#include "browserbridge.h"
#include "document.h"
#include <QJsonDocument>
#include <QPointer>
#include <cstdio>
#include <emscripten.h>
#include <stdexcept>

namespace paint {
static QPointer<BrowserBridge> bridge;
extern "C" EMSCRIPTEN_KEEPALIVE void retropaint_browser_result(unsigned id, const char *metadata,
                                                               int metadataSize, const char *data, int size) {
    if (!bridge)
        return;
    try {
        if (metadataSize < 0 || metadataSize > 65536 || size < 0 || size > MaxInputBytes)
            throw std::runtime_error("브라우저 응답 한도를 초과했습니다.");
        const auto parsed = QJsonDocument::fromJson(QByteArray(metadata, metadataSize));
        if (!parsed.isObject())
            throw std::runtime_error("브라우저 응답이 올바르지 않습니다.");
        emit bridge->completed(id, parsed.object(), QByteArray(data, size));
    } catch (const std::exception &error) {
        try {
            emit bridge->completed(id, {{"ok", false}, {"error", QString::fromUtf8(error.what())}}, {});
        } catch (...) {
            std::fprintf(stderr, "RetroPaint: browser callback failed\n");
        }
    }
}
extern "C" EMSCRIPTEN_KEEPALIVE void retropaint_browser_drop() {
    if (bridge)
        emit bridge->fileDropped();
}
EM_JS(void, initializeBrowserJs, (), { Module.paintBrowser.initialize(); });
EM_JS(void, requestBrowserJs,
      (unsigned id, const char *metadata, int metadataSize, const char *data, int size), {
          const options = JSON.parse(UTF8ToString(metadata, metadataSize));
          const bytes = size ? HEAPU8.slice(data, data + size) : new Uint8Array();
          Module.paintBrowser.request(id, options, bytes);
      });
EM_JS(void, dirtyBrowserJs, (int dirty), { Module.paintBrowser.dirty = !!dirty; });
BrowserBridge::BrowserBridge(QObject *parent) : QObject(parent) {
    if (bridge)
        throw std::runtime_error("브라우저 연결이 이미 존재합니다.");
    bridge = this;
    initializeBrowserJs();
}
void BrowserBridge::request(quint32 id, const QString &operation, QJsonObject options,
                            const QByteArray &bytes) {
    if (bytes.size() > MaxInputBytes)
        throw std::runtime_error("브라우저 출력 한도를 초과했습니다.");
    options.insert("operation", operation);
    options.insert("limit", double(MaxInputBytes));
    const auto metadata = QJsonDocument(options).toJson(QJsonDocument::Compact);
    requestBrowserJs(id, metadata.constData(), int(metadata.size()), bytes.constData(), int(bytes.size()));
}
void BrowserBridge::setDirty(bool dirty) { dirtyBrowserJs(dirty); }
} // namespace paint
