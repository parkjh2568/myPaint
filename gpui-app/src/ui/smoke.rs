use std::{
    ffi::OsStr,
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    time::{Duration, Instant},
};

use gpui::{Context, EntityInputHandler, WeakEntity, Window, px};
use serde_json::json;

use crate::{
    editor::{PointerButton, Raster, Sample, Tool},
    engine::State,
    io::LoadedDocument,
    preferences::{Density, EraserMode, Preferences},
};

use super::{Panel, Studio};

const FIXTURE: &str = "Windows 복구 테스트";
const PENDING_PIXELS: [u8; 8] = [221, 35, 43, 255, 39, 71, 201, 128];

#[derive(Clone, Copy)]
enum Mode {
    Save,
    Reload,
}

enum Step {
    OpenPanel,
    UsePanel,
    Observe,
}

pub(crate) struct WindowsSmoke {
    mode: Mode,
    report: PathBuf,
    deadline: Instant,
    step: Step,
    evidence: Vec<&'static str>,
}

impl WindowsSmoke {
    pub(crate) fn new(mode: &OsStr, report: PathBuf) -> Result<Self, String> {
        let mode = match mode.to_str() {
            Some("save") => Mode::Save,
            Some("reload") => Mode::Reload,
            _ => return Err("--windows-smoke requires save or reload".into()),
        };
        Ok(Self {
            mode,
            report,
            deadline: Instant::now() + Duration::from_secs(12),
            step: Step::OpenPanel,
            evidence: Vec::new(),
        })
    }

    pub(crate) fn schedule(mut self, window: &mut Window, view: WeakEntity<Studio>) {
        window.on_next_frame(move |window, app| {
            let result = view
                .update(app, |studio, cx| self.advance(studio, window, cx))
                .map_err(|error| error.to_string())
                .and_then(|step| step);
            match result {
                Ok(false) => {
                    window.refresh();
                    self.schedule(window, view);
                }
                outcome => {
                    if let Err(error) = self.write_report(outcome.err()) {
                        eprintln!("Windows smoke report failed: {error}");
                    }
                    window.remove_window();
                    app.quit();
                }
            }
        });
    }

    fn advance(
        &mut self,
        studio: &mut Studio,
        window: &mut Window,
        cx: &mut Context<Studio>,
    ) -> Result<bool, String> {
        if Instant::now() >= self.deadline {
            return Err("timed out waiting for a native frame or recovery snapshot".into());
        }
        match self.step {
            Step::OpenPanel => {
                if studio.canvas_bounds.size.width <= px(1.)
                    || studio.canvas_bounds.size.height <= px(1.)
                {
                    return Ok(false);
                }
                self.evidence.push("initial native canvas frame prepared");
                match self.mode {
                    Mode::Save => {
                        check(
                            studio.preferences == Preferences::default(),
                            "expected default settings in the isolated save process",
                        )?;
                        studio.command("settings", window, cx)?;
                    }
                    Mode::Reload => {
                        let expected = expected_preferences();
                        check(
                            studio.preferences == expected
                                && studio.editor.settings.eraser_background
                                    == expected.eraser_color(),
                            "restarted process did not load the expected settings and eraser color",
                        )?;
                        self.evidence
                            .push("restarted process loaded exact settings");
                        studio.command("recover", window, cx)?;
                    }
                }
                cx.notify();
                self.step = Step::UsePanel;
                Ok(false)
            }
            Step::UsePanel => {
                match self.mode {
                    Mode::Save => self.apply_settings_and_edit(studio, window, cx)?,
                    Mode::Reload => self.restore(studio, cx)?,
                }
                cx.notify();
                self.step = Step::Observe;
                Ok(false)
            }
            Step::Observe => match self.mode {
                Mode::Save => {
                    let listing = studio.io.list()?;
                    if listing.entries.is_empty() {
                        return Ok(false);
                    }
                    check(
                        listing.entries.len() == 1
                            && listing.entries[0].name == FIXTURE
                            && listing.warnings.is_empty(),
                        "the tab-switch recovery listing did not contain the one expected fixture",
                    )?;
                    self.evidence.push("tab switch wrote one recovery snapshot");
                    Ok(true)
                }
                Mode::Reload => {
                    let state = studio.editor.document().state();
                    check(
                        studio.panel.is_none()
                            && studio.editor.active_tab().name == FIXTURE
                            && *state == expected_state()?,
                        "the restored tab did not match the exact saved image or close the panel",
                    )?;
                    check(
                        studio.last_generation == studio.editor.document().visual_generation(),
                        "the restored tab did not reach the native canvas frame",
                    )?;
                    let (uploads, bytes) = studio.cache_counts();
                    check(
                        uploads == 1 && bytes == 4 * 3 * 4,
                        "the restored document did not prepare its exact pixel tile",
                    )?;
                    self.evidence
                        .push("restored native tab contains exact RGBA pixels");
                    self.evidence
                        .push("restored canvas prepared one 48-byte pixel tile");
                    Ok(true)
                }
            },
        }
    }

