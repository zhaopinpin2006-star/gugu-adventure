/**
 * 《咕咕奇遇记》角色控制器 CharacterController.js
 * —— GLTFLoader + AnimationMixer，严格按 docs/CONTRACT.md §2.3。
 *
 * 契约要点（已用脚本解析 public/nigugu.glb 的 JSON chunk 逐条核实）：
 *  - 节点树：Nigugu_Rig → [ Nigugu_Character(SkinnedMesh, skin=0), Root(骨骼根) ]，13 骨骼。
 *  - 动画名精确为 Idle(2.4s) Walk(1.0667s) Run(0.8s) Jump(1.4s) Cheer(2.0s)。
 *  - 包围盒 y ∈ [0, 0.9605] → 脚底正好 y=0，无需垂直偏移；高度 0.9605 单位。
 *  - 全部 5 个 clip 的 Root.translation 恒为 (0,0,0) → 无根位移，
 *    位移 100% 由外部 movement 模块写入 group.position。
 *
 * 因此本控制器 **绝不** 修改 group.position / group.rotation，
 * 也绝不做任何正弦抖动；它只负责动画状态机本身。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** GLB 实测包围盒高度（y ∈ [0, 0.9605]），用于换算 controller.height */
const MODEL_HEIGHT = 0.9605;
/** 默认缩放：角色高度约 0.42 个海报宽度 */
const DEFAULT_SCALE = 0.44;

/** 动作切换默认淡入淡出时长（契约 §2.3 要求 ≥ 0.18s） */
const DEFAULT_FADE = 0.22;
const MIN_FADE = 0.18;

/** dt 上限，防止切后台回来一次跳变（契约 §3 也是 0.05，这里留一点余量） */
const MAX_DT = 0.1;

/** gait 标签（纯逻辑）→ 模型里的精确 clip 名 */
const GAIT_CLIP = { idle: 'Idle', walk: 'Walk', run: 'Run' };

/**
 * 优雅降级：某个 clip 缺失时按顺序尝试替代（例如缺 Walk 时用 Idle 顶替）。
 * 只影响动画观感，不影响逻辑。
 */
const GAIT_FALLBACK = {
  idle: ['Idle', 'Walk', 'Run'],
  walk: ['Walk', 'Idle', 'Run'],
  run: ['Run', 'Walk', 'Idle']
};

/** one-shot clip 名 */
const ONE_SHOT_CLIP = { jump: 'Jump', cheer: 'Cheer' };

const VALID_GAITS = ['idle', 'walk', 'run'];

/** 把 fade 参数收敛到契约允许区间（≥0.18），非法值回落默认值 */
function resolveFade(fade) {
  if (!Number.isFinite(fade)) return DEFAULT_FADE;
  return Math.max(MIN_FADE, Math.min(fade, 2));
}

/** 材质微调：doubleSided 与 sRGB 贴图一律保留，不额外加光也能看清 */
function tuneMaterial(mat) {
  if (!mat || !mat.isMeshStandardMaterial) return;
  let changed = false;
  // 只有在 GLB 里根本没给出数值时才补默认值（本例文件里 roughness=0.9 / metalness=0，不动它）
  if (!Number.isFinite(mat.roughness)) {
    mat.roughness = 0.85;
    changed = true;
  }
  if (!Number.isFinite(mat.metalness)) {
    mat.metalness = 0;
    changed = true;
  }
  // 基础色贴图必须是 sRGB（GLTFLoader 通常已处理，这里兜底）
  if (mat.map && mat.map.isTexture && mat.map.colorSpace !== THREE.SRGBColorSpace) {
    mat.map.colorSpace = THREE.SRGBColorSpace;
    changed = true;
  }
  // 注意：不修改 mat.side —— 契约要求保留 GLB 的 doubleSided=true
  if (changed) mat.needsUpdate = true;
}

