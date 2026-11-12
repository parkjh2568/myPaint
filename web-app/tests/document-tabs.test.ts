import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { PaintDocument, createState } from '../src/engine/document';
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
    const recoveryA = { key: 'a', generation: 1 },
        recoveryB = { key: 'b', generation: 1 };
    const tabs = [first, second].map((doc, index) => ({
        key: index ? 'b' : 'a',
        doc,
        name: index ? 'B.png' : 'A.png',
        recovery: index ? recoveryB : recoveryA,
        recoveredRevision: 0,
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
        points: [],
        curveControls: [],
        workspace: { querySelector: () => null },
        pendingDirty: new Map(),
        settle() {},
        hasPending() {
            return false;
        },
        async autoRecover() {},
        async task(_label: string, action: () => Promise<void>) {
            await (action as any)(new AbortController().signal);
        },
        captureTab: method('captureTab'),
        cancelRenderPreparation() {},
        sceneCache: { clear() {} },
        draw() {},
        switchTab: method('switchTab', {
            activateNative: async () => {
                if (fail) throw Error('native activation failed');
            },
        }),
    };
    return { app, first, second, recoveryA, recoveryB };
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
    app.closeTab = method('closeTab');
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
    const { app, first } = fixture(true);
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
});
