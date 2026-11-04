#pragma once
#include <QByteArray>
#include <QJsonObject>
#include <QObject>

namespace paint {
class BrowserBridge final : public QObject {
    Q_OBJECT
  public:
    explicit BrowserBridge(QObject *parent);
    void request(quint32 id, const QString &operation, QJsonObject options = {},
                 const QByteArray &bytes = {});
    void setDirty(bool dirty);
  signals:
    void completed(quint32 id, QJsonObject result, QByteArray bytes);
    void fileDropped();
};
} // namespace paint
