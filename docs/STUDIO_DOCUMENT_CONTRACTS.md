# 문서·알파·비동기 확정 계약 — QF-04

2026-11-06. QF-04 원문의 설계 계약을 현재 구현과 대조한다. [독립 기준 목록](STUDIO_FIXTURE_BASELINE.md)의 입력·예상값을 사용하며, 전체 도구 옵션·플랫폼·성능·출시 인수는 각 태스크에 남긴다. 검토·재현·최종 판정은 [근거 JSON](evidence/studio-document-contracts.json)에 기록한다.

## 문서와 파일

엔진의 권위 데이터는 `Uint8ClampedArray`의 straight RGBA8이다. `State`는 width/height/background/active/layers, 레이어는 name/visible/pixels를 소유한다. 프로필·revision·이력·선택·문자·스킨은 RPAINT01에 추가하지 않는다. [파일 형식](FILE_FORMAT.md)의 28바이트 header와 아래→위 레이어 순서를 유지한다. 컨테이너 정수는 little-endian이고, 내부 PNG의 정수·CRC는 PNG 자체 규칙을 따른다.

| 경계 | 고정한 의미 | 현재 소유 코드·독립 기대값 |
| --- | --- | --- |
| 새 그림 | 기본은 흰색 `[255,255,255,255]`; 투명 선택은 `[0,0,0,0]`로 픽셀과 문서 바탕 초기화 | `createState`, Studio `new`; `core.test.ts`, 공개 browser 새 문서 항목 |
| 기존 프로젝트 | background QRgb·active·레이어 이름/visible/순서·완성 픽셀을 읽는다. 불투명 문서를 자동 투명화하지 않는다 | `decodeProject`; `format-compat.test.ts` 독립 wire, `qt-project.json` 실제 Qt producer |
| 원시 PNG·프로젝트 레이어 | `encodePng/decodePng` 및 프로젝트 각 레이어는 alpha0의 숨은 RGB까지 보존한다. Canvas readback을 저장 경로로 사용하지 않는다 | `format.ts`; PNG 독립 producer의 type/depth/filter/Adam7 값, `profiles.test.ts` raw 보존 |
| 합성 PNG 내보내기 | 보이는 레이어를 합성한 새 이미지다. 완전 투명한 합성 결과는 `[0,0,0,0]`일 수 있다. 프로젝트에 저장된 레이어 RGB를 바꾸지는 않는다 | `composite` → Worker `png-write`; 공개 export atlas의 투명 셀 literal |
| Qt 표시 표현 | Qt의 premultiplied 표현과 비교할 때 alpha 및 다시 premultiply한 채널을 대조한다. 이를 새 straight RGBA 저장의 허용 오차로 사용하지 않는다 | `core.test.ts` Qt 소비자와 별도 exact raw roundtrip |

읽기는 크기·레이어 합계·이름·visible·PNG 범위/CRC·치수·최종 길이를 확인한 후보가 완성된 뒤 교체한다. 파일 프로필은 웹 40MiB/레이어20MiB/4Mi pixels/총6Mi, 설치형 300MiB/레이어140MiB/32Mi pixels/총64Mi를 따른다. 둘 다 16레이어이며 최대 변 길이는 각각4096/32768이다. 프로필을 파일에 저장하지 않는다.

기존 파일 형식 설명의 “웹 writer는 무압축 PNG”는 레거시 Qt/Wasm과 Studio를 구분하지 않았다. Qt/Wasm의 compression 0과 Studio의 zlib level 1로 경로를 명시했다. 압축 바이트가 같아야 한다는 계약은 추가하지 않는다.

## 색상·바탕의 역할

| 값 | 쓰이는 곳 | 바뀌지 않는 것 |
| --- | --- | --- |
| 문서 background | 단일 레이어 clear/선택 원본 삭제의 Source RGBA, 캔버스 확장 시 layer0의 새 영역 | 이미 칠한 픽셀과 UI 보조색 |
| 다중 레이어 clear | 활성 레이어/선택 원본 mask 안에 RGBA0 직접 대입 | 다른 레이어와 mask 바깥 원본 |
| foreground/secondary | 새 그리기·문자·도형, 보조 버튼과 옵션의 색 | 문서 background와 파일의 기존 픽셀 |
| 체커보드·스킨 | 투명도를 보여 주는 화면 표시 | 문서 alpha·PNG·프로젝트 |
| JPG/BMP matte | 보이는 합성 픽셀을 마지막에 불투명 바탕으로 합성 | PNG의 alpha와 편집 문서 |

확장에서는 기존 원본 영역을 raw 복사하고, 새 layer0만 문서 background로 채우며 나머지 레이어의 새 영역은 RGBA0이다. 붙여넣기의 원본 없는 선택은 원본을 지우지 않는다. 이미지 파일을 가져오면 지우기·확장 바탕은 흰색으로 두면서 실제 이미지의 투명 픽셀은 유지한다. “바탕 변경”은 문서 metadata 변경이며 기존 그림 전체에 색을 덮는 동작이 아니다.

