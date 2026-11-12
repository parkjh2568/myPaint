> 과거 검증·설계 기록입니다. 현재 실행 방법은 [루트 안내](../../README.md)를 따르세요. 아래 수치는 기록 당시 환경에만 적용됩니다.

# 최대 문서 편집·표시 성능과 PNG 호환성 검증

2026-11-05. 모바일·태블릿은 웹만, 설치형은 Windows/macOS만 대상으로 한다. 이번 단계는 최대 문서의 실제 병목과 파일 오류를 수정한 기록이다. **초기 표시·다층 1:1 표시·일부 동기 작업의 인수는 아직 끝나지 않았다.** 전체 전환 완료로 표시하지 않는다. 코드/번들 해시와 표본은 [이전 최대 문서 근거](../evidence/studio-max-document.json)와 [후속 최종 화면 통합 근거](../evidence/studio-scene-integration.json)에서 구분한다.

## 실제 원인과 변경

| 문제 | 확인한 원인 | 변경 |
| --- | --- | --- |
| 이름만 바꿔도 대형 문서 전체 복사 | 일반 candidate/history snapshot을 메타데이터에도 사용 | 이름·표시·바탕·순서용 `editMetadata`와 정수 순열 이력. 픽셀 참조를 이력에 넣지 않음 |
| 준비 후 바뀐 candidate가 잘못 설치될 수 있음 | 지연 `installPrepared`가 revision/active만 검사 | 설치 전 유효성·captured snapshot 동등성 검사. 즉시 편집은 한 동기 호출의 `commitState`로 중복 검사를 피함 |
| 흰 바탕 초기화·canvas 확장이 수백 ms 소요 | 픽셀마다 작은 `set()` 호출 | native endian을 따르는 32bit word fill. 투명 픽셀의 숨은 RGB도 유지 |
| 자르기·병합·반전 등이 UI를 오래 점유 | 픽셀별 복사/합성을 UI에서 실행, 소유 candidate를 `doc.edit`가 다시 복사 | 자르기는 행 복사, 큰 연산은 Worker. 이미 소유한 candidate를 원자적으로 확정 |
| 매 축소 프레임에서 306개 타일 업로드 | 64개 cache보다 큰 가시 작업량이 LRU를 계속 밀어냄 | frame의 실제 가시 raster 수와 예산에 맞는 축소 단계 선택, 모든 source 기여를 포함한 premultiplied box 평균 |
| 획 종료·취소·Undo에서도 전체 타일 재생성 | `draw(true)`와 사라진 stroke dirty 정보 | 픽셀 배열별 변경 영역을 다음 frame까지 유지. 숨긴 레이어 cache는 반환해 재표시 잔상 방지 |
| 클립보드 경계의 중복 복사 | 이미 분리한 candidate를 다시 export snapshot으로 복사 | 소유 raster를 PNG Worker로 직접 transfer. 실패 시 Worker를 중단하고 원본을 유지 |

일반 `edit`의 독립 candidate·이력 계약은 유지했다. Metadata 경로는 pending 선택/문자/도형이 없을 때만 사용한다. pending이 있으면 기존 후보 합성과 성공 후 확정 경로를 사용해 실패 시 편집을 잃지 않는다. 지연 저장의 `prepareState/installPrepared` 검증도 유지한다.

크기 대화상자·회전/반전·기울이기의 선택 변형은 원본 raster를 보존한 채 Worker에서 계산하고, 문서·selection·pixels·epoch·revision·active가 같을 때만 적용한다. **드래그 핸들로 선택 크기를 조절하는 실시간 경로는 아직 동기 연산이다.** 모든 선택 조작이 Worker로 옮겨졌다고 해석하지 않는다.

## 최대 크기에서 측정한 결과

핵심 비교 문서는 8192×4096, 두 레이어, aggregate 64Mi pixels다. 권위 RGBA만 256MiB다. Node CPU 표본은 순차 실행 3회이며 아래 p95는 사실상 해당 표본의 최댓값이다. 통계적인 실제 사용자 p95·펜 지연이나 전체 프로세스 RSS를 뜻하지 않는다.

| 측정 | 변경 전 | 변경 후 |
| --- | ---: | ---: |
| 메타데이터 편집 CPU p95 | 약 110ms | 0.285ms |
| 메타데이터 편집 후 문서+이력의 reachable pixel buffer | 768MiB | 256MiB |
| 메타데이터 3회 이력 | 큰 구조 snapshot | 약 286B 회계, pixel buffer 0개 |
| 상수색 32Mi 이미지 생성 p95 | 627.66ms | 11.19ms |
| canvas 확장 p95 | 680.11ms | 27.10ms |
| 측정한 자르기 후보+commit p95 | 기존 UI와 동등한 경로 1267.13ms | 실제 clone+`cropState`+원자 commit 23.85ms |

자르기 비교는 매회 8192×4096×2의 새 문서에서 시작하고 입력/출력 SHA가 같은지 확인했다. 같은 표본의 slice 복사량은640MiB에서384MiB로 줄었다. 전체 앱 속도 개선률로 확대 해석하지 않는다.

일반 구조 편집은 여전히 전체 snapshot을 만들며 상황에 따라 reachable 768MiB를 유지한다. 단일 큰 이력 항목을 예산보다 커도 보존하는 기존 정책도 바꾸지 않았다. 위 메모리 감소는 메타데이터 전용 경로의 결과이며 모든 편집이나 앱 RSS가 같은 비율로 줄었다는 뜻이 아니다. 회전 CPU는 해당 표본에서 약 2.44초이며 Worker에서 실행되고 취소 시 원본을 보존했다.

Chrome의 고정 번들에서 실제 입력·표시와 변경 영역 업로드도 관측했다. 측정용 snapshot은 내부 함수 시간과 reachable buffer를 계측하며, 제품 번들에 계측 기능을 추가하지 않는다.

