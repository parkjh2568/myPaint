#include <QApplication>
#include <QFile>
#include <QImage>
#include <QPainter>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <cstdio>
#include <cmath>
int main(int argc, char **argv) {
    QApplication app(argc, argv);
    app.setApplicationName("isolated-width1-line");
    app.setOrganizationName("isolated-width1-line");
    QFile f(argv[1]);
    if (!f.open(QIODevice::ReadOnly))
        return 2;
    auto request = QJsonDocument::fromJson(f.readAll()).object();
    QJsonArray out;
    for (const auto &v : request["cases"].toArray()) {
        auto c = v.toObject();
        auto from = c["from"].toArray(), to = c["to"].toArray();
        QImage image(24, 24, QImage::Format_ARGB32_Premultiplied);
        image.fill(Qt::red);
        QPainter p(&image);
        p.setCompositionMode(QPainter::CompositionMode_Source);
        p.setPen(QPen(Qt::blue, 1, Qt::SolidLine, Qt::SquareCap, Qt::RoundJoin));
        QPoint a(int(std::floor(from[0].toDouble())), int(std::floor(from[1].toDouble()))),
            b(int(std::floor(to[0].toDouble())), int(std::floor(to[1].toDouble())));
        p.drawLine(a, a);
        p.drawPoint(a);
        p.drawLine(a, b);
        if (a == b)
            p.drawPoint(b);
        p.end();
        QJsonArray mask;
        for (int y = 0; y < 24; y++) {
            QString row;
            for (int x = 0; x < 24; x++)
                row += image.pixel(x, y) != qRgb(255, 0, 0) ? '#' : '.';
            mask.append(row);
        }
        out.append(QJsonObject{{"name", c["name"]}, {"from", from}, {"to", to}, {"mask", mask}});
    }
    auto bytes =
        QJsonDocument(
            QJsonObject{
                {"qt", qVersion()},
                {"scope",
                 "Actual Qt QPainter width1 image primitive, press dot plus complete segment before output clipping. No Canvas UI/history claim; first29 compared with actual Canvas oracle separately."},
                {"cases", out}})
            .toJson(QJsonDocument::Compact);
    std::fwrite(bytes.constData(), 1, bytes.size(), stdout);
    return 0;
}
