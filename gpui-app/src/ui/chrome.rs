use std::{
    cell::Cell,
    rc::Rc,
    sync::{Arc, Weak},
};

use gpui::{FontWeight, Role, Stateful, Toggled, svg};

use super::*;
use crate::engine::source_over;

pub(super) const CATEGORIES: &[Row] = &[
    ("file", "파일"),
    ("edit", "편집"),
    ("image", "이미지"),
    ("layer", "레이어"),
    ("setup", "설정"),
    ("help", "도움말"),
];

const TOOL_ICONS: [&str; 17] = [
    "brush",
    "pencil",
    "eraser",
    "fill",
    "picker",
    "spray",
    "color-eraser",
    "line",
    "curve",
    "rectangle",
    "roundrect",
    "ellipse",
    "polygon",
    "select",
    "lasso",
    "text",
    "pan",
];

const SWATCHES: [u32; 16] = [
    0x000000, 0xffffff, 0x687386, 0xb6c1ce, 0x1679ea, 0x8058e8, 0xf08063, 0xe3b66a, 0x35b69a,
    0xc64f71, 0xbe2d33, 0x167448, 0x173479, 0x894b19, 0xe9dbe8, 0xf9e7b0,
];

const HELP: &[Row] = &[("help", "사용 방법")];

pub(super) fn icon_button(
    id: impl Into<gpui::ElementId>,
    icon: &'static str,
    label: &'static str,
    show_label: bool,
    p: Palette,
    selected: bool,
    compact: bool,
) -> Stateful<gpui::Div> {
    let mut button = super::button(id, label, p, selected).child(
        svg()
            .path(icon)
            .text_color(rgb(if selected { p.on } else { p.text }))
            .size(px(if compact { 16. } else { 21. }))
            .flex_none(),
    );
    if compact {
        let target = if p.target > px(36.) {
            p.target
        } else {
            px(26.)
        };
        button = button.min_h(target).min_w(target).px(px(3.));
    }
    if show_label {
        button = button.child(label);
    }
    button
}

fn command_icon(key: &str) -> &'static str {
    match key {
        "open" | "insert" => "open",
        "new" | "zoom-in" | "layer-add" => "plus",
        "zoom-out" | "layer-delete" => "minus",
        "save" | "save-as" | "recover" => "save",
        "export" => "export",
        "undo" | "rotate-left" => "undo",
        "redo" | "rotate-right" => "redo",
        "fit" | "image-size" | "selection-size" => "fit",
        "settings" => "settings",
        "layer-up" | "layer-down" | "layer-merge" | "layers" => "layers",
        "properties" | "background" | "invert" => "palette",
        "canvas-size" => "rectangle",
        "shear" => "polygon",
        "flip-x" | "flip-y" => "pan",
        "text-options" | "layer-rename" => "text",
        "clear" | "delete" => "eraser",
        "copy" | "cut" | "paste" | "select-all" | "crop" => "select",
        _ => "menu",
    }
}

fn tools_button(tool: Tool, p: Palette, selected: bool) -> Stateful<gpui::Div> {
    icon_button(
        ("tool", tool as usize),
        TOOL_ICONS[tool as usize],
        tool.label(),
        false,
        p,
        selected,
        false,
    )
    .px_0()
}

#[derive(Clone, Copy)]
enum BrushControl {
    Size,
    Opacity,
    Hardness,
    Stabilization,
}

impl BrushControl {
    fn set(
        self,
        studio: &mut Studio,
        point_x: Pixels,
        bounds: Bounds<Pixels>,
        cx: &mut Context<Studio>,
    ) {
        let width = f32::from(bounds.size.width) - 14.;
        if width <= 0. {
            return;
        }
        let ratio = f64::from(((f32::from(point_x - bounds.origin.x) - 7.) / width).clamp(0., 1.));
        let brush = &mut studio.editor.settings;
        match self {
            Self::Size => brush.size = (1. + 99. * ratio).round(),
            Self::Opacity => brush.opacity = (1. + 99. * ratio).round() / 100.,
            Self::Hardness => brush.hardness = (100. * ratio).round() / 100.,
            Self::Stabilization => brush.stabilization = (75. * ratio).round(),
        }
        cx.notify();
    }

