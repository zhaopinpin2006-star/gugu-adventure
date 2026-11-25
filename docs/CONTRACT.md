# 《咕咕奇遇记》模块契约 v1（所有并行开发者必须严格遵守）

本文件是全项目唯一的接口契约。任何人不得修改本文件；如发现契约有歧义或缺陷，在自己的代码里兼容并在最终汇报中说明。

## 0. 项目事实（已核实，不要再猜）

- 工程根：`D:/Blender建模/gugu-adventure`，Vite 6 + three 0.160.1 + nipplejs 0.10.2，`type: module`。
- AR 引擎：**MindAR 1.2.5 官方编译产物**（`public/vendor/mindar-1.2.5/`）。图像识别/跟踪**直接复用其 `Controller`**，禁止自己实现识别。
- 目标海报：`public/targets/nigugu.jpg` 800×1000（竖版），已编译 `public/targets/nigugu.mind`。
- 模型：`public/nigugu.glb`（2.2MB，内嵌贴图，13 骨骼，5 个动画）。
  - 动画名**精确**为 `Idle`(2.4s) `Walk`(1.067s) `Run`(0.8s) `Jump`(1.4s) `Cheer`(2.0s)。
  - 模型包围盒：x∈[-0.5518,0.4047]，**y∈[0,0.9605]（脚底 y=0）**，z∈[-0.3026,0.2493]。高度 0.96 单位。
  - 所有 clip 的 `Root` 骨骼 **translation 恒为 (0,0,0)** → 没有任何根位移，位移必须 100% 由代码驱动。**禁止**在模型或其父节点上额外叠加位移动画。
  - 模型正面朝 **+Z**（尾巴在 -Z）。因此 `rotation.y = atan2(dirX, dirZ)` 即为朝向移动方向。
- 视觉主色（非遗泥咕咕）：青蓝 `#1B7A8C`、米白 `#F5EBDC`、红 `#D8382F`、黄 `#F2C230`，墨黑 `#211A18`。

## 1. 空间坐标系（最重要，全部代码必须一致）

### 1.1 MindAR 锚点坐标系 `M`
MindAR `anchor.group` 的局部坐标系（由 `worldMatrix * postMatrix` 得到）：
- 原点 = 海报中心；
- **1 单位 = 海报宽度**；
- `+X` = 海报向右；`+Y` = 海报向上（沿海报平面）；`+Z` = 海报法线朝外（指向观察者一侧）。

海报在 `M` 内占据：`x ∈ [-0.5, 0.5]`，`y ∈ [-H/2W, +H/2W]`，其中 `H/W = 1000/800 = 1.25` → `y ∈ [-0.625, 0.625]`。

> 该结论由 MindAR 上游 `three.js` 适配层的 `postMatrix` 推导得出，并在 `tests/e2e` 中用真实渲染投影校验。若校验失败，由 AR 层在 `posterSpace` 上补偿，**其他模块不要自己加旋转**。

### 1.2 海报地面坐标系 `P`（"posterSpace"，游戏逻辑唯一使用的坐标系）
由 AR 层创建，是 `M` 的子节点，`rotation.x = +Math.PI/2`，即：
- `P.x = M.x`（海报向右）
- `P.y = M.z`（海报法线 = 向上，"站立"方向）
- `P.z = -M.y`（海报向下）
- 原点仍在海报中心，1 单位仍 = 海报宽度。

于是 `P` 就是标准的 three.js "地面在 y=0" 环境：
- 地面 = 海报表面，`y = 0`；角色脚底 `y = 0` → **双脚正好落在海报表面**。
- 可活动矩形：`x ∈ [-0.5, 0.5]`，`z ∈ [-0.625, 0.625]`（`z` 正方向 = 海报下方）。
- 角色朝向：`heading = 0` 表示面向 `+Z`（海报下方）。朝向向量 `(sin(heading), cos(heading))`（在 `x,z` 上）。

