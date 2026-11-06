import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flood } from '../src/engine/operations';

test('fill joins four-connected premultiplied-equivalent low-alpha colors without quantizing source', () => {
    const a = [240, 20, 80, 1],
        b = [250, 10, 100, 1],
        wall = [100, 10, 100, 1];
    const pixels = Uint8ClampedArray.from([a, b, wall, a, wall, wall, b, a, b, wall, a, a].flat());
    const original = pixels.slice();
    const result = flood(pixels, 6, 2, 0, 0, [11, 71, 191, 128])!;
    assert.deepEqual([result.left, result.top, result.width, result.height], [0, 0, 3, 2]);
    assert.deepEqual(
        [...result.pixels],
        [
            [11, 71, 191, 128],
            [11, 71, 191, 128],
            wall,
            [11, 71, 191, 128],
            [11, 71, 191, 128],
            [11, 71, 191, 128],
        ].flat(),
    );
    assert.deepEqual(pixels, original);
});

test('fill treats hidden RGB as the same transparent key but respects an alpha barrier', () => {
    const pixels = Uint8ClampedArray.from(
        [
            [193, 71, 117, 0],
            [12, 99, 231, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 1],
            [193, 71, 117, 0],
        ].flat(),
    );
    const original = pixels.slice();
    const result = flood(pixels, 5, 1, 0, 0, [71, 93, 117, 128])!;
    assert.deepEqual([result.left, result.top, result.width, result.height], [0, 0, 3, 1]);
    assert.deepEqual([...result.pixels], Array.from({ length: 3 }, () => [71, 93, 117, 128]).flat());
    assert.deepEqual(pixels, original);
});

test('premultiplied-equivalent fill replacement is a no-op preserving hidden and low-alpha RGB', () => {
    for (const [original, replacement] of [
        [
            [193, 71, 117, 0],
            [11, 22, 33, 0],
        ],
        [
            [240, 20, 80, 1],
            [250, 10, 100, 1],
        ],
    ] as const) {
        const pixels = Uint8ClampedArray.from(original),
            before = pixels.slice();
        assert.equal(flood(pixels, 1, 1, 0, 0, [...replacement]), undefined);
        assert.deepEqual(pixels, before);
    }
});

test('fill keeps alpha and opaque color boundaries distinct', () => {
    const pixels = Uint8ClampedArray.from(
        [
            [240, 20, 80, 1],
            [240, 20, 80, 2],
            [240, 20, 80, 255],
        ].flat(),
    );
    const result = flood(pixels, 3, 1, 0, 0, [1, 2, 3, 255])!;
    assert.deepEqual([result.left, result.top, result.width, result.height], [0, 0, 1, 1]);
    assert.deepEqual([...result.pixels], [1, 2, 3, 255]);
});

test('invalid fill coordinates cannot redirect the operation to the first pixel', () => {
    const pixels = Uint8ClampedArray.from([9, 8, 7, 255]),
        before = pixels.slice();
    for (const [x, y] of [
        [NaN, 0],
        [0, NaN],
        [Infinity, 0],
        [0, -Infinity],
    ])
        assert.equal(flood(pixels, 1, 1, x, y, [1, 2, 3, 255]), undefined);
    assert.deepEqual(pixels, before);
});

const qtFixtures = JSON.parse(readFileSync(new URL('./fixtures/flood-key-qt.json', import.meta.url), 'utf8'));
for (const fixture of qtFixtures.cases) {
    test('actual Qt fill membership: ' + fixture.name, () => {
        const pixels = Uint8ClampedArray.from(
                (fixture.rows as string[]).flatMap((row) => [...row].flatMap((ch) => fixture.palette[ch])),
            ),
            original = pixels.slice(),
            expected = pixels.slice();
        for (let y = 0; y < fixture.height; y++)
            for (let x = 0; x < fixture.width; x++)
                if (fixture.changedMask[y][x] === '#')
                    expected.set(fixture.replacement, (y * fixture.width + x) * 4);
        const patch = flood(
            pixels,
            fixture.width,
            fixture.height,
            fixture.start[0],
            fixture.start[1],
            fixture.replacement,
        );
        assert.equal(!!patch, fixture.changed);
        const actual = pixels.slice();
        if (patch)
            for (let y = 0; y < patch.height; y++)
                actual.set(
                    patch.pixels.subarray(y * patch.width * 4, (y + 1) * patch.width * 4),
                    ((patch.top + y) * fixture.width + patch.left) * 4,
                );
        assert.deepEqual(actual, expected);
        assert.deepEqual(pixels, original);
    });
}

test('fill builds multiple result spans around a hole from unaligned source storage', () => {
    const pixels = new Uint8ClampedArray(7 * 7 * 4 + 3).subarray(3);
    const expected = new Uint8ClampedArray(7 * 7 * 4);
    for (let y = 0; y < 7; y++)
        for (let x = 0; x < 7; x++) {
            const border = x === 0 || y === 0 || x === 6 || y === 6;
            const color = border || (x === 3 && y === 3) ? [1, 2, 3, 255] : [9, 8, 7, 255];
            pixels.set(color, (y * 7 + x) * 4);
            expected.set(border ? [11, 71, 191, 128] : color, (y * 7 + x) * 4);
        }
    const original = pixels.slice(),
        result = flood(pixels, 7, 7, 0, 0, [11, 71, 191, 128])!;
    assert.deepEqual([result.left, result.top, result.width, result.height], [0, 0, 7, 7]);
    assert.deepEqual(result.pixels, expected);
    assert.deepEqual(pixels, original);
});
