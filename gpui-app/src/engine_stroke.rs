use std::collections::HashMap;

use super::{
    Color, EngineResult, MAX_DIMENSION, Rectangle, Region, State, byte_round, get_color, js_round,
    premultiplied, reserve_error, source_over, zeroed,
};

const TILE_EDGE: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BrushSettings {
    pub color: Color,
    pub size: f64,
    pub opacity: f64,
    pub hardness: f64,
    pub stabilization: f64,
    pub eraser: bool,
    pub pressure: bool,
    pub square: bool,
    pub pixel: bool,
    pub dabs_only: bool,
    pub match_color: Option<Color>,
}

impl Default for BrushSettings {
    fn default() -> Self {
        Self {
            color: [0, 0, 0, 255],
            size: 12.,
            opacity: 1.,
            hardness: 1.,
            stabilization: 0.,
            eraser: false,
            pressure: false,
            square: false,
            pixel: false,
            dabs_only: false,
            match_color: None,
        }
    }
}

impl BrushSettings {
    fn hard_square(self) -> bool {
        self.square && !self.pixel && !self.dabs_only && self.match_color.is_none()
    }
}

pub(super) struct StrokeTile {
    pub(super) rect: Rectangle,
    pub(super) before: Vec<u8>,
    pub(super) coverage: Vec<u8>,
}

pub(super) struct ActiveStroke {
    pub(super) settings: BrushSettings,
    pub(super) tiles: HashMap<usize, StrokeTile>,
    pub(super) layer: usize,
    pub(super) was_visible: bool,
    pub(super) inside_canvas: bool,
    pub(super) force: f64,
    pub(super) segment_dirty: Region,
    x: f64,
    y: f64,
    fx: f64,
    fy: f64,
}

fn clamp_coordinate(value: f64) -> f64 {
    value.clamp(-f64::from(MAX_DIMENSION), f64::from(MAX_DIMENSION) * 2.)
}

impl ActiveStroke {
    pub(super) fn new(
        x: f64,
        y: f64,
        mut settings: BrushSettings,
        force: f64,
        state: &State,
    ) -> EngineResult<Self> {
        if [
            x,
            y,
            force,
            settings.size,
            settings.opacity,
            settings.hardness,
            settings.stabilization,
        ]
        .into_iter()
        .any(|value| !value.is_finite())
        {
            return Err("입력 값이 올바르지 않습니다.".into());
        }
        let (mut x, mut y) = (clamp_coordinate(x), clamp_coordinate(y));
        if settings.hard_square() || settings.match_color.is_some() {
            x = x.floor();
            y = y.floor();
        }
        if settings.hard_square() {
            settings.size = settings.size.floor();
            settings.opacity = 1.;
            settings.hardness = 1.;
            settings.stabilization = 0.;
            settings.pressure = false;
        }
        settings.size = settings.size.clamp(1., 100.);
        settings.opacity = settings.opacity.clamp(0., 1.);
        settings.hardness = settings.hardness.clamp(0., 1.);
        settings.stabilization = settings.stabilization.clamp(0., 75.);
        Ok(Self {
            settings,
            tiles: HashMap::new(),
            layer: state.active,
            was_visible: state.layers[state.active].visible,
            inside_canvas: inside(x, y, state.width as usize, state.height as usize),
            force: if settings.pressure {
                force.clamp(0., 1.)
            } else {
                1.
            },
            segment_dirty: Region::EMPTY,
            x,
            y,
            fx: x,
            fy: y,
        })
    }

    pub(super) fn needs_end_sample(&self, x: f64, y: f64) -> bool {
        !self.settings.hard_square()
            || clamp_coordinate(x).floor() != self.x
            || clamp_coordinate(y).floor() != self.y
    }

