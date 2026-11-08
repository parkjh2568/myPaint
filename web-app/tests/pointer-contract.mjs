import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject, decodePng } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output =
    process.env.PAINT_POINTER_OUTPUT || '../build-web-work/task-planning/pointer-contract/result.json';
await fs.mkdir(path.dirname(output), { recursive: true });
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const original = createState(64, 64, [255, 255, 255, 255], desktopLimits),
    results = {
        checks: [],
        cases: [],
        errors: [],
        failures: [],
        browser: browser.version(),
        url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
        scope: 'Actual Chromium CDP mouse events, public canvas pixels and native IPC model. CDP resets only test navigation history to isolate editing from back/forward destinations; application default navigation/focus policy is unchanged and is not asserted. No production test hooks or operating-system persistence claims.',
    };
async function boot(tool) {
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
        (bytes) => window.__myPaintPersistenceTest.queueOpen('original.rpaint', Uint8Array.from(bytes)),
        Array.from(encodeProject(original, desktopLimits)),
    );
    await page.getByRole('button', { name: '파일 열기', exact: true }).click();
    await page.waitForFunction(
        () => window.__myPaintPersistenceTest.generation === 2 && !document.querySelector('.busy'),
    );
    await page.getByRole('button', { name: tool, exact: true }).click();
    await page.getByLabel('HEX 색상', { exact: true }).fill('#ff0000');
    await page.getByLabel('HEX 색상', { exact: true }).press('Tab');
    await page.locator('#secondary').evaluate((input) => {
        input.value = '#0000ff';
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#size').evaluate((input) => {
        input.value = '1';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(() => {
        window.pointerContractEvents = [];
        const canvas = document.querySelector('.workspace canvas');
        for (const type of [
            'pointerdown',
            'pointermove',
            'pointerup',
            'pointercancel',
            'gotpointercapture',
            'lostpointercapture',
            'mousedown',
            'mousemove',
            'mouseup',
        ])
            canvas.addEventListener(
                type,
                (event) =>
                    window.pointerContractEvents.push({
                        type: event.type,
                        pointerId: event.pointerId,
                        pointerType: event.pointerType,
                        button: event.button,
                        buttons: event.buttons,
                        x: event.clientX,
                        y: event.clientY,
                        shift: event.shiftKey,
                    }),
                true,
            );
    });
    const box = await page.locator('.workspace canvas').boundingBox(),
        x = box.x + box.width / 2 - 32,
        y = box.y + box.height / 2 - 32,
        cdp = await context.newCDPSession(page);
    // Isolate editing from browser back/forward destinations without changing app input handling.
    await cdp.send('Page.resetNavigationHistory');
    return { context, page, cdp, x, y };
}
async function mouse(target, type, x, y, button, buttons, modifiers = 0) {
    await target.cdp.send('Input.dispatchMouseEvent', {
        type,
        x: target.x + x,
        y: target.y + y,
        button,
        buttons,
        modifiers,
        clickCount: 1,
    });
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
async function exportPng(page) {
    const count = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    await page.getByRole('button', { name: '이미지 내보내기', exact: true }).click();
    await page.getByLabel('형식', { exact: true }).selectOption('png');
    await page.getByRole('dialog').getByRole('button', { name: '내보내기', exact: true }).click();
    await page.waitForFunction(
        (count) => window.__myPaintPersistenceTest.writes.length > count && !document.querySelector('.busy'),
        count,
    );
    const bytes = Uint8Array.from(
        await page.evaluate(() => Array.from(window.__myPaintPersistenceTest.writes.at(-1).bytes)),
    );
    return { bytes, ...decodePng(bytes, desktopLimits) };
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
try {
    const combinations = [
        ['left', 'middle', true],
        ['left', 'middle', false],
        ['left', 'right', true],
        ['right', 'left', true],
        ['right', 'left', false],
        ['left', 'back', true],
        ['left', 'back', false],
        ['left', 'forward', true],
        ['left', 'forward', false],
        ['right', 'back', true],
        ['right', 'back', false],
        ['right', 'forward', true],
        ['right', 'forward', false],
    ];
    for (const [owner, other, ownerFirst] of combinations) {
        const name = `Mouse owner ${owner} plus ${other}: ${ownerFirst ? 'owner' : 'other'} releases first`,
            target = await boot('연필');
        try {
            const mask = { left: 1, right: 2, middle: 4, back: 8, forward: 16 },
                both = mask[owner] | mask[other],
                last = ownerFirst ? 30 : 45,
                color = owner === 'right' ? [0, 0, 255, 255] : [255, 0, 0, 255];
            await mouse(target, 'mousePressed', 8, 16, owner, mask[owner]);
            await mouse(target, 'mouseMoved', 20, 16, owner, mask[owner]);
            await mouse(target, 'mousePressed', 20, 16, other, both);
            await mouse(target, 'mouseMoved', 30, 16, other, both);
            await mouse(
                target,
                'mouseReleased',
                30,
                16,
                ownerFirst ? owner : other,
                ownerFirst ? mask[other] : mask[owner],
            );
            await mouse(
                target,
                'mouseMoved',
                45,
                16,
                ownerFirst ? other : owner,
                ownerFirst ? mask[other] : mask[owner],
            );
            await mouse(target, 'mouseReleased', 45, 16, ownerFirst ? other : owner, 0);
            const events = await target.page.evaluate(() => window.pointerContractEvents);
            results.cases.push({ name, events });
            assert.deepEqual(await canvasPixel(target, 20, 16), color, 'owned stroke must really render');
            assert.deepEqual(
                await canvasPixel(target, 37, 16),
                ownerFirst ? [255, 255, 255, 255] : color,
                'ink must stop when the owning button releases',
            );
            const painted = await snapshot(target.page),
                expected = createState(64, 64, [255, 255, 255, 255], desktopLimits);
            for (let x = 8; x <= last; x++) expected.layers[0].pixels.set(color, (16 * 64 + x) * 4);
            assert.deepEqual(painted, expected);
            await target.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await snapshot(target.page), original);
            assert.equal(
                await target.page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
                false,
                'one chord must create one history entry',
            );
            await target.page.getByRole('button', { name: '다시 실행', exact: true }).click();
            assert.deepEqual(await snapshot(target.page), painted);
            await mouse(target, 'mousePressed', 8, 32, 'left', 1);
            await mouse(target, 'mouseMoved', 20, 32, 'left', 1);
            await mouse(target, 'mouseReleased', 20, 32, 'left', 0);
            assert.deepEqual(
                await canvasPixel(target, 15, 32),
                [255, 0, 0, 255],
                'fresh gesture must work after the final other-button release',
            );
            const next = await snapshot(target.page);
            for (let x = 8; x <= 20; x++) expected.layers[0].pixels.set([255, 0, 0, 255], (32 * 64 + x) * 4);
            assert.deepEqual(next, expected);
            await target.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await snapshot(target.page), painted);
            results.checks.push(name);
            console.log('PASS ' + name);
        } catch (error) {
            results.failures.push({
                name,
                error: String(error.stack || error),
                events: await target.page.evaluate(() => window.pointerContractEvents),
            });
            throw error;
        } finally {
            await target.context.close();
        }
    }
    for (const [button, mask, number] of [
        ['back', 8, 3],
        ['forward', 16, 4],
    ]) {
        {
            const name = `Side ${button} and side-first left chord never claim a stroke`,
                target = await boot('연필');
            try {
                const title = await target.page.locator('.title').textContent();
                await mouse(target, 'mousePressed', 8, 16, button, mask);
                await mouse(target, 'mouseMoved', 20, 16, button, mask);
                await mouse(target, 'mouseReleased', 20, 16, button, 0);
                const pixel = await canvasPixel(target, 15, 16),
                    undoDisabled = await target.page
                        .getByRole('button', { name: '실행 취소', exact: true })
                        .isDisabled(),
                    events = await target.page.evaluate(() => window.pointerContractEvents);
                results.cases.push({ name, phase: 'side-only', pixel, undoDisabled, events });
                assert(
                    events.some(
                        (event) =>
                            event.type === 'pointerdown' &&
                            event.pointerType === 'mouse' &&
                            event.button === number &&
                            event.buttons === mask,
                    ),
                );
                assert.equal(
                    events.some((event) => event.type === 'gotpointercapture'),
                    false,
                );
                assert.deepEqual(pixel, [255, 255, 255, 255]);
                assert.equal(await target.page.locator('.title').textContent(), title);
                assert.equal(undoDisabled, true);
                assert.deepEqual(await snapshot(target.page), original);
                await target.page.evaluate(() => {
                    window.pointerContractEvents = [];
                });
                await mouse(target, 'mousePressed', 8, 24, button, mask);
                await mouse(target, 'mousePressed', 8, 24, 'left', mask | 1);
                await mouse(target, 'mouseMoved', 20, 24, 'left', mask | 1);
                await mouse(target, 'mouseReleased', 20, 24, button, 1);
                await mouse(target, 'mouseMoved', 28, 24, 'left', 1);
                await mouse(target, 'mouseReleased', 28, 24, 'left', 0);
                const chordPixel = await canvasPixel(target, 16, 24),
                    chordEvents = await target.page.evaluate(() => window.pointerContractEvents);
                results.cases.push({
                    name,
                    phase: 'side-first primary transition',
                    pixel: chordPixel,
                    events: chordEvents,
                });
                assert(
                    chordEvents.some(
                        (event) =>
                            event.type === 'pointermove' &&
                            event.button === 0 &&
                            event.buttons === (mask | 1),
                    ),
                    'Chromium must deliver the added primary button as pointermove',
                );
                assert.equal(
                    chordEvents.some((event) => event.type === 'gotpointercapture'),
                    false,
                );
                assert.deepEqual(chordPixel, [255, 255, 255, 255]);
                assert.equal(await target.page.locator('.title').textContent(), title);
                assert.equal(
                    await target.page.getByRole('button', { name: '실행 취소', exact: true }).isDisabled(),
                    true,
                );
                assert.deepEqual(await snapshot(target.page), original);
                await mouse(target, 'mousePressed', 8, 40, 'left', 1);
                await mouse(target, 'mouseMoved', 20, 40, 'left', 1);
                await mouse(target, 'mouseReleased', 20, 40, 'left', 0);
                const expected = structuredClone(original);
                for (let x = 8; x <= 20; x++)
                    expected.layers[0].pixels.set([255, 0, 0, 255], (40 * 64 + x) * 4);
                assert.deepEqual(await canvasPixel(target, 15, 40), [255, 0, 0, 255]);
                assert.deepEqual(await snapshot(target.page), expected);
                const completed = await target.page.evaluate(() => window.pointerContractEvents);
                assert(
                    completed.some((event) => event.type === 'gotpointercapture' && event.buttons === 1),
                    'A fresh primary gesture must claim normal input after all buttons release',
                );
                await target.page.getByRole('button', { name: '실행 취소', exact: true }).click();
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
            const name = `Side ${button} preserves right pending polygon and permits the next vertex`,
                target = await boot('다각형');
            try {
                await target.page.locator('#size').evaluate((input) => {
                    input.value = '4';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                });
                for (const [x, y] of [
                    [8, 8],
                    [28, 8],
                    [28, 28],
                ]) {
                    await mouse(target, 'mousePressed', x, y, 'right', 2);
                    await mouse(target, 'mouseReleased', x, y, 'right', 0);
                }
                const before = await exportPng(target.page),
                    offset = (8 * 64 + 18) * 4;
                assert.deepEqual(Array.from(before.pixels.slice(offset, offset + 4)), [0, 0, 255, 255]);
                await target.page.evaluate(() => {
                    window.pointerContractEvents = [];
                });
                await mouse(target, 'mousePressed', 8, 28, button, mask);
                await mouse(target, 'mouseMoved', 10, 30, button, mask);
                await mouse(target, 'mouseReleased', 10, 30, button, 0);
                await canvasPixel(target, 18, 8);
                const after = await exportPng(target.page),
                    events = await target.page.evaluate(() => window.pointerContractEvents);
                results.cases.push({
                    name,
                    samePendingPng: Buffer.from(before.bytes).equals(Buffer.from(after.bytes)),
                    events,
                });
                assert(events.some((event) => event.type === 'pointerdown' && event.button === number));
                assert.equal(
                    events.some((event) => event.type === 'gotpointercapture'),
                    false,
                );
                assert.deepEqual(
                    after.bytes,
                    before.bytes,
                    'Ignored side input must neither add a vertex nor change pending colors',
                );
                await mouse(target, 'mousePressed', 8, 28, 'left', 1);
                await mouse(target, 'mouseReleased', 8, 28, 'left', 0);
                const extended = await exportPng(target.page);
                assert.deepEqual(Array.from(extended.pixels.slice(offset, offset + 4)), [255, 0, 0, 255]);
                await target.page.keyboard.press('Enter');
                const expected = structuredClone(original);
                expected.layers[0].pixels.set(extended.pixels);
                assert.deepEqual(await snapshot(target.page), expected);
                await target.page.getByRole('button', { name: '실행 취소', exact: true }).click();
                assert.deepEqual(await snapshot(target.page), original);
                assert.equal(
                    await target.page.getByRole('button', { name: '실행 취소', exact: true }).isDisabled(),
                    true,
                    'Ignoring side input must leave only the final polygon history entry',
                );
                await target.page.getByRole('button', { name: '다시 실행', exact: true }).click();
                assert.deepEqual(await snapshot(target.page), expected);
                results.checks.push(name);
            } finally {
                await target.context.close();
            }
        }
        {
            const name = `Side ${button} preserves pending selection and the next normal move`,
                target = await boot('연필');
            try {
                await mouse(target, 'mousePressed', 8, 16, 'left', 1);
                await mouse(target, 'mouseMoved', 20, 16, 'left', 1);
                await mouse(target, 'mouseReleased', 20, 16, 'left', 0);
                const painted = await snapshot(target.page);
                await target.page.getByRole('button', { name: '사각 선택', exact: true }).click();
                await mouse(target, 'mousePressed', 4, 10, 'left', 1);
                await mouse(target, 'mouseMoved', 28, 28, 'left', 1);
                await mouse(target, 'mouseReleased', 28, 28, 'left', 0);
                const before = await exportPng(target.page);
                assert.deepEqual(before.pixels, painted.layers[0].pixels);
                await target.page.evaluate(() => {
                    window.pointerContractEvents = [];
                });
                await mouse(target, 'mousePressed', 8, 14, button, mask);
                await mouse(target, 'mouseMoved', 24, 28, button, mask);
                await mouse(target, 'mouseReleased', 24, 28, button, 0);
                await canvasPixel(target, 15, 16);
                const after = await exportPng(target.page),
                    events = await target.page.evaluate(() => window.pointerContractEvents);
                results.cases.push({
                    name,
                    samePendingPng: Buffer.from(before.bytes).equals(Buffer.from(after.bytes)),
                    events,
                });
                assert(events.some((event) => event.type === 'pointerdown' && event.button === number));
                assert.equal(
                    events.some((event) => event.type === 'gotpointercapture'),
                    false,
                );
                assert.deepEqual(
                    after.bytes,
                    before.bytes,
                    'Ignored side input must not move or resize pending pixels',
                );
                await mouse(target, 'mousePressed', 8, 14, 'left', 1);
                await mouse(target, 'mouseMoved', 24, 28, 'left', 1);
                await mouse(target, 'mouseReleased', 24, 28, 'left', 0);
                const moved = await exportPng(target.page),
                    oldOffset = (16 * 64 + 15) * 4,
                    newOffset = (30 * 64 + 31) * 4;
                assert.deepEqual(
                    Array.from(moved.pixels.slice(oldOffset, oldOffset + 4)),
                    [255, 255, 255, 255],
                );
                assert.deepEqual(Array.from(moved.pixels.slice(newOffset, newOffset + 4)), [255, 0, 0, 255]);
                await target.page.keyboard.press('Escape');
                assert.deepEqual(await snapshot(target.page), painted);
                await target.page.getByRole('button', { name: '실행 취소', exact: true }).click();
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
    }
    for (const tool of ['사각형', '둥근 사각형', '타원', '직선']) {
        const variants = [];
        for (const shiftedMove of [false, true]) {
            const target = await boot(tool);
            try {
                await mouse(target, 'mousePressed', 8, 8, 'left', 1);
                await mouse(target, 'mouseMoved', 28, 18, 'left', 1, shiftedMove ? 8 : 0);
                await canvasPixel(target, 8, 8);
                await mouse(target, 'mouseReleased', 28, 18, 'left', 0, 8);
                const painted = await snapshot(target.page);
                assert.notDeepEqual(painted, original);
                let left = 64,
                    top = 64,
                    right = -1,
                    bottom = -1;
                for (let y = 0; y < 64; y++)
                    for (let x = 0; x < 64; x++) {
                        const index = (y * 64 + x) * 4;
                        if (
                            painted.layers[0].pixels[index + 1] < 255 ||
                            painted.layers[0].pixels[index + 2] < 255
                        ) {
                            left = Math.min(left, x);
                            right = Math.max(right, x);
                            top = Math.min(top, y);
                            bottom = Math.max(bottom, y);
                        }
                    }
                if (tool === '직선') {
                    // A round cap's faint antialiased edge need not have symmetric ink bounds.
                    // Compare every pixel with an independent exact 45-degree Canvas path instead.
                    const expectedLine = await target.page.evaluate(() => {
                        const surface = new OffscreenCanvas(64, 64),
                            ctx = surface.getContext('2d'),
                            endpoint = 8 + Math.sqrt(250);
                        ctx.strokeStyle = '#ff0000';
                        ctx.lineWidth = 1;
                        ctx.lineCap = 'round';
                        ctx.lineJoin = 'round';
                        ctx.beginPath();
                        ctx.moveTo(8, 8);
                        ctx.lineTo(endpoint, endpoint);
                        ctx.stroke();
                        const pixels = ctx.getImageData(0, 0, 64, 64).data;
                        for (let i = 0; i < pixels.length; i += 4) {
                            const alpha = pixels[i + 3];
                            pixels[i] = 255;
                            pixels[i + 1] = pixels[i + 2] = 255 - alpha;
                            pixels[i + 3] = 255;
                        }
                        return Array.from(pixels);
                    });
                    assert.deepEqual(
                        Array.from(painted.layers[0].pixels),
                        expectedLine,
                        'Shift line must match an independent exact 45-degree path with the original drag length',
                    );
                } else {
                    assert.equal(
                        right - left,
                        bottom - top,
                        'Shift must produce square bounds rather than merely matching two unconstrained gestures',
                    );
                }

                if (tool !== '직선')
                    assert.deepEqual(
                        [left, top, right, bottom],
                        [7, 7, 28, 28],
                        'A 20px Shift-constrained shape with a 1px outline must retain its intended location and full square bounds',
                    );
                const inkPoint = tool === '직선' ? [18, 18] : [18, 8],
                    inkIndex = (inkPoint[1] * 64 + inkPoint[0]) * 4,
                    ink = Array.from(painted.layers[0].pixels.slice(inkIndex, inkIndex + 4));
                assert(ink[1] < 255 && ink[2] < 255, 'Expected final outline pixel is blank');
                assert.deepEqual(await canvasPixel(target, ...inkPoint), ink);
                assert.deepEqual(await canvasPixel(target, 30, 30), [255, 255, 255, 255]);
                variants.push({
                    shiftedMove,
                    inkBounds: { left, top, right, bottom },
                    state: painted,
                    events: await target.page.evaluate(() => window.pointerContractEvents),
                });
                await target.page.getByRole('button', { name: '실행 취소', exact: true }).click();
                assert.deepEqual(await snapshot(target.page), original);
                assert.deepEqual(await canvasPixel(target, ...inkPoint), [255, 255, 255, 255]);
                await target.page.getByRole('button', { name: '다시 실행', exact: true }).click();
                assert.deepEqual(await snapshot(target.page), painted);
                assert.deepEqual(await canvasPixel(target, ...inkPoint), ink);
            } finally {
                await target.context.close();
            }
        }
        const name = `Same-position Shift release ${tool} matches Shift held during move and remains one Undo/Redo`;
        assert.deepEqual(variants[0].state, variants[1].state);
        results.cases.push({ name, inkBounds: variants[0].inkBounds, events: variants[0].events });
        results.checks.push(name);
        console.log('PASS ' + name);
    }
    {
        const name =
                'Stroke allocation failure releases capture, preserves pixels and accepts the first retry',
            target = await boot('브러시');
        try {
            await target.page.evaluate(() => {
                const Original = globalThis.Uint8Array;
                globalThis.Uint8Array = new Proxy(Original, {
                    construct(Type, args, newTarget) {
                        if (args.length === 1 && args[0] === 64 * 64) {
                            globalThis.Uint8Array = Original;
                            window.pointerAllocationFailed = true;
                            throw new Error('Injected one-shot stroke coverage allocation failure');
                        }
                        return Reflect.construct(Type, args, newTarget);
                    },
                });
            });
            await mouse(target, 'mousePressed', 8, 8, 'left', 1);
            await target.page.waitForFunction(() => window.pointerAllocationFailed === true);
            const pointer = await target.page.evaluate(() => {
                const id = window.pointerContractEvents.find(
                    (event) => event.type === 'pointerdown',
                ).pointerId;
                return { id, captured: document.querySelector('.workspace canvas').hasPointerCapture(id) };
            });
            assert.equal(pointer.captured, false, 'Failed stroke must release its captured pointer');
            await target.cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: 10,
                y: 10,
                button: 'left',
                buttons: 1,
            });
            await target.cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: 10,
                y: 10,
                button: 'left',
                buttons: 0,
                clickCount: 1,
            });
            assert.deepEqual(await snapshot(target.page), original);
            await mouse(target, 'mousePressed', 24, 24, 'left', 1);
            await mouse(target, 'mouseReleased', 24, 24, 'left', 0);
            const painted = await snapshot(target.page);
            assert.notDeepEqual(painted, original, 'First retry using the same mouse pointer must paint');
            assert((await canvasPixel(target, 24, 24))[1] < 255);
            await target.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await snapshot(target.page), original);
            await target.page.getByRole('button', { name: '다시 실행', exact: true }).click();
            assert.deepEqual(await snapshot(target.page), painted);
            results.cases.push({
                name,
                pointer,
                events: await target.page.evaluate(() => window.pointerContractEvents),
            });
            results.checks.push(name);
            console.log('PASS ' + name);
        } finally {
            await target.context.close();
        }
    }
    {
        const name = 'Picker capture loss without a drag accepts the first same-pointer color pick',
            target = await boot('스포이트');
        try {
            await mouse(target, 'mousePressed', 8, 8, 'left', 1);
            await mouse(target, 'mouseMoved', 9, 8, 'left', 1);
            const pointer = await target.page.evaluate(() => {
                const canvas = document.querySelector('.workspace canvas'),
                    id = window.pointerContractEvents.find((event) => event.type === 'pointerdown').pointerId,
                    captured = canvas.hasPointerCapture(id);
                if (captured) canvas.releasePointerCapture(id);
                return { id, captured };
            });
            assert.equal(pointer.captured, true, 'Fixture must exercise an actual browser capture');
            await target.cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: 10,
                y: 10,
                button: 'left',
                buttons: 1,
            });
            await target.cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: 10,
                y: 10,
                button: 'left',
                buttons: 0,
                clickCount: 1,
            });
            const lossEvents = await target.page.evaluate(() => window.pointerContractEvents);
            assert(lossEvents.some((event) => event.type === 'lostpointercapture'));
            assert(!lossEvents.some((event) => event.type === 'pointerup' || event.type === 'pointercancel'));
            await target.page.getByLabel('HEX 색상', { exact: true }).fill('#ff0000');
            await target.page.getByLabel('HEX 색상', { exact: true }).press('Tab');
            await mouse(target, 'mousePressed', 24, 24, 'left', 1);
            await mouse(target, 'mouseReleased', 24, 24, 'left', 0);
            assert.equal(await target.page.getByLabel('HEX 색상', { exact: true }).inputValue(), '#ffffff');
            assert.deepEqual(await snapshot(target.page), original);
            assert(await target.page.getByRole('button', { name: '실행 취소', exact: true }).isDisabled());
            results.cases.push({
                name,
                pointer,
                lossEvents,
                events: await target.page.evaluate(() => window.pointerContractEvents),
            });
            results.checks.push(name);
            console.log('PASS ' + name);
        } finally {
            await target.context.close();
        }
    }
    {
        const name =
                'Selection resize limit failure restores the original raster and accepts the first retry',
            target = await boot('연필');
        try {
            await mouse(target, 'mousePressed', 8, 8, 'left', 1);
            await mouse(target, 'mouseReleased', 8, 8, 'left', 0);
            const before = await snapshot(target.page);
            await target.page.getByRole('button', { name: '사각 선택', exact: true }).click();
            await mouse(target, 'mousePressed', 2, 2, 'left', 1);
            await mouse(target, 'mouseMoved', 25, 25, 'left', 1);
            await mouse(target, 'mouseReleased', 25, 25, 'left', 0);
            await mouse(target, 'mousePressed', 24, 24, 'left', 1);
            await mouse(target, 'mouseMoved', 35, 35, 'left', 1);
            assert.deepEqual(await canvasPixel(target, 11, 11), [255, 0, 0, 255]);
            await mouse(target, 'mouseMoved', 40000, 40000, 'left', 1);
            await target.page.waitForFunction(() =>
                document.querySelector('.status').textContent.includes('한도를 초과'),
            );
            const pointer = await target.page.evaluate(() => {
                const id = window.pointerContractEvents.find(
                    (event) => event.type === 'pointerdown',
                ).pointerId;
                return { id, captured: document.querySelector('.workspace canvas').hasPointerCapture(id) };
            });
            assert.equal(pointer.captured, false);
            await target.cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: 10,
                y: 10,
                button: 'left',
                buttons: 1,
            });
            await target.cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: 10,
                y: 10,
                button: 'left',
                buttons: 0,
                clickCount: 1,
            });
            await target.page.keyboard.press('Enter');
            assert.deepEqual(
                await snapshot(target.page),
                before,
                'Failed gesture must restore selection dimensions and pixels before commit',
            );
            await target.page.getByRole('button', { name: '연필', exact: true }).click();
            await mouse(target, 'mousePressed', 50, 50, 'left', 1);
            await mouse(target, 'mouseReleased', 50, 50, 'left', 0);
            const retried = await snapshot(target.page);
            assert.notDeepEqual(retried, before);
            assert.deepEqual(await canvasPixel(target, 50, 50), [255, 0, 0, 255]);
            await target.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await snapshot(target.page), before);
            results.cases.push({
                name,
                pointer,
                events: await target.page.evaluate(() => window.pointerContractEvents),
            });
            results.checks.push(name);
            console.log('PASS ' + name);
        } finally {
            await target.context.close();
        }
    }
    assert.deepEqual(results.errors, []);
} catch (error) {
    if (!results.failures.length)
        results.failures.push({
            name: 'Pointer contract or final assertion',
            error: String(error.stack || error),
        });
    throw error;
} finally {
    await fs.writeFile(output, JSON.stringify(results, null, 2) + '\n');
    await browser.close();
}
console.log(JSON.stringify(results, null, 2));
