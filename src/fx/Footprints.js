import * as THREE from 'three';

/**
 * 鸟爪脚印（Footprints）
 * ------------------------------------------------------------------
 * 契约：docs/CONTRACT.md §2.4
 *   export function createFootprints({ max = 24, area = { halfX: 0.5, halfZ: 0.625 } })
 *   → { object3D, update(dt, { visible, moving, gait, x, z, heading, stride }), clear() }
 *
 * 坐标系：posterSpace（P，§1.2）。1 单位 = 海报宽度，地面 y = 0；
 *         前进方向 = (sin(heading), 0, cos(heading))，左右偏移垂直于该方向。
 *
 * 做法：
 *   · 贴图：canvas 128×128 程序化画"三趾 + 掌垫"的鸟爪印（白色描边 + 实心填充两个
 *     透明度层次），再用每枚脚印的材质 color 染成 青蓝 → 红 → 黄 → 米白 轮换。
 *   · 几何：PlaneGeometry 平放（rotation.x = -π/2），单枚约 0.062 单位见方。
 *   · 池：构造时一次性建 max 个 mesh（复用，绝不在 update 里 new），
 *        每枚 5~7 秒生命期，前 55% 满不透明、之后线性淡出，回收进池。
 *   · visible === false：**绝不新增脚印**，已有脚印继续淡出回收（不 throw、不移动）。
 *
 * 性能：≤ max(24) 个可见小四边形（各自一次 draw call，均 frustumCulled），
 *       贴图共享 1 张，几何共享 1 个；update 里只有算术 + 少量属性赋值，无 GC。
 */

const MAX_DT = 0.1;
const BASE_Y = 0.003; // 贴地高度（防 z-fighting）
const TEX_SIZE = 128;
const PRINT_SIZE = 0.062; // 单枚脚印边长（单位 = 海报宽度）
const SIDE_OFFSET = 0.06; // 左右脚横向偏移
const STEP_WALK = 0.13; // 走：每 0.13 单位一枚
const STEP_RUN = 0.20; // 跑：每 0.20 单位一枚
const LIFE_MIN = 5.0; // 秒
const LIFE_MAX = 7.0; // 秒
const FADE_START = 0.55; // 寿命前 55% 不淡出
const MIN_MAX = 2;
const MAX_MAX = 48;
const PALETTE = [0x1b7a8c, 0xd8382f, 0xf2c230, 0xf5ebdc]; // 青蓝 → 红 → 黄 → 米白

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function clampDt(dt) {
  const v = Number(dt);
  if (!Number.isFinite(v)) return 0;
  return Math.min(Math.max(v, 0), MAX_DT);
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* ------------------------------------------------------------------ *
 * 贴图
 * ------------------------------------------------------------------ */

/** 沿二次贝塞尔铺一串圆点 —— 天然得到"由粗到细、尖端收口"的鸟趾 */
function taperStroke(ctx, x0, y0, cx, cy, x1, y1, r0, r1, alpha) {
  const steps = 16;
  ctx.globalAlpha = alpha;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const mt = 1 - t;
    const x = mt * mt * x0 + 2 * mt * t * cx + t * t * x1;
    const y = mt * mt * y0 + 2 * mt * t * cy + t * t * y1;
    const r = r0 + (r1 - r0) * t;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/**
 * 画一只鸟爪印：外层（alpha 0.95）是描边轮廓，内层缩到 0.74 并降到 alpha 0.38，
 * 形成"白色描边 + 实心填充"的双层彩绘感，同时颜色由材质 color 统一染色。
 */
function drawClaw(ctx, S, scale, alpha) {
  const cx = 64 * S;
  const cy = 64 * S;
  const put = (x, y) => [cx + (x * S - cx) * scale, cy + (y * S - cy) * scale];
  const k = (v) => v * S * scale;

  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#ffffff';

  // 掌垫（底部椭圆）
  const [px, py] = put(64, 96);
  ctx.beginPath();
  ctx.ellipse(px, py, k(20), k(13), 0, 0, Math.PI * 2);
  ctx.fill();

  // 三趾：中趾最长、两侧趾略微外撇（泥塑彩绘的手作不对称感）
  const [m0x, m0y] = put(64, 84);
  const [m1x, m1y] = put(64, 44);
  const [m2x, m2y] = put(64, 18);
  taperStroke(ctx, m0x, m0y, m1x, m1y, m2x, m2y, k(10), k(4.6), alpha);

  const [l0x, l0y] = put(56, 88);
  const [l1x, l1y] = put(34, 54);
  const [l2x, l2y] = put(25, 33);
  taperStroke(ctx, l0x, l0y, l1x, l1y, l2x, l2y, k(8.6), k(4.0), alpha);

  const [r0x, r0y] = put(72, 88);
  const [r1x, r1y] = put(94, 54);
  const [r2x, r2y] = put(103, 33);
  taperStroke(ctx, r0x, r0y, r1x, r1y, r2x, r2y, k(8.6), k(4.0), alpha);

  // 趾尖三颗小圆点（泥咕咕白点彩的收尾）
  ctx.beginPath();
  ctx.arc(m2x, m2y - k(1.5), k(3.4), 0, Math.PI * 2);
  ctx.arc(l2x, l2y - k(1.2), k(3.0), 0, Math.PI * 2);
  ctx.arc(r2x, r2y - k(1.2), k(3.0), 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = 1;
}

/** canvas 程序化鸟爪印贴图（无外部图片） */
function makeFootprintTexture() {
  const hasDom = typeof document !== 'undefined' && document && typeof document.createElement === 'function';
  if (hasDom) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = TEX_SIZE;
      canvas.height = TEX_SIZE;
      const ctx = canvas.getContext && canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
        const S = TEX_SIZE / 128; // 相对 128 设计稿缩放
        drawClaw(ctx, S, 1.0, 0.95); // 描边层（外轮廓）
        drawClaw(ctx, S, 0.74, 0.38); // 填充层（内缩，形成亮边）
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        return tex;
      }
    } catch (err) {
      // 继续走兜底
    }
  }
  return makeFallbackTexture();
}

