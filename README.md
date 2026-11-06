# myPaint

Qt-free 새 버전은 [`web-app/`](web-app/)에서 개발 중입니다. Studio 웹 번들은 `python3 tools/build_studio.py`로 `dist/studio`에 만들고 [별도 홈페이지 반영 절차](docs/WEB_BUILD.md)를 따릅니다. 기본 빌드는 홈페이지·Git을 변경하지 않습니다. **모바일·태블릿은 웹 전용, 설치 실행파일은 Windows/macOS 전용**입니다. 새 빌드 명령·실제 검증·남은 전환 조건은 [Studio 개발 안내](docs/STUDIO_IMPLEMENTATION.md)를 참고하세요. 아래 Qt 설명은 전환 중 보존하는 기준 구현에 해당합니다.


저장소: https://github.com/parkjh2568/myPaint

독립형 오프라인 그림판 프로젝트입니다. 현재 앱의 개발명과 실행 대상 이름은 **RetroPaint 0.1.0 / `retropaint`**입니다. 클라우드 개발 환경 설정은 [CLOUD_SETUP.md](docs/CLOUD_SETUP.md)를 참고하세요.

클래식 그림판 도구에 어두운 드로잉 작업 공간과 부드러운 브러시를 더한 독립형 그림판입니다. 웹과 데스크톱이 같은 편집 화면을 사용합니다. C++20, Qt Widgets, CMake를 사용합니다. 원본 Windows 그림판 실행 파일이나 REA의 코드를 가져오지 않았습니다.

**현재 상태: Linux 검증 기록, macOS ARM64 네이티브 자동 검증, 데스크톱 Chrome의 웹 버전을 제공합니다. Windows·네이티브 입력·Retina·다른 웹 브라우저·실제 Pages 게시 인수는 별도 확인이 필요합니다.**

![myPaint 웹 드로잉 화면](docs/studio-web.png)

[드로잉 UI·브러시 개선과 검증](docs/STUDIO_UPGRADE.md), [홈페이지 용량 정리](docs/WEB_SIZE_CLEANUP.md)를 참고하세요.

## 구현 범위

| 영역 | 기능 |
| --- | --- |
| 기본 그리기 | 연필, 둥근/사각 브러시, 스프레이, 지우개, 색 지우개, 채우기, 스포이트 |
| 브러시 설정 | 색상환·HEX, 잉크/부드러운 붓/픽셀 연필, 크기·불투명도·경도·선 보정, 펜 필압 크기 |
| 도형 | 직선, 곡선, 사각형, 둥근 사각형, 타원, 다각형; 선 굵기·윤곽선·채우기 설정 |
| 선택 | 사각/자유 선택, 배경색 투명 선택, 이동·크기 조절, 복사·잘라내기·붙여넣기, 삭제·자르기 |
| 이미지 | PNG/JPEG/BMP/GIF 열기, 사진 삽입·파일 드롭, 이미지 클립보드; GIF는 첫 프레임만 읽기 |
| 캔버스 | 작업 공간 크기 변경, 이미지 확대/축소, 90도 회전·좌우/상하 반전·가로 기울이기 |
| 문자 | 시스템 글꼴, 글꼴 크기·스타일, 한글 입력을 위한 Qt 텍스트 편집기, 문자 배경 선택 |
| 화면 | 확대/축소, 맞춤 보기, 픽셀 격자, 가운데 버튼 이동, 전경·배경 팔레트 |
| 레이어 | 기본 표시 패널·미리보기, 추가·삭제·순서·이름·표시·숨김·아래 레이어와 병합, 최대 16개 |
| 저장 | PNG/JPEG/BMP 이미지, 레이어 보존 `.rpaint`, Undo/Redo, 로컬 복구 사본 |

계정, AI, 사용자 파일 업로드, 원격 이미지, 광고, 텔레메트리, 자동 업데이트, 웹뷰를 구현하지 않았습니다. 네이티브 앱은 HTTP 요청과 외부 URL 열기를 구현하지 않으며 웹 앱은 같은 사이트의 정적 앱 자산만 읽습니다. 앱은 Qt Network 모듈을 링크하지 않습니다. 빌드 도구 설치와 CI의 의존성 다운로드는 개발 단계이며 앱 실행 기능에 포함되지 않습니다.

## 빠른 사용법

