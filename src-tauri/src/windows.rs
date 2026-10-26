//! 窗口：连接窗口、主窗口（am-hook 页面）、设置窗口。
//!
//! 主窗口按连接的服务器创建：WebView 的初始化脚本（注入的 bridge 补丁）与 Chromium 启动参数
//! 在创建时确定，所以换服务器时重建主窗口，而不是在同一个 WebView 里跳来跳去。

use std::sync::Arc;

use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use url::Url;

use crate::state::{AppState, ConnectState};

pub const CONNECT: &str = "connect";
pub const MAIN: &str = "main";
pub const SETTINGS: &str = "settings";

/// Chromium 的默认参数；设置 `additional_browser_args` 时会覆盖 wry 的默认值，所以要写全
const BASE_BROWSER_ARGS: &str =
    "--autoplay-policy=no-user-gesture-required --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// 隐藏 / 最小化窗口时不让 WebView 降低定时器频率、暂停渲染
const BACKGROUND_ARGS: &str = "--disable-background-timer-throttling \
     --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
     --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling";

/// 本地页面（tauri.localhost）的基准地址；Windows 上 Tauri 用 http://tauri.localhost
pub const LOCAL_BASE: &str = "http://tauri.localhost/";

/// 给窗口统一加上 Chromium 参数与 WebView2 数据目录
fn prepare<'a>(builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>, state: &Arc<AppState>, target: Option<&Url>) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    #[cfg(windows)]
    let builder = builder.additional_browser_args(&browser_args(state, target));
    #[cfg(not(windows))]
    let builder = builder;
    match webview_data_dir(state) {
        Some(dir) => builder.data_directory(dir),
        None => builder,
    }
}

/// WebView2 的用户数据目录：默认的用户目录在 %LOCALAPPDATA%，某些策略下不可写
#[cfg(windows)]
fn webview_data_dir(state: &Arc<AppState>) -> Option<std::path::PathBuf> {
    Some(crate::paths::webview_dir(&state.data_dir))
}

#[cfg(not(windows))]
fn webview_data_dir(_state: &Arc<AppState>) -> Option<std::path::PathBuf> {
    None
}

fn is_loopback(url: &Url) -> bool {
    match url.host_str() {
        Some(host) => host == "localhost" || host == "127.0.0.1" || host == "::1" || host.ends_with(".localhost"),
        None => false,
    }
}

/// 主窗口的 Chromium 启动参数
pub fn browser_args(state: &Arc<AppState>, target: Option<&Url>) -> String {
    let config = state.config();
    let mut args = vec![BASE_BROWSER_ARGS.to_string()];
    if config.behavior.background_playback {
        // 两条 --disable-features 会互相覆盖，合并成一条放在最前面那条里
        args[0] = BASE_BROWSER_ARGS.replace(
            "msSmartScreenProtection",
            "msSmartScreenProtection,CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
        );
        args.push(BACKGROUND_ARGS.replace(
            " --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
            "",
        ));
    }
    if let Some(url) = target {
        if config.behavior.insecure_origin_as_secure && url.scheme() == "http" && !is_loopback(url) {
            args.push(format!("--unsafely-treat-insecure-origin-as-secure={}", url.origin().ascii_serialization()));
        }
    }
    // 调试用：远程调试端口（自动化测试通过 CDP 驱动真实窗口）
    if let Ok(port) = std::env::var("AM_HOOK_GUI_CDP") {
        if !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()) {
            args.push(format!("--remote-debugging-port={port}"));
        }
    }
    args.join(" ")
}

/// 本地页面（连接 / 设置）的 base 地址，形如 `http://tauri.localhost/`
fn local_base(window: &WebviewWindow) -> String {
    let url = window.url().ok();
    let base = url
        .as_ref()
        .map(|url| format!("{}://{}", url.scheme(), url.host_str().map(|host| match url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        }).unwrap_or_default()))
        .unwrap_or_else(|| LOCAL_BASE.trim_end_matches('/').to_string());
    format!("{base}/")
}