- 반복 렌더는 약 110–116ms에서 1.5–2.4ms로 줄었고, 정적 metadata/순서 변경 프레임의 `putImageData` 요청은 약 266MiB에서 0이 됐다.
- 최대 문서의 작은 획 완료는 약 0.036–0.077MiB, Undo/Redo는 약 0.012–0.026MiB만 갱신했다. 이것은 API에 요청한 RGBA 영역 합계이며 실제 GPU bus 전송량이 아니다.
- 별도 공개 UI 회귀의 1024² 문서는 마지막 mouseup 업로드가 4,260,096바이트에서 270,400바이트로 줄었다. 마지막 위치의 실제 canvas 색, Undo/Redo 전체 픽셀, 두 손가락 취소·숨긴 레이어 재표시의 잔상 부재를 함께 확인했다.
- 최대 문서 crop의 관측 long task 최댓값은 약 1419ms에서 70ms로 줄었다. Merge·작은 획·Undo/Redo에는 해당 표본에서 50ms 이상 long task가 관측되지 않았다. CPU 작업 시간이 0이라는 뜻은 아니다.
- 최초 표시를 포함한 동기 render는 해당 표본에서 흰 그림 93.2ms, 두 번째 레이어 추가 465.2ms였다. 이 값은 mip 순수 CPU만 분리한 시간이 아니다. 별도 계측에서도 UI long task 117/466ms와 RAF gap 116.7/533.3ms가 관측됐다. **UI 응답성 게이트는 미완료다.** 전환 계획의 50ms는 전체 이미지 준비 시간 상한이 아니라 UI long task 제거 목표이며, 입력→다음 유효 표시와 대기 큐는 별도 기준으로 유지한다.

축소 첫 셀을 복사하며 만들던 작은 typed view는 비교 fixture에서 132,355개에서 0개가 됐고 표시 픽셀 SHA는 같았다. CPU 표본의 중앙값이 흔들려 이 변경만의 확정 속도 개선률은 주장하지 않는다.

## 추가 동작 계약 회귀

복합 마우스 입력도 실제 CDP 이벤트로 대조했다. 왼쪽 획 중 가운데 버튼을 누른 채 왼쪽을 먼저 놓으면 브라우저는 최종 `pointerup` 대신 `pointermove(button=0,buttons=4)`를 전달한다. 기존 pointer ID만의 추적은 가운데 버튼 이동에도 잉크를 이어 그렸다. 시작 버튼의 mask를 추적해 해당 버튼이 해제되는 순간 마지막 위치를 처리하고 획을 종료하도록 수정했다. 왼쪽/가운데, 왼쪽/오른쪽, 오른쪽/왼쪽 해제 순열과 새 제스처·Undo/Redo, 사각형/직선의 같은 위치 Shift release를 영구 회귀 7개로 확인했다.

`historyBudget`도 Qt의 즉시 가지치기 계약으로 복원했다. Undo 앞쪽부터, 이후 먼 Redo부터 줄이고 현재 pixels/revision/saved ID를 유지한다. 음수 정수는 0으로 clamp하며 잘못된 수는 변경 전에 거부한다. 가장 가까운 한 항목 자체가 예산을 넘는 기존 예외는 유지한다. 4096개 경계, Undo 위치, 정책 복원 후 오래된 prepared의 이력 재도입 거부 등을 10개 회귀로 확인했다.

같은 이름·같은 RGBA를 가진 두 레이어도 명시적인 순서 변경은 이력과 dirty를 유지해야 한다. 실제 Qt의 `reorderedIdenticalLayers`와 새 코어의 추가 회귀 4개를 비교해 Undo/Redo·saved revision, active 값이 같은 순열, 비이력 active 선택과 이력 active 후보, 선택 이후 지연 후보 거부/Redo 보존을 확인했다. 이 범위는 기존 구현이 계약을 지켜 제품 변경 없이 테스트만 추가했다. 그 단계의 전체 Node 회귀는 111개다.

## 표시 품질과 자원 소유권

1:1과 확대는 원래 픽셀 경로를 사용한다. 축소는 예산에 맞는 power-of-two mip를 사용하되 단순 최근접 샘플로 가는 선을 버리지 않는다. 평균은 premultiplied 색/알파로 계산하고, 홀수 크기 마지막 셀은 실제 기여 수로 나눈다. 원본 extent를 넘겨 그리지 않는다. 변환 preview는 임시 행 사본에만 적용하며 권위 RGBA를 수정하지 않는다.

Surface 최대 축 512, global cache 64개, ImageData+Canvas 추정 RGBA와 mip scratch의 128MiB 예산을 유지한다. 할당 실패 시 부분 타일과 scratch를 반환하고 다음 시도에서 정상 복구한다. 이 회계는 브라우저/GPU 내부 복사나 전체 프로세스 메모리 상한이 아니다.

이름/표시/순서 변경으로 만들어진 새 Layer wrapper는 cache 식별자가 아니다. 실제 pixels 배열을 식별자로 사용한다. 획 완료 뒤 dirty 정보가 사라져도 마지막 dab을 표시하고, 취소에서는 이전 frame에 그린 영역까지 복원한다. Frame 완료·전체 교체·오류에서 임시 dirty 참조를 해제한다.

통합 전에는 2048²×16 문서와 1072×944 viewport의 가시 타일 96개가 64개 cache를 넘었다. 변경 없는 재표시에도 96개 재업로드/퇴출과 100,499,520바이트 업로드가 발생했다. 이를 줄이기 위해 기존 Canvas가 배경까지 합성한 불투명 최종 화면을 보관하는 방식을 검토했다. 아래 시제품 수치는 당시의 독립 실험이며, 실제 제품 통합 결과는 다음 절에서 구분한다.

후속 [분리된 scene cache 실험](../evidence/studio-scene-prototype.json)은 실제 제품 통합 전의 설계 검증이다. 물리 배율 1에서 33개 기능·12개 측정 frame, Retina/물리 1.25·1.5·2·3에서 64개 기능·12개 측정 frame의 전체 RGBA가 비교 경로와 일치했다. 원본 256MiB RGBA 해시도 유지됐다. 비교 Canvas의 수명과 readback 순서를 맞춘 결과이며 원인이 입증되지 않은 CPU/GPU 차이를 사실로 단정하지 않는다.

Retina 2144×1888 시제품의 변경 없는 frame은 업로드 96회/100,499,520바이트에서 0으로 줄었다. 호출 중앙값은 130.30→0.50ms, render 구간과 일치하는 Long Task 관측은 9/9→0/9였다. 반면 최초 호출 중앙값은 140.50→175.30ms로 증가했고 Long Task 3/3이 남았다. 이 값은 SwiftShader Chrome의 3개 cold/9개 steady 표본이며 presentation/실제 펜 지연이나 제품 앱 개선률이 아니다. source+scene 최대 64개, RGBA 추정 125,449,328바이트와 surface 최대 512px를 유지했으나 브라우저/GPU 내부 메모리는 포함하지 않는다.

축소 상태에서는 source 예산을 64→58개로 줄이는 것만으로도 mip 단계가 2→4로 바뀌고 1,376,049개 채널이 달라졌다. 따라서 실제 통합은 물리 배율 1 이상, 원래 가시 source 작업량이 64개 초과, 모든 scene이 예산 안에 들어가는 경우로 제한했다. 축소·작은 작업량·예산 초과는 기존 source 예산과 mip 경로를 유지한다.

