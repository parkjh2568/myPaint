import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync, crc32 } from 'node:zlib';
import { createState, cloneState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(
        process.env.PAINT_SELECTION_MASK_OUTPUT ||
            '../build-web-work/task-planning/selection-mask/ui/results.json',
    ),
    out = path.dirname(output),
    hash = (bytes) => createHash('sha256').update(bytes).digest('hex'),
    maskBytes = await fs.readFile(new URL('./fixtures/polygon-mask-qt.json', import.meta.url)),
    nearestBytes = await fs.readFile(new URL('./fixtures/nearest-qt.json', import.meta.url)),
    maskFixtures = JSON.parse(maskBytes),
    nearest = JSON.parse(nearestBytes).mapsBySource,
    palette = [
        [180, 30, 70, 255],
        [240, 20, 80, 1],
        [250, 10, 100, 1],
        [80, 144, 220, 128],
        [255, 255, 255, 128],
        [255, 255, 255, 255],
        [23, 89, 210, 0],
        [230, 12, 59, 0],
    ],
    shapes = ['concave', 'triangle', 'bowtie', 'hole'],
    results = {
        url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
        scope: 'Eight public Chromium lasso cases: four literal Qt shapes times transparent-key OFF/ON, three-layer raw palette, public picker/swap, negative keyboard movement, actual geometry/codec Workers and ClipboardItem PNG, canceled modeled SaveAs then Escape/source/old-Redo recovery and replay/settle or cut/oneUndoRedo. PNG independently read with Node zlib; straight RGB survives without Qt premultiplied storage quantization. Raw pending observations are read-only Worker.postMessage records. Stage failures continue to isolate membership, nearest mapping, cancellation and dependent final composition; no private Studio hooks, response edits, OS clipboard/picker, physical input or performance claim.',
        testSha256: hash(await fs.readFile(new URL(import.meta.url))),
        fixtureSha256: { polygonMask: hash(maskBytes), nearest: hash(nearestBytes) },
        checks: [],
        cases: [],
        failures: [],
        errors: [],
        assets: [],
    };
await fs.mkdir(out, { recursive: true });
function readPng(bytes) {
    assert.deepEqual(Array.from(bytes.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        data = [];
    let width = 0,
        height = 0,
        ended = false,
        offset = 8;
    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset);
        assert(length <= bytes.length - offset - 12);
        const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)),
            chunk = bytes.subarray(offset + 8, offset + 8 + length);
        assert.equal(
            crc32(bytes.subarray(offset + 4, offset + 8 + length)),
            view.getUint32(offset + 8 + length),
        );
        if (name === 'IHDR') {
            assert.equal(offset, 8);
            assert.equal(length, 13);
            width = view.getUint32(offset + 8);
            height = view.getUint32(offset + 12);
            assert(width > 0 && height > 0 && width <= 128 && height <= 128);
            assert.deepEqual(
                Array.from(chunk.subarray(8)),
                [8, 6, 0, 0, 0],
                'This independent reader requires non-interlaced PNG8 RGBA output',
            );
        } else if (name === 'IDAT') data.push(chunk);
        else if (name === 'IEND') {
            assert.equal(length, 0);
            ended = true;
            offset += 12;
            break;
        }
        offset += length + 12;
    }
    assert(ended);
    assert.equal(offset, bytes.length);
    const rowBytes = width * 4,
        raw = inflateSync(Buffer.concat(data), { maxOutputLength: height * (rowBytes + 1) + 1 });
    assert.equal(raw.length, height * (rowBytes + 1));
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (rowBytes + 1)];
        assert(filter <= 4);
        for (let x = 0; x < rowBytes; x++) {
            const a = x >= 4 ? pixels[y * rowBytes + x - 4] : 0,
                b = y ? pixels[(y - 1) * rowBytes + x] : 0,
                c = y && x >= 4 ? pixels[(y - 1) * rowBytes + x - 4] : 0;
            let predictor = 0;
            if (filter === 1) predictor = a;
            if (filter === 2) predictor = b;
            if (filter === 3) predictor = Math.floor((a + b) / 2);
            if (filter === 4) {
                const p = a + b - c,
                    pa = Math.abs(p - a),
                    pb = Math.abs(p - b),
                    pc = Math.abs(p - c);
                predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            pixels[y * rowBytes + x] = (raw[y * (rowBytes + 1) + 1 + x] + predictor) & 255;
        }
    }
    return { width, height, pixels };
}
function instrument() {
    const probe = (window.selectionContract = { inputs: [], writes: [] }),
        Original = window.Worker;
    window.Worker = class extends Original {
        postMessage(message, transfer) {
            if (message.operation === 'png-write')
                probe.inputs.push({
                    width: message.state.width,
                    height: message.state.height,
                    pixels: Array.from(message.state.layers[0].pixels),
                });
            return super.postMessage(message, transfer);
        }
    };
    Object.defineProperty(navigator.clipboard, 'write', {
        configurable: true,
        value: async (items) => {
            if (items.length !== 1 || items[0].types.length !== 1 || items[0].types[0] !== 'image/png')
                throw Error('Expected actual PNG ClipboardItem');
            probe.writes.push(await items[0].getType('image/png'));
        },
    });
}
function verify(record, stage, work) {
    try {
        work();
        record.stages.push({ stage, ok: true });
    } catch (error) {
        const failure = { name: record.name, stage, error: String(error.stack || error) };
        record.stages.push({ stage, ok: false, error: failure.error });
        results.failures.push(failure);
    }
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
    };
}
async function copied(page, name) {
    const n = await page.evaluate(() => window.selectionContract.writes.length);
    await menu(page, '복사');
    await page.waitForFunction(
        (n) => window.selectionContract.writes.length === n + 1 && !document.querySelector('.busy'),
        n,
    );
    const value = await page.evaluate(async () => ({
        input: window.selectionContract.inputs.at(-1),
        png: Array.from(new Uint8Array(await window.selectionContract.writes.at(-1).arrayBuffer())),
    }));
    const png = Uint8Array.from(value.png);
    await fs.writeFile(path.join(out, name + '.png'), png);
    return { input: value.input, image: readPng(png), pngSha256: hash(png) };
}
async function saved(page, name) {
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
async function lasso(page, origin, points) {
    await page.getByRole('button', { name: '자유 선택', exact: true }).click();
    await page.mouse.move(origin.x + points[0][0], origin.y + points[0][1]);
    await page.mouse.down();
    for (const [x, y] of points.slice(1)) await page.mouse.move(origin.x + x, origin.y + y);
    await page.mouse.move(origin.x + points[0][0], origin.y + points[0][1]);
    await page.mouse.up();
}
async function moveResize(page, left, top, width, height) {
    await page.locator('.workspace canvas').focus();
    for (let i = 0; i < left + 3; i++) await page.keyboard.press('ArrowLeft');
    for (let i = 0; i < top + 2; i++) await page.keyboard.press('ArrowUp');
    const before = await page.evaluate(
        () => window.__myPaintPersistenceTest.codecJobs.filter((job) => job.operation === 'geometry').length,
    );
    await menu(page, '선택 크기');
    await page.getByLabel('너비', { exact: true }).fill(String(width));
    await page.getByLabel('높이', { exact: true }).fill(String(height));
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
    await page.waitForFunction(
        (n) =>
            window.__myPaintPersistenceTest.codecJobs.filter((job) => job.operation === 'geometry').length ===
                n + 1 &&
            !document.querySelector('.busy') &&
            window.__myPaintPersistenceTest.liveWorkers.size === 0,
        before,
    );
}
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
results.browser = browser.version();
try {
    for (const shape of shapes)
        for (const transparent of [false, true]) {
            const name = shape + '-transparent-' + (transparent ? 'on' : 'off'),
                record = { name, shape, transparent, stages: [] },
                context = await browser.newContext({
                    viewport: { width: 1400, height: 1000 },
                    deviceScaleFactor: 1,
                }),
                page = await context.newPage();
            results.cases.push(record);
            page.setDefaultTimeout(25000);
            page.on('pageerror', (error) => results.errors.push(error.message));
            page.on('request', (request) => {
                if (/\.js(?:[?#]|$)/.test(request.url()) && !results.assets.includes(request.url()))
                    results.assets.push(request.url());
            });
            try {
                const fixture = maskFixtures.cases.find((item) => item.name === 'canvas-reference-' + shape);
                assert(fixture);
                const points = fixture.rawPoints,
                    left = Math.min(...points.map((p) => p[0])),
                    top = Math.min(...points.map((p) => p[1])),
                    width = Math.max(...points.map((p) => p[0])) - left,
                    height = Math.max(...points.map((p) => p[1])) - top,
                    target = shape === 'triangle' ? [8, 6] : shape === 'hole' ? [15, 13] : [13, 9],
                    state = createState(20, 14, [0, 0, 0, 0], desktopLimits);
                state.layers[0].name = 'base';
                state.layers.push(
                    {
                        name: 'hidden active raw palette',
                        visible: false,
                        pixels: new Uint8ClampedArray(20 * 14 * 4),
                    },
                    { name: 'unrelated upper', visible: true, pixels: new Uint8ClampedArray(20 * 14 * 4) },
                );
                state.active = 1;
                for (let y = 0; y < 14; y++)
                    for (let x = 0; x < 20; x++) {
                        const at = (y * 20 + x) * 4;
                        state.layers[0].pixels.set(
                            [11 + x * 7, 17 + y * 11, 31 + ((x + 20 * y) % 197), 255],
                            at,
                        );
                        state.layers[1].pixels.set(palette[(x + 3 * y) % 8], at);
                        state.layers[2].pixels.set([17 + x, 31 + y, 101, (x + y) % 3 ? 64 : 0], at);
                    }
                state.layers[0].pixels.set([250, 10, 100, 1], (12 * 20 + 18) * 4);
                state.layers[2].pixels.set([123, 49, 212, 0], (12 * 20 + 18) * 4);
                const input = encodeProject(state, desktopLimits);
                await fs.writeFile(path.join(out, name + '-input.rpaint'), input);
                record.inputSha256 = hash(input);
                record.sourceRect = [left, top, width, height];
                record.destination = [-3, -2, ...target];
                record.action = transparent ? 'cut' : 'settle';
                await page.addInitScript(installNativeHarness, {});
                await page.addInitScript(instrument);
                await page.goto(results.url);
                await page.waitForFunction(
                    () =>
                        window.__myPaintPersistenceTest?.generation === 1 &&
                        !document.querySelector('dialog[open]'),
                );
                await page.evaluate(
                    (bytes) =>
                        window.__myPaintPersistenceTest.queueOpen('mask.rpaint', Uint8Array.from(bytes)),
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
                    origin = { x: box.x + box.width / 2 - 10, y: box.y + box.height / 2 - 7 };
                await page.getByRole('button', { name: '연필', exact: true }).click();
                await page.mouse.click(origin.x + 18.5, origin.y + 12.5);
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                assert.deepEqual(await controls(page), { dirty: false, undo: false, redo: true });
                await page.getByRole('button', { name: '스포이트', exact: true }).click();
                await page.mouse.click(origin.x + 18.5, origin.y + 12.5);
                await page.getByRole('button', { name: '전경색 보조색 바꾸기', exact: true }).click();
                await page.locator('#transparent-selection').setChecked(transparent);
                const expectedLift = new Uint8ClampedArray(width * height * 4);
                for (let y = 0; y < height; y++)
                    for (let x = 0; x < width; x++) {
                        const at = ((top + y) * 20 + left + x) * 4,
                            j = (y * width + x) * 4;
                        expectedLift.set(state.layers[1].pixels.subarray(at, at + 4), j);
                        if (
                            fixture.maskRows[top + y][left + x] !== '#' ||
                            (transparent &&
                                expectedLift[j + 3] === 1 &&
                                Math.round(expectedLift[j] / 255) === 1 &&
                                Math.round(expectedLift[j + 1] / 255) === 0 &&
                                Math.round(expectedLift[j + 2] / 255) === 0)
                        )
                            expectedLift[j + 3] = 0;
                    }
                await lasso(page, origin, points);
                const initial = await copied(page, name + '-initial');
                record.initial = {
                    dimensions: [initial.input.width, initial.input.height],
                    rawSha256: hash(Uint8Array.from(initial.input.pixels)),
                    pngSha256: initial.pngSha256,
                };
                verify(record, 'literal-mask-raw', () => {
                    assert.deepEqual([initial.input.width, initial.input.height], [width, height]);
                    assert.deepEqual(Uint8Array.from(initial.input.pixels), new Uint8Array(expectedLift));
                });
                const expectedPng = expectedLift.slice();
                for (let at = 0; at < expectedPng.length; at += 4)
                    if (!expectedPng[at + 3]) expectedPng.fill(0, at, at + 4);
                verify(record, 'literal-mask-png', () => {
                    assert.deepEqual([initial.image.width, initial.image.height], [width, height]);
                    assert.deepEqual(initial.image.pixels, expectedPng);
                });
                await moveResize(page, left, top, ...target);
                const resized = await copied(page, name + '-negative-resized'),
                    resizedExpected = new Uint8ClampedArray(target[0] * target[1] * 4),
                    independentFromObserved = new Uint8ClampedArray(resizedExpected.length),
                    xMap = nearest[width - 1][target[0] - 1].split(',').map(Number),
                    yMap = nearest[height - 1][target[1] - 1].split(',').map(Number),
                    actualXMap = nearest[initial.input.width - 1][target[0] - 1].split(',').map(Number),
                    actualYMap = nearest[initial.input.height - 1][target[1] - 1].split(',').map(Number);
                for (let y = 0; y < target[1]; y++)
                    for (let x = 0; x < target[0]; x++) {
                        const at = (y * target[0] + x) * 4,
                            source = (yMap[y] * width + xMap[x]) * 4,
                            observed = (actualYMap[y] * initial.input.width + actualXMap[x]) * 4;
                        resizedExpected.set(expectedLift.subarray(source, source + 4), at);
                        independentFromObserved.set(initial.input.pixels.slice(observed, observed + 4), at);
                    }
                verify(record, 'nearest-isolated-from-observed-input', () => {
                    assert.deepEqual([resized.input.width, resized.input.height], target);
                    assert.deepEqual(
                        Uint8Array.from(resized.input.pixels),
                        new Uint8Array(independentFromObserved),
                    );
                });
                verify(record, 'combined-mask-nearest-raw', () =>
                    assert.deepEqual(Uint8Array.from(resized.input.pixels), new Uint8Array(resizedExpected)),
                );
                const resizedPng = resizedExpected.slice();
                for (let at = 0; at < resizedPng.length; at += 4)
                    if (!resizedPng[at + 3]) resizedPng.fill(0, at, at + 4);
                verify(record, 'combined-mask-nearest-png', () => {
                    assert.deepEqual([resized.image.width, resized.image.height], target);
                    assert.deepEqual(resized.image.pixels, resizedPng);
                });
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
                const afterCancel = await copied(page, name + '-after-save-cancel'),
                    cancelControls = await controls(page),
                    writeCount = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
                verify(record, 'save-as-cancel-pending', () => {
                    assert.equal(writeCount, beforeCancel.writes);
                    assert.deepEqual(afterCancel.input, resized.input);
                    assert.equal(afterCancel.pngSha256, resized.pngSha256);
                    assert.deepEqual(cancelControls, { dirty: false, undo: true, redo: false });
                });
                await page.locator('.workspace canvas').focus();
                await page.keyboard.press('Escape');
                const restored = await saved(page, name + '-escaped-source'),
                    restoredControls = await controls(page);
                verify(record, 'escape-source-old-redo', () => {
                    exact(restored, state);
                    assert.deepEqual(restoredControls, { dirty: false, undo: false, redo: true });
                });
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                await lasso(page, origin, points);
                await moveResize(page, left, top, ...target);
                if (transparent) {
                    const n = await page.evaluate(() => window.selectionContract.writes.length);
                    await menu(page, '잘라내기');
                    await page.waitForFunction(
                        (n) =>
                            window.selectionContract.writes.length === n + 1 &&
                            !document.querySelector('.busy'),
                        n,
                    );
                } else {
                    await page.locator('.workspace canvas').focus();
                    await page.keyboard.press('Enter');
                }
                const expected = cloneState(state),
                    destination = expected.layers[1].pixels;
                for (let y = 0; y < height; y++)
                    for (let x = 0; x < width; x++)
                        if (fixture.maskRows[top + y][left + x] === '#')
                            destination.set([0, 0, 0, 0], ((top + y) * 20 + left + x) * 4);
                if (!transparent) {
                    expected.layers[1].visible = true;
                    for (let y = 0; y < target[1]; y++)
                        for (let x = 0; x < target[0]; x++) {
                            const tx = x - 3,
                                ty = y - 2;
                            if (tx < 0 || ty < 0 || tx >= 20 || ty >= 14) continue;
                            const i = (ty * 20 + tx) * 4,
                                j = (y * target[0] + x) * 4,
                                a = resizedExpected[j + 3] / 255;
                            if (!a) continue;
                            const b = destination[i + 3] / 255,
                                alpha = a + b * (1 - a);
                            for (let channel = 0; channel < 3; channel++)
                                destination[i + channel] = Math.round(
                                    (resizedExpected[j + channel] * a +
                                        destination[i + channel] * b * (1 - a)) /
                                        alpha,
                                );
                            destination[i + 3] = Math.round(alpha * 255);
                        }
                }
                const committed = await saved(page, name + '-committed');
                verify(record, 'dependent-final-composition-source-visibility', () =>
                    exact(committed, expected),
                );
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                const undone = await saved(page, name + '-undo'),
                    noEarlierUndo = !(await page
                        .getByRole('button', { name: '실행 취소', exact: true })
                        .isEnabled());
                verify(record, 'single-undo-original-all-layers', () => {
                    exact(undone, state);
                    assert(noEarlierUndo);
                });
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                const redone = await saved(page, name + '-redo');
                verify(record, 'redo-exact-recorded-result', () => exact(redone, committed));
                record.resources = await page.evaluate(() => ({
                    workers: window.__myPaintPersistenceTest.liveWorkers.size,
                    busy: !!document.querySelector('.busy'),
                    inert: [...document.querySelectorAll('.topbar,.tools,.inspector')].map(
                        (node) => node.inert,
                    ),
                }));
                verify(record, 'resources-released', () =>
                    assert.deepEqual(record.resources, {
                        workers: 0,
                        busy: false,
                        inert: [false, false, false],
                    }),
                );
                record.ok = record.stages.every((stage) => stage.ok);
                if (record.ok) results.checks.push(name);
            } catch (error) {
                const failure = { name, stage: 'execution', error: String(error.stack || error) };
                record.error = failure.error;
                results.failures.push(failure);
            } finally {
                await context.close();
            }
        }
} finally {
    await browser.close();
    results.ok = results.checks.length === 8 && !results.failures.length && !results.errors.length;
    await fs.writeFile(output, JSON.stringify(results, null, 2) + '\n');
    console.log(
        JSON.stringify({
            output,
            ok: results.ok,
            checks: results.checks,
            failures: results.failures.map(({ name, stage, error }) => ({ name, stage, error })),
        }),
    );
    if (!results.ok) process.exitCode = 1;
}
