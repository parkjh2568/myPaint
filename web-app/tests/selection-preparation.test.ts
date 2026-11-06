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
    type State,
} from '../src/engine/document';
import { applySelectionMask, polygonMask } from '../src/engine/operations';
import type { SelectionRequest } from '../src/platform/codec';

test('shared selection algorithm preserves all literal Qt mask bytes, raw RGB and key policy', () => {
    let cases = 0,
        keyMatches = 0;
    for (const file of ['polygon-mask-qt.json', 'polygon-mask-dense-qt.json']) {
        const fixture = JSON.parse(readFileSync(new URL('./fixtures/' + file, import.meta.url), 'utf8'));
        for (const spec of fixture.cases) {
            const path = spec.rawPoints.map(([x, y]: number[]) => ({ x, y })),
                palette = [
                    [63, 127, 191, 1],
                    [100, 100, 200, 1],
                    [128, 127, 191, 1],
                    [63, 127, 191, 128],
                    [193, 71, 117, 0],
                ],
                source = Uint8ClampedArray.from(
                    { length: spec.width * spec.height * 4 },
                    (_, i) => palette[Math.floor(i / 4) % palette.length][i % 4],
                ),
                mask = Uint8Array.from(spec.maskRows.join(''), (p: string) => (p === '#' ? 255 : 0));
            for (const transparent of [false, true]) {
                const pixels = source.slice(),
                    key: [number, number, number, number] = [63, 127, 191, 1];
                const actual = applySelectionMask(
                    pixels,
                    spec.width,
                    spec.height,
                    spec.left ?? 0,
                    spec.top ?? 0,
                    path,
                    key,
                    transparent,
                );
                assert.deepEqual(actual, mask, spec.name);
                for (let i = 0; i < source.length; i += 4) {
                    assert.deepEqual(pixels.subarray(i, i + 3), source.subarray(i, i + 3));
                    const alpha = mask[i / 4] ? source[i + 3] : 0,
                        matches =
                            transparent &&
                            alpha === key[3] &&
                            [0, 1, 2].every(
                                (c) =>
                                    Math.round((source[i + c] * key[3]) / 255) ===
                                    Math.round((key[c] * key[3]) / 255),
                            );
                    if (matches && alpha) keyMatches++;
                    assert.equal(pixels[i + 3], matches ? 0 : alpha);
                }
            }
            cases++;
        }
    }
    assert.equal(cases, 883);
    assert(keyMatches > 0, 'fixtures must exercise actual premultiplied key removal');
});

test('shared selection validation precedes candidate alpha mutation and supports offset-owned views', () => {
    const backing = new Uint8ClampedArray(32).fill(193),
        pixels = backing.subarray(3, 19),
        before = backing.slice();
    for (const key of [undefined, [0, 0, 0], [0, -1, 0, 255], [0, 0, 0, NaN]]) {
        assert.throws(() => applySelectionMask(pixels, 2, 2, 0, 0, [], key as never, true));
        assert.deepEqual(backing, before);
    }
    assert.throws(() => applySelectionMask(pixels, 2, 2, 0, 0, [{ x: Infinity, y: 0 }], [0, 0, 0, 0], true));
    assert.deepEqual(backing, before);
    assert.equal(applySelectionMask(pixels, 2, 2, 0, 0, undefined, [193, 193, 193, 193], true), undefined);
    for (let i = 0; i < backing.length; i++)
        assert.equal(backing[i], i >= 3 && i < 19 && (i - 3) % 4 === 3 ? 0 : 193);
});

