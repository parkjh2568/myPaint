# Qt-free Studio 구현·플랫폼 범위와 검증

2026-11-05 / 개발 중인 `web-app/`의 현황. 전체 34개 태스크의 완료나 정식 출시를 의미하지 않는다. 기존 Qt 앱과 게시된 홈페이지는 전환 기준으로 보존한다.

최신 로컬 웹 검증은 [QF-04 문서·알파·비동기 확정 계약](STUDIO_DOCUMENT_CONTRACTS.md)에 정리했다. 직전 저장·복구 소유권 수정은 [이전 보고](STUDIO_NATIVE_OWNERSHIP.md)를 따른다. Codec 응답 계약 수정은 [이전 보고](STUDIO_CODEC_REPLY.md)를 따른다. 아래 날짜별 기록은 당시 소스·실행 범위이며 현재 전체 완료 상태는 [완료 감사](STUDIO_COMPLETION_AUDIT.md)를 따른다.

[독립 기준 목록·QF-02 완료](STUDIO_FIXTURE_BASELINE.md)에서10개 수정·17도구·6상태 영역의 기준과 허용차를 고정했고, Qt producer 재현·Node324·CTest6·고정 스프레이2case를 확인했다. 제품 변경이나 전체 플랫폼/출시 완료 선언은 아니다.

[QF-04 완료·Minor 수정](STUDIO_DOCUMENT_CONTRACTS.md)에서는 늦은 복구 목록 오류의 epoch 검사를 catch에 한 줄 추가했다. 수정 전 상태문구 재현 실패→수정 후 공개 저장/복구16·조회흐름7·내보내기12가 통과했다. 현재 entry는 `index-DIgO41Ne.js`, payload9/291,664B이며 native 재빌드/새 GUI 검증은 하지 않았다.

[QF-03 측정기 v2·방법 검증](STUDIO_MEASUREMENT_METHOD.md): 개발 benchmark의 출력/operand 범위·입력 연결·정확성/cleanup·환경 기록을 보완했다. 제품17개와payload는 그대로다. 기기별 예산·tail·실제 표시·Android 인수는 아직 미완료다.

[공통 코어 입력·교차 검증](STUDIO_MATCHED_CORE.md): 독립 Python RGBA 기준과 Node wire producer, 개발용 Qt/Node12 API 프로브를 추가했다. 정상/교차/오류·예산 경계를 검증했으며 제품 소스와 배포 payload는 그대로다.

## 확정된 플랫폼 범위

| 대상 | 제공 방식 | 빌드·인수 범위 |
| --- | --- | --- |
| Android 휴대폰·태블릿 | HTTPS 웹 브라우저 | Chrome의 실제 터치·다운로드·복구 확인. APK/AAB 없음 |
| iPhone·iPad | HTTPS 웹 브라우저 | Safari 웹 호환성 확인. iOS/iPadOS 앱·스토어 배포 없음 |
| Windows | 웹 + 설치 실행파일 | 같은 웹 엔진을 Tauri/WebView2로 묶고 NSIS 패키지 생성 |
| macOS | 웹 + 설치 실행파일 | 같은 웹 엔진을 Tauri/WKWebView로 묶고 `.app` 생성 |

화면은 CSS 폭, `any-pointer: coarse`, 실제 PointerEvent로 대응한다. OS 문자열로 태블릿을 단정하지 않는다. `tools/desktop.mjs`는 Windows/macOS 호스트의 dev/build만 허용하고 모바일 명령·타깃 인자를 거부한다. Rust에도 그 외 OS의 네이티브 컴파일 거부를 둔다. 새 CI의 설치형 행렬은 Windows/macOS뿐이다. 기존 Qt CI의 Linux 작업은 전환 회귀 검사다.

## 구조와 데이터 계약

- `src/engine/document.ts`: 직선 RGBA8 권위 픽셀, 레이어·활성 레이어·revision/saved revision, 128px 타일 획과 패치 이력. 픽셀을 DOM 상태나 PNG 이력에 넣지 않는다.
- `src/engine/format.ts`, `operations.ts`: RPAINT01·제한된 PNG 코덱, 크기/바이트 검증, 합성·채우기·변형. PNG 인코딩은 로컬 fflate, 제한된 스트리밍 inflate 검증은 pako를 사용한다.
- `src/main.ts`, `style.css`, `ui/icons.ts`: 편집·미확정 선택/문자/도형, 도구와 대화상자, 포인터·두 손가락 탐색, Studio/Classic 98 스킨. 순차 작업은 해당 함수에 둔다.
- `src/platform/codec.ts`, `workers/codec.worker.ts`: 코덱/채우기 Worker의 전송·취소·20초 제한·최대 2개 작업과 종료 자원 관리. SharedArrayBuffer나 교차 출처 격리 헤더를 요구하지 않는다.
- `src/platform/tiles.ts`: 원본 픽셀 타일과 불투명 최종 화면 캐시의 합계 64개/128MiB 추정 예산을 소유한다. 축소·작은 작업량·예산 초과는 기존 경로를 유지한다. `native-smoke.ts`는 명시 검증 모드에서만 지연 로드한다.
- `src/platform/storage.ts`: 웹은 기존 IndexedDB 복구를 유지하고, 설치형은 native 파일 복구와 이전 IndexedDB/Qt 사본 읽기를 연결한다. 웹과 다른 origin의 저장소는 자동 공유되지 않는다.
- `src/platform/native.ts`, `src-tauri/`: OS 저장 선택권, 선택 토큰에 한정된 원자 교체와 취소, 외부 변경 감지·동시 실행 잠금. 포인터와 그림 데이터를 프레임마다 IPC로 보내지 않는다. 설치형은 번들 로컬 UI만 표시한다.

기존 RPAINT01 필드·매직·순서·UTF-8·PNG 레이어를 유지한다. 불투명/반투명 PNG의 원시 RGBA 바이트는 새 엔진 왕복에서 보존한다. Qt fixture와는 실제 저장 표현인 premultiplied 채널과 알파를 비교한다. Qt의 저알파 `pixelColor()` 역변환과 raw PNG가 1 LSB 다를 수 있어, 그 역변환 값으로 새 픽셀을 정규화하지 않는다.

문서 `background`는 지우기·확장 색이다. 보조색·체커보드 표시·JPG/BMP 출력 바탕과 분리한다. 투명 PNG는 알파를 유지하고 JPG/BMP에는 명시한 불투명 바탕을 합성한다.

편집은 후보를 검증한 뒤 확정하며 실패/취소 시 현재 픽셀·Redo·미확정 선택을 보존한다. 네이티브 저장은 필요한 편집 이력을 먼저 준비하고 파일의 원자 교체가 성공한 뒤 설치한다. 교체 직전까지 받은 취소는 원본을 유지하며, 교체가 이미 성공한 이후의 늦은 취소는 저장 성공으로 처리한다. 브라우저는 다운로드 준비/요청을 저장 완료로 표시하지 않고 편집과 이력을 유지한다.

## 실행·빌드

Node 24, lockfile의 npm 의존성을 사용한다. Windows/macOS 설치형에는 Rust 1.94와 해당 OS의 네이티브 도구가 추가로 필요하다.

```sh
npm --prefix web-app ci
npm --prefix web-app run dev
npm --prefix web-app run build
```

정적 결과는 `web-app/dist/`다. 상대 자산 URL로 `/mypaint/`에서 실행된다. Android에서는 HTTPS 배포 주소를 브라우저로 연다. 로컬 HTTP 개발 서버의 `localhost` 예외를 휴대폰 LAN 주소에 적용하지 않는다. 클립보드·복구 기능의 브라우저 권한/보안 컨텍스트 조건은 실제 기기에서 확인한다.

Windows/macOS의 해당 호스트에서 다음 명령을 실행한다.

```sh
npm --prefix web-app run desktop
npm --prefix web-app run desktop:build
```

macOS 결과는 `web-app/src-tauri/target/release/bundle/macos/myPaint Studio.app`, Windows 결과는 `target/release/bundle/nsis/`의 설치 파일이다. macOS의 빌드를 Windows 실행 검증으로 취급하지 않는다. 현재 패키지는 개발 검증용이며 서명·공증·공개 배포 승인을 완료한 릴리스가 아니다.

## 확인한 결과

[최대 문서·PNG·동작 계약 기록](STUDIO_MAX_DOCUMENT.md)과 최신 [기능별 인수표](STUDIO_ACCEPTANCE_MATRIX.md)를 기준으로 확인한다. 새 미확정 편집 배치의 [독립 근거](evidence/studio-pending-contracts.json)는 이전 성능/종료 snapshot과 구별한다.

