# RetroPaint 결함 수정 결과와 검증

기준일: 2026-11-03 한국 시간. [코드 검토](CODE_REVIEW.md)와 [작업계획](IMPLEMENTATION_PLAN.md)에 따라 제품 코드와 회귀 검사를 적용했다. 기존 소스 구조, Qt Core/Gui와 Widgets 경계, RPAINT01 파일 형식, 오프라인 실행 제약을 유지했다. 변경은 작업 트리에 있으며 커밋·배포·원격 CI 실행은 하지 않았다.

## 우선순위별 적용 결과

| 항목 | 적용한 동작 | 주 검증 |
| --- | --- | --- |
| F02 복합 버튼 입력 | 제스처를 시작한 버튼만 해당 제스처를 종료한다. 추가 press/release가 원래 획을 덮어쓰지 않는다. | 왼쪽 획 중 가운데 버튼, Undo, 기존 spray·pan·소유권 상실 |
| F07 잘라내기 | 선택이 없으면 활성 레이어를 복사한 뒤 같은 레이어를 지운다. 일반 복사의 합성 이미지 계약은 유지한다. | 반투명 활성 레이어의 클립보드 이미지, 다른 레이어 불변, Undo |
| F01 선택 크기 | copy/cut/transform이 현재 표시 크기를 사용한다. 확장된 붙여넣기 영역의 crop도 후보 문서 범위를 사용한다. | 20×20→30×25 복사, 90도 회전→25×30, 45×35 붙여넣기 crop와 한 번의 Undo |
| F03 레이어 이력 | 명시적인 구조 변경 모드와 active 차이 검증으로 reorder를 기록하고 전후 active를 복원한다. 같은 이름·이미지도 누락하지 않는다. | 동일한 두 레이어 reorder→Undo/Redo·dirty, 명시적인 후보 active 변경과 비이력 setActive 구분 |
| F04 편집 알림 | 획·곡선·다각형·문자 시작과 취소·확정에서 메뉴를 갱신한다. pending 중 Redo는 비활성화한다. | 깨끗한 문서의 취소 메뉴와 실제 취소, 기존 이력 |
| F05 취소와 실패 | pending 후보 생성과 문서 설치를 분리했다. 저장·종료·크기 변경 취소와 쓰기 실패가 pending을 확정하지 않는다. | 선택·문자·곡선·다각형 × 저장 취소/실패·종료 취소·크기 취소 16개 조합 |
| F06 선택 범위 | 이동·크기 조절·키 이동·줌의 표시 범위를 갱신한다. 한도 초과 이동·크기 변경은 후보 교체 전에 거부한다. | 문서 밖 선택 표시, 취소 후 위젯 범위 복원, 투명 선택의 실패 후 불변 |
| F08 마지막 modifier | release 위치가 같아도 도형의 Shift 제약을 반영한다. 같은 위치의 일반 획은 불필요하게 덧그리지 않는다. | 비제약 move 후 같은 위치에서 Shift release |
| F09 이력 비용 | 용량을 기하급수적으로 예약하고 최대 4,096개 항목을 유지한다. 예산 축소는 현재 픽셀을 유지하면서 즉시 가지치기한다. | 수천 개 작은 편집, Undo 위치에서 예산 축소, saved revision·Redo 분기 |
| F10 응답성 | 도형 미리보기는 화면에 직접 그린다. 수동 저장·내보내기·자동 복구의 인코딩과 임시 파일 준비를 worker에서 수행한다. | 저장 중 취소, 파일 불변, 복구 snapshot 경합, 성능 표본 |

## 저장과 복구의 확정 경계

수동 저장은 아래 순서를 사용한다.

