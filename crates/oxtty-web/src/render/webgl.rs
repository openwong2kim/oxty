//! The WebGL2 renderer: ties together the glyph and rectangle renderers, the shared atlas, the render model and
//! the colour resolver; fills the model from [`Viewport`] rows; owns the canvas, the context and its recovery.
//!
//! Ported from xterm.js 6.0.0 (commit f447274f430fd22513f6adbf9862d19524471c04, MIT): the model update, dimensions
//! and font/devicePixelRatio handling of `addons/addon-webgl/src/WebglRenderer.ts` lines 200-560,
//! `src/browser/services/CharSizeService.ts` lines 13-127 (glyph measurement) and
//! `addons/addon-webgl/src/DevicePixelObserver.ts` lines 8-40, by way of the TypeScript orchestrator at 0510a7d
//! (`packages/oxtty/xterm/src/renderer/WebglRenderer.ts`), whose context state machine (live/lost/parked) and
//! context hand-over between panes are oxtty's.
//!
//! # Contexts
//!
//! A page keeps only so many WebGL contexts (16 in Chrome) and takes the least recently used away when a new one
//! goes over. A lost context waits [`CONTEXT_RESTORE_TIMEOUT`] for `webglcontextrestored`, then the renderer makes a
//! new canvas under a back-off throttle. A context the browser took away for another pane is never restored, so
//! that renderer is *parked* instead: it waits to be handed a context by a pane that goes out of view or away,
//! which keeps panes from evicting each other in a loop.
//!
//! # Re-entrancy
//!
//! State is behind one `RefCell` per renderer. DOM listeners, timers and observers borrow it with `try_borrow_mut`
//! and retry on a later task when it is busy; they never call into the terminal, they queue
//! [`RendererRequest`]s and call the terminal's `wake`.
use std::cell::{Cell, RefCell};
use std::collections::BTreeSet;
use std::rc::{Rc, Weak};

use js_sys::{Array, Object, Reflect};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{
    Document, Event, EventTarget, FocusEvent, HtmlCanvasElement, HtmlElement, IntersectionObserver,
    IntersectionObserverEntry, OffscreenCanvasRenderingContext2d, ResizeObserver,
    ResizeObserverBoxOptions, ResizeObserverOptions, WebGl2RenderingContext as Gl,
    WebGlContextAttributes, WebglLoseContext,
};

use super::atlas::{self, AtlasConfig, TextureAtlas};
use super::blink::Blink;
use super::cell::{CellData, CM_RGB, RGB_MASK};
use super::color::{css_to_color, ColorSet};
use super::glyphs::GlyphRenderer;
use super::model::{
    resolve, CursorModel, RenderModel, ResolvedHighlight, SelectionModel, COMBINED_CHAR_BIT_MASK,
    RENDER_MODEL_BG_OFFSET, RENDER_MODEL_EXT_OFFSET, RENDER_MODEL_FG_OFFSET,
    RENDER_MODEL_INDICIES_PER_CELL,
};
use super::rects::{css_floats, Rect, RectangleRenderer};
use super::{
    CursorInactiveStyle, CursorStyle, Dimensions, Dirty, Highlight, Renderer, RendererOptions,
    RendererRequest, SelectionRange,
};
use crate::engine::{attr, CursorShape, Viewport};
use crate::timer::{self, Timeout};

/// How long a lost context may take to come back by itself before the renderer makes a new one (as in xterm.js).
const CONTEXT_RESTORE_TIMEOUT: i32 = 3000;
/// Requests kept for [`Renderer::debug`].
const LOG_LIMIT: usize = 256;

thread_local! {
    /// Live renderers in creation order, to hand contexts to the ones in view.
    static RENDERERS: RefCell<Vec<Weak<RefCell<Inner>>>> = const { RefCell::new(Vec::new()) };
    static NEXT_ID: Cell<u32> = const { Cell::new(1) };
}

/// `Live`: drawing. `Lost`: waiting for `webglcontextrestored`. `Parked`: no context until one is handed over.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Live,
    Lost,
    Parked,
}

/// A DOM listener, removed when dropped.
struct Listener {
    target: EventTarget,
    kind: &'static str,
    closure: Closure<dyn FnMut(Event)>,
}

impl Listener {
    fn new(target: &EventTarget, kind: &'static str, closure: Closure<dyn FnMut(Event)>) -> Self {
        let _ = target.add_event_listener_with_callback(kind, closure.as_ref().unchecked_ref());
        Self {
            target: target.clone(),
            kind,
            closure,
        }
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        let _ = self
            .target
            .remove_event_listener_with_callback(self.kind, self.closure.as_ref().unchecked_ref());
    }
}

enum Observer {
    Resize(ResizeObserver),
    Intersection(IntersectionObserver),
}

/// An observer and its callback, disconnected when dropped.
struct Observed {
    observer: Observer,
    _closure: Closure<dyn FnMut(Array)>,
}

impl Drop for Observed {
    fn drop(&mut self) {
        match &self.observer {
            Observer::Resize(o) => o.disconnect(),
            Observer::Intersection(o) => o.disconnect(),
        }
    }
}

/// How glyphs are measured (`CharSizeService`): canvas text metrics, or a DOM element where those are missing.
enum Measure {
    Metrics(OffscreenCanvasRenderingContext2d),
    Dom(HtmlElement),
}

impl Measure {
    fn new(document: &Document, parent: &HtmlElement) -> Option<Self> {
        if let Some(ctx) = metrics_context() {
            return Some(Self::Metrics(ctx));
        }
        const REPEAT: usize = 32;
        let span: HtmlElement = document.create_element("span").ok()?.dyn_into().ok()?;
        let _ = span.class_list().add_1("xterm-char-measure-element");
        span.set_text_content(Some(&"W".repeat(REPEAT)));
        let _ = span.set_attribute("aria-hidden", "true");
        let _ = span.style().set_property("white-space", "pre");
        let _ = span.style().set_property("font-kerning", "none");
        parent.append_child(&span).ok()?;
        Some(Self::Dom(span))
    }

