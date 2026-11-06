import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import jpeg from 'jpeg-js';
import { decodeProject } from '../src/engine/format.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out =
    process.env.PAINT_JPEG_ORIENTATION_OUTPUT || '../build-web-work/task-planning/jpeg-orientation/portable';
await fs.mkdir(out + '/fixtures', { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const literalRows = [
    [8, 18, 28, 38, 48, 58],
    [68, 78, 88, 98, 108, 118],
    [128, 138, 148, 158, 168, 178],
    [188, 198, 208, 218, 228, 238],
];
const pixels = Buffer.from(literalRows.flat().flatMap((v) => [v, v, v, 255]));
const base = jpeg.encode({ width: 6, height: 4, data: pixels }, 100).data;
await fs.writeFile(out + '/fixtures/no-exif.jpg', base);
const rows = {
    1: [
        [0, 1, 2, 3, 4, 5],
        [6, 7, 8, 9, 10, 11],
        [12, 13, 14, 15, 16, 17],
        [18, 19, 20, 21, 22, 23],
    ],
    2: [
        [5, 4, 3, 2, 1, 0],
        [11, 10, 9, 8, 7, 6],
        [17, 16, 15, 14, 13, 12],
        [23, 22, 21, 20, 19, 18],
    ],
    3: [
        [23, 22, 21, 20, 19, 18],
        [17, 16, 15, 14, 13, 12],
        [11, 10, 9, 8, 7, 6],
        [5, 4, 3, 2, 1, 0],
    ],
    4: [
        [18, 19, 20, 21, 22, 23],
        [12, 13, 14, 15, 16, 17],
        [6, 7, 8, 9, 10, 11],
        [0, 1, 2, 3, 4, 5],
    ],
    5: [
        [0, 6, 12, 18],
        [1, 7, 13, 19],
        [2, 8, 14, 20],
        [3, 9, 15, 21],
        [4, 10, 16, 22],
        [5, 11, 17, 23],
    ],
    6: [
        [18, 12, 6, 0],
        [19, 13, 7, 1],
        [20, 14, 8, 2],
        [21, 15, 9, 3],
        [22, 16, 10, 4],
        [23, 17, 11, 5],
    ],
    7: [
        [23, 17, 11, 5],
        [22, 16, 10, 4],
        [21, 15, 9, 3],
        [20, 14, 8, 2],
        [19, 13, 7, 1],
        [18, 12, 6, 0],
    ],
    8: [
        [5, 11, 17, 23],
        [4, 10, 16, 22],
        [3, 9, 15, 21],
        [2, 8, 14, 20],
        [1, 7, 13, 19],
        [0, 6, 12, 18],
    ],
};
const manifest = {
    source: 'deterministic jpeg-js0.4.4 quality100, literal6x4 grayscale asymmetric input',
    literalRows,
    inputRawSha256: hash(pixels),
    base: { file: 'no-exif.jpg', sha256: hash(base), bytes: base.length, width: 6, height: 4 },
    expectedIndexRows: rows,
    cases: [],
    references: [
        {
            url: 'https://www.cipa.jp/std/documents/e/DC-008-2012_E_C.pdf',
            scope: 'Orientation tag 274 direction table',
        },
        {
            url: 'https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#dom-imagebitmapoptions-imageorientation',
            scope: 'WHATWG from-image image orientation behavior',
        },
    ],
};
// APP1 stores an Exif TIFF with one inline SHORT Orientation entry.
for (let orientation = 1; orientation <= 8; orientation++) {
    const payload = Buffer.alloc(32);
    payload.write('Exif\0\0', 0, 'binary');
    payload.write('II', 6);
    payload.writeUInt16LE(42, 8);
    payload.writeUInt32LE(8, 10);
    payload.writeUInt16LE(1, 14);
    payload.writeUInt16LE(0x0112, 16);
    payload.writeUInt16LE(3, 18);
    payload.writeUInt32LE(1, 20);
    payload.writeUInt16LE(orientation, 24);
    payload.writeUInt32LE(0, 28);
    const segment = Buffer.alloc(4);
    segment[0] = 0xff;
    segment[1] = 0xe1;
    segment.writeUInt16BE(payload.length + 2, 2);
    const bytes = Buffer.concat([base.subarray(0, 2), segment, payload, base.subarray(2)]),
        file = `orientation-${orientation}.jpg`;
    await fs.writeFile(out + '/fixtures/' + file, bytes);
    manifest.cases.push({
        orientation,
        file,
        bytes: bytes.length,
        sha256: hash(bytes),
        expectedWidth: rows[orientation][0].length,
        expectedHeight: rows[orientation].length,
        TIFF: 'little-endian, magic42, IFD0offset8, one entry, orientation SHORT count1 inline, nextIFD0',
    });
}
await fs.writeFile(out + '/fixture-manifest.json', JSON.stringify(manifest, null, 2) + '\n');

const result = {
    ok: false,
    scope: 'Actual public file chooser -> unchanged Studio readArtwork -> actual Chrome JPEG/Canvas -> project save; independent literal orientation index rows against no-EXIF decoded base',
    cases: [],
    errors: [],
    consoleErrors: [],
    requests: [],
    cleanup: {},
    references: manifest.references,
};
let browser,
    activePage,
    stage = 'setup';
try {
    result.provenance = {
        driverSha256: hash(await fs.readFile(new URL(import.meta.url))),
        fixtureManifestSha256: hash(await fs.readFile(out + '/fixture-manifest.json')),
        codecSha256: hash(await fs.readFile(new URL('../src/platform/codec.ts', import.meta.url))),
    };
    result.url = process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/';
    browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PAINT_BROWSER_PATH || undefined,
    });
    result.browser = browser.version();
    let basePixels;
    for (const sample of [
        { orientation: 0, file: 'no-exif.jpg', expectedWidth: 6, expectedHeight: 4 },
        ...manifest.cases,
        { ...manifest.cases[5], name: 'orientation6-HTMLCanvas-fallback', disableOffscreen: true },
        {
            orientation: 0,
            file: 'no-exif.jpg',
            expectedWidth: 800,
            expectedHeight: 600,
            name: 'bitmap-rejection-original-preservation',
            rejectBitmap: true,
        },
    ]) {
        stage = sample.name || `orientation-${sample.orientation}`;
        const context = await browser.newContext({
                viewport: { width: 1280, height: 900 },
                deviceScaleFactor: 1,
            }),
            page = await context.newPage();
        activePage = page;
        page.setDefaultTimeout(12000);
        page.on('pageerror', (e) => result.errors.push({ stage, message: e.message }));
        page.on('console', (m) => {
            if (m.type() === 'error') result.consoleErrors.push({ stage, message: m.text() });
        });
        page.on('response', (res) => result.requests.push({ stage, url: res.url(), status: res.status() }));
        await page.addInitScript(
            ({ disableOffscreen, rejectBitmap }) => {
                window.testBlobs = [];
                window.bitmapObservation = { calls: [], closed: 0 };
                window.readyMutations = 0;
                const real = globalThis.createImageBitmap;
                globalThis.createImageBitmap = async (...args) => {
                    window.bitmapObservation.calls.push({
                        imageOrientation: args[1]?.imageOrientation,
                        bytes: args[0]?.size,
                    });
                    if (rejectBitmap) throw Error('QF16 injected bitmap decoder rejection');
                    const b = await real(...args);
                    const close = b.close.bind(b);
                    b.close = () => {
                        window.bitmapObservation.closed++;
                        return close();
                    };
                    return b;
                };
                if (disableOffscreen)
                    Object.defineProperty(globalThis, 'OffscreenCanvas', {
                        value: undefined,
                        configurable: true,
                    });
                const create = URL.createObjectURL.bind(URL);
                URL.createObjectURL = (blob) => {
                    window.testBlobs.push(blob);
                    return create(blob);
                };
                new MutationObserver((records) => {
                    for (const record of records)
                        if (
                            record.target instanceof HTMLCanvasElement &&
                            record.attributeName === 'data-ready'
                        )
                            window.readyMutations++;
                }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-ready'] });
            },
            { disableOffscreen: !!sample.disableOffscreen, rejectBitmap: !!sample.rejectBitmap },
        );
        await page.goto(result.url);
        await page.waitForSelector('canvas[data-ready=true]');
        const before = await page.evaluate(() => window.readyMutations),
            chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: '파일 열기', exact: true }).click();
        await (await chooser).setFiles(out + '/fixtures/' + sample.file);
        if (sample.rejectBitmap)
            await page
                .getByRole('status')
                .filter({ hasText: 'QF16 injected bitmap decoder rejection' })
                .waitFor();
        else
            await page.waitForFunction(
                ({ before, w, h }) =>
                    window.readyMutations > before &&
                    !document.querySelector('.busy') &&
                    document.querySelector('canvas')?.dataset.ready === 'true' &&
                    document.querySelector('.document-info')?.textContent.includes(`${w} × ${h}`),
                { before, w: sample.expectedWidth, h: sample.expectedHeight },
            );
        await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
        await page.getByRole('button', { name: '파일 받기', exact: true }).waitFor();
        const bytes = Buffer.from(
                await page.evaluate(async () =>
                    Array.from(new Uint8Array(await window.testBlobs.at(-1).arrayBuffer())),
                ),
            ),
            doc = decodeProject(bytes);
        assert.equal(doc.width, sample.expectedWidth);
        assert.equal(doc.height, sample.expectedHeight);
        assert.equal(doc.layers.length, 1);
        assert.equal(doc.layers[0].visible, true);
        assert.equal(doc.active, 0);
        const actual = doc.layers[0].pixels;
        let expected, corners;
        if (sample.rejectBitmap) {
            expected = new Uint8ClampedArray(800 * 600 * 4).fill(255);
        } else if (sample.orientation === 0) {
            basePixels = actual.slice();
            expected = basePixels;
            assert.equal(
                new Set(Array.from({ length: 24 }, (_, i) => basePixels[i * 4])).size,
                24,
                'asymmetric grayscale decoded labels unique',
            );
            await fs.writeFile(out + '/decoded-base.rgba', basePixels);
        } else {
            const rows = manifest.expectedIndexRows[sample.orientation];
            expected = Uint8ClampedArray.from(
                rows.flat().flatMap((i) => Array.from(basePixels.subarray(i * 4, i * 4 + 4))),
            );
            corners = [rows[0][0], rows[0].at(-1), rows.at(-1)[0], rows.at(-1).at(-1)].map((i) =>
                Array.from(basePixels.subarray(i * 4, i * 4 + 4)),
            );
        }
        assert.deepEqual(actual, expected, stage + ' whole RGBA');
        const actualCorners = [
            0,
            doc.width - 1,
            (doc.height - 1) * doc.width,
            doc.width * doc.height - 1,
        ].map((i) => Array.from(actual.subarray(i * 4, i * 4 + 4)));
        if (corners) assert.deepEqual(actualCorners, corners);
        const bitmap = await page.evaluate(() => window.bitmapObservation);
        assert.equal(bitmap.calls.length, 1);
        assert.equal(bitmap.calls[0].imageOrientation, 'from-image');
        assert.equal(bitmap.closed, sample.rejectBitmap ? 0 : 1);
        await fs.writeFile(out + '/' + stage + '.rpaint', bytes);
        result.cases.push({
            name: stage,
            orientation: sample.orientation,
            file: sample.file,
            width: doc.width,
            height: doc.height,
            wholeRGBAExact: true,
            corners: actualCorners,
            rgbaSha256: hash(actual),
            rpaintSha256: hash(bytes),
            bitmap,
            HTMLCanvasFallback: !!sample.disableOffscreen,
            decoderFailurePreservedOriginal: !!sample.rejectBitmap,
        });
        await context.close();
        activePage = undefined;
    }
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.consoleErrors, []);
    assert.equal(result.requests.filter((x) => x.status >= 400).length, 0);
    result.ok = true;
} catch (error) {
    result.failure = { stage, message: String(error.stack || error) };
    await activePage?.screenshot({ path: out + '/failure.png' }).catch(() => {});
    process.exitCode = 1;
} finally {
    if (browser) {
        await browser.close();
        result.cleanup.browserClosed = true;
    }
    result.provenance.codecAfterSha256 = hash(
        await fs.readFile(new URL('../src/platform/codec.ts', import.meta.url)),
    );
    await fs.writeFile(out + '/results.json', JSON.stringify(result, null, 2) + '\n');
    console.log(
        JSON.stringify({
            ok: result.ok,
            cases: result.cases.length,
            stage,
            failure: result.failure,
            cleanup: result.cleanup,
        }),
    );
}
