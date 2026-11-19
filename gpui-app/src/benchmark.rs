use std::{fs::OpenOptions, io::Write, path::PathBuf, time::Instant};

use gpui::{App, Context, WeakEntity, Window};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    editor::{PointerButton, Sample, Tool},
    engine::{Layer, State},
    ui::Studio,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Workload {
    width: u32,
    height: u32,
    size: f64,
    strokes: usize,
    first_x: i32,
    first_y: i32,
    x_step: i32,
    y_step: i32,
    wave: Vec<i32>,
}

pub struct Benchmark {
    root_start: Instant,
    output: PathBuf,
    layers: usize,
    workload: Workload,
    samples: Vec<SampleResult>,
    submit: Option<(usize, Instant, f64)>,
    first_frame_ms: Option<f64>,
    startup_scene_ms: Option<f64>,
    configured: bool,
    pub complete: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SampleResult {
    stroke: usize,
    editor_ms: f64,
    editor_to_paint_ms: f64,
    render_uploads: usize,
    upload_bytes: usize,
}

fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

impl Benchmark {
    pub fn new(output: PathBuf, layers: usize, root_start: Instant) -> Result<Self, String> {
        if output.exists() || !(1..=16).contains(&layers) {
            return Err("벤치마크 출력은 새 파일이어야 하며 레이어 수는 1~16이어야 합니다.".into());
        }
        let workload = serde_json::from_str(include_str!("../../bench/brush-workload.json"))
            .map_err(|error| error.to_string())?;
        Ok(Self {
            root_start,
            output,
            layers,
            workload,
            samples: Vec::new(),
            submit: None,
            first_frame_ms: None,
            startup_scene_ms: None,
            configured: false,
            complete: false,
        })
    }

    fn setup(&mut self, studio: &mut Studio, cx: &mut Context<Studio>) -> Result<(), String> {
        let start = Instant::now();
        let mut state = State::new(self.workload.width, self.workload.height, [0; 4])?;
        for index in 1..self.layers {
            state.layers.push(Layer::new(
                format!("레이어 {}", index + 1),
                true,
                vec![0; state.width as usize * state.height as usize * 4],
            ));
        }
        studio.install_benchmark_state(state, cx)?;
        studio.editor.settings.tool = Tool::Brush;
        studio.editor.settings.size = self.workload.size;
        studio.editor.settings.opacity = 1.;
        studio.editor.settings.hardness = 1.;
        studio.editor.settings.stabilization = 0.;
        studio.editor.settings.foreground = [255, 0, 0, 255];
        studio.editor.settings.secondary = [0, 0, 255, 255];
        studio.editor.settings.square = false;
        self.configured = true;
        self.startup_scene_ms = Some(ms(start));
        Ok(())
    }

    fn stroke(&mut self, studio: &mut Studio) -> Result<(), String> {
        let stroke = self.samples.len();
        let start = Instant::now();
        let view = *studio.editor.viewport();
        let red = stroke.is_multiple_of(2);
        let samples = self
            .workload
            .wave
            .iter()
            .enumerate()
            .map(|(index, variation)| {
                let along = if red {
                    index
                } else {
                    self.workload.wave.len() - 1 - index
                };
                let x = self.workload.first_x + self.workload.x_step * along as i32;
                let y = self.workload.first_y + self.workload.y_step * stroke as i32 + variation;
                let (x, y) = view.screen_point(f64::from(x), f64::from(y));
                Sample {
                    x,
                    y,
                    pressure: 1.,
                    pen: false,
                    shift: false,
                }
            })
            .collect::<Vec<_>>();
        let button = if red {
            PointerButton::Primary
        } else {
            PointerButton::Secondary
        };
        studio.editor.pointer_down(samples[0], button)?;
        for &sample in &samples[1..samples.len() - 1] {
            studio.editor.pointer_move(sample)?;
        }
        studio
            .editor
            .pointer_up(*samples.last().ok_or("입력점이 없습니다.")?)?;
        self.submit = Some((stroke, start, ms(start)));
        Ok(())
    }

