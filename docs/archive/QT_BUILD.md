# Qt 기준 구현 빌드 (레거시)

Studio가 아닌 `src/` 호환성 기준 구현입니다. 신규 앱 테스트는 [루트 안내](../../README.md)를 따르세요. 아래는 보존된 Qt 빌드 절차이며 최신 OS 인수를 의미하지 않습니다.

## 빌드

필수 도구: C++20 컴파일러, CMake 3.22+, Qt 6.4+의 Core/Gui/Widgets와 개발 도구. 테스트에는 Qt Test가 추가로 필요합니다. 최소 호환 버전은 보안 패치 권장 버전과 같은 의미가 아닙니다. 실제 배포에는 사용하는 Qt 배포판의 보안 패치를 확인해야 합니다.

### Linux

Ubuntu 계열 개발 환경 예:

```sh
sudo apt-get install build-essential cmake ninja-build qt6-base-dev qt6-base-dev-tools qt6-qpa-plugins libgl1-mesa-dev fonts-nanum
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel 2
ctest --test-dir build --output-on-failure
./build/retropaint
```

Qt SDK를 별도 경로에 설치했다면 구성 명령에 `-DCMAKE_PREFIX_PATH=/path/to/Qt/prefix`를 추가합니다. Linux 실행에는 디스플레이와 해당 Qt 플랫폼 플러그인이 필요합니다. 첨부한 Linux 개발 실행 파일은 Qt 런타임을 포함하지 않습니다.

### macOS

Xcode Command Line Tools, CMake와 macOS용 Qt SDK가 필요합니다. Qt 설치 경로를 실제 경로로 바꿉니다.

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH=/path/to/Qt/macos
cmake --build build --parallel 2
ctest --test-dir build --output-on-failure
open build/retropaint.app
```

호스트 아키텍처가 기본값입니다. Universal 빌드는 Universal Qt SDK에서 `-DCMAKE_OSX_ARCHITECTURES="arm64;x86_64"`를 지정합니다. 두 아키텍처의 실제 실행 검증은 별개로 필요합니다.

### Windows

Visual Studio 2022의 C++ 데스크톱 도구와 동일한 ABI의 Qt SDK를 사용합니다. 다음은 PowerShell 예입니다.

```powershell
$env:Path = 'C:\Qt\6.8.3\msvc2022_64\bin;' + $env:Path
cmake -S . -B build -G 'Visual Studio 17 2022' -A x64 -DCMAKE_PREFIX_PATH=C:/Qt/6.8.3/msvc2022_64
cmake --build build --config Release --parallel 2
ctest --test-dir build -C Release --output-on-failure
.\build\Release\retropaint.exe
```

6.8.3은 CI 설정의 고정 호환성 기준이며 최신 보안 버전이라는 뜻은 아닙니다. MSVC 소스 인코딩은 CMake에서 `/utf-8`로 지정합니다.

## 배포 준비

`RETROPAINT_DEPLOY_RUNTIME=ON`은 Qt의 네이티브 배포 스크립트를 사용합니다. macOS에서는 앱 번들, Windows에서는 실행 폴더로 Qt 의존성을 수집합니다. Linux의 이 기능은 Qt 6.5 이상이 필요하며 시스템 라이브러리까지 모두 모으는 범용 독립 실행 파일을 보장하지 않습니다.

```sh
cmake -S . -B build -DRETROPAINT_DEPLOY_RUNTIME=ON -DCMAKE_PREFIX_PATH=/path/to/Qt/prefix
cmake --build build --config Release
cmake --install build --config Release --prefix dist
```

배포 전에는 해당 Qt 빌드와 플러그인의 라이선스·소스 제공 요건, 깨끗한 OS에서의 실행, OS별 서명 및 macOS 공증을 완료해야 합니다. 이 프로젝트는 서명·공증 인증서를 포함하지 않습니다. CI는 빌드와 테스트 설정이며 배포를 자동 게시하지 않습니다.

