import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createState, cloneState } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.PAINT_SHEAR_OUTPUT || '../build-web-work/task-planning/shear';
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }),
    page = await context.newPage();
const results = {
    checks: [],
    errors: [],
    browser: browser.version(),
    url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
    assets: [],
};
const assetJobs = [];
page.on('response', (response) => {
    if (['script', 'stylesheet'].includes(response.request().resourceType()) && response.ok())
        assetJobs.push(
            response.body().then(
                (body) => ({ url: response.url(), sha256: createHash('sha256').update(body).digest('hex') }),
                (error) => ({ url: response.url(), bodyUnavailable: String(error) }),
            ),
        );
});
page.on('pageerror', (error) => results.errors.push(error.message));
page.setDefaultTimeout(15000);
await page.addInitScript(() => {
    window.testBlobs = [];
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
        window.testBlobs.push(blob);
        return create(blob);
    };
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (this.name === 'retropaint-local-v1' && tx.mode === 'readonly')
            tx.addEventListener(
                'complete',
                () => {
                    window.testStartupRead = true;
                },
                { once: true },
            );
        return tx;
    };
});
let serial = 0;
async function load(state) {
    const name = `shear-${++serial}.rpaint`,
        chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '파일 열기', exact: true }).click();
    await (
        await chooser
    ).setFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(encodeProject(state)) });
    const replacement = page.getByRole('button', { name: '저장하지 않고 버리기', exact: true });
    await Promise.race([
        page.waitForFunction((name) => document.title.includes(name), name),
        replacement.waitFor({ state: 'visible' }),
    ]);
    if (await replacement.isVisible()) {
        await replacement.click();
    }
    await page.waitForFunction((name) => document.title.includes(name), name);
}
async function menu(name) {
    await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
}
async function shear(angle) {
    await menu('가로 기울이기');
    await page.getByLabel('각도 (-60~60)', { exact: true }).fill(String(angle));
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
}
async function snapshot() {
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.getByRole('button', { name: '파일 받기', exact: true }).waitFor();
    const bytes = await page.evaluate(async () =>
        Array.from(new Uint8Array(await window.testBlobs.at(-1).arrayBuffer())),
    );
    await page.getByRole('button', { name: '다운로드 닫기', exact: true }).click();
    return decodeProject(Uint8Array.from(bytes));
}
// These row offsets and dimensions come from the independent Qt 6.12 Fast oracle,
// rather than calling the production transform to generate expected UI results.
function expectedRows(source, width, offsets) {
    const result = cloneState(source);
    result.width = width;
    for (let n = 0; n < result.layers.length; n++) {
        const pixels = new Uint8ClampedArray(width * source.height * 4);
        for (let y = 0; y < source.height; y++)
            pixels.set(
                source.layers[n].pixels.subarray(y * source.width * 4, (y + 1) * source.width * 4),
                (y * width + offsets[y]) * 4,
            );
        result.layers[n].pixels = pixels;
    }
    return result;
}
async function selectRegion(x, y, width, height, documentWidth, documentHeight) {
    await page.getByRole('button', { name: '사각 선택', exact: true }).click();
    const box = await page.locator('.workspace canvas').boundingBox(),
        left = box.x + (box.width - documentWidth) / 2,
        top = box.y + (box.height - documentHeight) / 2;
    await page.mouse.move(left + x, top + y);
    await page.mouse.down();
    await page.mouse.move(left + x + width, top + y + height);
    await page.mouse.up();
}
try {
    await page.goto(process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/');
    await page.waitForFunction(() => window.testStartupRead === true);
    const source = createState(3, 3, [0, 0, 0, 0]);
    for (let y = 0; y < 3; y++)
        for (let x = 0; x < 3; x++)
            source.layers[0].pixels.set([20 + x * 55, 30 + y * 65, 100 + x * 10, 255], (y * 3 + x) * 4);
    source.layers.push({ name: '숨김 fixture', visible: false, pixels: source.layers[0].pixels.slice() });
    await load(source);
    await shear(30);
    const positive = expectedRows(source, 5, [0, 1, 1]);
    assert.deepEqual(await snapshot(), positive);
    await page.getByRole('button', { name: '실행 취소', exact: true }).click();
    assert.deepEqual(await snapshot(), source);
    await page.getByRole('button', { name: '다시 실행', exact: true }).click();
    assert.deepEqual(await snapshot(), positive);
    results.checks.push(
        'Positive whole-document shear expands bounds without clipping; one Undo/Redo restores exact layers',
    );

    await load(source);
    await shear(-30);
    assert.deepEqual(await snapshot(), expectedRows(source, 5, [2, 1, 1]));
    results.checks.push('Negative whole-document shear includes the translated left bounds');

    const selectionSource = createState(20, 12, [0, 0, 0, 0]);
    for (let y = 2; y < 5; y++)
        for (let x = 2; x < 6; x++)
            selectionSource.layers[0].pixels.set([25 + x * 25, 30 + y * 30, 140, 255], (y * 20 + x) * 4);
    selectionSource.layers[0].pixels.set([44, 88, 199, 255], (8 * 20 + 15) * 4);
    selectionSource.layers.push({
        name: '다른 숨김 레이어',
        visible: false,
        pixels: new Uint8ClampedArray(20 * 12 * 4),
    });
    for (let i = 0; i < selectionSource.layers[1].pixels.length; i += 4)
        selectionSource.layers[1].pixels.set([55, 123, 71, 85], i);
    await load(selectionSource);
    await selectRegion(2, 2, 4, 3, 20, 12);
    await shear(30);
    const selectionExpected = cloneState(selectionSource),
        rowOffsets = [0, 1, 1];
    for (let y = 2; y < 5; y++)
        selectionExpected.layers[0].pixels.fill(0, (y * 20 + 2) * 4, (y * 20 + 6) * 4);
    for (let y = 0; y < 3; y++)
        selectionExpected.layers[0].pixels.set(
            selectionSource.layers[0].pixels.subarray(((y + 2) * 20 + 2) * 4, ((y + 2) * 20 + 6) * 4),
            ((y + 2) * 20 + 2 + rowOffsets[y]) * 4,
        );
    assert.deepEqual(await snapshot(), selectionExpected);
    await page.keyboard.press('Enter');
    assert.deepEqual(await snapshot(), selectionExpected);
    await page.getByRole('button', { name: '실행 취소', exact: true }).click();
    assert.deepEqual(await snapshot(), selectionSource);
    results.checks.push(
        'Selection shear changes only the selected raster and preserves document bounds, outside pixels and other layers',
    );

    await load(selectionSource);
    await selectRegion(2, 2, 4, 3, 20, 12);
    await shear(0);
    assert.deepEqual(await snapshot(), selectionSource);
    await page.keyboard.press('Enter');
    assert.deepEqual(await snapshot(), selectionSource);
    assert.equal(await page.getByRole('button', { name: '실행 취소', exact: true }).isDisabled(), true);
    results.checks.push(
        'Zero-degree selection shear preserves the unmodified selection and creates no edit history',
    );

    const wide = createState(4096, 1, [0, 0, 0, 0]);
    for (let x = 0; x < 4096; x++)
        wide.layers[0].pixels.set([x % 256, (x * 3) % 256, (x * 7) % 256, 255], x * 4);
    await load(wide);
    await shear(1);
    await page.getByRole('status').filter({ hasText: '한도' }).waitFor();
    assert.deepEqual(await snapshot(), wide);
    assert.equal(await page.getByRole('button', { name: '실행 취소', exact: true }).isDisabled(), true);
    results.checks.push(
        'Oversized whole-document shear rejects before commit and preserves pixels and history',
    );

    await menu('전체 선택');
    await shear(1);
    await page.getByRole('status').filter({ hasText: '한도' }).waitFor();
    assert.deepEqual(await snapshot(), wide);
    assert.equal(await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button', { name: '실행 취소', exact: true }).isDisabled(), true);
    assert.deepEqual(await snapshot(), wide);
    results.checks.push(
        'Oversized pending selection shear preserves the selection and supports cancellation without an edit',
    );
    assert.deepEqual(results.errors, []);
} catch (error) {
    results.failure = String(error.stack || error);
    await page.screenshot({ path: output + '/failure.png' }).catch(() => {});
    throw error;
} finally {
    results.assets = Object.values(
        Object.fromEntries((await Promise.all(assetJobs)).map((asset) => [asset.url, asset])),
    );
    const main = results.assets.find((asset) => /\/assets\/index-[^/]+\.js$/.test(asset.url));
    if (
        !results.failure &&
        (!main?.sha256 ||
            (process.env.PAINT_EXPECT_MAIN_SHA256 && main.sha256 !== process.env.PAINT_EXPECT_MAIN_SHA256))
    )
        results.failure = 'The loaded main script did not match the independently expected snapshot hash';
    await fs.writeFile(output + '/results.json', JSON.stringify(results, null, 2));
    await browser.close();
}
assert.equal(results.failure, undefined);
console.log(JSON.stringify(results, null, 2));
