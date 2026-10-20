// ALAC 检测（专辑页「检测 ALAC」，见 views/alac-check-dialog.mjs）：不请求 /key，只从 Apple CDN 读取很少的字节。
//
// 背景（AppleMusicDecrypt#136）：Apple 打包 ALAC 时输出缓冲区只有一帧原始 PCM 那么大
// （frameLength × 声道 × 位深 / 8），原样帧（escape，不压缩）比它多 4 字节；这 4 字节在缓冲区释放后才被复制，
// 内容是堆管理数据而不是音频。于是原样帧末尾的 END 标记（111）与最后一个样本的低位都可能是垃圾：
//   - END 标记不是 111：FFmpeg 等解码器丢弃该帧或报错（缺 END 标记）；
//   - 恰好是 111 但其后的填充位不全为零：解码不报错，但最后一个样本已损坏（隐藏缺陷）。
// 检测方法：
//   1. 每个分段只下载开头的 moof，由 tfhd / trun 得到每个 sample 的偏移、长度与时间；
//   2. 长度超过一帧 PCM 的 sample 就是受影响的帧；cbcs 只加密整 16 字节块，原样帧（16388 / 24580 字节）
//      末尾不足一块的 4 字节是明文，只下载这 4 字节，检查 PCM 之后的位是否恰为 111 加零填充；
//   3. init 段：mvhd 的创建时间即打包（编码）日期，udta/swre 为打包软件版本，ALAC magic cookie 给出帧长、位深与采样率；
//   4. 可选：第一个分段（约 15 秒）使用固定密钥，在浏览器内解密（decrypt.js，同样不请求 /key）后解码，
//      分析实际位深（低位是否全为零）与频宽（是否由低采样率升频），见 crates/am-flac-wasm/src/analysis.rs。

/** 每条轨道第一个分段使用的 FairPlay 固定密钥（与 decrypt.js 相同） */
const FIXED_KEY_URI = 'skd://itunes.apple.com/P000000000/s1/e1';
/** mvhd 时间的起点：1904-01-01 UTC */
const MAC_EPOCH = Date.UTC(1904, 0, 1);
/** 估计 moof 大小：每个 sample 在 trun（4 字节）与 senc（8 字节）中各占一项，再留出余量 */
const MOOF_BYTES_PER_SAMPLE = 16;
const MOOF_SLACK = 1024;

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** pos 处的 box；数据不足以读出头部时为 null（box 本身可能只下载了一部分） */
function boxAt(bytes, pos) {
  if (pos + 8 > bytes.length) return null;
  const v = view(bytes);
  const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
  let size = v.getUint32(pos);
  let header = 8;
  if (size === 1) {
    if (pos + 16 > bytes.length) return null;
    size = Number(v.getBigUint64(pos + 8));
    header = 16;
  } else if (size === 0) {
    size = bytes.length - pos;
  }
  if (size < header) throw new Error(`Invalid MP4 ${type} box`);
  return { type, start: pos, body: pos + header, end: pos + size };
}

function children(bytes, parent, skip = 0) {
  const list = [];
  for (let pos = parent.body + skip; pos + 8 <= parent.end;) {
    const box = boxAt(bytes, pos);
    if (!box || box.end > parent.end) throw new Error('Truncated MP4 box');
    list.push(box);
    pos = box.end;
  }
  return list;
}

function find(bytes, parent, type, skip = 0) {
  const box = children(bytes, parent, skip).find((b) => b.type === type);
  if (!box) throw new Error(`Missing MP4 ${type} box`);
  return box;
}

const root = (bytes) => ({ body: 0, end: bytes.length });

/**
 * 未改写的 init segment：打包日期、打包软件、时间刻度与 ALAC magic cookie（ALACSpecificConfig）。
 * created 为 Date（没有时为 null），software 为 swre 中的字符串（没有时为 ''）。
 */