- 이전 단계의 Strict TypeScript·Prettier·정적 빌드와 Node 166개가 통과했다. PNG/Adam7·이력/예산·candidate·원시 픽셀과 취소 계약, 동일 레이어 순열/active 계약을 포함한다.
- 종료 보호 수정 전 `/mypaint/` 번들의 기존 웹 UI 45개와 모델 native bridge의 bulk 16·pointer 7·대형 문서 17·저장/복구 12개가 통과했다. 각 검사군 page error 0이며 실제 OS 파일시험과 구분한다.
- 이전 Renderer 검사에서 필수 38개와 독립 경계 15개를 확인했고, 정보성 fractional 진단 4개는 통과 개수에 합치지 않는다. 최대 문서 core opt-in 6개도 통과했다. 최초 cache 생성·16 layer 1:1·일부 동기 작업은 여전히 성능 gate에 미달한다.
- 모바일 320·360·390px 조작부와390×844 작업 영역·두 손가락 탐색, 1024×768/DPR2 태블릿 웹 배치를 확인했다. Android/iPad 실기기 검증은 아니다.
- 이전 종료 보호 번들에서 기본 웹 10개·native 저장/복구/종료 15개를 재검증했다. Rust 16개·rustfmt·Clippy를 통과했다. 실제 macOS release `.app`의 세 실행에서 64MiB 초과 파일 복구, 4096²/32768×1 코덱·렌더러·geometry·JPEG, runtime/AppKit 종료 취소·반복 요청·승인을 확인했다. 미확정 문자·작업 중 상태와 Qt 복구 원본·lock도 보존됐다. Windows 및 실제 Cmd+Q/Dock 조작 인수는 별도다.
- 실제 512MiB APFS 격리 볼륨에서 유효 RPAINT 저장·복구의 OS ENOSPC를 확인했다. 원본 bytes/메타데이터·경로·복구 사본과 토큰 보존, 임시 파일 정리·공간 확보 후 재시도까지 통과했다. 실제 Windows·교체/디렉토리 동기화 실패·OS 선택기는 별도다.
- 이전 8968 번들에서 미확정 편집/Redo 36개·독립 clipboard payload 4개·기존 편집 13개·동시성 3개가 통과했다. Pending 중 단축키가 비활성 Redo를 우회하던 오류를 수정했고 실제 macOS 앱의 복구·코덱·종료 3단계도 재확인했다.
- 최종 화면 캐시 통합 후보에서 타일 필수 63건(정보성 4건 별도), 원본 기준 전체 Canvas 56개·저장 출력 12개, 실제 macOS의 복구·코덱·종료·렌더링 4단계를 통과했다. 일반 웹/네이티브에서 검증 전용 chunk 요청은 0회였다. 반복 그리기와 대표 dirty 비용은 줄었지만 cold와 모서리/분리 영역의 성능 인수는 남아 있다. [통합 근거](evidence/studio-scene-integration.json)를 따른다.
- 후속 도구 검사에서 지정 색 교체의 전역 변경, 도형 우클릭 색/알파 유실, 투명 입력의 hidden RGB 손실을 수정했다. 실제 Qt 기준과 공개 UI 색 교체 9개·도형/투명 붓 23개를 확인했다. 직전 도형 snapshot의 기존 103개 회귀, 최종 UI/엔진의 bulk 16·pointer 9도 통과했다. 각 snapshot의 소스/번들은 [도구·입력 근거](evidence/studio-tool-contracts.json)에서 구분한다.
- 손상된 프로젝트의 내부 PNG 크기를 디코드 전 검사해 불일치 레이어의 raw/output 할당을 차단했다. 파일 size를 한 번 캡처하고 실제 읽은 길이를 확인한다. 최종 decoder 번들의 기본 웹 10개와 실제 macOS 4단계, 기존 Qt CTest 5개 프로그램을 통과했다. macOS 렌더링 단계의 추가 3개는 JavaScriptCore 엔진 검사이며 실제 포인터 UI를 대신하지 않는다.
- 후속 입력 경계에서 마우스 보조 버튼 3/4를 포인터 등록 전에 거부했다. 현재 후보의 포인터 23개·기본 웹 10개·편집 13개, 플랫폼 제한 1개와 실제 macOS 4단계를 통과했다. [보조 버튼 근거](evidence/studio-pointer-buttons.json)에 이전 decoder 결과와 별도로 기록한다.
- GIF 첫 프레임의 위치·크기 확장도 디코딩 전에 검사하고, 긴 확장 블록을 읽을 때 시간 예산에 따라 양보·취소한다. 공개 UI 22개와 기본 웹 10개, 실제 macOS 4단계 및 그 안의 정상 GIF 3개가 통과했다. 정상 87a/89a·로컬 팔레트·인터레이스·투명·애니메이션 첫 장면을 확인했다. [GIF 근거](evidence/studio-gif-input.json)에 완료시간 증가와 전체 네이티브 메모리 미인수를 함께 기록한다.
- 실제 WK 렌더 호출과 검증용 readback/reference 비용을 분리했다. 8K×4K 두 레이어의 단색 판정을 인라인 행 인덱스·4word/tail 검사로 바꿔 같은 조건의 초기 렌더 중앙값을 345→272ms로 줄였다. 필수 타일 74개(정보성 4개 별도)·Node 166개·기본 웹 10개·실제 macOS 4단계가 통과했다. [WK 근거](evidence/studio-wk-render.json)는 135ms 표본과 교차 재검증, 미달한 50ms 목표를 보존한다.
- 활성 scene의 화면 밖 ImageData 초기화·업로드를 줄이고 Canvas geometry는 유지했다. 실제 WK 교차6회에서 초기 중앙98→84ms·요청100,499,520→44,374,848B, 필수 타일82(정보성4별도)·Node166·기본 웹10·일반 빌드 macOS4단계를 확인했다. [후속 근거](evidence/studio-viewport-tiles.json)에 실패 후보와 독립 픽셀/할당 실패 검증도 남긴다. 50ms 목표와 실기기 인수는 미완료다.
- 펜 release 필압·투명 지우개 NoOp·입력 오류의 선택/캡처 복원·spray timer 예외를 수정했다. 새 도구 UI31·포인터26·기본 웹10·동시성3·편집13·Node169·macOS4단계가 통과했다. [근거](evidence/studio-basic-tools.json)는 실제 Qt와 straight RGBA 정책, 단발 실패 주입과 물리 기기 미검증을 구분한다. 사각 도구의 Qt161개 기준 차이는 후속 Major로 남긴다.
- `.github/workflows/studio.yml`에 웹 검사와 Windows/macOS 패키징을 연결했다. 원격 CI·Windows 실행·서명/공증은 아직 확인하지 않았다.

코드/산출물 해시·실행 범위·미완료 gate는 [최신 도구·입력 근거](evidence/studio-tool-contracts.json), [이전 최종 화면 통합 근거](evidence/studio-scene-integration.json), [이전 계약 근거](evidence/studio-pending-contracts.json)와 이전 [최대 문서 검증](evidence/studio-max-document.json)에 각 snapshot별로 남긴다. 이전 단계의 [초기 앱](evidence/studio-qt-free.json), [대형 프로필](evidence/studio-native-profiles.json), [파일 저장·복구](evidence/studio-native-persistence.json) 표본은 각 당시 source hash의 기록이다. 작은 번들·자동 검사 수를 실제 모바일 입력 지연이나 전체 기능 동등성으로 해석하지 않는다.

상세 구조/권한/로컬 계약은 [아키텍처](STUDIO_ARCHITECTURE.md), 독립 검토는 [RCA 기록](STUDIO_REVIEW_AND_RCA.md)을 따른다. 웹 복구는 32개/합계 64 MiB, 설치형은 사본당 300 MiB·32개/합계 1 GiB payload이며 임시파일 비용은 별도다.

## 남은 전환 조건과 우선순위

1. **P0 데이터/기능 인수**: 레거시 fixture, PNG/Adam7, F05 실패/취소와 F01/F07 clipboard payload의 명시 범위를 확인했다. 후속 선택·문자 alpha, fill/cut 키·숨긴 활성 레이어와 자유 선택 mask·음수 이동·nearest·UI crop의 명시 조합을 수정·검증했다. 후속 source-less paste·투명 배경 Source-clear와 원본 mask의 명시 변형/연속 크기 조합도 인수했다. 임의 변형·혼합 alpha/키·사진 형식·장치 등 [남은 인수](STUDIO_ACCEPTANCE_MATRIX.md)는 계속 남는다. 현재 검사로 전체 기존 기능 동등성을 선언하지 않는다.
2. **P0 설치형 차이**: 웹 프로필은 유지하고 설치형에 레거시 대형 문서 프로필과 bounded 타일 경로를 추가했다. 경로를 기억하는 저장/OS 열기·파일 복구·Qt 읽기 전용 인계를 구현했고 macOS 파일 검증을 추가했다. 최대 부하/메모리, 실제 OS 선택기·Windows 공간 부족·교체/동기화 실패 인수를 마치기 전에는 기존 설치형을 대체하지 않는다. 브라우저 복구는 확정 revision을 저장하며 미확정 선택/문자를 보장하지 않는다.
3. **P1 성능 인수**: 최대 mip의 bounded 준비를 구현하고 같은 출력에서 짧은 callback과 늘어난 완성 시간을 함께 확인했다. 후속 선택 nearest·같은 크기 중복 재샘플·밀집 mask 비용을 측정·개선했으며 작은 대조군의 퇴행도 보존했다. 같은 DPR·camera·mip 조건의 WK checker 재비교, 넓은 dirty·장기 RSS/자원 해제·완성 시간 회귀를 우선 측정한다. 직접 동기 render와 공개 UI의 양보 경로를 구분하며 전체 50ms·p95·물리 표시 지연을 완료 처리하지 않는다. 실제 병목 없이 Wasm/GPU를 추가하지 않는다.
4. **P1 입력/플랫폼 인수**: 추가 마우스 버튼 3/4의 잘못된 편집 진입은 차단·검증했다. GIF 첫 프레임 범위·prefix 취소는 보완했으며, 애니메이션 메타데이터와 네이티브 디코더 내부 메모리는 앱 소유 버퍼 한도와 구분해 남긴다. 사용 가능한 Android에서 웹의 터치·회전·키보드·다운로드 취소/재열기·저장소 제한/복구를 우선 확인한다. Safari 웹과 Windows 설치형, 깨끗한 macOS·서명/공증·Rust 의존성 배포 고지는 별도 미완료 항목이다.
5. **출시/정리**: 새 manifest staging·홈페이지의 다른 파일 보존·되돌리기를 검증하고 출시 조건이 충족된 다음 형제 홈페이지에 결과만 반영한다. commit/push는 각 저장소에서 별도로 한다. 기존 Qt 삭제와 공개 교체는 이 조건 이후다.

상세 백로그는 [34개 전환 태스크](QT_FREE_MIGRATION_TASKS.md)다. 모바일 네이티브 포장 작업은 추가하지 않는다.


## 사각 도구 후속 구현

2026-11-05. [사각 도구 검증](evidence/studio-square-tools.json)에 따라 Qt 기준의 hard square 경계·이벤트 합성·종료 처리와 옵션 UI를 구현했다. 불필요한 hard coverage 버퍼를 제거하고 원형 동작의 타일 원본 소유권을 공유한다. 새 의존성과 모바일 native 프로젝트는 없다. 모바일/태블릿 웹 전용, Windows/macOS 설치형 범위를 유지한다.

