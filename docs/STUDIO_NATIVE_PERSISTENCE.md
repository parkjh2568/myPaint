# Studio 네이티브 저장·복구 구현과 독립 검증

2026-11-04. 모바일·태블릿은 웹만, 실행파일은 Windows/macOS만 대상으로 한다. 이 기록은 저장·복구 작업의 결과이며 전체 Qt 전환이나 출시 완료 보고가 아니다. 원시 결과와 코드/번들 해시는 [검증 근거](evidence/studio-native-persistence.json)에 기록한다.

## 변경한 동작과 경계

프로젝트를 정상적으로 읽고 검증한 뒤에만 해당 경로를 현재 문서에 연결한다. Ctrl/Cmd+S는 연결한 경로를 다시 사용하고, 다른 이름 저장은 새 OS 선택기를 연다. 새 경로는 파일 교체가 성공해야 연결된다. 이미지 열기·내보내기·복구 열기는 프로젝트 원본 경로를 가로채지 않는다. PNG/JPEG/BMP/GIF를 열고 프로젝트를 저장해도 입력 이미지를 자동으로 덮어쓰지 않는다. 복구한 그림은 미저장 문서로 열리며 별도로 저장한다.

`main.ts`는 문서 전환 전에 새 generation/key를 네이티브에 활성화한다. 활성화가 실패하면 기존 픽셀·이력·미확정 입력을 유지한다. 활성화가 확정된 뒤의 늦은 취소는 UI와 네이티브 소유권을 분리하지 않는다. 초기 저장소 준비가 실패하면 편집을 막고 재시도/종료를 제공한다. 재시도는 같은 문서 키를 사용하며 실패한 초기화 결과를 프로세스 수명 동안 캐시하지 않는다.

첫 문서 활성화가 성공한 뒤에는 창 닫기와 앱 종료 요청을 현재 UI의 확인 절차로 보낸다. 오래된 dirty 캐시를 이용하던 IPC는 제거했다. 획·장기 작업·열린 대화상자 중에는 종료를 보류하고, 저장 후 계속하기는 실제 저장 성공과 pending 해제까지 확인한다. 브라우저 다운로드는 기존처럼 실제 저장 완료로 간주하지 않는다.

## 앱 종료의 소유권

`guard_armed`는 처음에는 false다. UI는 최초 `activate_document` 응답 전까지 편집을 막고, Rust는 저장소 초기화와 문서 활성화가 모두 성공한 뒤 응답 직전에만 이를 true로 설정한다. 초기화 실패·JS 부팅 실패로 편집을 시작하지 못한 상태에서는 종료를 허용한다. 한 번 활성화한 뒤에는 이후 문서 전환이 실패해도 보호를 해제하지 않는다. 승인된 종료(`allow_close`)이거나 main WebView가 이미 없는 경우에도 종료를 허용한다.

| 종료 요청 | 보호 경로 |
| --- | --- |
| 창 닫기 | `WindowEvent::CloseRequested` → 공통 `request_close` |
| 실행 중인 앱의 `app.exit` | `RunEvent::ExitRequested` → 공통 `request_close` |
| macOS 기본 메뉴 Cmd+Q·Dock Quit | AppKit `applicationShouldTerminate:` → 공통 `request_close` |

보호가 켜져 있고 UI가 남아 있으면 네이티브 요청을 막고 `mypaint-close-request`를 전달한다. 현재 UI가 취소하면 앱과 편집 상태를 유지한다. UI가 최종 승인한 `close_window`는 `allow_close=true`를 설정하고 단일 창 앱 전체를 종료한다. 창만 닫고 macOS 앱 프로세스를 남기는 동작으로 처리하지 않는다. 검증용 `smoke_result`도 `--smoke`에서만 의도한 종료를 승인한다. 정상 종료 보호를 시험하는 `smoke_quit`와 결과만 기록하는 `quit_smoke_report`는 승인 flag를 설정하지 않는다.

### macOS delegate 유지보수 근거