    fn measure(&self, options: &RendererOptions) -> Option<(f64, f64)> {
        let (width, height) = match self {
            Self::Metrics(ctx) => {
                ctx.set_font(&format!("{}px {}", options.font_size, options.font_family));
                let m = ctx.measure_text("W").ok()?;
                (
                    m.width(),
                    m.font_bounding_box_ascent() + m.font_bounding_box_descent(),
                )
            }
            Self::Dom(span) => {
                let style = span.style();
                let _ = style.set_property("font-family", &options.font_family);
                let _ = style.set_property("font-size", &format!("{}px", options.font_size));
                // Note that this triggers a synchronous layout
                (
                    span.offset_width() as f64 / 32.0,
                    span.offset_height() as f64,
                )
            }
        };
        // Zero while the element is display:none: keep the last size then
        (width > 0.0 && height > 0.0).then_some((width, height))
    }
}

impl Drop for Measure {
    fn drop(&mut self) {
        if let Self::Dom(span) = self {
            span.remove();
        }
    }
}

fn metrics_context() -> Option<OffscreenCanvasRenderingContext2d> {
    let canvas = web_sys::OffscreenCanvas::new(100, 100).ok()?;
    let ctx: OffscreenCanvasRenderingContext2d = canvas.get_context("2d").ok()??.dyn_into().ok()?;
    let m = ctx.measure_text("W").ok()?;
    let has = |key: &str| Reflect::has(&m, &key.into()).unwrap_or(false);
    (has("width") && has("fontBoundingBoxAscent") && has("fontBoundingBoxDescent")).then_some(ctx)
}

struct Inner {
    id: u32,
    me: Weak<RefCell<Inner>>,
    document: Document,
    /// `.xterm-screen`: the canvas goes in here, and atlas glyphs are drawn inside it.
    container: HtmlElement,
    cols: u32,
    rows: u32,
    options: RendererOptions,
    colors: ColorSet,
    measure: Option<Measure>,
    char_size: (f64, f64),
    dims: Dimensions,
    dpr: f64,
    canvas: HtmlCanvasElement,
    gl: Gl,
    max_texture_size: f64,
    rects: Option<RectangleRenderer>,
    glyphs: Option<GlyphRenderer>,
    atlas: Option<Rc<RefCell<TextureAtlas>>>,
    model: RenderModel,
    cell: CellData,
    selection: SelectionModel,
    /// Named layers in the order they were first set.
    highlights: Vec<(String, Vec<Highlight>)>,
    resolved_highlights: Vec<ResolvedHighlight>,
    overlay: Vec<Rect>,
    focused: bool,
    blink: Option<Blink>,
    cursor: crate::engine::Cursor,
    cursor_row: i64,
    /// Resolved background of the last cell drawn (the glyph renderer clips glyphs where it changes).
    last_bg: u32,
    full_redraw: bool,
    dirty: BTreeSet<u32>,
    state: State,
    context_gone: bool,
    visible: bool,
    disposed: bool,
    restore_timeout: Option<Timeout>,
    recreate_timeout: Option<Timeout>,
    last_recreate: f64,
    recreate_gap: f64,
    context_listeners: Vec<Listener>,
    context_observer: Option<Observed>,
    listeners: Vec<Listener>,
    observers: Vec<Observed>,
    requests: Vec<RendererRequest>,
    log: Vec<RendererRequest>,
    wake: Rc<dyn Fn()>,
}

pub struct WebglRenderer {
    inner: Rc<RefCell<Inner>>,
}

impl WebglRenderer {
    /// Puts a canvas into `container` (`.xterm-screen`); `element` (`.xterm`) tells focus. `wake` asks the
    /// terminal for a frame; it must only schedule one.
    pub fn new(
        container: &HtmlElement,
        element: &HtmlElement,
        cols: u32,
        rows: u32,
        options: &RendererOptions,
        wake: Rc<dyn Fn()>,
    ) -> Result<Self, JsValue> {
        let document = container
            .owner_document()
            .ok_or("oxtty/xterm: the element is not in a document")?;
        let window = document
            .default_view()
            .ok_or("oxtty/xterm: the document has no window")?;
        let (canvas, gl) = new_context(&document)?;
        let measure = Measure::new(&document, container);
        let id = NEXT_ID.with(|n| n.replace(n.get() + 1));
        let focused = document
            .active_element()
            .is_some_and(|active| element.contains(Some(&active)));
        let inner = Rc::new(RefCell::new(Inner {
            id,
            me: Weak::new(),
            document: document.clone(),
            container: container.clone(),
            cols,
            rows,
            options: options.clone(),
            colors: ColorSet::new(&options.theme),
            measure,
            char_size: (0.0, 0.0),
            dims: Dimensions::default(),
            dpr: window.device_pixel_ratio(),
            canvas: canvas.clone(),
            gl: gl.clone(),
            max_texture_size: 0.0,
            rects: None,
            glyphs: None,
            atlas: None,
            model: RenderModel::default(),
            cell: CellData::default(),
            selection: SelectionModel::default(),
            highlights: Vec::new(),
            resolved_highlights: Vec::new(),
            overlay: Vec::new(),
            focused,
            blink: None,
            cursor: crate::engine::Cursor::default(),
            cursor_row: -1,
            last_bg: 0,
            full_redraw: true,
            dirty: BTreeSet::new(),
            state: State::Live,
            context_gone: false,
            visible: true,
            disposed: false,
            restore_timeout: None,
            recreate_timeout: None,
            last_recreate: f64::NEG_INFINITY,
            recreate_gap: 1000.0,
            context_listeners: Vec::new(),
            context_observer: None,
            listeners: Vec::new(),
            observers: Vec::new(),
            requests: Vec::new(),
            log: Vec::new(),
            wake,
        }));
        {
            let mut i = inner.borrow_mut();
            i.me = Rc::downgrade(&inner);
            i.measure_chars();
            i.install_context(canvas, gl);
        }
        RENDERERS.with(|r| r.borrow_mut().push(Rc::downgrade(&inner)));
        {
            let mut i = inner.borrow_mut();
            i.initialize_webgl_state();
            i.update_cursor_blink();
            i.listen(&window, &document, element);
        }
        Ok(Self { inner })
    }
}

