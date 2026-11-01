// Runs the incremental render pixel check (check.ts) in headless Chrome. Exit 1 on any difference or error.
// Usage: node bench/check.mjs
import { createServer } from 'node:http';
import { readFile, copyFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
const here = dirname(fileURLToPath(import.meta.url));
const spike = join(here, '..');
const dist = join(here, 'dist', 'check');
await build({ entryPoints: [join(here, 'check.ts')], bundle: true, format: 'esm', target: 'es2022', outfile: join(dist, 'main.js'), tsconfig: join(spike, 'tsconfig.json'), logLevel: 'warning' });
await writeFile(join(dist, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><body style="margin:0;background:#111"><script type="module" src="./main.js"></script>');
await copyFile(join(spike, '../../packages/oxtty/dist/oxtty.wasm'), join(dist, 'oxtty.wasm'));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer(async (rq, rs) => { const p = normalize(new URL(rq.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  try { const b = await readFile(join(dist, p)); rs.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' }); rs.end(b); } catch { rs.writeHead(404).end(); } });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1400 } });
const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
await page.waitForFunction(() => window.__check, null, { timeout: 120000 });
const r = await page.evaluate(() => window.__check);
await browser.close(); server.close();
console.log(JSON.stringify(r), errors);
const { sentinelOneChar, error, ...chunks } = r;
if (error || errors.length || !(sentinelOneChar > 0) || Object.values(chunks).some(d => d !== 0)) process.exit(1);