### 1.3 屏幕对齐控制
摇杆方向要映射为"手机画面上看到的方向"。由 AR 层每帧提供 `screenBasis`：
```js
{ right: {x, z}, up: {x, z} }   // 单位向量，海报平面内、P 坐标系
```
含义：`right` = 屏幕上"右"在世界中的方向；`up` = 屏幕上"上"（远离镜头）的方向。移动模块用 `move = right*jx + up*jy`。

## 2. 模块清单与 API（导出名、参数名、返回结构必须逐字一致）

### 2.1 `src/core/movement.js`（纯函数，无 DOM / 无 three 依赖）
```js
export const MOVE_TUNING = {
  walkSpeed: 0.32,     // 海报宽度/秒
  runSpeed: 0.85,
  accel: 2.6,          // 单位/秒²
  decel: 4.2,
  turnRate: 14,        // 每秒朝向平滑系数（指数逼近）
  runThreshold: 0.62,  // force 超过即 Run
  stopEpsilon: 0.02    // 速度低于此视为静止
};

export function createMovementState({ x = 0, z = 0, heading = 0 } = {})
// → { x, z, vx, vz, heading, speed, gait: 'idle' }

// 纯函数：不修改传入对象，返回新 state（浅拷贝即可）
// input: { x, y, force }  x/y ∈ [-1,1]，已转到海报平面（y>0 = 屏幕上方）
// bounds: { halfX, halfZ, margin }
// basis: { right:{x,z}, up:{x,z} }  （可为 null → 退化为 right=(1,0)、up=(0,-1)）
// dt: 秒，必须做 clamp（建议 0..0.05）以防切页后台跳变
export function stepMovement(state, dt, input, bounds, basis, tuning = MOVE_TUNING)
// → { x, z, vx, vz, heading, speed, gait, dirX, dirZ, moving: boolean }

export function resetMovement(state, { x = 0, z = 0, heading = 0 } = {})
```
规则（必须全部实现）：
1. `dt` 先 `clamp(0, 0.05)`；`dt <= 0` 时原样返回。
2. 期望方向 = `normalize(right*jx + up*jy)`；`force` 决定目标速度（`force>=runThreshold` → runSpeed，否则 walkSpeed；可用 `lerp` 平滑但必须单调）。
3. 加速用 `accel`，无输入时用 `decel` 逼近 0；**不得瞬移**；速度模长不超过目标速度。
4. `heading` 用最短角差 + `1 - exp(-turnRate*dt)` 指数逼近（`turnRate` 为每秒速率），**不抖动**。
5. 位置用 `dt` 积分后 **clamp 到 bounds**（含 margin），clamp 后对应速度分量置 0。
6. `gait`：`speed < stopEpsilon` → `'idle'`；否则 `force >= runThreshold` → `'run'`，其余 `'walk'`。
7. 静止但仍有朝向变化时，`gait` 仍为 `'idle'`。

### 2.2 `src/input/Joystick.js`
```js
export function createJoystick({ zone, onChange, size = 132, deadzone = 0.12 })
// → { input: {x,y,force}, destroy(), forceReset(), setEnabled(bool) }
```
- **必须用 nipplejs**（`import nipplejs from 'nipplejs'`），`mode:'static'`、`zone`、`size`、`restJoystick:true`、`restOpacity:0.5`、`fadeTime:120`、`color:'#F5EBDC'`、`dataOnly:false`。
- `input.x = data.vector.x`，`input.y = data.vector.y`（nipplejs：**x 右为正，y 上为正**，已归一化），`input.force = min(1, data.force)`。
- 死区：`force < deadzone` → 输出 0。
- `onChange(input)` 每次变化都要回调（含回中、松手）。
- **防卡住**：同时监听 `window` 的 `touchend/touchcancel/pointerup/pointercancel/blur/visibilitychange/pagehide`，一旦触发 → `forceReset()` 并把输入归零。`forceReset()` 必须在 250ms 内让 `input` 归零（不可依赖 nipplejs 自身）。
- `setEnabled(false)` 时归零且忽略后续输入（切页/识别丢失时用）。

