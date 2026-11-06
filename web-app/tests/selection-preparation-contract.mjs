import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createState } from '../src/engine/document.ts';
import { inflateSync, crc32 } from 'node:zlib';
import { encodeProject } from '../src/engine/format.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(
        process.env.PAINT_SELECTION_PREPARATION_OUTPUT ||
            '../build-web-work/task-planning/bounded-lasso/public-ui.json',
    ),
    out = path.dirname(output),
    hash = (bytes) => createHash('sha256').update(bytes).digest('hex'),
    modes = [
        'success-opaque',
        'success-key',
        'chord-success',
        'channel-cancel',
        'button-cancel',
        'escape-cancel',
        'blur-cancel',
        'hidden-cancel',
        'worker-error',
        'worker-profile',
        'worker-mask',
        'worker-roi',
        'worker-missing',
    ],
    points = Array.from(
        { length: 8193 },
        (_, i) =>
            [
                { x: 2, y: 2 },
                { x: 62, y: 2 },
                { x: 2, y: 62 },
            ][i % 3],
    ),
    state = createState(64, 64, [0, 0, 0, 0]),
    report = {
        url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
        scope: 'Public file chooser, trusted pointerdown with synthetic public pointer moves/release, actual selection/PNG Workers and actual PNG clipboard payload. Worker delivery faults and channel/cancel lifecycle are explicitly injected; not physical input cadence or native OS validation. Node extraction tests separately model source-owner races.',
        driverSha256: hash(await fs.readFile(new URL(import.meta.url))),
        cases: [],
        errors: [],
        ok: false,
    };
for (let i = 0; i < state.layers[0].pixels.length; i += 4)
    state.layers[0].pixels.set([17 + (i % 223), 63, 191, [0, 1, 128, 255][(i / 4) % 4]], i);
