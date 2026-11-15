use super::{
    Color, EngineResult, Layer, PixelPatch, Rectangle, State, byte_round, fill_pixels, get_color,
    js_round, premultiplied, reserve_error, validate_size, zeroed,
};

pub fn snap_line_delta(dx: f64, dy: f64) -> (f64, f64) {
    let octant =
        (js_round(dy.atan2(dx) / std::f64::consts::FRAC_PI_4) as i32).rem_euclid(8) as usize;
    let length = dx.hypot(dy);
    let distance = if octant.is_multiple_of(2) {
        length
    } else {
        length / std::f64::consts::SQRT_2
    };
    let x = [1., 1., 0., -1., -1., -1., 0., 1.][octant] * distance;
    let y = [0., 1., 1., 1., 0., -1., -1., -1.][octant] * distance;
    (x, y)
}

#[derive(Clone, Copy)]
struct Edge {
    first_y: i64,
    end_y: i64,
    x: i64,
    step: i64,
}

pub fn polygon_mask(
    path: &[(f64, f64)],
    left: i32,
    top: i32,
    width: u32,
    height: u32,
) -> EngineResult<Vec<u8>> {
    validate_size(width, height, 1)?;
    const LIMIT: i64 = 8_388_607;
    const MAX_VERTICES: usize = 1_048_576;
    let (left, top, width, height) = (
        i64::from(left),
        i64::from(top),
        i64::from(width),
        i64::from(height),
    );
    if left.abs() + width > LIMIT || top.abs() + height > LIMIT || path.len() > MAX_VERTICES {
        return Err("선택 경로가 좌표 또는 꼭짓점 한도를 초과합니다.".into());
    }
    let mut needs_clip = false;
    for &(x, y) in path {
        let (x, y) = (x.floor(), y.floor());
        if !x.is_finite() || !y.is_finite() || x.abs().max(y.abs()) > LIMIT as f64 {
            return Err("선택 경로 좌표가 너무 큽니다.".into());
        }
        if x < (left - 1024) as f64
            || x > (left + width + 1024) as f64
            || y < (top - 1024) as f64
            || y > (top + height + 1024) as f64
        {
            needs_clip = true;
        }
    }

    let mut clipped = Vec::new();
    let vertices = if needs_clip {
        clipped
            .try_reserve_exact(path.len())
            .map_err(reserve_error)?;
        clipped.extend(path.iter().map(|(x, y)| (x.floor(), y.floor())));
        for (horizontal, edge, lower) in [
            (true, left, true),
            (true, left + width, false),
            (false, top, true),
            (false, top + height, false),
        ] {
            let bound = edge as f64;
            let coordinate = |(x, y): (f64, f64)| if horizontal { x } else { y };
            let inside = |value: f64| {
                if lower {
                    value >= bound
                } else {
                    value <= bound
                }
            };
            let mut next = Vec::new();
            next.try_reserve_exact(clipped.len().min(MAX_VERTICES))
                .map_err(reserve_error)?;
            for index in 0..clipped.len() {
                let a = clipped[index];
                let b = clipped[(index + 1) % clipped.len()];
                let (u, v) = (coordinate(a), coordinate(b));
                if inside(u) {
                    next.try_reserve(1).map_err(reserve_error)?;
                    next.push(a);
                }
                if inside(u) != inside(v) {
                    let ratio = (bound - u) / (v - u);
                    let intersection = if horizontal {
                        (bound, a.1 + (b.1 - a.1) * ratio)
                    } else {
                        (a.0 + (b.0 - a.0) * ratio, bound)
                    };
                    next.try_reserve(1).map_err(reserve_error)?;
                    next.push(intersection);
                }
                if next.len() > MAX_VERTICES {
                    return Err("자른 선택 경로의 꼭짓점 한도를 초과합니다.".into());
                }
            }
            clipped = next;
        }
        clipped.as_slice()
    } else {
        path
    };

    let mut edges = Vec::new();
    edges
        .try_reserve_exact(vertices.len())
        .map_err(reserve_error)?;
    let quantize = |coordinate: f64, origin: i64| -> i64 {
        if needs_clip {
            js_round((coordinate - origin as f64) * 64.) as i64 + origin * 64
        } else {
            coordinate.floor() as i64 * 64
        }
    };
    for index in 0..vertices.len() {
        let (a, b) = (vertices[index], vertices[(index + 1) % vertices.len()]);
        let (mut ax, mut ay) = (quantize(a.0, left), quantize(a.1, top));
        let (mut bx, mut by) = (quantize(b.0, left), quantize(b.1, top));
        if ay > by {
            std::mem::swap(&mut ax, &mut bx);
            std::mem::swap(&mut ay, &mut by);
        }
        let first_y = top.max((ay + 32).div_euclid(64));
        let end_y = (top + height).min((by - 32).div_euclid(64) + 1);
        if first_y >= end_y {
            continue;
        }
        let step = ((bx - ax) * 65536) / (by - ay);
        let x = ax * 1024
            + 32768
            + (step as f64 * (first_y as f64 + 0.5 - ay as f64 / 64.)).floor() as i64;
        edges.push(Edge {
            first_y,
            end_y,
            x,
            step,
        });
    }

    let mut mask = zeroed((width * height) as usize)?;
    edges.sort_unstable_by_key(|edge| edge.first_y);
    let mut active: Vec<Edge> = Vec::new();
    let mut next = 0;
    let mut columns = Vec::new();
    for y in edges.first().map_or(top, |edge| edge.first_y)..top + height {
        if active.is_empty() && next == edges.len() {
            break;
        }
        while next < edges.len() && edges[next].first_y == y {
            active.try_reserve(1).map_err(reserve_error)?;
            active.push(edges[next]);
            next += 1;
        }
        let row = (y - top) as usize * width as usize;
        if active.len() >= 64
            && active.len() * 2 >= width as usize
            && active.len().is_multiple_of(2)
        {
            if columns.is_empty() {
                columns = zeroed(width as usize + 1)?;
            } else {
                columns.fill(0);
            }
            for edge in &active {
                let column = (edge.x.div_euclid(65536) - left).clamp(0, width) as usize;
                columns[column] ^= 1;
            }
            let mut first = None;
            for (x, &crossing) in columns.iter().enumerate() {
                if crossing != 0 {
                    if let Some(start) = first.take() {
                        mask[row + start..row + x].fill(255);
                    } else {
                        first = Some(x);
                    }
                }
            }
        } else {
            active.sort_unstable_by_key(|edge| edge.x);
            for pair in active.as_chunks::<2>().0 {
                let start = (pair[0].x.div_euclid(65536) - left).max(0);
                let end = (pair[1].x.div_euclid(65536) - left).min(width);
                if end > start {
                    mask[row + start as usize..row + end as usize].fill(255);
                }
            }
        }
        active.retain_mut(|edge| {
            if edge.end_y <= y + 1 {
                false
            } else {
                edge.x += edge.step;
                true
            }
        });
    }
    Ok(mask)
}

