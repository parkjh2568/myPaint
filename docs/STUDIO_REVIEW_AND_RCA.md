# Studio 독립 리뷰·RCA·성능 수정 기록

2026-11-04 / 현재 Qt-free 전환 작업의 수정 배치. 전체 전환·출시 완료 보고가 아니다. Architect, Implementation Engineer, Reviewer, SRE/Optimizer가 같은 작업 트리를 독립 검토하고, 재현 → 수정 → 회귀 → 별도 고정 스냅샷 인수를 진행했다.

## 요구사항과 설계 적용 범위

이 제품은 로컬 그림 편집기다. 모바일·태블릿은 HTTPS 웹만, 설치 실행파일은 Windows/macOS만 제공한다. 기존 offline/no upload 규칙을 유지하므로 서버·계정·RDBMS·HTTP API를 새로 추가하지 않는다. 요구한 DB/API/인증 설계는 실제 제품의 IndexedDB 스키마, 로컬 파일 계약, Worker/네이티브 IPC와 권한 경계로 구체화한다. 해당 계약은 [아키텍처](STUDIO_ARCHITECTURE.md)에 정리했다.

| 목표 | 이번 배치에서 확인·수정한 근거 | 남은 완료 조건 |
| --- | --- | --- |
| 제품 요구·최소 프로덕션 구조 | 독립 엔진/DOM UI/플랫폼 경계, 로컬 데이터·권한·배포 계약, 정적 앱과 macOS 패키지 실행 | 네이티브 기능 동등성과 실제 목표 기기 인수 |
| 레거시 인수·호환 리팩터링 | Qt 원본의 선택·변형·복구 정책과 신규 코드 비교, Qt oracle 40개, 후보 확정·자원 소유권 수정 | 모든 F01~F10·17개 도구·형식 조합의 전환 인수 |
| 장애 RCA·재발 방지 | 아래 실제 재현, 원인 추적, 실패/경합 테스트, 원본 보존 경계 | 실제 디스크 부족·OS 잠금·기기 예외 추가 인수 |
| 측정 기반 성능 | 같은 문서/궤적의 전후 계측, 업로드·CPU·이력 메모리 구분 | 큰 구조 작업·실제 GPU/WebView·Android 지연과 피크 메모리 |
| 4개 역할 독립 검토 | 역할별 코드/설계/벤치와 리뷰 반환 수정, 별도 frozen snapshot 인수 | 새 변경마다 같은 검토 루프 유지 |
| PR 직전 품질 검증 | strict TS·Prettier·Node 26개·브라우저 45개·macOS bundle smoke, CI 연결 | 원격 CI·Windows 실행·서명·안전 staging·공개 인수 |

## 위험도·수정 비용과 RCA

Blocker는 현재 구현으로 기존 제품을 교체하기 전에 해결해야 하는 데이터 보존 문제, Major는 필수 기능·계약·성능 문제, Minor는 제한된 유지보수/자원 문제로 구분했다. 아래 해결 여부는 이 배치의 해당 재현 범위만 뜻한다.

| 항목 | 분류/비용 | 재현·호출 경로·근본 원인 | 영구 수정과 확인 |
| --- | --- | --- | --- |
| macOS 앱 종료가 미저장 확인 우회 | Blocker / M | 창 닫기만 가로챔 → `app.exit`는 `ExitRequested`, 기본 Cmd+Q/Dock은 `NSApplication.terminate:`로 별도 종료. Tao 0.37.2 실제 프로브에서 창 닫기를 막아도 앱 종료는 통과 | runtime 종료와 macOS delegate 종료를 현재 UI 확인에 연결. 문서 활성화 후 보호, 승인 후 입력 동결, IPC 실패 시 복원. 실제 macOS bundle에서 두 종료 경로의 미저장/문자/작업 중 보존·반복 요청·최종 승인 종료를 확인. [후속 근거](STUDIO_MAX_DOCUMENT.md) |
| Pending 중 Redo 단축키가 원본문서 변경 | Major / S | 헤더 Redo는 비활성화됐지만 Ctrl+Shift+Z/Ctrl+Y가 command redo를 직접 호출 → pending 아래의 committed 문서에 과거 변경을 재실행 | 공통 redo 명령에 inline pending 가드. 실제 Qt disabled QAction 키 시험으로 무동작 계약을 확인하고 수정 전 12개 실패→수정 후 12개 보존을 확인. 실패/취소 24개와 독립 clipboard 4개도 통과. [근거](evidence/studio-pending-contracts.json) |
| 비동기 편집 소유권 | Blocker / M | 채우기 Worker를 지연시키고 레이어 B 클릭 → 입력은 A였으나 완료 시 현재 active=B로 결과 적용. 저장 중 Enter는 pending 문자를 확정해 revision 변경. 활성 획 중 Ctrl+S 거절도 공통 run.catch가 무관한 획을 취소 | 작업 중 조작부 inert·키보드 소유권, 직접 레이어 콜백 가드, 캡처한 문서/epoch/revision/active 재확인. 포인터 실패만 해당 획을 취소. 수정 전 세 사례 전부 실패, 수정 후 concurrency 3개 통과 |
| 최신 복구 사본 삭제 경합 | Blocker / M | 복구 목록을 연 뒤 원래 탭이 같은 key의 새 generation 저장 → 예전 항목의 삭제가 key만 보고 최신 head/blob까지 삭제 | 동일 readwrite 트랜잭션에서 key/sequence/size 재확인 후 삭제. 변경됐으면 abort·보존. 실제 UI에서 거부 후 최신 사본의 픽셀 재열기까지 확인 |
| 미확정 도형 중복 합성 | Major / M | pending polygon → image-size가 pendingState를 이미 래스터화한 후보로 확정 → points가 남아 다음 저장/Enter에서 재합성. 수정 전 예상 확대와 525채널 차이 | 크기/바탕/문서 변형을 editPending의 후보·검증·확정·pending 해제 경계로 통합. 단일 Undo와 실패 후 pending 보존 확인 |
| 연필·스프레이 의미 | Major / M | 1px 연필이 일반 AA 사각 브러시를 써 정수 좌표에 4픽셀 생성. 스프레이 랜덤 점도 이전 점과 보간해 선 생성 | 명시 pixel 모드의 8연결 픽셀 경로, dabsOnly의 독립 점. 타일·불투명도·이력 소유권은 공유. 엔진 5개 회귀 통과 |
| 지연된 문자 클립보드 | Major / M | await readText 후 현재 editor를 재참조해 새 편집기에 옛 결과 적용 가능. 최대 길이 계산은 교체할 선택 길이도 더해 정상 1자 교체 거부 | 원래 editor/value/range/epoch 캡처·재확인, 다른 작업이 소유 중이면 거부. 최종 길이로 한도 검증. 지연 응답·65536자 전체선택 교체 확인 |
| 터치 탐색 전환 | Major / M | 선택 이동 중 둘째 손가락 → drag만 지워 선택 위치/크기 복원 생략. 수정 전 이동 복귀 snapshot 972채널 차이 | cancelPointer 자원 경계로 선택/raster/수정 상태와 lasso 임시 경로 복원, 두 touch ID는 탐색용 유지. 곡선 제어점/다각형 점도 release 시 확정. 이동·resize·곡선 takeover 3개 확인 |
| 기울이기 잘림·선택 범위 | Major / M | 기존 폭 버퍼에 shear해 바깥 픽셀 잘림. 선택이 있어도 문서 전체 변형 | 확대 bounds·음수 원점·할당 전 메모리 한도, 선택만 변형하거나 후보 전체 확정. Qt 6.12 oracle 일반 경계 40개와 공개 UI 6개 확인 |
| 자유 선택 알파·숨은 RGB | Major / M | AA mask로 원본을 부분 삭제하고 같은 mask의 선택을 source-over해 a'=m+(1-m)^2. 원위치 복귀도 80채널 변화, alpha255→191. mask/source alpha0도 RGB를 0으로 덮음 | 기존 비AA clip 의미의 이산 evenodd mask, 원래 raster/위치 복귀는 무변경, 미도색 위치는 건드리지 않음. 이동 중 alpha0/255·복귀 exact·무이력과 hiddenRGB PNG 문자/Undo 확인 |
| 복구 총량·스키마 | Major / M | 신규 저장은 16개 제한만 있어 이전 32개/64MiB 계약과 다르고 총량 상한이 사라짐 | 공유 스키마 predicate, bounded cursor, 최대 32개·합계64MiB·own 교체 비용 제외·트랜잭션 rollback. 공개 UI autosave/DB 경로 13개 확인 |
| 재시도·경계 입력 | Major / S | 두 번째 곡선 제어점 push 후 raster 예외면 길이2가 남아 다음 클릭 길이3으로 재시도 불가. preset은 기존 도형을 확정하기 전 tool 교체. 최초 좌표만 미정규화되어 먼 pan 입력에서 보간 비용 폭증 가능 | 실패한 제어점만 되돌림, preset도 chooseTool 경계 사용, begin/move 좌표·필압 한도 일치. 단발 예외 주입·프리셋 단일 Undo·큰 finite 좌표 시험 |
| 선택 미리보기 자원 잔류 | Minor / S | 선택을 취소해도 selectionCache가 이전 pixels/cut/image를 참조 | 선택 소유권 setter에서 교체·해제 시 캐시 즉시 해제. 문자 소유권도 해제 시 IME 상태 정리 |

