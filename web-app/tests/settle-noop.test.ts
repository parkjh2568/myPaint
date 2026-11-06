import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { PaintDocument, createState, cloneState, validate, desktopLimits } from '../src/engine/document';
import { resizeState } from '../src/engine/operations';

const text = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'),
    ast = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true),
    studio = ast.statements.find(
        (node) => ts.isClassDeclaration(node) && node.name?.text === 'Studio',
    ) as ts.ClassDeclaration,
    compiled = ts.transpileModule(
        'class Studio {' +
            studio.members
                .filter(
                    (node) =>
                        ts.isMethodDeclaration(node) &&
                        [
                            'hasPending',
                            'settle',
                            'editPending',
                            'pendingState',
                            'commitPending',
                            'clearSelectionSource',
                        ].includes(node.name.getText(ast)),
                )
                .map((node) => node.getText(ast))
                .join('\n') +
            '} return Studio;',
        { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
    ).outputText,
    Constructor = new Function('cloneState', 'resizeState', 'validate', 'runtimeProfile', compiled)(
        cloneState,
        resizeState,
        validate,
        desktopLimits,
    );

// Only drawing/DOM cleanup are modeled; execute the shipped settlement methods and real history engine.
function fixture() {
    const state = createState(4, 4, [193, 71, 117, 0], desktopLimits);
    state.layers[0].pixels.set([11, 23, 47, 128], 0);
    const doc = new PaintDocument(state, desktopLimits);
    doc.editMetadata('seed', { kind: 'layer-name', layer: 0, name: 'seed' });
    doc.undo();
    doc.markSaved(doc.revision);
    const pixels = Uint8ClampedArray.of(11, 23, 47, 128),
        selection = {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            pixels,
            source: { x: 0, y: 0, width: 1, height: 1 },
            modified: false,
        },
        app = new Constructor();
    Object.assign(app, {
        doc,
        selection,
        selectionCache: { held: true },
        points: [],
        curveControls: [],
        composing: false,
        draw(full: boolean) {
            assert.equal(full, true);
            app.drawCalls = (app.drawCalls || 0) + 1;
        },
    });
    return { app, doc, selection };
}

test('unmodified selection settles without copying source planes and preserves saved state and old Redo', () => {
    const { app, doc } = fixture(),
        owner = doc.state,
        pixels = owner.layers[0].pixels,
        before = pixels.slice(),
        history = doc.history,
        revision = doc.revision,
        cursor = doc.cursor,
        saved = doc.savedRevision,
        bytes = doc.historyBytes,
        slice = Uint8ClampedArray.prototype.slice;
    let copies = 0;
    Uint8ClampedArray.prototype.slice = function (...args) {
        copies++;
        return slice.apply(this, args);
    };
    try {
        app.settle();
    } finally {
        Uint8ClampedArray.prototype.slice = slice;
    }
    assert.equal(copies, 0);
    assert.equal(doc.state, owner);
    assert.equal(doc.state.layers[0].pixels, pixels);
    assert.deepEqual(pixels, before);
    assert.equal(doc.history, history);
    assert.equal(doc.revision, revision);
    assert.equal(doc.cursor, cursor);
    assert.equal(doc.savedRevision, saved);
    assert.equal(doc.historyBytes, bytes);
    assert.equal(doc.dirty, false);
    assert.equal(doc.canRedo, true);
    assert.equal(app.selection, undefined);
    assert.equal(app.selectionCache, undefined);
    assert.equal(app.drawCalls, 1);
    doc.redo();
    assert.equal(doc.state.layers[0].name, 'seed');
});

test('moved selection still clears its source, commits once and remains one Undo/Redo operation', () => {
    const { app, doc, selection } = fixture(),
        before = cloneState(doc.state);
    selection.x = 1;
    selection.modified = true;
    app.settle();
    assert.deepEqual(
        Array.from(doc.state.layers[0].pixels.subarray(0, 8)),
        [193, 71, 117, 0, 11, 23, 47, 128],
    );
    const committed = cloneState(doc.state);
    assert.equal(doc.canRedo, false);
    assert.equal(doc.dirty, true);
    doc.undo();
    assert.deepEqual(doc.state, before);
    doc.redo();
    assert.deepEqual(doc.state, committed);
});

test('NoOp validation and unfinished-operation guards fail before clearing selection or changing history', () => {
    for (const failure of ['invalid-state', 'resize', 'composition', 'stroke']) {
        const { app, doc, selection } = fixture(),
            history = doc.history,
            revision = doc.revision,
            pixels = doc.state.layers[0].pixels.slice(),
            cache = app.selectionCache;
        if (failure === 'invalid-state') doc.state.active = -1;
        else if (failure === 'resize') app.selectionResize = {};
        else if (failure === 'composition') app.composing = true;
        else app.doc.stroke = {};
        const canRedo = doc.canRedo;
        assert.throws(() => app.settle());
        assert.equal(app.selection, selection);
        assert.equal(app.selectionCache, cache);
        assert.equal(app.drawCalls, undefined);
        assert.equal(doc.history, history);
        assert.equal(doc.revision, revision);
        assert.deepEqual(doc.state.layers[0].pixels, pixels);
        assert.equal(doc.canRedo, canRedo);
    }
});
