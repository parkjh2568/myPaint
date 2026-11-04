#include "document.h"
#include <QBuffer>
#include <QDataStream>
#include <QFile>
#include <QFileInfo>
#include <QImageReader>
#include <QImageWriter>
#include <QPainter>
#include <QSaveFile>
#include <QStringDecoder>
#include <algorithm>
#include <cstring>
#include <stdexcept>
#include <type_traits>

namespace paint {
static void fail(const QString &message) { throw std::runtime_error(message.toStdString()); }
class BoundedBuffer final : public QBuffer {
  public:
    BoundedBuffer(QByteArray *bytes, qint64 limit) : QBuffer(bytes), limit(limit) {}
    bool seek(qint64 position) override {
        if (position < 0 || position > limit) {
            setErrorString(QStringLiteral("출력 버퍼 한도를 초과했습니다."));
            return false;
        }
        return QBuffer::seek(position);
    }

  protected:
    qint64 writeData(const char *data, qint64 length) override {
        if (length < 0 || pos() < 0 || pos() > limit || length > limit - pos()) {
            setErrorString(QStringLiteral("출력 버퍼 한도를 초과했습니다."));
            return -1;
        }
        return QBuffer::writeData(data, length);
    }

  private:
    qint64 limit;
};

void Document::validateSize(QSize size, qsizetype layerCount) {
    if (size.width() < 1 || size.height() < 1 || size.width() > MaxDimension ||
        size.height() > MaxDimension || layerCount < 1 || layerCount > MaxLayers ||
        qint64(size.width()) * size.height() > MaxPixels ||
        qint64(size.width()) * size.height() * layerCount > MaxDocumentPixels)
        fail(QStringLiteral(
                 "이미지 크기 또는 레이어 메모리 한도를 초과합니다 (이미지 %1M / 레이어 합계 %2M 픽셀).")
                 .arg(MaxPixels / 1024 / 1024)
                 .arg(MaxDocumentPixels / 1024 / 1024));
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
    qint64 decodedBytes = 0;
    for (const auto &layer : s.layers) {
        if (layer.image.isNull() || layer.image.size() != s.size ||
            layer.image.format() != QImage::Format_ARGB32_Premultiplied)
            fail(QStringLiteral("레이어 이미지가 올바르지 않습니다."));
        decodedBytes += layer.image.sizeInBytes();
        if (layer.image.sizeInBytes() > MaxPixels * 4 || decodedBytes > MaxDocumentPixels * 4)
            fail(QStringLiteral("레이어 버퍼의 바이트 한도를 초과합니다."));
        if (layer.name.size() > MaxNameUnits)
            fail(QStringLiteral("레이어 이름은 256자 이내여야 합니다."));
        for (qsizetype i = 0; i < layer.name.size(); ++i) {
            if (layer.name[i].isHighSurrogate()) {
                if (++i >= layer.name.size() || !layer.name[i].isLowSurrogate())
                    fail(QStringLiteral("레이어 이름의 유니코드가 올바르지 않습니다."));
            } else if (layer.name[i].isLowSurrogate()) {
                fail(QStringLiteral("레이어 이름의 유니코드가 올바르지 않습니다."));
            }
        }
    }
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
bool Document::commit(State candidate, const QString &label, CommitMode mode) {
    auto edit = prepare(std::move(candidate), label, mode);
    const bool modified = edit.changed();
    install(std::move(edit));
    return modified;
}
Document::PreparedEdit Document::prepare(State candidate, const QString &label, CommitMode mode) {
    validate(candidate);
    PreparedEdit edit;
    edit.owner = this;
    edit.baseId = currentId;
    edit.baseCursor = cursor;
    edit.baseActive = current.active;
    edit.candidate = std::move(candidate);
    const auto &candidateState = edit.candidate;
    auto &change = edit.change;
    change.label = label;
    change.beforeId = currentId;
    change.afterId = nextId;
    change.structural = mode == CommitMode::Structural || current.active != candidateState.active ||
                        current.size != candidateState.size ||
                        current.background != candidateState.background ||
                        current.layers.size() != candidateState.layers.size();
    if (!change.structural) {
        for (int i = 0; i < current.layers.size(); ++i)
            if (current.layers[i].name != candidateState.layers[i].name ||
                current.layers[i].visible != candidateState.layers[i].visible)
                change.structural = true;
    }
    if (change.structural) {
        change.before = current;
        change.after = candidateState;
        for (const auto &s : {current, candidateState})
            for (const auto &layer : s.layers)
                change.bytes += layer.image.sizeInBytes();
    } else {
        for (int i = 0; i < current.layers.size(); ++i) {
            const auto &before = current.layers[i].image;
            const auto &after = candidateState.layers[i].image;
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
            return edit;
    }
    // Reserve first: allocation failures must not truncate the redo branch.
    if (history.capacity() < cursor + 1)
        history.reserve(std::max(cursor + 1, std::max(size_t(8), history.capacity() * 2)));
    edit.modified = true;
    return edit;
}
void Document::install(PreparedEdit &&edit) {
    if (edit.owner != this || edit.baseId != currentId || edit.baseCursor != cursor ||
        edit.baseActive != current.active)
        fail(QStringLiteral("준비한 편집의 문서가 변경되었습니다. 작업을 다시 시도하세요."));
    edit.owner = nullptr;
    if (!edit.modified)
        return;
    // Everything that can allocate was prepared before file replacement or redo truncation.
    static_assert(std::is_nothrow_move_constructible_v<Change>);
    static_assert(std::is_nothrow_move_assignable_v<Change>);
    static_assert(std::is_nothrow_move_assignable_v<State>);
    for (size_t i = cursor; i < history.size(); ++i)
        retainedBytes -= history[i].bytes;
    history.erase(history.begin() + qptrdiff(cursor), history.end());
    retainedBytes += edit.change.bytes;
    history.push_back(std::move(edit.change));
    current = std::move(edit.candidate);
    currentId = nextId++;
    cursor = history.size();
    while ((retainedBytes > budget || history.size() > MaxHistoryChanges) && history.size() > 1) {
        retainedBytes -= history.front().bytes;
        history.erase(history.begin());
        --cursor;
    }
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
void Document::setHistoryBudget(qint64 bytes) {
    budget = std::max(qint64(0), bytes);
    while (retainedBytes > budget && history.size() > 1) {
        if (cursor > 0) {
            retainedBytes -= history.front().bytes;
            history.erase(history.begin());
            --cursor;
        } else {
            retainedBytes -= history.back().bytes;
            history.pop_back();
        }
    }
}
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
    if (size == state.size)
        return state;
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
    if (!QFileInfo(path).isFile() || !file.open(QIODevice::ReadOnly) || file.size() > MaxInputBytes)
        fail(QStringLiteral("읽을 수 없거나 너무 큰 이미지 파일입니다 (최대 %1 MiB).")
                 .arg(MaxInputBytes / 1024 / 1024));
    return readImageData(file);
}
State Document::readImageBytes(const QByteArray &bytes) {
    if (bytes.size() > MaxInputBytes)
        fail(QStringLiteral("이미지 입력 바이트 한도를 초과했습니다."));
    QBuffer file;
    file.setData(bytes);
    if (!file.open(QIODevice::ReadOnly))
        fail(file.errorString());
    return readImageData(file);
}
State Document::readImageData(QIODevice &file) {
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
    reader.setAllocationLimit(int(MaxPixels * 4 / 1024 / 1024));
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
    auto file = stageImage(state, path, format);
    if (!file->commit())
        fail(file->errorString());
}
std::unique_ptr<QSaveFile> Document::stageImage(const State &state, const QString &path,
                                                const QByteArray &format) {
    auto file = std::make_unique<QSaveFile>(path);
    file->setDirectWriteFallback(false);
    if (!file->open(QIODevice::WriteOnly))
        fail(file->errorString());
    writeImageData(state, *file, format);
    return file;
}
QByteArray Document::imageBytes(const State &state, const QByteArray &format) {
    QByteArray bytes;
    BoundedBuffer file(&bytes, MaxInputBytes);
    if (!file.open(QIODevice::WriteOnly))
        fail(file.errorString());
    writeImageData(state, file, format);
    return bytes;
}
void Document::writeImageData(const State &state, QIODevice &file, const QByteArray &format) {
    if (format != "png" && format != "jpg" && format != "jpeg" && format != "bmp")
        fail(QStringLiteral("PNG, JPEG, BMP 형식으로 저장하세요."));
    QImage image = flatten(state);
    if (format != "png") {
        QImage opaque = allocate(state.size, state.background);
        QPainter painter(&opaque);
        painter.drawImage(0, 0, image);
        painter.end();
        image = opaque.convertToFormat(QImage::Format_RGB32);
        if (image.isNull())
            throw std::bad_alloc();
    }
    QImageWriter writer(&file, format);
    writer.setQuality(95);
#ifdef Q_OS_WASM
    if (format == "png")
        writer.setCompression(0);
#endif
    if (!writer.write(image))
        fail(writer.errorString());
}
void Document::writeProject(const State &state, const QString &path) {
    auto file = stageProject(state, path);
    if (!file->commit())
        fail(file->errorString());
}
std::unique_ptr<QSaveFile> Document::stageProject(const State &state, const QString &path,
                                                  const std::function<bool()> &cancel) {
    validate(state);
    auto file = std::make_unique<QSaveFile>(path);
    file->setDirectWriteFallback(false);
    if (!file->open(QIODevice::WriteOnly))
        fail(file->errorString());
    writeProjectData(state, *file, cancel);
    return file;
}
QByteArray Document::projectBytes(const State &state, const std::function<bool()> &cancel) {
    QByteArray bytes;
    BoundedBuffer file(&bytes, MaxInputBytes);
    if (!file.open(QIODevice::WriteOnly))
        fail(file.errorString());
    writeProjectData(state, file, cancel);
    return bytes;
}
void Document::writeProjectData(const State &state, QIODevice &file, const std::function<bool()> &cancel) {
    validate(state);
    QDataStream stream(&file);
    stream.setByteOrder(QDataStream::LittleEndian);
    stream.writeRawData("RPAINT01", 8);
    stream << quint32(state.size.width()) << quint32(state.size.height()) << quint32(state.layers.size())
           << quint32(state.active) << quint32(state.background.rgba());
    for (const auto &layer : state.layers) {
        if (cancel && cancel())
            fail(QStringLiteral("저장을 취소했습니다."));
        const auto name = layer.name.toUtf8();
        QByteArray png;
        BoundedBuffer buffer(&png, MaxLayerEncodedBytes);
        buffer.open(QIODevice::WriteOnly);
        QImageWriter writer(&buffer, "png");
#ifdef Q_OS_WASM
        writer.setCompression(0);
#endif
        if (!writer.write(layer.image))
            fail(QStringLiteral("레이어 인코딩 실패"));
        if (png.isEmpty() || png.size() > MaxLayerEncodedBytes || name.size() > MaxNameBytes)
            fail(QStringLiteral("프로젝트 레코드가 너무 큽니다."));
        stream << quint32(name.size());
        stream.writeRawData(name.constData(), name.size());
        stream << quint8(layer.visible) << quint32(png.size());
        stream.writeRawData(png.constData(), png.size());
        if (file.pos() > MaxInputBytes)
            fail(QStringLiteral("프로젝트 파일이 너무 큽니다."));
    }
    if (stream.status() != QDataStream::Ok)
        fail(QStringLiteral("프로젝트 저장 실패"));
}
State Document::readProject(const QString &path) {
    QFile file(path);
    if (!QFileInfo(path).isFile() || !file.open(QIODevice::ReadOnly))
        fail(file.errorString());
    if (file.size() > MaxInputBytes)
        fail(QStringLiteral("프로젝트 파일이 너무 큽니다."));
    return readProjectData(file);
}
State Document::readProjectBytes(const QByteArray &bytes) {
    if (bytes.size() > MaxInputBytes)
        fail(QStringLiteral("프로젝트 입력 바이트 한도를 초과했습니다."));
    QBuffer file;
    file.setData(bytes);
    if (!file.open(QIODevice::ReadOnly))
        fail(file.errorString());
    return readProjectData(file);
}
State Document::readProjectData(QIODevice &file) {
    QDataStream stream(&file);
    stream.setByteOrder(QDataStream::LittleEndian);
    char magic[8];
    if (stream.readRawData(magic, 8) != 8 || std::memcmp(magic, "RPAINT01", 8))
        fail(QStringLiteral("올바른 RetroPaint 프로젝트가 아닙니다."));
    quint32 w = 0, h = 0, count = 0, active = 0, background = 0;
    stream >> w >> h >> count >> active >> background;
    if (stream.status() != QDataStream::Ok || w < 1 || h < 1 || w > MaxDimension || h > MaxDimension ||
        quint64(w) * h > MaxPixels || count < 1 || count > MaxLayers || active >= count ||
        quint64(w) * h * count > MaxDocumentPixels)
        fail(QStringLiteral("프로젝트 크기 또는 레이어 정보가 잘못되었습니다."));
    State state{QSize(int(w), int(h)), QColor::fromRgba(background), {}, int(active)};
    for (quint32 i = 0; i < count; ++i) {
        quint32 length = 0;
        stream >> length;
        if (length > MaxNameBytes || length > file.bytesAvailable())
            fail(QStringLiteral("레이어 이름이 잘못되었습니다."));
        QByteArray name(length, Qt::Uninitialized);
        if (stream.readRawData(name.data(), int(length)) != int(length))
            fail(QStringLiteral("잘린 프로젝트"));
        QStringDecoder decoder(QStringDecoder::Utf8, QStringDecoder::Flag::Stateless);
        const QString layerName = decoder(name);
        if (decoder.hasError() || layerName.size() > MaxNameUnits)
            fail(QStringLiteral("레이어 이름의 UTF-8 또는 길이가 올바르지 않습니다."));
        quint8 visible = 0;
        stream >> visible >> length;
        if (visible > 1 || length == 0 || length > MaxLayerEncodedBytes || length > file.bytesAvailable())
            fail(QStringLiteral("레이어 데이터가 잘못되었습니다."));
        QByteArray bytes(length, Qt::Uninitialized);
        if (stream.readRawData(bytes.data(), int(length)) != int(length))
            fail(QStringLiteral("잘린 프로젝트"));
        QBuffer buffer(&bytes);
        buffer.open(QIODevice::ReadOnly);
        QImageReader reader(&buffer, "PNG");
        reader.setAutoDetectImageFormat(false);
        reader.setDecideFormatFromContent(false);
        reader.setAllocationLimit(int(MaxPixels * 4 / 1024 / 1024));
        if (reader.size() != state.size)
            fail(QStringLiteral("레이어 크기 불일치"));
        QImage image = reader.read().convertToFormat(QImage::Format_ARGB32_Premultiplied);
        if (image.isNull())
            fail(QStringLiteral("레이어 디코딩 실패"));
        state.layers.push_back({layerName, image, bool(visible)});
    }
    if (stream.status() != QDataStream::Ok || !file.atEnd())
        fail(QStringLiteral("잘리거나 추가 데이터가 있는 프로젝트"));
    validate(state);
    return state;
}
bool Document::flood(QImage &image, QPoint start, QColor color, const std::function<bool()> &cancel) {
    validateSize(image.size());
    if (image.sizeInBytes() > MaxPixels * 4)
        fail(QStringLiteral("채우기 이미지 버퍼가 너무 큽니다."));
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
