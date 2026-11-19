use std::collections::HashMap;
use std::sync::{Arc, Weak};

use cosmic_text::{Attrs, Buffer, Family, FontSystem, Metrics, Shaping, SwashCache, Wrap};
use gpui::{Bounds, Corners, Pixels, RenderImage, Window, fill, point, px, rgb, size};
use image::{Frame, RgbaImage};

use crate::editor::{Raster, Viewport};
use crate::engine::{Color, Region, State};

const TILE: u32 = 192;
const MAX_TILES: usize = 192;

#[derive(Default)]
pub struct CanvasCache {
    tiles: HashMap<(u32, u32, u32), Tile>,
    tab: u64,
    frame: u64,
    version: u64,
    pending_preview: Option<PendingCanvas>,
    pub last_uploads: usize,
    pub last_upload_bytes: usize,
}

struct PendingCanvas {
    dimensions: (u32, u32),
    layers: Vec<(bool, Weak<Vec<u8>>)>,
}

struct Tile {
    version: u64,
    seen: u64,
    width: u32,
    height: u32,
    swizzle: Vec<u8>,
    image: Arc<RenderImage>,
}

pub struct Scene {
    images: Vec<(Bounds<Pixels>, Arc<RenderImage>)>,
    paper: Bounds<Pixels>,
}

impl Scene {
    pub fn paint(self, viewport: Bounds<Pixels>, window: &mut Window) {
        window.paint_quad(fill(self.paper.intersect(&viewport), rgb(0xd8dce0)));
        for (bounds, image) in self.images {
            let _ = window.paint_image(viewport, bounds, Corners::default(), image, 0, false);
        }
    }
}

