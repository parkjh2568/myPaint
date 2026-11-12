> 과거 검증·설계 기록입니다. 현재 실행 방법은 [루트 안내](../../README.md)를 따르세요. 아래 수치는 기록 당시 환경에만 적용됩니다.

# Qt·Studio 공통 코어 fixture — QF-03 진행

2026-11-06. [입력·소스·실행·독립 검토 근거](../evidence/studio-matched-core.json). QF-03의 **같은 입력·operation 경계**를 코어 API 네 종류에서 고정하고 실제 두 구현을 검증했다. 전체 QF-03·성능 예산·물리 장치·출시 인수는 미완료다. 제품 소스와 payload는 [QF-04](../STUDIO_DOCUMENT_CONTRACTS.md) 그대로다.

## 같은 입력과 다른 구현을 구분

[고정 명세](../../web-app/tests/fixtures/matched-core.json)는800×600×1,2048²×1,1536×2048×2의 RGB 프로젝트와 크기별 단일 흰색 plane을 정의한다. RGBA는 전부 alpha255다. 독립 Python 정수 계산으로7개 원본 plane과3개 빨강 출력 SHA를 먼저 도출했다. Node zlib/CRC와 직접 쓴 RPAINT01 레코드로6파일·37,681,237B를 생성했으며 제품 encoder를 기준 생성기로 사용하지 않았다.

Qt와 Studio는 각 파일의 **같은 전체 wire SHA**를 확인하고, 크기·active/background·레이어 이름/visible/순서와 숨은 레이어를 포함한 전체 canonical RGBA SHA를 대조했다. Qt 내부 ARGB/BGRA bytes는 직접 비교하지 않고 타이머 밖에서 RGBA로 변환해 stride를 지켜 해시했다. alpha0/반투명 표현 차이·모든 도구·최대 desktop 문서의 인수는 이 opaque fixture와 구분하며 [문서·알파 계약](../STUDIO_DOCUMENT_CONTRACTS.md)을 유지한다.

| 작업 | 공통 외부 계약 | 포함/제외한 비용 |
| --- | --- | --- |
| project-decode | 같은 RPAINT01 bytes→같은 완성 문서 | 메모리 decoder 호출. 파일 읽기·canonical 검증 제외 |
| project-encode | 같은 decoded 문서→같은 의미의 프로젝트 | 실제 production encoder. 파일 쓰기와 검증 decode 제외; 압축 바이트 일치는 요구하지 않음 |
| flood | 불변 단일 흰색 plane→독립된 전체 opaque-red 출력 | Qt는 shallow handle/공유 확인을 밖에 두고 production COW detach·출력 할당을 안에 둠. TS는 ROI 결과 할당 포함 |
| deep-copy | 모든 mutable pixel plane의 독립 복사 | Qt 각 `QImage.copy()`와 TS `cloneState`를 실제로 호출. 일반 Qt COW snapshot 비용이 아님 |

필수 픽셀과 metadata 검증은 매 warmup/측정 호출 뒤 타이머 밖에서 수행했다. source wire/plane의 불변성과 실제 출력 포인터·버퍼 분리를 확인했다. 호출자 output 해제는 밖이지만 callee 내부 RAII와 자연 GC는 호출 시간에 포함될 수 있다. 검증 자체가 다음 표본의 캐시·GC에 영향을 줄 수 있으며, 서로 다른 런타임의 기계적 비용을 동일하다고 주장하지 않는다.

Qt는 현재 native `QImageWriter` PNG 기본 설정이고 Wasm compression0 분기가 아니다. Studio는 fflate zlib level1이다. 출력 파일 크기는 다를 수 있으며, 최종 representative3파일씩을 상대 엔진으로 읽어 같은 독립 기대값과 대조했다. 매 encode 반복의 self-read 검사와 이 양방향 교차 검사를 구분한다.

## 실제 검증

