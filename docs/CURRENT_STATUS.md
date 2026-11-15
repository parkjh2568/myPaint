# 현재 상태와 검증 범위

2026-11-15 기준. [인수인계](../PROJECT_HANDOFF.md) · [개발 문서](README.md)

## 확인된 최신 결과

| 영역 | 구현과 확인 범위 |
| --- | --- |
| Studio 웹·Tauri | 복구 DB 분리, 탭 이동 시 복구 예약, 닫힌 탭의 저장 경로 해제. Node 테스트 359개와 TypeScript·Vite 빌드 통과. |
| Tauri Windows | MSVC로 x64 NSIS를 빌드했다. 추출 앱과 이후 별도 비교 설치본에서 탭 전환 편집의 복구, 종료·재시작, 닫힌 탭의 저장 경로 해제를 확인했다. |
| GPUI Windows | 실제 설치본에서 Tauri가 만든 `.rpaint` 사본을 메뉴로 복원했다. PNG 투명·JPG 바탕색 미리보기와 한글 글리프 표시를 확인했다. 설정은 두 설치 프로세스에서 재시작 후 유지됐다. Rust 테스트 68개 통과. |
| Windows 공통 지연 | 동일한 합성 마우스 입력과 GDI 화면 읽기로 각각 30개 표본을 수집했다. 중앙값은 Tauri 24.33 ms, GPUI 20.19 ms이고 p95는 34.93 ms, 25.55 ms다. 폴링 대기가 포함된 한 번의 Windows 비교다. |

[GPUI 설치·검증 및 측정 근거](GPUI_WINDOWS_COMPARISON.md)

## 남아 있는 검증

- 최신 Windows IME 조합과 물리 펜 필압, 실물 두 손가락 제스처, macOS 앱은 미검증이다. GPUI의 Windows 포인터 및 조합 처리 내부 경로는 각각 자동 검사를 수행했다.
- Tauri 재감사에서 비활성 탭 닫기 취소가 현재 탭의 편집·Redo에 영향을 줄 수 있음을 재현했다. 열린 프로젝트 경로의 이미지 내보내기 충돌과 종료 취소도 인수할 항목으로 남겼다. [감사와 재현 순서](archive/STUDIO_CODEBASE_REAUDIT.md)
- 로컬 Windows 설치 파일은 미서명 테스트 빌드다. 제품 배포와 플랫폼 검증 기록은 아래 해당 실행 기준으로 본다.

## 2026-11-15 복구 저장소와 문서 탭 수명

Qt 제거가 반영된 `48e4058`에서 시작해 아래 복구 변경을 `04a2c5d`에 보존했다. 아래 기록은 당시 실행별 검증 환경을 포함한다.

- 새 브라우저 복구는 `mypaint-studio-recovery-v2`에 쓴다. 이전 웹 DB는 읽기 전용이며 사용자가 열어 검증한 사본을 새 DB에 복제한다. 같은 사본을 다시 열어도 동일한 복구 항목을 재사용한다. 손상된 head를 건너뛰어 정상 항목을 표시하고, 쓰기 한도를 검증할 수 없으면 기존 사본을 보존한다.
- 전환에 성공하면 이전 탭에 pending을 확정하고 그 탭의 revision을 복구 대기열에 넣는다. 쓰기 실패는 열린 비활성 탭도 재시도한다. 쓰기는 비동기이고 앱이 완료 전에 강제 종료되면 마지막 완료 사본부터 복구한다.
- 네이티브는 열린 탭의 키에 저장 대상을 귀속한다. 다음 활성화와 닫는 탭 해제를 함께 확정하며 닫힌 키의 늦은 저장·복구 쓰기를 거절한다. 이미 완료된 복구 파일은 유지한다. 활성화 실패와 일반 닫기 취소의 기존 회귀는 통과했으며, 비활성 탭을 대상으로 한 닫기 취소의 편집·이력 결함은 아래 재감사에서 확인했다. [탭 상세](DOCUMENT_TABS.md) · [저장 계약](STUDIO_NATIVE_PERSISTENCE.md)

### 이번 검증

