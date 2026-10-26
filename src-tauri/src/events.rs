//! bridge 的事件总线：页面通过 SSE 订阅 mpv 状态、配置变化与服务器切换。
//!
//! 用事件而不是轮询，一是页面在后台被 WebView 降频时仍能收到定时器之外的通知，
//! 二是切歌、播放结束这类状态变化不必等页面下一次定时查询。

use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;

use crate::mpv::SessionState;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BridgeEvent {
    /// mpv 会话状态（位置、时长、暂停、音量、音频参数…）
    MpvState { session: String, state: SessionState },
    /// mpv 播放到结尾并正常退出
    MpvEnded { session: String },
    /// mpv 异常退出（例如设备被独占、参数错误）
    MpvError { session: String, message: String },
    /// GUI 设置变化（页面据此切换输出方式、音量、设备）
    Config { settings: Value },
    /// 连接的服务器变化（换服务器或断开）
    Server { url: Option<String> },
    /// 服务器探活结果：掉线时页面显示提示与「重试」
    ServerStatus { alive: bool, message: Option<String> },
}

pub type EventBus = broadcast::Sender<BridgeEvent>;

/// 事件总线；容量足够覆盖一次状态推送的积压，满了丢最旧的（页面只关心最新状态）
pub fn bus() -> EventBus {
    broadcast::channel(256).0
}

pub fn send(bus: &EventBus, event: BridgeEvent) {
    // 没有订阅者时 send 会失败，这不重要
    let _ = bus.send(event);
}