1. `파일 → 열기`로 사진을 열거나, 클립보드 이미지를 붙여넣습니다. 사진 삽입/드롭은 현재 그림 위에 올립니다.
2. 붙여넣은 그림은 드래그로 이동하고 우하단에서 크기를 바꿉니다. Enter로 확정, Esc로 취소합니다. 방향키는 1픽셀, Shift+방향키는 10픽셀 이동합니다.
3. 우측·하단 여백을 끌거나 `이미지 → 캔버스 크기`에서 작업 공간을 조절합니다. `이미지 크기`는 그림 자체를 확대/축소하는 별도 명령입니다.
4. 레이어 패널은 기본 표시됩니다. 숨겼다면 `보기 → 레이어`로 표시합니다. 패널을 숨겨도 레이어는 삭제·병합되지 않습니다.
5. 여러 레이어가 있거나 단일 레이어를 숨긴 문서는 `.rpaint`로 저장합니다. `이미지 내보내기`는 미확정 선택·문자를 포함한 미리보기 결과를 저장하며, 프로젝트의 저장 상태와 미확정 편집을 바꾸지 않습니다.
6. 저장 중에는 진행창에서 취소할 수 있습니다. 취소·실패 시 기존 파일과 미확정 편집을 유지합니다. 자동 복구는 백그라운드에서 준비하고, 그 사이 문서가 바뀌면 이전 사본을 유지한 채 다음 주기에 다시 시도합니다.

기본 도구는 12px 브러시입니다. 오른쪽에서 색상·프리셋·크기·불투명도·경도·선 보정을 바꿉니다. 선 보정을 높이면 흔들림을 줄이는 대신 포인터보다 선이 늦게 따라올 수 있습니다. 캔버스에 초점이 있을 때 B/N/E/I/G/T/V/H로 브러시/연필/지우개/스포이트/채우기/문자/선택/이동을 고르고, [ / ]로 크기를 조절합니다. 펜 필압은 입력 장치와 브라우저가 전달하는 경우 크기에 적용됩니다.

곡선은 끝점 드래그 후 제어점 두 번 클릭, 다각형은 꼭짓점 클릭 후 Enter/더블클릭으로 확정합니다. 문자는 Ctrl+Enter 또는 다른 도구 선택으로 확정합니다. 현재 문자 입력 영역에 보이는 내용만 픽셀로 확정하며, IME 조합이 남아 있으면 먼저 입력을 확정해야 합니다. 문자 확정 후에는 픽셀이 되므로 다시 입력 내용을 편집하려면 Undo가 필요합니다.

선택은 현재 레이어에 작용합니다. 선택 없이 복사하면 보이는 합성 이미지를 복사하고, 잘라내기는 활성 레이어 전체에 작용합니다. 선택 크기를 조절한 뒤 복사·회전하면 화면에 표시된 크기를 사용합니다. 숨겨진 레이어에 새로 그리면 해당 레이어를 표시합니다. 캔버스 확대는 좌상단 기준이며 우측/하단으로 나간 붙여넣기는 확정할 때 작업 공간을 넓힙니다. 음수 좌표의 내용은 캔버스 밖으로 잘립니다. 첫 붙여넣기는 기존 기본 캔버스보다 작아도 캔버스를 자동으로 줄이지 않습니다.

## 웹 버전

네이티브와 같은 그리기·도형·선택·문자·레이어 UI를 사용합니다. 로컬 파일을 기기 안에서 읽고 `.rpaint` 프로젝트 또는 PNG/JPEG/BMP를 다운로드합니다. 다운로드 준비 뒤 화면 상단 `파일 받기`를 누르고 실제 파일을 확인하세요. 다운로드 요청은 현재 편집·Undo·미확정 선택/문자를 유지하며 저장 완료로 표시하지 않습니다.

복구 사본은 IndexedDB에 30초마다 확정 revision을 저장합니다. 새로 열 때 또는 `파일 → 브라우저 복구 사본 열기`에서 시각·이름·크기로 고를 수 있습니다. 브라우저의 사이트 데이터 삭제·용량 제한·private 모드에서 잃을 수 있으므로 프로젝트 다운로드를 함께 사용하세요. 복구 사본에는 미확정 선택·문자와 마지막 저장 이후 편집이 포함되지 않을 수 있습니다.

