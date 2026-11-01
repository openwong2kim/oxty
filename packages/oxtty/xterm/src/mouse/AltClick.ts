// Stands in for the mouse side of xterm.js SelectionService until selection exists (M2 step 4): what mouse reporting
// asks of it (`shouldForceSelection`, `enable`/`disable`) and Alt+click moving the shell cursor (`altClickMovesCursor`).
// It selects nothing, so every click has empty selection text. Follows xterm.js 6.1 SelectionService
// (`shouldForceSelection`, `handleMouseDown`, `_handleMouseUp`).
import { moveToCellSequence } from 'browser/input/MoveToCell';
import type { IMouseCoordsService } from 'browser/services/MouseServices';
import type { IBufferService, ICoreService, IMouseStateService } from 'common/services/MouseServices';
import { isMac } from 'common/Platform';
import type { MouseSelection } from './MouseController';

/** A click shorter than this moves the cursor (SelectionService `ALT_CLICK_MOVE_CURSOR_TIME`). */
const ALT_CLICK_MOVE_CURSOR_TIME = 500;

export interface AltClickOptions {
  altClickMovesCursor: boolean;
  macOptionClickForcesSelection: boolean;
  mouseEventsRequireAlt: boolean;
}

export class AltClick implements MouseSelection {
  private _enabled = true;
  private _mouseDownTimeStamp = 0;
  private readonly _onMouseUp = (event: MouseEvent): void => this._handleMouseUp(event);

  constructor(
    private readonly _element: HTMLElement,
    private readonly _options: Readonly<AltClickOptions>,
    private readonly _bufferService: IBufferService,
    private readonly _coreService: ICoreService,
    private readonly _mouseCoordsService: IMouseCoordsService,
    private readonly _mouseStateService: IMouseStateService,
  ) {}

  public shouldForceSelection(event: MouseEvent): boolean {
    if (this._options.mouseEventsRequireAlt && this._mouseStateService.areMouseEventsActive) {
      return !event.altKey;
    }
    if (isMac) {
      return event.altKey && this._options.macOptionClickForcesSelection;
    }
    return event.shiftKey;
  }

  public enable(): void {
    this._enabled = true;
  }

  public disable(): void {
    this._enabled = false;
  }

  public handleMouseDown(event: MouseEvent): void {
    this._mouseDownTimeStamp = event.timeStamp;
    if (event.button !== 0) return;
    if (this._options.mouseEventsRequireAlt && this._mouseStateService.areMouseEventsActive && event.altKey) return;
    if (!this._enabled) {
      if (!this.shouldForceSelection(event)) return;
      event.stopPropagation();
    }
    event.preventDefault();
    this._element.ownerDocument.addEventListener('mouseup', this._onMouseUp);
  }

  public dispose(): void {
    this._element.ownerDocument.removeEventListener('mouseup', this._onMouseUp);
  }

  private _handleMouseUp(event: MouseEvent): void {
    const timeElapsed = event.timeStamp - this._mouseDownTimeStamp;
    this._element.ownerDocument.removeEventListener('mouseup', this._onMouseUp);
    if (timeElapsed >= ALT_CLICK_MOVE_CURSOR_TIME || !event.altKey || !this._options.altClickMovesCursor) return;
    const { buffer, cols, rows } = this._bufferService;
    if (buffer.ybase !== buffer.ydisp) return;
    const coordinates = this._mouseCoordsService.getCoords(event, this._element, cols, rows, false);
    if (!coordinates) return;
    const sequence = moveToCellSequence(coordinates[0] - 1, coordinates[1] - 1, this._bufferService, this._coreService.decPrivateModes.applicationCursorKeys);
    this._coreService.triggerDataEvent(sequence, true);
  }
}
