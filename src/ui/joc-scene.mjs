/*
 * 空间声场（双耳 JOC 渲染的交互界面，播放器的 openSpatial 按需加载）。
 *
 * 画布上是一个虚拟头部与 Dolby Atmos 码流里的 15 个对象（OAMD 位置，光球大小随电平），听到的方向就是看到的方向：
 *   - 拖动转头（左右 / 俯仰），渲染器按新的朝向重算每个对象的 HRTF 与房间反射，约 0.1 秒后听到；
 *   - 漫步：在房间里走动（拖动或 W A S D），对象留在原处，走近变响，反射随站位变化；
 *   - 点光球（或下方的对象条）独奏 / 静音；聚焦让面朝的对象更响；高度放大仰角；巡游让头部缓缓转一圈；
 *   - 第一人称视角从头部看出去；手机上可以用陀螺仪转头。
 * 控制项存在播放器（player.spatial）里，由 JocLiveEngine 交给 Worker；场景数据（位置与电平）按播放时间从引擎取（sceneAt）。
 *
 * 坐标：ADM 方向（+X 右、+Y 前、+Z 上），单位米；对象位于 ADM 位置 × 2.19 m（渲染器 mid 档的距离），听者站在原点 + 站位。
 */
const { AmI18n } = window;
const { t } = AmI18n;

/** 渲染器 mid 档：ADM 半径 1 对应的距离（crates/joc-core 的 DISTANCE_M[1]） */
const MIX_RADIUS = 2.19327927;
const OBJECTS = 15;
const TRAIL = 40;
const HEAD_RADIUS = 0.32;
/** 地面在耳朵下方的高度（米）：网格、方位字与对象的投影画在这里 */
const FLOOR = -1.3;
/** 光球在屏幕上的最大半径（第一人称时近处的对象不至于铺满画面） */
const MAX_ORB = 64;
const PITCH_LIMIT = 1.3;
const WALK_LIMIT = 6;
/** 巡游：每秒转过的弧度 */
const TOUR_SPEED = 0.4;
const TAU = Math.PI * 2;
/** 画布不认 CSS 变量：与 app.css 的 --font 相同的字体 */
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI", Arial, "PingFang SC", "Microsoft YaHei", sans-serif';

let current = null;

/** 打开声场界面；已经打开时把焦点移回去 */
export function open(player) {
  if (current) { current.root.focus(); return current; }
  current = new SpatialScene(player);
  return current;
}

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) if (child != null) node.append(child);
  return node;
}

function button(className, text, title) {
  const node = el('button', className, text);
  node.type = 'button';
  if (title) node.title = title;
  return node;
}

/** 第 i 个对象的颜色（色相均分，LFE 为暖白） */
function hue(index) { return index === 0 ? 40 : ((index - 1) * 24 + 200) % 360; }

function clamp(value, low, high) { return Math.min(high, Math.max(low, value)); }

/** 头部朝向（左转 yaw、抬头 pitch）的面向与右手方向 */
function headAxes(yaw, pitch) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return {
    face: [-sy * cp, cy * cp, sp],
    right: [cy, sy, 0],
    up: [sy * sp, -cy * sp, cp],
  };
}

/** 头部局部坐标（右、前、上）→ 世界坐标 */
function headPoint(axes, origin, local) {
  const out = [origin[0], origin[1], origin[2]];
  for (let k = 0; k < 3; k++) out[k] += axes.right[k] * local[0] + axes.face[k] * local[1] + axes.up[k] * local[2];
  return out;
}

class SpatialScene {
  constructor(player) {
    this.player = player;
    this.engine = null;
    this.state = player.spatial;
    this.view = 'orbit';
    /** 俯瞰视角的相机：绕听者的方位角（0 在身后）、俯角与距离 */
    this.camera = { yaw: 0, pitch: 0.62, distance: window.innerWidth < 600 ? 7.5 : 9.5, fov: 1.0 };
    this.tour = false;
    this.walk = false;
    this.gyro = null;
    this.pointers = new Map();
    this.gesture = null;
    this.hover = -1;
    this.keys = new Set();
    /** 每个对象显示用的位置（平滑过）、电平与轨迹 */
    this.objects = Array.from({ length: OBJECTS }, () => ({ pos: null, target: null, level: 0, trail: [] }));
    this.lfe = 0;
    this.lastScene = null;
    this.dirty = false;
    this.last = performance.now();
    this.build();
    this.unsubscribe = player.onSpatial((state) => { this.state = state; this.renderMixer(); this.renderReadout(); });
    // 键盘只在声场里处理（焦点在对话框内），处理过的键不再传给播放器的快捷键；空格等照常播放 / 暂停
    this.root.addEventListener('keydown', (e) => this.keyDown(e));
    this.root.addEventListener('keyup', (e) => this.keys.delete(e.code));
    this.root.addEventListener('focusout', () => { if (!this.root.contains(document.activeElement)) this.keys.clear(); });
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(this.canvas);
    this.previousFocus = document.activeElement;
    document.body.append(this.root);
    this.root.focus();
    this.fit();
    this.frame = requestAnimationFrame((time) => this.tick(time));
  }