| 검사 | Windows 로컬 결과 |
| --- | --- |
| Node 24 `npm test`, `npm run format:check`, `npm run build` | 단위 테스트 359개 통과. 포맷, TypeScript, Vite 빌드 통과. |
| Studio 빌드 및 staging | `tools/build_studio.py`, `/mypaint/` 정적 staging 검사 및 격리된 테스트 사이트 반영 통과. 테스트 release `c5b242e55bd39c11df216452`. |
| 실제 Chrome 158.0.8127.37 | `test:storage` 16개, `test:recovery-contract` 5개, `test:document-tabs` 통과. IndexedDB 격리를 실제 DB에서 검사했고, 설치형 경로 바인딩은 IPC 모형으로 검사했다. |
| Rust 1.94.0 저장 모듈 | 실제 Windows GNU 환경에서 같은 `persistence.rs`와 저장 의존성을 쓴 격리 테스트 26개 통과. 저장 경로를 가진 탭의 66회 열기·닫기, 닫기 직전 실패, 닫힌 탭의 늦은 쓰기와 비활성 탭 복구를 확인했다. Rustfmt와 저장 모듈 Clippy 검사 통과. |
| 전체 Tauri Windows GNU | `cargo check --offline --locked --all-targets --target x86_64-pc-windows-gnu`가 앱 빌드 스크립트까지 도달한 뒤 `windres`의 리소스 전처리 실패로 중단됐다. 전체 앱 컴파일과 설치 패키지 실행은 미검증이다. |
| Python 3.12 unittest | 43개 실행에서 건너뜀 4건과 오류 1건. 오류는 Windows 권한 1314로 staging 테스트의 디렉터리 심볼릭 링크를 만들지 못했다. |

기존 `test:browser`, shear, codec 일부 및 전체 native IPC 브라우저 suite에는 이 변경 전의 `48e4058`에서도 재현된 팔레트 픽셀 기대값이나 이전 메뉴·문자 선택자 문제가 있다. 복구·탭 회귀는 CI에서 개별 실행한다.

### Windows x64 설치 패키지와 앱 실행 후속 검증

