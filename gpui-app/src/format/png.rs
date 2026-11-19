use super::{Raster, pixel_buffer};
use crate::engine::{MAX_INPUT_BYTES, validate_size};
use flate2::{Compression, write::ZlibEncoder};
use std::{io::Write, ops::Range};
use zlib_rs::{Inflate, InflateFlush, Status};

pub(super) const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

const ADAM7: [(usize, usize, usize, usize); 7] = [
    (0, 0, 8, 8),
    (4, 0, 8, 8),
    (0, 4, 4, 8),
    (2, 0, 4, 4),
    (0, 2, 2, 4),
    (1, 0, 2, 2),
    (0, 1, 1, 2),
];

pub fn encode_png(width: u32, height: u32, pixels: &[u8]) -> Result<Vec<u8>, String> {
    validate_size(width, height, 1)?;
    let stride = width as usize * 4;
    if pixels.len() != stride * height as usize {
        return Err("픽셀 크기 불일치".into());
    }
    encode_png_rows(width, height, |row, target| {
        let start = row as usize * stride;
        target.copy_from_slice(&pixels[start..start + stride]);
    })
}

pub(super) fn encode_png_rows(
    width: u32,
    height: u32,
    mut fill_row: impl FnMut(u32, &mut [u8]),
) -> Result<Vec<u8>, String> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
    let mut row = pixel_buffer(width as usize * 4 + 1)?;
    for y in 0..height {
        fill_row(y, &mut row[1..]);
        encoder.write_all(&row).map_err(|e| e.to_string())?;
    }
    let data = encoder.finish().map_err(|e| e.to_string())?;
    let length = data.len() + 57;
    if length > MAX_INPUT_BYTES {
        return Err("PNG 출력은 300 MiB 이내여야 합니다.".into());
    }
    let mut header = [0; 13];
    header[..4].copy_from_slice(&width.to_be_bytes());
    header[4..8].copy_from_slice(&height.to_be_bytes());
    header[8] = 8;
    header[9] = 6;
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(length).map_err(|e| e.to_string())?;
    bytes.extend_from_slice(SIGNATURE);
    write_chunk(&mut bytes, b"IHDR", &header);
    write_chunk(&mut bytes, b"IDAT", &data);
    write_chunk(&mut bytes, b"IEND", &[]);
    Ok(bytes)
}

fn write_chunk(output: &mut Vec<u8>, name: &[u8; 4], data: &[u8]) {
    output.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let start = output.len();
    output.extend_from_slice(name);
    output.extend_from_slice(data);
    output.extend_from_slice(&crc32fast::hash(&output[start..]).to_be_bytes());
}

struct ImageHeader<'a> {
    width: u32,
    height: u32,
    depth: usize,
    color_type: u8,
    channels: usize,
    interlaced: bool,
    palette: Option<&'a [u8]>,
    transparency: Option<&'a [u8]>,
    data: Range<usize>,
}

