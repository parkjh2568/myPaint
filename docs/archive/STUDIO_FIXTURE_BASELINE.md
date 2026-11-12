> 과거 검증·설계 기록입니다. 현재 실행 방법은 [루트 안내](../../README.md)를 따르세요. 아래 수치는 기록 당시 환경에만 적용됩니다.

# 기존 기능의 독립 기준 목록 — QF-02

2026-11-06. [입력·실행·검토 근거](../evidence/studio-fixture-baseline.json). QF-02의 **새 UI와 독립된 기준 데이터·동작 목록**을 완료했다. 전체 도구 옵션·플랫폼·성능·출시 승인은 아니다. 제품 runtime17개와 배포 payload는 그대로다.

## 고정한 기준

[legacy-contracts.json](../../web-app/tests/fixtures/legacy-contracts.json)은 F01–F10,17개 도구,6개 상태/실패 영역을 입력·예상 상태·소유 테스트·정책·남은 인수에 연결한다. 레이어·이력·pending 선택/문자·저장 실패·클립보드/복구를 포함한다. 기존 수정은 `fixed-reference`로 유지하며 뒤의 미인수 옵션을 새 결함으로 재분류하지 않는다.

독립 자료16개를 구분했다. Qt 관측, Qt 관측에서 유도한 값, 수작업 literal과 Qt resize의 혼합, 독립 wire producer가 각각 어떤 비교를 허용하는지 기록한다. 제품 encoder로 만든 seed의 mutation이나 자기 roundtrip도 독립 oracle과 구분한다. [실행 안내](../../web-app/tests/fixtures/contracts-README.md)에 Node·Qt·공개 UI의 범위를 명시했다.

- 완료된 straight RGBA·alpha0 숨은 RGB·원본 바깥 픽셀과 mask는 해당 raw 기준에서 정확히 보존한다.
- Qt pixelColor 자료는 alpha와 premultiplied 채널 동등성을 비교한다. Qt 표현 차이를 새 PNG의 raw 보존 완화로 쓰지 않는다.
- 새 획/도형의 QPainter 대 Canvas 경계 AA와 글꼴 glyph는 지정된 로컬 정책으로 분리한다. 고정된 geometry/row-span 값을 임의 오차로 완화하지 않는다. 둥근 사각형의 Studio 축별 최대12 정책을 레거시 제스처/dirty/Undo 기준과 혼동하지 않는다.
- 명령 취소와 pending 자체 Escape 취소를 구별한다. 공개 dirty/saved·Redo 재생과 엔진의 숫자 revision 검사를 같은 관측이라고 쓰지 않는다. Pan의 기존 Redo seed/replay는 해당 owner에서 직접 확인하지 않았음을 남겼다.

`fixture-inventory.test.ts`는 누락 ID·정책·참조·고정 SHA를 검사한다. 실제 행동 assertion을 대신하지 않는다. 각 참조 테스트가 자기 입력/기대값을 실행한다. 전체 신규 UI 옵션과 물리 장치 인수는 QF-07/QF-12–22 등에 남는다.

## 실제 보완·검증

