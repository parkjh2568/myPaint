#pragma once
#include "document.h"
#include <QFont>
#include <QPainterPath>
#include <QTimer>
#include <QWidget>
#include <exception>
class QTextEdit;
class QPainter;
class QPointingDevice;

namespace paint {
enum class Tool {
    Pencil,
    Brush,
    Spray,
    Eraser,
    ColorEraser,
    Fill,
    Picker,
    Line,
    Curve,
    Rectangle,
    RoundRectangle,
    Ellipse,
    Polygon,
    Select,
    FreeSelect,
    Text,
    Pan
};
class Canvas : public QWidget {
    Q_OBJECT
  public:
    explicit Canvas(Document &document, QWidget *parent = nullptr);
    Tool tool = Tool::Pencil;
    QColor foreground = Qt::black, background = Qt::white;
    int thickness = 3;
    int brushOpacity = 100, brushHardness = 100, brushStabilization = 25;
    bool pressureEnabled = true;
    bool fillShape = false, outlineShape = true, transparentSelection = false, grid = false;
    QFont textFont;
    bool transparentText = true, brushSquare = false;
    double zoom = 1.0;
    void refresh();
    void setTool(Tool next);
    void setZoom(double value);
    void paste(QImage image);
    void pasteClipboard();
    void settle();
    State pendingState() const;
    void recoverAfterError();
    void cancel();
    void copy(bool cut);
    void selectAll();
    void removeSelection();
    void crop();
    void transformSelection(const QTransform &transform);
    bool hasSelection() const { return !selection.isNull(); }
    bool hasActiveGesture() const { return dragging; }
    bool hasPendingEdit() const { return dragging || hasSelection() || textEditor || !points.isEmpty(); }
#ifdef Q_OS_WASM
    void completeTextCut();
    void insertClipboardText(const QString &text);
#endif
    void beginText();
    void updateTextStyle();
  signals:
    void changed();
    void positionChanged(QPoint point);
    void colorPicked(QColor color);
    void fileDropped(QString path);
    void errorOccurred(QString message);
#ifdef Q_OS_WASM
    void clipboardWriteRequested(QImage image, bool cut, State candidate);
    void clipboardTextWriteRequested(QString text, bool cut);
    void clipboardReadRequested(bool textMode);
#endif

  protected:
    void paintEvent(QPaintEvent *) override;
    void mousePressEvent(QMouseEvent *) override;
    void mouseMoveEvent(QMouseEvent *) override;
    void mouseReleaseEvent(QMouseEvent *) override;
    void mouseDoubleClickEvent(QMouseEvent *) override;
    void tabletEvent(QTabletEvent *) override;
    void keyPressEvent(QKeyEvent *) override;
    void wheelEvent(QWheelEvent *) override;
    void dragEnterEvent(QDragEnterEvent *) override;
    void dropEvent(QDropEvent *) override;
    bool eventFilter(QObject *, QEvent *) override;
    bool event(QEvent *) override;

  private:
    Document &doc;
    QImage display;
    quint64 displayRevision = 0;
    State working;
    bool dragging = false, moving = false, resizingSelection = false, resizingCanvas = false;
    bool rightButton = false;
    Qt::MouseButton gestureButton = Qt::NoButton;
    const QPointingDevice *gestureDevice = nullptr;
    bool panning = false, resizeWidth = false, resizeHeight = false;
    bool selectionFromDocument = false, selectionModified = false;
    QPoint start, last, hover, selectionOffset;
    struct BrushStroke {
        QImage coverage, base;
        QPointF position, filtered;
        QColor color;
        qreal pressure = 1;
        int size = 1, opacity = 100, hardness = 100, stabilization = 0;
        bool eraser = false, pressureSensitive = false;
    } brushStroke;
    bool tabletInput = false;
    qreal tabletPressure = 1;
    QPointF pointerPosition;
    QImage selection;
    QRect selectionRect;
    QPainterPath selectionMask;
    QPolygon points;
    int curvePhase = 0;
    QSize canvasPreview;
    QTimer spray;
    QTextEdit *textEditor = nullptr;
    bool textComposing = false;
    QPoint textPosition;
    QPoint documentPoint(QPointF point) const;
    QPoint constrained(QPoint point, Qt::KeyboardModifiers modifiers) const;
    void drawStroke(QPoint from, QPoint to);
    void drawBrush(QPointF point, qreal pressure, bool finish = false);
    void drawShape(QPainter &painter, QPoint end) const;
    void liftSelection(QPainterPath mask, QRect rect);
    void fillAt(QPoint point);
    QImage selectionImage() const;
    void reportError(const std::exception &error) noexcept;
};
} // namespace paint
