import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = path.resolve(
        process.env.PAINT_SQUARE_UI_OUTPUT || '../build-web-work/task-planning/square-contract',
    ),
    hash = (b) => crypto.createHash('sha256').update(b).digest('hex'),
    results = {
        url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
        cases: [],
        failures: [],
        layouts: [],
        errors: [],
        assets: [],
        scope: 'Public square-tool contract verification. Actual Chromium CDP gestures; native-harness only transports project input/output. Qt literal geometry/event coverage is separate from exact independent straightRGBA policy literals. No private Studio/doc hooks or physical device claim.',
    };
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
let expectedBrowserClose = false;
browser.on(
    'disconnected',
    () => (results.browserDisconnect = { expected: expectedBrowserClose, at: new Date().toISOString() }),
);
try {
    const diagnostics = await browser.newBrowserCDPSession();
    results.browserProcesses = await diagnostics.send('SystemInfo.getProcessInfo');
    await diagnostics.detach();
} catch (e) {
    results.browserDiagnosticError = String(e);
}
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
        for (const type of ['pointerdown', 'pointermove', 'pointerup'])
            canvas.addEventListener(
                type,
                (e) =>
                    window.__eraserPickerEvents.push({
                        type: e.type,
                        x: e.clientX,
                        y: e.clientY,
                        pointerType: e.pointerType,
                        pressure: e.pressure,
                        pointerId: e.pointerId,
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
        x: box.x + box.width / 2 - state.width / 2,
        y: box.y + box.height / 2 - state.height / 2,
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
function fill(state, color) {
    for (let i = 0; i < state.layers[state.active].pixels.length; i += 4)
        state.layers[state.active].pixels.set(color, i);
}
const oracle = JSON.parse(
    await fs.readFile(new URL('./fixtures/square-ui-qt.json', import.meta.url), 'utf8'),
);
results.oracleSha256 = hash(await fs.readFile(new URL('./fixtures/square-ui-qt.json', import.meta.url)));
results.testSha256 = hash(await fs.readFile(new URL(import.meta.url)));
try {
    for (const c of oracle.cases) {
        let t;
        const result = {
            name: c.name,
            qtChangedPixels: c.changed.length,
            policy: 'Qt mask/event count; exact straightRGBA literal colors',
        };
        try {
            const state = createState(64, 64, [0, 0, 255, c.alpha], desktopLimits);
            fill(state, [255, 0, 0, 255]);
            state.layers[0].pixels.set([77, 144, 219, c.alpha], (2 * 64 + 2) * 4);
            state.layers[0].pixels.set([0, 0, 255, c.alpha], (2 * 64 + 3) * 4);
            state.layers[0].pixels.set([193, 71, 117, 0], (2 * 64 + 40) * 4);
            t = await boot(c.name, state, c.tool === 'brush' ? '브러시' : '지우개', {
                size: c.size,
                opacity: 10,
                hardness: 0,
                stabilization: 75,
            });
            await t.page.getByRole('button', { name: '스포이트', exact: true }).click();
            await event(t, 'mousePressed', 3.5, 2.5);
            await event(t, 'mouseReleased', 3.5, 2.5);
            await t.page.getByRole('button', { name: '전경색 보조색 바꾸기', exact: true }).click();
            await event(t, 'mousePressed', 2.5, 2.5);
            await event(t, 'mouseReleased', 2.5, 2.5);
            if (c.hidden) {
                state.layers[0].visible = false;
                await t.page.evaluate(
                    (bytes) =>
                        window.__myPaintPersistenceTest.queueOpen('hidden.rpaint', Uint8Array.from(bytes)),
                    Array.from(encodeProject(state, desktopLimits)),
                );
                await t.page.getByRole('button', { name: '파일 열기', exact: true }).click();
                await t.page.waitForFunction(
                    () =>
                        window.__myPaintPersistenceTest.generation === 3 && !document.querySelector('.busy'),
                );
            }
            await t.page
                .getByRole('button', { name: c.tool === 'brush' ? '브러시' : '지우개', exact: true })
                .click();
            await t.page.locator('#square').check();
            for (const id of ['opacity', 'hardness', 'stabilization', 'pressure'])
                assert.equal(await t.page.locator('#' + id).isDisabled(), true);
            assert.equal(await t.page.locator('#size').isDisabled(), false);
            assert.equal(await t.page.locator('.square-hint').isVisible(), true);
            const button = c.right ? 'right' : 'left';
            await event(t, 'mousePressed', ...c.from, 'mouse', 1, button);
            if (c.kind !== 'click') await event(t, 'mouseMoved', ...c.to, 'mouse', 1, button);
            if (c.kind === 'cancel') await t.page.keyboard.press('Escape');
            await event(t, 'mouseReleased', ...c.release, 'mouse', 1, button);
            const control = await controls(t),
                actual = await save(t),
                expected = state.layers[0].pixels.slice();
            for (const [x, y, rgba] of c.straightPolicyExpectedChanges) expected.set(rgba, (y * 64 + x) * 4);
            const first = [];
            let mismatchedChannels = 0;
            for (let i = 0; i < expected.length; i++)
                if (expected[i] !== actual.layers[0].pixels[i]) {
                    mismatchedChannels++;
                    if (first.length < 12)
                        first.push({
                            x: Math.floor(i / 4) % 64,
                            y: Math.floor(i / 256),
                            channel: i % 4,
                            actual: actual.layers[0].pixels[i],
                            expected: expected[i],
                        });
                }
            Object.assign(result, {
                mismatchedChannels,
                first,
                control,
                actualPixelsSha256: hash(actual.layers[0].pixels),
                expectedPixelsSha256: hash(expected),
                visible: actual.layers[0].visible,
                events: await t.page.evaluate(() => window.__eraserPickerEvents),
            });
            assert.equal(mismatchedChannels, 0, 'Square event output differs from exact straightRGBA oracle');
            assert.equal(actual.layers[0].visible, c.visible);
            assert.deepEqual(control, { dirty: c.dirty, undo: c.undo, redo: false });
            if (c.undo) {
                await t.page.getByRole('button', { name: '실행 취소', exact: true }).click();
                const u = await save(t);
                assert.deepEqual(u.layers[0].pixels, state.layers[0].pixels);
                assert.equal(u.layers[0].visible, state.layers[0].visible);
                assert.equal(
                    await t.page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
                    false,
                    'One Undo restores initial square state',
                );
                await t.page.getByRole('button', { name: '다시 실행', exact: true }).click();
                const r = await save(t);
                assert.deepEqual(r.layers[0].pixels, actual.layers[0].pixels);
                assert.equal(r.layers[0].visible, actual.layers[0].visible);
                result.undoRedoExact = true;
            }
        } catch (error) {
            result.failure = String(error.stack || error);
            results.failures.push({ name: c.name, error: result.failure });
        } finally {
            if (t) await t.context.close();
        }
        if (results.browserDisconnect && !results.browserDisconnect.expected)
            throw Error('Unexpected browser disconnect: ' + JSON.stringify(results.browserDisconnect));
        results.cases.push(result);
        await fs.writeFile(path.join(out, 'ui-partial.json'), JSON.stringify(results, null, 2));
    }
    for (const ownerFirst of [true, false]) {
        let target;
        const record = { name: 'Square chord ignores middle transitions; ownerFirst=' + ownerFirst };
        try {
            const state = createState(64, 64, [255, 0, 0, 255], desktopLimits);
            state.layers[0].pixels.set([77, 144, 219, 128], (2 * 64 + 2) * 4);
            target = await boot(record.name, state, '브러시', { size: 4 });
            await target.page.getByRole('button', { name: '스포이트', exact: true }).click();
            await event(target, 'mousePressed', 2.5, 2.5);
            await event(target, 'mouseReleased', 2.5, 2.5);
            await target.page.getByRole('button', { name: '브러시', exact: true }).click();
            await target.page.locator('#square').check();
            const sequence = [
                ['mousePressed', 'left', 1],
                ['mousePressed', 'middle', 5],
                ...(ownerFirst
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
                await target.cdp.send('Input.dispatchMouseEvent', {
                    type,
                    button,
                    buttons,
                    x: target.x + 8,
                    y: target.y + 8,
                    clickCount: 1,
                });
            const actual = await save(target),
                expected = state.layers[0].pixels.slice();
            for (let y = 6; y < 10; y++)
                for (let x = 6; x < 10; x++) expected.set([121, 108, 165, 255], (y * 64 + x) * 4);
            assert.deepEqual(actual.layers[0].pixels, expected);
            await target.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual((await save(target)).layers[0].pixels, state.layers[0].pixels);
            await target.page.getByRole('button', { name: '다시 실행', exact: true }).click();
            assert.deepEqual((await save(target)).layers[0].pixels, expected);
            record.undoRedoExact = true;
            record.rgbaSHA256 = hash(expected);
        } catch (error) {
            record.failure = String(error.stack || error);
            results.failures.push({ name: record.name, error: record.failure });
        } finally {
            if (target) await target.context.close();
        }
        results.cases.push(record);
    }
    const wide = JSON.parse(
        await fs.readFile(new URL('./fixtures/square-wide-qt.json', import.meta.url), 'utf8'),
    );
    for (const name of ['inside-size-32', 'seed-9a73-27']) {
        const c = wide.cases.find((entry) => entry.name === name);
        assert(c, 'Missing held-out wide fixture ' + name);
        let target;
        const record = { name: 'Wide public gesture ' + name };
        try {
            const color = [17, 91, 203, 128],
                state = createState(c.width, c.height, color, desktopLimits);
            fill(state, [210, 80, 30, 255]);
            const original = state.layers[0].pixels.slice(),
                expected = original.slice();
            for (const [y, left, right] of c.expected.find((entry) => entry.alpha === 128).spans)
                for (let x = left; x < right; x++) expected.set(color, (y * c.width + x) * 4);
            target = await boot(record.name, state, '지우개', { size: c.size });
            await target.page.locator('#square').check();
            await event(target, 'mousePressed', ...c.from);
            await event(target, 'mouseMoved', ...c.to);
            await event(target, 'mouseReleased', ...c.to);
            const actual = await save(target);
            assert.deepEqual(actual.layers[0].pixels, expected);
            await target.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual((await save(target)).layers[0].pixels, original);
            await target.page.getByRole('button', { name: '다시 실행', exact: true }).click();
            assert.deepEqual((await save(target)).layers[0].pixels, expected);
            record.rgbaSHA256 = hash(expected);
            record.undoRedoExact = true;
        } catch (error) {
            record.failure = String(error.stack || error);
            results.failures.push({ name: record.name, error: record.failure });
        } finally {
            if (target) await target.context.close();
        }
        results.cases.push(record);
    }
    const state = createState(64, 64, [0, 0, 0, 0], desktopLimits),
        t = await boot('square-hint-layout', state, '브러시', {
            size: 4,
            opacity: 10,
            hardness: 0,
            stabilization: 75,
        });
    try {
        await t.page.locator('#square').check();
        for (const id of ['opacity', 'hardness', 'stabilization', 'pressure'])
            assert.equal(await t.page.locator('#' + id).isDisabled(), true);
        assert.equal(await t.page.locator('.square-hint').isVisible(), true);
        const stored = await t.page.evaluate(() =>
            Object.fromEntries(
                ['size', 'opacity', 'hardness', 'stabilization', 'pressure'].map((id) => {
                    const n = document.getElementById(id);
                    return [id, id === 'pressure' ? n.checked : n.value];
                }),
            ),
        );
        assert.deepEqual(stored, {
            size: '4',
            opacity: '10',
            hardness: '0',
            stabilization: '75',
            pressure: true,
        });
        await t.page.locator('#square').uncheck();
        for (const id of ['opacity', 'hardness', 'stabilization', 'pressure'])
            assert.equal(await t.page.locator('#' + id).isDisabled(), false);
        assert.equal(await t.page.locator('.square-hint').isVisible(), false);
        assert.deepEqual(
            await t.page.evaluate(() =>
                Object.fromEntries(
                    ['size', 'opacity', 'hardness', 'stabilization', 'pressure'].map((id) => {
                        const n = document.getElementById(id);
                        return [id, id === 'pressure' ? n.checked : n.value];
                    }),
                ),
            ),
            stored,
        );
        results.roundOptionsRestored = true;
        await t.page.locator('#square').check();
        for (const skin of ['Studio Dark', 'Classic 98']) {
            if (skin === 'Classic 98') {
                await t.page.getByRole('button', { name: '환경설정', exact: true }).click();
                await t.page.getByLabel('스킨', { exact: true }).selectOption(skin);
                await t.page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
            }
            await t.page.locator('.square-hint').scrollIntoViewIfNeeded();
            const layout = await t.page.locator('.square-hint').evaluate((n) => ({
                text: n.textContent,
                rect: n.getBoundingClientRect().toJSON(),
                clientWidth: n.clientWidth,
                scrollWidth: n.scrollWidth,
                color: getComputedStyle(n).color,
                fontSize: getComputedStyle(n).fontSize,
                documentWidth: document.documentElement.scrollWidth,
                viewportWidth: innerWidth,
            }));
            assert(layout.rect.width > 0 && layout.rect.height > 0);
            assert(layout.scrollWidth <= layout.clientWidth);
            assert(layout.documentWidth <= layout.viewportWidth);
            results.layouts.push({ skin, width: 1400, ...layout });
            await t.page.screenshot({
                path: path.join(out, 'desktop-' + (skin === 'Studio Dark' ? 'studio' : 'classic') + '.png'),
            });
        }
        await t.page.setViewportSize({ width: 390, height: 844 });
        await t.page.getByRole('button', { name: '색상과 브러시', exact: true }).click();
        await t.page.locator('.square-hint').scrollIntoViewIfNeeded();
        const layout = await t.page.locator('.square-hint').evaluate((n) => ({
            text: n.textContent,
            rect: n.getBoundingClientRect().toJSON(),
            clientWidth: n.clientWidth,
            scrollWidth: n.scrollWidth,
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: innerWidth,
            viewportHeight: innerHeight,
        }));
        assert(layout.scrollWidth <= layout.clientWidth);
        assert(layout.documentWidth <= 390);
        assert(
            layout.rect.left >= 0 &&
                layout.rect.right <= 390 &&
                layout.rect.top >= 0 &&
                layout.rect.bottom <= 844,
        );
        results.layouts.push({ skin: 'Classic 98', width: 390, ...layout });
        await t.page.screenshot({ path: path.join(out, 'mobile-classic.png') });
    } finally {
        await t.context.close();
    }
    results.ok = !results.errors.length && !results.failures.length;
} catch (error) {
    results.error = String(error.stack || error);
    results.ok = false;
} finally {
    expectedBrowserClose = true;
    await browser.close();
    await fs.writeFile(path.join(out, 'ui-results.json'), JSON.stringify(results, null, 2));
    console.log(
        JSON.stringify({
            ok: results.ok,
            cases: results.cases.length,
            failures: results.failures.length,
            errors: results.errors,
            layouts: results.layouts.length,
            error: results.error,
        }),
    );
    if (!results.ok) process.exitCode = 1;
}
