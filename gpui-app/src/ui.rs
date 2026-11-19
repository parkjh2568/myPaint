use std::{
    collections::HashMap,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use gpui::{
    AnyElement, App, AppContext, Bounds, ClipboardEntry, ClipboardItem, Context, FocusHandle,
    Focusable, Image, ImageFormat, KeyDownEvent, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, ObjectFit, Pixels, Point, RenderImage, ScrollEvent, SharedString, StyledImage,
    Subscription, Window, canvas, deferred, div, img, point, prelude::*, px, rgb, rgba, size,
};

use crate::{
    editor::{CanvasEdge, Editor, LayerEdit, PointerAction, PointerButton, Raster, Sample, Tool},
    engine::{Color, State},
    export_preview::{ExportPreview, WHITE},
    format::{self, ExportFormat},
    input::TextField,
    io::{LoadedDocument, NativeIo, RecoveryListing},
    preferences::{Density, EraserMode, PreferenceStore, Preferences},
    render::{CanvasCache, TextRasterizer, TextStyle},
    touch::{Contact, NativeContact, Phase, TouchGesture},
};

mod chrome;
mod icons;
mod smoke;
mod wheel;
pub(crate) use icons::Icons;
pub(crate) use smoke::WindowsSmoke;

type Row = (&'static str, &'static str);
const FILE: &[Row] = &[
    ("new", "새 그림 탭"),
    ("open", "파일 열기"),
    ("insert", "사진 삽입"),
    ("save", "프로젝트 저장"),
    ("save-as", "다른 이름으로 저장"),
    ("export", "이미지 내보내기"),
    ("recover", "복구 사본"),
];
const EDIT: &[Row] = &[
    ("undo", "실행 취소"),
    ("redo", "다시 실행"),
    ("copy", "복사"),
    ("cut", "잘라내기"),
    ("paste", "붙여넣기"),
    ("select-all", "전체 선택"),
    ("delete", "선택 삭제"),
    ("crop", "선택 자르기"),
    ("selection-size", "선택 크기"),
];
const IMAGE: &[Row] = &[
    ("canvas-size", "캔버스 크기"),
    ("image-size", "이미지 크기"),
    ("rotate-right", "오른쪽 회전"),
    ("rotate-left", "왼쪽 회전"),
    ("flip-x", "좌우 반전"),
    ("flip-y", "상하 반전"),
    ("shear", "가로 기울이기"),
    ("invert", "색 반전"),
];
const LAYER: &[Row] = &[
    ("layer-add", "레이어 추가"),
    ("layer-delete", "레이어 삭제"),
    ("layer-up", "위로 이동"),
    ("layer-down", "아래로 이동"),
    ("layer-merge", "아래와 병합"),
    ("layer-rename", "이름 변경"),
    ("clear", "활성 레이어 지우기"),
];
const SETUP: &[Row] = &[
    ("settings", "테마 · 환경설정"),
    ("text-options", "글꼴 · 문자 설정"),
    ("background", "문서 지우기 바탕"),
];

#[derive(Clone, Copy)]
enum Choice {
    Tab(u64),
    Quit,
}

struct Form {
    action: &'static str,
    title: &'static str,
    fields: Vec<(&'static str, gpui::Entity<TextField>)>,
}

struct ExportPanel {
    candidate: State,
    generation: u64,
    preview: ExportPreview,
    image: std::sync::Arc<RenderImage>,
    format: ExportFormat,
    name: gpui::Entity<TextField>,
    matte: gpui::Entity<TextField>,
    matte_color: Color,
    format_menu_open: bool,
    matte_editor_open: bool,
    _matte_observer: Subscription,
}

const EXPORT_FORMATS: [ExportFormat; 3] =
    [ExportFormat::Png, ExportFormat::Jpeg, ExportFormat::Bmp];

impl ExportPanel {
    fn update_image(&mut self, format: ExportFormat, matte: Color, window: &mut Window) {
        if self.format != format || (format != ExportFormat::Png && self.matte_color != matte) {
            let previous = std::mem::replace(&mut self.image, self.preview.image(format, matte));
            let _ = window.drop_image(previous);
        }
        self.format = format;
        self.matte_color = matte;
    }

    fn choose_format(&mut self, format: ExportFormat, window: &mut Window, cx: &mut App) {
        if format == ExportFormat::Png && self.matte_editor_open {
            self.matte_editor_open = false;
            self.name.read(cx).focus_handle(cx).focus(window, cx);
        }
        self.update_image(format, self.matte_color, window);
    }
}

enum Panel {
    Form(Form),
    Settings(Preferences),
    Export(ExportPanel),
    Recovery(RecoveryListing),
    Confirm(Choice),
    Help,
}

#[derive(Clone, Copy)]
struct Palette {
    classic: bool,
    main: u32,
    card: u32,
    canvas: u32,
    field: u32,
    button: u32,
    active: u32,
    border: u32,
    text: u32,
    accent: u32,
    muted: u32,
    on: u32,
    radius: Pixels,
    target: Pixels,
}

impl Palette {
    fn for_theme(classic: bool, touch: bool) -> Self {
        let target = px(if touch { 48. } else { 36. });
        if classic {
            Self {
                classic,
                main: 0x808080,
                card: 0xc0c0c0,
                canvas: 0x808080,
                field: 0xffffff,
                button: 0xc0c0c0,
                active: 0x000080,
                border: 0x808080,
                text: 0x000000,
                accent: 0x000080,
                muted: 0x333333,
                on: 0xffffff,
                radius: px(0.),
                target,
            }
        } else {
            Self {
                classic,
                main: 0x17191f,
                card: 0x252932,
                canvas: 0x17191f,
                field: 0x1b1e26,
                button: 0x252932,
                active: 0x648cff,
                border: 0x414957,
                text: 0xe4e9f2,
                accent: 0x648cff,
                muted: 0xa8b1c0,
                on: 0x0b1838,
                radius: px(7.),
                target,
            }
        }
    }
}

pub struct Studio {
    pub editor: Editor,
    pub(crate) benchmark: Option<crate::benchmark::Benchmark>,
    io: NativeIo,
    session: String,
    epoch: u64,
    generations: HashMap<u64, u64>,
    recovery_queued: HashMap<u64, u64>,
    sequence: u64,
    focus: FocusHandle,
    canvas_bounds: Bounds<Pixels>,
    cache: CanvasCache,
    last_generation: u64,
    preview_version: u64,
    had_preview: bool,
    status: String,
    menu: Option<&'static str>,
    panel: Option<Panel>,
    text: Option<gpui::Entity<TextField>>,
    text_cache: (String, Option<TextStyle>),
    text_engine: Option<TextRasterizer>,
    color_wheel: wheel::ColorWheel,
    thumbnails: chrome::Thumbnails,
    eraser_menu: bool,
    settings_dropdown: Option<&'static str>,
    inspector_overlay: Option<&'static str>,
    preference_store: PreferenceStore,
    preferences: Preferences,
    touch_available: bool,
    touch: TouchGesture,
    allow_close: bool,
}

impl Studio {
    pub fn new(
        io: NativeIo,
        preference_store: PreferenceStore,
        initial: Option<&Path>,
        cx: &mut Context<Self>,
    ) -> Result<Self, String> {
        let mut editor = Editor::new()?;
        let (preferences, status) = match preference_store.load() {
            Ok(preferences) => (
                preferences,
                "기기 안에서 편집 · 파일을 업로드하지 않습니다".into(),
            ),
            Err(error) => (
                Preferences::default(),
                format!("환경 설정을 읽지 못했습니다. {error}"),
            ),
        };
        editor.settings.eraser_background = preferences.eraser_color();
        let id = editor.active_tab().id;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|err| err.to_string())?
            .as_nanos();
        let session = format!("g{}-{stamp:x}", std::process::id());
        io.activate(1, &tab_key(&session, id), None, false)?;
        let mut app = Self {
            editor,
            benchmark: None,
            io,
            session,
            epoch: 1,
            generations: HashMap::from([(id, 1)]),
            recovery_queued: HashMap::new(),
            sequence: 0,
            focus: cx.focus_handle().tab_stop(true),
            canvas_bounds: Bounds::new(point(px(0.), px(0.)), size(px(1.), px(1.))),
            cache: CanvasCache::default(),
            last_generation: 0,
            preview_version: 1,
            had_preview: false,
            status,
            menu: None,
            panel: None,
            text: None,
            text_cache: (String::new(), None),
            text_engine: None,
            color_wheel: wheel::ColorWheel::default(),
            thumbnails: chrome::Thumbnails::default(),
            eraser_menu: false,
            settings_dropdown: None,
            inspector_overlay: None,
            preference_store,
            preferences,
            touch_available: crate::touch::touch_available(),
            touch: TouchGesture::default(),
            allow_close: false,
        };
        if let Some(path) = initial {
            let loaded = app.io.open_path(path)?;
            app.install_loaded(loaded, cx)?;
        }
        Ok(app)
    }

    pub fn handle_close(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.allow_close {
            return true;
        }
        self.touch.cancel(&mut self.editor);
        if self.editor.has_active_gesture() {
            self.status = "진행 중인 편집을 마친 후 닫으세요.".into();
            cx.notify();
            return false;
        }
        if self.editor.has_pending() || self.editor.tabs.iter().any(|tab| tab.document.dirty()) {
            self.dismiss_export(window, cx);
            self.panel = Some(Panel::Confirm(Choice::Quit));
            cx.notify();
            false
        } else {
            true
        }
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.editor.has_pending() {
            self.preview_version = self.preview_version.wrapping_add(1);
        }
        cx.notify();
    }

    pub(crate) fn install_benchmark_state(
        &mut self,
        state: State,
        cx: &mut Context<Self>,
    ) -> Result<u64, String> {
        self.install_loaded(
            LoadedDocument {
                state,
                name: "벤치마크".into(),
                source_token: None,
            },
            cx,
        )?;
        Ok(self.epoch)
    }

    pub(crate) fn cache_counts(&self) -> (usize, usize) {
        (self.cache.last_uploads, self.cache.last_upload_bytes)
    }

    fn report(&mut self, result: Result<(), String>, cx: &mut Context<Self>) {
        if let Err(message) = result {
            self.status = message;
        }
        self.refresh(cx);
    }

    fn queue_recovery(&mut self, id: u64, cx: &mut Context<Self>) {
        let Some(tab) = self.editor.tabs.iter().find(|tab| tab.id == id) else {
            return;
        };
        let revision = tab.document.revision();
        if !tab.document.dirty() || self.recovery_queued.get(&id) == Some(&revision) {
            return;
        }
        let Some(&generation) = self.generations.get(&id) else {
            return;
        };
        self.recovery_queued.insert(id, revision);
        self.sequence += 1;
        let sequence = self.sequence;
        let state = tab.document.state().clone();
        let key = tab_key(&self.session, id);
        let name = tab.name.clone();
        let io = self.io.clone();
        let worker =
            cx.background_spawn(
                async move { io.snapshot(&state, generation, &key, sequence, &name) },
            );
        cx.spawn(async move |view, app| {
            if let Err(message) = worker.await {
                let _ = view.update(app, |studio, cx| {
                    if studio.recovery_queued.get(&id) == Some(&revision) {
                        studio.recovery_queued.remove(&id);
                        if studio.generations.contains_key(&id) {
                            studio.status = format!("복구 저장 실패 · {message}");
                            cx.notify();
                        }
                    }
                });
            }
        })
        .detach();
    }

    fn install_loaded(
        &mut self,
        loaded: LoadedDocument,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let outgoing = self.editor.active_tab().id;
        let epoch = self.epoch + 1;
        let id = self.editor.open_tab_with(loaded.name, loaded.state, |id| {
            self.io.activate(
                epoch,
                &tab_key(&self.session, id),
                loaded.source_token,
                false,
            )
        })?;
        self.epoch = epoch;
        self.generations.insert(id, epoch);
        self.queue_recovery(outgoing, cx);
        self.text = None;
        Ok(())
    }

    fn restore_recovery(
        &mut self,
        token: &str,
        name: &str,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let state = self.io.recover(token)?;
        self.install_loaded(
            LoadedDocument {
                state,
                name: name.into(),
                source_token: None,
            },
            cx,
        )?;
        self.panel = None;
        Ok(())
    }

    fn switch_tab(&mut self, id: u64, cx: &mut Context<Self>) -> Result<(), String> {
        if id == self.editor.active_tab().id {
            return Ok(());
        }
        self.touch.cancel(&mut self.editor);
        let epoch = self.epoch + 1;
        let outgoing = self.editor.activate_tab_with(id, |id| {
            self.io
                .activate(epoch, &tab_key(&self.session, id), None, false)
        })?;
        self.epoch = epoch;
        self.generations.insert(id, epoch);
        if let Some(outgoing) = outgoing {
            self.queue_recovery(outgoing, cx);
        }
        self.text = None;
        Ok(())
    }

    fn close_tab(&mut self, id: u64, discard: bool) -> Result<(), String> {
        self.touch.cancel(&mut self.editor);
        let active = self.editor.active_tab().id;
        let mut epoch = self.epoch;
        let mut next = active;
        let closed = self.editor.close_tab_with(id, discard, |closed, target| {
            if closed != active {
                return self
                    .io
                    .retire_inactive(epoch, &tab_key(&self.session, closed));
            }
            epoch += 1;
            self.io
                .activate(epoch, &tab_key(&self.session, target), None, true)?;
            next = target;
            Ok(())
        })?;
        if closed {
            self.epoch = epoch;
            self.generations.remove(&id);
            self.generations.insert(next, epoch);
            self.recovery_queued.remove(&id);
            if active == id {
                self.text = None;
            }
        } else {
            self.panel = Some(Panel::Confirm(Choice::Tab(id)));
        }
        Ok(())
    }

    pub fn save(
        &mut self,
        save_as: bool,
        path: Option<&Path>,
        cx: &mut Context<Self>,
    ) -> Result<bool, String> {
        self.save_tab(self.editor.active_tab().id, save_as, path, cx)
    }

    fn save_tab(
        &mut self,
        id: u64,
        save_as: bool,
        path: Option<&Path>,
        cx: &mut Context<Self>,
    ) -> Result<bool, String> {
        let generation = *self
            .generations
            .get(&id)
            .ok_or("저장할 그림이 닫혔습니다.")?;
        let written = self.editor.save_tab_with(id, |candidate, name| {
            if let Some(path) = path {
                self.io
                    .save_project_path(candidate, generation, path)
                    .map(Some)
            } else {
                self.io.save_project(candidate, generation, name, save_as)
            }
        })?;
        if written {
            if self.editor.active_tab().id == id {
                self.text = None;
            }
            self.status = "프로젝트 저장 완료".into();
            cx.notify();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn confirmed(
        &mut self,
        choice: Choice,
        save: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        match choice {
            Choice::Tab(id) => {
                if save {
                    if !self.save_tab(id, false, None, cx)? {
                        return Ok(());
                    }
                }
                self.close_tab(id, true)
            }
            Choice::Quit => {
                if save {
                    let mut ids: Vec<_> = self
                        .editor
                        .tabs
                        .iter()
                        .filter(|tab| tab.document.dirty())
                        .map(|tab| tab.id)
                        .collect();
                    let current = self.editor.active_tab().id;
                    ids.retain(|id| *id != current);
                    if self.editor.document().dirty() || self.editor.has_pending() {
                        ids.push(current);
                    }
                    for id in ids {
                        if !self.save_tab(id, false, None, cx)? {
                            return Ok(());
                        }
                    }
                }
                self.allow_close = true;
                window.remove_window();
                cx.quit();
                Ok(())
            }
        }
    }

    fn show_export(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Result<(), String> {
        self.update_text(cx);
        let candidate = self.editor.export_candidate()?;
        let preview = ExportPreview::new(&candidate)?;
        let name = Path::new(&self.editor.active_tab().name)
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("그림")
            .to_owned();
        let name = cx.new(|cx| TextField::new(name, false, cx));
        let matte = cx.new(|cx| TextField::new("#FFFFFF".into(), false, cx));
        let matte_observer = cx.observe_in(&matte, window, |studio, field, window, cx| {
            if let Some(Panel::Export(export)) = &mut studio.panel {
                if let Ok(matte) = export_matte(field.read(cx).text()) {
                    export.update_image(export.format, matte, window);
                }
                cx.notify();
            }
        });
        let format = ExportFormat::Png;
        let image = preview.image(format, WHITE);
        name.read(cx).focus_handle(cx).focus(window, cx);
        self.panel = Some(Panel::Export(ExportPanel {
            candidate,
            generation: self.epoch,
            preview,
            image,
            format,
            name,
            matte,
            matte_color: WHITE,
            format_menu_open: false,
            matte_editor_open: false,
            _matte_observer: matte_observer,
        }));
        Ok(())
    }

    fn dismiss_export(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(Panel::Export(export)) = &self.panel else {
            return false;
        };
        let _ = window.drop_image(export.image.clone());
        self.panel = None;
        let focus = self
            .text
            .as_ref()
            .map_or_else(|| self.focus.clone(), |text| text.read(cx).focus_handle(cx));
        focus.focus(window, cx);
        true
    }

    fn save_export(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Result<(), String> {
        let Some(Panel::Export(export)) = &self.panel else {
            return Ok(());
        };
        if export.generation != self.epoch {
            return Err("그림이 변경되었습니다. 내보내기를 다시 실행하세요.".into());
        }
        let name = export.name.read(cx);
        let matte = export.matte.read(cx);
        if name.composing() || (export.format != ExportFormat::Png && matte.composing()) {
            return Err("문자 조합을 먼저 확정하세요.".into());
        }
        let matte = if export.format == ExportFormat::Png {
            WHITE
        } else {
            export_matte(matte.text())?
        };
        if let Some(file) = self.io.export_image(
            &export.candidate,
            export.generation,
            export.format,
            matte,
            name.text(),
        )? {
            self.status = format!("{file} 내보내기 완료");
            self.dismiss_export(window, cx);
        }
        Ok(())
    }

    fn dialog(
        &mut self,
        action: &'static str,
        title: &'static str,
        rows: Vec<(&'static str, String)>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let fields = rows
            .into_iter()
            .map(|(label, value)| (label, cx.new(|cx| TextField::new(value, false, cx))))
            .collect::<Vec<_>>();
        if let Some((_, first)) = fields.first() {
            first.read(cx).focus_handle(cx).focus(window, cx);
        }
        self.panel = Some(Panel::Form(Form {
            action,
            title,
            fields,
        }));
    }

    fn apply_form(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Result<(), String> {
        let Some(Panel::Form(form)) = self.panel.take() else {
            return Ok(());
        };
        let values: Vec<_> = form
            .fields
            .iter()
            .map(|(_, field)| field.read(cx).text().trim().to_owned())
            .collect();
        let result = self.apply_values(form.action, &values, cx);
        if result.is_err() {
            self.panel = Some(Panel::Form(form));
        } else {
            self.focus.focus(window, cx);
        }
        result
    }

    fn apply_values(
        &mut self,
        action: &str,
        values: &[String],
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let dim = |i: usize| {
            values
                .get(i)
                .ok_or_else(|| "크기를 입력하세요.".to_string())?
                .parse::<u32>()
                .map_err(|_| "크기는 양의 정수여야 합니다.".to_string())
        };
        let number = |i: usize, min: f64, max: f64| {
            values
                .get(i)
                .and_then(|s| s.parse::<f64>().ok())
                .filter(|n| n.is_finite() && *n >= min && *n <= max)
                .ok_or_else(|| format!("{min}–{max} 범위의 수를 입력하세요."))
        };
        match action {
            "new" => self.install_loaded(
                LoadedDocument {
                    state: State::new(dim(0)?, dim(1)?, [0; 4])?,
                    name: "제목 없음".into(),
                    source_token: None,
                },
                cx,
            )?,
            "selection-size" => self.editor.resize_selection(dim(0)?, dim(1)?)?,
            "image-size" | "canvas-size" => {
                self.editor.resize_document(
                    dim(0)?,
                    dim(1)?,
                    action == "image-size",
                    values.get(2).is_none_or(|value| value != "0"),
                )?;
            }
            "shear" => {
                self.editor.shear(number(0, -80., 80.)?)?;
            }
            "layer-rename" => {
                self.editor
                    .layer_edit(LayerEdit::Rename(values[0].clone()))?;
            }
            "background" => {
                self.editor.set_background(parse_color(&values[0])?)?;
            }
            "foreground" => self.editor.settings.foreground = parse_color(&values[0])?,
            "secondary" => self.editor.settings.secondary = parse_color(&values[0])?,
            "eraser-color" => {
                let [red, green, blue, _] = parse_color(&values[0])?;
                let mut preferences = self.preferences.clone();
                preferences.eraser_background = [red, green, blue];
                self.apply_preferences(preferences)?;
            }
            "text-options" => {
                let size = number(1, 4., 256.)?;
                let settings = &mut self.editor.settings;
                settings.font_family = values[0].clone();
                settings.font_size = size as u16;
                settings.font_bold = values[2] == "1";
                settings.font_italic = values[3] == "1";
                settings.text_background = values[4] == "1";
            }
            _ => return Err("입력 창의 명령을 처리할 수 없습니다.".into()),
        }
        Ok(())
    }

    fn apply_preferences(&mut self, preferences: Preferences) -> Result<(), String> {
        if preferences != self.preferences {
            self.preference_store.save(&preferences)?;
            self.editor.settings.eraser_background = preferences.eraser_color();
            self.preferences = preferences;
        }
        Ok(())
    }

    fn accept_preferences(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        if let Some(Panel::Settings(preferences)) = &self.panel {
            self.apply_preferences(preferences.clone())?;
            self.settings_dropdown = None;
            self.panel = None;
            self.focus.focus(window, cx);
        }
        Ok(())
    }

    fn command(
        &mut self,
        action: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        self.menu = None;
        self.eraser_menu = false;
        self.settings_dropdown = None;
        self.touch.cancel(&mut self.editor);
        let state = self.editor.document().state();
        let dims = || {
            vec![
                ("너비", state.width.to_string()),
                ("높이", state.height.to_string()),
            ]
        };
        let settings = &self.editor.settings;
        match action {
            "new" => self.dialog(
                action,
                "새 그림",
                vec![("너비", "800".into()), ("높이", "600".into())],
                window,
                cx,
            ),
            "open" | "insert" => {
                if let Some(loaded) = self.io.open_dialog()? {
                    if action == "open" {
                        self.install_loaded(loaded, cx)?;
                    } else {
                        let state = loaded.state;
                        self.editor.paste_raster(Raster {
                            width: state.width,
                            height: state.height,
                            pixels: state.composite()?,
                        })?;
                    }
                }
            }
            "save" | "save-as" => {
                self.save(action == "save-as", None, cx)?;
            }
            "export" => return self.show_export(window, cx),
            "recover" => self.panel = Some(Panel::Recovery(self.io.list()?)),
            "undo" => {
                self.editor.undo();
                self.text = None;
            }
            "redo" => {
                self.editor.redo();
            }
            "copy" | "cut" => {
                let raster = self.editor.clipboard_raster(action == "cut")?;
                let bytes = format::encode_png(raster.width, raster.height, &raster.pixels)?;
                cx.write_to_clipboard(ClipboardItem::new_image(&Image::from_bytes(
                    ImageFormat::Png,
                    bytes,
                )));
                if action == "cut" {
                    self.editor.cut_after_copy()?;
                }
            }
            "paste" => {
                let item = cx
                    .read_from_clipboard()
                    .ok_or("클립보드에 그림이 없습니다.")?;
                let image = item
                    .entries()
                    .iter()
                    .find_map(|entry| match entry {
                        ClipboardEntry::Image(image) => Some(image),
                        _ => None,
                    })
                    .ok_or("클립보드에 그림이 없습니다.")?;
                let state = format::decode_artwork(image.bytes())?;
                self.editor.paste_raster(Raster {
                    width: state.width,
                    height: state.height,
                    pixels: state.composite()?,
                })?;
            }
            "select-all" => self.editor.select_all()?,
            "delete" => {
                self.editor.delete_selection()?;
            }
            "crop" => {
                self.editor.crop_selection()?;
            }
            "rotate-right" | "rotate-left" | "flip-x" | "flip-y" => {
                self.editor.transform(action)?;
            }
            "invert" => {
                self.editor.layer_edit(LayerEdit::Invert)?;
            }
            "clear" => {
                self.editor.layer_edit(LayerEdit::Clear)?;
            }
            "layer-add" => {
                self.editor.layer_edit(LayerEdit::Add)?;
            }
            "layer-delete" => {
                self.editor.layer_edit(LayerEdit::Delete)?;
            }
            "layer-up" => {
                self.editor.layer_edit(LayerEdit::Up)?;
            }
            "layer-down" => {
                self.editor.layer_edit(LayerEdit::Down)?;
            }
            "layer-merge" => {
                self.editor.layer_edit(LayerEdit::Merge)?;
            }
            "layer-rename" => self.dialog(
                action,
                "레이어 이름",
                vec![("이름", state.layers[state.active].name.clone())],
                window,
                cx,
            ),
            "canvas-size" => self.dialog(action, "캔버스 크기", dims(), window, cx),
            "image-size" => {
                let mut fields = dims();
                fields.push(("부드러운 보간 (0 또는 1)", "1".into()));
                self.dialog(action, "이미지 크기", fields, window, cx);
            }
            "selection-size" => {
                let region = self
                    .editor
                    .selection_region()
                    .ok_or("먼저 영역을 선택하세요.")?;
                self.dialog(
                    action,
                    "선택 크기",
                    vec![
                        ("너비", region.width.to_string()),
                        ("높이", region.height.to_string()),
                    ],
                    window,
                    cx,
                );
            }
            "shear" => self.dialog(
                action,
                "가로 기울이기",
                vec![("각도", "0".into())],
                window,
                cx,
            ),
            "background" => self.dialog(
                action,
                "문서 지우기 바탕",
                vec![("RGBA", hex(state.background))],
                window,
                cx,
            ),
            "foreground" => self.dialog(
                action,
                "전경색",
                vec![("RGBA", hex(settings.foreground))],
                window,
                cx,
            ),
            "secondary" => self.dialog(
                action,
                "보조색",
                vec![("RGBA", hex(settings.secondary))],
                window,
                cx,
            ),
            "settings" => self.panel = Some(Panel::Settings(self.preferences.clone())),
            "properties" | "layers" => {
                self.inspector_overlay = if self.inspector_overlay == Some(action) {
                    None
                } else {
                    Some(action)
                }
            }
            "eraser-color" => self.dialog(
                action,
                "지우개 배경색",
                vec![(
                    "HEX",
                    format!(
                        "#{:02x}{:02x}{:02x}",
                        self.preferences.eraser_background[0],
                        self.preferences.eraser_background[1],
                        self.preferences.eraser_background[2]
                    ),
                )],
                window,
                cx,
            ),
            "text-options" => self.dialog(
                action,
                "글꼴 · 문자 설정",
                vec![
                    ("글꼴", settings.font_family.clone()),
                    ("크기", settings.font_size.to_string()),
                    ("굵게 (0 또는 1)", u8::from(settings.font_bold).to_string()),
                    (
                        "기울임 (0 또는 1)",
                        u8::from(settings.font_italic).to_string(),
                    ),
                    (
                        "바탕색 (0 또는 1)",
                        u8::from(settings.text_background).to_string(),
                    ),
                ],
                window,
                cx,
            ),
            "fit" => self.editor.fit(),
            "zoom-in" | "zoom-out" => {
                let view = *self.editor.viewport();
                self.editor.zoom_at(
                    view.zoom * if action == "zoom-in" { 1.25 } else { 0.8 },
                    view.width / 2.,
                    view.height / 2.,
                );
            }
            "square" => self.editor.settings.square = !self.editor.settings.square,
            "pressure" => self.editor.settings.pressure = !self.editor.settings.pressure,
            "fill-shape" => self.editor.settings.fill_shape = !self.editor.settings.fill_shape,
            "outline-shape" => {
                self.editor.settings.outline_shape = !self.editor.settings.outline_shape
            }
            "transparent-selection" => {
                self.editor.settings.transparent_selection =
                    !self.editor.settings.transparent_selection
            }
            "finger" => self.editor.settings.finger_draw = !self.editor.settings.finger_draw,
            "swap" => std::mem::swap(
                &mut self.editor.settings.foreground,
                &mut self.editor.settings.secondary,
            ),
            "commit" => {
                self.update_text(cx);
                self.editor.commit_pending()?;
                self.text = None;
            }
            "cancel" => {
                if self.dismiss_export(window, cx) {
                    return Ok(());
                }
                if self.panel.take().is_none() {
                    self.editor.cancel_pointer();
                    self.editor.discard_pending();
                    self.text = None;
                }
                self.focus.focus(window, cx);
            }
            "help" => self.panel = Some(Panel::Help),
            _ => return Err("편집 명령을 처리할 수 없습니다.".into()),
        }
        self.queue_recovery(self.editor.active_tab().id, cx);
        Ok(())
    }

    fn sample(&self, position: Point<Pixels>, shift: bool) -> Sample {
        let pressure = crate::pen::current_pressure();
        Sample {
            x: f64::from(f32::from(position.x - self.canvas_bounds.origin.x)),
            y: f64::from(f32::from(position.y - self.canvas_bounds.origin.y)),
            pressure: pressure.unwrap_or(1.),
            pen: pressure.is_some(),
            shift,
        }
    }

    pub(crate) fn native_touch(
        &mut self,
        contact: NativeContact,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let position = point(
            px(contact.x as f32 / window.scale_factor()),
            px(contact.y as f32 / window.scale_factor()),
        );
        if contact.phase == Phase::Down && !self.canvas_bounds.contains(&position) {
            return false;
        }
        if contact.phase == Phase::Down && !self.touch.is_active() {
            if self.panel.is_some()
                || self.menu.is_some()
                || self.text.is_some()
                || self.editor.has_active_gesture()
            {
                return false;
            }
            self.touch_available = true;
            self.focus.focus(window, cx);
        } else if !self.touch.is_active() {
            return false;
        }
        let sample = self.sample(position, window.modifiers().shift);
        let spray_was_active = self.editor.spray_active();
        match self.touch.handle(
            &mut self.editor,
            Contact {
                id: contact.id,
                phase: contact.phase,
                x: sample.x,
                y: sample.y,
                shift: sample.shift,
            },
        ) {
            Ok(outcome) => {
                self.pointer_action(outcome.action, window, cx);
                if outcome.queue_recovery {
                    self.queue_recovery(self.editor.active_tab().id, cx);
                }
                if outcome.changed {
                    self.refresh(cx);
                }
                if !spray_was_active && self.editor.spray_active() {
                    self.schedule_spray(cx);
                }
            }
            Err(error) => self.report(Err(error), cx),
        }
        true
    }

    fn pointer_action(
        &mut self,
        action: PointerAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if matches!(action, PointerAction::TextRequested { .. }) {
            let text = cx.new(|cx| TextField::new(String::new(), true, cx));
            text.read(cx).focus_handle(cx).focus(window, cx);
            self.text = Some(text);
            self.text_cache = (String::new(), None);
        }
    }

    fn pointer_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.panel.is_some() || self.menu.is_some() || self.touch.is_active() {
            return;
        }
        self.focus.focus(window, cx);
        let button = match event.button {
            MouseButton::Right => PointerButton::Secondary,
            MouseButton::Middle => PointerButton::Middle,
            _ => PointerButton::Primary,
        };
        let result = self
            .editor
            .pointer_down(self.sample(event.position, event.modifiers.shift), button)
            .map(|action| self.pointer_action(action, window, cx));
        if self.editor.spray_active() {
            self.schedule_spray(cx);
        }
        self.report(result, cx);
    }

    fn schedule_spray(&self, cx: &mut Context<Self>) {
        cx.spawn(async move |view, app| {
            loop {
                app.background_executor()
                    .timer(Duration::from_millis(35))
                    .await;
                let keep = view.update(app, |studio, cx| {
                    if !studio.editor.spray_active() {
                        return false;
                    }
                    let result = studio.editor.spray_tick().map(|_| ());
                    studio.report(result, cx);
                    true
                });
                if !matches!(keep, Ok(true)) {
                    break;
                }
            }
        })
        .detach();
    }

    fn pointer_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.touch.is_active() || !self.editor.has_active_gesture() {
            return;
        }
        let result = self
            .editor
            .pointer_move(self.sample(event.position, event.modifiers.shift));
        self.report(result, cx);
    }

    fn pointer_up(&mut self, event: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.touch.is_active() || !self.editor.has_active_gesture() {
            return;
        }
        let result = self
            .editor
            .pointer_up(self.sample(event.position, event.modifiers.shift))
            .map(|_| ());
        self.queue_recovery(self.editor.active_tab().id, cx);
        self.report(result, cx);
    }

    fn wheel(&mut self, event: &ScrollEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.panel.is_some() || self.menu.is_some() || self.touch.is_active() {
            return;
        }
        let sample = self.sample(event.position, event.modifiers.shift);
        let delta = event.delta.pixel_delta(px(20.));
        self.editor.zoom_at(
            self.editor.viewport().zoom * (-f64::from(f32::from(delta.y)) * 0.003).exp(),
            sample.x,
            sample.y,
        );
        cx.notify();
    }

    fn keyboard(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        let mods = event.keystroke.modifiers;
        let ctrl = mods.control || mods.platform;
        if self
            .text
            .as_ref()
            .is_some_and(|field| field.read(cx).composing())
            || matches!(&self.panel, Some(Panel::Form(form)) if form.fields.iter().any(|(_, field)| field.read(cx).composing()))
        {
            return;
        }
        if let Some(current) = self.menu {
            if key == "escape" {
                self.menu = None;
                self.focus.focus(window, cx);
                cx.notify();
                cx.stop_propagation();
            } else if matches!(key, "left" | "right" | "home" | "end") {
                let categories = chrome::CATEGORIES;
                let index = categories
                    .iter()
                    .position(|(id, _)| *id == current)
                    .unwrap_or(0);
                let index = match key {
                    "left" => (index + categories.len() - 1) % categories.len(),
                    "right" => (index + 1) % categories.len(),
                    "home" => 0,
                    _ => categories.len() - 1,
                };
                self.menu = Some(categories[index].0);
                cx.notify();
                cx.stop_propagation();
            }
            return;
        }
        if matches!(self.panel, Some(Panel::Settings(_))) {
            let result = match key {
                "escape" if self.settings_dropdown.take().is_some() => Ok(()),
                "enter" => self.accept_preferences(window, cx),
                "escape" => self.command("cancel", window, cx),
                _ => return,
            };
            self.report(result, cx);
            cx.stop_propagation();
            return;
        }
        if let Some(Panel::Export(export)) = &mut self.panel {
            let result = match key {
                "enter" | "escape" if export.format_menu_open => {
                    export.format_menu_open = false;
                    Ok(())
                }
                "up" | "down" if export.format_menu_open => {
                    let index = EXPORT_FORMATS
                        .iter()
                        .position(|&format| format == export.format)
                        .expect("preview has a supported format");
                    let step = if key == "down" { 1 } else { 2 };
                    export.choose_format(
                        EXPORT_FORMATS[(index + step) % EXPORT_FORMATS.len()],
                        window,
                        cx,
                    );
                    Ok(())
                }
                "escape" if export.matte_editor_open => {
                    export.matte_editor_open = false;
                    export.name.read(cx).focus_handle(cx).focus(window, cx);
                    Ok(())
                }
                "enter" => self.save_export(window, cx),
                "escape" => self.command("cancel", window, cx),
                _ => return,
            };
            self.report(result, cx);
            cx.stop_propagation();
            return;
        }
        if matches!(self.panel, Some(Panel::Form(_))) && key == "enter" {
            let result = self.apply_form(window, cx);
            self.report(result, cx);
            return;
        }
        let command = match (ctrl, key) {
            (_, "escape") => "cancel",
            (true, "enter") => "commit",
            (true, "s") if mods.shift => "save-as",
            (true, "s") => "save",
            (true, "o") => "open",
            (true, "n") => "new",
            (true, "z") if mods.shift => "redo",
            (true, "z") => "undo",
            (true, "y") => "redo",
            (true, "c") => "copy",
            (true, "x") => "cut",
            (true, "v") => "paste",
            (true, "a") => "select-all",
            (false, "delete") => "delete",
            (false, "enter") if self.text.is_none() => "commit",
            (false, "left" | "right" | "up" | "down")
                if self.panel.is_none() && self.text.is_none() =>
            {
                let (x, y) = match key {
                    "left" => (-1, 0),
                    "right" => (1, 0),
                    "up" => (0, -1),
                    _ => (0, 1),
                };
                let result = self.editor.nudge_selection(x, y);
                self.report(result, cx);
                return;
            }
            (false, "b" | "e" | "v" | "h" | "t" | "i")
                if self.panel.is_none() && self.text.is_none() =>
            {
                let tool = match key {
                    "b" => Tool::Brush,
                    "e" => Tool::Eraser,
                    "v" => Tool::Select,
                    "h" => Tool::Pan,
                    "t" => Tool::Text,
                    _ => Tool::Picker,
                };
                let result = self.editor.choose_tool(tool).map(|_| ());
                self.report(result, cx);
                return;
            }
            _ => return,
        };
        let result = self.command(command, window, cx);
        self.report(result, cx);
        cx.stop_propagation();
    }

    fn update_text(&mut self, cx: &mut Context<Self>) {
        let Some(text) = &self.text else {
            return;
        };
        let field = text.read(cx);
        let content = field.text().to_string();
        let composing = field.composing();
        self.editor.set_text_composing(composing);
        let settings = &self.editor.settings;
        let style = TextStyle {
            family: settings.font_family.clone(),
            size: f32::from(settings.font_size),
            bold: settings.font_bold,
            italic: settings.font_italic,
            color: settings.foreground,
        };
        if self.text_cache.0 != content || self.text_cache.1.as_ref() != Some(&style) {
            let raster = self
                .text_engine
                .get_or_insert_with(TextRasterizer::new)
                .raster(&content, &style);
            if let Err(error) = self.editor.set_text_raster(raster) {
                self.status = error;
            }
            self.text_cache = (content, Some(style));
            self.preview_version = self.preview_version.wrapping_add(1);
        }
    }
}

fn tab_key(session: &str, id: u64) -> String {
    format!("{session}-{id:x}")
}

fn parse_color(value: &str) -> Result<Color, String> {
    let value = value.trim().trim_start_matches('#');
    if !matches!(value.len(), 6 | 8) || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("색을 #RRGGBB 또는 #RRGGBBAA로 입력하세요.".into());
    }
    let mut color = [255; 4];
    for (i, target) in color.iter_mut().take(value.len() / 2).enumerate() {
        *target =
            u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).map_err(|err| err.to_string())?;
    }
    Ok(color)
}

fn export_matte(value: &str) -> Result<Color, String> {
    if value.trim().trim_start_matches('#').len() != 6 {
        return Err("바탕색을 #RRGGBB로 입력하세요.".into());
    }
    parse_color(value).map_err(|_| "바탕색을 #RRGGBB로 입력하세요.".into())
}

fn hex([r, g, b, a]: Color) -> String {
    format!("#{r:02X}{g:02X}{b:02X}{a:02X}")
}

fn button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    palette: Palette,
    selected: bool,
) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .role(gpui::Role::Button)
        .aria_label(label)
        .flex()
        .items_center()
        .justify_center()
        .gap(px(7.))
        .min_w(palette.target)
        .min_h(palette.target)
        .rounded(palette.radius)
        .bg(rgb(if selected {
            palette.active
        } else {
            palette.button
        }))
        .text_color(rgb(if selected { palette.on } else { palette.text }))
        .border_1()
        .border_color(if palette.classic {
            rgba(0x707070ff)
        } else {
            rgba(0x00000000)
        })
        .px(px(9.))
        .cursor_pointer()
        .hover(move |style| {
            style.bg(rgb(if selected {
                palette.active
            } else {
                palette.border
            }))
        })
}

fn command_button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    palette: Palette,
    selected: bool,
) -> gpui::Stateful<gpui::Div> {
    let label = label.into();
    button(id, label.clone(), palette, selected).child(label)
}

