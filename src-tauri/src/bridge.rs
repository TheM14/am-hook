//! 本机 bridge：GUI 自己的 HTTP 服务，只监听 127.0.0.1，页面里的注入脚本通过它控制 mpv。
//!
//! 为什么用本机 HTTP 而不是 Tauri IPC：音频流是长连接 + 背压（mpv 读得慢时 `fetch` 的请求体
//! 自然挂住），流式请求体走 HTTP 最直接；页面也能用 EventSource 接收状态推送，窗口隐藏时
//! 不受页面定时器降频影响。安全性由三点保证：只绑定回环地址、每次启动随机令牌、mpv 参数校验。

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_stream::wrappers::BroadcastStream;

use crate::events::BridgeEvent;
use crate::mpv::FeedError;
use crate::state::{AppState, UiAction};

/// 请求头里带令牌；SSE 与 feed 这种不方便加头的走查询参数
const TOKEN_HEADER: &str = "x-amhook-gui-token";

pub struct Bridge {
    pub port: u16,
    pub token: String,
}

/// 启动 bridge，返回实际端口；调用方把端口与令牌放进 `AppState`
pub async fn start(state: Arc<AppState>, token: String) -> Result<Bridge, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("bridge 无法监听本机端口: {error}"))?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    *state.bridge_port.write().expect("bridge port rwlock") = port;

    let router = router(state.clone());
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::warn!("bridge server stopped: {error}");
        }
    });
    tracing::info!("bridge listening on http://127.0.0.1:{port}");
    // 调试 / 自动化测试：把端口与令牌写到数据目录，便于外部驱动同一个 bridge
    if std::env::var("AM_HOOK_GUI_DEBUG_BRIDGE").is_ok() {
        let path = state.data_dir.join("bridge.json");
        let payload = json!({ "port": port, "token": token, "pid": std::process::id() });
        if let Err(error) = std::fs::write(&path, payload.to_string()) {
            tracing::warn!("cannot write {}: {error}", path.display());
        }
    }
    Ok(Bridge { port, token })
}

fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/config", get(get_config).post(set_config))
        .route("/events", get(events))
        .route("/mpv/play", post(play))
        .route("/mpv/feed/:session", post(feed))
        .route("/mpv/feed/:session/end", post(feed_end))
        .route("/mpv/control", post(control))
        .route("/mpv/state", get(state_of))
        .route("/mpv/devices", get(devices))
        .route("/mpv/session/:session", delete(stop))
        .route("/ui", post(ui_action))
        .route("/mpv/browse", post(browse))
        .route("/mpv/probe", post(probe_mpv))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

/* ---------- 鉴权与 CORS ---------- */

fn query_token(query: Option<&str>) -> Option<String> {
    let query = query?;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == "token").then(|| urldecode(value))
    })
}

fn urldecode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    index += 3;
                    continue;
                }
                out.push(bytes[index]);
                index += 1;
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn cors_headers(headers: &mut HeaderMap, origin: Option<HeaderValue>) {
    if let Some(origin) = origin {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        headers.insert(header::VARY, HeaderValue::from_static("origin"));
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, DELETE, OPTIONS"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("content-type, x-amhook-gui-token"),
        );
        headers.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
        headers.insert(
            "access-control-allow-private-network",
            HeaderValue::from_static("true"),
        );
    }
}

