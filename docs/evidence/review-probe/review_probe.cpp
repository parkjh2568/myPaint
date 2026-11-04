// Diagnostic observations for the 2026-11-03 review; not a passing regression suite.
// Run in an isolated test data directory, never against a user's recovery files.
#include "mainwindow.h"
#include <QAction>
#include <QApplication>
#include <QClipboard>
#include <QFileDialog>
#include <QListWidget>
#include <QMessageBox>
#include <QPushButton>
#include <QStandardPaths>
#include <QTemporaryDir>
#include <QTextEdit>
#include <QtTest>
#include <cstdio>

using namespace paint;

int main(int argc, char **argv) {
    QApplication app(argc, argv);
    app.setApplicationName("RetroPaint-review-probe");
    app.setOrganizationName("RetroPaint-review-probe");
    QStandardPaths::setTestModeEnabled(true);

    {
        Document doc(QSize(40, 30));
        auto state = doc.state();
        state.layers[0].name = "same";
        state.layers.push_back({"same", Document::allocate(state.size, Qt::red), true});
        doc.reset(state);
        state = doc.state();
        state.layers.swapItemsAt(0, 1);
        state.active = 1;
        doc.commit(state, "reorder");
        doc.undo();
        std::printf("R01 reorder undo active: expected=0 actual=%d\n", doc.state().active);
    }
    {
        Document doc(QSize(80, 60));
        Canvas canvas(doc);
        canvas.show();
        canvas.paste(Document::allocate(QSize(20, 20), Qt::red));
        QTest::mousePress(&canvas, Qt::LeftButton, {}, QPoint(19, 19));
        QTest::mouseMove(&canvas, QPoint(29, 24));
        QTest::mouseRelease(&canvas, Qt::LeftButton, {}, QPoint(29, 24));
        canvas.copy(false);
        const auto copied = app.clipboard()->image();
        std::printf("R02 resized copy: expected=30x25 actual=%dx%d\n", copied.width(), copied.height());
        canvas.transformSelection(QTransform().rotate(90));
        canvas.copy(false);
        const auto rotated = app.clipboard()->image();
        std::printf("R03 resized rotate: expected=25x30 actual=%dx%d\n", rotated.width(), rotated.height());
    }
    {
        MainWindow window;
        window.show();
        auto *canvas = window.canvasWidget();
        QAction *undo = nullptr;
        for (auto *action : window.findChildren<QAction *>())
            if (action->shortcut() == QKeySequence(QKeySequence::Undo))
                undo = action;
        QTest::mousePress(canvas, Qt::LeftButton, {}, QPoint(10, 10));
        std::printf("R04 pending stroke undo enabled: expected=1 actual=%d pending=%d\n",
                    undo && undo->isEnabled(), canvas->hasPendingEdit());
        canvas->cancel();
        canvas->setTool(Tool::Text);
        QTest::mouseClick(canvas, Qt::LeftButton, {}, QPoint(10, 10));
        auto *editor = canvas->findChild<QTextEdit *>();
        editor->setPlainText("pending text");
        std::printf("R05 pending text undo enabled: expected=1 actual=%d pending=%d\n",
                    undo && undo->isEnabled(), canvas->hasPendingEdit());
        canvas->cancel();
    }
    {
        Document doc(QSize(40, 30));
        Canvas canvas(doc);
        canvas.show();
        canvas.paste(Document::allocate(QSize(20, 20), Qt::red));
        for (int i = 0; i < 8; ++i)
            QTest::keyClick(&canvas, Qt::Key_Right, Qt::ShiftModifier);
        std::printf("R06 moved selection widget width: expected>=110 actual=%d\n", canvas.width());
        canvas.cancel();
    }
    {
        MainWindow window;
        window.show();
        auto *canvas = window.canvasWidget();
        canvas->paste(Document::allocate(QSize(5, 5), Qt::red));
        QTimer::singleShot(0, [] {
            if (auto *dialog = qobject_cast<QFileDialog *>(QApplication::activeModalWidget()))
                dialog->reject();
        });
        const auto revision = window.document().revision();
        for (auto *action : window.findChildren<QAction *>())
            if (action->text() == QStringLiteral("저장")) {
                action->trigger();
                break;
            }
        std::printf(
            "R07 cancelled save pending preserved: expected=1 actual=%d revision_before=%llu after=%llu\n",
            canvas->hasSelection(), static_cast<unsigned long long>(revision),
            static_cast<unsigned long long>(window.document().revision()));
        window.document().markSaved();
    }
    {
        Document doc(QSize(40, 30));
        Canvas canvas(doc);
        canvas.show();
        canvas.setTool(Tool::Line);
        QTest::mousePress(&canvas, Qt::LeftButton, {}, QPoint(5, 5));
        QTest::mouseMove(&canvas, QPoint(30, 20), 1);
        QTest::mouseRelease(&canvas, Qt::LeftButton, Qt::ShiftModifier, QPoint(30, 20));
        const auto image = doc.composite();
        std::printf("R08 shift release endpoint: unconstrained_pixel_is_dark=%d\n",
                    image.pixelColor(30, 20) != QColor(Qt::white));
    }
    {
        MainWindow window;
        auto *list = window.findChild<QListWidget *>();
        list->item(0)->setCheckState(Qt::Unchecked);
        std::printf("R09 visibility toggle survived: visible=%d\n",
                    window.document().state().layers[0].visible);
        window.document().markSaved();
    }
    {
        Document doc(QSize(20, 20));
        auto state = Document::blank(QSize(20, 20), Qt::red);
        state.layers.push_back({"top", Document::allocate(state.size, Qt::blue), true});
        doc.reset(state);
        Canvas canvas(doc);
        canvas.copy(true);
        const auto copied = app.clipboard()->image();
        std::printf("R10 cut without selection: clipboard_is_active_red=%d clipboard_is_composite_blue=%d\n",
                    copied.pixelColor(0, 0) == QColor(Qt::red), copied.pixelColor(0, 0) == QColor(Qt::blue));
    }
    {
        Document doc(QSize(40, 30));
        Canvas canvas(doc);
        canvas.show();
        canvas.foreground = Qt::red;
        QTest::mousePress(&canvas, Qt::LeftButton, {}, QPoint(5, 5));
        QTest::mouseMove(&canvas, QPoint(10, 5));
        QTest::mousePress(&canvas, Qt::MiddleButton, {}, QPoint(10, 5));
        QTest::mouseRelease(&canvas, Qt::MiddleButton, {}, QPoint(10, 5));
        QTest::mouseRelease(&canvas, Qt::LeftButton, {}, QPoint(10, 5));
        std::printf("R11 pan during stroke: drawn_pixel_preserved=%d pending=%d\n",
                    doc.composite().pixelColor(5, 5) == QColor(Qt::red), canvas.hasPendingEdit());
    }
    {
        Document doc(QSize(2, 2));
        auto state = doc.state();
        state.layers[0].image.setPixelColor(0, 0, Qt::red);
        doc.commit(state, "pixel");
        std::printf("R12 history accounting: patch_bytes=%lld sizeof_Change=%zu sizeof_Patch=%zu\n",
                    static_cast<long long>(doc.historyBytes()), sizeof(Change), sizeof(Patch));
    }
    return 0;
}
