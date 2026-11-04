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

The web packaging tool includes the complete Qt source archive for the recorded
Qt commit, Qt LICENSES (including Qt third-party license texts), the matching
application sources and build tools, Emscripten and linked C/C++ runtime license
texts, and the font license. The license page links these local files.
BUILDING.txt records the tested configuration and application rebuild/relink
steps, including replacement of application source. No modification or reverse
engineering restriction is imposed on the recipient's applicable Qt rights.
See docs/WEB_BUILD.md for the local packaging workflow.