  build() {
    const root = el('div', 'joc-scene');
    root.tabIndex = -1;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', t('scene.title'));
    this.root = root;

    this.canvas = el('canvas', 'joc-scene-canvas');
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', t('scene.hint'));
    this.ctx = this.canvas.getContext('2d');
    this.bindPointer();

    this.status = el('span', 'joc-scene-status');
    const close = button('joc-scene-close', '', t('scene.close'));
    close.setAttribute('aria-label', t('scene.close'));
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    close.addEventListener('click', () => this.close());
    const top = el('header', 'joc-scene-top', el('h2', 'joc-scene-title', t('scene.title')), this.status, close);

    this.message = el('p', 'joc-scene-message');
    this.message.hidden = true;

    this.mixer = el('div', 'joc-scene-mixer');
    this.mixer.setAttribute('role', 'group');
    this.mixerItems = [];
    for (let index = 0; index <= OBJECTS; index++) {
      const name = index === 0 ? t('scene.lfe') : String(index);
      const meter = el('span', 'joc-scene-meter', el('span', 'joc-scene-meter-fill'));
      const solo = button('joc-scene-chip-solo', 'S', t('scene.solo'));
      const mute = button('joc-scene-chip-mute', 'M', t('scene.mute'));
      solo.setAttribute('aria-label', `${index === 0 ? name : t('scene.object', { n: index })} · ${t('scene.solo')}`);
      mute.setAttribute('aria-label', `${index === 0 ? name : t('scene.object', { n: index })} · ${t('scene.mute')}`);
      solo.addEventListener('click', () => this.toggle('solo', index));
      mute.addEventListener('click', () => this.toggle('mute', index));
      const chip = el('div', 'joc-scene-chip', meter, el('span', 'joc-scene-chip-name', name), solo, mute);
      chip.style.setProperty('--chip-hue', hue(index));
      chip.addEventListener('pointerenter', () => { this.hover = index - 1; });
      chip.addEventListener('pointerleave', () => { this.hover = -1; });
      this.mixer.append(chip);
      this.mixerItems.push({ chip, meter: meter.firstChild, solo, mute });
    }

    this.viewButtons = {};
    const views = el('div', 'joc-scene-segment');
    views.setAttribute('role', 'radiogroup');
    for (const [view, key] of [['orbit', 'scene.viewOrbit'], ['first', 'scene.viewFirst']]) {
      const option = button('joc-scene-segment-option', t(key));
      option.setAttribute('role', 'radio');
      option.addEventListener('click', () => this.setView(view));
      this.viewButtons[view] = option;
      views.append(option);
    }

    this.tourButton = this.toggleButton(t('scene.tour'), t('scene.tourTip'), () => { this.tour = !this.tour; this.renderToggles(); });
    this.walkButton = this.toggleButton(t('scene.walk'), t('scene.walkTip'), () => { this.walk = !this.walk; this.renderToggles(); });
    const toggles = [this.tourButton, this.walkButton];
    if ('DeviceOrientationEvent' in window && window.matchMedia('(pointer: coarse)').matches) {
      this.gyroButton = this.toggleButton(t('scene.gyro'), t('scene.gyroTip'), () => this.toggleGyro());
      toggles.push(this.gyroButton);
    }

    this.focusSlider = this.slider(t('scene.focus'), t('scene.focusTip'), 0, 1, 0.05, (value) => this.update({ focus: value }));
    this.heightSlider = this.slider(t('scene.height'), t('scene.heightTip'), 1, 3, 0.1, (value) => this.update({ height: value }));

    const reset = button('joc-scene-action', t('scene.reset'));
    reset.addEventListener('click', () => this.resetPose());
    const restore = button('joc-scene-action', t('scene.restore'));
    restore.addEventListener('click', () => this.update({ solo: [], mute: [] }));
    this.readout = el('span', 'joc-scene-readout');

    const controls = el('div', 'joc-scene-controls',
      views, ...toggles, this.focusSlider.root, this.heightSlider.root, reset, restore, this.readout);
    const touch = window.matchMedia('(pointer: coarse)').matches;
    const hint = el('p', 'joc-scene-hint', t(touch ? 'scene.hintTouch' : 'scene.hint'), ' ', el('span', 'joc-scene-notice', t('scene.notice')));
    root.append(this.canvas, top, this.message, el('footer', 'joc-scene-bottom', this.mixer, controls, hint));
    this.renderToggles();
    this.renderMixer();
    this.renderReadout();
  }

  toggleButton(label, title, onClick) {
    const node = button('joc-scene-toggle', label, title);
    node.setAttribute('aria-pressed', 'false');
    node.addEventListener('click', onClick);
    return node;
  }

  slider(label, title, min, max, step, onInput) {
    const input = Object.assign(document.createElement('input'), { type: 'range', min, max, step });
    const value = el('span', 'joc-scene-slider-value');
    const root = el('label', 'joc-scene-slider', el('span', 'joc-scene-slider-name', label), input, value);
    root.title = title;
    input.addEventListener('input', () => onInput(Number(input.value)));
    return { root, input, value };
  }

