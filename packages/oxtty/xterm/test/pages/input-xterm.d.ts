// More of the real xterm.js build (declared in renderer-xterm.d.ts) for the input pages: only what they call.
declare module '@xterm/xterm/lib/xterm.mjs' {
  interface Terminal {
    readonly textarea: HTMLTextAreaElement | undefined;
    options: object;
    onData(listener: (data: string) => void): { dispose(): void };
    focus(): void;
    blur(): void;
    paste(data: string): void;
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  }
}
