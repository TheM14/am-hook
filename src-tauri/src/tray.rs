//! 托盘图标与菜单：显示窗口、重新连接、更换服务器、切换 MPV 输出、设置、退出。

use std::sync::{Arc, OnceLock};

use tauri::menu::{CheckMenuItem, MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::state::AppState;

static MPV_ITEM: OnceLock<CheckMenuItem<Wry>> = OnceLock::new();

/// 托盘提示：让「后台在放」这件事看得见（Windows 11 会把新图标收进折叠区）
pub fn set_tooltip(app: &AppHandle, text: &str) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(text));
    }
}

/// 菜单项的勾选状态跟着配置走（页面里的悬浮面板也能改）
pub fn sync_mpv_checked(enabled: bool) {
    if let Some(item) = MPV_ITEM.get() {
        let _ = item.set_checked(enabled);
    }
}

/// 创建托盘图标并把句柄存起来；`rect()` 能拿到矩形才说明 shell 真的收下了这个图标。
fn create(app: &AppHandle, state: &Arc<AppState>) -> tauri::Result<()> {
    let config = state.config();
    let show = MenuItemBuilder::with_id("show", "打开主页面").build(app)?;
    let reconnect = MenuItemBuilder::with_id("reconnect", "重新连接").build(app)?;
    let server = MenuItemBuilder::with_id("server", "更换服务器…").build(app)?;
    let mpv = CheckMenuItem::with_id(app, "mpv", "MPV 输出（本机独占）", true, config.mpv.enabled, None::<&str>)?;
    let settings = MenuItemBuilder::with_id("settings", "设置").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[
            &show,
            &settings,
            &quit,
            &PredefinedMenuItem::separator(app)?,
            &mpv,
            &reconnect,
            &server,
        ])
        .build()?;
    MPV_ITEM.set(mpv).ok();

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("am-hook GUI")
        .on_menu_event(move |app, event| {
            let state = app.try_state::<Arc<AppState>>().map(|state| state.inner().clone());
            match event.id().as_ref() {
                "show" => crate::windows::show_main(app),
                "reconnect" => {
                    if let Some(state) = state.clone() {
                        crate::commands::reconnect_now(app, &state);
                    }
                }
                "server" => {
                    if let Some(state) = state.clone() {
                        let _ = crate::windows::ensure_connect(app, &state);
                    }
                }
                "mpv" => {
                    if let Some(state) = state.clone() {
                        let enabled = !state.config().mpv.enabled;
                        state.update_config(|config| config.mpv.enabled = enabled);
                        sync_mpv_checked(enabled);
                        crate::commands::broadcast(app, &state);
                    }
                }
                "settings" => {
                    if let Some(state) = state.clone() {
                        let _ = crate::windows::open_settings(app, &state);
                    }
                }
                "quit" => crate::commands::quit(app),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                let app = tray.app_handle();
                match app.get_webview_window(crate::windows::MAIN) {
                    Some(window) if window.is_visible().unwrap_or(false) => {
                        let _ = window.hide();
                    }
                    _ => crate::windows::show_main(app),
                }
            }
        });
    match app.default_window_icon().cloned() {
        Some(icon) => {
            tracing::info!("tray icon from window icon: {}x{}", icon.width(), icon.height());
            builder = builder.icon(icon);
        }
        None => tracing::warn!("tray: no default window icon available"),
    }
    // 图标由 Tauri 的资源表持有（`TrayIcon` 是 Rc），这里拿到的句柄用完就放掉，别再存到别处
    let tray = builder.build(app)?;
    if let Ok(rect) = tray.rect() {
        tracing::info!("tray icon registered at {rect:?}");
    } else {
        // shell 还没准备好（开机自启、explorer 重启中）时 NIM_ADD 会失败，tray-icon 只是静默
        // 等 TaskbarCreated；这里记下来，交给下面的自检任务
        tracing::warn!("tray icon not registered yet");
    }
    drop(tray);
    Ok(())
}

/// 建好之后做一次自检：拿不到图标矩形时，再用一次 `Shell_NotifyIcon` 探明是
/// 「系统拒收」还是「只是收进了折叠区」。这里**不会**销毁重建——Windows 11 的折叠区里
/// 的图标本来就取不到矩形，反复重建会让它一直从列表里消失。
fn diagnose(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let rect = app
            .tray_by_id("main")
            .and_then(|tray| tray.rect().ok().flatten());
        match rect {
            Some(rect) => tracing::info!("tray icon location: {rect:?}"),
            None => {
                let probe = crate::commands::tray_probe_result(&app);
                tracing::warn!(
                    "tray icon location unavailable (可能在 ^ 折叠区里); shell probe: {probe}"
                );
            }
        }
    });
}

pub fn build(app: &AppHandle, state: &Arc<AppState>) -> tauri::Result<()> {
    create(app, state)?;
    diagnose(app.clone());
    Ok(())
}