pinned Tauri 2.12.5 / runtime-wry 2.12.3 / Tao 0.37.2 / muda 0.20.0 소스를 확인했다. `app.exit`는 창 닫기 이벤트를 거치지 않으며, macOS 기본 Quit의 `terminate:`는 Tao의 `applicationWillTerminate` → `LoopDestroyed`로 이어져 `ExitRequested`도 우회한다. 따라서 RunEvent 처리만으로 Cmd+Q를 보호할 수 없다.

[lifecycle.rs](../web-app/src-tauri/src/lifecycle.rs)는 동기 setup의 메인 스레드에서 현재 Tao delegate를 부모로 하는 ivar 없는 subclass를 설치한다. 기존 `auxState`, `new`, `dealloc`은 상속하고 새 ivar나 소멸자를 추가하지 않는다. 부모와 subclass의 instance size 및 교체 전 class identity를 확인한다. objc2 0.6.5의 `AnyObject::set_class` 조건과 `NSApplicationTerminateReply`의 NSUInteger ABI에 맞추며 NSApplication 자체의 class는 바꾸지 않는다. 이미 `applicationShouldTerminate:`가 있으면 덮어쓰지 않고 준비 오류로 처리한다. Tao/objc2를 갱신할 때는 이 layout·ivar 수명·상속 메서드의 super-dispatch·selector ABI를 다시 검토해야 한다.

이 보호는 살아 있는 앱의 제어 가능한 종료 요청을 대상으로 한다. 강제 종료·프로세스 충돌·전원 차단을 확인 대화상자로 막는다는 뜻은 아니다. 복구 내구성 인수는 별도 조건으로 유지한다.

## 저장소와 한도

| 항목 | 웹 | Windows/macOS 네이티브 |
| --- | --- | --- |
| 복구 위치 | 같은 origin의 `retropaint-local-v1` IndexedDB | Tauri `app_local_data_dir()/recovery/` |
| 복구 payload | 사본당 웹 입력 한도 40MiB | 사본당 300MiB |
| 복구 개수·합계 | 32개·64MiB | 32개·1GiB |
| 이전 사본 | 기존 IndexedDB 데이터 유지 | 이전 WebView IndexedDB 읽기 + 이전 Qt 사본 읽기 전용 |
| 삭제 | 트랜잭션에서 head/sequence 검증 | 파일 식별자·버전과 head 검증; Qt 원본 삭제 거부 |

네이티브 `.rprec`는 12바이트 prefix, 최대 4KiB JSON header, 기존 RPAINT01 payload를 한 파일로 원자 교체한다. 외부 `.rpaint` 형식은 변경하지 않는다. 1GiB는 확정 payload 합계이며 실제 디스크 사용량 상한이 아니다. header와 최대 300MiB 복구 임시파일, 별도 수동 저장 임시파일이 추가될 수 있다. 일반 실패/취소의 임시파일은 해제하지만 강제 종료로 남은 `.mypaint-*.tmp`는 자동 삭제하지 않는다. Windows `ReplaceFileW`의 부분 실패 1176/1177에서는 마지막 복구 가능 사본을 지우지 않도록 임시파일을 보존하고 오류에 그 경로를 표시한다. 대상 원본이 이미 이동되거나 사라졌을 수 있으므로 자동 재시도나 원본 복원을 보장하지 않는다. 복구 사본 자동 prune도 하지 않는다.

macOS의 이전 Qt 위치는 실제 Qt 6.12 probe로 `~/Library/Application Support/RetroPaint/RetroPaint`를 확인했다. Windows는 기존 `AppLocalDataLocation` 계약에 따라 `%LOCALAPPDATA%/RetroPaint/RetroPaint`를 사용하며 실제 Windows 인수는 남아 있다. `recovery.rpaint`와 보관된 timestamp 사본을 읽고 원본·session.lock을 수정하지 않는다. 잠금 파일의 존재만으로 복구를 차단하지 않는다. macOS 실제 Qt 프로세스를 강제 종료한 뒤 남은 stale lock에서도 읽기 전용 shared guard로 복구가 가능했고, 실행 중인 Qt의 배타 잠금은 거부했다.