## 합성·반올림·출력 값

보이는 레이어를 아래에서 위로 처리한다. source/destination alpha를 각각 `a`, `b`(0~1)라 하면 `outAlpha=a+b*(1-a)`, straight 채널은 `round((source*a+destination*b*(1-a))/outAlpha)`이며 alpha는 `round(outAlpha*255)`다. 이 결과를 **레이어마다 8비트로 반올림**한다. alpha0 source는 건너뛴다. `round`는 이 비음수 범위에서 JavaScript `Math.round`다. 한 번에 모든 레이어를 합산한 뒤 반올림하는 정책과 다르다.

아래 값은 기존 공개 export atlas의 독립 유리수 계산 literal을 따른다. 제품 함수를 expected 생성기로 쓰지 않는다.

| 입력/조건 | PNG 합성 RGBA | matte `[37,59,61]` 뒤 BMP RGBA |
| --- | --- | --- |
| 숨은 RGB만 있는 투명 레이어들 | `[0,0,0,0]` | `[37,59,61,255]` |
| 빨강 alpha1 | `[255,0,0,1]` | `[38,59,61,255]` |
| 흰색 alpha128 | `[255,255,255,128]` | `[146,157,158,255]` |
| 아래 빨강128, 위 파랑128 | `[85,0,170,192]` | `[73,15,143,255]` |
| atlas의 세 레이어 마지막 셀 | `[115,128,55,169]` | `[89,105,57,255]` |

JPG/BMP는 합성한 채널에 `round(channel*alpha + matteRGB*(1-alpha))`를 적용하고 alpha를255로 만든다. matte 인자의 RGB를 불투명 바탕으로 사용하며 그 인자의 alpha를 다시 합성하지 않는다. UI 바탕색 입력은 alpha255다. 기본 matte는 흰색이다. PNG에서는 matte를 적용하지 않는다.

BMP는 54바이트 header, 32비트 BI_RGB, 양수 높이의 bottom-up BGRA이고 각 출력 alpha는255다. JPG는 같은 불투명 후보를 jpeg-js quality95로 인코딩한다. JPG는 손실 형식이므로 원본 채널과 byte-exact를 요구하지 않는다. 기존 Node 검사는 실제 배포 Worker handler를 Node channel에서 호출하고 jpeg-js로 인코드·디코드했다. 균일 matte의4096²/32768×1 검증값은 디코딩한 처음·마지막 채널 오차≤3/alpha255이며, 이를 브라우저 Worker 실행이나 모든 사진·glyph의 전수 오차 상한으로 확대하지 않는다.

PNG writer는 RGBA8/non-interlaced/filter0과 CRC를 쓰며, reader는 기존 독립 type/depth/filter/Adam7 범위를 유지한다. 낮은 bit depth·16비트 샘플은 `round(sample*255/(2^depth-1))`로8비트화한다. tRNS 비교는 축소 전 원래 샘플로 수행한다. 원래8비트 RGBA의 alpha0/1/128/255를 표시 premultiplication 오차 때문에 완화하지 않는다.

## 후보·이력·비동기 소유권

`revision`과 `savedRevision`은 고유 상태 ID다. Undo cursor나 이력 길이를 saved 판정에 사용하지 않는다. NoOp·검증/할당 실패·취소는 확정 상태와 기존 Redo를 보존한다. 상태 변경과 이력 등록을 끝낸 뒤에만 새 ID로 확정한다. 이력 예산 가지치기로 ID를 재사용하지 않는다.

`prepareState`는 원본·Redo를 바꾸지 않고 후보·복사한 after-image·이력을 준비한다. `installPrepared`는 owner/revision/cursor/history identity/budget/active/next ID와 후보 내용이 그대로인지 검사한 뒤 한 번 설치한다. 즉시 `commitState`는 같은 준비를 동기적으로 설치한다. pending 선택·문자는 확정 문서와 별개이며, 바깥 저장/교체 대화상자 취소와 pending 자체의 Escape 취소를 구별한다.

| 비동기 경계 | 확정 또는 폐기 조건 |
| --- | --- |
| Worker | 소유한 후보/입력만 transfer. 응답 profile·결과 shape/typed pixels·한도 확인. 취소·오류·20초 timeout 뒤 Worker/timer/listener 해제 |
| 문서 교체 | native activation 성공이 commit point. 그 뒤 늦은 cancel로 native/UI 소유권을 나누지 않고 reset·epoch/key를 함께 갱신 |
| 프로젝트 저장 | revision/epoch 및 native 저장 receipt 뒤 state/active를 재검사. 성공한 현재 후보만 설치·markSaved. 취소/실패는 pending과 Redo 보존 |
| 웹 다운로드 | 파일 준비/다운로드 요청은 실제 저장 완료가 아니다. 편집 문서·savedRevision·pending을 유지 |
| 이미지 내보내기 | dialog 중 문서/pending signature를 확인하고 출력 후보만 생성. 원본·이력·pending을 확정하지 않음 |
| 자동 복구 | 확정 revision의 복사본만 transfer. epoch/revision 재검사와 storage commit 성공 뒤 recoveredRevision 표시 |
| 복구 목록 | 조회 중복은 recoveryOpening으로 막고 finally 해제. 성공·오류 모두 조회 epoch가 현재 문서인지 확인 |