    pub(super) fn paint(
        &mut self,
        state: &mut State,
        x: f64,
        y: f64,
        force: f64,
        finish: bool,
    ) -> EngineResult<()> {
        self.segment_dirty = Region::EMPTY;
        if !x.is_finite() || !y.is_finite() || !force.is_finite() {
            return Err("입력 좌표가 올바르지 않습니다.".into());
        }
        let width = state.width as usize;
        let height = state.height as usize;
        let (mut x, mut y) = (clamp_coordinate(x), clamp_coordinate(y));
        let s = self.settings;
        if s.hard_square() || s.match_color.is_some() {
            x = x.floor();
            y = y.floor();
        }
        self.inside_canvas |= inside(x, y, width, height);
        if s.hard_square() {
            if s.eraser || s.color[3] != 0 {
                self.paint_square(state.try_pixels_mut(self.layer)?, width, height, x, y)?;
            }
            self.x = x;
            self.y = y;
            self.fx = x;
            self.fy = y;
            self.force = 1.;
            return Ok(());
        }

        let force = if s.pressure { force.clamp(0., 1.) } else { 1. };
        let match_color = s.match_color.map(premultiplied);
        let direct = finish || s.pixel || s.dabs_only || match_color.is_some();
        let weight = 1. - s.stabilization * 0.008;
        let fx = if direct {
            x
        } else {
            self.fx + (x - self.fx) * weight
        };
        let fy = if direct {
            y
        } else {
            self.fy + (y - self.fy) * weight
        };
        let ex = if direct { x } else { (self.fx + fx) * 0.5 };
        let ey = if direct { y } else { (self.fy + fy) * 0.5 };
        let length =
            (self.x - self.fx).hypot(self.y - self.fy) + (self.fx - ex).hypot(self.fy - ey);
        let dabs = s.dabs_only || match_color.is_some();
        let steps = if dabs {
            1
        } else if s.pixel {
            (x.floor() - self.x.floor())
                .abs()
                .max((y.floor() - self.y.floor()).abs())
                .max(1.) as usize
        } else {
            (length / (s.size * 0.12).max(0.25)).ceil().max(1.) as usize
        };
        let dx = x - self.x;
        let dy = y - self.y;
        let length_squared = dx * dx + dy * dy;
        if match_color.is_some() || (s.opacity > 0. && (s.eraser || s.color[3] != 0)) {
            let image = state.try_pixels_mut(self.layer)?;
            for step in usize::from(dabs)..=steps {
                let t = step as f64 / steps as f64;
                let u = 1. - t;
                let (cx, cy) = if dabs {
                    (x, y)
                } else if s.pixel {
                    (
                        js_round(u * self.x.floor() + t * x.floor()) + 0.5,
                        js_round(u * self.y.floor() + t * y.floor()) + 0.5,
                    )
                } else {
                    (
                        u * u * self.x + 2. * u * t * self.fx + t * t * ex,
                        u * u * self.y + 2. * u * t * self.fy + t * t * ey,
                    )
                };
                let interpolation = self.force + (force - self.force) * t;
                let r = if match_color.is_some() {
                    s.size / 2.
                } else {
                    (s.size * (0.2 + 0.8 * (if s.pressure { interpolation } else { 1. })) / 2.)
                        .max(0.5)
                };
                let inner = r * s.hardness;
                let (left, right, top, bottom) = if match_color.is_some() {
                    (
                        (self.x.min(x) - r).floor(),
                        (self.x.max(x) + r).ceil(),
                        (self.y.min(y) - r).floor(),
                        (self.y.max(y) + r).ceil(),
                    )
                } else if s.pixel {
                    (cx.floor(), cx.floor(), cy.floor(), cy.floor())
                } else {
                    (
                        (cx - r - 0.5).floor(),
                        (cx + r + 0.5).ceil(),
                        (cy - r - 0.5).floor(),
                        (cy + r + 0.5).ceil(),
                    )
                };
                let left = (left as i32).max(0);
                let right = (right as i32).min(width as i32 - 1);
                let top = (top as i32).max(0);
                let bottom = (bottom as i32).min(height as i32 - 1);
                for py in top..=bottom {
                    let mut row_left = left;
                    let mut row_right = right;
                    if match_color.is_some() && dy != 0. {
                        let lower = (f64::from(py) - r - self.y) / dy;
                        let upper = (f64::from(py) + r - self.y) / dy;
                        let first = lower.min(upper).max(0.);
                        let last = lower.max(upper).min(1.);
                        if first > last {
                            continue;
                        }
                        let a = self.x + first * dx;
                        let b = self.x + last * dx;
                        row_left = row_left.max((a.min(b) - r).floor() as i32);
                        row_right = row_right.min((a.max(b) + r).ceil() as i32);
                    }
                    for px in row_left..=row_right {
                        let index = (py as usize * width + px as usize) * 4;
                        let distance = if let Some(key) = match_color {
                            let previous = get_color(&image[index..]);
                            if premultiplied(previous) != key || previous == s.color {
                                continue;
                            }
                            let along = if length_squared != 0. {
                                (((f64::from(px) - self.x) * dx + (f64::from(py) - self.y) * dy)
                                    / length_squared)
                                    .clamp(0., 1.)
                            } else {
                                0.
                            };
                            (f64::from(px) - self.x - along * dx)
                                .hypot(f64::from(py) - self.y - along * dy)
                        } else {
                            let (offset_x, offset_y) =
                                (f64::from(px) + 0.5 - cx, f64::from(py) + 0.5 - cy);
                            if s.square {
                                offset_x.abs().max(offset_y.abs())
                            } else {
                                offset_x.hypot(offset_y)
                            }
                        };
                        let coverage = if match_color.is_some() {
                            if distance <= r { 255 } else { 0 }
                        } else {
                            let edge = ((distance - inner) / (r + 0.5 - inner)).clamp(0., 1.);
                            byte_round(
                                255. * (if s.pixel {
                                    1.
                                } else {
                                    1. - edge * edge * (3. - 2. * edge)
                                }) * s.opacity,
                            )
                        };
                        if coverage == 0 {
                            continue;
                        }
                        let point = (px as usize, py as usize);
                        let id = tile_index(width, point);
                        if match_color.is_none()
                            && s.eraser
                            && s.color[3] == 0
                            && self.tiles.get(&id).map_or(image[index + 3], |tile| {
                                tile.before[local_index(tile.rect, point) * 4 + 3]
                            }) == 0
                        {
                            continue;
                        }
                        let tile = tile_for(&mut self.tiles, image, width, height, point, true)?;
                        let local = local_index(tile.rect, point);
                        if coverage <= tile.coverage[local] {
                            continue;
                        }
                        tile.coverage[local] = coverage;
                        self.segment_dirty.include(Region {
                            left: point.0 as u32,
                            top: point.1 as u32,
                            width: 1,
                            height: 1,
                        });
                        if match_color.is_some() {
                            image[index..index + 4].copy_from_slice(&s.color);
                            continue;
                        }
                        let p = local * 4;
                        let old = &tile.before[p..p + 4];
                        let amount = f64::from(coverage) / 255.;
                        let before_alpha = f64::from(old[3]) / 255.;
                        let target_alpha = f64::from(s.color[3]) / 255.;
                        let source = if s.eraser {
                            target_alpha * amount
                        } else {
                            (amount * f64::from(s.color[3])) / 255.
                        };
                        let retained = if s.eraser { 1. - amount } else { 1. - source };
                        let alpha = source + before_alpha * retained;
                        for c in 0..3 {
                            let ink = if s.eraser {
                                f64::from(s.color[c]) * target_alpha * amount
                            } else {
                                f64::from(s.color[c]) * source
                            };
                            image[index + c] = if alpha != 0. {
                                byte_round(
                                    (ink + f64::from(old[c]) * before_alpha * retained) / alpha,
                                )
                            } else {
                                0
                            };
                        }
                        image[index + 3] = byte_round(alpha * 255.);
                    }
                }
            }
        }
        self.x = ex;
        self.y = ey;
        self.fx = fx;
        self.fy = fy;
        self.force = force;
        Ok(())
    }

