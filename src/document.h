#pragma once
#include <QColor>
#include <QImage>
#include <QSaveFile>
#include <QString>
#include <QVector>
#include <cstddef>
#include <functional>
#include <memory>
#include <utility>
#include <vector>

namespace paint {
#ifdef Q_OS_WASM
constexpr qint64 MaxPixels = 4LL * 1024 * 1024;
constexpr qint64 MaxDocumentPixels = 6LL * 1024 * 1024;
constexpr int MaxDimension = 4096;
constexpr qint64 MaxInputBytes = 40LL * 1024 * 1024;
constexpr qint64 MaxLayerEncodedBytes = 20LL * 1024 * 1024;
#else
constexpr qint64 MaxPixels = 32LL * 1024 * 1024;
constexpr qint64 MaxDocumentPixels = 64LL * 1024 * 1024;
constexpr int MaxDimension = 32768;
constexpr qint64 MaxInputBytes = 300LL * 1024 * 1024;
constexpr qint64 MaxLayerEncodedBytes = 140LL * 1024 * 1024;
#endif
constexpr int MaxLayers = 16;
constexpr int MaxNameUnits = 256;
constexpr int MaxNameBytes = 1024;
constexpr size_t MaxHistoryChanges = 4096;
enum class CommitMode { Automatic, Structural };
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
    class PreparedEdit {
      public:
        PreparedEdit(PreparedEdit &&other) noexcept
            : owner(std::exchange(other.owner, nullptr)), candidate(std::move(other.candidate)),
              change(std::move(other.change)), baseId(other.baseId), baseCursor(other.baseCursor),
              baseActive(other.baseActive), modified(other.modified) {}
        PreparedEdit(const PreparedEdit &) = delete;
        const State &state() const { return candidate; }
        bool changed() const { return modified; }

      private:
        friend class Document;
        PreparedEdit() = default;
        Document *owner = nullptr;
        State candidate;
        Change change;
        quint64 baseId = 0;
        size_t baseCursor = 0;
        int baseActive = 0;
        bool modified = false;
    };
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
    bool commit(State candidate, const QString &label, CommitMode mode = CommitMode::Automatic);
    PreparedEdit prepare(State candidate, const QString &label, CommitMode mode = CommitMode::Automatic);
    // Install immediately after synchronous I/O; processing events invalidates this guarantee.
    void install(PreparedEdit &&edit);
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
    static State readImageBytes(const QByteArray &bytes);
    static State readProjectBytes(const QByteArray &bytes);
    static QByteArray imageBytes(const State &state, const QByteArray &format);
    static QByteArray projectBytes(const State &state, const std::function<bool()> &cancel = {});
    static State readImage(const QString &path);
    static State readProject(const QString &path);
    static void writeProject(const State &state, const QString &path);
    static void writeImage(const State &state, const QString &path, const QByteArray &format);
    static std::unique_ptr<QSaveFile> stageProject(const State &state, const QString &path,
                                                   const std::function<bool()> &cancel = {});
    static std::unique_ptr<QSaveFile> stageImage(const State &state, const QString &path,
                                                 const QByteArray &format);
    static bool flood(QImage &image, QPoint start, QColor color, const std::function<bool()> &cancel = {});

  private:
    State current;
    quint64 currentId = 1, savedId = 1, nextId = 2;
    std::vector<Change> history;
    size_t cursor = 0;
    qint64 retainedBytes = 0, budget = 256LL * 1024 * 1024;
    void apply(const Change &change, bool forward);
    static State readImageData(QIODevice &file);
    static State readProjectData(QIODevice &file);
    static void writeImageData(const State &state, QIODevice &file, const QByteArray &format);
    static void writeProjectData(const State &state, QIODevice &file, const std::function<bool()> &cancel);
};
} // namespace paint