기존 Qt 프로젝트 producer가 임시 phase에만 있었으므로 [영구 C++ producer](https://github.com/parkjh2568/myPaint/blob/c10a29a397aa77bb946c84406fd661db747164c0/web-app/tests/fixtures/qt-project-oracle.cpp)로 보존했다. Qt6.12.0의 실제 paintcore/Core/Gui에서 재실행한 RPAINT01 전체4,173B와 Qt RGBA 두 plane(각3,072B), metadata가 기존 파일과 모두 일치했다. JSON 텍스트 formatting만 달랐으며 expected는 바꾸지 않았다. README의 직접 c++/pkg-config 명령도 별도로 실행해 parsed fixture 전체 일치를 확인했다. Node 소비자는 Qt 설치 없이 실행된다.

스프레이에는 [고정 RNG/시간·literal5점](../../web-app/tests/fixtures/spray-literal.json)을 추가했다. 공개 도구에서35ms 가상 tick의16난수 호출과 literal raster, release/Undo/Redo, Escape 뒤 원본·기존 Redo, timer/capture 정리·늦은 release를2case로 확인했다. expected를 제품 rasterizer로 만들지 않았다. 실제 난수 분포나 물리 타이밍·Qt 난수 동등성의 검증은 아니다. `test:spray-contract`를 기존 CI에 연결했다.

| 검사 | 결과와 범위 |
| --- | --- |
| Node | 324개 통과. 기존 엔진/wire 소비자와 inventory1개 포함 |
| 최종 inventory | 리뷰 정정 뒤 독립 재실행 통과; index/provenance 검사 |
| 기존 CTest | 6그룹 통과: Qt core/UI·allocation·smoke와 기존 staging/Studio build 검사. OS GUI 검증과 구분 |
| 스프레이 | 공개 Chrome2case, 오류0. RNG/가상 clock 및 native transport 모형의 범위 |
| 타입·포맷·로컬 build | 통과. runtime와 payload hash는 기존 제품과 동일 |
| 독립 검토 | Architect·Reviewer·SRE가 명령 표기, 입력/기대 범위와 독립성 정정 후 QF-02 자체 조건 승인 |

명령의 `--parallel 2`, F06의 실제 bounds/취소 참조, pending Escape와 명령 취소, pan 관측 범위, Qt derived/mixed 출처를 리뷰에서 정정했다. 새 fixture framework나 runtime helper·의존성·IPC는 추가하지 않았다.

## 완료 판정과 남은 작업

QF-01에 이어 QF-02를 완료로 갱신한다. 전체 감사는7개 자체 조건 입증·25개 부분·2개 미구현이며 선행까지 닫힌 항목은 QF-01/QF-02다. QF-04의 최신 조건별 확인은 별도 진행한다. 형식 필드·픽셀 정책·서명/배포·실기기·성능의 다른 완료 조건을 이 목록 검사로 대신하지 않는다.

사용자 잠금 해제 뒤 같은9f01 바이너리의 일반 macOS 실행에서 복구·코덱·종료·scene4단계가 모두 통과했다. 실행 직후 AppKit 관측은 active=true/hidden=false였으며, 각 LaunchServices wait가 완료되고 성공 marker를 확인했다. 이 경로의 launcher exit는0이지만 실제 app의 OS exit code는 직접 관측할 수 없어 null/미관측으로 기록한다. OS picker·Windows·물리 기기 승인의 대체가 아니다.

검증 도구는 Mac bundled app의 기본 실행을 LaunchServices로 하고 Windows/plain binary는 직접 실행하며 `PAINT_NATIVE_LAUNCH_MODE=direct` 진단 경로를 유지한다. 네 번의 호출에 공통인 프로세스/로그/timeout 자원 소유권만 실행기 하나에 모았다. 잘못된 mode는 앱 시작 전에 거부했고 로그는1MiB capture 한도, 실패 정리는 정확 executable+고유 persistence-root로 한정한다. 이는 앱 runtime의 shell 기능이 아닌 개발 테스트 도구다.

앞선 직접 실행120초 실패와 첫 foreground4 시도120초 실패, 초기20초 `project-read-large` 실패도 보존했다. 단일 foreground control은7.6초에 통과했고 마지막4단계도 통과했지만, 120초 내 smoke가 완료되지 않은 실패 단계와 원인은 미확정이다. 잠금·실행 방식·활성 상태의 관측만으로 원인을 확정하거나 실패를 삭제하지 않는다. 코덱20초와 프로세스120초 제한 및 네 fixture의 기존 assertion은 유지했다.

최신 제품은 계속 `index-DLvOR2As.js`, payload9파일·291,639B다. 홈페이지 쓰기·Git commit/push·공개 배포는 하지 않았다. 모바일·태블릿은 웹, 실행파일은 Windows/macOS만 제공한다.
