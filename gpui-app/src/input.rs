use std::ops::Range;

use gpui::{
    Bounds, ClipboardItem, Context, CursorStyle, ElementInputHandler, EntityInputHandler,
    FocusHandle, Focusable, KeyDownEvent, MouseButton, MouseDownEvent, Pixels, Point, ShapedLine,
    TextAlign, TextRun, UTF16Selection, Window, canvas, div, fill, point, prelude::*, px, rgb,
    size,
};

struct TextBuffer {
    value: String,
    selection: Range<usize>,
    marked: Option<Range<usize>>,
    multiline: bool,
}

impl TextBuffer {
    fn new(value: String, multiline: bool) -> Self {
        let selection = 0..value.len();
        Self {
            value,
            selection,
            marked: None,
            multiline,
        }
    }

    fn utf8_index(&self, units: usize) -> usize {
        let mut offset = 0usize;
        for (index, ch) in self.value.char_indices() {
            if offset.saturating_add(ch.len_utf16()) > units {
                return index;
            }
            offset = offset.saturating_add(ch.len_utf16());
        }
        self.value.len()
    }

    fn utf8_range(&self, range: Range<usize>) -> Range<usize> {
        let start = range.start.min(range.end);
        let end = range.start.max(range.end);
        self.utf8_index(start)..self.utf8_index(end)
    }

    fn clamp_utf8_index(&self, index: usize) -> usize {
        let index = index.min(self.value.len());
        if self.value.is_char_boundary(index) {
            index
        } else {
            self.value.floor_char_boundary(index)
        }
    }

    fn clamp_utf8_range(&self, range: Range<usize>) -> Range<usize> {
        let start = self.clamp_utf8_index(range.start.min(range.end));
        let end = self.clamp_utf8_index(range.start.max(range.end));
        start..end
    }

    fn utf16_index(&self, index: usize) -> usize {
        let index = self.clamp_utf8_index(index);
        self.value[..index].encode_utf16().count()
    }

    fn native_range(&self, range: Range<usize>) -> Range<usize> {
        let range = self.clamp_utf8_range(range);
        self.utf16_index(range.start)..self.utf16_index(range.end)
    }

    fn insert(&mut self, range: Range<usize>, text: &str) -> Range<usize> {
        let range = self.clamp_utf8_range(range);
        let filtered;
        let text = if self.multiline {
            text
        } else {
            filtered = text.replace(['\r', '\n'], "");
            &filtered
        };
        if self
            .value
            .len()
            .saturating_sub(range.len())
            .saturating_add(text.len())
            > 16_384
        {
            return range.end..range.end;
        }
        let start = range.start;
        self.value.replace_range(range, text);
        start..start + text.len()
    }

    fn copy_selection(&self) -> Option<String> {
        let range = self.clamp_utf8_range(self.selection.clone());
        (!range.is_empty()).then(|| self.value[range].to_string())
    }

    fn cut_selection(&mut self) -> Option<String> {
        let range = self.clamp_utf8_range(self.selection.clone());
        if range.is_empty() {
            return None;
        }
        let cut = self.value[range.clone()].to_string();
        let start = range.start;
        self.value.replace_range(range, "");
        self.selection = start..start;
        self.marked = None;
        Some(cut)
    }

    fn text_for_utf16_range(&self, range: Range<usize>) -> (Range<usize>, Option<String>) {
        let range = self.utf8_range(range);
        let adjusted = self.native_range(range.clone());
        (adjusted, self.value.get(range).map(str::to_string))
    }

    fn selected_utf16_range(&self) -> Range<usize> {
        self.native_range(self.selection.clone())
    }

    fn marked_utf16_range(&self) -> Option<Range<usize>> {
        self.marked.clone().map(|range| self.native_range(range))
    }

    fn replace_utf16_range(&mut self, range: Option<Range<usize>>, text: &str) {
        let range = range
            .map(|r| self.utf8_range(r))
            .or_else(|| self.marked.take())
            .unwrap_or_else(|| self.selection.clone());
        let position = self.insert(range, text).end;
        self.selection = position..position;
        self.marked = None;
    }

