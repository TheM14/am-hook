//! 日志：同时写到 stderr、`<数据目录>/gui.log` 和内存环形缓冲（设置窗口里能看到最后 300 行）。

use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use tracing_subscriber::fmt::MakeWriter;

const CAPACITY: usize = 300;

static LINES: OnceLock<Arc<Mutex<VecDeque<String>>>> = OnceLock::new();

#[derive(Clone)]
struct Sink {
    lines: Arc<Mutex<VecDeque<String>>>,
    path: Option<PathBuf>,
}

impl Write for Sink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let text = String::from_utf8_lossy(buf).trim_end().to_string();
        if !text.is_empty() {
            if let Ok(mut lines) = self.lines.lock() {
                for line in text.lines() {
                    if lines.len() >= CAPACITY {
                        lines.pop_front();
                    }
                    lines.push_back(line.to_string());
                }
            }
            if let Some(path) = &self.path {
                if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
                    let _ = writeln!(file, "{text}");
                }
            }
            // 调试版本也打到 stderr（发布版本窗口程序没有控制台，写失败无所谓）
            let _ = writeln!(std::io::stderr(), "{text}");
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(Clone)]
struct SinkFactory {
    sink: Sink,
}

impl<'a> MakeWriter<'a> for SinkFactory {
    type Writer = Sink;

    fn make_writer(&'a self) -> Self::Writer {
        self.sink.clone()
    }
}

/// 初始化日志；`data_dir` 用于落盘（失败时只写内存与 stderr）
pub fn init(data_dir: Option<PathBuf>) {
    let lines = LINES.get_or_init(|| Arc::new(Mutex::new(VecDeque::with_capacity(CAPACITY)))).clone();
    let path = data_dir.and_then(|dir| {
        if let Err(error) = fs::create_dir_all(&dir) {
            eprintln!("cannot create {}: {error}", dir.display());
            return None;
        }
        let path = dir.join("gui.log");
        // 简单轮转：超过 2 MB 时留一份 .1
        if fs::metadata(&path).map(|meta| meta.len() > 2 * 1024 * 1024).unwrap_or(false) {
            let _ = fs::rename(&path, dir.join("gui.log.1"));
        }
        Some(path)
    });
    let factory = SinkFactory { sink: Sink { lines, path } };
    let filter = tracing_subscriber::EnvFilter::try_from_env("AM_HOOK_GUI_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,am_hook_gui=debug"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(factory)
        .with_target(false)
        .with_ansi(false)
        .try_init();
}

/// 最后 `count` 行日志（设置窗口的诊断区）
pub fn tail(count: usize) -> String {
    let Some(lines) = LINES.get() else { return String::new() };
    let Ok(lines) = lines.lock() else { return String::new() };
    let skip = lines.len().saturating_sub(count);
    lines.iter().skip(skip).cloned().collect::<Vec<_>>().join("\n")
}
