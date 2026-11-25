import * as THREE from 'three';

/**
 * 漂浮花瓣（Petals）
 * ------------------------------------------------------------------
 * 契约：docs/CONTRACT.md §2.4
 *   export function createPetals({ count = 42, area = { halfX: 0.5, halfZ: 0.625 } })
 *   → { object3D, update(dt, { visible, speedRatio, x, z, heading }), burst(n = 14) }
 *
 * 坐标系：posterSpace（P，§1.2）。1 单位 = 海报宽度，地面 y = 0。
 * 几何：THREE.Shape 画的单枚花瓣 → ShapeGeometry（不用 ExtrudeGeometry，省面数）。
 *       花瓣在 XY 平面、法线 +Z，故绕 X 轴 -90° 后即"平躺"朝上；每帧只叠一个绕 Y 的自转。
 * 实例化：整个系统 1 个 InstancedMesh（count 片花瓣）+ instanceColor 上色，
 *         frustumCulled = false（实例包围球不随实例更新，必须关掉剔除）。
 * 性能：42 实例 ≈ 42 × ~60 三角形；每帧仅写 instanceMatrix + 1 次
 *       instanceMatrix.needsUpdate，无 new、无数组扩容、无 GC 抖动。
 */

const MAX_DT = 0.1;
const GRAVITY = -0.95; // 单位/秒²（海报宽度）
const TERMINAL_FALL = 0.115; // 终端下落速度（缓慢飘落）
const CEIL = 0.58;
const FLOOR = 0.012;
const MIN_COUNT = 6;
const MAX_COUNT = 96;

// 泥咕咕彩绘配色（§0）：红 / 黄 / 米白 / 青蓝
const PALETTE = [0xd8382f, 0xf2c230, 0xf5ebdc, 0x1b7a8c];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);

