import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject, decodePng } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';

const output =
        process.env.PAINT_SHAPE_COLOR_OUTPUT ||
        '../build-web-work/task-planning/shape-color-contract/result.json',
    { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
await fs.mkdir(path.dirname(output), { recursive: true });
const original = createState(64, 64, [0, 0, 0, 0], desktopLimits),
    red = [255, 0, 0, 128],
    blue = [0, 0, 255, 255],
    transparent = [0, 0, 0, 0];
original.layers[0].pixels.set(red, (2 * 64 + 2) * 4);
const hidden = [193, 71, 117, 0];
original.layers[0].pixels.set(hidden, (20 * 64 + 28) * 4);
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
        fixtureSha256: createHash('sha256').update(encodeProject(original, desktopLimits)).digest('hex'),
        checks: [],
        cases: [],
        errors: [],
        failures: [],
        assets: [],
        scope: 'Public Chromium UI and picker-selected alpha128 color. Literal full-coverage/interior RGBA expectations avoid antialiased boundaries. Project/PNG saves use modeled native IPC; One mouse cancellation uses a synthetic public PointerEvent after a real CDP press; touch takeover uses CDP touch events. No operating-system persistence or exact Qt/Canvas edge-raster equivalence claim.',
    };
async function boot(tool, fill = false, outline = true) {
    const context = await browser.newContext({
            viewport: { width: 1400, height: 1000 },
            deviceScaleFactor: 1,
        }),
        page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => results.errors.push(error.message));
    page.on('request', (request) => {
        if (/\.js(?:[?#]|$)/.test(request.url()) && !results.assets.includes(request.url()))
            results.assets.push(request.url());
    });
    await page.addInitScript(installNativeHarness, {});
    await page.goto(results.url);
    await page.waitForSelector('canvas[data-ready=true]');
    await page.waitForFunction(
        () => window.__myPaintPersistenceTest.generation === 1 && !document.querySelector('dialog[open]'),
    );
    await page.evaluate(
        (bytes) => window.__myPaintPersistenceTest.queueOpen('transparent.rpaint', Uint8Array.from(bytes)),
        Array.from(encodeProject(original, desktopLimits)),
    );
    await page.getByRole('button', { name: '파일 열기', exact: true }).click();
    await page.waitForFunction(
        () => window.__myPaintPersistenceTest.generation === 2 && !document.querySelector('.busy'),
    );
    await page.locator('#secondary').evaluate((input) => {
        input.value = '#0000ff';
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#size').evaluate((input) => {
        input.value = '4';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.locator('#opacity').evaluate((input) => {
        input.value = '10';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.locator('#fill-shape').setChecked(fill);
    await page.locator('#outline-shape').setChecked(outline);
    const box = await page.locator('.workspace canvas').boundingBox(),
        target = {
            context,
            page,
            cdp: await context.newCDPSession(page),
            x: box.x + box.width / 2 - 32,
            y: box.y + box.height / 2 - 32,
        };
    await page.getByRole('button', { name: '스포이트', exact: true }).click();
    await mouse(target, 'mousePressed', 2, 2, 'left', 1);
    await mouse(target, 'mouseReleased', 2, 2, 'left', 0);
    await page.getByRole('button', { name: tool, exact: true }).click();
    return target;
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
async function click(target, x, y, button = 'left') {
    await mouse(target, 'mousePressed', x, y, button, button === 'right' ? 2 : 1);
    await mouse(target, 'mouseReleased', x, y, button, 0);
}
async function drag(target, from, to, button = 'left') {
    const mask = button === 'right' ? 2 : 1;
    await mouse(target, 'mousePressed', ...from, button, mask);
    await mouse(target, 'mouseMoved', ...to, button, mask);
    await mouse(target, 'mouseReleased', ...to, button, 0);
}
async function save(target, png = false) {
    const count = await target.page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    if (png) {
        await target.page.getByRole('button', { name: '이미지 내보내기', exact: true }).click();
        await target.page.getByLabel('형식', { exact: true }).selectOption('png');
        await target.page.getByRole('dialog').getByRole('button', { name: '내보내기', exact: true }).click();
    } else
        await target.page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await target.page.waitForFunction(
        (count) => window.__myPaintPersistenceTest.writes.length > count && !document.querySelector('.busy'),
        count,
    );
    const bytes = Uint8Array.from(
        await target.page.evaluate(() => Array.from(window.__myPaintPersistenceTest.writes.at(-1).bytes)),
    );
    return png ? decodePng(bytes, desktopLimits) : decodeProject(bytes, desktopLimits);
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
async function committed(target, name, samples, canvasSample) {
    const state = await save(target),
        png = await save(target, true),
        observations = [];
    for (const [x, y, expected, expectedPng = expected] of [...samples, [2, 2, red], [50, 50, transparent]]) {
        const offset = (y * 64 + x) * 4;
        observations.push({
            x,
            y,
            expected,
            expectedPng,
            project: Array.from(state.layers[0].pixels.slice(offset, offset + 4)),
            png: Array.from(png.pixels.slice(offset, offset + 4)),
        });
    }
    results.cases.push({
        name,
        observations,
        actualLayerSha256: createHash('sha256').update(state.layers[0].pixels).digest('hex'),
    });
    for (const observation of observations) {
        assert.deepEqual(observation.project, observation.expected, name + ' project RGBA');
        assert.deepEqual(observation.png, observation.expectedPng, name + ' PNG RGBA');
    }
    if (canvasSample)
        assert.deepEqual(await canvasPixel(target, canvasSample[0], canvasSample[1]), canvasSample[2]);
    await target.page.getByRole('button', { name: '실행 취소', exact: true }).click();
    assert.deepEqual(await save(target), original, 'One Undo must restore the exact original document');
    await target.page.getByRole('button', { name: '다시 실행', exact: true }).click();
    assert.deepEqual(await save(target), state, 'One Redo must restore every committed shape pixel');
}
try {
    for (const button of ['left', 'right']) {
        const name = `Line ${button} preserves picker alpha and stroke direction`,
            target = await boot('직선', true, false);
        try {
            await drag(target, [12, 16], [44, 16], button);
            await committed(
                target,
                name,
                [
                    [28, 16, button === 'left' ? red : blue],
                    [28, 20, hidden, transparent],
                ],
                [28, 16, button === 'left' ? [255, 127, 127, 255] : blue],
            );
            results.checks.push(name);
        } catch (error) {
            results.failures.push({ name, error: String(error.stack || error) });
        } finally {
            await target.context.close();
        }
    }
    for (const [tool, fill, outline] of [
        ['사각형', false, true],
        ['사각형', true, false],
        ['둥근 사각형', true, true],
        ['타원', true, true],
    ]) {
        for (const button of ['left', 'right']) {
            const name = `${tool} ${button} fill=${fill} outline=${outline} keeps RGBA and direction`,
                target = await boot(tool, fill, outline);
            try {
                await drag(target, [12, 12], [44, 44], button);
                const stroke = button === 'left' ? red : blue,
                    interior = button === 'left' ? blue : red,
                    samples = [
                        [28, 11, outline ? stroke : transparent],
                        [28, 28, fill ? interior : transparent],
                    ];
                if (!fill) samples.push([28, 20, hidden, transparent]);
                // The rounded rectangle has a straight side at y28. Its inside
                // stroke is red 128 over opaque blue, not red 128 over transparency.
                if (tool === '둥근 사각형')
                    samples.push([12, 28, button === 'left' ? [128, 0, 127, 255] : blue]);
                await committed(target, name, samples, [
                    28,
                    28,
                    fill ? (button === 'left' ? blue : [238, 112, 114, 255]) : [221, 224, 229, 255],
                ]);
                results.checks.push(name);
            } catch (error) {
                results.failures.push({ name, error: String(error.stack || error) });
            } finally {
                await target.context.close();
            }
        }
    }
    for (const buttons of [
        ['right', 'left', 'right'],
        ['left', 'right', 'left'],
    ]) {
        const name = `Curve mixed ${buttons.join('-')} tracks each accepted press and commits once`,
            target = await boot('곡선', true, false);
        try {
            await drag(target, [12, 32], [44, 32], buttons[0]);
            let png = await save(target, true),
                offset = (32 * 64 + 28) * 4;
            let actual = Array.from(png.pixels.slice(offset, offset + 4));
            results.cases.push({
                name: name + ' endpoint pending',
                expected: buttons[0] === 'left' ? red : blue,
                png: actual,
            });
            assert.deepEqual(actual, buttons[0] === 'left' ? red : blue);
            await click(target, 20, 8, buttons[1]);
            png = await save(target, true);
            offset = (32 * 64 + 12) * 4;
            actual = Array.from(png.pixels.slice(offset, offset + 4));
            results.cases.push({
                name: name + ' first control pending',
                expected: buttons[1] === 'left' ? red : blue,
                png: actual,
            });
            assert.deepEqual(actual, buttons[1] === 'left' ? red : blue);
            await click(target, 36, 8, buttons[2]);
            await committed(target, name, [
                [28, 14, buttons[2] === 'left' ? red : blue],
                [28, 24, transparent],
                [28, 20, hidden, transparent],
            ]);
            results.checks.push(name);
        } catch (error) {
            results.failures.push({ name, error: String(error.stack || error) });
        } finally {
            await target.context.close();
        }
    }
    for (const cancel of [false, true]) {
        const name = cancel
                ? 'Curve pending PNG export preserves latest right color and Esc cancels'
                : 'Curve pending project save uses latest left color and one Undo/Redo',
            target = await boot('곡선', true, false),
            latest = cancel ? 'right' : 'left';
        try {
            await drag(target, [12, 16], [44, 16], cancel ? 'left' : 'right');
            await click(target, 20, 16, latest);
            if (cancel) {
                const png = await save(target, true),
                    offset = (16 * 64 + 28) * 4,
                    actual = Array.from(png.pixels.slice(offset, offset + 4));
                results.cases.push({ name, expected: blue, png: actual });
                assert.deepEqual(actual, blue);
                await target.page.keyboard.press('Escape');
                assert.deepEqual(await save(target), original);
                assert.equal(
                    await target.page.getByRole('button', { name: '실행 취소', exact: true }).isDisabled(),
                    true,
                );
                assert.deepEqual(await canvasPixel(target, 28, 16), [255, 255, 255, 255]);
            } else
                await committed(
                    target,
                    name,
                    [
                        [28, 16, red],
                        [28, 20, hidden, transparent],
                    ],
                    [28, 16, [255, 127, 127, 255]],
                );
            results.checks.push(name);
        } catch (error) {
            results.failures.push({ name, error: String(error.stack || error) });
        } finally {
            await target.context.close();
        }
    }
    for (const buttons of [
        ['right', 'left', 'right', 'left'],
        ['left', 'right', 'left', 'right'],
    ]) {
        const name = `Polygon mixed ${buttons.join('-')} uses latest vertex color and one Undo/Redo`,
            target = await boot('다각형', true, true);
        try {
            const vertices = [
                [12, 12],
                [44, 12],
                [44, 44],
                [12, 44],
            ];
            for (let i = 0; i < vertices.length; i++) await click(target, ...vertices[i], buttons[i]);
            await target.page.keyboard.press('Enter');
            const left = buttons.at(-1) === 'left';
            await committed(target, name, [
                [28, 11, left ? red : blue],
                [28, 28, left ? blue : red],
                [12, 28, left ? [128, 0, 127, 255] : blue],
            ]);
            results.checks.push(name);
        } catch (error) {
            results.failures.push({ name, error: String(error.stack || error) });
        } finally {
            await target.context.close();
        }
    }
    for (const cancel of [false, true]) {
        const name = cancel
                ? 'Polygon pending PNG export keeps latest right colors and Esc cancels'
                : 'Polygon pending project save uses latest left colors and one Undo/Redo',
            target = await boot('다각형', true, true);
        try {
            const vertices = [
                    [12, 12],
                    [44, 12],
                    [44, 44],
                    [12, 44],
                ],
                buttons = cancel ? ['left', 'right', 'left', 'right'] : ['right', 'left', 'right', 'left'];
            for (let i = 0; i < vertices.length; i++) await click(target, ...vertices[i], buttons[i]);
            if (cancel) {
                const png = await save(target, true),
                    observations = [];
                for (const [x, y, expected] of [
                    [28, 11, blue],
                    [28, 28, red],
                ]) {
                    const offset = (y * 64 + x) * 4,
                        actual = Array.from(png.pixels.slice(offset, offset + 4));
                    observations.push({ x, y, expected, png: actual });
                    assert.deepEqual(actual, expected);
                }
                results.cases.push({ name, observations });
                await target.page.keyboard.press('Escape');
                assert.deepEqual(await save(target), original);
                assert.equal(
                    await target.page.getByRole('button', { name: '실행 취소', exact: true }).isDisabled(),
                    true,
                );
                assert.deepEqual(await canvasPixel(target, 28, 28), [221, 224, 229, 255]);
            } else
                await committed(target, name, [
                    [28, 11, red],
                    [28, 28, blue],
                    [12, 28, [128, 0, 127, 255]],
                ]);
            results.checks.push(name);
        } catch (error) {
            results.failures.push({ name, error: String(error.stack || error) });
        } finally {
            await target.context.close();
        }
    }
    {
        const name = 'Right curve control pointercancel restores the previous left pending color',
            target = await boot('곡선', true, false);
        try {
            await drag(target, [12, 16], [44, 16], 'left');
            await click(target, 20, 16, 'left');
            await target.page.locator('.workspace canvas').evaluate((canvas) => {
                canvas.addEventListener(
                    'pointerdown',
                    (event) => {
                        window.shapeColorObservedPointerId = event.pointerId;
                    },
                    { once: true, capture: true },
                );
            });
            await mouse(target, 'mousePressed', 36, 16, 'right', 2);
            assert.deepEqual(
                await canvasPixel(target, 28, 16),
                blue,
                'The tentative right control must really change the preview before cancellation',
            );
            await target.page.locator('.workspace canvas').evaluate((canvas) => {
                canvas.dispatchEvent(
                    new PointerEvent('pointercancel', {
                        pointerId: window.shapeColorObservedPointerId,
                        pointerType: 'mouse',
                        button: 2,
                        buttons: 0,
                        bubbles: true,
                    }),
                );
            });
            await mouse(target, 'mouseReleased', 36, 16, 'right', 0);
            assert.deepEqual(await canvasPixel(target, 28, 16), [255, 127, 127, 255]);
            const png = await save(target, true),
                offset = (16 * 64 + 28) * 4;
            const actual = Array.from(png.pixels.slice(offset, offset + 4));
            results.cases.push({
                name: name + ' after cancel',
                expected: red,
                png: actual,
                syntheticPublicPointerCancel: true,
            });
            assert.deepEqual(actual, red);
            await committed(target, name, [
                [28, 16, red],
                [28, 20, hidden, transparent],
            ]);
            results.checks.push(name);
        } catch (error) {
            results.failures.push({ name, error: String(error.stack || error) });
        } finally {
            await target.context.close();
        }
    }
    {
        const name = 'Two-finger control takeover restores the previously accepted right curve color',
            target = await boot('곡선', true, false);
        try {
            await drag(target, [12, 16], [44, 16], 'left');
            await click(target, 20, 16, 'right');
            const first = { x: target.x + 36, y: target.y + 16, id: 61, force: 1 };
            await target.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
            assert.deepEqual(await canvasPixel(target, 28, 16), [255, 127, 127, 255]);
            await target.cdp.send('Input.dispatchTouchEvent', {
                type: 'touchStart',
                touchPoints: [first, { x: target.x + 44, y: target.y + 24, id: 62, force: 1 }],
            });
            await target.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            assert.deepEqual(await canvasPixel(target, 28, 16), blue);
            const png = await save(target, true),
                offset = (16 * 64 + 28) * 4,
                actual = Array.from(png.pixels.slice(offset, offset + 4));
            results.cases.push({ name: name + ' after takeover', expected: blue, png: actual });
            assert.deepEqual(actual, blue);
            await committed(target, name, [
                [28, 16, blue],
                [28, 20, hidden, transparent],
            ]);
            results.checks.push(name);
        } catch (error) {
            results.failures.push({ name, error: String(error.stack || error) });
        } finally {
            await target.context.close();
        }
    }
    {
        const name = 'Middle pan preserves the latest pending polygon colors',
            target = await boot('다각형', true, true);
        try {
            const vertices = [
                    [12, 12],
                    [44, 12],
                    [44, 44],
                    [12, 44],
                ],
                buttons = ['left', 'right', 'left', 'right'];
            for (let i = 0; i < vertices.length; i++) await click(target, ...vertices[i], buttons[i]);
            await mouse(target, 'mousePressed', 20, 20, 'middle', 4);
            await mouse(target, 'mouseMoved', 28, 24, 'middle', 4);
            await mouse(target, 'mouseReleased', 28, 24, 'middle', 0);
            await committed(target, name, [
                [28, 11, blue],
                [28, 28, red],
                [12, 28, blue],
            ]);
            results.checks.push(name);
        } catch (error) {
            results.failures.push({ name, error: String(error.stack || error) });
        } finally {
            await target.context.close();
        }
    }
    {
        const name = 'Failed left curve control restores right pending color and permits one-history retry',
            target = await boot('곡선', true, false);
        try {
            await drag(target, [12, 16], [44, 16], 'left');
            await click(target, 20, 16, 'right');
            await target.page.evaluate(() => {
                const prototype = OffscreenCanvasRenderingContext2D.prototype,
                    read = prototype.getImageData;
                window.shapeColorReadbackFailed = false;
                prototype.getImageData = function () {
                    prototype.getImageData = read;
                    window.shapeColorReadbackFailed = true;
                    throw Error('Injected shape color readback failure');
                };
            });
            await click(target, 36, 16, 'left');
            await target.page.waitForFunction(() => window.shapeColorReadbackFailed === true);
            const png = await save(target, true),
                offset = (16 * 64 + 28) * 4,
                actual = Array.from(png.pixels.slice(offset, offset + 4));
            results.cases.push({
                name: name + ' after failure',
                expected: blue,
                png: actual,
                injectedReadbackFailure: true,
            });
            assert.deepEqual(actual, blue);
            await click(target, 36, 16, 'left');
            await committed(target, name, [
                [28, 16, red],
                [28, 20, hidden, transparent],
            ]);
            results.checks.push(name);
        } catch (error) {
            results.failures.push({ name, error: String(error.stack || error) });
        } finally {
            await target.context.close();
        }
    }
    {
        const name = 'Alpha-zero picker brush preserves raw pixels, clean state and empty history',
            target = await boot('브러시');
        try {
            await target.page.getByRole('button', { name: '스포이트', exact: true }).click();
            await click(target, 28, 20, 'left');
            await target.page.getByRole('button', { name: '브러시', exact: true }).click();
            assert.equal(
                await target.page
                    .getByRole('button', { name: '브러시', exact: true })
                    .getAttribute('aria-pressed'),
                'true',
            );
            const beforeTitle = await target.page.locator('.title').textContent();
            await click(target, 28, 20, 'left');
            await canvasPixel(target, 28, 20);
            // Observe clean/history before saving, which would otherwise hide a dirty-state regression.
            const afterTitle = await target.page.locator('.title').textContent(),
                undoDisabled = await target.page
                    .getByRole('button', { name: '실행 취소', exact: true })
                    .isDisabled(),
                state = await save(target),
                offset = (20 * 64 + 28) * 4;
            let changedChannels = 0;
            for (let i = 0; i < original.layers[0].pixels.length; i++)
                if (state.layers[0].pixels[i] !== original.layers[0].pixels[i]) changedChannels++;
            results.cases.push({
                name,
                beforeTitle,
                afterTitle,
                undoDisabled,
                changedChannels,
                expected: hidden,
                project: Array.from(state.layers[0].pixels.slice(offset, offset + 4)),
            });
            assert.deepEqual(
                state,
                original,
                'A normal transparent brush must not rewrite invisible RGB or any other raw state',
            );
            assert.equal(afterTitle, beforeTitle);
            assert.equal(undoDisabled, true);
            results.checks.push(name);
        } catch (error) {
            results.failures.push({ name, error: String(error.stack || error) });
        } finally {
            await target.context.close();
        }
    }
    assert.deepEqual(results.errors, []);
    assert.deepEqual(results.failures, []);
} finally {
    await fs.writeFile(output, JSON.stringify(results, null, 2) + '\n');
    await browser.close();
}
console.log(JSON.stringify(results, null, 2));
