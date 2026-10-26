//! 本地 mpv 进程：启动、命名管道 IPC、stdin 流式喂数据、状态轮询、设备枚举。
//!
//! 页面只负责取流与解密（`AmDecrypt`），解密后的音频分段原样写进 mpv 的 stdin，
//! 由 mpv 自己解码输出。播放、暂停、seek、音量走 mpv 的 JSON IPC。
//!
//! 状态轮询的结果会广播给订阅者，页面不必自己定时查询。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{broadcast, Mutex as AsyncMutex};
use tracing::{info, warn};

use crate::events::{BridgeEvent, EventBus};

/// 传给 mpv 的参数里不允许出现的选项：`--script` 可以让 mpv 执行任意 Lua，
/// `--input-conf` / `--include` 能间接做到同样的事，`--input-ipc-server` 会抢走
/// 我们自己的控制管道，`--log-file` 会覆盖运行日志。
const BLOCKED_ARGS: [&str; 5] =
    ["--script", "--input-conf", "--include", "--input-ipc-server", "--log-file"];

/// 启动 mpv 的必需参数（不含用户自己的参数；指定了配置目录时 `--no-config` 换成 `--config=yes`）
const BASE_ARGS: [&str; 11] = [
    "--no-video",
    "--load-scripts=no",
    "--force-window=no",
    "--terminal=no",
    "--audio-display=no",
    "--idle=no",
    "--cache=yes",
    "--demuxer-seekable-cache=yes",
    "--keep-open=no",
    "--msg-level=all=no",
    "--input-terminal=no",
];

/// 一次播放会话：一个 mpv 进程
pub struct Session {
    pub id: String,
    pipe: String,
    stdin: AsyncMutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    /// mpv 的 stderr（最多保留 8 KB）：退出码非 0 时带给页面看
    stderr: Arc<Mutex<String>>,
    fed: AtomicU64,
    /// 最近一次轮询到的状态（SSE 与 `/mpv/state` 共用）
    state: Mutex<SessionState>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub alive: bool,
    pub position: f64,
    pub duration: Option<f64>,
    pub paused: bool,
    pub codec: Option<String>,
    /// mpv 实际使用的解码器（JOC 时为 joc）
    pub decoder: Option<String>,
    /// mpv 实际使用的输出设备（`--audio-device`）
    pub device: Option<String>,
    pub samplerate: Option<u64>,
    pub channels: Option<u64>,
    pub eof: bool,
    pub fed: u64,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

impl Session {
    fn try_wait(&self) -> Option<std::process::ExitStatus> {
        let mut child = self.child.lock().expect("mpv child mutex");
        child.as_mut().and_then(|child| child.try_wait().ok().flatten())
    }

    fn stderr_text(&self) -> String {
        self.stderr.lock().map(|text| text.trim().to_string()).unwrap_or_default()
    }

    fn snapshot(&self) -> SessionState {
        let mut state = self.state.lock().expect("mpv state mutex").clone();
        state.fed = self.fed.load(Ordering::Relaxed);
        state
    }

    async fn kill(&self) {
        // 先 quit：让 mpv 正常关闭设备（独占模式下直接杀进程可能留下设备占用）
        if self.try_wait().is_none() {
            let _ = ipc(&self.pipe, &[vec![json!("quit")]], Duration::from_millis(600)).await;
        }
        let mut child = self.child.lock().expect("mpv child mutex").take();
        if let Some(child) = child.as_mut() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.start_kill();
            }
        }
        if let Some(mut child) = child {
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        }
    }
}

/// 由一个 mpv 进程构成的输出端；同一时间只有一个会话（新的播放会先停掉旧的）
pub struct Mpv {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    counter: AtomicU64,
    events: EventBus,
    devices: Mutex<Option<CachedDevices>>,
    info: Mutex<Option<CachedInfo>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
}