### 2.3 `src/character/CharacterController.js`
```js
export async function loadCharacter({ url, manager, onProgress }) 
// → { group: THREE.Group, controller: CharacterController }
// group 是"角色枢轴"：位置=脚底落点(x,0,z)，rotation.y=heading；
// 内部已处理 scale（角色高度约 0.42 个海报宽度 → 默认 scale 0.44），脚底严格 y=0。

export class CharacterController {
  constructor({ gltf, scale = 0.44 })
  group            // THREE.Group（脚底在原点）
  height           // 缩放后高度（世界单位）
  playGait(gait, { fade = 0.22 } = {})   // 'idle' | 'walk' | 'run'，内部 crossFade
  playJump({ onLand } = {})              // one-shot，结束回到当前 gait；重复调用忽略
  playCheer()                            // one-shot
  update(dt)                             // mixer.update(dt)
  get currentLoopLabel()                 // 当前循环动画名，调试/测试用
  get isOneShot()                        // jump/cheer 播放中
  get animationNames()                   // 已成功绑定到 mixer 的动画名数组
  setTimeScale(v)                        // walk/run 播放速度微调（可选）
}
```
要求：
- 用 `GLTFLoader` + `AnimationMixer`；`Idle/Walk/Run` 必须 `LoopRepeat`，`Jump/Cheer` 用 `LoopOnce` + `clampWhenFinished = true`，用 mixer 的 `'finished'` 事件回退。
- 切换用 `crossFadeTo`（或等价 `fadeOut/fadeIn`）时长 ≥ 0.18s，**禁止**任何整体抖动（不要对 `group.position` 做正弦抖动）。
- `Jump` 期间角色的水平位移仍由 movement 模块负责，控制器**不得**修改 `group.position`（`group.position` 只由外部按 movement 结果设置）。
- 贴图色彩空间正确（`renderer.outputColorSpace = SRGBColorSpace` 时贴图默认 sRGB），材质 `doubleSided` 保留，不额外加光也能看清（外部会放 HemisphereLight + DirectionalLight）。
- 资源加载失败要 `throw` 明确错误（上层捕获并提示），不得静默。

### 2.4 `src/fx/*.js`（视觉特效，均返回可更新对象；构造函数签名固定）
```js
// src/fx/ContactShadow.js
export function createContactShadow({ radius = 0.36, opacity = 0.34 })
// → { object3D, update(dt, { visible, x, z, height, speedRatio }) }
// 贴在海报表面（y≈0.002），跟随角色 x/z；height 升高时变大变淡；visible=false 时整体淡出。

// src/fx/Petals.js
export function createPetals({ count = 42, area = { halfX: 0.5, halfZ: 0.625 } })
// → { object3D, update(dt, { visible, speedRatio, x, z, heading }), burst(n = 14) }
// 海报平面上方漂浮的花瓣（红/黄/米白），下落 + 旋转 + 轻微环绕；角色跑动时被"带起"。

// src/fx/Footprints.js
export function createFootprints({ max = 24, area = { halfX: 0.5, halfZ: 0.625 } })
// → { object3D, update(dt, { visible, moving, gait, x, z, heading, stride }), clear() }
// 每走约 stride(=0.13) 距离在角色脚下交替左右贴一枚彩色脚印（青蓝/红/黄轮换），
// 贴在海报表面 y≈0.003，5~7 秒内淡出并回收；跑动时脚印间距更大。
```
- 全部特效必须挂在 **posterSpace** 里（单位与海报一致，1 = 海报宽度），不得用屏幕坐标。
- 全部特效在 `visible=false`（识别丢失）时停止更新并淡出，**不得**在丢失期间继续在地面上留新脚印。
- 只能用 three 内置几何体 + canvas 程序化贴图，**不得**新增外部资源文件（避免加载失败）。

### 2.5 `src/audio/Sfx.js`
```js
export class Sfx {
  constructor()
  async unlock()            // 首个用户手势后调用；幂等
  setEnabled(bool); get enabled
  chirp()   // 泥咕咕鸣叫（短促上扬的两声鸟哨/陶哨音，WebAudio 合成，禁用外部音频文件）
  step(gait)                // 脚步声（gait 'walk'|'run' 音色/音量不同，需节流 ≥120ms）
  jump(); land(); cheer(); place(); error()
}
```
全部用 `AudioContext` + `OscillatorNode`/`GainNode` 合成，任何异常必须被吞掉（不能影响游戏）。首次 `unlock()` 必须处理 `suspended` 状态。

