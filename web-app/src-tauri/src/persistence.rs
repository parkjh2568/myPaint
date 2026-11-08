use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::io::AsyncWriteExt;

pub const MAX_BYTES: u64 = 300 * 1024 * 1024;
const MAX_TOTAL: u64 = 1024 * 1024 * 1024;
const MAX_HEADS: usize = 32;
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const ENVELOPE: &[u8; 8] = b"RPREC001";
const PROJECT: &[u8; 8] = b"RPAINT01";
static SERIAL: AtomicU64 = AtomicU64::new(1);
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
}
fn valid_name(name: &str) -> bool {
    name.len() <= 1024 && name.encode_utf16().count() <= 256 && !name.contains('\0')
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(MAX_SAFE as u128) as u64
}
fn token() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    size: u64,
    modified: SystemTime,
    identity: (u64, u64),
    changed: (i64, i64),
    readonly: bool,
}
fn metadata_stamp(file: &File, m: &Metadata) -> Result<Stamp, String> {
    #[cfg(unix)]
    let (identity, changed) = {
        use std::os::unix::fs::MetadataExt;
        ((m.dev(), m.ino()), (m.ctime(), m.ctime_nsec()))
    };
    #[cfg(windows)]
    let (identity, changed) = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, FileBasicInfo, GetFileInformationByHandle,
            GetFileInformationByHandleEx,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
            return Err(error(std::io::Error::last_os_error()));
        }
        let mut basic: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle() as _,
                FileBasicInfo,
                &mut basic as *mut _ as _,
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(error(std::io::Error::last_os_error()));
        }
        (
            (
                info.dwVolumeSerialNumber as u64,
                ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
            ),
            (basic.ChangeTime, 0),
        )
    };
    #[cfg(unix)]
    let _ = file;
    Ok(Stamp {
        size: m.len(),
        modified: m.modified().map_err(error)?,
        identity,
        changed,
        readonly: m.permissions().readonly(),
    })
}
fn open_regular(path: &Path, writable: bool) -> Result<File, String> {
    let m = fs::symlink_metadata(path).map_err(error)?;
    if !m.is_file() || m.file_type().is_symlink() {
        return Err("일반 파일을 선택하세요.".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 {
            return Err("재분석 지점은 사용할 수 없습니다.".into());
        }
    }
    let mut options = OpenOptions::new();
    options.read(true).write(writable);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let file = options.open(path).map_err(error)?;
    if !file.metadata().map_err(error)?.is_file() {
        return Err("일반 파일만 읽을 수 있습니다.".into());
    }
    Ok(file)
}
fn stamp(path: &Path) -> Result<Option<Stamp>, String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(error(e)),
        Ok(_) => {
            let file = open_regular(path, false)?;
            Ok(Some(metadata_stamp(
                &file,
                &file.metadata().map_err(error)?,
            )?))
        }
    }
}
#[derive(Clone)]
struct Target {
    path: PathBuf,
    stamp: Option<Stamp>,
    content_digest: Option<[u8; 32]>,
    directory: Arc<Directory>,
}
struct Directory {
    path: PathBuf,
    // Windows retains this handle for directory lifetime/identity protection.
    // Only Unix uses its descriptor for relative operations and directory fsync.
    #[cfg_attr(windows, allow(dead_code))]
    file: File,
    identity: (u64, u64),
}
impl Directory {
    fn open(path: &Path) -> Result<Arc<Self>, String> {
        let path = fs::canonicalize(path).map_err(error)?;
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options
                .custom_flags(0x02000000 | 0x00200000)
                .share_mode(1 | 2);
        }
        let file = options.open(&path).map_err(error)?;
        let metadata = file.metadata().map_err(error)?;
        if !metadata.is_dir() {
            return Err("저장 폴더가 올바르지 않습니다.".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("재분석 폴더를 사용할 수 없습니다.".into());
            }
        }
        let identity = metadata_stamp(&file, &metadata)?.identity;
        Ok(Arc::new(Self {
            path,
            file,
            identity,
        }))
    }
    fn check(&self) -> Result<(), String> {
        let other = Self::open(&self.path)?;
        if other.identity != self.identity {
            return Err("작업 중 폴더가 교체됐습니다.".into());
        }
        Ok(())
    }
}
impl Target {
    fn new(path: &Path) -> Result<Self, String> {
        let directory = Directory::open(path.parent().ok_or("폴더가 없습니다.")?)?;
        let name = path.file_name().ok_or("파일 이름이 없습니다.")?;
        let path = directory.path.join(name);
        let stamp = stamp(&path)?;
        Ok(Self {
            path,
            stamp,
            content_digest: None,
            directory,
        })
    }
    // Content checks are opt-in for manual save/open bindings, not recovery scans.
    fn capture_content(&mut self) -> Result<(), String> {
        self.check()?;
        if let Some(expected) = &self.stamp {
            self.content_digest = Some(self.fingerprint(expected)?);
        }
        Ok(())
    }
    fn fingerprint(&self, expected: &Stamp) -> Result<[u8; 32], String> {
        if expected.size > MAX_BYTES {
            return Err("덮어쓸 원본 파일은 300 MiB 이내여야 합니다.".into());
        }
        let mut file = open_regular(&self.path, false)?;
        if metadata_stamp(&file, &file.metadata().map_err(error)?)? != *expected {
            return Err("원본 파일이 변경됐습니다.".into());
        }
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        let mut total = 0u64;
        loop {
            // Read at most the expected size plus one byte, even if another writer grows it.
            let limit = (expected.size + 1 - total).min(buffer.len() as u64) as usize;
            let count = file.read(&mut buffer[..limit]).map_err(error)?;
            if count == 0 {
                break;
            }
            total += count as u64;
            if total > expected.size {
                return Err("읽는 중 원본 파일 크기가 변경됐습니다.".into());
            }
            hash.update(&buffer[..count]);
        }
        if total != expected.size
            || metadata_stamp(&file, &file.metadata().map_err(error)?)? != *expected
            || stamp(&self.path)?.as_ref() != Some(expected)
        {
            return Err("읽는 중 원본 파일이 변경됐습니다.".into());
        }
        Ok(hash.finalize().into())
    }
    fn check(&self) -> Result<(), String> {
        self.directory.check()?;
        if stamp(&self.path)? != self.stamp {
            return Err("다른 프로그램이 파일을 변경했습니다. 다시 선택하세요.".into());
        }
        if let Some(digest) = self.content_digest {
            let expected = self.stamp.as_ref().ok_or("원본 파일 상태 오류")?;
            if self.fingerprint(expected)? != digest {
                return Err("다른 프로그램이 파일 내용을 변경했습니다. 다시 선택하세요.".into());
            }
        }
        Ok(())
    }
}
struct Stage {
    target: Target,
    name: String,
    file: Option<File>,
    committed: bool,
    retain_on_failure: bool,
    content_digest: Option<[u8; 32]>,
    #[cfg(test)]
    after_commit: Option<Box<dyn FnOnce() + Send>>,
}
impl Stage {
    fn new(target: Target) -> Result<Self, String> {
        target.check()?;
        if target.stamp.as_ref().is_some_and(|s| s.readonly) {
            return Err("읽기 전용 파일은 덮어쓸 수 없습니다.".into());
        }
        let name = format!(".mypaint-{}.tmp", token());
        #[cfg(unix)]
        let file = {
            use std::os::fd::{AsRawFd, FromRawFd};
            let name_c = std::ffi::CString::new(name.as_bytes()).map_err(error)?;
            let fd = unsafe {
                libc::openat(
                    target.directory.file.as_raw_fd(),
                    name_c.as_ptr(),
                    libc::O_RDWR
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if fd < 0 {
                return Err(error(std::io::Error::last_os_error()));
            }
            unsafe { File::from_raw_fd(fd) }
        };
        #[cfg(windows)]
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(target.directory.path.join(&name))
            .map_err(error)?;
        let stage = Self {
            target,
            name,
            file: Some(file),
            committed: false,
            retain_on_failure: false,
            content_digest: None,
            #[cfg(test)]
            after_commit: None,
        };
        if stage.target.stamp.is_some() {
            let source = open_regular(&stage.target.path, true)?;
            if Some(metadata_stamp(&source, &source.metadata().map_err(error)?)?)
                != stage.target.stamp
            {
                return Err("대상 파일이 변경됐습니다.".into());
            }
            #[cfg(unix)]
            {
                use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
                let m = source.metadata().map_err(error)?;
                let destination = stage.file.as_ref().unwrap();
                if unsafe { libc::fchown(destination.as_raw_fd(), m.uid(), m.gid()) } != 0 {
                    return Err(error(std::io::Error::last_os_error()));
                }
                #[cfg(target_os = "macos")]
                if unsafe {
                    libc::fcopyfile(
                        source.as_raw_fd(),
                        destination.as_raw_fd(),
                        std::ptr::null_mut(),
                        libc::COPYFILE_ACL | libc::COPYFILE_XATTR,
                    )
                } != 0
                {
                    return Err(error(std::io::Error::last_os_error()));
                }
                destination
                    .set_permissions(m.permissions())
                    .map_err(error)?;
            }
        }
        Ok(stage)
    }
    async fn write(
        &mut self,
        prefix: &[u8],
        bytes: &[u8],
        cancelled: &AtomicBool,
    ) -> Result<(), String> {
        let mut file = tokio::fs::File::from_std(self.file.take().ok_or("임시 파일 상태 오류")?);
        file.set_max_buf_size(2 * 1024 * 1024);
        self.content_digest = None;
        let mut hash = Sha256::new();
        let result = async {
            for data in [prefix, bytes] {
                for chunk in data.chunks(2 * 1024 * 1024) {
                    if cancelled.load(Ordering::SeqCst) {
                        return Err("저장을 취소했습니다.".into());
                    }
                    file.write_all(chunk).await.map_err(error)?;
                    hash.update(chunk);
                }
            }
            file.flush().await.map_err(error)?;
            file.sync_all().await.map_err(error)?;
            Ok(())
        }
        .await;
        self.file = Some(file.into_std().await);
        if result.is_ok() {
            self.content_digest = Some(hash.finalize().into());
        }
        result
    }
    fn commit(&mut self) -> Result<(), String> {
        self.target.check()?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::ffi::OsStrExt;
            let from = std::ffi::CString::new(self.name.as_bytes()).map_err(error)?;
            let to = std::ffi::CString::new(self.target.path.file_name().unwrap().as_bytes())
                .map_err(error)?;
            let dir = self.target.directory.file.as_raw_fd();
            #[cfg(target_os = "macos")]
            let status = unsafe {
                libc::renameatx_np(
                    dir,
                    from.as_ptr(),
                    dir,
                    to.as_ptr(),
                    if self.target.stamp.is_none() {
                        libc::RENAME_EXCL
                    } else {
                        0
                    },
                )
            };
            #[cfg(not(target_os = "macos"))]
            let status = unsafe { libc::renameat(dir, from.as_ptr(), dir, to.as_ptr()) };
            if status != 0 {
                return Err(error(std::io::Error::last_os_error()));
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt};
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
                FILE_SHARE_READ, FILE_SHARE_WRITE, MOVEFILE_WRITE_THROUGH, MoveFileExW,
                ReplaceFileW,
            };
            // ReplaceFileW opens the replacement without sharing data access. Keep an
            // attributes-only handle to track our published identity without retaining
            // the writer (or reopening the destination and adopting another writer).
            let writer = self.file.as_ref().ok_or("임시 파일 상태 오류")?;
            let published = OpenOptions::new()
                .access_mode(FILE_READ_ATTRIBUTES)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(self.target.directory.path.join(&self.name))
                .map_err(error)?;
            if metadata_stamp(writer, &writer.metadata().map_err(error)?)?.identity
                != metadata_stamp(&published, &published.metadata().map_err(error)?)?.identity
            {
                return Err("임시 파일이 변경됐습니다.".into());
            }
            self.file = Some(published);
            let from: Vec<u16> = self
                .target
                .directory
                .path
                .join(&self.name)
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            let to: Vec<u16> = self
                .target
                .path
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            let status = unsafe {
                if self.target.stamp.is_some() {
                    ReplaceFileW(
                        to.as_ptr(),
                        from.as_ptr(),
                        std::ptr::null(),
                        0,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    )
                } else {
                    MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH)
                }
            };
            if status == 0 {
                let failure = std::io::Error::last_os_error();
                return Err(if self.target.stamp.is_some() {
                    self.replacement_error(failure)
                } else {
                    error(failure)
                });
            }
        }
        self.committed = true;
        #[cfg(test)]
        if let Some(after_commit) = self.after_commit.take() {
            after_commit();
        }
        // Replacement is already committed. A directory sync failure must not be reported as an uncommitted save.
        // Windows directory handles do not support this Unix durability operation.
        // The staged file was flushed before publication; MoveFileExW also requests write-through.
        #[cfg(unix)]
        if let Err(e) = self.target.directory.file.sync_all() {
            eprintln!("myPaint directory sync: {e}");
        }
        Ok(())
    }
    #[cfg(any(windows, test))]
    fn replacement_error(&mut self, failure: std::io::Error) -> String {
        // ReplaceFileW can remove or move the original before failing to publish
        // the replacement. Keep the staged bytes rather than deleting the only
        // remaining copy. Do not retry an operation with an uncertain outcome.
        if matches!(failure.raw_os_error(), Some(1176) | Some(1177)) {
            self.retain_on_failure = true;
            format!(
                "파일 교체가 일부만 완료됐을 수 있습니다. 대상 파일이 이동되거나 사라졌을 수 있습니다. 복구용 임시 파일을 보존했습니다: {} ({failure})",
                self.target.directory.path.join(&self.name).display()
            )
        } else {
            error(failure)
        }
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        self.file.take();
        if self.committed || self.retain_on_failure {
            return;
        }
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            if let Ok(name) = std::ffi::CString::new(self.name.as_bytes()) {
                unsafe {
                    libc::unlinkat(self.target.directory.file.as_raw_fd(), name.as_ptr(), 0);
                }
            }
        }
        #[cfg(windows)]
        {
            let _ = fs::remove_file(self.target.directory.path.join(&self.name));
        }
    }
}
fn read_target(target: &Target, maximum: u64) -> Result<Vec<u8>, String> {
    target.check()?;
    let file = open_regular(&target.path, false)?;
    let before = metadata_stamp(&file, &file.metadata().map_err(error)?)?;
    if Some(&before) != target.stamp.as_ref() || before.size == 0 || before.size > maximum {
        return Err("파일 크기 또는 버전이 올바르지 않습니다.".into());
    }
    let mut data = Vec::new();
    data.try_reserve_exact(before.size as usize)
        .map_err(error)?;
    (&file)
        .take(maximum + 1)
        .read_to_end(&mut data)
        .map_err(error)?;
    if data.len() as u64 != before.size
        || metadata_stamp(&file, &file.metadata().map_err(error)?)? != before
    {
        return Err("읽는 중 파일이 변경됐습니다.".into());
    }
    target.check()?;
    Ok(data)
}
// Qt's stale lock file is never edited or removed. A shared lock excludes a live
// Unix Qt writer while permitting read-only import after a crash left the file.
struct LegacyGuard {
    target: Target,
    _file: Option<File>,
}
impl LegacyGuard {
    fn new(directory: &Path) -> Result<Self, String> {
        let target = Target::new(&directory.join("session.lock"))?;
        let file = if target.stamp.is_some() {
            let file = open_regular(&target.path, false)?;
            fs2::FileExt::try_lock_shared(&file)
                .map_err(|_| "이전 Qt 앱이 실행 중입니다. 앱을 닫고 복구를 다시 시도하세요.")?;
            if Some(metadata_stamp(&file, &file.metadata().map_err(error)?)?) != target.stamp {
                return Err("이전 앱의 잠금 파일이 변경됐습니다.".into());
            }
            Some(file)
        } else {
            None
        };
        let guard = Self {
            target,
            _file: file,
        };
        guard.check()?;
        Ok(guard)
    }
    fn check(&self) -> Result<(), String> {
        self.target.check()
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Head {
    key: String,
    sequence: u64,
    size: u64,
    name: String,
    at: u64,
}
impl Head {
    fn valid(&self) -> bool {
        valid_key(&self.key)
            && self.sequence > 0
            && self.sequence <= MAX_SAFE
            && self.size >= 8
            && self.size <= MAX_BYTES
            && valid_name(&self.name)
            && self.at <= 8_640_000_000_000_000
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub key: String,
    pub sequence: u64,
    pub size: u64,
    pub name: String,
    pub at: u64,
    pub token: String,
    pub source: &'static str,
    pub read_only: bool,
}
#[derive(Serialize)]
pub struct RecoveryListing {
    pub entries: Vec<RecoveryEntry>,
    pub warnings: Vec<String>,
}
#[derive(Clone)]
struct RecoveryTicket {
    target: Target,
    head: Head,
    legacy: bool,
}
#[derive(Clone)]
struct ReadTicket {
    target: Target,
    project_read: bool,
}
#[derive(Clone)]
struct SaveTicket {
    target: Target,
    generation: u64,
    project: bool,
    cancelled: Arc<AtomicBool>,
}
#[derive(Default)]
struct Session {
    generation: u64,
    key: String,
    binding: Option<Target>,
    reads: HashMap<String, ReadTicket>,
    saves: HashMap<String, SaveTicket>,
    recovery: HashMap<String, RecoveryTicket>,
    writing: HashMap<String, Arc<AtomicBool>>,
    recovery_cancel: Arc<AtomicBool>,
}
pub struct Persistence {
    root: PathBuf,
    root_directory: Arc<Directory>,
    legacy: PathBuf,
    session: Mutex<Session>,
    recovery_busy: AtomicBool,
    _session_lock: File,
}
#[derive(Serialize)]
pub struct OpenTarget {
    pub token: String,
    pub name: String,
}
#[derive(Serialize)]
pub struct SaveTarget {
    pub token: String,
    pub name: String,
    pub generation: u64,
}
#[derive(Serialize)]
pub struct Receipt {
    pub name: String,
    pub generation: u64,
    pub project: bool,
}
pub struct RecoveryMetadata {
    pub generation: u64,
    pub key: String,
    pub sequence: u64,
    pub name: String,
}
fn filename(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}
fn read_head(target: &Target) -> Result<Head, String> {
    target.check()?;
    let mut file = open_regular(&target.path, false)?;
    if Some(metadata_stamp(&file, &file.metadata().map_err(error)?)?) != target.stamp {
        return Err("복구 파일이 변경됐습니다.".into());
    }
    let mut prefix = [0u8; 12];
    file.read_exact(&mut prefix).map_err(error)?;
    let length = u32::from_le_bytes(prefix[8..12].try_into().unwrap()) as usize;
    if &prefix[..8] != ENVELOPE || length == 0 || length > 4096 {
        return Err("복구 헤더가 올바르지 않습니다.".into());
    }
    let mut json = vec![0u8; length];
    file.read_exact(&mut json).map_err(error)?;
    let head: Head = serde_json::from_slice(&json).map_err(error)?;
    let mut magic = [0u8; 8];
    file.read_exact(&mut magic).map_err(error)?;
    if !head.valid()
        || magic != *PROJECT
        || target.stamp.as_ref().unwrap().size != 12 + length as u64 + head.size
    {
        return Err("복구 메타데이터가 올바르지 않습니다.".into());
    }
    if Some(metadata_stamp(&file, &file.metadata().map_err(error)?)?) != target.stamp {
        return Err("복구 파일이 변경됐습니다.".into());
    }
    target.check()?;
    Ok(head)
}
impl Persistence {
    pub fn new(app_root: &Path, legacy: &Path) -> Result<Arc<Self>, String> {
        fs::create_dir_all(app_root).map_err(error)?;
        let app_root = fs::canonicalize(app_root).map_err(error)?;
        let lock_path = app_root.join("session.lock");
        if fs::symlink_metadata(&lock_path)
            .is_ok_and(|m| !m.is_file() || m.file_type().is_symlink())
        {
            return Err("앱 잠금 파일이 올바르지 않습니다.".into());
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .mode(0o600);
        }
        let lock = options.open(&lock_path).map_err(error)?;
        fs2::FileExt::try_lock_exclusive(&lock)
            .map_err(|_| "다른 myPaint 창이 복구 저장소를 사용 중입니다.")?;
        let root = app_root.join("recovery");
        match fs::symlink_metadata(&root) {
            Ok(m) if !m.is_dir() || m.file_type().is_symlink() => {
                return Err("복구 폴더가 올바르지 않습니다.".into());
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&root).map_err(error)?
            }
            Err(e) => return Err(error(e)),
        }
        let root_directory = Directory::open(&root)?;
        Ok(Arc::new(Self {
            root,
            root_directory,
            legacy: legacy.to_path_buf(),
            session: Mutex::new(Session::default()),
            recovery_busy: AtomicBool::new(false),
            _session_lock: lock,
        }))
    }
    fn forbidden(&self, path: &Path) -> bool {
        if path.starts_with(self.root.parent().unwrap()) {
            return true;
        }
        let legacy = fs::canonicalize(&self.legacy).unwrap_or_else(|_| self.legacy.clone());
        path.parent() == Some(legacy.as_path()) && {
            let name = filename(path).to_ascii_lowercase();
            name.starts_with("recovery.rpaint") || name == "session.lock"
        }
    }
    pub fn activate(
        &self,
        generation: u64,
        key: String,
        source_token: Option<String>,
    ) -> Result<(), String> {
        if generation == 0 || generation > MAX_SAFE || !valid_key(&key) {
            return Err("문서 세대가 올바르지 않습니다.".into());
        }
        let mut session = self.session.lock().map_err(error)?;
        if generation == session.generation && key == session.key && source_token.is_none() {
            return Ok(());
        }
        if generation <= session.generation {
            return Err("문서 세대가 만료됐습니다.".into());
        }
        let binding = if let Some(token) = source_token {
            let ticket = session
                .reads
                .get(&token)
                .ok_or("선택한 원본 파일이 만료됐습니다.")?;
            if !ticket.project_read {
                return Err("검증된 프로젝트 원본이 아닙니다.".into());
            }
            ticket.target.check()?;
            if self.forbidden(&ticket.target.path) {
                None
            } else {
                Some(ticket.target.clone())
            }
        } else {
            None
        };
        for cancelled in session.writing.values() {
            cancelled.store(true, Ordering::SeqCst);
        }
        for ticket in session.saves.values() {
            ticket.cancelled.store(true, Ordering::SeqCst);
        }
        session.recovery_cancel.store(true, Ordering::SeqCst);
        session.recovery_cancel = Arc::new(AtomicBool::new(false));
        session.generation = generation;
        session.key = key;
        session.binding = binding;
        session.reads.clear();
        session.saves.clear();
        Ok(())
    }
    pub fn register_open(&self, path: &Path) -> Result<OpenTarget, String> {
        let target = Target::new(path)?;
        if target
            .stamp
            .as_ref()
            .is_none_or(|s| s.size == 0 || s.size > MAX_BYTES)
        {
            return Err("파일은 300 MiB 이내여야 합니다.".into());
        }
        let name = filename(&target.path);
        let token = token();
        let mut session = self.session.lock().map_err(error)?;
        session.reads.clear();
        session.reads.insert(
            token.clone(),
            ReadTicket {
                target,
                project_read: false,
            },
        );
        Ok(OpenTarget { token, name })
    }
    pub fn read_selected(&self, token: &str) -> Result<Vec<u8>, String> {
        let ticket = self
            .session
            .lock()
            .map_err(error)?
            .reads
            .get(token)
            .cloned()
            .ok_or("파일 선택이 만료됐습니다.")?;
        let data = read_target(&ticket.target, MAX_BYTES)?;
        let project = data.starts_with(PROJECT)
            && ticket
                .target
                .path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("rpaint"));
        let mut session = self.session.lock().map_err(error)?;
        let current = session
            .reads
            .get_mut(token)
            .ok_or("파일 선택이 만료됐습니다.")?;
        if current.target.stamp != ticket.target.stamp {
            return Err("파일 선택이 변경됐습니다.".into());
        }
        current.project_read = project;
        // Bind to the bytes actually delivered, not a later reopening of the path.
        current.target.content_digest = project.then(|| Sha256::digest(&data).into());
        Ok(data)
    }
    pub fn existing_save(
        &self,
        generation: u64,
        project: bool,
        save_as: bool,
    ) -> Result<Option<SaveTarget>, String> {
        let mut session = self.session.lock().map_err(error)?;
        if generation != session.generation {
            return Err("문서 세대가 만료됐습니다.".into());
        }
        if project
            && !save_as
            && let Some(target) = session.binding.clone()
        {
            return Self::add_save(&mut session, target, generation, project).map(Some);
        }
        Ok(None)
    }
    fn add_save(
        session: &mut Session,
        target: Target,
        generation: u64,
        project: bool,
    ) -> Result<SaveTarget, String> {
        if session.saves.len() >= 32 {
            return Err("저장 요청이 너무 많습니다.")?;
        }
        let token = token();
        let name = filename(&target.path);
        session.saves.insert(
            token.clone(),
            SaveTicket {
                target,
                generation,
                project,
                cancelled: Arc::new(AtomicBool::new(false)),
            },
        );
        Ok(SaveTarget {
            token,
            name,
            generation,
        })
    }
    pub fn register_save(
        &self,
        path: &Path,
        generation: u64,
        project: bool,
    ) -> Result<SaveTarget, String> {
        let mut target = Target::new(path)?;
        if self.forbidden(&target.path) {
            return Err("앱의 복구 원본에는 저장할 수 없습니다.".into());
        }
        if project
            && !path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("rpaint"))
        {
            return Err("프로젝트는 .rpaint 이름으로 저장하세요.".into());
        }
        target.capture_content()?;
        let mut session = self.session.lock().map_err(error)?;
        if generation != session.generation {
            return Err("문서 세대가 만료됐습니다.".into());
        }
        if !project
            && session.binding.as_ref().is_some_and(|b| {
                b.path == target.path
                    || b.stamp
                        .as_ref()
                        .zip(target.stamp.as_ref())
                        .is_some_and(|(a, b)| a.identity == b.identity)
            })
        {
            return Err("이미지 내보내기는 프로젝트 원본과 다른 파일을 선택하세요.".into());
        }
        Self::add_save(&mut session, target, generation, project)
    }
    pub fn cancel(&self, token: &str) -> Result<(), String> {
        let mut session = self.session.lock().map_err(error)?;
        if let Some(ticket) = session.saves.remove(token) {
            ticket.cancelled.store(true, Ordering::SeqCst);
        }
        if let Some(cancelled) = session.writing.get(token) {
            cancelled.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
    pub fn claim_save(
        self: &Arc<Self>,
        token: &str,
        length: usize,
        magic: bool,
    ) -> Result<WriteJob, String> {
        if length == 0 || length as u64 > MAX_BYTES {
            return Err("출력은 300 MiB 이내여야 합니다.".into());
        }
        let mut session = self.session.lock().map_err(error)?;
        if !session.writing.is_empty() {
            return Err("다른 저장 작업이 진행 중입니다.".into());
        }
        let ticket = session
            .saves
            .remove(token)
            .ok_or("저장 대상이 만료됐거나 이미 사용됐습니다.")?;
        if ticket.generation != session.generation
            || ticket.cancelled.load(Ordering::SeqCst)
            || ticket.project && !magic
        {
            return Err("저장 문서가 변경됐거나 올바르지 않습니다.".into());
        }
        session
            .writing
            .insert(token.into(), ticket.cancelled.clone());
        drop(session);
        let mut job = WriteJob {
            store: self.clone(),
            stage: None,
            token: token.into(),
            cancelled: ticket.cancelled.clone(),
            kind: JobKind::Save(ticket.clone()),
            prefix: vec![],
        };
        job.stage = Some(Stage::new(ticket.target)?);
        Ok(job)
    }
    fn scan(&self) -> Result<Vec<(Target, Head)>, String> {
        self.root_directory.check()?;
        let mut records = Vec::new();
        let mut total = 0u64;
        for entry in fs::read_dir(&self.root).map_err(error)? {
            let path = entry.map_err(error)?.path();
            let name = filename(&path);
            if name.starts_with(".mypaint-") && name.ends_with(".tmp") {
                continue;
            }
            if path.extension().is_none_or(|e| e != "rprec") {
                return Err("복구 폴더에 알 수 없는 파일이 있습니다. 원본을 보존합니다.".into());
            }
            if records.len() >= MAX_HEADS {
                return Err("복구 사본은 32개까지 보관할 수 있습니다.".into());
            }
            let target = Target::new(&path)?;
            let head = read_head(&target)?;
            if name != format!("{}.rprec", head.key) {
                return Err("복구 문서 키가 일치하지 않습니다.".into());
            }
            total = total.checked_add(head.size).ok_or("복구 합계 오류")?;
            if total > MAX_TOTAL {
                return Err("복구 합계 1 GiB 한도를 초과합니다.".into());
            }
            records.push((target, head));
        }
        Ok(records)
    }
    pub fn list(&self) -> Result<RecoveryListing, String> {
        let mut tickets = Vec::new();
        let mut warnings = Vec::new();
        let mut warn = |message: String| {
            if warnings.len() < 64 {
                warnings.push(message.chars().take(512).collect());
            }
        };
        // Listing isolates damaged files. Writes still use the strict complete scan
        // so unreadable records cannot disappear from quota accounting.
        let native = (|| -> Result<(), String> {
            self.root_directory.check()?;
            for (index, entry) in fs::read_dir(&self.root).map_err(error)?.enumerate() {
                if index >= 128 {
                    warn("복구 폴더 파일이 너무 많습니다. 일부 항목을 표시하지 못했습니다.".into());
                    break;
                }
                let path = match entry {
                    Ok(entry) => entry.path(),
                    Err(e) => {
                        warn(error(e));
                        continue;
                    }
                };
                let name = filename(&path);
                if name.starts_with(".mypaint-") && name.ends_with(".tmp") {
                    continue;
                }
                let record = (|| -> Result<RecoveryTicket, String> {
                    if path.extension().is_none_or(|e| e != "rprec") {
                        return Err("알 수 없는 파일 형식입니다.".into());
                    }
                    if tickets.len() >= MAX_HEADS {
                        return Err("복구 사본 32개 표시 한도를 초과했습니다.".into());
                    }
                    let target = Target::new(&path)?;
                    let head = read_head(&target)?;
                    if name != format!("{}.rprec", head.key) {
                        return Err("복구 문서 키가 일치하지 않습니다.".into());
                    }
                    Ok(RecoveryTicket {
                        target,
                        head,
                        legacy: false,
                    })
                })();
                match record {
                    Ok(ticket) => tickets.push(ticket),
                    Err(e) => warn(format!("복구 파일 '{name}': {e}")),
                }
            }
            self.root_directory.check()?;
            Ok(())
        })();
        if let Err(e) = native {
            warn(format!("앱 복구 저장소: {e}"));
        }
        if self.legacy.exists() {
            let legacy = (|| -> Result<Vec<RecoveryTicket>, String> {
                let guard = LegacyGuard::new(&self.legacy)?;
                let directory = Directory::open(&self.legacy)?;
                let mut paths = Vec::new();
                for (index, entry) in fs::read_dir(&directory.path).map_err(error)?.enumerate() {
                    if index >= 256 {
                        warn(
                            "이전 Qt 폴더 파일이 너무 많습니다. 일부 항목을 표시하지 못했습니다."
                                .into(),
                        );
                        break;
                    }
                    let path = match entry {
                        Ok(entry) => entry.path(),
                        Err(e) => {
                            warn(error(e));
                            continue;
                        }
                    };
                    let name = filename(&path);
                    if name == "recovery.rpaint"
                        || name.strip_prefix("recovery.rpaint.").is_some_and(|suffix| {
                            !suffix.is_empty()
                                && suffix.len() <= 32
                                && suffix.bytes().all(|b| b.is_ascii_digit() || b == b'-')
                        })
                    {
                        if paths.len() >= 32 {
                            warn("이전 Qt 복구 사본 32개 표시 한도를 초과했습니다.".into());
                            break;
                        }
                        paths.push(path);
                    }
                }
                paths.sort();
                let mut result = Vec::new();
                for path in paths {
                    let record = (|| -> Result<RecoveryTicket, String> {
                        let target = Target::new(&path)?;
                        let mark = target.stamp.as_ref().ok_or("이전 복구 파일 없음")?;
                        if mark.size < 8 || mark.size > MAX_BYTES {
                            return Err("이전 복구 파일은 300 MiB 이내여야 합니다.".into());
                        }
                        let mut file = open_regular(&path, false)?;
                        let mut magic = [0u8; 8];
                        file.read_exact(&mut magic).map_err(error)?;
                        if magic != *PROJECT
                            || Some(metadata_stamp(&file, &file.metadata().map_err(error)?)?)
                                != target.stamp
                        {
                            return Err("이전 복구 파일이 손상됐거나 변경됐습니다.".into());
                        }
                        target.check()?;
                        let at = mark
                            .modified
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis()
                            .min(8_640_000_000_000_000) as u64;
                        let head = Head {
                            key: format!("legacy-{}", token()),
                            sequence: 1,
                            size: mark.size,
                            name: format!("Qt 복구: {}", filename(&path)),
                            at,
                        };
                        Ok(RecoveryTicket {
                            target,
                            head,
                            legacy: true,
                        })
                    })();
                    match record {
                        Ok(ticket) => result.push(ticket),
                        Err(e) => warn(format!("이전 Qt 복구 파일 '{}': {e}", filename(&path))),
                    }
                }
                guard.check()?;
                Ok(result)
            })();
            match legacy {
                Ok(records) => tickets.extend(records),
                Err(e) => warn(format!("이전 Qt 복구 저장소: {e}")),
            }
        }
        let mut session = self.session.lock().map_err(error)?;
        session.recovery.clear();
        let mut entries = Vec::new();
        for ticket in tickets {
            let token = token();
            let h = &ticket.head;
            entries.push(RecoveryEntry {
                key: h.key.clone(),
                sequence: h.sequence,
                size: h.size,
                name: h.name.clone(),
                at: h.at,
                token: token.clone(),
                source: if ticket.legacy { "legacy" } else { "native" },
                read_only: ticket.legacy,
            });
            session.recovery.insert(token, ticket);
        }
        entries.sort_by(|a, b| b.at.cmp(&a.at));
        Ok(RecoveryListing { entries, warnings })
    }
    pub fn recovery_read(&self, token: &str) -> Result<Vec<u8>, String> {
        let ticket = self
            .session
            .lock()
            .map_err(error)?
            .recovery
            .get(token)
            .cloned()
            .ok_or("복구 목록이 만료됐습니다.")?;
        if ticket.legacy {
            let guard = LegacyGuard::new(&self.legacy)?;
            let bytes = read_target(&ticket.target, MAX_BYTES)?;
            guard.check()?;
            return Ok(bytes);
        }
        if read_head(&ticket.target)? != ticket.head {
            return Err("복구 사본이 갱신됐습니다. 목록을 다시 여세요.".into());
        }
        // Read only the payload; the envelope never adds another full-size allocation.
        let mut file = open_regular(&ticket.target.path, false)?;
        if Some(metadata_stamp(&file, &file.metadata().map_err(error)?)?) != ticket.target.stamp {
            return Err("복구 사본이 갱신됐습니다.".into());
        }
        let mut prefix = [0u8; 12];
        file.read_exact(&mut prefix).map_err(error)?;
        let length = u32::from_le_bytes(prefix[8..12].try_into().unwrap()) as u64;
        file.seek(SeekFrom::Start(12 + length)).map_err(error)?;
        let mut data = Vec::new();
        data.try_reserve_exact(ticket.head.size as usize)
            .map_err(error)?;
        (&file)
            .take(ticket.head.size + 1)
            .read_to_end(&mut data)
            .map_err(error)?;
        if data.len() as u64 != ticket.head.size
            || !data.starts_with(PROJECT)
            || Some(metadata_stamp(&file, &file.metadata().map_err(error)?)?) != ticket.target.stamp
        {
            return Err("읽는 중 복구 파일이 변경됐습니다.".into());
        }
        ticket.target.check()?;
        Ok(data)
    }
    pub fn clear(&self, token: &str) -> Result<(), String> {
        if self
            .recovery_busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("복구 저장 중에는 삭제할 수 없습니다.".into());
        }
        let _lease = RecoveryLease(self);
        let mut session = self.session.lock().map_err(error)?;
        let ticket = session
            .recovery
            .get(token)
            .ok_or("복구 목록이 만료됐습니다.")?;
        if ticket.legacy {
            return Err("이전 앱의 복구 원본은 삭제하지 않습니다.".into());
        }
        if read_head(&ticket.target)? != ticket.head {
            return Err("복구 사본이 갱신됐습니다. 원본을 보존합니다.".into());
        }
        ticket.target.check()?;
        #[cfg(unix)]
        {
            use std::os::{fd::AsRawFd, unix::ffi::OsStrExt};
            let name = std::ffi::CString::new(ticket.target.path.file_name().unwrap().as_bytes())
                .map_err(error)?;
            if unsafe { libc::unlinkat(ticket.target.directory.file.as_raw_fd(), name.as_ptr(), 0) }
                != 0
            {
                return Err(error(std::io::Error::last_os_error()));
            }
        }
        #[cfg(windows)]
        fs::remove_file(&ticket.target.path).map_err(error)?;
        session.recovery.remove(token);
        Ok(())
    }
    pub fn claim_recovery(
        self: &Arc<Self>,
        metadata: RecoveryMetadata,
        length: usize,
        magic: bool,
    ) -> Result<WriteJob, String> {
        if !magic
            || length < 8
            || length as u64 > MAX_BYTES
            || !valid_key(&metadata.key)
            || !valid_name(&metadata.name)
            || metadata.sequence == 0
            || metadata.sequence > MAX_SAFE
        {
            return Err("복구 데이터 또는 메타데이터가 올바르지 않습니다.".into());
        }
        if self
            .recovery_busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("다른 복구 작업이 진행 중입니다.".into());
        }
        let mut job = WriteJob {
            store: self.clone(),
            stage: None,
            token: String::new(),
            cancelled: Arc::new(AtomicBool::new(false)),
            kind: JobKind::Recovery {
                generation: metadata.generation,
                key: metadata.key.clone(),
            },
            prefix: vec![],
        };
        let session = self.session.lock().map_err(error)?;
        if metadata.generation != session.generation || metadata.key != session.key {
            return Err("복구 문서 세대가 만료됐습니다.".into());
        }
        job.cancelled = session.recovery_cancel.clone();
        drop(session);
        let records = self.scan()?;
        let existing = records.iter().find(|(_, h)| h.key == metadata.key);
        if existing.is_some_and(|(_, h)| metadata.sequence <= h.sequence) {
            return Err("복구 사본보다 오래된 저장 요청입니다.".into());
        }
        let others: u64 = records
            .iter()
            .filter(|(_, h)| h.key != metadata.key)
            .map(|(_, h)| h.size)
            .sum();
        if existing.is_none() && records.len() >= MAX_HEADS || others + length as u64 > MAX_TOTAL {
            return Err(
                "복구 한도(32개 / 합계 1 GiB)를 초과합니다. 기존 사본을 보존합니다.".into(),
            );
        }
        let head = Head {
            key: metadata.key,
            sequence: metadata.sequence,
            size: length as u64,
            name: metadata.name,
            at: now(),
        };
        let json = serde_json::to_vec(&head).map_err(error)?;
        if json.len() > 4096 {
            return Err("복구 헤더 한도를 초과합니다.".into());
        }
        job.prefix.extend_from_slice(ENVELOPE);
        job.prefix
            .extend_from_slice(&(json.len() as u32).to_le_bytes());
        job.prefix.extend_from_slice(&json);
        let target = match existing {
            Some((target, _)) => target.clone(),
            None => Target::new(&self.root.join(format!("{}.rprec", head.key)))?,
        };
        job.stage = Some(Stage::new(target)?);
        Ok(job)
    }
}
struct RecoveryLease<'a>(&'a Persistence);
impl Drop for RecoveryLease<'_> {
    fn drop(&mut self) {
        self.0.recovery_busy.store(false, Ordering::SeqCst);
    }
}
enum JobKind {
    Save(SaveTicket),
    Recovery { generation: u64, key: String },
}
pub struct WriteJob {
    store: Arc<Persistence>,
    stage: Option<Stage>,
    token: String,
    cancelled: Arc<AtomicBool>,
    kind: JobKind,
    prefix: Vec<u8>,
}
impl WriteJob {
    pub async fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.stage
            .as_mut()
            .ok_or("임시 파일 없음")?
            .write(&self.prefix, bytes, &self.cancelled)
            .await
    }
    pub fn commit(mut self) -> Result<Option<Receipt>, String> {
        let mut session = self.store.session.lock().map_err(error)?;
        if self.cancelled.load(Ordering::SeqCst) {
            return Err("저장을 취소했습니다.".into());
        }
        let (generation, key) = match &self.kind {
            JobKind::Save(ticket) => (ticket.generation, None),
            JobKind::Recovery { generation, key } => (*generation, Some(key)),
        };
        if generation != session.generation || key.is_some_and(|key| *key != session.key) {
            return Err("저장 문서 세대가 변경됐습니다.".into());
        }
        if matches!(self.kind, JobKind::Recovery { .. }) {
            self.store.root_directory.check()?;
        }
        let stage = self.stage.as_mut().ok_or("임시 파일 없음")?;
        stage.commit()?;
        let receipt = match &self.kind {
            JobKind::Save(ticket) => {
                if ticket.project {
                    // Keep the published file identity; reopening the path can adopt a later replacement.
                    session.binding = stage.file.as_ref().and_then(|file| {
                        Some(Target {
                            path: stage.target.path.clone(),
                            stamp: Some(metadata_stamp(file, &file.metadata().ok()?).ok()?),
                            content_digest: stage.content_digest,
                            directory: stage.target.directory.clone(),
                        })
                    });
                }
                Some(Receipt {
                    name: filename(&ticket.target.path),
                    generation: ticket.generation,
                    project: ticket.project,
                })
            }
            JobKind::Recovery { .. } => None,
        };
        drop(session);
        Ok(receipt)
    }
}
impl Drop for WriteJob {
    fn drop(&mut self) {
        match self.kind {
            JobKind::Save(_) => {
                if let Ok(mut session) = self.store.session.lock() {
                    session.writing.remove(&self.token);
                }
            }
            JobKind::Recovery { .. } => {
                self.store.recovery_busy.store(false, Ordering::SeqCst);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> (tempfile::TempDir, Arc<Persistence>) {
        let root = tempfile::tempdir().unwrap();
        let store =
            Persistence::new(&root.path().join("app"), &root.path().join("legacy")).unwrap();
        store.activate(1, "document-a".into(), None).unwrap();
        (root, store)
    }
    fn execute(job: WriteJob, bytes: &[u8]) -> Result<Option<Receipt>, String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut job = job;
            job.write(bytes).await?;
            job.commit()
        })
    }
    fn recovery(store: &Arc<Persistence>, sequence: u64, bytes: &[u8]) -> Result<(), String> {
        execute(
            store.claim_recovery(
                RecoveryMetadata {
                    generation: 1,
                    key: "document-a".into(),
                    sequence,
                    name: "복구 이름".into(),
                },
                bytes.len(),
                bytes.starts_with(PROJECT),
            )?,
            bytes,
        )
        .map(|_| ())
    }
    #[test]
    fn snapshot_staleness_and_legacy_are_preserved() {
        let (root, s) = store();
        recovery(&s, 1, b"RPAINT01first").unwrap();
        let entry = s.list().unwrap().entries.remove(0);
        recovery(&s, 2, b"RPAINT01latest").unwrap();
        assert!(s.recovery_read(&entry.token).is_err());
        assert!(s.clear(&entry.token).is_err());
        let entry = s.list().unwrap().entries.remove(0);
        assert_eq!(s.recovery_read(&entry.token).unwrap(), b"RPAINT01latest");
        fs::create_dir(root.path().join("legacy")).unwrap();
        let old = root.path().join("legacy/recovery.rpaint");
        fs::write(&old, b"RPAINT01oldQt").unwrap();
        fs::write(
            root.path().join("legacy/session.lock"),
            b"stale Qt crash lock",
        )
        .unwrap();
        let entry = s
            .list()
            .unwrap()
            .entries
            .into_iter()
            .find(|e| e.source == "legacy")
            .unwrap();
        assert_eq!(s.recovery_read(&entry.token).unwrap(), b"RPAINT01oldQt");
        assert!(s.clear(&entry.token).is_err());
        assert_eq!(fs::read(old).unwrap(), b"RPAINT01oldQt");
    }
    #[test]
    fn tickets_cancel_epoch_and_external_change_preserve_original() {
        let (root, s) = store();
        let path = root.path().join("drawing.rpaint");
        fs::write(&path, b"RPAINT01original").unwrap();
        let t = s.register_save(&path, 1, true).unwrap();
        let job = s.claim_save(&t.token, 10, true).unwrap();
        assert!(s.claim_save(&t.token, 10, true).is_err());
        s.cancel(&t.token).unwrap();
        assert!(execute(job, b"RPAINT01xx").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"RPAINT01original");
        let t = s.register_save(&path, 1, true).unwrap();
        let job = s.claim_save(&t.token, 10, true).unwrap();
        s.activate(2, "document-b".into(), None).unwrap();
        assert!(execute(job, b"RPAINT01xx").is_err());
        let t = s.register_save(&path, 2, true).unwrap();
        fs::write(&path, b"RPAINT01external").unwrap();
        assert!(s.claim_save(&t.token, 10, true).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"RPAINT01external");
    }
    #[test]
    fn content_fingerprint_rejects_metadata_collisions_at_claim_and_commit() {
        for at_commit in [false, true] {
            let (root, s) = store();
            let path = root.path().join("drawing.rpaint");
            fs::write(&path, b"RPAINT01original").unwrap();
            let ticket = s.register_save(&path, 1, true).unwrap();
            if at_commit {
                let mut job = s.claim_save(&ticket.token, 15, true).unwrap();
                fs::write(&path, b"RPAINT01external").unwrap();
                // Deterministically model a filesystem returning identical metadata:
                // retain the original digest while making metadata checks succeed.
                job.stage.as_mut().unwrap().target.stamp = stamp(&path).unwrap();
                assert!(execute(job, b"RPAINT01pending!").is_err());
            } else {
                fs::write(&path, b"RPAINT01external").unwrap();
                s.session
                    .lock()
                    .unwrap()
                    .saves
                    .get_mut(&ticket.token)
                    .unwrap()
                    .target
                    .stamp = stamp(&path).unwrap();
                assert!(s.claim_save(&ticket.token, 15, true).is_err());
            }
            assert_eq!(fs::read(&path).unwrap(), b"RPAINT01external");
            assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
        }
    }
    #[test]
    fn opened_content_digest_survives_activation_and_later_save() {
        for before_activation in [false, true] {
            let (root, s) = store();
            let path = root.path().join("drawing.rpaint");
            fs::write(&path, b"RPAINT01original").unwrap();
            let opened = s.register_open(&path).unwrap();
            assert_eq!(
                s.read_selected(&opened.token).unwrap(),
                b"RPAINT01original"
            );
            if before_activation {
                fs::write(&path, b"RPAINT01external").unwrap();
                s.session
                    .lock()
                    .unwrap()
                    .reads
                    .get_mut(&opened.token)
                    .unwrap()
                    .target
                    .stamp = stamp(&path).unwrap();
                assert!(s.activate(2, "opened".into(), Some(opened.token)).is_err());
            } else {
                s.activate(2, "opened".into(), Some(opened.token))
                    .unwrap();
                fs::write(&path, b"RPAINT01external").unwrap();
                s.session.lock().unwrap().binding.as_mut().unwrap().stamp = stamp(&path).unwrap();
                let next = s.existing_save(2, true, false).unwrap().unwrap();
                assert!(s.claim_save(&next.token, 15, true).is_err());
            }
            assert_eq!(fs::read(&path).unwrap(), b"RPAINT01external");
        }
    }
    #[test]
    fn published_content_digest_rejects_later_same_metadata_change() {
        let (root, s) = store();
        let path = root.path().join("drawing.rpaint");
        let ticket = s.register_save(&path, 1, true).unwrap();
        execute(
            s.claim_save(&ticket.token, 15, true).unwrap(),
            b"RPAINT01original",
        )
        .unwrap();
        let expected: [u8; 32] = Sha256::digest(b"RPAINT01original").into();
        assert_eq!(
            s.session.lock().unwrap().binding.as_ref().unwrap().content_digest,
            Some(expected)
        );
        fs::write(&path, b"RPAINT01external").unwrap();
        s.session.lock().unwrap().binding.as_mut().unwrap().stamp = stamp(&path).unwrap();
        let next = s.existing_save(1, true, false).unwrap().unwrap();
        assert!(s.claim_save(&next.token, 15, true).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"RPAINT01external");
    }
    #[test]
    fn content_fingerprint_is_bounded_and_handles_empty_files() {
        let (root, s) = store();
        let path = root.path().join("drawing.rpaint");
        let file = File::create(&path).unwrap();
        file.set_len(MAX_BYTES + 1).unwrap();
        drop(file);
        assert!(s.register_save(&path, 1, true).is_err());
        assert_eq!(fs::metadata(&path).unwrap().len(), MAX_BYTES + 1);
        fs::write(&path, []).unwrap();
        let ticket = s.register_save(&path, 1, true).unwrap();
        execute(
            s.claim_save(&ticket.token, 15, true).unwrap(),
            b"RPAINT01original",
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"RPAINT01original");
    }
    #[test]
    fn staged_digest_includes_prefix_and_payload() {
        let root = tempfile::tempdir().unwrap();
        let mut stage = Stage::new(Target::new(&root.path().join("test.rprec")).unwrap()).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime
            .block_on(stage.write(b"prefix", b"payload", &AtomicBool::new(false)))
            .unwrap();
        let expected: [u8; 32] = Sha256::digest(b"prefixpayload").into();
        assert_eq!(stage.content_digest, Some(expected));
    }
    #[test]
    fn saved_binding_preserves_a_file_replaced_after_commit() {
        for existing in [false, true] {
            let (root, s) = store();
            let path = root.path().join("drawing.rpaint");
            if existing {
                fs::write(&path, b"RPAINT01original").unwrap();
            }
            let replacement = root.path().join("external.rpaint");
            fs::write(&replacement, b"RPAINT01external-user-edit").unwrap();
            let expected = stamp(&replacement).unwrap();
            let ticket = s.register_save(&path, 1, true).unwrap();
            let mut job = s.claim_save(&ticket.token, 13, true).unwrap();
            let target = path.clone();
            // Model another writer between our atomic publication and binding capture.
            job.stage.as_mut().unwrap().after_commit = Some(Box::new(move || {
                fs::rename(replacement, target).unwrap();
            }));
            let receipt = execute(job, b"RPAINT01first").unwrap().unwrap();
            assert_eq!(receipt.name, "drawing.rpaint");
            assert_eq!(receipt.generation, 1);
            assert!(receipt.project);
            let after = stamp(&path).unwrap();
            assert_eq!(after.as_ref().unwrap().identity, expected.unwrap().identity);
            let next = s.existing_save(1, true, false).unwrap().unwrap();
            assert!(s.claim_save(&next.token, 14, true).is_err());
            assert_eq!(stamp(&path).unwrap(), after);
            assert_eq!(fs::read(&path).unwrap(), b"RPAINT01external-user-edit");
            assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
        }
    }
    #[test]
    fn repeated_project_save_tracks_the_file_we_published() {
        let (root, s) = store();
        let path = root.path().join("drawing.rpaint");
        let mut ticket = s.register_save(&path, 1, true).unwrap();
        for bytes in [b"RPAINT01first".as_slice(), b"RPAINT01second"] {
            execute(
                s.claim_save(&ticket.token, bytes.len(), true).unwrap(),
                bytes,
            )
            .unwrap();
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert_eq!(
                s.session.lock().unwrap().binding.as_ref().unwrap().stamp,
                stamp(&path).unwrap()
            );
            ticket = s.existing_save(1, true, false).unwrap().unwrap();
        }
    }
    #[test]
    fn partial_replacement_failure_retains_staged_bytes() {
        use std::io::Write;
        for code in [1176, 1177] {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("drawing.rpaint");
            fs::write(&path, b"RPAINT01original").unwrap();
            let mut stage = Stage::new(Target::new(&path).unwrap()).unwrap();
            let staged_path = stage.target.directory.path.join(&stage.name);
            let file = stage.file.as_mut().unwrap();
            file.write_all(b"RPAINT01recoverable").unwrap();
            file.sync_all().unwrap();
            // Model the documented outcomes; this does not inject an actual OS failure.
            let moved = root.path().join("moved-original.rpaint");
            if code == 1176 {
                fs::remove_file(&path).unwrap();
            } else {
                fs::rename(&path, &moved).unwrap();
            }
            let message = stage.replacement_error(std::io::Error::from_raw_os_error(code));
            assert!(stage.retain_on_failure);
            assert!(!stage.committed);
            assert!(message.contains(staged_path.to_str().unwrap()));
            assert!(message.contains("대상 파일이 이동되거나 사라졌을 수 있습니다"));
            drop(stage);
            assert!(!path.exists());
            assert_eq!(fs::read(&staged_path).unwrap(), b"RPAINT01recoverable");
            if code == 1177 {
                assert_eq!(fs::read(&moved).unwrap(), b"RPAINT01original");
            }
            // Cleanup is possible after Drop closes the retained file handle.
            fs::remove_file(staged_path).unwrap();
        }
    }
    #[test]
    fn ordinary_replacement_failure_still_removes_stage() {
        for code in [32, 1175] {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("drawing.rpaint");
            fs::write(&path, b"RPAINT01original").unwrap();
            let mut stage = Stage::new(Target::new(&path).unwrap()).unwrap();
            let staged_path = stage.target.directory.path.join(&stage.name);
            let failure = std::io::Error::from_raw_os_error(code);
            let expected = failure.to_string();
            assert_eq!(stage.replacement_error(failure), expected);
            assert!(!stage.retain_on_failure);
            assert!(!stage.committed);
            drop(stage);
            assert!(!staged_path.exists());
            assert_eq!(fs::read(&path).unwrap(), b"RPAINT01original");
        }
    }
    #[test]
    fn publication_keeps_the_staged_file_identity() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("drawing.rpaint");
        for existing in [false, true] {
            if existing {
                fs::write(&path, b"RPAINT01original").unwrap();
            }
            let mut stage = Stage::new(Target::new(&path).unwrap()).unwrap();
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime
                .block_on(stage.write(&[], b"RPAINT01published", &AtomicBool::new(false)))
                .unwrap();
            let file = stage.file.as_ref().unwrap();
            let identity = metadata_stamp(file, &file.metadata().unwrap())
                .unwrap()
                .identity;
            stage.commit().unwrap();
            let file = stage.file.as_ref().unwrap();
            let published = metadata_stamp(file, &file.metadata().unwrap()).unwrap();
            assert_eq!(published.identity, identity);
            assert_eq!(Some(published), stamp(&path).unwrap());
            assert_eq!(fs::read(&path).unwrap(), b"RPAINT01published");
            drop(stage);
            assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
        }
    }
    #[cfg(windows)]
    #[test]
    fn replacement_sharing_failure_preserves_original_and_removes_stage() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
        let (root, s) = store();
        let path = root.path().join("drawing.rpaint");
        fs::write(&path, b"RPAINT01original").unwrap();
        let ticket = s.register_save(&path, 1, true).unwrap();
        let job = s.claim_save(&ticket.token, 16, true).unwrap();
        // An external reader denies deletion/replacement, but permits validation reads.
        let locked = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&path)
            .unwrap();
        assert!(execute(job, b"RPAINT01blocked!").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"RPAINT01original");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
        drop(locked);
        let ticket = s.register_save(&path, 1, true).unwrap();
        execute(
            s.claim_save(&ticket.token, 15, true).unwrap(),
            b"RPAINT01retry!!",
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"RPAINT01retry!!");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
    }
    #[test]
    fn recovery_listing_replaces_previous_selection_tickets() {
        let (_root, s) = store();
        recovery(&s, 1, b"RPAINT01recovery").unwrap();
        let old = s.list().unwrap().entries.remove(0);
        let current = s.list().unwrap().entries.remove(0);
        assert_ne!(old.token, current.token);
        assert!(s.recovery_read(&old.token).is_err());
        assert!(s.clear(&old.token).is_err());
        assert_eq!(
            s.recovery_read(&current.token).unwrap(),
            b"RPAINT01recovery"
        );
        s.clear(&current.token).unwrap();
        assert!(s.list().unwrap().entries.is_empty());
    }
    #[test]
    fn binding_only_after_validated_activation_and_exports_do_not_hijack() {
        let (root, s) = store();
        let path = root.path().join("source.rpaint");
        fs::write(&path, b"RPAINT01source").unwrap();
        let open = s.register_open(&path).unwrap();
        assert!(
            s.activate(2, "document-b".into(), Some(open.token.clone()))
                .is_err()
        );
        s.read_selected(&open.token).unwrap();
        s.activate(2, "document-b".into(), Some(open.token))
            .unwrap();
        assert!(s.register_save(&path, 2, false).is_err());
        let export = root.path().join("picture.png");
        let t = s.register_save(&export, 2, false).unwrap();
        execute(s.claim_save(&t.token, 3, false).unwrap(), b"png").unwrap();
        let save = s.existing_save(2, true, false).unwrap().unwrap();
        assert_eq!(save.name, "source.rpaint");
        assert!(
            s.register_save(&s.root.join("oops.rpaint"), 2, true)
                .is_err()
        );
    }
    #[cfg(unix)]
    #[test]
    fn readonly_mode_identity_and_symlinks() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let (root, s) = store();
        let path = root.path().join("drawing.rpaint");
        fs::write(&path, b"RPAINT01original").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let t = s.register_save(&path, 1, true).unwrap();
        execute(s.claim_save(&t.token, 10, true).unwrap(), b"RPAINT01xx").unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o644
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        let t = s.register_save(&path, 1, true).unwrap();
        assert!(s.claim_save(&t.token, 10, true).is_err());
        let link = root.path().join("alias.rpaint");
        symlink(&path, &link).unwrap();
        assert!(s.register_open(&link).is_err());
        let before = Target::new(&path).unwrap();
        let replacement = root.path().join("replace");
        fs::write(&replacement, b"RPAINT01xx").unwrap();
        fs::rename(replacement, &path).unwrap();
        assert!(before.check().is_err());
    }
    #[test]
    fn recovery_quota_and_malformed_head_preserve() {
        let (_root, s) = store();
        recovery(&s, 1, b"RPAINT01first").unwrap();
        assert!(recovery(&s, 1, b"RPAINT01other").is_err());
        assert!(
            s.claim_recovery(
                RecoveryMetadata {
                    generation: 1,
                    key: "document-a".into(),
                    sequence: 2,
                    name: "x".into()
                },
                MAX_BYTES as usize + 1,
                true
            )
            .is_err()
        );
        let path = s.root.join("document-a.rprec");
        fs::write(&path, b"corrupt").unwrap();
        assert!(recovery(&s, 2, b"RPAINT01next").is_err());
        assert_eq!(fs::read(path).unwrap(), b"corrupt");
    }
    #[test]
    fn native_recovery_32_heads_and_replacement_exclusion() {
        let (_root, s) = store();
        for index in 0..32 {
            let key = format!("doc-{index}");
            s.activate(index + 2, key.clone(), None).unwrap();
            let bytes = b"RPAINT01snapshot";
            let job = s
                .claim_recovery(
                    RecoveryMetadata {
                        generation: index + 2,
                        key,
                        sequence: 1,
                        name: "head".into(),
                    },
                    bytes.len(),
                    true,
                )
                .unwrap();
            execute(job, bytes).unwrap();
        }
        assert_eq!(s.list().unwrap().entries.len(), 32);
        // Replacing the current key is permitted at the head limit.
        let bytes = b"RPAINT01replacement";
        execute(
            s.claim_recovery(
                RecoveryMetadata {
                    generation: 33,
                    key: "doc-31".into(),
                    sequence: 2,
                    name: "replacement".into(),
                },
                bytes.len(),
                true,
            )
            .unwrap(),
            bytes,
        )
        .unwrap();
        let last = s
            .list()
            .unwrap()
            .entries
            .into_iter()
            .find(|e| e.key == "doc-31")
            .unwrap();
        s.activate(34, "doc-32".into(), None).unwrap();
        assert!(
            s.claim_recovery(
                RecoveryMetadata {
                    generation: 34,
                    key: "doc-32".into(),
                    sequence: 1,
                    name: "over limit".into()
                },
                12,
                true
            )
            .is_err()
        );
        assert_eq!(s.list().unwrap().entries.len(), 32);
        assert_eq!(
            s.recovery_read(
                &s.list()
                    .unwrap()
                    .entries
                    .into_iter()
                    .find(|e| e.key == "doc-31")
                    .unwrap()
                    .token
            )
            .unwrap(),
            bytes
        );
        assert_eq!(last.sequence, 2);
    }
    #[test]
    fn aggregate_byte_boundary_excludes_replaced_key() {
        use std::io::Write;
        let (_root, s) = store();
        // Sparse payloads test actual on-disk envelope metadata without allocating 900 MiB.
        for index in 0..3 {
            let head = Head {
                key: format!("seed-{index}"),
                sequence: 1,
                size: MAX_BYTES,
                name: "quota fixture".into(),
                at: 1,
            };
            let json = serde_json::to_vec(&head).unwrap();
            let mut file = File::create(s.root.join(format!("{}.rprec", head.key))).unwrap();
            file.write_all(ENVELOPE).unwrap();
            file.write_all(&(json.len() as u32).to_le_bytes()).unwrap();
            file.write_all(&json).unwrap();
            file.write_all(PROJECT).unwrap();
            file.set_len(12 + json.len() as u64 + MAX_BYTES).unwrap();
        }
        let before = stamp(&s.root.join("seed-0.rprec")).unwrap();
        assert!(
            s.claim_recovery(
                RecoveryMetadata {
                    generation: 1,
                    key: "document-a".into(),
                    sequence: 1,
                    name: "one over".into()
                },
                124 * 1024 * 1024 + 1,
                true
            )
            .is_err()
        );
        assert_eq!(stamp(&s.root.join("seed-0.rprec")).unwrap(), before);
        let mut bytes = vec![0u8; 124 * 1024 * 1024];
        bytes[..8].copy_from_slice(PROJECT);
        execute(
            s.claim_recovery(
                RecoveryMetadata {
                    generation: 1,
                    key: "document-a".into(),
                    sequence: 1,
                    name: "exact quota".into(),
                },
                bytes.len(),
                true,
            )
            .unwrap(),
            &bytes,
        )
        .unwrap();
        drop(bytes);
        assert_eq!(
            s.scan().unwrap().iter().map(|(_, h)| h.size).sum::<u64>(),
            MAX_TOTAL
        );
        s.activate(2, "seed-0".into(), None).unwrap();
        let bytes = b"RPAINT01smaller";
        execute(
            s.claim_recovery(
                RecoveryMetadata {
                    generation: 2,
                    key: "seed-0".into(),
                    sequence: 2,
                    name: "replace own".into(),
                },
                bytes.len(),
                true,
            )
            .unwrap(),
            bytes,
        )
        .unwrap();
        assert!(s.scan().unwrap().iter().map(|(_, h)| h.size).sum::<u64>() < MAX_TOTAL);
    }
    #[test]
    fn recovery_epoch_and_postwrite_cancel_preserve_original() {
        let (root, s) = store();
        recovery(&s, 1, b"RPAINT01original").unwrap();
        let mut job = s
            .claim_recovery(
                RecoveryMetadata {
                    generation: 1,
                    key: "document-a".into(),
                    sequence: 2,
                    name: "old epoch".into(),
                },
                12,
                true,
            )
            .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(job.write(b"RPAINT01late")).unwrap();
        s.activate(2, "document-b".into(), None).unwrap();
        assert!(job.commit().is_err());
        let entry = s.list().unwrap().entries.remove(0);
        assert_eq!(s.recovery_read(&entry.token).unwrap(), b"RPAINT01original");
        let path = root.path().join("saved.rpaint");
        fs::write(&path, b"RPAINT01original").unwrap();
        let t = s.register_save(&path, 2, true).unwrap();
        let mut job = s.claim_save(&t.token, 12, true).unwrap();
        runtime.block_on(job.write(b"RPAINT01late")).unwrap();
        s.cancel(&t.token).unwrap();
        assert!(job.commit().is_err());
        assert_eq!(fs::read(&path).unwrap(), b"RPAINT01original");
    }
    #[test]
    fn legacy_live_lock_blocks_but_crash_lock_is_readonly_importable() {
        let (root, s) = store();
        fs::create_dir(root.path().join("legacy")).unwrap();
        fs::write(root.path().join("legacy/recovery.rpaint"), b"RPAINT01Qt").unwrap();
        let path = root.path().join("legacy/session.lock");
        fs::write(&path, b"stale lock bytes").unwrap();
        let before = stamp(&path).unwrap();
        let live = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        fs2::FileExt::try_lock_exclusive(&live).unwrap();
        assert!(!s.list().unwrap().warnings.is_empty());
        drop(live);
        let entry = s.list().unwrap().entries.remove(0);
        assert_eq!(s.recovery_read(&entry.token).unwrap(), b"RPAINT01Qt");
        assert_eq!(stamp(&path).unwrap(), before);
        assert_eq!(fs::read(path).unwrap(), b"stale lock bytes");
    }
    #[cfg(unix)]
    #[test]
    fn same_size_mtime_replacement_and_parent_swap_are_detected() {
        use std::io::Write;
        use std::os::unix::fs::symlink;
        let (root, s) = store();
        let folder = root.path().join("chosen");
        fs::create_dir(&folder).unwrap();
        let path = folder.join("work.rpaint");
        fs::write(&path, b"RPAINT01original").unwrap();
        let target = Target::new(&path).unwrap();
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let replacement = folder.join("replacement");
        fs::write(&replacement, b"RPAINT01external").unwrap();
        File::options()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        fs::rename(replacement, &path).unwrap();
        assert!(target.check().is_err());
        let target = Target::new(&path).unwrap();
        let mut changed = File::options().write(true).open(&path).unwrap();
        changed.write_all(b"RPAINT01inplace!").unwrap();
        changed.set_modified(modified).unwrap();
        assert!(target.check().is_err());
        drop(changed);
        let t = s.register_save(&path, 1, true).unwrap();
        let job = s.claim_save(&t.token, 12, true).unwrap();
        let moved = root.path().join("moved");
        fs::rename(&folder, &moved).unwrap();
        let other = root.path().join("other");
        fs::create_dir(&other).unwrap();
        fs::write(other.join("work.rpaint"), b"external folder").unwrap();
        symlink(&other, &folder).unwrap();
        assert!(execute(job, b"RPAINT01late").is_err());
        assert_eq!(
            fs::read(other.join("work.rpaint")).unwrap(),
            b"external folder"
        );
        assert_eq!(fs::read_dir(moved).unwrap().count(), 1);
    }
    #[test]
    fn list_isolates_corruption_and_live_legacy_but_writes_fail_closed() {
        let (root, s) = store();
        recovery(&s, 1, b"RPAINT01good").unwrap();
        fs::write(s.root.join("damaged.rprec"), b"bad header").unwrap();
        fs::create_dir(root.path().join("legacy")).unwrap();
        fs::write(root.path().join("legacy/recovery.rpaint"), b"bad Qt backup").unwrap();
        fs::write(
            root.path()
                .join("legacy/recovery.rpaint.20261104-010101000"),
            b"RPAINT01goodQt",
        )
        .unwrap();
        let listing = s.list().unwrap();
        assert_eq!(listing.entries.len(), 2);
        assert_eq!(listing.warnings.len(), 2);
        let native = listing
            .entries
            .iter()
            .find(|e| e.source == "native")
            .unwrap();
        assert_eq!(s.recovery_read(&native.token).unwrap(), b"RPAINT01good");
        assert!(recovery(&s, 2, b"RPAINT01replacement").is_err());
        assert_eq!(s.recovery_read(&native.token).unwrap(), b"RPAINT01good");
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.path().join("legacy/session.lock"))
            .unwrap();
        fs2::FileExt::try_lock_exclusive(&lock).unwrap();
        let listing = s.list().unwrap();
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].source, "native");
        assert!(!listing.warnings.is_empty());
    }
    #[test]
    fn protected_legacy_names_are_case_insensitive() {
        let (root, s) = store();
        fs::create_dir(root.path().join("legacy")).unwrap();
        for name in [
            "RECOVERY.RPAINT",
            "Recovery.Rpaint.20261104-010101000",
            "SESSION.LOCK",
        ] {
            let path = root.path().join("legacy").join(name);
            fs::write(&path, b"RPAINT01original").unwrap();
            assert!(s.register_save(&path, 1, false).is_err());
            assert_eq!(fs::read(&path).unwrap(), b"RPAINT01original");
        }
        let path = root.path().join("legacy/RECOVERY.RPAINT");
        let opened = s.register_open(&path).unwrap();
        s.read_selected(&opened.token).unwrap();
        s.activate(2, "next-document".into(), Some(opened.token))
            .unwrap();
        assert!(s.existing_save(2, true, false).unwrap().is_none());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn deny_write_acl_preserves_original_and_removes_stage() {
        let (root, s) = store();
        let path = root.path().join("acl.rpaint");
        fs::write(&path, b"RPAINT01original").unwrap();
        let account =
            std::env::var("USER").expect("macOS ACL fixture needs the current account name");
        let result = std::process::Command::new("/bin/chmod")
            .args(["+a", &format!("user:{account} deny write")])
            .arg(&path)
            .status()
            .unwrap();
        assert!(result.success());
        let before = stamp(&path).unwrap();
        let ticket = s.register_save(&path, 1, true).unwrap();
        assert!(s.claim_save(&ticket.token, 12, true).is_err());
        assert_eq!(stamp(&path).unwrap(), before);
        assert_eq!(fs::read(&path).unwrap(), b"RPAINT01original");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
    }
}
