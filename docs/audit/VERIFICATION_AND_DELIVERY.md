# Studio 검증·빌드·배포 감사

2026-11-15 · Windows x64 · `48e4058`과 기존 복구·탭 작업 트리. 테스트 코드는 제품 보존 조건과 실패 관찰 방법을 확인했다. 실행 결과는 현재 작업 트리, 패키지 바이너리, 역사적 fixture의 범위를 각각 기록한다.

## 실행 결과

| 검사 | 결과와 범위 |
| --- | --- |
| Node 단위·계약 | `npm.cmd test` 359 통과. 모델·렌더 계산·형식·작업 경계의 단위 검증과 소스에서 추출한 일부 기능의 상태 비교가 포함된다. |
| 형식과 타입 | `npm.cmd run format:check`, `npm.cmd run check` 통과. 최근 Rust 패키지 빌드에서 fmt를 확인했다. 현 셸에 Cargo가 없어 Windows MSVC all-target Clippy를 새로 실행하지 못했다. 제한된 이전 GNU Clippy 결과는 [검증 대장](../CURRENT_STATUS.md)에 있다. |
| Node 독립 코어 fixture | 새 감사 경로에서 `test:core-fixtures`가 RPAINT01 fixture 6개(37,681,237 bytes)를 생성하고 `test:matched-core` 12개 업무가 픽셀·메타데이터·출력을 검증했다. 이번 실행의 Qt 교차 디코드 수는 0이다. |
| Python | Windows Python 3.12에서 43개 테스트 메서드를 실행했다. 권한으로 symlink/hardlink를 만드는 네 검증이 skip 처리됐고, `test_symlink_asset_directory_is_rejected`는 symlink 생성에서 `WinError 1314`로 1건 오류가 났다. 제품의 거부 검사에 도달하지 못했으므로 전체 통과로 세지 않는다. 별도의 권한이 있는 junction 실험은 아래에 기록했다. [staging 테스트](../../tests/test_stage_web.py#L133) · [build 테스트](../../tests/test_build_studio.py) |
| Vite·Python 정적 빌드 | `tools/build_studio.py`로 9개 파일·320,250 bytes, release `c5b242e55bd39c11df216452`를 산출했다. `tools/stage_web.py`로 격리한 로컬 사이트에서 `--check`와 실제 교체를 실행했다. staging 결과 320,844 bytes. |
| Windows NSIS | Windows SDK `rc.exe` 및 x64 MSVC 경로로 기존 빌드에 성공했다. 패키지 무결성, Rust 릴리스 테스트 29개와 바이너리를 `dist/windows-x64`에 보관했다. 이번 감사에서 동일 바이너리를 직접 실행했다. SHA-256 `199215c31a4c6d8aea55d0daba2d3cfcffc653f0faeabbbc0b182536bc9c3ca7`. [Windows 검증 대장](../CURRENT_STATUS.md#windows-x64-설치-패키지와-앱-실행-후속-검증) |
| 실제 WebView2 smoke | 실제 앱의 격리된 네 실행이 모두 성공했다. 복구 67,126,671 bytes의 왕복 픽셀, stale read/clear, legacy 보호, 오래된 generation, GIF 3종, 작업 중·미확정·저장 전 종료 취소, 최종 장면 21개 체크 중 기준 화면과 직접 비교한 14개 phase를 확인했다. 테스트 중 관측한 추정 캐시 피크는 64 tiles/84,312,616 bytes다. Chromium 창 클래스 해제 Error 1412가 종료 로그에 있었으며 각 프로세스는 성공 결과 및 종료 코드를 반환했다. [smoke 실행기](../../web-app/tests/native-desktop.mjs) |
| 실제 Windows 탭 수명 | 이전 패키지 검증의 동일 해시 바이너리에서 OS 열기·저장 대화상자, 탭 전환 이후 416픽셀 복구, 프로세스 강제 종료 뒤 프로젝트 round-trip 바이트, 바인딩 해제와 닫힌 키 쓰기 거부를 확인했다. [검증 대장](../CURRENT_STATUS.md#windows-x64-설치-패키지와-앱-실행-후속-검증) |

Windows 설치 마법사 전체, macOS `.app`/WKWebView 검수, 실기기 펜·터치 및 한글 IME 조합, 서명·공증, 공급망 감사는 이번 실행 범위 밖이다. Windows smoke의 타이밍은 API 반환까지다. OS 프레임 표시 시각과 여러 탭을 사용한 장기 RSS는 따로 측정한다. 정적 staging 사이트도 로컬 검증 범위다.

### Chrome 158 브라우저 회귀

현재 Vite 번들을 격리한 `/mypaint/`에서 GitHub Actions web matrix의 npm alias를 파일별 명령으로 펼쳤다. `&&`로 연결된 명령도 개별 실행했다. 44개 명령 중 13개 통과, 21개 비정상 종료, 10개 시간 상한에 도달했다. 로컬 Chrome 158.0.8127.37, 3개 병렬 lane, 파일마다 165초 상한이며 GitHub Actions 공식 실행과 시간·환경이 다르다. 로컬 원본은 `build-codebase-audit/chrome-ci-f161e5f4/summary.json`과 `logs/`에 있다.

| 분류 | 로그에서 확인한 범위 |
| --- | --- |
| 통과 | `concurrency`, `storage`, `fill-failure`, `native-recovery-flow`, `spray`, `shape-color`, `roundrect`, `eraser-settings`, `text-alpha`, `selection-resize`, `fill-key`, `eraser-picker`, `document-tabs`. 실제 IndexedDB 격리와 탭 회귀가 포함된다. |
| 이전 메뉴 locator | `editing`, `shear`, `usability`, `native-profile`, `render-preparation`, `export-preview`, `camera-viewport`, `selection-alpha`, `selection-preparation`, `selection-mask-failure`, `paste-transform`, `cut-key`, `clipboard`에서 현재 범주나 레이블을 열지 못했다. 같은 테스트의 다른 시나리오까지 통과했다는 의미는 아니다. |
| 확인한 제품 결함 | `native-persistence.mjs`의 IPC 대역이 창 종료 중 새 활성화와 `recovery_write` 호출을 관측했다. 저장 Picker 대역을 취소하자 원래 편집 중이던 textarea가 없어졌다. 비활성 탭 닫기 취소에서 미확정 문자·Redo가 바뀐 별도 재현과 같은 선행 전환을 확인했다. [종료 테스트](../../web-app/tests/native-persistence.mjs#L164) · [종료 처리](../../web-app/src/main.ts#L608) |
| 분리 재현할 픽셀 오류 | `browser` 팔레트 경로의 기대값, `bulk-edit`의 Redo 뒤 화면 digest, `pointer-contract`의 소유 획 색, `color-eraser`의 Canvas 픽셀 검사가 실패했다. 마지막 케이스의 저장 State 검사 자체는 통과했다. 서로 다른 렌더·픽셀·fixtures 조건을 비교해 원인을 확정한다. |
| 테스트 상태와 환경 | GIF 10개가 정확한 첫 프레임을 확인한 뒤 12탭 한도에 걸렸다. `recovery-contract`는 테스트 중 `response.body()`에서 종료해 현재 실행의 성공을 확인하지 못했다. `tiles`는 Windows `node_modules` symlink 생성에서 권한 오류가 났다. |
| 파일별 시간 상한 | `jpeg-orientation`, `touch-viewport`, `codec-reply`, `selection-mask`, `selection-crop`, `selection-source`, `masked-transform`, `square`, `pending`, `scene-contract`가 165초에서 중단됐다. `codec-reply`는 15개 시나리오 통과와 예전 메뉴 locator 실패를 일부 남겼으며, `pending`에도 예전 paste 메뉴 locator 실패가 기록됐다. JPEG는 방향 입력과 HTMLCanvas 전환 산출물이 있고, scene은 reference 빌드와 일부 프레임을 남겼다. 두 파일의 최종 검증 결과는 확인되지 않았다. |

수정 때는 메뉴 helper로 현재 범주를 열고, GIF 각 조건 사이에 탭을 정리하며, `response.body()` 실패 원인을 격리한다. 픽셀 실패는 동일 브라우저·DPR·asset을 두고 스크린샷과 저장 RGBA를 각각 비교한다. CI의 본래 시간 한도로 브라우저 lane을 실행하고 저장·종료 실패를 별도 제품 회귀로 고정한다.

## 테스트 코드와 검증 사각지대

`git ls-files` 기준 264개 파일, 현재 TypeScript 제품 소스 15개와 Rust 제품 파일 3개 및 빌드 스크립트 1개를 조사했다. HTML/CSS, Vite, Tauri 설정, GitHub Actions, Python 4개, 웹 테스트 파일 84개와 `web-app/tools` 3개를 실행 계약과 연결해 검토했다. 감사 전 소스·fixture·설정 146개의 입력 지문은 `c47b9b52949110b01826f0bee87dada4aaae7804e7366b7d96ef662f973416a7`이다. 경로와 파일 원본 SHA-256을 경로순 정렬해 탭으로 구분하고 줄바꿈으로 이은 뒤 다시 해시했다. Markdown, `docs/evidence`, PNG·TTF·ICO, 루트 `LICENSE`와 `assets/`는 지문 대상에서 제외했다.

| 테스트 영역 | 조사한 파일군과 관찰 대상 |
| --- | --- |
| 엔진 및 형식 Node | `core`, `history`, `metadata`, `pixel`, `composite`, `crop`, `square`, `color-eraser`, `color-eraser-qt`, `eraser`, `overlay`, `line-snap`, `decoder-boundaries`, `format-compat`, `gif-boundaries`, `nearest-bulk`, `nearest-qt`, `shear`, `polygon-mask`, `flood-key`, `selection-cut-transform`, `selection-preparation`, `selection-resize`, `settle-noop`, `codec-contract`, `profiles`의 `.test.ts`가 픽셀, 실패 상한, 상태·이력·코덱 메시지를 확인한다. 런타임과 다른 방식으로 소스 함수 본문을 추출하는 일부 검사는 배치 변경에도 깨질 수 있다. |
| 설정·경계 Node | `classic-skin`, `eraser-preferences`, `preferences-performance`, `document-tabs`, `native`, `recovery-store`, `platforms`, `fixture-inventory`의 `.test.ts`는 테마·설정, 호출 권한, DB 계약, 탭 수명, 플랫폼/fixtures를 확인한다. `native.test.ts` IPC 대역과 `native-harness.mjs`는 Rust 저장의 OS 권한·경합까지 검증하지 못한다. |
| 브라우저 기본·I/O | `browser`, `concurrency`, `editing`, `storage`, `shear`, `usability`, `fill-failure-contract`, `gif-input`, `jpeg-orientation`, `native-profile`, `native-persistence`, `native-recovery-flow`, `spray-contract`, `bulk-edit`, `render-preparation`, `eraser-settings`, `recovery-contract`, `codec-reply-contract`, `document-tabs`의 `.mjs`. 편집 결과·타이밍·DB·네이티브 대역과 변경된 메뉴 흐름을 다룬다. |
| 브라우저 입력·렌더·선택 | `pointer-contract`, `color-eraser-contract`, `shape-color-contract`, `roundrect-contract`, `export-preview-contract`, `touch-viewport-contract`, `camera-viewport-contract`, `selection-alpha-contract`, `text-alpha-contract`, `selection-preparation-contract`, `selection-resize-contract`, `selection-mask-contract`, `selection-crop-contract`, `selection-mask-failure`, `selection-source-contract`, `paste-transform-contract`, `masked-transform-contract`, `fill-key-contract`, `cut-key-contract`, `eraser-picker-contract`, `square-contract`, `clipboard-contract`, `pending-contract`, `tiles`, `scene-contract`의 `.mjs`. 픽셀·선택/문자 후보·장면 갱신·권한 모델을 다룬다. |
| 전용 검증·fixture | `matched-core.mjs`, `core-fixtures.mjs`, `max-document.mjs`, `performance.mjs`, `native-desktop.mjs`. 과거 Qt/WebAssembly 및 초기 코어에서 동결한 입력·픽셀 배열, 격리 브라우저 최대 문서, 시간, 실제 설치형 바이너리를 확인한다. fixture는 독립 기준값으로 소비된다. |
| 빌드 보조와 OS | `benchmark-composite.ts`, `desktop.mjs`, `scene-contract.mjs`, `build_studio.py`, `stage_web.py` 및 Python unittest 2개, GitHub Actions, Rust inline tests와 smoke. 작업 소유권/프로세스 정리, 설정 잠금·후보 배포, I/O 실패, WebView 범위를 확인한다. |

`menu`, `boot`, `instrument`, `save`, `snapshot` 등 동일 이름의 준비/대기 도우미가 여러 파일에 있다. 메뉴·대화상자 접근과 공통 단계의 진단은 공유할 수 있다. 직접 PNG를 해제하는 독립 oracle과 실제 WebView 결과 비교는 유지한다. `tests/native-harness.mjs`가 주입·추적 경로를 공유하는 기존 지점이므로 별도 브라우저 파일마다 비슷한 IPC 모형을 만들 필요가 없다. `tests/*.mjs`는 Prettier 검사 대상이지만 프로젝트의 `tsc include`에서 빠진다. ESLint/Python lint는 설정돼 있지 않다. 이름·들여쓰기는 해당 언어의 설정을 따르고, 테스트 코드에서 구조 변경에 민감한 정확한 문자열 추출을 줄인다. [패키지 스크립트](../../web-app/package.json) · [TS 설정](../../web-app/tsconfig.json) · [프로젝트 지침](../../AGENTS.md)

### 전용 검사와 역사적 수치

- `test:max-document`는 별도 Node 자식에서 8192×4096·2레이어(원본 256 MiB)의 브러시, 개별 편집·Undo/Redo·취소·크기 변경의 상태와 endpoint 메모리를 확인한다. `PAINT_MAX_DOCUMENT_OUTPUT`을 새 경로로 지정한다. 브라우저 UI·Worker·WebView 메모리는 별도다. [검사](../../web-app/tests/max-document.mjs) · [2026-11-04 기록](../evidence/studio-max-document.json)
- `test:performance`는 고정 샘플 수에서 Node 코어와 production Chromium·Worker 흐름을 관측한다. `PAINT_BENCH_SKIP_BROWSER=1`과 `PAINT_BENCH_BROWSER_ONLY=1` 중 하나를 쓰거나 전체를 사용한다. `PAINT_PERFORMANCE_OUTPUT`을 격리하고, 브라우저 단계에는 `PAINT_TEST_URL`을 지정한다. 물리 입력에서 모니터에 표시되기까지의 지연이나 장기 RSS 측정은 별도다. [검사](../../web-app/tests/performance.mjs) · [2026-11-04 기록](../evidence/studio-performance.json)
- `node --import tsx tools/benchmark-composite.ts`는 1024²·2레이어에서 네 알파 분포의 독립 baseline과 현 합성 pixels를 비교하고 5회 warmup 및 21회 교대 샘플을 출력한다. 현재 host의 UI 체감 수치로 사용하지 않는다. [벤치](../../web-app/tools/benchmark-composite.ts) · [2026-11-08 결과](../evidence/composite-refactor-20261108.json)
- `test:scene-contract`는 production 후보와 캐시 재사용을 우회한 별도 reference 번들을 구성해 DPR 1·2의 56개 장면과 12개 저장 상태를 비교한다. 일부 픽셀 렌더 경로를 공유해 해당 cache 변경을 검증한다. reference용 소스 exact-string 수정은 클래스 이동에 취약하므로 상태 추출 때 좁은 테스트 seam으로 옮긴다. `PAINT_TEST_URL`, `PAINT_SCENE_RUN_OUTPUT`을 준비한다. [실행기](../../web-app/tools/scene-contract.mjs) · [2026-11-04 장면 기록](../evidence/studio-scene-integration.json)
- 과거 `studio-matched-core.json`에는 2026-11-06 Qt/Node의 12개 항목과 세 파일의 양방향 검증이 있다. 현재 frozen fixture의 입력과 출처로 사용한다. CI가 자동 실행하는 전용 검사는 위 항목 중 `test:scene-contract`다. 데스크톱 CI는 fmt·Clippy·테스트·패키지 빌드까지이며 `test:native-desktop`은 별도 실행한다. [역사적 코어 비교](../evidence/studio-matched-core.json) · [CI](../../.github/workflows/studio.yml)

## 배포 도구의 소유권과 발견 사항

`buildStudio`가 Vite 출력과 manifest 입력 검증, 후보 디렉터리와 lock을 소유한다. `stageBundle`은 사용자가 지정한 별도 로컬 사이트에서 이전 release와 새 파일을 검증하고 복사·교체한다. 두 도구 모두 stale lock을 자동 무시하기보다 후보·이전 출력 복원 경로를 갖고 있으며 테스트가 교체 실패와 재시도를 관찰한다. 동시에 진행할 lock 소유권과 롤백 복원 대상은 각 도구에 남긴다. [빌드](../../tools/build_studio.py#L32) · [stage](../../tools/stage_web.py#L116)

| 우선순위 · 비용 | 재현 또는 코드 근거 | 수정과 인수 |
| --- | --- | --- |
| P2 · M | `readManifest`가 각 파일의 `read_bytes()`로 해시를 계산한 뒤 stage에서 총량을 제한한다. 개별 파일과 목록이 제한 안에 있어도 합계 과대 시 본문 읽기와 할당을 먼저 반복한다. [manifest](../../tools/stage_web.py#L18) · [총량](../../tools/stage_web.py#L155) | 경로와 메타데이터 preflight에서 예상 합계를 계산하고 해시는 제한 단위 스트림으로 처리한다. 기존 digest/manifest JSON과 실패 복구를 유지한다. |
| P2 · M | Windows에서 격리한 `assets` junction을 동일 scratch 내 다른 디렉터리로 연결했다. Python 3.12에서 `is_junction()`은 true이고 `is_symlink()`는 false였으며 `readBundle`이 받아들였다. 파일을 덮어쓰는 실행은 하지 않았다. [경로 검증](../../tools/stage_web.py#L36) | 지정 root와 각 상대 경로 성분에 junction/reparse 검사와 판정 시점 검증을 적용한다. 일반 Windows 디렉터리, symlink, junction, hardlink와 후보 경로 교체를 테스트한다. |
| P2 · M | 같은 로컬 bundle에서 상대 script와 일반 HTML은 통과했고 외부 `<script src>`는 차단됐다. 외부 `<img>`, iframe, CSS `@import`가 포함된 격리 fixture는 validation을 통과했다. 검증기 범위가 `script`·`link`에 집중돼 있다. URL은 `example.invalid`를 쓴 파일 입력으로 실제 전송은 발생하지 않았다. [HTML 검사](../../tools/stage_web.py#L57) | 빌드 자원 graph와 HTML/CSS 실행 가능 경로를 정책에 맞춰 소유한다. 의도한 범위와 경로, `srcset`, CSS `url`·`@import`, 정상 `/mypaint/`와 실제 브라우저 요청 목록을 검증한다. |
| P3 · S | `readBundle`과 `stageBundle`의 `<head>`/`<base>` 검사가 겹치고, Studio만 허용한 뒤 항상 참인 target 분기가 있다. `BundleHtml`은 link rel 파싱을 반복한다. [bundle](../../tools/stage_web.py#L81) · [stage](../../tools/stage_web.py#L116) | 파서가 보고한 유효성 사실을 변환 경계에서 재사용하고, 실패 시점과 승인한 파일 집합을 기존 fixture에 고정한다. 개별 문장마다 헬퍼를 추가하는 방식은 소유 흐름을 읽기 어렵게 한다. |
| P2 · M | CI matrix는 npm alias별 실패를 계속 집계한다. 같은 alias의 `&&` 뒤에 있는 파일은 앞 파일 실패 시 시작하지 않는다. 렌더 lane은 자체 참조 번들 빌드와 타일·장면 검사를 25분 job에서 실행한다. [CI](../../.github/workflows/studio.yml#L13) · [alias](../../web-app/package.json#L13) | 첫 실패 이후 관찰이 필요한 계약은 각각 실행하고 로그와 첫 실패 장면을 보관한다. 픽셀 파리티 오류, 키/준비 실패, locator 오류, timeout을 구분해 안정화한다. Windows 전용 fixture 인코딩과 Rust 작업 실패를 초기에 전파하는 현재 CI 흐름을 유지한다. |

## 문서·라이선스·레거시

현재 인수표의 상대 링크 20개와 보관 성능 문서의 상대 링크 1개가 원래 로컬 `build-web-work/` 산출물을 가리켜 이 체크아웃에 존재하지 않는다. 이전 untracked 감사 메모에는 Qt 제거 커밋 이후 유효하지 않은 소스 링크가 27개 있다. 기존 기록을 날짜와 함께 보존하고, 현재 인수표의 근거는 저장소 내부 fixture/증거 또는 실제 실행 명령으로 고친다. 삭제된 Qt 원본과 fixture 생성기는 Git 이력에서 확인할 수 있다. 새 작업자가 빌드할 수 없는 `matched_core_probe` CMake 안내와 삭제된 사각형 oracle 링크는 역사 레퍼런스로 표시한다. [인수표](../STUDIO_ACCEPTANCE_MATRIX.md) · [보관 기록](../archive/STUDIO_MAX_DOCUMENT.md) · [matched-core fixture 안내](../../web-app/tests/fixtures/matched-core-README.md) · [사각형 fixture 안내](../../web-app/tests/fixtures/square-README.md)

Qt 출처를 명시한 JSON 기준값을 기존 Node·브라우저 테스트가 읽으므로 데이터는 현재 검증의 입력이다. `assets/fonts`의 NanumGothic은 현재 `src`와 9개 정적 출력에 참조가 없지만 라이선스 고지가 남아 있다. `licenses/`의 GPL/LGPL 텍스트와 OFL은 보관 근거를 확인하며 정비한다. 현재 정적 runtime notice와 native 정확 버전 고지 완료 여부는 별도 항목이다. [제3자 고지](../../NOTICE.md) · [정적 runtime 고지](../../web-app/public/THIRD_PARTY_NOTICES.txt) · [Qt 제거 기록](../LEGACY_REMOVAL.md)

## 재현 명령

Windows에서 프로젝트에 현재 의존성, Python, OS SDK/도구체인이 있어야 한다. `npm`과 Cargo는 아래 해당 디렉터리에서 실행한다. `PAINT_TEST_URL`은 이미 로컬에 준비한 `/mypaint/` 주소다. native smoke에는 패키지에서 추출한 현재 앱 또는 동일 커밋을 로컬에서 빌드한 exe를 지정한다.

```powershell
# 저장소 루트
$auditRoot = Join-Path $env:TEMP ('mypaint-audit-' + [guid]::NewGuid().ToString('N'))
$auditSite = Join-Path $auditRoot 'site'
New-Item -ItemType Directory -Path $auditSite -Force | Out-Null
git -C $auditSite init -q
python -m unittest discover -s tests
python tools/build_studio.py
python tools/stage_web.py dist/studio $auditSite --check

# web-app
Set-Location web-app
npm.cmd test
npm.cmd run format:check
npm.cmd run check
$env:PAINT_CORE_FIXTURES_DIR = Join-Path $auditRoot 'fixtures'
$env:PAINT_MATCHED_CORE_OUTPUT = Join-Path $auditRoot 'matched'
npm.cmd run test:core-fixtures
npm.cmd run test:matched-core
$env:PAINT_DESKTOP_BINARY = (Resolve-Path '../dist/windows-x64/mypaint-desktop.exe').Path
$env:PAINT_NATIVE_DESKTOP_OUTPUT = Join-Path $auditRoot 'windows-smoke.json'
npm.cmd run test:native-desktop
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

배포 요건과 역사적 인수의 기준 날짜는 [웹 빌드](../WEB_BUILD.md), [검증 대장](../CURRENT_STATUS.md)과 [상위 보고서](../STUDIO_CODEBASE_REAUDIT.md)를 찾는다.
