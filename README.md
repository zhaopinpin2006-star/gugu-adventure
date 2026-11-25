# 咕咕奇遇记 · 泥咕咕 WebAR 角色操控小游戏

用手机后置摄像头对准一幅泥咕咕（河南浚县，国家级非物质文化遗产）海报，
一只会跑、会跳、会欢呼的泥咕咕三维角色就会从海报表面站起来，
由左下角的虚拟摇杆带着四处走。

技术栈：**MindAR.js**（图像识别）+ **Three.js**（渲染）+ **NippleJS**（虚拟摇杆）+ **Vite**（构建）。

---

## 快速开始

```bash
npm install

# 手机真机调试（推荐）：先生成自签名证书，dev server 会用 https
python scripts/gen-cert.py
npm run dev            # https://<你的局域网 IP>:5173

# 桌面快速预览（不需要摄像头，走模拟 AR）
npm run dev            # 打开 http://localhost:5173/?mock=1
```

> **为什么必须 HTTPS**：iOS Safari 与 Android Chrome 只在安全上下文（`https://` 或 `localhost`）
> 才允许 `getUserMedia`。手机访问电脑上的 http 开发服务器会被静默拒绝。

打开后点「开始奇遇」→ 允许摄像头 → 把镜头对准 `public/targets/nigugu.jpg` 那张海报。
手机上首次访问自签名证书会提示不安全，选择「继续访问」即可（仅开发用）。

调试参数：

| 参数 | 作用 |
| --- | --- |
| `?mock` | 强制模拟 AR（不需要摄像头，桌面端可直接玩） |
| `?debug` | 打印每 30 帧的 fps / 识别状态 / 坐标 / 步态，并显示锚点调试立方体 |

---

## 项目结构

```
gugu-adventure/
├── index.html                     # 唯一入口，DOM 结构与 UI 骨架
├── vite.config.js                 # base:'./' + 可选 HTTPS dev server
├── public/
│   ├── nigugu.glb                 # 角色模型（13 骨骼，5 个动画剪辑）
│   ├── targets/
│   │   ├── nigugu.jpg             # 原始海报（识别目标底图）
│   │   └── nigugu.mind            # 编译后的 MindAR 图像目标（415 KB）
│   └── vendor/mindar-1.2.5/       # MindAR 运行时分发包（含内联 tfjs 与 worker）
├── scripts/
│   ├── compile-target.mjs         # 海报 → .mind 的编译脚本
│   └── gen-cert.py                # 自签名 HTTPS 证书生成
├── src/
│   ├── main.js                    # 装配层 + 唯一主循环
│   ├── ar/
│   │   ├── MindARLite.js          # MindAR 的 three.js 适配层（复用官方 Controller）
│   │   └── MockAR.js              # 无摄像头时的替身（接口与几何约定完全一致）
│   ├── core/movement.js           # 纯函数移动学（无 three / 无 DOM，可 node 单测）
│   ├── character/CharacterController.js  # GLTFLoader + AnimationMixer + crossFade
│   ├── input/Joystick.js          # nipplejs 封装（死区 / 回中 / 防卡住）
│   ├── fx/                        # ContactShadow / Petals / Footprints
│   ├── ui/Hud.js                  # 状态药丸 / 遮罩 / 进度 / toast
│   ├── audio/Sfx.js               # WebAudio 合成音效（无外部音频文件）
│   └── style/main.css             # 非遗视觉风格
├── tests/
│   ├── movement.test.mjs          # node --test 纯逻辑单测
│   └── e2e.mjs                    # Playwright 端到端验收
└── docs/CONTRACT.md               # 模块接口契约（坐标系、API、DOM id、验收标准）
```

---

## 坐标系约定（最容易踩坑的地方）

海报是一个**竖直的平面**，而角色需要站在海报**表面**上像站在地面上一样跑动。
所以设了两层坐标系（详见 `docs/CONTRACT.md` §1）：

