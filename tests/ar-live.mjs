/**
 * tests/ar-live.mjs — 阶段一 & 阶段二的"真 AR"验证
 *
 * E2E（tests/e2e.mjs）跑的是 MockAR，不碰 tfjs。这个脚本不一样：
 * 它 monkey-patch `navigator.mediaDevices.getUserMedia`，把「海报图片画到 canvas
 * 再 captureStream()」伪装成后置摄像头画面，于是 MindAR 的**真实 Controller**
 * （tfjs + 编译好的 nigugu.mind）会真的去识别这幅海报。
 *
 * 于是能在没有真机的情况下验证：
 *   1. nigugu.mind 确实是从这张海报编译出来的（能被识别）；
 *   2. MindARLite 的 postMatrix / 轴向转换没有把锚点算歪（角色出现在海报中心）；
 *   3. 角色模型能挂到锚点下且脚底贴地；
 *   4. 把海报移出画面后 isTracking 会变 false（识别丢失 → 停止移动的前提）。
 *
 * 用法：npm run build && node tests/ar-live.mjs
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { homedir } from 'node:os';
import { chromium } from 'playwright';

const ROOT = resolve(process.cwd(), 'dist');
const PORT = 4400;

function findChromium() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  const pwRoot = join(homedir(), 'AppData', 'Local', 'ms-playwright');
  if (existsSync(pwRoot)) {
    const dirs = readdirSync(pwRoot).filter((d) => d.startsWith('chromium-')).sort().reverse();
    for (const d of dirs) {
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome']) {
        const p = join(pwRoot, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.mind': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm'
};

function startServer() {
  return new Promise((res) => {
    const server = createServer(async (req, resp) => {
      try {
        const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
        let path = decodeURIComponent(url.pathname).replace(/\\/g, '/');
        if (path === '/' || path.endsWith('/')) path += 'index.html';
        const file = join(ROOT, normalize(path).replace(/^([/\\])+/, ''));
        if (!file.startsWith(ROOT)) {
          resp.writeHead(403).end('forbidden');
          return;
        }
        const s = await stat(file).catch(() => null);
        if (!s || !s.isFile()) {
          resp.writeHead(404).end('not found');
          return;
        }
        const buf = await readFile(file);
        resp.writeHead(200, {
          'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Length': buf.length,
          'Cache-Control': 'no-store'
        });
        resp.end(buf);
      } catch (e) {
        resp.writeHead(500).end(String(e));
      }
    });
    server.listen(PORT, '127.0.0.1', () => res(server));
  });
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

/**
 * 把「假摄像头」装进页面：getUserMedia 返回 canvas 流。
 * 画面上按 poster 真实比例绘制海报（默认占画面高度 68%），
 * 并带一点缓慢平移，让 MindAR 的滤波器有条件收敛。
 */
