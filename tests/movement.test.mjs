/**
 * tests/movement.test.mjs — src/core/movement.js 单元测试
 *
 * 运行：node --test tests/movement.test.mjs（= npm test）
 * 自包含：不依赖 DOM / three / 浏览器，只 import 被测模块。
 *
 * 覆盖契约 §2.1 的 7 条规则：
 *   dt clamp、加速/减速、边界 clamp + 速度清零、最短角转向、gait 三分支、
 *   basis 映射（含 basis = null 退化）、纯函数性（不修改入参）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MOVE_TUNING,
  createMovementState,
  resetMovement,
  stepMovement
} from '../src/core/movement.js';

const TAU = Math.PI * 2;
const EPS = 1e-9;

/** 主循环里实际使用的 bounds（与 src/main.js 一致） */
const BOUNDS = { halfX: 0.5, halfZ: 0.625, margin: 0.13 };
/**
 * 测加速度/稳态速度时用的"无限场地"：避免跑几秒后撞墙，
 * 撞墙会把该轴速度清零（规则 5），从而污染纯速度断言。
 */
const BOUNDS_OPEN = { halfX: 1e6, halfZ: 1e6, margin: 0 };
/** 单位基：屏幕右 = 海报 +x，屏幕上 = 海报 -z */
const BASIS = { right: { x: 1, z: 0 }, up: { x: 0, z: -1 } };
const NO_INPUT = { x: 0, y: 0, force: 0 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** 朝向角差归一到 [0, 2π) */
const wrapTau = (a) => ((a % TAU) + TAU) % TAU;
/** 最短角差，与实现同式但独立写一遍，避免"用实现验证实现" */
const shortestDelta = (target, current) => wrapTau(target - current + Math.PI) - Math.PI;

/** 连续推进 n 帧，返回 { state, trace } */
function run(state, n, dt, input, bounds = BOUNDS, basis = BASIS, tuning = MOVE_TUNING) {
  const trace = [];
  let s = state;
  for (let i = 0; i < n; i += 1) {
    s = stepMovement(s, dt, input, bounds, basis, tuning);
    trace.push(s);
  }
  return { state: s, trace };
}

/** 构造"已经跑满目标速度"的状态（用无限场地，避免撞墙清速度） */
function atFullSpeed(force, dt = 1 / 60) {
  const input = { x: 1, y: 0, force };
  const { state } = run(createMovementState({ x: 0, z: 0, heading: Math.PI / 2 }), 240, dt, input, BOUNDS_OPEN);
  return { state, input };
}

// ---------------------------------------------------------------- 基本形状

test('createMovementState 返回契约字段，初始为静止 idle', () => {
  const s = createMovementState({ x: 0.1, z: -0.2, heading: 0.5 });
  assert.equal(s.x, 0.1);
  assert.equal(s.z, -0.2);
  assert.equal(s.vx, 0);
  assert.equal(s.vz, 0);
  assert.equal(s.heading, 0.5);
  assert.equal(s.speed, 0);
  assert.equal(s.gait, 'idle');

  const d = createMovementState();
  assert.deepEqual(
    { x: d.x, z: d.z, heading: d.heading, gait: d.gait },
    { x: 0, z: 0, heading: 0, gait: 'idle' }
  );

  // MOVE_TUNING 与契约数值逐字一致
  assert.deepEqual(MOVE_TUNING, {
    walkSpeed: 0.32,
    runSpeed: 0.85,
    accel: 2.6,
    decel: 4.2,
    turnRate: 14,
    runThreshold: 0.62,
    stopEpsilon: 0.02
  });
});

test('stepMovement 返回对象含 x/z/vx/vz/heading/speed/gait/dirX/dirZ/moving', () => {
  const out = stepMovement(createMovementState(), 1 / 60, { x: 0, y: 1, force: 1 }, BOUNDS, BASIS);
  for (const key of ['x', 'z', 'vx', 'vz', 'heading', 'speed', 'gait', 'dirX', 'dirZ', 'moving']) {
    assert.ok(key in out, `缺少字段 ${key}`);
  }
  assert.equal(typeof out.moving, 'boolean');
  assert.ok(['idle', 'walk', 'run'].includes(out.gait));
  // dirX/dirZ 必须是单位朝向向量 (sin(heading), cos(heading))
  assert.ok(Math.abs(Math.hypot(out.dirX, out.dirZ) - 1) < 1e-9);
  assert.ok(Math.abs(out.dirX - Math.sin(out.heading)) < 1e-12);
  assert.ok(Math.abs(out.dirZ - Math.cos(out.heading)) < 1e-12);
});

// ---------------------------------------------------------------- 规则 1：dt clamp

test('dt clamp：dt=10 与 dt=0.05 结果完全一致（防切页后台跳变）', () => {
  const base = createMovementState({ x: 0, z: 0, heading: 0 });
  const input = { x: 1, y: 0, force: 1 };

  const huge = stepMovement(base, 10, input, BOUNDS, BASIS);
  const capped = stepMovement(base, 0.05, input, BOUNDS, BASIS);
  assert.deepEqual(huge, capped);

  // 单帧位移也必须 ≤ 0.05 * runSpeed（不得瞬移）
  const moved = Math.hypot(huge.x - base.x, huge.z - base.z);
  assert.ok(moved <= MOVE_TUNING.runSpeed * 0.05 + 1e-12, `单帧位移过大: ${moved}`);
});

test('dt clamp：dt=0（及负数 / NaN）原样返回，位置速度朝向都不变', () => {
  const prev = {
    x: 0.12,
    z: -0.34,
    vx: 0.2,
    vz: 0.1,
    heading: 1.1,
    speed: Math.hypot(0.2, 0.1),
    gait: 'walk'
  };
  const input = { x: 1, y: 1, force: 1 };

  for (const dt of [0, -1, -0.02, NaN, undefined]) {
    const out = stepMovement(prev, dt, input, BOUNDS, BASIS);
    assert.equal(out.x, prev.x, `dt=${dt} 时 x 被改动`);
    assert.equal(out.z, prev.z, `dt=${dt} 时 z 被改动`);
    assert.equal(out.vx, prev.vx, `dt=${dt} 时 vx 被改动`);
    assert.equal(out.vz, prev.vz, `dt=${dt} 时 vz 被改动`);
    assert.equal(out.heading, prev.heading, `dt=${dt} 时 heading 被改动`);
    assert.ok(Math.abs(out.speed - prev.speed) < 1e-12);
    assert.ok(Number.isFinite(out.dirX) && Number.isFinite(out.dirZ));
  }
});

// ---------------------------------------------------------------- 规则 2/3：加速与减速

test('加速单调：满力推进时 speed 单调不减，且始终不超过目标速度', () => {
  const { trace } = run(createMovementState(), 120, 1 / 60, { x: 1, y: 0, force: 1 }, BOUNDS_OPEN);
  let prev = -Infinity;
  for (const s of trace) {
    assert.ok(s.speed >= prev - 1e-12, `speed 出现回落: ${prev} → ${s.speed}`);
    assert.ok(s.speed <= MOVE_TUNING.runSpeed + 1e-9, `speed 超上限: ${s.speed}`);
    prev = s.speed;
  }
  // 单帧速度增量不超过 accel * dt
  assert.ok(trace[0].speed <= MOVE_TUNING.accel / 60 + 1e-9);
  // 足够多帧后收敛到 runSpeed
  assert.ok(Math.abs(trace[trace.length - 1].speed - MOVE_TUNING.runSpeed) < 1e-6);
});

test('松手减速：无输入时 speed 单调降到 0，且不反向', () => {
  const { state: full } = atFullSpeed(1);
  assert.ok(Math.abs(full.speed - MOVE_TUNING.runSpeed) < 1e-6);

  let s = full;
  let prev = s.speed;
  for (let i = 0; i < 120; i += 1) {
    s = stepMovement(s, 1 / 60, NO_INPUT, BOUNDS_OPEN, BASIS);
    assert.ok(s.speed <= prev + 1e-12, `减速过程 speed 反而上升: ${prev} → ${s.speed}`);
    prev = s.speed;
    if (s.speed === 0) break;
  }
  assert.equal(s.speed, 0, '松手后必须完全停住');
  assert.equal(s.vx, 0);
  assert.equal(s.vz, 0);
  assert.equal(s.gait, 'idle');
  assert.equal(s.moving, false);

  // 停住后再推进，位置不再变化
  const still = stepMovement(s, 1 / 60, NO_INPUT, BOUNDS_OPEN, BASIS);
  assert.equal(still.x, s.x);
  assert.equal(still.z, s.z);
  assert.equal(still.speed, 0);
});

test('walk 稳态速度低于 run 稳态速度', () => {
  const walk = atFullSpeed(0.4).state; // force < runThreshold → walk 档
  const run2 = atFullSpeed(1).state; // force >= runThreshold → run 档
  assert.equal(walk.gait, 'walk');
  assert.equal(run2.gait, 'run');
  assert.ok(run2.speed > walk.speed, `run ${run2.speed} 应大于 walk ${walk.speed}`);
});

test('force 单调性：目标速度随 force 单调不减，force 很大时等于 runSpeed', () => {
  const speeds = [];
  for (const force of [0.05, 0.2, 0.4, 0.62, 0.8, 1]) {
    const { state } = run(createMovementState(), 600, 1 / 60, { x: 1, y: 0, force }, BOUNDS_OPEN);
    speeds.push(state.speed);
  }
  for (let i = 1; i < speeds.length; i += 1) {
    assert.ok(speeds[i] >= speeds[i - 1] - 1e-9, `force 递增时速度回落: ${speeds}`);
  }
  assert.ok(Math.abs(speeds[speeds.length - 1] - MOVE_TUNING.runSpeed) < 1e-6);
  // 任何力度下都不超过 runSpeed
  for (const v of speeds) assert.ok(v <= MOVE_TUNING.runSpeed + 1e-9);
  // force 超过 1 也不炸（摇杆 force 未 clamp 时上层已 min(1)，这里再兜一层）
  const over = run(createMovementState(), 600, 1 / 60, { x: 1, y: 0, force: 5 }, BOUNDS_OPEN).state;
  assert.ok(over.speed <= MOVE_TUNING.runSpeed + 1e-9);
  assert.equal(over.gait, 'run');
});

// ---------------------------------------------------------------- 规则 4：最短角转向

test('最短角转向：3.0 rad → -3.0 rad 走近路（跨过 ±π，而不是绕一整圈）', () => {
  const target = -3.0;
  const startHeading = 3.0;
  const expectedShort = Math.abs(shortestDelta(target, startHeading)); // ≈ 0.283
  assert.ok(expectedShort < 0.5, '前置：理论上应该走短弧');

  // 让朝向指向 -3.0 rad 的世界方向：dir = (sin(-3), cos(-3))，用 basis=null + 输入反解
  // 更直接的做法：自定义 basis，使 move 方向就是该世界方向。
  const dirX = Math.sin(target);
  const dirZ = Math.cos(target);
  const basis = { right: { x: dirX, z: dirZ }, up: { x: 0, z: 0 } };
  const input = { x: 1, y: 0, force: 0.5 };

  const dt = 1 / 60;
  const s0 = createMovementState({ heading: startHeading });
  let s = stepMovement(s0, dt, input, BOUNDS, basis);
  // 第一步必须朝正方向（3.0 → 3.14+）走，即跨过 π
  assert.ok(s.heading > startHeading, `应走近路(增大 heading)，实际 ${s.heading}`);
  // 剩余角差必须变小（按最短角距度量）
  assert.ok(
    Math.abs(shortestDelta(target, s.heading)) < Math.abs(shortestDelta(target, startHeading)),
    '第一步之后最短角距没有变小'
  );

  // 收敛到目标（允许 ±2π 等价）
  for (let i = 0; i < 200; i += 1) s = stepMovement(s, dt, input, BOUNDS, basis);
  assert.ok(Math.abs(shortestDelta(target, s.heading)) < 1e-3, `未收敛: ${s.heading}`);

  // 累计转过的角度必须接近短弧，不能接近长弧（5.999）
  let total = 0;
  let cur = createMovementState({ heading: startHeading });
  for (let i = 0; i < 200; i += 1) {
    const next = stepMovement(cur, dt, input, BOUNDS, basis);
    total += Math.abs(next.heading - cur.heading);
    cur = next;
  }
  assert.ok(Math.abs(total - expectedShort) < 0.02, `累计转角 ${total} 应≈${expectedShort}`);
  assert.ok(total < 1, `累计转角 ${total} 不应该是长弧`);
});

test('转向平滑：单帧 heading 变化受 turnRate 指数系数约束，不瞬转到目标', () => {
  const dt = 1 / 60;
  const basis = { right: { x: 1, z: 0 }, up: { x: 0, z: 0 } }; // 目标 heading = π/2
  const s0 = createMovementState({ heading: 0 });
  const s1 = stepMovement(s0, dt, { x: 1, y: 0, force: 0.5 }, BOUNDS, basis);
  const target = Math.PI / 2; // 与起点差 90°，方向唯一，不会踩到 ±π 的对称歧义
  const k = 1 - Math.exp(-MOVE_TUNING.turnRate * dt);
  const expected = 0 + target * k;
  assert.ok(Math.abs(s1.heading - expected) < 1e-9, `heading=${s1.heading} 期望${expected}`);
  assert.ok(Math.abs(s1.heading - target) > 0.1, '不应一步到位');
  assert.ok(s1.heading > 0 && s1.heading < target, '应朝目标单调推进');

  // dt 翻倍时单帧转角也要更大（指数逼近对 dt 单调）
  const s2 = stepMovement(s0, dt * 2, { x: 1, y: 0, force: 0.5 }, BOUNDS, basis);
  assert.ok(s2.heading > s1.heading, 'dt 更大时单帧应转得更多');
});

// ---------------------------------------------------------------- 规则 5：边界 clamp

test('边界 clamp：撞到 ±x / ±z 时位置被夹住且该轴速度分量清零', () => {
  const margin = 0.1;
  const bounds = { halfX: 0.5, halfZ: 0.625, margin };
  const limX = bounds.halfX - margin;
  const limZ = bounds.halfZ - margin;

  // +x 方向：从内部出发一直推，最终夹在 limX
  let s = createMovementState({ x: limX - 0.05, z: 0, heading: Math.PI / 2 });
  for (let i = 0; i < 60; i += 1) {
    s = stepMovement(s, 1 / 60, { x: 1, y: 0, force: 1 }, bounds, BASIS);
  }
  assert.ok(Math.abs(s.x - limX) < 1e-9, `x=${s.x} 应夹到 ${limX}`);
  assert.equal(s.vx, 0, '被夹住的 x 轴速度必须清零');
  assert.ok(s.x <= limX + 1e-12);

  // -x 方向
  let sx = createMovementState({ x: -limX + 0.05, z: 0, heading: -Math.PI / 2 });
  for (let i = 0; i < 60; i += 1) {
    sx = stepMovement(sx, 1 / 60, { x: -1, y: 0, force: 1 }, bounds, BASIS);
  }
  assert.ok(Math.abs(sx.x + limX) < 1e-9, `x=${sx.x} 应夹到 -${limX}`);
  assert.equal(sx.vx, 0);

  // +z（屏幕上 = -z，所以用 y=-1 走 +z）
  let sz = createMovementState({ x: 0, z: limZ - 0.05, heading: 0 });
  for (let i = 0; i < 60; i += 1) {
    sz = stepMovement(sz, 1 / 60, { x: 0, y: -1, force: 1 }, bounds, BASIS);
  }
  assert.ok(Math.abs(sz.z - limZ) < 1e-9, `z=${sz.z} 应夹到 ${limZ}`);
  assert.equal(sz.vz, 0, '被夹住的 z 轴速度必须清零');

  // -z
  let szn = createMovementState({ x: 0, z: -limZ + 0.05, heading: Math.PI });
  for (let i = 0; i < 60; i += 1) {
    szn = stepMovement(szn, 1 / 60, { x: 0, y: 1, force: 1 }, bounds, BASIS);
  }
  assert.ok(Math.abs(szn.z + limZ) < 1e-9, `z=${szn.z} 应夹到 -${limZ}`);
  assert.equal(szn.vz, 0);
});

test('边界 clamp 是逐轴独立的：贴 x 墙滑 z 时 z 轴保留速度', () => {
  const margin = 0.1;
  const bounds = { halfX: 0.5, halfZ: 0.625, margin };
  const limX = bounds.halfX - margin;
  // 斜向推：x 方向已顶墙，z 方向还应能滑
  const diag = { x: 1, y: -1, force: 1 };
  let s = createMovementState({ x: limX, z: 0, heading: 0 });
  for (let i = 0; i < 30; i += 1) {
    s = stepMovement(s, 1 / 60, diag, bounds, BASIS);
  }
  assert.ok(Math.abs(s.x - limX) < 1e-9);
  assert.equal(s.vx, 0, 'x 轴速度清零');
  assert.ok(s.z > 0.05, `z 轴应沿墙滑动，实际 z=${s.z}`);
  assert.ok(Math.abs(s.vz) > 1e-6, 'z 轴速度应保留');
});

// ---------------------------------------------------------------- 规则 6/7：gait

test('gait 三分支：无输入 idle / 小于阈值 walk / 大于阈值 run', () => {
  const idle = stepMovement(createMovementState(), 1 / 60, NO_INPUT, BOUNDS, BASIS);
  assert.equal(idle.gait, 'idle');

  const walk = run(createMovementState(), 60, 1 / 60, { x: 1, y: 0, force: 0.3 }, BOUNDS_OPEN).state;
  assert.equal(walk.gait, 'walk');
  assert.ok(walk.speed >= MOVE_TUNING.stopEpsilon);

  const runGait = run(createMovementState(), 60, 1 / 60, { x: 1, y: 0, force: 0.9 }, BOUNDS_OPEN).state;
  assert.equal(runGait.gait, 'run');

  // 边界值：正好等于 runThreshold → run
  const edge = run(
    createMovementState(),
    60,
    1 / 60,
    {
      x: 1,
      y: 0,
      force: MOVE_TUNING.runThreshold
    },
    BOUNDS_OPEN
  ).state;
  assert.equal(edge.gait, 'run');

  // 速度掉到 stopEpsilon 以下 → 立刻 idle（哪怕 force 仍然很大但没有位移）
  const stopped = { x: 0, z: 0, vx: 0, vz: 0, heading: 0, speed: 0, gait: 'run' };
  const out = stepMovement(stopped, 1 / 60, NO_INPUT, BOUNDS, BASIS);
  assert.equal(out.gait, 'idle');
});

test('规则 7：静止但朝向仍在变时 gait 仍然是 idle', () => {
  // 极小 dt：速度还没攒起来（< stopEpsilon），但朝向已经明显转了一步
  const dt = 0.001;
  const s0 = createMovementState({ heading: 0 });
  const basis = { right: { x: 1, z: 0 }, up: { x: 0, z: 0 } }; // 目标 heading = π/2
  const s1 = stepMovement(s0, dt, { x: 1, y: 0, force: 1 }, BOUNDS, basis);

  assert.ok(s1.speed > 0 && s1.speed < MOVE_TUNING.stopEpsilon, `speed=${s1.speed} 应低于 stopEpsilon`);
  assert.ok(Math.abs(s1.heading - s0.heading) > 1e-3, 'heading 应该已经变化');
  assert.equal(s1.gait, 'idle', '速度低于 stopEpsilon 时必须 idle');
  assert.equal(s1.moving, false);
});

// ---------------------------------------------------------------- basis 映射

test('basis 旋转 90° 后，同样的摇杆输入对应新的世界方向', () => {
  const dt = 1 / 60;
  const input = { x: 1, y: 0, force: 1 }; // 一直往"屏幕右"

  // 身份基：屏幕右 = 海报 +x → heading ≈ +π/2
  const plain = run(createMovementState(), 90, dt, input, BOUNDS, BASIS).state;
  assert.ok(Math.abs(shortestDelta(Math.PI / 2, plain.heading)) < 1e-2, `heading=${plain.heading}`);
  assert.ok(plain.x > 0.05, '应沿 +x 位移');

  // 旋转 90°：屏幕右 = 海报 +z → heading ≈ 0
  const rotated = { right: { x: 0, z: 1 }, up: { x: 1, z: 0 } };
  const turned = run(createMovementState(), 90, dt, input, BOUNDS, rotated).state;
  assert.ok(Math.abs(shortestDelta(0, turned.heading)) < 1e-2, `heading=${turned.heading}`);
  assert.ok(turned.z > 0.05, '应沿 +z 位移');
  assert.ok(Math.abs(turned.x) < 1e-6, 'x 方向不应位移');

  // 屏幕"上"(y=1) 在身份基里 = 海报 -z → heading ≈ π
  const up = run(createMovementState(), 90, dt, { x: 0, y: 1, force: 1 }, BOUNDS, BASIS).state;
  assert.ok(Math.abs(shortestDelta(Math.PI, up.heading)) < 1e-2);
  assert.ok(up.z < -0.05, '屏幕上方应走向 -z');
});

test('basis = null 退化：right=(1,0)、up=(0,-1)', () => {
  const dt = 1 / 60;
  // 向右推
  const right = run(createMovementState(), 90, dt, { x: 1, y: 0, force: 1 }, BOUNDS, null).state;
  assert.ok(Math.abs(shortestDelta(Math.PI / 2, right.heading)) < 1e-2);
  assert.ok(right.x > 0.05);
  // 向上推 = 海报 -z
  const up = run(createMovementState(), 90, dt, { x: 0, y: 1, force: 1 }, BOUNDS, null).state;
  assert.ok(Math.abs(shortestDelta(Math.PI, up.heading)) < 1e-2);
  assert.ok(up.z < -0.05);
  // basis = null 必须与显式退化基完全等价
  const a = stepMovement(createMovementState(), dt * 7, { x: 0.6, y: 0.8, force: 0.7 }, BOUNDS, null);
  const b = stepMovement(createMovementState(), dt * 7, { x: 0.6, y: 0.8, force: 0.7 }, BOUNDS, {
    right: { x: 1, z: 0 },
    up: { x: 0, z: -1 }
  });
  assert.deepEqual(a, b);
  // 空对象 basis 也走退化分支，不抛错
  const c = stepMovement(createMovementState(), dt, { x: 1, y: 0, force: 1 }, BOUNDS, {});
  assert.ok(Number.isFinite(c.heading));
});

// ---------------------------------------------------------------- 纯函数性

test('纯函数性：传入的 state / input / bounds / basis 均未被修改，且返回新对象', () => {
  const state = { x: 0.05, z: -0.1, vx: 0.3, vz: 0.2, heading: 2.5, speed: Math.hypot(0.3, 0.2), gait: 'walk' };
  const input = { x: 0.4, y: 0.6, force: 0.8 };
  const bounds = { halfX: 0.5, halfZ: 0.625, margin: 0.13 };
  const basis = { right: { x: 0, z: 1 }, up: { x: 1, z: 0 } };

  const snapshot = JSON.stringify({ state, input, bounds, basis });
  const out = stepMovement(state, 1 / 60, input, bounds, basis);
  assert.equal(JSON.stringify({ state, input, bounds, basis }), snapshot, '入参被修改了');

  assert.notEqual(out, state, '必须返回新对象');
  assert.notEqual(out.x, undefined);
  // 连续多帧也不应污染入参
  let s = state;
  for (let i = 0; i < 20; i += 1) s = stepMovement(s, 1 / 60, input, bounds, basis);
  assert.equal(JSON.stringify({ state, input, bounds, basis }), snapshot, '多帧后入参被修改了');
});

test('resetMovement 原地复位（保留对象身份），速度/gait 归零', () => {
  const s = createMovementState({ x: 0.3, z: 0.2, heading: 1 });
  const dirty = stepMovement(s, 1 / 60, { x: 1, y: 0, force: 1 }, BOUNDS, BASIS);
  assert.ok(dirty.speed > 0);

  const out = resetMovement(dirty, { x: 0, z: 0.12, heading: Math.PI });
  assert.equal(out, dirty, 'resetMovement 应返回同一个对象');
  assert.equal(dirty.x, 0);
  assert.equal(dirty.z, 0.12);
  assert.equal(dirty.vx, 0);
  assert.equal(dirty.vz, 0);
  assert.equal(dirty.heading, Math.PI);
  assert.equal(dirty.speed, 0);
  assert.equal(dirty.gait, 'idle');

  // 复位后当帧推进不应出现 NaN
  const next = stepMovement(dirty, 1 / 60, NO_INPUT, BOUNDS, BASIS);
  for (const key of ['x', 'z', 'vx', 'vz', 'heading', 'speed']) {
    assert.ok(Number.isFinite(next[key]), `${key} 非有限值`);
  }
  // 位置不会被重置逻辑拉回来
  assert.equal(next.x, 0);
  assert.equal(next.z, 0.12);
});

// ---------------------------------------------------------------- 鲁棒性

test('鲁棒性：缺省 bounds / input 不抛错，位置始终留在合法矩形内', () => {
  const out = stepMovement(createMovementState(), 1 / 60, undefined, undefined, undefined);
  assert.ok(Number.isFinite(out.x) && Number.isFinite(out.z));

  let s = createMovementState();
  const input = { x: 1, y: -1, force: 1 };
  for (let i = 0; i < 600; i += 1) {
    s = stepMovement(s, 1 / 30, input, BOUNDS, BASIS);
    assert.ok(Math.abs(s.x) <= BOUNDS.halfX - BOUNDS.margin + 1e-9, `x 越界: ${s.x}`);
    assert.ok(Math.abs(s.z) <= BOUNDS.halfZ - BOUNDS.margin + 1e-9, `z 越界: ${s.z}`);
    assert.ok(Number.isFinite(s.heading) && Number.isFinite(s.speed));
    assert.ok(s.speed <= MOVE_TUNING.runSpeed + 1e-9);
  }
  // heading 归一化后仍在有限范围，dirX/dirZ 单位长
  assert.ok(Math.abs(Math.hypot(s.dirX, s.dirZ) - 1) < 1e-9);
});