| 검사 | 결과·범위 |
| --- | --- |
| 독립 기준 재현 | Python check7plane/6fixture 통과. 포맷 전·후 spec SHA는 각각 보존하고 parsed 값 동일 확인 |
| Qt native 코어 | 정확12작업, warmup12회·측정36회 모두 검증. Release Core/Gui 프로브, GUI 실행 아님 |
| Studio Node 코어 | 같은12작업, warmup12회·측정36회 모두 검증. Node24 actual engine/format/operations, 브라우저 Worker 아님 |
| 교차 읽기 | Qt→Studio3개, Studio→Qt3개 전체 픽셀·metadata 일치 |
| 잘못된 입력·소유권 | duplicate operation/변조 wire/40MiB 초과 입력을 두 probe가 거부. 기존 Qt/Studio 결과와 producer 출력 재사용도 거부; 총9control |
| 예산 소진 | 두 backend의1000ms soft budget 실패에서 기존 warmup/표본 보존. Qt21attempt/Node8attempt가 남았으며 전체 성공으로 기록하지 않음 |
| 포맷·타입·빌드·기존 회귀 | CTest6그룹·타입·JS/C++포맷·로컬 build 통과. 초기 새 Qt 옵션 생성자의 컴파일 오류는 QString 타입 명시로 해결했고 최종 Release 빌드는 경고 없이 통과 |

입력 집합을 row12개로만 판정하던 검사 빈틈은 독립 리뷰에서 찾았다. 중복 decode로 deep-copy 누락을 숨길 수 있어 canonical spec SHA와 모든 case/operation 배열을 먼저 대조한다. 오류 control에서는 측정행이0이며 정상 결과로 합산하지 않았다. 읽기는 descriptor와 byte cap을 사용하고 출력은 독점 생성한 새 run directory 안에서만 만든다. Qt QSaveFile은 그 소유 디렉터리의 원자 교체이며 일반적인 공격적 filesystem no-overwrite API가 아니다.

실행 순서는 Qt block→Node block→Qt cross→Node cross였다. 각 프로세스에120초 외부 제한을 두고 내부 soft budget90000ms를 적용했다. 실제 명령·cwd·시작/끝 load와 종료 코드를 보존했다. 동시 벤치/빌드는 실행하지 않았으며 다른 데스크톱 앱 부하는 통제하지 않았다. Qt와 Node의 전체 elapsed 시작 경계는 다르므로 그 값으로 backend 향상률을 계산하지 않는다.

## 관측치와 한계

아래는800×600 입력의 p50 wall ms(각n3)이며 동작·측정 방법 검증의 진단 표본이다. p95/p99도 원문에 있지만 n3에서는 최대값이다.

| API | Qt native | Studio Node |
| --- | --- | --- |
| decode | 7.549 | 89.907 |
| encode | 92.374 | 120.909 |
| forced deep-copy | 0.036 | 0.164 |
| immutable-input fill | 1.125 | 12.063 |

이 표는 cold/hot·순서·반복 cohort를 통제한 성능 비교나 앱 전체 지연의 증거가 아니다. 특히 Qt/Node 런타임·PNG 정책·GC/RAII·allocator가 다르다. decode/fill의 관측 차이는 후속 profile 가설을 정할 자료이며 root cause나 교체 권고로 확정하지 않는다. Qt native 결과를 기존 Qt/Wasm UI의 분모로 사용하지 않는다.

[직전 측정기 방법 검증](STUDIO_MEASUREMENT_METHOD.md)의 UI sync-prefix·첫 Canvas command proxy와 이번 코어 API도 다른 population이다. pointer→유효한 표시·물리 photon·실기기·WAN cold startup·snapshot/codec/storage/native I/O·IDB·peak RSS/GPU·장기 사용 예산 인수는 남아 있다. Android 모델/OS/Chrome 답변도 여전히 대기 중이며 adb는 이전 확인 위치에서 없었다.

## 다음 작업과 재현

다음은 같은 fixture의 decode/fill을 Node와 실제 shipped Worker에서 CPU profile해 압축 해제·CRC·PNG sample/unfilter·할당/GC 비용을 분리하는 일이다. 기존 raw RGBA/알파·malformed PNG/프로젝트 한도와 취소·20초 제한을 유지한 채 병목이 확인된 부분만 후보로 만든다. 프로파일 계측과 비계측 표본은 분리하고 같은 입력/검증/소스 대조로 후보를 평가한다. 공통 실제 UI trace와 대상 기기별 반복/tail·예산 확정도 계속 진행한다.

[실행 안내](../../web-app/tests/fixtures/matched-core-README.md)에 새 디렉터리 생성·fixture 생성·양쪽 probe·교차 읽기 명령을 정리했다. 생성한 대용량 fixture/encoded outputs는 `build-web-work` 검증 산출물이며 웹 bundle에 넣지 않는다. 모바일/태블릿은 웹만, 실행파일은 Windows/macOS만 제공한다. 홈페이지 쓰기·commit/push·공개 배포는 하지 않았다. QF-03과 전체 목표는 계속 진행 중이다.