복구 목록은 `{entries,warnings}`를 반환한다. 손상된 사본이나 실행 중인 Qt 때문에 정상 사본까지 숨기지 않으며 경고는 대화상자에 표시한다. 쓰기·용량 계산은 잘못된 기존 metadata를 발견하면 중단하여 기존 사본을 보존한다. 네이티브/Qt 항목은 각각 최대 32개이고 이전 IndexedDB는 별도 최대 32개다.

## 재현한 문제와 수정

| 우선순위 | 재현 조건·영향 | 수정·검증 |
| --- | --- | --- |
| P1 | native 300MiB 입력과 IndexedDB 64MiB 합계 제한 불일치 | 네이티브 파일 복구 분리. 실제 64MiB 초과 그림과 300MiB binary storage 왕복 |
| P1 | 같은 저장 토큰을 동시에 재사용 | claim 시 한 번 소비, 진행 중 요청과 취소 소유권 추적 |
| P1 | 새 문서 뒤 이전 저장/복구 완료 도착 | generation/key/sequence 및 마지막 commit 검사 |
| P1 | size/mtime만 같은 파일 교체 | 파일 식별자와 변경 시각을 포함해 재검사 |
| P1 | 기존 0644가 0600으로 바뀌거나 0444·deny-write ACL 파일을 덮어씀 | 접근 권한 확인, 원본 권한·지원 metadata 보존. macOS 모드/ACL 재현 후 보존 확인 |
| P1 | 복구 원본을 Save As 대상으로 선택하거나 대소문자로 우회 | native 저장소·Qt 예약 파일 보호, 이름 비교 정규화 |
| P0 | 창 닫기만 차단해 `app.exit`·macOS Cmd+Q/Dock Quit가 확인 없이 종료 | 활성화 이후 공통 종료 gate, RunEvent와 AppKit delegate 양쪽 보호. 실제 macOS 종료 취소·반복 요청·최종 승인 확인 |
| P1 | 초기화 실패 상태에서 편집 후 저장 경로 전체가 막힘 | 초기 편집 차단·명시적 재시도, 성공한 저장소만 캐시 |
| P1 | 늦은 복구 목록이 새 문서/편집/저장 이후 UI를 침범 | 목록 응답 후 문서 epoch/revision과 편집 상태 재검사 |

실제 공유 자원 소유권만 `persistence.rs`와 테스트의 IPC 모델로 분리했다. 대화상자·문서 전환·후보 확정의 순차 처리는 해당 함수 안에 유지했다. 제품 런타임에 업로드·원격 페이지·쉘·telemetry를 추가하지 않았다.

## 성능과 검증 범위

raw IPC 요청을 다시 `Vec` 전체 복제하던 경로를 제거하고 2MiB 단위 비동기 쓰기를 사용한다. 자동 복구도 소유 snapshot을 Worker에 바로 transfer하여 두 번째 전체 레이어 복사를 제거했다. 복구 읽기는 envelope 전체와 payload를 각각 할당하지 않고 payload만 읽는다.

- Node 43개, strict TypeScript, Prettier, 정적 빌드 통과.
- 고정 `/mypaint/` 번들의 기존 웹 UI 45개 통과. Chrome page error 0개.
- Chromium의 native IPC 모델에서 대형 문서 17개와 저장·복구 12개 통과. 실제 Worker가 만든 67,126,665바이트 autosave가 native 경로를 사용했고 해당 구간 IndexedDB 접근 증가는 0이었다. 이는 OS 파일시스템 시험과 구분한다.
- 실제 macOS release `.app`/WKWebView에서 4096² 난수 RGBA를 유효한 67,126,671바이트 RPAINT01로 저장·복구했다. 원시 픽셀 SHA-256이 일치했고 stale read/delete, 이전 문서 요청, Qt 원본 삭제를 거부했다. 테스트 전후 Qt fixture/lock의 bytes·mtime·inode도 유지됐다. 사용자 실제 복구 저장소 대신 임시 디렉토리와 비영구 WebView를 사용했다.
- 저장소 단계 Rust 14개에 종료 검증 모드 제한과 활성화 성공/실패·재시도 보호 회귀를 추가해 현재 Rust 16개, rustfmt, Clippy `--all-targets -D warnings`가 통과했다. 기존 Windows persistence 모듈 cross-target 타입 검사와 실제 Windows 앱 실행·설치 검증은 구분한다.
- 별도 실제 native debug CLI의 65/300MiB payload 저장·읽기 전체 바이트 비교 통과. 최대 RSS 381.5MiB는 한 번의 Rust CLI 프로세스 측정이며 WebView·IPC·JS/Worker 메모리는 제외한다. 이전 clone probe와 작업 부하가 달라 속도/메모리 개선률로 계산하지 않는다.