## 실제 앱의 최종 화면 캐시 통합

[통합 근거](../evidence/studio-scene-integration.json)는 배경 수정만 적용한 원본 source renderer, 1차 scene 통합, source 경계 정렬과 완전 적중 생략을 추가한 최종 후보를 각각의 소스·번들 해시로 구분한다. `FinalSceneCache`는 원래 레이어 순서와 알파 합성을 그대로 사용하고, 임시 선택 테두리·도형 표시 전에 불투명 화면만 캡처한다. main은 물리 backing 전체에 배경을 채워 분수 CSS 높이의 마지막 행에 이전 frame이 누적되던 문제도 수정했다.

Source와 scene은 합계 64개/추정 RGBA 128MiB, 각 surface 축 512px 제한을 공유한다. source 510px 경계를 화면에 투영하고 큰 셀만 분할한다. 변경 영역은 한 번 등록하며, 표시 화면에 없는 dirty도 source에 남긴다. pan·zoom·DPR·스킨·종이 범위·레이어 순서·선택 소유권이 바뀌면 재구성한다. 할당·캡처·크기 변경·중단 실패는 부분 자원을 해제한다. 정상 적중에서는 흰색·체커보드·source 반복 그리기를 생략한다.

실제 Chrome 행렬에서 정수 355 경계가 world 좌표 왕복 후 354.99999999999955로 변해 이전 source 행·열을 추가로 그리는 반례도 발견했다. Scene이 만든 정수 `deviceBounds`를 culling에 전달해 해결했다. 기존 `PixelRect` 호출과 mip는 기존 계산을 유지하며, 픽셀 샘플링이나 알파 연산에 임의 epsilon을 넣지 않았다.

최종 후보의 검증 결과는 다음과 같다.

- 타일 67건 중 필수 63건 통과, 기존 정보성 진단 4건 별도. 실제 좌표 왕복 반례, 510/1020 경계 dirty/rollback, 잘못된 경계 11종의 상태 보존을 포함한다.
- 원래 source renderer와 실제 UI의 DPR 1/2 전체 Canvas 56개 및 저장 출력 12개가 바이트 단위로 일치했다. 같은 Canvas 수명, 선택·획 확정/취소·Undo/Redo·레이어 변경·스킨·축소 fallback·캡처 실패 후 재시도를 포함한다.
- 실제 macOS release 앱의 복구·코덱·종료·렌더링 4단계가 통과했다. 렌더링 14개 화면과 권위 RGBA 보존, 최대 64개/111,436,096바이트, 변경 없는 frame 업로드 0회를 확인했다. Windows와 실기기 웹 검증을 대신하지 않는다.
- `test:scene-contract`는 private mirror에서 scene 재사용만 우회한 현재 source renderer와 비교하며 CI에 연결했다. 이 반복 검사는 source renderer 자체의 독립 oracle이 아니므로 위의 원본 기준 비교·타일 회귀와 구분한다.

대표 성능 비교는 M1 Pro의 Chrome/SwiftShader, 2048²×16, CSS 1072×910, DPR 1/2, 실제 물리 배율 약 1.047/2.093이다. 1차 scene 통합만으로 변경 없는 frame 중앙값이 원본 110.6/153.9ms에서 0.6/0.5ms로 줄었지만 DPR 1의 dirty 64개 재업로드가 남았다. 최종 후보와 1차 통합을 새로 비교한 표본은 다음과 같다.

| 구간 | 1차 통합 → 최종 후보 | 표본 범위 |
| --- | --- | --- |
| 변경 없는 호출 중앙값 | DPR 1: 0.6→0.1ms, DPR 2: 0.6→0.2ms | 각각 9회; 업로드 0 유지, fillRect 3467→1 |
| DPR 1 작은 획 이동 | 49.1→1.0ms; 64회/67,043,328B→2회/66,560B 업로드 | 단일 동작 표본 |
| DPR 1 획 확정·취소 | 129.6→1.1ms, 91.8→1.0ms | 각각 단일 동작 표본 |
| DPR 2 dirty 갱신 | 약 1.0~1.3ms와 2회 업로드 유지 | scene 캡처는 1→4회 증가 |
| 첫 카메라 무효화 호출 | DPR 1: 47.9→120.1ms, DPR 2: 29.6→622.8ms | 각각 1회; 불리한 표본도 그대로 보존 |

네 실행 모두 마지막 화면과 전체 RPAINT 출력 해시가 원본과 일치했다. Source+scene 추정 peak는 DPR 1에서 121,293,440바이트, DPR 2에서 99,478,016바이트였다. 호출 시간은 계측 비용을 포함하고 실제 GPU 전송량·RSS·Android 펜 지연·프레젠테이션 시간이 아니다. **최초 표시 성능은 미해결이다. 아래 반복 결과에서도 DPR 2 지연이 재현됐지만, 소수 표본으로 안정된 분포나 원인을 단정하지 않는다.**

추가로 같은 공개 UI 설정·카메라·viewport에서 버전별/DPR별 새 브라우저를 3회씩 교차 실행했다. 12회 모두 화면 해시가 기준과 일치했고, 각 cold 호출의 업로드는 96회/100,597,760바이트로 같았다. 원래 622.8ms 표본은 별도로 보존했다.

| DPR | 1차 통합 호출 중앙값 (범위) | 최종 후보 호출 중앙값 (범위) |
| --- | --- | --- |
| 1 | 49.7ms (42.1~65.1) | 39.6ms (31.7~42.3) |
| 2 | 84.6ms (31.1~196.2) | 237.0ms (193.3~714.1) |

각 칸은 3개 표본이다. DPR 2의 큰 지연이 반복돼 이번 후보의 cold 성능 게이트는 통과시키지 않았다. 다음 진단은 source 그리기·최종 화면 캡처·putImageData·surface/문맥/ImageData 할당의 동기 비용과 나머지 callback 시간을 분리한다. 호출에서 관측된 비용과 근본 원인을 구분하며 GC나 scene 정렬 자체를 근거 없이 원인으로 단정하지 않는다.

별도의 DPR 2 진단 1+1에서는 주요 Canvas API를 계측해도 33번째 source 그리기 뒤 약 508/549ms가 잔여 시간으로 남았다. 상태 API와 크기 setter까지 계측한 추가 1+1에서 후보의 593.1ms 호출 중 558.8ms가 main `context.restore()` 한 번 안에서 관측됐다. 같은 후보 표본의 화면 캡처 24회 합계는 0.4ms, width/height setter 합계는 0.8ms였다. **이는 지연이 노출된 API 위치이며 근본 원인의 확정이 아니다.** 당시 source cap에 도달하기 전이므로 앱의 LRU 퇴출을 직접 원인으로 단정하지 않는다. 계측 종류와 오버헤드가 다른 표본을 하나의 성능 분포로 합치지 않았다.

