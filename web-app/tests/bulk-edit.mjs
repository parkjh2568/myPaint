import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createState, cloneState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject, decodePng, encodePng } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.PAINT_BULK_OUTPUT || '../build-web-work/task-planning/bulk-edit/results.json';
await fs.mkdir(path.dirname(output), { recursive: true });
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const results = {
    checks: [],
    errors: [],
    failures: [],
    browser: browser.version(),
    scope: 'Chromium public UI, actual codec/geometry Workers and in-memory native IPC. Injected Worker responses exercise client failure/cancellation, not operating-system persistence.',
};
const fixture = createState(64, 64, [0, 0, 0, 0], desktopLimits);
fixture.layers[0].name = '바닥';
for (let p = 0; p < 64 * 64; p++) fixture.layers[0].pixels.set([p % 241, 37, 81, 255], p * 4);
fixture.layers.push({ name: '위 레이어', visible: true, pixels: new Uint8ClampedArray(64 * 64 * 4) });
fixture.active = 1;
for (let p = 0; p < 64 * 64; p++) fixture.layers[1].pixels.set([67, 151, p % 223, p % 7 ? 128 : 0], p * 4);
function instrument() {
    window.bulkMode = undefined;
    window.bulkHeld = undefined;
    window.bulkClipboard = [];
    window.bulkUploads = [];
    for (const prototype of [
        CanvasRenderingContext2D.prototype,
        globalThis.OffscreenCanvasRenderingContext2D?.prototype,
    ].filter(Boolean)) {
        const put = prototype.putImageData;
        prototype.putImageData = function (...args) {
            const image = args[0];
            window.bulkUploads.push((args.length >= 7 ? args[5] * args[6] : image.width * image.height) * 4);
            return put.apply(this, args);
        };
    }
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
        postMessage(message, transfer) {
            const mode = window.bulkMode;
            if (mode && ['geometry', 'layer-edit'].includes(message.operation)) {
                window.bulkMode = undefined;
                const receive = this.onmessage;
                this.onmessage = (event) => {
                    if (mode === 'hold') window.bulkHeld = { event, receive, worker: this };
                    else
                        receive.call(this, {
                            data: { profileId: message.profileId, error: 'Injected bulk Worker failure' },
                        });
                };
            }
            return super.postMessage(message, transfer);
        }
    };
    Object.defineProperty(navigator.clipboard, 'write', {
        configurable: true,
        value: async (items) => {
            for (const item of items)
                window.bulkClipboard.push(
                    new Uint8Array(await (await item.getType('image/png')).arrayBuffer()),
                );
            if (window.bulkClipboardFailure) throw Error('Injected clipboard failure');
        },
    });
}
async function boot(state = fixture) {
    const context = await browser.newContext({
            viewport: { width: 1400, height: 1000 },
            deviceScaleFactor: 1,
        }),
        page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', (e) => results.errors.push(e.message));
    await page.addInitScript({
        content: `(${installNativeHarness.toString()})({});(${instrument.toString()})();`,
    });
    await page.goto(process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/');
    await page.waitForSelector('canvas[data-ready=true]');
    await page.waitForFunction(
        () => window.__myPaintPersistenceTest.generation === 1 && !document.querySelector('dialog[open]'),
    );
    await page.evaluate(
        (bytes) => window.__myPaintPersistenceTest.queueOpen('bulk.rpaint', Uint8Array.from(bytes)),
        Array.from(encodeProject(state, desktopLimits)),
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
async function idle(page) {
    await page.waitForFunction(() => !document.querySelector('.busy'));
}
async function snapshot(page, png = false) {
    const n = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    if (png) {
        await page.getByRole('button', { name: '이미지 내보내기', exact: true }).click();
        await page.getByLabel('형식', { exact: true }).selectOption('png');
        await page.getByRole('dialog').getByRole('button', { name: '내보내기', exact: true }).click();
    } else await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.waitForFunction(
        (n) => window.__myPaintPersistenceTest.writes.length > n && !document.querySelector('.busy'),
        n,
    );
    const bytes = Uint8Array.from(
        await page.evaluate(() => Array.from(window.__myPaintPersistenceTest.writes.at(-1).bytes)),
    );
    return png ? decodePng(bytes, desktopLimits) : decodeProject(bytes, desktopLimits);
}
async function selection(page, x = 8, y = 6, width = 16, height = 12) {
    await page.getByRole('button', { name: '사각 선택', exact: true }).click();
    await page.getByRole('button', { name: '화면에 맞추기', exact: true }).click();
    const box = await page.locator('.workspace canvas').boundingBox(),
        ox = box.x + box.width / 2 - 32,
        oy = box.y + box.height / 2 - 32;
    await page.mouse.move(ox + x, oy + y);
    await page.mouse.down();
    await page.mouse.move(ox + x + width, oy + y + height);
    await page.mouse.up();
}
async function pendingText(page) {
    await page.getByRole('button', { name: '문자', exact: true }).click();
    const box = await page.locator('.workspace canvas').boundingBox();
    await page.mouse.click(box.x + box.width / 2 - 25, box.y + box.height / 2 - 25);
    const editor = page.getByRole('textbox', { name: /문자 입력/ });
    await editor.fill('Pending');
    return editor;
}
async function undo(page) {
    await page.getByRole('button', { name: '실행 취소', exact: true }).click();
    await idle(page);
}
async function render(page) {
    return page.locator('.workspace canvas').evaluate(async (canvas) => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const context = canvas.getContext('2d'),
            x = Math.floor(canvas.width / 2),
            y = Math.floor(canvas.height / 2);
        return Array.from(context.getImageData(x, y, 1, 1).data);
    });
}
const single = cloneState(fixture);
single.layers.pop();
single.active = 0;
const hidden = cloneState(fixture);
hidden.layers[0].visible = false;
const large = createState(1024, 1024, [109, 109, 109, 255], desktopLimits);
const hiddenStroke = cloneState(large);
hiddenStroke.layers.push({
    name: '숨긴 잉크',
    visible: false,
    pixels: new Uint8ClampedArray(1024 * 1024 * 4),
});
hiddenStroke.active = 1;
async function canvasDigest(page) {
    return page.locator('.workspace canvas').evaluate(async (canvas) => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
            .map((v) => v.toString(16).padStart(2, '0'))
            .join('');
    });
}
async function brushInput(page) {
    await page.getByRole('button', { name: '브러시', exact: true }).click();
    await page.getByLabel('HEX 색상', { exact: true }).fill('#ff0000');
    await page.getByLabel('HEX 색상', { exact: true }).press('Tab');
    await page.locator('#stabilization').evaluate((input) => {
        input.value = '0';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const box = await page.locator('.workspace canvas').boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
const cases = [
    [
        'Rendered provisional brush keeps the last release point and uploads less than the full document on commit; Undo and Redo are exact',
        large,
        async (page) => {
            const center = await brushInput(page),
                originalCanvas = await canvasDigest(page),
                cdp = await page.context().newCDPSession(page);
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mousePressed',
                x: center.x - 100,
                y: center.y,
                button: 'left',
                buttons: 1,
                clickCount: 1,
            });
            for (const dx of [-80, -50, -20])
                await cdp.send('Input.dispatchMouseEvent', {
                    type: 'mouseMoved',
                    x: center.x + dx,
                    y: center.y,
                    button: 'left',
                    buttons: 1,
                });
            assert.notEqual(await canvasDigest(page), originalCanvas);
            await page.evaluate(() => (window.bulkUploads = []));
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: center.x + 100,
                y: center.y,
                button: 'left',
                buttons: 0,
                clickCount: 1,
            });
            const paintedCanvas = await canvasDigest(page);
            const endpoint = await page.locator('.workspace canvas').evaluate(
                (canvas, point) => {
                    const rect = canvas.getBoundingClientRect();
                    return Array.from(
                        canvas
                            .getContext('2d')
                            .getImageData(
                                Math.floor(((point.x - rect.x) * canvas.width) / rect.width),
                                Math.floor(((point.y - rect.y) * canvas.height) / rect.height),
                                1,
                                1,
                            ).data,
                    );
                },
                { x: center.x + 100, y: center.y },
            );
            assert.deepEqual(endpoint, [255, 0, 0, 255]);
            const uploaded = await page.evaluate(() =>
                window.bulkUploads.reduce((sum, bytes) => sum + bytes, 0),
            );
            assert(
                uploaded > 0 && uploaded < 1024 * 1024 * 4,
                `mouseup upload=${uploaded}, full document=${1024 * 1024 * 4}`,
            );
            results.commitUploadBytes = uploaded;
            const painted = await snapshot(page);
            assert.notDeepEqual(painted, large);
            await undo(page);
            assert.equal(await canvasDigest(page), originalCanvas);
            assert.deepEqual(await snapshot(page), large);
            await page.getByRole('button', { name: '다시 실행', exact: true }).click();
            assert.equal(await canvasDigest(page), paintedCanvas);
            assert.deepEqual(await snapshot(page), painted);
            await cdp.detach();
        },
    ],
    [
        'Second touch takeover cancels an already rendered brush without ghost pixels or history',
        large,
        async (page) => {
            const center = await brushInput(page),
                original = await canvasDigest(page),
                cdp = await page.context().newCDPSession(page),
                first = { x: center.x - 80, y: center.y, id: 21, radiusX: 1, radiusY: 1, force: 1 },
                moved = { ...first, x: center.x + 20 },
                second = { x: center.x + 100, y: center.y + 40, id: 22, radiusX: 1, radiusY: 1, force: 1 };
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [moved] });
            assert.notEqual(await canvasDigest(page), original);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [moved, second] });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
            assert.equal(await canvasDigest(page), original);
            assert.deepEqual(await snapshot(page), large);
            assert.equal(
                await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
                false,
            );
            await cdp.detach();
        },
    ],
    [
        'Drawing auto-shows a hidden active layer; Undo hides it and showing it again has no stale painted canvas tiles',
        hiddenStroke,
        async (page) => {
            const center = await brushInput(page),
                original = await canvasDigest(page);
            await page.mouse.move(center.x - 60, center.y);
            await page.mouse.down();
            await page.mouse.move(center.x + 60, center.y, { steps: 6 });
            await page.mouse.up();
            assert.notEqual(await canvasDigest(page), original);
            await undo(page);
            assert.equal(await page.locator('.layer-list input[type=checkbox]').first().isChecked(), false);
            assert.equal(await canvasDigest(page), original);
            await page.locator('.layer-list input[type=checkbox]').first().check();
            assert.equal(await canvasDigest(page), original);
            const expected = cloneState(hiddenStroke);
            expected.layers[1].visible = true;
            assert.deepEqual(await snapshot(page), expected);
        },
    ],
    [
        'Malformed PNG decode preserves pending text, native binding and original pixels',
        single,
        async (page) => {
            const editor = await pendingText(page),
                before = await snapshot(page, true);
            const binding = await page.evaluate(() => window.__myPaintPersistenceTest.binding);
            const png = encodePng(1, 1, Uint8ClampedArray.from([23, 41, 61, 255]), desktopLimits);
            await page.evaluate(
                (bytes) => window.__myPaintPersistenceTest.queueOpen('broken.png', Uint8Array.from(bytes)),
                Array.from(png.subarray(0, png.length - 3)),
            );
            await page.getByRole('button', { name: '파일 열기', exact: true }).click();
            await page.getByRole('status').filter({ hasText: /PNG/ }).waitFor();
            assert.equal(await editor.inputValue(), 'Pending');
            assert.deepEqual(await snapshot(page, true), before);
            assert.deepEqual(await page.evaluate(() => window.__myPaintPersistenceTest.binding), binding);
            await editor.press('Escape');
            assert.deepEqual(await snapshot(page), single);
        },
    ],
    [
        'Worker inversion preserves alpha/other layers and is one atomic Undo',
        fixture,
        async (page) => {
            await menu(page, '색 반전');
            await page.waitForFunction(
                () =>
                    window.__myPaintPersistenceTest.codecJobs.some((job) => job.operation === 'layer-edit') &&
                    !document.querySelector('.busy'),
            );
            const expected = cloneState(fixture);
            for (let i = 0; i < expected.layers[1].pixels.length; i++)
                if (i % 4 !== 3) expected.layers[1].pixels[i] = 255 - expected.layers[1].pixels[i];
            assert.deepEqual(await snapshot(page), expected);
            await undo(page);
            assert.deepEqual(await snapshot(page), fixture);
            await page.getByRole('button', { name: '다시 실행', exact: true }).click();
            assert.deepEqual(await snapshot(page), expected);
        },
    ],
    [
        'Clear includes pending text once and one Undo restores the pre-text document',
        single,
        async (page) => {
            await pendingText(page);
            await menu(page, '활성 레이어 지우기');
            await page.getByRole('dialog').getByRole('button', { name: '지우기', exact: true }).click();
            await page.waitForFunction(
                () => !document.querySelector('textarea') && !document.querySelector('.busy'),
            );
            const expected = cloneState(single);
            expected.layers[0].pixels.fill(0);
            assert.deepEqual(await snapshot(page), expected);
            await undo(page);
            assert.deepEqual(await snapshot(page), single);
        },
    ],
    [
        'Layer merge uses actual Worker alpha compositing and restores both layers with one Undo',
        fixture,
        async (page) => {
            await page.getByRole('button', { name: '아래 레이어와 병합', exact: true }).click();
            await page.waitForFunction(
                () =>
                    document.querySelectorAll('.layer-list input[type=checkbox]').length === 1 &&
                    !document.querySelector('.busy'),
            );
            const expected = cloneState(fixture);
            for (let p = 0; p < 64 * 64; p++) {
                const a = fixture.layers[1].pixels[p * 4 + 3] / 255;
                for (let c = 0; c < 3; c++)
                    expected.layers[0].pixels[p * 4 + c] = Math.round(
                        fixture.layers[1].pixels[p * 4 + c] * a +
                            fixture.layers[0].pixels[p * 4 + c] * (1 - a),
                    );
            }
            expected.layers.pop();
            expected.active = 0;
            assert.deepEqual(await snapshot(page), expected);
            await undo(page);
            assert.deepEqual(await snapshot(page), fixture);
        },
    ],
    [
        'Rejected merge with a hidden lower layer preserves pending text and the original layer document',
        hidden,
        async (page) => {
            const editor = await pendingText(page),
                before = await snapshot(page, true);
            await page.getByRole('button', { name: '아래 레이어와 병합', exact: true }).click();
            await page.getByRole('status').filter({ hasText: '두 레이어를 먼저 표시하세요.' }).waitFor();
            assert.equal(await editor.inputValue(), 'Pending');
            assert.deepEqual(await snapshot(page, true), before);
            await editor.press('Escape');
            assert.deepEqual(await snapshot(page), hidden);
            assert.equal(
                await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
                false,
            );
        },
    ],
    [
        'Worker failure preserves pending editor, pixels and history',
        single,
        async (page) => {
            const editor = await pendingText(page),
                before = await snapshot(page, true);
            await page.evaluate(() => (window.bulkMode = 'error'));
            await menu(page, '색 반전');
            await page.getByRole('status').filter({ hasText: 'Injected bulk Worker failure' }).waitFor();
            assert.equal(await editor.inputValue(), 'Pending');
            assert.deepEqual(await snapshot(page, true), before);
            await editor.press('Escape');
            assert.deepEqual(await snapshot(page), single);
            assert.equal(
                await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
                false,
            );
            assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.liveWorkers.size), 0);
        },
    ],
    [
        'Cancelled crop preserves selection/pixels; retry crops all layers with atomic Undo',
        fixture,
        async (page) => {
            await selection(page);
            const before = await snapshot(page, true);
            await page.evaluate(() => (window.bulkMode = 'hold'));
            await menu(page, '선택 자르기');
            await page.waitForFunction(() => !!window.bulkHeld);
            await page.keyboard.press('Control+n');
            assert.equal(await page.getByRole('dialog').count(), 0);
            await page.getByRole('button', { name: '취소', exact: true }).click();
            await idle(page);
            assert.deepEqual(await snapshot(page, true), before);
            assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.liveWorkers.size), 0);
            await menu(page, '선택 자르기');
            await page.waitForFunction(
                () =>
                    document.querySelector('.document-info')?.textContent.includes('16 × 12') &&
                    !document.querySelector('.busy'),
            );
            const actual = await snapshot(page),
                expected = cloneState(fixture);
            expected.width = 16;
            expected.height = 12;
            for (let l = 0; l < 2; l++) {
                const pixels = new Uint8ClampedArray(16 * 12 * 4);
                for (let y = 0; y < 12; y++)
                    for (let x = 0; x < 16; x++)
                        pixels.set(
                            fixture.layers[l].pixels.subarray(
                                ((y + 6) * 64 + x + 8) * 4,
                                ((y + 6) * 64 + x + 9) * 4,
                            ),
                            (y * 16 + x) * 4,
                        );
                expected.layers[l].pixels = pixels;
            }
            assert.deepEqual(actual, expected);
            await undo(page);
            assert.deepEqual(await snapshot(page), fixture);
        },
    ],
    [
        'Selection Worker failure and cancellation preserve pending selection; a flip commits once with Undo',
        fixture,
        async (page) => {
            await selection(page);
            const before = await snapshot(page, true);
            await page.evaluate(() => (window.bulkMode = 'error'));
            await menu(page, '좌우 반전');
            await page.getByRole('status').filter({ hasText: 'Injected bulk Worker failure' }).waitFor();
            assert.deepEqual(await snapshot(page, true), before);
            await page.evaluate(() => (window.bulkMode = 'hold'));
            await menu(page, '선택 크기');
            await page.getByLabel('너비', { exact: true }).fill('24');
            await page.getByLabel('높이', { exact: true }).fill('18');
            await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
            await page.waitForFunction(() => !!window.bulkHeld);
            await page.keyboard.press('Control+n');
            assert.equal(await page.getByRole('dialog').count(), 0);
            await page.getByRole('button', { name: '취소', exact: true }).click();
            await idle(page);
            assert.deepEqual(await snapshot(page, true), before);
            await menu(page, '좌우 반전');
            await page.waitForFunction(
                () =>
                    !document.querySelector('.busy') &&
                    window.__myPaintPersistenceTest.liveWorkers.size === 0,
            );
            const expected = cloneState(fixture);
            for (let y = 6; y < 18; y++)
                for (let x = 8; x < 24; x++) {
                    const from = (y * 64 + 31 - x) * 4,
                        to = (y * 64 + x) * 4,
                        alpha = fixture.layers[1].pixels[from + 3];
                    expected.layers[1].pixels.set(
                        alpha ? fixture.layers[1].pixels.subarray(from, from + 4) : [0, 0, 0, 0],
                        to,
                    );
                }
            assert.deepEqual(await snapshot(page), expected);
            await undo(page);
            assert.deepEqual(await snapshot(page), fixture);
        },
    ],
    [
        'Selection delete clears only the selected active layer and Undo restores exact source',
        fixture,
        async (page) => {
            await selection(page);
            await menu(page, '선택 삭제');
            const expected = cloneState(fixture);
            for (let y = 6; y < 18; y++)
                expected.layers[1].pixels.fill(0, (y * 64 + 8) * 4, (y * 64 + 24) * 4);
            assert.deepEqual(await snapshot(page), expected);
            await undo(page);
            assert.deepEqual(await snapshot(page), fixture);
        },
    ],
    [
        'Clipboard failure preserves selection; successful cut commits exact deletion and is undoable',
        fixture,
        async (page) => {
            await selection(page);
            const before = await snapshot(page, true);
            await page.evaluate(() => (window.bulkClipboardFailure = true));
            await menu(page, '잘라내기');
            await page.getByRole('status').filter({ hasText: 'Injected clipboard failure' }).waitFor();
            assert.deepEqual(await snapshot(page, true), before);
            await page.evaluate(() => (window.bulkClipboardFailure = false));
            await menu(page, '잘라내기');
            await idle(page);
            await page.waitForFunction(
                () => window.bulkClipboard.length === 2 && !document.querySelector('.busy'),
            );
            const expected = cloneState(fixture);
            for (let y = 6; y < 18; y++)
                expected.layers[1].pixels.fill(0, (y * 64 + 8) * 4, (y * 64 + 24) * 4);
            assert.deepEqual(await snapshot(page), expected);
            await undo(page);
            assert.deepEqual(await snapshot(page), fixture);
        },
    ],
    [
        'No-selection cut preserves pixels on clipboard failure and clears atomically with Undo',
        fixture,
        async (page) => {
            await page.evaluate(() => (window.bulkClipboardFailure = true));
            await menu(page, '잘라내기');
            await page.getByRole('status').filter({ hasText: 'Injected clipboard failure' }).waitFor();
            assert.deepEqual(await snapshot(page), fixture);
            await page.evaluate(() => (window.bulkClipboardFailure = false));
            await menu(page, '잘라내기');
            await page.waitForFunction(
                () => window.bulkClipboard.length === 2 && !document.querySelector('.busy'),
            );
            const expected = cloneState(fixture);
            expected.layers[1].pixels.fill(0);
            assert.deepEqual(await snapshot(page), expected);
            await undo(page);
            assert.deepEqual(await snapshot(page), fixture);
        },
    ],
    [
        'Metadata edits and Undo preserve canvas rendering while visibility updates actual pixels',
        fixture,
        async (page) => {
            const original = await render(page);
            await page.getByRole('button', { name: '레이어 이름 변경', exact: true }).click();
            await page.getByLabel('이름', { exact: true }).fill('Renamed');
            await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
            assert.deepEqual(await render(page), original);
            await undo(page);
            assert.deepEqual(await render(page), original);
            await page.locator('.layer-list input[type=checkbox]').first().uncheck();
            await page.waitForFunction(() => !document.querySelector('.busy'));
            assert.notDeepEqual(await render(page), original);
            await undo(page);
            assert.deepEqual(await render(page), original);
            assert.deepEqual(await snapshot(page), fixture);
        },
    ],
    [
        'Merge on bottom layer leaves pending text intact without creating a history step',
        single,
        async (page) => {
            const editor = await pendingText(page),
                before = await snapshot(page, true);
            assert(await page.getByRole('button', { name: '아래 레이어와 병합', exact: true }).isDisabled());
            assert.equal(await editor.inputValue(), 'Pending');
            assert.deepEqual(await snapshot(page, true), before);
            await editor.press('Escape');
            assert.deepEqual(await snapshot(page), single);
            assert.equal(
                await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
                false,
            );
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
    await fs.writeFile(output, JSON.stringify(results, null, 2) + '\n');
    await browser.close();
}
console.log(JSON.stringify(results, null, 2));
