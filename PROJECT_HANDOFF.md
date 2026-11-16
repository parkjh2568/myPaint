# myPaint 인수인계

2026-11-16 인수인계. myPaint Studio는 로컬에서 편집하고 `.rpaint` 프로젝트나 이미지로 저장하는 그림판입니다. 현재 제품 경로는 TypeScript 픽셀 엔진·DOM UI와 Tauri/Rust 저장 경계가 있는 `web-app/`입니다. 초기 Qt/C++ 실행 및 빌드 경로를 제거한 뒤에도 고정 픽셀 fixture와 이전 복구 파일 보호는 유지합니다.

## 로컬 검사 정책

이번 변경은 `a8a3eca`를 기반으로 로컬 검사로 전환합니다. 사용자의 리소스 절약 요청에 따라 이 브랜치의 `studio.yml`을 제거했습니다. 테스트·브라우저 매트릭스·OS별 빌드·패키징은 [로컬 검사 안내](docs/LOCAL_CHECKS.md)를 따릅니다. 기존 여섯 브라우저 그룹의 38개 스크립트는 `npm run test:local-browser -- <group|all>`로 선택 실행합니다. 명령만 실행하면 목록을 출력하며 대규모 검사를 시작하지 않습니다.

GitHub 저장소 설정과 다른 브랜치는 변경하지 않았습니다. 워크플로 제거는 이 변경이 반영된 브랜치에 적용되며 이미 실행 중인 작업은 별도로 취소해야 합니다. GitHub 웹에서 Actions를 끄고 실행을 취소하는 절차는 로컬 검사 문서 끝에 기록했습니다.

## a8a3eca의 구현과 검증

`a8a3eca`는 `21ea74f`를 기반으로 탭 닫기·앱 종료 취소와 열린 프로젝트의 내보내기 충돌을 수정했습니다. 저장·닫기 계약과 회귀 테스트를 반영했으며 당시 CI 등록은 이후 로컬 실행으로 전환했습니다.

- Tauri는 닫기 확인과 종료 확인을 위해 탭을 활성화하지 않습니다. 대상 문서를 직접 저장하고, 비활성 닫기는 해당 네이티브 키만 해제합니다. 취소·저장 창 취소·쓰기 실패·종료 IPC 실패 시 현재 미확정 편집과 Redo를 유지합니다.
- GPUI도 비활성 탭의 저장을 위해 현재 탭을 전환하지 않습니다. 전체 종료의 저장은 비활성 문서부터 처리하고 현재 미확정 편집은 마지막에 저장합니다.
- 공유 Rust 저장소는 모든 열린 프로젝트의 경로·파일 identity를 저장 대상 선택, 쓰기 준비, 최종 교체 직전에 확인해 이미지 덮어쓰기를 거절합니다.
- 최종 macOS arm64 결과: Tauri 33개·GPUI 71개·Node 362개·Python 43개 통과. 새 Chromium 회귀 14개와 기존 문서 탭 회귀 통과. [명령과 검증 한계](docs/CURRENT_STATUS.md#2026-11-16-닫기종료-취소와-내보내기-충돌-수정)

## 로컬 실행 준비

이번 Apple Silicon Mac에는 Rust 1.100.0과 Xcode Metal Toolchain을 추가했습니다. Tauri 검사는 Rust 1.94.0을 사용했습니다. `gpui-app/`의 rustup 디렉터리 override는 이 Mac에만 등록된 설정이며 저장소에 포함되지 않습니다. 최신 수정의 Rust 전체 테스트와 브라우저 검증은 통과했으며 GPUI GUI·설치 패키지 검수는 남아 있습니다.

Rust 1.100.0과 Metal 도구가 준비된 Mac에서는 저장소 루트에서 다음 명령으로 별도 개발 저장소를 사용하는 앱을 시작할 수 있습니다.

```sh
cargo +1.100.0 run --manifest-path gpui-app/Cargo.toml --locked -- --persistence-root /private/tmp/mypaint-gpui-dev
```

## 브랜치와 기준

| 브랜치 | 역할과 기준 |
| --- | --- |
| `codex/studio-recovery` | Qt 제거 반영 지점 `48e4058`에서 복구 저장소와 탭 수명을 정리했습니다. 제품 코드 기준은 `04a2c5d`입니다. |
| `codex/gpui-compare` | `04a2c5d` Tauri 기준에 별도 `gpui-app/`과 `bench/`를 추가했습니다. `620584c` 첫 비교, `ea24e72` 기능 이식, `f4e2095` Windows 화면·입력 비교로 이어졌습니다. [Windows 비교 보고서](docs/GPUI_WINDOWS_COMPARISON.md) |

## 확인된 범위

- 웹 복구 사본은 Studio 전용 DB에 기록합니다. 탭을 전환하면 떠나는 탭의 편집을 확정하고 복구를 예약합니다. 열린 탭만 네이티브 저장 경로를 사용하며 닫힌 탭의 늦은 쓰기는 거절합니다.
- Windows MSVC로 Tauri NSIS를 빌드했습니다. 실제 Windows 앱에서 탭을 전환한 편집을 재시작 뒤 복구하고, 탭을 닫은 뒤 저장 경로가 해제되는 것을 확인했습니다.
- GPUI는 Tauri와 호환되는 `.rpaint`, 복구, 내보내기 미리보기와 설정 재시작을 확인했습니다. 공통 Windows GDI 화면 관측값은 [현재 검증 범위](docs/CURRENT_STATUS.md)에 있습니다.

## 이어서 검증할 항목

- 최신 수정은 해당 OS의 로컬 검사로 확인합니다. 원격 CI를 인수 조건으로 사용하지 않습니다. macOS 로컬 단위 검사 통과는 전체 브라우저 회귀·실제 GUI·설치 패키지 검증을 포함하지 않습니다.
- 닫기·종료 취소와 내보내기 충돌의 로컬 회귀는 통과했습니다. 실제 OS 대화상자와 Windows/WebView 런타임 검수는 남았습니다. 나머지 편집 실패·자원 경계 항목은 [2026-11-15 코드베이스 감사](docs/archive/STUDIO_CODEBASE_REAUDIT.md)를 따릅니다.
- GPUI 한글 글리프 표시는 확인했습니다. Windows IME 조합, 물리 펜 필압, 실제 두 손가락 제스처, macOS 설치본은 남아 있습니다. GDI 관측값은 하드웨어 펜 지연을 포함하지 않습니다.

[설치·실행 안내](README.md) · [현재 상태](docs/CURRENT_STATUS.md) · [기술 문서](docs/README.md) · [작업 연혁](docs/PROJECT_HISTORY.md) · [과거 기록](docs/archive/README.md)
