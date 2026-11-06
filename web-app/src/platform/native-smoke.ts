import { PaintDocument, createState, type BrushSettings, type ResourceProfile } from '../engine/document';
import type { Studio } from '../main';
import { runCodec, readArtwork, exportBytes } from './codec';
import { activateNative } from './native';
import type { RecoveryEntry } from './storage';
import { FinalSceneCache } from './tiles';

export async function runNativeSmoke(studio: Studio, runtimeProfile: ResourceProfile): Promise<void> {
    await studio.nativeReady;
    if (await window.__TAURI__!.core.invoke<boolean>('render_smoke_mode')) {
        const setupStarted = performance.now();
        studio.busy = true;
        // Let the constructor's 500ms recovery check finish before installing the timed document.
        await new Promise<void>((resolve) => setTimeout(resolve, 750));
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        if (studio.frame) cancelAnimationFrame(studio.frame);
        studio.frame = 0;
        const startupDrainMs = performance.now() - setupStarted,
            canvas = studio.canvas,
            context = studio.ctx,
            candidate = studio.sceneCache,
            referenceCanvas = document.createElement('canvas');
        const state = createState(2048, 2048, [0, 0, 0, 0], runtimeProfile),
            hashes: string[] = [],
            checks: string[] = [];
        const renderTimings: object[] = [],
            correctnessCosts: object[] = [];
        let authorityHashBeforeMs = 0,
            authorityHashAfterMs = 0;
        let reference = new FinalSceneCache(64, 512 * 512 * 8),
            maxTiles = 0,
            maxBytes = 0,
            unchangedUploads = -1;
        try {
            for (let layer = 0; layer < 16; layer++) {
                if (layer)
                    state.layers.push({
                        name: '레이어 ' + layer,
                        visible: true,
                        pixels: new Uint8ClampedArray(2048 * 2048 * 4),
                    });
                const pixels = state.layers[layer].pixels,
                    color = Uint8Array.from([
                        (layer * 37) % 251,
                        31 + layer * 11,
                        223 - layer * 7,
                        64 + layer * 9,
                    ]),
                    word = new Uint32Array(color.buffer)[0];
                new Uint32Array(pixels.buffer).fill(word);
                for (let y = layer; y < 2048; y += 31)
                    for (let x = layer * 3; x < 2048; x += 47)
                        pixels.set([193, 71, 117, 0], (y * 2048 + x) * 4);
                const hashStarted = performance.now();
                hashes.push(
                    Array.from(
                        new Uint8Array(
                            await crypto.subtle.digest('SHA-256', pixels as Uint8ClampedArray<ArrayBuffer>),
                        ),
                    ).join(','),
                );
                authorityHashBeforeMs += performance.now() - hashStarted;
            }
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            if (studio.frame) cancelAnimationFrame(studio.frame);
            studio.frame = 0;
            state.active = 15;
            studio.doc.reset(state, true);
            studio.autoFit = false;
            studio.zoom = 1;
            studio.offsetX = -301.25;
            studio.offsetY = -153.5;
            studio.selection = undefined;
            studio.points = [];
            studio.curveControls = [];
            studio.fullPixels = true;
            const dpr = canvas.width / Math.max(1, studio.viewWidth),
                x = Math.floor(512 / dpr - studio.offsetX) - 8,
                y = Math.floor(512 / dpr - studio.offsetY) - 8,
                active = state.layers[15].pixels,
                backup = new Uint8ClampedArray(16 * 16 * 4);
            // Keep additional test readbacks and reference rendering after the timing batch.
            for (let row = 0; row < 16; row++) {
                const start = ((y + row) * 2048 + x) * 4;
                backup.set(active.subarray(start, start + 16 * 4), row * 16 * 4);
            }
            const timingWidth = canvas.width,
                timingHeight = canvas.height,
                timingViewWidth = studio.viewWidth,
                timingViewHeight = studio.viewHeight,
                timingZoom = studio.zoom,
                timingOffsetX = studio.offsetX,
                timingOffsetY = studio.offsetY,
                timingDpr = window.devicePixelRatio,
                timingStarted = performance.now();
            let previousFrame: number | undefined;
            try {
                for (const phase of [
                    'cache-empty-cold',
                    ...Array.from({ length: 9 }, (_, index) => 'unchanged-' + index),
                    'dirty',
                    'rollback',
                ]) {
                    if (phase === 'cache-empty-cold') {
                        // Distinct native fixture/camera, not the Metal fixture comparison.
                        candidate.clear();
                        studio.fullPixels = true;
                    }
                    if (phase === 'dirty' || phase === 'rollback') {
                        for (let row = 0; row < 16; row++) {
                            const start = ((y + row) * 2048 + x) * 4;
                            if (phase === 'rollback')
                                active.set(backup.subarray(row * 64, (row + 1) * 64), start);
                            else
                                for (let column = 0; column < 16; column++)
                                    active.set([215, 31, 63, 144], start + column * 4);
                        }
                        studio.pendingDirty.set(active, [{ x, y, width: 16, height: 16 }]);
                    }
                    if (studio.frame) throw Error('Unexpected scheduled render before native timing');
                    const requested = performance.now(),
                        before = candidate.stats;
                    await new Promise<void>((resolve, reject) =>
                        requestAnimationFrame((timestamp) => {
                            try {
                                if (
                                    studio.frame ||
                                    studio.canvas !== canvas ||
                                    studio.ctx !== context ||
                                    studio.sceneCache !== candidate ||
                                    studio.doc.state !== state ||
                                    canvas.width !== timingWidth ||
                                    canvas.height !== timingHeight ||
                                    studio.viewWidth !== timingViewWidth ||
                                    studio.viewHeight !== timingViewHeight ||
                                    studio.zoom !== timingZoom ||
                                    studio.offsetX !== timingOffsetX ||
                                    studio.offsetY !== timingOffsetY ||
                                    window.devicePixelRatio !== timingDpr
                                )
                                    throw Error(
                                        'Native timing ownership or camera changed: ' +
                                            JSON.stringify({
                                                phase,
                                                frame: studio.frame,
                                                owners: [
                                                    studio.canvas === canvas,
                                                    studio.ctx === context,
                                                    studio.sceneCache === candidate,
                                                    studio.doc.state === state,
                                                ],
                                                expected: [
                                                    timingWidth,
                                                    timingHeight,
                                                    timingViewWidth,
                                                    timingViewHeight,
                                                    timingZoom,
                                                    timingOffsetX,
                                                    timingOffsetY,
                                                    timingDpr,
                                                ],
                                                actual: [
                                                    canvas.width,
                                                    canvas.height,
                                                    studio.viewWidth,
                                                    studio.viewHeight,
                                                    studio.zoom,
                                                    studio.offsetX,
                                                    studio.offsetY,
                                                    window.devicePixelRatio,
                                                ],
                                            }),
                                    );
                                const started = performance.now();
                                studio.render();
                                const ended = performance.now(),
                                    stats = candidate.stats;
                                if (
                                    stats.tiles > 64 ||
                                    stats.estimatedBytes > 128 * 1024 * 1024 ||
                                    stats.largestSurfaceDimension > 512
                                )
                                    throw Error('Native timing resource budget exceeded');
                                if (
                                    phase.startsWith('unchanged-') &&
                                    (stats.uploads !== before.uploads ||
                                        stats.sceneCaptures !== before.sceneCaptures)
                                )
                                    throw Error('Unchanged timed frame rebuilt pixel caches');
                                renderTimings.push({
                                    phase,
                                    requested,
                                    started,
                                    ended,
                                    renderMs: ended - started,
                                    queueMs: started - requested,
                                    precedingRafTimestampGapMs:
                                        previousFrame === undefined ? undefined : timestamp - previousFrame,
                                    uploads: stats.uploads - before.uploads,
                                    putImageDataBytes: stats.putImageDataBytes - before.putImageDataBytes,
                                    captures: stats.sceneCaptures - before.sceneCaptures,
                                    stats,
                                    canvas: [canvas.width, canvas.height],
                                    devicePixelRatio: window.devicePixelRatio,
                                    derivedPaperMatrix: [
                                        dpr * studio.zoom,
                                        0,
                                        0,
                                        dpr * studio.zoom,
                                        dpr * studio.offsetX,
                                        dpr * studio.offsetY,
                                    ],
                                    view: [studio.viewWidth, studio.viewHeight],
                                    zoom: studio.zoom,
                                    offset: [studio.offsetX, studio.offsetY],
                                    document: [state.width, state.height, state.layers.length],
                                    scope: 'Direct production render inside a test rAF; API return elapsed, not presentation. No additional test readback/reference in timing batch; production captures remain timed.',
                                });
                                previousFrame = timestamp;
                                resolve();
                            } catch (error) {
                                reject(error);
                            }
                        }),
                    );
                    if (performance.now() - timingStarted > 30000)
                        throw Error('Native timing batch exceeded 30s');
                }
            } finally {
                if (studio.frame) cancelAnimationFrame(studio.frame);
                studio.frame = 0;
                for (let row = 0; row < 16; row++)
                    active.set(backup.subarray(row * 64, (row + 1) * 64), ((y + row) * 2048 + x) * 4);
                studio.pendingDirty.clear();
                candidate.clear();
                studio.fullPixels = true;
            }
            referenceCanvas.width = canvas.width;
            referenceCanvas.height = canvas.height;
            const referenceContext = referenceCanvas.getContext('2d')!;
            for (const phase of [
                'cold',
                'unchanged',
                'rename',
                'dirty-boundary',
                'rollback',
                'selection',
                'selection-move',
                'selection-cancel',
                'hide',
                'unhide',
                'fractional-paper-edge',
                'minified-fallback',
                'restore-camera',
                'restored-unchanged',
            ]) {
                if (phase === 'rename')
                    studio.doc.editMetadata('검사 이름', {
                        kind: 'layer-name',
                        layer: 15,
                        name: '같은 픽셀',
                    });
                if (phase === 'dirty-boundary') {
                    for (let row = 0; row < 16; row++) {
                        const start = ((y + row) * 2048 + x) * 4;
                        backup.set(active.subarray(start, start + 16 * 4), row * 16 * 4);
                        for (let column = 0; column < 16; column++)
                            active.set([215, 31, 63, 144], start + column * 4);
                    }
                    studio.pendingDirty.set(active, [{ x, y, width: 16, height: 16 }]);
                }
                if (phase === 'rollback') {
                    for (let row = 0; row < 16; row++)
                        active.set(
                            backup.subarray(row * 16 * 4, (row + 1) * 16 * 4),
                            ((y + row) * 2048 + x) * 4,
                        );
                    studio.pendingDirty.set(active, [{ x, y, width: 16, height: 16 }]);
                }
                if (phase === 'selection') {
                    const pixels = new Uint8ClampedArray(24 * 24 * 4);
                    for (let row = 0; row < 24; row++) {
                        const start = ((300 + row) * 2048 + 400) * 4;
                        pixels.set(active.subarray(start, start + 24 * 4), row * 24 * 4);
                    }
                    studio.selection = {
                        x: 430,
                        y: 320,
                        width: 24,
                        height: 24,
                        pixels,
                        source: { x: 400, y: 300, width: 24, height: 24 },
                        modified: true,
                    };
                }
                if (phase === 'selection-move') studio.selection!.x += 33;
                if (phase === 'selection-cancel') studio.selection = undefined;
                if (phase === 'hide')
                    studio.doc.editMetadata('숨김', {
                        kind: 'layer-visible',
                        layer: 15,
                        visible: false,
                    });
                if (phase === 'unhide') studio.doc.undo();
                if (phase === 'fractional-paper-edge') {
                    studio.offsetX = 20.25;
                    studio.offsetY = -450.5;
                }
                if (phase === 'minified-fallback') {
                    studio.zoom = 0.25;
                    reference.clear();
                    reference = new FinalSceneCache();
                }
                if (phase === 'restore-camera') {
                    studio.zoom = 1;
                    studio.offsetX = -301.25;
                    studio.offsetY = -153.5;
                    reference.clear();
                    reference = new FinalSceneCache(64, 512 * 512 * 8);
                }
                studio.canvas = canvas;
                studio.ctx = context;
                studio.sceneCache = candidate;
                const uploads = candidate.stats.uploads;
                studio.render();
                const actualReadStarted = performance.now(),
                    actual = context.getImageData(0, 0, canvas.width, canvas.height).data,
                    actualReadMs = performance.now() - actualReadStarted,
                    stats = candidate.stats;
                maxTiles = Math.max(maxTiles, stats.tiles);
                maxBytes = Math.max(maxBytes, stats.estimatedBytes);
                if (stats.tiles > 64 || stats.estimatedBytes > 128 * 1024 * 1024)
                    throw Error('Native scene exceeded its shared budget');
                if (phase === 'cold' && !stats.sceneTiles)
                    throw Error('Native large-document fixture did not activate scene caching');
                if (phase === 'unchanged' || phase === 'rename' || phase === 'restored-unchanged') {
                    const count = stats.uploads - uploads;
                    if (count) throw Error('Unchanged native scene uploaded source pixels: ' + phase);
                    if (phase === 'unchanged') unchangedUploads = count;
                }
                if (phase === 'minified-fallback' && (stats.sceneTiles || candidate.source.maxTiles !== 64))
                    throw Error('Native minification did not retain the original source budget');
                studio.canvas = referenceCanvas;
                studio.ctx = referenceContext;
                studio.sceneCache = reference;
                studio.fullPixels = true;
                const referenceStarted = performance.now();
                studio.render();
                const referenceMs = performance.now() - referenceStarted,
                    expectedReadStarted = performance.now(),
                    expected = referenceContext.getImageData(0, 0, canvas.width, canvas.height).data,
                    expectedReadMs = performance.now() - expectedReadStarted,
                    comparisonStarted = performance.now();
                for (let index = 0; index < actual.length; index++)
                    if (actual[index] !== expected[index] || (index % 4 === 3 && actual[index] !== 255))
                        throw Error('Native scene pixel mismatch: ' + phase + '/' + index);
                correctnessCosts.push({
                    phase,
                    actualReadMs,
                    referenceMs,
                    expectedReadMs,
                    comparisonMs: performance.now() - comparisonStarted,
                });
                checks.push(phase);
            }
            studio.canvas = canvas;
            studio.ctx = context;
            studio.sceneCache = candidate;
            for (let layer = 0; layer < state.layers.length; layer++) {
                const hashStarted = performance.now();
                const hash = Array.from(
                    new Uint8Array(
                        await crypto.subtle.digest(
                            'SHA-256',
                            state.layers[layer].pixels as Uint8ClampedArray<ArrayBuffer>,
                        ),
                    ),
                ).join(',');
                authorityHashAfterMs += performance.now() - hashStarted;
                if (hash !== hashes[layer]) throw Error('Native scene changed authoritative RGBA');
            }
            checks.push('authoritative-rgba-preserved');
            const local = new PaintDocument(
                    createState(16, 12, [255, 0, 0, 255], runtimeProfile),
                    runtimeProfile,
                ),
                colorSettings: BrushSettings = {
                    color: [0, 0, 255, 255],
                    matchColor: [255, 0, 0, 255],
                    size: 4,
                    opacity: 0,
                    hardness: 0,
                    stabilization: 75,
                    eraser: false,
                    pressure: true,
                    square: true,
                },
                spans = new Map([
                    [4, [4, 12]],
                    [5, [3, 13]],
                    [6, [2, 14]],
                    [7, [3, 13]],
                    [8, [4, 12]],
                ]);
            local.beginStroke(4.8, 6.9, colorSettings, 0.01);
            local.endStroke(12.2, 6.5);
            for (let y = 0; y < 12; y++)
                for (let x = 0; x < 16; x++) {
                    const span = spans.get(y),
                        changed = span && x >= span[0] && x <= span[1],
                        at = (y * 16 + x) * 4,
                        pixels = local.state.layers[0].pixels;
                    if (
                        pixels[at] !== (changed ? 0 : 255) ||
                        pixels[at + 1] !== 0 ||
                        pixels[at + 2] !== (changed ? 255 : 0) ||
                        pixels[at + 3] !== 255
                    )
                        throw Error('Native color replacement escaped its hard capsule');
                }
            if (local.cursor !== 1 || !local.dirty)
                throw Error('Native color replacement lost its single history entry');
            checks.push('color-eraser-capsule');
            const painted = local.state.layers[0].pixels.slice();
            local.undo();
            if (local.state.layers[0].pixels.some((v, i) => v !== (i % 4 === 0 || i % 4 === 3 ? 255 : 0)))
                throw Error('Native color replacement Undo changed original pixels');
            local.beginStroke(4, 6, colorSettings);
            local.cancelStroke();
            if (
                local.dirty ||
                !local.canRedo ||
                local.state.layers[0].pixels.some((v, i) => v !== (i % 4 === 0 || i % 4 === 3 ? 255 : 0))
            )
                throw Error('Native color replacement cancel changed pixels, saved state or Redo');
            local.redo();
            if (local.state.layers[0].pixels.some((v, i) => v !== painted[i]))
                throw Error('Native color replacement Redo changed pixels');
            checks.push('color-eraser-cancel-redo');
            const lowAlpha = createState(3, 1, [10, 20, 30, 1], runtimeProfile);
            lowAlpha.layers[0].pixels.set([1, 2, 3, 1], 4);
            lowAlpha.layers[0].pixels.set([200, 201, 202, 1], 8);
            local.reset(lowAlpha, true);
            local.beginStroke(0, 0, {
                ...colorSettings,
                size: 1,
                matchColor: [10, 20, 30, 1],
            });
            local.endStroke(2, 0);
            const expectedLow = [0, 0, 255, 255, 0, 0, 255, 255, 200, 201, 202, 1];
            if (local.state.layers[0].pixels.some((v, i) => v !== expectedLow[i]))
                throw Error('Native color replacement premultiplied key mismatch');
            checks.push('color-eraser-low-alpha');
            // Independent Qt geometry literals; straight RGBA and history are checked in this runtime.
            for (const fixture of [
                {
                    name: 'square-thin-clipped',
                    width: 24,
                    height: 24,
                    size: 1,
                    from: [6, 11],
                    to: [37990, 14488],
                    color: [0, 0, 255, 255],
                    spans: [
                        [11, 6, 9],
                        [12, 9, 11],
                        [13, 11, 14],
                        [14, 14, 17],
                        [15, 17, 19],
                        [16, 19, 22],
                        [17, 22, 24],
                    ],
                },
                {
                    name: 'square-wide-fixed-boundary',
                    width: 64,
                    height: 64,
                    size: 61,
                    from: [1, 41],
                    to: [29, 15],
                    color: [17, 91, 203, 128],
                    spans: [
                        [0, 0, 57],
                        [1, 0, 58],
                        [2, 0, 59],
                        [3, 0, 60],
                        [4, 0, 61],
                        [5, 0, 62],
                        [6, 0, 63],
                        [7, 0, 64],
                        [8, 0, 64],
                        [9, 0, 64],
                        [10, 0, 64],
                        [11, 0, 64],
                        [12, 0, 64],
                        [13, 0, 64],
                        [14, 0, 64],
                        [15, 0, 64],
                        [16, 0, 64],
                        [17, 0, 64],
                        [18, 0, 64],
                        [19, 0, 64],
                        [20, 0, 64],
                        [21, 0, 64],
                        [22, 0, 64],
                        [23, 0, 64],
                        [24, 0, 64],
                        [25, 0, 63],
                        [26, 0, 61],
                        [27, 0, 60],
                        [28, 0, 59],
                        [29, 0, 58],
                        [30, 0, 57],
                        [31, 0, 56],
                        [32, 0, 55],
                        [33, 0, 54],
                        [34, 0, 53],
                        [35, 0, 52],
                        [36, 0, 51],
                        [37, 0, 50],
                        [38, 0, 49],
                        [39, 0, 47],
                        [40, 0, 46],
                        [41, 0, 45],
                        [42, 0, 44],
                        [43, 0, 43],
                        [44, 0, 42],
                        [45, 0, 41],
                        [46, 0, 40],
                        [47, 0, 39],
                        [48, 0, 38],
                        [49, 0, 37],
                        [50, 0, 36],
                        [51, 0, 34],
                        [52, 0, 33],
                        [53, 0, 32],
                        [54, 0, 32],
                        [55, 0, 32],
                        [56, 0, 32],
                        [57, 0, 32],
                        [58, 0, 32],
                        [59, 0, 32],
                        [60, 0, 32],
                        [61, 0, 32],
                        [62, 0, 32],
                        [63, 0, 32],
                    ],
                },
            ] as const) {
                local.reset(
                    createState(fixture.width, fixture.height, [255, 0, 0, 255], runtimeProfile),
                    true,
                );
                const original = local.state.layers[0].pixels.slice(),
                    expected = original.slice();
                for (const [y, left, right] of fixture.spans)
                    for (let x = left; x < right; x++)
                        expected.set(fixture.color, (y * fixture.width + x) * 4);
                local.beginStroke(
                    fixture.from[0],
                    fixture.from[1],
                    {
                        color: fixture.color,
                        size: fixture.size,
                        opacity: 0,
                        hardness: 0,
                        stabilization: 75,
                        pressure: true,
                        square: true,
                        eraser: true,
                    },
                    0.01,
                );
                local.moveStroke(fixture.to[0], fixture.to[1], 0.01);
                local.endStroke(fixture.to[0], fixture.to[1]);
                if (local.state.layers[0].pixels.some((v, i) => v !== expected[i]) || local.cursor !== 1)
                    throw Error('Native square geometry/history mismatch: ' + fixture.name);
                local.undo();
                if (local.state.layers[0].pixels.some((v, i) => v !== original[i]))
                    throw Error('Native square Undo mismatch');
                local.redo();
                if (local.state.layers[0].pixels.some((v, i) => v !== expected[i]))
                    throw Error('Native square Redo mismatch');
                checks.push(fixture.name);
            }
            local.reset(createState(16, 16, [255, 0, 0, 255], runtimeProfile), true);
            local.beginStroke(
                8.2,
                8.2,
                {
                    color: [77, 144, 219, 128],
                    size: 4,
                    opacity: 0,
                    hardness: 0,
                    stabilization: 75,
                    pressure: true,
                    square: true,
                    eraser: false,
                },
                0.01,
            );
            local.moveStroke(8.8, 8.8, 0.01);
            local.endStroke(8.8, 8.8);
            for (let y = 0; y < 16; y++)
                for (let x = 0; x < 16; x++) {
                    const expected =
                            x >= 6 && x < 10 && y >= 6 && y < 10 ? [88, 135, 206, 255] : [255, 0, 0, 255],
                        at = (y * 16 + x) * 4;
                    if (
                        expected.some(
                            (value, channel) => value !== local.state.layers[0].pixels[at + channel],
                        )
                    )
                        throw Error('Native square event source-over mismatch');
                }
            checks.push('square-event-source-over');
        } finally {
            studio.canvas = canvas;
            studio.ctx = context;
            studio.sceneCache = candidate;
            reference.clear();
            referenceCanvas.width = 0;
            referenceCanvas.height = 0;
        }
        await window.__TAURI__!.core.invoke('smoke_result', {
            ok: true,
            error: JSON.stringify({
                scene: true,
                checks,
                maxTiles,
                maxBytes,
                unchangedUploads,
                authorityDigests: hashes,
                renderTimings,
                correctnessCosts,
                authorityHashBeforeMs,
                authorityHashAfterMs,
                startupDrainMs,
                setupMs: renderTimings.length
                    ? (renderTimings[0] as { requested: number }).requested - setupStarted
                    : undefined,
            }),
        });
        return;
    }
    const quitModes = await window.__TAURI__!.core.invoke<string[]>('quit_smoke_modes');
    if (quitModes.length) {
        const invoke = window.__TAURI__!.core.invoke;
        for (const phase of ['unsaved', 'pending', 'busy']) {
            const state = createState(16, 16, [0, 0, 0, 0], runtimeProfile);
            state.layers[0].pixels.set([22, 121, 234, 128]);
            studio.doc.reset(state, phase !== 'unsaved');
            studio.editor?.remove();
            studio.editor = undefined;
            if (phase !== 'unsaved') {
                studio.beginText({ x: 1, y: 1, pressure: 1 });
                studio.editor!.value = '종료 전에 유지할 문자';
            }
            studio.busy = phase === 'busy';
            studio.fit();
            studio.sync();
            const revision = studio.doc.revision,
                saved = studio.doc.savedRevision,
                editor = studio.workspace.querySelector<HTMLTextAreaElement>('.text-editor') || undefined,
                pixels = state.layers[0].pixels.slice();
            for (const mode of quitModes) {
                studio.message('종료 검사: ' + phase + ' / ' + mode);
                await invoke('smoke_quit', { mode });
                let observed = false;
                for (let attempt = 0; attempt < 100; attempt++) {
                    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
                    observed =
                        phase === 'busy'
                            ? studio.status.textContent === '진행 중인 작업을 완료하거나 취소한 뒤 닫으세요.'
                            : dialog?.querySelector('h2')?.textContent === '변경한 내용을 저장하시겠습니까?';
                    if (observed) break;
                    await new Promise<void>((resolve) => setTimeout(resolve, 25));
                }
                if (!observed) throw Error('Quit guard did not reach the expected UI: ' + phase + '/' + mode);
                const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
                if (phase === 'busy') {
                    if (dialog) throw Error('Busy quit opened a replacement dialog');
                } else {
                    studio.message('중복 종료 검사: ' + phase + ' / ' + mode);
                    await invoke('smoke_quit', { mode });
                    observed = false;
                    for (let attempt = 0; attempt < 100; attempt++) {
                        observed =
                            studio.status.textContent === '진행 중인 작업을 완료하거나 취소한 뒤 닫으세요.';
                        if (observed) break;
                        await new Promise<void>((resolve) => setTimeout(resolve, 25));
                    }
                    if (
                        !observed ||
                        document.querySelector('dialog[open]') !== dialog ||
                        document.querySelectorAll('dialog[open]').length !== 1
                    )
                        throw Error('Repeated quit replaced or duplicated its dialog');
                    if (
                        dialog!.querySelector('select') ||
                        dialog!.querySelectorAll('button[data-action]').length !== 3
                    )
                        throw Error('Unsaved changes must present three direct action buttons');
                    const cancel = dialog?.querySelector<HTMLButtonElement>('button[value=cancel]');
                    if (!cancel) throw Error('Quit cancellation button missing');
                    cancel.click();
                    for (let attempt = 0; dialog!.isConnected && attempt < 100; attempt++)
                        await new Promise<void>((resolve) => setTimeout(resolve, 25));
                    if (dialog!.isConnected) throw Error('Quit cancellation dialog did not finish');
                }
                if (
                    studio.doc.state !== state ||
                    studio.doc.revision !== revision ||
                    studio.doc.savedRevision !== saved ||
                    !pixels.every((value, index) => value === state.layers[0].pixels[index]) ||
                    (editor && (!editor.isConnected || editor.value !== '종료 전에 유지할 문자')) ||
                    studio.editor !== editor
                )
                    throw Error('Quit changed the document or pending text');
            }
        }
        studio.busy = false;
        studio.editor?.remove();
        studio.editor = undefined;
        studio.doc.markSaved(studio.doc.revision);
        studio.sync();
        await invoke('quit_smoke_report', {
            checks: {
                modes: quitModes,
                unsavedCancel: true,
                pendingCancel: true,
                busyPreserved: true,
                repeatedQuitPreserved: true,
                readyForApprovedClose: true,
            },
        });
        await invoke('smoke_quit', { mode: 'runtime' });
        return;
    }
    studio.busy = true;
    if (await window.__TAURI__!.core.invoke<boolean>('persistence_smoke_mode')) {
        const invoke = window.__TAURI__!.core.invoke;
        const started = performance.now();
        let stage = 'fixture-generation',
            stageStarted = started;
        try {
            const state = createState(4096, 4096, [0, 0, 0, 0], runtimeProfile);
            const words = new Uint32Array(state.layers[0].pixels.buffer);
            let random = 0x12345678;
            for (let i = 0; i < words.length; i++) {
                random ^= random << 13;
                random ^= random >>> 17;
                random ^= random << 5;
                words[i] = random >>> 0;
            }
            const pixelHash = new Uint8Array(
                await crypto.subtle.digest(
                    'SHA-256',
                    state.layers[0].pixels as Uint8ClampedArray<ArrayBuffer>,
                ),
            );
            stage = 'project-write-large';
            stageStarted = performance.now();
            const bytes = (await runCodec('project-write', state, undefined, undefined, runtimeProfile))
                .bytes!;
            if (bytes.length <= 64 * 1048576)
                throw Error('Large recovery fixture must exceed the browser quota');
            const encodedBytes = bytes.length;
            stage = 'recovery-write-large';
            stageStarted = performance.now();
            await studio.recovery.request('write', undefined, bytes, '복구 검증 ✏️.rpaint');
            stage = 'recovery-list-initial';
            stageStarted = performance.now();
            let { entries } = await invoke<{ entries: RecoveryEntry[] }>('recovery_list');
            const entry = entries.find(
                (item) => item.key === studio.recovery.key && item.source === 'native',
            );
            if (!entry || entry.size !== encodedBytes || entry.name !== '복구 검증 ✏️.rpaint')
                throw Error('Native recovery metadata mismatch');
            stage = 'recovery-read-large';
            stageStarted = performance.now();
            const recoveredBytes = await studio.recovery.read(entry);
            stage = 'project-read-large';
            stageStarted = performance.now();
            const reopened = (
                await runCodec('project-read', undefined, recoveredBytes, undefined, runtimeProfile)
            ).state!;
            stage = 'pixel-roundtrip';
            stageStarted = performance.now();
            const recoveredHash = new Uint8Array(
                await crypto.subtle.digest(
                    'SHA-256',
                    reopened.layers[0].pixels as Uint8ClampedArray<ArrayBuffer>,
                ),
            );
            if (
                reopened.width !== 4096 ||
                reopened.height !== 4096 ||
                !pixelHash.every((value, i) => value === recoveredHash[i])
            )
                throw Error('Native recovery pixels changed');
            stage = 'project-write-small';
            stageStarted = performance.now();
            const small = (
                await runCodec(
                    'project-write',
                    createState(2, 1, [12, 34, 56, 78], runtimeProfile),
                    undefined,
                    undefined,
                    runtimeProfile,
                )
            ).bytes!;
            stage = 'recovery-write-small';
            stageStarted = performance.now();
            await studio.recovery.request('write', undefined, small, '두 번째 사본.rpaint');
            stage = 'stale-handles';
            stageStarted = performance.now();
            let staleRead = false,
                staleClear = false;
            try {
                await studio.recovery.read(entry);
            } catch {
                staleRead = true;
            }
            try {
                await studio.recovery.request('clear', entry);
            } catch {
                staleClear = true;
            }
            if (!staleRead || !staleClear) throw Error('Stale recovery handle accepted');
            stage = 'recovery-list-replacement';
            stageStarted = performance.now();
            ({ entries } = await invoke<{ entries: RecoveryEntry[] }>('recovery_list'));
            const latest = entries.find(
                (item) => item.key === studio.recovery.key && item.source === 'native',
            );
            if (!latest || latest.sequence !== 2 || latest.size !== small.length)
                throw Error('Replacement recovery was lost');
            stage = 'recovery-clear-replacement';
            stageStarted = performance.now();
            await studio.recovery.request('clear', latest);
            stage = 'legacy-recovery';
            stageStarted = performance.now();
            const legacy = entries.find((item) => item.source === 'legacy');
            if (!legacy || !legacy.readOnly) throw Error('Isolated legacy fixture missing');
            const legacyBytes = await studio.recovery.read(legacy);
            if (new TextDecoder().decode(legacyBytes.subarray(0, 8)) !== 'RPAINT01')
                throw Error('Legacy recovery changed');
            let legacyClear = false;
            try {
                await invoke('recovery_clear', { token: legacy.token });
            } catch {
                legacyClear = true;
            }
            if (!legacyClear) throw Error('Legacy recovery deletion allowed');
            stage = 'generation-replacement';
            stageStarted = performance.now();
            await activateNative(studio.epoch + 1, crypto.randomUUID());
            let oldGeneration = false;
            try {
                await studio.recovery.request('write', undefined, small);
            } catch {
                oldGeneration = true;
            }
            if (!oldGeneration) throw Error('Old document recovery accepted');
            stage = 'recovery-list-final';
            stageStarted = performance.now();
            const { entries: finalEntries } = await invoke<{ entries: RecoveryEntry[] }>('recovery_list');
            if (finalEntries.some((item) => item.source === 'native')) throw Error('Recovery cleanup failed');
            stage = 'result-report';
            stageStarted = performance.now();
            await invoke('smoke_result', {
                ok: true,
                error: JSON.stringify({
                    encodedBytes,
                    elapsedMs: Math.round(performance.now() - started),
                    pixelRoundtrip: true,
                    staleRead,
                    staleClear,
                    legacyClear,
                    oldGeneration,
                }),
            });
        } catch (error) {
            const failedAt = performance.now();
            throw new Error(
                `Native persistence smoke ${JSON.stringify({
                    stage,
                    elapsedMs: Math.round(failedAt - started),
                    stageElapsedMs: Math.round(failedAt - stageStarted),
                    visibilityAtFailure: document.visibilityState,
                    focusAtFailure: document.hasFocus(),
                    error: String(error),
                })}`,
                { cause: error },
            );
        }
        return;
    }
    for (const [width, height] of [
        [4096, 4096],
        [32768, 1],
    ]) {
        const state = createState(width, height, [0, 0, 0, 0], runtimeProfile);
        state.layers[0].pixels.set([22, 121, 234, 128], (width * height - 1) * 4);
        if (height > 1)
            for (let y = 2048; y < 2112; y++)
                for (let x = 2048; x < 2112; x++)
                    state.layers[0].pixels.set([22, 121, 234, 255], (y * width + x) * 4);
        const encoded = (await runCodec('project-write', state, undefined, undefined, runtimeProfile)).bytes!;
        const decoded = (await runCodec('project-read', undefined, encoded, undefined, runtimeProfile))
            .state!;
        if (
            decoded.width !== width ||
            decoded.height !== height ||
            decoded.layers[0].pixels[(width * height - 1) * 4] !== 22 ||
            decoded.layers[0].pixels[(width * height - 1) * 4 + 3] !== 128
        )
            throw Error('대형 문서 알파/코덱 검증 실패');
        studio.doc.reset(decoded);
        studio.fit();
        studio.render();
        if (height > 1) {
            const dpr = studio.canvas.width / studio.viewWidth,
                x = Math.floor((studio.offsetX + 2080 * studio.zoom) * dpr),
                y = Math.floor((studio.offsetY + 2080 * studio.zoom) * dpr),
                pixel = studio.ctx.getImageData(x, y, 1, 1).data;
            if (pixel[0] !== 22 || pixel[1] !== 121 || pixel[2] !== 234)
                throw Error('네이티브 대형 문서 타일 표시 실패');
        }
        studio.commitShape(
            { x: 0, y: 0, pressure: 1 },
            { x: width - 1, y: Math.min(20, height - 1), pressure: 1 },
            'line',
        );
        studio.doc.undo();
        if (height === 1) {
            const jpg = await exportBytes(
                studio.doc.state,
                'jpg',
                [255, 255, 255, 255],
                undefined,
                runtimeProfile,
            );
            const reopened = await readArtwork(
                new File([jpg as Uint8Array<ArrayBuffer>], 'native-smoke.jpg', {
                    type: 'image/jpeg',
                }),
                undefined,
                runtimeProfile,
            );
            if (
                reopened.width !== width ||
                reopened.height !== height ||
                reopened.layers[0].pixels[3] !== 255
            )
                throw Error('네이티브 긴 JPEG 왕복 실패');
        }
    }
    const staticGif = Uint8Array.from(
            atob(
                'R0lGODlhCAAGAIEAAAAAAP8AAAD/AAAA/yH5BAQCAAAALAAAAAAIAAYAAAIlDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwBQA7',
            ),
            (byte) => byte.charCodeAt(0),
        ),
        animationGif = Uint8Array.from(
            atob(
                'R0lGODlhCAAGAIEAAAAAAP8AAAD/AAAA/yH5BAQCAAAALAAAAAAIAAYAAAIlDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwBQAh+QQEAgAAACwAAAAACAAGAAACJRRFURRFURRFURRFURRFURRFURRFURRFURRFURRFURRFURRFUQUAOw==',
            ),
            (byte) => byte.charCodeAt(0),
        ),
        transparentGif = staticGif.slice(),
        gifChecks: string[] = [];
    // The shared 84-byte GIF encodes palette index 1; its GCE makes that index transparent.
    transparentGif[28] |= 1;
    transparentGif[31] = 1;
    for (const sample of [
        { name: 'gif-static-red-8x6', bytes: staticGif, rgba: [255, 0, 0, 255] },
        { name: 'gif-animation-first-red', bytes: animationGif, rgba: [255, 0, 0, 255] },
        { name: 'gif-transparent-rgba', bytes: transparentGif, rgba: [0, 0, 0, 0] },
    ]) {
        const loaded = await readArtwork(
            new File([sample.bytes as Uint8Array<ArrayBuffer>], sample.name + '.gif', { type: 'image/gif' }),
            undefined,
            runtimeProfile,
        );
        if (
            loaded.width !== 8 ||
            loaded.height !== 6 ||
            loaded.active !== 0 ||
            loaded.layers.length !== 1 ||
            loaded.layers[0].pixels.length !== 8 * 6 * 4 ||
            loaded.layers[0].pixels.some((value, index) => value !== sample.rgba[index % 4])
        )
            throw Error('Native GIF pixels changed: ' + sample.name);
        gifChecks.push(sample.name);
    }
    await window.__TAURI__!.core.invoke('smoke_result', {
        ok: true,
        error: JSON.stringify({ codec: true, checks: gifChecks }),
    });
}
