# Legacy contract references

`legacy-contracts.json` fixes the QF-02 reference boundary: F01–F10, all17 tool IDs, layers/history/pending/file/clipboard/recovery inputs, observed expected state and explicitly allowed raster differences. Each row points to the owning executable test or independent oracle. It is an inventory, not a claim that every Studio option or platform has passed.

`npm run test:fixture-inventory` checks IDs, policy ownership, resolvable case anchors and frozen reference SHA. It checks the index, not the behavior assertions. `npm test` executes the standalone engine/wire consumers. The old reference executable is no longer part of this repository build. Public browser/IPC consumers require a local production-assets server and retain their own scope and error models.

- Stored straight RGBA is exact, including hidden RGB at alpha0. Selection masks and outside-source bytes are exact.
- Qt pixelColor observations may require alpha-exact/premultiplied-channel equivalence. This never relaxes raw PNG preservation.
- New Canvas2D versus QPainter boundary antialiasing and installed-font glyph rasterization follow the named local policy. Existing text pixels remain stored pixels. Exact row-span or geometry fixtures are not relaxed.
- Rejected/cancelled operations preserve the state fields actually observed by that test. Public dirty/saved status is not a private revision-ID observation. F10 ownership/cancellation is separate from latency/RSS acceptance.

`spray-literal.json` supplies16 fixed random values, a35ms virtual tick and five literal pixel coordinates. `npm run test:spray-contract` verifies the public tool without deriving expected raster data from Studio. Virtual time is not a physical timing benchmark.

## Frozen reference provenance

The original generator sources are preserved in Git commit `c10a29a397aa77bb946c84406fd661db747164c0`, not in the active build. Fixed JSON pixels and wire bytes remain unchanged. `historicalReferences` records removed source anchors; active `references` identify executable Studio consumers. Never regenerate expected pixels with the Studio encoder/rasterizer.

Actual OS clipboard/IME, Windows and mobile/pen behavior, every tool option, performance budgets and release acceptance remain separate tasks. Missing later acceptance does not reopen already-fixed F01–F10 contracts.
