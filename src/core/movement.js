/**
 * src/core/movement.js — 运动学核心（契约 §2.1）
 *
 * 设计约束（逐条对应 docs/CONTRACT.md §2.1）：
 *   - 纯函数模块：零依赖，不 import three，不触碰 window / document / performance。
 *   - `stepMovement` 纯：不修改传入的 state / input，内部 dt clamp 到 [0, 0.05]，返回新对象。
 *   - 位置 / 速度 / 朝向都用普通对象字段，方便单测与主循环直接读写。
 *
 * 坐标系 P（posterSpace）：
 *   地面 y = 0；x 向右为正；z 向"海报下方"为正；heading = 0 时面向 +Z，
 *   朝向向量 = (sin(heading), cos(heading))；three 里对应 rotation.y = heading。
 *   竖向平移时 up 的退化方向是 (0, -1)（屏幕上方 = 海报 -z 方向）。
 */

/** 调参表：数值与契约 §2.1 逐字一致，不要在别处硬编码这些数。 */
export const MOVE_TUNING = {
  walkSpeed: 0.32, // 海报宽度/秒
  runSpeed: 0.85, // 海报宽度/秒
  accel: 2.6, // 单位/秒²
  decel: 4.2, // 单位/秒²
  turnRate: 14, // 每秒朝向平滑系数（指数逼近）
  runThreshold: 0.62, // force 超过即 Run
  stopEpsilon: 0.02 // 速度低于此视为静止
};

const MAX_DT = 0.05;
const TAU = Math.PI * 2;
const EPS = 1e-9;

/** basis 退化值（契约：basis 为 null → right=(1,0)、up=(0,-1)） */
const FALLBACK_RIGHT = { x: 1, z: 0 };
const FALLBACK_UP = { x: 0, z: -1 };
/** bounds 缺失时的兜底（等于海报可活动矩形，margin 按 0 处理） */
const FALLBACK_BOUNDS = { halfX: 0.5, halfZ: 0.625, margin: 0 };

const GAITS = ['idle', 'walk', 'run'];

