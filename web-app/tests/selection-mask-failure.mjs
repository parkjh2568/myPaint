import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createState, cloneState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(
        process.env.PAINT_SELECTION_MASK_FAILURE_OUTPUT ||
            '../build-web-work/task-planning/selection-mask/failure/results.json',
    ),
    out = path.dirname(output),
    hash = (bytes) => createHash('sha256').update(bytes).digest('hex'),
    nearestMaps = JSON.parse(
        await fs.readFile(new URL('./fixtures/nearest-qt.json', import.meta.url), 'utf8'),
    ).mapsBySource,
    modes = [
        'lasso-mask-allocation',
        'geometry-error',
        'geometry-profile',
        'geometry-overflow',
        'pointer-resize-limit',
        'negative-resize-clipboard',
    ],
    results = {
        url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
        scope: 'Public Chromium lasso/move/resize/menu/copy/cut/SaveAs-cancel/Escape/UndoRedo with actual geometry/codec Workers. Native file IPC and clipboard delivery are modeled. Read-only public Worker input observations compare pending raw RGBA; only explicitly named mask-allocation/Worker/clipboard failure responses are injected. No private Studio hooks, production deadlines changed, large lasso stress, physical clipboard, OS picker, hardware or memory/performance acceptance.',
        testSha256: hash(await fs.readFile(new URL(import.meta.url))),
        checks: [],
        cases: [],
        errors: [],
        failures: [],
        assets: [],
    };