/** 把加载过程中的各种错误归一成带明确 message 的 Error（上层直接 toast） */
function buildLoadError(err, url) {
  const status = err?.status ?? err?.target?.status ?? err?.response?.status;
  const raw = String(err?.message || err || '');
  let code = Number.isFinite(status) ? Number(status) : 0;
  if (!code) {
    const m = raw.match(/\b(4\d\d|5\d\d)\b/);
    if (m) code = Number(m[1]);
  }
  if (code) return new Error(`无法加载角色模型 (HTTP ${code}): ${url}`);
  return new Error(`无法加载角色模型（网络错误或文件损坏：${raw || '未知错误'}）: ${url}`);
}

/**
 * 加载角色模型。
 * @param {{ url?: string, manager?: THREE.LoadingManager, onProgress?: (loaded: number, total: number) => void, scale?: number }} [options]
 * @returns {Promise<{ group: THREE.Group, controller: CharacterController }>}
 */
export async function loadCharacter({ url = './nigugu.glb', manager, onProgress, scale = DEFAULT_SCALE } = {}) {
  const modelUrl = typeof url === 'string' ? url.trim() : '';
  if (!modelUrl) {
    throw new Error('无法加载角色模型（url 为空）: 期望形如 "./nigugu.glb"');
  }

  const loader = new GLTFLoader(manager);
  const gltf = await new Promise((resolve, reject) => {
    loader.load(
      modelUrl,
      (result) => resolve(result),
      (event) => {
        if (typeof onProgress !== 'function') return;
        try {
          const loaded = Number(event?.loaded) || 0;
          const total = Number(event?.total) || 0;
          onProgress(Math.max(0, loaded), Math.max(0, total));
        } catch (callbackError) {
          // 进度回调由 UI 提供，它抛错不应影响模型加载
          console.warn('[CharacterController] onProgress 回调异常：', callbackError);
        }
      },
      (error) => reject(buildLoadError(error, modelUrl))
    );
  });

  if (!gltf || !gltf.scene) {
    throw new Error(`无法加载角色模型（GLB 结构异常：缺少 scene）: ${modelUrl}`);
  }
  if (!Array.isArray(gltf.animations) || gltf.animations.length === 0) {
    throw new Error(`无法加载角色模型（GLB 内没有任何动画剪辑）: ${modelUrl}`);
  }

  const controller = new CharacterController({ gltf, scale });
  return { group: controller.group, controller };
}

/**
 * 角色动画状态机。
 * 只操作 AnimationMixer 与 group 的初始摆放，绝不写 group.position / group.rotation。
 */
export class CharacterController {
  constructor({ gltf, scale = DEFAULT_SCALE } = {}) {
    if (!gltf || !gltf.scene) {
      throw new Error('CharacterController 构造失败：缺少 gltf.scene');
    }

    const safeScale = Number.isFinite(scale) && scale > 0 ? scale : DEFAULT_SCALE;

    /** 缩放后高度（世界单位，海报宽度制） */
    this.height = MODEL_HEIGHT * safeScale;
    this.scale = safeScale;

    /** 角色枢轴：脚底在原点，外部按 movement 结果设置 position / rotation.y */
    this.group = new THREE.Group();
    this.group.name = 'CharacterPivot';

    /** 原始 GLB 场景（蒙皮网格 + 骨骼），保留引用便于调试 */
    this.rig = gltf.scene;
    this.clips = gltf.animations || [];

    // 缩放挂在模型本体上，group 保持 1:1，这样外部只需要管位置与朝向
    this.rig.scale.setScalar(safeScale);
    // 脚底 y=0（GLB 包围盒本身就是 y∈[0,0.9605]，这里只是显式保证不做垂直偏移）
    this.rig.position.set(0, 0, 0);
    this.group.position.set(0, 0, 0); // 构造时归零；此后只有外部会写它
    this.group.add(this.rig);

    // 阴影用自绘接触阴影（§2.4 ContactShadow），这里关掉 three 的阴影
    this.rig.traverse((node) => {
      if (!node || !node.isMesh) return;
      node.castShadow = false;
      node.receiveShadow = false;
      // 蒙皮网格的包围盒随动画变化不可靠，关掉视锥剔除防止角色被误剔除
      node.frustumCulled = false;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const mat of materials) tuneMaterial(mat);
    });