종료 보호 수정 시점의 macOS arm64 release `.app`/WKWebView의 3단계 검증도 통과했다. 복구 단계는 유효한 67,126,671바이트 RPAINT01과 픽셀 왕복을 재확인했고, 코덱 단계는 4096²·32768×1 프로젝트/알파 왕복과 도형·Undo 실행, 4096² 표시 픽셀 및 32768×1 JPEG 왕복을 확인했다. 종료 단계는 `runtime`과 `native` 요청 각각에서 미저장·미확정 입력의 취소, busy 거부, 반복 Quit의 상태 보존을 확인했다. 결과 marker를 출력한 뒤 일반 UI 승인 경로로만 exit 0이 되어 `finalApprovedClose=true`를 기록했다. 각 단계는 별도 임시 root와 비영구 WebView를 사용했고 Qt fixture/lock의 내용·mtime·inode·mode는 유지됐다.

이 실행의 앱 SHA-256은 `0b213edb8907f2011d8158c763bda72053333ac876c39b5d1a576b408d00afaa`다. 원시 결과는 `build-web-work/task-planning/max-document/quit-desktop.json`, 정리된 검증 요약은 [최대 문서 근거](evidence/studio-max-document.json)를 따른다. 이는 실제 macOS 네이티브 경로 검증이며 Windows 실행, OS 선택기 조작, 강제 종료 검증을 대신하지 않는다.

후속 [최대 문서·PNG 검증](STUDIO_MAX_DOCUMENT.md)에서 저장/복구를 재검증하고 실제 native 코덱·렌더러 검사도 별도 임시 root로 격리했다. 이 문서의 43개 단위 회귀는 당시 표본이며 최신 개수와 source hash는 후속 기록을 따른다.

## 실제 APFS 공간 부족 검사

현재 `persistence.rs`를 직접 import한 격리 Rust probe에서 실제 OS ENOSPC를 확인했다. 자체 생성한 512MiB APFS sparsebundle의 장치·mountpoint·가상 용량·호스트 여유 공간을 먼저 확인하고 그 볼륨만 채웠다. 유효한 33,563,410바이트 RPAINT01(4096×2048, encode/decode RGBA 왕복 확인)의 수동 저장과 복구 쓰기가 모두 실제 `No space left on device (os error 28)`로 실패했다. 모델 오류 주입이 아니다.

실패 뒤 원본 내용과 inode·mode·uid/gid·mtime/ctime·ACL·사용자 xattr, 기억한 저장 경로, 기존 복구 envelope/sequence 1과 읽기 토큰이 유지됐다. 실패한 쓰기 작업을 해제한 뒤 `.mypaint-*.tmp`는 0개였다. 공간을 확보한 뒤 수동 저장과 동일 sequence 2 복구를 재시도해 전체 bytes 일치·기존 토큰 stale·임시 파일 0개를 확인했다. 반례나 제품 변경은 없었다.

검사 후 자체 장치만 eject하고 이미지와 큰 fixture/build 산출물을 삭제했다. [명령·해시·원시 결과](evidence/studio-pending-contracts.json)의 `actualAPFSEnospc`에 격리·정리 근거를 기록했다. 이 결과는 macOS APFS의 `Stage::write` 경로에 한정한다. rename/commit/directory-sync 오류를 각각 유도한 결과나 실제 WebView/OS 파일 선택기·Windows ENOSPC 검증은 아니다.