임시 우회인 ‘작업 중 레이어를 누르지 말기’, ‘선택을 움직였다 되돌리지 않기’, ‘기울일 그림을 작게 자르기’는 제품 해결책으로 채택하지 않았다. 기능을 유지하면서 해당 소유권·후보·트랜잭션 경계를 수정했다.

Qt +45° Fast 변환의 마지막 texel 중복은 원시 소스 픽셀을 한 번씩 보존하는 새 nearest 행 변환에서 재현하지 않는다. 일반 각도·음수 45°·fuzzy 0의 40개 oracle은 exact로 확인했고, 이 차이는 새 변형의 경계 렌더링 차이로 명시한다. 기존 파일의 원시 RGBA나 RPAINT01 필드를 변경하는 정책이 아니다.

## 측정 → 원인 → 수정 → 비교

[상세 측정 기록](evidence/studio-performance.json)은 before/after 소스·실제 UI bundle·Worker·harness 해시와 조건을 포함한다. 소프트웨어 렌더링의 데스크톱 Chrome 측정이며 Android 또는 물리 펜 지연이 아니다.

| 지표 | 수정 전 → 수정 후 | 해석 |
| --- | --- | --- |
| 800×600/12px 획의 putImageData 요청 합계 | 81.87→24.99 MiB, -69.5% | 누적된 모든 획 타일 대신 바뀐 타일만 업로드. 실제 GPU 버스 전송량 아님 |
| 같은 100px 획 요청 합계 | 133.87→45.93 MiB, -65.7% | 같은 문서·입력 궤적 |
| 브라우저 pointer move p95 | 12px 0.20→0.20ms /100px 0.80→0.80ms | 해당 획 시험 long task 전후0. 전체 제품의 정지0을 뜻하지 않음 |
| Node 800×600/100px move p95 | 1.003→1.103ms | dirty Set의 CPU 약10% 비용을 수용. 무비용 최적화로 표현하지 않음 |
| 실제 2048² 스포이트 pointerdown p95 | 70.5→0.50ms | 전체 합성/할당 대신 클릭 좌표만 레이어별 합성 |
| 복사된 동일 후보 비교 p95 | after2048² 4.59ms, 복사 포함8.86ms | Uint32 비교/unaligned fallback. 동일 배열 identity의0.001ms와 구분 |

스포이트의 전체 이미지 CPU scan은 제거됐다. 별도 long task는 네이티브 렌더/대기·compositor·계측 환경 가능성이 있으나 원인이 확정되지 않았다. `/tmp`에서 불필요 redraw를 생략한 A/B도 long task를 없애지 못했으므로 제품 패치로 채택하지 않았다.

큰 문서 구조 변형은 여전히 UI 동기 경로에서 약150~245ms가 걸린다. 구조 이력의 고유 raw buffer만48~72MiB이며 Canvas·Worker·압축 임시 메모리는 별도다. 네이티브 한도 숫자만 올리거나 Wasm/GPU를 성능 근거 없이 추가하지 않는다. 다음 단위는 대형 문서 타일 표시·명시 자원 프로필과 장기 구조 작업 경계다.

## 검증과 관측성

- 이 초기 배치의 Node 회귀 **26개**, 고정 `/mypaint/` 정적 빌드의 브라우저 **45개**(기본10·동시성3·편집13·복구13·기울이기6) 통과. 각 브라우저 검사군 page error0.
- 독립 Reviewer의 별도 frozen snapshot에서도 편집13개·픽셀5개·타입/정적 빌드 통과. 별도 seeded deep-copy oracle의 history700전이와 BFS oracle의 flood2000영역 비교에서 불일치0. 이 개수로 전체 기능 동등성을 주장하지 않는다.
- strict TS/미사용 검사·Prettier, macOS 패키지 생성과 실제 WKWebView Worker/RPAINT01/알파 시작 검사 통과. 네이티브 저장의 기존 Rust3개/rustfmt/Clippy 근거는 보존한다.
- 실패는 현재 UI 상태 메시지로 알리며 run 경계에서 포착한 실패는 로컬 console의 `myPaint operation failed` message도 남긴다. 픽셀·파일 bytes를 로그에 기록하거나 외부 전송하지 않는다. 성능/메모리 분포는 명시 실행한 개발 검증 스크립트의 로컬 JSON에만 기록한다.
- CI는 실패 시 nonzero로 검사 실패를 알린다. 새 브라우저 검사군과 lockfile Playwright를 연결했다. 실제 원격 CI 실행은 미확인이다.
- 소프트쿼터와 transaction abort, 단발 raster 예외 주입은 확인했지만 실제 브라우저 디스크 고갈·실제 GPU/context 상실·OS 강제 종료 시험과 같다고 기록하지 않는다.

후속 [최대 문서·PNG·계약 검증](STUDIO_MAX_DOCUMENT.md)에서 metadata 전체 복사, 상수색/행 복사, 축소 cache와 종료 dirty 전달, PNG 오류, F02/F09와 macOS 앱 종료의 미저장 확인 우회를 수정·검증했다. 현재 미완료 조건은 [기능 인수표](STUDIO_ACCEPTANCE_MATRIX.md)와 해당 성능 기록을 따른다.

## 구조적으로 남은 부채

| 부채 | 영향/비용 | 후속 방향 |
| --- | --- | --- |
| Studio main.ts가 DOM·입력·pending 편집·명령을 함께 소유 | 변경 경계가 넓어 직접 콜백 가드와 명령 가드가 달라지는 위험 / L | 단일 대입 helper 대신 선택/문자 자원 세션처럼 실제 소유권 단위만 분리. 엔진/코덱/저장 경계는 유지 |
| 후보 편집의 구조 snapshot과 큰 동기 변형 | 일반 구조 snapshot·pending 합성·live 선택 resize의 비용 / L | 기존 Worker crop/merge와 metadata 최적화를 유지하고, 남은 동기 준비·cold 표시를 취소·메모리 회계와 함께 개선 |
| raw PNG 보존을 위한 자체 코덱 검증 부담 | Canvas 왕복을 피하는 장점과 색상형/Adam7/손상 입력 검증 비용 / M~L | 독립 코덱 fixture와 malformed/fuzz 범위를 넓힌 뒤 기존 파일 전환 인수. 빠른 RGBA 경로만으로 전체 PNG를 승인하지 않음 |

## 남은 출시 차단 항목

1. **Blocker / L**: 네이티브 원래 대형 문서 프로필(32Mi pixels/64Mi aggregate/32768)·타일 표시·Worker 경계는 [후속 구현](STUDIO_NATIVE_PROFILES.md)으로 추가했다. 최대 합계 부하·피크 메모리·장시간 편집 인수는 남아 있다.
2. **Blocker / M~L**: [native 저장·복구 후속 구현](STUDIO_NATIVE_PERSISTENCE.md)에서 경로 저장/열기·파일 복구·Qt 읽기 전용 인계를 구현하고 macOS 실제 파일/Qt live·stale 잠금을 검증했다. 실제 macOS APFS 쓰기 ENOSPC와 원본/metadata/복구 보존·retry도 후속 검사로 확인했다. Windows 실제 파일/잠금·OS 선택기·교체/디렉토리 동기화 실패·지원 metadata 인수는 남아 있다.
3. **Major / L**: 형식/17개 도구/F01~F10 전체 실패 조합, 큰 구조 연산의 UI blocking과 취소, 장시간 자원·실제 디스크/잠금 예외.
4. **Major / M~L**: 현재 staging의 Qt 고정 가정을 새 manifest와 안전하게 공존시켜 수동/staged 파일·이전 탭 자산·롤백을 보존.
5. **Blocker / 외부 인수**: Windows 실행, Android 실기기 웹과 Safari 웹, 깨끗한 macOS·서명/공증/고지·공개 배포 인수. 현재 자동화의 통과로 대체하지 않는다.

