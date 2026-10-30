#include "canvas.h"
#include <QAbstractTextDocumentLayout>
#include <QApplication>
#include <QClipboard>
#include <QDragEnterEvent>
#include <QDropEvent>
#include <QKeyEvent>
#include <QMimeData>
#include <QMouseEvent>
#include <QPaintEvent>
#include <QPainter>
#include <QProgressDialog>
#include <QRandomGenerator>
#include <QScrollArea>
#include <QScrollBar>
#include <QTextDocument>
#include <QTextEdit>
#include <QUrl>
#include <QWheelEvent>
#include <QtMath>
#include <atomic>
#include <cmath>
#include <future>
#include <numbers>

namespace paint {
Canvas::Canvas(Document &document, QWidget *parent) : QWidget(parent), doc(document) {
    setFocusPolicy(Qt::StrongFocus);
    setMouseTracking(true);
    setAcceptDrops(true);
    textFont = QFont(QStringLiteral("Sans Serif"), 18);
    spray.setInterval(35);
    connect(&spray, &QTimer::timeout, this, [this] {
        if (dragging) {
            drawStroke(hover, hover);
            update();
        }
    });
    refresh();
}
QPoint Canvas::documentPoint(QPointF point) const {
    return QPoint(int(std::floor(point.x() / zoom)), int(std::floor(point.y() / zoom)));
}
QPoint Canvas::constrained(QPoint point, Qt::KeyboardModifiers modifiers) const {
    if (!(modifiers & Qt::ShiftModifier))
        return point;
    QPoint delta = point - start;
    if (tool == Tool::Line || tool == Tool::Curve) {
        double length = std::hypot(delta.x(), delta.y());
        double angle =
            std::round(std::atan2(delta.y(), delta.x()) / (std::numbers::pi / 4)) * (std::numbers::pi / 4);
        return start + QPoint(qRound(length * std::cos(angle)), qRound(length * std::sin(angle)));
    }
    int side = std::max(std::abs(delta.x()), std::abs(delta.y()));
    return start + QPoint(delta.x() < 0 ? -side : side, delta.y() < 0 ? -side : side);
}
void Canvas::refresh() {
    if (displayRevision != doc.revision()) {
        display = doc.composite();
        displayRevision = doc.revision();
    }
    resize(qCeil(doc.state().size.width() * zoom) + 10, qCeil(doc.state().size.height() * zoom) + 10);
    update();
}
void Canvas::setZoom(double value) {
    if (textEditor)
        settle();
    zoom = std::clamp(value, 0.015625, 16.0);
    refresh();
    emit changed();
}
void Canvas::setTool(Tool next) {
    settle();
    tool = next;
    setCursor(next == Tool::Pan ? Qt::OpenHandCursor : Qt::CrossCursor);
}
void Canvas::cancel() {
    spray.stop();
    dragging = moving = resizingSelection = resizingCanvas = panning = false;
    selectionFromDocument = selectionModified = false;
    selection = {};
    selectionRect = {};
    points.clear();
    curvePhase = 0;
    working = {};
    if (textEditor) {
        textEditor->deleteLater();
        textEditor = nullptr;
    }
    refresh();
    emit changed();
}
bool Canvas::settle() {
    spray.stop();
    if (textEditor) {
        auto *editor = static_cast<QTextEdit *>(textEditor);
        if (!editor->toPlainText().isEmpty()) {
            State candidate = doc.state();
            auto &image = candidate.layers[candidate.active].image;
            candidate.layers[candidate.active].visible = true;
            QPainter painter(&image);
            QRect rect(textPosition, QSize(qRound(editor->width() / zoom), qRound(editor->height() / zoom)));
            if (!transparentText)
                painter.fillRect(rect, background);
            painter.translate(rect.topLeft());
            QTextDocument document;
            document.setDefaultFont(textFont);
            document.setPlainText(editor->toPlainText());
            document.setTextWidth(rect.width());
            QAbstractTextDocumentLayout::PaintContext context;
            context.palette.setColor(QPalette::Text, foreground);
            document.documentLayout()->draw(&painter, context);
            painter.end();
            doc.commit(std::move(candidate), QStringLiteral("문자"));
        }
        editor->deleteLater();
        textEditor = nullptr;
        refresh();
        emit changed();
    }
    if (!selection.isNull()) {
        // Merely selecting transparent pixels must not replace them with the background.
        if (selectionFromDocument && !selectionModified) {
            selection = {};
            selectionRect = {};
            working = {};
            update();
            emit changed();
            return true;
        }
        State candidate = working;
        QSize needed(std::max(candidate.size.width(), selectionRect.right() + 1),
                     std::max(candidate.size.height(), selectionRect.bottom() + 1));
        if (needed != candidate.size)
            candidate = Document::resized(candidate, needed, false);
        candidate.layers[candidate.active].visible = true;
        QPainter painter(&candidate.layers[candidate.active].image);
        painter.drawImage(selectionRect, selection);
        painter.end();
        doc.commit(std::move(candidate), QStringLiteral("선택 / 붙여넣기"));
        selection = {};
        selectionRect = {};
        working = {};
        refresh();
        emit changed();
    }
    if (!points.isEmpty()) {
        State candidate = doc.state();
        candidate.layers[candidate.active].visible = true;
        drawShape(candidate.layers[candidate.active].image, hover);
        doc.commit(std::move(candidate), QStringLiteral("도형"));
        points.clear();
        curvePhase = 0;
        refresh();
        emit changed();
    }
    return true;
}
void Canvas::paste(QImage image) {
    if (image.isNull())
        return;
    Document::validateSize(image.size());
    settle();
    image = image.convertToFormat(QImage::Format_ARGB32_Premultiplied);
    if (image.isNull())
        throw std::bad_alloc();
    selection = std::move(image);
    selectionRect = QRect(QPoint(0, 0), selection.size());
    working = doc.state();
    selectionFromDocument = selectionModified = false;
    resize(qCeil(std::max(selection.width(), doc.state().size.width()) * zoom) + 10,
           qCeil(std::max(selection.height(), doc.state().size.height()) * zoom) + 10);
    tool = Tool::Select;
    setFocus();
    update();
    emit changed();
}
void Canvas::liftSelection(QPainterPath mask, QRect rect) {
    rect = rect.intersected(QRect(QPoint(0, 0), doc.state().size));
    if (rect.isEmpty())
        return;
    working = doc.state();
    QImage lifted = Document::allocate(rect.size());
    QPainter painter(&lifted);
    painter.translate(-rect.topLeft());
    painter.setClipPath(mask);
    painter.drawImage(0, 0, working.layers[working.active].image);
    painter.end();
    if (transparentSelection) {
        const QRgb key = qPremultiply(background.rgba());
        for (int y = 0; y < lifted.height(); ++y) {
            auto *row = reinterpret_cast<QRgb *>(lifted.scanLine(y));
            for (int x = 0; x < lifted.width(); ++x)
                if (row[x] == key)
                    row[x] = 0;
        }
    }
    QPainter erase(&working.layers[working.active].image);
    erase.setClipPath(mask);
    erase.setCompositionMode(QPainter::CompositionMode_Source);
    erase.fillRect(rect, working.layers.size() == 1 ? background : QColor(Qt::transparent));
    erase.end();
    selection = std::move(lifted);
    selectionRect = rect;
    selectionFromDocument = true;
    selectionModified = false;
    update();
    emit changed();
}
void Canvas::selectAll() {
    settle();
    QPainterPath path;
    path.addRect(QRect(QPoint(0, 0), doc.state().size));
    liftSelection(path, QRect(QPoint(0, 0), doc.state().size));
}
void Canvas::copy(bool cut) {
    if (selection.isNull()) {
        QApplication::clipboard()->setImage(doc.composite());
        if (cut) {
            selectAll();
            removeSelection();
        }
        return;
    }
    QApplication::clipboard()->setImage(selection);
    if (cut)
        removeSelection();
}
void Canvas::removeSelection() {
    if (selection.isNull())
        return;
    doc.commit(working, QStringLiteral("선택 삭제"));
    selection = {};
    selectionRect = {};
    working = {};
    refresh();
    emit changed();
}
void Canvas::crop() {
    if (selection.isNull())
        return;
    const QRect rect = selectionRect.intersected(QRect(QPoint(0, 0), doc.state().size));
    if (rect.isEmpty())
        return;
    settle();
    State candidate = doc.state();
    candidate.size = rect.size();
    for (auto &layer : candidate.layers)
        layer.image = layer.image.copy(rect);
    doc.commit(std::move(candidate), QStringLiteral("자르기"));
    refresh();
    emit changed();
}
void Canvas::transformSelection(const QTransform &transform) {
    if (!selection.isNull()) {
        const QRectF bounds = transform.mapRect(QRectF(QPointF(0, 0), selection.size()));
        if (!std::isfinite(bounds.width()) || !std::isfinite(bounds.height()) || bounds.width() > 32768 ||
            bounds.height() > 32768)
            throw std::runtime_error("선택 변형 크기가 너무 큽니다.");
        Document::validateSize(QSize(qCeil(bounds.width()), qCeil(bounds.height())));
        QImage transformed = selection.transformed(transform, Qt::FastTransformation);
        if (transformed.isNull() || qint64(transformed.width()) * transformed.height() > MaxPixels)
            throw std::runtime_error("선택 변형 크기가 너무 큽니다.");
        selection = transformed;
        selectionRect.setSize(selection.size());
        selectionModified = true;
        update();
        return;
    }
    settle();
    State candidate = doc.state();
    const QRectF bounds = transform.mapRect(QRectF(QPointF(0, 0), candidate.size));
    if (!std::isfinite(bounds.width()) || !std::isfinite(bounds.height()) || bounds.width() > 32768 ||
        bounds.height() > 32768)
        throw std::runtime_error("변형 결과의 레이어 메모리가 너무 큽니다.");
    Document::validateSize(QSize(qCeil(bounds.width()), qCeil(bounds.height())), candidate.layers.size());
    for (auto &layer : candidate.layers) {
        layer.image = layer.image.transformed(transform, Qt::FastTransformation);
        if (layer.image.isNull())
            throw std::bad_alloc();
    }
    candidate.size = candidate.layers.front().image.size();
    doc.commit(std::move(candidate), QStringLiteral("이미지 변형"));
    refresh();
    emit changed();
}
void Canvas::drawStroke(QPoint from, QPoint to) {
    auto &image = working.layers[working.active].image;
    const QColor color = rightButton ? background : foreground;
    if (tool == Tool::ColorEraser) {
        if (!image.bits())
            throw std::bad_alloc();
        const QRect rect = QRect(from, to)
                               .normalized()
                               .adjusted(-thickness, -thickness, thickness, thickness)
                               .intersected(image.rect());
        const QRgb key = qPremultiply(foreground.rgba()), value = qPremultiply(background.rgba());
        const QPoint delta = to - from;
        const double length = double(delta.x()) * delta.x() + double(delta.y()) * delta.y();
        for (int y = rect.top(); y <= rect.bottom(); ++y) {
            auto *row = reinterpret_cast<QRgb *>(image.scanLine(y));
            for (int x = rect.left(); x <= rect.right(); ++x) {
                const double t = length ? std::clamp(((x - from.x()) * double(delta.x()) +
                                                      (y - from.y()) * double(delta.y())) /
                                                         length,
                                                     0.0, 1.0)
                                        : 0;
                if (std::hypot(x - from.x() - t * delta.x(), y - from.y() - t * delta.y()) <=
                        thickness / 2.0 &&
                    row[x] == key)
                    row[x] = value;
            }
        }
        return;
    }
    QPainter painter(&image);
    if (tool == Tool::Spray) {
        painter.setPen(color);
        auto *random = QRandomGenerator::global();
        for (int i = 0; i < thickness * 2; ++i) {
            QPoint offset(random->bounded(thickness * 2 + 1) - thickness,
                          random->bounded(thickness * 2 + 1) - thickness);
            if (offset.x() * offset.x() + offset.y() * offset.y() <= thickness * thickness)
                painter.drawPoint(to + offset);
        }
    } else {
        const bool eraser = tool == Tool::Eraser;
        if (eraser)
            painter.setCompositionMode(QPainter::CompositionMode_Source);
        QColor ink = eraser ? (working.layers.size() > 1 ? QColor(Qt::transparent) : background) : color;
        painter.setPen(QPen(ink, tool == Tool::Pencil ? 1 : thickness, Qt::SolidLine,
                            brushSquare || eraser ? Qt::SquareCap : Qt::RoundCap, Qt::RoundJoin));
        painter.drawLine(from, to);
        if (from == to)
            painter.drawPoint(to);
    }
}
void Canvas::drawShape(QImage &image, QPoint end) {
    QPainter painter(&image);
    painter.setPen(outlineShape ? QPen(rightButton ? background : foreground, thickness) : QPen(Qt::NoPen));
    painter.setBrush(fillShape ? QBrush(rightButton ? foreground : background) : QBrush(Qt::NoBrush));
    QRect rect(start, end);
    rect = rect.normalized();
    switch (tool) {
    case Tool::Line:
        painter.setPen(QPen(rightButton ? background : foreground, thickness));
        painter.drawLine(start, end);
        break;
    case Tool::Rectangle:
        painter.drawRect(rect);
        break;
    case Tool::RoundRectangle:
        painter.drawRoundedRect(rect, 12, 12);
        break;
    case Tool::Ellipse:
        painter.drawEllipse(rect);
        break;
    case Tool::Polygon: {
        QPolygon polygon = points;
        if (dragging)
            polygon << end;
        painter.drawPolygon(polygon);
        break;
    }
    case Tool::Curve: {
        painter.setPen(QPen(rightButton ? background : foreground, thickness));
        if (points.size() < 2) {
            painter.drawLine(start, end);
            break;
        }
        QPainterPath path(points[0]);
        QPoint control1 = points.size() > 2 ? points[2] : end;
        QPoint control2 = points.size() > 3 ? points[3] : end;
        path.cubicTo(control1, control2, points[1]);
        painter.setBrush(Qt::NoBrush);
        painter.drawPath(path);
        break;
    }
    default:
        break;
    }
}
void Canvas::fillAt(QPoint point) {
    State candidate = doc.state();
    const int active = candidate.active;
    const QColor color = rightButton ? background : foreground;
    std::atomic_bool cancelled = false;
    auto future = std::async(
        std::launch::async, [image = candidate.layers[active].image, point, color, &cancelled]() mutable {
            bool changed = Document::flood(image, point, color, [&cancelled] { return cancelled.load(); });
            return std::make_pair(changed, std::move(image));
        });
    QProgressDialog progress(QStringLiteral("영역 채우기"), QStringLiteral("취소"), 0, 0, this);
    progress.setWindowModality(Qt::ApplicationModal);
    progress.setMinimumDuration(150);
    QTimer timer;
    timer.setInterval(15);
    connect(&timer, &QTimer::timeout, &progress, [&] {
        if (progress.wasCanceled())
            cancelled = true;
        if (future.wait_for(std::chrono::milliseconds(0)) == std::future_status::ready)
            progress.accept();
    });
    connect(&progress, &QProgressDialog::canceled, &progress, [&] { cancelled = true; });
    timer.start();
    progress.exec();
    cancelled = progress.wasCanceled();
    auto result = future.get();
    if (result.first && !cancelled) {
        candidate.layers[active].image = std::move(result.second);
        candidate.layers[active].visible = true;
        doc.commit(std::move(candidate), QStringLiteral("채우기"));
        refresh();
        emit changed();
    }
}
void Canvas::paintEvent(QPaintEvent *event) {
    QPainter painter(this);
    painter.fillRect(rect(), QColor(128, 128, 128));
    const QSize size =
        selection.isNull()
            ? doc.state().size
            : doc.state().size.expandedTo(QSize(selectionRect.right() + 1, selectionRect.bottom() + 1));
    const QRect paper(0, 0, qRound(size.width() * zoom), qRound(size.height() * zoom));
    painter.fillRect(paper, Qt::white);
    const QRect visible = event->rect().intersected(paper);
    for (int y = (visible.top() / 12) * 12; y <= visible.bottom(); y += 12)
        for (int x = (visible.left() / 24) * 24 + ((y / 12) % 2 ? 12 : 0); x <= visible.right(); x += 24)
            painter.fillRect(QRect(x, y, 12, 12).intersected(paper), QColor(225, 225, 225));
    painter.save();
    painter.scale(zoom, zoom);
    painter.setClipRect(QRect(QPoint(0, 0), size));
    if (dragging && !working.layers.isEmpty() && selection.isNull() && !resizingCanvas &&
        tool != Tool::Select && tool != Tool::FreeSelect && tool != Tool::Pan) {
        for (int i = 0; i < working.layers.size(); ++i)
            if (working.layers[i].visible) {
                if (i == working.active && tool >= Tool::Line && tool <= Tool::Polygon) {
                    QImage preview = working.layers[i].image;
                    drawShape(preview, hover);
                    painter.drawImage(0, 0, preview);
                } else
                    painter.drawImage(0, 0, working.layers[i].image);
            }
    } else if (!selection.isNull()) {
        if (selectionFromDocument && !selectionModified)
            painter.drawImage(0, 0, display);
        else
            for (int i = 0; i < working.layers.size(); ++i) {
                if (working.layers[i].visible || i == working.active)
                    painter.drawImage(0, 0, working.layers[i].image);
                if (i == working.active)
                    painter.drawImage(selectionRect, selection);
            }
    } else if (!points.isEmpty()) {
        QImage preview = doc.state().layers[doc.state().active].image;
        drawShape(preview, hover);
        for (int i = 0; i < doc.state().layers.size(); ++i)
            if (doc.state().layers[i].visible)
                painter.drawImage(0, 0, i == doc.state().active ? preview : doc.state().layers[i].image);
    } else
        painter.drawImage(0, 0, display);
    if (grid && zoom >= 4) {
        painter.setPen(QPen(QColor(150, 150, 150, 120), 0));
        for (int x = std::max(0, int(visible.left() / zoom));
             x <= std::min(size.width(), int(visible.right() / zoom) + 1); ++x)
            painter.drawLine(x, 0, x, size.height());
        for (int y = std::max(0, int(visible.top() / zoom));
             y <= std::min(size.height(), int(visible.bottom() / zoom) + 1); ++y)
            painter.drawLine(0, y, size.width(), y);
    }
    painter.setBrush(Qt::NoBrush);
    painter.setPen(QPen(Qt::black, 0, Qt::DashLine));
    if (!selection.isNull())
        painter.drawRect(selectionRect);
    if (dragging && (tool == Tool::Select || tool == Tool::FreeSelect) && selection.isNull()) {
        if (tool == Tool::Select)
            painter.drawRect(QRect(start, hover).normalized());
        else
            painter.drawPath(selectionMask);
    }
    if (resizingCanvas)
        painter.drawRect(QRect(QPoint(0, 0), canvasPreview));
    painter.restore();
    painter.setPen(Qt::black);
    painter.setBrush(Qt::white);
    painter.drawRect(QRect(paper.right() + 1, paper.bottom() + 1, 7, 7));
}
void Canvas::mousePressEvent(QMouseEvent *event) {
    setFocus();
    hover = documentPoint(event->position());
    rightButton = event->button() == Qt::RightButton;
    if (event->button() == Qt::MiddleButton || tool == Tool::Pan) {
        start = event->globalPosition().toPoint();
        dragging = panning = true;
        return;
    }
    if (event->button() != Qt::LeftButton && !rightButton)
        return;
    if (!selection.isNull()) {
        QRect handle(selectionRect.bottomRight() - QPoint(qCeil(6 / zoom), qCeil(6 / zoom)),
                     QSize(qCeil(12 / zoom), qCeil(12 / zoom)));
        if (handle.contains(hover)) {
            resizingSelection = true;
            dragging = true;
            return;
        }
        if (selectionRect.contains(hover)) {
            moving = true;
            dragging = true;
            selectionOffset = hover - selectionRect.topLeft();
            return;
        }
        settle();
    }
    if (hover.x() >= doc.state().size.width() || hover.y() >= doc.state().size.height()) {
        resizeWidth = hover.x() >= doc.state().size.width();
        resizeHeight = hover.y() >= doc.state().size.height();
        start = hover;
        canvasPreview = doc.state().size;
        resizingCanvas = true;
        dragging = true;
        return;
    }
    if (tool == Tool::Text) {
        settle();
        textPosition = hover;
        beginText();
        return;
    }
    if (tool == Tool::Picker) {
        emit colorPicked(display.pixelColor(hover));
        return;
    }
    if (tool == Tool::Fill) {
        settle();
        fillAt(hover);
        return;
    }
    if (tool == Tool::Curve && curvePhase > 0) {
        points << hover;
        if (points.size() == 4)
            settle();
        update();
        return;
    }
    if (tool == Tool::Polygon) {
        if (points.isEmpty())
            start = hover;
        points << hover;
        working = doc.state();
        dragging = false;
        update();
        return;
    }
    start = last = hover;
    working = doc.state();
    dragging = true;
    if (!working.layers[working.active].visible) {
        working.layers[working.active].visible = true;
    }
    if (tool == Tool::FreeSelect) {
        selectionMask = {};
        selectionMask.moveTo(start);
    }
    if (tool <= Tool::ColorEraser) {
        drawStroke(start, start);
        if (tool == Tool::Spray)
            spray.start();
    }
    update();
}
void Canvas::mouseMoveEvent(QMouseEvent *event) {
    hover = documentPoint(event->position());
    emit positionChanged(hover);
    if (!dragging) {
        update();
        return;
    }
    if (panning) {
        if (auto *area =
                parentWidget() ? qobject_cast<QScrollArea *>(parentWidget()->parentWidget()) : nullptr) {
            QPoint delta = event->globalPosition().toPoint() - start;
            area->horizontalScrollBar()->setValue(area->horizontalScrollBar()->value() - delta.x());
            area->verticalScrollBar()->setValue(area->verticalScrollBar()->value() - delta.y());
            start = event->globalPosition().toPoint();
        }
        return;
    }
    if (moving) {
        selectionRect.moveTopLeft(hover - selectionOffset);
        selectionModified = true;
    } else if (resizingSelection) {
        selectionRect.setBottomRight(
            QPoint(std::max(hover.x(), selectionRect.left()), std::max(hover.y(), selectionRect.top())));
        selectionModified = true;
    } else if (resizingCanvas)
        canvasPreview = QSize(resizeWidth ? std::clamp(hover.x(), 1, 32768) : doc.state().size.width(),
                              resizeHeight ? std::clamp(hover.y(), 1, 32768) : doc.state().size.height());
    else if (tool == Tool::FreeSelect)
        selectionMask.lineTo(hover);
    else if (tool <= Tool::ColorEraser) {
        drawStroke(last, hover);
        last = hover;
    } else
        hover = constrained(hover, event->modifiers());
    update();
}
void Canvas::mouseReleaseEvent(QMouseEvent *event) {
    if (!dragging)
        return;
    if (documentPoint(event->position()) != hover)
        mouseMoveEvent(event);
    spray.stop();
    dragging = false;
    if (panning) {
        panning = false;
        return;
    }
    if (moving || resizingSelection) {
        moving = resizingSelection = false;
        update();
        return;
    }
    if (resizingCanvas) {
        resizingCanvas = false;
        settle();
        doc.commit(Document::resized(doc.state(), canvasPreview, false), QStringLiteral("캔버스 크기"));
        refresh();
        emit changed();
        return;
    }
    if (tool == Tool::Pan)
        return;
    if (tool == Tool::Select || tool == Tool::FreeSelect) {
        QRect rect;
        if (tool == Tool::Select) {
            rect = QRect(start, hover).normalized();
            selectionMask = {};
            selectionMask.addRect(rect);
        } else {
            selectionMask.closeSubpath();
            rect = selectionMask.boundingRect().toAlignedRect();
        }
        liftSelection(selectionMask, rect);
        return;
    }
    if (tool == Tool::Curve) {
        points = {start, hover};
        curvePhase = 1;
        update();
        return;
    }
    if (tool >= Tool::Line && tool <= Tool::Ellipse)
        drawShape(working.layers[working.active].image, hover);
    doc.commit(std::move(working), QStringLiteral("그리기"));
    working = {};
    refresh();
    emit changed();
}
void Canvas::mouseDoubleClickEvent(QMouseEvent *) {
    if (tool == Tool::Polygon && points.size() >= 3)
        settle();
}
void Canvas::keyPressEvent(QKeyEvent *event) {
    if (event->key() == Qt::Key_Escape) {
        cancel();
        return;
    }
    if (event->key() == Qt::Key_Return || event->key() == Qt::Key_Enter) {
        settle();
        return;
    }
    if (event->key() == Qt::Key_Delete) {
        removeSelection();
        return;
    }
    if (!selection.isNull()) {
        QPoint delta;
        if (event->key() == Qt::Key_Left)
            delta = {-1, 0};
        if (event->key() == Qt::Key_Right)
            delta = {1, 0};
        if (event->key() == Qt::Key_Up)
            delta = {0, -1};
        if (event->key() == Qt::Key_Down)
            delta = {0, 1};
        if (event->modifiers() & Qt::ShiftModifier)
            delta *= 10;
        if (!delta.isNull())
            selectionModified = true;
        selectionRect.translate(delta);
        update();
    } else
        QWidget::keyPressEvent(event);
}
void Canvas::wheelEvent(QWheelEvent *event) {
    if (event->modifiers() & Qt::ControlModifier) {
        setZoom(zoom * (event->angleDelta().y() > 0 ? 1.25 : 0.8));
        event->accept();
    } else
        event->ignore();
}
void Canvas::dragEnterEvent(QDragEnterEvent *event) {
    if (event->mimeData()->hasImage() || event->mimeData()->hasUrls())
        event->acceptProposedAction();
}
void Canvas::dropEvent(QDropEvent *event) {
    const auto *mime = event->mimeData();
    if (mime->hasImage())
        paste(qvariant_cast<QImage>(mime->imageData()));
    else if (mime->hasUrls() && !mime->urls().isEmpty() && mime->urls().first().isLocalFile())
        emit fileDropped(mime->urls().first().toLocalFile());
    event->acceptProposedAction();
}
void Canvas::beginText() {
    auto *editor = new QTextEdit(this);
    textEditor = editor;
    editor->setPlainText({});
    editor->setFont(textFont);
    editor->setTextColor(foreground);
    updateTextStyle();
    editor->setAcceptRichText(false);
    editor->setGeometry(qRound(textPosition.x() * zoom), qRound(textPosition.y() * zoom),
                        std::max(120, qRound(260 * zoom)), std::max(70, qRound(120 * zoom)));
    editor->setStyleSheet(QStringLiteral("QTextEdit { border: 1px dashed black; background: white; }"));
    editor->installEventFilter(this);
    editor->show();
    editor->setFocus();
}
void Canvas::updateTextStyle() {
    if (!textEditor)
        return;
    auto *editor = static_cast<QTextEdit *>(textEditor);
    QFont font = textFont;
    if (font.pixelSize() > 0)
        font.setPixelSize(std::max(1, qRound(font.pixelSize() * zoom)));
    else
        font.setPointSizeF(std::max(1.0, font.pointSizeF() * zoom));
    editor->setFont(font);
    editor->document()->setDocumentMargin(4 * zoom);
    const QTextCursor cursor = editor->textCursor();
    editor->selectAll();
    QTextCharFormat format;
    format.setFont(font);
    format.setForeground(foreground);
    editor->mergeCurrentCharFormat(format);
    editor->setTextCursor(cursor);
}
bool Canvas::eventFilter(QObject *object, QEvent *event) {
    if (object == textEditor && event->type() == QEvent::KeyPress) {
        auto *key = static_cast<QKeyEvent *>(event);
        if (key->key() == Qt::Key_Escape) {
            cancel();
            setFocus();
            return true;
        }
        if (key->key() == Qt::Key_Return && (key->modifiers() & Qt::ControlModifier)) {
            settle();
            setFocus();
            return true;
        }
    }
    return QWidget::eventFilter(object, event);
}
bool Canvas::event(QEvent *event) {
    // A lost mouse grab must not leave the spray timer running indefinitely.
    if ((event->type() == QEvent::WindowDeactivate || event->type() == QEvent::UngrabMouse) && dragging) {
        cancel();
    }
    return QWidget::event(event);
}
} // namespace paint
