// Borrowed by oxtty: xterm.js src/common/Types.ts @ 08829c7eb6279dda2a9e86df901353a1a89858ca (6.1.0-beta.336), MIT license — vendor-xterm/LICENSE
// Excerpt (original lines cut out as is, see the oxtty note below)
/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */
// oxtty excerpt: the mouse types (lines 146-243), cut out verbatim. common/Types.ts holds the 6.0 renderer excerpt of the same file.
/**
 * Interface for mouse events in the core.
 */
export const enum CoreMouseButton {
  LEFT = 0,
  MIDDLE = 1,
  RIGHT = 2,
  NONE = 3,
  WHEEL = 4,
  // additional buttons 1..8
  // untested!
  AUX1 = 8,
  AUX2 = 9,
  AUX3 = 10,
  AUX4 = 11,
  AUX5 = 12,
  AUX6 = 13,
  AUX7 = 14,
  AUX8 = 15
}

export const enum CoreMouseAction {
  UP = 0,     // buttons, wheel
  DOWN = 1,   // buttons, wheel
  LEFT = 2,   // wheel only
  RIGHT = 3,  // wheel only
  MOVE = 32   // buttons only
}

export interface ICoreMouseEvent {
  /** column (zero based). */
  col: number;
  /** row (zero based). */
  row: number;
  /** xy pixel positions. */
  x: number;
  y: number;
  /**
   * Button the action occurred. Due to restrictions of the tracking protocols
   * it is not possible to report multiple buttons at once.
   * Wheel is treated as a button.
   * There are invalid combinations of buttons and actions possible
   * (like move + wheel), those are silently ignored by the MouseStateService.
   */
  button: CoreMouseButton;
  action: CoreMouseAction;
  /**
   * Modifier states.
   * Protocols will add/ignore those based on specific restrictions.
   */
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/**
 * CoreMouseEventType
 * To be reported to the browser component which events a mouse
 * protocol wants to be catched and forwarded as an ICoreMouseEvent
 * to MouseStateService.
 */
export const enum CoreMouseEventType {
  NONE = 0,
  /** any mousedown event */
  DOWN = 1,
  /** any mouseup event */
  UP = 2,
  /** any mousemove event while a button is held */
  DRAG = 4,
  /** any mousemove event without a button */
  MOVE = 8,
  /** any wheel event */
  WHEEL = 16
}

/**
 * Mouse protocol interface.
 * A mouse protocol can be registered and activated at the MouseStateService.
 * `events` should contain a list of needed events as a hint for the browser component
 * to install/remove the appropriate event handlers.
 * `restrict` applies further protocol specific restrictions like not allowed
 * modifiers or filtering invalid event types.
 */
export interface ICoreMouseProtocol {
  events: CoreMouseEventType;
  restrict: (e: ICoreMouseEvent) => boolean;
}

/**
 * CoreMouseEncoding
 * The tracking encoding can be registered and activated at the MouseStateService.
 * If a ICoreMouseEvent passes all procotol restrictions it will be encoded
 * with the active encoding and sent out.
 * Note: Returning an empty string will supress sending a mouse report,
 * which can be used to skip creating falsey reports in limited encodings
 * (DEFAULT only supports up to 223 1-based as coord value).
 */
export type CoreMouseEncoding = (event: ICoreMouseEvent) => string;
