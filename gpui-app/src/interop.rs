//! Isolated file-format and recovery probe for installed binaries.
use crate::{
    engine::{MAX_INPUT_BYTES, State},
    format,
    io::NativeIo,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{ffi::OsString, fs, io::Read, path::Path};

pub fn run(arguments: &[OsString]) -> Result<bool, String> {
    let [option, rest @ ..] = arguments else {
        return Ok(false);
    };
    if option != "--interop" {
        return Ok(false);
    }
    let result =
        match rest {
            [action, file] if action == "inspect" => fingerprint(&read_project(Path::new(file))?),
            [action, source, root] if action == "exercise" => {
                exercise(Path::new(source), Path::new(root))?
            }
            [action, root] if action == "recover" => recover(Path::new(root))?,
            _ => return Err(
                "--interop inspect FILE | exercise PROJECT NEW_DIRECTORY | recover TEST_DIRECTORY"
                    .into(),
            ),
        };
    println!("{result}");
    Ok(true)
}

fn exercise(source: &Path, root: &Path) -> Result<Value, String> {
    fs::create_dir(root).map_err(|e| format!("비교용 새 폴더를 만들 수 없습니다: {e}"))?;
    let native = NativeIo::new(&root.join("app"), &root.join("legacy"))?;
    let loaded = native.open_path(source)?;
    let token = loaded
        .source_token
        .ok_or("비교 입력은 .rpaint 프로젝트여야 합니다.")?;
    native.activate(1, "interop-original", Some(token), false)?;
    if !native.project_has_save_path(1)? {
        return Err("연 프로젝트에 저장 경로가 연결되지 않았습니다.".into());
    }
    let published = root.join("roundtrip.rpaint");
    native.save_project_path(&loaded.state, 1, &published)?;
    let reopened = read_project(&published)?;
    if reopened != loaded.state {
        return Err("프로젝트 왕복 값이 다릅니다.".into());
    }
    let original = fingerprint(&loaded.state);
    let mut edited = loaded.state;
    let active = edited.active;
    let pixel = &mut edited.pixels_mut(active)[..4];
    for (byte, delta) in pixel.iter_mut().zip([0x61, 0x33, 0x27, 0x81]) {
        *byte ^= delta;
    }
    native.snapshot(&edited, 1, "interop-original", 1, &loaded.name)?;
    native.activate(2, "interop-next", None, true)?;
    if native
        .snapshot(&edited, 1, "interop-original", 2, &loaded.name)
        .is_ok()
    {
        return Err("닫힌 탭의 복구 쓰기가 허용됐습니다.".into());
    }
    native.activate(3, "interop-original", None, false)?;
    if native.project_has_save_path(3)? {
        return Err("닫힌 탭에 이전 저장 경로가 남아 있습니다.".into());
    }
    Ok(json!({
        "operation": "exercise",
        "roundtripFile": published.to_string_lossy(),
        "original": original,
        "roundtrip": fingerprint(&reopened),
        "recoveryExpected": fingerprint(&edited),
        "closedSnapshotRejected": true,
        "closedSavePathReleased": true,
    }))
}

fn recover(root: &Path) -> Result<Value, String> {
    let native = NativeIo::new(&root.join("app"), &root.join("legacy"))?;
    let recovered = root.join("recovered.rpaint");
    if recovered.try_exists().map_err(|e| e.to_string())? {
        return Err("비교용 복구 결과가 이미 있습니다.".into());
    }
    let listing = native.list()?;
    let entry = listing
        .entries
        .iter()
        .find(|entry| entry.key == "interop-original" && entry.sequence == 1)
        .ok_or("프로세스를 다시 실행한 뒤 복구 사본을 찾을 수 없습니다.")?;
    let state = native.recover(&entry.token)?;
    native.activate(1, "interop-recovered", None, false)?;
    native.save_project_path(&state, 1, &recovered)?;
    if read_project(&recovered)? != state {
        return Err("복구 저장 뒤 프로젝트 값이 다릅니다.".into());
    }
    Ok(
        json!({ "operation": "recover", "file": recovered.to_string_lossy(), "recovered": fingerprint(&state) }),
    )
}

fn read_project(path: &Path) -> Result<State, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    let length = metadata.len();
    if !metadata.is_file() || length > MAX_INPUT_BYTES as u64 {
        return Err("비교 입력은 300 MiB 이하의 프로젝트 파일이어야 합니다.".into());
    }
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length as usize)
        .map_err(|e| e.to_string())?;
    file.take(length + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 != length {
        return Err("읽는 동안 파일 크기가 변경됐습니다.".into());
    }
    format::decode_project(&bytes)
}

fn fingerprint(state: &State) -> Value {
    json!({
        "width": state.width,
        "height": state.height,
        "active": state.active,
        "background": state.background,
        "layers": state.layers.iter().map(|layer| json!({
            "name": layer.name,
            "visible": layer.visible,
            "rgbaSha256": format!("{:x}", Sha256::digest(&layer.pixels[..])),
        })).collect::<Vec<_>>(),
    })
}
