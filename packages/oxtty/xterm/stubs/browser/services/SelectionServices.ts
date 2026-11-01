// [oxtty stub] Replaces xterm.js 6.1 src/browser/services/Services.ts (181 lines) for the copied selection parts.
// Interfaces keeping only the members SelectionService and the copy and right click handlers call. Implemented by
// src/selection/SelectionController.ts. A separate module from Services.ts and MouseServices.ts, whose services the
// other copied parts use with other members.
export { IMouseCoordsService } from 'browser/services/MouseServices';

// Constructor parameter decorators (createDecorator in xterm.js), which do nothing here
const decorator = (_target: unknown, _key: string | symbol | undefined, _index: number): void => {};

export const ICoreBrowserService = decorator;
export interface ICoreBrowserService {
  // Redraw frames, the drag scroll timer and mouse coordinates
  readonly window: Window;
}

export const IRenderService = decorator;
export interface IRenderService {
  // Drag scrolling starts above or below the canvas
  readonly dimensions: { readonly css: { readonly canvas: { readonly height: number } } };
}

export const ISelectionService = decorator;
export interface ISelectionService {
  readonly selectionText: string;
  // rightClickHandler: `rightClickSelectsWord`
  rightClickSelect(event: MouseEvent): void;
}