/** 无 DOM（测试环境）时的兜底：程序化生成一个软边圆形脚印 */
function makeFallbackTexture() {
  const size = TEX_SIZE;
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - c) / (size * 0.34);
      const dy = (y - c) / (size * 0.38);
      const d = Math.sqrt(dx * dx + dy * dy);
      const a = d >= 1 ? 0 : d < 0.72 ? 1 : (1 - d) / 0.28;
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 235);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ *
 * 工厂
 * ------------------------------------------------------------------ */

/**
 * @param {{ max?: number, area?: { halfX?: number, halfZ?: number } }} [options]
 */
export function createFootprints({ max = 24, area = { halfX: 0.5, halfZ: 0.625 } } = {}) {
  const poolSize = Math.round(clamp(num(max, 24), MIN_MAX, MAX_MAX));
  const halfX = Math.abs(num(area && area.halfX, 0.5)) || 0.5;
  const halfZ = Math.abs(num(area && area.halfZ, 0.625)) || 0.625;

  const object3D = new THREE.Group();
  object3D.name = 'Footprints';

  const texture = makeFootprintTexture();
  const geometry = new THREE.PlaneGeometry(PRINT_SIZE, PRINT_SIZE);

  // ---- 池：一次性建好 max 个 mesh，之后只切换显示/属性 ----
  const slots = new Array(poolSize);
  for (let i = 0; i < poolSize; i += 1) {
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      color: 0xF5EBDC,
      transparent: true,
      opacity: 0,
      depthWrite: false, // 平铺贴地，不写深度
      toneMapped: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'Footprint' + i;
    mesh.rotation.x = -Math.PI / 2; // 平放贴地
    mesh.position.set(0, BASE_Y, 0);
    mesh.visible = false;
    mesh.renderOrder = 3;
    object3D.add(mesh);
    slots[i] = {
      mesh,
      material,
      active: false,
      age: 0,
      life: 1,
      baseOpacity: 1
    };
  }

  // ---- 运行态 ----
  let elapsed = 0;
  let travel = 0; // 累计移动距离（跨过 stride 就落一枚）
  let lastX = 0;
  let lastZ = 0;
  let lastHeading = 0;
  let side = 1; // 左右脚交替
  let colorCursor = 0;
  let spawned = 0;
  let dumped = 0; // 被挤出池（池满）的旧脚印计数，调试用

  const colorScratch = new THREE.Color();

  /** 找一枚可用槽位：优先空槽；池满则回收最老的一枚 */
  function acquireSlot() {
    let oldest = -1;
    let oldestScore = -1;
    for (let i = 0; i < poolSize; i += 1) {
      const s = slots[i];
      if (!s.active) return s;
      const score = s.age / s.life;
      if (score > oldestScore) {
        oldestScore = score;
        oldest = i;
      }
    }
    if (oldest >= 0) {
      dumped += 1;
      return slots[oldest];
    }
    return null;
  }

  /**
   * 落一枚脚印。
   * @param {number} x
   * @param {number} z
   * @param {number} heading
   */
  function place(x, z, heading) {
    const slot = acquireSlot();
    if (!slot) return;

    // 左右脚垂直于前进方向偏移：前进 (sin h, cos h) → 垂直 (cos h, -sin h)
    const ox = Math.cos(heading) * SIDE_OFFSET * side;
    const oz = -Math.sin(heading) * SIDE_OFFSET * side;
    side = -side;

    const px = clamp(x + ox, -halfX, halfX);
    const pz = clamp(z + oz, -halfZ, halfZ);

    slot.active = true;
    slot.age = 0;
    slot.life = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN);
    slot.baseOpacity = 0.62 + Math.random() * 0.24;

    // 泥塑彩绘配色轮换：青蓝 → 红 → 黄 → 米白
    colorScratch.setHex(PALETTE[colorCursor % PALETTE.length]);
    colorCursor = (colorCursor + 1) % PALETTE.length;
    slot.material.color.copy(colorScratch);
    slot.material.opacity = 0;

    slot.mesh.position.set(px, BASE_Y, pz);
    // 贴地 yaw：rotation.x 已经把平面放平，接着绕局部 Z 转 (heading + π)
    // 是因为"贴图上方"在放平后指向世界 -Z，补上 π 才让它朝着前进方向。
    slot.mesh.rotation.set(-Math.PI / 2, 0, heading + Math.PI + (Math.random() - 0.5) * 0.16);
    slot.mesh.scale.setScalar(0.72);
    slot.mesh.visible = true;
    spawned += 1;
  }

  /** 淡出 + 回收（visible=false 时也会走，已有脚印继续衰减） */
  function ageSlots(d) {
    for (let i = 0; i < poolSize; i += 1) {
      const s = slots[i];
      if (!s.active) continue;
      s.age += d;
      const t = s.age / s.life;
      if (t >= 1) {
        s.active = false;
        s.mesh.visible = false;
        s.material.opacity = 0;
        continue;
      }
      // 入场轻微放大（0 → 0.18 秒），随后按寿命淡出
      const grow = s.age < 0.18 ? 0.72 + 0.28 * (s.age / 0.18) : 1;
      s.mesh.scale.setScalar(grow);
      let a;
      if (t <= FADE_START) {
        a = 1;
      } else {
        const u = (t - FADE_START) / (1 - FADE_START);
        a = 1 - u * u * (3 - 2 * u); // smoothstep 收尾，边缘更"化开"
      }
      s.material.opacity = s.baseOpacity * a;
    }
  }

  /**
   * @param {number} dt 秒
   * @param {{ visible?: boolean, moving?: boolean, gait?: string, x?: number, z?: number,
   *           heading?: number, stride?: number }} [ctx]
   */
  function update(dt, ctx) {
    const c = ctx || {};
    const d = clampDt(dt);
    if (d <= 0) return;

    // 已有脚印：无论可见与否都继续淡出回收
    ageSlots(d);

    const visible = c.visible !== false;
    const moving = c.moving === true && visible;

    const x = num(c.x, lastX);
    const z = num(c.z, lastZ);
    const heading = num(c.heading, lastHeading);

    if (!visible) {
      // 跟踪丢失：不新增脚印，只同步位置基准，恢复后不会补一串脚印
      lastX = x;
      lastZ = z;
      travel = 0;
      return;
    }

    // 累计位移；单帧位移异常大（重定位）视为瞬移，不落脚印
    const dx = x - lastX;
    const dz = z - lastZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    lastX = x;
    lastZ = z;
    lastHeading = heading;

    if (!moving) {
      travel = 0; // 停下时归零，下一步从脚边重新起算
      elapsed += d;
      return;
    }

    if (dist > 0.35) {
      travel = 0;
    } else if (dist > 0) {
      travel += dist;
    }

    const stepRaw = c.gait === 'run' ? STEP_RUN : num(c.stride, STEP_WALK);
    const step = clamp(stepRaw, 0.04, 0.45);

    let guard = 0;
    while (travel >= step && guard < 3) {
      travel -= step;
      guard += 1;
      place(x, z, heading);
    }
    if (guard >= 3) travel = 0; // 补不上的截断掉，避免后续连发

    elapsed += d;
  }

  /** 全部立即回收（瞬移 / 场景重建） */
  function clear() {
    for (let i = 0; i < poolSize; i += 1) {
      const s = slots[i];
      s.active = false;
      s.age = 0;
      s.material.opacity = 0;
      s.mesh.visible = false;
    }
    travel = 0;
    side = 1;
  }

  function getState() {
    let alive = 0;
    for (let i = 0; i < poolSize; i += 1) if (slots[i].active) alive += 1;
    return { pool: poolSize, alive, travel, spawned, dumped, elapsed };
  }

  function dispose() {
    for (let i = 0; i < poolSize; i += 1) {
      object3D.remove(slots[i].mesh);
      slots[i].material.dispose();
    }
    geometry.dispose();
    texture.dispose();
  }

  return { object3D, geometry, texture, update, clear, dispose, getState };
}