function clampDt(dt) {
  const v = Number(dt);
  if (!Number.isFinite(v)) return 0;
  return Math.min(Math.max(v, 0), MAX_DT);
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 单枚花瓣轮廓：水滴形（圆钝的根部 + 微微回勾的尖），用两段三次贝塞尔。
 * 尺寸约 1×1 单位，由实例 matrix 缩放到 ~0.02 实际大小。
 */
function makePetalShape() {
  const s = new THREE.Shape();
  s.moveTo(0, -0.5); // 根部（圆钝）
  s.bezierCurveTo(0.42, -0.42, 0.46, 0.12, 0.16, 0.46); // 右缘 → 尖
  s.bezierCurveTo(0.06, 0.56, 0.02, 0.5, 0, 0.5); // 尖部收口
  s.bezierCurveTo(-0.02, 0.5, -0.06, 0.56, -0.16, 0.46);
  s.bezierCurveTo(-0.46, 0.12, -0.42, -0.42, 0, -0.5); // 左缘回到根部
  return s;
}

/**
 * @param {{ count?: number, area?: { halfX?: number, halfZ?: number } }} [options]
 */
export function createPetals({ count = 42, area = { halfX: 0.5, halfZ: 0.625 } } = {}) {
  const total = Math.round(clamp(num(count, 42), MIN_COUNT, MAX_COUNT));
  const halfX = Math.abs(num(area && area.halfX, 0.5)) || 0.5;
  const halfZ = Math.abs(num(area && area.halfZ, 0.625)) || 0.625;

  const object3D = new THREE.Group();
  object3D.name = 'Petals';

  const geometry = new THREE.ShapeGeometry(makePetalShape(), 8);

  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff, // 真实颜色来自 instanceColor
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide, // 花瓣翻面也要能看见
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
  });
  material.opacity = 0; // 首帧淡入

  const mesh = new THREE.InstancedMesh(geometry, material, total);
  mesh.name = 'PetalsInstanced';
  mesh.frustumCulled = false; // 必须：实例位置每帧变化，包围球不会跟着算
  mesh.renderOrder = 2;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  object3D.add(mesh);

  // ---------- 每片花瓣的状态：全部预分配（typed array，零 GC） ----------
  const px = new Float32Array(total);
  const py = new Float32Array(total);
  const pz = new Float32Array(total);
  const vy = new Float32Array(total);
  const spin = new Float32Array(total); // 自转角
  const spinSpeed = new Float32Array(total); // 自转角速度
  const swayPhase = new Float32Array(total);
  const swayFreq = new Float32Array(total);
  const swayAmp = new Float32Array(total);
  const tiltX = new Float32Array(total); // 固定小倾角（不许完全侧立，否则顶视角会消失）
  const tiltZ = new Float32Array(total);
  const scaleArr = new Float32Array(total);
  const active = new Uint8Array(total); // 1 = 参与绘制

  const colorScratch = new THREE.Color();

  function spawnFresh(i, initial) {
    px[i] = (Math.random() * 2 - 1) * halfX * 0.98;
    pz[i] = (Math.random() * 2 - 1) * halfZ * 0.98;
    py[i] = initial ? FLOOR + Math.random() * (CEIL - FLOOR) : 0.4 + Math.random() * (CEIL - 0.4);
    vy[i] = -TERMINAL_FALL * (0.55 + Math.random() * 0.6);
    spin[i] = Math.random() * Math.PI * 2;
    spinSpeed[i] = (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 1.7);
    swayPhase[i] = Math.random() * Math.PI * 2;
    swayFreq[i] = 0.5 + Math.random() * 1.1;
    swayAmp[i] = 0.05 + Math.random() * 0.085;
    tiltX[i] = (Math.random() * 2 - 1) * 0.42;
    tiltZ[i] = (Math.random() * 2 - 1) * 0.42;
    scaleArr[i] = 0.016 + Math.random() * 0.013;
    active[i] = 1;

    const c = PALETTE[(Math.random() * PALETTE.length) | 0];
    colorScratch.setHex(c);
    mesh.setColorAt(i, colorScratch);
  }

  for (let i = 0; i < total; i += 1) spawnFresh(i, true);
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  // ---------- 复用的临时对象（每帧复用，绝不 new） ----------
  const mat = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const axisY = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scaleVec = new THREE.Vector3();
  const eulerScratch = new THREE.Euler();

  let elapsed = 0;
  let fade = 0; // 0..1 整体淡入淡出
  let lastX = 0;
  let lastZ = 0;
  let lastHeading = 0;
  let lastSpeed = 0;
  let burstLeft = 0; // burst 冷却（秒），期间允许更高的上浮能量

  // 花瓣几何在 XY 平面、法线 +Z：先绕 X 转 -90° 变成"平躺朝上"
  const axisX = new THREE.Vector3(1, 0, 0);
  const quatFlat = new THREE.Quaternion().setFromAxisAngle(axisX, -Math.PI / 2);
  const quatLocal = new THREE.Quaternion();
  const quatTiltFixed = new THREE.Quaternion();

  /** 热路径：写一片花瓣的 instanceMatrix（全部复用临时对象，无 new） */
  function writeInstance(i) {
    quatLocal.setFromEuler(eulerScratch.set(tiltX[i], 0, tiltZ[i], 'YXZ'));
    quatTiltFixed.copy(quatFlat).multiply(quatLocal); // 先平躺再微倾
    quat.setFromAxisAngle(axisY, spin[i]).multiply(quatTiltFixed); // 再整体自转
    pos.set(px[i], py[i], pz[i]);
    const s = active[i] ? scaleArr[i] : 0;
    scaleVec.set(s, s, s);
    mat.compose(pos, quat, scaleVec);
    mesh.setMatrixAt(i, mat);
  }

  // 构造函数里先写一遍矩阵，首帧不会出现"零缩放"的空实例
  for (let i = 0; i < total; i += 1) writeInstance(i);
  mesh.instanceMatrix.needsUpdate = true;

  /**
   * @param {number} dt 秒
   * @param {{ visible?: boolean, speedRatio?: number, x?: number, z?: number, heading?: number }} [ctx]
   */
  function update(dt, ctx) {
    const c = ctx || {};
    const d = clampDt(dt);
    if (d <= 0) return;

    const visible = c.visible !== false;

    if (!visible) {
      // 识别丢失：停止一切移动/生成，只做整体淡出
      fade = Math.max(0, fade - d * 4.0);
      material.opacity = fade * 0.95;
      if (fade <= 0) {
        mesh.visible = false;
        object3D.visible = false;
      }
      return;
    }

    if (!mesh.visible) mesh.visible = true;
    object3D.visible = true;
    fade = Math.min(1, fade + d * 3.2);
    material.opacity = fade * 0.95;

    const charX = num(c.x, lastX);
    const charZ = num(c.z, lastZ);
    const heading = num(c.heading, lastHeading);
    const speed = clamp01(num(c.speedRatio, 0));
    lastX = charX;
    lastZ = charZ;
    lastHeading = heading;
    lastSpeed = speed;

    elapsed += d;
    if (burstLeft > 0) burstLeft = Math.max(0, burstLeft - d);

    // 速度越快，花瓣被"气流"带得越高
    const lift = speed * 0.19 + (burstLeft > 0 ? 0.32 : 0);
    // 围绕角色的轻微旋转（速度越快越明显）
    const swirl = speed * 1.35;
    const swirlRadius = 0.34;

    for (let i = 0; i < total; i += 1) {
      if (!active[i]) continue;

      // --- 垂直：重力 + 终端速度 + 气流上浮 ---
      vy[i] += GRAVITY * d;
      if (vy[i] < -TERMINAL_FALL) vy[i] = -TERMINAL_FALL;
      if (vy[i] > 1.6) vy[i] = 1.6;
      py[i] += vy[i] * d + lift * d;

      // 上浮不能飘出海报上空
      if (py[i] > CEIL) {
        py[i] = CEIL;
        if (vy[i] > 0) vy[i] = 0;
      }

      // --- 水平：自身摆动（正弦漂移） ---
      const sway = Math.sin(elapsed * swayFreq[i] + swayPhase[i]) * swayAmp[i];
      px[i] += sway * d;
      pz[i] += Math.cos(elapsed * swayFreq[i] * 0.83 + swayPhase[i]) * swayAmp[i] * 0.7 * d;

      // --- 围绕角色的轻微旋转（只在角色附近起作用） ---
      if (swirl > 0.01) {
        const dx = px[i] - charX;
        const dz = pz[i] - charZ;
        const dist2 = dx * dx + dz * dz;
        const dist = Math.sqrt(dist2) || 1e-4;
        if (dist < swirlRadius) {
          const w = (1 - dist / swirlRadius) * swirl * d;
          px[i] += (-dz / dist) * w * 0.55;
          pz[i] += (dx / dist) * w * 0.55;
        }
      }

      // --- 自转 ---
      spin[i] += spinSpeed[i] * d * (1 + speed * 0.9);

      // --- 出界回卷（海报范围外从对面进来，避免花瓣"消失"） ---
      const limX = halfX * 1.02;
      const limZ = halfZ * 1.02;
      if (px[i] > limX) px[i] = -limX;
      else if (px[i] < -limX) px[i] = limX;
      if (pz[i] > limZ) pz[i] = -limZ;
      else if (pz[i] < -limZ) pz[i] = limZ;

      // --- 落地重置到高处随机位置 ---
      if (py[i] < FLOOR) {
        py[i] = 0.42 + Math.random() * (CEIL - 0.42);
        px[i] = (Math.random() * 2 - 1) * halfX * 0.98;
        pz[i] = (Math.random() * 2 - 1) * halfZ * 0.98;
        vy[i] = -TERMINAL_FALL * (0.5 + Math.random() * 0.5);
        swayPhase[i] = Math.random() * Math.PI * 2;
        scaleArr[i] = 0.016 + Math.random() * 0.013;
      }

      writeInstance(i);
    }

    mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * 在角色附近喷出 n 枚花瓣（跳跃落地 / 欢呼）。
   * @param {number} [n] 数量
   * @param {{ x?: number, z?: number }} [at] 可选目标位置；缺省用最近一次 update 的 x/z
   */
  function burst(n = 14, at) {
    const want = Math.round(clamp(num(n, 14), 1, total));
    const src = at && Number.isFinite(Number(at.x)) && Number.isFinite(Number(at.z)) ? at : null;
    const bx = src ? Number(src.x) : lastX;
    const bz = src ? Number(src.z) : lastZ;

    for (let k = 0; k < want; k += 1) {
      const i = k % total;
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.random() * 0.1;
      px[i] = clamp(bx + Math.cos(ang) * rad, -halfX, halfX);
      pz[i] = clamp(bz + Math.sin(ang) * rad, -halfZ, halfZ);
      py[i] = 0.1 + Math.random() * 0.2;
      vy[i] = 0.75 + Math.random() * 0.85; // 向上喷
      spinSpeed[i] = (Math.random() < 0.5 ? -1 : 1) * (2.2 + Math.random() * 3.4);
      swayPhase[i] = Math.random() * Math.PI * 2;
      swayFreq[i] = 0.9 + Math.random() * 1.4;
      swayAmp[i] = 0.14 + Math.random() * 0.18;
      scaleArr[i] = 0.019 + Math.random() * 0.014;
      active[i] = 1;
      colorScratch.setHex(PALETTE[(Math.random() * PALETTE.length) | 0]);
      mesh.setColorAt(i, colorScratch);
      writeInstance(i);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
    burstLeft = Math.max(burstLeft, 0.9);
    mesh.visible = true;
    object3D.visible = true;
  }

  /** 是否还有可见花瓣（调试用） */
  function getState() {
    let alive = 0;
    for (let i = 0; i < total; i += 1) if (active[i]) alive += 1;
    return { count: total, alive, opacity: material.opacity, speed: lastSpeed, elapsed };
  }

  function dispose() {
    object3D.remove(mesh);
    mesh.dispose();
    geometry.dispose();
    material.dispose();
    if (mesh.instanceColor) mesh.instanceColor = null;
  }

  return { object3D, mesh, material, update, burst, dispose, getState };
}
