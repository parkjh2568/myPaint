# 네이티브 저장 기준과 복구 조회 소유권

2026-11-06. [재현·수정·독립 검토·실행 근거](evidence/studio-native-ownership.json). 이번 단계에서 저장 기준과 복구 조회의 두 결함을 수정했다. 전체 전환·출시 완료가 아니다. 당시 대기한 GUI 재검증은 후속 [최신 소스 macOS 앱 검증](STUDIO_NATIVE_CURRENT.md)에서4분기 통과했으며, 아래 실패 기록은 당시 근거로 보존한다. 모바일·태블릿은 웹, 실행파일은 Windows/macOS 전용이다.

## 확인한 결함과 수정

| 위험 / 비용 | 실제 확인한 조건·영향 | 수정 |
| --- | --- | --- |
| Major / S — 저장 후 다른 파일을 기준으로 채택 | 원자 교체 직후부터 binding 갱신 전 사이에 다른 프로그램의 파일 교체를 배치했다. 기존 Rust 모듈 사본에서는 다음 일반 저장이 외부 버전을 덮었고, 영구 회귀도 기준 binding 구현에서 다음 claim이 잘못 허용돼 실패했다. | 새 경로를 다시 열지 않고 방금 게시한 `stage.file`의 열린 핸들에서 identity·stamp를 얻는다. 다음 저장은 후발 교체를 변경으로 인식해 거부한다. |
| Minor / S — 복구 목록의 선택 권한 만료 | 500ms 자동 조회와 수동 조회를 앞뒤 두 순서로 겹쳤다. Rust의 새 목록은 이전 token을 만료시키지만 기존 IPC 모형은 이 동작을 빠뜨렸다. 열기·삭제 4개 경합에서 변경 없는 사본 선택이 실패했다. 원본·Redo 손상은 없었다. | `openRecovery`의 첫 await 전부터 목록·대화상자·읽기/삭제·문서 교체가 끝날 때까지 `recoveryOpening` 소유권을 유지하고 finally에서 해제한다. 자동 조회는 이미 열린 모달도 피하며, 모형도 Rust처럼 token을 갱신한다. |

저장 경합은 생성한 임시 파일의 실제 Rust I/O에 결정적인 한 번의 교체를 배치한 재현이다. 실사용 중 자연 발생한 사용자 데이터 사고를 관측했다는 뜻은 아니다. 테스트 전용 `Stage.after_commit` 경계는 `cfg(test)`에만 존재한다. 처음 생성하는 파일과 기존 파일을 각각 확인했고, 정상 반복 저장과 임시 파일 정리도 검사했다.

이미 원자 교체가 성공한 뒤 metadata를 얻지 못하면 binding을 비우고 성공 receipt는 유지한다. 다음 저장은 대상을 다시 선택하게 된다. 이 경로는 독립 코드 검토로 확인했으며 metadata 실패 자체를 새로 주입한 실행은 아니다. 이미지 내보내기의 기존 project binding과 복구 저장의 receipt 계약은 바꾸지 않았다. 모든 외부 동시 쓰기를 잠그는 기능으로 확대하지 않는다.

변경은 기존 함수 안의 순차 처리와 실제 소유권 필드에 한정했다. 새 runtime helper·모듈·의존성·IPC·업로드·telemetry는 추가하지 않았다. 새 주석은 열린 파일 identity를 유지해야 하는 이유와 테스트 경계를 설명하며 완료된 TODO는 남기지 않았다.

## 검증 범위

- 실제 macOS Rust 검사 19개 통과. 새 저장 경합 회귀는 기준 구현에서 실패하고 수정 후 통과했다. 정상 반복 저장, 실제 복구 목록 token 만료 검사도 포함한다. 전체 Rust Clippy와 타입·포맷 검사가 통과했다.
- 독립 Chrome 공개 UI: 같은 드라이버·수정한 IPC 모형으로 기준 경합 4개 실패/대조군 3개 통과에서 후보 7개 통과·pageerrors0이 됐다. 두 방향의 열기·삭제와 목록 오류·대화상자 취소·읽기 오류 후 재시도를 확인했다. 전체 RGBA·숨은 RGB·레이어 metadata와 oldRedo의 실제 저장/재생을 비교했다.
- 영구 `test:native-recovery-flow`도 7개를 재실행하고 CI에 연결했다. 이는 같은 시나리오의 반복이며 독립 14개로 합산하지 않는다. 기존 Node323개, 웹48개(기본13/동시성3/편집13/저장13/shear6), 네이티브 IPC 모형15개도 통과했다.

