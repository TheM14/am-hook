#!/usr/bin/env sh
# 构建浏览器端 wasm（随二进制内嵌发布）：
#   crates/am-wasm -> src/ui/hook.wasm（歌曲解密）
#   crates/am-flac-wasm -> src/ui/flac.wasm（ALAC 转 FLAC）
#   crates/am-media-wasm -> src/ui/media.wasm（MV 的 PlayReady / CENC / 合并，歌曲与 MV 的 defrag，AAC-LC 歌曲的 Widevine）
# 修改 crates/ 下任一相关 crate 后需重新运行并提交产物。
# 需要：rustup target add wasm32-unknown-unknown，以及 wasm-opt（binaryen）。WASM_OPT 可指定 wasm-opt 命令，
# 例如 WASM_OPT="npx -y -p binaryen@123.0.0 wasm-opt"；没有 wasm-opt 时产物明显更大，不要提交。
# hook.wasm 与 media.wasm 用 Cargo.toml 的 wasm profile（按体积优化，解密热点保持 opt-level 3）；
# flac.wasm 的转码在播放路径上，保持 release（opt-level 3）。
set -eu
cd "$(dirname "$0")/.."
WASM_OPT=${WASM_OPT:-wasm-opt}

cargo build -p am-wasm --profile wasm --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/wasm/am_wasm.wasm src/ui/hook.wasm
cargo build -p am-flac-wasm --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/am_flac_wasm.wasm src/ui/flac.wasm
cargo build -p am-media-wasm --profile wasm --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/wasm/am_media_wasm.wasm src/ui/media.wasm

if $WASM_OPT --version >/dev/null 2>&1; then
  $WASM_OPT -Oz --enable-bulk-memory src/ui/hook.wasm -o src/ui/hook.wasm
  $WASM_OPT -O3 --enable-bulk-memory src/ui/flac.wasm -o src/ui/flac.wasm
  $WASM_OPT -Oz --enable-bulk-memory src/ui/media.wasm -o src/ui/media.wasm
else
  echo "warning: wasm-opt not found (set WASM_OPT); the outputs are not optimized" >&2
fi

ls -l src/ui/hook.wasm
ls -l src/ui/flac.wasm
ls -l src/ui/media.wasm
