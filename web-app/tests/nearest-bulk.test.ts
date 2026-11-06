import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, cloneState, desktopLimits } from '../src/engine/document';
import { resizeState } from '../src/engine/operations';
const maps = JSON.parse(readFileSync(new URL('./fixtures/nearest-qt.json', import.meta.url), 'utf8'))
    .mapsBySource as string[][];

test('nearest row and horizontal reuse preserve literal Qt pixels, metadata and offset guards across layers', () => {
    for (const offset of [0, 1, 2, 3, 4, 8]) {
        const state = createState(7, 2, [37, 59, 61, 0]);
        state.active = 2;
        state.layers = [];
        const storage: Uint8Array[] = [],
            retained: Uint8Array[] = [];
        for (let layer = 0; layer < 3; layer++) {
            const bytes = new Uint8Array(offset + 7 * 2 * 4 + 3).fill(167),
                pixels = new Uint8ClampedArray(bytes.buffer, offset, 7 * 2 * 4);
            for (let i = 0; i < 14; i++)
                pixels.set(
                    [
                        (i * 17 + layer * 13) % 256,
                        (i * 31 + layer * 7) % 256,
                        (i * 23 + layer * 11) % 256,
                        [0, 1, 128, 255][(i + layer) % 4],
                    ],
                    i * 4,
                );
            state.layers.push({ name: 'row source ' + layer, visible: layer === 1, pixels });
            storage.push(bytes);
            retained.push(bytes.slice());
        }
        const original = cloneState(state);
        for (const [width, height] of [
            [14, 9],
            [11, 9],
            [7, 9],
            [3, 9],
            [14, 2],
            [8, 2],
            [7, 2],
        ]) {
            const out = resizeState(state, width, height, true, false),
                xs = maps[6][width - 1].split(',').map(Number),
                ys = maps[1][height - 1].split(',').map(Number);
            assert.deepEqual(
                [out.width, out.height, out.active, out.background],
                [width, height, 2, state.background],
            );
            assert.equal(new Set(out.layers.map((layer) => layer.pixels.buffer)).size, 3);
            for (let layer = 0; layer < 3; layer++) {
                const expected = new Uint8ClampedArray(width * height * 4);
                for (let y = 0; y < height; y++)
                    for (let x = 0; x < width; x++) {
                        const at = (ys[y] * 7 + xs[x]) * 4;
                        expected.set(state.layers[layer].pixels.subarray(at, at + 4), (y * width + x) * 4);
                    }
                assert.deepEqual(out.layers[layer].pixels, expected);
                assert.notEqual(out.layers[layer].pixels.buffer, state.layers[layer].pixels.buffer);
                assert.deepEqual(
                    [out.layers[layer].name, out.layers[layer].visible],
                    [state.layers[layer].name, state.layers[layer].visible],
                );
                assert.deepEqual(storage[layer], retained[layer]);
            }
            out.layers[0].pixels[0] ^= 255;
            assert.deepEqual(state, original);
        }
    }
});

test('one-row multicolor layers start independently and identity resizing still owns a fresh output', () => {
    const state = createState(5, 1, [193, 71, 117, 0]);
    state.layers = [];
    for (let layer = 0; layer < 3; layer++) {
        const pixels = new Uint8ClampedArray(20);
        for (let x = 0; x < 5; x++)
            pixels.set(
                [17 + x * 7 + layer * 31, 37 + layer * 19, 191 - x * 11, [0, 1, 128, 255][(x + layer) % 4]],
                x * 4,
            );
        state.layers.push({ name: 'single row ' + layer, visible: layer === 2, pixels });
    }
    state.active = 1;
    const original = cloneState(state),
        result = resizeState(state, 9, 7, true, false),
        xs = [0, 0, 1, 1, 2, 3, 3, 4, 4];
    for (let layer = 0; layer < 3; layer++)
        for (let y = 0; y < 7; y++)
            for (let x = 0; x < 9; x++)
                assert.deepEqual(
                    Array.from(result.layers[layer].pixels.subarray((y * 9 + x) * 4, (y * 9 + x + 1) * 4)),
                    Array.from(state.layers[layer].pixels.subarray(xs[x] * 4, xs[x] * 4 + 4)),
                );
    const identity = resizeState(state, 5, 1, true, false);
    assert.deepEqual(identity, state);
    for (let layer = 0; layer < 3; layer++) {
        assert.notEqual(identity.layers[layer].pixels.buffer, state.layers[layer].pixels.buffer);
        assert.notEqual(result.layers[layer].pixels.buffer, state.layers[layer].pixels.buffer);
    }
    result.layers[1].pixels[0] ^= 255;
    assert.deepEqual(state, original);
});

