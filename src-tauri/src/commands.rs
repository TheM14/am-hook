//! 前端（连接窗口 / 设置窗口）调用的命令。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;

use crate::config::Config;
use crate::mpv::{Device, MpvInfo};
use crate::server::{self, CheckError};
use crate::state::{AppState, ConnectState, ServerInfo, UiAction};

static QUITTING: AtomicBool = AtomicBool::new(false);

pub fn exiting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

/// 退出：先结束 mpv（释放 WASAPI 独占设备），再退出进程
pub fn quit(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        state.mpv.kill_all_sync();
    }
    app.exit(0);
}

/// 把状态快照推给所有本地窗口
pub fn broadcast(app: &AppHandle, state: &Arc<AppState>) {
    let _ = app.emit("gui://state", state.snapshot());
}

fn fail_connect(app: &AppHandle, state: &Arc<AppState>, url: &str, kind: &str, message: &str) {
    state.set_connect(ConnectState {
        status: "failed".into(),
        url: Some(url.to_string()),
        message: Some(message.to_string()),
        kind: Some(kind.to_string()),
    });
    crate::windows::emit_connect(app, &state.connect_state());
    broadcast(app, state);
}

/// 连接成功：记住地址、保存服务器、打开主窗口、收起连接窗口
pub async fn connect_success(app: &AppHandle, state: &Arc<AppState>, info: &ServerInfo) -> Result<(), String> {
    state.update_config(|config| config.remember_server(&info.url));
    state.set_server(Some(info.clone()));
    state.set_connect(ConnectState {
        status: "connected".into(),
        url: Some(info.url.clone()),
        message: None,
        kind: None,
    });
    let parsed = Url::parse(&info.url).map_err(|error| format!("地址无效: {error}"))?;
    crate::windows::open_main(app, state, &parsed).await?;
    if let Some(window) = app.get_webview_window(crate::windows::CONNECT) {
        let _ = window.hide();
    }
    crate::windows::emit_connect(app, &state.connect_state());
    crate::tray::set_tooltip(app, &format!("am-hook GUI · 已连接 {}", info.url));
    broadcast(app, state);
    // 换服务器后旧的 mpv 会话没有意义了
    let mpv = state.mpv.clone();
    tauri::async_runtime::spawn(async move { mpv.stop_all().await });
    Ok(())
}

/// 不经过 HTTP 检查直接打开页面。
///
/// 用在两类场景：用户确认过的 Cloudflare 挑战站点（`connect_anyway`），以及已保存的服务器
/// 在启动 / 重连时又被挑战（此时 Cookies 已经在 WebView2 profile 里，页面通常不会再问）。
async fn open_unchecked(
    app: &AppHandle,
    state: &Arc<AppState>,
    raw: &str,
) -> Result<ServerInfo, CheckError> {
    let parsed = server::normalize(raw)?;
    let info = ServerInfo {
        url: parsed.as_str().to_string(),
        title: parsed.host_str().unwrap_or("am-hook").to_string(),
        decrypt: true,
        wrapper_relay: None,
        regions: Vec::new(),
        wrapper_url: None,
        checked_at: None,
    };
    match connect_success(app, state, &info).await {
        Ok(()) => Ok(info),
        Err(message) => {
            let error = CheckError { kind: "window".into(), message, url: info.url.clone() };
            fail_connect(app, state, &info.url, &error.kind, &error.message);
            Err(error)
        }
    }
}

/// 重新检查当前服务器并打开主窗口（托盘「重新连接」、设置里的按钮都走这里）
pub fn reconnect_now(app: &AppHandle, state: &Arc<AppState>) {
    let url = state.server().map(|info| info.url).or_else(|| state.config().server.url);
    let Some(url) = url else {
        let _ = crate::windows::ensure_connect(app, state);
        return;
    };
    let app = app.clone();
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        crate::windows::close_main(&app);
        state.set_connect(ConnectState {
            status: "checking".into(),
            url: Some(url.clone()),
            message: None,
            kind: None,
        });
        crate::windows::emit_connect(&app, &state.connect_state());
        broadcast(&app, &state);
        let client = server::client();
        match server::check(&client, &url).await {
            Ok(info) => {
                if let Err(error) = connect_success(&app, &state, &info).await {
                    fail_connect(&app, &state, &url, "window", &error);
                    let _ = crate::windows::ensure_connect(&app, &state);
                }
            }
            Err(error) => {
                // Cloudflare 挑战：服务器之前连过，Cookies 还在 WebView2 profile 里，直接打开
                if error.kind == "challenge" && open_unchecked(&app, &state, &url).await.is_ok() {
                    return;
                }
                // 服务不可用：留下连接窗口显示原因，同时保留自动重试的入口
                state.set_server(None);
                fail_connect(&app, &state, &url, &error.kind, &error.message);
                let _ = crate::windows::ensure_connect(&app, &state);
            }
        }
    });
}

