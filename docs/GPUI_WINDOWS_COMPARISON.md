# myPaint Tauri와 GPUI의 Windows 비교

2026-11-15 · `codex/gpui-compare` · Tauri 기준 커밋 `04a2c5d71416aa4442623519969e7c391b13e479`

## 권한 재승인 후 실제 Windows 화면과 지연 측정

Windows 컴퓨터 사용 권한을 다시 받아 두 앱을 조작했다. 처음 승인된 GPUI 화면의 빈 아이콘은 SVG 요소에 색상이 직접 설정되지 않은 문제였다. 아이콘 렌더링, 터치 밀도의 도구와 하단 조작부 크기, 지우개와 레이어 배치를 보정한 뒤 같은 150% 배율의 두 설치본 화면을 대조했다. 상단 바, 탭, 아이콘 도구 모음, 800×600 캔버스, 색상환과 레이어의 위치를 확인했다. 캔버스 크기 조절 손잡이 위치, 스크롤바 표시, 일부 입력란과 버튼 스타일은 차이가 남았다. [GPUI 화면 구성](../gpui-app/src/ui/chrome.rs) · [아이콘 회귀 검사](../gpui-app/src/ui/icons.rs)

새 GPUI 설치본의 SHA-256은 `50e7013ff1438b2fd5bfbf3ce496a7d87bc17d55d694fff2b9629cde5e09b4f5`이며 설치 실행 파일은 `3ef351675ce639c3fd229e96d6c35a51d29c207bb8448d65623876edc8e6f25f`이다. 실제 파일 메뉴의 **복구 사본**에서 Tauri가 만든 2048×2048 사본을 선택해 붉은색과 파란색 획이 포함된 새 탭을 열었다. 복구 입력 파일의 SHA-256은 열기 전후 동일했다. 복원된 그림으로 PNG 미리보기의 투명 체크무늬와 JPG 선택 시 흰색 바탕 합성을 확인했다. Windows Rust 테스트는 68개가 통과했다.

설치본의 문자 입력란에 `한글`을 직접 입력하고 확정해 두 글리프를 캔버스에서 확인했다. Windows 한국어 IME를 통한 키 조합은 확인하지 못했다. 도구는 `Hangul` 키를 지원하지 않았고 오른쪽 Alt 및 화상 키보드로 시도한 뒤에도 앱에 `gks`가 들어왔다. 화상 키보드의 Windows 무결성 수준은 조작 도구보다 높았다. 장치 재조회 결과 Windows가 인식한 펜은 0개, 터치는 1대이며 동시 접점은 최대 10개다. 실물 필압과 두 손가락 조작은 미검증이다.

### 공통 입력부터 GDI 화면 관측까지

두 앱 모두 Windows 설치본을 사용했다. 동일한 1920×1260 클라이언트, 150% 배율, 2560×1440 모니터, Studio Dark 테마, 100% 줌, 초기 투명 단일 레이어 800×600 그림을 맞췄다. 각 설치본에서 같은 33개 문서 좌표에 Windows 합성 마우스 클릭을 보냈다. 브러시 크기는 12 px, 색상은 `#1679EA`이며 각 앱의 앞 3번은 워밍업으로 제외했다. 나머지 30행이 양쪽에서 모두 유효했다. [공통 화면 계측 절차](../bench/windows-input-display.md)

| Windows 화면 관측 | Tauri | GPUI |
| --- | ---: | ---: |
| 유효 클릭 표본 | 30 | 30 |
| 입력부터 색상 관측 중앙값 | 24.33 ms | 20.19 ms |
| p95 | 34.93 ms | 25.55 ms |
| 최솟값–최댓값 | 18.14–35.83 ms | 16.52–25.86 ms |
| 기록된 가장 긴 폴링 간격 | 15.89 ms | 13.66 ms |

