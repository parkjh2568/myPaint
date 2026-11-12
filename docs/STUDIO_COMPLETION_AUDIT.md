# Studio 전체 완료 조건 감사

2026-11-06. [조건별 원문과 현재 소스·검증 근거](evidence/studio-completion-audit.json). 이 감사는 구현 존재, 실제 검증 범위, 선행·플랫폼 게이트를 분리한다. 전체 목표의 완료 선언이 아니다.

최초 감사에서는 34개 중 자체 조건 입증 6개, 부분 충족 25개, 미구현 3개였다. [Studio 로컬 staging](evidence/studio-staging.json) 구현 뒤 당시 판정은 6/26/2였다. 원문 JSON의 6/25/3은 수정 전 snapshot으로 보존한다. 후속 [독립 기준 목록](archive/STUDIO_FIXTURE_BASELINE.md) 완료로 현재 판정은7/25/2, 후속 [QF-04 계약 감사](STUDIO_DOCUMENT_CONTRACTS.md)까지 완료해 선행까지 닫힌 항목은 QF-01/QF-02/QF-04다. 자체 집계7/25/2는 그대로이며 다른 태스크의 최신 조건별 인수는 별도다.

직전 로컬 제품은 [네이티브 저장 기준·복구 조회 소유권](archive/STUDIO_NATIVE_OWNERSHIP.md)의 entry `assets/index-DLvOR2As.js`다. 저장 후 외부 파일 버전을 기준으로 채택하던 Major와 자동/수동 복구 조회 경합 Minor를 수정했다. 실제 Rust19·Node323·기존 웹48·native IPC 모형15·독립/영구 복구 UI 각7개가 통과했다. 같은 시나리오의 반복을 별도 기능 수로 합산하지 않는다. 후속 [독립 기준 목록·GUI 재검증](archive/STUDIO_FIXTURE_BASELINE.md)에서는 같은9f01 바이너리의 일반 macOS 실행4단계가 통과했다. 앞선20초 `project-read-large` 실패와120초 smoke 미완료·성공 marker 없음도 보존한다. 20초 실패의 관측 단계와120초 실행의 미관측 단계를 구별하며, 원인은 미확정이다. 간헐적 안정성·다른 플랫폼·출시 게이트는 남긴다. 이전 [관측·CRC 실험](archive/STUDIO_NATIVE_TIMING.md)의 통과는 당시 바이너리의 결과로 보존한다.

최신 웹 후보는 [QF-04 계약 감사·늦은 복구 오류 수정](STUDIO_DOCUMENT_CONTRACTS.md)의 `assets/index-DIgO41Ne.js`다. main의 catch epoch guard 한 줄만 제품에 추가했고 저장/복구16·조회흐름7·내보내기12가 통과했다. payload9개/291,664B이며 native 앱은 이번 단계에서 재빌드/재실행하지 않았다. QF-02의 독립 자료와 이전9f01 바이너리의 macOS4단계는 각각 당시 범위로 유지한다.

후속 [최신 소스 macOS 앱 재검증](archive/STUDIO_NATIVE_CURRENT.md)에서 main48695를 포함한 새 바이너리d1da의 일반4분기가 통과했다. 이전 단락의 미재빌드 기록은 QF-04 당시 범위로 보존한다. 과거 timeout 원인·OS picker/IME·Windows/실기기·성능/출시 게이트는 계속 열려 있다.

[QF-03 측정기 보완·방법 검증](archive/STUDIO_MEASUREMENT_METHOD.md)을 진행했다. 제품은 같으며36개 Node 관측행·분리 UI/Worker 파일럿을 실제 성능/출시 인수로 확대하지 않는다. 첫 통합 budget 실패도 그대로 보존한다. 자체 집계7/25/2와 선행 완료01/02/04는 바꾸지 않는다.

[공통 코어 fixture·교차 검증](archive/STUDIO_MATCHED_CORE.md)에서 같은 입력으로 Qt/Node 각12 API 작업과 교차3파일씩을 확인했다. 소표본·런타임·압축·UI/실기기 범위를 구분하며 전체 집계와 완료 체크는 추가로 닫지 않았다.

