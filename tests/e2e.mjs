/**
 * 端到端验收（Playwright + headless Chromium）。
 *
 * 覆盖 docs/CONTRACT.md 里可自动化的验收点：
 *   阶段二  GLB 载入 + 五个动画剪辑全部就绪
 *   阶段三  摇杆推动 → 位移 / 朝向 / 步态切换 / 边界裁剪 / 松手回中
 *   阶段三  识别丢失 → 停止移动（关键硬性要求）
 *   阶段四  特效对象存在且有可见几何、HUD 状态切换、按钮可用
 *
 * 运行：node tests/e2e.mjs        （需要先 npm run build）
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { homedir } from 'node:os';
import { chromium } from 'playwright';

const ROOT = resolve(process.cwd(), 'dist');
const PORT = 4399;

/**
 * 找一个能用的 Chromium 可执行文件。
 * 本机 playwright 1.56.1 期望 chromium-1194，但磁盘上装的是更新的 1254，
 * 所以依次尝试：系统 Chrome → ms-playwright 里任意版本的 chrome.exe → 让 playwright 自己找。
 */
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
    const dirs = readdirSync(pwRoot)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .reverse();
    for (const d of dirs) {
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
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
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
};

function startServer() {
  return new Promise((res) => {
    const server = createServer(async (req, resp) => {
      try {
        const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
        let path = decodeURIComponent(url.pathname);
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
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  const server = await startServer();
  const exe = findChromium();
  const browser = await chromium.launch({
    executablePath: exe,
    args: ['--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--no-sandbox']
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true
  });

  const errors = [];
  const failedRequests = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => failedRequests.push(`${r.url()} (${r.failure() && r.failure().errorText})`));
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.url()} → ${r.status()}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const t = m.text();
      // 404 由上面的 response 监听统一报（带 URL），这里只收真正的脚本错误
      if (!/Failed to load resource/i.test(t)) errors.push('[console] ' + t);
    }
  });

  try {
    await page.goto(`http://127.0.0.1:${PORT}/?mock=1`, { waitUntil: 'load', timeout: 30000 });

    // ---- 启动遮罩 ----
    await page.waitForSelector('#btn-start', { state: 'visible', timeout: 15000 });
    check('启动遮罩出现', true);

    await page.click('#btn-start');

    // ---- 等 AR mock 锁定 + 角色加载 ----
    await page.waitForFunction(
      () => window.__GUGU__ && window.__GUGU__.ar && window.__GUGU__.ar.isTracking === true,
      { timeout: 25000 }
    );
    await page.waitForFunction(
      () => window.__GUGU__ && window.__GUGU__.character && window.__GUGU__.controller,
      { timeout: 25000 }
    );
    check('Mock AR 锁定海报', true);

    // ---- 阶段二：动画剪辑齐全 ----
    const anims = await page.evaluate(() => window.__GUGU__.controller.animationNames.slice().sort());
    const want = ['Cheer', 'Idle', 'Jump', 'Run', 'Walk'];
    check('五个动画剪辑就绪', JSON.stringify(anims) === JSON.stringify(want), anims.join('/'));

    // ---- 角色脚底贴海报 ----
    const boot = await page.evaluate(() => {
      const g = window.__GUGU__.character;
      return { y: g.position.y, x: g.position.x, z: g.position.z };
    });
    check('角色脚底 y=0 贴海报表面', Math.abs(boot.y) < 1e-6, `y=${boot.y}`);

    // ---- 阶段三：摇杆 ----
    const box = await page.locator('#joystick-zone').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const radius = Math.min(box.width, box.height) / 2;

    /**
     * 每次摇杆测试前把角色放回"左边界"。
     * 海报可活动范围只有 halfX - margin = 0.37，从中心推 0.37 就到墙；
     * 撞墙后规则 5 会把该轴速度清零 → speed=0 → gait=idle，
     * 于是"有没有切 walk/run"会被误判成失败。从左边界出发能跑满 0.74 个身位。
     */
    const armRecorder = (startX) =>
      page.evaluate((x0) => {
        const s = window.__GUGU__;
        Object.assign(s.movement, { x: x0, z: 0, vx: 0, vz: 0, speed: 0, gait: 'idle' });
        const rec = { gaits: [], maxSpeed: 0, startX: x0, on: true };
        window.__REC__ = rec;
        const tick = () => {
          if (!rec.on) return;
          const m = window.__GUGU__.movement;
          if (rec.gaits[rec.gaits.length - 1] !== m.gait) rec.gaits.push(m.gait);
          if (m.speed > rec.maxSpeed) rec.maxSpeed = m.speed;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }, startX);

    const stopRecorder = () =>
      page.evaluate(() => {
        const rec = window.__REC__;
        rec.on = false;
        return {
          gaits: rec.gaits,
          maxSpeed: rec.maxSpeed,
          startX: rec.startX,
          x: window.__GUGU__.movement.x
        };
      });

    /** 按住摇杆推到 ratio × 半径处，保持 stay 毫秒后松手，返回记录到的 gait 序列。 */
    const pushJoystick = async (ratio, stay) => {
      await armRecorder(-0.37); // 站到左边界
      await page.waitForTimeout(120);
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      const dist = radius * ratio;
      // 只走两步：playwright 每次 mouse.move 都是一次 CDP 往返，步数多了会吃掉保持时间
      await page.mouse.move(cx + dist * 0.5, cy);
      await page.mouse.move(cx + dist, cy);
      await page.waitForTimeout(stay);
      const rec = await stopRecorder();
      await page.mouse.up();
      await page.waitForTimeout(260);
      return rec;
    };

    const walked = await pushJoystick(0.42, 520); // force≈0.42 → 落在 walk 区间
    check('摇杆驱动位移', walked.x - walked.startX > 0.02, `Δx=${(walked.x - walked.startX).toFixed(3)}`);
    check(
      '轻推切到 walk 且不越档到 run',
      walked.gaits.includes('walk') && !walked.gaits.includes('run'),
      `gaits=${walked.gaits.join('→')} maxSpeed=${walked.maxSpeed.toFixed(3)}`
    );

    const ran = await pushJoystick(0.95, 520); // force≈0.95 → run
    check(
      '重推切到 run',
      ran.gaits.includes('run'),
      `gaits=${ran.gaits.join('→')} maxSpeed=${ran.maxSpeed.toFixed(3)}`
    );
    check('run 速度高于 walk', ran.maxSpeed > walked.maxSpeed,
      `run=${ran.maxSpeed.toFixed(3)} walk=${walked.maxSpeed.toFixed(3)}`);

    // ---- 松手回中 ----
    await page.mouse.up();
    await page.waitForTimeout(900);
    const rest = await page.evaluate(() => {
      const m = window.__GUGU__.movement;
      const i = window.__GUGU__.input;
      return { gait: m.gait, speed: m.speed, ix: i.x, iy: i.y, force: i.force };
    });
    check('松手后摇杆回中', Math.abs(rest.ix) < 0.05 && Math.abs(rest.iy) < 0.05, `in=(${rest.ix.toFixed(2)},${rest.iy.toFixed(2)})`);
    check('松手后回到 idle', rest.gait === 'idle', rest.gait);

    // ---- 边界裁剪 ----
    const clamped = await page.evaluate(async () => {
      const s = window.__GUGU__;
      // 直接把状态推到边界外，验证 stepMovement 的裁剪
      s.movement.x = 5;
      s.movement.z = 5;
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => setTimeout(r, 300));
      return { x: s.movement.x, z: s.movement.z, halfX: s.bounds.halfX, halfZ: s.bounds.halfZ };
    });
    check('移动被限制在海报边界内', clamped.x <= clamped.halfX + 1e-6 && clamped.z <= clamped.halfZ + 1e-6,
      `pos=(${clamped.x.toFixed(3)},${clamped.z.toFixed(3)}) half=(${clamped.halfX},${clamped.halfZ.toFixed(3)})`);

    // ---- 识别丢失：必须停止移动 ----
    const lost = await page.evaluate(async () => {
      const s = window.__GUGU__;
      s.ar._tracking = false;
      s.input = { x: 1, y: 0, force: 1 };
      const before = { x: s.movement.x, z: s.movement.z };
      await new Promise((r) => setTimeout(r, 600));
      const after = { x: s.movement.x, z: s.movement.z, speed: s.movement.speed };
      s.ar._tracking = true;
      return { before, after };
    });
    const drift = Math.hypot(lost.after.x - lost.before.x, lost.after.z - lost.before.z);
    check('识别丢失时角色不移动', drift < 1e-6 && Math.abs(lost.after.speed) < 1e-6, `drift=${drift.toExponential(2)}`);

    // ---- 阶段四：特效与 UI ----
    const fx = await page.evaluate(() => {
      const s = window.__GUGU__;
      const count = (obj) => {
        let n = 0;
        obj.traverse((o) => { if (o.isMesh || o.isPoints || o.isSprite) n++; });
        return n;
      };
      return {
        shadow: !!s.shadow && count(s.shadow.object3D) > 0,
        petals: !!s.petals && count(s.petals.object3D) > 0,
        footprints: !!s.footprints && typeof s.footprints.getState === 'function',
        footprintPool: s.footprints ? s.footprints.getState().pool : 0,
        inPosterSpace: !!(s.shadow.object3D.parent && s.shadow.object3D.parent === s.ar.posterSpace)
      };
    });
    check('接触阴影已挂载', fx.shadow);
    check('花瓣粒子已挂载', fx.petals);
    check('脚印系统已挂载', fx.footprints && fx.footprintPool > 0, `pool=${fx.footprintPool}`);
    check('特效挂在海报坐标系下', fx.inPosterSpace);

    const ui = await page.evaluate(() => ({
      status: document.querySelector('#status-text')?.textContent || '',
      jumpDisabled: document.querySelector('#btn-jump')?.disabled ?? null,
      recenterDisabled: document.querySelector('#btn-recenter')?.disabled ?? null,
      overlayHidden: document.querySelector('#overlay')?.classList.contains('hidden')
    }));
    check('顶部识别状态已更新', ui.status.length > 0, ui.status);
    check('识别成功后跳跃按钮可用', ui.jumpDisabled === false || ui.jumpDisabled === null);

    // ---- 跳跃 ----
    const jump = await page.evaluate(async () => {
      const s = window.__GUGU__;
      document.querySelector('#btn-jump').click();
      await new Promise((r) => setTimeout(r, 120));
      const airborne = s.isAirborne;
      const label = s.controller.currentLoopLabel;
      await new Promise((r) => setTimeout(r, 1800));
      return { airborne, label, after: s.isAirborne };
    });
    check('跳跃按钮触发 one-shot', jump.airborne === true, `airborne=${jump.airborne}`);
    check('跳跃后自动落地', jump.after === false);

    // ---- 重新定位 ----
    const recentered = await page.evaluate(async () => {
      const s = window.__GUGU__;
      s.movement.x = 0.4;
      s.movement.z = -0.4;
      document.querySelector('#btn-recenter').click();
      await new Promise((r) => setTimeout(r, 300));
      return { x: s.movement.x, z: s.movement.z };
    });
    check('重新定位把角色拉回中心', Math.hypot(recentered.x, recentered.z - 0.12) < 0.05,
      `pos=(${recentered.x.toFixed(2)},${recentered.z.toFixed(2)})`);

    // ---- 页面无致命错误 ----
    const fatal = errors.filter((e) => !/favicon|net::ERR_/i.test(e));
    check('运行时无未捕获错误', fatal.length === 0, fatal.slice(0, 3).join(' | '));
  } catch (err) {
    check('E2E 流程异常', false, err && err.message);
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
