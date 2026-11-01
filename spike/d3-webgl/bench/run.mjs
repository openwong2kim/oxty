// Runs the renderer bench: esbuild bundle → COOP/COEP static server → fresh Chrome per sample → collect time and memory.
// Usage: node bench/run.mjs OUT.json [--quick | --align | --diag]
import { createServer } from 'node:http';
import { readFile, copyFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
const here = dirname(fileURLToPath(import.meta.url));
const spike = join(here, '..');
const nm = join(here, 'node_modules');
const out = process.argv[2], quick = process.argv.includes('--quick');
if (!out) throw new Error('Usage: node run.mjs OUT.json [--quick]');
const dist = join(here, 'dist');
await build({ entryPoints: [join(here, 'main.ts')], bundle: true, format: 'esm', target: 'es2022', outfile: join(dist, 'main.js'),
  tsconfig: join(spike, 'tsconfig.json'), minify: true, logLevel: 'warning' });
await copyFile(join(here, 'index.html'), join(dist, 'index.html'));
await copyFile(process.env.WASM ?? join(spike, '../../packages/oxtty/dist/oxtty.wasm'), join(dist, 'oxtty.wasm'));
await copyFile(join(nm, '@xterm/xterm/css/xterm.css'), join(dist, 'xterm.css'));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css' };
// measureUserAgentSpecificMemory works only on cross-origin isolated pages
const server = createServer(async (rq, rs) => {
  const p = normalize(new URL(rq.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  try {
    const b = await readFile(join(dist, p));
    rs.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream',
      'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/index.html`;

async function sample(backend, workload, panes, mib, chunk, align = 0) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--enable-blink-features=ForceEagerMeasureMemory', '--enable-precise-memory-info', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1800, height: 2700 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(`${base}?backend=${backend}&workload=${workload}&panes=${panes}&mib=${mib}&chunk=${chunk}&align=${align}&nodraw=${process.env.NODRAW ?? 0}`);
    await page.waitForFunction(() => window.__bench, null, { timeout: 300000 });
    const r = await page.evaluate(() => window.__bench);
    if (r.error) throw new Error(r.error);
    // CPU time (seconds) used by the renderer main thread from page load to the end
    const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const m = await page.evaluate(async () => performance.measureUserAgentSpecificMemory());
    const uasm = m.bytes;
    // Memory broken down by kind (JavaScript/DOM/Canvas…)
    const kinds = {};
    for (const e of m.breakdown) for (const t of e.types.length ? e.types : ['other']) kinds[t] = (kinds[t] ?? 0) + e.bytes / 1048576 / (e.types.length || 1);
    // Actual physical memory: RSS (MiB) of this browser's renderer and GPU processes. Untouched wasm pages do not show up here
    const bcdp = await browser.newBrowserCDPSession();
    const { processInfo } = await bcdp.send('SystemInfo.getProcessInfo');
    const procRss = { renderer: 0, gpu: 0 };
    for (const p of processInfo) {
      const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(p.id)], { encoding: 'utf8' }).trim() || 0);
      if (p.type === 'renderer') procRss.renderer = Math.max(procRss.renderer, kb / 1024);
      if (p.type === 'GPU') procRss.gpu += kb / 1024;
    }
    return { ...r, rendererRssMiB: procRss.renderer, gpuRssMiB: procRss.gpu, taskMs: metrics.TaskDuration * 1000, scriptMs: metrics.ScriptDuration * 1000, heapUsedMiB: heap.usedSize / 1048576, backingStoreMiB: (heap.backingStorageSize ?? 0) / 1048576, uasmMiB: uasm / 1048576, kinds, errors };
  } finally { await browser.close(); }
}

// [workload, panes, MiB per pane, chunk KiB per pane per frame, repeats]
const plan = process.env.PLAN ? JSON.parse(process.env.PLAN) : process.argv.includes('--align') ? [['tui', 8, 2, 32, 3, 1], ['tui', 8, 2, 256, 3, 1]] : process.argv.includes('--diag') ? [['tui', 8, 2, 32, 1], ['log', 8, 2, 32, 1]] : quick ? [['log', 2, 1, 32, 1]] : [['log', 8, 2, 32, 3], ['tui', 8, 2, 32, 3], ['log', 8, 2, 256, 3], ['tui', 8, 2, 256, 3], ['log', 1, 8, 256, 3]];
const samples = [];
try {
  for (const [workload, panes, mib, chunk, repeats, align] of plan) for (let rep = 0; rep < repeats; rep++)
    for (const backend of rep % 2 ? ['oxtty', 'xterm'] : ['xterm', 'oxtty']) {
      const s = await sample(backend, workload, panes, mib, chunk, align);
      samples.push({ rep, ...s });
      console.error(`${backend} ${workload} ${panes}x${mib}MiB/${chunk}K ${s.elapsedMs.toFixed(0)}ms task ${s.taskMs.toFixed(0)} script ${s.scriptMs.toFixed(0)} p50 ${s.frameP50.toFixed(1)} p95 ${s.frameP95.toFixed(1)} max ${s.frameMax.toFixed(0)} long ${s.longTasks}/${s.longTaskMs.toFixed(0)}ms heap ${s.heapUsedMiB.toFixed(1)} store ${s.backingStoreMiB.toFixed(1)} uasm ${s.uasmMiB.toFixed(1)} rss ${s.rendererRssMiB.toFixed(0)}+gpu ${s.gpuRssMiB.toFixed(0)}MiB hash ${s.hash} err ${s.errors.length}`);
    }
} finally { server.close(); }
await writeFile(out, JSON.stringify({ at: new Date().toISOString(), gpu: samples[0]?.gpu, samples }, null, 1), { flag: 'wx' });
