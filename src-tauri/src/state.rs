//! 全局状态：配置、bridge 端口与令牌、当前服务器、mpv 管理器、事件总线。

use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Instant;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

use crate::config::Config;
use crate::events::{self, EventBus};
use crate::mpv::{Mpv, PlaySettings};

/// 已连接的 am-hook 服务器信息
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub url: String,
    pub title: String,
    /// 页面是否带浏览器内解密（`AmDecrypt`），mpv 输出依赖它
    pub decrypt: bool,
    /// 服务端是否转发 wrapper-lite
    pub wrapper_relay: Option<bool>,
    pub regions: Vec<String>,
    pub wrapper_url: Option<String>,
    #[serde(skip)]
    pub checked_at: Option<Instant>,
}

/// 连接流程的状态：连接窗口据此显示「正在连接 / 失败原因 / 已连接」
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectState {
    /// idle | checking | failed | connected
    pub status: String,
    pub url: Option<String>,
    pub message: Option<String>,
    pub kind: Option<String>,
}

impl ConnectState {
    pub fn idle() -> Self {
        Self { status: "idle".into(), ..Self::default() }
    }
}

/// 页面请求选择本地文件时的目标
#[derive(Clone, Copy, Debug)]
pub enum PathKind {
    MpvExe,
    MpvConfig,
}

/// 设置窗口 / 托盘要 GUI 做的事（页面里的悬浮面板通过 bridge 的 `/ui` 发过来）
#[derive(Debug)]
pub enum UiAction {
    OpenSettings,
    ShowConnect,
    Reconnect,
    ShowMain,
    HideMain,
    MinimizeMain,
    CloseMain,
    /// 打开系统文件对话框，结果通过 oneshot 回给请求方
    PickPath {
        kind: PathKind,
        reply: tokio::sync::oneshot::Sender<Option<String>>,
    },
    Quit,
}

pub struct AppState {
    pub config: RwLock<Config>,
    pub config_path: PathBuf,
    pub data_dir: PathBuf,
    /// 数据目录没能用上 app config dir（受限权限/被沙箱拉起），界面会提示
    pub data_dir_fallback: bool,
    pub mpv: Arc<Mpv>,
    pub events: EventBus,
    pub bridge_port: RwLock<u16>,
    pub bridge_token: String,
    pub server: RwLock<Option<ServerInfo>>,
    pub connect: RwLock<ConnectState>,
    /// 服务器探活：最近一次是否可达、连续失败次数
    pub alive: RwLock<bool>,
    pub failures: std::sync::atomic::AtomicU32,
    pub local_url: RwLock<String>,
    pub ui: UnboundedSender<UiAction>,
    pub started: Instant,
}

impl AppState {
    pub fn new(
        config: Config,
        config_path: PathBuf,
        data_dir: PathBuf,
        data_dir_fallback: bool,
        token: String,
        ui: UnboundedSender<UiAction>,
    ) -> Arc<Self> {
        let bus = events::bus();
        let mpv = Arc::new(Mpv::new(bus.clone()));
        Arc::new(Self {
            config: RwLock::new(config),
            config_path,
            data_dir,
            data_dir_fallback,
            mpv,
            events: bus,
            bridge_port: RwLock::new(0),
            bridge_token: token,
            server: RwLock::new(None),
            connect: RwLock::new(ConnectState::idle()),
            alive: RwLock::new(false),
            failures: std::sync::atomic::AtomicU32::new(0),
            local_url: RwLock::new(String::new()),
            ui,
            started: Instant::now(),
        })
    }

    pub fn config(&self) -> Config {
        self.config.read().expect("config rwlock").clone()
    }

    /// 修改配置、写盘并广播，页面据此更新输出方式
    pub fn update_config(&self, change: impl FnOnce(&mut Config)) {
        let snapshot = {
            let mut config = self.config.write().expect("config rwlock");
            change(&mut config);
            config.clone()
        };
        if let Err(error) = snapshot.save(&self.config_path) {
            tracing::warn!("cannot save config: {error}");
        }
        events::send(&self.events, events::BridgeEvent::Config { settings: snapshot.page_settings() });
    }

    /// mpv 播放设置（来自配置）
    pub fn play_settings(&self) -> PlaySettings {
        let config = self.config();
        PlaySettings {
            path: config.mpv.path.clone(),
            extra_args: config.mpv.extra_args.clone(),
            device: config.mpv.device.clone(),
            config_file: config.mpv.config_file.clone(),
            exclusive: config.mpv.exclusive,
            cache_seconds: config.mpv.cache_seconds,
            args: Vec::new(),
        }
    }

    pub fn bridge_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.bridge_port.read().expect("bridge port rwlock"))
    }

    pub fn set_server(&self, info: Option<ServerInfo>) {
        let url = info.as_ref().map(|info| info.url.clone());
        *self.server.write().expect("server rwlock") = info;
        events::send(&self.events, events::BridgeEvent::Server { url });
    }

    pub fn server(&self) -> Option<ServerInfo> {
        self.server.read().expect("server rwlock").clone()
    }

    pub fn set_connect(&self, next: ConnectState) {
        *self.connect.write().expect("connect rwlock") = next;
    }

    pub fn connect_state(&self) -> ConnectState {
        self.connect.read().expect("connect rwlock").clone()
    }

    pub fn set_local_url(&self, url: String) {
        *self.local_url.write().expect("local url rwlock") = url;
    }

    pub fn local_url(&self) -> String {
        self.local_url.read().expect("local url rwlock").clone()
    }

    /// 给设置窗口 / 连接窗口的状态快照
    pub fn snapshot(&self) -> Value {
        let config = self.config();
        let info = self.mpv.info(config.mpv.path.as_deref(), false);
        serde_json::json!({
            "config": config,
            "configPath": self.config_path.display().to_string(),
            "dataDir": self.data_dir.display().to_string(),
            "webviewDir": crate::paths::webview_dir(&self.data_dir).display().to_string(),
            "dataDirFallback": self.data_dir_fallback,
            "bridge": { "port": *self.bridge_port.read().expect("bridge port rwlock"), "url": self.bridge_url() },
            "localUrl": self.local_url(),
            "mpv": info,
            "server": self.server(),
            "connect": self.connect_state(),
            "session": self.mpv.current(),
            "uptimeSeconds": self.started.elapsed().as_secs(),
        })
    }
}