마우스 훅의 QPC부터 클릭 주변 17×17 픽셀에서 브러시 색이 처음 검출된 GDI `BitBlt` 읽기 시각까지 재었다. Tauri의 DXGI 예비 실행에서 클릭과 실제 점은 확인했으나 해당 색을 관측한 DXGI 프레임을 기록하지 못해 두 앱 모두 GDI로 측정했다. 이 실행의 GPUI 값이 더 작았고 중앙값 차이는 약 4.14 ms다. 화면 읽기에는 폴링 대기가 포함된다. 단일 세션의 브러시 점 입력 비교이며 물리 펜, 연속 획, 디스플레이 주사 지연은 측정 범위 밖이다.

새 설치본은 `dist/windows-compare/followup/myPaint-Studio-GPUI-Compare-validated-x64-setup.exe`에 있다. 두 앱의 원시 표본과 집계는 같은 폴더 아래 `evidence/approved-desktop/`의 `gpui-gdi-formal.csv`, `tauri-gdi-formal.csv`, `gdi-formal-summary.json`에 있다. `gdi-conditions.json`에서 양쪽 33개 위치가 같은 문서 좌표였음을 검증했다.

## 후속 이식과 Windows 검증

아래는 권한 재승인 전의 이식 및 검증 기록이다.

후속 구현은 GPUI 비교판 `620584c`에서 시작했다. Tauri의 Windows 편집 화면을 기준으로 GPUI의 상단 바, 문서 탭, 아이콘 도구 모음, 캔버스, 색상환과 지우개·브러시·레이어 패널, 상태 표시줄을 재구성했다. 기본 Studio Dark와 Classic 98의 색상, 버튼 밀도와 메뉴 범주를 이식했다. 실제 Tauri 설치본의 첫 화면을 확인했고 GPUI의 동일 항목을 소스와 대조했다. GPUI 설치본의 창은 생성됐으며, Windows 컴퓨터 사용 도구는 접근 검토에서 `Computer Use was not approved to use myPaint GPUI Compare`를 반환했다. 두 설치본의 실제 화면을 나란히 검수하는 절차와 마우스로 복구 메뉴를 여는 절차는 사용자 조작이 필요하다. [Tauri 화면 원본](../web-app/src/style.css) · [GPUI 화면 구성](../gpui-app/src/ui/chrome.rs)

| 후속 범위 | 동작 |
| --- | --- |
| 내보내기 | 확정 전 편집이 반영된 PNG·JPG·BMP 미리보기, JPG·BMP 바탕색과 저장 이름 선택. 미리보기를 취소하거나 내보내도 편집 이력과 Redo를 보존한다. |
| 환경 설정 | 스킨, 조작부 크기, 지우개 방식과 마지막 지우개 배경색을 프로필에 원자적으로 저장한다. 투명 모드로 전환해도 마지막 배경색을 기억한다. |
| 멀티터치 | 캔버스의 Windows 포인터 접점에서 한 손가락 그리기 또는 이동과 두 손가락 이동·확대를 처리한다. 두 번째 접점이 닿으면 그리던 획을 취소하고 취소 전 이력과 Redo를 보존한다. |

### 최종 Windows x64 설치본 검사

NSIS 설치본 `myPaint-Studio-GPUI-Compare-x64-setup.exe`를 사용자 범위에 설치했다. 패키지 크기는 4,573,939 bytes, SHA-256은 `d6e3027d404fcaed8af99e86b44d80fc877e85c520c2addd1c8227d620a8cb3c`다. 설치된 실행 파일은 16,758,272 bytes이며 릴리스 산출물과 SHA-256 `01b7e1242a9410d74d123e569c00f5612e46915bd2f6dac63ac2795baa990d93`이 일치했다. 같은 테스트 프로필에 설치본 프로세스를 두 번 실행해 두 검증 JSON과 종료 코드 0을 얻었다.

