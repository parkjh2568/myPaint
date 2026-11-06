import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopLimits } from '../src/engine/document';
import { polygonMask } from '../src/engine/operations';

const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/polygon-mask-qt.json', import.meta.url), 'utf8'),
) as {
    cases: {
        name: string;
        left?: number;
        top?: number;
        width: number;
        height: number;
        rawPoints: [number, number][];
        maskRows: string[];
    }[];
};

test('polygon mask matches 871 literal Qt aliased clips including floor, retracing, intersections and 512 seams', () => {
    assert.equal(fixture.cases.length, 871);
    for (const spec of fixture.cases) {
        const points = spec.rawPoints.map(([x, y]) => ({ x, y })),
            original = structuredClone(points),
            expected = Uint8Array.from(
                Array.from(spec.maskRows.join(''), (pixel) => (pixel === '#' ? 255 : 0)),
            );
        assert.equal(expected.length, spec.width * spec.height);
        const actual = polygonMask(points, spec.left ?? 0, spec.top ?? 0, spec.width, spec.height);
        assert.deepEqual(actual, expected, spec.name);
        assert.equal(actual.byteLength, spec.width * spec.height);
        assert.deepEqual(points, original);
    }
});

test('polygon mask validates coordinates and dimensions before output allocation without changing points', () => {
    const path = [
            { x: 1, y: 1 },
            { x: 5, y: 1 },
            { x: 1, y: 5 },
        ],
        original = structuredClone(path);
    for (const value of [NaN, Infinity, -Infinity, 8388608]) {
        assert.throws(() => polygonMask([{ x: value, y: 1 }, ...path], 0, 0, 8, 8));
        assert.throws(() => polygonMask([{ x: 1, y: value }, ...path], 0, 0, 8, 8));
        assert.throws(() => polygonMask(path, value, 0, 8, 8));
        assert.throws(() => polygonMask(path, 0, value, 8, 8));
    }
    for (const size of [0, -1, 0.5, 32769, Infinity])
        assert.throws(() => polygonMask(path, 0, 0, size, 8, desktopLimits));
    assert.deepEqual(path, original);
    assert.deepEqual(polygonMask([], 0, 0, 3, 2), new Uint8Array(6));
    assert.deepEqual(
        polygonMask(
            [
                { x: 0, y: 1 },
                { x: 2, y: 1 },
            ],
            0,
            0,
            3,
            2,
        ),
        new Uint8Array(6),
    );
});

test('polygon mask handles a long repeated path without argument spreading or changing parity', () => {
    const path: { x: number; y: number }[] = [];
    for (let i = 0; i < 100000; i++) path.push({ x: 1, y: 1 });
    path.push({ x: 5, y: 1 }, { x: 5, y: 5 }, { x: 1, y: 5 });
    const mask = polygonMask(path, 0, 0, 6, 6);
    assert.deepEqual(
        Array.from({ length: 6 }, (_, y) =>
            Array.from(mask.subarray(y * 6, y * 6 + 6), (alpha) => (alpha ? '#' : '.')).join(''),
        ),
        ['......', '.####.', '.####.', '.####.', '.####.', '......'],
    );
});

test('dense masks match twelve actual Qt clips including column collisions and sparse row transitions', () => {
    const dense = JSON.parse(
        readFileSync(new URL('./fixtures/polygon-mask-dense-qt.json', import.meta.url), 'utf8'),
    ) as typeof fixture;
    assert.equal(dense.cases.length, 12);
    for (const spec of dense.cases) {
        const points = spec.rawPoints.map(([x, y]) => ({ x, y })),
            original = structuredClone(points),
            expected = Uint8Array.from(Array.from(spec.maskRows.join(''), (c) => (c === '#' ? 255 : 0)));
        assert.equal(expected.length, spec.width * spec.height);
        assert.deepEqual(
            polygonMask(points, spec.left ?? 0, spec.top ?? 0, spec.width, spec.height, desktopLimits),
            expected,
            spec.name,
        );
        assert.deepEqual(points, original);
    }
});

test('dense maximum-width workspace is allocated once and preserves retraced zero-area paths', () => {
    const points = Array.from({ length: 16384 }, (_, i) => ({ x: i % 2 ? 32768 : 0, y: i % 2 ? 2 : 0 })),
        original = structuredClone(points),
        OriginalBytes = globalThis.Uint8Array,
        allocations: number[] = [];
    globalThis.Uint8Array = new Proxy(OriginalBytes, {
        construct(target, args) {
            if (args.length === 1 && typeof args[0] === 'number') allocations.push(args[0]);
            return Reflect.construct(target, args, target);
        },
    });
    let mask: Uint8Array;
    try {
        mask = polygonMask(points, 0, 0, 32768, 2, desktopLimits);
    } finally {
        globalThis.Uint8Array = OriginalBytes;
    }
    assert.deepEqual(allocations, [65536, 32769]);
    assert.equal(mask!.length, 65536);
    assert(mask!.every((value) => value === 0));
    assert.deepEqual(points, original);
});

test('dense workspace allocation failure leaves the input intact and permits a clean retry', () => {
    const points = Array.from({ length: 128 }, (_, i) => ({ x: i % 2 ? 64 : 0, y: i % 2 ? 32 : 0 })),
        original = structuredClone(points),
        OriginalBytes = globalThis.Uint8Array;
    let failures = 0;
    globalThis.Uint8Array = new Proxy(OriginalBytes, {
        construct(target, args) {
            if (args.length === 1 && args[0] === 65) {
                failures++;
                throw new RangeError('Injected dense workspace allocation failure');
            }
            return Reflect.construct(target, args, target);
        },
    });
    try {
        assert.throws(() => polygonMask(points, 0, 0, 64, 33), /Injected dense workspace allocation failure/);
        assert.equal(failures, 1);
        assert.deepEqual(points, original);
    } finally {
        globalThis.Uint8Array = OriginalBytes;
    }
    assert.deepEqual(polygonMask(points, 0, 0, 64, 33), new OriginalBytes(64 * 33));
    assert.deepEqual(points, original);
});
