import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    PaintDocument,
    createState,
    cloneState,
    composite,
    validateSize,
    type BrushSettings,
} from '../src/engine/document';
import { encodePng, decodePng, encodeProject, decodeProject } from '../src/engine/format';
const brush: BrushSettings = {
    color: [255, 0, 0, 255],
    size: 10,
    opacity: 0.5,
    hardness: 1,
    stabilization: 25,
    eraser: false,
    pressure: false,
};
test('PNG and project preserve alpha and UTF8 layers', () => {
    const s = createState(32, 20, [0, 0, 0, 0]);
    s.layers[0].name = '한글 레이어';
    s.layers[0].pixels.set([33, 72, 195, 128], 120);
    s.layers.push({ ...s.layers[0], visible: false, pixels: s.layers[0].pixels.slice() });
    const p = decodePng(encodePng(s.width, s.height, s.layers[0].pixels));
    assert.deepEqual(p.pixels, s.layers[0].pixels);
    assert.deepEqual(decodeProject(encodeProject(s)), s);
});
test('stroke overlap opacity, endpoints, undo redo and cancellation', () => {
    const d = new PaintDocument(createState(100, 60, [0, 0, 0, 0]));
    d.beginStroke(10, 20, brush);
    d.moveStroke(80, 20);
    d.moveStroke(10, 20);
    d.endStroke(80, 20);
    const result = cloneState(d.state);
    assert.equal(d.state.layers[0].pixels[(20 * 100 + 40) * 4 + 3], 128);
    assert(d.dirty);
    d.undo();
    assert(d.state.layers[0].pixels.every((v) => v === 0));
    d.redo();
    assert.deepEqual(d.state, result);
    const revision = d.revision;
    d.beginStroke(10, 40, brush);
    d.moveStroke(80, 40);
    d.cancelStroke();
    assert.deepEqual(d.state, result);
    assert.equal(d.revision, revision);
});
test('save revision remains unique across branch and failed edit preserves redo', () => {
    const d = new PaintDocument();
    d.beginStroke(10, 10, brush);
    d.endStroke(30, 10);
    d.markSaved(d.revision);
    d.beginStroke(10, 30, brush);
    d.endStroke(30, 30);
    d.undo();
    assert(!d.dirty);
    const previous = cloneState(d.state);
    assert.throws(() =>
        d.edit('invalid', (s) => {
            s.width = 0;
        }),
    );
    assert(d.canRedo);
    assert.deepEqual(d.state, previous);
    d.beginStroke(10, 40, brush);
    d.endStroke(30, 40);
    assert(d.dirty);
    assert(!d.canRedo);
});
test('structural history does not share mutable stroke pixels', () => {
    const d = new PaintDocument(createState(50, 40));
    d.edit('layer', (s) => {
        s.layers.push({ name: 'new', visible: true, pixels: new Uint8ClampedArray(50 * 40 * 4) });
        s.active = 1;
    });
    const blank = cloneState(d.state);
    d.beginStroke(10, 10, brush);
    d.endStroke(30, 10);
    d.undo();
    assert.deepEqual(d.state, blank);
    d.undo();
    assert.equal(d.state.layers.length, 1);
    d.redo();
    assert.deepEqual(d.state, blank);
});
test('malformed and excessive data rejected before replacement', () => {
    assert.throws(() => validateSize(4096, 4096));
    const p = encodeProject(createState(5, 5));
    assert.throws(() => decodeProject(p.subarray(0, p.length - 1)));
    const extra = new Uint8Array(p.length + 1);
    extra.set(p);
    assert.throws(() => decodeProject(extra));
    const bad = p.slice();
    new DataView(bad.buffer).setUint32(8, 0xffffffff, true);
    assert.throws(() => decodeProject(bad));
    const png = encodePng(5, 5, new Uint8ClampedArray(100));
    png[40] ^= 1;
    assert.throws(() => decodePng(png));
});
test('alpha compositing keeps hidden layers out', () => {
    const s = createState(1, 1);
    s.layers.push({ name: 'ink', visible: true, pixels: Uint8ClampedArray.of(255, 0, 0, 128) });
    assert.deepEqual([...composite(s)], [255, 127, 127, 255]);
    s.layers[1].visible = false;
    assert.deepEqual([...composite(s)], [255, 255, 255, 255]);
});
test('native Qt project preserves exact premultiplied channels and raw PNG roundtrip', async () => {
    const { readFile } = await import('node:fs/promises');
    const fixture = JSON.parse(
        await readFile(new URL('./fixtures/qt-project.json', import.meta.url), 'utf8'),
    );
    const state = decodeProject(Buffer.from(fixture.projectBase64, 'base64'));
    assert.equal(state.active, 1);
    assert.deepEqual(state.background, [0, 0, 0, 0]);
    assert.equal(state.layers[1].name, '반투명 레이어');
    for (let i = 0; i < 2; i++) {
        const actual = state.layers[i].pixels,
            expected = Buffer.from(fixture.rgbaBase64[i], 'base64');
        for (let p = 0; p < actual.length; p += 4) {
            assert.equal(actual[p + 3], expected[p + 3]);
            for (let c = 0; c < 3; c++)
                assert.equal(
                    Math.round((actual[p + c] * actual[p + 3]) / 255),
                    Math.round((expected[p + c] * expected[p + 3]) / 255),
                );
        }
    }
    assert.deepEqual(decodeProject(encodeProject(state)), state);
});

