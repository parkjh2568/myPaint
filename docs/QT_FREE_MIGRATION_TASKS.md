# Qt-free 전환·전체 기능·UI·성능 최적화 태스크

2026-11-04 / 실행 백로그. 사용자 요청에 따라 기존 코드 검토, 수정 결과, 웹 배포/용량 정리, Studio 개선, 투명도·반응형·스킨 계획, Qt 제거 영향도를 통합했다. 이 문서는 실행 백로그다. 실제 부분 구현·검증·미완료 전환 조건은 [Studio 구현 기록](STUDIO_IMPLEMENTATION.md)에 갱신한다. 전체 완료 보고가 아니다.

## 1. 실행 방향

권장 기본 구조는 **TypeScript + Vite + DOM/CSS UI / 독립 문서·픽셀 엔진 / Canvas2D 표시 / 측정에 따른 Worker 활용**이다. Qt 없는 C++/Rust Wasm과 GPU 렌더러는 실제 병목·이득이 확인될 때 채택한다. 데스크톱은 같은 웹 엔진의 Tauri 셸을 우선 검증 후보로 삼되 실제 OS 성능·입력·저장 결과로 결정한다.

대상 플랫폼은 **모바일·태블릿은 웹 브라우저만, 설치 실행파일은 Windows/macOS만**으로 확정했다. Android APK/AAB, iOS/iPadOS 앱, 모바일 Tauri 프로젝트와 스토어 배포는 범위에 포함하지 않는다. Android 실기기에서는 Chrome의 펜·터치·파일 다운로드·복구를 확인하며, iPhone/iPad는 Safari 웹 호환성 확인 대상으로 남긴다. 모바일 UI는 OS 이름만으로 판별하지 않고 화면 크기와 실제 포인터 능력으로 반응한다.

전체 대체가 검증되기 전에는 기존 Qt 앱과 홈페이지를 보존한다. 새 제품 코드는 `web-app/`에 격리하고 기존 Qt 웹 호스트인 `web/`와 혼합하지 않는다. 최초 PoC는 Qt Core/Gui까지 제거한 실제 독립 경로여야 한다. UI만 새로 만들고 Qt Wasm을 내부에서 계속 로드하는 것을 완전 제거로 표시하지 않는다.

‘완전 최적화’는 모든 기기의 무지연·전역 최적해를 보장한다는 뜻으로 사용하지 않는다. **기능·데이터 계약을 지키면서 목표 기기의 측정 예산을 충족하고, 확인된 주요 병목과 불필요한 복사/할당/작업을 제거한 상태**를 완료 기준으로 삼는다. 실제 이득이 없는 최적화는 채택하지 않는다.

## 2. 이미 완료된 일과 신규 범위

| 구분 | 현재 확인 상태 | 이번 백로그에서의 취급 |
| --- | --- | --- |
| 레거시 검토와 F01~F10 수정 | 기존 코드에 적용·검증 기록 있음 | 다시 미해결로 등록하지 않고 새 엔진의 회귀 조건으로 이식 |
| Qt 네이티브·웹·파일·IndexedDB 복구 | 구현 및 macOS/Chrome 검증 기록 있음 | 동작·실패·비동기 확정 계약 보존 |
| Studio UI·브러시 개선 | 작업 트리에 적용, 일부 변경 미커밋 | 기준 구현으로 보존. 신규 제품은 아래 태스크로 재구성 |
| 홈페이지 중복·불필요 대형 산출물 | 약 104.46→20.40 MiB 정리와 재발 방지 도구 적용 | 새 manifest/자산 구조로 검증·중복 방지 정책 이식 |
| 투명도·반응형·스킨·아이콘 | 새 앱에 구현하고 일부 브라우저 검증 | 전체 실기기/예외 인수는 미완료 |
| Qt 제거 영향도·성능 기준 | 기존 구현 측정 완료 | 신규 엔진과의 동등 조건 비교는 QF-03/11에서 수행 |
| 신규 Qt-free 앱·셸 | web-app/에 독립 엔진·웹 UI·macOS 셸 구현 및 부분 검증 | 미완료 전환 조건을 유지하며 기존 앱 대체 전 통합 인수 |

후속 실제 구현/수정: [로컬 계약·아키텍처](STUDIO_ARCHITECTURE.md), [독립 리뷰·RCA·성능](archive/STUDIO_REVIEW_AND_RCA.md). 이번 공개 UI45개·엔진26개의 통과는 아래 전체 전환 조건의 완료와 구분한다.