struct CachedDevices {
    at: Instant,
    for_path: String,
    devices: Vec<Device>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvInfo {
    pub found: bool,
    pub path: String,
    pub version: String,
}

struct CachedInfo {
    at: Instant,
    for_path: String,
    info: MpvInfo,
}

/// 一次播放用的设置（来自 GUI 配置）
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaySettings {
    pub path: Option<String>,
    #[serde(default)]
    pub extra_args: String,
    #[serde(default)]
    pub device: String,
    /// mpv 配置目录或其中的 mpv.conf（以 `--config-dir=` 传给 mpv）
    #[serde(default)]
    pub config_file: Option<String>,
    #[serde(default = "default_true")]
    pub exclusive: bool,
    #[serde(default = "default_cache")]
    pub cache_seconds: u32,
    /// 传给 mpv 的额外参数（已拆好）；来自页面时为空，用配置里的写法
    #[serde(default)]
    pub args: Vec<String>,
}

fn default_true() -> bool {
    true
}

fn default_cache() -> u32 {
    20
}

impl Mpv {
    pub fn new(events: EventBus) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(1),
            events,
            devices: Mutex::new(None),
            info: Mutex::new(None),
        }
    }

    /// 当前会话 id（没有时为空）
    pub fn current(&self) -> Option<String> {
        self.sessions.lock().expect("mpv sessions mutex").keys().next().cloned()
    }

    pub fn session_ids(&self) -> Vec<String> {
        self.sessions.lock().expect("mpv sessions mutex").keys().cloned().collect()
    }

    fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().expect("mpv sessions mutex").get(id).cloned()
    }

    fn take(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().expect("mpv sessions mutex").remove(id)
    }

    pub async fn stop(&self, id: &str) {
        if let Some(session) = self.take(id) {
            session.kill().await;
            let mut state = session.state.lock().expect("mpv state mutex");
            state.alive = false;
        }
    }

    pub async fn stop_all(&self) {
        for id in self.session_ids() {
            self.stop(&id).await;
        }
    }

    /// 同步结束所有 mpv（退出进程时用：不能等异步任务，也不能留下子进程占着独占设备）
    pub fn kill_all_sync(&self) {
        let sessions: Vec<Arc<Session>> =
            self.sessions.lock().expect("mpv sessions mutex").values().cloned().collect();
        for session in sessions {
            let mut child = session.child.lock().expect("mpv child mutex");
            if let Some(child) = child.as_mut() {
                let _ = child.start_kill();
            }
        }
        self.sessions.lock().expect("mpv sessions mutex").clear();
    }

    /// 查询 mpv 版本与 JOC 支持（结果缓存 60 秒）
    pub fn info(&self, path: Option<&str>, refresh: bool) -> MpvInfo {
        let resolved = resolve_mpv(path);
        let key = resolved.as_ref().map(|path| path.display().to_string()).unwrap_or_default();
        if !refresh {
            if let Some(cached) = self.info.lock().expect("mpv info mutex").as_ref() {
                if cached.for_path == key && cached.at.elapsed() < Duration::from_secs(60) {
                    return cached.info.clone();
                }
            }
        }
        let info = match resolved {
            None => MpvInfo { found: false, path: String::new(), version: String::new() },
            Some(exe) => {
                let version = probe_version(&exe);
                MpvInfo {
                    found: true,
                    path: display_path(&exe),
                    version: version.unwrap_or_default(),
                }
            }
        };
        *self.info.lock().expect("mpv info mutex") =
            Some(CachedInfo { at: Instant::now(), for_path: key, info: info.clone() });
        info
    }

    /// 枚举 WASAPI 设备：起一个 idle 的 mpv 查询 `audio-device-list`，5 分钟内复用结果
    pub async fn devices(&self, path: Option<&str>, refresh: bool) -> Result<Vec<Device>, String> {
        let exe = resolve_mpv(path).ok_or_else(|| "找不到 mpv".to_string())?;
        let key = exe.display().to_string();
        if !refresh {
            if let Some(cached) = self.devices.lock().expect("mpv devices mutex").as_ref() {
                if cached.for_path == key && cached.at.elapsed() < Duration::from_secs(300) {
                    return Ok(cached.devices.clone());
                }
            }
        }
        let list = enumerate_devices(&exe).await?;
        *self.devices.lock().expect("mpv devices mutex") =
            Some(CachedDevices { at: Instant::now(), for_path: key, devices: list.clone() });
        Ok(list)
    }

    /// 起一个 mpv 播放会话，等 IPC 可用后返回会话 id
    pub async fn play(&self, settings: &PlaySettings) -> Result<String, String> {
        self.stop_all().await;
        let args = build_args(settings)?;
        let session = self.spawn(settings.path.as_deref(), &args).await?;
        let id = session.id.clone();
        Ok(id)
    }

    async fn spawn(&self, path: Option<&str>, args: &[String]) -> Result<Arc<Session>, String> {
        let exe = resolve_mpv(path).ok_or_else(|| {
            "找不到 mpv：请在设置里指定 mpv.exe 的路径".to_string()
        })?;
        let id = format!("{:x}{:x}", std::process::id(), self.counter.fetch_add(1, Ordering::Relaxed));
        let pipe = pipe_name(&id);

        // 指定了配置目录就不能再 --no-config，否则 mpv 不会读那个目录里的 mpv.conf
        let has_config = args.iter().any(|arg| arg.starts_with("--config-dir") || arg.starts_with("--config="));
        let mut command = tokio::process::Command::new(&exe);
        if !has_config {
            command.arg("--no-config");
        } else {
            command.arg("--config=yes");
        }
        command.args(BASE_ARGS).arg(format!("--input-ipc-server={pipe}"));
        command.args(args).arg("-");
        command.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            // CREATE_NO_WINDOW：不要弹出控制台窗口
            command.creation_flags(0x0800_0000);
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 {}: {error}", exe.display()))?;
        if let Some(pid) = child.id() {
            job::assign(pid);
        }
        let stdin = child.stdin.take();
        let stderr = Arc::new(Mutex::new(String::new()));
        if let Some(mut source) = child.stderr.take() {
            let sink = stderr.clone();
            tokio::spawn(async move {
                let mut buffer = [0u8; 1024];
                loop {
                    match source.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(count) => {
                            if let Ok(mut text) = sink.lock() {
                                if text.len() < 8192 {
                                    text.push_str(&String::from_utf8_lossy(&buffer[..count]));
                                }
                            }
                        }
                    }
                }
            });
        }

        let session = Arc::new(Session {
            id: id.clone(),
            pipe: pipe.clone(),
            stdin: AsyncMutex::new(stdin),
            child: Mutex::new(Some(child)),
            stderr,
            fed: AtomicU64::new(0),
            state: Mutex::new(SessionState { alive: true, ..SessionState::default() }),
        });
        // 等 mpv 建好 IPC 管道：之后喂数据与查询都不会抢跑
        if let Err(error) =
            ipc(&pipe, &[vec![json!("get_property"), json!("mpv-version")]], Duration::from_secs(8)).await
        {
            session.kill().await;
            return Err(format!("mpv 的 IPC 不可用: {error}"));
        }
        self.sessions.lock().expect("mpv sessions mutex").insert(id.clone(), session.clone());
        info!("mpv session {id} started ({} {})", exe.display(), args.join(" "));
        self.spawn_poll(session.clone());
        Ok(session)
    }

    /// 每 250 ms 查一次状态并广播；进程退出时广播 ended 或 error
    fn spawn_poll(&self, session: Arc<Session>) {
        let events = self.events.clone();
        let pipe = session.pipe.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(250));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                if let Some(status) = session.try_wait() {
                    let error = session.stderr_text();
                    let code = status.code();
                    {
                        let mut state = session.state.lock().expect("mpv state mutex");
                        state.alive = false;
                        state.exit_code = code;
                        state.error = (!error.is_empty()).then(|| last_line(&error));
                    }
                    let snapshot = session.snapshot();
                    if code.unwrap_or(0) != 0 || snapshot.error.is_some() && !snapshot.eof {
                        let message = snapshot
                            .error
                            .clone()
                            .unwrap_or_else(|| format!("mpv 异常退出（{}）", code.unwrap_or(-1)));
                        if code.unwrap_or(0) != 0 {
                            warn!("mpv session {} exited with {:?}: {}", session.id, code, error);
                            crate::events::send(&events, BridgeEvent::MpvError { session: session.id.clone(), message });
                        } else {
                            crate::events::send(&events, BridgeEvent::MpvEnded { session: session.id.clone() });
                        }
                    } else {
                        crate::events::send(&events, BridgeEvent::MpvEnded { session: session.id.clone() });
                    }
                    break;
                }
                let commands = vec![
                    vec![json!("get_property"), json!("time-pos")],
                    vec![json!("get_property"), json!("duration")],
                    vec![json!("get_property"), json!("pause")],
                    vec![json!("get_property"), json!("audio-out-params")],
                    vec![json!("get_property"), json!("audio-codec-name")],
                    vec![json!("get_property"), json!("eof-reached")],
                    vec![json!("get_property"), json!("current-tracks/audio/decoder-desc")],
                    vec![json!("get_property"), json!("audio-device")],
                ];
                let Ok(replies) = ipc(&pipe, &commands, Duration::from_millis(1200)).await else {
                    // mpv 正在启动解码器时可能短暂不响应：下一轮再试
                    continue;
                };
                let value = |index: usize| replies.get(index).and_then(|reply| data_of(reply).ok());
                let params = value(3).unwrap_or(Value::Null);
                let mut state = session.state.lock().expect("mpv state mutex");
                if let Some(position) = value(0).and_then(|value| value.as_f64()) {
                    state.position = position;
                }
                if let Some(duration) = value(1).and_then(|value| value.as_f64()) {
                    state.duration = Some(duration);
                }
                if let Some(paused) = value(2).and_then(|value| value.as_bool()) {
                    state.paused = paused;
                }
                if let Some(codec) = value(4).and_then(|value| value.as_str().map(str::to_string)) {
                    state.codec = Some(codec);
                }
                if let Some(decoder) = value(6).and_then(|value| value.as_str().map(str::to_string)) {
                    state.decoder = Some(decoder);
                }
                if let Some(device) = value(7).and_then(|value| value.as_str().map(str::to_string)) {
                    state.device = Some(device);
                }
                if let Some(rate) = params.get("samplerate").and_then(Value::as_u64) {
                    state.samplerate = Some(rate);
                }
                if let Some(channels) = params.get("channel-count").and_then(Value::as_u64) {
                    state.channels = Some(channels);
                }
                state.eof = value(5).and_then(|value| value.as_bool()).unwrap_or(false);
                state.fed = session.fed.load(Ordering::Relaxed);
                let snapshot = state.clone();
                drop(state);
                crate::events::send(&events, BridgeEvent::MpvState { session: session.id.clone(), state: snapshot.clone() });
                if snapshot.eof {
                    // EOF 之后 mpv 会自己退出（--idle=no），下一轮就能看到退出码
                    continue;
                }
            }
        });
    }

    /// 页面把解密后的 fMP4 分片按到达顺序原样写进 mpv 的 stdin。
    ///
    /// 一段一次请求：请求体可以是一整段（页面用普通 POST，等写完再发下一段），也可以是流式请求体
    /// （其他客户端）。写不进 mpv 时请求就挂在这里，页面自然慢下来，这就是背压。
    pub async fn feed(&self, id: &str, body: axum::body::Body) -> Result<u64, FeedError> {
        let Some(session) = self.get(id) else { return Err(FeedError::NotFound) };
        use futures::StreamExt;
        let mut stream = body.into_data_stream();
        let mut written = 0u64;
        while let Some(chunk) = stream.next().await {
            let Ok(bytes) = chunk else { break };
            if bytes.is_empty() {
                continue;
            }
            self.write(session.clone(), &bytes).await?;
            written += bytes.len() as u64;
        }
        Ok(written)
    }

    async fn write(&self, session: Arc<Session>, bytes: &[u8]) -> Result<(), FeedError> {
        let mut stdin = session.stdin.lock().await;
        let Some(stdin) = stdin.as_mut() else { return Err(FeedError::Closed) };
        stdin.write_all(bytes).await.map_err(|_| FeedError::Closed)?;
        let fed = session.fed.fetch_add(bytes.len() as u64, Ordering::Relaxed) + bytes.len() as u64;
        debug_assert!(fed >= bytes.len() as u64);
        Ok(())
    }

    /// 这一首的数据送完了：关掉 mpv 的 stdin，让 mpv 播完缓冲后自己退出
    pub async fn feed_end(&self, id: &str) -> Result<(), FeedError> {
        let Some(session) = self.get(id) else { return Err(FeedError::NotFound) };
        let mut stdin = session.stdin.lock().await;
        if let Some(mut stdin) = stdin.take() {
            let _ = stdin.shutdown().await;
        }
        Ok(())
    }

    pub async fn control(&self, id: &str, command: &str, value: &Value) -> Result<(), String> {
        let Some(session) = self.get(id) else { return Err("mpv 会话不存在".into()) };
        let command = match command {
            "pause" => vec![json!("set_property"), json!("pause"), json!(true)],
            "resume" => vec![json!("set_property"), json!("pause"), json!(false)],
            "toggle" => vec![json!("cycle"), json!("pause")],
            "seek" => {
                let Some(seconds) = value.as_f64().filter(|value| value.is_finite()) else {
                    return Err("seek 需要一个数值".into());
                };
                vec![json!("seek"), json!(seconds.max(0.0)), json!("absolute")]
            }
            "volume" => {
                let Some(volume) = value.as_f64().filter(|value| value.is_finite()) else {
                    return Err("volume 需要一个数值".into());
                };
                vec![json!("set_property"), json!("volume"), json!(volume.clamp(0.0, 100.0))]
            }
            other => return Err(format!("未知的 mpv 命令: {other}")),
        };
        match ipc(&session.pipe, &[command], Duration::from_millis(1500)).await {
            Ok(mut replies) if !replies.is_empty() => match data_of(&replies.remove(0)) {
                Ok(_) => Ok(()),
                Err(message) => Err(format!("mpv 拒绝了命令: {message}")),
            },
            Ok(_) => Err("mpv 没有回复".into()),
            Err(message) => Err(message),
        }
    }

    pub fn state(&self, id: &str) -> Option<SessionState> {
        self.get(id).map(|session| session.snapshot())
    }
}

