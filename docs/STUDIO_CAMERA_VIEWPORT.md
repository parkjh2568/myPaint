# 카메라·VisualViewport와 선택 확정 최적화

2026-11-06. [소스·최초 실패·원인 분리·최종 검증](evidence/studio-camera-viewport.json). 모바일·태블릿은 웹만, 실행 파일은 Windows/macOS만 제공한다. 이번 단계는 전체34태스크·실기기·출시 완료 판정이 아니다.

## 우선순위와 수정

| 순서·위험·비용 | 재현한 영향 | 채택한 수정 |
| --- | --- | --- |
| 1 Major / S | 그리는 중 휠 pan 뒤 실제 release가 불필요한 픽셀을 확정했다. 같은 trace의6셀이14셀로 늘었고 Ctrl+wheel 브러시는 AA 이웃도 생겼다. | 실제 입력 소유자가 있는 동안 휠을 무시한다. 일반 탐색과 손을 뗀 비동기 크기 변경은 유지한다. |
| 2 Minor / M | 실제 Chrome3배 확대에서 layout390×844는 그대로인데 앱 높이가281px로 줄고 자동 맞춤45%가12%로 변했다. 별도 키보드 API 모델에서는 대화상자가 visual rect 밖에 남았다. | 앱 높이는 visual height×scale로 정규화한다. 초기·resize·scroll을 같은 소유 핸들러로 처리한다. 정상 크기 패널은 visual rect를 따르고, 좁은 확대에서는 원점을 고정해 브라우저 pan을 허용한다. 회전·실제 span 변화에는 재기준화한다. |
| 3 Minor / S | top300 모델에서 폭260px 문자 상자의 오른쪽이431.5px로 화면390px를 넘었다. 중복 observer가 맞춤을 재실행해 앞선 보정을 덮었다. | 포커스된 문자와 같은 기하에만 조기 반환한다. 독립적으로 같은 fixture·assert를 유지해 오른쪽382px와 원본·캐럿·스크롤·PNG 보존을 확인했다. 선택·문서 확장·Undo/Redo의 기존 맞춤은 유지한다. |
| 4 Minor / S | 입력 중 coarse 변경을 보류한 뒤 같은 크기로 취소하거나 스포이트처럼 drag 없는 pointer를 취소하면 밀도 갱신이 남았다. | pending 상태를 안전한 종료 경계에서 소비한다. 수동 마우스/터치 선택은 자동 감지보다 우선한다. |
| 5 실측 최적화 / S | 미변형 선택을 닫기만 해도4K 두 레이어 전체128MiB를 동기 복사했다. | 엄격한 무변형 guard에서 기존 commitPending에 현재 state를 전달한다. 엔진 검증·NoOp 이력·정리·draw(true)는 유지한다. |

앱은 scale1·전체 폭일 때만 VisualViewport offset에 맞춰 이동한다. 브라우저 확대를 역으로 축소하거나 루트 transform을 적용하지 않는다. pinch 중에는 anchor를 고정해 사용자의 pan을 쫓지 않으며, normalized span이나 layout이 달라지면 패널 기준을 재설정한다. 키보드 API 모델은 OS 키보드 인수와 구분한다. 태블릿 패널은 상단 명령 영역 아래에 두고, 낮은 화면은 패널 전체를 스크롤한다.

## 성능과 원본 보존

실제 제품 메서드를 추출하고 실제 PaintDocument 엔진을 사용한 측정에서4096² 두 레이어의 slice 출력은134,217,728B→0이었다. 수정 전3회 중앙값40.97ms이며 수정 후 짧은 호출 표본은 원문에 모두 남겼다. drawing은 모델이므로 이 결과를 앱 지연·RSS·FPS·p95 개선으로 확대하지 않는다. draw(true)의 실제 렌더링 비용도 남아 있다.

공개1K 두 레이어 테스트에서는 도구 클릭으로 무변형 선택을 실제 해제하고, 픽셀 slice·전체 평면 생성자 복사·Worker 작업 발생 여부, 저장 원본·숨은 RGB·dirty·기존 Redo를 확인한다. 이동된 선택은 원래 영역 지우기와 한 번 Undo/Redo를 유지하며, invalid state·미완료 resize·조합·stroke 가드는 정리 전에 실패한다.

