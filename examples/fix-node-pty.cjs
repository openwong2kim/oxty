// node-pty 1.1.0 ships its macOS spawn-helper without the executable bit, so every spawn fails with
// "posix_spawnp failed" (microsoft/node-pty#850). Restore it after install.
const { chmodSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const prebuilds = join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds');
for (const dir of readdirSync(prebuilds, { withFileTypes: true })) {
  try {
    if (dir.isDirectory()) chmodSync(join(prebuilds, dir.name, 'spawn-helper'), 0o755);
  } catch {}
}
