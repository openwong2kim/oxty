// Test helpers for oxtty/xterm. `importTs` bundles a TypeScript entry for Node; `withPage` bundles one for the
// browser and runs it in headless system Chrome (SwiftShader WebGL2) next to oxtty.wasm.
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const xterm = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsconfig = join(xterm, 'tsconfig.json');
const wasm = join(xterm, '..', 'dist', 'oxtty.wasm');

/** Bundles `entry` (relative to packages/oxtty/xterm) and imports it in Node. */
export async function importTs(entry) {
  const dir = await mkdtemp(join(tmpdir(), 'oxtty-xterm-'));
  const outfile = join(dir, 'entry.mjs');
  await build({ entryPoints: [join(xterm, entry)], bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile, tsconfig, logLevel: 'warning' });
  return import(pathToFileURL(outfile).href);
}

/**
 * Bundles `entry` for the browser, opens it and calls `fn(page)`. The page fails the call on any console error
 * or page exception. Options: `viewport`, `deviceScaleFactor`.
 */
export async function withPage(entry, fn, { viewport = { width: 1000, height: 700 }, deviceScaleFactor = 1 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'oxtty-xterm-page-'));
  await build({ entryPoints: [join(xterm, entry)], bundle: true, format: 'esm', target: 'es2022', outfile: join(dir, 'main.js'), tsconfig, sourcemap: 'inline', logLevel: 'warning' });
  await writeFile(join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><body style="margin:0;background:#111"><div id="terminal"></div><script type="module" src="./main.js"></script>');
  await copyFile(wasm, join(dir, 'oxtty.wasm'));
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
  const server = createServer(async (req, res) => {
    const path = normalize(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    try {
      const body = await readFile(join(dir, path));
      res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport, deviceScaleFactor });
    page.on('console', m => m.type() === 'error' && errors.push(`console: ${m.text()}`));
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    const result = await fn(page);
    if (errors.length) throw new Error(errors.join('\n'));
    return result;
  } finally {
    await browser.close();
    server.close();
  }
}
