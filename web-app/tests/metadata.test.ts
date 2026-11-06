import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PaintDocument,
    cloneState,
    createState,
    type MetadataChange,
    type Color,
    type State,
} from '../src/engine/document';
import { resizeState } from '../src/engine/operations';
function layered(): PaintDocument {
    const state = createState(3, 2, [0, 0, 0, 0]);
    state.layers = [11, 22, 33].map((red, index) => ({
        name: `layer-${index}`,
        visible: index !== 1,
        pixels: Uint8ClampedArray.from({ length: 24 }, (_, position) =>
            position % 4 === 0 ? red : position % 4 === 3 ? 255 : 0,
        ),
    }));
    return new PaintDocument(state);
}
test('metadata history owns no pixel buffers and keeps active document arrays', () => {
    const document = layered(),
        pixels = document.state.layers.map((layer) => layer.pixels),
        background: [number, number, number, number] = [4, 8, 12, 16];
    document.editMetadata('rename', { kind: 'layer-name', layer: 0, name: 'renamed' });
    document.editMetadata('visibility', { kind: 'layer-visible', layer: 1, visible: true });
    document.editMetadata('background', { kind: 'background', background });
    background[0] = 200;
    assert.deepEqual(document.state.background, [4, 8, 12, 16]);
    for (const change of document.history) {
        assert.equal(change.before, undefined);
        assert.equal(change.after, undefined);
        assert.equal(change.tiles, undefined);
        const visit = (value: unknown): void => {
            assert(!ArrayBuffer.isView(value));
            assert(!(value instanceof ArrayBuffer));
            if (value && typeof value === 'object') for (const item of Object.values(value)) visit(item);
        };
        visit(change.metadata);
    }
    assert(document.historyBytes > 0 && document.historyBytes < 4096);
    for (let index = 0; index < 3; index++) assert.equal(document.state.layers[index].pixels, pixels[index]);
    document.undo();
    document.undo();
    document.undo();
    assert.deepEqual(document.state, layered().state);
    for (let index = 0; index < 3; index++) assert.equal(document.state.layers[index].pixels, pixels[index]);
    document.redo();
    document.redo();
    document.redo();
    assert.equal(document.state.layers[0].name, 'renamed');
    assert.equal(document.state.layers[1].visible, true);
    assert.deepEqual(document.state.background, [4, 8, 12, 16]);
});
test('forward and inverse permutations move pixels, metadata and active layer together', () => {
    const document = layered(),
        original = cloneState(document.state),
        pixels = document.state.layers.map((layer) => layer.pixels);
    document.editMetadata('move', { kind: 'layer-reorder', layer: 0, to: 2 });
    assert.deepEqual(
        document.state.layers.map((layer) => layer.name),
        ['layer-1', 'layer-2', 'layer-0'],
    );
    assert.equal(document.state.active, 2);
    assert.equal(document.state.layers[2].pixels, pixels[0]);
    const moved = cloneState(document.state);
    document.undo();
    assert.deepEqual(document.state, original);
    assert.equal(document.state.layers[0].pixels, pixels[0]);
    document.redo();
    assert.deepEqual(document.state, moved);
    document.editMetadata('move back', { kind: 'layer-reorder', layer: 2, to: 0 });
    assert.deepEqual(document.state, original);
    document.undo();
    assert.deepEqual(document.state, moved);
});
test('metadata, pixel patches and structural snapshots replay in both directions', () => {
    const document = layered(),
        states: State[] = [cloneState(document.state)];
    document.editMetadata('rename', { kind: 'layer-name', layer: 0, name: 'ink' });
    states.push(cloneState(document.state));
    document.editMetadata('reorder', { kind: 'layer-reorder', layer: 0, to: 2 });
    states.push(cloneState(document.state));
    document.replacePixels('pixel', document.state.active, 1, 0, 1, 1, Uint8ClampedArray.of(90, 80, 70, 128));
    states.push(cloneState(document.state));
    document.edit('structural resize', (state) => resizeState(state, 4, 2));
    states.push(cloneState(document.state));
    document.editMetadata('hide resized', { kind: 'layer-visible', layer: 2, visible: false });
    states.push(cloneState(document.state));
    for (let index = states.length - 2; index >= 0; index--) {
        document.undo();
        assert.deepEqual(document.state, states[index], `undo state ${index}`);
    }
    for (let index = 1; index < states.length; index++) {
        document.redo();
        assert.deepEqual(document.state, states[index], `redo state ${index}`);
    }
});
test('no-op and failed metadata changes preserve redo, saved identity and state', () => {
    const document = layered();
    document.editMetadata('rename', { kind: 'layer-name', layer: 0, name: 'new' });
    document.undo();
    const before = cloneState(document.state),
        revision = document.revision,
        nextRevision = document.nextRevision,
        history = document.history,
        bytes = document.historyBytes;
    const unchanged: MetadataChange[] = [
        { kind: 'layer-name', layer: 0, name: 'layer-0' },
        { kind: 'layer-visible', layer: 1, visible: false },
        { kind: 'background', background: [0, 0, 0, 0] },
        { kind: 'layer-reorder', layer: 2, to: 2 },
    ];
    for (const change of unchanged) document.editMetadata('same', change);
    const invalid: MetadataChange[] = [
        { kind: 'layer-name', layer: -1, name: 'bad' },
        { kind: 'layer-name', layer: 0, name: 'x'.repeat(257) },
        { kind: 'layer-name', layer: 0, name: '\ud800' },
        { kind: 'layer-visible', layer: 0, visible: 'yes' as unknown as boolean },
        { kind: 'background', background: [0, 0, 0, Number.NaN] },
        { kind: 'layer-reorder', layer: 0, to: 3 },
        { kind: 'layer-reorder', layer: 0.5, to: 1 },
        { kind: 'missing' } as unknown as MetadataChange,
    ];
    for (const change of invalid) assert.throws(() => document.editMetadata('bad', change));
    assert.deepEqual(document.state, before);
    assert.equal(document.revision, revision);
    assert.equal(document.nextRevision, nextRevision);
    assert.equal(document.history, history);
    assert.equal(document.historyBytes, bytes);
    assert.equal(document.dirty, false);
    assert.equal(document.canRedo, true);
    document.redo();
    assert.equal(document.state.layers[0].name, 'new');
});
test('metadata edit invalidates an older prepared state without consuming it', () => {
    const document = layered(),
        candidate = cloneState(document.state);
    candidate.layers[0].name = 'prepared';
    const prepared = document.prepareState('prepared', candidate)!;
    document.editMetadata('visibility', { kind: 'layer-visible', layer: 0, visible: false });
    const current = cloneState(document.state);
    assert.throws(() => document.installPrepared(prepared));
    assert.deepEqual(document.state, current);
    document.undo();
    assert.equal(document.state.layers[0].visible, true);
});
test('metadata undo retains mutable pixels without storing aliases in history', () => {
    const document = layered();
    document.editMetadata('name', { kind: 'layer-name', layer: 0, name: 'new' });
    document.state.layers[0].name = 'externally changed metadata';
    document.state.background = [99, 0, 0, 0];
    document.state.layers[0].pixels[0] = 200;
    document.undo();
    assert.equal(document.state.layers[0].name, 'layer-0');
    assert.equal(document.state.background[0], 0);
    assert.equal(document.state.layers[0].pixels[0], 200);
    document.redo();
    assert.equal(document.state.layers[0].name, 'new');
    assert.equal(document.state.layers[0].pixels[0], 200);
});

