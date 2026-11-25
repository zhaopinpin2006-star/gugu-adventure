/**
 * 《咕咕奇遇记》主控 —— 装配 AR 层 / 角色 / 摇杆 / 特效 / UI / 音频，
 * 并驱动唯一的主循环（时序见 docs/CONTRACT.md §3）。
 */

import './style/main.css';

import * as THREE from 'three';
import { MindARLite } from './ar/MindARLite.js';
import { MockAR } from './ar/MockAR.js';
import { createMovementState, stepMovement, MOVE_TUNING } from './core/movement.js';
import { loadCharacter } from './character/CharacterController.js';
import { createJoystick } from './input/Joystick.js';
import { createContactShadow } from './fx/ContactShadow.js';
import { createPetals } from './fx/Petals.js';
import { createFootprints } from './fx/Footprints.js';
import { Sfx } from './audio/Sfx.js';
import { Hud } from './ui/Hud.js';

const params = new URLSearchParams(location.search);
const FORCE_MOCK = params.has('mock');
const DEBUG_ANCHOR = params.has('debug');
const FORCE_DEBUG = params.has('debug');

const IS_SECURE =
  location.protocol === 'https:' ||
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1' ||
  location.hostname === '[::1]';

// 出生/重新定位的朝向：heading=0 面向 P 系 +Z（海报下沿、靠近镜头那一侧）。
// 俯看平放的海报时，这一侧就是玩家，所以角色一出现就正对镜头，不会露后脑勺。
// 注意 P 系与模型自身朝向：模型正面朝 +Z（尾部骨骼 Tail 在 z=-0.18），见 CONTRACT §1.2。
const SPAWN_HEADING = 0;

const state = {
  started: false,
  ar: null,
  hud: null,
  joystick: null,
  sfx: null,
  character: null,
  controller: null,
  shadow: null,
  petals: null,
  footprints: null,
  movement: null,
  input: { x: 0, y: 0, force: 0 },
  bounds: { halfX: 0.5, halfZ: 0.625, margin: 0.13 },
  clock: null,
  running: false,
  lastFrame: 0,
  rafId: 0,
  jumpTimer: 0,
  isAirborne: false,
  gait: 'idle',
  lastSpeed: 0,
  fpsSamples: [],
  lastLostAt: 0
};

boot();

function boot() {
  const hud = new Hud({
    onStart: () => startExperience(),
    onJump: () => doJump(),
    onRecenter: () => doRecenter(),
    onToggleSound: () => toggleSound()
  });
  state.hud = hud;

  // 环境能力预检查（不请求权限，只做提示）
  const blockers = preflight();
  if (blockers) {
    hud.showOverlay({
      kind: blockers.kind,
      title: blockers.title,
      desc: blockers.desc,
      actionText: blockers.actionText
    });
    hud.setStatus(blockers.kind === 'permission' ? 'warn' : 'error', blockers.statusText || '无法开始');
    if (blockers.fatal) {
      hud.setControlsEnabled({ jump: false, recenter: false });
      return;
    }
  } else {
    hud.showOverlay({
      kind: 'start',
      title: '咕咕奇遇记',
      desc: '把镜头对准那幅泥咕咕海报，泥咕咕就会从年画里跳出来，跟着你的摇杆四处走走。',
      actionText: '开始奇遇'
    });
    hud.setStatus('scan', IS_SECURE ? '准备就绪' : '需要 HTTPS');
  }
}

function preflight() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);

  if (!window.WebGLRenderingContext || !hasWebGL2or1()) {
    return {
      kind: 'error',
      fatal: true,
      title: '这个浏览器画不出 3D',
      desc: '没有找到可用的 WebGL。请换用 iOS Safari 或 Android Chrome 的最新版本再试。',
      actionText: '知道了',
      statusText: 'WebGL 不可用'
    };
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return {
      kind: 'permission',
      fatal: false,
      title: '需要摄像头权限',
      desc: IS_SECURE
        ? '当前浏览器没有开放摄像头接口。请在浏览器设置里允许本站使用摄像头，然后重新加载。'
        : '当前页面不是 HTTPS，移动端浏览器会拒绝摄像头。请用 https:// 打开，或改用 localhost 调试。',
      actionText: '我再试试',
      statusText: '摄像头不可用'
    };
  }
  if (!IS_SECURE) {
    return {
      kind: 'permission',
      fatal: false,
      title: '要用 HTTPS 才能开摄像头',
      desc: 'iOS Safari 与 Android Chrome 都要求 HTTPS（或 localhost）。本地调试请运行 `npm run dev` 并访问 https 地址，部署请使用 GitHub Pages。',
      actionText: '继续尝试',
      statusText: '需要 HTTPS'
    };
  }
  if (!isIOS && !isAndroid && !FORCE_MOCK) {
    // 桌面浏览器：仍然允许，但提示可以开 mock
    return null;
  }
  return null;
}

