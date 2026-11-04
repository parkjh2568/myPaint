#include "mainwindow.h"
#include <QActionGroup>
#include <QCheckBox>
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
#include <QGuiApplication>
#include <QIcon>
#include <QInputDialog>
#include <QInputMethod>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QMenuBar>
#include <QMessageBox>
#include <QPainter>
#include <QPixmap>
#include <QProgressBar>
#include <QPushButton>
#include <QScopedValueRollback>
#include <QScrollArea>
#include <QSignalBlocker>
#include <QSpinBox>
#include <QStandardPaths>
#include <QStatusBar>
#include <QThread>
#include <QToolBar>
#include <QToolButton>
#include <QVBoxLayout>
#include <cstdio>
#include <stdexcept>

namespace paint {
class FileProgressDialog final : public QDialog {
  public:
    using QDialog::QDialog;
    std::atomic_bool cancelled = false;
    QLabel *message = nullptr;
    QPushButton *cancelButton = nullptr;
    void reject() override {
        cancelled = true;
        if (message)
            message->setText(QStringLiteral("취소 중… 현재 이미지 처리가 끝나면 닫힙니다."));
        if (cancelButton)
            cancelButton->setEnabled(false);
    }

  protected:
    void closeEvent(QCloseEvent *event) override {
        reject();
        event->ignore();
    }
};
QAction *MainWindow::action(QMenu *menu, const QString &name, const QKeySequence &shortcut,
                            std::function<void()> work) {
    auto *result = menu->addAction(name);
    result->setShortcut(shortcut);
    connect(result, &QAction::triggered, this, [this, work = std::move(work)] { run(work); });
    return result;
}
void MainWindow::run(const std::function<void()> &work) {
    if (fileWorkActive)
        return;
#ifdef Q_OS_WASM
    if (canvas->hasActiveGesture()) {
        statusBar()->showMessage(QStringLiteral("마우스 버튼을 놓고 현재 그리기를 마친 뒤 실행하세요."));
        return;
    }
#endif
    try {
        work();
        sync();
    } catch (const std::exception &error) {
        try {
            canvas->recoverAfterError();
            sync();
            showMessage(QStringLiteral("작업을 완료하지 못했습니다"), QString::fromUtf8(error.what()));
        } catch (...) {
            std::fprintf(stderr, "RetroPaint: insufficient resources to report an operation error\n");
        }
    }
}
MainWindow::~MainWindow() {
    if (recoveryCancel)
        *recoveryCancel = true;
}
void MainWindow::recoverAfterError() {
    canvas->recoverAfterError();
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
        State blank = Document::blank(QSize(800, 600));
        requestReplacement([this, blank = std::move(blank)]() mutable {
            doc.reset(std::move(blank));
            clearRecovery();
            canvas->cancel();
        });
    });
    action(file, QStringLiteral("열기…"), QKeySequence::Open, [this] { chooseFile(false); });
    action(file, QStringLiteral("사진 삽입…"), {}, [this] { chooseFile(true); });
    action(file, QStringLiteral("저장"), QKeySequence::Save, [this] { save(); });
    action(file, QStringLiteral("다른 이름으로 저장…"), QKeySequence::SaveAs, [this] { save(true); });
    action(file, QStringLiteral("이미지 내보내기…"), QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_E), [this] {
#ifdef Q_OS_WASM
        downloadBrowser({}, true);
#else
        QGuiApplication::inputMethod()->commit();
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
        auto file = stageFile(canvas->pendingState(), path, format);
        if (file && !file->commit())
            throw std::runtime_error(file->errorString().toStdString());
#endif
    });
    file->addSeparator();
#ifndef Q_OS_WASM
    action(file, QStringLiteral("끝내기"), QKeySequence::Quit, [this] { close(); });
#else
    for (auto *item : file->actions()) {
        if (item->text() == QStringLiteral("저장"))
            item->setText(QStringLiteral("프로젝트 다운로드"));
        if (item->text() == QStringLiteral("다른 이름으로 저장…"))
            item->setText(QStringLiteral("다른 이름으로 다운로드…"));
    }
    action(file, QStringLiteral("브라우저 복구 사본 열기…"), {}, [this] { checkRecovery(); });
    action(file, QStringLiteral("브라우저 복구 사본 비우기…"), {}, [this] {
        auto *dialog = new QMessageBox(
            QMessageBox::Question, QStringLiteral("복구 사본 비우기"),
            QStringLiteral("이 앱의 모든 탭에서 만든 복구 사본을 삭제할까요? 현재 그림은 유지됩니다."),
            QMessageBox::Yes | QMessageBox::No, this);
        dialog->setDefaultButton(QMessageBox::No);
        finishDialog(dialog, [this](int result) {
            if (result == QMessageBox::Yes)
                startBrowserRequest(QStringLiteral("clear"));
        });
    });