| 태스크 | 자체 조건 | 현재 판정과 남은 범위 |
| --- | --- | --- |
| QF-01 | 자체 조건 입증 | 전환·플랫폼·로컬 계약 결정 |
| QF-02 | 자체 조건 입증·완료 | 독립 입력/예상 상태·도구/실패 목록·허용 차이를 고정; 전체 옵션/플랫폼 인수와 분리 |
| QF-03 | 부분 충족 | 측정기 v2·공통 코어 API fixture 검증; 실제 UI/Worker profile·Android 상세/실기기·안정 tail·예산 인수 남음 |
| QF-04 | 자체 조건 입증·완료 | 원문13세부 조건의 최신 계약·독립 기대값 대조, 늦은 오류 세대 경계 수정; 선행 QF-02 충족 |
| QF-05 | 자체 조건 입증 | 자체 빌드·타입·포맷 입증; 선행 QF-03 미완료 |
| QF-06 | 자체 조건 입증 | 자체 상태·할당 실패 계약 입증; 선행 QF-04/05 인수 |
| QF-07 | 부분 충족 | 둥근 브러시 옵션·필압·물리 입력 |
| QF-08 | 자체 조건 입증 | 자체 이력 계약 입증; 선행 QF-07 미완료 |
| QF-09 | 자체 조건 입증 | 자체 형식·알파·손상 입력 계약 입증; 선행 게이트 |
| QF-10 | 부분 충족 | 입력·Worker/fallback/작업량 경계 전체 인수 |
| QF-11 | 부분 충족 | 같은 Qt/신규 workload 및 조건부 진행 판정 |
| QF-12 | 부분 충족 | 기본 도구의 남은 옵션·장치 조합 |
| QF-13 | 부분 충족 | 독립 축 최대 12·기존 float/퇴화 정책, 공개 24·자원 정리 확인; 전체 옵션·장치·기존 WK 경계 AA 게이트 |
| QF-14 | 부분 충족 | 명시되지 않은 선택·한도·실패 조합 |
| QF-15 | 부분 충족 | 실제 OS IME 및 글꼴 준비 정책 |
| QF-16 | 부분 충족 | Chrome EXIF 8방향·Surface 대체·기본 문서 오류 보존 확인; 전체 형식·레이어·변형/실패·다른 브라우저 인수 |
| QF-17 | 부분 충족 | 미확정 편집·출력 바탕 미리보기 및 Classic 대비 구현·Chrome 검증; 실제 WK/Safari·최대 경계·선행 게이트 |
| QF-18 | 부분 충족 | 레거시 복구·이전 탭·저장소 인계 |
| QF-19 | 부분 충족 | 크기·원점 변경 입력 롤백과 정지 선택/문자·줌·Redo 검증; 실제 VisualViewport/OS 키보드·IME/회전 인수 |
| QF-20 | 부분 충족 | 두 스킨·coarse/수동 touch 48px hit 및 스크롤바 예산 검증; 실제 장치·DPR·펜/터치 혼용 |
| QF-21 | 부분 충족 | 전체 패널·스킨·IME/pending 인수 |
| QF-22 | 부분 충족 | 대비·보조공학·DPR와 아이콘 식별 인수 |
| QF-23 | 부분 충족 | 미변형 선택128MiB 복사 제거·NoOp/Redo 확인; 복구 snapshot·장기 자원 인수 |
| QF-24 | 부분 충족 | 복구 재시도/epoch 오류 수정·단계 비용 분해; 실제 WK/OS I/O·최대 입력·RSS/지연 인수 |
| QF-25 | 부분 충족 | 조건부 Wasm 도입/미도입의 명시 판정 |
| QF-26 | 부분 충족 | 조건부 GPU 도입/미도입의 명시 판정 |
| QF-27 | 부분 충족 | 로딩·DPR·장기 자원 수명 |
| QF-28 | 부분 충족 | Windows 및 실제 OS 통합·성능 |
| QF-29 | 부분 충족 | OS별 파일 실패·저장소 인계·패키지 인수 |
| QF-30 | 부분 충족 | 실제 Android 웹·Windows·OS·통합 성능 |
| QF-31 | 부분 충족 | 공개 CI·고지·문서·의존성 최종 인수 |
| QF-32 | 부분 충족 | 로컬 build/manifest/staging·old tab 지연 자산 검증 완료; 공개 Pages 헤더/캐시·복구 인계·선행 게이트 |
| QF-33 | 미구현 | 출시 후보·승인된 게시·공개 URL 인수 |
| QF-34 | 미구현 | 출시 안정화 후 Qt 경로 정리 |

## 진행 순서

