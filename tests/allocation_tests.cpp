// Isolate global allocation fault injection from QtTest and the UI event loop.
#include "document.h"
#include <QFile>
#include <QTemporaryDir>
#include <cstdlib>
#include <new>

static bool rejectAllocation = false;
static std::size_t rejectedBytes = 0;
void *operator new(std::size_t bytes) {
    if (rejectAllocation && (!rejectedBytes || bytes == rejectedBytes))
        throw std::bad_alloc();
    if (void *memory = std::malloc(bytes ? bytes : 1))
        return memory;
    throw std::bad_alloc();
}
void operator delete(void *memory) noexcept { std::free(memory); }
void operator delete(void *memory, std::size_t) noexcept { std::free(memory); }
void *operator new[](std::size_t bytes) { return ::operator new(bytes); }
void operator delete[](void *memory) noexcept { ::operator delete(memory); }
void operator delete[](void *memory, std::size_t) noexcept { ::operator delete(memory); }

int main() {
    paint::Document document(QSize(2, 2));
    auto state = document.state();
    state.layers[0].image.setPixelColor(0, 0, Qt::red);
    const auto revision = document.revision();
    QTemporaryDir directory;
    if (!directory.isValid())
        return 5;
    const auto path = directory.filePath("original.rpaint");
    QFile original(path);
    if (!original.open(QIODevice::WriteOnly) || original.write("original") != 8)
        return 6;
    original.close();
    auto staged = paint::Document::stageProject(state, path);
    bool rejected = false;
    // Target the history vector without throwing through Qt's noexcept allocation paths.
    rejectedBytes = 8 * sizeof(paint::Change);
    rejectAllocation = true;
    try {
        auto edit = document.prepare(state, QStringLiteral("pixel"));
    } catch (const std::bad_alloc &) {
        rejected = true;
    }
    rejectAllocation = false;
    if (!rejected || document.revision() != revision || document.dirty() || document.canUndo())
        return 1;
    staged.reset();
    if (!original.open(QIODevice::ReadOnly) || original.readAll() != QByteArray("original"))
        return 7;
    original.close();
    auto edit = document.prepare(state, QStringLiteral("pixel"));
    staged = paint::Document::stageProject(edit.state(), path);
    if (!staged->commit())
        return 8;
    rejectedBytes = 0;
    rejectAllocation = true;
    try {
        document.install(std::move(edit));
    } catch (...) {
        rejectAllocation = false;
        return 2;
    }
    rejectAllocation = false;
    if (!document.dirty() || document.state().layers[0].image.pixelColor(0, 0) != QColor(Qt::red))
        return 3;
    document.undo();
    if (document.dirty() || document.state().layers[0].image.pixelColor(0, 0) != QColor(Qt::white))
        return 4;
    return 0;
}
