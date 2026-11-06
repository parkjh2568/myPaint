# Codec 응답 계약과 Worker 비용 분해

2026-11-06. [소스·최초 실패·수정·독립 검증](evidence/studio-codec-reply.json). 확정된10개 Worker 작업의 성공/오류 계약을 보완했다. 전체 전환·실기기·출시·네이티브 안정성 완료나 성능 개선 선언이 아니다. 모바일·태블릿은 웹, 실행 파일은 Windows/macOS 전용이다.

## 재현과 우선순위

| 위험·수정 비용 | 실제 재현한 영향 | 수정 |
| --- | --- | --- |
| Major / S: write 결과 누락 | matching profile 응답에 bytes 누락/null/빈 값을 주입하면4종류 출력이9바이트 `undefined`,4바이트 `null`,0바이트 실제 파일로 준비됐다. 클립보드 수락 모델에서는 잘라내기가9바이트 PNG Blob을 수락한 뒤 active 원본과 Redo를 지웠다. | write 작업마다 Uint8Array·nonempty·프로필 byte 한도를 확인한다. 잘못된 결과가 소비자 성공 분기로 도달하지 않는다. |
| Major / S: state 픽셀/색상 계약 | Array/Uint8Array 픽셀 응답을3개 state 작업에 주입하자 문서와 Redo가 훼손됐다. 별도 Node+실제 엔진에서는 길이4의 sparse 바탕색이 설치된 뒤 clone/UndoRedo가 유효성을 잃었다. | bounded layer 수·string 이름·Uint8ClampedArray plane·바탕색4개 own 성분을 확인하고 기존 validate를 재사용한다. |
| Minor / S: 잘못된 응답을 NoOp로 처리 | project-read state와 fill image key 누락은 무음 반환이었다. 완전히 밖인 ROI의 공개 주입도 오류 없이 무변경이었으며, 소비자는 소스상 영역을 clipping한다. 일부 geometry/selection 누락은 기존 소비자에서 이미 거부했다. | 작업별 필수 필드와 fill의 source-contained 정수 ROI를 검증한다. 정상 fill의 own `image: undefined`는 성공 NoOp로 유지한다. |
| Minor / S: messageerror 지연 | 모델 deserialization-error에는 별도 handler가 없어 기존20초 timeout까지 정리가 늦었다. | 같은 finally를 사용하는 즉시 reject handler를 둔다. |

오류는 명시적으로 실제 Worker 응답을 한 번 바꾼 테스트이며 정상 Worker의 자연 장애라고 주장하지 않는다. 클립보드는 실제 ClipboardItem/getType Blob과 수락 모델을 사용했고 OS 수락을 검증하지 않았다. sparse 사례와 자원 slot 검사는 Node 모델을 구분한다. 유효한 타입/shape라고 해서 모든 의미상 틀린 픽셀이나 파일을 재계산·인증하는 기능은 아니다.

## 10개 작업의 최소 성공 계약

| 작업 | 필수 결과와 정상 NoOp |
| --- | --- |
| project-read, geometry, layer-edit | 유효한 State, typed RGBA plane, metadata/profile 한도. 누락 state는 NoOp가 아니다. |
| png-read | 크기와 정확한 Uint8ClampedArray RGBA plane을 가진 image |
| project-write, png-write, jpg-write, bmp-write | 비어 있지 않은 Uint8Array, profile.inputBytes 이하 |
| selection | 입력 crop과 같은 image 치수, width×height mask bytes. binary 값 scan/yield는 기존 main owner에 유지 |
| fill | own image key가 필수이며 undefined만 정상 NoOp. 그 외에는 유효 Raster와 source 안의 left/top 정수 ROI |

알 수 없는 operation은 Worker 생성·slot·transfer 전에 거부한다. envelope/profile/error와 필수필드를 검사하고, timer/abort/terminate/active 정리는 기존 finally가 소유한다. 잘못된 layer 목록은16개 초과 scan 전에 거부한다. 입력 후보의 크기는 transfer 전에 저장해 검증 중 바뀐 객체에 의존하지 않는다. live 문서·이력 buffer는 전송하지 않는다. 새로 분리한 helper·클래스 필드·모듈·의존성은 없다.

## 실제 검증과 네이티브 잔여 사항

동일한 최종 공개 드라이버27개는 기준22실패/기존 대조5통과에서 후보27통과·pageerrors0이 됐다. source·메타데이터·oldRedo, 거부 뒤 실제 파일·PNG/JPG/BMP 정상 재시도, 정상 cut 뒤 Undo 원문 복구와 fill 실제 NoOp를 확인했다. 작은 문서의 긴 lasso 경로는 trusted down 뒤8193개 합성 public move/release로 실제 selection Worker 경로에 도달했으며 물리 펜 시험이 아니다. 실제 로드5자산과 다운로드163개 SHA도 고정했다.

