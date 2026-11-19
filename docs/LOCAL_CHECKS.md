# 로컬 검사와 빌드

2026-11-16부터 이 브랜치는 테스트·빌드·패키징을 로컬에서 실행합니다. GitHub Actions 사용량을 줄이기 위해 `.github/workflows/studio.yml`을 제거했습니다. push·PR·수동 Actions 검사와 호스팅 OS 빌드 매트릭스는 제공하지 않습니다. 과거 CI 로그는 당시 커밋의 검증 근거로 보존하며 현재 통과 여부는 로컬 실행으로 기록합니다.

다른 브랜치와 GitHub 저장소 설정은 이번 변경 범위에 포함되지 않습니다. 이 변경은 커밋·푸시된 브랜치에 반영돼야 원격 실행 정의에서도 제거됩니다. 이미 실행 중인 작업은 GitHub 웹에서 별도로 취소합니다.

## 기본 검사

Node 24와 Python 3을 준비합니다. 저장소 루트에서 아래 명령을 한 줄씩 실행하고 실패 원인을 기록합니다. 최초 의존성 설치에는 인터넷이 필요합니다.

```sh
npm --prefix web-app ci --no-fund
npm --prefix web-app run format:check
npm --prefix web-app test
npm --prefix web-app run build
python3 -m unittest discover -s tests
```

Windows에서 Python 명령이 `py`라면 `python3` 대신 `py -3`을 사용합니다. 패키지 잠금 파일을 지우거나 실패 검사를 건너뛰어 통과로 기록하지 않습니다. 로컬 실행 로그에는 커밋·미커밋 변경 여부, OS·아키텍처, 도구 버전과 실행 명령을 함께 남깁니다.

## 브라우저 검사

기존 여섯 CI 그룹의 38개 npm 스크립트는 `web-app/tools/local-browser.mjs`로 옮겼습니다. 테스트 파일과 개별 `npm run test:...` 명령은 그대로 유지합니다. 기본 실행은 목록만 출력하며 브라우저 설치나 전체 검사를 자동으로 시작하지 않습니다.

`web-app/`에서 Chromium을 준비하고 정적 미리보기를 켭니다.

```sh
npx --no-install playwright install chromium
npm run build
npx --no-install vite preview --host 127.0.0.1 --port 8922 --strictPort
```

두 번째 터미널을 `web-app/`에서 열고 실행합니다.

macOS/Linux:

```sh
export PAINT_TEST_URL=http://127.0.0.1:8922/
npm run test:local-browser -- --list
npm run test:close-cancel
npm run test:document-tabs
npm run test:local-browser -- pending
```

Windows PowerShell:

```powershell
$env:PAINT_TEST_URL = "http://127.0.0.1:8922/"
npm run test:local-browser -- --list
npm run test:close-cancel
npm run test:document-tabs
npm run test:local-browser -- pending
```

| 그룹 | 검사 범위 |
| --- | --- |
| `core` | 기본 브라우저·사용성·채우기 실패·GIF/JPEG·네이티브 IPC/복구 모형·스프레이·일괄 편집·렌더 준비 |
| `drawing` | 포인터·색상/지우개·도형·둥근 사각형·내보내기·지우개 설정 |
| `viewport` | 터치·카메라·복구 계약·코덱 응답·알파 |
| `selection` | 선택 준비/크기/마스크/원천·변형·채우기·잘라내기·클립보드 |
| `pending` | 미확정 편집·문서 탭·닫기 취소·저장소 |
| `raster` | 타일과 최종 장면 |

`npm run test:local-browser -- all`은 모든 그룹을 순서대로 실행하는 무거운 로컬 검사입니다. 실패한 독립 스크립트 이후에도 나머지를 실행하고 하나라도 실패하면 종료 코드 1을 반환합니다. 복합 스크립트 내부는 기존 중단 동작을 유지합니다. 필요한 그룹을 선택해 실행하고 미실행 항목은 미검증으로 남깁니다. 종료 후 미리보기 서버는 Ctrl+C로 닫습니다.

## 정적 번들과 스테이징

기본 Python 검사는 번들·스테이징의 실패 경로를 포함합니다. `/mypaint/` 하위 경로의 실제 번들 검사는 저장소 루트에서 별도 임시 Git 저장소를 준비해 실행합니다.

```sh
python3 tools/build_studio.py
git init /tmp/mypaint-check-site
python3 tools/stage_web.py dist/studio /tmp/mypaint-check-site --check
python3 tools/stage_web.py dist/studio /tmp/mypaint-check-site
python3 -m http.server 8922 --bind 127.0.0.1 --directory /tmp/mypaint-check-site
```

`/tmp/mypaint-check-site`는 사용하지 않는 빈 테스트 경로로 바꿀 수 있습니다. Windows는 `$env:TEMP` 아래 별도 경로를 쓰고 Python 명령도 맞춥니다. 두 번째 터미널에서 `PAINT_TEST_URL`을 `http://127.0.0.1:8922/mypaint/`로 설정해 필요한 브라우저 그룹을 실행합니다. 실제 홈페이지 저장소·공개 배포·Git push는 이 절차에 포함되지 않습니다.