test('shipped Worker selection protocol preserves full global coordinates and rejects malformed requests', async () => {
    const channel = globalThis as unknown as {
            onmessage?: (event: MessageEvent) => Promise<void>;
            postMessage?: (data: any, transfers?: Transferable[]) => void;
        },
        originalMessage = channel.onmessage,
        originalPost = channel.postMessage;
    let reply: any, transfers: Transferable[] | undefined;
    try {
        channel.postMessage = (data, transfer) => {
            reply = data;
            transfers = transfer;
        };
        await import('../src/workers/codec.worker');
        const state = createState(4, 3, [63, 127, 191, 1]),
            selection: SelectionRequest = {
                points: Float64Array.of(10, 20, 14, 20, 10, 23),
                left: 10,
                top: 20,
                key: [63, 127, 191, 1],
                transparent: true,
            };
        const send = async (change: Record<string, unknown> = {}) => {
            reply = undefined;
            await channel.onmessage!(
                new MessageEvent('message', {
                    data: {
                        profileId: 'web',
                        operation: 'selection',
                        state: cloneState(state),
                        selection,
                        ...change,
                    },
                }),
            );
            return reply;
        };
        const good = await send();
        assert.equal(good.error, undefined);
        assert.deepEqual(
            good.bytes,
            polygonMask(
                [
                    { x: 10, y: 20 },
                    { x: 14, y: 20 },
                    { x: 10, y: 23 },
                ],
                10,
                20,
                4,
                3,
            ),
        );
        assert(
            good.image.pixels.every((value: number, i: number) =>
                i % 4 === 3 ? value === 0 : value === [63, 127, 191][i % 4],
            ),
        );
        assert.deepEqual(transfers, [good.image.pixels.buffer, good.bytes.buffer]);
        for (const request of [
            undefined,
            { ...selection, points: new Uint8Array(6) },
            { ...selection, points: Float64Array.of(0) },
            { ...selection, points: new Float64Array(8).subarray(2) },
            { ...selection, points: Float64Array.of(NaN, 0) },
            { ...selection, points: Float64Array.of(8388608, 0) },
            { ...selection, left: -1 },
            { ...selection, left: 4095 },
            { ...selection, top: 0.5 },
            { ...selection, key: [1, 2, 3] },
            { ...selection, transparent: 1 },
        ]) {
            assert.match((await send({ selection: request })).error, /선택/);
        }
        assert.match((await send({ profileId: 'unknown' })).error, /프로필/);
        const offset = cloneState(state),
            backing = new Uint8ClampedArray(offset.layers[0].pixels.length + 1);
        offset.layers[0].pixels = backing.subarray(1);
        assert.match((await send({ state: offset })).error, /선택/);
        assert.deepEqual(state.layers[0].pixels, createState(4, 3, [63, 127, 191, 1]).layers[0].pixels);
    } finally {
        channel.onmessage = originalMessage;
        channel.postMessage = originalPost;
    }
});

