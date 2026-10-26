/* 设置窗口：服务器 / 输出与 mpv / 桌面与后台 / 诊断。改动即时保存并广播给页面里的补丁脚本。 */
'use strict';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const el = (id) => document.getElementById(id);
let snapshot = null;
let devicesLoaded = false;
let toastTimer = null;

function toast(message, isError) {
  const node = el('toast');
  node.textContent = message;
  node.className = `toast${isError ? ' error' : ''}`;
  node.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.dataset.show = 'false'; }, 2200);
}

async function save(patch, { quiet = false } = {}) {
  try {
    snapshot = await invoke('save_config', { patch });
    if (!quiet) toast('已保存');
    render(snapshot);
  } catch (error) {
    toast(String((error && (error.message || error.msg)) || error), true);
  }
}

function bindSwitch(id, getValue, onToggle) {
  const node = el(id);
  node.addEventListener('click', () => onToggle(!getValue()));
}

function setSwitch(id, value) {
  el(id).dataset.on = String(!!value);
}

function renderServer(state) {
  const server = state.server;
  const config = state.config;
  const pill = el('server-pill');
  const connect = state.connect || {};
  if (server) {
    pill.className = 'pill ok';
    pill.innerHTML = `<span class="dot"></span>已连接`;
    el('server-title').textContent = server.title || '';
  } else if (connect.status === 'checking') {
    pill.className = 'pill warn';
    pill.innerHTML = `<span class="dot"></span>连接中…`;
    el('server-title').textContent = connect.url || '';
  } else if (connect.status === 'failed') {
    pill.className = 'pill bad';
    pill.innerHTML = `<span class="dot"></span>连接失败`;
    el('server-title').textContent = connect.message || '';
  } else {
    pill.className = 'pill';
    pill.innerHTML = `<span class="dot"></span>未连接`;
    el('server-title').textContent = '';
  }
  if (document.activeElement !== el('server-url')) {
    el('server-url').value = (server && server.url) || (config.server && config.server.url) || '';
  }
  const history = (config.server && config.server.history) || [];
  el('server-history').replaceChildren(...history.map((url) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = url;
    button.addEventListener('click', () => { el('server-url').value = url; });
    return button;
  }));
}

function renderOutput(state) {
  const mpv = state.config.mpv;
  setSwitch('mpv-enabled', mpv.enabled);
  setSwitch('mpv-exclusive', mpv.exclusive);
  setSwitch('mpv-prefer-atmos', mpv.preferAtmos !== false);
  if (document.activeElement !== el('mpv-path')) el('mpv-path').value = mpv.path || '';
  if (document.activeElement !== el('mpv-config')) el('mpv-config').value = mpv.configFile || '';
  if (document.activeElement !== el('mpv-args')) el('mpv-args').value = mpv.extraArgs || '';
  if (document.activeElement !== el('mpv-cache')) el('mpv-cache').value = mpv.cacheSeconds || 20;
  const info = state.mpv || {};
  const pill = el('mpv-status');
  if (!info.found) {
    pill.className = 'pill bad';
    pill.textContent = '未找到 mpv';
  } else {
    pill.className = 'pill ok';
    pill.textContent = info.version || info.path;
    pill.title = info.path || '';
  }
  const select = el('mpv-device');
  const current = mpv.device || '';
  if (!select.dataset.loaded) {
    select.innerHTML = '<option value="">（mpv 默认设备）</option>';
  }
  select.value = current;
  if (info.found && !devicesLoaded) loadDevices(false);
}

function renderDesktop(state) {
  const behavior = state.config.behavior;
  setSwitch('behavior-close', behavior.closeToTray);
  setSwitch('behavior-minimize', behavior.minimizeToTray);
  setSwitch('behavior-start-hidden', behavior.startHidden);
  setSwitch('behavior-background', behavior.backgroundPlayback);
  setSwitch('behavior-insecure', behavior.insecureOriginAsSecure);
}

