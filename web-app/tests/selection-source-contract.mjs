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
        process.env.PAINT_SELECTION_SOURCE_OUTPUT ||
            '../build-web-work/task-planning/selection-source/ui/results.json',
    ),
    out = path.dirname(output),
    hash = (bytes) => createHash('sha256').update(bytes).digest('hex'),
    background = [37, 59, 61, 0],
    palette = [
        [193, 71, 117, 0],
        [11, 29, 231, 0],
        [240, 20, 80, 1],
        [100, 10, 100, 1],
        [80, 144, 220, 128],
        [255, 255, 255, 128],
        [180, 30, 70, 255],
        [25, 127, 239, 255],
    ],
    cases = ['rect', 'lasso'].flatMap((shape) =>
        ['delete', 'cut', 'move'].map((action) => ({
            name: shape + '-' + action + '-preserves-transparent-background-raw',
            shape,
            action,
        })),
    ),
    results = {
        url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
        scope: 'Public Chromium selection/delete/cut/negative-move/settle, actual codec Workers and ClipboardItem PNG, modeled native IPC and clipboard rejection. Independent Node zlib PNG reader reused from clipboard-contract. Read-only public Worker.postMessage observation captures owned project candidates before transfer. Source replacement writes the explicit raw document background; this is distinct from Qt premultiplied RGB storage and the round-eraser already-transparent NoOp policy. No private Studio hooks, OS clipboard/picker, physical input or performance acceptance.',
        testSha256: hash(await fs.readFile(new URL(import.meta.url))),
        sourceSha256: {},
        assets: [],
        checks: [],
        cases: [],
        errors: [],
        failures: [],
    };
cases.push({
    name: 'already-background-selection-delete-is-clean-noop-and-preserves-redo',
    shape: 'rect',
    action: 'delete',
    noop: true,
});
await fs.mkdir(out, { recursive: true });
for (const file of ['main.ts', 'engine/document.ts', 'engine/operations.ts', 'workers/codec.worker.ts'])
    results.sourceSha256[file] = hash(await fs.readFile(new URL('../src/' + file, import.meta.url)));
