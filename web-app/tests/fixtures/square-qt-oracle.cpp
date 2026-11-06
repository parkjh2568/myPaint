#include "canvas.h"
#include <QApplication>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMouseEvent>
#include <QPointingDevice>
#include <QTabletEvent>
#include <QCryptographicHash>
#include <cstdio>
#include <vector>
#include <cmath>
#include <random>
using namespace paint;
struct Case {
    QString name;
    QPointF from{8, 8}, to{8, 8};
    int size = 4, opacity = 100, hardness = 100, stabilization = 0;
    bool eraser = true, right = false, tablet = false, multi = false, cancel = false, hidden = false;
    double zoom = 1, pressure = 1;
    QColor fill{Qt::red}, ink{Qt::blue}, background{Qt::blue};
    bool noMove = false;
};
int main(int argc, char **argv) {
    QApplication app(argc, argv);
    app.setApplicationName("myPaint-Square-isolated-s480_297");
    app.setOrganizationName("myPaint-Square-isolated-s480_297");
    std::vector<Case> cases;
    for (int size : {1, 2, 3, 4, 7, 8})
        cases.push_back({.name = QString("eraser-click-size%1").arg(size), .size = size});
    for (int size : {1, 2, 3, 4})
        cases.push_back(
            {.name = QString("eraser-axis-size%1").arg(size), .from = {5, 8}, .to = {15, 8}, .size = size});
    cases.push_back({.name = "eraser-vertical-size3", .from = {8, 5}, .to = {8, 15}, .size = 3});
    cases.push_back({.name = "eraser-diagonal45-size4", .from = {5, 5}, .to = {15, 15}});
    cases.push_back({.name = "eraser-diagonal45-reverse-size4", .from = {15, 15}, .to = {5, 5}});
    cases.push_back({.name = "eraser-slope-half-size3", .from = {5, 5}, .to = {15, 10}, .size = 3});
    cases.push_back({.name = "eraser-slope-half-size4", .from = {5, 5}, .to = {15, 10}});
    cases.push_back({.name = "eraser-slope-half-reverse-size4", .from = {15, 10}, .to = {5, 5}});
    cases.push_back({.name = "eraser-slope-negative-size4", .from = {5, 15}, .to = {15, 10}});
    cases.push_back({.name = "eraser-clipped-negative-fraction", .from = {-1.2, 5.9}, .to = {4.9, 5.9}});
    cases.push_back(
        {.name = "eraser-fraction-floor-zoom2", .from = {5.9, 8.9}, .to = {15.9, 8.9}, .zoom = 2});
    cases.push_back({.name = "eraser-options-ignored",
                     .from = {5, 8},
                     .to = {15, 8},
                     .opacity = 0,
                     .hardness = 0,
                     .stabilization = 75});
    cases.push_back({.name = "eraser-right-same", .from = {5, 8}, .to = {15, 8}, .right = true});
    cases.push_back(
        {.name = "eraser-pen-pressure-low", .from = {5, 8}, .to = {15, 8}, .tablet = true, .pressure = .01});
    cases.push_back(
        {.name = "eraser-pen-pressure-high", .from = {5, 8}, .to = {15, 8}, .tablet = true, .pressure = 1});
    cases.push_back({.name = "eraser-transparent-background", .background = {77, 144, 219, 0}});
    cases.push_back({.name = "eraser-halfalpha-background", .background = {77, 144, 219, 128}});
    cases.push_back({.name = "eraser-multiple-layers-clear", .multi = true});
    cases.push_back({.name = "eraser-hidden-unhide", .hidden = true});
    cases.push_back(
        {.name = "eraser-hidden-cancel", .from = {5, 8}, .to = {15, 8}, .cancel = true, .hidden = true});
    cases.push_back({.name = "square-brush-alpha128-click", .eraser = false, .ink = {77, 144, 219, 128}});
    cases.push_back({.name = "square-brush-alpha128-axis",
                     .from = {5, 8},
                     .to = {15, 8},
                     .eraser = false,
                     .ink = {77, 144, 219, 128}});
    cases.push_back({.name = "square-brush-options-ignored",
                     .from = {5, 8},
                     .to = {15, 8},
                     .opacity = 0,
                     .hardness = 0,
                     .stabilization = 75,
                     .eraser = false});
    cases.push_back({.name = "square-brush-right-background",
                     .eraser = false,
                     .right = true,
                     .ink = {Qt::green},
                     .background = {Qt::blue}});
    cases.push_back({.name = "square-brush-alpha128-click-no-move",
                     .eraser = false,
                     .ink = {77, 144, 219, 128},
                     .noMove = true});
    for (int size : {1, 3, 5, 7})
        for (const QPoint delta : {QPoint(7, 1), QPoint(7, 3), QPoint(7, 7), QPoint(3, 7)})
            for (int sx : {-1, 1})
                for (int sy : {-1, 1})
                    cases.push_back({.name = QString("odd-slopes-size%1-dx%2-dy%3")
                                                 .arg(size)
                                                 .arg(sx * delta.x())
                                                 .arg(sy * delta.y()),
                                     .from = {8, 8},
                                     .to = {8.0 + sx * delta.x(), 8.0 + sy * delta.y()},
                                     .size = size});
    std::mt19937 random(0x5a17);
    for (int i = 0; i < 64; i++) {
        Case c;
        c.name = QString("seed-5a17-%1").arg(i);
        c.from = {double(random() % 220) / 10, double(random() % 220) / 10};
        c.to = {double(int(random() % 310) - 35) / 10, double(int(random() % 310) - 35) / 10};
        c.size = 1 + int(random() % 9);
        c.zoom = i % 3 == 0 ? 1.25 : i % 3 == 1 ? 2 : 1;
        cases.push_back(c);
    }
    QJsonArray records, errors;
    auto rgba = [](QRgb v) { return QJsonArray{qRed(v), qGreen(v), qBlue(v), qAlpha(v)}; };
    for (const auto &c : cases) {
        Document doc(QSize(24, 24));
        State state = doc.state();
        state.background = c.background;
        state.layers[0].image.fill(c.fill);
        state.layers[0].visible = !c.hidden;
        if (c.multi)
            state.layers.push_back({"unused", Document::allocate(state.size, Qt::transparent), true});
        doc.reset(state);
        const auto before = doc.state().layers[0].image;
        const auto revision = doc.revision();
        Canvas canvas(doc);
        QObject::connect(&canvas, &Canvas::errorOccurred, [&](const QString &s) { errors.append(s); });
        canvas.tool = c.eraser ? Tool::Eraser : Tool::Brush;
        canvas.brushSquare = true;
        canvas.thickness = c.size;
        canvas.brushOpacity = c.opacity;
        canvas.brushHardness = c.hardness;
        canvas.brushStabilization = c.stabilization;
        canvas.pressureEnabled = true;
        canvas.foreground = c.ink;
        canvas.background = c.background;
        canvas.setZoom(c.zoom);
        canvas.show();
        QPointingDevice pen("square oracle pen", 93, QInputDevice::DeviceType::Stylus,
                            QPointingDevice::PointerType::Pen,
                            QInputDevice::Capability::Position | QInputDevice::Capability::Pressure, 1, 1);
        const auto button = c.right ? Qt::RightButton : Qt::LeftButton;
        auto send = [&](QEvent::Type t, QPointF point) {
            point *= c.zoom;
            if (c.tablet) {
                const auto tt = t == QEvent::MouseButtonPress     ? QEvent::TabletPress
                                : t == QEvent::MouseButtonRelease ? QEvent::TabletRelease
                                                                  : QEvent::TabletMove;
                QTabletEvent e(tt, &pen, point, point, c.pressure, 0, 0, 0, 0, 0, Qt::NoModifier,
                               t == QEvent::MouseMove ? Qt::NoButton : button,
                               t == QEvent::MouseButtonRelease ? Qt::NoButton : button);
                QApplication::sendEvent(&canvas, &e);
            } else {
                QMouseEvent e(t, point, point, t == QEvent::MouseMove ? Qt::NoButton : button,
                              t == QEvent::MouseButtonRelease ? Qt::NoButton : button, Qt::NoModifier);
                QApplication::sendEvent(&canvas, &e);
            }
        };
        send(QEvent::MouseButtonPress, c.from);
        if (!c.noMove)
            send(QEvent::MouseMove, c.to);
        const bool during = doc.revision() != revision;
        const bool pendingVisible = canvas.pendingState().layers[0].visible;
        if (c.cancel)
            canvas.cancel();
        send(QEvent::MouseButtonRelease, c.to);
        const auto after = doc.state().layers[0].image;
        QJsonArray rows, changed;
        int count = 0;
        for (int y = 0; y < 24; y++) {
            QString row;
            for (int x = 0; x < 24; x++) {
                bool diff = before.pixel(x, y) != after.pixel(x, y);
                row += diff ? '#' : '.';
                if (diff) {
                    count++;
                    changed.append(QJsonObject{{"x", x},
                                               {"y", y},
                                               {"premultiplied", rgba(after.pixel(x, y))},
                                               {"straight", rgba(after.pixelColor(x, y).rgba())}});
                }
            }
            rows.append(row);
        }
        QJsonObject rec{{"name", c.name},
                        {"noMove", c.noMove},
                        {"eventSequence", c.noMove ? "press-release" : "press-move-release"},
                        {"tool", c.eraser ? "eraser" : "brush"},
                        {"from", QJsonArray{c.from.x(), c.from.y()}},
                        {"to", QJsonArray{c.to.x(), c.to.y()}},
                        {"size", c.size},
                        {"opacity", c.opacity},
                        {"hardness", c.hardness},
                        {"stabilization", c.stabilization},
                        {"right", c.right},
                        {"tablet", c.tablet},
                        {"pressure", c.pressure},
                        {"zoom", c.zoom},
                        {"multi", c.multi},
                        {"fill", rgba(c.fill.rgba())},
                        {"ink", rgba(c.ink.rgba())},
                        {"background", rgba(c.background.rgba())},
                        {"mask", rows},
                        {"changed", changed},
                        {"changedCount", count},
                        {"committedDuringDrag", during},
                        {"pendingVisible", pendingVisible},
                        {"visibleAfter", doc.state().layers[0].visible},
                        {"dirty", doc.dirty()},
                        {"canUndo", doc.canUndo()}};
        if (doc.canUndo()) {
            doc.undo();
            rec["undoExact"] =
                doc.state().layers[0].image == before && doc.state().layers[0].visible == !c.hidden;
            rec["undoClean"] = !doc.dirty();
            doc.redo();
            rec["redoExact"] = doc.state().layers[0].image == after;
        }
        records.append(rec);
    }
    auto out =
        QJsonDocument(
            QJsonObject{
                {"qt", qVersion()},
                {"scope",
                 "Actual legacy Canvas/Document linked to existing local paintui/paintcore, isolated application namespace, offscreen; no MainWindow/recovery/user file access"},
                {"cases", records},
                {"errors", errors}})
            .toJson();
    std::fwrite(out.constData(), 1, size_t(out.size()), stdout);
    return errors.isEmpty() ? 0 : 1;
}