Chrome의 native bridge는 in-memory 모형이다. 실제 OS 파일 선택기·WKWebView·Windows I/O 인수로 대체하지 않는다. 이번 Rust 검사는 실제 임시 파일 I/O이며 앱의 OS picker를 조작한 시험은 아니다.

후속 [최신 소스 macOS 앱 검증](STUDIO_NATIVE_CURRENT.md)은 epoch guard까지 포함한 새 바이너리의 일반4분기 통과다. 아래 GUI 실패와 메모리 측정은 이전 바이너리의 별도 실행으로 유지한다.

## 실제 저장소 메모리 측정

최종 바이너리 `9f01dfc2822f`의 `--io-smoke`를 1회 측정했다. 이 경로는 Tauri/WK 초기화 전에 반환한다. 합성 `RPAINT01` magic+0x5a 데이터 65→300MiB를 같은 Rust 프로세스에서 순서대로 저장·읽고 전수 비교한다. 정상 프로젝트 이미지의 decode/render 측정은 아니다.

| 단일 프로세스 lifetime | 값 |
| --- | ---: |
| 최대 RSS | 397,049,856B · 378.66MiB |
| kernel peak physical footprint | 389,628,744B · 371.58MiB |

`time -l`의 highwater와 정확히 같은 child의 libproc 50ms 샘플 11개를 분리했다. physical sampled peak는 389,612,360B로 highwater보다 한 페이지 작았다. 부모의 종료 후 검증 메모리는 포함하지 않는다. native 내부는 65·300MiB를 전수 비교했고, 외부에서는 마지막 300MiB envelope·metadata·payload를 1MiB씩 독립 전수 비교했다. 큰 payload는 제거했고 작은 근거 11파일·41,325B만 보존했다. n1·screen-locked 조건의 Rust 저장소 기준이며 전체 Tauri/WK·최대 문서·Android·입력 tail·p95·성능 예산 충족을 의미하지 않는다.

## 당시 macOS GUI 실패 기록

당시 바이너리의 일반 smoke 실행은 `project-read-large`에서 20초 제한으로 실패했다. 전체 경과 37,961ms, 해당 단계 20,109ms, 실패 당시 visibility=hidden/focus=false였다. engine/format/codec/Worker는 이전 검증과 같으며 Worker SHA는 `2cefd7596758`이다. 제한을 늘리거나 실패를 통과로 바꾸지 않았다.

같은 바이너리를 LaunchServices의 foreground 실행으로 비교했을 때는 화면 잠금을 독립 관측했고, JS 완료 신호 없이 120초 watchdog으로 종료됐다. 생성한 테스트 앱 PID의 종료와 임시 폴더 제거를 확인했다. 나중에 관측한 잠금 상태만으로 앞선 20초 실패 원인을 확정할 수 없다. 이 단계에서는 사용자에게 잠금 해제 가능 여부를 물었고 GUI 재검증을 남겼다. 후속 [최신 소스 macOS 앱 검증](STUDIO_NATIVE_CURRENT.md)에서 새 바이너리의4분기가 통과했으며, 앞선 실패 원인은 여전히 미확정이다.

## 산출물과 후속 인수

entry는 `assets/index-DLvOR2As.js`, 라이선스·고지를 포함한 웹 payload는 9파일·291,639B다. 빌드 입력115개와 runtime 소스17개를 고정했고 실제 시험한 앱 자산8개가 최종 payload와 같다. 제품 소스 변경은 main.ts와 persistence.rs 두 곳이며 import 관계는 유지한다. 홈페이지 쓰기·Git commit/push·게시를 하지 않았다.

당시 후속 항목이던 독립 기준 목록·QF-04 계약과 최신 소스 macOS 일반4분기는 이후 검증했다. 현재 우선순위와 전체 자체 판정7입증·25부분·2미구현, 선행 완료QF-01/02/04는 [최신 완료 감사](STUDIO_COMPLETION_AUDIT.md)를 따른다. 목표 장치·메모리/입력 예산과 Android 웹·Windows·OS picker/IME 인수는 계속 남는다.