// Independent PNG8 RGBA reader; no production decoder or Canvas roundtrip oracle.
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
    const probe = (window.__selectionSourceTest = {
        projectInputs: [],
        writes: [],
        rejectNext: false,
        rejected: 0,
    });
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
        postMessage(message, transfer) {
            if (message.operation === 'project-write' && message.state)
                probe.projectInputs.push(structuredClone(message.state));
            return super.postMessage(message, transfer);
        }
    };
    Object.defineProperty(navigator.clipboard, 'write', {
        configurable: true,
        value: async (items) => {
            if (items.length !== 1 || items[0].types.length !== 1 || items[0].types[0] !== 'image/png')
                throw Error('Expected one actual PNG ClipboardItem');
            const blob = await items[0].getType('image/png'),
                bytes = [...new Uint8Array(await blob.arrayBuffer())],
                rejected = probe.rejectNext;
            probe.rejectNext = false;
            probe.writes.push({ bytes, rejected });
            if (rejected) {
                probe.rejected++;
                throw Error('Injected selection source clipboard rejection');
            }
        },
    });
}
async function menu(page, name) {
    await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.waitForFunction(() => !document.querySelector('.busy'));
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
}
async function snapshot(page, name) {
    const count = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.waitForFunction(
        (n) => window.__myPaintPersistenceTest.writes.length > n && !document.querySelector('.busy'),
        count,
    );
    const bytes = Uint8Array.from(
        await page.evaluate(() => [...window.__myPaintPersistenceTest.writes.at(-1).bytes]),
    );
    await fs.writeFile(path.join(out, name + '.rpaint'), bytes);
    return decodeProject(bytes, desktopLimits);
}
async function select(page, shape, left, top) {
    await page
        .getByRole('button', { name: shape === 'lasso' ? '자유 선택' : '사각 선택', exact: true })
        .click();
    await page.locator('#transparent-selection').uncheck();
    await page.mouse.move(left + 3, top + 3);
    await page.mouse.down();
    for (const [x, y] of shape === 'lasso'
        ? [
              [15, 3],
              [15, 7],
              [9, 7],
              [9, 11],
              [3, 11],
          ]
        : [[15, 11]])
        await page.mouse.move(left + x, top + y);
    await page.mouse.up();
}
async function copy(page, name, cut = false) {
    const count = await page.evaluate(() => window.__selectionSourceTest.writes.length);
    await menu(page, cut ? '잘라내기' : '복사');
    await page.waitForFunction(
        (n) => window.__selectionSourceTest.writes.length > n && !document.querySelector('.busy'),
        count,
    );
    const item = await page.evaluate(() => window.__selectionSourceTest.writes.at(-1)),
        bytes = Uint8Array.from(item.bytes);
    await fs.writeFile(path.join(out, name + '.png'), bytes);
    return { image: readPng(bytes), bytes, rejected: item.rejected };
}
async function pending(page, name) {
    const before = await page.evaluate(() => ({
        inputs: window.__selectionSourceTest.projectInputs.length,
        picks: window.__myPaintPersistenceTest.pickerCount,
        writes: window.__myPaintPersistenceTest.writes.length,
    }));
    await page.evaluate(() => window.__myPaintPersistenceTest.savePicks.push(null));
    await menu(page, '프로젝트 다른 이름 저장');
    const observed = await page.evaluate(() => {
        const state = window.__selectionSourceTest.projectInputs.at(-1);
        return { ...state, layers: state.layers.map((layer) => ({ ...layer, pixels: [...layer.pixels] })) };
    });
    assert.deepEqual(
        await page.evaluate(() => ({
            inputs: window.__selectionSourceTest.projectInputs.length,
            picks: window.__myPaintPersistenceTest.pickerCount,
            writes: window.__myPaintPersistenceTest.writes.length,
        })),
        { inputs: before.inputs + 1, picks: before.picks + 1, writes: before.writes },
    );
    const state = {
        ...observed,
        layers: observed.layers.map((layer) => ({ ...layer, pixels: Uint8ClampedArray.from(layer.pixels) })),
    };
    await fs.writeFile(path.join(out, name + '.rpaint'), encodeProject(state, desktopLimits));
    return state;
}
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
results.browser = browser.version();
try {
    for (const [index, fixture] of cases.entries()) {
        const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } }),
            page = await context.newPage(),
            prefix = String(index + 1).padStart(2, '0'),
            record = { ...fixture };
        results.cases.push(record);
        page.setDefaultTimeout(30000);
        page.on('pageerror', (error) => results.errors.push(error.message));
        page.on('request', (request) => {
            if (/\.js(?:[?#]|$)/.test(request.url()) && !results.assets.includes(request.url()))
                results.assets.push(request.url());
        });
        try {
            const source = createState(24, 16, [...background], desktopLimits);
            source.layers[0].name = 'single raw transparent background';
            for (let y = 0; y < 16; y++)
                for (let x = 0; x < 24; x++)
                    source.layers[0].pixels.set(
                        fixture.noop ? background : palette[(x + 3 * y) % palette.length],
                        (y * 24 + x) * 4,
                    );
            const bytes = encodeProject(source, desktopLimits);
            await fs.writeFile(path.join(out, prefix + '-input.rpaint'), bytes);
            record.inputSha256 = hash(bytes);
            await page.addInitScript(installNativeHarness, {});
            await page.addInitScript(instrument);
            await page.goto(results.url);
            await page.waitForFunction(
                () =>
                    window.__myPaintPersistenceTest?.generation === 1 &&
                    !document.querySelector('dialog[open]'),
            );
            await page.evaluate(
                (value) =>
                    window.__myPaintPersistenceTest.queueOpen(
                        'selection-source.rpaint',
                        Uint8Array.from(value),
                    ),
                [...bytes],
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
                left = box.x + box.width / 2 - 12,
                top = box.y + box.height / 2 - 8,
                seeded = cloneState(source);
            seeded.layers[0].pixels.set([22, 121, 234, 255], (13 * 24 + 21) * 4);
            await page.getByRole('button', { name: '연필', exact: true }).click();
            await page.mouse.click(left + 21.5, top + 13.5);
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            assert.deepEqual(await snapshot(page, prefix + '-original'), source);
            await select(page, fixture.shape, left, top);
            const payload = new Uint8ClampedArray(12 * 8 * 4),
                pngPixels = new Uint8ClampedArray(12 * 8 * 4);
            for (let y = 0; y < 8; y++)
                for (let x = 0; x < 12; x++) {
                    const i = ((y + 3) * 24 + x + 3) * 4,
                        j = (y * 12 + x) * 4;
                    payload.set(source.layers[0].pixels.subarray(i, i + 4), j);
                    if (fixture.shape === 'lasso' && y >= 4 && x >= 6) payload[j + 3] = 0;
                    if (payload[j + 3]) pngPixels.set(payload.subarray(j, j + 4), j);
                }
            const firstCopy = await copy(page, prefix + '-unmodified-copy');
            assert.deepEqual(firstCopy.image, { width: 12, height: 8, pixels: pngPixels });
            assert.deepEqual(await pending(page, prefix + '-unmodified-pending'), source);
            if (fixture.action === 'cut') {
                await page.evaluate(() => (window.__selectionSourceTest.rejectNext = true));
                const failed = await copy(page, prefix + '-rejected-cut', true);
                assert(failed.rejected);
                assert.deepEqual(failed.image, firstCopy.image);
                assert.deepEqual(await pending(page, prefix + '-after-rejected-cut'), source);
                assert.deepEqual(
                    (await copy(page, prefix + '-after-rejected-cut-copy')).image,
                    firstCopy.image,
                );
                record.rejectedPayloadSha256 = hash(failed.bytes);
            }
            await page.locator('.workspace canvas').focus();
            await page.keyboard.press('Escape');
            assert(!(await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled()));
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            assert.deepEqual(await snapshot(page, prefix + '-cancel-original'), source);
            await page.getByRole('button', { name: '다시 실행', exact: true }).click();
            assert.deepEqual(await snapshot(page, prefix + '-cancel-preserved-redo'), seeded);
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await snapshot(page, prefix + '-cancel-undo-redo'), source);
            record.cancelSourceAndRedoExact = true;
            await select(page, fixture.shape, left, top);
            const expected = cloneState(source);
            for (let y = 0; y < 8; y++)
                for (let x = 0; x < 12; x++) {
                    if (fixture.shape === 'lasso' && y >= 4 && x >= 6) continue;
                    expected.layers[0].pixels.set(background, ((y + 3) * 24 + x + 3) * 4);
                }
            let pendingMove;
            if (fixture.action === 'move') {
                await page.locator('.workspace canvas').focus();
                for (let n = 0; n < 5; n++) await page.keyboard.press('ArrowLeft');
                for (let n = 0; n < 4; n++) await page.keyboard.press('ArrowUp');
                for (let y = 0; y < 8; y++)
                    for (let x = 0; x < 12; x++) {
                        const tx = x - 2,
                            ty = y - 1,
                            j = (y * 12 + x) * 4;
                        if (tx < 0 || ty < 0 || !payload[j + 3]) continue;
                        const i = (ty * 24 + tx) * 4,
                            a = payload[j + 3] / 255,
                            b = expected.layers[0].pixels[i + 3] / 255,
                            alpha = a + b * (1 - a);
                        for (let channel = 0; channel < 3; channel++)
                            expected.layers[0].pixels[i + channel] = Math.round(
                                (payload[j + channel] * a +
                                    expected.layers[0].pixels[i + channel] * b * (1 - a)) /
                                    alpha,
                            );
                        expected.layers[0].pixels[i + 3] = Math.round(alpha * 255);
                    }
                assert.deepEqual((await copy(page, prefix + '-negative-copy')).image, firstCopy.image);
                pendingMove = await pending(page, prefix + '-negative-pending');
                record.pendingRawMatchesExpected = pendingMove.layers[0].pixels.every(
                    (v, i) => v === expected.layers[0].pixels[i],
                );
                await page.locator('.workspace canvas').focus();
                await page.keyboard.press('Enter');
            } else if (fixture.action === 'cut') {
                const cut = await copy(page, prefix + '-accepted-cut', true);
                assert(!cut.rejected);
                assert.deepEqual(cut.image, firstCopy.image);
                assert.equal(hash(cut.bytes), record.rejectedPayloadSha256);
            } else await menu(page, '선택 삭제');
            await page.evaluate(
                () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            );
            record.afterAction = {
                undo: await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
                redo: await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled(),
                dirty: (await page.title()).startsWith('* '),
            };
            const actual = await snapshot(page, prefix + '-actual');
            await fs.writeFile(
                path.join(out, prefix + '-expected.rpaint'),
                encodeProject(expected, desktopLimits),
            );
            record.actualRawSha256 = hash(actual.layers[0].pixels);
            record.expectedRawSha256 = hash(expected.layers[0].pixels);
            record.mismatchedRawChannels = actual.layers[0].pixels.reduce(
                (count, value, i) => count + (value !== expected.layers[0].pixels[i] ? 1 : 0),
                0,
            );
            if (fixture.noop && !record.afterAction.undo) {
                assert.deepEqual(record.afterAction, { undo: false, redo: true, dirty: false });
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                assert.deepEqual(await snapshot(page, prefix + '-noop-preserved-redo'), seeded);
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                assert.deepEqual(await snapshot(page, prefix + '-noop-undo-redo'), source);
                record.noopAndRedoExact = true;
            } else {
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                assert(
                    !(await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled()),
                    'One edit must undo directly to the original document',
                );
                assert.deepEqual(await snapshot(page, prefix + '-undo'), source);
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                assert.deepEqual(await snapshot(page, prefix + '-redo'), actual);
                record.singleUndoRedoExact = true;
            }
            record.clipboardRejections = await page.evaluate(() => window.__selectionSourceTest.rejected);
            assert.equal(record.clipboardRejections, fixture.action === 'cut' ? 1 : 0);
            record.liveWorkers = await page.evaluate(() => window.__myPaintPersistenceTest.liveWorkers.size);
            assert.equal(record.liveWorkers, 0);
            assert.deepEqual(
                actual,
                expected,
                'Source replacement must use the exact raw background, preserving all pixels outside the binary source mask',
            );
            if (pendingMove)
                assert.deepEqual(
                    pendingMove,
                    expected,
                    'Pending and committed move must share the raw Source-clear contract',
                );
            if (fixture.noop) assert.deepEqual(record.afterAction, { undo: false, redo: true, dirty: false });
            record.ok = true;
            results.checks.push(fixture.name);
        } catch (error) {
            record.error = String(error.stack || error);
            results.failures.push({ name: fixture.name, error: record.error });
        } finally {
            await context.close();
        }
    }
} finally {
    await browser.close();
    results.ok = results.checks.length === cases.length && !results.errors.length && !results.failures.length;
    await fs.writeFile(output, JSON.stringify(results, null, 2) + '\n');
    console.log(
        JSON.stringify({ output, ok: results.ok, checks: results.checks, failures: results.failures }),
    );
    if (!results.ok) process.exitCode = 1;
}