## 재실행과 남은 조건

```sh
npm --prefix web-app run check
npm --prefix web-app run format:check
npm --prefix web-app test
npm --prefix web-app run build
# 고정 정적 서버 주소를 PAINT_TEST_URL로 지정
npm --prefix web-app run test:browser
npm --prefix web-app run test:native-profile
npm --prefix web-app run test:native-persistence
cargo test --manifest-path web-app/src-tauri/Cargo.toml --locked
cargo clippy --manifest-path web-app/src-tauri/Cargo.toml --all-targets --locked -- -D warnings
# 해당 Windows/macOS 호스트에서 빌드 후 실제 앱 시험
npm --prefix web-app run desktop:build
npm --prefix web-app run test:native-desktop
```

새 테스트는 npm/웹 CI에 연결했다. 원격 CI는 아직 실행하지 않았다. 실제 native runner는 macOS에서 확인했으며 OS 선택기 자동 조작이나 Windows 인수를 대신하지 않는다.

남은 조건은 Windows 실제 실행·파일 공유/ACL/reparse, 실제 OS 선택기와 저장 취소, Windows 공간 부족 및 rename 실패, 지원 파일시스템 metadata, 최대 문서/전체 IPC 메모리, Android/Safari 실기기 웹, 서명·공증 및 안전 staging이다. 비협조 외부 프로세스의 최종 검사와 rename 사이를 완전한 파일시스템 CAS로 보장하지 않는다. Unix에서 rename 뒤 directory fsync 오류는 기록하지만 이미 교체된 저장을 미확정 실패로 되돌리지 않는다. Windows에는 같은 directory fsync를 적용하지 않으며 교체 전 파일 flush와 새 파일의 `MoveFileExW` write-through를 유지한다. 전원 차단 내구성 인수는 남겨 둔다. 미확정 선택/문자 자동 복구와 강제 종료 임시파일 정리는 별도 작업이다.

### Windows 저장 공유 모드 후속 수정

