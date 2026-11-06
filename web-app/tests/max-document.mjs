import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PaintDocument, createState, desktopLimits } from '../src/engine/document.ts';
import { cropState, resizeState } from '../src/engine/operations.ts';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(
    process.env.PAINT_MAX_DOCUMENT_OUTPUT ||
        path.join(webRoot, '../build-web-work/task-planning/max-document/current-core.json'),
);
const measuring = process.argv.includes('--measure-max-document');
if (!measuring) {
    const started = Date.now();
    try {
        const execution = await promisify(execFile)(
            process.execPath,
            [...process.execArgv, fileURLToPath(import.meta.url), '--measure-max-document'],
            {
                cwd: process.cwd(),
                timeout: 90000,
                killSignal: 'SIGKILL',
                maxBuffer: 1024 * 1024,
                encoding: 'utf8',
                shell: false,
            },
        );
        process.stdout.write(execution.stdout);
        process.stderr.write(execution.stderr);
    } catch (error) {
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(
            output,
            JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                elapsedMs: Date.now() - started,
                watchdogMs: 90000,
                signal: error.signal,
                stdout: error.stdout,
                stderr: error.stderr,
            }) + '\n',
        );
        throw error;
    }
} else {
    const started = performance.now(),
        width = 8192,
        height = 4096,
        planeBytes = width * height * 4,
        stateBytes = planeBytes * 2,
        samples = 3,
        source = {},
        files = ['src/engine/document.ts', 'src/engine/operations.ts', 'tests/max-document.mjs'];
    for (const file of files)
        source[file] = createHash('sha256')
            .update(await fs.readFile(path.join(webRoot, file)))
            .digest('hex');
    const result = {
        ok: false,
        recordedAt: new Date().toISOString(),
        profile: desktopLimits,
        width,
        height,
        layers: 2,
        authoritativeBytes: stateBytes,
        samplesPerOperation: samples,
        watchdogMs: 90000,
        source,
        host: {
            node: process.version,
            platform: os.platform(),
            release: os.release(),
            architecture: os.arch(),
            cpu: os.cpus()[0]?.model,
        },
        scope: {
            memory: 'Unique reachable ArrayBuffers through the named engine roots, deduplicated by buffer identity. process.memoryUsage includes allocator/GC effects; it is not the same as reachable bytes. The small watchdog controller is excluded. No Canvas, renderer, Worker, IPC or native app memory is measured.',
            timing: 'Three sequential samples; explicit GC outside timers when available. p95/p99 are descriptive observed maxima, not hardware acceptance thresholds. Fixture setup and pixel/hash assertions are outside operation timers.',
            cancellation:
                'Synchronous engine stroke cancellation is checked. DOM/Worker/native close and asynchronous in-app cancellation cannot be accepted by this Node runner; use the browser/native suites.',
            history:
                'The zero-pixel-history assertion applies to metadata changes. Generic structural history may retain one oversized entry under the current policy; this exception is recorded explicitly.',
            renderer:
                'No UI, tile uploads, cold rendering or multi-layer visible working-set acceptance is covered here.',
        },
        gcAvailable: typeof globalThis.gc === 'function',
        checks: [],
    };
    function buffers(roots) {
        const seen = new Set(),
            found = new Set(),
            pending = [...roots];
        while (pending.length) {
            const value = pending.pop();
            if (!value || typeof value !== 'object' || seen.has(value)) continue;
            seen.add(value);
            if (ArrayBuffer.isView(value)) found.add(value.buffer);
            else if (value instanceof ArrayBuffer) found.add(value);
            else if (value instanceof Map) for (const [key, item] of value) pending.push(key, item);
            else if (value instanceof Set) pending.push(...value);
            else pending.push(...Object.values(value));
        }
        return {
            count: found.size,
            bytes: [...found].reduce((total, buffer) => total + buffer.byteLength, 0),
        };
    }
    function memory(doc) {
        return {
            document: buffers([doc]),
            currentState: buffers([doc.state]),
            history: buffers(doc.history),
            historyAccountedBytes: doc.historyBytes,
            historyBudget: doc.historyBudget,
            historyEntries: doc.history.length,
            process: process.memoryUsage(),
        };
    }
    function distribution(values) {
        const sorted = values.slice().sort((a, b) => a - b);
        return {
            count: values.length,
            p50: sorted[Math.floor(sorted.length / 2)],
            p95: sorted.at(-1),
            p99: sorted.at(-1),
            samples: values,
        };
    }
    function fixture(w = width) {
        const state = createState(w, height, [0, 0, 0, 0], desktopLimits);
        state.background = [12, 34, 56, 255];
        new Uint32Array(state.layers[0].pixels.buffer).fill(
            new Uint32Array(new Uint8ClampedArray(state.background).buffer)[0],
        );
        const pixels = new Uint8ClampedArray(w * height * 4);
        new Uint32Array(pixels.buffer).fill(
            new Uint32Array(new Uint8ClampedArray([200, 20, 40, 128]).buffer)[0],
        );
        pixels.set([22, 44, 66, 88], 0);
        pixels.set([33, 44, 55, 77], pixels.length - 4);
        state.layers.push({ name: 'top', visible: true, pixels });
        state.active = 1;
        return new PaintDocument(state, desktopLimits);
    }
    function pixelHashes(state) {
        return state.layers.map((layer) => createHash('sha256').update(layer.pixels).digest('hex'));
    }
    function checkpoint() {
        if (performance.now() - started > 85000)
            throw Error('Maximum-document measurement deadline exceeded');
        globalThis.gc?.();
    }
    try {
        const fillTimes = [];
        for (let sample = 0; sample < samples; sample++) {
            checkpoint();
            const start = performance.now(),
                state = createState(width, height, [12, 34, 56, 78], desktopLimits);
            fillTimes.push(performance.now() - start);
            const expected = new Uint32Array(new Uint8ClampedArray([12, 34, 56, 78]).buffer)[0];
            assert.ok(new Uint32Array(state.layers[0].pixels.buffer).every((word) => word === expected));
            assert.equal(buffers([state]).bytes, planeBytes);
        }
        result.checks.push({
            operation: 'constant-background',
            durationMs: distribution(fillTimes),
            outputBytes: planeBytes,
        });
        checkpoint();
        {
            const doc = fixture(),
                originalHashes = pixelHashes(doc.state),
                identities = doc.state.layers.map((layer) => layer.pixels),
                originalRevision = doc.revision,
                metadataTimes = [],
                reorderTimes = [],
                undoTimes = [],
                redoTimes = [];
            for (let sample = 0; sample < samples; sample++) {
                checkpoint();
                const start = performance.now();
                doc.editMetadata('rename', { kind: 'layer-name', layer: 0, name: `renamed-${sample}` });
                metadataTimes.push(performance.now() - start);
                assert.equal(doc.state.layers[0].pixels, identities[0]);
                assert.equal(doc.state.layers[1].pixels, identities[1]);
            }
            for (let sample = 0; sample < samples; sample++) {
                checkpoint();
                const start = performance.now();
                doc.editMetadata('reorder', { kind: 'layer-reorder', layer: 1, to: 0 });
                reorderTimes.push(performance.now() - start);
                assert.equal(doc.state.active, 0);
                assert.equal(doc.state.layers[0].pixels, identities[1]);
                doc.undo();
                assert.equal(doc.state.active, 1);
                assert.equal(doc.state.layers[0].pixels, identities[0]);
            }
            for (let sample = 0; sample < samples; sample++) {
                const start = performance.now();
                doc.undo();
                undoTimes.push(performance.now() - start);
            }
            assert.equal(doc.revision, originalRevision);
            assert.equal(doc.dirty, false);
            assert.equal(doc.state.layers[0].name, '배경');
            for (let sample = 0; sample < samples; sample++) {
                const start = performance.now();
                doc.redo();
                redoTimes.push(performance.now() - start);
            }
            assert.equal(doc.state.layers[0].name, 'renamed-2');
            assert.deepEqual(pixelHashes(doc.state), originalHashes);
            assert.equal(buffers(doc.history).bytes, 0);
            assert.equal(buffers([doc]).bytes, stateBytes);
            result.checks.push({
                operation: 'metadata',
                renameMs: distribution(metadataTimes),
                reorderMs: distribution(reorderTimes),
                undoMs: distribution(undoTimes),
                redoMs: distribution(redoTimes),
                memory: memory(doc),
                pixelHashes: originalHashes,
            });
            const brushTimes = [],
                brushUndo = [],
                brushRedo = [],
                settings = {
                    color: [255, 0, 0, 255],
                    size: 1,
                    opacity: 1,
                    hardness: 1,
                    stabilization: 0,
                    eraser: false,
                    pressure: false,
                    pixel: true,
                };
            for (let sample = 0; sample < samples; sample++) {
                checkpoint();
                const x = 64 + sample * 2,
                    at = (64 * width + x) * 4,
                    before = [...doc.state.layers[1].pixels.subarray(at, at + 4)],
                    start = performance.now();
                doc.beginStroke(x, 64, settings);
                doc.endStroke(x, 64);
                brushTimes.push(performance.now() - start);
                assert.deepEqual([...doc.state.layers[1].pixels.subarray(at, at + 4)], settings.color);
                const undo = performance.now();
                doc.undo();
                brushUndo.push(performance.now() - undo);
                assert.deepEqual([...doc.state.layers[1].pixels.subarray(at, at + 4)], before);
                const redo = performance.now();
                doc.redo();
                brushRedo.push(performance.now() - redo);
                assert.deepEqual([...doc.state.layers[1].pixels.subarray(at, at + 4)], settings.color);
            }
            const brushMemory = memory(doc);
            assert.ok(brushMemory.document.bytes <= stateBytes + samples * 128 * 128 * 8);
            result.checks.push({
                operation: 'single-pixel-brush',
                durationMs: distribution(brushTimes),
                undoMs: distribution(brushUndo),
                redoMs: distribution(brushRedo),
                memory: brushMemory,
            });
            const revision = doc.revision,
                historyLength = doc.history.length,
                beforeCancel = pixelHashes(doc.state),
                cancelTimes = [];
            for (let sample = 0; sample < samples; sample++) {
                checkpoint();
                const start = performance.now();
                doc.beginStroke(90, 90, settings);
                doc.cancelStroke();
                cancelTimes.push(performance.now() - start);
            }
            assert.equal(doc.stroke, undefined);
            assert.equal(doc.revision, revision);
            assert.equal(doc.history.length, historyLength);
            assert.deepEqual(pixelHashes(doc.state), beforeCancel);
            result.checks.push({
                operation: 'synchronous-stroke-cancel',
                durationMs: distribution(cancelTimes),
                memory: memory(doc),
            });
        }
        const cropTimes = [],
            cropUndoTimes = [],
            cropRedoTimes = [],
            cropMemory = [];
        for (let sample = 0; sample < samples; sample++) {
            checkpoint();
            const doc = fixture(),
                originalHashes = pixelHashes(doc.state),
                start = performance.now();
            doc.commitState('crop', cropState(doc.state, 0, 0, 4096, 4096, desktopLimits));
            cropTimes.push(performance.now() - start);
            assert.equal(doc.state.width, 4096);
            assert.equal(doc.state.height, 4096);
            assert.deepEqual([...doc.state.layers[1].pixels.subarray(0, 4)], [22, 44, 66, 88]);
            assert.deepEqual([...doc.state.layers[1].pixels.subarray(-4)], [200, 20, 40, 128]);
            const croppedHashes = pixelHashes(doc.state),
                committed = memory(doc);
            if (doc.historyBytes > doc.historyBudget) assert.equal(doc.history.length, 1);
            const undo = performance.now();
            doc.undo();
            cropUndoTimes.push(performance.now() - undo);
            assert.deepEqual(pixelHashes(doc.state), originalHashes);
            const undone = memory(doc),
                redo = performance.now();
            doc.redo();
            cropRedoTimes.push(performance.now() - redo);
            assert.deepEqual(pixelHashes(doc.state), croppedHashes);
            cropMemory.push({
                committed,
                undone,
                redone: memory(doc),
                retainedOversizedEntry: doc.historyBytes > doc.historyBudget,
            });
        }
        result.checks.push({
            operation: 'crop-and-atomic-commit',
            durationMs: distribution(cropTimes),
            undoMs: distribution(cropUndoTimes),
            redoMs: distribution(cropRedoTimes),
            memory: cropMemory,
        });
        const resizeTimes = [],
            resizeMemory = [];
        for (let sample = 0; sample < samples; sample++) {
            checkpoint();
            const doc = fixture(width - 1),
                originalHashes = pixelHashes(doc.state),
                start = performance.now(),
                expanded = resizeState(doc.state, width, height, false, false, desktopLimits);
            resizeTimes.push(performance.now() - start);
            assert.equal(expanded.width, width);
            assert.equal(expanded.height, height);
            assert.deepEqual([...expanded.layers[0].pixels.subarray(-4)], doc.state.background);
            assert.deepEqual([...expanded.layers[1].pixels.subarray(-4)], [0, 0, 0, 0]);
            assert.deepEqual([...expanded.layers[1].pixels.subarray(0, 4)], [22, 44, 66, 88]);
            assert.deepEqual(pixelHashes(doc.state), originalHashes);
            resizeMemory.push({
                source: buffers([doc.state]),
                sourceAndResult: buffers([doc.state, expanded]),
                process: process.memoryUsage(),
            });
        }
        result.checks.push({
            operation: 'canvas-expand',
            durationMs: distribution(resizeTimes),
            memory: resizeMemory,
        });
        for (const file of files)
            assert.equal(
                createHash('sha256')
                    .update(await fs.readFile(path.join(webRoot, file)))
                    .digest('hex'),
                source[file],
                `Source changed during measurement: ${file}`,
            );
        result.ok = true;
    } catch (error) {
        result.error = error instanceof Error ? error.stack || error.message : String(error);
        throw error;
    } finally {
        result.elapsedMs = performance.now() - started;
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
        console.log(JSON.stringify(result));
    }
}
