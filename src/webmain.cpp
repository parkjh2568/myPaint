#include "mainwindow.h"
#include <QApplication>
#include <QFontDatabase>
#include <QStyleFactory>
#include <QTimer>
#include <cstdio>
#include <memory>

class WebApplication final : public QApplication {
  public:
    using QApplication::QApplication;
    paint::MainWindow *window = nullptr;
    bool reporting = false;
    bool notify(QObject *receiver, QEvent *event) override {
        try {
            return QApplication::notify(receiver, event);
        } catch (const std::exception &error) {
            if (reporting)
                return false;
            reporting = true;
            try {
                if (window)
                    window->recoverAfterError();
                auto *dialog = new QMessageBox(QMessageBox::Warning, QStringLiteral("작업 실패"),
                                               QString::fromUtf8(error.what()), QMessageBox::Ok, window);
                dialog->setAttribute(Qt::WA_DeleteOnClose);
                dialog->open();
            } catch (...) {
                std::fputs("RetroPaint: unable to report browser error\n", stderr);
            }
            reporting = false;
            return false;
        }
    }
};
static std::unique_ptr<WebApplication> application;
static std::unique_ptr<paint::MainWindow> window;
int main(int argc, char **argv) {
    try {
        application = std::make_unique<WebApplication>(argc, argv);
        application->setApplicationName(QStringLiteral("RetroPaint"));
        application->setStyle(QStyleFactory::create(QStringLiteral("Windows")));
        const int font = QFontDatabase::addApplicationFont(QStringLiteral(":/NanumGothic.ttf"));
        if (font < 0)
            throw std::runtime_error("한글 글꼴을 읽을 수 없습니다.");
        application->setFont(QFont(QFontDatabase::applicationFontFamilies(font).first(), 11));
        QPalette palette;
        palette.setColor(QPalette::Window, QColor(192, 192, 192));
        palette.setColor(QPalette::Button, QColor(192, 192, 192));
        palette.setColor(QPalette::Base, Qt::white);
        palette.setColor(QPalette::WindowText, Qt::black);
        palette.setColor(QPalette::Text, Qt::black);
        palette.setColor(QPalette::Highlight, QColor(0, 0, 128));
        palette.setColor(QPalette::HighlightedText, Qt::white);
        application->setPalette(palette);
        window = std::make_unique<paint::MainWindow>();
        application->window = window.get();
        window->show();
        QTimer::singleShot(0, window.get(), [] {
            try {
                window->checkRecovery();
            } catch (const std::exception &error) {
                std::fputs(error.what(), stderr);
            }
        });
    } catch (const std::exception &error) {
        std::fputs(error.what(), stderr);
        return 1;
    }
    return 0;
}