    fn view(
        self,
        settings: &crate::editor::ToolSettings,
        p: Palette,
        cx: &mut Context<Studio>,
    ) -> impl IntoElement + use<> {
        let (label, value, fraction) = match self {
            Self::Size => (
                "크기",
                format!("{:.0} px", settings.size),
                (settings.size - 1.) / 99.,
            ),
            Self::Opacity => (
                "불투명도",
                format!("{:.0}%", 100. * settings.opacity),
                (100. * settings.opacity - 1.) / 99.,
            ),
            Self::Hardness => (
                "경도",
                format!("{:.0}%", 100. * settings.hardness),
                settings.hardness,
            ),
            Self::Stabilization => (
                "선 보정",
                format!("{:.0}", settings.stabilization),
                settings.stabilization / 75.,
            ),
        };
        let bounds = Rc::new(Cell::new(Bounds::default()));
        let prepaint = bounds.clone();
        let dragging = bounds.clone();
        div()
            .flex()
            .flex_col()
            .gap(px(5.))
            .child(div().flex().justify_between().child(label).child(value))
            .child(
                div()
                    .id(label)
                    .role(Role::Slider)
                    .aria_label(label)
                    .cursor_pointer()
                    .h(p.target)
                    .w_full()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |studio, e: &MouseDownEvent, _, cx| {
                            self.set(studio, e.position.x, bounds.get(), cx);
                        }),
                    )
                    .on_mouse_move(cx.listener(move |studio, e: &MouseMoveEvent, _, cx| {
                        if e.pressed_button == Some(MouseButton::Left) {
                            self.set(studio, e.position.x, dragging.get(), cx);
                        }
                    }))
                    .child(
                        canvas(
                            move |b, _, _| prepaint.set(b),
                            move |b, (), w, _| {
                                let left = b.origin.x + px(7.);
                                let y = b.origin.y + b.size.height / 2.;
                                let width = (b.size.width - px(14.)).max(px(0.));
                                let thumb = left + width * fraction.clamp(0., 1.) as f32;
                                w.paint_quad(gpui::fill(
                                    Bounds::new(point(left, y - px(2.)), size(width, px(4.))),
                                    rgb(p.border),
                                ));
                                w.paint_quad(gpui::fill(
                                    Bounds::new(
                                        point(left, y - px(2.)),
                                        size(thumb - left, px(4.)),
                                    ),
                                    rgb(p.accent),
                                ));
                                w.paint_quad(
                                    gpui::fill(
                                        Bounds::new(
                                            point(thumb - px(6.), y - px(6.)),
                                            size(px(12.), px(12.)),
                                        ),
                                        rgb(p.accent),
                                    )
                                    .corner_radii(px(if p.classic { 0. } else { 6. })),
                                );
                            },
                        )
                        .size_full(),
                    ),
            )
    }
}

#[derive(Default)]
pub(super) struct Thumbnails {
    layers: Vec<(Weak<Vec<u8>>, Arc<RenderImage>)>,
    dimensions: (u32, u32),
}

impl Thumbnails {
    pub(super) fn update(&mut self, state: &State, window: &mut Window) {
        let dimensions = (state.width, state.height);
        let mut previous = std::mem::take(&mut self.layers);
        if self.dimensions != dimensions {
            for (_, image) in previous.drain(..) {
                let _ = window.drop_image(image);
            }
            self.dimensions = dimensions;
        }
        for layer in &state.layers {
            let pixels = Arc::downgrade(&layer.pixels);
            if let Some(i) = previous
                .iter()
                .position(|(source, _)| source.ptr_eq(&pixels))
            {
                self.layers.push(previous.swap_remove(i));
                continue;
            }
            let scale = (42. / f64::from(state.width)).min(30. / f64::from(state.height));
            let width = (f64::from(state.width) * scale).round().clamp(1., 42.) as u32;
            let height = (f64::from(state.height) * scale).round().clamp(1., 30.) as u32;
            let image = image::RgbaImage::from_fn(42, 30, |x, y| {
                let c = if (x / 6 + y / 6).is_multiple_of(2) {
                    255
                } else {
                    221
                };
                let mut pixel = [c, c, c, 255];
                if let Some(x) = x.checked_sub((42 - width) / 2)
                    && let Some(y) = y.checked_sub((30 - height) / 2)
                    && x < width
                    && y < height
                {
                    let i = ((y * state.height / height) * state.width + x * state.width / width)
                        as usize
                        * 4;
                    source_over(
                        &mut pixel,
                        layer.pixels[i..i + 4].try_into().expect("layer pixel"),
                    );
                }
                image::Rgba([pixel[2], pixel[1], pixel[0], 255])
            });
            let image = Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(
                image
            )]));
            self.layers.push((pixels, image));
        }
        for (_, image) in previous {
            let _ = window.drop_image(image);
        }
    }
}

