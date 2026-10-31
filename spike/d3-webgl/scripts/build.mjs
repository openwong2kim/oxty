// 스파이크 빌드: 타입 검사 → esbuild 번들 → dist/에 index.html·oxty.wasm 복사
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(here, '..', '..');
const oxtyDist = join(repo, 'packages', 'oxty', 'dist');
const dist = join(here, 'dist');

// oxty wasm이 아직 없으면 저장소 빌드 스크립트로 만든다
if (!existsSync(join(oxtyDist, 'oxty.wasm'))) {
  execFileSync('bash', [join(repo, 'scripts', 'build-wasm.sh')], { stdio: 'inherit' });
}

execFileSync(join(here, 'node_modules', '.bin', 'tsc'), ['--noEmit', '-p', here], { stdio: 'inherit' });

mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [join(here, 'src', 'main.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: join(dist, 'main.js'),
  tsconfig: join(here, 'tsconfig.json'),
  sourcemap: true,
  logLevel: 'info'
});
copyFileSync(join(here, 'index.html'), join(dist, 'index.html'));
copyFileSync(join(oxtyDist, 'oxty.wasm'), join(dist, 'oxty.wasm'));
