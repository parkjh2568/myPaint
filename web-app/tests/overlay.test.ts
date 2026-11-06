import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaintDocument, createState, cloneState, type BrushSettings } from '../src/engine/document';

test('an empty source-over preserves hidden RGB, saved state and an existing Redo branch', () => {
    const doc = new PaintDocument(createState(4, 4, [193, 71, 117, 0]));
    doc.editMetadata('name', { kind: 'layer-name', layer: 0, name: 'redo name' });
    doc.undo();
    const before = cloneState(doc.state),
        revision = doc.revision,
        history = [...doc.history];
    doc.replacePixels('empty overlay', 0, 0, 0, 4, 4, new Uint8ClampedArray(64), true);
    assert.deepEqual(doc.state, before);
    assert.equal(doc.revision, revision);
    assert.equal(doc.dirty, false);
    assert.deepEqual(doc.history, history);
    assert.equal(doc.canRedo, true);
    doc.redo();
    assert.equal(doc.state.layers[0].name, 'redo name');
});

test('mixed source-over preserves untouched RGBA and composites visible ink with one Undo', () => {
    const state = createState(4, 1, [193, 71, 117, 0]);
    state.layers[0].pixels.set([20, 40, 60, 128], 4);
    state.layers[0].pixels.set([0, 0, 0, 0], 8);
    state.layers[0].pixels.set([0, 0, 255, 128], 12);
    const doc = new PaintDocument(state),
        before = cloneState(state),
        input = Uint8ClampedArray.of(1, 2, 3, 0, 255, 0, 0, 0, 17, 91, 203, 96, 255, 0, 0, 128),
        originalInput = input.slice();
    doc.replacePixels('ink', 0, 0, 0, 4, 1, input, true);
    assert.deepEqual(
        Array.from(state.layers[0].pixels),
        [193, 71, 117, 0, 20, 40, 60, 128, 17, 91, 203, 96, 170, 0, 85, 192],
    );
    assert.deepEqual(input, originalInput);
    assert.equal(doc.history.length, 1);
    const painted = cloneState(state);
    doc.undo();
    assert.deepEqual(doc.state, before);
    doc.redo();
    assert.deepEqual(doc.state, painted);
});

test('clipped transparent source-over retains raw destination pixels and hidden visibility history', () => {
    const state = createState(3, 1, [193, 71, 117, 0]);
    state.layers[0].visible = false;
    const doc = new PaintDocument(state),
        before = cloneState(state),
        input = Uint8ClampedArray.of(255, 0, 0, 255, 1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0);
    doc.replacePixels('overlay', 0, -1, 0, 4, 1, input, true);
    assert.deepEqual(state.layers[0].pixels, before.layers[0].pixels);
    assert.equal(state.layers[0].visible, true);
    assert.equal(doc.history.length, 1);
    doc.undo();
    assert.deepEqual(doc.state, before);
});

test('explicit pixel replacement still writes transparent source RGB', () => {
    const doc = new PaintDocument(createState(2, 1, [193, 71, 117, 0])),
        before = cloneState(doc.state),
        input = Uint8ClampedArray.of(1, 2, 3, 0, 4, 5, 6, 0);
    doc.replacePixels('replace', 0, 0, 0, 2, 1, input);
    assert.deepEqual(doc.state.layers[0].pixels, input);
    doc.undo();
    assert.deepEqual(doc.state, before);
});

const transparentBrush: BrushSettings = {
    color: [17, 91, 203, 0],
    size: 4,
    opacity: 1,
    hardness: 1,
    stabilization: 0,
    eraser: false,
    pressure: false,
};

test('transparent normal ink leaves raw pixels and an existing Redo untouched', () => {
    const doc = new PaintDocument(createState(8, 8, [193, 71, 117, 0]));
    doc.state.layers[0].pixels.set([20, 40, 60, 128], (3 * 8 + 3) * 4);
    doc.editMetadata('name', { kind: 'layer-name', layer: 0, name: 'redo name' });
    doc.undo();
    const original = cloneState(doc.state),
        revision = doc.revision;
    doc.beginStroke(2, 3, transparentBrush);
    doc.moveStroke(6, 3);
    doc.endStroke(6, 3);
    assert.deepEqual(doc.state, original);
    assert.equal(doc.revision, revision);
    assert.equal(doc.dirty, false);
    assert.equal(doc.cursor, 0);
    assert.equal(doc.canRedo, true);
});