test('constant background fill preserves every raw RGBA byte in native word order', () => {
    const colors: Color[] = [
        [0, 0, 0, 0],
        [255, 255, 255, 255],
        [1, 2, 3, 4],
        [255, 0, 128, 0],
        [0, 255, 0, 1],
        [2, 3, 4, 255],
    ];
    for (const color of colors) {
        const state = createState(19, 17, color),
            pixels = state.layers[0].pixels;
        assert.deepEqual(state.background, color);
        assert.deepEqual(
            pixels,
            Uint8ClampedArray.from({ length: 19 * 17 * 4 }, (_, index) => color[index % 4]),
        );
    }
    for (const color of [
        [-1, 0, 0, 0],
        [256, 0, 0, 0],
        [0.5, 0, 0, 0],
        [0, 0, 0, Number.NaN],
        [1, 2, 3],
    ] as unknown as Color[])
        assert.throws(() => createState(1, 1, color));
});

test('post-prepare candidate mutations reject atomically while preserving redo and saved identity', () => {
    const mutations: [string, (candidate: State) => void][] = [
        [
            'valid name',
            (candidate) => {
                candidate.layers[0].name = 'changed after prepare';
            },
        ],
        [
            'visibility',
            (candidate) => {
                candidate.layers[1].visible = true;
            },
        ],
        [
            'background',
            (candidate) => {
                candidate.background = [1, 2, 3, 4];
            },
        ],
        [
            'active layer',
            (candidate) => {
                candidate.active = 2;
            },
        ],
        [
            'last RGBA channel',
            (candidate) => {
                candidate.layers[2].pixels[candidate.layers[2].pixels.length - 1] = 1;
            },
        ],
        [
            'unaligned pixels',
            (candidate) => {
                const storage = new Uint8ClampedArray(candidate.layers[1].pixels.length + 1);
                storage.set(candidate.layers[1].pixels, 1);
                candidate.layers[1].pixels = storage.subarray(1);
                candidate.layers[1].pixels[0] = 123;
            },
        ],
        [
            'invalid dimension',
            (candidate) => {
                candidate.width = 0;
            },
        ],
        [
            'invalid layer name',
            (candidate) => {
                candidate.layers[1].name = '\ud800';
            },
        ],
    ];
    for (const [name, mutate] of mutations) {
        const document = layered();
        document.editMetadata('redo branch', { kind: 'layer-name', layer: 0, name: 'redo name' });
        document.undo();
        const candidate = cloneState(document.state);
        candidate.layers[0].name = 'prepared';
        const prepared = document.prepareState('pending candidate', candidate)!,
            current = document.state,
            pixels = current.layers.map((layer) => layer.pixels),
            before = cloneState(current),
            history = document.history,
            cursor = document.cursor,
            historyBytes = document.historyBytes,
            revision = document.revision,
            nextRevision = document.nextRevision,
            savedRevision = document.savedRevision;
        mutate(candidate);
        assert.throws(() => document.installPrepared(prepared), name);
        assert.equal(document.state, current, name);
        assert.deepEqual(document.state, before, name);
        for (let index = 0; index < pixels.length; index++)
            assert.equal(document.state.layers[index].pixels, pixels[index], name);
        assert.equal(document.history, history, name);
        assert.equal(document.cursor, cursor, name);
        assert.equal(document.historyBytes, historyBytes, name);
        assert.equal(document.revision, revision, name);
        assert.equal(document.nextRevision, nextRevision, name);
        assert.equal(document.savedRevision, savedRevision, name);
        assert.equal(document.dirty, false, name);
        assert.equal(document.canRedo, true, name);
        document.redo();
        assert.equal(document.state.layers[0].name, 'redo name', name);
    }
});