  setView(view) {
    this.view = view;
    this.renderToggles();
  }

  renderToggles() {
    for (const [view, node] of Object.entries(this.viewButtons)) node.setAttribute('aria-checked', String(view === this.view));
    this.tourButton.setAttribute('aria-pressed', String(this.tour));
    this.walkButton.setAttribute('aria-pressed', String(this.walk));
    if (this.gyroButton) this.gyroButton.setAttribute('aria-pressed', String(Boolean(this.gyro)));
  }

  /** 独奏 / 静音的编号（0 为 LFE）算成 16 路增益 */
  gainsFor(solo, mute) {
    const gains = new Array(OBJECTS + 1).fill(1);
    for (let index = 0; index <= OBJECTS; index++) {
      if ((solo.length && !solo.includes(index)) || mute.includes(index)) gains[index] = 0;
    }
    return gains;
  }

  toggle(kind, index) {
    const list = (this.state[kind] || []).slice();
    const at = list.indexOf(index);
    if (at >= 0) list.splice(at, 1); else list.push(index);
    this.update({ [kind]: list });
  }

  /** 修改控制项：独奏 / 静音变了就重算增益；朝向与站位在动画帧里合并发送 */
  update(patch) {
    // 还没发出去的朝向 / 站位一起带上，播放器回传的状态才不会把它盖掉
    if (this.dirty) {
      const { yaw, pitch, roll, x, y, z } = this.state;
      patch = { yaw, pitch, roll, x, y, z, ...patch };
      this.dirty = false;
    }
    if (patch.solo || patch.mute) {
      const solo = patch.solo || this.state.solo || [];
      const mute = patch.mute || this.state.mute || [];
      patch = { ...patch, gains: this.gainsFor(solo, mute) };
    }
    this.player.setSpatial(patch);
  }

  /** 转头 / 走动：先改本地状态，下一帧一起交给播放器（拖动时每帧最多发一次） */
  pose(patch) {
    this.state = { ...this.state, ...patch };
    this.dirty = true;
  }

  resetPose() {
    this.tour = false;
    if (this.gyro) this.gyro.base = null;
    this.renderToggles();
    this.update({ yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: 0 });
  }

  renderMixer() {
    const solo = this.state.solo || [];
    const mute = this.state.mute || [];
    for (let index = 0; index <= OBJECTS; index++) {
      const item = this.mixerItems[index];
      item.solo.setAttribute('aria-pressed', String(solo.includes(index)));
      item.mute.setAttribute('aria-pressed', String(mute.includes(index)));
      item.chip.classList.toggle('is-silent', this.gainOf(index) === 0);
    }
    this.focusSlider.input.value = String(this.state.focus || 0);
    this.focusSlider.value.textContent = `${Math.round((this.state.focus || 0) * 100)}%`;
    this.heightSlider.input.value = String(this.state.height || 1);
    this.heightSlider.value.textContent = `×${(this.state.height || 1).toFixed(1)}`;
  }

  gainOf(index) {
    const gains = this.state.gains;
    return gains && gains.length > index ? gains[index] : 1;
  }

  renderReadout() {
    const deg = (rad) => Math.round((Math.abs(rad) * 180) / Math.PI);
    // yaw 规范到 ±180°，左转为正
    let yaw = (this.state.yaw || 0) % TAU;
    if (yaw > Math.PI) yaw -= TAU;
    if (yaw < -Math.PI) yaw += TAU;
    const pitch = this.state.pitch || 0;
    const parts = [t('scene.pose', {
      turn: t(yaw >= 0 ? 'scene.turnLeft' : 'scene.turnRight'), yaw: deg(yaw),
      tilt: t(pitch >= 0 ? 'scene.tiltUp' : 'scene.tiltDown'), pitch: deg(pitch),
    })];
    if (this.state.x || this.state.y) parts.push(t('scene.position', { x: (this.state.x || 0).toFixed(1), y: (this.state.y || 0).toFixed(1) }));
    this.readout.textContent = parts.join(' · ');
  }

  async toggleGyro() {
    if (this.gyro) {
      window.removeEventListener('deviceorientation', this.gyro.listener);
      this.gyro = null;
      this.renderToggles();
      return;
    }
    try {
      // iOS 要在点击里请求权限
      if (typeof DeviceOrientationEvent.requestPermission === 'function' && await DeviceOrientationEvent.requestPermission() !== 'granted') return;
    } catch { return; }
    const gyro = { base: null };
    gyro.listener = (event) => {
      if (event.alpha == null || event.beta == null) return;
      if (!gyro.base) gyro.base = { alpha: event.alpha, beta: event.beta, yaw: this.state.yaw || 0, pitch: this.state.pitch || 0 };
      let turn = event.alpha - gyro.base.alpha;
      if (turn > 180) turn -= 360;
      if (turn < -180) turn += 360;
      this.pose({
        yaw: gyro.base.yaw + (turn * Math.PI) / 180,
        pitch: clamp(gyro.base.pitch + ((event.beta - gyro.base.beta) * Math.PI) / 180, -PITCH_LIMIT, PITCH_LIMIT),
      });
    };
    window.addEventListener('deviceorientation', gyro.listener);
    this.gyro = gyro;
    this.renderToggles();
  }

