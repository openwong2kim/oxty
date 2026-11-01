// [oxtty stub] Replaces xterm.js src/common/input/Win32InputMode.ts (297 lines).
// KeyboardService calls it only while the program has win32-input-mode on (`CSI ? 9001 h`). The engine does not
// track that mode, so `decPrivateModes.win32InputMode` stays false and this is never reached.
import { IKeyboardEvent, IKeyboardResult, KeyboardResultType } from 'common/Types.keyboard';

export class Win32InputMode {
  public evaluateKeyboardEvent(_ev: IKeyboardEvent, _isKeyDown: boolean): IKeyboardResult {
    return { type: KeyboardResultType.SEND_KEY, cancel: false, key: undefined };
  }
}