#endif
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
    action(edit, QStringLiteral("붙여넣기"), QKeySequence::Paste, [this] { canvas->pasteClipboard(); });
    action(edit, QStringLiteral("전체 선택"), QKeySequence::SelectAll, [this] { canvas->selectAll(); });
    deleteSelectionAction = action(edit, QStringLiteral("선택 삭제"), QKeySequence::Delete,
                                   [this] { canvas->removeSelection(); });
    auto *image = menuBar()->addMenu(QStringLiteral("이미지(&I)"));
    action(image, QStringLiteral("캔버스 크기…"), {}, [this] { changeSize(false); });
    action(image, QStringLiteral("이미지 크기…"), {}, [this] { changeSize(true); });
    cropAction = action(image, QStringLiteral("선택 영역으로 자르기"), {}, [this] { canvas->crop(); });
    action(image, QStringLiteral("오른쪽 90도 회전"), {},
           [this] { canvas->transformSelection(QTransform().rotate(90)); });
    action(image, QStringLiteral("왼쪽 90도 회전"), {},
           [this] { canvas->transformSelection(QTransform().rotate(-90)); });
    action(image, QStringLiteral("좌우 반전"), {},
           [this] { canvas->transformSelection(QTransform().scale(-1, 1)); });
    action(image, QStringLiteral("상하 반전"), {},
           [this] { canvas->transformSelection(QTransform().scale(1, -1)); });
    action(image, QStringLiteral("기울이기…"), {}, [this] {
        auto *dialog = new QInputDialog(this);
        dialog->setWindowTitle(QStringLiteral("기울이기"));
        dialog->setLabelText(QStringLiteral("가로 기울기 (-1~1)"));
        dialog->setInputMode(QInputDialog::DoubleInput);
        dialog->setDoubleRange(-1, 1);
        dialog->setDoubleDecimals(2);
        finishDialog(dialog, [this, dialog](int result) {
            if (result == QDialog::Accepted)
                canvas->transformSelection(QTransform().shear(dialog->doubleValue(), 0));
        });
    });
    action(image, QStringLiteral("색 반전"), {}, [this] {
        State candidate = canvas->pendingState();
        candidate.layers[candidate.active].image.invertPixels(QImage::InvertRgb);
        doc.commit(std::move(candidate), QStringLiteral("색 반전"));
        canvas->cancel();
        canvas->refresh();
    });
    action(image, QStringLiteral("전체 지우기"), {}, [this] {
        State candidate = canvas->pendingState();
        candidate.layers[candidate.active].image.fill(candidate.layers.size() > 1 ? QColor(Qt::transparent)
                                                                                  : candidate.background);
        doc.commit(std::move(candidate), QStringLiteral("지우기"));
        canvas->cancel();
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
        auto *dialog = new QColorDialog(canvas->foreground, this);
        dialog->setWindowTitle(QStringLiteral("전경색"));
        dialog->setOption(QColorDialog::ShowAlphaChannel);
        finishDialog(dialog, [this, dialog](int result) {
            if (result != QDialog::Accepted)
                return;
            canvas->foreground = dialog->selectedColor();
            canvas->updateTextStyle();
        });
    });
    action(colors, QStringLiteral("배경색…"), {}, [this] {
        auto *dialog = new QColorDialog(canvas->background, this);
        dialog->setWindowTitle(QStringLiteral("배경색"));
        finishDialog(dialog, [this, dialog](int result) {
            if (result != QDialog::Accepted)
                return;
            State candidate = canvas->pendingState();
            candidate.background = dialog->selectedColor();
            doc.commit(std::move(candidate), QStringLiteral("배경색 설정"));
            canvas->cancel();
        });
    });
    action(colors, QStringLiteral("글꼴…"), {}, [this] {
        auto *dialog = new QFontDialog(canvas->textFont, this);
        finishDialog(dialog, [this, dialog](int result) {
            if (result != QDialog::Accepted)
                return;
            canvas->textFont = dialog->selectedFont();
            canvas->updateTextStyle();
        });
    });
    auto *help = menuBar()->addMenu(QStringLiteral("도움말(&H)"));
    action(help, QStringLiteral("사용 방법"), QKeySequence::HelpContents, [this] {
        showMessage(
            QStringLiteral("RetroPaint"),
            QStringLiteral(
                "사진을 열거나 붙여넣고 도구를 선택해 그리세요.\n선택: 이동 / 우하단 크기 조절 / Enter 확정 "
                "/ Esc 취소\n캔버스 우측·아래 가장자리 드래그: 작업 공간 변경\n곡선: 끝점 드래그 후 제어점 "
                "두 번 클릭\n다각형: 꼭짓점 클릭 후 더블클릭 또는 Enter\n문자: 입력 후 Ctrl+Enter 또는 다른 "
                "도구로 확정\nCtrl+휠: 확대 / 가운데 버튼: 화면 이동\n레이어는 보기 메뉴에서 표시할 수 "
                "있습니다.\nPNG는 투명도를 보존하며 JPEG/BMP는 배경색과 합성합니다.\n프로젝트(.rpaint)는 "
                "레이어를 보존합니다.\n라이선스: 앱 MIT / Qt 의존성은 배포물 NOTICE 참고."),
            QMessageBox::Information);
    });
    auto *toolBar = new QToolBar(QStringLiteral("도구"), this);
    toolBar->setMovable(false);
    addToolBar(Qt::LeftToolBarArea, toolBar);
    auto *toolWidget = new QWidget;
    auto *toolLayout = new QGridLayout(toolWidget);
    toolLayout->setSpacing(2);
    toolLayout->setContentsMargins(3, 3, 3, 3);
    struct ToolDefinition {
        Tool tool;
        QString name;
    };
    const ToolDefinition toolDefinitions[] = {{Tool::Pencil, QStringLiteral("연필")},
                                              {Tool::Brush, QStringLiteral("브러시")},
                                              {Tool::Spray, QStringLiteral("스프레이")},
                                              {Tool::Eraser, QStringLiteral("지우개")},
                                              {Tool::ColorEraser, QStringLiteral("색 지우개")},
                                              {Tool::Fill, QStringLiteral("채우기")},
                                              {Tool::Picker, QStringLiteral("스포이트")},
                                              {Tool::Line, QStringLiteral("직선")},
                                              {Tool::Curve, QStringLiteral("곡선")},
                                              {Tool::Rectangle, QStringLiteral("사각형")},
                                              {Tool::RoundRectangle, QStringLiteral("둥근 사각형")},
                                              {Tool::Ellipse, QStringLiteral("타원")},
                                              {Tool::Polygon, QStringLiteral("다각형")},
                                              {Tool::Select, QStringLiteral("사각 선택")},
                                              {Tool::FreeSelect, QStringLiteral("자유 선택")},
                                              {Tool::Text, QStringLiteral("문자")},
                                              {Tool::Pan, QStringLiteral("이동")}};
    auto *group = new QActionGroup(this);
    int toolIndex = 0;
    for (const auto &definition : toolDefinitions) {
        QIcon icon;
        for (int scale : {1, 2, 3}) {
            QPixmap pixmap(24 * scale, 24 * scale);
            pixmap.setDevicePixelRatio(scale);
            pixmap.fill(Qt::transparent);
            QPainter painter(&pixmap);
            painter.setPen(QPen(QColor(32, 32, 32), 1));
            painter.setBrush(Qt::NoBrush);
            switch (definition.tool) {
            case Tool::Pencil:
                painter.setBrush(QColor(245, 202, 66));
                painter.drawPolygon(QPolygon{{5, 16}, {15, 4}, {19, 7}, {9, 19}});
                painter.setBrush(QColor(245, 220, 168));
                painter.drawPolygon(QPolygon{{5, 16}, {9, 19}, {3, 21}});
                painter.setBrush(QColor(213, 129, 132));
                painter.drawPolygon(QPolygon{{15, 4}, {17, 2}, {21, 5}, {19, 7}});
                painter.drawLine(3, 21, 5, 19);
                painter.drawLine(8, 16, 17, 6);
                break;
            case Tool::Brush:
                painter.setBrush(QColor(224, 182, 82));
                painter.drawRoundedRect(10, 2, 4, 11, 2, 2);
                painter.setBrush(QColor(169, 173, 177));
                painter.drawRect(8, 12, 8, 4);
                painter.setBrush(QColor(116, 73, 39));
                painter.drawPolygon(QPolygon{{8, 16}, {16, 16}, {17, 21}, {6, 21}});
                painter.drawLine(10, 17, 9, 21);
                painter.drawLine(13, 17, 13, 21);
                break;
            case Tool::Spray:
                painter.setBrush(QColor(56, 93, 161));
                painter.drawRect(11, 10, 8, 11);
                painter.setBrush(QColor(192, 197, 203));
                painter.drawRect(12, 7, 6, 3);
                painter.drawRect(12, 4, 4, 3);
                painter.drawLine(14, 12, 14, 18);
                for (QPoint point :
                     {QPoint(3, 3), QPoint(6, 5), QPoint(8, 2), QPoint(4, 8), QPoint(8, 8), QPoint(9, 5)})
                    painter.drawPoint(point);
                break;
            case Tool::Eraser:
            case Tool::ColorEraser:
                if (definition.tool == Tool::ColorEraser) {
                    painter.fillRect(3, 3, 5, 4, QColor(32, 96, 173));
                    painter.fillRect(10, 3, 5, 4, QColor(188, 66, 64));
                    painter.drawLine(17, 4, 21, 4);
                    painter.drawLine(19, 2, 21, 4);
                    painter.drawLine(19, 6, 21, 4);
                }
                painter.setBrush(QColor(244, 225, 151));
                painter.drawPolygon(QPolygon{{3, 15}, {13, 8}, {21, 12}, {11, 20}, {6, 20}});
                painter.setBrush(QColor(251, 246, 219));
                painter.drawPolygon(QPolygon{{3, 15}, {9, 17}, {14, 13}, {8, 11}});
                painter.drawLine(9, 17, 11, 20);
                break;
            case Tool::Fill:
                painter.setBrush(QColor(0, 128, 128));
                painter.drawPolygon(QPolygon{{17, 13}, {22, 19}, {19, 22}, {15, 20}});
                painter.setBrush(QColor(205, 211, 218));
                painter.drawPolygon(QPolygon{{3, 11}, {11, 4}, {19, 12}, {11, 20}});
                painter.setBrush(Qt::white);
                painter.drawPolygon(QPolygon{{3, 11}, {11, 7}, {19, 12}, {11, 15}});
                painter.drawArc(6, 1, 10, 12, 0, 180 * 16);
                break;
            case Tool::Picker:
                painter.setPen(QPen(QColor(32, 32, 32), 2));
                painter.drawLine(4, 20, 14, 10);
                painter.drawLine(7, 21, 17, 11);
                painter.drawLine(3, 21, 7, 21);
                painter.setBrush(QColor(40, 77, 124));
                painter.drawPolygon(QPolygon{{12, 7}, {17, 2}, {22, 7}, {17, 12}});
                painter.drawLine(11, 7, 18, 14);
                break;
            case Tool::Line:
                painter.setPen(QPen(QColor(32, 32, 32), 2));
                painter.drawLine(4, 4, 20, 20);
                break;
            case Tool::Curve: {
                painter.setPen(QPen(QColor(32, 32, 32), 2));
                QPainterPath path(QPointF(7, 3));
                path.cubicTo(25, 8, -1, 16, 17, 21);
                painter.drawPath(path);
                break;
            }
            case Tool::Rectangle:
                painter.setPen(QPen(QColor(32, 32, 32), 2));
                painter.drawRect(4, 5, 16, 14);
                break;
            case Tool::RoundRectangle:
                painter.setPen(QPen(QColor(32, 32, 32), 2));
                painter.drawRoundedRect(4, 5, 16, 14, 4, 4);
                break;
            case Tool::Ellipse:
                painter.setPen(QPen(QColor(32, 32, 32), 2));
                painter.drawEllipse(3, 6, 18, 12);
                break;
            case Tool::Polygon:
                painter.setPen(QPen(QColor(32, 32, 32), 2));
                painter.drawPolygon(QPolygon{{4, 19}, {9, 4}, {20, 4}, {15, 11}, {21, 19}});
                break;
            case Tool::Select:
                painter.setPen(QPen(QColor(32, 32, 32), 1, Qt::DashLine));
                painter.drawRect(3, 4, 18, 16);
                break;
            case Tool::FreeSelect:
                painter.setPen(QPen(QColor(32, 32, 32), 1, Qt::DashLine));
                painter.drawPolygon(
                    QPolygon{{3, 17}, {7, 10}, {4, 5}, {13, 3}, {20, 8}, {17, 20}, {10, 17}, {7, 21}});
                break;
            case Tool::Text:
                painter.setPen(QPen(QColor(32, 32, 32), 2));
                painter.drawPolyline(QPolygon{{5, 20}, {12, 3}, {19, 20}});
                painter.drawLine(8, 14, 16, 14);
                painter.drawLine(3, 20, 8, 20);
                painter.drawLine(16, 20, 21, 20);
                break;
            case Tool::Pan: {
                painter.setBrush(QColor(250, 234, 200));
                QPainterPath path(QPointF(8, 20));
                path.lineTo(3, 13);
                path.quadTo(2, 10, 5, 11);
                path.lineTo(8, 14);
                path.lineTo(8, 5);
                path.quadTo(10, 2, 11, 5);
                path.lineTo(11, 10);
                path.lineTo(11, 3);
                path.quadTo(13, 1, 14, 4);
                path.lineTo(14, 10);
                path.lineTo(14, 5);
                path.quadTo(17, 3, 17, 6);
                path.lineTo(17, 11);
                path.quadTo(21, 6, 21, 11);
                path.lineTo(19, 20);
                path.closeSubpath();
                painter.drawPath(path);
                break;
            }
            }
            painter.end();
            icon.addPixmap(pixmap);
        }
        auto *toolAction = new QAction(icon, definition.name, this);
        toolAction->setData(int(definition.tool));
        toolAction->setCheckable(true);
        group->addAction(toolAction);
        tools << toolAction;
        auto *button = new QToolButton;
        button->setDefaultAction(toolAction);
        button->setToolButtonStyle(Qt::ToolButtonIconOnly);
        button->setIconSize(QSize(24, 24));
        button->setFixedSize(36, 34);
        button->setToolTip(definition.name);
        button->setAccessibleName(definition.name);
        toolLayout->addWidget(button, toolIndex / 2, toolIndex % 2);
        connect(toolAction, &QAction::triggered, this,
                [this, tool = definition.tool] { run([this, tool] { canvas->setTool(tool); }); });
        ++toolIndex;
    }
    toolBar->addWidget(toolWidget);
    tools.front()->setChecked(true);
    auto *options = addToolBar(QStringLiteral("도구 옵션"));
    options->setMovable(false);
    options->addWidget(new QLabel(QStringLiteral(" 굵기 ")));
    auto *width = new QSpinBox;
    width->setRange(1, 100);
    width->setValue(3);
    width->setAccessibleName(QStringLiteral("선 굵기"));
    options->addWidget(width);
    connect(width, &QSpinBox::valueChanged, this, [this](int value) { canvas->thickness = value; });
    auto *shape = new QComboBox;
    shape->setAccessibleName(QStringLiteral("도형 그리기 방식"));
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
    connect(opaqueText, &QCheckBox::toggled, this, [this](bool value) {
        canvas->transparentText = !value;
        canvas->updateTextStyle();
    });
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
        button->setAccessibleName(QStringLiteral("색상 %1").arg(hex));
        button->setAccessibleDescription(
            QStringLiteral("왼쪽 클릭으로 전경색, 오른쪽 클릭으로 배경색을 선택합니다."));
        palette->addWidget(button);
        connect(button, &QPushButton::clicked, this, [this, hex] {
            canvas->foreground = QColor(hex);
            canvas->updateTextStyle();
            sync();
        });
        button->setContextMenuPolicy(Qt::CustomContextMenu);
        connect(button, &QWidget::customContextMenuRequested, this, [this, hex] {
            run([this, hex] {
                State candidate = canvas->pendingState();
                candidate.background = QColor(hex);
                doc.commit(std::move(candidate), QStringLiteral("배경색 설정"));
                canvas->cancel();
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
        const QStringList descriptions = {
            QStringLiteral("레이어 추가"),        QStringLiteral("레이어 삭제"),
            QStringLiteral("레이어 위로 이동"),   QStringLiteral("레이어 아래로 이동"),
            QStringLiteral("아래 레이어와 병합"), QStringLiteral("레이어 이름 변경")};
        button->setAccessibleName(descriptions[i]);
        button->setToolTip(descriptions[i]);
        row->addWidget(button);
        layerButtons.push_back(button);
        connect(button, &QPushButton::clicked, this, [this, i] {
            run([this, i] {
                if (i == 5) {
                    auto *dialog = new QInputDialog(this);
                    dialog->setWindowTitle(QStringLiteral("레이어 이름"));
                    dialog->setLabelText(QStringLiteral("이름"));
                    dialog->setTextValue(doc.state().layers[doc.state().active].name);
                    finishDialog(dialog, [this, dialog](int result) {
                        if (result == QDialog::Accepted && !dialog->textValue().isEmpty())
                            editLayer(QStringLiteral("이름"), [dialog](State &state) {
                                state.layers[state.active].name = dialog->textValue();
                            });
                    });
                    return;
                }
                editLayer(
                    QStringLiteral("레이어"),
                    [i](State &s) {
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
                    },
                    i == 2 || i == 3 ? CommitMode::Structural : CommitMode::Automatic);
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
    connect(canvas, &Canvas::errorOccurred, this,
            [this](const QString &message) { showMessage(QStringLiteral("편집 실패"), message); });
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
#ifdef Q_OS_WASM
    initializeBrowser();
#else
    const QString data = QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation);
    if (data.isEmpty() || !QDir().mkpath(data)) {
        preserveRecovery = true;
        recoveryErrorShown = true;
        statusBar()->showMessage(
            QStringLiteral("복구 폴더에 접근할 수 없습니다. 다른 위치에 직접 저장하세요."));
    }
    recoveryPath = data + QStringLiteral("/recovery.rpaint");
    auto *recovery = new QTimer(this);
    recovery->setObjectName(QStringLiteral("recoveryStart"));
    recovery->setInterval(30000);
    connect(recovery, &QTimer::timeout, this, [this] {
        if (preserveRecovery || fileWorkActive || recoveryWork.valid() || !doc.dirty() ||
            doc.revision() == recoveredRevision)
            return;
        try {
            State snapshot = doc.state();
            auto cancelled = std::make_shared<std::atomic_bool>(false);
            recoveryWorkRevision = doc.revision();
            recoveryWork = std::async(std::launch::async, [snapshot = std::move(snapshot),
                                                           path = recoveryPath, cancelled,
                                                           uiThread = thread()] {
                auto file = Document::stageProject(snapshot, path, [cancelled] { return cancelled->load(); });
                file->moveToThread(uiThread);
                return file;
            });
            recoveryCancel = std::move(cancelled);
        } catch (const std::exception &) {
            recoveryErrorShown = true;
            statusBar()->showMessage(QStringLiteral("자동 복구 저장 실패. 다른 위치에 직접 저장하세요."));
            sync();
        }
    });
    auto *recoveryPoll = new QTimer(this);
    recoveryPoll->setInterval(50);
    connect(recoveryPoll, &QTimer::timeout, this, [this] {
        if (fileWorkActive || !recoveryWork.valid() ||
            recoveryWork.wait_for(std::chrono::milliseconds(0)) != std::future_status::ready)
            return;
        bool saved = false;
        try {
            auto file = recoveryWork.get();
            if (!preserveRecovery && !recoveryCancel->load() && doc.dirty() &&
                doc.revision() == recoveryWorkRevision) {
                if (!file->commit())
                    throw std::runtime_error(file->errorString().toStdString());
                recoveredRevision = recoveryWorkRevision;
                recoveryErrorShown = false;
                saved = true;
            }
        } catch (const std::exception &) {
            if (!recoveryCancel || !recoveryCancel->load()) {
                recoveryErrorShown = true;
                statusBar()->showMessage(QStringLiteral("자동 복구 저장 실패. 다른 위치에 직접 저장하세요."));
            }
        }
        recoveryCancel.reset();
        sync();
        emit recoveryFinished(recoveryWorkRevision, saved);
    });
    recoveryPoll->start();
    recovery->start();
#endif
    sync();
}
void MainWindow::sync() noexcept try {
    canvas->background = doc.state().background;
    const bool pending = canvas->hasPendingEdit();
#ifdef Q_OS_WASM
    if (browser)
        browser->setDirty(doc.dirty() || pending);
#endif
    setWindowTitle(QStringLiteral("%1%2%3 - RetroPaint")
                       .arg(doc.dirty() ? QStringLiteral("* ") : QString(),
                            doc.path.isEmpty() ? QStringLiteral("제목 없음") : QFileInfo(doc.path).fileName(),
                            pending ? QStringLiteral(" (편집 중)") : QString()));
    undoAction->setEnabled(doc.canUndo() || pending);
    redoAction->setEnabled(doc.canRedo() && !pending);
    undoAction->setText(pending ? QStringLiteral("현재 편집 취소")
                                : QStringLiteral("실행 취소 %1").arg(doc.undoLabel()));
    redoAction->setText(QStringLiteral("다시 실행 %1").arg(doc.redoLabel()));
    deleteSelectionAction->setEnabled(canvas->hasSelection());
    cropAction->setEnabled(canvas->hasSelection());
    QSignalBlocker blocker(layerList);
    if (layerList->count() != doc.state().layers.size()) {
        layerList->clear();
        for (const auto &layer : doc.state().layers) {
            auto *item = new QListWidgetItem(layer.name, layerList);
            item->setFlags(item->flags() | Qt::ItemIsUserCheckable);
        }
    }
    for (int i = 0; i < layerList->count(); ++i) {
        const auto &layer = doc.state().layers[i];
        layerList->item(i)->setText(layer.name);
        layerList->item(i)->setCheckState(layer.visible ? Qt::Checked : Qt::Unchecked);
    }
    layerList->setCurrentRow(doc.state().active);
    const auto &state = doc.state();
    layerButtons[0]->setEnabled(
        state.layers.size() < MaxLayers &&
        qint64(state.size.width()) * state.size.height() * (state.layers.size() + 1) <= MaxDocumentPixels);
    layerButtons[1]->setEnabled(state.layers.size() > 1);
    layerButtons[2]->setEnabled(state.active + 1 < state.layers.size());
    layerButtons[3]->setEnabled(state.active > 0);
    layerButtons[4]->setEnabled(state.active > 0 && state.layers[state.active].visible &&
                                state.layers[state.active - 1].visible);
    for (auto *toolAction : tools)
        toolAction->setChecked(toolAction->data().toInt() == int(canvas->tool));
    status->setText(
        QStringLiteral("%1 × %2 px  |  %3%  |  %4  |  전경 %5 / 배경 %6  |  Undo %7 MiB%8")
            .arg(state.size.width())
            .arg(state.size.height())
            .arg(qRound(canvas->zoom * 100))
            .arg(state.layers[state.active].name, canvas->foreground.name(), canvas->background.name())
            .arg(doc.historyBytes() / 1024 / 1024)
            .arg(recoveryErrorShown ? QStringLiteral(" | 복구 저장 확인 필요") : QString()));
} catch (...) {
    std::fprintf(stderr, "RetroPaint: insufficient resources to refresh window controls\n");
}
void MainWindow::editLayer(const QString &label, const std::function<void(State &)> &edit, CommitMode mode) {
    State candidate = canvas->pendingState();
    edit(candidate);
    doc.commit(std::move(candidate), label, mode);
    canvas->cancel();
}
void MainWindow::clearRecovery() noexcept try {
#ifdef Q_OS_WASM
    ++browserEpoch;
    recoveredRevision = 0;
    preserveRecovery = false;
    recoveryErrorShown = false;
    if (browser)
        browser->request(0, QStringLiteral("reset"));
#else
    if (recoveryCancel)
        *recoveryCancel = true;
    if (preserveRecovery)
        return;
    if (!doc.path.isEmpty() && isRecoveryPath(doc.path)) {
        preserveRecovery = true;
        recoveryErrorShown = true;
        statusBar()->showMessage(
            QStringLiteral("복구 파일을 직접 열었습니다. 별도 이름으로 저장하세요. 자동 복구를 중지합니다."));
        return;
    }
    if (QFile::exists(recoveryPath) && !QFile::remove(recoveryPath)) {
        recoveryErrorShown = true;
        statusBar()->showMessage(
            QStringLiteral("이전 복구 파일을 지우지 못했습니다. 다음 실행에서 다시 표시될 수 있습니다."));
    } else {
        recoveryErrorShown = false;
    }
#endif
} catch (...) {
    recoveryErrorShown = true;
    std::fprintf(stderr, "RetroPaint: recovery cleanup failed\n");
}
bool MainWindow::isRecoveryPath(const QString &path) const {
    const QFileInfo target(path), recovery(recoveryPath);
#ifdef Q_OS_WIN
    if (target.absoluteFilePath().compare(recovery.absoluteFilePath(), Qt::CaseInsensitive) == 0)
#else
    if (target.absoluteFilePath() == recovery.absoluteFilePath())
#endif
        return true;
    // Missing paths must not compare equal merely because both canonical paths are empty.
    return target.exists() && recovery.exists() && target == recovery;
}
#ifndef Q_OS_WASM
std::unique_ptr<QSaveFile> MainWindow::stageFile(const State &state, const QString &path,
                                                 const QByteArray &format) {
    QScopedValueRollback<bool> busy(fileWorkActive, true);
    if (recoveryCancel)
        *recoveryCancel = true;
    const auto revision = doc.revision();
    const int active = doc.state().active;
    FileProgressDialog dialog(this);
    dialog.setWindowTitle(QStringLiteral("그림 저장"));
    dialog.setWindowModality(Qt::ApplicationModal);
    QVBoxLayout layout(&dialog);
    QLabel message(QStringLiteral("그림 저장 중…"));
    QProgressBar progress;
    progress.setRange(0, 0);
    QPushButton cancel(QStringLiteral("취소"));
    dialog.message = &message;
    dialog.cancelButton = &cancel;
    layout.addWidget(&message);
    layout.addWidget(&progress);
    layout.addWidget(&cancel);
    connect(&cancel, &QPushButton::clicked, &dialog, &FileProgressDialog::reject);
    auto future =
        std::async(std::launch::async, [this, snapshot = state, path, format, &dialog, uiThread = thread()] {
            // The UI poller leaves this future untouched while fileWorkActive is true.
            if (recoveryWork.valid())
                recoveryWork.wait();
            if (dialog.cancelled)
                return std::unique_ptr<QSaveFile>();
            auto file =
                format == "rpaint"
                    ? Document::stageProject(snapshot, path, [&dialog] { return dialog.cancelled.load(); })
                    : Document::stageImage(snapshot, path, format);
            file->moveToThread(uiThread);
            return file;
        });
    QTimer poll;
    poll.setInterval(15);
    connect(&poll, &QTimer::timeout, &dialog, [&] {
        if (future.wait_for(std::chrono::milliseconds(0)) == std::future_status::ready)
            dialog.accept();
    });
    poll.start();
    dialog.exec();
    std::unique_ptr<QSaveFile> file;
    try {
        file = future.get();
    } catch (...) {
        if (dialog.cancelled)
            return {};
        throw;
    }
    if (dialog.cancelled)
        return {};
    if (doc.revision() != revision || doc.state().active != active)
        throw std::runtime_error("저장 중 문서가 변경되었습니다. 다시 저장하세요.");
    return file;
}
#endif
bool MainWindow::save(bool saveAs) {
#ifdef Q_OS_WASM
    downloadBrowser("rpaint", saveAs);
    return false;
#else
    QGuiApplication::inputMethod()->commit();
    bool requiresProject;
    {
        const State candidate = canvas->pendingState();
        requiresProject = candidate.layers.size() > 1 || !candidate.layers.front().visible;
    }
    QString path = doc.path;
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
            requiresProject ? QStringLiteral("RetroPaint (*.rpaint)")
                            : QStringLiteral("RetroPaint (*.rpaint);;PNG (*.png);;JPEG (*.jpg);;BMP (*.bmp)"),
            &selectedFilter);
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
    if (isRecoveryPath(path))
        throw std::runtime_error("자동 복구 전용 경로입니다. 다른 이름으로 저장하세요.");
    if (suffix != QStringLiteral("rpaint") && requiresProject) {
        QMessageBox::information(
            this, QStringLiteral("레이어 보존"),
            QStringLiteral("레이어 문서는 .rpaint로 저장하세요. 평면 이미지는 내보내기를 사용하세요."));
        return false;
    }
    State candidate = canvas->pendingState();
    auto file = stageFile(candidate, path, suffix.toLatin1());
    if (!file)
        return false;
    auto edit = doc.prepare(std::move(candidate), QStringLiteral("편집 확정"));
    if (!file->commit())
        throw std::runtime_error(file->errorString().toStdString());
    // No events or allocating document operations between file commit and installation.
    doc.install(std::move(edit));
    doc.path.swap(path);
    doc.markSaved();
    clearRecovery();
    try {
        canvas->cancel();
        sync();
    } catch (...) {
        std::fprintf(stderr, "RetroPaint: file saved; canvas refresh failed\n");
    }
    return true;
#endif
}
#ifndef Q_OS_WASM
bool MainWindow::maybeSave() {
    if (!doc.dirty() && (!canvas->hasPendingEdit() ||
                         !doc.prepare(canvas->pendingState(), QStringLiteral("편집 확인")).changed()))
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
#endif
void MainWindow::openFile(const QString &path) {
    // Parse completely before asking to replace the current document.
    State loaded = path.endsWith(QStringLiteral(".rpaint"), Qt::CaseInsensitive) ? Document::readProject(path)
                                                                                 : Document::readImage(path);
    requestReplacement([this, path, loaded = std::move(loaded)]() mutable {
        doc.reset(std::move(loaded), path);
        clearRecovery();
        canvas->cancel();
        canvas->background = doc.state().background;
        canvas->refresh();
        sync();
    });
}
void MainWindow::changeSize(bool scale) {
    auto *dialog = new QDialog(this);
    dialog->setWindowTitle(scale ? QStringLiteral("이미지 크기") : QStringLiteral("캔버스 크기"));
    auto *layout = new QFormLayout(dialog);
    auto *width = new QSpinBox(dialog);
    auto *height = new QSpinBox(dialog);
    width->setRange(1, MaxDimension);
    height->setRange(1, MaxDimension);
    width->setValue(doc.state().size.width());
    height->setValue(doc.state().size.height());
    layout->addRow(QStringLiteral("너비 (픽셀)"), width);
    layout->addRow(QStringLiteral("높이 (픽셀)"), height);
    auto *ratio = new QCheckBox(QStringLiteral("비율 유지"), dialog);
    ratio->setChecked(scale);
    layout->addRow(ratio);
    const double aspect = double(width->value()) / height->value();
    connect(width, &QSpinBox::valueChanged, dialog, [=](int value) {
        if (ratio->isChecked()) {
            QSignalBlocker block(height);
            height->setValue(qRound(value / aspect));
        }
    });
    connect(height, &QSpinBox::valueChanged, dialog, [=](int value) {
        if (ratio->isChecked()) {
            QSignalBlocker block(width);
            width->setValue(qRound(value * aspect));
        }
    });
    auto *smooth = new QCheckBox(QStringLiteral("부드러운 보간"), dialog);
    smooth->setVisible(scale);
    if (scale)
        layout->addRow(smooth);
    layout->addRow(
        new QLabel(scale ? QStringLiteral("그림 자체의 크기를 변경합니다.")
                         : QStringLiteral("좌상단 기준 작업 공간 변경. 잘린 부분은 Undo로 복원합니다."),
                   dialog));
    auto *buttons = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel, dialog);
    layout->addRow(buttons);
    connect(buttons, &QDialogButtonBox::accepted, dialog, &QDialog::accept);
    connect(buttons, &QDialogButtonBox::rejected, dialog, &QDialog::reject);
    finishDialog(dialog, [=, this](int result) {
        if (result != QDialog::Accepted)
            return;
        doc.commit(Document::resized(canvas->pendingState(), QSize(width->value(), height->value()), scale,
                                     smooth->isChecked()),
                   QStringLiteral("크기 변경"));
        canvas->cancel();
    });
}
void MainWindow::checkRecovery() {
#ifdef Q_OS_WASM
    if (!fileWorkActive && !canvas->hasActiveGesture())
        startBrowserRequest(QStringLiteral("recover"));
#else
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
#endif
}
void MainWindow::closeEvent(QCloseEvent *event) {
#ifdef Q_OS_WASM
    event->ignore();
    showMessage(QStringLiteral("웹 그림판"),
                QStringLiteral("프로젝트를 다운로드한 뒤 브라우저 탭을 닫으세요."), QMessageBox::Information);
#else
    if (fileWorkActive) {
        event->ignore();
        return;
    }
    try {
        if (!maybeSave()) {
            event->ignore();
            return;
        }
        clearRecovery();
        event->accept();
    } catch (const std::exception &error) {
        showMessage(QStringLiteral("저장 실패"), QString::fromUtf8(error.what()));
        event->ignore();
    }
#endif
}
void MainWindow::finishDialog(QDialog *dialog, std::function<void(int)> finished) {
#ifdef Q_OS_WASM
    ++browserDialogCount;
    connect(dialog, &QDialog::finished, this, [this, dialog, finished = std::move(finished)](int result) {
        --browserDialogCount;
        if (finished)
            run([&] { finished(result); });
        dialog->deleteLater();
    });
    dialog->setWindowModality(Qt::ApplicationModal);
    dialog->open();
#else
    const int result = dialog->exec();
    if (finished)
        run([&] { finished(result); });
    dialog->deleteLater();
#endif
}
void MainWindow::showMessage(const QString &title, const QString &message, QMessageBox::Icon icon) {
    finishDialog(new QMessageBox(icon, title, message, QMessageBox::Ok, this));
}
#ifndef Q_OS_WASM
void MainWindow::chooseFile(bool insert, bool) {
    const QString path = QFileDialog::getOpenFileName(
        this, insert ? QStringLiteral("사진 삽입") : QStringLiteral("그림 열기"), {},
        insert
            ? QStringLiteral("이미지 (*.png *.jpg *.jpeg *.bmp *.gif)")
            : QStringLiteral("이미지 / 프로젝트 (*.png *.jpg *.jpeg *.bmp *.gif *.rpaint);;모든 파일 (*)"));
    if (path.isEmpty())
        return;
    if (insert)
        canvas->paste(Document::readImage(path).layers.front().image);
    else
        openFile(path);
}
void MainWindow::requestReplacement(std::function<void()> continuation) {
    if (maybeSave())
        continuation();
}
#endif
} // namespace paint
