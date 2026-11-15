#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod benchmark;
mod editor;
mod engine;
mod export_preview;
mod format;
mod input;
mod interop;
mod io;
mod pen;
mod preferences;
mod render;
mod touch;
mod ui;

use std::{ffi::OsString, path::PathBuf, time::Instant};

use gpui::{App, AppContext, Bounds, Focusable, WindowBounds, WindowOptions, px, size};

fn path_arg(args: &[OsString], flag: &str) -> Option<PathBuf> {
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| PathBuf::from(&pair[1]))
}

fn start(args: &[OsString]) -> Result<(), String> {
    let started = Instant::now();
    if interop::run(args)? {
        return Ok(());
    }
    let isolated_root = path_arg(args, "--persistence-root");
    let mut smoke = if let Some(mode) = path_arg(args, "--windows-smoke") {
        if isolated_root.is_none() {
            return Err("Windows 검증에는 별도 --persistence-root가 필요합니다.".into());
        }
        let report = path_arg(args, "--windows-smoke-report")
            .ok_or("Windows 검증 출력 경로가 필요합니다.")?;
        Some(ui::WindowsSmoke::new(mode.as_os_str(), report)?)
    } else {
        None
    };
    let (data, legacy) = if let Some(root) = isolated_root {
        (root.join("app"), root.join("legacy"))
    } else {
        io::NativeIo::default_paths()?
    };
    let native = io::NativeIo::new(&data, &legacy)?;
    let preferences = preferences::PreferenceStore::new(&data);
    let initial = path_arg(args, "--open");
    let layers = path_arg(args, "--benchmark-layers")
        .and_then(|value| value.to_str()?.parse().ok())
        .unwrap_or(1);
    let mut benchmark = path_arg(args, "--benchmark-result")
        .map(|path| benchmark::Benchmark::new(path, layers, started))
        .transpose()?;
    if smoke.is_some() && (initial.is_some() || benchmark.is_some()) {
        return Err("Windows 검증과 파일 열기 또는 벤치마크를 함께 사용할 수 없습니다.".into());
    }
    gpui_platform::application()
        .with_assets(ui::Icons)
        .run(move |app: &mut App| {
            app.on_window_closed(|app, _| {
                if app.windows().is_empty() {
                    app.quit();
                }
            })
            .detach();
            let bounds = Bounds::centered(None, size(px(1280.0), px(840.0)), app);
            let opened = app.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: Some(gpui::TitlebarOptions {
                        title: Some("myPaint Studio GPUI Compare".into()),
                        ..Default::default()
                    }),
                    window_min_size: Some(size(px(640.0), px(420.0))),
                    ..Default::default()
                },
                move |window, app| {
                    let _ = pen::register(window);
                    let studio = app.new(|cx| {
                        match ui::Studio::new(
                            native.clone(),
                            preferences.clone(),
                            initial.as_deref(),
                            cx,
                        ) {
                            Ok(mut studio) => {
                                studio.benchmark = benchmark.take();
                                studio
                            }
                            Err(error) => {
                                eprintln!("myPaint Studio: {error}");
                                rfd::MessageDialog::new()
                                    .set_title("myPaint Studio")
                                    .set_description(&error)
                                    .set_level(rfd::MessageLevel::Error)
                                    .show();
                                std::process::exit(1);
                            }
                        }
                    });
                    let weak = studio.downgrade();
                    let mut touch_window = window.to_async(app);
                    let touch_studio = weak.clone();
                    let _ = touch::register(window, move |contact| {
                        touch_window
                            .update(|window, app| {
                                touch_studio
                                    .update(app, |studio, cx| {
                                        studio.native_touch(contact, window, cx)
                                    })
                                    .unwrap_or(false)
                            })
                            .unwrap_or(false)
                    });
                    window.on_window_should_close(app, move |window, app| {
                        weak.update(app, |studio, cx| studio.handle_close(window, cx))
                            .unwrap_or(true)
                    });
                    studio.read(app).focus_handle(app).focus(window, app);
                    if studio.read(app).benchmark.is_some() {
                        benchmark::schedule(window, studio.downgrade());
                    }
                    if let Some(smoke) = smoke.take() {
                        smoke.schedule(window, studio.downgrade());
                    }
                    studio
                },
            );
            if let Err(error) = opened {
                eprintln!("myPaint Studio: {error}");
                app.quit();
            } else {
                app.activate(true);
            }
        });
    Ok(())
}

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if let Err(error) = start(&args) {
        eprintln!("myPaint Studio: {error}");
        std::process::exit(1);
    }
}