    pub fn paint_finished(&mut self, uploads: usize, bytes: usize) {
        if self.first_frame_ms.is_none() {
            self.first_frame_ms = Some(ms(self.root_start));
        }
        if let Some((stroke, start, editor_ms)) = self.submit.take() {
            self.samples.push(SampleResult {
                stroke,
                editor_ms,
                editor_to_paint_ms: ms(start),
                render_uploads: uploads,
                upload_bytes: bytes,
            });
        }
    }

    fn write(&mut self, studio: &Studio, window: &Window) -> Result<(), String> {
        let state = studio.editor.document().state();
        let viewport = studio.editor.viewport();
        let outputs = state
            .layers
            .iter()
            .map(|layer| format!("{:x}", Sha256::digest(layer.pixels.as_slice())))
            .collect::<Vec<_>>();
        let report = serde_json::json!({
            "ok": true, "scope": "Installed GPUI event loop; scheduled controller replay from a single frame callback through native canvas paint return. Display scanout and physical pen are excluded.",
            "firstFrameMs": self.first_frame_ms,"scenePrepareMs":self.startup_scene_ms,
            "viewport":[viewport.width,viewport.height],"dpi":window.scale_factor(),"zoom":viewport.zoom,
            "document":[state.width,state.height,state.layers.len() as u32],
            "strokeSamples":self.samples,"layerHashes":outputs,"processId":std::process::id(),
        });
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&self.output)
            .map_err(|error| error.to_string())?;
        output
            .write_all(
                serde_json::to_string_pretty(&report)
                    .map_err(|err| err.to_string())?
                    .as_bytes(),
            )
            .map_err(|error| error.to_string())?;
        self.complete = true;
        Ok(())
    }
}

pub fn schedule(window: &mut Window, view: WeakEntity<Studio>) {
    window.on_next_frame(move |window, app| {
        let done = view
            .update(app, |studio, cx| {
                let Some(mut benchmark) = studio.benchmark.take() else {
                    return true;
                };
                let result = if benchmark.first_frame_ms.is_none() {
                    Ok(())
                } else if !benchmark.configured {
                    benchmark.setup(studio, cx)
                } else if benchmark.samples.len() == benchmark.workload.strokes {
                    benchmark.write(studio, window)
                } else if benchmark.submit.is_none() {
                    benchmark.stroke(studio)
                } else {
                    Ok(())
                };
                if let Err(error) = result {
                    let mut file = OpenOptions::new()
                        .create_new(true)
                        .write(true)
                        .open(&benchmark.output);
                    if let Ok(ref mut file) = file {
                        let _ = write!(file, "{}", serde_json::json!({"ok":false,"error":error}));
                    }
                    benchmark.complete = true;
                }
                let done = benchmark.complete;
                studio.benchmark = Some(benchmark);
                done
            })
            .unwrap_or(true);
        if done {
            window.remove_window();
            app.quit();
        } else {
            window.refresh();
            schedule(window, view);
        }
    });
}

pub fn paint_finished(view: &WeakEntity<Studio>, app: &mut App) {
    let _ = view.update(app, |studio, _| {
        let uploads = studio.cache_counts();
        if let Some(bench) = studio.benchmark.as_mut() {
            bench.paint_finished(uploads.0, uploads.1);
        }
    });
}

pub(crate) fn io_profile_fixture(size: u32) -> State {
    let mut pixels = vec![0; size as usize * size as usize * 4];
    let mut seed = 17_u32;
    for pixel in pixels.chunks_exact_mut(4) {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        pixel.copy_from_slice(&[seed as u8, (seed >> 16) as u8, (seed >> 24) as u8, 255]);
    }
    State {
        width: size,
        height: size,
        background: [0; 4],
        active: 0,
        layers: vec![Layer::new("fixture".into(), true, pixels)],
    }
}

