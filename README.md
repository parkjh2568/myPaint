# myPaint Studio

myPaint Studio 0.2.0은 로컬에서 그림을 그리고 `.rpaint` 프로젝트나 이미지로 저장하는 그림판입니다. 브러시·도형·선택·문자·레이어와 여러 문서 탭을 지원합니다. Studio Dark와 Classic 98은 상단 **설정**에서 선택합니다.

## 빌드 및 실행

| 대상 | Windows | macOS |
| --- | --- | --- |
| Tauri 데스크톱 앱 | [앱 테스트](WINDOWS_APP_TEST.md) | [앱 테스트](MACOS_APP_TEST.md) |
| 웹 편집기 | [웹 테스트](WINDOWS_WEB_TEST.md) | [웹 테스트](MACOS_WEB_TEST.md) |

- `web-app/`에는 TypeScript 편집기와 Tauri/Rust 데스크톱 앱이 있습니다. 모바일과 태블릿에서는 웹 편집기를 사용합니다.
- GPUI 비교판의 코드와 Windows 실측은 [codex/gpui-compare](https://github.com/parkjh2568/myPaint/tree/codex/gpui-compare)에서 확인할 수 있습니다.

## 개발과 검증

[프로젝트 인수인계](PROJECT_HANDOFF.md) · [현재 상태와 검증 범위](docs/CURRENT_STATUS.md) · [기술 문서](docs/README.md) · [작업 연혁](docs/PROJECT_HISTORY.md)

작업 중인 그림은 **프로젝트**에서 `.rpaint`로 저장하고, PNG·JPG·BMP 파일은 **내보내기**에서 만듭니다. 새 그림은 투명으로 시작하며 지우개의 투명·배경색 모드는 우측 색상·브러시 패널에서 바꿉니다. 저장 전에 종료된 편집 사본은 메뉴의 **복구 사본**에서 찾을 수 있습니다.

[MIT 라이선스](LICENSE) · [외부 의존성 고지](NOTICE.md) · [작업 규칙](AGENTS.md)
