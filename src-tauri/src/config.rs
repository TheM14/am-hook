//! 持久化配置（`%APPDATA%/moe.amhook.gui/config.json`）。
//!
//! 配置改动都会写回磁盘；写入使用临时文件 + 替换，避免断电或崩溃留下半个文件。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 当前配置结构版本；将来结构变化时用来迁移
const CONFIG_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub version: u32,
    pub server: ServerConfig,
    pub mpv: MpvConfig,
    pub behavior: BehaviorConfig,
    pub window: WindowConfig,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ServerConfig {
    /// 上次连接成功的服务器地址（`http://host:port`）；为空表示还没有连接过
    pub url: Option<String>,
    /// 最近连接过的服务器地址（新的在前）
    pub history: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MpvConfig {
    /// 输出方式：`browser` 为页面自己解码输出，`mpv` 走本地 mpv
    pub enabled: bool,
    /// 明确指定的 mpv 可执行文件；为空时自动查找
    pub path: Option<String>,
    /// mpv 配置目录（以 `--config-dir=` 传给 mpv），例如一份带 HRTF 或滤波设置的 mpv.conf
    pub config_file: Option<String>,
    /// 传给 mpv 的额外参数（命令行写法，按空白拆开并支持引号）
    pub extra_args: String,
    /// WASAPI 设备名（`--audio-device` 的取值）；为空表示 mpv 默认设备
    pub device: String,
    /// WASAPI 独占输出（`--audio-exclusive=yes`）
    pub exclusive: bool,
    /// mpv 的 stdin 预读时长（`--cache-secs`），单位秒
    pub cache_seconds: u32,
    /// 在 mpv 输出时优先选择全景声（E-AC-3）音质：页面的选音质逻辑只在自己开了 JOC 时才首选
    /// Atmos，客户端通过临时打开页面的 JOC 偏好来达到同样效果（真正的解码仍由 mpv 做）
    pub prefer_atmos: bool,
}

impl Default for MpvConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            path: None,
            config_file: None,
            extra_args: String::new(),
            device: String::new(),
            exclusive: true,
            cache_seconds: 20,
            prefer_atmos: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BehaviorConfig {
    /// 关闭主窗口时收进托盘（音频继续播放）；默认关闭窗口就退出
    pub close_to_tray: bool,
    /// 最小化时收进托盘
    pub minimize_to_tray: bool,
    /// 启动时不显示窗口，只在托盘里
    pub start_hidden: bool,
    /// 对 http 的局域网 / 远程地址按安全上下文处理（Chromium 的
    /// `--unsafely-treat-insecure-origin-as-secure`），否则离线下载等依赖
    /// 安全上下文的功能在该地址上不可用
    pub insecure_origin_as_secure: bool,
    /// 窗口隐藏 / 最小化时不让 WebView 降低定时器频率
    pub background_playback: bool,
}

impl Default for BehaviorConfig {
    fn default() -> Self {
        Self {
            close_to_tray: false,
            minimize_to_tray: false,
            start_hidden: false,
            insecure_origin_as_secure: true,
            background_playback: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WindowConfig {
    pub width: f64,
    pub height: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub maximized: bool,
}

impl Default for WindowConfig {
    fn default() -> Self {
        Self { width: 1320.0, height: 880.0, x: None, y: None, maximized: false }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            server: ServerConfig::default(),
            mpv: MpvConfig::default(),
            behavior: BehaviorConfig::default(),
            window: WindowConfig::default(),
        }
    }
}

impl Config {
    /// 读取配置；文件不存在或解析失败时返回默认值（坏文件先备份成 `.bak`）
    pub fn load(path: &Path) -> Self {
        let Ok(text) = fs::read_to_string(path) else { return Self::default() };
        match serde_json::from_str::<Config>(&text) {
            Ok(config) => config,
            Err(error) => {
                tracing::warn!("config {} unreadable ({error}), starting from defaults", path.display());
                let _ = fs::copy(path, path.with_extension("json.bak"));
                Self::default()
            }
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        let temp: PathBuf = path.with_extension("json.tmp");
        fs::write(&temp, text)?;
        fs::rename(&temp, path)?;
        Ok(())
    }

    /// 记录一次连接：设为当前地址并放进历史（最新的在前，最多 8 个）
    pub fn remember_server(&mut self, url: &str) {
        self.server.url = Some(url.to_string());
        self.server.history.retain(|entry| entry != url);
        self.server.history.insert(0, url.to_string());
        self.server.history.truncate(8);
    }

    /// 页面脚本需要的设置（注入脚本通过 bridge 的 `/config` 读取）
    pub fn page_settings(&self) -> serde_json::Value {
        serde_json::json!({
            "mpv": {
                "enabled": self.mpv.enabled,
                "device": self.mpv.device,
                "exclusive": self.mpv.exclusive,
                "extraArgs": self.mpv.extra_args,
                "configFile": self.mpv.config_file,
                "path": self.mpv.path,
                "preferAtmos": self.mpv.prefer_atmos,
            },
            "server": self.server.url,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_defaults() {
        let mut config = Config::default();
        config.remember_server("http://127.0.0.1:8888");
        config.remember_server("http://192.168.1.5:8888");
        config.remember_server("http://127.0.0.1:8888");
        assert_eq!(config.server.history, vec!["http://127.0.0.1:8888", "http://192.168.1.5:8888"]);

        let json = serde_json::to_string(&config).unwrap();
        let parsed: Config = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.server.url.as_deref(), Some("http://127.0.0.1:8888"));
        assert!(parsed.mpv.enabled);

        // 缺字段的旧配置也能读出来
        let partial: Config = serde_json::from_str(r#"{"mpv":{"enabled":false}}"#).unwrap();
        assert!(!partial.mpv.enabled);
        assert_eq!(partial.behavior.close_to_tray, false);
    }
}
