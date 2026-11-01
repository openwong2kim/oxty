//! The xterm.js-compatible `Terminal`: owns the engine view, the write queue, the frame loop and the DOM element.
//! Other modules add their members in their own `#[wasm_bindgen] impl Terminal` blocks and hook in where marked
//! "Hook:" below.
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::{Rc, Weak};

use js_sys::{Function, JsString, Object, Promise, Proxy, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::HtmlElement;

use crate::emitter::{Disposable, Emitter};
use crate::engine::{get, mode, Engine, EngineView, LocalEngineView, Viewport};
use crate::render::{Dirty, Renderer};
use crate::timer;

/// Feed the engine at most this long per task, then yield to the next task (xterm.js WriteBuffer).
const TIME_BUDGET_MS: f64 = 12.0;
/// Bytes or UTF-16 units fed per engine call.
const SLICE: u32 = 16 * 1024;
/// Options that only the constructor takes, like xterm.js.
const INIT_ONLY: [&str; 3] = ["cols", "rows", "scrollback"];

const STYLE_ID: &str = "oxtty-xterm-style";
const STYLE: &str = "
.xterm { position: relative; cursor: text; user-select: none; -webkit-user-select: none; }
.xterm .xterm-screen { position: relative; }
.xterm .xterm-screen canvas { position: absolute; left: 0; top: 0; }
.xterm .xterm-helpers { position: absolute; top: 0; z-index: 5; }
.xterm.focus, .xterm:focus { outline: none; }
";

/// One `write()` waiting for the engine. `data` is a string or a `Uint8Array`.
struct Chunk {
    data: JsValue,
    callback: Option<Function>,
}

/// State behind one `RefCell`. Never call JS (listeners, write callbacks, host handlers) while it is borrowed:
/// collect what to call, drop the borrow, then call (crate docs, "Re-entrancy").
pub(crate) struct Core {
    pub view: LocalEngineView,
    pub viewport: Viewport,
    /// The user's options with the defaults filled in; `term.options` is a proxy over it.
    pub options: Object,
    pub element: Option<HtmlElement>,
    pub screen: Option<HtmlElement>,
    /// Hook: the renderer module creates it in `open`.
    pub renderer: Option<Box<dyn Renderer>>,
    pub dirty: Dirty,
    queue: VecDeque<Chunk>,
    /// A high surrogate a string `write` ended with, joined to the next one.
    high_surrogate: Option<u16>,
    pub disposed: bool,
}

/// Every xterm.js event the terminal fires. Members are added by the modules that fire them.
#[derive(Default)]
pub(crate) struct Emitters {
    pub data: Rc<Emitter>,
    pub binary: Rc<Emitter>,
    pub resize: Rc<Emitter>,
    pub title_change: Rc<Emitter>,
    pub bell: Rc<Emitter>,
    pub scroll: Rc<Emitter>,
    pub render: Rc<Emitter>,
    pub write_parsed: Rc<Emitter>,
    pub cursor_move: Rc<Emitter>,
}

/// What the engine looked like after the last change, to fire `onScroll`/`onCursorMove` on differences.
#[derive(Clone, Copy, Default, PartialEq)]
struct State {
    cursor: (i32, u32),
    viewport_y: u32,
    alternate: bool,
}

type ProxySetTrap = Closure<dyn FnMut(JsValue, JsValue, JsValue) -> bool>;
type CrashCallback = Closure<dyn FnMut(JsValue)>;

pub(crate) struct Shared {
    pub core: RefCell<Core>,
    pub events: Emitters,
    state: Cell<State>,
    /// Serialises OSC 52 reads so each answers the oldest pending read.
    clipboard_reads: RefCell<Promise>,
    drain_timer: RefCell<Option<timer::Timeout>>,
    frame: RefCell<Option<timer::AnimationFrame>>,
    options_proxy: RefCell<Option<(Proxy, ProxySetTrap)>>,
    /// `onCrash` and `onSyncFlush` the engine holds; they live as long as the terminal.
    #[allow(dead_code)]
    engine_callbacks: (CrashCallback, Closure<dyn FnMut()>),
}

#[wasm_bindgen]
pub struct Terminal {
    pub(crate) shared: Rc<Shared>,
}

#[wasm_bindgen]
impl Terminal {
    /// Throws unless `await init()` has finished.
    #[wasm_bindgen(constructor)]
    pub fn new(options: Option<Object>) -> Result<Terminal, JsValue> {
        crate::set_panic_hook();
        let options = default_options(options.unwrap_or_default());
        let engine_options = Object::new();
        for key in INIT_ONLY {
            Reflect::set(&engine_options, &key.into(), &get(&options, key))?;
        }
        // The engine calls these from inside a call this terminal made: only note it, handle it on the next task.
        let slot: Rc<RefCell<Weak<Shared>>> = Rc::default();
        let on_crash = {
            let slot = slot.clone();
            CrashCallback::new(move |error: JsValue| {
                web_sys::console::warn_1(&error);
                let weak = slot.borrow().clone();
                timer::queue(move || {
                    if let Some(shared) = weak.upgrade() {
                        shared.handle_crash();
                    }
                });
            })
        };
        let on_sync_flush = {
            let slot = slot.clone();
            Closure::<dyn FnMut()>::new(move || {
                let weak = slot.borrow().clone();
                timer::queue(move || {
                    if let Some(shared) = weak.upgrade() {
                        shared.after_change();
                    }
                });
            })
        };
        Reflect::set(&engine_options, &"onCrash".into(), on_crash.as_ref())?;
        Reflect::set(
            &engine_options,
            &"onSyncFlush".into(),
            on_sync_flush.as_ref(),
        )?;
        let engine = Engine::new(&engine_options)?;
        let shared = Rc::new(Shared {
            core: RefCell::new(Core {
                view: LocalEngineView::new(engine),
                viewport: Viewport::default(),
                options,
                element: None,
                screen: None,
                renderer: None,
                dirty: Dirty::All,
                queue: VecDeque::new(),
                high_surrogate: None,
                disposed: false,
            }),
            events: Emitters::default(),
            state: Cell::new(State::default()),
            clipboard_reads: RefCell::new(Promise::resolve(&JsValue::UNDEFINED)),
            drain_timer: RefCell::new(None),
            frame: RefCell::new(None),
            options_proxy: RefCell::new(None),
            engine_callbacks: (on_crash, on_sync_flush),
        });
        *slot.borrow_mut() = Rc::downgrade(&shared);
        shared.apply_clipboard();
        shared.state.set(shared.read_state());
        Ok(Terminal { shared })
    }

    #[wasm_bindgen(getter)]
    pub fn cols(&self) -> u32 {
        self.shared.core.borrow().view.engine().cols()
    }

    #[wasm_bindgen(getter)]
    pub fn rows(&self) -> u32 {
        self.shared.core.borrow().view.engine().rows()
    }

    #[wasm_bindgen(getter)]
    pub fn element(&self) -> Option<HtmlElement> {
        self.shared.core.borrow().element.clone()
    }

    /// `term.options.x = y` and `term.options = { … }` both go through `setOption`.
    #[wasm_bindgen(getter)]
    pub fn options(&self) -> Result<Proxy, JsValue> {
        if let Some((proxy, _)) = &*self.shared.options_proxy.borrow() {
            return Ok(proxy.clone());
        }
        let weak = Rc::downgrade(&self.shared);
        let set = ProxySetTrap::new(move |_target, key: JsValue, value: JsValue| {
            // Throw only after every Rust value is dropped: a JS exception skips destructors.
            let error = match (weak.upgrade(), key.as_string()) {
                (Some(shared), Some(key)) => shared.set_option(&key, value).err(),
                _ => None,
            };
            if let Some(error) = error {
                wasm_bindgen::throw_val(error);
            }
            true
        });
        let handler = Object::new();
        Reflect::set(&handler, &"set".into(), set.as_ref())?;
        let proxy = Proxy::new(&self.shared.core.borrow().options, &handler);
        *self.shared.options_proxy.borrow_mut() = Some((proxy.clone(), set));
        Ok(proxy)
    }

    #[wasm_bindgen(setter)]
    pub fn set_options(&self, options: Object) -> Result<(), JsValue> {
        for entry in Object::entries(&options).iter() {
            let entry: js_sys::Array = entry.unchecked_into();
            self.shared
                .set_option(&entry.get(0).as_string().unwrap_or_default(), entry.get(1))?;
        }
        Ok(())
    }

    pub fn open(&self, parent: HtmlElement) -> Result<(), JsValue> {
        let mut core = self.shared.core.borrow_mut();
        if let Some(element) = &core.element {
            // xterm.js keeps its DOM when opened again; a parked element is simply moved.
            if element.parent_element().as_deref() != Some(&parent) {
                parent.append_child(element)?;
            }
            return Ok(());
        }
        let document = parent
            .owner_document()
            .ok_or("oxtty/xterm: the parent is not in a document")?;
        if document.get_element_by_id(STYLE_ID).is_none() {
            let style = document.create_element("style")?;
            style.set_id(STYLE_ID);
            style.set_text_content(Some(STYLE));
            document
                .head()
                .ok_or("oxtty/xterm: the document has no head")?
                .append_child(&style)?;
        }
        let element: HtmlElement = document.create_element("div")?.unchecked_into();
        element.class_list().add_2("terminal", "xterm")?;
        element.set_dir("ltr");
        let screen: HtmlElement = document.create_element("div")?.unchecked_into();
        screen.class_list().add_1("xterm-screen")?;
        // Input puts the hidden textarea and the IME composition view in here.
        let helpers = document.create_element("div")?;
        helpers.class_list().add_1("xterm-helpers")?;
        screen.append_child(&helpers)?;
        element.append_child(&screen)?;
        parent.append_child(&element)?;
        core.element = Some(element);
        core.screen = Some(screen);
        // Hook: renderer, input, mouse, selection and accessibility attach here.
        core.view.invalidate();
        core.dirty = Dirty::All;
        drop(core);
        self.shared.schedule_frame();
        Ok(())
    }

    /// `callback` runs once the engine has parsed `data`; `write('', callback)` waits for earlier writes.
    pub fn write(&self, data: JsValue, callback: Option<Function>) {
        let mut core = self.shared.core.borrow_mut();
        if core.disposed {
            return;
        }
        let data = match data.dyn_into::<JsString>() {
            Ok(mut text) => {
                if let Some(high) = core.high_surrogate.take() {
                    text = JsString::from_char_code1(high.into()).concat(&text);
                }
                let len = text.length();
                if len > 0 && is_high_surrogate(text.char_code_at(len - 1) as u16) {
                    core.high_surrogate = Some(text.char_code_at(len - 1) as u16);
                    text = text.slice(0, len - 1);
                }
                text.into()
            }
            Err(data) => data,
        };
        core.queue.push_back(Chunk { data, callback });
        drop(core);
        self.shared.schedule_drain();
    }

    pub fn writeln(&self, data: JsValue, callback: Option<Function>) {
        self.write(data, None);
        self.write("\r\n".into(), callback);
    }

    pub fn resize(&self, cols: u32, rows: u32) -> Result<(), JsValue> {
        {
            let mut core = self.shared.core.borrow_mut();
            let engine = core.view.engine();
            if core.disposed || (cols == engine.cols() && rows == engine.rows()) {
                return Ok(());
            }
            engine.resize(cols, rows)?;
            let (cols, rows) = (engine.cols(), engine.rows());
            Reflect::set(&core.options, &"cols".into(), &cols.into())?;
            Reflect::set(&core.options, &"rows".into(), &rows.into())?;
            if let Some(renderer) = core.renderer.as_mut() {
                renderer.resize(cols, rows);
            }
            // Hook: selection drops on row changes.
        }
        let size = Object::new();
        Reflect::set(&size, &"cols".into(), &self.cols().into())?;
        Reflect::set(&size, &"rows".into(), &self.rows().into())?;
        self.shared.events.resize.fire(&[&size]);
        self.shared.after_change();
        Ok(())
    }

    /// Positive `amount` scrolls down towards the newest output.
    #[wasm_bindgen(js_name = scrollLines)]
    pub fn scroll_lines(&self, amount: i32) -> Result<(), JsValue> {
        self.shared
            .core
            .borrow()
            .view
            .engine()
            .scroll_display(-amount)?;
        self.shared.after_change();
        Ok(())
    }

    #[wasm_bindgen(js_name = scrollToBottom)]
    pub fn scroll_to_bottom(&self) -> Result<(), JsValue> {
        self.shared.core.borrow().view.engine().scroll_to_bottom()?;
        self.shared.after_change();
        Ok(())
    }

    #[wasm_bindgen(js_name = onData)]
    pub fn on_data(&self, listener: Function) -> Disposable {
        self.shared.events.data.event(listener)
    }

    #[wasm_bindgen(js_name = onBinary)]
    pub fn on_binary(&self, listener: Function) -> Disposable {
        self.shared.events.binary.event(listener)
    }

    #[wasm_bindgen(js_name = onResize)]
    pub fn on_resize(&self, listener: Function) -> Disposable {
        self.shared.events.resize.event(listener)
    }

    #[wasm_bindgen(js_name = onTitleChange)]
    pub fn on_title_change(&self, listener: Function) -> Disposable {
        self.shared.events.title_change.event(listener)
    }

    #[wasm_bindgen(js_name = onBell)]
    pub fn on_bell(&self, listener: Function) -> Disposable {
        self.shared.events.bell.event(listener)
    }

    #[wasm_bindgen(js_name = onScroll)]
    pub fn on_scroll(&self, listener: Function) -> Disposable {
        self.shared.events.scroll.event(listener)
    }

    #[wasm_bindgen(js_name = onRender)]
    pub fn on_render(&self, listener: Function) -> Disposable {
        self.shared.events.render.event(listener)
    }

    #[wasm_bindgen(js_name = onWriteParsed)]
    pub fn on_write_parsed(&self, listener: Function) -> Disposable {
        self.shared.events.write_parsed.event(listener)
    }

    #[wasm_bindgen(js_name = onCursorMove)]
    pub fn on_cursor_move(&self, listener: Function) -> Disposable {
        self.shared.events.cursor_move.event(listener)
    }

    /// Drops pending writes without running their callbacks, like xterm.js. Safe to call from any listener.
    pub fn dispose(&self) {
        let mut core = self.shared.core.borrow_mut();
        if core.disposed {
            return;
        }
        core.disposed = true;
        core.queue.clear();
        // Hook: input, mouse, selection and accessibility remove their listeners here.
        core.renderer = None;
        if let Some(element) = core.element.take() {
            element.remove();
        }
        core.screen = None;
        core.view.engine().dispose();
        drop(core);
        self.shared.drain_timer.borrow_mut().take();
        self.shared.frame.borrow_mut().take();
        self.shared.options_proxy.borrow_mut().take();
        let e = &self.shared.events;
        for emitter in [
            &e.data,
            &e.binary,
            &e.resize,
            &e.title_change,
            &e.bell,
            &e.scroll,
            &e.render,
            &e.write_parsed,
            &e.cursor_move,
        ] {
            emitter.clear();
        }
    }
}

impl Shared {
    pub(crate) fn schedule_drain(self: &Rc<Self>) {
        if self.drain_timer.borrow().is_some() {
            return;
        }
        let weak = Rc::downgrade(self);
        *self.drain_timer.borrow_mut() = Some(timer::Timeout::new(0, move || {
            if let Some(shared) = weak.upgrade() {
                shared.drain_timer.borrow_mut().take();
                shared.drain();
            }
        }));
    }

    /// Feeds queued writes for up to [`TIME_BUDGET_MS`]. A crashed engine drops the chunk it was fed.
    fn drain(self: &Rc<Self>) {
        let start = timer::now();
        loop {
            let finished = {
                let mut core = self.core.borrow_mut();
                if core.disposed {
                    return;
                }
                let Some(chunk) = core.queue.front_mut() else {
                    break;
                };
                let (slice, rest) = split_chunk(&chunk.data);
                let fed = core.view.engine().write(&slice);
                let chunk = core.queue.front_mut().unwrap();
                match (fed, rest) {
                    (Ok(()), Some(rest)) => {
                        chunk.data = rest;
                        None
                    }
                    _ => Some(core.queue.pop_front().unwrap().callback),
                }
            };
            if let Some(callback) = finished {
                self.handle_events();
                // Hook: selection syncs to the output just parsed, before the callback reads it.
                if let Some(callback) = callback {
                    if let Err(error) = callback.call0(&JsValue::UNDEFINED) {
                        web_sys::console::error_1(&error);
                    }
                }
            }
            if timer::now() - start >= TIME_BUDGET_MS {
                break;
            }
        }
        if !self.core.borrow().queue.is_empty() {
            self.schedule_drain();
        }
        if self.core.borrow().disposed {
            return;
        }
        self.handle_events();
        self.events.write_parsed.fire(&[]);
        self.after_change();
    }

    /// Hands what the program asked of the host to the events; runs after every parsed write, frames or not.
    pub(crate) fn handle_events(self: &Rc<Self>) {
        let (events, clipboard) = {
            let mut core = self.core.borrow_mut();
            if core.disposed {
                return;
            }
            (core.view.take_events(), get(&core.options, "clipboard"))
        };
        if !events.replies.is_empty() {
            // Hook: replies go through the input module's data path (scroll-on-input rules) once it exists.
            let text = String::from_utf8_lossy(&events.replies).into_owned();
            self.events.data.fire(&[&text.into()]);
        }
        if let Some(title) = events.title {
            self.events.title_change.fire(&[&title.into()]);
        }
        for _ in 0..events.bells {
            self.events.bell.fire(&[]);
        }
        // Hook: selection drops on each of `events.resets`.
        let write: Option<Function> = get(&clipboard, "write").dyn_into().ok();
        for w in events.clipboard_writes {
            if let Some(write) = &write {
                if let Err(error) =
                    write.call2(&clipboard, &w.text.into(), &w.selection.to_string().into())
                {
                    web_sys::console::error_1(&error);
                }
            }
        }
        for selection in events.clipboard_reads {
            self.queue_clipboard_read(&clipboard, selection);
        }
    }

    /// Reads are answered in order, each with the oldest pending read of its selection; a failed read answers "".
    fn queue_clipboard_read(self: &Rc<Self>, clipboard: &JsValue, selection: char) {
        let read: Option<Function> = get(clipboard, "read").dyn_into().ok();
        let clipboard = clipboard.clone();
        let weak = Rc::downgrade(self);
        let previous = self.clipboard_reads.borrow().clone();
        let next = wasm_bindgen_futures::future_to_promise(async move {
            let _ = wasm_bindgen_futures::JsFuture::from(previous).await;
            let mut text = String::new();
            if let Some(read) = read {
                if let Ok(value) = read.call1(&clipboard, &selection.to_string().into()) {
                    let value =
                        wasm_bindgen_futures::JsFuture::from(Promise::resolve(&value)).await;
                    text = value.ok().and_then(|v| v.as_string()).unwrap_or_default();
                }
            }
            if let Some(shared) = weak.upgrade() {
                let replied = {
                    let core = shared.core.borrow();
                    !core.disposed
                        && core
                            .view
                            .engine()
                            .reply_clipboard(&selection.to_string(), &text)
                            .is_ok()
                };
                if replied {
                    shared.handle_events();
                }
            }
            Ok(JsValue::UNDEFINED)
        });
        *self.clipboard_reads.borrow_mut() = next;
    }

    fn set_option(self: &Rc<Self>, key: &str, value: JsValue) -> Result<(), JsValue> {
        {
            let core = self.core.borrow();
            if INIT_ONLY.contains(&key) {
                if !js_sys::Object::is(&value, &get(&core.options, key)) {
                    return Err(JsValue::from_str(&format!(
                        "oxtty/xterm: option \"{key}\" can only be set in the constructor"
                    )));
                }
                return Ok(());
            }
            Reflect::set(&core.options, &key.into(), &value)?;
        }
        if key == "clipboard" {
            self.apply_clipboard();
        }
        // Hook: theme (engine colours, renderer), renderer options, input, mouse and accessibility options.
        Ok(())
    }

    fn apply_clipboard(&self) {
        let core = self.core.borrow();
        let clipboard = get(&core.options, "clipboard");
        let access = Object::new();
        let _ = Reflect::set(
            &access,
            &"read".into(),
            &get(&clipboard, "read").is_function().into(),
        );
        let _ = Reflect::set(
            &access,
            &"write".into(),
            &get(&clipboard, "write").is_function().into(),
        );
        let _ = core.view.engine().set_clipboard_access(&access);
    }

    /// Fires the state events and schedules a frame after the engine changed.
    pub(crate) fn after_change(self: &Rc<Self>) {
        if self.core.borrow().disposed {
            return;
        }
        let (old, new) = (self.state.get(), self.read_state());
        self.state.set(new);
        // Hook: selection syncs; buffer fires onBufferChange when `alternate` changed.
        if new.viewport_y != old.viewport_y {
            self.events.scroll.fire(&[&new.viewport_y.into()]);
        }
        if new.cursor != old.cursor {
            self.events.cursor_move.fire(&[]);
        }
        self.schedule_frame();
    }

    fn read_state(&self) -> State {
        let core = self.core.borrow();
        let cursor = core.view.cursor();
        let e = core.view.engine();
        State {
            cursor: (cursor.line, cursor.col),
            viewport_y: e.history_length() - e.display_offset(),
            alternate: e.modes().unwrap_or(0) & mode::ALT_SCREEN != 0,
        }
    }

    /// After an engine crash the terminal starts over empty: redraw everything.
    fn handle_crash(self: &Rc<Self>) {
        {
            let mut core = self.core.borrow_mut();
            core.view.invalidate();
            core.dirty = Dirty::All;
            // Hook: selection drops.
        }
        self.after_change();
    }

    /// Asks for a frame; touches only the frame slot, so it is safe from anywhere (renderers wake it this way).
    pub(crate) fn schedule_frame(self: &Rc<Self>) {
        if self.frame.borrow().is_some() {
            return;
        }
        let weak: Weak<Self> = Rc::downgrade(self);
        *self.frame.borrow_mut() = timer::AnimationFrame::new(move || {
            if let Some(shared) = weak.upgrade() {
                shared.frame.borrow_mut().take();
                shared.render_frame();
            }
        });
    }

    fn render_frame(self: &Rc<Self>) {
        let rows = {
            let mut core = self.core.borrow_mut();
            if core.disposed || core.renderer.is_none() {
                return;
            }
            let frame = core.view.take_frame();
            let changed = core.viewport.apply(frame);
            let dirty = std::mem::replace(&mut core.dirty, Dirty::Rows(Vec::new()));
            let Core {
                renderer, viewport, ..
            } = &mut *core;
            renderer
                .as_mut()
                .unwrap()
                .render(viewport, &changed, &dirty);
            // Hook: input reads modes from the frame; selection and links repaint.
            match dirty {
                Dirty::All => Some((0, viewport.rows.saturating_sub(1))),
                Dirty::Rows(rows) => changed.iter().chain(&rows).fold(None, |range, &y| {
                    Some(range.map_or((y, y), |(a, b): (u32, u32)| (a.min(y), b.max(y))))
                }),
            }
        };
        if let Some((start, end)) = rows {
            let range = Object::new();
            let _ = Reflect::set(&range, &"start".into(), &start.into());
            let _ = Reflect::set(&range, &"end".into(), &end.into());
            self.events.render.fire(&[&range]);
        }
    }
}

/// The first [`SLICE`] of a chunk and what is left, or `None` when it fits. Strings are cut between surrogates.
fn split_chunk(data: &JsValue) -> (JsValue, Option<JsValue>) {
    if let Some(bytes) = data.dyn_ref::<Uint8Array>() {
        if bytes.length() <= SLICE {
            return (data.clone(), None);
        }
        return (
            bytes.subarray(0, SLICE).into(),
            Some(bytes.subarray(SLICE, bytes.length()).into()),
        );
    }
    let text: &JsString = data.unchecked_ref();
    if text.length() <= SLICE {
        return (data.clone(), None);
    }
    let mut n = SLICE;
    if is_high_surrogate(text.char_code_at(n - 1) as u16) {
        n -= 1;
    }
    (
        text.slice(0, n).into(),
        Some(text.slice(n, text.length()).into()),
    )
}

fn is_high_surrogate(unit: u16) -> bool {
    (0xd800..=0xdbff).contains(&unit)
}

/// xterm.js 6 defaults of the options the terminal keeps; modules apply their own defaults to the rest.
fn default_options(options: Object) -> Object {
    let defaults: [(&str, JsValue); 3] = [
        ("cols", 80.into()),
        ("rows", 24.into()),
        ("scrollback", 1000.into()),
    ];
    let merged = Object::new();
    for (key, value) in defaults {
        let _ = Reflect::set(&merged, &key.into(), &value);
    }
    Object::assign(&merged, &options)
}
