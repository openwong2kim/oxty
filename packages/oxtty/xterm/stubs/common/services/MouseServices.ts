// [oxtty stub] Replaces xterm.js 6.1 src/common/services/Services.ts (396 lines) for the copied mouse parts.
// Interfaces keeping only the members MouseService, MouseStateService and MoveToCell call. Implemented by src/mouse/MouseController.ts.
// A separate module from Services.ts, whose services the renderer parts use with other members.
import type { CoreMouseEncoding, CoreMouseEventType, ICoreMouseEvent, ICoreMouseProtocol } from 'common/Types.mouse';
import type { IDisposable } from 'common/Lifecycle';
import type { Event } from 'vs/base/common/event';

// Constructor parameter decorators (createDecorator in xterm.js), which do nothing here
const decorator = (_target: unknown, _key: string | symbol | undefined, _index: number): void => {};

export const IBufferService = decorator;
export interface IBufferService {
  // MouseService: range check; MoveToCell: row lengths
  readonly cols: number;
  readonly rows: number;
  readonly buffer: {
    // MouseService: wheel sends arrows without scrollback; MoveToCell: row navigation
    readonly hasScrollback: boolean;
    // MoveToCell: cursor
    readonly x: number;
    readonly y: number;
    // Alt+click: only at the bottom of the scrollback
    readonly ybase: number;
    readonly ydisp: number;
    // MoveToCell: wrapped rows
    readonly lines: { readonly length: number; get(index: number): { readonly isWrapped: boolean } | undefined };
    translateBufferLineToString(lineIndex: number, trimRight: boolean, startCol?: number, endCol?: number): string;
  };
}

export const IMouseStateService = decorator;
export interface IMouseStateService {
  serviceBrand: undefined;

  activeProtocol: string;
  activeEncoding: string;
  areMouseEventsActive: boolean;
  addProtocol(name: string, protocol: ICoreMouseProtocol): void;
  addEncoding(name: string, encoding: CoreMouseEncoding): void;
  reset(): void;
  setCustomWheelEventHandler(customWheelEventHandler: ((event: WheelEvent) => boolean) | undefined): void;
  allowCustomWheelEvent(ev: WheelEvent): boolean;
  onProtocolChange: Event<CoreMouseEventType>;
  restrictMouseEvent(event: ICoreMouseEvent): boolean;
  encodeMouseEvent(event: ICoreMouseEvent): string;
  readonly isDefaultEncoding: boolean;
  readonly isPixelEncoding: boolean;
}

export const ICoreService = decorator;
export interface ICoreService {
  // MouseService and MoveToCell: arrow keys follow DECCKM
  readonly decPrivateModes: { readonly applicationCursorKeys: boolean };
  // onData (user input) and onBinary (default-encoding mouse reports)
  triggerDataEvent(data: string, wasUserInput?: boolean): void;
  triggerBinaryEvent(data: string): void;
}

export const ILogService = decorator;
export interface ILogService {
  debug(message: string, ...optionalParams: any[]): void;
}

/** The options the copied mouse parts read, with xterm.js names. */
export interface IMouseOptions {
  mouseEventsRequireAlt: boolean;
  logLevel: string;
  scrollSensitivity: number;
  fastScrollSensitivity: number;
}

export const IOptionsService = decorator;
export interface IOptionsService {
  readonly rawOptions: Readonly<IMouseOptions>;
  // MouseService: mouseEventsRequireAlt
  onSpecificOptionChange<T extends keyof IMouseOptions>(key: T, listener: (value: IMouseOptions[T]) => any): IDisposable;
}
