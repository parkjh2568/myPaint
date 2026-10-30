#pragma once
#include <QColor>
#include <QImage>
#include <QString>
#include <QVector>
#include <functional>
#include <vector>

namespace paint {
constexpr qint64 MaxPixels = 32LL * 1024 * 1024;
constexpr qint64 MaxDocumentPixels = 64LL * 1024 * 1024;
constexpr int MaxLayers = 16;
struct Layer {
    QString name;
    QImage image;
    bool visible = true;
};
struct State {
    QSize size;
    QColor background = Qt::white;
    QVector<Layer> layers;
    int active = 0;
};
struct Patch {
    int layer;
    QRect rect;
    QImage before;
    QImage after;
};
struct Change {
    QString label;
    quint64 beforeId = 0, afterId = 0;
    State before, after;
    QVector<Patch> patches;
    bool structural = false;
    qint64 bytes = 0;
};
class Document {
  public:
    explicit Document(QSize size = QSize(800, 600));
    const State &state() const { return current; }
    quint64 revision() const { return currentId; }
    bool dirty() const { return currentId != savedId; }
    bool canUndo() const { return cursor > 0; }
    bool canRedo() const { return cursor < history.size(); }
    QString undoLabel() const { return canUndo() ? history[cursor - 1].label : QString(); }
    QString redoLabel() const { return canRedo() ? history[cursor].label : QString(); }
    qint64 historyBytes() const { return retainedBytes; }
    QString path;
    void markSaved() { savedId = currentId; }
    void markUnsaved() { savedId = 0; }
    void setActive(int index);
    void reset(State state, QString filePath = {});
    bool commit(State candidate, const QString &label);
    void undo();
    void redo();
    QImage composite() const;
    void setHistoryBudget(qint64 bytes);
    static void validate(const State &state);
    static void validateSize(QSize size, qsizetype layerCount = 1);
    static State blank(QSize size, QColor background = Qt::white);
    static QImage allocate(QSize size, QColor fill = Qt::transparent);
    static QImage flatten(const State &state);
    static State resized(const State &state, QSize size, bool scale, bool smooth = false);
    static State readImage(const QString &path);
    static State readProject(const QString &path);
    static void writeProject(const State &state, const QString &path);
    static void writeImage(const State &state, const QString &path, const QByteArray &format);
    static bool flood(QImage &image, QPoint start, QColor color, const std::function<bool()> &cancel = {});

  private:
    State current;
    quint64 currentId = 1, savedId = 1, nextId = 2;
    std::vector<Change> history;
    size_t cursor = 0;
    qint64 retainedBytes = 0, budget = 256LL * 1024 * 1024;
    void apply(const Change &change, bool forward);
};
} // namespace paint