    fn replace_and_mark_utf16_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selection: Option<Range<usize>>,
    ) {
        let range = range
            .map(|r| self.utf8_range(r))
            .or_else(|| self.marked.take())
            .unwrap_or_else(|| self.selection.clone());
        let new_range = self.insert(range, text);
        let leading = self.utf16_index(new_range.start);
        self.selection = selection
            .map(|s| {
                let start = s.start.min(s.end);
                let end = s.start.max(s.end);
                self.utf8_index(leading.saturating_add(start))
                    .clamp(new_range.start, new_range.end)
                    ..self
                        .utf8_index(leading.saturating_add(end))
                        .clamp(new_range.start, new_range.end)
            })
            .unwrap_or(new_range.end..new_range.end);
        self.marked = (!new_range.is_empty()).then_some(new_range);
    }

    fn set_selected_utf16_range(&mut self, range: Range<usize>) {
        self.selection = self.utf8_range(range);
    }
}

pub struct TextField {
    buffer: TextBuffer,
    focus: FocusHandle,
    layout: Vec<(usize, ShapedLine)>,
    bounds: Option<Bounds<Pixels>>,
}

impl TextField {
    pub fn new(value: String, multiline: bool, cx: &mut Context<Self>) -> Self {
        Self {
            buffer: TextBuffer::new(value, multiline),
            focus: cx.focus_handle().tab_stop(true),
            layout: Vec::new(),
            bounds: None,
        }
    }

    pub fn text(&self) -> &str {
        &self.buffer.value
    }

    pub fn composing(&self) -> bool {
        self.buffer.marked.is_some()
    }

    fn on_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = &event.keystroke.key;
        let mods = event.keystroke.modifiers;
        let command = mods.control || mods.platform;
        if self.buffer.marked.is_some() && !command {
            return;
        }
        let range = self.buffer.clamp_utf8_range(self.buffer.selection.clone());
        let start = range.start;
        let end = range.end;
        let before = self.buffer.value[..start]
            .char_indices()
            .next_back()
            .map_or(0, |(i, _)| i);
        let after = self.buffer.value[end..]
            .chars()
            .next()
            .map_or(end, |ch| end + ch.len_utf8());
        match (command, key.as_str()) {
            (true, "a") => self.buffer.selection = 0..self.buffer.value.len(),
            (true, "c") => {
                if let Some(copied) = self.buffer.copy_selection() {
                    cx.write_to_clipboard(ClipboardItem::new_string(copied));
                }
            }
            (true, "x") => {
                if let Some(cut) = self.buffer.cut_selection() {
                    cx.write_to_clipboard(ClipboardItem::new_string(cut));
                }
            }
            (true, "v") => {
                if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                    self.replace_text_in_range(None, &text, window, cx);
                }
            }
            (false, "left") => {
                self.buffer.selection = if mods.shift {
                    before..end
                } else {
                    let pos = if start != end { start } else { before };
                    pos..pos
                };
            }
            (false, "right") => {
                self.buffer.selection = if mods.shift {
                    start..after
                } else {
                    let pos = if start != end { end } else { after };
                    pos..pos
                };
            }
            (false, "home") => self.buffer.selection = 0..0,
            (false, "end") => {
                let end = self.buffer.value.len();
                self.buffer.selection = end..end;
            }
            (false, "backspace" | "delete") => {
                let range = if start != end {
                    start..end
                } else if key == "backspace" {
                    before..end
                } else {
                    start..after
                };
                let leading = range.start;
                self.buffer.value.replace_range(range, "");
                self.buffer.selection = leading..leading;
            }
            (false, "enter") if self.buffer.multiline => {
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
            let index = self.buffer.utf8_index(units);
            self.buffer.selection = index..index;
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
        let local = index.saturating_sub(*offset).min(shaped.text.len());
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
        let (adjusted, text) = self.buffer.text_for_utf16_range(range);
        *adjusted_range = Some(adjusted);
        text
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.buffer.selected_utf16_range(),
            reversed: false,
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.buffer.marked_utf16_range()
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.buffer.marked = None;
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.buffer.replace_utf16_range(range, text);
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
        self.buffer
            .replace_and_mark_utf16_range(range, text, selection);
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
        let range = self.buffer.utf8_range(range);
        let start = self.caret(range.start, height)?;
        let end = self.caret(range.end, height)?;
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
        Some(
            self.buffer
                .utf16_index(offset + line.closest_index_for_x(cursor.x - origin.x)),
        )
    }