### 2.6 `src/ui/Hud.js`
```js
export class Hud {
  constructor({ onStart, onJump, onRecenter, onToggleSound })
  setStatus(kind, text)     // kind: 'scan' | 'track' | 'lost' | 'error' | 'warn'
  showOverlay({ title, desc, actionText, kind })   // kind: 'start' | 'error' | 'permission'
  hideOverlay()
  setProgress(ratio)        // 0..1；null 隐藏进度条
  toast(text, ms = 2200)
  setSoundOn(bool)
  setControlsEnabled({ jump, recenter })
  update(dt, { force, gait })   // 可选：摇杆提示/速度条
}
```
DOM 由 `index.html` 提供（见 §4 的 id 清单），Hud **只读这些节点、只改 class/文本/属性**，不得重建节点结构。所有按钮必须 `touchstart` 与 `click` 双绑定并 `preventDefault` 防止 300ms 延迟/双击缩放。

### 2.7 `src/ar/MindARLite.js`（AR 层，已由架构侧实现，其他人只读）
```js
export class MindARLite {
  constructor({ container, imageTargetSrc, onTargetFound, onTargetLost, onStatus, missTolerance, filterMinCF, filterBeta })
  scene; camera; renderer; video
  async start()
  resize()
  get posterSpace()        // §1.2 的 Group（旋转已补偿）
  get targetAspect()       // H/W = 1.25
  get isTracking()
  screenBasis()            // §1.3 的 { right, up }，识别丢失时返回 null
  addAnchorDebug()         // 开发用：立方体 + 轴
  recenter()               // 重新定位（重置跟踪状态 + 角色归位由上层做）
  stop()
}
```

## 3. 主循环时序（`src/main.js`，架构侧实现，其他人按此假设编码）

```
每帧 rAF:
  1. dt = clamp((now - last)/1000, 0, 0.05)
  2. joystick 输入 → 若 !isTracking → 强制 {0,0,0} 且不推进 movement
  3. movement.stepMovement(...)  → state
  4. controller.playGait(state.gait)（仅当变化时）
  5. character.group.position.set(state.x, 0, state.z); rotation.y = state.heading
  6. controller.update(dt); fx 各 update(dt, ctx)
  7. renderer.render(scene, camera)
```
识别丢失（`onTargetLost`）时：立即把输入与速度归零、`anchor.group.visible=false`、暂停 movement 与脚印；找回后从当前状态继续（不瞬移、不重置位置）。

## 4. `index.html` 必须提供的 DOM id（Hud 与 main 依赖）
```
#ar-container           AR 容器（video + canvas 挂载点）
#hud                    叠加层根
#status-pill            顶部状态药丸
  #status-dot, #status-text
#hint-bar               顶部/中部的提示条（toast 用）
#joystick-zone          左下摇杆区域（圆形，position:relative）
#btn-jump               右下 跳跃
#btn-recenter           右下 重新定位
#btn-sound              右上 声音开关
#overlay                全屏遮罩（首屏/错误/权限）
  #overlay-card, #overlay-title, #overlay-desc, #btn-start, #overlay-icon
#progress               加载进度容器
  #progress-bar, #progress-text
#flash                  闪光/转场层（可选）
```
按钮内文案用中文；`aria-label` 必须有。

## 5. 移动端约束（所有人必须遵守）
- 只用 `touch`/`pointer` 事件；`touch-action: none` 区域不得滚动；页面 `overscroll-behavior: none`、`user-select: none`、`-webkit-tap-highlight-color: transparent`。
- 不使用 `alert/confirm/prompt`；不使用外部网络请求（字体、CDN 一律避免）。
- 所有尺寸用 `dvh`/`svh` 兜底（iOS 地址栏），`env(safe-area-inset-*)` 处理刘海。
- 任何 `await` 都要有失败分支；不得产生未捕获 Promise。