impl Focusable for Studio {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Studio {
    fn action_button(
        &self,
        key: &'static str,
        label: impl Into<SharedString>,
        palette: Palette,
        selected: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        command_button(key, label, palette, selected)
            .on_click(cx.listener(move |studio, _, window, cx| {
                let result = studio.command(key, window, cx);
                studio.report(result, cx);
            }))
            .into_any_element()
    }

    fn view_export_panel(
        &self,
        export: &ExportPanel,
        p: Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let opaque = export.format != ExportFormat::Png;
        let invalid_matte = opaque && export_matte(export.matte.read(cx).text()).is_err();
        let (width, height) = export.preview.display_size();
        let [r, g, b, _] = export.matte_color;
        let title = div()
            .font_weight(gpui::FontWeight::BOLD)
            .child("이미지 내보내기");
        let title = if p.classic {
            title
                .bg(rgb(p.accent))
                .text_color(rgb(p.on))
                .text_size(px(13.))
                .px_2()
                .py_1()
        } else {
            title.text_size(px(18.))
        };
        let mut format = div().relative().child(
            command_button(
                "export-format",
                format!("{} ▾", export.format.extension()),
                p,
                false,
            )
            .on_click(cx.listener(|studio, _, _, cx| {
                if let Some(Panel::Export(export)) = &mut studio.panel {
                    export.format_menu_open = !export.format_menu_open;
                    cx.notify();
                }
            })),
        );
        if export.format_menu_open {
            let choices = div()
                .absolute()
                .top(px(29.))
                .right_0()
                .min_w(px(65.))
                .p_1()
                .bg(rgb(p.card))
                .border_1()
                .border_color(rgb(p.border))
                .shadow_lg()
                .occlude()
                .children(EXPORT_FORMATS.map(|kind| {
                    command_button(
                        ("export-format-choice", kind as usize),
                        kind.extension(),
                        p,
                        kind == export.format,
                    )
                    .on_click(cx.listener(move |studio, _, window, cx| {
                        if let Some(Panel::Export(export)) = &mut studio.panel {
                            export.format_menu_open = false;
                            export.choose_format(kind, window, cx);
                            cx.notify();
                        }
                    }))
                }));
            format = format.child(deferred(choices).with_priority(1));
        }
        let swatch = div()
            .id("export-matte")
            .role(gpui::Role::Button)
            .w(px(50.))
            .h(px(28.))
            .p_1()
            .bg(rgb(p.field))
            .border_1()
            .border_color(rgb(p.border))
            .child(div().size_full().bg(rgb(u32::from_be_bytes([0, r, g, b]))));
        let swatch = if opaque {
            swatch
                .cursor_pointer()
                .on_click(cx.listener(|studio, _, window, cx| {
                    if let Some(Panel::Export(export)) = &mut studio.panel {
                        export.matte_editor_open = !export.matte_editor_open;
                        if export.matte_editor_open {
                            export.matte.read(cx).focus_handle(cx).focus(window, cx);
                        } else {
                            export.name.read(cx).focus_handle(cx).focus(window, cx);
                        }
                        cx.notify();
                    }
                }))
        } else {
            swatch.opacity(0.45)
        };
        let mut matte = div()
            .flex()
            .items_center()
            .justify_between()
            .gap_2()
            .child("JPG/BMP 바탕색")
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .when(opaque && export.matte_editor_open, |row| {
                        row.child(div().w(px(114.)).child(export.matte.clone()))
                    })
                    .child(swatch),
            );
        if invalid_matte {
            matte = matte.text_color(rgb(if p.classic { 0x9e2727 } else { 0xff8989 }));
        }
        let description = if opaque {
            "투명한 부분에 선택한 바탕색을 적용합니다. JPG는 저장 시 색이 조금 달라질 수 있습니다."
        } else {
            "PNG는 투명도를 유지합니다."
        };
        let submit = command_button("export-save", "내보내기", p, true);
        let submit = if invalid_matte {
            submit.opacity(0.45)
        } else {
            submit.on_click(cx.listener(|studio, _, window, cx| {
                let result = studio.save_export(window, cx);
                studio.report(result, cx);
            }))
        };
        let content = div()
            .id("export-dialog")
            .w(px(420.))
            .max_w_full()
            .max_h_full()
            .overflow_y_scroll()
            .p_5()
            .flex()
            .flex_col()
            .gap(px(15.))
            .bg(rgb(p.card))
            .border_1()
            .border_color(rgb(p.border))
            .shadow_lg()
            .rounded(p.radius)
            .child(title)
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .child("파일 이름")
                    .child(div().w(px(240.)).child(export.name.clone())),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .child("형식")
                    .child(format),
            )
            .child(matte)
            .when(invalid_matte, |panel| {
                panel.child(div().text_xs().child("바탕색을 #RRGGBB로 입력하세요."))
            })
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(10.))
                    .child(
                        div()
                            .border_1()
                            .border_color(rgb(p.border))
                            .child(
                                img(export.image.clone())
                                    .w(px(width as f32))
                                    .h(px(height as f32))
                                    .object_fit(ObjectFit::Fill),
                            ),
                    )
                    .child(div().w_full().text_xs().text_color(rgb(p.muted)).child(format!(
                            "{description} 축소 미리보기에서는 작은 세부와 가장자리가 실제 출력과 다를 수 있습니다."
                    ))),
            )
            .child(
                div()
                    .mt_1()
                    .flex()
                    .justify_end()
                    .gap(px(7.))
                    .child(self.action_button("cancel", "취소", p, false, cx))
                    .child(submit),
            );
        div()
            .absolute()
            .inset_0()
            .occlude()
            .p_3()
            .bg(rgba(if p.classic { 0x00000044 } else { 0x00000088 }))
            .flex()
            .items_center()
            .justify_center()
            .child(content)
            .into_any_element()
    }

    fn view_panel(&self, p: Palette, cx: &mut Context<Self>) -> AnyElement {
        let mut content = div()
            .min_w(px(340.))
            .max_w(px(540.))
            .max_h(px(630.))
            .p_4()
            .flex()
            .flex_col()
            .gap_2()
            .bg(rgb(p.card))
            .border_1()
            .border_color(rgb(p.border))
            .rounded(p.radius)
            .shadow_lg();
        match &self.panel {
            Some(Panel::Settings(preferences)) => {
                content =
                    content
                        .w(px(420.))
                        .p(px(20.))
                        .child(self.settings_view(preferences, p, cx));
            }
            Some(Panel::Form(form)) => {
                content = content.child(div().text_lg().child(form.title));
                for (name, field) in &form.fields {
                    content = content.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(*name)
                            .child(field.clone()),
                    );
                }
                content = content.child(
                    div()
                        .flex()
                        .gap_2()
                        .child(command_button("form-accept", "확인", p, true).on_click(
                            cx.listener(|studio, _, window, cx| {
                                let result = studio.apply_form(window, cx);
                                studio.report(result, cx);
                            }),
                        ))
                        .child(self.action_button("cancel", "취소", p, false, cx)),
                );
            }
            Some(Panel::Confirm(choice)) => {
                let choice = *choice;
                content = content
                    .child(div().text_lg().child("그림 변경 사항을 저장할까요?"))
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .children([(true, "저장"), (false, "저장하지 않음")].map(
                                |(save, label)| {
                                    command_button(label, label, p, save).on_click(cx.listener(
                                        move |studio, _, window, cx| {
                                            studio.panel = None;
                                            let result = studio.confirmed(choice, save, window, cx);
                                            studio.report(result, cx);
                                        },
                                    ))
                                },
                            ))
                            .child(self.action_button("cancel", "취소", p, false, cx)),
                    );
            }
            Some(Panel::Export(export)) => return self.view_export_panel(export, p, cx),
            Some(Panel::Recovery(list)) => {
                content = content.child(div().text_lg().child("복구 사본"));
                if list.entries.is_empty() {
                    content = content.child("복구 사본이 없습니다.");
                }
                for warning in &list.warnings {
                    content = content.child(warning.clone());
                }
                let mut entries = div()
                    .id("recovery-list")
                    .max_h(px(430.))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap_1();
                for (index, entry) in list.entries.iter().enumerate() {
                    let token = entry.token.clone();
                    let deleting = token.clone();
                    let name = entry.name.clone();
                    let mut row = div().flex().gap_2().child(
                        command_button(
                            ("recovery-open", index),
                            format!("{} · {} KiB", name, entry.size.div_ceil(1024)),
                            p,
                            false,
                        )
                        .on_click(cx.listener(move |studio, _, _, cx| {
                            let result = studio.restore_recovery(&token, &name, cx);
                            studio.report(result, cx);
                        })),
                    );
                    if !entry.read_only {
                        row = row.child(
                            command_button(("recovery-delete", index), "삭제", p, false).on_click(
                                cx.listener(move |studio, _, _, cx| {
                                    let result = (|| {
                                        studio.io.clear_recovery(&deleting)?;
                                        studio.panel = Some(Panel::Recovery(studio.io.list()?));
                                        Ok(())
                                    })();
                                    studio.report(result, cx);
                                }),
                            ),
                        );
                    }
                    entries = entries.child(row);
                }
                content = content
                    .child(entries)
                    .child(self.action_button("cancel", "닫기", p, false, cx));
            }
            _ => {
                content = content
                    .child(div().text_lg().child("사용 방법"))
                    .child("붓 B · 지우개 E · 선택 V · 화면 이동 H · 문자 T")
                    .child("Ctrl 또는 Cmd + O 열기 · S 저장 · Z 실행 취소")
                    .child("휠 확대 · 가운데 버튼 화면 이동 · Enter 확정 · Esc 취소")
                    .child(self.action_button("cancel", "닫기", p, false, cx))
            }
        }
        div()
            .absolute()
            .inset_0()
            .bg(rgba(0x00000085))
            .flex()
            .items_center()
            .justify_center()
            .occlude()
            .child(content)
            .into_any_element()
    }
}

