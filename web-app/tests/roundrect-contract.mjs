import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject, decodePng } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output =
    process.env.PAINT_ROUNDRECT_OUTPUT || '../build-web-work/task-planning/roundrect-contract/results.json';
await fs.mkdir(path.dirname(output), { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const original = createState(1024, 180, [37, 59, 61, 0], desktopLimits);
original.layers[0].pixels.set([255, 0, 0, 128], (2 * 1024 + 2) * 4);
const blue = [0, 0, 255, 255],
    black = [0, 0, 0, 255],
    red = [255, 0, 0, 128];
// Interior/exterior samples leave antialiased boundary coverage unspecified.
const fixtures = [
    {
        name: 'large',
        from: [16, 16],
        to: [96, 64],
        rect: [16, 16, 80, 48],
        radii: [12, 12],
        samples: [
            [56, 40, blue],
            [16, 16, null],
        ],
    },
    {
        name: 'wide-short',
        from: [16, 16],
        to: [96, 24],
        rect: [16, 16, 80, 8],
        radii: [12, 4],
        samples: [
            [56, 20, blue],
            [18, 16, null],
            [18, 23, null],
        ],
    },
    {
        name: 'narrow-tall',
        from: [16, 16],
        to: [24, 96],
        rect: [16, 16, 8, 80],
        radii: [4, 12],
        samples: [
            [20, 56, blue],
            [16, 18, null],
            [23, 18, null],
        ],
    },
    {
        name: 'small',
        from: [16, 16],
        to: [24, 22],
        rect: [16, 16, 8, 6],
        radii: [4, 3],
        samples: [
            [20, 19, blue],
            [15, 16, null],
        ],
    },
    {
        name: 'reverse',
        from: [96, 64],
        to: [16, 16],
        rect: [16, 16, 80, 48],
        radii: [12, 12],
        samples: [
            [56, 40, blue],
            [16, 16, null],
        ],
    },
    {
        name: 'fractional',
        from: [16.25, 16.75],
        to: [96.75, 64.25],
        rect: [16.25, 16.75, 80.5, 47.5],
        radii: [12, 12],
        samples: [
            [56, 40, blue],
            [17, 17, null],
        ],
    },
    {
        name: 'negative-clip',
        from: [-8, -4],
        to: [64, 36],
        rect: [-8, -4, 72, 40],
        radii: [12, 12],
        samples: [
            [0, 0, blue],
            [24, 16, blue],
            [63, 0, null],
            [65, 20, null],
        ],
    },
    {
        name: 'tile-seam',
        from: [8, 16],
        to: [800, 100],
        rect: [8, 16, 792, 84],
        radii: [12, 12],
        samples: [
            [509, 40, blue],
            [510, 40, blue],
            [511, 40, blue],
            [512, 40, blue],
            [513, 40, blue],
            [514, 40, blue],
            [515, 40, blue],
        ],
    },
    {
        name: 'outline',
        from: [16, 16],
        to: [96, 64],
        rect: [16, 16, 80, 48],
        radii: [12, 12],
        outline: true,
        fill: false,
        samples: [
            [56, 16, black],
            [56, 40, null],
            [16, 16, null],
        ],
    },
    {
        name: 'both',
        from: [16, 16],
        to: [96, 64],
        rect: [16, 16, 80, 48],
        radii: [12, 12],
        outline: true,
        samples: [
            [56, 16, black],
            [56, 40, blue],
            [16, 16, null],
        ],
    },
    {
        name: 'right-alpha',
        from: [16, 16],
        to: [96, 64],
        rect: [16, 16, 80, 48],
        radii: [12, 12],
        right: true,
        outline: true,
        samples: [
            [56, 16, blue],
            [56, 40, red],
            [16, 16, null],
        ],
    },
    {
        name: 'shift-release',
        from: [16, 16],
        to: [96, 40],
        rect: [16, 16, 80, 80],
        radii: [12, 12],
        shiftRelease: true,
        samples: [
            [56, 80, blue],
            [16, 16, null],
        ],
    },
    {
        name: 'point-fill',
        from: [16, 16],
        to: [16, 16],
        rect: [16, 16, 0, 0],
        radii: [0, 0],
        noOp: true,
        samples: [[16, 16, null]],
    },
    {
        name: 'vertical-fill',
        from: [16, 16],
        to: [16, 64],
        rect: [16, 16, 0, 48],
        radii: [0, 0],
        noOp: true,
        samples: [[16, 40, null]],
    },
    {
        name: 'vertical-outline',
        from: [16, 16],
        to: [16, 64],
        rect: [16, 16, 0, 48],
        radii: [0, 0],
        outline: true,
        fill: false,
        samples: [
            [16, 40, black],
            [20, 40, null],
        ],
    },
];
const results = {
    url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
    source: hash(await fs.readFile(new URL(import.meta.url))),
    checks: [],
    cases: [],
    failures: [],
    errors: [],
    assets: [],
    scope: 'Public Chromium input and actual project/PNG pixels with modeled native file IPC. Literal geometry/radius contract plus stable interior/exterior colors, not exact Qt or antialias edge coverage. CtrlS rejection and Escape use actual keys; readback failure is injected in a shape tile. No OS filesystem/device/performance acceptance.',
};
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
results.browser = browser.version();
async function boot(dpr, fixture) {
    const context = await browser.newContext({
        viewport: { width: 1800, height: 1000 },
        deviceScaleFactor: dpr,
    });
    try {
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.on('pageerror', (error) => results.errors.push(error.message));
        page.on('request', (request) => {
            if (request.url().endsWith('.js') && !results.assets.includes(request.url()))
                results.assets.push(request.url());
        });
        await page.addInitScript(installNativeHarness, {});
        await page.addInitScript(
            ({ htmlSurface }) => {
                if (htmlSurface)
                    Object.defineProperty(globalThis, 'OffscreenCanvas', {
                        value: undefined,
                        configurable: true,
                    });
                window.roundrectTest = {
                    paths: [],
                    reads: [],
                    contexts: [],
                    failRead: 0,
                    failContext: undefined,
                    failedSurface: undefined,
                };
                for (const proto of [
                    HTMLCanvasElement.prototype,
                    globalThis.OffscreenCanvas?.prototype,
                ].filter(Boolean)) {
                    const get = proto.getContext;
                    proto.getContext = function (kind, settings) {
                        if (kind === '2d' && this !== document.querySelector('.workspace canvas')) {
                            const request = {
                                surface: this,
                                main: false,
                                kind: this instanceof HTMLCanvasElement ? 'HTMLCanvas' : 'OffscreenCanvas',
                                width: this.width,
                                height: this.height,
                                willReadFrequently: settings?.willReadFrequently === true,
                                raster: false,
                            };
                            window.roundrectTest.contexts.push(request);
                            // These dimensions identify the armed two-tile shape fixture.
                            if (
                                window.roundrectTest.failContext &&
                                this.width === 512 &&
                                this.height === 96
                            ) {
                                request.raster = true;
                                const mode = window.roundrectTest.failContext;
                                window.roundrectTest.failContext = undefined;
                                window.roundrectTest.failedSurface = this;
                                if (mode === 'throw')
                                    throw Error('Injected roundrect context creation failure');
                                return null;
                            }
                        }
                        return get.apply(this, arguments);
                    };
                }
                for (const proto of [
                    CanvasRenderingContext2D.prototype,
                    globalThis.OffscreenCanvasRenderingContext2D?.prototype,
                ].filter(Boolean)) {
                    const roundRect = proto.roundRect,
                        read = proto.getImageData;
                    proto.roundRect = function (x, y, w, h, radii) {
                        if (this.canvas !== document.querySelector('.workspace canvas'))
                            for (const request of window.roundrectTest.contexts)
                                if (request.surface === this.canvas) request.raster = true;
                        window.roundrectTest.paths.push({
                            main: this.canvas === document.querySelector('.workspace canvas'),
                            rect: [x, y, w, h],
                            radii: typeof radii === 'number' ? [radii, radii] : [radii.x, radii.y],
                        });
                        return roundRect.apply(this, arguments);
                    };
                    proto.getImageData = function (x, y, w, h) {
                        if (
                            window.roundrectTest.failRead &&
                            this.canvas !== document.querySelector('.workspace canvas')
                        ) {
                            window.roundrectTest.reads.push({ x, y, w, h });
                            if (--window.roundrectTest.failRead === 0)
                                throw Error('Injected roundrect second tile read failure');
                        }
                        return read.apply(this, arguments);
                    };
                }
            },
            { htmlSurface: fixture.htmlSurface === true },
        );
        await page.goto(results.url);
        await page.waitForSelector('canvas[data-ready=true]');
        await page.waitForFunction(
            () => window.__myPaintPersistenceTest.generation === 1 && !document.querySelector('dialog[open]'),
        );
        await page.evaluate(
            (bytes) => window.__myPaintPersistenceTest.queueOpen('roundrect.rpaint', Uint8Array.from(bytes)),
            Array.from(encodeProject(original, desktopLimits)),
        );
        await page.getByRole('button', { name: '파일 열기', exact: true }).click();
        await page.waitForFunction(
            () => window.__myPaintPersistenceTest.generation === 2 && !document.querySelector('.busy'),
        );
        assert.equal(await page.locator('#zoom').textContent(), '100%');
        const box = await page.locator('.workspace canvas').boundingBox();
        const target = {
            page,
            context,
            cdp: await context.newCDPSession(page),
            x: box.x + box.width / 2 - original.width / 2,
            y: box.y + box.height / 2 - original.height / 2,
        };
        if (fixture.right) {
            await page.getByRole('button', { name: '스포이트', exact: true }).click();
            await mouse(target, 'mousePressed', [2, 2], 'left', 1);
            await mouse(target, 'mouseReleased', [2, 2], 'left', 0);
        } else
            await page.locator('#color').evaluate((input) => {
                input.value = '#000000';
                input.dispatchEvent(new Event('change', { bubbles: true }));
            });
        await page.locator('#secondary').evaluate((input) => {
            input.value = '#0000ff';
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.locator('#size').evaluate((input) => {
            input.value = '4';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        if (fixture.noOp || fixture.cancel || fixture.fail || fixture.contextFail) {
            await page.getByRole('button', { name: '연필', exact: true }).click();
            await mouse(target, 'mousePressed', [200, 120], 'left', 1);
            await mouse(target, 'mouseReleased', [200, 120], 'left', 0);
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
        }
        await page.getByRole('button', { name: '둥근 사각형', exact: true }).click();
        await page.locator('#fill-shape').setChecked(fixture.fill !== false);
        await page.locator('#outline-shape').setChecked(fixture.outline === true);
        await page.evaluate(() => {
            window.roundrectTest.paths = [];
            window.roundrectTest.contexts = [];
        });
        return target;
    } catch (error) {
        await context.close();
        throw error;
    }
}
async function mouse(target, type, point, button, buttons, modifiers = 0) {
    await target.cdp.send('Input.dispatchMouseEvent', {
        type,
        x: target.x + point[0],
        y: target.y + point[1],
        button,
        buttons,
        modifiers,
        clickCount: 1,
    });
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
async function frame(target, samples) {
    return target.page.locator('.workspace canvas').evaluate(
        async (canvas, data) => {
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const rect = canvas.getBoundingClientRect(),
                context = canvas.getContext('2d');
            return data.samples.map(([x, y]) =>
                Array.from(
                    context.getImageData(
                        Math.floor(((data.x + x + 0.5 - rect.x) * canvas.width) / rect.width),
                        Math.floor(((data.y + y + 0.5 - rect.y) * canvas.height) / rect.height),
                        1,
                        1,
                    ).data,
                ),
            );
        },
        { x: target.x, y: target.y, samples },
    );
}
try {
    const largeRaw = new Map();
    for (const [dpr, fixture] of [
        ...fixtures.map((fixture) => [1, fixture]),
        [2, fixtures[0]],
        [2, fixtures[7]],
        [1, { ...fixtures[7], name: 'escape-and-save-rejection', cancel: true }],
        [1, { ...fixtures[7], name: 'second-tile-failure', fail: true }],
        [1, { ...fixtures[7], name: 'context-null', contextFail: 'null' }],
        [1, { ...fixtures[7], name: 'context-throw', contextFail: 'throw' }],
        [1, { ...fixtures[1], name: 'HTMLCanvas-wide-short', htmlSurface: true }],
        [1, { ...fixtures[7], name: 'HTMLCanvas-context-null', htmlSurface: true, contextFail: 'null' }],
        [1, { ...fixtures[7], name: 'HTMLCanvas-context-throw', htmlSurface: true, contextFail: 'throw' }],
    ]) {
        const name = `DPR${dpr} ${fixture.name}`,
            target = await boot(dpr, fixture);
        try {
            const button = fixture.right ? 'right' : 'left',
                mask = fixture.right ? 2 : 1;
            await mouse(target, 'mousePressed', fixture.from, button, mask);
            await mouse(target, 'mouseMoved', fixture.to, button, mask);
            const preview = await frame(target, fixture.samples);
            if (fixture.cancel) {
                const count = await target.page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
                await target.page.keyboard.press('Control+s');
                await target.page
                    .getByRole('status')
                    .filter({ hasText: '현재 작업을 마친 뒤 실행하세요.' })
                    .waitFor();
                assert.equal(
                    await target.page.evaluate(() => window.__myPaintPersistenceTest.writes.length),
                    count,
                );
                await target.page.keyboard.press('Escape');
            }
            if (fixture.fail)
                await target.page.evaluate(() => {
                    window.roundrectTest.failRead = 2;
                });
            if (fixture.contextFail)
                await target.page.evaluate((mode) => {
                    window.roundrectTest.failContext = mode;
                }, fixture.contextFail);
            await mouse(target, 'mouseReleased', fixture.to, button, 0, fixture.shiftRelease ? 8 : 0);
            if (fixture.fail)
                await target.page
                    .getByRole('status')
                    .filter({ hasText: 'Injected roundrect second tile read failure' })
                    .waitFor();
            if (fixture.contextFail) {
                await target.page
                    .getByRole('status')
                    .filter({
                        hasText:
                            fixture.contextFail === 'throw'
                                ? 'Injected roundrect context creation failure'
                                : '2D 화면을 만들 수 없습니다.',
                    })
                    .waitFor();
                assert.deepEqual(
                    await target.page.evaluate(() => [
                        window.roundrectTest.failedSurface.width,
                        window.roundrectTest.failedSurface.height,
                    ]),
                    [0, 0],
                    name + ' failed context releases owned backing',
                );
            }
            const document = await save(target),
                png = await save(target, true);
            const record = {
                name,
                preview,
                rgbaSha256: hash(document.layers[0].pixels),
                paths: await target.page.evaluate(() => window.roundrectTest.paths),
                contexts: await target.page.evaluate(() =>
                    window.roundrectTest.contexts
                        .filter((request) => request.raster)
                        .map((request) => ({
                            main: request.main,
                            kind: request.kind,
                            width: request.width,
                            height: request.height,
                            willReadFrequently: request.willReadFrequently,
                        })),
                ),
                observations: [],
            };
            results.cases.push(record);
            if (fixture.cancel) assert.equal(record.contexts.length, 0, name + ' cancel creates no raster');
            else
                assert(
                    record.contexts.length > 0 &&
                        record.contexts.every((context) => !context.main && !context.willReadFrequently),
                    name + ' raster retains default readback policy',
                );
            if (fixture.htmlSurface)
                assert(
                    record.contexts.every((context) => context.kind === 'HTMLCanvas'),
                    name + ' actual HTMLCanvas fallback',
                );
            if (fixture.noOp || fixture.cancel || fixture.fail || fixture.contextFail) {
                assert.deepEqual(document, original, name + ' original document');
                assert(
                    await target.page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled(),
                    name + ' previous Redo',
                );
                if (fixture.fail)
                    assert.equal(await target.page.evaluate(() => window.roundrectTest.reads.length), 2);
                await target.page.getByRole('button', { name: '다시 실행', exact: true }).click();
                const redone = await save(target),
                    offset = (120 * original.width + 200) * 4;
                assert.deepEqual(Array.from(redone.layers[0].pixels.subarray(offset, offset + 4)), black);
                if (fixture.cancel || fixture.fail || fixture.contextFail) {
                    results.checks.push(name);
                    continue;
                }
            }
            const finalPaths = record.paths.filter((p) => !p.main),
                previewPaths = record.paths.filter((p) => p.main);
            assert(previewPaths.length && finalPaths.length, name + ' actual preview and raster paths');
            for (const observed of finalPaths) {
                assert.deepEqual(observed.rect, fixture.rect, name + ' document bounds');
                assert.deepEqual(observed.radii, fixture.radii, name + ' independent corner radii');
            }
            if (!fixture.shiftRelease)
                for (const observed of previewPaths) {
                    // Initial point and intermediate input previews can precede the final target.
                    if (observed.rect.every((value, i) => value === fixture.rect[i]))
                        assert.deepEqual(observed.radii, fixture.radii, name + ' preview radii');
                }
            for (const [x, y, color] of fixture.samples) {
                const offset = (y * original.width + x) * 4;
                const expected = color || Array.from(original.layers[0].pixels.subarray(offset, offset + 4));
                const raw = Array.from(document.layers[0].pixels.subarray(offset, offset + 4));
                const pngExpected = expected[3] ? expected : [0, 0, 0, 0];
                const encoded = Array.from(png.pixels.subarray(offset, offset + 4));
                record.observations.push({ x, y, expected, raw, pngExpected, encoded });
                assert.deepEqual(raw, expected, name + ' raw pixel');
                assert.deepEqual(encoded, pngExpected, name + ' PNG pixel');
            }
            assert.equal(document.width, original.width);
            assert.equal(document.height, original.height);
            if (fixture.noOp) {
                results.checks.push(name);
                continue;
            }
            const committedFrame = await frame(target, fixture.samples);
            record.committedFrame = committedFrame;
            if (!fixture.shiftRelease)
                assert.deepEqual(committedFrame, preview, name + ' stable interior/exterior display');
            if (fixture.name === 'large' || fixture.name === 'tile-seam') {
                if (dpr === 1) largeRaw.set(fixture.name, document.layers[0].pixels);
                else
                    assert.deepEqual(
                        document.layers[0].pixels,
                        largeRaw.get(fixture.name),
                        name + ' DPR-independent document RGBA',
                    );
            }
            if (fixture.name === 'reverse')
                assert.deepEqual(
                    document.layers[0].pixels,
                    largeRaw.get('large'),
                    name + ' direction-independent raw RGBA',
                );
            await target.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await save(target), original, name + ' one Undo');
            await target.page.getByRole('button', { name: '다시 실행', exact: true }).click();
            assert.deepEqual(await save(target), document, name + ' one Redo');
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
    await browser.close();
    results.cleanup = { browserClosed: true };
    await fs.writeFile(output, JSON.stringify(results, null, 2) + '\n');
    console.log(
        JSON.stringify({
            checks: results.checks.length,
            failures: results.failures.length,
            errors: results.errors.length,
            output,
        }),
    );
}