당시 사각 도구 고정 산출물 `index-dmsxjaEy.js`는 Node176·사각 UI35·기존 도구/입력/편집 회귀를 통과했고, 동일 자산의 실제 macOS 앱에서 저장/복구·codec·종료·scene4단계를 확인했다. `test:square-contract`를 웹 CI에 추가했으며 원격 CI 실행·Windows 실행·Android 실기기는 아직 인수하지 않았다. 이전 basic-tools 결과는 당시 snapshot으로 보존한다.


## 팔레트·키보드·연필 후속 구현

2026-11-05. [후속 검증](evidence/studio-pencil-palette.json)에서 Classic98 색상표와 버튼 Enter를 수정하고 연필을 기존 hard square의1px 경로에 연결했다. 연필의 Qt 경계·이벤트별 alpha·옵션 무시를 복원하면서 엔진과 파일 형식은 유지했다. 옵션 비활성화·1px 표시·원형 설정 복원도 함께 확인했다.

최종 source17/asset8의 UI41·사각35·웹13·동시성3·편집13·레이아웃4 및 실제 macOS4단계가 통과했다. 이전 코어176개는 동일 엔진의 과거 실행 근거로 보존하며 새 실행으로 세지 않는다. 당시 다음 작업으로 남긴 mip 준비는 아래 후속 구현을 따른다. 미완료 도구·실기기·배포 인수는 계속 남아 있다.


## 최대 mip의 bounded 준비 후속 구현

2026-11-05. [통합 근거](evidence/studio-bounded-mip.json)의 UI4 구현을 제품에 반영했다. 같은 타일 cursor를 동기 draw와 준비 경로가 공유하고, 축소 계산은 최대 65,536개 source-pixel 진행 단위와 soft 4ms 예산으로 나눈다. MessageChannel task로 이어서 처리하며 이미 예약된 앱 rAF가 있으면 합류한다. Canvas save/clip과 scene target을 task 사이에 유지하지 않고 모든 가시 raster가 준비된 뒤 완성 프레임만 공개한다. 직접 `render()`는 기존 동기 동작을 유지한다.

취소·새 dirty·문서 교체·할당 실패·context loss에서 cursor/port/scratch를 정리한다. 렌더 준비는 원본·이력을 변경하지 않으며, backing 크기가 같은 준비 단계에서는 이전 화면을 유지한다. 실제 그리기 도중 실패하면 Canvas를 초기화하고, context loss에서는 준비 완료 상태를 해제한 뒤 복구 후 다시 그린다. 준비 타일과 scratch도 기존 합계 64타일·128MiB 추정 RGBA·최대 512축 한도에 포함한다. 단순 도구·스킨 변경은 픽셀 전체 invalidation을 만들지 않아 warm cache를 유지한다. 엔진·프로젝트 형식·Rust·의존성은 바꾸지 않았다.

필수 타일 109개와 별도 정보성 4개, Node 176개, 기존 웹 48개, 준비 UI 8개, 장면 Canvas 56개·문서 12개 및 계측 overlay 없는 일반 macOS 앱의 4단계가 통과했다. Chrome 패턴별 n3에서 uniform 완성 시간 중앙값은 186.6→219.6ms, checker는 361.8→404.0ms로 늘었다. 반면 관측된 최대 callback은 전 173.1~364.2ms에서 후 5.0~9.6ms로 줄었다. 실제 WK uniform n1도 첫 동기 반환 245→5ms·완성 246→312ms·최대 timer gap 246→9ms였으며, WK checker는 DPR/mip 조건이 달라 비교에서 제외했다. 이 결과는 응답성 개선이며 총 처리시간 개선이나 전역 50ms·p95·성능 인수 완료가 아니다. 모바일·태블릿은 웹, 실행파일은 Windows/macOS만 유지한다.


## 선택·문자 alpha 계약의 후속 구현

2026-11-05. [통합 근거](evidence/studio-alpha-contracts.json)에 따라 선택과 문자에 한정한 alpha 손실을 수정했다. 투명 선택은 RGB만 비교하던 경로를 alpha 포함 premultiplied 키 판정으로 바꿨다. alpha가 다른 white128/255를 보존하고 alpha1에서 premul 값이 같은 색은 키로 처리하되 저장된 straight RGB는 재양자화하지 않는다. 선택 버퍼의 hidden RGB 보존과 PNG 합성 출력의 alpha0 RGB=0은 별도 계약이다.

문자 preview와 raster의 RGB hex 네 곳을 인라인 RGBA로 바꿨다. alpha0/1/128 잉크와 보조색 배경을 그대로 사용하며, brush opacity를 곱하거나 HEX/type=color 규칙을 바꾸지 않았다. 엔진·tiles·파일 형식·Rust·런타임 import는 그대로이고 함수 추가는 없다. `test:alpha-contract`는 선택/문자 두 검사를 순차 실행하며 웹 CI에 연결했다.

선택은 실제 Qt 4개와 수정 전 UI 4개 중 3실패→수정 후 4개 통과, 문자는 수정 전 UI 8개 중 7실패→수정 후 8개 통과를 확인했다. 별도 Qt 문자 6case·84check·완전 coverage 3,680픽셀은 알파 기준이며 OS 간 glyph geometry 동등성은 아니다. 실제 WK의 별도 alpha 10개(문자6/선택4)와 overlay 없는 일반 macOS 앱4단계, 기존 웹48·pending36·clipboard4도 통과했다. 일반 앱과 임시 alphaProbe는 서로 다른 실행 표본이다. Node176은 같은 엔진의 이전 실행 근거이고 이번에 다시 실행한 수가 아니다. UI4의 기존 성능 수치도 새 측정으로 세지 않는다. 남은 F06/17도구·OS IME·실기기·최종 성능과 스포이트 alpha 표시 UX는 계속 미완료다.


## 채우기 실패와 작업 setup의 소유권 후속 검증

2026-11-05. [통합 근거](evidence/studio-fill-failure.json)의 수정은 `main.task` 한 메서드에 한정한다. 실제 결함은 overlay를 붙이는 setup에서 throw가 나면 `try/finally`에 들어가지 못해 busy·inert가 남는 것이었다. 수정 전 공개 UI에서 overlay는 없지만 조작부 세 곳이 inert인 상태를 재현했다. DOM과 이전 제어 상태는 변경 전에 준비하고, busy/abort 설정 뒤 inert/readOnly/append/work를 `try/finally` 안에 넣었다. 취소 버튼은 해당 작업의 local controller를 캡처한다. 함수 추가나 엔진·Codec·Rust·형식·fill 키/색 정책 변경은 없다.

새 공개 UI 10개는 setup과 Worker constructor/postMessage·오류 이벤트/응답·profile/pixels/coordinates·hold 취소·timeout을 각 두 번 거친 뒤 정상 fill과 Undo/Redo를 검증했다. Worker 9경계는 기존 코드의 원본·상태/Redo·자원 정리가 안전함을 확인한 것이며 새 결함 9개를 고쳤다는 뜻이 아니다. timeout은 단축하지 않은 실제 20초를 두 번 기다렸고, setup의 단발 append 예외는 OOM 실증이 아니다. 제거된 이전 취소 버튼의 합성 DOM 재생도 확인했으나 물리 경합 입력 시험은 아니다.

기존 웹 48개·pending 36개와 표준 `desktop:build`의 일반 macOS 앱 4단계가 통과했다. 이전 일반 앱은 별도 보존했고, Node 176개와 UI4 성능은 이전 근거로 남긴다. `test:fill-failure`를 웹 CI에 연결했다. 이 단계 당시 fill premul/cut flag는 가설로 남겼으며 아래 후속 절에서 명시 범위를 수정·인수했다. 전체 F10·실기기·최종 성능과 fixed-DPR WK checker·넓은 dirty/장기 RSS·남은 F06은 유지한다.


## 채우기·잘라내기 계약과 버퍼 최적화

2026-11-05. [채우기·잘라내기 근거](evidence/studio-fill-cut-key.json)의 최종 source17·asset8을 기준으로 세 Major를 수정했다. 채우기의 raw RGBA 비교를 Qt의 alpha+premul 키와 NoOp로 맞췄다. 선택 없는 cut은 투명 선택 옵션이 켜졌을 때만 소유한 활성 레이어 복제본에 키를 적용한다. 숨긴 활성 레이어의 cut PNG가 비어 있던 문제는 PNG용 wrapper만 `visible:true`로 만들어 고쳤다. 문서 표시 상태·원본 straight/hidden RGB·클립보드 실패·Redo·한 번 Undo를 유지한다. 두 소유 함수 안에 순차 작성했으며 새 helper·의존성·API·형식 변경은 없다.

최종 후보에서 Node188, 공개 채우기6·cut5·실패10종류×두 번, 실제 WK Worker6과 일반 macOS 앱4단계(scene21)를 통과했다. 실제 production20초 timeout 두 번도 원본·Redo와 정상 retry를 보존했다. 기존 웹48·pending36·clipboard4는 메모리 최적화 전 v2에서 실행한 결과이며 새 v3 실행으로 합산하지 않는다. Qt fill6/45check와 cut5는 legacy 의미의 독립 기준이고, Qt의 RGB 양자화를 새 저장 RGB에 강제하지 않는다. 정적 source 런타임 순환과 emitted 정적 평가 순환은0, 동적 load SCC2는 별도다.

채우기에서 전체 원본 복사본을 제거하고 방문 span으로 결과 bbox를 재구성했다. 변경 fill의 명시 버퍼 순감소는 `4*N−4B`이며 전체 RSS는 아니다. 같은 Node core 표본1024²에서 full 중앙34.51→16.59ms·32² island0.265→0.093ms였지만 thin ring은0.638→0.844ms, 512² ring은0.239→1.214ms로 느려졌다. 각 측 네 번·총64개 교차 표본의 bbox/전체 출력/원본이 같았다. 메모리 감소와 full/island 이득을 채택하면서 이 퇴행을 유지·기록한다. 전체 UI 지연·장기 RSS·물리 기기의 성능 완료는 아니다.

이 fill/cut 배치 당시의 다음 F06 mask·음수 이동·resize 결합은 아래 후속 절의 명시 범위로 갱신했다. 대형 cut 키 스캔/최악 fill·장기 메모리, 같은 DPR의 WK checker·넓고 분리된 dirty, Android 웹·Safari·Windows/OS 통합과 출시 인수는 유지한다. 모바일·태블릿 웹 전용, 설치형 Windows/macOS 전용을 유지한다. 커밋·푸시·홈페이지 배포는 수행하지 않았다.