| 항목 | 확인 범위와 결과 |
| --- | --- |
| 환경 설정 재시작 | 첫 프로세스에서 실제 설정, 적용 명령을 호출했다. 두 번째 프로세스의 스킨은 Classic 98, 조작부 크기는 마우스, 지우개는 배경색 방식, 배경색은 `#255095`였다. 브러시 설정에도 같은 배경색이 적용됐다. |
| 탭 전환과 복구 메뉴 | 미확정 픽셀을 가진 탭에서 전환해 복구 사본 하나를 저장했다. 재시작 뒤 복구 메뉴가 사용하는 명령과 사본 선택 처리를 호출해 4×3 문서, 레이어와 투명도를 포함한 RGBA 값이 일치했다. 캔버스가 48바이트 타일을 준비했다. |
| 한글 조합 | 설치 프로세스의 실제 문자 입력 필드에서 `TextField` 핸들러를 직접 호출했다. `ㅎ → 한 → 한글`의 조합 범위 유지와 확정 후 조합 범위 해제 및 문자열 일치를 확인했다. Windows는 한국어 Microsoft IME를 열거했으며 키보드에서 IME로 들어오는 실입력 검증은 남아 있다. |
| 펜·터치 | Windows는 ILITEK 터치스크린 1개, 동시 접점 10개, 펜 장치 0개를 열거했다. 멀티터치 상태 전이와 Redo 보존은 Windows Rust 검사에서 확인했다. 두 손가락으로 화면을 직접 조작하는 검수와 실물 펜 필압은 미검증이다. |
| 회귀 검사 | GPUI Windows Rust 테스트 67개와 Tauri 기준 Node 테스트 359개를 통과했다. Vite 빌드 및 체크아웃 줄바꿈을 자동 판정한 Prettier 검사도 통과했다. |

설치본과 로컬 원시 증거는 `dist/windows-compare/followup/`의 `evidence/gpui-final-install.json`, `gpui-installed-smoke-*.json`에 있다. 재현 시 새 테스트 폴더와 매번 새 결과 파일을 사용한다. 아래를 순서대로 실행하며 두 번째 명령은 첫 실행의 종료를 기다린다. [설치본 검증 모드](../gpui-app/src/ui/smoke.rs) · [Windows 장치 열거 API](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-getpointerdevices)