function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value, lo, hi) {
  const v = num(value, lo);
  if (!(hi >= lo)) return lo; // 区间倒置（margin > halfX）时收敛到 lo，避免出现反向 clamp
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/** 朝向角差归一到 [0, 2π) */
function wrapTau(angle) {
  const a = angle % TAU;
  return a < 0 ? a + TAU : a;
}

/**
 * 最短角差：把 (target - current) 折进 (-π, π]。
 * 契约给的写法：((target - heading + π) % 2π + 2π) % 2π - π
 */
function shortestAngleDelta(target, current) {
  return wrapTau(target - current + Math.PI) - Math.PI;
}

/** 朝 goal 逼近，单步最多移动 maxDelta（线性，避免瞬移） */
function approach(current, goal, maxDelta) {
  const delta = goal - current;
  const limit = Math.abs(maxDelta);
  if (delta > limit) return current + limit;
  if (delta < -limit) return current - limit;
  return goal;
}

/** force → 目标速度：单调递增，force ≥ runThreshold 时正好等于 runSpeed */
function speedForForce(force, tuning) {
  const threshold = Math.max(EPS, num(tuning.runThreshold, MOVE_TUNING.runThreshold));
  const k = clamp(force / threshold, 0, 1);
  const walk = num(tuning.walkSpeed, MOVE_TUNING.walkSpeed);
  const run = num(tuning.runSpeed, MOVE_TUNING.runSpeed);
  return walk + (run - walk) * k;
}

/** gait 判定：先看速度，再看 force（规则 6 / 规则 7） */
function gaitFor(speed, force, tuning) {
  if (speed < num(tuning.stopEpsilon, MOVE_TUNING.stopEpsilon)) return 'idle';
  if (force >= num(tuning.runThreshold, MOVE_TUNING.runThreshold)) return 'run';
  return 'walk';
}

/**
 * 创建运动状态（全新对象，gait 恒为 'idle'）。
 * @param {{x?:number, z?:number, heading?:number}} [opts]
 */
export function createMovementState({ x = 0, z = 0, heading = 0 } = {}) {
  return {
    x: num(x),
    z: num(z),
    vx: 0,
    vz: 0,
    heading: num(heading),
    speed: 0,
    gait: 'idle'
  };
}

/**
 * 原地复位（保留对象身份，主循环里 `state.movement` 引用不变）。
 * @param {object} state
 * @param {{x?:number, z?:number, heading?:number}} [opts]
 * @returns {object} 传入的同一个 state
 */
export function resetMovement(state, { x = 0, z = 0, heading = 0 } = {}) {
  const target = state && typeof state === 'object' ? state : {};
  target.x = num(x);
  target.z = num(z);
  target.vx = 0;
  target.vz = 0;
  target.heading = num(heading);
  target.speed = 0;
  target.gait = 'idle';
  return target;
}

/**
 * 推进一帧。纯函数：不修改 state / input / bounds / basis，返回新状态对象。
 *
 * @param {{x:number,z:number,vx:number,vz:number,heading:number,speed:number,gait:string}} state
 * @param {number} dt 实际经过秒数（内部 clamp 到 [0, 0.05]）
 * @param {{x:number,y:number,force:number}} input 摇杆输入（x 右正、y 上正、force 0..1）
 * @param {{halfX:number,halfZ:number,margin:number}} bounds 可活动矩形
 * @param {{right:{x:number,z:number}, up:{x:number,z:number}}|null} basis 屏幕对齐基
 * @param {typeof MOVE_TUNING} [tuning]
 * @returns {{x,z,vx,vz,heading,speed,gait,dirX,dirZ,moving}}
 */
export function stepMovement(state, dt, input, bounds, basis, tuning = MOVE_TUNING) {
  const s = state && typeof state === 'object' ? state : {};
  const tn = tuning && typeof tuning === 'object' ? tuning : MOVE_TUNING;

  const startX = num(s.x);
  const startZ = num(s.z);
  const startVx = num(s.vx);
  const startVz = num(s.vz);
  const heading0 = num(s.heading);

  // ---- 规则 1：dt clamp 到 [0, 0.05]；dt <= 0（含 NaN）原样返回 ----
  const stepDt = Number.isFinite(dt) ? clamp(dt, 0, MAX_DT) : 0;
  if (stepDt <= 0) {
    const speed = Math.hypot(startVx, startVz);
    const gait = GAITS.indexOf(s.gait) >= 0 ? s.gait : gaitFor(speed, 0, tn);
    return {
      x: startX,
      z: startZ,
      vx: startVx,
      vz: startVz,
      heading: heading0,
      speed,
      gait,
      dirX: Math.sin(heading0),
      dirZ: Math.cos(heading0),
      moving: gait !== 'idle'
    };
  }

  // ---- 规则 2a：把摇杆输入投影到海报平面并归一化 ----
  const inp = input && typeof input === 'object' ? input : {};
  const jx = clamp(num(inp.x), -1, 1);
  const jy = clamp(num(inp.y), -1, 1);
  // force 缺失时用摇杆位移长度兜底（键盘/滑杆调试时也能动）
  const rawForce = Number.isFinite(inp.force) ? inp.force : Math.hypot(jx, jy);
  const force = clamp(rawForce, 0, 1);

  const right = (basis && basis.right) || FALLBACK_RIGHT;
  const up = (basis && basis.up) || FALLBACK_UP;
  const moveX = num(right.x, FALLBACK_RIGHT.x) * jx + num(up.x, FALLBACK_UP.x) * jy;
  const moveZ = num(right.z, FALLBACK_RIGHT.z) * jx + num(up.z, FALLBACK_UP.z) * jy;
  const moveLen = Math.hypot(moveX, moveZ);

  const hasInput = force > 0 && moveLen > EPS;
  const dirX = hasInput ? moveX / moveLen : 0;
  const dirZ = hasInput ? moveZ / moveLen : 0;

  // ---- 规则 2b：force 决定目标速度（单调） ----
  const targetSpeed = hasInput ? speedForForce(force, tn) : 0;

  // ---- 规则 4：最短角差 + 指数逼近 ----
  let heading = heading0;
  if (hasInput) {
    const targetHeading = Math.atan2(dirX, dirZ); // heading=0 → +Z
    const delta = shortestAngleDelta(targetHeading, heading);
    const k = 1 - Math.exp(-Math.max(0, num(tn.turnRate, MOVE_TUNING.turnRate)) * stepDt);
    heading = heading + delta * k;
  }

  // ---- 规则 3：加速 / 减速，速度模长不超过目标速度 ----
  const accel = Math.max(0, num(tn.accel, MOVE_TUNING.accel));
  const decel = Math.max(0, num(tn.decel, MOVE_TUNING.decel));
  let vx = startVx;
  let vz = startVz;

  if (hasInput) {
    const goalVx = dirX * targetSpeed;
    const goalVz = dirZ * targetSpeed;
    const budget = accel * stepDt;
    vx = approach(vx, goalVx, budget);
    vz = approach(vz, goalVz, budget);
    const speedNow = Math.hypot(vx, vz);
    if (speedNow > targetSpeed && speedNow > EPS) {
      const scale = targetSpeed / speedNow;
      vx *= scale;
      vz *= scale;
    }
  } else {
    // 无输入：沿当前方向按 decel 归零，绝不反向
    const speedNow = Math.hypot(vx, vz);
    if (speedNow > EPS) {
      const next = Math.max(0, speedNow - decel * stepDt);
      const scale = next / speedNow;
      vx *= scale;
      vz *= scale;
    } else {
      vx = 0;
      vz = 0;
    }
  }

  // ---- 规则 5：位置积分后 clamp 到 bounds（含 margin），被夹的轴速度清零 ----
  const b = bounds && typeof bounds === 'object' ? bounds : FALLBACK_BOUNDS;
  const margin = Math.max(0, num(b.margin));
  const limitX = Math.max(0, num(b.halfX, FALLBACK_BOUNDS.halfX) - margin);
  const limitZ = Math.max(0, num(b.halfZ, FALLBACK_BOUNDS.halfZ) - margin);

  const rawX = startX + vx * stepDt;
  const rawZ = startZ + vz * stepDt;

  let x = rawX;
  if (rawX < -limitX) x = -limitX;
  else if (rawX > limitX) x = limitX;
  if (x !== rawX) vx = 0;

  let z = rawZ;
  if (rawZ < -limitZ) z = -limitZ;
  else if (rawZ > limitZ) z = limitZ;
  if (z !== rawZ) vz = 0;

  // ---- 规则 6 / 7：gait 由速度决定，静止时转向也仍然是 idle ----
  const speed = Math.hypot(vx, vz);
  const gait = gaitFor(speed, hasInput ? force : 0, tn);

  return {
    x,
    z,
    vx,
    vz,
    heading,
    speed,
    gait,
    dirX: Math.sin(heading),
    dirZ: Math.cos(heading),
    moving: gait !== 'idle'
  };
}