1. QF-32의 로컬 build/manifest/staging은 구현했다. Qt 혼합 릴리스·다른 홈페이지 파일·Git index·수동/staged 변경·symlink·복사/설치 실패와 이전 탭의 첫 Worker/JPEG 로딩을 임시 Git/HTTP에서 확인했다. 실제 Pages 헤더/캐시·Qt가 쓴 복구의 인계·미저장 탭 전환과 선행 게이트는 남긴다. 실제 홈페이지 게시나 commit/push는 하지 않았다.
2. 둥근 사각형은 독립 축 최대 12·기존 float/퇴화 정책과 컨텍스트 실패 정리를 채택했다. 읽기 hint는 실제 화면 회귀로 미채택했다. JPEG EXIF 8방향도 영구 회귀로 확인했으며, 전체 도형·형식·변형·실기기 인수는 계속 진행한다.
3. 출력 바탕과 터치 표적의 Chrome 계약을 검증했다. 크기·원점 변경 중 입력 투영과 정지 pending 보존도 수정·확인했다. 후속 카메라 단계에서 VV/API 모델과 확대를 검증했으며 실제 OS·보조공학 인수는 남는다. 창 크기 에뮬레이션을 실기기 인수로 대체하지 않는다.
4. 미변형 선택 복사는 실측 후 좁은 guard로 제거했다. 자동 복구의 단계 비용과 오류 경계를 확인했다. 10개 codec 응답과 Worker 비용을 분해했다. 후속 macOS 단계에서 검증 전용 실패 위치 관측을 보완했고 같은 바이너리 및 최종 앱의4단계가 통과했다. 동일 생산 소스 빌드의 CRC 후보도 low/high 혼재로 비채택했다. 첫 timeout 원인·실제 플랫폼 입력/OS I/O·메모리와 지연 예산은 계속 검증한다.
5. 대상 장치·예산과 조건부 기술 결정을 명시하고 물리 Android 웹/Windows·OS 파일/IME·CI·서명·공개 인수 게이트를 별도 진행한다.

## 확정 문제와 미확정 사항

입력 투영 소유권 Major는 공개 재현 후 수정했고, 최종 범위에서 추가 Blocker/Major/Minor는 없다. 48px 선언 충돌과 별도 태블릿 외곽 잘림은 실제 hit 검사로 확인·수정했다. 강제 gutter의42/48px 잘림 추론은 아래 정정 기록에 따라 철회한다. 이 판정은 해당 소스/검증 조합에 한정한다. 둥근 사각형의 기하/래스터 정책 차이와 자동 복구 snapshot 비용은 별도 잔여 작업이다. 미변형 선택 clone은 후속 단계에서 제거했다. 출력 미리보기는 구현했으며 플랫폼·최대 경계 인수가 남는다. JPEG 방향 fixture 공백은 후속 Chrome 영구 회귀로 좁혔다. 이를 모두 픽셀 결함이나 성능 Major로 묶지 않는다.

이전 99ms 지연은 새 재현에서 확인하지 못했고 원인은 미확정이다. 정확성은 통과하지만 실측 응답성이 나빠진 후보들은 제품에 반영하지 않았다. 임계치 조정의 반복보다 확인된 미구현·미검증 계약을 우선한다.

서버 DB·계정 로그인은 승인된 오프라인 그림 앱 범위 밖이다. 브라우저 origin·파일/클립보드 권한, IndexedDB 복구 스키마, 로컬 IPC 경계는 기존 아키텍처에 명시돼 있다. 새로운 원격 서비스는 추가하지 않는다.

모바일·태블릿은 웹만, 설치형은 Windows/macOS만 제공한다. Android 기기는 사용 가능하다고 확인됐지만 현재 호스트에서 adb/표준 SDK platform-tools는 찾지 못했으며 이번 감사에서 실제 기기 시험은 하지 않았다.

## Studio staging 후속 검증

[실행·독립 리뷰 근거](evidence/studio-staging.json). 새 빌더는 기본적으로 `dist/studio`만 생성한다. 배포 payload는 기존 Vite 8개와 LICENSE를 합한 9개, 276,578바이트다. SDK·node_modules·Rust target·소스 압축은 포함하지 않는다. 기존 런타임 17개·Vite 자산 8개와 두 저장소의 Git index/config 4개는 불변이다.

Python 회귀 43개(빌더 16·staging 27), macOS의 Qt 포함 CTest 6그룹이 통과했다. 실제 Chrome에서는 staging 전용 16개와 기존 저장소 회귀 13개를 분리했다. A 탭이 idle인 상태에서 합성 B를 반영한 후 A의 첫 Worker와 JPEG 지연 import, B 새 탭, A 롤백을 확인했다. 실제 Pages나 dirty/pending 탭 전체 인수로 확대하지 않는다.

독립 리뷰에서 후보 LICENSE의 symlink/hardlink가 외부 파일을 덮던 Major를 찾아 새 파일의 배타 생성으로 수정했다. 일반 파일·symlink·hardlink 세 충돌에서 외부 파일과 기존 번들을 보존했다. 현재 검토 범위의 추가 Blocker/Major/Minor는 0개다. 이전 감사의 터치 표적 Minor와 다른 태스크 잔여 사항은 계속 유효하다.

## JPEG 방향 후속 검증

