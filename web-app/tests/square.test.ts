import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    PaintDocument,
    createState,
    cloneState,
    desktopLimits,
    type BrushSettings,
    type Color,
} from '../src/engine/document';

const square: BrushSettings = {
    color: [77, 144, 219, 128],
    size: 4,
    opacity: 0,
    hardness: 0,
    stabilization: 75,
    pressure: true,
    eraser: true,
    square: true,
};
type Span = [number, number, number];
interface GeometryCase {
    name: string;
    width: number;
    height: number;
    size: number;
    from: [number, number];
    to: [number, number];
    expected: { alpha: number; spans: Span[] }[];
}

test('square eraser matches 693 independently recorded wide Qt gesture masks and preserves exact Source pixels', () => {
    const fixture = JSON.parse(
        readFileSync(new URL('./fixtures/square-wide-qt.json', import.meta.url), 'utf8'),
    ) as { cases: GeometryCase[] };
    assert.equal(fixture.cases.length, 231);
    for (const c of fixture.cases)
        for (const expectation of c.expected) {
            const state = createState(c.width, c.height, [210, 80, 30, 255], desktopLimits),
                original = state.layers[0].pixels.slice(),
                expected = original.slice(),
                color: Color = [17, 91, 203, expectation.alpha],
                doc = new PaintDocument(state, desktopLimits);
            for (const [y, left, right] of expectation.spans)
                for (let x = left; x < right; x++) expected.set(color, (y * c.width + x) * 4);
            doc.beginStroke(...c.from, { ...square, color, size: c.size }, 0.01);
            doc.moveStroke(...c.to, 0.01);
            doc.endStroke(...c.to);
            assert.deepEqual(state.layers[0].pixels, expected, c.name + '/' + expectation.alpha);
            const changed = expected.some((v, i) => v !== original[i]);
            assert.equal(doc.canUndo, changed, c.name);
            if (changed) {
                doc.undo();
                assert.deepEqual(doc.state.layers[0].pixels, original, c.name);
                doc.redo();
                assert.deepEqual(doc.state.layers[0].pixels, expected, c.name);
            }
        }
});

test('square width1 matches all 4543 Qt endpoint, direction and clipped-input masks', () => {
    const fixture = JSON.parse(
        readFileSync(new URL('./fixtures/square-thin-qt.json', import.meta.url), 'utf8'),
    ) as {
        cases: { name: string; from: [number, number]; to: [number, number]; spans: Span[] }[];
    };
    assert.equal(fixture.cases.length, 4543);
    for (const c of fixture.cases) {
        const doc = new PaintDocument(createState(24, 24, [255, 0, 0, 255], desktopLimits), desktopLimits),
            expected = doc.state.layers[0].pixels.slice(),
            color: Color = [0, 0, 255, 255];
        for (const [y, left, right] of c.spans)
            for (let x = left; x < right; x++) expected.set(color, (y * 24 + x) * 4);
        doc.beginStroke(...c.from, { ...square, color, size: 1 }, 0.01);
        doc.moveStroke(...c.to, 0.01);
        doc.endStroke(...c.to);
        assert.deepEqual(doc.state.layers[0].pixels, expected, c.name);
    }
});

