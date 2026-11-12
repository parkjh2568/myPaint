# Studio 제품·도메인·로컬 계약

2026-11-05 / Qt-free 전환의 현재 구조와 목표 계약. 실제 검증 상태와 남은 차이는 [구현 기록](STUDIO_IMPLEMENTATION.md), [독립 리뷰/RCA](archive/STUDIO_REVIEW_AND_RCA.md)를 기준으로 한다.

[문서·알파·비동기 확정의 명시 계약과 최신 QF-04 감사](STUDIO_DOCUMENT_CONTRACTS.md)를 따른다. 아래 날짜별 실행 기록은 각각 당시 소스에 한정한다.

## 제품과 흐름

사용자는 계정 없이 새 그림 또는 로컬 파일을 열고, 도구/레이어로 편집하며 Undo/Redo 후 프로젝트 또는 이미지를 기기에 저장한다. 웹에서는 다운로드를 준비한 뒤 `파일 받기`를 눌러 실제 파일을 확인한다. 브라우저의 다운로드 요청을 저장 완료로 취급하지 않는다. 설치형은 OS에서 선택한 대상만 안전하게 교체한 뒤 saved revision을 확정한다. 저장 취소/실패·손상 입력·미확정 선택/문자의 실패가 기존 문서나 복구 사본을 바꾸지 않아야 한다.

필수 기능은 기존 17개 도구, 레이어/변형/문자/클립보드, 프로젝트 호환, 알파, 복구, 반응형/펜/터치, Studio/Classic 스킨이다. 비기능 요구는 bounded allocation, 한 획 한 Undo, 고유 revision, 단일 입력 소유권, 작업 취소, 로컬 실행, 접근 가능한 조작부, 측정 가능한 응답성과 재현 가능한 빌드다. 실행파일은 Windows/macOS만, 모바일/태블릿은 웹만 제공한다.

## 도메인과 상태 소유권

| 모델                         | 권위 상태·규칙                                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document State               | width/height/background/active/layers. background는 지우기·확장 색이며 UI 보조색/체커보드/출력 바탕과 별개                                                                                            |
| Layer                        | name/visible/straight RGBA8 pixels. 단순 Canvas 왕복으로 원시 픽셀을 정규화하지 않음                                                                                                                  |
| History Change               | unique beforeId/afterId, 픽셀 타일 patch·metadata/순열 patch·구조 snapshot, 메모리 회계와 즉시 예산 가지치기. savedRevision과 cursor를 동일시하지 않음                                                |
| Stroke                       | 포인터·시작 마우스 버튼이 소유한 임시 tile-before/최대 coverage/dirty set. 완료/취소 dirty 영역은 다음 frame까지 픽셀 배열에 연결. 끝점 확정 또는 cancel 복원. pixel/dabsOnly도 같은 이력 소유권 사용 |
| Pending Selection/Text/Shape | session 소유의 미확정 상태. 후보를 만들고 검증한 뒤 원자적으로 확정·해제. 취소는 기존 문서/Redo 보존                                                                                                  |
| Recovery Head/Snapshot       | 각 문서 세대 key·증가 sequence와 같은 key의 웹 Blob 또는 native envelope 파일. 동시 탭과 stale 목록을 구분                                                                                            |
| Native Lifetime Gate         | 첫 `activate_document` 성공 후 `guard_armed`; UI 승인 시 `allow_close`. 창·runtime·AppKit 종료 요청을 같은 확인 절차로 연결하고 초기 편집 차단 상태에서는 종료 허용                                   |
| Native Save Ticket           | OS에서 선택한 path의 opaque token, 파일 identity/size/mtime/변경시각·generation과 저장 취소 flag. 임의 경로 쓰기 API를 노출하지 않음                                                                  |

엔진은 DOM/플랫폼을 import하지 않는다. UI는 엔진과 platform을 호출하고, codec platform은 Worker의 수명/전송을 소유한다. Worker는 엔진 코덱/연산만 실행한다. platform storage는 웹 로컬 DB/설치형 복구 라우팅, native는 Tauri IPC, Rust persistence는 파일·잠금·원자 교체, lifecycle은 macOS AppKit 종료 delegate, surface는 표시 자원을 소유한다. 색상·메뉴·포인터는 DOM에 작은 값으로 두고 픽셀을 프레임워크 상태로 복제하지 않는다. 실제 공유 스키마·자원 소유권만 분리하며 단일 대입을 helper로 나누지 않는다.

직전 Codec 응답 단계에 고정한 [의존성 기록](evidence/studio-codec-reply-module-graph.json)은 `env.d.ts`를 포함한 TypeScript 파일 13개를 분석한다. Import·re-export·type query 선언 35개를 같은 출발점·대상·종류로 합친 고유 관계는 34개다. 정적 런타임 관계 24개, 동적 관계 3개, Worker 자산 1개, CSS 자산 1개, 타입 전용 관계 5개이며 외부 패키지 관계를 포함한다. 로컬 런타임 관계의 순환은 0개다. Worker 메시지 왕복은 통신 경계이며 import로 세지 않는다.

