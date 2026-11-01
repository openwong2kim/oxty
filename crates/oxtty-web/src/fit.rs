//! The built-in `FitAddon` and `Terminal.loadAddon`.
//!
//! `proposeDimensions` is ported from xterm.js `addons/addon-fit/src/FitAddon.ts` lines 22-95, as published in
//! `@xterm/addon-fit` 0.12.0-beta.332 (MIT): the terminal fills its element's parent, less the element's padding and
//! the width xterm.js keeps for its scrollbar.
use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};

use js_sys::{Function, Object, Proxy, Reflect};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{CssStyleDeclaration, Element};

use crate::engine::get;
use crate::terminal::{Shared, Terminal};

const MINIMUM_COLS: f64 = 2.0;
const MINIMUM_ROWS: f64 = 1.0;
/// xterm.js keeps this much room for its scrollbar when there is scrollback.
const DEFAULT_SCROLL_BAR_WIDTH: f64 = 14.0;

#[wasm_bindgen(typescript_custom_section)]
const TS_ADDON: &str = r#"
export interface ITerminalAddon {
  activate(terminal: Terminal): void;
  dispose(): void;
}
"#;

struct FitState {
    id: u32,
    terminal: RefCell<Weak<Shared>>,
}

thread_local! {
    static ADDONS: RefCell<Vec<Weak<FitState>>> = const { RefCell::new(Vec::new()) };
    static NEXT_ID: Cell<u32> = const { Cell::new(1) };
}

/// Sizes the terminal to its element's parent, like `@xterm/addon-fit`.
#[wasm_bindgen]
pub struct FitAddon {
    state: Rc<FitState>,
}

impl Default for FitAddon {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl FitAddon {
    #[wasm_bindgen(constructor)]
    pub fn new() -> FitAddon {
        let state = Rc::new(FitState {
            id: NEXT_ID.with(|n| n.replace(n.get() + 1)),
            terminal: RefCell::new(Weak::new()),
        });
        ADDONS.with(|a| a.borrow_mut().push(Rc::downgrade(&state)));
        FitAddon { state }
    }

    /// `terminal.loadAddon(fitAddon)` calls this.
    pub fn activate(&self, terminal: &Terminal) {
        *self.state.terminal.borrow_mut() = Rc::downgrade(&terminal.shared);
    }

    pub fn dispose(&self) {
        *self.state.terminal.borrow_mut() = Weak::new();
    }

    /// Resizes the terminal to `proposeDimensions()`.
    pub fn fit(&self) -> Result<(), JsValue> {
        self.state.fit()
    }

    /// The size that fills the parent, `undefined` before `open` or while the cell size is unknown.
    #[wasm_bindgen(
        js_name = proposeDimensions,
        unchecked_return_type = "{ cols: number; rows: number } | undefined"
    )]
    pub fn propose_dimensions(&self) -> JsValue {
        let Some((cols, rows)) = self.state.propose() else {
            return JsValue::UNDEFINED;
        };
        let o = Object::new();
        let _ = Reflect::set(&o, &"cols".into(), &cols.into());
        let _ = Reflect::set(&o, &"rows".into(), &rows.into());
        o.into()
    }

    /// Internal: marks the built-in addon for `loadAddon`.
    #[wasm_bindgen(getter, js_name = __oxttyFitAddon, skip_typescript)]
    pub fn marker(&self) -> u32 {
        self.state.id
    }
}

impl Drop for FitAddon {
    fn drop(&mut self) {
        let state = Rc::downgrade(&self.state);
        ADDONS.with(|a| {
            if let Ok(mut a) = a.try_borrow_mut() {
                a.retain(|w| w.strong_count() > 0 && !Weak::ptr_eq(w, &state));
            }
        });
    }
}

impl FitState {
    fn fit(&self) -> Result<(), JsValue> {
        let Some((cols, rows)) = self.propose() else {
            return Ok(());
        };
        let Some(shared) = self.terminal.borrow().upgrade() else {
            return Ok(());
        };
        Terminal { shared }.resize(cols, rows)
    }