독립 API 검사89기록(하위88+부모1)은 고정 기준33통과/56실패(부모 실패 포함)에서 최종89통과가 됐다. 정상10작업, malformed envelope/fields, typed plane·sparse색상·selection mask·fill ROI,2slot/3번째거절·unknown·constructor/post/error/messageerror·abort/20초 모델 timeout·late reply 정리를 확인했다. 전체 Node323개와 기존 웹48개·fill 실패10종류×2회·selection preparation13개·clipboard 모델4개·복구 오류5개도 통과했다.

macOS 첫 persistence 검증은 codec의20초 timeout으로 exit1이었다. 원문을 보존했고 어느 operation에서 멈췄는지 현재 stdout만으로 확정하지 못했다. Worker 파일은 기준과 byte-exact이며 새 callback에는 정상 픽셀/bytes의 장시간 순회가 없음을 독립 검토했다. 동일 바이너리 `af2fb336046b`를 잠금 해제 관측·일시적 awake 조건에서 재시도했을 때 실제 WKWebView·IPC/복구·코덱·종료·scene4단계와 정상 종료가 통과했다. 이것이 최초 실패 원인이 전원·환경이었다는 입증은 아니다. 최초20초 timeout 원인과 실제 runtime 부하/첫 실행 안정성은 QF-24/30 게이트로 남긴다. OS picker·Windows·실기기 인수의 대체도 아니다.

## Worker 시간의 근본 분해

Worker 생성/준비와 동기 인코딩 시간을 분리했다. 재빌드한 계측 번들 차이를 통제하기 위해 원본 production Worker의 clock-only literal patch와 수정 없는 import-ready 대조를 별도 cohort로 썼다. 원래 reply와 transfer는 바꾸지 않았고 patch 역적용으로 원본 SHA를 재구성했다.

| 입력, n3 | encodeProject wall | Adler | deflate | PNG CRC |
| --- | --- | --- | --- | --- |
| 웹16MiB high entropy | 689–759ms | 33–35ms | 332–386ms | 306–324ms |
| 데스크톱128MiB low | 1203–1289ms | 219–276ms | 953–985ms | 2.6–3.3ms |
| 데스크톱128MiB high | 5973–6253ms | 226–258ms | 2925–3085ms | 2618–2801ms |

Adler와 deflate는 zlib 구간의 하위 항목이며 위 표의 겹친 항목을 더하지 않는다. 수정 없는 원본 Worker도 import 완료 뒤 low 요청을 보내면1190–1275ms가 남았다. 시작 비용보다 인코딩·체크섬이 주비용이라는 근거다. 이는 Worker 함수 wall time이며 Chrome thread CPU가 아니다. 별도 Node process CPU9표본, Chrome69실험 작업, correctness roundtrip을 분리 보존한다. 데이터 엔트로피에 따라 지배 비용이 달라지며 n3를 p95·모바일·RSS·실제 OS I/O로 확대하지 않는다.

CRC의 for-of를 indexed loop로 바꾼 임시 후보42작업은 바이트·전체 RGBA·메타데이터가 같았고 high project31–53%, PNG26–38% 개선을 보였다. 그러나 low project 제어군은 재측정에서도 +4.8%/+15.2%/−1.6%로 혼재했다. 무회귀 근거가 없어 **생산 코드에 반영하지 않았다**. 배포 엔진·형식·Worker의 원문은 그대로다. 후보는 동일 생산 source/build의 별도 paired 후속 검증 대상으로 보존했다. 이번 응답 검증 수정의 성능 향상은 주장하지 않는다.

## 구조·산출물·다음 순서

런타임17개 중 platform/codec.ts의 기존 runCodec만 바뀌었다. 함수의 공개 signature, 다른 codec 함수, 엔진/형식/Worker/Rust는 유지한다. [현재 소스·배포 그래프](evidence/studio-codec-reply-module-graph.json)의 source runtime 순환0·정적 평가 순환0과 기존 동적 SCC2를 확인했다.

최종 codec `01499abbdac7`, entry `assets/index-CnFyP_9m.js`다. payload는 LICENSE·고지 포함9파일·290,519B, 검증 manifest는 별도다. 실제 홈페이지 쓰기·Git commit/push·공개 배포는 하지 않았다.

전체34태스크는6입증·26부분·2미구현, 선행까지 닫힌 것은 QF-01뿐이다. 다음은 네이티브 timeout이 반복될 때 operation/Worker/post/result 단계 시각으로 원인을 좁히는 진단, 동일 생산 build의 CRC 후보 검증과 인코더 비용 대안 비교다. 형식·버퍼·입력 지연·실제 WK/OS I/O·RSS, Android 웹/IME·Windows·보조공학·공개 CI·서명/공증·복구 인계·Pages 승인 게이트도 남긴다.
