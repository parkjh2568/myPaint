# 파일 저장·복구와 Tauri 경계 감사

기준은 codex/studio-recovery의 48e4058과 감사 시작 시 작업 트리에 포함된 후속 변경이다. 범위는 Rust 데스크톱 진입점·수명주기·파일 저장소, TypeScript 네이티브 어댑터·IndexedDB 복구·스모크 진입점, 이 경계를 호출하는 Studio 탭·닫기 경로다. 소스 추적, 현재 TypeScript 재현, Windows 산출물 검증을 구분했다. [기준 및 인계](../../../PROJECT_HANDOFF.md) · [현재 상태](../../CURRENT_STATUS.md) · [프로젝트 이력](../../PROJECT_HISTORY.md)

## 모듈 경계와 의존성

~~~mermaid
flowchart TD
    Edit["Studio · 탭, 작업, UI 선택"]
    Doc["PaintDocument · 픽셀, 후보, 이력"]
    Codec["Codec Worker · RPAINT 및 이미지 바이트"]
    Native["native.ts · 파일 및 문서 IPC"]
    Recovery["RecoveryStore · 복구 스냅샷 IPC 및 IndexedDB"]
    Bridge["Tauri main.rs · 창, 대화 상자, IPC"]
    Quit["lifecycle.rs · macOS 종료"]
    Session["Persistence · 세대, 바인딩, 선택 티켓"]
    Stage["Target / Stage · 파일 신원, 원자 교체"]
    Files["사용자 파일 및 .rprec"]
    Browser["IndexedDB · heads와 snapshots"]
    Edit --> Doc
    Edit --> Codec
    Edit --> Native
    Edit --> Recovery
    Native --> Bridge
    Recovery --> Bridge
    Recovery --> Browser
    Bridge --> Session
    Bridge --> Quit
    Session --> Stage
    Stage --> Files
~~~

