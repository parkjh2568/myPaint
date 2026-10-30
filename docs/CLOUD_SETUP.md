# myPaint 클라우드 개발 환경

GitHub 저장소는 `parkjh2568/myPaint`, 기본 브랜치는 `main`입니다. 이 저장소를 클라우드 프로젝트의 소스로 선택하고 작업 디렉터리를 저장소 루트로 지정합니다. 앱 내부 개발명과 CMake 실행 대상은 `RetroPaint` / `retropaint`를 유지합니다.

## Ubuntu 24.04 기준 환경 준비

다음은 개발 환경을 준비하는 명령입니다. root 환경에서는 `sudo`를 빼고 실행합니다. 의존성 설치에는 네트워크가 필요하며, 완성된 그림판의 실행 기능에는 네트워크 연결이 필요하지 않습니다.

```sh
sudo apt-get update
sudo apt-get install -y build-essential cmake ninja-build qt6-base-dev qt6-base-dev-tools qt6-qpa-plugins libgl1-mesa-dev fonts-nanum
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel 2
QT_QPA_PLATFORM=offscreen ctest --test-dir build --output-on-failure
```

별도로 설치한 Qt SDK를 사용할 때는 구성 명령에 `-DCMAKE_PREFIX_PATH=/path/to/Qt/prefix`를 추가합니다. 계정 토큰이나 `.env` 파일은 앱 빌드에 필요하지 않습니다. GitHub 인증은 클라우드 환경의 저장소 연결 기능으로 관리합니다.

## 실행과 검사

GUI가 있는 개발 환경에서는 `./build/retropaint`로 실행합니다. 디스플레이가 없는 클라우드에서는 다음과 같이 검사할 수 있습니다.

```sh
QT_QPA_PLATFORM=offscreen ./build/retropaint --smoke
QT_QPA_PLATFORM=offscreen RETROPAINT_SCREENSHOT=/tmp/mypaint-smoke.png ./build/retropaint --smoke
./build/perf_probe
```

`--smoke`는 테스트용 데이터 경로에서 실행되며 실제 사용자 문서를 열지 않습니다. offscreen 검사는 macOS/Windows의 시스템 클립보드, 네이티브 입력기, Retina 표시 등의 실기기 검증을 대체하지 않습니다.

`.github/workflows/build.yml`은 push/PR 시 Ubuntu, macOS, Windows의 빌드와 테스트를 실행합니다. CI는 배포를 게시하지 않습니다. 실행 결과는 저장소 Actions에서 확인합니다. 기존 검증 범위는 [VERIFICATION.md](VERIFICATION.md)에 기록되어 있습니다.

## 저장소에 포함하는 것

소스, CMake 설정, 프로젝트 컨벤션, 테스트, 라이선스, 문서와 검증 증거를 버전 관리합니다. 로컬 빌드 디렉터리, 실행 파일 배포 폴더, 개인 설정, 임시 이미지/프로젝트, 압축 배포물과 인증 정보는 제외합니다. 화면 예시인 `docs/screenshot.png`는 문서 자료로 포함합니다.

이 문서는 클라우드 프로젝트 설정 안내입니다. 외부 클라우드 프로젝트의 환경 설정 자체는 별도로 적용해야 합니다.
