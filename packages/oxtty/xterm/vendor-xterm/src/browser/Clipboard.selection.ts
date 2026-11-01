// Borrowed by oxtty: xterm.js src/browser/Clipboard.ts @ 08829c7eb6279dda2a9e86df901353a1a89858ca (npm @xterm/xterm 6.1.0-beta.336), MIT license — vendor-xterm/LICENSE
// Excerpt (original lines cut out as is, see the oxtty note below)
/**
 * Copyright (c) 2016 The xterm.js authors. All rights reserved.
 * @license MIT
 */

// oxtty excerpt: the copy and right click half, cut out verbatim (lines 31-41, 61-96); the paste half is Clipboard.ts.
// The import (line 6) is mapped to the oxtty module below.
import { ISelectionService } from 'browser/services/SelectionServices';

/**
 * Binds copy functionality to the given terminal.
 * @param ev The original copy event to be handled
 */
export function copyHandler(ev: ClipboardEvent, selectionService: ISelectionService): void {
  if (ev.clipboardData) {
    ev.clipboardData.setData('text/plain', selectionService.selectionText);
  }
  // Prevent or the original text will be copied.
  ev.preventDefault();
}

/**
 * Moves the textarea under the mouse cursor and focuses it.
 * @param ev The original right click event to be handled.
 * @param textarea The terminal's textarea.
 */
export function moveTextAreaUnderMouseCursor(ev: MouseEvent, textarea: HTMLTextAreaElement, screenElement: HTMLElement): void {

  // Calculate textarea position relative to the screen element
  const pos = screenElement.getBoundingClientRect();
  const left = ev.clientX - pos.left - 10;
  const top = ev.clientY - pos.top - 10;

  // Bring textarea at the cursor position
  textarea.style.width = '20px';
  textarea.style.height = '20px';
  textarea.style.left = `${left}px`;
  textarea.style.top = `${top}px`;
  textarea.style.zIndex = '1000';

  textarea.focus();
}

/**
 * Bind to right-click event and allow right-click copy and paste.
 */
export function rightClickHandler(ev: MouseEvent, textarea: HTMLTextAreaElement, screenElement: HTMLElement, selectionService: ISelectionService, shouldSelectWord: boolean): void {
  moveTextAreaUnderMouseCursor(ev, textarea, screenElement);

  if (shouldSelectWord) {
    selectionService.rightClickSelect(ev);
  }

  // Get textarea ready to copy from the context menu
  textarea.value = selectionService.selectionText;
  textarea.select();
}