Studio가 편집 UI와 탭 상태를 소유한다. 엔진과 Worker가 프로젝트 후보와 전체 페이로드를 검증한다. Rust가 경로, 파일 신원, 교체와 네이티브 문서 등록을 소유한다. IPC 문서 키·세대·선택 토큰이 이 경계를 잇는다. native-smoke.ts에서 Studio로 향하는 참조는 타입 전용이고 Studio는 스모크를 동적으로 로드한다. 해당 경로에 런타임 순환 의존성이 없으며, 스모크가 Studio의 캐시·선택·문서·DOM 상태를 직접 조작하는 결합은 테스트 수정 비용을 높인다. [Studio 진입점](../../../web-app/src/main.ts#L4840) · [네이티브 어댑터](../../../web-app/src/platform/native.ts#L1) · [스모크](../../../web-app/src/platform/native-smoke.ts#L1)

| 코드 경계 | 함수군과 책임 |
|---|---|
| Tauri 초기화와 파일 IPC | NativeState::store/activate가 저장소 단일 생성과 성공한 첫 활성화 후 종료 보호를 담당한다. 실패한 초기화는 재시도할 수 있다. activate_document, choose_open, read_selected, choose_save, write_selected, cancel_write가 Picker와 IPC를 연결한다. 파일 읽기와 게시의 블로킹 처리는 별도 작업으로 보낸다. [main.rs](../../../web-app/src-tauri/src/main.rs#L19) |
| Tauri 복구·수명주기 | recovery_list/read/clear/write가 토큰과 raw body를 검증한다. runtime_ready, 각 smoke mode·result·report, smoke_quit, close_window, request_close, argument_path, legacy_path, io_smoke, main이 런타임·창 이벤트·패키지 검증 스위치를 연결한다. [IPC](../../../web-app/src-tauri/src/main.rs#L184) · [빌더](../../../web-app/src-tauri/src/main.rs#L413) |
| macOS 종료 | lifecycle::install이 기존 Tao delegate를 같은 인스턴스 크기의 ObjC 서브클래스로 확장하고 종료 결정을 Rust 이벤트로 전달한다. terminate는 메인 스레드 마커가 있을 때 AppKit 종료를 실행한다. ObjC 동적 주입과 단일 OnceLock의 수명주기는 macOS 패키지에서 확인할 영역이다. [lifecycle.rs](../../../web-app/src-tauri/src/lifecycle.rs#L1) |
| 파일 검증·게시 | error/valid_key/valid_name/now/token은 오류 문자열과 세션 식별을 제공한다. metadata_stamp/open_regular/stamp, Directory::open/check, Target::new/capture_content/fingerprint/check, read_target이 일반 파일 여부·크기·정규 경로·디렉터리 및 파일 신원·내용 SHA-256을 검증한다. Stage::new/write/commit/replacement_error/Drop이 같은 디렉터리의 임시 파일 및 게시를 소유한다. [파일 신원](../../../web-app/src-tauri/src/persistence.rs#L24) · [스테이지](../../../web-app/src-tauri/src/persistence.rs#L287) · [읽기](../../../web-app/src-tauri/src/persistence.rs#L540) |
| 네이티브 세션 | Persistence::new/forbidden/activate/register_open/read_selected/existing_save/add_save/register_save/cancel/claim_save가 문서별 바인딩, 승인된 읽기·쓰기 티켓, 취소 플래그를 관리한다. Session::active_document/active_document_mut가 활성 키에서 문서를 조회한다. [세션 타입](../../../web-app/src-tauri/src/persistence.rs#L616) · [활성화](../../../web-app/src-tauri/src/persistence.rs#L739) · [파일 명령](../../../web-app/src-tauri/src/persistence.rs#L870) |
| 네이티브 복구 | LegacyGuard::new/check, Head::valid, filename/read_head, scan/list/recovery_read/clear/claim_recovery가 잠금·이전 데이터 읽기·목록 격리·할당량·최신 스냅샷 확인을 처리한다. RecoveryLease::drop, WriteJob::write/commit/Drop이 쓰기 직렬화, 게시 및 정리를 맡는다. [복구 타입](../../../web-app/src-tauri/src/persistence.rs#L563) · [헤더](../../../web-app/src-tauri/src/persistence.rs#L703) · [복구 명령](../../../web-app/src-tauri/src/persistence.rs#L1050) · [쓰기 작업](../../../web-app/src-tauri/src/persistence.rs#L1401) |
| WebView 파일 클라이언트 | isDesktop/activateNative/openNative/saveNative가 IPC 호출, 응답 형식·세대 검사와 취소 전달을 담당한다. 앱에는 경로 대신 토큰과 표시 이름이 온다. [native.ts](../../../web-app/src/platform/native.ts#L1) |
| WebView 복구 클라이언트 | openBrowserRecovery/validEntry/sameBrowserEntry/sha256이 두 IndexedDB 저장소와 행 정체성을 다룬다. RecoveryStore의 request/listBrowser/writeBrowser/copyLegacyBrowser/read/reset에 네이티브 디스패치, 브라우저 트랜잭션, 마이그레이션, 문서 키·시퀀스가 모여 있다. [storage.ts](../../../web-app/src/platform/storage.ts#L13) |
| 패키지와 신뢰 경계 | Cargo manifest와 잠금 파일이 Rust 요구 버전과 Tauri 의존성을 명시한다. build.rs가 Tauri 컨텍스트를 빌드한다. 릴리스가 번들 UI를 로드하고 개발 서버는 localhost를 사용한다. CSP는 IPC 연결, 로컬 script·worker·폰트, data/Blob 이미지와 인라인 CSS 허용을 선언한다. capability는 main 창의 core:default이며 등록된 파일 명령은 네이티브 Picker와 티켓을 사용한다. Windows/macOS 외 데스크톱 빌드는 컴파일 단계에서 제한된다. [Cargo.toml](../../../web-app/src-tauri/Cargo.toml) · [Cargo.lock](../../../web-app/src-tauri/Cargo.lock) · [build.rs](../../../web-app/src-tauri/build.rs) · [Tauri 설정](../../../web-app/src-tauri/tauri.conf.json) · [main capability](../../../web-app/src-tauri/capabilities/main.json) · [OS 조건](../../../web-app/src-tauri/src/main.rs#L1) |
| 스모크 | runNativeSmoke가 타일/씬 타이밍과 픽셀, 종료 대화 상자 및 취소, 대형 IPC와 복구 토큰·이전 저장소, 극단 종횡비와 GIF 알파를 검증한다. [렌더](../../../web-app/src/platform/native-smoke.ts#L8) · [종료](../../../web-app/src/platform/native-smoke.ts#L649) · [저장](../../../web-app/src/platform/native-smoke.ts#L743) · [코덱](../../../web-app/src/platform/native-smoke.ts#L900) |

## 실행 경로와 계약

1. **파일 열기와 경로 바인딩.** Picker 선택 후 Rust가 부모 디렉터리와 파일 신원을 기록한다. read_selected는 제한 내 바이트를 반환하며, 확장자가 .rpaint이고 프로젝트 매직과 일치하면 바이트의 SHA-256을 토큰에 연결한다. Studio가 Worker로 후보를 전체 검증한 뒤 탭 활성화 시 소스 토큰을 보낸다. activate가 원본 변경을 재검사한다. 보호된 복구 원본은 쓰기 경로에서 제외하며, 이미지 가져오기와 복구로 연 문서는 프로젝트 저장 시 경로를 얻는다. [파일 읽기](../../../web-app/src-tauri/src/persistence.rs#L870) · [활성화](../../../web-app/src-tauri/src/persistence.rs#L791) · [Studio 파일 작업](../../../web-app/src/main.ts#L3490)
2. **저장과 내보내기.** 프로젝트 일반 저장은 활성 탭의 바인딩을 조회하고, 다른 이름 저장과 이미지 내보내기는 Picker로 목적지를 지정한다. 쓰기 티켓에는 세대·유형·파일 신원과 내용 해시가 있다. Rust가 크기와 프로젝트 매직을 검사한 뒤 일회용 티켓을 청구한다. 성공한 프로젝트 영수증과 동일 세대를 확인한 후 Studio가 후보를 커밋하고 저장 상태를 표시한다. [Studio 저장](../../../web-app/src/main.ts#L3591) · [IPC 어댑터](../../../web-app/src/platform/native.ts#L48) · [티켓 청구](../../../web-app/src-tauri/src/persistence.rs#L1012)
3. **파일 게시.** 동일 디렉터리에 배타적으로 만든 스테이지에 최대 2 MiB 청크를 쓰며 취소를 확인하고 해시를 축적한다. flush 및 sync 뒤 디렉터리와 대상 신원을 재검증한다. Windows는 기존 파일 교체와 신규 파일 이동을 분기한다. macOS 신규 파일은 배타적 rename으로 게시한다. Windows의 특정 부분 교체 오류 1176/1177에서는 스테이지를 보존한다. Unix는 rename 뒤 디렉터리 sync 실패를 stderr로 남기고 성공 상태를 유지한다. 파일 원본 보존 테스트는 실패 주입 및 교체 결과를 검증한다. 전원 장애 후 디렉터리 변경 내구성은 별도 검증 범위다. [쓰기와 게시](../../../web-app/src-tauri/src/persistence.rs#L365) · [실패 정리](../../../web-app/src-tauri/src/persistence.rs#L504)
4. **전환과 닫기.** Studio의 epoch, 탭 복구 키·세대, Rust 활성 키·세대와 문서별 바인딩이 동기화된다. 대상 탭의 활성화 성공 후 출발 탭 후보를 설치하고 복구를 예약한다. 네이티브 전환 검증 실패 시 이전 세션을 유지한다. 성공한 닫기는 출발 문서 레코드와 복구 대기 플래그를 폐기하며 커밋된 복구 스냅샷은 보존한다. 활성 문서를 바꿀 때 이전 세대의 명시적 파일 쓰기를 취소한다. 비활성 문서는 마지막 세대로 자기 복구를 계속할 수 있다. [전환과 닫기](../../../web-app/src/main.ts#L3334) · [세션 전이](../../../web-app/src-tauri/src/persistence.rs#L791) · [복구 세대](../../../web-app/src-tauri/src/persistence.rs#L1323)
5. **자동 복구와 다시 열기.** Studio의 직렬 큐가 탭·문서·리비전을 확인하고 제한된 복제본을 Worker로 인코딩한다. 쓰기 성공 후에만 복구 리비전이 전진한다. 네이티브 파일은 8바이트 RPREC001, 4바이트 little-endian 길이, 최대 4,096바이트 JSON 헤더, RPAINT01 본문 순서다. 키별 시퀀스와 스냅샷당 300 MiB, 전체 1 GiB, 최대 32개를 검사한다. 브라우저는 플랫폼 파일 상한과 DB 최대 32개·전체 64 MiB를 적용하고 heads와 snapshots를 같은 트랜잭션으로 게시한다. 목록 토큰과 행 및 본문을 검증한 뒤 전체 디코딩이 성공하면 새 탭을 활성화한다. 레거시 브라우저 행은 검증한 페이로드와 메타데이터의 해시로 결정적인 복사 키를 만들며 원본은 읽기 전용이다. [복구 큐](../../../web-app/src/main.ts#L4125) · [복구 헤더](../../../web-app/src-tauri/src/persistence.rs#L709) · [네이티브 저장량](../../../web-app/src-tauri/src/persistence.rs#L1323) · [DB 트랜잭션](../../../web-app/src/platform/storage.ts#L259) · [레거시 복사](../../../web-app/src/platform/storage.ts#L334)
6. **창 종료.** 첫 네이티브 문서 활성화 후 OS 요청을 보류하고 WebView에 mypaint-close-request를 전달한다. Studio가 진행 중 작업과 열린 대화 상자를 확인하고 탭별 미저장 결정을 처리한 뒤 close_window로 승인한다. 이후 Windows 창 닫기 및 macOS 앱 종료가 실행된다. [Rust 보호](../../../web-app/src-tauri/src/main.rs#L342) · [Studio 승인](../../../web-app/src/main.ts#L609)

| IPC 계약 | 경계에서 고정할 필드와 실패 처리 |
|---|---|
| `activate_document` | 세대·문서 키·선택적 소스 토큰·closePrevious. 더 큰 세대 또는 변경이 없는 같은 세대만 받는다. 대상 검증 실패에선 이전 문서 레코드와 바인딩을 유지한다. [IPC](../../../web-app/src-tauri/src/main.rs#L58) · [세션](../../../web-app/src-tauri/src/persistence.rs#L791) |
| `choose_open/read_selected`, `choose_save/write_selected/cancel_write` | Picker 취소는 null, 선택은 이름·토큰과 쓰기 세대, 읽기 데이터는 raw 응답, 쓰기는 raw body와 x-save-token의 조합이다. 프로젝트 영수증은 이름·세대·project를 반환한다. [읽기](../../../web-app/src-tauri/src/main.rs#L76) · [쓰기](../../../web-app/src-tauri/src/main.rs#L105) |
| `recovery_list/read/write/clear` | 목록은 entries와 warnings, 읽기·삭제는 선택 토큰, 쓰기는 raw body와 x-recovery-generation/key/sequence/name 헤더다. 이름은 UTF-8 Base64이며 결과를 해석하기 전에 길이를 제한한다. 목록을 다시 불러오면 기존 선택 티켓이 만료되고, 레거시 원본에 대한 삭제는 거부된다. [복구 IPC](../../../web-app/src-tauri/src/main.rs#L184) · [티켓·읽기](../../../web-app/src-tauri/src/persistence.rs#L1243) |
| `runtime_ready/close_window` 및 스모크 | main 창 라이프사이클 승인, 런타임 준비, 명령행 테스트 모드의 보고 경계를 구성한다. --persistence-root가 있는 실행은 별도 app/legacy 경로와 incognito WebView를 사용한다. 격리된 산출물 검증에서 기본 사용자 저장소와 구분하는 계약이다. [스모크 모드](../../../web-app/src-tauri/src/main.rs#L263) · [앱 설정](../../../web-app/src-tauri/src/main.rs#L413) |

## 결함과 우선순위

이 부록의 P1은 문서 또는 영구 파일 보존 문제를 포함한다. 상위 보고서에서는 기존 파일 손상 가능성이 있는 비활성 탭의 내보내기 경로를 P0로 분류한다.

P1은 사용자 프로젝트나 Redo 손실 경로, P2는 복구 가용성·오류 처리·중대한 성능 위험, P3는 방어 심화 및 유지 비용이다. S는 독립적인 국소 변경, M은 여러 경계와 회귀 검증이 필요한 변경, L은 여러 운영체제에서 게시 타이밍을 검증해야 하는 변경이다.

| 순위·비용 | 확인한 경로와 영향 | 수정 및 검증 범위 |
|---|---|---|
| **P1 / M** | 비활성 탭의 프로젝트 파일을 이미지로 덮어쓸 수 있다. register_save는 활성 문서의 바인딩에 대해서만 이미지 목적지의 경로와 파일 신원을 대조한다. 사용자가 A 프로젝트를 연 채 B에서 A의 파일이나 같은 파일 신원의 별칭을 Picker로 승인하면, 이미지 쓰기가 그 목적지에 발급될 수 있다. .rpaint 확장자와 프로젝트 매직 검사는 프로젝트 요청에 적용된다. claim_save와 게시에서 비활성 탭을 보호하는 검사는 없다. 현행 Rust 회귀는 활성 탭을 보호하는 경로에 한정된다. 근거는 현재 소스의 분기다. | 열린 문서의 바인딩 전체와 이미지 목적지를 경로 및 파일 신원으로 대조한다. 티켓 발급과 게시에 동일한 보호 규칙을 적용한다. A/B 탭, hard link, 외부 교체, 정상 이미지 내보내기, 명시적 프로젝트 다른 이름 저장과 원본 바이트를 각각 검증한다. [Picker](../../../web-app/src-tauri/src/main.rs#L123) · [발급](../../../web-app/src-tauri/src/persistence.rs#L966) · [청구](../../../web-app/src-tauri/src/persistence.rs#L1012) · [게시](../../../web-app/src-tauri/src/persistence.rs#L1429) · [기존 회귀](../../../web-app/src-tauri/src/persistence.rs#L2057) |
| **P1 / M** | 비활성 탭 닫기 취소가 다른 탭의 후보와 Redo를 바꾼다. closeTab('b')는 사용자 확인보다 먼저 B를 활성화하며 A의 후보를 커밋한다. 현재 메서드와 실제 PaintDocument를 기존 Node 하네스에서 실행했다. A에 Redo와 대기 픽셀 [28,199,42,255]을 두고 B 닫기를 취소하자 탭은 2개였으나 B가 활성화됐고, A의 기존 Redo가 대기 편집으로 교체됐으며, 그 편집이 복구에 기록됐다. 창 닫기의 탭 순회에도 같은 전환이 선행한다. 기존 닫기 취소 회귀는 탭 수를 비교한다. | 대상 탭의 변경·후보 여부를 미리 조회하고 그 탭의 저장/폐기 결정을 받는다. 탭 활성화·후보 설치·키 폐기는 승인 후에 수행한다. 창 종료는 취소 가능한 확인과 실제 종료·저장을 구분하고 이미 성공한 사용자 승인 저장을 보존한다. 활성 키, 세대, 후보, 픽셀, Undo/Redo, 복구 큐와 바인딩을 단언한다. [닫기](../../../web-app/src/main.ts#L3388) · [종료 순회](../../../web-app/src/main.ts#L609) · [현행 취소 회귀](../../../web-app/tests/document-tabs.test.ts#L130) |
| **P2 / M** | 네이티브 복구 목록 오류가 브라우저 폴백도 가로막는다. request('list')가 먼저 네이티브 IPC 및 전체 응답을 검증하며, 실패하면 두 IndexedDB 소스에 도달하지 않는다. 현재 모듈에 IPC 실패를 주입했을 때 IndexedDB 열기 횟수는 0이었다. IPC 전체 오류·형식 불일치가 정상 브라우저 행까지 숨긴다. | 네이티브, 현재 DB, 레거시 DB를 독립 실행하고 소스별 결과와 제한된 오류를 병합한다. 부분 성공 시 정상 항목과 오류를 함께 제공하고 전체 실패 시 재시도를 제시한다. [네이티브 목록](../../../web-app/src/platform/storage.ts#L128) · [브라우저](../../../web-app/src/platform/storage.ts#L202) |
| **P2 / M** | 복구 헤더 한 개의 손상으로 새 쓰기가 계속 거부될 수 있다. Rust list는 손상 파일을 경고로 격리하며, scan은 다음 쓰기에서 바이트·개수·신원 검증을 엄격히 적용한다. 브라우저 writeBrowser도 불량 헤더에서 트랜잭션을 중단한다. 목록에서는 헤더가 맞고 본문이 없는 행이 열기까지 정상 항목으로 보일 수 있다. Rust 목록의 128개 디렉터리 탐색 상한에는 임시 파일도 포함돼, 많은 임시 파일이 남으면 정상 행이 누락될 수 있다. | 손상·초과·임시 보존 파일을 구분해 사용자에게 제공하고 읽기 전용 확인과 격리 후 재시도를 제공한다. 원본 보존, 탐색 상한, 할당량, Windows의 예외적 임시 파일 보존을 검증한다. [네이티브 탐색](../../../web-app/src-tauri/src/persistence.rs#L1050) · [브라우저 목록과 쓰기](../../../web-app/src/platform/storage.ts#L213) |
| **P2 / M** | 창 종료 요청의 이벤트 전달 실패가 화면에 드러나지 않는다. request_close는 webview.eval 결과를 버린 뒤 닫기를 보류한다. WebView가 이벤트를 평가할 수 없는 상태에서는 저장·종료 선택이 전달되지 않는다. 초기 활성화 실패 후 재시도는 첫 복구 탐색 타이머를 다시 등록하지 않는다. 비활성 탭 복구 쓰기 오류는 현재 탭 비교 때문에 즉시 보이지 않는다. | 종료 요청의 접수·승인·실패를 구분해 안전하게 재시도하도록 처리한다. 초기 활성화 성공 직후에 복구 탐색을 한 번 예약한다. 복구 오류는 문서별 상태와 재시도 결과로 귀속한다. [네이티브 닫기](../../../web-app/src-tauri/src/main.rs#L348) · [초기화 재시도](../../../web-app/src/main.ts#L647) · [복구 큐 오류](../../../web-app/src/main.ts#L4161) |
| **P2 / L** | 대용량 파일 해시와 세션 잠금에 따른 응답 지연 위험이 있다. 기존 파일은 승인, 스테이지 준비, 게시에서 최대 300 MiB를 다시 해시한다. 원본 토큰 활성화와 게시 중 긴 검사 또는 동기화가 세션 mutex 안에 있다. cancel_write는 취소 플래그를 바꾸려면 잠금이 필요하다. read_target은 승인 크기보다 파일이 커지면 전역 상한까지 읽고 나서 크기 불일치를 검출할 수 있다. CPU·메모리·취소 지연 수치는 아직 계측하지 않았다. | 먼저 크기별 해시 통과 수·잠금 시간·취소 응답을 기록한다. 읽기는 승인 크기+1로 외부 성장 검출 비용을 줄인다. 잠금 축소는 길게 읽은 결과에 대한 게시 직전 파일 신원 및 문서 세대 재검증을 포함한다. Windows/macOS의 취소 직전·직후, 동시 변경, 최대 크기, 부분 교체 실패를 확인한다. [해시](../../../web-app/src-tauri/src/persistence.rs#L230) · [읽기](../../../web-app/src-tauri/src/persistence.rs#L540) · [취소](../../../web-app/src-tauri/src/main.rs#L181) · [게시 잠금](../../../web-app/src-tauri/src/persistence.rs#L1429) |
| **P3 / S** | 형식상 정상이며 세대가 다른 저장 티켓 응답을 렌더러가 거절할 때 cancel_write를 송신하지 않는다. 응답을 위조한 Node 검증에서 choose_save만 기록됐다. 정상 Rust 응답은 현재 세대를 사용한다. 또 AbortSignal은 Picker 응답 후 다시 검사되고 Picker에 부모 창 설정이 없다. Windows/macOS 포커스 및 모달 동작은 실기 확인 범위다. | 거절된 토큰이 이번 요청 소유임을 입증할 수 있을 때 티켓 정리를 전달한다. 창 및 Picker의 포커스, 부모 설정 후 취소, 티켓 수 상한을 각각 확인한다. [렌더러 응답](../../../web-app/src/platform/native.ts#L25) · [Picker](../../../web-app/src-tauri/src/main.rs#L76) |
| **P3 / S** | IndexedDB는 읽기 트랜잭션 정상 완료 후 Blob.arrayBuffer()를 끝낼 때까지 연결을 보유한다. blocked 열기와 뒤늦은 성공은 정리하지만 versionchange 연결 종료는 없다. 레거시 복사에는 최대 40 MiB 웹 입력 해시와 중복 판정 시 추가 Blob 읽기 비용이 있다. 반복 작업의 실측 수치는 없다. | 완료된 트랜잭션과 바이트 변환의 소유기간을 구분한다. 연결 종료를 보장하고 다중 창에서 읽기와 버전 갱신의 경쟁을 확인한다. [DB 열기](../../../web-app/src/platform/storage.ts#L18) · [복사와 읽기](../../../web-app/src/platform/storage.ts#L334) · [웹 크기 정책](../../../web-app/src/engine/document.ts#L1) |

## 유지보수와 분리 지점

- **복구 저장소 소유권.** request(operation, entry?, bytes?, name)가 목록·저장·삭제 프로토콜을 한 타입에 담는다. 반환 공용체에는 Uint8Array가 있으며 본문 반환은 별도 read가 담당한다. 소스 검색에서 RecoveryStore.reset 호출은 발견하지 못했다. list/write/clear/read의 명시적 API를 두고 네이티브·IndexedDB의 동작부터 각각 테스트한다. 탭 컨트롤러가 문서 세대 연결을 소유하게 한다. validEntry와 sameBrowserEntry의 자료 검사는 하나의 공유 규약으로 유지한다. [복구 API](../../../web-app/src/platform/storage.ts#L81) · [미호출 reset](../../../web-app/src/platform/storage.ts#L406)
- **파일 자원과 쓰기 상태.** Directory/Target/Stage의 RAII와 LegacyGuard/RecoveryLease는 파일·임시 파일·잠금 해제의 실제 수명주기를 소유한다. WriteJob에 JobKind, 명시적 저장 토큰과 복구의 빈 문자열 센티널, Option<Stage>, 취소가 공존해 유효한 조합을 읽기 어렵다. 프로젝트 저장과 복구 쓰기를 유형으로 표현하고 저수준 Stage를 공유한다. 파일 신원과 게시, 문서 세션, 복구 인덱스 경계에서 분리하며 기존 IPC 이름과 .rprec 형식을 고정한다. [WriteJob](../../../web-app/src-tauri/src/persistence.rs#L1401)
- **주석·오류·의존성.** Windows attributes-only 핸들, 부분 교체 실패와 임시 파일 보존, 레거시 잠금의 가져오기 이유를 설명하는 주석은 장치 제약을 기록한다. open_regular의 OS 플래그를 명명된 플랫폼 상수와 대조한다. 오류는 프로토콜·용량·세대·파일 변경·I/O를 구조적으로 분류하고 한국어 표시 계약을 유지한다. return Err(…) 뒤의 불필요한 물음표 제거는 Rust Clippy로 확인한다. tempfile 직접 사용은 테스트에 있으므로 all-targets 및 locked 모드에서 확인하고 dev dependency로 이동할 수 있다. [Windows 파일 열기](../../../web-app/src-tauri/src/persistence.rs#L107) · [부분 실패](../../../web-app/src-tauri/src/persistence.rs#L504) · [티켓 상한](../../../web-app/src-tauri/src/persistence.rs#L940) · [의존성](../../../web-app/src-tauri/Cargo.toml)
- **스모크 소유권.** runNativeSmoke가 렌더 성능, 종료, 복구, 코덱의 서로 다른 수명주기를 가진다. 750 ms 대기를 앱의 준비 완료 신호로 바꾸고 각 시나리오의 설정·검증을 함께 분리한다. 명령행 게이트, 픽셀 및 시간 기준을 보존한다. Studio 런타임 프로파일의 데스크톱 판정은 기존 isDesktop을 사용할 수 있다. [스모크 시작](../../../web-app/src/platform/native-smoke.ts#L8) · [프로파일](../../../web-app/src/main.ts#L88)

## 적용 순서와 완료 확인

1. **데이터 손실 회귀를 고정한다.** A/B 탭과 파일 별칭에서 이미지 쓰기 차단 및 원본 바이트 동일성을 확인한다. 닫기 취소는 활성 키·세대·Redo·대기 후보·복구 큐를 검증한다. Windows 실제 Picker와 창 닫기를 추가 확인한다. [Rust 파일·탭 회귀군](../../../web-app/src-tauri/src/persistence.rs#L1535) · [TS 탭 회귀군](../../../web-app/tests/document-tabs.test.ts)
2. **복구 실패를 소스와 탭 단위로 격리한다.** 세 소스의 교차 실패, 불량 헤더·본문, 오래된 토큰, 네이티브 준비 재시도, 비활성 탭의 오류 후 성공을 테스트한다. 파일 및 디코딩 상한과 실패 시 이전 스냅샷 보존을 유지한다. [TS 저장소 회귀](../../../web-app/tests/recovery-store.test.ts) · [Rust 복구 회귀](../../../web-app/src-tauri/src/persistence.rs#L2041)
3. **경계를 분리하고 성능을 계측한다.** IPC 이름·raw body 헤더·프로젝트 매직·복구 엔벨로프·DB 이름·바인딩을 회귀에 고정한다. 파일 및 복구 소유권 분리 후 동일 테스트를 실행한다. 잠금 축소와 해시 최적화에서는 운영체제별 교체 실패·취소·외부 변경을 다시 검증한다. [파일 규약](../../FILE_FORMAT.md) · [네이티브 저장](../../STUDIO_NATIVE_PERSISTENCE.md)
4. **릴리스 경계를 검증한다.** Windows는 NSIS에서 추출한 앱과 설치 실행 경로를 구분해 기록한다. macOS는 실제 창 및 Dock/AppKit 종료와 공유 잠금을 확인한다. 패키지, 커밋, 테스트 출력, RGBA 해시와 원본 보존 증거를 연결한다. [스모크 실행 경로](../../../web-app/src-tauri/src/main.rs#L263) · [승인 매트릭스](../STUDIO_ACCEPTANCE_MATRIX.md)

## 검증 기록

| 현행 테스트 함수군 | 관찰하는 상태와 남은 구멍 |
|---|---|
| Tauri 초기화·종료 단위 | 기본 실행에서 smoke 모드 비노출, 다른 세션 잠금 해제 뒤 초기화 재시도, 성공한 첫 활성화 뒤 종료 보호 무장을 확인한다. WebView 이벤트 전달 실패 또는 macOS 실제 종료는 패키지 시험이 필요하다. [main.rs 테스트](../../../web-app/src-tauri/src/main.rs#L490) |
| 저장 경로와 원자 교체 | 탭별 바인딩, 닫힌 탭 등록 상한, 비활성 탭 복구, 만료·취소, 같은 메타데이터의 내용 변경, 읽은 내용 및 실제 게시 파일의 신원, 부분 교체 실패, Windows 공유 실패·ACL, Unix symlink·부모 교체를 검증한다. 비활성 탭 원본으로의 이미지 내보내기가 회귀에 추가돼야 한다. [세션 회귀](../../../web-app/src-tauri/src/persistence.rs#L1535) · [스테이지 회귀](../../../web-app/src-tauri/src/persistence.rs#L1858) · [대상 검사](../../../web-app/src-tauri/src/persistence.rs#L2057) · [ACL 검사](../../../web-app/src-tauri/src/persistence.rs#L2440) |
| 복구 계약 | 목록 새로고침의 토큰 만료, 파손 목록 격리와 엄격한 쓰기, 32개·1 GiB 상한 및 교체할 기존 키 제외, 오래된 세대·게시 전 취소, 레거시 실시간 잠금과 읽기 전용 이전 파일을 검증한다. IPC 전체 오류에서 정상 브라우저 소스가 살아 있어야 하는 테스트가 필요하다. [Rust 회귀](../../../web-app/src-tauri/src/persistence.rs#L2041) · [레거시·목록 회귀](../../../web-app/src-tauri/src/persistence.rs#L2317) · [TypeScript 어댑터 회귀](../../../web-app/tests/recovery-store.test.ts) |

- 현재 소스에서 `node --import tsx --test tests/native.test.ts tests/recovery-store.test.ts tests/document-tabs.test.ts`를 실행해 **28/28 통과**했다. 별도 실행에서 비활성 탭 취소 후 활성 탭·픽셀·Redo·복구 기록의 변경, 네이티브 목록 오류 후 IndexedDB 미실행, 세대 불일치 티켓 거절 후 IPC 취소 미전송을 재현했다. 범위는 Node 하네스와 소스 주입이다. [네이티브 어댑터](../../../web-app/tests/native.test.ts) · [복구 저장소](../../../web-app/tests/recovery-store.test.ts) · [문서 탭](../../../web-app/tests/document-tabs.test.ts)
- 보관된 Windows MSVC 기록은 Rust **29/29 통과**이며, 이전 NSIS에서 추출한 앱의 실제 WebView2 두 번 실행에서 탭을 전환한 후 강제로 종료·재실행해 416개 변경 픽셀의 RGBA 해시가 복구된 것을 기록한다. 닫힌 탭 바인딩 해제, 이웃 탭 경로 보존, 닫힌 세대 쓰기 거절도 해당 산출물로 확인했다. 이 부록 담당 범위에서 Rust 테스트, 릴리스 빌드, macOS 종료 시나리오를 독립 재실행하지 않았다. Rust 전체 린트 확인 명령은 `cargo clippy --manifest-path web-app/src-tauri/Cargo.toml --all-targets --locked -- -D warnings`이며, 기존 기록은 지정 범위 GNU Clippy와 MSVC 테스트·포맷을 증명한다. [Windows 증거](../../CURRENT_STATUS.md) · [탭 검증](../../DOCUMENT_TABS.md)