test('prepared edits stay pending and reject another document revision', () => {
    const d = new PaintDocument(createState(12, 12));
    const old = cloneState(d.state),
        next = cloneState(d.state);
    next.layers[0].name = 'prepared';
    const prepared = d.prepareState('prepared', next)!;
    assert.deepEqual(d.state, old);
    assert.equal(d.canUndo, false);
    d.edit('other', (s) => {
        s.layers[0].name = 'other';
    });
    const current = cloneState(d.state);
    assert.throws(() => d.installPrepared(prepared));
    assert.deepEqual(d.state, current);
});
test('fill spans respect enclosed regions, alpha and no-op', async () => {
    const { flood } = await import('../src/engine/operations');
    const s = createState(11, 9, [0, 0, 0, 0]),
        pixels = s.layers[0].pixels;
    for (let y = 2; y <= 6; y++)
        for (let x = 3; x <= 7; x++)
            if (x === 3 || x === 7 || y === 2 || y === 6) pixels.set([1, 2, 3, 255], (y * 11 + x) * 4);
    const result = flood(pixels, 11, 9, 4, 3, [255, 0, 0, 128])!;
    assert.deepEqual([result.left, result.top, result.width, result.height], [4, 3, 3, 3]);
    for (let i = 0; i < result.pixels.length; i += 4)
        assert.deepEqual([...result.pixels.subarray(i, i + 4)], [255, 0, 0, 128]);
    assert(pixels[(3 * 11 + 4) * 4 + 3] === 0);
    assert.equal(flood(pixels, 11, 9, 3, 2, [1, 2, 3, 255]), undefined);
    const outside = flood(pixels, 11, 9, 0, 0, [0, 255, 0, 255])!;
    assert.equal(outside.pixels[(3 * 11 + 4) * 4 + 3], 0);
    assert.equal(outside.pixels[3], 255);
});

test('candidate equality handles unaligned RGBA and does not miss the last channel', () => {
    const d = new PaintDocument(createState(8, 8));
    const candidate = cloneState(d.state),
        backing = new Uint8ClampedArray(8 * 8 * 4 + 1);
    backing.set(candidate.layers[0].pixels, 1);
    candidate.layers[0].pixels = backing.subarray(1);
    assert.equal(d.prepareState('same', candidate), undefined);
    assert.equal(d.canUndo, false);
    candidate.layers[0].pixels[candidate.layers[0].pixels.length - 1] = 127;
    const prepared = d.prepareState('alpha', candidate)!;
    d.installPrepared(prepared);
    assert.equal(d.state.layers[0].pixels.at(-1), 127);
    d.undo();
    assert.equal(d.state.layers[0].pixels.at(-1), 255);
});

test('large finite outside input stays bounded and does not reveal a hidden layer', () => {
    const state = createState(16, 16, [0, 0, 0, 0]);
    state.layers[0].visible = false;
    const d = new PaintDocument(state);
    d.beginStroke(Number.MAX_VALUE, -Number.MAX_VALUE, { ...brush, size: 1 });
    assert(Number.isFinite(d.stroke!.x));
    assert(d.stroke!.x <= 8192);
    assert(d.stroke!.y >= -4096);
    d.endStroke(Number.MAX_VALUE, -Number.MAX_VALUE);
    assert.equal(d.canUndo, false);
    assert.equal(d.state.layers[0].visible, false);
    assert(d.state.layers[0].pixels.every((v) => v === 0));
});