function hasWebGL2or1() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'));
  } catch (e) {
    return false;
  }
}

async function startExperience() {
  if (state.started) return;
  state.started = true;

  const hud = state.hud;
  hud.hideOverlay();
  hud.setStatus('scan', '正在唤起摄像头…');
  hud.setProgress(0.02);

  const sfx = new Sfx();
  state.sfx = sfx;
  sfx.unlock().catch(() => {});

  const useMock = FORCE_MOCK || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !IS_SECURE;

  // ---------- AR 层 ----------
  const container = document.getElementById('ar-container');
  const ARClass = useMock ? MockAR : MindARLite;
  const ar = new ARClass({
    container,
    imageTargetSrc: 'targets/nigugu.mind',
    missTolerance: 6,
    warmupTolerance: 3,
    onStatus: (kind, text) => hud.setStatus(kind === 'loading' ? 'scan' : kind, text),
    onTargetFound: () => onTargetFound(),
    onTargetLost: () => onTargetLost(),
    onFrame: () => {}
  });
  state.ar = ar;

  try {
    await ar.start();
  } catch (err) {
    console.error('[gugu] AR 启动失败', err);
    hud.setProgress(null);
    hud.showOverlay({
      kind: 'error',
      title: '镜头打不开',
      desc: (err && err.message) || '摄像头启动失败，请检查权限或改用 HTTPS。',
      actionText: '重试'
    });
    hud.setStatus('error', '启动失败');
    state.started = false;
    return;
  }

  if (useMock) {
    hud.toast(FORCE_MOCK ? '未检测到摄像头，已进入演示模式' : '演示模式（无摄像头）', 2600);
  }

  // ---------- 场景内容 ----------
  const half = ar.posterHalf;
  state.bounds = { halfX: half.halfX, halfZ: half.halfZ, margin: 0.13 };

  if (DEBUG_ANCHOR) ar.addAnchorDebug();

  // 角色
  hud.setStatus('scan', '正在请泥咕咕出场…');
  let character = null;
  try {
    const res = await loadCharacter({
      url: 'nigugu.glb',
      onProgress: (loaded, total) => {
        if (total) hud.setProgress(Math.min(0.98, 0.05 + (loaded / total) * 0.9));
      }
    });
    character = res;
  } catch (err) {
    console.error('[gugu] 角色加载失败', err);
    hud.setProgress(null);
    hud.showOverlay({
      kind: 'error',
      title: '泥咕咕走丢了',
      desc: (err && err.message) || '模型加载失败，请检查网络后重试。',
      actionText: '重试'
    });
    hud.setStatus('error', '模型加载失败');
    state.started = false;
    return;
  }
  state.character = character.group;
  state.controller = character.controller;
  hud.setProgress(1);
  setTimeout(() => hud.setProgress(null), 400);

  // 枢轴放进海报地面坐标系
  ar.posterSpace.add(character.group);

  // 特效
  const shadow = createContactShadow({ radius: 0.3, opacity: 0.34 });
  ar.posterSpace.add(shadow.object3D);
  state.shadow = shadow;

  const petals = createPetals({ count: 42, area: { halfX: half.halfX, halfZ: half.halfZ } });
  ar.posterSpace.add(petals.object3D);
  state.petals = petals;

  const footprints = createFootprints({ max: 24, area: { halfX: half.halfX, halfZ: half.halfZ } });
  ar.posterSpace.add(footprints.object3D);
  state.footprints = footprints;

  // 运动学状态：出生在海报中心偏下一点。
  // heading=0 表示面向 P 系 +Z —— 即海报下沿、靠近镜头的一侧，
  // 也是玩家俯看海报时自己的方向，所以出生就该面对玩家（详见 CONTRACT §1.2）。
  state.movement = createMovementState({ x: 0, z: 0.12, heading: SPAWN_HEADING });
  applyMovementToCharacter(state.movement);

  // 摇杆
  const joystickZone = document.getElementById('joystick-zone');
  state.joystick = createJoystick({
    zone: joystickZone,
    size: joystickZone ? Math.round(joystickZone.clientWidth || 132) : 132,
    deadzone: 0.12,
    onChange: (input) => {
      state.input = input;
    }
  });

  // 进入主循环
  state.clock = new THREE.Clock();
  state.lastFrame = performance.now();
  state.running = true;
  requestAnimationFrame(loop);

  // 识别状态决定操作可用性（由 AR 回调驱动；mock 会立刻 found）
  hud.setStatus('scan', '对准泥咕咕海报');
  hud.setControlsEnabled({ jump: false, recenter: true });

  // 后台切走要暂停
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('orientationchange', () => {
    // 旋转后 CSS 的 --joystick-size 会变，摇杆 DOM 是创建时写死尺寸的，必须重建
    setTimeout(() => syncJoystickSize(), 200);
    setTimeout(() => ar.resize && ar.resize(), 200);
    setTimeout(() => syncJoystickSize(), 600);
    setTimeout(() => ar.resize && ar.resize(), 600);
  });
  window.addEventListener('resize', () => {
    if (ar.resize && ar.scheduleResize) ar.scheduleResize();
    else if (ar.resize) ar.resize();
    syncJoystickSize();
  });
}