`main.ts`는 `runtime_ready`가 참일 때만 `native-smoke.ts`를 동적으로 불러온다. Smoke가 받는 `Studio`는 `import type`이고 main도 `export type`만 제공한다. 타입 역참조를 포함한 소스 그래프에는 main↔smoke와 codec↔codec.worker의 SCC 2개가 있지만, 타입만의 순환과 런타임 소스 순환은 각각 0개다. 타입 import/export는 실제 JavaScript에서 소거된다. 이전 고정 phase2 `/mypaint/` 빌드의 Chrome 2문맥과 색 교체 단계의 일반 웹 1문맥·`runtime_ready=false` 네이티브 IPC 모델 9문맥에서 smoke chunk 요청과 오류가 없었다. 각각 당시 소스·산출물 해시에 한정한 관측이다. 해당 Codec 응답 단계의 bundle은 당시 소스·산출물 AST와 해시를 재검사했다. 이전 GIF·pointer-side·decoder 단계의 source/native/network 근거는 당시 스냅샷으로 보존하며, 그 고정 bundle의 일반 모드 네트워크를 새로 실행하지 않았다. 실제 네이티브 일반 모드의 네트워크 검증과도 구분한다.

생성된 chunk 그래프는 별도로 구분한다. 당시 Codec 응답 산출물의 JavaScript chunk 5개는 정적 평가 순환이 없고, 동적 로딩까지 포함하면 entry↔smoke와 codec.worker↔Buffer/encoder의 SCC 2개가 있다. Entry는 Studio를 먼저 생성하고, top-level await 없는 모듈 안의 별도 async workflow가 `runtime_ready`에서 기다린다. 이후 동적으로 불러온 smoke는 이미 평가된 Entry의 공유 helper를 참조하므로 Entry와 Studio를 다시 실행하지 않는다. Worker도 평가와 handler 설치를 마친 뒤 JPEG 요청에서 공유 helper chunk를 불러온다. 초기화 전 지연 import나 의존 chunk를 기다리는 top-level await가 추가되면 이 순서를 다시 검토한다. 소스와 산출물 해시, 각 그래프의 집계 범위는 의존성 기록에 남긴다.

직전 네이티브 저장·복구 단계는 [당시 보고](archive/STUDIO_NATIVE_OWNERSHIP.md)의 main `b7b9d26c`·persistence `4d46f4cb`·entry `index-DLvOR2As.js`를 따른다. 현재 웹 후보의 main `48695bee`·entry `index-DIgO41Ne.js`와 오류 세대 검사는 [QF-04 계약 감사](STUDIO_DOCUMENT_CONTRACTS.md)에 연결한다. 복구 조회 전체 흐름에 owner guard를 두고 저장 binding은 게시한 열린 파일 descriptor에서 갱신한다. 앞선 smoke 단계·시간 기록은 유지한다. import 관계는 바꾸지 않았으며 위 그래프의 원문·해시는 직전 Codec 응답 단계 snapshot으로 보존한다. 최신 자산 그래프를 새로 생성했다고 주장하지 않는다.

핵심 데이터 흐름은 입력→Stroke 임시 patch→권위 pixels→dirty 영역 표시→획 종료 history다. 파일 흐름은 bounded File bytes→Worker 검증/해독 또는 헤더 검사 후 플랫폼 bitmap→후보→교체 여부→Document reset이다. 저장은 pending 후보/이력 준비→Worker 인코딩→웹 다운로드 또는 네이티브 원자 교체→해당 문서/세대에만 확정이다.

투명 일반 브러시와 투명 source-over는 원본의 숨은 RGB를 정규화하지 않는다. 보이는 레이어의 무변경 입력은 revision·saved 상태·기존 Redo를 유지한다. 숨긴 레이어는 실제 입력점이 문서 안에 한 번이라도 들어왔거나 실제 coverage 타일이 있을 때 표시한다. 픽셀 변화가 없으면 기존 stroke 이력 안에 visibility 변화만 픽셀 0바이트로 기록한다. 완전히 문서 밖인 무잉크 입력을 no-op으로 남기는 것은 Qt의 무조건 표시와 구분한 안전 정책이다.

binary 선택의 원본 지우기는 단일 레이어에서 배경 raw RGBA, 여러 레이어에서 RGBA0을 원본 mask 안에 직접 대입한다. alpha0의 배경 RGB도 명시 대상값이다. 원본이 없는 붙여넣기는 원본을 지우지 않는다. 최종 후보가 원본과 같으면 기존 revision/Redo를 유지한다. 연속 coverage를 가진 원형 지우개와는 별도 계약이며 [선택 원본 근거](evidence/studio-selection-source.json)를 따른다.

