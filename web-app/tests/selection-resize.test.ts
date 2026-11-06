import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
    createState,
    cloneState,
    PaintDocument,
    validateSize,
    webLimits,
    desktopLimits,
    type State,
} from '../src/engine/document';
import { resizeState, resizeNearestSteps } from '../src/engine/operations';

const text = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'),
    ast = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true),
    studio = ast.statements.find(
        (n) => ts.isClassDeclaration(n) && n.name?.text === 'Studio',
    ) as ts.ClassDeclaration;
const compiled = ts.transpileModule(
    'class Studio {' +
        studio.members
            .filter(
                (n) =>
                    ts.isMethodDeclaration(n) &&
                    [
                        'resizeSelection',
                        'pointerMove',
                        'pointerUp',
                        'cancelPointer',
                        'pendingState',
                        'hasPending',
                    ].includes(n.name.getText(ast)),
            )
            .map((n) => n.getText(ast))
            .join('\n') +
        '} return Studio;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;
// Only channel scheduling and DOM drawing are modeled; execute the shipped gesture methods and kernel.
function fixture(
    options: {
        yield?: (app: any, turn: number) => void;
        setupFailure?: boolean;
        hold?: boolean;
        timeout?: boolean;
    } = {},
) {
    let app: any,
        turn = 0,
        closed = 0;
    class Channel {
        port1: any = { close: () => closed++ };
        port2 = {
            close: () => closed++,
            postMessage: () =>
                setImmediate(() => {
                    options.yield?.(app, ++turn);
                    if (!options.hold) this.port1.onmessage?.();
                }),
        };
        constructor() {
            if (options.setupFailure)
                Object.defineProperty(this.port1, 'onmessage', {
                    set(value) {
                        if (value) throw Error('Injected resize channel setup');
                    },
                });
        }
    }
    const Constructor = new Function(
        'resizeNearestSteps',
        'resizeState',
        'validateSize',
        'runtimeProfile',
        'MessageChannel',
        'setTimeout',
        'devicePixelRatio',
        compiled,
    )(
        resizeNearestSteps,
        resizeState,
        validateSize,
        webLimits,
        Channel,
        (work: () => void, delay: number) => setTimeout(work, options.timeout ? 1 : delay),
        1,
    );
    app = new Constructor();
    const state = createState(64, 64, [193, 71, 117, 0]);
    for (let i = 0; i < state.layers[0].pixels.length; i += 4)
        state.layers[0].pixels.set([17 + ((i / 4) % 231), 31, 191, [0, 1, 128, 255][(i / 4) % 4]], i);
    const pixels = state.layers[0].pixels.slice();
    const selection: any = {
        x: 0,
        y: 0,
        width: 64,
        height: 64,
        pixels,
        originalPixels: pixels,
        source: { x: 0, y: 0, width: 64, height: 64 },
        modified: false,
    };
    const drag = {
        pointer: 1,
        mode: 'resize-selection',
        resizeReleased: false,
        selectionX: 0,
        selectionY: 0,
        selectionModified: false,
        selectionRaster: { width: 64, height: 64, pixels },
        start: { x: 64, y: 64 },
        last: { x: 64, y: 64 },
    };
    const pending: Promise<void>[] = [];
    Object.assign(app, {
        doc: new PaintDocument(state),
        epoch: 1,
        selection,
        drag,
        points: [],
        curveControls: [],
        pointers: new Map([[1, { x: 64, y: 64, type: 'pen' }]]),
        mouseButtonMask: 0,
        viewWidth: 64,
        viewLeft: 0,
        viewTop: 0,
        viewHeight: 64,
        workspace: { getBoundingClientRect: () => ({ width: 64, height: 64, left: 0, top: 0 }) },
        canvas: {
            width: 64,
            height: 64,
            getBoundingClientRect: () => ({ width: 64, height: 64, left: 0, top: 0 }),
            dataset: {},
            setAttribute() {},
            hasPointerCapture: () => false,
        },
        sync() {},
        draw() {},
        resizeView() {},
        stopSpray() {},
        message(value: string) {
            app.messageText = value;
        },
        point: (e: any) => ({ x: e.clientX, y: e.clientY, pressure: 1 }),
        run(work: () => Promise<void>) {
            const result = Promise.resolve(work());
            pending.push(result);
            return result;
        },
    });
    return {
        app,
        selection,
        drag,
        state,
        pending,
        get closed() {
            return closed;
        },
    };
}
function event(x: number, y: number) {
    return {
        pointerId: 1,
        pointerType: 'pen',
        clientX: x,
        clientY: y,
        button: -1,
        buttons: 1,
    } as PointerEvent;
}

test('nearest cursor yields before full output allocation and can abandon a private partial output', () => {
    const state = createState(128, 128, [193, 71, 117, 0]),
        original = cloneState(state),
        Native = globalThis.Uint8ClampedArray;
    let planes = 0;
    globalThis.Uint8ClampedArray = new Proxy(Native, {
        construct(target, args) {
            if (args[0] === 512 * 512 * 4) planes++;
            return Reflect.construct(target, args, target);
        },
    });
    try {
        const steps = resizeNearestSteps(state, 512, 512);
        assert.equal(planes, 0);
        assert.equal(steps.next().done, false);
        assert.equal(planes, 0);
        assert.equal(steps.next().done, false);
        assert.equal(planes, 1);
        steps.return(state);
        assert.equal(steps.next().done, true);
        assert.deepEqual(state, original);
    } finally {
        globalThis.Uint8ClampedArray = Native;
    }
});

test('nearest cursor matches independent BigInt coordinates across max axes, offsets and layers', () => {
    for (const offset of [0, 1, 4])
        for (const [sw, sh, width, height] of [
            [7, 2, 32768, 3],
            [32768, 1, 17, 3],
            [5, 1, 9, 32768],
        ]) {
            const state = createState(sw, sh, [37, 59, 61, 0], desktopLimits);
            state.layers = [];
            const guards: Uint8Array[] = [],
                retained: Uint8Array[] = [];
            for (let layer = 0; layer < 3; layer++) {
                const bytes = new Uint8Array(offset + sw * sh * 4 + 3).fill(167),
                    pixels = new Uint8ClampedArray(bytes.buffer, offset, sw * sh * 4);
                for (let i = 0; i < sw * sh; i++)
                    pixels.set(
                        [(i * 17 + layer) % 256, 31 + layer, (193 + i * 7) % 256, [0, 1, 128, 255][i % 4]],
                        i * 4,
                    );
                state.layers.push({ name: 'offset ' + layer, visible: layer === 1, pixels });
                guards.push(bytes);
                retained.push(bytes.slice());
            }
            const xs = Array.from({ length: width }, (_, x) =>
                    Number(
                        ((2n * BigInt(x) + 1n) * BigInt(sw) + 2n * BigInt(width) - 1n) /
                            (2n * BigInt(width)) -
                            1n,
                    ),
                ),
                ys = Array.from({ length: height }, (_, y) =>
                    Number(
                        ((2n * BigInt(y) + 1n) * BigInt(sh) + 2n * BigInt(height) - 1n) /
                            (2n * BigInt(height)) -
                            1n,
                    ),
                );
            const steps = resizeNearestSteps(state, width, height, desktopLimits);
            let step = steps.next(),
                chunks = 0;
            while (!step.done) {
                chunks++;
                assert.deepEqual(guards, retained);
                step = steps.next();
            }
            assert(chunks > 1);
            for (let layer = 0; layer < 3; layer++) {
                const output: State['layers'][number] = step.value.layers[layer];
                assert.notEqual(output.pixels.buffer, state.layers[layer].pixels.buffer);
                assert.equal(output.name, state.layers[layer].name);
                assert.equal(output.visible, state.layers[layer].visible);
                for (let y = 0; y < height; y++)
                    for (let x = 0; x < width; x++)
                        for (let c = 0; c < 4; c++)
                            assert.equal(
                                output.pixels[(y * width + x) * 4 + c],
                                state.layers[layer].pixels[(ys[y] * sw + xs[x]) * 4 + c],
                            );
            }
        }
});

test('latest resize target wins after release without intermediate publication or history edits', async () => {
    let intermediate = 0;
    const f = fixture({
        yield(app, turn) {
            if (turn === 3) {
                intermediate = app.selection.width;
                app.pointerMove(event(513, 512));
                app.pointerUp(event(513, 512));
                assert(app.drag.resizeReleased);
                assert.throws(() => app.pendingState(), /크기 변경/);
            }
        },
    });
    const original = cloneState(f.state);
    f.app.pointerMove(event(512, 512));
    await f.pending[0];
    assert.equal(intermediate, 64);
    assert.deepEqual([f.selection.width, f.selection.height], [513, 512]);
    assert.equal(f.app.drag, undefined);
    assert.equal(f.app.selectionResize, undefined);
    assert.equal(f.closed, 2);
    assert.deepEqual(f.state, original);
    assert.equal(f.app.doc.history.length, 0);
    for (let y = 0; y < 512; y++)
        for (let x = 0; x < 513; x++) {
            const sx = Number(((2n * BigInt(x) + 1n) * 64n + 1026n - 1n) / 1026n - 1n),
                sy = Math.floor(y / 8);
            for (let c = 0; c < 4; c++)
                assert.equal(
                    f.selection.pixels[(y * 513 + x) * 4 + c],
                    f.state.layers[0].pixels[(sy * 64 + sx) * 4 + c],
                );
        }
});

test('displayed A to pending B to original A abandons B without resurrecting pixels', async () => {
    const f = fixture({
        yield(app, turn) {
            if (turn === 3) {
                app.pointerMove(event(64, 64));
                app.pointerUp(event(64, 64));
            }
        },
    });
    const pixels = f.selection.pixels;
    f.app.pointerMove(event(512, 512));
    await f.pending[0];
    assert.deepEqual([f.selection.width, f.selection.height, f.selection.modified], [64, 64, false]);
    assert.equal(f.selection.pixels, pixels);
    assert.equal(f.selection.resizeSource, undefined);
    assert.equal(f.app.drag, undefined);
    assert.equal(f.app.selectionResize, undefined);
    assert.equal(f.closed, 2);
});

test('cancel after release restores the gesture snapshot and settles scheduled work', async () => {
    const f = fixture({
        yield(app, turn) {
            if (turn === 3) {
                app.pointerUp(event(512, 512));
                app.cancelPointer();
            }
        },
    });
    const pixels = f.selection.pixels;
    f.app.pointerMove(event(512, 512));
    await f.pending[0];
    assert.equal(f.selection.pixels, pixels);
    assert.deepEqual([f.selection.width, f.selection.height, f.selection.modified], [64, 64, false]);
    assert.equal(f.app.drag, undefined);
    assert.equal(f.app.selectionResize, undefined);
    assert.equal(f.closed, 2);
    assert.equal(f.app.doc.history.length, 0);
});

test('stale resize discards its candidate and never restores an old snapshot onto replacement state', async () => {
    for (const change of ['document', 'selection', 'revision', 'pixels']) {
        let replacement: any;
        const f = fixture({
            yield(app, turn) {
                if (turn === 3) {
                    if (change === 'document') app.doc.reset(createState(17, 19, [37, 59, 61, 128]), true);
                    else if (change === 'selection') {
                        replacement = {
                            ...app.selection,
                            width: 17,
                            pixels: new Uint8ClampedArray(17 * 64 * 4),
                        };
                        app.selection = replacement;
                    } else if (change === 'revision')
                        app.doc.editMetadata('name', { kind: 'layer-name', layer: 0, name: 'new name' });
                    else {
                        replacement = app.selection.pixels.slice();
                        app.selection.pixels = replacement;
                    }
                }
            },
        });
        f.app.pointerMove(event(512, 512));
        await f.pending[0];
        assert.equal(f.app.selectionResize, undefined);
        assert.equal(f.app.drag, undefined);
        if (change === 'document')
            assert.deepEqual([f.app.doc.state.width, f.app.doc.state.height], [17, 19]);
        if (change === 'selection') assert.equal(f.app.selection, replacement);
        if (change === 'pixels') assert.equal(f.app.selection.pixels, replacement);
        assert.equal(f.closed, 2);
    }
});

test('channel setup and partial output write failures preserve the source and permit a new gesture', async () => {
    const f = fixture({ setupFailure: true }),
        original = cloneState(f.state);
    await f.app.resizeSelection(512, 512);
    assert.equal(f.app.selectionResize, undefined);
    assert.equal(f.app.drag, undefined);
    assert.equal(f.closed, 2);
    assert.deepEqual(f.state, original);
    assert.match(f.app.messageText, /Injected/);
    const next = fixture(),
        nativeCopy = Uint8ClampedArray.prototype.copyWithin;
    let injected = false;
    Uint8ClampedArray.prototype.copyWithin = function (this: Uint8ClampedArray, target, start, end) {
        const result = nativeCopy.call(this, target, start, end);
        if (this.length === 512 * 512 * 4 && !injected) {
            injected = true;
            throw Error('Injected resize after write');
        }
        return result;
    };
    try {
        await next.app.resizeSelection(512, 512);
        assert(injected);
        assert.equal(next.selection.pixels, next.drag.selectionRaster.pixels);
        assert.equal(next.app.drag, undefined);
        assert.equal(next.app.selectionResize, undefined);
        assert.equal(next.closed, 2);
    } finally {
        Uint8ClampedArray.prototype.copyWithin = nativeCopy;
    }
    next.app.drag = { ...next.drag };
    await next.app.resizeSelection(512, 512);
    assert.deepEqual([next.selection.width, next.selection.height], [512, 512]);
    assert.equal(next.app.selectionResize, undefined);
});

test('partial layer tails cannot accumulate beyond the cursor work bound', () => {
    const state = createState(600, 100, [17, 31, 193, 0]);
    for (let i = 1; i < 16; i++)
        state.layers.push({ ...state.layers[0], name: 'layer ' + i, pixels: state.layers[0].pixels.slice() });
    const steps = resizeNearestSteps(state, 600, 100);
    let step = steps.next(),
        yields = 0;
    while (!step.done) {
        yields++;
        step = steps.next();
    }
    assert(
        yields >= Math.ceil((16 * 600 * 100) / 65536),
        'every .next must have bounded work across layer boundaries',
    );
    for (const layer of step.value.layers) assert.deepEqual(layer.pixels, state.layers[0].pixels);
});

test('held channel cancellation and bounded timeout settle without publishing or retaining a gesture', async () => {
    for (const timeout of [false, true]) {
        const f = fixture({ hold: true, timeout }),
            pixels = f.selection.pixels;
        const work = f.app.resizeSelection(512, 512);
        if (!timeout) f.app.cancelPointer();
        await work;
        assert.equal(f.selection.pixels, pixels);
        assert.deepEqual([f.selection.width, f.selection.height, f.selection.modified], [64, 64, false]);
        assert.equal(f.app.selectionResize, undefined);
        assert.equal(f.app.drag, undefined);
        assert.equal(f.closed, 2);
        if (timeout) assert.match(f.app.messageText, /시간이 초과/);
    }
});

test('a cancelled old job cannot clear the next gesture or its completed raster', async () => {
    let launched: Promise<void> | undefined;
    const f = fixture({
        yield(app, turn) {
            if (turn === 3) {
                const drag = app.drag;
                app.cancelPointer();
                app.drag = { ...drag, resizeReleased: true };
                launched = app.resizeSelection(513, 512);
            }
        },
    });
    const first = f.app.resizeSelection(512, 512);
    await first;
    assert(launched);
    await launched;
    assert.deepEqual([f.selection.width, f.selection.height], [513, 512]);
    assert.equal(f.app.drag, undefined);
    assert.equal(f.app.selectionResize, undefined);
    assert.equal(f.closed, 4);
});

test('timeout after foreign state replacement never rolls an old snapshot onto the new owner', async () => {
    for (const change of ['document', 'pixels']) {
        const f = fixture({ hold: true, timeout: true }),
            work = f.app.resizeSelection(512, 512);
        const replacement = f.selection.pixels.slice();
        if (change === 'document') f.app.doc.reset(createState(17, 19, [37, 59, 61, 128]), true);
        else f.selection.pixels = replacement;
        await work;
        assert.equal(f.app.drag, undefined);
        assert.equal(f.app.selectionResize, undefined);
        assert.equal(f.app.pointers.size, 0);
        assert.equal(f.closed, 2);
        if (change === 'document')
            assert.deepEqual([f.app.doc.state.width, f.app.doc.state.height], [17, 19]);
        else assert.equal(f.selection.pixels, replacement);
    }
});

test('completed and cancelled asynchronous previews preserve an existing Redo branch and document revision', async () => {
    for (const cancel of [false, true]) {
        const f = fixture({
            yield(app, turn) {
                if (cancel && turn === 3) app.cancelPointer();
            },
        });
        f.app.doc.editMetadata('old redo', { kind: 'layer-name', layer: 0, name: 'existing redo' });
        f.app.doc.undo();
        const revision = f.app.doc.revision,
            cursor = f.app.doc.cursor,
            state = cloneState(f.app.doc.state);
        assert(f.app.doc.canRedo);
        f.drag.resizeReleased = true;
        await f.app.resizeSelection(512, 512);
        assert.equal(f.app.doc.revision, revision);
        assert.equal(f.app.doc.cursor, cursor);
        assert(f.app.doc.canRedo);
        assert.deepEqual(f.app.doc.state, state);
        assert.deepEqual([f.selection.width, f.selection.height], cancel ? [64, 64] : [512, 512]);
    }
});