enum EraserOption {
    Mode(EraserMode),
    Color,
}

impl Studio {
    fn icon_action(
        &self,
        key: &'static str,
        label: &'static str,
        show: bool,
        p: Palette,
        selected: bool,
        compact: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        icon_button(key, command_icon(key), label, show, p, selected, compact).on_click(
            cx.listener(move |studio, _, window, cx| {
                let result = studio.command(key, window, cx);
                studio.report(result, cx);
            }),
        )
    }

    pub(super) fn topbar(
        &self,
        p: Palette,
        narrow: bool,
        show_labels: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let tab = self.editor.active_tab();
        let title = div()
            .flex_1()
            .min_w_0()
            .text_ellipsis()
            .whitespace_nowrap()
            .text_color(rgb(if p.classic { p.on } else { p.muted }))
            .when(p.classic, |d| {
                d.bg(gpui::linear_gradient(
                    90.,
                    gpui::linear_color_stop(rgb(0x000080), 0.),
                    gpui::linear_color_stop(rgb(0x1084d0), 1.),
                ))
                .px(px(7.))
                .py(px(5.))
                .font_weight(FontWeight::BOLD)
            })
            .child(format!(
                "{}{}",
                tab.name,
                if tab.document.dirty() { " *" } else { "" }
            ));
        div()
            .flex()
            .items_center()
            .gap(px(if narrow { 3. } else { 7. }))
            .px(px(if narrow { 6. } else { 12. }))
            .py(px(8.))
            .bg(rgb(p.card))
            .border_b_1()
            .border_color(rgb(p.border))
            .child(
                div()
                    .text_size(px(if narrow { 16. } else { 18. }))
                    .mr(px(if show_labels { 12. } else { 0. }))
                    .font_weight(FontWeight::BOLD)
                    .text_color(rgb(if p.classic { p.text } else { p.accent }))
                    .child("myPaint"),
            )
            .child(
                icon_button(
                    "menu",
                    "menu",
                    "파일 및 편집 메뉴",
                    false,
                    p,
                    self.menu.is_some(),
                    false,
                )
                .on_click(cx.listener(|studio, _, window, cx| {
                    if studio.panel.is_none() && !studio.file_write_pending() {
                        studio.touch.cancel(&mut studio.editor);
                        studio.menu = Some("file");
                        studio.focus.focus(window, cx);
                        cx.notify();
                    }
                })),
            )
            .child(self.icon_action("open", "열기", show_labels, p, false, false, cx))
            .child(self.icon_action("undo", "실행 취소", false, p, false, false, cx))
            .child(self.icon_action("redo", "다시 실행", false, p, false, false, cx))
            .child(title)
            .when(narrow, |bar| {
                bar.child(self.icon_action(
                    "properties",
                    "색상과 브러시",
                    false,
                    p,
                    false,
                    false,
                    cx,
                ))
                .child(self.icon_action(
                    "layers",
                    "레이어 패널",
                    false,
                    p,
                    false,
                    false,
                    cx,
                ))
            })
            .child(self.icon_action("settings", "설정", true, p, false, false, cx))
            .child(self.icon_action("export", "내보내기", show_labels, p, false, false, cx))
            .child(self.icon_action("save", "프로젝트", show_labels, p, true, false, cx))
    }

