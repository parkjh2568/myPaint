import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync, crc32 } from 'node:zlib';
import { createState, cloneState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output =
    process.env.PAINT_CLIPBOARD_OUTPUT || '../build-web-work/task-planning/clipboard-contract/results.json';
await fs.mkdir(path.dirname(output), { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const nearestQt = JSON.parse(
    await fs.readFile(new URL('./fixtures/nearest-qt.json', import.meta.url), 'utf8'),
);
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const results = {
    checks: [],
    payloads: [],
    fixtures: [],
    assets: [],
    errors: [],
    failures: [],
    browser: browser.version(),
    url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
    testSha256: hash(await fs.readFile(new URL(import.meta.url))),
    scope: 'Public Chromium UI with the actual ClipboardItem PNG Blob and application codec/geometry Workers; clipboard read/write and native file dialogs are modeled. PNG payload is decoded independently using Node zlib, not production decodePng/Canvas; this does not verify OS clipboard permission or mobile hardware.',
};
const assetRequests = [],
    seenAssets = new Set();
// Independent reader for the application's PNG8 RGBA output, including all five standard filters.
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
function instrumentClipboard() {
    const state = { writes: [], reads: 0, paste: undefined };
    window.__clipboardContractTest = state;
    Object.defineProperties(navigator.clipboard, {
        write: {
            configurable: true,
            value: async (items) => {
                if (items.length !== 1 || items[0].types.length !== 1 || items[0].types[0] !== 'image/png')
                    throw Error('Expected one actual PNG ClipboardItem');
                state.writes.push(await items[0].getType('image/png'));
            },
        },
        read: {
            configurable: true,
            value: async () => {
                state.reads++;
                if (!state.paste) throw Error('Clipboard fixture missing');
                return [new ClipboardItem({ 'image/png': state.paste })];
            },
        },
    });
}
async function boot(state) {
    const context = await browser.newContext({
            viewport: { width: 1400, height: 1000 },
            deviceScaleFactor: 1,
        }),
        page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', (error) => results.errors.push(error.message));
    page.on('response', (response) => {
        if (!/\.js(?:\?|$)/.test(response.url()) || seenAssets.has(response.url())) return;
        seenAssets.add(response.url());
        assetRequests.push(
            response.body().then((body) => results.assets.push({ url: response.url(), sha256: hash(body) })),
        );
    });
    await page.addInitScript({
        content: `(${installNativeHarness.toString()})({});(${instrumentClipboard.toString()})();`,
    });
    await page.goto(results.url);
    await page.waitForSelector('canvas[data-ready=true]');
    await page.waitForFunction(
        () => window.__myPaintPersistenceTest.generation === 1 && !document.querySelector('dialog[open]'),
    );
    const encoded = encodeProject(state, desktopLimits);
    await page.evaluate(
        (bytes) => window.__myPaintPersistenceTest.queueOpen('fixture.rpaint', Uint8Array.from(bytes)),
        Array.from(encoded),
    );
    await page.getByRole('button', { name: '파일 열기', exact: true }).click();
    await page.waitForFunction(
        () => window.__myPaintPersistenceTest.generation === 2 && !document.querySelector('.busy'),
    );
    return { context, page };
}
async function menu(page, name) {
    await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
}
async function select(page, state, x, y, width, height) {
    await page.getByRole('button', { name: '사각 선택', exact: true }).click();
    await page.getByRole('button', { name: '화면에 맞추기', exact: true }).click();
    const box = await page.locator('.workspace canvas').boundingBox(),
        left = box.x + box.width / 2 - state.width / 2,
        top = box.y + box.height / 2 - state.height / 2;
    await page.mouse.move(left + x, top + y);
    await page.mouse.down();
    await page.mouse.move(left + x + width, top + y + height);
    await page.mouse.up();
}
async function copied(page, cut = false) {
    const count = await page.evaluate(() => window.__clipboardContractTest.writes.length);
    await menu(page, cut ? '잘라내기' : '복사');
    await page.waitForFunction(
        (count) =>
            window.__clipboardContractTest.writes.length === count + 1 && !document.querySelector('.busy'),
        count,
    );
    const payload = await page.evaluate(async () => {
        const blob = window.__clipboardContractTest.writes.at(-1);
        return { type: blob.type, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
    });
    assert.equal(payload.type, 'image/png');
    const bytes = Uint8Array.from(payload.bytes);
    return { bytes, image: readPng(bytes) };
}
async function snapshot(page) {
    const count = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.waitForFunction(
        (count) => window.__myPaintPersistenceTest.writes.length > count && !document.querySelector('.busy'),
        count,
    );
    return decodeProject(
        Uint8Array.from(
            await page.evaluate(() => Array.from(window.__myPaintPersistenceTest.writes.at(-1).bytes)),
        ),
        desktopLimits,
    );
}
const pattern = createState(64, 48, [0, 0, 0, 0], desktopLimits);
for (let y = 0; y < 48; y++)
    for (let x = 0; x < 64; x++)
        pattern.layers[0].pixels.set(
            [
                (x * 7 + y * 13) % 256,
                (x * 11 + y * 5) % 256,
                (x * 3 + y * 17) % 256,
                [64, 128, 192, 255][(x + 2 * y) % 4],
            ],
            (y * 64 + x) * 4,
        );
const layered = createState(32, 24, [255, 255, 255, 255], desktopLimits);
layered.layers[0].name = '아래';
layered.layers.push(
    { name: '반투명 활성', visible: true, pixels: new Uint8ClampedArray(32 * 24 * 4) },
    { name: '숨긴 상단', visible: false, pixels: new Uint8ClampedArray(32 * 24 * 4) },
);
layered.active = 1;
for (let p = 0; p < 32 * 24; p++) {
    layered.layers[0].pixels.set([20, 40, 60, 128], p * 4);
    layered.layers[1].pixels.set(p % 2 ? [40, 200, 220, 96] : [200, 100, 20, 96], p * 4);
    layered.layers[2].pixels.set([0, 255, 0, 255], p * 4);
}
const small = createState(16, 16, [13, 29, 47, 255], desktopLimits);
for (const [name, state] of [
    ['pattern', pattern],
    ['layered', layered],
    ['small', small],
])
    results.fixtures.push({
        name,
        width: state.width,
        height: state.height,
        active: state.active,
        layers: state.layers.map((layer) => ({
            name: layer.name,
            visible: layer.visible,
            rgbaSha256: hash(layer.pixels),
        })),
    });
const cases = [
    [
        'Resized pending selection copies 30x25 exact nearest-neighbor RGBA without committing the document',
        pattern,
        async (page) => {
            await select(page, pattern, 8, 6, 20, 20);
            await menu(page, '선택 크기');
            await page.getByLabel('너비', { exact: true }).fill('30');
            await page.getByLabel('높이', { exact: true }).fill('25');
            await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
            const payload = await copied(page),
                expected = new Uint8ClampedArray(30 * 25 * 4);
            const xIndices = nearestQt.mapsBySource[19][29].split(',').map(Number),
                yIndices = nearestQt.mapsBySource[19][24].split(',').map(Number);
            for (let y = 0; y < 25; y++)
                for (let x = 0; x < 30; x++) {
                    const sx = 8 + xIndices[x],
                        sy = 6 + yIndices[y];
                    expected.set(
                        pattern.layers[0].pixels.subarray((sy * 64 + sx) * 4, (sy * 64 + sx + 1) * 4),
                        (y * 30 + x) * 4,
                    );
                }
            results.payloads.push({
                name: 'resized-selection',
                width: payload.image.width,
                height: payload.image.height,
                pngSha256: hash(payload.bytes),
                rgbaSha256: hash(payload.image.pixels),
                expectedRgbaSha256: hash(expected),
            });
            assert.equal(payload.image.width, 30);
            assert.equal(payload.image.height, 25);
            assert.deepEqual(payload.image.pixels, expected);
            await page.locator('.workspace canvas').focus();
            await page.keyboard.press('Escape');
            assert.deepEqual(await snapshot(page), pattern);
            assert.equal(
                await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
                false,
            );
        },
    ],
    [
        'Rotated pending selection copies swapped 14x20 dimensions and exact clockwise RGBA without committing',
        pattern,
        async (page) => {
            await select(page, pattern, 6, 5, 20, 14);
            await menu(page, '오른쪽 회전');
            const payload = await copied(page),
                expected = new Uint8ClampedArray(14 * 20 * 4);
            for (let y = 0; y < 14; y++)
                for (let x = 0; x < 20; x++)
                    expected.set(
                        pattern.layers[0].pixels.subarray(
                            ((y + 5) * 64 + x + 6) * 4,
                            ((y + 5) * 64 + x + 7) * 4,
                        ),
                        (x * 14 + 13 - y) * 4,
                    );
            results.payloads.push({
                name: 'rotated-selection',
                width: payload.image.width,
                height: payload.image.height,
                pngSha256: hash(payload.bytes),
                rgbaSha256: hash(payload.image.pixels),
                expectedRgbaSha256: hash(expected),
            });
            assert.equal(payload.image.width, 14);
            assert.equal(payload.image.height, 20);
            assert.deepEqual(payload.image.pixels, expected);
            await page.locator('.workspace canvas').focus();
            await page.keyboard.press('Escape');
            assert.deepEqual(await snapshot(page), pattern);
            assert.equal(
                await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
                false,
            );
        },
    ],
    [
        'No-selection copy composites visible alpha layers, while cut copies only the active layer and clears it atomically',
        layered,
        async (page) => {
            const copy = await copied(page),
                expected = new Uint8ClampedArray(32 * 24 * 4);
            // Independent source-over vectors: alpha=round((96/255+128/255*(1-96/255))*255)=176.
            for (let p = 0; p < 32 * 24; p++)
                expected.set(p % 2 ? [31, 127, 147, 176] : [118, 73, 38, 176], p * 4);
            assert.equal(copy.image.width, 32);
            assert.equal(copy.image.height, 24);
            assert.deepEqual(copy.image.pixels, expected);
            assert.deepEqual(await snapshot(page), layered);
            const cut = await copied(page, true);
            assert.equal(cut.image.width, 32);
            assert.equal(cut.image.height, 24);
            assert.deepEqual(cut.image.pixels, layered.layers[1].pixels);
            results.payloads.push(
                {
                    name: 'visible-composite-copy',
                    width: 32,
                    height: 24,
                    pngSha256: hash(copy.bytes),
                    rgbaSha256: hash(copy.image.pixels),
                    expectedRgbaSha256: hash(expected),
                },
                {
                    name: 'active-layer-cut',
                    width: 32,
                    height: 24,
                    pngSha256: hash(cut.bytes),
                    rgbaSha256: hash(cut.image.pixels),
                    expectedRgbaSha256: hash(layered.layers[1].pixels),
                },
            );
            const cleared = cloneState(layered);
            cleared.layers[1].pixels.fill(0);
            assert.deepEqual(await snapshot(page), cleared);
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await snapshot(page), layered);
            await page.getByRole('button', { name: '다시 실행', exact: true }).click();
            assert.deepEqual(await snapshot(page), cleared);
        },
    ],
    [
        'Pasted selection outside the document crops its full 45x35 payload, with one Undo to 16x16 and exact Redo',
        small,
        async (page) => {
            const width = 45,
                height = 35,
                pixels = new Uint8ClampedArray(width * height * 4),
                raw = Buffer.alloc(height * (width * 4 + 1)),
                header = Buffer.alloc(13);
            for (let y = 0; y < height; y++)
                for (let x = 0; x < width; x++)
                    pixels.set(
                        [(x * 13 + y * 3) % 256, (x * 5 + y * 11) % 256, (x * 17 + y * 7) % 256, 255],
                        (y * width + x) * 4,
                    );
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
            const bytes = Buffer.concat(chunks);
            assert.deepEqual(readPng(bytes).pixels, pixels);
            results.fixtures.push({
                name: 'independent-paste-png',
                width,
                height,
                pngSha256: hash(bytes),
                rgbaSha256: hash(pixels),
            });
            await page.evaluate(
                (bytes) =>
                    (window.__clipboardContractTest.paste = new Blob([Uint8Array.from(bytes)], {
                        type: 'image/png',
                    })),
                Array.from(bytes),
            );
            await menu(page, '붙여넣기');
            await page.waitForFunction(
                () =>
                    document.querySelector('[data-tool=select]')?.getAttribute('aria-pressed') === 'true' &&
                    !document.querySelector('.busy'),
            );
            const box = await page.locator('.workspace canvas').boundingBox(),
                left = box.x + box.width / 2 - 8,
                top = box.y + box.height / 2 - 8;
            await page.mouse.move(left + 10, top + 10);
            await page.mouse.down();
            await page.mouse.move(left + 18, top + 16);
            await page.mouse.up();
            assert.equal(await page.locator('.document-info').textContent(), '16 × 16 px');
            const exportCount = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
            await page.getByRole('button', { name: '이미지 내보내기', exact: true }).click();
            await page.getByLabel('형식', { exact: true }).selectOption('png');
            await page.getByRole('dialog').getByRole('button', { name: '내보내기', exact: true }).click();
            await page.waitForFunction(
                (count) =>
                    window.__myPaintPersistenceTest.writes.length > count && !document.querySelector('.busy'),
                exportCount,
            );
            const previewBytes = Uint8Array.from(
                    await page.evaluate(() =>
                        Array.from(window.__myPaintPersistenceTest.writes.at(-1).bytes),
                    ),
                ),
                preview = readPng(previewBytes),
                previewExpected = new Uint8ClampedArray(53 * 41 * 4);
            for (let y = 0; y < 41; y++)
                for (let x = 0; x < 53; x++)
                    previewExpected.set(
                        x >= 8 && y >= 6
                            ? pixels.subarray(((y - 6) * 45 + x - 8) * 4, ((y - 6) * 45 + x - 7) * 4)
                            : small.background,
                        (y * 53 + x) * 4,
                    );
            assert.equal(preview.width, 53);
            assert.equal(preview.height, 41);
            assert.deepEqual(preview.pixels, previewExpected);
            assert.equal(
                await page.locator('.document-info').textContent(),
                '16 × 16 px',
                'Image export must keep the expanded paste pending',
            );
            results.payloads.push({
                name: 'pending-paste-expanded-preview',
                width: 53,
                height: 41,
                pngSha256: hash(previewBytes),
                rgbaSha256: hash(preview.pixels),
                expectedRgbaSha256: hash(previewExpected),
            });
            await menu(page, '선택 자르기');
            await page.waitForFunction(
                () =>
                    document.querySelector('.document-info')?.textContent.includes('45 × 35') &&
                    !document.querySelector('.busy'),
            );
            const cropped = await snapshot(page),
                expected = cloneState(small);
            expected.width = width;
            expected.height = height;
            expected.layers[0].pixels = pixels;
            assert.deepEqual(cropped, expected);
            assert.equal(await page.evaluate(() => window.__clipboardContractTest.reads), 1);
            results.payloads.push({
                name: 'expanded-paste-crop',
                width: cropped.width,
                height: cropped.height,
                rgbaSha256: hash(cropped.layers[0].pixels),
                expectedRgbaSha256: hash(pixels),
            });
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await snapshot(page), small);
            assert.equal(
                await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
                false,
            );
            await page.getByRole('button', { name: '다시 실행', exact: true }).click();
            assert.deepEqual(await snapshot(page), expected);
        },
    ],
];
try {
    for (const [name, state, run] of cases) {
        const { context, page } = await boot(state);
        try {
            await run(page);
            results.checks.push(name);
            console.log('PASS ' + name);
        } catch (error) {
            results.failures.push({
                name,
                error: String(error.stack || error),
                status: await page.locator('.status').textContent(),
            });
            await page.screenshot({ path: path.join(path.dirname(output), 'failure.png') });
            throw error;
        } finally {
            await context.close();
        }
    }
    assert.deepEqual(results.errors, []);
} finally {
    await Promise.all(assetRequests);
    await fs.writeFile(output, JSON.stringify(results, null, 2) + '\n');
    await browser.close();
}
console.log(JSON.stringify(results, null, 2));