#[derive(Debug)]
pub enum FeedError {
    NotFound,
    Closed,
}

fn last_line(text: &str) -> String {
    text.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("").trim().to_string()
}

/// mpv 0.39 起 `--config` 只是开关，配置文件由 `--config-dir` 指定：
/// 传进来的可以是一个目录，也可以是其中 mpv.conf 的路径。
fn config_dir_of(path: &str) -> Option<PathBuf> {
    let candidate = Path::new(path);
    if candidate.is_file() {
        return candidate.parent().map(Path::to_path_buf);
    }
    candidate.is_dir().then(|| candidate.to_path_buf())
}

fn build_args(settings: &PlaySettings) -> Result<Vec<String>, String> {
    // 各项设置各自产生参数、全部拼接起来：不因为某一项而丢弃另一项
    let mut args = Vec::new();
    let mut extra = Vec::new();

    if let Some(config_path) = settings.config_file.as_deref().map(str::trim).filter(|path| !path.is_empty()) {
        if config_path.len() > 500 || config_path.chars().any(|ch| ch.is_control()) {
            return Err("mpv 配置路径不合法".into());
        }
        let dir = config_dir_of(config_path)
            .ok_or_else(|| format!("mpv 配置路径不存在：{config_path}"))?;
        args.push(format!("--config-dir={}", dir.display()));
    }

    #[cfg(windows)]
    args.push("--ao=wasapi".to_string());
    args.push(format!("--audio-exclusive={}", if settings.exclusive { "yes" } else { "no" }));
    if settings.exclusive {
        // 独占模式下不要自动重采样，交给 mpv 按设备能力选择
        args.push("--audio-samplerate=0".to_string());
    }
    args.push(format!("--cache-secs={}", settings.cache_seconds.clamp(1, 600)));
    args.push("--demuxer-max-bytes=512MiB".to_string());

    // 页面给的列表优先于设置里的写法；只是「附加」，不替换上面这些
    let raw_extra = if settings.args.is_empty() {
        crate::args::split_args(&settings.extra_args)
    } else {
        settings.args.clone()
    };
    for arg in raw_extra {
        let trimmed = arg.trim();
        if trimmed.is_empty() {
            continue;
        }
        validate_arg(trimmed)?;
        extra.push(trimmed.to_string());
    }
    args.extend(extra);

    // 设备选择放最后：命令行里后出现的选项生效，所以 UI 里选的设备始终压过配置文件
    // 或额外参数里的 `--audio-device`
    if !settings.device.trim().is_empty() {
        args.push(format!("--audio-device={}", settings.device.trim()));
    }
    Ok(args)
}

