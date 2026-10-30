#include "document.h"
#include <QBuffer>
#include <QDataStream>
#include <QFile>
#include <QPainter>
#include <QRandomGenerator>
#include <QTemporaryDir>
#include <QtTest>
#ifdef Q_OS_LINUX
#include <csignal>
#include <sys/resource.h>
#endif
using namespace paint;
class CoreTests : public QObject {
    Q_OBJECT
  private slots:
    void pixelUndoRedo();
    void savedBranch();
    void resizeRestoresCroppedPixels();
    void projectRoundTrip();
    void malformedProject();
    void failedSavePreservesOriginal();
    void floodBoundariesAndCancellation();
    void memoryLimits();
    void historyBudget();
    void imageFormats();
    void truncatedAndForgedProjects();
    void layerHistory();
    void cancelledFillDoesNotCommit();
    void partialWritePreservesOriginal();
};
void CoreTests::pixelUndoRedo() {
    Document doc(QSize(50, 40));
    auto s = doc.state();
    s.layers[0].image.setPixelColor(7, 8, Qt::red);
    QVERIFY(doc.commit(s, "pixel"));
    QVERIFY(doc.dirty());
    QVERIFY(doc.historyBytes() < 100);
    QCOMPARE(doc.composite().pixelColor(7, 8), QColor(Qt::red));
    doc.undo();
    QVERIFY(!doc.dirty());
    QCOMPARE(doc.composite().pixelColor(7, 8), QColor(Qt::white));
    doc.redo();
    QCOMPARE(doc.composite().pixelColor(7, 8), QColor(Qt::red));
    QVERIFY(!doc.commit(doc.state(), "empty"));
}
void CoreTests::savedBranch() {
    Document doc(QSize(8, 8));
    auto s = doc.state();
    s.layers[0].image.setPixelColor(0, 0, Qt::red);
    doc.commit(s, "A");
    doc.markSaved();
    doc.undo();
    s = doc.state();
    s.layers[0].image.setPixelColor(0, 0, Qt::blue);
    doc.commit(s, "B");
    QVERIFY(doc.dirty());
    QVERIFY(!doc.canRedo());
    doc.undo();
    doc.redo();
    QVERIFY(doc.dirty());
}
void CoreTests::resizeRestoresCroppedPixels() {
    Document doc(QSize(12, 10));
    auto s = doc.state();
    s.layers[0].image.setPixelColor(11, 9, Qt::green);
    doc.commit(s, "pixel");
    doc.commit(Document::resized(doc.state(), QSize(5, 5), false), "crop");
    doc.undo();
    QCOMPARE(doc.state().size, QSize(12, 10));
    QCOMPARE(doc.composite().pixelColor(11, 9), QColor(Qt::green));
    doc.redo();
    QCOMPARE(doc.state().size, QSize(5, 5));
    doc.commit(Document::resized(doc.state(), QSize(20, 20), false), "expand");
    QCOMPARE(doc.composite().pixelColor(19, 19), QColor(Qt::white));
}
void CoreTests::projectRoundTrip() {
    QTemporaryDir dir;
    auto s = Document::blank(QSize(11, 9));
    s.layers.push_back({QStringLiteral("투명 레이어"), Document::allocate(s.size), false});
    s.active = 1;
    s.layers[1].image.setPixelColor(2, 3, QColor(20, 100, 200, 80));
    const QString path = dir.filePath("test.rpaint");
    Document::writeProject(s, path);
    const auto loaded = Document::readProject(path);
    QCOMPARE(loaded.layers.size(), 2);
    QCOMPARE(loaded.active, 1);
    QCOMPARE(loaded.layers[1].name, s.layers[1].name);
    QVERIFY(!loaded.layers[1].visible);
    QCOMPARE(loaded.layers[1].image, s.layers[1].image);
}
void CoreTests::malformedProject() {
    QTemporaryDir dir;
    const QString path = dir.filePath("bad.rpaint");
    QFile file(path);
    QVERIFY(file.open(QIODevice::WriteOnly));
    file.write("RPAINT01", 8);
    file.close();
    QVERIFY_EXCEPTION_THROWN(Document::readProject(path), std::runtime_error);
    auto state = Document::blank(QSize(2, 2));
    Document::writeProject(state, path);
    QVERIFY(file.open(QIODevice::Append));
    file.write("trailing");
    file.close();
    QVERIFY_EXCEPTION_THROWN(Document::readProject(path), std::runtime_error);
}
void CoreTests::failedSavePreservesOriginal() {
    QTemporaryDir dir;
    const QString path = dir.filePath("original.png");
    QFile f(path);
    QVERIFY(f.open(QIODevice::WriteOnly));
    f.write("original");
    f.close();
    QVERIFY_EXCEPTION_THROWN(Document::writeImage(Document::blank(QSize(2, 2)), path, "unknown"),
                             std::runtime_error);
    QVERIFY(f.open(QIODevice::ReadOnly));
    QCOMPARE(f.readAll(), QByteArray("original"));
    QVERIFY_EXCEPTION_THROWN(
        Document::writeProject(Document::blank(QSize(2, 2)), dir.filePath("missing/out.rpaint")),
        std::runtime_error);
}
void CoreTests::floodBoundariesAndCancellation() {
    QImage image = Document::allocate(QSize(30, 20), Qt::white);
    QPainter p(&image);
    p.setPen(Qt::black);
    p.drawLine(15, 0, 15, 19);
    p.end();
    QVERIFY(Document::flood(image, QPoint(0, 0), Qt::red));
    QCOMPARE(image.pixelColor(14, 19), QColor(Qt::red));
    QCOMPARE(image.pixelColor(16, 0), QColor(Qt::white));
    QVERIFY(!Document::flood(image, QPoint(0, 0), Qt::red));
    QVERIFY(!Document::flood(image, QPoint(-1, 0), Qt::blue));
    QImage candidate = image;
    QVERIFY(!Document::flood(candidate, QPoint(16, 0), Qt::blue, [] { return true; }));
    QCOMPARE(candidate, image);
}
void CoreTests::memoryLimits() {
    QVERIFY_EXCEPTION_THROWN(Document::allocate(QSize(-1, 1)), std::runtime_error);
    QVERIFY_EXCEPTION_THROWN(Document::allocate(QSize(32768, 32768)), std::runtime_error);
    auto s = Document::blank(QSize(2, 2));
    s.active = 4;
    QVERIFY_EXCEPTION_THROWN(Document::validate(s), std::runtime_error);
    Document doc(QSize(3, 3));
    const auto revision = doc.revision();
    QVERIFY_EXCEPTION_THROWN(doc.commit(s, "bad"), std::runtime_error);
    QCOMPARE(doc.revision(), revision);
}
void CoreTests::historyBudget() {
    Document doc(QSize(8, 8));
    doc.setHistoryBudget(16);
    for (int i = 0; i < 10; ++i) {
        auto s = doc.state();
        s.layers[0].image.setPixelColor(i % 8, i / 8, Qt::red);
        doc.commit(s, "pixel");
    }
    QVERIFY(doc.historyBytes() <= 16);
    int steps = 0;
    while (doc.canUndo()) {
        doc.undo();
        ++steps;
    }
    QCOMPARE(steps, 2);
}
void CoreTests::imageFormats() {
    QTemporaryDir dir;
    auto s = Document::blank(QSize(10, 10), Qt::transparent);
    s.layers[0].image.setPixelColor(2, 2, Qt::red);
    for (const auto &format : QList<QByteArray>{"png", "jpg", "bmp"}) {
        const auto path = dir.filePath(QString::fromLatin1(format) + "." + QString::fromLatin1(format));
        Document::writeImage(s, path, format);
        auto loaded = Document::readImage(path);
        QCOMPARE(loaded.size, s.size);
    }
    const QString png = dir.filePath("alpha.png");
    Document::writeImage(s, png, "png");
    QCOMPARE(Document::readImage(png).layers[0].image.pixelColor(0, 0).alpha(), 0);
}
void CoreTests::truncatedAndForgedProjects() {
    QTemporaryDir dir;
    const QString path = dir.filePath("input.rpaint");
    Document::writeProject(Document::blank(QSize(3, 2)), path);
    QFile file(path);
    QVERIFY(file.open(QIODevice::ReadOnly));
    const QByteArray complete = file.readAll();
    file.close();
    // Every proper prefix is incomplete, including inside each length and PNG record.
    for (qsizetype length = 0; length < complete.size(); ++length) {
        QVERIFY(file.open(QIODevice::WriteOnly | QIODevice::Truncate));
        file.write(complete.left(length));
        file.close();
        QVERIFY_EXCEPTION_THROWN(Document::readProject(path), std::runtime_error);
    }
    for (int offset : {8, 12, 16, 20, 28}) {
        QByteArray forged = complete;
        QBuffer buffer(&forged);
        buffer.open(QIODevice::ReadWrite);
        buffer.seek(offset);
        QDataStream stream(&buffer);
        stream.setByteOrder(QDataStream::LittleEndian);
        stream << quint32(0xffffffff);
        QVERIFY(file.open(QIODevice::WriteOnly | QIODevice::Truncate));
        file.write(forged);
        file.close();
        QVERIFY_EXCEPTION_THROWN(Document::readProject(path), std::runtime_error);
    }
    QImage indexed(QSize(4, 4), QImage::Format_Grayscale8);
    indexed.fill(0);
    QVERIFY_EXCEPTION_THROWN(Document::flood(indexed, QPoint(0, 0), Qt::red), std::runtime_error);
}
void CoreTests::layerHistory() {
    Document doc(QSize(20, 10));
    State state = doc.state();
    state.layers.push_back({"red", Document::allocate(state.size, Qt::red), true});
    state.active = 1;
    doc.commit(state, "add");
    QCOMPARE(doc.composite().pixelColor(0, 0), QColor(Qt::red));
    state = doc.state();
    state.layers[1].visible = false;
    doc.commit(state, "hide");
    QCOMPARE(doc.composite().pixelColor(0, 0), QColor(Qt::white));
    doc.undo();
    QVERIFY(doc.state().layers[1].visible);
    doc.undo();
    QCOMPARE(doc.state().layers.size(), 1);
    QVERIFY(!doc.dirty());
    doc.redo();
    QCOMPARE(doc.state().active, 1);
    doc.redo();
    QVERIFY(!doc.state().layers[1].visible);
}
void CoreTests::cancelledFillDoesNotCommit() {
    Document doc(QSize(64, 64));
    auto candidate = doc.state();
    int checks = 0;
    const bool success =
        Document::flood(candidate.layers[0].image, QPoint(0, 0), Qt::red, [&] { return ++checks > 5; });
    QVERIFY(!success);
    QVERIFY(checks > 5);
    QVERIFY(!doc.dirty());
    QCOMPARE(doc.composite().pixelColor(0, 0), QColor(Qt::white));
    QVERIFY(candidate.layers[0].image != doc.state().layers[0].image);
}
void CoreTests::partialWritePreservesOriginal() {
#ifdef Q_OS_LINUX
    QTemporaryDir directory;
    const QString path = directory.filePath("existing.rpaint");
    QFile file(path);
    QVERIFY(file.open(QIODevice::WriteOnly));
    file.write("original-content");
    file.close();
    auto state = Document::blank(QSize(100, 100));
    QRandomGenerator random(1234);
    for (int y = 0; y < 100; ++y)
        for (int x = 0; x < 100; ++x)
            state.layers[0].image.setPixelColor(x, y, QColor::fromRgb(random.generate() | 0xff000000));
    struct rlimit previous;
    QVERIFY(getrlimit(RLIMIT_FSIZE, &previous) == 0);
    struct rlimit limited = previous;
    limited.rlim_cur = 1024;
    const auto priorSignal = std::signal(SIGXFSZ, SIG_IGN);
    QVERIFY(setrlimit(RLIMIT_FSIZE, &limited) == 0);
    bool failed = false;
    try {
        Document::writeProject(state, path);
    } catch (const std::exception &) {
        failed = true;
    }
    const int restored = setrlimit(RLIMIT_FSIZE, &previous);
    std::signal(SIGXFSZ, priorSignal);
    QVERIFY(restored == 0);
    QVERIFY(failed);
    QVERIFY(file.open(QIODevice::ReadOnly));
    QCOMPARE(file.readAll(), QByteArray("original-content"));
    QCOMPARE(QDir(directory.path()).entryList(QDir::Files).size(), 1);
#else
    QSKIP("File-size resource limit fault injection runs on Linux only");
#endif
}
QTEST_GUILESS_MAIN(CoreTests)
#include "core_tests.moc"
