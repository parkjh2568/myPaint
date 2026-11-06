# macOS 검증 단계 관측과 소스 빌드 성능 비교

2026-11-06. [실행·소스·독립 검토 근거](evidence/studio-native-timing.json). 이번 변경은 실패 위치를 구분하기 위한 검증 코드 보완이다. 첫 네이티브 timeout의 원인 규명이나 전체 출시 인수를 완료했다는 뜻은 아니다. 모바일·태블릿은 웹 전용, 실행파일은 Windows/macOS 대상이다.

## 확인한 현상과 변경

이전 macOS persistence smoke는 이미지 처리의 20초 제한으로 한 번 실패했다. 기존 로그로는 대용량 project-write, project-read, 소형 project-write 중 어느 작업인지 구분할 수 없었다. 같은 바이너리의 기존 재시도는 통과했다. 사용자가 화면이 켜져 있고 앱 창을 볼 수 있다고 답한 뒤, 이번에도 같은 바이너리 `af2fb336046b`의 복구·코덱·종료·scene 4단계가 통과했다. 이 결과는 최초 실패가 절전이나 백그라운드 실행 때문이었다는 입증이 아니다.

`platform/native-smoke.ts`의 persistence 분기에만 local stage와 시작 시각을 추가했다. 중첩됐던 `recovery.read(entry)`를 같은 함수 안의 순차 const로 옮겨 저장소 read와 project decode 실패를 구분한다. 실패하면 한 번 읽은 시각으로 전체·단계 경과시간을 계산하고, 원래 오류와 실패 당시 visibility/focus를 기존 오류 보고 경로로 전달한다. 별도 helper·IPC·의존성·원격 전송·일반 UI 로그는 추가하지 않았다. codec의 20초 제한, 성공 JSON, 기존 예상 실패 검사와 종료 방식은 유지한다.

이는 JS catch에 도달한 실패의 단계와 wall time이다. Worker 내부의 constructor/post/ready/encode 단계나 OS hang을 직접 계측하지 않으며, 실패 당시 visibility/focus가 지연 원인을 증명하지도 않는다. 재발하면 이 기록으로 실제 실패 작업을 먼저 특정한 뒤 필요한 내부 관측만 추가한다.

## 검증 범위

- 실제 macOS arm64/WKWebView: 수정 전 같은 실행파일 4단계와 수정 후 새 실행파일 4단계 모두 통과했다. 새 바이너리는 `7309041fbf82`다. 64MiB를 넘는 67,126,671바이트 복구 파일의 픽셀 roundtrip·stale handle·legacy 보호·문서 세대 교체, GIF codec, 종료 취소/승인, scene 검증을 포함한다. OS 파일 선택기·Windows·실제 Android 인수는 포함하지 않는다.
- 독립 Node 모델 6개: 실제 함수 전체를 AST 추출·transpile하고 실제 4096² random fixture와 SHA를 사용했다. codec 세 번의 각 거부, 별도 recovery read 거부, fixture hash 거부에서 stage·원래 Error.cause·시간·visibility/focus와 후속 작업 중단을 확인했다. 성공 시 기존 7개 JSON key·codec 순서·단일 보고를 확인했다. codec/IPC/clock/가시성은 모델이며 실제 20초 대기나 성능 측정이 아니다.
- 타입 검사·Prettier·Vite·macOS 앱 빌드·로컬 Studio 빌드가 통과했다. runtime 소스 17개 중 검증 모듈 하나만 변경됐고 engine/format/codec/Worker/Rust는 그대로다. Worker SHA는 `2cefd7596758`로 같다.

최종 entry는 `assets/index-BKLmkHlU.js`다. 로컬 payload는 LICENSE·고지를 포함해 9파일·291,492바이트이며 `bundle.json`은 별도다. 소스 입력 114개와 payload SHA를 확인했다. 홈페이지 쓰기·커밋·푸시는 수행하지 않았다.

## CRC 소스 빌드 비교

최종 소스 17개를 동결한 별도 트리에서 기존 for-of와 indexed-loop 한 줄만 다른 후보를 같은 Vite 설정·의존성으로 빌드했다. 기준 Worker는 제품의 `2cefd7596758`을 정확히 재현했고 후보는 실제 소스 빌드의 `6e80ecb8`다. 생성된 chunk URL까지 포함한 실제 파일을 사용했으며 이전 emitted-byte patch 실험과 구분한다.

128MiB low/high 입력에 AB/BA/AB 순서로 각각 paired n3, 총 12개 Worker 작업을 실행했다. 아래는 main에서 Worker 생성 직전부터 원래 reply callback 진입까지의 전체 API wall time이다. 시작·로드·JIT·스케줄링·인코딩·응답 전달을 포함하며, fixture 생성과 결과 hash/decode 검증은 제외한다. CPU·p95·Android·WKWebView 성능으로 확대하지 않는다. HTTP/code cache의 cold 상태를 강제하지 않았고 다른 OS 작업의 부하까지 격리한 측정도 아니다.

| 입력 | 기준 A, ms | 후보 B, ms | 쌍별 변화 |
| --- | --- | --- | --- |
| low | 1322.0 / 1249.5 / 1278.3 | 1255.3 / 1300.2 / 1376.8 | −5.0% / +4.1% / +7.7% |
| high | 6707.3 / 6110.1 / 5390.1 | 4486.7 / 6220.0 / 3460.6 | −33.1% / +1.8% / −35.8% |

12개 응답 전체 buffer의 SHA-256·길이가 고정 기준과 같았고, 입력별·후보별 첫 표본 4개는 전체 RGBA/alpha0 숨은 RGB·metadata를 decode 비교했다. 나머지 8개는 전체 encoded digest·길이를 비교했고 별도 PNG 출력 작업은 추가하지 않았다. 이 correctness 범위는 통과했지만 low 혼재가 해결되지 않았다. high도 모든 표본에서 개선되지 않아 **제품에는 적용하지 않았다**. 추가 반복으로 유리한 결과를 고르지 않고 format/Worker 원문을 유지한다. 현재 근거로 CRC 루프 변경의 모든 환경 무회귀나 절대 성능 예산 충족을 주장할 수 없다.

## 남은 게이트

첫 timeout 원인과 재발 조건은 미확정이다. OS 파일/IME·실제 Android 웹·Windows·최대 입력/RSS/지연·공개 CI·서명/공증·Pages 인수는 남는다. 전체 34태스크의 6입증·26부분·2미구현 및 선행까지 닫힌 QF-01 판정은 바꾸지 않는다.
