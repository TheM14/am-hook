//! --client-rate / --client-ip-header: relayed wrapper-lite requests are limited per client IP,
//! /status is not counted, and requests over the limit never reach wrapper-lite.
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use am_hook::state::{AppState, Config};
use axum::Router;

fn config(wrapper_url: String, ip_header: Option<&str>) -> Config {
    Config {
        wrapper_url,
        amp_keepalive: Duration::ZERO,
        amp_cache_mb: 0,
        wrapper_rate: 0,
        wrapper_concurrency: 0,
        wrapper_auth: None,
        wrapper_relay: true,
        wrapper_hint: None,
        client_rate: 2,
        client_ip_header: ip_header.map(str::to_owned),
    }
}

/// 与 main.rs 相同，带上对端地址
async fn serve_app(state: AppState) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = am_hook::router(Arc::new(state)).into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

/// 假的 wrapper-lite：记录收到的请求数
async fn fake_wrapper(calls: Arc<AtomicUsize>) -> String {
    let app = Router::new().fallback(move || {
        calls.fetch_add(1, Ordering::SeqCst);
        async { r#"{"code":0,"data":{"m3u8":"https://aod.itunes.apple.com/x.m3u8","regions":["us"]},"msg":"SUCCESS"}"# }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

#[tokio::test]
async fn relayed_requests_are_limited_per_client_ip() {
    let calls = Arc::new(AtomicUsize::new(0));
    let app = serve_app(AppState::with_config(config(fake_wrapper(calls.clone()).await, Some("x-real-ip")))).await;
    let client = reqwest::Client::new();
    let song = |ip: &str| client.get(format!("{app}/parse/song/1440833098")).header("x-real-ip", ip).send();

    assert_eq!(song("198.51.100.1").await.unwrap().status(), 200);
    assert_eq!(song("198.51.100.1").await.unwrap().status(), 200);
    let limited = song("198.51.100.1").await.unwrap();
    assert_eq!(limited.status(), 429);
    let retry_after: u64 = limited.headers()["retry-after"].to_str().unwrap().parse().unwrap();
    assert!((59..=60).contains(&retry_after), "{retry_after}");
    assert_eq!(calls.load(Ordering::SeqCst), 2, "the limited request did not reach wrapper-lite");

    // 其他 IP 不受影响；/status 不计入
    assert_eq!(song("198.51.100.2").await.unwrap().status(), 200);
    for _ in 0..3 {
        let status = client.get(format!("{app}/status")).header("x-real-ip", "198.51.100.1").send().await.unwrap();
        assert_eq!(status.status(), 200);
    }
}

#[tokio::test]
async fn without_ip_header_the_peer_address_is_used() {
    let calls = Arc::new(AtomicUsize::new(0));
    let app = serve_app(AppState::with_config(config(fake_wrapper(calls).await, None))).await;
    let client = reqwest::Client::new();
    // 没有配置 --client-ip-header 时，客户端传来的请求头不能绕过限制
    for (ip, expected) in [("198.51.100.1", 200), ("198.51.100.2", 200), ("198.51.100.3", 429)] {
        let response = client.get(format!("{app}/parse/song/1440833098")).header("x-real-ip", ip).send().await.unwrap();
        assert_eq!(response.status(), expected, "{ip}");
    }
}