[JPEG 방향 실행·fixture·독립 검토](evidence/studio-jpeg-orientation.json). `test:jpeg-orientation`를 웹 CI에 추가했다. 실제 파일 열기→디코딩→프로젝트 저장의 8방향 전체 RGBA·코너·치수와 no-EXIF 제어 1개, HTMLCanvas 대체 1개, 디코더 거부의 기본 문서 보존 1개가 통과했다. 손실 JPEG의 실제 base 픽셀과 독립 literal 순열을 비교한다. 새 방향 디코더를 구현한 것이 아니라 기존 동작의 검증 공백을 닫은 작업이다.

제품 runtime17·기존 Vite8은 불변이다. 같은 입력 snapshot에서 앱 타입 검사·테스트 포맷·실제 번들 빌드가 통과했다. 오류 인수는 기본 clean 문서의 pixels/active/visibility에 한정하며 Redo/pending·복잡 metadata까지 확대하지 않는다. 다른 JPEG 변형·손상/대형 입력·다른 브라우저/물리 기기 및 QF-16 전체 조건은 남긴다.

## 둥근 사각형 기하 조사

[Qt·실제 Canvas 조사와 후보 미채택 근거](evidence/studio-roundrect-geometry.json). Qt 14입력의 fill/outline 56래스터와 실제 Canvas 224프로토타입을 비교했다. 반경 14→12만으로 짧은 축의 타원 코너나 QRect의 순/역방향·point/line·floor 차이가 해결되지 않는다. 현재 Studio endpoint를 유지하는 축별 최대12 후보와 엄격한 Qt endpoint 복원은 별개 정책이다. 제품 기하는 변경하지 않았다.

동일 기하의 초기 Canvas 출력 차이는 별도 96프레임의 고정 조건에서 조사했다. 조건 내부 반복은 같았고 readback context와 fresh default context 사이에서 경계 alpha 차이가 있었다. 내부 backend 전환은 직접 관측하지 않았으며 실제 앱의 preview/512타일 결함이라고 판정하지 않는다. 224/96은 진단 프레임이며 공개 UI 정확성 검사 320개로 세지 않는다. 다음은 안정된 조건에서 공개 미리보기·저장·확정·Undo/cancel·DPR/512 seam을 비교해 도형 endpoint 정책을 정하는 작업이다.

## 둥근 사각형·자원 정리 구현 결과

[최종 소스·실행·독립 리뷰 근거](evidence/studio-roundrect-contract.json). 새 반경 정책과 컨텍스트 획득 실패 정리를 main의 두 메서드 안에서 수정했다. source17 중 main 하나만 바뀌며 surface API·엔진·형식·Rust는 원본과 같다. 컨텍스트 null/throw의 기존 후보는 Offscreen/HTML 4개 주입에서 표면 512×96을 남겼고, 최종 후보는 0×0으로 정리하며 원본·기존 Redo를 유지한다.

최종 공개 24개·도형 23개·pending 36개·웹 48개·Canvas 56개/문서 12개/재시도 2개·Node 229개·실제 macOS 4단계가 통과했다. 독립 compositor UI 8개는 최대 12의 중간 안정 후보와 화면·프로젝트·PNG 40쌍이 byte-exact하다. 각각의 검증 범위를 넘는 수치 합산이나 물리 기기 인수로 확대하지 않는다.

읽기 hint는 prototype에서 readback 비용과 WK seam을 개선했지만 실제 DPR 1의 미리보기→확정 경계색 차이를 1→최대 124로 키웠다. 그 후보와 선택 인자는 제품에서 제거했다. 기존 WK 경계 AA의 alpha 1/RGB 2 편차와 strict seam false는 Minor P2로 남긴다. 이는 전체 그림의 데이터 손실이나 신규 P0/P1 회귀로 확인된 사항이 아니다.

QF-17의 bounded 미리보기는 후속 [구현·검증 보고서](archive/STUDIO_EXPORT_PREVIEW.md)에 반영했다. 현재는 원본 전체 복사 없이 미확정 선택·문자·도형과 상위 레이어를 합성한다. 전체 태스크의 선행·플랫폼 게이트와 다음 우선순위는 위 진행 순서를 따른다.


## 카메라·VisualViewport 후속 및 gutter 정정

[최신 근거](archive/STUDIO_CAMERA_VIEWPORT.md). 위 날짜별 원문은 당시 소스·검증 범위다. 강제 gutter의 clientWidth 차이로 추론한42/48px hit 손실은 실제 Mac Chrome 스크린샷·가장자리 클릭과 맞지 않아 철회한다. 별도 태블릿 외곽 잘림과 intrinsic 예산 개선은 유지한다. 새 단계에서도 전체34태스크의 완료 체크는 추가로 닫지 않았다.
