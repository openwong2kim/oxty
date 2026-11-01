// [oxtty stub] Replaces xterm.js 6.1 src/browser/services/Services.ts (181 lines) for the copied mouse parts.
// Interfaces keeping only the members MouseService and MouseCoordsService call. Implemented by src/mouse/MouseController.ts.
// A separate module from Services.ts, whose services the renderer parts use with other members.
import type { IDisposable } from 'common/Lifecycle';

// Constructor parameter decorators (createDecorator in xterm.js), which do nothing here
const decorator = (_target: unknown, _key: string | symbol | undefined, _index: number): void => {};

export const ICharSizeService = decorator;
export interface ICharSizeService {
  // MouseCoordsService: no coordinates before the cell size is known
  readonly hasValidSize: boolean;
}

export const ICoreBrowserService = decorator;
export interface ICoreBrowserService {
  // MouseService: wheel pixels per line
  readonly dpr: number;
}

export const IRenderService = decorator;
export interface IRenderService {
  // MouseCoordsService: pixel → cell; MouseService: wheel pixels per line
  readonly dimensions: {
    readonly css: { readonly cell: { readonly width: number; readonly height: number }; readonly canvas: { readonly width: number; readonly height: number } };
    readonly device: { readonly cell: { readonly width: number; readonly height: number } };
  };
}

export const IMouseCoordsService = decorator;
export interface IMouseCoordsService {
  getCoords(event: { clientX: number, clientY: number }, element: HTMLElement, colCount: number, rowCount: number, isSelection?: boolean): [number, number] | undefined;
  getMouseReportCoords(event: MouseEvent, element: HTMLElement): { col: number, row: number, x: number, y: number } | undefined;
}

export const ISelectionService = decorator;
export interface ISelectionService {
  // MouseService: a modifier forces a selection instead of a report; reporting on/off turns selection off/on
  shouldForceSelection(event: MouseEvent): boolean;
  enable(): void;
  disable(): void;
}

export interface IMouseService {
  bindMouse(target: IMouseServiceTarget, register: (disposable: IDisposable) => void, focus: () => void): void;
  reset(): void;
}

export interface IMouseServiceTarget {
  element: HTMLElement;
  screenElement: HTMLElement;
  document: Document;
  handleTouchScroll?(amount: number): void;
}