선택의 sourceRect/sourceMask는 문서에서 지울 원래 영역이고, current Raster는 표시/합성 payload, resizeSource는 nearest 크기 조절의 기준 Raster다. 크기 조절은 기준을 유지하고 rotate/flip/shear 성공은 현재 표시를 굳힌다. drag는 current/base/modified를 함께 캡처·복원하며 제스처 전체의 기준을 고정한다. originalPixels는 초기 선택의 포인터/방향키 이동·포인터 크기 조절에서 NoOp 비교용이고 명시 geometry 성공 뒤 해제한다. 원본 픽셀 복구는 doc.state가 소유한다. [후속 선택 근거](evidence/studio-masked-transform.json)는 이 역할과 추가 보유 메모리의 범위를 구분한다.

nearest는 호출당 X 표와 행 Y를 공유하며 aligned source를 명시 byteOffset/length Uint32 view로 읽고 unaligned는4채널을 직접 복사한다. 바이트/alpha/hiddenRGB를 재양자화하지 않는다. 같은 current 크기 요청은 포인터 bookkeeping/검증/draw를 유지해 출력만 재사용한다. polygonMask의 even dense 행은 floored/clamped 열 XOR로 동일 반개구간을 만들고 sparse/odd는 기존 pair를 유지한다. 추가 workspace와 실제 비용·제한은 [선택 성능 근거](evidence/studio-selection-performance.json)를 따른다.

마우스의 추가 버튼 3/4를 포함해 0~2 밖의 시작 버튼은 focus·capture·포인터 소유권 등록·settle 전에 거부한다. 터치·펜 입력과 가운데 버튼 pan, 이미 시작한 획의 owner 버튼 해제 판정은 기존 경로를 유지한다. 이는 펜 지우개 자동 전환이나 브라우저 뒤로/앞으로 동작의 변경을 뜻하지 않는다.

도형은 최근 그리기 press의 좌·우 버튼을 기억해 윤곽/채움 색을 바꾸고 RGBA 알파를 유지한다. 둥근 사각형은 현재 Studio의 소수 좌표·min/abs 범위와 방향 대칭을 유지하고 양수 면적에서 x/y 반경을 각각 최대 12로 제한한다. 점·한 축 0은 기존 scalar 0 경로이며 Qt QRect의 방향별 범위를 그대로 복제한 정책은 아니다. 이미 저장된 프로젝트는 완성 픽셀을 유지한다. 미리보기·닫힌 다각형 채움·pending 후보·확정이 같은 `paintShape`를 사용한다. 포인터 취소·두 손가락 탐색 전환·입력 실패는 이전 버튼 소유권을 복원한다. Pan은 이 소유권을 바꾸지 않으며, middle pan이 도형 색까지 바꾸던 Qt 부작용은 복제하지 않는다.

표시는 `PixelTileCache`의 source 타일과 `FinalSceneCache`의 완성된 불투명 화면을 함께 소유한다. source는 실제 pixels 객체를 식별자로 사용하고, 선택의 잘라낸 바탕 preview는 별도 cut owner를 사용한다. 물리 배율이 1 이상이고 원래 가시 작업량이 64타일을 넘으며 전체 scene이 예산 안에 맞을 때만 final scene을 유지한다. Source 510px 격자의 device clip 경계를 정렬하고 각 투영 구획을 최대 512px로 나눈다. 생성된 world viewport의 정수 `deviceBounds`를 source culling에 전달해 분수 배율의 역변환 오차를 피한다. 기존 PixelRect 호출자는 같은 경로를 유지한다.

Source와 scene은 합계 64타일·128MiB의 추정 RGBA 예산을 공유한다. 축소나 scene 예산 부족에서는 원래 source 예산으로 돌아간다. 이는 전체 RSS나 GPU 복사를 포함한 상한이 아니다. 물리 Canvas 전체에 불투명 배경을 먼저 채우며, 완성된 scene을 얻은 뒤 선택·곡선·다각형 overlay를 한 번 그린다. 완전한 cache hit에서는 종이와 체커보드를 다시 채우지 않는다. Dirty는 source에 한 번 등록하고, context loss·예외·문서 교체에서는 두 cache를 함께 해제한다. 원본 RGBA·알파·halo·mip 선택은 유지한다. 여러 dirty 구획의 단일 bounding box와 최초 cache 생성의 응답성 한계는 [최대 문서 기록](archive/STUDIO_MAX_DOCUMENT.md)에 별도 인수 항목으로 남긴다. 균일 mip 영역의 검사는 행 시작 인덱스를 한 번 계산하고 4word 비교와 tail을 순차 처리한다. 최초 불일치에서 기존 box 평균으로 돌아가며, unaligned 버퍼와 transform은 기존 fallback을 유지한다. 원본 RGBA·zero-alpha preview·좌표·할당·예산 계약은 바꾸지 않는다.