1. 경로·형식·overwrite를 결정하고 IME 입력 확정을 요청한다. 조합이 남아 있으면 누락된 문자로 저장하지 않고 입력 완료를 요청한다.
2. Canvas가 선택·문자·도형을 포함한 후보 State를 만들되 기존 pending은 유지한다.
3. worker가 후보를 인코딩하고 direct-write fallback이 꺼진 QSaveFile에 쓴다. 이 단계에서는 대상 파일을 교체하지 않는다.
4. worker 완료 후 문서 revision·active를 확인하고 `Document::prepare`로 patch와 이력 공간을 준비한다. 이 준비가 실패하면 임시 파일을 폐기한다.
5. UI 스레드에서 QSaveFile을 commit하고 이벤트 처리 없이 준비된 변경을 install한다. path·savedId를 갱신한 뒤 pending과 복구 사본을 정리한다.

`PreparedEdit`은 해당 문서·revision·cursor·active에 연결된 이동 전용 값이다. 오래된 준비 결과의 설치는 거부한다. 최종 설치의 컨테이너 이동은 컴파일 시 예외 보장을 확인하며, 이력 공간은 설치 전에 예약한다. 별도 프로세스의 할당 실패 주입은 파일 준비 뒤 이력 예약 실패 시 기존 파일·문서가 유지되고, 준비된 변경 설치에서 추가 C++ 할당이 필요하지 않음을 확인한다. 이 시험이 Qt 내부의 모든 malloc 실패나 운영체제 OOM 강제 종료를 보장하지는 않는다.

취소 가능한 저장 진행창은 worker가 현재 이미지 처리를 끝낼 때까지 유지된다. Qt 이미지 인코더를 한 프레임 중간에서 강제로 종료하지 않는다. 내보내기는 pending을 포함한 결과를 쓰되 revision·savedId·path·pending을 바꾸지 않는다.

자동 복구는 불변 State를 준비하고 완료 시 여전히 같은 revision이며 dirty인 경우에만 교체한다. 수동 저장·내보내기는 진행 중인 복구 준비를 취소하고 해당 worker가 끝난 뒤 인코딩을 시작하여 큰 인코딩 작업을 겹치지 않는다. 대기는 UI 스레드를 점유하지 않는다. 새 문서·저장·종료는 진행 중인 복구 준비를 취소한다. 편집 중 바뀐 snapshot과 수동 저장 후 도착한 snapshot은 폐기하며, 기존 복구 사본은 유지한다. 계속 편집하는 동안에는 갱신이 30초보다 늦어질 수 있다. 읽기는 현재 동기식이며, 측정한 4096×4096 문서의 열기 중앙값은 31ms였다.

## 예외와 특수 상황 보강

- **Qt 입력 예외:** 한도를 넘는 실제 키 입력에서 프로세스 종료를 재현했다. 각 입력·그리기·문자 필터·타이머 콜백이 소유 함수 안에서 예외를 처리한다. 실패한 제스처를 정리하되 기존 선택·문자는 유지한다. 앱 전역 notify만을 오류 경계로 의존하지 않는다.
- **복구 경로 보호:** 복구 파일을 직접 열었을 때 정리 루틴이 해당 문서를 삭제하지 않는다. 일반 저장에 복구 전용 경로를 허용하지 않는다. 존재하지 않는 두 경로의 비교도 명시적으로 구별하여 정상적인 새 이름 저장을 허용한다.
- **버퍼 검증:** 픽셀·레이어 합계 외에 실제 이미지 바이트 길이를 검증한다. 붙여넣기 입력을 검사하고 내부 ARGB 행 배치를 정규화한다. 한도 검증 전에 과도한 대상 이미지를 할당하지 않는다.
- **프로젝트 입력:** 잘못된 UTF-8과 끊긴 입력을 거부하고, writer는 유효하지 않은 UTF-16 이름을 저장하지 않는다. 내부 PNG decoder의 형식 자동 탐지를 끈다. 입력 크기·이름·encoded 레코드 한도는 공통 상수를 사용한다.
- **문자:** 편집기 viewport·스크롤·margin·clip을 확정 결과에 반영한다. 현재 보이는 문자 영역만 래스터화한다는 안내를 제공한다. 조합 중인 문자는 누락된 상태로 확정하지 않으며, commit 이벤트 전달 시험과 실제 IME 검증을 구분한다.
- **문자 클립보드:** 문자 편집 중 메뉴의 복사·잘라내기·붙여넣기는 텍스트 편집기에 적용한다. 텍스트를 잘라내려다 활성 레이어 전체가 지워지는 동작을 방지한다. 문자 편집이 끝난 뒤에는 기존 이미지 클립보드 동작을 사용한다.
- **복구 실패 표시:** 삭제·폴더 접근·자동 저장 실패를 상태에 반영한다. 자원 부족으로 오류창이나 UI를 갱신할 수 없으면 stderr에 남긴다. 이미 성공한 파일 저장을 화면 갱신 실패 때문에 다시 저장 실패로 취급하지 않는다.

