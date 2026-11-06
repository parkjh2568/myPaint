import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import type { Color } from '../src/engine/document';
import type { TileTransform, PixelRect } from '../src/platform/tiles';

// Execute the shipped render callback. The literal oracle below preserves the d320b6a7 source loop.
const text = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'),
    ast = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true),
    callbacks: string[] = [];
function visit(node: ts.Node): void {
    if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(ast) === 'transform' &&
        ts.isArrowFunction(node.initializer)
    )
        callbacks.push(node.initializer.getText(ast));
    ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(callbacks.length, 1);
interface CutSelection {
    source?: PixelRect;
    sourceMask?: Uint8Array;
    width: number;
    height: number;
    pixels: Uint8ClampedArray;
}
interface CutState {
    background: Color;
    layers: object[];
}
const compiled = ts.transpileModule('const callback = ' + callbacks[0], {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const factory = new Function('sel', 's', compiled + '\nreturn callback;') as (
    selection: CutSelection,
    state: CutState,
) => TileTransform;
function reference(
    sel: CutSelection,
    state: CutState,
    pixels: Uint8ClampedArray,
    x: number,
    y: number,
    width: number,
    height: number,
): void {
    const source = sel.source;
    if (!source) return;
    const target = state.layers.length === 1 ? state.background : [0, 0, 0, 0];
    for (let row = 0; row < height; row++)
        for (let col = 0; col < width; col++) {
            const sx = x + col - source.x,
                sy = y + row - source.y;
            if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
            if (sel.sourceMask && !sel.sourceMask[sy * source.width + sx]) continue;
            pixels.set(target, (row * width + col) * 4);
        }
}

test('cut callback matches the frozen source loop on 22400 complete guarded backing views', () => {
    let cases = 0;
    for (const [width, height] of [
        [1, 1],
        [3, 2],
        [8, 4],
        [13, 5],
    ])
        for (const [x, y] of [
            [-7, -3],
            [-1, 0],
            [0, 0],
            [2, 3],
            [4, -1],
            [10, 5],
            [50, 50],
        ])
            for (const source of [
                undefined,
                { x: 2, y: 3, width: 5, height: 3 },
                { x: -3, y: -2, width: 7, height: 5 },
                { x: -20, y: -20, width: 40, height: 40 },
                { x: 0.25, y: 0.75, width: 5, height: 3 },
            ])
                for (const kind of ['none', 'full', 'holes', 'truncated'])
                    for (const background of [
                        [0, 0, 0, 0],
                        [37, 59, 61, 128],
                        [255, 255, 255, 255],
                        [193, 71, 117, 0],
                    ] as Color[])
                        for (const layers of [1, 3])
                            for (const offset of [0, 1, 3, 4, 8]) {
                                const mask =
                                        kind === 'none'
                                            ? undefined
                                            : Uint8Array.from(
                                                  {
                                                      length:
                                                          kind === 'truncated'
                                                              ? 3
                                                              : (source?.width ?? 5) * (source?.height ?? 3),
                                                  },
                                                  (_, i) => (kind === 'full' ? 255 : i % 3 ? 0 : 255),
                                              ),
                                    selection = {
                                        source,
                                        sourceMask: mask,
                                        width: 2,
                                        height: 7,
                                        pixels: new Uint8ClampedArray(56),
                                    },
                                    state = {
                                        background,
                                        layers: Array.from({ length: layers }, () => ({})),
                                    },
                                    input = Uint8ClampedArray.from(
                                        { length: offset + width * height * 4 + 7 },
                                        (_, i) => (i * 37 + 53) % 256,
                                    ),
                                    expected = input.slice(),
                                    actual = input.slice(),
                                    retainedMask = mask?.slice(),
                                    retained = structuredClone({ source, background });
                                reference(
                                    selection,
                                    state,
                                    expected.subarray(offset, offset + width * height * 4),
                                    x,
                                    y,
                                    width,
                                    height,
                                );
                                factory(selection, state)(
                                    actual.subarray(offset, offset + width * height * 4),
                                    x,
                                    y,
                                    width,
                                    height,
                                );
                                assert.deepEqual(
                                    actual,
                                    expected,
                                    JSON.stringify({
                                        width,
                                        height,
                                        x,
                                        y,
                                        source,
                                        kind,
                                        background,
                                        layers,
                                        offset,
                                    }),
                                );
                                assert.deepEqual(mask, retainedMask);
                                assert.deepEqual({ source, background }, retained);
                                assert(selection.pixels.every((value) => value === 0));
                                cases++;
                            }
    assert.equal(cases, 22400);
});

test('cut uses original source-mask stride and Source RGBA despite resized transparent payload', () => {
    const source = { x: 2, y: 1, width: 5, height: 3 },
        sourceMask = Uint8Array.from('#.#.#.###.##..#', (value) => (value === '#' ? 255 : 0)),
        selection = { source, sourceMask, width: 2, height: 9, pixels: new Uint8ClampedArray(72) },
        cleared = new Set(['2,1', '4,1', '6,1', '3,2', '4,2', '5,2', '2,3', '3,3', '6,3']);
    for (const background of [
        [193, 71, 117, 0],
        [37, 59, 61, 1],
        [37, 59, 61, 128],
        [255, 255, 255, 255],
    ] as Color[])
        for (const count of [1, 4]) {
            const pixels = new Uint8ClampedArray(7 * 5 * 4);
            for (let i = 0; i < pixels.length; i += 4) pixels.set([9, 19, 29, 128], i);
            factory(selection, { background, layers: Array.from({ length: count }, () => ({})) })(
                pixels,
                1,
                0,
                7,
                5,
            );
            for (let y = 0; y < 5; y++)
                for (let x = 0; x < 7; x++)
                    assert.deepEqual(
                        Array.from(pixels.subarray((y * 7 + x) * 4, (y * 7 + x + 1) * 4)),
                        cleared.has(`${x + 1},${y}`)
                            ? count === 1
                                ? background
                                : [0, 0, 0, 0]
                            : [9, 19, 29, 128],
                    );
        }
});

test('cut callback keeps maximum source stride and far-edge clipped row addressing', () => {
    const sourceMask = new Uint8Array(32768 * 2);
    sourceMask[32768 + 32767] = 255;
    const selection = {
            source: { x: 0, y: 0, width: 32768, height: 2 },
            sourceMask,
            width: 1,
            height: 1,
            pixels: new Uint8ClampedArray(4),
        },
        pixels = new Uint8ClampedArray(3 * 2 * 4).fill(183);
    factory(selection, { background: [37, 59, 61, 128], layers: [{}] })(pixels, 32767, 1, 3, 2);
    assert.deepEqual(Array.from(pixels.subarray(0, 4)), [37, 59, 61, 128]);
    assert(pixels.subarray(4).every((value) => value === 183));
});
