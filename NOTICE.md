# Third-party notices

RetroPaint source is provided under the MIT license in LICENSE.
It is an independently written implementation and contains no copied Windows Paint executable, extracted Windows resources, or REA source.

## Qt

The native application uses dynamically linked Qt 6 Core, Gui and Widgets.
The WebAssembly build statically links the exception-enabled Qt 6.12.0 build. Qt Test is used only by tests.
Qt is copyright The Qt Company Ltd. and its contributors. Licensing choices and third-party components depend on the exact SDK/build being used.

This source archive and the separate Linux development executable do **not** redistribute Qt shared libraries or plugins. They require a separately installed compatible Qt runtime/SDK. The CMake deployment option can copy those libraries on the developer's own machine; it does not automatically collect or fulfill all notices and corresponding-source obligations for a later distribution.

Before distributing bundled Qt, include the licenses and third-party notices from the exact Qt build, provide the corresponding sources as required by its selected license, and preserve the recipient's applicable modification/relinking rights. Keep application-specific source and dependencies identifiable. The copies of GPLv3/LGPLv3 in `licenses/` are reference license texts, not a substitute for a complete dependency notice/source bundle.

Official references:

- https://doc.qt.io/qt-6.8/licensing.html
- https://doc.qt.io/qt-6.8/qtcore-index.html#licenses-and-attributions
- https://doc.qt.io/qt-6.8/qtgui-index.html#licenses-and-attributions
- https://doc.qt.io/qt-6.8/qtwidgets-index.html#licenses
- https://doc.qt.io/qt-6.8/cmake-deployment.html

The CI downloads Qt through aqtinstall 3.3.0. These are development dependencies and are not shipped in the application. The native verification screenshot uses a system-installed Korean font. The native application uses operating-system fonts; the web application and Wasm probe font are described below.

## NanumGothic web font

The web application and WebAssembly probe include the unmodified NanumGothic Regular font from
https://github.com/google/fonts/tree/main/ofl/nanumgothic.
Copyright (c) 2010, NHN Corporation. The font is licensed under the SIL Open
Font License 1.1; see assets/fonts/OFL.txt for the copyright, reserved names,
and complete terms. The native application continues to use system fonts.
The font source identity is recorded by SHA-256 in the Wasm probe evidence.

## Web distribution

The web packaging tool links the official Qt archive for the exact unmodified
Qt commit, and includes the matching application sources and build tools,
Qt LICENSES (including third-party license texts), Emscripten and C/C++ runtime
license texts, and the font license. The pinned Qt source download is:
https://codeload.github.com/qt/qtbase/tar.gz/025bdad181de241e81bf853c8a2d7bf3d19261a9

The official archive was verified against all 23,476 files of the local Qt
source archive. The distributor remains responsible for keeping the source
offer available; if the upstream download becomes unavailable, restore a
verified local archive with --bundle-qt-source. The archive can also be bundled
for a self-contained distribution. No license or relinking material is omitted.
BUILDING.txt records the tested configuration and application rebuild/relink
steps, including replacement of application source. No modification or reverse
engineering restriction is imposed on the recipient's applicable Qt rights.
See docs/WEB_BUILD.md for the local packaging workflow.


Qt-free Studio (`web-app/`)는 별도의 TypeScript/Canvas 엔진과 Windows/macOS Tauri 셸을 개발 중이다. 웹 런타임의 fflate 0.8.3 MIT 고지는 `web-app/public/THIRD_PARTY_NOTICES.txt`에 포함하며 정적 빌드에 복사한다. Tauri/Rust 의존성의 전체 배포 고지, Windows 배포와 macOS 서명·공증은 설치형 공개 전 검증 항목이다. 위 레거시 Qt 고지가 새 엔진에 Qt를 포함한다는 뜻은 아니다.