## 자유 선택·nearest·음수 자르기 후속 인수

2026-11-05. [현재 근거](evidence/studio-selection-mask.json)의 source17·asset8에서 세 Major를 수정했다. 자유 선택의 Canvas AA 임계값이 Qt aliased clip과 다른 픽셀을 선택했다. 입력을 정수 floor하고 연속 중복점을 줄이며, bbox는 소유 함수에서 순회한다. 실제 픽셀 알고리즘 `polygonMask`만 기존 엔진에 두고 UI의 미리보기·원본 지우기에 같은1B mask를 연결했다. nearest의 정확한 중간 경계는 Qt FastTransformation의 낮은 원본 인덱스로 맞췄다. UI 음수 crop은 pending 문서와 교차하고 빈 교차는 NoOp로 남기며, 공용 cropState의 패딩 API는 유지한다.

독립 Qt public Canvas13/160check, 실제 mask871개와 축1~32의1024쌍을 기준으로 검증했다. 최종 Node192·새 CI 진입의 공개 선택8/자르기4/실패6, 기존 웹48/pending36/clipboard4가 통과했다. 실제 WK의871 mask·nearest1024쌍(가로/세로2048check)·geometry Worker4는 임시 진단 앱이며, 오버레이 없는 일반 macOS 앱4단계(scene21)와 구분한다. 저장 취소·clipboard 거절·mask 할당 실패·Worker/profile/한도 오류 뒤 원본/Redo·첫 재시도·단일 UndoRedo도 명시 범위로 확인했다.

선택 pixels+mask의 명시 저장 공간은8*S→5*S+O(path/edge)다. 동일 출력의 순수 mask 커널64개 표본에서1024²의 도형별 중앙31.3~58.65→0.2~0.9ms와 mask4→1MiB·누적 readback 반환4→0MiB를 관측했다. 512² 사각은7.4~779ms의 큰 분산이 있고0ms 표본은 타이머 해상도 이하다. 전체 UI/물리 지연·WK 성능·최고 메모리/RSS·안정 배수를 뜻하지 않는다. 실제 UI 선택은8개이며871개 UI/실기기 검사로 합산하지 않는다.

리뷰가 반환한 큰 외부 edge·음수 원점의 양자화 오차도 수정했다. Qt 자체가 full-mask slice와 다른 파생 viewport8개는 잘못된 불변성 가정 대신 실제108개 viewport oracle로 인수했다. 이 단계에서 남긴 paste/source 없음·단일 투명 배경 Source-clear는 아래 후속 검증의 명시 범위로 갱신한다. 남은 F06의 원본 mask를 가진 회전/flip/resize 조합, 비퇴화 거대 경로의 동기 CPU/장기 RSS, fixed-DPR WK·실기기/OS·출시 gate를 유지한다. 모바일/태블릿 웹만, 패키지 Windows/macOS만이며 커밋·푸시·배포는 수행하지 않았다.


## 선택 원본 지우기와 붙여넣기 변환의 후속 검증

2026-11-05. [고정 근거](evidence/studio-selection-source.json)에서 단일 레이어의 투명 배경 `[37,59,61,0]`을 선택 삭제·cut·이동할 때 숨은 RGB가 0으로 바뀌던 Major를 수정했다. 이미 배경과 같은 영역도 가짜 편집으로 기록해 기존 Redo를 잃었다. binary mask에 남아 있던 coverage 합성식을 없애고 `clearSelectionSource` 안에서 원본 mask/stride로 대상 RGBA를 직접 대입한다. 원본이 없는 paste는 그대로 반환하며 원형 지우개 coverage 정책은 별개다. 작은 helper·API·의존성·엔진/형식/Rust 변경은 없다.

수정 전 공개 UI 7개는 모두 계약 차이를 재현했고 수정 후 모두 통과했다. 사각/자유 선택의 삭제·cut·음수 이동과 이미 배경인 삭제의 NoOp/Redo를 확인했다. 별도 source-less PNG paste의 변환 순서·오류 후 재시도·취소·한 번 UndoRedo 4개는 수정 전부터 안전했던 동작이다. 두 검사를 `test:selection-source`로 CI에 연결했다. 최종 Node192, 기존 선택18·웹48·pending36·clipboard4, 실제 WK 원본 처리 진단6 및 오버레이 없는 일반 macOS 앱4단계(scene21)를 확인했다. WK6은 임시 진단이며 실제 OS clipboard/picker·물리 입력 인수는 아니다.

실제 수정 전/후 메서드를 추출한 Node96 표본에서 동일 출력·원본·mask를 확인했다. 1024 source/1008² 처리 영역의 no-mask 중앙값은 opaque11.16→4.56ms, half11.30→4.52ms, zero6.76→4.45ms였다. 의미가 달라진 nonzero-RGB/alpha0 배경은 같은 출력 성능 비교에서 제외했다. 각 측4회·순수 메서드 검사이며 JIT/outlier를 보존한다. UI·caller clone/이력·WK·RSS·p95·물리 펜 성능의 인수 근거로 확대하지 않는다.

이 단계의 다음 항목이었던 원본 mask 변형 순서·음수 copy/cut/crop·취소는 아래 후속 검증의 명시 범위로 갱신한다. 비퇴화 거대 path CPU·장기 RSS, 동일 DPR WK checker·분리된 dirty, Android 웹/Safari·Windows/실제 OS 통합·출시 gate는 계속 남아 있다. 모바일/태블릿은 웹 전용, 패키지는 Windows/macOS 전용이며 커밋·푸시·공개 배포는 수행하지 않았다.


## 선택 크기 조절 기준 버퍼와 변형 조합 후속 구현

2026-11-05. [고정 근거](evidence/studio-masked-transform.json)에서 별도 크기 조절 두 번이 직전 표시 결과를 재샘플해 픽셀을 잃던 Major/M을 수정했다. 사각3×2→2×3→3×2에서 원래 라벨0/1/2/3/4/5가0/0/2/3/3/5로 바뀌고 새 이력·dirty와 기존 Redo 손실이 생겼다. 실제 Qt public Canvas12개/104검증과 별도 공개 UI 재현을 대조했다. generic nearest 알고리즘이나 원본 mask stride의 문제가 아니다.

선택은 nearest 크기 조절의 기준 Raster를 참조로 유지한다. 드래그 전체에서 시작 시점의 기준을 고정하며 원래 크기 경유·제스처 시작 크기 복귀·포인터 취소에서 current/base/modified를 함께 다룬다. 비동기 크기 변경은 소유한 기준 복제본만 Worker에 넘기고 stale/한도 검사 뒤 게시한다. 회전/반전/기울기 성공은 현재 표시 payload를 굳혀 다음 기준으로 삼는다. 명시적 변형은 기존 modified=true 정책을 유지하고 초기 NoOp 비교 참조 originalPixels만 해제한다. 원본문서·sourceRect/sourceMask를 지우는 동작이 아니다. 소유 메서드4개와 optional Raster 필드2개만 변경했으며 작은 helper·의존성·엔진/형식/Rust 변경은 없다.

새 `test:masked-transform`의 공개9개, 기존 선택8·자르기10·실패6·Source-clear7·paste4, 웹48/pending36/clipboard4 및 Node192가 통과했다. 자르기10은 기존4+변형 순서/음수/확장/완전 밖 취소6이며 연속 크기 조절 검사를 대신하지 않는다. 신규9는 두 제스처·pointercancel·원래 크기 경유·표시 payload bake·profile 실패/첫 재시도·triangle/hole mask·실제 cut PNG·투명 키 ON 명시 크기 왕복 뒤 Arrow/Enter를 확인했다. 모델 native IPC/clipboard와 합성 pointercancel은 실제 OS/물리 장치 검사와 구분한다.

실제 WK 임시 진단4개는 기준 픽셀 왕복·회전 후 기준 교체·명시 키 변형·원본 mask 보존을 실제 메서드/Worker로 확인했다. 오버레이 없는 최종 일반 macOS 앱4단계(scene21)는 별도다. WK3×2의 선택 필드 unique buffer는24→48→24B였고 회전 후6×4는24+96=120B였다. descriptor 생성 시 pixel 복사는 없지만 backing4*B와 current4*R이 별개로 남을 수 있고 Worker는 backing을 복제한다. 이 수치는 전체 live/peak/RSS·Canvas/cache·입력 지연이나 성능 향상 근거가 아니다. 원래 크기 비동기 복귀도 Worker 할당/계산이 끝난 뒤 참조를 재사용한다.

전체 F06/17도구·혼합 알파/키/장치 순열, 거대 비퇴화 path·대형 handle의 동기 CPU·장기 RSS, 동일 DPR WK/분리된 dirty, Android 웹·Safari·Windows/실제 OS·출시 인수는 남아 있다. 모바일/태블릿 웹 전용·패키지 Windows/macOS 전용이며 커밋·푸시·배포는 수행하지 않았다.


## 선택 연산·같은 크기 입력·밀집 마스크 성능 후속 구현

2026-11-05. [고정 근거](evidence/studio-selection-performance.json)는 세 동기 비용을 분리해 수정한 기록이다. nearest는 출력 픽셀마다 subarray/set을 호출해 배열 뷰를 만들고 X/Y를 다시 계산했다. 인라인 X 표와 행 Y, 정렬된 source의 명시 offset/length Uint32 복사·비정렬4채널 복사로 바꿨다. 같은 RGBA 바이트를 복사하며 Qt ceil(center)-1·alpha0 hiddenRGB·레이어 metadata·smooth/패딩 계약을 유지한다.

핸들은 요청 크기가 current와 같아도 제스처 시작 크기가 아니면 다시 샘플링했고 release에서도 반복했다. 실제 웹 trace에서3Mi 픽셀 출력을5회 만들었다. 크기가 달라질 때만 재샘플하며 검증 두 단계·drag.last·draw·시작 크기 복귀·base/modified·Up/cancel은 유지한다. mask는 dense even 행(active>=64, active>=width/2)에서 같은 정수 열의 교차점을 XOR로 묶는다. width sentinel·매행 초기화·공통 edge advance/retire를 유지하고 sparse/odd 행은 기존 sort/pair다. 점을 버리거나 다른 viewport로 나누지 않는다. 기존 세 소유 함수만 바꿨고 helper·API·의존성·형식/Rust 변경은 없다.

