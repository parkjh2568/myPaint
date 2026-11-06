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
        process.env.PAINT_CUT_KEY_OUTPUT || '../build-web-work/task-planning/fill-cut-key/results.json',
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
const keyFixture = createState(8, 1, [0, 0, 0, 0], desktopLimits);
keyFixture.layers[0].pixels.set(samples.flat());
const source = createState(8, 1, [0, 0, 0, 0], desktopLimits);
source.layers[0].name = 'bottom';
for (let x = 0; x < 8; x++) source.layers[0].pixels.set([12, 34, 56, 255], x * 4);
source.layers.push(
    { name: 'active', visible: true, pixels: new Uint8ClampedArray(samples.flat()) },
    {
        name: 'hidden',
        visible: false,
        pixels: new Uint8ClampedArray(Array.from({ length: 8 }, () => [0, 255, 0, 255]).flat()),
    },
);
source.active = 1;
const compositeExpected = new Uint8ClampedArray(
    [
        [255, 255, 255, 255],
        [134, 145, 156, 255],
        [12, 34, 56, 255],
        [12, 34, 56, 255],
        [255, 0, 0, 255],
        [13, 34, 56, 255],
        [13, 34, 56, 255],
        [12, 34, 56, 255],
    ].flat(),
);
const results = {
    url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
    testSHA256: hash(await fs.readFile(new URL(import.meta.url))),
    checks: [],
    cases: [],
    errors: [],
    failures: [],
    assets: [],
    fixture: {
        width: 8,
        height: 1,
        active: 1,
        samples,
        compositeExpected: Array.from(compositeExpected),
        layers: source.layers.map((l) => ({ name: l.name, visible: l.visible, sha256: hash(l.pixels) })),
    },
    scope: 'Public Chromium picker/swap and no-selection copy/cut with actual ClipboardItem PNG/codec Worker, modeled native IPC/clipboard rejection. Independent PNG zlib reader and literal Qt key-alpha membership. Surviving straight RGBA/hidden RGB remain original in raw Worker input; alpha0 output PNG is flattened to zero separately. Three layers including a hidden-active control distinguish ordinary composite copy from active-layer cut. No OS clipboard permission, filesystem, physical device or performance claim.',
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
    const p = (window.__cutKeyTest = { attempts: [], inputs: [], failNext: false });
    Object.defineProperty(navigator.clipboard, 'write', {
        configurable: true,
        value: async (items) => {
            if (items.length !== 1 || items[0].types.length !== 1 || items[0].types[0] !== 'image/png')
                throw Error('Expected actual PNG ClipboardItem');
            const blob = await items[0].getType('image/png');
            p.attempts.push(blob);
            if (p.failNext) {
                p.failNext = false;
                throw Error('Injected cut clipboard rejection');
            }
        },
    });
    const Worker = window.Worker;
    window.Worker = class extends Worker {
        postMessage(message, transfer) {
            if (message?.operation === 'png-write')
                p.inputs.push({
                    width: message.state.width,
                    height: message.state.height,
                    active: message.state.active,
                    layers: message.state.layers.map((l) => ({
                        name: l.name,
                        visible: l.visible,
                        pixels: Array.from(l.pixels),
                    })),
                });
            return super.postMessage(message, transfer);
        }
    };
}
let browser;
const contexts = new Set();
async function open(page, state, name, generation) {
    await page.evaluate(
        ({ name, bytes }) => window.__myPaintPersistenceTest.queueOpen(name, Uint8Array.from(bytes)),
        { name, bytes: Array.from(encodeProject(state, desktopLimits)) },
    );
    await page.getByRole('button', { name: '파일 열기', exact: true }).click();
    await page.waitForFunction(
        (g) =>
            window.__myPaintPersistenceTest.generation === g &&
            !document.querySelector('.busy') &&
            document.querySelector('.workspace canvas').dataset.ready === 'true',
        generation,
    );
}
async function menu(page, name) {
    await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
}
async function copied(page, cut = false, reject = false) {
    const n = await page.evaluate((reject) => {
        window.__cutKeyTest.failNext = reject;
        return window.__cutKeyTest.attempts.length;
    }, reject);
    await menu(page, cut ? '잘라내기' : '복사');
    await page.waitForFunction(
        (n) => window.__cutKeyTest.attempts.length === n + 1 && !document.querySelector('.busy'),
        n,
    );
    const value = await page.evaluate(async () => ({
        bytes: Array.from(new Uint8Array(await window.__cutKeyTest.attempts.at(-1).arrayBuffer())),
        input: window.__cutKeyTest.inputs.at(-1),
    }));
    const bytes = Uint8Array.from(value.bytes);
    return { bytes, image: readPng(bytes), input: value.input };
}
async function snapshot(page) {
    const n = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.waitForFunction(
        (n) => window.__myPaintPersistenceTest.writes.length > n && !document.querySelector('.busy'),
        n,
    );
    return decodeProject(
        Uint8Array.from(
            await page.evaluate(() => Array.from(window.__myPaintPersistenceTest.writes.at(-1).bytes)),
        ),
        desktopLimits,
    );
}
async function controls(page) {
    return {
        dirty: (await page.title()).startsWith('* '),
        undo: await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
        redo: await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled(),
    };
}
try {
    browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PAINT_BROWSER_PATH || undefined,
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    results.browser = browser.version();
    for (const spec of [
        {
            name: 'cut-opaque-white-key-on',
            pick: 0,
            key: [255, 255, 255, 255],
            on: true,
            alpha: [0, 128, 0, 0, 255, 1, 1, 1],
        },
        {
            name: 'cut-white128-key-on',
            pick: 1,
            key: [255, 255, 255, 128],
            on: true,
            alpha: [255, 0, 0, 0, 255, 1, 1, 1],
        },
        {
            name: 'cut-alpha1-premul-equivalence-on',
            pick: 5,
            key: [240, 20, 80, 1],
            on: true,
            alpha: [255, 128, 0, 0, 255, 0, 0, 1],
        },
        {
            name: 'cut-key-off-preserves-original-payload',
            pick: 0,
            key: [255, 255, 255, 255],
            on: false,
            alpha: [255, 128, 0, 0, 255, 1, 1, 1],
        },
        {
            name: 'cut-hidden-active-off-keeps-payload-and-original-visibility',
            pick: 0,
            key: [255, 255, 255, 255],
            on: false,
            hidden: true,
            alpha: [255, 128, 0, 0, 255, 1, 1, 1],
        },
    ]) {
        const fixture = cloneState(source);
        if (spec.hidden) fixture.layers[1].visible = false;
        const expectedCopy = spec.hidden
            ? new Uint8ClampedArray(Array.from({ length: 8 }, () => [12, 34, 56, 255]).flat())
            : compositeExpected;
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
        await open(page, keyFixture, 'key.rpaint', 2);
        let box = await page.locator('.workspace canvas').boundingBox(),
            left = box.x + box.width / 2 - 4,
            top = box.y + box.height / 2 - 0.5;
        await page.getByRole('button', { name: '스포이트', exact: true }).click();
        await page.mouse.click(left + spec.pick + 0.5, top + 0.5);
        await page.getByRole('button', { name: '전경색 보조색 바꾸기', exact: true }).click();
        await open(page, fixture, 'layered.rpaint', 3);
        await page.getByLabel('HEX 색상', { exact: true }).fill('#1679ea');
        await page.getByLabel('HEX 색상', { exact: true }).press('Tab');
        await page.getByRole('button', { name: '연필', exact: true }).click();
        box = await page.locator('.workspace canvas').boundingBox();
        left = box.x + box.width / 2 - 4;
        top = box.y + box.height / 2 - 0.5;
        await page.mouse.click(left + 7.5, top + 0.5);
        await page.getByRole('button', { name: '실행 취소', exact: true }).click();
        assert.deepEqual(await controls(page), { dirty: false, undo: false, redo: true });
        await page.locator('#transparent-selection').setChecked(spec.on);
        const ordinary = await copied(page);
        assert.deepEqual(
            ordinary.image.pixels,
            expectedCopy,
            'Ordinary copy must remain visible-layer composite even with transparent selection ON',
        );
        assert.equal(ordinary.input.layers.length, 3);
        assert.deepEqual(
            ordinary.input.layers.map((l) => l.pixels),
            fixture.layers.map((l) => Array.from(l.pixels)),
        );
        assert.deepEqual(await controls(page), { dirty: false, undo: false, redo: true });
        const failed = await copied(page, true, true);
        assert.match(await page.locator('.status').textContent(), /Injected cut clipboard rejection/);
        assert.deepEqual(await controls(page), { dirty: false, undo: false, redo: true });
        assert.deepEqual(
            await snapshot(page),
            fixture,
            'Rejected clipboard cut must preserve all original bytes/metadata',
        );
        await page.getByRole('button', { name: '다시 실행', exact: true }).click();
        const seeded = cloneState(fixture);
        seeded.layers[1].visible = true;
        seeded.layers[1].pixels.set([22, 121, 234, 255], 7 * 4);
        assert.deepEqual(await snapshot(page), seeded);
        await page.getByRole('button', { name: '실행 취소', exact: true }).click();
        assert.deepEqual(await snapshot(page), fixture);
        assert.deepEqual(await controls(page), { dirty: false, undo: false, redo: true });
        const cut = await copied(page, true);
        assert.equal(cut.input.layers.length, 1);
        assert.equal(cut.input.active, 0);
        assert.deepEqual(
            cut.bytes,
            failed.bytes,
            'The real retry must use the same payload as the rejected attempt',
        );
        assert.deepEqual(await controls(page), { dirty: true, undo: true, redo: false });
        const cleared = cloneState(fixture);
        cleared.layers[1].pixels.fill(0);
        assert.deepEqual(await snapshot(page), cleared);
        await page.getByRole('button', { name: '실행 취소', exact: true }).click();
        assert.deepEqual(await snapshot(page), fixture);
        assert.equal(await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(), false);
        await page.getByRole('button', { name: '다시 실행', exact: true }).click();
        assert.deepEqual(await snapshot(page), cleared);
        const expectedRaw = samples.map((c, i) => [...c.slice(0, 3), spec.alpha[i]]).flat(),
            expectedPNG = samples
                .map((c, i) => (spec.alpha[i] ? [...c.slice(0, 3), spec.alpha[i]] : [0, 0, 0, 0]))
                .flat();
        assert.equal(cut.image.width, 8);
        assert.equal(cut.image.height, 1);
        const raw = cut.input.layers[0].pixels,
            png = Array.from(cut.image.pixels),
            matches =
                JSON.stringify(raw) === JSON.stringify(expectedRaw) &&
                JSON.stringify(png) === JSON.stringify(expectedPNG) &&
                cut.input.layers[0].visible === true;
        results.cases.push({
            name: spec.name,
            key: spec.key,
            hiddenActive: !!spec.hidden,
            cutInputVisible: cut.input.layers[0].visible,
            on: spec.on,
            actualRaw: raw,
            expectedRaw,
            actualPNG: png,
            expectedPNG,
            pngSHA256: hash(cut.bytes),
            matches,
            ordinaryCopyExact: true,
            clipboardFailureSourceAndRedoExact: true,
            retryExact: true,
            singleUndoRedoExact: true,
        });
        if (matches) results.checks.push(spec.name);
        else
            results.failures.push({
                name: spec.name,
                kind: 'No-selection cut payload differs from Qt key/visibility contract',
                actualPNGAlpha: png.filter((_, i) => i % 4 === 3),
                cutInputVisible: cut.input.layers[0].visible,
                actualAlpha: raw.filter((_, i) => i % 4 === 3),
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
        for (const page of context.pages())
            try {
                results.failureStatus = await page.locator('.status').textContent();
                await page.screenshot({ path: path.join(out, 'failure.png') });
            } catch (error) {
                results.captureError = String(error);
            }
} finally {
    for (const context of contexts) await context.close().catch(() => {});
    if (browser) await browser.close();
    results.ok = results.checks.length === 5 && !results.errors.length && !results.failures.length;
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