test('unchanged prepared candidates including unaligned pixels commit and replay their captured bytes', () => {
    const document = layered(),
        candidate = cloneState(document.state),
        original = cloneState(document.state),
        storage = new Uint8ClampedArray(candidate.layers[2].pixels.length + 1);
    storage.set(candidate.layers[2].pixels, 1);
    candidate.layers[2].pixels = storage.subarray(1);
    candidate.layers[0].name = 'prepared';
    candidate.layers[2].pixels[candidate.layers[2].pixels.length - 1] = 101;
    const expected = cloneState(candidate),
        prepared = document.prepareState('prepared', candidate)!;
    document.installPrepared(prepared);
    assert.deepEqual(document.state, expected);
    assert.equal(document.state, candidate);
    candidate.layers[2].pixels[0] = 200;
    document.undo();
    assert.deepEqual(document.state, original);
    document.redo();
    assert.deepEqual(document.state, expected);
});

test('synchronous candidate commit captures independent history and replays exact mutable pixels', () => {
    const document = layered(),
        original = cloneState(document.state),
        candidate = cloneState(document.state);
    candidate.layers[0].name = 'immediate';
    candidate.layers[2].pixels[3] = 77;
    const expected = cloneState(candidate);
    document.commitState('immediate commit', candidate);
    assert.equal(document.state, candidate);
    assert.deepEqual(document.state, expected);
    candidate.layers[0].name = 'later external name';
    candidate.layers[2].pixels[3] = 199;
    document.undo();
    assert.deepEqual(document.state, original);
    document.redo();
    assert.deepEqual(document.state, expected);
});

