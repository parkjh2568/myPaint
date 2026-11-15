use std::sync::Arc;

use crate::engine::{
    BrushSettings, Color, EngineResult, Layer, PaintDocument, PreparedState, State,
    apply_selection_mask, crop_state, flood, resize_state, shear_state, snap_line_delta,
    source_over, transform_state, validate_size,
};

#[path = "editor/shape.rs"]
mod shape;

const TAB_COUNT_LIMIT: usize = 12;
const TAB_HISTORY_LIMIT: usize = 512 * 1024 * 1024;
const MAX_ZOOM: f64 = 64.0;
const MIN_ZOOM: f64 = 32.0 / 32768.0;
const MAX_PATH_POINTS: usize = 65_536;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Tool {
    #[default]
    Brush,
    Pencil,
    Eraser,
    Fill,
    Picker,
    Spray,
    ColorEraser,
    Line,
    Curve,
    Rectangle,
    RoundRect,
    Ellipse,
    Polygon,
    Select,
    Lasso,
    Text,
    Pan,
}

impl Tool {
    pub const ALL: [Self; 17] = [
        Self::Brush,
        Self::Pencil,
        Self::Eraser,
        Self::Fill,
        Self::Picker,
        Self::Spray,
        Self::ColorEraser,
        Self::Line,
        Self::Curve,
        Self::Rectangle,
        Self::RoundRect,
        Self::Ellipse,
        Self::Polygon,
        Self::Select,
        Self::Lasso,
        Self::Text,
        Self::Pan,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::Brush => "브러시",
            Self::Pencil => "연필",
            Self::Eraser => "지우개",
            Self::Fill => "채우기",
            Self::Picker => "스포이트",
            Self::Spray => "스프레이",
            Self::ColorEraser => "지정 색 교체",
            Self::Line => "직선",
            Self::Curve => "곡선",
            Self::Rectangle => "사각형",
            Self::RoundRect => "둥근 사각형",
            Self::Ellipse => "타원",
            Self::Polygon => "다각형",
            Self::Select => "사각 선택",
            Self::Lasso => "자유 선택",
            Self::Text => "문자",
            Self::Pan => "화면 이동",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ToolSettings {
    pub tool: Tool,
    pub foreground: Color,
    pub secondary: Color,
    pub size: f64,
    pub opacity: f64,
    pub hardness: f64,
    pub stabilization: f64,
    pub pressure: bool,
    pub square: bool,
    pub fill_shape: bool,
    pub outline_shape: bool,
    pub transparent_selection: bool,
    pub eraser_background: Option<Color>,
    pub finger_draw: bool,
    pub font_size: u16,
    pub font_family: String,
    pub font_bold: bool,
    pub font_italic: bool,
    pub text_background: bool,
}

impl Default for ToolSettings {
    fn default() -> Self {
        Self {
            tool: Tool::Brush,
            foreground: [22, 121, 234, 255],
            secondary: [255; 4],
            size: 12.0,
            opacity: 1.0,
            hardness: 1.0,
            stabilization: 25.0,
            pressure: true,
            square: false,
            fill_shape: false,
            outline_shape: true,
            transparent_selection: false,
            eraser_background: None,
            finger_draw: true,
            font_size: 24,
            font_family: "sans-serif".into(),
            font_bold: false,
            font_italic: false,
            text_background: false,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Viewport {
    pub zoom: f64,
    pub offset_x: f64,
    pub offset_y: f64,
    pub width: f64,
    pub height: f64,
    pub auto_fit: bool,
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            zoom: 1.0,
            offset_x: 0.0,
            offset_y: 0.0,
            width: 0.0,
            height: 0.0,
            auto_fit: true,
        }
    }
}

impl Viewport {
    pub fn document_point(self, x: f64, y: f64) -> (f64, f64) {
        (
            (x - self.offset_x) / self.zoom,
            (y - self.offset_y) / self.zoom,
        )
    }

    pub fn screen_point(self, x: f64, y: f64) -> (f64, f64) {
        (x * self.zoom + self.offset_x, y * self.zoom + self.offset_y)
    }

    pub fn zoom_at(&mut self, zoom: f64, x: f64, y: f64) {
        if !zoom.is_finite() || !x.is_finite() || !y.is_finite() {
            return;
        }
        let (anchor_x, anchor_y) = self.document_point(x, y);
        self.zoom = zoom.clamp(MIN_ZOOM, MAX_ZOOM);
        self.offset_x = x - anchor_x * self.zoom;
        self.offset_y = y - anchor_y * self.zoom;
        self.auto_fit = false;
    }

    pub fn fit(&mut self, width: u32, height: u32) {
        if self.width <= 0.0 || self.height <= 0.0 {
            return;
        }
        self.zoom = ((self.width - 32.0) / f64::from(width))
            .min((self.height - 32.0) / f64::from(height))
            .clamp(MIN_ZOOM, 1.0);
        self.offset_x = (self.width - f64::from(width) * self.zoom) / 2.0;
        self.offset_y = (self.height - f64::from(height) * self.zoom) / 2.0;
        self.auto_fit = true;
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Raster {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl Raster {
    pub fn validate(&self) -> EngineResult<()> {
        validate_size(self.width, self.height, 1)?;
        if self.pixels.len() != self.width as usize * self.height as usize * 4 {
            return Err("이미지 픽셀 길이가 올바르지 않습니다.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Sample {
    pub x: f64,
    pub y: f64,
    pub pressure: f64,
    pub pen: bool,
    pub shift: bool,
}

impl Sample {
    fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.pressure.is_finite()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PointerButton {
    Primary,
    Secondary,
    Middle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PointerAction {
    None,
    TextRequested { x: i32, y: i32 },
}

#[derive(Clone, Copy, Debug)]
pub enum CanvasEdge {
    East,
    South,
    SouthEast,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Region {
    fn clipped(x: f64, y: f64, right: f64, bottom: f64, state: &State) -> Option<Self> {
        let left = x.floor().clamp(0.0, f64::from(state.width)) as i32;
        let top = y.floor().clamp(0.0, f64::from(state.height)) as i32;
        let right = right.ceil().clamp(0.0, f64::from(state.width)) as i32;
        let bottom = bottom.ceil().clamp(0.0, f64::from(state.height)) as i32;
        if right <= left || bottom <= top {
            return None;
        }
        Some(Self {
            x: left,
            y: top,
            width: (right - left) as u32,
            height: (bottom - top) as u32,
        })
    }

    fn contains(self, sample: Sample) -> bool {
        sample.x >= f64::from(self.x)
            && sample.y >= f64::from(self.y)
            && sample.x <= f64::from(self.x) + f64::from(self.width)
            && sample.y <= f64::from(self.y) + f64::from(self.height)
    }
}

#[derive(Clone)]
struct Selection {
    region: Region,
    pixels: Arc<Vec<u8>>,
    source: Option<Region>,
    mask: Option<Arc<Vec<u8>>>,
    modified: bool,
    original_pixels: Option<Arc<Vec<u8>>>,
    resize_source: Option<(u32, u32, Arc<Vec<u8>>)>,
}

struct TextDraft {
    x: i32,
    y: i32,
    raster: Option<Raster>,
    composing: bool,
}

#[derive(Clone)]
struct ShapeDraft {
    tool: Tool,
    points: Vec<Sample>,
    controls: Vec<Sample>,
    secondary: bool,
}

enum Drag {
    Stroke {
        last: Sample,
        spray: bool,
    },
    Pan {
        grab_x: f64,
        grab_y: f64,
    },
    CanvasResize {
        edge: CanvasEdge,
        start: Sample,
        width: u32,
        height: u32,
    },
    Select {
        start: Sample,
        last: Sample,
    },
    Lasso(Vec<(f64, f64)>),
    Move {
        original: Selection,
        grab_x: f64,
        grab_y: f64,
    },
    Resize {
        original: Selection,
        width: u32,
        height: u32,
    },
    Shape(ShapeDraft),
    CurveControl {
        at: Sample,
        secondary: bool,
    },
    PolygonPoint {
        at: Sample,
        secondary: bool,
    },
}

pub struct DocumentTab {
    pub id: u64,
    pub name: String,
    pub document: PaintDocument,
    pub viewport: Viewport,
}

pub enum LayerEdit {
    Add,
    Delete,
    Up,
    Down,
    Merge,
    Clear,
    Invert,
    Rename(String),
    SetVisible { index: usize, visible: bool },
    Background(Color),
}

pub struct Editor {
    pub tabs: Vec<DocumentTab>,
    pub settings: ToolSettings,
    active: usize,
    next_tab: u64,
    drag: Option<Drag>,
    selection: Option<Selection>,
    text: Option<TextDraft>,
    shape: Option<ShapeDraft>,
    random_state: u64,
}

impl Editor {
    pub fn new() -> EngineResult<Self> {
        let document = PaintDocument::new(State::new(800, 600, [0, 0, 0, 0])?)?;
        Ok(Self {
            tabs: vec![DocumentTab {
                id: 1,
                name: "제목 없음".into(),
                document,
                viewport: Viewport::default(),
            }],
            settings: ToolSettings::default(),
            active: 0,
            next_tab: 2,
            drag: None,
            selection: None,
            text: None,
            shape: None,
            random_state: 0x5E7F_955A_14A2_5931,
        })
    }

    pub fn active_tab(&self) -> &DocumentTab {
        &self.tabs[self.active]
    }

    pub fn active_tab_mut(&mut self) -> &mut DocumentTab {
        &mut self.tabs[self.active]
    }

    pub fn document(&self) -> &PaintDocument {
        &self.active_tab().document
    }

    pub fn document_mut(&mut self) -> &mut PaintDocument {
        &mut self.active_tab_mut().document
    }

    pub fn viewport(&self) -> &Viewport {
        &self.active_tab().viewport
    }

    pub fn viewport_mut(&mut self) -> &mut Viewport {
        &mut self.active_tab_mut().viewport
    }

    pub fn resize_view(&mut self, width: f64, height: f64) {
        if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return;
        }
        let v = self.viewport_mut();
        if v.width == width && v.height == height {
            return;
        }
        if !v.auto_fit {
            v.offset_x += (width - v.width) / 2.0;
            v.offset_y += (height - v.height) / 2.0;
        }
        v.width = width;
        v.height = height;
        if v.auto_fit {
            self.fit();
        }
    }

    pub fn fit(&mut self) {
        let state = self.document().state();
        let (width, height) = (state.width, state.height);
        self.viewport_mut().fit(width, height);
    }

    pub fn zoom_at(&mut self, zoom: f64, x: f64, y: f64) {
        if self.drag.is_none() {
            self.viewport_mut().zoom_at(zoom, x, y);
        }
    }

    pub fn has_pending(&self) -> bool {
        self.selection.is_some() || self.text.is_some() || self.shape.is_some()
    }

    pub fn has_active_gesture(&self) -> bool {
        self.drag.is_some()
    }

    pub fn lasso_path(&self) -> Option<&[(f64, f64)]> {
        if let Some(Drag::Lasso(path)) = &self.drag {
            return Some(path);
        }
        None
    }

    pub fn selection_region(&self) -> Option<Region> {
        if let Some(Drag::Resize {
            original,
            width,
            height,
        }) = self.drag.as_ref()
        {
            return Some(Region {
                width: *width,
                height: *height,
                ..original.region
            });
        }
        if let Some(Drag::Select { start, last }) = self.drag.as_ref() {
            return self.selection_bounds(*start, *last);
        }
        self.selection.as_ref().map(|selection| selection.region)
    }

    pub fn choose_tool(&mut self, tool: Tool) -> EngineResult<bool> {
        self.ensure_no_gesture()?;
        let changed = self.commit_pending()?;
        self.settings.tool = tool;
        Ok(changed)
    }

    pub fn pointer_down(
        &mut self,
        sample: Sample,
        button: PointerButton,
    ) -> EngineResult<PointerAction> {
        if self.drag.is_some() || !sample.is_finite() {
            return Ok(PointerAction::None);
        }

        let tool = self.settings.tool;
        if button == PointerButton::Middle || tool == Tool::Pan {
            let v = self.viewport();
            self.drag = Some(Drag::Pan {
                grab_x: sample.x - v.offset_x,
                grab_y: sample.y - v.offset_y,
            });
            return Ok(PointerAction::None);
        }

        let point = self.document_sample(sample);
        if matches!(tool, Tool::Select | Tool::Lasso)
            && let Some(selection) = &self.selection
            && selection.region.contains(point)
        {
            let region = selection.region;
            let handle = 12.0 / self.viewport().zoom;
            self.drag = Some(
                if f64::from(region.x) + f64::from(region.width) - point.x < handle
                    && f64::from(region.y) + f64::from(region.height) - point.y < handle
                {
                    Drag::Resize {
                        original: selection.clone(),
                        width: region.width,
                        height: region.height,
                    }
                } else {
                    Drag::Move {
                        original: selection.clone(),
                        grab_x: point.x - f64::from(region.x),
                        grab_y: point.y - f64::from(region.y),
                    }
                },
            );
            return Ok(PointerAction::None);
        }

        let secondary = button == PointerButton::Secondary;
        if self.shape.as_ref().is_some_and(|draft| draft.tool == tool) {
            match tool {
                Tool::Curve => {
                    self.drag = Some(Drag::CurveControl {
                        at: point,
                        secondary,
                    })
                }
                Tool::Polygon => {
                    self.drag = Some(Drag::PolygonPoint {
                        at: point,
                        secondary,
                    })
                }
                _ => {}
            }
            if self.drag.is_some() {
                return Ok(PointerAction::None);
            }
        }

        self.commit_pending()?;
        let color = if secondary {
            self.settings.secondary
        } else {
            self.settings.foreground
        };
        match tool {
            Tool::Brush | Tool::Pencil | Tool::Eraser | Tool::ColorEraser | Tool::Spray => {
                let settings = self.brush_settings(tool, color, point.pen);
                self.document_mut().begin_stroke(
                    point.x,
                    point.y,
                    settings,
                    if point.pen { point.pressure } else { 1.0 },
                )?;
                self.drag = Some(Drag::Stroke {
                    last: point,
                    spray: tool == Tool::Spray,
                });
            }
            Tool::Fill => {
                let state = self.document().state();
                let layer = state.active;
                if let Some(patch) = flood(
                    &state.layers[layer].pixels,
                    state.width,
                    state.height,
                    point.x.floor(),
                    point.y.floor(),
                    color,
                )? {
                    self.document_mut()
                        .replace_pixels("색상 처리", layer, &patch, false)?;
                }
            }
            Tool::Picker => {
                if let Some(color) = self.color_at(point) {
                    self.settings.foreground = color;
                }
            }
            Tool::Text => {
                let (x, y) = (point.x.floor() as i32, point.y.floor() as i32);
                self.text = Some(TextDraft {
                    x,
                    y,
                    raster: None,
                    composing: false,
                });
                return Ok(PointerAction::TextRequested { x, y });
            }
            Tool::Select => {
                self.drag = Some(Drag::Select {
                    start: point,
                    last: point,
                })
            }
            Tool::Lasso => self.drag = Some(Drag::Lasso(vec![(point.x.floor(), point.y.floor())])),
            Tool::Polygon => {
                self.drag = Some(Drag::PolygonPoint {
                    at: point,
                    secondary,
                })
            }
            Tool::Line | Tool::Curve | Tool::Rectangle | Tool::RoundRect | Tool::Ellipse => {
                self.drag = Some(Drag::Shape(ShapeDraft {
                    tool,
                    points: vec![point, point],
                    controls: Vec::new(),
                    secondary,
                }));
            }
            Tool::Pan => {}
        }
        Ok(PointerAction::None)
    }

    pub fn pointer_move(&mut self, sample: Sample) -> EngineResult<()> {
        self.update_pointer(sample, false)
    }

    pub fn begin_canvas_resize(&mut self, sample: Sample, edge: CanvasEdge) -> EngineResult<()> {
        self.ensure_no_gesture()?;
        if !sample.is_finite() {
            return Err("포인터 좌표가 올바르지 않습니다.".into());
        }
        let state = self.document().state();
        self.drag = Some(Drag::CanvasResize {
            edge,
            start: self.document_sample(sample),
            width: state.width,
            height: state.height,
        });
        Ok(())
    }

    pub fn canvas_resize_size(&self) -> Option<(u32, u32)> {
        if let Some(Drag::CanvasResize { width, height, .. }) = self.drag {
            return Some((width, height));
        }
        None
    }

    pub fn pointer_up(&mut self, sample: Sample) -> EngineResult<bool> {
        self.update_pointer(sample, true)?;
        match self.drag.take() {
            Some(Drag::Stroke { last, .. }) => {
                let result = self.document_mut().end_stroke(last.x, last.y);
                if result.is_err() {
                    self.document_mut().cancel_stroke();
                }
                result
            }
            Some(Drag::Select { start, last }) => {
                if let Some(region) = self.selection_bounds(start, last) {
                    self.capture_selection(region, None)?;
                }
                Ok(false)
            }
            Some(Drag::CanvasResize { width, height, .. }) => {
                let original = self.document().state();
                if original.width == width && original.height == height {
                    return Ok(false);
                }
                let changed = self.edit_state("캔버스 크기 변경", |state| {
                    resize_state(&state, width, height, false, false)
                })?;
                self.viewport_mut().auto_fit = false;
                Ok(changed)
            }
            Some(Drag::Lasso(path)) => {
                if path.len() >= 3 {
                    let (left, top, right, bottom) = path.iter().fold(
                        (
                            f64::INFINITY,
                            f64::INFINITY,
                            f64::NEG_INFINITY,
                            f64::NEG_INFINITY,
                        ),
                        |(l, t, r, b), (x, y)| (l.min(*x), t.min(*y), r.max(*x), b.max(*y)),
                    );
                    if let Some(region) =
                        Region::clipped(left, top, right, bottom, self.document().state())
                    {
                        self.capture_selection(region, Some(&path))?;
                    }
                }
                Ok(false)
            }
            Some(Drag::Resize {
                original,
                width,
                height,
            }) => {
                if width != original.region.width || height != original.region.height {
                    self.resize_selection(width, height)?;
                }
                Ok(false)
            }
            Some(Drag::Shape(draft)) if draft.tool == Tool::Curve => {
                self.shape = Some(draft);
                Ok(false)
            }
            Some(Drag::Shape(draft)) => {
                let mut state = self.document().state().clone();
                shape::apply(&draft, &self.settings, &mut state)?;
                self.commit_candidate("도형", state)
            }
            Some(Drag::CurveControl { at, secondary }) => {
                let Some(mut draft) = self.shape.clone() else {
                    return Ok(false);
                };
                draft.controls.push(at);
                draft.secondary = secondary;
                if draft.controls.len() < 2 {
                    self.shape = Some(draft);
                    return Ok(false);
                }
                let mut state = self.document().state().clone();
                shape::apply(&draft, &self.settings, &mut state)?;
                self.commit_candidate("도형", state)
            }
            Some(Drag::PolygonPoint { at, secondary }) => {
                let draft = self.shape.get_or_insert_with(|| ShapeDraft {
                    tool: Tool::Polygon,
                    points: Vec::new(),
                    controls: Vec::new(),
                    secondary,
                });
                if draft
                    .points
                    .last()
                    .is_none_or(|p| p.x != at.x || p.y != at.y)
                {
                    if draft.points.len() == MAX_PATH_POINTS {
                        return Err("다각형 점 수가 너무 많습니다.".into());
                    }
                    draft.points.push(at);
                }
                draft.secondary = secondary;
                Ok(false)
            }
            _ => Ok(false),
        }
    }

    pub fn cancel_pointer(&mut self) -> bool {
        match self.drag.take() {
            Some(Drag::Move { original, .. } | Drag::Resize { original, .. }) => {
                self.selection = Some(original);
                true
            }
            Some(Drag::Stroke { .. }) => {
                self.document_mut().cancel_stroke();
                true
            }
            Some(_) => true,
            None => self.document_mut().cancel_stroke(),
        }
    }

    pub fn spray_active(&self) -> bool {
        matches!(self.drag, Some(Drag::Stroke { spray: true, .. }))
    }

    pub fn spray_tick(&mut self) -> EngineResult<bool> {
        let Some(Drag::Stroke { last, spray: true }) = self.drag else {
            return Ok(false);
        };
        let size = self.settings.size.clamp(1.0, 100.0);
        for _ in 0..(size * 2.0) as usize {
            let angle = self.random_fraction() * std::f64::consts::TAU;
            let radius = self.random_fraction().sqrt() * size;
            let (sine, cosine) = angle.sin_cos();
            if let Err(error) = self.document_mut().move_stroke(
                last.x + cosine * radius,
                last.y + sine * radius,
                1.0,
                true,
            ) {
                self.cancel_pointer();
                return Err(error);
            }
        }
        Ok(true)
    }

    fn update_pointer(&mut self, sample: Sample, finish: bool) -> EngineResult<()> {
        if !sample.is_finite() {
            self.cancel_pointer();
            return Err("포인터 좌표가 올바르지 않습니다.".into());
        }
        let point = self.document_sample(sample);
        let Some(mut drag) = self.drag.take() else {
            return Ok(());
        };
        let result = match &mut drag {
            Drag::Stroke { last, spray } => {
                let pressure = if point.pen && (!finish || point.pressure > 0.0) {
                    point.pressure
                } else if point.pen {
                    last.pressure
                } else {
                    1.0
                };
                *last = point;
                if *spray {
                    Ok(())
                } else {
                    self.document_mut()
                        .move_stroke(point.x, point.y, pressure, finish)
                }
            }
            Drag::Pan { grab_x, grab_y } => {
                let viewport = self.viewport_mut();
                viewport.offset_x = sample.x - *grab_x;
                viewport.offset_y = sample.y - *grab_y;
                viewport.auto_fit = false;
                Ok(())
            }
            Drag::CanvasResize {
                edge,
                start,
                width,
                height,
            } => {
                let state = self.document().state();
                let proposed_width = if matches!(edge, CanvasEdge::East | CanvasEdge::SouthEast) {
                    (f64::from(state.width) + (point.x - start.x + 0.5).floor()).clamp(1.0, 32768.0)
                        as u32
                } else {
                    state.width
                };
                let proposed_height = if matches!(edge, CanvasEdge::South | CanvasEdge::SouthEast) {
                    (f64::from(state.height) + (point.y - start.y + 0.5).floor())
                        .clamp(1.0, 32768.0) as u32
                } else {
                    state.height
                };
                // Keep the last valid extent so releasing an out-of-bounds drag stays safe.
                if validate_size(proposed_width, proposed_height, state.layers.len()).is_ok() {
                    *width = proposed_width;
                    *height = proposed_height;
                }
                Ok(())
            }
            Drag::Select { last, .. } => {
                *last = point;
                Ok(())
            }
            Drag::Lasso(path) => {
                let point = (point.x.floor(), point.y.floor());
                if path.last() != Some(&point) {
                    if path.len() == MAX_PATH_POINTS {
                        return Err("자유 선택 점 수가 너무 많습니다.".into());
                    }
                    path.push(point);
                }
                Ok(())
            }
            Drag::Move {
                original,
                grab_x,
                grab_y,
            } => {
                let region = Region {
                    x: (point.x - *grab_x + 0.5).floor() as i32,
                    y: (point.y - *grab_y + 0.5).floor() as i32,
                    ..original.region
                };
                self.move_selection(region)
            }
            Drag::Resize {
                original,
                width,
                height,
            } => {
                let region = Region {
                    width: (point.x - f64::from(original.region.x)).round().max(1.0) as u32,
                    height: (point.y - f64::from(original.region.y)).round().max(1.0) as u32,
                    ..original.region
                };
                self.validate_selection_extent(region).map(|()| {
                    *width = region.width;
                    *height = region.height;
                })
            }
            Drag::Shape(draft) => {
                let mut next = point;
                let origin = draft.points[0];
                if point.shift {
                    let (dx, dy) = (point.x - origin.x, point.y - origin.y);
                    if draft.tool == Tool::Line {
                        let (dx, dy) = snap_line_delta(dx, dy);
                        next.x = origin.x + dx;
                        next.y = origin.y + dy;
                    } else if matches!(
                        draft.tool,
                        Tool::Rectangle | Tool::RoundRect | Tool::Ellipse
                    ) {
                        let distance = dx.abs().max(dy.abs());
                        next.x = origin.x + distance.copysign(dx);
                        next.y = origin.y + distance.copysign(dy);
                    }
                }
                draft.points[1] = next;
                Ok(())
            }
            Drag::CurveControl { at, .. } | Drag::PolygonPoint { at, .. } => {
                *at = point;
                Ok(())
            }
        };
        self.drag = Some(drag);
        if result.is_err() {
            self.cancel_pointer();
        }
        result
    }

    fn document_sample(&self, sample: Sample) -> Sample {
        let (x, y) = self.viewport().document_point(sample.x, sample.y);
        Sample {
            x: x.clamp(-8_000_000.0, 8_000_000.0),
            y: y.clamp(-8_000_000.0, 8_000_000.0),
            ..sample
        }
    }

    fn brush_settings(&self, tool: Tool, color: Color, pen: bool) -> BrushSettings {
        let settings = &self.settings;
        let pixel_tool = matches!(tool, Tool::Pencil | Tool::Spray);
        let color = match tool {
            Tool::Eraser => settings.eraser_background.unwrap_or([0; 4]),
            Tool::ColorEraser => settings.secondary,
            _ => color,
        };
        BrushSettings {
            color,
            size: if pixel_tool { 1.0 } else { settings.size },
            opacity: settings.opacity,
            hardness: if pixel_tool { 1.0 } else { settings.hardness },
            stabilization: if pixel_tool {
                0.0
            } else {
                settings.stabilization
            },
            eraser: tool == Tool::Eraser,
            pressure: pen && settings.pressure,
            square: tool == Tool::Pencil || settings.square,
            pixel: tool == Tool::Spray,
            dabs_only: tool == Tool::Spray,
            match_color: (tool == Tool::ColorEraser).then_some(settings.foreground),
        }
    }

    fn random_fraction(&mut self) -> f64 {
        self.random_state ^= self.random_state << 13;
        self.random_state ^= self.random_state >> 7;
        self.random_state ^= self.random_state << 17;
        (self.random_state >> 11) as f64 / ((1_u64 << 53) as f64)
    }

    fn color_at(&self, point: Sample) -> Option<Color> {
        let state = self.document().state();
        if point.x < 0.0
            || point.y < 0.0
            || point.x >= f64::from(state.width)
            || point.y >= f64::from(state.height)
        {
            return None;
        }
        let i = (point.y.floor() as usize * state.width as usize + point.x.floor() as usize) * 4;
        let mut pixel = [0; 4];
        for layer in state.layers.iter().filter(|layer| layer.visible) {
            source_over(&mut pixel, layer.pixels[i..i + 4].try_into().ok()?);
        }
        Some(pixel)
    }

    fn selection_bounds(&self, start: Sample, last: Sample) -> Option<Region> {
        Region::clipped(
            start.x.min(last.x),
            start.y.min(last.y),
            start.x.max(last.x),
            start.y.max(last.y),
            self.document().state(),
        )
    }

    pub fn open_tab(&mut self, name: String, state: State) -> EngineResult<u64> {
        self.open_tab_with(name, state, |_| Ok(()))
    }

    pub fn open_tab_with(
        &mut self,
        name: String,
        state: State,
        activate: impl FnOnce(u64) -> EngineResult<()>,
    ) -> EngineResult<u64> {
        self.ensure_no_gesture()?;
        state.validate()?;
        self.check_tab_capacity(state.width, state.height, state.layers.len())?;
        let document = PaintDocument::new(state)?;
        let id = self.next_tab;
        let next = id.checked_add(1).ok_or("탭 식별자 범위를 넘었습니다.")?;
        let mut viewport = Viewport {
            width: self.viewport().width,
            height: self.viewport().height,
            ..Viewport::default()
        };
        viewport.fit(document.state().width, document.state().height);
        self.tabs
            .try_reserve(1)
            .map_err(|_| "그림 탭을 열 메모리가 부족합니다.")?;
        let outgoing = self.prepare_pending()?;
        activate(id)?;
        self.apply_pending(outgoing)?;
        self.tabs.push(DocumentTab {
            id,
            name,
            document,
            viewport,
        });
        self.next_tab = next;
        self.active = self.tabs.len() - 1;
        Ok(id)
    }

    pub fn new_tab(&mut self, width: u32, height: u32, background: Color) -> EngineResult<u64> {
        self.check_tab_capacity(width, height, 1)?;
        self.open_tab("제목 없음".into(), State::new(width, height, background)?)
    }

    pub fn activate_tab(&mut self, id: u64) -> EngineResult<Option<u64>> {
        self.activate_tab_with(id, |_| Ok(()))
    }

    pub fn activate_tab_with(
        &mut self,
        id: u64,
        activate: impl FnOnce(u64) -> EngineResult<()>,
    ) -> EngineResult<Option<u64>> {
        self.ensure_no_gesture()?;
        let index = self.tab_index(id)?;
        if index == self.active {
            return Ok(None);
        }
        let prepared = self.prepare_pending()?;
        activate(id)?;
        self.apply_pending(prepared)?;
        let outgoing = self.active_tab();
        let dirty_id = outgoing.document.dirty().then_some(outgoing.id);
        self.active = index;
        Ok(dirty_id)
    }

    pub fn close_tab(&mut self, id: u64, discard: bool) -> EngineResult<bool> {
        self.close_tab_with(id, discard, |_, _| Ok(()))
    }

    pub fn close_tab_with(
        &mut self,
        id: u64,
        discard: bool,
        close: impl FnOnce(u64, u64) -> EngineResult<()>,
    ) -> EngineResult<bool> {
        self.ensure_no_gesture()?;
        let index = self.tab_index(id)?;
        let active = index == self.active;
        if !discard && (self.tabs[index].document.dirty() || (active && self.has_pending())) {
            return Ok(false);
        }
        if self.tabs.len() == 1 {
            let document = PaintDocument::new(State::new(800, 600, [0, 0, 0, 0])?)?;
            let new_id = self.next_tab;
            let next = new_id
                .checked_add(1)
                .ok_or("탭 식별자 범위를 넘었습니다.")?;
            let mut viewport = Viewport {
                width: self.viewport().width,
                height: self.viewport().height,
                ..Viewport::default()
            };
            viewport.fit(800, 600);
            close(id, new_id)?;
            self.tabs[0] = DocumentTab {
                id: new_id,
                name: "제목 없음".into(),
                document,
                viewport,
            };
            self.next_tab = next;
        } else {
            let target = if active {
                if index + 1 < self.tabs.len() {
                    index + 1
                } else {
                    index - 1
                }
            } else {
                self.active
            };
            close(id, self.tabs[target].id)?;
            self.tabs.remove(index);
            if active {
                self.active = index.min(self.tabs.len() - 1);
            } else if index < self.active {
                self.active -= 1;
            }
        }
        if active {
            self.discard_pending();
        }
        Ok(true)
    }

    pub fn preview_state(&self) -> EngineResult<State> {
        let mut state = self.pending_state(true, false)?;
        match self.drag.as_ref() {
            Some(Drag::Shape(draft)) => shape::apply(draft, &self.settings, &mut state)?,
            Some(Drag::CurveControl { at, secondary }) => {
                if let Some(mut draft) = self.shape.clone() {
                    draft.controls.push(*at);
                    draft.secondary = *secondary;
                    state = self.document().state().clone();
                    shape::apply(&draft, &self.settings, &mut state)?;
                }
            }
            Some(Drag::PolygonPoint { at, secondary }) => {
                if let Some(mut draft) = self.shape.clone() {
                    draft.points.push(*at);
                    draft.secondary = *secondary;
                    state = self.document().state().clone();
                    shape::apply(&draft, &self.settings, &mut state)?;
                }
            }
            _ => {}
        }
        Ok(state)
    }

    pub fn commit_pending(&mut self) -> EngineResult<bool> {
        self.ensure_no_gesture()?;
        let prepared = self.prepare_pending()?;
        self.apply_pending(prepared)
    }

    fn prepare_pending(&mut self) -> EngineResult<Option<PreparedState>> {
        if !self.has_pending() {
            return Ok(None);
        }
        let state = self.pending_state(true, true)?;
        let label = self.pending_label();
        self.document_mut().prepare_state(label, state)
    }

    fn pending_label(&self) -> &'static str {
        if self.text.is_some() {
            "문자"
        } else if self.shape.is_some() {
            "도형"
        } else {
            "선택 / 붙여넣기"
        }
    }

    fn apply_pending(&mut self, prepared: Option<PreparedState>) -> EngineResult<bool> {
        let changed = match prepared {
            Some(state) => self.document_mut().apply_prepared(state)?,
            None => false,
        };
        self.discard_pending();
        Ok(changed)
    }

    pub fn discard_pending(&mut self) -> bool {
        let changed = self.has_pending();
        self.selection = None;
        self.text = None;
        self.shape = None;
        changed
    }

    pub fn undo(&mut self) -> bool {
        if self.cancel_pointer() || self.discard_pending() {
            return true;
        }
        self.document_mut().undo()
    }

    pub fn redo(&mut self) -> bool {
        !self.has_pending() && self.drag.is_none() && self.document_mut().redo()
    }

    pub fn set_text_raster(&mut self, raster: Option<Raster>) -> EngineResult<()> {
        if let Some(raster) = &raster {
            raster.validate()?;
        }
        let text = self
            .text
            .as_mut()
            .ok_or("문자를 배치할 위치를 선택하세요.")?;
        text.raster = raster;
        Ok(())
    }

    pub fn set_text_composing(&mut self, composing: bool) {
        if let Some(text) = &mut self.text {
            text.composing = composing;
        }
    }

    fn tab_index(&self, id: u64) -> EngineResult<usize> {
        self.tabs
            .iter()
            .position(|tab| tab.id == id)
            .ok_or_else(|| "열려 있는 그림을 선택하세요.".into())
    }

    fn check_tab_capacity(&self, width: u32, height: u32, layers: usize) -> EngineResult<()> {
        validate_size(width, height, layers)?;
        if self.tabs.len() >= TAB_COUNT_LIMIT {
            return Err("그림 탭은 최대 12개까지 열 수 있습니다.".into());
        }
        let mut retained = width as usize * height as usize * layers * 4;
        for tab in &self.tabs {
            retained = retained.saturating_add(tab.document.retained_bytes());
        }
        if retained > TAB_HISTORY_LIMIT {
            return Err("그림 탭 메모리 한도를 넘었습니다. 다른 그림을 먼저 닫으세요.".into());
        }
        Ok(())
    }

    fn ensure_no_gesture(&self) -> EngineResult<()> {
        if self.drag.is_some() || self.document().has_stroke() {
            return Err("현재 조작을 마친 뒤 실행하세요.".into());
        }
        Ok(())
    }

    fn commit_candidate(&mut self, label: &str, state: State) -> EngineResult<bool> {
        let changed = self.document_mut().commit_state(label, state)?;
        self.discard_pending();
        Ok(changed)
    }

    pub fn select_all(&mut self) -> EngineResult<()> {
        self.choose_tool(Tool::Select)?;
        let state = self.document().state();
        self.capture_selection(
            Region {
                x: 0,
                y: 0,
                width: state.width,
                height: state.height,
            },
            None,
        )
    }

    pub fn nudge_selection(&mut self, x: i32, y: i32) -> EngineResult<()> {
        self.ensure_no_gesture()?;
        let Some(selection) = &self.selection else {
            return Ok(());
        };
        let original = selection.region;
        self.move_selection(Region {
            x: original.x.saturating_add(x),
            y: original.y.saturating_add(y),
            ..original
        })
    }

    pub fn resize_selection(&mut self, width: u32, height: u32) -> EngineResult<()> {
        self.transform_selection(true, |state| {
            resize_state(state, width, height, true, false)
        })
    }

    pub fn delete_selection(&mut self) -> EngineResult<bool> {
        self.ensure_no_gesture()?;
        if self.selection.is_none() {
            return Ok(false);
        }
        let state = self.pending_state(false, true)?;
        self.commit_candidate("선택 삭제", state)
    }

    pub fn copy_raster(&self) -> EngineResult<Raster> {
        self.clipboard_raster(false)
    }

    pub fn clipboard_raster(&self, cut: bool) -> EngineResult<Raster> {
        self.ensure_no_gesture()?;
        if self.text.is_some() {
            return Err("문자 편집에서는 문자 클립보드를 사용하세요.".into());
        }
        if let Some(selection) = &self.selection {
            let mut pixels = selection.pixels.as_ref().clone();
            for pixel in pixels.as_chunks_mut::<4>().0 {
                if pixel[3] == 0 {
                    pixel.fill(0);
                }
            }
            return Ok(Raster {
                width: selection.region.width,
                height: selection.region.height,
                pixels,
            });
        }
        let mut state = self.pending_state(true, true)?;
        if cut {
            let mut layer = state.layers[state.active].clone();
            layer.visible = true;
            state.layers = vec![layer];
            state.active = 0;
            if self.settings.transparent_selection {
                let (width, height) = (state.width, state.height);
                apply_selection_mask(
                    state.try_pixels_mut(0)?,
                    width,
                    height,
                    0,
                    0,
                    None,
                    self.settings.secondary,
                    true,
                )?;
            }
        }
        Ok(Raster {
            width: state.width,
            height: state.height,
            pixels: state.composite()?,
        })
    }

    pub fn cut_after_copy(&mut self) -> EngineResult<bool> {
        self.ensure_no_gesture()?;
        if self.selection.is_some() {
            let state = self.pending_state(false, true)?;
            return self.commit_candidate("잘라내기", state);
        }
        self.layer_edit(LayerEdit::Clear)
    }

    pub fn paste_raster(&mut self, raster: Raster) -> EngineResult<()> {
        self.ensure_no_gesture()?;
        raster.validate()?;
        let region = Region {
            x: 0,
            y: 0,
            width: raster.width,
            height: raster.height,
        };
        if self.has_pending() {
            let current = self.pending_state(true, true)?;
            let (width, height) = expanded_dimensions(&current, region)?;
            validate_size(width, height, current.layers.len())?;
            self.commit_candidate(self.pending_label(), current)?;
        } else {
            self.validate_selection_extent(region)?;
        }
        self.settings.tool = Tool::Select;
        self.selection = Some(Selection {
            region,
            pixels: Arc::new(raster.pixels),
            source: None,
            mask: None,
            modified: true,
            original_pixels: None,
            resize_source: None,
        });
        Ok(())
    }

    pub fn crop_selection(&mut self) -> EngineResult<bool> {
        let selection = self.selection.as_ref().ok_or("먼저 영역을 선택하세요.")?;
        let region = selection.region;
        let x = region.x.max(0);
        let y = region.y.max(0);
        let width = (i64::from(region.x) + i64::from(region.width) - i64::from(x)).max(0) as u32;
        let height = (i64::from(region.y) + i64::from(region.height) - i64::from(y)).max(0) as u32;
        if width == 0 || height == 0 {
            return Ok(false);
        }
        let changed =
            self.edit_state("자르기", |state| crop_state(&state, x, y, width, height))?;
        if changed {
            self.fit();
        }
        Ok(changed)
    }

    pub fn transform(&mut self, operation: &str) -> EngineResult<bool> {
        if self.selection.is_some() {
            self.transform_selection(false, |state| transform_state(state, operation))?;
            return Ok(false);
        }
        let changed = self.edit_state("변형", |state| transform_state(&state, operation))?;
        if changed {
            self.fit();
        }
        Ok(changed)
    }

    pub fn shear(&mut self, angle_degrees: f64) -> EngineResult<bool> {
        if angle_degrees.abs() <= 1e-12 {
            return Ok(false);
        }
        if self.selection.is_some() {
            self.transform_selection(false, |state| shear_state(state, angle_degrees))?;
            return Ok(false);
        }
        let changed =
            self.edit_state("기울이기", |state| shear_state(&state, angle_degrees))?;
        if changed {
            self.fit();
        }
        Ok(changed)
    }

    pub fn resize_document(
        &mut self,
        width: u32,
        height: u32,
        scale: bool,
        smooth: bool,
    ) -> EngineResult<bool> {
        let changed = self.edit_state("크기 변경", |state| {
            resize_state(&state, width, height, scale, smooth)
        })?;
        if changed {
            self.fit();
        }
        Ok(changed)
    }

    pub fn set_active_layer(&mut self, index: usize) -> EngineResult<bool> {
        self.ensure_no_gesture()?;
        if index >= self.document().state().layers.len() {
            return Err("레이어를 선택하세요.".into());
        }
        let changed = self.commit_pending()?;
        self.document_mut().set_active(index)?;
        Ok(changed)
    }

    pub fn layer_edit(&mut self, edit: LayerEdit) -> EngineResult<bool> {
        self.edit_state("레이어 편집", |mut state| {
            let active = state.active;
            match edit {
                LayerEdit::Add => {
                    validate_size(state.width, state.height, state.layers.len() + 1)?;
                    let pixels = zero_pixels(state.width, state.height)?;
                    state.layers.insert(
                        active + 1,
                        Layer::new(format!("레이어 {}", state.layers.len() + 1), true, pixels),
                    );
                    state.active += 1;
                }
                LayerEdit::Delete => {
                    if state.layers.len() == 1 {
                        return Err("마지막 레이어는 삭제할 수 없습니다.".into());
                    }
                    state.layers.remove(active);
                    state.active = active.min(state.layers.len() - 1);
                }
                LayerEdit::Up => {
                    if active + 1 < state.layers.len() {
                        state.layers.swap(active, active + 1);
                        state.active += 1;
                    }
                }
                LayerEdit::Down => {
                    if active > 0 {
                        state.layers.swap(active, active - 1);
                        state.active -= 1;
                    }
                }
                LayerEdit::Merge => {
                    if active == 0 {
                        return Err("병합할 아래 레이어가 없습니다.".into());
                    }
                    if !(state.layers[active].visible && state.layers[active - 1].visible) {
                        return Err("두 레이어를 먼저 표시하세요.".into());
                    }
                    let overlay = State {
                        width: state.width,
                        height: state.height,
                        background: state.background,
                        active: 0,
                        layers: state.layers[active - 1..=active].to_vec(),
                    };
                    state.layers[active - 1].pixels = Arc::new(overlay.composite()?);
                    state.layers.remove(active);
                    state.active -= 1;
                }
                LayerEdit::Clear => {
                    let color = if state.layers.len() == 1 {
                        state.background
                    } else {
                        [0; 4]
                    };
                    for pixel in state.try_pixels_mut(active)?.as_chunks_mut::<4>().0 {
                        pixel.copy_from_slice(&color);
                    }
                }
                LayerEdit::Invert => {
                    for pixel in state.try_pixels_mut(active)?.as_chunks_mut::<4>().0 {
                        for channel in &mut pixel[..3] {
                            *channel = 255 - *channel;
                        }
                    }
                }
                LayerEdit::Rename(name) => state.layers[active].name = name,
                LayerEdit::SetVisible { index, visible } => {
                    state
                        .layers
                        .get_mut(index)
                        .ok_or("레이어를 선택하세요.")?
                        .visible = visible;
                }
                LayerEdit::Background(color) => state.background = color,
            }
            Ok(state)
        })
    }

    pub fn set_background(&mut self, color: Color) -> EngineResult<bool> {
        self.layer_edit(LayerEdit::Background(color))
    }

    fn edit_state(
        &mut self,
        label: &str,
        edit: impl FnOnce(State) -> EngineResult<State>,
    ) -> EngineResult<bool> {
        self.ensure_no_gesture()?;
        let state = edit(self.pending_state(true, true)?)?;
        self.commit_candidate(label, state)
    }

    fn capture_selection(
        &mut self,
        region: Region,
        path: Option<&[(f64, f64)]>,
    ) -> EngineResult<()> {
        let state = self.document().state();
        let source = &state.layers[state.active].pixels;
        let mut pixels = zero_pixels(region.width, region.height)?;
        let stride = region.width as usize * 4;
        for (row, target) in pixels.chunks_exact_mut(stride).enumerate() {
            let start = ((region.y as usize + row) * state.width as usize + region.x as usize) * 4;
            target.copy_from_slice(&source[start..start + stride]);
        }
        let mask = apply_selection_mask(
            &mut pixels,
            region.width,
            region.height,
            region.x,
            region.y,
            path,
            self.settings.secondary,
            self.settings.transparent_selection,
        )?
        .map(Arc::new);
        let pixels = Arc::new(pixels);
        self.selection = Some(Selection {
            region,
            pixels: pixels.clone(),
            source: Some(region),
            mask,
            modified: false,
            original_pixels: Some(pixels),
            resize_source: None,
        });
        Ok(())
    }

    fn validate_selection_extent(&self, region: Region) -> EngineResult<()> {
        validate_size(region.width, region.height, 1)?;
        let state = self.document().state();
        let (width, height) = expanded_dimensions(state, region)?;
        validate_size(width, height, state.layers.len())?;
        Ok(())
    }

    fn move_selection(&mut self, region: Region) -> EngineResult<()> {
        self.validate_selection_extent(region)?;
        if let Some(selection) = &mut self.selection {
            selection.region = region;
            selection.modified = selection.source != Some(region)
                || !selection
                    .original_pixels
                    .as_ref()
                    .is_some_and(|original| Arc::ptr_eq(original, &selection.pixels));
        }
        Ok(())
    }

    fn transform_selection(
        &mut self,
        nearest: bool,
        transform: impl FnOnce(&State) -> EngineResult<State>,
    ) -> EngineResult<()> {
        self.ensure_no_gesture()?;
        let selection = self.selection.as_ref().ok_or("먼저 영역을 선택하세요.")?;
        let input = if nearest {
            selection.resize_source.as_ref()
        } else {
            None
        };
        let (width, height, pixels) = input.cloned().unwrap_or_else(|| {
            (
                selection.region.width,
                selection.region.height,
                selection.pixels.clone(),
            )
        });
        let state = State {
            width,
            height,
            background: [0; 4],
            active: 0,
            layers: vec![Layer {
                name: "선택".into(),
                visible: true,
                pixels: pixels.clone(),
            }],
        };
        let transformed = transform(&state)?;
        let region = Region {
            width: transformed.width,
            height: transformed.height,
            ..selection.region
        };
        self.validate_selection_extent(region)?;
        let selection = self
            .selection
            .as_mut()
            .ok_or("선택 상태가 변경되었습니다.")?;
        selection.region = region;
        selection.pixels = transformed.layers[0].pixels.clone();
        selection.resize_source = nearest.then_some((width, height, pixels));
        selection.original_pixels = None;
        selection.modified = true;
        Ok(())
    }

    fn pending_state(&self, include_selection: bool, validate_commit: bool) -> EngineResult<State> {
        if validate_commit && self.text.as_ref().is_some_and(|text| text.composing) {
            return Err("문자 조합을 먼저 확정하세요.".into());
        }
        let mut state = self.document().state().clone();
        if let Some(selection) = &self.selection
            && (selection.modified || !include_selection)
        {
            if let Some(source) = selection.source {
                let active = state.active;
                let stride = state.width as usize;
                let color = if state.layers.len() == 1 {
                    state.background
                } else {
                    [0; 4]
                };
                let layer = state.try_pixels_mut(active)?;
                for row in 0..source.height as usize {
                    for column in 0..source.width as usize {
                        if selection
                            .mask
                            .as_ref()
                            .is_some_and(|mask| mask[row * source.width as usize + column] == 0)
                        {
                            continue;
                        }
                        let offset =
                            ((source.y as usize + row) * stride + source.x as usize + column) * 4;
                        layer[offset..offset + 4].copy_from_slice(&color);
                    }
                }
            }
            if include_selection {
                let (width, height) = expanded_dimensions(&state, selection.region)?;
                if width != state.width || height != state.height {
                    state = resize_state(&state, width, height, false, false)?;
                }
                place_raster(&mut state, selection.region, &selection.pixels)?;
            }
        }
        if let Some(text) = &self.text
            && let Some(raster) = &text.raster
        {
            place_raster(
                &mut state,
                Region {
                    x: text.x,
                    y: text.y,
                    width: raster.width,
                    height: raster.height,
                },
                &raster.pixels,
            )?;
        }
        if let Some(draft) = &self.shape
            && (draft.tool != Tool::Polygon || draft.points.len() >= 3 || !validate_commit)
        {
            shape::apply(draft, &self.settings, &mut state)?;
        }
        Ok(state)
    }
}

fn zero_pixels(width: u32, height: u32) -> EngineResult<Vec<u8>> {
    validate_size(width, height, 1)?;
    let length = width as usize * height as usize * 4;
    let mut pixels = Vec::new();
    pixels
        .try_reserve_exact(length)
        .map_err(|_| "이미지 메모리가 부족합니다.")?;
    pixels.resize(length, 0);
    Ok(pixels)
}

fn expanded_dimensions(state: &State, region: Region) -> EngineResult<(u32, u32)> {
    let width = (i64::from(region.x) + i64::from(region.width)).max(i64::from(state.width));
    let height = (i64::from(region.y) + i64::from(region.height)).max(i64::from(state.height));
    let invalid = "선택 영역이 그림 크기 범위를 넘었습니다.";
    Ok((
        u32::try_from(width).map_err(|_| invalid)?,
        u32::try_from(height).map_err(|_| invalid)?,
    ))
}

fn place_raster(state: &mut State, region: Region, pixels: &[u8]) -> EngineResult<()> {
    let Some(target) = Region::clipped(
        f64::from(region.x),
        f64::from(region.y),
        f64::from(region.x) + f64::from(region.width),
        f64::from(region.y) + f64::from(region.height),
        state,
    ) else {
        return Ok(());
    };
    let stride = state.width as usize;
    let layer = state.active;
    let image = state.try_pixels_mut(layer)?;
    let source_x = (target.x - region.x) as usize;
    let source_y = (target.y - region.y) as usize;
    for row in 0..target.height as usize {
        let source = ((source_y + row) * region.width as usize + source_x) * 4;
        let destination = ((target.y as usize + row) * stride + target.x as usize) * 4;
        for column in 0..target.width as usize {
            let from = source + column * 4;
            let to = destination + column * 4;
            let color = [
                pixels[from],
                pixels[from + 1],
                pixels[from + 2],
                pixels[from + 3],
            ];
            if color[3] != 0 {
                source_over(&mut image[to..to + 4], color);
            }
        }
    }
    state.layers[layer].visible = true;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const RED: Color = [255, 0, 0, 255];

    fn fixture() -> Editor {
        let mut editor = Editor::new().unwrap();
        editor.active_tab_mut().document =
            PaintDocument::new(State::new(32, 24, [0; 4]).unwrap()).unwrap();
        editor.settings.foreground = RED;
        editor
    }

    fn point(x: f64, y: f64) -> Sample {
        Sample {
            x,
            y,
            pressure: 1.0,
            ..Sample::default()
        }
    }

    fn draw_pencil(editor: &mut Editor, x: f64, y: f64) {
        editor.choose_tool(Tool::Pencil).unwrap();
        let point = point(x, y);
        editor.pointer_down(point, PointerButton::Primary).unwrap();
        assert!(editor.pointer_up(point).unwrap());
    }

    fn read_pixel(editor: &Editor, column: usize, row: usize) -> Color {
        let state = editor.document().state();
        let offset = (row * state.width as usize + column) * 4;
        state.layers[state.active].pixels[offset..offset + 4]
            .try_into()
            .unwrap()
    }

    fn one_pixel(color: Color) -> Raster {
        Raster {
            width: 1,
            height: 1,
            pixels: color.to_vec(),
        }
    }

    #[test]
    fn activation_failure_preserves_live_selection_and_redo() {
        let mut editor = fixture();
        let drawing = editor.active_tab().id;
        let next = editor.new_tab(32, 24, [0; 4]).unwrap();
        editor.activate_tab(drawing).unwrap();
        draw_pencil(&mut editor, 4.5, 5.5);
        assert!(editor.undo());
        let revision = editor.document().revision();
        editor.paste_raster(one_pixel(RED)).unwrap();

        let failure = editor.activate_tab_with(next, |_| Err("선택 실패".into()));
        assert!(failure.is_err());
        assert_eq!(editor.active_tab().id, drawing);
        assert_eq!(editor.document().revision(), revision);
        assert_eq!(read_pixel(&editor, 0, 0), [0; 4]);
        assert!(editor.has_pending());
        assert!(editor.document().can_redo());

        assert_eq!(editor.activate_tab(next).unwrap(), Some(drawing));
        assert!(!editor.has_pending());
        editor.activate_tab(drawing).unwrap();
        assert_eq!(read_pixel(&editor, 0, 0), RED);
        assert!(!editor.document().can_redo());
    }

    #[test]
    fn declining_an_inactive_dirty_close_keeps_the_active_edit_pending() {
        let mut editor = fixture();
        let first = editor.active_tab().id;
        let dirty = editor.new_tab(16, 12, [0; 4]).unwrap();
        draw_pencil(&mut editor, 3.5, 5.5);
        editor.activate_tab(first).unwrap();
        editor.paste_raster(one_pixel(RED)).unwrap();
        let revision = editor.document().revision();
        assert!(
            !editor
                .close_tab_with(dirty, false, |_, _| panic!("unexpected native close"))
                .unwrap()
        );
        assert_eq!(editor.active_tab().id, first);
        assert_eq!(editor.document().revision(), revision);
        assert_eq!(read_pixel(&editor, 0, 0), [0; 4]);
        assert!(editor.has_pending());
    }

    #[test]
    fn selection_move_and_failed_transform_leave_authoritative_pixels_separate() {
        let mut editor = fixture();
        draw_pencil(&mut editor, 4.5, 5.5);
        assert_eq!(read_pixel(&editor, 4, 5), RED);
        editor.select_all().unwrap();
        editor.nudge_selection(1, 0).unwrap();
        assert!(editor.resize_selection(u32::MAX, 1).is_err());
        assert_eq!(read_pixel(&editor, 4, 5), RED);
        assert_eq!(read_pixel(&editor, 5, 5), [0; 4]);
        assert!(editor.commit_pending().unwrap());
        assert_eq!(read_pixel(&editor, 4, 5), [0; 4]);
        assert_eq!(read_pixel(&editor, 5, 5), RED);
        assert!(editor.undo());
        assert_eq!(read_pixel(&editor, 4, 5), RED);
    }

    #[test]
    fn canvas_resize_drag_can_be_cancelled_without_changing_redo() {
        let mut editor = fixture();
        draw_pencil(&mut editor, 3.5, 4.5);
        assert!(editor.undo());
        let original = editor.document().revision();
        editor
            .begin_canvas_resize(point(32.0, 24.0), CanvasEdge::SouthEast)
            .unwrap();
        editor.pointer_move(point(36.0, 28.0)).unwrap();
        assert_eq!(editor.canvas_resize_size(), Some((36, 28)));
        assert!(editor.cancel_pointer());
        assert_eq!(editor.document().revision(), original);
        assert!(editor.document().can_redo());
        assert_eq!(editor.document().state().width, 32);
    }

    #[test]
    fn pending_ime_text_is_locked_until_composition_finishes() {
        let mut editor = fixture();
        editor.choose_tool(Tool::Text).unwrap();
        assert_eq!(
            editor
                .pointer_down(point(6.0, 7.0), PointerButton::Primary)
                .unwrap(),
            PointerAction::TextRequested { x: 6, y: 7 },
        );
        editor.set_text_raster(Some(one_pixel(RED))).unwrap();
        editor.set_text_composing(true);
        let original = editor.document().revision();
        assert!(editor.commit_pending().is_err());
        assert_eq!(editor.document().revision(), original);
        assert!(editor.has_pending());
        editor.set_text_composing(false);
        assert!(editor.commit_pending().unwrap());
        assert_eq!(read_pixel(&editor, 6, 7), RED);
    }

    #[test]
    fn secondary_shape_uses_foreground_interior_and_can_be_undone() {
        let mut editor = fixture();
        editor.choose_tool(Tool::Rectangle).unwrap();
        editor.settings.secondary = [0, 0, 255, 255];
        editor.settings.size = 2.0;
        editor.settings.fill_shape = true;
        editor
            .pointer_down(point(4.0, 4.0), PointerButton::Secondary)
            .unwrap();
        assert!(editor.pointer_up(point(20.0, 18.0)).unwrap());
        assert_eq!(read_pixel(&editor, 10, 10), RED);
        assert_eq!(read_pixel(&editor, 4, 10), [0, 0, 255, 255]);
        assert!(editor.undo());
        assert_eq!(read_pixel(&editor, 10, 10), [0; 4]);
    }
}
