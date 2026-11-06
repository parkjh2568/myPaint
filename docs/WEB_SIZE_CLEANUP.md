# 홈페이지 용량 정리

2026-11-04. 사용자 요청에 따라 `parkjh2568.github.io`의 현재 배포 파일과 Git 이력을 구분해 조사했다.

## 원인

`mypaint/`는 109,532,751바이트(104.46 MiB)였다. 이 중 Qt 전체 소스 압축파일이 약 64.85 MiB이며, 동일한 JS/Wasm/HTML을 가진 release 폴더 두 개가 약 19.26 MiB씩 있었다. 빌드 도구가 Git commit·dirty를 포함한 manifest 전체로 release ID를 만들고 이전 release를 무기한 보존해, 소스 commit만 바뀐 재빌드에서도 실행 파일이 중복됐다.

기존 홈페이지 글꼴 네 개는 CSS body·h1·div·weather에서 실제 사용하고 있어 보존했다. 기존 HTML·CSS·JS·이미지·workflow 18개 파일과 Git index는 변경하지 않았다.

## 정리

- 수정하지 않은 Qt commit `025bdad181de241e81bf853c8a2d7bf3d19261a9`는 공식 다운로드 링크로 제공한다. 공식 압축파일을 실제로 내려받아 로컬 전체 Qt 소스 23,476개 파일의 SHA-256을 비교했고 모두 일치했다.
- 앱 소스·빌드 도구·재링크 안내·Qt/런타임/폰트 라이선스는 배포 폴더에 유지한다.
- 기본 패키지에서 전체 Qt 소스 압축파일을 제외한다. 자체 완결 묶음은 `--bundle-qt-source`로 선택한다. 배포자는 공식 소스 다운로드 가용성을 유지해야 하며, 확인한 로컬 백업도 홈페이지 밖에 보관했다.
- 같은 실행 파일·HTML은 활성 release 경로를 재사용한다. Git 메타데이터만 바뀌어 중복 Wasm을 생성하지 않는다.
- `--prune`은 해시·소유 manifest를 확인한 예전 release·미사용 공유 파일만 정리한다. 수동 수정과 staged 변경은 덮어쓰지 않는다.

정리 직후(드로잉 UI 적용 전) `mypaint/`는 21,340,772바이트(20.35 MiB)로 88,191,979바이트(약 80.5%) 감소했다. 활성 경로 `8c8698fbee718d079f6db636`와 실행 파일 네 개의 바이트는 그대로다. 이전 전체 폴더는 myPaint의 무시되는 `build-web-work/cleanup/homepage-mypaint-before`에 보관했다. 실제 정리 결과와 브라우저 검증은 `build-web-work/cleanup`에 있다.

## Git 이력

최초 조사 시 `.git` 약 115 MiB는 현재 파일과 별개다. 과거 커밋에는 Qt 압축파일 외에 예전 `node_modules`의 Tauri CLI(13.82 MiB), esbuild(9.47 MiB), TypeScript(8.51 MiB)도 있었다. 현재 작업 트리에 node_modules가 있는 것은 아니다. 파일 삭제 커밋만으로 이 blob이 이력에서 사라지지는 않는다.

이미 origin/main에 게시된 이력을 줄이는 작업은 커밋 ID 재작성과 원격 강제 반영을 수반한다. 이번 정리는 현재 배포 파일과 재발 방지 도구에 적용했으며 Git 이력·리모트·커밋·push는 변경하지 않았다.

## 근거

[LGPLv3 4(d)](https://raw.githubusercontent.com/qt/qtbase/025bdad181de241e81bf853c8a2d7bf3d19261a9/LICENSES/LGPL-3.0-only.txt)와 [GPLv3 6(d)](https://raw.githubusercontent.com/qt/qtbase/dev/LICENSES/GPL-3.0-only.txt)는 대응 소스와 재링크 자료 제공을 규정한다. 다른 서버에서 소스를 제공할 경우에도 명확한 안내와 지속적인 가용성이 필요하다. 라이선스 페이지에서 검증한 정확한 [공식 Qt 소스](https://codeload.github.com/qt/qtbase/tar.gz/025bdad181de241e81bf853c8a2d7bf3d19261a9)를 직접 안내한다.

이후 공통 드로잉 UI 적용 결과와 최종 산출물은 [STUDIO_UPGRADE.md](STUDIO_UPGRADE.md)를 참고하세요.
