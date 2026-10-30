#include "mainwindow.h"
#include <QAction>
#include <QClipboard>
#include <QDockWidget>
#include <QFileDialog>
#include <QInputMethodEvent>
#include <QListWidget>
#include <QMessageBox>
#include <QPushButton>
#include <QStandardPaths>
#include <QTemporaryDir>
#include <QTextEdit>
#include <QtTest>

using namespace paint;
class UiTests : public QObject {
    Q_OBJECT
  private slots:
    void initTestCase();
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
    QVERIFY_EXCEPTION_THROWN(canvas.transformSelection(QTransform().scale(100000, 100000)),
                             std::runtime_error);
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
    QVERIFY_EXCEPTION_THROWN(window.openFile(file.fileName()), std::runtime_error);
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
    QVERIFY_EXCEPTION_THROWN(window.checkRecovery(), std::runtime_error);
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
QTEST_MAIN(UiTests)
#include "ui_tests.moc"