/// 启动时自动连接上次的服务器
pub fn auto_connect(app: &AppHandle, state: &Arc<AppState>) {
    let Some(url) = state.config().server.url else {
        let _ = crate::windows::ensure_connect(app, state);
        state.set_connect(ConnectState::idle());
        crate::windows::emit_connect(app, &state.connect_state());
        return;
    };
    let app = app.clone();
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        state.set_connect(ConnectState {
            status: "checking".into(),
            url: Some(url.clone()),
            message: None,
            kind: None,
        });
        let _ = crate::windows::ensure_connect(&app, &state);
        crate::windows::emit_connect(&app, &state.connect_state());
        let client = server::client();
        match server::check(&client, &url).await {
            Ok(info) => {
                if let Err(error) = connect_success(&app, &state, &info).await {
                    fail_connect(&app, &state, &url, "window", &error);
                    let _ = crate::windows::ensure_connect(&app, &state);
                }
            }
            Err(error) => {
                // 已经保存的服务器被 Cloudflare 挑战：直接用 WebView 打开，用户完成验证即可
                if error.kind == "challenge" && open_unchecked(&app, &state, &url).await.is_ok() {
                    return;
                }
                fail_connect(&app, &state, &url, &error.kind, &error.message);
                let _ = crate::windows::ensure_connect(&app, &state);
            }
        }
    });
}

/// 弹出系统文件对话框并把结果送回请求方（页面里的悬浮面板选 mpv 路径用）
fn pick_path(app: &AppHandle, kind: crate::state::PathKind, reply: tokio::sync::oneshot::Sender<Option<String>>) {
    use tauri_plugin_dialog::DialogExt;
    let (title, filters): (&str, &[&str]) = match kind {
        crate::state::PathKind::MpvExe => ("选择 mpv.exe", &["exe"]),
        crate::state::PathKind::MpvConfig => ("选择 mpv 配置目录里的 mpv.conf", &["conf", "txt"]),
    };
    let dialog = app.dialog().file().set_title(title);
    let dialog = match kind {
        crate::state::PathKind::MpvExe => dialog.add_filter("mpv", filters),
        crate::state::PathKind::MpvConfig => dialog.add_filter("mpv 配置", filters),
    };
    let mut reply = Some(reply);
    dialog.pick_file(move |path| {
        if let Some(reply) = reply.take() {
            let _ = reply.send(path.map(|path| path.to_string()));
        }
    });
}

/* ---------- Tauri 命令 ---------- */

#[tauri::command]
pub async fn gui_snapshot(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    Ok(state.snapshot())
}

#[tauri::command]
pub async fn check_server(url: String) -> Result<ServerInfo, CheckError> {
    let client = server::client();
    server::check(&client, &url).await
}

#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    url: String,
) -> Result<ServerInfo, CheckError> {
    state.set_connect(ConnectState {
        status: "checking".into(),
        url: Some(url.clone()),
        message: None,
        kind: None,
    });
    crate::windows::emit_connect(&app, &state.connect_state());
    broadcast(&app, &state);
    let client = server::client();
    match server::check(&client, &url).await {
        Ok(info) => match connect_success(&app, &state, &info).await {
            Ok(()) => Ok(info),
            Err(message) => {
                let error = CheckError { kind: "window".into(), message, url: info.url.clone() };
                fail_connect(&app, &state, &info.url, &error.kind, &error.message);
                Err(error)
            }
        },
        Err(error) => {
            fail_connect(&app, &state, &url, &error.kind, &error.message);
            Err(error)
        }
    }
}

/// 服务器检查被 Cloudflare 人机验证拦截时，用户确认后直接打开页面。
///
/// 页面是否真的是 am-hook 由页面本身决定：Cloudflare 验证通过后，注入脚本和
/// AmDecrypt 才可用；如果不是 am-hook，用户会停留在验证页或普通网页上，可以断开。
#[tauri::command]
pub async fn connect_anyway(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    url: String,
) -> Result<ServerInfo, CheckError> {
    let state = state.inner().clone();
    open_unchecked(&app, &state, &url).await
}

