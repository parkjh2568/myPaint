# 웹 빌드와 홈페이지 반영

로컬 화면 테스트는 [루트 OS별 안내](../README.md)를 먼저 따른다. 아래는 별도 홈페이지 저장소로 산출물을 옮기는 고급 절차다. 소스 `myPaint`와 홈페이지 `parkjh2568.github.io`를 형제 폴더로 관리한다. 각 저장소의 `origin`만 사용하며 웹 빌드가 Git staging·commit·pull·push를 수행하지 않는다.

## Studio 웹 빌드

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

Studio 버전 ID는 전체 배포 파일의 해시로 정한다. 기본 반영은 이전 Studio의 Worker·JPEG 지연 로딩 자산과 이전 릴리스·공유 고지를 보존한다. `--prune`은 이 이전 파일을 제거하므로 열려 있던 이전 탭이나 직접 버전 URL이 이후 자산을 읽지 못할 수 있다. Git 과거 이력의 대형 blob은 파일 정리로 줄어들지 않는다.

기존 산출물의 수동 변경·미확인 파일·symlink·staged mypaint 변경은 덮어쓰지 않는다. 복사 실패에는 기존 폴더를 유지하고 설치 rename 실패에는 백업 복원을 시도한다. 두 번의 rename 사이 경로가 잠시 없을 수 있으며 전원 차단까지 복구하는 원자 교체를 보장하지 않는다. 중단 후 `dist/.studio-build-lock`, `dist/.studio-previous`, 홈페이지의 `.mypaint-build-lock`·`.mypaint-backup-*`가 남으면 실행 중 작업과 양쪽 manifest를 확인한다. 복원도 실패하면 오류에 표시된 백업을 보존하고 검토한다.

```sh
python3 tests/test_stage_web.py
python3 tests/test_build_studio.py
# 개발용 Playwright Chromium을 준비하고 위 localhost 서버를 띄운 뒤
PAINT_TEST_URL=http://127.0.0.1:8000/mypaint/ npm --prefix web-app run test:jpeg-orientation
```

Studio 브라우저 회귀는 별도 브라우저를 쓸 때 `PAINT_BROWSER_PATH`를 사용한다. [JPEG 방향 검증 범위](evidence/studio-jpeg-orientation.json)는 실제 Chrome 8방향과 HTMLCanvas 대체 경로·기본 문서 오류 보존이며 전체 플랫폼 인수가 아니다.
