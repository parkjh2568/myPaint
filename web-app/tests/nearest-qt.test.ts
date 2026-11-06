import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, cloneState, desktopLimits } from '../src/engine/document';
import { resizeState } from '../src/engine/operations';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/nearest-qt.json', import.meta.url), 'utf8')) as {
    mapsBySource: string[][];
};

test('nearest resize matches 1024 literal Qt axis maps while preserving straight RGBA and input', () => {
    assert.equal(fixture.mapsBySource.length, 32);
    for (let size = 1; size <= 32; size++) {
        assert.equal(fixture.mapsBySource[size - 1].length, 32);
        for (const vertical of [false, true]) {
            const source = createState(vertical ? 1 : size, vertical ? size : 1, [0, 0, 0, 0]);
            source.layers[0].visible = false;
            source.layers[0].name = 'raw source';
            for (let i = 0; i < size; i++)
                source.layers[0].pixels.set([i * 7, i * 5 + 9, i * 3 + 11, [0, 1, 128, 255][i % 4]], i * 4);
            const original = cloneState(source);
            for (let target = 1; target <= 32; target++) {
                const indices = fixture.mapsBySource[size - 1][target - 1].split(',').map(Number);
                assert.equal(indices.length, target);
                const result = resizeState(source, vertical ? 1 : target, vertical ? target : 1, true, false);
                const expected = new Uint8ClampedArray(target * 4);
                for (let i = 0; i < indices.length; i++)
                    expected.set(source.layers[0].pixels.subarray(indices[i] * 4, indices[i] * 4 + 4), i * 4);
                assert.deepEqual(
                    result.layers[0].pixels,
                    expected,
                    `${size}→${target}, vertical=${vertical}`,
                );
                assert.equal(result.layers[0].visible, false);
                assert.equal(result.layers[0].name, 'raw source');
                assert.deepEqual(source, original);
            }
        }
    }
});

test('nearest 2D resize preserves every raw channel, layer metadata and offset-buffer guards', () => {
    for (const offset of [0, 1, 2, 3, 4, 8]) {
        const source = createState(7, 5, [37, 59, 61, 0]);
        source.layers = [];
        source.active = 2;
        const storage: Uint8Array[] = [],
            originals: Uint8Array[] = [];
        for (let layer = 0; layer < 3; layer++) {
            const bytes = new Uint8Array(offset + 7 * 5 * 4 + 3);
            bytes.fill(167);
            const pixels = new Uint8ClampedArray(bytes.buffer, offset, 7 * 5 * 4);
            for (let y = 0; y < 5; y++)
                for (let x = 0; x < 7; x++)
                    pixels.set(
                        [
                            (x * 31 + y * 7 + layer * 13) % 256,
                            (x * 11 + y * 37 + layer * 17) % 256,
                            (x * 29 + y * 19 + layer * 23) % 256,
                            [0, 1, 127, 128, 254, 255][(x + y + layer) % 6],
                        ],
                        (y * 7 + x) * 4,
                    );
            source.layers.push({ name: 'offset layer ' + layer, visible: layer === 1, pixels });
            storage.push(bytes);
            originals.push(bytes.slice());
        }
        const original = cloneState(source);
        for (const [width, height] of [
            [3, 2],
            [11, 9],
            [7, 5],
            [1, 1],
        ]) {
            const result = resizeState(source, width, height, true, false),
                xIndices = fixture.mapsBySource[6][width - 1].split(',').map(Number),
                yIndices = fixture.mapsBySource[4][height - 1].split(',').map(Number);
            assert.deepEqual(
                [result.width, result.height, result.active, result.background],
                [width, height, 2, source.background],
            );
            assert.equal(result.layers.length, 3);
            for (let layer = 0; layer < 3; layer++) {
                const expected = new Uint8ClampedArray(width * height * 4);
                for (let y = 0; y < height; y++)
                    for (let x = 0; x < width; x++) {
                        const at = (yIndices[y] * 7 + xIndices[x]) * 4;
                        expected.set(source.layers[layer].pixels.subarray(at, at + 4), (y * width + x) * 4);
                    }
                assert.deepEqual(
                    result.layers[layer].pixels,
                    expected,
                    `offset${offset}, layer${layer}, ${width}x${height}`,
                );
                assert.notEqual(result.layers[layer].pixels.buffer, source.layers[layer].pixels.buffer);
                assert.deepEqual(
                    [result.layers[layer].name, result.layers[layer].visible],
                    [source.layers[layer].name, source.layers[layer].visible],
                );
                assert.deepEqual(
                    storage[layer],
                    originals[layer],
                    'prefix, source and odd trailing guards stay unchanged',
                );
            }
            assert.deepEqual(source, original);
        }
    }
});

test('nearest desktop axis boundary preserves the lower center texel and rejects invalid profiles', () => {
    const source = createState(32768, 1, [37, 59, 61, 0], desktopLimits);
    source.layers[0].name = 'maximum axis raw';
    source.layers[0].visible = false;
    for (let x = 0; x < source.width; x++)
        source.layers[0].pixels.set([x % 256, (x * 3) % 256, (x * 7) % 256, [0, 1, 128, 255][x % 4]], x * 4);
    source.layers[0].pixels.set([37, 71, 157, 0], 16383 * 4);
    source.layers[0].pixels.set([251, 89, 19, 255], 16384 * 4);
    const original = cloneState(source),
        result = resizeState(source, 1, 32768, true, false, desktopLimits);
    assert.deepEqual([result.width, result.height, result.layers[0].visible], [1, 32768, false]);
    for (let y = 0; y < 32768; y++)
        assert.deepEqual(Array.from(result.layers[0].pixels.subarray(y * 4, y * 4 + 4)), [37, 71, 157, 0]);
    assert.deepEqual(resizeState(source, 32768, 1, true, false, desktopLimits), source);
    assert.throws(() => resizeState(source, 1, 32768, true, false), /한도/);
    assert.throws(() => resizeState(source, 32769, 1, true, false, desktopLimits), /한도/);
    assert.deepEqual(source, original);
});

test('nearest index allocation failure preserves the source and does not affect other resize modes', () => {
    const source = createState(3, 2, [37, 59, 61, 0]);
    source.layers[0].pixels.set([240, 20, 80, 1, 80, 144, 220, 128, 193, 71, 117, 0]);
    const original = cloneState(source),
        OriginalIndices = globalThis.Int32Array;
    let allocations = 0;
    globalThis.Int32Array = new Proxy(OriginalIndices, {
        construct() {
            allocations++;
            throw new RangeError('Injected nearest index allocation failure');
        },
    });
    try {
        assert.doesNotThrow(() => resizeState(source, 6, 4, false, false));
        assert.doesNotThrow(() => resizeState(source, 6, 4, true, true));
        assert.equal(allocations, 0);
        assert.throws(
            () => resizeState(source, 6, 4, true, false),
            /Injected nearest index allocation failure/,
        );
        assert.equal(allocations, 1);
        assert.deepEqual(source, original);
    } finally {
        globalThis.Int32Array = OriginalIndices;
    }
    assert.deepEqual(source, original);
    assert.deepEqual(resizeState(source, 3, 2, true, false), original);
});