    fn paint_square(
        &mut self,
        image: &mut [u8],
        width: usize,
        height: usize,
        x: f64,
        y: f64,
    ) -> EngineResult<()> {
        let size = self.settings.size;
        let dx = x - self.x;
        let dy = y - self.y;
        let length_squared = dx * dx + dy * dy;
        let w = width as f64;
        let h = height as f64;
        let point = length_squared == 0.;
        let thin = !point && size == 1.;
        let mut axes: Option<[f64; 4]> = None;
        let mut edges = Vec::new();
        let mut first_row = h as i64;
        let mut last_row = -1;
        let mut first_col = 0_i64;
        let mut last_col = -1_i64;
        let mut phase = 0_i64;
        let mut increment = 0_i64;
        let mut horizontal = false;
        if thin {
            let mut first = 0.;
            let mut last = 1.;
            let mut anchors = [[None; 2]; 2];
            for (direction, distance, axis, boundary) in [
                (-dx, self.x + 1., 0, -1.),
                (dx, w + 1. - self.x, 0, w + 1.),
                (-dy, self.y + 1., 1, -1.),
                (dy, h + 1. - self.y, 1, h + 1.),
            ] {
                if direction == 0. {
                    if distance < 0. {
                        last = -1.;
                        break;
                    }
                    continue;
                }
                let t = distance / direction;
                let index = usize::from(direction >= 0.);
                let end = if index == 0 { &mut first } else { &mut last };
                if if index == 0 { t > *end } else { t < *end } {
                    *end = t;
                    anchors[index] = [None; 2];
                    anchors[index][axis] = Some(boundary);
                } else if t == *end {
                    anchors[index][axis] = Some(boundary);
                }
                if first > last {
                    break;
                }
            }
            if first <= last {
                let ax = (anchors[0][0].unwrap_or(self.x + dx * first) * 64.) as i64;
                let ay = (anchors[0][1].unwrap_or(self.y + dy * first) * 64.) as i64;
                let bx = (anchors[1][0].unwrap_or(self.x + dx * last) * 64.) as i64;
                let by = (anchors[1][1].unwrap_or(self.y + dy * last) * 64.) as i64;
                horizontal = (bx - ax).abs() >= (by - ay).abs();
                let (mut m0, mut n0, mut m1, mut n1) = if horizontal {
                    (ax, ay, bx, by)
                } else {
                    (ay, ax, by, bx)
                };
                if m0 > m1 {
                    std::mem::swap(&mut m0, &mut m1);
                    std::mem::swap(&mut n0, &mut n1);
                }
                if m1 > m0 {
                    increment = ((n1 - n0) * 65536) / (m1 - m0);
                    first_col = m0.div_euclid(64);
                    last_col = m1.div_euclid(64);
                    phase = n0 * 1024 - increment.div_euclid(2)
                        + ((first_col * 64 - m0 + 32 + if increment > 0 { 32 } else { 0 })
                            * increment)
                            .div_euclid(64);
                }
            }
        } else if !point {
            let relative = size / length_squared.sqrt();
            let shift_x = 0.5 * relative * dx;
            let shift_y = 0.5 * relative * dy;
            let mut ends = [
                [self.x - shift_x, self.y - shift_y],
                [x + shift_x, y + shift_y],
            ];
            let mut empty = false;
            'clip: for (axis, margin, limit) in [
                (0, dy.abs() * relative * 0.5, w),
                (1, dx.abs() * relative * 0.5, h),
            ] {
                for which in [0, 1] {
                    let own = ends[which];
                    let other = ends[1 - which];
                    let bound = own[axis].clamp(-margin, limit + margin);
                    if bound == own[axis] {
                        continue;
                    }
                    let denominator = other[axis] - own[axis];
                    let t = (bound - own[axis]) / denominator;
                    if denominator == 0. || !(0. ..=1.).contains(&t) {
                        empty = true;
                        break 'clip;
                    }
                    let slope = (other[1 - axis] - own[1 - axis]) / denominator;
                    ends[which][1 - axis] = slope.mul_add(bound - own[axis], own[1 - axis]);
                    ends[which][axis] = bound;
                }
            }
            if !empty {
                let [[ax, ay], [bx, by]] = ends;
                let (cx, cy) = (bx - ax, by - ay);
                let norm = cx.mul_add(cx, cy * cy);
                if norm > 0. {
                    let recovered = relative * (length_squared / norm).sqrt();
                    if dy == 0. {
                        let center = (ax + bx) * 0.5;
                        let half_height = recovered * (cx.abs() * 0.5);
                        let (high, low) = (ay - half_height, ay + half_height);
                        let half_width = 0.5 * (1. / recovered) * (low - high);
                        axes = Some([center - half_width, high, center + half_width, low]);
                    } else if dx == 0. {
                        let high = ay.min(by);
                        let low = ay.max(by);
                        let half_width = 0.5 * recovered * (low - high);
                        axes = Some([ax - half_width, high, ax + half_width, low]);
                    } else {
                        let (nx, ny) = (cy * recovered / 2., -cx * recovered / 2.);
                        let vertices = [
                            (ax + nx, ay + ny),
                            (bx + nx, by + ny),
                            (bx - nx, by - ny),
                            (ax - nx, ay - ny),
                        ]
                        .map(|(x, y)| ((x * 64.).floor() / 64., (y * 64.).floor() / 64.));
                        let top = vertices
                            .iter()
                            .map(|(_, y)| *y)
                            .fold(f64::INFINITY, f64::min);
                        let mut area = 0.;
                        for index in 0..4 {
                            let (x, y) = vertices[index];
                            let (nx, ny) = vertices[(index + 1) % 4];
                            area += x * ny - nx * y;
                        }
                        for index in 0..4 {
                            let (mut ax, mut ay) = vertices[index];
                            let (mut bx, mut by) = vertices[(index + 1) % 4];
                            let direction = by - ay;
                            if direction == 0. {
                                continue;
                            }
                            let left = area * direction < 0.;
                            if ay > by {
                                std::mem::swap(&mut ax, &mut bx);
                                std::mem::swap(&mut ay, &mut by);
                            }
                            let slope = (bx - ax) / (by - ay);
                            let first = if ay == top {
                                (ay + 0.5) as i64
                            } else if ay < 0.5 {
                                0
                            } else {
                                (ay - 0.5) as i64 + 1
                            };
                            let last = if by < 0.5 { -1 } else { (by - 0.5) as i64 };
                            let phase = ((first as f64 + 0.5 - ay)
                                .mul_add(slope, ax + if left { 0.5 } else { -0.5 })
                                * 65536.) as i64;
                            edges.push((left, first, last, phase, (slope * 65536.) as i64));
                            first_row = first_row.min(first.max(0));
                            last_row = last_row.max(last.min(height as i64 - 1));
                        }
                    }
                }
            }
        }
        let count = if point {
            2
        } else if thin {
            last_col - first_col
        } else {
            1
        };
        for step in i64::from(!thin)..=count {
            let (mut left, mut right, mut top, mut bottom) = (0, -1, 0, -1);
            if thin {
                let major = first_col + step;
                let minor = (phase + step * increment).div_euclid(65536);
                let (px, py) = if horizontal {
                    (major, minor)
                } else {
                    (minor, major)
                };
                (left, right, top, bottom) = (
                    px.max(0),
                    px.min(width as i64 - 1),
                    py.max(0),
                    py.min(height as i64 - 1),
                );
            } else if point {
                let (px, py) = (
                    (x - (size / 2.).floor()) as i64,
                    (y - (size / 2.).floor()) as i64,
                );
                (left, right, top, bottom) = (
                    px.max(0),
                    (px + size as i64 - 1).min(width as i64 - 1),
                    py.max(0),
                    (py + size as i64 - 1).min(height as i64 - 1),
                );
                if size > 1. && (step == 1 || self.settings.color[3] == 255) {
                    let travel = if step == 1 { size } else { x + (1. / 63.) - x };
                    let ratio = if step == 1 { 1. } else { size / travel.abs() };
                    let cap = 0.5 * ratio * travel;
                    let start = (x - cap).max(0.);
                    let end = (if step == 1 { x + cap } else { x + travel + cap }).min(w);
                    if end <= start {
                        continue;
                    }
                    let center = (start + end) * 0.5;
                    let span = end - start;
                    let recovered = ratio * (travel * travel / (span * span)).sqrt();
                    let half_height = recovered * (span.abs() * 0.5);
                    let (high, low) = (y - half_height, y + half_height);
                    let half_width = 0.5 * (1. / recovered) * (low - high);
                    axes = Some([center - half_width, high, center + half_width, low]);
                } else {
                    axes = None;
                }
            } else if !edges.is_empty() {
                (left, right, top, bottom) = (0, width as i64 - 1, first_row, last_row);
            }
            if let Some([l, t, r, b]) = axes {
                let l = l.clamp(0., w);
                let t = t.clamp(0., h);
                let r = r.clamp(0., w);
                let b = b.clamp(0., h);
                left = (l + 0.5).floor() as i64;
                top = (t + 0.5).floor() as i64;
                right = ((r - 0.5).floor() as i64).min(width as i64 - 1);
                bottom = ((b - 0.5).floor() as i64).min(height as i64 - 1);
            }
            for py in top..=bottom {
                let (mut row_left, mut row_right) = (left, right);
                if !edges.is_empty() && axes.is_none() {
                    let (mut first, mut last) = (i64::MAX, i64::MIN);
                    for &(is_left, anchor, end, phase, step) in &edges {
                        if anchor <= py && py <= end {
                            let position = (phase + (py - anchor) * step).div_euclid(65536);
                            if is_left {
                                first = position;
                            } else {
                                last = position;
                            }
                        }
                    }
                    row_left = row_left.max(first);
                    row_right = row_right.min(last);
                }
                for px in row_left..=row_right {
                    let point = (px as usize, py as usize);
                    let index = (point.1 * width + point.0) * 4;
                    let id = tile_index(width, point);
                    let s = self.settings;
                    if s.eraser
                        && s.color[3] == 0
                        && self.tiles.get(&id).map_or(image[index + 3], |tile| {
                            tile.before[local_index(tile.rect, point) * 4 + 3]
                        }) == 0
                    {
                        continue;
                    }
                    tile_for(&mut self.tiles, image, width, height, point, false)?;
                    self.segment_dirty.include(Region {
                        left: point.0 as u32,
                        top: point.1 as u32,
                        width: 1,
                        height: 1,
                    });
                    let pixel = &mut image[index..index + 4];
                    if s.eraser {
                        pixel.copy_from_slice(&s.color);
                    } else {
                        source_over(pixel, s.color);
                    }
                }
            }
        }
        Ok(())
    }
}

