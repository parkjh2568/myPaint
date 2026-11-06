import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaintDocument, createState, cloneState, type BrushSettings } from '../src/engine/document';
const pencil: BrushSettings = {
    color: [255, 0, 0, 255],
    size: 1,
    opacity: 1,
    hardness: 1,
    stabilization: 0,
    eraser: false,
    pressure: false,
    square: true,
    pixel: true,
};
test('one pixel pencil stamps the containing pixel at integer and fractional coordinates', () => {
    for (const [x, y] of [
        [10, 10],
        [10.2, 10.8],
    ]) {
        const doc = new PaintDocument(createState(24, 24, [0, 0, 0, 0]));
        doc.beginStroke(x, y, pencil);
        doc.endStroke(x, y);
        const painted: [number, number, number][] = [];
        for (let yy = 0; yy < 24; yy++)
            for (let xx = 0; xx < 24; xx++) {
                const alpha = doc.state.layers[0].pixels[(yy * 24 + xx) * 4 + 3];
                if (alpha) painted.push([xx, yy, alpha]);
            }
        assert.deepEqual(painted, [[10, 10, 255]]);
    }
});
test('pixel pencil connects horizontal and diagonal endpoints without adjacent antialias pixels', () => {
    for (const diagonal of [false, true]) {
        const doc = new PaintDocument(createState(20, 20, [0, 0, 0, 0]));
        doc.beginStroke(2, diagonal ? 2 : 4, pencil);
        doc.moveStroke(12, diagonal ? 12 : 4);
        doc.endStroke(12, diagonal ? 12 : 4);
        for (let y = 0; y < 20; y++)
            for (let x = 0; x < 20; x++) {
                const expected = x >= 2 && x <= 12 && y === (diagonal ? x : 4) ? 255 : 0;
                assert.equal(doc.state.layers[0].pixels[(y * 20 + x) * 4 + 3], expected, `${x},${y}`);
            }
    }
});
test('pixel pencil clips outside input and keeps one history operation per stroke', () => {
    const doc = new PaintDocument(createState(12, 12, [0, 0, 0, 0]));
    doc.beginStroke(-3, 4, pencil);
    doc.moveStroke(4, 4);
    doc.endStroke(4, 4);
    for (let x = 0; x < 12; x++)
        assert.equal(doc.state.layers[0].pixels[(4 * 12 + x) * 4 + 3], x <= 4 ? 255 : 0);
    const drawn = cloneState(doc.state);
    doc.undo();
    assert(doc.state.layers[0].pixels.every((value) => value === 0));
    doc.redo();
    assert.deepEqual(doc.state, drawn);
    const revision = doc.revision;
    doc.beginStroke(2, 7, pencil);
    doc.moveStroke(8, 7);
    doc.cancelStroke();
    assert.deepEqual(doc.state, drawn);
    assert.equal(doc.revision, revision);
});
test('pixel pencil overlapping passes keep maximum opacity within one stroke', () => {
    const doc = new PaintDocument(createState(20, 12, [0, 0, 0, 0]));
    const translucent = { ...pencil, opacity: 0.5 };
    doc.beginStroke(2, 4, translucent);
    doc.moveStroke(12, 4);
    doc.moveStroke(2, 4);
    doc.endStroke(12, 4);
    for (let x = 2; x <= 12; x++) assert.equal(doc.state.layers[0].pixels[(4 * 20 + x) * 4 + 3], 128);
});
test('independent spray dabs do not interpolate a line between distant random positions', () => {
    const doc = new PaintDocument(createState(48, 16, [0, 0, 0, 0]));
    doc.beginStroke(4.5, 8.5, { ...pencil, pixel: false, dabsOnly: true });
    doc.moveStroke(40.5, 8.5, 1, true);
    doc.endStroke(40.5, 8.5);
    const image = doc.state.layers[0].pixels;
    assert(image[(8 * 48 + 4) * 4 + 3] > 0);
    assert(image[(8 * 48 + 40) * 4 + 3] > 0);
    for (let x = 8; x <= 36; x++)
        assert.equal(image[(8 * 48 + x) * 4 + 3], 0, `unexpected connecting dot at ${x}`);
});
