//! 按客户端 IP 限制转发 wrapper-lite 的请求数（`--client-rate`）：wrapper-lite 的额度由所有用户共用，
//! 免得单个用户（如批量扒取整个艺人）用光。客户端 IP 取自 `--client-ip-header`（由前面的反向代理设置），
//! 没有设置或请求中没有该请求头时用 TCP 对端地址。

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::header::{CONTENT_TYPE, RETRY_AFTER};
use axum::http::{HeaderMap, HeaderName, Response, StatusCode};
use axum::middleware::Next;
use serde_json::json;
use tokio::time::Instant;

use crate::state::AppState;

const WINDOW: Duration = Duration::from_secs(60);

/// 滑动窗口：每个 IP 任意 60 秒内最多 `per_minute` 个请求，被拒绝的请求不计入
pub struct ClientLimit {
    per_minute: usize,
    header: Option<HeaderName>,
    inner: Mutex<Windows>,
}

struct Windows {
    sent: HashMap<IpAddr, VecDeque<Instant>>,
    /// 上次清理已过期窗口的时间，免得出现过的 IP 一直占着内存
    swept: Instant,
}

impl ClientLimit {
    /// `per_minute` 为 0 时不限；`header` 应已经过 [`parse_ip_header`]
    pub fn new(per_minute: u32, header: Option<&str>) -> Self {
        Self {
            per_minute: per_minute as usize,
            header: header.and_then(|name| HeaderName::from_bytes(name.as_bytes()).ok()),
            inner: Mutex::new(Windows { sent: HashMap::new(), swept: Instant::now() }),
        }
    }

    /// 请求头中的 IP（取第一个逗号前的部分）优先，否则为 TCP 对端地址
    pub fn client_ip(&self, headers: &HeaderMap, peer: Option<SocketAddr>) -> Option<IpAddr> {
        let from_header = self.header.as_ref().and_then(|name| headers.get(name)).and_then(|value| {
            value.to_str().ok()?.split(',').next()?.trim().parse().ok()
        });
        from_header.or(peer.map(|addr| addr.ip()))
    }

    /// 计入一个请求；超出时返回还要等多久才有配额
    pub fn check(&self, ip: IpAddr) -> Result<(), Duration> {
        let now = Instant::now();
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if now.duration_since(inner.swept) >= WINDOW {
            inner.sent.retain(|_, sent| sent.back().is_some_and(|t| now.duration_since(*t) < WINDOW));
            inner.swept = now;
        }
        let sent = inner.sent.entry(ip).or_default();
        while sent.front().is_some_and(|t| now.duration_since(*t) >= WINDOW) {
            sent.pop_front();
        }
        if sent.len() >= self.per_minute {
            return Err(*sent.front().expect("window is full") + WINDOW - now);
        }
        sent.push_back(now);
        Ok(())
    }
}

/// 校验 `--client-ip-header`，返回小写的请求头名；空值表示不使用
pub fn parse_ip_header(raw: &str) -> Result<Option<String>, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Ok(None);
    }
    HeaderName::from_bytes(name.as_bytes())
        .map(|name| Some(name.as_str().to_owned()))
        .map_err(|_| format!("Invalid --client-ip-header '{name}'"))
}

/// 转发 wrapper-lite 接口的中间件。`/status`（页面定时轮询）不限
pub async fn limit_clients(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response<Body> {
    let limit = &state.client_limit;
    if limit.per_minute == 0 || request.uri().path() == "/status" {
        return next.run(request).await;
    }
    let peer = request.extensions().get::<ConnectInfo<SocketAddr>>().map(|info| info.0);
    // 识别不出客户端时（没有对端地址，如测试中直接调用 router）不限
    let Some(ip) = limit.client_ip(request.headers(), peer) else {
        return next.run(request).await;
    };
    match limit.check(ip) {
        Ok(()) => next.run(request).await,
        Err(wait) => {
            let retry_after = wait.as_secs_f64().ceil().max(1.0) as u64;
            let body = json!({ "code": 1, "msg": format!("Too many requests; retry in {retry_after} s") });
            let response = Response::builder()
                .status(StatusCode::TOO_MANY_REQUESTS)
                .header(CONTENT_TYPE, "application/json; charset=utf-8")
                .header(RETRY_AFTER, retry_after)
                .body(Body::from(body.to_string()))
                .expect("static response parts are valid");
            crate::log::note(response, format!("client {ip} over {}/min", limit.per_minute))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn test_sliding_window_per_ip() {
        let limit = ClientLimit::new(3, None);
        let (a, b): (IpAddr, IpAddr) = ("203.0.113.1".parse().unwrap(), "203.0.113.2".parse().unwrap());
        for _ in 0..3 {
            limit.check(a).unwrap();
            tokio::time::advance(Duration::from_secs(10)).await;
        }
        // 第一个请求在 0 s，30 s 时还要等 30 s；被拒绝的请求不计入
        assert_eq!(limit.check(a), Err(Duration::from_secs(30)));
        assert_eq!(limit.check(a), Err(Duration::from_secs(30)));
        limit.check(b).unwrap();

        tokio::time::advance(Duration::from_secs(30)).await;
        limit.check(a).unwrap();
        assert_eq!(limit.check(a), Err(Duration::from_secs(10)));

        // 窗口全部过期的 IP 在清理时移除
        tokio::time::advance(Duration::from_secs(120)).await;
        limit.check(b).unwrap();
        assert_eq!(limit.inner.lock().unwrap().sent.len(), 1);
    }

    #[test]
    fn test_client_ip() {
        let peer: SocketAddr = "127.0.0.1:5000".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("cf-connecting-ip", "198.51.100.7".parse().unwrap());
        headers.insert("x-forwarded-for", "198.51.100.8, 10.0.0.1".parse().unwrap());

        // 没有配置请求头时不信任客户端传来的值
        assert_eq!(ClientLimit::new(1, None).client_ip(&headers, Some(peer)), Some(peer.ip()));
        let cf = ClientLimit::new(1, Some("cf-connecting-ip"));
        assert_eq!(cf.client_ip(&headers, Some(peer)), "198.51.100.7".parse().ok());
        let xff = ClientLimit::new(1, Some("x-forwarded-for"));
        assert_eq!(xff.client_ip(&headers, Some(peer)), "198.51.100.8".parse().ok());
        // 请求头缺失或不是 IP 时退回对端地址
        assert_eq!(cf.client_ip(&HeaderMap::new(), Some(peer)), Some(peer.ip()));
        headers.insert("cf-connecting-ip", "not-an-ip".parse().unwrap());
        assert_eq!(cf.client_ip(&headers, Some(peer)), Some(peer.ip()));
        assert_eq!(cf.client_ip(&HeaderMap::new(), None), None);
    }

    #[test]
    fn test_parse_ip_header() {
        assert_eq!(parse_ip_header(" ").unwrap(), None);
        assert_eq!(parse_ip_header("CF-Connecting-IP").unwrap().as_deref(), Some("cf-connecting-ip"));
        assert!(parse_ip_header("bad header").is_err());
    }
}
