#include "document.h"
#include <QBuffer>
#include <QDataStream>
#include <QFile>
#include <QFileInfo>
#include <QImageReader>
#include <QImageWriter>
#include <QPainter>
#include <QSaveFile>
#include <algorithm>
#include <cstring>
#include <stdexcept>

namespace paint {
static void fail(const QString &message) { throw std::runtime_error(message.toStdString()); }
void Document::validateSize(QSize size, qsizetype layerCount) {
    if (size.width() < 1 || size.height() < 1 || size.width() > 32768 || size.height() > 32768 ||
        layerCount < 1 || layerCount > MaxLayers || qint64(size.width()) * size.height() > MaxPixels ||
        qint64(size.width()) * size.height() * layerCount > MaxDocumentPixels)
        fail(QStringLiteral(
            "이미지 크기 또는 레이어 메모리 한도를 초과합니다 (이미지 32M / 레이어 합계 64M 픽셀)."));
}
QImage Document::allocate(QSize size, QColor fill) {
    validateSize(size);
    QImage image(size, QImage::Format_ARGB32_Premultiplied);
    if (image.isNull())
        throw std::bad_alloc();
    image.fill(fill);
    return image;
}
State Document::blank(QSize size, QColor background) {
    return {size, background, {{QStringLiteral("배경"), allocate(size, background), true}}, 0};
}
void Document::validate(const State &s) {
    if (s.layers.isEmpty() || s.layers.size() > MaxLayers || s.active < 0 || s.active >= s.layers.size())
        fail(QStringLiteral("레이어 구성이 올바르지 않습니다."));
    validateSize(s.size, s.layers.size());
    for (const auto &layer : s.layers)
        if (layer.image.isNull() || layer.image.size() != s.size ||
            layer.image.format() != QImage::Format_ARGB32_Premultiplied || layer.name.size() > 256)
            fail(QStringLiteral("레이어 이미지가 올바르지 않습니다."));
}
Document::Document(QSize size) : current(blank(size)) {}
void Document::setActive(int index) {
    if (index >= 0 && index < current.layers.size())
        current.active = index;
}
void Document::reset(State state, QString filePath) {
    validate(state);
    current = std::move(state);
    path = std::move(filePath);
    history.clear();
    cursor = 0;
    retainedBytes = 0;
    currentId = nextId++;
    savedId = currentId;
}
bool Document::commit(State candidate, const QString &label) {
    validate(candidate);
    Change change;
    change.label = label;
    change.beforeId = currentId;
    change.afterId = nextId;
    change.structural = current.size != candidate.size || current.background != candidate.background ||
                        current.layers.size() != candidate.layers.size();
    if (!change.structural) {
        for (int i = 0; i < current.layers.size(); ++i)
            if (current.layers[i].name != candidate.layers[i].name ||
                current.layers[i].visible != candidate.layers[i].visible)
                change.structural = true;
    }
    if (change.structural) {
        change.before = current;
        change.after = candidate;
        for (const auto &s : {current, candidate})
            for (const auto &layer : s.layers)
                change.bytes += layer.image.sizeInBytes();
    } else {
        for (int i = 0; i < current.layers.size(); ++i) {
            const auto &before = current.layers[i].image;
            const auto &after = candidate.layers[i].image;
            if (before.cacheKey() == after.cacheKey())
                continue;
            int left = before.width(), right = -1, top = before.height(), bottom = -1;
            for (int y = 0; y < before.height(); ++y) {
                const auto *a = reinterpret_cast<const QRgb *>(before.constScanLine(y));
                const auto *b = reinterpret_cast<const QRgb *>(after.constScanLine(y));
                if (std::memcmp(a, b, size_t(before.width()) * 4) == 0)
                    continue;
                top = std::min(top, y);
                bottom = y;
                int x = 0;
                while (x < before.width() && a[x] == b[x])
                    ++x;
                left = std::min(left, x);
                x = before.width() - 1;
                while (x >= 0 && a[x] == b[x])
                    --x;
                right = std::max(right, x);
            }
            if (right < left)
                continue;
            QRect rect(QPoint(left, top), QPoint(right, bottom));
            QImage a = before.copy(rect), b = after.copy(rect);
            if (a.isNull() || b.isNull())
                throw std::bad_alloc();
            change.bytes += a.sizeInBytes() + b.sizeInBytes();
            change.patches.push_back({i, rect, std::move(a), std::move(b)});
        }
        if (change.patches.isEmpty())
            return false;
    }
    // Reserve first: allocation failures must not truncate the redo branch.
    history.reserve(history.size() + 1);
    for (size_t i = cursor; i < history.size(); ++i)
        retainedBytes -= history[i].bytes;
    history.erase(history.begin() + qptrdiff(cursor), history.end());
    retainedBytes += change.bytes;
    history.push_back(std::move(change));
    current = std::move(candidate);
    currentId = nextId++;
    cursor = history.size();
    while (retainedBytes > budget && history.size() > 1) {
        retainedBytes -= history.front().bytes;
        history.erase(history.begin());
        --cursor;
    }
    return true;
}
void Document::apply(const Change &change, bool forward) {
    State candidate = current;
    if (change.structural)
        candidate = forward ? change.after : change.before;
    else
        for (const auto &patch : change.patches) {
            auto &image = candidate.layers[patch.layer].image;
            if (!image.bits())
                throw std::bad_alloc();
            QPainter painter(&image);
            painter.setCompositionMode(QPainter::CompositionMode_Source);
            painter.drawImage(patch.rect.topLeft(), forward ? patch.after : patch.before);
        }
    current = std::move(candidate);
    currentId = forward ? change.afterId : change.beforeId;
}
void Document::undo() {
    if (canUndo()) {
        apply(history[cursor - 1], false);
        --cursor;
    }
}
void Document::redo() {
    if (canRedo()) {
        apply(history[cursor], true);
        ++cursor;
    }
}
void Document::setHistoryBudget(qint64 bytes) { budget = std::max(qint64(0), bytes); }
QImage Document::flatten(const State &s) {
    validate(s);
    QImage image = allocate(s.size);
    QPainter p(&image);
    for (const auto &layer : s.layers)
        if (layer.visible)
            p.drawImage(0, 0, layer.image);
    return image;
}
QImage Document::composite() const { return flatten(current); }
State Document::resized(const State &state, QSize size, bool scale, bool smooth) {
    validate(state);
    validateSize(size, state.layers.size());
    State result = state;
    result.size = size;
    for (int i = 0; i < result.layers.size(); ++i) {
        QImage image;
        if (scale) {
            image = state.layers[i].image.scaled(size, Qt::IgnoreAspectRatio,
                                                 smooth ? Qt::SmoothTransformation : Qt::FastTransformation);
            if (image.isNull())
                throw std::bad_alloc();
        } else {
            image = allocate(size, i == 0 ? state.background : QColor(Qt::transparent));
            QPainter painter(&image);
            painter.setCompositionMode(QPainter::CompositionMode_Source);
            painter.drawImage(0, 0, state.layers[i].image);
        }
        result.layers[i].image = std::move(image);
    }
    validate(result);
    return result;
}
State Document::readImage(const QString &path) {
    QFile file(path);
    if (!QFileInfo(path).isFile() || !file.open(QIODevice::ReadOnly) || file.size() > 300LL * 1024 * 1024)
        fail(QStringLiteral("읽을 수 없거나 너무 큰 이미지 파일입니다 (최대 300 MiB)."));
    const QByteArray header = file.peek(12);
    QByteArray format;
    if (header.startsWith(QByteArray::fromHex("89504e470d0a1a0a")))
        format = "png";
    else if (header.startsWith(QByteArray::fromHex("ffd8ff")))
        format = "jpeg";
    else if (header.startsWith("BM"))
        format = "bmp";
    else if (header.startsWith("GIF87a") || header.startsWith("GIF89a"))
        format = "gif";
    else
        fail(QStringLiteral("PNG, JPEG, BMP, GIF 이미지만 열 수 있습니다."));
    QImageReader reader(&file, format);
    reader.setAutoDetectImageFormat(false);
    reader.setDecideFormatFromContent(false);
    reader.setAutoTransform(true);
    reader.setAllocationLimit(128);
    const QSize size = reader.size();
    validateSize(size);
    QImage image = reader.read();
    if (image.isNull())
        fail(reader.errorString());
    image = image.convertToFormat(QImage::Format_ARGB32_Premultiplied);
    if (image.isNull())
        throw std::bad_alloc();
    State state{image.size(), Qt::white, {{QStringLiteral("이미지"), image, true}}, 0};
    validate(state);
    return state;
}
void Document::writeImage(const State &state, const QString &path, const QByteArray &format) {
    if (format != "png" && format != "jpg" && format != "jpeg" && format != "bmp")
        fail(QStringLiteral("PNG, JPEG, BMP 형식으로 저장하세요."));
    QImage image = flatten(state);
    if (format != "png") {
        QImage opaque = allocate(state.size, state.background);
        QPainter painter(&opaque);
        painter.drawImage(0, 0, image);
        painter.end();
        image = opaque.convertToFormat(QImage::Format_RGB32);
    }
    QSaveFile file(path);
    file.setDirectWriteFallback(false);
    if (!file.open(QIODevice::WriteOnly))
        fail(file.errorString());
    QImageWriter writer(&file, format);
    writer.setQuality(95);
    if (!writer.write(image))
        fail(writer.errorString());
    if (!file.commit())
        fail(file.errorString());
}
void Document::writeProject(const State &state, const QString &path) {
    validate(state);
    QSaveFile file(path);
    file.setDirectWriteFallback(false);
    if (!file.open(QIODevice::WriteOnly))
        fail(file.errorString());
    QDataStream stream(&file);
    stream.setByteOrder(QDataStream::LittleEndian);
    stream.writeRawData("RPAINT01", 8);
    stream << quint32(state.size.width()) << quint32(state.size.height()) << quint32(state.layers.size())
           << quint32(state.active) << quint32(state.background.rgba());
    for (const auto &layer : state.layers) {
        const auto name = layer.name.toUtf8();
        QByteArray png;
        QBuffer buffer(&png);
        buffer.open(QIODevice::WriteOnly);
        if (!layer.image.save(&buffer, "PNG"))
            fail(QStringLiteral("레이어 인코딩 실패"));
        stream << quint32(name.size());
        stream.writeRawData(name.constData(), name.size());
        stream << quint8(layer.visible) << quint32(png.size());
        stream.writeRawData(png.constData(), png.size());
    }
    if (stream.status() != QDataStream::Ok || !file.commit())
        fail(QStringLiteral("프로젝트 저장 실패"));
}
State Document::readProject(const QString &path) {
    QFile file(path);
    if (!QFileInfo(path).isFile() || !file.open(QIODevice::ReadOnly))
        fail(file.errorString());
    if (file.size() > 300LL * 1024 * 1024)
        fail(QStringLiteral("프로젝트 파일이 너무 큽니다."));
    QDataStream stream(&file);
    stream.setByteOrder(QDataStream::LittleEndian);
    char magic[8];
    if (stream.readRawData(magic, 8) != 8 || std::memcmp(magic, "RPAINT01", 8))
        fail(QStringLiteral("올바른 RetroPaint 프로젝트가 아닙니다."));
    quint32 w = 0, h = 0, count = 0, active = 0, background = 0;
    stream >> w >> h >> count >> active >> background;
    if (stream.status() != QDataStream::Ok || w < 1 || h < 1 || w > 32768 || h > 32768 ||
        quint64(w) * h > MaxPixels || count < 1 || count > MaxLayers || active >= count ||
        quint64(w) * h * count > MaxDocumentPixels)
        fail(QStringLiteral("프로젝트 크기 또는 레이어 정보가 잘못되었습니다."));
    State state{QSize(int(w), int(h)), QColor::fromRgba(background), {}, int(active)};
    for (quint32 i = 0; i < count; ++i) {
        quint32 length = 0;
        stream >> length;
        if (length > 1024 || length > file.bytesAvailable())
            fail(QStringLiteral("레이어 이름이 잘못되었습니다."));
        QByteArray name(length, Qt::Uninitialized);
        if (stream.readRawData(name.data(), int(length)) != int(length))
            fail(QStringLiteral("잘린 프로젝트"));
        quint8 visible = 0;
        stream >> visible >> length;
        if (visible > 1 || length == 0 || length > 140U * 1024 * 1024 || length > file.bytesAvailable())
            fail(QStringLiteral("레이어 데이터가 잘못되었습니다."));
        QByteArray bytes(length, Qt::Uninitialized);
        if (stream.readRawData(bytes.data(), int(length)) != int(length))
            fail(QStringLiteral("잘린 프로젝트"));
        QBuffer buffer(&bytes);
        buffer.open(QIODevice::ReadOnly);
        QImageReader reader(&buffer, "PNG");
        reader.setAllocationLimit(128);
        if (reader.size() != state.size)
            fail(QStringLiteral("레이어 크기 불일치"));
        QImage image = reader.read().convertToFormat(QImage::Format_ARGB32_Premultiplied);
        if (image.isNull())
            fail(QStringLiteral("레이어 디코딩 실패"));
        const QString layerName = QString::fromUtf8(name);
        if (layerName.size() > 256)
            fail(QStringLiteral("레이어 이름이 너무 깁니다."));
        state.layers.push_back({layerName, image, bool(visible)});
    }
    if (stream.status() != QDataStream::Ok || !file.atEnd())
        fail(QStringLiteral("잘리거나 추가 데이터가 있는 프로젝트"));
    validate(state);
    return state;
}
bool Document::flood(QImage &image, QPoint start, QColor color, const std::function<bool()> &cancel) {
    if (image.format() != QImage::Format_ARGB32_Premultiplied)
        fail(QStringLiteral("채우기는 내부 32비트 이미지 형식만 지원합니다."));
    if (!image.rect().contains(start))
        return false;
    const QRgb target = image.pixel(start), replacement = qPremultiply(color.rgba());
    if (target == replacement)
        return false;
    auto *pixels = reinterpret_cast<QRgb *>(image.bits());
    if (!pixels)
        throw std::bad_alloc();
    const int stride = image.bytesPerLine() / 4, w = image.width(), h = image.height();
    std::vector<QPoint> spans{start};
    while (!spans.empty()) {
        if (cancel && cancel())
            return false;
        const QPoint point = spans.back();
        spans.pop_back();
        const int y = point.y();
        int x = point.x();
        if (pixels[y * stride + x] != target)
            continue;
        int left = x;
        while (left > 0 && pixels[y * stride + left - 1] == target)
            --left;
        int right = x;
        while (right + 1 < w && pixels[y * stride + right + 1] == target)
            ++right;
        for (int column = left; column <= right; ++column)
            pixels[y * stride + column] = replacement;
        for (int row : {y - 1, y + 1})
            if (row >= 0 && row < h) {
                bool span = false;
                for (int column = left; column <= right; ++column) {
                    const bool matches = pixels[row * stride + column] == target;
                    if (matches && !span)
                        spans.emplace_back(column, row);
                    span = matches;
                }
            }
    }
    return true;
}
} // namespace paint