네이티브 검증 모드에서는 기본 문서가 유지되는 준비 단계에서 constructor의 500ms recovery workflow를 기다린 뒤 rAF를 비우고 target을 설치한다. 750ms 대기와 초기화는 `startupDrainMs/setupMs`로 분리한다. Target 설치 이후 예약된 자동 frame이나 owner·camera·view·DPR 변경은 표본을 실패시킨다. Cold는 renderer cache가 비어 있음을 뜻하며 OS·CPU cache까지 차갑다는 보장은 아니다. 시간 batch는 test rAF 안의 실제 `Studio.render()` API 반환 시간을 잰다. Production scene capture의 Canvas-to-Canvas `drawImage`는 포함하고, 추가 test `getImageData`·권위 픽셀 hash·reference render는 뒤로 분리한다. `derivedPaperMatrix`는 산술 메타데이터이며 실제 backend transform 기록이 아니다. `queueMs`와 rAF timestamp 간격도 물리 화면 제시나 전체 입력 지연을 뜻하지 않는다.

2048²×16의 문서 배율 1:1 scene과 8192×4096×2 white/raw-zero mip는 별도 앱·프로세스로 확인한다. Mip fixture의 기대 원본 SHA는 Node 상수에서 따로 계산해 첫 cold 전에 브라우저에서 원본을 읽거나 hash하지 않는다. Cold/unchanged/dirty/rollback의 후속 전체 Canvas hash는 복원·불변성 oracle이며 독립 mip 수학 구현과의 비교가 아니다. 해당 mip의 각 3회 새 프로세스 표본에서 중앙값은 345→272 ms였고 50ms 응답성 목표는 남아 있다. 이 수치는 모든 문서의 개선율·p95/tail·물리 presentation 인수로 일반화하지 않는다. 초기 실패·16layer baseline·API 1+1 진단·8k baseline/unroll·최종 16layer·교차 6회 결과와 보존한 135 ms 표본은 [WK 렌더 통합 근거](evidence/studio-wk-render.json)에서 구분한다.

## 저장소 스키마·파일 형식

서버 RDBMS는 없다. 브라우저 DB는 같은 origin의 IndexedDB `retropaint-local-v1`, version1이다.

| Store     | Primary key          | Value                         | 계약                                                                                         |
| --------- | -------------------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| heads     | 문서 세대 문자열 key | `{key,sequence,size,name,at}` | key 길이≤64, sequence≥1 정수, 유효 size/name/date. value.key와 실제 key 일치                 |
| snapshots | heads와 같은 key     | RPAINT01 Blob                 | head와 size·generation을 같은 트랜잭션으로 확인. 저장/삭제는 두 store를 함께 commit/rollback |

복구 정책은 최대32개, 합계64MiB다. 자신의 기존 사본을 교체할 때 이전 크기는 새 합계에서 제외한다. 손상 메타데이터·새 generation·한도 초과·transaction abort는 기존 사본을 보존한다. 실제 디스크 quota/권한 실패는 별도 예외다. 현재 자동 복구는 확정 revision을 대상으로 하며 미확정 문자를 보장하지 않는다.

RPAINT01의 little-endian header, 크기/레이어 수/active/background, UTF-8 이름/visible/PNG 길이와 레이어 순서를 보존한다. 새 필드나 서비스 의존성을 추가하지 않는다. PNG raw RGBA 왕복과 Qt premultiplied 표시 표현을 구분한다. JPG/BMP는 명시한 바탕색으로 불투명하게 합성한다.

파일 크기는 한 번 캡처한 안전한 정수와 실제 arrayBuffer 길이를 모두 검사한 뒤 디코더를 선택한다. 프로젝트 레이어는 레코드 범위와 첫 IHDR 치수를 outer 문서와 먼저 대조하고, 이후 기존 PNG CRC·형식·출력 치수 검증을 유지한다. 손상된 마지막 레이어가 선언한 레이어 합계를 넘겨 디코드되는 경로를 막는다. PNG/프로젝트는 Worker에서 처리하고 JPEG/BMP/GIF는 헤더 한도 검사와 실제 bitmap 치수 재검사를 거친다. SVG·임의 포맷 fallback은 없다.

GIF는 첫 image descriptor까지 GCT·extension subblock의 길이를 확인하며 진행하고, logical screen과 첫 프레임 offset+치수의 최대 범위를 디코더 호출 전에 검사한다. 긴 prefix는 진행량과 경과 시간을 기준으로 event loop에 양보하며 취소를 확인한다. 정상 animation은 첫 프레임만 여는 기존 정책을 유지한다. 후속 프레임이나 bounded 비규격 GIF를 일괄 금지하지 않고, 플랫폼별 실제 bitmap 치수·픽셀과 기존 zero-logical 거부를 유지한다. 이 사전검사는 브라우저 디코더 내부 중간 버퍼·전체 프레임 metadata·전체 RSS 상한의 증명은 아니다.

웹은4Mi pixels/총6Mi/4096/16 layers/파일40MiB, 설치형은32Mi/총64Mi/32768/파일300MiB의 명시 프로필을 사용한다. State/파일에 프로필을 저장하지 않고 실행 환경과 Worker 요청/응답에 일치시킨다. 실제 대형 문서·타일·geometry·JPEG 경계 검증과 남은 최대 부하 인수는 [후속 기록](archive/STUDIO_NATIVE_PROFILES.md)을 따른다.

