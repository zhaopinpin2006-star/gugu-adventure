/**
 * src/input/Joystick.js — 虚拟摇杆（契约 §2.2）
 *
 * 职责：把 nipplejs 的指针事件收敛成一个稳定的 `{ x, y, force }` 输入向量，
 * 并保证"手指抬起 / 切后台 / 失焦"时一定回到全零，避免角色卡在跑动状态。
 *
 * 约定（与 docs/CONTRACT.md 一致）：
 *   - x 向右为正，y 向上为正，force ∈ [0, 1]。
 *   - 死区内（force < deadzone）输出 { x: 0, y: 0, force: 0 }。
 *   - 输入每次变化都回调 onChange（含松手回中），传的是同一个 input 对象。
 *
 * 模块顶层不允许触碰 DOM（node --check / 打包期导入都必须安全），
 * 所有 window / document 访问都在 createJoystick() 内部且带类型守卫。
 */

import nipplejs from 'nipplejs';

/** 这些事件一旦发生，就不该还有"按住"的语义：一律强制归零。 */
const WINDOW_RESET_EVENTS = [
  'touchend',
  'touchcancel',
  'pointerup',
  'pointercancel',
  'blur',
  'visibilitychange',
  'pagehide'
];

/** 归零后补发的兜底延时（ms）：有些浏览器抬起后才派发最后一次 move。 */
const RESET_RETRY_DELAYS = [0, 50];

const EPS = 1e-6;

function clamp(value, lo, hi) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/** 死区归一化：契约默认 0.12，非法值退回默认。 */
function normalizeDeadzone(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1 ? value : 0.12;
}

/** 拿一个"定时器宿主"，优先 window，其次 globalThis；都没有就返回 null。 */
function timerHost() {
  if (typeof window !== 'undefined' && window && typeof window.setTimeout === 'function') return window;
  if (typeof globalThis !== 'undefined' && typeof globalThis.setTimeout === 'function') return globalThis;
  return null;
}

/**
 * 创建虚拟摇杆。
 *
 * @param {object} options
 * @param {HTMLElement} [options.zone] 摇杆容器（圆形底盘）。允许为 null：
 *        此时退化成"永远输出 0"的空摇杆，主循环不需要额外判空。
 * @param {(input: {x:number,y:number,force:number}) => void} [options.onChange]
 * @param {number} [options.size=132] 底盘直径（px）
 * @param {number} [options.deadzone=0.12] 死区（force 低于此值视为无输入）
 * @returns {{ input: {x:number,y:number,force:number}, destroy: Function, forceReset: Function, setEnabled: Function }}
 */