await fs.mkdir(out, { recursive: true });
function instrumentation() {
    const probe = (window.selectionFailure = {
        maskFault: false,
        maskFailures: [],
        geometryFault: undefined,
        geometryFailures: [],
        clipboardReject: false,
        clipboardFailures: 0,
        writes: [],
        inputs: [],
    });
    const OriginalBytes = window.Uint8Array;
    window.Uint8Array = new Proxy(OriginalBytes, {
        construct(target, args) {
            if (probe.maskFault && args.length === 1 && args[0] === 32 * 32) {
                probe.maskFault = false;
                probe.maskFailures.push(args[0]);
                throw Error('Injected lasso mask allocation failure');
            }
            return Reflect.construct(target, args, target);
        },
    });
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
        postMessage(message, transfer) {
            if (message.operation === 'png-write')
                probe.inputs.push({
                    width: message.state.width,
                    height: message.state.height,
                    pixels: Array.from(message.state.layers[0].pixels),
                });
            if (message.operation === 'geometry' && probe.geometryFault) {
                this.selectionFault = probe.geometryFault;
                probe.geometryFailures.push(probe.geometryFault);
                probe.geometryFault = undefined;
            }
            return super.postMessage(message, transfer);
        }
        set onmessage(handler) {
            super.onmessage = (event) => {
                let data = event.data;
                if (this.selectionFault === 'geometry-error') {
                    this.dispatchEvent(
                        new ErrorEvent('error', {
                            message: 'Injected selection geometry failure',
                            cancelable: true,
                        }),
                    );
                    return;
                }
                if (this.selectionFault === 'geometry-profile')
                    data = { ...data, profileId: 'wrong-profile' };
                if (this.selectionFault === 'geometry-overflow')
                    data = { ...data, state: { ...data.state, width: 32768, height: 32768 } };
                handler.call(this, { data });
            };
        }
    };
    Object.defineProperty(navigator.clipboard, 'write', {
        configurable: true,
        value: async (items) => {
            if (items.length !== 1 || items[0].types.length !== 1 || items[0].types[0] !== 'image/png')
                throw Error('Expected actual PNG ClipboardItem');
            const blob = await items[0].getType('image/png');
            if (probe.clipboardReject) {
                probe.clipboardReject = false;
                probe.clipboardFailures++;
                throw Error('Injected selection clipboard rejection');
            }
            probe.writes.push(blob);
        },
    });
}
async function menu(page, name) {
    await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
}
async function controls(page) {
    return {
        dirty: (await page.title()).startsWith('* '),
        undo: await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
        redo: await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled(),
        pending: (await page.locator('.title').textContent()).includes('편집 중'),
    };
}
async function copy(page) {
    const n = await page.evaluate(() => window.selectionFailure.writes.length);
    await menu(page, '복사');
    await page.waitForFunction(
        (n) => window.selectionFailure.writes.length === n + 1 && !document.querySelector('.busy'),
        n,
    );
    return page.evaluate(() => window.selectionFailure.inputs.at(-1));
}
async function save(page, name) {
    const n = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.waitForFunction(
        (n) => window.__myPaintPersistenceTest.writes.length > n && !document.querySelector('.busy'),
        n,
    );
    const bytes = Uint8Array.from(
        await page.evaluate(() => [...window.__myPaintPersistenceTest.writes.at(-1).bytes]),
    );
    await fs.writeFile(path.join(out, name + '.rpaint'), bytes);
    return decodeProject(bytes, desktopLimits);
}
function exact(actual, expected) {
    assert.deepEqual(
        [actual.width, actual.height, actual.active, actual.background],
        [expected.width, expected.height, expected.active, expected.background],
    );
    assert.equal(actual.layers.length, expected.layers.length);
    for (let i = 0; i < expected.layers.length; i++) {
        assert.deepEqual(
            [actual.layers[i].name, actual.layers[i].visible],
            [expected.layers[i].name, expected.layers[i].visible],
        );
        assert.deepEqual(actual.layers[i].pixels, expected.layers[i].pixels);
    }
}
async function lasso(page, origin) {
    await page.getByRole('button', { name: '자유 선택', exact: true }).click();
    await page.mouse.move(origin.x + 8, origin.y + 8);
    await page.mouse.down();
    for (const [x, y] of [
        [40, 8],
        [40, 40],
        [8, 40],
        [8, 8],
    ])
        await page.mouse.move(origin.x + x, origin.y + y);
    await page.mouse.up();
}
async function resize(page) {
    const before = await page.evaluate(
        () => window.__myPaintPersistenceTest.codecJobs.filter((job) => job.operation === 'geometry').length,
    );
    await menu(page, '선택 크기');
    await page.getByLabel('너비', { exact: true }).fill('24');
    await page.getByLabel('높이', { exact: true }).fill('20');
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
    await page.waitForFunction(
        (n) =>
            window.__myPaintPersistenceTest.codecJobs.filter((job) => job.operation === 'geometry').length ===
                n + 1 &&
            window.__myPaintPersistenceTest.liveWorkers.size === 0 &&
            !document.querySelector('.busy'),
        before,
    );
}
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
results.browser = browser.version();
try {
    for (const mode of modes) {
        const context = await browser.newContext({
                viewport: { width: 1400, height: 1000 },
                deviceScaleFactor: 1,
            }),
            page = await context.newPage(),
            record = { mode };
        results.cases.push(record);
        page.setDefaultTimeout(25000);
        page.on('pageerror', (error) => results.errors.push(error.message));
        page.on('request', (request) => {
            if (/\.js(?:[?#]|$)/.test(request.url()) && !results.assets.includes(request.url()))
                results.assets.push(request.url());
        });
        try {
            const state = createState(64, 64, [0, 0, 0, 0], desktopLimits);
            state.layers[0].name = 'visible background';
            state.layers.push({
                name: 'hidden selection source',
                visible: false,
                pixels: new Uint8ClampedArray(64 * 64 * 4),
            });
            state.active = 1;
            for (let y = 0; y < 64; y++)
                for (let x = 0; x < 64; x++) {
                    state.layers[0].pixels.set([13, 27, 49, 255], (y * 64 + x) * 4);
                    state.layers[1].pixels.set([17 + x, 31 + y, 201, 255], (y * 64 + x) * 4);
                }
            state.layers[1].pixels.set([193, 71, 117, 0], (1 * 64 + 1) * 4);
            const input = encodeProject(state, desktopLimits);
            await fs.writeFile(path.join(out, mode + '-input.rpaint'), input);
            record.inputSha256 = hash(input);
            await page.addInitScript(installNativeHarness, {});
            await page.addInitScript(instrumentation);
            await page.goto(results.url);
            await page.waitForFunction(
                () =>
                    window.__myPaintPersistenceTest?.generation === 1 &&
                    !document.querySelector('dialog[open]'),
            );
            await page.evaluate(
                (bytes) =>
                    window.__myPaintPersistenceTest.queueOpen('selection.rpaint', Uint8Array.from(bytes)),
                [...input],
            );
            await page.getByRole('button', { name: '파일 열기', exact: true }).click();
            await page.waitForFunction(
                () =>
                    window.__myPaintPersistenceTest.generation === 2 &&
                    !document.querySelector('.busy') &&
                    document.querySelector('.workspace canvas').dataset.ready === 'true',
            );
            assert.equal(await page.locator('#zoom').textContent(), '100%');
            const box = await page.locator('.workspace canvas').boundingBox(),
                origin = { x: box.x + box.width / 2 - 32, y: box.y + box.height / 2 - 32 };
            await page.getByRole('button', { name: '연필', exact: true }).click();
            await page.mouse.click(origin.x + 55.5, origin.y + 55.5);
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await controls(page), { dirty: false, undo: false, redo: true, pending: false });
            if (mode === 'lasso-mask-allocation') {
                await page.evaluate(() => (window.selectionFailure.maskFault = true));
                await lasso(page, origin);
                await page.waitForFunction(() =>
                    document.querySelector('.status').textContent.includes('Injected lasso'),
                );
                record.afterFailure = await controls(page);
                assert.deepEqual(record.afterFailure, {
                    dirty: false,
                    undo: false,
                    redo: true,
                    pending: false,
                });
                record.maskCleanup = await page.evaluate(() => window.selectionFailure.maskFailures);
                assert.deepEqual(
                    record.maskCleanup,
                    [1024],
                    'Actual1024-byte mask allocation must fail exactly once',
                );
                exact(await save(page, mode + '-failed-source'), state);
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                await lasso(page, origin);
            } else await lasso(page, origin);
            const originalPending = await copy(page),
                literal = [];
            assert.deepEqual([originalPending.width, originalPending.height], [32, 32]);
            for (let y = 8; y < 40; y++)
                for (let x = 8; x < 40; x++)
                    literal.push(...state.layers[1].pixels.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
            assert.deepEqual(originalPending.pixels, literal, 'Simple axis-aligned lasso literal raw RGBA');
            const pendingControls = await controls(page);
            if (mode.startsWith('geometry-')) {
                await page.evaluate((mode) => (window.selectionFailure.geometryFault = mode), mode);
                await resize(page);
                await page.waitForFunction(() =>
                    /Injected|일치|한도/.test(document.querySelector('.status').textContent),
                );
                record.afterFailure = await controls(page);
                assert.deepEqual(record.afterFailure, pendingControls);
                assert.match(await page.locator('.status').textContent(), /Injected|일치|한도/);
                assert.deepEqual(
                    await copy(page),
                    originalPending,
                    'Failed geometry must preserve pending raw raster',
                );
                if (mode === 'geometry-overflow') {
                    await page.locator('.workspace canvas').focus();
                    await page.keyboard.press('Escape');
                    exact(await save(page, mode + '-failed-source'), state);
                    assert.deepEqual(await controls(page), {
                        dirty: false,
                        undo: false,
                        redo: true,
                        pending: false,
                    });
                    await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                    await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                    await lasso(page, origin);
                }
                await resize(page);
                const resized = await copy(page),
                    expectedPixels = [];
                assert.deepEqual([resized.width, resized.height], [24, 20]);
                for (let y = 0; y < 20; y++)
                    for (let x = 0; x < 24; x++) {
                        const sx = 8 + Number(nearestMaps[31][23].split(',')[x]),
                            sy = 8 + Number(nearestMaps[31][19].split(',')[y]);
                        expectedPixels.push(
                            ...state.layers[1].pixels.subarray((sy * 64 + sx) * 4, (sy * 64 + sx) * 4 + 4),
                        );
                    }
                assert.deepEqual(resized.pixels, expectedPixels);
                record.firstRetryExact = true;
            } else if (mode === 'pointer-resize-limit') {
                await page.mouse.move(origin.x + 39.5, origin.y + 39.5);
                await page.mouse.down();
                await page.mouse.move(origin.x + 6008, origin.y + 6008);
                await page.waitForFunction(() =>
                    document.querySelector('.status').textContent.includes('한도'),
                );
                await page.mouse.up();
                assert.deepEqual(await controls(page), pendingControls);
                assert.deepEqual(
                    await copy(page),
                    originalPending,
                    'Pointer limit failure must restore drag-start raster',
                );
                await page.mouse.move(origin.x + 39.5, origin.y + 39.5);
                await page.mouse.down();
                await page.mouse.move(origin.x + 32, origin.y + 28);
                await page.mouse.up();
                const retried = await copy(page);
                assert.deepEqual([retried.width, retried.height], [24, 20]);
                record.firstRetryExact = true;
            } else if (mode === 'negative-resize-clipboard') {
                await page.mouse.move(origin.x + 16, origin.y + 16);
                await page.mouse.down();
                await page.mouse.move(origin.x, origin.y + 2);
                await page.mouse.up();
                await resize(page);
                const beforeReject = await copy(page),
                    beforeControls = await controls(page);
                assert.deepEqual([beforeReject.width, beforeReject.height], [24, 20]);
                await page.evaluate(() => (window.selectionFailure.clipboardReject = true));
                await menu(page, '잘라내기');
                await page.waitForFunction(
                    () => window.selectionFailure.clipboardFailures === 1 && !document.querySelector('.busy'),
                );
                assert.match(await page.locator('.status').textContent(), /Injected selection clipboard/);
                assert.deepEqual(await controls(page), beforeControls);
                assert.deepEqual(await copy(page), beforeReject);
                const beforeCancel = await page.evaluate(() => ({
                    picks: window.__myPaintPersistenceTest.pickerCount,
                    writes: window.__myPaintPersistenceTest.writes.length,
                }));
                await page.evaluate(() => window.__myPaintPersistenceTest.savePicks.push(null));
                await menu(page, '프로젝트 다른 이름 저장');
                await page.waitForFunction(
                    (n) =>
                        window.__myPaintPersistenceTest.pickerCount === n + 1 &&
                        !document.querySelector('.busy'),
                    beforeCancel.picks,
                );
                assert.equal(
                    await page.evaluate(() => window.__myPaintPersistenceTest.writes.length),
                    beforeCancel.writes,
                );
                assert.deepEqual(await controls(page), beforeControls);
                assert.deepEqual(
                    await copy(page),
                    beforeReject,
                    'SaveAs cancellation must retain negative resized selection',
                );
                record.saveAsCancelExact = true;
                const cutWrites = await page.evaluate(() => window.selectionFailure.writes.length);
                await menu(page, '잘라내기');
                await page.waitForFunction(
                    (n) =>
                        window.selectionFailure.writes.length === n + 1 && !document.querySelector('.busy'),
                    cutWrites,
                );
                record.firstRetryExact = true;
            } else {
                await page.mouse.move(origin.x + 16, origin.y + 16);
                await page.mouse.down();
                await page.mouse.move(origin.x + 19, origin.y + 18);
                await page.mouse.up();
                record.firstRetryExact = true;
            }
            const expected = cloneState(state),
                pixels = expected.layers[1].pixels;
            for (let y = 8; y < 40; y++)
                for (let x = 8; x < 40; x++) pixels.set([0, 0, 0, 0], (y * 64 + x) * 4);
            if (mode !== 'negative-resize-clipboard') {
                expected.layers[1].visible = true;
                const w = mode.startsWith('geometry-') || mode === 'pointer-resize-limit' ? 24 : 32,
                    h = mode.startsWith('geometry-') || mode === 'pointer-resize-limit' ? 20 : 32,
                    dx = mode.startsWith('geometry-') || mode === 'pointer-resize-limit' ? 8 : 11,
                    dy = mode.startsWith('geometry-') || mode === 'pointer-resize-limit' ? 8 : 10;
                for (let y = 0; y < h; y++)
                    for (let x = 0; x < w; x++) {
                        const sx = 8 + Number(nearestMaps[31][w - 1].split(',')[x]),
                            sy = 8 + Number(nearestMaps[31][h - 1].split(',')[y]);
                        pixels.set(
                            state.layers[1].pixels.subarray((sy * 64 + sx) * 4, (sy * 64 + sx) * 4 + 4),
                            ((dy + y) * 64 + dx + x) * 4,
                        );
                    }
            }
            const committed = await save(page, mode + '-retry');
            exact(committed, expected);
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            exact(await save(page, mode + '-undo'), state);
            assert(
                !(await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled()),
                'Exactly one committed edit after retry',
            );
            await page.getByRole('button', { name: '다시 실행', exact: true }).click();
            exact(await save(page, mode + '-redo'), expected);
            record.resources = await page.evaluate(() => ({
                workers: window.__myPaintPersistenceTest.liveWorkers.size,
                busy: !!document.querySelector('.busy'),
                inert: [...document.querySelectorAll('.topbar,.tools,.inspector')].map((node) => node.inert),
                geometryFailures: window.selectionFailure.geometryFailures,
                clipboardFailures: window.selectionFailure.clipboardFailures,
            }));
            assert.equal(record.resources.workers, 0);
            assert.equal(record.resources.busy, false);
            assert.deepEqual(record.resources.inert, [false, false, false]);
            if (mode.startsWith('geometry-')) assert.deepEqual(record.resources.geometryFailures, [mode]);
            record.ok = true;
            results.checks.push(mode);
        } catch (error) {
            record.error = String(error.stack || error);
            results.failures.push({ mode, error: record.error });
        } finally {
            await context.close();
        }
    }
} finally {
    await browser.close();
    results.ok = results.checks.length === modes.length && !results.errors.length && !results.failures.length;
    await fs.writeFile(output, JSON.stringify(results, null, 2) + '\n');
    console.log(
        JSON.stringify({ output, ok: results.ok, checks: results.checks, failures: results.failures }),
    );
    if (!results.ok) process.exitCode = 1;
}
