#[path = "format/png.rs"]
mod png;

use crate::engine::{
    Color, Layer, MAX_DIMENSION, MAX_INPUT_BYTES, MAX_LAYER_BYTES, MAX_PIXELS, State, validate_size,
};
use image::{
    AnimationDecoder, DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits,
    codecs::{gif::GifDecoder, jpeg::JpegEncoder},
};
use std::{borrow::Cow, io::Cursor};

pub use png::{decode_png, encode_png};

pub const PROJECT_MAGIC: &[u8; 8] = b"RPAINT01";

pub struct Raster {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExportFormat {
    Png,
    Jpeg,
    Bmp,
}

impl ExportFormat {
    pub fn extension(self) -> &'static str {
        self.extensions()[0]
    }

    pub fn extensions(self) -> &'static [&'static str] {
        match self {
            Self::Png => &["png"],
            Self::Jpeg => &["jpg", "jpeg"],
            Self::Bmp => &["bmp"],
        }
    }
}

fn pixel_buffer(bytes: usize) -> Result<Vec<u8>, String> {
    let mut pixels = Vec::new();
    pixels.try_reserve_exact(bytes).map_err(|e| e.to_string())?;
    pixels.resize(bytes, 0);
    Ok(pixels)
}

pub fn encode_project(state: &State) -> Result<Vec<u8>, String> {
    state.validate()?;
    let mut bytes = PROJECT_MAGIC.to_vec();
    let [r, g, b, a] = state.background;
    for value in [
        state.width,
        state.height,
        state.layers.len() as u32,
        state.active as u32,
        u32::from_be_bytes([a, r, g, b]),
    ] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    for layer in &state.layers {
        let name = layer.name.as_bytes();
        if name.len() > 1024 || layer.name.encode_utf16().count() > 256 {
            return Err("레이어 이름 길이 오류".into());
        }
        let png = encode_png(state.width, state.height, &layer.pixels)?;
        if png.len() > MAX_LAYER_BYTES {
            return Err("레이어 출력은 140 MiB 이내여야 합니다.".into());
        }
        let additional = 9 + name.len() + png.len();
        if additional > MAX_INPUT_BYTES - bytes.len() {
            return Err("프로젝트 출력은 300 MiB 이내여야 합니다.".into());
        }
        bytes.try_reserve(additional).map_err(|e| e.to_string())?;
        bytes.extend_from_slice(&(name.len() as u32).to_le_bytes());
        bytes.extend_from_slice(name);
        bytes.push(u8::from(layer.visible));
        bytes.extend_from_slice(&(png.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&png);
    }
    Ok(bytes)
}

pub fn decode_project(bytes: &[u8]) -> Result<State, String> {
    if bytes.len() > MAX_INPUT_BYTES || bytes.len() < 28 || !bytes.starts_with(PROJECT_MAGIC) {
        return Err("올바른 프로젝트가 아닙니다.".into());
    }
    let mut remain = &bytes[8..];
    let width = project_u32(&mut remain)?;
    let height = project_u32(&mut remain)?;
    let count = project_u32(&mut remain)? as usize;
    let active = project_u32(&mut remain)? as usize;
    let [a, r, g, b] = project_u32(&mut remain)?.to_be_bytes();
    validate_size(width, height, count)?;
    if active >= count {
        return Err("활성 레이어 번호가 올바르지 않습니다.".into());
    }
    let mut layers = Vec::with_capacity(count);
    for _ in 0..count {
        let length = project_u32(&mut remain)? as usize;
        if length > 1024 {
            return Err("레이어 이름 길이 오류".into());
        }
        let (name, rest) = remain.split_at_checked(length).ok_or("잘린 레이어 이름")?;
        let name = std::str::from_utf8(name).map_err(|_| "레이어 이름이 올바르지 않습니다.")?;
        if name.encode_utf16().count() > 256 {
            return Err("레이어 이름 길이 오류".into());
        }
        let (&visible, rest) = rest.split_first().ok_or("잘린 레이어 레코드")?;
        remain = rest;
        let length = project_u32(&mut remain)? as usize;
        if visible > 1 || length == 0 || length > MAX_LAYER_BYTES {
            return Err("레이어 레코드 오류".into());
        }
        let (file, rest) = remain
            .split_at_checked(length)
            .ok_or("잘린 레이어 레코드")?;
        remain = rest;
        // Reject a larger embedded image before allocating its pixels.
        if file.get(16..20) != Some(width.to_be_bytes().as_slice())
            || file.get(20..24) != Some(height.to_be_bytes().as_slice())
        {
            return Err("레이어 크기 불일치".into());
        }
        let raster = decode_png(file)?;
        if raster.width != width || raster.height != height {
            return Err("레이어 크기 불일치".into());
        }
        layers.push(Layer::new(name.to_owned(), visible == 1, raster.pixels));
    }
    if !remain.is_empty() {
        return Err("프로젝트 뒤에 불필요한 데이터가 있습니다.".into());
    }
    let state = State {
        width,
        height,
        active,
        background: [r, g, b, a],
        layers,
    };
    state.validate()?;
    Ok(state)
}

fn project_u32(bytes: &mut &[u8]) -> Result<u32, String> {
    let (value, rest) = bytes.split_at_checked(4).ok_or("잘린 프로젝트")?;
    *bytes = rest;
    Ok(u32::from_le_bytes(value.try_into().unwrap()))
}

pub fn decode_artwork(bytes: &[u8]) -> Result<State, String> {
    if bytes.len() > MAX_INPUT_BYTES || bytes.len() < 8 {
        return Err("파일이 잘렸거나 300 MiB 한도를 넘었습니다.".into());
    }
    if bytes.starts_with(PROJECT_MAGIC) {
        return decode_project(bytes);
    }
    let image = if bytes.starts_with(png::SIGNATURE) {
        decode_png(bytes)?
    } else if bytes.starts_with(b"GIF") {
        decode_gif(bytes)?
    } else {
        let (kind, width, height) = if bytes.starts_with(b"BM") {
            let (width, height) = bmp_size(bytes)?;
            (ImageFormat::Bmp, width, height)
        } else if bytes.starts_with(&[255, 216]) {
            let (width, height) = jpeg_size(bytes)?;
            (ImageFormat::Jpeg, width, height)
        } else {
            return Err("PNG, JPEG, BMP, GIF, rpaint 파일만 열 수 있습니다.".into());
        };
        validate_size(width, height, 1)?;
        decode_image(bytes, kind)?
    };
    Ok(State {
        width: image.width,
        height: image.height,
        background: [255; 4],
        active: 0,
        layers: vec![Layer::new("이미지".into(), true, image.pixels)],
    })
}

fn bitmap_limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_PIXELS as u64 * 8);
    limits
}