기존 자료: [코드 검토](https://github.com/parkjh2568/myPaint/blob/cc5f0994df35553b987c523b164cfe0ac0fd738c/docs/CODE_REVIEW.md), [수정 결과](archive/IMPLEMENTATION_RESULTS.md), [웹 구현 결과](archive/WEB_IMPLEMENTATION_RESULTS.md), [용량 정리](archive/WEB_SIZE_CLEANUP.md), [Studio 결과](archive/STUDIO_UPGRADE.md), [UI 계획](https://github.com/parkjh2568/myPaint/blob/cc5f0994df35553b987c523b164cfe0ac0fd738c/docs/UI_EVOLUTION_PLAN.md), [Qt 제거 영향도](archive/QT_EXIT_ASSESSMENT.md).

[후속 native 프로필·타일·Worker 구현과 검증](archive/STUDIO_NATIVE_PROFILES.md), [native 저장·복구 구현과 검증](STUDIO_NATIVE_PERSISTENCE.md), [최대 문서·PNG·동작 계약 검증](archive/STUDIO_MAX_DOCUMENT.md)을 추가했다. [기능 인수 추적표](STUDIO_ACCEPTANCE_MATRIX.md)는 F01–F10과17개 도구의 실제 근거/미확인 조합을 유지한다. 후속 [미확정 편집·클립보드 계약](evidence/studio-pending-contracts.json)에서 F05 행렬/Redo 보존과 F01/F07 성공 payload·확장 crop을 확인했다. 태스크 완료 체크는 모든 완료 조건을 충족한 경우에만 갱신하며, 최대 메모리·실기기·복구/배포 게이트는 계속 열려 있다.

## 3. 최적화 설계 원칙

- 픽셀·레이어·이력은 엔진이 소유한다. UI 상태에는 도구·슬라이더·선택 ID 등 작은 값만 둔다.
- 한 획의 임시 변경과 확정 상태를 분리한다. 검증/할당 실패나 취소는 원본·Redo·이전 복구 사본을 보존한다.
- 변경 영역을 시작부터 추적하고 패치 이력을 사용한다. 매 포인트 전체 레이어 복사·PNG/DataURL 이력·전체 readback·전체 JSON 직렬화를 하지 않는다.
- 입력과 장기 코덱 작업의 경계를 분리한다. Worker 하나에 긴 동기 코덱을 넣고 UI만 움직이는 상태를 응답성 개선으로 판정하지 않는다.
- 필요한 snapshot 복사는 내보내기/복구 경계에서 한 번 수행할 수 있다. ‘어떤 복사도 금지’처럼 데이터 보존을 해치는 규칙은 두지 않는다.
- 단일 스레드와 현재 Pages 헤더에서도 실행되는 경로를 유지한다. SharedArrayBuffer·멀티스레드 Wasm을 초기 필수 조건으로 만들지 않는다.
- 작업을 소유한 함수 안의 순차 로직은 인라인으로 둔다. 실제로 공유하는 의미·자원 소유권·플랫폼 경계만 분리한다. 버튼/대입마다 wrapper나 과도한 Service/Repository 계층을 추가하지 않는다.
- 형식 호환·픽셀 보존·안전한 저장·입력 취소가 성능보다 먼저다. 최적화를 위해 사용자의 그림이나 편집 이력을 조용히 줄이지 않는다.

## 4. 순서·의존성·출시 게이트

우선순위는 P0=데이터/전환 필수 또는 출시 차단, P1=기능 동등성·사용성·실측 최적화, P2=조건부 가속/안정화 후 정리다. **의존성을 먼저 충족**하며, 뒤 단계의 P0 인수를 초기 코어 구현보다 먼저 실행하지 않는다. 비용 M/L은 상대적 변경·검증 범위이며 일정 약속이 아니다.

| 단계 | 태스크 | 통과 조건 |
| --- | --- | --- |
| A. 기준 고정 | QF-01~05 | 범위·파일/알파 계약·fixture·실기기/성능 방법·독립 빌드 준비 |
| B. 핵심 PoC | QF-06~11 | Qt 없는 실제 그리기·레이어·Undo·PNG/RPAINT01의 데이터/성능 판정 |
| C. 기능 동등성 | QF-12~18, QF-31 조기 연결 | 모든 기존 도구와 파일/복구/예외 경계 이식 |
| D. UI와 입력 | QF-19~22, QF-28 셸 검증 | 화면 크기·터치·스킨·아이콘·접근성과 설치형 방향 검증 |
| E. 실측 최적화 | QF-23/24/27, QF-29 | 주요 병목·메모리·장기 작업과 네이티브 안전 저장 인수 |
| 선택 가속 | QF-25/26 | 필요 시 채택. 불필요하면 근거를 남겨 미채택으로 종료 |
| F. 출시 인수 | QF-30~33 | 실기기·CI·성능 예산·복구 이행·안전 배포/되돌리기 |
| G. 최종 정리 | QF-34 | 신규 제품 안정화 후 활성 Qt/전환 경로 제거 |

QF-31의 CI는 QF-11 직후부터 연결한다. QF-19~22의 UI는 핵심 엔진 판정 후 시작할 수 있으며 모든 도구 이식이 끝날 때까지 기다릴 필요는 없다. 각 작업은 자체 의존성을 따른다. QF-25/26을 채택하면 해당 경로의 호환·fallback·성능 검증도 QF-30의 필수 조건이 된다.

QF-11이 실패하면 전체 이식을 확대하지 않고 원인을 해결해 다시 판정한다. UI만 완성한 상태로 기존 앱을 교체하지 않는다. 웹 중간 미리보기와 웹·설치형 전체 대체의 출시 조건을 구분한다.

## 5. 성능 측정 범위와 예산

기존 [측정 기준](evidence/qt-exit-baseline.json)은 로컬 Wasm 약 19.08 MiB, 전체 bundle 약 20.38 MiB다. 네이티브 4096²의 채우기 중앙값은 25ms, 프로젝트 저장은 448ms였다. 이는 물리 펜 지연이나 모바일 FPS가 아니다. 새 엔진의 향상률은 아직 측정하지 않았다.

### 공통 작업 부하

- 일상 편집: 800×600, 브러시 12px/100px, 잉크·부드러운 붓·반투명·지우개, 같은 좌표/필압/시간 입력.
- 웹 한도: 2048² 한 레이어, 1536×2048 두 레이어, 합계 한도 내 다수의 작은 레이어. 웹에서 4096² 문서를 허용하는 것으로 시험을 바꾸지 않는다.
- 설치형 대형 문서: 4096² 등 현재 네이티브 프로필 내 크기. 웹·네이티브 한도와 결과를 따로 보고한다.
- 고해상도/기기: DPR 1/2/3, 60Hz 및 가능하면 120Hz, 실제 iPad/Android/데스크톱. 120Hz 물리 입력과 브라우저 에뮬레이션을 동일하게 취급하지 않는다.

### 목표 후보 — QF-03에서 대상 기기와 함께 확정

| 지표 | 초기 목표 후보 | 판정 방법/주의 |
| --- | --- | --- |
| 첫 실행의 필수 전송 자산 | 압축 전송 합계 2 MiB 이내 검토 | 필수 글꼴/코덱 포함. 로컬 gzip 추정이 아니라 실제 전송으로 확인. 아직 달성한 수치가 아님 |
| 앱 편집 준비 | 지정한 12Mbps/RTT 150ms cold profile에서 3초 이내 검토 | 사용자 파일 열기 제외. TTFB·캐시·기기 조건을 명시하며 ‘모든 모바일 3초’로 표현하지 않음 |
| 일반 획의 앱 처리 | 기본 문서·12px 브러시에서 p95 8ms 이내 검토 | 이벤트 작업/commit/표시를 분리. frame 전체 비용이나 실제 touch-to-photon 수치와 구분 |
| 60Hz 화면 응답 | 이벤트→다음 유효 표시 p95 33ms 이내 검토 | 브라우저 trace와 실제 표시 측정 가능 범위를 명시. 120Hz에서는 별도 기준 측정 |
| 장기 작업 중 편집 | 활성 획에서 50ms 이상 UI long task 제거 목표 | UI가 부드러워도 입력 엔진 큐가 누적되면 미통과. 압축 취소 가능성은 실제 코덱 기준 |
| 이력/임시 메모리 | 명시 예산 준수, 작업 실패 시 원본 보존 | 평균 RSS 대신 버퍼·이력 회계와 피크를 함께 기록. 마지막 큰 항목의 처리 정책 명시 |
| 장시간 사용 | 반복 열기/닫기·내보내기 후 소유 자원 정상 해제 | GC/RSS 변동과 실제 누수를 구분. Bitmap·Blob URL·Worker·버퍼 수를 추적 |
| 데이터·기능 | 호환성 P0 0건 | 픽셀·알파·Undo·복구·취소가 빠른 표시보다 우선 |

이 수치는 구현 전 예산 후보다. QF-03에서 실제 목표 장치로 현실성을 확인하고 근거를 기록해 고정한다. 미달한 뒤 임의로 목표만 낮춰 완료 처리하지 않는다. UI 프레임워크가 바뀌었다는 이유로 속도 향상을 가정하지 않는다.

## 6. 상세 태스크

현재 판정은 [전체 완료 조건 감사](STUDIO_COMPLETION_AUDIT.md)를 따른다. 최초 6개 입증·25개 부분·3개 미구현에서 [Studio 로컬 staging](evidence/studio-staging.json) 구현 후 6/26/2로 진행했다. QF-02 독립 기준 목록 완료 후 현재7개 입증·25개 부분·2개 미구현이며, 선행까지 닫힌 것은 QF-01/QF-02/QF-04다. [도형 정책·공개 UI/자원 정리 채택](evidence/studio-roundrect-contract.json)을 마쳤다. QF-17의 미확정 편집까지 포함한 출력 바탕 미리보기와 Classic 98 대비는 [구현·검증 보고서](archive/STUDIO_EXPORT_PREVIEW.md)에 반영했다. 48px 표적과 크기/원점 변경 입력 투영은 [후속 구현·검증](archive/STUDIO_TOUCH_VIEWPORT.md)에 반영했다. VisualViewport 확대·pan/API 모델과 미변형 선택 확정 비용은 [카메라·뷰포트 후속 구현·검증](archive/STUDIO_CAMERA_VIEWPORT.md)에 반영했다. 자동 복구의 clone→Worker→storage 비용과 실패·재시도는 [후속 분석·수정](archive/STUDIO_RECOVERY_SNAPSHOT.md)에 반영했다. Codec10응답 계약과 Worker 내부 비용은 [후속 구현·검증](archive/STUDIO_CODEC_REPLY.md)에 반영했다. [macOS 단계 관측·실제 소스 빌드 비교](archive/STUDIO_NATIVE_TIMING.md)에서 smoke 실패 단계를 구분하고 수정 전·후 macOS 각4단계와 오류 모델6개를 확인했다. CRC 소스 후보는 low/high 혼재로 비채택했다. 첫 timeout 원인은 미확정이며 재발 시 해당 단계의 관측을 기준으로 추적한다. [저장 기준·복구 조회 후속](archive/STUDIO_NATIVE_OWNERSHIP.md)에서 post-save binding과 복구 조회 경합을 수정했고 실제 Rust 저장소65/300MiB 메모리 기준을 확보했다. 후속 일반 macOS 실행4단계는 통과했으나 앞선20초/120초 실패 원인은 미확정으로 보존한다. QF-02 기준 목록과 [QF-04 최신 계약 감사·늦은 복구 오류 수정](STUDIO_DOCUMENT_CONTRACTS.md)을 완료했다. 다음은 QF-03 대상/예산 확정, 120초 native smoke 미완료의 단계·원인과 실제 플랫폼 입력·앱 전체 메모리/지연 예산을 확인한다. 실제 OS 키보드·IME·Android 웹·플랫폼·미리보기 최대 경계 인수는 계속 남긴다. JPEG 방향은 [Chrome 8방향·영구 회귀 11개](evidence/studio-jpeg-orientation.json)를 확인했고 QF-16 전체 인수와 QF-32의 공개 Pages·복구 인계 인수는 남긴다. 아래 날짜별 후속 기록의 당시 우선순위는 현재 작업 순서를 대신하지 않는다.

상태: 아래 `[ ]`는 완료 조건 전체를 아직 충족하지 못했다는 뜻이며, 구현 중인 항목도 포함한다. 세부 진척은 [구현 기록](STUDIO_IMPLEMENTATION.md)을 기준으로 확인한다. 조건부 작업은 채택 조건이 성립하지 않으면 측정 근거와 함께 ‘미채택’으로 닫을 수 있다. 구현 완료는 연결된 검증과 결과가 남아야 표시한다.

### QF-01 — 전환 범위와 아키텍처 결정 기록

- [x] 완료

**P0 / 비용 M / 선행: 없음**

- 작업: Qt-free TypeScript+Vite+DOM/CSS UI, 독립 픽셀 엔진, Canvas2D 표시를 기본 경로로 기록한다. 기존 Qt 앱은 기준 구현으로 보존하고 신규 작업은 web-app/에서 격리한다. C++ 전용 규칙의 적용 범위와 새 TS 컨벤션을 구분한다.
- 완료 조건: 웹·데스크톱 기능 범위, Qt 제거 기준, 파일 호환 계약, 셸 선택 시점, 실제 공유 의미만 함수로 분리하는 원칙이 결정 문서에 명시된다.

### QF-02 — 기존 편집·파일·실패 동작을 회귀 fixture로 고정

- [x] 완료

**P0 / 비용 L / 선행: QF-01**

- 작업: F01~F10 수정 결과, 17개 도구, 레이어·Undo·pending 선택/문자, 저장/클립보드 실패와 복구를 재현 가능한 입력·문서·예상 상태로 추출한다. 정상/손상 RPAINT01과 투명·반투명 PNG를 포함한다.
- 완료 조건: 새 UI 구현과 독립적으로 실행할 기준 데이터와 동작 목록이 있고, 기존 수정 사항을 다시 미해결로 분류하지 않는다. 완성 픽셀 보존과 신규 획/문자의 렌더링 차이 허용 범위를 구분한다.

[독립 기준 목록·실행·완료 판정](archive/STUDIO_FIXTURE_BASELINE.md): 10fix/17tools/6상태·실패 영역,16자료의 출처·허용차를 고정했다. 기존 수정은 재개방하지 않으며 전체 UI 옵션·실기기·성능 인수와 구분한다.

### QF-03 — 비교 성능 측정기와 대상 기기·예산 확정

- [ ] 완료

**P0 / 비용 M / 선행: QF-01**

- 작업: 기존 Qt/신규 앱에 동일 문서·입력 궤적을 재생한다. 기존 코어 probe 외에 시작 시간, 포인터 처리·표시·commit 지연, 프레임, 메모리, 파일/복구 지연을 분리한다. iPad/Android 실기기 확보 여부를 초기에 확인한다.
- 완료 조건: 기기·브라우저·DPR·빌드 해시·warm/cold·입력 샘플·반복 조건을 기록하고 p50/p95/p99를 보고한다. 자동화가 실제 화면 표시/물리 펜 지연까지 측정하는지 한계를 명시한다. 아래 성능 예산의 적용 대상을 고정한다.

[측정기 v2 보완·실행·한계](archive/STUDIO_MEASUREMENT_METHOD.md): actual operand/출력 바이트·입력 token·정확성 control·환경/수명 기록을 보완했다. core36행과 별도12/100px method-validity 자료를 확인했으나 첫 통합90초 실패는 보존한다. Android 상세 정보·실기기, 공통 실제 UI trace·Qt/Wasm 웹 비교·안정 tail·예산 인수는 남겨 QF-03은 부분 충족으로 유지한다.

[Qt/Studio 공통 코어 fixture](archive/STUDIO_MATCHED_CORE.md)로 opaque7planes·6입력의 API12작업씩과 양방향3프로젝트를 검증했다. 같은 입력 wire SHA·실제 COW/독립 출력 경계를 고정했다. n3 진단 표본이며 Qt/Wasm UI·앱 향상률/실기기·안정 tail/예산 인수가 아니므로 QF-03은 계속 부분 충족이다.

### QF-04 — 문서·알파·비동기 확정 계약 설계

- [x] 완료

**P0 / 비용 M / 선행: QF-02**

- 작업: 엔진 픽셀의 채널 순서와 알파 표현, revision/saved revision, 후보/확정/pending, 문서 세대와 취소 소유권을 정한다. 문서 지우기·확장 바탕, 보조색, 미리보기 바탕, 출력 합성색을 분리한다.
- 완료 조건: RPAINT01 필드를 임의 추가하지 않고 기존 불투명 문서 의미를 보존한다. 새 투명 문서와 JPG/BMP 합성 정책, 반올림·PNG 경계의 검증 값이 정해진다.

[조건별 설계 계약·수정·검증](STUDIO_DOCUMENT_CONTRACTS.md): raw layer/합성 PNG·바탕/출력 matte·반올림/형식·후보/세대 소유권을 명시했다. 이전 문서의 늦은 복구 오류가 새 문서 상태를 덮던 Minor를 한 줄 epoch guard로 수정했고, 공개 저장/복구16·조회흐름7·내보내기12를 확인했다. 전체 플랫폼·성능·출시 인수는 별도다.

### QF-05 — 독립 웹 앱 빌드와 최소 실행 셸 준비

- [ ] 완료

**P0 / 비용 M / 선행: QF-01·QF-03**

- 작업: web-app/ 아래 TypeScript·정적 빌드·기본 DOM 조작부·로컬 자산을 구성한다. 기존 web/ Qt 호스트와 CMake/배포 결과를 덮어쓰지 않는다. UI에는 작은 값만 두고 픽셀을 프레임워크 상태로 관리하지 않는다.
- 완료 조건: 로컬 실행과 정적 산출물이 재현되고 새 진입점은 Qt JS/Wasm을 요청하지 않는다. strict 타입·포맷·최소 문법 검사가 동작한다. 스킨이나 메뉴를 위해 범용 프레임워크 계층을 추가하지 않는다.

### QF-06 — 엔진 문서 상태와 메모리 소유권 구현

- [ ] 완료

**P0 / 비용 L / 선행: QF-04·QF-05**

- 작업: 레이어·활성 레이어·문서 크기·한도·revision·후보 편집을 엔진에서 소유한다. 변경 영역을 추적하고 한 획의 임시 패치와 확정 픽셀을 분리한다. 작은 작업에서도 레이어 전체를 무조건 복제하지 않는다.
- 완료 조건: 후보 할당/검증 실패가 확정 문서와 Redo를 바꾸지 않는다. 문서 픽셀·임시 패치·마스크의 바이트 회계가 있으며 기존 웹/네이티브 자원 프로필을 구분한다.

### QF-07 — 핵심 브러시·지우개와 단일 입력 경로 구현

- [ ] 완료

**P0 / 비용 L / 선행: QF-06**

- 작업: 소수 좌표, 보간·안티앨리어싱·경도·불투명도·선 보정·필압과 한 획 최대 coverage를 이식한다. 소유 pointer·버튼·세대, 마지막 해제점, cancel/capture 상실을 처리한다.
- 진행: 마우스 보조 버튼 3/4의 편집 진입을 차단하고 기존 버튼 소유권·pending 보존·다음 정상 입력을 포인터 23개 회귀로 확인했다. [근거](evidence/studio-pointer-buttons.json). 물리 펜·장치 혼용과 전체 옵션 인수는 남아 있다.
- 완료 조건: 같은 입력의 색·알파·끝점이 기준을 만족한다. Esc/취소가 임시 획만 버리고 다른 장치나 늦은 이벤트가 새 획을 종료하지 않는다. DOM/Qt/Worker가 중복 획을 만들지 않는다.

### QF-08 — 변경 패치 기반 Undo/Redo와 예산 구현

- [ ] 완료

**P0 / 비용 L / 선행: QF-06·QF-07**

- 작업: 픽셀 변경은 사각형/타일 패치로, 레이어·크기 변경은 필요한 구조 정보로 기록한다. saved revision과 Redo 분기, 동일 레이어 재정렬, 이력 한도를 보존한다.
- 완료 조건: 한 획은 한 번의 Undo로 복원되고 저장 후 다른 분기로 편집해도 saved 표시가 틀리지 않는다. 전체 PNG/DataURL을 매 획 이력으로 저장하지 않으며 예산 축소가 현재 픽셀을 바꾸지 않는다.

### QF-09 — PNG와 RPAINT01의 제한된 안전 입출력 구현

- [ ] 완료

**P0 / 비용 L / 선행: QF-04·QF-06**

- 작업: 기존 이진 형식·UTF-8·레이어 순서·알파를 보존한다. 디코딩 전 치수·길이·합계·바이트 한도를 검사하고 권위 픽셀 버퍼를 단순 Canvas 왕복에 종속시키지 않는다. 코덱은 유지 가능한 기존 구현을 평가해 로컬 포함한다.
- 완료 조건: 기존 파일 왕복과 PNG 알파 fixture가 통과하고 손상/초대형 입력과 RPAINT01 뒤·PNG IEND 뒤의 비규격 후행 데이터가 현재 문서 교체 전에 거부된다. IDAT 내부 unused trailing bytes는 PNG 규격·Qt 호환성대로 허용한다. 출력 한도도 쓰기 전에 제한하며 새 형식이 필요하지 않다.

### QF-10 — 렌더링·Worker 경계와 제한된 작업 큐 구현

- [ ] 완료

**P0 / 비용 L / 선행: QF-05·QF-06·QF-07·QF-09**

- 작업: Canvas2D 표시와 dirty 영역 업데이트를 연결한다. 입력 포인트를 순서대로 묶어 보내고 큐·미처리 바이트를 제한한다. OffscreenCanvas/Worker 사용 가능 여부와 fallback을 검증한다. 코덱 장기 작업이 입력 엔진을 막지 않도록 경계를 둔다.
- 완료 조건: 주기적 전체 이미지 전송·매 포인트 readback이 없고 포인터 종료/취소가 큐에서 소실되지 않는다. Worker 실패는 마지막 확정 상태를 보존하거나 복구 안내를 제공한다. SharedArrayBuffer가 없어도 핵심 경로가 실행된다.

### QF-11 — 핵심 Qt-free PoC의 진행/중단 판정

- [ ] 완료

**P0 / 비용 M / 선행: QF-02·QF-03·QF-07·QF-08·QF-09·QF-10**

- 작업: 브러시·지우개·레이어·Undo·PNG/RPAINT01을 하나의 실제 흐름으로 확인한다. 기존 Qt 기준과 같은 문서·입력에서 데이터 보존, 지연·복사량·초기 크기를 비교한다.
- 완료 조건: 데이터 손실/호환 P0가 없고 목표 기기의 최소 편집이 성능 예산을 만족하거나 병목과 해결 경로가 재현된다. 결과를 기록한 뒤 전체 도구 이식을 시작한다. UI 데모만으로 통과시키지 않는다.

### QF-12 — 나머지 픽셀 도구와 취소 가능한 채우기 이식

- [ ] 완료

**P1 / 비용 L / 선행: QF-11**

- 작업: 연필·사각 브러시·스프레이·지정 색 교체·채우기·스포이트를 구현한다. 시작/종료·타이머·숨긴 레이어·투명 픽셀·보조색 정책을 포함한다.
- 완료 조건: 도구별 결과·Undo·취소가 fixture를 만족하고 스프레이가 입력 상실 후 계속 그리지 않는다. 채우기 취소는 확정 문서를 바꾸지 않으며 큰 작업이 UI를 점유하지 않는다.

현재 진행: [후속 도구 검사](STUDIO_ACCEPTANCE_MATRIX.md)에서 색 교체의 전역 변경을 국소 캡슐로 복원하고 실제 Qt·공개 UI·WK 엔진을 검증했다. 투명 잉크의 raw RGB/Redo 보호와 무잉크 visibility 정책도 확인했다. 나머지 옵션·장치 조합은 완료 표시하지 않는다.

### QF-13 — 도형 도구와 미확정 미리보기 이식

- [ ] 완료

**P1 / 비용 L / 선행: QF-11**

- 작업: 직선·곡선·사각형·둥근 사각형·타원·다각형과 윤곽/채움, 두께·보조색·Shift 제약을 구현한다. 미리보기는 별도 표시 상태로 둔다.
- 완료 조건: 마지막 release modifier·곡선 제어점·다각형 확정/취소를 검증한다. 미리보기마다 전체 레이어를 복사하거나 확정 revision을 생성하지 않는다.

현재 진행: 우클릭 도형 색·alpha128, pending preview/저장·취소·실패·마지막 Shift를 유지하고 [둥근 사각형 독립축 최대12·float/퇴화 정책과 컨텍스트 정리](evidence/studio-roundrect-contract.json)를 채택했다. 공개24·독립UI8·기존도형23/pending36·macOS4를 확인했다. 전체 옵션/입력 순열·실기기·기존WK 경계AA strict seam과 선행 게이트는 남긴다.

### QF-14 — 선택·클립보드 후보·자르기·붙여넣기 이식

- [ ] 완료

**P1 / 비용 L / 선행: QF-11**

- 작업: 사각/자유 선택, 투명 선택, 이동·크기 조절·삭제·crop·회전/반전과 사진 삽입을 구현한다. 문서 밖 범위·음수 좌표·표시 크기와 실제 복사 크기를 다룬다.
- 완료 조건: F01/F05/F06/F07의 재발이 없고 복사·cut·crop이 표시된 결과와 일치한다. 권한 처리 전 삭제하지 않으며 실패·취소 시 pending·원본 픽셀·Undo/Redo가 유지된다.

### QF-15 — 문자·한글 IME·글꼴과 래스터 확정 구현

- [ ] 완료

**P1 / 비용 L / 선행: QF-11**

- 작업: DOM 입력 편집기와 캔버스 표시를 연결한다. 조합·글꼴 준비·줄바꿈·편집 영역·줌·클립·문자 배경을 처리하고 확정 때 픽셀로 전환한다.
- 완료 조건: IME 조합 중 저장/도구 전환/회전이 문자를 누락하지 않는다. 입력 중 단축키가 텍스트를 가로채지 않고, 기존 확정 문자는 재조판하지 않는다. 실제 OS 입력기 검증을 별도로 통과한다.

### QF-16 — 전체 이미지 형식·레이어·변형 기능 동등성 확보

- [ ] 완료

**P1 / 비용 L / 선행: QF-11·QF-14**

- 작업: JPEG/BMP/GIF 첫 프레임, JPEG 방향, 파일 드롭·사진 삽입, 레이어 추가/삭제/표시/순서/이름/병합과 캔버스/이미지 크기·회전·반전·기울이기를 완성한다.
- 완료 조건: 기존 허용 형식과 메모리 제한을 지키고 이미지 크기와 작업 공간 변경을 구분한다. 레이어 구조 편집과 한도 실패에서 픽셀·활성 레이어·이력이 복원된다.

### QF-17 — 투명 문서·보조색·불투명 출력 바탕 UI 완성

- [ ] 완료

**P1 / 비용 M / 선행: QF-09·QF-11·QF-16**

- 작업: 새 그림의 흰색/투명, 문서 지우기·확장 바탕, 보조색과 화면 미리보기 바탕을 분리한다. PNG 알파 유지와 JPG/BMP 합성색·미리보기를 연결한다.
- 완료 조건: 기존 흰 픽셀을 자동 삭제하지 않고 단일/다중 레이어의 지우기·확장 정책이 일관된다. JPG/BMP 검정 바탕 재현이 해소되고 체커보드/스킨이 이미지에 기록되지 않는다.

### QF-18 — 웹 파일·다운로드·클립보드·복구와 이행 완성

- [ ] 완료

**P1 / 비용 L / 선행: QF-09·QF-11·QF-14·QF-15**

- 작업: 기존 File/Blob/IndexedDB 의미를 이식한다. retropaint-local-v1의 이전 복구 읽기, 탭/문서 키·세대, 트랜잭션과 quota, URL 수명을 유지한다. 다운로드 완료를 확인할 수 없는 상황의 안내를 보존한다.
- 완료 조건: 손상/권한 거절/선택 취소/저장소 실패·늦은 완료가 현재 편집을 바꾸지 않는다. 새 문서 전환·잘라내기·복구 인계와 기존 탭 동시 실행이 검증되고 이전 사본을 선삭제하지 않는다.

### QF-19 — 모바일·태블릿·데스크톱 반응형 셸 구현

- [ ] 완료

**P1 / 비용 L / 선행: QF-05·QF-11**

- 작업: 가용 폭/높이별 도구·파일 명령·속성·레이어 시트/탭을 구현한다. safe area, 가상 키보드·visual viewport·낮은 가로 화면과 파일/복구/오류 모달을 포함한다.
- 완료 조건: 390px에서 저장·내보내기·Undo 접근과 실용적인 그림 공간을 확보한다. 회전/리사이즈가 문서 해상도·사용자 줌·선택·문자를 바꾸지 않고 조작부가 화면 밖에 고립되지 않는다.

### QF-20 — 멀티터치 탐색·펜 우선·입력 밀도 구현

- [ ] 완료

**P1 / 비용 L / 선행: QF-07·QF-10·QF-11·QF-19**

- 작업: 두 손가락 이동/줌, 펜과 손가락 혼용, 손가락 그리기 설정과 48 논리 단위 터치 밀도를 적용한다. 두 번째 접촉 시 미확정 손가락 획을 버리고 탐색으로 전환한다.
- 완료 조건: 유령 점·중복 획·남은 한 손가락의 재그리기가 없고 펜 획 중 손가락이 소유권을 빼앗지 않는다. 취소/앱 전환/늦은 이벤트를 실제 기기에서 확인한다. 페이지 확대 대안과 줌 버튼도 제공한다.

### QF-21 — Studio/Classic 98 스킨과 환경설정 구현

- [ ] 완료

**P1 / 비용 M / 선행: QF-05·QF-11·QF-19**

- 작업: 공통 색·테두리·강조·초점 토큰과 두 스킨을 구현한다. 작품의 전경/보조색·텍스트 글꼴은 독립시킨다. 내장 SkinId와 버전 있는 앱 전용 설정 키, 저장 실패 fallback을 사용한다.
- 완료 조건: 모든 패널·모달·다운로드·초기 로딩이 일관된 스킨을 따른다. 스킨 전환 전후 픽셀·revision·dirty·Undo/Redo·IME/pending이 불변이고, Classic에서도 터치 크기와 한글 가독성이 유지된다.

### QF-22 — 도구 아이콘·명령 메타데이터·접근성 고도화

- [ ] 완료

**P1 / 비용 M / 선행: QF-11·QF-19·QF-21**

- 작업: 브러시/연필·지우개/색 교체·곡선/직선·선택/화면 이동을 명확히 구분한다. Undo/Redo 굽은 화살표, 병합/이름 변경/투명 표시를 정리한다. 도구 ID·이름·설명·아이콘·단축키를 한 정의에 연결한다.
- 완료 조건: 터치에서 hover 없이 현재 도구와 주요 명령을 찾는다. 비활성/선택/초점·대비·비정수 DPR·보조공학 이름이 검증되고 스킨별로 다른 동작 구현이 생기지 않는다. 외부 아이콘 런타임을 로드하지 않는다.

### QF-23 — 실측 기반 픽셀·이력·합성 경로 최적화

- [ ] 완료

**P1 / 비용 L / 선행: QF-03·QF-11·QF-12·QF-13·QF-14·QF-16**

- 작업: 프로파일 상위 병목부터 전체 스캔/복사·중복 합성·할당/GC·readback을 줄인다. dirty 패치·캐시·버퍼 재사용을 우선하고 전체 타일 저장소는 실제 메모리/복사 병목이 입증될 때 확대한다.
- 완료 조건: 같은 fixture의 결과를 유지한 전후 측정이 있고 포인터 hot path의 불필요한 전체 문서 작업이 없다. 최적화로 복잡도만 늘고 실측 이득이 없으면 원복한다.

현재 진행: 2026-11-05 [최종 화면 통합](archive/STUDIO_MAX_DOCUMENT.md)에서 반복 표시·대표 dirty 업로드를 줄였고 원본 UI/WKWebView 픽셀 보존을 확인했다. Cold와 모서리·분리 영역의 frame 비용은 미해결이다. 근거가 없는 Wasm/GPU 도입 없이 이 경계의 반복 측정을 우선한다.

### QF-24 — 인코딩·복구·장기 작업의 응답성과 메모리 최적화

- [ ] 완료

**P1 / 비용 M / 선행: QF-10·QF-18·QF-23**

- 작업: 입력 엔진과 인코딩을 격리하거나 협력적으로 분할한다. 필요한 snapshot만 소유하고 내보내기/복구의 중복 대형 작업을 제한한다. 진행·취소·늦은 완료·snapshot 메모리를 다룬다.
- 완료 조건: 저장/복구 중 입력 지연 예산을 지키고 취소 시 이전 파일/사본이 남는다. 동기 코덱이 있는 경우 즉시 취소를 허위 표시하지 않는다. UI만 부드럽고 권위 엔진이 수백 ms 밀리는 상태도 측정한다.

### QF-25 — 조건부 Qt-free Wasm 계산 커널 비교

- [ ] 완료

**P2 / 비용 L / 조건부 / 선행: QF-23**

- 작업: CPU 브러시/채우기/합성이 여전히 예산을 초과하고 병목을 지배할 때만 같은 알고리즘의 C++/Rust Wasm을 비교한다. 호출은 묶음/버퍼 소유권 단위로 설계한다.
- 완료 조건: 복사·바인딩·초기 로딩을 포함해 목표 기기의 유의미한 이득과 결과 호환이 확인되면 채택한다. 충족하지 않으면 사유와 함께 미채택으로 닫는다. Qt 코드/런타임은 새 엔진에 도입하지 않는다.

### QF-26 — 조건부 GPU 합성·고급 렌더러 비교

- [ ] 완료

**P2 / 비용 L / 조건부 / 선행: QF-23**

- 작업: 레이어 합성/큰 브러시가 병목일 때만 WebGL/WebGPU 경로를 검토한다. texture 메모리·CPU readback·알파 정확성·context/device loss·fallback 비용을 포함한다.
- 완료 조건: 대상 장치의 측정 이득과 손실 복구가 검증돼야 채택한다. 미지원 기기를 제외하는 방식으로 통과시키지 않는다. 이득이 없거나 유지비가 크면 미채택으로 닫는다.

### QF-27 — 초기 로딩·자산·DPR·장시간 자원 최적화

- [ ] 완료

**P1 / 비용 M / 선행: QF-19·QF-21·QF-22·QF-23·QF-24**

- 작업: 초기 필수 코드·폰트·코덱과 지연 자산을 분리하고 실제 전송량/준비 시간을 측정한다. 미사용 의존성·과한 효과를 제거한다. DPR, ImageBitmap/Blob/Worker/버퍼 수명과 문서 교체 반복을 확인한다.
- 완료 조건: 첫 실행이 이전 Qt Wasm을 함께 다운로드하지 않고 스킨별 엔진 복제본이 없다. 글꼴 최적화가 한글 입력 범위를 깨지 않으며 장시간 편집과 반복 열기 후 소유 자원이 정상 해제된다.

### QF-28 — 데스크톱 셸 PoC와 최종 런타임 결정

- [ ] 완료

**P1 / 비용 L / 선행: QF-11·QF-19·QF-20**

- 작업: Windows/macOS에서만 Tauri를 우선 후보로 같은 웹 엔진의 설치형 동작을 확인한다. Android/iOS 네이티브 빌드는 생성하지 않는다. OS별 WebView의 펜·Canvas·IME·자산 접근·오프라인, 패키지/RSS/시작 시간을 검증하고 필요하면 대안을 비교한다.
- 완료 조건: 실측 근거로 셸을 결정하고 현재 browser embedding 금지 규칙의 로컬 앱 자산 전용 적용 범위를 기록한다. 네이티브 IPC를 매 포인터/전체 이미지 왕복 경로로 쓰지 않는다. 작은 설치 파일을 성능 증거로 대체하지 않는다.

### QF-29 — 네이티브 안전 저장·복구 위치 인계·OS 통합

- [ ] 완료

**P1 / 비용 L / 선행: QF-18·QF-28**

- 작업: 선택한 셸에서 제한된 파일/클립보드/앱 수명 연결을 구현한다. 안전한 임시 파일 교체·동시 실행/잠금·취소와 이전 Qt 복구 위치 인계를 다룬다. 웹과 설치형 저장소가 자동 공유되지 않음을 반영한다.
- 완료 조건: 디스크 부족·권한 거절·파일 잠금·실패/취소·종료 경로에서 원본을 보존한다. 현재 네이티브 기능 범위와 한도를 검증하고 패키징·서명/공증의 실제 확인 상태를 구분한다.

### QF-30 — 기능·예외·실기기·성능 통합 인수

- [ ] 완료

**P0 / 비용 L / 선행: QF-12·QF-13·QF-14·QF-15·QF-16·QF-17·QF-18·QF-19·QF-20·QF-21·QF-22·QF-24·QF-27·QF-29**

- 작업: 기존 회귀와 새 알파/터치/스킨 조합을 실행한다. iPhone/iPad Safari 웹, Android Chrome 웹, 데스크톱 브라우저 및 Windows/macOS 설치형에서 파일 왕복·IME·클립보드·DPR·장시간 작업·오류를 확인한다.
- 완료 조건: 데이터 손실 P0와 필수 기능 미이식이 없고 목표 기기 성능 표를 작성한다. 실기기 미확인은 미확인으로 남기며 필수 대상이면 출시 게이트를 통과시키지 않는다. 합성 GPU 이벤트를 실제 장치 손실 시험으로 기록하지 않는다.

### QF-31 — CI·정적 검사·의존성·문서 품질 정리

- [ ] 완료

**P1 / 비용 M / 선행: QF-05·QF-11**

- 작업: 새 테스트/타입/린트/포맷/정적 빌드를 CI에 연결하고 전환 동안 기존 C++ 검사를 유지한다. 의미 있는 데이터/실패 시험을 우선한다. 완료 TODO·잘못된 주석·중복 문서·데드코드를 정리한다.
- 완료 조건: 빌드/테스트가 깨지면 결과를 검출하고 새 의존성의 고지·로컬 자산·재현 정보가 기록된다. 단일 대입/순차 작업을 헬퍼로 과분리하지 않으며 이미 해결한 과거 보고서는 날짜/후속 문서로 구분한다.

### QF-32 — 새 정적 산출물의 안전 staging과 Pages 이행

- [ ] 완료

**P1 / 비용 L / 선행: QF-18·QF-27·QF-31**

- 작업: Qt 파일명 고정 staging을 새 자산 manifest로 이행한다. 기존 manifest 읽기·수동/staged 변경 보호·경로/symlink 검증·일시 폴더·교체 실패 복원·중복 방지/prune를 보존한다.
- 완료 조건: /mypaint/ 상대 경로와 MIME/캐시·필요 헤더를 확인하고 홈페이지의 다른 파일을 보존한다. 새 Worker/단일 스레드 Wasm은 현재 헤더에서도 동작한다. 이전 탭의 지연 자산과 복구 이행을 검증한다.

### QF-33 — 출시 후보·전환·공개 인수·되돌리기 준비

- [ ] 완료

**P0 / 비용 M / 선행: QF-30·QF-31·QF-32**

- 작업: 빌드 해시·호환/성능 결과·기존 릴리스와 복구 자료를 묶어 출시 후보를 만든다. 웹과 설치형 전환 방법, 알려진 한계와 되돌리기 절차를 작성한다. 사용자 승인된 게시 이후 공개 URL 인수를 수행한다.
- 완료 조건: 실제 게시 파일의 다운로드/재열기/복구와 기존 홈페이지 보존이 확인된다. 미저장 탭을 강제 갱신하지 않는다. origin/형제 홈페이지의 별도 commit/push 방식을 유지하며 임의 force push/이력 재작성을 하지 않는다.

### QF-34 — 안정화 후 Qt 경로와 전환용 코드 정리

- [ ] 완료

**P2 / 비용 M / 선행: QF-33**

- 작업: 새 웹·설치형의 필수 기능/안전성/성능이 확인된 뒤 Qt 제품 경로·구형 빌드/자산·임시 어댑터·중복 문서를 정리한다. 유지해야 할 파일 형식 fixture와 검토 근거는 보존한다.
- 완료 조건: 활성 제품 빌드·실행 경로에 Qt 의존성이 없고 미사용 릴리스/SDK/아이콘 중복이 남지 않는다. 되돌리기와 이전 문서 열기 경로는 유지한다. Git 이력 용량 축소는 별도 명시 작업으로 남긴다.

## 7. 기존 분석 항목의 연결표

| 분석/요구 | 연결 태스크 | 보존할 의미 |
| --- | --- | --- |
| F01 선택 표시 크기 / F06 문서 밖 선택 | QF-02/14/19/30 | 복사·회전·crop은 보이는 크기를 사용하고 실패한 이동은 보존 |
| F02 복합 버튼 / F08 release modifier | QF-07/13/20/30 | 시작 장치/버튼 소유권과 마지막 좌표·modifier 반영 |
| F03 레이어 이력 / F09 이력 비용 | QF-06/08/16/23 | 동일 레이어 재정렬과 활성 레이어, saved revision·예산 |
| F04 pending 표시 / F05 저장 취소 | QF-04/08/14/15/18/29 | 메뉴·Redo·dirty와 미확정 편집, 원본 파일 보존 |
| F07 잘라내기·권한 거절 | QF-14/18/29 | 활성 레이어와 복사 대상 일치, 성공 전 삭제 금지 |
| F10 응답성 / 고결합·책임 혼재 | QF-06/10/23/24/31 | 픽셀/입력/IO 소유권과 실제 장기 작업 경계 |
| 투명 background와 JPG/BMP 검정 출력 | QF-04/09/17/30 | 보조색/clear/preview/matte 분리와 정확한 알파 |
| 모바일 종이 폭 76px·명령 밀림 | QF-19/20/22/30 | 패널 접기·시트·터치 표적·회전/키보드 처리 |
| 펜 cancel·다중 접촉·합성 입력 | QF-03/07/10/20/30 | 유령 획·중복·늦은 이벤트 방지와 실기기 인수 |
| Studio/Win98 스킨·아이콘 식별 | QF-19/21/22/27 | 같은 동작 정의, 문서 불변, 글꼴·대비·접근성 |
| IndexedDB quota·탭 경합·손상·URL 수명 | QF-18/24/27/30 | 기존 사본과 현재 편집 보존, 자원 정리 |
| Qt-free 성능·타일/복사·GPU/IPC 위험 | QF-03/06/08/10/23~29 | 같은 입력/문서 비교와 근거 있는 가속 채택 |
| 과한 헬퍼·중복·주석·린트·데드코드 | QF-01/05/31/34 | 소유 함수 안의 순차 작업, 필요한 공유 경계만 분리 |
| 중복 릴리스·전체 Qt 소스 때문에 큰 배포 | QF-27/32/34 | 자산 해시·소유권·한 버전 정책과 필요한 고지/소스 자료 |
| 별도 홈페이지 폴더·origin·pull/push | QF-32/33 | 소스/홈페이지 각각 관리, 산출물만 반영, 수동 Git 게시 |
| 실제 OS·IME·Retina·오류 인수 미완료 | QF-03/15/20/28/29/30 | 기존 macOS/Chrome 결과를 다른 기기 통과로 확대하지 않음 |

과거 보고서의 줄 번호·수치는 당시 기준이다. 완료된 수정은 현재 코드를 우선 확인한다. 이 Qt-free 백로그를 택하면 UI_EVOLUTION_PLAN의 Qt MainWindow/appearance 구현을 별도로 동시에 확장하지 않는다. 해당 문서의 UX·안전성 요구를 새 구조로 이식하며, 구형 앱에는 전환 중 필요한 긴급 회귀 수정만 별도 범위로 다룬다.

## 8. 파일 구조 초안과 과분리 방지

구현 위치는 QF-01에서 확정하되 초기 경계는 다음 정도로 제한한다.

| 위치 후보 | 소유 책임 |
| --- | --- |
| `web-app/src/engine/` | 문서·레이어·픽셀·이력·도구·포맷. DOM/UI 프레임워크를 모름 |
| `web-app/src/ui/` | 명령·패널·문자 입력·스킨·아이콘·반응형 배치 |
| `web-app/src/workers/` | 측정상 필요한 엔진/코덱 작업과 수명·세대·버퍼 전달 |
| `web-app/src/platform/` | 웹 파일/클립보드/복구·설치형 파일 경계. 실제 플랫폼 차이만 둠 |
| `web-app/tests/` | 파일·픽셀·실패·입력 재현과 비교 성능. 재사용 가능한 기존 fixture 연결 |
| 기존 `src/`, `web/`, `tools/` | 전환 동안 기준 구현·현재 배포 도구 유지. 최종 활성 경로 정리는 QF-34 |

이는 미리 모든 폴더·클래스를 생성하라는 지시가 아니다. 각 태스크가 실제 소유 상태/자원에 필요한 최소 파일만 만든다. Worker/코덱 분리는 응답성과 실패 격리를 위한 실행 경계이며 단순 동기 로직을 헬퍼로 쪼개는 작업과 구분한다.

## 9. 각 태스크의 공통 완료 조건

1. 현재 컨벤션·선행 태스크·기존 계약을 읽고 실제 변경 범위를 확인한다.
2. 확인된 소유 함수/상태에 구현하고 불필요한 계층·래퍼·별도 유사 로직을 만들지 않는다.
3. 데이터·파일·입력·자원 수명의 의미 있는 회귀/실패 시험을 실행한다. 단순 가역 UI 장식을 위해 구현을 복제하는 테스트를 추가하지 않는다.
4. 성능 작업은 같은 조건의 전후 자료를 남긴다. 네이티브 코어 시간, 브라우저 작업 시간, 물리 입력 지연을 혼용하지 않는다.
5. 예외·취소·권한·입력 상실·늦은 완료를 다시 검토한다. 작업한 코드의 주석·TODO·린트·미사용 코드와 다른 코드의 컨벤션을 점검한다.
6. 필요한 검사만 통과한 뒤 근거와 미확인 플랫폼을 기록하고 체크박스를 완료로 바꾼다. 조건부 가속은 채택/미채택 판단을 남긴다.

출시 게이트에서는 필수 대상의 미검증을 통과로 간주하지 않는다. 실제 기기나 원격 게시가 필요한 항목은 초기에 확보/일정을 정하고, 독립적인 구현·검증은 계속 진행한다.

## 10. 바로 시작할 작업 묶음

첫 묶음은 **QF-01~05**다. 범위/컨벤션·동작 fixture·측정 기준과 파일/알파 계약을 고정하고 신규 정적 앱만 준비한다. 다음은 **QF-06~10**의 핵심 엔진, 그 다음 **QF-11**의 비교 판정이다. 통과 뒤 QF-31의 CI를 연결하고 전체 기능/반응형·스킨 이식을 진행한다.

전환은 QF-33까지 검증한 후 수행하고, Qt 삭제는 마지막 QF-34다. 이 태스크 정리 단계에서는 신규 엔진·스킨을 구현하거나 현재 홈페이지 산출물·Git 리모트·commit/push를 변경하지 않았다.


### GIF 입력 경계의 추가 진행 기록

QF의 파일 입력·자원 한도·취소 인수에서 첫 GIF descriptor 확장과 긴 extension prefix를 보완했다. [근거](evidence/studio-gif-input.json): Node 166·GIF UI 22·기본 웹 10·실제 macOS 4단계, 그 안의 GIF 3개 전수 픽셀 확인. 기존의 bounded 비규격 frame과 애니메이션 첫 장면 호환을 유지한다. Native 내부 metadata/RSS, 실제 기기 인수와 WK cold/mip 측정은 완료 처리하지 않는다.


### 실제 WK 성능 계측과 첫 mip 개선 진행

[실측/수정 근거](evidence/studio-wk-render.json)에서 test readback과 renderer timing을 분리하고, 8K×4K×2 uniform 판정의 인라인 루프를 개선했다. 같은 조건의 중앙값 345→272ms, 픽셀/원본/예산/요청량 일치와 필수 타일74개·Node 166·웹 10·macOS 4단계를 확인했다. 계측 harness의 startup redraw 간섭도 별도로 수정했다. 초기 50ms 목표는 미달이므로 위 성능 관련 태스크를 완료로 체크하지 않는다. 남은 source 업로드/초기화와 bounded mip 준비, 넓은 dirty·실기기 인수를 계속 진행한다.


### 화면 범위 source 초기화 개선 진행

[후속 근거](evidence/studio-viewport-tiles.json)에서 Canvas geometry를 유지하며 ImageData/업로드만 화면 범위+halo로 줄였다. 실제 WK16layer 교차6회 초기 중앙98→84ms·요청55.85% 감소, 필수 타일82·Node166·웹10·macOS4단계를 확인했다. 초기50ms·최대 mip의 bounded 준비·넓은 dirty·실기기 게이트는 계속 미완료다. 모바일·태블릿은 웹만, 설치 패키지는 Windows/macOS만 유지한다.


### 기본 도구와 예외 소유권의 추가 진행

[근거](evidence/studio-basic-tools.json): 종료 pen0의 마지막 압력 유지, 투명 지우기 원본/Redo 보존, 입력 오류의 선택·포인터·캡처 복원, spray timer 예외 중단을 확인했다. 새 UI31·포인터26·엔진169와 기존 웹/편집/macOS 인수가 통과했다. Qt 사각 도구161개 기준은 다음 구현의 검증 입력으로 보존했다.

다음 도구 작업은 QF-12의 사각 브러시/지우개다. 폭1 aliased line과 굵은 SquareCap 경계를 구분하고, 홀짝 크기·양/음 기울기·역방향·clip 및 이벤트별 source-over를 복원한다. 기존 타일 이력/취소/할당 실패 경계를 공유해야 한다. 고정161개와 별도 생성 사례, 공개 UI 옵션/좌우/Undo/취소를 통과하기 전에는 이 항목을 완료하지 않는다. 단순 polygon 근사는160개 중36개 불일치로 채택하지 않았다.


## 현재 후속 작업 상태와 우선순위

2026-11-05. [사각 단계](evidence/studio-square-tools.json)와 [팔레트·키보드·연필 단계](evidence/studio-pencil-palette.json)에 이어 [bounded mip 준비](evidence/studio-bounded-mip.json)를 UI4로 승격했다. 이후 [선택·문자 alpha](evidence/studio-alpha-contracts.json)와 [task setup/채우기 실패](evidence/studio-fill-failure.json)의 좁은 계약 수정·검증을 반영했다. 이전 단계별 기록은 당시 snapshot의 결과이며 QF 전체 완료를 뜻하지 않는다.

| 항목 | 현재 상태 | 확인 범위 |
| --- | --- | --- |
| Classic98 색상표 배경 충돌 | 수정·로컬 검증 완료 | 두 스킨×데스크톱/모바일 웹4환경,16색·눌림·선택 |
| 버튼 Enter가 문서 확정을 실행 | 수정·로컬 검증 완료 | 버튼 기본 동작, pending 보존, Canvas Enter 확정·기존 IME/편집 |
| 연필1px 경계·이벤트 합성·옵션 | 수정·로컬 검증 완료 | 실제 Qt41개, 공개 UI10개+기존31개, 원형 옵션 복원 |
| 이전 공유 도구/앱 회귀 | 당시 로컬 통과 | 사각35·웹13·동시성3·편집13·레이아웃4·실제 macOS4단계 |
| 최대 mip의 bounded 준비 | UI4 당시 구현·로컬 검증, 성능 인수 일부 | 필수 타일109·정보4·Node176·웹48·준비8·Canvas56/문서12·일반 macOS4단계. 짧은 callback과 완성 시간 증가는 당시 측정 |
| 투명 선택 키·문자 alpha | 수정·좁은 인수 완료 | 선택 Qt 4개·UI 4개, 문자 UI 8개, Qt 문자 6case/84check·별도 WK alpha10·일반 macOS4단계·기존 웹48/pending36/clipboard4 |
| 작업 setup 예외·채우기 실패 | setup 수정·기존 Worker 안전성의 좁은 인수 | 공개 UI 10종류×두 실패/취소 뒤 retry·실제20초 timeout 두 번, 웹48·pending36·일반 macOS4단계. OOM/물리 경쟁/전체 F10은 미인수 |

1. **Major / L** — 고정 DPR의 WK checker 계획을 실행하고 동일 camera/mip에서 bounded 준비의 완성 시간 비용을 확인한다. 계획 준비는 새 계측 결과가 아니다. UI4는 최대 65,536개 source-pixel 진행 단위·soft 4ms MessageChannel과 완성 프레임 공개를 구현했고, 취소/dirty/문서 교체/할당 실패/context loss 및 도구·스킨 warm cache 보존을 검증했다. Chrome 6쌍의 callback은 짧아졌지만 완성은 모두 느려졌으며 WK uniform도 n1뿐이다. DPR/mip가 다른 checker는 성능 비교에서 제외한다. 넓은 dirty·장기 RSS·50ms/실기기 인수는 계속 미완료다. [측정과 다음 경계](archive/STUDIO_MAX_DOCUMENT.md#최대-mip-준비의-다음-구현-경계)를 따른다.
2. **Major / M** — 후속 선택 배치에서 lasso mask·음수 이동·투명 키·resize 결합의 명시 payload를 인수했다. 후속 배치에서 source-less paste4·투명 배경 Source-clear7을 인수했다. 원본 mask의 명시 변형·연속 resize는 아래 후속 배치에서 인수했으며 임의 조합과 전체 F06은 남아 있다. Worker fill 실패/취소/timeout의 명시 경계와 retry는 후속10개에서 확인했지만 fill premul/NoOp·cut flag·hidden active의 좁은 Qt/UI 대조와 수정은 후속 배치에서 마쳤다. alpha와 task·키 수정만으로 전체 F06/F10/17도구를 완료하지 않는다. 다른 F01–F10 옵션과 홈페이지 staging/rollback도 남아 있다.
3. **실기기/출시 게이트** — Android Chrome·Safari 웹, Windows/macOS 설치형 OS 통합, 원격 CI·서명/공증을 각각 인수한다. 모바일 APK/AAB·iOS 앱은 만들지 않는다.
4. **Minor / M** — 선택 색상의 alpha 표시 UX, 같은 불투명색 지우기의 임시 할당, native GIF metadata/RSS를 확인한다.

일반 pixel API의 최대 coverage 계약은 유지했다. UI 연필은 문서화된 Qt 도구 계약에 따라 이미 검증한 hard square의 폭1 경로를 사용한다. 연필 단계에서 엔진을 다시 구현하지 않았으며, 후속 bounded 준비도 전체 속도 향상이나 전역 50ms·p95 달성을 선언하지 않는다. 각 패턴 n3 Chrome과 n1 WK, 일반 앱 검증을 구분하고 모바일·태블릿 웹 전용/Windows·macOS 패키지 전용 범위를 유지한다.


선택 키는 alpha 포함 premultiplied 판정을 복원하되 원본 straight RGB를 재양자화하지 않았다. 문자는 RGB hex 네 곳만 인라인 RGBA로 바꾸며 기존 HEX/type=color·brush opacity와 상태 소유권을 유지했다. 함수 추가0, 엔진·tiles·형식·Rust·runtime import 불변이다. 새 alpha 12개의 수정 전 실패와 고친 뒤 성공을 보존했고 웹 CI에 두 테스트의 순차 실행을 연결했다. Node176은 동일 엔진의 이전 실행, UI4 callback/완성 시간은 이전 성능 표본이다. 실제 Qt 문자의3680 fully covered 픽셀은 OS 간 glyph geometry 인수가 아니며, 실제 WK alphaProbe10과 일반 overlay 없는 macOS4단계도 서로 다른 검증이다. 물리 기기·OS IME·최종 성능·스포이트 alpha 표시 UX는 계속 열려 있다.


후속 `task` 수정은 DOM/controls 준비와 실제 상태 변경의 예외 범위, local controller 소유권에 한정했다. `test:fill-failure` 10개를 CI에 연결했으며 각 모드 두 번의 실패/취소와 실제20초 timeout 두 번을 확인했다. Worker 9경계의 안전성은 기존 코드의 확인이고 새 Major는 setup throw 뒤 busy/inert 잔류다. 단발 DOM 주입을 OOM으로, 옛 cancel 합성 재생을 물리 경합으로 보고하지 않는다. 엔진·Codec·Rust·형식·키/색 정책은 그대로이며 Node176과 성능은 이전 근거다. 이 단계 당시의 fill premul/cut flag Qt 가설은 아래 후속 절에서 수정·검증했다. fixed-DPR WK checker·넓은 dirty/RSS와 남은 F06 목록은 유지한다.


## 채우기·잘라내기 키 계약 후속 반영

2026-11-05. [실행 근거](evidence/studio-fill-cut-key.json)로 fill premul 동등성/NoOp와 no-selection cut의 투명 키·hidden active 세 Major를 수정했다. QF-12/QF-15의 명시 범위를 확장하며 전체 태스크 완료 체크는 유지한다. 최종 source17/asset8, Node188·공개 fill6/cut5/실패10×두 번·WK Worker6·일반 macOS4단계를 묶었고, v2 웹48/pending36/clipboard4와 구분했다. 두 소유 함수만 변경했으며 helper·의존성·직렬화·Rust 변경은 없다.

fill의 전체 복사본 제거는 명시 버퍼4*N−4B 순감소를 확인했다. 1024² full34.51→16.59ms, island0.265→0.093ms였으나 ring0.638→0.844ms로 퇴행했다. 작은 Node 표본의 tradeoff이며 최종 성능 완료가 아니다. 최초 계측 assertion의4B 누락과 중간 NaN 후보 회귀도 테스트/개발 과정으로 구분해 기록했다.

이 fill/cut 단계 당시의 다음 우선순위는 (1) F06 lasso mask·음수 이동·resize·투명 키 결합과 한도 실패 payload (2) 대형 cut 키 스캔/최악 fill·장기 RSS 및 fixed-DPR WK checker·넓고 분리된 dirty (3) Android 웹·Safari·Windows/실제 OS 통합 (4) 원격 CI·서명/공증·홈페이지 staging/rollback이다. 사용 가능한 Android는 웹 검증에만 사용하며 모바일 네이티브 프로젝트는 추가하지 않는다. 커밋·푸시·공개 배포는 이번 배치에 없다.


## 자유 선택·nearest·UI crop 후속 반영

2026-11-05. [실행 근거](evidence/studio-selection-mask.json)에 QF-15의 세 Major와 인수 범위를 갱신했다. AA 임계 마스크를 순수 엔진의 aliased binary mask로 대체하고 입력 floor/dedupe·인라인 bbox 순회를 적용했다. UI crop은 음수 intersection/empty NoOp, 공용 crop 패딩은 유지한다. nearest의 exact tie는 Qt literal1024축쌍으로 수정했다. 새로운 실제 알고리즘1개를 기존 엔진에 추가했으며 작은 helper·새 모듈·의존성·형식·Rust 변경은 없다.

최종 Node192, 실제 새 CI 명령의 공개8+crop4+실패6, 기존 웹48/pending36/clipboard4를 확인했다. actual Qt871 mask·1024축쌍과 WK engine/Worker probe·일반 앱4단계는 각각 범위를 기록했다. source/자산/테스트·CI 해시와 정적 순환0은 고정 근거를 따른다. 전체 태스크 완료 체크는 그대로다.

명시 pixels+mask 저장 공간은8*S→5*S+O(path)이며 bounded kernel64 표본은 동일 출력을 확인했다. 큰 분산·타이머 분해능·누적 readback/peak 구분을 유지하고 전체 UI/RSS·실기기 성능 완료로 세지 않는다. 이 단계 당시의 다음 우선순위 (1) source-less paste·투명 배경 Source-clear는 아래 후속 배치로 갱신한다. 당시 이후 우선순위는 (1) 원본 mask rotate/flip/resize 결합 (2) 비퇴화 거대 path·장기 RSS/최대 문서·fixed-DPR WK/넓은 dirty (3) Android 웹·Safari·Windows/OS 인수 (4) 원격 CI·서명/공증·홈페이지 staging/rollback이다. 모바일 네이티브 프로젝트와 공개 배포는 추가하지 않았다.


## QF-14/15/31 선택 원본 지우기 후속 실행

2026-11-05. [고정 근거](evidence/studio-selection-source.json): binary Source-clear의 raw 배경 RGB 손실과 가짜 이력/Redo 손실 한 건(Major/S)을 소유 함수 안에서 수정했다. 엔진/형식/Rust·의존성은 그대로다. `test:selection-source`를 웹 CI에 연결해 공개7+source-less paste4를 순차 실행한다. paste4는 수정 전부터 안전했던 명시 경계다. 최종 Node192·기존 선택18/웹48/pending36/clipboard4·WK 진단6·일반 macOS4단계를 확인했다. 원격 CI 결과와 물리 장치 인수는 별도다.

실제 before/final 메서드96표본은 처리 영역/출력/원본/mask를 고정했으며 순수 동기 처리만 비교했다. UI/caller clone·이력/장기 RSS·실기기·p95로 일반화하지 않는다. 이 단계의 (1) 원본 mask 변형/음수 조합은 아래 후속 배치로 갱신한다. 이후 우선순위는 (1) 전체 F06/도구의 남은 혼합 alpha·키·장치 조합 (2) 비퇴화 거대 path CPU·최대 문서/장기 RSS·동일 DPR WK checker/분리된 dirty (3) Android 웹·Safari·Windows/OS·IME (4) 원격 CI·서명/공증·홈페이지 staging/rollback이다. 모바일 네이티브 프로젝트·커밋·푸시·공개 배포는 수행하지 않았다.


## QF-14/15/31 연속 선택 크기·변형 후속 실행

2026-11-05. [고정 근거](evidence/studio-masked-transform.json): 별도 크기 조절이 직전 결과를 재샘플해 픽셀/Redo를 잃던 Major/M을 고쳤다. UI의 persistent nearest backing과 drag snapshot 복원, 비동기 base identity guard·명시 geometry 초기 NoOp identity 무효화만 네 소유 메서드에 인라인 적용했다. helper·API·의존성·엔진/형식/Rust 변경은 없다. 새 `test:masked-transform` 공개9와 확장 crop10을 CI에 연결했다. 기존 선택8/실패6/Source7/paste4·웹48/pending36/clipboard4·Node192·실제 WK 진단4/일반 macOS4를 확인했으며 원격 CI·물리 기기 인수는 별도다.

정확도 복원을 위한 backing 참조 보유이며 성능 향상으로 보고하지 않는다. originalPixels 해제/alias와 backing4*B/current4*R, Worker 복제/반환과 Canvas/cache·RSS를 구분한다. 다음 우선순위는 (1) 비퇴화 거대 path와 대형 handle 동기 CPU·최대 문서/장기 RSS (2) 동일 DPR WK checker/분리된 dirty·남은 F01–F10/17도구 혼합 alpha/키/장치 조합 (3) Android 웹·Safari·Windows/실제 OS·IME (4) 원격 CI·서명/공증·홈페이지 staging/rollback이다. 모바일 네이티브 프로젝트와 커밋·푸시·공개 배포는 추가하지 않았다.


## QF-14/15/24 선택 비용 후속 실행

2026-11-05. [근거](evidence/studio-selection-performance.json)에 따라 nearest의 per-pixel view/set, 같은 rounded target/Up 중복 재샘플, dense active-edge 정렬을 기존3함수 안에서 줄였다. source/base/identity·Qt membership/ceil tie·원시 RGBA·candidate/실패 보존을 유지한다. 추가 X 표4W·bucketW+1은 실제 버퍼이고 뷰 객체/누적 output·RSS와 구분한다. helper·모듈·의존성·외부 API/형식/Rust 변경은 없다.

새10번째 결정적 resource 회귀는 기존 `test:masked-transform`/CI에 포함한다. Node198·실제Qt871+12의 분리된 범위·기존 선택/웹/pending/clipboard·CTest5·실제WK4/일반macOS4를 확인했다. UI n1/버전, Node n4/측·mask40표본의 개선과 퇴행을 모두 보존하며50ms/p95·물리 성능을 완료 표시하지 않는다.

다음은 (1) 더 큰 비퇴화 path/전체 preview·큰 새 handle target의 동기 작업과 취소 응답성, 최대 문서/장기 RSS를 측정해 bounded cursor/Worker 필요성을 판단 (2) 같은 DPR WK checker·넓고 분리된 dirty 및 남은 F01–F10/17도구·혼합 alpha/key/device 조합 (3) 공유 PNG 테스트 판독기의 중복 정리—제품 decoder와 oracle는 분리 (4) Android 웹/Safari/Windows·실제 OS/IME·디스크 교체 실패 (5) 원격CI·서명/공증·홈페이지 staging/rollback이다. mask를 다른 viewport로 잘라 반복 호출하는 방식은 기존Qt8개 반례 때문에 사용하지 않는다. 모바일 네이티브 포장·커밋·푸시·공개 배포는 추가하지 않았다.


## 큰 선택 준비 후속 — 2026-11-05

완료: 큰 lasso preparation의 job/controller/MessageChannel/Worker 소유권, full-origin mask/key 공유, 취소·stale guard·pending marker, 독립 Qt/PNG 기대값과성공·취소·실패 공개 회귀13개, npm/CI 연결. 검증은 로컬 Node208/기존7suite·macOS4/별도WK4다. 다음 P1은 modified-preview54ms/18uploads, 전체 path preview와 최대 동기 resize 측정/개선이며 P2는 packing threshold/Worker 시작/JS·RSS 장기 측정이다. 실제 Android 웹·Safari·Windows·OS/IME·출시 인수는 미완료. 모바일/태블릿 native package를 만들지 않는다. [고정 실행·리뷰 자료](evidence/studio-selection-preparation.json).


## 선택 첫 화면 비용 후속 — 2026-11-05

완료: 선택 첫modified cut 콜백의 bbox 외 순회와 pixel별 plain-array set 제거, 원본 sourceMask stride/Source RGBA 유지, Node211·frozen Canvas56/문서12·retry2·기존9suite·macOS4 검증. 첫RAF58.1→15.7ms이며 warm 재사용/업로드량은 기존 정책이다. 다음P1은 full path preview/최대 동기 resize 실측, P2는 resize 중 cutOwner·scene 활성 이동 재업로드/Worker startup·장기메모리다. 실제Android웹/Safari/Windows 및 출시 인수는 남는다. 모바일 native 프로젝트를 생성하지 않는다. [고정 측정·검증 자료](evidence/studio-selection-preview.json).


## 긴 올가미 미리보기 측정 결정 — 2026-11-06

근접65536점/성장batch와∆32·pan/no-op·중복이동을 분리한 현재 ordinary-web 관측은 RAF4.3–5.9ms였다. 전체 명령은1move+65535line이며 Canvas·literal stripe payload·원본/cancel/Undo가 일치했다. 별도 실제 Canvas API64개(DPR1/2·소수camera·원거리좌표)도 기존경로/Path2D 출력이 정확히 같았다. 그러나 이 fixture에서50ms 병목을 확인하지 못했고 native 경로O(P) 저장과 Enter 배열교체 소유권·실패복구가 추가되어 제품캐시는 보류했다. 현재소스17은 불변이다. 단일 Drag.path 제안은 Enter→settle 뒤 같은 drag에서points 배열이 교체되는 ABA를 놓쳐 정정했으며, 재개 시array identity/count/error 폐기가 필요하다. 입력49k를 한 작업에 전달한140.6ms와 실제 event cadence·랜덤long-edge stroke·native/Android/RSS를 일반화하지 않는다. 다음 우선순위는 최대32Mi nearest resize의 축별 실제비용이다. [측정·설계·보류 근거](evidence/studio-lasso-path-investigation.json). [WHATWG 경로 규칙](https://html.spec.whatwg.org/multipage/canvas.html#drawing-paths-to-the-canvas).


## 대형 nearest 크기 변경 후속 — 2026-11-06

완료: 기존 함수 안의 행 복사·반복 행 재사용·정확히 2배 word 대입, raw/offset/다층/후보 실패 회귀 6개, 단위 217개·공개 UI 9개 묶음·Canvas 56개·실제 WK 진단 4개·일반 macOS 4단계 검증. 일반 run 압축과 반복문 전개는 성능·복잡성 근거로 보류했다. [측정·구현·독립 검증 근거](evidence/studio-nearest-resize.json).

다음 P1/M–L은 최신 target의 취소 가능한 작업과 stale 결과 폐기, 원본 복귀·NoOp·Redo를 보존하는 대형 핸들 resize 설계다. 첫 처리 72.4→56.2ms/73.2→24.4ms 개선과 일반 비율 각 3회 중앙값 68.4→68.7ms를 구분한다. P1/M은 약 0.7초 축소 미리보기 준비의 누적 MessagePort 비용, P2/M은 후속 128MiB 결과 공존·장기 RSS·Worker clone/startup이다. 전역 50ms/p95·물리 기기·출시 목표를 완료 표시하지 않는다. 모바일/태블릿 웹 전용과 Windows/macOS 패키지 전용 범위를 유지한다.


## 대형 핸들 분할 처리 후속 — 2026-11-06

완료: shared nearest cursor와 기존 동기 API, gesture 최신 target·released 수명·취소/stale/예외 소유권, 모바일 취소 버튼, 단위 229개·공개 resize 10개/전체 10묶음·Canvas 56개·실제 WK 4개·일반 macOS 4단계 검증. 두 회귀 실행기의 플랫폼 고정 브라우저 경로도 고쳤다. [분할 resize 구현·실행·독립 검토 근거](evidence/studio-bounded-resize.json).

다음 P1은 앱 ready 약 0.7초의 cold 축소 미리보기 준비와 연속 target의 폐기·재할당/긴 gesture 검증이다. P1–P2는 후속 gesture의 고유 backing 공존(논리 예시 최대 512MiB)·장기 RSS/GC·실제 cadence다. P2는 Android 웹·Safari·Windows·OS picker/IME·디스크 실패·원격 CI·서명/공증·게시 인수다. 입력 콜백 0.4–0.8ms의 각 n1 개선을 전역 50ms·p95·전체 플랫폼 완료로 세지 않는다.


## 축소 미리보기 조사 후속 우선순위 — 2026-11-06

[고정 조사 근거](evidence/studio-cold-mip-investigation.json). cold mip의 CPU 표본과 별도 프로토타입을 비교했으며 제품 변경은 없다. Node fake Canvas 427회 raw/source 검사는 통과했지만, 실제 2×2 후보의 일반 카메라 이득과 factor16의 658.7→884.2ms·LongTask 증가가 함께 관측돼 채택하지 않았다. 각 n1·역사적 기준/새 pair·실제 Canvas/가짜 backend를 구분한다. 다른 후보도 패턴/factor 퇴행으로 보류했으며 전체 최적화 완료로 세지 않는다.

1. **P1 / M–L** — 연속 near-max target·취소·다음 gesture에서 버퍼 참조와 GC 전 폐기 후보, 장기 JS/RSS를 측정한다. 활성 owner 하나가 물리 메모리 상한이라는 가정을 하지 않는다. 기존 512MiB 논리 공존 계산과 실측을 구분한다.
2. **P1 / M** — 현행 high-minification의 99ms LongTask 관측을 고정 DPR/카메라에서 재현·분해한다. await 뒤 실제 cursor 작업과 할당·cut/payload·업로드를 구분하고, 일반 kernel 단순화 후보 하나를 격리해 검토한다. raw alpha/부분 셀/transform-before-box·예산·실패 복구와 다른 factor 대조를 통과하기 전 승격하지 않는다.
3. **플랫폼·출시 게이트** — Android 웹의 실제 touch/펜·회전·저장, Windows/macOS의 OS 파일/IME·교체 실패, Safari/WK의 동일 DPR checker·넓고 분리된 dirty를 확인한다. 가용 장치와 실행하지 못한 장치를 구분한다. 모바일 네이티브 포장은 만들지 않는다.
4. **P2 / M** — 공유 PNG 테스트 판독기 중복, 원격 CI·서명/공증·홈페이지 staging/rollback을 각각 검증한다. 조사용 결과를 홈페이지에 복사하거나 공개 배포하지 않는다.


## 연속 resize 유한 진단 후속 — 2026-11-06

[실행·독립 검토 근거](evidence/studio-resize-memory.json). 웹/데스크톱 Node 모델 각11후보·7전체raw와 실제 Chrome 데스크톱 IPC 모델의8192→8191→8190/8189/8188 버스트·최종전체raw/원본/기존Redo를 확인했다. 별도 GC에서 superseded target이 수집됐고 선택 제거 뒤 추적target5개 모두 수집됐다. 준비 중 실제 취소·PNG payload·장기/실기기/RSS 상한 인수로 확대하지 않는다. 확정된 제품 결함은 없고 buffer pool·별도 helper·runtime 수정은 추가하지 않았다.

다음 P1은 고정 DPR/카메라에서 현행 high-minification99ms 작업의 원인을 분리하는 일이다. 메모리는 유한 수집 가능성 진단을 마쳤으나 더 긴 실제 입력·후속 gesture·native/Android 웹의 자연 GC와 OS 메모리가 남는다. Android 웹의 touch/회전/저장과 Windows/macOS OS 파일·IME·교체 실패, 동일 DPR WK/넓고 분리된 dirty·원격 CI/서명·홈페이지 staging/rollback도 별도 미완료다. 기존 QF 전체 완료 체크는 유지하며 모바일 실행 파일·커밋·푸시·공개 배포는 만들지 않았다.


## High-minification 후속과 전체 완료 조건 감사 — 2026-11-06

[고정 진단·후보 보류 근거](evidence/studio-high-minification.json). 같은 기하의 새 비추적·진단 각 1회는 99ms를 재현하지 못했다. 진단 next 42.8ms를 확인했지만 원인 전체는 미확정이다. source work를 반으로 줄인 후보는 타일 필수 계약 109개 통과·정보성 비교 4개 기록에도 응답성이 개선되지 않고 primary의 불리한 표본이 있어 반영하지 않았다. 현재 소스 17개·자산 8개·65536 진행 단위는 유지한다. 전역 MessagePort의 resolver-only 일괄 해석은 동기 render와 분리하도록 정정했다.

다음은 각 QF 완료 조건과 현재 소스·테스트·실행 근거를 행별로 대조하는 감사다. 구현·로컬 인수 완료, 부분 검증, 미실행, 외부 장치·OS가 필요한 게이트를 구분하고 실제 미검증 계약을 우선 진행한다. 측정 이득이 없는 임계치 조정을 반복하지 않는다. 99ms 원인·p95/장기 메모리·실제 Android 웹/Windows·OS 파일/IME·동일 DPR WK·CI/서명·홈페이지 staging은 증거 없이 완료 표시하지 않는다. 모바일은 웹만, 패키지는 Windows/macOS만이고 커밋·푸시·공개 배포는 수행하지 않았다.

### 2026-11-06 QF-32 로컬 build·manifest·staging 구현

[고정 근거](evidence/studio-staging.json). `build_studio.py`는 타입/Vite 검사를 별도 후보에서 수행해 기본 `dist/studio`에만 설치한다. `stage_web.py`는 기존 Qt와 Studio manifest를 함께 받고 old Qt/shared·Studio Worker/JPEG lazy 자산을 기본 보존한다. 로컬 번들 설치 후 홈페이지 stage는 별도 작업이며 실패 시 로컬 번들은 남는다. 두 rename·복원 시도이지 crash-durable/no-gap 교체는 아니다.

회귀 43개·CTest 6그룹·실제 Chrome staging 16개 및 기존 storage 13개가 통과했다. 후보 LICENSE의 외부 파일 overwrite Major는 배타 생성과 충돌 3종 회귀로 해결했다. 배포 payload는 9파일/276,578B이고 기존 runtime17·자산8·두 저장소 index/config4는 불변이다. 실제 홈페이지 반영·commit·push·게시를 하지 않았다. 공개 cache/header·이전 Qt 복구 인계·dirty/pending update·Windows·원격 CI와 선행 게이트가 남아 QF-32 체크는 유지한다. 실행 방법은 [웹 빌드 안내](WEB_BUILD.md)를 따른다.

### 2026-11-06 JPEG 방향 영구 회귀

[고정 근거](evidence/studio-jpeg-orientation.json). QF-16의 EXIF 8방향을 독립 literal 순열과 실제 공개 파일 열기·저장 전체 픽셀로 확인했다. no-EXIF 제어/HTMLCanvas 대체/bitmap 오류의 기본 문서 보존을 포함한 11개를 `test:jpeg-orientation`로 CI에 연결했다. 제품 runtime17·Vite8은 불변이며 타입·포맷·실제 번들 빌드가 통과했다. 복잡한 Redo/pending 오류·다양한 JPEG/대형 손상 입력·레이어/변형 전 조합·다른 OS/브라우저는 인수하지 않았으므로 QF-16 체크는 유지한다.

### 2026-11-06 둥근 사각형의 실제 기하·래스터 조사

[고정 근거](evidence/studio-roundrect-geometry.json). Qt14×4와 실제 Canvas224프로토타입, 같은 기하/순서/context 조건을 분리한 후속96프레임을 기록했다. 단순14→12로 독립축·QRect 역방향/퇴화/floor·AA가 복원되지 않으며 fullQt bounds도 aliased/Canvas raster 동등성을 보장하지 않았다. 진단 프레임을 공개 UI 통과 수로 세지 않는다. 제품 소스는 유지한다. 다음은 공통 endpoint 정책을 명시하고 실제 preview/pending/export/commit·Undo/cancel·512 seam/DPR을 확인한 뒤 좁은 후보를 채택하는 단계다. 관측한 context 조건 차이를 근거 없이 전체 Surface의 willReadFrequently 변경으로 확대하지 않는다.

### 2026-11-06 QF-13 반경 정책·실패 자원 경계 구현

[채택 근거](evidence/studio-roundrect-contract.json). 제품 런타임 17개 중 main 하나만 변경했다. 최대 12의 독립 축 반경을 적용하고 shapeRaster의 컨텍스트 획득을 try 안으로 넣었다. 원본·NoOp·Redo·숨은 RGB·HTMLCanvas 대체·실패 시 backing 0을 공개 회귀 24개에서 확인했다. 기존 도형·pending·웹·화면·문서·실제 macOS 회귀도 다시 통과했다. 새 helper·import·의존성은 없으며 읽기 hint와 surface의 선택 인자는 제품에 남기지 않았다.

hint의 격리 성능 이득과 기술적인 seam 개선은 실제 pointerUp 경계색 snap의 증가를 상쇄하지 못했다. 기존 WK 경계 AA의 strict seam은 현재도 false/Minor P2로 기록한다. 다음 QF-17은 192 이하 grid에서 레이어 순서·선택 원본 지우기·미확정 payload·공유 문자 layout·도형을 모두 포함하는 읽기 전용 미리보기다. 전체 pendingState/composite 복사를 추가하지 않는다. doc.state만 보여주거나 미확정 내용을 누락한 중간안을 전체 완료로 취급하지 않는다.


## 2026-11-06 카메라·VisualViewport·무변형 선택

[수정·원인·검증·정정](archive/STUDIO_CAMERA_VIEWPORT.md), [고정 근거](evidence/studio-camera-viewport.json). 새 공개17개·Node232와 최종 기존 입력/선택/웹/출력·macOS 회귀를 통과했다. 휠 중 투영 Major, VV 확대·문자 원점/중복 observer·밀도 취소 Minor를 수정했다. 미변형 선택4K 두 레이어의 동기 slice는128MiB→0이며 draw(true)·엔진 검증·NoOp/Redo를 유지한다. 과거 forced-gutter42/48px 추론은 실제 hit 증거에 따라 철회하고 본문에 범위를 명시했다. 물리 Android 웹·OS IME/파일·Windows·보조공학·출시 및 선행 게이트는 남기며 전체 체크를 닫지 않는다.


## 2026-11-06 자동 복구의 오류 경계와 비용

[현재 분석·수정·검증](archive/STUDIO_RECOVERY_SNAPSHOT.md), [고정 근거](evidence/studio-recovery-snapshot.json). injected missing/null 출력의 false success→같은 revision 재시도 억제와 이전 epoch 오류 표시를 수정했다. 공개5·단위234·저장13·native IPC 모델15·웹48·실제 macOS4단계를 확인했다. 기준 clone/Worker/storage n3는 모델·실제 IDB를 분리하며, 성능 개선이나 실제 OS I/O/물리 장치 인수로 세지 않는다. full codec 응답 계약·Worker 내부 CPU/entropy·실제 플랫폼·전체 선행 게이트는 남는다.


## 2026-11-06 Codec10 응답과 Worker 비용

[분석·수정·검증·잔여 조건](archive/STUDIO_CODEC_REPLY.md), [고정 근거](evidence/studio-codec-reply.json). 잘못된파일 성공표시·조건부clipboard cut·typed state/sparse색상·fill응답 경계를 owner에서 닫았다. 동일공개27개 기준22실패/5대조통과→후보27통과, 독립계약89·전체Node323과기존회귀를확인했다. macOS최초20초timeout을보존하며동일binary재시도4단계는통과했다. Worker의지배비용은입력에따른압축·CRC였고CRC임시후보는low혼재로비채택했다. 정상Worker자연장애·OSclipboard·실기기·무회귀성능·전체출시완료로확대하지않는다.
