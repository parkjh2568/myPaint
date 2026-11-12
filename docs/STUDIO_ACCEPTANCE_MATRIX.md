# Studio 기능 인수 추적표

> 현재 Studio 실행·빌드만 유지합니다. 아래 과거 Qt 비교/검증 기록은 역사적 근거이며 제거된 경로를 실행하라는 안내가 아닙니다. 최신 제거 범위와 미완료 항목은 [정리 결과](LEGACY_REMOVAL.md)를 보세요.

QF-02의 유한한 입력·예상 상태·기준 데이터와 허용차는 [독립 기준 목록](archive/STUDIO_FIXTURE_BASELINE.md) 및 [canonical JSON](../web-app/tests/fixtures/legacy-contracts.json)으로 고정했다. 아래 날짜별 인수 범위를 전체 옵션 승인으로 확대하지 않는다.

최신 로컬 제품·검증 범위는 [QF-04 문서 계약](STUDIO_DOCUMENT_CONTRACTS.md)의 `index-DIgO41Ne.js`, [최신 소스 macOS 앱4분기 재검증](archive/STUDIO_NATIVE_CURRENT.md), [전체 완료 감사](STUDIO_COMPLETION_AUDIT.md)를 따른다. 아래 기능별 실행 기록은 각각 당시 snapshot이며 최신 실행 개수로 합산하지 않는다.

둥근 사각형 단계의 제품 기준은 2026-11-06의 `index-BL54aMU4.js`와 [둥근 사각형·컨텍스트 실패 채택 근거](evidence/studio-roundrect-contract.json)다. 공개24·기존도형23/pending36/웹48·전체Canvas56/저장12/재시도2·Node229·실제macOS4단계를 각각의 범위로 확인했다. [전체 완료 조건 감사](STUDIO_COMPLETION_AUDIT.md)는 남은 태스크 기준이며, 아래 날짜별 실행은 당시 소스 snapshot이다. WK 추출 알고리즘의 기존 strict seam 실패와 실기기/Windows·공개인수는 별도 미완료다.

2026-11-05 채우기 실패 단계의 제품 기준은 [채우기 실패·task 소유권 근거](evidence/studio-fill-failure.json)의 `index-B_qt7xyr.js`다. 새 공개 UI 10개에서 모드별 두 번의 실패/취소와 정상 retry·Undo/Redo, 웹 48개·pending 36개·표준 일반 macOS 앱 4단계를 확인했다. 새 수정은 `task`의 setup 예외 범위/local controller이며 Worker 9경계는 기존 안전성을 확인했다. 엔진·Codec·Rust·형식·fill 키/색 방식은 유지한다. 이전 Node 176과 성능을 새 실행으로 세지 않으며 전체 F10·채우기 alpha·실기기/성능/출시 인수는 남아 있다. 모바일·태블릿은 웹만, 패키지는 Windows/macOS만 제공한다.

직전 제품 기준은 [선택·문자 alpha 근거](evidence/studio-alpha-contracts.json)의 `index-CopdG-54.js`다. [source17](../build-web-work/task-planning/selection-text-alpha/final-source.json)과 [asset8](../build-web-work/task-planning/selection-text-alpha/candidate-manifest.json)을 기준으로 선택 4개·문자 8개, 기존 웹48·pending36·clipboard4, 별도 실제 WK alpha 10개(문자6/선택4)과 overlay 없는 일반 macOS4단계를 확인했다. 엔진·tiles·형식·Rust·runtime import는 같고 함수 추가는0개다. 이전 Node176과 성능은 이번 재실행/새 측정으로 합산하지 않는다. 모바일·태블릿은 웹 전용, 패키지는 Windows/macOS 전용이며 실기기·OS IME·전체 기능/최종 성능·출시 게이트는 남아 있다.

직전 [UI4](evidence/studio-bounded-mip.json)는 `index-BeDySgiR.js`에서 필수 타일109·정보4, Node176·웹48·준비8·장면 Canvas56/문서12와 일반 macOS4단계를 검증했다. 응답성 개선과 완성 시간 증가는 당시 스냅샷의 측정으로 보존한다.

직전 [팔레트·키보드·연필 단계](evidence/studio-pencil-palette.json)는 `index-D4CivZOE.js`에서 연필10+기존31, 사각35, 웹13·동시성3·편집13, 스킨/뷰포트4환경과 macOS4단계를 검증했다. 아래 과거 결과는 각각 당시 snapshot에 한정하며 현재 alpha 배치에서 다시 실행한 횟수로 합산하지 않는다.