- Visual Studio 2022 Build Tools 17.11.5의 x64 MSVC, Windows SDK 10.0.22621.0의 `rc.exe`, Rust 1.94.0으로 `x86_64-pc-windows-msvc` 릴리스와 NSIS 패키지를 빌드했다. 리소스 단계에서 `resource.lib`가 생성됐다. Tauri crate의 Windows MSVC 릴리스 테스트 29개와 패키지 무결성 검사도 통과했다. 결과는 로컬 `dist/windows-x64`의 설치 파일, `SHA256SUMS.txt`, `build-msvc.log`, `resource-compiler.log`, `nsis-integrity.log`, `test-msvc.log`에 있다.
- NSIS에서 추출한 실제 앱을 두 번 실행했다. WebView2 157.0.4341.46, 격리된 앱 저장소와 WebView 프로필, 실제 Windows 열기·저장 대화상자를 사용했다. 64×64 원본의 미확정 문자를 다른 탭으로 전환하자 이전 탭의 복구 파일에 416픽셀의 변화가 기록됐다. 쓰기 완료 뒤 프로세스를 강제 종료하고 앱을 다시 열어 복구 사본을 별도 `.rpaint`로 저장했다. 레이어·메타데이터와 모든 RGBA가 복구 사본과 일치했고 원본 파일 SHA-256도 일치했다. [WebView2 자동화 방식](https://playwright.dev/docs/webview2)
- 바인딩된 원본 탭을 닫은 뒤 옆 탭의 저장 경로 반환과 닫힌 세대의 늦은 복구 쓰기 거부를 확인했다. 닫힌 키를 새 세대에서 직접 재활성화했을 때 이전 경로 대신 새 Windows 저장 창이 열렸고 취소는 `null`을 반환했다. 기존 복구 파일 해시가 일치했다. 원본 실행 결과는 `dist/windows-x64/native-tabs-verification.json`에 있다.
- 이 결과는 로컬 미서명 패키지의 무결성과 추출한 앱의 동작 범위다. 실제 설치 마법사, 설치·제거 등록, macOS 런타임과 공개 배포는 별도 인수 항목이다.

### 코드베이스 재감사

2026-11-15 현재 작업 트리의 편집·저장·코덱·렌더·도구 경계를 다시 조사했다. Windows Chrome에서 수정된 비활성 탭 닫기 취소가 다른 탭의 미확정 편집을 확정하고 Redo를 잃는 경로를 확인했다. 현재 Node 359개와 추출한 Windows 앱의 복구·코덱·종료·렌더 smoke가 통과했다. 전체 브라우저 회귀의 실패와 플랫폼별 미검증은 [검증·배포 부록](archive/audit/VERIFICATION_AND_DELIVERY.md)에 남겼다. 안정화 순서는 [코드베이스 재감사](archive/STUDIO_CODEBASE_REAUDIT.md)에 있다.

## 2026-11-12 검증 기록

제품 기준 `d57fe5d`.

### 구현과 검증 구분

| 영역 | 구현 상태 | 현재 검증 및 한계 |
| --- | --- | --- |
| Classic 98 스킨 | 기존 구조를 유지한 CSS 외관 | 정적 빌드 통과, 최신 화면 실검수 미완료 |
| Qt 제거 | C++ 앱/CMake/Qt-Wasm/전용 CI 제거 | Studio 회귀 통과, 역사적 fixture 출처·데이터 보호 가드는 보존 |
| 투명 기본·지우개 | 독립 모드/색상, 단일·다층 일관 적용 | 엔진 알파·Undo/Redo 테스트 통과, 실제 PNG 내보내기는 미검수 |
| 메뉴·설정 | 6범주, 설정 텍스트와 좁은 화면 진입점 | Node 구조 검사 통과, 브라우저 실제 화면 미검수 |
| 문서 탭 | 문서 상태·이력·복구·저장 대상 분리, 닫기 확인 | Node 테스트 통과. Rust 저장 경로 테스트와 실제 OS 대화상자 미실행 |
| 지우개 전환 최적화 | 테마/전체 캔버스/전체 컨트롤 갱신 제거 | 모드 100회 전환의 불필요 렌더·테마 적용 0회, 같은 컬러휠 sync 100회에 raster 1회. 체감 ms는 미측정 |

### 당시 통합 검사 기록

메뉴/탭 통합 작업에서 Node **354개**, Python **43개**, 타입·포맷·Vite 빌드 통과가 보고되었습니다. 이 수치는 해당 커밋과 환경에 한정되며 네이티브 Rust/브라우저 검사를 합친 숫자가 아닙니다.

- Chromium 실행: `socket() failed: Operation not permitted`로 UI 회귀 미실행.
- Rust toolchain 부재로 새 네이티브 저장 경로 테스트 미실행.
- 연결 가능한 검증 호스트는 Linux였고 Mac은 offline, Windows 호스트는 없었습니다. 이는 당시 상태이므로 다음 세션에서 다시 확인하세요.
- 원격 CI status 목록은 당시 비어 있었습니다. 빈 목록은 통과가 아닙니다. 최신 SHA의 checks/actions를 다시 확인하세요.
- 과거 macOS 검수/CI 기록이 존재해도 이번 투명·탭·저장 경로 버전에 대한 보증이 아닙니다.

### 재현할 명령

`web-app/`에서 `npm ci`, `npm test`, `npm run check`, `npm run format:check`, `npm run build`를 실행합니다. tsx IPC 제한이 있는 Linux에서는 같은 테스트 파일을 `node --import tsx --test tests/*.test.ts`로 실행했던 이력이 있습니다. 환경 우회 성공과 원래 명령 성공을 구별해 기록하세요.

브라우저 사용 가능 환경에서는 `npm run test:eraser-settings`, `npm run test:document-tabs` 및 영향받은 전체 브라우저 계약을 실행합니다. 네이티브 테스트는 OS별 루트 안내와 저장 계약을 따릅니다. Python 검사 명령은 `python3 -m unittest discover -s tests`입니다.

### 성능 조사 스냅샷

메뉴/탭 도입 전 Linux/Node 코어 검사: 2048×2048의 100px 브러시 p95 1.50ms, 합성 76.4ms, 부드러운 resize 372ms, 프로젝트 인코딩 325ms. 8192×4096·2레이어 코어 검사도 통과했습니다. 별도 작업 실행 보고의 수치이며 이 문서는 원시 측정 파일을 포함하지 않습니다. 현재 UI 프레임·입력 지연·전체 RSS·플랫폼 성능이나 GPUI 비교 결과로 인용하지 마세요. 필요하면 동일 조건으로 다시 측정합니다.

## 남은 인수 체크리스트

- [ ] Windows 설치·제거 마법사와 macOS 패키지 빌드·실행
- [ ] OS 패키지의 외부 파일 변경 충돌, 실패 후 Redo 유지와 macOS 탭 A/B 저장 경로 분리
- [ ] 새 그림·열기·사진 삽입 구분, 최대 탭/메모리 경계, 반복 열기/닫기
- [ ] 모든 탭 미저장 종료 확인, 복구 사본 재열기
- [ ] PNG 투명 alpha, 지우개 미리보기/최종 픽셀, 테마 지속성
- [ ] 한글 IME, 펜, HiDPI, 작은 화면, 실제 사용자 반응 속도
- [ ] 최신 원격 CI 확인, 승인된 배포의 서명/공증 및 웹 자산 갱신

탭은 최대 12개이며 열기 시 보존 픽셀·이력+입력 합계 512 MiB 한도를 검사합니다. 전체 앱 RSS 한도가 아니고 탭 목록의 자동 재시작 복원도 구현되지 않았습니다. [탭 상세](DOCUMENT_TABS.md).
