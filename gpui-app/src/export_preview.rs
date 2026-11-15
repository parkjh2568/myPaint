use std::sync::Arc;

use gpui::RenderImage;
use image::{Frame, RgbaImage};

use crate::{
    engine::{Color, State, source_over},
    format::{ExportFormat, matte_pixel},
};

const MAX_EDGE: u32 = 192;
const CHECKER_SIZE: u32 = 8;
pub const WHITE: Color = [255; 4];

pub struct ExportPreview {
    pub width: u32,
    pub height: u32,
    pixels: Vec<Color>,
}

impl ExportPreview {
    pub fn new(state: &State) -> Result<Self, String> {
        state.validate()?;
        let longest = state.width.max(state.height);
        let edge = MAX_EDGE.min(longest);
        let scale = |length: u32| ((length * edge + longest / 2) / longest).max(1);
        let width = scale(state.width);
        let height = scale(state.height);
        let source_x: Vec<_> = (0..width)
            .map(|x| sample_center(x, width, state.width) as usize * 4)
            .collect();
        let mut pixels = vec![[0; 4]; (width * height) as usize];
        for layer in state.layers.iter().filter(|layer| layer.visible) {
            for (y, row) in pixels.chunks_exact_mut(width as usize).enumerate() {
                let source_y = sample_center(y as u32, height, state.height);
                let offset = (source_y * state.width) as usize * 4;
                for (pixel, &x) in row.iter_mut().zip(&source_x) {
                    let origin = layer.pixels[offset + x..offset + x + 4]
                        .try_into()
                        .expect("validated RGBA layer");
                    source_over(pixel, origin);
                }
            }
        }
        Ok(Self {
            width,
            height,
            pixels,
        })
    }

    pub fn display_size(&self) -> (u32, u32) {
        let longest = self.width.max(self.height);
        let scale = |length: u32| ((length * MAX_EDGE + longest / 2) / longest).max(1);
        (scale(self.width), scale(self.height))
    }

    fn display_pixels(&self, format: ExportFormat, matte: Color) -> Vec<u8> {
        let (width, height) = self.display_size();
        let mut image = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            let source_y = sample_center(y, height, self.height);
            for x in 0..width {
                let source_x = sample_center(x, width, self.width);
                let pixel = self.pixels[(source_y * self.width + source_x) as usize];
                let background = if format == ExportFormat::Png {
                    let shade = if (x / CHECKER_SIZE + y / CHECKER_SIZE).is_multiple_of(2) {
                        255
                    } else {
                        221
                    };
                    [shade, shade, shade, 255]
                } else {
                    matte
                };
                let [r, g, b] = matte_pixel(pixel, background);
                image.extend_from_slice(&[b, g, r, 255]);
            }
        }
        image
    }

    pub fn image(&self, format: ExportFormat, matte: Color) -> Arc<RenderImage> {
        let bgra = self.display_pixels(format, matte);
        let (width, height) = self.display_size();
        let image = RgbaImage::from_raw(width, height, bgra)
            .expect("preview has one BGRA pixel per destination position");
        Arc::new(RenderImage::new(smallvec::smallvec![Frame::new(image)]))
    }
}

fn sample_center(index: u32, output: u32, input: u32) -> u32 {
    ((2 * index + 1) * input - 1) / (2 * output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        editor::{Editor, Raster},
        engine::Layer,
        format,
    };

    #[test]
    fn preview_composites_visible_layers_and_matches_export_matte() {
        let mut state = State::new(3, 1, [0; 4]).unwrap();
        state.pixels_mut(0)[..8].copy_from_slice(&[240, 40, 20, 128, 100, 50, 20, 255]);
        state.layers.push(Layer::new(
            "overlay".into(),
            true,
            vec![0, 0, 0, 0, 10, 100, 240, 128, 0, 0, 0, 0],
        ));
        state.layers.push(Layer::new(
            "hidden".into(),
            false,
            [0, 255, 0, 255].repeat(3),
        ));
        let preview = ExportPreview::new(&state).unwrap();
        let composited = state.composite().unwrap();
        assert_eq!(preview.pixels.as_flattened(), composited);

        let matte = [0, 0, 100, 255];
        let png = preview.display_pixels(ExportFormat::Png, matte);
        assert_eq!(&png[..4], &[137, 147, 247, 255]);
        assert_eq!(&png[128 * 4..129 * 4], &[255, 255, 255, 255]);
        assert_eq!(&png[136 * 4..137 * 4], &[221, 221, 221, 255]);
        let bmp = format::export_image(&state, ExportFormat::Bmp, matte).unwrap();
        let preview_bmp = preview.display_pixels(ExportFormat::Bmp, matte);
        assert_eq!(&preview_bmp[..4], &bmp[54..58]);
        assert_eq!(&preview_bmp[64 * 4..65 * 4], &bmp[58..62]);
        assert_eq!(&preview_bmp[128 * 4..129 * 4], &bmp[62..66]);
        assert_eq!(
            preview.display_pixels(ExportFormat::Jpeg, matte),
            preview_bmp
        );
        let encoded_png = format::export_image(&state, ExportFormat::Png, matte).unwrap();
        let decoded = image::load_from_memory(&encoded_png).unwrap().into_rgba8();
        assert_eq!(decoded.as_raw(), &composited);
    }

    #[test]
    fn preview_samples_a_bounded_centered_thumbnail() {
        let mut state = State::new(576, 288, [0; 4]).unwrap();
        assert_eq!(sample_center(0, 192, 576), 1);
        assert_eq!(sample_center(191, 192, 576), 574);
        let last_sample = (286 * 576 + 574) * 4;
        state.pixels_mut(0)[last_sample..last_sample + 4].copy_from_slice(&[23, 42, 36, 255]);
        let preview = ExportPreview::new(&state).unwrap();
        assert_eq!((preview.width, preview.height), (192, 96));
        assert_eq!(preview.pixels.len(), 192 * 96);
        assert_eq!(preview.pixels.last(), Some(&[23, 42, 36, 255]));
    }

    #[test]
    fn candidate_exports_pending_pixels_without_changing_document_or_redo() {
        let mut editor = Editor::new().unwrap();
        let document = editor.document().state().clone();
        let mut prior_edit = document.clone();
        prior_edit.pixels_mut(0)[..4].copy_from_slice(&[10, 20, 30, 255]);
        editor
            .document_mut()
            .commit_state("edit", prior_edit)
            .unwrap();
        assert!(editor.undo());
        let revision = editor.document().revision();
        assert!(editor.document().can_redo());
        editor
            .paste_raster(Raster {
                width: 1,
                height: 1,
                pixels: vec![200, 100, 50, 128],
            })
            .unwrap();
        let candidate = editor.export_candidate().unwrap();
        let preview = ExportPreview::new(&candidate).unwrap();
        drop(preview);
        let encoded = format::export_image(&candidate, ExportFormat::Png, WHITE).unwrap();
        let decoded = image::load_from_memory(&encoded).unwrap().into_rgba8();
        assert_eq!(decoded.get_pixel(0, 0).0, [200, 100, 50, 128]);
        assert!(editor.has_pending());
        assert_eq!(editor.document().state(), &document);
        assert_eq!(editor.document().revision(), revision);
        assert!(editor.document().can_redo());
    }
}