impl Drop for WebglRenderer {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.try_borrow_mut() {
            inner.dispose();
        }
        RENDERERS.with(|r| {
            if let Ok(mut r) = r.try_borrow_mut() {
                r.retain(|w| w.strong_count() > 0 && !Weak::ptr_eq(w, &Rc::downgrade(&self.inner)));
            }
        });
    }
}

/// Runs `f` on the renderer behind `weak`, on a later task if it is borrowed now; nothing if it is gone.
fn with_inner(weak: &Weak<RefCell<Inner>>, f: impl FnOnce(&mut Inner) + 'static) {
    let Some(rc) = weak.upgrade() else { return };
    let Ok(mut inner) = rc.try_borrow_mut() else {
        let weak = weak.clone();
        timer::queue(move || with_inner(&weak, f));
        return;
    };
    if !inner.disposed {
        f(&mut inner);
    }
}

/// Every other live renderer, in creation order.
fn others(me: &Weak<RefCell<Inner>>) -> Vec<Rc<RefCell<Inner>>> {
    RENDERERS.with(|r| {
        r.borrow()
            .iter()
            .filter(|w| !Weak::ptr_eq(w, me))
            .filter_map(Weak::upgrade)
            .collect()
    })
}

fn new_context(document: &Document) -> Result<(HtmlCanvasElement, Gl), JsValue> {
    let canvas: HtmlCanvasElement = document.create_element("canvas")?.unchecked_into();
    let attributes = WebGlContextAttributes::new();
    attributes.set_antialias(false);
    attributes.set_depth(false);
    attributes.set_preserve_drawing_buffer(false);
    let gl: Gl = canvas
        .get_context_with_context_options("webgl2", &attributes)?
        .and_then(|c| c.dyn_into().ok())
        .ok_or("oxtty/xterm: WebGL2 is not supported")?;
    Ok((canvas, gl))
}

fn lose_context(gl: &Gl) {
    if let Ok(Some(ext)) = gl.get_extension("WEBGL_lose_context") {
        ext.unchecked_into::<WebglLoseContext>().lose_context();
    }
}

impl Inner {
    fn listen(&mut self, window: &web_sys::Window, document: &Document, element: &HtmlElement) {
        let weak = self.me.clone();
        let w = weak.clone();
        let fonts_loaded = Closure::<dyn FnMut(Event)>::new(move |_| {
            with_inner(&w, Inner::handle_fonts_loaded);
        });
        self.listeners.push(Listener::new(
            &document.fonts(),
            "loadingdone",
            fonts_loaded,
        ));
        let w = weak.clone();
        let resize = Closure::<dyn FnMut(Event)>::new(move |_| {
            with_inner(&w, |i| {
                i.check_device_pixel_ratio();
            });
        });
        self.listeners.push(Listener::new(window, "resize", resize));
        // Focus picks the cursor style and runs the blink; the textarea that takes focus is inside `element`
        let w = weak.clone();
        let focus_in =
            Closure::<dyn FnMut(Event)>::new(move |_| with_inner(&w, |i| i.set_focused(true)));
        self.listeners
            .push(Listener::new(element, "focusin", focus_in));
        let w = weak.clone();
        let el = element.clone();
        let focus_out = Closure::<dyn FnMut(Event)>::new(move |e: Event| {
            let inside = e
                .dyn_ref::<FocusEvent>()
                .and_then(FocusEvent::related_target)
                .and_then(|t| t.dyn_into::<web_sys::Node>().ok())
                .is_some_and(|node| el.contains(Some(&node)));
            with_inner(&w, move |i| i.set_focused(inside));
        });
        self.listeners
            .push(Listener::new(element, "focusout", focus_out));
        let w = weak;
        let visibility = Closure::<dyn FnMut(Array)>::new(move |entries: Array| {
            let last = entries.get(entries.length().saturating_sub(1));
            if let Some(entry) = last.dyn_ref::<IntersectionObserverEntry>() {
                let visible = entry.is_intersecting();
                with_inner(&w, move |i| i.handle_visibility(visible));
            }
        });
        if let Ok(observer) = IntersectionObserver::new(visibility.as_ref().unchecked_ref()) {
            observer.observe(&self.container);
            self.observers.push(Observed {
                observer: Observer::Intersection(observer),
                _closure: visibility,
            });
        }
    }

    fn measure_chars(&mut self) {
        if let Some(size) = self.measure.as_ref().and_then(|m| m.measure(&self.options)) {
            self.char_size = size;
        }
    }

    /// Makes `canvas` and `gl` this renderer's, replacing the current canvas in the DOM.
    fn install_context(&mut self, canvas: HtmlCanvasElement, gl: Gl) {
        // Over the browser's limit, getContext took the oldest context away. Nothing will restore it, so its
        // renderer waits to be handed a context instead of making a new one after the timeout, which would take
        // the next one's
        for other in others(&self.me) {
            if let Ok(mut r) = other.try_borrow_mut() {
                if r.state == State::Live && r.gl.is_context_lost() {
                    r.context_gone = true;
                }
            }
        }
        self.context_listeners.clear();
        self.context_observer = None;
        let weak = self.me.clone();
        let lost = Closure::<dyn FnMut(Event)>::new(move |e: Event| {
            // Allows the context to be restored
            e.prevent_default();
            with_inner(&weak, Inner::handle_context_lost);
        });
        let weak = self.me.clone();
        let restored = Closure::<dyn FnMut(Event)>::new(move |_| {
            with_inner(&weak, Inner::handle_context_restored)
        });
        self.context_listeners
            .push(Listener::new(&canvas, "webglcontextlost", lost));
        self.context_listeners
            .push(Listener::new(&canvas, "webglcontextrestored", restored));
        self.context_observer = self.observe_device_pixels(&canvas);
        if self.canvas.parent_element().is_some() && self.canvas != canvas {
            let _ = self.canvas.replace_with_with_node_1(&canvas);
        } else if canvas.parent_element().is_none() {
            let _ = self.container.append_child(&canvas);
        }
        self.max_texture_size = gl
            .get_parameter(Gl::MAX_TEXTURE_SIZE)
            .ok()
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        self.canvas = canvas;
        self.gl = gl;
        self.state = State::Live;
        self.context_gone = false;
    }

