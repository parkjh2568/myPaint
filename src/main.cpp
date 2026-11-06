#include "mainwindow.h"
#include <QApplication>
#include <QDir>
#include <QLockFile>
#include <QMessageBox>
#include <QPainter>
#include <QStandardPaths>
#include <QStyleFactory>
#include <QTimer>
#include <cstdio>
#include <functional>

class PaintApplication : public QApplication {
  public:
    using QApplication::QApplication;
    std::function<void()> recover;
    bool notify(QObject *receiver, QEvent *event) override {
        try {
            return QApplication::notify(receiver, event);
        } catch (const std::exception &error) {
            // Abort failed gestures without discarding a pending selection or text.
            if (reporting)
                return false;
            reporting = true;
            try {
                if (recover)
                    recover();
                QMessageBox::warning(nullptr, QStringLiteral("작업 실패"), QString::fromUtf8(error.what()));
            } catch (...) {
                std::fprintf(stderr, "RetroPaint: insufficient resources to report an error\n");
            }
            reporting = false;
            return false;
        }
    }

  private:
    bool reporting = false;
};
int main(int argc, char **argv) {
    PaintApplication app(argc, argv);
    app.setApplicationName(QStringLiteral("RetroPaint"));
    app.setOrganizationName(QStringLiteral("RetroPaint"));
    app.setApplicationVersion(QStringLiteral("0.1.0"));
    const bool smoke = app.arguments().contains(QStringLiteral("--smoke"));
    if (smoke)
        QStandardPaths::setTestModeEnabled(true);
    const QString data = QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation);
    if (data.isEmpty() || !QDir().mkpath(data)) {
        QMessageBox::warning(nullptr, QStringLiteral("RetroPaint"),
                             QStringLiteral("작업 폴더를 만들 수 없습니다. 저장 공간과 권한을 확인하세요."));
        return 1;
    }
    QLockFile lock(data + QStringLiteral("/session.lock"));
    lock.setStaleLockTime(0);
    if (!lock.tryLock(0)) {
        QMessageBox::information(nullptr, QStringLiteral("RetroPaint"),
                                 QStringLiteral("이미 실행 중이거나 작업 폴더에 접근할 수 없습니다."));
        return 1;
    }
    app.setStyle(QStyleFactory::create(QStringLiteral("Fusion")));

    try {
        paint::MainWindow window;
        app.recover = [&window] { window.recoverAfterError(); };
        window.show();
        QTimer::singleShot(0, &window, [&] {
            try {
                if (smoke) {
                    paint::State candidate = window.document().state();
                    QPainter p(&candidate.layers[0].image);
                    p.setPen(QPen(Qt::blue, 5));
                    p.drawRect(70, 80, 340, 220);
                    p.drawText(90, 130, QStringLiteral("RetroPaint - Offline"));
                    p.end();
                    window.document().commit(std::move(candidate), QStringLiteral("Smoke"));
                    window.canvasWidget()->refresh();
                    window.canvasWidget()->paste(window.document().composite().copy(70, 80, 180, 110));
                    window.canvasWidget()->settle();
                    window.document().undo();
                    window.document().redo();
                    if (const QString screenshot = qEnvironmentVariable("RETROPAINT_SCREENSHOT");
                        !screenshot.isEmpty())
                        window.grab().save(screenshot);
                    window.document().markSaved();
                    QTimer::singleShot(100, &window, &QWidget::close);
                } else {
                    window.checkRecovery();
                    if (app.arguments().size() > 1)
                        window.openFile(app.arguments()[1]);
                }
            } catch (const std::exception &error) {
                if (smoke) {
                    std::fprintf(stderr, "RetroPaint smoke: %s\n", error.what());
                    app.exit(1);
                } else {
                    try {
                        window.recoverAfterError();
                        QMessageBox::warning(&window, QStringLiteral("파일 열기 실패"),
                                             QString::fromUtf8(error.what()));
                    } catch (...) {
                        std::fprintf(stderr, "RetroPaint: unable to report file error\n");
                    }
                }
            }
        });
        const int result = app.exec();
        app.recover = {};
        return result;
    } catch (const std::exception &error) {
        app.recover = {};
        std::fprintf(stderr, "RetroPaint startup: %s\n", error.what());
        return 1;
    }
}
