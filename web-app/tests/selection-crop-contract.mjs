import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createState, cloneState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(
        process.env.PAINT_SELECTION_CROP_OUTPUT ||
            '../build-web-work/task-planning/selection-mask/crop/results.json',
    ),
    out = path.dirname(output),
    hash = (bytes) => createHash('sha256').update(bytes).digest('hex'),
    result = {
        url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
        scope: 'Public Chromium rectangle/lasso, Arrow movement and crop through the real geometry Worker, with modeled native file IPC. Original-source rectangle/lasso transform-order/nearest/crop combinations use literal index maps and Qt nearest fixtures. Opaque literal patterns distinguish crop geometry from Qt premultiplied RGB storage. UI crop intersects the pending document; the generic cropState padding API is not changed or redefined. No private Studio hooks, OS file picker, physical input or performance acceptance.',
        testSha256: hash(await fs.readFile(new URL(import.meta.url))),
        sourceSha256: {},
        assets: [],
        cases: [],
        checks: [],
        errors: [],
        failures: [],
    };
await fs.mkdir(out, { recursive: true });
for (const file of ['main.ts', 'engine/document.ts', 'engine/operations.ts', 'workers/codec.worker.ts'])
    result.sourceSha256[file] = hash(await fs.readFile(new URL('../src/' + file, import.meta.url)));

async function menu(page, name) {
    await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
    // Menu commands await native readiness before acquiring their busy owner.
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.waitForFunction(() => !document.querySelector('.busy'));
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
}
async function snapshot(page, name) {
    const count = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.waitForFunction(
        (n) => window.__myPaintPersistenceTest.writes.length > n && !document.querySelector('.busy'),
        count,
    );
    const bytes = Uint8Array.from(
        await page.evaluate(() => [...window.__myPaintPersistenceTest.writes.at(-1).bytes]),
    );
    await fs.writeFile(path.join(out, name + '.rpaint'), bytes);
    return decodeProject(bytes, desktopLimits);
}
// Literal source indices after right-rotation/left-right flip, or reverse order.
// These maps are independent of the production transform implementation.
const transpose = [
        [0, 10, 20, 30, 40, 50, 60, 70],
        [1, 11, 21, 31, 41, 51, 61, 71],
        [2, 12, 22, 32, 42, 52, 62, 72],
        [3, 13, 23, 33, 43, 53, 63, 73],
        [4, 14, 24, 34, 44, 54, 64, 74],
        [5, 15, 25, 35, 45, 55, 65, 75],
        [6, 16, 26, 36, 46, 56, 66, 76],
        [7, 17, 27, 37, 47, 57, 67, 77],
        [8, 18, 28, 38, 48, 58, 68, 78],
        [9, 19, 29, 39, 49, 59, 69, 79],
    ],
    antiTranspose = [
        [79, 69, 59, 49, 39, 29, 19, 9],
        [78, 68, 58, 48, 38, 28, 18, 8],
        [77, 67, 57, 47, 37, 27, 17, 7],
        [76, 66, 56, 46, 36, 26, 16, 6],
        [75, 65, 55, 45, 35, 25, 15, 5],
        [74, 64, 54, 44, 34, 24, 14, 4],
        [73, 63, 53, 43, 33, 23, 13, 3],
        [72, 62, 52, 42, 32, 22, 12, 2],
        [71, 61, 51, 41, 31, 21, 11, 1],
        [70, 60, 50, 40, 30, 20, 10, 0],
    ];
const nearestBytes = await fs.readFile(new URL('./fixtures/nearest-qt.json', import.meta.url)),
    nearest = JSON.parse(nearestBytes).mapsBySource;
