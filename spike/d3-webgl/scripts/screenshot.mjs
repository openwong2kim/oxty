// dist/를 로컬 정적 서버로 띄우고 시스템 Chrome으로 열어 screenshot.png를 저장한다.
// 콘솔 에러·페이지 예외가 하나라도 있으면 exit 1.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(here, 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.map': 'application/json' };

const server = createServer(async (req, res) => {
  const path = normalize(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  try {
    const body = await readFile(join(dist, path));
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/index.html`;

const errors = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 2 });
  page.on('console', m => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    else console.log(`[page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => window.__oxty?.ready === true, null, { timeout: 15000 });
  const state = await page.evaluate(() => window.__oxty);
  if (state.error) errors.push(`main: ${state.error}`);
  console.log('cursor', JSON.stringify(state.cursor));
  for (const row of state.rows ?? []) console.log('|' + row);
  await page.waitForTimeout(300);
  await page.locator('#terminal').screenshot({ path: join(here, 'screenshot.png') });
} finally {
  await browser.close();
  server.close();
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('screenshot.png 저장, 콘솔 에러 0');
