// End-to-end check of the GUI against a running am-hook + wrapper-lite + mpv.
//
// Needs the GUI started with AM_HOOK_GUI_CDP=9222 and AM_HOOK_GUI_DEBUG_BRIDGE=1:
//   node scripts/e2e.mjs --base http://127.0.0.1:8888 --device "usb dac"
//
// It drives the real WebView2 window through the DevTools protocol.
// --device is a fragment of the output device name or id; passing it keeps the test away
// from the system default device. The album and codecs below are fixture data, so the
// server under test needs to have them.
//
// 顺序有意安排：先用“优先 Dolby Atmos 关闭”跑 ALAC 队列（暂停、seek、切歌、后退），
// 再打开优先全景声验证队列会自动选 E-AC-3，然后换设备、歌词、后台播放、
// 浏览器 ↔ MPV 切换，最后验证关窗即退出。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

const BASE = arg('base', 'http://127.0.0.1:8888').replace(/\/$/, '');
// CDP 目标按 base 的 host 匹配，本机与远程部署都能跑
const HOST = new URL(BASE).host || BASE;
const PORT = arg('port', process.env.AM_HOOK_GUI_CDP || '9222');
const DATA_DIR = arg('data', process.env.AM_HOOK_GUI_DATA_DIR);
const DEVICE = arg('device', process.env.AM_HOOK_GUI_TEST_DEVICE || '');
const ALBUM = '/https://music.apple.com/cn/album/1989-taylors-version-deluxe/1713845538';

if (!DATA_DIR) {
  console.error('需要 --data 或 AM_HOOK_GUI_DATA_DIR 指向 GUI 启动时使用的数据目录（里面有 bridge.json）');
  process.exit(2);
}

const report = [];
let failures = 0;

// 任何一步卡死都要能退出，别把整轮测试挂在那里
const watchdog = setTimeout(() => {
  console.error('整体超时（10 分钟），测试中止');
  process.exit(4);
}, 10 * 60 * 1000);
watchdog.unref?.();

function pass(name, detail = '') {
  report.push({ name, ok: true, detail });
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail) {
  failures += 1;
  report.push({ name, ok: false, detail });
  console.log(`FAIL ${name} — ${detail}`);
}

async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    pass(name, `${detail ?? ''}${detail ? ' ' : ''}(${Date.now() - started} ms)`);
  } catch (error) {
    fail(name, (error && error.message) || String(error));
  }
}

function bridgeInfo() {
  const raw = readFileSync(join(DATA_DIR, 'bridge.json'), 'utf8');
  return JSON.parse(raw);
}

async function bridgeFetch(path, options = {}) {
  const { port, token } = bridgeInfo();
  const url = new URL(path, `http://127.0.0.1:${port}`);
  url.searchParams.set('token', token);
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body,
  });
  return response.json().catch(() => ({}));
}

async function setConfig(patch) {
  return bridgeFetch('/config', { method: 'POST', body: JSON.stringify(patch) });
}

/* ---------------- CDP ---------------- */

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      let message = null;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} ${message.error.data || ''}`));
      else resolve(message.result);
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  async waitFor(expression, timeout = 30000, label = expression) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeout) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch (error) {
        last = error.message;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
  }

  close() {
    try { this.socket.close(); } catch {}
  }
}

async function targets() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json`);
  return response.json();
}

