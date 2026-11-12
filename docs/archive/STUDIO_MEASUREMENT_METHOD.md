> 과거 검증·설계 기록입니다. 현재 실행 방법은 [루트 안내](../../README.md)를 따르세요. 아래 수치는 기록 당시 환경에만 적용됩니다.

# 성능 측정 방법·검증 — QF-03 진행

2026-11-06. [소스·원자료·독립 검토](../evidence/studio-measurement-method.json). **QF-03은 부분 충족**이다. 이번 작업은 기존 측정기의 정확성과 재현 조건을 보완했다. 기기별 성능 예산·안정적인 tail·물리 입력·Qt 대비 향상률 인수는 완료하지 않았다. 제품 runtime17개와 배포9파일/291,664B는 [QF-04 제품](../STUDIO_DOCUMENT_CONTRACTS.md) 그대로다.

## 수정한 측정 문제

| 확인 사항 | 보완과 검증 범위 |
| --- | --- |
| State 반환의 outputBytes=0 | layer plane byteLength 합계로 집계. 출력 크기/레이어 수·NoOp·양수 출력 확인은 타이밍 밖에서 수행 |
| 입력 SHA와 실제 인수가 다름 | State fixture와 실제 operand를 별도로 기록. white fill1plane, encoded project bytes, cloned candidate를 각각 전후 SHA로 확인. compressed bytes와 logical pixel bytes를 구분 |
| 마지막 입력 시각을 모든 rAF에서 재사용 | 입력 token을 첫 성공한 workspace Canvas 명령에서 한 번 소비. 유휴 rAF0→첫 draw1→재draw1→다음 입력2 control과 rAF 바깥 draw도 확인 |
| 불명확한 시간 이름 | handler sync prefix, final move를 포함한 endStroke, rAF callback, 첫 Canvas 명령 시작을 분리. async work·MessagePort·완료된 표시와 혼동하지 않음 |
| 실제 편집 실패가 빠른 결과로 보일 수 있음 | 공개 저장 프로젝트의 ink RGB/투명 corner·전체 Undo/Redo와 pageerror를 타이밍 밖에서 검사. 기존 엔진 correctness suite를 대체하는 전수 oracle은 아님 |
| 환경·궤적의 묵시 가정 | 고정 externalLoad 문구 제거. Node/UI 색·opacity/hardness·pressure·투명 문서·120moves·마지막 끝점 일치. 크기별 새 context,25px stroke 간격으로 최대15개도 세로 경계 안에서 측정 |
| 잘못된 표본 옵션 | 표본3~15 정수,10~120초 정수 budget,12/100px 선택과 불가능한 phase 조합을 preflight 검사. 음수/소수 등을 조용히 다른 표본으로 바꾸지 않음 |
| 수명·관측 경계 | 동기 CPU의 soft deadline와 소유 browser/context 취소를 구분. context 정리 예외에도 browser 종료를 시도. LongTask를 window overlap으로 분리·drain. raw HTML과 동적 DOM hash도 구분 |

공유한 `installMetrics`는 control page와 각 context에 같은 계측을 설치하는 한 소유 경계다. 제품 helper·IPC·런타임 의존성은 추가하지 않았다. 리뷰에서 undefined context2곳, Node/UI 종료 좌표, cleanup 예외 경로와 실제 operand 기록을 정정했다.

## 고정한 작업과 관측

브러시 문서는800×600, 색 `[22,121,234,255]`, opacity0.7/hardness0.25/stabilization25, pressure/square=false다. x=40에서6px씩120번 이동하며 y에 `sin(point/10)*20`을 적용한다. warmup1회 후 stroke별25px 간격으로 측정한다. Node는800×600/2048², 브라우저는800×600이다. 같은800×600 경로라도 Node 엔진 호출과 자동화 UI의 event cadence·렌더/이력 수명은 다르므로 전체 wall speedup 분모로 사용하지 않는다.

코어 알고리즘은800×600×1,2048²×1,1536×2048×2를 사용한다. fill은 각 크기의 별도 흰색1plane이고, resize는 **같은 크기 resample/copy**다. clone/composite/rotate/codec/NoOp와 구조 이력의 메모리 회계를 구분한다. 구조 이력 실험은 의도적으로 `edit`를 호출하며 현재 metadata-only UI의 비용을 뜻하지 않는다.

