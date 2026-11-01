// Bundles oxtty/xterm into dist/xterm.js (ESM) next to the engine. The engine import stays external as
// ./index.js, so dist/index.js keeps resolving oxtty.wasm from its own URL. Legal comments of the borrowed
// xterm.js code go to dist/xterm.js.LEGAL.txt; the full licence texts are in THIRD_PARTY_NOTICES.md.
import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const xterm = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(xterm, '..', 'dist');
const engine = join(xterm, '..', 'src', 'index.js');

await build({
  entryPoints: [join(xterm, 'src', 'index.ts')],
  outfile: join(dist, 'xterm.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  tsconfig: join(xterm, 'tsconfig.json'),
  legalComments: 'linked',
  logLevel: 'warning',
  plugins: [{
    name: 'external-engine',
    setup(b) {
      b.onResolve({ filter: /\/src\/index\.js$/ }, args =>
        join(args.resolveDir, args.path) === engine ? { path: './index.js', external: true } : undefined);
    },
  }],
});
await copyFile(join(xterm, 'xterm.d.ts'), join(dist, 'xterm.d.ts'));