이 표는 정상적인 공개 소유권 경계다. Worker/IPC 모형의 오류 주입을 실제 OS 장애·자연 발생으로 부르지 않으며, numeric revision과 공개 dirty/Redo 관측도 구분한다.

## 이번 감사와 남은 게이트

현재 source와 독립 예상값·유지 실행 근거를 원문의13개 세부 조건에 대조했다. Architect·Reviewer·SRE의 독립 검토와 아래 재현/수정 검증을 통과한 QF-04 설계 계약을 완료한다. QF-02 선행도 충족한다. 기존 자체 입증7/부분25/미구현2 집계는 같고, 선행까지 닫힌 항목은 QF-01/QF-02/QF-04다. QF-03과 그에 의존하는 빌드/엔진·성능/출시 인수를 자동 완료하지 않는다.

Minor 1건을 수정했다. A의 수동 복구 목록 조회를 hold하고 B를 활성화한 뒤 A 조회를 reject하면, catch에 epoch 검사가 없어 B의 “프로젝트를 저장했습니다”가 A 저장소 오류로 바뀌었다. 문서/픽셀을 바꾸는 경로는 아니지만 오류의 소유 문서가 틀렸다. 현재 epoch가 다르면 catch에서 즉시 return하는 한 줄을 추가했다. outer finally는 그대로 실행돼 다음 조회를 허용한다. helper·의존성·IPC·형식 변경은 없다.

| 이번 실행 | 결과·실제 범위 |
| --- | --- |
| 수정 전 재현 | 새 회귀 항목의 상태문구 assertion 실패. 이전 항목들은 실행됐고, 첫 실패 이후 항목은 실행되지 않았다. 기대값을 완화하지 않았다 |
| 수정 후 저장/복구 | 16개 통과. 공개 Chromium UI·실제 코덱 Worker와 native IPC/파일 메모리 모형. B의 status/title/세대·전체 문서·saved Redo/재생·다음 목록 조회 확인 |
| 복구 조회 흐름 | 7개 통과. 같은 문서의 list/read 오류는 계속 표시되고 cancel/error 뒤 guard 해제, 시작/수동 중복 조회의 기존 계약 확인 |
| 내보내기/미리보기 | 12개 통과. 독립 literal+PNG/BMP reader로 알파/반올림/바탕/레이어순서·pending·실패/취소·390px Classic98·큰 문서의 작은 preview 검증. 실제 JPG 디코딩 픽셀 검사는 이 묶음에 포함하지 않음 |
| 타입·포맷·로컬 build | 통과. 현재 entry `assets/index-DIgO41Ne.js`, payload9개/291,664B. 전체 runtime17개 중 main의 epoch guard 한 줄만 변경 |
| 유지한 기준 | 이전 Node324와 Qt producer의4173B wire/두3072B RGBA plane 검증을 각각 소스·범위에 맞춰 재사용. 이번 새 Node/Qt 실행으로 세지 않음 |

이 회귀는 기존 CI의 `test:native-persistence`에 포함돼 이후 누락을 감지한다. 앱 런타임에 원격 로그·텔레메트리·별도 알림 계층을 추가하지 않았다. 테스트의 hold/reject·가상32ms는 결정적 IPC 모형이며 실제 OS 장애 타이밍·물리 입력 검증이 아니다.

이번에는 native 앱을 다시 빌드하거나 GUI를 재실행하지 않았다. 앞선9f01 macOS4단계 통과는 epoch guard 이전 제품의 근거로 유지한다. 120초 smoke 미완료의 실패 단계·원인 미확정과 이전20초 `project-read-large` 관측도 남긴다. 홈페이지 쓰기·commit/push·공개 배포는 수행하지 않았다.

후속 [최신 소스 macOS 앱 재검증](STUDIO_NATIVE_CURRENT.md)에서 이 guard를 포함해 다시 빌드한 앱의 일반4분기가 통과했다. 이는 아래 Chromium 모형의 특정 late-list-rejection 경합을 실제 OS에서 재현했다는 뜻은 아니다.

전체 Android 웹/Windows·OS picker/IME/clipboard·물리 펜·전체 옵션·장시간 메모리·성능 예산·서명/배포 승인은 이 설계 계약의 완료와 별개다. 이전 macOS 바이너리의 통과와 현재 웹 후보 검증의 소스 범위를 각각 명시한다. 모바일/태블릿은 웹, 설치형은 Windows/macOS만 지원한다.