async function attach(match, timeout = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const pages = (await targets()).filter((target) => target.type === 'page');
    const hit = pages.find((target) => target.url.includes(match));
    if (hit) {
      const socket = new WebSocket(hit.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
      const client = new Cdp(socket);
      await client.send('Runtime.enable');
      return client;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`no page target matching ${match}`);
}

/* ---------------- 页面侧辅助 ---------------- */

const PLAYER_STATE = `(() => {
  const p = window.AmApp && window.AmApp.player;
  const gui = window.__AM_HOOK_GUI__;
  if (!p) return null;
  const transport = p.current ? p.transport() : null;
  const snapshot = gui && gui.snapshot ? gui.snapshot() : null;
  return {
    track: p.current && p.current.track,
    id: p.current && p.current.id,
    mode: p.current && p.current.mode,
    codecs: p.current && p.current.codecs,
    paused: transport ? transport.paused : null,
    time: transport ? transport.currentTime : null,
    duration: p.duration(),
    engine: snapshot && snapshot.engines[0] ? snapshot.engines[0] : null,
    enabled: snapshot ? snapshot.enabled : null,
    path: decodeURIComponent(location.pathname),
  };
})()`;

async function playerState(page) {
  return page.eval(PLAYER_STATE);
}

/** 探测 mpv 的音频设备，按 --device 的名称片段挑一个（不碰系统默认设备） */
async function pickDevice() {
  if (!DEVICE) throw new Error('请用 --device 或 AM_HOOK_GUI_TEST_DEVICE 指定测试输出设备');
  const payload = await bridgeFetch('/mpv/devices?refresh=true');
  const devices = payload.devices || [];
  const hint = DEVICE.toLowerCase();
  const hit = devices.find((device) => `${device.description || ''} ${device.id}`.toLowerCase().includes(hint));
  if (!hit) {
    throw new Error(`没有找到匹配「${DEVICE}」的设备，现有：${devices.map((d) => `${d.id} ${d.description}`).join(' | ')}`);
  }
  return hit;
}

async function openAlbum(page) {
  await page.eval(`location.href = ${JSON.stringify(ALBUM)}`);
  await page.waitFor(
    `(() => { const b = document.querySelector('#play-all'); return !!b && !b.disabled && document.querySelectorAll('.track').length > 3; })()`,
    60000,
    'album page ready',
  );
}

async function main() {
  console.log(`am-hook GUI end-to-end test → ${BASE}, CDP port ${PORT}`);

  /* 1. 连接 */
  let page;
  await step('客户端已连接并打开 am-hook 页面', async () => {
    try {
      page = await attach(HOST, 5000);
      return '复用已打开的页面';
    } catch {
      const connect = await attach('tauri.localhost', 30000);
      await connect.eval(`(() => {
        const input = document.getElementById('server-url');
        input.value = ${JSON.stringify(BASE)};
        document.getElementById('connect-form').dispatchEvent(new Event('submit', { cancelable: true }));
        return true;
      })()`);
      page = await attach(HOST, 90000);
      return '从连接窗口提交地址';
    }
  });
  if (!page) {
    console.log('\n没有可用的页面，测试终止');
    process.exit(1);
  }

  /* 2. 设备 + 关掉“优先全景声”，先跑 ALAC 路径 */
  await step('探测音频设备并选中指定设备', async () => {
    const device = await pickDevice();
    // 每一轮从确定的状态开始：启用 mpv、关掉优先全景声、输出到指定设备
    await setConfig({ mpv: { enabled: true, device: device.id, exclusive: true, preferAtmos: false } });
    await page.waitFor(
      `(() => { const s = window.__AM_HOOK_GUI__.snapshot(); return s && s.settings && s.settings.mpv && s.settings.mpv.enabled === true && s.settings.mpv.device === ${JSON.stringify(device.id)} && s.settings.mpv.preferAtmos === false; })()`,
      15000,
      'device + preferAtmos applied',
    );
    // 页面自己的 JOC 偏好也回到 off（上一轮可能被“优先全景声”临时打开过），保证 ALAC 步骤确定
    await page.eval(`(() => {
      try {
        const raw = JSON.parse(localStorage.getItem('am-hook:settings') || '{}');
        raw.joc = Object.assign({ mode: 'off' }, raw.joc || {}, { mode: 'off' });
        const text = JSON.stringify(raw);
        localStorage.setItem('am-hook:settings', text);
        localStorage.removeItem('am-hook:gui:joc-restore');
      } catch {}
      return true;
    })()`);
    // 重载页面，清掉上一轮留下的播放器/会话状态
    await page.eval(`location.reload()`);
    await page.waitFor(
      `(() => { const g = window.__AM_HOOK_GUI__; return g && g.ready && window.AmApp && window.AmApp.player ? true : false; })()`,
      40000,
      'page reloaded',
    );
    return `${device.description} (${device.id})`;
  });

  await step('注入脚本已就绪（播放器补丁 + bridge 事件流）', async () => {
    const diag = await page.waitFor('(() => { const g = window.__AM_HOOK_GUI__; return g && g.ready ? g.diag() : null; })()', 30000, 'shim ready');
    return `mpv=${diag.info && diag.info.found ? '已找到' : '未找到'} events=${diag.lastEvent}`;
  });

  await step('打开专辑页（1989 Taylor\'s Version Deluxe）', async () => {
    await openAlbum(page);
    return ALBUM;
  });

  /* 3. 队列播放（ALAC） */
  await step('队列播放通过本地 mpv 输出（ALAC）', async () => {
    let started = false;
    let last = null;
    for (let attempt = 0; attempt < 3 && !started; attempt += 1) {
      await page.eval(`document.querySelector('#play-all').click()`);
      try {
        last = await page.waitFor(
          `(() => { const s = ${PLAYER_STATE}; return s && s.mode === 'mpv' && s.codecs === 'alac' && s.time > 0.5 ? s : null; })()`,
          40000,
          'mpv alac playback',
        );
        started = true;
      } catch (error) {
        last = error.message;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    if (!started) throw new Error(`点了播放仍然没有开始 ALAC（last: ${JSON.stringify(last)}）`);
    const sessionState = await page.waitFor(
      `(() => { const g = window.__AM_HOOK_GUI__.snapshot(); const s = g.sessionState; return s && s.position > 0.5 ? s : null; })()`,
      30000,
      'mpv position',
    );
    return `track=${last.track} codec=${sessionState.codec} ${sessionState.samplerate}Hz ${sessionState.channels}ch`;
  });

  /* 4. 面板 */
  await step('页面悬浮面板改设置（开关 / 设备 → bridge）', async () => {
    const result = await page.eval(`(async () => {
      const g = window.__AM_HOOK_GUI__;
      g.openPanel(true);
      await new Promise((resolve) => setTimeout(resolve, 800));
      const shadow = document.getElementById('am-hook-gui-panel').shadowRoot;
      const before = g.snapshot().settings.mpv.enabled;
      const waitFor = async (value) => {
        for (let i = 0; i < 60; i += 1) {
          if (g.snapshot().settings.mpv.enabled === value) return true;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        return false;
      };
      shadow.querySelector('[data-role="enable"]').click();
      const flipped = await waitFor(!before);
      shadow.querySelector('[data-role="enable"]').click();
      const restored = await waitFor(before);
      return { before, flipped, restored, pathField: shadow.querySelector('[data-role="mpv-path"]').value };
    })()`);
    if (!result.flipped || !result.restored) throw new Error(`面板开关没有保存：${JSON.stringify(result)}`);
    return `开关从 ${result.before} 往返均写回配置`;
  });

  await step('面板切设备后真的换到那个设备', async () => {
    const target = await pickDevice();
    const result = await page.eval(`(async () => {
      const g = window.__AM_HOOK_GUI__;
      g.openPanel(true);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const shadow = document.getElementById('am-hook-gui-panel').shadowRoot;
      const select = shadow.querySelector('[data-role="device"]');
      const step = async (value, wait) => {
        select.value = value;
        select.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 700));
        window.AmApp.player.replay();
        await new Promise((resolve) => setTimeout(resolve, wait));
        return { config: g.snapshot().settings.mpv.device, session: g.snapshot().sessionState && g.snapshot().sessionState.device };
      };
      const auto = await step('auto', 9000);
      const back = await step(${JSON.stringify(target.id)}, 9000);
      return { auto, back };
    })()`);
    if (result.auto.config !== 'auto' || result.auto.session !== 'auto') {
      throw new Error(`面板选 auto 没有生效：${JSON.stringify(result.auto)}`);
    }
    if (result.back.config !== target.id || result.back.session !== target.id) {
      throw new Error(`面板切回指定设备没有生效：${JSON.stringify(result.back)}`);
    }
    return `auto → ${target.description}`;
  });

  await step('WASAPI 独占输出到指定设备', async () => {
    const target = await pickDevice();
    const deviceLabel = target.description || target.id;
    const g = await page.eval(`window.__AM_HOOK_GUI__.snapshot()`);
    const engine = g.engines[0];
    if (!engine || !engine.device) throw new Error('拿不到 mpv 的输出设备');
    const configured = g.settings && g.settings.mpv && g.settings.mpv.device;
    if (configured && engine.device !== configured) {
      throw new Error(`mpv 实际使用的设备 ${engine.device} 与设置里的 ${configured} 不一致`);
    }
    if (engine.device === 'auto') throw new Error('mpv 用的是 auto，没有固定到探测到的设备');
    return `设备 ${deviceLabel}（exclusive=${g.settings.mpv.exclusive}）`;
  });

  /* 5. 播放控制 */
  await step('暂停与继续（页面按钮 → mpv IPC）', async () => {
    await page.eval(`document.querySelector('.player-toggle').click()`);
    await page.waitFor(`(() => { const s = ${PLAYER_STATE}; return s && s.paused === true; })()`, 8000, 'paused');
    const paused = await playerState(page);
    await page.eval(`document.querySelector('.player-toggle').click()`);
    await page.waitFor(`(() => { const s = ${PLAYER_STATE}; return s && s.paused === false; })()`, 8000, 'resumed');
    return `暂停时 time=${Math.round(paused.time)}s，之后继续播放`;
  });

  await step('拖动进度 / seek 到 90 秒', async () => {
    await page.eval(`(() => { const p = window.AmApp.player; p.transport().currentTime = 90; return true; })()`);
    const state = await page.waitFor(`(() => { const s = ${PLAYER_STATE}; return s && Math.abs(s.time - 90) < 6 ? s : null; })()`, 30000, 'seek');
    return `seek 后 time=${Math.round(state.time)}s`;
  });

  await step('切歌（下一首）', async () => {
    const before = await playerState(page);
    await page.eval(`document.querySelector('.skip-next').click()`);
    const after = await page.waitFor(
      `(() => { const s = ${PLAYER_STATE}; return s && s.track !== ${JSON.stringify(before.track)} && s.mode === 'mpv' && s.time > 0.5 ? s : null; })()`,
      90000,
      'next track',
    );
    return `${before.track} → ${after.track}`;
  });

  /* 6. 后退按钮（设置页 → 上一页） */
  await step('左上角的后退按钮能从设置页回到专辑页', async () => {
    await openAlbum(page);
    await page.eval(`location.href = '/settings'`);
    await page.waitFor(
      `(() => { const host = document.getElementById('am-hook-gui-panel'); return !!host && !!host.shadowRoot.querySelector('[data-role="top-back"]'); })()`,
      30000,
      'settings page with nav',
    );
    const before = await page.eval(`(() => {
      const shadow = document.getElementById('am-hook-gui-panel').shadowRoot;
      shadow.querySelector('[data-role="top-back"]').click();
      return { historyLength: history.length, path: decodeURIComponent(location.pathname) };
    })()`);
    const after = await page.waitFor(
      `(() => { const path = decodeURIComponent(location.pathname); return path.includes('1989-taylors-version-deluxe') ? path : null; })()`,
      15000,
      'back to album',
    );
    return `设置页（history=${before.historyLength}）→ 后退 → ${String(after).slice(-32)}`;
  });

  /* 7. 优先全景声 */
  await step('打开“优先 Dolby Atmos”后队列自动选全景声', async () => {
    await setConfig({ mpv: { preferAtmos: true } });
    await page.waitFor(`window.__AM_HOOK_GUI__.snapshot().settings.mpv.preferAtmos === true`, 15000, 'preferAtmos on');
    await page.waitFor(
      `(() => { try { const raw = JSON.parse(localStorage.getItem('am-hook:settings') || '{}'); return raw.joc && raw.joc.mode && raw.joc.mode !== 'off'; } catch { return false; } })()`,
      15000,
      'page prefers atmos',
    );
    await openAlbum(page);
    await page.eval(`document.querySelector('#play-all').click()`);
    const state = await page.waitFor(
      `(() => { const s = ${PLAYER_STATE}; return s && s.codecs === 'ec-3' && s.mode === 'mpv' && s.time > 0.5 ? s : null; })()`,
      90000,
      'atmos picked by queue',
    );
    const engine = await page.waitFor(
      `(() => { const g = window.__AM_HOOK_GUI__.snapshot(); const e = g.engines[0]; return e && e.session === g.session && e.decoder ? e : null; })()`,
      30000,
      'atmos decoder',
    );
    if (!/joc/i.test(String(engine.decoder))) throw new Error(`队列选的不是 JOC 解码：${engine.decoder}`);
    return `队列选中 ${state.id} → ${engine.decoder}`;
  });

  await step('歌词面板打开（与 mpv 进度同步）', async () => {
    const hasLyrics = await page.eval(`!!document.querySelector('#player .player-lyrics')`);
    if (!hasLyrics) throw new Error('播放条上没有歌词按钮');
    await page.eval(`document.querySelector('#player .player-lyrics').click()`);
    await page.waitFor(
      `(() => { const overlay = document.querySelector('#lyrics-overlay'); return overlay && !overlay.hidden; })()`,
      20000,
      'lyrics overlay',
    );
    const lines = await page.eval(`document.querySelectorAll('#lyrics-overlay *').length`);
    await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    return `歌词浮层已打开（${lines} 个节点）`;
  });

  /* 8. 后台播放 */
  await step('最小化窗口后 mpv 播放继续（WebView 后台不降频）', async () => {
    const before = await playerState(page);
    await bridgeFetch('/ui', { method: 'POST', body: JSON.stringify({ action: 'minimizeMain' }) });
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const after = await playerState(page);
    if (!(after.time > before.time + 3)) {
      throw new Error(`位置没有前进：${before.time} → ${after.time}（paused=${after.paused} mode=${after.mode}）`);
    }
    const sessionState = await page.eval(`window.__AM_HOOK_GUI__.snapshot().sessionState`);
    if (!sessionState) throw new Error('最小化后拿不到 mpv 状态');
    await bridgeFetch('/ui', { method: 'POST', body: JSON.stringify({ action: 'showMain' }) });
    return `${Math.round(before.time)}s → ${Math.round(after.time)}s，状态推送正常`;
  });

  /* 9. 浏览器 ↔ MPV */
  await step('浏览器输出 ↔ MPV 来回切换（不能两路同时出声）', async () => {
    await setConfig({ mpv: { preferAtmos: false } });
    await page.waitFor(`window.__AM_HOOK_GUI__.snapshot().settings.mpv.preferAtmos === false`, 10000, 'preferAtmos off');
    // 换回专辑第一首的 ALAC：浏览器用 MSE 就能放，切换测试才有意义
    await openAlbum(page);
    await page.waitFor(
      `(() => { const b = document.querySelector('#play-all'); return !!b && !b.disabled; })()`,
      30000,
      'album ready',
    );
    await page.eval(`document.querySelector('#play-all').click()`);
    await page.waitFor(
      `(() => { const s = ${PLAYER_STATE}; return s && s.mode === 'mpv' && s.codecs === 'alac' && s.time > 0.5; })()`,
      60000,
      'alac before switch',
    );
    await setConfig({ mpv: { enabled: false } });
    await page.waitFor(`window.__AM_HOOK_GUI__.snapshot().enabled === false`, 15000, 'mpv disabled');
    await page.waitFor(
      `(() => { const p = window.AmApp.player; return p.current && p.current.mode !== 'mpv' && p.transport().currentTime > 0.5 && !p.transport().paused; })()`,
      90000,
      'browser playback',
    );
    const browserMode = await page.eval(`window.AmApp.player.current.mode`);
    const audioOn = await page.eval(`(() => { const a = window.AmApp.player.audio; return { paused: a.paused, hasSrc: !!(a.currentSrc || a.src) }; })()`);
    if (audioOn.paused || !audioOn.hasSrc) throw new Error(`浏览器模式下 <audio> 没有在放：${JSON.stringify(audioOn)}`);

    await setConfig({ mpv: { enabled: true } });
    await page.waitFor(`window.__AM_HOOK_GUI__.snapshot().enabled === true`, 15000, 'mpv enabled');
    await page.waitFor(
      `(() => { const p = window.AmApp.player; return p.current && p.current.mode === 'mpv' && p.transport().currentTime > 0.5 && !p.transport().paused; })()`,
      90000,
      'mpv playback after switch',
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    const audioOff = await page.eval(
      `(() => { const a = window.AmApp.player.audio; return { paused: a.paused, hasSrc: !!(a.currentSrc || a.src) }; })()`,
    );
    if (!audioOff.paused) throw new Error(`切到 mpv 后页面的 <audio> 还在播放（两路同时出声）：${JSON.stringify(audioOff)}`);
    return `浏览器(${browserMode}) 停下 → mpv 接管，<audio> paused=${audioOff.paused}`;
  });

  /* 10. 关窗 */
  await step('关窗即退出：mpv 一起停掉（默认行为）', async () => {
    await setConfig({ mpv: { enabled: true } });
    await page.waitFor(`window.__AM_HOOK_GUI__.snapshot().enabled === true`, 15000, 'mpv enabled');
    let before = await playerState(page);
    if (!before || before.mode !== 'mpv' || before.paused) {
      await openAlbum(page);
      await page.eval(`document.querySelector('#play-all').click()`);
      before = await page.waitFor(
        `(() => { const s = ${PLAYER_STATE}; return s && s.mode === 'mpv' && s.time > 0.5 && !s.paused ? s : null; })()`,
        60000,
        'mpv playing before close',
      );
    }
    // 关窗会直接退出进程，HTTP 响应可能来不及回来，失败是预期的
    await bridgeFetch('/ui', { method: 'POST', body: JSON.stringify({ action: 'closeMain' }) }).catch(() => null);
    const started = Date.now();
    let gone = false;
    while (Date.now() - started < 15000) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        await bridgeFetch('/health');
      } catch {
        gone = true;
        break;
      }
    }
    if (!gone) throw new Error('关闭窗口后 GUI 仍然在运行');
    let pages = [];
    try {
      pages = (await targets()).filter((target) => target.type === 'page');
    } catch {
      pages = [];
    }
    if (pages.some((target) => target.url.includes(HOST))) throw new Error('关闭窗口后页面还在');
    return `关闭前 ${Math.round(before.time)}s 在播放，关窗后进程与页面都退出`;
  });

  clearTimeout(watchdog);
  console.log(`\n${report.length - failures}/${report.length} 项通过`);
  if (failures) {
    console.log('\n失败项：');
    for (const item of report.filter((entry) => !entry.ok)) console.log(` - ${item.name}: ${item.detail}`);
    process.exit(1);
  }
  page.close();
  process.exit(0);
}

main().catch((error) => {
  console.error('测试脚本出错：', error);
  process.exit(2);
});