    /// `observeDevicePixelDimensions`: the canvas's exact device-pixel size, which corrects rounding at fractional
    /// devicePixelRatios.
    fn observe_device_pixels(&self, canvas: &HtmlCanvasElement) -> Option<Observed> {
        let weak = self.me.clone();
        let target: JsValue = canvas.clone().into();
        let observer_slot: Rc<RefCell<Option<ResizeObserver>>> = Rc::default();
        let slot = observer_slot.clone();
        let closure = Closure::<dyn FnMut(Array)>::new(move |entries: Array| {
            let entry = entries
                .iter()
                .find(|e| Reflect::get(e, &"target".into()).is_ok_and(|t| t == target));
            let Some(entry) = entry else { return };
            let Ok(sizes) = Reflect::get(&entry, &"devicePixelContentBoxSize".into()) else {
                return;
            };
            if sizes.is_undefined() {
                // Not supported by this browser
                if let Some(observer) = slot.borrow_mut().take() {
                    observer.disconnect();
                }
                return;
            }
            let size = Reflect::get(&sizes, &0.into()).unwrap_or(JsValue::UNDEFINED);
            let read = |key: &str| {
                Reflect::get(&size, &key.into())
                    .ok()
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0)
            };
            let (width, height) = (read("inlineSize"), read("blockSize"));
            // 0×0 while the canvas is hidden
            if width > 0.0 && height > 0.0 {
                with_inner(&weak, move |i| i.handle_device_pixels(width, height));
            }
        });
        let observer = ResizeObserver::new(closure.as_ref().unchecked_ref()).ok()?;
        let options = ResizeObserverOptions::new();
        options.set_box(ResizeObserverBoxOptions::DevicePixelContentBox);
        observer.observe_with_options(canvas, &options);
        *observer_slot.borrow_mut() = Some(observer.clone());
        Some(Observed {
            observer: Observer::Resize(observer),
            _closure: closure,
        })
    }

    fn request(&mut self, request: RendererRequest) {
        if self.log.len() >= LOG_LIMIT {
            self.log.remove(0);
        }
        self.log.push(request.clone());
        self.requests.push(request);
        (self.wake)();
    }

    fn request_redraw_all(&mut self) {
        self.full_redraw = true;
        self.request(RendererRequest::Redraw(Dirty::All));
    }

    fn request_redraw_rows(&mut self, rows: impl IntoIterator<Item = i64>) {
        let rows: Vec<u32> = rows
            .into_iter()
            .filter(|&y| y >= 0)
            .map(|y| y as u32)
            .collect();
        if rows.is_empty() {
            return;
        }
        self.dirty.extend(&rows);
        self.request(RendererRequest::Redraw(Dirty::Rows(rows)));
    }

    fn clear_model(&mut self, clear_glyphs: bool) {
        self.model.clear();
        if clear_glyphs {
            if let Some(g) = &mut self.glyphs {
                g.clear();
            }
        }
        self.full_redraw = true;
    }

    fn initialize_webgl_state(&mut self) {
        if let Some(mut r) = self.rects.take() {
            r.dispose();
        }
        if let Some(mut g) = self.glyphs.take() {
            g.dispose();
        }
        self.rects =
            RectangleRenderer::new(&self.gl, self.cols, self.rows, self.dims, &self.colors);
        self.glyphs = GlyphRenderer::new(&self.gl, self.cols, self.rows, self.dims);
        if let Some(g) = &mut self.glyphs {
            g.rescale_overlapping_glyphs = self.options.rescale_overlapping_glyphs;
        }
        self.handle_resize();
    }

    fn handle_resize(&mut self) {
        self.update_dimensions();
        self.model.resize(self.cols, self.rows);
        let d = self.dims;
        self.canvas.set_width(d.device_canvas.width as u32);
        self.canvas.set_height(d.device_canvas.height as u32);
        let style = self.canvas.style();
        let _ = style.set_property("width", &format!("{}px", d.css_canvas.width));
        let _ = style.set_property("height", &format!("{}px", d.css_canvas.height));
        let (cols, rows) = (self.cols, self.rows);
        if let Some(r) = &mut self.rects {
            r.resize(cols, rows);
            r.set_dimensions(d);
            r.handle_resize();
        }
        if let Some(g) = &mut self.glyphs {
            g.resize(cols, rows);
            g.set_dimensions(d);
            g.handle_resize();
        }
        self.refresh_char_atlas();
        // Resizing the glyph renderer cleared it already
        self.clear_model(false);
    }

    fn update_dimensions(&mut self) {
        let (char_w, char_h) = self.char_size;
        if char_w <= 0.0 || char_h <= 0.0 {
            return;
        }
        let (line_height, letter_spacing) = (self.options.line_height, self.options.letter_spacing);
        let dpr = self.dpr;
        let d = &mut self.dims;
        // Floored so atlas glyphs land on an integer grid and stay sharp
        d.device_char.width = (char_w * dpr).floor();
        // Ceiled so a fractional devicePixelRatio still leaves room for the glyph
        d.device_char.height = (char_h * dpr).ceil();
        d.device_cell.height = (d.device_char.height * line_height).floor();
        d.device_char.top = if line_height == 1.0 {
            0.0
        } else {
            super::color::js_round((d.device_cell.height - d.device_char.height) / 2.0)
        };
        d.device_cell.width = d.device_char.width + super::color::js_round(letter_spacing);
        d.device_char.left = (letter_spacing / 2.0).floor();
        d.device_canvas.height = self.rows as f64 * d.device_cell.height;
        d.device_canvas.width = self.cols as f64 * d.device_cell.width;
        // Rounded, not ceiled: devicePixelRatio is often slightly off (1.100000023841858)
        d.css_canvas.height = super::color::js_round(d.device_canvas.height / dpr);
        d.css_canvas.width = super::color::js_round(d.device_canvas.width / dpr);
        d.css_cell.height = d.device_cell.height / dpr;
        d.css_cell.width = d.device_cell.width / dpr;
    }

    fn refresh_char_atlas(&mut self) {
        let d = self.dims;
        if d.device_char.width <= 0.0 && d.device_char.height <= 0.0 {
            return;
        }
        let o = &self.options;
        let config = AtlasConfig {
            custom_glyphs: o.custom_glyphs,
            device_pixel_ratio: self.dpr,
            device_max_texture_size: self.max_texture_size,
            letter_spacing: o.letter_spacing,
            line_height: o.line_height,
            font_size: o.font_size,
            font_family: o.font_family.clone(),
            font_weight: o.font_weight.clone(),
            font_weight_bold: o.font_weight_bold.clone(),
            device_cell_width: d.device_cell.width,
            device_cell_height: d.device_cell.height,
            device_char_width: d.device_char.width,
            device_char_height: d.device_char.height,
            allow_transparency: o.allow_transparency,
            draw_bold_text_in_bright_colors: o.draw_bold_text_in_bright_colors,
            minimum_contrast_ratio: o.minimum_contrast_ratio,
            foreground: self.colors.foreground.clone(),
            background: self.colors.background.clone(),
            ansi: self.colors.ansi.clone(),
        };
        self.atlas = atlas::acquire(self.id, config, &self.document);
        if let (Some(g), Some(a)) = (&mut self.glyphs, &self.atlas) {
            g.set_atlas(a.clone());
        }
    }

    fn handle_fonts_loaded(&mut self) {
        let before = self.dims.css_cell;
        self.measure_chars();
        self.handle_resize();
        // Glyphs drawn before the font arrived are fallback glyphs
        if let Some(Ok(mut a)) = self.atlas.as_ref().map(|a| a.try_borrow_mut()) {
            a.clear_texture();
        }
        self.clear_model(true);
        if before != self.dims.css_cell {
            self.request(RendererRequest::DimensionsChanged);
        }
        self.request_redraw_all();
    }

    /// Zoom and moving to another screen change the canvas's device pixels; zoom also resizes the window.
    fn check_device_pixel_ratio(&mut self) -> bool {
        let dpr = self
            .document
            .default_view()
            .map_or(self.dpr, |w| w.device_pixel_ratio());
        if dpr == self.dpr {
            return false;
        }
        // New cell size and atlas
        self.dpr = dpr;
        self.handle_resize();
        self.request(RendererRequest::DimensionsChanged);
        self.request_redraw_all();
        true
    }

    fn handle_device_pixels(&mut self, width: f64, height: f64) {
        if self.check_device_pixel_ratio() {
            return;
        }
        // Keep the computed device size (an exact multiple of the cell) unless the real one differs
        if self.canvas.width() as f64 == width && self.canvas.height() as f64 == height {
            return;
        }
        self.canvas.set_width(width as u32);
        self.canvas.set_height(height as u32);
        self.request_redraw_all();
    }

    fn cursor_style(&self) -> CursorInactiveStyle {
        // Until the program sends DECSCUSR (or after `CSI 0 SP q`) the options decide
        if self.cursor.styled {
            return match self.cursor.shape {
                CursorShape::Block => CursorInactiveStyle::Block,
                CursorShape::Underline => CursorInactiveStyle::Underline,
                CursorShape::Bar => CursorInactiveStyle::Bar,
            };
        }
        match self.options.cursor_style {
            CursorStyle::Block => CursorInactiveStyle::Block,
            CursorStyle::Underline => CursorInactiveStyle::Underline,
            CursorStyle::Bar => CursorInactiveStyle::Bar,
        }
    }

    fn update_cursor_blink(&mut self) {
        let blink = if self.cursor.styled {
            self.cursor.blink
        } else {
            self.options.cursor_blink
        };
        if blink == self.blink.is_some() {
            return;
        }
        self.blink = blink.then(|| {
            let weak = self.me.clone();
            Blink::new(
                move || {
                    with_inner(&weak, |i| {
                        let row = i.cursor_row;
                        i.request_redraw_rows([row]);
                    })
                },
                self.focused,
            )
        });
        let row = self.cursor_row;
        self.request_redraw_rows([row]);
    }

    fn set_focused(&mut self, focused: bool) {
        if self.focused == focused {
            return;
        }
        self.focused = focused;
        if let Some(blink) = &self.blink {
            if focused {
                blink.resume();
            } else {
                blink.pause();
            }
        }
        // The cursor style and the selection colour both depend on focus
        self.request_redraw_all();
    }

    fn resolve_highlights(&mut self) {
        let mut resolved = Vec::new();
        let mut overlay = Vec::new();
        let d = self.dims;
        let (cw, ch) = (d.device_cell.width, d.device_cell.height);
        let line = self.dpr.max(1.0);
        for (_, layer) in &self.highlights {
            for h in layer {
                if h.row >= self.rows || h.start >= h.end {
                    continue;
                }
                let end = h.end.min(self.cols);
                let color = |c: &Option<String>| c.as_deref().and_then(css_to_color);
                let background = color(&h.background);
                let foreground = color(&h.foreground);
                resolved.push(ResolvedHighlight {
                    row: h.row,
                    start: h.start,
                    end,
                    background: background.as_ref().map(|c| c.rgba >> 8),
                    foreground: foreground.as_ref().map(|c| c.rgba >> 8),
                });
                let (x, y, w) = (
                    h.start as f64 * cw,
                    h.row as f64 * ch,
                    (end - h.start) as f64 * cw,
                );
                let rect = |x, y, width, height, color| Rect {
                    x,
                    y,
                    width,
                    height,
                    color,
                };
                if let Some(border) = color(&h.border) {
                    let c = css_floats(&super::color::opaque(&border));
                    overlay.push(rect(x, y, w, line, c));
                    overlay.push(rect(x, y + ch - line, w, line, c));
                    overlay.push(rect(x, y, line, ch, c));
                    overlay.push(rect(x + w - line, y, line, ch, c));
                }
                if h.underline {
                    let c = foreground
                        .as_ref()
                        .or(color(&h.border).as_ref())
                        .map_or_else(
                            || css_floats(&self.colors.foreground),
                            |c| css_floats(&super::color::opaque(c)),
                        );
                    overlay.push(rect(x, y + ch - line, w, line, c));
                }
            }
        }
        self.resolved_highlights = resolved;
        self.overlay = overlay;
    }

    fn render(&mut self, viewport: &Viewport, changed: &[u32], host_dirty: &Dirty) {
        let (cols, rows) = (self.cols, self.rows);
        if self.state != State::Live
            || self.glyphs.is_none()
            || self.rects.is_none()
            || viewport.cols != cols
            || viewport.rows != rows
        {
            return;
        }
        let cursor = viewport.cursor;
        if cursor.line != self.cursor.line || cursor.col != self.cursor.col {
            if let Some(blink) = &self.blink {
                blink.restart_blink_animation();
            }
        }
        let blink_changed = cursor.shape != self.cursor.shape
            || cursor.blink != self.cursor.blink
            || cursor.styled != self.cursor.styled;
        self.cursor = cursor;
        if blink_changed {
            self.update_cursor_blink();
        }

        let mut all = self.full_redraw || *host_dirty == Dirty::All;
        // The atlas merged pages (or there is none): rebuild the whole model
        if self.glyphs.as_ref().is_some_and(GlyphRenderer::begin_frame) {
            self.clear_model(true);
            all = true;
        }
        self.full_redraw = false;
        let lines: Vec<u32> = if all {
            (0..rows).collect()
        } else {
            let mut set = std::mem::take(&mut self.dirty);
            set.extend(changed);
            if let Dirty::Rows(r) = host_dirty {
                set.extend(r);
            }
            // The rows the cursor left and entered (the engine does not report cursor moves as damage)
            if self.cursor_row >= 0 {
                set.insert(self.cursor_row as u32);
            }
            if cursor.line >= 0 {
                set.insert(cursor.line as u32);
            }
            set.into_iter().filter(|&y| y < rows).collect()
        };
        self.dirty.clear();
        self.cursor_row = if cursor.visible {
            cursor.line as i64
        } else {
            -1
        };
        self.resolve_highlights();
        self.update_model(viewport, &lines);

        let (Some(rects), Some(glyphs)) = (&self.rects, &mut self.glyphs) else {
            return;
        };
        rects.render_backgrounds();
        glyphs.render(&self.model);
        rects.render_overlay();
        if self.blink.as_ref().is_none_or(Blink::is_cursor_visible) {
            rects.render_cursor();
        }
    }

    /// `WebglRenderer._updateModel` minus character joiners, reading cells from the viewport.
    fn update_model(&mut self, viewport: &Viewport, lines: &[u32]) {
        let cols = self.cols as usize;
        let cursor = viewport.cursor;
        let cursor_x = cursor.col.min(self.cols.saturating_sub(1));
        let cursor_style = if self.focused {
            self.cursor_style()
        } else {
            self.options.cursor_inactive_style
        };
        let cursor_visible =
            cursor.visible && self.blink.as_ref().is_none_or(Blink::is_cursor_visible);
        let mut last_cursor_x: i64 = -1;
        let mut model_updated = false;
        self.model.cursor = None;
        let stride = cols * 4;
        let mut extras: Vec<Option<usize>> = vec![None; cols];
        for &y in lines {
            let start = y as usize * stride;
            let Some(row) = viewport.cells.get(start..start + stride) else {
                continue;
            };
            let row_extras = viewport.extras.get(&y);
            extras.fill(None);
            if let Some(list) = row_extras {
                for (k, e) in list.iter().enumerate() {
                    if let Some(slot) = extras.get_mut(e.col as usize) {
                        *slot = Some(k);
                    }
                }
            }
            if let Some(len) = self.model.line_lengths.get_mut(y as usize) {
                *len = 0;
            }
            for (x, extra) in extras.iter().enumerate() {
                let last_bg = self.last_bg;
                let o = x * 4;
                let cell_words = &row[o..o + 4];
                if cell_words[3] & attr::WIDE != 0 {
                    atlas::record_wide(cell_words[0]);
                }
                let extra = extra.and_then(|k| row_extras.and_then(|l| l.get(k)));
                self.cell.load(
                    cell_words,
                    extra.and_then(|e| e.text.as_deref()),
                    extra.and_then(|e| e.underline_color).unwrap_or(0),
                );
                let mut code = self.cell.code;
                let i = (y as usize * cols + x) * RENDER_MODEL_INDICIES_PER_CELL;
                let mut result = resolve(
                    &self.cell,
                    x as u32,
                    y,
                    self.dims.device_cell.width,
                    &self.colors,
                    &self.selection,
                    &self.resolved_highlights,
                    self.focused,
                    self.options.font_size,
                    self.dpr,
                );

                // The cursor cell's colours
                if cursor_visible && y as i32 == cursor.line {
                    if x as u32 == cursor_x {
                        self.model.cursor = Some(CursorModel {
                            x: cursor_x,
                            y,
                            width: self.cell.width,
                            style: cursor_style,
                            cursor_width: self.options.cursor_width,
                            dpr: self.dpr,
                        });
                        last_cursor_x = cursor_x as i64 + self.cell.width as i64 - 1;
                    }
                    if cursor_style == CursorInactiveStyle::Block
                        && x as i64 >= cursor_x as i64
                        && x as i64 <= last_cursor_x
                    {
                        result.fg = CM_RGB | ((self.colors.cursor_accent.rgba >> 8) & RGB_MASK);
                        result.bg = CM_RGB | ((self.colors.cursor.rgba >> 8) & RGB_MASK);
                    }
                }
                self.last_bg = result.bg;

                if code != 0 {
                    if let Some(len) = self.model.line_lengths.get_mut(y as usize) {
                        *len = x as u32 + 1;
                    }
                }
                let Some(model) = self.model.cells.get_mut(i..i + 4) else {
                    continue;
                };
                // Nothing changed
                if model[0] == code
                    && model[RENDER_MODEL_BG_OFFSET] == result.bg
                    && model[RENDER_MODEL_FG_OFFSET] == result.fg
                    && model[RENDER_MODEL_EXT_OFFSET] == result.ext
                {
                    continue;
                }
                model_updated = true;
                let len16 = self.cell.utf16_len();
                // Combined characters are flagged so they are easily identified
                if len16 > 1 {
                    code |= COMBINED_CHAR_BIT_MASK;
                }
                model[0] = code;
                model[RENDER_MODEL_BG_OFFSET] = result.bg;
                model[RENDER_MODEL_FG_OFFSET] = result.fg;
                model[RENDER_MODEL_EXT_OFFSET] = result.ext;
                if let Some(glyphs) = &mut self.glyphs {
                    glyphs.update_cell(
                        x,
                        y as usize,
                        code,
                        result.bg,
                        result.fg,
                        result.ext,
                        &self.cell.chars,
                        len16,
                        self.cell.width,
                        last_bg,
                        Some(&self.container),
                    );
                }
            }
        }
        if let Some(rects) = &mut self.rects {
            if model_updated {
                rects.update_backgrounds(&self.model, &self.colors);
            }
            rects.update_cursor(self.model.cursor.as_ref());
            rects.update_overlay(&self.overlay);
        }
    }

    fn set_options(&mut self, options: &RendererOptions) {
        let old = std::mem::replace(&mut self.options, options.clone());
        if old == *options {
            return;
        }
        if old.theme != options.theme {
            self.colors = ColorSet::new(&options.theme);
            if let Some(r) = &mut self.rects {
                r.update_colors(&self.colors);
            }
        }
        if old.font_family != options.font_family || old.font_size != options.font_size {
            self.measure_chars();
        }
        if let Some(g) = &mut self.glyphs {
            g.rescale_overlapping_glyphs = options.rescale_overlapping_glyphs;
        }
        if old.font_family != options.font_family
            || old.font_size != options.font_size
            || old.line_height != options.line_height
            || old.letter_spacing != options.letter_spacing
        {
            self.handle_resize();
        } else {
            self.refresh_char_atlas();
            self.clear_model(true);
        }
        self.update_cursor_blink();
        self.request_redraw_all();
    }

    fn resize(&mut self, cols: u32, rows: u32) {
        self.cols = cols;
        self.rows = rows;
        self.handle_resize();
    }

    fn set_selection(&mut self, selection: Option<SelectionRange>) {
        let mut rows = BTreeSet::new();
        let mut add = |m: &SelectionModel| {
            if m.has_selection {
                rows.extend(m.capped_start_row..=m.capped_end_row);
            }
        };
        add(&self.selection);
        self.selection.update(self.rows, selection);
        add(&self.selection);
        self.request_redraw_rows(rows);
    }

    fn set_highlights(&mut self, layer: &str, highlights: Vec<Highlight>) {
        let mut rows: BTreeSet<i64> = BTreeSet::new();
        rows.extend(highlights.iter().map(|h| h.row as i64));
        match self.highlights.iter_mut().find(|(name, _)| name == layer) {
            Some((_, old)) => {
                rows.extend(old.iter().map(|h| h.row as i64));
                *old = highlights;
            }
            None => self.highlights.push((layer.to_string(), highlights)),
        }
        self.request_redraw_rows(rows);
    }

    fn dispose(&mut self) {
        if self.disposed {
            return;
        }
        self.disposed = true;
        self.restore_timeout = None;
        self.recreate_timeout = None;
        self.blink = None;
        self.listeners.clear();
        self.observers.clear();
        self.context_listeners.clear();
        self.context_observer = None;
        if let Some(mut r) = self.rects.take() {
            r.dispose();
        }
        if let Some(mut g) = self.glyphs.take() {
            g.dispose();
        }
        atlas::release(self.id);
        self.atlas = None;
        lose_context(&self.gl);
        self.canvas.remove();
        self.measure = None;
        // That freed a context
        let me = self.me.clone();
        RENDERERS.with(|r| {
            if let Ok(mut r) = r.try_borrow_mut() {
                r.retain(|w| w.strong_count() > 0 && !Weak::ptr_eq(w, &me));
            }
        });
        for other in others(&me) {
            if let Ok(mut r) = other.try_borrow_mut() {
                if r.state == State::Parked && r.visible && !r.disposed {
                    r.recreate();
                    break;
                }
            }
        }
    }

    fn handle_context_lost(&mut self) {
        if self.context_gone {
            self.park();
            return;
        }
        self.state = State::Lost;
        // Wait a few seconds for 'webglcontextrestored', then make a new context
        let weak = self.me.clone();
        self.restore_timeout = Some(Timeout::new(CONTEXT_RESTORE_TIMEOUT, move || {
            with_inner(&weak, |i| {
                i.restore_timeout = None;
                if !i.visible {
                    i.park();
                } else {
                    i.recreate_throttled();
                }
            })
        }));
    }

    fn handle_context_restored(&mut self) {
        self.restore_timeout = None;
        if self.state != State::Lost {
            return;
        }
        self.state = State::Live;
        // The atlas textures and the glyph renderer are gone with the context: rebuild them
        self.reacquire_atlas();
        self.initialize_webgl_state();
        self.request_redraw_all();
    }

    fn reacquire_atlas(&mut self) {
        atlas::release(self.id);
        self.atlas = None;
    }

    /// Waits without a context. A visible renderer takes one from a renderer out of view, if there is one.
    fn park(&mut self) {
        self.state = State::Parked;
        self.context_gone = false;
        if self.visible {
            self.take_context_from_hidden();
        }
    }

    fn take_context_from_hidden(&mut self) -> bool {
        for other in others(&self.me) {
            let Ok(mut r) = other.try_borrow_mut() else {
                continue;
            };
            if r.state == State::Live && !r.visible && !r.disposed {
                r.release();
                drop(r);
                self.recreate();
                return true;
            }
        }
        false
    }

    /// Gives the context back to the browser, which frees its slot right away.
    fn release(&mut self) {
        self.context_gone = true;
        self.state = State::Parked;
        lose_context(&self.gl);
    }

    fn handle_visibility(&mut self, visible: bool) {
        if visible == self.visible {
            return;
        }
        self.visible = visible;
        if visible && self.state == State::Parked {
            // The pane in view gets drawn, even if that takes the oldest context from another visible pane, which
            // then waits; that only happens again when visibility changes, so it cannot loop
            if !self.take_context_from_hidden() {
                self.recreate();
            }
        } else if !visible && self.state == State::Live {
            for other in others(&self.me) {
                let Ok(mut r) = other.try_borrow_mut() else {
                    continue;
                };
                if r.state == State::Parked && r.visible && !r.disposed {
                    self.release();
                    r.recreate();
                    return;
                }
            }
        }
    }

    /// Backs off when contexts keep getting lost (a driver that keeps resetting, or contexts outside oxtty taking
    /// turns).
    fn recreate_throttled(&mut self) {
        let wait = self.last_recreate + self.recreate_gap - timer::now();
        if wait <= 0.0 {
            self.recreate();
            return;
        }
        self.state = State::Parked;
        let weak = self.me.clone();
        self.recreate_timeout = Some(Timeout::new(wait.ceil() as i32, move || {
            with_inner(&weak, |i| {
                i.recreate_timeout = None;
                if i.state == State::Parked {
                    i.recreate();
                }
            })
        }));
    }

    fn recreate(&mut self) {
        let now = timer::now();
        self.recreate_gap = if now - self.last_recreate < 60_000.0 {
            (self.recreate_gap * 2.0).min(60_000.0)
        } else {
            1000.0
        };
        self.last_recreate = now;
        self.restore_timeout = None;
        self.recreate_timeout = None;
        self.reacquire_atlas();
        match new_context(&self.document) {
            Ok((canvas, gl)) => self.install_context(canvas, gl),
            Err(error) => {
                web_sys::console::warn_1(&error);
                self.state = State::Parked;
                return;
            }
        }
        self.initialize_webgl_state();
        self.request_redraw_all();
    }

    /// State for the tests; the requests are those since the last call.
    fn debug(&mut self) -> JsValue {
        let info = Object::new();
        let state = match self.state {
            State::Live => "live",
            State::Lost => "lost",
            State::Parked => "parked",
        };
        let set = |k: &str, v: JsValue| {
            let _ = Reflect::set(&info, &k.into(), &v);
        };
        set("state", state.into());
        set(
            "atlas",
            self.atlas
                .as_ref()
                .and_then(|a| a.try_borrow().ok().map(|a| a.id))
                .map_or(JsValue::NULL, JsValue::from),
        );
        set("liveAtlases", atlas::live_atlases().into());
        set("canvas", self.canvas.clone().into());
        set("focused", self.focused.into());
        let requests: Array = std::mem::take(&mut self.log)
            .iter()
            .map(|r| match r {
                RendererRequest::DimensionsChanged => JsValue::from("dimensions"),
                RendererRequest::Redraw(Dirty::All) => JsValue::from("all"),
                RendererRequest::Redraw(Dirty::Rows(rows)) => rows
                    .iter()
                    .map(|&y| JsValue::from(y))
                    .collect::<Array>()
                    .into(),
            })
            .collect();
        set("requests", requests.into());
        info.into()
    }
}

