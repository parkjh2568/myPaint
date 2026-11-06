import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync, crc32 } from 'node:zlib';
import { createState, cloneState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(
        process.env.PAINT_PASTE_TRANSFORM_OUTPUT ||
            '../build-web-work/task-planning/selection-source/paste-transform/results.json',
    ),
    out = path.dirname(output),
    hash = (bytes) => createHash('sha256').update(bytes).digest('hex'),
    nearestBytes = await fs.readFile(new URL('./fixtures/nearest-qt.json', import.meta.url)),
    nearest = JSON.parse(nearestBytes).mapsBySource,
    colors = {
        A: [193, 71, 117, 0],
        B: [240, 20, 80, 1],
        C: [80, 144, 220, 128],
        D: [17, 91, 203, 255],
        E: [250, 10, 100, 1],
        F: [255, 255, 255, 128],
    },
    specifications = [
        {
            name: 'paste-rotate-flip-resize-settle',
            initial: ['ABC', 'DEF'],
            position: [-1, -1],
            action: 'settle',
            steps: [
                { kind: 'rotate', rows: ['DA', 'EB', 'FC'] },
                { kind: 'flip', rows: ['AD', 'BE', 'CF'] },
                { kind: 'resize', rows: ['AADD', 'BBEE', 'CCFF'] },
            ],
        },
        {
            name: 'paste-flip-rotate-resize-profile-retry',
            initial: ['AB', 'CD', 'EF'],
            position: [-1, -2],
            action: 'settle',
            fault: true,
            steps: [
                { kind: 'flip', rows: ['BA', 'DC', 'FE'] },
                { kind: 'rotate', rows: ['FDB', 'ECA'] },
                { kind: 'resize', rows: ['FDB', 'FDB', 'ECA', 'ECA'] },
            ],
        },
        {
            name: 'paste-four-rotations-qt-tie-resize-flip',
            initial: ['ABC', 'DEF'],
            position: [-1, -1],
            action: 'settle',
            steps: [
                { kind: 'rotate', rows: ['DA', 'EB', 'FC'] },
                { kind: 'rotate', rows: ['FED', 'CBA'] },
                { kind: 'rotate', rows: ['CF', 'BE', 'AD'] },
                { kind: 'rotate', rows: ['ABC', 'DEF'] },
                { kind: 'resize', rows: ['AC', 'AC', 'DF'] },
                { kind: 'flip', rows: ['CA', 'CA', 'FD'] },
            ],
        },
        {
            name: 'paste-transform-cut-has-no-original-source',
            initial: ['ABC', 'DEF'],
            position: [-1, -1],
            action: 'cut',
            steps: [
                { kind: 'rotate', rows: ['DA', 'EB', 'FC'] },
                { kind: 'flip', rows: ['AD', 'BE', 'CF'] },
                { kind: 'resize', rows: ['AADD', 'BBEE', 'CCFF'] },
            ],
        },
    ],
    results = {
        url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
        testSha256: hash(await fs.readFile(new URL(import.meta.url))),
        nearestFixtureSha256: hash(nearestBytes),
        scope: 'Public Chromium paste from an independently generated actual PNG ClipboardItem, negative keyboard movement, literal rotate/flip sequences and Qt literal nearest resize, actual codecs/geometry Workers. Native file IPC and clipboard transport are modeled. Read-only public Worker input observes raw selection; PNG independently read with Node zlib. One explicitly named wrong-profile Worker fault checks pending ownership/retry. Source-less paste is inferred from public paste behavior, not private Studio state access. Incoming alpha0 hiddenRGB normalizes through the documented composite boundary; nonzero-alpha straight RGB is not forced through Qt premultiplied rounding. No public lasso/source-mask, OS clipboard/picker, physical input, native app or performance claim.',
        checks: [],
        cases: [],
        errors: [],
        failures: [],
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
    const probe = (window.pasteTransform = {
            paste: undefined,
            reads: 0,
            writes: [],
            inputs: [],
            profileFault: false,
            injected: 0,
        }),
        Original = window.Worker;
    window.Worker = class extends Original {
        postMessage(message, transfer) {
            if (message.operation === 'png-write')
                probe.inputs.push({
                    width: message.state.width,
                    height: message.state.height,
                    pixels: Array.from(message.state.layers[0].pixels),
                });
            if (message.operation === 'geometry' && probe.profileFault) {
                probe.profileFault = false;
                probe.injected++;
                this.wrongSelectionProfile = true;
            }
            return super.postMessage(message, transfer);
        }
        set onmessage(handler) {
            super.onmessage = (event) =>
                handler.call(
                    this,
                    this.wrongSelectionProfile
                        ? { data: { ...event.data, profileId: 'wrong-profile' } }
                        : event,
                );
        }
    };
    Object.defineProperties(navigator.clipboard, {
        read: {
            configurable: true,
            value: async () => {
                probe.reads++;
                if (!probe.paste) throw Error('Missing paste PNG fixture');
                return [new ClipboardItem({ 'image/png': probe.paste })];
            },
        },
        write: {
            configurable: true,
            value: async (items) => {
                if (items.length !== 1 || items[0].types.length !== 1 || items[0].types[0] !== 'image/png')
                    throw Error('Expected one actual PNG ClipboardItem');
                probe.writes.push(await items[0].getType('image/png'));
            },
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
    };
}
async function copied(page, name) {
    const n = await page.evaluate(() => window.pasteTransform.writes.length);
    await menu(page, '복사');
    await page.waitForFunction(
        (n) => window.pasteTransform.writes.length === n + 1 && !document.querySelector('.busy'),
        n,
    );
    const value = await page.evaluate(async () => ({
        input: window.pasteTransform.inputs.at(-1),
        bytes: Array.from(new Uint8Array(await window.pasteTransform.writes.at(-1).arrayBuffer())),
    }));
    const bytes = Uint8Array.from(value.bytes);
    await fs.writeFile(path.join(out, name + '.png'), bytes);
    return { input: value.input, image: readPng(bytes), pngSha256: hash(bytes) };
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
    for (let i = 0; i < actual.layers.length; i++) {
        assert.deepEqual(
            [actual.layers[i].name, actual.layers[i].visible],
            [expected.layers[i].name, expected.layers[i].visible],
        );
        assert.deepEqual(actual.layers[i].pixels, expected.layers[i].pixels);
    }
}
function literal(rows) {
    return Uint8ClampedArray.from(
        rows.flatMap((row) =>
            [...row].flatMap((label) => (colors[label][3] === 0 ? [0, 0, 0, 0] : colors[label])),
        ),
    );
}
async function verifyCopy(page, name, rows) {
    const copy = await copied(page, name),
        expected = literal(rows);
    assert.deepEqual([copy.input.width, copy.input.height], [rows[0].length, rows.length]);
    assert.deepEqual(
        Uint8ClampedArray.from(copy.input.pixels),
        expected,
        'Pending raw RGBA follows literal matrix',
    );
    assert.deepEqual([copy.image.width, copy.image.height], [rows[0].length, rows.length]);
    assert.deepEqual(copy.image.pixels, expected, 'Independent PNG pixels follow literal matrix');
    return copy;
}
async function pasteMove(page, position) {
    const n = await page.evaluate(() => window.pasteTransform.reads);
    await menu(page, '붙여넣기');
    await page.waitForFunction(
        (n) =>
            window.pasteTransform.reads === n + 1 &&
            !document.querySelector('.busy') &&
            document.querySelector('[data-tool=select]').getAttribute('aria-pressed') === 'true',
        n,
    );
    await page.locator('.workspace canvas').focus();
    for (let i = 0; i < -position[0]; i++) await page.keyboard.press('ArrowLeft');
    for (let i = 0; i < -position[1]; i++) await page.keyboard.press('ArrowUp');
}
async function transform(page, step) {
    const n = await page.evaluate(
        () => window.__myPaintPersistenceTest.codecJobs.filter((job) => job.operation === 'geometry').length,
    );
    if (step.kind === 'resize') {
        await menu(page, '선택 크기');
        await page.getByLabel('너비', { exact: true }).fill(String(step.rows[0].length));
        await page.getByLabel('높이', { exact: true }).fill(String(step.rows.length));
        await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
    } else await menu(page, step.kind === 'rotate' ? '오른쪽 회전' : '좌우 반전');
    await page.waitForFunction(
        (n) =>
            window.__myPaintPersistenceTest.codecJobs.filter((job) => job.operation === 'geometry').length ===
                n + 1 &&
            window.__myPaintPersistenceTest.liveWorkers.size === 0 &&
            !document.querySelector('.busy'),
        n,
    );
}
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
results.browser = browser.version();
try {
    for (const spec of specifications) {
        const context = await browser.newContext({
                viewport: { width: 1400, height: 1000 },
                deviceScaleFactor: 1,
            }),
            page = await context.newPage(),
            record = { name: spec.name, position: spec.position, action: spec.action, steps: [] };
        results.cases.push(record);
        page.setDefaultTimeout(25000);
        page.on('pageerror', (error) => results.errors.push(error.message));
        page.on('request', (request) => {
            if (/\.js(?:[?#]|$)/.test(request.url()) && !results.assets.includes(request.url()))
                results.assets.push(request.url());
        });
        try {
            const state = createState(32, 24, [0, 0, 0, 0], desktopLimits);
            state.layers[0].name = 'base';
            state.layers.push(
                { name: 'hidden active', visible: false, pixels: new Uint8ClampedArray(32 * 24 * 4) },
                { name: 'other upper', visible: true, pixels: new Uint8ClampedArray(32 * 24 * 4) },
            );
            state.active = 1;
            for (let y = 0; y < 24; y++)
                for (let x = 0; x < 32; x++) {
                    const at = (y * 32 + x) * 4;
                    state.layers[0].pixels.set([13 + x, 31 + y, 77, 255], at);
                    state.layers[1].pixels.set([121 + x, 51 + y, 193, [0, 1, 128, 255][(x + 3 * y) % 4]], at);
                    state.layers[2].pixels.set([11 + x, 17 + y, 91, (x + y) % 3 ? 64 : 0], at);
                }
            const input = encodeProject(state, desktopLimits);
            await fs.writeFile(path.join(out, spec.name + '-source.rpaint'), input);
            record.sourceSha256 = hash(input);
            const width = spec.initial[0].length,
                height = spec.initial.length,
                pixels = Uint8ClampedArray.from(
                    spec.initial.flatMap((row) => [...row].flatMap((label) => colors[label])),
                ),
                raw = Buffer.alloc(height * (width * 4 + 1)),
                header = Buffer.alloc(13);
            for (let y = 0; y < height; y++)
                Buffer.from(pixels.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
            header.writeUInt32BE(width);
            header.writeUInt32BE(height, 4);
            header[8] = 8;
            header[9] = 6;
            const chunks = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])];
            for (const [name, data] of [
                ['IHDR', header],
                ['IDAT', deflateSync(raw)],
                ['IEND', Buffer.alloc(0)],
            ]) {
                const chunk = Buffer.alloc(data.length + 12);
                chunk.writeUInt32BE(data.length);
                chunk.write(name, 4);
                data.copy(chunk, 8);
                chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
                chunks.push(chunk);
            }
            const png = Buffer.concat(chunks);
            assert.deepEqual(readPng(png).pixels, pixels);
            await fs.writeFile(path.join(out, spec.name + '-incoming.png'), png);
            record.incomingPngSha256 = hash(png);
            record.incomingRgbaSha256 = hash(pixels);
            record.compositedPasteRgbaSha256 = hash(literal(spec.initial));
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
                    window.__myPaintPersistenceTest.queueOpen('paste-owner.rpaint', Uint8Array.from(bytes)),
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
                origin = { x: box.x + box.width / 2 - 16, y: box.y + box.height / 2 - 12 };
            await page.getByRole('button', { name: '연필', exact: true }).click();
            await page.mouse.click(origin.x + 28.5, origin.y + 20.5);
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await controls(page), { dirty: false, undo: false, redo: true });
            await page.evaluate(
                (bytes) =>
                    (window.pasteTransform.paste = new Blob([Uint8Array.from(bytes)], { type: 'image/png' })),
                [...png],
            );
            await pasteMove(page, spec.position);
            let previousRows = spec.initial;
            await verifyCopy(page, spec.name + '-initial-paste', previousRows);
            for (const [index, step] of spec.steps.entries()) {
                if (step.kind === 'resize') {
                    const xMap = nearest[previousRows[0].length - 1][step.rows[0].length - 1]
                            .split(',')
                            .map(Number),
                        yMap = nearest[previousRows.length - 1][step.rows.length - 1].split(',').map(Number);
                    assert.deepEqual(
                        yMap.map((y) => xMap.map((x) => previousRows[y][x]).join('')),
                        step.rows,
                        'Literal resize matrix matches actual Qt axis fixture',
                    );
                }
                if (spec.fault && index === 0) {
                    await page.evaluate(() => (window.pasteTransform.profileFault = true));
                    await transform(page, step);
                    await page.waitForFunction(() =>
                        document.querySelector('.status').textContent.includes('일치'),
                    );
                    assert.deepEqual(await controls(page), { dirty: false, undo: true, redo: false });
                    await verifyCopy(page, spec.name + '-failed-geometry', previousRows);
                    record.profileFailurePreservedPending = true;
                }
                await transform(page, step);
                const value = await verifyCopy(page, spec.name + '-step-' + index, step.rows);
                record.steps.push({
                    kind: step.kind,
                    rows: step.rows,
                    rawSha256: hash(Uint8Array.from(value.input.pixels)),
                    pngSha256: value.pngSha256,
                    exact: true,
                });
                previousRows = step.rows;
            }
            const beforeCancel = await page.evaluate(() => ({
                picks: window.__myPaintPersistenceTest.pickerCount,
                writes: window.__myPaintPersistenceTest.writes.length,
            }));
            await page.evaluate(() => window.__myPaintPersistenceTest.savePicks.push(null));
            await menu(page, '프로젝트 다른 이름 저장');
            await page.waitForFunction(
                (n) =>
                    window.__myPaintPersistenceTest.pickerCount === n + 1 && !document.querySelector('.busy'),
                beforeCancel.picks,
            );
            assert.equal(
                await page.evaluate(() => window.__myPaintPersistenceTest.writes.length),
                beforeCancel.writes,
            );
            await verifyCopy(page, spec.name + '-after-save-cancel', previousRows);
            assert.deepEqual(await controls(page), { dirty: false, undo: true, redo: false });
            record.saveAsCanceledPendingExact = true;
            await page.locator('.workspace canvas').focus();
            await page.keyboard.press('Escape');
            exact(await saved(page, spec.name + '-escaped-source'), state);
            assert.deepEqual(await controls(page), { dirty: false, undo: false, redo: true });
            await page.getByRole('button', { name: '다시 실행', exact: true }).click();
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            record.originalAndOldRedoPreserved = true;
            await pasteMove(page, spec.position);
            for (const step of spec.steps) await transform(page, step);
            const finalRows = spec.steps.at(-1).rows,
                expected = cloneState(state);
            if (spec.action === 'cut') {
                const n = await page.evaluate(() => window.pasteTransform.writes.length);
                await menu(page, '잘라내기');
                await page.waitForFunction(
                    (n) => window.pasteTransform.writes.length === n + 1 && !document.querySelector('.busy'),
                    n,
                );
                assert.deepEqual(
                    await controls(page),
                    { dirty: false, undo: false, redo: true },
                    'Source-less cut must retain clean authority and original Redo',
                );
                exact(await saved(page, spec.name + '-cut-noop'), state);
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                exact(await saved(page, spec.name + '-undo-original-redo'), state);
                record.cutWasSourceLessNoOp = true;
            } else {
                expected.layers[1].visible = true;
                const ink = literal(finalRows),
                    destination = expected.layers[1].pixels;
                for (let y = 0; y < finalRows.length; y++)
                    for (let x = 0; x < finalRows[0].length; x++) {
                        const tx = x + spec.position[0],
                            ty = y + spec.position[1];
                        if (tx < 0 || ty < 0 || tx >= 32 || ty >= 24) continue;
                        const i = (ty * 32 + tx) * 4,
                            j = (y * finalRows[0].length + x) * 4,
                            a = ink[j + 3] / 255;
                        if (!a) continue;
                        const b = destination[i + 3] / 255,
                            alpha = a + b * (1 - a);
                        for (let channel = 0; channel < 3; channel++)
                            destination[i + channel] = Math.round(
                                (ink[j + channel] * a + destination[i + channel] * b * (1 - a)) / alpha,
                            );
                        destination[i + 3] = Math.round(alpha * 255);
                    }
                await page.locator('.workspace canvas').focus();
                await page.keyboard.press('Enter');
                exact(await saved(page, spec.name + '-settled'), expected);
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                exact(await saved(page, spec.name + '-undo'), state);
                assert(!(await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled()));
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                exact(await saved(page, spec.name + '-redo'), expected);
                record.oneUndoRedoExact = true;
            }
            record.resources = await page.evaluate(() => ({
                workers: window.__myPaintPersistenceTest.liveWorkers.size,
                busy: !!document.querySelector('.busy'),
                inert: [...document.querySelectorAll('.topbar,.tools,.inspector')].map((node) => node.inert),
                injected: window.pasteTransform.injected,
            }));
            assert.deepEqual(record.resources, {
                workers: 0,
                busy: false,
                inert: [false, false, false],
                injected: spec.fault ? 1 : 0,
            });
            record.ok = true;
            results.checks.push(spec.name);
        } catch (error) {
            record.error = String(error.stack || error);
            results.failures.push({ name: spec.name, error: record.error });
        } finally {
            await context.close();
        }
    }
} finally {
    await browser.close();
    results.ok =
        results.checks.length === specifications.length && !results.failures.length && !results.errors.length;
    await fs.writeFile(output, JSON.stringify(results, null, 2) + '\n');
    console.log(
        JSON.stringify({ output, ok: results.ok, checks: results.checks, failures: results.failures }),
    );
    if (!results.ok) process.exitCode = 1;
}