## 검증과 오류 기록

최종 소스 main `3eaaed5294bd`, CSS `8aa4c242aa25` 기준으로 다음을 확인했다.

- 새 공개 카메라·VV 회귀17개. 실제 Chrome 입력·page scale·pan과 통제된 VV/media 모델의 범위를 각 사례에 명시한다. 실제 OS 키보드·IME·물리 Android 인수로 세지 않는다.
- 단위232개, 기존 터치20개, 포인터26개, 손을 뗀 선택 크기 변경10개, 미확정 편집36개, 출력 미리보기12개가 통과했다.
- 기존 웹48개(기본13·동시성3·편집13·저장13·기울이기6)가 통과했다.
- 최종 macOS 앱의 실제 WKWebView·IPC/복구·코덱·종료·scene4단계와 정상 종료를 확인했다. Windows·OS picker·새 모바일 조합의 WK 인수를 대신하지 않는다.

최초 실패는 폐기하지 않았다. 선택 내부라고 가정한 시작점은 실제 resize handle 안이었고, 수동 밀도 대기는 자동 모드의 같은 dataset 때문에 너무 일찍 끝났다. 확대 gesture 좌표도 visual bounds 밖이었다. 이 세 하네스 전제와 실제 문자 가시성 실패를 구분한다. 단위 fixture에서 stroke 중 canRedo가 false인 엔진 계약도 유지했다.

고정 앱 때문에 body 높이가0이 된 후보의15개 generic clip 실패는 실제5점 hit가 모두 통과했다. body min-height는 전체 화면 셸 경계를 명시한 보완이며15개 사용자 클릭 결함 수정이 아니다. body의 overflow가 viewport로 전파되는 경우와 fixed 요소는 일반 조상 clientHeight 교집합만으로 판단할 수 없다. [CSS Overflow](https://www.w3.org/TR/css-overflow-3/#overflow-propagation)

앞선 터치 보고서의 강제17px gutter에서42/48px만 보인다는 판정도 정정한다. Mac Chrome의 실제 스크린샷·가장자리 클릭은48px 전체를 확인했다. clientWidth 차이만으로 잘림을 주장하지 않는다. intrinsic 레일이 overflow 예산을 해결한 점과 별도 태블릿 외곽 잘림은 유지하며, 실제 Windows 스크롤바 인수는 남긴다. 과거 보고서는 당시 기록으로 보존하고 이번 정정 근거를 연결한다.

## 구조·문서·남은 작업

런타임17개 중 main/CSS만 변경했고 기존 메서드 안에 순차 구현했다. 새 작은 helper·런타임 모듈·외부 의존성·엔진/형식/Rust 변경은 없다. 공유 VV 핸들러는 같은 이벤트 자원과 배치 상태를 소유한다. 신규 주석은 좁은 pinch anchor와 반복 observer의 의도만 설명한다. [소스·배포 의존성 그래프](evidence/studio-camera-viewport-module-graph.json)의 runtime 순환0·정적 평가 순환0·기존 동적 SCC2를 확인했다.

최종 웹 payload는 LICENSE 포함9파일·288,921B, entry는 `assets/index-CKNQ3vWc.js`다. 검증 manifest는 별도이며 SDK·node_modules·Rust target은 포함하지 않는다. 홈페이지 쓰기·Git commit/push·공개 배포는 하지 않았다.

전체 판정은 자체 조건6입증·26부분·2미구현, 선행까지 닫힌 항목은 QF-01뿐이다. 다음은 자동 복구 snapshot의 clone→codec→storage 비용을 분리 측정하고, stale·취소·예외·복구 세대의 안전성을 보존하는 후보만 검토한다. 실제 Android 키보드·IME·회전·확대 feedback, Windows/실제 OS 파일·펜·터치·보조공학, 공개 CI·서명/공증·복구 인계·Pages 인수도 남는다.

[VisualViewport 좌표·확대 규칙](https://www.w3.org/TR/cssom-view-1/#visualViewport), [Chrome의 layout/visual viewport 설명](https://developer.chrome.com/blog/visual-viewport-api)을 참고했다. 실제 CDP 확대와 통제된 keyboard getter 모델을 구분하며 표준 문서를 물리 장치 검증의 대체로 쓰지 않는다.