impl Renderer for WebglRenderer {
    fn dimensions(&self) -> Dimensions {
        self.inner.try_borrow().map(|i| i.dims).unwrap_or_default()
    }

    fn set_options(&mut self, options: &RendererOptions) {
        if let Ok(mut i) = self.inner.try_borrow_mut() {
            i.set_options(options);
        }
    }

    fn resize(&mut self, cols: u32, rows: u32) {
        if let Ok(mut i) = self.inner.try_borrow_mut() {
            i.resize(cols, rows);
        }
    }

    fn render(&mut self, viewport: &Viewport, changed: &[u32], dirty: &Dirty) {
        if let Ok(mut i) = self.inner.try_borrow_mut() {
            i.render(viewport, changed, dirty);
        }
    }

    fn set_selection(&mut self, selection: Option<SelectionRange>) {
        if let Ok(mut i) = self.inner.try_borrow_mut() {
            i.set_selection(selection);
        }
    }

    fn set_highlights(&mut self, layer: &str, highlights: Vec<Highlight>) {
        if let Ok(mut i) = self.inner.try_borrow_mut() {
            i.set_highlights(layer, highlights);
        }
    }

    fn set_focused(&mut self, focused: bool) {
        if let Ok(mut i) = self.inner.try_borrow_mut() {
            i.set_focused(focused);
        }
    }

    fn take_requests(&mut self) -> Vec<RendererRequest> {
        self.inner
            .try_borrow_mut()
            .map(|mut i| std::mem::take(&mut i.requests))
            .unwrap_or_default()
    }

    fn debug(&self) -> JsValue {
        self.inner
            .try_borrow_mut()
            .map(|mut i| i.debug())
            .unwrap_or(JsValue::UNDEFINED)
    }
}