## 내부 API와 권한

| 경계                                                   | 요청/응답                                                                                                            | 실패·소유권                                                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Document                                               | 즉시 `commitState`; 지연 `prepareState/installPrepared`; `editMetadata`                                              | 지연 후보의 owner/revision/active/id/이력/예산·픽셀 변경을 거부. Metadata는 픽셀을 이력에 참조하지 않음               |
| Codec Worker                                           | operation + owned State/bytes → state/image/bytes 또는 error                                                         | 최대2개,20초,AbortSignal, transferable은 후보 복사본만. 종료/실패 시 Worker/timer/listener 해제                       |
| RecoveryStore                                          | list/write/clear/read                                                                                                | 입력 스키마와 DB 실제 head 검증, stale read/delete 거부, 전 트랜잭션 완료 후 응답                                     |
| Native activate_document / choose_open / read_selected | generation/key/source token; OS 선택 token → raw bytes                                                               | 정상 읽기·코덱 검증 뒤 원본 경로 연결. 이미지/복구는 프로젝트 원본에 연결하지 않음                                    |
| Native choose_save                                     | name/generation/project/saveAs → token/name/generation 또는 취소                                                     | 기억한 프로젝트 또는 OS 선택 경로. 한 번 claim, 취소/문서 세대에 한정                                                 |
| Native write_selected                                  | token header + raw bytes → name/generation/project receipt 또는 error                                                | 일반 파일·stamp 재확인·임시파일 sync·원자 교체. 직접 덮어쓰기 fallback 없음                                           |
| Native cancel_write                                    | token → 취소 flag                                                                                                    | 교체 전 취소는 원본 보존, 이미 완료한 교체의 늦은 취소는 성공으로 처리                                                |
| Native recovery                                        | list → entries/warnings, read/clear token, write raw+generation/key/sequence/name headers                            | 32개·합계1GiB 파일 복구, 이전 Qt 읽기 전용, stale read/delete 거부                                                    |
| Native app lifetime                                    | 활성화 이후 Window CloseRequested / RunEvent ExitRequested / AppKit applicationShouldTerminate → close-request event | 초기 준비 실패 중 편집 차단·재시도·종료 허용. 활성화 이후 현재 UI가 취소하면 보존, 승인한 close_window만 앱 전체 종료 |

설치형 종료 보호는 첫 문서 활성화가 성공한 뒤 적용된다. Rust는 성공 응답 전에 `guard_armed=true`를 설정하며 이후 활성화 실패로 해제하지 않는다. UI 부팅·저장소 준비 실패로 편집을 시작하지 못했거나 main WebView가 이미 없는 경우에는 종료를 허용한다. 사용자 승인 뒤 `close_window`가 `allow_close=true`와 `app.exit(0)`으로 단일 창 앱 전체를 종료한다. 획·busy·열린 대화상자·미확정 입력은 현재 UI가 판단한다.

macOS 기본 Quit는 pinned Tao 0.37.2에서 창 닫기와 RunEvent ExitRequested를 우회하므로 [lifecycle.rs](../web-app/src-tauri/src/lifecycle.rs)의 AppKit delegate 보호도 필요하다. 동기 main-thread setup에서 기존 delegate의 ivar 없는 동일 크기 subclass만 설치하며 기존 ivar·생성/소멸·메서드를 상속한다. Tao/objc2 갱신 시 ABI·layout·super-dispatch를 재검토한다. 정상 실행에서는 종료 검증 모드를 노출하지 않고, `--smoke --quit-smoke --persistence-root`에서만 runtime/native 요청을 시험한다. 결과 보고 명령은 종료를 승인하지 않는다. 실제 macOS release/WKWebView의 복구·코덱·종료·scene 4단계와 Rust 16개 검증은 [네이티브 기록](STUDIO_NATIVE_PERSISTENCE.md)을 따른다. 각 단계의 소스·산출물 manifest와 실제 macOS 4단계 결과는 [의존성 기록](evidence/studio-module-graph.json)에 연결한다. 이전 [GIF 입력 근거](evidence/studio-gif-input.json)와 pointer-side·decoder 결과·원문·보존 바이너리도 별도로 남긴다. Codec 단계는 static red·animation first red·transparent GIF 3개를 실제 WK에서 확인했다. 직전 pointer-side의 추가 버튼·owner chord·pending 보존·Shift 끝점 [입력 회귀 23항목](evidence/studio-pointer-buttons.json)이 오류·실패 없이 통과했다. Chromium CDP와 네이티브 IPC 모델의 결과이며 브라우저 기본 탐색·focus 정책이나 물리 펜 입력의 검증을 뜻하지 않는다. Scene의 기존 14프레임·원본 SHA와 별도 작은 PaintDocument의 색 교체 core 3개를 합친 18항목은 공개 UI 입력 검사와 구분한다. 이전 decoder 단계의 Node 155개, 이전 GIF·WK 렌더 단계 각각의 Node 166개는 별도 기록으로 남긴다. 이전 GIF 공개 UI 22항목과 기본 브라우저 10항목은 당시 snapshot에 한정한다. 당시 WK 렌더 제품도 기본 브라우저 10항목을 다시 통과했다. 정렬 변경의 성능 결과는 당시 후보의 [통합 근거](evidence/studio-scene-integration.json)를 유지한다. Windows 실행과 강제 종료 내구성은 이 결과에 포함하지 않는다.

