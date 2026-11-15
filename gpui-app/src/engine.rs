use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

#[path = "engine_geometry.rs"]
mod geometry;
pub use geometry::*;

#[path = "engine_stroke.rs"]
mod stroke;
pub use stroke::BrushSettings;
use stroke::{ActiveStroke, StrokeTile};

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;

pub type Color = [u8; 4];
pub type EngineResult<T> = Result<T, String>;

pub const MAX_DIMENSION: u32 = 32_768;
pub const MAX_PIXELS: usize = 32 * 1024 * 1024;
pub const MAX_TOTAL_PIXELS: usize = 64 * 1024 * 1024;
pub const MAX_LAYERS: usize = 16;
pub const MAX_INPUT_BYTES: usize = 300 * 1024 * 1024;
pub const MAX_LAYER_BYTES: usize = 140 * 1024 * 1024;
const HISTORY_LIMIT: usize = 4096;
const HISTORY_BYTES: usize = 256 * 1024 * 1024;
static NEXT_DOCUMENT: AtomicU64 = AtomicU64::new(1);

pub fn validate_size(width: u32, height: u32, layers: usize) -> EngineResult<()> {
    let pixels = u64::from(width) * u64::from(height);
    if width == 0
        || height == 0
        || width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || !(1..=MAX_LAYERS).contains(&layers)
        || pixels > MAX_PIXELS as u64
        || pixels * layers as u64 > MAX_TOTAL_PIXELS as u64
    {
        return Err("이미지 크기 또는 레이어 메모리 한도를 초과합니다.".into());
    }
    Ok(())
}

fn reserve_error(_: std::collections::TryReserveError) -> String {
    "이미지에 필요한 메모리를 확보할 수 없습니다.".into()
}

fn zeroed(len: usize) -> EngineResult<Vec<u8>> {
    let mut out = Vec::new();
    out.try_reserve_exact(len).map_err(reserve_error)?;
    out.resize(len, 0);
    Ok(out)
}

fn owned_copy(src: &[u8]) -> EngineResult<Vec<u8>> {
    let mut out = Vec::new();
    out.try_reserve_exact(src.len()).map_err(reserve_error)?;
    out.extend_from_slice(src);
    Ok(out)
}

fn fill_pixels(pixels: &mut [u8], color: Color) {
    if color != [0; 4] {
        for pixel in pixels.as_chunks_mut::<4>().0 {
            *pixel = color;
        }
    }
}

fn get_color(bytes: &[u8]) -> Color {
    [bytes[0], bytes[1], bytes[2], bytes[3]]
}

fn byte_round(value: f64) -> u8 {
    value.round() as u8
}

fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    floor + (value - floor >= 0.5) as u8 as f64
}

fn premultiplied(color: Color) -> Color {
    let [red, green, blue, alpha] = color;
    let premultiply = |channel| ((u16::from(channel) * u16::from(alpha) + 127) / 255) as u8;
    [
        premultiply(red),
        premultiply(green),
        premultiply(blue),
        alpha,
    ]
}