브라우저는 actual production Worker와 공개 pointer/저장/Undo/Redo를 쓴다. 계측 wrapper가 실행 비용에 포함된다. Worker3개는 direct protocol의 constructor→reply 각1회이며 큐/snapshot/storage를 포함한 전체 저장 지연이 아니다. 첫/일부 채널 sentinel 검사는 전수 출력 검증이 아니다.

| 값 | 측정하는 것 | 인수로 확대할 수 없는 것 |
| --- | --- | --- |
| handlerSyncPrefix | 속성 handler가 동기 반환하기 전 wall time | await 이후 편집·commit·표시 전체 |
| inputToFirstCanvasCommand | 입력 뒤 첫 성공한 workspace Canvas API 호출 시작 | 새 내용의 유효 프레임 완성·compositor·실제 photon 지연·인과 확정 |
| renderRafCallback | 해당 rAF 콜백의 동기 wall time | 이후 MessagePort 렌더·전체 frame CPU/GPU 비용 |
| endStroke | 최종 move와 patch/history 처리를 포함한 호출 | 순수 이력 commit만의 비용 |
| putImageData bytes | 요청한 dirty rectangle 면적×4 | GPU bus 전송량·완료된 화면 픽셀 |
| Node 메모리 | 도달 가능한 engine buffer·history 회계와 process.memoryUsage endpoints | 자연 GC 전후 차이로 단정한 누수·전체 peak RSS/GPU 상한 |
| local startup | 새 browser context에서 canvas ready 관측까지의 driver wall/navigation 기록 | cold OS/browser·12Mbps/RTT150ms·전체 앱 준비·공개 Pages·3초 인수 |

통계는 nearest rank이고 raw samples와 stroke cluster를 함께 보존한다. n3의 p95/p99는 최대값이며,360개 move도3개 stroke와 한 session에 군집돼 있다. 독립 tail 표본이나 물리 펜/터치로 세지 않는다. v2는 옵션·궤적·context·계측이 v1과 달라 이전 성능표와 직접 before/after 향상률을 계산하지 않는다.

## 실제 실행과 상태

호스트는 MacBookPro18,1/Apple M1 Pro,10core/16GiB,macOS27.0 build26A428,Chrome156.0.8078.80/Node24.22.1이다. 렌더러는 headless ANGLE SwiftShader,viewport1400×1000/DPR1 지정이다. 실제 Mac 디스플레이 DPR/주사율이나 물리 입력을 측정한 것이 아니다.

시작 환경 snapshot의 load average는14.65/17.83/13.95였고 compiler process basename은 발견되지 않았다. 이는 한 시점의 관측이며 CPU 사용률·독점 실행·열 스로틀 없음의 증명이 아니다. 다른 앱 부하는 통제하지 않았다. 각 결과의 시작/끝 load와 Node 메모리/CPU endpoint도 따로 남겼다.

| 실행 | 결과 | 해석 |
| --- | --- | --- |
| 첫 v2 통합 파일럿 | 90.19초 budget 실패. 계측 control와12px3stroke의 픽셀/전체 UndoRedo는 완료,100px·Worker는 미완료 | 실패 원문 보존. 전체 통과로 바꾸지 않음. source fixture와 실제 operand 필드의 모호함도 후속 정정 |
| 최종 core-only | 36행 수집·검사:4brush+2구조 메모리+30알고리즘, 각 타이밍은warmup1+n3 | actual operand/hash·출력 분모를 검증. 새로운 안정적 tail 기준 아님 |
| 별도100px browser-only | 57.57초에 완료.3stroke/360moves·ink/corner·전체 UndoRedo·pageerror 검사 통과. 실제 Worker3작업도 완료 | 첫 통합 실행과 별도 process/context·부하/캐시 조건. 하나의90초 성공 run으로 합치지 않음 |
| 옵션 오류 | 소수 samples/잘못된 brush/phase 모두 끄기3개가 exit1, 결과 디렉터리 미생성 | 잘못된 실행을 정상 측정값으로 만들지 않음 |
| 포맷·타입·build | 통과. 제품 payload 해시 동일 | 개발 측정기만 변경, 제품 성능 개선 주장은 하지 않음 |