export function createJoystick({ zone, onChange, size = 132, deadzone = 0.12 } = {}) {
  /** 稳定引用的输入对象：主循环可以长期持有同一个引用。 */
  const input = { x: 0, y: 0, force: 0 };
  const notify = typeof onChange === 'function' ? onChange : null;
  const deadZone = normalizeDeadzone(deadzone);
  const initialDiameter = typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 132;
  /** 当前 nipple 的实际直径。屏幕旋转后 CSS 会改 --joystick-size，需要跟着重建。 */
  let diameter = initialDiameter;

  let enabled = true;
  let destroyed = false;
  let collection = null;
  /** 已注册的 window 监听：[target, type, handler, options] */
  const listeners = [];
  /** 正在等待的归零兜底定时器 id */
  const resetTimers = new Set();

  // ---------------------------------------------------------------- 输入写入口

  /**
   * 写入输入并（按需）回调。
   * @param {number} nextX
   * @param {number} nextY
   * @param {number} nextForce
   * @param {boolean} [always] true 时无论是否变化都回调（forceReset / setEnabled 用）
   */
  function applyInput(nextX, nextY, nextForce, always = false) {
    const rawForce = clamp(nextForce, 0, 1);
    const inDeadzone = rawForce < deadZone;
    const x = inDeadzone ? 0 : clamp(nextX, -1, 1);
    const y = inDeadzone ? 0 : clamp(nextY, -1, 1);
    const force = inDeadzone ? 0 : rawForce;

    const changed =
      Math.abs(x - input.x) > EPS || Math.abs(y - input.y) > EPS || Math.abs(force - input.force) > EPS;

    input.x = x;
    input.y = y;
    input.force = force;

    if ((changed || always) && notify) {
      try {
        notify(input);
      } catch (err) {
        // 消费方回调抛错不能拖垮摇杆事件循环
        if (typeof console !== 'undefined' && console.warn) console.warn('[Joystick] onChange 抛错：', err);
      }
    }
  }

  function clearResetTimers() {
    for (const id of resetTimers) {
      try {
        const host = timerHost();
        if (host && typeof host.clearTimeout === 'function') host.clearTimeout(id);
      } catch (err) {
        /* 忽略 */
      }
    }
    resetTimers.clear();
  }

  /** 立刻归零，并在后续两个时间点再补一次（防浏览器最后一条 move 迟到）。 */
  function scheduleResetRetries() {
    const host = timerHost();
    if (!host) return;
    clearResetTimers();
    for (const delay of RESET_RETRY_DELAYS) {
      const id = host.setTimeout(() => {
        resetTimers.delete(id);
        if (destroyed) return;
        applyInput(0, 0, 0, true);
      }, delay);
      resetTimers.add(id);
    }
  }

  /**
   * 强制回中：零输入 + 复位 nipple 视觉位置。
   * 不依赖 nipplejs 自身的事件链，所以即使 pointerup 丢失也能兜住。
   */
  function forceReset() {
    if (destroyed) {
      applyInput(0, 0, 0, true);
      return;
    }
    applyInput(0, 0, 0, true);
    scheduleResetRetries();

    // 尽量把 nipple 也拉回中心（失败无所谓，反正输入已经归零）
    try {
      if (collection && typeof collection.get === 'function' && typeof collection.processOnEnd === 'function') {
        const nipple = collection.get();
        if (nipple && nipple.identifier !== undefined) {
          collection.processOnEnd({ identifier: nipple.identifier });
        }
      }
    } catch (err) {
      /* nipplejs 内部状态不一致时会抛错，忽略即可 */
    }
  }

  function setEnabled(value) {
    enabled = !!value;
    if (!enabled) applyInput(0, 0, 0, true);
  }

  // ---------------------------------------------------------------- nipplejs 事件

  /** move：唯一的真实读数来源。data = { vector:{x,y}, force, ... } */
  function handleMove(evt, data) {
    if (destroyed || !enabled) return;
    if (!data || !data.vector) return;
    const force = typeof data.force === 'number' && Number.isFinite(data.force) ? data.force : 0;
    applyInput(data.vector.x, data.vector.y, Math.min(1, force));
  }

  /** end：手指抬起 —— 立刻归零（data 是 nipple 实例，不带 vector/force）。 */
  function handleEnd() {
    if (destroyed) return;
    applyInput(0, 0, 0, true);
    scheduleResetRetries();
  }

  /** start：刚按下还没位移，保持全零，避免继承上一轮的残留值。 */
  function handleStart() {
    if (destroyed) return;
    applyInput(0, 0, 0, true);
  }

  // ---------------------------------------------------------------- 装配

  function createCollection(currentDiameter) {
    // zone 可能为 null（index.html 里 #joystick-zone 尚未就绪），此时退化为空摇杆
    if (!zone || typeof zone.appendChild !== 'function') return null;
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    try {
      const created = nipplejs.create({
        zone,
        mode: 'static',
        position: { left: '50%', top: '50%' },
        size: currentDiameter,
        color: '#F5EBDC',
        restJoystick: true,
        restOpacity: 0.5,
        fadeTime: 120,
        threshold: 0.1,
        follow: false,
        dataOnly: false
      });
      if (created && typeof created.on === 'function') {
        created.on('start', handleStart);
        created.on('move', handleMove);
        created.on('end', handleEnd);
      }
      return created || null;
    } catch (err) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[Joystick] 创建摇杆失败：', err);
      return null;
    }
  }

  /**
   * 让摇杆跟上容器的当前尺寸。
   *
   * nipplejs 把 size 写死进生成的 DOM（.back/.front 的 width/height 都是像素）。
   * 屏幕旋转后 CSS 的 @media 会把 --joystick-size 改小，但已生成的 DOM 不会跟着变，
   * 结果就是摇杆视觉溢出色环、触点与视觉错位。这里按容器实测尺寸重建一次。
   */
  function syncSize() {
    if (destroyed || !zone) return;
    // 用 clientWidth 而不是 getBoundingClientRect：底盘有 1px 边框，
    // 初建时 main.js 传的也是 clientWidth（内容盒），这里必须用同一把尺子，
    // 否则重建出来的 nipple 会比色环大 2px 而溢出去。
    const measured = Math.round(zone.clientWidth);
    if (!Number.isFinite(measured) || measured <= 0) return;
    if (Math.abs(measured - diameter) < 2) return;

    diameter = measured;
    // 重建前先归零并清掉旧 DOM，避免残留空摇杆叠在同一个 zone 里
    applyInput(0, 0, 0, true);
    try {
      if (collection && typeof collection.destroy === 'function') collection.destroy();
    } catch (err) {
      /* 旧实例销毁失败不影响重建 */
    }
    collection = createCollection(diameter);
  }

  function addListener(target, type, handler, options) {
    if (!target || typeof target.addEventListener !== 'function') return;
    try {
      target.addEventListener(type, handler, options);
      listeners.push([target, type, handler, options]);
    } catch (err) {
      /* 忽略 */
    }
  }

  function bindGlobalResets() {
    const onReset = () => {
      if (destroyed) return;
      forceReset();
    };
    const passive = { passive: true };
    for (const type of WINDOW_RESET_EVENTS) {
      addListener(typeof window !== 'undefined' ? window : null, type, onReset, passive);
    }
    // visibilitychange 实际派发在 document 上，两个目标都挂一份最稳
    addListener(typeof document !== 'undefined' ? document : null, 'visibilitychange', onReset, passive);
  }

  function unbindGlobalResets() {
    for (const [target, type, handler, options] of listeners) {
      try {
        target.removeEventListener(type, handler, options);
      } catch (err) {
        /* 忽略 */
      }
    }
    listeners.length = 0;
  }

  collection = createCollection(diameter);
  bindGlobalResets();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearResetTimers();
    unbindGlobalResets();
    applyInput(0, 0, 0, true);
    try {
      if (collection && typeof collection.destroy === 'function') collection.destroy();
    } catch (err) {
      /* nipplejs 销毁失败不影响后续 */
    }
    collection = null;
  }

  return { input, destroy, forceReset, setEnabled, syncSize };
}

export default createJoystick;
