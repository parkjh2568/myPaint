import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    PaintDocument,
    createState,
    cloneState,
    type BrushSettings,
    type Color,
} from '../src/engine/document';

const foreground: Color = [231, 19, 41, 255],
    target: Color = [17, 91, 203, 96],
    settings: BrushSettings = {
        color: target,
        matchColor: foreground,
        size: 4,
        opacity: 0,
        hardness: 0,
        stabilization: 75,
        eraser: true,
        pressure: true,
        square: true,
        pixel: true,
        dabsOnly: true,
    };

test('color eraser uses an integer hard capsule and ignores brush coverage options', () => {
    const doc = new PaintDocument(createState(12, 9, foreground)),
        original = cloneState(doc.state);
    doc.beginStroke(2.9, 4.9, settings, 0);
    doc.moveStroke(5.9, 4.9, 0.1);
    doc.endStroke(8.9, 4.9);
    const spans = new Map([
        [2, [2, 8]],
        [3, [1, 9]],
        [4, [0, 10]],
        [5, [1, 9]],
        [6, [2, 8]],
    ]);
    for (let y = 0; y < 9; y++)
        for (let x = 0; x < 12; x++) {
            const span = spans.get(y),
                expected = span && x >= span[0] && x <= span[1] ? target : foreground;
            assert.deepEqual(
                Array.from(doc.state.layers[0].pixels.subarray((y * 12 + x) * 4, (y * 12 + x + 1) * 4)),
                expected,
                `${x},${y}`,
            );
        }
    const drawn = cloneState(doc.state);
    assert.equal(doc.history.length, 1);
    doc.undo();
    assert.deepEqual(doc.state, original);
    doc.redo();
    assert.deepEqual(doc.state, drawn);
});

test('color eraser keeps the key and target captured at stroke start', () => {
    const key: [number, number, number, number] = [...foreground],
        replacement: [number, number, number, number] = [...target],
        doc = new PaintDocument(createState(12, 9, foreground));
    doc.beginStroke(2, 4, { ...settings, matchColor: key, color: replacement });
    key.fill(0);
    replacement.fill(255);
    doc.endStroke(8, 4);
    assert.deepEqual(
        Array.from(doc.state.layers[0].pixels.subarray((4 * 12 + 8) * 4, (4 * 12 + 9) * 4)),
        target,
    );
});

test('color eraser matches premultiplied bytes including alpha and preserves unrelated raw RGB', () => {
    const state = createState(5, 1, [10, 20, 30, 1]),
        pixels = state.layers[0].pixels;
    pixels.set([1, 2, 3, 1], 4);
    pixels.set([200, 201, 202, 1], 8);
    pixels.set([10, 20, 30, 2], 12);
    pixels.set([193, 71, 117, 0], 16);
    const doc = new PaintDocument(state),
        original = pixels.slice();
    doc.beginStroke(0, 0, { ...settings, size: 1, matchColor: [10, 20, 30, 1] });
    doc.endStroke(4, 0);
    assert.deepEqual(Array.from(pixels.subarray(0, 4)), target);
    assert.deepEqual(Array.from(pixels.subarray(4, 8)), target);
    assert.deepEqual(pixels.subarray(8), original.subarray(8));
    doc.undo();
    assert.deepEqual(pixels, original);
});

test('transparent-key replacement is local and retains hidden RGB outside its disk', () => {
    const state = createState(7, 5, [193, 71, 117, 0]),
        doc = new PaintDocument(state),
        pixels = state.layers[0].pixels,
        original = pixels.slice(),
        marked = new Set(['3,1', '2,2', '3,2', '4,2', '3,3']);
    doc.beginStroke(3.9, 2.9, { ...settings, size: 2, matchColor: [22, 99, 7, 0] });
    doc.endStroke(3.9, 2.9);
    for (let y = 0; y < 5; y++)
        for (let x = 0; x < 7; x++)
            assert.deepEqual(
                Array.from(pixels.subarray((y * 7 + x) * 4, (y * 7 + x + 1) * 4)),
                marked.has(`${x},${y}`) ? target : [193, 71, 117, 0],
            );
    doc.undo();
    assert.deepEqual(pixels, original);
});

test('color eraser no-match and identical target preserve a visible document history and saved revision', () => {
    for (const change of [{ matchColor: [0, 0, 0, 255] as Color }, { color: foreground }]) {
        const doc = new PaintDocument(createState(12, 9, foreground)),
            original = cloneState(doc.state),
            revision = doc.revision;
        doc.beginStroke(2, 4, { ...settings, ...change });
        doc.endStroke(8, 4);
        assert.deepEqual(doc.state, original);
        assert.equal(doc.history.length, 0);
        assert.equal(doc.revision, revision);
        assert.equal(doc.dirty, false);
    }
});

test('color eraser cancel restores pixels, hidden visibility and a pre-existing Redo branch', () => {
    const state = createState(12, 9, foreground);
    state.layers[0].visible = false;
    const doc = new PaintDocument(state);
    doc.editMetadata('name', { kind: 'layer-name', layer: 0, name: 'redo-name' });
    doc.undo();
    const original = cloneState(doc.state),
        revision = doc.revision;
    doc.beginStroke(2, 4, settings);
    doc.moveStroke(8, 4);
    assert.equal(doc.state.layers[0].visible, true);
    assert.notDeepEqual(doc.state.layers[0].pixels, original.layers[0].pixels);
    doc.cancelStroke();
    assert.deepEqual(doc.state, original);
    assert.equal(doc.revision, revision);
    assert.equal(doc.canRedo, true);
    doc.redo();
    assert.equal(doc.state.layers[0].name, 'redo-name');
});

test('a committed color eraser gesture exposes a hidden active layer even without a color match', () => {
    const state = createState(12, 9, foreground);
    state.layers[0].visible = false;
    const doc = new PaintDocument(state),
        original = cloneState(state);
    doc.beginStroke(2, 4, { ...settings, matchColor: [0, 0, 0, 255] });
    doc.endStroke(8, 4);
    assert.equal(doc.state.layers[0].visible, true);
    assert.equal(doc.history.length, 1);
    assert.deepEqual(doc.state.layers[0].pixels, original.layers[0].pixels);
    doc.undo();
    assert.deepEqual(doc.state, original);
    doc.redo();
    assert.equal(doc.state.layers[0].visible, true);
});

test('invalid replacement colors reject before opening a stroke or changing visibility', () => {
    for (const bad of [
        [0, 0, 0, NaN],
        [0, 0, 0, 256],
        [-1, 0, 0, 255],
        [0, 0, 0.5, 255],
    ])
        for (const property of ['color', 'matchColor']) {
            const state = createState(12, 9, foreground);
            state.layers[0].visible = false;
            const doc = new PaintDocument(state),
                original = cloneState(state);
            assert.throws(() => doc.beginStroke(2, 4, { ...settings, [property]: bad }));
            assert.deepEqual(doc.state, original);
            assert.equal(doc.stroke, undefined);
            assert.equal(doc.history.length, 0);
        }
});