// Execute the shipped methods without booting the DOM. Only scheduling, task UI and codec delivery are modeled.
const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'),
    ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true),
    studio = ast.statements.find(
        (node) => ts.isClassDeclaration(node) && node.name?.text === 'Studio',
    ) as ts.ClassDeclaration,
    methods = studio.members.filter(
        (node) =>
            ts.isMethodDeclaration(node) &&
            ['prepareSelection', 'makeSelection', 'hasPending', 'cancelPointer', 'pointerUp'].includes(
                node.name.getText(ast),
            ),
    ),
    compiled = ts.transpileModule(
        'class TestStudio {' + methods.map((node) => node.getText(ast)).join('\n') + '}\nreturn TestStudio;',
        { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
    ).outputText;

function fixture(
    options: {
        atYield?: (instance: any, count: number) => void;
        codec?: (instance: any, result: any, signal: AbortSignal) => Promise<void> | void;
        channelSetupFail?: boolean;
        taskFail?: boolean;
    } = {},
) {
    let count = 0,
        closed = 0,
        calls = 0,
        instance: any;
    class Channel {
        port1: any = { close: () => closed++ };
        port2 = {
            close: () => closed++,
            postMessage: () =>
                setImmediate(() => {
                    count++;
                    options.atYield?.(instance, count);
                    this.port1.onmessage?.({});
                }),
        };
        constructor() {
            if (options.channelSetupFail)
                Object.defineProperty(this.port1, 'onmessage', {
                    set(value) {
                        if (value) throw Error('Injected channel setup failure');
                    },
                });
        }
    }
    const codec = async (
        operation: string,
        candidate: State,
        _bytes: undefined,
        signal: AbortSignal,
        _profile: unknown,
        request: SelectionRequest,
    ) => {
        calls++;
        assert.equal(operation, 'selection');
        assert.notEqual(candidate.layers[0].pixels.buffer, instance.doc.state.layers[0].pixels.buffer);
        const owned = structuredClone(
            { candidate, request },
            { transfer: [candidate.layers[0].pixels.buffer, request.points.buffer] },
        );
        assert.equal(candidate.layers[0].pixels.byteLength, 0);
        const pixels = owned.candidate.layers[0].pixels,
            path = Array.from({ length: owned.request.points.length / 2 }, (_, i) => ({
                x: owned.request.points[i * 2],
                y: owned.request.points[i * 2 + 1],
            })),
            mask = applySelectionMask(
                pixels,
                owned.candidate.width,
                owned.candidate.height,
                request.left,
                request.top,
                path,
                request.key,
                request.transparent,
            ),
            result = {
                image: { width: owned.candidate.width, height: owned.candidate.height, pixels },
                bytes: mask,
            };
        await options.codec?.(instance, result, signal);
        signal.throwIfAborted();
        return result;
    };
    const Constructor = new Function(
        'applySelectionMask',
        'runCodec',
        'validateSize',
        'runtimeProfile',
        'MessageChannel',
        'devicePixelRatio',
        compiled,
    )(applySelectionMask, codec, validateSize, webLimits, Channel, 1);
    instance = new Constructor();
    Object.assign(instance, {
        doc: new PaintDocument(createState(300, 300, [63, 127, 191, 1])),
        epoch: 1,
        tool: 'lasso',
        secondary: [63, 127, 191, 1],
        transparentSelection: true,
        points: [],
        pointers: new Map(),
        viewWidth: 300,
        viewLeft: 0,
        viewTop: 0,
        viewHeight: 300,
        workspace: { getBoundingClientRect: () => ({ width: 300, height: 300, left: 0, top: 0 }) },
        canvas: {
            width: 300,
            height: 300,
            getBoundingClientRect: () => ({ width: 300, height: 300, left: 0, top: 0 }),
            dataset: {},
            setAttribute() {},
            hasPointerCapture: () => false,
        },
        busy: false,
        abort: undefined as AbortController | undefined,
        sync() {},
        draw() {},
        resizeView() {},
        stopSpray() {},
        task: async function (_label: string, work: (signal: AbortSignal) => Promise<void>) {
            if (options.taskFail) throw Error('Injected task setup failure');
            this.busy = true;
            this.abort = new AbortController();
            try {
                await work(this.abort.signal);
            } finally {
                this.busy = false;
                this.abort = undefined;
            }
        },
    });
    return {
        instance,
        stats: () => ({ count, closed, calls }),
        path: [
            { x: 10, y: 20, pressure: 1 },
            { x: 290, y: 20, pressure: 1 },
            { x: 10, y: 290, pressure: 1 },
        ],
    };
}

test('large selection matches immediate selection, keeps history and source attached, and tracks pending during preparation', async () => {
    const { instance, path, stats } = fixture(),
        before = cloneState(instance.doc.state);
    instance.makeSelection(10, 20, 280, 270, path);
    const expected = instance.selection;
    instance.selection = undefined;
    const job = instance.prepareSelection(path);
    assert.equal(instance.busy, true);
    assert.equal(instance.hasPending(), true);
    await job;
    assert.deepEqual(instance.selection, expected);
    assert.equal(instance.selection.originalPixels, instance.selection.pixels);
    assert.equal(instance.selectionPreparation, undefined);
    assert.equal(instance.busy, false);
    assert.deepEqual(instance.doc.state, before);
    assert.equal(instance.doc.history.length, 0);
    assert.deepEqual(stats(), { count: 6, closed: 2, calls: 1 });
});

test('cancellation settles the current channel waiter in packing, crop and result validation', async () => {
    for (const cancelAt of [1, 2, 3, 4, 5, 6]) {
        const { instance, path, stats } = fixture({
                atYield: (owner, count) => {
                    if (count === cancelAt) owner.cancelPointer();
                },
            }),
            before = cloneState(instance.doc.state);
        await assert.rejects(instance.prepareSelection(path), /취소|abort/i);
        assert.equal(instance.selection, undefined);
        assert.equal(instance.selectionPreparation, undefined);
        assert.equal(instance.busy, false);
        assert.equal(stats().closed, 2);
        assert.deepEqual(instance.doc.state, before);
        assert.equal(instance.doc.history.length, 0);
    }
});

test('task and channel setup failures clear only their own pending marker and release ports', async () => {
    for (const options of [{ taskFail: true }, { channelSetupFail: true }]) {
        const { instance, path, stats } = fixture(options);
        await assert.rejects(instance.prepareSelection(path), /Injected/);
        assert.equal(instance.selectionPreparation, undefined);
        assert.equal(instance.busy, false);
        assert.equal(stats().closed, options.channelSetupFail ? 2 : 0);
    }
});

test('late results cannot replace a different document, layer, policy, gesture or selection job', async () => {
    const mutations = [
        (owner: any) => owner.doc.reset(createState(3, 3)),
        (owner: any) => owner.epoch++,
        (owner: any) => owner.doc.revision++,
        (owner: any) => (owner.doc.state.active = 1),
        (owner: any) => (owner.doc.state.layers[0].pixels = owner.doc.state.layers[0].pixels.slice()),
        (owner: any) => owner.secondary[0]++,
        (owner: any) => (owner.transparentSelection = false),
        (owner: any) => (owner.tool = 'brush'),
        (owner: any) => (owner.drag = {}),
        (owner: any) => (owner.selection = { other: true }),
        (owner: any) => (owner.selectionPreparation = { other: true }),
    ];
    for (const mutate of mutations) {
        const { instance, path } = fixture({ codec: mutate });
        await instance.prepareSelection(path);
        assert.equal(instance.selection?.originalPixels, undefined);
        assert.equal(
            instance.selectionPreparation?.other,
            mutations.indexOf(mutate) === 10 ? true : undefined,
        );
        assert.equal(instance.busy, false);
    }
});

test('malformed Worker ROI, absent planes and nonbinary masks never publish', async () => {
    for (const corrupt of [
        (r: any) => r.image.width++,
        (r: any) => delete r.image,
        (r: any) => delete r.bytes,
        (r: any) => (r.bytes = r.bytes.subarray(1)),
        (r: any) => (r.bytes[0] = 1),
    ]) {
        const { instance, path } = fixture({ codec: (_owner, result) => corrupt(result) });
        await assert.rejects(instance.prepareSelection(path), /선택/);
        assert.equal(instance.selection, undefined);
        assert.equal(instance.busy, false);
        assert.equal(instance.selectionPreparation, undefined);
    }
});

test('unrelated pointercancel cannot cancel a released-owner selection preparation', async () => {
    const { instance, path } = fixture({
        atYield: (owner, count) => {
            if (count === 1) owner.cancelPointer(999);
        },
    });
    await instance.prepareSelection(path);
    assert(instance.selection);
    assert.equal(instance.busy, false);
});

test('large lasso release stays void and transfers async error handling through the same sink for chord callers', async () => {
    const { instance, path } = fixture();
    const points = Array.from({ length: 8192 }, (_, i) => path[i % 3]),
        event = { pointerId: 1 },
        tasks: Promise<void>[] = [];
    instance.points = points;
    instance.pointers.set(1, {});
    instance.drag = { pointer: 1, mode: 'lasso', start: path[0], last: path[2] };
    instance.pointerMove = () => {};
    instance.run = (work: () => Promise<void>, ownsPointer?: boolean) => {
        assert.equal(ownsPointer, undefined);
        const task = work().catch((error: unknown) => {
            throw error;
        });
        tasks.push(task);
        return task;
    };
    assert.equal(instance.pointerUp(event), undefined);
    assert.equal(instance.drag, undefined);
    assert.equal(instance.points.length, 0);
    assert.equal(instance.hasPending(), true);
    assert.equal(tasks.length, 1);
    await tasks[0];
    assert(instance.selection);
});
