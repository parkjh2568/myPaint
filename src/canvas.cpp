#include "canvas.h"
#include <QAbstractTextDocumentLayout>
#include <QApplication>
#include <QClipboard>
#include <QDragEnterEvent>
#include <QDropEvent>
#include <QInputMethod>
#include <QInputMethodEvent>
#include <QKeyEvent>
#include <QMimeData>
#include <QMouseEvent>
#include <QPaintEvent>
#include <QPainter>
#include <QProgressDialog>
#include <QRandomGenerator>
#include <QScopedValueRollback>
#include <QScrollArea>
#include <QScrollBar>
#include <QTabletEvent>
#include <QTextDocument>
#include <QTextEdit>
#include <QUrl>
#include <QWheelEvent>
#include <QtMath>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <future>
#include <numbers>
#include <stdexcept>

namespace paint {
Canvas::Canvas(Document &document, QWidget *parent) : QWidget(parent), doc(document) {
    setFocusPolicy(Qt::StrongFocus);
    setMouseTracking(true);
    setAcceptDrops(true);
    textFont = QApplication::font();
    textFont.setPointSize(18);
    spray.setInterval(35);
    connect(&spray, &QTimer::timeout, this, [this] {
        try {
            if (dragging) {
                drawStroke(hover, hover);
                update();
            }
        } catch (const std::exception &error) {
            reportError(error);
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
    QSize size = doc.state().size;
    if (!selection.isNull())
        size = size.expandedTo(QSize(selectionRect.right() + 1, selectionRect.bottom() + 1));
    resize(qCeil(size.width() * zoom) + 10, qCeil(size.height() * zoom) + 10);
    update();
}
void Canvas::setZoom(double value) {
    if (!std::isfinite(value))
        throw std::runtime_error("확대율이 올바르지 않습니다.");
    const double previous = zoom;
    zoom = std::clamp(value, 0.015625, 16.0);
    if (textEditor) {
        textEditor->setGeometry(qRound(textPosition.x() * zoom), qRound(textPosition.y() * zoom),
                                std::max(1, qRound(textEditor->width() * zoom / previous)),
                                std::max(1, qRound(textEditor->height() * zoom / previous)));
        updateTextStyle();
    }
    refresh();
    emit changed();
}
void Canvas::setTool(Tool next) {
    settle();
    tool = next;
    setCursor(next == Tool::Pan ? Qt::OpenHandCursor : Qt::CrossCursor);
    emit changed();
}
void Canvas::cancel() {
    spray.stop();
    brushStroke = {};
    dragging = moving = resizingSelection = resizingCanvas = panning = false;
    gestureButton = Qt::NoButton;
    gestureDevice = nullptr;
    selectionFromDocument = selectionModified = false;
    selection = {};
    selectionRect = {};
    points.clear();
    curvePhase = 0;
    working = {};
    if (textEditor) {
        QGuiApplication::inputMethod()->reset();
        textComposing = false;
        textEditor->hide();
        textEditor->deleteLater();
        textEditor = nullptr;
    }
    refresh();
    emit changed();
}
void Canvas::recoverAfterError() {
    spray.stop();
    brushStroke = {};
    dragging = moving = resizingSelection = resizingCanvas = panning = false;
    gestureButton = Qt::NoButton;
    gestureDevice = nullptr;
    if (selection.isNull() && points.isEmpty())
        working = {};
    refresh();
    emit changed();
}
void Canvas::reportError(const std::exception &error) noexcept {
    try {
        recoverAfterError();
        emit errorOccurred(QString::fromUtf8(error.what()));
    } catch (...) {
        std::fprintf(stderr, "RetroPaint: insufficient resources to report an editing error\n");
    }
}
State Canvas::pendingState() const {
    if (textEditor && textComposing)
        throw std::runtime_error("문자 조합이 아직 끝나지 않았습니다. 입력을 확정한 뒤 다시 시도하세요.");
    State candidate = doc.state();
    if (textEditor && !textEditor->toPlainText().isEmpty()) {
        auto &layer = candidate.layers[candidate.active];
        layer.visible = true;
        if (!layer.image.bits())
            throw std::bad_alloc();
        QPainter painter(&layer.image);
        const qreal frame = textEditor->frameWidth() / zoom;
        const QRectF rect(QPointF(textPosition) + QPointF(frame, frame),
                          QSizeF(textEditor->viewport()->size()) / zoom);
        painter.setClipRect(rect);
        if (!transparentText)
            painter.fillRect(rect, background);
        const QPointF scroll(textEditor->horizontalScrollBar()->value() / zoom,
                             textEditor->verticalScrollBar()->value() / zoom);
        painter.translate(rect.topLeft() - scroll);
        QTextDocument document;
        document.setDefaultFont(textFont);
        document.setDocumentMargin(4);
        document.setPlainText(textEditor->toPlainText());
        document.setTextWidth(rect.width());
        QAbstractTextDocumentLayout::PaintContext context;
        context.palette.setColor(QPalette::Text, foreground);
        context.clip = QRectF(scroll, rect.size());
        document.documentLayout()->draw(&painter, context);
    } else if (!selection.isNull()) {
        // Merely selecting transparent pixels must not replace them with the background.
        if (selectionFromDocument && !selectionModified)
            return candidate;
        candidate = working;
        const QSize needed(std::max(candidate.size.width(), selectionRect.right() + 1),
                           std::max(candidate.size.height(), selectionRect.bottom() + 1));
        if (needed != candidate.size)
            candidate = Document::resized(candidate, needed, false);
        auto &layer = candidate.layers[candidate.active];
        layer.visible = true;
        if (!layer.image.bits())
            throw std::bad_alloc();
        QPainter painter(&layer.image);
        painter.drawImage(selectionRect, selection);
    } else if (!points.isEmpty() || (dragging && !panning && !resizingCanvas && tool != Tool::Select &&
                                     tool != Tool::FreeSelect)) {
        if (points.isEmpty())
            candidate = working;
        auto &layer = candidate.layers[candidate.active];
        layer.visible = true;
        if (!layer.image.bits())
            throw std::bad_alloc();
        QPainter painter(&layer.image);
        drawShape(painter, hover);
    } else if (resizingCanvas) {
        candidate = Document::resized(candidate, canvasPreview, false);
    }
    return candidate;
}
void Canvas::settle() {
    if (!hasPendingEdit())
        return;
    if (textEditor)
        QGuiApplication::inputMethod()->commit();
    doc.commit(pendingState(), textEditor          ? QStringLiteral("문자")
                               : hasSelection()    ? QStringLiteral("선택 / 붙여넣기")
                               : !points.isEmpty() ? QStringLiteral("도형")
                                                   : QStringLiteral("그리기"));
    cancel();
}
void Canvas::paste(QImage image) {
    if (image.isNull())
        return;
    Document::validateSize(image.size());
    if (image.sizeInBytes() > MaxInputBytes)
        throw std::runtime_error("붙여넣을 이미지 버퍼가 너무 큽니다.");
    image = image.convertToFormat(QImage::Format_ARGB32_Premultiplied);
    if (image.bytesPerLine() != image.width() * 4)
        image = image.copy();
    if (image.isNull())
        throw std::bad_alloc();
    const auto base = pendingState();
    Document::validateSize(base.size.expandedTo(image.size()), base.layers.size());
    settle();
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
void Canvas::pasteClipboard() {
#ifdef Q_OS_WASM
    emit clipboardReadRequested(textEditor != nullptr);
    return;
#else
    if (textEditor) {
        textEditor->paste();
        return;
    }
    const QImage image = QApplication::clipboard()->image();
    if (image.isNull())
        throw std::runtime_error("클립보드에 이미지가 없습니다.");
    paste(image);
#endif
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
    if (textEditor) {
#ifdef Q_OS_WASM
        QGuiApplication::inputMethod()->commit();
        if (textComposing)
            throw std::runtime_error("문자 조합을 먼저 확정하세요.");
        if (textEditor->textCursor().hasSelection())
            emit clipboardTextWriteRequested(
                textEditor->textCursor().selectedText().replace(QChar(0x2029), QChar(10)), cut);
#else
        if (cut)
            textEditor->cut();
        else
            textEditor->copy();
#endif
        return;
    }
    if (!cut) {
#ifdef Q_OS_WASM
        emit clipboardWriteRequested(
            selection.isNull() ? Document::flatten(pendingState()) : selectionImage(), false, {});
#else
        QApplication::clipboard()->setImage(selection.isNull() ? Document::flatten(pendingState())
                                                               : selectionImage());
#endif
        return;
    }
    State candidate = selection.isNull() ? pendingState() : working;
    QImage copied = selection.isNull() ? candidate.layers[candidate.active].image : selectionImage();
    if (selection.isNull()) {
        if (transparentSelection) {
            if (!copied.bits())
                throw std::bad_alloc();
            const QRgb key = qPremultiply(background.rgba());
            for (int y = 0; y < copied.height(); ++y) {
                auto *row = reinterpret_cast<QRgb *>(copied.scanLine(y));
                for (int x = 0; x < copied.width(); ++x)
                    if (row[x] == key)
                        row[x] = 0;
            }
        }
        if (!candidate.layers[candidate.active].image.bits())
            throw std::bad_alloc();
        candidate.layers[candidate.active].image.fill(candidate.layers.size() == 1 ? background
                                                                                   : QColor(Qt::transparent));
    }
#ifdef Q_OS_WASM
    emit clipboardWriteRequested(copied, true, std::move(candidate));
#else
    auto edit = doc.prepare(std::move(candidate), QStringLiteral("잘라내기"));
    QApplication::clipboard()->setImage(copied);
    doc.install(std::move(edit));
    cancel();
#endif
}
#ifdef Q_OS_WASM
void Canvas::completeTextCut() {
    if (!textEditor)
        throw std::runtime_error("문자 편집이 변경되었습니다.");
    auto cursor = textEditor->textCursor();
    cursor.removeSelectedText();
    emit changed();
}
void Canvas::insertClipboardText(const QString &text) {
    if (!textEditor || textComposing ||
        textEditor->document()->characterCount() - 1 - textEditor->textCursor().selectedText().size() +
                text.size() >
            65536)
        throw std::runtime_error("문자 조합 상태 또는 붙여넣기 크기를 확인하세요 (최대 65536자).");
    textEditor->insertPlainText(text);
    emit changed();
}
#endif
QImage Canvas::selectionImage() const {
    Document::validateSize(selectionRect.size());
    QImage image =
        selection.size() == selectionRect.size()
            ? selection
            : selection.scaled(selectionRect.size(), Qt::IgnoreAspectRatio, Qt::FastTransformation);
    if (image.isNull())
        throw std::bad_alloc();
    return image;
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
    State candidate = pendingState();
    const QRect rect = selectionRect.intersected(QRect(QPoint(0, 0), candidate.size));
    if (rect.isEmpty())
        return;
    candidate.size = rect.size();
    for (auto &layer : candidate.layers) {
        layer.image = layer.image.copy(rect);
        if (layer.image.isNull())
            throw std::bad_alloc();
    }
    doc.commit(std::move(candidate), QStringLiteral("자르기"));
    cancel();
}
void Canvas::transformSelection(const QTransform &transform) {
    if (!selection.isNull()) {
        const QRectF bounds = transform.mapRect(QRectF(QPointF(0, 0), selectionRect.size()));
        if (!std::isfinite(bounds.width()) || !std::isfinite(bounds.height()) ||
            bounds.width() > MaxDimension || bounds.height() > MaxDimension)
            throw std::runtime_error("선택 변형 크기가 너무 큽니다.");
        Document::validateSize(QSize(qCeil(bounds.width()), qCeil(bounds.height())));
        QImage transformed = selectionImage().transformed(transform, Qt::FastTransformation);
        if (transformed.isNull() || qint64(transformed.width()) * transformed.height() > MaxPixels)
            throw std::runtime_error("선택 변형 크기가 너무 큽니다.");
        selection = transformed;
        selectionRect.setSize(selection.size());
        selectionModified = true;
        refresh();
        emit changed();
        return;
    }
    State candidate = pendingState();
    const QRectF bounds = transform.mapRect(QRectF(QPointF(0, 0), candidate.size));
    if (!std::isfinite(bounds.width()) || !std::isfinite(bounds.height()) || bounds.width() > MaxDimension ||
        bounds.height() > MaxDimension)
        throw std::runtime_error("변형 결과의 레이어 메모리가 너무 큽니다.");
    Document::validateSize(QSize(qCeil(bounds.width()), qCeil(bounds.height())), candidate.layers.size());
    for (auto &layer : candidate.layers) {
        layer.image = layer.image.transformed(transform, Qt::FastTransformation);
        if (layer.image.isNull())
            throw std::bad_alloc();
    }
    candidate.size = candidate.layers.front().image.size();
    doc.commit(std::move(candidate), QStringLiteral("이미지 변형"));
    cancel();
}
void Canvas::drawBrush(QPointF point, qreal pressure, bool finish) {
    if (!std::isfinite(point.x()) || !std::isfinite(point.y()) || !std::isfinite(pressure))
        throw std::runtime_error("브러시 입력 좌표가 올바르지 않습니다.");
    auto &stroke = brushStroke;
    auto &image = working.layers[working.active].image;
    point.setX(std::clamp(point.x(), -qreal(MaxDimension), qreal(MaxDimension) * 2));
    point.setY(std::clamp(point.y(), -qreal(MaxDimension), qreal(MaxDimension) * 2));
    pressure = stroke.pressureSensitive ? std::clamp(pressure, 0.0, 1.0) : 1.0;
    const qreal weight = 1.0 - stroke.stabilization * 0.008;
    const QPointF filtered = finish ? point : stroke.filtered + (point - stroke.filtered) * weight;
    const QPointF end = finish ? point : (stroke.filtered + filtered) * 0.5;
    QPainterPath curve(stroke.position);
    curve.quadTo(stroke.filtered, end);
    const qreal length =
        QLineF(stroke.position, stroke.filtered).length() + QLineF(stroke.filtered, end).length();
    const qreal spacing = std::max(0.25, stroke.size * 0.12);
    const int steps = std::max(1, qCeil(length / spacing));
    if (!image.bits())
        throw std::bad_alloc();
    QRect dirty;
    for (int step = 0; step <= steps; ++step) {
        const qreal t = qreal(step) / steps;
        const QPointF center = curve.pointAtPercent(t);
        const qreal force = stroke.pressure + (pressure - stroke.pressure) * t;
        const qreal radius = std::max(0.5, stroke.size * (0.2 + 0.8 * force) * 0.5);
        const qreal inner = radius * stroke.hardness / 100.0;
        const QRect bounds(QPoint(qFloor(center.x() - radius - 0.5), qFloor(center.y() - radius - 0.5)),
                           QPoint(qCeil(center.x() + radius + 0.5), qCeil(center.y() + radius + 0.5)));
        const QRect clipped = bounds.intersected(image.rect());
        dirty = dirty.united(clipped);
        for (int y = clipped.top(); y <= clipped.bottom(); ++y) {
            auto *coverage = stroke.coverage.scanLine(y);
            auto *output = reinterpret_cast<QRgb *>(image.scanLine(y));
            const auto *base = reinterpret_cast<const QRgb *>(stroke.base.constScanLine(y));
            for (int x = clipped.left(); x <= clipped.right(); ++x) {
                const qreal distance = std::hypot(x + 0.5 - center.x(), y + 0.5 - center.y());
                const qreal edge = std::clamp((distance - inner) / (radius + 0.5 - inner), 0.0, 1.0);
                const int alpha = qRound(255 * (1 - edge * edge * (3 - 2 * edge)) * stroke.opacity / 100.0);
                // Revisiting a pixel in the same stroke must not compound its opacity.
                if (alpha <= coverage[x])
                    continue;
                coverage[x] = uchar(alpha);
                const QRgb original = base[x];
                if (stroke.eraser) {
                    const QRgb target = qPremultiply(stroke.color.rgba());
                    output[x] =
                        qRgba((qRed(target) * alpha + qRed(original) * (255 - alpha) + 127) / 255,
                              (qGreen(target) * alpha + qGreen(original) * (255 - alpha) + 127) / 255,
                              (qBlue(target) * alpha + qBlue(original) * (255 - alpha) + 127) / 255,
                              (qAlpha(target) * alpha + qAlpha(original) * (255 - alpha) + 127) / 255);
                } else {
                    const int ink = (alpha * stroke.color.alpha() + 127) / 255;
                    output[x] =
                        qRgba((stroke.color.red() * ink + qRed(original) * (255 - ink) + 127) / 255,
                              (stroke.color.green() * ink + qGreen(original) * (255 - ink) + 127) / 255,
                              (stroke.color.blue() * ink + qBlue(original) * (255 - ink) + 127) / 255,
                              ink + (qAlpha(original) * (255 - ink) + 127) / 255);
                }
            }
        }
    }
    stroke.position = end;
    stroke.filtered = filtered;
    stroke.pressure = pressure;
    if (!dirty.isEmpty())
        update(QRectF(dirty.x() * zoom - 2, dirty.y() * zoom - 2, dirty.width() * zoom + 4,
                      dirty.height() * zoom + 4)
                   .toAlignedRect());
}
void Canvas::drawStroke(QPoint from, QPoint to) {
    auto &image = working.layers[working.active].image;
    if (!image.bits())
        throw std::bad_alloc();
    const QColor color = rightButton ? background : foreground;
    if (tool == Tool::ColorEraser) {
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
void Canvas::drawShape(QPainter &painter, QPoint end) const {
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
    const auto revision = doc.revision();
    const int active = candidate.active;
    const QColor color = rightButton ? background : foreground;
#ifdef Q_OS_WASM
    if (Document::flood(candidate.layers[active].image, point, color)) {
        candidate.layers[active].visible = true;
        doc.commit(std::move(candidate), QStringLiteral("채우기"));
        refresh();
        emit changed();
    }
    Q_UNUSED(revision);
#else
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
    cancelled = cancelled.load() || progress.wasCanceled();
    auto result = future.get();
    if (doc.revision() != revision || doc.state().active != active)
        throw std::runtime_error("채우기 중 문서가 변경되었습니다. 다시 시도하세요.");
    if (result.first && !cancelled) {
        candidate.layers[active].image = std::move(result.second);
        candidate.layers[active].visible = true;
        doc.commit(std::move(candidate), QStringLiteral("채우기"));
        refresh();
        emit changed();
    }
#endif
}
void Canvas::paintEvent(QPaintEvent *event) try {
    QPainter painter(this);
    painter.fillRect(rect(), QColor(22, 24, 29));
    painter.setRenderHint(QPainter::SmoothPixmapTransform, zoom < 1);
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
                if (i == working.active) {
                    painter.drawImage(0, 0, working.layers[i].image);
                    painter.save();
                    drawShape(painter, hover);
                    painter.restore();
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
        for (int i = 0; i < doc.state().layers.size(); ++i) {
            if (doc.state().layers[i].visible || i == doc.state().active)
                painter.drawImage(0, 0, doc.state().layers[i].image);
            if (i == doc.state().active) {
                painter.save();
                drawShape(painter, hover);
                painter.restore();
            }
        }
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
    if (underMouse() && !dragging && (tool == Tool::Brush || tool == Tool::Eraser)) {
        const qreal radius = std::max(2.0, thickness * zoom * 0.5);
        painter.setBrush(Qt::NoBrush);
        painter.setPen(QPen(QColor(20, 24, 30, 180), 3));
        painter.drawEllipse(pointerPosition * zoom, radius, radius);
        painter.setPen(QPen(QColor(235, 240, 250), 1));
        painter.drawEllipse(pointerPosition * zoom, radius, radius);
    }
    painter.setPen(Qt::black);
    painter.setBrush(Qt::white);
    painter.drawRect(QRect(paper.right() + 1, paper.bottom() + 1, 7, 7));
} catch (const std::exception &error) {
    reportError(error);
}
void Canvas::mousePressEvent(QMouseEvent *event) try {
    if (dragging)
        return;
    setFocus();
    pointerPosition = event->position() / zoom;
    hover = documentPoint(event->position());
    rightButton = event->button() == Qt::RightButton;
    gestureButton = event->button();
    gestureDevice = event->pointingDevice();
    if (event->button() == Qt::MiddleButton || tool == Tool::Pan) {
        start = event->globalPosition().toPoint();
        dragging = panning = true;
        emit changed();
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
            emit changed();
            return;
        }
        if (selectionRect.contains(hover)) {
            moving = true;
            dragging = true;
            selectionOffset = hover - selectionRect.topLeft();
            emit changed();
            return;
        }
        settle();
    }
    gestureButton = event->button();
    gestureDevice = event->pointingDevice();
    if (hover.x() >= doc.state().size.width() || hover.y() >= doc.state().size.height()) {
        resizeWidth = hover.x() >= doc.state().size.width();
        resizeHeight = hover.y() >= doc.state().size.height();
        start = hover;
        canvasPreview = doc.state().size;
        resizingCanvas = true;
        dragging = true;
        emit changed();
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
        emit changed();
        update();
        return;
    }
    start = last = hover;
    working = doc.state();
    dragging = true;
    if (!brushSquare && (tool == Tool::Brush || tool == Tool::Eraser)) {
        brushStroke = {};
        brushStroke.coverage = QImage(working.size, QImage::Format_Alpha8);
        if (brushStroke.coverage.isNull())
            throw std::bad_alloc();
        brushStroke.coverage.fill(0);
        brushStroke.base = working.layers[working.active].image;
        brushStroke.position = brushStroke.filtered = pointerPosition;
        brushStroke.pressureSensitive = tabletInput && pressureEnabled;
        brushStroke.pressure = brushStroke.pressureSensitive ? tabletPressure : 1;
        brushStroke.size = std::clamp(thickness, 1, 100);
        brushStroke.opacity = std::clamp(brushOpacity, 0, 100);
        brushStroke.hardness = std::clamp(brushHardness, 0, 100);
        brushStroke.stabilization = std::clamp(brushStabilization, 0, 75);
        brushStroke.eraser = tool == Tool::Eraser;
        brushStroke.color = brushStroke.eraser
                                ? (working.layers.size() > 1 ? QColor(Qt::transparent) : background)
                                : (rightButton ? background : foreground);
    }
    if (!working.layers[working.active].visible) {
        working.layers[working.active].visible = true;
    }
    if (tool == Tool::FreeSelect) {
        selectionMask = {};
        selectionMask.moveTo(start);
    }
    switch (tool) {
    case Tool::Pencil:
    case Tool::Brush:
    case Tool::Spray:
    case Tool::Eraser:
    case Tool::ColorEraser:
        if (!brushStroke.coverage.isNull())
            drawBrush(pointerPosition, tabletPressure);
        else
            drawStroke(start, start);
        if (tool == Tool::Spray)
            spray.start();
        break;
    default:
        break;
    }
    update();
    emit changed();
} catch (const std::exception &error) {
    reportError(error);
}
void Canvas::mouseMoveEvent(QMouseEvent *event) try {
    if (dragging && gestureDevice != event->pointingDevice())
        return;
    pointerPosition = event->position() / zoom;
    hover = documentPoint(event->position());
    emit positionChanged(hover);
    if (!dragging) {
        update();
        return;
    }
    if (!brushStroke.coverage.isNull()) {
        drawBrush(pointerPosition, tabletPressure);
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
    if (moving || resizingSelection) {
        QRect candidate = selectionRect;
        if (moving) {
            const QPoint position = hover - selectionOffset;
            candidate.moveTopLeft(QPoint(std::clamp(position.x(), -MaxDimension, MaxDimension),
                                         std::clamp(position.y(), -MaxDimension, MaxDimension)));
        } else {
            candidate.setBottomRight(
                QPoint(std::max(hover.x(), candidate.left()), std::max(hover.y(), candidate.top())));
        }
        Document::validateSize(candidate.size());
        Document::validateSize(
            doc.state().size.expandedTo(QSize(candidate.right() + 1, candidate.bottom() + 1)),
            doc.state().layers.size());
        selectionRect = candidate;
        selectionModified = true;
        refresh();
    } else if (resizingCanvas)
        canvasPreview =
            QSize(resizeWidth ? std::clamp(hover.x(), 1, MaxDimension) : doc.state().size.width(),
                  resizeHeight ? std::clamp(hover.y(), 1, MaxDimension) : doc.state().size.height());
    else if (tool == Tool::FreeSelect)
        selectionMask.lineTo(hover);
    else {
        switch (tool) {
        case Tool::Pencil:
        case Tool::Brush:
        case Tool::Spray:
        case Tool::Eraser:
        case Tool::ColorEraser:
            drawStroke(last, hover);
            last = hover;
            break;
        default:
            hover = constrained(hover, event->modifiers());
            break;
        }
    }
    update();
} catch (const std::exception &error) {
    reportError(error);
}
void Canvas::mouseReleaseEvent(QMouseEvent *event) try {
    if (!dragging || event->button() != gestureButton || gestureDevice != event->pointingDevice())
        return;
    if (documentPoint(event->position()) != hover) {
        mouseMoveEvent(event);
        if (!dragging)
            return;
    } else if (!moving && !resizingSelection && !resizingCanvas && !panning) {
        switch (tool) {
        case Tool::Line:
        case Tool::Curve:
        case Tool::Rectangle:
        case Tool::RoundRectangle:
        case Tool::Ellipse:
            hover = constrained(hover, event->modifiers());
            break;
        default:
            break;
        }
    }
    if (!brushStroke.coverage.isNull()) {
        drawBrush(event->position() / zoom, brushStroke.pressure, true);
        brushStroke = {};
    }
    spray.stop();
    dragging = false;
    gestureButton = Qt::NoButton;
    gestureDevice = nullptr;
    if (panning) {
        panning = false;
        emit changed();
        return;
    }
    if (moving || resizingSelection) {
        moving = resizingSelection = false;
        update();
        return;
    }
    if (resizingCanvas) {
        State candidate = Document::resized(pendingState(), canvasPreview, false);
        doc.commit(std::move(candidate), QStringLiteral("캔버스 크기"));
        cancel();
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
        if (rect.isEmpty()) {
            working = {};
            emit changed();
        } else {
            liftSelection(selectionMask, rect);
        }
        return;
    }
    if (tool == Tool::Curve) {
        points = {start, hover};
        curvePhase = 1;
        update();
        emit changed();
        return;
    }
    switch (tool) {
    case Tool::Line:
    case Tool::Rectangle:
    case Tool::RoundRectangle:
    case Tool::Ellipse: {
        if (!working.layers[working.active].image.bits())
            throw std::bad_alloc();
        QPainter painter(&working.layers[working.active].image);
        drawShape(painter, hover);
        break;
    }
    default:
        break;
    }
    doc.commit(working, QStringLiteral("그리기"));
    working = {};
    refresh();
    emit changed();
} catch (const std::exception &error) {
    reportError(error);
}
void Canvas::tabletEvent(QTabletEvent *event) try {
    if (event->type() != QEvent::TabletPress && event->type() != QEvent::TabletMove &&
        event->type() != QEvent::TabletRelease) {
        event->ignore();
        return;
    }
    QScopedValueRollback<bool> source(tabletInput, true);
    tabletPressure = std::isfinite(event->pressure()) ? std::clamp(event->pressure(), 0.0, 1.0) : 1;
    const auto type = event->type() == QEvent::TabletPress     ? QEvent::MouseButtonPress
                      : event->type() == QEvent::TabletRelease ? QEvent::MouseButtonRelease
                                                               : QEvent::MouseMove;
    QMouseEvent mouse(type, event->position(), event->globalPosition(), event->button(), event->buttons(),
                      event->modifiers(), event->pointingDevice());
    if (type == QEvent::MouseButtonPress)
        mousePressEvent(&mouse);
    else if (type == QEvent::MouseButtonRelease)
        mouseReleaseEvent(&mouse);
    else
        mouseMoveEvent(&mouse);
    event->accept();
} catch (const std::exception &error) {
    reportError(error);
}
void Canvas::mouseDoubleClickEvent(QMouseEvent *) try {
    if (tool == Tool::Polygon && points.size() >= 3)
        settle();
} catch (const std::exception &error) {
    reportError(error);
}
void Canvas::keyPressEvent(QKeyEvent *event) try {
    if (!(event->modifiers() & (Qt::ControlModifier | Qt::MetaModifier | Qt::AltModifier)) && !dragging) {
        const int key = event->key();
        if (key == Qt::Key_B || key == Qt::Key_N || key == Qt::Key_E || key == Qt::Key_I ||
            key == Qt::Key_G || key == Qt::Key_T || key == Qt::Key_V || key == Qt::Key_H) {
            setTool(key == Qt::Key_B   ? Tool::Brush
                    : key == Qt::Key_N ? Tool::Pencil
                    : key == Qt::Key_E ? Tool::Eraser
                    : key == Qt::Key_I ? Tool::Picker
                    : key == Qt::Key_G ? Tool::Fill
                    : key == Qt::Key_T ? Tool::Text
                    : key == Qt::Key_V ? Tool::Select
                                       : Tool::Pan);
            return;
        }
        if (key == Qt::Key_BracketLeft || key == Qt::Key_BracketRight) {
            thickness = std::clamp(thickness + (key == Qt::Key_BracketLeft ? -1 : 1), 1, 100);
            emit changed();
            return;
        }
    }
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
        QRect candidate = selectionRect.translated(delta);
        const QPoint position = candidate.topLeft();
        candidate.moveTopLeft(QPoint(std::clamp(position.x(), -MaxDimension, MaxDimension),
                                     std::clamp(position.y(), -MaxDimension, MaxDimension)));
        Document::validateSize(
            doc.state().size.expandedTo(QSize(candidate.right() + 1, candidate.bottom() + 1)),
            doc.state().layers.size());
        selectionRect = candidate;
        if (!delta.isNull())
            selectionModified = true;
        refresh();
    } else
        QWidget::keyPressEvent(event);
} catch (const std::exception &error) {
    reportError(error);
}
void Canvas::wheelEvent(QWheelEvent *event) try {
    if (event->modifiers() & Qt::ControlModifier) {
        setZoom(zoom * (event->angleDelta().y() > 0 ? 1.25 : 0.8));
        event->accept();
    } else
        event->ignore();
} catch (const std::exception &error) {
    reportError(error);
}
void Canvas::dragEnterEvent(QDragEnterEvent *event) {
    if (event->mimeData()->hasImage() || event->mimeData()->hasUrls())
        event->acceptProposedAction();
}
void Canvas::dropEvent(QDropEvent *event) try {
    const auto *mime = event->mimeData();
    if (mime->hasImage())
        paste(qvariant_cast<QImage>(mime->imageData()));
    else if (mime->hasUrls() && !mime->urls().isEmpty() && mime->urls().first().isLocalFile())
        emit fileDropped(mime->urls().first().toLocalFile());
    event->acceptProposedAction();
} catch (const std::exception &error) {
    reportError(error);
}
void Canvas::beginText() {
    auto *editor = new QTextEdit(this);
    textEditor = editor;
    textComposing = false;
    editor->setPlainText({});
    editor->setFont(textFont);
    editor->setTextColor(foreground);
    updateTextStyle();
    editor->setAcceptRichText(false);
#ifdef Q_OS_WASM
    // Use the permission-aware Edit menu/shortcuts instead of QTextEdit's native clipboard actions.
    editor->setContextMenuPolicy(Qt::NoContextMenu);
    editor->setAcceptDrops(false);
#endif
    editor->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    editor->setVerticalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    editor->setToolTip(
        QStringLiteral("Ctrl+Enter 확정 / Esc 취소. 현재 문자 영역에 보이는 내용만 확정합니다."));
    editor->setGeometry(qRound(textPosition.x() * zoom), qRound(textPosition.y() * zoom),
                        std::max(120, qRound(260 * zoom)), std::max(70, qRound(120 * zoom)));
    editor->installEventFilter(this);
    editor->show();
    editor->setFocus();
    emit changed();
}
void Canvas::updateTextStyle() {
    if (!textEditor)
        return;
    auto *editor = textEditor;
    editor->setStyleSheet(QStringLiteral("QTextEdit { border: 1px dashed black; background: %1; }")
                              .arg(transparentText ? QStringLiteral("transparent") : background.name()));
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
bool Canvas::eventFilter(QObject *object, QEvent *event) try {
    if (object == textEditor && event->type() == QEvent::InputMethod) {
        auto *input = static_cast<QInputMethodEvent *>(event);
#ifdef Q_OS_WASM
        const auto length = textEditor->document()->characterCount() - 1;
        const auto replaced = input->replacementLength() ? input->replacementLength()
                                                         : textEditor->textCursor().selectedText().size();
        if (input->preeditString().size() > 65536 || length - replaced + input->commitString().size() > 65536)
            throw std::runtime_error("문자는 65536자 이내로 입력하세요.");
#endif
        textComposing = !input->preeditString().isEmpty();
    }
    if (object == textEditor && event->type() == QEvent::KeyPress) {
        auto *key = static_cast<QKeyEvent *>(event);
#ifdef Q_OS_WASM
        if (key->matches(QKeySequence::Copy) || key->matches(QKeySequence::Cut)) {
            copy(key->matches(QKeySequence::Cut));
            return true;
        }
        if (key->matches(QKeySequence::Paste)) {
            pasteClipboard();
            return true;
        }
        if (!key->text().isEmpty() && !(key->modifiers() & (Qt::ControlModifier | Qt::MetaModifier)) &&
            key->key() != Qt::Key_Backspace && key->key() != Qt::Key_Delete &&
            textEditor->document()->characterCount() - 1 - textEditor->textCursor().selectedText().size() +
                    key->text().size() >
                65536)
            throw std::runtime_error("문자는 65536자 이내로 입력하세요.");
#endif
        if (textComposing && (key->key() == Qt::Key_Escape || key->key() == Qt::Key_Return))
            return QWidget::eventFilter(object, event);
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
} catch (const std::exception &error) {
    reportError(error);
    return true;
}
bool Canvas::event(QEvent *event) {
    try {
        // A lost mouse grab must not leave the spray timer running indefinitely.
        if ((event->type() == QEvent::WindowDeactivate || event->type() == QEvent::UngrabMouse) && dragging)
            recoverAfterError();
        return QWidget::event(event);
    } catch (const std::exception &error) {
        reportError(error);
        return true;
    }
}
} // namespace paint