test('square brush and eraser retain 161 legacy option, mask, visibility and history fixtures', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/square-qt.json', import.meta.url), 'utf8'));
    assert.equal(fixture.cases.length, 161);
    for (const c of fixture.cases) {
        const state = createState(fixture.width, fixture.height, c.fill);
        state.background = [c.background[0], c.background[1], c.background[2], c.background[3]];
        state.layers[0].visible = !c.name.includes('hidden');
        if (c.multi)
            state.layers.push({
                name: 'unused',
                visible: true,
                pixels: new Uint8ClampedArray(fixture.width * fixture.height * 4),
            });
        const doc = new PaintDocument(state),
            original = cloneState(state),
            color =
                c.tool === 'eraser'
                    ? c.multi
                        ? [0, 0, 0, 0]
                        : c.background
                    : c.right
                      ? c.background
                      : c.ink;
        doc.beginStroke(
            c.from[0],
            c.from[1],
            {
                ...square,
                color,
                size: c.size,
                opacity: c.opacity / 100,
                hardness: c.hardness / 100,
                stabilization: c.stabilization,
                eraser: c.tool === 'eraser',
                pressure: c.tablet,
            },
            c.pressure,
        );
        if (!c.noMove) doc.moveStroke(c.to[0], c.to[1], c.pressure);
        if (c.name.includes('cancel')) doc.cancelStroke();
        else doc.endStroke(c.to[0], c.to[1]);
        for (let y = 0; y < fixture.height; y++)
            for (let x = 0; x < fixture.width; x++) {
                const i = (y * fixture.width + x) * 4,
                    changed = state.layers[0].pixels
                        .subarray(i, i + 4)
                        .some((v, k) => v !== original.layers[0].pixels[i + k]);
                assert.equal(changed, c.mask[y][x] === '#', c.name + '/' + x + ',' + y);
            }
        assert.equal(state.layers[0].visible, c.visibleAfter, c.name);
        assert.equal(doc.dirty, c.dirty, c.name);
        assert.equal(doc.canUndo, c.canUndo, c.name);
        if (doc.canUndo) {
            const drawn = cloneState(state);
            doc.undo();
            assert.deepEqual(doc.state, original, c.name);
            doc.redo();
            assert.deepEqual(doc.state, drawn, c.name);
        }
    }
});

test('square source-over counts actual point and segment events without a duplicate release', () => {
    for (const mode of ['click', 'stationary-move', 'line-move', 'release-endpoint']) {
        const base: Color = [21, 83, 137, 63],
            ink: Color = [77, 144, 219, 128],
            doc = new PaintDocument(createState(24, 24, base)),
            expected = doc.state.layers[0].pixels.slice(),
            from: [number, number] = mode === 'click' || mode === 'stationary-move' ? [8, 8] : [5, 8],
            end: [number, number] = mode === 'click' || mode === 'stationary-move' ? [8, 8] : [15, 8];
        // Literal axis spans and independent straight-RGBA source-over; no Qt premul rounding tolerance.
        const passes = [
            [from[0] - 2, from[0] + 2],
            [from[0] - 2, from[0] + 2],
        ];
        if (mode === 'stationary-move') passes.push([6, 10], [6, 10]);
        else if (mode === 'line-move' || mode === 'release-endpoint') passes.push([3, 17]);
        for (const [left, right] of passes)
            for (let y = 6; y < 10; y++)
                for (let x = left; x < right; x++) {
                    const p = (y * 24 + x) * 4,
                        a = ink[3] / 255,
                        b = expected[p + 3] / 255,
                        alpha = a + b * (1 - a);
                    for (let k = 0; k < 3; k++)
                        expected[p + k] = Math.round((ink[k] * a + expected[p + k] * b * (1 - a)) / alpha);
                    expected[p + 3] = Math.round(alpha * 255);
                }
        doc.beginStroke(...from, { ...square, color: ink, eraser: false });
        if (mode === 'stationary-move' || mode === 'line-move') doc.moveStroke(...end);
        doc.endStroke(...end);
        assert.deepEqual(doc.state.layers[0].pixels, expected, mode);
        assert.equal(doc.history.length, 1, mode);
    }
});