## 네이티브 검사와 패키징

지원 OS에서 저장소 루트 기준으로 실행합니다. Tauri는 Rust 1.94.0, GPUI는 Rust 1.100.0을 사용합니다. 필요한 도구는 해당 컴퓨터에 미리 설치합니다.

```sh
cargo +1.94.0 fmt --manifest-path web-app/src-tauri/Cargo.toml --check
cargo +1.94.0 clippy --manifest-path web-app/src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo +1.94.0 test --manifest-path web-app/src-tauri/Cargo.toml --all-targets --locked
cargo +1.100.0 fmt --manifest-path gpui-app/Cargo.toml --check
cargo +1.100.0 test --manifest-path gpui-app/Cargo.toml --all-targets --locked
```

Windows의 fixture 줄바꿈·바이트 검사도 `npm --prefix web-app run test:fixture-inventory`로 로컬 실행합니다. Tauri 설치 패키지는 해당 OS에서 `npm --prefix web-app run desktop:build`로, GPUI 릴리스는 `cargo +1.100.0 build --manifest-path gpui-app/Cargo.toml --release --locked`로 필요할 때만 만듭니다.

플랫폼 준비와 수동 인수는 [Windows 앱](../WINDOWS_APP_TEST.md)·[macOS 앱](../MACOS_APP_TEST.md), GPUI Windows 패키징·성능 계측은 [비교 보고서](GPUI_WINDOWS_COMPARISON.md)를 따릅니다. 설치·제거, 실제 OS 대화상자, IME·펜·터치, 서명·공증과 성능 측정은 별도 로컬 검증입니다. 한 OS의 결과를 다른 OS의 통과로 기록하지 않습니다.

## GitHub 웹에서 Actions 끄기

사용자가 직접 설정하는 절차이며 이 작업에서 저장소 설정을 변경하지 않았습니다.

1. 저장소의 **Settings → Actions → General**을 엽니다. myPaint는 [Actions 설정 화면](https://github.com/parkjh2568/myPaint/settings/actions)에서 접근합니다.
2. **Actions permissions**에서 **Disable actions**를 선택하고 **Save**를 누릅니다. 이 설정은 저장소 전체에 적용됩니다. [GitHub 공식 안내](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)
3. 진행 중인 실행은 **Actions → 실행 항목 → Cancel workflow**로 별도 취소합니다. [취소 안내](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/cancel-a-workflow-run)

특정 워크플로만 끄려면 **Actions → 해당 워크플로 → ⋯ → Disable workflow**를 선택합니다. [개별 비활성화 안내](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)


## 저장과 복구의 자원 계측

웹 빌드를 Vite preview로 로컬에 열고 아래 명령으로 합성 문서를 사용한다. 브라우저 프로세스 RSS 계측에는 macOS 또는 Linux의 `ps`가 필요하다.

```sh
PAINT_TEST_URL=http://127.0.0.1:8922/ npm --prefix web-app run test:resource-pipeline
TMPDIR=/private/tmp cargo +1.100.0 test --locked --manifest-path gpui-app/Cargo.toml profile_native_save_and_export -- --ignored --nocapture
```

웹 검사는 Chromium의 Worker, 실제 다운로드 파일, IndexedDB 스냅샷을 확인한다. RSS는 브라우저 전체의 샘플링 값이며 Worker나 Blob 단독 메모리와 UI 정지 시간을 대신하지 않는다. GPUI 테스트 명령은 파일 쓰기 시간과 다시 연 파일의 픽셀을 확인한다.

macOS에서는 실제 릴리스 앱의 프레임 간격도 측정할 수 있다. 매번 새 결과 경로를 사용한다.

```sh
profile_dir=$(mktemp -d /private/tmp/mypaint-gpui-frames.XXXXXX)
TMPDIR=/private/tmp cargo +1.100.0 run --release --locked --manifest-path gpui-app/Cargo.toml -- --persistence-root "$profile_dir/profile" --benchmark-io-result "$profile_dir/timings.json"
```

기본 실행은 합성 문서로 저장·내보내기를 측정한다. 실제 프로젝트 파일을 지정하면 미확정 편집 없음과 전체 선택 이동 상태를 각각 측정한다. 이 모드에서는 내보내기 미리보기도 별도 항목으로 기록하고, 저장한 프로젝트의 레이어와 PNG 합성 픽셀을 대조한다.

```sh
profile_dir=$(mktemp -d /private/tmp/mypaint-gpui-frames.XXXXXX)
gpui-app/target/release/mypaint-gpui --persistence-root "$profile_dir/profile" --benchmark-io-project /absolute/path/to/document.rpaint --benchmark-io-result "$profile_dir/timings.json"
```

계측 창은 완료 후 자동으로 닫힌다. 결과는 작업 핸들러 시간, 다음 GPUI 프레임 콜백까지의 시간, 완료를 처음 확인한 시점, 완료 직후 프레임까지 관측한 최장 간격을 기록한다. OS 파일 선택기와 디스플레이 주사 시간은 계측 범위 밖이다.
