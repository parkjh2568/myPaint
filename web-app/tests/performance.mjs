import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { PaintDocument, createState, cloneState, composite } from '../src/engine/document.ts';
import { flood, resizeState, transformState } from '../src/engine/operations.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';

const samples = Number(process.env.PAINT_BENCH_SAMPLES ?? 7),
    limitMs = Number(process.env.PAINT_BENCH_LIMIT_MS ?? 90000);
assert(Number.isInteger(samples) && samples >= 3 && samples <= 15, 'Samples must be an integer from3 to15');
assert(
    Number.isInteger(limitMs) && limitMs >= 10000 && limitMs <= 120000,
    'Budget must be an integer from10000 to120000ms',
);
const brushSizes =
    process.env.PAINT_BENCH_BRUSH_SIZE === undefined
        ? [12, 100]
        : [Number(process.env.PAINT_BENCH_BRUSH_SIZE)];
assert(
    brushSizes.every((size) => size === 12 || size === 100),
    'Brush size must be12 or100',
);
assert(
    !(process.env.PAINT_BENCH_BROWSER_ONLY === '1' && process.env.PAINT_BENCH_SKIP_BROWSER === '1'),
    'At least one measurement phase must be selected',
);
const output = path.resolve(
    process.env.PAINT_PERFORMANCE_OUTPUT || '../build-web-work/task-planning/current-tests/performance',
);
await fs.mkdir(output, { recursive: true });
const started = performance.now(),
    deadline = started + limitMs;
