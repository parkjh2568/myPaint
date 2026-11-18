# 프로젝트 작업 연혁과 결정 기록

작업 요약은 2026-11-16까지 갱신했습니다. 아래 전체 커밋 표는 2026-11-12의 `d57fe5d`까지 보존한 스냅샷입니다. [인수인계](../PROJECT_HANDOFF.md) · [현재 검증](CURRENT_STATUS.md).

2026-11-18에는 `eefda12` 위 로컬 작업 트리에서 레이어 이름·복구 목록·탭 포커스·웹 다운로드를 수정했습니다. [검증 및 미실행 범위](CURRENT_STATUS.md#2026-11-18-레이어-이름복구키보드다운로드)

## 범위와 읽는 법

단계별 요약과 기준 시점의 커밋 표를 함께 보존합니다. 이후 커밋은 `git log --all --date=iso --stat`로 확인합니다. 삭제된 브랜치·로컬에서만 존재한 중간 커밋·외부 세션의 모든 대화를 재현한다고 주장하지 않습니다. 이전 구현의 세부 실험은 [archive](archive/README.md)와 `evidence/`, 삭제 파일은 Git 이력이 근거입니다. 커밋 날짜는 Git에 기록된 날짜이며 실제 요청/로컬 작업 시작 시각과 다를 수 있습니다. 연결 앱으로 동일 트리를 게시한 단계에서는 로컬 커밋과 원격 커밋 SHA가 달랐습니다. 여기서는 원격 계보를 사용합니다.

## 단계별 히스토리

### 1. 초기 로컬 그림판 (10/30~11/04)

저장소 초기화 후 오프라인 Qt/C++ 데스크톱 앱과 개발 환경을 구성했습니다. 안정성 개선 및 WebAssembly 웹 경로가 추가되었습니다. 이 단계의 기술은 역사적 기록이며 현재 실행 안내가 아닙니다.

### 2. Qt-free Studio 및 안정화 (11/06~11/08)

같은 로컬 편집 흐름을 TypeScript 엔진/웹 UI와 Tauri/Rust 저장·창 경계로 옮겼습니다. 픽셀/알파/미확정 편집/복구·원자 저장의 계약과 독립 fixture를 마련했습니다. 합성 최적화, 외부 파일 변경 감지, 정확한 선 geometry, viewport와 screenshot 기반 테스트를 정비했습니다. macOS runner 변경과 브라우저 검사 병렬화도 이뤄졌습니다. PR #1이 `c4e8608`로 main에 병합되었습니다. 상세 증거의 날짜·바이너리 범위를 유지하며 제품 전체 출시 완료로 해석하지 않습니다.

### 3. Windows 98 외관 (11/11 요청, 원격 11/12)

사용자는 “현재 구조는 바꾸지 말고 Win98 그림판처럼 CSS와 룩앤필”을 요청했습니다. Classic 98 외관을 보강했고 원격 `cc5f099`에 게시했습니다. 당시 Node 337/Python 44·타입·포맷·빌드는 통과했으나 최신 실제 화면 검수는 환경 제약으로 수행하지 못했습니다.

### 4. 문서 정리 및 플랫폼 따라하기

중복 초기 계획 7개 제거, 과거 보고 23개 archive 이동, 루트 Windows/macOS 앱·웹 4개 한글 안내를 추가했습니다. 문서가 제품의 실제 상태와 혼동되지 않도록 실행 절차와 완료 증거를 분리했습니다.

### 5. Qt 제거와 GPUI 검토

사용자가 Qt 관련 내용을 걷어내고 Tauri/Rust 대 GPUI/Rust를 비교 요청했습니다. C++ GUI/CMake/Qt-Wasm/전용 생성기·CI 등 82개 경로를 제거하고 staging 도구를 Studio 전용으로 바꿨습니다. 픽셀 JSON 기준값·형식 호환·이전 사본/잠금 안전 가드는 보존했습니다.

**현재 추천은 Tauri 유지**입니다. 핵심 편집 엔진은 TypeScript, UI는 DOM/CSS이므로 GPUI는 껍데기 교체가 아닌 상당한 재작성입니다. Rust 중심 GPU UI의 이점 가능성은 있지만 myPaint에서 비교 측정하지 않았습니다. GPUI upstream에는 web backend도 있으므로 “웹 불가능”은 부정확합니다. 기존 웹 파일·클립보드·복구 경로는 별도 포팅 검증이 필요합니다. GPUI 전환을 실행한 적은 없습니다.

근거: [GPUI 예제](https://gpui.rs/examples/), [upstream README](https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md), [플랫폼 코드](https://github.com/zed-industries/zed/blob/main/crates/gpui_platform/src/gpui_platform.rs), [Tauri WebView](https://tauri.app/reference/webview-versions/). 최신 API/지원 현황은 전환 전에 다시 확인하세요.

### 6. 투명 배경·지우개·설정 발견성

기존 새 문서는 흰색이었고 지우개는 단일/다층에서 다르게 동작했습니다. 사용자 요청으로 시작/새 문서 투명, 우측 독립 지우개 모드·색상 저장, 레이어 수와 무관한 동작을 구현했습니다. 설정 텍스트와 좁은 화면 진입점도 추가했습니다. 기존 프로젝트 픽셀을 자동 변경하지 않는 것이 핵심 결정입니다. [상세](TRANSPARENT_ERASER.md).

### 7. 범주 메뉴·다중 그림 탭·지우개 전환 최적화

사용자 첨부 화면과 요청을 따라 파일/편집/이미지/레이어/설정/도움말로 묶었습니다. 문서별 상태·Undo/Redo·복구·뷰·저장 대상의 탭을 구현했고, Rust 저장 경로도 문서 key별 보존하도록 바꿨습니다. 전환 실패 시 pending/Redo를 보존하는 후속 수정을 `d57fe5d`에 반영했습니다. 탭 목록 자동 재시작 복원은 범위에 포함하지 않았습니다.

지우개 모드 전환 지연 조사에서 불필요한 전체 테마/캔버스/컨트롤 갱신을 확인해 제거했고 동일 컬러휠을 반복 그리지 않도록 했습니다. 계측상 작업 횟수 감소는 확인했지만 사용자 기기의 반응 속도 개선 ms는 아직 확인하지 못했습니다. [탭](DOCUMENT_TABS.md) · [성능](archive/PREFERENCES_PERFORMANCE.md).

### 8. 이번 인수인계 문서화

프로젝트 목적·소유권·이력·결정 이유·검증 한계·다음 작업을 한 시작점으로 모으고 README/AGENTS/문서 색인을 연결했습니다. 제품 코드는 바꾸지 않았습니다.

### 9. 웹 복구 격리와 탭 수명 정리 (11/15 작업 트리)

`48e4058`을 기반으로 복구 데이터를 Studio 전용 IndexedDB에 기록하게 했다. 이전 웹 DB는 처음 발견할 때 수정하지 않고, 사용자가 사본을 열어 프로젝트 검증을 통과하면 새 DB에 같은 bytes를 복제한다. 전환에서 확정한 편집은 떠난 탭의 복구 대상으로 예약한다. Rust는 열린 탭만 저장 바인딩을 보유하며 성공한 닫기 전환에서 이전 탭의 바인딩과 쓰기 권한을 해제한다. 앱이 보관한 복구 파일은 별도로 유지된다. [탭 동작](DOCUMENT_TABS.md) · [검증 대장](CURRENT_STATUS.md)

Windows GNU의 리소스 전처리 실패 이후 Visual Studio x64 MSVC와 Windows SDK 리소스 컴파일러로 전환해 NSIS 패키지를 빌드했다. 실제 패키지의 앱에서 탭 전환으로 확정한 편집을 강제 종료 후 복구하고, 닫힌 키의 늦은 쓰기 거부와 새 저장 경로 선택을 확인했다. [Windows 후속 검증](CURRENT_STATUS.md#windows-x64-설치-패키지와-앱-실행-후속-검증)

### 10. 현행 Studio 코드베이스 재감사 (11/15 작업 트리)

같은 작업 트리에서 제품 모듈, 저장 권한, 렌더링, 테스트 및 배포를 다시 검토했다. 현재 동작과 기존 파일·복구 계약을 보존하는 단계별 계획과 새 검증 범위를 문서화했다. 이번 감사의 변경은 문서에 한정한다. [재감사](archive/STUDIO_CODEBASE_REAUDIT.md)

### 11. Windows 복구와 GPUI 비교의 확정 기록 (11/15)

Tauri의 복구·문서 탭 변경은 `04a2c5d`에 보존했다. Windows에서 리소스 전처리 경로를 MSVC와 Windows SDK로 바꿔 NSIS를 빌드했고, 앱에서 탭 전환·닫기·재시작 복구를 실행했다. 원래 제품 경로는 TypeScript/Tauri다.

`codex/gpui-compare`의 `620584c`에 Rust/GPUI 비교판을 추가했다. `ea24e72`에서 Studio 화면과 내보내기 미리보기, 설정, 멀티터치를 이식했다. `f4e2095`에서는 실제 화면에서 확인한 SVG 색상 누락을 고치고, GPUI 메뉴로 Tauri 사본을 복원한 뒤 두 설치본의 동일한 Windows 클릭 위치와 GDI 화면 관측을 각각 30회 기록했다. [비교 및 원시 근거](GPUI_WINDOWS_COMPARISON.md)

### 12. 문서 통합과 브랜치 정리 (11/15)

실행, 상태, 이력, 계약 문서에서 중복 안내를 걷어내고 이전 감사와 실험을 [과거 기록](archive/README.md)으로 옮겼다. 검증 범위와 측정 환경은 기준 빌드별로 보존했다.

### 13. macOS에서 GPUI 작업 재개 준비 (11/16)

GitHub HEAD `6efb9d3`와 일치하는 로컬 `codex/gpui-compare`로 전환했습니다. Apple Silicon Mac에 Rust 1.100.0과 Metal Toolchain을 설치하고 GPUI 폴더의 로컬 도구 버전을 지정했습니다. GPUI 개발 빌드·전체 대상 컴파일·포맷, 웹 Node 359개·포맷·빌드, Python 43개가 통과했습니다. GPUI 테스트는 67개 통과, 공유 저장 모듈의 비활성 탭 복구 검사 1개 실패로 남았습니다. 제품 코드 변경 없이 작업 기준과 다음 조사 항목을 기록했습니다. [이번 검증 범위](CURRENT_STATUS.md#2026-11-16-macos-로컬-준비-검증)

### 14. GPUI 복구 테스트 수명 수정 (11/16)

준비 중 발견한 복구 테스트의 임시 디렉터리 조기 해제를 단독 실행으로 재현했습니다. 공유 저장 테스트에서 `TempDir`을 테스트 끝까지 유지하고 비활성 탭 쓰기의 복구 바이트 확인을 추가했습니다. GPUI 전체 68개, 웹 Node 359개, Python 43개와 포맷·웹 빌드가 통과했습니다. 추가 Tauri 검사는 복구 테스트를 포함해 30개 통과, 별도 macOS ACL 검사 1개 실패로 기록했습니다. 제품 저장 로직은 변경하지 않았습니다. [수정 후 검증 범위](CURRENT_STATUS.md#2026-11-16-gpui-복구-테스트-수정)

### 15. macOS ACL 테스트 조건 안정화 (11/16)

Tauri 단독 실패를 재현한 뒤, 사용자 ACL 설정 명령이 성공해도 실제 쓰기 거부가 성립하지 않는 경우를 GPUI 전체 검사에서도 확인했습니다. 공유 테스트를 `USER` 기반 사용자 ACL에서 `everyone deny write`로 바꾸고 OS 직접 쓰기가 거부되는지 먼저 검증했습니다. Tauri 31개·GPUI 68개 전체 테스트가 통과했고 `USER` 제거 상태에서 두 ACL 검사를 각각 20회 반복해 통과했습니다. Node 359개·Python 43개, Rust·웹 포맷과 웹 빌드도 통과했습니다. 제품 저장 로직은 변경하지 않았고 macOS 내부의 간헐적 사용자 ACL 적용 원인은 미확정으로 기록했습니다. [최종 검증과 한계](CURRENT_STATUS.md#2026-11-16-macos-acl-테스트-안정화)

### 16. 닫기·종료 취소와 열린 프로젝트 보호 (11/16)

`21ea74f`를 기반으로 비활성 탭 닫기와 전체 종료의 암묵적 탭 전환을 제거했습니다. 프로젝트 저장은 열린 대상 문서 세대로 수행하고, 비활성 닫기는 현재 키를 바꾸지 않고 해당 문서만 해제합니다. GPUI의 저장 확인도 대상 탭을 직접 저장합니다. 공유 Rust 저장소는 이미지 저장 대상을 모든 열린 프로젝트의 경로·파일 identity와 선택·claim·commit에서 비교합니다. macOS에서 Tauri 33개·GPUI 71개·Node 362개·Python 43개, 새 Chromium UI 14개와 기존 탭 회귀가 통과했습니다. 실제 OS 선택기·Windows·GPUI GUI 검수는 남았습니다. [최신 검증](CURRENT_STATUS.md#2026-11-16-닫기종료-취소와-내보내기-충돌-수정)

### 17. Actions 검사 제거와 로컬 실행 전환 (11/16)

GitHub Actions 리소스 절약 요청에 따라 `a8a3eca` 이후 현재 브랜치의 `studio.yml`을 제거했습니다. 브라우저 6그룹·38개 스크립트는 수동 로컬 그룹 실행기로 옮겼고 Node·Python·네이티브 검사·OS 패키징 절차도 로컬 안내로 모았습니다. 과거 CI 기록은 보존했습니다. 저장소 설정과 다른 브랜치는 변경하지 않았으며 웹에서 Actions를 끄는 절차를 안내했습니다. [로컬 검사](LOCAL_CHECKS.md)

전환 후 Node 362개·Python 43개, 포맷·웹 빌드가 로컬에서 통과했습니다. 그룹 목록 보존과 실행기의 오류 전파도 검사했으며, 전체 브라우저·네이티브 회귀를 새로 실행한 결과로 세지 않았습니다.

## 전체 커밋 목록 (2026-11-12 기준까지 도달 가능한 계보)

| 커밋 | Git 날짜 | 원래 커밋 제목 |
| --- | --- | --- |
| [cbd5b34](https://github.com/parkjh2568/myPaint/commit/cbd5b346d26f1699f0c9937150beec1bc5f0e0bd) | 2026-10-30 | chore: initialize myPaint repository |
| [942eb16](https://github.com/parkjh2568/myPaint/commit/942eb163ad369588962a905945f1cbe42f55506e) | 2026-10-30 | feat: add offline paint desktop client and cloud development setup |
| [11fbde1](https://github.com/parkjh2568/myPaint/commit/11fbde198c6b2d5c4d1d2c791667c734cfeb2fc7) | 2026-11-04 | feat: 그림판 안정성 개선 및 WebAssembly 웹 버전 구현 |
| [429f135](https://github.com/parkjh2568/myPaint/commit/429f13568f8647cd8d91e3fccce343986ff28b0b) | 2026-11-06 | feat: Qt-free Studio와 기본 그림판 사용성 개선 |
| [cbf299d](https://github.com/parkjh2568/myPaint/commit/cbf299d69b3aaea5c31366fc2cb8aba44338f0c3) | 2026-11-08 | refactor: optimize Studio compositing and clarify legacy boundaries |
| [3a90885](https://github.com/parkjh2568/myPaint/commit/3a90885abcc268c2ec587e7b31aa6034a7527c0d) | 2026-11-08 | test: respect disabled PNG matte control |
| [dc46272](https://github.com/parkjh2568/myPaint/commit/dc46272b980c734a4774e40439175d65264701de) | 2026-11-08 | test: compare canonical Windows recovery paths |
| [c6b5aaf](https://github.com/parkjh2568/myPaint/commit/c6b5aaf822e591d4eab086125ad6a30ce931485a) | 2026-11-08 | ci: migrate unavailable macOS 14 runners to macOS 15 |
| [6509b60](https://github.com/parkjh2568/myPaint/commit/6509b60b3b319fe56b7b77a69d672db17dd870a8) | 2026-11-08 | test: use stable interior coordinates for one-pixel native fixture |
| [9177ed5](https://github.com/parkjh2568/myPaint/commit/9177ed5fed95e06600046d68c4ffad44452f8f5f) | 2026-11-08 | fix: detect same-metadata external edits before saving |
| [c59f24e](https://github.com/parkjh2568/myPaint/commit/c59f24ec465e1f6416a8aa4485441b52377a0498) | 2026-11-08 | fix: make constrained line geometry exact and validate raster output |
| [81baaa0](https://github.com/parkjh2568/myPaint/commit/81baaa06dcc8e3d065afb7b25eff25466899fa40) | 2026-11-08 | test: stabilize pixel-scale export preview interactions |
| [68dae20](https://github.com/parkjh2568/myPaint/commit/68dae20360a755673a9127b0398f5161808d6766) | 2026-11-08 | ci: parallelize browser contracts without hiding failures |
| [7b8b8ac](https://github.com/parkjh2568/myPaint/commit/7b8b8ac5d75187eae7c522e1088d39d3930cce30) | 2026-11-08 | test: preserve continuous viewport coordinates in click oracle |
| [b068465](https://github.com/parkjh2568/myPaint/commit/b0684656ad699c9c3b0ccc3a5b447b28fe3a3493) | 2026-11-08 | test: make viewport and codec checks reproducible from checkout |
| [302b9df](https://github.com/parkjh2568/myPaint/commit/302b9df04534ae73afc83e99f2950af79d38440f) | 2026-11-08 | test: target selection pixels in CSS space and report pending diffs |
| [e31d746](https://github.com/parkjh2568/myPaint/commit/e31d7468c9ae2156dc72fa1c7051c15308f7a479) | 2026-11-08 | test: isolate raw mip pixels from browser clip rasterization |
| [bdd267e](https://github.com/parkjh2568/myPaint/commit/bdd267e7f04591949012f3c2b876601a8ce6f8be) | 2026-11-08 | test: exercise visual viewport pan with actual touch sequence |
| [54216d4](https://github.com/parkjh2568/myPaint/commit/54216d45b7b678dd0bd31427a6befb3f80758303) | 2026-11-08 | test: observe presented pixels without changing canvas backends |
| [dfd37d3](https://github.com/parkjh2568/myPaint/commit/dfd37d3f118d8259da0007e07ad41370a96c5afa) | 2026-11-08 | test: record decoded screenshot digest in redo evidence |
| [4c081f9](https://github.com/parkjh2568/myPaint/commit/4c081f946df7ccc624ac58335ecefc024723ae03) | 2026-11-08 | test: use matching readback backends for source and target surfaces |
| [29d968d](https://github.com/parkjh2568/myPaint/commit/29d968d3c9879f0896a1d7fa745cae4e76d08ba6) | 2026-11-08 | docs: distinguish verified native CI from remaining device acceptance |
| [c888c06](https://github.com/parkjh2568/myPaint/commit/c888c06040fb914ce81e67a87453ca122e393aac) | 2026-11-08 | test: model minimum zoom sampling before opacity in independent oracle |
| [c4e8608](https://github.com/parkjh2568/myPaint/commit/c4e8608c24b4a83de6a2f89b197a82ee8100e010) | 2026-11-08 | Merge pull request #1 from parkjh2568/refactor/measured-studio-cleanup |
| [cc5f099](https://github.com/parkjh2568/myPaint/commit/cc5f0994df35553b987c523b164cfe0ac0fd738c) | 2026-11-12 | style: refine Classic 98 skin without changing editor layout |
| [c10a29a](https://github.com/parkjh2568/myPaint/commit/c10a29a397aa77bb946c84406fd661db747164c0) | 2026-11-12 | docs: simplify guidance and add Korean platform test walkthroughs |
| [76438ff](https://github.com/parkjh2568/myPaint/commit/76438ff8c446493badaab0aa14d8c679f344222b) | 2026-11-12 | refactor: remove legacy Qt application and build paths |
| [43ffb2f](https://github.com/parkjh2568/myPaint/commit/43ffb2fc82405a49ee026087f58c819a7cf9c4c0) | 2026-11-12 | feat: default to transparent canvas and expose eraser preferences |
| [8637fad](https://github.com/parkjh2568/myPaint/commit/8637fad51ef5815921e0b0d61931287700c88e4e) | 2026-11-12 | feat: categorized menus, document tabs and fast eraser preferences |
| [d57fe5d](https://github.com/parkjh2568/myPaint/commit/d57fe5d420e12801a32d66bad09da7b7d9fc7ca3) | 2026-11-12 | fix: preserve pending edits and redo on failed tab activation |

새 작업은 위 단계에 요약하고 이 목록은 기준 스냅샷으로 보존합니다. 이후 전체 이력은 `git log --all --date=iso --stat`로 조회하세요.