사용자 인증/관리자 권한/원격 세션은 제품 범위에 없다. 웹은 브라우저 origin·보안 컨텍스트·파일 선택·클립보드 권한을 따르며, 저장소가 차단돼도 프로젝트 파일로 보존할 수 있어야 한다. 설치형은 번들 로컬 UI와 제한된 IPC만 사용한다. remote pages·uploads·telemetry·updater·shell 실행을 앱 런타임에 추가하지 않는다. 빌드 의존성 다운로드는 실행 기능과 분리한다.

## 프론트엔드·배포·품질 게이트

Vite/strict TypeScript, DOM/CSS, Canvas2D 표시와 로컬 SVG 아이콘을 쓴다. 스킨은 CSS 변수로 바꾸며 엔진을 복제하지 않는다. 화면 폭과 실제 pointer 능력으로 모바일 하단 도구/패널·태블릿 touch density를 조정한다. 고해상도 표시 자원과 문서 픽셀 해상도를 분리한다.

`npm --prefix web-app ci`, `npm --prefix web-app run build`로 정적 `web-app/dist`를 만든다. `/mypaint/` 상대 자산으로 동작한다. `npm --prefix web-app run desktop:build`는 해당 Windows/macOS 호스트에서만 패키지를 만든다. Android/iOS native 프로젝트는 생성하지 않는다.

소스 origin과 형제 홈페이지 저장소는 별도 디렉토리/commit/push를 유지한다. 홈페이지에는 검증된 산출물만 전달하며 SDK/node_modules/Rust target을 올리지 않는다. 새 manifest staging과 구탭 자산/롤백 인수가 끝나기 전에는 기존 공개 앱을 교체하지 않는다. release 서명·공증과 공개 URL 인수는 빌드 성공과 별개다.

기본 검사는 `npm --prefix web-app run check`, `format:check`, `test`다. 브라우저는 lockfile의 Playwright로 Chromium을 준비한 뒤 고정 정적 서버에 `PAINT_TEST_URL`을 지정하고 `test:browser`를 실행한다. 명시적 성능 검사는 `test:performance`이며 환경/프로필/해시를 결과에 남긴다. CI는 실패를 검사 상태로 알리고, 앱에서는 현재 상태 메시지와 로컬 오류 로그만 제공한다. 현재 검증과 미확인 기기는 후속 기록에서 분리한다. [최대 문서 기록](archive/STUDIO_MAX_DOCUMENT.md)은 cold/steady, 2layer 축소와16layer1:1을 구분한다. [native 저장·복구 기록](STUDIO_NATIVE_PERSISTENCE.md)은 실제 OS 파일 검증과 Chromium IPC 모델 검증을 구분한다.


## 입력 실패의 자원 소유권 보완

[후속 근거](evidence/studio-basic-tools.json)의 포인터 오류와 spray timer 오류는 기존 cancelPointer 경계에서 stroke·선택 임시 raster/위치·도형 버튼·lasso·timer를 복원한다. Map에서 먼저 제거한 뒤 capture를 해제하며, drag 없는 등록 포인터의 lostcapture도 정리한다. 두 손가락 탐색 전환의 keepPointers 경로는 두 owner와 capture를 유지한다. 단발 실패·실제 한도 오류 후 첫 재시도를 공개 UI로 확인했다.

펜 종료의 pressure0은 마지막 접촉 압력으로 마무리하고 실제 이동 중0은 보존한다. 지우개 target/source의 원래 alpha가 모두0이면 raw RGB와 이력을 바꾸지 않는다. 원래 알파는 tile.before로 판단해 중간 반올림0 이후의 정상 삭제를 막지 않는다. 최종 Node169·새 도구 UI31·포인터26과 실제 macOS 일반4단계는 각각의 검증 범위로 기록하며 물리 Android/Windows 인수와 구분한다.


## 사각 도구의 독립 raster 경로

[사각 도구 근거](evidence/studio-square-tools.json)의 hard square는 원형의 최대 coverage 누적과 다른 이벤트별 합성·고정소수점 경계를 사용한다. `moveSquareStroke`가 clipping·행 구간·합성을 소유하고 `captureStrokeTile`만 두 경로의 before-image 할당/등록을 공유한다. hard square는 불필요한 coverage plane을 할당하지 않는다. 수치 helper는 제한된 clipping/edge 준비에만 쓰고 픽셀 루프에서는 호출하지 않는다. 새 런타임 의존성이나 DOM/플랫폼 엔진 의존성을 추가하지 않았다.