    fn propose(&self) -> Option<(u32, u32)> {
        let shared = self.terminal.borrow().upgrade()?;
        let (element, cell, scrollback, scrollbar) = {
            let core = shared.core.borrow();
            let element = core.element.clone()?;
            let cell = core.renderer.as_ref()?.dimensions().css_cell;
            (
                element,
                cell,
                get(&core.options, "scrollback"),
                get(&core.options, "scrollbar"),
            )
        };
        if cell.width == 0.0 || cell.height == 0.0 {
            return None;
        }
        let parent = element.parent_element()?;
        let show_scrollbar = get(&scrollbar, "showScrollbar").as_bool().unwrap_or(true);
        let scrollbar_width = if scrollback.as_f64() == Some(0.0) || !show_scrollbar {
            0.0
        } else {
            get(&scrollbar, "width")
                .as_f64()
                .unwrap_or(DEFAULT_SCROLL_BAR_WIDTH)
        };
        let window = parent.owner_document()?.default_view()?;
        let style = |e: &Element| window.get_computed_style(e).ok().flatten();
        let parent_style = style(&parent)?;
        let element_style = style(&element)?;
        let px = |s: &CssStyleDeclaration, name: &str| {
            parse_int(&s.get_property_value(name).unwrap_or_default())
        };
        let height = px(&parent_style, "height").max(0.0)
            - px(&element_style, "padding-top")
            - px(&element_style, "padding-bottom");
        let width = px(&parent_style, "width").max(0.0)
            - px(&element_style, "padding-right")
            - px(&element_style, "padding-left")
            - scrollbar_width;
        let cols = (width / cell.width).floor().max(MINIMUM_COLS);
        let rows = (height / cell.height).floor().max(MINIMUM_ROWS);
        (cols.is_finite() && rows.is_finite()).then_some((cols as u32, rows as u32))
    }
}

/// `parseInt(s, 10) || 0`.
fn parse_int(s: &str) -> f64 {
    let s = s.trim_start();
    let (sign, digits) = match s.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, s.strip_prefix('+').unwrap_or(s)),
    };
    let digits: String = digits.chars().take_while(char::is_ascii_digit).collect();
    digits.parse::<f64>().map_or(0.0, |v| sign * v)
}

/// Refits every fit addon loaded into `shared` (the cell size changed by itself).
pub(crate) fn refit(shared: &Rc<Shared>) {
    let loaded: Vec<Rc<FitState>> = ADDONS.with(|a| {
        a.borrow()
            .iter()
            .filter_map(Weak::upgrade)
            .filter(|s| {
                s.terminal
                    .borrow()
                    .upgrade()
                    .is_some_and(|t| Rc::ptr_eq(&t, shared))
            })
            .collect()
    });
    for state in loaded {
        if let Err(error) = state.fit() {
            web_sys::console::error_1(&error);
        }
    }
}

/// True for an addon whose `activate` only registers a Unicode 11 width provider (`@xterm/addon-unicode11`): the
/// engine already measures with those tables. `activate` runs against a stand-in that has only `unicode`.
fn is_unicode11_addon(addon: &JsValue) -> bool {
    let Some(activate) = get(addon, "activate").dyn_into::<Function>().ok() else {
        return false;
    };
    let registered = Rc::new(Cell::new(false));
    let flag = registered.clone();
    let register = Closure::<dyn FnMut(JsValue)>::new(move |provider: JsValue| {
        flag.set(get(&provider, "version").as_string().as_deref() == Some("11"));
    });
    let unicode = Object::new();
    let _ = Reflect::set(&unicode, &"register".into(), register.as_ref());
    let trap =
        Closure::<dyn FnMut(JsValue, JsValue) -> JsValue>::new(move |_target, key: JsValue| {
            if key.as_string().as_deref() == Some("unicode") {
                unicode.clone().into()
            } else {
                JsValue::UNDEFINED
            }
        });
    let handler = Object::new();
    let _ = Reflect::set(&handler, &"get".into(), trap.as_ref());
    let probe = Proxy::new(&Object::new(), &handler);
    let ok = activate.call1(addon, &probe).is_ok();
    ok && registered.get()
}

#[wasm_bindgen]
impl Terminal {
    /// Accepts the built-in `FitAddon` (refitted by itself when the cell size changes) and `SearchAddon`, and
    /// absorbs `@xterm/addon-unicode11`, whose widths the engine already uses. Any other addon throws.
    #[wasm_bindgen(js_name = loadAddon)]
    pub fn load_addon(
        &self,
        #[wasm_bindgen(unchecked_param_type = "ITerminalAddon")] addon: JsValue,
    ) -> Result<(), JsValue> {
        if let Some(id) = get(&addon, "__oxttyFitAddon").as_f64() {
            let state = ADDONS.with(|a| {
                a.borrow()
                    .iter()
                    .filter_map(Weak::upgrade)
                    .find(|s| s.id as f64 == id)
            });
            if let Some(state) = state {
                *state.terminal.borrow_mut() = Rc::downgrade(&self.shared);
                return Ok(());
            }
        }
        if crate::search::load(self, &addon) || is_unicode11_addon(&addon) {
            return Ok(());
        }
        let name = get(&get(&addon, "constructor"), "name")
            .as_string()
            .unwrap_or_default();
        Err(js_sys::Error::new(&format!(
            "oxtty/xterm: unsupported addon {name}; only the built-in FitAddon and SearchAddon and @xterm/addon-unicode11 can be loaded"
        ))
        .into())
    }
}
