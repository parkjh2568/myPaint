#include "mainwindow.h"
#include <QAbstractButton>
#include <QApplication>
#include <QComboBox>
#include <QDateTime>
#include <QDialogButtonBox>
#include <QFileInfo>
#include <QFormLayout>
#include <QGuiApplication>
#include <QInputMethod>
#include <QJsonArray>
#include <QLabel>
#include <QLineEdit>
#include <QStatusBar>
#include <QTimer>
#include <stdexcept>

namespace paint {
void MainWindow::startBrowserRequest(const QString &operation, QJsonObject options, const QByteArray &bytes) {
    if (fileWorkActive || browserDialogCount || QApplication::activeModalWidget())
        throw std::runtime_error("진행 중인 작업을 먼저 완료하세요.");
    if (++browserSerial == 0)
        throw std::runtime_error("브라우저 세션 요청 한도를 초과했습니다.");
    browserPending = browserSerial;
    browserOperation = operation;
    browserRequestEpoch = browserEpoch;
    browserRequestRevision = doc.revision();
    browserActive = doc.state().active;
    browserTextMode = options.value("textMode").toBool();
    browserTextCut = options.value("cut").toBool();
    fileWorkActive = true;
    setEnabled(false);
    try {
        browser->request(browserPending, operation, std::move(options), bytes);
    } catch (...) {
        browserPending = 0;
        fileWorkActive = false;
        browserCut.reset();
        setEnabled(true);
        throw;
    }
}
void MainWindow::chooseFile(bool insert, bool dropped) {
    QGuiApplication::inputMethod()->commit();
    // Validate pending IME/selection state before starting an asynchronous command.
    canvas->pendingState();
    startBrowserRequest(dropped ? QStringLiteral("drop") : QStringLiteral("open"), {{"imageOnly", insert}});
    browserTextMode = insert;
}
void MainWindow::requestReplacement(std::function<void()> continuation) {
    if (!doc.dirty() && (!canvas->hasPendingEdit() ||
                         !doc.prepare(canvas->pendingState(), QStringLiteral("편집 확인")).changed())) {
        continuation();
        return;
    }
    auto *dialog =
        new QMessageBox(QMessageBox::Question, QStringLiteral("현재 그림"),
                        QStringLiteral("현재 그림을 어떻게 처리할까요? 다운로드 후에도 현재 그림은 "
                                       "유지됩니다. 파일을 확인한 뒤 다시 열기를 선택하세요."),
                        QMessageBox::Save | QMessageBox::Discard | QMessageBox::Cancel, this);
    dialog->button(QMessageBox::Save)->setText(QStringLiteral("프로젝트 다운로드"));
    dialog->button(QMessageBox::Discard)->setText(QStringLiteral("버리고 계속"));
    dialog->setDefaultButton(QMessageBox::Save);
    const auto epoch = browserEpoch, revision = doc.revision();
    finishDialog(dialog, [this, epoch, revision, continuation = std::move(continuation)](int result) {
        if (epoch != browserEpoch || revision != doc.revision())
            throw std::runtime_error("대화상자를 연 문서가 변경되었습니다.");
        if (result == QMessageBox::Discard)
            continuation();
        else if (result == QMessageBox::Save)
            downloadBrowser("rpaint", false);
    });
}
void MainWindow::downloadBrowser(QByteArray format, bool chooseName) {
    if (chooseName || format.isEmpty()) {
        auto *dialog = new QDialog(this);
        dialog->setWindowTitle(QStringLiteral("파일 다운로드"));
        auto *layout = new QFormLayout(dialog);
        auto *name = new QLineEdit(QFileInfo(doc.path).completeBaseName(), dialog);
        if (name->text().isEmpty())
            name->setText(QStringLiteral("그림"));
        name->setMaxLength(256);
        name->setAccessibleName(QStringLiteral("파일 이름"));
        layout->addRow(QStringLiteral("파일 이름"), name);
        auto *formats = new QComboBox(dialog);
        formats->addItems(format.isEmpty() ? QStringList{"png", "jpg", "bmp"}
                                           : QStringList{QString::fromLatin1(format)});
        formats->setAccessibleName(QStringLiteral("파일 형식"));
        layout->addRow(QStringLiteral("형식"), formats);
        auto *buttons = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel, dialog);
        layout->addRow(buttons);
        connect(buttons, &QDialogButtonBox::accepted, dialog, &QDialog::accept);
        connect(buttons, &QDialogButtonBox::rejected, dialog, &QDialog::reject);
        finishDialog(dialog, [this, name, formats](int result) {
            if (result != QDialog::Accepted)
                return;
            QGuiApplication::inputMethod()->commit();
            const State candidate = canvas->pendingState();
            const QByteArray format = formats->currentText().toLatin1();
            QString filename = name->text().trimmed();
            filename.replace(QChar(92), QChar('_')).replace(QChar('/'), QChar('_')).remove(QChar(0));
            if (filename.isEmpty())
                throw std::runtime_error("파일 이름을 입력하세요.");
            const QString suffix = QStringLiteral(".") + QString::fromLatin1(format);
            if (!filename.endsWith(suffix, Qt::CaseInsensitive))
                filename += suffix;
            const auto bytes = format == "rpaint" ? Document::projectBytes(candidate)
                                                  : Document::imageBytes(candidate, format);
            startBrowserRequest(QStringLiteral("download"),
                                {{"name", filename},
                                 {"mime", format == "rpaint" ? "application/octet-stream"
                                          : format == "jpg"  ? "image/jpeg"
                                          : format == "bmp"  ? "image/bmp"
                                                             : "image/png"}},
                                bytes);
        });
        return;
    }
    QGuiApplication::inputMethod()->commit();
    const auto candidate = canvas->pendingState();
    QString name = QFileInfo(doc.path).completeBaseName();
    if (name.isEmpty())
        name = QStringLiteral("그림");
    const auto bytes = Document::projectBytes(candidate);
    startBrowserRequest(QStringLiteral("download"),
                        {{"name", name + QStringLiteral(".rpaint")}, {"mime", "application/octet-stream"}},
                        bytes);
}
void MainWindow::initializeBrowser() {
    doc.setHistoryBudget(32LL * 1024 * 1024);
    browser = new BrowserBridge(this);
    connect(browser, &BrowserBridge::fileDropped, this, [this] {
        if (!fileWorkActive && !browserDialogCount && !QApplication::activeModalWidget())
            run([this] { chooseFile(true, true); });
    });
    connect(canvas, &Canvas::clipboardWriteRequested, this, [this](QImage image, bool cut, State candidate) {
        run([&] {
            const State clipboardState{
                image.size(), Qt::transparent, {{QStringLiteral("복사"), image, true}}, 0};
            const auto bytes = Document::imageBytes(clipboardState, "png");
            browserCut = cut ? std::optional<State>(std::move(candidate)) : std::nullopt;
            startBrowserRequest(QStringLiteral("clipboardWrite"), {}, bytes);
        });
    });
    connect(canvas, &Canvas::clipboardTextWriteRequested, this, [this](const QString &text, bool cut) {
        run([&] {
            if (text.size() > 65536)
                throw std::runtime_error("문자 복사는 65536자 이내로 선택하세요.");
            startBrowserRequest(QStringLiteral("clipboardWrite"),
                                {{"textMode", true}, {"text", text}, {"cut", cut}});
        });
    });
    connect(canvas, &Canvas::clipboardReadRequested, this, [this](bool textMode) {
        run([&] { startBrowserRequest(QStringLiteral("clipboardRead"), {{"textMode", textMode}}); });
    });
    connect(
        browser, &BrowserBridge::completed, this,
        [this](quint32 id, const QJsonObject &result, const QByteArray &bytes) {
            if (id == 0) {
                if (!result.value("ok").toBool())
                    statusBar()->showMessage(result.value("error").toString());
                return;
            }
            if (id == recoveryPending) {
                recoveryPending = 0;
                if (recoveryEpoch != browserEpoch)
                    return;
                const bool saved = result.value("ok").toBool();
                if (saved)
                    recoveredRevision = recoveryWorkRevision;
                recoveryErrorShown = !saved;
                statusBar()->showMessage(saved
                                             ? QStringLiteral("브라우저 복구 사본 저장됨 (미확정 편집 제외)")
                                             : result.value("error").toString());
                sync();
                emit recoveryFinished(recoveryWorkRevision, saved);
                return;
            }
            if (id != browserPending)
                return;
            const auto operation = std::exchange(browserOperation, {});
            auto cut = std::move(browserCut);
            browserCut.reset();
            browserPending = 0;
            fileWorkActive = false;
            setEnabled(true);
            run([&] {
                if (browserRequestEpoch != browserEpoch || browserRequestRevision != doc.revision() ||
                    browserActive != doc.state().active)
                    throw std::runtime_error("작업을 시작한 문서가 변경되어 결과를 적용하지 않았습니다.");
                if (result.value("cancelled").toBool())
                    return;
                if (!result.value("ok").toBool())
                    throw std::runtime_error(result.value("error").toString().toStdString());
                if (operation == QStringLiteral("download")) {
                    statusBar()->showMessage(
                        QStringLiteral("상단 파일 받기를 눌러 다운로드하세요. 현재 편집은 유지됩니다."));
                } else if (operation == QStringLiteral("open") || operation == QStringLiteral("drop")) {
                    const QString name = result.value("name").toString();
                    State loaded = bytes.startsWith("RPAINT01") && !browserTextMode
                                       ? Document::readProjectBytes(bytes)
                                       : Document::readImageBytes(bytes);
                    if (browserTextMode) {
                        canvas->paste(loaded.layers.front().image);
                        return;
                    }
                    requestReplacement([this, name, loaded = std::move(loaded)]() mutable {
                        doc.reset(std::move(loaded), name);
                        clearRecovery();
                        canvas->cancel();
                        canvas->refresh();
                    });
                } else if (operation == QStringLiteral("clipboardWrite")) {
                    if (cut) {
                        doc.commit(std::move(*cut), QStringLiteral("잘라내기"));
                        canvas->cancel();
                    } else if (browserTextCut)
                        canvas->completeTextCut();
                    statusBar()->showMessage(QStringLiteral("클립보드 복사 완료"));
                } else if (operation == QStringLiteral("clipboardRead")) {
                    if (browserTextMode)
                        canvas->insertClipboardText(QString::fromUtf8(bytes));
                    else
                        canvas->paste(Document::readImageBytes(bytes).layers.front().image);
                } else if (operation == QStringLiteral("recover")) {
                    if (result.value("empty").toBool())
                        return;
                    if (result.contains("entries")) {
                        auto *dialog = new QDialog(this);
                        dialog->setWindowTitle(QStringLiteral("복구 사본 선택"));
                        auto *layout = new QFormLayout(dialog);
                        auto *entries = new QComboBox(dialog);
                        entries->setAccessibleName(QStringLiteral("복구 사본"));
                        entries->setMinimumWidth(420);
                        entries->setSizeAdjustPolicy(QComboBox::AdjustToMinimumContentsLengthWithIcon);
                        entries->setMinimumContentsLength(36);
                        for (const auto &value : result.value("entries").toArray()) {
                            const auto entry = value.toObject();
                            entries->addItem(
                                QStringLiteral("%1 · %2 · %3 KiB")
                                    .arg(QDateTime::fromMSecsSinceEpoch(qint64(entry.value("at").toDouble()))
                                             .toString(QStringLiteral("yyyy-MM-dd HH:mm:ss")),
                                         entry.value("name").toString())
                                    .arg(qint64(entry.value("size").toDouble()) / 1024),
                                entry.toVariantMap());
                        }
                        layout->addRow(new QLabel(
                            QStringLiteral("미확정 선택·문자는 복구 사본에 포함되지 않습니다."), dialog));
                        layout->addRow(entries);
                        auto *buttons =
                            new QDialogButtonBox(QDialogButtonBox::Open | QDialogButtonBox::Cancel, dialog);
                        layout->addRow(buttons);
                        connect(buttons, &QDialogButtonBox::accepted, dialog, &QDialog::accept);
                        connect(buttons, &QDialogButtonBox::rejected, dialog, &QDialog::reject);
                        finishDialog(dialog, [this, entries](int result) {
                            if (result == QDialog::Accepted)
                                startBrowserRequest(
                                    QStringLiteral("recover"),
                                    QJsonObject::fromVariantMap(entries->currentData().toMap()));
                        });
                        return;
                    }
                    preserveRecovery = true;
                    State loaded = Document::readProjectBytes(bytes);
                    requestReplacement([this, loaded = std::move(loaded)]() mutable {
                        doc.reset(std::move(loaded));
                        doc.markUnsaved();
                        clearRecovery();
                        canvas->cancel();
                        canvas->refresh();
                    });
                } else if (operation == QStringLiteral("clear")) {
                    preserveRecovery = recoveryErrorShown = false;
                    recoveredRevision = 0;
                    statusBar()->showMessage(QStringLiteral("브라우저 복구 사본을 비웠습니다."));
                }
            });
        },
        Qt::QueuedConnection);
    auto *timer = new QTimer(this);
    timer->setInterval(30000);
    timer->setObjectName(QStringLiteral("recoveryStart"));
    connect(timer, &QTimer::timeout, this, [this] {
        if (preserveRecovery || fileWorkActive || browserDialogCount || recoveryPending || !doc.dirty() ||
            recoveredRevision == doc.revision())
            return;
        try {
            const auto bytes = Document::projectBytes(doc.state());
            if (++browserSerial == 0)
                throw std::runtime_error("브라우저 세션 요청 한도입니다.");
            recoveryPending = browserSerial;
            recoveryEpoch = browserEpoch;
            recoveryWorkRevision = doc.revision();
            browser->request(
                recoveryPending, QStringLiteral("store"),
                {{"name", doc.path.isEmpty() ? QStringLiteral("제목 없음") : QFileInfo(doc.path).fileName()}},
                bytes);
        } catch (const std::exception &error) {
            recoveryPending = 0;
            recoveryErrorShown = true;
            statusBar()->showMessage(QString::fromUtf8(error.what()));
            sync();
        }
    });
    timer->start();
}
} // namespace paint
