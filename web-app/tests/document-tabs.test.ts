import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { PaintDocument, createState, cloneState, webLimits } from '../src/engine/document';
import { documentMenuGroups } from '../src/ui/menu';
const source = ts.createSourceFile(
    'main.ts',
    readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
);
function method(name: string, globals: object = {}) {
    let found: ts.MethodDeclaration | undefined;
    function visit(node: ts.Node) {
        if (ts.isMethodDeclaration(node) && node.name.getText(source) === name) found = node;
        ts.forEachChild(node, visit);
    }
    visit(source);
    assert.ok(found);
    return vm.runInNewContext(
        ts.transpile(`(class Test { ${found.getText(source)} }).prototype.${name}`, {
            target: ts.ScriptTarget.ES2022,
        }),
        globals,
    );
}
function fixture(fail = false) {
    const first = new PaintDocument(createState(2, 2));
    const second = new PaintDocument(createState(3, 3));
    const writes: { key: string; bytes: Uint8Array; generation: number }[] = [];
    const activations: { key: string; closePrevious: boolean }[] = [];
    const store = (key: string) => ({
        key,
        generation: 1,
        async request(_operation: string, _entry: undefined, bytes: Uint8Array) {
            writes.push({ key, bytes, generation: this.generation });
        },
    });
    const recoveryA = store('a'),
        recoveryB = store('b');
    const tabs = [first, second].map((doc, index) => ({
        key: index ? 'b' : 'a',
        doc,
        name: index ? 'B.png' : 'A.png',
        recovery: index ? recoveryB : recoveryA,
        recoveredRevision: 0,
        recoveryQueued: false,
        zoom: index + 1,
        offsetX: index * 10,
        offsetY: 0,
        autoFit: false,
    }));
    const app: any = {
        ...tabs[0],
        tabs,
        epoch: 1,
        busy: false,
        recoveryQueue: Promise.resolve(),
        points: [],
        curveControls: [],
        workspace: { querySelector: () => null },
        pendingDirty: new Map(),
        settle() {},
        hasPending() {
            return false;
        },
        autoRecover: method('autoRecover'),
        async task(_label: string, action: () => Promise<void>) {
            await (action as any)(new AbortController().signal);
        },
        captureTab: method('captureTab'),
        cancelRenderPreparation() {},
        sceneCache: { clear() {} },
        draw() {},
        fit() {},
        message() {},
        switchTab: method('switchTab'),
        activateTab: method('activateTab', {
            activateNative: async (
                _generation: number,
                key: string,
                _sourceToken: string | undefined,
                closePrevious: boolean,
            ) => {
                if (fail) throw Error('native activation failed');
                activations.push({ key, closePrevious });
            },
        }),
        queueTabRecovery: method('queueTabRecovery', {
            cloneState,
            runtimeProfile: webLimits,
            Uint8Array,
            runCodec: async (_operation: string, state: ReturnType<typeof createState>) => ({
                bytes: Uint8Array.from(state.layers[0].pixels.slice(0, 4)),
            }),
        }),
        replaceDocument: method('replaceDocument', {
            validate: () => {},
            runtimeProfile: webLimits,
            PaintDocument,
            RecoveryStore: class {
                key = 'new-tab';
            },
        }),
        closeTab: method('closeTab', { createState, runtimeProfile: webLimits }),
    };
    return { app, first, second, recoveryA, recoveryB, writes, activations };
}
test('switch and return preserve distinct pixels, history, recovery and viewport', async () => {
    const { app, first, second, recoveryA, recoveryB } = fixture();
    first.edit('red', (state) => {
        state.layers[0].pixels.set([255, 0, 0, 255]);
    });
    app.zoom = 4;
    await app.switchTab('b');
    assert.equal(app.doc, second);
    assert.equal(app.recovery, recoveryB);
    assert.equal(app.zoom, 2);
    second.edit('blue', (state) => {
        state.layers[0].pixels.set([0, 0, 255, 255]);
    });
    await app.switchTab('a');
    assert.equal(app.doc, first);
    assert.equal(app.recovery, recoveryA);
    assert.equal(app.zoom, 4);
    assert.equal(first.history.length, 1);
    assert.equal(second.history.length, 1);
    assert.deepEqual([...first.state.layers[0].pixels.slice(0, 4)], [255, 0, 0, 255]);
    assert.equal(app.epoch, 3);
    assert.equal(recoveryA.generation, 3);
});
test('failed native activation preserves current tab and all documents', async () => {
    const { app, first } = fixture(true);
    await assert.rejects(app.switchTab('b'), /activation failed/);
    assert.equal(app.doc, first);
    assert.equal(app.epoch, 1);
    assert.equal(app.tabs.length, 2);
});
test('active operation prevents switching', async () => {
    const { app, first } = fixture();
    app.busy = true;
    await assert.rejects(app.switchTab('b'), /진행 중/);
    assert.equal(app.doc, first);
});
test('cancel close preserves every document', async () => {
    const { app } = fixture();
    app.replacementAllowed = async () => false;
    await app.closeTab('b');
    assert.equal(app.tabs.length, 2);
});
test('menu commands are unique and settings are in their own category', () => {
    const commands = documentMenuGroups.flatMap((group) => group.commands.map(([command]) => command));
    assert.equal(new Set(commands).size, commands.length);
    assert.deepEqual(
        documentMenuGroups.find((g) => g.label === '설정')!.commands.map(([c]) => c),
        ['settings', 'text-options', 'background'],
    );
    assert.ok(documentMenuGroups.find((g) => g.label === '파일')!.commands.some(([c]) => c === 'open'));
});