고정512×384 선택→2048×1536 한 번 변경·같은 정수 크기 subpixel3회·release를 같은 ordinary-web Chromium/M1 Pro Metal 관측 조건에서 버전별1회 실행했다. 원본·복사한 전체 raw·Canvas1072×910·기하·fixture가 모두 같았다.

| 관측 | 기준 | word만 | 최종 |
| --- | ---: | ---: | ---: |
| 동기 pointer callback 합계(ms) | 675.2 | 49.9 | 20.2 |
| rAF 호출 합계(ms) | 100.6 | 102.2 | 29.3 |
| 측정 시퀀스 완료(ms) | 827.0 | 187.1 | 112.7 |
| 대형 출력 생성 요청 | 5 | 5 | 1 |
| 관측 업로드 호출 | 30 | 30 | 6 |
| 10ms sentinel 최대 간격(ms) | 180.1 | 50.5 | 59.8 |

각 조건n1이며 계측 비용·queue/frame 대기를 포함한다. putImageData CPU는 rAF 안에 중첩되므로 더하지 않는다. 최종 첫 callback19.0ms/rAF27.4ms는 word의15.7ms/22.4ms보다 컸다. LongTask는 기준5개·최종0개였지만 sentinel59.8ms는 word보다 나빠 전체50ms·p95·물리 펜/WK/Android/RSS 목표 완료가 아니다.

별도 Node nearest의0.75/3/12Mi 출력 중앙값은37.798/125.375/563.148→26.919/17.011/24.112ms였다. 각 측4회·warm2,0.75Mi 후속2.444~34.194ms의 큰 분산과1×1 API0.0278→0.0378ms 퇴행을 보존한다. 최종 nearest 본문은 측정한 word 후보와 동일하다. mask는 같은1Mi 입력의 별도 AB/BA40표본에서 active512 중앙24.523→14.585ms, active2048 98.997→23.775ms였다. degenerate0.036→0.401·monotone0.258→0.575·active1287.433→7.632ms도 함께 기록하며 전역 무퇴행/안정 배수를 주장하지 않는다.

정확성은 기존 Qt871(sparse 경로)과 신규 실제 Qt12를 분리했다. 신규11개·110행이 bucket을 통과하고30행은 fallback/전환이다. 독립 행 모델62,076개는 실제 Qt/UI 사례 수가 아니다. 최대폭32768·16384edge에서32769B workspace1회, allocation 실패 뒤 입력/첫 재시도, offset/odd tail·alpha·다층·desktop tie를 포함해 Node198이 통과했다. 공개 masked10/68stage·기존 선택8/crop10/실패6/Source7/paste4·웹48/pending36/clipboard4, 기존 native CTest5도 통과했다. 새 반복 회귀는 guard 없는 word에서[1,1,1,1,1]→최종[1,0,0,0,0]을 확인한다. baseline의 같은 stage는 할당 단언 뒤 PNG 비교가 실행되지 않아 최종 raw/PNG 검증과 구분한다.

실제 WK 임시 진단4개는 denseQt12·최대폭·6offset×3layer·직접 Studio pointer/이력을 확인했다. 표준 일반 macOS 앱4단계(scene21)는 별도이며 기본 앱을 표준 빌드로 복원했다. 새 X 표4*W(최대128KiB)·dense 열 표W+1(최대32769B)은 명시 추가 버퍼다. 뷰 객체 제거는 원본 backing 감소와 다르다. trace의 대형 출력62,914,560→12,582,912B도 누적 요청량이며 peak/live/RSS가 아니다.

새 큰 target과 큰 path의 계산은 여전히 동기다. 더 큰 비퇴화 경로·전체 경로 preview·취소 응답성·최대32Mi 출력/장기 RSS, 같은 DPR WK checker·분리 dirty, 실제 Android 웹/Safari/Windows·OS/IME·출시 인수는 남아 있다. 모바일/태블릿은 웹만, 패키지는 Windows/macOS만이며 커밋·푸시·공개 배포는 수행하지 않았다.


## 큰 올가미 선택의 취소 가능한 준비 작업

2026-11-05. [실행·리뷰 근거](evidence/studio-selection-preparation.json). 위 선택 성능 후속 단계에서 남긴 큰 path의 동기 종료 경로를 변경했다. 실제 공개 UI의 32,768점/1024² 문서에서 bbox는 1023×1021이었다. 동일 계측 기준 pointerup 188.6ms와 타이머 최대 간격 211.9ms를 재현했다. bbox·픽셀 복사·mask·보조색 처리가 한 작업 안에서 끝날 때까지 취소 이벤트가 실행되지 않는 것이 원인이다. 초기 별도 프로토콜의 206.6ms와 섞지 않는다.

작은 `makeSelection`과 `pointerUp`은 즉시 끝나는 void API를 유지한다. 8,192점 이상 또는 작은 path의 ROI 262,144픽셀 이상에서 `prepareSelection`이 기존 busy/취소 UI와 Worker 수명 관리를 소유한다. 이 값은 dispatch 정책이며 모든 50ms 작업을 보장하는 수치가 아니다. 전체 점을 Float64에 복사하며 bbox/packing은 4,096점, ROI 복사는 최대 65,536픽셀, 반환 마스크 검사는 65,536바이트마다 작업 큐에 제어를 돌려준다. 점 생략·독립 viewport clipping은 하지 않는다. 원본 레이어가 아니라 소유한 ROI와 packed path만 transfer한다. Worker는 원래 global origin으로 polygonMask를 한 번 계산한다.

sync/Worker가 실제로 공유하는 `applySelectionMask`를 기존 engine 모듈에 둔다. alpha/key 처리 순서·premultiplied membership·숨은 RGB·sourceMask stride·originalPixels alias를 유지한다. 단순 문장은 소유 함수에 남기고, 채널 대기 closure는 abort 시 대기 Promise를 끝내는 자원 소유 경계로 한정한다. 새 모듈이나 전역 scheduler는 만들지 않았다.

job marker는 준비 중인 미확정 작업과 unload 경고를 유지한다. task가 시작되기 전 DOM 준비 실패까지 바깥 finally가 정리하고, 채널 설정도 포트 finally 안에서 수행한다. Esc/취소/blur/hidden은 해당 controller와 대기 Promise를 취소한다. 동일 job·문서/epoch/revision·active·원본 크기/픽셀 소유자·선택·도구·보조색/투명 정책이 유지될 때만 결과를 설치한다. 잘못된 응답·timeout·취소·늦은 결과는 문서와 이력을 바꾸지 않는다. 포인터 종료는 run(false) 비동기 경계로 넘겨 chorded release의 Promise 유실과 다른 제스처의 전역 취소를 피한다.

| 동일 입력, 조건별 1회 | 기준 | 후보 |
| --- | ---: | ---: |
| pointerup callback | 188.6ms | 1.3ms |
| 새 화면 준비 | 210.5ms | 239.7ms |
| 10ms 타이머 최대 간격 | 211.9ms | 24.3ms |
| 이동한 선택의 별도 preview RAF | 54.1ms | 53.9ms |

응답성은 개선됐지만 완료 시간은 29.2ms 늘었다. 전체 raw 선택·최초/이동/취소 Canvas·원본은 동일했다. 후보 중간 old-ready는 busy 상태라 제외하고 Worker 종료 뒤 최종 ready만 인수했다. 입력을 한 번에 넣는 자동화의 104–106ms와 이를 포함하는 LongTask 431/246ms는 mask 시간으로 해석하거나 더하지 않는다. MessagePort resolver 계측은 이어지는 async microtask 작업을 포함하지 않으므로 0ms가 slice CPU 0ms를 뜻하지 않는다. 물리 취소 지연·p95·전역 50ms·성능 무퇴행은 인증하지 않는다.

논리 typed plane 합계는 원본+ROI+mask+열 표 9,417,743B에 packed path 524,288B가 추가되어 9,942,031B다. 실제 transfer는 ROI 4,177,932B와 path 524,288B가 detach되고, 같은 ROI 픽셀과 mask 1,044,483B가 돌아왔다. 이 수치는 RSS/peak/물리 복사 수가 아니다. 원래 JS path의 closure 참조, Worker의 JS point/edge 재구성, Canvas/GPU는 별도다. `path=[]`만으로 원래 배열의 즉시 해제를 보장하지 않는다.

Node 208(새 10)·공개 큰 선택 13·기존 웹 48/선택 24/source·paste 11/masked 10·68stage/pending 36/clipboard 4 및 선택 alpha4·text alpha8이 통과했다. 기존 Qt883 literal mask에 실제 alpha1 보조색 일치/비일치 palette를 넣고 삭제가 실제 발생했음을 단언한다. 새 공개 기대값은 제품 mask/PNG decoder를 재사용하지 않는다. localX+localY<60 수식을 실제 Qt6.12 단일/2,731회 반복 두 경로로 확인(각 1,830픽셀·0불일치)하고 PNG는 Node zlib/CRC로 읽는다. raw hiddenRGB 보존과 PNG alpha0 정규화는 분리한다. 취소 직후와 늦은 응답 뒤 beforeunload가 차단되지 않아 pending 선택 부활도 검사한다. task/channel setup 실패·11종 소유권 변경은 실제 메서드/handler를 실행하되 UI·scheduler·delivery를 모델링한 단위 근거이며 공개 UI race로 세지 않는다.

실제 macOS 표준 앱4단계(scene21)와 별도 임시 WK4개(전체 path/key/alpha, desktop 최대 폭32768, channel 대기 취소, Worker 취소/late delivery)가 통과했다. 기본 앱은 표준 제품 빌드로 복원했고 SHA로 대조했다. 임시 진단을 공개 네이티브 제스처/물리 입력/OS clipboard/성능 인수로 부르지 않는다. Rust와 legacy C++는 이번 단계에서 바꾸지 않았다.

