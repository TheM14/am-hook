// 专辑页「检测 ALAC」打开的对话框：逐首检测最高音质的 ALAC（方法见 ../alac-check.mjs），结果逐行显示，
// 单击一行展开详情（原样帧列表、打包信息、第一个分段的实际位深与频谱），可复制文字报告。关闭对话框即停止检测。
import { checkTrack, createAnalyzer, createLimiter, interpretAnalysis } from '../alac-check.mjs';

const { AmI18n } = window;
const { t } = AmI18n;

/** 是否同时分析第一个分段（需要多下载约 1.5–10 MB / 首），记住上次的选择 */
const ANALYZE_KEY = 'am-hook:alac-check-analyze';
const TRACKS_AT_ONCE = 3;
const REQUESTS_AT_ONCE = 8;
const ANALYSES_AT_ONCE = 2;
/** 有缺陷的原样帧 */
const DEFECTS = new Set(['noEnd', 'hidden', 'oversize']);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

const art = (artwork, size) => (artwork && artwork.url ? artwork.url.replace('{w}', size).replace('{h}', size).replace('{c}', 'bb').replace('{f}', 'jpg') : '');
const khz = (hz) => `${(hz / 1000).toFixed(1).replace(/\.0$/, '')} kHz`;
const format = (bits, rate) => (bits && rate ? `${bits}-bit / ${khz(rate)}` : '');

function clock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

