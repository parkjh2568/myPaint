import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEraserPreferences, eraserColor } from '../src/ui/eraser';
import { createState, PaintDocument, cloneState } from '../src/engine/document';
import { encodeProject, decodeProject } from '../src/engine/format';

test('eraser preferences default safely and round-trip independently of document metadata', () => {
    for (const input of [null, undefined, 1, '', {}, { mode: 'bad', background: '#gggggg' }])
        assert.deepEqual(readEraserPreferences(input), { mode: 'transparent', background: '#ffffff' });
    const prefs = readEraserPreferences({ mode: 'background', background: '#AB12EF' });
    assert.deepEqual(readEraserPreferences(JSON.parse(JSON.stringify(prefs))), prefs);
    assert.deepEqual(eraserColor(prefs), [171, 18, 239, 255]);
});
for (const layers of [1, 2])
    for (const square of [false, true])
        for (const mode of ['transparent', 'background'])
            test(`explicit eraser ${mode}, ${layers} layers, square=${square}: pixels, cancel, undo/redo, alpha`, () => {
                const state = createState(16, 16, [10, 20, 30, 255]);
                if (layers === 2)
                    state.layers.push({ ...state.layers[0], pixels: state.layers[0].pixels.slice() });
                state.active = layers - 1;
                const doc = new PaintDocument(state),
                    original = cloneState(state);
                const color = eraserColor(readEraserPreferences({ mode, background: '#aa55ff' }));
                const settings = {
                    color,
                    size: 4,
                    opacity: 1,
                    hardness: 1,
                    stabilization: 0,
                    pressure: false,
                    eraser: true,
                    square,
                };
                doc.beginStroke(8, 8, settings);
                doc.cancelStroke();
                assert.deepEqual(doc.state, original);
                doc.beginStroke(8, 8, settings);
                doc.endStroke(8, 8);
                const changed = cloneState(doc.state),
                    i = (8 * 16 + 8) * 4;
                assert.deepEqual(Array.from(changed.layers[changed.active].pixels.slice(i, i + 4)), color);
                assert.deepEqual(changed.background, original.background);
                if (layers === 2) assert.deepEqual(changed.layers[0], original.layers[0]);
                doc.undo();
                assert.deepEqual(doc.state, original);
                doc.redo();
                assert.deepEqual(doc.state, changed);
                assert.deepEqual(decodeProject(encodeProject(doc.state)), changed);
            });
