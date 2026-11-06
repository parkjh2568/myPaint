import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { cloneState, validate } from '../src/engine/document.ts';
import { decodeProject, encodeProject } from '../src/engine/format.ts';
import { flood } from '../src/engine/operations.ts';
const directory = path.resolve(
    process.env.PAINT_CORE_FIXTURES_DIR ||
        '../build-web-work/task-planning/current-tests/matched-core/fixtures',
);
const output = path.resolve(
    process.env.PAINT_MATCHED_CORE_OUTPUT ||
        '../build-web-work/task-planning/current-tests/matched-core/studio',
);
const verifyDirectory =
    process.env.PAINT_MATCHED_VERIFY_DIR && path.resolve(process.env.PAINT_MATCHED_VERIFY_DIR);
const samples = Number(process.env.PAINT_MATCHED_SAMPLES ?? 3),
    warmups = Number(process.env.PAINT_MATCHED_WARMUPS ?? 1),
    budgetMs = Number(process.env.PAINT_MATCHED_BUDGET_MS ?? 90000);
assert(Number.isInteger(samples) && samples >= 3 && samples <= 30);
assert(Number.isInteger(warmups) && warmups >= 0 && warmups <= 10);
assert(Number.isInteger(budgetMs) && budgetMs >= 1000 && budgetMs <= 120000);
// Captured descriptors and capped buffers bound reads; source changes are rejected.
async function readBounded(file, limit) {
    const handle = await fs.open(file, 'r');
    try {
        const stat = await handle.stat();
        assert(stat.isFile() && stat.size > 0 && stat.size <= limit);
        const bytes = Buffer.alloc(stat.size + 1);
        let count = 0;
        while (count < bytes.length) {
            const read = await handle.read(bytes, count, bytes.length - count, null);
            if (!read.bytesRead) break;
            count += read.bytesRead;
        }
        assert.equal(count, stat.size);
        assert.equal((await handle.stat()).size, stat.size);
        return Uint8Array.from(bytes.subarray(0, count));
    } finally {
        await handle.close();
    }
}
const manifestBytes = await readBounded(path.join(directory, 'manifest.json'), 1048576),
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)),
    specBytes = await readBounded(new URL('./fixtures/matched-core.json', import.meta.url), 1048576),
    spec = JSON.parse(new TextDecoder().decode(specBytes));
assert.equal(manifest.specSha256, createHash('sha256').update(specBytes).digest('hex'));
assert.equal(spec.fixtures.length, 6);
for (let i = 0; i < manifest.fixtures.length; i++) {
    const actual = { ...manifest.fixtures[i] };
    delete actual.wireBytes;
    delete actual.wireSha256;
    actual.layers = actual.layers.map((layer) => {
        const value = { ...layer };
        delete value.pngBytes;
        return value;
    });
    assert.deepEqual(actual, spec.fixtures[i], 'Exact canonical fixture/case set must be retained');
    assert.equal(new Set(actual.operations).size, actual.operations.length);
}
assert.equal(manifest.schema, 1);
assert.equal(manifest.fixtures.length, 6);
await fs.mkdir(output, { recursive: false });
const result = {
    schema: 1,
    backend: 'studio-node',
    ok: false,
    scope: 'Native-host core API method validation; no UI, physical input, Wasm, filesystem latency, stable-tail or overall-app speedup claim.',
    mode: verifyDirectory ? 'cross-decode-only' : 'benchmark',
    samples,
    warmups,
    budgetMs,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    environment: {
        platform: process.platform,
        release: os.release(),
        arch: process.arch,
        node: process.version,
        cpu: os.cpus()[0]?.model,
        loadAtStart: os.loadavg(),
    },
    sources: {},
    compression: 'Production fflate zlib level1; compressed bytes are not equal-output contract',
    timing: 'Wall time; Validation/hash/setup/output file writes and caller-owned output release are outside timing. Callee-internal RAII or natural GC may occur inside a call. Configured warmups/samples are recorded; small samples are descriptive only.',
    rows: [],
    crossDecoded: [],
};
for (const file of [
    'src/engine/document.ts',
    'src/engine/format.ts',
    'src/engine/operations.ts',
    'tests/matched-core.mjs',
])
    result.sources[file] = createHash('sha256')
        .update(await fs.readFile(new URL('../' + file, import.meta.url)))
        .digest('hex');
