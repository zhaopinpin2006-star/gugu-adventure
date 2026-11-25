/**
 * 摇杆在屏幕旋转后的尺寸一致性（诊断用）。
 * 用法：node tests/probe-joy-size.mjs
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
  '.glb': 'model/gltf-binary',
  '.mind': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = url === '/' ? 'index.html' : url.slice(1);
  let file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end('404');
  }
  if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

function findChromium() {
  const c = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) if (d.startsWith('chromium-')) c.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
  }
  return c.find((p) => fs.existsSync(p));
}

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

await page.goto(`http://127.0.0.1:${PORT}/?mock=1`, { waitUntil: 'load' });
await page.waitForSelector('#btn-start', { state: 'visible', timeout: 20000 });
await page.click('#btn-start');
await page.waitForFunction(() => window.__GUGU__?.started, null, { timeout: 45000 });
await page.waitForTimeout(700);

const probe = () =>
  page.evaluate(() => {
    const zone = document.querySelector('#joystick-zone');
    const box = (el) => (el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null);
    const tree = [];
    const walk = (el, depth) => {
      if (depth > 3) return;
      for (const child of el.children) {
        const r = child.getBoundingClientRect();
        tree.push({
          d: depth,
          cls: child.className,
          w: Math.round(r.width),
          h: Math.round(r.height),
          inline: child.getAttribute('style') || '',
        });
        walk(child, depth + 1);
      }
    };
    if (zone) walk(zone, 0);
    return {
      cssVar: getComputedStyle(zone).getPropertyValue('--joystick-size').trim(),
      zone: box(zone),
      tree,
    };
  });

console.log('竖屏 390x844:');
console.log(JSON.stringify(await probe(), null, 1));

await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(900);
console.log('横屏 844x390:');
console.log(JSON.stringify(await probe(), null, 1));

await browser.close();
server.close();