test('invisible ink exposes a hidden active layer through metadata history and cancels exactly', () => {
    for (const brush of [
        transparentBrush,
        { ...transparentBrush, color: [255, 0, 0, 255] as const, opacity: 0 },
    ]) {
        const state = createState(8, 8, [193, 71, 117, 0]);
        state.layers[0].visible = false;
        const doc = new PaintDocument(state),
            original = cloneState(state);
        doc.beginStroke(2, 3, brush);
        doc.endStroke(6, 3);
        assert.equal(doc.state.layers[0].visible, true);
        assert.deepEqual(doc.state.layers[0].pixels, original.layers[0].pixels);
        assert.equal(doc.history.length, 1);
        assert.equal(doc.history[0].bytes, 0);
        doc.undo();
        assert.deepEqual(doc.state, original);
        doc.beginStroke(2, 3, brush);
        doc.cancelStroke();
        assert.deepEqual(doc.state, original);
        assert.equal(doc.dirty, false);
        assert.equal(doc.canRedo, true);
        doc.redo();
        assert.equal(doc.state.layers[0].visible, true);
        assert.deepEqual(doc.state.layers[0].pixels, original.layers[0].pixels);
    }
});

test('transparent eraser targets still remove opaque pixels', () => {
    const doc = new PaintDocument(createState(8, 8, [193, 71, 117, 255]));
    doc.beginStroke(3, 3, { ...transparentBrush, color: [0, 0, 0, 0], size: 1, eraser: true, pixel: true });
    doc.endStroke(3, 3);
    assert.deepEqual(
        Array.from(doc.state.layers[0].pixels.subarray((3 * 8 + 3) * 4, (3 * 8 + 4) * 4)),
        [0, 0, 0, 0],
    );
    assert.equal(doc.history.length, 1);
    doc.undo();
    assert.deepEqual(
        Array.from(doc.state.layers[0].pixels.subarray((3 * 8 + 3) * 4, (3 * 8 + 4) * 4)),
        [193, 71, 117, 255],
    );
});

test('an entirely outside no-ink gesture preserves hidden state and Redo', () => {
    for (const matchColor of [undefined, [193, 71, 117, 0] as const]) {
        const state = createState(8, 8, [193, 71, 117, 0]);
        state.layers[0].visible = false;
        const doc = new PaintDocument(state);
        doc.editMetadata('name', { kind: 'layer-name', layer: 0, name: 'redo name' });
        doc.undo();
        const original = cloneState(doc.state);
        doc.beginStroke(Number.MAX_VALUE, -Number.MAX_VALUE, { ...transparentBrush, matchColor });
        doc.endStroke(Number.MAX_VALUE, -Number.MAX_VALUE);
        assert.deepEqual(doc.state, original);
        assert.equal(doc.dirty, false);
        assert.equal(doc.canUndo, false);
        assert.equal(doc.canRedo, true);
    }
});

test('an inside sample keeps no-ink visibility history when the gesture ends outside', () => {
    const state = createState(8, 8, [193, 71, 117, 0]);
    state.layers[0].visible = false;
    const doc = new PaintDocument(state),
        original = cloneState(state);
    doc.beginStroke(-20, -20, transparentBrush);
    doc.moveStroke(3, 3);
    doc.endStroke(20, 20);
    assert.equal(doc.state.layers[0].visible, true);
    assert.deepEqual(doc.state.layers[0].pixels, original.layers[0].pixels);
    assert.equal(doc.history.length, 1);
    assert.equal(doc.history[0].bytes, 0);
    doc.undo();
    assert.deepEqual(doc.state, original);
    doc.redo();
    assert.equal(doc.state.layers[0].visible, true);
});
