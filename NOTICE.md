# Third-party notices

RetroPaint source is provided under the MIT license in LICENSE.
It is an independently written implementation and contains no copied Windows Paint executable, extracted Windows resources, or REA source.

## Qt

The application uses dynamically linked Qt 6 Core, Gui and Widgets. Qt Test is used only by tests.
Qt is copyright The Qt Company Ltd. and its contributors. Licensing choices and third-party components depend on the exact SDK/build being used.

This source archive and the separate Linux development executable do **not** redistribute Qt shared libraries or plugins. They require a separately installed compatible Qt runtime/SDK. The CMake deployment option can copy those libraries on the developer's own machine; it does not automatically collect or fulfill all notices and corresponding-source obligations for a later distribution.

Before distributing bundled Qt, include the licenses and third-party notices from the exact Qt build, provide the corresponding sources as required by its selected license, and preserve the recipient's applicable modification/relinking rights. Keep application-specific source and dependencies identifiable. The copies of GPLv3/LGPLv3 in `licenses/` are reference license texts, not a substitute for a complete dependency notice/source bundle.

Official references:

- https://doc.qt.io/qt-6.8/licensing.html
- https://doc.qt.io/qt-6.8/qtcore-index.html#licenses-and-attributions
- https://doc.qt.io/qt-6.8/qtgui-index.html#licenses-and-attributions
- https://doc.qt.io/qt-6.8/qtwidgets-index.html#licenses
- https://doc.qt.io/qt-6.8/cmake-deployment.html

The CI downloads Qt through aqtinstall 3.3.0. These are development dependencies and are not shipped in the application. A Korean font installed in the verification environment was used to render the screenshot; font files are not included in this archive. The application uses the fonts installed on the user's operating system.