fn decode_image(bytes: &[u8], kind: ImageFormat) -> Result<Raster, String> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), kind);
    reader.limits(bitmap_limits());
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let (width, height) = decoder.dimensions();
    validate_size(width, height, 1)?;
    let orientation = decoder.orientation().map_err(|e| e.to_string())?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    image.apply_orientation(orientation);
    let pixels = image.into_rgba8();
    let (width, height) = pixels.dimensions();
    Ok(Raster {
        width,
        height,
        pixels: pixels.into_raw(),
    })
}

fn bmp_size(bytes: &[u8]) -> Result<(u32, u32), String> {
    if bytes.len() < 26 {
        return Err("잘린 BMP".into());
    }
    let dib = u32::from_le_bytes(bytes[14..18].try_into().unwrap());
    if dib == 12 {
        Ok((
            u32::from(u16::from_le_bytes(bytes[18..20].try_into().unwrap())),
            u32::from(u16::from_le_bytes(bytes[20..22].try_into().unwrap())),
        ))
    } else {
        Ok((
            i32::from_le_bytes(bytes[18..22].try_into().unwrap()).unsigned_abs(),
            i32::from_le_bytes(bytes[22..26].try_into().unwrap()).unsigned_abs(),
        ))
    }
}

fn jpeg_size(bytes: &[u8]) -> Result<(u32, u32), String> {
    let mut position = 2;
    while bytes.len() - position >= 4 {
        if bytes[position] != 255 {
            return Err("JPEG 헤더 오류".into());
        }
        while bytes.get(position) == Some(&255) {
            position += 1;
        }
        let (&marker, post_marker) = bytes
            .get(position..)
            .and_then(|tail| tail.split_first())
            .ok_or("잘린 JPEG")?;
        position += 1;
        if matches!(marker, 217 | 218) {
            break;
        }
        if marker == 1 || (208..=215).contains(&marker) {
            continue;
        }
        let length = post_marker.first_chunk::<2>().ok_or("잘린 JPEG")?;
        let length = u16::from_be_bytes(*length) as usize;
        if length < 2 || length > post_marker.len() {
            return Err("잘린 JPEG".into());
        }
        if matches!(marker, 192..=195 | 197..=199 | 201..=203 | 205..=207) {
            if length < 8 {
                return Err("JPEG 크기 오류".into());
            }
            return Ok((
                u32::from(u16::from_be_bytes(post_marker[5..7].try_into().unwrap())),
                u32::from(u16::from_be_bytes(post_marker[3..5].try_into().unwrap())),
            ));
        }
        position += length;
    }
    Err("JPEG 이미지 크기를 읽을 수 없습니다.".into())
}

