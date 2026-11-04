# 구현 및 검증 보고서

2026-11-03의 후속 수정과 macOS ARM64 검증은 [구현 결과](IMPLEMENTATION_RESULTS.md)를 참고하세요. 아래는 최초 Linux 구현의 역사적 검증 기록입니다.

기준일: 2026-10-30 (한국 시간). 버전: 0.1.0 개발 버전.

## 결과

독립 오프라인 그림판의 문서 엔진, 클래식 UI, 기본 도구, 클립보드, 캔버스/이미지 크기 변경, 선택, 텍스트, 선택형 레이어 패널, 이미지/프로젝트 저장, 복구 기능을 구현했습니다. 기존 REA 저장소나 첨부 Windows 실행 파일을 수정·실행·재배포하지 않았습니다.

Linux에서 Release 빌드, 설치 경로로 복사한 실행 파일의 스모크 실행, 화면 렌더링 검토, 자동 테스트를 수행했습니다. **macOS/Windows용 배포 완료 또는 최신 Paint 전체 기능과의 동등성을 의미하지 않습니다.**

## 검증 환경과 범위

| 항목 | 결과 |
| --- | --- |
| 환경 | Ubuntu 24.04, x86_64, GCC 13.3, Qt 6.4.2, CMake 3.28 |
| Release 빌드 | 성공 |
| 자동 검사 | CTest 5개 그룹 통과 |
| 기능 사례 | 코어 14개 + UI 26개 = 서로 다른 동작 사례 40개 통과 |
| QtTest 표기 | 코어 16, UI 28에는 각 init/cleanup 2개씩이 포함됨 |
| 주소/UB 검사 | ASan+UBSan 빌드의 코어/UI 두 그룹 통과, `detect_leaks=0` |
| 오프라인 검사 | 인터넷 socket/connect/getaddrinfo 호출을 실패시키는 검사 환경에서 앱 스모크·UI 테스트 통과 |
| 차단 검사 자체의 검증 | 별도 프로세스가 의도적으로 Internet socket을 요청하면 차단되는 양성 대조 시험 통과 |
| 화면 | Qt offscreen으로 실제 위젯을 렌더링한 screenshot.png 확인 |
| CI | Ubuntu/macOS/Windows 빌드 매트릭스 작성 및 YAML 구문 확인; 원격 CI 실행은 하지 않음 |
| macOS/Windows 실기기 | 미검증 |

출력 원문: [Release](evidence/ctest-release.log), [ASan/UBSan](evidence/ctest-asan-ubsan.log), [성능 표본](evidence/performance.json), [Linux 링크 의존성](evidence/linux-dependencies.log).

테스트 화면은 offscreen 백엔드입니다. 실제 데스크톱의 시스템 클립보드, 트랙패드, 네이티브 한글 조합창, Retina/다중 모니터, 파일 선택 대화상자의 OS 연동까지 검증했다는 뜻은 아닙니다. QtTest의 한글 검사는 입력기 commit 이벤트를 전달하는 수준입니다. offscreen의 `propagateSizeHints` 경고는 해당 백엔드의 기능 제한이며 테스트 결과와 함께 원문에 남겼습니다.

## 실패 상황 검증

| 시험 | 확인 사항 |
| --- | --- |
| 픽셀 변경 → Undo/Redo | 원본 픽셀과 수정 상태 복원 |
| 저장 revision으로 돌아간 후 다른 분기 편집 | 잘못 '저장됨'으로 처리하지 않음 |
| 캔버스 축소 → Undo | 잘린 픽셀 복원 |
| 이미지·레이어 합계 한도 초과 | 현재 문서/revision 유지 |
| 프로젝트 모든 잘린 접두부 및 위조 헤더 | 비정상 크기·레이어 수·활성 인덱스·이름 길이 거부 |
| PNG/JPEG/BMP 및 프로젝트 읽기/쓰기 | 크기, 투명 PNG, 숨긴 레이어와 이름 보존 |
| 잘못된 저장 형식, 없는 저장 폴더 | 기존 파일 유지/명시적 실패 |
| 쓰기 도중 오류 | Linux 파일 크기 제한을 1 KiB로 낮춰 실제 쓰기 실패 유발; 기존 파일 내용 보존 및 임시 파일 정리 확인 |
| 채우기 중 취소 | 이미 일부 작업한 후보 이미지가 문서에 반영되지 않음 |
| 붙여넣기·이동·크기 변경·변형 | 한도 검사, 확정/취소, Undo/Redo 확인 |
| 자유 선택 삭제 | 선택 안쪽만 지우고 바깥 픽셀 보존 |
| 투명 픽셀 선택 후 그대로 확정 | 문서와 투명도 불변 |
| 스프레이 중 Esc/마우스 소유권 상실 | 임시 획 및 타이머 취소 |
| 가운데 버튼 이동 | 문서를 수정하지 않음 |
| 우측 또는 하단 캔버스 가장자리 | 해당 축만 변경 |
| 레이어 전환 중 미확정 붙여넣기 | 원래 레이어에 확정한 후 활성 레이어 변경 |
| 숨긴 단일 레이어 저장 | PNG로 기존 경로를 덮지 않고 프로젝트 저장 흐름으로 전환 |
| 창 닫기에서 저장 취소 | 창과 수정 문서 유지 |
| 손상된 복구 사본 | 읽기 실패 후 정상 종료해도 사본 유지 |
| 기존 작업을 버리고 새 문서 시작 | 이전 작업의 자동 복구 사본 제거 |
| 크게 확대한 캔버스의 작은 화면 영역 | 전체 확대 영역을 순회하지 않고 제한된 영역 렌더링 |