/// 用户参数只允许是选项，且挡住能让 mpv 执行代码的几类
fn validate_arg(arg: &str) -> Result<(), String> {
    if arg.len() > 500 || arg.contains('\0') || arg.contains(['\n', '\r']) {
        return Err("mpv 参数不合法".into());
    }
    if !arg.starts_with('-') {
        return Err(format!("mpv 参数必须是选项（以 - 开头）：{arg}"));
    }
    let lower = arg.to_ascii_lowercase();
    if BLOCKED_ARGS.iter().any(|blocked| lower.starts_with(blocked)) {
        return Err(format!("不允许使用这个 mpv 参数：{arg}"));
    }
    Ok(())
}

/// 显示给界面的路径：Windows 上统一用反斜杠，避免出现 `C:/dir\file.exe` 这种混写
fn display_path(path: &Path) -> String {
    let text = path.display().to_string();
    if cfg!(windows) {
        text.replace('/', "\\")
    } else {
        text
    }
}

/// 配置路径 → 环境变量 → 程序目录 → PATH → 常见安装位置
pub fn resolve_mpv(configured: Option<&str>) -> Option<PathBuf> {
    let name = "mpv.exe";
    if let Some(path) = configured.map(str::trim).filter(|path| !path.is_empty()) {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Some(candidate);
        }
        // 允许写目录
        let inside = candidate.join(name);
        if inside.is_file() {
            return Some(inside);
        }
    }
    if let Some(path) = std::env::var_os("AM_HOOK_GUI_MPV") {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
            let candidate = dir.join("mpv").join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        let found = std::env::split_paths(&path).map(|dir| dir.join(name)).find(|candidate| candidate.is_file());
        if found.is_some() {
            return found;
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let profile = PathBuf::from(profile);
        candidates.push(profile.join("scoop").join("apps").join("mpv").join("current").join(name));
        candidates.push(profile.join("AppData").join("Local").join("Programs").join("mpv").join(name));
    }
    if let Some(programs) = std::env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(programs).join("mpv").join(name));
    }
    // 官方压缩包常见的解压位置
    for dir in [r"C:\mpv", r"C:\Tools\mpv"] {
        candidates.push(Path::new(dir).join(name));
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn probe_version(exe: &Path) -> Option<String> {
    let mut command = std::process::Command::new(exe);
    command.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let first = text.lines().next()?.trim();
    // "mpv v0.41.0-UNKNOWN Copyright ..." → "mpv v0.41.0-UNKNOWN"
    let mut parts = first.split_whitespace();
    let name = parts.next().unwrap_or("mpv");
    let version = parts.next().unwrap_or("");
    Some(if version.is_empty() { name.to_string() } else { format!("{name} {version}") })
}

async fn enumerate_devices(exe: &Path) -> Result<Vec<Device>, String> {
    let id = format!("dev{:x}{:x}", std::process::id(), Instant::now().elapsed().subsec_nanos());
    let pipe = pipe_name(&id);
    let mut command = tokio::process::Command::new(exe);
    command
        .arg("--no-config")
        .arg("--no-video")
        .arg("--force-window=no")
        .arg("--terminal=no")
        .arg("--idle=yes")
        .arg("--ao=wasapi")
        .arg(format!("--input-ipc-server={pipe}"));
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|error| format!("无法启动 {}: {error}", exe.display()))?;
    // 设备枚举用的临时 mpv 也放进作业对象：GUI 退出时不会留下孤儿进程
    if let Some(pid) = child.id() {
        job::assign(pid);
    }
    let result = async {
        ipc(&pipe, &[vec![json!("get_property"), json!("audio-device-list")]], Duration::from_secs(8)).await
    }
    .await;
    let _ = ipc(&pipe, &[vec![json!("quit")]], Duration::from_millis(400)).await;
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    #[cfg(unix)]
    let _ = std::fs::remove_file(&pipe);

    let replies = result?;
    let mut devices = Vec::new();
    if let Some(Value::Array(list)) = replies.first().and_then(|reply| data_of(reply).ok()) {
        for entry in list {
            let id = entry.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            if id.is_empty() {
                continue;
            }
            devices.push(Device {
                id,
                name: entry.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
                description: entry.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
            });
        }
    }
    Ok(devices)
}

