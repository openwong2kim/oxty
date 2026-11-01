// Types for the real xterm.js builds that renderer-hangul.ts imports by file path (the bare names resolve to the oxtty stubs).
// Only what the page calls.
declare module '@xterm/xterm/lib/xterm.mjs' {
  export class Terminal {
    constructor(options: object);
    readonly unicode: { activeVersion: string };
    open(parent: HTMLElement): void;
    loadAddon(addon: object): void;
    write(data: string, callback: () => void): void;
    dispose(): void;
  }
}

declare module '@xterm/addon-webgl/lib/addon-webgl.mjs' {
  export class WebglAddon {
    constructor(options?: { preserveDrawingBuffer?: boolean });
  }
}

declare module '@xterm/addon-unicode11/lib/addon-unicode11.mjs' {
  export class Unicode11Addon {}
}