function dateTime(date) {
  if (!date) return '';
  return new Intl.DateTimeFormat(AmI18n.lang === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function size(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 分析报告的文字结论：位深、频宽两项，warn 表示值得注意 */
function analysisLines(report) {
  const verdict = interpretAnalysis(report);
  const bits = verdict.bits.effective == null ? { text: t('ac.bitsSilent') }
    : verdict.bits.padded ? { text: t('ac.bitsPadded', { n: verdict.bits.effective, bits: report.bits, zero: report.bits - verdict.bits.effective }), warn: true }
      : { text: t('ac.bitsFull', { n: verdict.bits.effective }) };
  const limit = khz(report.bandLimit);
  const band = {
    full: { text: t('ac.bandFull', { limit }) },
    upsampled: { text: t('ac.bandUpsampled', { limit, source: khz(verdict.source), wall: Math.round(report.wallDb) }), warn: true },
    hires: { text: t('ac.bandHires', { limit }) },
    cutoff: { text: t('ac.bandCutoff', { limit, wall: Math.round(report.wallDb) }), warn: true },
    low: { text: t('ac.bandLow', { limit }) },
    quiet: { text: t('ac.bandQuiet') },
  }[verdict.band];
  return { bits, band, verdict };
}

/**
 * 频谱（0 Hz 到奈奎斯特频率，线性频率轴）：一条线，量化噪声底为水平虚线，频宽上限为竖直虚线；
 * 悬停显示频率与电平。绘图区按容器拉伸，文字用 HTML 定位，不随拉伸变形。
 */
function spectrumChart(report, warn) {
  const values = report.spectrum;
  const nyquist = report.rate / 2;
  const top = Math.ceil((Math.max(-20, ...values) + 5) / 10) * 10;
  const bottom = Math.floor((report.floorDb - 10) / 10) * 10;
  const x = (i) => (i / (values.length - 1)) * 1000;
  const y = (db) => ((top - Math.min(top, Math.max(bottom, db))) / (top - bottom)) * 100;
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(2)}`).join('');
  const svg = svgEl('svg', { viewBox: '0 0 1000 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  svg.append(
    svgEl('path', { class: 'ac-spec-area', d: `${line}L1000,100L0,100Z` }),
    svgEl('line', { class: 'ac-spec-floor', x1: 0, x2: 1000, y1: y(report.floorDb), y2: y(report.floorDb), 'vector-effect': 'non-scaling-stroke' }),
    svgEl('path', { class: 'ac-spec-line', d: line, 'vector-effect': 'non-scaling-stroke' }));
  const limitX = (report.bandLimit / nyquist) * 100;
  const showLimit = report.bandLimit > 0 && report.bandLimit < nyquist * 0.95;
  if (showLimit) {
    svg.append(svgEl('line', { class: `ac-spec-limit${warn ? ' is-warn' : ''}`, x1: limitX * 10, x2: limitX * 10, y1: 0, y2: 100, 'vector-effect': 'non-scaling-stroke' }));
  }
  const cursor = svgEl('line', { class: 'ac-spec-cursor', x1: 0, x2: 0, y1: 0, y2: 100, 'vector-effect': 'non-scaling-stroke', visibility: 'hidden' });
  svg.append(cursor);
  const tip = el('span', { className: 'ac-spec-tip', hidden: true });
  const plot = el('div', { className: 'ac-spec-plot' }, svg,
    el('span', { className: 'ac-spec-floor-label', textContent: t('ac.floor', { bits: report.bits }), style: `top:${y(report.floorDb)}%` }),
    showLimit ? el('span', { className: 'ac-spec-limit-label', textContent: khz(report.bandLimit), style: `left:${limitX}%` }) : null,
    tip);
  plot.addEventListener('pointermove', (e) => {
    const box = plot.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const i = Math.round(f * (values.length - 1));
    cursor.setAttribute('x1', x(i));
    cursor.setAttribute('x2', x(i));
    cursor.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.textContent = `${khz(Math.round((i / (values.length - 1)) * nyquist / 100) * 100)} · ${values[i] <= bottom ? `< ${bottom}` : values[i].toFixed(0)} dB`;
    tip.style.left = `${(i / (values.length - 1)) * 100}%`;
    tip.classList.toggle('is-right', f > 0.6);
  });
  plot.addEventListener('pointerleave', () => { cursor.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  const chart = el('div', { className: 'ac-spectrum' }, plot,
    el('div', { className: 'ac-spec-axis' }, el('span', { textContent: '0' }), el('span', { textContent: khz(nyquist / 2) }), el('span', { textContent: khz(nyquist) })));
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', t('ac.spectrumLabel', { limit: khz(report.bandLimit), nyquist: khz(nyquist) }));
  return chart;
}

/**
 * resource / tracks：专辑页已取到的 amp-api 资源与曲目；toast(message)：底部提示
 */
export function openAlacCheckDialog({ resource, tracks, toast }) {
  const a = resource.attributes || {};
  const items = tracks.filter((r) => r.type === 'songs' && r.attributes).map((track) => ({
    track,
    master: track.attributes.extendedAssetUrls && track.attributes.extendedAssetUrls.enhancedHls,
    state: 'waiting',
    progress: null,
    result: null,
    error: null,
    open: false,
  }));
  /** 当前这次检测的 AbortController；停止后旧检测里仍在进行的请求不再改动任何一行 */
  let controller = null;

  const dialog = el('dialog', { className: 'dl-dialog ac-dialog' });
  dialog.setAttribute('aria-labelledby', 'ac-dialog-title');

  let analyze = true;
  try { analyze = localStorage.getItem(ANALYZE_KEY) !== '0'; } catch {}
  const analyzeBox = el('input', { type: 'checkbox', checked: analyze });
  analyzeBox.addEventListener('change', () => {
    try { localStorage.setItem(ANALYZE_KEY, analyzeBox.checked ? '1' : '0'); } catch {}
  });

  const summary = el('span', { className: 'dl-dialog-count', role: 'status' });
  const list = el('ul', { className: 'dl-dialog-list ac-list' });
  const copy = el('button', { type: 'button', className: 'dl-dialog-cancel', textContent: t('ac.copy') });
  const run = el('button', { type: 'button', className: 'dl-dialog-start' });
  const close = el('button', { type: 'button', className: 'dl-dialog-cancel', textContent: t('ac.close') });

  function defects(item) {
    return item.result && item.result.escapes ? item.result.escapes.filter((e) => DEFECTS.has(e.verdict)) : [];
  }

  function status(item) {
    if (!item.master) return { text: t('ac.unavailable'), kind: 'muted' };
    if (item.state === 'waiting') return { text: controller ? t('ac.waiting') : '', kind: 'muted' };
    if (item.state === 'running') {
      const p = item.progress;
      return { text: p && p.phase === 'scan' && p.total ? t('ac.scanning', { done: p.done, total: p.total }) : t('ac.running'), kind: 'muted' };
    }
    if (item.state === 'error') return { text: t('ac.failed'), kind: 'bad', title: item.error };
    if (item.result.status === 'noAlac') return { text: t('ac.noAlac'), kind: 'muted' };
    const bad = defects(item).length;
    if (bad) return { text: t('ac.defects', { n: bad }), kind: 'bad' };
    return { text: item.result.escapes.length ? t('ac.escapesOk', { n: item.result.escapes.length }) : t('ac.clean'), kind: 'ok' };
  }

  /** 实际位深 / 频宽值得注意时，行内多显示一个标记 */
  function flags(item) {
    const report = item.result && item.result.analysis;
    if (!report) return [];
    const { bits, band, verdict } = analysisLines(report);
    const out = [];
    if (bits.warn) out.push(t('ac.flagBits', { n: verdict.bits.effective }));
    if (verdict.band === 'upsampled') out.push(t('ac.flagUpsampled'));
    else if (band.warn) out.push(t('ac.flagCutoff', { limit: khz(report.bandLimit) }));
    return out;
  }

  function detail(item) {
    const r = item.result;
    if (item.state === 'error') return el('p', { className: 'ac-error', textContent: item.error });
    if (!r || r.status !== 'done') return null;
    const info = r.info;
    const parts = [];
    parts.push(el('p', { className: 'ac-meta' },
      t('ac.packaged', { date: dateTime(info.created) || '—' }), info.software ? el('span', { className: 'ac-soft', textContent: ` · ${info.software}` }) : null));
    parts.push(el('p', { className: 'ac-meta', textContent: `${format(info.bits, info.rate)} · ${t('ac.stats', { frames: r.frames, escapes: r.escapes.length, size: size(r.bytes) })}` }));
    if (r.escapes.length) {
      parts.push(el('table', { className: 'ac-frames' },
        el('thead', {}, el('tr', {}, ...['ac.colFrame', 'ac.colTime', 'ac.colVerdict', 'ac.colTail'].map((key) => el('th', { textContent: t(key) })))),
        el('tbody', {}, ...r.escapes.map((e) => el('tr', { className: DEFECTS.has(e.verdict) ? 'is-bad' : '' },
          el('td', { textContent: `#${e.frame}` }),
          el('td', { textContent: clock(e.time) }),
          el('td', { textContent: t(`ac.verdict.${e.verdict}`), title: t(`ac.verdictHint.${e.verdict}`) }),
          el('td', { className: 'ac-hex', textContent: e.tail }))))));
    }
    if (r.analysis) {
      const { bits, band, verdict } = analysisLines(r.analysis);
      parts.push(el('div', { className: 'ac-analysis' },
        el('p', { className: 'ac-analysis-title', textContent: t('ac.analysisTitle', { seconds: Math.round(r.analysis.frames / r.analysis.rate) }) }),
        el('p', { className: bits.warn ? 'is-warn' : '', textContent: bits.text }),
        el('p', { className: band.warn ? 'is-warn' : '', textContent: band.text }),
        r.analysis.failedPackets ? el('p', { className: 'is-warn', textContent: t('ac.undecodable', { n: r.analysis.failedPackets }) }) : null,
        r.analysis.spectrum.length && verdict.band !== 'quiet' ? spectrumChart(r.analysis, band.warn) : null));
    } else if (r.analysisError) {
      parts.push(el('p', { className: 'ac-error', textContent: t('ac.analysisFailed', { msg: r.analysisError }) }));
    }
    return el('div', { className: 'ac-detail' }, ...parts);
  }

  const rows = new Map();
  function renderRow(item, index) {
    const ra = item.track.attributes;
    const s = status(item);
    const r = item.result && item.result.status === 'done' ? item.result : null;
    const expandable = !!r || item.state === 'error';
    const head = el('button', { type: 'button', className: 'ac-item', disabled: !expandable },
      el('span', { className: 'dl-dialog-num', textContent: String(ra.trackNumber || index + 1) }),
      el('span', { className: 'dl-dialog-name', textContent: ra.name || item.track.id }),
      ...flags(item).map((text) => el('span', { className: 'ac-flag', textContent: text })),
      el('span', { className: 'ac-format', textContent: r ? format(r.info.bits, r.info.rate) : '' }),
      el('span', { className: `ac-status is-${s.kind}`, textContent: s.text, title: s.title || '' }));
    head.setAttribute('aria-expanded', String(item.open && expandable));
    head.addEventListener('click', () => { item.open = !item.open; update(item); });
    const li = el('li', { className: 'ac-row' }, head, item.open && expandable ? detail(item) : null);
    return li;
  }

  function update(item) {
    const index = items.indexOf(item);
    const next = renderRow(item, index);
    const old = rows.get(item);
    if (old) old.replaceWith(next); else list.append(next);
    rows.set(item, next);
    sync();
  }

  function sync() {
    const checkable = items.filter((i) => i.master);
    const done = checkable.filter((i) => i.state === 'done' || i.state === 'error').length;
    const bad = checkable.filter((i) => defects(i).length);
    const frames = bad.reduce((n, i) => n + defects(i).length, 0);
    summary.textContent = !checkable.length ? t('ac.nothing')
      : [t('ac.progress', { done, total: checkable.length }), bad.length ? t('ac.summaryBad', { n: bad.length, frames }) : done === checkable.length ? t('ac.summaryOk') : ''].filter(Boolean).join(' · ');
    run.textContent = controller ? t('ac.stop') : done ? t('ac.rerun') : t('ac.start');
    run.disabled = !checkable.length;
    analyzeBox.disabled = !!controller;
    copy.disabled = !done;
  }

  async function start() {
    controller = new AbortController();
    const { signal } = controller;
    // 每次检测有自己的分析 Worker，停止时立即终止
    const analyzer = analyzeBox.checked ? createAnalyzer() : null;
    if (analyzer) signal.addEventListener('abort', () => analyzer.close(), { once: true });
    const limit = createLimiter(REQUESTS_AT_ONCE);
    const analysisLimit = createLimiter(ANALYSES_AT_ONCE);
    const trackLimit = createLimiter(TRACKS_AT_ONCE);
    for (const item of items) {
      Object.assign(item, { state: 'waiting', progress: null, result: null, error: null });
      update(item);
    }
    await Promise.all(items.filter((i) => i.master).map((item) => trackLimit(async () => {
      if (signal.aborted) return;
      item.state = 'running';
      update(item);
      try {
        const result = await checkTrack(item.master, {
          adamId: item.track.id, signal, limit, analyzer, analysisLimit,
          onProgress: (progress) => { if (!signal.aborted) { item.progress = progress; update(item); } },
        });
        if (signal.aborted) return;
        Object.assign(item, { result, state: 'done' });
      } catch (error) {
        if (signal.aborted) return;
        Object.assign(item, { state: 'error', error: error.message || String(error) });
      }
      update(item);
    })));
    if (signal.aborted) return;
    if (analyzer) analyzer.close();
    controller = null;
    items.forEach(update);
  }

  function stop() {
    if (!controller) return;
    controller.abort(new DOMException('ALAC check stopped', 'AbortError'));
    controller = null;
    for (const item of items) if (item.state === 'running') item.state = 'waiting';
    items.forEach(update);
  }

  /** 纯文字报告，便于贴到 issue 或聊天中 */
  function report() {
    const lines = [`${t('ac.title', { name: a.name || '' })}${a.artistName ? ` — ${a.artistName}` : ''}`];
    for (const item of items) {
      const ra = item.track.attributes;
      const r = item.result && item.result.status === 'done' ? item.result : null;
      const num = String(ra.trackNumber || '').padStart(2, '0');
      const head = `${discs.size > 1 ? `${ra.discNumber || 1}-` : ''}${num} ${ra.name}`;
      if (!r) { lines.push(`${head}: ${status(item).text || '—'}${item.error ? ` (${item.error})` : ''}`); continue; }
      lines.push(`${head}: ${format(r.info.bits, r.info.rate)} · ${t('ac.packaged', { date: dateTime(r.info.created) || '—' })} · ${status(item).text}`);
      for (const e of r.escapes) lines.push(`    #${e.frame} ${clock(e.time)} ${t(`ac.verdict.${e.verdict}`)} [${e.tail}]`);
      if (r.analysis) {
        const { bits, band } = analysisLines(r.analysis);
        lines.push(`    ${bits.text} · ${band.text}`);
      }
    }
    return lines.join('\n');
  }

  run.addEventListener('click', () => (controller ? stop() : start()));
  close.addEventListener('click', () => dialog.close());
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(report());
      toast(t('ac.copied'));
    } catch (error) {
      toast(error.message || String(error));
    }
  });

  // 多碟专辑与下载对话框一样按碟分组（各碟曲目编号从 1 开始）
  const discs = new Set(items.map((i) => i.track.attributes.discNumber || 1));
  let lastDisc = null;
  for (const item of items) {
    const disc = item.track.attributes.discNumber || 1;
    if (discs.size > 1 && disc !== lastDisc) list.append(el('li', { className: 'dl-dialog-disc', textContent: t('album.disc', { n: disc }) }));
    lastDisc = disc;
    update(item);
  }

  const src = art(a.artwork, 112);
  dialog.append(
    el('div', { className: 'dl-dialog-head' },
      src ? el('img', { className: 'dl-dialog-art', src, alt: '' }) : null,
      el('div', { className: 'dl-dialog-titles' },
        el('h2', { className: 'dl-dialog-title', id: 'ac-dialog-title', textContent: t('ac.title', { name: a.name || '' }) }),
        el('p', { className: 'dl-dialog-sub', textContent: a.artistName || '' }))),
    el('details', { className: 'ac-intro' }, el('summary', { textContent: t('ac.introSummary') }), el('p', { textContent: t('ac.intro') })),
    el('label', { className: 'ac-option' }, analyzeBox, el('span', { textContent: t('ac.analyzeOption') })),
    el('div', { className: 'dl-dialog-tools' }, summary),
    list,
    el('div', { className: 'dl-dialog-foot' }, copy, close, run));
  dialog.addEventListener('close', () => { stop(); dialog.remove(); });
  document.body.append(dialog);
  dialog.showModal();
  start();
  return dialog;
}
