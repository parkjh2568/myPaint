import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync, crc32 } from 'node:zlib';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
// Literal straight-RGBA inputs/outputs from independent rational arithmetic.
// The last atlas cell distinguishes per-layer rounding from deferred rounding.
const fixtures = [
    {
        id: 'layer-rounding-alpha-atlas',
        width: 8,
        height: 1,
        active: 1,
        layers: [
            {
                name: 'bottom',
                visible: true,
                rows: [
                    [
                        [13, 17, 19, 0],
                        [255, 0, 0, 1],
                        [255, 255, 255, 128],
                        [255, 0, 0, 128],
                        [21, 77, 199, 1],
                        [0, 255, 0, 255],
                        [251, 1, 127, 0],
                        [17, 91, 203, 31],
                    ],
                ],
            },
            {
                name: 'active',
                visible: true,
                rows: [
                    [
                        [11, 23, 37, 0],
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                        [0, 0, 255, 128],
                        [230, 19, 40, 128],
                        [255, 0, 0, 128],
                        [77, 88, 99, 0],
                        [221, 63, 11, 117],
                    ],
                ],
            },
            {
                name: 'top',
                visible: true,
                rows: [
                    [
                        [101, 103, 107, 0],
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                        [15, 180, 210, 63],
                        [0, 0, 255, 64],
                        [0, 0, 0, 0],
                        [11, 207, 81, 73],
                    ],
                ],
            },
        ],
        pending: null,
        expectedPngRows: [
            [
                [0, 0, 0, 0],
                [255, 0, 0, 1],
                [255, 255, 255, 128],
                [85, 0, 170, 192],
                [144, 83, 108, 159],
                [96, 95, 64, 255],
                [0, 0, 0, 0],
                [115, 128, 55, 169],
            ],
        ],
        expectedBmpRows: [
            [
                [37, 59, 61, 255],
                [38, 59, 61, 255],
                [146, 157, 158, 255],
                [73, 15, 143, 255],
                [104, 74, 90, 255],
                [96, 95, 64, 255],
                [37, 59, 61, 255],
                [89, 105, 57, 255],
            ],
        ],
        matte: [37, 59, 61, 255],
    },
    {
        id: 'original-rect-negative-hidden-active',
        width: 6,
        height: 3,
        active: 1,
        layers: [
            {
                name: 'bottom',
                visible: true,
                rows: [
                    [
                        [20, 40, 60, 255],
                        [20, 40, 60, 255],
                        [20, 40, 60, 255],
                        [20, 40, 60, 255],
                        [20, 40, 60, 255],
                        [20, 40, 60, 255],
                    ],
                    [
                        [20, 40, 60, 255],
                        [20, 40, 60, 255],
                        [20, 40, 60, 255],
                        [20, 40, 60, 255],
                        [20, 40, 60, 255],
                        [20, 40, 60, 255],
                    ],
                    [
                        [20, 40, 60, 255],
                        [20, 40, 60, 255],
                        [20, 40, 60, 255],
                        [20, 40, 60, 255],
                        [20, 40, 60, 255],
                        [20, 40, 60, 255],
                    ],
                ],
            },
            {
                name: 'hidden-active',
                visible: false,
                rows: [
                    [
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                        [255, 0, 0, 255],
                        [0, 255, 0, 128],
                        [0, 0, 255, 1],
                        [0, 0, 0, 0],
                    ],
                    [
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                        [255, 255, 0, 255],
                        [255, 0, 255, 128],
                        [0, 255, 255, 255],
                        [0, 0, 0, 0],
                    ],
                    [
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                        [200, 100, 50, 128],
                    ],
                ],
            },
            {
                name: 'top',
                visible: true,
                rows: [
                    [
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                    ],
                    [
                        [255, 255, 255, 128],
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                    ],
                    [
                        [0, 0, 0, 0],
                        [0, 0, 0, 128],
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                        [0, 0, 0, 0],
                    ],
                ],
            },
            {
                name: 'hidden-top',
                visible: false,
                rows: [
                    [
                        [255, 0, 255, 255],
                        [255, 0, 255, 255],
                        [255, 0, 255, 255],
                        [255, 0, 255, 255],
                        [255, 0, 255, 255],
                        [255, 0, 255, 255],
                    ],
                    [
                        [255, 0, 255, 255],
                        [255, 0, 255, 255],
                        [255, 0, 255, 255],
                        [255, 0, 255, 255],
                        [255, 0, 255, 255],
                        [255, 0, 255, 255],
                    ],
                    [
                        [255, 0, 255, 255],
                        [255, 0, 255, 255],
                        [255, 0, 255, 255],
                        [255, 0, 255, 255],
                        [255, 0, 255, 255],
                        [255, 0, 255, 255],
                    ],
                ],
            },
        ],
        pending: {
            kind: 'selection',
            source: { x: 2, y: 0, width: 3, height: 2 },
            sourceMask: null,
            payloadRows: [
                [
                    [255, 0, 0, 255],
                    [0, 255, 0, 128],
                    [0, 0, 255, 1],
                ],
                [
                    [255, 255, 0, 255],
                    [255, 0, 255, 128],
                    [0, 255, 255, 255],
                ],
            ],
            x: -1,
            y: 1,
            width: 3,
            height: 2,
            modified: true,
        },
        expectedPngRows: [
            [
                [20, 40, 60, 255],
                [20, 40, 60, 255],
                [20, 40, 60, 255],
                [20, 40, 60, 255],
                [20, 40, 60, 255],
                [20, 40, 60, 255],
            ],
            [
                [133, 202, 143, 255],
                [20, 40, 61, 255],
                [20, 40, 60, 255],
                [20, 40, 60, 255],
                [20, 40, 60, 255],
                [20, 40, 60, 255],
            ],
            [
                [138, 20, 158, 255],
                [0, 127, 127, 255],
                [20, 40, 60, 255],
                [20, 40, 60, 255],
                [20, 40, 60, 255],
                [110, 70, 55, 255],
            ],
        ],
        expectedBmpRows: [
            [
                [20, 40, 60, 255],
                [20, 40, 60, 255],
                [20, 40, 60, 255],
                [20, 40, 60, 255],
                [20, 40, 60, 255],
                [20, 40, 60, 255],
            ],
            [
                [133, 202, 143, 255],
                [20, 40, 61, 255],
                [20, 40, 60, 255],
                [20, 40, 60, 255],
                [20, 40, 60, 255],
                [20, 40, 60, 255],
            ],
            [
                [138, 20, 158, 255],
                [0, 127, 127, 255],
                [20, 40, 60, 255],
                [20, 40, 60, 255],
                [20, 40, 60, 255],
                [110, 70, 55, 255],
            ],
        ],
        matte: [37, 59, 61, 255],
    },
    {
        id: 'single-layer-source-clear-hidden-rgb',
        width: 3,
        height: 1,
        active: 0,
        layers: [
            {
                name: 'only',
                visible: true,
                rows: [
                    [
                        [255, 0, 0, 255],
                        [10, 20, 30, 128],
                        [0, 0, 0, 0],
                    ],
                ],
            },
        ],
        pending: {
            kind: 'selection',
            source: { x: 0, y: 0, width: 1, height: 1 },
            sourceMask: null,
            payloadRows: [[[255, 0, 0, 255]]],
            x: 2,
            y: 0,
            width: 1,
            height: 1,
            modified: true,
        },
        expectedPngRows: [
            [
                [0, 0, 0, 0],
                [10, 20, 30, 128],
                [255, 0, 0, 255],
            ],
        ],
        expectedBmpRows: [
            [
                [37, 59, 61, 255],
                [23, 39, 45, 255],
                [255, 0, 0, 255],
            ],
        ],
        matte: [37, 59, 61, 255],
        background: [37, 59, 61, 0],
    },
];
// Literal positive expansion: clear original active source first, fill only new layer0 area with document background, then blend payload and visible layers.
fixtures.push({
    id: 'positive-selection-expansion-background-and-hidden-active',
    width: 2,
    height: 1,
    active: 1,
    background: [37, 59, 61, 128],
    layers: [
        {
            name: 'base',
            visible: true,
            rows: [
                [
                    [20, 40, 60, 128],
                    [20, 40, 60, 128],
                ],
            ],
        },
        {
            name: 'hidden-active',
            visible: false,
            rows: [
                [
                    [255, 0, 0, 128],
                    [0, 255, 0, 128],
                ],
            ],
        },
    ],
    pending: { source: { x: 1, y: 0, width: 1, height: 1 }, x: 2, y: 0 },
    expectedPngRows: [
        [
            [177, 13, 20, 192],
            [20, 40, 60, 128],
            [12, 190, 20, 192],
        ],
    ],
    expectedBmpRows: [
        [
            [142, 24, 30, 255],
            [28, 49, 60, 255],
            [18, 158, 30, 255],
        ],
    ],
    matte: [37, 59, 61, 255],
});
const output = path.resolve(
        process.env.PAINT_EXPORT_PREVIEW_OUTPUT ||
            '../build-web-work/task-planning/export-preview/ui/results.json',
    ),
    hash = (bytes) => createHash('sha256').update(bytes).digest('hex'),
    results = {
        url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
        scope: 'Public Chromium export dialog, actual production codec Workers, modeled native IPC. Exact preview putImageData inputs and independent PNG/BMP readers; Canvas low-alpha RGB readback is a separate observation. No private Studio hooks, modified Worker responses, OS picker/filesystem, physical input, native WebKit or performance acceptance.',
        testSha256: hash(await fs.readFile(new URL(import.meta.url))),
        fixtureSha256: hash(JSON.stringify(fixtures)),
        sourceSha256: {},
        assets: [],
        checks: [],
        cases: [],
        errors: [],
        failures: [],
    };