기준 커밋 `429f135`의 [Windows CI 로그](https://github.com/parkjh2568/myPaint/actions/runs/42197430142/job/127824073497)는 Rust 11개 통과·5개 실패 후 패키징을 계속했다. 실패 원인 중 하나는 임시파일의 쓰기 handle을 유지한 채 `ReplaceFileW`를 호출한 공유 모드 충돌이다. 수정은 같은 임시파일을 `FILE_READ_ATTRIBUTES` 전용으로 열고 살아 있는 writer와 파일 identity를 비교한 뒤 writer를 닫는다. 이 handle은 게시 이후에도 유지해 다른 프로세스가 바꾼 대상 파일을 새 binding으로 오인하지 않도록 한다.

게시 전후 identity, 외부 공유 잠금 실패 후 원본 보존·임시파일 해제·재시도, 부분 실패 때 복구 사본 보존 회귀를 추가했다. 부분 실패 테스트는 문서화된 OS 결과를 모델링하며 실제 Windows 오류를 주입하지 않는다. 이 후속 수정은 소스·독립 리뷰만 완료했으며 Rust 컴파일, rustfmt, Clippy와 실제 Windows 실행은 아직 확인하지 않았다. 위 과거 검증 결과를 이 수정의 실행 증거로 간주하지 않는다. 참고: [ReplaceFileW 계약](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew).

기존 홈페이지·Qt 실행 경로는 보존했으며 commit/push/공개 배포는 수행하지 않았다. [전체 전환 백로그](QT_FREE_MIGRATION_TASKS.md)의 미충족 완료 조건은 계속 열어 둔다.

후속 [미확정 편집 계약 검사](evidence/studio-pending-contracts.json)는 Redo 가드가 포함된 macOS 앱에서 같은 복구·코덱·종료 3단계를 다시 통과했다. 위 앱 해시와 해당 후속 앱 해시는 서로 다른 검증 snapshot이다.


## 최종 화면 캐시 통합 후 확인

2026-11-05의 [통합 근거](evidence/studio-scene-integration.json)는 위의 3단계에 별도 `--smoke --render-smoke --persistence-root` 실행을 추가한다. 최종 macOS arm64 앱 SHA256은 `7bff0a7c5f4201b08b4b2beebac41f7da78dbb4e7cfc93c009a88806a9c0347c`다. 복구·코덱·종료·렌더링 4개 격리 실행이 모두 통과했고 Qt 사본/lock의 bytes·mtime·inode·mode도 보존됐다.

렌더링은 같은 수명을 가진 두 Canvas에서 원래 source 합성과 최종 scene 경로의 화면 14개를 전 채널 비교하고 권위 RGBA 해시도 확인한다. Dirty·rollback·선택 이동/취소·레이어 숨김·분수 종이 경계·축소 fallback을 포함한다. 최대 64개/추정 RGBA 111,436,096바이트, 변경 없는 frame의 source 업로드 0회였다. 이 실행은 렌더링 정확성 검사이며 실제 입력 지연이나 Windows 검증 결과가 아니다. 일반 실행은 smoke 모듈을 요청하지 않는다.


후속 도구·decoder 수정의 최종 macOS 앱 SHA256은 `57205d9db71807e18404cbdbd7d8f2abe2f301205e205eaf273be81138199823`이다. [최신 근거](evidence/studio-tool-contracts.json)의 실제4단계 실행이 통과했고, scene 단계는 기존14화면+권위 RGBA 검사 뒤 작은 독립 PaintDocument의 색 교체 범위·취소/Redo·저알파3개를 JavaScriptCore에서 추가 확인한다. 이는 실제 포인터 UI나 WK 렌더링 지연의 측정이 아니다. 해당 UI 입력 계약은 별도 Chromium 검사에서 확인했다.


후속 마우스 입력 경계 후보도 macOS release 앱을 다시 빌드해 저장·복구/코덱/종료/렌더링 4개 실행을 통과했다. 실행파일 SHA-256은 `282f4b51202f0cac11e99c31f5a582042a3f9d20e7f13398e6d6af0904417f37`이며 [보조 버튼 근거](evidence/studio-pointer-buttons.json)에서 해당 소스·번들과 연결한다. 공개 포인터 23개는 Chromium 입력과 모델 파일 IPC로 검사했고, 실제 macOS smoke를 물리 보조 버튼 입력 검증으로 확대하지 않는다. 이전 decoder 앱은 고정된 별도 경로에 byte-exact로 보존했다.


GIF 입력 후보의 actual macOS 4단계도 통과했다. 실행파일 SHA-256은 `8a1ac4c485cf487f0306e63a754cc485348d23276ed132363629ded598517f55`이며 codec marker의 정적 빨강·애니메이션 첫 빨강·투명 GIF 3개를 runner가 정확히 확인한다. 각 8×6의 48픽셀 RGBA를 전수 비교했다. [후속 근거](evidence/studio-gif-input.json)에 현재 소스·번들과 연결하고 이전 pointer 앱은 별도 frozen 경로에 보존했다. 이 검사는 OS 파일 선택기나 native 전체 메모리 인수를 대신하지 않는다.


단색 스캔 개선을 반영한 일반 macOS 앱도 4단계와 GIF 3·scene 18을 통과했다. 실행파일 SHA-256 `b3b0c8e2e2b36085238d51587a2a9a481f5c5741919712be4fc5a07ef49f4ff9`는 [WK 근거](evidence/studio-wk-render.json)의 고정 앱/소스와 연결한다. 새 timing 12개는 실제 API 반환 시간이며, 원래 scene14 phase의 픽셀 검증은 그 뒤 별도로 실행된다. 임시 mip/API frontend override는 일반 앱 재빌드로 종료했고 제품 Rust/IPC·저장 계약은 변경하지 않았다.
