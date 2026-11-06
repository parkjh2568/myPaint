# 최신 소스 macOS 앱 재검증

2026-11-06. [소스·빌드·실행 근거](evidence/studio-native-current.json). 화면 잠금 해제 답변 후 콘솔 잠금 상태가 `false`임을 확인하고 최신 소스로 macOS 앱을 다시 빌드했다. **실제 앱의 저장·복구, 코덱, 종료 보호, 렌더링 네 분기가 모두 통과했다.** 제품 코드·helper·의존성 변경은 없다. 모바일·태블릿은 웹, 설치형은 Windows/macOS 범위를 유지한다.

## 검증 대상과 결과

[QF-04의 늦은 복구 오류 수정](STUDIO_DOCUMENT_CONTRACTS.md)을 포함한 runtime 소스17개를 직전 기준과 전수 SHA 대조했다. main은 `48695bee1d88`, 실행파일은 새 빌드 `d1da36e38326`이다. native frontend는8파일·290,584B이며 웹 staging의9파일·291,664B와 LICENSE1,080B만 다르다. 공통8파일의 SHA가 모두 같고 entry는 `assets/index-DIgO41Ne.js`다. 이전9f01 바이너리의 통과와 구분한다.

| 실제 macOS WKWebView 분기 | 결과 |
| --- | --- |
| 저장·복구 | 67,126,671B 프로젝트의 픽셀 roundtrip, stale read/clear, legacy 보호, 이전 문서 세대 거부 통과 |
| 코덱 | 정적·애니메이션 첫 프레임·투명 GIF의 전체 RGBA 검사 통과 |
| 종료 보호 | runtime/native 종료의 unsaved/pending 취소, busy·중복 요청 보존, 마지막 승인 종료 통과 |
| 렌더링 | scene21개 조건, 원시 RGBA digest16개, 변경 없는 화면 업로드0과 타일 한도 통과 |

LaunchServices 기본 foreground 방식으로 네 번 실행했다. 각 `/usr/bin/open -n -W`의 wait가 완료되고 고유한 성공 marker와 필수 결과를 검사했다. `launcherExitCode=0`이며 **앱 자체 종료 코드는 관측하지 않아 `appExitCode=null`, `appExitObserved=false`로 남겼다.** 저장·복구 launch wall은9,721ms, 코덱2,605ms, 종료981ms, scene5,697ms다. 서로 다른 작업의 전체 실행 시간이며 통계적 성능 비교로 사용하지 않는다.

임시 legacy 파일2개의 전체 bytes·SHA·mtime·inode·device·mode가 실행 전후 같았다. 테스트 전용 임시 root가 제거됐고, 정확한 실행파일과 그 root를 함께 가진 잔여 프로세스가 없음을 확인했다. 다른 앱·사용자 파일은 정리 대상에 포함하지 않았다. Git index/config 해시는 두 저장소 모두 같으며 홈페이지 쓰기·commit/push·공개 배포는 수행하지 않았다.

## 해석과 남은 검증

이번 실행은 최신 소스를 포함한 일반 native 통합 검증의 공백을 해소한다. 다만 늦은 A 복구 목록 오류가 B 문서 상태를 덮는 경합을 실제 OS에서 주입한 시험은 아니다. 그 수정의 결정적 회귀는 [기존 Chromium IPC 모형 검사](STUDIO_DOCUMENT_CONTRACTS.md)로 구분한다.

실행 전후 콘솔 잠금은 false였지만 모든 순간의 focus/visibility나 과거 실패의 원인을 증명하지 않는다. 기존20초 `project-read-large` 실패와120초 완료 신호 없음은 그대로 보존한다. 이번1회 통과로 간헐적 실패가 해결됐다고 단정하지 않으며 production 코덱20초·검증 watchdog120초도 늘리지 않았다.

scene의 최대 타일 추정치92,269,648B는 앱의 타일 회계다. 전체 앱/WK/GPU peak RSS나 장시간 메모리·입력 지연·p95 인수가 아니다. OS 파일 선택기·IME/clipboard·수동 시각 확인·Windows·물리 Android와 서명/공증·공개 배포는 남는다. 전체 자체 판정7입증/25부분/2미구현, 선행까지 완료한 QF-01/02/04와 QF-03 부분 상태는 유지한다.

다음 우선순위는 [공통 코어 fixture](STUDIO_MATCHED_CORE.md)의 decode/fill CPU profile이다. 검증 해시 비용을 profile 밖에 두고 실제 병목이 확인된 부분만 수정 후보로 평가한다.