| 坐标系 | 原点 | 1 单位 | 轴 |
| --- | --- | --- | --- |
| **M**（MindAR 锚点） | 海报中心 | 海报宽度 | +X 右、+Y 海报上、+Z 海报法线朝观察者 |
| **P**（posterSpace） | 海报中心 | 海报宽度 | +X 右、+Y **垂直海报向外**、+Z 海报下沿 |

`posterSpace` 是 M 的子节点，只做一次 `rotation.x = +Math.PI / 2`：

```
P.x = M.x        P.y =  M.z        P.z = -M.y
```

于是 P 就是一个标准 three 地面系：地面 `y = 0` 恰好是海报表面，
角色 `group.position.y = 0` 就实现了「双脚落在海报上」。
角色移动、朝向、阴影、脚印全部在 P 系内计算，轴向转换只在 `MindARLite` 里发生一次。

---

## 关键实现说明

### 1. 复用而不是重写

- **图像识别**：直接用 MindAR 官方 `Controller`（`public/vendor/mindar-1.2.5/`），
  自己只写 three.js 适配层（约 400 行），因为官方 `mindar-image-three` 的 npm 包已不再发布。
  适配层不实例化 MindAR 自带的 UI，避免它往 `<body>` 注入自己的遮罩。
- **虚拟摇杆**：直接用 nipplejs（`mode:'static'`），只在其上封装死区、力度归一化、
  回中与防卡住逻辑，不自己写触摸手势。
- **模型加载与动画**：three 官方 `GLTFLoader` + `AnimationMixer`。

### 2. 位移只由代码驱动

GLB 里所有动画剪辑的 `Root.translation` 恒为 `(0,0,0)`（已从二进制实证），
Walk/Run 是原地循环。因此：

- 角色位移 **完全** 由 `core/movement.js` 的纯函数计算，写入 `group.position`；
- 动画只负责腿部动作，不用整体抖动伪装跑步；
- 不存在「网页位移」与「根节点动画位移」重复叠加的问题。

### 3. 识别丢失必须停止移动

主循环里 `tracking === false` 时：

- 输入强制归零、**不调用** `stepMovement`、速度清零；
- 摇杆 `forceReset()` 并禁用；
- 特效淡出、脚印清空。

这满足「禁止识别失败时仍在后台持续移动角色」的硬性要求。
重新识别后从原位置平滑恢复。

### 4. 移动方向与手机画面一致

`screenBasis()` 每帧把屏幕的右方向与上方向投影到海报平面（P 系），
得到 `{right, up}` 两个单位向量，摇杆输入 `(jx, jy)` 就映射为

```
dir = right * jx + up * jy
```

相机绕到海报另一侧时 `right/up` 会自动翻转，所以「推摇杆往上 = 角色往画面上方走」始终成立。

---

## 测试

```bash
npm test              # 纯逻辑单测（移动学，19 项）
npm run build         # 产物构建
npm run test:e2e      # Playwright 端到端（自动起静态服务器 + headless Chromium，22 项）
npm run test:ar       # 真 AR 链路：假摄像头喂海报，跑真实 MindAR 识别（14 项）
npm run test:pages    # GitHub Pages 子路径部署校验（12 项）
npm run test:shots    # 视觉验收截图，输出到 tests/shots-ar/
npm run test:all      # 按序跑单测 → 构建 → E2E → 真 AR → 子路径
```

E2E 用 `?mock=1` 在无摄像头环境下验证：模型载入、五个动画剪辑、
摇杆位移 / 步态切换 / 边界裁剪 / 松手回中、识别丢失停止移动、
特效挂载、HUD 状态、跳跃与重新定位。

`test:ar` 不打 mock：它 monkey-patch `getUserMedia`，用 canvas 合成一段
"桌面平放海报、手机斜上方俯看"的假摄像头画面，交给**真实 MindAR** 做识别，
因此能验证图像目标文件、锚点位姿、Y-up 与图像平面轴向转换、脚底贴面、
识别丢失与恢复这些只有真链路才暴露的问题。