/// Straight source-over rounds after each layer and keeps destination bytes when source alpha is zero.
pub fn source_over(destination: &mut [u8], source: Color) {
    match source[3] {
        0 => {}
        255 => destination[..4].copy_from_slice(&source),
        source_alpha => {
            let a = f64::from(source_alpha) / 255.;
            let b = f64::from(destination[3]) / 255.;
            let alpha = a + b * (1. - a);
            for channel in 0..3 {
                destination[channel] = byte_round(
                    (f64::from(source[channel]) * a
                        + f64::from(destination[channel]) * b * (1. - a))
                        / alpha,
                );
            }
            destination[3] = byte_round(alpha * 255.);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layer {
    pub name: String,
    pub visible: bool,
    pub pixels: Arc<Vec<u8>>,
}

impl Layer {
    pub fn new(name: String, visible: bool, pixels: Vec<u8>) -> Self {
        Self {
            name,
            visible,
            pixels: Arc::new(pixels),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub width: u32,
    pub height: u32,
    pub background: Color,
    pub active: usize,
    pub layers: Vec<Layer>,
}

impl State {
    pub fn new(width: u32, height: u32, background: Color) -> EngineResult<Self> {
        validate_size(width, height, 1)?;
        let mut pixels = zeroed(width as usize * height as usize * 4)?;
        fill_pixels(&mut pixels, background);
        Ok(Self {
            width,
            height,
            background,
            active: 0,
            layers: vec![Layer::new("배경".into(), true, pixels)],
        })
    }

    pub fn validate(&self) -> EngineResult<()> {
        validate_size(self.width, self.height, self.layers.len())?;
        let bytes = self.width as usize * self.height as usize * 4;
        if self.active >= self.layers.len()
            || self
                .layers
                .iter()
                .any(|layer| layer.pixels.len() != bytes || layer.name.encode_utf16().count() > 256)
        {
            return Err("레이어 또는 활성 문서 데이터가 올바르지 않습니다.".into());
        }
        Ok(())
    }

    pub fn pixels_mut(&mut self, layer: usize) -> &mut Vec<u8> {
        Arc::make_mut(&mut self.layers[layer].pixels)
    }

    pub(crate) fn try_pixels_mut(&mut self, layer: usize) -> EngineResult<&mut Vec<u8>> {
        let pixels = &mut self
            .layers
            .get_mut(layer)
            .ok_or("레이어 번호가 올바르지 않습니다.")?
            .pixels;
        if Arc::get_mut(pixels).is_none() {
            *pixels = Arc::new(owned_copy(pixels)?);
        }
        Ok(Arc::get_mut(pixels).expect("unique owned pixel buffer"))
    }

    pub fn composite(&self) -> EngineResult<Vec<u8>> {
        self.composite_region(0, 0, self.width, self.height)
    }

    pub fn composite_region(
        &self,
        left: u32,
        top: u32,
        width: u32,
        height: u32,
    ) -> EngineResult<Vec<u8>> {
        self.validate()?;
        if width == 0
            || height == 0
            || self
                .width
                .checked_sub(left)
                .is_none_or(|remaining| width > remaining)
            || self
                .height
                .checked_sub(top)
                .is_none_or(|remaining| height > remaining)
        {
            return Err("합성할 이미지 영역이 올바르지 않습니다.".into());
        }
        let mut out = zeroed(width as usize * height as usize * 4)?;
        let row_bytes = width as usize * 4;
        for layer in &self.layers {
            if !layer.visible {
                continue;
            }
            for (row, target) in out.chunks_exact_mut(row_bytes).enumerate() {
                let index = ((top as usize + row) * self.width as usize + left as usize) * 4;
                let source = &layer.pixels[index..index + row_bytes];
                for (pixel, &origin) in target
                    .as_chunks_mut::<4>()
                    .0
                    .iter_mut()
                    .zip(source.as_chunks::<4>().0)
                {
                    source_over(pixel, origin);
                }
            }
        }
        Ok(out)
    }

    fn raw_bytes(&self) -> usize {
        self.layers.iter().map(|layer| layer.pixels.len()).sum()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PixelPatch {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Region {
    pub left: u32,
    pub top: u32,
    pub width: u32,
    pub height: u32,
}

impl Region {
    const EMPTY: Self = Self {
        left: 0,
        top: 0,
        width: 0,
        height: 0,
    };

    fn include(&mut self, other: Self) {
        if other.width == 0 || other.height == 0 {
            return;
        }
        if self.width == 0 {
            *self = other;
            return;
        }
        let left = self.left.min(other.left);
        let top = self.top.min(other.top);
        self.width = (self.left + self.width).max(other.left + other.width) - left;
        self.height = (self.top + self.height).max(other.top + other.height) - top;
        self.left = left;
        self.top = top;
    }
}

#[derive(Clone, Copy)]
struct Rectangle {
    x: usize,
    y: usize,
    width: usize,
    height: usize,
}

impl Rectangle {
    fn region(self) -> Region {
        Region {
            left: self.x as u32,
            top: self.y as u32,
            width: self.width as u32,
            height: self.height as u32,
        }
    }

    fn read(self, image: &[u8], stride: usize) -> EngineResult<Vec<u8>> {
        let mut pixels = Vec::new();
        let row_bytes = self.width * 4;
        pixels
            .try_reserve_exact(row_bytes * self.height)
            .map_err(reserve_error)?;
        for row in self.y..self.y + self.height {
            let start = (row * stride + self.x) * 4;
            pixels.extend_from_slice(&image[start..start + row_bytes]);
        }
        Ok(pixels)
    }

    fn write(self, image: &mut [u8], stride: usize, pixels: &[u8]) {
        let row_bytes = self.width * 4;
        for (row, source) in pixels.chunks_exact(row_bytes).enumerate() {
            let start = ((self.y + row) * stride + self.x) * 4;
            image[start..start + row_bytes].copy_from_slice(source);
        }
    }
}

struct PixelChange {
    rect: Rectangle,
    before: Vec<u8>,
    after: Vec<u8>,
}

struct MetadataFrame {
    background: Color,
    active: usize,
    layers: Vec<(String, bool)>,
}

impl MetadataFrame {
    fn from_state(state: &State) -> Self {
        Self {
            background: state.background,
            active: state.active,
            layers: state
                .layers
                .iter()
                .map(|layer| (layer.name.clone(), layer.visible))
                .collect(),
        }
    }

    fn applied(&self, state: &State, order: &[usize]) -> State {
        State {
            width: state.width,
            height: state.height,
            background: self.background,
            active: self.active,
            layers: order
                .iter()
                .zip(&self.layers)
                .map(|(&index, (name, visible))| Layer {
                    name: name.clone(),
                    visible: *visible,
                    pixels: Arc::clone(&state.layers[index].pixels),
                })
                .collect(),
        }
    }
}

enum Edit {
    Snapshot {
        before: State,
        after: State,
    },
    Metadata {
        before: MetadataFrame,
        after: MetadataFrame,
        forward: Vec<usize>,
        reverse: Vec<usize>,
    },
    Pixels {
        layer: usize,
        was_visible: bool,
        patches: Vec<PixelChange>,
    },
}

struct Change {
    label: String,
    before_revision: u64,
    after_revision: u64,
    bytes: usize,
    edit: Edit,
}

pub struct PreparedState {
    document: u64,
    revision: u64,
    next_revision: u64,
    visual_generation: u64,
    active: usize,
    label: String,
    candidate: State,
    bytes: usize,
    edit: Edit,
}

pub struct PaintDocument {
    identity: u64,
    state: State,
    revision: u64,
    next_revision: u64,
    saved_revision: u64,
    visual_generation: u64,
    visual_dirty: Option<Region>,
    history: VecDeque<Change>,
    cursor: usize,
    history_bytes: usize,
    history_budget: usize,
    stroke: Option<ActiveStroke>,
}

impl PaintDocument {
    pub fn new(state: State) -> EngineResult<Self> {
        state.validate()?;
        Ok(Self {
            identity: NEXT_DOCUMENT.fetch_add(1, Ordering::Relaxed),
            state,
            revision: 1,
            next_revision: 2,
            saved_revision: 1,
            visual_generation: 1,
            visual_dirty: None,
            history: VecDeque::new(),
            cursor: 0,
            history_bytes: 0,
            history_budget: HISTORY_BYTES,
            stroke: None,
        })
    }

    pub fn state(&self) -> &State {
        &self.state
    }

    pub fn dirty(&self) -> bool {
        self.revision != self.saved_revision
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn visual_generation(&self) -> u64 {
        self.visual_generation
    }

    /// Returns the accumulated dirty extent. None signals full invalidation.
    pub fn last_visual_dirty(&self) -> Option<Region> {
        self.visual_dirty
    }

    /// Consumes the accumulated dirty extent. A zero-sized region means no changes.
    pub fn take_visual_dirty(&mut self) -> Option<Region> {
        self.visual_dirty.replace(Region::EMPTY)
    }

    fn invalidate_visual(&mut self, changed: Option<Region>) {
        match (&mut self.visual_dirty, changed) {
            (Some(dirty), Some(region)) => dirty.include(region),
            (_, None) => self.visual_dirty = None,
            (None, Some(_)) => {}
        }
        self.visual_generation = self.visual_generation.wrapping_add(1);
    }

    pub fn has_stroke(&self) -> bool {
        self.stroke.is_some()
    }

    pub fn mark_saved(&mut self, revision: u64) {
        if revision == self.revision && self.stroke.is_none() {
            self.saved_revision = revision;
        }
    }

    pub fn set_active(&mut self, index: usize) -> EngineResult<()> {
        if index >= self.state.layers.len() || self.stroke.is_some() {
            return Err("활성 레이어를 바꿀 수 없습니다.".into());
        }
        self.state.active = index;
        Ok(())
    }

    pub fn can_undo(&self) -> bool {
        self.stroke.is_some() || self.cursor != 0
    }

    pub fn can_redo(&self) -> bool {
        self.stroke.is_none() && self.cursor < self.history.len()
    }

    pub fn history_bytes(&self) -> usize {
        self.history_bytes
    }

    pub fn retained_bytes(&self) -> usize {
        self.state
            .raw_bytes()
            .saturating_add(self.history_bytes)
            .saturating_add(self.stroke.as_ref().map_or(0, |stroke| {
                stroke
                    .tiles
                    .values()
                    .map(|tile| tile.before.len() + tile.coverage.len())
                    .sum()
            }))
    }

    pub fn undo_label(&self) -> Option<&str> {
        self.cursor
            .checked_sub(1)
            .and_then(|cursor| self.history.get(cursor))
            .map(|change| change.label.as_str())
    }

    fn reserve_history(&mut self) -> EngineResult<()> {
        self.history.try_reserve(1).map_err(reserve_error)?;
        self.next_revision
            .checked_add(1)
            .ok_or_else(|| "문서 변경 번호가 한도를 초과했습니다.".into())
            .map(|_| ())
    }

    fn record(&mut self, label: String, bytes: usize, edit: Edit) {
        while self.history.len() > self.cursor {
            self.history_bytes -= self.history.pop_back().expect("redo change").bytes;
        }
        self.history.push_back(Change {
            label,
            before_revision: self.revision,
            after_revision: self.next_revision,
            bytes,
            edit,
        });
        self.revision = self.next_revision;
        self.next_revision += 1;
        self.history_bytes += bytes;
        self.cursor += 1;
        while self.history.len() > 1
            && (self.history_bytes > self.history_budget || self.history.len() > HISTORY_LIMIT)
        {
            self.history_bytes -= self.history.pop_front().expect("old history change").bytes;
            self.cursor -= 1;
        }
    }

    pub fn prepare_state(
        &mut self,
        label: impl Into<String>,
        candidate: State,
    ) -> EngineResult<Option<PreparedState>> {
        if self.stroke.is_some() {
            return Err("현재 그리기를 마친 뒤 실행하세요.".into());
        }
        candidate.validate()?;
        if candidate == self.state {
            return Ok(None);
        }
        let previous = &self.state;
        let mut matched = [false; MAX_LAYERS];
        let order: Option<Vec<usize>> = if previous.width == candidate.width
            && previous.height == candidate.height
            && previous.layers.len() == candidate.layers.len()
        {
            candidate
                .layers
                .iter()
                .map(|layer| {
                    previous.layers.iter().enumerate().find_map(|(index, old)| {
                        if !matched[index] && Arc::ptr_eq(&layer.pixels, &old.pixels) {
                            matched[index] = true;
                            Some(index)
                        } else {
                            None
                        }
                    })
                })
                .collect()
        } else {
            None
        };
        let (bytes, edit) = if let Some(forward) = order {
            let mut reverse = vec![0; forward.len()];
            for (position, &index) in forward.iter().enumerate() {
                reverse[index] = position;
            }
            let name_bytes = previous
                .layers
                .iter()
                .chain(&candidate.layers)
                .map(|layer| layer.name.encode_utf16().count() * 2)
                .sum::<usize>();
            (
                32 + forward.len() * 10 + name_bytes,
                Edit::Metadata {
                    before: MetadataFrame::from_state(previous),
                    after: MetadataFrame::from_state(&candidate),
                    forward,
                    reverse,
                },
            )
        } else {
            (
                previous.raw_bytes() + candidate.raw_bytes(),
                Edit::Snapshot {
                    before: previous.clone(),
                    after: candidate.clone(),
                },
            )
        };
        self.reserve_history()?;
        Ok(Some(PreparedState {
            document: self.identity,
            revision: self.revision,
            next_revision: self.next_revision,
            visual_generation: self.visual_generation,
            active: self.state.active,
            label: label.into(),
            candidate,
            bytes,
            edit,
        }))
    }

    pub fn apply_prepared(&mut self, prepared: PreparedState) -> EngineResult<bool> {
        if prepared.document != self.identity
            || prepared.revision != self.revision
            || prepared.next_revision != self.next_revision
            || prepared.visual_generation != self.visual_generation
            || prepared.active != self.state.active
            || self.stroke.is_some()
        {
            return Err("준비한 편집의 문서가 변경됐습니다.".into());
        }
        self.state = prepared.candidate;
        self.record(prepared.label, prepared.bytes, prepared.edit);
        self.invalidate_visual(None);
        Ok(true)
    }

    pub fn commit_state(
        &mut self,
        label: impl Into<String>,
        candidate: State,
    ) -> EngineResult<bool> {
        match self.prepare_state(label, candidate)? {
            Some(prepared) => self.apply_prepared(prepared),
            None => Ok(false),
        }
    }

    pub fn replace_pixels(
        &mut self,
        label: impl Into<String>,
        layer: usize,
        source: &PixelPatch,
        over: bool,
    ) -> EngineResult<bool> {
        if self.stroke.is_some() || layer >= self.state.layers.len() {
            return Err("현재 획과 대상 레이어를 확인하세요.".into());
        }
        validate_size(source.width, source.height, 1)?;
        let source_stride = source.width as usize;
        if source.pixels.len() != source_stride * source.height as usize * 4 {
            return Err("픽셀 영역이 올바르지 않습니다.".into());
        }
        let left = i64::from(source.left);
        let top = i64::from(source.top);
        let x = left.max(0);
        let y = top.max(0);
        let right = (left + i64::from(source.width)).min(i64::from(self.state.width));
        let bottom = (top + i64::from(source.height)).min(i64::from(self.state.height));
        if right <= x || bottom <= y {
            return Ok(false);
        }
        let rect = Rectangle {
            x: x as usize,
            y: y as usize,
            width: (right - x) as usize,
            height: (bottom - y) as usize,
        };
        let mut after = Rectangle {
            x: (x - left) as usize,
            y: (y - top) as usize,
            ..rect
        }
        .read(&source.pixels, source_stride)?;
        let stride = self.state.width as usize;
        let previous = &self.state.layers[layer];
        let visible = previous.visible;
        let before = rect.read(&previous.pixels, stride)?;
        if over {
            for (pixels, &original) in after
                .as_chunks_mut::<4>()
                .0
                .iter_mut()
                .zip(before.as_chunks::<4>().0)
            {
                let color = *pixels;
                *pixels = original;
                source_over(pixels, color);
            }
        }
        if after == before && visible {
            return Ok(false);
        }
        self.reserve_history()?;
        let label = label.into();
        let bytes = before.len() + after.len();
        let patches = vec![PixelChange {
            rect,
            before,
            after,
        }];
        let pixels = self.state.try_pixels_mut(layer)?;
        rect.write(pixels, stride, &patches[0].after);
        self.state.layers[layer].visible = true;
        self.record(
            label,
            bytes,
            Edit::Pixels {
                layer,
                was_visible: visible,
                patches,
            },
        );
        self.invalidate_visual(visible.then(|| rect.region()));
        Ok(true)
    }

    pub fn begin_stroke(
        &mut self,
        x: f64,
        y: f64,
        settings: BrushSettings,
        pressure: f64,
    ) -> EngineResult<()> {
        if self.stroke.is_some() {
            return Err("이미 그리는 중입니다.".into());
        }
        let layer = self.state.active;
        let stroke = ActiveStroke::new(x, y, settings, pressure, &self.state)?;
        if !stroke.was_visible {
            self.invalidate_visual(None);
        }
        self.stroke = Some(stroke);
        self.state.layers[layer].visible = true;
        self.move_stroke(x, y, pressure, false)
    }

    pub fn move_stroke(&mut self, x: f64, y: f64, pressure: f64, finish: bool) -> EngineResult<()> {
        let Some(mut stroke) = self.stroke.take() else {
            return Ok(());
        };
        let outcome = stroke.paint(&mut self.state, x, y, pressure, finish);
        let region = stroke.segment_dirty;
        self.stroke = Some(stroke);
        if outcome.is_err() {
            self.cancel_stroke();
        } else {
            self.invalidate_visual(Some(region));
        }
        outcome
    }

    pub fn end_stroke(&mut self, x: f64, y: f64) -> EngineResult<bool> {
        let Some(stroke) = &self.stroke else {
            return Ok(false);
        };
        if stroke.needs_end_sample(x, y) {
            self.move_stroke(x, y, stroke.force, true)?;
        }
        let mut stroke = self.stroke.take().expect("active stroke");
        let preparation = (|| {
            self.reserve_history()?;
            let pixels = &self.state.layers[stroke.layer].pixels;
            let stride = self.state.width as usize;
            let mut destinations = Vec::new();
            destinations
                .try_reserve_exact(stroke.tiles.len())
                .map_err(reserve_error)?;
            for (&id, tile) in &stroke.tiles {
                let after = tile.rect.read(pixels, stride)?;
                if after != tile.before {
                    destinations.push((id, after));
                }
            }
            let mut patches = Vec::new();
            patches
                .try_reserve_exact(destinations.len())
                .map_err(reserve_error)?;
            for (id, after) in destinations {
                let StrokeTile { rect, before, .. } =
                    stroke.tiles.remove(&id).expect("captured stroke tile");
                patches.push(PixelChange {
                    rect,
                    before,
                    after,
                });
            }
            Ok::<_, String>(patches)
        })();
        let patches = match preparation {
            Ok(patches) => patches,
            Err(error) => {
                self.stroke = Some(stroke);
                self.cancel_stroke();
                return Err(error);
            }
        };
        if patches.is_empty()
            && (stroke.was_visible || (stroke.tiles.is_empty() && !stroke.inside_canvas))
        {
            self.state.layers[stroke.layer].visible = stroke.was_visible;
            if !stroke.was_visible {
                self.invalidate_visual(None);
            }
            return Ok(false);
        }
        let bytes = patches
            .iter()
            .map(|patch| patch.before.len() + patch.after.len())
            .sum();
        self.record(
            if stroke.settings.match_color.is_some() {
                "색 교체"
            } else {
                "그리기"
            }
            .into(),
            bytes,
            Edit::Pixels {
                layer: stroke.layer,
                was_visible: stroke.was_visible,
                patches,
            },
        );
        Ok(true)
    }

    pub fn cancel_stroke(&mut self) -> bool {
        let Some(stroke) = self.stroke.take() else {
            return false;
        };
        if !stroke.tiles.is_empty() {
            let stride = self.state.width as usize;
            let Ok(pixels) = self.state.try_pixels_mut(stroke.layer) else {
                self.stroke = Some(stroke);
                return false;
            };
            for tile in stroke.tiles.values() {
                tile.rect.write(pixels, stride, &tile.before);
            }
        }
        self.state.layers[stroke.layer].visible = stroke.was_visible;
        let mut region = Region::EMPTY;
        for tile in stroke.tiles.values() {
            region.include(tile.rect.region());
        }
        self.invalidate_visual(stroke.was_visible.then_some(region));
        true
    }

    pub fn undo(&mut self) -> bool {
        if self.stroke.is_some() {
            return self.cancel_stroke();
        }
        let Some(cursor) = self.cursor.checked_sub(1) else {
            return false;
        };
        if Self::apply_change(&mut self.state, &self.history[cursor], false).is_err() {
            return false;
        }
        self.revision = self.history[cursor].before_revision;
        self.cursor = cursor;
        self.invalidate_visual(Self::change_region(&self.history[cursor]));
        true
    }

    pub fn redo(&mut self) -> bool {
        if !self.can_redo()
            || Self::apply_change(&mut self.state, &self.history[self.cursor], true).is_err()
        {
            return false;
        }
        let dirty = Self::change_region(&self.history[self.cursor]);
        self.revision = self.history[self.cursor].after_revision;
        self.cursor += 1;
        self.invalidate_visual(dirty);
        true
    }

    fn apply_change(state: &mut State, change: &Change, forward: bool) -> EngineResult<()> {
        match &change.edit {
            Edit::Snapshot { before, after } => {
                *state = (if forward { after } else { before }).clone()
            }
            Edit::Metadata {
                before,
                after,
                forward: order,
                reverse,
            } => {
                *state = if forward {
                    after.applied(state, order)
                } else {
                    before.applied(state, reverse)
                };
            }
            Edit::Pixels {
                layer,
                was_visible,
                patches,
            } => {
                let stride = state.width as usize;
                if !patches.is_empty() {
                    let pixels = state.try_pixels_mut(*layer)?;
                    for patch in patches {
                        patch.rect.write(
                            pixels,
                            stride,
                            if forward { &patch.after } else { &patch.before },
                        );
                    }
                }
                state.layers[*layer].visible = forward || *was_visible;
            }
        }
        Ok(())
    }

    fn change_region(change: &Change) -> Option<Region> {
        match &change.edit {
            Edit::Pixels {
                was_visible: true,
                patches,
                ..
            } => {
                let mut dirty = Region::EMPTY;
                for patch in patches {
                    dirty.include(patch.rect.region());
                }
                Some(dirty)
            }
            _ => None,
        }
    }
}
