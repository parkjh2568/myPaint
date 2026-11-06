#pragma once
#include "canvas.h"
#include <QKeySequence>
#include <QMainWindow>
#include <QMessageBox>
#ifdef Q_OS_WASM
#include "browserbridge.h"
#include <optional>
#endif
#include <atomic>
#include <functional>
#include <future>
class QDialog;
class QAction;
class QLabel;
class QDockWidget;
class QListWidget;
class QScrollArea;
class QMenu;
class QPushButton;
class QLineEdit;
class QSpinBox;
namespace paint {
class ColorPicker;
class MainWindow : public QMainWindow {
    Q_OBJECT
  public:
    MainWindow();
    ~MainWindow() override;
    void openFile(const QString &path);
    void recoverAfterError();
    void checkRecovery();
    Canvas *canvasWidget() { return canvas; }
    Document &document() { return doc; }

  signals:
    void recoveryFinished(quint64 revision, bool saved);

  protected:
    void closeEvent(QCloseEvent *) override;

  private:
    Document doc;
    Canvas *canvas;
    QScrollArea *scroll;
    QDockWidget *layerDock;
    QListWidget *layerList;
    QLabel *status, *documentTitle;
    ColorPicker *colorPicker;
    QLineEdit *hexColor;
    QSpinBox *brushSize;
    QAction *undoAction, *redoAction, *deleteSelectionAction, *cropAction;
    QVector<QAction *> tools;
    QVector<QPushButton *> layerButtons;
    QString recoveryPath;
    quint64 layerPreviewRevision = 0;
    quint64 recoveredRevision = 0;
    bool recoveryErrorShown = false;
    bool preserveRecovery = false;
    bool fileWorkActive = false;
    quint64 recoveryWorkRevision = 0;
    std::shared_ptr<std::atomic_bool> recoveryCancel;
    std::future<std::unique_ptr<QSaveFile>> recoveryWork;
    QAction *action(QMenu *menu, const QString &name, const QKeySequence &shortcut,
                    std::function<void()> work);
    void run(const std::function<void()> &work);
    void sync() noexcept;
    void chooseFile(bool insert, bool dropped = false);
    void requestReplacement(std::function<void()> continuation);
    void finishDialog(QDialog *dialog, std::function<void(int)> finished = {});
    void showMessage(const QString &title, const QString &message,
                     QMessageBox::Icon icon = QMessageBox::Warning);
#ifdef Q_OS_WASM
    BrowserBridge *browser = nullptr;
    quint32 browserSerial = 0, browserPending = 0, recoveryPending = 0;
    quint64 browserEpoch = 1, browserRequestEpoch = 0, browserRequestRevision = 0, recoveryEpoch = 0;
    int browserActive = 0, browserDialogCount = 0;
    QString browserOperation;
    std::optional<State> browserCut;
    bool browserTextCut = false, browserTextMode = false;
    void initializeBrowser();
    void startBrowserRequest(const QString &operation, QJsonObject options = {},
                             const QByteArray &bytes = {});
    void downloadBrowser(QByteArray format, bool chooseName);
#endif
    bool save(bool saveAs = false);
    bool maybeSave();
    void clearRecovery() noexcept;
    bool isRecoveryPath(const QString &path) const;
    std::unique_ptr<QSaveFile> stageFile(const State &state, const QString &path, const QByteArray &format);
    void changeSize(bool scale);
    void editLayer(const QString &label, const std::function<void(State &)> &edit,
                   CommitMode mode = CommitMode::Automatic);
};
} // namespace paint
