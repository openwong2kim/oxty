// Page for the input tests: an oxtty Terminal and a real xterm.js 6.1 Terminal side by side, with the same options.
// The test drives both with the same browser input (CDP key events, IME, paste) and compares their onData bytes.
import { Terminal as XTerm } from '@xterm/xterm/lib/xterm.mjs';
import { init, Terminal } from '../../src/index';

type Name = 'ox' | 'xt';
/**
 * One browser event of an IME trace, replayed on a terminal's textarea. `update` and `end` also edit the textarea
 * the way the browser does for the composition, `insertText` types outside of it; `tick` yields one macrotask
 * (the browser delivers each native event as its own task, so timers armed by a handler can run in between).
 */
type Step =
  | { type: 'keydown' | 'keyup' | 'keypress'; init: KeyboardEventInit & { keyCode?: number; charCode?: number } }
  | { type: 'start' }
  | { type: 'update' | 'end' | 'insertText'; data: string }
  | { type: 'tick' };
interface Pair {
  ox: Terminal;
  xt: XTerm;
  data: Record<Name, string[]>;
}

let pair: Pair | undefined;
const frame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

const api = {
  /** Fresh terminals in fresh containers; `options` go to both. */
  async setup(options: Record<string, unknown> = {}): Promise<void> {
    if (pair) {
      pair.ox.dispose();
      pair.xt.dispose();
    }
    document.body.replaceChildren();
    const make = (): HTMLElement => document.body.appendChild(document.createElement('div'));
    const common = { cols: 40, rows: 6, fontFamily: 'Menlo, monospace', fontSize: 14, ...options };
    const ox = new Terminal(common);
    const xt = new XTerm(common);
    ox.open(make());
    xt.open(make());
    const data: Pair['data'] = { ox: [], xt: [] };
    ox.onData(d => data.ox.push(d));
    xt.onData(d => data.xt.push(d));
    pair = { ox, xt, data };
    await frame();
  },
  /** Writes to both and waits until oxtty has drawn it: input reads modes from the last frame (PRD D7). */
  async write(data: string): Promise<void> {
    const { ox, xt } = pair!;
    await Promise.all([new Promise<void>(r => ox.write(data, r)), new Promise<void>(r => xt.write(data, r))]);
    await frame();
  },
  focus(name: Name): void {
    pair![name].focus();
  },
  blur(name: Name): void {
    pair![name].blur();
  },
  paste(name: Name, text: string): void {
    pair![name].paste(text);
  },
  setOption(name: Name, key: string, value: unknown): void {
    (pair![name].options as Record<string, unknown>)[key] = value;
  },
  /** Replays `trace` on the textarea of `name`, then waits for the timers the composition armed. */
  async replay(name: Name, trace: Step[]): Promise<void> {
    const textarea = pair![name].textarea!;
    const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
    let start = 0;
    let end = 0;
    const input = (inputType: string, data: string, isComposing: boolean): void => {
      textarea.dispatchEvent(new InputEvent('input', { inputType, data, isComposing, composed: true, bubbles: true }));
    };
    for (const step of trace) {
      switch (step.type) {
        case 'tick':
          await tick();
          break;
        case 'keydown':
        case 'keyup':
        case 'keypress':
          textarea.dispatchEvent(new KeyboardEvent(step.type, { bubbles: true, cancelable: true, composed: true, ...step.init }));
          break;
        case 'start':
          start = end = textarea.selectionStart;
          textarea.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
          break;
        case 'update':
          textarea.value = textarea.value.slice(0, start) + step.data + textarea.value.slice(end);
          end = start + step.data.length;
          textarea.selectionStart = textarea.selectionEnd = end;
          textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: step.data, bubbles: true }));
          input('insertCompositionText', step.data, true);
          break;
        case 'end':
          textarea.dispatchEvent(new CompositionEvent('compositionend', { data: step.data, bubbles: true }));
          break;
        case 'insertText': {
          const at = textarea.selectionStart;
          textarea.value = textarea.value.slice(0, at) + step.data + textarea.value.slice(textarea.selectionEnd);
          textarea.selectionStart = textarea.selectionEnd = at + step.data.length;
          input('insertText', step.data, false);
          break;
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  },
  /** Data `name` sent since the last `take`, without taking it. */
  peek(name: Name): string[] {
    return [...pair!.data[name]];
  },
  /** Data each terminal sent since the last call. */
  take(): Record<Name, string[]> {
    const { data } = pair!;
    return { ox: data.ox.splice(0), xt: data.xt.splice(0) };
  },
  terminal(name: Name): Terminal | XTerm {
    return pair![name];
  },
  frame,
};

const w = window as unknown as { api: typeof api; ready?: boolean | string };
w.api = api;
init().then(() => { w.ready = true; }, err => { w.ready = String(err); });