웹 한도는 이미지 4 Mi 픽셀, 레이어 합계 6 Mi 픽셀, 한 변 4096픽셀, 입력 40 MiB, 레이어 최대 16개, 이력 예산 32 MiB입니다. 한도를 넘는 문서는 네이티브 앱에서 열 수 있습니다. 텍스트는 65536 UTF-16 단위 이내이며 복사·붙여넣기는 편집 메뉴/단축키를 사용합니다. 클립보드 권한이 거절되면 파일 열기·이미지 내보내기를 사용하세요. 웹 PNG는 동기 인코딩 시간을 줄이기 위해 무압축으로 저장하며 픽셀과 파일 형식은 보존합니다.

```sh
# SDK 최초 준비는 아래 빌드 문서 참고
python3 tools/build_web.py --host-qt /opt/homebrew
```

성공하면 형제 `parkjh2568.github.io/mypaint/`에 산출물만 반영합니다. 자동 Git 작업은 하지 않습니다. [웹 빌드·실패 복원](docs/WEB_BUILD.md), [각 저장소의 Git 관리](docs/GIT_WORKFLOW.md), [실제 검증 결과](docs/WEB_IMPLEMENTATION_RESULTS.md)를 참고하세요. 대상 URL은 [parkjh2568.github.io/mypaint/](https://parkjh2568.github.io/mypaint/)이며 공개 게시는 홈페이지 폴더의 별도 commit·push로 진행합니다.

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

## 구조와 문서

- `src/document.*`: 레이어·픽셀·변경 기록·이미지/프로젝트 입출력.
- `src/canvas.*`: 그리기 도구·선택·미리보기·입력 처리.
- `src/mainwindow.*`: 메뉴·저장 흐름·레이어 패널·복구.
- `src/colorpicker.*`: 색상환·명도/채도 선택.
- `src/main.cpp`: 앱 시작·Fusion 스타일·단일 인스턴스·오류 경계.
- `tests/`: 편집/파일/실패 시나리오, UI 입력, Linux 오프라인 호출 검사와 성능 측정.
- [설계와 예외 처리](docs/ARCHITECTURE.md), [프로젝트 파일 형식](docs/FILE_FORMAT.md), [검증 결과와 남은 작업](docs/VERIFICATION.md).
- [전체 코드 검토와 단계별 리팩터링 계획](docs/CODE_REVIEW.md): 2026-11-03 macOS offscreen 검증과 미해결 이슈.
- [결함 수정과 도구 UI 작업계획](docs/IMPLEMENTATION_PLAN.md): 이슈별 구현·의존성·회귀 조건과 적용한 아이콘 변경.
- [구현 결과와 검증 한계](docs/IMPLEMENTATION_RESULTS.md): 편집·취소·저장·복구 수정과 최신 로컬 검증.
- [웹 버전과 GitHub Pages 배포 검토](docs/WEB_FEASIBILITY.md): Qt WebAssembly 이식 조건과 기존 홈페이지의 `mypaint/`에 산출물을 반영하는 계획. 초기 타당성 검토 기록입니다. 현재 구현 결과는 아래 문서를 참고하세요.
- [웹 버전 구현 작업계획](docs/WEB_IMPLEMENTATION_PLAN.md): SDK 이식시험부터 비동기 편집·파일·복구·브라우저 검증·안전한 게시까지의 우선순위와 완료 조건.
- [소스와 홈페이지 Git 관리 방법](docs/GIT_WORKFLOW.md): 실제 로컬 저장소·Pages workflow·인증 문제와 각 폴더의 origin으로 pull/push하고 산출물을 수동 커밋·게시하는 절차.
- [웹 구현 진행 기록](docs/WEB_IMPLEMENTATION_RESULTS.md): 디렉토리 이동 복구·네이티브 회귀·실제 Wasm SDK와 한글·예외·편집 선행 시험. 공통 웹 UI와 브라우저 경계 검증을 포함합니다.
- 컨벤션은 [AGENTS.md](AGENTS.md), 코드 정렬은 `.clang-format`을 따릅니다.

함수는 하나의 편집·저장 흐름을 소유하도록 구성했습니다. 크기 검증, 작업 실행 경계, 반복 사용하는 텍스트 스타일 반영처럼 의미를 공유하는 작업만 분리했습니다. 컨트롤러·서비스·리포지터리 계층을 추가로 겹치지 않았습니다.

앱 소스는 [MIT](LICENSE)입니다. 외부 의존성은 [NOTICE.md](NOTICE.md)를 확인하세요.
