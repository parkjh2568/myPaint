use crate::editor::{
    Editor, MAX_PATH_POINTS, PointerAction, PointerButton, Sample, Tool, Viewport,
};
use crate::engine::EngineResult;

#[cfg(windows)]
#[path = "touch/windows.rs"]
mod windows;
#[cfg(windows)]
pub use windows::{register, touch_available};

const MAX_CONTACTS: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Down,
    Move,
    Up,
    Cancel,
    CancelAll,
}

#[derive(Clone, Copy)]
pub struct NativeContact {
    pub id: u32,
    pub phase: Phase,
    pub x: i32,
    pub y: i32,
}

#[cfg(not(windows))]
pub fn register(_: &gpui::Window, _: impl FnMut(NativeContact) -> bool + 'static) -> bool {
    false
}

#[cfg(not(windows))]
pub fn touch_available() -> bool {
    false
}

#[derive(Clone, Copy)]
pub struct Contact {
    pub id: u32,
    pub phase: Phase,
    pub x: f64,
    pub y: f64,
    pub shift: bool,
}

impl Contact {
    fn sample(self) -> Sample {
        Sample {
            x: self.x,
            y: self.y,
            pressure: 1.0,
            pen: false,
            shift: self.shift,
        }
    }
}

pub struct Outcome {
    pub changed: bool,
    pub action: PointerAction,
    pub queue_recovery: bool,
}

#[derive(Default)]
enum Mode {
    #[default]
    Idle,
    Single,
    Deferred {
        start: Sample,
        path: Vec<Sample>,
    },
    Navigate(Option<Pinch>),
}

#[derive(Default)]
pub struct TouchGesture {
    contacts: Vec<Contact>,
    mode: Mode,
}

impl TouchGesture {
    pub fn is_active(&self) -> bool {
        !self.contacts.is_empty()
    }

    pub fn cancel(&mut self, editor: &mut Editor) -> bool {
        let active = self.is_active();
        self.contacts.clear();
        if matches!(self.mode, Mode::Single) {
            editor.cancel_pointer();
        }
        self.mode = Mode::Idle;
        active
    }

    pub fn handle(&mut self, editor: &mut Editor, mut contact: Contact) -> EngineResult<Outcome> {
        let before = editor.document().revision();
        if !contact.x.is_finite() || !contact.y.is_finite() {
            contact.phase = match contact.phase {
                Phase::Down | Phase::CancelAll => contact.phase,
                _ => Phase::Cancel,
            };
        }
        let mut result = Outcome {
            changed: false,
            action: PointerAction::None,
            queue_recovery: false,
        };
        if let Err(error) = self.update(editor, contact, &mut result) {
            self.cancel(editor);
            return Err(error);
        }
        result.queue_recovery = editor.document().revision() != before;
        Ok(result)
    }