    fn apply_settings_and_edit(
        &mut self,
        studio: &mut Studio,
        window: &mut Window,
        cx: &mut Context<Studio>,
    ) -> Result<(), String> {
        let Some(Panel::Settings(draft)) = &mut studio.panel else {
            return Err("settings command did not open the settings panel".into());
        };
        self.evidence
            .push("settings command opened the native panel");
        let expected = expected_preferences();
        *draft = expected.clone();
        studio.accept_preferences(window, cx)?;
        check(
            studio.panel.is_none()
                && studio.preferences == expected
                && studio.preference_store.load()? == expected
                && studio.editor.settings.eraser_background == expected.eraser_color(),
            "settings accept did not save or apply the expected preferences",
        )?;
        self.evidence
            .push("settings accept saved and applied preferences");
        check_korean_marked_text(studio, window, cx)?;
        self.evidence
            .push("DIRECT TextField handler passed ㅎ → 한 → 한글 marked text and commit");

        let destination = studio.editor.active_tab().id;
        studio.install_loaded(
            LoadedDocument {
                state: State::new(4, 3, [0; 4])?,
                name: FIXTURE.into(),
                source_token: None,
            },
            cx,
        )?;
        studio.editor.paste_raster(Raster {
            width: 2,
            height: 1,
            pixels: PENDING_PIXELS.to_vec(),
        })?;
        check(
            studio.editor.has_pending(),
            "fixture did not create a pending edit",
        )?;
        studio.switch_tab(destination, cx)?;
        check(
            studio.editor.active_tab().id == destination && !studio.editor.has_pending(),
            "switching tabs did not settle the pending edit",
        )
    }

    fn restore(&mut self, studio: &mut Studio, cx: &mut Context<Studio>) -> Result<(), String> {
        let Some(Panel::Recovery(listing)) = &studio.panel else {
            return Err("recovery command did not open the recovery panel".into());
        };
        check(
            listing.entries.len() == 1
                && listing.entries[0].name == FIXTURE
                && listing.warnings.is_empty(),
            "the native recovery panel did not show the expected snapshot",
        )?;
        self.evidence
            .push("recovery command showed one persisted snapshot");
        let entry = &listing.entries[0];
        let (token, name) = (entry.token.clone(), entry.name.clone());
        studio.restore_recovery(&token, &name, cx)
    }

    fn write_report(&self, error: Option<String>) -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&self.report)
            .map_err(|error| error.to_string())?;
        let mode = match self.mode {
            Mode::Save => "save",
            Mode::Reload => "reload",
        };
        serde_json::to_writer_pretty(
            &mut file,
            &json!({
                "ok": error.is_none(),
                "mode": mode,
                "fixture": FIXTURE,
                "fixtureRgba": PENDING_PIXELS,
                "expectedPreferences": expected_preferences(),
                "evidence": self.evidence,
                "error": error,
                "input": "app-driven commands in the native Windows process"
            }),
        )
        .map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())
    }
}

fn check(condition: bool, message: &str) -> Result<(), String> {
    condition.then_some(()).ok_or_else(|| message.into())
}

fn expected_preferences() -> Preferences {
    Preferences {
        classic: true,
        density: Density::Mouse,
        eraser_mode: EraserMode::Background,
        eraser_background: [37, 80, 149],
    }
}

fn expected_state() -> Result<State, String> {
    let mut state = State::new(4, 3, [0; 4])?;
    state.pixels_mut(0)[..PENDING_PIXELS.len()].copy_from_slice(&PENDING_PIXELS);
    Ok(state)
}

fn check_korean_marked_text(
    studio: &mut Studio,
    window: &mut Window,
    cx: &mut Context<Studio>,
) -> Result<(), String> {
    studio.editor.choose_tool(Tool::Text)?;
    let (x, y) = studio.editor.viewport().screen_point(6., 6.);
    let action = studio.editor.pointer_down(
        Sample {
            x,
            y,
            pressure: 1.,
            pen: false,
            shift: false,
        },
        PointerButton::Primary,
    )?;
    studio.pointer_action(action, window, cx);
    let field = studio
        .text
        .clone()
        .ok_or("text tool did not open a TextField")?;
    field.update(cx, |field, cx| {
        for text in ["ㅎ", "한", "한글"] {
            let units = text.encode_utf16().count();
            field.replace_and_mark_text_in_range(None, text, Some(units..units), window, cx);
            check(
                field.text() == text
                    && field.composing()
                    && field.marked_text_range(window, cx) == Some(0..units),
                "direct TextField handler did not retain the expected Korean marked text",
            )?;
        }
        field.replace_text_in_range(None, "한글", window, cx);
        check(
            field.text() == "한글"
                && !field.composing()
                && field.marked_text_range(window, cx).is_none(),
            "direct TextField handler did not commit the Korean text",
        )
    })?;
    studio.command("cancel", window, cx)
}
