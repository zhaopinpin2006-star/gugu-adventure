/**
 * GitHub Pages 子路径部署校验。
 *
 * GitHub Pages 的项目站点地址是 https://<user>.github.io/<repo>/，
 * 页面不在域名根目录下。这个脚本把 dist/ 挂在 /gugu-adventure/ 前缀下
 * 起静态服务器，再用浏览器跑一遍，确认：
 *   1. 相对路径资源（assets / nigugu.glb / targets / vendor）都能在子路径下取到；
 *   2. 游戏真的能启动、角色、动画、摇杆都正常；
 *   3. 没有 4xx/5xx、没有未捕获错误。
 *
 * 用法：node tests/pages-subpath.mjs [prefix]     默认前缀 /gugu-adventure/
 *      需要先 npm run build 产出 dist/。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = 4391;
const ROOT = path.resolve('dist');
const PREFIX = normalizePrefix(process.argv[2] || '/gugu-adventure/');

function normalizePrefix(raw) {
  let p = raw.startsWith('/') ? raw : '/' + raw;
  if (!p.endsWith('/')) p += '/';
  return p;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mind': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
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

// ── 静态服务器：只服务 PREFIX 下的文件，模拟 GitHub Pages 项目站点 ──────────
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
  if (!url.startsWith(PREFIX)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not under ' + PREFIX + ': ' + url);
  }
  const rel = url.slice(PREFIX.length) || 'index.html';
  let file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 ' + rel);
  }
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
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (base && fs.existsSync(base)) {
    for (const dir of fs.readdirSync(base)) {
      if (!dir.startsWith('chromium-')) continue;
      candidates.push(
        path.join(base, dir, 'chrome-win64', 'chrome.exe'),
        path.join(base, dir, 'chrome-win', 'chrome.exe'),
      );
    }
  }
  return candidates.find((p) => fs.existsSync(p));
}

async function main() {
  if (!fs.existsSync(ROOT)) {
    console.error('缺少 dist/，请先执行 npm run build');
    process.exit(1);
  }

  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

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

  const httpErrors = [];
  const pageErrors = [];
  page.on('response', (r) => {
    if (r.status() >= 400) httpErrors.push(`${r.status()} ${r.url()}`);
  });
  page.on('requestfailed', (r) => {
    httpErrors.push(`FAILED ${r.url()} ${r.failure()?.errorText ?? ''}`);
  });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    // 网络层失败已经由 response/requestfailed 记录，避免重复计数
    if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) {
      pageErrors.push('[console] ' + m.text());
    }
  });

  const entry = `http://127.0.0.1:${PORT}${PREFIX}?mock=1`;
  console.log(`入口：${entry}\n`);

  await page.goto(entry, { waitUntil: 'load' });
  await page.waitForSelector('#btn-start', { state: 'visible', timeout: 20000 });
  check(true, '子路径下页面加载成功', PREFIX);

  // 启动前的 preflight 不应把页面判成致命错误
  const overlayKind = await page.evaluate(() => {
    const ov = document.querySelector('#overlay');
    const btn = document.querySelector('#btn-start');
    return { overlayVisible: !!ov && !ov.classList.contains('hidden'), canStart: !!btn && btn.offsetParent !== null };
  });
  check(overlayKind.canStart, '启动按钮可用（未被子路径判为致命错误）');

  await page.click('#btn-start');
  await page.waitForFunction(() => window.__GUGU__?.started, null, { timeout: 45000 });
  check(true, '游戏启动完成');

  // 资源是否真的按子路径取到（显式再验证一遍，不只看有没有报错）
  const assets = await page.evaluate(async () => {
    const urls = ['targets/nigugu.mind', 'nigugu.glb', 'vendor/mindar-1.2.5/mindar-image.prod.js', 'favicon.svg'];
    const out = {};
    for (const u of urls) {
      try {
        const r = await fetch(new URL(u, document.baseURI));
        out[u] = r.status;
      } catch (e) {
        out[u] = 'ERR ' + e.message;
      }
    }
    return out;
  });
  const badAsset = Object.entries(assets).find(([, code]) => code !== 200);
  check(!badAsset, '全部静态资源在子路径下返回 200', badAsset ? `${badAsset[0]}=${badAsset[1]}` : JSON.stringify(assets));

  await page.waitForTimeout(1500);

  const state = await page.evaluate(() => {
    const s = window.__GUGU__;
    if (!s) return null;
    return {
      started: !!s.started,
      tracking: !!s.ar?.isTracking,
      hasCharacter: !!s.character,
      anims: s.controller?.animationNames ?? null,
      gait: s.gait ?? null,
      pos: s.movement ? [+s.movement.x.toFixed(3), +s.movement.z.toFixed(3)] : null,
      hasJoystick: !!s.joystick,
      bounds: s.bounds ?? null,
      baseURI: document.baseURI,
    };
  });
  check(!!state?.hasCharacter, 'GLB 角色已加载', state?.anims ? 'anims=' + state.anims.join('/') : '');
  check(Array.isArray(state?.anims) && state.anims.length === 5, '五段动画齐全', state?.anims?.length);
  check(state?.tracking === true, '（mock）已进入跟踪状态');
  check(!!state?.hasJoystick, '虚拟摇杆已创建');
  check(state?.baseURI?.includes(PREFIX), 'document.baseURI 指向子路径', state?.baseURI);

  // 摇杆推一下，确认在子路径下操控链路仍然通畅
  const before = state?.pos ?? [0, 0];
  const box = await page.locator('#joystick-zone').boundingBox();
  if (box) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 36, cy, { steps: 2 });
    await page.waitForTimeout(500);
    await page.mouse.up();
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => {
      const m = window.__GUGU__?.movement;
      return m ? [m.x, m.z] : null;
    });
    const moved = after ? Math.hypot(after[0] - before[0], after[1] - before[1]) : 0;
    check(moved > 0.02, '摇杆能驱动角色位移', `Δ=${moved.toFixed(3)}`);
  } else {
    check(false, '摇杆能驱动角色位移', '找不到 #joystick-zone');
  }

  check(httpErrors.length === 0, '没有 4xx/5xx 或失败请求', httpErrors.length ? httpErrors.slice(0, 5).join(' | ') : '');
  check(pageErrors.length === 0, '没有未捕获错误', pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '');

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
  console.error('校验脚本异常：', err);
  server.close();
  process.exit(1);
});
