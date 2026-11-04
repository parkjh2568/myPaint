#include "document.h"
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QJsonDocument>
#include <QJsonObject>
#include <QPainter>
#include <QTemporaryDir>
#include <cstdio>
int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    const QSize size =
        app.arguments().contains(QStringLiteral("--large")) ? QSize(4096, 4096) : QSize(1920, 1080);
    paint::Document document(size);
    QElapsedTimer timer;
    timer.start();
    for (int i = 0; i < 20; ++i) {
        auto candidate = document.state();
        QPainter painter(&candidate.layers[0].image);
        painter.setPen(QPen(Qt::blue, 4));
        painter.drawLine(20, 30 + i * 10, 800, 30 + i * 10);
        painter.end();
        document.commit(std::move(candidate), "stroke");
    }
    QJsonObject result{{"qt", qVersion()},
                       {"canvas", QStringLiteral("%1x%2").arg(size.width()).arg(size.height())},
                       {"strokes", 20},
                       {"stroke_commit_total_ms", timer.elapsed()},
                       {"history_bytes", document.historyBytes()}};
    timer.restart();
    for (int i = 0; i < 20; ++i)
        document.undo();
    for (int i = 0; i < 20; ++i)
        document.redo();
    result["undo_redo_40_total_ms"] = timer.elapsed();
    auto candidate = document.state();
    timer.restart();
    paint::Document::flood(candidate.layers[0].image, QPoint(0, 0), Qt::yellow);
    result["fill_ms"] = timer.elapsed();
    QTemporaryDir directory;
    if (!directory.isValid())
        return 1;
    timer.restart();
    paint::Document::writeProject(document.state(), directory.filePath("probe.rpaint"));
    result["project_save_ms"] = timer.elapsed();
    timer.restart();
    const auto loaded = paint::Document::readProject(directory.filePath("probe.rpaint"));
    result["project_load_ms"] = timer.elapsed();
    if (loaded.layers[0].image != document.state().layers[0].image)
        return 2;
    const auto json = QJsonDocument(result).toJson();
    std::fwrite(json.constData(), 1, size_t(json.size()), stdout);
    return 0;
}