    this.mixer = new THREE.AnimationMixer(this.rig);

    /** name → AnimationAction（只收成功绑定的） */
    this.actions = new Map();
    /** 成功绑定到 mixer 的动画名（按 GLB 里的顺序） */
    this._boundNames = [];
    /** 当前循环动画的 gait 标签（'idle' | 'walk' | 'run'），供 playGait 去重 */
    this._currentLoopLabel = null;
    /** 当前循环动画对应的真实 clip 名（降级时可能与 label 不同） */
    this.currentClipName = null;

    /** 正在播放的 one-shot 描述；null 表示没有 one-shot 在播 */
    this._oneShot = null;
    /** one-shot 期间暂存的 gait，等 one-shot 结束后切过去 */
    this.pendingGait = null;

    /** 当前正在进行的循环 action */
    this._currentAction = null;
    /** 淡出中的 action，权重归零后统一 stop，避免残留权重与空转 */
    this._fading = new Set();
    /** walk/run 的播放速率（setTimeScale 可调） */
    this._timeScale = 1;
    /** 已经 warn 过的键，避免每帧刷屏 */
    this._warned = new Set();

    for (const clip of this.clips) {
      if (!clip || !clip.name) continue;
      try {
        const action = this.mixer.clipAction(clip);
        // 循环/一次性由 playGait / playJump 在播放时设置，这里先统一成安全默认
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = false;
        action.enabled = true;
        this.actions.set(clip.name, action);
        this._boundNames.push(clip.name);
      } catch (error) {
        console.warn(`[CharacterController] 绑定动画 "${clip.name}" 失败：`, error);
      }
    }

    // one-shot 播完的事件回退（§2.3 要求用 mixer 的 'finished' 事件）
    this._onFinishedBound = (event) => this._handleFinished(event);
    this.mixer.addEventListener('finished', this._onFinishedBound);