/// 把 mpv 放进一个 `KILL_ON_JOB_CLOSE` 的作业对象：GUI 进程无论怎么死（包括任务管理器强杀），
/// 作业句柄随进程关闭时 Windows 会立刻结束里面的 mpv，不会继续把缓冲里的音频放完。
#[cfg(windows)]
mod job {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    type Handle = *mut c_void;

    const PROCESS_SET_QUOTA: u32 = 0x0100;
    const PROCESS_TERMINATE: u32 = 0x0001;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct BasicLimit {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        _padding: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        _padding2: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct IoCounters {
        read_operations: u64,
        write_operations: u64,
        other_operations: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct ExtendedLimit {
        basic: BasicLimit,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *mut c_void, length: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
    }

    fn job_handle() -> Option<Handle> {
        static JOB: OnceLock<usize> = OnceLock::new();
        let stored = *JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                tracing::warn!("CreateJobObject failed: {}", std::io::Error::last_os_error());
                return 0;
            }
            let mut info = ExtendedLimit {
                basic: BasicLimit {
                    per_process_user_time_limit: 0,
                    per_job_user_time_limit: 0,
                    limit_flags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                    _padding: 0,
                    minimum_working_set_size: 0,
                    maximum_working_set_size: 0,
                    active_process_limit: 0,
                    _padding2: 0,
                    affinity: 0,
                    priority_class: 0,
                    scheduling_class: 0,
                },
                io: IoCounters {
                    read_operations: 0,
                    write_operations: 0,
                    other_operations: 0,
                    read_bytes: 0,
                    write_bytes: 0,
                    other_bytes: 0,
                },
                process_memory_limit: 0,
                job_memory_limit: 0,
                peak_process_memory_used: 0,
                peak_job_memory_used: 0,
            };
            let ok = SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                &mut info as *mut ExtendedLimit as *mut c_void,
                std::mem::size_of::<ExtendedLimit>() as u32,
            );
            if ok == 0 {
                tracing::warn!("SetInformationJobObject failed: {}", std::io::Error::last_os_error());
            }
            job as usize
        });
        (stored != 0).then_some(stored as Handle)
    }

    /// 把刚启动的进程加入作业对象
    pub fn assign(pid: u32) {
        let Some(job) = job_handle() else { return };
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                tracing::warn!("OpenProcess({pid}) failed: {}", std::io::Error::last_os_error());
                return;
            }
            if AssignProcessToJobObject(job, process) == 0 {
                tracing::warn!(
                    "AssignProcessToJobObject({pid}) failed: {}",
                    std::io::Error::last_os_error()
                );
            }
            CloseHandle(process);
        }
    }
}