result.nearestFixtureSha256 = hash(nearestBytes);
const cases = [
    {
        name: 'negative rectangle crops only the 7x6 pending intersection with one Undo',
        lasso: false,
        hidden: false,
        destination: [-3, -2],
    },
    {
        name: 'negative concave lasso crops its 7x6 intersection and restores hidden source on Undo',
        lasso: true,
        hidden: true,
        destination: [-3, -2],
    },
    {
        name: 'fully outside negative crop keeps pending selection, original pixels and Redo',
        lasso: false,
        hidden: false,
        destination: [-12, -10],
        outside: true,
    },
    {
        name: 'positive expansion crops the full 10x8 payload and all layer intersections',
        lasso: false,
        hidden: false,
        destination: [18, 12],
    },
];
for (const lasso of [false, true]) {
    cases.push(
        {
            name: `transposed ${lasso ? 'lasso' : 'rectangle'} negative crop preserves original mask stride`,
            lasso,
            hidden: lasso,
            destination: [-3, -2],
            transforms: ['오른쪽 회전', '좌우 반전'],
            map: transpose,
            target: [7, 9],
        },
        {
            name: `reverse-order ${lasso ? 'lasso' : 'rectangle'} positive crop expands every layer`,
            lasso,
            hidden: !lasso,
            destination: [18, 12],
            transforms: ['좌우 반전', '오른쪽 회전'],
            map: antiTranspose,
            target: [9, 6],
        },
        {
            name: `transformed ${lasso ? 'lasso' : 'rectangle'} fully outside crop preserves cancel and old Redo`,
            lasso,
            hidden: lasso,
            destination: [-12, -10],
            outside: true,
            transforms: ['오른쪽 회전', '좌우 반전'],
            map: transpose,
            target: [7, 9],
        },
    );
}
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
result.browser = browser.version();
try {
    for (const [index, fixture] of cases.entries()) {
        const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } }),
            page = await context.newPage(),
            prefix = String(index + 1).padStart(2, '0'),
            record = { ...fixture };
        result.cases.push(record);
        page.setDefaultTimeout(30000);
        page.on('pageerror', (error) => result.errors.push(error.message));
        page.on('request', (request) => {
            if (/\.js(?:[?#]|$)/.test(request.url()) && !result.assets.includes(request.url()))
                result.assets.push(request.url());
        });
        try {
            const original = createState(20, 14, [19, 31, 83, 128], desktopLimits);
            original.layers[0].name = 'bottom';
            original.layers.push(
                {
                    name: 'active selection source',
                    visible: !fixture.hidden,
                    pixels: new Uint8ClampedArray(20 * 14 * 4),
                },
                {
                    name: 'unrelated hidden layer',
                    visible: false,
                    pixels: new Uint8ClampedArray(20 * 14 * 4),
                },
            );
            original.active = 1;
            for (let layer = 0; layer < original.layers.length; layer++)
                for (let y = 0; y < 14; y++)
                    for (let x = 0; x < 20; x++)
                        original.layers[layer].pixels.set(
                            [
                                11 + x * 7 + layer * 3,
                                17 + y * 11 + layer * 5,
                                31 + ((x + 20 * y + layer * 13) % 197),
                                255,
                            ],
                            (y * 20 + x) * 4,
                        );
            const input = encodeProject(original, desktopLimits);
            await fs.writeFile(path.join(out, prefix + '-input.rpaint'), input);
            record.inputSha256 = hash(input);
            await page.addInitScript(installNativeHarness, {});
            await page.goto(result.url);
            await page.waitForFunction(
                () =>
                    window.__myPaintPersistenceTest?.generation === 1 &&
                    !document.querySelector('dialog[open]'),
            );
            await page.evaluate(
                (bytes) =>
                    window.__myPaintPersistenceTest.queueOpen(
                        'selection-crop.rpaint',
                        Uint8Array.from(bytes),
                    ),
                [...input],
            );
            await page.getByRole('button', { name: '파일 열기', exact: true }).click();
            await page.waitForFunction(
                () =>
                    window.__myPaintPersistenceTest.generation === 2 &&
                    !document.querySelector('.busy') &&
                    document.querySelector('.workspace canvas').dataset.ready === 'true',
            );
            assert.equal(await page.locator('#zoom').textContent(), '100%');
            const box = await page.locator('.workspace canvas').boundingBox(),
                left = box.x + box.width / 2 - 10,
                top = box.y + box.height / 2 - 7;
            // Seed and undo a real edit before selecting so a no-op must preserve a useful Redo branch.
            await page.getByRole('button', { name: '연필', exact: true }).click();
            await page.mouse.click(left + 17.5, top + 11.5);
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            assert.deepEqual(await snapshot(page, prefix + '-source'), original);
            await page
                .getByRole('button', { name: fixture.lasso ? '자유 선택' : '사각 선택', exact: true })
                .click();
            await page.locator('#transparent-selection').uncheck();
            await page.mouse.move(left + 2, top + 2);
            await page.mouse.down();
            const points = fixture.lasso
                ? [
                      [12, 2],
                      [12, 6],
                      [7, 6],
                      [7, 10],
                      [2, 10],
                  ]
                : [[12, 10]];
            for (const [x, y] of points) await page.mouse.move(left + x, top + y);
            await page.mouse.up();
            const target = fixture.target || [10, 8],
                [targetWidth, targetHeight] = target,
                payload = new Uint8ClampedArray(targetWidth * targetHeight * 4);
            if (fixture.transforms) {
                for (const command of fixture.transforms) await menu(page, command);
                await menu(page, '선택 크기');
                const dialog = page.getByRole('dialog');
                await dialog.getByLabel('너비', { exact: true }).fill(String(targetWidth));
                await dialog.getByLabel('높이', { exact: true }).fill(String(targetHeight));
                const geometryBefore = await page.evaluate(
                    () =>
                        window.__myPaintPersistenceTest.codecJobs.filter(
                            (job) => job.operation === 'geometry',
                        ).length,
                );
                await dialog.getByRole('button', { name: '확인', exact: true }).click();
                await dialog.waitFor({ state: 'detached' });
                await page.waitForFunction(
                    (n) =>
                        window.__myPaintPersistenceTest.codecJobs.filter(
                            (job) => job.operation === 'geometry',
                        ).length ===
                            n + 1 && !document.querySelector('.busy'),
                    geometryBefore,
                );
            }
            const xMap = fixture.map ? nearest[7][targetWidth - 1].split(',').map(Number) : undefined,
                yMap = fixture.map ? nearest[9][targetHeight - 1].split(',').map(Number) : undefined;
            for (let y = 0; y < targetHeight; y++)
                for (let x = 0; x < targetWidth; x++) {
                    const sourceIndex = fixture.map ? fixture.map[yMap[y]][xMap[x]] : y * 10 + x,
                        sx = sourceIndex % 10,
                        sy = Math.floor(sourceIndex / 10),
                        at = (y * targetWidth + x) * 4;
                    payload.set(
                        original.layers[1].pixels.subarray(
                            ((sy + 2) * 20 + sx + 2) * 4,
                            ((sy + 2) * 20 + sx + 3) * 4,
                        ),
                        at,
                    );
                    if (fixture.lasso && sy >= 4 && sx >= 5) payload[at + 3] = 0;
                }
            const [dx, dy] = fixture.destination;
            await page.locator('.workspace canvas').focus();
            for (let n = 0; n < Math.abs(dx - 2); n++)
                await page.keyboard.press(dx < 2 ? 'ArrowLeft' : 'ArrowRight');
            for (let n = 0; n < Math.abs(dy - 2); n++)
                await page.keyboard.press(dy < 2 ? 'ArrowUp' : 'ArrowDown');
            const geometryBeforeCrop = await page.evaluate(
                () =>
                    window.__myPaintPersistenceTest.codecJobs.filter((job) => job.operation === 'geometry')
                        .length,
            );
            await menu(page, '선택 자르기');
            await page.waitForFunction(() => !document.querySelector('.busy'));
            record.afterCrop = {
                info: await page.locator('.document-info').textContent(),
                undo: await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
                redo: await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled(),
                dirty: (await page.title()).startsWith('* '),
                geometryJobs: await page.evaluate(
                    () =>
                        window.__myPaintPersistenceTest.codecJobs.filter(
                            (job) => job.operation === 'geometry',
                        ).length,
                ),
            };
            assert.equal(
                record.afterCrop.geometryJobs,
                geometryBeforeCrop + (fixture.outside ? 0 : 1),
                'Only a nonempty crop starts a geometry Worker',
            );
            if (fixture.outside) {
                if (record.afterCrop.info !== '20 × 14 px' || record.afterCrop.dirty) {
                    const unexpected = await snapshot(page, prefix + '-unexpected-crop');
                    record.unexpectedDimensions = [unexpected.width, unexpected.height];
                }
                assert.deepEqual(
                    {
                        info: record.afterCrop.info,
                        undo: record.afterCrop.undo,
                        redo: record.afterCrop.redo,
                        dirty: record.afterCrop.dirty,
                    },
                    { info: '20 × 14 px', undo: true, redo: false, dirty: false },
                    'A fully outside crop must neither commit nor consume the pending selection/Redo',
                );
                await menu(page, '선택 크기');
                const dialog = page.getByRole('dialog');
                assert.equal(
                    await dialog.getByLabel('너비', { exact: true }).inputValue(),
                    String(targetWidth),
                );
                assert.equal(
                    await dialog.getByLabel('높이', { exact: true }).inputValue(),
                    String(targetHeight),
                );
                await dialog.getByRole('button', { name: '취소', exact: true }).click();
                await dialog.waitFor({ state: 'detached' });
                await page.locator('.workspace canvas').focus();
                if (fixture.transforms) {
                    await page.keyboard.press('Escape');
                } else {
                    for (let n = 0; n < 2 - dx; n++) await page.keyboard.press('ArrowRight');
                    for (let n = 0; n < 2 - dy; n++) await page.keyboard.press('ArrowDown');
                    await page.locator('.workspace canvas').focus();
                    await page.keyboard.press('Enter');
                }
                await page.waitForFunction(
                    () =>
                        document.querySelector('[data-command=undo]').disabled &&
                        !document.querySelector('[data-command=redo]').disabled,
                );
                record.returnedHistory = {
                    undo: await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
                    redo: await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled(),
                    dirty: (await page.title()).startsWith('* '),
                };
                assert.deepEqual(
                    record.returnedHistory,
                    { undo: false, redo: true, dirty: false },
                    'After canceling transformed pending state or returning unmodified geometry, the source and original Redo remain available',
                );
                assert.deepEqual(await snapshot(page, prefix + '-returned-source'), original);
                assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                const seeded = cloneState(original);
                seeded.layers[1].visible = true;
                seeded.layers[1].pixels.set([22, 121, 234, 255], (11 * 20 + 17) * 4);
                assert.deepEqual(await snapshot(page, prefix + '-preserved-redo'), seeded);
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                assert.deepEqual(await snapshot(page, prefix + '-undo-redo'), original);
                record.pendingAndRedoPreserved = true;
            } else {
                const pendingWidth = Math.max(20, dx + targetWidth),
                    pendingHeight = Math.max(14, dy + targetHeight),
                    pending = { ...original, width: pendingWidth, height: pendingHeight, layers: [] };
                for (let layer = 0; layer < original.layers.length; layer++) {
                    const pixels = new Uint8ClampedArray(pendingWidth * pendingHeight * 4);
                    for (let y = 0; y < pendingHeight; y++)
                        for (let x = 0; x < pendingWidth; x++) {
                            const value =
                                x < 20 && y < 14
                                    ? original.layers[layer].pixels.subarray(
                                          (y * 20 + x) * 4,
                                          (y * 20 + x + 1) * 4,
                                      )
                                    : layer === 0
                                      ? original.background
                                      : [0, 0, 0, 0];
                            pixels.set(value, (y * pendingWidth + x) * 4);
                        }
                    pending.layers.push({
                        ...original.layers[layer],
                        visible: layer === 1 ? true : original.layers[layer].visible,
                        pixels,
                    });
                }
                // Literal orthogonal mask: a 10x4 top bar and 5x4 lower bar, or the full rectangle.
                for (let y = 0; y < 8; y++)
                    for (let x = 0; x < 10; x++) {
                        if (fixture.lasso && y >= 4 && x >= 5) continue;
                        pending.layers[1].pixels.set([0, 0, 0, 0], ((y + 2) * pendingWidth + x + 2) * 4);
                    }
                for (let y = 0; y < targetHeight; y++)
                    for (let x = 0; x < targetWidth; x++) {
                        const at = (y * targetWidth + x) * 4;
                        if (!payload[at + 3] || dx + x < 0 || dy + y < 0) continue;
                        pending.layers[1].pixels.set(
                            payload.subarray(at, at + 4),
                            ((dy + y) * pendingWidth + dx + x) * 4,
                        );
                    }
                const cropX = Math.max(0, dx),
                    cropY = Math.max(0, dy),
                    width = dx + targetWidth - cropX,
                    height = dy + targetHeight - cropY,
                    expected = { ...pending, width, height, layers: [] };
                for (const layer of pending.layers) {
                    const pixels = new Uint8ClampedArray(width * height * 4);
                    for (let y = 0; y < height; y++)
                        pixels.set(
                            layer.pixels.subarray(
                                ((cropY + y) * pendingWidth + cropX) * 4,
                                ((cropY + y) * pendingWidth + cropX + width) * 4,
                            ),
                            y * width * 4,
                        );
                    expected.layers.push({ ...layer, pixels });
                }
                await fs.writeFile(
                    path.join(out, prefix + '-expected.rpaint'),
                    encodeProject(expected, desktopLimits),
                );
                const actual = await snapshot(page, prefix + '-cropped');
                record.dimensions = [actual.width, actual.height];
                record.expectedDimensions = [width, height];
                record.layerHashes = actual.layers.map((layer) => hash(layer.pixels));
                record.expectedLayerHashes = expected.layers.map((layer) => hash(layer.pixels));
                assert(record.afterCrop.undo && !record.afterCrop.redo && record.afterCrop.dirty);
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                assert(
                    !(await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled()),
                    'Crop is one history step',
                );
                assert.deepEqual(await snapshot(page, prefix + '-undo'), original);
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                assert.deepEqual(await snapshot(page, prefix + '-redo'), actual);
                record.singleUndoRedoPreserved = true;
                assert.deepEqual(
                    actual,
                    expected,
                    'Public UI crop must intersect the pending document, preserving exact raw pixels and metadata',
                );
            }
            record.liveWorkers = await page.evaluate(() => window.__myPaintPersistenceTest.liveWorkers.size);
            assert.equal(record.liveWorkers, 0);
            record.ok = true;
            result.checks.push(fixture.name);
        } catch (error) {
            record.error = String(error.stack || error);
            result.failures.push({ name: fixture.name, error: record.error });
        } finally {
            await context.close();
        }
    }
} finally {
    await browser.close();
    result.ok = result.checks.length === cases.length && !result.errors.length && !result.failures.length;
    await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ output, ok: result.ok, checks: result.checks, failures: result.failures }));
    if (!result.ok) process.exitCode = 1;
}
