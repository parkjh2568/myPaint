# macOS 앱 빌드·테스트

현재 Studio(`web-app/`) 기준입니다. **아래 명령은 한 줄씩 실행하고 오류가 나면 다음 단계로 넘어가지 마세요.** 처음 의존성을 받을 때는 인터넷이 필요합니다.

## 1. 도구 준비 (처음 한 번)

- [Git](https://git-scm.com/downloads), [Node.js 24](https://nodejs.org/en/download)를 설치합니다. 설치 후 새 터미널을 열고 `git --version`, `node --version`, `npm --version`을 확인합니다.
- [Rust 공식 설치](https://www.rust-lang.org/tools/install)로 rustup을 설치합니다. 이 프로젝트의 CI 기준은 Rust **1.94.0**입니다.
- `xcode-select --install`로 Xcode Command Line Tools를 설치합니다. [Tauri 공식 준비 안내](https://v2.tauri.app/start/prerequisites/#macos)

## 2. 소스 받기

테스트 폴더를 만들 상위 위치에서 실행합니다. `myPaint-test`가 이미 있으면 다른 빈 폴더 이름을 사용하세요. 기존 작업 폴더를 덮어쓰지 않습니다.

```sh
git clone --branch style/win98-paint-skin https://github.com/parkjh2568/myPaint.git myPaint-test
cd myPaint-test/web-app
npm ci
```

이후 명령은 모두 **`myPaint-test/web-app` 안에서** 실행합니다. 이미 받은 깨끗한 작업 폴더라면 해당 브랜치에서 `git pull --ff-only` 후 `npm ci`로 갱신할 수 있습니다. 분기 충돌이 나면 강제 reset하지 마세요.

## 3. 검사하고 실제 패키지 만들기

```sh
rustup toolchain install 1.94.0 --profile minimal --component rustfmt --component clippy
export RUSTUP_TOOLCHAIN=1.94.0
npm run format:check
npm test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run desktop:build
```

마지막 명령이 TypeScript 검사·웹 빌드·Rust 빌드와 패키징을 수행합니다. 개발 서버는 필요하지 않습니다.

**산출물:** `web-app/src-tauri/target/release/bundle/macos/myPaint Studio.app`. 현재 명령은 `.app`만 만들며 DMG는 만들지 않습니다.

```sh
open "src-tauri/target/release/bundle/macos/myPaint Studio.app"
```

현재 Mac 아키텍처용 앱입니다. Apple Silicon/Intel 둘 다 확인하려면 해당 기기에서 각각 빌드·실행해야 합니다.

서명·공증이 완료된 공개 배포본이 아닙니다. OS가 차단하면 출처·빌드 경로를 확인하고 보안 설정을 전역으로 끄지 마세요.

## 4. 직접 확인 (테스트 파일만 사용)

- [ ] 상단 톱니 또는 메뉴 → 환경설정에서 Classic 98 선택 후 도구·팔레트·대화상자·창 축소/확대가 정상이다.
- [ ] 그림과 레이어, 한글 문자를 만든 뒤 Undo/Redo가 된다.
- [ ] OS 저장 대화상자로 `.rpaint` 저장 → 앱 종료 → 재실행 → 열기에서 그림·레이어가 유지된다.
- [ ] PNG 내보내기 결과를 이미지 뷰어로 확인한다.
- [ ] 그림 수정 후 닫기 → 취소하면 편집 내용이 유지된다. 저장 대화상자 취소도 확인한다.
- [ ] 앱을 다시 시작한 뒤 로컬 복구 목록과 저장 파일을 구분해서 확인한다.

## 개발 중 빠른 실행 (선택)

`npm run desktop`은 개발 서버를 자동으로 띄우는 개발용 창입니다. **위 패키지 설치/실행 테스트를 대신하지 않습니다.** 동시에 `npm run dev`를 띄우면 8922 포트가 겹칠 수 있습니다.

## 막히면

- 의존성/검사 실패: 첫 오류를 먼저 해결하고 다음 단계를 재개하세요. `package-lock.json`을 지우거나 임의로 버전을 바꾸지 마세요.
- 설치형은 해당 OS에서만 빌드합니다. 웹 테스트 통과가 실제 앱의 OS 저장창·한글 IME·종료 동작 통과를 뜻하지 않습니다.

검증 기준과 남은 한계: [문서 색인](docs/README.md). 웹만 먼저 확인하려면 [macOS 웹 안내](MACOS_WEB_TEST.md).