전체 목표는 active로 유지한다. 다음 단계는 위 순서와 [전환 백로그](QT_FREE_MIGRATION_TASKS.md)의 선행 조건을 따른다.


## 최종 화면 캐시의 추가 RCA

2026-11-05. [통합 근거](evidence/studio-scene-integration.json)와 [성능 기록](STUDIO_MAX_DOCUMENT.md)은 기존 source renderer, 1차 통합, 최종 후보를 구분한다.

| 문제·우선순위 | 재현·원인 | 수정·검증 또는 남은 작업 |
| --- | --- | --- |
| 분수 CSS 높이의 마지막 행 누적 / Major | 가로에서 구한 DPR로 CSS 높이를 채우면 물리 backing 마지막 행이 남아 반복 합성 | Identity 변환에서 backing 전체 배경 채우기. 분수 배율 불투명 경계와 UI 전체 비교 |
| 변경 없는 다층 화면의 LRU 반복 교체 / Major | 가시 source 96개가 cache 64개를 초과 | 원래 합성이 끝난 불투명 scene만 보관. 합계 예산과 fallback 유지, 화면·원시 파일·실제 WKWebView 검증 |
| 작은 dirty가 source 64개를 재업로드 / Major | device 512 grid가 source 510 grid를 가로지르고 남은 source 슬롯보다 많은 타일 요구 | source 경계로 정렬, 완전 적중 시 체커 반복 생략. 대표 DPR 1 갱신에서 64→2회 업로드 |
| 정렬안의 부동소수점 culling 퇴행 / Major | 355 경계가 왕복 후 354.99999999999955가 되어 앞 행·열 추가 | 정확한 정수 deviceBounds를 표시 경계로 전달. 실제 반례·rollback·invalid 입력 영구 회귀 추가 |
| 최초 표시·넓은 dirty / 미해결 Major | cold 비용과 모서리/분리 bbox의 source 작업량이 남음 | 불리한 623ms 표본을 보존하고 12회 교차 반복. 별도 진단에서 main restore 한 번의 558.8ms 대기를 확인했으나 원인은 미확정. 실제 WKWebView/하드웨어 경로를 먼저 관측하고 부분 영역 최적화는 별도 검증 |

독립 Architect는 최소 패치의 데이터·기능 차단 결함을 발견하지 않았고, Reviewer는 원본 기준 화면 56개·출력 12개의 byte-exact 결과를 확인했다. 이 승인은 전체 성능·실기기·출시 게이트의 완료가 아니다. 외부 telemetry나 사용자 그림 로그를 추가하지 않았다.


## 도구·투명 입력·프로젝트 크기 경계의 후속 RCA

2026-11-05. [도구·입력 근거](evidence/studio-tool-contracts.json)는 수정 전 반례와 각 단계의 소스/번들·시험 범위를 보존한다.

| 분류·비용 | 재현·원인 | 수정·검증 |
| --- | --- | --- |
| Blocker / M: 색 교체의 전역 변경 | 짧은 드래그가 멀리 떨어진 같은 색까지 바꿈. UI가 활성 레이어 전체를 `replace` Worker로 보냈음 | 기존 stroke의 타일 이력/dirty/cancel을 공유하는 정수 hard capsule. 전경색 premul key·보조색 raw target, row 후보 범위 제한. Qt 18개·공개 UI 9개·WK 엔진 3개 |
| Major / M: 도형 버튼·알파 유실 | 우클릭 직선도 전경색, picker의 alpha128이255로 저장. RGB 전용 hex 스타일과 버튼 상태 누락 | 최근 drawing press의 색 소유권과 rgba 스타일을 preview/commit/pending에 공유. pointercancel·takeover·owned-pointer 예외에서 이전 색 복원. UI 23개에 투명 붓 사례 포함 |
| Blocker / S: 투명 입력의 숨은 RGB 손실 | 빈 overlay가 [193,71,117,0]을0으로 바꿔48채널과 history를 변경. 투명 붓도 sentinel 3채널 손실 | source alpha0은 before RGBA 복사, 무잉크 normal stroke는 paint/tile 할당 생략. 기존 외부 입력 보호를 보존하며 내부 시도의 hidden visibility는0바이트 이력 |
| Blocker / S: 잘못된 내부 PNG의 선할당 | outer 문서 한도 통과 뒤 마지막 inner PNG를 먼저 디코드하고 치수 불일치를 검사 | 첫 IHDR 치수 사전검사 뒤 전체 decoder 검증 유지. 독립 before/after에서 잘못된 raw/output 요청 각각1→0회, 정상 두 레이어의 픽셀/할당 요청 동일 |
| Major / S: 파일 adapter 크기 경계 | metadata size만 확인하고 fallback의 실제 byteLength를 재확인하지 않음 | size 단일 캡처·safe integer/한도·실제 길이 일치·취소 검사. 정상 File/native adapter는 동일하며 임의 adapter 내부 할당까지 통제하지 않음 |

전체 Node 155개, 최종 decoder 번들의 기본 웹 10개와 실제 macOS 4단계, Qt CTest 5개 프로그램이 통과했다. 도구 UI 32개·기존 103개·bulk 16/pointer 9는 각각 소스 해시가 기록된 앞 snapshot의 근거이며 합쳐서 ‘모든 검사를 한 최종 번들에서 수행’했다고 표시하지 않는다. 동일 UI/엔진 소스 뒤에는 디코더 guard만 추가됐다. CI에 색 교체·도형 회귀를 연결했으며 원격 CI는 아직 실행하지 않았다.

추가 마우스 버튼 3/4가 13픽셀을 칠하고 capture·Undo를 만드는 반례도 후속 수정했다. 초기 mouse 전용 guard로 편집 진입을 차단했으며, 같은 후보의 포인터 23개·기본 웹 10개·편집 13개와 실제 macOS 4단계가 통과했다. [후속 근거](evidence/studio-pointer-buttons.json)는 실제 브라우저 탐색과 편집 계약의 검증 범위를 구분한다.

남은 우선순위는 GIF native decoder 내부 할당의 확인, 실제 WK cold/mip·넓은 dirty 성능, Android/Safari/Windows와 실제 OS 입력·파일 인수다. 형제 홈페이지 staging·되돌리기·서명/공증도 별도 출시 조건이다.


## GIF 크기 사전검사와 긴 prefix 취소

