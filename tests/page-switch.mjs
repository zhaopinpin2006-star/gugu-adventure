/**
 * 页面切换 / 后台挂起 回归测试。
 *
 * 覆盖用户需求里的"页面切换"：
 *   1. 切到后台（visibilitychange → hidden）时角色立刻停住，不能在后台继续移动。
 *   2. 切回来的那一刻位置和切走前一致（没有"补帧跳变"）。
 *   3. 摇杆在切走时被强制归零，切回来后不会"卡住"（不会保持上一轮的推杆值）。
 *   4. 整个过程中主循环能停能恢复，不重复起循环（不出现两份 rAF 导致速度翻倍）。
 *
 * 用法：node tests/page-switch.mjs（需先 npm run build）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = 4394;
const ROOT = path.resolve('dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.mind': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

const failures = [];
let passed = 0;

function check(ok, label, detail) {
  if (ok) {
    passed += 1;
    console.log(`[PASS] ${label}${detail === undefined ? '' : ' — ' + detail}`);
  } else {
    failures.push(label + (detail === undefined ? '' : ' — ' + detail));
    console.log(`[FAIL] ${label}${detail === undefined ? '' : ' — ' + detail}`);
  }
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = url === '/' ? 'index.html' : url.slice(1);
  let file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});

function findChromium() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (base && fs.existsSync(base)) {
    for (const dir of fs.readdirSync(base)) {
      if (!dir.startsWith('chromium-')) continue;
      candidates.push(path.join(base, dir, 'chrome-win64', 'chrome.exe'), path.join(base, dir, 'chrome-win', 'chrome.exe'));
    }
  }
  return candidates.find((p) => fs.existsSync(p));
}

const readState = () => ({
  running: window.__GUGU__.running,
  pos: [+window.__GUGU__.movement.x.toFixed(4), +window.__GUGU__.movement.z.toFixed(4)],
  speed: window.__GUGU__.movement.speed,
  gait: window.__GUGU__.gait,
  input: { ...window.__GUGU__.input },
});

async function main() {
  if (!fs.existsSync(ROOT)) {
    console.error('缺少 dist/，请先执行 npm run build');
    process.exit(1);
  }
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) pageErrors.push('[console] ' + m.text());
  });

  await page.goto(`http://127.0.0.1:${PORT}/?mock=1`, { waitUntil: 'load' });
  await page.waitForSelector('#btn-start', { state: 'visible', timeout: 20000 });
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__GUGU__?.started, null, { timeout: 45000 });
  await page.waitForTimeout(700);

  const idle = await page.evaluate(readState);
  check(idle.running === true, '主循环在运行', `running=${idle.running}`);

  // ── 按住摇杆让它跑起来 ──────────────────────────────────────────────────
  const box = await page.locator('#joystick-zone').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 40, { steps: 2 });
  await page.waitForTimeout(450);
  const runningState = await page.evaluate(readState);
  check(Math.abs(runningState.input.force) > 0.3, '摇杆已推起（页面切换前有输入）', `force=${runningState.input.force.toFixed(2)}`);
  check(runningState.gait !== 'idle', '摇杆推起后不是 idle', runningState.gait);

  // ── 模拟切到后台（真派发 visibilitychange，并把 document.hidden 打成 true）──
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(400);

  const hiddenA = await page.evaluate(readState);
  check(hiddenA.running === false, '后台时主循环已停', `running=${hiddenA.running}`);
  check(Math.abs(hiddenA.input.force) < 1e-6, '后台时摇杆输入已归零', `force=${hiddenA.input.force}`);
  check(hiddenA.speed === 0, '后台时速度清零', `speed=${hiddenA.speed}`);
  check(hiddenA.gait === 'idle', '后台时步态回落 idle', hiddenA.gait);

  // 后台期间再等一会儿，确认位置一点都没动（不能在后台持续移动）
  await page.waitForTimeout(1200);
  const hiddenB = await page.evaluate(readState);
  const drift = Math.hypot(hiddenB.pos[0] - hiddenA.pos[0], hiddenB.pos[1] - hiddenA.pos[1]);
  check(drift < 1e-9, '后台静止期间角色零位移', `drift=${drift.toExponential(2)}`);

  // ── 切回前台 ────────────────────────────────────────────────────────────
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.mouse.up();
  await page.waitForTimeout(700);

  const visible = await page.evaluate(readState);
  check(visible.running === true, '切回前台后主循环恢复', `running=${visible.running}`);
  check(
    Math.abs(visible.input.force) < 1e-6,
    '切回前台后摇杆没有卡住（不会保持上一轮推杆值）',
    `force=${visible.input.force}`
  );
  const resumeDrift = Math.hypot(visible.pos[0] - hiddenB.pos[0], visible.pos[1] - hiddenB.pos[1]);
  check(resumeDrift < 0.02, '切回前台没有补帧跳变', `Δ=${resumeDrift.toFixed(4)}`);

  // ── 恢复后再推一次，确认操控仍然正常 ─────────────────────────────────────
  const box2 = await page.locator('#joystick-zone').boundingBox();
  const cx2 = box2.x + box2.width / 2;
  const cy2 = box2.y + box2.height / 2;
  const before2 = await page.evaluate(readState);
  await page.mouse.move(cx2, cy2);
  await page.mouse.down();
  await page.mouse.move(cx2 + 36, cy2, { steps: 2 });
  await page.waitForTimeout(500);
  await page.mouse.up();
  await page.waitForTimeout(150);
  const after2 = await page.evaluate(readState);
  const moved = Math.hypot(after2.pos[0] - before2.pos[0], after2.pos[1] - before2.pos[1]);
  check(moved > 0.02, '页面切换后摇杆仍能驱动角色', `Δ=${moved.toFixed(3)}`);

  // ── pagehide（关页面/跳走）也不能留下移动状态 ─────────────────────────────
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.waitForTimeout(250);
  const hid = await page.evaluate(readState);
  check(Math.abs(hid.input.force) < 1e-6 && hid.speed === 0, 'pagehide 后输入与速度归零', `force=${hid.input.force} speed=${hid.speed}`);

  check(pageErrors.length === 0, '页面切换全过程无未捕获错误', pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '');

  await browser.close();
  server.close();

  const total = passed + failures.length;
  console.log(`\n=== ${passed}/${total} 项通过 ===`);
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log(' - ' + f);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('页面切换测试异常：', err);
  server.close();
  process.exit(1);
});