기준: 2026-11-05, [`IMPLEMENTATION_RESULTS.md`](https://github.com/parkjh2568/myPaint/blob/c10a29a397aa77bb946c84406fd661db747164c0/docs/archive/IMPLEMENTATION_RESULTS.md)의 F01–F10과 [`toolDefinitions`](../web-app/src/ui/icons.ts)의 17개 도구. 이 문서는 구현 여부와 실제로 실행한 회귀의 범위를 구별한다. 검사 개수나 아이콘 존재만으로 레거시 전체 기능 동등성을 판정하지 않는다.

이전 기본 기능 회귀 묶음의 검증 대상은 `http://127.0.0.1:8965/mypaint/`의 `index-CVIk2cDl.js`이다. [`accepted-manifest.json`](../build-web-work/task-planning/max-document/accepted-manifest.json)에 번들 해시가 있다. F02 버튼 소유권과 F09 즉시 이력 가지치기가 모두 포함된 같은 번들에서 bulk 16개, pointer 7개, native profile 17개, persistence 12개를 순차 실행했고 `errors`/`failures`는 모두 비어 있다. 기존 공개 웹 45개와 Node 107개도 아래 해당 아티팩트에서 확인했다. Chromium·모델 native bridge 결과를 실제 OS 파일시스템·WKWebView·Windows·Android 실기기 결과로 해석하지 않는다. 후속 종료 보호는 `8966`의 `index-Bshc9KRt.js`에서 공개 UI persistence 15개를 확인했다. 실제 macOS 종료 경계는 별도 release 앱의 WKWebView·Rust/AppKit 3단계 검증으로 구분한다.

이전 미확정 편집 배치는 `8968`의 `index-DqAJBzmA.js`에서 검증했다. [통합 근거](evidence/studio-pending-contracts.json)에 pending 36개(실패/취소 24 + Redo 단축키 12), 클립보드 성공 payload 4개, 기존 편집 13개·동시성 3개와 실제 macOS 3단계의 소스/번들 해시를 구분해 기록했다. 아래 이전 묶음은 각 당시 snapshot의 근거다.

후속 [도구·알파·입력 검사](evidence/studio-tool-contracts.json)는 지정 색 교체의 국소 범위·키 매칭·취소, 도형의 우클릭·알파·pending 색 소유권, 투명한 입력의 raw RGBA 보존을 추가했다. 공개 UI 9+23개와 실제 Qt 기준, Node 155개, 최종 macOS 4단계의 범위는 각각 분리한다. 기존 103개 회귀도 도형 수정 snapshot에서 확인했다. 과거 고정 번들을 최신 소스 전체의 검증으로 확대하지 않는다.

주요 근거:

- [`pending-contract.mjs`](../web-app/tests/pending-contract.mjs), [36개 결과](../build-web-work/task-planning/pending-contract/fixed.json): 64² 두 레이어·active 1·기존 Redo가 있는 깨끗한 문서에서 paste/이동 선택/문자/곡선 두 단계/다각형의 실패·취소를 확인한다. 실제 export Worker 입력만 수동 변경 없이 관찰하고 원시 레이어/active·PNG·화면·문자·파일 bytes·dirty/saved UI·후속 Undo/Redo를 비교한다. 내부 숫자 revision을 직접 읽는 검사는 아니다.
- [`clipboard-contract.mjs`](../web-app/tests/clipboard-contract.mjs), [4개 결과](../build-web-work/task-planning/pending-contract/clipboard-fixed.json): 실제 ClipboardItem PNG를 Node zlib 기반 독립 reader로 검증한다. Resize 30×25·회전 14×20·합성 copy/active cut과 53×41 확장 preview→45×35 crop의 RGBA가 독립 기대값과 일치했다.
- [`bulk-accepted.json`](../build-web-work/task-planning/max-document/bulk-accepted.json): [`bulk-edit.mjs`](../web-app/tests/bulk-edit.mjs)의 실제 Canvas 픽셀·RGBA·Undo·실패/취소. Worker 응답 오류/지연은 명시적 주입이다.
- [`pointer-accepted.json`](../build-web-work/task-planning/max-document/pointer-accepted.json): [`pointer-contract.mjs`](../web-app/tests/pointer-contract.mjs)의 복합 버튼 소유권·실제 Canvas·다음 제스처·같은 위치 Shift release.
- [`profile-accepted.json`](../build-web-work/task-planning/max-document/profile-accepted.json): [`native-profile.mjs`](../web-app/tests/native-profile.mjs)의 4096²/32768×1 코덱·geometry Worker·프로필 경계.
- [`persistence-accepted.json`](../build-web-work/task-planning/max-document/persistence-accepted.json): [`native-persistence.mjs`](../web-app/tests/native-persistence.mjs)의 파일 binding·취소·복구. 실제 codec Worker가 만든 64MiB 초과 데이터를 모델 filesystem IPC로 저장한다.
- [`persistence-close-review.json`](../build-web-work/task-planning/native-quit/persistence-close-review.json), [원문](../build-web-work/task-planning/native-quit/persistence-close-review.log): [`native-persistence.mjs`](../web-app/tests/native-persistence.mjs)의 종료 저장 picker 취소·write IPC 오류·승인 후 close IPC 오류를 추가한 15개 통과. Chromium의 모델 IPC 오류 주입이며 실제 OS 선택기/디스크 고갈 검사가 아니다. 번들 기준은 [quit-manifest.json](../build-web-work/task-planning/max-document/quit-manifest.json)이다.
- [`quit-desktop.json`](../build-web-work/task-planning/max-document/quit-desktop.json): [`native-desktop.mjs`](../web-app/tests/native-desktop.mjs)의 실제 macOS `.app` 실행. `quitRun`에서 runtime/native 두 방식의 unsaved/pending 취소·busy 보존·중복 종료와 마지막 승인 종료를 확인했다. 현재 [`native-smoke.ts`](../web-app/src/platform/native-smoke.ts)로 분리된 quit smoke는 `pending` 단계에서 동일 문서/문자 identity·value·revision·saved revision·원시 RGBA를 비교하며, 검증 marker 자체는 종료를 승인하지 않는다. 임시 root와 비영구 WebView만 사용했다. Windows 실행이나 OS 파일 대화상자 검증은 포함하지 않는다.
- [`node-quit-final.log`](../build-web-work/task-planning/max-document/node-quit-final.log): F03 동일 레이어/active 계약 4개를 추가한 당시 Node 111개 통과. 실제 Qt oracle 및 소스 해시는 [통합 근거](evidence/studio-max-document.json)에 기록했다.
- [`node-accepted.log`](../build-web-work/task-planning/max-document/node-accepted.log): F09 accessor·stale prepared 방어를 포함한 당시 Node 107개 통과. 순수 코어의 한도/이력을 확인하며 UI/OS 인수의 대체 근거가 아니다.
- [`browser-accepted.log`](../build-web-work/task-planning/max-document/browser-accepted.log), [`editing-accepted.json`](../build-web-work/task-planning/max-document/editing-accepted.json): 기존 공개 UI/단위 회귀의 별도 실행 근거. 표의 특정 case만 해당 계약의 근거로 사용한다.
- [`performance-summary.json`](../build-web-work/task-planning/max-document/performance-summary.json): 최대 문서 성능·메모리 측정의 방법과 제한. 당시 cold white render 약93ms, 두 번째 레이어 표시 약465ms를 관측했다. 후속 UI4의 응답성/완성 시간은 아래 별도 근거를 따르며 이 값을 최신 측정으로 재사용하지 않는다. 50ms는 전체 이미지 완료 시간 상한으로 해석하지 않으며 유효 frame/입력 지연 기준은 별도로 유지한다. Warm/부분 갱신 개선이 이 gate를 충족했다는 뜻은 아니다.

## F01–F10

`부분 확인`은 적힌 시나리오만 통과했다는 뜻이다. 남은 조합을 통과로 추정하지 않는다.

| 계약 | 실제 case → 소스/근거 | 판정과 남은 인수 |
| --- | --- | --- |
| F01 표시된 선택 크기로 copy/cut/transform/crop | 기존 실패/취소·다층 crop → bulk; 성공 resize/회전 PNG와 확장 paste crop → [`clipboard-contract.mjs`](../web-app/tests/clipboard-contract.mjs) | **명시한 성공·실패 계약 확인.** 표시 크기 30×25 resize와 90도 회전 14×20 copy의 실제 PNG 치수/전체 RGBA를 독립 비교했다. 16² 문서에 붙인 그림을 이동해 53×41로 보이는 pending을 export한 뒤 45×35 crop·한 번 Undo→16²·Redo를 확인했다. 실제 OS clipboard 권한은 별도다. |
| F02 시작 버튼/장치의 제스처 소유권 | `rejected shortcut preserves the active stroke` → [`concurrency.mjs`](../web-app/tests/concurrency.mjs); `Second touch takeover cancels an already rendered brush without ghost pixels or history` → bulk | **수정 후 8965에서 직접 확인.** [`pointer-contract.mjs`](../web-app/tests/pointer-contract.mjs)의 `Mouse owner left plus middle: owner releases first/other releases first`, left+right owner-first, right+left 양순서가 실제 Canvas·RGBA·한 번 Undo·Redo·다음 정상 제스처까지 통과했다. [8963 반례](../build-web-work/task-planning/pointer-contract/result.json)는 owner release가 `pointermove(button=0,buttons=4)`로 전달되어 추가 잉크가 생겼다. 가운데 버튼을 owner로 시작하는 pan·펜/장치 혼합 순열은 남아 있다. |
| F03 구조 변경·active 복원·동일 레이어 reorder 이력 | 실제 Qt `reorderedIdenticalLayers`; `identical layer names and RGBA still reorder with active restoration and saved revision identity`, `an explicit identical-layer permutation stays historical even when the active index and values are unchanged`, active 선택/지연 후보 회귀 → [`metadata.test.ts`](../web-app/tests/metadata.test.ts) | **코어 계약 직접 확인.** 같은 이름/RGBA·독립 버퍼의 순열, active 값까지 같은 순열의 dirty/Undo/Redo/saved ID, 비이력 active 선택과 이력 active 후보, active 변경 후 지연 설치 거부·Redo 보존을 추가 4개로 확인했다. 제품 수정 없이 당시 Node 111개 통과. 실제 Qt oracle와 source hash는 [통합 근거](evidence/studio-max-document.json)의 `identicalLayerContract`에 있다. UI 버튼/장치 조합은 코어 근거와 구별한다. |
| F04 pending 시작/취소/확정의 메뉴·Undo/Redo 표시 | `pending-contract.mjs`의 여섯 pending fixture와 12개 단축키 → [최신 결과](evidence/studio-pending-contracts.json) | 기존 Redo가 있는 clean 문서에서 pending 시작→Undo 활성/Redo 비활성, Esc→기존 Redo 복원, 저장 확정→한 번 Undo/Redo와 saved UI를 확인했다. 키보드만 비활성 상태를 우회하던 오류를 공통 redo 명령의 pending 가드로 수정했다. Qt 실제 disabled QAction 키 검사와 일치한다. 모든 도구/장치 조합 전체를 뜻하지 않는다. |
| F05 저장·종료·크기 취소/실패가 pending을 확정하지 않음 | 아래 16칸 + 이동 선택/첫 제어점 곡선 확장 → pending 24개; 실제 macOS text/dirty/busy Quit → desktop | **행렬의 모델 공개 UI 계약 확인.** raw RGBA/active·실제 PNG·화면·문자·원본 파일/binding·기존 Redo가 유지되고, 재시도 저장은 한 번만 확정됐다. 종료 이벤트는 client 경계이며 실제 AppKit text/dirty/busy는 별도 실행이다. OS 선택기·ENOSPC/commit 오류는 이 표로 승인하지 않는다. |
| F06 문서 밖 선택·이동/크기/줌·한도 초과 보존 | `Two-finger navigation restores a provisional selection move/resize` → [`editing.mjs`](../web-app/tests/editing.mjs); `invalid angle, expanded dimension and aggregate limits reject without mutating source` → [`shear.test.ts`](../web-app/tests/shear.test.ts); selection 실패/취소 → bulk | 부분 확인. 후속 mask/nearest/crop 및 [Source-clear7·paste4](evidence/studio-selection-source.json)의 명시 경계를 확인했다. 후속 [원본 mask/연속 크기 검증](evidence/studio-masked-transform.json)의 명시 순서도 확인했다. 임의 순서·표시 범위/줌·모든 한도/장치 조합은 남아 있다. [`crop.test.ts`](../web-app/tests/crop.test.ts)의 음수/밖 좌표 oracle은 순수 연산 근거이다. |
| F07 선택 없는 cut은 활성 레이어, 일반 copy는 합성 | 기존 clipboard 실패/삭제/Undo → bulk; 반투명 다층의 copy/cut 실제 PNG → clipboard-contract | **payload 계약 직접 확인.** 일반 copy의 합성값 두 종류를 독립 상수 RGBA로 비교하고, cut은 active 레이어의 alpha 96을 포함한 원래 RGBA만 복사함을 확인했다. 다른 레이어·숨긴 세 번째 레이어와 Undo/Redo도 보존됐다. OS 권한/제스처 인수는 별도다. |
| F08 같은 release 위치에서도 마지막 Shift 반영 | `Rendered provisional brush keeps the last release point and uploads less than the full document on commit; Undo and Redo are exact` → bulk | 마지막 **좌표**와 렌더/Undo는 확인. Pointer 영구 회귀의 `Same-position Shift release 사각형/직선 matches Shift held during move and remains one Undo`는 같은 위치의 Shift release와 Shift move의 exact 일치·실제 square/45도 잉크 경계·한 번 Undo를 확인한다. 후속 pointer 9개 묶음에서 둥근 사각형/타원도 독립 잉크 경계·Canvas·단일 Undo/Redo까지 확인했다. 실제 장치와 기타 옵션 조합은 별도다. |
| F09 이력 4096개·예산 축소·saved revision·Redo 분기 | `save revision remains unique across branch and failed edit preserves redo` → [`core.test.ts`](../web-app/tests/core.test.ts); metadata 이력 버퍼 비용·prepared 변경 거부 → metadata tests | **코어의 명시 범위 확인.** 후속 accessor는 즉시 Undo 앞쪽/먼 Redo를 가지치기하고 현재 pixels·revision·saved ID를 유지한다. [`history.test.ts`](../web-app/tests/history.test.ts)의 `changing history budget immediately prunes from Undo then distant Redo without editing current pixels`, `4096 history boundary and budget shrink at fully undone position match the Qt patch contract`, `saved branch IDs stay unique after pruning removes both past and future changes`와 prepared 지연/정책 복원 우회·invalid 값·활성 stroke를 포함한 10개가 [당시 Node 107개](../build-web-work/task-planning/max-document/node-accepted.log)에서 통과했다. 음수는 0으로 clamp하며, 예산보다 큰 가장 가까운 **한 항목은 유지**하는 레거시 정책이다. 동적 예산을 노출하는 사용자 UI는 없다. 이력 회계가 codec/Canvas/동시 snapshot까지 포함한 전체 프로세스 메모리 한도라는 뜻은 아니다. |
| F10 미리보기·인코딩·복구 중 응답성/취소·원본 보호 | geometry 취소/오류 → profile; `background recovery completion from an old generation cannot replace a new generation backup` → persistence; 부분 업로드/실제 Canvas Undo/Redo → bulk | 해당 소유권과 파일/문서 보존을 명시한 범위에서 확인했다. UI4는 bounded mip 준비·완성 프레임 공개와 취소/dirty/문서 교체/context loss·warm cache를 추가 검증했다. Chrome6쌍에서 관측 callback은 짧아졌지만 완성은 모두 느려졌고 WK uniform은 n1, checker pair는 조건 불일치로 제외했다. 직접 동기 render와 cooperative UI 경로를 구분하며 전역50ms·p95·물리 input-to-photon·장기 RSS/코덱 peak는 계속 미확인이다. |

## F05의 16개 조합

아래 16칸은 모두 `pending-contract.mjs`의 모델 native 공개 UI에서 확인했다. 선택은 붙여넣기와 이동 선택, 곡선은 endpoint와 첫 제어점 단계까지 확장해 총 24개 실패·취소 실행이다. 두 종류의 크기 대화상자를 각각 취소하고 확인한다. `write_selected` 실패는 commit 전 모델 오류이며 실제 OS 디스크 오류와 구분한다.

| pending 종류 | 저장 취소 | 저장 쓰기 실패 | 종료 취소 | 크기 대화상자 취소 |
| --- | --- | --- | --- | --- |
| 선택 | `paste/selection / save_cancel` 확인 | `paste/selection / save_failure` 확인 | `paste/selection / close_cancel` 확인 | `paste/selection / size_cancel`에서 canvas/image 모두 확인 |
| 문자 | `text / save_cancel` 확인, 기존 종료→저장→picker 취소도 유지 | `text / save_failure` 확인, 기존 종료→저장 오류/retry도 유지 | `text / close_cancel` 확인 + 실제 macOS runtime/AppKit text 취소 | `text / size_cancel`에서 canvas/image 모두 확인 |
| 곡선 | `curve0/curve1 / save_cancel` 확인 | `curve0/curve1 / save_failure` 확인 | `curve0/curve1 / close_cancel` 확인 | `curve0/curve1 / size_cancel`에서 canvas/image 모두 확인 |
| 다각형 | `polygon / save_cancel` 확인 | `polygon / save_failure` 확인 | `polygon / close_cancel` 확인 | `polygon / size_cancel`에서 canvas/image 모두 확인 |

추가 `Approved close freezes input; close IPC failure restores drawing, Undo and saving`은 승인된 종료 IPC가 대기하는 동안 입력 동결과 중복 close 방지, 오류 뒤 `inert` 복원·실제 획·Undo·저장 가능을 모델 공개 UI로 확인한다. 깨끗한 문서에서 수행한 별도 종료 실패 경계이며 다른 pending 칸의 근거로 사용하지 않는다.

각 칸은 보류 편집이 원래 그림과 실제로 다른 PNG를 만드는지 먼저 확인한다. 실패/취소 전후 raw 레이어/active·PNG·화면·문자와 원본 bytes/binding을 비교한 뒤 Esc→원래 Redo→Undo, 같은 pending 재시도 저장→단일 Undo/Redo·saved UI를 확인했다. 수치 revision의 내부 관찰은 이 공개 UI 검사에 포함하지 않는다. 네이티브 write 실패는 OS commit 전 실패와 commit 성공 후 응답 지연을 구별하며, 성공한 파일을 실패로 보고 다시 덮어쓰는 결과를 만들면 안 된다.

별도 실제 APFS 시험은 현재 `Persistence`의 수동 저장/복구 `Stage::write`에 OS 오류 28을 발생시켜 원본·metadata·경로·복구 sequence/token 보존과 정리/retry를 확인했다. [통합 근거](evidence/studio-pending-contracts.json)의 `actualAPFSEnospc`를 따른다. 이 native 파일시스템 근거와 위의 pending UI 모델 행렬은 서로 다른 검증 경계이며, UI×실제 ENOSPC 전 조합을 실행한 것으로 표시하지 않는다.

## 17개 도구

도구별로 전체 옵션/장치 조합을 확인한 표가 아니다. `구현/개별 인수 남음`은 도구가 소스에 있으나 직접적인 성공 픽셀 oracle을 신규 테스트에서 찾지 못했다는 뜻이다.

| 도구 | 현재 확인한 case/경로 | 남은 직접 인수 |
| --- | --- | --- |
| 브러시 | 둥근 경로의 provisional/마지막점/부분 upload·취소·숨김 표시·release pen0; 사각 단계의 Qt 기하5397·UI35와 이벤트별 alpha/옵션 무시 | 둥근 압력 곡선·보정·경도의 남은 경계, 실제 펜·장시간과 미확인 장치 순열. 사각 인수를 soft dab의 미해결 문제로 되돌리지 않는다 |
| 연필 | 팔레트·연필 단계의 실제 Qt Canvas41개·공개 UI10개: 기존 hard square size1 경로의 기하·좌/우·이벤트 alpha·옵션 무시·pen0/chord·취소/Redo와 원형 설정 복원 | OS 배율·물리 펜·장시간 입력. [`pixel.test.ts`](../web-app/tests/pixel.test.ts)의 DDA/최대 coverage·opacity는 유지되는 내부 generic pixel 모드의 별도 계약이며 현재 UI 연필 인수가 아니다 |
| 지우개 | 둥근 경로의 단층 투명/50%·다층 clear, hidden RGB NoOp/Redo·숨김/취소·alpha1 부분→완전 삭제·pen release/move0; 사각 단계의 Qt 경계·옵션 무시·Source 합성·UI35 | 명시한 둥근/사각 계약을 확인했다. 물리 펜·장시간과 미확인 바탕색/저알파 조합은 별도이며, 과거 사각 차이는 후속 수정됨 |
| 채우기 | 기존 core fill/active 지연 정상 검사에 [실패 10개](evidence/studio-fill-failure.json)를 추가. 모드별 두 실패/취소·실제20초 timeout 두 번·첫 정상 retry/UndoRedo·원본/Redo/active·자원 복원 | 전체 F10, 복잡한 최대 영역·장기 메모리·물리 기기. 후속 [키 계약](evidence/studio-fill-cut-key.json)에서 Qt fill6·UI6·WK Worker6과 cut5를 확인. 숨긴 active cut의 OFF도 수정; hidden/ON 조합은 별도 |
| 스포이트 | 후속 공개 UI12개: 좌/우 foreground 선택, hidden active 무시·visible 합성, alpha0/1/128·문서 밖 NoOp·Redo 보존과 capture loss 재시도. 연필 단계에서 이후 잉크의 두 pass 합성 기대를 분리 | **명시한 색/원본 계약 확인.** 저알파 straight RGBA는 Qt premul 양자화와 구분. 색상 UI의 알파 표시와 실제 장치 인수는 남음 |
| 스프레이 | 독립 점의 비연결 코어 회귀, 후속 실제 timer의 단발 주입 실패→정지·원본/Redo·캡처 복원·재시도/Undo | 일반 pointercancel·장시간·랜덤 분포/실기기와 반복 메모리 실패 인수는 남음 |
| 지정 색 교체 | 실제 Qt 18개·영구 대조 19개, 공개 UI 9개, 실제 WK 엔진 3개 | 전역 Worker 교체를 폐기하고 hard capsule의 premul 키 매칭을 복원했다. raw target·마지막 release·좌/우·취소·NoOp/Redo·hidden visibility를 확인했다. 실제 펜/장시간 조작은 별도 |
| 직선 | profile의 32768×1 도형/Undo, 후속 좌·우 색/alpha128·Shift release | 우측/상단 clip·두께별 범위와 실제 장치 |
| 곡선 | Editing의 resize/takeover와 후속 mixed press·pending PNG/저장·오류 복원/retry·Undo/Redo | 실제 입력 장치, 비수평 제어점/두께·경계 조합 |
| 사각형 | profile의 4096² 도형/Undo, 후속 outline/fill/both·좌/우·alpha128·hidden RGB | 모서리/문서 밖 경계와 다양한 두께 |
| 둥근 사각형 | [독립축 최대12·기존퇴화/float endpoints 정책과 공개24](evidence/studio-roundrect-contract.json); DPR1/2 대표·clip·reverse·작은폭·512tile·원본/Undo/Redo·context null/throw/HTML fallback | 두께/alpha/포인터 전 조합·실기기·기존WK 경계AA strict seam 및 전체도형 인수 |
| 타원 | 후속 좌/우 채움·윤곽 색/alpha, 같은 위치 Shift release·Canvas·Undo/Redo | 작은/큰 축·clip·두께 조합 |
| 다각형 | Editing의 pending 변형 및 후속 closed fill preview·mixed press·PNG/프로젝트 저장·pan 색 보존 | 중복점/자기 교차·경계·실제 장치 |
| 사각 선택 | 기존 crop/delete/cut/transform 실패·취소와 clipboard 거부, 후속 Qt4/UI4개의 투명 선택 alpha+premul 키·원본 RGB 보존 | 다양한 보간·mask/음수 이동 결합, 실제 OS clipboard/장치. 투명 키 수정만으로 F06 전체를 완료하지 않는다 |
| 자유 선택 | 기존 editing의 원점 복귀 NoOp와 후속 [mask871/공개8·crop4·실패6](evidence/studio-selection-mask.json)의 자기교차/구멍·음수 이동·Qt nearest·키 ON/OFF·copy/cut/취소 payload | 후속 Source-clear7·source-less paste4는 명시 범위 확인. 원본 mask의 명시 rotate/flip/resize·연속 크기 조절은 후속9개와 crop10 범위 확인. 이후 같은 rounded target의 출력 재사용·원복은 공개10번째, dense parity는 실제Qt12/별도WK에서 확인했다. 임의 순서·비퇴화 거대 path·전체 F06/실기기 |
| 문자 | 기존 paste/hidden RGB·IME block·pending 보존에 alpha UI8개를 추가. preview/PNG·확정/UndoRedo·숨김 표시, Qt6case/84check와 별도 WK 문자6개의 명시 alpha 확인 | 실제 OS IME·스크롤/clip/긴 여러 줄·글꼴/스타일과 미확인 배경 조합·크기 취소·Windows 실제 종료/쓰기 오류. glyph의 OS 간 동일성을 뜻하지 않음 |
| 화면 이동 | `Mobile browser two-finger navigation cancels provisional finger stroke` → browser | H 도구의 실제 공개 입력 기준은 scene-contract.mjs에 존재함을 QF-02에서 확인했다(이번 신규 실행 아님). 가운데 마우스·문서 밖·Retina/다중 모니터/회전·seeded Redo 인수는 별도 |

## 후속 인수 순서

1. **P0 데이터 경계:** 확인한 F05 16칸과 확장 사례, F01/F07 성공 payload·확장 crop 회귀를 유지한다. 실제 OS 파일 선택기·쓰기 실패/외부 변경과 아직 미확인인 형식·도구 옵션을 인수하며 모델 IPC 결과와 구분한다.
2. **P0 제스처/이력 동등성:** F02/F08의 확인한 순열과 F09의 즉시 가지치기/단일 초과 항목 정책 회귀를 유지한다. F03 동일 레이어/active 코어 회귀도 유지하며 남은 장치·도형·공개 UI 조합을 좁은 재현 입력으로 확인한다. 향후 예산 UI를 추가하면 코어의 동일 계약과 실패 표시를 공개 UI에서 검증한다.
3. **P1 도구 옵션·플랫폼:** 도구별 미확인 성공 경로와 옵션을 추가하고, Android 웹·Windows 설치형·macOS 실제 선택기/클립보드/IME·서명/공증을 인수한다. 모바일 설치형은 범위에 포함하지 않는다.
4. **P1 성능:** UI4의 제한된 준비/완성 프레임 공개를 유지하고 같은 DPR·mip의 WK checker, 넓은 dirty·반복 latency·장기 RSS를 확인한다. 짧은 callback을 총 완료시간·전역50ms·p95·실기기 인수로 확대하지 않는다.

이 추적표는 후속 작업의 범위를 보존한다. 현재 소스/검증에서 아직 확인하지 않은 칸을 제품 결함으로 단정하거나 완료로 바꾸지 않는다.


최종 화면 캐시의 2026-11-05 후속 검증은 [통합 근거](evidence/studio-scene-integration.json)를 따른다. DPR 1/2의 실제 UI 전체 화면 56개·파일 출력 12개, 타일 필수 63건, macOS 렌더링 14개 화면과 원시 RGBA 보존을 확인했다. F10의 cold·넓은 dirty 응답성, 장치별 입력 지연과 위 표의 미확인 도구 옵션은 계속 미완료다.


추가 정책: 가운데 버튼/두 손가락 탐색은 pending 도형 색을 보존한다. Qt의 middle-pan이 global rightButton을 바꾸는 부작용은 복제하지 않는다. 실제 그리기 press의 최신 좌/우 선택은 반영하고, 취소/실패는 이전 색으로 복원한다. 투명 일반 잉크와 source-over의 alpha0은 기존 hidden RGB를 바꾸지 않는다. 문서 위의 무잉크 시도는 숨김 레이어의 표시 이력만 남길 수 있지만, 완전히 외부의 무효 입력은 기존 NoOp/Redo 보호를 유지한다.

추가 마우스 버튼 3/4는 등록·capture·settle 전에 거부하도록 수정했다. [후속 포인터 23개](evidence/studio-pointer-buttons.json)는 보조 버튼 단독/먼저 누른 chord, 좌·우 owner와의 해제 순서, pending 다각형·선택 보존과 다음 정상 입력을 확인한다. 브라우저 자체 뒤로·앞으로 탐색은 이 검사에서 단언하지 않는다. 스포이트의 저알파 수치 차이는 Qt premul 정규화와 새 straight RGBA 모델의 차이로 구분하고 별도 UI 인수를 남긴다.


## GIF 입력의 후속 인수

[GIF 입력 근거](evidence/studio-gif-input.json)의 같은 후보에서 공개 UI 22개와 기본 웹 10개가 통과했다. 정상 87a/89a, global/local palette, 투명 index, interlace 행 순서, NETSCAPE loop extension과 애니메이션 첫 장면의 literal RGBA를 확인했다. 잘린 입력과 첫 프레임의 크기·offset 초과는 기존 문서·binding·세대를 보존하며, 별도 기존 Redo와 pending 다각형도 후속 정상 입력·단일 Undo까지 확인했다. 큰 metadata 표본은 실제 decoder를 호출할 수 없는 spy로 보호했다.

실제 macOS WKWebView는 정적 빨강·애니메이션 첫 빨강·투명 GIF의 8×6 전체 RGBA를 추가 확인했다. 별도 ImageIO 직접 프로브의 비규격 frame crop 결과를 WK 전체 동등성으로 확대하지 않는다. Prefix 취소의 Node 검사는 soft budget의 동작 근거이며 Android의 hard latency나 브라우저 전체 RSS 인수가 아니다.


후속 [실제 WK/타일 검사](evidence/studio-wk-render.json)는 기존 67개를 유지하며 작은 factor8 oracle11개를 추가했다. 필수 74개가 통과했고 기존 정보성 4개 차이는 별도다. 순백색·raw-zero·constant/varied hidden RGB·alpha1/2 반올림·행 마지막 픽셀과 별도 preview owner의 취소·dirty/rollback을 확인했다. 실제 업로드 RGBA 10개는 독립 boxReference와 같고 취소는 업로드 없이 원본owner를 재사용했다. 동일 소스의 macOS scene 18/GIF 3도 유지했다. 이 결과는 물리 펜·전체 장치 인수나 모든 cold latency의 통과가 아니다.


### 화면 범위 source 업로드 회귀

[후속 근거](evidence/studio-viewport-tiles.json): 기존 타일78개를 유지하고 좁은 viewport·smoothing·paper edge·동일 owner 두 위치·실제1px halo·ImageData 실패 정리/재시도8개를 추가했다. 필수82개 통과(전체 Canvas exact71개·기존 경계 계약9개·실패/할당 자원 계약2개), 정보성4개 별도, page error0. 고정 이전 renderer와 독립18/확장23 비교도 통과했다. 실제 macOS6회 교차 비교에서 scene18·원본16개 digest·별도14프레임 replay를 유지했지만, 물리 Android·Windows·50ms/tail 인수를 완료한 것은 아니다.


### 둥근 도구·스포이트·입력 실패의 후속 인수

[근거](evidence/studio-basic-tools.json)의 최종 source에서 새 도구 UI31개, 포인터26개(기존23+실패/소유권3), 기본 웹10·동시성3·편집13, Node169·macOS 일반 패키지4단계가 통과했다. 같은/이동된 release에서 마우스와 pressure1 펜을4쌍으로 비교했고, 실제 move pressure0은 계속 반영한다. 종료 시 마지막 접촉 압력을 유지하는 정책이며 모든 Qt tablet 경로와 같은 결과라는 뜻은 아니다.

할당 실패 뒤 첫 제스처 유실, drag 없는 capture loss, 선택 resize 한도 오류의 중간 raster 잔류, spray timer 오류 뒤 계속 그리는 문제를 재현·수정했다. 단발 할당/난수 실패는 의도적 주입이며 resize 한도는 공개 CDP 입력에 대한 실제 검증 오류다. 화면·raw RGBA·Redo·첫 재시도를 확인했지만 반복 OOM·물리 장치 검증은 아니다.

**당시 미해결 Major: 사각 브러시/지우개.** basic-tools 단계는 Qt161개와 soft square dab의 차이, 실패한 polygon 근사를 보존한 기록이다. 이후 아래 사각 단계에서 hard square 경계·옵션·이벤트 합성을 수정·검증했다. 이 과거 차이를 현재 미수정 결함으로 나열하지 않으며, 전체17도구·물리 장치 인수는 여전히 별도다.


## 사각 도구 후속 인수

2026-11-05. [당시 근거](evidence/studio-square-tools.json)의 source17개·asset8개와 `index-dmsxjaEy.js`를 기준으로 아래를 확인했다. 이전 표의 다른 snapshot 결과를 새 결과로 합산하지 않는다.

| 검증 | 결과 | 범위 |
| --- | --- | --- |
| 엔진 | Node176 통과 | 새7개 테스트 안에 실제 Qt 기하5397개·RGBA·이력·실패 복구 포함 |
| 사각 도구 공개 UI | 35개·레이아웃3개 통과 | Chromium CDP, 파일 전송은 모델 IPC; Studio/Classic·390px 확인 |
| 기존 도구·입력·편집 | 31+26+10+3+13 통과 | 지우개/스포이트·포인터·웹·동시성·편집 |
| macOS 앱 | 실제4단계 통과 | 저장/복구·codec·종료·scene21; 사각3개는 JavaScriptCore core 검사 |
| 플랫폼 범위 | 설정 일치 | 모바일/태블릿 웹만, 패키지는 Windows/macOS만 |

이 사각 단계 종료 시 남았던 연필1px 대각 경계·Classic98 색상표 문제는 [후속 단계](evidence/studio-pencil-palette.json)에서 수정했다. Android 실기기·Safari 웹·Windows 실행·OS 다이얼로그·물리 펜 지연·장시간 메모리·서명/공증·공개 배포는 이 결과로 완료 처리하지 않는다.


## Bounded mip UI4의 후속 인수

[당시 UI4 근거](evidence/studio-bounded-mip.json)는 같은 타일 cursor의 동기/양보 경로, 최대65,536 source-pixel 진행 단위와 soft4ms MessageChannel 준비를 다룬다. 준비 중 이전 backing을 유지하며 전체 가시 raster가 준비된 뒤에만 공개한다. dirty를 한 번 이관하고 취소·새 문서·카메라·할당 실패·context loss에서 cursor/port/scratch를 정리한다. 단순 도구/스킨 변경은 warm cache를 유지한다. 기존64타일/128MiB 추정 RGBA/512축을 넘기지 않으며 직접 `render()`는 동기 API로 유지한다.

UI4는 필수 타일109·정보4, Node176, 웹48·준비8·Canvas56/문서12와 일반 macOS4단계를 통과했다. 이 목록에 과거 사각 UI35나 연필10을 새 실행으로 더하지 않는다. Chrome uniform/checker 각 n3의 완성 중앙값은 186.6→219.6ms / 361.8→404.0ms로 늘었고, 관측 최대 callback 범위는 173.1~364.2→5.0~9.6ms로 줄었다. 실제 WK uniform n1의 첫 동기 반환/완성/timer gap은 245→5ms / 246→312ms / 246→9ms였으며 전체 Canvas·authority·geometry가 일치했다. WK LongTask API 미지원은 `null`이며 checker는 DPR/mip 불일치로 비교에서 제외했다. 일반 앱에는 계측 overlay/foreground helper를 포함하지 않는다. 물리 표시 지연·실기기·전역50ms·p95·전체 성능 완료는 아니다.

## 선택·문자 alpha의 후속 인수

[현재 근거](evidence/studio-alpha-contracts.json)는 투명 키의 RGB-only 판정과 문자 RGB hex 네 곳을 수정한 배치다. 선택은 alpha와 premul RGB를 함께 비교하며, alpha가 다른 white128/255는 남기고 alpha1의 premul 동등색만 키로 처리한다. 선택 버퍼의 straight/hidden RGB는 보존하고, PNG 합성 출력에서 alpha0 RGB가0인 계약은 따로 확인한다. 문자는 preview/raster에 같은 RGBA를 사용하며 HEX/type=color·brush opacity는 그대로다.

수정 전 선택3실패/4·문자7실패/8을 보존하고, 수정 후 선택 4개·문자 8개과 기존 웹48·pending36·clipboard4를 확인했다. 별도 Qt 문자 6case·84check·완전 coverage 3,680픽셀은 알파 기준이다. 실제 WK alpha 10개(문자6/선택4)은 임시 alphaProbe이며 overlay 없는 일반 앱4단계와 구분한다. Node176은 동일 엔진의 이전 근거이고 UI4 성능도 새 측정으로 세지 않는다. 웹 CI의 `test:alpha-contract`는 새 두 검사를 순차 실행한다. 스포이트 alpha 표시 UX는 별도 미완료 Minor다.

## 남은 구체적 계약 경계

앞서 의심했던 문자 alpha와 투명 선택 키는 재현·수정·좁은 회귀까지 확인했다. 아래는 이 수정으로 완료하지 않은 실제 경계다.

| 우선순위·계약 | 현재 확인 범위와 한계 | 필요한 최소 인수 |
| --- | --- | --- |
| P0 / 자유 선택 mask·음수 이동·F01/F06/F07 | 후속 [선택 근거](evidence/studio-selection-mask.json)의 실제 Qt871 mask/1024축쌍, 공개4shape×key OFF/ON8개·crop4·실패6에서 음수 이동·nearest·copy/cut payload·취소/원본/다른 레이어/hidden RGB/단일 UndoRedo를 확인했다. generic crop 패딩은 유지하고 UI crop intersection만 수정 | Source-clear7·source-less paste4는 후속 확인. 원본 mask의 명시 변형/연속 resize는 후속 인수. 임의 조합·비퇴화 거대 path·전체 F06 및 실기기는 남음 |
| 확인 범위 / 채우기 실패·F03/F10 | 후속 [10개 검사](evidence/studio-fill-failure.json)가 constructor/post·오류/profile/픽셀/좌표·취소/timeout의 기존 안전성과 새 setup 복원을 확인했다. 기존 지연 정상 fill만으로 추정한 결과가 아니다 | 실제20초 timeout 두 번과 retry/UndoRedo·원본/active/saved/Redo 보존은 확인. fill premul/cut flag의 좁은 Qt 대조는 후속 완료. 최대 영역·장기 메모리·전체 F10은 남음 |

고정 DPR·같은 camera/mip의 WK checker 계획은 준비 단계이며 아직 새 성능 실행 근거가 아니다. 넓은 dirty·장기 RSS, 물리 Android/Safari 웹·Windows/macOS OS 통합·IME·출시 인수도 남아 있다. 전체 F06/17도구와 최종 성능을 완료 처리하지 않는다.


## 채우기 실패의 후속 인수

[현재 근거](evidence/studio-fill-failure.json)의 공개 UI 10개는 setup과 Worker 9경계를 각 두 번 실패/취소한 뒤 실제 fill retry와 한 번 Undo/Redo를 확인했다. 수정 전 setup은 overlay 부재·inert 세 곳 잔존으로 실패했다. 수정 후 준비 DOM/controls snapshot은 상태 변경 전에 만들고, inert/readOnly/append/work를 `try/finally`에 포함하며 cancel은 local controller를 사용한다. 원본 pixels·active·dirty/saved·기존 Redo와 제어/Worker/포인터 자원을 비교했다.

timeout은 production 20초를 두 번 실제 기다렸으며 단축한 정책 검사가 아니다. append의 단발 throw는 OOM 실증이 아니고, 이전 취소 버튼의 합성 DOM 재생은 실제 장치 경합이 아니다. Worker 9경계는 기존 코드가 안전했음을 확인한 범위이며 모든 실패에서 새 결함이 있었던 것으로 세지 않는다. 웹 48·pending 36·일반 macOS 4단계는 새 후보에서 통과했고 Node 176과 성능은 이전 표본이다. 이 단계 당시의 fill alpha 동등성은 아래 후속 키 계약의 명시 범위로 갱신한다. 전체 F10·실기기·최종 성능은 미완료다.


## 채우기·선택 없는 cut의 후속 인수

[현재 키 계약 근거](evidence/studio-fill-cut-key.json)는 fill의 premul 동등 연결/NoOp와 cut 투명 키·숨긴 활성 레이어를 다룬다. 최종 Node188(새 flood12), 공개 fill6·cut5·실패10종류×두 번, 실제 WK Worker6 및 오버레이 없는 일반 macOS4단계(scene21)가 통과했다. 실제 Qt fill6/45check·cut5와 straight RGBA 보존 정책을 구분한다. Clipboard PNG는 독립 zlib 판독과 비교했고 실제 OS 권한·물리 입력은 검증하지 않았다. hidden-active는 keyOFF만 샘플링했으며 hidden×keyON 전체 조합 인수로 세지 않는다.

메모리 후보는 full source clone을 없애고 span으로 결과를 만든다. 명시 버퍼 순감소4*N−4B와 full/island 개선을 확인했지만 얇은 ring은 느려졌다. UI/Worker 전체 지연·장기 RSS·최대 문서가 완료된 것은 아니다. 기존 웹48·pending36·clipboard4는 최종 main과 메모리 최적화 전 operations의 v2 표본이다. 앞 단락의 'fill alpha 동등성 미완료'는 당시 상태이며 이번 명시6개로 갱신하고, 전체 F10은 유지한다.

이 fill/cut 단계 당시의 다음 P0였던 자유 선택 mask·음수 이동·resize·투명 키 조합은 아래 후속 인수의 명시 범위로 갱신한다. 고정 DPR WK checker·넓고 분리된 dirty·대형 cut scan/최악 fill·Android 웹·Safari·Windows/OS·출시 항목도 유지한다. 새 UI 검사는 `test:fill-key`, `test:cut-key`로 CI에 연결했다. 원격 CI 실행은 아직 확인하지 않았다.


## 자유 선택 마스크·nearest·음수 crop의 후속 인수

[현재 근거](evidence/studio-selection-mask.json)의 영구 mask871개와 실제 파생 viewport108개(871에 포함)는 엔진 oracle이다. 공개 UI는4shape×투명 키 OFF/ON의8개/88stage, UI crop4, 실패6이다. `test:selection-contract`를 실제 실행해 이18개가 순서대로 통과했고 Node192·기존 웹48/pending36/clipboard4도 최종 소스에서 통과했다. 서로 다른 실행이나 stage 실패36개를 별개 제품 결함 수로 합산하지 않는다.

actual WK는 임시 앱에서 mask871·nearest1024축쌍/2048방향 검사·geometry Worker4를 확인했다. 일반 앱의 저장/복구·codec·종료·scene21은 오버레이 없는4단계다. OS clipboard/picker·실제 펜·모바일 하드웨어 검증은 아니다. Canvas mask 경로를 없앴으므로 baseline readback 실패와 최종 Uint8Array1024B 할당 실패는 서로 다른 경계로 기록했다.

선택 초기 pixels/mask 저장 공간8*S→5*S와 bounded 커널 시간을 확인했지만, path/edge O(P), Canvas 내부·caller·전체 RSS는 별도다. 복잡한 거대 path의 동기 비용·최대 문서·장기 메모리·전체 F06/17도구·Android 웹/Safari/Windows·fixed-DPR WK·출시 gate를 유지한다. 당시 다음 데이터 판정이었던 source-less paste와 투명 배경 Source-clear는 아래 명시 범위로 갱신한다. 이때 남긴 원본 mask 회전/flip/resize는 아래 후속 인수의 명시 범위로 갱신한다.


## 선택 원본 지우기·source-less paste의 후속 인수

[현재 근거](evidence/studio-selection-source.json)의 `test:selection-source` 공개7+paste4가 통과했다. 원본 RGB·mask 밖·다른 레이어·메타데이터, clipboard 거절 뒤 재시도, 저장 취소/Escape·기존 Redo·한 번 UndoRedo를 확인했다. 이미 배경인 선택 삭제는 selection을 닫되 새 revision을 만들지 않는다. source-less cut은 문서/이력 NoOp다. 모델 IPC/clipboard 전달을 실제 OS 인수로 세지 않는다.

같은 최종 source17/asset8에서 Node192·선택18·웹48/pending36/clipboard4, 실제 WK 소유 후보 진단6과 일반 macOS4단계(scene21)를 별도로 통과했다. 순수 메서드 성능96표본은 UI/최대 메모리/물리 입력 성능 검증이 아니다. 이 단계의 다음 원본 mask 변형/음수 조합은 아래 후속 인수로 갱신한다. 전체 F06 완료는 아니다.


## 연속 크기 조절·원본 mask 변형의 후속 인수

[현재 근거](evidence/studio-masked-transform.json)의 `test:masked-transform` 공개9개와 확장 crop10개를 통과했다. 신규 검사는 두 gesture의 원본6라벨·원복 NoOp/Redo, 합성 pointercancel 복원, 원래 크기 경유 후 최종 출력의 고정 기준, 표시 payload 변형 후 기준 교체, profile 거부 뒤 첫 재시도, triangle/hole 원본 mask와 변형 payload·실제 cut PNG·취소/단일 UndoRedo를 다룬다. 키 ON 명시 dialog 크기 왕복 뒤 Arrow/Enter는 단순 payload 원복을 무수정 문서로 오인하지 않음을 확인했다. gesture 안 중간 치수는 pointer target이며 실제 private 상태를 관측한 것으로 세지 않는다.

crop10은 기존4와 사각/자유 선택 × 변형 순서 후 음수 crop·양수 확장·완전 밖 취소6이다. empty crop은 Worker/문서 commit이 없으며 모든 레이어 raw/metadata와 기존 이력 경계를 확인했다. 단일 resize 조합이므로 persistent backing9개와 검증 역할이 다르다. 최종 Node192·기존 선택8/실패6/Source7/paste4·웹48/pending36/clipboard4, 실제 WK 진단4와 표준 일반 macOS4단계(scene21)도 별도로 통과했다. Qt12/104·브라우저9·WK4·일반 앱4를 같은 플랫폼/단위로 합산하지 않는다.

유한한 명시 사례이며 모든 mixed alpha·투명 키·레이어·변형 순서·장치·F06/17도구 인수가 아니다. 대형 path/handle 동기 CPU·장기 RSS·동일 DPR WK·Android 실제 웹/Safari/Windows·OS clipboard/picker/IME·출시 gate는 유지한다.


## 선택 성능의 좁은 후속 인수

[현재 근거](evidence/studio-selection-performance.json)의 `test:masked-transform`은 기존9+반복 rounded target1개의10개/68stage다. trusted down 뒤 합성 move4/up1의 동기 출력 생성만 관측하며 physical pen·시간/RSS 시험은 아니다. guard 없는 고정 word는5회 신호로 한 stage 실패, 최종은1회·raw/독립PNG·실제 다른 target 복귀·EnterNoOp/oldRedo/cleanup이 통과했다.

Node198은 기존Qt871(sparse)와 denseQt12, 원시 RGBA/offset/odd tail·다층·최대축·추가 workspace 단발 실패/retry를 포함한다. denseQt11개에서 실제 branch를 확인했고62076 rowmodel은 실제Qt 사례 수에 더하지 않는다. 기존 선택8/crop10/실패6/Source7/paste4·웹48/pending36/clipboard4, legacy CTest5, 실제WK 진단4와 표준macOS4단계도 통과했다. WK의 mask12·직접pointer 검사는 공개 native gesture/OS 검증과 다르다.

actual ordinary-web n1/variant는 원본/raw/Canvas 동일과 출력 요청5→1·관측 upload30→6을 확인했다. 마스크 paired40은 dense512/2048에서 개선, ordinary/128의 일부 중앙값은 퇴행/변동이다. 최대 sentinel59.8ms이므로 전체50ms/p95·실기기 목표는 미인수다. 새 크기 재샘플·매우 큰 path/preview는 여전히 동기이며32Mi 최대출력/장기 RSS·동일DPR WK/넓은dirty·전체F06/17도구·Android웹/Safari/Windows/OS·출시 gate를 유지한다.


## 큰 선택 준비 후속 — 2026-11-05

큰 올가미 준비의 local acceptance: Node208, 공개13(실제 선택/PNG Worker, literal Qt 삼각형·독립 PNG reader, 취소/Escape/blur/hidden/late reply/실패), 기존7suite 모두 PASS. source11mutations·task/channel setup 및6wait cancellation은 모델 테스트다. 실제 macOS 일반4(scene21)와 별도 WKdirect4 PASS, 표준 앱 복원 SHA 대조. 조건별n1 pointerup188.6→1.3ms, 새ready210.5→239.7ms, 타이머최대211.9→24.3ms이므로 전체50ms/p95/성능 무퇴행 인수는 미완료. 공개 새13의 seeded oldRedo/fresh large retry, 물리 Android 웹/펜·Safari·Windows·OS/IME·장기RSS·서명/출시는 별도 미확인이다. 모바일 웹 전용 정책 유지. [고정 실행·리뷰 자료](evidence/studio-selection-preparation.json).


## 선택 첫 화면 비용 후속 — 2026-11-05

이번 cut 콜백 변경은 Node211(새3/22,400모델조합), frozen 이전main 대비 actual DPR1/2 Canvas56·문서12·retry2 byte-equal, 기존9suite, 실제 macOS 일반4(scene21)로 확인했다. 성능은 ordinary-web 조건별n1 첫RAF58.1→15.7ms/완료74.0→31.3ms. 업로드·신규 ImageData/surface 각각18개는 동일하며 전체cache/RSS를 뜻하지 않는다. Software Canvas비교와 Metal성능표·별도CDP 진단을 구분한다. 전역50ms/p95/물리Android웹·Safari·Windows·OS/IME·서명/출시는 미인수다. [고정 측정·검증 자료](evidence/studio-selection-preview.json).


## nearest 크기 변경 후속 인수 — 2026-11-06

국소 개선 후보는 단위 217개·공개 UI 9개 묶음·Canvas 56개 비교와 실제 WK 진단 4개·일반 macOS 4단계를 통과했다. 실제 UI 10회는 첫 3축의 전후 각 1회와 8191px 추가 교차 4회다. 8191px 각 3회 중앙값 68.4→68.7ms, 가로 2배 56.2ms, 세로 ready 증가와 남은 50ms/p95·RSS·물리 입력 인수를 명시한다. Android/태블릿은 실제 웹 검증 대상으로 유지하며 모바일 실행파일을 만들지 않는다. [측정·구현·독립 검증 근거](evidence/studio-nearest-resize.json).


## 분할 handle resize 후속 인수 — 2026-11-06

단위 229개·공개 resize 10개/전체 10묶음·후보 Canvas 56개 비교·WK 진단 4개·일반 macOS 4단계를 통과했다. 실제 20초 timeout과 대기 중 Enter/저장 거부·취소·late callback·원본 PNG를 확인했다. 390px touch-capable 에뮬레이션의 입력은 mouse이므로 실제 Android/태블릿 touch 인수와 구분한다. 새 UI 세 표본의 콜백 0.4–0.8ms와 ready 약 0.7초, 별도 동기 API 70회·가로 cold 퇴행·RSS/물리 입력/원격 CI 미완료를 함께 유지한다. [분할 resize 구현·실행·독립 검토 근거](evidence/studio-bounded-resize.json).

### 2026-11-06 웹 산출물 경계

[Studio staging 근거](evidence/studio-staging.json): 앱 runtime17/Vite8은 그대로 두고 builder/stager를 구현했다. 로컬 payload9(기존8+LICENSE)/276,578B, Python43·CTest6그룹·Chrome staging16·별도 storage13이 통과했다. 합성 B와 idle A의 첫 Worker/JPEG 및 롤백을 확인했다. 실제 Pages 헤더/캐시·dirty/pending 탭·Qt가 작성한 복구 인계·Windows/원격 CI는 별도 gate다. QF-32 전체 완료는 아니다.

### 2026-11-06 JPEG EXIF 8방향

[실행·영구 회귀 근거](evidence/studio-jpeg-orientation.json). 공개 JPEG 열기·프로젝트 저장의 방향 8개 전체 RGBA·코너·치수, no-EXIF 제어 1개·HTMLCanvas 대체 1개·bitmap 거부 시 기본 clean 문서 보존 1개가 통과했다. `test:jpeg-orientation`를 웹 CI에 연결했다. 제품 소스17·기존 자산8은 불변이다. 오류에서 Redo/pending 전 조합, 다른 JPEG 변형/브라우저·실기기, QF-16 전체 완료를 뜻하지 않는다.

### 2026-11-06 반경 정책·표면 자원 정리 채택

[고정 실행·독립 검토](evidence/studio-roundrect-contract.json). 새 둥근 사각형의 x/y 반경을 각각 최대 12로 정하고 기존 float 범위·Shift·퇴화 scalar 0을 유지했다. 컨텍스트 획득도 소유 함수의 try/finally 안으로 옮겼다. 수정 전 null/throw 주입 4개에서는 표면 512×96이 남았고, 최종 Offscreen/HTML 양쪽에서는 0×0이며 원본·기존 Redo를 보존했다. 영구 회귀 24개를 CI에 연결했다.

실제 compositor UI 8개는 중간 안정 후보 654와 화면·프로젝트·PNG 40쌍이 byte-exact하게 같았다. 여기서 654는 이미 최대 12 정책을 가진 후보이며, 최초 반경 14와의 무변경 증명이 아니다. 미채택 hint는 그 미리보기를 유지하면서 확정 결과만 바꿔 실제 경계색 snap을 만들었다. 실제 WK의 알고리즘·Surface 검증은 번들 UI의 4단계 검증과 별개이며, 기존 경계 AA의 strict seam은 false로 보존한다.


## 2026-11-06 카메라·VisualViewport·무변형 선택

[수정·원인·검증·정정](archive/STUDIO_CAMERA_VIEWPORT.md), [고정 근거](evidence/studio-camera-viewport.json). 새 공개17개·Node232와 최종 기존 입력/선택/웹/출력·macOS 회귀를 통과했다. 휠 중 투영 Major, VV 확대·문자 원점/중복 observer·밀도 취소 Minor를 수정했다. 미변형 선택4K 두 레이어의 동기 slice는128MiB→0이며 draw(true)·엔진 검증·NoOp/Redo를 유지한다. 과거 forced-gutter42/48px 추론은 실제 hit 증거에 따라 철회하고 본문에 범위를 명시했다. 물리 Android 웹·OS IME/파일·Windows·보조공학·출시 및 선행 게이트는 남기며 전체 체크를 닫지 않는다.


## 2026-11-06 자동 복구의 오류 경계와 비용

[현재 분석·수정·검증](archive/STUDIO_RECOVERY_SNAPSHOT.md), [고정 근거](evidence/studio-recovery-snapshot.json). injected missing/null 출력의 false success→같은 revision 재시도 억제와 이전 epoch 오류 표시를 수정했다. 공개5·단위234·저장13·native IPC 모델15·웹48·실제 macOS4단계를 확인했다. 기준 clone/Worker/storage n3는 모델·실제 IDB를 분리하며, 성능 개선이나 실제 OS I/O/물리 장치 인수로 세지 않는다. full codec 응답 계약·Worker 내부 CPU/entropy·실제 플랫폼·전체 선행 게이트는 남는다.


## 2026-11-06 Codec10 응답과 Worker 비용

[분석·수정·검증·잔여 조건](archive/STUDIO_CODEC_REPLY.md), [고정 근거](evidence/studio-codec-reply.json). 잘못된파일 성공표시·조건부clipboard cut·typed state/sparse색상·fill응답 경계를 owner에서 닫았다. 동일공개27개 기준22실패/5대조통과→후보27통과, 독립계약89·전체Node323과기존회귀를확인했다. macOS최초20초timeout을보존하며동일binary재시도4단계는통과했다. Worker의지배비용은입력에따른압축·CRC였고CRC임시후보는low혼재로비채택했다. 정상Worker자연장애·OSclipboard·실기기·무회귀성능·전체출시완료로확대하지않는다.