fn decode_gif(bytes: &[u8]) -> Result<Raster, String> {
    if bytes.len() < 13 || !(bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        return Err("GIF 헤더 오류".into());
    }
    let screen_width = u32::from(u16::from_le_bytes(bytes[6..8].try_into().unwrap()));
    let screen_height = u32::from(u16::from_le_bytes(bytes[8..10].try_into().unwrap()));
    validate_size(screen_width, screen_height, 1)?;
    let packed = bytes[10];
    let palette_bytes = if packed & 128 != 0 {
        3 * (2usize << (packed & 7))
    } else {
        0
    };
    let mut position = 13 + palette_bytes;
    let (width, height) = loop {
        let block = *bytes.get(position).ok_or("잘린 GIF")?;
        position += 1;
        if block == 0x2c {
            let frame = bytes.get(position..position + 9).ok_or("잘린 GIF 이미지")?;
            let x = u32::from(u16::from_le_bytes(frame[..2].try_into().unwrap()));
            let y = u32::from(u16::from_le_bytes(frame[2..4].try_into().unwrap()));
            let width = u32::from(u16::from_le_bytes(frame[4..6].try_into().unwrap()));
            let height = u32::from(u16::from_le_bytes(frame[6..8].try_into().unwrap()));
            validate_size(width, height, 1)?;
            break (screen_width.max(x + width), screen_height.max(y + height));
        }
        if block != 0x21 || position >= bytes.len() {
            return Err("GIF 이미지 헤더 오류".into());
        }
        position += 1;
        loop {
            let size = usize::from(*bytes.get(position).ok_or("잘린 GIF 확장 블록")?);
            position += 1 + size;
            if position > bytes.len() {
                return Err("잘린 GIF 확장 블록".into());
            }
            if size == 0 {
                break;
            }
        }
    };
    validate_size(width, height, 1)?;
    let mut data = Cow::Borrowed(bytes);
    if (width, height) != (screen_width, screen_height) {
        // The first frame may exceed the declared logical screen, as in Chromium.
        let header = data.to_mut();
        header[6..8].copy_from_slice(&(width as u16).to_le_bytes());
        header[8..10].copy_from_slice(&(height as u16).to_le_bytes());
    }
    let mut decoder = GifDecoder::new(Cursor::new(data)).map_err(|e| e.to_string())?;
    decoder
        .set_limits(bitmap_limits())
        .map_err(|e| e.to_string())?;
    let frame = decoder
        .into_frames()
        .next()
        .ok_or("GIF 첫 프레임이 없습니다.")?
        .map_err(|e| e.to_string())?;
    let pixels = frame.into_buffer();
    if pixels.dimensions() != (width, height) {
        return Err("GIF 첫 프레임 크기 불일치".into());
    }
    Ok(Raster {
        width,
        height,
        pixels: pixels.into_raw(),
    })
}

pub(crate) fn matte_pixel(pixel: Color, matte: Color) -> [u8; 3] {
    let alpha = u32::from(pixel[3]);
    std::array::from_fn(|channel| {
        ((u32::from(pixel[channel]) * alpha + u32::from(matte[channel]) * (255 - alpha) + 127)
            / 255) as u8
    })
}

