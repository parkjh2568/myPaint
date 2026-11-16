use crate::{
    engine::{Color, State},
    format::{self, ExportFormat, PROJECT_MAGIC},
};
use std::{
    fs::File,
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

mod persistence {
    include!("../../web-app/src-tauri/src/persistence.rs");
}

pub use persistence::RecoveryListing;
use persistence::{Persistence, RecoveryMetadata, SaveTarget};

pub struct LoadedDocument {
    pub state: State,
    pub name: String,
    pub source_token: Option<String>,
}

#[derive(Clone)]
pub struct NativeIo {
    store: Arc<Persistence>,
    runtime: Arc<tokio::runtime::Runtime>,
    recovery_serial: Arc<Mutex<()>>,
}

impl NativeIo {
    pub fn new(app_root: &Path, legacy_root: &Path) -> Result<Self, String> {
        let store = Persistence::new(app_root, legacy_root)?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            store,
            runtime: Arc::new(runtime),
            recovery_serial: Arc::new(Mutex::new(())),
        })
    }

    pub fn default_paths() -> Result<(PathBuf, PathBuf), String> {
        #[cfg(windows)]
        let (folder, relative) = ("LOCALAPPDATA", "");
        #[cfg(target_os = "macos")]
        let (folder, relative) = ("HOME", "Library/Application Support");
        #[cfg(not(any(windows, target_os = "macos")))]
        let (folder, relative) = ("HOME", ".local/share");
        let data = std::env::var_os(folder)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or("앱 데이터의 기본 경로를 찾을 수 없습니다.")?;
        let data = data.join(relative);
        Ok((
            data.join("io.github.parkjh2568.mypaint.gpui"),
            data.join("RetroPaint/RetroPaint"),
        ))
    }

    pub fn activate(
        &self,
        generation: u64,
        key: &str,
        source_token: Option<String>,
        close_previous: bool,
    ) -> Result<(), String> {
        self.store
            .activate(generation, key.to_owned(), source_token, close_previous)
    }

    pub fn retire_inactive(&self, generation: u64, key: &str) -> Result<(), String> {
        self.store.retire_inactive(generation, key)
    }

    pub fn open_path(&self, path: &Path) -> Result<LoadedDocument, String> {
        let target = self.store.register_open(path)?;
        let bytes = self.store.read_selected(&target.token)?;
        let project = bytes.starts_with(PROJECT_MAGIC)
            && path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("rpaint"));
        let state = format::decode_artwork(&bytes)?;
        Ok(LoadedDocument {
            state,
            name: target.name,
            source_token: project.then_some(target.token),
        })
    }

    pub fn open_dialog(&self) -> Result<Option<LoadedDocument>, String> {
        rfd::FileDialog::new()
            .set_title("그림 또는 프로젝트 열기")
            .add_filter(
                "그림 및 프로젝트",
                &["rpaint", "png", "jpg", "jpeg", "bmp", "gif"],
            )
            .pick_file()
            .map(|path| self.open_path(&path))
            .transpose()
    }

    pub fn save_project(
        &self,
        state: &State,
        generation: u64,
        name: &str,
        save_as: bool,
    ) -> Result<Option<String>, String> {
        let target = if let Some(target) = self.store.existing_save(generation, true, save_as)? {
            target
        } else {
            let name = project_file_name(name);
            let Some(path) = save_dialog("프로젝트 저장", "myPaint 프로젝트", &["rpaint"], &name)
            else {
                return Ok(None);
            };
            self.store.register_save(&path, generation, true)?
        };
        self.write_encoded(target, format::encode_project(state), generation, true)
            .map(Some)
    }

    pub fn save_project_path(
        &self,
        state: &State,
        generation: u64,
        path: &Path,
    ) -> Result<String, String> {
        let target = self.store.register_save(path, generation, true)?;
        self.write_encoded(target, format::encode_project(state), generation, true)
    }

    pub(crate) fn project_has_save_path(&self, generation: u64) -> Result<bool, String> {
        let Some(target) = self.store.existing_save(generation, true, false)? else {
            return Ok(false);
        };
        self.store.cancel(&target.token)?;
        Ok(true)
    }

    pub fn export_image(
        &self,
        state: &State,
        generation: u64,
        format: ExportFormat,
        matte: Color,
        stem: &str,
    ) -> Result<Option<String>, String> {
        let label = format.extension().to_ascii_uppercase();
        let stem: String = stem
            .trim()
            .replace(['/', '\\', '\0'], "_")
            .chars()
            .take(256)
            .collect();
        let stem = if stem.is_empty() { "그림" } else { &stem };
        let name = format!("{stem}.{}", format.extension());
        save_dialog("이미지 내보내기", &label, format.extensions(), &name)
            .map(|path| self.export_image_path(state, generation, format, matte, &path))
            .transpose()
    }

    pub fn export_image_path(
        &self,
        state: &State,
        generation: u64,
        format: ExportFormat,
        matte: Color,
        path: &Path,
    ) -> Result<String, String> {
        if !path.extension().is_some_and(|extension| {
            format
                .extensions()
                .iter()
                .any(|kind| extension.eq_ignore_ascii_case(kind))
        }) {
            return Err(format!(
                "이미지는 .{} 이름으로 저장하세요.",
                format.extension()
            ));
        }
        let target = self.store.register_save(path, generation, false)?;
        // The ticket captures file identity and content first. Inspecting the current file
        // after that protects every project, including an inactive tab or a hard link.
        let bytes = check_export_destination(path)
            .and_then(|()| format::export_image(state, format, matte));
        self.write_encoded(target, bytes, generation, false)
    }

    fn write_encoded(
        &self,
        target: SaveTarget,
        bytes: Result<Vec<u8>, String>,
        generation: u64,
        project: bool,
    ) -> Result<String, String> {
        debug_assert_eq!(target.generation, generation);
        let bytes = match bytes {
            Ok(bytes) => bytes,
            Err(error) => {
                self.store.cancel(&target.token)?;
                return Err(error);
            }
        };
        let mut job =
            self.store
                .claim_save(&target.token, bytes.len(), bytes.starts_with(PROJECT_MAGIC))?;
        self.runtime.block_on(job.write(&bytes))?;
        let receipt = job.commit()?.ok_or("저장 응답이 없습니다.")?;
        debug_assert_eq!(
            (receipt.generation, receipt.project, &receipt.name),
            (generation, project, &target.name)
        );
        Ok(receipt.name)
    }

    pub fn list(&self) -> Result<RecoveryListing, String> {
        self.store.list()
    }

    pub fn recover(&self, token: &str) -> Result<State, String> {
        format::decode_project(&self.store.recovery_read(token)?)
    }

    pub fn clear_recovery(&self, token: &str) -> Result<(), String> {
        self.store.clear(token)
    }

    pub fn snapshot(
        &self,
        state: &State,
        generation: u64,
        key: &str,
        sequence: u64,
        name: &str,
    ) -> Result<(), String> {
        let _serial = self.recovery_serial.lock().map_err(|e| e.to_string())?;
        let bytes = format::encode_project(state)?;
        let metadata = RecoveryMetadata {
            generation,
            key: key.to_owned(),
            sequence,
            name: name.to_owned(),
        };
        let mut job = self.store.claim_recovery(metadata, bytes.len(), true)?;
        self.runtime.block_on(job.write(&bytes))?;
        job.commit()?;
        Ok(())
    }
}