    // 构造后立刻进入 Idle，避免首帧出现 T-pose
    this._startIdle();
  }

  /** 已成功绑定到 mixer 的动画名数组 */
  get animationNames() {
    return this._boundNames.slice();
  }

  /** 当前循环动画的 gait 标签（调试/测试用；playGait 靠它去重） */
  get currentLoopLabel() {
    return this._currentLoopLabel;
  }

  /** jump / cheer 是否正在播放 */
  get isOneShot() {
    return this._oneShot !== null;
  }

  // ------------------------------------------------------------------ 内部

  _warnOnce(key, message) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    console.warn(`[CharacterController] ${message}`);
  }

  /** 按 fallback 顺序取第一个已经绑定成功的 action */
  _resolveClip(names) {
    for (const name of names) {
      const action = this.actions.get(name);
      if (action) return { action, clipName: name };
    }
    return null;
  }

  _resolveGait(label) {
    const chain = GAIT_FALLBACK[label];
    if (!chain) return null;
    const resolved = this._resolveClip(chain);
    if (resolved && resolved.clipName !== GAIT_CLIP[label]) {
      this._warnOnce(
        `gait-missing:${label}:${resolved.clipName}`,
        `缺少动画 "${GAIT_CLIP[label]}"，gait "${label}" 已降级使用 "${resolved.clipName}"`
      );
    }
    return resolved;
  }

  _timeScaleFor(clipName) {
    return clipName === 'Walk' || clipName === 'Run' ? this._timeScale : 1;
  }

  /** 构造后直接 play Idle（无淡入，首帧即有姿势） */
  _startIdle() {
    const resolved = this._resolveGait('idle');
    if (!resolved) {
      this._warnOnce('no-anim', '模型内没有可用动画，角色将保持静态姿势');
      return;
    }
    const { action, clipName } = resolved;
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    action.enabled = true;
    action.setEffectiveTimeScale(this._timeScaleFor(clipName));
    action.setEffectiveWeight(1);
    action.play();
    this._currentAction = action;
    this._currentLoopLabel = 'idle';
    this.currentClipName = clipName;
  }

  /**
   * 切换到某个循环动作（供 playGait 与 one-shot 结束后复用）。
   * @param {string} label 'idle' | 'walk' | 'run'
   * @param {number} fadeParam 淡入淡出时长
   * @param {THREE.AnimationAction|null} fromAction 指定淡出的来源（one-shot 结束时用）
   * @returns {boolean} 是否成功切换
   */
  _switchLoop(label, fadeParam, fromAction = null) {
    const resolved = this._resolveGait(label);
    if (!resolved) {
      this._warnOnce(`no-gait:${label}`, `没有可用的循环动画来表现 gait "${label}"`);
      return false;
    }
    const { action, clipName } = resolved;
    const fade = resolveFade(fadeParam);
    const cur = fromAction || this._currentAction;
    const same = action === this._currentAction;

    // 同一 action、同 label、且不是从 one-shot 回来 → 什么都不用做
    if (same && !fromAction && this._currentLoopLabel === label) return true;
    // 同一 action 但 label 变了（例如 Walk 缺失时 walk/run 都落到 Idle）→ 只更新标签
    if (same && !fromAction) {
      this._currentLoopLabel = label;
      this.currentClipName = clipName;
      return true;
    }

    if (!same) {
      action.reset();
      action.enabled = true;
      action.setEffectiveTimeScale(this._timeScaleFor(clipName));
      action.setEffectiveWeight(1);
    }
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    action.play();

    if (cur && cur !== action) {
      // 交叉淡入淡出：无跳变、无叠加权重残留
      action.crossFadeFrom(cur, fade, false);
      this._fading.add(cur);
    } else if (!same) {
      action.setEffectiveWeight(1);
    }

    this._currentAction = action;
    this._currentLoopLabel = label;
    this.currentClipName = clipName;
    this._fading.delete(action);
    return true;
  }

  _startOneShot(kind, onLand) {
    const wantedName = ONE_SHOT_CLIP[kind];
    const fallbackName = kind === 'jump' ? ONE_SHOT_CLIP.cheer : ONE_SHOT_CLIP.jump;
    let resolved = this._resolveClip([wantedName]);
    if (!resolved) {
      resolved = this._resolveClip([fallbackName]);
      if (resolved) {
        this._warnOnce(
          `oneshot-missing:${kind}`,
          `缺少动画 "${wantedName}"，one-shot "${kind}" 已降级使用 "${resolved.clipName}"`
        );
      }
    }
    if (!resolved) {
      this._warnOnce('oneshot-none', `模型内没有 Jump/Cheer 动画，${kind} 只能退化为纯回调`);
      // 退化：仍然异步回调 onLand，避免调用方等待一个永远不来的事件而卡死
      if (typeof onLand === 'function') {
        setTimeout(() => {
          try {
            onLand();
          } catch (error) {
            console.warn('[CharacterController] onLand 回调异常：', error);
          }
        }, 0);
      }
      return false;
    }

    const { action } = resolved;
    const fade = resolveFade(DEFAULT_FADE);

    action.reset();
    action.enabled = true;
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true; // 停在最后一帧，等回退淡出
    action.setEffectiveTimeScale(1);
    action.setEffectiveWeight(1);
    action.play();

    const cur = this._currentAction;
    if (cur && cur !== action) {
      action.crossFadeFrom(cur, fade, false);
      this._fading.add(cur);
    }

    this._fading.delete(action);
    this._oneShot = { kind, action, onLand: typeof onLand === 'function' ? onLand : null };
    return true;
  }

  /** mixer 'finished' 事件：one-shot 结束 → 回到 pendingGait（默认 Idle）→ 回调 onLand */
  _handleFinished(event) {
    const one = this._oneShot;
    if (!one || !event || event.action !== one.action) return;

    this._oneShot = null;
    const target = VALID_GAITS.includes(this.pendingGait)
      ? this.pendingGait
      : VALID_GAITS.includes(this._currentLoopLabel)
        ? this._currentLoopLabel
        : 'idle';
    this.pendingGait = null;

    try {
      this._switchLoop(target, DEFAULT_FADE, one.action);
    } catch (error) {
      console.warn('[CharacterController] one-shot 回退循环动作失败：', error);
    }

    if (one.onLand) {
      try {
        one.onLand();
      } catch (error) {
        console.warn('[CharacterController] onLand 回调异常：', error);
      }
    }
  }

  /**
   * 权重已归零的淡出 action 统一 stop，防止空转与权重残留。
   * 注意：不能用 isRunning() 判断 —— LoopOnce + clampWhenFinished 播完后 action 会 paused，
   * isRunning() 立刻变 false，但此时它的淡出还没走完，提前 stop 会造成"啪"地消失。
   * 所以只认有效权重。
   */
  _pruneFading() {
    if (this._fading.size === 0) return;
    for (const action of this._fading) {
      if (action === this._currentAction) {
        this._fading.delete(action);
        continue;
      }
      if (this._oneShot && action === this._oneShot.action) continue;
      if (action.getEffectiveWeight() <= 0.0005) {
        action.stop();
        this._fading.delete(action);
      }
    }
  }

  // ------------------------------------------------------------------ 公开 API

  /**
   * 切换循环动作。
   * @param {'idle'|'walk'|'run'} gait
   * @param {{ fade?: number }} [options]
   */
  playGait(gait, { fade = DEFAULT_FADE } = {}) {
    const label = typeof gait === 'string' ? gait.trim().toLowerCase() : '';
    if (!VALID_GAITS.includes(label)) {
      this._warnOnce(`bad-gait:${label}`, `playGait 收到非法 gait "${gait}"，已忽略`);
      return;
    }
    // one-shot 期间只记意图，等 finished 再切（§2.3）
    if (this._oneShot) {
      this.pendingGait = label;
      return;
    }
    if (this._currentLoopLabel === label) return;
    this._switchLoop(label, fade, null);
  }

  /** 跳跃（one-shot，结束回到当前 gait；重复调用忽略） */
  playJump({ onLand } = {}) {
    if (this._oneShot) return false; // 正在 jump/cheer → 忽略
    return this._startOneShot('jump', onLand);
  }

  /** 欢呼（one-shot，重复调用忽略） */
  playCheer() {
    if (this._oneShot) return false;
    return this._startOneShot('cheer', null);
  }

  /** 每帧推进动画 */
  update(dt) {
    const d = Number.isFinite(dt) ? Math.max(0, Math.min(dt, MAX_DT)) : 0;
    if (!this.mixer) return;
    if (d > 0) this.mixer.update(d);
    this._pruneFading();
  }

  /** walk/run 播放速率微调（不影响 idle 与 one-shot） */
  setTimeScale(v) {
    if (!Number.isFinite(v) || v <= 0) return;
    const ts = Math.max(0.1, Math.min(v, 4));
    this._timeScale = ts;
    for (const name of ['Walk', 'Run']) {
      const action = this.actions.get(name);
      if (action) action.setEffectiveTimeScale(ts);
    }
  }

  /** 释放：停止所有动作并断开 mixer 事件（页面卸载/热更新时用，可重复调用） */
  dispose() {
    try {
      this.mixer.removeEventListener('finished', this._onFinishedBound);
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.rig);
    } catch (error) {
      console.warn('[CharacterController] dispose 异常：', error);
    }
    this.actions.clear();
    this._boundNames = [];
    this._fading.clear();
    this._currentAction = null;
    this._oneShot = null;
    this.pendingGait = null;
    this._currentLoopLabel = null;
    this.currentClipName = null;
  }
}