#[tauri::command]
pub async fn disconnect(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    let state = state.inner().clone();
    let mpv = state.mpv.clone();
    tauri::async_runtime::spawn(async move { mpv.stop_all().await });
    crate::windows::close_main(&app);
    state.set_server(None);
    state.set_connect(ConnectState::idle());
    state.update_config(|config| config.server.url = None);
    let _ = crate::windows::ensure_connect(&app, &state);
    crate::windows::emit_connect(&app, &state.connect_state());
    broadcast(&app, &state);
    Ok(state.snapshot())
}

/// 深层合并设置补丁：只覆盖补丁里出现的字段
fn merge(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(target), Value::Object(patch)) => {
            for (key, value) in patch {
                match target.get_mut(key) {
                    Some(slot) => merge(slot, value),
                    None => {
                        target.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (target, patch) => *target = patch.clone(),
    }
}

#[tauri::command]
pub async fn save_config(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    patch: Value,
) -> Result<Value, String> {
    let state = state.inner().clone();
    let before = state.config();
    let mut value = serde_json::to_value(&before).map_err(|error| error.to_string())?;
    merge(&mut value, &patch);
    let mut next: Config = serde_json::from_value(value).map_err(|error| format!("设置不合法: {error}"))?;
    // 服务器地址只由连接流程写，避免设置窗口把它改乱
    next.server = before.server.clone();
    next.save(&state.config_path).map_err(|error| format!("保存设置失败: {error}"))?;
    *state.config.write().expect("config rwlock") = next.clone();
    crate::tray::sync_mpv_checked(next.mpv.enabled);
    crate::events::send(&state.events, crate::events::BridgeEvent::Config { settings: next.page_settings() });
    broadcast(&app, &state);
    Ok(state.snapshot())
}

#[tauri::command]
pub async fn probe_mpv(state: State<'_, Arc<AppState>>, refresh: bool) -> Result<MpvInfo, String> {
    let state = state.inner().clone();
    let path = state.config().mpv.path;
    let info = tauri::async_runtime::spawn_blocking(move || state.mpv.info(path.as_deref(), refresh))
        .await
        .map_err(|error| error.to_string())?;
    Ok(info)
}

#[tauri::command]
pub async fn list_devices(state: State<'_, Arc<AppState>>, refresh: bool) -> Result<Vec<Device>, String> {
    let state = state.inner().clone();
    let config = state.config();
    state.mpv.devices(config.mpv.path.as_deref(), refresh).await
}

#[tauri::command]
pub async fn pick_mpv_exe(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("mpv", &["exe"])
        .set_title("选择 mpv.exe")
        .pick_file(move |path| {
            let _ = tx.send(path.map(|path| path.to_string()));
        });
    rx.await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn pick_config_file(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("mpv 配置", &["conf", "txt"])
        .set_title("选择 mpv 配置文件")
        .pick_file(move |path| {
            let _ = tx.send(path.map(|path| path.to_string()));
        });
    rx.await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn open_settings(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    crate::windows::open_settings(&app, state.inner()).map(|_| ())
}

#[tauri::command]
pub async fn open_connect(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    crate::windows::ensure_connect(&app, state.inner()).map(|_| ())
}

/// 诊断用：直接调用 Shell_NotifyIcon 看这个进程能不能加托盘图标，
/// 以及失败时的 Win32 错误码（托盘图标没出现时用来定位）
#[tauri::command]
pub fn tray_probe(app: AppHandle) -> serde_json::Value {
    tray_probe_result(&app)
}

/// `tray_probe` 的实际实现，托盘自检时也调用
pub fn tray_probe_result(app: &AppHandle) -> serde_json::Value {
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        #[repr(C)]
        struct NotifyIconData {
            cb_size: u32,
            hwnd: *mut c_void,
            uid: u32,
            flags: u32,
            callback_message: u32,
            hicon: *mut c_void,
            tip: [u16; 128],
            state: u32,
            state_mask: u32,
            info: [u16; 256],
            timeout_or_version: u32,
            info_title: [u16; 64],
            info_flags: u32,
            guid: [u8; 16],
            balloon_icon: *mut c_void,
        }
        extern "system" {
            fn Shell_NotifyIconW(message: u32, data: *mut NotifyIconData) -> i32;
            fn LoadIconW(instance: *mut c_void, name: *const u16) -> *mut c_void;
        }
        const NIM_ADD: u32 = 0;
        const NIM_DELETE: u32 = 2;
        const NIF_MESSAGE: u32 = 1;
        const NIF_ICON: u32 = 2;
        const NIF_TIP: u32 = 4;

        let hwnd = app
            .webview_windows()
            .values()
            .find_map(|window| window.hwnd().ok())
            .map(|handle| handle.0 as *mut c_void);
        let mut data = NotifyIconData {
            cb_size: std::mem::size_of::<NotifyIconData>() as u32,
            hwnd: hwnd.unwrap_or(std::ptr::null_mut()),
            uid: 0xA11C,
            flags: NIF_MESSAGE | NIF_ICON | NIF_TIP,
            callback_message: 0x8000 + 1,
            hicon: unsafe { LoadIconW(std::ptr::null_mut(), 32512usize as *const u16) },
            tip: [0; 128],
            state: 0,
            state_mask: 0,
            info: [0; 256],
            timeout_or_version: 0,
            info_title: [0; 64],
            info_flags: 0,
            guid: [0; 16],
            balloon_icon: std::ptr::null_mut(),
        };
        for (index, unit) in "probe".encode_utf16().enumerate() {
            data.tip[index] = unit;
        }
        let added = unsafe { Shell_NotifyIconW(NIM_ADD, &mut data) };
        let add_error = std::io::Error::last_os_error().raw_os_error();
        let removed = unsafe { Shell_NotifyIconW(NIM_DELETE, &mut data) };
        return serde_json::json!({
            "hwnd": hwnd.is_some(),
            "added": added != 0,
            "addError": add_error,
            "removed": removed != 0,
        });
    }
    #[cfg(not(windows))]
    serde_json::json!({ "supported": false })
}

/// 托盘图标是否真的被 shell 收下了（诊断页会显示）
#[tauri::command]
pub fn tray_status(app: AppHandle) -> serde_json::Value {
    let tray = app.tray_by_id("main");
    let registered = tray.as_ref().map(|tray| matches!(tray.rect(), Ok(Some(_)))).unwrap_or(false);
    serde_json::json!({
        "created": tray.is_some(),
        "registered": registered,
    })
}

#[tauri::command]
pub async fn show_main(app: AppHandle) -> Result<(), String> {
    crate::windows::show_main(&app);
    Ok(())
}

#[tauri::command]
pub async fn hide_to_tray(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(crate::windows::MAIN) {
        crate::windows::save_bounds(&window, state.inner());
    }
    crate::windows::hide_main(&app);
    Ok(())
}

#[tauri::command]
pub async fn reconnect(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    reconnect_now(&app, state.inner());
    Ok(())
}

#[tauri::command]
pub async fn quit_app(app: AppHandle) -> Result<(), String> {
    quit(&app);
    Ok(())
}

#[tauri::command]
pub async fn logs(lines: Option<usize>) -> Result<String, String> {
    Ok(crate::logging::tail(lines.unwrap_or(300)))
}

#[tauri::command]
pub async fn open_data_dir(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let dir = state.data_dir.clone();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg(dir)
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 页面里的悬浮面板通过 bridge 发来的界面动作
pub fn handle_ui_action(app: &AppHandle, state: &Arc<AppState>, action: UiAction) {
    match action {
        UiAction::OpenSettings => {
            let _ = crate::windows::open_settings(app, state);
        }
        UiAction::ShowConnect => {
            let _ = crate::windows::ensure_connect(app, state);
        }
        UiAction::Reconnect => reconnect_now(app, state),
        UiAction::ShowMain => {
            crate::windows::open_external(
                &Url::parse(state.config().server.url.as_deref().unwrap_or("http://127.0.0.1")).unwrap_or_else(|_| {
                    Url::parse("http://127.0.0.1").expect("static url")
                }),
            );
            crate::windows::show_main(app);
        }
        UiAction::HideMain => crate::windows::hide_main(app),
        UiAction::MinimizeMain => {
            if let Some(window) = app.get_webview_window(crate::windows::MAIN) {
                let _ = window.minimize();
            }
        }
        UiAction::CloseMain => {
            // 先让 bridge 的响应发出去，再关窗（关窗会直接退出进程）
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                if let Some(window) = app.get_webview_window(crate::windows::MAIN) {
                    let _ = window.close();
                }
            });
        }
        UiAction::PickPath { kind, reply } => {
            pick_path(app, kind, reply);
        }
        UiAction::Quit => quit(app),
    }
}
