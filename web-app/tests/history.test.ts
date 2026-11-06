import test from 'node:test';
import assert from 'node:assert/strict';
import { PaintDocument, createState, cloneState, desktopLimits } from '../src/engine/document';

test('changing history budget immediately prunes from Undo then distant Redo without editing current pixels', () => {
    const document = new PaintDocument(createState(2, 2));
    for (const red of [1, 2, 3, 4, 5])
        document.replacePixels('pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(red, 20, 30, 255));
    document.undo();
    document.undo();
    document.markSaved(document.revision);
    const current = document.state,
        bytes = cloneState(current),
        revision = document.revision,
        saved = document.savedRevision,
        next = document.nextRevision;
    document.historyBudget = 16;
    assert.equal(document.historyBudget, 16);
    assert.equal(document.historyBytes, 16);
    assert.equal(document.history.length, 2);
    assert.equal(document.cursor, 0);
    assert.equal(document.state, current);
    assert.deepEqual(document.state, bytes);
    assert.equal(document.revision, revision);
    assert.equal(document.savedRevision, saved);
    assert.equal(document.nextRevision, next);
    assert.equal(document.dirty, false);
    assert.equal(document.canUndo, false);
    assert.equal(document.canRedo, true);
    document.redo();
    assert.equal(document.state.layers[0].pixels[0], 4);
    assert.equal(document.dirty, true);
    document.redo();
    assert.equal(document.state.layers[0].pixels[0], 5);
    assert.equal(document.canRedo, false);
    document.undo();
    document.undo();
    assert.deepEqual(document.state, bytes);
    assert.equal(document.dirty, false);
});

test('zero and negative budgets preserve the single oversized nearest change', () => {
    const document = new PaintDocument(createState(2, 2));
    document.replacePixels('pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(1, 20, 30, 255));
    document.replacePixels('pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(2, 20, 30, 255));
    document.replacePixels('pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(3, 20, 30, 255));
    document.undo();
    const current = cloneState(document.state);
    document.historyBudget = -1;
    assert.equal(document.historyBudget, 0);
    assert.equal(document.historyBytes, 8);
    assert.equal(document.history.length, 1);
    assert.equal(document.cursor, 0);
    assert.deepEqual(document.state, current);
    assert.equal(document.canRedo, true);
    document.redo();
    assert.equal(document.state.layers[0].pixels[0], 3);
    document.undo();
    assert.deepEqual(document.state, current);
    document.replacePixels('pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(4, 20, 30, 255));
    assert.equal(document.history.length, 1);
    assert.equal(document.historyBytes, 8);
    assert.equal(document.canRedo, false);
    document.historyBudget = Number.MIN_SAFE_INTEGER;
    assert.equal(document.historyBudget, 0);
    document.undo();
    assert.deepEqual(document.state, current);
});

test('invalid budget values fail before changing policy, history, pixels or saved identity', () => {
    const document = new PaintDocument(createState(2, 2));
    document.replacePixels('pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(1, 20, 30, 255));
    document.replacePixels('pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(2, 20, 30, 255));
    document.undo();
    const history = document.history,
        state = document.state,
        budget = document.historyBudget,
        cursor = document.cursor,
        retained = document.historyBytes,
        revision = document.revision,
        saved = document.savedRevision,
        next = document.nextRevision;
    for (const value of [
        Number.NaN,
        Infinity,
        -Infinity,
        1.5,
        -1.5,
        Number.MAX_SAFE_INTEGER + 1,
        Number.MIN_SAFE_INTEGER - 1,
        '16',
        null,
        undefined,
    ]) {
        assert.throws(() => {
            document.historyBudget = value as number;
        });
        assert.equal(document.historyBudget, budget);
        assert.equal(document.history, history);
        assert.equal(document.state, state);
        assert.equal(document.cursor, cursor);
        assert.equal(document.historyBytes, retained);
        assert.equal(document.revision, revision);
        assert.equal(document.savedRevision, saved);
        assert.equal(document.nextRevision, next);
    }
    document.redo();
    assert.equal(document.state.layers[0].pixels[0], 2);
});

test('4096 history boundary and budget shrink at fully undone position match the Qt patch contract', () => {
    const document = new PaintDocument(createState(2, 2));
    for (let index = 0; index < 4096 + 10; index++)
        document.replacePixels(
            'pixel',
            0,
            0,
            0,
            1,
            1,
            Uint8ClampedArray.of(index % 2 ? 255 : 0, 20, 30, 255),
        );
    assert.equal(document.history.length, 4096);
    assert.equal(document.historyBytes, 4096 * 8);
    let undone = 0;
    while (document.canUndo) {
        document.undo();
        undone++;
    }
    assert.equal(undone, 4096);
    const current = cloneState(document.state),
        revision = document.revision;
    document.historyBudget = 16;
    assert.deepEqual(document.state, current);
    assert.equal(document.revision, revision);
    assert.equal(document.historyBytes, 16);
    assert.equal(document.history.length, 2);
    assert.equal(document.cursor, 0);
    document.redo();
    assert.equal(document.state.layers[0].pixels[0], 0);
    document.redo();
    assert.equal(document.state.layers[0].pixels[0], 255);
    assert.equal(document.canRedo, false);
    document.undo();
    document.undo();
    assert.deepEqual(document.state, current);
});

test('saved branch IDs stay unique after pruning removes both past and future changes', () => {
    const document = new PaintDocument(createState(2, 2));
    document.replacePixels('pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(1, 20, 30, 255));
    const first = document.revision;
    document.replacePixels('pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(2, 20, 30, 255));
    const saved = document.revision;
    document.markSaved(saved);
    document.replacePixels('pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(3, 20, 30, 255));
    const removedFuture = document.revision;
    document.undo();
    document.undo();
    assert.equal(document.revision, first);
    document.historyBudget = 8;
    assert.equal(document.history.length, 1);
    assert.equal(document.canRedo, true);
    document.redo();
    assert.equal(document.revision, saved);
    assert.equal(document.dirty, false);
    assert.equal(document.canRedo, false);
    document.undo();
    document.replacePixels('pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(4, 20, 30, 255));
    assert(document.revision > removedFuture);
    assert.equal(document.savedRevision, saved);
    assert.equal(document.dirty, true);
    assert.equal(document.canRedo, false);
    document.undo();
    assert.equal(document.revision, first);
    document.redo();
    assert.equal(document.state.layers[0].pixels[0], 4);
    assert.equal(document.dirty, true);
});

test('shrinking budget invalidates delayed prepared history and cannot resurrect pruned entries', () => {
    const document = new PaintDocument(createState(2, 2));
    for (const red of [1, 2, 3, 4])
        document.replacePixels('pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(red, 20, 30, 255));
    document.undo();
    const candidate = cloneState(document.state);
    candidate.layers[0].name = 'prepared';
    const prepared = document.prepareState('pending', candidate)!;
    document.historyBudget = 8;
    const history = document.history,
        current = document.state,
        revision = document.revision,
        saved = document.savedRevision,
        next = document.nextRevision;
    assert.throws(() => document.installPrepared(prepared));
    assert.equal(document.state, current);
    assert.equal(document.history, history);
    assert.equal(document.history.length, 1);
    assert.equal(document.historyBytes, 8);
    assert.equal(document.revision, revision);
    assert.equal(document.savedRevision, saved);
    assert.equal(document.nextRevision, next);
    assert.equal(document.cursor, 0);
    document.redo();
    assert.equal(document.state.layers[0].pixels[0], 4);
});

test('raising a budget and setting it idempotently preserve current state and available redo', () => {
    const document = new PaintDocument(createState(2, 2));
    document.replacePixels('pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(1, 20, 30, 255));
    document.replacePixels('pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(2, 20, 30, 255));
    document.undo();
    const state = document.state,
        history = document.history,
        cursor = document.cursor,
        bytes = document.historyBytes;
    document.historyBudget = Number.MAX_SAFE_INTEGER;
    assert.equal(document.historyBudget, Number.MAX_SAFE_INTEGER);
    assert.equal(document.state, state);
    assert.equal(document.history, history);
    assert.equal(document.cursor, cursor);
    assert.equal(document.historyBytes, bytes);
    const candidate = cloneState(state);
    candidate.layers[0].name = 'valid';
    const prepared = document.prepareState('candidate', candidate)!;
    document.historyBudget = document.historyBudget;
    document.installPrepared(prepared);
    assert.equal(document.state.layers[0].name, 'valid');
    document.undo();
    assert.deepEqual(document.state, state);
});

test('profile defaults initialize through the accessor and budget changes do not cancel an active stroke', () => {
    assert.equal(new PaintDocument(createState(1, 1)).historyBudget, 32 * 1024 * 1024);
    assert.equal(
        new PaintDocument(createState(1, 1, [0, 0, 0, 0], desktopLimits), desktopLimits).historyBudget,
        256 * 1024 * 1024,
    );
    const document = new PaintDocument(createState(4, 4));
    document.replacePixels('pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(1, 20, 30, 255));
    document.replacePixels('pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(2, 20, 30, 255));
    document.beginStroke(2, 2, {
        color: [20, 40, 60, 255],
        size: 1,
        opacity: 1,
        hardness: 1,
        stabilization: 0,
        eraser: false,
        pressure: false,
        pixel: true,
    });
    const stroke = document.stroke,
        state = document.state,
        revision = document.revision;
    document.historyBudget = 0;
    assert.equal(document.stroke, stroke);
    assert.equal(document.state, state);
    assert.equal(document.revision, revision);
    document.cancelStroke();
    assert.equal(document.state.layers[0].pixels[(2 * 4 + 2) * 4], 255);
    assert.equal(document.history.length, 1);
});

test('delayed candidates reject a changed budget even when no retained entry was pruned', () => {
    const document = new PaintDocument(createState(2, 2));
    document.replacePixels('pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(1, 20, 30, 255));
    const candidate = cloneState(document.state);
    candidate.layers[0].name = 'pending';
    const prepared = document.prepareState('pending', candidate)!,
        history = document.history,
        current = document.state;
    document.historyBudget += 1;
    assert.equal(document.history, history);
    assert.throws(() => document.installPrepared(prepared));
    assert.equal(document.state, current);
    assert.equal(document.history, history);
    assert.equal(document.historyBytes, 8);
});

test('restoring the old budget cannot make a prepared candidate resurrect already pruned history', () => {
    const document = new PaintDocument(createState(2, 2));
    for (const red of [1, 2, 3, 4])
        document.replacePixels('pixel', 0, 0, 0, 1, 1, Uint8ClampedArray.of(red, 20, 30, 255));
    document.undo();
    const budget = document.historyBudget,
        candidate = cloneState(document.state);
    candidate.layers[0].name = 'pending';
    const prepared = document.prepareState('pending', candidate)!;
    document.historyBudget = 8;
    const history = document.history,
        current = document.state;
    document.historyBudget = budget;
    assert.equal(document.historyBudget, budget);
    assert.throws(() => document.installPrepared(prepared));
    assert.equal(document.state, current);
    assert.equal(document.history, history);
    assert.equal(document.history.length, 1);
    assert.equal(document.historyBytes, 8);
    document.redo();
    assert.equal(document.state.layers[0].pixels[0], 4);
});