소스17·산출물8을 대조했고 runtime 관계는 같다. 새 모듈0, 관계34 중 Worker→codec DTO type-only가 하나 추가됐다. source runtime cycle0, emitted static cycle0이며 type-inclusive SCC2와 dynamic-load SCC2를 분리했다. 타입은 emit에서 제거된다. Architect/Implementation/Reviewer/SRE가 설계·구현·실패 정리·기대값 보강·최종 검증을 교차 확인했다. npm/CI 회귀 경로를 추가했지만 원격 CI 실행·커밋·푸시·공개 배포는 하지 않았다.

다음 우선순위는 P1 이동 선택 preview 약54ms/18업로드의 원인 분리, 전체 path preview, 최대 resize의 동기 비용이다. P2는 packing/Worker 시작/threshold와 장기 메모리다. 새 공개13은 seeded oldRedo/취소 직후 첫 큰 재시도를 직접 포함하지 않으며 generic pending/Redo36과 구분한다. 실제 Android 웹·Safari·Windows·OS/IME·서명/출시는 남아 있다. 모바일/태블릿은 웹만, 실행 패키지는 Windows/macOS만 지원한다.


## 선택 이동 첫 화면의 CPU 비용 개선

2026-11-05. [측정·RCA·구현·독립 검증](evidence/studio-selection-preview.json). 이전 단계의 약54ms 관측을 새 고정 프로토콜에서 분리했다. 같은1024² 문서/32,768점/실제ROI1023×1021의 첫 Arrow는 RAF58.1ms·18업로드였고, 이후 세 번은3.8–4.1ms·업로드0이었다. 원본을 지운 cut 래스터를 처음 만드는 비용과 이미 재사용하는 이동을 구분했다. 공개 Canvas API 벽시간 합은3.6ms, 별도 CDP 샘플에서 transform이66개·가중49.911ms였으며 stack/실제번들이 원본 bbox/mask/set 콜백임을 확인했다. 차액을 정확한 callback CPU 또는 set 자체 시간이라고 부르지 않는다.

변경은 `render`의 기존 cut transform 한 곳뿐이다. 원래 source rect와 현재 row/col의 교집합만 순회하고, 선택 픽셀마다 plain-array `set`을 호출하던 부분을 RGBA4채널 직접 대입으로 바꿨다. ceil 시작/종료는 정수 인덱스의 기존 범위 판정과 같으며 오른쪽/아래는 exclusive다. mask stride는 resized payload 폭이 아닌 원본 source.width다. key로 투명해진 payload라도 기하 mask가 있으면 원본을 지우고, 단층 background 전체RGBA/다층 투명RGBA의 Source 의미와 숨은RGB를 유지한다. cache owner·key·합성순서·hidden active·mip/halo·scene·actual source clear·Worker·문서/이력은 바꾸지 않았다. 새 모듈·헬퍼·의존성·production TODO는 없다.

22,400개 guarded 전체 backing 비교에서 direct4/word 두 인라인 prototype이 원래 콜백과 일치했다. Node1Mi row-callback(warm2·timed4)의 full-mask 중앙값은21.244→direct5.814/word3.145ms, sparse9.793→3.349/2.685ms였다. unmasked는word0.630ms가direct4.819ms보다 빨랐지만 smallROI는direct0.244ms/word0.789ms였다. direct4는 색 packing/endianness/unaligned fallback·행당 packed backing을 추가하지 않아 선택했다. 이 보조 고정순서 microbench는 공개 UI나 모든 패턴의 우월성을 뜻하지 않는다.

| 동일 ordinary-web 입력, 조건별1회 | 기준 | 후보 |
| --- | ---: | ---: |
| 첫 modified RAF | 58.1ms | 15.7ms |
| 입력부터 새 화면 준비 | 74.0ms | 31.3ms |
| 10ms sentinel 최대 간격 | 75.1ms | 32.2ms |
| warm Arrow3 RAF | 3.9/3.8/4.1ms | 4.0/3.9/3.9ms |
| 첫 업로드 요청 | 18회/8,437,836B | 18회/8,437,836B |

주측정 첫 LongTask59ms는 후보에서 관측되지 않았지만 전역50ms/p95/무퇴행 완료가 아니다. 별도 profiler RAF58.8→15.8ms, transform leaf66→13/가중49.911→9.344ms는 샘플 근거이며 set 자체나 bbox 단독 효과를 분리하지 못한다. 샘플 주기요청500µs/실제 delta중앙755µs, API wrapper/clock 해상도·graphics flush·queue 비용을 보존한다. profiler 시작이 포함된 완료 시간은 주표에서 제외한다.

새 ImageData18개8,437,836B와 새 surface18개의 명목RGBA 추정량도 양쪽이 같다. CPU 개선이며 업로드/large backing/RSS 절감이 아니다. 원래 owner가 남을 수 있으므로18업로드를 전체 cache18개로 세지 않는다. 주표 physical scale1·관측scene capture0이며 다른 scene/mip 비용은 별도다. warm/짧은drag 업로드0은 양쪽 공통이고, Esc의9업로드도 이번에 바꾸지 않았다.

Node211(새3) 중 실제 callback의22,400조합은 literal d320 loop와 전체guard/source/mask/payload 불변을 비교한다. 별도 literal mask와 alpha0/1/128/255·리사이즈 뒤 원본stride·최대32768 addressing도 확인한다. 22,400은 공개UI/Qt 사례 수가 아니다. actual frozen d320 main+renderer의 DPR1/2 Canvas56프레임·문서12·실패재시도2를 후보와 비교해 모두 byte-equal이었다. 최신 main으로 만드는 renderer-only reference가 변경 의미를 같이 실행하는 공백을 피했다. Software SwiftShader 정확성이며 성능표의 Metal 관측과 구분한다. cooperative timing에 따라 렌더 counter는 달라질 수 있어56개의 모든 할당/업로드가 같다는 주장은 하지 않는다.

기존 웹48/렌더준비8/큰선택13/선택alpha4·text8/선택24/source·paste11/masked10·68stage/pending36/clipboard4, 총9개 npm 회귀 묶음이 통과했다. 실제 macOS 표준앱4단계(scene21)도 통과했고 테스트한 앱을 별도로 고정했다. Rust와 legacy C++는 바꾸지 않았으므로 이전 CTest5를 새 실행으로 세지 않는다. CI는 기존 unit glob에 자동 연결되지만 원격 CI를 실행하지 않았다. Architect·Implementation·Reviewer·SRE가 설계/샘플링/후보/AST·픽셀 검증을 독립 확인했다. 소스17/산출물8 exact, AST는 nested transform만 변경이고 관계34/source runtime cycle0·emitted static0/type-inclusive2·dynamic-load2는 같다.

다음 P1은 전체 lasso path preview와 최대 resize 동기 비용의 실제 측정이다. P2는 payload-only resize의 cutOwner 재생성·scene 활성 이동 시 source clear, Worker startup/packed path16P·장기메모리다. 실제 Android 웹·Safari·Windows·OS/IME·서명/출시와 전체 성능 인수는 남아 있다. 모바일/태블릿은 웹 전용, 패키지는 Windows/macOS만이다. 커밋·푸시·공개 배포를 수행하지 않았다.


## 대형 nearest 크기 변경 — 2026-11-06

[측정·구현·독립 검증 근거](evidence/studio-nearest-resize.json). 데스크톱 한도인 32Mi 픽셀 출력에서 선택 핸들 이동이 약 70ms 동안 동기 처리되는 것을 확인했다. `resizeState`의 nearest 분기만 변경했다. 같은 폭은 원본 행을 복사하고, 같은 원본 행이 반복되면 완성된 직전 출력 행을 복사한다. 정렬된 원본의 정확히 2배 가로 확대에서는 원본 word 하나를 두 출력 word에 쓴다. 순차 처리는 기존 함수 안에 두었으며 새 헬퍼·모듈·의존성은 없다.

Qt의 경계 tie 계산과 기존 X 좌표 표, 정렬되지 않은 원본의 4채널 처리, 레이어마다 독립적인 출력 버퍼를 유지한다. 투명 픽셀의 hidden RGB와 sourceMask stride, 메타데이터, smooth·캔버스 패딩, 원본 복귀·NoOp·취소·Redo 정책을 바꾸지 않았다. 출력 실패는 후보만 폐기하며 원본을 수정하지 않는다.

| 실제 Chromium UI 관측 | 이전 | 후보 | 범위 |
| --- | ---: | ---: | --- |
| 가로 4096→8192 첫 콜백 | 72.4ms | 56.2ms | 각 1회 |
| 세로 4096→8192 첫 콜백 | 73.2ms | 24.4ms | 각 1회 |
| 가로 4096→8191 첫 콜백 중앙값 | 68.4ms | 68.7ms | 각 3회 |
| 가로 2배 앱 ready | 811.8ms | 758.3ms | 각 1회 |
| 세로 2배 앱 ready | 682.3ms | 700.9ms | 각 1회, 퇴행 보존 |

실제 DOM/Canvas/Worker에 데스크톱 IPC 모델을 연결한 검사다. 누른 입력은 실제 브라우저 입력이고 이후 이동은 capture를 확인한 합성 이벤트다. 앱 ready는 렌더 준비 완료 표식이며 OS의 실제 화면 표시 시점이나 물리 기기 입력 지연을 뜻하지 않는다. 일반 비율의 최초 70.1→74.8ms 관측을 지우지 않고 기준·후보를 번갈아 4회 추가했다. 각 3회의 범위가 겹쳤으며, 이 표본으로 전체 무퇴행·p95를 보장하지 않는다.

별도 Node 함수 검사에서는 세로·가로 2배·축 교환의 warm 중앙값이 각각 약 47.84→6.94ms, 48.88→30.95ms, 47.94→29.31ms였다. 각 입력의 cold 1회·warm 2회·timed 4회와 전체 RGBA/원본 검사를 분리했다. 실제 콜백과는 다른 비용 범위다. 일반 run 압축 126개 출력과 반복문 전개 105개 출력은 픽셀 검사를 통과했으나 퇴행·제한적 이득·복잡성 때문에 제품에 넣지 않았다. 긴 올가미 Path2D 캐시도 앞선 측정에 따라 보류했다.