test('synchronous candidate no-op and validation failure preserve redo and saved identity', () => {
    const document = layered();
    document.editMetadata('redo', { kind: 'layer-name', layer: 0, name: 'redo' });
    document.undo();
    const state = document.state,
        history = document.history,
        revision = document.revision,
        saved = document.savedRevision,
        next = document.nextRevision,
        bytes = document.historyBytes;
    document.commitState('identical', cloneState(state));
    const invalid = cloneState(state);
    invalid.layers[0].name = '\ud800';
    assert.throws(() => document.commitState('invalid', invalid));
    assert.equal(document.state, state);
    assert.equal(document.history, history);
    assert.equal(document.revision, revision);
    assert.equal(document.savedRevision, saved);
    assert.equal(document.nextRevision, next);
    assert.equal(document.historyBytes, bytes);
    assert.equal(document.canRedo, true);
    assert.equal(document.dirty, false);
    document.redo();
    assert.equal(document.state.layers[0].name, 'redo');
});

test('generic edit keeps mutable callbacks isolated before synchronous commit', () => {
    const document = layered(),
        original = cloneState(document.state),
        current = document.state;
    assert.throws(() =>
        document.edit('failed callback', (candidate) => {
            assert.notEqual(candidate.layers[0].pixels, current.layers[0].pixels);
            candidate.layers[0].pixels[0] = 200;
            candidate.layers[0].name = 'not committed';
            throw Error('deliberate callback failure');
        }),
    );
    assert.equal(document.state, current);
    assert.deepEqual(document.state, original);
    assert.equal(document.canUndo, false);
    document.edit('valid callback', (candidate) => {
        candidate.layers[0].pixels[0] = 201;
        candidate.layers[0].name = 'committed';
    });
    assert.equal(document.state.layers[0].pixels[0], 201);
    document.undo();
    assert.deepEqual(document.state, original);
    document.redo();
    assert.equal(document.state.layers[0].pixels[0], 201);
    assert.equal(document.state.layers[0].name, 'committed');
});

test('identical layer names and RGBA still reorder with active restoration and saved revision identity', () => {
    const state = createState(2, 1, [17, 31, 201, 128]);
    state.layers[0].pixels.set([244, 82, 9, 0], 4);
    state.layers.push({ ...state.layers[0], pixels: state.layers[0].pixels.slice() });
    const document = new PaintDocument(state),
        first = document.state.layers[0].pixels,
        second = document.state.layers[1].pixels,
        expected = first.slice(),
        saved = document.savedRevision;
    assert.notEqual(first, second);
    assert.deepEqual(first, second);
    document.editMetadata('identical reorder', { kind: 'layer-reorder', layer: 0, to: 1 });
    assert.equal(document.state.active, 1);
    assert.equal(document.state.layers[0].pixels, second);
    assert.equal(document.state.layers[1].pixels, first);
    assert.equal(document.history.length, 1);
    assert.equal(document.dirty, true);
    assert(document.revision > saved);
    const reordered = document.revision;
    document.undo();
    assert.equal(document.state.active, 0);
    assert.equal(document.state.layers[0].pixels, first);
    assert.equal(document.state.layers[1].pixels, second);
    assert.equal(document.revision, saved);
    assert.equal(document.dirty, false);
    document.redo();
    assert.equal(document.state.active, 1);
    assert.equal(document.state.layers[0].pixels, second);
    assert.equal(document.revision, reordered);
    assert.equal(document.dirty, true);
    document.markSaved(reordered);
    document.undo();
    assert.equal(document.dirty, true);
    document.redo();
    assert.equal(document.dirty, false);
    assert.deepEqual(first, expected);
    assert.deepEqual(second, expected);
});

