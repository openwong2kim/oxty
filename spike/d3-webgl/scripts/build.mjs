// Spike build: type check → esbuild bundle → copy index.html and oxtty.wasm into dist/
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(here, '..', '..');
const oxttyDist = join(repo, 'packages', 'oxtty', 'dist');
const dist = join(here, 'dist');

// If the oxtty wasm does not exist yet, build it with the repository build script
if (!existsSync(join(oxttyDist, 'oxtty.wasm'))) {
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
copyFileSync(join(oxttyDist, 'oxtty.wasm'), join(dist, 'oxtty.wasm'));