최종 단위 217개와 타입·포맷 검사, 공개 UI 9개 묶음, 새 후보의 전체 Canvas 56개·문서 12개·실패 복구 2개 비교가 통과했다. 화면 기준은 소스 17개와 자산 8개가 모두 같은 직전 실제 실행을 재사용했으며 새 이전 버전 실행으로 세지 않는다. 별도 WK 진단은 두 32Mi 출력, 8191px 인접 크기의 실제 Worker, 정렬되지 않은 3개 레이어의 전체 raw 픽셀·원본 SHA·guard를 확인했다. 일반 macOS 앱 4단계와 그 안의 scene 21개도 통과했고, 최종 기본 앱과 보존한 일반 앱이 같은 바이너리다. 검증기의 복사 경로를 기본 앱 경로로 오인한 ENOENT는 앱 실행 전 설정 오류로 구분해 바로잡았다.

최대 출력 128MiB와 최대 128KiB의 X 표는 여전히 필요하다. 문서 64MiB·선택 원본 64MiB·새 결과 128MiB의 단순 픽셀 버퍼 모델은 256MiB이며, 후속 target 교체에서 이전 결과가 함께 살아 있으면 384MiB일 수 있다. 별칭을 중복 계산하지 않았지만 캐시·코덱·관측기·GPU·GC 전체의 peak/RSS 측정은 아니다. UI 업로드는 양쪽 모두 50회/38,159,232B였고, 새 ImageData와 surface는 각각 50개로 같았다. 이를 전체 메모리 절감으로 해석하지 않는다.

다음 P1은 일반 비율에서 남는 약 68ms 동기 resize와 약 0.7초의 축소 미리보기 준비다. 최신 target만 처리하는 작업 큐와 취소 가능한 Worker/시간 분할 방식을 설계하되 gesture base·원본 복귀·stale 결과·NoOp·Redo·버퍼 공존을 먼저 검증한다. 장기 RSS와 실제 입력, Android 웹·Safari·Windows·OS picker/IME·출시 인수는 남아 있다. 모바일/태블릿은 웹만, 실행 패키지는 Windows/macOS만 지원한다. 이번 단계에서 커밋·푸시·공개 배포를 수행하지 않았다.


## 대형 선택 핸들의 분할 처리 — 2026-11-06

[분할 resize 구현·실행·독립 검토 근거](evidence/studio-bounded-resize.json). 이전 단계에 남긴 56~75ms 동기 핸들 콜백을 변경했다. 기존 nearest 계산을 `resizeNearestSteps` 하나에 두고, 동기 `resizeState`는 끝까지 실행하며 UI는 MessageChannel을 통해 행 묶음씩 실행한다. 두 호출자가 같은 픽셀 알고리즘을 공유하므로 작은 헬퍼로 순차 코드를 나눈 변경과 구분한다. 새 runtime 모듈·의존성·파일 형식·Worker 프로토콜은 없다.

한 번의 커서 진행은 최대 65,536 출력 픽셀이다. 레이어 끝에서도 양보해 잔여 행이 다음 레이어와 누적되지 않게 했다. validation·X 좌표 표·전체 결과 버퍼 할당·GC의 실행 시간 상한은 아니며 고정 4ms를 보장하지 않는다. 262,144픽셀 미만의 새 요청은 기존 동기 경로를 사용한다. 이미 큰 작업을 진행 중이면 작은 최신 요청도 같은 소유자가 처리한다.

한 gesture에는 최신 목표 슬롯과 활성 커서 하나만 둔다. 완성 전에는 마지막 완성 raster를 유지하고 목표 윤곽·핸들을 표시한다. 현재·시작·base 크기 복귀는 작업을 먼저 무효화해 A→B→A 뒤 B가 늦게 설치되는 것을 막는다. 포인터를 놓으면 마지막 좌표와 포인터 정리를 동기로 끝내고, 계산 완료까지 released drag를 유지한다. 미완성 결과의 Enter·저장·복사·Undo 소비를 막으며 Esc·화면의 취소 버튼·blur·hidden 등은 시작 snapshot을 복원한다. 외부 상태 교체나 새 gesture에는 오래된 rollback을 적용하지 않는다.

취소 버튼은 기존 SVG와 skin·touch density 규칙을 사용한다. workspace 위 절대 배치로 canvas 레이아웃을 바꾸지 않는다. 390px의 touch-capable 모바일 에뮬레이션에서 메뉴로 파일을 열고 44px 이상 취소 버튼과 PNG 결과를 검사했다. 입력은 mouse이므로 실제 Android·태블릿 touch 인수가 아니다.

| 실제 Chromium 관측 | 역사적 현행 기준 | 새 후보 |
| --- | ---: | ---: |
| 가로 8192px 첫 이동 콜백 | 56.2ms | 0.4ms |
| 가로 8191px 첫 이동 콜백 | 74.8ms | 0.8ms |
| 세로 8192px 첫 이동 콜백 | 24.4ms | 0.5ms |
| 앱 ready: 가로 8192px | 758.3ms | 698.7ms |
| 앱 ready: 가로 8191px | 692.6ms | 689.1ms |
| 앱 ready: 세로 8192px | 700.9ms | 682.7ms |

새 후보는 각 1회이며, 이전 소스·자산이 같은 실제 현행 5표본을 재사용했다. 새 baseline 실행으로 세지 않는다. 8191px의 이전 3회 콜백 74.8/68.7/65.4ms도 남긴다. 새 3종에서 LongTask는 관측되지 않았고 10ms 타이머의 최대 간격은 20.3/22.1/17.8ms였다. 전체 phase Canvas·raw RGBA·실제 PNG·원본·취소·기존 Redo가 같았다. 업로드 50회/38,159,232B와 명목 ImageData·surface 각 50개도 같다. 당시 전역 MessagePort 계측에는 resize의 resolver-only 핸들러와 미리보기를 동기로 실행하는 핸들러가 섞였다. 이전 resolver-only라는 일괄 설명은 부정확하며, 미분류 합계로 async 커서 CPU나 렌더 CPU를 분리할 수 없다. 원문 수치는 유지한다. p95·전역 50ms·실제 화면 표시 지연 인수는 남는다.

공유 커서가 동기 API를 느리게 만드는지도 별도로 비교했다. before/candidate 10개 child, 각 cold 1·warm 2·timed 4, 총 70회 전체 RGBA·원본·버퍼 수명 검사가 통과했다. timed 중앙값은 세로 7.07→6.71ms, 가로 29.81→25.87ms, 축 교환 29.24→25.33ms였다. 가로 cold 36.30→39.03ms와 작은 입력의 분산을 보존하며 전체 무퇴행으로 확대하지 않는다.

최종 단위 229개, 공개 resize 10개를 포함한 10개 회귀 묶음, 후보 Canvas 56개·문서 12개·실패 복구 2개 비교가 통과했다. 실제 WK 별도 진단 4개는 8191×4096의 near-max raw 출력과 latest/released·대기 취소·문서 교체·Enter/Esc를 확인했다. 일반 macOS 앱 4단계와 scene 21개도 별도로 통과했다. 최종 일반 앱을 복원했으며 보존한 앱과 같은 바이너리다.

리뷰에서 발견한 두 실행기의 macOS 고정 Chrome 경로는 기본 Playwright 브라우저를 사용하도록 고쳤다. 새 회귀는 CI에 연결했으나 원격 Ubuntu CI를 실제 실행하지는 않았다. ESM 경계 누락과 모바일 테스트의 숨겨진 열기 버튼 접근은 실행기 문제로 분리해 교정했다.

최대 출력 128MiB와 X 표 128KiB는 유지한다. 이미 큰 선택의 다음 gesture에서는 문서 64+base 64+시작 snapshot 128+현재 표시 128+부분 후보 128MiB가 서로 다르면 512MiB가 공존할 수 있다. 폐기한 후보도 GC 전에는 남을 수 있다. 활성 owner 하나는 물리 peak/RSS 상한을 뜻하지 않는다. 다음 우선순위는 약 0.7초의 축소 미리보기 준비, 연속 최신 target의 재할당·후속 gesture·장기 RSS, 실제 Android 웹/Safari/Windows·OS/출시 인수다. 모바일/태블릿은 웹만, 패키지는 Windows/macOS만 유지하며 커밋·푸시·공개 배포는 수행하지 않았다.


## 축소 미리보기 비용 조사와 후보 보류 — 2026-11-06

[측정·보류·독립 검토 근거](evidence/studio-cold-mip-investigation.json). 이 단계에서는 제품 소스 17개와 빌드 자산 8개를 변경하지 않았다. 별도 CDP 진단의 1,072개 가중 표본에서 `walkTiles` self 약 527ms가 관측돼, 약 0.7초 준비 시간을 단순 MessageChannel 대기로 보던 가설을 좁혔다. 표본 간격은 요청 500µs와 달리 중앙 756µs였으며, 함수 내부 분기나 정확한 CPU·GPU 시간을 확정하지 않는다.

인덱스 이동·누적값 지역 변수·2×2 전개·반복 행/샘플 재사용을 제품 밖에서 비교했다. Node fake Canvas의 427회 전체 업로드 raw RGBA·원본 비교는 통과했으나 실제 Canvas·플랫폼 인수가 아니다. 2×2 후보의 실제 Chromium 일반 카메라 준비 시간은 역사적 동일 소스 각 1회 대비 698.7→555.4ms, 689.1→568.3ms, 682.7→527.5ms였다. 새 기준 실행이나 분포 비교로 세지 않는다.

같은 후보의 별도 factor16 카메라에서는 새 기준/후보 각 1회의 준비 시간이 658.7→884.2ms, LongTask가 [99]→[57,127,50,127]ms로 늘었다. 전체 Canvas·raw/실제 PNG·원본·취소·기존 Redo/Undo와 업로드 3회/790,528B는 같았다. 원인과 안정적 퇴행 크기를 단정할 표본은 아니지만 채택을 보류할 충분한 우려다. 다른 후보도 입력 패턴·factor에 따라 퇴행해 모두 미반영했다. JIT·함수 크기는 가설이며 확인된 RCA로 기록하지 않는다.