async function renderDiagnostics(state) {
  let trayText = '—';
  try {
    const tray = await invoke('tray_status');
    trayText = tray.registered
      ? '已注册（右下角通知区域或 ^ 折叠区里）'
      : tray.created
        ? '已创建，但系统没有接收（看看 ^ 折叠区，或被系统策略隐藏）'
        : '未创建';
  } catch (error) {
    trayText = '读取失败';
  }

  const rows = [
    ['版本', snapshotVersion(state)],
    ['服务器', (state.server && state.server.url) || '未连接'],
    ['bridge 地址', (state.bridge && state.bridge.url) || '—'],
    ['mpv 路径', (state.mpv && state.mpv.path) || '未找到'],
    ['mpv 版本', (state.mpv && state.mpv.version) || '—'],
    ['mpv 配置目录', (state.config.mpv && state.config.mpv.configFile) || '（未指定，使用 --no-config）'],
    ['音频设备', (state.config.mpv && state.config.mpv.device) || '（mpv 默认设备）'],
    ['独占模式', state.config.mpv && state.config.mpv.exclusive ? '开（--ao=wasapi）' : '关'],
    ['当前 mpv 会话', state.session || '无'],
    ['配置文件', state.configPath || '—'],
    ['数据目录', state.dataDir || '—'],
    ['页面存储目录', state.webviewDir || '—'],
    ['托盘图标', trayText],
    ['权限', state.dataDirFallback ? '受限（数据目录回退到程序目录，托盘图标可能不可用；请直接双击程序启动）' : '正常'],
    ['运行时长', `${Math.round(state.uptimeSeconds || 0)} 秒`],
  ];
  el('diagnostics-info').replaceChildren(...rows.flatMap(([key, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    return [dt, dd];
  }));
}

function snapshotVersion(state) {
  return state.version || '0.1.0';
}

function render(state) {
  if (!state) return;
  renderServer(state);
  renderOutput(state);
  renderDesktop(state);
  void renderDiagnostics(state);
  el('sidebar-version').textContent = `v${snapshotVersion(state)}`;
}

async function loadDevices(refresh) {
  const select = el('mpv-device');
  try {
    const list = await invoke('list_devices', { refresh: !!refresh });
    const current = (snapshot && snapshot.config && snapshot.config.mpv && snapshot.config.mpv.device) || '';
    const options = [new Option('（mpv 默认设备）', '')];
    for (const device of list || []) {
      const label = device.description || device.name || device.id;
      options.push(new Option(label, device.id));
    }
    if (current && !(list || []).some((device) => device.id === current)) {
      options.push(new Option(`${current}（当前设置，未在列表里）`, current));
    }
    select.replaceChildren(...options);
    select.value = current;
    select.dataset.loaded = '1';
    devicesLoaded = true;
    if (!list || !list.length) {
      select.replaceChildren(new Option('没有枚举到设备（检查 mpv 与声卡）', ''));
    }
  } catch (error) {
    devicesLoaded = true;
    select.replaceChildren(new Option(`读取设备失败：${(error && error.message) || error}`, ''));
    toast(String((error && error.message) || error), true);
  }
}

async function refreshLogs() {
  try {
    const text = await invoke('logs', { lines: 300 });
    const node = el('logs');
    node.textContent = text || '（还没有日志）';
    node.scrollTop = node.scrollHeight;
  } catch (error) {
    el('logs').textContent = `读取日志失败：${error}`;
  }
}

async function reload() {
  try {
    snapshot = await invoke('gui_snapshot');
  } catch (error) {
    toast('无法读取状态', true);
    return;
  }
  render(snapshot);
}

async function boot() {
  // 导航
  const buttons = Array.from(document.querySelectorAll('.nav button'));
  const sections = Array.from(document.querySelectorAll('.section'));
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const target = button.dataset.target;
      for (const other of buttons) other.dataset.active = String(other === button);
      for (const section of sections) section.dataset.active = String(section.dataset.section === target);
      if (target === 'diagnostics') refreshLogs();
      if (target === 'output' && !devicesLoaded) loadDevices(false);
    });
  }

  // 服务器
  el('server-connect').addEventListener('click', async () => {
    const url = el('server-url').value.trim();
    if (!url) { toast('请填写服务器地址', true); return; }
    try {
      const info = await invoke('connect', { url });
      toast(`已连接 ${info.url}`);
      await reload();
    } catch (error) {
      toast(`${(error && error.message) || error}`, true);
      await reload();
    }
  });
  el('server-url').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') el('server-connect').click();
  });
  el('server-reconnect').addEventListener('click', async () => {
    await invoke('reconnect').catch(() => {});
    toast('正在重新连接…');
  });
  el('server-disconnect').addEventListener('click', async () => {
    await invoke('disconnect').catch(() => {});
    toast('已断开');
    await reload();
  });

  // 输出与 mpv
  bindSwitch('mpv-enabled', () => snapshot.config.mpv.enabled,
    (value) => save({ mpv: { enabled: value } }, { quiet: true }).then(() => toast(value ? '已开启 MPV 输出' : '已切回浏览器输出')));
  bindSwitch('mpv-exclusive', () => snapshot.config.mpv.exclusive,
    (value) => save({ mpv: { exclusive: value } }, { quiet: true }));
  bindSwitch('mpv-prefer-atmos', () => snapshot.config.mpv.preferAtmos !== false,
    (value) => save({ mpv: { preferAtmos: value } }, { quiet: true }));
  el('mpv-path').addEventListener('change', () => save({ mpv: { path: el('mpv-path').value.trim() || null } }, { quiet: true }));
  el('mpv-browse').addEventListener('click', async () => {
    try {
      const path = await invoke('pick_mpv_exe');
      if (path) {
        el('mpv-path').value = path;
        await save({ mpv: { path } }, { quiet: true });
        toast('已保存 mpv 路径');
      }
    } catch (error) {
      toast(String((error && error.message) || error), true);
    }
  });
  el('mpv-config').addEventListener('change', () => save({ mpv: { configFile: el('mpv-config').value.trim() || null } }, { quiet: true }));
  el('mpv-config-browse').addEventListener('click', async () => {
    try {
      const path = await invoke('pick_config_file');
      if (path) {
        el('mpv-config').value = path;
        await save({ mpv: { configFile: path } }, { quiet: true });
        toast('已保存 mpv 配置目录');
      }
    } catch (error) {
      toast(String((error && error.message) || error), true);
    }
  });
  el('mpv-config-clear').addEventListener('click', async () => {
    el('mpv-config').value = '';
    await save({ mpv: { configFile: null } }, { quiet: true });
    toast('已清空配置目录');
  });
  el('mpv-probe').addEventListener('click', async () => {
    try {
      const info = await invoke('probe_mpv', { refresh: true });
      devicesLoaded = false;
      await reload();
      toast(info.found ? `mpv: ${info.version || info.path}` : '没有找到 mpv', !info.found);
    } catch (error) {
      toast(String((error && error.message) || error), true);
    }
  });
  el('mpv-device').addEventListener('change', () => save({ mpv: { device: el('mpv-device').value } }, { quiet: true }));
  el('mpv-devices-refresh').addEventListener('click', () => loadDevices(true));
  el('mpv-cache').addEventListener('change', () => {
    const value = Math.max(1, Math.min(600, Number(el('mpv-cache').value) || 20));
    el('mpv-cache').value = value;
    save({ mpv: { cacheSeconds: value } }, { quiet: true });
  });
  el('mpv-args').addEventListener('change', () => save({ mpv: { extraArgs: el('mpv-args').value.trim() } }, { quiet: true }));

  // 桌面与后台
  bindSwitch('behavior-close', () => snapshot.config.behavior.closeToTray, (value) => save({ behavior: { closeToTray: value } }, { quiet: true }));
  bindSwitch('behavior-minimize', () => snapshot.config.behavior.minimizeToTray, (value) => save({ behavior: { minimizeToTray: value } }, { quiet: true }));
  bindSwitch('behavior-start-hidden', () => snapshot.config.behavior.startHidden, (value) => save({ behavior: { startHidden: value } }, { quiet: true }));
  bindSwitch('behavior-background', () => snapshot.config.behavior.backgroundPlayback, (value) => {
    save({ behavior: { backgroundPlayback: value } }, { quiet: true });
    toast('下次连接后生效');
  });
  bindSwitch('behavior-insecure', () => snapshot.config.behavior.insecureOriginAsSecure, (value) => {
    save({ behavior: { insecureOriginAsSecure: value } }, { quiet: true });
    toast('下次连接后生效');
  });

  // 诊断
  el('logs-refresh').addEventListener('click', refreshLogs);
  el('logs-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el('logs').textContent || '');
      toast('日志已复制');
    } catch {
      toast('复制失败', true);
    }
  });
  el('open-data-dir').addEventListener('click', () => invoke('open_data_dir').catch(() => {}));

  await listen('gui://state', (event) => {
    snapshot = event.payload;
    render(snapshot);
  });

  await reload();
  if (document.querySelector('.section[data-active="true"]').dataset.section === 'output') loadDevices(false);
  setInterval(() => {
    if (document.querySelector('.section[data-section="diagnostics"][data-active="true"]')) refreshLogs();
  }, 2500);
}

boot();