#[allow(clippy::too_many_arguments)]
pub fn apply_selection_mask(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    left: i32,
    top: i32,
    path: Option<&[(f64, f64)]>,
    key: Color,
    transparent: bool,
) -> EngineResult<Option<Vec<u8>>> {
    validate_size(width, height, 1)?;
    if pixels.len() != width as usize * height as usize * 4 {
        return Err("선택 영역의 픽셀 크기가 일치하지 않습니다.".into());
    }
    let mask = path
        .map(|polygon| polygon_mask(polygon, left, top, width, height))
        .transpose()?;
    let key = premultiplied(key);
    for (index, pixel) in pixels.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        if mask.as_ref().is_some_and(|mask| mask[index] == 0)
            || (transparent && premultiplied(*pixel) == key)
        {
            pixel[3] = 0;
        }
    }
    Ok(mask)
}

pub fn resize_state(
    state: &State,
    width: u32,
    height: u32,
    scale: bool,
    smooth: bool,
) -> EngineResult<State> {
    state.validate()?;
    validate_size(width, height, state.layers.len())?;
    if !scale {
        return crop_state(state, 0, 0, width, height);
    }
    let mut result = State {
        width,
        height,
        background: state.background,
        active: state.active,
        layers: Vec::with_capacity(state.layers.len()),
    };
    let (width, height) = (width as usize, height as usize);
    let (source_width, source_height) = (state.width as usize, state.height as usize);
    let x_indices: Vec<usize> = if smooth {
        Vec::new()
    } else {
        (0..width)
            .map(|x| ((2 * x + 1) * source_width).div_ceil(2 * width) - 1)
            .collect()
    };
    for layer in &state.layers {
        let mut pixels = zeroed(width * height * 4)?;
        let mut previous_source_row = None;
        for y in 0..height {
            let offset = y * width * 4;
            if smooth {
                let sy = (y as f64 + 0.5) * source_height as f64 / height as f64 - 0.5;
                let floor_y = sy.floor();
                let y_fraction = sy - floor_y;
                for x in 0..width {
                    let sx = (x as f64 + 0.5) * source_width as f64 / width as f64 - 0.5;
                    let floor_x = sx.floor();
                    let mut alpha = 0.;
                    let mut color = [0.; 3];
                    for (yy, weight_y) in [1. - sy + floor_y, y_fraction].into_iter().enumerate() {
                        let py = (floor_y as i64 + yy as i64).clamp(0, source_height as i64 - 1)
                            as usize;
                        for (xx, weight_x) in
                            [1. - sx + floor_x, sx - floor_x].into_iter().enumerate()
                        {
                            let px = (floor_x as i64 + xx as i64).clamp(0, source_width as i64 - 1)
                                as usize;
                            let p = (py * source_width + px) * 4;
                            let weight = weight_x * weight_y;
                            let opacity = f64::from(layer.pixels[p + 3]) / 255.;
                            alpha += opacity * weight;
                            for (channel, sum) in color.iter_mut().enumerate() {
                                *sum += f64::from(layer.pixels[p + channel]) * opacity * weight;
                            }
                        }
                    }
                    let i = offset + x * 4;
                    if alpha > 0. {
                        for channel in 0..3 {
                            pixels[i + channel] = byte_round(color[channel] / alpha);
                        }
                    }
                    pixels[i + 3] = byte_round(alpha * 255.);
                }
            } else {
                let source_row =
                    (((2 * y + 1) * source_height).div_ceil(2 * height) - 1) * source_width * 4;
                if previous_source_row == Some(source_row) {
                    pixels.copy_within(offset - width * 4..offset, offset);
                } else if width == source_width {
                    pixels[offset..offset + width * 4]
                        .copy_from_slice(&layer.pixels[source_row..source_row + width * 4]);
                } else {
                    for (target, &source) in pixels[offset..offset + width * 4]
                        .as_chunks_mut::<4>()
                        .0
                        .iter_mut()
                        .zip(&x_indices)
                    {
                        let p = source_row + source * 4;
                        target.copy_from_slice(&layer.pixels[p..p + 4]);
                    }
                }
                previous_source_row = Some(source_row);
            }
        }
        result
            .layers
            .push(Layer::new(layer.name.clone(), layer.visible, pixels));
    }
    Ok(result)
}

