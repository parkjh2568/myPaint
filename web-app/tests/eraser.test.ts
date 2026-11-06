import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaintDocument, createState, cloneState, type BrushSettings } from '../src/engine/document';

const transparentEraser: BrushSettings = {
    color: [0, 0, 0, 0],
    size: 4,
    opacity: 1,
    hardness: 1,
    stabilization: 0,
    pressure: false,
    eraser: true,
};

test('erasing already transparent pixels preserves hidden RGB, saved state and Redo without pixel allocation', () => {
    const doc = new PaintDocument(createState(8, 8, [193, 71, 117, 0]));
    doc.editMetadata('rename', { kind: 'layer-name', layer: 0, name: 'redo name' });
    doc.undo();
    const original = cloneState(doc.state),
        revision = doc.revision,
        history = [...doc.history];
    doc.beginStroke(2, 3, transparentEraser);
    doc.moveStroke(6, 3);
    assert.equal(doc.stroke?.tiles.size, 0);
    assert.equal(doc.stroke?.dirty.size, 0);
    doc.endStroke(6, 3);
    assert.deepEqual(doc.state, original);
    assert.equal(doc.revision, revision);
    assert.equal(doc.dirty, false);
    assert.deepEqual(doc.history, history);
    assert.equal(doc.canRedo, true);
    doc.redo();
    assert.equal(doc.state.layers[0].name, 'redo name');
});

test('transparent erasing exposes a hidden layer only through metadata history and cancels exactly', () => {
    const state = createState(8, 8, [193, 71, 117, 0]);
    state.layers[0].visible = false;
    const doc = new PaintDocument(state),
        original = cloneState(state);
    doc.beginStroke(2, 3, transparentEraser);
    doc.endStroke(6, 3);
    assert.equal(doc.state.layers[0].visible, true);
    assert.deepEqual(doc.state.layers[0].pixels, original.layers[0].pixels);
    assert.equal(doc.history.length, 1);
    assert.equal(doc.history[0].bytes, 0);
    doc.undo();
    assert.deepEqual(doc.state, original);
    doc.beginStroke(2, 3, transparentEraser);
    doc.cancelStroke();
    assert.deepEqual(doc.state, original);
    assert.equal(doc.dirty, false);
    assert.equal(doc.canRedo, true);
    doc.redo();
    assert.equal(doc.state.layers[0].visible, true);
    assert.deepEqual(doc.state.layers[0].pixels, original.layers[0].pixels);
});

test('eraser coverage still finishes a low-alpha pixel that rounded to transparent earlier in the stroke', () => {
    const doc = new PaintDocument(createState(8, 8, [193, 71, 117, 0])),
        at = (4 * 8 + 4) * 4;
    doc.state.layers[0].pixels.set([17, 91, 203, 1], at);
    const original = cloneState(doc.state);
    doc.beginStroke(2.3, 4.5, transparentEraser);
    assert.deepEqual(Array.from(doc.state.layers[0].pixels.slice(at, at + 4)), [17, 91, 203, 0]);
    doc.moveStroke(4.5, 4.5, 1, true);
    doc.endStroke(4.5, 4.5);
    assert.deepEqual(Array.from(doc.state.layers[0].pixels.slice(at, at + 4)), [0, 0, 0, 0]);
    for (let i = 0; i < doc.state.layers[0].pixels.length; i++)
        if (i < at || i >= at + 4) assert.equal(doc.state.layers[0].pixels[i], original.layers[0].pixels[i]);
    assert.equal(doc.history.length, 1);
    const erased = cloneState(doc.state);
    doc.undo();
    assert.deepEqual(doc.state, original);
    doc.redo();
    assert.deepEqual(doc.state, erased);
});