await fs.mkdir(out, { recursive: true });
const file = path.join(out, 'public-selection.rpaint');
await fs.writeFile(file, encodeProject(state));
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
const watchdog = setTimeout(() => {
    report.watchdog = true;
    void browser.close();
}, 120000);
function instrumentation() {
    const probe = (window.selectionPreparationTest = {
        mode: '',
        jobs: [],
        live: new Set(),
        inputs: [],
        writes: [],
        closes: 0,
        holds: [],
        cancelledChannels: 0,
    });
    const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage'),
        close = MessagePort.prototype.close;
    Object.defineProperty(MessagePort.prototype, 'onmessage', {
        ...descriptor,
        set(handler) {
            return descriptor.set.call(
                this,
                typeof handler === 'function'
                    ? function (...args) {
                          if (probe.mode === 'channel-cancel') {
                              probe.cancelledChannels++;
                              return;
                          }
                          return handler.apply(this, args);
                      }
                    : handler,
            );
        },
    });
    MessagePort.prototype.close = function () {
        probe.closes++;
        return close.call(this);
    };
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
        postMessage(message, transfers) {
            this.selectionJob = message.operation === 'selection';
            if (this.selectionJob) {
                probe.live.add(this);
                probe.jobs.push({
                    roi: [message.state.width, message.state.height],
                    points: message.selection.points.length / 2,
                    transferBytes: transfers.map((buffer) => buffer.byteLength),
                });
            }
            if (message.operation === 'png-write')
                probe.inputs.push({
                    width: message.state.width,
                    height: message.state.height,
                    pixels: Array.from(message.state.layers[0].pixels),
                });
            return super.postMessage(message, transfers);
        }
        set onmessage(handler) {
            super.onmessage = (event) => {
                if (!this.selectionJob) return handler.call(this, event);
                let data = event.data;
                if (['button-cancel', 'escape-cancel', 'blur-cancel', 'hidden-cancel'].includes(probe.mode)) {
                    probe.holds.push(() => handler.call(this, event));
                    return;
                }
                if (probe.mode === 'worker-error') {
                    this.dispatchEvent(
                        new ErrorEvent('error', { message: 'Injected selection failure', cancelable: true }),
                    );
                    return;
                }
                if (probe.mode === 'worker-profile') data = { ...data, profileId: 'invalid' };
                if (probe.mode === 'worker-mask') {
                    data.bytes[0] = 1;
                }
                if (probe.mode === 'worker-roi')
                    data = { ...data, image: { ...data.image, width: data.image.width + 1 } };
                if (probe.mode === 'worker-missing') data = { ...data, bytes: undefined };
                return handler.call(this, { data });
            };
        }
        terminate() {
            probe.live.delete(this);
            return super.terminate();
        }
    };
    Object.defineProperty(navigator.clipboard, 'write', {
        configurable: true,
        value: async (items) => {
            const blob = await items[0].getType('image/png');
            probe.writes.push(Array.from(new Uint8Array(await blob.arrayBuffer())));
        },
    });
}
async function copy(page) {
    const count = await page.evaluate(() => window.selectionPreparationTest.writes.length);
    await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '복사', exact: true }).click();
    await page.waitForFunction(
        (n) => window.selectionPreparationTest.writes.length > n && !document.querySelector('.busy'),
        count,
    );
    const observed = await page.evaluate(() => {
        const p = window.selectionPreparationTest;
        return { input: p.inputs.at(-1), png: p.writes.at(-1) };
    });
    const bytes = Uint8Array.from(observed.png),
        view = new DataView(bytes.buffer),
        chunks = [];
    assert.deepEqual(Array.from(bytes.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    let width = 0,
        height = 0,
        offset = 8,
        ended = false;
    while (offset + 12 <= bytes.length) {
        const size = view.getUint32(offset),
            name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        assert(size <= bytes.length - offset - 12);
        assert.equal(crc32(bytes.subarray(offset + 4, offset + 8 + size)), view.getUint32(offset + 8 + size));
        if (name === 'IHDR') {
            assert.equal(offset, 8);
            assert.equal(size, 13);
            width = view.getUint32(offset + 8);
            height = view.getUint32(offset + 12);
            assert(width > 0 && height > 0 && width <= 64 && height <= 64);
            assert.deepEqual(Array.from(bytes.subarray(offset + 16, offset + 21)), [8, 6, 0, 0, 0]);
        } else if (name === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + size));
        else if (name === 'IEND') {
            assert.equal(size, 0);
            ended = true;
            offset += 12;
            break;
        }
        offset += size + 12;
    }
    assert(ended);
    assert.equal(offset, bytes.length);
    const rowBytes = width * 4,
        raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: height * (rowBytes + 1) + 1 }),
        pixels = new Uint8Array(width * height * 4);
    assert.equal(raw.length, height * (rowBytes + 1));
    for (let y = 0; y < height; y++) {
        assert.equal(raw[y * (rowBytes + 1)], 0, 'shipped clipboard encoder uses unfiltered RGBA rows');
        pixels.set(raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1)), y * rowBytes);
    }
    return { ...observed, image: { width, height, pixels } };
}
try {
    for (const mode of modes.filter(
        (value) =>
            !process.env.PAINT_SELECTION_PREPARATION_CASES ||
            process.env.PAINT_SELECTION_PREPARATION_CASES.split(',').includes(value),
    )) {
        const context = await browser.newContext({ viewport: { width: 1100, height: 800 } }),
            page = await context.newPage();
        page.setDefaultTimeout(15000);
        await context.addInitScript(instrumentation);
        page.on('pageerror', (error) => report.errors.push({ mode, message: error.message }));
        try {
            await page.goto(report.url);
            await page.waitForSelector('canvas[data-ready=true]');
            const picker = page.waitForEvent('filechooser');
            await page.getByRole('button', { name: '파일 열기', exact: true }).click();
            await (await picker).setFiles(file);
            await page.waitForFunction(
                () =>
                    document.querySelector('.document-info').textContent === '64 × 64 px' &&
                    !document.querySelector('.busy'),
            );
            await page.getByRole('button', { name: '자유 선택', exact: true }).click();
            if (mode === 'success-key') {
                const secondary = page.locator('#secondary');
                await secondary.fill('#113fbf');
                await secondary.dispatchEvent('change');
                await page.locator('#transparent-selection').check();
            }
            await page.evaluate((mode) => {
                const p = window.selectionPreparationTest;
                p.mode = mode;
                p.closes = 0;
            }, mode);
            const box = await page.locator('.workspace canvas').boundingBox(),
                zoom = parseInt(await page.locator('#zoom').textContent()) / 100,
                origin = { x: box.x + box.width / 2 - 32 * zoom, y: box.y + box.height / 2 - 32 * zoom };
            await page.mouse.move(
                origin.x + (points[0].x + 0.25) * zoom,
                origin.y + (points[0].y + 0.25) * zoom,
            );
            await page.mouse.down();
            await page.evaluate(
                ({ points, origin, zoom, mode }) => {
                    const c = document.querySelector('.workspace canvas');
                    for (let i = 1; i < points.length; i++)
                        c.dispatchEvent(
                            new PointerEvent('pointermove', {
                                pointerId: 1,
                                pointerType: 'mouse',
                                buttons: 1,
                                button: -1,
                                clientX: origin.x + (points[i].x + 0.25) * zoom,
                                clientY: origin.y + (points[i].y + 0.25) * zoom,
                                bubbles: true,
                            }),
                        );
                    const q = points.at(-1);
                    c.dispatchEvent(
                        new PointerEvent(mode === 'chord-success' ? 'pointermove' : 'pointerup', {
                            pointerId: 1,
                            pointerType: 'mouse',
                            buttons: 0,
                            button: 0,
                            clientX: origin.x + (q.x + 0.25) * zoom,
                            clientY: origin.y + (q.y + 0.25) * zoom,
                            bubbles: true,
                        }),
                    );
                },
                { points, origin, zoom, mode },
            );
            // Release the trusted capture too; synthetic pointerup only finishes the public gesture.
            await page.mouse.up();
            if (mode === 'channel-cancel') {
                await page.waitForFunction(() => window.selectionPreparationTest.cancelledChannels > 0);
                assert.match(
                    await page
                        .locator('.title')
                        .textContent()
                        .catch(() => page.title()),
                    /편집|제목|selection/,
                );
                await page.keyboard.press('Escape');
            } else if (['button-cancel', 'escape-cancel', 'blur-cancel', 'hidden-cancel'].includes(mode)) {
                await page.waitForFunction(() => window.selectionPreparationTest.holds.length > 0);
                if (mode === 'button-cancel') await page.locator('.busy button').click();
                if (mode === 'escape-cancel') await page.keyboard.press('Escape');
                if (mode === 'blur-cancel')
                    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
                if (mode === 'hidden-cancel')
                    await page.evaluate(() => {
                        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
                        document.dispatchEvent(new Event('visibilitychange'));
                        delete document.hidden;
                    });
            }
            await page.waitForFunction(
                () => !document.querySelector('.busy') && window.selectionPreparationTest.live.size === 0,
            );
            await page.mouse.up();
            const snapshot = await page.evaluate(() => {
                const p = window.selectionPreparationTest;
                return {
                    jobs: p.jobs,
                    closes: p.closes,
                    controlsInert: [...document.querySelectorAll('.topbar,.tools,.inspector')].some(
                        (c) => c.inert,
                    ),
                    held: p.holds.length,
                };
            });
            assert.equal(snapshot.controlsInert, false);
            assert.equal(snapshot.closes, 2);
            if (mode === 'channel-cancel') assert.equal(snapshot.jobs.length, 0);
            else {
                assert.equal(snapshot.jobs.length, 1);
                assert.equal(snapshot.jobs[0].points, points.length);
                assert.deepEqual(snapshot.jobs[0].roi, [60, 60]);
                assert.deepEqual(snapshot.jobs[0].transferBytes, [14400, points.length * 16]);
            }
            if (mode.startsWith('success') || mode === 'chord-success') {
                const actual = await copy(page),
                    expected = new Uint8ClampedArray(60 * 60 * 4);
                for (let row = 0; row < 60; row++)
                    expected.set(
                        state.layers[0].pixels.subarray(((row + 2) * 64 + 2) * 4, ((row + 2) * 64 + 62) * 4),
                        row * 60 * 4,
                    );
                // Literal aliased right-triangle membership; 2731 complete traversals retain odd parity.
                for (let y = 0; y < 60; y++)
                    for (let x = 0; x < 60; x++) {
                        const i = (y * 60 + x) * 4;
                        if (
                            x + y >= 60 ||
                            (mode === 'success-key' &&
                                expected[i + 3] === 255 &&
                                expected[i] === 17 &&
                                expected[i + 1] === 63 &&
                                expected[i + 2] === 191)
                        )
                            expected[i + 3] = 0;
                    }
                assert.deepEqual([actual.input.width, actual.input.height], [60, 60]);
                assert.deepEqual(Uint8ClampedArray.from(actual.input.pixels), expected);
                const expectedPng = expected.slice();
                for (let i = 0; i < expectedPng.length; i += 4)
                    if (!expectedPng[i + 3]) expectedPng.fill(0, i, i + 4);
                assert.equal(hash(actual.image.pixels), hash(expectedPng));
                await page.locator('.workspace canvas').focus();
                await page.keyboard.press('ArrowRight');
                await page.keyboard.press('Escape');
            } else {
                assert.equal(await page.locator('[data-command="undo"]').isDisabled(), true);
                assert.equal(
                    await page.evaluate(() => {
                        const event = new Event('beforeunload', { cancelable: true });
                        window.dispatchEvent(event);
                        return event.defaultPrevented;
                    }),
                    false,
                    'cancel must leave no pending selection',
                );
                await page.evaluate(() => {
                    const p = window.selectionPreparationTest;
                    for (const deliver of p.holds) deliver();
                    p.mode = '';
                });
                await page.waitForTimeout(20);
                assert.equal(
                    await page.evaluate(() => {
                        const event = new Event('beforeunload', { cancelable: true });
                        window.dispatchEvent(event);
                        return event.defaultPrevented;
                    }),
                    false,
                    'late reply must not resurrect a pending selection',
                );
                assert.equal(await page.locator('[data-command="undo"]').isDisabled(), true);
            }
            await page.locator('.workspace canvas').focus();
            await page.locator('#transparent-selection').uncheck();
            await page.keyboard.press('Control+a');
            const original = await copy(page);
            assert.deepEqual([original.input.width, original.input.height], [64, 64]);
            assert.deepEqual(Uint8ClampedArray.from(original.input.pixels), state.layers[0].pixels);
            const sourcePng = state.layers[0].pixels.slice();
            for (let i = 0; i < sourcePng.length; i += 4) if (!sourcePng[i + 3]) sourcePng.fill(0, i, i + 4);
            assert.equal(hash(original.image.pixels), hash(sourcePng));
            report.cases.push({
                mode,
                ...snapshot,
                sourceRawSha256: hash(Uint8Array.from(original.input.pixels)),
                ok: true,
            });
        } catch (error) {
            report.failedCase = {
                mode,
                detail: await page
                    .evaluate(() => {
                        const p = window.selectionPreparationTest;
                        return {
                            jobs: p.jobs,
                            holds: p.holds.length,
                            live: p.live.size,
                            closes: p.closes,
                            busy: !!document.querySelector('.busy'),
                            title: document.title,
                            status: document.querySelector('.statusbar')?.textContent,
                        };
                    })
                    .catch(String),
            };
            throw error;
        } finally {
            await context.close();
        }
    }
    assert(report.cases.length > 0, 'at least one requested case must execute');
    if (!process.env.PAINT_SELECTION_PREPARATION_CASES) assert.equal(report.cases.length, modes.length);
    assert.deepEqual(report.errors, []);
    report.ok = true;
} catch (error) {
    report.error = String(error.stack || error);
    process.exitCode = 1;
} finally {
    clearTimeout(watchdog);
    await browser.close();
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ output, ok: report.ok, passed: report.cases.length, error: report.error }));
}
