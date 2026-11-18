# myPaint Studio

myPaint Studio 0.2.0은 로컬에서 그림을 그리고 `.rpaint` 프로젝트나 이미지로 저장하는 그림판입니다. 브러시·도형·선택·문자·레이어와 여러 문서 탭을 지원합니다. Studio Dark와 Classic 98은 상단 **설정**에서 선택합니다.

## 로컬 웹 편집기 시작

처음 한 번 **Node.js 24 이상과 npm**을 준비한 뒤 저장소 루트에서 `npm ci --prefix web-app`을 실행합니다. Windows PowerShell에서는 `npm.cmd ci --prefix web-app`을 사용합니다. 기존 lockfile로 웹 의존성만 준비하며 Python·Docker·Rust는 이 실행에 필요하지 않습니다. 루트에서 별도의 `npm install`은 필요 없습니다.

이후 매일 저장소 루트에서 한 줄로 실행합니다.

```sh
npm run start:local
```

Windows PowerShell: `npm.cmd run start:local`. 화면은 **http://127.0.0.1:8922/** 에서 열고, 실행한 터미널의 **Ctrl+C**로 종료합니다. 환경변수 export, `$env:`, `.env` 작성은 필요 없습니다. 브라우저를 자동으로 열지 않으며 기존 Windows/Mac 웹 편집기와 같은 화면을 제공합니다. Tauri 창·설치본과 GPUI는 아래 별도 안내를 사용합니다.

포트가 사용 중이면 기존 서비스를 그대로 두고 실패합니다. `npm run start:local -- --port 18922` (Windows: `npm.cmd run start:local -- --port 18922`)로 바꾸면 주소는 http://127.0.0.1:18922/ 입니다. 바인딩은 항상 loopback입니다. `--help`로 사용법을 확인할 수 있습니다.

설정 우선순위는 실행기의 포트 인자 → 기본 8922이며, 호스트·strictPort·자동 브라우저 열기 여부는 실행기가 고정합니다. 나머지는 기존 `web-app/vite.config.ts`를 재사용합니다. `.env`는 필요 없고 새 로컬 설정 파일도 만들지 않습니다. 기존 Vite 환경값은 프로세스 환경 → 모드별 `.env.*.local`/`.env.*` → 일반 `.env.local`/`.env` 순으로 우선하며, 이 값으로 실행기의 호스트·포트를 바꾸지는 않습니다. `VITE_` 값은 브라우저에 노출되므로 비밀을 넣지 마세요. 기존 `web-app`의 `npm run dev -- ...` 고급 실행 경로는 유지합니다.

검토에는 새 일반 브라우저 프로필과 테스트 파일 사본을 사용하세요. 실행기 자체는 복구 DB를 읽지 않지만, 브라우저에서 기존 origin을 열면 앱이 그 프로필의 기존 복구 목록을 읽을 수 있습니다. 포트를 바꾸면 origin과 복구 저장소도 달라집니다. 기존 사이트 데이터는 지우지 말고 `.rpaint` 파일로 별도 보관하세요.

실제 검증 플랫폼과 남은 항목은 [현재 검증 기록](docs/CURRENT_STATUS.md)을 참고하세요.

## 빌드 및 실행

| 대상 | Windows | macOS |
| --- | --- | --- |
| Tauri 데스크톱 앱 | [앱 테스트](WINDOWS_APP_TEST.md) | [앱 테스트](MACOS_APP_TEST.md) |
| 웹 편집기 | [웹 테스트](WINDOWS_WEB_TEST.md) | [웹 테스트](MACOS_WEB_TEST.md) |

- `web-app/`에는 TypeScript 편집기와 Tauri/Rust 데스크톱 앱이 있습니다. 모바일과 태블릿에서는 웹 편집기를 사용합니다.
- `gpui-app/`은 별도의 Rust/GPUI Windows 비교판입니다. [Windows 실측과 재현 절차](docs/GPUI_WINDOWS_COMPARISON.md)에 빌드, 파일 호환, 복구와 입력 지연을 기록했습니다.

## 개발과 검증

테스트·빌드·패키징은 로컬에서 실행합니다. 이 브랜치의 GitHub Actions 검사 워크플로는 제거했습니다. 기본 검사와 선택형 브라우저·네이티브 실행은 [로컬 검사 안내](docs/LOCAL_CHECKS.md)를 따릅니다.

[프로젝트 인수인계](PROJECT_HANDOFF.md) · [현재 상태와 검증 범위](docs/CURRENT_STATUS.md) · [기술 문서](docs/README.md) · [작업 연혁](docs/PROJECT_HISTORY.md)

작업 중인 그림은 **프로젝트**에서 `.rpaint`로 저장하고, PNG·JPG·BMP 파일은 **내보내기**에서 만듭니다. 새 그림은 투명으로 시작하며 지우개의 투명·배경색 모드는 우측 색상·브러시 패널에서 바꿉니다. 저장 전에 종료된 편집 사본은 메뉴의 **복구 사본**에서 찾을 수 있습니다.

[MIT 라이선스](LICENSE) · [외부 의존성 고지](NOTICE.md) · [작업 규칙](AGENTS.md)
