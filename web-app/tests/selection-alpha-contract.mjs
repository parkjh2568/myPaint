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
        process.env.PAINT_SELECTION_ALPHA_OUTPUT ||
            '../build-web-work/task-planning/selection-alpha/result.json',
    ),
    out = path.dirname(output);
await fs.mkdir(out, { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const samples = [
    [255, 255, 255, 255],
    [255, 255, 255, 128],
    [255, 255, 255, 0],
    [193, 71, 117, 0],
    [255, 0, 0, 255],
    [240, 20, 80, 1],
    [250, 10, 100, 1],
    [100, 10, 100, 1],
];
const source = createState(8, 1, [0, 0, 0, 0], desktopLimits);
source.layers[0].pixels.set(samples.flat());
const bytes = encodeProject(source, desktopLimits);
const results = {
    url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
    checks: [],
    cases: [],
    errors: [],
    failures: [],
    assets: [],
    testSHA256: hash(await fs.readFile(new URL(import.meta.url))),
    fixture: { width: 8, height: 1, pixels: samples, projectSHA256: hash(bytes) },
    scope: 'Actual Chromium public picker/swap/select/copy/SaveAs-cancel/Escape/Undo/Redo and actual ClipboardItem PNG with codec Worker. Native IPC and clipboard transport are modeled. PNG pixels are independently decoded with Node zlib. Read-only public Worker.postMessage observation captures selection raw input. Key membership/alpha literal expectations come from actual Qt6.12 Canvas oracle; surviving straight RGBA and hidden RGB remain original rather than forced through Qt unpremultiplication. Alpha0 PNG normalizes to zero via flattening, separately from raw selection/original preservation. No physical clipboard, OS picker or hardware claim.',
};
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
    const probe = (window.__selectionAlphaTest = { writes: [], inputs: [] });
    Object.defineProperty(navigator.clipboard, 'write', {
        configurable: true,
        value: async (items) => {
            if (items.length !== 1 || items[0].types.length !== 1 || items[0].types[0] !== 'image/png')
                throw Error('Expected actual PNG ClipboardItem');
            probe.writes.push(await items[0].getType('image/png'));
        },
    });
    const Worker = window.Worker;
    window.Worker = class extends Worker {
        postMessage(message, transfer) {
            if (message?.operation === 'png-write')
                probe.inputs.push({
                    width: message.state.width,
                    height: message.state.height,
                    pixels: Array.from(message.state.layers[0].pixels),
                });
            return super.postMessage(message, transfer);
        }
    };
}
let browser;
const contexts = new Set();
async function menu(page, name) {
    await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
}
async function copied(page) {
    const count = await page.evaluate(() => window.__selectionAlphaTest.writes.length);
    await menu(page, '복사');
    await page.waitForFunction(
        (n) => window.__selectionAlphaTest.writes.length === n + 1 && !document.querySelector('.busy'),
        count,
    );
    const value = await page.evaluate(async () => ({
        bytes: Array.from(new Uint8Array(await window.__selectionAlphaTest.writes.at(-1).arrayBuffer())),
        input: window.__selectionAlphaTest.inputs.at(-1),
    }));
    const png = Uint8Array.from(value.bytes);
    return { png, image: readPng(png), input: value.input };
}
async function snapshot(page) {
    const count = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.waitForFunction(
        (n) => window.__myPaintPersistenceTest.writes.length > n && !document.querySelector('.busy'),
        count,
    );
    const value = await page.evaluate(() => Array.from(window.__myPaintPersistenceTest.writes.at(-1).bytes));
    return decodeProject(Uint8Array.from(value), desktopLimits);
}
async function controls(page) {
    return {
        dirty: (await page.title()).startsWith('* '),
        undo: await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
        redo: await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled(),
    };
}
async function selectAll(page) {
    await page.locator('.workspace canvas').focus();
    await page.keyboard.press('Control+a');
    assert.match(await page.locator('.title').textContent(), /편집 중/);
}
try {
    browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PAINT_BROWSER_PATH || undefined,
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    results.browser = browser.version();
    // Qt oracle literals separate alpha/key membership from premultiplied RGB rounding.
    for (const spec of [
        {
            name: 'opaque-white-key-keeps-white128',
            pick: 0,
            qtKey: [255, 255, 255, 255],
            alpha: [0, 128, 0, 0, 255, 1, 1, 1],
        },
        {
            name: 'white128-key-keeps-white255',
            pick: 1,
            qtKey: [255, 255, 255, 128],
            alpha: [255, 0, 0, 0, 255, 1, 1, 1],
        },
        {
            name: 'alpha0-key-preserves-original-hidden-rgb',
            pick: 3,
            qtKey: [193, 71, 117, 0],
            alpha: [255, 128, 0, 0, 255, 1, 1, 1],
        },
        {
            name: 'alpha1-key-matches-quantized-equal-not-different',
            pick: 5,
            qtKey: [240, 20, 80, 1],
            alpha: [255, 128, 0, 0, 255, 0, 0, 1],
        },
    ]) {
        const context = await browser.newContext({
            viewport: { width: 1400, height: 1000 },
            deviceScaleFactor: 1,
        });
        contexts.add(context);
        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        page.on('pageerror', (e) => results.errors.push({ name: spec.name, message: e.message }));
        page.on('request', (r) => {
            if (/\.js(?:$|\?)/.test(r.url()) && !results.assets.includes(r.url()))
                results.assets.push(r.url());
        });
        await page.addInitScript(installNativeHarness, {});
        await page.addInitScript(instrument);
        await page.goto(results.url);
        await page.waitForFunction(
            () =>
                window.__myPaintPersistenceTest?.generation === 1 && !document.querySelector('dialog[open]'),
        );
        const inputId = await page.evaluate(
            (value) =>
                window.__myPaintPersistenceTest.queueOpen('selection-alpha.rpaint', Uint8Array.from(value)),
            Array.from(bytes),
        );
        await page.getByRole('button', { name: '파일 열기', exact: true }).click();
        await page.waitForFunction(
            () => window.__myPaintPersistenceTest.generation === 2 && !document.querySelector('.busy'),
        );
        await page.waitForSelector('canvas[data-ready=true]');
        const box = await page.locator('.workspace canvas').boundingBox(),
            left = box.x + box.width / 2 - 4,
            top = box.y + box.height / 2 - 0.5;
        await page.getByRole('button', { name: '연필', exact: true }).click();
        await page.mouse.click(left + 7.5, top + 0.5);
        assert.equal(await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(), true);
        await page.getByRole('button', { name: '실행 취소', exact: true }).click();
        assert.deepEqual(await controls(page), { dirty: false, undo: false, redo: true });
        await page.getByRole('button', { name: '스포이트', exact: true }).click();
        await page.mouse.click(left + spec.pick + 0.5, top + 0.5);
        await page.getByRole('button', { name: '전경색 보조색 바꾸기', exact: true }).click();
        await page.getByRole('button', { name: '사각 선택', exact: true }).click();
        await page.locator('#transparent-selection').check();
        await selectAll(page);
        const first = await copied(page);
        const beforeCancel = await page.evaluate(() => ({
            writes: window.__myPaintPersistenceTest.writes.length,
            pickers: window.__myPaintPersistenceTest.pickerCount,
        }));
        await page.evaluate(() => window.__myPaintPersistenceTest.savePicks.push(null));
        await page.locator('.workspace canvas').focus();
        await page.keyboard.press('Control+Shift+s');
        await page.waitForFunction(
            (n) => window.__myPaintPersistenceTest.pickerCount === n + 1 && !document.querySelector('.busy'),
            beforeCancel.pickers,
        );
        assert.equal(
            await page.evaluate(() => window.__myPaintPersistenceTest.writes.length),
            beforeCancel.writes,
        );
        assert.match(await page.locator('.title').textContent(), /편집 중/);
        const second = await copied(page);
        assert.deepEqual(second.png, first.png, 'SaveAs cancellation must preserve the pending payload');
        assert.deepEqual(second.input, first.input);
        await page.keyboard.press('Escape');
        assert.deepEqual(await controls(page), { dirty: false, undo: false, redo: true });
        assert.deepEqual(
            await snapshot(page),
            source,
            'Cancellation must preserve every original straight RGBA byte',
        );
        const fileBytes = await page.evaluate(
            (id) => Array.from(window.__myPaintPersistenceTest.files.get(id).bytes),
            inputId,
        );
        assert.equal(hash(Uint8Array.from(fileBytes)), hash(bytes));
        await selectAll(page);
        const retry = await copied(page);
        assert.deepEqual(retry.png, first.png);
        assert.deepEqual(retry.input, first.input);
        await page.keyboard.press('Escape');
        assert.deepEqual(await controls(page), { dirty: false, undo: false, redo: true });
        await page.getByRole('button', { name: '다시 실행', exact: true }).click();
        const seeded = cloneState(source);
        seeded.layers[0].pixels.set([22, 121, 234, 255], 7 * 4);
        assert.deepEqual(await snapshot(page), seeded, 'The old Redo must still be usable');
        await page.getByRole('button', { name: '실행 취소', exact: true }).click();
        assert.deepEqual(await snapshot(page), source);
        const expectedRaw = samples.map((rgba, i) => [...rgba.slice(0, 3), spec.alpha[i]]).flat();
        const expectedPNG = samples
            .map((rgba, i) => (spec.alpha[i] ? [...rgba.slice(0, 3), spec.alpha[i]] : [0, 0, 0, 0]))
            .flat();
        assert.equal(first.image.width, 8);
        assert.equal(first.image.height, 1);
        assert.equal(first.input.width, 8);
        assert.equal(first.input.height, 1);
        const rawMatches = JSON.stringify(first.input.pixels) === JSON.stringify(expectedRaw),
            pngMatches = JSON.stringify(Array.from(first.image.pixels)) === JSON.stringify(expectedPNG);
        const record = {
            name: spec.name,
            qtKey: spec.qtKey,
            actualRaw: first.input.pixels,
            expectedRaw,
            actualPNG: Array.from(first.image.pixels),
            expectedPNG,
            rawMatches,
            pngMatches,
            pngSHA256: hash(first.png),
            sourceExact: true,
            saveCancelPreserved: true,
            cancelRetryExact: true,
            redoUsable: true,
        };
        results.cases.push(record);
        if (rawMatches && pngMatches) results.checks.push(spec.name);
        else
            results.failures.push({
                name: spec.name,
                kind: 'Key/alpha payload differs from actual Qt membership with original straight-RGBA preservation',
                actualAlpha: first.input.pixels.filter((_, i) => i % 4 === 3),
                expectedAlpha: spec.alpha,
            });
        await fs.writeFile(path.join(out, 'partial.json'), JSON.stringify(results, null, 2) + '\n');
        await context.close();
        contexts.delete(context);
    }
    assert.deepEqual(results.errors, []);
    if (results.failures.length) process.exitCode = 1;
} catch (error) {
    results.failures.push({ unexpected: String(error.stack || error) });
    console.error(error);
    process.exitCode = 1;
    for (const context of contexts)
        for (const page of context.pages()) {
            try {
                await page.screenshot({ path: path.join(out, 'failure.png') });
                results.failureStatus = await page.locator('.status').textContent();
            } catch (error) {
                results.failureCaptureError = String(error);
            }
        }
} finally {
    for (const context of contexts) await context.close().catch(() => {});
    if (browser) await browser.close();
    results.ok = !results.errors.length && !results.failures.length && results.checks.length === 4;
    await fs.writeFile(output, JSON.stringify(results, null, 2) + '\n');
    console.log(
        JSON.stringify({
            output,
            ok: results.ok,
            checks: results.checks,
            failures: results.failures,
            errors: results.errors,
        }),
    );
}