fn image_header(bytes: &[u8]) -> Result<ImageHeader<'_>, String> {
    if bytes.len() > MAX_INPUT_BYTES || bytes.len() < 33 || !bytes.starts_with(SIGNATURE) {
        return Err("올바른 PNG 파일이 아닙니다.".into());
    }
    let mut header = ImageHeader {
        width: 0,
        height: 0,
        depth: 0,
        color_type: 255,
        channels: 0,
        interlaced: false,
        palette: None,
        transparency: None,
        data: 0..0,
    };
    let mut offset = 8;
    let (mut started, mut ended, mut complete) = (false, false, false);
    while bytes.len() - offset >= 12 {
        let size = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        if size > bytes.len() - offset - 12 {
            return Err("잘린 PNG 데이터".into());
        }
        let name = &bytes[offset + 4..offset + 8];
        let data = &bytes[offset + 8..offset + 8 + size];
        let next = offset + size + 12;
        if !name.iter().all(u8::is_ascii_alphabetic) || (offset == 8 && name != b"IHDR") {
            return Err("PNG 청크 이름 또는 순서 오류".into());
        }
        if crc32fast::hash(&bytes[offset + 4..next - 4])
            != u32::from_be_bytes(bytes[next - 4..next].try_into().unwrap())
        {
            return Err("PNG 체크섬 오류".into());
        }
        if started && name != b"IDAT" {
            ended = true;
        }
        match name {
            b"IHDR" => {
                if offset != 8 || size != 13 {
                    return Err("PNG 헤더 오류".into());
                }
                header.width = u32::from_be_bytes(data[..4].try_into().unwrap());
                header.height = u32::from_be_bytes(data[4..8].try_into().unwrap());
                validate_size(header.width, header.height, 1)?;
                header.depth = data[8] as usize;
                header.color_type = data[9];
                header.channels = match header.color_type {
                    0 | 3 => 1,
                    2 => 3,
                    4 => 2,
                    6 => 4,
                    _ => return Err("지원하지 않는 PNG 색상 형식".into()),
                };
                if data[10] != 0 || data[11] != 0 || data[12] > 1 {
                    return Err("지원하지 않는 PNG 구성".into());
                }
                header.interlaced = data[12] != 0;
                if !matches!(header.depth, 1 | 2 | 4 | 8 | 16)
                    || (matches!(header.color_type, 2 | 4 | 6) && header.depth < 8)
                    || (header.color_type == 3 && header.depth > 8)
                {
                    return Err("PNG 형식이 올바르지 않습니다.".into());
                }
            }
            b"PLTE" => {
                if header.palette.is_some()
                    || started
                    || header.transparency.is_some()
                    || matches!(header.color_type, 0 | 4)
                    || !(3..=768).contains(&size)
                    || !size.is_multiple_of(3)
                    || (header.color_type == 3 && size / 3 > 1 << header.depth)
                {
                    return Err("PNG 팔레트 구성 오류".into());
                }
                header.palette = Some(data);
            }
            b"tRNS" => {
                let valid = match header.color_type {
                    0 => size == 2,
                    2 => size == 6,
                    3 => header
                        .palette
                        .is_some_and(|palette| size <= palette.len() / 3),
                    _ => false,
                };
                if header.transparency.is_some() || started || !valid {
                    return Err("PNG 투명도 구성 오류".into());
                }
                header.transparency = Some(data);
            }
            b"IDAT" => {
                if ended || (header.color_type == 3 && header.palette.is_none()) {
                    return Err("PNG 이미지 청크 순서 오류".into());
                }
                if !started {
                    header.data.start = offset;
                    started = true;
                }
                header.data.end = next;
            }
            b"IEND" => {
                if !started || size != 0 {
                    return Err("PNG 종료 오류".into());
                }
                offset = next;
                complete = true;
                break;
            }
            _ if name[0].is_ascii_uppercase() => return Err("지원하지 않는 PNG 필수 청크".into()),
            _ => {}
        }
        offset = next;
    }
    if !complete || offset != bytes.len() {
        return Err("PNG 형식이 올바르지 않습니다.".into());
    }
    Ok(header)
}

// Scanlines own the output budget. Validated IDAT chunks are streamed in place even
// when the zlib header or checksum straddles chunk boundaries.
struct Inflator<'a> {
    zlib: Inflate,
    remaining_chunks: &'a [u8],
    input: &'a [u8],
    finished: bool,
}

impl Inflator<'_> {
    fn read(&mut self, output: &mut [u8]) -> Result<usize, String> {
        let mut written = 0;
        while written < output.len() && !self.finished {
            while self.input.is_empty() && !self.remaining_chunks.is_empty() {
                let size =
                    u32::from_be_bytes(self.remaining_chunks[..4].try_into().unwrap()) as usize;
                self.input = &self.remaining_chunks[8..8 + size];
                self.remaining_chunks = &self.remaining_chunks[12 + size..];
            }
            let in_before = self.zlib.total_in();
            let out_before = self.zlib.total_out();
            let status = self
                .zlib
                .decompress(self.input, &mut output[written..], InflateFlush::NoFlush)
                .map_err(|e| format!("PNG 압축 데이터 오류: {}", e.as_str()))?;
            let consumed = (self.zlib.total_in() - in_before) as usize;
            let produced = (self.zlib.total_out() - out_before) as usize;
            self.input = &self.input[consumed..];
            written += produced;
            self.finished = status == Status::StreamEnd;
            if !self.finished && consumed == 0 && produced == 0 {
                return Err("PNG 해제 길이 오류".into());
            }
        }
        Ok(written)
    }
}

