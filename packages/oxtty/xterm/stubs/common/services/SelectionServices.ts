// [oxtty stub] Replaces xterm.js 6.1 src/common/services/Services.ts (396 lines) for the copied selection parts.
// Interfaces keeping only the members SelectionService and SelectionModel call. Implemented by src/selection/SelectionController.ts.
// A separate module from Services.ts and MouseServices.ts, whose services the other copied parts use with other members.
import type { IBuffer } from 'common/buffer/Types';
import type { Event as IEvent } from 'vs/base/common/event';

export { IMouseStateService } from 'common/services/MouseServices';

// Constructor parameter decorators (createDecorator in xterm.js), which do nothing here
const decorator = (_target: unknown, _key: string | symbol | undefined, _index: number): void => {};

export const IBufferService = decorator;
export interface IBufferService {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: IBuffer;
  // A switch to or from the alternate screen clears the selection
  readonly buffers: { readonly onBufferActivate: IEvent<{ activeBuffer: IBuffer, inactiveBuffer: IBuffer }> };
  // A resize that changes the rows clears the selection
  readonly onResize: IEvent<{ cols: number, rows: number, colsChanged: boolean, rowsChanged: boolean }>;
}

export const ICoreService = decorator;
export interface ICoreService {
  // MoveToCell: arrow keys follow DECCKM
  readonly decPrivateModes: { readonly applicationCursorKeys: boolean };
  // Alt+click cursor moves are user input
  triggerDataEvent(data: string, wasUserInput?: boolean): void;
  // User input clears the selection
  readonly onUserInput: IEvent<void>;
}

/** The options the copied selection parts read, with xterm.js names. */
export interface ISelectionOptions {
  altClickMovesCursor: boolean;
  macOptionClickForcesSelection: boolean;
  mouseEventsRequireAlt: boolean;
  wordSeparator: string;
}

export const IOptionsService = decorator;
export interface IOptionsService {
  readonly rawOptions: Readonly<ISelectionOptions>;
}
