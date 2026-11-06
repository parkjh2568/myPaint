# 네이티브 대형 문서·타일 표시 구현 기록

2026-11-04 / 전체 목표 진행 중. 모바일은 웹만, 설치 실행파일은 Windows/macOS만 제공한다. [원시 검증 기록](evidence/studio-native-profiles.json)은 소스/산출물 해시와 실제 검사 범위를 포함한다.

## 구현한 경계

엔진·PNG/RPAINT01·이미지 입력·Worker가 명시한 같은 ResourceProfile을 사용한다. 프로필은 불변 canonical 객체이고 Worker 요청/응답에는 web/desktop ID를 확인한다. 파일 내용이 실행 프로필을 선택하지 않으며 기존 State/RPAINT01 직렬화 필드는 유지한다. 웹 기본값과 limits alias도 유지한다.

| 한도 | 웹 | Windows/macOS 설치형 |
| --- | --- | --- |
| 이미지/레이어 총 픽셀 | 4Mi /6Mi | 32Mi /64Mi |
| 한 변/레이어 수 | 4096 /16 | 32768 /16 |
| 입력/레이어 PNG | 40MiB /20MiB | 300MiB /140MiB |
| 기본 이력 예산 | 32MiB | 256MiB |

기존처럼 마지막 큰 이력 한 항목은 예산을 초과해도 보존한다. 이 값은 전체 프로세스 RSS 상한이 아니다.

레이어 표시와 선택 preview는 최대512px Surface의 전역64타일 cache로 표시한다. 가시 영역만 처리하고 변경128px 획 타일과 교차한 부분만 갱신한다. ImageData+Canvas의 추정RGBA 비용을128MiB 이내로 회계하고 LRU/문서 교체/예외에서 backing을 해제한다. GPU·브라우저의 추가 복사까지 측정한 메모리 상한은 아니다.

도형·미확정 도형·자유 선택 마스크·문자와 JPEG/BMP/GIF 입력 readback도 bounded 타일을 사용한다. 선택 preview의 cut은 전체 레이어 사본 대신 해당 타일에만 적용한다. 원본 RGBA는 표시 버퍼에 가변으로 빌려주지 않는다.

문서 크기 변경·회전/반전·기울이기는 Worker geometry 작업으로 옮겼다. 이미 분리한 후보만 transfer하고, 실패/취소/다른 문서·revision·active면 확정하지 않는다. 결과가 돌아오면 후보를 한 번에 확정하고 pending을 해제한다. JPEG/BMP 인코딩도 Worker에서 수행한다. JPEG의 jpeg-js encoder와 Buffer는 해당 형식 요청 때만 로드하며 고지를 정적 산출물에 포함한다.

## 표시 경계의 실제 RCA

고정1px halo는 축소 시 정수 device-pixel 경계의 최대0.5px 반올림을 덮지 못했다. 반투명 uniform 이미지에서0.65/0.215배율의 한 줄 alpha 부족이 각각360/119픽셀로 재현됐다. 배율별 halo로 수정한 뒤 두 경우 모두0이었다. 초기 구현의 최소1/1024는 작은 투영 영역의 alpha-aware 샘플링을 사용했다. 후속 [mip 구현](STUDIO_MAX_DOCUMENT.md)은 이 배율에서도 모든 source 기여를 반영하는 box 평균으로 바꾸고, 실제 원본 extent와 극단 행렬의 예외를 검증했다.

1:1 및 정수 확대, dirty/eviction/retain, uniform alpha·global opacity, gradient 추가 경계 점프, 극저배율 clipping/preview/실패 해제는 엄격하게 검증했다. 고주파 fractional 화면은 전체 Canvas와 샘플링 차이가 남는다. nearest 내부 차이는 정확한 texel tie 위치에 한정됐고 축소 필터 차이도 기록했다. 이를 권위 픽셀 손상이나 경계 틈과 혼동하지 않으며 전체 배율의 표시 바이트 동일성을 주장하지 않는다. native fractional 시각 인수는 남아 있다.

## 초기 프로필 전환 당시의 검증

- strict 타입·Prettier·정적 빌드, Node32개 통과. 실제4096²·32768×1 PNG/RPAINT 원시 픽셀 왕복, 웹 거부, 좌표30000, 프로필 위조/크기/aggregate 거부, geometry와 JPEG/BMP를 포함한다.
- 최종 `/mypaint/` 정적 빌드의 기존 공개 UI45개 통과.
- 네이티브 bridge mock의 공개 UI17개 통과, page error0. 두 대형 문서의 획·Undo/Redo·파일·도형·선택·Worker 실패/취소, JPEG 재열기와32768×1 BMP 전체RGBA를 검증했다. main-thread Canvas2349회 독립 관측의 최대축1072px였으며 최종 재실행도 guard2048px/4Mi pixels를 통과했다. 이는 실제 OS 저장 시험이 아니다.
- 실제 macOS `.app`의 WKWebView에서4096²·32768×1 프로젝트/알파·타일 표시·긴 도형/Undo·32768×1 JPEG 저장/재열기 통과.
- 타일 검사 필수26개 통과, page error0. 고주파 fractional 진단4개는 정보로 따로 남겼으며 통과 개수에 합치지 않는다.
- `test:native-profile`, `test:tiles`를 npm과 CI에 연결했다. 원격 CI/Windows 실행 결과는 아직 없다.

후속 [최대 문서·PNG 검증](STUDIO_MAX_DOCUMENT.md)에서 metadata 무복사 이력·mip cache·dirty 완료 전달·Worker 대형 편집을 추가했다. 이 문서의 초기 표본과 최신 검증을 구분한다.

## 남은 우선순위

1. 후속 [native 파일 저장·복구](STUDIO_NATIVE_PERSISTENCE.md)에서 기억한 경로 저장/OS 열기·Qt 읽기 전용 인계·32개/합계1GiB 파일 복구를 구현하고 실제64MiB 초과 복구를 검증했다. Windows 실제 실행·OS 선택기·디스크 부족·전체 IPC 메모리 인수는 계속 남아 있다. 웹의64MiB 정책은 유지한다.
2. 실제32Mi 이미지/64Mi 합계의 피크 메모리·장시간 편집·취소 인수. 축소 보기의64타일 교체 반복은 mip cache로 개선했다. 초기 cache 생성과16layer1:1 교체 반복, live 선택 resize·pending 합성·후보/이력 복사는 남아 있다. crop/merge 계산은 Worker로 옮겼다.
3. 모든 형식/17개 도구/F01~F10 조합, 실제 Windows·Android 웹·Safari 웹, native fractional 시각 인수.
4. 새 정적 manifest staging·구탭 자산·되돌리기와 서명·공증·전체 native 의존성 고지·공개 인수. 기존 공개 앱/Qt 경로의 제거는 이 조건 이후다.

이번 구현으로 지원 경계와 대형 문서 경로가 전진했지만 전체 전환이나 성능 최적화 완료로 판정하지 않는다.
