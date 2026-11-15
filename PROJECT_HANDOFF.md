# myPaint 인수인계

2026-11-15 기준. myPaint Studio는 로컬에서 편집하고 `.rpaint` 프로젝트나 이미지로 저장하는 그림판입니다. 현재 제품 경로는 TypeScript 픽셀 엔진·DOM UI와 Tauri/Rust 저장 경계가 있는 `web-app/`입니다. 초기 Qt/C++ 실행 및 빌드 경로를 제거한 뒤에도 고정 픽셀 fixture와 이전 복구 파일 보호는 유지합니다.

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

- Tauri에서 수정된 비활성 탭의 닫기 취소가 현재 탭의 편집과 Redo를 바꾸는 경로가 재현됐습니다. 내보내기 대상과 열려 있는 프로젝트 경로의 충돌, 종료 취소 시 편집 보존도 확인이 필요합니다. [2026-11-15 코드베이스 감사](docs/archive/STUDIO_CODEBASE_REAUDIT.md)
- GPUI 한글 글리프 표시는 확인했습니다. Windows IME 조합, 물리 펜 필압, 실제 두 손가락 제스처, macOS 설치본은 남아 있습니다. GDI 관측값은 하드웨어 펜 지연을 포함하지 않습니다.

[설치·실행 안내](README.md) · [현재 상태](docs/CURRENT_STATUS.md) · [기술 문서](docs/README.md) · [작업 연혁](docs/PROJECT_HISTORY.md) · [과거 기록](docs/archive/README.md)
