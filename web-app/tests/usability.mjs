import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, encodePng, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';
import { chromium } from 'playwright';
const output = path.resolve(
    process.env.PAINT_USABILITY_OUTPUT ||
        '../build-web-work/task-planning/current-tests/usability/results.json',
);
await fs.mkdir(path.dirname(output), { recursive: true });
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
const result = {
    ok: false,
    browser: browser.version(),
    url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8994/',
    scope: 'Public DOM, mouse/keyboard, actual codecs/geometry Workers and in-memory native file bridge. Paste payload events and one geometry failure are explicitly modeled; OS clipboard/OS picker/physical hardware are separate.',
    cases: [],
    errors: [],
};
const fixture = createState(16, 12, [0, 0, 0, 0], desktopLimits);
fixture.layers[0].pixels.set([17, 83, 201, 0]);
fixture.layers[0].pixels.set([91, 27, 33, 128], (11 * 16 + 15) * 4);
fixture.layers.push({ name: '숨김 RGB', visible: false, pixels: new Uint8ClampedArray(16 * 12 * 4) });
fixture.layers[1].pixels.set([101, 67, 241, 0], 12);
const wire = encodeProject(fixture, desktopLimits),
    red = new Uint8ClampedArray(16 * 16 * 4);
for (let i = 0; i < red.length; i += 4) red.set([255, 0, 0, 255], i);
const image = encodePng(16, 16, red, desktopLimits);
async function menu(page, name) {
    await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
}
async function project(page) {
    const count = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
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
async function pastePayload(page, bytes = image, target = '.workspace canvas') {
    return page.evaluate(
        ({ bytes, target }) => {
            const data = new DataTransfer();
            data.items.add(new File([Uint8Array.from(bytes)], 'clipboard.png', { type: 'image/png' }));
            const event = new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: data,
            });
            document.querySelector(target).dispatchEvent(event);
            return event.defaultPrevented;
        },
        { bytes: Array.from(bytes), target },
    );
}
async function dragHandle(page, edge, dx, dy, finish = 'up') {
    const handle = page.locator('[data-canvas-resize=' + edge + ']'),
        box = await handle.boundingBox();
    assert(box);
    const x = box.x + box.width / 2,
        y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 3 });
    if (finish === 'up') {
        await page.mouse.up();
        await page.waitForFunction(() => !document.querySelector('.busy'));
    } else if (finish === 'escape') {
        await page.keyboard.press('Escape');
        await page.mouse.up();
    } else if (finish === 'cancel') {
        await page.evaluate(() =>
            document
                .querySelector('.workspace canvas')
                .dispatchEvent(
                    new PointerEvent('pointercancel', { pointerId: window.lastTestPointer, bubbles: true }),
                ),
        );
        await page.mouse.up();
    }
}
const cases = [
    [
        'mobile Classic98 shows all three unsaved action buttons without clipping',
        async (page) => {
            const paper = await page.locator('.canvas-bounds').boundingBox();
            await page.touchscreen.tap(paper.x + 5, paper.y + 5);
            await menu(page, '새 그림');
            await page.getByLabel('너비', { exact: true }).fill('32');
            await page.getByLabel('높이', { exact: true }).fill('24');
            await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
            await page.getByRole('button', { name: '프로젝트 다운로드', exact: true }).waitFor();
            assert.equal(await page.getByRole('dialog').locator('select').count(), 0);
            for (const name of ['프로젝트 다운로드', '저장하지 않고 버리기', '취소']) {
                const box = await page.getByRole('button', { name, exact: true }).boundingBox();
                assert(box && box.x >= 0 && box.x + box.width <= 390 && box.height >= 44);
            }
            await page.screenshot({ path: path.join(path.dirname(output), 'mobile-dialog.png') });
            await page.getByRole('button', { name: '취소', exact: true }).click();
            assert((await page.title()).includes('usability.rpaint'));
        },
    ],
    [
        'unsaved choices are three direct buttons; Escape preserves drawing',
        async (page) => {
            const paper = await page.locator('.canvas-bounds').boundingBox();
            await page.getByRole('button', { name: '연필', exact: true }).click();
            await page.mouse.click(paper.x + 5, paper.y + 5);
            await page.evaluate(() => window.dispatchEvent(new Event('mypaint-close-request')));
            const dialog = page.getByRole('dialog');
            await dialog.waitFor();
            assert.equal(await dialog.locator('select').count(), 0);
            assert.deepEqual(await dialog.getByRole('button').allTextContents(), [
                '저장',
                '저장하지 않고 버리기',
                '취소',
            ]);
            await page.keyboard.press('Escape');
            assert.equal(await dialog.count(), 0);
            assert.equal(
                await page.evaluate(
                    () =>
                        window.__myPaintPersistenceTest.calls.filter((c) => c.command === 'close_window')
                            .length,
                ),
                0,
            );
            assert(await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled());
        },
    ],
    [
        'discard closes through one visible button and does not save',
        async (page) => {
            const b = await page.locator('.canvas-bounds').boundingBox();
            await page.mouse.click(b.x + 4, b.y + 4);
            await page.evaluate(() => window.dispatchEvent(new Event('mypaint-close-request')));
            await page.getByRole('button', { name: '저장하지 않고 버리기', exact: true }).click();
            await page.waitForFunction(() =>
                window.__myPaintPersistenceTest.calls.some((c) => c.command === 'close_window'),
            );
            assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.writes.length), 0);
        },
    ],
    [
        'Ctrl and Cmd paste leave default event enabled and image event inserts exactly once',
        async (page) => {
            await page.evaluate(() => {
                window.asyncClipboardReads = 0;
                Object.defineProperty(navigator, 'clipboard', {
                    configurable: true,
                    value: {
                        read: async () => {
                            window.asyncClipboardReads++;
                            throw Error('Async read must not run for paste events');
                        },
                    },
                });
                for (const key of ['ctrlKey', 'metaKey']) {
                    const event = new KeyboardEvent('keydown', {
                        key: 'v',
                        [key]: true,
                        bubbles: true,
                        cancelable: true,
                    });
                    document.querySelector('.workspace canvas').dispatchEvent(event);
                    if (event.defaultPrevented) throw Error('Native paste suppressed');
                }
            });
            const count = await page.evaluate(
                () =>
                    window.__myPaintPersistenceTest.codecJobs.filter((c) => c.operation === 'png-read')
                        .length,
            );
            assert(await pastePayload(page));
            await page.getByRole('status').filter({ hasText: '드래그로 배치' }).waitFor();
            assert.equal(await page.evaluate(() => window.asyncClipboardReads), 0);
            assert.equal(
                await page.evaluate(
                    () =>
                        window.__myPaintPersistenceTest.codecJobs.filter((c) => c.operation === 'png-read')
                            .length,
                ),
                count + 1,
            );
            const state = await project(page);
            assert.deepEqual(Array.from(state.layers[0].pixels.subarray(0, 4)), [255, 0, 0, 255]);
        },
    ],
    [
        'PNG representation wins over an unsupported image representation',
        async (page) => {
            await page.evaluate((bytes) => {
                const data = new DataTransfer();
                data.items.add(new File(['unsupported'], 'clipboard.tiff', { type: 'image/tiff' }));
                data.items.add(new File([Uint8Array.from(bytes)], 'clipboard.png', { type: 'image/png' }));
                document
                    .querySelector('.workspace canvas')
                    .dispatchEvent(
                        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
                    );
            }, Array.from(image));
            await page.getByRole('status').filter({ hasText: '드래그로 배치' }).waitFor();
            assert.deepEqual(
                Array.from((await project(page)).layers[0].pixels.subarray(0, 4)),
                [255, 0, 0, 255],
            );
        },
    ],
    [
        'paste in a text editor remains native text editing',
        async (page) => {
            await page.getByRole('button', { name: '문자', exact: true }).click();
            const b = await page.locator('.canvas-bounds').boundingBox();
            await page.mouse.click(b.x + 4, b.y + 4);
            await page.locator('.text-editor').fill('keep');
            assert.equal(await pastePayload(page, image, '.text-editor'), false);
            assert.equal(await page.locator('.text-editor').inputValue(), 'keep');
        },
    ],
    [
        'invalid image paste preserves document and permits retry and cancel',
        async (page) => {
            assert(await pastePayload(page, Uint8Array.from([137, 80, 78, 71, 0, 0, 0, 0])));
            await page
                .getByRole('status')
                .filter({ hasText: /PNG|잘린|올바른/ })
                .waitFor();
            assert.deepEqual(await project(page), fixture);
            assert(await pastePayload(page));
            await page.getByRole('status').filter({ hasText: '드래그로 배치' }).waitFor();
            await page.keyboard.press('Escape');
            assert.deepEqual(await project(page), fixture);
        },
    ],
    [
        'canvas drag previews only then commits all layers with one Undo and Redo',
        async (page) => {
            const jobs = await page.evaluate(
                () =>
                    window.__myPaintPersistenceTest.codecJobs.filter((c) => c.operation === 'geometry')
                        .length,
            );
            await dragHandle(page, 'se', 8, 6, 'hold');
            assert.equal(await page.locator('.document-info').textContent(), '16 × 12 px');
            assert.equal(
                await page.evaluate(
                    () =>
                        window.__myPaintPersistenceTest.codecJobs.filter((c) => c.operation === 'geometry')
                            .length,
                ),
                jobs,
            );
            assert.equal(await page.locator('.canvas-resize-size').textContent(), '24 × 18 px');
            await page.mouse.up();
            await page.waitForFunction(
                () =>
                    document.querySelector('.document-info').textContent === '24 × 18 px' &&
                    !document.querySelector('.busy'),
            );
            const resized = await project(page);
            for (let layer = 0; layer < 2; layer++) {
                const expected = new Uint8ClampedArray(24 * 18 * 4);
                for (let y = 0; y < 12; y++)
                    expected.set(
                        fixture.layers[layer].pixels.subarray(y * 16 * 4, (y + 1) * 16 * 4),
                        y * 24 * 4,
                    );
                assert.deepEqual(resized.layers[layer].pixels, expected);
                assert.equal(resized.layers[layer].name, fixture.layers[layer].name);
                assert.equal(resized.layers[layer].visible, fixture.layers[layer].visible);
            }
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await project(page), fixture);
            await page.getByRole('button', { name: '다시 실행', exact: true }).click();
            assert.deepEqual(await project(page), resized);
        },
    ],
    [
        'Escape canvas resize preserves the unfinished text editor',
        async (page) => {
            await page.getByRole('button', { name: '문자', exact: true }).click();
            const b = await page.locator('.canvas-bounds').boundingBox();
            await page.mouse.click(b.x + 3, b.y + 3);
            await page.locator('.text-editor').fill('stay');
            await dragHandle(page, 'se', 16, 12, 'escape');
            assert.equal(await page.locator('.text-editor').inputValue(), 'stay');
            assert.equal(await page.locator('.document-info').textContent(), '16 × 12 px');
        },
    ],
    [
        'pointer cancellation and a NoOp preserve pixels and history',
        async (page) => {
            await dragHandle(page, 'e', 20, 0, 'cancel');
            assert.deepEqual(await project(page), fixture);
            const box = await page.locator('[data-canvas-resize=se]').boundingBox(),
                x = box.x + box.width / 2,
                y = box.y + box.height / 2;
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.mouse.move(x + 10, y + 10);
            await page.mouse.move(x, y);
            await page.mouse.up();
            assert(await page.getByRole('button', { name: '실행 취소', exact: true }).isDisabled());
            assert.deepEqual(await project(page), fixture);
        },
    ],
    [
        'fractional zoom and DPR2 resize in document pixels',
        async (page) => {
            await page.getByRole('button', { name: '확대', exact: true }).click();
            await page.getByRole('button', { name: '확대', exact: true }).click();
            const b = await page.locator('.canvas-bounds').boundingBox(),
                zoom = b.width / 16;
            await dragHandle(page, 'e', 10 * zoom, 0);
            await page.waitForFunction(
                () => document.querySelector('.document-info').textContent === '26 × 12 px',
            );
            assert.equal((await project(page)).width, 26);
        },
    ],
    [
        'resize keyboard input and size dialogs expose meaningful options',
        async (page) => {
            const handle = page.getByRole('button', { name: '캔버스 너비와 높이 조절', exact: true });
            await handle.focus();
            await page.keyboard.press('ArrowRight');
            await page.waitForFunction(
                () => document.querySelector('.document-info').textContent === '17 × 12 px',
            );
            await handle.focus();
            await page.keyboard.press('Enter');
            await page.getByRole('dialog').waitFor();
            assert.equal(await page.getByLabel('보간', { exact: true }).count(), 0);
            await page.getByRole('button', { name: '취소', exact: true }).click();
            await menu(page, '이미지 크기');
            await page.getByLabel('보간', { exact: true }).waitFor();
            assert.equal(await page.getByLabel('보간', { exact: true }).count(), 1);
            await page.getByRole('button', { name: '취소', exact: true }).click();
        },
    ],
    [
        'help contains instructions and unavailable layer actions are disabled',
        async (page) => {
            assert(await page.getByRole('button', { name: '레이어 아래로 이동', exact: true }).isDisabled());
            assert(await page.getByRole('button', { name: '아래 레이어와 병합', exact: true }).isDisabled());
            await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
            assert(await page.getByRole('button', { name: '선택 자르기', exact: true }).isDisabled());
            await page.getByRole('button', { name: '사용 방법', exact: true }).click();
            await page
                .getByRole('dialog')
                .getByText('클립보드 이미지 바로 붙여넣기', { exact: false })
                .waitFor();
        },
    ],
    [
        'window blur cancels a resize without changing pixels',
        async (page) => {
            await dragHandle(page, 'se', 10, 8, 'hold');
            await page.evaluate(() => window.dispatchEvent(new Event('blur')));
            await page.mouse.up();
            assert.equal(await page.locator('.document-info').textContent(), '16 × 12 px');
            assert.deepEqual(await project(page), fixture);
        },
    ],
    [
        'canvas expansion uses document background and transparent upper layers',
        async (page) => {
            const source = { ...fixture, background: [12, 34, 56, 78] };
            await page.evaluate(
                (bytes) =>
                    window.__myPaintPersistenceTest.queueOpen('background.rpaint', Uint8Array.from(bytes)),
                Array.from(encodeProject(source, desktopLimits)),
            );
            await page.getByRole('button', { name: '파일 열기', exact: true }).click();
            await page.waitForFunction(
                () => document.title.includes('background.rpaint') && !document.querySelector('.busy'),
            );
            await dragHandle(page, 'se', 4, 4);
            await page.waitForFunction(
                () => document.querySelector('.document-info').textContent === '20 × 16 px',
            );
            const state = await project(page);
            assert.deepEqual(
                Array.from(state.layers[0].pixels.subarray((15 * 20 + 19) * 4)),
                [12, 34, 56, 78],
            );
            assert.deepEqual(Array.from(state.layers[1].pixels.subarray((15 * 20 + 19) * 4)), [0, 0, 0, 0]);
        },
    ],
    [
        'shrinking crops without resampling and Undo restores hidden RGB',
        async (page) => {
            await dragHandle(page, 'se', -8, -4);
            await page.waitForFunction(
                () => document.querySelector('.document-info').textContent === '8 × 8 px',
            );
            const cropped = await project(page);
            for (let layer = 0; layer < 2; layer++)
                for (let y = 0; y < 8; y++)
                    assert.deepEqual(
                        cropped.layers[layer].pixels.subarray(y * 8 * 4, (y + 1) * 8 * 4),
                        fixture.layers[layer].pixels.subarray(y * 16 * 4, (y * 16 + 8) * 4),
                    );
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await project(page), fixture);
        },
    ],
    [
        'oversized drag rejects before a geometry job and can return to valid bounds',
        async (page) => {
            const box = await page.locator('[data-canvas-resize=se]').boundingBox(),
                x = box.x + box.width / 2,
                y = box.y + box.height / 2;
            const jobs = await page.evaluate(
                () =>
                    window.__myPaintPersistenceTest.codecJobs.filter((c) => c.operation === 'geometry')
                        .length,
            );
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.locator('.workspace canvas').evaluate(
                (canvas, point) =>
                    canvas.dispatchEvent(
                        new PointerEvent('pointermove', {
                            pointerId: window.lastTestPointer,
                            pointerType: 'mouse',
                            buttons: 1,
                            clientX: point.x + 30000,
                            clientY: point.y + 30000,
                            bubbles: true,
                        }),
                    ),
                { x, y },
            );
            assert.equal(await page.locator('.canvas-resize-size').textContent(), '16 × 12 px');
            assert.equal(
                await page.evaluate(
                    () =>
                        window.__myPaintPersistenceTest.codecJobs.filter((c) => c.operation === 'geometry')
                            .length,
                ),
                jobs,
            );
            await page.mouse.move(x + 4, y + 6);
            await page.mouse.up();
            await page.waitForFunction(
                () => document.querySelector('.document-info').textContent === '20 × 18 px',
            );
        },
    ],
    [
        'geometry failure preserves the document and Redo; the next drag succeeds',
        async (page) => {
            const paper = await page.locator('.canvas-bounds').boundingBox();
            await page.getByRole('button', { name: '연필', exact: true }).click();
            await page.mouse.click(paper.x + 4, paper.y + 4);
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            await page.evaluate(() => {
                const Original = window.Worker;
                window.failResizeOnce = true;
                window.Worker = class extends Original {
                    postMessage(data, transfer) {
                        if (window.failResizeOnce && data.operation === 'geometry') {
                            window.failResizeOnce = false;
                            queueMicrotask(() =>
                                this.dispatchEvent(
                                    new MessageEvent('message', {
                                        data: { profileId: 'desktop', error: 'resize test failure' },
                                    }),
                                ),
                            );
                        } else super.postMessage(data, transfer);
                    }
                };
            });
            await dragHandle(page, 'e', 4, 0);
            await page.getByRole('status').filter({ hasText: 'resize test failure' }).waitFor();
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            assert.deepEqual(await project(page), fixture);
            await dragHandle(page, 'e', 4, 0);
            await page.waitForFunction(
                () => document.querySelector('.document-info').textContent === '20 × 12 px',
            );
        },
    ],
    [
        'pasted image is visible after panning away from document origin',
        async (page) => {
            const box = await page.locator('.workspace canvas').boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.wheel(900, 700);
            assert(await pastePayload(page));
            await page.getByRole('status').filter({ hasText: '드래그로 배치' }).waitFor();
            const pixel = await page
                .locator('.workspace canvas')
                .evaluate((canvas) =>
                    Array.from(
                        canvas
                            .getContext('2d')
                            .getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1)
                            .data,
                    ),
                );
            assert.deepEqual(pixel, [255, 0, 0, 255]);
            await page.keyboard.press('Escape');
            assert.deepEqual(await project(page), fixture);
        },
    ],
];
try {
    for (const [name, action] of cases) {
        const record = { name, ok: false };
        result.cases.push(record);
        const mobile = name.startsWith('mobile');
        const context = await browser.newContext({
            viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 1000 },
            deviceScaleFactor: mobile || name.includes('DPR2') ? 2 : 1,
            isMobile: mobile,
            hasTouch: mobile,
        });
        const page = await context.newPage();
        page.setDefaultTimeout(12000);
        page.on('pageerror', (error) => result.errors.push(error.message));
        try {
            if (!mobile) await page.addInitScript(installNativeHarness);
            else
                await page.addInitScript(() =>
                    localStorage.setItem(
                        'mypaint.ui.v1',
                        JSON.stringify({ skin: 'classic', density: 'touch' }),
                    ),
                );
            await page.addInitScript(() =>
                document.addEventListener(
                    'pointerdown',
                    (event) => {
                        window.lastTestPointer = event.pointerId;
                    },
                    true,
                ),
            );
            await page.goto(result.url);
            await page.waitForSelector('canvas[data-ready=true]');
            if (mobile) {
                const [chooser] = await Promise.all([
                    page.waitForEvent('filechooser'),
                    menu(page, '파일 열기'),
                ]);
                await chooser.setFiles({
                    name: 'usability.rpaint',
                    mimeType: 'application/octet-stream',
                    buffer: Buffer.from(wire),
                });
            } else {
                await page.evaluate(
                    (bytes) =>
                        window.__myPaintPersistenceTest.queueOpen('usability.rpaint', Uint8Array.from(bytes)),
                    Array.from(wire),
                );
                await page.getByRole('button', { name: '파일 열기', exact: true }).click();
            }
            await page.waitForFunction(
                () => document.title.includes('usability.rpaint') && !document.querySelector('.busy'),
            );
            await action(page);
            record.ok = true;
        } catch (error) {
            record.error = String(error);
            await page.screenshot({ path: path.join(path.dirname(output), 'failure.png') });
            throw error;
        } finally {
            await context.close();
        }
    }
    assert.deepEqual(result.errors, []);
    result.ok = true;
} finally {
    await browser.close();
    result.testSha256 = createHash('sha256')
        .update(await fs.readFile(new URL(import.meta.url)))
        .digest('hex');
    await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
}