pub fn decode_png(bytes: &[u8]) -> Result<Raster, String> {
    let header = image_header(bytes)?;
    let mut data = Inflator {
        zlib: Inflate::new(true, 15),
        remaining_chunks: &bytes[header.data.clone()],
        input: &[],
        finished: false,
    };
    let width = header.width as usize;
    let height = header.height as usize;
    let depth = header.depth;
    let channels = header.channels;
    let mut pixels = pixel_buffer(width * height * 4)?;
    let passes: &[_] = if header.interlaced {
        &ADAM7
    } else {
        &[(0, 0, 1, 1)]
    };
    let filter_stride = (depth * channels).div_ceil(8);
    let sample_max = ((1u32 << depth) - 1) as u16;
    let transparency = header.transparency.unwrap_or_default();
    let mut transparent_color = [0; 3];
    for (value, bytes) in transparent_color
        .iter_mut()
        .zip(transparency.chunks_exact(2))
    {
        *value = u16::from_be_bytes(bytes.try_into().unwrap()) & sample_max;
    }
    for &(ox, oy, dx, dy) in passes {
        let w = width.saturating_sub(ox).div_ceil(dx);
        let h = height.saturating_sub(oy).div_ceil(dy);
        if w == 0 || h == 0 {
            continue;
        }
        let row_bytes = (w * channels * depth).div_ceil(8);
        let mut previous = pixel_buffer(row_bytes + 1)?;
        let mut scanline = pixel_buffer(row_bytes + 1)?;
        for y in 0..h {
            if data.read(&mut scanline)? != scanline.len() {
                return Err("PNG 해제 길이 오류".into());
            }
            let filter = scanline[0];
            let row = &mut scanline[1..];
            let above = &previous[1..];
            match filter {
                0 => {}
                1 => {
                    for i in filter_stride..row_bytes {
                        row[i] = row[i].wrapping_add(row[i - filter_stride]);
                    }
                }
                2 => {
                    for (value, &up) in row.iter_mut().zip(above) {
                        *value = value.wrapping_add(up);
                    }
                }
                3 => {
                    for (value, &up) in row[..filter_stride].iter_mut().zip(above) {
                        *value = value.wrapping_add(up / 2);
                    }
                    for i in filter_stride..row_bytes {
                        let left = row[i - filter_stride];
                        row[i] = row[i].wrapping_add(left.midpoint(above[i]));
                    }
                }
                4 => {
                    for (value, &up) in row[..filter_stride].iter_mut().zip(above) {
                        *value = value.wrapping_add(up);
                    }
                    for i in filter_stride..row_bytes {
                        let left = row[i - filter_stride];
                        row[i] =
                            row[i].wrapping_add(paeth(left, above[i], above[i - filter_stride]));
                    }
                }
                _ => return Err("PNG 필터 오류".into()),
            }
            if !header.interlaced && header.color_type == 6 && depth == 8 {
                pixels[y * width * 4..(y + 1) * width * 4].copy_from_slice(row);
                std::mem::swap(&mut scanline, &mut previous);
                continue;
            }
            for x in 0..w {
                let mut samples = [0u16; 4];
                for (c, sample) in samples[..channels].iter_mut().enumerate() {
                    let bit = (x * channels + c) * depth;
                    let byte = bit / 8;
                    *sample = match depth {
                        16 => u16::from_be_bytes([row[byte], row[byte + 1]]),
                        8 => u16::from(row[byte]),
                        _ => (u16::from(row[byte]) >> (8 - depth - bit % 8)) & sample_max,
                    };
                }
                let scaled = |sample: u16| {
                    ((u32::from(sample) * 255 + u32::from(sample_max) / 2) / u32::from(sample_max))
                        as u8
                };
                let grayscale = matches!(header.color_type, 0 | 4);
                let rgba = if let Some(palette) = header.palette.filter(|_| header.color_type == 3)
                {
                    let index = usize::from(samples[0]);
                    let rgb = palette
                        .get(index * 3..index * 3 + 3)
                        .ok_or("PNG 팔레트 오류")?;
                    [
                        rgb[0],
                        rgb[1],
                        rgb[2],
                        transparency.get(index).copied().unwrap_or(255),
                    ]
                } else {
                    let green = if grayscale { samples[0] } else { samples[1] };
                    let blue = if grayscale { samples[0] } else { samples[2] };
                    let alpha = if matches!(header.color_type, 4 | 6) {
                        scaled(samples[channels - 1])
                    } else if !transparency.is_empty()
                        && samples[..channels] == transparent_color[..channels]
                    {
                        0
                    } else {
                        255
                    };
                    [scaled(samples[0]), scaled(green), scaled(blue), alpha]
                };
                let index = ((oy + y * dy) * width + ox + x * dx) * 4;
                pixels[index..index + 4].copy_from_slice(&rgba);
            }
            std::mem::swap(&mut scanline, &mut previous);
        }
    }
    if data.read(&mut [0])? != 0 || !data.finished {
        return Err("PNG 해제 길이 오류".into());
    }
    Ok(Raster {
        width: header.width,
        height: header.height,
        pixels,
    })
}