  bindPointer() {
    const canvas = this.canvas;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const camera = e.button === 2 || e.shiftKey || this.pointers.size > 1;
      this.gesture = { camera, moved: false, x: e.clientX, y: e.clientY, alt: e.altKey, spread: this.spread() };
      this.tour = false;
      this.renderToggles();
    });
    canvas.addEventListener('pointermove', (e) => {
      const point = this.pointers.get(e.pointerId);
      if (!point) { this.hover = this.pick(e.clientX, e.clientY); return; }
      const dx = e.clientX - point.x;
      const dy = e.clientY - point.y;
      point.x = e.clientX;
      point.y = e.clientY;
      const g = this.gesture;
      if (!g) return;
      if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) > 4) g.moved = true;
      if (!g.moved) return;
      if (this.pointers.size > 1) {
        // 双指：平均位移转视角，张合缩放
        const spread = this.spread();
        if (g.spread && spread) this.zoom(g.spread / spread);
        g.spread = spread;
        this.orbit(dx / this.pointers.size, dy / this.pointers.size);
      } else if (g.camera) {
        this.orbit(dx, dy);
      } else if (this.walk) {
        this.drag(dx, dy);
      } else {
        // 向右拖头向右转（yaw 减小），向上拖抬头
        this.pose({
          yaw: (this.state.yaw || 0) - dx * 0.008,
          pitch: clamp((this.state.pitch || 0) - dy * 0.006, -PITCH_LIMIT, PITCH_LIMIT),
        });
      }
    });
    const end = (e) => {
      const g = this.gesture;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) this.gesture = null;
      if (!g || g.moved || e.type === 'pointercancel' || g.camera) return;
      const index = this.pick(e.clientX, e.clientY);
      if (index >= 0) this.toggle(g.alt || e.altKey ? 'mute' : 'solo', index + 1);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => { if (!this.pointers.size) this.hover = -1; });
    canvas.addEventListener('dblclick', (e) => { if (this.pick(e.clientX, e.clientY) < 0) this.resetPose(); });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom(Math.exp(e.deltaY * 0.0012));
    }, { passive: false });
  }

  spread() {
    if (this.pointers.size < 2) return 0;
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  orbit(dx, dy) {
    if (this.view === 'first') {
      this.pose({ yaw: (this.state.yaw || 0) - dx * 0.006, pitch: clamp((this.state.pitch || 0) - dy * 0.005, -PITCH_LIMIT, PITCH_LIMIT) });
      return;
    }
    this.camera.yaw -= dx * 0.008;
    this.camera.pitch = clamp(this.camera.pitch + dy * 0.006, -0.2, 1.45);
  }

  zoom(factor) {
    if (this.view === 'first') this.camera.fov = clamp(this.camera.fov * factor, 0.6, 1.6);
    else this.camera.distance = clamp(this.camera.distance * factor, 3, 24);
  }

  /** 漫步：拖动方向按当前视角换算成地面上的位移 */
  drag(dx, dy) {
    const scale = this.view === 'first' ? 0.01 : this.camera.distance * 0.0016;
    const yaw = this.view === 'first' ? this.state.yaw || 0 : this.camera.yaw;
    const right = [Math.cos(yaw), Math.sin(yaw)];
    const ahead = [-Math.sin(yaw), Math.cos(yaw)];
    // 向上拖往（相机的）前方走，向右拖往右走
    this.step((right[0] * dx - ahead[0] * dy) * scale, (right[1] * dx - ahead[1] * dy) * scale);
  }

  step(dx, dy) {
    this.pose({
      x: clamp((this.state.x || 0) + dx, -WALK_LIMIT, WALK_LIMIT),
      y: clamp((this.state.y || 0) + dy, -WALK_LIMIT, WALK_LIMIT),
    });
  }

  keyDown(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); return; }
    // 滑块自己用方向键
    if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
    const turn = 0.12;
    switch (e.key) {
      case 'ArrowLeft': this.pose({ yaw: (this.state.yaw || 0) + turn }); break;
      case 'ArrowRight': this.pose({ yaw: (this.state.yaw || 0) - turn }); break;
      case 'ArrowUp': this.pose({ pitch: clamp((this.state.pitch || 0) + turn, -PITCH_LIMIT, PITCH_LIMIT) }); break;
      case 'ArrowDown': this.pose({ pitch: clamp((this.state.pitch || 0) - turn, -PITCH_LIMIT, PITCH_LIMIT) }); break;
      case 'r': case 'R': this.resetPose(); break;
      case 'v': case 'V': this.setView(this.view === 'first' ? 'orbit' : 'first'); break;
      default:
        if (['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) { this.keys.add(e.code); break; }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  close() {
    cancelAnimationFrame(this.frame);
    if (this.gyro) window.removeEventListener('deviceorientation', this.gyro.listener);
    this.resize.disconnect();
    this.unsubscribe();
    if (this.engine) this.engine.watchScene(false);
    this.root.remove();
    if (this.previousFocus && this.previousFocus.focus) this.previousFocus.focus();
    current = null;
  }

  fit() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const { width, height } = this.canvas.getBoundingClientRect();
    this.width = width;
    this.height = height;
    this.canvas.width = Math.max(1, Math.round(width * ratio));
    this.canvas.height = Math.max(1, Math.round(height * ratio));
    this.ratio = ratio;
  }

  tick(time) {
    this.frame = requestAnimationFrame((next) => this.tick(next));
    const dt = Math.min(0.1, (time - this.last) / 1000);
    this.last = time;
    this.follow();
    this.animate(dt);
    this.ingest(dt);
    this.draw();
  }

  /** 跟上播放器当前的引擎（换曲会换引擎），更新状态行与提示 */
  follow() {
    const engine = this.player.spatialEngine();
    if (engine !== this.engine) {
      if (this.engine) this.engine.watchScene(false);
      this.engine = engine;
      if (engine) engine.watchScene(true);
      for (const object of this.objects) { object.pos = null; object.target = null; object.trail = []; object.level = 0; }
    }
    let message = '';
    if (!engine) message = t('scene.waiting');
    else if (engine.mode !== 'binaural') message = t('scene.speaker');
    else if (!engine.live) message = t('scene.noLive');
    if (this.message.textContent !== message) {
      this.message.textContent = message;
      this.message.hidden = !message;
    }
    const parts = [];
    if (engine && engine.mode === 'binaural') {
      parts.push(`HRTF ${engine.dataset}`);
      if (engine.live && engine.lead != null) {
        const context = engine.context;
        const output = (context.outputLatency || context.baseLatency || 0) * 1000;
        parts.push(t('scene.latency', { ms: Math.round((engine.lead / engine.rate) * 1000 + output) }));
      }
    }
    const status = parts.join(' · ');
    if (this.status.textContent !== status) this.status.textContent = status;
  }

  /** 巡游与键盘走动，然后把这一帧的朝向 / 站位交给播放器 */
  animate(dt) {
    if (this.tour) this.pose({ yaw: ((this.state.yaw || 0) + TOUR_SPEED * dt) % TAU });
    if (this.keys.size) {
      const speed = 2.2 * dt;
      const axes = headAxes(this.state.yaw || 0, 0);
      let forward = 0;
      let side = 0;
      if (this.keys.has('KeyW')) forward += speed;
      if (this.keys.has('KeyS')) forward -= speed;
      if (this.keys.has('KeyD')) side += speed;
      if (this.keys.has('KeyA')) side -= speed;
      this.step(axes.face[0] * forward + axes.right[0] * side, axes.face[1] * forward + axes.right[1] * side);
    }
    if (this.dirty) {
      this.dirty = false;
      const { yaw, pitch, roll, x, y, z } = this.state;
      this.player.setSpatial({ yaw, pitch, roll, x, y, z });
    }
  }

  /** 取当前播放位置的场景，平滑对象位置与电平 */
  ingest(dt) {
    const scene = this.engine && this.engine.live ? this.engine.sceneAt() : null;
    if (scene && scene !== this.lastScene) {
      this.lastScene = scene;
      for (let i = 0; i < OBJECTS; i++) {
        const object = this.objects[i];
        object.target = [scene[i * 3], scene[i * 3 + 1], scene[i * 3 + 2]];
        if (!object.pos) object.pos = object.target.slice();
        object.rms = scene[45 + i + 1];
      }
      this.lfeRms = scene[45];
    }
    const follow = 1 - Math.exp(-dt * 18);
    for (const object of this.objects) {
      if (!object.target) continue;
      for (let k = 0; k < 3; k++) object.pos[k] += (object.target[k] - object.pos[k]) * follow;
      object.level = this.smoothLevel(object.level, object.rms || 0, dt);
      object.trail.push(object.pos.slice());
      if (object.trail.length > TRAIL) object.trail.shift();
    }
    this.lfe = this.smoothLevel(this.lfe, this.lfeRms || 0, dt);
  }

  /** RMS → 0..1（-60..0 dBFS），起得快落得慢 */
  smoothLevel(previous, rms, dt) {
    const level = rms > 0 ? clamp((20 * Math.log10(rms) + 60) / 60, 0, 1) : 0;
    const rate = level > previous ? 30 : 4;
    return previous + (level - previous) * (1 - Math.exp(-dt * rate));
  }

  /** 世界坐标里的对象位置（高度倍率与渲染器一致） */
  objectWorld(adm) {
    const height = this.state.height || 1;
    return [adm[0] * MIX_RADIUS, adm[1] * MIX_RADIUS, clamp(adm[2] * height, -1, 1) * MIX_RADIUS];
  }

  listener() { return [this.state.x || 0, this.state.y || 0, this.state.z || 0]; }

  /** 相机：俯瞰时绕房间中心，第一人称时在头部 */
  setupCamera() {
    let eye;
    let face;
    let fov;
    if (this.view === 'first') {
      const axes = headAxes(this.state.yaw || 0, this.state.pitch || 0);
      eye = this.listener();
      face = axes.face;
      fov = 1.25 * this.camera.fov;
    } else {
      const { yaw, pitch, distance } = this.camera;
      face = [-Math.sin(yaw) * Math.cos(pitch), Math.cos(yaw) * Math.cos(pitch), -Math.sin(pitch)];
      const target = [0, 0, 0.4];
      eye = target.map((value, k) => value - face[k] * distance);
      fov = 0.9;
    }
    const length = Math.hypot(face[1], face[0]) || 1e-9;
    const right = [face[1] / length, -face[0] / length, 0];
    const up = [right[1] * face[2] - right[2] * face[1], right[2] * face[0] - right[0] * face[2], right[0] * face[1] - right[1] * face[0]];
    const focal = (Math.min(this.width, this.height) / 2) / Math.tan(fov / 2);
    this.cam = { eye, face, right, up, focal, cx: this.width / 2, cy: this.height * (this.view === 'first' ? 0.45 : 0.42) };
  }

  /** 世界坐标 → 屏幕（x, y, 深度, 缩放）；在相机后面时为 null */
  project(point) {
    const { eye, face, right, up, focal, cx, cy } = this.cam;
    const d = [point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]];
    const depth = d[0] * face[0] + d[1] * face[1] + d[2] * face[2];
    if (depth < 0.15) return null;
    const scale = focal / depth;
    return {
      x: cx + (d[0] * right[0] + d[1] * right[1] + d[2] * right[2]) * scale,
      y: cy - (d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) * scale,
      depth,
      scale,
    };
  }

  /** 屏幕坐标下最靠前的光球（对象编号 0..14），没有为 -1 */
  pick(clientX, clientY) {
    if (!this.cam) return -1;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = -1;
    let bestDepth = Infinity;
    for (let i = 0; i < OBJECTS; i++) {
      const object = this.objects[i];
      if (!object.pos) continue;
      const p = this.project(this.objectWorld(object.pos));
      if (!p) continue;
      const radius = Math.max(10, clamp(this.orbRadius(object) * p.scale, 2.5, MAX_ORB) + 6);
      if (Math.hypot(p.x - x, p.y - y) <= radius && p.depth < bestDepth) { best = i; bestDepth = p.depth; }
    }
    return best;
  }

  orbRadius(object) { return 0.1 + 0.32 * object.level; }

  draw() {
    const ctx = this.ctx;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    this.setupCamera();
    this.drawFloor();
    this.drawShadows();
    const items = [];
    const solo = this.state.solo || [];
    for (let i = 0; i < OBJECTS; i++) {
      const object = this.objects[i];
      if (!object.pos) continue;
      const world = this.objectWorld(object.pos);
      const p = this.project(world);
      if (p) items.push({ depth: p.depth, draw: () => this.drawObject(i, object, world, p, solo) });
    }
    if (this.view !== 'first') {
      const p = this.project(this.listener());
      if (p) items.push({ depth: p.depth, draw: () => this.drawHead() });
    }
    items.sort((a, b) => b.depth - a.depth);
    for (const item of items) item.draw();
    if (this.view === 'first') this.drawCompass();
    this.renderMeters();
  }

  /** 耳朵高度的地面：同心圆、方位线、ADM 房间的轮廓与「前 / 后 / 左 / 右」 */
  drawFloor() {
    const ctx = this.ctx;
    const line = (points, style, width = 1, dash = null) => {
      ctx.beginPath();
      let pen = false;
      for (const point of points) {
        const p = this.project(point);
        if (!p) { pen = false; continue; }
        if (pen) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
        pen = true;
      }
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.setLineDash(dash || []);
      ctx.stroke();
    };
    const circle = (radius, z = FLOOR) => Array.from({ length: 73 }, (_, k) => [Math.cos((k / 72) * TAU) * radius, Math.sin((k / 72) * TAU) * radius, z]);
    for (const radius of [1, 2, 3, 4, 5]) line(circle(radius), radius === 2 ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.06)');
    for (let k = 0; k < 12; k++) {
      const angle = (k / 12) * TAU;
      line([[Math.cos(angle) * 0.6, Math.sin(angle) * 0.6, FLOOR], [Math.cos(angle) * 5, Math.sin(angle) * 5, FLOOR]], 'rgba(255,255,255,.05)');
    }
    // ADM 的立方体：x / y ∈ ±1、z ∈ 0..1（Atmos 房间，底面在耳朵高度），乘以渲染距离
    const r = MIX_RADIUS;
    const square = (z) => [[-r, -r, z], [r, -r, z], [r, r, z], [-r, r, z], [-r, -r, z]];
    line(square(0), 'rgba(255,255,255,.12)');
    line(square(r), 'rgba(255,255,255,.08)', 1, [4, 6]);
    for (const [x, y] of [[-r, -r], [r, -r], [r, r], [-r, r]]) line([[x, y, FLOOR], [x, y, r]], 'rgba(255,255,255,.06)', 1, [4, 6]);
    ctx.setLineDash([]);
    ctx.font = `600 12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [key, point] of [['scene.front', [0, 5.6, FLOOR]], ['scene.back', [0, -5.6, FLOOR]], ['scene.left', [-5.6, 0, FLOOR]], ['scene.right', [5.6, 0, FLOOR]]]) {
      const p = this.project(point);
      if (!p) continue;
      ctx.fillStyle = key === 'scene.front' ? 'rgba(250,45,72,.9)' : 'rgba(255,255,255,.45)';
      ctx.fillText(t(key), p.x, p.y);
    }
    // LFE：脚下随低频电平起伏的光环
    if (this.lfe > 0.02 && this.gainOf(0) > 0) {
      const ring = circle(0.55 + this.lfe * 0.9).map(([x, y]) => [x + (this.state.x || 0), y + (this.state.y || 0), FLOOR]);
      line(ring, `hsla(${hue(0)}, 90%, 70%, ${0.15 + this.lfe * 0.5})`, 1 + this.lfe * 3);
    }
  }

  /** 对象落到地面的竖线与投影（看得出高度），俯瞰时还有听者的身体与脚下的位置；都画在光球之前 */
  drawShadows() {
    const ctx = this.ctx;
    const drop = (world, color, alpha) => {
      const top = this.project(world);
      const ground = this.project([world[0], world[1], FLOOR]);
      if (!top || !ground) return;
      ctx.beginPath();
      ctx.moveTo(ground.x, ground.y);
      ctx.lineTo(top.x, top.y);
      ctx.strokeStyle = `hsla(${color}, 60%, 75%, ${alpha})`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(ground.x, ground.y, 0.14 * ground.scale + 1, 0.05 * ground.scale + 1, 0, 0, TAU);
      ctx.fillStyle = `hsla(${color}, 60%, 65%, ${alpha})`;
      ctx.fill();
    };
    for (let i = 0; i < OBJECTS; i++) {
      const object = this.objects[i];
      if (object.pos) drop(this.objectWorld(object.pos), hue(i + 1), this.gainOf(i + 1) === 0 ? 0.06 : 0.2);
    }
    if (this.view !== 'first') drop(this.listener(), 0, 0.3);
  }

  drawObject(index, object, world, p, solo) {
    const ctx = this.ctx;
    const silent = this.gainOf(index + 1) === 0;
    const soloed = solo.includes(index + 1);
    const color = hue(index + 1);
    const active = object.level > 0.05;
    // 轨迹
    if (object.trail.length > 2 && !silent) {
      let previous = null;
      object.trail.forEach((point, k) => {
        const q = this.project(this.objectWorld(point));
        if (q && previous) {
          ctx.beginPath();
          ctx.moveTo(previous.x, previous.y);
          ctx.lineTo(q.x, q.y);
          ctx.strokeStyle = `hsla(${color}, 85%, 65%, ${(k / object.trail.length) * 0.35})`;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        previous = q;
      });
    }
    const radius = clamp(this.orbRadius(object) * p.scale, 2.5, MAX_ORB);
    if (silent) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, TAU);
      ctx.strokeStyle = 'rgba(255,255,255,.25)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 2.6);
      glow.addColorStop(0, `hsla(${color}, 95%, 70%, ${active ? 0.55 : 0.15})`);
      glow.addColorStop(1, `hsla(${color}, 95%, 60%, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 2.6, 0, TAU);
      ctx.fill();
      ctx.restore();
      const body = ctx.createRadialGradient(p.x - radius * 0.35, p.y - radius * 0.35, radius * 0.1, p.x, p.y, radius);
      body.addColorStop(0, `hsla(${color}, 100%, ${active ? 88 : 60}%, 1)`);
      body.addColorStop(1, `hsla(${color}, 80%, ${active ? 52 : 30}%, 1)`);
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, TAU);
      ctx.fill();
    }
    if (soloed || this.hover === index) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius + 4, 0, TAU);
      ctx.strokeStyle = soloed ? '#fff' : 'rgba(255,255,255,.6)';
      ctx.lineWidth = soloed ? 2 : 1.5;
      ctx.stroke();
    }
    if (this.hover === index || soloed) {
      const db = object.rms > 0 ? `${Math.round(20 * Math.log10(object.rms))} dB` : '-∞ dB';
      ctx.font = `600 12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.fillText(`${t('scene.object', { n: index + 1 })} · ${db}`, p.x, p.y - radius - 8);
    } else if (radius > 9) {
      ctx.font = `600 ${Math.min(13, radius * 0.8)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillText(String(index + 1), p.x, p.y + 0.5);
    }
  }

  /** 俯瞰视角的头部：球形的头、鼻子指向面朝的方向，两只耳朵（左青右红），聚焦时前方有一束光 */
  drawHead() {
    const ctx = this.ctx;
    const origin = this.listener();
    const axes = headAxes(this.state.yaw || 0, this.state.pitch || 0);
    const center = this.project(origin);
    if (!center) return;
    const radius = HEAD_RADIUS * center.scale;
    // 面朝方向的光束（聚焦越强越亮）与视线
    const focus = this.state.focus || 0;
    const reach = 1.8 + focus * 1.5;
    const spread = 0.55 - focus * 0.25;
    const beam = [0, 1, 2].map((k) => {
      const angle = (k - 1) * spread;
      return headPoint(axes, origin, [Math.sin(angle) * reach, Math.cos(angle) * reach, 0]);
    });
    const tip = beam.map((point) => this.project(point));
    if (tip.every(Boolean)) {
      const gradient = ctx.createLinearGradient(center.x, center.y, tip[1].x, tip[1].y);
      gradient.addColorStop(0, `rgba(250,45,72,${0.18 + focus * 0.35})`);
      gradient.addColorStop(1, 'rgba(250,45,72,0)');
      ctx.beginPath();
      ctx.moveTo(center.x, center.y);
      ctx.lineTo(tip[0].x, tip[0].y);
      ctx.lineTo(tip[2].x, tip[2].y);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    }
    // 耳朵与鼻子按深度排在头的前后
    const parts = [
      { local: [-HEAD_RADIUS * 1.02, 0, 0], kind: 'ear', color: '#5ad1ff', label: 'L' },
      { local: [HEAD_RADIUS * 1.02, 0, 0], kind: 'ear', color: '#ff5a73', label: 'R' },
      { local: [0, HEAD_RADIUS * 1.08, -0.02], kind: 'nose' },
    ].map((part) => ({ ...part, p: this.project(headPoint(axes, origin, part.local)) })).filter((part) => part.p);
    const drawPart = (part) => {
      if (part.kind === 'ear') {
        ctx.beginPath();
        ctx.ellipse(part.p.x, part.p.y, radius * 0.22, radius * 0.34, 0, 0, TAU);
        ctx.fillStyle = part.color;
        ctx.fill();
        ctx.font = `700 ${Math.max(9, radius * 0.28)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(0,0,0,.7)';
        ctx.fillText(part.label, part.p.x, part.p.y + 0.5);
      } else {
        ctx.beginPath();
        ctx.arc(part.p.x, part.p.y, radius * 0.16, 0, TAU);
        ctx.fillStyle = '#f2d4c4';
        ctx.fill();
      }
    };
    for (const part of parts) if (part.p.depth > center.depth) drawPart(part);
    const skin = ctx.createRadialGradient(center.x - radius * 0.35, center.y - radius * 0.4, radius * 0.1, center.x, center.y, radius);
    skin.addColorStop(0, '#f6e3d8');
    skin.addColorStop(1, '#b98f7d');
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, TAU);
    ctx.fillStyle = skin;
    ctx.fill();
    // 头顶的发旋：看得出头部的俯仰
    const crown = this.project(headPoint(axes, origin, [0, -HEAD_RADIUS * 0.25, HEAD_RADIUS * 0.85]));
    if (crown) {
      ctx.beginPath();
      ctx.arc(crown.x, crown.y, radius * 0.5, 0, TAU);
      ctx.fillStyle = 'rgba(60,40,32,.55)';
      ctx.fill();
    }
    for (const part of parts) if (part.p.depth <= center.depth) drawPart(part);
  }

  /** 第一人称：顶部的方位刻度与中心准星 */
  drawCompass() {
    const ctx = this.ctx;
    const yaw = this.state.yaw || 0;
    const width = Math.min(this.width - 32, 420);
    const left = (this.width - width) / 2;
    const top = 64;
    ctx.font = `600 11px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 世界方位（0 = 前，90 = 左，与 yaw 同向）相对面朝方向的角度，显示视野内的 ±90°，左边的方位在左
    const labels = { 0: 'scene.front', 90: 'scene.left', 180: 'scene.back', 270: 'scene.right' };
    for (let deg = 0; deg < 360; deg += 15) {
      let relative = ((deg * Math.PI) / 180 - yaw) % TAU;
      if (relative > Math.PI) relative -= TAU;
      if (relative <= -Math.PI) relative += TAU;
      if (Math.abs(relative) > Math.PI / 2) continue;
      const x = left + width / 2 - (relative / (Math.PI / 2)) * (width / 2);
      const label = labels[deg];
      ctx.fillStyle = label === 'scene.front' ? 'rgba(250,45,72,.95)' : 'rgba(255,255,255,.55)';
      if (label) ctx.fillText(t(label), x, top);
      else ctx.fillRect(x - 0.5, top - (deg % 45 ? 3 : 6), 1, deg % 45 ? 6 : 12);
    }
    const { cx, cy } = this.cam;
    ctx.strokeStyle = 'rgba(255,255,255,.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, TAU);
    ctx.moveTo(cx - 18, cy);
    ctx.lineTo(cx - 13, cy);
    ctx.moveTo(cx + 13, cy);
    ctx.lineTo(cx + 18, cy);
    ctx.stroke();
  }

  renderMeters() {
    for (let index = 0; index <= OBJECTS; index++) {
      const level = index === 0 ? this.lfe : this.objects[index - 1].level;
      const meter = this.mixerItems[index].meter;
      const value = `${Math.round(level * 100)}%`;
      if (meter.style.height !== value) meter.style.height = value;
    }
  }
}