    fn update(
        &mut self,
        editor: &mut Editor,
        contact: Contact,
        result: &mut Outcome,
    ) -> EngineResult<()> {
        if contact.phase == Phase::CancelAll {
            result.changed = self.cancel(editor);
            return Ok(());
        }
        let index = self.contacts.iter().position(|held| held.id == contact.id);
        if contact.phase == Phase::Down {
            if index.is_some()
                || self.contacts.len() >= MAX_CONTACTS
                || !contact.x.is_finite()
                || !contact.y.is_finite()
                || (!self.is_active() && editor.has_active_gesture())
            {
                return Ok(());
            }
            self.contacts.push(contact);
            if self.contacts.len() == 2 {
                if matches!(self.mode, Mode::Single) {
                    editor.cancel_pointer();
                }
                self.mode = Mode::Navigate(Pinch::start(&self.contacts, *editor.viewport()));
                result.changed = true;
            } else if self.contacts.len() == 1 {
                let start = contact.sample();
                let button = if editor.settings.finger_draw {
                    PointerButton::Primary
                } else {
                    PointerButton::Middle
                };
                if button == PointerButton::Middle || editor.touch_down_is_provisional(start) {
                    self.mode = Mode::Single;
                    result.action = editor.pointer_down(start, button)?;
                    result.changed = true;
                } else {
                    self.mode = Mode::Deferred {
                        start,
                        path: Vec::new(),
                    };
                }
            }
            return Ok(());
        }
        let Some(index) = index else {
            return Ok(());
        };
        let ends = matches!(contact.phase, Phase::Up | Phase::Cancel);
        let cancelled = contact.phase == Phase::Cancel;
        if !cancelled {
            self.contacts[index] = contact;
        }
        let sample = contact.sample();
        match &mut self.mode {
            Mode::Single => {
                result.changed = true;
                if cancelled {
                    editor.cancel_pointer();
                } else if ends {
                    editor.pointer_up(sample)?;
                } else {
                    editor.pointer_move(sample)?;
                }
            }
            Mode::Deferred { start, path } => {
                if ends && !cancelled {
                    result.action = editor.pointer_down(*start, PointerButton::Primary)?;
                    if editor.has_active_gesture() {
                        let update = path
                            .drain(..)
                            .try_for_each(|previous| editor.pointer_move(previous))
                            .and_then(|()| editor.pointer_up(sample));
                        if let Err(error) = update {
                            editor.cancel_pointer();
                            return Err(error);
                        }
                    }
                    result.changed = true;
                } else if !ends
                    && editor.settings.tool == Tool::Lasso
                    && path.len() < MAX_PATH_POINTS
                    && path.last().is_none_or(|last| *last != sample)
                {
                    path.push(sample);
                }
            }
            Mode::Navigate(pinch) => {
                if !cancelled
                    && index < 2
                    && let Some(pinch) = pinch
                {
                    pinch.apply(&self.contacts, editor.viewport_mut());
                    result.changed = true;
                }
            }
            Mode::Idle => {}
        }
        if ends {
            self.contacts.remove(index);
            if self.contacts.is_empty() {
                self.mode = Mode::Idle;
            } else if let Mode::Navigate(pinch) = &mut self.mode
                && index < 2
            {
                *pinch = Pinch::start(&self.contacts, *editor.viewport());
            }
        }
        Ok(())
    }
}

struct Pinch {
    distance: f64,
    zoom: f64,
    anchor: (f64, f64),
}

impl Pinch {
    fn start(contacts: &[Contact], viewport: Viewport) -> Option<Self> {
        let (first, second) = (contacts.first()?, contacts.get(1)?);
        let (x, y, distance) = pinch_geometry(first, second);
        Some(Self {
            distance: distance.max(1.0),
            zoom: viewport.zoom,
            anchor: viewport.document_point(x, y),
        })
    }

    fn apply(&self, contacts: &[Contact], viewport: &mut Viewport) {
        let (x, y, distance) = pinch_geometry(&contacts[0], &contacts[1]);
        viewport.zoom_at(self.zoom * distance / self.distance, x, y);
        viewport.offset_x = x - self.anchor.0 * viewport.zoom;
        viewport.offset_y = y - self.anchor.1 * viewport.zoom;
    }
}