pub fn ensure_connect(app: &AppHandle, state: &Arc<AppState>) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(CONNECT) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(window);
    }
    let script = crate::inject::build(state);
    tracing::info!("creating connect window");
    state.set_local_url(LOCAL_BASE.to_string());
    let window = {
        let state_for_load = state.clone();
        let builder = WebviewWindowBuilder::new(app, CONNECT, WebviewUrl::App("index.html".into()))
            .title("am-hook GUI")
            .inner_size(940.0, 660.0)
            .min_inner_size(720.0, 520.0)
            .center()
            .resizable(true)
            .initialization_script(&script)
            .on_page_load(move |window, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Finished {
                    let base = local_base(&window);
                    state_for_load.set_local_url(base);
                }
            });
        prepare(builder, state, None).build().map_err(|error| format!("无法创建连接窗口: {error}"))?
    };
    let _ = window.show();
    tracing::info!("connect window ready at {}", state.local_url());
    Ok(window)
}

pub async fn open_main(app: &AppHandle, state: &Arc<AppState>, url: &Url) -> Result<WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window(MAIN) {
        let same_origin = existing.url().ok().map(|current| current.origin() == url.origin()).unwrap_or(false);
        if same_origin {
            // 同一个站点：直接在原窗口里跳转，重连不会闪一下窗口
            existing.navigate(url.clone()).map_err(|error| format!("无法重新加载页面: {error}"))?;
            let _ = existing.show();
            let _ = existing.unminimize();
            let _ = existing.set_focus();
            return Ok(existing);
        }
        // 换站点要按新的 origin 重建 WebView（Chromium 启动参数在创建时确定）；
        // 同一个 label 立刻重建会卡住，等旧窗口真的销毁
        let _ = existing.destroy();
        for _ in 0..120 {
            if app.get_webview_window(MAIN).is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        tracing::info!("old main window gone, creating a new one");
    }
    let script = crate::inject::build(state);
    let config = state.config();
    let origin = url.origin().ascii_serialization();
    let server_url = url.clone();
    let handle = app.clone();
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url.clone()))
        .title(format!("am-hook · {}", url.host_str().unwrap_or("GUI")))
        .inner_size(config.window.width.max(900.0), config.window.height.max(600.0))
        .min_inner_size(860.0, 540.0)
        .resizable(true)
        .initialization_script(&script)
        .on_navigation(move |target| {
            // 站内跳转（同一 origin）留在窗口里；其他链接交给系统浏览器
            if target.scheme() == "about" {
                return true;
            }
            if target.origin().ascii_serialization() == origin {
                return true;
            }
            tracing::info!("opening external link in the browser: {target}");
            open_external(&target);
            false
        })
        .on_page_load(move |window, payload| {
            tracing::info!(
                "{} page load ({}): {}",
                window.label(),
                if payload.event() == tauri::webview::PageLoadEvent::Started { "started" } else { "finished" },
                payload.url()
            );
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = handle.emit("gui://page-loaded", server_url.as_str());
            }
        });
    tracing::info!("creating main window for {url}");
    let window = prepare(builder, state, Some(url)).build().map_err(|error| format!("无法创建主窗口: {error}"))?;
    tracing::info!("main window ready");
    if let (Some(x), Some(y)) = (config.window.x, config.window.y) {
        let _ = window.set_position(LogicalPosition::new(x, y));
    }
    if config.window.maximized {
        let _ = window.maximize();
    }
    let _ = window.show();
    let _ = window.set_focus();
    Ok(window)
}

pub fn open_settings(app: &AppHandle, state: &Arc<AppState>) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(SETTINGS) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(window);
    }
    let script = crate::inject::build(state);
    let base = {
        let url = state.local_url();
        if url.is_empty() { "http://tauri.localhost/".to_string() } else { url }
    };
    let target = Url::parse(&format!("{base}settings.html")).map_err(|error| error.to_string())?;
    let builder = WebviewWindowBuilder::new(app, SETTINGS, WebviewUrl::External(target))
        .title("am-hook GUI 设置")
        .inner_size(1020.0, 760.0)
        .min_inner_size(860.0, 600.0)
        .center()
        .resizable(true)
        .initialization_script(&script);
    let window = prepare(builder, state, None).build().map_err(|error| format!("无法创建设置窗口: {error}"))?;
    let _ = window.show();
    let _ = window.set_focus();
    Ok(window)
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    } else if let Some(state) = app.try_state::<Arc<AppState>>() {
        let _ = ensure_connect(app, &state);
    }
}

