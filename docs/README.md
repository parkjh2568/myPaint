# 필요한 개발 문서

실행부터 하려면 [루트 README의 OS별 안내](../README.md)를 보세요. 이 폴더는 현재 계약·검증·배포 기준만 앞에 둡니다.

| 확인할 내용 | 문서 |
| --- | --- |
| 모듈·상태 소유권 | [Studio 아키텍처](STUDIO_ARCHITECTURE.md) |
| 픽셀·알파·취소·확정 규칙 | [문서 계약](STUDIO_DOCUMENT_CONTRACTS.md) |
| 실제 파일 저장·복구 | [네이티브 저장 계약](STUDIO_NATIVE_PERSISTENCE.md) |
| 프로젝트 형식 | [RPAINT01](FILE_FORMAT.md) |
| 확인된 기능과 아직 남은 검증 | [인수표](STUDIO_ACCEPTANCE_MATRIX.md), [완료 감사](STUDIO_COMPLETION_AUDIT.md) |
| 이전 구현 제거 범위 | [정리 결과와 남은 검증](LEGACY_REMOVAL.md) |
| 정적 번들·별도 홈페이지 반영 | [웹 빌드](WEB_BUILD.md) |
| Windows 98 외관 변경 범위 | [Classic 98](STUDIO_CLASSIC98_SKIN.md) |

## 기록은 필요할 때만

- [과거 기록 안내](archive/README.md): 개별 성능·디버깅 과거 조사. 기록 당시 수치를 최신 빌드의 검증으로 해석하지 마세요.
- `evidence/`와 fixture는 재현 근거이므로 보존합니다. `build-web-work/`를 가리키는 일부 과거 링크는 당시 로컬 산출물이며 새 clone에는 없을 수 있습니다.
- 2026-11-12 문서 정리: 초기 중복 계획 7개 제거, 상세 보고서 23개를 archive로 이동, 긴 구현 일지는 시작 안내로 축약했습니다. 삭제한 원문은 정리 전 커밋 `cc5f099`에서 복구할 수 있습니다. 제품 코드·테스트·라이선스는 이 정리에서 변경하지 않았습니다.

## 이번 문서 정리의 검증 범위 (2026-11-12)

새 안내의 명령은 `package.json`, `desktop.mjs`, Tauri 설정, CI와 대조했습니다. Linux에서 Node 337개, Python 44개, 포맷·타입·Vite 빌드가 통과했습니다. `npm test`의 tsx IPC가 환경 제한으로 막혀 같은 테스트 파일을 `node --import tsx --test tests/*.test.ts`로 실행했습니다. 새 안내/이동 문서에 도입한 깨진 상대 링크는 없습니다.

Chromium은 이 환경의 socket 권한 제한으로 시작하지 못했습니다. Windows NSIS 설치, macOS `.app` 실행, 실제 OS 파일 선택기·IME·스킨 화면은 이번 문서 작업에서 실행하지 않았습니다. OS별 안내의 체크리스트는 사용자가 수행할 절차이지 완료 보고가 아닙니다.
