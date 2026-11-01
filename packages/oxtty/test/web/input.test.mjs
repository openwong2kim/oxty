// Input beside key encoding, each compared with a real xterm.js 6.1 on the same page: the textarea, paste, focus
// reports, the custom key handler, disableStdin, scrollOnUserInput, onUserInput and oxtty's kitty keyboard API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPage } from './harness.mjs';

const setup = (page, options = {}) => page.evaluate((o) => window.api.setup(o), options);
const write = (page, data) => page.evaluate((d) => window.api.write(d), data);
const take = (page) => page.evaluate(() => window.api.take());
const both = async (page, fn) => {
  for (const name of ['ox', 'xt']) await fn(name);
  return take(page);
};
const press = (page, key) => async (name) => {
  await page.evaluate((n) => window.api.focus(n), name);
  await page.keyboard.press(key);
};

test('input matches xterm.js', async (t) => {
  await withPage('parity.mjs', async (page) => {
    await page.waitForFunction(() => window.ready);

    await t.test('the textarea is built like xterm.js and takes focus', async () => {
      await setup(page);
      const shape = await page.evaluate(() => ['ox', 'xt'].map((name) => {
        const terminal = window.api.terminal(name);
        const textarea = terminal.textarea;
        const attributes = Object.fromEntries([...textarea.attributes].filter((a) => a.name !== 'style').map((a) => [a.name, a.value]));
        const helpers = textarea.parentElement;
        textarea.focus();
        const focused = document.activeElement === textarea && terminal.element.classList.contains('focus');
        terminal.blur();
        const blurred = document.activeElement !== textarea && !terminal.element.classList.contains('focus');
        terminal.focus();
        const refocused = document.activeElement === textarea;
        terminal.blur();
        return {
          attributes, className: textarea.className, helpers: helpers.className, inScreen: helpers.parentElement.classList.contains('xterm-screen'),
          compositionView: !!helpers.querySelector(':scope > .composition-view'), focused, blurred, refocused,
        };
      }));
      assert.deepEqual(shape[0], shape[1]);
      assert.equal(shape[0].className, 'xterm-helper-textarea');
      assert.ok(shape[0].compositionView && shape[0].focused && shape[0].blurred && shape[0].refocused);
    });

    await t.test('the textarea follows the cursor cell', { todo: 'Terminal.textarea, Terminal.dimensions' }, async () => {
      await setup(page);
      await write(page, 'abc\r\n de');
      const placed = await page.evaluate(() => {
        const t = window.api.terminal('ox');
        const { width, height } = t.dimensions.css.cell;
        return { left: t.textarea.style.left, top: t.textarea.style.top, width, height };
      });
      assert.equal(placed.left, `${3 * placed.width}px`);
      assert.equal(placed.top, `${placed.height}px`);
    });

    await t.test('paste() and the paste event send what xterm.js sends', async () => {
      const texts = ['plain', 'a\r\nb\nc\rd', 'x\x1b[201~y'];
      for (const bracketed of [false, true]) {
        await setup(page);
        if (bracketed) await write(page, '\x1b[?2004h');
        for (const text of texts) {
          const api = await both(page, (name) => page.evaluate(([n, s]) => window.api.paste(n, s), [name, text]));
          const event = await both(page, (name) => page.evaluate(([n, s]) => {
            const clipboardData = new DataTransfer();
            clipboardData.setData('text/plain', s);
            window.api.terminal(n).textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
          }, [name, text]));
          assert.deepEqual(api.ox, api.xt, `paste(${JSON.stringify(text)}), bracketed ${bracketed}`);
          assert.deepEqual(event.ox, event.xt, `paste event ${JSON.stringify(text)}, bracketed ${bracketed}`);
          assert.deepEqual(event.ox, api.ox);
        }
      }
      // The known bytes: newlines become CR; brackets wrap the paste and an ESC inside cannot end it.
      const shown = await both(page, (name) => page.evaluate((n) => window.api.paste(n, 'a\r\nb\x1b'), name));
      assert.deepEqual(shown.ox, ['\x1b[200~a\rb␛\x1b[201~']);
    });

    await t.test('focus reports follow the focus events mode', async () => {
      for (const mode of ['', '\x1b[?1004h']) {
        await setup(page);
        await write(page, mode);
        const sent = await both(page, async (name) => {
          await page.evaluate((n) => window.api.focus(n), name);
          await page.evaluate((n) => window.api.blur(n), name);
        });
        assert.deepEqual(sent.ox, sent.xt);
        // Turning the mode on reports the current focus (out) first.
        assert.deepEqual(sent.ox, mode ? ['\x1b[O', '\x1b[I', '\x1b[O'] : []);
      }
    });

    await t.test('a custom key handler returning false stops the key', async () => {
      await setup(page);
      await page.evaluate(() => {
        window.seen = { ox: [], xt: [] };
        for (const name of ['ox', 'xt']) window.api.terminal(name).attachCustomKeyEventHandler((e) => {
          window.seen[name].push(`${e.type}:${e.key}`);
          return e.key !== 'a';
        });
      });
      const sent = await both(page, async (name) => {
        await press(page, 'KeyA')(name);
        await press(page, 'KeyB')(name);
      });
      assert.deepEqual(sent.ox, sent.xt);
      assert.deepEqual(sent.ox, ['b']);
      const seen = await page.evaluate(() => window.seen);
      assert.deepEqual(seen.ox, seen.xt);
      // Stopped, the keydown is not cancelled, so the browser still fires keypress for it; b is sent from keydown.
      assert.deepEqual(seen.ox, ['keydown:a', 'keypress:a', 'keyup:a', 'keydown:b', 'keyup:b']);
    });

    await t.test('disableStdin drops keys, pastes and replies', async () => {
      await setup(page, { disableStdin: true });
      const sent = await both(page, async (name) => {
        await press(page, 'KeyA')(name);
        await page.evaluate((n) => window.api.paste(n, 'p'), name);
      });
      await write(page, '\x1b[6n');
      const replies = await take(page);
      assert.deepEqual(sent, { ox: [], xt: [] });
      assert.deepEqual(replies, { ox: [], xt: [] });
      assert.equal(await page.evaluate(() => window.api.terminal('ox').textarea.readOnly), true);
      const enabled = await both(page, async (name) => {
        await page.evaluate((n) => window.api.setOption(n, 'disableStdin', false), name);
        await press(page, 'KeyA')(name);
      });
      assert.deepEqual(enabled, { ox: ['a'], xt: ['a'] });
      assert.equal(await page.evaluate(() => window.api.terminal('ox').textarea.readOnly), false);
    });

    await t.test('typing scrolls to the bottom unless scrollOnUserInput is false', async () => {
      for (const scrollOnUserInput of [true, false]) {
        await setup(page, { scrollOnUserInput });
        await write(page, '\r\n'.repeat(20));
        await page.evaluate(() => {
          for (const name of ['ox', 'xt']) window.api.terminal(name).scrollLines(-5);
        });
        await page.evaluate(() => window.api.frame());
        await both(page, press(page, 'KeyA'));
        const atBottom = await page.evaluate(() => ['ox', 'xt'].map((name) => {
          const { viewportY, baseY } = window.api.terminal(name).buffer.active;
          return viewportY === baseY;
        }));
        assert.deepEqual(atBottom, [scrollOnUserInput, scrollOnUserInput], `scrollOnUserInput ${scrollOnUserInput}`);
      }
    });

    await t.test('onUserInput fires before onData for input, never for replies', async () => {
      await setup(page);
      const order = await page.evaluate(async () => {
        const t = window.api.terminal('ox');
        const order = [];
        t.onUserInput(() => order.push('user'));
        t.onData((d) => order.push(d));
        await window.api.write('\x1b[6n');
        window.api.paste('ox', 'p');
        return order;
      });
      await press(page, 'KeyA')('ox');
      const typed = await page.evaluate(() => window.api.take().ox);
      assert.deepEqual(order, ['\x1b[1;1R', 'user', 'p']);
      assert.deepEqual(typed, ['\x1b[1;1R', 'p', 'a']);
    });

    await t.test('kitty keyboard: vtExtensions, flags and reset (oxtty API)', async () => {
      const escape = async () => {
        await press(page, 'Escape')('ox');
        return (await take(page)).ox.join('');
      };
      await setup(page);
      await write(page, '\x1b[>1u');
      assert.equal(await page.evaluate(() => window.api.terminal('ox').kittyKeyboardFlags), 0, 'pushes are ignored with the extension off');
      assert.equal(await escape(), '\x1b');

      await setup(page, { vtExtensions: { kittyKeyboard: true } });
      await write(page, '\x1b[>1u');
      assert.equal(await page.evaluate(() => window.api.terminal('ox').kittyKeyboardFlags), 1);
      assert.equal(await escape(), '\x1b[27u');
      assert.equal(await page.evaluate(() => {
        const t = window.api.terminal('ox');
        t.resetKittyKeyboard();
        return t.kittyKeyboardFlags;
      }), 0, 'reset applies at once');
      assert.equal(await escape(), '\x1b');

      // Turning the extension off drops what the program pushed.
      await write(page, '\x1b[>1u');
      await page.evaluate(() => window.api.setOption('ox', 'vtExtensions', { kittyKeyboard: false }));
      await page.evaluate(() => window.api.frame());
      assert.equal(await page.evaluate(() => window.api.terminal('ox').kittyKeyboardFlags), 0);
      assert.equal(await escape(), '\x1b');
    });
  });
});