    fn text_length_utf16(&mut self, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        Some(self.buffer.value.encode_utf16().count())
    }

    fn set_selected_text_range(
        &mut self,
        range: Range<usize>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.buffer.set_selected_utf16_range(range);
        cx.notify();
    }
}

impl Render for TextField {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let view = cx.entity();
        let field = cx.entity();
        let focused = self.focus.clone();
        let focus = self.focus.clone();
        let height = if self.buffer.multiline {
            px(104.)
        } else {
            px(24.)
        };
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
                            for text in input.buffer.value.split('\n') {
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
                        let selection = input
                            .buffer
                            .clamp_utf8_range(input.buffer.selection.clone());
                        let start = input.caret(selection.start, height);
                        let end = input.caret(selection.end, height);
                        let marked = input.buffer.marked.as_ref().and_then(|range| {
                            let range = input.buffer.clamp_utf8_range(range.clone());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cutting_while_ime_marked_clears_marked_range_without_panicking() {
        let mut buffer = TextBuffer::new("ab".into(), false);
        buffer.selection = 2..2;
        buffer.replace_and_mark_utf16_range(None, "한글🎨", Some(0..2));
        assert!(buffer.marked.is_some());
        assert_eq!(buffer.value, "ab한글🎨");

        // Simulate Ctrl+A then Ctrl+X during active IME composition.
        buffer.selection = 0..buffer.value.len();
        assert_eq!(buffer.cut_selection().as_deref(), Some("ab한글🎨"));
        assert_eq!(buffer.value, "");
        assert_eq!(buffer.selection, 0..0);
        assert_eq!(buffer.marked, None);
        assert_eq!(buffer.marked_utf16_range(), None);
        assert_eq!(buffer.selected_utf16_range(), 0..0);

        // Partial cut while marked also clears marked and leaves valid UTF-8 state.
        buffer.replace_and_mark_utf16_range(None, "가나다", Some(0..2));
        assert!(buffer.marked.is_some());
        assert_eq!(buffer.cut_selection().as_deref(), Some("가나"));
        assert_eq!(buffer.value, "다");
        assert_eq!(buffer.selection, 0..0);
        assert_eq!(buffer.marked, None);
        assert_eq!(buffer.marked_utf16_range(), None);
        buffer.replace_utf16_range(None, "라");
        assert_eq!(buffer.value, "라다");
    }

    #[test]
    fn reversed_and_overflowing_utf16_ranges_are_normalized_without_panicking() {
        let mut buffer = TextBuffer::new("A한🎨Z".into(), false);

        let (adjusted, text) = buffer.text_for_utf16_range(5..1);
        assert_eq!(adjusted, 1..5);
        assert_eq!(text.as_deref(), Some("한🎨Z"));

        let (adjusted, text) = buffer.text_for_utf16_range(usize::MAX..1);
        assert_eq!(adjusted, 1..5);
        assert_eq!(text.as_deref(), Some("한🎨Z"));

        buffer.set_selected_utf16_range(4..1);
        assert_eq!(buffer.selected_utf16_range(), 1..4);

        buffer.replace_and_mark_utf16_range(Some(4..1), "가나", Some(usize::MAX..1));
        assert_eq!(buffer.value, "A가나Z");
        assert_eq!(buffer.selected_utf16_range(), 2..3);
        assert_eq!(buffer.marked_utf16_range(), Some(1..3));

        buffer.replace_utf16_range(Some(usize::MAX..0), "끝");
        assert_eq!(buffer.value, "끝");
        assert_eq!(buffer.selection, "끝".len().."끝".len());
        assert_eq!(buffer.marked, None);
    }
}