// Shared semantic verifier is used for source, decoded/encoded/copied outputs, and cross-engine reads.
function verifyState(state, fixture) {
    validate(state);
    assert.deepEqual(
        [state.width, state.height, state.active, state.background],
        [fixture.width, fixture.height, fixture.active, fixture.background],
    );
    assert.equal(state.layers.length, fixture.layers.length);
    return state.layers.map((layer, i) => {
        const expected = fixture.layers[i];
        assert.equal(layer.name, expected.name);
        assert.equal(layer.visible, expected.visible);
        const hash = createHash('sha256').update(layer.pixels).digest('hex');
        assert.equal(hash, expected.sha256);
        return hash;
    });
}
const started = performance.now();
let activeAttempt, activeAt;
try {
    const seen = new Set();
    for (const fixture of manifest.fixtures) {
        assert(/^[a-z0-9-]+$/.test(fixture.id) && !seen.has(fixture.id));
        seen.add(fixture.id);
        if (verifyDirectory && !fixture.operations.includes('project-encode')) continue;
        const file = path.join(verifyDirectory || directory, fixture.id + '.rpaint'),
            wire = await readBounded(file, 40 * 1048576),
            wireSha256 = createHash('sha256').update(wire).digest('hex');
        if (!verifyDirectory) {
            assert.equal(wire.length, fixture.wireBytes);
            assert.equal(wireSha256, fixture.wireSha256);
        }
        const state = decodeProject(wire),
            sourcePlanes = verifyState(state, fixture);
        if (verifyDirectory) {
            result.crossDecoded.push({
                id: fixture.id,
                wireBytes: wire.length,
                wireSha256,
                planeSha256: sourcePlanes,
            });
            continue;
        }
        for (const operation of fixture.operations) {
            assert(['project-decode', 'project-encode', 'flood', 'deep-copy'].includes(operation));
            const durations = [],
                attempts = [],
                row = { id: fixture.id, operation, attempts, durationsMs: durations };
            result.rows.push(row);
            let outputBytes = 0,
                encoded;
            for (let repetition = -warmups; repetition < samples; repetition++) {
                assert(performance.now() - started < budgetMs, 'Soft operation budget exhausted');
                const attempt = {
                    phase: repetition < 0 ? 'warmup' : 'measured',
                    index: repetition < 0 ? repetition + warmups : repetition,
                    status: 'started',
                };
                attempts.push(attempt);
                activeAttempt = attempt;
                const start = performance.now();
                activeAt = start;
                const value =
                    operation === 'project-decode'
                        ? decodeProject(wire)
                        : operation === 'project-encode'
                          ? encodeProject(state)
                          : operation === 'deep-copy'
                            ? cloneState(state)
                            : flood(
                                  state.layers[0].pixels,
                                  state.width,
                                  state.height,
                                  fixture.fill.x,
                                  fixture.fill.y,
                                  fixture.fill.color,
                              );
                const elapsed = performance.now() - start;
                attempt.elapsedMs = elapsed;
                attempt.status = 'validating';
                if (operation === 'project-encode') {
                    encoded = value;
                    verifyState(decodeProject(value), fixture);
                    outputBytes = value.length;
                } else if (operation === 'flood') {
                    assert.equal(state.layers.length, 1);
                    assert(value);
                    assert.deepEqual(
                        [value.left, value.top, value.width, value.height],
                        [0, 0, fixture.width, fixture.height],
                    );
                    assert.notEqual(value.pixels.buffer, state.layers[0].pixels.buffer);
                    assert.equal(
                        createHash('sha256').update(value.pixels).digest('hex'),
                        fixture.fill.sha256,
                    );
                    outputBytes = value.pixels.byteLength;
                } else {
                    verifyState(value, fixture);
                    outputBytes = value.layers.reduce((n, layer) => n + layer.pixels.byteLength, 0);
                    if (operation === 'deep-copy')
                        for (let i = 0; i < value.layers.length; i++) {
                            assert.notEqual(value.layers[i].pixels.buffer, state.layers[i].pixels.buffer);
                            assert.notEqual(value.layers[i], state.layers[i]);
                        }
                }
                verifyState(state, fixture);
                assert.equal(createHash('sha256').update(wire).digest('hex'), wireSha256);
                attempt.status = 'validated';
                activeAttempt = undefined;
                if (repetition >= 0) durations.push(elapsed);
            }
            const sorted = durations.slice().sort((a, b) => a - b);
            Object.assign(row, {
                id: fixture.id,
                operation,
                sourceWireSha256: wireSha256,
                sourcePlaneSha256: sourcePlanes,
                operandKind:
                    operation === 'project-decode'
                        ? 'same encoded input bytes'
                        : operation === 'flood'
                          ? 'immutable opaque-white RGBA plane'
                          : 'decoded immutable State',
                operandBytes:
                    operation === 'project-decode'
                        ? wire.length
                        : fixture.width * fixture.height * 4 * fixture.layers.length,
                logicalPixelBytes: fixture.width * fixture.height * 4 * fixture.layers.length,
                outputBytes,
                dimensions: [fixture.width, fixture.height],
                layers: fixture.layers.length,
                durationsMs: durations,
                p50: sorted[Math.ceil(samples * 0.5) - 1],
                p95: sorted[Math.ceil(samples * 0.95) - 1],
                p99: sorted[Math.ceil(samples * 0.99) - 1],
                inputPreserved: true,
                outputVerified: true,
                independentMutableOutput: operation === 'flood' || operation === 'deep-copy',
                boundary:
                    operation === 'flood'
                        ? 'Immutable white plane -> independent full opaque-red ROI, result allocation included'
                        : operation === 'deep-copy'
                          ? 'Forced mutable pixel deep copy, not normal Qt COW snapshot cost'
                          : 'In-memory production codec, no filesystem I/O',
            });
            if (encoded)
                await fs.writeFile(path.join(output, fixture.id + '.rpaint'), encoded, { flag: 'wx' });
        }
    }
    assert.equal(verifyDirectory ? result.crossDecoded.length : result.rows.length, verifyDirectory ? 3 : 12);
    result.ok = true;
} catch (error) {
    if (activeAttempt) {
        activeAttempt.status = 'failed';
        activeAttempt.elapsedScope =
            activeAttempt.elapsedMs === undefined
                ? 'throwing-call observation'
                : 'completed call before validation failure';
        activeAttempt.elapsedMs ??= performance.now() - activeAt;
    }
    result.error = String(error.stack || error);
    process.exitCode = 1;
}
result.elapsedMs = performance.now() - started;
result.environment.loadAtEnd = os.loadavg();
result.nodeMemoryEndpoint = process.memoryUsage();
await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(
    JSON.stringify({
        output,
        ok: result.ok,
        rows: result.rows.length,
        crossDecoded: result.crossDecoded.length,
        elapsedMs: result.elapsedMs,
        error: result.error,
    }),
);