    pub(super) fn tabs_view(&self, p: Palette, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let active = self.editor.active_tab().id;
        let tabs = div()
            .id("documents")
            .role(Role::TabList)
            .flex()
            .flex_1()
            .min_w_0()
            .overflow_x_scroll()
            .children(self.editor.tabs.iter().map(|tab| {
                let id = tab.id;
                let label = format!(
                    "{}{}",
                    if tab.document.dirty() { "• " } else { "" },
                    tab.name
                );
                div()
                    .flex()
                    .flex_none()
                    .border_r_1()
                    .border_color(rgb(p.border))
                    .child(
                        button(("tab", id as usize), label.clone(), p, active == id)
                            .role(Role::Tab)
                            .max_w(px(220.))
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .child(label)
                            .on_click(cx.listener(move |studio, _, _, cx| {
                                let result = studio.switch_tab(id, cx);
                                studio.report(result, cx);
                            })),
                    )
                    .child(
                        icon_button(
                            ("close-tab", id as usize),
                            "close",
                            "그림 탭 닫기",
                            false,
                            p,
                            false,
                            true,
                        )
                        .min_h(p.target)
                        .on_click(cx.listener(move |studio, _, _, cx| {
                            let result = studio.close_tab(id, false);
                            studio.report(result, cx);
                        })),
                    )
            }));
        div()
            .flex()
            .bg(rgb(p.card))
            .border_b_1()
            .border_color(rgb(p.border))
            .child(tabs)
            .child(self.icon_action("new", "새 그림 탭", false, p, false, false, cx))
    }

    pub(super) fn tools_view(
        &self,
        p: Palette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        div()
            .id("tools")
            .w(px(if p.target > px(36.) { 78. } else { 54. }))
            .flex_none()
            .bg(rgb(p.card))
            .px(px(7.))
            .py(px(7.))
            .flex()
            .flex_col()
            .gap(px(3.))
            .overflow_y_scroll()
            .children(Tool::ALL.into_iter().map(|tool| {
                tools_button(tool, p, self.editor.settings.tool == tool).on_click(cx.listener(
                    move |studio, _, _, cx| {
                        studio.touch.cancel(&mut studio.editor);
                        let result = studio.editor.choose_tool(tool).map(|_| ());
                        studio.text = None;
                        studio.report(result, cx);
                    },
                ))
            }))
    }