await fs.mkdir(path.dirname(output), { recursive: true });
for (const file of ['main.ts', 'engine/document.ts', 'platform/codec.ts', 'workers/codec.worker.ts'])
    results.sourceSha256[file] = hash(await fs.readFile(new URL('../src/' + file, import.meta.url)));

function instrument() {
    const probe = (window.exportPreviewTest = {
        serial: 0,
        latest: undefined,
        uploads: [],
        maxWidth: 0,
        maxHeight: 0,
    });
    Object.assign(probe, {
        failContext: 0,
        throwPut: 0,
        contextFailures: 0,
        putFailures: 0,
        measure: false,
        allocations: [],
        holdFont: false,
        heldFonts: [],
        fontWaits: 0,
    });
    probe.htmlSurfaces = 0;
    const createElement = document.createElement;
    document.createElement = function (...args) {
        const value = createElement.apply(this, args);
        if (probe.measure && String(args[0]).toLowerCase() === 'canvas') probe.htmlSurfaces++;
        return value;
    };
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) {
        if (this.closest?.('.export-preview') && args[0] === '2d' && probe.failContext) {
            probe.failContext--;
            probe.contextFailures++;
            return null;
        }
        return get.apply(this, args);
    };
    const load = document.fonts.load.bind(document.fonts);
    document.fonts.load = (...args) => {
        if (probe.holdFont) {
            probe.holdFont = false;
            probe.fontWaits++;
            return new Promise((resolve) => probe.heldFonts.push(() => resolve([])));
        }
        return load(...args);
    };
    const seen = new WeakSet(),
        owners = new WeakMap();
    for (const name of ['Uint8Array', 'Uint8ClampedArray', 'Uint32Array']) {
        const Type = window[name],
            slice = Type.prototype.slice;
        window[name] = new Proxy(Type, {
            construct(target, args) {
                const value = Reflect.construct(target, args);
                if (probe.measure && !(args[0] instanceof ArrayBuffer) && !seen.has(value.buffer)) {
                    seen.add(value.buffer);
                    const record = {
                        kind: name,
                        bytes: value.buffer.byteLength,
                        stack: new Error().stack,
                        usedBy: [],
                    };
                    owners.set(value.buffer, record);
                    probe.allocations.push(record);
                }
                return value;
            },
        });
        Type.prototype.slice = function (...args) {
            const value = slice.apply(this, args);
            if (probe.measure && !seen.has(value.buffer)) {
                seen.add(value.buffer);
                const record = {
                    kind: name + '.slice',
                    bytes: value.buffer.byteLength,
                    stack: new Error().stack,
                    usedBy: [],
                };
                owners.set(value.buffer, record);
                probe.allocations.push(record);
            }
            return value;
        };
    }
    const Image = window.ImageData;
    window.ImageData = new Proxy(Image, {
        construct(target, args) {
            const value = Reflect.construct(target, args);
            if (probe.measure && !seen.has(value.data.buffer)) {
                seen.add(value.data.buffer);
                const record = {
                    kind: 'ImageData',
                    bytes: value.data.buffer.byteLength,
                    stack: new Error().stack,
                    usedBy: [],
                };
                owners.set(value.data.buffer, record);
                probe.allocations.push(record);
            }
            return value;
        },
    });
    const put = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (image, ...args) {
        if (this.canvas.closest?.('.export-preview')) {
            if (probe.throwPut) {
                probe.throwPut--;
                probe.putFailures++;
                throw Error('Injected preview putImageData failure');
            }
            if (
                image.width > 192 ||
                image.height > 192 ||
                this.canvas.width > 192 ||
                this.canvas.height > 192
            )
                throw Error('Export preview exceeded192px backing/sample cap');
            probe.maxWidth = Math.max(probe.maxWidth, this.canvas.width);
            probe.maxHeight = Math.max(probe.maxHeight, this.canvas.height);
            probe.latestCanvas = this.canvas;
            probe.latest = {
                serial: ++probe.serial,
                width: image.width,
                height: image.height,
                pixels: Array.from(image.data),
            };
            probe.uploads.push({
                serial: probe.serial,
                width: image.width,
                height: image.height,
                connected: this.canvas.isConnected,
            });
        }
        return put.call(this, image, ...args);
    };
    for (const Context of [CanvasRenderingContext2D, globalThis.OffscreenCanvasRenderingContext2D].filter(
        Boolean,
    )) {
        const method = Context.prototype.putImageData;
        Context.prototype.putImageData = function (image, ...args) {
            const record = owners.get(image.data.buffer);
            if (record && record.usedBy.length < 16)
                record.usedBy.push({
                    canvas: this.canvas.constructor.name,
                    width: this.canvas.width,
                    height: this.canvas.height,
                    preview: Boolean(this.canvas.closest?.('.export-preview')),
                });
            return method.call(this, image, ...args);
        };
    }
}
async function command(page, name) {
    const button = page.getByRole('button', { name, exact: true });
    if (await button.isVisible()) await button.click();
    else {
        await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
    }
}
async function preview(page, expected, after = 0) {
    await page.waitForFunction((n) => {
        const content = document.querySelector('dialog[open] .export-preview');
        return (
            content?.dataset.state === 'ready' &&
            window.exportPreviewTest.latestCanvas === content.querySelector('canvas') &&
            window.exportPreviewTest.serial > n
        );
    }, after);
    const sample = await page.evaluate(() => {
        const canvas = document.querySelector('dialog[open] .export-preview canvas');
        return {
            ...window.exportPreviewTest.latest,
            backing: [canvas.width, canvas.height],
            status: document.querySelector('dialog[open] .export-preview [role=status]')?.textContent,
        };
    });
    assert.equal(sample.width, expected[0].length);
    assert.equal(sample.height, expected.length);
    assert.deepEqual(sample.backing, [sample.width, sample.height]);
    assert.deepEqual(sample.pixels, expected.flat(2), 'Whole raw preview upload must equal literal samples');
    assert.equal(typeof sample.status, 'string', 'Preview must expose its status element');
    return {
        serial: sample.serial,
        width: sample.width,
        height: sample.height,
        sha256: hash(Uint8Array.from(sample.pixels)),
    };
}
async function project(page) {
    const count = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    await command(page, '프로젝트 저장 또는 다운로드');
    await page.waitForFunction(
        (n) => window.__myPaintPersistenceTest.writes.length > n && !document.querySelector('.busy'),
        count,
    );
    return decodeProject(
        Uint8Array.from(
            await page.evaluate(() => Array.from(window.__myPaintPersistenceTest.writes.at(-1).bytes)),
        ),
        desktopLimits,
    );
}
async function exportFile(page) {
    const count = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    await page.getByRole('dialog').getByRole('button', { name: '내보내기', exact: true }).click();
    await page.waitForFunction(
        (n) => window.__myPaintPersistenceTest.writes.length > n && !document.querySelector('.busy'),
        count,
    );
    assert.equal(await page.getByRole('dialog').count(), 0);
    return Uint8Array.from(
        await page.evaluate(() => Array.from(window.__myPaintPersistenceTest.writes.at(-1).bytes)),
    );
}

