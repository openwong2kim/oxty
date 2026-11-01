//! Draws the glyphs of the render model from the atlas pages, one instanced quad per cell.
//!
//! Ported from xterm.js 6.0.0 (commit f447274f430fd22513f6adbf9862d19524471c04, MIT):
//! `addons/addon-webgl/src/GlyphRenderer.ts` lines 15-390, and `allowRescaling`/`isEmoji`/`isNerdFontGlyph` of
//! `src/browser/renderer/shared/RendererUtils.ts` lines 25-66.
use std::cell::RefCell;
use std::rc::Rc;

use web_sys::{
    HtmlElement, WebGl2RenderingContext as Gl, WebGlBuffer, WebGlProgram, WebGlTexture,
    WebGlUniformLocation, WebGlVertexArrayObject,
};

use super::atlas::{self, is_powerline_glyph, TextureAtlas};
use super::gl::{buffer_f32, create_program, PROJECTION_MATRIX};
use super::model::RenderModel;
use super::Dimensions;

const UNIT_QUAD: u32 = 0;
const CELL_POSITION: u32 = 1;
const OFFSET: u32 = 2;
const SIZE: u32 = 3;
const TEXPAGE: u32 = 4;
const TEXCOORD: u32 = 5;
const TEXSIZE: u32 = 6;

const INDICES_PER_CELL: usize = 11;
const BYTES_PER_CELL: i32 = INDICES_PER_CELL as i32 * 4;
const CELL_POSITION_INDICES: usize = 2;

fn vertex_shader() -> String {
    format!(
        "#version 300 es
layout (location = {UNIT_QUAD}) in vec2 a_unitquad;
layout (location = {CELL_POSITION}) in vec2 a_cellpos;
layout (location = {OFFSET}) in vec2 a_offset;
layout (location = {SIZE}) in vec2 a_size;
layout (location = {TEXPAGE}) in float a_texpage;
layout (location = {TEXCOORD}) in vec2 a_texcoord;
layout (location = {TEXSIZE}) in vec2 a_texsize;

uniform mat4 u_projection;
uniform vec2 u_resolution;

out vec2 v_texcoord;
flat out int v_texpage;

void main() {{
  vec2 zeroToOne = (a_offset / u_resolution) + a_cellpos + (a_unitquad * a_size);
  gl_Position = u_projection * vec4(zeroToOne, 0.0, 1.0);
  v_texpage = int(a_texpage);
  v_texcoord = a_texcoord + a_unitquad * a_texsize;
}}"
    )
}

fn fragment_shader(units: u32) -> String {
    let mut conditionals = String::new();
    for i in 1..units {
        conditionals.push_str(&format!(
            " else if (v_texpage == {i}) {{ outColor = texture(u_texture[{i}], v_texcoord); }}"
        ));
    }
    format!(
        "#version 300 es
precision lowp float;

in vec2 v_texcoord;
flat in int v_texpage;

uniform sampler2D u_texture[{units}];

out vec4 outColor;

void main() {{
  if (v_texpage == 0) {{
    outColor = texture(u_texture[0], v_texcoord);
  }} {conditionals}
}}"
    )
}

fn is_emoji(c: u32) -> bool {
    (0x1f600..=0x1f64f).contains(&c)
        || (0x1f300..=0x1f5ff).contains(&c)
        || (0x1f680..=0x1f6ff).contains(&c)
        || (0x2600..=0x26ff).contains(&c)
        || (0x2700..=0x27bf).contains(&c)
        || (0xfe00..=0xfe0f).contains(&c)
        || (0x1f900..=0x1f9ff).contains(&c)
        || (0x1f1e6..=0x1f1ff).contains(&c)
}

fn allow_rescaling(code: u32, width: u32, glyph_width: f64, cell_width: f64) -> bool {
    width == 1
        // Overlapping by more than half a cell: barely overlapping glyphs stay readable as they are
        && glyph_width > (cell_width * 1.5).ceil()
        && code > 0xff
        && !is_emoji(code)
        && !is_powerline_glyph(code)
        && !(0xe000..=0xf8ff).contains(&code)
}

struct AtlasTexture {
    texture: WebGlTexture,
    version: i64,
}