impl CanvasCache {
    pub fn prepare(
        &mut self,
        state: &State,
        tab: u64,
        version: u64,
        mut dirty: Option<Region>,
        pending: bool,
        view: Viewport,
        viewport: Bounds<Pixels>,
        window: &mut Window,
    ) -> Scene {
        let scale = view.zoom.max(0.01);
        let origin = point(
            viewport.origin.x + px(view.offset_x as f32),
            viewport.origin.y + px(view.offset_y as f32),
        );
        let draw_bounds = |x: u32, y: u32, w: u32, h: u32| {
            Bounds::new(
                point(
                    origin.x + px((f64::from(x) * scale) as f32),
                    origin.y + px((f64::from(y) * scale) as f32),
                ),
                size(
                    px((f64::from(w) * scale) as f32),
                    px((f64::from(h) * scale) as f32),
                ),
            )
        };
        let paper = draw_bounds(0, 0, state.width, state.height);
        let clip = paper.intersect(&viewport);
        let mut scene = Scene {
            paper,
            images: Vec::new(),
        };
        self.last_uploads = 0;
        self.last_upload_bytes = 0;
        if pending || self.pending_preview.is_some() {
            let dimensions = (state.width, state.height);
            let unchanged = self.tab == tab
                && self.pending_preview.as_ref().is_some_and(|preview| {
                    preview.dimensions == dimensions
                        && preview.layers.len() == state.layers.len()
                        && preview.layers.iter().zip(&state.layers).all(
                            |((visible, pixels), layer)| {
                                *visible == layer.visible
                                    && pixels.as_ptr() == Arc::as_ptr(&layer.pixels)
                            },
                        )
                });
            if !unchanged && self.tab == tab && version == self.version {
                // A settings change can request a repaint without advancing the editor's version.
                for tile in self.tiles.values_mut() {
                    tile.version = version.wrapping_sub(1);
                }
            }
            // Committing a pending edit can preserve the exact pixel storage already displayed.
            dirty = unchanged.then_some(Region {
                left: 0,
                top: 0,
                width: 0,
                height: 0,
            });
            if !pending {
                self.pending_preview = None;
            } else if !unchanged {
                self.pending_preview = Some(PendingCanvas {
                    dimensions,
                    layers: state
                        .layers
                        .iter()
                        .map(|layer| (layer.visible, Arc::downgrade(&layer.pixels)))
                        .collect(),
                });
            }
        }
        if self.tab != tab {
            for (_, tile) in self.tiles.drain() {
                let _ = window.drop_image(tile.image);
            }
            self.tab = tab;
        } else if let Some(dirty) = dirty {
            for (&(x, y, factor), tile) in &mut self.tiles {
                let step = TILE * factor;
                let outside = dirty.width == 0
                    || dirty.height == 0
                    || x >= dirty.left + dirty.width
                    || y >= dirty.top + dirty.height
                    || x + step <= dirty.left
                    || y + step <= dirty.top;
                if tile.version == self.version && outside {
                    tile.version = version;
                }
            }
        }
        self.version = version;
        if clip.size.width <= px(0.) || clip.size.height <= px(0.) {
            return scene;
        }
        self.frame = self.frame.wrapping_add(1);
        let factor = ((1.0 / scale).floor() as u32)
            .clamp(1, 16)
            .next_power_of_two();
        let step = TILE * factor;
        let start_x =
            (f64::from(f32::from(clip.origin.x - origin.x)) / scale).max(0.) as u32 / step * step;
        let start_y =
            (f64::from(f32::from(clip.origin.y - origin.y)) / scale).max(0.) as u32 / step * step;
        let end_x = ((f64::from(f32::from(clip.origin.x + clip.size.width - origin.x)) / scale)
            .ceil() as u32)
            .min(state.width);
        let end_y = ((f64::from(f32::from(clip.origin.y + clip.size.height - origin.y)) / scale)
            .ceil() as u32)
            .min(state.height);
        for y in (start_y..end_y).step_by(step as usize) {
            for x in (start_x..end_x).step_by(step as usize) {
                let width = step.min(state.width - x);
                let height = step.min(state.height - y);
                let key = (x, y, factor);
                let current = self
                    .tiles
                    .get(&key)
                    .is_some_and(|tile| tile.version == version);
                if !current {
                    if state.validate().is_err() {
                        continue;
                    }
                    let image_width = width.div_ceil(factor);
                    let image_height = height.div_ceil(factor);
                    let pixels = checker_bgra(state, x, y, width, height, factor);
                    if self.tiles.get(&key).is_some_and(|tile| {
                        tile.width == image_width
                            && tile.height == image_height
                            && tile.swizzle == pixels
                    }) {
                        self.tiles.get_mut(&key).unwrap().version = version;
                    } else if let Some(rgba) =
                        RgbaImage::from_raw(image_width, image_height, pixels.clone())
                    {
                        self.last_uploads += 1;
                        self.last_upload_bytes += pixels.len();
                        let image =
                            Arc::new(RenderImage::new(smallvec::smallvec![Frame::new(rgba)]));
                        if let Some(old) = self.tiles.insert(
                            key,
                            Tile {
                                version,
                                seen: self.frame,
                                width: image_width,
                                height: image_height,
                                swizzle: pixels,
                                image,
                            },
                        ) {
                            let _ = window.drop_image(old.image);
                        }
                    }
                }
                if let Some(tile) = self.tiles.get_mut(&key) {
                    tile.seen = self.frame;
                    scene
                        .images
                        .push((draw_bounds(x, y, width, height), tile.image.clone()));
                }
            }
        }
        if self.tiles.len() > MAX_TILES {
            self.tiles.retain(|_, tile| {
                let retain = tile.seen == self.frame;
                if !retain {
                    let _ = window.drop_image(tile.image.clone());
                }
                retain
            });
        }
        scene
    }
}

fn checker_bgra(
    state: &State,
    left: u32,
    top: u32,
    width: u32,
    height: u32,
    factor: u32,
) -> Vec<u8> {
    let row_bytes = width.div_ceil(factor) as usize * 4;
    let mut pixels = vec![0; row_bytes * height.div_ceil(factor) as usize];
    for (row, target) in pixels.chunks_exact_mut(row_bytes).enumerate() {
        let y = top + row as u32 * factor;
        state.composite_row(left, y, factor as usize, target);
        for (column, pixel) in target.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            let x = left + column as u32 * factor;
            let alpha = u32::from(pixel[3]);
            let background = if (y / 12 + x / 12).is_multiple_of(2) {
                [221, 224, 229]
            } else {
                [255, 255, 255]
            };
            let blend = |channel: usize| {
                ((u32::from(pixel[channel]) * alpha + background[channel] * (255 - alpha) + 127)
                    / 255) as u8
            };
            *pixel = [blend(2), blend(1), blend(0), 255];
        }
    }
    pixels
}

