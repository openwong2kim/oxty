//! Platform-neutral input that the encoders turn into PTY bytes (PRD M3), shared by the browser front end
//! (`crates/oxtty-web`) and native hosts. Fields follow DOM `KeyboardEvent`/`MouseEvent`, the richest source;
//! a native host fills what it has. Encoders read terminal modes from the host's last frame, not the live
//! engine (PRD D7).

/// Modifier keys held during an event.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Modifiers {
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
    /// Command on macOS, the Windows key elsewhere.
    pub meta: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum KeyEventType {
    #[default]
    Press,
    Repeat,
    Release,
}

/// One key event.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyInput {
    /// DOM `KeyboardEvent.key`: the character produced (`"a"`, `"한"`) or a key name (`"Enter"`, `"ArrowUp"`).
    pub key: String,
    /// DOM `KeyboardEvent.code`: the physical key (`"KeyA"`, `"Numpad1"`); empty when unknown.
    pub code: String,
    /// DOM `KeyboardEvent.keyCode`, which the xterm.js rules still rely on; `None` on hosts without it.
    pub key_code: Option<u32>,
    /// DOM `KeyboardEvent.location`: 0 standard, 1 left, 2 right, 3 numpad.
    pub location: u8,
    pub mods: Modifiers,
    pub event_type: KeyEventType,
    /// An IME composition is in progress (DOM `isComposing` or keyCode 229).
    pub composing: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MouseButton {
    #[default]
    Left,
    Middle,
    Right,
    /// No button (motion).
    None,
    WheelUp,
    WheelDown,
    WheelLeft,
    WheelRight,
    /// Back and forward buttons (8, 9).
    Back,
    Forward,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MouseAction {
    #[default]
    Down,
    Up,
    Move,
    Wheel,
}

/// One mouse event at a cell, with the pixel position SGR-pixels mode (`?1016`) reports.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MouseInput {
    /// 0-based viewport cell.
    pub col: u32,
    pub row: u32,
    /// 0-based pixels from the top left of the screen.
    pub x: u32,
    pub y: u32,
    pub button: MouseButton,
    pub action: MouseAction,
    pub mods: Modifiers,
}