pub struct GlyphRenderer {
    gl: Gl,
    program: WebGlProgram,
    vao: WebGlVertexArrayObject,
    resolution_location: WebGlUniformLocation,
    atlas_textures: Vec<AtlasTexture>,
    buffers: [WebGlBuffer; 3],
    atlas: Option<Rc<RefCell<TextureAtlas>>>,
    active_buffer: usize,
    attributes: Vec<f32>,
    /// Double buffered: the one the GPU may still read is not written next frame.
    attributes_buffers: [Vec<f32>; 2],
    count: usize,
    cols: usize,
    rows: usize,
    dims: Dimensions,
    pub rescale_overlapping_glyphs: bool,
}

impl GlyphRenderer {
    pub fn new(gl: &Gl, cols: u32, rows: u32, dims: Dimensions) -> Option<Self> {
        // Typically 8 or 16 texture units; almost every client supports 4096 px textures
        let units = gl
            .get_parameter(Gl::MAX_TEXTURE_IMAGE_UNITS)
            .ok()?
            .as_f64()?;
        let max_size = gl.get_parameter(Gl::MAX_TEXTURE_SIZE).ok()?.as_f64()?;
        if units < 1.0 || max_size < 1.0 {
            return None;
        }
        atlas::init_limits(units as u32, max_size as u32);
        let pages = atlas::max_atlas_pages()?;
        let program = create_program(gl, &vertex_shader(), &fragment_shader(pages))?;
        let projection = gl.get_uniform_location(&program, "u_projection")?;
        let resolution_location = gl.get_uniform_location(&program, "u_resolution")?;
        let texture_location = gl.get_uniform_location(&program, "u_texture")?;

        let vao = gl.create_vertex_array()?;
        gl.bind_vertex_array(Some(&vao));

        // The 4 vertices of a rectangle
        let unit_quad = gl.create_buffer()?;
        gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&unit_quad));
        buffer_f32(
            gl,
            Gl::ARRAY_BUFFER,
            &[0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0],
            Gl::STATIC_DRAW,
        );
        gl.enable_vertex_attrib_array(UNIT_QUAD);
        gl.vertex_attrib_pointer_with_i32(UNIT_QUAD, 2, Gl::FLOAT, false, 0, 0);

        // Two triangles from the 4 vertices, as a triangle strip
        let elements = gl.create_buffer()?;
        gl.bind_buffer(Gl::ELEMENT_ARRAY_BUFFER, Some(&elements));
        gl.buffer_data_with_u8_array(Gl::ELEMENT_ARRAY_BUFFER, &[0, 1, 2, 3], Gl::STATIC_DRAW);

        let attributes = gl.create_buffer()?;
        gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&attributes));
        for (location, size, offset) in [
            (OFFSET, 2, 0),
            (SIZE, 2, 2),
            (TEXPAGE, 1, 4),
            (TEXCOORD, 2, 5),
            (TEXSIZE, 2, 7),
            (CELL_POSITION, 2, 9),
        ] {
            gl.enable_vertex_attrib_array(location);
            gl.vertex_attrib_pointer_with_i32(
                location,
                size,
                Gl::FLOAT,
                false,
                BYTES_PER_CELL,
                offset * 4,
            );
            gl.vertex_attrib_divisor(location, 1);
        }

        gl.use_program(Some(&program));
        let units: Vec<i32> = (0..pages as i32).collect();
        gl.uniform1iv_with_i32_array(Some(&texture_location), &units);
        gl.uniform_matrix4fv_with_f32_array(Some(&projection), false, &PROJECTION_MATRIX);

        // 1×1 red textures for every page: a glyph drawn from a page that was never uploaded shows red
        let mut atlas_textures = Vec::new();
        for i in 0..pages {
            let texture = gl.create_texture()?;
            gl.active_texture(Gl::TEXTURE0 + i);
            gl.bind_texture(Gl::TEXTURE_2D, Some(&texture));
            gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_WRAP_S, Gl::CLAMP_TO_EDGE as i32);
            gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_WRAP_T, Gl::CLAMP_TO_EDGE as i32);
            let _ = gl.tex_image_2d_with_i32_and_i32_and_i32_and_format_and_type_and_opt_u8_array(
                Gl::TEXTURE_2D,
                0,
                Gl::RGBA as i32,
                1,
                1,
                0,
                Gl::RGBA,
                Gl::UNSIGNED_BYTE,
                Some(&[255, 0, 0, 255]),
            );
            atlas_textures.push(AtlasTexture {
                texture,
                version: -1,
            });
        }

        // Transparent glyph texture
        gl.enable(Gl::BLEND);
        gl.blend_func(Gl::SRC_ALPHA, Gl::ONE_MINUS_SRC_ALPHA);

        let mut renderer = Self {
            gl: gl.clone(),
            program,
            vao,
            resolution_location,
            atlas_textures,
            buffers: [unit_quad, elements, attributes],
            atlas: None,
            active_buffer: 0,
            attributes: Vec::new(),
            attributes_buffers: [Vec::new(), Vec::new()],
            count: 0,
            cols: cols as usize,
            rows: rows as usize,
            dims,
            rescale_overlapping_glyphs: false,
        };
        renderer.handle_resize();
        Some(renderer)
    }

    pub fn dispose(&mut self) {
        let gl = &self.gl;
        gl.delete_program(Some(&self.program));
        gl.delete_vertex_array(Some(&self.vao));
        for buffer in &self.buffers {
            gl.delete_buffer(Some(buffer));
        }
        for texture in &self.atlas_textures {
            gl.delete_texture(Some(&texture.texture));
        }
        self.atlas = None;
    }

    /// True when the model must be rebuilt (no atlas, or the atlas merged pages).
    pub fn begin_frame(&self) -> bool {
        self.atlas
            .as_ref()
            .is_none_or(|a| a.try_borrow().is_ok_and(|a| a.begin_frame()))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_cell(
        &mut self,
        x: usize,
        y: usize,
        code: u32,
        bg: u32,
        fg: u32,
        ext: u32,
        chars: &str,
        chars_len16: usize,
        width: u32,
        last_bg: u32,
        container: Option<&HtmlElement>,
    ) {
        let i = (y * self.cols + x) * INDICES_PER_CELL;
        let Some(cell) = self.attributes.get_mut(i..i + INDICES_PER_CELL) else {
            return;
        };
        // An empty cell draws nothing; a space continues (it may carry an underline or strikethrough)
        if code == 0 {
            cell[..INDICES_PER_CELL - 1 - CELL_POSITION_INDICES].fill(0.0);
            return;
        }
        let Some(atlas) = &self.atlas else { return };
        let Ok(mut atlas) = atlas.try_borrow_mut() else {
            return;
        };
        let glyph = if chars_len16 > 1 {
            atlas.get_rasterized_glyph_combined_char(chars, bg, fg, ext, container)
        } else {
            atlas.get_rasterized_glyph(code, bg, fg, ext, container)
        };
        let page_width = atlas.page_width(glyph.texture_page);
        let d = &self.dims;
        let left_cell_padding = ((d.device_cell.width - d.device_char.width) / 2.0).floor();
        let canvas = d.device_canvas;
        if bg != last_bg && glyph.offset.0 > left_cell_padding {
            // The glyph reaches into a cell with another background: clip its left side there
            let clipped = glyph.offset.0 - left_cell_padding;
            cell[0] = (-(glyph.offset.0 - clipped) + d.device_char.left) as f32;
            cell[1] = (-glyph.offset.1 + d.device_char.top) as f32;
            cell[2] = ((glyph.size.0 - clipped) / canvas.width) as f32;
            cell[3] = (glyph.size.1 / canvas.height) as f32;
            cell[4] = glyph.texture_page as f32;
            cell[5] = (glyph.texture_position_clip_space.0 + clipped / page_width) as f32;
            cell[6] = glyph.texture_position_clip_space.1 as f32;
            cell[7] = (glyph.size_clip_space.0 - clipped / page_width) as f32;
            cell[8] = glyph.size_clip_space.1 as f32;
        } else {
            cell[0] = (-glyph.offset.0 + d.device_char.left) as f32;
            cell[1] = (-glyph.offset.1 + d.device_char.top) as f32;
            cell[2] = (glyph.size.0 / canvas.width) as f32;
            cell[3] = (glyph.size.1 / canvas.height) as f32;
            cell[4] = glyph.texture_page as f32;
            cell[5] = glyph.texture_position_clip_space.0 as f32;
            cell[6] = glyph.texture_position_clip_space.1 as f32;
            cell[7] = glyph.size_clip_space.0 as f32;
            cell[8] = glyph.size_clip_space.1 as f32;
        }
        // a_cellpos only changes on resize

        // Narrow wide glyphs printed in one cell so they do not run into the next
        if self.rescale_overlapping_glyphs
            && allow_rescaling(code, width, glyph.size.0, d.device_cell.width)
        {
            // - 1 to improve readability
            cell[2] = ((d.device_cell.width - 1.0) / canvas.width) as f32;
        }
    }

    pub fn clear(&mut self) {
        let (cols, rows) = (self.cols, self.rows);
        let count = cols * rows * INDICES_PER_CELL;
        if self.count != count {
            self.attributes = vec![0.0; count];
            self.attributes_buffers = [vec![0.0; count], vec![0.0; count]];
        } else {
            self.attributes.fill(0.0);
            for b in &mut self.attributes_buffers {
                b.fill(0.0);
            }
        }
        self.count = count;
        let mut i = 0;
        for y in 0..rows {
            for x in 0..cols {
                self.attributes[i + 9] = x as f32 / cols as f32;
                self.attributes[i + 10] = y as f32 / rows as f32;
                i += INDICES_PER_CELL;
            }
        }
    }

    pub fn resize(&mut self, cols: u32, rows: u32) {
        self.cols = cols as usize;
        self.rows = rows as usize;
    }

    pub fn handle_resize(&mut self) {
        let gl = &self.gl;
        gl.use_program(Some(&self.program));
        let (width, height) = (gl.drawing_buffer_width(), gl.drawing_buffer_height());
        let (width, height) = canvas_size(gl).unwrap_or((width, height));
        gl.viewport(0, 0, width, height);
        gl.uniform2f(Some(&self.resolution_location), width as f32, height as f32);
        self.clear();
    }

    pub fn render(&mut self, model: &RenderModel) {
        let Some(atlas) = self.atlas.clone() else {
            return;
        };
        let Ok(atlas) = atlas.try_borrow() else {
            return;
        };
        let gl = &self.gl;
        gl.use_program(Some(&self.program));
        gl.bind_vertex_array(Some(&self.vao));

        // Alternate buffers each frame: the GPU may still be reading the last one
        self.active_buffer = (self.active_buffer + 1) % 2;
        let active = &mut self.attributes_buffers[self.active_buffer];
        // Each row up to its last non-blank cell, so trailing whitespace sends no vertices
        let mut length = 0;
        for (y, &line_length) in model.line_lengths.iter().enumerate() {
            let start = y * self.cols * INDICES_PER_CELL;
            let end = start + line_length as usize * INDICES_PER_CELL;
            let (Some(src), true) = (
                self.attributes.get(start..end),
                length + end - start <= active.len(),
            ) else {
                continue;
            };
            active[length..length + src.len()].copy_from_slice(src);
            length += src.len();
        }
        gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&self.buffers[2]));
        buffer_f32(gl, Gl::ARRAY_BUFFER, &active[..length], Gl::STREAM_DRAW);

        // Upload the atlas pages that changed
        for i in 0..atlas.page_count().min(self.atlas_textures.len()) {
            if atlas.page_version(i) as i64 != self.atlas_textures[i].version {
                let Some(canvas) = atlas.page_canvas(i) else {
                    continue;
                };
                gl.active_texture(Gl::TEXTURE0 + i as u32);
                gl.bind_texture(Gl::TEXTURE_2D, Some(&self.atlas_textures[i].texture));
                gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_WRAP_S, Gl::CLAMP_TO_EDGE as i32);
                gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_WRAP_T, Gl::CLAMP_TO_EDGE as i32);
                let _ = gl.tex_image_2d_with_u32_and_u32_and_html_canvas_element(
                    Gl::TEXTURE_2D,
                    0,
                    Gl::RGBA as i32,
                    Gl::RGBA,
                    Gl::UNSIGNED_BYTE,
                    canvas,
                );
                gl.generate_mipmap(Gl::TEXTURE_2D);
                self.atlas_textures[i].version = atlas.page_version(i) as i64;
            }
        }

        gl.draw_elements_instanced_with_i32(
            Gl::TRIANGLE_STRIP,
            4,
            Gl::UNSIGNED_BYTE,
            0,
            (length / INDICES_PER_CELL) as i32,
        );
    }

    pub fn set_atlas(&mut self, atlas: Rc<RefCell<TextureAtlas>>) {
        self.atlas = Some(atlas);
        for texture in &mut self.atlas_textures {
            texture.version = -1;
        }
    }

    pub fn set_dimensions(&mut self, dims: Dimensions) {
        self.dims = dims;
    }
}

/// `gl.canvas.width/height`, the size the canvas element was given.
pub fn canvas_size(gl: &Gl) -> Option<(i32, i32)> {
    use wasm_bindgen::JsCast;
    let canvas: web_sys::HtmlCanvasElement = gl.canvas()?.dyn_into().ok()?;
    Some((canvas.width() as i32, canvas.height() as i32))
}