```powershell
Start-Process $installedGpui -ArgumentList "--persistence-root `"$profile`" --windows-smoke save --windows-smoke-report `"$saveReport`"" -Wait
Start-Process $installedGpui -ArgumentList "--persistence-root `"$profile`" --windows-smoke reload --windows-smoke-report `"$reloadReport`"" -Wait
```

### 같은 Windows 입력과 화면 표시 지연

두 앱에 공통으로 쓸 Windows 계측기를 작성했다. 대상 창이 전경에 있을 때 `WH_MOUSE_LL`의 마우스 누름 QPC를 시작으로 기록한다. 화면에 표시된 클릭 주변에 같은 브러시 색이 나타나면 DXGI Desktop Duplication의 `LastPresentTime` QPC를 종료 시각으로 기록한다. 대상의 창과 클릭 주변 영역을 검증하며 클릭을 생성하거나 화면을 저장하지 않는다. 두 앱에는 같은 줌·브러시·색상·마우스 입력과 동일 디스플레이를 사용하고, 준비 클릭과 본 표본을 구분한다. 패널 주사나 펜 장치의 물리적 지연은 이 지표의 범위 밖이다. [실행 절차](../bench/windows-input-display.md) · [Windows 마우스 훅](https://learn.microsoft.com/windows/win32/winmsg/lowlevelmouseproc) · [DXGI 표시 타임스탬프](https://learn.microsoft.com/windows/win32/api/dxgi1_2/ns-dxgi1_2-dxgi_outdupl_frame_info)

Windows 사용자 세션에서 두 설치본을 각각 시작해 동일한 DXGI 모드와 마우스 훅까지 연결했다. 두 창의 실제 클라이언트는 1920×1260, DPI는 144, 대상 모니터는 2560×1440이었다. 두 파일 모두 클릭 감지 없이 15초가 지나 유효 표본은 Tauri 0개, GPUI 0개다. 데스크톱 조작 도구는 Tauri 창 활성화에 실패했고 GPUI 조작은 승인하지 않았다. 아래 최초 비교의 내부 rAF·paint 수치는 각 빌드의 역사적 값이다. 후속 빌드의 입력 표시 지연 비교는 미측정이다. 로컬 원시 기록은 `evidence/desktop-benchmark-pilot*.json`과 `evidence/dxgi-pilot-*.csv`에 있다.

## 최초 Windows 비교 기록

아래 측정과 패키지 크기는 비교판 `620584c`의 빌드에 해당한다.

## 비교 환경과 구현 범위

원래 `codex/studio-recovery`의 `48e4058`과 당시 미커밋 변경을 별도 worktree에 보존했다. 변경 파일 33개의 raw SHA-256을 복제 전후 비교했다. 비교 브랜치의 `web-app/`은 Tauri 설치형과 기존 웹 제품을 생산한다. `gpui-app/`은 Rust/GPUI만으로 그림을 편집하는 독립 실행 파일을 생산한다. `bench/`는 같은 그림과 획 입력, 파일 왕복, Windows 측정 스크립트를 제공한다.

MSVC x64, Microsoft Visual Studio Build Tools 17.11.5, Windows SDK 10.0.22621.0, Rust 1.100.0을 사용했다. Tauri는 잠금 파일의 2.12.5와 Windows WebView2 157.0.4341.46을 사용했다. GPUI는 Zed GPUI의 registry 재패키징 `gpui-pre`와 `gpui-pre-platform`을 각각 0.3.12로 고정했다. Windows 설치본은 사용자 범위에 다른 제품명·App ID·설치 경로로 등록했다. 측정은 매 실행에 별도 `--persistence-root`를 사용했다. 패키지는 로컬 비교용 미서명 빌드다. [GPUI 의존성 잠금 파일](../gpui-app/Cargo.lock) · [GPUI 설치 스크립트](../gpui-app/windows/installer.nsi) · [기존 기술 비교](GPUI_MIGRATION_ASSESSMENT.md)

| 영역 | GPUI 이식 범위 |
| --- | --- |
| 편집 엔진 | Rust RGBA 레이어, 합성, 브러시·연필·지우개·스프레이·채우기, 리비전·이력, 클립된 픽셀 영역. PNG 투명 RGB와 소스 레이어 픽셀을 보존한다. |
| 편집 명령 | 사각/자유 선택, 복사·잘라내기·붙여넣기, 도형과 곡선, 문자, 자르기, 크기, 회전·반전·기울이기, 레이어와 카메라, 다중 탭 UI. GPUI 네이티브 UI와 타일 렌더러를 추가했다. |
| 파일 | 기존 RPAINT01, PNG·JPEG·BMP·GIF 입력, PNG·JPEG·BMP 내보내기, Windows 파일 선택과 별도 복구 저장소. 원자 쓰기·저장 경로 제약은 기존 Rust 모듈을 사용한다. 비활성 탭 해제는 활성 세대를 건드리지 않는다. |
| Windows 입력 | 마우스와 GPUI 키 입력, 텍스트 조합 인터페이스, Windows 포인터 필압 연동을 구현했다. 물리 장치의 필압과 한글 IME 및 접근성은 실기기 인수 항목이다. |

픽셀 엔진의 레거시 기준 테스트 8개, 현재 TS 엔진을 독립적으로 실행한 512개 브러시와 224개 변형의 차등 검사, 편집기·엔진 14개, 실제 Rust 엔진·코덱·저장 경계의 44개가 독립 Windows MSVC 실행에서 통과했다. 검사 집합에는 겹치는 엔진·저장 케이스가 있다. 통합 `cargo check --offline --locked --all-targets`는 통과했고 미사용 메서드·이력 라벨 경고가 남았다. Tauri 기준 Node 회귀는 고정 fixture의 체크아웃 줄바꿈을 원본과 맞춘 뒤 359개가 통과했다. 텍스트 렌더링은 `cosmic-text`, 벡터 도형은 `tiny-skia`를 사용한다. 글자와 도형의 안티앨리어싱, 확대·축소 화면 샘플은 기존 Canvas와 전체 이미지 동등성을 별도로 검사해야 한다. [편집기](../gpui-app/src/editor.rs) · [엔진](../gpui-app/src/engine.rs) · [파일 및 저장](../gpui-app/src/io.rs)

## Windows 설치와 파일·복구 확인

Tauri의 설치 실행 파일 SHA-256은 `ff481b92f2d071dc0fb02e203aa1d3d185710953657db2fa35d16b6dfb4bf611`이다. NSIS 설치 경로와 Windows 제거 항목을 확인했다. 설치본에서 네 가지 실제 WebView2 실행이 각각 종료 코드 0을 반환했다. 67,126,671 bytes의 복구 왕복 픽셀, stale 읽기·삭제와 오래된 세대, 이전 Qt 복구 데이터 원본 보호, GIF, 종료 취소, 장면 렌더를 확인했다.

설치본에서 브러시 입력을 넣고 실제 탭을 전환했다. 프로세스를 강제 종료하고 동일 격리 프로필로 재실행한 뒤 복구 대화상자에서 20개 캔버스 표본이 모두 일치했다. 복구 envelope는 36,641 bytes였으며 내부 `.rpaint`는 36,515 bytes였다. 복구 전후 envelope가 같았고, 프로젝트 SHA-256은 `f0861d47828c7d1c86cfd3f3fcd60a9802f46d9165cc8f78588ff8314a4b85e4`였다. [설치 Tauri 테스트](../bench/tauri-windows.mjs)

GPUI 설치 실행 파일 SHA-256은 `f04e6872a6e7e4d91b226643761341e7a59c71ae3f08976ef93b7c7fffdc4759`이다. 릴리스 빌드에서 생성한 exe와 설치본이 일치했다. 이 exe로 Qt 원본(32×24·2레이어), TS 기준 프로젝트(73×47·3레이어), 위 설치 Tauri가 쓴 프로젝트(2048²·1레이어)를 읽었다. GPUI에서 다시 저장한 파일을 TS 디코더로 읽었고 크기·배경·레이어 이름·보임·RGBA 해시가 세 경우 모두 일치했다. 각 입력에 대해 픽셀을 바꿔 복구를 기록하고 별도 프로세스에서 예상 픽셀을 복원했다. 원본 해시 보존, 닫힌 저장 경로 해제, 늦은 복구 쓰기 거부도 세 경우 모두 통과했다. 프로젝트 압축 바이트는 다를 수 있다. [설치본 교차 테스트](../bench/codec-interop.mjs)

반대 방향은 GPUI 설치본이 복구 후 저장한 `5d51e5f8…` 프로젝트를 Tauri 설치본의 격리된 이전 복구 폴더에 넣고 실제 복구 대화상자로 열어 검증했다. 탭 전환 뒤 Tauri가 새 `RPREC001` 사본 36,661 bytes를 기록했다. 원본과 다시 복구한 전체 레이어의 RGBA SHA-256 `2b584c8aee808a9ec5eeb22dc08bbaed8e9340907bf3b32c07ae65a193b6c794`, 크기·배경·레이어 정보가 일치했고 두 원본 파일의 바이트는 유지됐다. [Tauri 설치본 복구 화면 검증](../bench/tauri-windows.mjs)

GPUI 설치본의 일반 파일 로드 경로로 Tauri 원본과 GPUI가 복구한 파일을 각각 열었다. 서로 다른 프로필에서 첫 네이티브 프레임을 그린 뒤 종료하는 점검이 두 경우 모두 성공했다. 별도 Windows 컴퓨터 사용 도구는 GPUI 테스트 창을 발견했으나 `Computer Use was not approved to use mypaint-gpui`를 반환했다. GPUI의 복구 저장과 재실행은 설치본의 검증 모드로 실행했다. GPUI의 복구 메뉴 조작과 실물 펜·한글 IME·키보드 접근성 검수는 남았다.

| Windows x64 로컬 배포물 | Tauri | GPUI |
| --- | ---: | ---: |
| NSIS 패키지 | 2,200,424 bytes | 4,160,727 bytes |
| 설치된 실행 파일 | 9,927,680 bytes | 14,924,288 bytes |

설치 파일 크기는 이 두 개의 배포 구성에서 측정했다. Tauri의 시스템 WebView2 런타임, 두 앱의 사용자 캐시, GPUI 그래픽 드라이버 구성 요소는 위 숫자에 포함되지 않는다.

## 성능 측정에서 비교하는 범위

설치된 릴리스 프로그램은 동일 Windows PC에서 번갈아 새 프로세스로 시작한다. 공통 시작 도구는 실행에서 보이는 메인 창을 감지할 때까지의 시간, Windows 입력 idle, 정해진 안정화 시간 이후의 프로세스 트리 private bytes를 저장한다. WebView2의 보조 프로세스를 포함하며 VRAM을 포함하지 않는다. 첫 창 감지와 실제 편집 가능 화면은 각각 다른 측정점이다. [공통 시작·메모리 도구](../bench/windows-startup.ps1)

2048×2048 투명 그림의 브러시 크기 12, 경도·불투명도 100%, 보정 0으로 동일 문서 좌표의 20획을 적용한다. 설치 Tauri의 CDP는 실제 WebView2 포인터 입력 후 `requestAnimationFrame` 콜백 시점을 기록한다. 설치 GPUI는 네이티브 윈도우 프레임에서 편집 제어부에 입력을 재생하고 렌더 호출 반환을 기록한다. 화면 주사·펜 하드웨어를 포함한 지연이나 동일 타이밍 지표로 환산하지 않는다. [공통 획 좌표](../bench/brush-workload.json) · [GPUI 프레임 실행기](../bench/gpui-windows.ps1)

### 같은 Windows 시작·메모리 지표

| 지표 | Tauri | GPUI |
| --- | ---: | ---: |
| 준비 실행 제외 측정 수 | 8 | 8 |
| OS에서 메인 창 감지까지 중앙값 | 54.8 ms | 517.6 ms |
| 첫 Windows 입력 idle 중앙값 | 115.9 ms | 518.0 ms |
| 고정 안정화 후 프로세스 트리 private memory 중앙값 | 244.5 MiB | 125.3 MiB |
| 안정 idle 판정 도달 | 3/8 | 8/8 |

동일한 첫 창 지표는 Tauri가 먼저 도달했다. 이 지표는 창에 편집 표면이 그려진 시점을 검증하지 않는다. 같은 안정화 시점에서 GPUI의 private bytes는 약 49% 적었다. 별도로 판정한 안정 idle은 Tauri와 GPUI 표본 수가 달라 주 비교는 고정 시간 값을 사용했다. 프로세스 트리를 집계했으므로 별도의 시스템 공유 메모리나 VRAM은 제외한다. [측정 방법](../bench/windows-startup.ps1)

### 앱별 브러시 시간과 픽셀 확인

| 실행과 측정점 | 횟수 | p50 | p95 |
| --- | ---: | ---: | ---: |
| Tauri 1레이어, 단일 이벤트 핸들러 후 다음 rAF | 1,080 이벤트 | 0.8 ms | 5.0 ms |
| Tauri 1레이어, 단일 이벤트 핸들러 후 그다음 rAF | 1,080 이벤트 | 6.0 ms | 10.4 ms |
| Tauri 16레이어, 단일 이벤트 핸들러 후 다음 rAF | 1,080 이벤트 | 0.7 ms | 4.8 ms |
| Tauri 16레이어, 단일 이벤트 핸들러 후 그다음 rAF | 1,080 이벤트 | 6.6 ms | 10.8 ms |
| GPUI 1레이어, 한 획 제어부 적용 | 60획 | 6.97 ms | 8.00 ms |
| GPUI 1레이어, 한 획 적용 시작부터 Canvas paint 반환 | 60획 | 9.26 ms | 10.60 ms |
| GPUI 16레이어, 한 획 적용 시작부터 Canvas paint 반환 | 60획 | 17.19 ms | 20.40 ms |

Tauri CDP를 붙여 첫 편집 가능 화면을 관찰한 중앙값은 1,724.2 ms다. CDP 연결이 포함돼 GPUI 첫 프레임 내부 타이머와 직접 비교하지 않는다. 두 앱 모두 DPR 1.5였다. Tauri 편집 영역은 920.67×668 CSS 픽셀과 줌 0.31055였고, GPUI는 941.33×716 논리 픽셀과 줌 0.33398이었다. 같은 문서 좌표를 사용했지만 생성 입력은 Tauri의 실제 브라우저 CSS 좌표와 GPUI 제어부 직접 입력으로 달랐다. 저장된 브러시 그림의 해시도 다르다. 브러시 모델의 픽셀 동등성은 좌표를 똑같이 넣은 독립 차등 검사에서 확인했다. 이 수치로 두 설치 앱의 펜 지연 우열을 결정할 수 없다.

## 적용 판단과 남은 동등성

GPUI는 이 PC에서 창이 뜨는 데 시간이 더 걸렸고, 유휴 상태의 앱 프로세스 메모리는 적었다. GPUI 설치 파일은 약 1.89배였다. 고주사율 그림 편집 성능으로 선택하려면 두 앱의 입력을 같은 OS 경로로 보내고 표시된 첫 변화까지 같은 계측으로 기록해야 한다. 8192×4096·2레이어의 화면 계측과 GPU 메모리 비교도 추가 대상이다.

주요 그림·파일 명령을 네이티브 앱으로 연결했다. 현행 Tauri의 내보내기 미리보기, 재시작 뒤 환경 설정 유지, 여러 터치 접점 제스처와 기존 도형·문자·축소 화면의 픽셀 동등성은 작업이 남아 있다. 실물 Windows 펜, 한글 조합, 접근성 도구 검수, GUI 복구 메뉴는 기능 확정 대상이다. 제품 기본 경로는 현행 Tauri를 유지하고 GPUI는 측정 가능한 Windows 비교판으로 사용하는 것을 권장한다.

## 패키지와 원시 결과

비교 worktree의 `dist/windows-compare/tauri/`와 `dist/windows-compare/gpui/`에 실제 설치에 사용한 파일이 있다. `dist/windows-compare/evidence/`에는 설치 실행 파일 SHA-256, Windows 실행과 브러시 원시 데이터, 파일 교차 검증 결과를 보존한다. 브랜치에서 다시 만들 때는 [Tauri 비교 설정](../bench/tauri-compare.json)과 [GPUI 패키지 도구](../gpui-app/windows/package.ps1)를 사용한다.

Visual Studio x64 개발자 셸에서 브랜치 루트를 열고 릴리스 설정으로 빌드한다.

```powershell
Push-Location web-app
npm.cmd ci --no-fund
node node_modules/@tauri-apps/cli/tauri.js build --target x86_64-pc-windows-msvc --bundles nsis --config ../bench/tauri-compare.json --no-sign --ci -- --locked
Pop-Location
cargo build --manifest-path gpui-app/Cargo.toml --release --locked
```

GPUI 빌드 실행 파일, 새 설치 패키지 출력 경로, Tauri 빌드가 받은 `makensis.exe`의 경로를 `gpui-app/windows/package.ps1`에 모두 절대 경로로 전달한다. 두 빌드 후 다른 설치 경로와 테스트 프로필을 고른다. 브러시 타이밍은 `tauri-windows.mjs`의 `BENCH_LAYERS=1`과 `16`, `gpui-windows.ps1`의 `-Layers 1`과 `16`으로 재현한다.
