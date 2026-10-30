#pragma once
#include "canvas.h"
#include <QKeySequence>
#include <QMainWindow>
#include <functional>
class QAction;
class QLabel;
class QDockWidget;
class QListWidget;
class QScrollArea;
class QMenu;
namespace paint {
class MainWindow : public QMainWindow {
    Q_OBJECT
  public:
    MainWindow();
    void openFile(const QString &path);
    void recoverAfterError();
    void checkRecovery();
    Canvas *canvasWidget() { return canvas; }
    Document &document() { return doc; }

  protected:
    void closeEvent(QCloseEvent *) override;

  private:
    Document doc;
    Canvas *canvas;
    QScrollArea *scroll;
    QDockWidget *layerDock;
    QListWidget *layerList;
    QLabel *status;
    QAction *undoAction, *redoAction;
    QVector<QAction *> tools;
    QString recoveryPath;
    quint64 recoveredRevision = 0;
    bool recoveryErrorShown = false;
    bool preserveRecovery = false;
    QAction *action(QMenu *menu, const QString &name, const QKeySequence &shortcut,
                    std::function<void()> work);
    void run(const std::function<void()> &work);
    void sync();
    bool save(bool saveAs = false);
    bool maybeSave();
    void changeSize(bool scale);
    void editLayer(const QString &label, const std::function<void(State &)> &edit);
};
} // namespace paint