포인터 종료는 최종 선분을 한 번 처리하고, 다른 마우스 버튼의 상태 변화는 hard square 그리기 이동에서 제외한다. 실제 이동 이벤트의 반투명 합성은 유지한다. 사각 옵션과 원형 옵션의 UI를 구분하되 원형으로 돌아갈 때 값을 복원한다. Qt 기하/이벤트 기준과 현재 straight RGBA 저장 정책은 별도 계약으로 검증했다.


## 연필 라우팅과 키보드 버튼 소유권

[최신 입력 근거](evidence/studio-pencil-palette.json)의 UI 연필은 size1·square=true·pixel=false로 검증된 정수 raster 경로를 사용한다. generic pixel/spray API와 엔진은 변경하지 않는다. opacity·압력·크기 등 미적용 옵션을 UI에서 비활성화하고 표시만1px로 바꾸며, 저장된 둥근 브러시 설정은 유지한다. 엔진/코덱 원본은 이전 사각 단계와 byte-equal이다.

Enter 처리에서 입력 대상이 native button이면 버튼이 해당 동작을 소유한다. Canvas의 Enter 확정은 유지하고 busy·dialog·IME·Esc·Ctrl/Cmd 정책은 기존 선행 분기에 둔다. 팔레트의 색상 custom property는 스킨 panel/accent보다 우선하므로 일반 버튼의 스킨과 색상 의미가 함께 유지된다. 현재 source/asset 의존성 그래프와 actual macOS 바이너리 근거는 [의존성 기록](evidence/studio-module-graph.json)에 연결하며 이전 square 그래프는 고정본으로 보존한다.


## 큰 선택 준비 후속 — 2026-11-05

큰 lasso만 prepareSelection 자원 소유 경계를 거친다. 작은 void API와 기존 pending selection/commit 계약은 유지한다. UI가4096point packing/bbox와65536pixel crop를 협력 스케줄링하고, 기존 codec Worker가 전체 global path의 mask/key를 처리한다. owned ROI와Float64만 transfer하며 새 전역 scheduler는 없다. engine applySelectionMask는 sync/Worker의 실제 공통 알고리즘이고 DOM/IPC를 참조하지 않는다. 런타임 관계/모듈수는 같고 Worker→codec DTO type-only 관계1개 추가로34관계가 됐다. source runtime cycles0·emitted static cycles0, type-inclusive SCC2·dynamic-load SCC2를 분리한다. 실패/취소/소유권 변경 뒤에는 게시하지 않는다. [고정 실행·리뷰 자료](evidence/studio-selection-preparation.json).


## 선택 첫 화면 비용 후속 — 2026-11-05

Studio.render 안의 cut transform 하나만 변경했다. 정수row/col과 원본 source bbox의 ceil 교집합을 순회하며 원본 mask stride·단층 background/다층 투명 Source RGBA를 그대로 쓴다. payload alpha/key·캐시owner/key·레이어순서·hiddenactive·TileCache/mip/halo/scene·Worker·문서/이력은 그대로다. 새 production module/helper/dependency0. 소스17/산출물8/AST 검증에서 나머지 render/class/top-level은 같고 의존관계34/runtime cycle0·emitted static0/type-inclusive2·dynamic-load2는 같다. 성능개선은 첫 cut CPU의 근거이며 scene/cache 재설계로 확대하지 않는다. [고정 측정·검증 자료](evidence/studio-selection-preview.json).


## nearest 엔진 변경과 그래프 — 2026-11-06

`operations.resizeState`의 nearest 본문에서만 행 복사·반복 행 재사용·정렬된 정확히 2배 대입을 수행한다. 원래 좌표 표와 검증·smooth·패딩·메타데이터·호스트 경계를 유지했으며 헬퍼·모듈·의존성을 추가하지 않았다. 소스 17개 중 나머지 16개와 import 관계는 같고 정적 런타임 순환은 0이다. canonical 그래프는 독립 AST/번들 검토와 이전 그래프 보존을 연결한다. 아직 동기 UI 호출이므로 취소 가능한 대형 작업은 별도 소유권 설계가 필요하다. [측정·구현·독립 검증 근거](evidence/studio-nearest-resize.json).


## 선택 크기 계산의 소유권 — 2026-11-06

`resizeNearestSteps`는 두 소비자가 공유하는 순수 nearest 알고리즘이다. 동기 `resizeState`는 끝까지 실행하고 UI의 `resizeSelection`은 한 gesture의 채널·커서·최신 target·대기·제한시간·정리를 소유한다. 기존 작은 동기 경로와 형식/Worker 경계는 유지한다. 새 runtime 모듈·의존성은 없고 정적 runtime 순환은 0이다. released drag와 pendingState/키보드 fence가 미완성 후보 소비를 막는다. 일반 busy overlay로 매 이동을 감싸지 않아 기존 두 손가락 takeover의 취소 경로를 유지한다. 현재 실제 touch 인수로 세지는 않는다. [분할 resize 구현·실행·독립 검토 근거](evidence/studio-bounded-resize.json).

