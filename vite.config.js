import { defineConfig } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 开发服务器 HTTPS：手机（iOS Safari / Android Chrome）只有在安全上下文
 * （https:// 或 localhost）里才允许 getUserMedia。
 *
 * 先跑一次 `python scripts/gen-cert.py` 生成 certs/dev-{cert,key}.pem，
 * dev server 会自动启用 HTTPS；证书不存在时退回 HTTP（桌面 localhost 仍可调试）。
 */
function httpsOptions() {
  const certPath = resolve(process.cwd(), 'certs/dev-cert.pem');
  const keyPath = resolve(process.cwd(), 'certs/dev-key.pem');
  if (!existsSync(certPath) || !existsSync(keyPath)) return undefined;
  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath)
  };
}

export default defineConfig(({ command }) => {
  const https = command === 'serve' ? httpsOptions() : undefined;
  return {
    base: './',
    build: {
      target: 'es2020',
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 2400
    },
    server: {
      host: '0.0.0.0',
      https,
      port: 5173
    },
    preview: {
      host: '0.0.0.0',
      https,
      port: 4173
    }
  };
});
