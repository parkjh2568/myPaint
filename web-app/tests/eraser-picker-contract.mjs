import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(
        process.env.PAINT_ERASER_PICKER_OUTPUT ||
            '../build-web-work/task-planning/eraser-picker-contract/result.json',
    ),
    out = path.dirname(output),
    hash = (b) => crypto.createHash('sha256').update(b).digest('hex'),
    results = {
        url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
        checks: [],
        cases: [],
        failures: [],
        errors: [],
        assets: [],
        scope: 'Actual public Chromium mouse/pen/touch UI; file IPC is modeled by native-harness. No physical stylus or OS dialog claim. Literal straight RGBA, full-source Undo/Redo and paired mouse/pen release comparisons preserve source precision; Qt premul quantization is separate evidence.',
    };
await fs.mkdir(out, { recursive: true });
results.testSha256 = hash(await fs.readFile(new URL(import.meta.url)));
const pressureRecords = new Map();
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
async function boot(name, state, tool, settings = {}) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } }),
        page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (e) => results.errors.push(e.message));
    page.on('request', (r) => {
        if (/\.js(?:[?#]|$)/.test(r.url()) && !results.assets.includes(r.url())) results.assets.push(r.url());
    });
    await page.addInitScript(installNativeHarness, {});
    await page.goto(results.url);
    await page.waitForFunction(
        () => window.__myPaintPersistenceTest?.generation === 1 && !document.querySelector('dialog[open]'),
    );
    await page.evaluate(
        (bytes) => window.__myPaintPersistenceTest.queueOpen('review.rpaint', Uint8Array.from(bytes)),
        Array.from(encodeProject(state, desktopLimits)),
    );
    await page.getByRole('button', { name: '파일 열기', exact: true }).click();
    await page.waitForFunction(
        () => window.__myPaintPersistenceTest.generation === 2 && !document.querySelector('.busy'),
    );
    assert.equal(await page.locator('#zoom').textContent(), '100%');
    for (const [id, value] of Object.entries({
        size: 8,
        hardness: 100,
        stabilization: 0,
        opacity: 100,
        ...settings,
    }))
        await page.locator('#' + id).evaluate((input, value) => {
            input.value = String(value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }, value);
    await page.locator('#square').uncheck();
    await page.locator('#pressure').check();
    await page.getByLabel('HEX 색상', { exact: true }).fill('#ff00ff');
    await page.getByLabel('HEX 색상', { exact: true }).press('Tab');
    await page.locator('#secondary').evaluate((input) => {
        input.value = '#ff0000';
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.getByRole('button', { name: tool, exact: true }).click();
    await page.locator('.workspace canvas').evaluate((canvas) => {
        window.__eraserPickerEvents = [];
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'])
            canvas.addEventListener(
                type,
                (e) =>
                    window.__eraserPickerEvents.push({
                        type: e.type,
                        x: e.clientX,
                        y: e.clientY,
                        pointerType: e.pointerType,
                        pressure: e.pressure,
                        button: e.button,
                        buttons: e.buttons,
                    }),
                { passive: true },
            );
    });
    const box = await page.locator('.workspace canvas').boundingBox();
    return {
        name,
        state,
        context,
        page,
        cdp: await context.newCDPSession(page),
        x: box.x + box.width / 2 - 32,
        y: box.y + box.height / 2 - 32,
    };
}
async function event(t, type, x, y, pointerType = 'mouse', force = 1, button = 'left') {
    await t.cdp.send('Input.dispatchMouseEvent', {
        type,
        x: t.x + x,
        y: t.y + y,
        button,
        buttons: type === 'mouseReleased' ? 0 : button === 'right' ? 2 : 1,
        clickCount: 1,
        pointerType,
        force,
    });
}
async function save(t) {
    const before = await t.page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    await t.page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await t.page.waitForFunction(
        (n) => window.__myPaintPersistenceTest.writes.length > n && !document.querySelector('.busy'),
        before,
    );
    const bytes = Uint8Array.from(
        await t.page.evaluate(() => Array.from(window.__myPaintPersistenceTest.writes.at(-1).bytes)),
    );
    return decodeProject(bytes, desktopLimits);
}
async function controls(t) {
    return {
        dirty: (await t.page.title()).startsWith('* '),
        undo: await t.page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
        redo: await t.page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled(),
    };
}
function pixel(state, x, y) {
    return Array.from(state.layers[state.active].pixels.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
}
function fill(state, color) {
    for (let i = 0; i < state.layers[state.active].pixels.length; i += 4)
        state.layers[state.active].pixels.set(color, i);
}
async function record(t, value) {
    value.name = t.name;
    value.fixtureSha256 = hash(encodeProject(t.state, desktopLimits));
    results.checks.push(t.name);
    value.events = await t.page.evaluate(() => window.__eraserPickerEvents);
    results.cases.push(value);
    await fs.writeFile(path.join(out, 'partial.json'), JSON.stringify(results, null, 2));
    await t.context.close();
}
try {
    for (const tool of ['지우개', '브러시'])
        for (const movedRelease of [false, true])
            for (const pointer of ['mouse', 'pen']) {
                const state = createState(64, 64, [0, 0, 0, 0], desktopLimits);
                if (tool === '지우개') fill(state, [40, 120, 200, 255]);
                const t = await boot(
                    `${tool}-${movedRelease ? 'new' : 'same'}-release-${pointer}`,
                    state,
                    tool,
                    { size: 20, stabilization: 75 },
                );
                await event(t, 'mousePressed', 8.5, 24.5, pointer, 1);
                await event(t, 'mouseMoved', 40.5, 24.5, pointer, 1);
                await event(
                    t,
                    'mouseReleased',
                    movedRelease ? 44.5 : 40.5,
                    24.5,
                    pointer,
                    pointer === 'pen' ? 0 : 1,
                );
                const c = await controls(t),
                    s = await save(t);
                assert.deepEqual(
                    pixel(s, movedRelease ? 44 : 40, 29),
                    tool === '지우개' ? [0, 0, 0, 0] : [255, 0, 255, 255],
                    'Release must finish the last contact radius',
                );
                assert.deepEqual(c, { dirty: true, undo: true, redo: false });
                const key = tool + ':' + movedRelease;
                if (pointer === 'mouse') pressureRecords.set(key, hash(s.layers[0].pixels));
                else {
                    assert.equal(
                        hash(s.layers[0].pixels),
                        pressureRecords.get(key),
                        'Pen release0 must match mouse contact1 over the same path',
                    );
                    const events = await t.page.evaluate(() => window.__eraserPickerEvents);
                    assert(
                        events.some(
                            (e) => e.type === 'pointerup' && e.pointerType === 'pen' && e.pressure === 0,
                        ),
                    );
                    await t.page.getByRole('button', { name: '실행 취소', exact: true }).click();
                    const undo = await save(t);
                    assert.deepEqual(undo.layers[0].pixels, state.layers[0].pixels);
                    assert.equal(
                        await t.page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
                        false,
                    );
                    await t.page.getByRole('button', { name: '다시 실행', exact: true }).click();
                    const redo = await save(t);
                    assert.deepEqual(redo.layers[0].pixels, s.layers[0].pixels);
                }
                await record(t, {
                    controls: c,
                    pixelsSHA256: hash(s.layers[0].pixels),
                    endpoint: pixel(s, movedRelease ? 44 : 40, 29),
                    alphaRegion: Array.from(
                        { length: 16 * 24 },
                        (_, i) =>
                            s.layers[0].pixels[((18 + Math.floor(i / 24)) * 64 + 28 + (i % 24)) * 4 + 3],
                    ),
                });
            }
    for (const tool of ['지우개', '브러시']) {
        const state = createState(64, 64, [0, 0, 0, 0], desktopLimits);
        if (tool === '지우개') fill(state, [40, 120, 200, 255]);
        const t = await boot(`${tool}-real-move-pressure-zero`, state, tool, { size: 20, stabilization: 75 });
        await event(t, 'mousePressed', 8.5, 24.5, 'pen', 1);
        await event(t, 'mouseMoved', 40.5, 24.5, 'pen', 0);
        await event(t, 'mouseReleased', 40.5, 24.5, 'pen', 0);
        const painted = await save(t),
            expected = tool === '지우개' ? [40, 120, 200, 255] : [0, 0, 0, 0],
            events = await t.page.evaluate(() => window.__eraserPickerEvents);
        assert(
            events.some((e) => e.type === 'pointermove' && e.pointerType === 'pen' && e.pressure === 0),
            'Real pressure-zero move must reach the application',
        );
        assert.deepEqual(pixel(painted, 40, 29), expected, 'Pressure-zero movement must still reduce radius');
        await record(t, { endpoint: pixel(painted, 40, 29), pressureZeroMoveObserved: true });
    }
    for (const kind of [
        'transparent-full',
        'transparent-half',
        'multi-white',
        'hidden-rgb-only',
        'outside',
    ]) {
        const state = createState(
            64,
            64,
            kind === 'multi-white' ? [255, 255, 255, 255] : [0, 0, 0, 0],
            desktopLimits,
        );
        fill(state, [40, 120, 200, 255]);
        if (kind === 'multi-white') {
            state.layers.push({ name: 'active', visible: true, pixels: state.layers[0].pixels.slice() });
            state.active = 1;
        }
        if (kind === 'hidden-rgb-only') {
            state.layers[0].pixels.fill(0);
            state.layers[0].pixels.set([193, 71, 117, 0], (12 * 64 + 12) * 4);
        }
        const t = await boot('eraser-' + kind, state, '지우개', {
            opacity: kind === 'transparent-half' ? 50 : 100,
        });
        if (kind === 'hidden-rgb-only') {
            await t.page.getByRole('button', { name: '연필', exact: true }).click();
            await event(t, 'mousePressed', 55.5, 55.5);
            await event(t, 'mouseReleased', 55.5, 55.5);
            await t.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            await t.page.getByRole('button', { name: '지우개', exact: true }).click();
        }
        const x = kind === 'outside' ? -12 : 12.5;
        await event(t, 'mousePressed', x, 12.5);
        await event(t, 'mouseReleased', x, 12.5);
        const c = await controls(t),
            s = await save(t);
        let undoExact, redoExact;
        if (c.undo) {
            await t.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            const u = await save(t);
            undoExact = u.layers.every((l, i) => hash(l.pixels) === hash(state.layers[i].pixels));
            await t.page.getByRole('button', { name: '다시 실행', exact: true }).click();
            const r = await save(t);
            redoExact = r.layers.every((l, i) => hash(l.pixels) === hash(s.layers[i].pixels));
        }
        const sourceExact = s.layers.every((l, i) => hash(l.pixels) === hash(state.layers[i].pixels));
        if (kind === 'hidden-rgb-only' || kind === 'outside') {
            assert.deepEqual(c, { dirty: false, undo: false, redo: kind === 'hidden-rgb-only' });
            assert.equal(sourceExact, true);
            if (kind === 'hidden-rgb-only') {
                await t.page.getByRole('button', { name: '다시 실행', exact: true }).click();
                const redo = await save(t);
                assert.deepEqual(pixel(redo, 55, 55), [255, 0, 255, 255]);
                assert.deepEqual(pixel(redo, 12, 12), [193, 71, 117, 0]);
            }
        } else {
            assert.deepEqual(
                pixel(s, 12, 12),
                kind === 'transparent-half' ? [40, 120, 200, 127] : [0, 0, 0, 0],
            );
            assert.equal(undoExact, true);
            assert.equal(redoExact, true);
            if (kind === 'multi-white') assert.deepEqual(s.layers[0].pixels, state.layers[0].pixels);
        }
        await record(t, {
            controls: c,
            center: pixel(s, 12, 12),
            sourceExact: s.layers.every((l, i) => hash(l.pixels) === hash(state.layers[i].pixels)),
            undoExact,
            redoExact,
        });
    }
    for (const cancel of [false, true]) {
        const state = createState(64, 64, [0, 0, 0, 0], desktopLimits);
        state.layers[0].visible = false;
        state.layers[0].pixels.set([193, 71, 117, 0], (12 * 64 + 12) * 4);
        const t = await boot(
            'eraser-hidden-layer-' + (cancel ? 'cancel' : 'visibility-only'),
            state,
            '지우개',
        );
        if (cancel) {
            await t.cdp.send('Input.dispatchTouchEvent', {
                type: 'touchStart',
                touchPoints: [{ id: 1, x: t.x + 12.5, y: t.y + 12.5 }],
            });
            await t.page.waitForFunction(
                () => document.querySelector('.layer-list input[type=checkbox]').checked,
            );
            await t.cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        } else {
            await event(t, 'mousePressed', 12.5, 12.5);
            await event(t, 'mouseReleased', 12.5, 12.5);
        }
        const c = await controls(t),
            after = await save(t);
        assert.deepEqual(
            after.layers[0].pixels,
            state.layers[0].pixels,
            'Visibility edits cannot erase hidden RGB',
        );
        assert.equal(after.layers[0].visible, !cancel);
        assert.deepEqual(c, { dirty: !cancel, undo: !cancel, redo: false });
        if (!cancel) {
            await t.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            const undo = await save(t);
            assert.equal(undo.layers[0].visible, false);
            assert.deepEqual(undo.layers[0].pixels, state.layers[0].pixels);
            assert.equal(
                await t.page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
                false,
                'One Undo must restore the original hidden layer',
            );
            await t.page.getByRole('button', { name: '다시 실행', exact: true }).click();
            const redo = await save(t);
            assert.equal(redo.layers[0].visible, true);
            assert.deepEqual(redo.layers[0].pixels, state.layers[0].pixels);
        }
        await record(t, { controls: c, visibility: after.layers[0].visible, rawPixelsPreserved: true });
    }
    {
        const state = createState(64, 64, [0, 0, 0, 0], desktopLimits);
        state.layers[0].pixels.set([240, 20, 80, 1], (12 * 64 + 16) * 4);
        state.layers[0].pixels.set([193, 71, 117, 0], (20 * 64 + 48) * 4);
        const t = await boot('eraser-original-alpha1-partial-rounds-zero-then-full', state, '지우개');
        // At distance4.25 with radius4/hardness100, initial coverage128 rounds alpha1 to zero.
        await event(t, 'mousePressed', 12.25, 12.5);
        await event(t, 'mouseMoved', 16.5, 12.5);
        await event(t, 'mouseReleased', 16.5, 12.5);
        const c = await controls(t),
            painted = await save(t);
        assert.deepEqual(
            pixel(painted, 16, 12),
            [0, 0, 0, 0],
            'An original alpha1 pixel must finish erasing after intermediate alpha rounds to zero',
        );
        assert.deepEqual(pixel(painted, 48, 20), [193, 71, 117, 0]);
        assert.equal(c.undo, true);
        await t.page.getByRole('button', { name: '실행 취소', exact: true }).click();
        const undo = await save(t);
        assert.deepEqual(undo.layers[0].pixels, state.layers[0].pixels);
        assert.equal(await t.page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(), false);
        await t.page.getByRole('button', { name: '다시 실행', exact: true }).click();
        const redo = await save(t);
        assert.deepEqual(redo.layers[0].pixels, painted.layers[0].pixels);
        await record(t, { controls: c, center: pixel(painted, 16, 12), undoRedoExact: true });
    }
    for (const kind of ['single', 'multi-hidden', 'transparent', 'lowalpha', 'outside-left', 'outside-right'])
        for (const button of ['left', 'right']) {
            const s = createState(64, 64, [0, 0, 0, 0], desktopLimits),
                at = (12 * 64 + 12) * 4;
            let expected = [255, 0, 255, 255];
            if (kind === 'single') {
                s.layers[0].pixels.set([77, 144, 219, 128], at);
                expected = [77, 144, 219, 128];
            }
            if (kind === 'lowalpha') {
                s.layers[0].pixels.set([240, 20, 80, 1], at);
                expected = [240, 20, 80, 1];
            }
            if (kind === 'transparent') {
                s.layers[0].pixels.set([193, 71, 117, 0], at);
                expected = [0, 0, 0, 0];
            }
            if (kind === 'multi-hidden') {
                s.layers[0].pixels.set([255, 0, 0, 128], at);
                const blue = new Uint8ClampedArray(64 * 64 * 4),
                    hidden = blue.slice();
                blue.set([0, 0, 255, 128], at);
                hidden.set([0, 255, 0, 255], at);
                s.layers.push(
                    { name: 'blue', visible: true, pixels: blue },
                    { name: 'hidden active', visible: false, pixels: hidden },
                );
                s.active = 2;
                expected = [85, 0, 170, 192];
            }
            const t = await boot(`picker-${kind}-${button}`, s, '연필');
            await event(t, 'mousePressed', 55.5, 55.5);
            await event(t, 'mouseReleased', 55.5, 55.5);
            await t.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            const before = await controls(t);
            await t.page.getByRole('button', { name: '스포이트', exact: true }).click();
            const x = kind === 'outside-left' ? -4 : kind === 'outside-right' ? 68 : 12.5;
            await event(t, 'mousePressed', x, 12.5, 'mouse', 1, button);
            await event(t, 'mouseReleased', x, 12.5, 'mouse', 1, button);
            const after = await controls(t);
            const pickedSource = await save(t);
            const sourceExact = pickedSource.layers.every(
                (l, i) => hash(l.pixels) === hash(s.layers[i].pixels),
            );
            await t.page.getByRole('button', { name: '연필', exact: true }).click();
            await event(t, 'mousePressed', 48.5, 48.5);
            await event(t, 'mouseReleased', 48.5, 48.5);
            const drawn = await save(t);
            assert.deepEqual(before, { dirty: false, undo: false, redo: true });
            assert.deepEqual(after, before, 'Picker must preserve clean state and Redo');
            assert.equal(sourceExact, true);
            assert.deepEqual(
                pickedSource.layers.map((l) => l.visible),
                s.layers.map((l) => l.visible),
            );
            // Picking preserves one source RGBA; a later pencil press composites it twice.
            const expectedPencilInk = [...expected];
            expectedPencilInk[3] = Math.round(expected[3] + expected[3] * (1 - expected[3] / 255));
            assert.deepEqual(
                pixel(drawn, 48, 48),
                expectedPencilInk,
                'Picked straight RGBA must be composited by the two pencil press passes',
            );
            await record(t, {
                before,
                after,
                sourceExact,
                ink: pixel(drawn, 48, 48),
                expected,
                expectedPencilInk,
                inkMatches: JSON.stringify(pixel(drawn, 48, 48)) === JSON.stringify(expectedPencilInk),
            });
        }
    {
        const state = createState(64, 64, [0, 0, 0, 0], desktopLimits),
            t = await boot('spray-injected-timer-failure-rollback-and-retry', state, '연필');
        await event(t, 'mousePressed', 55.5, 55.5);
        await event(t, 'mouseReleased', 55.5, 55.5);
        await t.page.getByRole('button', { name: '실행 취소', exact: true }).click();
        await t.page.getByRole('button', { name: '스프레이', exact: true }).click();
        assert.deepEqual(await controls(t), { dirty: false, undo: false, redo: true });
        const beforeCanvas = await t.page.locator('.workspace canvas').evaluate(async (canvas) => {
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data,
                digest = await crypto.subtle.digest('SHA-256', pixels);
            return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('');
        });
        await t.page.evaluate(() => {
            const s = (window.__sprayFailureReview = {
                armed: false,
                faults: 0,
                randomCalls: 0,
                ticks: 0,
                active: new Set(),
                pointer: undefined,
                random: Math.random,
                set: window.setInterval,
                clear: window.clearInterval,
            });
            document
                .querySelector('.workspace canvas')
                .addEventListener('pointerdown', (e) => (s.pointer = e.pointerId), { passive: true });
            // Browser API observation only. The injected failure is not an ordinary user input.
            Math.random = function () {
                s.randomCalls++;
                if (s.armed) {
                    s.armed = false;
                    s.faults++;
                    throw Error('Injected spray timer failure');
                }
                return s.random();
            };
            window.setInterval = function (callback, delay, ...args) {
                const id = s.set.call(
                    window,
                    function (...values) {
                        s.ticks++;
                        return callback(...values);
                    },
                    delay,
                    ...args,
                );
                s.active.add(id);
                return id;
            };
            window.clearInterval = function (id) {
                s.active.delete(id);
                return s.clear.call(window, id);
            };
        });
        let failure;
        try {
            await event(t, 'mousePressed', 12.5, 12.5);
            await t.page.evaluate(() => (window.__sprayFailureReview.armed = true));
            await t.page.waitForFunction(() => window.__sprayFailureReview.faults === 1);
            failure = await t.page.locator('.workspace canvas').evaluate(async (canvas) => {
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const s = window.__sprayFailureReview,
                    pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data,
                    digest = await crypto.subtle.digest('SHA-256', pixels);
                return {
                    faults: s.faults,
                    randomCalls: s.randomCalls,
                    ticks: s.ticks,
                    activeTimers: s.active.size,
                    captured: canvas.hasPointerCapture(s.pointer),
                    status: document.querySelector('.status').textContent,
                    canvasSha256: Array.from(new Uint8Array(digest), (v) =>
                        v.toString(16).padStart(2, '0'),
                    ).join(''),
                };
            });
            results.sprayInjectedFailure = failure;
            assert.deepEqual(results.errors, [], 'Owned timer failure must not escape as pageerror');
            assert.equal(failure.faults, 1);
            assert.equal(failure.activeTimers, 0, 'The spray interval must be cleared after failure');
            assert.equal(failure.captured, false);
            assert(failure.status.includes('Injected spray timer failure'));
            assert.equal(
                failure.canvasSha256,
                beforeCanvas,
                'Provisional spray must disappear from the actual Canvas',
            );
            assert.deepEqual(await controls(t), { dirty: false, undo: false, redo: true });
            await event(t, 'mouseReleased', 12.5, 12.5);
            assert.deepEqual(await controls(t), { dirty: false, undo: false, redo: true });
            const unchanged = await save(t);
            assert.deepEqual(
                unchanged.layers[0].pixels,
                state.layers[0].pixels,
                'A late release cannot commit the failed stroke',
            );
            await t.page.getByRole('button', { name: '다시 실행', exact: true }).click();
            const oldRedo = await save(t);
            assert.deepEqual(
                pixel(oldRedo, 55, 55),
                [255, 0, 255, 255],
                'Failure must retain the previous Redo edit',
            );
            assert.deepEqual(pixel(oldRedo, 12, 12), [0, 0, 0, 0]);
            await t.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            const restored = await save(t);
            assert.deepEqual(restored.layers[0].pixels, state.layers[0].pixels);
            const ticksBeforeRetry = failure.ticks;
            await event(t, 'mousePressed', 32.5, 32.5);
            await t.page.waitForFunction(
                (before) => window.__sprayFailureReview.ticks > before,
                ticksBeforeRetry,
            );
            await event(t, 'mouseReleased', 32.5, 32.5);
            assert.equal(await t.page.evaluate(() => window.__sprayFailureReview.active.size), 0);
            assert.deepEqual(await controls(t), { dirty: true, undo: true, redo: false });
            const painted = await save(t);
            assert.deepEqual(pixel(painted, 32, 32), [255, 0, 255, 255]);
            await t.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            const undo = await save(t);
            assert.deepEqual(undo.layers[0].pixels, state.layers[0].pixels);
            assert.equal(
                await t.page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
                false,
            );
        } finally {
            await t.page.evaluate(() => {
                const s = window.__sprayFailureReview;
                for (const id of s.active) s.clear.call(window, id);
                Math.random = s.random;
                window.setInterval = s.set;
                window.clearInterval = s.clear;
            });
        }
        await record(t, {
            injectedFailure: true,
            failure,
            sourceRestored: true,
            lateReleaseIgnored: true,
            retryUndoExact: true,
        });
    }
    for (const spec of [
        { name: 'pencil-Qt-slope-7-1-literal', mode: 'slope' },
        {
            name: 'pencil-ignores-size87-opacity1-hardness0-stabilization75',
            mode: 'slope',
            settings: { size: 87, opacity: 1, hardness: 0, stabilization: 75 },
        },
        { name: 'pencil-alpha128-click-is-two-passes192', mode: 'click', alpha: true },
        { name: 'pencil-alpha128-same-floor-real-move-is-four-passes240', mode: 'same-floor', alpha: true },
        { name: 'pencil-alpha128-new-release-adds-one-segment', mode: 'release', alpha: true },
        { name: 'pencil-right-button-uses-secondary', mode: 'slope', right: true },
        { name: 'pencil-pen-pressure0-including-release-keeps-width1', mode: 'pen' },
        { name: 'pencil-middle-chord-owner-releases-first', mode: 'chord', alpha: true, ownerFirst: true },
        { name: 'pencil-middle-chord-owner-releases-last', mode: 'chord', alpha: true, ownerFirst: false },
        { name: 'pencil-hidden-cancel-restores-raw-source-visibility-and-Redo', mode: 'cancel' },
    ]) {
        const state = createState(64, 64, [0, 0, 0, 0], desktopLimits),
            ink = spec.alpha ? [80, 144, 220, 128] : spec.right ? [255, 0, 0, 255] : [255, 0, 255, 255];
        if (spec.alpha) state.layers[0].pixels.set(ink, (2 * 64 + 2) * 4);
        if (spec.mode === 'cancel') {
            state.layers[0].visible = false;
            state.layers[0].pixels.set([193, 71, 117, 0], (2 * 64 + 40) * 4);
        }
        const t = await boot(spec.name, state, '연필', spec.settings),
            expected = state.layers[0].pixels.slice();
        if (spec.alpha) {
            await t.page.getByRole('button', { name: '스포이트', exact: true }).click();
            await event(t, 'mousePressed', 2.5, 2.5);
            await event(t, 'mouseReleased', 2.5, 2.5);
            await t.page.getByRole('button', { name: '연필', exact: true }).click();
            assert.deepEqual(await controls(t), { dirty: false, undo: false, redo: false });
        }
        if (spec.mode === 'cancel') {
            await event(t, 'mousePressed', 55.5, 55.5);
            await event(t, 'mouseReleased', 55.5, 55.5);
            await t.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await controls(t), { dirty: false, undo: false, redo: true });
        }
        if (spec.mode === 'chord') {
            const sequence = [
                ['mousePressed', 'left', 1],
                ['mousePressed', 'middle', 5],
                ...(spec.ownerFirst
                    ? [
                          ['mouseReleased', 'left', 4],
                          ['mouseReleased', 'middle', 0],
                      ]
                    : [
                          ['mouseReleased', 'middle', 1],
                          ['mouseReleased', 'left', 0],
                      ]),
            ];
            for (const [type, button, buttons] of sequence)
                await t.cdp.send('Input.dispatchMouseEvent', {
                    type,
                    button,
                    buttons,
                    x: t.x + 8.25,
                    y: t.y + 8.25,
                    clickCount: 1,
                });
            expected.set([80, 144, 220, 192], (8 * 64 + 8) * 4);
        } else if (spec.mode === 'click' || spec.mode === 'same-floor') {
            await event(t, 'mousePressed', 8.125, 8.125);
            if (spec.mode === 'same-floor') await event(t, 'mouseMoved', 8.875, 8.875);
            await event(t, 'mouseReleased', 8.875, 8.875);
            // Two press passes, plus two for an actual move within the same floored document pixel.
            expected.set([80, 144, 220, spec.mode === 'same-floor' ? 240 : 192], (8 * 64 + 8) * 4);
        } else if (spec.mode === 'release') {
            await event(t, 'mousePressed', 4.25, 8.25);
            await event(t, 'mouseReleased', 18.25, 8.25);
            // Independent straight-RGBA literals: press2, changed-endpoint release1; no release dot.
            expected.set([80, 144, 220, 224], (8 * 64 + 4) * 4);
            for (let x = 5; x <= 18; x++) expected.set([80, 144, 220, 128], (8 * 64 + x) * 4);
        } else {
            const pointer = spec.mode === 'pen' ? 'pen' : 'mouse',
                force = pointer === 'pen' ? 0 : 1,
                button = spec.right ? 'right' : 'left';
            await event(t, 'mousePressed', 8.25, 8.25, pointer, force, button);
            await event(t, 'mouseMoved', 15.25, 9.25, pointer, force, button);
            if (spec.mode === 'cancel') await t.page.keyboard.press('Escape');
            await event(t, 'mouseReleased', 15.25, 9.25, pointer, force, button);
            if (spec.mode !== 'cancel') {
                // Actual Qt slope-7-1: row8 columns8..14, row9 column15. Nearest DDA differs at6 pixels.
                for (let x = 8; x <= 14; x++) expected.set(ink, (8 * 64 + x) * 4);
                expected.set(ink, (9 * 64 + 15) * 4);
            }
        }
        const status = await controls(t),
            actual = await save(t),
            events = await t.page.evaluate(() => window.__eraserPickerEvents);
        assert.deepEqual(actual.layers[0].pixels, expected, spec.name + ': every authoritative RGBA byte');
        assert.equal(actual.layers[0].visible, state.layers[0].visible);
        assert.deepEqual(status, {
            dirty: spec.mode !== 'cancel',
            undo: spec.mode !== 'cancel',
            redo: spec.mode === 'cancel',
        });
        if (spec.mode === 'same-floor')
            assert(
                events.some(
                    (e) =>
                        e.type === 'pointermove' &&
                        Math.floor(e.x - t.x) === 8 &&
                        Math.floor(e.y - t.y) === 8,
                ),
                'A real CDP move inside one document pixel must reach the application',
            );
        if (spec.mode === 'pen')
            for (const type of ['pointerdown', 'pointermove', 'pointerup'])
                assert(events.some((e) => e.type === type && e.pointerType === 'pen' && e.pressure === 0));
        if (spec.mode === 'chord')
            assert(
                events.some((e) => e.type === 'pointermove' && e.button === 1),
                'The middle-button transition must reach the application without adding ink',
            );
        if (spec.mode === 'cancel') {
            await t.page.getByRole('button', { name: '다시 실행', exact: true }).click();
            const redo = await save(t),
                seeded = state.layers[0].pixels.slice();
            seeded.set([255, 0, 255, 255], (55 * 64 + 55) * 4);
            assert.deepEqual(redo.layers[0].pixels, seeded);
            assert.equal(redo.layers[0].visible, true);
            await t.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            const restored = await save(t);
            assert.deepEqual(restored.layers[0].pixels, state.layers[0].pixels);
            assert.equal(restored.layers[0].visible, false);
        } else {
            await t.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            const undo = await save(t);
            assert.deepEqual(undo.layers[0].pixels, state.layers[0].pixels);
            assert.equal(undo.layers[0].visible, state.layers[0].visible);
            assert.equal(
                await t.page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
                false,
            );
            await t.page.getByRole('button', { name: '다시 실행', exact: true }).click();
            const redo = await save(t);
            assert.deepEqual(redo.layers[0].pixels, expected);
            assert.equal(redo.layers[0].visible, actual.layers[0].visible);
        }
        await record(t, {
            controls: status,
            geometryOracle: ['slope', 'pen', 'cancel'].includes(spec.mode)
                ? 'Actual Qt Pencil slope-7-1 literal rows; width1 regardless of options'
                : 'Qt event-count contract with independent exact straight-RGBA literals',
            sourceSHA256: hash(state.layers[0].pixels),
            actualSHA256: hash(actual.layers[0].pixels),
            expectedSHA256: hash(expected),
            undoRedoExact: true,
            cancellationPreservesRedo: spec.mode === 'cancel',
        });
    }
    assert.deepEqual(results.errors, [], 'Unexpected public UI page errors');
} catch (error) {
    results.error = String(error.stack || error);
    results.failures.push(results.error);
    process.exitCode = 1;
} finally {
    await browser.close();
    await fs.writeFile(output, JSON.stringify(results, null, 2));
    console.log(
        JSON.stringify({ cases: results.cases.length, errors: results.errors, error: results.error }),
    );
}
