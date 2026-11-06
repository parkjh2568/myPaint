#include <QImage>
#include <QPainter>
#include <QJsonDocument>
#include <QJsonArray>
#include <QJsonObject>
#include <QFile>
#include <cstdio>
int main(int argc, char **argv) {
    if (argc != 2)
        return 2;
    QFile input(argv[1]);
    if (!input.open(QIODevice::ReadOnly))
        return 3;
    auto cases = QJsonDocument::fromJson(input.readAll()).object()["cases"].toArray();
    QJsonArray output;
    for (auto item : cases) {
        auto c = item.toObject();
        int w = c["width"].toInt(), h = c["height"].toInt(), size = c["size"].toInt();
        auto aa = c["from"].toArray(), bb = c["to"].toArray();
        QPoint a(aa[0].toInt(), aa[1].toInt()), b(bb[0].toInt(), bb[1].toInt());
        QJsonArray observations;
        for (int alpha : {0, 128, 255})
            for (int mode = 0; mode < 3; mode++) {
                QImage image(w, h, QImage::Format_ARGB32_Premultiplied);
                image.fill(Qt::red);
                {
                    QPainter p(&image);
                    p.setCompositionMode(QPainter::CompositionMode_Source);
                    p.setPen(
                        QPen(QColor(31, 83, 197, alpha), size, Qt::SolidLine, Qt::SquareCap, Qt::RoundJoin));
                    if (mode == 0)
                        p.drawLine(a, a);
                    else if (mode == 1)
                        p.drawPoint(a);
                    else
                        p.drawLine(a, b);
                }
                QJsonArray runs;
                int count = 0;
                for (int y = 0; y < h; y++) {
                    int begin = -1;
                    const auto *row = reinterpret_cast<const QRgb *>(image.constScanLine(y));
                    for (int x = 0; x <= w; x++) {
                        bool hit = x < w && row[x] != qRgb(255, 0, 0);
                        if (hit && begin < 0)
                            begin = x;
                        if (!hit && begin >= 0) {
                            runs.append(QJsonArray{y, begin, x});
                            count += x - begin;
                            begin = -1;
                        }
                    }
                }
                observations.append(QJsonObject{{"alpha", alpha},
                                                {"operation", mode == 0   ? "zeroLine"
                                                              : mode == 1 ? "pointOnly"
                                                                          : "segment"},
                                                {"pixels", count},
                                                {"rowSpans", runs}});
            }
        c["observations"] = observations;
        output.append(c);
    }
    auto bytes =
        QJsonDocument(
            QJsonObject{
                {"qt", qVersion()},
                {"scope",
                 "Held-out QImage/QPainter geometry only, Source composition, no QApplication/user data; rowSpans=[y,left,rightExclusive]"},
                {"cases", output}})
            .toJson(QJsonDocument::Compact);
    std::fwrite(bytes.constData(), 1, size_t(bytes.size()), stdout);
    return 0;
}
