use std::ops::Range;

use gpui::{
    Bounds, ClipboardItem, Context, CursorStyle, ElementInputHandler, EntityInputHandler,
    FocusHandle, Focusable, KeyDownEvent, MouseButton, MouseDownEvent, Pixels, Point, ShapedLine,
    TextAlign, TextRun, UTF16Selection, Window, canvas, div, fill, point, prelude::*, px, rgb,
    size,
};

pub struct TextField {
    value: String,
    selection: Range<usize>,
    marked: Option<Range<usize>>,
    focus: FocusHandle,
    multiline: bool,
    layout: Vec<(usize, ShapedLine)>,
    bounds: Option<Bounds<Pixels>>,
}

impl TextField {
    pub fn new(value: String, multiline: bool, cx: &mut Context<Self>) -> Self {
        let selection = 0..value.len();
        Self {
            value,
            selection,
            marked: None,
            focus: cx.focus_handle().tab_stop(true),
            multiline,
            layout: Vec::new(),
            bounds: None,
        }
    }

    pub fn text(&self) -> &str {
        &self.value
    }

    pub fn composing(&self) -> bool {
        self.marked.is_some()
    }

    fn utf8_index(&self, units: usize) -> usize {
        let mut offset = 0;
        for (index, ch) in self.value.char_indices() {
            if offset + ch.len_utf16() > units {
                return index;
            }
            offset += ch.len_utf16();
        }
        self.value.len()
    }

    fn utf16_index(&self, index: usize) -> usize {
        self.value[..index].encode_utf16().count()
    }

    fn native_range(&self, range: Range<usize>) -> Range<usize> {
        self.utf16_index(range.start)..self.utf16_index(range.end)
    }

    fn insert(&mut self, range: Range<usize>, text: &str) -> Range<usize> {
        let filtered;
        let text = if self.multiline {
            text
        } else {
            filtered = text.replace(['\r', '\n'], "");
            &filtered
        };
        if self.value.len() - range.len() + text.len() > 16_384 {
            return range.end..range.end;
        }
        let start = range.start;
        self.value.replace_range(range, text);
        start..start + text.len()
    }

    fn on_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = &event.keystroke.key;
        let mods = event.keystroke.modifiers;
        let command = mods.control || mods.platform;
        if self.marked.is_some() && !command {
            return;
        }
        let start = self.selection.start;
        let end = self.selection.end;
        let before = self.value[..start]
            .char_indices()
            .next_back()
            .map_or(0, |(i, _)| i);
        let after = self.value[end..]
            .chars()
            .next()
            .map_or(end, |ch| end + ch.len_utf8());
        match (command, key.as_str()) {
            (true, "a") => self.selection = 0..self.value.len(),
            (true, "c" | "x") => {
                if start != end {
                    cx.write_to_clipboard(ClipboardItem::new_string(
                        self.value[start..end].to_string(),
                    ));
                    if key == "x" {
                        self.value.replace_range(start..end, "");
                        self.selection = start..start;
                    }
                }
            }
            (true, "v") => {
                if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                    self.replace_text_in_range(None, &text, window, cx);
                }
            }
            (false, "left") => {
                self.selection = if mods.shift {
                    before..end
                } else {
                    let pos = if start != end { start } else { before };
                    pos..pos
                };
            }
            (false, "right") => {
                self.selection = if mods.shift {
                    start..after
                } else {
                    let pos = if start != end { end } else { after };
                    pos..pos
                };
            }
            (false, "home") => self.selection = 0..0,
            (false, "end") => self.selection = self.value.len()..self.value.len(),
            (false, "backspace" | "delete") => {
                let range = if start != end {
                    start..end
                } else if key == "backspace" {
                    before..end
                } else {
                    start..after
                };
                let leading = range.start;
                self.value.replace_range(range, "");
                self.selection = leading..leading;
            }
            (false, "enter") if self.multiline => {
                self.replace_text_in_range(None, "\n", window, cx)
            }
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }

    fn on_click(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.focus.focus(window, cx);
        if let Some(units) = self.character_index_for_point(event.position, window, cx) {
            let index = self.utf8_index(units);
            self.selection = index..index;
        }
        cx.notify();
    }

    fn caret(&self, index: usize, height: Pixels) -> Option<Point<Pixels>> {
        let origin = self.bounds?.origin;
        let line_index = self
            .layout
            .partition_point(|(offset, _)| *offset <= index)
            .saturating_sub(1);
        let (offset, shaped) = self.layout.get(line_index)?;
        let local = (index - offset).min(shaped.text.len());
        Some(point(
            origin.x + shaped.x_for_index(local),
            origin.y + height * line_index as f32,
        ))
    }
}

impl Focusable for TextField {
    fn focus_handle(&self, _cx: &gpui::App) -> FocusHandle {
        self.focus.clone()
    }
}