/** 摇杆 DOM 的尺寸是创建时写死的，容器尺寸变了就得让它跟上。 */
function syncJoystickSize() {
  const joystick = state.joystick;
  if (joystick && typeof joystick.syncSize === 'function') {
    try {
      joystick.syncSize();
    } catch (err) {
      console.warn('[gugu] 摇杆尺寸同步失败', err);
    }
  }
}

function onVisibility() {
  if (document.hidden) {
    stopMovingInstantly();
    if (state.joystick) state.joystick.setEnabled(false);
    state.running = false;
  } else if (state.started && state.character) {
    if (state.joystick) state.joystick.setEnabled(true);
    state.running = true;
    state.lastFrame = performance.now();
    requestAnimationFrame(loop);
  }
}

function onPageHide() {
  stopMovingInstantly();
  if (state.joystick) state.joystick.setEnabled(false);
}

function stopMovingInstantly() {
  state.input = { x: 0, y: 0, force: 0 };
  if (state.joystick && state.joystick.forceReset) state.joystick.forceReset();
  if (state.movement) {
    state.movement.vx = 0;
    state.movement.vz = 0;
    state.movement.speed = 0;
    state.movement.gait = 'idle';
  }
  state.gait = 'idle';
}

function onTargetFound() {
  const hud = state.hud;
  if (!hud) return;
  hud.setStatus('track', '泥咕咕来啦！');
  hud.setControlsEnabled({ jump: true, recenter: true });
  if (state.joystick) state.joystick.setEnabled(true);
  if (state.sfx) state.sfx.place();
  if (state.petals) state.petals.burst(12);
  if (state.ar && state.ar.posterSpace) state.ar.posterSpace.visible = true;
  const lostLong = performance.now() - state.lastLostAt;
  if (state.lastLostAt && lostLong > 1200 && hud.toast) hud.toast('找到海报啦，走吧！', 1800);
  state.lastLostAt = 0;
}

function onTargetLost() {
  const hud = state.hud;
  state.lastLostAt = performance.now();
  stopMovingInstantly();
  if (state.joystick) {
    state.joystick.forceReset();
    state.joystick.setEnabled(false);
  }
  if (hud) {
    hud.setStatus('lost', '海报跑出画面了');
    hud.setControlsEnabled({ jump: false, recenter: false });
  }
  if (state.footprints) state.footprints.clear();
}

function doJump() {
  if (!state.controller || !state.ar || !state.ar.isTracking) return;
  if (state.isAirborne) return;

  const onLand = () => {
    if (!state.isAirborne) return;
    state.isAirborne = false;
    clearTimeout(state.jumpTimer);
    if (state.sfx) state.sfx.land();
    if (state.petals) state.petals.burst(14);
    if (state.hud) state.hud.flash && state.hud.flash(160);
  };

  const started = state.controller.playJump({ onLand });
  if (started === false) return;

  state.isAirborne = true;
  if (state.sfx) state.sfx.jump();
  if (state.footprints) state.footprints.clear();

  // 兜底：页面切走导致 mixer 暂停时 'finished' 可能迟迟不来，别把角色永久锁在天上
  const clip = (state.controller.clips || []).find((c) => c && c.name === 'Jump');
  const seconds = (clip && clip.duration) || 1.4;
  clearTimeout(state.jumpTimer);
  state.jumpTimer = setTimeout(onLand, seconds * 1000 + 400);
}