export function parseInit(bytes) {
  const v = view(bytes);
  const moov = find(bytes, root(bytes), 'moov');
  const mvhd = find(bytes, moov, 'mvhd');
  const seconds = bytes[mvhd.body] === 1 ? Number(v.getBigUint64(mvhd.body + 4)) : v.getUint32(mvhd.body + 4);
  let software = '';
  const udta = children(bytes, moov).find((b) => b.type === 'udta');
  const swre = udta && children(bytes, udta).find((b) => b.type === 'swre');
  // FullBox(4) + 语言(2) + 以 NUL 结尾的字符串
  if (swre && swre.body + 6 <= swre.end) {
    const text = bytes.subarray(swre.body + 6, swre.end);
    const end = text.indexOf(0);
    software = new TextDecoder().decode(end < 0 ? text : text.subarray(0, end)).trim();
  }
  const mdia = find(bytes, find(bytes, moov, 'trak'), 'mdia');
  const mdhd = find(bytes, mdia, 'mdhd');
  const timescale = v.getUint32(mdhd.body + (bytes[mdhd.body] === 1 ? 20 : 12));
  const stsd = find(bytes, find(bytes, find(bytes, mdia, 'minf'), 'stbl'), 'stsd');
  // 加密时 sample entry 是 enca（frma 为 alac），cookie 同样在 AudioSampleEntry 的 28 字节之后
  let cookie = null;
  for (const entry of children(bytes, stsd, 8)) {
    cookie = children(bytes, entry, 28).find((b) => b.type === 'alac');
    if (cookie) break;
  }
  if (!cookie || cookie.end - cookie.body !== 28) throw new Error('Missing ALAC magic cookie');
  const c = cookie.body + 4;
  return {
    created: seconds ? new Date(MAC_EPOCH + seconds * 1000) : null,
    software,
    timescale,
    frameLength: v.getUint32(c),
    bits: bytes[c + 5],
    channels: bytes[c + 9],
    maxFrameBytes: v.getUint32(c + 12),
    avgBitrate: v.getUint32(c + 16),
    rate: v.getUint32(c + 20),
  };
}

/**
 * 分段开头的 moof：{ samples: [{ offset, size, time }] }，offset 相对分段起点，time 为解码时间（时间刻度单位）。
 * 下载的字节不足以包含整个 moof 时返回 { needed }：需要的字节数。
 */
export function parseFragmentHead(bytes) {
  const moof = boxAt(bytes, 0);
  if (!moof) return { needed: 16 };
  if (moof.type !== 'moof') throw new Error('Segment does not start with moof');
  if (moof.end > bytes.length) return { needed: moof.end };
  const v = view(bytes);
  const traf = find(bytes, moof, 'traf');
  const boxes = children(bytes, traf);
  const tfhd = boxes.find((b) => b.type === 'tfhd');
  if (!tfhd) throw new Error('Missing MP4 tfhd box');
  const flags = v.getUint32(tfhd.body) & 0xffffff;
  if (flags & 0x01) throw new Error('tfhd base-data-offset is not supported');
  let pos = tfhd.body + 8;
  if (flags & 0x02) pos += 4;
  const defaultDuration = flags & 0x08 ? v.getUint32(pos) : 0;
  if (flags & 0x08) pos += 4;
  const defaultSize = flags & 0x10 ? v.getUint32(pos) : 0;
  const tfdt = boxes.find((b) => b.type === 'tfdt');
  let time = !tfdt ? 0 : bytes[tfdt.body] === 1 ? Number(v.getBigUint64(tfdt.body + 4)) : v.getUint32(tfdt.body + 4);
  const samples = [];
  let data = 0;
  for (const trun of boxes.filter((b) => b.type === 'trun')) {
    const runFlags = v.getUint32(trun.body) & 0xffffff;
    const count = v.getUint32(trun.body + 4);
    let p = trun.body + 8;
    if (runFlags & 0x01) { data = v.getInt32(p); p += 4; }
    if (runFlags & 0x04) p += 4;
    const fields = [0x100, 0x200, 0x400, 0x800].filter((f) => runFlags & f).length;
    if (p + count * fields * 4 > trun.end) throw new Error('Truncated trun');
    for (let i = 0; i < count; i++) {
      const duration = runFlags & 0x100 ? v.getUint32((p += 4) - 4) : defaultDuration;
      const size = runFlags & 0x200 ? v.getUint32((p += 4) - 4) : defaultSize;
      if (runFlags & 0x400) p += 4;
      if (runFlags & 0x800) p += 4;
      samples.push({ offset: data, size, time });
      data += size;
      time += duration;
    }
  }
  return { samples };
}

/**
 * 一帧的尺寸：pcmBytes 为 Apple 打包时的输出缓冲区大小（一帧原始 PCM），
 * escapeBytes 为完整原样帧的长度（23 位帧头 + PCM + 3 位 END 标记，按字节补齐）。
 */
export function frameLayout({ frameLength, channels, bits }) {
  const payloadBits = 23 + frameLength * channels * bits;
  return { pcmBytes: (frameLength * channels * bits) / 8, escapeBytes: Math.ceil((payloadBits + 3) / 8), payloadBits };
}

/**
 * 根据长度超过 pcmBytes 的 sample 的末尾 4 字节判断：
 *   ok      PCM 之后恰为 END 标记 111 加零填充
 *   noEnd   END 标记不是 111（解码器会丢弃该帧或报错）
 *   hidden  END 标记是 111 但填充不为零（解码不报错，最后一个样本已损坏）
 *   oversize 长度不是完整原样帧（压缩帧或末尾的短帧也超过了缓冲区），无法定位 END 标记
 */
