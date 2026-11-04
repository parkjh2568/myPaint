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
    void byteIOPreservesEditingState();
    void preparedEditPreservesRedo();
    void historyLimitsAtUndoPosition();
    void invalidUtf8Project();
    void projectRecordBounds();
    void stagedWriteCancellation();
    void gifFirstFrame();
    void reorderedIdenticalLayers();
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
void CoreTests::byteIOPreservesEditingState() {
    paint::Document doc(QSize(24, 20));
    auto edited = doc.state();
    edited.layers[0].name = QStringLiteral("바이트 왕복");
    edited.layers[0].image.setPixelColor(2, 3, Qt::red);
    doc.commit(std::move(edited), QStringLiteral("편집"));
    doc.undo();
    const auto revision = doc.revision();
    const bool dirty = doc.dirty();
    const auto bytes = paint::Document::projectBytes(doc.state());
    const auto restored = paint::Document::readProjectBytes(bytes);
    QCOMPARE(restored.layers[0].image, doc.state().layers[0].image);
    QCOMPARE(restored.layers[0].name, doc.state().layers[0].name);
    QVERIFY_THROWS_EXCEPTION(std::runtime_error, paint::Document::readProjectBytes(bytes.chopped(1)));
    QVERIFY_THROWS_EXCEPTION(std::runtime_error,
                             paint::Document::projectBytes(doc.state(), [] { return true; }));
    const auto png = paint::Document::imageBytes(doc.state(), "png");
    QCOMPARE(paint::Document::readImageBytes(png).layers[0].image, doc.state().layers[0].image);
    QVERIFY_THROWS_EXCEPTION(std::runtime_error, paint::Document::readImageBytes("bad"));
    QCOMPARE(doc.revision(), revision);
    QCOMPARE(doc.dirty(), dirty);
    QVERIFY(doc.canRedo());
    doc.redo();
    QCOMPARE(doc.state().layers[0].image.pixelColor(2, 3), QColor(Qt::red));
}
void CoreTests::preparedEditPreservesRedo() {
    Document doc(QSize(8, 8));
    auto state = doc.state();
    state.layers[0].image.setPixelColor(0, 0, Qt::red);
    doc.commit(state, "red");
    doc.markSaved();
    doc.undo();
    const auto revision = doc.revision();
    state = doc.state();
    state.layers[0].image.setPixelColor(1, 1, Qt::blue);
    {
        auto edit = doc.prepare(state, "blue");
        QVERIFY(edit.changed());
        QTemporaryDir directory;
        QVERIFY_THROWS_EXCEPTION(
            std::runtime_error,
            Document::writeProject(edit.state(), directory.filePath("missing/file.rpaint")));
    }
    QVERIFY(doc.canRedo());
    QCOMPARE(doc.revision(), revision);
    QCOMPARE(doc.composite().pixelColor(1, 1), QColor(Qt::white));
    auto stale = doc.prepare(state, "stale");
    doc.redo();
    QVERIFY_THROWS_EXCEPTION(std::runtime_error, doc.install(std::move(stale)));
    QVERIFY(!doc.dirty());
    QCOMPARE(doc.composite().pixelColor(0, 0), QColor(Qt::red));
}
void CoreTests::historyLimitsAtUndoPosition() {
    Document doc(QSize(2, 2));
    for (size_t i = 0; i < MaxHistoryChanges + 10; ++i) {
        auto state = doc.state();
        state.layers[0].image.setPixelColor(0, 0, i % 2 ? Qt::red : Qt::blue);
        doc.commit(state, "pixel");
    }
    size_t undoCount = 0;
    while (doc.canUndo()) {
        doc.undo();
        ++undoCount;
    }
    QCOMPARE(undoCount, MaxHistoryChanges);
    const auto pixels = doc.composite();
    doc.setHistoryBudget(16);
    QCOMPARE(doc.composite(), pixels);
    QVERIFY(doc.historyBytes() <= 16);
    int redoCount = 0;
    while (doc.canRedo()) {
        doc.redo();
        ++redoCount;
    }
    QCOMPARE(redoCount, 2);
}
void CoreTests::invalidUtf8Project() {
    QTemporaryDir directory;
    auto state = Document::blank(QSize(2, 2));
    state.layers[0].name = "x";
    const auto path = directory.filePath("bad.rpaint");
    Document::writeProject(state, path);
    QFile file(path);
    QVERIFY(file.open(QIODevice::ReadWrite));
    QVERIFY(file.seek(32));
    QCOMPARE(file.write(QByteArray(1, char(0xff))), qint64(1));
    file.close();
    QVERIFY_THROWS_EXCEPTION(std::runtime_error, Document::readProject(path));
}
void CoreTests::projectRecordBounds() {
    QTemporaryDir directory;
    const auto path = directory.filePath("records.rpaint");
    auto state = Document::blank(QSize(2, 2));
    state.layers[0].name = "x";
    Document::writeProject(state, path);
    QFile file(path);
    QVERIFY(file.open(QIODevice::ReadOnly));
    const auto original = file.readAll();
    file.close();
    for (int variant = 0; variant < 6; ++variant) {
        QByteArray bytes = original;
        if (variant == 0)
            bytes[33] = char(2);
        else if (variant == 1)
            bytes[38] = char(0);
        else {
            QBuffer buffer(&bytes);
            QVERIFY(buffer.open(QIODevice::ReadWrite));
            QDataStream stream(&buffer);
            stream.setByteOrder(QDataStream::LittleEndian);
            if (variant == 2 || variant == 3) {
                QVERIFY(buffer.seek(34));
                stream << quint32(variant == 2 ? 0 : MaxLayerEncodedBytes + 1);
            } else if (variant == 4) {
                QVERIFY(buffer.seek(8));
                stream << quint32(1);
            } else {
                QVERIFY(buffer.seek(8));
                stream << quint32(8192) << quint32(4096) << quint32(3);
            }
        }
        QVERIFY(file.open(QIODevice::WriteOnly | QIODevice::Truncate));
        QCOMPARE(file.write(bytes), qint64(bytes.size()));
        file.close();
        QVERIFY_THROWS_EXCEPTION(std::runtime_error, Document::readProject(path));
    }
    Document::validateSize(QSize(8192, 4096), 2);
    QVERIFY_THROWS_EXCEPTION(std::runtime_error, Document::validateSize(QSize(8192, 4096), 3));
    state.layers[0].name = QString(QChar(0xd800));
    QVERIFY_THROWS_EXCEPTION(std::runtime_error, Document::validate(state));
}
void CoreTests::stagedWriteCancellation() {
    QTemporaryDir directory;
    const auto path = directory.filePath("original.rpaint");
    QFile original(path);
    QVERIFY(original.open(QIODevice::WriteOnly));
    QCOMPARE(original.write("original"), qint64(8));
    original.close();
    {
        auto staged = Document::stageProject(Document::blank(QSize(8, 8)), path);
        QVERIFY(original.open(QIODevice::ReadOnly));
        QCOMPARE(original.readAll(), QByteArray("original"));
        original.close();
        staged->cancelWriting();
        QVERIFY(!staged->commit());
    }
    QVERIFY(original.open(QIODevice::ReadOnly));
    QCOMPARE(original.readAll(), QByteArray("original"));
    QCOMPARE(QDir(directory.path()).entryList(QDir::Files | QDir::Hidden).size(), 1);
}
void CoreTests::gifFirstFrame() {
    QTemporaryDir directory;
    QFile file(directory.filePath("two-frames.gif"));
    QVERIFY(file.open(QIODevice::WriteOnly));
    const auto bytes = QByteArray::fromHex("47494638396101000100800000ff00000000ff"
                                           "2c0000000001000100000202440100"
                                           "2c00000000010001000002024c01003b");
    QCOMPARE(file.write(bytes), qint64(bytes.size()));
    file.close();
    const auto state = Document::readImage(file.fileName());
    QCOMPARE(state.size, QSize(1, 1));
    QCOMPARE(state.layers[0].image.pixelColor(0, 0), QColor(Qt::red));
}
void CoreTests::reorderedIdenticalLayers() {
    Document doc(QSize(8, 8));
    auto state = doc.state();
    state.layers.push_back(state.layers[0]);
    doc.reset(state);
    state.layers.swapItemsAt(0, 1);
    state.active = 1;
    QVERIFY(doc.commit(state, "reorder", CommitMode::Structural));
    doc.undo();
    QCOMPARE(doc.state().active, 0);
    QVERIFY(!doc.dirty());
    doc.redo();
    QCOMPARE(doc.state().active, 1);
    QVERIFY(doc.dirty());
    doc.reset(state);
    state.active = 0;
    QVERIFY(doc.commit(state, "active candidate"));
    doc.undo();
    QCOMPARE(doc.state().active, 1);
    QVERIFY(!doc.dirty());
    doc.setActive(0);
    QVERIFY(!doc.dirty());
}
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
    QVERIFY_THROWS_EXCEPTION(std::runtime_error, Document::readProject(path));
    auto state = Document::blank(QSize(2, 2));
    Document::writeProject(state, path);
    QVERIFY(file.open(QIODevice::Append));
    file.write("trailing");
    file.close();
    QVERIFY_THROWS_EXCEPTION(std::runtime_error, Document::readProject(path));
}
void CoreTests::failedSavePreservesOriginal() {
    QTemporaryDir dir;
    const QString path = dir.filePath("original.png");
    QFile f(path);
    QVERIFY(f.open(QIODevice::WriteOnly));
    f.write("original");
    f.close();
    QVERIFY_THROWS_EXCEPTION(std::runtime_error,
                             Document::writeImage(Document::blank(QSize(2, 2)), path, "unknown"));
    QVERIFY(f.open(QIODevice::ReadOnly));
    QCOMPARE(f.readAll(), QByteArray("original"));
    QVERIFY_THROWS_EXCEPTION(std::runtime_error, Document::writeProject(Document::blank(QSize(2, 2)),
                                                                        dir.filePath("missing/out.rpaint")));
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
    QRgb pixel = qRgb(255, 0, 0);
    QImage oversized(reinterpret_cast<uchar *>(&pixel), 1, 1, MaxPixels * 4 + 4,
                     QImage::Format_ARGB32_Premultiplied);
    QVERIFY(!oversized.isNull());
    auto padded = Document::blank(QSize(1, 1));
    padded.layers[0].image = oversized;
    QVERIFY_THROWS_EXCEPTION(std::runtime_error, Document::validate(padded));
    QVERIFY_THROWS_EXCEPTION(std::runtime_error, Document::flood(oversized, QPoint(0, 0), Qt::blue));
    QVERIFY_THROWS_EXCEPTION(std::runtime_error, Document::allocate(QSize(-1, 1)));
    QVERIFY_THROWS_EXCEPTION(std::runtime_error, Document::allocate(QSize(32768, 32768)));
    auto s = Document::blank(QSize(2, 2));
    s.active = 4;
    QVERIFY_THROWS_EXCEPTION(std::runtime_error, Document::validate(s));
    Document doc(QSize(3, 3));
    const auto revision = doc.revision();
    QVERIFY_THROWS_EXCEPTION(std::runtime_error, doc.commit(s, "bad"));
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
        QVERIFY_THROWS_EXCEPTION(std::runtime_error, Document::readProject(path));
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
        QVERIFY_THROWS_EXCEPTION(std::runtime_error, Document::readProject(path));
    }
    QImage indexed(QSize(4, 4), QImage::Format_Grayscale8);
    indexed.fill(0);
    QVERIFY_THROWS_EXCEPTION(std::runtime_error, Document::flood(indexed, QPoint(0, 0), Qt::red));
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