pub fn hide_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.hide();
    }
}

pub fn close_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.destroy();
    }
}

/// 打开系统浏览器（不引入额外插件）
pub fn open_external(url: &Url) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let text = url.as_str().to_string();
        let _ = std::process::Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(text)
            .creation_flags(0x0800_0000)
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("xdg-open").arg(url.as_str()).spawn();
    }
}

/// 记住主窗口的大小与位置
pub fn save_bounds(window: &WebviewWindow, state: &Arc<AppState>) {
    let Ok(size) = window.inner_size() else { return };
    let scale = window.scale_factor().unwrap_or(1.0);
    let position = window.outer_position().ok();
    let maximized = window.is_maximized().unwrap_or(false);
    // 最小化 / 收起时报告的坐标是屏幕外的大负数，不能当成真的位置存下来
    let sane = |value: f64| value.is_finite() && (-20000.0..40000.0).contains(&value);
    let minimized = window.is_minimized().unwrap_or(false);
    state.update_config(|config| {
        if !maximized && !minimized {
            let width = size.width as f64 / scale;
            let height = size.height as f64 / scale;
            if width >= 640.0 && height >= 480.0 {
                config.window.width = width;
                config.window.height = height;
            }
            if let Some(position) = position {
                let x = position.x as f64 / scale;
                let y = position.y as f64 / scale;
                if sane(x) && sane(y) {
                    config.window.x = Some(x);
                    config.window.y = Some(y);
                }
            }
        }
        config.window.maximized = maximized;
    });
}

/// 连接状态变化时通知连接窗口
pub fn emit_connect(app: &AppHandle, connect: &ConnectState) {
    let _ = app.emit("gui://connect", connect);
}

pub fn window_event(state: &Arc<AppState>, window: &tauri::Window, event: &WindowEvent) {
    let label = window.label().to_string();
    let webview = window.app_handle().get_webview_window(window.label());
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            let config = state.config();
            match label.as_str() {
                MAIN => {
                    if let Some(webview) = webview.as_ref() {
                        save_bounds(webview, state);
                    }
                    api.prevent_close();
                    if config.behavior.close_to_tray {
                        // 收进托盘继续播放（右键托盘图标有完整菜单）。
                        // 但如果系统没接收我们的托盘图标（权限级别、explorer 异常等），
                        // 直接隐藏会让程序“人间蒸发”，这时改成最小化，至少任务栏还有入口。
                        let registered = window
                            .app_handle()
                            .tray_by_id("main")
                            .map(|tray| matches!(tray.rect(), Ok(Some(_))))
                            .unwrap_or(false);
                        if registered {
                            let _ = window.hide();
                        } else {
                            tracing::warn!("tray icon not registered; minimizing instead of hiding");
                            let _ = window.minimize();
                        }
                    } else {
                        // 默认行为：关窗就是退出，mpv 一起结束
                        crate::commands::quit(&window.app_handle());
                    }
                }
                CONNECT => {
                    api.prevent_close();
                    if config.behavior.close_to_tray {
                        let _ = window.hide();
                    } else {
                        crate::commands::quit(&window.app_handle());
                    }
                }
                _ => {}
            }
        }
        WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
            if label == MAIN
                && state.config().behavior.minimize_to_tray
                && window.is_minimized().unwrap_or(false)
            {
                let _ = window.hide();
                let _ = window.unminimize();
            }
        }
        WindowEvent::Destroyed => {
            if label == MAIN {
                tracing::info!("main window destroyed");
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_detection() {
        assert!(is_loopback(&Url::parse("http://127.0.0.1:8888/").unwrap()));
        assert!(is_loopback(&Url::parse("http://localhost:8888/").unwrap()));
        assert!(!is_loopback(&Url::parse("http://192.168.1.5:8888/").unwrap()));
        assert!(!is_loopback(&Url::parse("https://music.example.com/").unwrap()));
    }
}
