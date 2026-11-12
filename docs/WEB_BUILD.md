# 웹 빌드와 홈페이지 반영

로컬 화면 테스트는 [루트 OS별 안내](../README.md)를 먼저 따른다. 아래는 별도 홈페이지 저장소로 산출물을 옮기는 고급 절차다. 소스 `myPaint`와 홈페이지 `parkjh2568.github.io`를 형제 폴더로 관리한다. 각 저장소의 `origin`만 사용하며 웹 빌드가 Git staging·commit·pull·push를 수행하지 않는다.

## Studio 웹 빌드 (Qt-free)

Python 3.11+와 Node 24/npm을 사용한다. 모바일·태블릿은 웹만 제공하고 설치형 패키지는 Windows/macOS만 대상으로 한다. SDK·Rust target·node_modules·앱 소스 압축은 웹 배포 산출물에 넣지 않는다.

```sh
cd /path/to/myPaint  # 실제 소스 폴더로 바꾼다
npm --prefix web-app ci --no-fund
python3 tools/build_studio.py
# 기본 실행은 dist/studio만 생성하고 홈페이지에는 쓰지 않는다.
python3 tools/stage_web.py dist/studio ../parkjh2568.github.io --check
python3 tools/stage_web.py dist/studio ../parkjh2568.github.io
# 또는 빌드 성공 후 로컬 홈페이지 반영까지 한 번에 실행
python3 tools/build_studio.py --homepage ../parkjh2568.github.io
```

빌더는 타입 검사와 Vite 빌드를 전용 임시 폴더에서 수행하고 입력 해시·소유 manifest·HTML 진입 자산의 상대 경로를 검증한다. 성공하면 `dist/studio`를 교체한다. `web-app/dist`는 바꾸지 않는다. LICENSE와 THIRD_PARTY_NOTICES.txt를 포함하고 bundle.json에는 입력 해시·Git commit/dirty·Node 버전을 기록한다. sourceFiles는 입력 해시이며 대응 소스 압축을 포함한다는 뜻은 아니다. 빌더 소유 LICENSE는 새 파일로만 생성하므로 Vite 출력/public에 같은 경로가 있으면 덮어쓰지 않고 중단한다. npm 의존성 설치는 별도 준비 단계다. 로컬 번들 설치와 홈페이지 반영은 별도 작업이므로 홈페이지 반영 실패 시에도 완성된 로컬 번들은 남는다.

staging은 홈페이지의 `mypaint/`만 교체하고 Git index·설정·다른 페이지를 수정하지 않는다. 확인 후 홈페이지 폴더에서 별도로 commit·push한다. 기존 root 게시 설정이 `/mypaint/`를 포함해야 하며 실제 공개 인수는 게시 후 수행한다.

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory ../parkjh2568.github.io
# http://127.0.0.1:8000/mypaint/
# 정리 전 삭제 대상 수·용량만 확인
python3 tools/stage_web.py dist/studio ../parkjh2568.github.io --check --prune
# 검토 후 현재 Studio 릴리스만 유지할 때
python3 tools/stage_web.py dist/studio ../parkjh2568.github.io --prune
```

Studio 버전 ID는 전체 배포 파일의 해시로 정한다. 기본 반영은 이전 Studio의 Worker·JPEG 지연 로딩 자산과 Qt 릴리스·공유 고지를 보존한다. `--prune`은 이 이전 파일을 제거하므로 열려 있던 이전 탭이나 직접 버전 URL이 이후 자산을 읽지 못할 수 있다. Git 과거 이력의 대형 blob은 파일 정리로 줄어들지 않는다.

기존 산출물의 수동 변경·미확인 파일·symlink·staged mypaint 변경은 덮어쓰지 않는다. 복사 실패에는 기존 폴더를 유지하고 설치 rename 실패에는 백업 복원을 시도한다. 두 번의 rename 사이 경로가 잠시 없을 수 있으며 전원 차단까지 복구하는 원자 교체를 보장하지 않는다. 중단 후 `dist/.studio-build-lock`, `dist/.studio-previous`, 홈페이지의 `.mypaint-build-lock`·`.mypaint-backup-*`가 남으면 실행 중 작업과 양쪽 manifest를 확인한다. 복원도 실패하면 오류에 표시된 백업을 보존하고 검토한다.

```sh
python3 tests/test_stage_web.py
python3 tests/test_build_studio.py
# 개발용 Playwright Chromium을 준비하고 위 localhost 서버를 띄운 뒤
PAINT_TEST_URL=http://127.0.0.1:8000/mypaint/ npm --prefix web-app run test:jpeg-orientation
```

Studio 브라우저 회귀는 별도 브라우저를 쓸 때 `PAINT_BROWSER_PATH`를 사용한다. [JPEG 방향 검증 범위](evidence/studio-jpeg-orientation.json)는 실제 Chrome 8방향과 HTMLCanvas 대체 경로·기본 문서 오류 보존이며 전체 플랫폼 인수가 아니다.

아래 SDK·정적 링크 소스 제공 안내는 보존 중인 Qt 웹 타깃 전용이다. Studio는 별도 번들 형식을 사용한다.

## Qt 웹 타깃: 준비한 SDK

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

## Qt 웹 타깃: 빌드

```sh
cd /path/to/myPaint  # 실제 소스 폴더로 바꾼다
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