impl EntityInputHandler for TextField {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        adjusted_range: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.utf8_index(range.start)..self.utf8_index(range.end);
        *adjusted_range = Some(self.native_range(range.clone()));
        Some(self.value.get(range)?.to_string())
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.native_range(self.selection.clone()),
            reversed: false,
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.clone().map(|range| self.native_range(range))
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range
            .map(|r| self.utf8_index(r.start)..self.utf8_index(r.end))
            .or_else(|| self.marked.take())
            .unwrap_or_else(|| self.selection.clone());
        let position = self.insert(range, text).end;
        self.selection = position..position;
        self.marked = None;
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selection: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range
            .map(|r| self.utf8_index(r.start)..self.utf8_index(r.end))
            .or_else(|| self.marked.take())
            .unwrap_or_else(|| self.selection.clone());
        let new_range = self.insert(range, text);
        let leading = self.utf16_index(new_range.start);
        self.selection = selection
            .map(|s| {
                self.utf8_index(leading + s.start).min(new_range.end)
                    ..self.utf8_index(leading + s.end).min(new_range.end)
            })
            .unwrap_or(new_range.end..new_range.end);
        self.marked = (!new_range.is_empty()).then_some(new_range);
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        _: Bounds<Pixels>,
        window: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let height = window.line_height();
        let start = self.caret(self.utf8_index(range.start), height)?;
        let end = self.caret(self.utf8_index(range.end), height)?;
        Some(Bounds::new(
            start,
            size((end.x - start.x).max(px(1.)), height),
        ))
    }

    fn character_index_for_point(
        &mut self,
        cursor: Point<Pixels>,
        window: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let origin = self.bounds?.origin;
        let row = (f32::from(cursor.y - origin.y) / f32::from(window.line_height()))
            .floor()
            .max(0.) as usize;
        let (offset, line) = self
            .layout
            .get(row.min(self.layout.len().saturating_sub(1)))?;
        Some(self.utf16_index(offset + line.closest_index_for_x(cursor.x - origin.x)))
    }

    fn text_length_utf16(&mut self, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        Some(self.value.encode_utf16().count())
    }

    fn set_selected_text_range(
        &mut self,
        range: Range<usize>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.selection = self.utf8_index(range.start)..self.utf8_index(range.end);
        cx.notify();
    }
}

impl Render for TextField {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let view = cx.entity();
        let field = cx.entity();
        let focused = self.focus.clone();
        let focus = self.focus.clone();
        let height = if self.multiline { px(104.) } else { px(24.) };
        div()
            .track_focus(&self.focus)
            .cursor(CursorStyle::IBeam)
            .on_key_down(cx.listener(Self::on_key))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_click))
            .border_1()
            .border_color(rgb(0x6a7d97))
            .bg(rgb(0xf3f5f9))
            .text_color(rgb(0x15223a))
            .px_2()
            .py_1()
            .line_height(px(21.))
            .text_size(px(15.))
            .overflow_hidden()
            .child(
                canvas(
                    move |bounds, window, app| {
                        let style = window.text_style();
                        view.update(app, |input, _| {
                            input.bounds = Some(bounds);
                            let mut offset = 0;
                            input.layout.clear();
                            for text in input.value.split('\n') {
                                let runs = [TextRun {
                                    len: text.len(),
                                    font: style.font(),
                                    color: style.color,
                                    background_color: None,
                                    underline: None,
                                    strikethrough: None,
                                }];
                                let shaped = window.text_system().shape_line(
                                    text.to_string().into(),
                                    px(15.),
                                    &runs,
                                    None,
                                );
                                input.layout.push((offset, shaped));
                                offset += text.len() + 1;
                            }
                        });
                    },
                    move |bounds, _, window, app| {
                        window.handle_input(
                            &focus,
                            ElementInputHandler::new(bounds, field.clone()),
                            app,
                        );
                        let input = field.read(app);
                        let height = window.line_height();
                        let layout = input.layout.clone();
                        let start = input.caret(input.selection.start, height);
                        let end = input.caret(input.selection.end, height);
                        let marked = input.marked.as_ref().and_then(|range| {
                            Some((
                                input.caret(range.start, height)?,
                                input.caret(range.end, height)?,
                            ))
                        });
                        if focused.is_focused(window) {
                            if let (Some(a), Some(b)) = (start, end) {
                                if a.y == b.y && b.x > a.x {
                                    window.paint_quad(fill(
                                        Bounds::new(a, size(b.x - a.x, height)),
                                        rgb(0xa6c7f0),
                                    ));
                                } else if a == b {
                                    window.paint_quad(fill(
                                        Bounds::new(a, size(px(1.), height)),
                                        rgb(0x172846),
                                    ));
                                }
                            }
                        }
                        if let Some((a, b)) = marked.filter(|(a, b)| a.y == b.y) {
                            window.paint_quad(fill(
                                Bounds::new(
                                    point(a.x, a.y + height - px(2.)),
                                    size(b.x - a.x, px(1.)),
                                ),
                                rgb(0x405eaf),
                            ));
                        }
                        for (row, (_, line)) in layout.iter().enumerate() {
                            let origin =
                                point(bounds.origin.x, bounds.origin.y + height * row as f32);
                            let _ = line.paint(origin, height, TextAlign::Left, None, window, app);
                        }
                    },
                )
                .w_full()
                .h(height),
            )
    }
}