pub fn crop_state(state: &State, x: i32, y: i32, width: u32, height: u32) -> EngineResult<State> {
    state.validate()?;
    validate_size(width, height, state.layers.len())?;
    let (x, y) = (i64::from(x), i64::from(y));
    let left = x.max(0);
    let top = y.max(0);
    let right = i64::from(state.width).min(x + i64::from(width));
    let bottom = i64::from(state.height).min(y + i64::from(height));
    let mut result = State {
        width,
        height,
        background: state.background,
        active: state.active,
        layers: Vec::with_capacity(state.layers.len()),
    };
    for (index, layer) in state.layers.iter().enumerate() {
        let mut pixels = zeroed(width as usize * height as usize * 4)?;
        if index == 0 {
            fill_pixels(&mut pixels, state.background);
        }
        if left < right && top < bottom {
            let bytes = (right - left) as usize * 4;
            for row in top..bottom {
                let from = (row * i64::from(state.width) + left) as usize * 4;
                let to = ((row - y) * i64::from(width) + left - x) as usize * 4;
                pixels[to..to + bytes].copy_from_slice(&layer.pixels[from..from + bytes]);
            }
        }
        result
            .layers
            .push(Layer::new(layer.name.clone(), layer.visible, pixels));
    }
    Ok(result)
}

pub fn transform_state(state: &State, operation: &str) -> EngineResult<State> {
    state.validate()?;
    let (width, height) = match operation {
        "rotate-left" | "rotate-right" => (state.height, state.width),
        "flip-x" | "flip-y" => (state.width, state.height),
        _ => return Err("지원하지 않는 변형입니다.".into()),
    };
    let mut result = State {
        width,
        height,
        background: state.background,
        active: state.active,
        layers: Vec::with_capacity(state.layers.len()),
    };
    for layer in &state.layers {
        let mut pixels = zeroed(layer.pixels.len())?;
        for y in 0..state.height {
            for x in 0..state.width {
                let (nx, ny) = match operation {
                    "rotate-left" => (y, state.width - x - 1),
                    "rotate-right" => (state.height - y - 1, x),
                    "flip-x" => (state.width - x - 1, y),
                    _ => (x, state.height - y - 1),
                };
                let from = (y as usize * state.width as usize + x as usize) * 4;
                let to = (ny as usize * width as usize + nx as usize) * 4;
                pixels[to..to + 4].copy_from_slice(&layer.pixels[from..from + 4]);
            }
        }
        result
            .layers
            .push(Layer::new(layer.name.clone(), layer.visible, pixels));
    }
    Ok(result)
}

