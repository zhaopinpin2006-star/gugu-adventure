import { chromium } from 'playwright';
import { createServer } from 'vite';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
const server = await createServer({ server: { host:'127.0.0.1',port:0 },logLevel:'error' });
await server.listen();
const local = ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await chromium.launch({executablePath:process.env.BROWSER_PATH || local, args:['--enable-unsafe-swiftshader']});
try {
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls.local[0]+'targets/nigugu.jpg');
  const result = await page.evaluate(async () => {
    const { Compiler } = await import('/vendor/mindar-1.2.5/mindar-image.prod.js');
    const img = new Image(); img.src='/targets/nigugu.jpg'; await img.decode();
    const compiler = new Compiler(); await compiler.compileImageTargets([img],()=>{});
    const out = Array.from(new Uint8Array(await compiler.exportData()));
    return { out, width:img.naturalWidth,height:img.naturalHeight };
  });
  await writeFile('public/targets/nigugu.mind',Buffer.from(result.out));
  console.log('Compiled IP target', result.width,result.height,result.out.length,'bytes');
} finally { await browser.close(); await server.close(); }