### 2026-11-06 둥근 사각형·컨텍스트 실패 경계

[채택 코드와 실행 근거](evidence/studio-roundrect-contract.json). `paintShape`의 독립 축 최대 12와 `shapeRaster`의 컨텍스트 획득 위치만 변경했다. 새 helper·런타임 모듈·의존성은 없다. 컨텍스트 null/throw에서도 소유 함수가 임시 Surface를 finally에서 0×0으로 내리며 문서와 기존 Redo를 유지한다. `surface.ts`의 API와 기본 컨텍스트 요청은 원본 바이트 그대로다.

읽기 hint는 격리 측정에서 비용과 WK seam을 개선했지만, 실제 DPR 1의 pointerUp 경계색 차이를 1→최대 124로 키워 미채택했다. 기본 벡터 미리보기와 문서 해상도 확정 결과의 경계 AA 차이, 기존 WK 타일 경계 alpha 1/RGB 2 한계는 별도로 기록한다. Strict WK seam 실패를 통과로 바꾸지 않는다. 이전 [그래프 snapshot](evidence/studio-module-graph.json)은 과거 해시 참조를 위해 보존한다.

## 출력 미리보기 소유권

[현재 구현·검증](archive/STUDIO_EXPORT_PREVIEW.md). exportImage는 원본을 읽는 최대 192px grid·채널·폰트 대기·표면·대화상자를 소유한다. 선택 원본 지우기와 확장 바탕을 적용한 뒤 pending 문자/도형을 활성 레이어 안에 합성하고, 상위 레이어와 최종 matte를 순서대로 적용한다. 형식·색 변경은 캐시만 갱신하며 실제 확정 전에는 전체 후보·Worker를 만들지 않는다. 문자 줄바꿈과 그리기는 동기 실제 출력과 분할 미리보기가 공유한다. 취소·stale·실패는 원본과 Redo를 유지한다. 새 런타임 모듈·의존성은 없으며 기본 Surface API는 그대로다.

## 입력 투영과 터치 표적

[현재 구현·검증](archive/STUDIO_TOUCH_VIEWPORT.md). UI는 canvas 원점·크기와 backing/DPR을 저장한다. 실제 pointer가 소유한 provisional/navigation의 투영이 달라지면 rollback 후 geometry를 갱신하며, down/move에서 소유권을 확인한 뒤 문서 좌표로 변환한다. 손을 뗀 비동기 resize/preparation은 별도 작업 소유권을 유지한다. 정지 pending·수동 줌·문자 box와 내용은 보존하고 필요한 camera offset만 조정한다. Move/coalesced는 기존 point 메서드가 같은 rect를 재사용한다. 터치48px은 label·레일·grid·scrollport의 실제 영역 기준이며 모델리스 패널의 전체 scroll/sticky heading과 함께 적용한다.

## 카메라와 VisualViewport 소유권

[현재 구현·검증](archive/STUDIO_CAMERA_VIEWPORT.md). canvas wheel은 진행 중 pointer/provisional/navigation/busy/modal과 동시에 투영을 바꾸지 않는다. VV의 normalized 높이는 앱 레이아웃, raw rect는 접근 가능한 패널을 소유한다. 좁은 pinch에서는 anchor를 고정하고 실제 span/layout 변화에만 재기준화한다. scale1/full-width origin은 앱 전체가 따른다. 반복된 같은 기하는 focused editor clamp를 덮지 않으며, 선택·UndoRedo의 기존 맞춤은 유지한다. 미변형 선택은 기존 commitPending 검증·정리로 합류하고 픽셀 복제만 생략한다.

## 복구 snapshot과 실패 소유권

[현재 근거](archive/STUDIO_RECOVERY_SNAPSHOT.md). 확정 revision의 전용 snapshot만 Worker로 전송하며 live/이력 버퍼는 유지한다. recovery owner는 backend를 고르기 전에 typed/nonempty/profile byte 한도를 검증한다. IDB 완료나 native commit을 성공으로 받은 뒤에만 recoveredRevision을 표시하며, 이전 epoch의 늦은 오류가 새 문서 상태를 덮지 않는다. key/generation·quota·기존 사본·원자성 검사는 유지한다. stage wall time을 clone/Worker/storage로 분리하고 실제 플랫폼 게이트와 모델을 구분한다.

## Codec 작업별 응답 계약

[현재 근거](archive/STUDIO_CODEC_REPLY.md). runCodec은10개 operation의 envelope/profile/필수slot과 typed/profile-bounded 상태·래스터를 검증한다. fill은 own image:undefined만 정상NoOp로 구분하고 selection mask binary scan은 기존 yield owner가 맡는다. metadata layer count와4색상 own인덱스를 bounded하게 확인한다. timer/abort/terminate/active는한finally, malformed/error/messageerror는실패로합류한다. 공개signature/후보transfer/기존source epoch와history guard는유지한다. native첫timeout 원인·CRC후보비채택·실제플랫폼게이트는별도기록이다.
