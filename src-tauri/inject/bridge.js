/*
 * am-hook GUI 注入脚本。
 *
 * 由 GUI 的 WebView 在文档创建时注入，运行在 am-hook 页面里，做三件事：
 *   1. 提供 MpvEngine：用页面的 AmDecrypt 取流解密，把 fMP4 原样流式写进本机 bridge
 *      （bridge 再写进 mpv 的 stdin），进度、暂停、Seek、音量走 mpv 的 JSON IPC。
 *      transport 接口与页面自己的 PcmEngine 一致，播放器补丁可以直接替换。
 *   2. 给页面里的 AmPlayer 打补丁：设置里开启 mpv 输出时，播放交给 mpv，其余界面（播放条、
 *      队列、歌词、音质详情）保持原样；mpv 出错时自动退回浏览器自己的播放方式。
 *   3. 右下角的悬浮面板：切换输出、列音频设备、看 mpv 状态，以及打开 GUI 的设置窗口。
 *
 * 页面本身不需要任何修改，未做定制的 am-hook 实例也能用。
 */
(function () {
  'use strict';

  const GUI = window.__AM_HOOK_GUI__;
  if (!GUI || !GUI.bridge) return;
  if (window.__AM_HOOK_GUI_ACTIVE__) return;
  if (window.top !== window) return; // 只处理顶层文档
  if (location.hostname === 'tauri.localhost' || location.protocol === 'tauri:') return;
  window.__AM_HOOK_GUI_ACTIVE__ = true;

  const VERSION = GUI.version || '0.1.0';
  const BRIDGE = String(GUI.bridge).replace(/\/$/, '');
  const TOKEN = GUI.token || '';
  const HEADER = 'x-amhook-gui-token';

  /* ---------------- 基础工具 ---------------- */

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function url(path, params) {
    const target = new URL(path, BRIDGE);
    if (params) for (const key of Object.keys(params)) target.searchParams.set(key, params[key]);
    if (TOKEN) target.searchParams.set('token', TOKEN);
    return target.href;
  }

  async function request(path, options = {}) {
    const headers = Object.assign({ [HEADER]: TOKEN }, options.headers || {});
    // bridge 的 POST 都收 JSON；少了 content-type 会被 axum 以 415 拒绝
    if (options.body != null && !headers['content-type']) headers['content-type'] = 'application/json';
    const response = await fetch(url(path, options.query), {
      method: options.method || 'GET',
      headers,
      body: options.body,
      signal: options.signal,
      duplex: options.duplex,
      cache: 'no-store',
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      const message = (payload && (payload.msg || payload.error)) || `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return payload || {};
  }

  function log(...args) {
    if (window.__AM_HOOK_GUI_DEBUG__) console.log('[am-hook-gui]', ...args);
  }

  /* ---------------- 与 bridge 共用的状态 ---------------- */

  const state = {
    settings: GUI.settings || null,
    info: null,
    server: GUI.server || null,
    session: null,
    sessionState: null,
    devices: [],
    engines: new Set(),
    fingerprint: '',
    lastEvent: null,
    eventLog: [],
    serverAlive: true,
    serverMessage: null,
  };

  function mpvEnabled() {
    return !!(state.settings && state.settings.mpv && state.settings.mpv.enabled && state.info && state.info.found);
  }

  function mpvArgs() {
    return splitArgs((state.settings && state.settings.mpv && state.settings.mpv.extraArgs) || '');
  }

  /** 按空白拆开「额外参数」，支持单双引号（与 GUI 里的写法一致） */
  function splitArgs(text) {
    const out = [];
    let current = '';
    let quote = null;
    let started = false;
    for (const ch of String(text || '')) {
      if (quote) {
        if (ch === quote) quote = null;
        else current += ch;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
      if (/\s/.test(ch)) {
        if (started || current) { out.push(current); current = ''; started = false; }
        continue;
      }
      current += ch;
      started = true;
    }
    if (started || current) out.push(current);
    return out.filter((arg) => arg.length > 0).slice(0, 32);
  }

  /* ---------------- 事件流（窗口隐藏时也不依赖页面定时器） ---------------- */

  let source = null;
  let sourceRetry = 0;

  function connectEvents() {
    if (source) return;
    try {
      source = new EventSource(url('/events'));
    } catch {
      return;
    }
    note('eventsource created');
    source.onopen = () => { sourceRetry = 0; note('eventsource open'); };
    source.onmessage = (event) => {
      let payload = null;
      try { payload = JSON.parse(event.data); } catch { return; }
      handleEvent(payload);
    };
    source.onerror = () => {
      note(`eventsource error state=${source && source.readyState}`);
      // EventSource 自己会重连；连续失败太久就重建一次，避免卡在坏状态
      if (source && source.readyState === EventSource.CLOSED) {
        source = null;
        const delay = Math.min(5000, 500 * Math.pow(2, Math.min(sourceRetry++, 4)));
        setTimeout(connectEvents, delay);
      }
    };
  }

  function setFingerprint() {
    state.fingerprint = JSON.stringify({
      enabled: mpvEnabled(),
      device: state.settings && state.settings.mpv && state.settings.mpv.device,
      exclusive: state.settings && state.settings.mpv && state.settings.mpv.exclusive,
      args: state.settings && state.settings.mpv && state.settings.mpv.extraArgs,
      path: state.info && state.info.path,
    });
  }

  /** 设备 id → 友好的名字（查看 session 的实际输出设备） */
  function deviceName(id) {
    if (!id) return 'mpv 默认设备';
    if (id === 'auto') return '自动（跟随系统默认）';
    const device = state.devices.find((entry) => entry.id === id);
    return device ? (device.description || device.name || device.id) : id;
  }

  /* ---------------- 页面偏好（只为了“优先全景声”） ---------------- */

  const PAGE_PREFS_KEY = 'am-hook:settings';
  /** 我们改过页面 JOC 偏好时，把原来的值记在本地，页面重载后也能还原 */
  const JOC_RESTORE_KEY = 'am-hook:gui:joc-restore';

  function pagePrefs() {
    try {
      const raw = localStorage.getItem(PAGE_PREFS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return null;
    }
  }

  /** 写页面的 JOC 偏好并让页面的 prefs 模块重新读取（同标签页不会收到 storage 事件，手动补一个） */
  function setPageJocMode(mode) {
    const prefs = pagePrefs();
    if (!prefs) return false;
    const joc = Object.assign({ mode: 'off' }, prefs.joc || {});
    if (joc.mode === mode) return false;
    joc.mode = mode;
    prefs.joc = joc;
    const text = JSON.stringify(prefs);
    try {
      localStorage.setItem(PAGE_PREFS_KEY, text);
      window.dispatchEvent(new StorageEvent('storage', { key: PAGE_PREFS_KEY, newValue: text, storageArea: localStorage }));
    } catch (error) {
      log('cannot update page prefs', error);
      return false;
    }
    return true;
  }

  /**
   * mpv 输出时让页面把全景声排在 ALAC 前面。
   *
   * 页面自己的排序规则（rankVariant）只在「JOC 对象渲染」不是 off 时才首选 Atmos，而那项设置
   * 原本是给浏览器内渲染用的。这里在 mpv 模式下临时把它打开，只影响选音质；真正的解码仍然
   * 全部交给 mpv（页面不会加载 JOC 解码器）。关掉 mpv 或关闭「优先全景声」时还原。
   */
  function applyAtmosPreference() {
    const settings = state.settings && state.settings.mpv;
    const wanted = mpvEnabled() && !!(settings && settings.preferAtmos !== false);
    const prefs = pagePrefs();
    if (!prefs) return;
    const mode = (prefs.joc && prefs.joc.mode) || 'off';
    let restore = null;
    try { restore = localStorage.getItem(JOC_RESTORE_KEY); } catch {}
    if (wanted && mode === 'off') {
      // 正在放的已经是全景声就不用动，避免打断当前曲目
      const current = player && player.current;
      const playingEc3 = current && /^(ec-3|ec3)$/i.test(String(current.codecs));
      if (playingEc3) return;
      if (setPageJocMode('binaural')) {
        try { localStorage.setItem(JOC_RESTORE_KEY, 'off'); } catch {}
        note('page joc -> binaural (prefer atmos)');
      }
      return;
    }
    if (!wanted && restore && mode === 'binaural') {
      if (setPageJocMode(restore)) note('page joc restored');
      try { localStorage.removeItem(JOC_RESTORE_KEY); } catch {}
      return;
    }
    if (!wanted && restore && mode !== 'binaural') {
      // 用户自己改过了：尊重用户，不再还原
      try { localStorage.removeItem(JOC_RESTORE_KEY); } catch {}
    }
  }

  function note(entry) {
    state.eventLog.push(`${new Date().toISOString().slice(11, 23)} ${entry}`);
    if (state.eventLog.length > 80) state.eventLog.shift();
  }

  function handleEvent(payload) {
    if (!payload || !payload.type) return;
    state.lastEvent = payload.type;
    if (payload.type !== 'mpvState') note(`event ${payload.type}`);
    if (payload.type === 'hello') {
      state.settings = payload.settings || state.settings;
      state.info = payload.mpv || state.info;
      state.server = payload.server || state.server;
      setFingerprint();
      applyAtmosPreference();
      // 页面重新加载后，上一个文档留下的 mpv 会话（没人再喂数据、也没人管）直接停掉，
      // 否则它会把缓冲区里的音频放完，和新页面的声音叠在一起
      if (payload.session && state.engines.size === 0) {
        stopRemote(payload.session.id);
        state.session = null;
        state.sessionState = null;
        note(`stopped orphan session ${payload.session.id}`);
        payload = Object.assign({}, payload, { session: null });
      }
      if (payload.session) {
        state.session = payload.session.id;
        state.sessionState = payload.session.state;
        for (const engine of state.engines) {
          if (engine.session === state.session) engine.applyState(state.sessionState);
        }
      }
      renderPanel();
      return;
    }
    if (payload.type === 'config') {
      const before = state.fingerprint;
      state.settings = payload.settings || state.settings;
      setFingerprint();
      renderPanel();
      applyAtmosPreference();
      if (before !== state.fingerprint) {
        for (const engine of state.engines) engine.onSettingsChanged();
        syncOutputMode();
      }
      return;
    }
    if (payload.type === 'mpvState') {
      state.session = payload.session;
      state.sessionState = payload.state;
      for (const engine of state.engines) {
        if (engine.session === payload.session) engine.applyState(payload.state);
      }
      renderPanel();
      return;
    }
    if (payload.type === 'mpvEnded' || payload.type === 'mpvError') {
      for (const engine of state.engines) {
        if (engine.session === payload.session) {
          if (payload.type === 'mpvEnded') engine.handleEnded();
          else engine.fail(new Error(payload.message || 'mpv 出错'));
        }
      }
      renderPanel();
      return;
    }
    if (payload.type === 'server') {
      state.server = payload.url;
      renderPanel();
      return;
    }
    if (payload.type === 'serverStatus') {
      const wasAlive = state.serverAlive;
      state.serverAlive = payload.alive !== false;
      state.serverMessage = payload.message || null;
      note(`server ${state.serverAlive ? 'alive' : 'lost'}`);
      renderPanel();
      if (wasAlive && !state.serverAlive) state.eventLog.push('server connection lost');
      return;
    }
  }

  /* ---------------- mpv 播放引擎（transport 接口与页面的 PcmEngine 一致） ---------------- */

  class MpvEngine {
    constructor(onUpdate, onError, onEnded) {
      this.onUpdate = onUpdate;
      this.onError = onError;
      this.onEnded = onEnded;
      this.playlist = null;
      this.duration = 0;
      this.position = 0;
      this.paused = true;
      this.loadedUntil = 0;
      this.session = null;
      this.generation = 0;
      this.index = 0;
      this.ended = false;
      this.volume = 1;
      this.feedController = null;
      this.feedDone = false;
      this.stateSeq = 0;
      this.controller = null;
      state.engines.add(this);
    }

    get mode() { return 'mpv'; }

    get currentTime() { return Math.min(this.duration || Infinity, this.position); }

    set currentTime(value) { const pending = this.seek(value); if (pending) pending.catch(() => {}); }

    async load(m3u8Url) {
      const generation = this.generation;
      this.controller = new AbortController();
      if (!window.AmDecrypt || typeof window.AmDecrypt.openTrack !== 'function') {
        throw new Error('这个页面没有浏览器内解密（AmDecrypt），无法交给 mpv 播放');
      }
      this.playlist = await window.AmDecrypt.openTrack(m3u8Url, this.controller.signal);
      if (generation !== this.generation) throw new DOMException('stale', 'AbortError');
      this.duration = this.playlist.duration || 0;
      this.position = 0;
      this.index = 0;
      this.loadedUntil = 0;
    }

    async play() {
      if (!this.playlist) return;
      this.ended = false;
      if (!this.session) {
        await this.start(this.position || 0);
      } else {
        try { await request('/mpv/control', { method: 'POST', body: JSON.stringify({ session: this.session, command: 'resume' }) }); } catch (error) { this.fail(error); return; }
      }
      this.paused = false;
      this.onUpdate();
    }

    pause() {
      if (this.paused) return;
      this.paused = true;
      if (this.session) {
        request('/mpv/control', { method: 'POST', body: JSON.stringify({ session: this.session, command: 'pause' }) }).catch(() => {});
      }
      this.onUpdate();
    }

    async seek(time) {
      if (!this.playlist) return;
      const target = Math.max(0, Math.min(Number(time) || 0, this.duration || Infinity));
      this.position = target;
      this.ended = false;
      this.onUpdate();
      if (!this.session) { await this.start(target); return; }
      const session = this.session;
      const seq = this.stateSeq;
      try {
        await this.control('seek', target);
        if (await this.confirmSeek(target, session, seq)) return;
      } catch {}
      if (session === this.session) await this.start(target);
    }

    /**
     * 管道里没有目标位置的数据时 mpv 的 seek 会被忽略：确认一下位置真的到位。
     * 必须等到 seek 之后新收到的状态（seq 变化）再判断，不能拿 seek 时的乐观值骗自己。
     */
    async confirmSeek(target, session, seqBefore) {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await sleep(250);
        if (session !== this.session) return true;
        if (this.stateSeq > seqBefore && Math.abs(this.position - target) < 2.5) return true;
      }
      return false;
    }

    setVolume(volume) {
      this.volume = Math.max(0, Math.min(1, Number(volume) || 0));
      if (this.session) this.control('volume', Math.round(this.volume * 100)).catch(() => {});
    }

    /** 从 seconds 开始：起会话 → 喂 init 与后续分段 →（非 0 时）seek 到精确位置 */
    async start(seconds) {
      const generation = ++this.generation;
      await this.stopSession();
      this.paused = false;
      this.ended = false;
      this.feedDone = false;
      const segments = this.playlist ? this.playlist.segments : [];
      if (!segments.length) throw new Error('音轨里没有可播放的分段');
      this.index = segmentAt(segments, seconds);
      this.position = seconds;
      this.loadedUntil = segments[this.index] ? segments[this.index].time : seconds;
      const payload = await request('/mpv/play', {
        method: 'POST',
        body: JSON.stringify({ volume: Math.round(this.volume * 100), args: mpvArgs() }),
      });
      if (generation !== this.generation) {
        stopRemote(payload.session);
        return;
      }
      this.session = payload.session;
      // 新会话：丢掉上一个会话残留的状态，避免进度/编码显示成旧值
      state.session = payload.session;
      state.sessionState = null;
      note(`start session=${this.session} at=${seconds.toFixed(1)}s index=${this.index}`);
      this.feed(generation, seconds);
      this.onUpdate();
    }

    /**
     * 把 init 与从当前分段开始的数据依次 POST 给 bridge。
     *
     * 一段一次请求：WebView2 里流式上传请求体会失败（net::ERR_ALPN_NEGOTIATION_FAILED），
     * 普通 POST 稳定；每次都等 bridge 写完 mpv 的 stdin 再发下一段，所以背压照样成立。
     */
    feed(generation, seekTo) {
      const segments = this.playlist.segments;
      const init = this.playlist.init;
      const session = this.session;
      const controller = new AbortController();
      this.feedController = controller;
      note(`feed open session=${session}`);
      const post = async (path, body) => {
        const response = await fetch(url(path), { method: 'POST', body, signal: controller.signal });
        if (!response.ok) {
          const error = new Error(`bridge ${response.status}`);
          error.status = response.status;
          throw error;
        }
      };
      (async () => {
        try {
          const initBytes = await this.playlist.load(init, controller.signal);
          if (generation !== this.generation) return;
          note(`feed init ${(initBytes && (initBytes.byteLength || initBytes.length)) || 0}B`);
          await post(`/mpv/feed/${encodeURIComponent(session)}`, new Uint8Array(initBytes));
          let index = this.index;
          while (index < segments.length) {
            if (generation !== this.generation || this.session !== session) return;
            const piece = segments[index];
            index += 1;
            const bytes = await this.playlist.load(piece, controller.signal);
            if (generation !== this.generation || this.session !== session) return;
            if (bytes && (bytes.byteLength || bytes.length)) {
              await post(`/mpv/feed/${encodeURIComponent(session)}`, new Uint8Array(bytes));
            }
            this.loadedUntil = piece.time + piece.duration;
            this.onUpdate();
          }
          this.feedDone = true;
          note('feed complete');
          await post(`/mpv/feed/${encodeURIComponent(session)}/end`).catch(() => {});
        } catch (error) {
          if (error && error.name === 'AbortError') return;
          note(`feed error ${(error && error.name) || error}:${(error && error.message) || ''}`);
          if (generation === this.generation && !this.ended) this.fail(error);
        }
      })();
      if (seekTo > 0.05) {
        (async () => {
          for (let attempt = 0; attempt < 10; attempt += 1) {
            await sleep(300);
            if (generation !== this.generation || this.session !== session) return;
            try { await this.control('seek', seekTo); } catch { continue; }
            if (Math.abs(this.position - seekTo) < 2.5) return;
          }
        })();
      }
    }

    async control(command, value) {
      if (!this.session) return;
      await request('/mpv/control', {
        method: 'POST',
        body: JSON.stringify({ session: this.session, command, value }),
      });
    }

    applyState(payload) {
      if (!payload) return;
      this.stateSeq += 1;
      if (typeof payload.position === 'number' && Number.isFinite(payload.position)) this.position = payload.position;
      // mpv 的 duration 是“当前已解析出的时长”，会随着缓冲增长；播放列表的时长才是准的，
      // 只有在没有播放列表时长时才拿它兜底（否则 seek 会被截到已缓冲的位置）
      if (!(this.duration > 0) && typeof payload.duration === 'number' && payload.duration > 0) {
        this.duration = payload.duration;
      }
      if (typeof payload.paused === 'boolean') this.paused = payload.paused;
      if (payload.eof && !this.ended) { this.handleEnded(); return; }
      this.onUpdate();
    }

    handleEnded() {
      if (this.ended) return;
      this.ended = true;
      this.paused = true;
      this.position = this.duration || this.position;
      this.onUpdate();
      if (this.onEnded) this.onEnded();
    }

    fail(error) {
      if (this.ended) return;
      if (this.onError) this.onError(error);
    }

    onSettingsChanged() {
      // 设备、独占、额外参数变化：下一次起会话时生效，正在播放的不打断
    }

    get stats() {
      const payload = state.session === this.session ? state.sessionState : null;
      return {
        session: this.session,
        position: this.position,
        duration: this.duration,
        paused: this.paused,
        loadedUntil: this.loadedUntil,
        codec: payload && payload.codec,
        decoder: payload && payload.decoder,
        device: payload && payload.device,
        samplerate: payload && payload.samplerate,
        channels: payload && payload.channels,
        fed: payload && payload.fed,
        eof: payload && payload.eof,
      };
    }

    async stopSession(known) {
      if (this.feedController) {
        try { this.feedController.abort(); } catch {}
        this.feedController = null;
      }
      const session = known || this.session;
      this.session = null;
      this.feedDone = false;
      if (session) stopRemote(session);
    }

    destroy() {
      this.generation += 1;
      try { if (this.controller) this.controller.abort(); } catch {}
      if (this.feedController) { try { this.feedController.abort(); } catch {} this.feedController = null; }
      const session = this.session;
      this.session = null;
      state.engines.delete(this);
      if (session) stopRemote(session);
    }
  }

  function stopRemote(session) {
    if (!session) return;
    fetch(url(`/mpv/session/${encodeURIComponent(session)}`), { method: 'DELETE', headers: { [HEADER]: TOKEN } }).catch(() => {});
  }

  /** 目标时间所在分段的序号（与 player.js 的 segmentAt 相同） */
  function segmentAt(segments, time) {
    let low = 0;
    let high = segments.length - 1;
    let found = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (segments[mid].time <= time) { found = mid; low = mid + 1; }
      else high = mid - 1;
    }
    return Math.min(found, Math.max(0, segments.length - 1));
  }

  /* ---------------- 页面播放器补丁 ---------------- */

  let player = null;
  let patches = null;

  function installPatches(AmPlayer) {
    if (!AmPlayer || !AmPlayer.prototype || AmPlayer.prototype.__amgPatched) return null;
    const proto = AmPlayer.prototype;
    proto.__amgPatched = true;
    const original = {
      start: proto.start,
      transport: proto.transport,
      modeText: proto.modeText,
      setVolume: proto.setVolume,
      renderProgress: proto.renderProgress,
      renderQualityPanel: proto.renderQualityPanel,
    };

    proto.transport = function transport() {
      if (this.current && this.current.mode === 'mpv' && this.pcm) return this.pcm;
      return original.transport.call(this);
    };

    proto.modeText = function modeText() {
      if (this.current && this.current.mode === 'mpv') {
        const exclusive = state.settings && state.settings.mpv && state.settings.mpv.exclusive;
        return `mpv · WASAPI ${exclusive ? '独占' : '共享'}`;
      }
      return original.modeText.call(this);
    };

    proto.setVolume = function setVolume(volume) {
      const engine = this.pcm;
      if (engine && typeof engine.setVolume === 'function') {
        this.pcm = null;
        try { original.setVolume.call(this, volume); } finally { this.pcm = engine; }
        engine.setVolume(volume);
        return;
      }
      return original.setVolume.call(this, volume);
    };

    proto.renderProgress = function renderProgress() {
      original.renderProgress.call(this);
      if (this.current && this.current.mode === 'mpv' && this.pcm && this.pcm.loadedUntil) {
        const duration = this.duration();
        if (duration) {
          const width = Math.min(1, this.pcm.loadedUntil / duration) * 100;
          const bar = this.$('.seek-buffer');
          if (bar) bar.style.width = `${width}%`;
        }
      }
    };

    proto.renderQualityPanel = function renderQualityPanel() {
      const result = original.renderQualityPanel.apply(this, arguments);
      try {
        if (mpvEnabled() && this.qualityPanel && !this.qualityPanel.hidden) {
          for (const button of this.qualityPanel.querySelectorAll('.quality-option[disabled]')) {
            button.disabled = false;
            button.removeAttribute('title');
          }
        }
      } catch {}
      return result;
    };

    proto.start = function start(item, options) {
      const wantsMpv = mpvEnabled() && !this.__amgFallback;
      if (!wantsMpv) {
        // 切回浏览器输出：残留的 mpv 会话必须先停掉，否则两路同时出声
        if (this.pcm && typeof this.pcm.destroy === 'function') {
          try { this.pcm.destroy(); } catch {}
          this.pcm = null;
        }
        return original.start.call(this, item, options);
      }
      return startWithMpv(this, item, options || {}, original);
    };

    return original;
  }

  /** 用 mpv 播放一首：界面状态与页面自己的 start 一致，失败时退回原来的播放方式 */
  async function startWithMpv(target, item, options, original) {
    if (!item || !item.m3u8Url) return original.start.call(target, item, options);
    if (!options.force && target.current && target.current.id === item.id) {
      target.toggle();
      return;
    }
    const token = ++target.playToken;
    // 关键：先把页面自己的 MSE / Web Audio / <audio> 全部拆掉。
    // 否则上一首还在浏览器里放着，mpv 又开一路，两路声音会同时出现。
    try { target.teardown(); } catch (error) { log('teardown before mpv failed', error); }
    target.pcm = null;
    const resumeAt = target.current && target.current.track === item.track
      ? (target.transport() ? target.transport().currentTime : 0) : 0;
    target.current = Object.assign({}, item, { mode: 'mpv', duration: 0 });
    try {
      target.show();
      target.showError('');
      target.renderTrackText();
      target.renderArtwork(item);
      target.setLoading(true);
      target.emit();
      if (target.updateMediaSession) target.updateMediaSession();
      target.renderMode();
    } catch (error) {
      log('player ui update failed', error);
    }
    const engine = new MpvEngine(
      () => target.updatePcm(),
      (error) => {
        // mpv 会话出错：把错误显示出来，并从当前位置退回浏览器自己的播放方式
        log('mpv error', error);
        target.showError(String((error && error.message) || error));
        fallbackToBrowser(target, item, original);
      },
      () => target.ended(),
    );
    target.pcm = engine;
    if (target.audio) engine.setVolume(target.audio.volume);
    try {
      await engine.load(item.m3u8Url);
      if (token !== target.playToken) { engine.destroy(); return; }
      target.current.duration = engine.duration;
      if (resumeAt > 0.1) await engine.seek(resumeAt);
      await engine.play();
      target.setLoading(false);
      target.renderProgress();
      if (target.prepareNext) target.prepareNext();
    } catch (error) {
      log('mpv start failed', error);
      target.showError(String((error && error.message) || error));
      target.pcm = null;
      engine.destroy();
      await fallbackToBrowser(target, item, original);
    }
  }

  async function fallbackToBrowser(target, item, original) {
    if (target.__amgFallback) return;
    target.__amgFallback = true;
    try {
      // 回退之前先把 mpv 关掉，不能让它继续在后台出声
      if (target.pcm && typeof target.pcm.destroy === 'function') {
        try { target.pcm.destroy(); } catch {}
        target.pcm = null;
      }
      await original.start.call(target, item, { force: true });
    } catch (error) {
      log('browser fallback failed', error);
    } finally {
      target.__amgFallback = false;
    }
  }

  /** 设置里的输出方式变了：按新方式从当前位置重播当前曲目 */
  function syncOutputMode() {
    if (!player || !player.current || player.attempting) return;
    const wantsMpv = mpvEnabled();
    const isMpv = player.current.mode === 'mpv';
    if (wantsMpv === isMpv) return;
    if (player.__amgSwitching) return;
    player.__amgSwitching = true;
    const at = player.transport() ? player.transport().currentTime : 0;
    player.replay().then(() => {
      if (at > 0) {
        try { player.transport().currentTime = at; } catch {}
      }
    }).catch(() => {}).finally(() => {
      player.__amgSwitching = false;
    });
  }

  /* ---------------- 右下角面板 ---------------- */

  const ICON_NOTE = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9 18a3 3 0 1 1-2-2.83V5.6l11-2.2v10.77a3 3 0 1 1-2-2.83V6.4L9 8.1z"/></svg>';

  const PANEL_STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif; }
    .wrap { position: fixed; right: 18px; bottom: 96px; z-index: 2147483000; display: flex; flex-direction: column; align-items: flex-end; gap: 10px; }
    .bubble { width: 34px; height: 34px; border-radius: 50%; border: 1px solid rgba(17,24,39,.12); background: rgba(255,255,255,.96); color: #0d9488; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 6px 18px rgba(17,24,39,.14); transition: transform .15s ease, box-shadow .15s ease; }
    .bubble:hover { transform: translateY(-1px); box-shadow: 0 10px 24px rgba(17,24,39,.18); }
    .bubble[data-on="true"] { color: #0b8378; border-color: rgba(13,148,136,.4); }
    .panel { width: 322px; max-height: 78vh; overflow-y: auto; border-radius: 14px; border: 1px solid rgba(17,24,39,.1); background: #ffffff; color: #1b1f2a; box-shadow: 0 20px 48px rgba(17,24,39,.16); padding: 14px 14px 12px; display: none; }
    .panel[data-open="true"] { display: block; }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .title { font-size: 13px; font-weight: 600; letter-spacing: .2px; }
    .badge { font-size: 10px; padding: 2px 6px; border-radius: 999px; background: rgba(13,148,136,.1); color: #0b7f74; }
    .spacer { flex: 1; }
    .toptools { position: fixed; top: 8px; left: 10px; z-index: 2147483002; display: flex; gap: 6px; }
    .toptools button { width: 28px; height: 28px; border-radius: 9px; border: 1px solid rgba(17,24,39,.13); background: rgba(255,255,255,.92); color: #3c4250; font-size: 15px; line-height: 1; cursor: pointer; padding: 0; box-shadow: 0 2px 6px rgba(17,24,39,.08); backdrop-filter: blur(6px); }
    .toptools button:hover { background: #fff; color: #0b7f74; }
    .toptools button:disabled { opacity: .38; cursor: default; }
    .close { border: none; background: transparent; color: #8a90a1; cursor: pointer; font-size: 15px; line-height: 1; padding: 2px 4px; }
    .close:hover { color: #1b1f2a; }
    .row { display: flex; align-items: center; gap: 8px; margin: 8px 0 6px; font-size: 12px; }
    .row > label { flex: 1; color: #5b6273; }
    select, .args { width: 100%; background: #fff; color: #1b1f2a; border: 1px solid rgba(17,24,39,.16); border-radius: 8px; padding: 6px 8px; font-size: 12px; outline: none; }
    select:focus, .args:focus { border-color: rgba(13,148,136,.55); box-shadow: 0 0 0 3px rgba(13,148,136,.1); }
    .args { font-family: ui-monospace, "Cascadia Mono", monospace; }
    .switch { position: relative; width: 38px; height: 21px; border-radius: 999px; background: #d6dae4; cursor: pointer; transition: background .18s ease; flex: none; }
    .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 17px; height: 17px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(17,24,39,.25); transition: transform .18s ease; }
    .switch[data-on="true"] { background: linear-gradient(140deg, #12b3a2, #0b8378); }
    .switch[data-on="true"]::after { transform: translateX(17px); }
    .status { margin-top: 10px; padding: 8px 10px; border-radius: 10px; background: #f6f7fb; border: 1px solid rgba(17,24,39,.07); font-size: 11px; line-height: 1.65; color: #5b6273; white-space: pre-wrap; word-break: break-all; }
    .status b { color: #1b1f2a; font-weight: 600; }
    .buttons { display: flex; gap: 8px; margin-top: 10px; }
    button.action { flex: 1; border: 1px solid rgba(17,24,39,.16); background: #fff; color: #1b1f2a; border-radius: 8px; padding: 7px 8px; font-size: 11.5px; cursor: pointer; }
    button.action:hover { background: #f2f4f8; }
    button.action.primary { border-color: rgba(13,148,136,.4); color: #0b7f74; background: rgba(13,148,136,.08); }
    button.action.primary:hover { background: rgba(13,148,136,.14); }
    .hint { margin-top: 8px; font-size: 10.5px; color: #8a90a1; line-height: 1.5; }
    .hidden { display: none !important; }
    .more { margin: 6px 0 2px; }
    .more > summary { cursor: pointer; color: #5b6273; font-size: 11.5px; padding: 3px 0; list-style: none; user-select: none; }
    .more > summary::-webkit-details-marker { display: none; }
    .more > summary::before { content: "▸ "; }
    .more[open] > summary::before { content: "▾ "; }
    .more[open] { border-top: 1px solid rgba(17,24,39,.08); margin-top: 8px; padding-top: 4px; }
    .field { display: flex; gap: 6px; align-items: center; }
    .field .action { flex: none; padding: 6px 10px; }
    .banner { position: fixed; top: 14px; left: 50%; transform: translateX(-50%) translateY(-12px); display: none; align-items: center; gap: 10px; max-width: min(720px, 90vw); padding: 9px 12px 9px 16px; border-radius: 999px; border: 1px solid rgba(208,69,69,.35); background: #fff5f5; color: #a32f2f; font-size: 12.5px; box-shadow: 0 14px 36px rgba(17,24,39,.16); z-index: 2147483001; }
    .banner[data-show="true"] { display: flex; animation: banner-in .18s ease forwards; }
    @keyframes banner-in { to { transform: translateX(-50%) translateY(0); } }
    .banner-text { max-width: 460px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .banner-button { border: 1px solid rgba(208,69,69,.4); background: #fff; color: #a32f2f; border-radius: 999px; padding: 4px 12px; font-size: 12px; cursor: pointer; flex: none; }
    .banner-button:hover { background: #ffecec; }
    .banner-close { border: none; background: transparent; color: #c07373; font-size: 15px; line-height: 1; cursor: pointer; padding: 0 4px; flex: none; }
  `;

  let panelParts = null;

  function ensurePanel() {
    if (panelParts) return panelParts;
    const host = document.createElement('div');
    host.id = 'am-hook-gui-panel';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PANEL_STYLE;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = `
      <div class="panel" data-open="false">
        <div class="head">
          <span class="title">am-hook GUI</span>
          <span class="badge">v${VERSION}</span>
          <span class="spacer"></span>
          <button class="close" title="关闭">×</button>
        </div>
        <div class="row">
          <label>MPV 输出</label>
          <div class="switch" data-role="enable" data-on="false"></div>
        </div>
        <div class="row"><label>音频设备</label></div>
        <select data-role="device"></select>
        <div class="row">
          <label>WASAPI 独占</label>
          <div class="switch" data-role="exclusive" data-on="false"></div>
        </div>
        <div class="row">
          <label>优先 Dolby Atmos</label>
          <div class="switch" data-role="prefer-atmos" data-on="true"></div>
        </div>
        <details class="more">
          <summary>mpv 设置</summary>
          <div class="row"><label>mpv 可执行文件</label></div>
          <div class="field">
            <input class="args" data-role="mpv-path" spellcheck="false" placeholder="留空自动查找 mpv.exe" />
            <button class="action" data-role="browse-exe">选择…</button>
          </div>
          <div class="row"><label>配置目录</label></div>
          <div class="field">
            <input class="args" data-role="mpv-config" spellcheck="false" placeholder="放 mpv.conf 的目录" />
            <button class="action" data-role="browse-config">选择…</button>
          </div>
          <div class="row"><label>额外参数</label></div>
          <input class="args" data-role="args" spellcheck="false" placeholder="--cache-secs=20" />
          <div class="hint">配置目录以 --config-dir 传给 mpv，与该目录里 mpv.conf 的选项一起生效；额外参数是附加，不会替换上面的选项。</div>
        </details>
        <div class="status" data-role="status">正在连接…</div>
        <div class="buttons">
          <button class="action" data-role="refresh">刷新设备</button>
          <button class="action" data-role="probe">重新检测</button>
          <button class="action primary" data-role="settings">打开设置</button>
        </div>
        <div class="hint">Alt+M 显示 / 隐藏此面板。这里的改动会保存到 GUI 设置。</div>
      </div>
      <div class="bubble" data-on="false" data-role="toggle" title="am-hook GUI（Alt+M）">${ICON_NOTE}</div>
      <div class="banner" data-show="false">
        <span class="banner-text" data-role="banner-text">与 am-hook 服务器的连接已断开</span>
        <button class="banner-button" data-role="banner-retry">重试</button>
        <button class="banner-close" data-role="banner-close">×</button>
      </div>
    `;
    const root = shadow;
    const tools = document.createElement('div');
    tools.className = 'toptools';
    tools.innerHTML = `
      <button data-role="top-back" title="后退">←</button>
      <button data-role="top-forward" title="前进">→</button>
    `;
    root.append(style, tools, wrap);
    // 侧栏整体让出左上角这一条：页面自己的 logo 往下挪，按钮就不会压住它
    if (!document.getElementById('am-hook-gui-nav-offset')) {
      const offset = document.createElement('style');
      offset.id = 'am-hook-gui-nav-offset';
      offset.textContent = '#nav { padding-top: 46px !important; }';
      document.head.append(offset);
    }
    const panel = wrap.querySelector('.panel');
    // 必须按 data-role 取，不能用 .bubble：样式类可能先命中别的元素
    const bubble = wrap.querySelector('[data-role="toggle"]');
    const parts = {
      host,
      panel,
      bubble,
      enable: wrap.querySelector('[data-role="enable"]'),
      device: wrap.querySelector('[data-role="device"]'),
      exclusive: wrap.querySelector('[data-role="exclusive"]'),
      preferAtmos: wrap.querySelector('[data-role="prefer-atmos"]'),
      args: wrap.querySelector('[data-role="args"]'),
      mpvPath: wrap.querySelector('[data-role="mpv-path"]'),
      mpvConfig: wrap.querySelector('[data-role="mpv-config"]'),
      browseExe: wrap.querySelector('[data-role="browse-exe"]'),
      browseConfig: wrap.querySelector('[data-role="browse-config"]'),
      probe: wrap.querySelector('[data-role="probe"]'),
      status: wrap.querySelector('[data-role="status"]'),
      banner: wrap.querySelector('.banner'),
      bannerText: wrap.querySelector('[data-role="banner-text"]'),
      bannerRetry: wrap.querySelector('[data-role="banner-retry"]'),
      bannerClose: wrap.querySelector('[data-role="banner-close"]'),
      refresh: wrap.querySelector('[data-role="refresh"]'),
      settings: wrap.querySelector('[data-role="settings"]'),
      close: wrap.querySelector('.close'),
      topBack: shadow.querySelector('[data-role="top-back"]'),
      topForward: shadow.querySelector('[data-role="top-forward"]'),
    };
    panelParts = parts;

    bubble.addEventListener('click', () => togglePanel());
    parts.close.addEventListener('click', () => togglePanel(false));
    parts.enable.addEventListener('click', () => patchSettings({ enabled: !mpvEnabled() }));
    parts.exclusive.addEventListener('click', () => {
      const current = !!(state.settings && state.settings.mpv && state.settings.mpv.exclusive);
      patchSettings({ exclusive: !current });
    });
    parts.device.addEventListener('change', () => patchSettings({ device: parts.device.value }));
    parts.preferAtmos.addEventListener('click', () => {
      const current = !!(state.settings && state.settings.mpv && state.settings.mpv.preferAtmos !== false);
      patchSettings({ preferAtmos: !current });
    });
    parts.args.addEventListener('change', () => patchSettings({ extraArgs: parts.args.value.trim() }));
    parts.refresh.addEventListener('click', () => loadDevices(true));
    parts.probe.addEventListener('click', () => probeMpv());
    parts.mpvPath.addEventListener('change', () => patchSettings({ path: parts.mpvPath.value.trim() }));
    parts.mpvConfig.addEventListener('change', () => patchSettings({ configFile: parts.mpvConfig.value.trim() || null }));
    parts.browseExe.addEventListener('click', () => browseFor('exe', parts.mpvPath));
    parts.browseConfig.addEventListener('click', () => browseFor('config', parts.mpvConfig));
    parts.settings.addEventListener('click', () => postUi('openSettings'));
    parts.topBack.addEventListener('click', () => goBack());
    parts.topForward.addEventListener('click', () => goForward());
    parts.bannerRetry.addEventListener('click', () => postUi('reconnect'));
    parts.bannerClose.addEventListener('click', () => { parts.banner.dataset.show = 'false'; });
    document.documentElement.append(host);
    renderPanel();
    return parts;
  }

  /**
   * 前进 / 后退按钮始终可点。
   *
   * 单页应用里 pushState 不触发任何事件，按 history.length 判断“能否后退”只会在打开面板时
   * 算一次，之后一直停在灰色状态，点击被 disabled 吞掉。没有历史时点一下本来也不会发生什么，
   * 保持可点更稳。
   */
  function syncNavButtons() {
    if (!panelParts) return;
    if (panelParts.topBack) panelParts.topBack.disabled = false;
    if (panelParts.topForward) panelParts.topForward.disabled = false;
  }

  function togglePanel(force) {
    const parts = ensurePanel();
    const open = force === undefined ? parts.panel.dataset.open !== 'true' : !!force;
    parts.panel.dataset.open = String(open);
    syncNavButtons();
    if (open) {
      renderPanel();
      loadDevices(false);
    }
  }

  async function loadDevices(refresh) {
    const parts = panelParts;
    if (!parts) return;
    try {
      const payload = await request('/mpv/devices', { query: refresh ? { refresh: 'true' } : undefined });
      const current = (state.settings && state.settings.mpv && state.settings.mpv.device) || '';
      const options = ['<option value="">（mpv 默认设备）</option>'];
      for (const device of payload.devices || []) {
        const label = escapeHtml(device.description || device.name || device.id);
        options.push(`<option value="${escapeHtml(device.id)}">${label}</option>`);
      }
      state.devices = payload.devices || [];
      if (current && !state.devices.some((device) => device.id === current)) {
        options.push(`<option value="${escapeHtml(current)}">${escapeHtml(current)}（当前设置，未在列表里）</option>`);
      }
      parts.device.innerHTML = options.join('');
      parts.device.value = current;
      renderPanel();
      if (payload.mpv) state.info = payload.mpv;
    } catch (error) {
      parts.device.innerHTML = `<option value="">读取设备失败：${escapeHtml(String(error.message || error))}</option>`;
    }
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  /** 选本地文件：页面在远程 origin 上开不了系统对话框，由 bridge 转给 GUI */
  async function browseFor(kind, input) {
    const parts = ensurePanel();
    try {
      const payload = await request('/mpv/browse', { method: 'POST', body: JSON.stringify({ kind }) });
      const path = payload && payload.path;
      if (!path) return;
      input.value = path;
      await patchSettings(kind === 'config' ? { configFile: path } : { path });
      parts.status.textContent = kind === 'config' ? `已设置配置目录：${path}` : `已设置 mpv：${path}`;
    } catch (error) {
      parts.status.textContent = `选择文件失败：${(error && error.message) || error}`;
    }
  }

  /** 重新检测 mpv（换了路径以后不用重启客户端） */
  async function probeMpv() {
    try {
      const payload = await request('/mpv/probe', { method: 'POST' });
      if (payload && payload.mpv) state.info = payload.mpv;
      renderPanel();
      loadDevices(true);
    } catch (error) {
      if (panelParts) panelParts.status.textContent = `检测失败：${(error && error.message) || error}`;
    }
  }

  async function patchSettings(patch) {
    try {
      const payload = await request('/config', { method: 'POST', body: JSON.stringify({ mpv: patch }) });
      if (payload && payload.mpv) state.info = payload.mpv;
      if (payload && payload.settings) {
        const before = state.fingerprint;
        state.settings = payload.settings;
        setFingerprint();
        renderPanel();
        applyAtmosPreference();
        if (before !== state.fingerprint) syncOutputMode();
      }
    } catch (error) {
      const parts = ensurePanel();
      parts.status.textContent = `保存设置失败：${error.message || error}`;
    }
  }

  async function postUi(action) {
    try {
      await request('/ui', { method: 'POST', body: JSON.stringify({ action }) });
    } catch (error) {
      log('ui action failed', action, error);
    }
  }

  function renderPanel() {
    if (!panelParts) return;
    const parts = panelParts;
    const settings = (state.settings && state.settings.mpv) || {};
    const enabled = mpvEnabled();
    parts.enable.dataset.on = String(!!settings.enabled);
    parts.exclusive.dataset.on = String(!!settings.exclusive);
    parts.preferAtmos.dataset.on = String(settings.preferAtmos !== false);
    parts.bubble.dataset.on = String(enabled);
    if (document.activeElement !== parts.args) parts.args.value = settings.extraArgs || '';
    // 只显示「用户自己指定」的路径；自动找到的路径不写进输入框
    if (parts.mpvPath && document.activeElement !== parts.mpvPath) {
      parts.mpvPath.value = settings.path || '';
    }
    if (parts.mpvConfig && document.activeElement !== parts.mpvConfig) {
      parts.mpvConfig.value = settings.configFile || '';
    }
    const info = state.info || {};
    const engine = Array.from(state.engines)[0];
    const lines = [];
    if (!info.found) {
      lines.push('<b>没有找到 mpv</b>：展开「mpv 设置」选择 mpv.exe，或在设置窗口里指定路径');
    } else {
      const howFound = settings.path ? '已指定' : '自动查找';
      lines.push(`mpv：<b>${escapeHtml(shorten(info.version || '已找到', 40))}</b>（${howFound}）`);
    }
    if (engine && engine.session) {
      const stats = engine.stats || {};
      const codec = stats.codec ? String(stats.codec).toUpperCase() : '—';
      const rate = stats.samplerate ? `${stats.samplerate / 1000} kHz` : '';
      const channels = stats.channels ? `${stats.channels} ch` : '';
      const pos = formatTime(stats.position || 0);
      const total = stats.duration ? formatTime(stats.duration) : '—';
      lines.push(`状态：<b>${stats.paused ? '暂停' : '播放中'}</b> ${pos} / ${total}`);
      lines.push(`格式：<b>${escapeHtml(codec)}</b> ${escapeHtml([rate, channels].filter(Boolean).join(' · '))}`);
      if (stats.device) {
        lines.push(`输出：<b>${escapeHtml(deviceName(stats.device))}</b>${settings.exclusive ? '（WASAPI 独占）' : ''}`);
        const pageAudible = player && player.audio && !player.audio.paused && !player.audio.ended;
        if (pageAudible) lines.push('注意：页面自己的播放器仍在发声（应当已经停下）');
      }
      const fed = stats.fed ? `${(stats.fed / 1048576).toFixed(1)} MB` : '—';
      lines.push(`已送入 mpv：${fed}${stats.eof ? '（已到结尾）' : ''}`);
    } else if (enabled) {
      lines.push('状态：等待播放');
    } else {
      lines.push('状态：当前使用页面自己的输出（浏览器解码）');
    }
    parts.status.innerHTML = lines.join('\n');
    // 服务器掉线时在页面顶部显示提示与「重试」
    if (parts.banner) {
      const lost = state.serverAlive === false;
      parts.banner.dataset.show = String(lost);
      if (lost) {
        parts.bannerText.textContent = state.serverMessage
          ? `与 am-hook 服务器的连接已断开：${state.serverMessage}`
          : '与 am-hook 服务器的连接已断开';
      }
    }
    if (parts.device.options.length <= 1) loadDevices(false);
  }

  function shorten(text, length) {
    const value = String(text || '');
    return value.length > length ? `${value.slice(0, length - 1)}…` : value;
  }

  function formatTime(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(value / 60);
    return `${minutes}:${String(value % 60).padStart(2, '0')}`;
  }

  /* ---------------- 启动：等页面把播放器与解密库准备好 ---------------- */

  let bootAttempts = 0;

  function boot() {
    if (!document.documentElement) {
      setTimeout(boot, 30);
      return;
    }
    const hooks = window.AmHook;
    const app = window.AmApp;
    if (!hooks || !hooks.AmPlayer) {
      if (bootAttempts++ < 300) {
        setTimeout(boot, 100);
        return;
      }
      log('am-hook player api not found');
      return;
    }
    if (!patches) patches = installPatches(hooks.AmPlayer);
    if (app && app.player) {
      player = app.player;
      showBubble();
    } else if (bootAttempts++ < 300) {
      setTimeout(boot, 100);
      return;
    }
    if (patches) log('player patched for mpv output');
  }

  function showBubble() {
    try { ensurePanel(); } catch (error) { log('panel failed', error); }
  }

  /** 像浏览器一样后退 / 前进（am-hook 是单页应用，history 是完整的） */
  function goBack() {
    try { history.back(); } catch (error) { log('history.back failed', error); }
  }

  function goForward() {
    try { history.forward(); } catch (error) { log('history.forward failed', error); }
  }

  window.addEventListener('popstate', () => syncNavButtons());
  window.addEventListener('hashchange', () => syncNavButtons());

  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey) return;
    if (event.altKey && (event.key === 'm' || event.key === 'M')) {
      event.preventDefault();
      togglePanel();
      return;
    }
  }, true);

  connectEvents();
  boot();

  /* ---------------- 调试入口（自动化测试用） ---------------- */

  const api = Object.assign({}, GUI, {
    version: VERSION,
    openPanel: (open) => togglePanel(open),
    setEnabled: (enabled) => patchSettings({ enabled: !!enabled }),
    enable: () => patchSettings({ enabled: true }),
    disable: () => patchSettings({ enabled: false }),
    diag: () => ({
      source: source ? source.readyState : null,
      lastEvent: state.lastEvent,
      log: state.eventLog.slice(),
      settings: state.settings,
      info: state.info,
      engines: state.engines.size,
      patched: !!patches,
    }),
    snapshot: () => ({
      settings: state.settings,
      info: state.info,
      session: state.session,
      sessionState: state.sessionState,
      engines: Array.from(state.engines).map((engine) => engine.stats),
      enabled: mpvEnabled(),
      patched: !!patches,
    }),
  });
  // 用 defineProperty：Object.assign 会把 getter 立刻求值，拿到的就是过期快照
  Object.defineProperty(api, 'ready', { get: () => !!patches, configurable: true });
  Object.defineProperty(api, 'state', {
    get: () => ({
      settings: state.settings,
      info: state.info,
      session: state.session,
      sessionState: state.sessionState,
      engines: Array.from(state.engines).map((engine) => engine.stats),
      enabled: mpvEnabled(),
      patched: !!patches,
    }),
    configurable: true,
  });
  window.__AM_HOOK_GUI__ = api;
})();
