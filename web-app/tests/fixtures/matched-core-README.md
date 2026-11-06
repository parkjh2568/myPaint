# Matched core workloads

These are development-only native Qt / Node API fixtures, not shipped UI assets or physical-device performance acceptance. The canonical specification is `matched-core.json`. Generated RPAINT01 files stay under ignored build output; do not add them to a website payload.

The seven opaque RGBA planes and three red fill output hashes were derived with independent Python integer arithmetic before the Node wire producer. The producer uses Node zlib/CRC and explicit RPAINT01 fields, without importing the product encoder. Both consumers pin the canonical spec SHA and exact case list, then check all metadata and canonical RGBA bytes, including hidden layers. This is an opaque subset; existing low-alpha/raw-PNG contracts remain separate.

The three dimensions are800×600×1,2048²×1,1536×2048×2. Each RGB project has decode, encode and forced deep-copy operations. Each corresponding uniform white fill project has one layer and a full opaque-red output. Twelve operations per backend are expected; row counts cannot hide a missing operation or duplicate case.

- Decode uses exactly the same input wire SHA. Encode uses the same decoded metadata and planes, and checks decoded output rather than compressed-byte identity.
- Qt fill creates a shallow handle outside the timer and confirms shared `constBits`. Production flood detachment/allocation is inside the timer. The original is preserved and output pointers/whole plane are checked afterward. Studio flood returns an independent full ROI with allocation included.
- Deep-copy explicitly times Qt `QImage.copy()` for every layer and Studio `cloneState`. This is forced mutable-pixel copying, not Qt's normal shallow COW snapshot cost.
- Validation/hash/setup/file writes/caller-owned output release are outside per-operation timing. Callee-internal RAII and natural GC can still be inside. Interleaved validation may affect subsequent cache/GC conditions.
- Warmup and measured attempts are retained separately. A failed validation is not a valid latency sample. Soft checkpoints cannot interrupt a running synchronous call. External process timeouts are separate.
- Cross-decode reads the final representative encoded file for each of the three RGB projects. Each local encode iteration is separately verified against independent expected metadata/plane hashes.

The following commands were exercised on macOS from the repository root with an existing Release Qt build. Configure that build and its normal Qt dependencies first. Each output directory must be new; wait for fixture generation to exit successfully before reading its manifest. Incomplete owned output is retained on failure.

```sh
cmake --build build-native-relocated --target matched_core_probe --parallel 2
MATCHED_RUN_DIR="$(mktemp -d)"
PAINT_CORE_FIXTURES_DIR="$MATCHED_RUN_DIR/fixtures" npm --prefix web-app run test:core-fixtures
build-native-relocated/matched_core_probe --fixtures "$MATCHED_RUN_DIR/fixtures" --spec web-app/tests/fixtures/matched-core.json --output "$MATCHED_RUN_DIR/qt" --samples 3 --warmups 1
PAINT_CORE_FIXTURES_DIR="$MATCHED_RUN_DIR/fixtures" PAINT_MATCHED_CORE_OUTPUT="$MATCHED_RUN_DIR/studio" npm --prefix web-app run test:matched-core
build-native-relocated/matched_core_probe --fixtures "$MATCHED_RUN_DIR/fixtures" --spec web-app/tests/fixtures/matched-core.json --output "$MATCHED_RUN_DIR/qt-cross" --verify "$MATCHED_RUN_DIR/studio"
PAINT_CORE_FIXTURES_DIR="$MATCHED_RUN_DIR/fixtures" PAINT_MATCHED_CORE_OUTPUT="$MATCHED_RUN_DIR/studio-cross" PAINT_MATCHED_VERIFY_DIR="$MATCHED_RUN_DIR/qt" npm --prefix web-app run test:matched-core
```

Node options are `PAINT_MATCHED_SAMPLES`(default3), `PAINT_MATCHED_WARMUPS`(default1), `PAINT_MATCHED_BUDGET_MS`(default90000), with corresponding Qt flags. Nearest-rank p95/p99 at n3 are the maximum, not stable tails. Native Qt and Node have different runtimes, compression policies, scratch allocation and cleanup; total process elapsed starts at different setup boundaries. Do not compute application speedup from these method-validation runs.

Atomic Qt file replacement is confined to an exclusively created run directory; this is not a general no-overwrite or hostile-filesystem API. Inputs use capped descriptor reads. The documented workflow uses trusted local fixtures and no uploads, GUI, network or mobile package generation.
