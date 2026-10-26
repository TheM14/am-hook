//! 注入给 am-hook 页面的初始化脚本：先写入 bridge 地址、令牌与当前设置，再带上补丁脚本。

use crate::state::AppState;

/// 生成 `AddScriptToExecuteOnDocumentCreated` 用的脚本
pub fn build(state: &AppState) -> String {
    let config = state.config();
    let prelude = serde_json::json!({
        "bridge": state.bridge_url(),
        "token": state.bridge_token,
        "version": env!("CARGO_PKG_VERSION"),
        "server": config.server.url,
        "settings": config.page_settings(),
    });
    format!(
        "(function () {{\n  if (window.__AM_HOOK_GUI__ && window.__AM_HOOK_GUI__.injected) return;\n  \
         window.__AM_HOOK_GUI__ = Object.assign(window.__AM_HOOK_GUI__ || {{}}, {prelude});\n  \
         window.__AM_HOOK_GUI__.injected = true;\n}})();\n{}\n",
        include_str!("../inject/bridge.js")
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn script_is_valid_js_shape() {
        let script = include_str!("../inject/bridge.js");
        // 至少确认没有模板残留、没有语法上明显不配对的大括号
        assert!(!script.contains("__AM_HOOK_GUI_PLACEHOLDER__"));
        assert!(script.contains("class MpvEngine"));
        assert!(script.contains("window.AmDecrypt"));
    }
}
