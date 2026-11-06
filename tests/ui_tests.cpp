#include "colorpicker.h"
#include "mainwindow.h"
#include <QAction>
#include <QClipboard>
#include <QComboBox>
#include <QDockWidget>
#include <QFileDialog>
#include <QInputMethodEvent>
#include <QLineEdit>
#include <QListWidget>
#include <QMessageBox>
#include <QPointingDevice>
#include <QPushButton>
#include <QStandardPaths>
#include <QTabletEvent>
#include <QTemporaryDir>
#include <QTextEdit>
#include <QtTest>

using namespace paint;
class UiTests : public QObject {
    Q_OBJECT
  private slots:
    void initTestCase();
    void smoothBrushEndpointsAndUndo();
    void brushOpacityAndSoftness();
    void fractionalBrushInput();
    void tabletPressureOwnsItsStroke();
    void studioColorControls();
    void textClipboardDoesNotCutLayer();
    void exportKeepsPendingState();
    void recoveryPathIsProtected();
    void cancelStagedSavePreservesFile();
    void recoveryDiscardsStaleSnapshot();
    void rejectedSelectionMoveIsUnchanged();
    void textBoundsAndZoom();
    void preeditCannotBeSilentlyDiscarded();
    void pendingCommandsPreserveState_data();
    void pendingCommandsPreserveState();
    void savePendingRoundTrip();
    void gestureOwnsItsButton();
    void cutUsesActiveLayer();
    void resizedSelectionCopyAndRotate();
    void cropIncludesPendingExtent();
    void pendingActionsAndReleaseModifiers();
    void pencilAndUndo();
    void cancelledStroke();
    void pasteMoveResizeUndo();
    void unchangedTransparentSelection();
    void cutAndCancel();
    void selectionTransform();
    void singleEdgeCanvasResize();
    void panDoesNotEdit();
    void shapes_data();
    void shapes();
    void curveAndPolygon();
    void fillAndHiddenLayer();
    void koreanTextCommit();
    void clipboardRoundTrip();
    void layerSwitchSettlesPaste();
    void badOpenPreservesWork();
    void zoomedRenderIsBounded();
    void brushEraserAndPicker();
    void freeSelectionKeepsOutsidePixels();
    void lostMouseGrabStopsSpray();
    void closeCancelKeepsDocument();
    void damagedRecoveryIsPreserved();
    void hiddenSingleLayerRequiresProjectSave();
    void discardedDocumentClearsOldRecovery();
};
void UiTests::initTestCase() {
    QCoreApplication::setApplicationName("RetroPaint-tests");
    QCoreApplication::setOrganizationName("RetroPaint-tests");
    QStandardPaths::setTestModeEnabled(true);
}
void UiTests::textClipboardDoesNotCutLayer() {
    MainWindow window;
    window.show();
    auto *canvas = window.canvasWidget();
    canvas->setTool(Tool::Text);
    QTest::mouseClick(canvas, Qt::LeftButton, {}, QPoint(10, 10));
    auto *editor = canvas->findChild<QTextEdit *>();
    QVERIFY(editor);
    editor->setPlainText(QStringLiteral("ABCDEF"));
    auto cursor = editor->textCursor();
    cursor.setPosition(1);
    cursor.setPosition(4, QTextCursor::KeepAnchor);
    editor->setTextCursor(cursor);
    for (auto *action : window.findChildren<QAction *>())
        if (action->text() == QStringLiteral("잘라내기")) {
            action->trigger();
            break;
        }
    QCOMPARE(QApplication::clipboard()->text(), QStringLiteral("BCD"));
    QCOMPARE(editor->toPlainText(), QStringLiteral("AEF"));
    QApplication::clipboard()->setText(QStringLiteral("한글"));
    for (auto *action : window.findChildren<QAction *>())
        if (action->text() == QStringLiteral("붙여넣기")) {
            action->trigger();
            break;
        }
    QCOMPARE(editor->toPlainText(), QStringLiteral("A한글EF"));
    QVERIFY(!window.document().dirty());
    QVERIFY(!window.document().canUndo());
    QVERIFY(canvas->hasPendingEdit());
    canvas->cancel();
}
void UiTests::exportKeepsPendingState() {
    MainWindow window;
    QTemporaryDir directory;
    const auto path = directory.filePath("export.png");
    auto *canvas = window.canvasWidget();
    canvas->paste(Document::allocate(QSize(7, 6), Qt::red));
    const auto revision = window.document().revision();
    bool dialogSeen = false;
    QTimer::singleShot(0, [&] {
        auto *dialog = qobject_cast<QFileDialog *>(QApplication::activeModalWidget());
        QVERIFY(dialog);
        dialogSeen = true;
        dialog->selectFile(path);
        QVERIFY(QMetaObject::invokeMethod(dialog, "accept", Qt::DirectConnection));
    });
    for (auto *action : window.findChildren<QAction *>())
        if (action->text() == QStringLiteral("이미지 내보내기…")) {
            action->trigger();
            break;
        }
    QVERIFY(dialogSeen);
    QCOMPARE(Document::readImage(path).layers[0].image.pixelColor(0, 0), QColor(Qt::red));
    QCOMPARE(window.document().revision(), revision);
    QVERIFY(!window.document().dirty());
    QVERIFY(window.document().path.isEmpty());
    QVERIFY(canvas->hasSelection());
    canvas->cancel();
}
void UiTests::recoveryPathIsProtected() {
    MainWindow window;
    const auto path =
        QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation) + "/recovery.rpaint";
    Document::writeProject(window.document().state(), path);
    window.openFile(path);
    window.canvasWidget()->paste(Document::allocate(QSize(7, 6), Qt::red));
    bool warned = false;
    QTimer::singleShot(0, [&] {
        auto *dialog = qobject_cast<QMessageBox *>(QApplication::activeModalWidget());
        QVERIFY(dialog);
        warned = true;
        dialog->accept();
    });
    for (auto *action : window.findChildren<QAction *>())
        if (action->text() == QStringLiteral("저장")) {
            action->trigger();
            break;
        }
    QVERIFY(warned);
    QVERIFY(window.canvasWidget()->hasSelection());
    QCOMPARE(Document::readProject(path).layers[0].image.pixelColor(0, 0), QColor(Qt::white));
    window.canvasWidget()->cancel();
    QVERIFY(window.close());
    QVERIFY(QFile::exists(path));
    QVERIFY(QFile::remove(path));
}
void UiTests::cancelStagedSavePreservesFile() {
    MainWindow window;
    QTemporaryDir directory;
    const auto path = directory.filePath("original.rpaint");
    QFile file(path);
    QVERIFY(file.open(QIODevice::WriteOnly));
    QCOMPARE(file.write("original"), qint64(8));
    file.close();
    window.document().path = path;
    window.canvasWidget()->paste(Document::allocate(QSize(7, 6), Qt::red));
    const auto revision = window.document().revision();
    bool cancelled = false;
    QTimer::singleShot(0, [&] {
        auto *dialog = qobject_cast<QDialog *>(QApplication::activeModalWidget());
        QVERIFY(dialog);
        QCOMPARE(dialog->windowTitle(), QStringLiteral("그림 저장"));
        dialog->reject();
        cancelled = true;
    });
    for (auto *action : window.findChildren<QAction *>())
        if (action->text() == QStringLiteral("저장")) {
            action->trigger();
            break;
        }
    QVERIFY(cancelled);
    QVERIFY(window.canvasWidget()->hasSelection());
    QCOMPARE(window.document().revision(), revision);
    QVERIFY(!window.document().dirty());
    QVERIFY(file.open(QIODevice::ReadOnly));
    QCOMPARE(file.readAll(), QByteArray("original"));
    window.canvasWidget()->cancel();
}
void UiTests::recoveryDiscardsStaleSnapshot() {
    MainWindow window;
    const auto path =
        QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation) + "/recovery.rpaint";
    Document::writeProject(window.document().state(), path);
    auto *start = window.findChild<QTimer *>(QStringLiteral("recoveryStart"));
    QVERIFY(start);
    QSignalSpy finished(&window, &MainWindow::recoveryFinished);
    auto state = window.document().state();
    state.layers[0].image.setPixelColor(0, 0, Qt::red);
    window.document().commit(state, "red");
    QVERIFY(QMetaObject::invokeMethod(start, "timeout", Qt::DirectConnection));
    state.layers[0].image.setPixelColor(0, 0, Qt::blue);
    window.document().commit(state, "blue");
    QTRY_COMPARE_WITH_TIMEOUT(finished.size(), 1, 10000);
    QVERIFY(!finished[0][1].toBool());
    QCOMPARE(Document::readProject(path).layers[0].image.pixelColor(0, 0), QColor(Qt::white));
    finished.clear();
    QVERIFY(QMetaObject::invokeMethod(start, "timeout", Qt::DirectConnection));
    QTRY_COMPARE_WITH_TIMEOUT(finished.size(), 1, 10000);
    QVERIFY(finished[0][1].toBool());
    QCOMPARE(Document::readProject(path).layers[0].image.pixelColor(0, 0), QColor(Qt::blue));
    finished.clear();
    state.layers[0].image.setPixelColor(0, 0, Qt::green);
    window.document().commit(state, "green");
    QVERIFY(QMetaObject::invokeMethod(start, "timeout", Qt::DirectConnection));
    window.document().markSaved();
    QTRY_COMPARE_WITH_TIMEOUT(finished.size(), 1, 10000);
    QVERIFY(!finished[0][1].toBool());
    QCOMPARE(Document::readProject(path).layers[0].image.pixelColor(0, 0), QColor(Qt::blue));
    finished.clear();
    QTemporaryDir directory;
    window.document().path = directory.filePath("manual.rpaint");
    state.layers[0].image.setPixelColor(0, 0, Qt::yellow);
    window.document().commit(state, "yellow");
    QVERIFY(QMetaObject::invokeMethod(start, "timeout", Qt::DirectConnection));
    for (auto *action : window.findChildren<QAction *>())
        if (action->text() == QStringLiteral("저장")) {
            action->trigger();
            break;
        }
    QTRY_COMPARE_WITH_TIMEOUT(finished.size(), 1, 10000);
    QVERIFY(!finished[0][1].toBool());
    QVERIFY(!QFile::exists(path));
    QVERIFY(!window.document().dirty());
    QCOMPARE(Document::readProject(window.document().path).layers[0].image.pixelColor(0, 0),
             QColor(Qt::yellow));
}
void UiTests::rejectedSelectionMoveIsUnchanged() {
    Document doc(QSize(MaxDimension, 1));
    auto state = Document::blank(doc.state().size, Qt::transparent);
    state.background = Qt::white;
    doc.reset(state);
    Canvas canvas(doc);
    canvas.selectAll();
    QSignalSpy errors(&canvas, &Canvas::errorOccurred);
    QTest::keyClick(&canvas, Qt::Key_Right);
    QCOMPARE(errors.size(), 1);
    QCOMPARE(canvas.pendingState().layers[0].image, state.layers[0].image);
    canvas.settle();
    QVERIFY(!doc.dirty());
}
void UiTests::textBoundsAndZoom() {
    Document doc(QSize(400, 300));
    Canvas canvas(doc);
    canvas.show();
    canvas.setTool(Tool::Text);
    QTest::mouseClick(&canvas, Qt::LeftButton, {}, QPoint(10, 10));
    auto *editor = canvas.findChild<QTextEdit *>();
    QVERIFY(editor);
    editor->setPlainText(QStringLiteral("ABC 한글\n").repeated(30));
    canvas.setZoom(4);
    QVERIFY(canvas.hasPendingEdit());
    QVERIFY(!doc.dirty());
    canvas.setZoom(1);
    const auto pending = canvas.pendingState();
    QCOMPARE(pending.layers[0].image.copy(0, 140, 400, 160),
             doc.state().layers[0].image.copy(0, 140, 400, 160));
    canvas.settle();
    QCOMPARE(doc.state().layers[0].image, pending.layers[0].image);
    doc.undo();
    QVERIFY(!doc.dirty());
}
void UiTests::preeditCannotBeSilentlyDiscarded() {
    Document doc(QSize(400, 200));
    Canvas canvas(doc);
    canvas.show();
    canvas.setTool(Tool::Text);
    QTest::mouseClick(&canvas, Qt::LeftButton, {}, QPoint(10, 10));
    auto *editor = canvas.findChild<QTextEdit *>();
    QVERIFY(editor);
    QInputMethodEvent composing(QStringLiteral("한"), {});
    QApplication::sendEvent(editor, &composing);
    QVERIFY_THROWS_EXCEPTION(std::runtime_error, canvas.pendingState());
    QVERIFY(!doc.dirty());
    QVERIFY(canvas.hasPendingEdit());
    QInputMethodEvent committed;
    committed.setCommitString(QStringLiteral("한글 ABC"));
    QApplication::sendEvent(editor, &committed);
    QCOMPARE(editor->toPlainText(), QStringLiteral("한글 ABC"));
    canvas.settle();
    QVERIFY(doc.dirty());
    doc.undo();
    QVERIFY(!doc.dirty());
}
void UiTests::pendingCommandsPreserveState_data() {
    QTest::addColumn<int>("pendingTool");
    QTest::addColumn<QString>("command");
    for (int tool : {int(Tool::Select), int(Tool::Text), int(Tool::Polygon), int(Tool::Curve)})
        for (const auto &command : {QStringLiteral("save_cancel"), QStringLiteral("save_failure"),
                                    QStringLiteral("close_cancel"), QStringLiteral("resize_cancel")})
            QTest::newRow(qPrintable(QString::number(tool) + "_" + command)) << tool << command;
}
void UiTests::pendingCommandsPreserveState() {
    QFETCH(int, pendingTool);
    QFETCH(QString, command);
    MainWindow window;
    window.show();
    auto *canvas = window.canvasWidget();
    if (pendingTool == int(Tool::Select)) {
        canvas->paste(Document::allocate(QSize(7, 6), Qt::red));
    } else {
        canvas->setTool(Tool(pendingTool));
        if (pendingTool == int(Tool::Text)) {
            QTest::mouseClick(canvas, Qt::LeftButton, {}, QPoint(10, 10));
            canvas->findChild<QTextEdit *>()->setPlainText(QStringLiteral("보존 ABC"));
        } else if (pendingTool == int(Tool::Polygon)) {
            for (QPoint point : {QPoint(5, 5), QPoint(40, 5), QPoint(20, 30)})
                QTest::mouseClick(canvas, Qt::LeftButton, {}, point);
        } else {
            QTest::mousePress(canvas, Qt::LeftButton, {}, QPoint(5, 5));
            QTest::mouseRelease(canvas, Qt::LeftButton, {}, QPoint(40, 25));
        }
    }
    const auto pending = canvas->pendingState();
    const auto revision = window.document().revision();
    const auto original = window.document().composite();
    QTemporaryDir directory;
    if (command == "save_failure")
        window.document().path = directory.filePath("missing/output.rpaint");
    const auto originalPath = window.document().path;
    bool dialogSeen = false;
    QTimer responder;
    connect(&responder, &QTimer::timeout, &window, [&] {
        auto *dialog = qobject_cast<QDialog *>(QApplication::activeModalWidget());
        if (!dialog || (command == "save_failure" && !qobject_cast<QMessageBox *>(dialog)))
            return;
        responder.stop();
        dialogSeen = true;
        if (command == "close_cancel") {
            auto *message = qobject_cast<QMessageBox *>(dialog);
            QVERIFY(message);
            message->button(QMessageBox::Cancel)->click();
        } else if (command == "save_failure") {
            QVERIFY(qobject_cast<QMessageBox *>(dialog));
            dialog->accept();
        } else {
            dialog->reject();
        }
    });
    responder.start(1);
    if (command == "close_cancel") {
        QVERIFY(!window.close());
    } else {
        const QString actionName =
            command == "resize_cancel" ? QStringLiteral("캔버스 크기…") : QStringLiteral("저장");
        bool actionSeen = false;
        for (auto *action : window.findChildren<QAction *>())
            if (action->text() == actionName) {
                actionSeen = true;
                action->trigger();
                break;
            }
        QVERIFY(actionSeen);
    }
    QVERIFY(dialogSeen);
    QCOMPARE(window.document().revision(), revision);
    QCOMPARE(window.document().path, originalPath);
    QCOMPARE(window.document().composite(), original);
    QVERIFY(!window.document().dirty());
    QVERIFY(!window.document().canUndo());
    QVERIFY(canvas->hasPendingEdit());
    QCOMPARE(canvas->pendingState().layers[0].image, pending.layers[0].image);
    canvas->cancel();
}
void UiTests::savePendingRoundTrip() {
    MainWindow window;
    QTemporaryDir directory;
    window.document().path = directory.filePath("saved.rpaint");
    auto *canvas = window.canvasWidget();
    canvas->paste(Document::allocate(QSize(7, 6), Qt::red));
    const State pending = canvas->pendingState();
    for (auto *action : window.findChildren<QAction *>())
        if (action->text() == QStringLiteral("저장")) {
            action->trigger();
            break;
        }
    QVERIFY(!canvas->hasPendingEdit());
    QVERIFY(!window.document().dirty());
    QCOMPARE(Document::readProject(window.document().path).layers[0].image, pending.layers[0].image);
    window.document().undo();
    QCOMPARE(window.document().composite().pixelColor(0, 0), QColor(Qt::white));
    QVERIFY(window.document().dirty());
    window.document().redo();
    QVERIFY(!window.document().dirty());
}
void UiTests::gestureOwnsItsButton() {
    Document doc(QSize(60, 40));
    Canvas canvas(doc);
    canvas.show();
    canvas.foreground = Qt::red;
    QTest::mousePress(&canvas, Qt::LeftButton, {}, QPoint(5, 5));
    QTest::mouseMove(&canvas, QPoint(20, 5));
    QTest::mousePress(&canvas, Qt::MiddleButton, {}, QPoint(20, 5));
    QTest::mouseRelease(&canvas, Qt::MiddleButton, {}, QPoint(20, 5));
    QVERIFY(canvas.hasPendingEdit());
    QTest::mouseRelease(&canvas, Qt::LeftButton, {}, QPoint(20, 5));
    QCOMPARE(doc.composite().pixelColor(10, 5), QColor(Qt::red));
    doc.undo();
    QVERIFY(!doc.dirty());
}
void UiTests::cutUsesActiveLayer() {
    Document doc(QSize(20, 20));
    State state = Document::blank(QSize(20, 20), QColor(240, 30, 20, 128));
    state.layers.push_back({"top", Document::allocate(state.size, Qt::blue), true});
    doc.reset(state);
    Canvas canvas(doc);
    canvas.copy(false);
    QCOMPARE(QApplication::clipboard()->image().pixelColor(0, 0), QColor(Qt::blue));
    canvas.copy(true);
    QCOMPARE(QApplication::clipboard()->image(), state.layers[0].image);
    QCOMPARE(doc.state().layers[0].image.pixelColor(0, 0).alpha(), 0);
    QCOMPARE(doc.state().layers[1].image, state.layers[1].image);
    doc.undo();
    QCOMPARE(doc.state().layers[0].image, state.layers[0].image);
}
void UiTests::resizedSelectionCopyAndRotate() {
    Document doc(QSize(40, 30));
    Canvas canvas(doc);
    canvas.show();
    canvas.paste(Document::allocate(QSize(20, 20), Qt::red));
    QTest::mousePress(&canvas, Qt::LeftButton, {}, QPoint(19, 19));
    QTest::mouseMove(&canvas, QPoint(29, 24));
    QTest::mouseRelease(&canvas, Qt::LeftButton, {}, QPoint(29, 24));
    canvas.copy(false);
    QCOMPARE(QApplication::clipboard()->image().size(), QSize(30, 25));
    canvas.transformSelection(QTransform().rotate(90));
    canvas.copy(false);
    QCOMPARE(QApplication::clipboard()->image().size(), QSize(25, 30));
    for (int i = 0; i < 8; ++i)
        QTest::keyClick(&canvas, Qt::Key_Right, Qt::ShiftModifier);
    QVERIFY(canvas.width() >= 115);
    canvas.cancel();
    QCOMPARE(canvas.width(), 50);
    QVERIFY(!doc.dirty());
}
void UiTests::cropIncludesPendingExtent() {
    Document doc(QSize(40, 30));
    Canvas canvas(doc);
    canvas.paste(Document::allocate(QSize(45, 35), Qt::red));
    canvas.crop();
    QCOMPARE(doc.state().size, QSize(45, 35));
    QCOMPARE(doc.composite().pixelColor(44, 34), QColor(Qt::red));
    QVERIFY(!canvas.hasSelection());
    doc.undo();
    QCOMPARE(doc.state().size, QSize(40, 30));
    QCOMPARE(doc.composite().pixelColor(0, 0), QColor(Qt::white));
    QVERIFY(!doc.canUndo());
    QVERIFY(!doc.dirty());
}
void UiTests::pendingActionsAndReleaseModifiers() {
    MainWindow window;
    window.show();
    auto *canvas = window.canvasWidget();
    QAction *undo = nullptr;
    for (auto *action : window.findChildren<QAction *>())
        if (action->shortcut() == QKeySequence(QKeySequence::Undo))
            undo = action;
    QVERIFY(undo);
    QVERIFY(!undo->isEnabled());
    canvas->setTool(Tool::Text);
    QTest::mouseClick(canvas, Qt::LeftButton, {}, QPoint(10, 10));
    QVERIFY(undo->isEnabled());
    undo->trigger();
    QVERIFY(!canvas->hasPendingEdit());
    canvas->setTool(Tool::Line);
    QTest::mousePress(canvas, Qt::LeftButton, {}, QPoint(5, 5));
    QVERIFY(undo->isEnabled());
    QTest::mouseMove(canvas, QPoint(30, 20));
    QTest::mouseRelease(canvas, Qt::LeftButton, Qt::ShiftModifier, QPoint(30, 20));
    QCOMPARE(window.document().composite().pixelColor(30, 20), QColor(Qt::white));
    QVERIFY(window.document().dirty());
    window.document().markSaved();
}
void UiTests::pencilAndUndo() {
    Document doc(QSize(80, 60));
    Canvas canvas(doc);
    canvas.show();
    canvas.foreground = Qt::red;
    QTest::mousePress(&canvas, Qt::LeftButton, {}, QPoint(5, 5));
    QTest::mouseMove(&canvas, QPoint(30, 5));
    QTest::mouseRelease(&canvas, Qt::LeftButton, {}, QPoint(30, 5));
    QCOMPARE(doc.composite().pixelColor(15, 5), QColor(Qt::red));
    doc.undo();
    QVERIFY(!doc.dirty());
    QCOMPARE(doc.composite().pixelColor(15, 5), QColor(Qt::white));
    doc.redo();
    QCOMPARE(doc.composite().pixelColor(15, 5), QColor(Qt::red));
}
void UiTests::cancelledStroke() {
    Document doc(QSize(80, 60));
    Canvas canvas(doc);
    canvas.show();
    canvas.setTool(Tool::Spray);
    QTest::mousePress(&canvas, Qt::LeftButton, {}, QPoint(10, 10));
    QTest::keyClick(&canvas, Qt::Key_Escape);
    QTest::mouseRelease(&canvas, Qt::LeftButton, {}, QPoint(10, 10));
    QTest::qWait(50);
    QVERIFY(!doc.dirty());
    QVERIFY(!canvas.hasPendingEdit());
}
void UiTests::pasteMoveResizeUndo() {
    Document doc(QSize(40, 30));
    Canvas canvas(doc);
    canvas.show();
    canvas.paste(Document::allocate(QSize(45, 35), Qt::red));
    QVERIFY(!doc.dirty());
    QTest::keyClick(&canvas, Qt::Key_Right);
    canvas.settle();
    QCOMPARE(doc.state().size, QSize(46, 35));
    QCOMPARE(doc.composite().pixelColor(45, 34), QColor(Qt::red));
    doc.undo();
    QCOMPARE(doc.state().size, QSize(40, 30));
    QVERIFY(!doc.dirty());
    doc.redo();
    QCOMPARE(doc.state().size, QSize(46, 35));
    canvas.paste(Document::allocate(QSize(20, 20), Qt::blue));
    QTest::mousePress(&canvas, Qt::LeftButton, {}, QPoint(19, 19));
    QTest::mouseMove(&canvas, QPoint(29, 24));
    QTest::mouseRelease(&canvas, Qt::LeftButton, {}, QPoint(29, 24));
    canvas.settle();
    QCOMPARE(doc.composite().pixelColor(29, 24), QColor(Qt::blue));
    QCOMPARE(doc.composite().pixelColor(30, 24), QColor(Qt::red));
}
void UiTests::unchangedTransparentSelection() {
    Document doc(QSize(40, 30));
    auto state = Document::blank(QSize(40, 30), Qt::transparent);
    state.background = Qt::white;
    state.layers[0].image.setPixelColor(2, 2, QColor(100, 150, 200, 90));
    doc.reset(state);
    Canvas canvas(doc);
    canvas.selectAll();
    canvas.settle();
    QVERIFY(!doc.dirty());
    QCOMPARE(doc.state().layers[0].image, state.layers[0].image);
    canvas.selectAll();
    canvas.cancel();
    QCOMPARE(doc.state().layers[0].image, state.layers[0].image);
}
void UiTests::cutAndCancel() {
    Document doc(QSize(20, 20));
    auto state = doc.state();
    state.layers[0].image.fill(Qt::red);
    doc.reset(state);
    Canvas canvas(doc);
    canvas.selectAll();
    canvas.copy(true);
    QCOMPARE(doc.composite().pixelColor(0, 0), QColor(Qt::white));
    doc.undo();
    QCOMPARE(doc.composite().pixelColor(0, 0), QColor(Qt::red));
    canvas.paste(Document::allocate(QSize(5, 5), Qt::blue));
    canvas.cancel();
    QVERIFY(!doc.dirty());
}
void UiTests::selectionTransform() {
    Document doc(QSize(40, 30));
    Canvas canvas(doc);
    QImage image = Document::allocate(QSize(3, 2));
    image.setPixelColor(0, 0, Qt::red);
    canvas.paste(image);
    canvas.transformSelection(QTransform().rotate(90));
    canvas.settle();
    QCOMPARE(doc.composite().pixelColor(1, 0), QColor(Qt::red));
    canvas.selectAll();
    const auto revision = doc.revision();
    QVERIFY_THROWS_EXCEPTION(std::runtime_error,
                             canvas.transformSelection(QTransform().scale(100000, 100000)));
    QCOMPARE(doc.revision(), revision);
    QVERIFY(canvas.hasSelection());
    canvas.cancel();
    canvas.transformSelection(QTransform().rotate(90));
    QCOMPARE(doc.state().size, QSize(30, 40));
    doc.undo();
    QCOMPARE(doc.state().size, QSize(40, 30));
}
void UiTests::singleEdgeCanvasResize() {
    Document doc(QSize(80, 60));
    Canvas canvas(doc);
    canvas.show();
    QTest::mousePress(&canvas, Qt::LeftButton, {}, QPoint(82, 15));
    QTest::mouseMove(&canvas, QPoint(50, 20));
    QTest::mouseRelease(&canvas, Qt::LeftButton, {}, QPoint(50, 20));
    QCOMPARE(doc.state().size, QSize(50, 60));
    doc.undo();
    canvas.refresh();
    QTest::mousePress(&canvas, Qt::LeftButton, {}, QPoint(12, 62));
    QTest::mouseMove(&canvas, QPoint(20, 35));
    QTest::mouseRelease(&canvas, Qt::LeftButton, {}, QPoint(20, 35));
    QCOMPARE(doc.state().size, QSize(80, 35));
}
void UiTests::panDoesNotEdit() {
    Document doc(QSize(80, 60));
    Canvas canvas(doc);
    canvas.show();
    QTest::mousePress(&canvas, Qt::MiddleButton, {}, QPoint(5, 5));
    QTest::mouseMove(&canvas, QPoint(30, 30));
    QTest::mouseRelease(&canvas, Qt::MiddleButton, {}, QPoint(30, 30));
    QVERIFY(!doc.dirty());
    QVERIFY(!canvas.hasPendingEdit());
}
void UiTests::shapes_data() {
    QTest::addColumn<int>("tool");
    for (Tool tool : {Tool::Line, Tool::Rectangle, Tool::RoundRectangle, Tool::Ellipse})
        QTest::newRow(qPrintable(QString::number(int(tool)))) << int(tool);
}
void UiTests::shapes() {
    QFETCH(int, tool);
    Document doc(QSize(80, 60));
    Canvas canvas(doc);
    canvas.show();
    canvas.setTool(Tool(tool));
    QTest::mousePress(&canvas, Qt::LeftButton, {}, QPoint(10, 10));
    QTest::mouseMove(&canvas, QPoint(50, 40));
    QTest::mouseRelease(&canvas, Qt::LeftButton, {}, QPoint(50, 40));
    QVERIFY(doc.dirty());
    doc.undo();
    QCOMPARE(doc.composite(), Document::blank(QSize(80, 60)).layers[0].image);
}
void UiTests::curveAndPolygon() {
    Document doc(QSize(80, 60));
    Canvas canvas(doc);
    canvas.show();
    canvas.setTool(Tool::Curve);
    QTest::mousePress(&canvas, Qt::LeftButton, {}, QPoint(5, 10));
    QTest::mouseMove(&canvas, QPoint(60, 10));
    QTest::mouseRelease(&canvas, Qt::LeftButton, {}, QPoint(60, 10));
    QVERIFY(!doc.dirty());
    QTest::mouseClick(&canvas, Qt::LeftButton, {}, QPoint(20, 40));
    QTest::mouseClick(&canvas, Qt::LeftButton, {}, QPoint(40, 40));
    QVERIFY(doc.dirty());
    doc.undo();
    canvas.refresh();
    canvas.setTool(Tool::Polygon);
    for (QPoint point : {QPoint(10, 10), QPoint(50, 10), QPoint(30, 40)})
        QTest::mouseClick(&canvas, Qt::LeftButton, {}, point);
    QTest::keyClick(&canvas, Qt::Key_Return);
    QVERIFY(doc.dirty());
    QVERIFY(!canvas.hasPendingEdit());
}
void UiTests::fillAndHiddenLayer() {
    Document doc(QSize(80, 60));
    auto state = doc.state();
    state.layers[0].visible = false;
    doc.reset(state);
    Canvas canvas(doc);
    canvas.show();
    canvas.setTool(Tool::Fill);
    canvas.foreground = Qt::green;
    QTest::mouseClick(&canvas, Qt::LeftButton, {}, QPoint(10, 10));
    QVERIFY(doc.state().layers[0].visible);
    QCOMPARE(doc.composite().pixelColor(79, 59), QColor(Qt::green));
    doc.undo();
    QVERIFY(!doc.state().layers[0].visible);
}
void UiTests::koreanTextCommit() {
    Document doc(QSize(400, 200));
    Canvas canvas(doc);
    canvas.show();
    canvas.setTool(Tool::Text);
    QTest::mouseClick(&canvas, Qt::LeftButton, {}, QPoint(10, 10));
    auto *editor = canvas.findChild<QTextEdit *>();
    QVERIFY(editor);
    QInputMethodEvent input;
    input.setCommitString(QStringLiteral("한글 테스트 ABC"));
    QApplication::sendEvent(editor, &input);
    QCOMPARE(editor->toPlainText(), QStringLiteral("한글 테스트 ABC"));
    canvas.settle();
    QVERIFY(doc.dirty());
    doc.undo();
    QVERIFY(!doc.dirty());
}
void UiTests::clipboardRoundTrip() {
    Document doc(QSize(30, 20));
    Canvas canvas(doc);
    QImage image = Document::allocate(QSize(10, 8), Qt::red);
    QApplication::clipboard()->setImage(image);
    canvas.paste(QApplication::clipboard()->image());
    canvas.copy(false);
    QCOMPARE(QApplication::clipboard()->image(), image);
    canvas.settle();
    QCOMPARE(doc.composite().pixelColor(5, 5), QColor(Qt::red));
}
void UiTests::layerSwitchSettlesPaste() {
    MainWindow window;
    auto &doc = window.document();
    auto state = doc.state();
    state.layers.push_back({"top", Document::allocate(state.size), true});
    doc.reset(state);
    window.canvasWidget()->refresh();
    window.canvasWidget()->paste(Document::allocate(QSize(10, 10), Qt::red));
    auto *list = window.findChild<QListWidget *>();
    QVERIFY(list);
    list->setCurrentRow(1);
    QCOMPARE(doc.state().active, 1);
    QVERIFY(!window.canvasWidget()->hasSelection());
    QCOMPARE(doc.state().layers[0].image.pixelColor(0, 0), QColor(Qt::red));
    QCOMPARE(doc.state().layers[1].image.pixelColor(0, 0).alpha(), 0);
    auto *dock = window.findChild<QDockWidget *>();
    dock->show();
    dock->hide();
    QCOMPARE(doc.state().layers.size(), 2);
    doc.markSaved();
}
void UiTests::badOpenPreservesWork() {
    MainWindow window;
    window.canvasWidget()->paste(Document::allocate(QSize(5, 5), Qt::red));
    const auto revision = window.document().revision();
    QTemporaryDir dir;
    QFile file(dir.filePath("broken.rpaint"));
    QVERIFY(file.open(QIODevice::WriteOnly));
    file.write("bad");
    file.close();
    QVERIFY_THROWS_EXCEPTION(std::runtime_error, window.openFile(file.fileName()));
    QCOMPARE(window.document().revision(), revision);
    QVERIFY(window.canvasWidget()->hasSelection());
    window.canvasWidget()->cancel();
}
void UiTests::zoomedRenderIsBounded() {
    Document doc(QSize(2048, 2048));
    Canvas canvas(doc);
    canvas.setZoom(16);
    canvas.grid = true;
    QPixmap target(300, 200);
    QElapsedTimer timer;
    timer.start();
    canvas.render(&target, QPoint(), QRegion(0, 0, 300, 200));
    QVERIFY2(timer.elapsed() < 5000, "A small viewport must not iterate the entire zoomed canvas");
}
void UiTests::brushEraserAndPicker() {
    Document doc(QSize(60, 40));
    Canvas canvas(doc);
    canvas.show();
    canvas.setTool(Tool::Brush);
    canvas.thickness = 7;
    canvas.foreground = Qt::red;
    QTest::mouseClick(&canvas, Qt::LeftButton, {}, QPoint(20, 20));
    QCOMPARE(doc.composite().pixelColor(20, 20), QColor(Qt::red));
    canvas.setTool(Tool::Picker);
    QSignalSpy spy(&canvas, &Canvas::colorPicked);
    QTest::mouseClick(&canvas, Qt::LeftButton, {}, QPoint(20, 20));
    QCOMPARE(spy.size(), 1);
    QCOMPARE(qvariant_cast<QColor>(spy[0][0]), QColor(Qt::red));
    canvas.setTool(Tool::ColorEraser);
    canvas.background = Qt::blue;
    QTest::mouseClick(&canvas, Qt::LeftButton, {}, QPoint(20, 20));
    QCOMPARE(doc.composite().pixelColor(20, 20), QColor(Qt::blue));
    canvas.setTool(Tool::Eraser);
    canvas.background = Qt::white;
    QTest::mouseClick(&canvas, Qt::LeftButton, {}, QPoint(20, 20));
    QCOMPARE(doc.composite().pixelColor(20, 20), QColor(Qt::white));
}
void UiTests::freeSelectionKeepsOutsidePixels() {
    Document doc(QSize(60, 40));
    auto state = doc.state();
    state.layers[0].image.fill(Qt::red);
    doc.reset(state);
    Canvas canvas(doc);
    canvas.show();
    canvas.setTool(Tool::FreeSelect);
    QTest::mousePress(&canvas, Qt::LeftButton, {}, QPoint(5, 5));
    QTest::mouseMove(&canvas, QPoint(30, 5));
    QTest::mouseMove(&canvas, QPoint(5, 30));
    QTest::mouseRelease(&canvas, Qt::LeftButton, {}, QPoint(5, 30));
    QVERIFY(canvas.hasSelection());
    canvas.removeSelection();
    QCOMPARE(doc.composite().pixelColor(8, 8), QColor(Qt::white));
    QCOMPARE(doc.composite().pixelColor(28, 28), QColor(Qt::red));
    doc.undo();
    QCOMPARE(doc.state().layers[0].image, state.layers[0].image);
}
void UiTests::lostMouseGrabStopsSpray() {
    Document doc(QSize(80, 60));
    Canvas canvas(doc);
    canvas.show();
    canvas.setTool(Tool::Spray);
    QTest::mousePress(&canvas, Qt::LeftButton, {}, QPoint(10, 10));
    QEvent event(QEvent::UngrabMouse);
    QApplication::sendEvent(&canvas, &event);
    QTest::qWait(60);
    QVERIFY(!canvas.hasPendingEdit());
    QVERIFY(!doc.dirty());
    QTest::mouseRelease(&canvas, Qt::LeftButton, {}, QPoint(10, 10));
}
void UiTests::closeCancelKeepsDocument() {
    MainWindow window;
    window.show();
    window.canvasWidget()->paste(Document::allocate(QSize(5, 5), Qt::red));
    window.canvasWidget()->settle();
    const auto revision = window.document().revision();
    QTimer::singleShot(0, [] {
        auto *dialog = qobject_cast<QMessageBox *>(QApplication::activeModalWidget());
        QVERIFY(dialog);
        dialog->button(QMessageBox::Cancel)->click();
    });
    QVERIFY(!window.close());
    QCOMPARE(window.document().revision(), revision);
    QVERIFY(window.document().dirty());
    window.document().markSaved();
}
void UiTests::damagedRecoveryIsPreserved() {
    MainWindow window;
    const QString path =
        QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation) + "/recovery.rpaint";
    QFile file(path);
    QVERIFY(file.open(QIODevice::WriteOnly));
    file.write("broken-backup");
    file.close();
    QTimer::singleShot(0, [] {
        auto *dialog = qobject_cast<QMessageBox *>(QApplication::activeModalWidget());
        QVERIFY(dialog);
        dialog->button(QMessageBox::Yes)->click();
    });
    QVERIFY_THROWS_EXCEPTION(std::runtime_error, window.checkRecovery());
    QVERIFY(window.close());
    QVERIFY(file.open(QIODevice::ReadOnly));
    QCOMPARE(file.readAll(), QByteArray("broken-backup"));
    file.close();
    QVERIFY(file.remove());
}
void UiTests::hiddenSingleLayerRequiresProjectSave() {
    MainWindow window;
    QTemporaryDir directory;
    auto state = window.document().state();
    state.layers[0].visible = false;
    window.document().commit(state, "hide");
    const QString original = directory.filePath("original.png");
    window.document().path = original;
    bool dialogSeen = false;
    QTimer::singleShot(0, [&] {
        auto *dialog = qobject_cast<QFileDialog *>(QApplication::activeModalWidget());
        QVERIFY(dialog);
        dialogSeen = true;
        const auto selected = dialog->selectedNameFilter();
        dialog->reject();
        QCOMPARE(selected, QStringLiteral("RetroPaint (*.rpaint)"));
    });
    for (auto *action : window.findChildren<QAction *>())
        if (action->text() == QStringLiteral("저장")) {
            action->trigger();
            break;
        }
    QVERIFY(dialogSeen);
    QVERIFY(window.document().dirty());
    QCOMPARE(window.document().path, original);
    QVERIFY(!QFile::exists(original));
    window.document().markSaved();
}
void UiTests::discardedDocumentClearsOldRecovery() {
    MainWindow window;
    window.canvasWidget()->paste(Document::allocate(QSize(5, 5), Qt::red));
    window.canvasWidget()->settle();
    const QString backup =
        QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation) + "/recovery.rpaint";
    Document::writeProject(window.document().state(), backup);
    QTimer::singleShot(0, [] {
        auto *dialog = qobject_cast<QMessageBox *>(QApplication::activeModalWidget());
        QVERIFY(dialog);
        dialog->button(QMessageBox::Discard)->click();
    });
    for (auto *action : window.findChildren<QAction *>())
        if (action->text() == QStringLiteral("새 그림")) {
            action->trigger();
            break;
        }
    QVERIFY(!window.document().dirty());
    QVERIFY(!QFile::exists(backup));
}
void UiTests::smoothBrushEndpointsAndUndo() {
    Document doc(QSize(100, 60));
    Canvas canvas(doc);
    canvas.show();
    canvas.setTool(Tool::Brush);
    canvas.foreground = Qt::red;
    canvas.thickness = 6;
    canvas.brushStabilization = 65;
    QTest::mousePress(&canvas, Qt::LeftButton, {}, {10, 10});
    for (const auto &point : {QPoint(30, 5), QPoint(50, 25), QPoint(70, 15)})
        QTest::mouseMove(&canvas, point);
    QTest::mouseRelease(&canvas, Qt::LeftButton, {}, {80, 30});
    const QImage result = doc.state().layers[0].image;
    QCOMPARE(result.pixelColor(10, 10), QColor(Qt::red));
    QCOMPARE(result.pixelColor(80, 30), QColor(Qt::red));
    doc.undo();
    QCOMPARE(doc.state().layers[0].image.pixelColor(40, 15), QColor(Qt::white));
    QVERIFY(!doc.canUndo());
    doc.redo();
    QCOMPARE(doc.state().layers[0].image, result);
    const auto revision = doc.revision();
    QTest::mousePress(&canvas, Qt::LeftButton, {}, {15, 45});
    QTest::mouseMove(&canvas, {70, 45});
    QTest::keyClick(&canvas, Qt::Key_Escape);
    QCOMPARE(doc.revision(), revision);
    QCOMPARE(doc.state().layers[0].image, result);
}
void UiTests::brushOpacityAndSoftness() {
    Document doc(QSize(60, 40));
    State blank = doc.state();
    blank.layers[0].image.fill(Qt::transparent);
    doc.reset(blank);
    Canvas canvas(doc);
    canvas.show();
    canvas.setTool(Tool::Brush);
    canvas.foreground = Qt::red;
    canvas.thickness = 10;
    canvas.brushOpacity = 50;
    canvas.brushStabilization = 0;
    QTest::mousePress(&canvas, Qt::LeftButton, {}, {10, 20});
    QTest::mouseMove(&canvas, {40, 20});
    QTest::mouseMove(&canvas, {10, 20});
    QTest::mouseRelease(&canvas, Qt::LeftButton, {}, {40, 20});
    const auto ink = doc.state().layers[0].image.pixelColor(25, 20);
    QCOMPARE(ink.red(), 255);
    QCOMPARE(ink.alpha(), 128);
    doc.reset(blank);
    canvas.refresh();
    canvas.brushHardness = 0;
    QTest::mouseClick(&canvas, Qt::LeftButton, {}, {30, 20});
    const QImage soft = doc.state().layers[0].image;
    QVERIFY(soft.pixelColor(30, 20).alpha() > soft.pixelColor(34, 20).alpha());
    QVERIFY(soft.pixelColor(34, 20).alpha() > 0);
    doc.reset(blank);
    canvas.refresh();
    canvas.brushOpacity = 0;
    QTest::mouseClick(&canvas, Qt::LeftButton, {}, {30, 20});
    QVERIFY(!doc.dirty());
}
void UiTests::fractionalBrushInput() {
    Document doc(QSize(40, 40));
    Canvas canvas(doc);
    canvas.show();
    canvas.setTool(Tool::Brush);
    canvas.thickness = 1;
    canvas.brushStabilization = 0;
    QVector<QImage> results;
    const State blank = doc.state();
    for (qreal coordinate : {20.1, 20.9}) {
        doc.reset(blank);
        canvas.refresh();
        const QPointF position(coordinate, coordinate);
        QMouseEvent press(QEvent::MouseButtonPress, position, position, Qt::LeftButton, Qt::LeftButton,
                          Qt::NoModifier);
        QApplication::sendEvent(&canvas, &press);
        QMouseEvent release(QEvent::MouseButtonRelease, position, position, Qt::LeftButton, Qt::NoButton,
                            Qt::NoModifier);
        QApplication::sendEvent(&canvas, &release);
        results.push_back(doc.state().layers[0].image);
    }
    QVERIFY(results[0] != results[1]);
}
void UiTests::tabletPressureOwnsItsStroke() {
    Document doc(QSize(90, 80));
    Canvas canvas(doc);
    canvas.show();
    canvas.setTool(Tool::Brush);
    canvas.foreground = Qt::red;
    canvas.thickness = 20;
    canvas.brushStabilization = 0;
    QPointingDevice pen(QStringLiteral("test pen"), 42, QInputDevice::DeviceType::Stylus,
                        QPointingDevice::PointerType::Pen,
                        QInputDevice::Capability::Position | QInputDevice::Capability::Pressure, 1, 1);
    for (int stroke = 0; stroke < 2; ++stroke) {
        const qreal pressure = stroke ? 1.0 : 0.1;
        const int y = stroke ? 55 : 20;
        for (const auto type : {QEvent::TabletPress, QEvent::TabletMove, QEvent::TabletRelease}) {
            const QPointF position(type == QEvent::TabletPress ? 15 : 65, y);
            QTabletEvent event(type, &pen, position, position, pressure, 0, 0, 0, 0, 0, Qt::NoModifier,
                               type == QEvent::TabletMove ? Qt::NoButton : Qt::LeftButton,
                               type == QEvent::TabletRelease ? Qt::NoButton : Qt::LeftButton);
            QApplication::sendEvent(&canvas, &event);
            if (type == QEvent::TabletPress) {
                QTest::mouseRelease(&canvas, Qt::LeftButton, {}, {85, 75});
                QVERIFY(canvas.hasActiveGesture());
            }
        }
    }
    int narrow = 0, wide = 0;
    const QImage image = doc.state().layers[0].image;
    for (int y = 0; y < 80; ++y) {
        if (image.pixelColor(40, y) != QColor(Qt::white)) {
            if (y < 38)
                ++narrow;
            else
                ++wide;
        }
    }
    QVERIFY(wide > narrow * 2);
    QCOMPARE(image.pixelColor(85, 75), QColor(Qt::white));
    doc.undo();
    QCOMPARE(doc.state().layers[0].image.pixelColor(40, 55), QColor(Qt::white));
    QVERIFY(doc.state().layers[0].image.pixelColor(40, 20) != QColor(Qt::white));
}
void UiTests::studioColorControls() {
    MainWindow window;
    window.show();
    auto *field = window.findChild<QLineEdit *>(QStringLiteral("hexColor"));
    QVERIFY(field);
    const auto revision = window.document().revision();
    field->setText(QStringLiteral("#1679ea"));
    QVERIFY(QMetaObject::invokeMethod(field, "editingFinished"));
    QCOMPARE(window.canvasWidget()->foreground, QColor("#1679ea"));
    QCOMPARE(window.document().revision(), revision);
    field->setText(QStringLiteral("broken"));
    QVERIFY(QMetaObject::invokeMethod(field, "editingFinished"));
    QCOMPARE(window.canvasWidget()->foreground, QColor("#1679ea"));
    auto *picker = window.findChild<ColorPicker *>();
    QVERIFY(picker);
    QSignalSpy picked(picker, &ColorPicker::colorChanged);
    QTest::mouseClick(picker, Qt::LeftButton, {}, picker->rect().center() + QPoint(15, -15));
    QCOMPARE(picked.count(), 1);
    QTest::mousePress(picker, Qt::LeftButton, {}, picker->rect().center());
    QEvent lost(QEvent::UngrabMouse);
    QApplication::sendEvent(picker, &lost);
    const auto selected = window.canvasWidget()->foreground;
    QMouseEvent move(QEvent::MouseMove, QPointF(10, 10), QPointF(10, 10), Qt::NoButton, Qt::NoButton,
                     Qt::NoModifier);
    QApplication::sendEvent(picker, &move);
    QCOMPARE(window.canvasWidget()->foreground, selected);
    QCOMPARE(field->text(), window.canvasWidget()->foreground.name());
    QCOMPARE(window.document().revision(), revision);
}
QTEST_MAIN(UiTests)
#include "ui_tests.moc"