#[derive(Clone, PartialEq)]
pub struct TextStyle {
    pub family: String,
    pub size: f32,
    pub bold: bool,
    pub italic: bool,
    pub color: Color,
}

pub struct TextRasterizer {
    font_system: FontSystem,
    cache: SwashCache,
}

impl TextRasterizer {
    pub fn new() -> Self {
        Self {
            font_system: FontSystem::new(),
            cache: SwashCache::new(),
        }
    }

    pub fn raster(&mut self, text: &str, style: &TextStyle) -> Option<Raster> {
        if text.is_empty() || text.len() > 8192 {
            return None;
        }
        let line_height = (style.size * 1.25).ceil();
        let mut buffer = Buffer::new(&mut self.font_system, Metrics::new(style.size, line_height));
        buffer.set_wrap(&mut self.font_system, Wrap::None);
        let attrs = Attrs::new()
            .family(if style.family.is_empty() {
                Family::SansSerif
            } else {
                Family::Name(&style.family)
            })
            .weight(if style.bold {
                cosmic_text::Weight::BOLD
            } else {
                cosmic_text::Weight::NORMAL
            })
            .style(if style.italic {
                cosmic_text::Style::Italic
            } else {
                cosmic_text::Style::Normal
            });
        buffer.set_text(&mut self.font_system, text, &attrs, Shaping::Advanced, None);
        buffer.shape_until_scroll(&mut self.font_system, false);
        let width = (buffer
            .layout_runs()
            .map(|run| run.line_w)
            .fold(1., f32::max)
            + style.size * 0.3)
            .ceil() as u32;
        let height = ((buffer.layout_runs().count() as f32 + 0.3) * line_height).ceil() as u32;
        if u64::from(width) * u64::from(height) > 4_194_304 {
            return None;
        }
        let mut pixels = vec![0; width as usize * height as usize * 4];
        let [r, g, b, a] = style.color;
        buffer.draw(
            &mut self.font_system,
            &mut self.cache,
            cosmic_text::Color::rgba(r, g, b, a),
            |x, y, w, h, color| {
                for dy in 0..h {
                    for dx in 0..w {
                        let x = x + dx as i32;
                        let y = y + dy as i32;
                        if x >= 0 && y >= 0 && (x as u32) < width && (y as u32) < height {
                            let offset = (y as usize * width as usize + x as usize) * 4;
                            pixels[offset..offset + 4].copy_from_slice(&[
                                color.r(),
                                color.g(),
                                color.b(),
                                color.a(),
                            ]);
                        }
                    }
                }
            },
        );
        Some(Raster {
            width,
            height,
            pixels,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Layer;

    #[test]
    fn paint_tiles_match_full_composition_then_sampling() {
        let mut state = State::new(37, 29, [0; 4]).unwrap();
        for (i, pixel) in state
            .pixels_mut(0)
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .enumerate()
        {
            *pixel = [(i * 3) as u8, (i * 5) as u8, (i * 11) as u8, (i * 17) as u8];
        }
        let overlay = (0..37 * 29)
            .flat_map(|i| [231, (i * 21) as u8, 17, (i * 5) as u8])
            .collect();
        state
            .layers
            .push(Layer::new("overlay".into(), true, overlay));
        state
            .layers
            .push(Layer::new("hidden".into(), false, vec![255; 37 * 29 * 4]));
        let (left, top, width, height) = (3, 7, 31, 21);
        let full = state.composite_region(left, top, width, height).unwrap();
        for factor in [1, 2, 4, 8, 16] {
            let mut expected = Vec::new();
            for y in (0..height).step_by(factor as usize) {
                for x in (0..width).step_by(factor as usize) {
                    let offset = ((y * width + x) * 4) as usize;
                    let a = u32::from(full[offset + 3]);
                    let background = if ((top + y) / 12 + (left + x) / 12).is_multiple_of(2) {
                        [221, 224, 229]
                    } else {
                        [255, 255, 255]
                    };
                    for c in [2, 1, 0] {
                        expected.push(
                            ((u32::from(full[offset + c]) * a + background[c] * (255 - a) + 127)
                                / 255) as u8,
                        );
                    }
                    expected.push(255);
                }
            }
            assert_eq!(
                checker_bgra(&state, left, top, width, height, factor),
                expected
            );
        }
    }
}