이 대형 문서는 256MiB 권위 픽셀의 모델 native 프로필을 Chrome/SwiftShader에서 실행한 것이다. 총 픽셀 6Mi/약 24MiB인 모바일 웹 한도와 다르며 실제 WKWebView 성능을 뜻하지 않는다. 다음 우선순위는 실제 macOS 앱 또는 하드웨어 렌더링이 확인된 경로에서 같은 cold 비용을 관측하고, 필요할 때 source 정렬·할당·상태 처리의 조건을 하나씩 바꿔 비교하는 것이다. 복잡한 비동기 표시나 cache 정책을 원인 확인 없이 추가하지 않는다.

모서리와 서로 떨어진 dirty 영역도 별도 과제다. API 실험에서는 한 bbox로 합친 변경 영역이 64개 또는 96개 source 업로드를 요구했다. 원본 경계 정렬만으로 모든 획 비용이 해결되지는 않는다. 다음 단계는 빈 영역 재합성 제거와 제한된 영역의 업로드를 각각 측정하는 것이며, 영역별 호출의 작업량과 한 frame 전체의 LRU 교체를 구분한다. Cold/mip 준비, 넓은 dirty, 실제 기기 입력·메모리·장시간 인수는 완료 표시하지 않는다.

## Metal 선택 환경의 후속 비교

도구 계약 수정 중 [별도 Metal 실험](../evidence/studio-tool-contracts.json)을 수행했다. Playwright 추가 args는 없고, 4개 새 Chrome의 실행 전/후 CDP 장치가 Apple M1 Pro/ANGLE_METAL·GraphiteDawnMetal이었다. 기존 옵션을 재현한 작은 capability 검사는 SwiftShader/GraphiteDawnVulkan을 관측했다. 개별 Canvas의 가속 지속이나 물리 입력 지연을 이 정보만으로 확정하지 않는다.

비교 대상은 1차 scene 통합과 색 교체 수정 시점의 source 경계 정렬 후보다. 이후 도형·무잉크·디코더 수정의 성능 수치로 재표기하지 않는다. 동일 2048²×16/256MiB 문서에서 전체 화면과 canonical 프로젝트 해시가 일치했다.

| 구간 | 1차 scene → 정렬 후보 | 해석 |
| --- | --- | --- |
| 카메라 무효화 cold | DPR 1: 32.7→32.4ms, DPR 2: 31.5→32.1ms | 각1회. 이 표본에서500ms 지연 미재현, cold tail 통과 아님 |
| 변경 없는 중앙값 | DPR 1: 1.2→0.2ms, DPR 2: 1.0→0.3ms | 각9회 |
| DPR 1 작은 획 이동/확정 | 22.8/22.5→1.0/1.2ms | 각 단일 동작, 업로드64/67,043,328B→2/66,560B |
| DPR 2 작은 획 이동/확정 | 1.5/2.0→1.9/2.0ms | 업로드2회 유지·캡처1→4. 개선 주장하지 않음 |

해당 측정 구간의 Long Task는 관측되지 않았고 최대64개/512축, source+scene RGBA 추정125,459,072바이트였다. 이전 불리한 SwiftShader 옵션 표본은 그대로 보존한다. 실제 WKWebView cold/mip·모바일·장시간·corner/disjoint 인수는 계속 미완료다.

색 교체의 별도 소스 계측에서는 4096² 대각선 후보 픽셀을 bbox16,777,216개에서102,244개(0.61%)로 제한했고 patch before6,160,384B/coverage1,540,096B를 관측했다. 반면32768×128의 얕은 선은 모든128px 이력 타일을 건드려 before16MiB/history32MiB다. 단일 전체 clone과 타일 granularity 비용을 구분하며 이 동시 기능 검사 시간을 성능 인증값으로 쓰지 않는다.

## PNG 호환성과 예외 처리