fn paeth(left: u8, up: u8, upper_left: u8) -> u8 {
    let a = i16::from(left);
    let b = i16::from(up);
    let c = i16::from(upper_left);
    let estimate = a + b - c;
    let (da, db, dc) = (
        (estimate - a).abs(),
        (estimate - b).abs(),
        (estimate - c).abs(),
    );
    if da <= db && da <= dc {
        left
    } else if db <= dc {
        up
    } else {
        upper_left
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_scanline_filters_preserve_rgba_and_hidden_rgb() {
        let mut header = [0; 13];
        header[3] = 3;
        header[7] = 5;
        header[8] = 8;
        header[9] = 6;
        let pixels: Vec<_> = (0..15)
            .flat_map(|i| {
                [
                    (i * 19 + 3) as u8,
                    (209 - i * 9) as u8,
                    (i * 61) as u8,
                    (i * 128) as u8,
                ]
            })
            .collect();
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
        let mut above = [0; 12];
        for (filter, row) in pixels.chunks_exact(12).enumerate() {
            let mut encoded = [0; 13];
            encoded[0] = filter as u8;
            for (i, &value) in row.iter().enumerate() {
                let left = if i >= 4 { row[i - 4] } else { 0 };
                let upper_left = if i >= 4 { above[i - 4] } else { 0 };
                let predictor = match filter {
                    0 => 0,
                    1 => left,
                    2 => above[i],
                    3 => ((u16::from(left) + u16::from(above[i])) / 2) as u8,
                    _ => paeth(left, above[i], upper_left),
                };
                encoded[i + 1] = value.wrapping_sub(predictor);
            }
            encoder.write_all(&encoded).unwrap();
            above.copy_from_slice(row);
        }
        let mut file = SIGNATURE.to_vec();
        write_chunk(&mut file, b"IHDR", &header);
        write_chunk(&mut file, b"IDAT", &encoder.finish().unwrap());
        write_chunk(&mut file, b"IEND", &[]);
        assert_eq!(decode_png(&file).unwrap().pixels, pixels);
    }

    #[test]
    fn png_interleaved_rgba16_accepts_split_header_and_ignores_unused_idat() {
        let mut header = [0; 13];
        header[3] = 1;
        header[7] = 1;
        header[8] = 16;
        header[9] = 6;
        header[12] = 1;
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
        encoder
            .write_all(&[0, 0x80, 0x80, 0x11, 0x11, 0xff, 0xff, 0, 0])
            .unwrap();
        let compressed = encoder.finish().unwrap();
        let mut png = SIGNATURE.to_vec();
        write_chunk(&mut png, b"IHDR", &header);
        for byte in compressed {
            write_chunk(&mut png, b"IDAT", &[byte]);
        }
        write_chunk(&mut png, b"IDAT", &[0xff]);
        write_chunk(&mut png, b"IEND", &[]);
        assert_eq!(decode_png(&png).unwrap().pixels, [128, 17, 255, 0]);
    }

    #[test]
    fn png_stream_must_finish_with_exact_bytes_and_valid_checksum() {
        let image = encode_png(1, 1, &[1, 3, 7, 0]).unwrap();
        assert_eq!(decode_png(&image).unwrap().pixels, [1, 3, 7, 0]);
        let end = image.len() - 16;
        for wrong in [true, false] {
            let header = &image[16..29];
            let mut compressed = image[41..end].to_vec();
            if wrong {
                *compressed.last_mut().unwrap() ^= 1;
            } else {
                compressed.pop();
            }
            let mut file = SIGNATURE.to_vec();
            write_chunk(&mut file, b"IHDR", header);
            write_chunk(&mut file, b"IDAT", &compressed);
            write_chunk(&mut file, b"IEND", &[]);
            assert!(decode_png(&file).is_err());
        }
    }
}