첫 파일럿의 완료12px 관측은 계측 initializer와 브라우저 body의 원문 해시가 최종본과 같음을 두 독립 검토에서 확인한 범위로 재사용한다. 최종 core와100px 결과는 각기 별도로 보존한다. 원래 실패 이후 작업이 실행됐다고 추정하지 않는다. Node 알고리즘/메모리 관측36행을36개 UI 기능 검사로 세지 않는다.

진단 표본의 pointermove 동기 prefix p95는12px0.2ms/100px0.9ms, 첫 Canvas command proxy p95는0.3/1.1ms였다. 이것으로8ms 전체 획 처리나33ms 실제 표시 목표를 달성했다고 판정하지 않는다. Worker write/read/fill은 각각161.8/301.6/105.7ms(n1 direct protocol)였으며 파일/복구 저장·안정적인 tail 수치가 아니다.

## 예산과 다음 실행

[원래 태스크와 초기 예산 후보](https://github.com/parkjh2568/myPaint/blob/c10a29a397aa77bb946c84406fd661db747164c0/docs/QT_FREE_MIGRATION_TASKS.md)의2MiB 필수 전송·3초 준비·8ms 획 처리·33ms 표시·50ms long task·메모리/장기 사용 목표를 그대로 유지한다. 이번 proxy에 맞춰 목표를 낮추거나 완료 처리하지 않는다.

| 대상 | 현재 고정한 것 | 남은 인수 |
| --- | --- | --- |
| Mac 로컬 진단 | 위 호스트·Chrome/SwiftShader·DPR1·hash·workload·warmup/표본·nearest rank | 반복 cohort·부하 통제·실제 입력/표시·cold network·I/O/IDB·peak/장기 메모리 |
| Android 웹 | Android 기기만 사용 가능 | 모델/Android/Chrome 응답 대기, 실제 DPR/Hz·입력·다운로드·복구와 per-target 예산. adb는 현재 PATH/표준 SDK 위치에 없음 |
| macOS 설치형 | 이전 native 기능 proof와 현재 소스는 구분 | 현행 guard 앱 재빌드·WK 실제 측정·OS picker/IME/clipboard |
| Windows 설치형 | 패키지 대상 범위 | 실제 Windows/WebView2 빌드·측정·OS I/O |

다음 P0는 같은 입력 파일 SHA·색/alpha·크기·레이어/entropy와 operation 경계를 공유하는 Qt/Studio 비교 fixture다. Qt QPainter20line batch/네이티브 파일 save와 현재 TS soft brush/메모리 encode를 같은 분모로 사용하지 않는다. clone/COW detach·warmup·I/O 포함 범위를 고정하고 실제 read/encode/fill4case부터 맞춘다. 이어 cold network/준비·입력/유효표시·snapshot/codec/storage·반복 메모리의 독립 cohort를 측정한다. Android 상세 정보와 물리 실행 없이 QF-03을 닫지 않는다.

재현은 기존 `npm --prefix web-app run test:performance`를 사용한다. 환경변수 `PAINT_BENCH_SAMPLES=3`, `PAINT_BENCH_SKIP_BROWSER=1`은 core-only, `PAINT_BENCH_BROWSER_ONLY=1 PAINT_BENCH_BRUSH_SIZE=100`은100px UI와 Worker를 고른다. 기본은 두 크기이며 load에 따라 전체90초 예산에서 완료되지 않을 수 있다. `PAINT_TEST_URL`은 직접 제공한 로컬 번들을, `PAINT_PERFORMANCE_OUTPUT`은 새 보존 디렉터리를 지정한다. 이 budget은 OS hard watchdog이 아니며 실패 시 원문과 소유 자원을 확인한다.

모바일/태블릿은 웹만, 실행파일은 Windows/macOS만 제공한다. 홈페이지 쓰기·commit/push·공개 배포는 하지 않았다.
