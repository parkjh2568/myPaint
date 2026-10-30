#include "mainwindow.h"
#include <QActionGroup>
#include <QApplication>
#include <QCheckBox>
#include <QClipboard>
#include <QCloseEvent>
#include <QColorDialog>
#include <QComboBox>
#include <QDateTime>
#include <QDialogButtonBox>
#include <QDir>
#include <QDockWidget>
#include <QFileDialog>
#include <QFileInfo>
#include <QFontDialog>
#include <QFormLayout>
#include <QGridLayout>
#include <QInputDialog>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QMenuBar>
#include <QMessageBox>
#include <QPainter>
#include <QPushButton>
#include <QScrollArea>
#include <QSignalBlocker>
#include <QSpinBox>
#include <QStandardPaths>
#include <QStatusBar>
#include <QToolBar>
#include <QToolButton>

namespace paint {
QAction *MainWindow::action(QMenu *menu, const QString &name, const QKeySequence &shortcut,
                            std::function<void()> work) {
    auto *result = menu->addAction(name);
    result->setShortcut(shortcut);
    connect(result, &QAction::triggered, this, [this, work = std::move(work)] { run(work); });
    return result;
}
void MainWindow::run(const std::function<void()> &work) {
    try {
        work();
        sync();
    } catch (const std::exception &error) {
        sync();
        canvas->update();
        QMessageBox::warning(this, QStringLiteral("작업을 완료하지 못했습니다"),
                             QString::fromUtf8(error.what()));
    }
}
void MainWindow::recoverAfterError() {
    canvas->cancel();
    sync();
}
MainWindow::MainWindow() {
    setWindowTitle(QStringLiteral("RetroPaint"));
    resize(1080, 780);
    canvas = new Canvas(doc);
    scroll = new QScrollArea(this);
    scroll->setWidget(canvas);
    setCentralWidget(scroll);
    scroll->setAlignment(Qt::AlignLeft | Qt::AlignTop);
    scroll->setWidgetResizable(false);
    status = new QLabel;
    statusBar()->addPermanentWidget(status, 1);
    auto *file = menuBar()->addMenu(QStringLiteral("파일(&F)"));
    action(file, QStringLiteral("새 그림"), QKeySequence::New, [this] {
        canvas->settle();
        if (maybeSave()) {
            canvas->cancel();
            doc.reset(Document::blank(QSize(800, 600)));
            if (!preserveRecovery)
                QFile::remove(recoveryPath);
            canvas->refresh();
        }
    });
    action(file, QStringLiteral("열기…"), QKeySequence::Open, [this] {
        const auto path = QFileDialog::getOpenFileName(
            this, QStringLiteral("그림 열기"), {},
            QStringLiteral("이미지 / 프로젝트 (*.png *.jpg *.jpeg *.bmp *.gif *.rpaint);;모든 파일 (*)"));
        if (!path.isEmpty())
            openFile(path);
    });
    action(file, QStringLiteral("사진 삽입…"), {}, [this] {
        const auto path = QFileDialog::getOpenFileName(
            this, QStringLiteral("사진 삽입"), {}, QStringLiteral("이미지 (*.png *.jpg *.jpeg *.bmp *.gif)"));
        if (!path.isEmpty())
            canvas->paste(Document::readImage(path).layers.front().image);
    });
    action(file, QStringLiteral("저장"), QKeySequence::Save, [this] { save(); });
    action(file, QStringLiteral("다른 이름으로 저장…"), QKeySequence::SaveAs, [this] { save(true); });
    action(file, QStringLiteral("이미지 내보내기…"), QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_E), [this] {
        canvas->settle();
        QString selectedFilter = QStringLiteral("PNG (*.png)");
        QString path = QFileDialog::getSaveFileName(
            this, QStringLiteral("이미지 내보내기"), QStringLiteral("그림.png"),
            QStringLiteral("PNG (*.png);;JPEG (*.jpg);;BMP (*.bmp)"), &selectedFilter);
        if (path.isEmpty())
            return;
        QByteArray format = QFileInfo(path).suffix().toLatin1().toLower();
        if (format.isEmpty()) {
            format = selectedFilter.startsWith(QStringLiteral("JPEG"))  ? "jpg"
                     : selectedFilter.startsWith(QStringLiteral("BMP")) ? "bmp"
                                                                        : "png";
            path += QStringLiteral(".") + QString::fromLatin1(format);
            if (QFile::exists(path) && QMessageBox::question(this, QStringLiteral("덮어쓰기"),
                                                             path + QStringLiteral(" 파일을 덮어쓸까요?"),
                                                             QMessageBox::Yes | QMessageBox::No,
                                                             QMessageBox::No) != QMessageBox::Yes)
                return;
        }
        Document::writeImage(doc.state(), path, format);
    });
    file->addSeparator();
    action(file, QStringLiteral("끝내기"), QKeySequence::Quit, [this] { close(); });
    auto *edit = menuBar()->addMenu(QStringLiteral("편집(&E)"));
    undoAction = action(edit, QStringLiteral("실행 취소"), QKeySequence::Undo, [this] {
        if (canvas->hasPendingEdit())
            canvas->cancel();
        else
            doc.undo();
        canvas->refresh();
    });
    redoAction = action(edit, QStringLiteral("다시 실행"), QKeySequence::Redo, [this] {
        if (canvas->hasPendingEdit())
            canvas->cancel();
        else
            doc.redo();
        canvas->refresh();
    });
    edit->addSeparator();
    action(edit, QStringLiteral("잘라내기"), QKeySequence::Cut, [this] { canvas->copy(true); });
    action(edit, QStringLiteral("복사"), QKeySequence::Copy, [this] { canvas->copy(false); });
    action(edit, QStringLiteral("붙여넣기"), QKeySequence::Paste, [this] {
        auto image = QApplication::clipboard()->image();
        if (image.isNull())
            throw std::runtime_error("클립보드에 이미지가 없습니다.");
        canvas->paste(image);
    });
    action(edit, QStringLiteral("전체 선택"), QKeySequence::SelectAll, [this] { canvas->selectAll(); });
    action(edit, QStringLiteral("선택 삭제"), QKeySequence::Delete, [this] { canvas->removeSelection(); });
    auto *image = menuBar()->addMenu(QStringLiteral("이미지(&I)"));
    action(image, QStringLiteral("캔버스 크기…"), {}, [this] { changeSize(false); });
    action(image, QStringLiteral("이미지 크기…"), {}, [this] { changeSize(true); });
    action(image, QStringLiteral("선택 영역으로 자르기"), {}, [this] { canvas->crop(); });
    action(image, QStringLiteral("오른쪽 90도 회전"), {},
           [this] { canvas->transformSelection(QTransform().rotate(90)); });
    action(image, QStringLiteral("왼쪽 90도 회전"), {},
           [this] { canvas->transformSelection(QTransform().rotate(-90)); });
    action(image, QStringLiteral("좌우 반전"), {},
           [this] { canvas->transformSelection(QTransform().scale(-1, 1)); });
    action(image, QStringLiteral("상하 반전"), {},
           [this] { canvas->transformSelection(QTransform().scale(1, -1)); });
    action(image, QStringLiteral("기울이기…"), {}, [this] {
        bool ok = false;
        double value = QInputDialog::getDouble(this, QStringLiteral("기울이기"),
                                               QStringLiteral("가로 기울기 (-1~1)"), 0, -1, 1, 2, &ok);
        if (ok)
            canvas->transformSelection(QTransform().shear(value, 0));
    });
    action(image, QStringLiteral("색 반전"), {}, [this] {
        canvas->settle();
        State candidate = doc.state();
        candidate.layers[candidate.active].image.invertPixels(QImage::InvertRgb);
        doc.commit(std::move(candidate), QStringLiteral("색 반전"));
        canvas->refresh();
    });
    action(image, QStringLiteral("전체 지우기"), {}, [this] {
        canvas->settle();
        State candidate = doc.state();
        candidate.layers[candidate.active].image.fill(candidate.layers.size() > 1 ? QColor(Qt::transparent)
                                                                                  : candidate.background);
        doc.commit(std::move(candidate), QStringLiteral("지우기"));
        canvas->refresh();
    });
    auto *view = menuBar()->addMenu(QStringLiteral("보기(&V)"));
    action(view, QStringLiteral("확대"), QKeySequence::ZoomIn,
           [this] { canvas->setZoom(canvas->zoom * 1.25); });
    action(view, QStringLiteral("축소"), QKeySequence::ZoomOut,
           [this] { canvas->setZoom(canvas->zoom / 1.25); });
    action(view, QStringLiteral("실제 크기"), {}, [this] { canvas->setZoom(1); });
    action(view, QStringLiteral("화면에 맞추기"), {}, [this] {
        canvas->setZoom(std::min((scroll->viewport()->width() - 16.0) / doc.state().size.width(),
                                 (scroll->viewport()->height() - 16.0) / doc.state().size.height()));
    });
    auto *grid = view->addAction(QStringLiteral("픽셀 격자"));
    grid->setCheckable(true);
    connect(grid, &QAction::toggled, this, [this](bool value) {
        canvas->grid = value;
        canvas->update();
    });
    auto *colors = menuBar()->addMenu(QStringLiteral("색상(&C)"));
    action(colors, QStringLiteral("전경색…"), {}, [this] {
        const auto color = QColorDialog::getColor(canvas->foreground, this, QStringLiteral("전경색"),
                                                  QColorDialog::ShowAlphaChannel);
        if (color.isValid()) {
            canvas->foreground = color;
            canvas->updateTextStyle();
        }
    });
    action(colors, QStringLiteral("배경색…"), {}, [this] {
        const auto color = QColorDialog::getColor(canvas->background, this, QStringLiteral("배경색"));
        if (color.isValid()) {
            canvas->settle();
            State candidate = doc.state();
            candidate.background = color;
            doc.commit(std::move(candidate), QStringLiteral("배경색 설정"));
        }
    });
    action(colors, QStringLiteral("글꼴…"), {}, [this] {
        bool ok = false;
        const auto font = QFontDialog::getFont(&ok, canvas->textFont, this);
        if (ok) {
            canvas->textFont = font;
            canvas->updateTextStyle();
        }
    });
    auto *help = menuBar()->addMenu(QStringLiteral("도움말(&H)"));
    action(help, QStringLiteral("사용 방법"), QKeySequence::HelpContents, [this] {
        QMessageBox::information(
            this, QStringLiteral("RetroPaint"),
            QStringLiteral(
                "사진을 열거나 붙여넣고 도구를 선택해 그리세요.\n선택: 이동 / 우하단 크기 조절 / Enter 확정 "
                "/ Esc 취소\n캔버스 우측·아래 가장자리 드래그: 작업 공간 변경\n곡선: 끝점 드래그 후 제어점 "
                "두 번 클릭\n다각형: 꼭짓점 클릭 후 더블클릭 또는 Enter\n문자: 입력 후 Ctrl+Enter 또는 다른 "
                "도구로 확정\nCtrl+휠: 확대 / 가운데 버튼: 화면 이동\n레이어는 보기 메뉴에서 표시할 수 "
                "있습니다.\nPNG는 투명도를 보존하며 JPEG/BMP는 배경색과 합성합니다.\n프로젝트(.rpaint)는 "
                "레이어를 보존합니다.\n라이선스: 앱 MIT / Qt LGPLv3 (배포물 NOTICE 참고)."));
    });
    auto *toolBar = new QToolBar(QStringLiteral("도구"), this);
    toolBar->setMovable(false);
    addToolBar(Qt::LeftToolBarArea, toolBar);
    auto *toolWidget = new QWidget;
    auto *toolLayout = new QGridLayout(toolWidget);
    toolLayout->setSpacing(2);
    toolLayout->setContentsMargins(3, 3, 3, 3);
    const QStringList names = {
        QStringLiteral("연필"),     QStringLiteral("브러시"),      QStringLiteral("스프레이"),
        QStringLiteral("지우개"),   QStringLiteral("색 지우개"),   QStringLiteral("채우기"),
        QStringLiteral("스포이트"), QStringLiteral("직선"),        QStringLiteral("곡선"),
        QStringLiteral("사각형"),   QStringLiteral("둥근 사각형"), QStringLiteral("타원"),
        QStringLiteral("다각형"),   QStringLiteral("사각 선택"),   QStringLiteral("자유 선택"),
        QStringLiteral("문자"),     QStringLiteral("이동")};
    auto *group = new QActionGroup(this);
    for (int i = 0; i < names.size(); ++i) {
        auto *toolAction = new QAction(names[i], this);
        toolAction->setCheckable(true);
        group->addAction(toolAction);
        tools << toolAction;
        auto *button = new QToolButton;
        button->setDefaultAction(toolAction);
        button->setFixedSize(64, 38);
        button->setToolTip(names[i]);
        toolLayout->addWidget(button, i / 2, i % 2);
        connect(toolAction, &QAction::triggered, this,
                [this, i] { run([this, i] { canvas->setTool(Tool(i)); }); });
    }
    toolBar->addWidget(toolWidget);
    tools.front()->setChecked(true);
    auto *options = addToolBar(QStringLiteral("도구 옵션"));
    options->setMovable(false);
    options->addWidget(new QLabel(QStringLiteral(" 굵기 ")));
    auto *width = new QSpinBox;
    width->setRange(1, 100);
    width->setValue(3);
    options->addWidget(width);
    connect(width, &QSpinBox::valueChanged, this, [this](int value) { canvas->thickness = value; });
    auto *shape = new QComboBox;
    shape->addItems({QStringLiteral("윤곽선"), QStringLiteral("윤곽선+채우기"), QStringLiteral("채우기")});
    options->addWidget(shape);
    connect(shape, &QComboBox::currentIndexChanged, this, [this](int i) {
        canvas->outlineShape = i != 2;
        canvas->fillShape = i != 0;
    });
    auto *square = new QCheckBox(QStringLiteral("사각 붓"));
    options->addWidget(square);
    connect(square, &QCheckBox::toggled, this, [this](bool v) { canvas->brushSquare = v; });
    auto *transparent = new QCheckBox(QStringLiteral("투명 선택"));
    options->addWidget(transparent);
    connect(transparent, &QCheckBox::toggled, this, [this](bool v) { canvas->transparentSelection = v; });
    auto *opaqueText = new QCheckBox(QStringLiteral("문자 배경"));
    options->addWidget(opaqueText);
    connect(opaqueText, &QCheckBox::toggled, this, [this](bool v) { canvas->transparentText = !v; });
    auto *palette = new QToolBar(QStringLiteral("팔레트"), this);
    palette->setMovable(false);
    addToolBar(Qt::BottomToolBarArea, palette);
    palette->addWidget(new QLabel(QStringLiteral(" 전경/배경: 왼쪽/오른쪽 클릭 ")));
    const QStringList swatches = {"#000000", "#808080", "#800000", "#808000", "#008000", "#008080",
                                  "#000080", "#800080", "#ffffff", "#c0c0c0", "#ff0000", "#ffff00",
                                  "#00ff00", "#00ffff", "#0000ff", "#ff00ff"};
    for (const auto &hex : swatches) {
        auto *button = new QPushButton;
        button->setFixedSize(24, 24);
        button->setStyleSheet(QStringLiteral("background:%1;").arg(hex));
        button->setToolTip(hex);
        palette->addWidget(button);
        connect(button, &QPushButton::clicked, this, [this, hex] {
            canvas->foreground = QColor(hex);
            canvas->updateTextStyle();
            sync();
        });
        button->setContextMenuPolicy(Qt::CustomContextMenu);
        connect(button, &QWidget::customContextMenuRequested, this, [this, hex] {
            run([this, hex] {
                canvas->settle();
                State candidate = doc.state();
                candidate.background = QColor(hex);
                doc.commit(std::move(candidate), QStringLiteral("배경색 설정"));
            });
        });
    }
    layerDock = new QDockWidget(QStringLiteral("레이어 (아래 → 위)"), this);
    layerDock->setObjectName(QStringLiteral("layers"));
    auto *layerWidget = new QWidget;
    auto *layerLayout = new QVBoxLayout(layerWidget);
    layerList = new QListWidget;
    layerLayout->addWidget(layerList);
    auto *row = new QHBoxLayout;
    layerLayout->addLayout(row);
    for (int i = 0; i < 6; ++i) {
        const QStringList labels = {QStringLiteral("+"), QStringLiteral("−"),    QStringLiteral("↑"),
                                    QStringLiteral("↓"), QStringLiteral("병합"), QStringLiteral("이름")};
        auto *button = new QPushButton(labels[i]);
        row->addWidget(button);
        connect(button, &QPushButton::clicked, this, [this, i] {
            run([this, i] {
                if (i == 5) {
                    bool ok = false;
                    const auto name = QInputDialog::getText(this, QStringLiteral("레이어 이름"),
                                                            QStringLiteral("이름"), QLineEdit::Normal,
                                                            doc.state().layers[doc.state().active].name, &ok);
                    if (ok && !name.isEmpty())
                        editLayer(QStringLiteral("이름"),
                                  [&](State &s) { s.layers[s.active].name = name.left(256); });
                    return;
                }
                editLayer(QStringLiteral("레이어"), [i](State &s) {
                    const int active = s.active;
                    if (i == 0) {
                        if (s.layers.size() >= MaxLayers ||
                            qint64(s.size.width()) * s.size.height() * (s.layers.size() + 1) >
                                MaxDocumentPixels)
                            throw std::runtime_error("레이어 한도를 초과합니다.");
                        s.layers.insert(active + 1, {QStringLiteral("레이어 %1").arg(s.layers.size() + 1),
                                                     Document::allocate(s.size), true});
                        s.active = active + 1;
                    }
                    if (i == 1 && s.layers.size() > 1) {
                        s.layers.removeAt(active);
                        s.active = std::min(active, int(s.layers.size()) - 1);
                    }
                    if (i == 2 && active + 1 < s.layers.size()) {
                        s.layers.swapItemsAt(active, active + 1);
                        ++s.active;
                    }
                    if (i == 3 && active > 0) {
                        s.layers.swapItemsAt(active, active - 1);
                        --s.active;
                    }
                    if (i == 4 && active > 0) {
                        if (!s.layers[active].visible || !s.layers[active - 1].visible)
                            throw std::runtime_error("병합할 두 레이어를 먼저 표시하세요.");
                        QPainter p(&s.layers[active - 1].image);
                        p.drawImage(0, 0, s.layers[active].image);
                        p.end();
                        s.layers.removeAt(active);
                        --s.active;
                    }
                });
            });
        });
    }
    layerDock->setWidget(layerWidget);
    addDockWidget(Qt::RightDockWidgetArea, layerDock);
    layerDock->hide();
    view->addAction(layerDock->toggleViewAction());
    connect(layerList, &QListWidget::currentRowChanged, this, [this](int index) {
        if (index < 0)
            return;
        run([this, index] {
            canvas->settle();
            doc.setActive(index);
            canvas->refresh();
        });
    });
    connect(layerList, &QListWidget::itemChanged, this, [this](QListWidgetItem *item) {
        const int index = layerList->row(item);
        const bool visible = item->checkState() == Qt::Checked;
        run([this, index, visible] {
            editLayer(QStringLiteral("표시 / 숨김"), [=](State &s) { s.layers[index].visible = visible; });
        });
    });
    connect(canvas, &Canvas::changed, this, &MainWindow::sync);
    connect(canvas, &Canvas::positionChanged, this,
            [this](QPoint p) { statusBar()->showMessage(QStringLiteral("%1, %2").arg(p.x()).arg(p.y())); });
    connect(canvas, &Canvas::colorPicked, this, [this](QColor color) {
        canvas->foreground = color;
        canvas->updateTextStyle();
        sync();
    });
    connect(canvas, &Canvas::fileDropped, this, [this](const QString &path) {
        run([this, path] { canvas->paste(Document::readImage(path).layers.front().image); });
    });
    const QString data = QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation);
    QDir().mkpath(data);
    recoveryPath = data + QStringLiteral("/recovery.rpaint");
    auto *recovery = new QTimer(this);
    recovery->setInterval(30000);
    connect(recovery, &QTimer::timeout, this, [this] {
        if (preserveRecovery || !doc.dirty() || doc.revision() == recoveredRevision)
            return;
        try {
            Document::writeProject(doc.state(), recoveryPath);
            recoveredRevision = doc.revision();
            recoveryErrorShown = false;
        } catch (const std::exception &) {
            if (!recoveryErrorShown) {
                statusBar()->showMessage(QStringLiteral("자동 복구 저장 실패. 다른 위치에 직접 저장하세요."),
                                         15000);
                recoveryErrorShown = true;
            }
        }
    });
    recovery->start();
    sync();
}
void MainWindow::sync() {
    canvas->background = doc.state().background;
    setWindowTitle(
        QStringLiteral("%1%2 - RetroPaint")
            .arg(doc.dirty() ? QStringLiteral("* ") : QString(),
                 doc.path.isEmpty() ? QStringLiteral("제목 없음") : QFileInfo(doc.path).fileName()));
    undoAction->setEnabled(doc.canUndo() || canvas->hasPendingEdit());
    redoAction->setEnabled(doc.canRedo() || canvas->hasPendingEdit());
    undoAction->setText(canvas->hasPendingEdit() ? QStringLiteral("현재 편집 취소")
                                                 : QStringLiteral("실행 취소 %1").arg(doc.undoLabel()));
    redoAction->setText(QStringLiteral("다시 실행 %1").arg(doc.redoLabel()));
    QSignalBlocker blocker(layerList);
    layerList->clear();
    for (const auto &layer : doc.state().layers) {
        auto *item = new QListWidgetItem(layer.name, layerList);
        item->setFlags(item->flags() | Qt::ItemIsUserCheckable);
        item->setCheckState(layer.visible ? Qt::Checked : Qt::Unchecked);
    }
    layerList->setCurrentRow(doc.state().active);
    for (int i = 0; i < tools.size(); ++i)
        tools[i]->setChecked(i == int(canvas->tool));
    status->setText(QStringLiteral("%1 × %2 px  |  %3%  |  %4  |  전경 %5 / 배경 %6  |  Undo %7 MiB")
                        .arg(doc.state().size.width())
                        .arg(doc.state().size.height())
                        .arg(qRound(canvas->zoom * 100))
                        .arg(doc.state().layers[doc.state().active].name, canvas->foreground.name(),
                             canvas->background.name())
                        .arg(doc.historyBytes() / 1024 / 1024));
}
void MainWindow::editLayer(const QString &label, const std::function<void(State &)> &edit) {
    canvas->settle();
    State candidate = doc.state();
    edit(candidate);
    doc.commit(std::move(candidate), label);
    canvas->refresh();
}
bool MainWindow::save(bool saveAs) {
    canvas->settle();
    QString path = doc.path;
    const bool requiresProject = doc.state().layers.size() > 1 || !doc.state().layers.front().visible;
    if (requiresProject && !path.endsWith(QStringLiteral(".rpaint"), Qt::CaseInsensitive))
        saveAs = true;
    if (!path.isEmpty() &&
        !QStringList{"rpaint", "png", "jpg", "jpeg", "bmp"}.contains(QFileInfo(path).suffix().toLower()))
        saveAs = true;
    if (saveAs || path.isEmpty()) {
        QString selectedFilter =
            requiresProject ? QStringLiteral("RetroPaint (*.rpaint)") : QStringLiteral("PNG (*.png)");
        path = QFileDialog::getSaveFileName(
            this, QStringLiteral("그림 저장"),
            requiresProject ? QStringLiteral("그림.rpaint") : QStringLiteral("그림.png"),
            QStringLiteral("RetroPaint (*.rpaint);;PNG (*.png);;JPEG (*.jpg);;BMP (*.bmp)"), &selectedFilter);
        if (path.isEmpty())
            return false;
        if (QFileInfo(path).suffix().isEmpty()) {
            path += selectedFilter.startsWith(QStringLiteral("RetroPaint")) ? QStringLiteral(".rpaint")
                    : selectedFilter.startsWith(QStringLiteral("JPEG"))     ? QStringLiteral(".jpg")
                    : selectedFilter.startsWith(QStringLiteral("BMP"))      ? QStringLiteral(".bmp")
                                                                            : QStringLiteral(".png");
            if (QFile::exists(path) && QMessageBox::question(this, QStringLiteral("덮어쓰기"),
                                                             path + QStringLiteral(" 파일을 덮어쓸까요?"),
                                                             QMessageBox::Yes | QMessageBox::No,
                                                             QMessageBox::No) != QMessageBox::Yes)
                return false;
        }
    }
    const auto suffix = QFileInfo(path).suffix().toLower();
    if (suffix == QStringLiteral("rpaint"))
        Document::writeProject(doc.state(), path);
    else {
        if (requiresProject) {
            QMessageBox::information(
                this, QStringLiteral("레이어 보존"),
                QStringLiteral("레이어 문서는 .rpaint로 저장하세요. 평면 이미지는 내보내기를 사용하세요."));
            return false;
        }
        Document::writeImage(doc.state(), path, suffix.toLatin1());
    }
    doc.path = path;
    doc.markSaved();
    if (!preserveRecovery)
        QFile::remove(recoveryPath);
    sync();
    return true;
}
bool MainWindow::maybeSave() {
    if (!doc.dirty())
        return true;
    const auto choice = QMessageBox::question(
        this, QStringLiteral("변경 사항 저장"), QStringLiteral("현재 그림을 저장할까요?"),
        QMessageBox::Save | QMessageBox::Discard | QMessageBox::Cancel, QMessageBox::Save);
    if (choice == QMessageBox::Cancel)
        return false;
    if (choice == QMessageBox::Save)
        return save();
    return choice == QMessageBox::Discard;
}
void MainWindow::openFile(const QString &path) {
    // Parse completely before asking to replace the current document.
    State loaded = path.endsWith(QStringLiteral(".rpaint"), Qt::CaseInsensitive) ? Document::readProject(path)
                                                                                 : Document::readImage(path);
    canvas->settle();
    if (!maybeSave())
        return;
    canvas->cancel();
    doc.reset(std::move(loaded), path);
    if (!preserveRecovery)
        QFile::remove(recoveryPath);
    canvas->background = doc.state().background;
    canvas->refresh();
    sync();
}
void MainWindow::changeSize(bool scale) {
    canvas->settle();
    QDialog dialog(this);
    dialog.setWindowTitle(scale ? QStringLiteral("이미지 크기") : QStringLiteral("캔버스 크기"));
    QFormLayout layout(&dialog);
    QSpinBox width, height;
    width.setRange(1, 32768);
    height.setRange(1, 32768);
    width.setValue(doc.state().size.width());
    height.setValue(doc.state().size.height());
    layout.addRow(QStringLiteral("너비 (픽셀)"), &width);
    layout.addRow(QStringLiteral("높이 (픽셀)"), &height);
    QCheckBox ratio(QStringLiteral("비율 유지"));
    ratio.setChecked(scale);
    layout.addRow(&ratio);
    const double aspect = double(width.value()) / height.value();
    connect(&width, &QSpinBox::valueChanged, &dialog, [&](int value) {
        if (ratio.isChecked()) {
            QSignalBlocker block(height);
            height.setValue(qRound(value / aspect));
        }
    });
    connect(&height, &QSpinBox::valueChanged, &dialog, [&](int value) {
        if (ratio.isChecked()) {
            QSignalBlocker block(width);
            width.setValue(qRound(value * aspect));
        }
    });
    QCheckBox smooth(QStringLiteral("부드러운 보간"));
    if (scale)
        layout.addRow(&smooth);
    QLabel notice(scale ? QStringLiteral("그림 자체의 크기를 변경합니다.")
                        : QStringLiteral("좌상단 기준 작업 공간 변경. 잘린 부분은 Undo로 복원합니다."));
    layout.addRow(&notice);
    QDialogButtonBox buttons(QDialogButtonBox::Ok | QDialogButtonBox::Cancel);
    layout.addRow(&buttons);
    connect(&buttons, &QDialogButtonBox::accepted, &dialog, &QDialog::accept);
    connect(&buttons, &QDialogButtonBox::rejected, &dialog, &QDialog::reject);
    if (dialog.exec() != QDialog::Accepted)
        return;
    doc.commit(
        Document::resized(doc.state(), QSize(width.value(), height.value()), scale, smooth.isChecked()),
        QStringLiteral("크기 변경"));
    canvas->refresh();
}
void MainWindow::checkRecovery() {
    if (!QFile::exists(recoveryPath))
        return;
    preserveRecovery = true;
    if (QMessageBox::question(this, QStringLiteral("작업 복구"),
                              QStringLiteral("이전 작업의 복구 사본을 열까요?")) == QMessageBox::Yes) {
        State state = Document::readProject(recoveryPath);
        doc.reset(std::move(state));
        doc.markUnsaved();
        canvas->background = doc.state().background;
        canvas->refresh();
        sync();
        preserveRecovery = false;
    } else {
        // Retain a declined backup separately; new autosaves must not overwrite it.
        const QString retained =
            recoveryPath + QStringLiteral(".") +
            QDateTime::currentDateTimeUtc().toString(QStringLiteral("yyyyMMdd-hhmmsszzz"));
        if (!QFile::rename(recoveryPath, retained))
            throw std::runtime_error("이전 복구 파일을 보관하지 못했습니다. 자동 복구 저장을 중지합니다.");
        preserveRecovery = false;
    }
}
void MainWindow::closeEvent(QCloseEvent *event) {
    try {
        canvas->settle();
        if (!maybeSave()) {
            event->ignore();
            return;
        }
        if (!preserveRecovery)
            QFile::remove(recoveryPath);
        event->accept();
    } catch (const std::exception &error) {
        QMessageBox::warning(this, QStringLiteral("저장 실패"), QString::fromUtf8(error.what()));
        event->ignore();
    }
}
} // namespace paint
