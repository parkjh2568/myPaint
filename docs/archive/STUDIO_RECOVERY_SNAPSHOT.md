> 과거 검증·설계 기록입니다. 현재 실행 방법은 [루트 안내](../../README.md)를 따르세요. 아래 수치는 기록 당시 환경에만 적용됩니다.

# 자동 복구의 오류 경계와 비용 분해

2026-11-06. [소스·최초 실패·측정·독립 검토](../evidence/studio-recovery-snapshot.json). QF-24의 확인된 복구 경계를 수정한 단계이며 전체 전환·실기기·성능 예산·출시 완료는 아니다. 모바일·태블릿은 웹 전용, 실행 파일은 Windows/macOS 전용이다.

## 우선순위·원인·수정

| 순서·위험·비용 | 재현 조건과 실제 영향 | 수정 |
| --- | --- | --- |
| 1 Major / S: 오류 응답의 복구 성공 오인 | Worker 응답의 bytes를 의도적으로 누락/null 처리했다. runCodec은 결과를 resolve하고 웹 Store는 bytes 분기를 건너뛰어 빈 transaction을 성공 처리했다. autoRecover가 recoveredRevision을 전진시켜 같은 revision 재시도를 막았다. 이전 사본은 유지됐지만 새 사본은 없었다. 정상 Worker에서 자연 발생한 장애라고 주장하지 않는다. | 저장 owner 진입부에서 Uint8Array·비어 있지 않음·프로필 한도를 공통 검증한다. native/IDB 접근과 sequence 변경 전에 거부한다. key·generation·quota·트랜잭션 완료/실패 의미는 유지한다. |
| 2 Minor / S: 이전 문서의 늦은 오류 표시 | A의 복구 응답을 지연시킨 동안 B를 열고 오류를 돌려주면 B의 상태가 A 복구 실패로 바뀌었다. 픽셀·사본 오염은 관측하지 않았다. | 같은 epoch가 소유한 화면에만 오류를 표시한다. finally 정리와 같은 문서의 실패 알림·재시도는 유지한다. |

누락/null의 공개 재시도2개와 늦은 상태1개는 수정 전 실패했고, 빈 bytes/명시적 오류 제어2개는 기존부터 안전했다. 최종5개가 모두 통과했다. 기존 사본·문서 전체 RGBA·메타데이터·Redo 보존, 오류 메시지, 같은 revision의 재시도와 B의 후속 복구까지 확인했다. B 복구 뒤에도 A의 기존 사본이 남는다.

`nativeReady` 대기 중 새 provisional 획이라는 모델은 현재 초기 inert/모달·clean 문서와 교체 수명주기에서 실제 공개 경로를 입증하지 못해 Major로 세지 않았다. 복구는 확정 revision을 저장한다. 미확정 문자/선택은 그대로 pending이며, active layer만 고르는 UI 변화와 문서 revision은 별도 정책이다.

## 실제 비용과 채택 판단

복구는 snapshot을 한 번 복사하고 그 후보의 버퍼를 Worker에 transfer한다. 버퍼 ID가 같고 전송 직후 길이가0인 것을 확인했다. live 문서와 이력 버퍼는 넘기지 않는다. transfer를 또 한 번의 전체 픽셀 복사로 계산하지 않는다.

| 관측 단계 | 웹 1K²·1레이어·4MiB, n3 | 데스크톱 프로필 4K²·2레이어·128MiB, n3 |
| --- | --- | --- |
| 전체 복구 tick | 53.8 / 55.0 / 51.5ms | 1193.1 / 1092.4 / 1060.1ms |
| 동기 snapshot slice 합 | 0.3 / 0.4 / 0.4ms | 14.7 / 13.4 / 24.7ms |
| Worker post→result | 50.7 / 51.1 / 49.2ms | 1175.3 / 1078.3 / 1034.4ms |
| 저장 구간 | 실제 IDB tx 1.7 / 2.5 / 1.3ms | native IPC 모델 1.9 / 0.2 / 0.2ms |