const source = {};
for (const file of [
    'src/engine/document.ts',
    'src/engine/operations.ts',
    'src/engine/format.ts',
    'src/main.ts',
    'tests/performance.mjs',
]) {
    source[file] = crypto
        .createHash('sha256')
        .update(await fs.readFile(new URL('../' + file, import.meta.url)))
        .digest('hex');
}
const result = {
    schemaVersion: 2,
    label: process.env.PAINT_PERFORMANCE_LABEL || 'development',
    recordedAt: new Date().toISOString(),
    host: {
        os: os.platform(),
        release: os.release(),
        architecture: os.arch(),
        cpu: os.cpus()[0]?.model,
        node: process.version,
        logicalCpuCount: os.cpus().length,
        physicalMemoryBytes: os.totalmem(),
        loadAverageAtStart: os.loadavg(),
    },
    method: {
        samples,
        brushSizes,
        phases:
            process.env.PAINT_BENCH_BROWSER_ONLY === '1'
                ? 'browser-only'
                : process.env.PAINT_BENCH_SKIP_BROWSER === '1'
                  ? 'core-only'
                  : 'both',
        limitMs,
        warmupsPerOperation: 1,
        trajectory: {
            points: 120,
            startX: 40,
            stepX: 6,
            startY: 80,
            strokeYStep: 25,
            sineAmplitude: 20,
            sineDivisor: 10,
        },
        quantiles:
            'Nearest rank of raw observations; strokes are clusters, not independent move samples. Small-sample p95/p99 may equal max and do not certify stable tails.',
        bounds: 'Web profile only: <=4 Mi pixels, <=6 Mi aggregate layer pixels',
        node: 'Warm V8 engine operation durations; setup excluded except where explicitly included',
        externalLoad:
            process.env.PAINT_BENCH_LOAD_NOTE ||
            'Not independently observed by this driver; record host load and competing work separately. No isolation claim.',
        gc: 'Natural GC; no forced collections. Memory endpoints and reachable buffers are not peak RSS.',
        timing: 'Wall time, not process CPU cycles. Handler synchronous prefix, endStroke including its final move, rAF callbacks and first accepted workspace Canvas command are distinct observations.',
        browser:
            'Chrome on desktop with software rendering; trusted automated mouse events. Handler and rAF callback durations are not physical input-to-photon latency or Android measurements.',
        uploadMeasurement:
            'Bytes are the sum of requested putImageData dirty rectangles, not measured GPU bus transfers or completed display pixels.',
        limits: 'CPU budget has soft checkpoints and cannot interrupt a synchronous operation. Browser deadline requests closure of the owned context/browser, best effort rather than an OS hard wall. Existing Qt QPainter/native probe has a different workload and is not a speedup denominator.',
    },
    nodeMemoryAtStart: process.memoryUsage(),
    nodeCpuAtStartMicroseconds: process.cpuUsage(),
    source,
    core: [],
    browser: [],
};
function distribution(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const percentile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
    return {
        count: sorted.length,
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
        max: sorted.at(-1) ?? null,
        samples: values,
        nearestRankP95: sorted.length ? Math.ceil(sorted.length * 0.95) : null,
        nearestRankP99: sorted.length ? Math.ceil(sorted.length * 0.99) : null,
    };
}
function documentMemory(document) {
    const buffers = new Set();
    const addState = (state) => {
        if (state) for (const layer of state.layers) buffers.add(layer.pixels.buffer);
    };
    addState(document.state);
    for (const change of document.history) {
        addState(change.before);
        addState(change.after);
        for (const tile of change.tiles || []) {
            buffers.add(tile.before.buffer);
            if (tile.after) buffers.add(tile.after.buffer);
            buffers.add(tile.coverage.buffer);
        }
    }
    for (const tile of document.stroke?.tiles.values() || []) {
        buffers.add(tile.before.buffer);
        buffers.add(tile.coverage.buffer);
    }
    return {
        uniqueEngineArrayBufferBytes: [...buffers].reduce((n, b) => n + b.byteLength, 0),
        historyAccountedBytes: document.historyBytes,
        historyBudget: document.historyBudget,
        retainedHistoryEntries: document.history.length,
    };
}
try {
    if (process.env.PAINT_BENCH_BROWSER_ONLY !== '1') {
        for (const [width, height] of [
            [800, 600],
            [2048, 2048],
        ]) {
            for (const size of brushSizes) {
                if (performance.now() > deadline) throw Error('Benchmark time limit exceeded');
                const doc = new PaintDocument(createState(width, height, [0, 0, 0, 0]));
                const settings = {
                    color: [22, 121, 234, 255],
                    size,
                    opacity: 0.7,
                    hardness: 0.25,
                    stabilization: 25,
                    eraser: false,
                    pressure: false,
                };
                const moves = [],
                    commits = [],
                    strokes = [];
                for (let stroke = -1; stroke < samples; stroke++) {
                    const y = 80 + (stroke + 1) * 25;
                    const start = performance.now();
                    doc.beginStroke(40, y, settings);
                    for (let point = 1; point <= 120; point++) {
                        const time = performance.now();
                        doc.moveStroke(40 + point * 6, y + Math.sin(point / 10) * 20);
                        if (stroke >= 0) moves.push(performance.now() - time);
                    }
                    const commitStart = performance.now();
                    doc.endStroke(760, y + Math.sin(120 / 10) * 20);
                    if (stroke >= 0) {
                        commits.push(performance.now() - commitStart);
                        strokes.push(performance.now() - start);
                    }
                }
                result.core.push({
                    operation: 'smooth-brush',
                    width,
                    height,
                    size,
                    pointsPerStroke: 120,
                    movesMs: distribution(moves),
                    endStrokeMs: distribution(commits),
                    strokesMs: distribution(strokes),
                    memory: documentMemory(doc),
                });
            }
        }
        for (const [width, height, layerCount] of [
            [2048, 2048, 1],
            [1536, 2048, 2],
        ]) {
            const state = createState(width, height);
            for (let n = 1; n < layerCount; n++)
                state.layers.push({
                    name: 'Layer ' + n,
                    visible: true,
                    pixels: state.layers[0].pixels.slice(),
                });
            const doc = new PaintDocument(state);
            doc.edit('metadata', (candidate) => {
                candidate.background = [0, 0, 0, 0];
            });
            result.core.push({
                operation: 'structural-history-memory',
                width,
                height,
                layerCount,
                memory: documentMemory(doc),
                note: 'This deliberately uses structural edit, not the current metadata-only API. Unique reachable engine ArrayBuffers after a structural candidate commit. Canvas backing stores, worker snapshots, compression temporaries and GC/RSS are excluded. One last oversized entry is retained by current history policy.',
            });
        }
        for (const [width, height, layerCount] of [
            [800, 600, 1],
            [2048, 2048, 1],
            [1536, 2048, 2],
        ]) {
            const state = createState(width, height, [0, 0, 0, 0]);
            for (let layer = 1; layer < layerCount; layer++)
                state.layers.push({
                    name: 'Layer ' + layer,
                    visible: true,
                    pixels: state.layers[0].pixels.slice(),
                });
            for (let layer = 0; layer < layerCount; layer++)
                for (let i = 0; i < state.layers[layer].pixels.length; i += 4)
                    state.layers[layer].pixels.set(
                        [(i / 4) % 256, (i / 4 / width) % 256, layer ? 200 : 30, layer ? 100 : 255],
                        i,
                    );
            const inputDigest = crypto.createHash('sha256');
            inputDigest.update(
                JSON.stringify([
                    state.width,
                    state.height,
                    state.active,
                    state.background,
                    state.layers.map((layer) => [layer.name, layer.visible]),
                ]),
            );
            for (const layer of state.layers) inputDigest.update(layer.pixels);
            const stateFixtureSha256 = inputDigest.digest('hex');
            const encoded = encodeProject(state);
            for (const operation of [
                'clone',
                'composite',
                'fill-solid',
                'resize-nearest',
                'resize-smooth',
                'rotate-right',
                'project-encode',
                'project-decode',
                'candidate-no-op',
                'candidate-no-op-cloned',
            ]) {
                const durations = [];
                let bytes = 0;
                const fillPixels =
                    operation === 'fill-solid' ? createState(width, height).layers[0].pixels : undefined;
                const doc = operation.startsWith('candidate-no-op') ? new PaintDocument(state) : undefined;
                const equalCandidate = operation === 'candidate-no-op-cloned' ? cloneState(state) : undefined;
                const operand =
                        fillPixels || (operation === 'project-decode' ? encoded : equalCandidate || state),
                    operandDigest = crypto.createHash('sha256');
                if (ArrayBuffer.isView(operand)) operandDigest.update(operand);
                else {
                    operandDigest.update(
                        JSON.stringify([
                            operand.width,
                            operand.height,
                            operand.active,
                            operand.background,
                            operand.layers.map((layer) => [layer.name, layer.visible]),
                        ]),
                    );
                    for (const layer of operand.layers) operandDigest.update(layer.pixels);
                }
                const operandSha256 = operandDigest.digest('hex');
                for (let repeat = -1; repeat < samples; repeat++) {
                    if (performance.now() > deadline) throw Error('Benchmark time limit exceeded');
                    const time = performance.now();
                    let value;
                    if (operation === 'clone') value = cloneState(state);
                    else if (operation === 'composite') value = composite(state);
                    else if (operation === 'fill-solid')
                        value = flood(fillPixels, width, height, 0, 0, [255, 0, 0, 128]);
                    else if (operation === 'resize-nearest')
                        value = resizeState(state, width, height, true, false);
                    else if (operation === 'resize-smooth')
                        value = resizeState(state, width, height, true, true);
                    else if (operation === 'rotate-right') value = transformState(state, 'rotate-right');
                    else if (operation === 'project-encode') value = encodeProject(state);
                    else if (operation === 'project-decode') value = decodeProject(encoded);
                    else if (operation.startsWith('candidate-no-op'))
                        value = doc.prepareState('no-op', equalCandidate || state);
                    const duration = performance.now() - time;
                    if (repeat >= 0) durations.push(duration);
                    bytes = value?.layers
                        ? value.layers.reduce((total, layer) => total + layer.pixels.byteLength, 0)
                        : value?.byteLength || value?.pixels?.byteLength || 0;
                    if (operation.startsWith('candidate-no-op')) assert.equal(value, undefined);
                    else assert(bytes > 0, 'Measured operation must produce real output');
                    if (value?.layers) {
                        assert.equal(value.layers.length, layerCount);
                        assert.deepEqual(
                            [value.width, value.height],
                            operation === 'rotate-right' ? [height, width] : [width, height],
                        );
                    }
                }
                const preserved = crypto.createHash('sha256');
                preserved.update(
                    JSON.stringify([
                        state.width,
                        state.height,
                        state.active,
                        state.background,
                        state.layers.map((layer) => [layer.name, layer.visible]),
                    ]),
                );
                for (const layer of state.layers) preserved.update(layer.pixels);
                assert.equal(
                    preserved.digest('hex'),
                    stateFixtureSha256,
                    'Timed operation must preserve its source State fixture',
                );
                const actualPreserved = crypto.createHash('sha256');
                if (ArrayBuffer.isView(operand)) actualPreserved.update(operand);
                else {
                    actualPreserved.update(
                        JSON.stringify([
                            operand.width,
                            operand.height,
                            operand.active,
                            operand.background,
                            operand.layers.map((layer) => [layer.name, layer.visible]),
                        ]),
                    );
                    for (const layer of operand.layers) actualPreserved.update(layer.pixels);
                }
                assert.equal(
                    actualPreserved.digest('hex'),
                    operandSha256,
                    'Actual timed operand must remain unchanged',
                );
                result.core.push({
                    stateFixtureSha256,
                    stateFixturePreserved: true,
                    stateFixtureLayerCount: layerCount,
                    operandSha256,
                    operandPreserved: true,
                    operandKind: fillPixels
                        ? 'standalone opaque-white RGBA plane'
                        : operation === 'project-decode'
                          ? 'encoded project bytes'
                          : equalCandidate
                            ? 'equal cloned candidate State'
                            : 'State',
                    operandBytes: ArrayBuffer.isView(operand)
                        ? operand.byteLength
                        : operand.layers.reduce((total, layer) => total + layer.pixels.byteLength, 0),
                    operation,
                    width,
                    height,
                    layerCount: fillPixels ? 1 : layerCount,
                    durationsMs: distribution(durations),
                    outputBytes: bytes,
                    note: operation.startsWith('resize-')
                        ? 'Same-size resampling/copy; not a size-changing resize benchmark.'
                        : undefined,
                    logicalPixelBytes: width * height * 4 * (fillPixels ? 1 : layerCount),
                });
            }
        }
    }
    result.nodeMemoryAfterCore = process.memoryUsage();
    result.nodeCpuAfterCoreMicroseconds = process.cpuUsage();
    result.corePhaseEndedAtMs = performance.now() - started;
    if (process.env.PAINT_BENCH_SKIP_BROWSER !== '1') {
        assert(performance.now() < deadline, 'Benchmark budget exhausted before browser launch');
        const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
        const browser = await chromium.launch({
            headless: true,
            executablePath: process.env.PAINT_BROWSER_PATH || undefined,
            timeout: Math.max(1, deadline - performance.now()),
            args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        });
        let ownedContext;
        const budgetTimer = setTimeout(
            () => {
                result.browserDeadlineExceeded = true;
                void ownedContext?.close({ reason: 'Benchmark wall budget exhausted' }).catch(() => {});
                void browser.close({ reason: 'Benchmark wall budget exhausted' }).catch(() => {});
            },
            Math.max(1, deadline - performance.now()),
        );
        // Shared instrumentation runs in its own control page and each fresh application context.
        const installMetrics = () => {
            const metrics = (window.paintMetrics = {
                recording: false,
                stroke: -1,
                sequence: 0,
                handlers: [],
                frames: [],
                longTasks: [],
                pendingInputs: [],
                firstCanvasCommands: [],
                workspaceCalls: 0,
                uploadBytes: 0,
                uploadCalls: 0,
                rafCallback: null,
            });
            const nextFrame = window.requestAnimationFrame.bind(window);
            window.paintNextFrame = () => new Promise((resolve) => nextFrame(resolve));
            for (const name of ['onpointerdown', 'onpointermove', 'onpointerup']) {
                let owner = HTMLElement.prototype;
                while (owner && !Object.getOwnPropertyDescriptor(owner, name))
                    owner = Object.getPrototypeOf(owner);
                const descriptor = Object.getOwnPropertyDescriptor(owner, name);
                Object.defineProperty(owner, name, {
                    ...descriptor,
                    set(handler) {
                        descriptor.set.call(
                            this,
                            typeof handler !== 'function'
                                ? handler
                                : function (event) {
                                      if (
                                          !metrics.recording ||
                                          !this.matches?.('.workspace canvas') ||
                                          (name === 'onpointermove' && !event.buttons)
                                      )
                                          return handler.call(this, event);
                                      const input = {
                                          id: ++metrics.sequence,
                                          name,
                                          stroke: metrics.stroke,
                                          at: performance.now(),
                                      };
                                      metrics.pendingInputs.push(input);
                                      try {
                                          return handler.call(this, event);
                                      } finally {
                                          metrics.handlers.push({
                                              ...input,
                                              duration: performance.now() - input.at,
                                          });
                                      }
                                  },
                        );
                    },
                });
            }
            window.requestAnimationFrame = (callback) =>
                nextFrame((time) => {
                    const start = performance.now(),
                        bytes = metrics.uploadBytes,
                        calls = metrics.uploadCalls,
                        draws = metrics.workspaceCalls,
                        id = metrics.frames.length;
                    metrics.rafCallback = id;
                    try {
                        callback(time);
                    } finally {
                        metrics.rafCallback = null;
                        if (metrics.recording)
                            metrics.frames.push({
                                id,
                                stroke: metrics.stroke,
                                start,
                                duration: performance.now() - start,
                                workspaceCalls: metrics.workspaceCalls - draws,
                                uploadBytes: metrics.uploadBytes - bytes,
                                uploadCalls: metrics.uploadCalls - calls,
                            });
                    }
                });
            for (const prototype of [
                CanvasRenderingContext2D.prototype,
                globalThis.OffscreenCanvasRenderingContext2D?.prototype,
            ].filter(Boolean)) {
                for (const name of ['putImageData', 'drawImage', 'fillRect', 'clearRect']) {
                    const original = prototype[name];
                    prototype[name] = function (...args) {
                        const start = performance.now(),
                            value = original.apply(this, args);
                        if (!metrics.recording) return value;
                        if (name === 'putImageData') {
                            metrics.uploadBytes +=
                                (args.length >= 7
                                    ? Math.max(0, args[5]) * Math.max(0, args[6])
                                    : args[0].width * args[0].height) * 4;
                            metrics.uploadCalls++;
                        }
                        if (this.canvas.matches?.('.workspace canvas')) {
                            metrics.workspaceCalls++;
                            for (const input of metrics.pendingInputs.splice(0))
                                metrics.firstCanvasCommands.push({
                                    ...input,
                                    method: name,
                                    canvasCommandAt: start,
                                    latency: start - input.at,
                                    rafCallback: metrics.rafCallback,
                                });
                        }
                        return value;
                    };
                }
            }
            const observer = new PerformanceObserver((list) => {
                for (const entry of list.getEntries())
                    metrics.longTasks.push({ start: entry.startTime, duration: entry.duration });
            });
            observer.observe({ type: 'longtask', buffered: true });
            window.paintDrainLongTasks = () => {
                for (const entry of observer.takeRecords())
                    metrics.longTasks.push({ start: entry.startTime, duration: entry.duration });
            };
        };
        try {
            ownedContext = await browser.newContext({
                viewport: { width: 1400, height: 1000 },
                deviceScaleFactor: 1,
            });
            await ownedContext.addInitScript(installMetrics);
            const control = await ownedContext.newPage();
            await control.goto('data:text/html,<section class="workspace"><canvas></canvas></section>');
            result.instrumentationControl = await control.evaluate(async () => {
                const canvas = document.querySelector('canvas'),
                    ctx = canvas.getContext('2d'),
                    m = window.paintMetrics;
                m.recording = true;
                canvas.onpointerdown = () => {};
                canvas.dispatchEvent(new PointerEvent('pointerdown', { buttons: 1 }));
                await new Promise((resolve) => requestAnimationFrame(resolve));
                const afterIdle = m.firstCanvasCommands.length;
                await new Promise((resolve) =>
                    requestAnimationFrame(() => {
                        ctx.fillRect(0, 0, 1, 1);
                        resolve();
                    }),
                );
                const afterFirst = m.firstCanvasCommands.length;
                await new Promise((resolve) =>
                    requestAnimationFrame(() => {
                        ctx.fillRect(1, 0, 1, 1);
                        resolve();
                    }),
                );
                const afterRepeated = m.firstCanvasCommands.length;
                canvas.dispatchEvent(new PointerEvent('pointerdown', { buttons: 1 }));
                ctx.fillRect(2, 0, 1, 1);
                return {
                    afterIdle,
                    afterFirst,
                    afterRepeated,
                    records: m.firstCanvasCommands,
                    pending: m.pendingInputs.length,
                };
            });
            assert.deepEqual(
                [
                    result.instrumentationControl.afterIdle,
                    result.instrumentationControl.afterFirst,
                    result.instrumentationControl.afterRepeated,
                    result.instrumentationControl.pending,
                ],
                [0, 1, 1, 0],
            );
            assert.deepEqual(
                result.instrumentationControl.records.map((r) => r.id),
                [1, 2],
            );
            assert.equal(result.instrumentationControl.records[1].rafCallback, null);
            await ownedContext.close();
            const url = process.env.PAINT_TEST_URL || 'http://127.0.0.1:8923/mypaint/';
            result.productionBundles = [];
            for (const size of brushSizes) {
                ownedContext = await browser.newContext({
                    viewport: { width: 1400, height: 1000 },
                    deviceScaleFactor: 1,
                });
                await ownedContext.addInitScript(installMetrics);
                const page = await ownedContext.newPage(),
                    errors = [];
                page.setDefaultTimeout(Math.max(1, Math.min(15000, deadline - performance.now())));
                page.on('pageerror', (error) => errors.push(error.message));
                const navigationAt = performance.now();
                await page.goto(url);
                await page.waitForSelector('canvas[data-ready=true]');
                const readyWallMs = performance.now() - navigationAt;
                await page.waitForTimeout(800);
                const bundleSources = [];
                const assets = await page.evaluate(() =>
                    performance
                        .getEntriesByType('resource')
                        .filter((e) => /\.(js|css)(\?|$)/.test(e.name))
                        .map((e) => e.name),
                );
                for (const asset of assets) {
                    const response = await ownedContext.request.get(asset);
                    assert(response.ok());
                    bundleSources.push({
                        url: asset,
                        sha256: crypto
                            .createHash('sha256')
                            .update(await response.body())
                            .digest('hex'),
                    });
                }
                const rawHtml = await ownedContext.request.get(url);
                result.productionBundles.push({
                    size,
                    url,
                    assets: bundleSources,
                    browser: browser.version(),
                    rawHtmlSha256: crypto
                        .createHash('sha256')
                        .update(await rawHtml.body())
                        .digest('hex'),
                    dynamicDomSha256: crypto
                        .createHash('sha256')
                        .update(await page.content())
                        .digest('hex'),
                    readyWallMs,
                    navigation: await page.evaluate(() =>
                        performance.getEntriesByType('navigation')[0].toJSON(),
                    ),
                    environment: await page.evaluate(() => ({
                        userAgent: navigator.userAgent,
                        dpr: devicePixelRatio,
                        viewport: [innerWidth, innerHeight],
                        hardwareConcurrency: navigator.hardwareConcurrency,
                    })),
                    scope: 'Fresh browser context on local HTTP; OS/browser startup and caches are not cold-system, WAN12Mbps/150ms or physical display measurements.',
                });
                await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
                await page.getByRole('dialog').getByRole('button', { name: '새 그림', exact: true }).click();
                await page.getByLabel('너비', { exact: true }).fill('800');
                await page.getByLabel('높이', { exact: true }).fill('600');
                await page.getByLabel('배경', { exact: true }).selectOption('투명');
                await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
                await page.waitForSelector('canvas[data-ready=true]');
                await page.getByRole('button', { name: '브러시', exact: true }).click();
                for (const [id, value] of [
                    ['size', size],
                    ['color', '#1679ea'],
                    ['opacity', 70],
                    ['hardness', 25],
                    ['stabilization', 25],
                ])
                    await page.locator('#' + id).evaluate((input, value) => {
                        input.value = String(value);
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    }, value);
                await page.locator('#pressure').uncheck();
                await page.locator('#square').uncheck();
                assert.equal(await page.locator('#zoom').textContent(), '100%');
                const rect = await page.locator('.workspace canvas').boundingBox(),
                    origin = { x: rect.x + (rect.width - 800) / 2, y: rect.y + (rect.height - 600) / 2 };
                for (let stroke = -1; stroke < samples; stroke++) {
                    assert(performance.now() < deadline, 'Benchmark time limit exceeded');
                    if (stroke === 0)
                        await page.evaluate(() => {
                            const m = window.paintMetrics;
                            m.handlers = [];
                            m.frames = [];
                            m.firstCanvasCommands = [];
                            m.pendingInputs = [];
                            m.uploadBytes = 0;
                            m.uploadCalls = 0;
                            m.workspaceCalls = 0;
                            m.windowStart = performance.now();
                            m.recording = true;
                        });
                    await page.evaluate((stroke) => {
                        window.paintMetrics.stroke = stroke;
                    }, stroke);
                    const y = origin.y + 80 + (stroke + 1) * 25;
                    await page.mouse.move(origin.x + 40, y);
                    await page.mouse.down();
                    for (let point = 1; point <= 120; point++)
                        await page.mouse.move(origin.x + 40 + point * 6, y + Math.sin(point / 10) * 20);
                    await page.mouse.up();
                    await page.evaluate(async () => {
                        await window.paintNextFrame();
                        await window.paintNextFrame();
                    });
                }
                const metrics = await page.evaluate(async () => {
                    const m = window.paintMetrics;
                    m.windowEnd = performance.now();
                    m.recording = false;
                    await new Promise((resolve) => setTimeout(resolve, 0));
                    window.paintDrainLongTasks();
                    return m;
                });
                for (const name of ['onpointerdown', 'onpointerup'])
                    assert.equal(
                        metrics.handlers.filter((h) => h.name === name).length,
                        samples,
                        'Every measured stroke must reach the real input handler',
                    );
                assert(metrics.handlers.filter((h) => h.name === 'onpointermove').length >= samples * 120);
                assert(metrics.firstCanvasCommands.length > 0);
                assert.equal(
                    new Set(metrics.firstCanvasCommands.map((r) => r.id)).size,
                    metrics.firstCanvasCommands.length,
                );
                const readbacks = [];
                for (const step of ['before', 'undo', 'redo']) {
                    if (step !== 'before')
                        await page
                            .getByRole('button', {
                                name: step === 'undo' ? '실행 취소' : '다시 실행',
                                exact: true,
                            })
                            .click();
                    await page
                        .getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true })
                        .click();
                    await page.locator('.download').waitFor();
                    const [download] = await Promise.all([
                        page.waitForEvent('download'),
                        page
                            .locator('.download')
                            .getByRole('button', { name: '파일 받기', exact: true })
                            .click(),
                    ]);
                    const file = path.join(output, `brush-${size}-${step}.rpaint`);
                    await download.saveAs(file);
                    readbacks.push(decodeProject(new Uint8Array(await fs.readFile(file))));
                    await page.getByRole('button', { name: '다운로드 닫기', exact: true }).click();
                }
                assert.notDeepEqual(readbacks[1], readbacks[0]);
                assert.deepEqual(readbacks[2], readbacks[0]);
                const pixels = readbacks[0].layers[0].pixels;
                assert.deepEqual(Array.from(pixels.subarray(pixels.length - 4)), [0, 0, 0, 0]);
                let ink = 0;
                for (let i = 0; i < pixels.length; i += 4)
                    if (pixels[i + 3]) {
                        ink++;
                        assert.deepEqual(Array.from(pixels.subarray(i, i + 3)), [22, 121, 234]);
                    }
                assert(ink > 120);
                assert.deepEqual(errors, []);
                result.browser.push({
                    operation: 'trusted-mouse-stroke',
                    width: 800,
                    height: 600,
                    size,
                    strokes: samples,
                    pointsPerStroke: 120,
                    settings: {
                        color: [22, 121, 234, 255],
                        opacity: 0.7,
                        hardness: 0.25,
                        stabilization: 25,
                        pressure: false,
                        square: false,
                    },
                    handlerSyncPrefixMs: Object.fromEntries(
                        ['onpointerdown', 'onpointermove', 'onpointerup'].map((name) => [
                            name,
                            distribution(
                                metrics.handlers.filter((h) => h.name === name).map((h) => h.duration),
                            ),
                        ]),
                    ),
                    renderRafCallbackMs: distribution(metrics.frames.map((f) => f.duration)),
                    inputToFirstCanvasCommandMs: distribution(
                        metrics.firstCanvasCommands.map((r) => r.latency),
                    ),
                    strokeClusters: Array.from({ length: samples }, (_, stroke) => ({
                        stroke,
                        moveMs: distribution(
                            metrics.handlers
                                .filter((h) => h.stroke === stroke && h.name === 'onpointermove')
                                .map((h) => h.duration),
                        ),
                    })),
                    unmatchedInputs: metrics.pendingInputs,
                    rawHandlers: metrics.handlers,
                    rawFrames: metrics.frames,
                    rawCanvasMatches: metrics.firstCanvasCommands,
                    uploadedBytesTotal: metrics.uploadBytes,
                    uploadCalls: metrics.uploadCalls,
                    longTasks: metrics.longTasks.filter(
                        (e) => e.start < metrics.windowEnd && e.start + e.duration > metrics.windowStart,
                    ),
                    window: [metrics.windowStart, metrics.windowEnd],
                    correctness: {
                        inkPixels: ink,
                        transparentCorner: true,
                        fullUndoRedoExact: true,
                        pageErrors: errors,
                    },
                    note: 'Wall time with measurement wrappers. First accepted Canvas command is neither completed valid frame nor photon. rAF callback excludes later MessagePort work. Move samples cluster by stroke/session; no stable-tail certification. Requested putImageData bytes are not GPU bus traffic.',
                });
                if (size === 100) {
                    // Exercise the exact shipped worker, without importing a dev-only engine into this page.
                    let workerAsset;
                    for (const asset of bundleSources) {
                        if (!/\.js(\?|$)/.test(asset.url)) continue;
                        const code = await (await ownedContext.request.get(asset.url)).text();
                        const name = code.match(/codec\.worker-[A-Za-z0-9_-]+\.js/)?.[0];
                        if (name) {
                            workerAsset = new URL('assets/' + name, url).href;
                            break;
                        }
                    }
                    if (!workerAsset) throw Error('Production worker asset not found');
                    result.productionBundles.at(-1).worker = {
                        url: workerAsset,
                        sha256: crypto
                            .createHash('sha256')
                            .update(await (await ownedContext.request.get(workerAsset)).body())
                            .digest('hex'),
                    };
                    const workerTimings = await page.evaluate(async (workerUrl) => {
                        const jobs = [];
                        let encoded;
                        for (const operation of ['project-write', 'project-read', 'fill']) {
                            const width = 2048,
                                height = 2048;
                            const pixels = new Uint8ClampedArray(width * height * 4);
                            pixels.fill(255);
                            const state =
                                operation === 'project-read'
                                    ? undefined
                                    : {
                                          width,
                                          height,
                                          background: [255, 255, 255, 255],
                                          active: 0,
                                          layers: [{ name: 'benchmark', visible: true, pixels }],
                                      };
                            const bytes =
                                operation === 'project-read'
                                    ? encoded
                                    : operation === 'fill'
                                      ? Uint8Array.of(0, 0, 0, 0, 255, 0, 0, 128)
                                      : undefined;
                            const gaps = [];
                            let running = true,
                                lastFrame = 0;
                            const tick = (now) => {
                                if (!running) return;
                                if (lastFrame) gaps.push(now - lastFrame);
                                lastFrame = now;
                                if (running) requestAnimationFrame(tick);
                            };
                            requestAnimationFrame(tick);
                            await window.paintNextFrame();
                            const start = performance.now();
                            const worker = new Worker(workerUrl, { type: 'module' });
                            let timer;
                            try {
                                const response = await new Promise((resolve, reject) => {
                                    timer = setTimeout(
                                        () => reject(Error('worker benchmark timeout')),
                                        20000,
                                    );
                                    worker.onmessage = (event) =>
                                        event.data.error
                                            ? reject(Error(event.data.error))
                                            : resolve(event.data);
                                    worker.onerror = (event) => {
                                        event.preventDefault();
                                        reject(Error(event.message));
                                    };
                                    const transfer = [];
                                    if (state)
                                        for (const layer of state.layers) transfer.push(layer.pixels.buffer);
                                    if (bytes) transfer.push(bytes.buffer);
                                    worker.postMessage(
                                        { operation, state, bytes, profileId: 'web' },
                                        transfer,
                                    );
                                });
                                const replyAt = performance.now(),
                                    elapsed = replyAt - start;
                                running = false;
                                if (operation === 'project-write') encoded = response.bytes;
                                if (
                                    operation === 'project-read' &&
                                    response.state.layers[0].pixels[0] !== 255
                                )
                                    throw Error('Worker decode mismatch');
                                if (
                                    operation === 'fill' &&
                                    (response.image.pixels[0] !== 255 || response.image.pixels[3] !== 128)
                                )
                                    throw Error('Worker fill mismatch');
                                await window.paintNextFrame();
                                await window.paintNextFrame();
                                running = false;
                                window.paintDrainLongTasks();
                                jobs.push({
                                    operation,
                                    width,
                                    height,
                                    elapsedMs: elapsed,
                                    rafGapsMs: gaps,
                                    window: [start, replyAt],
                                    longTasks: window.paintMetrics.longTasks.filter(
                                        (entry) =>
                                            entry.start < replyAt && entry.start + entry.duration > start,
                                    ),
                                    note: 'Shipped Worker startup/transfer/operation included; setup pixels excluded. Uses production protocol directly, not the runCodec queue wrapper.',
                                });
                            } finally {
                                clearTimeout(timer);
                                worker.terminate();
                                running = false;
                            }
                        }
                        return jobs;
                    }, workerAsset);
                    result.worker = workerTimings.map((job) => ({
                        ...job,
                        rafGapsMs: distribution(job.rafGapsMs),
                    }));
                }
                await page.screenshot({ path: path.join(output, `browser-${size}.png`) });
                assert.deepEqual(errors, []);
                await ownedContext.close();
                ownedContext = undefined;
            }
        } finally {
            clearTimeout(budgetTimer);
            try {
                await ownedContext?.close();
            } finally {
                await browser.close();
            }
        }
        assert(!result.browserDeadlineExceeded, 'Browser budget exhausted');
    }
} catch (error) {
    result.failure = String(error.stack || error);
    process.exitCode = 1;
}
result.elapsedMs = performance.now() - started;
result.loadAverageAtEnd = os.loadavg();
result.nodeMemoryAtEnd = process.memoryUsage();
await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
console.log(
    JSON.stringify(
        {
            label: result.label,
            elapsedMs: result.elapsedMs,
            core: result.core.map((row) => ({
                operation: row.operation,
                width: row.width,
                height: row.height,
                size: row.size,
                layerCount: row.layerCount,
                p95: row.durationsMs?.p95 ?? row.movesMs?.p95,
            })),
            browser: result.browser.map((row) => ({
                operation: row.operation,
                size: row.size,
                moveP95: row.handlerSyncPrefixMs.onpointermove.p95,
                renderP95: row.renderRafCallbackMs.p95,
                uploadedBytes: row.uploadedBytesTotal,
                longTasks: row.longTasks.length,
            })),
            worker: result.worker?.map((row) => ({
                operation: row.operation,
                elapsedMs: row.elapsedMs,
                rafGapP95: row.rafGapsMs.p95,
                longTasks: row.longTasks.length,
            })),
            failure: result.failure,
        },
        null,
        2,
    ),
);
