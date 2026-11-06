#include "document.h"
#include <QCoreApplication>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <cstdio>
int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    auto state = paint::Document::blank(QSize(32, 24), Qt::transparent);
    state.layers[0].name = QStringLiteral("투명 배경");
    state.layers.push_back({QStringLiteral("반투명 레이어"), paint::Document::allocate(state.size), false});
    state.active = 1;
    for (int layer = 0; layer < 2; layer++)
        for (int y = 0; y < 24; y++)
            for (int x = 0; x < 32; x++)
                state.layers[layer].image.setPixelColor(
                    x, y,
                    QColor((x * 9) % 256, (y * 13) % 256, (x * y * 7) % 256, (x + y + layer * 23) % 256));
    const auto bytes = paint::Document::projectBytes(state);
    const auto loaded = paint::Document::readProjectBytes(bytes);
    QJsonArray expected;
    for (const auto &layer : loaded.layers) {
        QByteArray rgba;
        for (int y = 0; y < 24; y++)
            for (int x = 0; x < 32; x++) {
                const auto c = layer.image.pixelColor(x, y);
                rgba.append(char(c.red()));
                rgba.append(char(c.green()));
                rgba.append(char(c.blue()));
                rgba.append(char(c.alpha()));
            }
        expected.append(QString::fromLatin1(rgba.toBase64()));
    }
    std::puts(QJsonDocument(QJsonObject{{"qt", qVersion()},
                                        {"projectBase64", QString::fromLatin1(bytes.toBase64())},
                                        {"rgbaBase64", expected}})
                  .toJson()
                  .constData());
}