초기 factor16 실행기의 JS double/Canvas float32 축척 비교 실패는 첫 resize 이전의 검증기 오류다. 원문을 남기고 별도 v2에서 정확한 `Math.fround` 기대와 전체 카메라 일치를 검사했다. 성능 표본으로 세지 않는다. 이전 일반 macOS 4단계·별도 WK 4개는 이미 끝난 분할 resize 검증이며 이 조사의 새 네이티브 실행이 아니다.

다음 P1은 연속 큰 target·후속 gesture의 후보 버퍼 수명/장기 RSS와 현행 factor16의 99ms 관측을 분리 측정하는 일이다. raw alpha·변형 후 box 순서·두 raster의 예산·취소/실패 소유권을 유지하며 특수 분기를 누적하지 않는다. 실제 Android 웹·Windows·OS 파일/IME, 동일 DPR WK·분리 dirty·원격 CI/서명·홈페이지 staging도 미완료다. 모바일은 웹만, 패키지는 Windows/macOS만이며 커밋·푸시·공개 배포는 하지 않았다.


## 연속 선택 크기 변경의 버퍼 수명 — 2026-11-06

[원문·관측기 보정·독립 검토](evidence/studio-resize-memory.json). 제품 소스 17개와 자산 8개는 그대로다. 웹/데스크톱의 실제 move/up/cancel·nearest 본문을 쓰는 Node 모델 각 1회에서 후보 11개·전체 raw 출력 7개, 원본·기존 Redo/Undo를 확인했다. DOM·렌더·포인터 시작과 scheduler는 모델이므로 브라우저 인수와 구분한다. 취소·settle·강제 GC 뒤 복원된 후보 하나, released 작업 뒤 현재 후보 하나, 선택 제거·강제 GC 뒤 후보 0개였다.

실제 Chromium의 별도 데스크톱 IPC 모델 1회는 8192×4096 완료/Up, 공개 축소 5회, 다음 gesture의 8191×4096 완료 유지, 8190→8189→8188의 실제 후보 생성 후 교체를 실행했다. 세 생성 시 ready=false/aria-busy=true였고 최종 8188×4096의 CopyWorker 입력 raw 134,152,192B가 전체 수식 검사·SHA를 통과했다. 별도 Node word 기대와 목표·원본 SHA도 같았다. 이 관측기는 PNG Blob/bytes를 읽지 않으므로 PNG payload 인수로 세지 않는다. Escape는 계산 완료/Up 이후의 미확정 선택을 취소했으며 준비 중 취소는 이전 회귀/Node 모델 근거와 구분한다.

자연 구간에는 강제 GC를 실행하지 않았다. 당시 관측한 픽셀 버퍼의 WeakRef 조회 가능 합계는 첫 완료 256MiB, 다음 gesture의 시작/표시 383.98MiB, 첫 partial 511.95MiB, 세 후보 burst 767.84MiB였다. 조회 가능은 강한 참조 증명이 아니며 버퍼 용량은 resident 페이지와 다르다. 별도 강제 GC 뒤 현재 문서/base/target 약 255.94MiB, 검증·Escape·다시 GC 뒤 문서 64MiB를 관측했다. 후보 다섯 개는 모두 수집됐다. 모델 파일 저장소가 보관한 입력 47,824,197B는 이 픽셀 합계에서 제외했다.

주 isolate의 backingStorage는 약 826.97→311.93→110.76MiB였으나 ArrayBuffer와 외부 문자열을 포함한다. owned browser/GPU/service/renderer PID의 RSS 단순 합계는 같은 세 지점에서 1619.50→1349.05→1139.77MiB였다. 공유 페이지 중복과 비원자 관측이 있어 고유 물리 메모리나 앱 한 프로세스 RSS가 아니다. raw/PNG 인코딩 검증 구간의 더 큰 RSS 관측을 resize 최고치로 합치지 않는다. 106개 표본은 유한 관측이며 장기/peak/RSS 상한·실기기 성능 인수가 아니다.

초기 실제 실행은 목표 폭만 갱신하고 기대 바이트 수를 바꾸지 않은 관측기 오류로 종료됐다. 당시 앱은 8191×4096/ready=true였다. 원문을 보존하고 기대 dimension/bytes를 함께 갱신한 별도 실행에서 통과했다. Node의 generic metadata 편집/집계 순서·픽셀별 오류문자열도 관측기 문제로 교정·보존했다. 제품 버그로 세지 않는다.

확인한 시퀀스에서 불필요한 강한 후보 참조는 재현되지 않아 buffer pool이나 source/current/start 공유 수정은 추가하지 않았다. 다음은 현행 high-minification 99ms 작업의 원인 분리와 더 긴 자연 입력·실제 native/Android 웹의 메모리 검증이다. 모바일은 웹만, 패키지는 Windows/macOS만이며 커밋·푸시·공개 배포는 하지 않았다.


## High-minification 진단과 진행량 후보 보류 — 2026-11-06

[재현·추적·반증 근거](evidence/studio-high-minification.json). 제품 소스 17개·자산 8개는 바꾸지 않았다. 같은 소스·카메라·DPR의 새 비추적 1회는 준비 656.7ms/LongTask 0으로 이전 99ms를 재현하지 못했다. 별도 진단 1회도 LongTask 0이었다. 추가 계측이 있으므로 정상 성능 표본과 합치지 않는다. 실제 matrix·전체 5개 phase Canvas·raw/PNG·원본·취소·Redo는 역사적 동일 소스와 같았다.

외부 next/API/handler hook과 제한된 trace에서 tile-prepare next의 최대 42.8ms를 확인했다. 포함된 main RunTask는 wall 43.831ms/thread CPU 42.005ms였다. 해당 next 안에서 관측 API/생성자는 없었지만 특정 내부 함수·명령의 CPU까지 분리한 것은 아니다. compiler/optimization/deopt 계열의 main union 약 1.14ms와 다른 thread의 compiler 동시성을 42.8ms의 근본 원인으로 단정하지 않았다. 기존 99ms의 원인은 미확정이다.

전역 MessagePort 시간을 모두 resolver-only로 보던 해석을 정정했다. resize handler는 Promise를 깨우고, render handler는 renderFrame을 동기로 실행한다. 진단의 render-inline 120회/max 43.8ms와 resize-resolver 514회/max 0.2ms는 별개이며 next·API·Task와 중첩 합산하지 않는다. 이전 수치·필드명은 원문을 유지하되 현재 해석에 이 정정을 적용한다.

세 work checkpoint를 65536→32768로 줄인 격리 후보를 비교했다. 픽셀 계산·타일 계획·버퍼·소유권은 같았고 타일 필수 계약 109개와 공개 흐름의 전체 출력은 통과했고, 기존 정보성 비교 4개도 기록했다(총 113개 기록). 줄어든 quantum에 맞춰 격리 테스트의 single-cell 감시 상한 8→16, retain의 정확한 remaining 4→8만 조정했다. resume 8/restart 9 구분과 raw/source/lease 기대는 유지했다. 그러나 비추적 준비 656.7→755.0ms·LongTask 0→[58,56,57], 별도 진단 next 776→1550회/max 42.8→42.9ms여서 후보를 반영하지 않았다. 안정적인 퇴행률로 확대하지 않지만 채택할 이득은 확인하지 못했다. 현재 제품의 65536 단위와 기존 테스트는 그대로다.

처음 추적은 Chrome의 getCategories가 빈 배열을 반환해 편집 전에 중지했다. 별도 about:blank의 작은 마크·콜백 시험에서는 실제 Task/V8 trace가 나와, 확인된 조건으로 진단을 재개했다. 목록 부재와 추적 불가를 동일시하지 않았다. 이후에는 임계치 실험을 반복하지 않고 각 QF의 완료 조건을 현재 코드·테스트·실행 근거에 대조해 실제 남은 계약을 우선 정렬한다. 물리 Android 웹/Windows·OS·장기 RSS·CI/서명·staging은 계속 열려 있다.

### 2026-11-06 Studio 웹 배포 산출물·안전 staging

[구현·실행·독립 검토](evidence/studio-staging.json). `python3 tools/build_studio.py`로 `dist/studio`의 작은 번들을 만든다. 기본 빌드는 홈페이지에 쓰지 않으며 명시한 `--homepage` 또는 별도 stager로만 로컬 반영한다. 실제 Git 작업은 각 저장소에서 따로 한다. [사용·복구·보존/정리 절차](WEB_BUILD.md)를 따른다.

로컬 회귀 43개와 Qt 포함 CTest 6그룹, 실제 Chrome의 합성 버전 교체·이전 탭 첫 Worker/JPEG·롤백 16개, 기존 저장소 회귀 13개를 확인했다. 9파일/276,578B이며 앱 runtime17·기존 Vite8은 불변이다. LICENSE 링크 overwrite Major는 수정·독립 재검증했다. 공개 Pages/캐시·OS/물리 기기·실제 Qt 복구 이행·원격 CI 인수는 남기며 Qt 앱을 제거하거나 실제 홈페이지에 게시하지 않는다.

### 2026-11-06 둥근 사각형·표면 실패 정리

[최종 구현·검증과 남은 한계](evidence/studio-roundrect-contract.json). 새 도형의 x/y 반경은 각각 최대 12이며 float 좌표·min/abs·기존 scalar 0 퇴화를 유지한다. 컨텍스트 생성이 실패해도 소유 Surface를 finally에서 정리한다. main 하나만 바뀌고 새 helper·모듈·의존성은 없다. `test:roundrect-contract` 공개 회귀 24개를 CI에 추가했다.

Node 229개·공개 24개·기존 도형 23개/pending 36개/웹 48개·Canvas 56개/문서 12개/재시도 2개·일반 macOS 앱 4단계를 확인했다. 실제 UI 8개의 정상 경로는 최대 12의 중간 안정 후보와 화면·파일 40쌍이 동일했다. 읽기 hint는 실제 색 snap 때문에 미채택했고, WK strict AA seam의 기존 false는 감추지 않는다. OS·물리 기기·Windows·공개 게시와 전체 도형 옵션은 별도 게이트다.
