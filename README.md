# myPaint Studio

로컬에서 그림을 그리고 `.rpaint` 프로젝트와 이미지로 저장하는 그림판입니다. 현재 개발 버전은 **Studio 0.2.0**이며 `web-app/`을 사용합니다. 이번 작업 브랜치는 `style/win98-paint-skin`입니다.

## 내 컴퓨터에서 따라 하기

| 목적 | Windows (PowerShell) | macOS (터미널) |
| --- | --- | --- |
| 실제 앱 패키지 빌드·실행 | [Windows 앱 테스트](WINDOWS_APP_TEST.md) | [macOS 앱 테스트](MACOS_APP_TEST.md) |
| 웹 개발·배포용 빌드 테스트 | [Windows 웹 테스트](WINDOWS_WEB_TEST.md) | [macOS 웹 테스트](MACOS_WEB_TEST.md) |

- **앱**: Tauri/Rust가 로컬 파일·창을 관리합니다. Windows는 NSIS 설치 파일, macOS는 `.app`을 만듭니다.
- **웹**: 같은 편집기를 브라우저로 실행합니다. Rust/Qt 없이 Node만으로 개발·빌드할 수 있습니다. 모바일·태블릿도 웹 전용입니다.
- 테마는 상단 톱니 또는 메뉴 → 환경설정에서 Classic 98을 선택합니다. 기존 배치·기능을 유지하며 CSS 룩앤필만 변경했습니다.
- 개발용 패키지는 정식 서명·공증·배포 완료 제품이 아닙니다. 다른 OS에서 빌드 성공했다고 내 OS의 파일 대화상자·한글 입력까지 검증된 것은 아닙니다.

## 먼저 해볼 것

1. 브러시로 선을 그리고 Undo/Redo를 해봅니다.
2. 레이어를 추가하고 한글 문자를 입력합니다.
3. `.rpaint`로 저장한 다음 다시 열어 레이어와 그림을 확인합니다. 웹에서는 실제 다운로드 파일을 확인합니다.
4. PNG로 내보내고, 저장 취소·미저장 상태의 종료 취소가 원래 그림을 유지하는지 확인합니다.
5. Classic 98 ↔ Studio 스킨을 전환해 도구·팔레트·대화상자·창 크기를 확인합니다.

시작/새 캔버스의 기본 배경은 흰색입니다.

중요한 원본 대신 테스트용 파일로 진행하세요. 복구 사본은 별도 파일 백업을 대신하지 않습니다.

## 개발 문서

[필수 기술 문서와 남은 검증](docs/README.md) · [웹 배포 절차](docs/WEB_BUILD.md) · [Classic 98 변경·검증 한계](docs/STUDIO_CLASSIC98_SKIN.md)

과거 조사 보고서는 `docs/archive/`로 분리했고 중복된 초기 계획·환경 안내는 Git 이력에 남겼습니다. `src/`, `web/`, 루트 CMake는 Qt 호환성 기준 구현으로 보존하며 신규 Studio 실행 경로가 아닙니다. fixture, evidence, 라이선스는 삭제하지 않았습니다.

앱 소스: [MIT](LICENSE) · 외부 의존성: [NOTICE.md](NOTICE.md) · 작업 규칙: [AGENTS.md](AGENTS.md)
