import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync, crc32 } from 'node:zlib';
import { createState } from '../src/engine/document.ts';
import { encodeProject } from '../src/engine/format.ts';
const { chromium } = await import('playwright');
const output = path.resolve(
        process.env.PAINT_SELECTION_RESIZE_OUTPUT ||
            '../build-web-work/task-planning/bounded-selection-resize/public/results.json',
    ),
    out = path.dirname(output),
    hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const source = createState(64, 64, [193, 71, 117, 0]);
for (let i = 0; i < 4096; i++)
    source.layers[0].pixels.set([17 + (i % 231), 31, 191, [0, 1, 128, 255][i % 4]], i * 4);
await fs.mkdir(out, { recursive: true });
const file = path.join(out, 'source.rpaint');
await fs.writeFile(file, encodeProject(source));
const report = {
    url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
    scope: 'Actual public DOM/Canvas/PNG Worker and clipboard payload. Trusted mouse-down with capture plus synthetic moves/release, held channel fault injection. Full raw hiddenRGB and independent PNG checks; not physical cadence/native OS/performance acceptance.',
    driverSha256: hash(await fs.readFile(new URL(import.meta.url))),
    cases: [],
    errors: [],
    ok: false,
};
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
const watchdog = setTimeout(() => {
    report.watchdog = true;
    void browser.close();
}, 150000);
function instrumentation() {
    const p = (window.resizeTest = {
        armed: false,
        hold: true,
        held: [],
        inputs: [],
        writes: [],
        owners: [],
        closed: 0,
        mode: '',
        matrix: null,
    });
    const Native = window.MessageChannel,
        descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage'),
        close = MessagePort.prototype.close;
    window.MessageChannel = class extends Native {
        constructor() {
            super();
            if (p.armed) {
                p.armed = false;
                p.owners.push(this.port1, this.port2);
            }
        }
    };
    Object.defineProperty(MessagePort.prototype, 'onmessage', {
        ...descriptor,
        set(handler) {
            if (handler && p.owners.includes(this) && p.mode === 'setup-failure')
                throw Error('Injected public resize channel setup');
            return descriptor.set.call(
                this,
                typeof handler === 'function' && p.owners.includes(this)
                    ? function (event) {
                          if (p.hold) {
                              p.held.push(() => handler.call(this, event));
                              return;
                          }
                          return handler.call(this, event);
                      }
                    : handler,
            );
        },
    });
    MessagePort.prototype.close = function () {
        if (p.owners.includes(this)) p.closed++;
        return close.call(this);
    };
    const rect = CanvasRenderingContext2D.prototype.strokeRect;
    CanvasRenderingContext2D.prototype.strokeRect = function (x, y, w, h) {
        if (
            this.canvas === document.querySelector('.workspace canvas') &&
            x === 0 &&
            y === 0 &&
            w === 64 &&
            h === 64
        )
            p.matrix = Array.from(this.getTransform().toFloat64Array());
        return rect.call(this, x, y, w, h);
    };
    const WorkerNative = window.Worker;
    window.Worker = class extends WorkerNative {
        postMessage(message, transfer) {
            if (message.operation === 'png-write')
                p.inputs.push({
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
            const blob = await items[0].getType('image/png');
            p.writes.push(Array.from(new Uint8Array(await blob.arrayBuffer())));
        },
    });
}
async function copy(page, width, height) {
    const count = await page.evaluate(() => window.resizeTest.writes.length);
    await page.keyboard.press('Control+c');
    await page.waitForFunction(
        (n) => window.resizeTest.writes.length > n && !document.querySelector('.busy'),
        count,
    );
    const observed = await page.evaluate(() => ({
        input: window.resizeTest.inputs.at(-1),
        png: window.resizeTest.writes.at(-1),
    }));
    assert.deepEqual([observed.input.width, observed.input.height], [width, height]);
    const expected = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const sx = Number(
                    ((2n * BigInt(x) + 1n) * 64n + 2n * BigInt(width) - 1n) / (2n * BigInt(width)) - 1n,
                ),
                sy = Number(
                    ((2n * BigInt(y) + 1n) * 64n + 2n * BigInt(height) - 1n) / (2n * BigInt(height)) - 1n,
                );
            expected.set(
                source.layers[0].pixels.subarray((sy * 64 + sx) * 4, (sy * 64 + sx + 1) * 4),
                (y * width + x) * 4,
            );
        }
    assert.deepEqual(
        Uint8Array.from(observed.input.pixels),
        expected,
        'full raw pixels including transparent hiddenRGB',
    );
    const png = Buffer.from(observed.png);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const parts = [];
    let at = 8,
        ended = false;
    while (at + 12 <= png.length) {
        const size = png.readUInt32BE(at),
            type = png.toString('ascii', at + 4, at + 8);
        assert(size <= png.length - at - 12);
        assert.equal(crc32(png.subarray(at + 4, at + 8 + size)), png.readUInt32BE(at + 8 + size));
        if (type === 'IHDR') {
            assert.equal(png.readUInt32BE(at + 8), width);
            assert.equal(png.readUInt32BE(at + 12), height);
            assert.deepEqual([...png.subarray(at + 16, at + 21)], [8, 6, 0, 0, 0]);
        } else if (type === 'IDAT') parts.push(png.subarray(at + 8, at + 8 + size));
        else if (type === 'IEND') {
            ended = true;
            at += 12;
            break;
        }
        at += 12 + size;
    }
    assert(ended);
    assert.equal(at, png.length);
    const raw = inflateSync(Buffer.concat(parts), { maxOutputLength: height * (width * 4 + 1) + 1 });
    assert.equal(raw.length, height * (width * 4 + 1));
    for (let y = 0; y < height; y++) {
        assert.equal(raw[y * (width * 4 + 1)], 0);
        for (let x = 0; x < width; x++)
            for (let c = 0; c < 4; c++) {
                const i = (y * width + x) * 4;
                assert.equal(
                    raw[y * (width * 4 + 1) + 1 + x * 4 + c],
                    c < 3 && !expected[i + 3] ? 0 : expected[i + c],
                );
            }
    }
    return { width, height, rawSha256: hash(expected), pngSha256: hash(png) };
}
try {
    for (const mode of [
        'latest-release',
        'same-target',
        'return-start',
        'cancel-button',
        'escape',
        'blur',
        'hidden',
        'setup-failure',
        'timeout',
        'mobile-cancel',
    ].filter(
        (mode) =>
            !process.env.PAINT_SELECTION_RESIZE_CASES ||
            process.env.PAINT_SELECTION_RESIZE_CASES.split(',').includes(mode),
    )) {
        const context = await browser.newContext({
                viewport:
                    mode === 'mobile-cancel' ? { width: 390, height: 844 } : { width: 1100, height: 800 },
                ...(mode === 'mobile-cancel' ? { isMobile: true, hasTouch: true } : {}),
            }),
            page = await context.newPage();
        page.setDefaultTimeout(30000);
        await context.addInitScript(instrumentation);
        page.on('pageerror', (e) => report.errors.push({ mode, error: e.message }));
        try {
            const downloads = [];
            page.on('download', (download) => downloads.push(download.suggestedFilename()));
            await page.goto(report.url);
            await page.waitForSelector('canvas[data-ready=true]');
            if (mode === 'mobile-cancel')
                await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
            const [chooser] = await Promise.all([
                page.waitForEvent('filechooser'),
                page.getByRole('button', { name: '파일 열기', exact: true }).click(),
            ]);
            await chooser.setFiles(file);
            await page.waitForFunction(
                () =>
                    document.querySelector('.document-info').textContent === '64 × 64 px' &&
                    !document.querySelector('.busy'),
            );
            await page.getByRole('button', { name: '사각 선택', exact: true }).click();
            await page.keyboard.press('Control+a');
            await page.waitForFunction(
                () => window.resizeTest.matrix && document.querySelector('canvas').dataset.ready === 'true',
            );
            const geometry = await page.evaluate(() => {
                const c = document.querySelector('.workspace canvas'),
                    r = c.getBoundingClientRect(),
                    m = window.resizeTest.matrix;
                return {
                    x: r.x + m[12] / (c.width / r.width),
                    y: r.y + m[13] / (c.height / r.height),
                    zoom: m[0] / (c.width / r.width),
                };
            });
            await page.mouse.move(geometry.x + 63.5 * geometry.zoom, geometry.y + 63.5 * geometry.zoom);
            await page.mouse.down();
            assert(await page.locator('.workspace canvas').evaluate((c) => c.hasPointerCapture(1)));
            await page.evaluate(
                ({ mode, g }) => {
                    const p = window.resizeTest,
                        c = document.querySelector('.workspace canvas');
                    p.mode = mode;
                    p.armed = true;
                    window.moveResize = (w, h, type = 'pointermove') =>
                        c.dispatchEvent(
                            new PointerEvent(type, {
                                pointerId: 1,
                                pointerType: 'mouse',
                                button: type === 'pointerup' ? 0 : -1,
                                buttons: type === 'pointerup' ? 0 : 1,
                                clientX: g.x + w * g.zoom,
                                clientY: g.y + h * g.zoom,
                                bubbles: true,
                            }),
                        );
                    window.moveResize(512, 512);
                },
                { mode, g: geometry },
            );
            if (mode !== 'setup-failure') await page.waitForFunction(() => window.resizeTest.held.length > 0);
            if (mode === 'latest-release') {
                await page.keyboard.press('Enter');
                await page.keyboard.press('Control+s');
                await page.keyboard.press('Delete');
                assert.equal(await page.locator('dialog[open]').count(), 0);
                assert.equal(downloads.length, 0, 'incomplete resize must not download a partial project');
                assert.equal(await page.evaluate(() => window.resizeTest.writes.length), 0);
                await page.evaluate(() => {
                    window.moveResize(513, 512);
                    window.moveResize(513, 512, 'pointerup');
                });
                await page.mouse.up();
                assert(await page.locator('.resize-cancel').isVisible());
            } else if (mode === 'same-target') {
                await page.evaluate(() => {
                    for (let i = 0; i < 5; i++) window.moveResize(512, 512);
                    window.moveResize(512, 512, 'pointerup');
                });
                await page.mouse.up();
            } else if (mode === 'return-start') {
                await page.evaluate(() => {
                    window.moveResize(64, 64);
                    window.moveResize(64, 64, 'pointerup');
                });
                await page.mouse.up();
            } else if (mode !== 'setup-failure') {
                await page.evaluate(() => window.moveResize(512, 512, 'pointerup'));
                await page.mouse.up();
                if (mode === 'mobile-cancel') {
                    const bounds = await page
                        .getByRole('button', { name: '선택 크기 변경 취소', exact: true })
                        .boundingBox();
                    assert(bounds && bounds.width >= 44 && bounds.height >= 44);
                    await page.evaluate((bounds) => {
                        window.resizeTest.mobileLayout = {
                            bounds,
                            width: innerWidth,
                            height: innerHeight,
                            coarse: matchMedia('(any-pointer: coarse)').matches,
                            maxTouchPoints: navigator.maxTouchPoints,
                        };
                    }, bounds);
                    await page.screenshot({ path: path.join(out, 'mobile-pending.png') });
                }
                if (mode === 'cancel-button' || mode === 'mobile-cancel')
                    await page.getByRole('button', { name: '선택 크기 변경 취소', exact: true }).click();
                if (mode === 'escape') await page.keyboard.press('Escape');
                if (mode === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
                if (mode === 'hidden')
                    await page.evaluate(() => {
                        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
                        document.dispatchEvent(new Event('visibilitychange'));
                        delete document.hidden;
                    });
                if (mode === 'timeout')
                    await page.waitForFunction(() =>
                        document.querySelector('.status').textContent.includes('시간이 초과'),
                    );
            } else await page.mouse.up();
            await page.evaluate(() => {
                const p = window.resizeTest;
                p.hold = false;
                for (const run of p.held.splice(0)) run();
            });
            await page.waitForFunction(
                () =>
                    document.querySelector('.resize-cancel').hidden &&
                    document.querySelector('.workspace canvas').dataset.ready === 'true',
            );
            const width = mode === 'latest-release' ? 513 : mode === 'same-target' ? 512 : 64,
                height = ['latest-release', 'same-target'].includes(mode) ? 512 : 64;
            await page.locator('.workspace canvas').focus();
            const payload = await copy(page, width, height);
            const lifecycle = await page.evaluate(() => ({
                closed: window.resizeTest.closed,
                ports: window.resizeTest.owners.length,
                buttonHidden: document.querySelector('.resize-cancel').hidden,
                status: document.querySelector('.status').textContent,
            }));
            assert.equal(lifecycle.closed, 2);
            assert.equal(lifecycle.ports, 2);
            assert(lifecycle.buttonHidden);
            report.cases.push({ mode, ...payload, lifecycle, ok: true });
        } finally {
            await context.close();
        }
    }
    assert.equal(report.errors.length, 0);
    report.ok =
        report.cases.length ===
        (process.env.PAINT_SELECTION_RESIZE_CASES
            ? process.env.PAINT_SELECTION_RESIZE_CASES.split(',').length
            : 10);
} catch (error) {
    report.error = String(error.stack || error);
    process.exitCode = 1;
} finally {
    clearTimeout(watchdog);
    await browser.close();
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, error: report.error }));
}