function doRecenter() {
  const ar = state.ar;
  if (!ar) return;
  if (state.hud) state.hud.setStatus('scan', '重新对准海报…');
  if (ar.recenter) ar.recenter();
  if (state.sfx) state.sfx.chirp();
  // 重新定位同时把移动输入清零：否则如果这时摇杆还压着，
  // 下一帧 stepMovement 会立刻把角色又推离中心，"回到中心"就成了空操作。
  stopMovingInstantly();
  // 角色回到海报中心附近，但不打断已绑定的动画
  if (state.movement) {
    resetMovementToCenter(state.movement);
    applyMovementToCharacter(state.movement);
  }
  if (state.footprints) state.footprints.clear();
}

function resetMovementToCenter(m) {
  m.x = 0;
  m.z = 0.12;
  m.vx = 0;
  m.vz = 0;
  m.speed = 0;
  m.heading = SPAWN_HEADING;
  m.gait = 'idle';
}

function toggleSound() {
  if (!state.sfx) return;
  const on = !state.sfx.enabled;
  state.sfx.setEnabled(on);
  if (on) {
    state.sfx.unlock().then(() => state.sfx.chirp()).catch(() => {});
  }
  if (state.hud) state.hud.setSoundOn(on);
}

function applyMovementToCharacter(m) {
  const g = state.character;
  if (!g) return;
  g.position.set(m.x, 0, m.z);
  g.rotation.y = m.heading;
}

let frameCount = 0;

function loop(now) {
  if (!state.running) return;
  state.rafId = requestAnimationFrame(loop);

  const dtRaw = (now - state.lastFrame) / 1000;
  state.lastFrame = now;
  const dt = Math.min(Math.max(dtRaw, 0), 0.05);

  const ar = state.ar;
  const hud = state.hud;
  const tracking = !!(ar && ar.isTracking);

  // 1) 输入（识别丢失时强制归零，且不推进 movement）
  let input = state.input;
  if (!tracking) input = { x: 0, y: 0, force: 0 };

  // 2) movement
  let m = state.movement;
  if (m && tracking) {
    const basis = ar.screenBasis ? ar.screenBasis() : null;
    m = stepMovement(m, dt, input, state.bounds, basis, MOVE_TUNING);
    state.movement = m;
    applyMovementToCharacter(m);
  } else if (m) {
    // 跟踪丢失：速度立刻归零，不推进位置
    m.vx = 0;
    m.vz = 0;
    m.speed = 0;
    m.gait = 'idle';
  }

  // 3) 动画
  const controller = state.controller;
  if (controller) {
    const gait = tracking && m ? m.gait : 'idle';
    if (gait !== state.gait) {
      state.gait = gait;
      try {
        controller.playGait(gait);
      } catch (e) {
        console.warn('[gugu] playGait 失败', e);
      }
    }
    controller.update(dt);
  }

  // 4) 特效
  const mv = state.movement || { x: 0, z: 0, speed: 0, heading: 0, gait: 'idle' };
  const speedRatio = Math.min(1, (mv.speed || 0) / MOVE_TUNING.runSpeed);
  const charHeight = state.controller ? state.controller.height || 0.42 : 0.42;

  if (state.shadow) {
    state.shadow.update(dt, {
      visible: tracking,
      x: mv.x,
      z: mv.z,
      height: 0,
      speedRatio
    });
  }
  if (state.petals) {
    state.petals.update(dt, { visible: tracking, speedRatio, x: mv.x, z: mv.z, heading: mv.heading });
  }
  if (state.footprints) {
    state.footprints.update(dt, {
      visible: tracking,
      moving: tracking && !state.isAirborne && (mv.speed || 0) > 0.03,
      gait: mv.gait,
      x: mv.x,
      z: mv.z,
      heading: mv.heading,
      stride: mv.gait === 'run' ? 0.2 : 0.135
    });
  }

  // 5) HUD 反馈
  if (hud && hud.update) hud.update(dt, { force: input.force, gait: mv.gait });

  // 6) 渲染
  ar.render();

  // 7) 调试信息
  frameCount++;
  if (state.fpsSamples.length < 30) state.fpsSamples.push(dtRaw);
  if (frameCount % 30 === 0 && FORCE_DEBUG) {
    const avg = state.fpsSamples.reduce((a, b) => a + b, 0) / Math.max(1, state.fpsSamples.length);
    console.log(
      '[gugu]',
      'fps≈' + Math.round(1 / Math.max(avg, 0.0001)),
      'tracking=' + tracking,
      'pos=(' + mv.x.toFixed(3) + ',' + mv.z.toFixed(3) + ')',
      'speed=' + (mv.speed || 0).toFixed(3),
      'gait=' + mv.gait,
      'anims=' + (controller ? controller.animationNames.join('/') : '-')
    );
    state.fpsSamples = [];
  }
}

// 便于 E2E / 调试观察
if (typeof window !== 'undefined') {
  window.__GUGU__ = state;
}