2026-11-05. **Major / S**: 논리 화면 8×6인 GIF의 첫 descriptor가12×10이거나 offset을 가지면 실제 Chromium 출력은12×10·11×8·28×23으로 확장됐다. 기존 검사는 논리 화면만 확인해 native decoder에 먼저 진입했다. 첫 descriptor까지 팔레트·extension subblock을 경계 검사하고 `max(logical, offset + size)`를 사전 검증하도록 보완했다. [현재 Wuffs 구현](https://raw.githubusercontent.com/google/wuffs/main/std/gif/decode_gif.wuffs)의 확장 경로와 작은 실제 재현이 일치한다. 정상 애니메이션의 첫 장면 열기는 [ImageBitmap 계약](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#createImageBitmap)을 유지한다.

새 사전검사의 빈 extension 목록을 실측하자 약 40MiB에서 135~137ms 동안 취소 timer가 실행되지 않았다. 256KiB 진행마다 시간을 확인하고 4ms soft budget을 넘으면 timer task로 양보한 뒤 취소한다. 독립 Node 비교의 긴 빈 목록 취소 12회는 Blob/bitmap 호출 0, 빠른 payload 경로 24회는 불필요 yield 0이었다. 무취소 전체 처리시간은 약 136→352ms로 늘었으므로 속도 향상으로 표시하지 않는다. [전체 근거](evidence/studio-gif-input.json)는 측정 구간과 최악 관측값, 실제 디코딩0회 조건을 포함한다.

전체 Node 166개·공개 GIF UI 22개·기본 웹 10개·실제 macOS 4단계가 통과했다. Native codec 단계에는 정상 GIF 3개 전수 픽셀 검사가 포함된다. 브라우저/네이티브의 전체 프레임 metadata·중간 버퍼와 프로세스 RSS는 여전히 미확인이다. 첫 장면만 반환한다는 사실로 내부 할당이 상수 크기라고 판단하지 않는다.


## 실제 WK 계측과 uniform mip 판정

[WK 후속 근거](evidence/studio-wk-render.json)에서 실제 앱의 timing을 추가 test readback/reference와 분리했다. 초기 실패는 camera 변경이 아니라 시작 시 복구 확인의 `run.finally`가 예약한 draw였다. 측정 fixture 설치 전 준비 단계에서 해당 작업을 끝내고 pending frame·camera·owner guard를 유지했다. 일시적인 draw 호출 wrapper는 제거했다.

**Major / S 개선**: 8K 두 레이어의 전체 uniform rect 판정에서 행 주소를 픽셀마다 계산하던 루프를 행 선형 인덱스·4word/tail 검사로 바꿨다. 같은 실제 WK 조건의 중앙값 345→272ms와 원본·화면·자원·요청량 일치를 확인한 뒤 제품에 반영했다. 수학·좌표·할당·파일 계약은 바꾸지 않았다. 새 11개 독립 mip 회귀를 포함한 필수 74개, Node 166·웹 10·macOS 4단계가 통과했다.

**미해결 Major**: 16layer initial의 putImageData/초기 ImageData 비용과 대형 mip의 main-thread 준비가 남는다. 135ms 최종 표본은 교차 재검증에서 재현되지 않았지만 보존했으며, 50ms 목표나 지연 tail을 완료 처리하지 않는다. 자세한 수치와 계측 한계는 [성능 기록](STUDIO_MAX_DOCUMENT.md)을 따른다.


## 화면 밖 source 업로드의 후속 RCA

Major / M. 활성 scene이 화면에 걸친510px source 타일 전체를 초기화·업로드해 화면 밖 영역에도 비용을 썼다. 전체 backing Canvas의 역변환 범위+halo로 ImageData만 제한하고 crop을 owner identity에 포함했다. Canvas 크기·origin까지 바꾼 첫 후보는 경계 오차로 폐기했다. 실제 WK 교차6회에서 초기 중앙98→84ms, 요청100.5→44.4MB를 확인했다. [근거](evidence/studio-viewport-tiles.json)는 실패 후보·독립 픽셀 oracle·할당 실패 복구·최종 포맷/빌드 동일성을 보존한다. 초기50ms 목표와 넓은 dirty/최대 mip/실기기 인수는 미해결이다.


## 펜·투명 지우기·입력 오류의 후속 RCA

2026-11-05. [재현/수정 근거](evidence/studio-basic-tools.json)는 각 수정 전 번들과 최종 후보를 분리한다.

| 분류/비용 | 재현·원인 | 수정·확인 |
| --- | --- | --- |
| Major / S: 펜 획의 마지막 부분 누락 | release pressure0이 보정된 끝부분의 반경을 축소. pressure1 마우스/펜4쌍에서 끝점 RGBA가 다름 | 종료의 pen0만 마지막 접촉 압력 사용. 실제 move0 유지, 같은/이동 release 포함 UI8실행 |
| Major / S: 투명 지우개의 숨은 RGB/Redo 변경 | target/source alpha0인데 RGB를0으로 쓰고 이력 생성 | 원래 stroke-before alpha0을 tile 할당 전에 skip. alpha1이 중간에0으로 반올림된 뒤 완전 삭제되는 회귀 포함 |
| Major / M: 오류 뒤 포인터/선택 소유권 잔류 | catch가 drag만 지워 다음 제스처 유실·중간 selection raster 잔류. lostcapture는 drag 없는 owner를 무시 | 기존 cancelPointer로 복원 통합, Map 제거 후 capture 해제. 단발 할당 실패·picker loss·실제 resize 한도 오류와 첫 재시도3개 |
| Major / S: spray timer 예외 후 계속 편집 | interval이 공통 오류 경계 밖. 주입 오류 뒤47픽셀이 release 때 확정됨 | timer try/catch를 포인터 오류 경계로 연결. timer 정지·화면/raw/clean/Redo·늦은 release·정상 재시도/Undo 확인 |

엔진169개·새 UI31개·포인터26개·기존 웹/동시성/편집10+3+13개·실제 macOS 일반4단계를 통과했다. 반복 OOM이나 물리 펜의 인수로 확대하지 않는다. 사각 도구는 실제 Qt161개에서 옵션·경계·이벤트별 알파 차이를 확인했고, 미검증 근사 rasterizer는 제품에 넣지 않았다. 이 Major와 선택 색상의 알파 표시 UX, 같은 불투명색 지우기의 임시 할당은 후속으로 남긴다.


## 사각 붓·지우개의 경계와 이벤트 합성

2026-11-05. **Major / L**: 사각 도구를 soft dab와 한 획 최대 coverage로 근사해, Qt의 정수 경계·square cap·이벤트별 반투명 누적과 달라졌다. 작은 실제 Qt Canvas 기준을 확보한 뒤 폭1 clipping과 넓은 선분의 held-out mask로 확대했다. 단순 polygon/반올림 근사는 경계에서 실패했고 고정소수점 scanline, 교차 경계 anchoring, 제한된 multiply-add 반올림을 적용했다. [통합 근거](evidence/studio-square-tools.json)에 실패 후보와 독립 모델을 보존했다. Qt의 premultiplied RGB 반올림을 현재 straight RGBA에 강제로 적용하지 않았다.

**Major / S**: 브라우저는 누른 마우스의 다른 버튼 전환을 pointermove로 전달한다. 사각 alpha128 클릭 중 가운데 버튼을 누르면 2회 합성이 4회 또는 6회로 늘어났다. 다른 버튼 전환과 종료 이벤트를 실제 그리기 이동과 구분해 수정했다. 두 release 순서의 전체 raw RGBA와 한 번의 Undo/Redo를 검증했다.

옵션 toggle의 즉시 sync 누락과 사용하지 않는 hard coverage 버퍼도 수정했다. 함수 분리는 공유 원본 snapshot 소유권과 독립 raster 알고리즘에 한정했다. Node176개 안의 Qt 기하5397개, 새 UI35개·레이아웃3개, 기존 도구/포인터/웹/동시성/편집31+26+10+3+13개, 실제 macOS4단계(scene21개)가 통과했다. 엔진 경계·자원 코드·C++ oracle 토큰은 역할별 독립 검토했고, 후속 Reviewer 실행 불가와 이전 검토의 범위도 근거에 명시했다.

원형 동작의 fresh-process 교차 측정은 같은 출력·이력에서 중앙값 약 -1.3%~+5.2% 범위였다. 소표본으로 무회귀나 전체 속도 향상을 선언하지 않는다. 이 단계 종료 시 연필1px 경계·Classic98 색상표·초기50ms·최대 mip·실기기 인수가 남았다. 연필과 팔레트의 후속 수정은 아래 기록을 따른다.


## 팔레트와 Enter 소유권, 연필의 후속 RCA

2026-11-05. [원문 재현·검증](evidence/studio-pencil-palette.json)에 수정 전후의 소스/자산과 별도 Qt 기준을 기록했다.

| 분류/비용 | 원인 | 수정·회귀 |
| --- | --- | --- |
| Major / S: Classic 색상표16색이 회색 | 스킨 공통 버튼의 높은 specificity가 swatch 배경을 덮음 | 기존 --swatch를 panel/accent fallback보다 우선. 마우스·키보드 눌림, 두 스킨·모바일 선택 확인 |
| Major / S: Enter가 버튼을 실행하지 않음 | 전역 keyboard Enter가 preventDefault 후 문서 settle을 실행 | 해당 분기에서만 native button에 소유권 위임. palette Enter는 pending을 보존하고 Canvas Enter는 확정. Ctrl/Cmd·IME·busy/dialog·Escape 선행 분기 유지 |
| Major / M: 연필 기하·반투명 합성 불일치 | UI가 generic pixel DDA/최대 coverage 모드에 연결됨 | 기존 hard square size1로 라우팅. Qt 실제41개와 UI10개, full RGBA·옵션 무시·pen0·chord·cancel/Redo 확인 |

스포이트가 읽은 RGBA와 이후 연필의 두 pass 합성 기대값을 분리했다. 원본 레이어·visibility·clean·Redo 단언은 바꾸지 않았다. 기존 document-Enter 테스트는 저장/메뉴 뒤 Canvas를 명시적으로 focus하며 예상 픽셀과 Undo는 그대로다. 새 helper·엔진·의존성은 추가하지 않았다.

최종 source의 공개 UI41·사각35·웹13·동시성3·편집13·레이아웃4 및 실제 macOS4단계를 통과했다. Qt 반투명 RGB와 straight RGBA의 반올림 차이는 정책 차이로 명시하며 허용오차로 테스트를 완화하지 않았다. 성능 향상·Windows·물리 기기·출시 완료를 주장하지 않는다.


## 최대 mip 연속 점유의 bounded 준비 RCA

2026-11-05. **Major / L**. 타일 수는 제한돼 있어도 uniform 판정과 box 평균의 원본 스캔이 한 rAF에서 끝나 UI를 오래 점유했다. [통합 근거](evidence/studio-bounded-mip.json)에 같은 cursor의 동기/양보 경로와 최종 UI4 승격을 기록한다. source row 작업량을 최대 65,536개 진행 단위로 제한하고 soft 4ms 뒤 MessageChannel에서 이어서 처리한다. 타일마다 rAF를 기다리는 첫 후보는 완성 시간이 늘어나 채택하지 않았다. Canvas clip/scene target을 task 사이에 유지하지 않고 준비 완료 뒤 한 프레임만 공개한다.

**Major / S**. 단순 도구/스킨 변경의 `draw(true)`가 원본 전체를 다시 dirty로 만들어 cold 준비와 입력 대기를 반복했다. 실제 픽셀을 바꾸는 pending 확정의 full invalidation은 유지하고, 도구/환경설정은 일반 draw와 기존 frame/owner/factor/crop key를 사용한다. 취소·새 dirty·문서 교체·할당 실패·context loss에서는 cursor와 채널을 정리하고, 렌더러가 원본·이력을 변경하지 않도록 한다. 같은 backing 크기의 준비 단계에서는 이전 화면을 유지하지만 그리기 도중 실패하면 Canvas를 초기화한다. context loss는 준비 완료를 해제하고 복구 후 다시 그리며, 실제 장치 손실에서 backing 보존을 보장하지 않는다. 64타일/128MiB/512축 한도는 유지한다. 엔진·파일 형식·Rust와 의존성은 바꾸지 않았다.

응답성과 완성 시간은 분리한다. Chrome uniform/checker 각 n3에서 관측된 최대 callback은 173.1~364.2→5.0~9.6ms로 줄었으나, 완성 중앙값은 각각 186.6→219.6ms와 361.8→404.0ms로 늘었고 6쌍 모두 완성이 느려졌다. 실제 WK uniform n1의 첫 동기 반환/완성/timer gap은 245→5ms / 246→312ms / 246→9ms였다. 전체 Canvas·authority·geometry는 exact이며 LongTask API 미지원은 `null`로 남긴다. WK checker의 DPR/mip 불일치는 비교에서 제외한다. 자세한 표본과 계측 한계는 [성능 기록](STUDIO_MAX_DOCUMENT.md#최대-mip-준비의-다음-구현-경계)을 따른다.

필수 타일 109개·정보성 4개, Node 176개·웹 48개·준비 UI 8개·장면 Canvas 56개/문서 12개와 계측 overlay 없는 일반 macOS 앱 4단계를 확인했다. 임시 foreground 도구는 검사에만 사용했다. 초기 AppKit 권한 실패·timeout·helper 실패는 숨김/잠금 원인으로 단정하지 않고 원문을 남겼다. 전역 50ms·p95·전체 성능 완료는 아니다. 다음은 동일 DPR/WK checker·넓은 dirty·장기 RSS, 남은 도구와 Android/Safari 웹·Windows/macOS OS 통합·출시 인수다.


## 투명 선택 키와 문자 alpha 손실의 RCA

2026-11-05. [수정 전후 근거](evidence/studio-alpha-contracts.json)는 UI4 이후의 별도 배치다.

| 분류/비용 | 재현·원인 | 수정·검증 |
| --- | --- | --- |
| Major / S: 투명 선택의 alpha 키 손실 | RGB만 비교해 opaque-white 키가 white128을 지우고 white128 키가 white255를 지웠다. 반대로 alpha1의 premul 동등색은 남겼다 | alpha와 premul RGB를 함께 비교한다. straight RGB는 보존한다. 실제 Qt 4개, 기존 UI 4개 중 3실패→후속 4개 통과 |
| Major / S: 문자 alpha를255로 강제 | preview color/background와 raster fillStyle 네 곳이 RGB hex를 사용했다. alpha0/1/128 잉크와 배경이 불투명해졌다 | 동일 foreground/secondary의 인라인 RGBA 사용. globalAlpha·brush opacity·HEX 입력은 바꾸지 않았다. 기존 UI 8개 중 7실패→후속 8개 통과 |

선택 버퍼의 alpha0 hidden RGB 보존과 PNG 합성의 alpha0 RGB=0을 혼동하지 않는다. 실제 Qt 문자의6case·84check와 fully covered 3,680픽셀은 알파 판정 근거이며 glyph의 OS 간 동일성을 주장하지 않는다. 별도 실제 WK alpha 10개(문자6/선택4)는 DOM/Canvas와 원시 상태 검사이고, 일반 overlay 없는 앱의 저장/복구·codec·Quit·scene4단계와 구분한다. 기존 웹48·pending36·clipboard4는 새 후보에서 통과했다. 동일 엔진의 Node176과 UI4 성능은 이전 표본으로 보존하며 새 실행·새 속도 향상으로 세지 않는다.

엔진·tiles·format·Rust·runtime import와 기존 상태 소유권을 바꾸지 않았고 함수 추가는0개다. 스포이트 색상의 alpha를 숫자로 표시하는 UX는 이 픽셀 손실 Major와 별개인 미완료 Minor다. 다음은 고정 DPR WK checker의 준비 계획 실행, 넓은 dirty·장기 RSS, 남은 F06과 fill 실패/timeout 계약이다. 전체17도구·물리 기기·OS IME·최종 성능·출시 완료는 아니다.


## 비동기 작업 setup의 예외 범위와 취소 소유권 RCA

2026-11-05. **Major / S**. [실패 전후 근거](evidence/studio-fill-failure.json)의 기존 `task`는 busy/inert/readOnly를 바꾸고 DOM overlay를 붙인 뒤에 `try/finally`를 시작했다. 단발 setup append 예외를 주입하자 busy overlay는 없는데 topbar/tools/inspector의 inert 세 곳이 남아 후속 작업을 막았다. 이는 실제 공개 UI 재현이지만 OOM이나 OS 오류를 발생시킨 실험은 아니다.

소유 함수 안에서 detached DOM·제어 상태를 먼저 준비하고, 실제 상태 변경·append·작업 실행을 `try/finally`에 포함했다. 취소 버튼과 work에는 같은 local AbortController를 사용해 이전 작업의 취소가 새 작업에 전달되지 않게 했다. helper나 엔진/Codec/Rust/파일 형식·fill premul 키·RGBA 정책을 추가로 바꾸지 않았다.

새 10개 검사에서 모드별 두 번의 실패/취소 뒤 원본·active·dirty/saved·Redo·첫 정상 retry와 Undo/Redo, 제어 상태·Worker/포인터 정리를 확인했다. Worker constructor/postMessage·오류 이벤트/응답·profile/pixels/coordinates·hold·timeout 9경계는 기존 안전성 확인이며 이번 새 Major는 setup 예외 범위다. 두 timeout은 각각 실제 20초다. 옛 취소 버튼 재생은 합성 DOM 검증으로 물리 장치 경쟁을 대신하지 않는다. 웹 48개·pending 36개와 표준 경로 일반 macOS 앱 4단계도 통과했다. Node 176과 성능은 이전 근거로 보존한다.

이 단계 당시의 fill premul 동등/NoOp·cut 투명 키 가설은 아래 후속 RCA에서 검증했다. 남은 F10 전체는 별도다. 고정 DPR WK checker 계획, 넓은 dirty·장기 RSS, 남은 F06/실기기·출시 게이트도 이 수정으로 완료하지 않는다.


## 채우기·잘라내기 후속 RCA와 독립 리뷰

2026-11-05. [고정 근거](evidence/studio-fill-cut-key.json)에서 앞 단계의 fill premul/cut flag 가설을 실제 Qt와 수정 전 공개 UI로 확인했다.

| 분류·비용 | 실패 조건과 원인 | 수정과 확인 |
| --- | --- | --- |
| Major / S~M | alpha1에서 raw RGB는 다르지만 premul 키가 같은 연결 픽셀이 갈라짐. alpha0 hidden RGB도 분리되며 같은 premul 교체색에 불필요한 편집 발생 | alpha+premul 키/NoOp를 flood 안에 인라인 적용. 수정 전 기본4중3실패, Qt6/45check·최종 UI6·WK Worker6·Node flood12 확인 |
| Major / S | 선택 없는 cut이 투명 선택 ON을 무시해 키 색도 PNG에 포함 | 소유한 clipboard 후보에만 키 필터. 수정 전 ON3실패/OFF1통과, 최종 cut5에서 payload·실패 보존·UndoRedo 확인 |
| Major / S | hidden active 레이어를 PNG로 합성하면서 `visible:false`가 유지됨. 빈 PNG 전송 뒤 원본을 지움 | PNG wrapper만 visible true. 문서 hidden 상태 보존. hidden/OFF 실제 수정 전 실패와 수정 후 성공을 기록; hidden/ON 결합은 미실행 |

Architect는 방문값0→2→1·stack≤N·배출 뒤2 없음과 hole/비정렬 원본 보존을 독립 검토했다. Reviewer는 최종 main/operations·새 회귀·CI 연결에서 필수 수정 사항을 찾지 못했다. SRE는 정확한 출력·원본을 비교한64개 교차 표본에서 전체 fill/island 개선과 thin-ring 퇴행을 함께 확인했다. 명시 버퍼는 원본 clone4*N을 없애고 replacement4B를 더해 순4*N−4B 감소한다. Node core의 짧은 표본을 RSS·앱/펜 지연·p95로 확대하지 않는다. 임시 WK 앱과 오버레이 없는 일반 앱의 근거도 별도다.

최종 Node188·fill6·cut5·실패10종류×두 번 및 일반 macOS4단계를 확인했다. 전 단계 v2의 웹48·pending36·clipboard4와 새 v3 검사를 구분한다. Playwright 기본 브라우저가 없던 시작 오류는 실제 페이지 실행 전 실패이며 설치 Chrome 경로로 정정했다. 메모리 계측의 최초 assertion도 새4B replacement를 누락한 테스트 오류로 보존했다. `nonfinite-before`는 중간 scalar 후보의 회귀였으며 기존 production 결함으로 세지 않는다. F06/전체 도구·물리 기기·최악 비용·고정 DPR WK·OS·출시 gate는 열려 있다.


## 자유 선택과 자르기 후속 RCA

2026-11-05. [고정 근거](evidence/studio-selection-mask.json)로 세 계약 차이를 재현·수정했다.

| 분류·비용 | 재현과 근본 원인 | 수정·관측 범위 |
| --- | --- | --- |
| Major / M | 사선·bowtie의 Canvas AA coverage>=128은 Qt의 aliased edge membership과 다름. 공개4shape×key OFF/ON에서 초기 payload4개 실패 | floor/dedupe 입력과 엔진 binary polygonMask, source preview/clear의1B stride. 실제 Qt mask871·공개8개·raw/독립 PNG 비교 |
| Major / S~M | nearest의 정확한 중간 경계에서 Math.round가 높은 인덱스를 선택. 마스크 오차와 분리한 공개 resize6개 실패 | 기존 nearest 분기에서 ceil(center)-1, Qt literal1024축쌍과 raw RGBA/숨김 상태 보존. 기존 clipboard 기대도 production 수식 대신 Qt literal map으로 교정 |
| Major / S | UI crop이 패딩용 공용 API에 음수 rect를 그대로 전달. 부분 선택10×8(기대7×6), 완전 밖도 commit/Redo 폐기 | UI intersection과 empty NoOp. 같은 최종 테스트 baseline1PASS/3FAIL→후보4PASS; generic cropState 함수/패딩 회귀는 유지 |

Architect가 작은601개 뒤 큰 외부 edge와 음수 원점 반올림 반례를 돌려보냈다. Qt의1024px trigger 뒤 preclip·1/64 좌표 변환과 원점 상대 양자화를 보완했다. 실제 파생 viewport108개 중8개는 Qt 자체도 전체 mask slice와 달라, 가정이 잘못된 테스트를 실제 Qt literal로 대체했다. 이 후보/테스트 문제를 기존 제품 결함 수에 더하지 않는다. 최신 source17·mask871 원본 multiset·그래프와 Reviewer 최종4식 검토는 각각 고정했다. 엔진은 DOM/IPC 참조가 없고 새 모듈·의존성·작은 helper는 없다.

최종 Node192·공개8+4+6·기존 웹48/pending36/clipboard4 및 실제 WK engine/Worker·일반 앱4단계를 확인했다. SRE는 커널64 표본의 소스/출력/회계를 독립 감사했다. readback4*S는 누적 반환 바이트이며 peak/live/RSS가 아니다. 512 사각202ms는395.3/8.7/7.4/779의 중앙값이고, 작은 after 표본은 timer 양자화가 크다. 전역 성능 배수·독점 실행 환경을 주장하지 않는다. source17=frontend14+Rust3이며 이전 채팅의15 표현은 정정했다.

추가 위험은 비퇴화 대형 경로의 O(P+ΣA log A+mask area) 동기 CPU와 O(P) 임시 데이터다. 100k 동일점 테스트는 그 최악 비용의 증거가 아니다. 이 단계의 P0였던 단일 투명 배경 Source-clear·source 없는 paste는 아래 후속 RCA로 갱신하며 원본 mask가 있는 rotate/flip/resize 결합을 남긴다. 원본/비동기 소유권·형식·실기기/OS·release gate를 전체 완료로 확대하지 않는다.


## 선택 원본 Source-clear의 후속 RCA

2026-11-05. [근거와 고정 해시](evidence/studio-selection-source.json)의 Major / S 한 건이다. 단일 투명 배경 `[37,59,61,0]`에서 binary mask 원본 삭제를 coverage 합성식으로 처리해 alpha0의 RGB를 강제로 0으로 만들었다. 선택된 원본 RGB만 달라졌으며 mask 밖·alpha·치수·배경 metadata는 같았다. 이미 대상 배경인 영역까지 가짜 history/dirty를 만들고 기존 Redo를 폐기했다. 사각/자유 선택 × delete/cut/음수 move와 NoOp의 수정 전 7실패→수정 후 7통과를 확인했다.

기존 preview·선택 없는 cut과 같은 raw Source 대입으로 소유 메서드만 수정했다. 원본 mask/stride와 source-less 조기 반환을 유지하고 최종 무변경은 기존 prepareState 판정에 맡겼다. Qt4개/34assertion은 Source 교체·alpha·history 기준이며 Qt premul alpha0의 RGB0을 straight RGBA 저장 정책에 강제하지 않는다. 원형 지우개 coverage의 투명 NoOp와도 구분한다.

Architect는 Qt/저장 정책, Reviewer는 baseline 차이와 최종 실제 메서드·127개 class member 중 한 개만 변경됨·소유권·NoOp를 독립 검토했다. SRE의 최종 narration은 credits 오류로 중단됐지만 실제 메서드96표본은 완료·저장돼 있었다. Root가 원본 파일·메서드 해시·96개 출력·12개 중앙값을 회수·검증했다. 이를 두 번째 독립 실행으로 세지 않는다. AST getText와 파일 끝 LF의 해시 차이에 의한 집계 최초 오류도 별도로 보존했다.

최종 Node192·새 UI7+paste4·기존 선택18/웹48/pending36/clipboard4·WK 진단6·일반 macOS4단계가 통과했다. paste4는 기존 안전 동작의 확인으로 새 결함 수에 넣지 않는다. 실제 메서드96표본의 개선은 순수 동기 처리 범위이며 caller/이력·UI·RSS·p95는 미측정이다. 당시 남긴 원본 mask 변환 조합은 아래 후속 RCA의 명시 범위로 갱신한다. 거대 경로·실기기/OS·출시 인수를 전체 완료로 확대하지 않는다.


## 연속 선택 크기 조절의 후속 RCA와 독립 검토

2026-11-05. [고정 근거](evidence/studio-masked-transform.json)의 Major/M 한 건이다. 원본3×2를 별도 제스처로2×3→3×2 조절하면 B/E 픽셀이 사라지고, 원래 크기인데도 실제 편집/새 Undo로 기존 Redo를 잃었다. 원인은 매 제스처와 명시 크기 명령이 이미 재샘플된 current pixels를 새 입력으로 택한 것이다. 같은 제스처 안의 왕복은 기존 drag 참조 덕에 안전했다. source/sourceMask와 payload 치수 분리는 이미 안전한 경계였으며 별도 결함으로 세지 않는다.

Architect의 실제 Qt12/104·리터럴 map과 SRE 공개 두 사례, Root 별도 공개 재현이 손실 라벨0/0/2/3/3/5를 교차 확인했다. 원본 mask는 그대로 두고 nearest resize backing을 유지하는 설계를 채택했다. 최초 NoOp identity와 backing을 같은 역할로 재사용하지 않는다. 명시 geometry 성공은 modified=true·originalPixels=undefined로 비교 참조만 무효화하며 실패/취소/한도 거부 이전에는 바꾸지 않는다. Qt의 키 ON 네 번 회전은7픽셀이 실제 변경돼 단순 역변환=NoOp라는 가정을 반박했다. pointer-only opaque/keyOFF 원복 보호를 모든 명시 변형으로 일반화하지 않는다.

Reviewer는 설계 중 mutable base를 따라가면 드래그 안의 원래 크기 경유에서 다시 lossy current로 돌아가는 ABA 경계와 시작 크기 복귀 때 base 복원 누락을 돌려보냈다. 고정 drag snapshot·current/base/modified 복원으로 해결했다. 최종127멤버 중4메서드·2interface 필드 외 소스 변경이 없고 필수 Blocker/Major는 남지 않았다. 이는 후보 설계 검토 사항이며 기존 제품 결함 수에 더하지 않는다.

독립 신규8개는52stage가 통과했고 Reviewer가 지적한 키 ON 명시 왕복/Arrow/Enter와 cut 실제 전송 PNG 범위는 최종 공개9개로 보완했다. Root의 실제 CI alias도9개가 통과했다. 기존 선택/자르기/실패24·Source/paste11·웹48/pending36/clipboard4·Node192, 실제 WK 진단4·일반 macOS4단계는 각 범위를 분리했다. 초기 crop 검사6실패는 dialog 종료와 Worker 시작 사이를 완료로 오인한 테스트 대기 오류였다. 실제 geometry job 완료를 기다리도록 교정했으며 초기 원문을 보존했다. 임시 WK 진단의 compile·CI 블록 연결 보정도 제품 결함으로 보고하지 않는다.

SRE는 최종 코드의 backing/current/initial identity와 Worker 복사·renderer owner를 독립 검토했다. originalPixels는 명시 변형 뒤 해제되므로 옛4*S를 항상 합산하지 않는다. backing과 current가 다르면 각4*B/4*R을 보유하고 async 입력은 backing을 복제한다. 실제 WK의 작은 선택 필드 참조 집계는 RSS/peak/성능 벤치마크가 아니다. 거대 동기 resize·전체 장기 메모리·물리 장치/OS·remote CI와 출시 gate는 남아 있다.


## 선택 성능의 재현·비용 분해·독립 검토

2026-11-05. [고정 근거](evidence/studio-selection-performance.json)에서 nearest/반복 target/밀집 mask의 비용을 분리했다.

| 분류·비용 | 재현·원인 | 수정·검증 |
| --- | --- | --- |
| Major/S | 출력 픽셀마다 subarray view·set·축 계산. Node3Mi 중앙125.375ms, actual-web 첫 callback142.2ms | 동일 Qt 인덱스 표·명시 offset/length word copy·unaligned4채널. hiddenRGB/alpha·다층/canary·상한/할당 실패·독립 output을 Node/실제WK 확인 |
| Major/S | 같은 rounded target3회와 release가 최초와 같은 대형 출력을 다시 생성. actual-web 누적5회/62,914,560B | 재샘플 block만 크기 변경 guard. 기존 validate/last/draw/restore 유지. 동일 trace1회/12,582,912B, 공개 합성 회귀는 word5신호→최종1·원크기NoOp/Redo |
| Major/M 성능 위험 | Node1Mi/2048active의 행별 정렬 비용. 실제 browser lasso-up 시간으로 환산하지 않음 | even dense 정수 열 parity; sparse/odd pair 유지. 실제Qt12/11branch·62076행 모델·max workspace/실패retry·paired40출력 exact |

Architect는 floor→clamp가 단조여서 even-odd pair와 XOR의 반개구간이 같음을 증명하고, width sentinel·row clear·공통 advance/retire를 확인했다. odd65 endpoint 모델은 fallback이 없으면 달라지는 반례다. 기존871은64active 미만이라 새 분기를 검증하지 못한다는 Reviewer 지적을 반영해 실제 Qt12를 별도 추가했고11개/110행의 branch 도달을 계측했다. 계측 prototype과 제품 함수는 서식/설명 주석 외 같다.

Reviewer는 source offset와 명시 length가 있어야 aligned buffer의 odd tail에서 RangeError가 없음을 확인했다. 순수 후보·최종3함수·원본/키/alpha·같은 크기 guard의 원복·선검증/실패 경계를 각각 검토했고 필수 차단 문제는 남지 않았다. 작은 helper나 새 모듈/의존성은 없고 본문 밖 API·파일 형식·Rust는 그대로다.

SRE는 before/word-only/final을 고정해 actual-web n1씩·Node nearest와 mask40표본을 별도 실행했다. 원본/raw/Canvas/기하는 버전 간 같고, 각 버전의 source·asset은 해당 고정 manifest와 일치했다. 큰 비용은 줄었지만 작은 API·ordinary/active128 mask 중앙 퇴행과 최종 sentinel59.8ms를 보존했다. n4 분산·n1 이벤트 시퀀스를 안정 배수·p95·물리 성능으로 일반화하지 않는다. 단순 경로와 거대 경로의 비용을 서로 대체하지 않는다.

새 공개 회귀10/68은 기존9개 기대를 유지했다. Constructor 계측은 명시적 동기 합성 move/up 안에서만 켜고 finally로 해제해 rAF/Worker를 세지 않는다. baseline 실패 stage는 allocation assert가 먼저 throw해 뒤 payloadExact를 생략하므로 baseline 같은 stage의 raw/PNG 통과로 보고하지 않는다. 최종 payload 및 이후 원크기/NoOp/Redo는 확인했다. Node198·기존 UI/legacy CTest5·실제WK4/일반macOS4단계도 각 범위로 기록했다.

뷰는 원본 backing을 공유하므로 49,152개 view 제거를49,152×4B pixel memory 감소로 세지 않는다. Xmap4W·dense bucketW+1을 더하며 old/current/base·Canvas/cache·Worker/transient·RSS는 별개다. 첫 UI 입력 전달 실패는 측정0개의 harness 직렬화 오류, prototype ESM import 실패도 실행 전 오류로 원문 보존했다. 최악 동기 시간/전체 메모리·실제 OS·출시 gate는 열려 있다.


## 큰 선택 준비 후속 — 2026-11-05

큰 path의 pointerUp→bbox/crop→mask/key 동기 경로가 취소 이벤트를 지연시키는 RCA를 고정했다. 소유 ROI/Float64 path의 Worker 처리와 job/state/policy guard로 변경했다. MessageChannel setup-before-try 정리 누락은 독립 리뷰에서 발견해 고쳤고, 대기 abort settle도 검사한다. 테스트의 keyalpha1 미일치 분포·제품 oracle 재사용·cancel 뒤 pending 부활 관측 공백을 보완했다. Node208/공개13/기존7suite와 실제 macOS 표준4·임시WK4가 통과했다. 확정 Blocker/Major는 남지 않았으나 전체 성능/플랫폼 완료가 아니다. pointerup188.6→1.3ms와 timer211.9→24.3ms 개선, 완료210.5→239.7ms 퇴행, preview약54ms를 함께 기록한다. 원본 path/packed16P/Workerobjects가 공존할 수 있으며 RSS 감소를 주장하지 않는다. 다음은 preview/전체 path/최대 resize 및 실제 Android 웹·Windows 인수다. [고정 실행·리뷰 자료](evidence/studio-selection-preparation.json).


## 선택 첫 화면 비용 후속 — 2026-11-05

선택 첫 modified 화면을 warm 재사용과 분리했다. 첫RAF58.1ms/18업로드와 warm3.8–4.1ms/업로드0, 별도샘플 transform66/가중49.911ms를 근거로 cut 콜백을 교집합·RGBA4direct로 바꿨다. 후보첫RAF15.7ms/새ready31.3ms(기준74.0), 업로드18/8,437,836B는 동일하다. bbox와대입을 같이 바꿔 set단독 원인을 주장하지 않는다. 같은 최신 main을 공유하는 reference의 공백은 frozen d320 actual56Canvas·12문서·2retry byte 비교로 보완했다. Node211/9suite/macOS표준4도 PASS. 별도 literalmask/alpha/stride 회귀와22,400 backing 조합은 UI·Qt 사례 수와 구분한다. 확정 Blocker/Major는 남지 않았으며 전역50ms/p95/메모리·모바일/Windows·출시는 미완료다. [고정 측정·검증 자료](evidence/studio-selection-preview.json).


## 대형 nearest 크기 변경 후속 — 2026-11-06

최대 출력의 동기 핸들 콜백 약 70ms를 재현했다. 같은 원본 행·동일 폭에서도 출력 픽셀마다 좌표 표를 읽던 비용을 줄이고, 정확히 2배 정렬 입력은 원본 word를 두 번 대입하도록 nearest 본문만 바꿨다. 단위 217개·공개 UI 9개 묶음·Canvas 56개 비교·실제 WK 진단 4개·일반 macOS 4단계가 통과했다. 독립 리뷰에서 확정 차단 결함을 찾지 못했고 새 primitive의 after-write 실패와 두 번째 레이어 할당 실패에서도 원본을 보존했다. 수정 전 4PASS/2FAIL은 새 primitive 주입 경로가 없던 coverage 차이이며 기존 데이터 손실 버그로 세지 않는다.

최초 일반 비율 70.1→74.8ms는 기준·후보 교차 4회 추가 검사로 확인했다. 각 3회 중앙값 68.4→68.7ms와 겹치는 범위를 보존하며 일반 무퇴행을 단정하지 않는다. 세로 ready 682.3→700.9ms 퇴행, 정확히 2배 가로의 56.2ms와 전체 128MiB 할당도 남는다. 추가 run 압축·반복문 전개는 실제 측정으로 보류했으며 앱 경로 ENOENT·좌표 oracle·취소 ready 대기 오류는 검증기 문제로 분리했다. [측정·구현·독립 검증 근거](evidence/studio-nearest-resize.json).


## 대형 핸들 분할 처리 후속 — 2026-11-06

동기 전체 nearest 계산이 입력·취소를 막던 경로를 공유 커서와 MessageChannel 행 묶음으로 변경했다. 최신 target 슬롯·gesture snapshot·released drag·job identity와 source guard가 소유권을 유지한다. 리뷰에서 초안의 다층 잔여 행 누적, pending 윤곽/핸들 불일치, stale/timeout의 old capture 정리, Linux CI의 macOS 고정 브라우저 경로를 찾아 수정했다. 이후 고정 후보와 단위 229개·회귀 10묶음·Canvas 56개·WK 진단 4개·일반 macOS 4단계를 확인했다.

새 UI 각 n1의 첫 콜백 0.4/0.8/0.5ms·관측 LongTask 0과 전체 ready 약 0.7초를 구분한다. 동기 API의 70회 raw/source 검사는 별도이며 가로 cold의 36.30→39.03ms도 보존한다. ESM 누락·모바일 컨텍스트/숨겨진 열기 접근은 검증기 오류로 기록했다. 실제 touch·OS picker·원격 CI·장기 RSS와 연속 target 재할당 검증은 남아 있다. [분할 resize 구현·실행·독립 검토 근거](evidence/studio-bounded-resize.json).


## Cold mip 조사: 정확도 통과와 성능 채택 분리 — 2026-11-06

[실행 원문과 검토](evidence/studio-cold-mip-investigation.json). 가중 CPU 표본으로 타일 축소 준비를 우선 조사했으나 함수 수준 표본만으로 내부 분기·GC·JIT 원인을 확정하지 않았다. 제품 밖 후보들의 fake backend raw/source 427회와 실제 direct2 Canvas/PNG·취소·Redo는 일치했다. 반면 실제 factor16에서 준비 658.7→884.2ms와 LongTask 증가가 관측됐고 다른 후보도 대조 패턴에서 퇴행했다. 정확도 PASS를 성능 승인으로 취급하지 않고 모두 보류했다. 현행 소스17·자산8·정적 의존성 그래프는 그대로다.

확정된 새 데이터 손실 결함은 없지만, 현행 factor16의 단일 99ms 관측과 연속 target의 장기 메모리는 열린 성능 위험이다. 후보가 factor2 전용이라는 사실은 다른 factor의 무퇴행 증거가 아니다. 원격 CI/실제 Android/Windows·새 WK 성능·p95/RSS를 인수했다고 보고하지 않는다. 초기 Canvas 축척 기대 오류는 resize 전 실행기 실패로 보존했고, 이전 GUI 검증의 완료 기록과 현재 조사를 구분했다.


## 연속 resize: 수집 전 용량과 누수 가설 분리 — 2026-11-06

[고정 관측·보정·검토](evidence/studio-resize-memory.json). 가설은 latest-target가 이전 partial/시작 snapshot을 의도치 않게 유지하는지였다. 실제 소유 메서드의 Node 웹/desktop 모델과 별도 실제 Chromium 시퀀스를 확인했다. burst에서 수집 전 많은 버퍼가 조회됐지만 별도 GC 뒤 current만 남고 Escape·최종GC 뒤 target5개가 수집됐다. 최종raw/원본SHA·기존Redo도 보존돼 이 시퀀스의 강한 참조 누수는 재현되지 않았다. RSS를 ArrayBuffer 용량이나 조회 가능 WeakRef와 동일시하지 않았고, 제품 코드는 바꾸지 않았다.

확인된 문제는 관측기였다. 최초 실제 실행은 폭8191에서도8192의 기대 바이트 수를 유지해 앱ready=true를 놓쳤다. 별도 v2의 dimension/bytes 동반 갱신 후 통과했다. Node의 generic metadata 이력·집계 순서·성공 시 오류문자열 생성도 고쳤고 이전 원문을 남겼다. actualCopyWorker 입력raw와 출력PNG bytes, 완료 후 Escape와 준비 중 취소, 자연 구간과 강제GC/검증 구간을 구분했다. 광범위 누수 부재·장기RSS·Windows/모바일·실제native 성능의 승인은 아니다.


## High-minification RCA와 관측 해석 정정 — 2026-11-06

[원문·독립 감사](evidence/studio-high-minification.json). 이전 99ms의 새 재현은 비추적·별도 진단 각 1회 모두 없었다. 현재 진단의 42.8ms next와 43.831ms Task/42.005ms thread CPU를 포함 관계로 확인했다. API/생성자 중첩 0과 짧은 compile/optimization/deopt 계열 이벤트만으로 특정 함수나 99ms의 원인을 확정하지 않았다.

확정된 관측 문제는 MessagePort 종류 혼재다. 소스 AST와 등록 본문·stack으로 동기 render-inline과 resize-resolver를 구분했고, 과거 전역 resolverOnly 필드의 이름이 CPU 배제를 증명하지 못함을 정정했다. tracing category 빈 응답으로 편집 전에 중지한 시행은 0표본으로 보존하고, 별도 작은 시험에서 확인된 positive trace 조건만 사용했다. cleanup의 독립 10s는 tracingComplete 대기에 한정되며 Tracing.end/IO.read는 전체 120s watchdog 제약이다.

한정된 work 32768 후보는 타일 필수 계약 109개 통과·정보성 비교 4개 기록과 동일 전체 출력에도 primary의 불리한 표본과 최장 next 불변으로 미승격했다. 초기 타일 retain 실패는 기존 remaining 4단계의 전제였고, 새 8단계가 restart 9와 구분되는 근거를 유지해 관측기만 교정했다. 제품은 유지하며 소스별 실제 원인·50ms/p95·플랫폼 인수는 완료 처리하지 않는다.


## 2026-11-06 카메라·VisualViewport·무변형 선택

[수정·원인·검증·정정](STUDIO_CAMERA_VIEWPORT.md), [고정 근거](evidence/studio-camera-viewport.json). 새 공개17개·Node232와 최종 기존 입력/선택/웹/출력·macOS 회귀를 통과했다. 휠 중 투영 Major, VV 확대·문자 원점/중복 observer·밀도 취소 Minor를 수정했다. 미변형 선택4K 두 레이어의 동기 slice는128MiB→0이며 draw(true)·엔진 검증·NoOp/Redo를 유지한다. 과거 forced-gutter42/48px 추론은 실제 hit 증거에 따라 철회하고 본문에 범위를 명시했다. 물리 Android 웹·OS IME/파일·Windows·보조공학·출시 및 선행 게이트는 남기며 전체 체크를 닫지 않는다.


## 2026-11-06 자동 복구의 오류 경계와 비용

[현재 분석·수정·검증](STUDIO_RECOVERY_SNAPSHOT.md), [고정 근거](evidence/studio-recovery-snapshot.json). injected missing/null 출력의 false success→같은 revision 재시도 억제와 이전 epoch 오류 표시를 수정했다. 공개5·단위234·저장13·native IPC 모델15·웹48·실제 macOS4단계를 확인했다. 기준 clone/Worker/storage n3는 모델·실제 IDB를 분리하며, 성능 개선이나 실제 OS I/O/물리 장치 인수로 세지 않는다. full codec 응답 계약·Worker 내부 CPU/entropy·실제 플랫폼·전체 선행 게이트는 남는다.


## 2026-11-06 Codec10 응답과 Worker 비용

[분석·수정·검증·잔여 조건](STUDIO_CODEC_REPLY.md), [고정 근거](evidence/studio-codec-reply.json). 잘못된파일 성공표시·조건부clipboard cut·typed state/sparse색상·fill응답 경계를 owner에서 닫았다. 동일공개27개 기준22실패/5대조통과→후보27통과, 독립계약89·전체Node323과기존회귀를확인했다. macOS최초20초timeout을보존하며동일binary재시도4단계는통과했다. Worker의지배비용은입력에따른압축·CRC였고CRC임시후보는low혼재로비채택했다. 정상Worker자연장애·OSclipboard·실기기·무회귀성능·전체출시완료로확대하지않는다.
