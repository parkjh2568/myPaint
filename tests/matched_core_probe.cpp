#include "document.h"
#include <QCommandLineParser>
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QSaveFile>
#include <QSet>
#include <QSysInfo>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <stdexcept>

static QByteArray readBounded(const QString &path, qint64 limit) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly) || file.size() < 1 || file.size() > limit)
        throw std::runtime_error("Invalid bounded input file");
    const auto bytes = file.read(limit + 1);
    if (bytes.size() > limit || bytes.size() != file.size() || !file.atEnd())
        throw std::runtime_error("Incomplete input read");
    return bytes;
}
static QString sha256(QByteArrayView bytes) {
    return QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex());
}
// Canonical comparison is outside timing; native QImage ARGB/BGRA bytes are not RGBA authority.
static QString planeSha256(const QImage &image) {
    const auto rgba = image.convertToFormat(QImage::Format_RGBA8888);
    if (rgba.isNull())
        throw std::runtime_error("Canonical image allocation failed");
    QCryptographicHash hash(QCryptographicHash::Sha256);
    for (int y = 0; y < rgba.height(); ++y)
        hash.addData(QByteArrayView(reinterpret_cast<const char *>(rgba.constScanLine(y)), rgba.width() * 4));
    return QString::fromLatin1(hash.result().toHex());
}
static QJsonArray verifyState(const paint::State &state, const QJsonObject &fixture) {
    paint::Document::validate(state);
    const auto layers = fixture.value("layers").toArray();
    const auto background = fixture.value("background").toArray();
    const QJsonArray actualBackground{state.background.red(), state.background.green(),
                                      state.background.blue(), state.background.alpha()};
    if (state.size != QSize(fixture.value("width").toInt(), fixture.value("height").toInt()) ||
        state.active != fixture.value("active").toInt() || state.layers.size() != layers.size() ||
        actualBackground != background)
        throw std::runtime_error("Document metadata mismatch");
    QJsonArray hashes;
    for (qsizetype i = 0; i < layers.size(); ++i) {
        const auto expected = layers[i].toObject();
        const auto &layer = state.layers[i];
        const auto hash = planeSha256(layer.image);
        if (layer.name != expected.value("name").toString() ||
            layer.visible != expected.value("visible").toBool() ||
            hash != expected.value("sha256").toString())
            throw std::runtime_error("Layer metadata or full RGBA mismatch");
        hashes.append(hash);
    }
    return hashes;
}
// Atomic replacement is confined to this run's exclusively created directory.
static void writeOwnedFile(const QString &path, const QByteArray &bytes) {
    if (QFileInfo::exists(path))
        throw std::runtime_error("Output file already exists");
    QSaveFile file(path);
    file.setDirectWriteFallback(false);
    if (!file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size() || !file.commit())
        throw std::runtime_error("Atomic output write failed");
}
int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    QCommandLineParser parser;
    parser.addHelpOption();
    parser.addOptions(
        {{QStringLiteral("spec"), "Canonical fixture specification", "path"},
         {QStringLiteral("fixtures"), "Fixture directory", "path"},
         {QStringLiteral("output"), "New output directory", "path"},
         {QStringLiteral("verify"), "Cross-decode encoded projects from another backend", "path"},
         {QStringLiteral("samples"), "Measured repetitions", "count", "3"},
         {QStringLiteral("warmups"), "Excluded warmups", "count", "1"},
         {QStringLiteral("budget-ms"), "Soft checkpoint budget", "milliseconds", "90000"}});
    parser.process(app);
    QJsonObject result{
        {"schema", 1},
        {"backend", "qt-native"},
        {"ok", false},
        {"qt", qVersion()},
        {"arch", QSysInfo::currentCpuArchitecture()},
        {"os", QSysInfo::prettyProductName()},
        {"scope", "Native-host core API method validation; no UI, Wasm, physical input, stable-tail or "
                  "overall-app speedup claim"},
        {"compression", "Production native QImageWriter PNG default; no explicit compression setting, not "
                        "the Wasm compression0 branch"},
        {"timing", "Wall time; validation/canonical hash/setup/output writes and caller-owned output release "
                   "outside timing. Callee-internal RAII may be inside a call. Configured warmups/samples "
                   "recorded; small samples descriptive only"}};
    QJsonArray rows, crossDecoded;
    QString output;
    int activeRow = -1;
    double activeElapsed = -1;
    QElapsedTimer operationTimer;
    QElapsedTimer total;
    total.start();
    try {
        bool sampleOk = false, warmOk = false, budgetOk = false;
        const int samples = parser.value("samples").toInt(&sampleOk),
                  warmups = parser.value("warmups").toInt(&warmOk),
                  budgetMs = parser.value("budget-ms").toInt(&budgetOk);
        if (!sampleOk || samples < 3 || samples > 30 || !warmOk || warmups < 0 || warmups > 10 || !budgetOk ||
            budgetMs < 1000 || budgetMs > 120000 || parser.value("fixtures").isEmpty() ||
            parser.value("output").isEmpty())
            throw std::runtime_error("Invalid explicit measurement options");
        const QDir directory(parser.value("fixtures"));
        const QString verifyDirectory = parser.value("verify");
        const auto specBytes = readBounded(parser.value("spec"), 1048576);
        const auto specification = QJsonDocument::fromJson(specBytes).object();
        const auto expectedFixtures = specification.value("fixtures").toArray();
        if (specification.value("schema").toInt() != 1 || expectedFixtures.size() != 6)
            throw std::runtime_error("Invalid canonical specification");
        const auto manifestBytes = readBounded(directory.filePath("manifest.json"), 1048576);
        QJsonParseError error;
        const auto parsed = QJsonDocument::fromJson(manifestBytes, &error);
        const auto manifest = parsed.object();
        const auto fixtures = manifest.value("fixtures").toArray();
        if (error.error != QJsonParseError::NoError || manifest.value("schema").toInt() != 1 ||
            fixtures.size() != 6)
            throw std::runtime_error("Invalid fixture manifest");
        if (manifest.value("specSha256").toString() != sha256(specBytes))
            throw std::runtime_error("Canonical specification hash mismatch");
        for (qsizetype i = 0; i < fixtures.size(); ++i) {
            auto actual = fixtures[i].toObject();
            actual.remove("wireBytes");
            actual.remove("wireSha256");
            auto actualLayers = actual.value("layers").toArray();
            for (qsizetype j = 0; j < actualLayers.size(); ++j) {
                auto layer = actualLayers[j].toObject();
                layer.remove("pngBytes");
                actualLayers[j] = layer;
            }
            actual["layers"] = actualLayers;
            if (actual != expectedFixtures[i].toObject())
                throw std::runtime_error("Exact canonical fixture/case set mismatch");
        }
        output = QDir::cleanPath(parser.value("output"));
        if (!QDir().mkdir(output)) {
            output.clear();
            throw std::runtime_error("Output directory must be new");
        }
        result["samples"] = samples;
        result["warmups"] = warmups;
        result["budgetMs"] = budgetMs;
        result["mode"] = verifyDirectory.isEmpty() ? "benchmark" : "cross-decode-only";
        result["manifestSha256"] = sha256(manifestBytes);
        QSet<QString> seen;
        for (const auto &entry : fixtures) {
            const auto fixture = entry.toObject();
            const QString id = fixture.value("id").toString();
            if (!QRegularExpression(QStringLiteral("^[a-z0-9-]+$")).match(id).hasMatch() || seen.contains(id))
                throw std::runtime_error("Invalid fixture identity");
            seen.insert(id);
            const auto operations = fixture.value("operations").toArray();
            if (!verifyDirectory.isEmpty() && !operations.contains("project-encode"))
                continue;
            const auto wire = readBounded(
                QDir(verifyDirectory.isEmpty() ? directory.path() : verifyDirectory).filePath(id + ".rpaint"),
                40LL * 1048576);
            const auto wireHash = sha256(wire);
            if (verifyDirectory.isEmpty() && (wire.size() != fixture.value("wireBytes").toInteger() ||
                                              wireHash != fixture.value("wireSha256").toString()))
                throw std::runtime_error("Input wire identity mismatch");
            const auto source = paint::Document::readProjectBytes(wire);
            const auto sourcePlanes = verifyState(source, fixture);
            const qint64 logicalBytes =
                qint64(source.size.width()) * source.size.height() * 4 * source.layers.size();
            if (!verifyDirectory.isEmpty()) {
                crossDecoded.append(QJsonObject{{"id", id},
                                                {"wireBytes", double(wire.size())},
                                                {"wireSha256", wireHash},
                                                {"planeSha256", sourcePlanes}});
                continue;
            }
            for (const auto &operationValue : operations) {
                const auto operation = operationValue.toString();
                if (operation != "project-decode" && operation != "project-encode" &&
                    operation != "deep-copy" && operation != "flood")
                    throw std::runtime_error("Unknown operation");
                QVector<double> durations;
                rows.append(QJsonObject{{"id", id},
                                        {"operation", operation},
                                        {"attempts", QJsonArray{}},
                                        {"durationsMs", QJsonArray{}}});
                QByteArray lastEncoded;
                qint64 outputBytes = 0;
                for (int repeat = -warmups; repeat < samples; ++repeat) {
                    if (total.elapsed() >= budgetMs)
                        throw std::runtime_error("Soft operation budget exhausted");
                    paint::State produced;
                    QImage filled;
                    QByteArray encoded;
                    bool changed = false;
                    if (operation == "flood") {
                        if (source.layers.size() != 1)
                            throw std::runtime_error("Fill operand must be a single plane");
                        filled = source.layers[0].image;
                        if (filled.constBits() != source.layers[0].image.constBits())
                            throw std::runtime_error("COW candidate must initially share immutable source");
                    }
                    const auto fill = fixture.value("fill").toObject();
                    const auto color = fill.value("color").toArray();
                    const QColor replacement =
                        operation == "flood"
                            ? QColor(color[0].toInt(), color[1].toInt(), color[2].toInt(), color[3].toInt())
                            : QColor();
                    activeRow = int(rows.size() - 1);
                    activeElapsed = -1;
                    auto partial = rows[activeRow].toObject();
                    auto attempts = partial.value("attempts").toArray();
                    attempts.append(QJsonObject{{"phase", repeat < 0 ? "warmup" : "measured"},
                                                {"index", repeat < 0 ? repeat + warmups : repeat},
                                                {"status", "started"}});
                    partial["attempts"] = attempts;
                    rows[activeRow] = partial;
                    operationTimer.start();
                    if (operation == "project-decode")
                        produced = paint::Document::readProjectBytes(wire);
                    else if (operation == "project-encode")
                        encoded = paint::Document::projectBytes(source);
                    else if (operation == "deep-copy") {
                        produced = source;
                        for (auto &layer : produced.layers)
                            layer.image = layer.image.copy();
                    } else
                        changed = paint::Document::flood(
                            filled, QPoint(fill.value("x").toInt(), fill.value("y").toInt()), replacement);
                    const double elapsed = double(operationTimer.nsecsElapsed()) / 1000000.0;
                    activeElapsed = elapsed;
                    if (operation == "project-encode") {
                        verifyState(paint::Document::readProjectBytes(encoded), fixture);
                        outputBytes = encoded.size();
                        lastEncoded = encoded;
                    } else if (operation == "flood") {
                        if (!changed || filled.constBits() == source.layers[0].image.constBits() ||
                            planeSha256(filled) != fill.value("sha256").toString())
                            throw std::runtime_error(
                                "Fill must produce an independent exact opaque-red plane");
                        outputBytes = filled.sizeInBytes();
                    } else {
                        if (operation == "deep-copy")
                            for (qsizetype i = 0; i < produced.layers.size(); ++i)
                                if (produced.layers[i].image.constBits() ==
                                    source.layers[i].image.constBits())
                                    throw std::runtime_error(
                                        "Shallow image copy cannot satisfy deep-copy operation");
                        verifyState(produced, fixture);
                        outputBytes = logicalBytes;
                    }
                    verifyState(source, fixture);
                    if (sha256(wire) != wireHash)
                        throw std::runtime_error("Input bytes changed");
                    auto attempt = attempts.last().toObject();
                    attempt["elapsedMs"] = elapsed;
                    attempt["status"] = "validated";
                    attempts[attempts.size() - 1] = attempt;
                    partial["attempts"] = attempts;
                    if (repeat >= 0)
                        durations.append(elapsed);
                    QJsonArray retained;
                    for (double value : durations)
                        retained.append(value);
                    partial["durationsMs"] = retained;
                    rows[activeRow] = partial;
                    activeRow = -1;
                }
                auto sorted = durations;
                std::sort(sorted.begin(), sorted.end());
                QJsonArray raw;
                for (double sample : durations)
                    raw.append(sample);
                QJsonObject completed{
                    {"id", id},
                    {"operation", operation},
                    {"sourceWireSha256", wireHash},
                    {"sourcePlaneSha256", sourcePlanes},
                    {"operandKind", operation == "project-decode" ? "same encoded input bytes"
                                    : operation == "flood"        ? "immutable white QImage COW candidate"
                                                                  : "decoded immutable State"},
                    {"operandBytes", double(operation == "project-decode" ? wire.size() : logicalBytes)},
                    {"logicalPixelBytes", double(logicalBytes)},
                    {"outputBytes", double(outputBytes)},
                    {"dimensions", QJsonArray{source.size.width(), source.size.height()}},
                    {"layers", source.layers.size()},
                    {"durationsMs", raw},
                    {"p50", sorted[int(std::ceil(samples * 0.5)) - 1]},
                    {"p95", sorted[int(std::ceil(samples * 0.95)) - 1]},
                    {"p99", sorted[int(std::ceil(samples * 0.99)) - 1]},
                    {"inputPreserved", true},
                    {"outputVerified", true},
                    {"independentMutableOutput", operation == "flood" || operation == "deep-copy"},
                    {"boundary", operation == "flood"
                                     ? "Immutable white plane -> independent opaque-red output; shallow "
                                       "handle setup excluded, production COW detach/allocation included"
                                 : operation == "deep-copy"
                                     ? "Forced mutable pixel deep copy, not normal Qt COW snapshot cost"
                                     : "In-memory production codec, no filesystem I/O"}};
                completed["attempts"] = rows.last().toObject().value("attempts");
                rows[rows.size() - 1] = completed;
                if (!lastEncoded.isEmpty())
                    writeOwnedFile(QDir(output).filePath(id + ".rpaint"), lastEncoded);
            }
        }
        if ((verifyDirectory.isEmpty() && rows.size() != 12) ||
            (!verifyDirectory.isEmpty() && crossDecoded.size() != 3))
            throw std::runtime_error("Incomplete expected case set");
        result["ok"] = true;
    } catch (const std::exception &error) {
        if (activeRow >= 0) {
            auto partial = rows[activeRow].toObject();
            auto attempts = partial.value("attempts").toArray();
            auto attempt = attempts.last().toObject();
            attempt["status"] = "failed";
            attempt["elapsedScope"] =
                activeElapsed < 0 ? "throwing-call observation" : "completed call before validation failure";
            attempt["elapsedMs"] =
                activeElapsed < 0 ? double(operationTimer.nsecsElapsed()) / 1000000.0 : activeElapsed;
            attempts[attempts.size() - 1] = attempt;
            partial["attempts"] = attempts;
            rows[activeRow] = partial;
        }
        result["error"] = QString::fromUtf8(error.what());
    }
    result["rows"] = rows;
    result["crossDecoded"] = crossDecoded;
    result["elapsedMs"] = double(total.nsecsElapsed()) / 1000000.0;
    const auto json = QJsonDocument(result).toJson();
    try {
        if (!output.isEmpty())
            writeOwnedFile(QDir(output).filePath("results.json"), json);
    } catch (const std::exception &error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
    std::fwrite(json.constData(), 1, size_t(json.size()), stdout);
    return result.value("ok").toBool() ? 0 : 1;
}