test('an explicit identical-layer permutation stays historical even when the active index and values are unchanged', () => {
    const state = createState(2, 1, [13, 29, 197, 128]);
    state.layers.push(
        { ...state.layers[0], pixels: state.layers[0].pixels.slice() },
        { ...state.layers[0], pixels: state.layers[0].pixels.slice() },
    );
    state.active = 2;
    const document = new PaintDocument(state),
        before = cloneState(document.state),
        first = document.state.layers[0].pixels,
        second = document.state.layers[1].pixels;
    document.editMetadata('explicit structural reorder', { kind: 'layer-reorder', layer: 0, to: 1 });
    assert.deepEqual(document.state, before);
    assert.equal(document.state.layers[0].pixels, second);
    assert.equal(document.state.layers[1].pixels, first);
    assert.equal(document.state.active, 2);
    assert.equal(document.dirty, true);
    assert.equal(document.canUndo, true);
    document.undo();
    assert.equal(document.state.layers[0].pixels, first);
    assert.equal(document.state.layers[1].pixels, second);
    assert.equal(document.state.active, 2);
    assert.equal(document.dirty, false);
    document.redo();
    assert.equal(document.state.layers[0].pixels, second);
    assert.equal(document.dirty, true);
});

test('active selection is nonhistorical while an active candidate is historical and pixel undo keeps the selected layer', () => {
    const state = createState(2, 1, [17, 31, 201, 128]);
    state.layers.push({ ...state.layers[0], pixels: state.layers[0].pixels.slice() });
    const document = new PaintDocument(state),
        saved = document.savedRevision;
    document.state.active = 1;
    assert.equal(document.revision, saved);
    assert.equal(document.dirty, false);
    assert.equal(document.canUndo, false);
    const candidate = cloneState(document.state);
    candidate.active = 0;
    document.commitState('active candidate', candidate);
    assert.equal(document.state.active, 0);
    assert.equal(document.history.length, 1);
    assert.equal(document.dirty, true);
    document.undo();
    assert.equal(document.state.active, 1);
    assert.equal(document.dirty, false);
    const history = document.history,
        cursor = document.cursor,
        next = document.nextRevision;
    document.state.active = 0;
    assert.equal(document.revision, saved);
    assert.equal(document.dirty, false);
    assert.equal(document.history, history);
    assert.equal(document.cursor, cursor);
    assert.equal(document.nextRevision, next);
    assert.equal(document.canRedo, true);
    document.redo();
    assert.equal(document.state.active, 0);
    assert.equal(document.dirty, true);
    document.undo();
    assert.equal(document.state.active, 1);
    document.state.active = 0;
    document.replacePixels('layer zero pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(1, 2, 3, 255));
    document.state.active = 1;
    document.undo();
    assert.equal(document.state.active, 1);
    assert.deepEqual([...document.state.layers[0].pixels.subarray(0, 4)], [17, 31, 201, 128]);
    assert.equal(document.dirty, false);
    document.redo();
    assert.equal(document.state.active, 1);
    assert.deepEqual([...document.state.layers[0].pixels.subarray(0, 4)], [1, 2, 3, 255]);
});

test('nonhistorical active selection invalidates a delayed candidate without consuming redo', () => {
    const state = createState(2, 1, [17, 31, 201, 128]);
    state.layers.push({ ...state.layers[0], pixels: state.layers[0].pixels.slice() });
    const document = new PaintDocument(state);
    document.replacePixels('redo pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(1, 2, 3, 255));
    document.undo();
    const candidate = cloneState(document.state);
    candidate.layers[0].name = 'pending';
    const prepared = document.prepareState('pending', candidate)!,
        history = document.history,
        revision = document.revision,
        saved = document.savedRevision,
        cursor = document.cursor;
    document.state.active = 1;
    assert.equal(document.revision, revision);
    assert.equal(document.dirty, false);
    assert.throws(() => document.installPrepared(prepared));
    assert.equal(document.state.active, 1);
    assert.equal(document.history, history);
    assert.equal(document.cursor, cursor);
    assert.equal(document.revision, revision);
    assert.equal(document.savedRevision, saved);
    assert.equal(document.canRedo, true);
    document.redo();
    assert.equal(document.state.active, 1);
    assert.deepEqual([...document.state.layers[0].pixels.subarray(0, 4)], [1, 2, 3, 255]);
});