test('large and adjacent axis ratios match an independent integer nearest model on aligned and unaligned raw views', () => {
    for (const [sourceWidth, width] of [
        [16384, 32768],
        [16383, 32767],
        [32767, 32768],
        [32768, 32767],
        [32768, 16384],
        [1, 32768],
        [2, 32768],
        [17, 4093],
    ])
        for (const offset of [0, 1, 4]) {
            const state = createState(sourceWidth, 1, [37, 59, 61, 0], desktopLimits),
                backing = new Uint8Array(offset + sourceWidth * 4 + 3).fill(167),
                source = new Uint8ClampedArray(backing.buffer, offset, sourceWidth * 4);
            for (let x = 0; x < sourceWidth; x++)
                source.set(
                    [(17 + x) % 256, (31 + x * 3) % 256, (193 + x * 7) % 256, [0, 1, 128, 255][x % 4]],
                    x * 4,
                );
            state.layers[0].pixels = source;
            const retained = backing.slice(),
                output = resizeState(state, width, 1, true, false, desktopLimits).layers[0].pixels,
                numeratorScale = BigInt(sourceWidth),
                denominator = 2n * BigInt(width);
            for (let x = 0; x < width; x++) {
                const sx = Number(
                    ((2n * BigInt(x) + 1n) * numeratorScale + denominator - 1n) / denominator - 1n,
                );
                for (let c = 0; c < 4; c++) assert.equal(output[x * 4 + c], source[sx * 4 + c]);
            }
            assert.deepEqual(backing, retained);
        }
});

test('a failed second output allocation leaves all raw input layers intact and permits a retry', () => {
    const state = createState(3, 2, [37, 59, 61, 0]);
    for (let layer = 0; layer < 3; layer++) {
        if (layer)
            state.layers.push({
                name: 'allocation layer ' + layer,
                visible: layer === 1,
                pixels: new Uint8ClampedArray(24),
            });
        for (let i = 0; i < 6; i++)
            state.layers[layer].pixels.set([17 + i + layer * 31, 71, 157, [0, 1, 128, 255][i % 4]], i * 4);
    }
    const original = cloneState(state),
        OriginalPixels = globalThis.Uint8ClampedArray;
    let planes = 0;
    globalThis.Uint8ClampedArray = new Proxy(OriginalPixels, {
        construct(target, args) {
            if (args.length === 1 && args[0] === 120 && ++planes === 2)
                throw new RangeError('Injected second nearest plane allocation failure');
            return Reflect.construct(target, args, target);
        },
    });
    try {
        assert.throws(() => resizeState(state, 6, 5, true, false), /Injected second nearest plane/);
        assert.equal(planes, 2);
        assert.deepEqual(state, original);
    } finally {
        globalThis.Uint8ClampedArray = OriginalPixels;
    }
    const output = resizeState(state, 6, 5, true, false);
    assert.equal(output.layers.length, 3);
    assert.deepEqual(state, original);
});

test('row-copy failure after writing an owned candidate never changes its source', () => {
    const state = createState(128, 2, [37, 59, 61, 0]);
    state.layers[0].pixels.set([193, 71, 117, 0]);
    const original = cloneState(state),
        nativeSet = Uint8ClampedArray.prototype.set;
    let injected = 0;
    Uint8ClampedArray.prototype.set = function (this: Uint8ClampedArray, source, offset) {
        nativeSet.call(this, source, offset);
        if (this.length === 128 * 10 * 4 && !injected++)
            throw Error('Injected nearest row copy failure after write');
    };
    try {
        assert.throws(() => resizeState(state, 128, 10, true, false), /Injected nearest row copy/);
        assert.deepEqual(state, original);
    } finally {
        Uint8ClampedArray.prototype.set = nativeSet;
    }
    const output = resizeState(state, 128, 10, true, false).layers[0].pixels;
    for (let y = 0; y < 10; y++) {
        const sourceRow = y < 5 ? 0 : 1;
        assert.deepEqual(
            output.subarray(y * 512, (y + 1) * 512),
            state.layers[0].pixels.subarray(sourceRow * 512, (sourceRow + 1) * 512),
        );
    }
    assert.deepEqual(state, original);
});

test('repeated-output-row failure after writing an owned candidate preserves inputs and permits a clean retry', () => {
    const state = createState(64, 2, [37, 59, 61, 0]);
    for (let x = 0; x < 128; x++)
        state.layers[0].pixels.set([17 + (x % 231), 71, 157, [0, 1, 128, 255][x % 4]], x * 4);
    const original = cloneState(state),
        nativeCopy = Uint8ClampedArray.prototype.copyWithin;
    let injected = 0;
    Uint8ClampedArray.prototype.copyWithin = function (this: Uint8ClampedArray, target, start, end) {
        const result = nativeCopy.call(this, target, start, end);
        if (this.length === 128 * 10 * 4 && !injected++)
            throw Error('Injected nearest repeat copy failure after write');
        return result;
    };
    try {
        assert.throws(() => resizeState(state, 128, 10, true, false), /Injected nearest repeat copy/);
        assert.deepEqual(state, original);
    } finally {
        Uint8ClampedArray.prototype.copyWithin = nativeCopy;
    }
    const output = resizeState(state, 128, 10, true, false).layers[0].pixels;
    assert.equal(output.length, 128 * 10 * 4);
    assert.deepEqual(state, original);
    for (let y = 0; y < 10; y++)
        for (let x = 0; x < 128; x++) {
            const at = ((y < 5 ? 0 : 1) * 64 + Math.floor(x / 2)) * 4;
            for (let c = 0; c < 4; c++)
                assert.equal(output[(y * 128 + x) * 4 + c], state.layers[0].pixels[at + c]);
        }
});
