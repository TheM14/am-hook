/* 连接窗口：首次填写服务器地址，之后自动连接；失败时给出可操作的原因与重试入口。 */
'use strict';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const el = (id) => document.getElementById(id);
const ICON_WAIT = '<span class="spinner"></span>';
const ICON_OK = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="#37c8a0" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5l4 4 8-9"/></svg>';
const ICON_BAD = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="#ef6a6a" stroke-width="2" stroke-linecap="round"><path d="M10 5v6.5"/><circle cx="10" cy="15" r="1.1" fill="#ef6a6a" stroke="none"/><circle cx="10" cy="10" r="8.2" stroke-width="1.6"/></svg>';

let snapshot = null;
let busy = false;

const HINTS = {
  network: '确认 am-hook 正在运行、地址与端口正确，并检查防火墙或代理。',
  http: '这个端口可能被别的服务占用；请确认 am-hook 的 --listen 地址与端口。',
  challenge: '目标站点要求 Cloudflare 人机验证，客户端无法自动检查。确认是你的服务器后可以点「仍然继续」，在打开的页面里完成验证。',
  'not-am-hook': '这个网页不是 am-hook。请填写 am-hook 的站点根地址（不要带 /assets 之类的子路径）。',
  incompatible: '这个 am-hook 太旧了：需要带浏览器内解密（AmDecrypt）的版本。',
  'bad-url': '地址格式不对，例如 http://192.168.1.10:8888 或 https://music.example.com。',
  window: '服务器检查通过，但打开窗口失败。请重试，或查看设置里的日志。',
};

function showStatus(kind, title, detail, { actions = false, allowContinue = false } = {}) {
  const status = el('status');
  status.hidden = false;
  status.className = `status ${kind}`;
  el('status-icon').innerHTML = kind === 'error' ? ICON_BAD : kind === 'success' ? ICON_OK : ICON_WAIT;
  el('status-title').textContent = title;
  el('status-detail').textContent = detail || '';
  el('status-actions').hidden = !actions;
  el('continue-button').hidden = !allowContinue;
}

function hideStatus() {
  el('status').hidden = true;
}

function setBusy(value) {
  busy = value;
  el('connect-button').disabled = value;
  el('connect-button').textContent = value ? '连接中…' : '连接';
}

function renderRecent(history) {
  const chips = el('recent-chips');
  const recent = (history || []).filter(Boolean);
  el('recent').hidden = recent.length === 0;
  chips.replaceChildren(...recent.map((url) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = url;
    button.addEventListener('click', () => {
      el('server-url').value = url;
      el('server-url').focus();
    });
    return button;
  }));
}

function applyConnect(connect) {
  if (!connect) return;
  if (connect.status === 'checking') {
    el('server-url').value = connect.url || el('server-url').value;
    showStatus('', '正在连接…', connect.url || '正在检查服务器');
    setBusy(true);
    return;
  }
  if (connect.status === 'failed') {
    setBusy(false);
    const hint = HINTS[connect.kind] || '请检查地址后重试。';
    showStatus('error', '连接失败', `${connect.message || '未知错误'}\n${hint}`, {
      actions: true,
      allowContinue: connect.kind === 'challenge',
    });
    return;
  }
  if (connect.status === 'connected') {
    setBusy(false);
    showStatus('success', '连接成功', `${connect.url || ''} · 正在打开 am-hook 页面`);
    return;
  }
  setBusy(false);
  hideStatus();
}

function renderFooter(state) {
  const parts = [];
  if (state && state.bridge && state.bridge.port) parts.push(`bridge 端口 ${state.bridge.port}`);
  if (state && state.mpv) {
    parts.push(state.mpv.found ? `mpv ${state.mpv.version || '已找到'}` : 'mpv 未找到');
  }
  el('footer-info').textContent = parts.join(' · ') || '就绪';
}

async function refresh() {
  try {
    snapshot = await invoke('gui_snapshot');
  } catch (error) {
    el('footer-info').textContent = '无法读取状态，请重启客户端';
    return;
  }
  if (snapshot.config && snapshot.config.server) {
    const saved = snapshot.config.server.url;
    if (saved && !el('server-url').value) el('server-url').value = saved;
  }
  renderRecent(snapshot.config && snapshot.config.server && snapshot.config.server.history);
  renderFooter(snapshot);
  el('version-pill').textContent = `v${(snapshot.version || '0.1.0')}`;
  applyConnect(snapshot.connect);
}

async function connect() {
  const url = el('server-url').value.trim();
  if (!url) {
    showStatus('error', '请输入服务器地址', '例如 https://music.example.com');
    el('server-url').focus();
    return;
  }
  if (busy) return;
  setBusy(true);
  showStatus('', '正在连接…', url);
  try {
    const info = await invoke('connect', { url });
    showStatus('success', '连接成功', `${info.url} · ${info.title || 'am-hook'}`);
  } catch (error) {
    const kind = (error && error.kind) || 'network';
    const message = (error && (error.message || error.msg)) || String(error);
    const hint = HINTS[kind] || '请检查地址后重试。';
    showStatus('error', '连接失败', `${message}\n${hint}`, {
      actions: true,
      allowContinue: kind === 'challenge',
    });
  } finally {
    setBusy(false);
  }
}

/** 检查被 Cloudflare 拦截时，用户确认后直接打开页面；验证在 WebView 里完成。 */
async function continueAnyway() {
  const url = el('server-url').value.trim();
  if (!url) return;
  setBusy(true);
  showStatus('', '正在打开…', url);
  try {
    const info = await invoke('connect_anyway', { url });
    showStatus('success', '已打开页面', `${info.url} · 如果出现人机验证，请在页面里完成`);
  } catch (error) {
    const message = (error && (error.message || error.msg)) || String(error);
    showStatus('error', '无法打开页面', message, {
      actions: true,
      allowContinue: !(error && error.kind === 'bad-url'),
    });
  } finally {
    setBusy(false);
  }
}

async function boot() {
  el('connect-form').addEventListener('submit', (event) => {
    event.preventDefault();
    connect();
  });
  el('settings-button').addEventListener('click', () => invoke('open_settings').catch(() => {}));
  el('quit-button').addEventListener('click', () => invoke('quit_app').catch(() => {}));
  el('retry-button').addEventListener('click', () => connect());
  el('continue-button').addEventListener('click', () => continueAnyway());
  el('edit-button').addEventListener('click', () => {
    hideStatus();
    el('server-url').focus();
    el('server-url').select();
  });
  await listen('gui://connect', (event) => applyConnect(event.payload));
  await listen('gui://state', (event) => {
    snapshot = event.payload;
    renderRecent(snapshot.config && snapshot.config.server && snapshot.config.server.history);
    renderFooter(snapshot);
  });
  await refresh();
  setTimeout(() => {
    if (!el('server-url').value) el('server-url').focus();
    else el('server-url').select();
  }, 120);
}

boot().catch((error) => {
  const footer = el('footer-info');
  if (footer) footer.textContent = `初始化失败：${(error && error.message) || error}`;
  console.error(error);
});
