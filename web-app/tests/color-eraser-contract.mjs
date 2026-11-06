import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';

const output =
        process.env.PAINT_COLOR_ERASER_OUTPUT ||
        '../build-web-work/task-planning/color-eraser-contract/result.json',
    { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
await fs.mkdir(path.dirname(output), { recursive: true });
const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PAINT_BROWSER_PATH || undefined,
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    }),
    results = {
        url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
        browser: browser.version(),
        testSha256: createHash('sha256')
            .update(await fs.readFile(new URL(import.meta.url)))
            .digest('hex'),
        checks: [],
        cases: [],
        errors: [],
        failures: [],
        scope: 'Public UI and actual Chromium pointer events. Literal horizontal capsule/disk row ranges are independent expected pixels; no production replacement/brush algorithm is used as an oracle. Project files use an in-memory native IPC model, not OS filesystem or clipboard validation.',
    };
function fixture() {
    const state = createState(64, 64, [255, 255, 255, 255], desktopLimits),
        active = new Uint8ClampedArray(64 * 64 * 4),
        hidden = new Uint8ClampedArray(64 * 64 * 4);
    for (let i = 0; i < hidden.length; i += 4) hidden.set([0, 255, 0, 255], i);
    hidden.set([255, 0, 0, 255], (16 * 64 + 8) * 4);
    hidden.set([255, 0, 0, 255], (50 * 64 + 50) * 4);
    for (let y = 12; y <= 20; y++)
        for (let x = 4; x <= 56; x++) active.set([255, 0, 0, 255], (y * 64 + x) * 4);
    for (let y = 48; y <= 56; y++)
        for (let x = 48; x <= 56; x++) active.set([255, 0, 0, 255], (y * 64 + x) * 4);
    active.set([0, 255, 0, 255], (16 * 64 + 20) * 4);
    state.layers.push(
        { name: 'Active', visible: true, pixels: active },
        { name: 'Hidden', visible: false, pixels: hidden },
    );
    state.active = 1;
    return state;
}
async function boot(state) {
    const context = await browser.newContext({
            viewport: { width: 1400, height: 1000 },
            deviceScaleFactor: 1,
        }),
        page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => results.errors.push(error.message));
    await page.addInitScript(installNativeHarness, {});
    await page.goto(results.url);
    await page.waitForSelector('canvas[data-ready=true]');
    await page.waitForFunction(
        () => window.__myPaintPersistenceTest.generation === 1 && !document.querySelector('dialog[open]'),
    );
    await page.evaluate(
        (bytes) => window.__myPaintPersistenceTest.queueOpen('fixture.rpaint', Uint8Array.from(bytes)),
        Array.from(encodeProject(state, desktopLimits)),
    );
    await page.getByRole('button', { name: '파일 열기', exact: true }).click();
    await page.waitForFunction(
        () => window.__myPaintPersistenceTest.generation === 2 && !document.querySelector('.busy'),
    );
    await page.getByRole('button', { name: '지정 색 교체', exact: true }).click();
    await page.getByLabel('HEX 색상', { exact: true }).fill('#ff0000');
    await page.getByLabel('HEX 색상', { exact: true }).press('Tab');
    await page.locator('#secondary').evaluate((input) => {
        input.value = '#0000ff';
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // Legacy color replacement ignores brush opacity, hardness, smoothing and square mode.
    for (const [id, value] of [
        ['size', '4'],
        ['opacity', '1'],
        ['hardness', '0'],
        ['stabilization', '75'],
    ])
        await page.locator('#' + id).evaluate((input, value) => {
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }, value);
    await page.locator('#square').check();
    const box = await page.locator('.workspace canvas').boundingBox();
    return {
        context,
        page,
        cdp: await context.newCDPSession(page),
        x: box.x + box.width / 2 - 32,
        y: box.y + box.height / 2 - 32,
    };
}
async function mouse(target, type, x, y, button = 'left', buttons = 0) {
    await target.cdp.send('Input.dispatchMouseEvent', {
        type,
        x: target.x + x,
        y: target.y + y,
        button,
        buttons,
        clickCount: 1,
    });
}
async function canvasPixel(target, x, y) {
    return target.page.locator('.workspace canvas').evaluate(
        async (canvas, point) => {
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
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
        { x: target.x + x + 0.5, y: target.y + y + 0.5 },
    );
}
async function snapshot(page) {
    await page.waitForFunction(() => !document.querySelector('.busy'));
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
try {
    for (const button of ['left', 'right']) {
        const name = `Local color replacement ${button} drag, last release and one Undo/Redo`,
            original = fixture(),
            target = await boot(original);
        try {
            const mask = button === 'left' ? 1 : 2;
            await mouse(target, 'mousePressed', 8, 16, button, mask);
            await mouse(target, 'mouseMoved', 24, 16, button, mask);
            await canvasPixel(target, 16, 16);
            await mouse(target, 'mouseReleased', 40, 16, button, 0);
            const actual = await snapshot(target.page),
                expected = structuredClone(original);
            // Radius 2, horizontal segment 8..40: these five literal scanline runs
            // include circular endpoints and exclude the nonmatching green pixel.
            for (const [y, left, right] of [
                [14, 8, 40],
                [15, 7, 41],
                [16, 6, 42],
                [17, 7, 41],
                [18, 8, 40],
            ])
                for (let x = left; x <= right; x++)
                    if (x !== 20 || y !== 16)
                        expected.layers[1].pixels.set([0, 0, 255, 255], (y * 64 + x) * 4);
            results.cases.push({
                name,
                remotePixel: Array.from(
                    actual.layers[1].pixels.slice((50 * 64 + 50) * 4, (50 * 64 + 50) * 4 + 4),
                ),
                expectedRemotePixel: [255, 0, 0, 255],
                actualActiveSha256: createHash('sha256').update(actual.layers[1].pixels).digest('hex'),
                expectedActiveSha256: createHash('sha256').update(expected.layers[1].pixels).digest('hex'),
            });
            assert.deepEqual(
                actual,
                expected,
                'Only matching pixels inside the radius2 drag capsule may change',
            );
            assert.deepEqual(await canvasPixel(target, 16, 16), [0, 0, 255, 255]);
            assert.deepEqual(await canvasPixel(target, 50, 50), [255, 0, 0, 255]);
            await target.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await snapshot(target.page), original);
            await target.page.getByRole('button', { name: '다시 실행', exact: true }).click();
            assert.deepEqual(await snapshot(target.page), expected);
            results.checks.push(name);
        } finally {
            await target.context.close();
        }
    }
    for (const takeover of [false, true]) {
        const name = takeover
                ? 'Second touch takeover rolls back local color replacement'
                : 'Touch cancel rolls back local color replacement',
            original = fixture(),
            target = await boot(original);
        try {
            const first = { x: target.x + 8, y: target.y + 16, id: 41, force: 1 },
                moved = { ...first, x: target.x + 24 };
            await target.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
            await target.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [moved] });
            assert.deepEqual(
                await canvasPixel(target, 16, 16),
                [0, 0, 255, 255],
                'The provisional replacement must render before cancellation',
            );
            if (takeover) {
                await target.cdp.send('Input.dispatchTouchEvent', {
                    type: 'touchStart',
                    touchPoints: [moved, { x: target.x + 32, y: target.y + 24, id: 42, force: 1 }],
                });
                await target.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            } else
                await target.cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
            assert.deepEqual(await canvasPixel(target, 16, 16), [255, 0, 0, 255]);
            assert.deepEqual(await snapshot(target.page), original);
            assert.equal(
                await target.page.getByRole('button', { name: '실행 취소', exact: true }).isDisabled(),
                true,
            );
            results.checks.push(name);
        } finally {
            await target.context.close();
        }
    }
    {
        const name = 'No nearby match preserves remote color, clean state and the Redo branch',
            original = fixture(),
            target = await boot(original);
        try {
            await mouse(target, 'mousePressed', 8, 16, 'left', 1);
            await mouse(target, 'mouseReleased', 8, 16, 'left', 0);
            const painted = await snapshot(target.page);
            assert.deepEqual(await canvasPixel(target, 8, 16), [0, 0, 255, 255]);
            await target.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await snapshot(target.page), original);
            assert.equal(
                await target.page.getByRole('button', { name: '다시 실행', exact: true }).isDisabled(),
                false,
            );
            const title = await target.page.locator('.title').textContent();
            await mouse(target, 'mousePressed', 8, 40, 'left', 1);
            await mouse(target, 'mouseReleased', 8, 40, 'left', 0);
            await canvasPixel(target, 8, 40);
            assert.equal(
                await target.page.locator('.title').textContent(),
                title,
                'A no-op must preserve the saved indicator',
            );
            assert.equal(
                await target.page.getByRole('button', { name: '실행 취소', exact: true }).isDisabled(),
                true,
            );
            assert.deepEqual(await snapshot(target.page), original);
            assert.equal(
                await target.page.getByRole('button', { name: '다시 실행', exact: true }).isDisabled(),
                false,
            );
            await target.page.getByRole('button', { name: '다시 실행', exact: true }).click();
            assert.deepEqual(await snapshot(target.page), painted);
            results.checks.push(name);
        } finally {
            await target.context.close();
        }
    }
    {
        const name = 'Low-alpha premultiplied matching stays local and preserves nonmatches',
            original = createState(64, 64, [0, 0, 0, 0], desktopLimits),
            pixels = original.layers[0].pixels;
        pixels.set([240, 20, 80, 1], (2 * 64 + 2) * 4);
        pixels.set([250, 10, 100, 1], (16 * 64 + 8) * 4);
        pixels.set([100, 10, 100, 1], (16 * 64 + 9) * 4);
        pixels.set([77, 88, 99, 0], (16 * 64 + 10) * 4);
        const target = await boot(original);
        try {
            // At alpha 1, both red 240 and red 250 quantize to premultiplied 1;
            // red 100 quantizes to 0. Source RGB is deliberately not identical.
            await target.page.getByRole('button', { name: '스포이트', exact: true }).click();
            await mouse(target, 'mousePressed', 2, 2, 'left', 1);
            await mouse(target, 'mouseReleased', 2, 2, 'left', 0);
            await target.page.getByRole('button', { name: '지정 색 교체', exact: true }).click();
            await mouse(target, 'mousePressed', 8, 16, 'left', 1);
            await mouse(target, 'mouseReleased', 8, 16, 'left', 0);
            const expected = structuredClone(original);
            expected.layers[0].pixels.set([0, 0, 255, 255], (16 * 64 + 8) * 4);
            assert.deepEqual(await snapshot(target.page), expected);
            assert.deepEqual(await canvasPixel(target, 8, 16), [0, 0, 255, 255]);
            await target.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await snapshot(target.page), original);
            await target.page.getByRole('button', { name: '다시 실행', exact: true }).click();
            assert.deepEqual(await snapshot(target.page), expected);
            results.checks.push(name);
        } finally {
            await target.context.close();
        }
    }
    {
        const name = 'Alpha-zero hidden RGB matches within the disk while outside raw bytes survive',
            original = createState(64, 64, [13, 17, 19, 0], desktopLimits),
            target = await boot(original);
        try {
            await target.page.getByRole('button', { name: '스포이트', exact: true }).click();
            await mouse(target, 'mousePressed', 2, 2, 'left', 1);
            await mouse(target, 'mouseReleased', 2, 2, 'left', 0);
            await target.page.getByRole('button', { name: '지정 색 교체', exact: true }).click();
            await mouse(target, 'mousePressed', 8, 16, 'left', 1);
            await mouse(target, 'mouseReleased', 8, 16, 'left', 0);
            const expected = structuredClone(original);
            for (const [y, left, right] of [
                [14, 8, 8],
                [15, 7, 9],
                [16, 6, 10],
                [17, 7, 9],
                [18, 8, 8],
            ])
                for (let x = left; x <= right; x++)
                    expected.layers[0].pixels.set([0, 0, 255, 255], (y * 64 + x) * 4);
            assert.deepEqual(await snapshot(target.page), expected);
            await target.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await snapshot(target.page), original);
            await target.page.getByRole('button', { name: '다시 실행', exact: true }).click();
            assert.deepEqual(await snapshot(target.page), expected);
            results.checks.push(name);
        } finally {
            await target.context.close();
        }
    }
    for (const cancelled of [false, true]) {
        const name = cancelled
                ? 'Hidden active no-match cancellation restores visibility without history'
                : 'Hidden active no-match commit reveals only visibility with one Undo/Redo',
            original = fixture();
        original.layers[1].visible = false;
        const target = await boot(original);
        try {
            const title = await target.page.locator('.title').textContent();
            if (cancelled)
                await target.cdp.send('Input.dispatchTouchEvent', {
                    type: 'touchStart',
                    touchPoints: [{ x: target.x + 8, y: target.y + 40, id: 51, force: 1 }],
                });
            else await mouse(target, 'mousePressed', 8, 40, 'left', 1);
            assert.deepEqual(
                await canvasPixel(target, 16, 16),
                [255, 0, 0, 255],
                'A hidden active layer must be provisionally revealed even when the local color does not match',
            );
            if (cancelled)
                await target.cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
            else await mouse(target, 'mouseReleased', 8, 40, 'left', 0);
            const expected = structuredClone(original);
            expected.layers[1].visible = !cancelled;
            if (cancelled) {
                assert.equal(await target.page.locator('.title').textContent(), title);
                assert.equal(
                    await target.page.getByRole('button', { name: '실행 취소', exact: true }).isDisabled(),
                    true,
                );
            } else {
                assert.notEqual(
                    await target.page.locator('.title').textContent(),
                    title,
                    'Committing the visibility edit must mark the document dirty',
                );
                assert.equal(
                    await target.page.getByRole('button', { name: '실행 취소', exact: true }).isDisabled(),
                    false,
                );
            }
            assert.deepEqual(await snapshot(target.page), expected);
            if (!cancelled) {
                await target.page.getByRole('button', { name: '실행 취소', exact: true }).click();
                assert.deepEqual(await snapshot(target.page), original);
                await target.page.getByRole('button', { name: '다시 실행', exact: true }).click();
                assert.deepEqual(await snapshot(target.page), expected);
            }
            results.checks.push(name);
        } finally {
            await target.context.close();
        }
    }
    assert.deepEqual(results.errors, []);
} catch (error) {
    results.failures.push(String(error.stack || error));
    throw error;
} finally {
    await fs.writeFile(output, JSON.stringify(results, null, 2) + '\n');
    await browser.close();
}
console.log(JSON.stringify(results, null, 2));
