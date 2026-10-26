pub mod args;
pub mod bridge;
pub mod commands;
pub mod config;
pub mod events;
pub mod inject;
pub mod logging;
pub mod mpv;
pub mod paths;
pub mod server;
pub mod state;
pub mod tray;
pub mod windows;

use std::sync::Arc;

use tauri::Manager;

use crate::config::Config;
use crate::state::AppState;

/// bridge 的访问令牌：每次启动重新生成，只交给本窗口里注入的脚本
fn random_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_nanos()).unwrap_or(0);
    let pid = std::process::id() as u128;
    let mix = nanos ^ (pid << 64) ^ nanos.rotate_left(23) ^ 0x9e37_79b9_7f4a_7c15;
    format!("{mix:032x}")
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 第二次启动：把已有窗口带到前面
            if app.get_webview_window(windows::MAIN).is_some() {
                windows::show_main(app);
            } else if let Some(state) = app.try_state::<Arc<AppState>>() {
                let _ = windows::ensure_connect(app, state.inner());
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let preferred = handle.path().app_config_dir().ok();
            let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()));
            let (data_dir, report) = paths::resolve_with_report(preferred.clone(), exe_dir);
            logging::init(Some(data_dir.clone()));
            tracing::info!("am-hook GUI {} starting (data dir {})", env!("CARGO_PKG_VERSION"), data_dir.display());
            for line in &report {
                tracing::info!("data dir candidate {line}");
            }
            // 数据目录回退了，说明这个进程写不了自己的用户目录：多半是被某个沙箱/受限令牌
            // 拉起来的。这种情况下 shell 也会拒绝托盘图标（NIM_ADD 返回 ACCESS_DENIED），
            // 直接在日志里说清楚，免得把环境问题当成 bug 查。
            let restricted = preferred.as_ref().map(|dir| *dir != data_dir).unwrap_or(false);
            if restricted {
                tracing::warn!(
                    "running with restricted permissions: data dir fell back to {}, tray icon and page storage may be unavailable — start the exe directly instead",
                    data_dir.display()
                );
            }

            let config_path = data_dir.join("config.json");
            let config = Config::load(&config_path);
            let (ui_tx, mut ui_rx) = tokio::sync::mpsc::unbounded_channel();
            let state = AppState::new(config, config_path, data_dir, restricted, random_token(), ui_tx);
            app.manage(state.clone());
            state.set_local_url(windows::LOCAL_BASE.to_string());
            tray::build(&handle, &state)?;

            let ui_handle = handle.clone();
            let ui_state = state.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(action) = ui_rx.recv().await {
                    commands::handle_ui_action(&ui_handle, &ui_state, action);
                }
            });

            // 连接窗口在主线程里建好：WebView 的创建要等事件循环，放到后台线程里会一直等不到
            if !state.config().behavior.start_hidden {
                if let Err(error) = windows::ensure_connect(&handle, &state) {
                    tracing::error!("cannot create the connect window: {error}");
                }
            }

            let boot_handle = handle.clone();
            let boot_state = state.clone();
            tauri::async_runtime::spawn(async move {
                match bridge::start(boot_state.clone(), boot_state.bridge_token.clone()).await {
                    Ok(info) => tracing::info!("bridge listening on 127.0.0.1:{}", info.port),
                    Err(error) => tracing::error!("bridge failed to start: {error}"),
                }
                commands::auto_connect(&boot_handle, &boot_state);
            });

            // 连上之后每隔几秒探一次服务器：关掉 am-hook 时页面会显示「服务器已断开」并可重试
            let watch_state = state.clone();
            tauri::async_runtime::spawn(async move {
                let client = crate::server::client();
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(8)).await;
                    let Some(server) = watch_state.server() else {
                        watch_state.failures.store(0, std::sync::atomic::Ordering::Relaxed);
                        *watch_state.alive.write().expect("alive rwlock") = false;
                        continue;
                    };
                    match crate::server::ping(&client, &server.url).await {
                        Ok(()) => {
                            let was = *watch_state.alive.read().expect("alive rwlock");
                            watch_state.failures.store(0, std::sync::atomic::Ordering::Relaxed);
                            *watch_state.alive.write().expect("alive rwlock") = true;
                            if !was {
                                tracing::info!("server {} is back", server.url);
                                crate::events::send(
                                    &watch_state.events,
                                    crate::events::BridgeEvent::ServerStatus { alive: true, message: None },
                                );
                            }
                        }
                        Err(message) => {
                            let failures =
                                watch_state.failures.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                            if failures == 2 {
                                tracing::warn!("server {} unreachable: {message}", server.url);
                                *watch_state.alive.write().expect("alive rwlock") = false;
                                crate::events::send(
                                    &watch_state.events,
                                    crate::events::BridgeEvent::ServerStatus {
                                        alive: false,
                                        message: Some(message),
                                    },
                                );
                            }
                        }
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let Some(state) = window.app_handle().try_state::<Arc<AppState>>() {
                windows::window_event(state.inner(), window, event);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::gui_snapshot,
            commands::check_server,
            commands::connect,
            commands::connect_anyway,
            commands::disconnect,
            commands::save_config,
            commands::probe_mpv,
            commands::list_devices,
            commands::pick_mpv_exe,
            commands::pick_config_file,
            commands::open_settings,
            commands::open_connect,
            commands::show_main,
            commands::tray_status,
            commands::tray_probe,
            commands::hide_to_tray,
            commands::reconnect,
            commands::quit_app,
            commands::logs,
            commands::open_data_dir,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the am-hook GUI application");

    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if !commands::exiting() {
                // 有托盘常驻：关掉所有窗口也继续在后台放音
                api.prevent_exit();
            }
        }
        tauri::RunEvent::Exit => {
            if let Some(state) = app.try_state::<Arc<AppState>>() {
                state.mpv.kill_all_sync();
            }
        }
        _ => {}
    });
}
