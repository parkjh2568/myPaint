# 프로젝트 작업 연혁과 결정 기록

2026-11-12 / 기준 `d57fe5d`. [인수인계](../PROJECT_HANDOFF.md) · [현재 검증](CURRENT_STATUS.md).

## 범위와 읽는 법

현재 브랜치에서 도달 가능한 전체 30개 커밋을 아래에 수록했습니다. 삭제된 브랜치·로컬에서만 존재한 중간 커밋·외부 세션의 모든 대화를 재현한다고 주장하지 않습니다. 이전 구현의 세부 실험은 [archive](archive/README.md)와 `evidence/`, 삭제 파일은 Git 이력이 근거입니다. 커밋 날짜는 Git에 기록된 날짜이며 실제 요청/로컬 작업 시작 시각과 다를 수 있습니다. 연결 앱으로 동일 트리를 게시한 단계에서는 로컬 커밋과 원격 커밋 SHA가 달랐습니다. 여기서는 원격 계보를 사용합니다.

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

지우개 모드 전환 지연 조사에서 불필요한 전체 테마/캔버스/컨트롤 갱신을 확인해 제거했고 동일 컬러휠을 반복 그리지 않도록 했습니다. 계측상 작업 횟수 감소는 확인했지만 사용자 기기의 반응 속도 개선 ms는 아직 확인하지 못했습니다. [탭](DOCUMENT_TABS.md) · [성능](PREFERENCES_PERFORMANCE.md).

### 8. 이번 인수인계 문서화

프로젝트 목적·소유권·이력·결정 이유·검증 한계·다음 작업을 한 시작점으로 모으고 README/AGENTS/문서 색인을 연결했습니다. 제품 코드는 바꾸지 않았습니다.

## 전체 커밋 목록 (기준까지 도달 가능한 계보)

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