`test:pages` 把 `dist/` 挂在 `/gugu-adventure/` 前缀下起服务器，
模拟 GitHub Pages 项目站点的子路径，确认相对路径资源全部可取。

---

## 重新编译识别目标

替换 `public/targets/nigugu.jpg` 后：

```bash
npm run target      # node scripts/compile-target.mjs，输出 public/targets/nigugu.mind
```

脚本用 Playwright 在真实浏览器里跑 MindAR 的 `Compiler`（它依赖浏览器的 WebGL/Worker 环境）。

---

## 部署到 GitHub Pages

仓库自带 `.github/workflows/deploy.yml`：

1. 把项目推到 GitHub（默认分支 `main` 或 `master`）。
2. 仓库 Settings → Pages → Source 选 **GitHub Actions**。
3. 推送即自动跑 `npm ci` → `npm test` → `npm run build` → 部署 `dist`。

因为 `vite.config.js` 里 `base: './'`，产物在 `/仓库名/` 这样的子路径下也能正常工作
（`npm run test:pages` 就是本地模拟这个子路径做的回归）。

推送到远端：

```bash
# 首次：在 GitHub 上新建空仓库后
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

> **关于 HTTPS**：GitHub Pages 默认提供 HTTPS，所以部署后手机可以直接用
> `https://<用户名>.github.io/<仓库名>/` 打开 —— 后置摄像头要求安全上下文，
> 这一点正好满足。本地调试才需要用 `npm run cert` 生成自签证书。
GitHub Pages 本身是 HTTPS，摄像头权限可直接使用。

---

## 浏览器支持

| 平台 | 状态 | 备注 |
| --- | --- | --- |
| iOS Safari 15+ | 主要目标 | 需要 HTTPS；`playsinline` + `muted` + `autoplay` 齐全；`100dvh` 适配地址栏 |
| Android Chrome 100+ | 主要目标 | 需要 HTTPS |
| 桌面 Chrome / Edge | 可调试 | 走 `?mock=1` 或不带 mock 用电脑摄像头 |

已处理的移动端边界情况：

- **HTTPS**：dev server 自签名证书 + GitHub Pages 原生 HTTPS；非安全上下文给出明确中文提示。
- **摄像头权限**：`NotAllowedError` / `NotFoundError` / `NotReadableError` / `SecurityError` 分别给出中文说明，
  并提供「重试」。`OverconstrainedError` 时退化为 `{video:true}` 再试一次。
- **资源加载失败**：模型与识别目标分别有失败遮罩与重试，进度条走 `onProgress`。
- **识别丢失**：停止移动 + 摇杆归零 + 状态药丸变红；重新识别后恢复。
- **触摸事件**：摇杆用 nipplejs 原生 touch/pointer 处理；按钮双绑 `touchstart` + `click` 并做 600ms 去重。
- **摇杆卡住**：全局 `touchend/pointerup/blur/visibilitychange/pagehide` 兜底 `forceReset()`。
- **屏幕旋转**：`orientationchange` 后延迟两次 `resize()`（200ms / 600ms），重新计算 FOV 与视频铺满偏移。
- **页面切换**：`visibilitychange` / `pagehide` 立即停止移动并暂停主循环，回到前台恢复。

---

## 素材来源与版权

- 海报与角色模型（`public/targets/nigugu.jpg`、`public/nigugu.glb`）由项目作者提供。
- 泥咕咕为河南浚县国家级非物质文化遗产，本项目为其数字化展示，非商业用途。
- MindAR.js 遵循 MIT 许可（`public/vendor/mindar-1.2.5/LICENSE`）；Three.js MIT；nipplejs MIT。
- 页面内所有音效均由 WebAudio 实时合成，无第三方音频素材。
