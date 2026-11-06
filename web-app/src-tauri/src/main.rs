#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
compile_error!("Mobile uses the web application; native builds target Windows and macOS only.");
#[cfg(target_os = "macos")]
mod lifecycle;
mod persistence;
use base64::Engine;
use persistence::{
    MAX_BYTES, OpenTarget, Persistence, Receipt, RecoveryListing, RecoveryMetadata, SaveTarget,
};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::Manager;
struct NativeState {
    paths: OnceLock<(PathBuf, PathBuf)>,
    persistence: tokio::sync::OnceCell<Arc<Persistence>>,
    allow_close: AtomicBool,
    guard_armed: AtomicBool,
}
impl NativeState {
    async fn store(&self) -> Result<Arc<Persistence>, String> {
        self.persistence
            .get_or_try_init(|| async {
                let (root, legacy) = self
                    .paths
                    .get()
                    .cloned()
                    .ok_or("파일 저장소 경로를 시작하지 못했습니다.")?;
                tauri::async_runtime::spawn_blocking(move || Persistence::new(&root, &legacy))
                    .await
                    .map_err(|e| e.to_string())?
            })
            .await
            .map(Arc::clone)
    }
    async fn activate(
        &self,
        generation: u64,
        key: String,
        source_token: Option<String>,
    ) -> Result<(), String> {
        let store = self.store().await?;
        tauri::async_runtime::spawn_blocking(move || store.activate(generation, key, source_token))
            .await
            .map_err(|e| e.to_string())??;
        self.guard_armed.store(true, Ordering::SeqCst);
        Ok(())
    }
}
#[tauri::command]
async fn activate_document(
    generation: u64,
    key: String,
    source_token: Option<String>,
    state: tauri::State<'_, NativeState>,
) -> Result<(), String> {
    state.activate(generation, key, source_token).await
}
#[tauri::command]
async fn choose_open(state: tauri::State<'_, NativeState>) -> Result<Option<OpenTarget>, String> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("그림 또는 프로젝트 열기")
        .add_filter(
            "그림 및 프로젝트",
            &["rpaint", "png", "jpg", "jpeg", "bmp", "gif"],
        )
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let store = state.store().await?;
    let path = file.path().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || store.register_open(&path).map(Some))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn read_selected(
    token: String,
    state: tauri::State<'_, NativeState>,
) -> Result<tauri::ipc::Response, String> {
    let store = state.store().await?;
    let data = tauri::async_runtime::spawn_blocking(move || store.read_selected(&token))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(data))
}
#[tauri::command]
async fn choose_save(
    name: String,
    generation: u64,
    project: bool,
    save_as: bool,
    state: tauri::State<'_, NativeState>,
) -> Result<Option<SaveTarget>, String> {
    let store = state.store().await?;
    let existing = store.clone();
    if let Some(target) = tauri::async_runtime::spawn_blocking(move || {
        existing.existing_save(generation, project, save_as)
    })
    .await
    .map_err(|e| e.to_string())??
    {
        return Ok(Some(target));
    }
    let name: String = name
        .chars()
        .filter(|c| !matches!(*c, '/' | '\\' | '\0'))
        .take(256)
        .collect();
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_title(if project {
            "프로젝트 저장"
        } else {
            "이미지 내보내기"
        })
        .set_file_name(name);
    if project {
        dialog = dialog.add_filter("myPaint 프로젝트", &["rpaint"]);
    }
    let Some(file) = dialog.save_file().await else {
        return Ok(None);
    };
    let path = file.path().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        store.register_save(&path, generation, project).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn write_selected(
    request: tauri::ipc::Request<'_>,
    state: tauri::State<'_, NativeState>,
) -> Result<Receipt, String> {
    let token = request
        .headers()
        .get("x-save-token")
        .and_then(|v| v.to_str().ok())
        .ok_or("저장 대상을 다시 선택하세요.")?
        .to_owned();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("이진 출력 데이터가 필요합니다.".into());
    };
    if bytes.is_empty() || bytes.len() as u64 > MAX_BYTES {
        return Err("출력은 300 MiB 이내여야 합니다.".into());
    }
    let store = state.store().await?;
    let length = bytes.len();
    let magic = bytes.starts_with(b"RPAINT01");
    let mut job =
        tauri::async_runtime::spawn_blocking(move || store.claim_save(&token, length, magic))
            .await
            .map_err(|e| e.to_string())??;
    let result = job.write(bytes).await;
    tauri::async_runtime::spawn_blocking(move || {
        result?;
        job.commit()?.ok_or("저장 응답이 없습니다.".into())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn cancel_write(token: String, state: tauri::State<'_, NativeState>) -> Result<(), String> {
    state.store().await?.cancel(&token)
}
#[tauri::command]
async fn recovery_list(state: tauri::State<'_, NativeState>) -> Result<RecoveryListing, String> {
    let store = state.store().await?;
    tauri::async_runtime::spawn_blocking(move || store.list())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn recovery_read(
    token: String,
    state: tauri::State<'_, NativeState>,
) -> Result<tauri::ipc::Response, String> {
    let store = state.store().await?;
    let data = tauri::async_runtime::spawn_blocking(move || store.recovery_read(&token))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(data))
}
#[tauri::command]
async fn recovery_clear(token: String, state: tauri::State<'_, NativeState>) -> Result<(), String> {
    let store = state.store().await?;
    tauri::async_runtime::spawn_blocking(move || store.clear(&token))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn recovery_write(
    request: tauri::ipc::Request<'_>,
    state: tauri::State<'_, NativeState>,
) -> Result<(), String> {
    let headers = request.headers();
    let header = |key| {
        headers
            .get(key)
            .and_then(|v| v.to_str().ok())
            .ok_or("복구 메타데이터가 없습니다.")
    };
    let generation = header("x-recovery-generation")?
        .parse::<u64>()
        .map_err(|_| "복구 세대가 올바르지 않습니다.")?;
    let key = header("x-recovery-key")?.to_owned();
    let sequence = header("x-recovery-sequence")?
        .parse::<u64>()
        .map_err(|_| "복구 순서가 올바르지 않습니다.")?;
    let encoded = header("x-recovery-name")?;
    if encoded.len() > 1400 {
        return Err("복구 이름 한도를 초과합니다.".into());
    }
    let name = String::from_utf8(
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| "복구 이름이 올바르지 않습니다.")?,
    )
    .map_err(|_| "복구 이름은 UTF-8이어야 합니다.")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("이진 복구 데이터가 필요합니다.".into());
    };
    let store = state.store().await?;
    let length = bytes.len();
    let magic = bytes.starts_with(b"RPAINT01");
    let metadata = RecoveryMetadata {
        generation,
        key,
        sequence,
        name,
    };
    let mut job =
        tauri::async_runtime::spawn_blocking(move || store.claim_recovery(metadata, length, magic))
            .await
            .map_err(|e| e.to_string())??;
    let result = job.write(bytes).await;
    tauri::async_runtime::spawn_blocking(move || {
        result?;
        job.commit().map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn runtime_ready() -> bool {
    std::env::args().any(|arg| arg == "--smoke")
}
#[tauri::command]
fn persistence_smoke_mode() -> bool {
    std::env::args().any(|arg| arg == "--persistence-root")
        && !std::env::args()
            .any(|arg| arg == "--codec-smoke" || arg == "--quit-smoke" || arg == "--render-smoke")
}
#[tauri::command]
fn render_smoke_mode() -> bool {
    std::env::args().any(|arg| arg == "--smoke")
        && std::env::args().any(|arg| arg == "--render-smoke")
        && argument_path("--persistence-root").is_some()
}
#[tauri::command]
fn smoke_result(
    ok: bool,
    error: String,
    app: tauri::AppHandle,
    state: tauri::State<NativeState>,
) -> Result<(), String> {
    if !std::env::args().any(|arg| arg == "--smoke") {
        return Err("네이티브 검증 모드에서만 종료 결과를 보낼 수 있습니다.".into());
    }
    println!("myPaint native smoke: ok={ok} {error}");
    state.allow_close.store(true, Ordering::SeqCst);
    app.exit(if ok { 0 } else { 1 });
    Ok(())
}
#[tauri::command]
fn quit_smoke_modes() -> Vec<String> {
    if !std::env::args().any(|arg| arg == "--smoke")
        || !std::env::args().any(|arg| arg == "--quit-smoke")
        || argument_path("--persistence-root").is_none()
    {
        return vec![];
    }
    #[cfg(target_os = "macos")]
    {
        vec!["runtime".into(), "native".into()]
    }
    #[cfg(windows)]
    {
        vec!["runtime".into()]
    }
}
#[tauri::command]
fn quit_smoke_report(checks: serde_json::Value) -> Result<(), String> {
    if quit_smoke_modes().is_empty() {
        return Err("격리된 앱 종료 검증 모드가 아닙니다.".into());
    }
    println!("myPaint native quit smoke: ok=true {checks}");
    Ok(())
}
#[tauri::command]
fn smoke_quit(
    mode: String,
    app: tauri::AppHandle,
    state: tauri::State<NativeState>,
) -> Result<(), String> {
    if !quit_smoke_modes().contains(&mode) {
        return Err("격리된 앱 종료 검증 모드가 아닙니다.".into());
    }
    if !state.guard_armed.load(Ordering::SeqCst) {
        return Err("문서 준비를 완료한 뒤 앱 종료를 검증하세요.".into());
    }
    if mode == "runtime" {
        app.exit(0);
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    if mode == "native" {
        return app
            .run_on_main_thread(lifecycle::terminate)
            .map_err(|e| e.to_string());
    }
    Err("지원하지 않는 앱 종료 검증 방식입니다.".into())
}
#[tauri::command]
fn close_window(app: tauri::AppHandle, state: tauri::State<NativeState>) -> Result<(), String> {
    state.allow_close.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}
fn request_close(app: &tauri::AppHandle) -> bool {
    let state = app.state::<NativeState>();
    if state.allow_close.load(Ordering::SeqCst) || !state.guard_armed.load(Ordering::SeqCst) {
        return true;
    }
    let Some(view) = app.get_webview_window("main") else {
        return true;
    };
    let _ = view.eval("window.dispatchEvent(new Event('mypaint-close-request'))");
    false
}
fn argument_path(flag: &str) -> Option<PathBuf> {
    let mut args = std::env::args();
    while let Some(arg) = args.next() {
        if arg == flag {
            return args.next().map(PathBuf::from);
        }
    }
    None
}
fn legacy_path() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
            .join("Library/Application Support/RetroPaint/RetroPaint")
    }
    #[cfg(windows)]
    {
        PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default())
            .join("RetroPaint/RetroPaint")
    }
}
fn io_smoke(root: &Path) -> Result<(), String> {
    let store = Persistence::new(&root.join("app"), &root.join("legacy"))?;
    store.activate(1, "io-document".into(), None)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    for mib in [65usize, 300] {
        let mut bytes = vec![0x5a; mib * 1024 * 1024];
        bytes[..8].copy_from_slice(b"RPAINT01");
        let metadata = RecoveryMetadata {
            generation: 1,
            key: "io-document".into(),
            sequence: mib as u64,
            name: format!("{mib} MiB 실파일"),
        };
        let mut job = store.claim_recovery(metadata, bytes.len(), true)?;
        runtime.block_on(job.write(&bytes))?;
        job.commit()?;
        drop(bytes);
        let entry = store.list()?.entries.remove(0);
        let read = store.recovery_read(&entry.token)?;
        if read.len() != mib * 1024 * 1024
            || &read[..8] != b"RPAINT01"
            || read[8..].iter().any(|b| *b != 0x5a)
        {
            return Err("실파일 복구 비교 실패".into());
        }
        drop(read);
        println!("myPaint IO smoke: {mib} MiB binary recovery roundtrip passed");
    }
    Ok(())
}
fn main() {
    if let Some(root) = argument_path("--io-smoke") {
        match io_smoke(&root) {
            Ok(()) => return,
            Err(e) => {
                eprintln!("myPaint IO smoke: {e}");
                std::process::exit(1);
            }
        }
    }
    let mut context = tauri::generate_context!();
    if argument_path("--persistence-root").is_some() {
        for window in &mut context.config_mut().app.windows {
            window.incognito = true;
            window.data_directory = None;
            window.data_store_identifier = None;
        }
    }
    tauri::Builder::default()
        .manage(NativeState {
            paths: OnceLock::new(),
            persistence: tokio::sync::OnceCell::new(),
            allow_close: AtomicBool::new(false),
            guard_armed: AtomicBool::new(false),
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            lifecycle::install(app.handle()).map_err(std::io::Error::other)?;
            let (root, legacy) = if let Some(root) = argument_path("--persistence-root") {
                (root.join("app"), root.join("legacy"))
            } else {
                (app.path().app_local_data_dir()?, legacy_path())
            };
            app.state::<NativeState>()
                .paths
                .set((root, legacy))
                .map_err(|_| std::io::Error::other("저장소 경로가 이미 초기화됐습니다."))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            activate_document,
            choose_open,
            read_selected,
            choose_save,
            write_selected,
            cancel_write,
            recovery_list,
            recovery_read,
            recovery_write,
            recovery_clear,
            close_window,
            runtime_ready,
            persistence_smoke_mode,
            render_smoke_mode,
            quit_smoke_modes,
            quit_smoke_report,
            smoke_quit,
            smoke_result
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && !request_close(window.app_handle())
            {
                api.prevent_close();
            }
        })
        .build(context)
        .expect("myPaint desktop could not start")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event
                && !request_close(app)
            {
                api.prevent_exit();
            }
        });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordinary_process_does_not_expose_smoke_modes() {
        assert!(!runtime_ready());
        assert!(!persistence_smoke_mode());
        assert!(!render_smoke_mode());
        assert!(quit_smoke_modes().is_empty());
        assert!(quit_smoke_report(serde_json::json!({"readyForApprovedClose":true})).is_err());
    }
    #[test]
    fn initialization_failure_can_retry_after_other_session_releases_lock() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("app");
        let legacy = directory.path().join("legacy");
        let other = Persistence::new(&root, &legacy).unwrap();
        let state = NativeState {
            paths: OnceLock::new(),
            persistence: tokio::sync::OnceCell::new(),
            allow_close: AtomicBool::new(false),
            guard_armed: AtomicBool::new(false),
        };
        state.paths.set((root, legacy)).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert!(runtime.block_on(state.store()).is_err());
        assert!(state.persistence.get().is_none());
        drop(other);
        assert!(runtime.block_on(state.store()).is_ok());
        assert!(state.persistence.get().is_some());
    }
    #[test]
    fn quit_guard_arms_only_after_successful_activation_and_stays_armed_on_later_failure() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("app");
        let legacy = directory.path().join("legacy");
        let other = Persistence::new(&root, &legacy).unwrap();
        let state = NativeState {
            paths: OnceLock::new(),
            persistence: tokio::sync::OnceCell::new(),
            allow_close: AtomicBool::new(false),
            guard_armed: AtomicBool::new(false),
        };
        state.paths.set((root, legacy)).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert!(!state.guard_armed.load(Ordering::SeqCst));
        assert!(
            runtime
                .block_on(state.activate(1, "ready".into(), None))
                .is_err()
        );
        assert!(!state.guard_armed.load(Ordering::SeqCst));
        drop(other);
        assert!(
            runtime
                .block_on(state.activate(0, "invalid".into(), None))
                .is_err()
        );
        assert!(!state.guard_armed.load(Ordering::SeqCst));
        runtime
            .block_on(state.activate(1, "ready".into(), None))
            .unwrap();
        assert!(state.guard_armed.load(Ordering::SeqCst));
        assert!(
            runtime
                .block_on(state.activate(1, "stale".into(), None))
                .is_err()
        );
        assert!(state.guard_armed.load(Ordering::SeqCst));
        assert!(!state.allow_close.load(Ordering::SeqCst));
    }
}
