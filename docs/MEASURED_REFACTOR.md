# 측정 기반 Studio 리팩터링

2026-11-08. 기준 커밋 `429f135`. 런타임 전면 교체보다 현재 병목과 실패 경로를 줄인다.

## 기사에서 채택한 원칙과 적용 범위

참고: [GeekNews 토론](https://news.hada.io/topic?id=36778), [Windows Latest 원문](https://www.windowslatest.com/2026/11/06/every-windows-11-app-should-kill-electron-and-discord-just-showed-why-no-starting-screen-and-70-less-ram-even-with-two-accounts-signed-in/).

사용자가 제공한 기사 요지는 시작 비용·메모리를 줄이고 네이티브/웹의 적절한 경계를 선택하자는 것이다. Discord 사례의 메모리 약 70% 감소를 myPaint의 목표 달성 근거나 동일 조건 비교로 옮기지 않는다. 이 문서는 기사 요지에 대한 프로젝트 판단이며 외부 구현을 검증한 보고서가 아니다.

- Studio는 이미 Electron이 아닌 TypeScript 엔진 + Tauri/Rust + 로컬 WebView다. GPUI 도입이나 Rust/WASM 엔진 이식은 측정·호환·접근성 이익이 확인된 뒤 별도 결정한다.
- Windows/macOS 설치형, 모바일/태블릿 웹 지원 범위를 유지한다. 기사에 Linux가 등장한다고 Linux 설치형 지원 완료를 선언하지 않는다.
- 원격 페이지, 업로드, 텔레메트리, updater, shell API를 추가하지 않는다. 로컬 UI 및 기존 CSP/IPC 경계를 유지한다.
- Qt는 활성 CMake 대상과 호환 fixture를 제공한다. 남은 인수를 우회하는 삭제 대신 README와 문서 색인에서 기준 구현으로 분리한다. 이 변경은 Qt 제거 완료가 아니다.

## 변경

1. 합성 루프는 투명 픽셀을 먼저 건너뛰고 불투명 픽셀은 직접 복사한다. 중간 alpha만 기존 혼합·반올림을 수행한다. 전체 65,536개 alpha 조합·다중/숨김 레이어·입력 불변성·독립 출력으로 기존 바이트 결과를 비교한다.
2. Windows 파일 교체 전에 writer를 닫고 identity가 같은 attributes-only handle을 유지한다. `ReplaceFileW` 부분 실패 1176/1177는 복구용 stage를 보존한다. Windows에 Unix 디렉터리 fsync를 시도하지 않는다. 실제 Windows 실패 주입을 했다는 뜻은 아니다.
3. Windows CI의 설치·포맷·Clippy·테스트·패키징을 분리해 앞선 native 명령 실패가 뒤의 성공으로 가려지지 않게 한다.
4. 빌드 출력의 경로는 raw substring 대신 JSON 파싱 후 비교한다. 웹 pan/paste 회귀는 임의 sleep 대신 위치·정확한 픽셀 조건을 기다린다.
5. README의 Studio/Qt 설명 충돌을 해소하고 [문서 색인](README.md)을 제공한다. 과거 검증 자료·라이선스·fixture는 보존한다.

## 재현 가능한 합성 측정

```sh
cd web-app
npm ci
node --import tsx tools/benchmark-composite.ts > /tmp/composite.json
```

[이번 원시 표본과 환경](evidence/composite-refactor-20261108.json): Node 워밍업 5회, 번갈아 실행한 21개 표본, 1024×1024의 두 레이어, 출력 할당 포함. 원본 알고리즘과 결과 바이트를 측정 전에 비교한다. 공유 호스트 한 회차이며 통계적 유의성·실제 UI·시작 속도·RSS 감소를 입증하지 않는다.

| 작업 | 원본 중앙값 ms | 변경 중앙값 ms |
| --- | ---: | ---: |
| 불투명 | 31.30 | 8.67 |
| 혼합 alpha | 22.07 | 14.20 |
| 투명 | 4.87 | 4.19 |
| 반투명 | 28.37 | 28.01 |

비교 대상이 Electron이 아니므로 위 수치를 런타임 교체 효과로 표현하지 않는다. 시작·메모리 개선은 동일 OS/하드웨어, 동일 문서·레이어·계정 없는 작업, warm/cold 분리, raw 표본, 전체 process tree RSS와 GPU 범위까지 정의한 별도 실험이 필요하다. 현재 [측정 방법](STUDIO_MEASUREMENT_METHOD.md)의 proxy 한계와 인수 예산을 유지한다. 키보드·IME·펜/터치·스크린리더와 OS별 저장 인수도 성능 수치로 대체하지 않는다.

## 로컬 검증

- Node 단위/계약 테스트 332/332, 실패·skip 없음 (`node --import tsx --test tests/*.test.ts`).
- Python staging 27/27, Studio build 17/17.
- Prettier, TypeScript, Vite 프로덕션 빌드 통과.
- 위 합성 벤치마크의 네 workload 출력 비교 통과.
- Rust toolchain이 없어 rustfmt·Clippy·native 테스트는 로컬 미실행. 실제 Windows/macOS, Qt CTest와 브라우저 통합 테스트도 로컬 미검증이다. 원격 CI와 플랫폼 인수 결과는 이 로컬 성공과 구분한다.

## CI에서 발견해 추가한 보강

- Windows의 같은 길이·같은 메타데이터 외부 덮어쓰기를 놓치지 않도록 수동 저장/열기 바인딩에 bounded SHA-256을 전파한다. 64KiB 버퍼, 기존 파일 300MiB 상한이며 recovery scan에 전수 해싱을 붙이지 않는다. 게시 핸들의 identity와 실제 쓴 bytes의 지문을 함께 유지한다. 마지막 검증과 OS 교체 사이의 비협조적 외부 writer까지 CAS로 막는 보장은 아니다.
- PNG에서는 바탕색 입력이 비활성이라는 계약을 테스트에 반영한다. 한 픽셀 높이 문서는 400% 이상 확대하고 실제 문서 내부 좌표·canvas hit target을 검증하여 경계 hit-test 반올림에 의존하지 않는다.
- Shift 직선은 정확한 8방향으로 길이를 보존해 snap한다. 대각선의 두 성분은 동일 값을 사용하고 축 방향의 다른 성분은 0이다. 브라우저 회귀는 antialias 경계 bounding box의 대칭 대신 독립된 정확한 45도 Canvas 경로의 전체 픽셀을 비교한다. 사각형·타원의 정사각형 bounds 검증은 유지한다.
- GitHub가 `macos-14-arm64-us-default`를 지원하지 않아 실행 전에 취소한 두 workflow를 `macos-15`로 갱신했다. 실제 Qt 세 플랫폼과 Studio macOS 빌드 성공을 확인했지만 이후 커밋의 검증 상태는 PR의 해당 SHA checks를 따르며 과거 성공을 재사용하지 않는다.