## 구조와 컨벤션 정리

기존 `Document`, `Canvas`, `MainWindow`, `main` 구조를 유지했다. 추가된 공유 연산은 선택 이미지 실체화, 후보 State 생성, 문자/이미지 클립보드 분기, 준비된 편집의 소유권, 파일 준비와 복구 경로 검증처럼 여러 경로가 실제로 같은 의미나 자원을 공유하는 경우다. 단일 대입·버튼 생성·Qt connect를 각각 헬퍼로 분리하지 않았다.

도구의 enum 순서 비교를 명시적인 switch와 대응표로 바꾸고, always-true `settle` 반환과 QWidget→QTextEdit 반복 캐스트를 제거했다. 레이어 수가 같으면 목록을 재생성하지 않고 텍스트·체크·선택만 갱신한다. 사용할 수 없는 레이어·선택 명령을 비활성화하고 옵션·색상·레이어 버튼에 접근성 이름을 보강했다.

테스트의 deprecated 예외 검사 매크로 14곳을 변경하고 테스트 대상에도 경고 옵션을 적용했다. CMake의 기존 들여쓰기는 EditorConfig에 명시했다. 공통 smoke와 할당 실패 검사를 추가했으며, Linux UI/오프라인 UI 및 smoke/오프라인 smoke의 공유 테스트 경로에는 각각 CTest resource lock을 적용했다. 네트워크 guard의 양성 대조는 정확한 종료 코드와 메시지를 검사한다.

CI에는 시스템 Qt 기준 빌드와 기존 formatter를 사용하는 포맷 검사를 정의했다. 원격 CI 실행은 하지 않았다. 기존 네이티브 매트릭스의 Qt 고정 버전도 유지했다.

## 최종 로컬 검증

환경은 macOS 27 ARM64, AppleClang 21, Qt 6.12.0이다.

| 검사 | 결과 |
| --- | --- |
| Release 빌드 | 성공, 제품·테스트 컴파일 경고 없음 |
| Release CTest | core, allocation_failure, smoke, ui 4개 그룹 통과 |
| 코어 QtTest | 동작 20개 통과·Linux 전용 쓰기 제한 1개 skip. QtTest 표기는 init/cleanup 포함 22 pass/1 skip |
| UI QtTest | 동작 56개 통과. QtTest 표기는 init/cleanup 포함 58 pass |
| ASan·UBSan | 위 4개 그룹 통과. 누수 검사는 끔. 최종 원문은 아래 로그 참조 |
| Clang static analyzer | 제품 cpp 4개 translation unit 검사, 진단 없음 |
| clang-format | 기존 로컬 Apple clang-format 21로 src·tests 전체 통과 |
| YAML·whitespace | workflow YAML 구문과 `git diff --check` 통과 |
| UI 화면 | macOS 빌드 앱의 offscreen smoke와 실제 위젯 화면 확인 |

의도적인 손상 PNG 시험의 libpng 오류 출력, offscreen의 propagateSizeHints 및 font alias 경고는 로그에 남겼다. 해당 출력이 테스트 실패나 컴파일 경고라는 뜻은 아니다.

최초 `review-probe` 소스와 출력은 초기 진단 자료로 보존한다. 현재 동작의 회귀 판정은 기본 core/UI 테스트를 사용한다.

