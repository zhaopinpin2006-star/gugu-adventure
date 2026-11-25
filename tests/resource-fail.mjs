/**
 * 资源加载失败 / 摄像头失败 回归测试。
 *
 * 覆盖用户需求里的"资源加载失败、摄像头权限"：
 *   1. 识别目标 .mind 404 → 出现可读的错误遮罩，而不是无限转圈。
 *   2. GLB 模型 404 → 同样给出错误遮罩 + 重试入口，不留半成品角色。
 *   3. 摄像头权限被拒绝（NotAllowedError）→ 提示要讲清楚"去哪开权限"。
 *   4. 以上情况都不能有**未捕获异常**炸到用户面前。
 *
 * 注意：这里必须走真实的 MindARLite 路径（不带 ?mock），
 * 因为 mock 模式压根不加载 .mind 也不开摄像头，测不出失败分支。
 *
 * 用法：node tests/resource-fail.mjs（需先 npm run build）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { fakeCameraScript } from './fake-camera.mjs';

const PORT = 4395;
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

/** blocked: 请求路径片段 → 直接 404，用来模拟资源缺失。 */
let blocked = [];

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (blocked.some((b) => url.includes(b))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('blocked: ' + url);
  }
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

const readUi = () => {
  const overlay = document.querySelector('#overlay');
  const title = document.querySelector('#overlay-title');
  const desc = document.querySelector('#overlay-desc');
  const btn = document.querySelector('#btn-start');
  const status = document.querySelector('#status-text');
  return {
    overlayVisible: !!overlay && !overlay.classList.contains('hidden'),
    title: title?.textContent?.trim() || '',
    desc: desc?.textContent?.trim() || '',
    actionText: btn?.textContent?.trim() || '',
    status: status?.textContent?.trim() || '',
    started: !!window.__GUGU__?.started,
    hasCharacter: !!window.__GUGU__?.character,
    arKind: window.__GUGU__?.ar?.kind || '',
  };
};

async function runScenario(browser, { query = '', initScripts = [], wait = 9000, expect }) {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  // uncaught：真正没被接住的异常；consoleError：代码自己 console.error 的诊断日志
  const uncaught = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => uncaught.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // 网络层失败由 404 场景自己制造，这里只关心脚本异常
    if (/Failed to load resource/i.test(text)) return;
    consoleErrors.push(text.split('\n')[0]);
  });

  for (const script of initScripts) await page.addInitScript(script);

  await page.goto(`http://127.0.0.1:${PORT}/${query}`, { waitUntil: 'load' });
  await page.waitForSelector('#btn-start', { state: 'visible', timeout: 20000 });
  await page.click('#btn-start');
  await page.waitForTimeout(wait);

  const ui = await page.evaluate(readUi);
  expect(ui, uncaught, consoleErrors);
  await page.close();
  return ui;
}

async function main() {
  if (!fs.existsSync(ROOT)) {
    console.error('缺少 dist/，请先执行 npm run build');
    process.exit(1);
  }
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: [
      '--enable-unsafe-swiftshader',
      '--use-gl=swiftshader',
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const fakeCam = fakeCameraScript({ tilted: true });

  // ── 场景 1：识别目标 .mind 404（真路径：假摄像头 + MindARLite）────────────
  blocked = ['nigugu.mind'];
  await runScenario(browser, {
    query: '',
    initScripts: [fakeCam],
    wait: 12000,
    expect: (ui, uncaught) => {
      check(ui.arKind === 'mindar', '识别目标缺失：走的是真实 AR 路径（非 mock）', ui.arKind);
      check(ui.overlayVisible, '识别目标缺失：出现错误遮罩', ui.title);
      check(
        /镜头|加载|失败|海报|目标|引擎/.test(ui.title + ui.desc + ui.status),
        '识别目标缺失：给出了可读原因',
        `${ui.status} / ${ui.desc.slice(0, 50)}`
      );
      check(!ui.hasCharacter, '识别目标缺失：没有加载角色（失败即止）');
      check(uncaught.length === 0, '识别目标缺失：没有未捕获异常', uncaught.slice(0, 2).join(' | '));
    },
  });

  // ── 场景 2：GLB 404（mock 路径，先确保跟踪成功再让模型失败）────────────────
  blocked = ['nigugu.glb'];
  await runScenario(browser, {
    query: '?mock=1',
    wait: 9000,
    expect: (ui, uncaught, consoleErrors) => {
      check(ui.overlayVisible, 'GLB 缺失：出现错误遮罩', ui.title);
      check(/泥咕咕|模型|加载/.test(ui.title + ui.desc), 'GLB 缺失：文案讲清了是模型加载失败', `${ui.title} / ${ui.desc.slice(0, 40)}`);
      check(ui.actionText.length > 0, 'GLB 缺失：遮罩带重试按钮', ui.actionText);
      check(!ui.hasCharacter, 'GLB 缺失：没有半成品角色残留');
      check(uncaught.length === 0, 'GLB 缺失：没有未捕获异常', uncaught.slice(0, 2).join(' | '));
      check(
        consoleErrors.every((t) => t.includes('[gugu]')),
        'GLB 缺失：控制台只有自家诊断日志',
        consoleErrors.slice(0, 2).join(' | ')
      );
    },
  });

  // ── 场景 3：摄像头权限被拒（真路径，getUserMedia 抛 NotAllowedError）───────
  blocked = [];
  await runScenario(browser, {
    query: '',
    wait: 7000,
    initScripts: [
      () => {
        // 仅覆盖 getUserMedia 的权限结果；其余 mediaDevices 能力保持原样
        const md = navigator.mediaDevices;
        if (!md) return;
        md.getUserMedia = () => {
          const err = new Error('Permission denied');
          err.name = 'NotAllowedError';
          return Promise.reject(err);
        };
      },
    ],
    expect: (ui, uncaught) => {
      check(ui.overlayVisible, '摄像头被拒：出现错误遮罩', ui.title);
      check(
        /权限|允许|摄像头/.test(ui.title + ui.desc),
        '摄像头被拒：提示讲清了是权限问题',
        `${ui.title} / ${ui.desc.slice(0, 60)}`
      );
      check(ui.actionText.length > 0, '摄像头被拒：遮罩带重试按钮', ui.actionText);
      check(uncaught.length === 0, '摄像头被拒：没有未捕获异常', uncaught.slice(0, 2).join(' | '));
    },
  });

  blocked = [];
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
  console.error('资源失败测试异常：', err);
  server.close();
  process.exit(1);
});