실제 Chrome의 생산30초 callback을 테스트가 명시 호출했다. 각 표본의 전체 픽셀·숨은 RGB·레이어 이름/표시·active/background, 기존 Redo→Undo와 같은 revision의 slice/Worker/저장 무작업을 확인했다. 웹 공개 복구 재열기도 통과했다. 데스크톱 재열기는 같은 기준 번들의 별도 새 문맥 n1에서 generation·ready canvas·공개 재저장 전체 상태로 확인했다.

Worker 구간은 생성·스케줄링·인코딩을 포함한 wall time으로 순수 codec CPU가 아니다. 웹은 실제 IndexedDB, 큰 문서의 저장은 기존 메모리 IPC 모델이다. 물리 디스크 flush·실제 네이티브 IPC/파일 성능은 측정하지 않았다. 표본은 한 문맥의 연속 revision3개이며 p95·장치 보장은 아니다. tick 안에서 시작한50ms 이상 LongTask는 관측되지 않았지만 전체 앱 무끊김을 뜻하지 않는다. 별도 Node clone4사례는 UI 측정과 합산하지 않는다.

현재는 안전한 후보 복사/transfer를 유지한다. 분할 copy·COW·Worker 재사용·압축 캐시는 채택하지 않았다. 이번 두 수정의 성능 향상을 주장하지 않는다. 다음 성능 조사에서는 Worker 내부 CPU와 시작 비용, 다른 압축 난이도의 이미지, 실제 WK/OS I/O와 입력 지연을 분리한다.

## 검증·계측기 교정

- 최종 단위234개, 새 실제 웹 오류 주입5개, 기존 저장13개·네이티브 영속성 모델15개·웹48개가 통과했다.
- 독립 Store 경계48개는 Node browser/native stub 검사다. 잘못된 타입·빈 값·초과 크기를 I/O/sequence 변경 전에 거부하고 유효한 범위는 전달하는지 확인했다. 실제 플랫폼48개로 세지 않는다.
- 최종 macOS 앱의 WKWebView·IPC/복구·코덱·종료·scene4단계와 정상 종료를 확인했다. OS picker·Windows·Android 인수의 대체가 아니다.

최초 root 하네스는 없는 `#status`를 기다려 실패했으며 실제 `.status`로 바로잡은 뒤 제품의3실패를 재현했다. SRE는 초기 ESM 경계와 Blob subclass 관측기를 교정했다. subclass는 IDB에서 돌아온 원래 Blob의 instanceof 의미를 바꿨다. 작은 roundtrip으로 원인을 분리하고 원래 prototype을 유지하는 Proxy로 측정했다. 첫 실행 원문과 유효한 웹3표본을 최종 측정으로 소급 합치지 않았다.

데스크톱 복구 뒤의 성공 문구는 정상 비동기 렌더에 덮일 수 있었다. 원문 timeout을 유지하고 별도 n1에서 실제 문서·generation·출력 상태를 비교했다. 기존 n3 시계열은 그대로 보존했다. 측정·정확성 검증·오류 주입의 범위를 구분한다.

## 구조와 남은 게이트

런타임17개 중 main의 autoRecover와 storage의 request만 변경했다. 새 helper·필드·모듈·의존성·엔진/형식/codec/Rust 변경은 없다. 기존 중복 byte 검사만 공통 owner로 옮겼으며 sequential 작업은 소유 함수 안에 둔다. [현재 의존성·AST 기록](../evidence/studio-recovery-snapshot-module-graph.json)의 source runtime 순환0·배포 정적 평가 순환0과 기존 동적 SCC2를 유지한다.

최종 main `809e911ded98`, storage `6e3da32de5fe`, entry `assets/index-BZZOX9cr.js`다. 웹 payload는 LICENSE 포함9파일·288,837B이며 manifest는 별도다. 실제 홈페이지·Git commit/push·공개 배포를 변경하지 않았다.

전체34태스크 판정은6입증·26부분·2미구현, 선행까지 닫힌 것은 QF-01뿐이다. 다음 안전성 감사는 runCodec의 전연산 응답 계약과 다른 소비자의 오류 출력이다. 저장 owner guard를 모든 export/read/geometry의 검증 완료로 확대하지 않는다. 성능 조사와 실제 Android 웹·OS IME/파일·Windows·보조공학·공개 CI·서명/공증·복구 인계·Pages 전환 게이트도 남긴다.