pub fn shear_state(state: &State, angle_degrees: f64) -> EngineResult<State> {
    if !(-60. ..=60.).contains(&angle_degrees) {
        return Err("기울기는 -60도에서 60도 사이여야 합니다.".into());
    }
    state.validate()?;
    let mut factor = (angle_degrees * std::f64::consts::PI / 180.).tan();
    if factor.abs() <= 1e-12 {
        factor = 0.;
    }
    let width = (f64::from(state.width) + factor.abs() * f64::from(state.height)).ceil() as u32;
    validate_size(width, state.height, state.layers.len())?;
    let offset = if factor < 0. {
        (-factor * f64::from(state.height)).ceil()
    } else {
        0.
    };
    let mut result = State {
        width,
        height: state.height,
        background: state.background,
        active: state.active,
        layers: Vec::with_capacity(state.layers.len()),
    };
    let row_bytes = state.width as usize * 4;
    for layer in &state.layers {
        let mut pixels = zeroed(width as usize * state.height as usize * 4)?;
        for (y, row) in layer.pixels.chunks_exact(row_bytes).enumerate() {
            let shift = (offset + js_round(factor * (y as f64 + 0.5))) as usize;
            let target = (y * width as usize + shift) * 4;
            pixels[target..target + row_bytes].copy_from_slice(row);
        }
        result
            .layers
            .push(Layer::new(layer.name.clone(), layer.visible, pixels));
    }
    Ok(result)
}

pub fn flood(
    pixels: &[u8],
    width: u32,
    height: u32,
    x: f64,
    y: f64,
    color: Color,
) -> EngineResult<Option<PixelPatch>> {
    validate_size(width, height, 1)?;
    let (width, height) = (width as usize, height as usize);
    if pixels.len() != width * height * 4 {
        return Err("픽셀 크기 불일치".into());
    }
    if !(0. ..width as f64).contains(&x) || !(0. ..height as f64).contains(&y) {
        return Ok(None);
    }
    let (x, y) = (x.floor() as usize, y.floor() as usize);
    let start = y * width + x;
    let key = premultiplied(get_color(&pixels[start * 4..]));
    if premultiplied(color) == key {
        return Ok(None);
    }
    let matches = |index: usize| {
        let original = get_color(&pixels[index * 4..]);
        original[3] == key[3]
            && match key[3] {
                0 => true,
                255 => original == key,
                _ => premultiplied(original) == key,
            }
    };
    let mut visited = zeroed(width * height)?;
    visited[start] = 2;
    let mut stack = vec![start as u32];
    let (mut left, mut top, mut right, mut bottom) = (x, y, x, y);
    while let Some(pos) = stack.pop() {
        let pos = pos as usize;
        if visited[pos] == 1 {
            continue;
        }
        let row = pos / width;
        let row_start = row * width;
        let (mut lo, mut hi) = (pos % width, pos % width);
        while lo > 0 && visited[row_start + lo - 1] != 1 && matches(row_start + lo - 1) {
            lo -= 1;
        }
        while hi + 1 < width && visited[row_start + hi + 1] != 1 && matches(row_start + hi + 1) {
            hi += 1;
        }
        let mut runs = [false, false];
        for col in lo..=hi {
            let index = row_start + col;
            if visited[index] == 1 {
                continue;
            }
            visited[index] = 1;
            for (run, neighbor) in runs.iter_mut().zip([
                index.checked_sub(width),
                row.checked_add(1)
                    .filter(|&next| next < height)
                    .map(|_| index + width),
            ]) {
                if let Some(neighbor) = neighbor {
                    let adjacent = visited[neighbor] != 1 && matches(neighbor);
                    if adjacent && !*run && visited[neighbor] == 0 {
                        stack.try_reserve(1).map_err(reserve_error)?;
                        visited[neighbor] = 2;
                        stack.push(neighbor as u32);
                    }
                    *run = adjacent;
                }
            }
        }
        left = left.min(lo);
        right = right.max(hi);
        top = top.min(row);
        bottom = bottom.max(row);
    }

    let rect = Rectangle {
        x: left,
        y: top,
        width: right + 1 - left,
        height: bottom + 1 - top,
    };
    let mut patch = rect.read(pixels, width)?;
    for (row, target) in patch.chunks_exact_mut(rect.width * 4).enumerate() {
        let start = (top + row) * width + left;
        for (&mark, pixel) in visited[start..start + rect.width]
            .iter()
            .zip(target.as_chunks_mut::<4>().0)
        {
            if mark == 1 {
                *pixel = color;
            }
        }
    }
    Ok(Some(PixelPatch {
        left: left as i32,
        top: top as i32,
        width: rect.width as u32,
        height: rect.height as u32,
        pixels: patch,
    }))
}