파일 크기 제한 시험은 디스크 쓰기 오류의 한 종류입니다. 실제 용량 고갈, 저장 도중 장치 분리, 네트워크/특수 파일시스템, 전원 차단을 모두 재현한 시험은 아닙니다.

## 성능 표본

아래는 이 컨테이너에서 측정한 1회 표본입니다. 다른 OS/하드웨어의 목표 수치나 최대 부하 성능으로 일반화할 수 없습니다.

| 항목 | 표본 |
| --- | --- |
| Release 실행 파일 | 382,584바이트; Qt 런타임은 별도 |
| 스모크 실행 최대 RSS | 37,856 KiB, 약 37 MiB |
| 스모크 전체 시간 | 약 167 ms; 편집/화면 캡처와 100 ms 종료 타이머 포함, 시작 시간 측정이 아님 |
| 1920×1080, 선 20회 그리기+커밋 | 총 22 ms |
| 위 20회 편집의 이력 이미지 데이터 | 501,760바이트 |
| Undo 20회 + Redo 20회 | 총 10 ms |
| 1920×1080 채우기 | 4 ms |
| 같은 문서 프로젝트 저장/열기 | 68 ms / 27 ms |

합성 화면 캐시, 변경 영역 이력, 표시 영역만 그리는 격자를 적용했습니다. 큰 캔버스의 획은 여전히 QImage 전체 버퍼 분리와 변경 레이어 전체 비교 비용이 들고, 프로젝트 인코딩/저장은 UI 스레드에서 수행됩니다. 대용량 작업의 응답성은 후속 성능 검증 대상입니다.

## 실행 환경 때문에 완료하지 못한 검사

- `strace`는 ptrace 권한 제한으로 실행되지 않았습니다. 대신 앱의 동적 libc 네트워크 API를 가로채는 검사와 링크/소스 검토를 수행했습니다. 이 검사는 모든 커널 호출을 관찰하는 패킷 캡처나 OS 방화벽이 아닙니다.
- LeakSanitizer는 프로세스/스레드 조회 제한으로 종료 검사에 실패했습니다. 주소 접근과 UB 검사는 누수 검사를 끄고 다시 통과했으며, 메모리 누수가 없다고 결론내리지 않았습니다.
- Xvfb의 로컬 디스플레이 소켓 생성이 실패하여 X11 데스크톱 백엔드 검증을 수행하지 못했습니다. offscreen 검증과 구분합니다.
- Qt 공유 라이브러리는 제공된 배포 빌드입니다. 앱의 sanitizer 검사 결과가 Qt 내부 전체의 sanitizer 검증을 대신하지 않습니다.

## 다음 배포 단계

우선 macOS Apple Silicon에서 소스 빌드 후 클립보드·한글 IME·Retina·파일 열기/저장·복구를 확인하고, Windows와 Intel Mac에서 같은 시나리오를 확인해야 합니다. 이후 최신 보안 패치를 적용한 Qt 의존성 고정, 런타임과 해당 라이선스/소스 자료 패키징, OS 서명·공증, 인터넷이 차단된 깨끗한 기기의 설치/실행 검증 순서로 진행합니다.

현재 전달물은 재사용 가능한 소스, 테스트, 설계/검증 문서, Qt 런타임 별도 설치가 필요한 Linux 개발 실행 파일입니다. macOS DMG와 Windows 설치 파일, 서명된 정식 배포물을 포함하지 않습니다.

## 재현 명령

표준 Qt 개발 환경에서는 README의 Release 빌드 후 `ctest --test-dir build --output-on-failure`를 실행합니다. Linux는 `offline_smoke`, `network_guard_selftest`, `offline_ui`를 추가로 실행합니다.

```sh
cmake -S . -B build-sanitize -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_CXX_FLAGS='-fsanitize=address,undefined -fno-omit-frame-pointer' \
  -DCMAKE_EXE_LINKER_FLAGS='-fsanitize=address,undefined'
cmake --build build-sanitize --parallel 2
ASAN_OPTIONS=detect_leaks=0 UBSAN_OPTIONS=halt_on_error=1 \
  ctest --test-dir build-sanitize --output-on-failure -R '^(core|ui)$'
./build/perf_probe
```

누수 검사가 허용된 별도 환경에서는 `detect_leaks=1`로 다시 확인해야 합니다. 오프라인 preload 검사는 일반 Release 빌드에서 실행합니다. ASan의 런타임 로드 순서와 혼합하지 않습니다.

배포 API 확인에 사용한 공식 문서:

- https://doc.qt.io/qt-6.5/qt-generate-deploy-app-script.html
- https://doc.qt.io/qt-6.8/cmake-deployment.html
- https://doc.qt.io/qt-6.8/licensing.html
- https://aqtinstall.readthedocs.io/en/v3.3.0/cli.html

## 웹 이식 후 검증

2026-11-03 macOS ARM64에서 공통 코어/UI 변경 후 CTest 5개 그룹과 ASan/UBSan core·ui를 통과했다. Chrome의 실제 `/mypaint/` 경로, 저장소 실패 주입, 폴더 반영 보존·복원과 성능 결과는 [웹 구현 결과](WEB_IMPLEMENTATION_RESULTS.md)에 기록한다. 다른 브라우저·실제 OS IME·공개 Pages 인수와 원격 CI는 별도다.