루트 `mypaint/index.html`은 `releases/<버전>/`을 참조한다. Qt는 실행 파일과 HTML이 같으면 Git commit/dirty 정보나 라이선스 안내만 달라져도 현재 버전 경로를 재사용한다. Studio는 LICENSE·고지를 포함한 전체 배포 파일이 같을 때 재사용한다. 새로운 실행 파일의 이전 버전과 공유 라이선스·소스 자료는 보존해 오래된 HTML 캐시에서도 같은 JS/Wasm을 읽게 한다. 파일당 100 MiB 미만, 보존 산출물 합계 900 MiB 미만, 파일 8192개 이하다. 보존 한도에 도달하면 도구는 중지한다. 이전 버전 정리는 홈페이지 작업 트리에서 사용 중인 root index와 manifest의 소유 파일을 함께 검토한 뒤 수행한다. 무조건 디렉토리를 지우거나 홈페이지 전체를 reset하지 않는다.

중단으로 `.mypaint-build-lock` 또는 `.mypaint-backup-*`가 남으면 다른 빌드가 실행 중인지 먼저 확인하고 양쪽 manifest를 검토한다. 정상 백업을 버리지 않는다. 홈페이지 커밋을 되돌릴 때는 `mypaint/` 변경만 복원하는 새 커밋을 만든다.

## Qt 웹 타깃: 라이선스·대응 소스

웹은 Qt를 정적으로 링크한다. 패키지는 실제 빌드한 앱 소스·빌드 도구, Qt LICENSES, Emscripten 및 C++/C 런타임 고지, 폰트 OFL을 포함한다. 수정하지 않은 Qt는 정확한 commit의 공식 소스 압축 다운로드를 라이선스 페이지에 연결한다. 검증한 공식 압축파일은 로컬 Qt 소스 23,476개 파일과 모두 일치했다. 소스 제공의 가용성 책임은 배포자에게 남으며, 링크가 사라지면 로컬 백업으로 복원해야 한다. 자체 완결 배포는 `--bundle-qt-source`로 전체 Qt 소스를 포함할 수 있다. 앱 소스는 미커밋 내용을 포함하고 각 파일 해시를 기록한다. 소스가 빌드 중 변경되면 패키징을 중단한다. SDK 바이너리·인증 파일·사용자 그림은 수집하지 않는다. 자료는 앱 초기 로딩과 별개로 `라이선스` 링크에서 받을 수 있다. 패키지 `BUILDING.txt`에 재빌드·재링크 절차가 있다.

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

## 용량 정리

`--prune`은 현재 번들에 없는 예전 버전과 사용하지 않는 공유 파일을 제거한다. 삭제 전에 manifest와 모든 파일 해시를 검증하고 임시 폴더에서 준비한 뒤 교체한다. 수동 수정·미확인 파일·staged 변경이 있으면 중단한다. 오래된 버전의 직접 URL/캐시가 여전히 필요한 배포에서는 사용 전에 검토한다. 현재 실행 파일이 같으면 활성 버전 경로는 유지한다.

```sh
python3 tools/stage_web.py dist/web ../parkjh2568.github.io --prune --check
python3 tools/stage_web.py dist/web ../parkjh2568.github.io --prune
# 빌드와 정리를 한 번에 실행하려면
python3 tools/build_web.py --host-qt /opt/homebrew --prune
```

파일 정리는 과거 Git 커밋의 대형 blob을 삭제하지 않는다. 이미 게시된 Git 이력을 줄이려면 별도로 이력을 다시 작성하고 원격에 반영해야 하며, 일반 파일 정리 도구는 해당 작업을 수행하지 않는다.
