// api-checklist.json stays honest: supported members exist at runtime and in xterm.d.ts, the others are absent
// from xterm.d.ts so TypeScript users find out at compile time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { importTs } from './harness.mjs';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const MEMBER = /^(Terminal|options|buffer\.active|IBufferLine|IBufferCell|FitAddon)\.(\w+)$/;

test('every checklist entry has a known status and a reason', async () => {
  const { statuses, members } = JSON.parse(await read('./api-checklist.json'));
  for (const [name, { status, reason }] of Object.entries(members)) {
    assert.ok(status in statuses, `${name}: status "${status}"`);
    assert.ok(reason, `${name}: reason`);
  }
});

test('supported members exist and are typed; the others are not typed', async () => {
  const { members } = JSON.parse(await read('./api-checklist.json'));
  const types = await read('../xterm.d.ts');
  assert.doesNotMatch(types, /@xterm\/xterm/);
  const m = await importTs('test/pages/terminal-node.ts');
  await m.init(await readFile(new URL('../../dist/oxtty.wasm', import.meta.url)));
  const t = new m.Terminal();
  t.write('x');
  await new Promise(resolve => t.write('', resolve));
  const line = t.buffer.active.getLine(0);
  const owners = { Terminal: t, options: t.options, 'buffer.active': t.buffer.active, IBufferLine: line, IBufferCell: line.getCell(0), FitAddon: new m.FitAddon() };
  for (const [name, { status }] of Object.entries(members)) {
    const match = MEMBER.exec(name);
    if (!match || match[2] === 'constructor') continue;
    const [, owner, member] = match;
    const typed = new RegExp(`\\n\\s+(readonly )?${member}\\??[(:]`).test(types);
    if (status === 'supported') {
      assert.ok(member in owners[owner], `${name} at runtime`);
      assert.ok(typed, `${name} in xterm.d.ts`);
    } else {
      assert.ok(!typed, `${name} is ${status} but typed in xterm.d.ts`);
    }
  }
  t.dispose();
});
