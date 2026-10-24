// 对象重建与双耳渲染的状态是定长数组（各约 1 MB），构造时会经过栈；wasm 默认 1 MB 的栈不够。
// 只给这个 crate 的 wasm 产物加大栈，不影响工作区里其他 wasm（hook.wasm、media.wasm 等）。
fn main() {
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        println!("cargo:rustc-link-arg=-zstack-size=8388608");
    }
}
