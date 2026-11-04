# WebAssembly SDK 이식시험

전체 웹 앱을 이식하기 전 예외 지원 Qt SDK와 이벤트 루프를 확인하는 작은 시험이다. 제품 main·MainWindow를 실행하거나 홈페이지에 게시하지 않는다.

## 확인하는 동작

main 반환 후 타이머, 검증 예외 처리, 한글 glyph, 편집과 Undo/Redo, rpaint 파일 왕복을 시험한다. 브라우저에서 첫 버튼을 클릭하면 편집을 반복하며 두 번째 버튼은 예외를 처리하고 비동기 대화상자를 연다. 창을 닫은 뒤 첫 버튼이 계속 작동해야 한다. 결과는 개발자 콘솔의 globalThis.retropaintProbe로 확인할 수 있다.

## 빌드

Emscripten 5.0.5와 예외를 활성화한 Qt 6.12.0을 검증했다. 일반 Wasm Qt 바이너리는 사용할 수 없다. CMake에서 Qt의 wasm_exceptions feature를 검사한다. 아래는 myPaint 폴더에서 프로젝트 내부 SDK를 사용하는 예다. 호스트 Qt 경로는 설치 환경에 맞춘다.

```sh
source build-tools/emsdk/emsdk_env.sh
build-tools/qt-wasm/bin/qt-cmake -S tests/wasm_probe -B build-wasm-probe -G Ninja -DCMAKE_BUILD_TYPE=Release -DQT_HOST_PATH=/opt/homebrew
cmake --build build-wasm-probe --parallel 2
python3 -m http.server 8794 --bind 127.0.0.1 --directory build-wasm-probe
```

브라우저에서 http://127.0.0.1:8794/wasm_probe.html 을 연다. 스레드·SharedArrayBuffer·Asyncify·JSPI·COOP/COEP를 요구하지 않는다. 앱과 창은 main 반환 이후에도 수명을 유지한다.

글꼴은 assets/fonts의 수정하지 않은 NanumGothic Regular이며 OFL.txt와 NOTICE.md를 따른다. 시험 코드와 동일한 Qt SDK를 쓴다는 사실만으로 전체 웹 UI·클립보드·복구·모바일 지원을 보장하지 않는다.

## 검증 결과

2026-11-03 macOS ARM64, Chrome 156.0.8078.80 headless에서 한글 표시와 실제 클릭·오류창·오류 후 편집까지 통과했다. SDK 구성·한계와 증거는 [웹 진행 기록](../../docs/WEB_IMPLEMENTATION_RESULTS.md)을 참고한다.

## 웹 한도 성능 시험

같은 빌드의 `wasm_performance.html`은 최대 4 Mi 픽셀 채우기와 레이어 합계 6 Mi 픽셀의 결정적 난수 이미지 입출력을 실행한다. 결과는 `globalThis.paintPerformance`다. 픽셀 왕복 일치·파일 크기와 동기 호출 시간을 기록한다. 제품 UI 지연의 전체 분포나 모든 기기의 성능을 보장하는 시험은 아니다.