#[cfg(not(windows))]
mod job {
    pub fn assign(_pid: u32) {}
}

#[cfg(windows)]
fn pipe_name(id: &str) -> String {
    format!(r"\\.\pipe\am-hook-gui-{id}")
}

#[cfg(unix)]
fn pipe_name(id: &str) -> String {
    std::env::temp_dir().join(format!("am-hook-gui-{id}.sock")).to_string_lossy().into_owned()
}

/* ---------- JSON IPC ---------- */

trait PipeStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> PipeStream for T {}

#[cfg(windows)]
async fn connect_once(path: &str) -> std::io::Result<Box<dyn PipeStream>> {
    tokio::net::windows::named_pipe::ClientOptions::new().open(path).map(|pipe| Box::new(pipe) as Box<dyn PipeStream>)
}

#[cfg(unix)]
async fn connect_once(path: &str) -> std::io::Result<Box<dyn PipeStream>> {
    tokio::net::UnixStream::connect(path).await.map(|pipe| Box::new(pipe) as Box<dyn PipeStream>)
}

/// mpv 的 IPC 允许多个客户端：每条命令单开一条连接，读齐对应 `request_id` 的回复即关
async fn ipc(pipe: &str, commands: &[Vec<Value>], timeout: Duration) -> Result<Vec<Value>, String> {
    match tokio::time::timeout(timeout, exchange(pipe, commands)).await {
        Ok(result) => result,
        Err(_) => Err("mpv IPC 超时".into()),
    }
}

