# 웹 빌드와 홈페이지 반영

소스와 홈페이지를 형제 폴더로 관리한다. 현재 위치는 `myService/myPaint`와 `myService/parkjh2568.github.io`다. 각 저장소의 `origin`만 사용하며 웹 빌드가 Git staging·commit·pull·push를 수행하지 않는다.

## 준비한 SDK

검증한 조합은 Qt 6.12.0, Qt 소스 commit `025bdad181de241e81bf853c8a2d7bf3d19261a9`, Emscripten 5.0.5다. 기본 Qt Wasm 바이너리 대신 예외 지원 Qt를 소스에서 빌드한다. 호스트 Qt도 같은 버전을 사용한다. SDK·도구는 무시되는 `build-tools/` 안에 둔다.

```sh
# myPaint 폴더에서 실행. 최초 SDK 준비에만 네트워크가 필요하다.
git clone https://github.com/emscripten-core/emsdk.git build-tools/emsdk
build-tools/emsdk/emsdk install 5.0.5
build-tools/emsdk/emsdk activate 5.0.5
source build-tools/emsdk/emsdk_env.sh

git clone --branch v6.12.0 --depth 1 https://github.com/qt/qtbase.git build-tools/qtbase
mkdir -p build-tools/qt-wasm-build
cd build-tools/qt-wasm-build
../qtbase/configure -release -static -no-feature-thread -feature-wasm-exceptions \
  -nomake tests -nomake examples -no-feature-network -no-feature-dbus \
  -no-feature-sql -no-feature-testlib -no-feature-printsupport -no-openssl \
  -qt-host-path /opt/homebrew -platform wasm-emscripten \
  -prefix "$(cd .. && pwd)/qt-wasm"
cmake --build . --parallel 2
cmake --install .
```

`/opt/homebrew`는 이 macOS 환경의 호스트 Qt 경로다. 다른 환경은 실제 동일 버전 SDK 경로로 바꾼다. Qt/Emscripten 업그레이드 시 예외 처리와 브라우저 시험을 다시 수행하고 빌드 도구의 버전 검사도 함께 갱신한다. Asyncify·JSPI·스레드·격리용 Service Worker를 요구하지 않는다.

## 평소 빌드

```sh
cd /Users/jhpark/code/myService/myPaint
python3 tools/build_web.py --host-qt /opt/homebrew
```

매번 CMake 구성과 빌드를 수행한 뒤 `dist/web/`를 완성하고 기본 형제 홈페이지의 `mypaint/`만 갱신한다. 다른 위치는 `--homepage <홈페이지 저장소 root>`로 지정한다. 홈페이지 반영 없이 확인하려면 `--no-stage`를 사용한다. Python 3.11+, CMake, Ninja와 준비된 SDK가 필요하다. 앱 실행에는 Python·Qt 설치가 필요 없다.

```sh
# 만들어진 산출물만 검증하거나 나중에 반영할 때
python3 tools/stage_web.py dist/web ../parkjh2568.github.io --check
python3 tools/stage_web.py dist/web ../parkjh2568.github.io

# localhost에서 실제 하위 경로 확인
python3 -m http.server 8000 --bind 127.0.0.1 --directory ../parkjh2568.github.io
# http://127.0.0.1:8000/mypaint/
```

파일을 `file://`로 열지 않는다. HTTPS 또는 localhost에서 실행한다. GitHub Pages에는 홈페이지 저장소의 기존 root 게시 workflow가 있어 `/mypaint/`를 포함한다. 실제 공개 URL 검증은 사용자의 별도 commit·push 이후에 한다.

## 반영의 보호 장치

파일 해시와 소유 manifest를 검사하고 임시 디렉토리에서 준비한 뒤 교체한다. 복사 실패는 기존 산출물을 유지하고 설치 rename 실패는 이전 디렉토리를 복원한다. `mypaint/` 안의 수동 수정·미확인 파일·staged 변경·심볼릭 링크는 덮어쓰지 않고 중지한다. 다른 홈페이지 파일과 다른 staged 작업은 보존한다. 강제 덮어쓰기 옵션은 없다.

루트 `mypaint/index.html`은 `releases/<버전>/`을 참조한다. 이전 버전 파일과 공유 라이선스·소스 자료는 보존해 오래된 HTML 캐시에서도 같은 JS/Wasm을 읽게 한다. 파일당 100 MiB 미만, 보존 산출물 합계 900 MiB 미만, 파일 8192개 이하다. 보존 한도에 도달하면 도구는 중지한다. 이전 버전 정리는 홈페이지 작업 트리에서 사용 중인 root index와 manifest의 소유 파일을 함께 검토한 뒤 수행한다. 무조건 디렉토리를 지우거나 홈페이지 전체를 reset하지 않는다.

중단으로 `.mypaint-build-lock` 또는 `.mypaint-backup-*`가 남으면 다른 빌드가 실행 중인지 먼저 확인하고 양쪽 manifest를 검토한다. 정상 백업을 버리지 않는다. 홈페이지 커밋을 되돌릴 때는 `mypaint/` 변경만 복원하는 새 커밋을 만든다.

## 라이선스·대응 소스

웹은 Qt를 정적으로 링크한다. 패키지는 실제 빌드한 앱 소스·빌드 도구, Qt 전체 대응 소스, Qt LICENSES, Emscripten 및 C++/C 런타임 고지, 폰트 OFL을 포함한다. 앱 소스는 미커밋 내용을 포함하고 각 파일 해시를 기록한다. 소스가 빌드 중 변경되면 패키징을 중단한다. SDK 바이너리·인증 파일·사용자 그림은 수집하지 않는다. 자료는 앱 초기 로딩과 별개로 `라이선스` 링크에서 받을 수 있다. 패키지 `BUILDING.txt`에 재빌드·재링크 절차가 있다.

## 테스트

```sh
ctest --test-dir build-native-relocated --output-on-failure
python3 -m unittest discover -s tests -p 'test_stage_web.py'
# 별도 개발 도구 Playwright가 설치된 환경에서 localhost 서버를 실행한 뒤
PAINT_TEST_URL=http://127.0.0.1:8000/mypaint/ node tests/web_browser.mjs
PAINT_TEST_URL=http://127.0.0.1:8000/mypaint/ node tests/web_storage.mjs
```

이 문서의 로컬 성공은 원격 Pages 게시 성공을 뜻하지 않는다. Safari·Firefox·실제 OS 한글 IME·모바일은 별도 인수 항목이다.

Playwright는 제품 의존성이 아니다. 개발 환경에서 `playwright` 모듈을 설치하거나 `PLAYWRIGHT_MODULE`에 해당 ESM 경로를 지정한다. 브라우저 설치가 별도면 `CHROME_PATH`에 실행 파일을 지정한다. `PAINT_TEST_OUTPUT`은 증거를 저장할 폴더다. 검증에 사용한 버전은 Playwright 1.62.1 / Chrome 156.0.8078.80이다.
