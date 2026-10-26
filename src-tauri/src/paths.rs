//! 数据目录：配置、日志、WebView2 的用户数据都放在这里。
//!
//! 默认是 `%APPDATA%\moe.amhook.gui`。exe 旁边有 `portable.txt` 时数据写到 `exe\data`；
//! `AM_HOOK_GUI_DATA_DIR` 可以直接指定目录。每个候选目录都会先做一次写入测试，不可写就换下一个：
//! 某些机器上的受控文件夹访问策略会拦下未签名程序对用户目录的写入。

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// 写入测试：在目录里建一个临时文件再删掉。失败时把原因带回来，方便排查
fn writable(dir: &PathBuf) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| format!("create_dir_all: {error}"))?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_nanos()).unwrap_or(0);
    let probe = dir.join(format!(".write-test-{stamp}"));
    match fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            Ok(())
        }
        Err(error) => Err(format!("write: {error}")),
    }
}

/// 解析数据目录；`preferred` 来自 Tauri 的 app config dir。
///
/// 顺序：`AM_HOOK_GUI_DATA_DIR` → exe 旁的 `portable.txt` → `%APPDATA%\<id>` →
/// `%LOCALAPPDATA%\<id>` → 程序目录/data → 临时目录。返回选中的目录，以及每个候选的尝试结果：
/// 日志要等 logger 初始化之后才能写，所以这里先把结果攒起来，交给调用方打印。
pub fn resolve_with_report(preferred: Option<PathBuf>, exe_dir: Option<PathBuf>) -> (PathBuf, Vec<String>) {
    let mut candidates: Vec<(String, PathBuf)> = Vec::new();
    if let Some(explicit) = std::env::var_os("AM_HOOK_GUI_DATA_DIR") {
        candidates.push(("AM_HOOK_GUI_DATA_DIR".into(), PathBuf::from(explicit)));
    }
    // 便携模式：exe 旁边放一个 portable.txt，数据就写在 exe\data（免安装、不碰用户目录）
    if let Some(dir) = &exe_dir {
        if dir.join("portable.txt").exists() {
            candidates.push(("portable marker".into(), dir.join("data")));
        }
    }
    if let Some(preferred) = preferred {
        candidates.push(("app config dir".into(), preferred));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(("LOCALAPPDATA".into(), PathBuf::from(local).join("moe.amhook.gui")));
    }
    if let Some(exe_dir) = exe_dir {
        candidates.push(("exe dir".into(), exe_dir.join("data")));
    }
    candidates.push(("temp".into(), std::env::temp_dir().join("am-hook-gui")));

    let mut report = Vec::new();
    for (label, candidate) in &candidates {
        match writable(candidate) {
            Ok(()) => {
                report.push(format!("[{label}] {}: ok", candidate.display()));
                return (candidate.clone(), report);
            }
            Err(reason) => report.push(format!("[{label}] {}: {reason}", candidate.display())),
        }
    }
    let fallback = std::env::temp_dir().join("am-hook-gui");
    (fallback, report)
}

/// WebView2 的用户数据目录。
///
/// 页面自己的设置（音质、语言、搜索历史、登录态等）都是 WebView2 的 profile 里的
/// localStorage / IndexedDB，跟着这个目录走。放在 `%LOCALAPPDATA%` 下而不是配置目录里：
/// 换 exe 位置、便携模式、清空配置目录都不会把这些页面设置一起带走。
pub fn webview_dir(data_dir: &std::path::Path) -> PathBuf {
    if let Some(explicit) = std::env::var_os("AM_HOOK_GUI_WEBVIEW_DIR") {
        return PathBuf::from(explicit);
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let candidate = PathBuf::from(local).join("moe.amhook.gui").join("webview2");
        if writable(&candidate).is_ok() {
            return candidate;
        }
    }
    data_dir.join("webview2")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webview_dir_can_be_overridden() {
        let custom = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("profile-test");
        std::env::set_var("AM_HOOK_GUI_WEBVIEW_DIR", &custom);
        let dir = webview_dir(&PathBuf::from("data"));
        std::env::remove_var("AM_HOOK_GUI_WEBVIEW_DIR");
        assert_eq!(dir, custom);
    }

    #[test]
    fn skips_unwritable_candidate() {
        // 用一个普通文件当父目录，create_dir_all 必然失败，模拟“首选目录不可写”
        let blocker = std::env::temp_dir().join(format!("am-hook-gui-blocker-{}", std::process::id()));
        std::fs::write(&blocker, b"x").unwrap();
        let bad = blocker.join("data");
        let (resolved, report) = resolve_with_report(Some(bad.clone()), None);
        std::fs::remove_file(&blocker).ok();
        assert_ne!(resolved, bad);
        assert!(report.first().map(|line| line.contains("app config dir") && !line.ends_with("ok")).unwrap_or(false));
    }
}