    pub(super) fn footer(&self, p: Palette, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let state = self.editor.document().state();
        div()
            .flex()
            .items_center()
            .gap(px(12.))
            .px(px(12.))
            .py(px(5.))
            .border_t_1()
            .border_color(rgb(p.border))
            .text_color(rgb(p.muted))
            .text_size(px(12.))
            .child(self.editor.settings.tool.label())
            .child(format!("{} × {}", state.width, state.height))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .child(self.status.clone()),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .child(self.icon_action("zoom-out", "축소", false, p, false, true, cx))
                    .child(format!("{:.0}%", self.editor.viewport().zoom * 100.))
                    .child(self.icon_action("zoom-in", "확대", false, p, false, true, cx))
                    .child(self.icon_action("fit", "화면에 맞추기", false, p, false, true, cx)),
            )
    }

    pub(super) fn categorized_menu(
        &self,
        current: &'static str,
        p: Palette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let commands = match current {
            "file" => FILE,
            "edit" => EDIT,
            "image" => IMAGE,
            "layer" => LAYER,
            "setup" => SETUP,
            _ => HELP,
        };
        let grid = div()
            .flex()
            .flex_col()
            .gap_2()
            .children(commands.chunks(2).map(|row| {
                div()
                    .flex()
                    .gap_2()
                    .children(row.iter().map(|&(key, label)| {
                        let (label, enabled) = match key {
                            "insert" => ("현재 그림에 사진 삽입", true),
                            "save-as" => ("프로젝트 다른 이름 저장", true),
                            "crop" | "selection-size" => {
                                (label, self.editor.selection_region().is_some())
                            }
                            _ => (label, true),
                        };
                        let mut command =
                            icon_button(key, command_icon(key), label, true, p, false, false)
                                .flex_1()
                                .justify_start()
                                .border_color(rgb(p.border));
                        if enabled {
                            command =
                                command.on_click(cx.listener(move |studio, _, window, cx| {
                                    let result = studio.command(key, window, cx);
                                    studio.report(result, cx);
                                }));
                        } else {
                            command = command.opacity(0.4);
                        }
                        command
                    }))
                    .when(row.len() == 1, |line| line.child(div().flex_1()))
            }));
        div()
            .absolute()
            .inset_0()
            .flex()
            .justify_center()
            .items_center()
            .bg(rgba(0x05080e99))
            .occlude()
            .child(
                div()
                    .id("categorized-menu")
                    .role(Role::Dialog)
                    .aria_label("메뉴")
                    .w(px(580.))
                    .max_w(gpui::relative(0.94))
                    .p(px(20.))
                    .flex()
                    .flex_col()
                    .gap_2()
                    .border_1()
                    .border_color(rgb(p.border))
                    .rounded(p.radius)
                    .bg(rgb(p.card))
                    .shadow_lg()
                    .child(
                        div()
                            .text_size(px(19.))
                            .font_weight(FontWeight::BOLD)
                            .child("메뉴"),
                    )
                    .child(
                        div()
                            .id("menu-categories")
                            .role(Role::TabList)
                            .flex()
                            .flex_wrap()
                            .gap_1()
                            .pb_2()
                            .border_b_1()
                            .border_color(rgb(p.border))
                            .children(CATEGORIES.iter().enumerate().map(
                                |(index, &(key, label))| {
                                    command_button(("category", index), label, p, key == current)
                                        .role(Role::Tab)
                                        .aria_selected(key == current)
                                        .on_click(cx.listener(move |studio, _, _, cx| {
                                            studio.menu = Some(key);
                                            cx.notify();
                                        }))
                                },
                            )),
                    )
                    .child(grid)
                    .child(
                        command_button("menu-close", "닫기", p, false)
                            .self_end()
                            .on_click(cx.listener(|studio, _, w, cx| {
                                studio.menu = None;
                                studio.focus.focus(w, cx);
                                cx.notify();
                            })),
                    ),
            )
    }

    pub(super) fn settings_view(
        &self,
        draft: &Preferences,
        p: Palette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        div()
            .flex()
            .flex_col()
            .gap(px(15.))
            .child(
                div()
                    .text_size(px(18.))
                    .font_weight(FontWeight::BOLD)
                    .child("환경설정"),
            )
            .child(self.preference_select(
                "skin",
                "스킨",
                draft.classic,
                [(false, "Studio Dark"), (true, "Classic 98")],
                |prefs, value| prefs.classic = value,
                p,
                cx,
            ))
            .child(self.preference_select(
                "density",
                "조작부 크기",
                draft.density,
                [
                    (Density::Auto, "자동"),
                    (Density::Touch, "터치"),
                    (Density::Mouse, "마우스"),
                ],
                |prefs, value| prefs.density = value,
                p,
                cx,
            ))
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(7.))
                    .mt(px(16.))
                    .child(self.action_button("cancel", "취소", p, false, cx))
                    .child(command_button("accept-settings", "확인", p, true).on_click(
                        cx.listener(|studio, _, window, cx| {
                            let result = studio.accept_preferences(window, cx);
                            studio.report(result, cx);
                        }),
                    )),
            )
    }

    fn preference_select<T: Copy + Eq + 'static, const N: usize>(
        &self,
        key: &'static str,
        name: &'static str,
        selected: T,
        options: [(T, &'static str); N],
        update: fn(&mut Preferences, T),
        p: Palette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<T, N> {
        let caption = options
            .iter()
            .find(|(value, _)| *value == selected)
            .map(|(_, text)| *text)
            .unwrap_or("");
        let expanded = self.settings_dropdown == Some(key);
        let choices = expanded.then(|| {
            div()
                .flex()
                .flex_col()
                .gap_1()
                .w(px(180.))
                .self_end()
                .border_1()
                .border_color(rgb(p.border))
                .rounded(p.radius)
                .bg(rgb(p.field))
                .children(
                    options
                        .into_iter()
                        .enumerate()
                        .map(|(index, (value, label))| {
                            command_button((key, index), label, p, selected == value)
                                .justify_start()
                                .on_click(cx.listener(move |studio, _, _, cx| {
                                    if let Some(Panel::Settings(draft)) = &mut studio.panel {
                                        update(draft, value);
                                        studio.settings_dropdown = None;
                                        cx.notify();
                                    }
                                }))
                        }),
                )
        });
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_center()
                    .child(name)
                    .child(
                        button(key, name, p, false)
                            .justify_between()
                            .w(px(180.))
                            .border_color(rgb(p.border))
                            .bg(rgb(p.field))
                            .child(caption)
                            .child("⌄")
                            .on_click(cx.listener(move |studio, _, _, cx| {
                                studio.settings_dropdown = (!expanded).then_some(key);
                                cx.notify();
                            })),
                    ),
            )
            .children(choices)
    }

    pub(super) fn inspector(
        &mut self,
        p: Palette,
        narrow: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let touch = p.target > px(36.);
        let state = self.editor.document().state();
        self.thumbnails.update(state, window);
        let layer_list = div()
            .id("layer-list")
            .role(Role::List)
            .flex()
            .flex_1()
            .min_h_0()
            .flex_col()
            .overflow_y_scroll()
            .p(px(8.))
            .children(state.layers.iter().enumerate().rev().map(|(i, layer)| {
                let desired = !layer.visible;
                let active = i == state.active;
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(5.))
                    .p(px(5.))
                    .rounded(p.radius)
                    .when(active, |row| row.bg(rgb(p.border)))
                    .child(
                        button(
                            ("layer-visibility", i),
                            if layer.visible {
                                "레이어 숨기기"
                            } else {
                                "레이어 표시"
                            },
                            p,
                            false,
                        )
                        .min_h(if touch { p.target } else { px(24.) })
                        .min_w(if touch { p.target } else { px(24.) })
                        .px_0()
                        .child(if layer.visible { "✓" } else { "" })
                        .on_click(cx.listener(move |studio, _, _, cx| {
                            let result = studio
                                .editor
                                .layer_edit(LayerEdit::SetVisible {
                                    index: i,
                                    visible: desired,
                                })
                                .map(|_| ());
                            studio.queue_recovery(studio.editor.active_tab().id, cx);
                            studio.report(result, cx);
                        })),
                    )
                    .child(
                        img(self.thumbnails.layers[i].1.clone())
                            .w(px(42.))
                            .h(px(30.))
                            .flex_none(),
                    )
                    .child(
                        command_button(("layer", i), layer.name.clone(), p, active)
                            .min_w_0()
                            .flex_1()
                            .justify_start()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .on_click(cx.listener(move |studio, _, _, cx| {
                                let result = studio.editor.set_active_layer(i).map(|_| ());
                                studio.report(result, cx);
                            })),
                    )
            }));
        let layer_commands = [
            ("layer-add", "+"),
            ("layer-delete", "−"),
            ("layer-up", "↑"),
            ("layer-down", "↓"),
            ("layer-merge", "⇣"),
            ("layer-rename", "✎"),
        ];
        let actions = div().flex().flex_col().gap(px(4.)).p(px(7.)).children(
            layer_commands.chunks(if touch { 3 } else { 6 }).map(|row| {
                div()
                    .flex()
                    .gap(px(if touch { 4. } else { 2. }))
                    .children(row.iter().map(|&(key, symbol)| {
                        command_button(key, symbol, p, false)
                            .flex_1()
                            .min_w_0()
                            .px_0()
                            .on_click(cx.listener(move |studio, _, window, cx| {
                                let result = studio.command(key, window, cx);
                                studio.report(result, cx);
                            }))
                    }))
            }),
        );
        let layers = div()
            .flex_none()
            .h(px(if touch { 250. } else { 210. }))
            .flex()
            .flex_col()
            .border_t_1()
            .border_color(rgb(p.border))
            .child(heading("레이어 · 위 → 아래", p))
            .child(layer_list)
            .child(actions);
        let settings = &self.editor.settings;
        let selected = self.preferences.eraser_mode;
        let background = self.preferences.eraser_background;
        let eraser = div()
            .relative()
            .flex()
            .flex_col()
            .gap(px(6.))
            .border_1()
            .border_color(rgb(p.border))
            .p(px(8.))
            .mt(px(6.))
            .mb(px(12.))
            .child(
                div()
                    .absolute()
                    .left(px(8.))
                    .top(px(-9.))
                    .px(px(3.))
                    .bg(rgb(p.card))
                    .child("지우개 설정"),
            )
            .child("지우는 방식")
            .child(
                button("eraser-mode", "지우는 방식", p, false)
                    .justify_between()
                    .text_size(px(if touch { 16. } else { 13. }))
                    .bg(rgb(p.field))
                    .border_color(rgb(p.border))
                    .child(eraser_label(selected))
                    .child("⌄")
                    .on_click(cx.listener(|studio, _, _, cx| {
                        studio.eraser_menu = !studio.eraser_menu;
                        cx.notify();
                    })),
            )
            .when(self.eraser_menu, |options| {
                options.children(
                    [EraserMode::Transparent, EraserMode::Background].map(|mode| {
                        command_button(eraser_label(mode), eraser_label(mode), p, mode == selected)
                            .justify_start()
                            .on_click(cx.listener(move |studio, _, window, cx| {
                                studio.eraser_option(EraserOption::Mode(mode), window, cx)
                            }))
                    }),
                )
            })
            .child(
                div()
                    .flex()
                    .gap_2()
                    .items_center()
                    .child("지우개 배경색")
                    .child(
                        color_chip(
                            "eraser-color",
                            "지우개 배경색",
                            [background[0], background[1], background[2], 255],
                            p,
                        )
                        .when(selected == EraserMode::Transparent, |chip| {
                            chip.cursor_default()
                        })
                        .when(selected == EraserMode::Background, |chip| {
                            chip.on_click(cx.listener(|studio, _, w, cx| {
                                studio.eraser_option(EraserOption::Color, w, cx)
                            }))
                        }),
                    ),
            )
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(rgb(p.muted))
                    .child("활성 레이어에만 적용 · 기존 그림과 문서 바탕은 유지"),
            );
        let color = settings.foreground;
        let wheel = self.color_wheel.view(
            color,
            px(if touch {
                f32::from(window.viewport_size().height * 0.32).clamp(96., 210.)
            } else {
                210.
            }),
            window,
            cx,
        );
        let controls = div()
            .id("properties")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .px(px(14.))
            .py(px(12.))
            .gap(px(13.))
            .child(eraser)
            .child(wheel)
            .child(
                div()
                    .flex()
                    .gap(px(6.))
                    .child(
                        color_chip("foreground-picker", "전경색", color, p).on_click(cx.listener(
                            |studio, _, window, cx| {
                                let result = studio.command("foreground", window, cx);
                                studio.report(result, cx);
                            },
                        )),
                    )
                    .child(
                        command_button("foreground", hex(color), p, false)
                            .flex_1()
                            .justify_start()
                            .bg(rgb(p.field))
                            .border_color(rgb(p.border))
                            .on_click(cx.listener(|studio, _, window, cx| {
                                let result = studio.command("foreground", window, cx);
                                studio.report(result, cx);
                            })),
                    ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child("보조색")
                    .child(
                        color_chip("secondary", "보조색", settings.secondary, p).on_click(
                            cx.listener(|studio, _, window, cx| {
                                let result = studio.command("secondary", window, cx);
                                studio.report(result, cx);
                            }),
                        ),
                    )
                    .child(self.action_button("swap", "↔", p, false, cx)),
            )
            .child(
                div().flex().gap_1().children(
                    [
                        ("잉크", Tool::Brush, 1., 25.),
                        ("부드러운 붓", Tool::Brush, 0.25, 25.),
                        ("픽셀", Tool::Pencil, 1., 0.),
                    ]
                    .map(|(name, tool, hardness, stabilization)| {
                        command_button(name, name, p, false)
                            .flex_1()
                            .px(px(5.))
                            .on_click(cx.listener(move |studio, _, _, cx| {
                                studio.touch.cancel(&mut studio.editor);
                                let result = studio
                                    .editor
                                    .choose_tool(tool)
                                    .map(|_| {
                                        let brush = &mut studio.editor.settings;
                                        brush.hardness = hardness;
                                        brush.opacity = 1.;
                                        brush.stabilization = stabilization;
                                    })
                                    .map(|_| ());
                                studio.report(result, cx);
                            }))
                    }),
                ),
            )
            .children(
                [
                    BrushControl::Size,
                    BrushControl::Opacity,
                    BrushControl::Hardness,
                    BrushControl::Stabilization,
                ]
                .map(|control| control.view(settings, p, cx)),
            )
            .children(
                [
                    ("pressure", "펜 필압으로 크기 조절", settings.pressure),
                    ("finger", "손가락으로 그리기", settings.finger_draw),
                    ("square", "사각 브러시", settings.square),
                    ("fill-shape", "도형 내부 채우기", settings.fill_shape),
                    ("outline-shape", "도형 윤곽선", settings.outline_shape),
                    (
                        "transparent-selection",
                        "선택의 보조색을 투명하게",
                        settings.transparent_selection,
                    ),
                ]
                .map(|(key, label, value)| {
                    button(key, label, p, false)
                        .role(Role::CheckBox)
                        .aria_toggled(if value { Toggled::True } else { Toggled::False })
                        .justify_start()
                        .min_h(if touch { p.target } else { px(19.) })
                        .px_0()
                        .child(
                            div()
                                .size(px(14.))
                                .text_size(px(11.))
                                .line_height(px(12.))
                                .text_center()
                                .border_1()
                                .border_color(rgb(p.border))
                                .rounded(px(if p.classic { 0. } else { 3. }))
                                .bg(rgb(if value { p.accent } else { p.field }))
                                .text_color(rgb(p.on))
                                .child(if value { "✓" } else { "" }),
                        )
                        .child(label)
                        .on_click(cx.listener(move |studio, _, window, cx| {
                            let result = studio.command(key, window, cx);
                            studio.report(result, cx);
                        }))
                }),
            )
            .child(
                div().flex().flex_col().gap_1().children(
                    SWATCHES
                        .chunks(if touch { 5 } else { 8 })
                        .enumerate()
                        .map(|(row, colors)| {
                            div().flex().gap_1().children(colors.iter().enumerate().map(
                                |(col, &color)| {
                                    div()
                                        .id(("swatch", row * 8 + col))
                                        .role(Role::Button)
                                        .aria_label(format!("#{color:06x}"))
                                        .flex_1()
                                        .h(if touch { px(43.) } else { px(24.) })
                                        .rounded(px(if p.classic { 0. } else { 3. }))
                                        .bg(rgb(color))
                                        .border_1()
                                        .border_color(rgb(p.border))
                                        .cursor_pointer()
                                        .on_click(cx.listener(move |studio, _, _, cx| {
                                            let [_, r, g, b] = color.to_be_bytes();
                                            studio.editor.settings.foreground = [r, g, b, 255];
                                            studio.refresh(cx);
                                        }))
                                },
                            ))
                        }),
                ),
            )
            .child(self.action_button("text-options", "글꼴 · 문자 설정", p, false, cx));

        div()
            .id("inspector")
            .w(px(if narrow {
                320.
            } else if touch {
                282.
            } else {
                274.
            }))
            .flex_none()
            .min_h_0()
            .bg(rgb(p.card))
            .border_l_1()
            .border_color(rgb(p.border))
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .child(heading("색상 · 브러시", p).flex_1())
                    .when(narrow, |row| {
                        row.child(
                            icon_button(
                                "close-inspector",
                                "close",
                                "패널 닫기",
                                false,
                                p,
                                false,
                                false,
                            )
                            .on_click(cx.listener(
                                |studio, _, _, cx| {
                                    studio.inspector_overlay = None;
                                    cx.notify();
                                },
                            )),
                        )
                    }),
            )
            .when(
                !narrow || self.inspector_overlay != Some("layers"),
                |panel| panel.child(controls),
            )
            .child(layers)
    }

    fn eraser_option(&mut self, option: EraserOption, window: &mut Window, cx: &mut Context<Self>) {
        self.eraser_menu = false;
        let result = match option {
            EraserOption::Color => self.command("eraser-color", window, cx),
            EraserOption::Mode(mode) => {
                let mut preferences = self.preferences.clone();
                preferences.eraser_mode = mode;
                self.apply_preferences(preferences)
            }
        };
        self.report(result, cx);
    }
}

fn heading(label: &'static str, p: Palette) -> gpui::Div {
    div()
        .px(px(14.))
        .py(px(12.))
        .border_b_1()
        .border_color(rgb(p.border))
        .text_size(px(12.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(rgb(p.muted))
        .child(label)
}

fn color_chip(
    id: &'static str,
    label: &'static str,
    color: Color,
    p: Palette,
) -> Stateful<gpui::Div> {
    button(id, label, p, false)
        .w(px(50.))
        .h(px(38.))
        .flex_none()
        .bg(rgb(p.field))
        .border_color(rgb(p.border))
        .p(px(3.))
        .child(
            div()
                .size_full()
                .border_1()
                .border_color(rgb(p.border))
                .bg(rgb(u32::from_be_bytes([0, color[0], color[1], color[2]]))),
        )
}

fn eraser_label(mode: EraserMode) -> &'static str {
    match mode {
        EraserMode::Transparent => "투명하게 지우기",
        EraserMode::Background => "배경색으로 지우기",
    }
}
