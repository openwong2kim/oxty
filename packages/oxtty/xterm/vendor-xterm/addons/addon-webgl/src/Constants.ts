// Borrowed by oxtty: xterm.js addons/addon-webgl/src/Constants.ts @ f447274f430fd22513f6adbf9862d19524471c04 (tag 6.0.0), MIT license — vendor-xterm/LICENSE
// Verbatim (unmodified)
/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { isFirefox, isLegacyEdge } from 'common/Platform';

export const DIM_OPACITY = 0.5;
// The text baseline is set conditionally by browser. Using 'ideographic' for Firefox or Legacy Edge
// would result in truncated text (Issue 3353). Using 'bottom' for Chrome would result in slightly
// unaligned Powerline fonts (PR 3356#issuecomment-850928179).
export const TEXT_BASELINE: CanvasTextBaseline = isFirefox || isLegacyEdge ? 'bottom' : 'ideographic';
