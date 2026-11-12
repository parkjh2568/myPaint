import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { readEraserPreferences } from '../src/ui/eraser';

// Execute the actual UI methods with instrumented DOM/canvas boundaries. No browser timing claims.
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
    const js = ts.transpile(`(function ${found.getText(source)})`, { target: ts.ScriptTarget.ES2022 });
    return vm.runInNewContext(js, globals);
}
test('eraser preferences change does not schedule document render or reapply theme', () => {
    let handler: ts.ArrowFunction | undefined;
    function visit(node: ts.Node) {
        if (
            ts.isForOfStatement(node) &&
            node.expression.getText(source) === "['eraser-mode', 'eraser-color']"
        ) {
            function arrow(child: ts.Node) {
                if (ts.isArrowFunction(child)) handler = child;
                ts.forEachChild(child, arrow);
            }
            arrow(node.statement);
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
    assert.ok(handler);
    let saved = 0;
    const mode = { value: '' },
        color = { value: '', disabled: true };
    const app = {
        busy: false,
        drag: undefined,
        doc: { stroke: undefined },
        brushCursor: { hidden: false },
        eraserPreferences: readEraserPreferences(null),
        root: { querySelector: (selector: string) => (selector === '#eraser-mode' ? mode : color) },
        savePreferences() {
            saved++;
        },
        syncEraserPreferences: method('syncEraserPreferences'),
        applyPreferences() {
            assert.fail('must not reapply appearance');
        },
        sync() {
            assert.fail('must not sync unrelated controls');
        },
        draw() {
            assert.fail('preferences do not alter document pixels');
        },
    };
    const factory = vm.runInNewContext(
        ts.transpile(`(function () { return ${handler.getText(source)}; })`, {
            target: ts.ScriptTarget.ES2022,
        }),
        { readEraserPreferences, id: 'eraser-mode' },
    );
    const change = factory.call(app);
    for (let i = 0; i < 100; i++) change({ target: { value: i % 2 ? 'transparent' : 'background' } });
    assert.equal(saved, 100);
    assert.equal(mode.value, 'transparent');
    assert.equal(color.disabled, true);
    assert.equal(app.brushCursor.hidden, true);
});
test('unchanged color wheel sync skips raster work but color, hue and dimensions invalidate it', () => {
    let paints = 0;
    const gradient = { addColorStop() {} };
    const ctx = new Proxy(
        {},
        {
            get: (_, name) =>
                name === 'clearRect'
                    ? () => paints++
                    : name === 'createConicGradient' || name === 'createLinearGradient'
                      ? () => gradient
                      : () => {},
        },
    );
    const app = {
        foreground: [0, 0, 0, 255],
        hue: 0,
        wheelPaintKey: '',
        wheel: { width: 440, height: 420, getContext: () => ctx },
    };
    const paint = method('paintColorWheel');
    for (let i = 0; i < 100; i++) paint.call(app);
    assert.equal(paints, 1);
    app.foreground = [255, 0, 0, 255];
    paint.call(app);
    assert.equal(paints, 2);
    app.foreground = [0, 0, 0, 255];
    paint.call(app);
    app.hue = 0.5;
    paint.call(app);
    assert.equal(paints, 4);
    app.wheel.width++;
    paint.call(app);
    assert.equal(paints, 5);
});
