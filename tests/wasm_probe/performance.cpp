#include "document.h"
#include <QApplication>
#include <QElapsedTimer>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTimer>
#include <emscripten.h>
#include <memory>
EM_JS(void, performanceResult, (const char *json),
      { globalThis.paintPerformance = JSON.parse(UTF8ToString(json)); });
static std::unique_ptr<QApplication> application;
int main(int argc, char **argv) {
    application = std::make_unique<QApplication>(argc, argv);
    QTimer::singleShot(0, [] {
        QJsonObject result;
        try {
            auto state = paint::Document::blank(QSize(2048, 2048));
            QElapsedTimer timer;
            timer.start();
            paint::Document::flood(state.layers[0].image, {0, 0}, Qt::blue);
            result["fill_ms"] = timer.elapsed();
            state = paint::Document::blank(QSize(1536, 2048));
            quint32 seed = 42;
            for (int y = 0; y < state.size.height(); ++y) {
                auto *row = reinterpret_cast<QRgb *>(state.layers[0].image.scanLine(y));
                for (int x = 0; x < state.size.width(); ++x) {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    row[x] = 0xff000000 | seed;
                }
            }
            state.layers.push_back(state.layers[0]);
            timer.restart();
            const auto bytes = paint::Document::projectBytes(state);
            result["project_bytes"] = bytes.size();
            result["project_encode_ms"] = timer.elapsed();
            timer.restart();
            const auto loaded = paint::Document::readProjectBytes(bytes);
            result["project_decode_ms"] = timer.elapsed();
            result["pixels_match"] = loaded.layers[1].image == state.layers[1].image;
            timer.restart();
            const auto image = paint::Document::imageBytes(state, "png");
            result["image_encode_ms"] = timer.elapsed();
            result["image_bytes"] = image.size();
        } catch (const std::exception &error) {
            result["error"] = error.what();
        }
        performanceResult(QJsonDocument(result).toJson(QJsonDocument::Compact).constData());
    });
    return 0;
}