test('failed tab activation preserves pending candidate and redo history', async () => {
    const { app, first, writes } = fixture(true);
    first.edit('red', (state) => {
        state.layers[0].pixels.set([255, 0, 0, 255]);
    });
    first.undo();
    const candidate = createState(2, 2, [0, 255, 0, 255]);
    app.hasPending = () => true;
    app.pendingState = () => candidate;
    await assert.rejects(app.switchTab('b'), /activation failed/);
    assert.equal(first.cursor, 0);
    assert.equal(first.history.length, 1);
    assert.equal(first.state.layers[0].pixels[1], 255);
    first.redo();
    assert.equal(first.state.layers[0].pixels[0], 255);
    await app.recoveryQueue;
    assert.equal(writes.length, 0);
});

test('a formerly clean tab backs up its pending edit after the destination is activated', async () => {
    const { app, first, second, writes } = fixture();
    const outgoing = app.tabs[0];
    app.hasPending = () => app.doc === first;
    app.pendingState = () => createState(2, 2, [28, 199, 42, 255]);
    await app.switchTab('b');
    assert.equal(app.doc, second);
    await app.recoveryQueue;
    assert.equal(first.history.length, 1);
    assert.equal(outgoing.recoveredRevision, first.revision);
    assert.deepEqual(writes, [{ key: 'a', generation: 1, bytes: Uint8Array.of(28, 199, 42, 255) }]);
    app.autoRecover();
    await app.recoveryQueue;
    assert.equal(writes.length, 1);
});

test('a failed transition backup retries the inactive tab and never records a false success', async () => {
    const { app, first, recoveryA, writes } = fixture();
    first.edit('blue', (state) => state.layers[0].pixels.set([0, 0, 200, 255]));
    const write = recoveryA.request;
    recoveryA.request = async () => {
        throw Error('storage temporarily unavailable');
    };
    await app.switchTab('b');
    await app.recoveryQueue;
    assert.equal(app.tabs[0].recoveredRevision, 0);
    recoveryA.request = write;
    app.autoRecover();
    await app.recoveryQueue;
    assert.equal(app.tabs[0].recoveredRevision, first.revision);
    assert.deepEqual(writes, [{ key: 'a', generation: 1, bytes: Uint8Array.of(0, 0, 200, 255) }]);
});

test('reactivating a tab retries a rejected backup at the new generation without waiting for the timer', async () => {
    const { app, first, recoveryA, writes } = fixture();
    first.edit('green', (state) => state.layers[0].pixels.set([0, 203, 0, 255]));
    const write = recoveryA.request;
    let rejectWrite!: (reason: Error) => void;
    const started = new Promise<void>((resolve) => {
        recoveryA.request = () => {
            resolve();
            return new Promise<void>((_resolve, reject) => (rejectWrite = reject));
        };
    });
    await app.switchTab('b');
    await started;
    await app.switchTab('a');
    recoveryA.request = write;
    rejectWrite(Error('obsolete generation'));
    await app.recoveryQueue;
    await app.recoveryQueue;
    assert.deepEqual(writes, [{ key: 'a', generation: 3, bytes: Uint8Array.of(0, 203, 0, 255) }]);
    assert.equal(app.tabs[0].recoveredRevision, first.revision);
});

test('closing the last tab releases only on successful replacement and does not count discarded history', async () => {
    const { app, first, activations, writes } = fixture();
    app.tabs.splice(1);
    first.historyBytes = 512 * 1048576;
    app.hasPending = () => true;
    app.pendingState = () => assert.fail('discard must not materialize pending pixels');
    app.replacementAllowed = async () => true;
    await app.closeTab('a');
    await app.recoveryQueue;
    assert.deepEqual(activations, [{ key: 'new-tab', closePrevious: true }]);
    assert.equal(app.tabs.length, 1);
    assert.equal(app.doc.state.width, 800);
    assert.equal(writes.length, 0);
});

test('rejected close activation keeps the original tab and pending editor', async () => {
    const { app, first } = fixture(true);
    const editor = { remove: () => assert.fail('editor must survive') };
    app.editor = editor;
    app.hasPending = () => true;
    app.pendingState = () => assert.fail('discard must not materialize pending pixels');
    app.replacementAllowed = async () => true;
    await assert.rejects(app.closeTab('a'), /activation failed/);
    assert.equal(app.tabs.length, 2);
    assert.equal(app.editor, editor);
    assert.equal(app.doc, first);
});
