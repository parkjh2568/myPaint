import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createState } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const output = process.env.PAINT_TEST_OUTPUT || '../build-web-work/task-planning/browser';
await fs.mkdir(output, { recursive: true });
const fixture = createState(64, 64);
fixture.layers[0].name = 'Layer A';
fixture.layers.push({ name: 'Layer B', visible: true, pixels: new Uint8ClampedArray(64 * 64 * 4) });
const results = { checks: [], failures: [], errors: [], browser: browser.version() };
async function open() {
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await context.addInitScript(() => {
        window.testBlobs = [];
        window.delayOperation = 'fill';
        const create = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => {
            window.testBlobs.push(blob);
            return create(blob);
        };
        const Original = Worker;
        window.Worker = class extends Original {
            delay = false;
            postMessage(message, transfer) {
                this.delay = message.operation === window.delayOperation;
                super.postMessage(message, transfer);
            }
            set onmessage(handler) {
                super.onmessage = (event) => {
                    if (this.delay) setTimeout(() => handler.call(this, event), 800);
                    else handler.call(this, event);
                };
            }
        };
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => results.errors.push(error.message));
    page.setDefaultTimeout(10000);
    await page.goto(process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/');
    await page.waitForSelector('canvas[data-ready=true]');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '파일 열기', exact: true }).click();
    await (
        await chooser
    ).setFiles({
        name: 'fixture.rpaint',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(encodeProject(fixture)),
    });
    await page.locator('.document-info').filter({ hasText: '64 × 64' }).waitFor();
    const box = await page.locator('.workspace canvas').boundingBox();
    return { context, page, x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function snapshot(page) {
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.getByRole('button', { name: '파일 받기', exact: true }).waitFor();
    const bytes = await page.evaluate(async () =>
        Array.from(new Uint8Array(await window.testBlobs.at(-1).arrayBuffer())),
    );
    await page.getByRole('button', { name: '다운로드 닫기' }).click();
    return decodeProject(Uint8Array.from(bytes));
}
try {
    for (const name of [
        'busy fill keeps its original layer',
        'busy save keeps pending text and revision',
        'rejected shortcut preserves the active stroke',
    ]) {
        const { context, page, x, y } = await open();
        try {
            if (name.startsWith('busy fill')) {
                await page.getByRole('button', { name: '채우기', exact: true }).click();
                await page.mouse.click(x, y);
                await page.locator('.busy').waitFor();
                await page.getByRole('button', { name: 'Layer B', exact: true }).click({ force: true });
                await page.locator('.busy').waitFor({ state: 'hidden' });
                const state = await snapshot(page);
                assert.equal(state.active, 0, 'layer changed while fill was running');
                assert.deepEqual([...state.layers[0].pixels.subarray(0, 4)], [22, 121, 234, 255]);
                assert(
                    state.layers[1].pixels.every((v) => v === 0),
                    'fill wrote to another layer',
                );
            } else if (name.startsWith('busy save')) {
                await page.getByRole('button', { name: '문자', exact: true }).click();
                await page.mouse.click(x - 24, y - 24);
                const editor = page.getByRole('textbox', { name: /문자 입력/ });
                await editor.fill('pending');
                await page.evaluate(() => {
                    window.delayOperation = 'project-write';
                });
                await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
                await page.locator('.busy').waitFor();
                await page.keyboard.press('Enter');
                await page.locator('.busy').waitFor({ state: 'hidden' });
                assert.equal(await editor.count(), 1, 'Enter committed pending text while save was running');
                assert.equal(await editor.inputValue(), 'pending');
                assert.equal(
                    await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
                    true,
                );
            } else {
                await page.getByRole('button', { name: '브러시', exact: true }).click();
                await page.mouse.move(x - 16, y);
                await page.mouse.down();
                await page.mouse.move(x + 16, y, { steps: 5 });
                await page.keyboard.press('Control+s');
                await page.mouse.up();
                const state = await snapshot(page);
                assert.deepEqual(
                    [...state.layers[0].pixels.subarray((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 4)],
                    [22, 121, 234, 255],
                    'blocked save cancelled the owned stroke',
                );
            }
            results.checks.push(name);
        } catch (error) {
            results.failures.push({ name, error: String(error.stack || error) });
            await page
                .screenshot({ path: output + '/concurrency-failure-' + results.failures.length + '.png' })
                .catch(() => {});
        } finally {
            await context.close();
        }
    }
} finally {
    await browser.close();
    await fs.writeFile(output + '/concurrency.json', JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results, null, 2));
assert.equal(results.failures.length, 0);

assert.deepEqual(results.errors, []);
