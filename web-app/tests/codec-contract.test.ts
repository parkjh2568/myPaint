import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, cloneState, webLimits, type State } from '../src/engine/document';
import { encodeProject, decodeProject, encodePng, decodePng } from '../src/engine/format';
import { applySelectionMask, flood, resizeState } from '../src/engine/operations';
import { runCodec, type SelectionRequest } from '../src/platform/codec';

// Node contract model: actual runCodec/engine fixtures, stubbed Worker and 20s timer.
// No browser, OS clipboard, real Worker scheduling, natural Worker fault or performance claim.
test('codec response contracts and Worker resource ownership in the Node model', async (t) => {
    const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker'),
        originalSetTimeout = globalThis.setTimeout,
        originalClearTimeout = globalThis.clearTimeout,
        source = createState(3, 2, [4, 8, 12, 0]),
        operations = [
            'project-write',
            'png-write',
            'jpg-write',
            'bmp-write',
            'project-read',
            'png-read',
            'geometry',
            'layer-edit',
            'selection',
            'fill',
        ];
    source.layers[0].name = '계약 fixture';
    source.layers[0].pixels.set([
        17, 39, 81, 128, 90, 12, 41, 255, 73, 54, 99, 0, 31, 66, 94, 191, 42, 82, 93, 64, 56, 102, 144, 1,
    ]);
    const sourceBefore = cloneState(source),
        sourceBuffer = source.layers[0].pixels.buffer,
        workers: ContractWorker[] = [],
        timers = new Map<ReturnType<typeof setTimeout>, () => void>();
    let timerId = 0,
        constructions = 0,
        hold = false,
        constructorFailure = false,
        postFailure = false,
        changeReply: ((reply: Record<string, unknown>) => unknown) | undefined;

    // This fixture owns transferred candidate buffers, controlled replies and termination.
    class ContractWorker {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        onmessageerror: ((event: MessageEvent) => void) | null = null;
        reply: unknown;
        terminated = false;
        terminateCalls = 0;
        constructor(_url: string | URL, _options?: WorkerOptions) {
            constructions++;
            if (constructorFailure) {
                constructorFailure = false;
                throw Error('contract constructor failure');
            }
            workers.push(this);
        }
        postMessage(value: unknown, transfer: Transferable[] = []): void {
            if (postFailure) {
                postFailure = false;
                throw Error('contract post failure');
            }
            const request = structuredClone(value, { transfer }) as {
                operation: string;
                state?: State;
                bytes?: Uint8Array;
                profileId: string;
                selection?: SelectionRequest;
            };
            let reply: Record<string, unknown> = { profileId: request.profileId };
            if (request.operation === 'project-read') reply.state = decodeProject(request.bytes!);
            else if (request.operation === 'png-read') reply.image = decodePng(request.bytes!);
            else if (request.operation === 'project-write') reply.bytes = encodeProject(request.state!);
            else if (['png-write', 'jpg-write', 'bmp-write'].includes(request.operation)) {
                // Real engine PNG bytes isolate the response shape from format-specific tests.
                reply.bytes = encodePng(3, 2, request.state!.layers[0].pixels);
            } else if (request.operation === 'geometry')
                reply.state = resizeState(request.state!, 2, 3, false, false);
            else if (request.operation === 'layer-edit') {
                const candidate = request.state!;
                for (let i = 0; i < candidate.layers[0].pixels.length; i += 4)
                    for (let channel = 0; channel < 3; channel++)
                        candidate.layers[0].pixels[i + channel] =
                            255 - candidate.layers[0].pixels[i + channel];
                reply.state = candidate;
            } else if (request.operation === 'selection') {
                const candidate = request.state!,
                    selection = request.selection!,
                    path: { x: number; y: number }[] = [];
                for (let i = 0; i < selection.points.length; i += 2)
                    path.push({ x: selection.points[i], y: selection.points[i + 1] });
                reply.bytes = applySelectionMask(
                    candidate.layers[0].pixels,
                    candidate.width,
                    candidate.height,
                    selection.left,
                    selection.top,
                    path,
                    selection.key,
                    selection.transparent,
                );
                reply.image = {
                    width: candidate.width,
                    height: candidate.height,
                    pixels: candidate.layers[0].pixels,
                };
            } else if (request.operation === 'fill') {
                const candidate = request.state!;
                reply.image = flood(candidate.layers[0].pixels, 3, 2, 0, 0, [91, 122, 153, 255]);
            } else reply.error = 'contract unsupported operation';
            const mutate = changeReply;
            changeReply = undefined;
            this.reply = mutate ? mutate(reply) : reply;
            if (!hold) queueMicrotask(() => this.onmessage?.({ data: this.reply } as MessageEvent));
        }
        terminate(): void {
            this.terminateCalls++;
            this.terminated = true;
        }
    }

    // Each request owns a fresh candidate and verifies the original stays attached and exact.
    const start = (operation: string, signal?: AbortSignal) => {
        const candidate = cloneState(source);
        let state: State | undefined = candidate,
            bytes: Uint8Array | undefined,
            selection: SelectionRequest | undefined;
        if (operation === 'project-read') {
            state = undefined;
            bytes = encodeProject(candidate);
        } else if (operation === 'png-read') {
            state = undefined;
            bytes = encodePng(candidate.width, candidate.height, candidate.layers[0].pixels);
        } else if (operation === 'jpg-write' || operation === 'bmp-write')
            bytes = Uint8Array.of(255, 255, 255, 255);
        else if (operation === 'geometry')
            bytes = new TextEncoder().encode(JSON.stringify({ kind: 'resize', width: 2, height: 3 }));
        else if (operation === 'layer-edit') bytes = new TextEncoder().encode('invert');
        else if (operation === 'fill') bytes = Uint8Array.of(0, 0, 0, 0, 91, 122, 153, 255);
        else if (operation === 'selection')
            selection = {
                points: Float64Array.of(0, 0, 3, 0, 3, 2, 0, 2),
                left: 0,
                top: 0,
                key: [0, 0, 0, 0],
                transparent: false,
            };
        return runCodec(operation, state, bytes, signal, webLimits, selection).finally(() => {
            assert.equal(source.layers[0].pixels.buffer, sourceBuffer);
            assert.equal(source.layers[0].pixels.byteLength, 24);
            assert.deepEqual(source, sourceBefore);
        });
    };
    try {
        Object.defineProperty(globalThis, 'Worker', { configurable: true, value: ContractWorker });
        globalThis.setTimeout = ((
            callback: (...args: unknown[]) => void,
            delay?: number,
            ...args: unknown[]
        ) => {
            if (delay !== 20000) return originalSetTimeout(callback, delay, ...args);
            const timer = { contractTimer: ++timerId } as unknown as ReturnType<typeof setTimeout>;
            timers.set(timer, () => callback(...args));
            return timer;
        }) as typeof setTimeout;
        globalThis.clearTimeout = ((...args: Parameters<typeof clearTimeout>) => {
            const timer = args[0] as ReturnType<typeof setTimeout>;
            if (!timers.delete(timer)) originalClearTimeout(...args);
        }) as typeof clearTimeout;
        for (const operation of operations) {
            await t.test(`${operation}: valid required payload resolves`, async () => {
                const before = workers.length,
                    result = await start(operation);
                assert.equal(workers.length, before + 1);
                assert.equal(workers.at(-1)!.terminateCalls, 1);
                assert.equal(timers.size, 0);
                if (operation.endsWith('-write')) assert(result.bytes instanceof Uint8Array);
                else if (['project-read', 'geometry', 'layer-edit'].includes(operation))
                    assert(result.state!.layers[0].pixels instanceof Uint8ClampedArray);
                else assert(result.image!.pixels instanceof Uint8ClampedArray);
            });
        }
        for (const operation of operations) {
            const slots = operation.endsWith('-write')
                ? ['bytes']
                : ['project-read', 'geometry', 'layer-edit'].includes(operation)
                  ? ['state']
                  : operation === 'selection'
                    ? ['image', 'bytes']
                    : ['image'];
            for (const slot of slots)
                for (const kind of ['missing', 'null', 'empty', 'wrong-type']) {
                    await t.test(`${operation}: ${kind} ${slot} rejects`, async () => {
                        changeReply = (reply) => {
                            if (kind === 'missing') delete reply[slot];
                            else if (kind === 'null') reply[slot] = null;
                            else if (kind === 'empty') reply[slot] = slot === 'bytes' ? new Uint8Array() : {};
                            else reply[slot] = slot === 'bytes' ? new Uint8ClampedArray(1) : false;
                            return reply;
                        };
                        await assert.rejects(start(operation));
                        assert.equal(workers.at(-1)!.terminateCalls, 1);
                        assert.equal(timers.size, 0);
                    });
                }
        }
        for (const operation of ['project-read', 'geometry', 'layer-edit'])
            for (const kind of ['array', 'uint8']) {
                await t.test(`${operation}: ${kind} state plane rejects`, async () => {
                    changeReply = (reply) => {
                        const state = reply.state as State;
                        state.layers[0].pixels = (kind === 'array'
                            ? Array.from(state.layers[0].pixels)
                            : Uint8Array.from(state.layers[0].pixels)) as unknown as Uint8ClampedArray;
                        return reply;
                    };
                    await assert.rejects(start(operation));
                    assert.equal(timers.size, 0);
                });
            }
        for (const operation of ['project-read', 'geometry', 'layer-edit']) {
            await t.test(
                `${operation}: sparse background channels reject before state publication`,
                async () => {
                    changeReply = (reply) => {
                        const state = reply.state as State;
                        state.background = new Array(4) as unknown as State['background'];
                        return reply;
                    };
                    await assert.rejects(start(operation));
                    assert.equal(workers.at(-1)!.terminateCalls, 1);
                    assert.equal(timers.size, 0);
                },
            );
        }
        await t.test('selection: mask length must match exact candidate pixels', async () => {
            changeReply = (reply) => ({ ...reply, bytes: new Uint8Array(5) });
            await assert.rejects(start('selection'));
        });
        await t.test('selection: valid raster with wrong candidate dimensions rejects', async () => {
            changeReply = (reply) => ({
                ...reply,
                image: { width: 2, height: 3, pixels: new Uint8ClampedArray(24) },
            });
            await assert.rejects(start('selection'));
        });
        for (const [kind, coordinates] of [
            ['missing-left', { left: undefined, top: 0 }],
            ['negative-left', { left: -1, top: 0 }],
            ['fractional-top', { left: 0, top: 0.5 }],
            ['outside-right', { left: 3, top: 0 }],
            ['outside-bottom', { left: 0, top: 2 }],
        ] as const) {
            await t.test(`fill: ${kind} ROI rejects`, async () => {
                changeReply = (reply) => ({
                    ...reply,
                    image: { ...(reply.image as object), ...coordinates },
                });
                await assert.rejects(start('fill'));
            });
        }
        await t.test('fill: own image undefined is a valid engine NoOp', async () => {
            changeReply = (reply) => ({
                ...reply,
                image: flood(sourceBefore.layers[0].pixels.slice(), 3, 2, 0, 0, [17, 39, 81, 128]),
            });
            const result = await start('fill');
            assert(Object.prototype.hasOwnProperty.call(result, 'image'));
            assert.equal(result.image, undefined);
            assert.equal(timers.size, 0);
        });
        await t.test('unsupported operation rejects before Worker, timer or transfer', async () => {
            const before = constructions,
                candidate = cloneState(source),
                buffer = candidate.layers[0].pixels.buffer;
            await assert.rejects(runCodec('contract-unknown', candidate));
            assert.equal(constructions, before);
            assert.equal(candidate.layers[0].pixels.buffer, buffer);
            assert.equal(candidate.layers[0].pixels.byteLength, 24);
            assert.equal(timers.size, 0);
        });
        for (const kind of ['null-envelope', 'wrong-profile', 'worker-error-reply']) {
            await t.test(`${kind}: rejects, terminates and permits the next request`, async () => {
                changeReply = (reply) =>
                    kind === 'null-envelope'
                        ? null
                        : kind === 'wrong-profile'
                          ? { ...reply, profileId: 'desktop' }
                          : { profileId: reply.profileId, error: 'contract Worker error reply' };
                await assert.rejects(start('project-write'));
                assert.equal(workers.at(-1)!.terminateCalls, 1);
                assert.equal(timers.size, 0);
                assert((await start('project-write')).bytes instanceof Uint8Array);
            });
        }
        for (const [kind, error] of [
            ['undefined', undefined],
            ['null', null],
            ['empty-string', ''],
            ['false', false],
        ] as const) {
            await t.test(`own ${kind} error field rejects even with valid bytes`, async () => {
                changeReply = (reply) => ({ ...reply, error });
                await assert.rejects(start('project-write'));
                assert.equal(workers.at(-1)!.terminateCalls, 1);
                assert.equal(timers.size, 0);
                assert((await start('project-write')).bytes instanceof Uint8Array);
            });
        }
        await t.test('constructor failure releases its active slot without a Worker or timer', async () => {
            const before = workers.length;
            constructorFailure = true;
            await assert.rejects(start('project-write'), /contract constructor failure/);
            assert.equal(workers.length, before);
            assert.equal(timers.size, 0);
            assert((await start('project-write')).bytes instanceof Uint8Array);
        });
        await t.test('postMessage failure terminates its Worker and clears the timer', async () => {
            postFailure = true;
            await assert.rejects(start('project-write'), /contract post failure/);
            assert.equal(workers.at(-1)!.terminateCalls, 1);
            assert.equal(timers.size, 0);
            assert((await start('project-write')).bytes instanceof Uint8Array);
        });
        await t.test('Worker onerror rejects and releases resources for retry', async () => {
            hold = true;
            const pending = start('project-write'),
                worker = workers.at(-1)!;
            let prevented = false;
            try {
                worker.onerror!({
                    message: 'contract onerror',
                    preventDefault() {
                        prevented = true;
                    },
                } as ErrorEvent);
                await assert.rejects(pending, /contract onerror/);
                assert(prevented);
                assert.equal(worker.terminateCalls, 1);
                assert.equal(timers.size, 0);
            } finally {
                hold = false;
            }
            assert((await start('project-write')).bytes instanceof Uint8Array);
        });
        await t.test('synthetic messageerror rejects immediately and permits retry', async () => {
            hold = true;
            const pending = start('project-write'),
                worker = workers.at(-1)!;
            try {
                assert.equal(typeof worker.onmessageerror, 'function');
                worker.onmessageerror!({ data: undefined } as MessageEvent);
                await assert.rejects(pending, /읽지 못/);
                assert.equal(worker.terminateCalls, 1);
                assert.equal(timers.size, 0);
            } finally {
                // Baseline has no messageerror handler: settle through its controlled timeout.
                if (!worker.terminated) {
                    timers.values().next().value?.();
                    await pending.catch(() => {});
                }
                hold = false;
            }
            assert((await start('project-write')).bytes instanceof Uint8Array);
        });
        await t.test('already aborted signal rejects before Worker creation or transfer', async () => {
            const controller = new AbortController(),
                before = constructions,
                candidate = cloneState(source);
            controller.abort();
            await assert.rejects(runCodec('project-write', candidate, undefined, controller.signal));
            assert.equal(constructions, before);
            assert.equal(candidate.layers[0].pixels.byteLength, 24);
            assert.equal(timers.size, 0);
        });
        await t.test('in-flight abort clears its timer/listener and releases the Worker once', async () => {
            const controller = new AbortController(),
                signal = controller.signal,
                add = signal.addEventListener.bind(signal),
                remove = signal.removeEventListener.bind(signal);
            let added = 0,
                removed = 0;
            Object.defineProperty(signal, 'addEventListener', {
                value: (...args: Parameters<AbortSignal['addEventListener']>) => {
                    if (args[0] === 'abort') added++;
                    Reflect.apply(add, undefined, args);
                },
            });
            Object.defineProperty(signal, 'removeEventListener', {
                value: (...args: Parameters<AbortSignal['removeEventListener']>) => {
                    if (args[0] === 'abort') removed++;
                    Reflect.apply(remove, undefined, args);
                },
            });
            hold = true;
            const pending = start('project-write', signal),
                worker = workers.at(-1)!;
            try {
                controller.abort();
                await assert.rejects(pending, /취소/);
                assert.equal(added, 1);
                assert.equal(removed, 1);
                assert.equal(worker.terminateCalls, 1);
                assert.equal(timers.size, 0);
            } finally {
                hold = false;
            }
            assert((await start('project-write')).bytes instanceof Uint8Array);
        });
        await t.test('controlled 20s timeout rejects and frees the Worker without a real wait', async () => {
            hold = true;
            const pending = start('project-write'),
                worker = workers.at(-1)!;
            try {
                assert.equal(timers.size, 1);
                timers.values().next().value!();
                await assert.rejects(pending, /시간이 초과/);
                assert.equal(worker.terminateCalls, 1);
                assert.equal(timers.size, 0);
            } finally {
                hold = false;
            }
            assert((await start('project-write')).bytes instanceof Uint8Array);
        });
        await t.test('two active slots reject a third and return only the completed slot', async () => {
            hold = true;
            const before = workers.length,
                first = start('project-write'),
                firstWorker = workers.at(-1)!,
                second = start('project-write'),
                secondWorker = workers.at(-1)!;
            let replacement: ReturnType<typeof start> | undefined;
            try {
                await assert.rejects(start('project-write'), /진행 중/);
                assert.equal(workers.length, before + 2);
                assert.equal(timers.size, 2);
                firstWorker.onmessage!({ data: firstWorker.reply } as MessageEvent);
                await first;
                assert.equal(firstWorker.terminateCalls, 1);
                assert.equal(timers.size, 1);
                replacement = start('project-write');
                assert.equal(workers.length, before + 3);
                assert.equal(timers.size, 2);
                await assert.rejects(start('project-write'), /진행 중/);
            } finally {
                for (const worker of workers.slice(before))
                    if (!worker.terminated) worker.onmessage!({ data: worker.reply } as MessageEvent);
                await Promise.allSettled([first, second, replacement]);
                hold = false;
            }
            assert.equal(secondWorker.terminateCalls, 1);
            assert.equal(timers.size, 0);
        });
        await t.test(
            'late duplicate reply cannot terminate twice or release another active slot',
            async () => {
                const completed = await start('project-write'),
                    oldWorker = workers.at(-1)!,
                    late = oldWorker.onmessage!;
                assert(completed.bytes instanceof Uint8Array);
                late({ data: oldWorker.reply } as MessageEvent);
                late({ data: { profileId: 'web', error: 'late duplicate error' } } as MessageEvent);
                assert.equal(oldWorker.terminateCalls, 1);
                hold = true;
                const before = workers.length,
                    first = start('project-write'),
                    second = start('project-write');
                try {
                    late({ data: oldWorker.reply } as MessageEvent);
                    await assert.rejects(start('project-write'), /진행 중/);
                    assert.equal(workers.length, before + 2);
                    assert.equal(timers.size, 2);
                } finally {
                    for (const worker of workers.slice(before))
                        if (!worker.terminated) worker.onmessage!({ data: worker.reply } as MessageEvent);
                    await Promise.allSettled([first, second]);
                    hold = false;
                }
                assert.equal(oldWorker.terminateCalls, 1);
                assert.equal(timers.size, 0);
            },
        );
        assert.equal(timers.size, 0);
        assert(workers.every((worker) => worker.terminated && worker.terminateCalls === 1));
        assert.deepEqual(source, sourceBefore);
        assert.equal(source.layers[0].pixels.buffer, sourceBuffer);
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
        if (originalWorker) Object.defineProperty(globalThis, 'Worker', originalWorker);
        else Reflect.deleteProperty(globalThis, 'Worker');
    }
});
