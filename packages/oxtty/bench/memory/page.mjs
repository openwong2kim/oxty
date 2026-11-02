// The page bench.mjs opens: `setup(kind, n, cols, rows, lines)` builds `n` terminals of one kind ('oxtty' or
// 'xterm' with @xterm/addon-webgl), all in view, feeds each the same log output and waits a few frames.
import { Terminal as XtermTerminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { init, Terminal } from 'oxtty/xterm';

/** 1000 lines of coloured words (Hangul, box drawing, paths), deterministic for a seed. */
function chunk(cols, seed0) {
  const words = ['build', 'PASS', '한글', '터미널', 'error:', '│', '─┼─', 'src/render/webgl.rs', '0x1f600', 'ok'];
  let s = '';
  let seed = seed0;
  for (let line = 0; line < 1000; line++) {
    let width = 0;
    while (width < cols - 12) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const word = words[seed % words.length];
      s += `\x1b[${31 + (seed % 7)}m${word}\x1b[0m `;
      width += [...word].reduce((w, c) => w + (c.charCodeAt(0) > 0x1100 ? 2 : 1), 0) + 1;
    }
    s += '\r\n';
  }
  return s;
}

const frames = (n) =>
  new Promise((resolve) => {
    const next = () => (n-- > 0 ? requestAnimationFrame(next) : resolve());
    next();
  });

window.setup = async (kind, n, cols, rows, lines) => {
  const terms = [];
  for (let i = 0; i < n; i++) {
    const host = document.createElement('div');
    host.style.cssText = 'display:inline-block;vertical-align:top';
    document.body.appendChild(host);
    const options = { cols, rows, scrollback: 10000, fontFamily: 'Menlo, monospace', fontSize: 12 };
    const term = kind === 'xterm' ? new XtermTerminal(options) : new Terminal(options);
    term.open(host);
    if (kind === 'xterm') term.loadAddon(new WebglAddon());
    for (let k = 0; k < lines / 1000; k++) await new Promise((resolve) => term.write(chunk(cols, 7 + k), resolve));
    terms.push(term);
  }
  await frames(20);
  window.terms = terms;
  const gl = document.createElement('canvas').getContext('webgl2');
  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  return { gpuName: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '?', canvases: document.querySelectorAll('canvas').length };
};

await init();
window.ready = true;