pub struct IoBenchmark {
    output: PathBuf,
    scratch: tempfile::TempDir,
    project: bool,
    case: usize,
    step: usize,
    fixture_ready: bool,
    expected: Option<State>,
    before_export: Option<(u64, bool)>,
    pending: Option<IoSample>,
    results: Vec<IoTiming>,
}

struct IoSample {
    operation: &'static str,
    path: Option<PathBuf>,
    started: Instant,
    handler_ms: f64,
    first_frame_ms: Option<f64>,
    last_frame: Instant,
    max_frame_gap_ms: f64,
    completed_ms: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IoTiming {
    size: u32,
    height: u32,
    layers: usize,
    pending_edit: bool,
    operation: &'static str,
    handler_ms: f64,
    until_next_frame_ms: f64,
    completed_ms: f64,
    max_frame_gap_ms: f64,
}

impl IoBenchmark {
    pub fn new(output: PathBuf, root: &std::path::Path, project: bool) -> Result<Self, String> {
        if output.exists() {
            return Err("저장 계측 결과 경로는 새 파일이어야 합니다.".into());
        }
        let scratch = tempfile::tempdir_in(root).map_err(|error| error.to_string())?;
        Ok(Self {
            output,
            scratch,
            project,
            case: 0,
            step: 0,
            fixture_ready: false,
            expected: None,
            before_export: None,
            pending: None,
            results: Vec::new(),
        })
    }

