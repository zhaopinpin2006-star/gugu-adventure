/**
 * 屏幕旋转 / 尺寸变化回归测试。
 *
 * 覆盖用户需求里的"屏幕旋转"边界情况：
 *   1. 旋转后 #joystick-zone 按 CSS 媒体查询缩小，摇杆内部 .back/.front 必须跟着缩，
 *      不能保持创建时的像素尺寸（否则视觉溢出色环、触点与视觉错位）。
 *   2. 旋转后 canvas 尺寸跟着容器变，摄像机纵横比更新，画面不能被拉伸。
 *   3. 旋转后角色位置、步态、动画不被打断。
 *   4. 旋转过程中不出未捕获错误。
 *
 * 用法：node tests/rotation.mjs（需先 npm run build）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = 4393;
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

/** 读摇杆与画布的当前几何状态。 */
const readGeometry = () => {
  const zone = document.querySelector('#joystick-zone');
  const back = zone?.querySelector('.back');
  const front = zone?.querySelector('.front');
  const canvas = document.querySelector('#ar-container canvas');
  const rect = (el) => (el ? el.getBoundingClientRect() : null);
  const zr = rect(zone);
  const br = rect(back);
  const fr = rect(front);
  const cr = rect(canvas);
  return {
    cssVar: zone ? getComputedStyle(zone).getPropertyValue('--joystick-size').trim() : null,
    zone: zr ? { w: Math.round(zr.width), h: Math.round(zr.height) } : null,
    back: br ? { w: Math.round(br.width), h: Math.round(br.height) } : null,
    front: fr ? { w: Math.round(fr.width), h: Math.round(fr.height) } : null,
    canvas: cr ? { w: Math.round(cr.width), h: Math.round(cr.height) } : null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    cameraAspect: window.__GUGU__?.ar?.camera?.aspect ?? null,
    pos: window.__GUGU__?.movement ? [+window.__GUGU__.movement.x.toFixed(3), +window.__GUGU__.movement.z.toFixed(3)] : null,
    gait: window.__GUGU__?.gait ?? null,
  };
};

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

  // ── 竖屏基准 ────────────────────────────────────────────────────────────
  const portrait = await page.evaluate(readGeometry);
  check(portrait.zone?.w === 132, '竖屏摇杆底盘 132px', `zone=${portrait.zone?.w}`);
  check(portrait.back?.w === 130, '竖屏 nipple 内径与底盘相称', `back=${portrait.back?.w}`);
  check(portrait.canvas?.w === portrait.viewport.w, '竖屏 canvas 铺满宽度', `${portrait.canvas?.w}/${portrait.viewport.w}`);

  // 走两步，让角色离开中心，旋转后要能保持
  const box = await page.locator('#joystick-zone').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2, { steps: 2 });
  await page.waitForTimeout(420);
  await page.mouse.up();
  await page.waitForTimeout(120);
  const beforeRotate = await page.evaluate(readGeometry);
  check(Math.abs(beforeRotate.pos[0] - portrait.pos[0]) > 0.02, '旋转前角色已经走动', `pos=(${beforeRotate.pos})`);

  // ── 旋转到横屏 ──────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(900);

  const landscape = await page.evaluate(readGeometry);
  const expected = parseInt(landscape.cssVar, 10);
  check(
    landscape.zone?.w === expected,
    '横屏摇杆底盘跟随 CSS 变量缩小',
    `zone=${landscape.zone?.w} css=${landscape.cssVar}`
  );
  check(
    landscape.back?.w === expected - 2,
    '横屏 nipple 内径同步重建（不溢出色环）',
    `back=${landscape.back?.w} 期望≈${expected - 2}`
  );
  check(
    landscape.front && Math.abs(landscape.front.w - landscape.back.w / 2) <= 2,
    '横屏推杆直径为底盘一半',
    `front=${landscape.front?.w} back=${landscape.back?.w}`
  );
  check(
    landscape.canvas?.w === landscape.viewport.w && landscape.canvas?.h === landscape.viewport.h,
    '横屏 canvas 跟随视口',
    `${landscape.canvas?.w}x${landscape.canvas?.h} vs ${landscape.viewport.w}x${landscape.viewport.h}`
  );
  check(
    landscape.cameraAspect && Math.abs(landscape.cameraAspect - landscape.viewport.w / landscape.viewport.h) < 0.02,
    '横屏摄像机纵横比已更新',
    `aspect=${landscape.cameraAspect?.toFixed(3)} 期望≈${(landscape.viewport.w / landscape.viewport.h).toFixed(3)}`
  );
  check(
    Math.abs(landscape.pos[0] - beforeRotate.pos[0]) < 1e-6 && Math.abs(landscape.pos[1] - beforeRotate.pos[1]) < 1e-6,
    '旋转不改变角色位置',
    `before=(${beforeRotate.pos}) after=(${landscape.pos})`
  );
  check(landscape.gait === 'idle', '旋转后步态回落 idle（没有卡在移动态）', landscape.gait);

  // 横屏下摇杆仍然能推
  const box2 = await page.locator('#joystick-zone').boundingBox();
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2 - 24, { steps: 2 });
  await page.waitForTimeout(420);
  const moving = await page.evaluate(() => ({
    input: { ...window.__GUGU__.input },
    pos: [+window.__GUGU__.movement.x.toFixed(3), +window.__GUGU__.movement.z.toFixed(3)],
  }));
  await page.mouse.up();
  check(Math.abs(moving.input.force) > 0, '横屏下摇杆仍能读数', `force=${moving.input.force.toFixed(2)}`);

  // ── 转回竖屏 ────────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(900);
  const back2 = await page.evaluate(readGeometry);
  check(back2.zone?.w === 132, '转回竖屏摇杆恢复 132px', `zone=${back2.zone?.w}`);
  check(back2.back?.w === 130, '转回竖屏 nipple 内径恢复', `back=${back2.back?.w}`);
  check(
    back2.canvas?.w === back2.viewport.w && back2.canvas?.h === back2.viewport.h,
    '转回竖屏 canvas 恢复',
    `${back2.canvas?.w}x${back2.canvas?.h}`
  );

  check(pageErrors.length === 0, '旋转全过程无未捕获错误', pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '');

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
  console.error('旋转测试异常：', err);
  server.close();
  process.exit(1);
});