export function classifyTail(tail, size, layout) {
  if (size !== layout.escapeBytes || tail.length !== 4) return 'oversize';
  const rest = size * 8 - layout.payloadBits;
  const after = view(tail).getUint32(0) & ((1 << rest) - 1);
  const tag = after >>> (rest - 3);
  const padding = after & ((1 << (rest - 3)) - 1);
  return tag !== 7 ? 'noEnd' : padding ? 'hidden' : 'ok';
}

/** master m3u8 变体（wrapper.js 的 parseSongMaster）中音质最高的 ALAC：采样率、位深、码率依次比较 */
export function pickAlac(variants) {
  const key = (v) => [v.sample_rate || 0, v.bit_depth || 0, v.bandwidth || 0];
  return variants.filter((v) => v.codecs === 'alac').sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  })[0] || null;
}

/**
 * 第一个分段的 FairPlay 密钥是否为固定密钥。只看 skd:// 的 EXT-X-KEY：较新的 media m3u8 在每个密钥周期同时列出
 * FairPlay、PlayReady 与 Widevine，decrypt.js 的 parseMediaPlaylist 此时取 Widevine，分段的 key 不再是 'fixed'。
 */
export function firstSegmentFixed(text) {
  let fairplay = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-KEY:')) {
      const uri = (/URI="([^"]+)"/.exec(line) || [])[1];
      if (/METHOD=NONE/.test(line)) fairplay = null;
      else if (uri && uri.startsWith('skd://')) fairplay = uri;
    } else if (line.startsWith('#EXTINF:')) {
      return fairplay === FIXED_KEY_URI;
    }
  }
  return false;
}

/** 最多同时运行 n 个任务的限流器：limit(fn) 返回 fn() 的结果 */
export function createLimiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

/**
 * 解码第一个分段并分析的 Worker（flac-transcode-worker.js 的 analyze，flac.wasm）。
 * analyze(init, frag) 的 init 为改写后的 init（enca → alac），frag 为解密后的分段，两者都会被转移给 Worker。
 */
export function createAnalyzer() {
  let worker = null;
  let seq = 0;
  const pending = new Map();
  const failAll = (error) => { for (const p of pending.values()) p.reject(error); pending.clear(); };
  return {
    analyze(init, frag) {
      if (!worker) {
        worker = new Worker('/assets/flac-transcode-worker.js');
        worker.onmessage = ({ data }) => {
          const p = pending.get(data.id);
          if (!p) return;
          pending.delete(data.id);
          if (data.ok) p.resolve(data.result); else p.reject(new Error(data.error));
        };
        worker.onerror = (e) => failAll(new Error(e.message || 'ALAC analysis worker failed'));
      }
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, op: 'analyze', init, frag }, [init, frag]);
      });
    },
    close() {
      if (worker) worker.terminate();
      worker = null;
      failAll(new DOMException('Analysis cancelled', 'AbortError'));
    },
  };
}

/**
 * 检测一首歌曲。master 为 amp-api extendedAssetUrls.enhancedHls（master m3u8）。
 * options：signal；limit（网络请求限流器）；analyzer（createAnalyzer() 的结果，没有时不分析第一个分段）；
 * analysisLimit（分析的限流器）；onProgress({ phase: 'scan' | 'analyze', done, total })。
 * 返回 { status: 'noAlac' } 或
 * { status: 'done', variant, info, layout, frames, duration, escapes: [{ frame, time, size, tail, verdict }], bytes, analysis, analysisError }，
 * time 为秒，tail 为末尾 4 字节的十六进制，analysis 为 flac.wasm 的报告（没有分析时为 null）。
 */