const FAKE_CAMERA = () => {
  // ---- 测试环境专用补丁 ----
  // tfjs（MindAR 内部）用 `failIfMajorPerformanceCaveat: true` 取 WebGL 上下文。
  // 无头 Chrome 走 SwiftShader 软渲染，正好被这条判据拒绝 →
  // "Could not get context for WebGL version 1/2" → Controller 构造抛错。
  // 真机有 GPU，不受影响；这里只在测试里把该判据关掉。
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function patched(type, attrs) {
    if (attrs && attrs.failIfMajorPerformanceCaveat) {
      attrs = Object.assign({}, attrs, { failIfMajorPerformanceCaveat: false });
    }
    return origGetContext.call(this, type, attrs);
  };

  const W = 1280;
  const H = 720;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const state = { showPoster: true, t: 0, ready: false };
  window.__FAKE_CAM__ = state;

  const img = new Image();
  img.onload = () => {
    state.ready = true;
  };
  img.src = 'targets/nigugu.jpg';

  // 白底，模拟真实的海报拍摄环境
  function draw() {
    ctx.fillStyle = '#efe9df';
    ctx.fillRect(0, 0, W, H);

    if (state.showPoster && state.ready) {
      const posterH = H * 0.68;
      const posterW = posterH * (img.naturalWidth / img.naturalHeight);
      const driftX = Math.sin(state.t * 0.9) * 26;
      const driftY = Math.cos(state.t * 0.7) * 16;
      ctx.save();
      ctx.translate(W / 2 + driftX, H / 2 + driftY);
      // 轻微旋转 + 缩放抖动，模拟手持晃动（幅度刻意很小，避免真的跟丢）
      ctx.rotate(Math.sin(state.t * 0.5) * 0.02);
      ctx.drawImage(img, -posterW / 2, -posterH / 2, posterW, posterH);
      ctx.restore();
    }
    state.t += 1 / 30;
  }
  draw();
  setInterval(draw, 1000 / 30);

  const stream = canvas.captureStream(30);
  const orig = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    : null;
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (constraints && constraints.video) return stream;
    if (orig) return orig(constraints);
    throw new Error('no getUserMedia');
  };
  navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'videoinput', deviceId: 'fake', label: 'fake' }];
};

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required']
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: true
  });
  await page.addInitScript(FAKE_CAMERA);

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push('[console] ' + m.text());
  });

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#btn-start', { state: 'visible', timeout: 20000 });
    await page.click('#btn-start');

    // 假摄像头就绪（海报图片解码完成）
    await page.waitForFunction(() => window.__FAKE_CAM__ && window.__FAKE_CAM__.ready === true, { timeout: 20000 });
    check('假摄像头就绪（海报已绘制）', true);

    // ---- 真实 MindAR 识别 ----
    const t0 = Date.now();
    let tracked = false;
    try {
      await page.waitForFunction(
        () => window.__GUGU__ && window.__GUGU__.ar && window.__GUGU__.ar.isTracking === true,
        { timeout: 90000 }
      );
      tracked = true;
    } catch (e) {
      tracked = false;
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    check('真实 MindAR 认出海报（非 mock）', tracked, tracked ? `耗时 ${elapsed}s` : `${elapsed}s 内未识别`);
    if (!tracked) {
      const dbg = await page.evaluate(() => ({
        hasGugu: !!window.__GUGU__,
        ar: window.__GUGU__ && window.__GUGU__.ar ? window.__GUGU__.ar.constructor.name : null,
        status: document.querySelector('#status-text') && document.querySelector('#status-text').textContent
      }));
      console.log('  debug:', JSON.stringify(dbg));
      throw new Error('识别未成功，后续断言跳过');
    }

    // ---- 锚点几何 ----
    // 注意：character.group 的 matrixWorld 是「相机空间」的，其中包含 postMatrix
    // 的 800 像素缩放，数值会是几千，不是判断依据。
    // 判断依据是它在 posterSpace（也就是海报局部地面系）里的局部位置：
    // posterSpace 的原点 = 海报中心、y=0 = 海报表面、1 单位 = 海报宽度。
    const geom = await page.evaluate(async () => {
      const s = window.__GUGU__;
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
      const local = s.character.position;
      // 再用世界矩阵反算一次，交叉验证 posterSpace 的变换没坏
      const back = s.ar.posterSpace
        .worldToLocal(s.character.getWorldPosition(new s.character.position.constructor()))
        .clone();
      return {
        local: { x: local.x, y: local.y, z: local.z },
        back: { x: back.x, y: back.y, z: back.z },
        half: s.ar.posterHalf,
        posterAspect: s.ar.targetAspect,
        anchorVisible: !!s.ar.posterSpace.parent && s.ar.posterSpace.parent.visible,
        tracking: s.ar.isTracking,
        posterSpaceRotX: s.ar.posterSpace.rotation.x
      };
    });
    check('锚点组已可见', geom.anchorVisible === true);
    check(
      'posterSpace 已把海报平面旋成地面（rotation.x = π/2）',
      Math.abs(geom.posterSpaceRotX - Math.PI / 2) < 1e-6,
      `rotation.x=${geom.posterSpaceRotX.toFixed(4)}`
    );
    check(
      '海报纵横比与目标文件一致（1000/800 = 1.25）',
      Math.abs(geom.posterAspect - 1.25) < 1e-6,
      `aspect=${geom.posterAspect}`
    );
    check(
      '角色站在海报范围内',
      Math.abs(geom.local.x) <= geom.half.halfX + 1e-6 && Math.abs(geom.local.z) <= geom.half.halfZ + 1e-6,
      `local=(${geom.local.x.toFixed(2)},${geom.local.y.toFixed(2)},${geom.local.z.toFixed(2)}) 范围 x±${geom.half.halfX} z±${geom.half.halfZ.toFixed(2)}`
    );
    check(
      '角色脚底 y≈0（贴海报表面）',
      Math.abs(geom.local.y) < 1e-6,
      `y=${geom.local.y.toFixed(4)}`
    );
    check(
      'worldToLocal 反算与局部坐标一致（锚点矩阵自洽）',
      Math.hypot(geom.back.x - geom.local.x, geom.back.y - geom.local.y, geom.back.z - geom.local.z) < 1e-4,
      `back=(${geom.back.x.toFixed(3)},${geom.back.y.toFixed(3)},${geom.back.z.toFixed(3)})`
    );

    // ---- 模型与动画 ----
    const model = await page.evaluate(() => {
      const s = window.__GUGU__;
      let skinned = 0;
      let bones = 0;
      s.character.traverse((o) => {
        if (o.isSkinnedMesh) skinned++;
        if (o.isBone) bones++;
      });
      return {
        skinned,
        bones,
        anims: s.controller.animationNames.slice().sort(),
        gait: s.movement.gait
      };
    });
    check('GLB 骨骼网格已挂载', model.skinned > 0 && model.bones >= 13, `mesh=${model.skinned} bones=${model.bones}`);
    check(
      '五个动画可用（真实识别路径）',
      JSON.stringify(model.anims) === JSON.stringify(['Cheer', 'Idle', 'Jump', 'Run', 'Walk']),
      model.anims.join('/')
    );

    // ---- 识别丢失：把海报从画面里拿掉 ----
    await page.evaluate(() => {
      window.__FAKE_CAM__.showPoster = false;
    });
    let lostOk = false;
    try {
      await page.waitForFunction(
        () => window.__GUGU__.ar.isTracking === false,
        { timeout: 30000 }
      );
      lostOk = true;
    } catch (e) {
      lostOk = false;
    }
    check('海报移出画面后识别丢失', lostOk);

    // ---- 丢失后角色不得移动 ----
    if (lostOk) {
      const drift = await page.evaluate(async () => {
        const s = window.__GUGU__;
        s.input = { x: 1, y: 0, force: 1 };
        const b = { x: s.movement.x, z: s.movement.z };
        await new Promise((r) => setTimeout(r, 700));
        return Math.hypot(s.movement.x - b.x, s.movement.z - b.z);
      });
      check('识别丢失后角色零位移', drift < 1e-9, `drift=${drift.toExponential(2)}`);
    }

    // ---- 放回海报 → 重新识别并恢复 ----
    await page.evaluate(() => {
      window.__FAKE_CAM__.showPoster = true;
    });
    let regained = false;
    try {
      await page.waitForFunction(() => window.__GUGU__.ar.isTracking === true, { timeout: 60000 });
      regained = true;
    } catch (e) {
      regained = false;
    }
    check('海报放回画面后重新识别', regained);

    const fatal = errors.filter((e) => !/favicon|net::ERR_/i.test(e));
    check('真 AR 路径无未捕获错误', fatal.length === 0, fatal.slice(0, 3).join(' | '));
  } catch (err) {
    check('真 AR 流程异常', false, err && err.message);
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} 项通过 ===`);
  if (failed.length) {
    console.error('失败项：\n' + failed.map((f) => ` - ${f.name} (${f.detail || ''})`).join('\n'));
    process.exitCode = 1;
  }
}

main();
