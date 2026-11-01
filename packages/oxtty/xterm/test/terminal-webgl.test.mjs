// The Terminal facade with the real WebGL renderer in headless Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPage } from './harness.mjs';

test('a real Terminal draws coloured Hangul and answers a cursor position request', async () => {
  const facts = await withPage('test/pages/terminal-webgl.ts', async page => {
    await page.waitForFunction(() => window.result, null, { timeout: 20000 });
    return page.evaluate(() => window.result);
  });
  assert.equal(facts.error, undefined, facts.error);
  assert.deepEqual(facts.data, ['\x1b[1;8R']);
  assert.equal(facts.line, '한글 ok');
  assert.ok(facts.red > 20, `red glyph pixels: ${facts.red}`);
  assert.ok(facts.lit > facts.red, `lit pixels: ${facts.lit}`);
});
