# 그림판과 홈페이지 저장소 관리 방법

확인일: 2026-11-03. 두 저장소는 `/Users/jhpark/code/myService` 아래 각 폴더에서 관리한다. myPaint의 mypage 리모트는 제거했고 각 저장소는 자신의 origin만 사용한다. 웹 빌드 결과는 기존 홈페이지의 mypaint 폴더에 반영하되 커밋·push는 홈페이지 폴더에서 사용자가 별도로 수행한다.

## 저장소와 경로

| 용도 | 로컬 경로 | 리모트 |
| --- | --- | --- |
| 그림판 소스·웹 빌드 | `/Users/jhpark/code/myService/myPaint` | origin → parkjh2568/myPaint |
| 기존 홈페이지·게시 | `/Users/jhpark/code/myService/parkjh2568.github.io` | origin → parkjh2568/parkjh2568.github.io |
| 웹 결과물 | `/Users/jhpark/code/myService/parkjh2568.github.io/mypaint/` | 별도 Git 저장소 아님 |

두 main은 각각 자기 origin/main을 추적한다. 같은 origin 이름이어도 서로 다른 저장소다. 새 저장소·배포용 체크아웃을 만들거나 main 이력을 합치지 않는다.

## 폴더 이동 후 빌드

이전 `/Users/jhpark/code/myPaint`와 홈페이지 경로는 존재하지 않는다. 기존 build-macos·build-audit CMake 캐시는 옛 절대 경로를 포함하므로 그대로 재사용하지 않는다. 새 빌드 디렉토리에서 구성하고 기존 증거 로그는 당시 실행 경로를 그대로 보존한다.

## 소스 저장소의 동기화

현재 미커밋 개선분은 먼저 필요한 파일을 검토해 커밋하거나 별도로 보존한다. 다음은 main·깨끗한 작업 트리를 전제로 하는 절차다.

```sh
cd /Users/jhpark/code/myService/myPaint
git status --short --branch
git pull --ff-only origin main
# 변경을 검토하고 필요한 파일만 add·commit한 뒤
git push origin HEAD:main
```

기능 브랜치는 해당 브랜치를 origin에 push하고 PR로 합친다. 홈페이지 저장소의 이력을 이 폴더로 pull하지 않는다. ff-only가 실패하면 상태·양쪽 커밋을 확인하고 적절한 merge/rebase를 선택한다. 미커밋 변경을 reset·clean·force로 처리하지 않는다.

## 웹 산출물 반영

웹 빌드는 먼저 myPaint 내부에서 완성된 결과를 준비·검증하고, 성공한 산출물만 형제 홈페이지 저장소의 mypaint 폴더에 반영하는 구조로 구현했다. `python3 tools/build_web.py --host-qt /opt/homebrew`로 실행하며, SDK 준비·검증·실패 복원은 [웹 빌드 문서](WEB_BUILD.md)를 따른다.

- 대상은 홈페이지 루트 전체가 아니라 mypaint 하위로 고정한다.
- 기존 index.html·css·js·img·workflow와 다른 미커밋 변경을 보존한다.
- 대상 mypaint 안의 수동 수정·staged 변경·출처 불명 파일은 조용히 덮어쓰지 않는다.
- 빌드·검증 실패 시 기존 산출물을 교체하지 않는다. 복사 실패의 정리·복원 경계도 시험한다.
- 경로 탈출·심볼릭 링크·빈 경로·저장소 루트 대상으로의 삭제 동기화를 거부한다.
- 자동 fetch·pull·add·commit·push는 하지 않는다. 홈페이지 staging도 바꾸지 않는다.

빌드에는 GitHub 인증이 필요하지 않다. 인터넷 접속은 개발용 SDK 준비와 최초 웹 자산 로딩 등 별도 경계에서 다루며 사용자 그림을 업로드하지 않는다. 실제 홈페이지 push의 인증·권한은 홈페이지 작업에서 확인한다.

## 홈페이지 폴더에서 별도로 게시

웹 빌드 전 홈페이지의 필요한 작업을 보존하고 최신 상태로 동기화한다. 이후 산출물이 반영되면 그 폴더에서 변경을 검토한다.

```sh
cd /Users/jhpark/code/myService/parkjh2568.github.io
git status --short --branch
git pull --ff-only origin main
# myPaint에서 웹 빌드와 mypaint/ 반영 후
git status --short
git diff --name-status
git add -- mypaint/
git diff --cached --name-status
git diff --cached --stat
# 기존 staged 파일까지 포함한 커밋 내용을 확인한 뒤
git commit -m "feat: publish myPaint web build"
git push origin HEAD:main
```

pull은 산출물을 반영하기 전에 수행한다. 반영 뒤 변경이 남은 상태에서 무조건 다시 pull하지 않는다. 원격 변경으로 push가 거절되면 홈페이지 변경과 빌드 결과를 보존한 채 최신 이력을 통합하고 다시 검증한다. force push는 사용하지 않는다.

기존에 staged한 다른 홈페이지 파일도 일반 commit에 포함될 수 있으므로 `git diff --cached` 전체를 확인한다. 자동 빌드가 해당 staging을 수정하지 않도록 하는 것과 사용자가 최종 커밋 범위를 고르는 것은 별개다.

## Pages 게시 설정

로컬 `.github/workflows/deploy.yml`은 main push에서 root 전체를 artifact로 게시하도록 정의되어 있다. 이 설정이 유지되면 기존 홈페이지와 mypaint 폴더가 함께 게시된다. 그림판만 별도 Pages artifact로 보내 기존 사이트에 부분 병합될 것으로 가정하지 않는다.

push 뒤에는 Pages workflow 성공과 기존 홈페이지·기존 페이지·`https://parkjh2568.github.io/mypaint/`를 확인한다. 되돌리기는 홈페이지의 mypaint 산출물을 이전 버전으로 복원하는 새 커밋으로 수행한다.

## 인증과 검증 범위

홈페이지 origin은 현재 SSH URL이다. 이전 HTTPS의 누락된 gh helper 오류는 과거 조회 기록이며 현재 SSH 접근 가능 여부를 대신하지 않는다. 필요할 때 홈페이지 폴더에서 `git ls-remote --symref origin HEAD`로 읽기 접근을 확인하고, 읽기 성공을 push 권한 확인과 동일하게 취급하지 않는다.

현재 경로·로컬 Git 설정·workflow를 확인했다. 웹 빌드는 홈페이지의 mypaint 산출물만 반영하며 인증·origin·upstream·staging과 원격 커밋·push를 변경하지 않는다. 웹 기능의 구현·검증 상태는 [웹 구현 작업계획](WEB_IMPLEMENTATION_PLAN.md)을 참고한다.