fn project_file_name(name: &str) -> String {
    let name: String = name
        .chars()
        .filter(|c| !matches!(*c, '/' | '\\' | '\0'))
        .take(256)
        .collect();
    let stem = Path::new(&name)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("그림");
    format!("{stem}.rpaint")
}

fn save_dialog(title: &str, label: &str, extensions: &[&str], name: &str) -> Option<PathBuf> {
    rfd::FileDialog::new()
        .set_title(title)
        .set_file_name(name)
        .add_filter(label, extensions)
        .save_file()
}

fn check_export_destination(path: &Path) -> Result<(), String> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let mut magic = [0; PROJECT_MAGIC.len()];
    match file.read_exact(&mut magic) {
        Ok(()) if &magic == PROJECT_MAGIC => {
            Err("이미지 내보내기는 프로젝트 원본과 다른 파일을 선택하세요.".into())
        }
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Layer;

    fn small_document() -> State {
        State {
            width: 1,
            height: 2,
            background: [13, 17, 5, 0],
            active: 0,
            layers: vec![Layer::new(
                "기준".into(),
                true,
                vec![7, 29, 3, 0, 212, 28, 77, 220],
            )],
        }
    }

    #[test]
    fn saves_recovers_and_reopens_the_exact_document_through_the_native_policy() {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("app");
        let legacy = root.path().join("legacy");
        let output = root.path().join("그림.rpaint");
        let state = small_document();
        {
            let io = NativeIo::new(&app, &legacy).unwrap();
            io.activate(1, "example", None, false).unwrap();
            assert_eq!(
                io.save_project_path(&state, 1, &output).unwrap(),
                "그림.rpaint"
            );
            io.snapshot(&state, 1, "example", 1, "그림.rpaint").unwrap();
        }
        let io = NativeIo::new(&app, &legacy).unwrap();
        let listing = io.list().unwrap();
        assert_eq!(listing.entries.len(), 1);
        assert!(listing.warnings.is_empty());
        let recovery = &listing.entries[0];
        let restored = io.recover(&recovery.token).unwrap();
        let opened = io.open_path(&output).unwrap();
        assert!(opened.source_token.is_some());
        assert_eq!(
            (&state.layers[0].pixels, &state.background),
            (&opened.state.layers[0].pixels, &opened.state.background)
        );
        assert_eq!(
            (&state.layers[0].pixels, &state.background),
            (&restored.layers[0].pixels, &restored.background)
        );
        io.clear_recovery(&recovery.token).unwrap();
        assert!(io.list().unwrap().entries.is_empty());
    }

    #[test]
    fn exports_never_replace_project_bytes_even_when_another_tab_is_active() {
        let root = tempfile::tempdir().unwrap();
        let io = NativeIo::new(&root.path().join("app"), &root.path().join("legacy")).unwrap();
        let state = small_document();
        let bytes = format::encode_project(&state).unwrap();
        let project = root.path().join("tab-a.rpaint");
        let alternate = root.path().join("tab-a.png");
        std::fs::write(&project, &bytes).unwrap();
        std::fs::write(&alternate, &bytes).unwrap();
        let opened = io.open_path(&project).unwrap();
        io.activate(1, "tab-a", opened.source_token, false).unwrap();
        io.activate(2, "tab-b", None, false).unwrap();
        for target in [&project, &alternate] {
            assert!(
                io.export_image_path(&state, 2, ExportFormat::Png, [255; 4], target)
                    .is_err()
            );
            assert_eq!(std::fs::read(target).unwrap(), bytes);
        }
        let fresh = root.path().join("image.png");
        assert_eq!(
            io.export_image_path(&state, 2, ExportFormat::Png, [255; 4], &fresh)
                .unwrap(),
            "image.png"
        );
        assert_eq!(
            format::decode_png(&std::fs::read(fresh).unwrap())
                .unwrap()
                .pixels,
            state.composite().unwrap()
        );
    }

    #[test]
    fn closing_inactive_tab_releases_its_binding_without_switching_the_active_store() {
        let root = tempfile::tempdir().unwrap();
        let io = NativeIo::new(&root.path().join("app"), &root.path().join("legacy")).unwrap();
        let state = small_document();
        io.activate(1, "inactive", None, false).unwrap();
        io.save_project_path(&state, 1, &root.path().join("inactive.rpaint"))
            .unwrap();
        io.activate(2, "active", None, false).unwrap();
        io.save_project_path(&state, 2, &root.path().join("active.rpaint"))
            .unwrap();
        assert!(io.retire_inactive(1, "inactive").is_err());
        assert!(io.retire_inactive(2, "active").is_err());
        io.retire_inactive(2, "inactive").unwrap();
        assert!(io.project_has_save_path(2).unwrap());
        assert!(
            io.snapshot(&state, 1, "inactive", 1, "inactive.rpaint")
                .is_err()
        );
        io.activate(3, "inactive", None, false).unwrap();
        assert!(!io.project_has_save_path(3).unwrap());
    }
}