async fn exchange(pipe: &str, commands: &[Vec<Value>]) -> Result<Vec<Value>, String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut client = loop {
        match connect_once(pipe).await {
            Ok(client) => break client,
            Err(error) => {
                if Instant::now() >= deadline {
                    return Err(format!("无法连接 mpv IPC: {error}"));
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    };

    let mut payload = String::new();
    for (index, command) in commands.iter().enumerate() {
        let request = json!({ "command": command, "request_id": index + 1 });
        payload.push_str(&request.to_string());
        payload.push('\n');
    }
    client.write_all(payload.as_bytes()).await.map_err(|error| format!("写入 mpv IPC 失败: {error}"))?;
    client.flush().await.ok();

    let mut reader = BufReader::new(client);
    let mut replies: Vec<Option<Value>> = vec![None; commands.len()];
    let mut remaining = commands.len();
    let mut line = String::new();
    while remaining > 0 {
        line.clear();
        let read = reader.read_line(&mut line).await.map_err(|error| format!("读取 mpv IPC 失败: {error}"))?;
        if read == 0 {
            return Err("mpv IPC 连接意外关闭".into());
        }
        let Ok(message) = serde_json::from_str::<Value>(line.trim()) else { continue };
        let Some(id) = message.get("request_id").and_then(Value::as_u64) else { continue };
        let index = id as usize;
        if index >= 1 && index <= replies.len() && replies[index - 1].is_none() {
            replies[index - 1] = Some(message);
            remaining -= 1;
        }
    }
    Ok(replies.into_iter().flatten().collect())
}

/// 取 IPC 回复里的 `data`；命令失败时返回错误文字
fn data_of(reply: &Value) -> Result<Value, String> {
    match reply.get("error").and_then(Value::as_str) {
        Some("success") | None => Ok(reply.get("data").cloned().unwrap_or(Value::Null)),
        Some(other) => Err(other.to_string()),
    }
}

/// 供测试与单元测试使用：把设置拆成 mpv 参数
pub fn args_for(settings: &PlaySettings) -> Result<Vec<String>, String> {
    build_args(settings)
}

/// 事件总线类型别名（`events.rs` 里定义）
pub type Events = broadcast::Sender<BridgeEvent>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_dangerous_args() {
        assert!(validate_arg("--ad-joc-binaural=yes").is_ok());
        assert!(validate_arg("--audio-exclusive=yes").is_ok());
        for bad in ["video.mkv", "--script=evil.lua", "--input-conf=x.conf", "--include=x.conf"] {
            assert!(validate_arg(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn builds_default_args() {
        let settings = PlaySettings { exclusive: true, cache_seconds: 15, ..PlaySettings::default() };
        let args = args_for(&settings).unwrap();
        assert!(args.iter().any(|arg| arg == "--audio-exclusive=yes"));
        assert!(args.iter().any(|arg| arg == "--cache-secs=15"));
    }

    #[test]
    fn extra_args_are_appended_not_replacing() {
        let settings = PlaySettings {
            exclusive: true,
            device: "wasapi/{test}".to_string(),
            args: vec!["--ao=null".to_string(), "--ad-joc-binaural=yes".to_string()],
            ..PlaySettings::default()
        };
        let args = args_for(&settings).unwrap();
        // 独占参数与用户参数同时存在（不再因为用户写了 --ao 就丢掉独占）
        assert!(args.iter().any(|arg| arg == "--audio-exclusive=yes"));
        assert!(args.iter().any(|arg| arg == "--ao=null"));
        assert!(args.iter().any(|arg| arg == "--ad-joc-binaural=yes"));
        // 设备参数始终在最后，压过额外参数里的同名项
        assert_eq!(args.last().map(String::as_str), Some("--audio-device=wasapi/{test}"));
    }

    #[test]
    fn resolves_configured_dir() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-tmp/mpv");
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("mpv.exe");
        std::fs::write(&exe, b"stub").unwrap();
        assert_eq!(resolve_mpv(Some(dir.to_str().unwrap())), Some(exe.clone()));
        std::fs::remove_dir_all(&dir).ok();
    }
}