증거: [Release](evidence/implementation-release.log), [ASan·UBSan](evidence/implementation-sanitize.log), [정적 분석](evidence/implementation-static.log), [성능 JSON](evidence/implementation-performance.json), [성능 원문](evidence/implementation-performance-raw.log), [smoke](evidence/implementation-smoke.log).

### 성능 표본

동일 환경에서 각 크기를 세 번 순차 실행한 중앙값이다. 시스템의 다른 부하는 통제하지 않았다. 코어의 동기식 저장 시간이며 앱 UI가 그 시간 동안 멈춘다는 뜻은 아니다. UI는 인코딩을 worker에 맡긴다.

| 항목 | 1920×1080 | 4096×4096 |
| --- | --- | --- |
| 선 20회와 commit | 10ms | 106ms |
| Undo/Redo 40회 | 8ms | 70ms |
| 채우기 | 3ms | 26ms |
| 프로젝트 저장 | 59ms | 456ms |
| 프로젝트 열기 | 4ms | 31ms |
| 프로브 프로세스 최대 RSS 중앙값 | 약 45MiB | 약 213MiB |

해당 RSS는 코어 프로브의 값으로, 실제 앱의 화면 캐시·최대 레이어·최대 이력·여러 인코딩 동시 실행의 총 메모리를 나타내지 않는다. 더 큰 실사진·다층 문서에서 병목이 확인되면 변경 영역 추적·타일 이력·동기식 열기의 비동기화를 별도 검토한다. 현재 빠르게 처리되는 편집 경로에 새 계층을 추가하지 않았다.

## 재현 명령

```sh
cmake -S . -B build-audit -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_PREFIX_PATH=/path/to/Qt -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
cmake --build build-audit --parallel 2
ctest --test-dir build-audit --parallel 2 --output-on-failure

cmake -S . -B build-audit-sanitize -G Ninja -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_PREFIX_PATH=/path/to/Qt \
  -DCMAKE_CXX_FLAGS='-fsanitize=address,undefined -fno-omit-frame-pointer' \
  -DCMAKE_EXE_LINKER_FLAGS='-fsanitize=address,undefined'
cmake --build build-audit-sanitize --parallel 2
ASAN_OPTIONS=detect_leaks=0 UBSAN_OPTIONS=halt_on_error=1 \
  ctest --test-dir build-audit-sanitize --parallel 2 --output-on-failure \
    -R '^(core|ui|allocation_failure|smoke)$'

./build-audit/perf_probe
./build-audit/perf_probe --large
xcrun clang-format --dry-run --Werror src/*.cpp src/*.h tests/*.cpp
```

Release와 sanitizer의 UI 테스트는 서로 다른 CTest 프로세스로 동시에 실행하지 않는다. CTest resource lock은 같은 CTest 실행 안에서만 적용된다. Linux의 LD_PRELOAD guard와 ASan 런타임 순서도 혼합하지 않는다.

## 남은 환경 검증과 제한

Windows·Intel Mac, 네이티브 IME·클립보드·파일 대화상자·Retina·다중 모니터, 실제 디스크 고갈·장치 분리·강제 종료 복구, Qt 런타임 패키징·서명·공증은 미검증이다. 현재 로컬 결과로 해당 환경의 통과를 주장하지 않는다. Linux 전용 guard와 부분 쓰기 실패 주입은 소스와 CI 구성을 보강했지만 이번 Mac에서는 실행하지 않았다.

최소 Qt 6.4 계열과 CI 고정 Qt의 원격 빌드도 미실행이다. 추가 formatter 설치는 자동 승인 검토가 외부 패키지 실행과 프로젝트 네트워크 제약을 이유로 거절하여 진행하지 않았다. 기존 로컬 formatter 21로 검사했고, CI의 사전 설치 formatter 18에 대한 실제 실행 결과는 남아 있다. 누수 검증과 운영체제에 의한 OOM 종료 복구도 완료로 표시하지 않는다.