독립 wire fixture로 color type·bit depth의 합법 15조합, noninterlace/Adam7, 5개 필터와 투명도를 확인했다. 실제 Qt 6.12/libpng도 허용한 IDAT의 unused trailing bytes를 이전 decoder가 거부하는 문제를 재현했다. Pako 3.0.3의 공개 streaming API를 사용해 정확한 zlib checksum 끝에서 종료하고 trailing input은 PNG 규칙대로 처리한다. [PNG IDAT 규격](https://www.w3.org/TR/png-3/#11IDAT), [Pako Inflate API](https://nodeca.github.io/pako/classes/Inflate.html).

선언된 크기의 output buffer 하나와 64KiB 출력 chunk를 사용하며 overflow는 복사 전에 거부한다. PNG 청크의 CRC/순서·PLTE·tRNS를 먼저 검증한 다음 IDAT 범위를 다시 순회한다. 청크마다 view를 보관하지 않아 수백만 개의 작은 IDAT에서도 metadata 메모리가 청크 수에 비례해 늘어나지 않는다. checksum 오류·잘린 stream·gzip/dictionary·길이 초과는 거부한다.

8bit 이하 tRNS의 사용하지 않는 상위 비트는 규격대로 마스크하고, 16bit는 전체 sample을 비교한 후 RGBA8로 변환한다. [PNG tRNS 규격](https://www.w3.org/TR/png-3/#11tRNS).

추가 PNG 회귀는 38개다. 독립 검토에서 유효 7종·무효 4종, 4MiB inflate bomb의 출력 한도, 120,000개 빈 IDAT의 bounded metadata를 별도로 확인했다. PNG 인코더는 기존 fflate를 유지하며, Pako는 exact pin/lockfile과 MIT·zlib 고지를 포함한다. 비교한 동일 snapshot에서 decoder 변경은 JS 28,345바이트, gzip 8,536바이트를 추가했다.

## 네이티브 종료 시 데이터 보호

창의 닫기 요청만 가로채던 구현은 앱 전체 종료를 보호하지 못했다. 고정된 Tao 0.37.2/muda 0.20.0 소스와 실제 macOS 프로브에서 `app.exit`의 `ExitRequested`, Cmd+Q·Dock Quit의 `NSApplication.terminate:`가 서로 다른 경로임을 확인했다. 특히 macOS 기본 Quit은 창 닫기뿐 아니라 기존 runtime 종료 콜백도 우회했다. **미저장 그림 손실 가능성이 있는 P0**로 분류해 먼저 수정했다.

창 닫기와 앱 종료 요청은 현재 UI의 확인 절차를 공유한다. macOS에서는 기존 Tao delegate의 필드와 동작을 상속하는 동일 크기의 subclass로 `applicationShouldTerminate:`를 연결했다. 의존성 업그레이드 시 이 경계는 다시 검토해야 한다. 문서 활성화 성공 후에만 종료 보호를 켜므로 초기 준비 실패 상태에서는 앱을 닫을 수 있다. 종료를 승인한 뒤에는 화면 입력을 막고, 종료 IPC가 실패하면 다시 편집할 수 있도록 상태를 복원한다.

최종 macOS `.app`의 별도 quit 실행에서 runtime/native 두 경로 모두 미저장 그림·미확정 문자·작업 중 종료를 보존했다. 확인 대화상자가 열린 상태에서 반복 종료해도 같은 대화상자 한 개를 유지했고, 취소 후 문서 identity·revision·saved revision·RGBA·문자 값을 유지했다. 성공 marker는 종료 권한을 부여하지 않는다. 마지막 깨끗한 문서의 일반 승인 경로를 통해 실제 프로세스가 종료 코드 0으로 끝나는 것까지 확인했다. 실제 Cmd+Q 키 입력이나 Dock 클릭을 자동 조작한 결과는 아니며, 해당 메뉴가 호출하는 같은 AppKit 종료 메서드와 실제 WebView를 사용한 검사다. 별도 공개 UI 회귀는 종료 중 저장 선택기 취소·저장 쓰기 실패 후 문자/원본 파일/경로/Undo 보존과 재편집을 확인했다. 승인 후 종료 IPC를 지연시켜 입력 동결을 확인하고, IPC 실패를 주입한 뒤 실제 획·Undo·재저장이 가능한지도 검증했다. 이 세 실패 조합은 모델 IPC 검사이며 실제 OS 선택기·ENOSPC 결과가 아니다.

## 검증과 다음 우선순위

종료 보호 수정 전 8965 고정 번들에서 Node 107개, 기존 웹 UI 45개, bulk UI 16개, pointer 계약 7개, native 모델의 대형 문서 17개·저장/복구 12개가 통과했다. Renderer는 엄격한 비교 38개와 정보성 fractional 비교 4개를 구분한다. Opt-in 최대 core 6개 시나리오도 통과했다. 종료 보호를 포함한 8966 번들에서는 영향받는 기본 웹 10개·native 저장/복구/종료 15개, 타입·포맷을 재검증했다. 추가 F03 회귀를 포함한 전체 Node 111개와 Rust 16개·Clippy·rustfmt도 통과했다. 실제 macOS release 앱의 세 실행은 각각 64MiB 초과 파일 복구, 4096²/32768×1 코덱·렌더러·geometry·JPEG, 종료 취소/보존/승인을 확인한다. Qt fixture의 bytes·mtime·inode는 유지됐다. 각 snapshot의 해시를 분리해 기록하며 Android·Safari·Windows 실제 인수로 확대 해석하지 않는다.

재실행은 `npm --prefix web-app run test:bulk-edit`, `test:pointer-contract`, `test:tiles`, `test:native-profile`, `test:native-persistence`에 고정 정적 서버의 `PAINT_TEST_URL`을 전달한다. 최대 core 측정은 별도 `test:max-document`로 실행한다. 실제 native 검증은 호스트 빌드 후 `test:native-desktop`을 사용하며 파일 복구·코덱/렌더러·종료 보호를 각각 임시 root·비영구 WebView로 검사한다.

1. **P0 데이터 인수**: [기능 인수 추적표](../STUDIO_ACCEPTANCE_MATRIX.md)의 F05 16개 조합, F01/F07 clipboard payload, F03 동일 레이어와 도구별 공백을 닫는다. 테스트 개수를 전체 기능 동등성으로 간주하지 않는다.
2. **P1 표시/응답성**: 최초 mip 생성의 비동기 준비, 16개 레이어 1:1 작업량, 실시간 선택 resize, 큰 pending 합성·구조 snapshot/동일성 검사와 남은 70ms 작업을 다룬다. Worker로 옮길 때 원본 snapshot 복사와 메모리를 함께 회계한다.
3. **플랫폼/출시**: Android 실제 웹·Safari 웹·Windows 설치형, ENOSPC/OS 파일 선택기, 서명/공증/고지, 안전 manifest staging과 롤백을 검증한다. 로컬에는 ADB가 없어 Android 연결을 확인하지 못했으며 실기기 통과를 주장하지 않는다.

후속 [미확정 편집·clipboard 검증](../evidence/studio-pending-contracts.json)에서 F05 행렬과 F01/F07 성공 payload를 확인하고 pending Redo 우회를 수정했다. 이 문서의 성능 표본은 당시 source hash를 유지한다.

기존 Qt·홈페이지는 보존한다. 이 단계에서 commit/push/공개 배포를 수행하지 않았다. [전체 전환 백로그](https://github.com/parkjh2568/myPaint/blob/c10a29a397aa77bb946c84406fd661db747164c0/docs/QT_FREE_MIGRATION_TASKS.md)와 미완료 게이트는 유지한다.


프로젝트 디코더 후속 보완: 내부 PNG를 전부 할당한 뒤 outer 크기를 확인하던 경로에 IHDR 사전검사를 추가했다. 단독 PNG per-image 한도뿐 아니라 outer count×size의 aggregate 가정도 지킨다. CRC/전체 구조 검사는 생략하지 않는다. 자세한 before/after 할당 관측과 File adapter size/취소 경계는 [도구·입력 근거](../evidence/studio-tool-contracts.json)를 따른다. GIF/JPEG/BMP의 브라우저 디코더 내부 메모리와 프로세스 전체 RSS를 이 검사로 보장하지 않는다.


## GIF prefix의 응답성 측정

[GIF 후속 근거](../evidence/studio-gif-input.json)는 논리 화면만 검사하던 원본, 동기 first-descriptor 사전검사, 협력적 사전검사를 구분한다. 성능 비교 대상은 마지막 두 단계다. Node24.22.1/macOS27/M1 Pro의 같은 8개 입력 SHA를 사용했고, 실제 픽셀 디코딩 없이 Blob과 bitmap 진입 spy를 관측했다.

| 입력·구간 | 동기 사전검사 → 시간 예산 적용 | 해석 |
| --- | --- | --- |
| 빈 extension16MiB 무취소 scan | 약54→138~141ms | 전체 완료시간 증가 |
| 빈 extension 약 40MiB 무취소 scan | 약135~137→352~353ms | 양보의 비용을 포함. 전체속도 개선 아님 |
| 빈 extension 취소 12회 | native 진입 선행 → Blob/bitmap0 | timer 취소 반영4.25~5.48ms의 관측 표본 |
| payload255 경로 24회 | 추가 yield 0 | 빠른 scan에 강제 timer를 넣지 않음 |

수정 후 빈 목록의 무취소 실행 구간 최대 관측값은 5.81ms였고, Blob 복사를 포함한 전체 표본 최대 구간은 8.49ms였다. 4ms는 soft budget이며 브라우저 LongTask·물리 입력·Android hard deadline을 의미하지 않는다. 별도 준비한 WK timing prototype은 아직 적용/실행하지 않았다. 기존 readback/reference/hash를 timing batch 뒤로 분리한 후 현재 GIF smoke를 보존해 다시 검증해야 한다.


## 실제 WK 렌더 비용 분리와 단색 스캔 개선

2026-11-05. [WK 통합 근거](../evidence/studio-wk-render.json)는 준비된 임시 prototype을 현재 코드에 반영한 단계, 최초 계측 실패, 기준/최종 앱과 API 진단·8K 변형 앱을 구분한다. 앱 시작 500ms 복구 확인의 `run.finally`가 추가 draw를 예약해 첫 계측이 중단됐다. 입력 없는 실행의 실제 호출 stack과 동일 camera/owner를 기록하고, 검증 모드에서 이 작업을 750ms 준비 구간과 rAF drain으로 끝낸 후 target 문서를 설치했다. 일반 앱 시작에는 대기가 추가되지 않는다.

Timing은 production `Studio.render()`의 API 반환 시간이며, production Canvas-to-Canvas 캡처는 포함하고 추가 test readback/reference/hash는 뒤로 분리한다. `setupMs`에 startup drain과 16layer 사전 hash가 포함되므로 합산하지 않는다. Cold는 renderer cache empty를 뜻하며 OS/CPU/GPU cache cold를 보장하지 않는다. 계산한 `derivedPaperMatrix`, 실제 CSS/backing/DPR과 source SHA를 함께 기록했다.

| 작업·표본 | 관측 | 해석 |
| --- | --- | --- |
| 2048²×16 기준3fresh | cold 101/95/91ms; unchanged 27개 0~1ms | CSS952×718, backing1904×1436, DPR2. 기존 Chrome/Metal과 fixture/camera가 달라 향상률 비교 금지 |
| API control/profile 각1회 | control 117ms; profile 103ms 중 putImageData 55ms/96회, ImageData 생성 11ms/96회 | 요청100,499,520B. 내부GPU 전송시간으로 단정하지 않음. 미분해 32ms는 JS/GC 등으로 귀속하지 않음 |
| 8192×4096×2 기준→unroll 각3fresh | cold 361/345/343→286/272/271ms, 중앙값 약21.16% 감소 | white/raw-zero, mip4, 같은camera·replay4hash·원본SHA·요청량·30tiles/34,080,768B |
| 최종16layer 3fresh | cold 135/94/94ms; steady0~1ms | 135ms 표본을 보존. 중앙값만으로 tail 비퇴행을 주장하지 않음 |
| 추가교차 A/B·B/A·A/B | 기준111/96/95, 최종92/99/94ms | 모든검증·geometry·요청수·예산일치. 135ms 미재현은 p95/tail 인증이 아님 |

실제 API 진단에서 production `getImageData`는 0회였으며 final scene capture는 `drawImage`다. 큰 `restore` 지연은 이 표본에서 관측되지 않았다. 0ms는 1ms 양자화된 보고값이며 실제 무비용을 뜻하지 않는다. 최초 SwiftShader의 긴 `restore` 표본과 합치거나 그 원인을 이 결과만으로 결론내리지 않는다.

제품 변경은 uniform mip rect의 판정을 행 선형 인덱스·4word 검사와 0~3word tail로 바꾼 것뿐이다. 최초 불일치의 종료, alpha0 정규화, box 평균·반올림, transform/unaligned fallback, 원본·dirty·예산은 그대로다. 새 helper나 지속 캐시는 추가하지 않았다. 독립 작은 factor8 fixture11개는 raw 업로드10개와 원본owner 취소 upload 0, hidden RGB·저알파·마지막 픽셀·preview/rollback을 확인한다. 기존 67개를 포함해74개 필수 검사와 4개 정보성 기록이 유지됐다.

50ms UI blocking 목표는 여전히 미달이다. 다음 순서는 가시영역 밖 source 업로드/초기화 비용 검토, 대형 mip의 bounded 준비·취소/소유권/메모리 설계, 넓은 dirty와 장시간·실기기 인수다. 실제 표시 시각·펜 지연·전체 RSS는 이번 렌더 호출/논리 예산 검증으로 대체하지 않는다.


## 화면 밖 source 초기화·업로드 축소

2026-11-05. [후속 근거](../evidence/studio-viewport-tiles.json)는 이전 WK 측정과 분리한 새 기준/후보 교차 실험이다. 활성 scene에서만 전체 backing Canvas의 역변환 범위와 halo에 맞춰 ImageData를 줄였다. 원래 Canvas 크기·좌표·타일 격자를 유지하며, crop 범위가 달라지면 해당 owner의 source를 폐기한다. Canvas까지 줄인 첫 후보는 엄격한 픽셀 비교에서 실패해 채택하지 않았다. 축소·일반 fallback은 기존 경로를 유지한다.

| 실제 macOS WK, 2048²×16 | 기준 | 반영 후보 |
| --- | ---: | ---: |
| 초기 render 3회 / 중앙값 | 119·98·97ms /98ms | 85·83·84ms /84ms |
| 초기 putImageData 요청 | 100,499,520B | 44,374,848B |
| 대표 dirty 요청 | 10,466,304B | 7,353,344B |
| 초기 cache 논리 추정 | 111,436,096B | 83,373,760B |
| timing/replay 최대 cache 논리 추정 | 111,436,096B | 86,268,304B |

A/B, B/A, A/B 순서의 6회에서 화면·원본·기하·예산 검사는 모두 통과했다. 초기 중앙값 약14.29%, 요청량55.85% 감소다. 업로드 호출96회와 capture16회는 같다. GPU 전송량·RSS·물리 입력 지연 또는 tail 인증값이 아니며, 50ms 목표는 아직 미달이다.

고정 이전 renderer와 독립18/확장23 비교, 기존 필수74개를 통과하고 영구 회귀8개를 추가해 필수82개를 확인했다(기존 정보성4개 별도). 동일 owner의 두 위치, 화면 밖1px의 실제 보간 기여, ImageData 실패의 source 해제→호출자 scene 정리→재시도를 포함한다. Node166·기본 웹10·일반 빌드 macOS4단계도 통과했다. 최종 포맷 보정은 정규화 실행 코드와 배포자산8개가 동일함을 확인했으며, 계측 후보와 일반 빌드의 바이너리 해시는 구분해 기록했다.


## 최대 mip 준비의 다음 구현 경계

2026-11-05. [계획 원문](../../build-web-work/task-planning/pencil-tools/next-mip-plan/PLAN.md)의 bounded 준비를 UI4로 구현·승격했다. 현재 결과는 [통합 근거](../evidence/studio-bounded-mip.json)를 따른다. 위의 과거 271~286ms 렌더 관측은 그대로 보존하며 새 측정이나 순수 mip CPU 시간으로 바꾸지 않는다.

- 동기 draw와 cooperative prepare가 같은 cursor·픽셀 알고리즘을 사용한다. 최대 65,536개 source-pixel 진행 단위와 soft 4ms 예산으로 계산을 나누고 MessageChannel로 이어서 실행한다. 타일마다 rAF를 기다리던 첫 후보는 완성 시간 퇴행 때문에 채택하지 않았다. soft 예산은 할당·transform·Canvas API·최종 합성까지 선점하는 hard deadline이 아니다.
- 준비 중에는 이전 backing을 유지하며, Canvas save/clip과 scene target은 yield 밖에 둔다. 가시 raster 전체 준비 후 기존 순서로 한 완성 프레임을 공개한다. 직접 `render()`는 동기 drain이므로 이전 직접 API 계측과 새 UI 준비 시간을 혼합하지 않는다.
- dirty를 한 번 cache에 이관하고 이후 raw 변경·owner/문서·선택·카메라 변경은 준비를 취소한다. context loss·할당/업로드 실패·문서 교체에서 port/cursor/scratch를 반환하고 재시도를 허용한다. 미완성 화면 좌표로 그리기는 막고 화면 이동·확대·축소는 유지한다.
- building tile·scratch도 합계 64타일·128MiB 추정 RGBA·512축 안에 둔다. 현재 main의 최대 한 cut transform을 먼저 준비해 기존 mip 선택을 바꾸지 않으며, 불가능한 동시 working set은 반복 eviction/재준비로 넘기지 않는다. 단순 도구/스킨 변경은 원본 전체 invalidation을 만들지 않는다. 전체 원본 복제·새 Worker·알고리즘 복제를 추가하지 않았다.

| 같은 조건의 관측 | 이전 | UI4 | 범위 |
| --- | --- | --- | --- |
| Chrome uniform 활성화→valid 중앙값 | 186.6ms | 219.6ms | 패턴별 각 n3, 완성은 느려짐 |
| Chrome checker 활성화→valid 중앙값 | 361.8ms | 404.0ms | 6쌍 전부 완성 시간 증가 |
| Chrome 최대 관측 callback 범위 | 173.1~364.2ms | 5.0~9.6ms | 앱 rAF와 MessagePort callback 관측, 전역 task 상한 아님 |
| 실제 WK uniform 첫 동기 반환 | 245ms | 5ms | 같은 원본·전체 Canvas·기하·요청 품질이 일치한 n1 |
| 실제 WK uniform 시작→valid | 246ms | 312ms | 총 계산/완성 시간 개선이 아님 |
| 실제 WK uniform 최대 timer gap | 246ms | 9ms | 물리 표시 시각·펜 지연이 아님 |

Chrome 6쌍의 전체 Canvas와 각 원본은 exact이며, 실제 WK uniform도 전체 RGBA·authority·geometry가 일치했다. WK는 LongTask API를 지원하지 않아 해당 값은 `null`이고 0으로 세지 않는다. WK checker는 개별 실행의 원본·예산은 통과했지만 DPR2 대 DPR1, mip4 대 mip8로 조건이 달라 pair를 제외했다. 속도 향상 근거로 사용하지 않는다.

네이티브 성능 계측은 test-only overlay가 든 별도 앱에서 했다. 일반 앱 binary `3769a06bd4c636f587e9dcdaca94d56ce0a24e94024a852f857c1800dcbbeb0d`에는 overlay가 없고, 실제 macOS 저장/복구·codec·Quit·scene 4단계를 통과했다. 임시 foreground 도구도 검사 프로세스에만 사용했다. 사용자 화면이 켜지고 앱 창이 보였다는 확인과 초기 AppKit 권한 실패·두 timeout·등록 전 helper 실패 원문을 함께 보존하며 숨김/잠금을 원인으로 단정하지 않는다.

필수 타일 109개·정보성 4개, Node 176개, 기존 웹 48개·준비 UI 8개·장면 Canvas 56개/문서 12개를 확인했다. 이는 취소·dirty·할당 실패·context loss 등의 검증 범위이며 장시간 RSS나 실제 기기 인수를 대체하지 않는다. 다음 순서는 조건을 맞춘 WK checker 재비교, 넓은 dirty·반복 취소/열기·장기 RSS, 남은 도구·Android/Safari 웹·Windows/macOS OS 통합과 출시 인수다. 전역 50ms·p95·전체 성능이나 전체 goal을 완료 처리하지 않는다.


## 선택 nearest·반복 크기·밀집 mask의 후속 측정

[고정 근거](../evidence/studio-selection-performance.json)는 cold/mip/scene 인수와 다른 선택 연산 측정이다. nearest의 view/set을 raw word/4채널과 축 표로 바꾸고 동일 rounded target/Up의 중복 생성만 생략했다. ordinary-web512×384→2048×1536 고정 trace에서 원본/raw/Canvas가 같고, callback 합계675.2→20.2ms·rAF100.6→29.3ms·시퀀스827→112.7ms·대형 출력5→1회·관측 upload30→6이었다. 버전별1회·DPR1·M1Pro Metal capability 관측이며 물리 표시·Android/WK·안정분포 검사가 아니다.

최종 첫 callback19.0ms/rAF27.4ms는 word-only보다 컸고 sentinel59.8ms도 word50.5ms보다 컸다. 따라서 전체50ms/p95는 미완료다. rAF의 중첩 putImageData 시간을 다시 더하지 않는다. 출력 요청62,914,560→12,582,912B는 누적 생성 요청이지 peak/live/RSS가 아니다. 새 X 표4W(최대128KiB)와 dense 열 표W+1(최대32769B)을 더하며 source 공유 view 제거를 pixel backing 감소로 세지 않는다.

별도1Mi mask paired40에서는 active512 중앙24.523→14.585ms,active2048 98.997→23.775ms였지만 degenerate0.036→0.401·monotone0.258→0.575·active1287.433→7.632ms도 보존했다. 각 측4회·warm2이며 새 dense 분기는 실제Qt12 중11개로 검증했다. 단순 sparse 성능·32Mi 최대 출력·긴 실제 lasso의 프리뷰/입력 응답·전체 RSS·same-DPR WK/넓은 dirty 인수를 대신하지 않는다. 큰 새 target과 path는 여전히 동기다.


## 큰 선택 준비 후속 — 2026-11-05

큰 lasso는8192점 또는 ROI262144픽셀 기준으로 취소 가능한 preparation/Worker로 넘긴다. path16P bytes, owned ROI4S, maskS, 최대열W+1이 필요하며 원래 JS path와Worker point/edge의 공존 가능성을 포함한다. 전체 점·global clipping·raw alpha/RGB·sourceMask stride는 보존한다. 현재1Mi문서/n1 논리typed합계9417743→9942031B는 RSS/peak/Canvas/GPU 측정이 아니다. actualWK 최대폭32768×2/full8193point와 channel/Worker cancel4개 correctness PASS지만 최대32Mi시간/메모리 인수는 아니다. 새ready29.2ms 증가·preview54ms와 기존 최대resize 동기 비용은 남았다. [고정 실행·리뷰 자료](../evidence/studio-selection-preparation.json).


## 선택 첫 화면 비용 후속 — 2026-11-05

이번 개선은 cut bbox 밖 순회를 생략하고 RGBA4를 직접 대입하는 인라인 변경이다. 원본 sourceMask 폭32768 addressing·unaligned byte views·부분/0 alpha rawRGB와 리사이즈 payload와의 stride 분리를 회귀했다. 새 ImageData18/8,437,836B와surface18 명목RGBA추정은 이전과 같고 전체cache/peak/RSS/GPUpool 측정이 아니다. 실측1024²/조건별n1 첫RAF58.1→15.7ms는 최대32Mi·장기 세션 성능 인수가 아니다. 전체path/최대resize/scene 활성·memory acceptance와 Android웹/Windows는 남아 있다. [고정 측정·검증 자료](../evidence/studio-selection-preview.json).


## 대형 nearest 출력 후속 — 2026-11-06

단일 32Mi 픽셀 출력의 128MiB 버퍼는 유지하면서 행 재사용과 정확히 2배 word 복사를 적용했다. 실제 Chromium 10회에서 전체 raw/실제 PNG·원본·취소·기존 Redo가 같았고, 별도 실제 WK에서 두 32Mi 출력과 8191px 인접 크기의 geometry Worker를 확인했다. 단위 검사의 최대 축/높이 1은 이 최대 면적 검사와 구분한다. 문서·선택 원본·새 결과의 단순 픽셀 모델 256MiB, 후속 target 교체 시 384MiB 가능성과 캐시·코덱·GPU·GC 전체 peak/RSS 미인수를 함께 유지한다. 일반 macOS 4단계도 별도로 통과했다. [측정·구현·독립 검증 근거](../evidence/studio-nearest-resize.json).


## 분할 nearest 출력 후속 — 2026-11-06

실제 Chromium에서 두 32Mi 출력과 8191px 인접 출력을 분할 처리하고 전체 raw/PNG·원본·취소·Redo를 비교했다. 별도 WK는 8191×4096 near-max 출력 전체 word와 직접 Studio/MessageChannel 소유권을 검사했다. 최대 단일 출력 128MiB와 X 표 128KiB는 여전하다. 새 gesture의 문서·base·시작 snapshot·current·partial이 모두 다르면 논리 512MiB가 공존할 수 있고 폐기 후보의 GC 시점도 별개다. 65,536 출력 픽셀 작업량의 bound를 할당·시간·peak/RSS 상한으로 해석하지 않는다. [분할 resize 구현·실행·독립 검토 근거](../evidence/studio-bounded-resize.json).


## 선택 resize의 논리 용량과 수집 가능성 — 2026-11-06

[유한 메모리 진단 근거](../evidence/studio-resize-memory.json). 이전 512MiB는 doc64+base64+gesture-start128+displayed128+private128이 모두 다른 예제다. 전역 상한이 아니다. 허용되는 doc8192×4096×2layers(256MiB), 별도 base8192×4096(128MiB), start8191×4096, current8190×4096, candidate8189×4096의 합은 805,208,064B(767.90625MiB)다. 모든 목표는 원본문서 안에 있고 image32Mi/aggregate64Mi 한도를 지킨다. 이는 코드의 한도/기하를 검토한 계산이며 이번 실행에서 이 2레이어 최대 예제를 할당한 것은 아니다. 이력·mask·타일/Canvas·codec·GC 전 폐기 후보는 별도다.

실제 single-layer 진단에서도 세 partial 교체 동안 수집 전 픽셀 버퍼 용량 약 767.84MiB가 관측됐다. 그 합계에는 이미 폐기됐지만 아직 수집되지 않은 후보가 포함된다. 별도 GC 후 약 255.94MiB, 완료된 선택의 Escape·검증 후 GC 뒤 문서64MiB만 남았으며 추적한 target5개는 수집됐다. 한 owner·커서와 물리 메모리 상한을 동일시하지 않는다. partial 버퍼는 전체 용량을 모두 쓰지 않았으므로 용량을 RSS로 환산하지 않는다.

Node 웹/desktop 진단과 실제 Chrome 데스크톱 IPC 모델은 범위가 다르다. 실제 OS/WebKit·Android 웹·긴 자연 GC cadence/peak/RSS는 계속 미인수다. 3GiB 샘플 중단 조건은 이번 실행에서 도달하지 않았지만 hard limit이나 미관측 peak의 증거는 아니다. 버퍼 재사용은 source/시작 snapshot/현재 표시/공개 전 후보가 alias하지 않는다는 별도 설계·회귀와 실측 이득 없이 도입하지 않는다.


## 진행 단위와 시간 예산의 추가 진단 — 2026-11-06

[동일 카메라 진단](../evidence/studio-high-minification.json). 4ms deadline은 prepare 반환 뒤 확인하고, source 65536 카운터는 할당·최종 normalize/upload·합성·컴파일/GC의 시간 상한이 아니다. 실제 진단은 첫 payload next 42.8ms를 보였으나, 32768 후보에서도 첫 두 resume 42.9/14.9ms로 큰 구간이 줄지 않았다. 이후 작은 단계는 줄고 호출 수는 늘어도 전체 응답성 개선의 근거가 되지 않아 후보를 미반영했다. 이전 99ms 원인·전역 50ms·물리 입력/p95 인수는 계속 미확정이며 현재 제품은 65536을 유지한다.
