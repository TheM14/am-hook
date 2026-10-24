// JOC 对象渲染的浏览器构建（src/ui/joc.wasm，crates/joc-wasm）：离线，只需 Node：
//   node --test tests/joc_wasm.mjs
// 用 crates/joc-core/tests/fixtures 的样本（真实 Atmos 码流的 EMDF 元数据 + 合成的 5.1 床）按 Worker 的方式逐帧送入，
// 输出须与原生参考实现逐位一致（与 crates/joc-core/tests/fixture.rs 相同的摘要），20 组 HRTF 都能加载；
// 另外报告两种模式的实时倍率（JOC_WASM 可指定其他 wasm，比较不同构建的速度）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const wasmPath = process.env.JOC_WASM || new URL('src/ui/joc.wasm', root);
const eac3 = readFileSync(new URL('crates/joc-core/tests/fixtures/joc_fixture.eac3', root));
const SPEAKER_SHA256 = '907b8cca070b5f4e4eb07d63d0a60803eb50e12b13a0012ee62403bef830c13a';
const BINAURAL_SHA256 = 'e07706caf58d6f25dc057ecfe6d4ce24b7bd94e27e9f4de409d12fc7fe869e1f';
const CHANNELS = 6;
const FRAME = 1536;

const frames = [];
for (let offset = 0; offset + 4 <= eac3.length;) {
  const size = ((((eac3[offset + 2] & 0x07) << 8) | eac3[offset + 3]) + 1) * 2;
  frames.push(eac3.subarray(offset, offset + size));
  offset += size;
}
const tones = [440, 554, 659, 880, 110, 55];
const bed = new Float32Array(frames.length * FRAME * CHANNELS);
for (let sample = 0; sample < frames.length * FRAME; sample++) {
  for (let channel = 0; channel < CHANNELS; channel++) {
    bed[sample * CHANNELS + channel] = 0.08 * Math.sin(2 * Math.PI * tones[channel] * (sample / 48000) + channel * 0.3);
  }
}

const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const ex = instance.exports;
const hrtf = (name) => readFileSync(new URL(`src/ui/joc-hrtf-${name}.jochrtf`, root));

function error() {
  return new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ex.joc_error_ptr(), ex.joc_error_len()));
}

function copyIn(bytes) {
  const ptr = ex.joc_alloc(bytes.byteLength);
  new Uint8Array(ex.memory.buffer, ptr, bytes.byteLength).set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return ptr;
}

/** 与 joc-decode-worker.js 相同的调用顺序：每帧 push_eac3、push_pcm、flush_pending，再 pull 干净 */
function render(mode, field, count = frames.length, repeat = 1) {
  let fieldPtr = 0;
  if (field) fieldPtr = copyIn(field);
  const handle = ex.joc_open(mode, 0, 1, 1473, 5.0, fieldPtr, field ? field.length : 0);
  if (fieldPtr) ex.joc_free(fieldPtr, field.length);
  assert.ok(handle, `joc_open: ${error()}`);
  const pcmPtr = ex.joc_alloc(FRAME * CHANNELS * 4);
  const outPtr = ex.joc_alloc(4096 * 2 * 4);
  const chunks = [];
  try {
    for (let pass = 0; pass < repeat; pass++) {
      if (pass) assert.equal(ex.joc_reset(handle), 0);
      for (let i = 0; i < count; i++) {
        const ptr = copyIn(frames[i]);
        assert.equal(ex.joc_push_eac3(handle, ptr, frames[i].length), 0, error());
        ex.joc_free(ptr, frames[i].length);
        new Float32Array(ex.memory.buffer, pcmPtr, FRAME * CHANNELS).set(bed.subarray(i * FRAME * CHANNELS, (i + 1) * FRAME * CHANNELS));
        assert.equal(ex.joc_push_pcm(handle, pcmPtr, FRAME, CHANNELS), 0, error());
        assert.equal(ex.joc_flush_pending(handle), 0, error());
        for (;;) {
          const produced = ex.joc_pull(handle, outPtr, 4096);
          assert.ok(produced >= 0, error());
          if (!produced) break;
          if (pass === repeat - 1) chunks.push(new Float32Array(ex.memory.buffer, outPtr, produced * 2).slice());
        }
      }
    }
  } finally {
    ex.joc_close(handle);
    ex.joc_free(pcmPtr, FRAME * CHANNELS * 4);
    ex.joc_free(outPtr, 4096 * 2 * 4);
  }
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

const sha256 = (samples) => createHash('sha256').update(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)).digest('hex');

test('Speaker 2.0 与原生参考实现逐位一致', () => {
  const out = render(0, null);
  assert.equal(out.length, frames.length * FRAME * 2);
  assert.equal(sha256(out), SPEAKER_SHA256);
});

test('Binaural（D2）与原生参考实现逐位一致，reset 后从干净的状态重新开始', () => {
  const out = render(1, hrtf('D2'), frames.length, 2);
  assert.equal(out.length, (frames.length * FRAME - 961) * 2);
  assert.equal(sha256(out), BINAURAL_SHA256);
});

test('20 组 HRTF 都能加载并渲染出声音', () => {
  const names = readdirSync(new URL('src/ui/', root)).filter((n) => /^joc-hrtf-.+\.jochrtf$/.test(n));
  assert.equal(names.length, 20);
  for (const name of names) {
    const out = render(1, readFileSync(new URL(`src/ui/${name}`, root)), 4);
    assert.ok(out.length > 0, name);
    assert.ok(out.some((v) => v !== 0) && out.every(Number.isFinite), name);
  }
});

test('无效的 HRTF 报错而不是崩溃', () => {
  const junk = new Uint8Array(1024).fill(7);
  const ptr = copyIn(junk);
  const handle = ex.joc_open(1, 0, 1, 1473, 5.0, ptr, junk.length);
  ex.joc_free(ptr, junk.length);
  assert.equal(handle, 0);
  assert.match(error(), /hrtf/i);
});

test('实时倍率', () => {
  const field = hrtf('D2');
  const seconds = (frames.length * FRAME) / 48000;
  const rates = {};
  for (const [name, mode, data] of [['speaker', 0, null], ['binaural', 1, field]]) {
    render(mode, data); // 预热
    const started = performance.now();
    render(mode, data, frames.length, 4);
    rates[name] = ((seconds * 4) / ((performance.now() - started) / 1000)).toFixed(1);
  }
  console.log(`joc.wasm 实时倍率：Speaker 2.0 ${rates.speaker}x，Binaural ${rates.binaural}x`);
  assert.ok(Number(rates.binaural) > 1, 'binaural rendering is slower than real time');
});
