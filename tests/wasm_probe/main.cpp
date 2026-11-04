#include "document.h"
#include <QApplication>
#include <QFontDatabase>
#include <QMainWindow>
#include <QMessageBox>
#include <QPushButton>
#include <QRawFont>
#include <QTimer>
#include <QVBoxLayout>
#include <emscripten.h>
#include <memory>
#include <stdexcept>

EM_JS(void, report, (int status, const char *message),
      { globalThis.retropaintProbe = {status, message : UTF8ToString(message)}; });

class ProbeWindow final : public QMainWindow {
  public:
    paint::Document document{QSize(64, 64)};
    ProbeWindow() {
        auto *panel = new QWidget(this);
        auto *layout = new QVBoxLayout(panel);
        auto *edit = new QPushButton(QString::fromUtf8("그리기 / Undo / Redo"), panel);
        auto *error = new QPushButton(QString::fromUtf8("예외 처리 시험"), panel);
        layout->addWidget(edit);
        layout->addWidget(error);
        setCentralWidget(panel);
        resize(600, 400);
        connect(edit, &QPushButton::clicked, this, [this] {
            try {
                auto candidate = document.state();
                candidate.layers[0].image.setPixelColor(1, 1, Qt::red);
                document.commit(std::move(candidate), "probe");
                document.undo();
                document.redo();
                if (document.state().layers[0].image.pixelColor(1, 1) != QColor(Qt::red))
                    throw std::runtime_error("Undo/Redo mismatch");
                report(2, "Qt input callback and editing OK");
            } catch (const std::exception &e) {
                report(-1, e.what());
            }
        });
        connect(error, &QPushButton::clicked, this, [this] {
            try {
                paint::Document::validateSize(QSize(0, 0));
                report(-2, "validation did not throw");
            } catch (const std::exception &) {
                auto *dialog = new QMessageBox(QMessageBox::Information, QString::fromUtf8("예외 처리"),
                                               QString::fromUtf8("오류 이후에도 편집할 수 있습니다."),
                                               QMessageBox::Ok, this);
                dialog->setAttribute(Qt::WA_DeleteOnClose);
                dialog->open();
                report(3, "Exception caught in Qt callback; nonblocking dialog opened");
            }
        });
    }
};
static std::unique_ptr<QApplication> application;
static std::unique_ptr<ProbeWindow> window;
int main(int argc, char **argv) {
    application = std::make_unique<QApplication>(argc, argv);
    const int fontId = QFontDatabase::addApplicationFont(":/NanumGothic.ttf");
    if (fontId < 0) {
        report(-4, "Korean font failed to load");
        return 1;
    }
    application->setFont(QFont(QFontDatabase::applicationFontFamilies(fontId).first(), 12));
    window = std::make_unique<ProbeWindow>();
    window->show();
    QTimer::singleShot(0, window.get(), [] {
        try {
            if (!QRawFont::fromFont(QApplication::font()).supportsCharacter(U'그'))
                throw std::runtime_error("Korean glyph missing");
            bool caught = false;
            try {
                paint::Document::validateSize(QSize());
            } catch (const std::exception &) {
                caught = true;
            }
            if (!caught)
                throw std::runtime_error("Exception support missing");
            auto candidate = window->document.state();
            candidate.layers[0].image.setPixelColor(2, 2, Qt::blue);
            window->document.commit(std::move(candidate), "selftest");
            window->document.undo();
            window->document.redo();
            paint::Document::writeProject(window->document.state(), "/tmp/probe.rpaint");
            auto loaded = paint::Document::readProject("/tmp/probe.rpaint");
            if (loaded.layers[0].image != window->document.state().layers[0].image)
                throw std::runtime_error("Project round trip mismatch");
            report(1, "Timer after main return, exception, edit, Undo/Redo and project round trip OK");
        } catch (const std::exception &e) {
            report(-3, e.what());
        }
    });
    return 0;
}