impl Render for Studio {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.update_text(cx);
        let touch = match self.preferences.density {
            Density::Auto => self.touch_available,
            Density::Touch => true,
            Density::Mouse => false,
        };
        let p = Palette::for_theme(self.preferences.classic, touch);
        let width = window.viewport_size().width;
        let narrow = width < px(840.);
        let show_labels = width >= px(1200.);
        let header = self.topbar(p, narrow, show_labels, cx);
        let tabs = self.tabs_view(p, cx);
        let tools = self.tools_view(p, cx);
        let footer = self.footer(p, cx);
        let inspector = (!narrow).then(|| self.inspector(p, narrow, window, cx));
        let state = self.editor.document().state();

        let view = cx.entity();
        let paint_view = cx.weak_entity();
        let measure = self.benchmark.is_some();
        let sheet = canvas(
            move |bounds, window, app| {
                view.update(app, |studio, _| {
                    studio.canvas_bounds = bounds;
                    studio.editor.resize_view(
                        f64::from(f32::from(bounds.size.width)),
                        f64::from(f32::from(bounds.size.height)),
                    );
                    let current = studio.editor.document().visual_generation();
                    if studio.last_generation != current {
                        studio.last_generation = current;
                        studio.preview_version = studio.preview_version.wrapping_add(1);
                    }
                    let pending = studio.editor.has_pending();
                    if pending != studio.had_preview {
                        studio.preview_version = studio.preview_version.wrapping_add(1);
                    }
                    let dirty = studio.editor.document_mut().take_visual_dirty();
                    let dirty = if pending || studio.had_preview {
                        None
                    } else {
                        dirty
                    };
                    studio.had_preview = pending;
                    let preview = if pending {
                        studio.editor.preview_state().ok()
                    } else {
                        None
                    };
                    let state = preview
                        .as_ref()
                        .unwrap_or_else(|| studio.editor.document().state());
                    let scene = studio.cache.prepare(
                        state,
                        studio.editor.active_tab().id,
                        studio.preview_version,
                        dirty,
                        *studio.editor.viewport(),
                        bounds,
                        window,
                    );
                    let selection = studio.editor.selection_region().map(|region| {
                        let viewport = studio.editor.viewport();
                        let (x, y) =
                            viewport.screen_point(f64::from(region.x), f64::from(region.y));
                        Bounds::new(
                            point(
                                bounds.origin.x + px(x as f32),
                                bounds.origin.y + px(y as f32),
                            ),
                            size(
                                px((f64::from(region.width) * viewport.zoom) as f32),
                                px((f64::from(region.height) * viewport.zoom) as f32),
                            ),
                        )
                    });
                    let viewport = *studio.editor.viewport();
                    let map = |x: f64, y: f64| {
                        let (x, y) = viewport.screen_point(x, y);
                        point(
                            bounds.origin.x + px(x as f32),
                            bounds.origin.y + px(y as f32),
                        )
                    };
                    let lasso = studio
                        .editor
                        .lasso_path()
                        .map(|path| path.iter().map(|&(x, y)| map(x, y)).collect::<Vec<_>>());
                    let resizing = studio.editor.canvas_resize_size().map(|(w, h)| {
                        Bounds::new(
                            map(0., 0.),
                            size(
                                px((f64::from(w) * viewport.zoom) as f32),
                                px((f64::from(h) * viewport.zoom) as f32),
                            ),
                        )
                    });
                    (scene, selection, lasso, resizing)
                })
            },
            move |bounds, (scene, selection, lasso, resizing), window, app| {
                scene.paint(bounds, window);
                for region in [selection, resizing].into_iter().flatten() {
                    let clipped = region.intersect(&bounds);
                    window.paint_quad(gpui::outline(
                        clipped,
                        rgba(0x78cbe7ff),
                        gpui::BorderStyle::Dashed,
                    ));
                }
                if let Some(points) = lasso
                    && let Some((&first, rest)) = points.split_first()
                {
                    let mut path = gpui::PathBuilder::stroke(px(1.));
                    path.move_to(first);
                    for &next in rest {
                        path.line_to(next);
                    }
                    if let Ok(path) = path.build() {
                        window.paint_path(path, rgb(0x159fea));
                    }
                }
                if measure {
                    crate::benchmark::paint_finished(&paint_view, app);
                }
            },
        )
        .size_full();
        let mut workspace = div()
            .relative()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .bg(rgb(p.canvas))
            .overflow_hidden()
            .child(sheet)
            .on_mouse_down(MouseButton::Left, cx.listener(Self::pointer_down))
            .on_mouse_down(MouseButton::Right, cx.listener(Self::pointer_down))
            .on_mouse_down(MouseButton::Middle, cx.listener(Self::pointer_down))
            .on_mouse_move(cx.listener(Self::pointer_move))
            .on_scroll(cx.listener(Self::wheel));
        for button in [MouseButton::Left, MouseButton::Right, MouseButton::Middle] {
            workspace = workspace
                .on_mouse_up(button, cx.listener(Self::pointer_up))
                .on_mouse_up_out(button, cx.listener(Self::pointer_up));
        }
        if self.panel.is_none() && self.text.is_none() && !self.editor.has_pending() {
            let view = self.editor.viewport();
            let paper_width = f64::from(state.width) * view.zoom;
            let paper_height = f64::from(state.height) * view.zoom;
            for (index, (edge, x, y)) in [
                (
                    CanvasEdge::East,
                    view.offset_x + paper_width,
                    view.offset_y + paper_height / 2.,
                ),
                (
                    CanvasEdge::South,
                    view.offset_x + paper_width / 2.,
                    view.offset_y + paper_height,
                ),
                (
                    CanvasEdge::SouthEast,
                    view.offset_x + paper_width,
                    view.offset_y + paper_height,
                ),
            ]
            .into_iter()
            .enumerate()
            {
                if x >= 4. && y >= 4. && x + 4. < view.width && y + 4. < view.height {
                    workspace = workspace.child(
                        div()
                            .id(("canvas-resize", index))
                            .absolute()
                            .left(px(x as f32 - 4.))
                            .top(px(y as f32 - 4.))
                            .size(px(8.))
                            .border_1()
                            .border_color(rgb(p.accent))
                            .bg(rgb(p.card))
                            .cursor_move()
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(move |studio, event: &MouseDownEvent, _, cx| {
                                    let result = studio.editor.begin_canvas_resize(
                                        studio.sample(event.position, event.modifiers.shift),
                                        edge,
                                    );
                                    studio.report(result, cx);
                                    cx.stop_propagation();
                                }),
                            ),
                    );
                }
            }
        }
        if let Some(text) = &self.text
            && !matches!(self.panel, Some(Panel::Export(_)))
        {
            workspace = workspace.child(
                div()
                    .absolute()
                    .left(px(16.))
                    .bottom(px(14.))
                    .w(px(300.))
                    .bg(rgb(p.card))
                    .border_1()
                    .border_color(rgb(p.border))
                    .p_2()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child("문자 입력")
                    .child(text.clone())
                    .child(
                        div()
                            .flex()
                            .gap_1()
                            .child(self.action_button("commit", "확정", p, true, cx))
                            .child(self.action_button("cancel", "취소", p, false, cx)),
                    ),
            );
        }
        let mut body = div()
            .flex()
            .flex_1()
            .min_h_0()
            .child(tools)
            .child(workspace);
        if !narrow && let Some(inspector) = inspector {
            body = body.child(inspector);
        }
        let mut root = div()
            .relative()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::keyboard))
            .size_full()
            .bg(rgb(p.main))
            .text_color(rgb(p.text))
            .text_size(px(13.))
            .font_family(if p.classic { "Tahoma" } else { "Segoe UI" })
            .flex()
            .flex_col()
            .child(header)
            .child(tabs)
            .child(body)
            .child(footer);
        if narrow && self.inspector_overlay.is_some() {
            root = root.child(
                div()
                    .absolute()
                    .right(px(8.))
                    .top(p.target + px(21.))
                    .bottom(px(8.))
                    .shadow_lg()
                    .occlude()
                    .child(self.inspector(p, true, window, cx)),
            );
        }
        if let Some(category) = self.menu {
            root = root.child(self.categorized_menu(category, p, cx));
        }

        if self.panel.is_some() {
            root = root.child(self.view_panel(p, cx));
        }
        root
    }
}
