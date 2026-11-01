//! Timers through the JS globals, so the terminal core also runs in Node (tests). Only macrotasks
//! (`setTimeout`) and animation frames: the IME and input ordering borrowed from xterm.js depends on it.
//!
//! The callback is handed to JS with `Closure::once_into_js`, which frees it after it runs; a timer cancelled
//! before it fires leaks that one closure (only on dispose).
use js_sys::Function;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = setTimeout)]
    fn set_timeout(callback: &Function, ms: i32) -> JsValue;
    #[wasm_bindgen(js_name = clearTimeout)]
    fn clear_timeout(id: &JsValue);
    #[wasm_bindgen(js_name = requestAnimationFrame, catch)]
    fn request_animation_frame(callback: &Function) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(js_name = cancelAnimationFrame)]
    fn cancel_animation_frame(id: &JsValue);
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now() -> f64;
}

/// Milliseconds, monotonic.
pub fn now() -> f64 {
    performance_now()
}

/// Runs `f` on a later task.
pub fn queue(f: impl FnOnce() + 'static) {
    set_timeout(Closure::once_into_js(f).unchecked_ref(), 0);
}

/// A `setTimeout` cleared when dropped.
pub struct Timeout(JsValue);

impl Timeout {
    pub fn new(ms: i32, f: impl FnOnce() + 'static) -> Self {
        Self(set_timeout(Closure::once_into_js(f).unchecked_ref(), ms))
    }
}

impl Drop for Timeout {
    fn drop(&mut self) {
        clear_timeout(&self.0);
    }
}

/// A `requestAnimationFrame` cancelled when dropped; `None` where there are no frames (Node).
pub struct AnimationFrame(JsValue);

impl AnimationFrame {
    pub fn new(f: impl FnOnce() + 'static) -> Option<Self> {
        request_animation_frame(Closure::once_into_js(f).unchecked_ref())
            .ok()
            .map(Self)
    }
}

impl Drop for AnimationFrame {
    fn drop(&mut self) {
        cancel_animation_frame(&self.0);
    }
}
