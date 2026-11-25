import * as THREE from 'three';

/**
 * 接触阴影（ContactShadow）
 * ------------------------------------------------------------------
 * 契约：docs/CONTRACT.md §2.4
 *   export function createContactShadow({ radius = 0.36, opacity = 0.34 })
 *   → { object3D, update(dt, { visible, x, z, height, speedRatio }) }
 *
 * 坐标系：posterSpace（P，§1.2）。1 单位 = 海报宽度，地面 y = 0。
 * 贴图：canvas 程序化径向渐变（中心墨黑 alpha≈0.85 → 边缘 0），无任何外部资源。
 * 性能：整块阴影只有 1 个 Mesh / 1 个材质 / 1 张 128×128 贴图，全程零分配。
 *       运行时只改 position / scale / opacity，不重建几何体。
 */

/** 贴地高度：与脚印(0.003)、花瓣(≥0.05) 分层，避免共面闪烁 */
const BASE_Y = 0.002;
/** 贴图边长（2 的幂，移动端采样友好） */
const TEX_SIZE = 128;
/** dt 上限：切页 / 掉帧时不允许一步跳太远 */
const MAX_DT = 0.1;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

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
 * 径向渐变 canvas 贴图：中心墨黑 alpha 0.85 → 边缘 alpha 0。
 * 上面叠一圈极淡的"手绘"抖动环，避免死板的 CG 感（泥塑/民俗的柔和笔触）。
 * @returns {THREE.Texture|null} 无 DOM 环境时返回 null（调用方回退到程序化贴图）
 */
function makeRadialCanvasTexture(size) {
  try {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return null;

    const c = size / 2;
    const grad = ctx.createRadialGradient(c, c, size * 0.02, c, c, c);
    grad.addColorStop(0.0, 'rgba(0,0,0,0.85)');
    grad.addColorStop(0.42, 'rgba(0,0,0,0.58)');
    grad.addColorStop(0.72, 'rgba(0,0,0,0.20)');
    grad.addColorStop(0.90, 'rgba(0,0,0,0.05)');
    grad.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(c, c, c, 0, Math.PI * 2);
    ctx.fill();

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  } catch (_err) {
    return null;
  }
}

/**
 * 无 canvas 时的兜底：直接用 DataTexture 生成同样的径向 alpha 衰减。
 * （真实浏览器里永远走 canvas 分支，这里只是保证模块不会 throw。）
 */
function makeRadialFallbackTexture(size) {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      // 与 canvas 渐变同一形状：中心 0.85，边缘 0
      const a = 0.85 * Math.pow(1 - d, 1.55);
      const i = (y * size + x) * 4;
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = Math.round(clamp01(a) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * @param {{ radius?: number, opacity?: number }} [options]
 */
export function createContactShadow({ radius = 0.36, opacity = 0.34 } = {}) {
  const r = Math.max(0.02, num(radius, 0.36));
  const baseOpacity = clamp01(num(opacity, 0.34));

  const object3D = new THREE.Group();
  object3D.name = 'ContactShadow';

  const texture = makeRadialCanvasTexture(TEX_SIZE) || makeRadialFallbackTexture(64);

  const geometry = new THREE.PlaneGeometry(r * 2, r * 2);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    color: 0x000000, // 墨黑，靠贴图 alpha 表现柔和过渡
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2
  });
  material.opacity = 0; // 首帧从 0 淡入，避免"啪"一下出现

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'ContactShadowPlane';
  mesh.rotation.x = -Math.PI / 2; // 平放，法线朝 +Y
  mesh.position.set(0, BASE_Y, 0);
  mesh.renderOrder = -1; // 先画（在角色/花瓣之前）
  mesh.frustumCulled = false; // 单 mesh，跟着角色跑，省掉包围球重算
  mesh.matrixAutoUpdate = true;
  object3D.add(mesh);

  // ---- 运行时状态（全部复用，不产生垃圾） ----
  let curX = 0;
  let curZ = 0;
  let curScale = 1;
  let curOpacity = 0;
  let fade = 0; // 0..1，visible=false 时淡到 0
  let lastHeight = 0;
  let lastSpeed = 0;

  /**
   * @param {number} dt 秒
   * @param {{ visible?: boolean, x?: number, z?: number, height?: number, speedRatio?: number }} [ctx]
   */
  function update(dt, ctx) {
    const c = ctx || {};
    const d = clampDt(dt);
    const visible = c.visible !== false;

    if (d <= 0) return; // 静止帧什么都不做（不推进淡入淡出）

    if (visible) {
      const x = num(c.x, curX);
      const z = num(c.z, curZ);
      const height = Math.max(0, Math.min(num(c.height, 0), 1.5)); // 离地高度，1 单位 = 海报宽度
      const speed = clamp01(num(c.speedRatio, 0));

      // 1) 跟随：指数平滑，避免角色每帧微抖动被放大
      const kFollow = 1 - Math.exp(-22 * d);
      curX += (x - curX) * kFollow;
      curZ += (z - curZ) * kFollow;

      // 2) 越高 → 越大越淡（真实阴影的软硬变化）
      const targetScale = 1 + height * 2.6 + speed * 0.05;
      const targetOpacity = baseOpacity * (1 / (1 + height * 2.1)) * (1 - 0.12 * speed);

      // 3) 淡入
      fade = Math.min(1, fade + d * 3.4);

      const kLerp = 1 - Math.exp(-10 * d);
      curScale += (targetScale - curScale) * kLerp;
      curOpacity += (targetOpacity * fade - curOpacity) * kLerp;

      lastHeight = height;
      lastSpeed = speed;

      mesh.visible = true;
      mesh.position.set(curX, BASE_Y, curZ);
      // PlaneGeometry 平放后：local x → 世界 x，local y → 世界 z。
      // 跑动时沿"前进方向"拉长做不到（ctx 无 heading），因此只做轻微纵向拉伸 + 整体收窄。
      mesh.scale.set(curScale * (1 - 0.05 * speed), curScale * (1 + 0.12 * speed), 1);
      material.opacity = curOpacity;
    } else {
      // 识别丢失：停止跟随、停止形变，只做整体淡出
      fade = Math.max(0, fade - d * 4.5);
      curOpacity += (0 - curOpacity) * (1 - Math.exp(-9 * d));
      if (curOpacity < 0.004) {
        curOpacity = 0;
        material.opacity = 0;
        mesh.visible = false;
      } else {
        material.opacity = curOpacity;
      }
    }
  }

  /** 释放 GPU 资源（可选，外部卸载场景时调用） */
  function dispose() {
    object3D.remove(mesh);
    geometry.dispose();
    material.dispose();
    if (texture && texture.dispose) texture.dispose();
  }

  /** 调试/外部读取用（非契约要求） */
  function getState() {
    return { x: curX, z: curZ, scale: curScale, opacity: material.opacity, height: lastHeight, speed: lastSpeed };
  }

  return { object3D, mesh, material, update, dispose, getState };
}
