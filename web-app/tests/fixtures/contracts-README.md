# Legacy contract references

`legacy-contracts.json` fixes the QF-02 reference boundary: F01–F10, all17 tool IDs, layers/history/pending/file/clipboard/recovery inputs, observed expected state and explicitly allowed raster differences. Each row points to the owning executable test or independent oracle. It is an inventory, not a claim that every Studio option or platform has passed.

`npm run test:fixture-inventory` checks IDs, policy ownership, resolvable case anchors and frozen reference SHA. It checks the index, not the behavior assertions. `npm test` executes the standalone engine/wire consumers. The root Qt CTest suite executes the original reference inputs independently of the Studio UI. Public browser/IPC consumers require a local production-assets server and retain their own scope and error models.

- Stored straight RGBA is exact, including hidden RGB at alpha0. Selection masks and outside-source bytes are exact.
- Qt pixelColor observations may require alpha-exact/premultiplied-channel equivalence. This never relaxes raw PNG preservation.
- New Canvas2D versus QPainter boundary antialiasing and installed-font glyph rasterization follow the named local policy. Existing text pixels remain stored pixels. Exact row-span or geometry fixtures are not relaxed.
- Rejected/cancelled operations preserve the state fields actually observed by that test. Public dirty/saved status is not a private revision-ID observation. F10 ownership/cancellation is separate from latency/RSS acceptance.

`spray-literal.json` supplies16 fixed random values, a35ms virtual tick and five literal pixel coordinates. `npm run test:spray-contract` verifies the public tool without deriving expected raster data from Studio. Virtual time is not a physical timing benchmark.

## Optional Qt project recapture

`qt-project.json` is the existing Qt6.12.0 RPAINT01+RGBA observation. `qt-project-oracle.cpp` preserves its original producer using only paintcore/QtCore/Gui; Node tests do not require Qt. On the recorded macOS Qt environment, from the repository root:

```sh
cmake -S . -B build-reference -DCMAKE_BUILD_TYPE=Release
cmake --build build-reference --target paintcore --parallel 2
c++ -std=c++20 -Isrc web-app/tests/fixtures/qt-project-oracle.cpp build-reference/libpaintcore.a $(pkg-config --cflags --libs Qt6Core Qt6Gui) -o /tmp/mypaint-qt-project-oracle
/tmp/mypaint-qt-project-oracle > /tmp/mypaint-qt-project-recaptured.json
```

Write recaptures separately. Compare parsed JSON, entire decoded project bytes and both RGBA planes before reviewing any expected-data change. Text formatting/newlines are not wire differences. Never regenerate expected pixels with the Studio encoder/rasterizer. Other recorded/derived Qt datasets retain their own source/version scope and the square-oracle instructions in `square-README.md`.

Actual OS clipboard/IME, Windows and mobile/pen behavior, every tool option, performance budgets and release acceptance remain separate tasks. Missing later acceptance does not reopen already-fixed F01–F10 contracts.