test('square strokes capture colors and raw originals without allocating coverage planes', () => {
    const color: [number, number, number, number] = [17, 91, 203, 128],
        doc = new PaintDocument(createState(260, 4, [21, 83, 137, 63])),
        original = cloneState(doc.state);
    doc.editMetadata('redo', { kind: 'layer-name', layer: 0, name: 'redo name' });
    doc.undo();
    doc.beginStroke(1, 1, { ...square, size: 1, color });
    color.fill(0);
    doc.moveStroke(259, 1);
    assert(doc.stroke!.tiles.size >= 3);
    for (const tile of doc.stroke!.tiles.values()) {
        assert(tile.before.byteLength);
        assert.equal(tile.coverage.byteLength, 0);
    }
    assert.deepEqual(
        Array.from(doc.state.layers[0].pixels.slice((1 * 260 + 200) * 4, (1 * 260 + 200) * 4 + 4)),
        [17, 91, 203, 128],
    );
    doc.cancelStroke();
    assert.deepEqual(doc.state, original);
    assert.equal(doc.canRedo, true);
    assert.equal(doc.dirty, false);
});

test('shared tile allocation failures restore square or round ownership and the previous Redo branch', () => {
    for (const failure of ['before', 'coverage', 'end-after']) {
        const state = createState(260, 4, [21, 83, 137, 63]);
        state.layers[0].visible = false;
        const doc = new PaintDocument(state);
        doc.editMetadata('redo', { kind: 'layer-name', layer: 0, name: 'redo name' });
        doc.undo();
        const original = cloneState(state),
            revision = doc.revision,
            history = doc.history,
            Clamped = globalThis.Uint8ClampedArray,
            Bytes = globalThis.Uint8Array;
        doc.beginStroke(1, 1, {
            ...square,
            size: 1,
            opacity: 1,
            hardness: 1,
            stabilization: 0,
            pressure: false,
            square: failure !== 'coverage',
        });
        let fired = false;
        const Type = failure === 'coverage' ? Bytes : Clamped,
            allocation = failure === 'coverage' ? 512 : 2048,
            injected = new Proxy(Type, {
                construct(target, args, newTarget) {
                    if (!fired && args.length === 1 && args[0] === allocation) {
                        fired = true;
                        throw Error('Injected tile allocation failure');
                    }
                    return Reflect.construct(target, args, newTarget);
                },
            });
        try {
            if (failure === 'coverage') globalThis.Uint8Array = injected as Uint8ArrayConstructor;
            else globalThis.Uint8ClampedArray = injected as Uint8ClampedArrayConstructor;
            if (failure === 'end-after') assert.throws(() => doc.endStroke(1, 1), /Injected/);
            else {
                assert.throws(() => doc.moveStroke(259, 1), /Injected/);
                doc.cancelStroke();
            }
        } finally {
            globalThis.Uint8Array = Bytes;
            globalThis.Uint8ClampedArray = Clamped;
            doc.cancelStroke();
        }
        assert(fired, failure);
        assert.deepEqual(doc.state, original, failure);
        assert.equal(doc.revision, revision);
        assert.equal(doc.history, history);
        assert.equal(doc.canRedo, true);
        doc.redo();
        assert.equal(doc.state.layers[0].name, 'redo name');
    }
});

test('transparent square erasing preserves hidden RGB and creates only an intentional visibility change', () => {
    for (const visible of [true, false]) {
        const state = createState(8, 8, [193, 71, 117, 0]);
        state.layers[0].visible = visible;
        const doc = new PaintDocument(state),
            original = cloneState(state);
        doc.editMetadata('redo', { kind: 'layer-name', layer: 0, name: 'redo name' });
        doc.undo();
        doc.beginStroke(3, 3, { ...square, color: [0, 0, 0, 0] });
        assert.equal(doc.stroke!.tiles.size, 0);
        doc.endStroke(5, 4);
        assert.deepEqual(doc.state.layers[0].pixels, original.layers[0].pixels);
        assert.equal(doc.state.layers[0].visible, true);
        assert.equal(doc.dirty, !visible);
        if (visible) {
            assert.equal(doc.canUndo, false);
            assert.equal(doc.canRedo, true);
        } else {
            assert.equal(doc.history.length, 1);
            assert.equal(doc.history[0].bytes, 0);
            doc.undo();
            assert.deepEqual(doc.state, original);
        }
    }
});