fn pinch_geometry(first: &Contact, second: &Contact) -> (f64, f64, f64) {
    (
        first.x.midpoint(second.x),
        first.y.midpoint(second.y),
        (first.x - second.x).hypot(first.y - second.y),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::Raster;
    use crate::engine::{PaintDocument, State};

    const RED: [u8; 4] = [255, 0, 0, 255];

    fn fixture(tool: Tool) -> Editor {
        let mut editor = Editor::new().unwrap();
        editor.active_tab_mut().document =
            PaintDocument::new(State::new(64, 48, [0; 4]).unwrap()).unwrap();
        editor.settings.foreground = RED;
        editor.choose_tool(tool).unwrap();
        editor
    }

    fn send(
        touch: &mut TouchGesture,
        editor: &mut Editor,
        id: u32,
        phase: Phase,
        x: f64,
        y: f64,
    ) -> Outcome {
        touch
            .handle(
                editor,
                Contact {
                    id,
                    phase,
                    x,
                    y,
                    shift: false,
                },
            )
            .unwrap()
    }

    fn pixel(editor: &Editor, x: usize, y: usize) -> [u8; 4] {
        let state = editor.document().state();
        let i = (y * state.width as usize + x) * 4;
        state.layers[state.active].pixels[i..i + 4]
            .try_into()
            .unwrap()
    }

    #[test]
    fn a_single_finger_draws_and_queues_only_the_committed_stroke() {
        let mut editor = fixture(Tool::Pencil);
        let mut touch = TouchGesture::default();
        let rev = editor.document().revision();
        assert!(!send(&mut touch, &mut editor, 1, Phase::Down, 8.5, 8.5).queue_recovery);
        assert!(editor.document().has_stroke());
        assert!(!send(&mut touch, &mut editor, 1, Phase::Move, 16.5, 8.5).queue_recovery);
        assert!(send(&mut touch, &mut editor, 1, Phase::Up, 24.5, 8.5).queue_recovery);
        assert_ne!(editor.document().revision(), rev);
        assert_eq!(pixel(&editor, 8, 8), RED);
        assert_eq!(pixel(&editor, 16, 8), RED);
        assert_eq!(pixel(&editor, 24, 8), RED);
        assert!(!touch.is_active());
    }

    #[test]
    fn pinch_rolls_back_finger_stroke_and_keeps_redo_and_the_midpoint_anchor() {
        let mut editor = fixture(Tool::Pencil);
        let mut touch = TouchGesture::default();
        send(&mut touch, &mut editor, 1, Phase::Down, 4.5, 4.5);
        send(&mut touch, &mut editor, 1, Phase::Up, 4.5, 4.5);
        assert!(editor.undo());
        let rev = editor.document().revision();
        send(&mut touch, &mut editor, 2, Phase::Down, 8.5, 8.5);
        send(&mut touch, &mut editor, 2, Phase::Move, 10.5, 8.5);
        assert!(editor.document().has_stroke());
        send(&mut touch, &mut editor, 3, Phase::Down, 26.5, 8.5);
        assert!(!editor.document().has_stroke());
        send(&mut touch, &mut editor, 3, Phase::Move, 42.5, 8.5);
        assert_eq!(editor.viewport().zoom, 2.0);
        assert_eq!(editor.viewport().document_point(26.5, 8.5), (18.5, 8.5));
        assert!(!editor.viewport().auto_fit);

        send(&mut touch, &mut editor, 3, Phase::Up, 42.5, 8.5);
        send(&mut touch, &mut editor, 2, Phase::Move, 15.5, 12.5);
        send(&mut touch, &mut editor, 2, Phase::Up, 15.5, 12.5);
        assert_eq!(editor.viewport().document_point(26.5, 8.5), (18.5, 8.5));
        assert_eq!(editor.document().revision(), rev);
        assert!(editor.document().can_redo());
        assert_eq!(pixel(&editor, 8, 8), [0; 4]);
        assert_eq!(pixel(&editor, 10, 8), [0; 4]);
        assert!(editor.redo());
        assert_eq!(pixel(&editor, 4, 4), RED);
        assert!(!touch.is_active());
    }

    #[test]
    fn finger_drawing_disabled_pans_and_leaves_the_document_untouched() {
        let mut editor = fixture(Tool::Pencil);
        let mut touch = TouchGesture::default();
        editor.settings.finger_draw = false;
        let revision = editor.document().revision();
        send(&mut touch, &mut editor, 1, Phase::Down, 8.5, 8.5);
        send(&mut touch, &mut editor, 1, Phase::Move, 20.5, 13.5);
        let end = send(&mut touch, &mut editor, 1, Phase::Up, 26.5, 17.5);
        assert!(end.changed);
        assert!(!end.queue_recovery);
        assert_eq!(editor.viewport().offset_x, 18.0);
        assert_eq!(editor.viewport().offset_y, 9.0);
        assert_eq!(editor.document().revision(), revision);
        assert_eq!(pixel(&editor, 8, 8), [0; 4]);
    }

    #[test]
    fn capture_loss_and_window_cancel_end_strokes_without_accepting_late_up() {
        let mut editor = fixture(Tool::Pencil);
        let mut touch = TouchGesture::default();
        let revision = editor.document().revision();
        for phase in [Phase::Cancel, Phase::CancelAll] {
            send(&mut touch, &mut editor, 1, Phase::Down, 8.5, 8.5);
            send(&mut touch, &mut editor, 1, Phase::Move, 20.5, 13.5);
            send(&mut touch, &mut editor, 1, phase, 0.0, 0.0);
            assert!(!touch.is_active());
            assert!(!editor.document().has_stroke());
            assert!(!send(&mut touch, &mut editor, 1, Phase::Up, 20.5, 13.5).changed);
            assert_eq!(editor.document().revision(), revision);
            assert_eq!(pixel(&editor, 8, 8), [0; 4]);
        }
    }

    #[test]
    fn fill_and_text_wait_for_a_single_finger_release() {
        let mut editor = fixture(Tool::Fill);
        let mut touch = TouchGesture::default();
        let revision = editor.document().revision();
        send(&mut touch, &mut editor, 1, Phase::Down, 8.5, 8.5);
        assert_eq!(editor.document().revision(), revision);
        send(&mut touch, &mut editor, 2, Phase::Down, 20.5, 13.5);
        send(&mut touch, &mut editor, 1, Phase::Up, 8.5, 8.5);
        send(&mut touch, &mut editor, 2, Phase::Up, 20.5, 13.5);
        assert_eq!(editor.document().revision(), revision);
        assert_eq!(pixel(&editor, 8, 8), [0; 4]);
        send(&mut touch, &mut editor, 3, Phase::Down, 8.5, 8.5);
        assert!(send(&mut touch, &mut editor, 3, Phase::Up, 8.5, 8.5).queue_recovery);
        assert_eq!(pixel(&editor, 8, 8), RED);

        editor.choose_tool(Tool::Text).unwrap();
        let down = send(&mut touch, &mut editor, 4, Phase::Down, 12.5, 11.5);
        assert_eq!(down.action, PointerAction::None);
        assert!(!editor.has_pending());
        let up = send(&mut touch, &mut editor, 4, Phase::Up, 12.5, 11.5);
        assert_eq!(up.action, PointerAction::TextRequested { x: 12, y: 11 });
        assert!(editor.has_pending());
    }

    #[test]
    fn third_contact_does_not_steer_until_the_first_pair_releases() {
        let mut editor = fixture(Tool::Pencil);
        let mut touch = TouchGesture::default();
        send(&mut touch, &mut editor, 1, Phase::Down, 10.0, 10.0);
        send(&mut touch, &mut editor, 2, Phase::Down, 30.0, 10.0);
        send(&mut touch, &mut editor, 3, Phase::Down, 40.0, 10.0);
        assert!(!send(&mut touch, &mut editor, 3, Phase::Move, 50.0, 10.0).changed);
        send(&mut touch, &mut editor, 1, Phase::Up, 10.0, 10.0);
        assert_eq!(editor.viewport().zoom, 1.0);
        assert_eq!(editor.viewport().offset_x, 0.0);
        send(&mut touch, &mut editor, 3, Phase::Move, 70.0, 10.0);
        assert_eq!(editor.viewport().zoom, 2.0);
        assert_eq!(editor.viewport().document_point(50.0, 10.0), (40.0, 10.0));
    }

    #[test]
    fn pinch_keeps_a_previous_paste_pending_and_redo_available() {
        let mut editor = fixture(Tool::Pencil);
        let mut touch = TouchGesture::default();
        send(&mut touch, &mut editor, 1, Phase::Down, 4.5, 4.5);
        send(&mut touch, &mut editor, 1, Phase::Up, 4.5, 4.5);
        assert!(editor.undo());
        editor
            .paste_raster(Raster {
                width: 1,
                height: 1,
                pixels: RED.to_vec(),
            })
            .unwrap();
        let revision = editor.document().revision();
        send(&mut touch, &mut editor, 2, Phase::Down, 8.5, 8.5);
        send(&mut touch, &mut editor, 3, Phase::Down, 18.5, 8.5);
        touch.cancel(&mut editor);
        assert_eq!(editor.document().revision(), revision);
        assert_eq!(pixel(&editor, 0, 0), [0; 4]);
        assert!(editor.has_pending());
        assert!(editor.document().can_redo());
    }
}
