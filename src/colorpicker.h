#pragma once
#include <QColor>
#include <QWidget>

namespace paint {
class ColorPicker final : public QWidget {
    Q_OBJECT
  public:
    explicit ColorPicker(QWidget *parent = nullptr);
    void setColor(QColor color);
  signals:
    void colorChanged(QColor color);

  protected:
    void paintEvent(QPaintEvent *) override;
    void mousePressEvent(QMouseEvent *) override;
    void mouseMoveEvent(QMouseEvent *) override;
    void mouseReleaseEvent(QMouseEvent *) override;
    bool event(QEvent *) override;

  private:
    QColor color = Qt::black;
    qreal hue = 0;
    int dragging = 0;
};
} // namespace paint
