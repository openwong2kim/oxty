// run.mjs 결과 JSON을 시나리오·백엔드별 중앙값으로 요약한다. 사용: node bench/summ.mjs A.json [B.json ...]
import { readFileSync } from 'node:fs';
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
for (const f of process.argv.slice(2)) {
  const { samples } = JSON.parse(readFileSync(f, 'utf8'));
  console.log('==', f);
  const groups = new Map();
  for (const s of samples) { const k = `${s.workload}${s.align ? "A" : ""} ${s.panes}x${s.mib}/${s.chunkKiB}K ${s.backend}`; (groups.get(k) ?? groups.set(k, []).get(k)).push(s); }
  for (const [k, g] of groups) console.log(k.padEnd(26), 'elapsed', med(g.map(s => s.elapsedMs)).toFixed(0), 'task', med(g.map(s => s.taskMs)).toFixed(0), 'script', med(g.map(s => s.scriptMs)).toFixed(0), 'p95', med(g.map(s => s.frameP95)).toFixed(0), 'max', med(g.map(s => s.frameMax)).toFixed(0), 'rss', med(g.map(s => s.rendererRssMiB)).toFixed(0), '+gpu', med(g.map(s => s.gpuRssMiB)).toFixed(0), 'hash', [...new Set(g.map(s => s.hash))].join(','), 'err', g.reduce((a, s) => a + s.errors.length, 0));
}
