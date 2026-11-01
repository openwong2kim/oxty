// Borrowed by oxtty: xterm.js src/browser/Clipboard.ts @ 08829c7eb6279dda2a9e86df901353a1a89858ca (npm @xterm/xterm 6.1.0-beta.336), MIT license — vendor-xterm/LICENSE
// Excerpt (original lines cut out as is, see the oxtty note below)
/**
 * Copyright (c) 2016 The xterm.js authors. All rights reserved.
 * @license MIT
 */

// oxtty excerpt: the paste half, cut out verbatim (lines 9-29, 42-59); copy and right click belong to selection.
// The import (line 7) uses this tree's path alias, which resolves to xterm/stubs.
import { ICoreService, IOptionsService } from 'common/services/Services';

/**
 * Prepares text to be pasted into the terminal by normalizing the line endings
 * @param text The pasted text that needs processing before inserting into the terminal
 */
export function prepareTextForTerminal(text: string): string {
  return text.replace(/\r?\n/g, '\r');
}

/**
 * Bracket text for paste, if necessary, as per https://cirw.in/blog/bracketed-paste
 * @param text The pasted text to bracket
 */
export function bracketTextForPaste(text: string, bracketedPasteMode: boolean): string {
  if (!bracketedPasteMode) {
    return text;
  }
  // Sanitize pasted text to prevent injected escape sequences (e.g. exiting bracketed paste)
  // by replacing ESC (\x1b) with its visible representation U+241B (␛).
  const sanitizedText = text.replace(/\x1b/g, '\u241b');
  return `\x1b[200~${sanitizedText}\x1b[201~`;
}

/**
 * Redirect the clipboard's data to the terminal's input handler.
 */
export function handlePasteEvent(ev: ClipboardEvent, textarea: HTMLTextAreaElement, coreService: ICoreService, optionsService: IOptionsService): void {
  ev.stopPropagation();
  if (ev.clipboardData) {
    const text = ev.clipboardData.getData('text/plain');
    paste(text, textarea, coreService, optionsService);
  }
}

export function paste(text: string, textarea: HTMLTextAreaElement, coreService: ICoreService, optionsService: IOptionsService): void {
  text = prepareTextForTerminal(text);
  text = bracketTextForPaste(text, coreService.decPrivateModes.bracketedPasteMode && optionsService.rawOptions.ignoreBracketedPasteMode !== true);
  coreService.triggerDataEvent(text, true);
  textarea.value = '';
}
