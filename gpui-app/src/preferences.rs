use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

const SCHEMA_VERSION: u8 = 1;
const MAX_BYTES: u64 = 4 * 1024;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Density {
    #[default]
    Auto,
    Touch,
    Mouse,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EraserMode {
    #[default]
    Transparent,
    Background,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub classic: bool,
    pub density: Density,
    pub eraser_mode: EraserMode,
    pub eraser_background: [u8; 3],
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            classic: false,
            density: Density::Auto,
            eraser_mode: EraserMode::Transparent,
            eraser_background: [255; 3],
        }
    }
}

impl Preferences {
    pub fn eraser_color(&self) -> Option<[u8; 4]> {
        let [red, green, blue] = self.eraser_background;
        (self.eraser_mode == EraserMode::Background).then_some([red, green, blue, 255])
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreferencesFile {
    schema_version: u8,
    preferences: Preferences,
}

#[derive(Clone)]
pub struct PreferenceStore {
    root: PathBuf,
}

impl PreferenceStore {
    pub fn new(profile_root: &Path) -> Self {
        Self {
            root: profile_root.to_owned(),
        }
    }

    fn path(&self) -> PathBuf {
        self.root.join("preferences.json")
    }

    pub fn load(&self) -> Result<Preferences, String> {
        let path = self.path();
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => return Err("환경 설정 파일이 일반 파일이 아닙니다.".into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(Preferences::default());
            }
            Err(error) => return Err(error.to_string()),
        }
        let file = File::open(path).map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        file.take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("환경 설정 파일이 너무 큽니다.".into());
        }
        let saved: PreferencesFile =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if saved.schema_version != SCHEMA_VERSION {
            return Err("지원하지 않는 환경 설정 파일 버전입니다.".into());
        }
        Ok(saved.preferences)
    }

    pub fn save(&self, preferences: &Preferences) -> Result<(), String> {
        let saved = PreferencesFile {
            schema_version: SCHEMA_VERSION,
            preferences: preferences.clone(),
        };
        let bytes = serde_json::to_vec(&saved).map_err(|error| error.to_string())?;
        self.replace(&bytes).map_err(|error| error.to_string())
    }

    fn replace(&self, bytes: &[u8]) -> io::Result<()> {
        fs::create_dir_all(&self.root)?;
        let mut stage = tempfile::Builder::new()
            .prefix(".preferences-")
            .tempfile_in(&self.root)?;
        stage.write_all(bytes)?;
        stage.as_file().sync_all()?;
        stage.persist(self.path())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn committed_preferences_round_trip_across_store_instances_and_profiles() {
        let root = tempfile::tempdir().unwrap();
        let active = root.path().join("active");
        let separate = root.path().join("separate");
        let store = PreferenceStore::new(&active);
        assert_eq!(store.load().unwrap(), Preferences::default());
        assert!(!store.path().exists());
        let mut settings = Preferences {
            classic: true,
            density: Density::Touch,
            eraser_mode: EraserMode::Background,
            eraser_background: [35, 75, 150],
        };
        store.save(&settings).unwrap();
        let restarted = PreferenceStore::new(&active);
        assert_eq!(restarted.load().unwrap(), settings);
        assert_eq!(settings.eraser_color(), Some([35, 75, 150, 255]));
        assert_eq!(
            PreferenceStore::new(&separate).load().unwrap(),
            Preferences::default()
        );

        settings.eraser_mode = EraserMode::Transparent;
        restarted.save(&settings).unwrap();
        let transparent = store.load().unwrap();
        assert_eq!(transparent.eraser_color(), None);
        assert_eq!(transparent.eraser_background, [35, 75, 150]);
        assert_eq!(fs::read_dir(&active).unwrap().count(), 1);
    }

    #[test]
    fn malformed_and_unbounded_inputs_remain_available_for_repair() {
        let root = tempfile::tempdir().unwrap();
        let store = PreferenceStore::new(root.path());
        for bytes in [
            b"{".as_slice(),
            br#"{"schemaVersion":2,"preferences":{}}"#,
            br#"{"schemaVersion":1,"preferences":{"eraserBackground":[1,2,256]}}"#,
            &vec![b' '; MAX_BYTES as usize + 1],
        ] {
            fs::write(store.path(), bytes).unwrap();
            assert!(store.load().is_err());
            assert_eq!(fs::read(store.path()).unwrap(), bytes);
        }

        fs::write(store.path(), br#"{"schemaVersion":1,"preferences":{}}"#).unwrap();
        assert_eq!(store.load().unwrap(), Preferences::default());
    }

    #[test]
    fn dropped_draft_does_not_touch_committed_preferences() {
        let root = tempfile::tempdir().unwrap();
        let store = PreferenceStore::new(root.path());
        let saved = Preferences::default();
        store.save(&saved).unwrap();
        let committed_bytes = fs::read(store.path()).unwrap();
        {
            let mut draft = store.load().unwrap();
            draft.density = Density::Mouse;
            draft.eraser_background = [30, 40, 50];
            assert_ne!(draft, saved);
        }
        assert_eq!(store.load().unwrap(), saved);
        assert_eq!(fs::read(store.path()).unwrap(), committed_bytes);
    }

    #[test]
    fn failed_replacement_keeps_existing_target_and_removes_stage() {
        let root = tempfile::tempdir().unwrap();
        let store = PreferenceStore::new(root.path());
        fs::create_dir(store.path()).unwrap();
        let original = store.path().join("existing");
        fs::write(&original, b"Original").unwrap();
        assert!(store.save(&Preferences::default()).is_err());
        assert_eq!(fs::read(original).unwrap(), b"Original");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_sharing_violation_keeps_previous_preferences() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

        let root = tempfile::tempdir().unwrap();
        let store = PreferenceStore::new(root.path());
        let saved = Preferences::default();
        store.save(&saved).unwrap();
        let before = fs::read(store.path()).unwrap();
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(store.path())
            .unwrap();
        let changed = Preferences {
            classic: true,
            ..saved.clone()
        };

        assert!(store.save(&changed).is_err());
        assert_eq!(fs::read(store.path()).unwrap(), before);
        assert_eq!(store.load().unwrap(), saved);
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
        drop(locked);

        store.save(&changed).unwrap();
        assert_eq!(store.load().unwrap(), changed);
    }
}
