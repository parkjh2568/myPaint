#include "colorpicker.h"
#include <QConicalGradient>
#include <QMouseEvent>
#include <QPainter>
#include <algorithm>
#include <cmath>
#include <numbers>

namespace paint {
ColorPicker::ColorPicker(QWidget *parent) : QWidget(parent) {
    setMinimumSize(210, 210);
    setMaximumHeight(260);
    setAccessibleName(QStringLiteral("색상 선택기"));
    setAccessibleDescription(
        QStringLiteral("색상환과 명도·채도를 선택합니다. HEX 입력으로도 색상을 지정할 수 있습니다."));
}
void ColorPicker::setColor(QColor next) {
    if (!next.isValid())
        return;
    if (next.hsvHueF() >= 0)
        hue = next.hsvHueF();
    color = next;
    update();
}
void ColorPicker::paintEvent(QPaintEvent *) {
    QPainter painter(this);
    painter.setRenderHint(QPainter::Antialiasing);
    const QPointF center = rect().center();
    const qreal radius = std::min(width(), height()) * 0.5 - 12;
    const qreal side = (radius - 14) * std::sqrt(2.0);
    const QRectF square(center.x() - side * 0.5, center.y() - side * 0.5, side, side);
    QConicalGradient spectrum(center, 0);
    for (int i = 0; i <= 12; ++i)
        spectrum.setColorAt(i / 12.0, QColor::fromHsvF((i % 12) / 12.0, 1, 1));
    painter.setPen(QPen(QBrush(spectrum), 16));
    painter.setBrush(Qt::NoBrush);
    painter.drawEllipse(center, radius, radius);
    QLinearGradient saturation(square.topLeft(), square.topRight());
    saturation.setColorAt(0, Qt::white);
    saturation.setColorAt(1, QColor::fromHsvF(hue, 1, 1));
    painter.fillRect(square, saturation);
    QLinearGradient value(square.topLeft(), square.bottomLeft());
    value.setColorAt(0, Qt::transparent);
    value.setColorAt(1, Qt::black);
    painter.fillRect(square, value);
    painter.setPen(QPen(QColor("#101216"), 2));
    painter.drawRect(square);
    const QPointF selected(square.left() + color.hsvSaturationF() * side,
                           square.top() + (1 - color.valueF()) * side);
    const QPointF selectedHue = center + QPointF(std::cos(hue * 2 * std::numbers::pi) * radius,
                                                 -std::sin(hue * 2 * std::numbers::pi) * radius);
    for (const auto &point : {selected, selectedHue}) {
        painter.setPen(QPen(Qt::black, 3));
        painter.drawEllipse(point, 5, 5);
        painter.setPen(QPen(Qt::white, 1.5));
        painter.drawEllipse(point, 5, 5);
    }
}
void ColorPicker::mousePressEvent(QMouseEvent *event) {
    if (event->button() != Qt::LeftButton)
        return;
    const QPointF center = rect().center();
    const qreal radius = std::min(width(), height()) * 0.5 - 12;
    const qreal distance = QLineF(center, event->position()).length();
    const qreal side = (radius - 14) * std::sqrt(2.0);
    const QRectF square(center.x() - side * 0.5, center.y() - side * 0.5, side, side);
    dragging = std::abs(distance - radius) <= 12 ? 1 : square.contains(event->position()) ? 2 : 0;
    mouseMoveEvent(event);
}
void ColorPicker::mouseMoveEvent(QMouseEvent *event) {
    if (!dragging)
        return;
    const QPointF center = rect().center();
    const qreal radius = std::min(width(), height()) * 0.5 - 12;
    const qreal side = (radius - 14) * std::sqrt(2.0);
    qreal saturation = color.hsvSaturationF(), value = color.valueF();
    if (dragging == 1) {
        hue = std::atan2(center.y() - event->position().y(), event->position().x() - center.x()) /
              (2 * std::numbers::pi);
        if (hue < 0)
            hue += 1;
    } else {
        saturation = std::clamp((event->position().x() - center.x()) / side + 0.5, 0.0, 1.0);
        value = std::clamp(0.5 - (event->position().y() - center.y()) / side, 0.0, 1.0);
    }
    const QColor next = QColor::fromHsvF(hue, saturation, value);
    const bool changed = next != color;
    color = next;
    update();
    if (changed)
        emit colorChanged(color);
}
void ColorPicker::mouseReleaseEvent(QMouseEvent *event) {
    if (event->button() == Qt::LeftButton) {
        mouseMoveEvent(event);
        dragging = 0;
    }
}
bool ColorPicker::event(QEvent *event) {
    if (event->type() == QEvent::UngrabMouse || event->type() == QEvent::WindowDeactivate)
        dragging = 0;
    return QWidget::event(event);
}
} // namespace paint