fn inside(x: f64, y: f64, width: usize, height: usize) -> bool {
    x >= 0. && y >= 0. && x < width as f64 && y < height as f64
}

fn tile_index(width: usize, (x, y): (usize, usize)) -> usize {
    (y / TILE_EDGE) * width.div_ceil(TILE_EDGE) + x / TILE_EDGE
}

fn local_index(rect: Rectangle, (x, y): (usize, usize)) -> usize {
    (y - rect.y) * rect.width + x - rect.x
}

fn tile_for<'a>(
    tiles: &'a mut HashMap<usize, StrokeTile>,
    image: &[u8],
    width: usize,
    height: usize,
    point: (usize, usize),
    coverage: bool,
) -> EngineResult<&'a mut StrokeTile> {
    let id = tile_index(width, point);
    if !tiles.contains_key(&id) {
        tiles.try_reserve(1).map_err(reserve_error)?;
        let x = point.0 / TILE_EDGE * TILE_EDGE;
        let y = point.1 / TILE_EDGE * TILE_EDGE;
        let rect = Rectangle {
            x,
            y,
            width: (width - x).min(TILE_EDGE),
            height: (height - y).min(TILE_EDGE),
        };
        let before = rect.read(image, width)?;
        let coverage = if coverage {
            zeroed(rect.width * rect.height)?
        } else {
            Vec::new()
        };
        tiles.insert(
            id,
            StrokeTile {
                rect,
                before,
                coverage,
            },
        );
    }
    Ok(tiles.get_mut(&id).expect("captured tile"))
}
