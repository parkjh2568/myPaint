# macOS 웹 버전 테스트

현재 Studio(`web-app/`) 기준입니다. **아래 명령은 한 줄씩 실행하고 오류가 나면 다음 단계로 넘어가지 마세요.** 처음 의존성을 받을 때는 인터넷이 필요합니다.

## 1. 도구 준비 (처음 한 번)

- [Git](https://git-scm.com/downloads), [Node.js 24](https://nodejs.org/en/download)를 설치합니다. 설치 후 새 터미널을 열고 `git --version`, `node --version`, `npm --version`을 확인합니다.
- Chrome 또는 Edge를 준비합니다. macOS에서는 Safari에서도 수동 동작을 확인하세요. Rust·Qt·Visual Studio는 웹 테스트에 필요하지 않습니다.

## 2. 소스 받기

테스트 폴더를 만들 상위 위치에서 실행합니다. `myPaint-test`가 이미 있으면 다른 빈 폴더 이름을 사용하세요. 기존 작업 폴더를 덮어쓰지 않습니다.

```sh
git clone --branch style/win98-paint-skin https://github.com/parkjh2568/myPaint.git myPaint-test
cd myPaint-test/web-app
npm ci
```

이후 명령은 모두 **`myPaint-test/web-app` 안에서** 실행합니다. 이미 받은 깨끗한 작업 폴더라면 해당 브랜치에서 `git pull --ff-only` 후 `npm ci`로 갱신할 수 있습니다. 분기 충돌이 나면 강제 reset하지 마세요.

## 3. 개발 화면 켜기

```sh
npm run dev
```

브라우저에서 **http://127.0.0.1:8922/** 를 엽니다. 종료는 터미널에서 `Ctrl+C`입니다. 다른 서버가 8922를 사용 중이면 자신이 띄운 서버를 먼저 종료하세요.

## 4. 배포용 빌드도 확인

개발 서버를 종료한 뒤 다음을 실행합니다.

```sh
npm run format:check
npm test
npm run build
npx --no-install vite preview --host 127.0.0.1 --port 8922 --strictPort
```

같은 **http://127.0.0.1:8922/** 를 새로고침합니다. 이 화면은 `web-app/dist/`의 빌드 결과입니다. `dist/index.html`을 더블클릭(`file://`)해서 열지 마세요. 홈페이지 게시나 Git push는 이 절차에 포함되지 않습니다.

## 5. 브라우저 자동 테스트

위 미리보기 서버를 켜 둔 상태에서 **두 번째 터미널을 `myPaint-test/web-app`에 열고** 실행합니다.

```sh
npx --no-install playwright install chromium
export PAINT_TEST_URL=http://127.0.0.1:8922/
npm run test:browser
```

이 명령은 기본 브라우저 회귀 묶음입니다. 모든 성능·실기기·Safari/Edge 검사를 포괄하지 않습니다. 전체 CI 묶음은 [studio.yml](.github/workflows/studio.yml)을 참고하세요.

## 6. 직접 확인 (테스트 파일만 사용)

- [ ] 상단 톱니 또는 메뉴 → 환경설정에서 Classic 98 ↔ Studio 전환 후 버튼·팔레트·대화상자와 작은 창 크기에서 확인한다.
- [ ] 그림·레이어·한글 문자를 만들고 Undo/Redo가 된다.
- [ ] `.rpaint` 다운로드 후 실제 파일이 생겼는지 확인하고 다시 열어 비교한다.
- [ ] PNG 내보내기 파일을 이미지 뷰어로 확인한다.
- [ ] 새로고침 후 브라우저 복구 목록을 확인한다. 사이트 데이터 삭제/시크릿 모드에서는 복구가 사라질 수 있다.
- [ ] 클립보드 권한 거절 시 파일 열기·내보내기로 계속 사용할 수 있는지 확인한다.

웹 다운로드 요청만으로 파일 저장 성공을 보장하지 않습니다. 복구는 브라우저·origin별로 분리되므로 `localhost`와 `127.0.0.1`, 개발 서버와 앱 사이에서 자동 공유되지 않습니다.

## 막히면

- 의존성/검사 실패: 첫 오류를 먼저 해결하고 다음 단계를 재개하세요. `package-lock.json`을 지우거나 임의로 버전을 바꾸지 마세요.
- 설치형은 해당 OS에서만 빌드합니다. 웹 테스트 통과가 실제 앱의 OS 저장창·한글 IME·종료 동작 통과를 뜻하지 않습니다.

검증 기준과 남은 한계: [문서 색인](docs/README.md). 실제 앱은 [macOS 앱 안내](MACOS_APP_TEST.md).