export async function checkTrack(master, { adamId, signal, limit = (fn) => fn(), analyzer = null, analysisLimit = (fn) => fn(), onProgress } = {}) {
  const { AmWrapper, AmDecrypt } = globalThis;
  let bytes = 0;
  const fetchBytes = (url, start, end) => limit(async () => {
    signal?.throwIfAborted();
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let buf = new Uint8Array(await res.arrayBuffer());
    // 上游忽略 Range 时自行截取
    if (res.status === 200 && buf.length > end - start + 1) buf = buf.slice(start, end + 1);
    bytes += buf.length;
    return buf;
  });
  const fetchText = (url) => limit(async () => {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    bytes += text.length;
    return { text, url: res.url || url };
  });

  const masterRes = await fetchText(master);
  const variant = pickAlac(AmWrapper.parseSongMaster(masterRes.text, masterRes.url));
  if (!variant) return { status: 'noAlac' };
  const media = await fetchText(variant.url);
  const playlist = AmDecrypt.parseMediaPlaylist(media.text, media.url, adamId);
  const info = parseInit(await fetchBytes(playlist.url, playlist.init.start, playlist.init.end));
  const layout = frameLayout(info);

  // 第一个分段使用固定密钥时，与扫描同时解密并分析。只解密这一段，按固定密钥（FairPlay）处理；
  // 构造 Track 而不用 Track.open：后者会预取轨道模板，即 /key
  const first = { ...playlist.segments[0], key: 'fixed' };
  const analysis = analyzer && firstSegmentFixed(media.text)
    ? analysisLimit(async () => {
      signal?.throwIfAborted();
      const track = new AmDecrypt.Track({ ...playlist, cenc: false, keyUri: null, segments: [first] });
      const frag = await track.load(first, signal);
      const init = await track.load(track.init, signal);
      bytes += first.end - first.start + 1;
      onProgress?.({ phase: 'analyze' });
      return analyzer.analyze(init, frag);
    })
    : null;
  // 不等待时也要处理拒绝，免得出现未处理的 Promise 拒绝
  analysis?.catch(() => {});

  let done = 0;
  const total = playlist.segments.length;
  onProgress?.({ phase: 'scan', done, total });
  const perSegment = await Promise.all(playlist.segments.map(async (segment) => {
    const length = segment.end - segment.start + 1;
    const estimate = MOOF_SLACK + Math.ceil((segment.duration * info.rate) / info.frameLength) * MOOF_BYTES_PER_SAMPLE;
    let head = await fetchBytes(playlist.url, segment.start, segment.start + Math.min(length, estimate) - 1);
    let parsed = parseFragmentHead(head);
    if (parsed.needed) {
      head = await fetchBytes(playlist.url, segment.start, segment.start + Math.min(length, parsed.needed) - 1);
      parsed = parseFragmentHead(head);
      if (parsed.needed) throw new Error('Truncated moof');
    }
    const escapes = await Promise.all(parsed.samples.map((sample, index) => ({ ...sample, index }))
      .filter((sample) => sample.size > layout.pcmBytes)
      .map(async (sample) => {
        const end = segment.start + sample.offset + sample.size - 1;
        const tail = await fetchBytes(playlist.url, end - 3, end);
        return { ...sample, tail };
      }));
    onProgress?.({ phase: 'scan', done: ++done, total });
    return { count: parsed.samples.length, escapes };
  }));

  const escapes = [];
  let frames = 0;
  for (const segment of perSegment) {
    for (const e of segment.escapes) {
      escapes.push({
        frame: frames + e.index,
        time: e.time / info.timescale,
        size: e.size,
        tail: [...e.tail].map((b) => b.toString(16).padStart(2, '0')).join(' '),
        verdict: classifyTail(e.tail, e.size, layout),
      });
    }
    frames += segment.count;
  }

  let report = null;
  let analysisError = null;
  if (analysis) {
    try {
      report = await analysis;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      analysisError = error.message || String(error);
    }
  }
  return { status: 'done', variant, info, layout, frames, duration: playlist.duration, escapes, bytes, analysis: report, analysisError };
}

/**
 * 分析报告的结论：
 *   bits    { effective, padded }：padded 为容器位深大于实际使用的位数（低位全为零）
 *   band    'full'（频谱延伸到奈奎斯特频率附近）| 'upsampled'（source 为疑似的原采样率）| 'hires'（含 24 kHz 以上的内容）
 *           | 'cutoff'（44.1 / 48 kHz 在 19.5 kHz 以下陡峭截止）| 'low'（高频能量较少，无法判断）| 'quiet'（信号太弱或静音）
 * 只有陡降（wallDb）明显时才下结论：自然衰减的高频不能说明来源。高采样率母带常在 40 kHz 以上有抗混叠滤波的陡降，
 * 44.1 kHz 母带也常在 20 kHz 左右低通，都不算问题。
 */
export function interpretAnalysis(report) {
  const nyquist = report.rate / 2;
  const bits = { effective: report.effectiveBits, padded: report.effectiveBits != null && report.effectiveBits < report.bits };
  // 静音或极弱的信号（例如开头 15 秒是淡入）不足以判断频宽
  if (report.effectiveBits == null || report.peakDb == null || report.peakDb < -50 || !report.spectrum.length) return { bits, band: 'quiet' };
  const limit = report.bandLimit;
  const wall = report.wallDb >= 25;
  if (limit >= nyquist * 0.95) return { bits, band: 'full' };
  if (report.rate > 48000) {
    if (wall && limit <= 24500) return { bits, band: 'upsampled', source: limit <= 22600 ? 44100 : 48000 };
    if (wall && report.rate >= 176400 && limit <= 48500) return { bits, band: 'upsampled', source: limit <= 44600 ? 88200 : 96000 };
    return { bits, band: limit > 24500 ? 'hires' : 'low' };
  }
  return { bits, band: wall && limit <= 19500 ? 'cutoff' : 'low' };
}
