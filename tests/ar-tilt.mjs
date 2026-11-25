/**
 * tests/ar-tilt.mjs —— 用「俯看平放海报」的假摄像头跑真实 MindAR 管线，
 * 量出角色在屏幕上的实际观感，并截图供人工验收。
 *
 * 背景：把海报当地面时，正对拍摄只能看到角色头顶（一颗黑球）。
 * 真机用法是俯看，这里就用透视梯形的假镜头复现那种情况。
 */
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { homedir } from 'node:os';
import { chromium } from 'playwright';
import { fakeCameraScript } from './fake-camera.mjs';

const ROOT = resolve(process.cwd(), 'dist');
const OUT = resolve(process.cwd(), 'tests/shots-ar');
const PORT = 4408;

function findChromium() {
  for (const c of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']) {
    if (existsSync(c)) return c;
  }
  const pwRoot = join(homedir(), 'AppData', 'Local', 'ms-playwright');
  if (existsSync(pwRoot)) {
    for (const d of readdirSync(pwRoot).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome']) {
        const p = join(pwRoot, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.mind': 'application/octet-stream', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = createServer(async (req, resp) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname).replace(/\\/g, '/');
  if (p === '/' || p.endsWith('/')) p += 'index.html';
  const f = join(ROOT, normalize(p).replace(/^([/\\])+/, ''));
  const s = await stat(f).catch(() => null);
  if (!s || !s.isFile()) return resp.writeHead(404).end('nf');
  resp.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  resp.end(await readFile(f));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required']
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.addInitScript({ content: fakeCameraScript({ tilted: true }) });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#btn-start', { state: 'visible' });
  // 首屏标志是位图（logo-mark.png），且带 icon-pop 入场动画（延迟 120ms + 560ms）。
  // 截图要反映稳定态，否则拍到 opacity:0 的那一帧，看起来像"没有图标"。
  await page.waitForFunction(() => {
    const img = document.querySelector('#overlay-icon img');
    return !!img && img.complete && img.naturalWidth > 0;
  }, { timeout: 15000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, 'T0-start.png') });
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__GUGU__ && window.__GUGU__.ar && window.__GUGU__.ar.isTracking === true, { timeout: 90000 });
  console.log('  tracking ok');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, 'T1-tracked.png') });

  const geo = await page.evaluate(() => {
    const s = window.__GUGU__;
    const ar = s.ar;
    const cam = ar.camera;
    const PS = ar.posterSpace;
    PS.updateWorldMatrix(true, true);
    cam.updateMatrixWorld(true);
    const W = window.innerWidth, H = window.innerHeight;
    const toScreen = (v) => {
      const p = v.clone().project(cam);
      return { x: +((p.x * 0.5 + 0.5) * W).toFixed(1), y: +((-p.y * 0.5 + 0.5) * H).toFixed(1) };
    };
    const V3 = Object.getPrototypeOf(PS.position).constructor;
    const half = ar.posterHalf;
    const corners = [
      [-half.halfX, 0, -half.halfZ], [half.halfX, 0, -half.halfZ],
      [half.halfX, 0, half.halfZ], [-half.halfX, 0, half.halfZ]
    ].map((c) => toScreen(PS.localToWorld(new V3(c[0], c[1], c[2]))));

    const g = s.character;
    g.updateWorldMatrix(true, true);
    let box = null;
    g.traverse((o) => {
      if (o.isSkinnedMesh) {
        o.geometry.computeBoundingBox();
        const b = o.geometry.boundingBox;
        const min = { x: 1e9, y: 1e9 }, max = { x: -1e9, y: -1e9 };
        for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
          const p = toScreen(new V3(x, y, z).applyMatrix4(o.matrixWorld));
          min.x = Math.min(min.x, p.x); max.x = Math.max(max.x, p.x);
          min.y = Math.min(min.y, p.y); max.y = Math.max(max.y, p.y);
        }
        box = { min, max, w: +(max.x - min.x).toFixed(1), h: +(max.y - min.y).toFixed(1) };
      }
    });
    const pMin = { x: Math.min(...corners.map((c) => c.x)), y: Math.min(...corners.map((c) => c.y)) };
    const pMax = { x: Math.max(...corners.map((c) => c.x)), y: Math.max(...corners.map((c) => c.y)) };
    return {
      posterQuad: corners,
      posterW: +(pMax.x - pMin.x).toFixed(1),
      posterH: +(pMax.y - pMin.y).toFixed(1),
      character: box,
      charWOverPosterW: box ? +(box.w / (pMax.x - pMin.x)).toFixed(3) : null,
      charLocal: [g.position.x, g.position.y, g.position.z],
      heading: +g.rotation.y.toFixed(3),
      camPos: [cam.position.x, cam.position.y, cam.position.z]
    };
  });
  console.log(JSON.stringify(geo, null, 1));

  // 摇杆走动
  const zone = await page.locator('#joystick-zone').boundingBox();
  const cx = zone.x + zone.width / 2, cy = zone.y + zone.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy - 26, { steps: 2 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, 'T2-walk.png') });
  await page.mouse.up();
  await page.waitForTimeout(300);

  // 跳跃
  await page.tap('#btn-jump');
  await page.waitForTimeout(340);
  await page.screenshot({ path: join(OUT, 'T3-jump.png') });
  await page.waitForTimeout(1500);

  // 丢失
  await page.evaluate(() => { window.__FAKE_CAM__.showPoster = false; });
  await page.waitForFunction(() => window.__GUGU__.ar.isTracking === false, { timeout: 30000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'T4-lost.png') });
  console.log('\n[done] →', OUT);
} finally {
  await browser.close();
  server.close();
}