    pub fn schedule(mut self, window: &mut Window, view: WeakEntity<Studio>) {
        window.on_next_frame(move |window, app| {
            let result = view
                .update(app, |studio, cx| -> Result<bool, String> {
                    let editor = &mut studio.editor;
                    let pending_edit = self.project && self.case == 1;
                    if !self.fixture_ready {
                        if self.project {
                            if pending_edit {
                                // Leave a Redo branch in place while the floating edit is exported.
                                let mut state = editor.document().state().clone();
                                state.layers[state.active].visible = !state.layers[state.active].visible;
                                editor.document_mut().commit_state("계측", state)?;
                                if !editor.undo() {
                                    return Err("계측용 다시 실행 상태를 만들 수 없습니다.".into());
                                }
                                editor.select_all()?;
                                let state = editor.document().state();
                                editor.nudge_selection(-(state.width as i32 / 8), -(state.height as i32 / 8))?;
                                if !editor.has_pending() {
                                    return Err("계측용 미확정 편집을 만들 수 없습니다.".into());
                                }
                            } else {
                                self.expected = Some(editor.document().state().clone());
                            }
                        } else {
                            studio.install_benchmark_state(io_profile_fixture([1024, 2048][self.case]), cx)?;
                        }
                        self.fixture_ready = true;
                        cx.notify();
                        return Ok(false);
                    }
                    if let Some(mut pending) = self.pending.take() {
                        let now = Instant::now();
                        let elapsed_ms = now.duration_since(pending.started).as_secs_f64() * 1000.;
                        let gap_ms = now.duration_since(pending.last_frame).as_secs_f64() * 1000.;
                        let until_next_frame_ms = *pending.first_frame_ms.get_or_insert(elapsed_ms);
                        pending.max_frame_gap_ms = pending.max_frame_gap_ms.max(gap_ms);
                        pending.last_frame = now;
                        let Some(completed_ms) = pending.completed_ms else {
                            if !studio.file_write_pending() {
                                pending.completed_ms = Some(elapsed_ms);
                            }
                            self.pending = Some(pending);
                            return Ok(false);
                        };
                        if pending.path.as_ref().is_some_and(|path| !path.is_file()) {
                            return Err(format!("계측용 {} 파일을 쓰지 못했습니다.", pending.operation));
                        }
                        let editor = &mut studio.editor;
                        let document = editor.document();
                        let state = document.state();
                        if self.project {
                            if pending.operation == "png"
                                && (self.before_export != Some((document.revision(), document.can_redo()))
                                    || editor.has_pending() != pending_edit)
                            {
                                return Err("PNG 내보내기가 문서 또는 다시 실행 상태를 변경했습니다.".into());
                            }
                            if pending.operation == "rpaint" && (editor.has_pending() || document.dirty()) {
                                return Err("프로젝트 저장 후 편집이 확정되지 않았습니다.".into());
                            }
                        }
                        if self.project || pending.operation != "export-preview" {
                            self.results.push(IoTiming {
                                size: state.width,
                                height: state.height,
                                layers: state.layers.len(),
                                pending_edit,
                                operation: pending.operation,
                                handler_ms: pending.handler_ms,
                                until_next_frame_ms,
                                completed_ms,
                                max_frame_gap_ms: pending.max_frame_gap_ms,
                            });
                        }
                        self.step += 1;
                        if self.step == 3 {
                            if self.project && pending_edit {
                                for (case, expected) in [
                                    (0, self.expected.as_ref().expect("opened benchmark document")),
                                    (1, state),
                                ] {
                                    let project = std::fs::read(self.scratch.path().join(format!("{case}.rpaint")))
                                        .map_err(|error| error.to_string())?;
                                    if crate::format::decode_project(&project)? != *expected {
                                        return Err("저장한 프로젝트의 레이어 또는 픽셀이 다릅니다.".into());
                                    }
                                    let png = std::fs::read(self.scratch.path().join(format!("{case}.png")))
                                        .map_err(|error| error.to_string())?;
                                    if crate::format::decode_png(&png)?.pixels != expected.composite()? {
                                        return Err("내보낸 PNG의 합성 픽셀이 다릅니다.".into());
                                    }
                                }
                            }
                            self.case += 1;
                            self.step = 0;
                            self.fixture_ready = false;
                            return Ok(self.case == 2);
                        }
                        return Ok(false);
                    }
                    let operation = if self.project {
                        ["export-preview", "png", "rpaint"][self.step]
                    } else {
                        ["rpaint", "export-preview", "png"][self.step]
                    };
                    let path = (operation != "export-preview").then(|| {
                        self.scratch.path().join(format!("{}.{operation}", self.case))
                    });
                    if operation == "export-preview" {
                        let document = studio.editor.document();
                        self.before_export = Some((document.revision(), document.can_redo()));
                    }
                    let started = Instant::now();
                    match operation {
                        "export-preview" => studio.show_export(window, cx)?,
                        "png" => studio.save_export(path.as_deref(), window, cx)?,
                        _ => { studio.save(false, path.as_deref(), window, cx)?; }
                    }
                    if path.is_some() && !studio.file_write_pending() {
                        return Err(format!("계측용 {operation} 쓰기를 시작하지 못했습니다."));
                    }
                    studio.report(Ok(()), cx);
                    self.pending = Some(IoSample {
                        operation,
                        path,
                        started,
                        handler_ms: ms(started),
                        first_frame_ms: None,
                        last_frame: started,
                        max_frame_gap_ms: 0.,
                        completed_ms: None,
                    });
                    Ok(false)
                })
                .map_err(|error| error.to_string())
                .and_then(|result| result);
            if matches!(result, Ok(false)) {
                window.refresh();
                self.schedule(window, view);
                return;
            }
            let result = match result {
                Ok(true) => serde_json::json!({
                    "ok": true,
                    "scope": "GPUI frame callbacks from dispatch through the first frame after observed completion. File dialogs and display scanout excluded.",
                    "verifiedProjectAndPngPixels": self.project,
                    "timings": self.results,
                }),
                Err(error) => serde_json::json!({"ok": false, "error": error}),
                Ok(false) => unreachable!(),
            };
            let output = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&self.output)
                .and_then(|mut file| writeln!(file, "{result}"));
            if let Err(error) = output {
                eprintln!("myPaint Studio: {error}");
            }
            window.remove_window();
            app.quit();
        });
    }
}