pub fn export_image(state: &State, format: ExportFormat, matte: Color) -> Result<Vec<u8>, String> {
    let width = state.width;
    let height = state.height;
    if format == ExportFormat::Png {
        state.validate()?;
        return png::encode_png_rows(width, height, |row, target| {
            state.composite_row(0, row, 1, target);
        });
    }
    let pixels = state.composite()?;
    if format == ExportFormat::Bmp {
        let stride = width as usize * 4;
        let size = 54 + height as usize * stride;
        let mut bytes = pixel_buffer(size)?;
        bytes[..2].copy_from_slice(b"BM");
        bytes[2..6].copy_from_slice(&(size as u32).to_le_bytes());
        bytes[10..14].copy_from_slice(&54u32.to_le_bytes());
        bytes[14..18].copy_from_slice(&40u32.to_le_bytes());
        bytes[18..22].copy_from_slice(&width.to_le_bytes());
        bytes[22..26].copy_from_slice(&height.to_le_bytes());
        bytes[26..28].copy_from_slice(&1u16.to_le_bytes());
        bytes[28..30].copy_from_slice(&32u16.to_le_bytes());
        for (source, destination) in pixels
            .chunks_exact(stride)
            .rev()
            .zip(bytes[54..].chunks_exact_mut(stride))
        {
            for (&pixel, color) in source
                .as_chunks::<4>()
                .0
                .iter()
                .zip(destination.as_chunks_mut::<4>().0)
            {
                let [r, g, b] = matte_pixel(pixel, matte);
                *color = [b, g, r, 255];
            }
        }
        return Ok(bytes);
    }
    let mut rgb = pixel_buffer(width as usize * height as usize * 3)?;
    for (&pixel, color) in pixels
        .as_chunks::<4>()
        .0
        .iter()
        .zip(rgb.as_chunks_mut::<3>().0)
    {
        *color = matte_pixel(pixel, matte);
    }
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 95)
        .encode(&rgb, width, height, image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_INPUT_BYTES {
        return Err("JPEG 출력은 300 MiB 이내여야 합니다.".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use serde_json::Value;
    use sha2::{Digest, Sha256};

    #[test]
    fn decodes_the_frozen_qt_project_and_reencodes_its_pixels() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../web-app/tests/fixtures/qt-project.json"))
                .unwrap();
        let project = STANDARD
            .decode(fixture["projectBase64"].as_str().unwrap())
            .unwrap();
        let state = decode_project(&project).unwrap();
        assert_eq!(
            (state.width, state.height, state.active, state.background),
            (32, 24, 1, [0; 4])
        );
        assert_eq!(
            state
                .layers
                .iter()
                .map(|layer| layer.name.as_str())
                .collect::<Vec<_>>(),
            ["투명 배경", "반투명 레이어"]
        );
        assert_eq!(
            state
                .layers
                .iter()
                .map(|layer| layer.visible)
                .collect::<Vec<_>>(),
            [true, false]
        );
        // Qt's sidecar is captured before its premultiplied pixels are saved. The
        // exact decoded RGBA digest is from Studio's existing TypeScript reader.
        let studio_rgba = [
            "b66976ae436a5cfb3e58f89cea5866df71fa6bcad6ba5b2c4c87e3602f6ec6b7",
            "029d503626ee6bb50a20842229ec9ed4da12ad6252f54e2b2a4100aabc4e62a0",
        ];
        for (index, (layer, expected)) in state
            .layers
            .iter()
            .zip(fixture["rgbaBase64"].as_array().unwrap())
            .enumerate()
        {
            let rgba = STANDARD.decode(expected.as_str().unwrap()).unwrap();
            assert_eq!(
                format!("{:x}", Sha256::digest(&layer.pixels[..])),
                studio_rgba[index]
            );
            for (from_png, from_qt) in layer.pixels.chunks_exact(4).zip(rgba.chunks_exact(4)) {
                assert_eq!(from_png[3], from_qt[3]);
                for channel in 0..3 {
                    let premultiply = |pixel: &[u8]| {
                        (u16::from(pixel[channel]) * u16::from(pixel[3]) + 127) / 255
                    };
                    assert_eq!(premultiply(from_png), premultiply(from_qt));
                }
            }
        }
        let saved = encode_project(&state).unwrap();
        let reopened = decode_project(&saved).unwrap();
        for (before, after) in state.layers.iter().zip(&reopened.layers) {
            assert_eq!(
                (&before.name, before.visible, &before.pixels),
                (&after.name, after.visible, &after.pixels)
            );
        }
    }

    #[test]
    fn project_retains_transparent_rgb_and_rejects_bad_layer_dimensions() {
        let state = State {
            width: 1,
            height: 1,
            background: [1, 2, 3, 4],
            active: 0,
            layers: vec![Layer::new("투명 🎨".into(), false, vec![8, 76, 59, 0])],
        };
        let mut bytes = encode_project(&state).unwrap();
        let actual = decode_project(&bytes).unwrap();
        assert_eq!(&actual.layers[0].pixels[..], &[8, 76, 59, 0]);
        assert!(!actual.layers[0].visible);
        bytes[8..12].copy_from_slice(&MAX_DIMENSION.to_le_bytes());
        assert_eq!(
            decode_project(&bytes).err().as_deref(),
            Some("레이어 크기 불일치")
        );
    }

    #[test]
    fn matches_frozen_gif_first_frames_and_rejects_invalid_inputs() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../web-app/tests/fixtures/gif-input.json"))
                .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let bytes = STANDARD.decode(case["base64"].as_str().unwrap()).unwrap();
            if case["reject"].as_bool().unwrap_or(false) {
                assert!(decode_artwork(&bytes).is_err(), "{name}");
                continue;
            }
            let expected = &case["chromiumExpected"];
            let state = decode_artwork(&bytes).unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(
                u64::from(state.width),
                expected["width"].as_u64().unwrap(),
                "{name}"
            );
            assert_eq!(
                u64::from(state.height),
                expected["height"].as_u64().unwrap(),
                "{name}"
            );
            let mut rgba = Vec::new();
            for run in expected["rgbaRuns"].as_array().unwrap() {
                let run = run.as_array().unwrap();
                let color: Vec<u8> = run[1..].iter().map(|v| v.as_u64().unwrap() as u8).collect();
                for _ in 0..run[0].as_u64().unwrap() {
                    rgba.extend_from_slice(&color);
                }
            }
            assert_eq!(&state.layers[0].pixels[..], rgba, "{name}");
        }
    }

    #[test]
    fn jpeg_exif_orientation_preserves_the_decoded_pixels() {
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 95)
            .encode(
                &[
                    255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 255, 0, 255, 0, 255, 255,
                ],
                3,
                2,
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
        let original = decode_artwork(&jpeg).unwrap();
        for orientation in 0u16..=8 {
            let mut exif = b"Exif\0\0MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01".to_vec();
            exif.extend_from_slice(&orientation.to_be_bytes());
            exif.extend_from_slice(&[0; 6]);
            let mut source = vec![255, 216, 255, 225];
            source.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
            source.extend_from_slice(&exif);
            source.extend_from_slice(&jpeg[2..]);
            let oriented = decode_artwork(&source).unwrap();
            let (width, height) = if orientation >= 5 { (2, 3) } else { (3, 2) };
            assert_eq!((oriented.width, oriented.height), (width, height));
            for (index, original_pixel) in original.layers[0].pixels.chunks_exact(4).enumerate() {
                let (x, y) = (index % 3, index / 3);
                let (ox, oy) = match orientation {
                    2 => (2 - x, y),
                    3 => (2 - x, 1 - y),
                    4 => (x, 1 - y),
                    5 => (y, x),
                    6 => (1 - y, x),
                    7 => (1 - y, 2 - x),
                    8 => (y, 2 - x),
                    _ => (x, y),
                };
                let destination = (oy * width as usize + ox) * 4;
                assert_eq!(
                    &oriented.layers[0].pixels[destination..destination + 4],
                    original_pixel
                );
            }
        }
    }

    #[test]
    fn bmp_exports_bottom_up_with_an_opaque_matte() {
        let state = State {
            width: 1,
            height: 2,
            background: [0; 4],
            active: 0,
            layers: vec![Layer::new(
                "색상".into(),
                true,
                vec![255, 0, 0, 128, 0, 255, 0, 255],
            )],
        };
        let bmp = export_image(&state, ExportFormat::Bmp, [0, 0, 255, 8]).unwrap();
        assert_eq!(&bmp[54..], [0, 255, 0, 255, 127, 0, 128, 255]);
        let import = decode_artwork(&bmp).unwrap();
        assert_eq!(
            &import.layers[0].pixels[..],
            &[128, 0, 127, 255, 0, 255, 0, 255]
        );
    }
}