// Independent PNG8 RGBA reader shared in structure with selection-source-contract.
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

function readBmp(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(view.getUint16(0, true), 0x4d42);
    assert.equal(view.getUint32(2, true), bytes.length);
    assert.equal(view.getUint32(10, true), 54);
    assert.equal(view.getUint32(14, true), 40);
    const width = view.getInt32(18, true),
        height = view.getInt32(22, true);
    assert(width > 0 && height > 0 && width <= 192 && height <= 192);
    assert.equal(view.getUint16(26, true), 1);
    assert.equal(view.getUint16(28, true), 32);
    assert.equal(view.getUint32(30, true), 0);
    assert.equal(bytes.length, 54 + width * height * 4);
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const from = 54 + ((height - y - 1) * width + x) * 4,
                to = (y * width + x) * 4;
            pixels.set([bytes[from + 2], bytes[from + 1], bytes[from], bytes[from + 3]], to);
        }
    return { width, height, pixels };
}
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
results.browser = browser.version();
const watchdog = setTimeout(() => {
    results.failures.push({ name: 'suite-watchdog', error: '120s suite deadline' });
    void browser.close();
}, 120000);
try {
    for (const entry of [
        { fixture: fixtures[0], name: 'layer-round-alpha-and-matte' },
        { fixture: fixtures[3], name: 'positive-expansion-layer0-background-hidden-active' },
        { fixture: fixtures[1], name: 'hidden-active-negative-original-selection' },
        { fixture: fixtures[2], name: 'single-layer-source-clear-hidden-rgb' },
        { fixture: fixtures[0], name: '390px-classic98-keyboard-and-matte', mobile: true },
    ]) {
        const { fixture } = entry,
            context = await browser.newContext({
                viewport: { width: 1400, height: 1000 },
                deviceScaleFactor: 1,
            }),
            page = await context.newPage(),
            record = { name: entry.name, stages: [] };
        results.cases.push(record);
        page.setDefaultTimeout(20000);
        page.on('pageerror', (e) => results.errors.push(e.message));
        page.on('response', (response) => {
            if (response.status() >= 400) results.errors.push(response.status() + ' ' + response.url());
            if (/\.js(?:[?#]|$)/.test(response.url()) && !results.assets.includes(response.url()))
                results.assets.push(response.url());
        });
        try {
            const state = createState(
                fixture.width,
                fixture.height,
                fixture.background || [0, 0, 0, 0],
                desktopLimits,
            );
            state.active = fixture.active;
            state.layers = fixture.layers.map((layer) => ({
                name: layer.name,
                visible: layer.visible,
                pixels: Uint8ClampedArray.from(layer.rows.flat(2)),
            }));
            const bytes = encodeProject(state, desktopLimits);
            record.inputSha256 = hash(bytes);
            record.originalLayerSha256 = state.layers.map((layer) => hash(layer.pixels));
            await page.addInitScript(installNativeHarness, {});
            await page.addInitScript(instrument);
            await page.goto(results.url);
            await page.waitForFunction(
                () =>
                    window.__myPaintPersistenceTest?.generation === 1 &&
                    !document.querySelector('dialog[open]') &&
                    document.querySelector('.workspace canvas')?.dataset.ready === 'true',
            );
            await page.evaluate(
                (bytes) =>
                    window.__myPaintPersistenceTest.queueOpen('preview.rpaint', Uint8Array.from(bytes)),
                Array.from(bytes),
            );
            await command(page, '파일 열기');
            await page.waitForFunction(
                () =>
                    window.__myPaintPersistenceTest.generation === 2 &&
                    !document.querySelector('.busy') &&
                    document.querySelector('.workspace canvas').dataset.ready === 'true',
            );
            assert.equal(await page.locator('#zoom').textContent(), '100%');
            const box = await page.locator('.workspace canvas').boundingBox(),
                left = box.x + box.width / 2 - state.width / 2,
                top = box.y + box.height / 2 - state.height / 2;
            await page.getByRole('button', { name: '연필', exact: true }).click();
            await page.mouse.click(left + 0.5, top + 0.5);
            await command(page, '실행 취소');
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            assert(!(await page.title()).startsWith('* '));
            if (fixture.pending) {
                const source = fixture.pending.source;
                await page.getByRole('button', { name: '사각 선택', exact: true }).click();
                await page.locator('#transparent-selection').uncheck();
                await page.mouse.move(left + source.x + 0.1, top + source.y + 0.1);
                await page.mouse.down();
                await page.mouse.move(
                    left + source.x + source.width - 0.1,
                    top + source.y + source.height - 0.1,
                );
                await page.mouse.up();
                for (let x = source.x; x > fixture.pending.x; x--) await page.keyboard.press('ArrowLeft');
                for (let x = source.x; x < fixture.pending.x; x++) await page.keyboard.press('ArrowRight');
                for (let y = source.y; y < fixture.pending.y; y++) await page.keyboard.press('ArrowDown');
            }
            if (entry.mobile) {
                await command(page, '환경설정');
                await page.getByLabel('스킨', { exact: true }).selectOption('Classic 98');
                await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
                await page.waitForFunction(() => document.documentElement.dataset.skin === 'classic');
                await page.setViewportSize({ width: 390, height: 844 });
            }
            const jobs = await page.evaluate(() => window.__myPaintPersistenceTest.codecJobs.length);
            await command(page, '이미지 내보내기');
            record.stages.push(await preview(page, fixture.expectedPngRows));
            const dialog = page.getByRole('dialog'),
                matte = dialog.getByLabel('JPG/BMP 바탕색', { exact: true });
            await dialog.getByLabel('파일 이름', { exact: true }).fill('preview-literal');
            assert(await matte.isDisabled(), 'PNG must disable the matte control');
            await dialog.getByLabel('형식', { exact: true }).selectOption('bmp');
            let serial = await page.evaluate(() => window.exportPreviewTest.serial);
            await matte.evaluate((input) => {
                input.value = '#253b3d';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            });
            record.stages.push(await preview(page, fixture.expectedBmpRows, serial));
            serial = await page.evaluate(() => window.exportPreviewTest.serial);
            await dialog.getByLabel('형식', { exact: true }).selectOption('jpg');
            record.stages.push(await preview(page, fixture.expectedBmpRows, serial));
            serial = await page.evaluate(() => window.exportPreviewTest.serial);
            await dialog.getByLabel('형식', { exact: true }).selectOption('png');
            record.stages.push(await preview(page, fixture.expectedPngRows, serial));
            assert(await matte.isDisabled());
            assert.equal(await matte.inputValue(), '#253b3d', 'PNG must preserve the selected matte');
            assert.equal(
                await dialog.getByLabel('파일 이름', { exact: true }).inputValue(),
                'preview-literal',
            );
            assert.equal(
                await page.evaluate(() => window.__myPaintPersistenceTest.codecJobs.length),
                jobs,
                'Preview changes must not start a codec Worker',
            );
            if (entry.mobile) {
                await page.waitForFunction(
                    () => !document.querySelector('dialog[open] button[value="ok"]').disabled,
                );
                record.confirmContrast = await dialog
                    .getByRole('button', { name: '내보내기', exact: true })
                    .evaluate((button) => {
                        const style = getComputedStyle(button),
                            foreground = style.color.match(/[\d.]+/g).map(Number),
                            background = style.backgroundColor.match(/[\d.]+/g).map(Number),
                            luminances = [foreground, background].map((channels) =>
                                channels
                                    .slice(0, 3)
                                    .map((value) => {
                                        value /= 255;
                                        return value <= 0.04045
                                            ? value / 12.92
                                            : ((value + 0.055) / 1.055) ** 2.4;
                                    })
                                    .reduce(
                                        (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
                                        0,
                                    ),
                            );
                        return {
                            foreground: style.color,
                            background: style.backgroundColor,
                            opacity: Number(style.opacity),
                            foregroundAlpha: foreground[3] ?? 1,
                            backgroundAlpha: background[3] ?? 1,
                            disabled: button.disabled,
                            ratio: (Math.max(...luminances) + 0.05) / (Math.min(...luminances) + 0.05),
                        };
                    });
                assert.equal(
                    record.confirmContrast.disabled,
                    false,
                    'Measure enabled ready confirm, not its disabled state',
                );
                assert.equal(record.confirmContrast.opacity, 1);
                assert.equal(record.confirmContrast.foregroundAlpha, 1);
                assert.equal(record.confirmContrast.backgroundAlpha, 1);
                assert(
                    record.confirmContrast.ratio >= 4.5,
                    'Classic98 ready primary text must have at least4.5:1 contrast',
                );
                const bounds = await dialog.boundingBox();
                assert(bounds.x >= 0 && bounds.x + bounds.width <= 391, '390px dialog must stay on screen');
                assert(await dialog.getByRole('button', { name: '취소', exact: true }).isVisible());
                assert(await dialog.getByRole('button', { name: '내보내기', exact: true }).isVisible());
                assert.equal(
                    await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth + 1),
                    true,
                    'No horizontal dialog overflow',
                );
                await page.screenshot({ path: path.join(path.dirname(output), '390-classic98-preview.png') });
                await dialog.getByLabel('파일 이름', { exact: true }).focus();
                await page.keyboard.press('Tab');
                assert.equal(
                    await page.evaluate(() => document.activeElement.closest('dialog') !== null),
                    true,
                );
            }
            const pngBytes = await exportFile(page),
                png = readPng(pngBytes);
            assert.equal(png.width, fixture.expectedPngRows[0].length);
            assert.equal(png.height, fixture.expectedPngRows.length);
            assert.deepEqual(Array.from(png.pixels), fixture.expectedPngRows.flat(2));
            record.pngSha256 = hash(pngBytes);
            assert(
                !(await page.title()).startsWith('* '),
                'Image export must not commit pending or dirty the document',
            );
            await command(page, '이미지 내보내기');
            await preview(page, fixture.expectedPngRows);
            await page.getByRole('dialog').getByLabel('형식', { exact: true }).selectOption('bmp');
            const old = await page.evaluate(() => window.exportPreviewTest.serial);
            await page
                .getByRole('dialog')
                .getByLabel('JPG/BMP 바탕색', { exact: true })
                .evaluate((input) => {
                    input.value = '#253b3d';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                });
            await preview(page, fixture.expectedBmpRows, old);
            const bmpBytes = await exportFile(page),
                bmp = readBmp(bmpBytes);
            assert.equal(bmp.width, fixture.expectedBmpRows[0].length);
            assert.equal(bmp.height, fixture.expectedBmpRows.length);
            assert.deepEqual(Array.from(bmp.pixels), fixture.expectedBmpRows.flat(2));
            record.bmpSha256 = hash(bmpBytes);
            await command(page, '이미지 내보내기');
            await preview(page, fixture.expectedPngRows);
            await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
            const cancelledAt = await page.evaluate(() => window.exportPreviewTest.serial);
            await page.evaluate(
                () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            );
            assert.equal(
                await page.evaluate(() => window.exportPreviewTest.serial),
                cancelledAt,
                'Closed preview must not repaint',
            );
            if (fixture.pending) {
                await page.locator('.workspace canvas').focus();
                await page.keyboard.press('Escape');
            }
            assert(
                await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled(),
                'Preview/export/cancel must preserve old Redo',
            );
            assert(!(await page.title()).startsWith('* '));
            assert.deepEqual(
                await project(page),
                state,
                'Preview/export/cancel must preserve every raw source byte and metadata',
            );
            await command(page, '다시 실행');
            assert(await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled());
            await command(page, '실행 취소');
            assert.deepEqual(
                await project(page),
                state,
                'Old Redo/Undo must still restore the original document',
            );
            record.resources = await page.evaluate(() => ({
                maxWidth: window.exportPreviewTest.maxWidth,
                maxHeight: window.exportPreviewTest.maxHeight,
                uploads: window.exportPreviewTest.uploads,
                workers: window.__myPaintPersistenceTest.liveWorkers.size,
            }));
            assert(record.resources.maxWidth <= 192 && record.resources.maxHeight <= 192);
            assert.equal(record.resources.workers, 0);
            record.ok = true;
            results.checks.push(entry.name);
        } catch (error) {
            record.error = String(error.stack || error);
            results.failures.push({ name: entry.name, error: record.error });
        } finally {
            await context.close();
        }
    }
    for (const kind of [
        'preview-context-null-save-and-retry',
        'preview-repaint-throw-save-and-retry',
        'font-hold-cancel-reopen-stale',
        'html-text-background-layer-order',
        'curve-pending-layer-order',
        'polygon-pending-layer-order',
        'desktop4096x4096-two-layer-bounded-preview',
    ]) {
        const context = await browser.newContext({
                viewport: { width: 1400, height: 1000 },
                deviceScaleFactor: 1,
            }),
            page = await context.newPage(),
            record = { name: kind };
        results.cases.push(record);
        page.setDefaultTimeout(30000);
        page.on('pageerror', (error) => results.errors.push(error.message));
        page.on('response', (response) => {
            if (response.status() >= 400) results.errors.push(response.status() + ' ' + response.url());
            if (/\.js(?:[?#]|$)/.test(response.url()) && !results.assets.includes(response.url()))
                results.assets.push(response.url());
        });
        try {
            const large = kind.startsWith('desktop'),
                text = kind.startsWith('font') || kind.startsWith('html'),
                shape = kind.startsWith('curve') || kind.startsWith('polygon'),
                width = large ? 4096 : text || shape ? 64 : 8,
                height = large ? 4096 : text || shape ? 32 : 1,
                state = createState(width, height, [0, 0, 0, 0], desktopLimits);
            let expected;
            if (large) {
                new Uint32Array(state.layers[0].pixels.buffer).fill(
                    new Uint32Array(Uint8Array.from([20, 40, 60, 255]).buffer)[0],
                );
                const pixels = new Uint8ClampedArray(width * height * 4);
                new Uint32Array(pixels.buffer).fill(
                    new Uint32Array(Uint8Array.from([0, 0, 255, 128]).buffer)[0],
                );
                state.layers.push({ name: 'top half blue', visible: true, pixels });
                expected = Array.from({ length: 192 }, () =>
                    Array.from({ length: 192 }, () => [10, 20, 158, 255]),
                );
            } else if (text) {
                state.layers[0].pixels.set([255, 0, 0, 128], 0);
                state.layers.push({
                    name: 'hidden text target',
                    visible: false,
                    pixels: new Uint8ClampedArray(width * height * 4),
                });
                const pixels = new Uint8ClampedArray(width * height * 4);
                for (let i = 8; i < pixels.length; i += 4) pixels.set([0, 255, 0, 128], i);
                state.layers.push({ name: 'upper half green', visible: true, pixels });
                state.active = 1;
                expected = Array.from({ length: height }, () =>
                    Array.from({ length: width }, () => [85, 170, 0, 192]),
                );
                expected[0][0] = [255, 0, 0, 192];
                expected[0][1] = [255, 0, 0, 128];
            } else if (shape) {
                // Upper opaque blue is a literal order witness; the transparent
                // witness hole at (12,12) also checks pending source-over once.
                for (let i = 0; i < state.layers[0].pixels.length; i += 4)
                    state.layers[0].pixels.set([0, 255, 0, 255], i);
                state.layers[0].pixels.set([255, 0, 0, 128], 0);
                state.layers.push({
                    name: 'hidden shape target',
                    visible: false,
                    pixels: new Uint8ClampedArray(width * height * 4),
                });
                const pixels = new Uint8ClampedArray(width * height * 4);
                for (let i = 0; i < pixels.length; i += 4) pixels.set([0, 0, 255, 255], i);
                pixels.fill(0, 0, 4);
                pixels.fill(0, (12 * width + 12) * 4, (12 * width + 12) * 4 + 4);
                state.layers.push({ name: 'upper blue with witness', visible: true, pixels });
                state.active = 1;
            } else {
                const fixture = fixtures[0];
                state.active = fixture.active;
                state.layers = fixture.layers.map((layer) => ({
                    name: layer.name,
                    visible: layer.visible,
                    pixels: Uint8ClampedArray.from(layer.rows.flat(2)),
                }));
                expected = fixture.expectedPngRows;
            }
            const input = encodeProject(state, desktopLimits);
            record.inputSha256 = hash(input);
            record.sourceLayerSha256 = state.layers.map((layer) => hash(layer.pixels));
            await page.addInitScript(installNativeHarness, {});
            await page.addInitScript(instrument);
            if (kind.startsWith('html'))
                await page.addInitScript(() => {
                    window.OffscreenCanvas = undefined;
                });
            await page.goto(results.url);
            await page.waitForFunction(
                () =>
                    window.__myPaintPersistenceTest?.generation === 1 &&
                    !document.querySelector('dialog[open]') &&
                    document.querySelector('.workspace canvas')?.dataset.ready === 'true',
            );
            await page.evaluate(
                (bytes) =>
                    window.__myPaintPersistenceTest.queueOpen(
                        'preview-control.rpaint',
                        Uint8Array.from(bytes),
                    ),
                Array.from(input),
            );
            await command(page, '파일 열기');
            await page.waitForFunction(
                () =>
                    window.__myPaintPersistenceTest.generation === 2 &&
                    !document.querySelector('.busy') &&
                    document.querySelector('.workspace canvas').dataset.ready === 'true',
            );
            if (!large) {
                assert.equal(await page.locator('#zoom').textContent(), '100%');
                const box = await page.locator('.workspace canvas').boundingBox(),
                    left = box.x + (box.width - width) / 2,
                    top = box.y + (box.height - height) / 2;
                await page.getByRole('button', { name: '연필', exact: true }).click();
                await page.mouse.click(left + 0.5, top + 0.5);
                await command(page, '실행 취소');
                assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
                if (text) {
                    await page.getByRole('button', { name: '스포이트', exact: true }).click();
                    await page.mouse.click(left + 0.5, top + 0.5);
                    await page.getByRole('button', { name: '전경색 보조색 바꾸기', exact: true }).click();
                    await page.mouse.click(left + 1.5, top + 0.5);
                    await command(page, '글꼴 · 문자 설정');
                    await page
                        .getByRole('dialog')
                        .getByLabel('문자 배경', { exact: true })
                        .selectOption('보조색');
                    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
                    await page.getByRole('button', { name: '문자', exact: true }).click();
                    await page.mouse.click(left + 0.5, top + 0.5);
                    await page.getByRole('textbox', { name: /문자 입력/ }).fill('MMMM');
                    if (kind.startsWith('font'))
                        await page.evaluate(() => {
                            window.exportPreviewTest.holdFont = true;
                        });
                } else if (shape) {
                    await page.getByRole('button', { name: '스포이트', exact: true }).click();
                    await page.mouse.click(left + 0.5, top + 0.5);
                    if (kind.startsWith('polygon')) {
                        await page.getByRole('button', { name: '전경색 보조색 바꾸기', exact: true }).click();
                        await page.mouse.click(left + 0.5, top + 0.5);
                    }
                    await page.locator('#size').evaluate((input) => {
                        input.value = '4';
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    });
                    await page.locator('#fill-shape').setChecked(kind.startsWith('polygon'));
                    await page.locator('#outline-shape').setChecked(kind.startsWith('curve'));
                    await page
                        .getByRole('button', {
                            name: kind.startsWith('curve') ? '곡선' : '다각형',
                            exact: true,
                        })
                        .click();
                    if (kind.startsWith('curve')) {
                        await page.mouse.move(left + 4, top + 12);
                        await page.mouse.down();
                        await page.mouse.move(left + 24, top + 12);
                        await page.mouse.up();
                    } else {
                        for (const [x, y] of [
                            [4, 4],
                            [24, 4],
                            [12, 24],
                        ])
                            await page.mouse.click(left + x, top + y);
                    }
                }
            }
            await page.evaluate(
                () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            );
            const jobs = await page.evaluate(() => window.__myPaintPersistenceTest.codecJobs.length);
            await page.evaluate((kind) => {
                const p = window.exportPreviewTest;
                p.measure = true;
                if (kind.includes('context-null')) p.failContext = 1;
            }, kind);
            await command(page, '이미지 내보내기');
            if (kind.startsWith('font')) {
                await page.waitForFunction(
                    () =>
                        window.exportPreviewTest.fontWaits === 1 &&
                        document.querySelector('.export-preview')?.dataset.state === 'loading',
                );
                await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
                await page.waitForFunction(() => !document.querySelector('dialog[open]'));
                await command(page, '이미지 내보내기');
                await preview(page, expected);
                const before = await page.evaluate(() => window.exportPreviewTest.serial);
                await page.evaluate(() =>
                    window.exportPreviewTest.heldFonts.splice(0).forEach((release) => release()),
                );
                await page.evaluate(
                    () =>
                        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
                );
                assert.equal(
                    await page.evaluate(() => window.exportPreviewTest.serial),
                    before,
                    'Old font completion must not repaint the reopened dialog',
                );
                record.fontCancellation = true;
            } else if (kind.includes('context-null')) {
                await page.waitForFunction(
                    () => document.querySelector('.export-preview')?.dataset.state === 'error',
                );
                assert.equal(
                    await page.evaluate(() => window.exportPreviewTest.contextFailures),
                    1,
                    'Null-context fault must actually fire',
                );
            } else if (shape) {
                await page.waitForFunction(
                    () => document.querySelector('.export-preview')?.dataset.state === 'ready',
                );
                const sample = await page.evaluate(() => window.exportPreviewTest.latest);
                expected = [];
                for (let y = 0; y < height; y++)
                    expected.push(
                        Array.from({ length: width }, (_, x) =>
                            sample.pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4),
                        ),
                    );
                for (let y = 0; y < height; y++)
                    for (let x = 0; x < width; x++)
                        if ((x !== 0 || y !== 0) && (x !== 12 || y !== 12))
                            assert.deepEqual(
                                expected[y][x],
                                [0, 0, 255, 255],
                                'Upper visible layer must remain above pending shape',
                            );
                record.previewWitness = expected[12][12];
                assert.deepEqual(
                    expected[12][12],
                    [128, 127, 0, 255],
                    'Literal interior pending shape blend witness',
                );
                record.shapeOracle =
                    'Literal upper-layer and interior witness; whole preview independently compared with actual pending PNG below, not a full geometry literal.';
            } else await preview(page, expected);
            if (kind.includes('repaint-throw')) {
                await page.evaluate(() => {
                    window.exportPreviewTest.throwPut = 1;
                });
                await page.getByRole('dialog').getByLabel('형식', { exact: true }).selectOption('bmp');
                await page.waitForFunction(
                    () => document.querySelector('.export-preview')?.dataset.state === 'error',
                );
                assert.equal(
                    await page.evaluate(() => window.exportPreviewTest.putFailures),
                    1,
                    'Repaint fault must actually fire',
                );
                await page.getByRole('dialog').getByLabel('형식', { exact: true }).selectOption('png');
            }
            if (kind.startsWith('html')) {
                record.htmlFallback = await page.evaluate(() => ({
                    offscreenAbsent: typeof OffscreenCanvas === 'undefined',
                    surfaces: window.exportPreviewTest.htmlSurfaces,
                }));
                assert(
                    record.htmlFallback.offscreenAbsent && record.htmlFallback.surfaces >= 2,
                    'Actual HTML surface fallback must be exercised',
                );
            }
            record.allocations = await page.evaluate(() => {
                window.exportPreviewTest.measure = false;
                return window.exportPreviewTest.allocations;
            });
            assert.equal(
                await page.evaluate(() => window.__myPaintPersistenceTest.codecJobs.length),
                jobs,
                'Preview must not create codec jobs',
            );
            if (large) {
                assert(record.allocations.length > 0);
                assert(
                    record.allocations.every(
                        (allocation) =>
                            allocation.bytes <= 192 * 192 * 4 ||
                            (allocation.bytes <= 512 * 512 * 4 &&
                                allocation.stack.includes('walkTiles') &&
                                allocation.stack.includes('renderFrame') &&
                                (allocation.kind !== 'ImageData' || allocation.usedBy.length > 0) &&
                                allocation.usedBy.every(
                                    (use) =>
                                        !use.preview &&
                                        use.canvas === 'OffscreenCanvas' &&
                                        use.width <= 512 &&
                                        use.height <= 512,
                                )),
                    ),
                    'No full source/flatten clone or output buffer allowed for preview',
                );
                record.rendererAllocations = record.allocations.filter(
                    (allocation) =>
                        allocation.stack.includes('walkTiles') && allocation.stack.includes('renderFrame'),
                );
                record.nonRendererAllocations = record.allocations.filter(
                    (allocation) => !record.rendererAllocations.includes(allocation),
                );
                assert(record.nonRendererAllocations.length >= 2);
                assert(
                    record.nonRendererAllocations.every((allocation) => allocation.bytes <= 192 * 192 * 4),
                    'All allocations without proven existing tile-renderer origin remain bounded',
                );
                assert(
                    record.nonRendererAllocations.some((allocation) =>
                        allocation.usedBy.some(
                            (use) => use.preview && use.width === 192 && use.height === 192,
                        ),
                    ),
                    'Observe actual preview upload backing',
                );
                record.maxNewTypedBackingBytes = Math.max(
                    ...record.nonRendererAllocations.map((value) => value.bytes),
                );
                record.resourceScope =
                    'Distinct observed Uint8/Uint8Clamped/Uint32 constructors/slices and ImageData backings in preview wall interval. Existing tile renderer is separately attributed only with walkTiles+renderFrame stack and non-preview Offscreen receiver; every unclassified allocation remains192px capped. Full source planes absent in observed constructors; JS/Canvas internals, unobserved types and RSS excluded. No timing claim.';
                await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
                assert.deepEqual(
                    await project(page),
                    state,
                    'Large preview cancel must preserve full raw source',
                );
            } else {
                const png = readPng(await exportFile(page));
                if (shape)
                    record.actualPngWitness = Array.from(
                        png.pixels.slice((12 * width + 12) * 4, (12 * width + 12) * 4 + 4),
                    );
                assert.deepEqual(
                    Array.from(png.pixels),
                    expected.flat(2),
                    'Preview and independent actual pending PNG must agree',
                );
                if (kind.includes('context-null') || kind.includes('repaint-throw')) {
                    await command(page, '이미지 내보내기');
                    await preview(page, expected);
                    await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
                    record.firstRetry = true;
                }
                if (text || shape) {
                    await page.locator('.workspace canvas').focus();
                    await page.keyboard.press('Escape');
                }
                assert(
                    await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled(),
                    'Preview controls preserve original Redo',
                );
                assert.deepEqual(await project(page), state, 'Control/failure/cancel preserves raw source');
            }
            assert(!(await page.title()).startsWith('* '));
            assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.liveWorkers.size), 0);
            record.ok = true;
            results.checks.push(kind);
        } catch (error) {
            record.error = String(error.stack || error);
            results.failures.push({ name: kind, error: record.error });
        } finally {
            await context.close();
        }
    }
} finally {
    clearTimeout(watchdog);
    await browser.close();
    results.ok = results.checks.length === 12 && !results.failures.length && !results.errors.length;
    await fs.writeFile(output, JSON.stringify(results, null, 2) + '\n');
    console.log(
        JSON.stringify({ output, ok: results.ok, checks: results.checks, failures: results.failures }),
    );
    if (!results.ok) process.exitCode = 1;
}
