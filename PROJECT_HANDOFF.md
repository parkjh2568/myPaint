# myPaint 인수인계

2026-11-16 인수인계. myPaint Studio는 로컬에서 편집하고 `.rpaint` 프로젝트나 이미지로 저장하는 그림판입니다. 현재 제품 경로는 TypeScript 픽셀 엔진·DOM UI와 Tauri/Rust 저장 경계가 있는 `web-app/`입니다. 초기 Qt/C++ 실행 및 빌드 경로를 제거한 뒤에도 고정 픽셀 fixture와 이전 복구 파일 보호는 유지합니다.

## 이번 커밋의 변경과 검증

`codex/gpui-compare`의 `6efb9d3cbaf0e50c6583c146949364da99f852b9`를 기반으로 공유 저장 모듈의 테스트 두 곳과 인수인계 문서를 수정했습니다. 제품 저장 로직과 의존성 잠금 파일은 그대로입니다.

- 복구 테스트: `TempDir`을 테스트 끝까지 유지하고, 비활성 탭에서 완료된 복구 쓰기의 바이트를 직접 읽어 비교합니다.
- macOS ACL 테스트: `USER` 기반 사용자 ACL을 `everyone deny write`로 바꾸고, OS가 직접 쓰기 열기를 `PermissionDenied`로 거부하는지 먼저 확인합니다. 원본 보존과 임시 stage 제거 검증은 유지합니다.
- 최종 macOS arm64 결과: Tauri 31개·GPUI 68개·Node 359개·Python 43개 통과. Rust·웹 포맷 및 TypeScript·Vite 빌드 통과. `USER`를 제거한 ACL 검사도 두 앱에서 각각 20회 통과했습니다. [명령과 검증 한계](docs/CURRENT_STATUS.md#2026-11-16-macos-acl-테스트-안정화)

## 로컬 실행 준비

이번 Apple Silicon Mac에는 Rust 1.100.0과 Xcode Metal Toolchain을 추가했습니다. Tauri 검사는 Rust 1.94.0을 사용했습니다. `gpui-app/`의 rustup 디렉터리 override는 이 Mac에만 등록된 설정이며 저장소에 포함되지 않습니다. GPUI 개발 실행 파일 빌드는 통과했고 GUI는 실행하지 않았습니다.

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

- 이번 커밋의 원격 CI 결과와 Windows 검사를 확인해야 합니다. macOS 로컬 단위 검사 통과는 전체 브라우저 회귀·실제 GUI·설치 패키지 검증을 포함하지 않습니다.
- Tauri에서 수정된 비활성 탭의 닫기 취소가 현재 탭의 편집과 Redo를 바꾸는 경로가 재현됐습니다. 내보내기 대상과 열려 있는 프로젝트 경로의 충돌, 종료 취소 시 편집 보존도 확인이 필요합니다. [2026-11-15 코드베이스 감사](docs/archive/STUDIO_CODEBASE_REAUDIT.md)
- GPUI 한글 글리프 표시는 확인했습니다. Windows IME 조합, 물리 펜 필압, 실제 두 손가락 제스처, macOS 설치본은 남아 있습니다. GDI 관측값은 하드웨어 펜 지연을 포함하지 않습니다.

[설치·실행 안내](README.md) · [현재 상태](docs/CURRENT_STATUS.md) · [기술 문서](docs/README.md) · [작업 연혁](docs/PROJECT_HISTORY.md) · [과거 기록](docs/archive/README.md)