async fn guard(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    let origin = request.headers().get(header::ORIGIN).cloned();
    if request.method() == Method::OPTIONS {
        tracing::debug!(
            "bridge OPTIONS {} from {:?} (request-headers: {:?})",
            request.uri().path(),
            origin,
            request.headers().get("access-control-request-headers").and_then(|value| value.to_str().ok())
        );
        let mut response = StatusCode::NO_CONTENT.into_response();
        cors_headers(response.headers_mut(), origin);
        return response;
    }
    let header_token = request
        .headers()
        .get(TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let token = header_token.or_else(|| query_token(request.uri().query()));
    if token.as_deref() != Some(state.bridge_token.as_str()) {
        let mut response = Json(json!({ "code": 1, "msg": "invalid bridge token" })).into_response();
        *response.status_mut() = StatusCode::UNAUTHORIZED;
        cors_headers(response.headers_mut(), origin);
        return response;
    }
    tracing::debug!("bridge {} {} from {:?}", request.method(), request.uri().path(), origin);
    let mut response = next.run(request).await;
    cors_headers(response.headers_mut(), origin);
    response
}

/* ---------- 基础信息 ---------- */

async fn health(State(state): State<Arc<AppState>>) -> Response {
    let config = state.config();
    let info = state.mpv.info(config.mpv.path.as_deref(), false);
    Json(json!({
        "code": 0,
        "version": env!("CARGO_PKG_VERSION"),
        "mpv": info,
        "session": state.mpv.current(),
        "server": state.server(),
        "uptimeSeconds": state.started.elapsed().as_secs(),
    }))
    .into_response()
}

async fn get_config(State(state): State<Arc<AppState>>) -> Response {
    let config = state.config();
    let info = state.mpv.info(config.mpv.path.as_deref(), false);
    Json(json!({
        "code": 0,
        "settings": config.page_settings(),
        "mpv": info,
        "server": state.server(),
    }))
    .into_response()
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ConfigPatch {
    mpv: Option<MpvPatch>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct MpvPatch {
    enabled: Option<bool>,
    /// mpv 可执行文件；空字符串表示回到自动查找
    path: Option<String>,
    device: Option<String>,
    exclusive: Option<bool>,
    extra_args: Option<String>,
    config_file: Option<String>,
    cache_seconds: Option<u32>,
    prefer_atmos: Option<bool>,
}

/// 页面里的悬浮面板改设置（输出方式、设备、独占）：写回同一个配置文件
async fn set_config(State(state): State<Arc<AppState>>, Json(patch): Json<ConfigPatch>) -> Response {
    let Some(mpv) = patch.mpv else {
        return bad_request("没有要修改的设置");
    };
    let mut error: Option<String> = None;
    state.update_config(|config| {
        if let Some(enabled) = mpv.enabled {
            config.mpv.enabled = enabled;
        }
        if let Some(device) = mpv.device.as_ref() {
            if device.len() <= 400 {
                config.mpv.device = device.clone();
            }
        }
        if let Some(exclusive) = mpv.exclusive {
            config.mpv.exclusive = exclusive;
        }
        if let Some(path) = mpv.path.as_ref() {
            if path.len() <= 500 {
                config.mpv.path = (!path.trim().is_empty()).then(|| path.trim().to_string());
            }
        }
        if let Some(cache) = mpv.cache_seconds {
            config.mpv.cache_seconds = cache.clamp(1, 600);
        }
        if let Some(prefer) = mpv.prefer_atmos {
            config.mpv.prefer_atmos = prefer;
        }
        if let Some(config_file) = mpv.config_file.as_ref() {
            if config_file.len() <= 500 {
                config.mpv.config_file = (!config_file.is_empty()).then(|| config_file.clone());
            }
        }
        if let Some(extra_args) = mpv.extra_args.as_ref() {
            if extra_args.len() <= 1000 {
                config.mpv.extra_args = extra_args.clone();
            } else {
                error = Some("额外参数太长".into());
            }
        }
    });
    if let Some(message) = error {
        return bad_request(&message);
    }
    get_config(State(state)).await
}

/* ---------- 播放 ---------- */

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PlayRequest {
    device: Option<String>,
    exclusive: Option<bool>,
    volume: Option<f64>,
    args: Option<Vec<String>>,
    cache_seconds: Option<u32>,
}

async fn play(State(state): State<Arc<AppState>>, body: Option<Json<PlayRequest>>) -> Response {
    let request = body.map(|Json(request)| request).unwrap_or_default();
    let mut settings = state.play_settings();
    if let Some(device) = request.device {
        settings.device = device;
    }
    if let Some(exclusive) = request.exclusive {
        settings.exclusive = exclusive;
    }
    if let Some(args) = request.args {
        settings.args = args;
    }
    if let Some(cache) = request.cache_seconds {
        settings.cache_seconds = cache;
    }
    match state.mpv.play(&settings).await {
        Ok(session) => {
            if let Some(volume) = request.volume {
                let _ = state.mpv.control(&session, "volume", &json!(volume)).await;
            }
            Json(json!({ "code": 0, "session": session })).into_response()
        }
        Err(message) => {
            tracing::warn!("mpv play failed: {message}");
            Json(json!({ "code": 1, "msg": message })).into_response_with_status(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

/// 便于上面返回非 200 的小工具
trait IntoResponseWithStatus {
    fn into_response_with_status(self, status: StatusCode) -> Response;
}

impl IntoResponseWithStatus for Json<Value> {
    fn into_response_with_status(self, status: StatusCode) -> Response {
        let mut response = self.into_response();
        *response.status_mut() = status;
        response
    }
}

async fn feed(State(state): State<Arc<AppState>>, Path(session): Path<String>, request: Request) -> Response {
    tracing::debug!("feed request for session {session}");
    match state.mpv.feed(&session, request.into_body()).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(FeedError::NotFound) => bad_request_status("mpv 会话不存在", StatusCode::NOT_FOUND),
        Err(FeedError::Closed) => bad_request_status("mpv 已经关闭了输入", StatusCode::CONFLICT),
    }
}

/// 一首歌的数据送完了：关掉 mpv 的 stdin
async fn feed_end(State(state): State<Arc<AppState>>, Path(session): Path<String>) -> Response {
    tracing::debug!("feed end for session {session}");
    match state.mpv.feed_end(&session).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(FeedError::NotFound) => bad_request_status("mpv 会话不存在", StatusCode::NOT_FOUND),
        Err(FeedError::Closed) => StatusCode::NO_CONTENT.into_response(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlRequest {
    session: String,
    command: String,
    #[serde(default)]
    value: Value,
}

async fn control(State(state): State<Arc<AppState>>, Json(request): Json<ControlRequest>) -> Response {
    match state.mpv.control(&request.session, &request.command, &request.value).await {
        Ok(()) => Json(json!({ "code": 0 })).into_response(),
        Err(message) => {
            let status = if message.contains("不存在") { StatusCode::NOT_FOUND } else { StatusCode::INTERNAL_SERVER_ERROR };
            bad_request_status(&message, status)
        }
    }
}

#[derive(Debug, Deserialize)]
struct SessionQuery {
    session: String,
}

async fn state_of(State(state): State<Arc<AppState>>, Query(query): Query<SessionQuery>) -> Response {
    match state.mpv.state(&query.session) {
        Some(state_of_session) => Json(json!({ "code": 0, "alive": state_of_session.alive, "session": query.session, "state": state_of_session })).into_response(),
        None => Json(json!({ "code": 0, "alive": false, "gone": true, "session": query.session })).into_response(),
    }
}

async fn stop(State(state): State<Arc<AppState>>, Path(session): Path<String>) -> Response {
    state.mpv.stop(&session).await;
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Debug, Default, Deserialize)]
struct DeviceQuery {
    /// 查询串里的刷新开关；同时接受 `true` / `1` / `yes` / `on`
    #[serde(default)]
    refresh: Option<String>,
}

fn truthy(value: Option<&String>) -> bool {
    match value.map(|text| text.trim().to_ascii_lowercase()) {
        Some(text) => matches!(text.as_str(), "1" | "true" | "yes" | "on"),
        None => false,
    }
}

async fn devices(State(state): State<Arc<AppState>>, Query(query): Query<DeviceQuery>) -> Response {
    let config = state.config();
    let info = state.mpv.info(config.mpv.path.as_deref(), false);
    if !info.found {
        return Json(json!({ "code": 1, "msg": "找不到 mpv", "devices": [], "mpv": info }))
            .into_response_with_status(StatusCode::BAD_REQUEST);
    }
    match state.mpv.devices(config.mpv.path.as_deref(), truthy(query.refresh.as_ref())).await {
        Ok(devices) => Json(json!({ "code": 0, "devices": devices, "current": config.mpv.device, "mpv": info })).into_response(),
        Err(message) => Json(json!({ "code": 1, "msg": message, "devices": [] }))
            .into_response_with_status(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/* ---------- 页面里选择本地文件 ---------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowseRequest {
    /// `exe`（mpv 可执行文件）或 `config`（mpv 配置目录 / mpv.conf）
    #[serde(default = "default_kind")]
    kind: String,
}

fn default_kind() -> String {
    "exe".to_string()
}

/// 重新检测 mpv（换路径 / 装好 mpv 之后不必重启客户端）
async fn probe_mpv(State(state): State<Arc<AppState>>) -> Response {
    let config = state.config();
    let path = config.mpv.path.clone();
    let mpv = state.mpv.clone();
    let info = tauri::async_runtime::spawn_blocking(move || mpv.info(path.as_deref(), true))
        .await
        .unwrap_or(crate::mpv::MpvInfo { found: false, path: String::new(), version: String::new() });
    Json(json!({ "code": 0, "mpv": info })).into_response()
}

/// 页面在远程 origin 上，不能直接开系统文件对话框：由 bridge 转给 GUI 主线程，
/// 拿到结果再回给页面（最长等 2 分钟）。
async fn browse(State(state): State<Arc<AppState>>, Json(request): Json<BrowseRequest>) -> Response {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let kind = match request.kind.as_str() {
        "config" => crate::state::PathKind::MpvConfig,
        _ => crate::state::PathKind::MpvExe,
    };
    let _ = state.ui.send(UiAction::PickPath { kind, reply: tx });
    match tokio::time::timeout(Duration::from_secs(120), rx).await {
        Ok(Ok(path)) => Json(json!({ "code": 0, "path": path })).into_response(),
        Ok(Err(_)) => Json(json!({ "code": 1, "msg": "对话框已取消" })).into_response(),
        Err(_) => bad_request_status("等待选择文件超时", StatusCode::GATEWAY_TIMEOUT),
    }
}

/* ---------- 页面请求的界面动作 ---------- */

#[derive(Debug, Deserialize)]
struct UiRequest {
    action: String,
}

/// 页面里的悬浮面板不能直接用 Tauri IPC（页面在服务器 origin 上），
/// 需要打开设置窗口之类的动作时通过 bridge 转给 GUI 主线程
async fn ui_action(State(state): State<Arc<AppState>>, Json(request): Json<UiRequest>) -> Response {
    let action = match request.action.as_str() {
        "openSettings" => UiAction::OpenSettings,
        "showConnect" => UiAction::ShowConnect,
        "reconnect" => UiAction::Reconnect,
        "showMain" => UiAction::ShowMain,
        "hideMain" => UiAction::HideMain,
        "minimizeMain" => UiAction::MinimizeMain,
        "closeMain" => UiAction::CloseMain,
        "quit" => UiAction::Quit,
        other => return bad_request(&format!("未知动作: {other}")),
    };
    let _ = state.ui.send(action);
    Json(json!({ "code": 0 })).into_response()
}

/* ---------- 事件推送 ---------- */

async fn events(State(state): State<Arc<AppState>>) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
    let initial = {
        let config = state.config();
        let info = state.mpv.info(config.mpv.path.as_deref(), false);
        let session = state.mpv.current().and_then(|session| state.mpv.state(&session).map(|state| (session, state)));
        json!({
            "type": "hello",
            "settings": config.page_settings(),
            "mpv": info,
            "server": state.server(),
            "session": session.map(|(id, state)| json!({ "id": id, "state": state })),
        })
    };
    let receiver = state.events.subscribe();
    let first = futures::stream::once(async move {
        Ok(Event::default().data(serde_json::to_string(&initial).unwrap_or_default()))
    });
    let rest = BroadcastStream::new(receiver).filter_map(|result| async move {
        match result {
            Ok(event) => {
                let payload = match &event {
                    BridgeEvent::MpvState { session, state } => json!({
                        "type": "mpvState", "session": session, "state": state,
                    }),
                    BridgeEvent::MpvEnded { session } => json!({ "type": "mpvEnded", "session": session }),
                    BridgeEvent::MpvError { session, message } => {
                        json!({ "type": "mpvError", "session": session, "message": message })
                    }
                    BridgeEvent::Config { settings } => json!({ "type": "config", "settings": settings }),
                    BridgeEvent::Server { url } => json!({ "type": "server", "url": url }),
                    BridgeEvent::ServerStatus { alive, message } => {
                        json!({ "type": "serverStatus", "alive": alive, "message": message })
                    }
                };
                Some(Ok(Event::default().data(serde_json::to_string(&payload).unwrap_or_default())))
            }
            Err(_) => None,
        }
    });
    Sse::new(first.chain(rest)).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("ping"))
}

/* ---------- 小工具 ---------- */

fn bad_request(message: &str) -> Response {
    bad_request_status(message, StatusCode::BAD_REQUEST)
}

fn bad_request_status(message: &str, status: StatusCode) -> Response {
    let mut response = Json(json!({ "code": 1, "msg": message })).into_response();
    *response.status_mut() = status;
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_query_tokens() {
        assert_eq!(query_token(Some("token=abc")).as_deref(), Some("abc"));
        assert_eq!(query_token(Some("x=1&token=a%2Bb")).as_deref(), Some("a+b"));
        assert_eq!(query_token(Some("x=1")), None);
        assert_eq!(query_token(None), None);
    }
}
