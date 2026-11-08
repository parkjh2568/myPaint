# 문서 안내

현재 제품은 Studio (`web-app/`)이며 Qt (`src/`, `web/`)는 전환 기준 구현이다. 날짜가 있는 실행 기록은 해당 소스·환경에 한정한다. 오래된 결과를 현재 플랫폼 인수로 승격하지 않는다.

## 먼저 읽을 문서

| 목적 | 기준 문서 |
| --- | --- |
| 개발·빌드 시작 | [Studio 구현 안내](STUDIO_IMPLEMENTATION.md), [웹 배포 절차](WEB_BUILD.md) |
| 모듈과 상태 소유권 | [Studio 아키텍처](STUDIO_ARCHITECTURE.md) |
| 픽셀·알파·취소·문서 계약 | [문서 계약](STUDIO_DOCUMENT_CONTRACTS.md) |
| 네이티브 저장·복구 | [저장 계약](STUDIO_NATIVE_PERSISTENCE.md), [복구 스냅샷](STUDIO_RECOVERY_SNAPSHOT.md) |
| 성능을 재현하고 해석 | [측정 방법](STUDIO_MEASUREMENT_METHOD.md), [이번 최적화](MEASURED_REFACTOR.md) |
| 지원 범위와 남은 인수 | [인수 매트릭스](STUDIO_ACCEPTANCE_MATRIX.md), [완료 감사](STUDIO_COMPLETION_AUDIT.md) |
| Qt 제거 조건 | [전환 작업](QT_FREE_MIGRATION_TASKS.md), [Qt 이탈 평가](QT_EXIT_ASSESSMENT.md) |
| 파일 호환과 기준 fixture | [파일 형식](FILE_FORMAT.md), [fixture 기준](STUDIO_FIXTURE_BASELINE.md) |

## 기록과 레거시 구분

- `STUDIO_*` 세부 보고서와 `evidence/`는 조사 당시의 근거다. 최신 계약 문서에서 연결된 범위만 현재 판정에 사용한다.
- `ARCHITECTURE.md`, `IMPLEMENTATION_*`, `WEB_IMPLEMENTATION_*`, `WEB_FEASIBILITY.md`, `VERIFICATION.md`는 Qt/기존 웹 작업의 기록이다. Studio 개발 지침 대신 읽지 않는다.
- `src/`, `web/`, CMake 대상, fixture, 라이선스는 여전히 빌드·호환 검증에 사용된다. 인수 완료 전에 오래됐다는 이유만으로 삭제하지 않는다.
- 실제 명령은 `web-app/package.json`, CI workflow와 빌드 도구를 기준으로 한다. 이 색인에 명령 전체를 복제하지 않는다.
