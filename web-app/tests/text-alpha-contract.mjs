import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync, crc32 } from 'node:zlib';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(
    process.env.PAINT_TEXT_ALPHA_OUTPUT || '../build-web-work/task-planning/text-alpha/results.json',
);
await fs.mkdir(path.dirname(output), { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const result = {
    url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
    scope: 'Public Chromium picker/text/export/save/Undo UI with actual PNG/codec Worker. File IPC is modeled. Independent PNG8/filter0 reader and alpha bounds; glyph shapes are not compared across operating systems. No private Studio access.',
    testSha256: hash(await fs.readFile(new URL(import.meta.url))),
    checks: [],
    cases: [],
    errors: [],
    failures: [],
    assets: [],
};
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
result.browser = browser.version();
// Independent reader for the bounded, unfiltered PNG8 RGBA produced by these fixtures.
function png(bytes) {
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const data = [],
        view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8,
        width,
        height,
        ended = false;
    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset),
            name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        assert(length <= bytes.length - offset - 12);
        assert.equal(
            crc32(bytes.subarray(offset + 4, offset + 8 + length)),
            view.getUint32(offset + 8 + length),
        );
        if (name === 'IHDR') {
            assert.equal(offset, 8);
            assert.equal(length, 13);
            width = view.getUint32(offset + 8);
            height = view.getUint32(offset + 12);
            assert.equal(width, 320);
            assert.equal(height, 180);
            assert.deepEqual([...bytes.subarray(offset + 16, offset + 21)], [8, 6, 0, 0, 0]);
        } else if (name === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length));
        else if (name === 'IEND') {
            assert.equal(length, 0);
            ended = true;
            offset += 12;
            break;
        }
        offset += 12 + length;
    }
    assert(ended);
    assert.equal(offset, bytes.length);
    const stride = width * 4 + 1,
        raw = inflateSync(Buffer.concat(data), { maxOutputLength: stride * height + 1 });
    assert.equal(raw.length, stride * height);
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        assert.equal(raw[y * stride], 0);
        pixels.set(raw.subarray(y * stride + 1, (y + 1) * stride), y * width * 4);
    }
    return { width, height, pixels };
}
async function save(page) {
    const before = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.waitForFunction(
        (n) => window.__myPaintPersistenceTest.writes.length > n && !document.querySelector('.busy'),
        before,
    );
    return decodeProject(
        Uint8Array.from(await page.evaluate(() => [...window.__myPaintPersistenceTest.writes.at(-1).bytes])),
        desktopLimits,
    );
}
try {
    for (const options of [
        { alpha: 0 },
        { alpha: 1 },
        { alpha: 128 },
        { alpha: 255 },
        { alpha: 0, background: 128 },
        { alpha: 128, background: 128 },
        { alpha: 128, background: 0 },
        { alpha: 0, hidden: true },
    ]) {
        const name = `text-alpha${options.alpha}-background${options.background ?? 'none'}-${options.hidden ? 'hidden' : 'visible'}`;
        const record = { name, options },
            context = await browser.newContext({
                viewport: { width: 1400, height: 1000 },
                deviceScaleFactor: 1,
            }),
            page = await context.newPage();
        result.cases.push(record);
        page.setDefaultTimeout(20000);
        page.on('pageerror', (error) => result.errors.push({ name, message: error.message }));
        page.on('request', (request) => {
            if (/\.js(?:[?#]|$)/.test(request.url()) && !result.assets.includes(request.url()))
                result.assets.push(request.url());
        });
        try {
            const state = createState(320, 180, [0, 0, 0, 0], desktopLimits),
                pixels = state.layers[0].pixels;
            for (let i = 0; i < pixels.length; i += 4) pixels.set([193, 71, 117, 0], i);
            pixels.set([40, 100, 200, options.alpha], (4 * 320 + 4) * 4);
            pixels.set([60, 180, 80, options.background ?? 128], (4 * 320 + 8) * 4);
            state.layers[0].visible = !options.hidden;
            const original = hash(pixels);
            await page.addInitScript(installNativeHarness, {});
            await page.goto(result.url);
            await page.waitForFunction(
                () =>
                    window.__myPaintPersistenceTest?.generation === 1 &&
                    !document.querySelector('dialog[open]'),
            );
            await page.evaluate(
                (bytes) => window.__myPaintPersistenceTest.queueOpen('alpha.rpaint', Uint8Array.from(bytes)),
                [...encodeProject(state, desktopLimits)],
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
                x = box.x + (box.width - 320) / 2,
                y = box.y + (box.height - 180) / 2;
            await page.getByRole('button', { name: '연필', exact: true }).click();
            await page.mouse.click(x + 300.5, y + 170.5);
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            await page.getByRole('button', { name: '스포이트', exact: true }).click();
            if (options.background !== undefined) {
                await page.mouse.click(x + 8.5, y + 4.5);
                await page.getByRole('button', { name: '전경색 보조색 바꾸기', exact: true }).click();
            }
            await page.mouse.click(x + 4.5, y + 4.5);
            // Brush opacity is a separate setting and must not multiply text ink alpha.
            await page.locator('#opacity').evaluate((input) => {
                input.value = '1';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await page.getByRole('button', { name: '글꼴 · 문자 설정', exact: true }).click();
            const dialog = page.getByRole('dialog');
            await dialog.getByLabel('크기 (px)', { exact: true }).fill('32');
            await dialog
                .getByLabel('문자 배경', { exact: true })
                .selectOption(options.background === undefined ? '투명' : '보조색');
            await dialog.getByRole('button', { name: '확인', exact: true }).click();
            await page.getByRole('button', { name: '문자', exact: true }).click();
            await page.mouse.click(x + 32, y + 32);
            const editor = page.getByRole('textbox', { name: /문자 입력/ });
            await editor.fill('MMMM');
            record.preview = await editor.evaluate((element) => ({
                color: getComputedStyle(element).color,
                background: getComputedStyle(element).backgroundColor,
                width: element.clientWidth,
                height: element.clientHeight,
                value: element.value,
            }));
            const writes = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
            await page.getByRole('button', { name: '이미지 내보내기', exact: true }).click();
            await page.getByRole('dialog').getByRole('button', { name: '내보내기', exact: true }).click();
            await page.waitForFunction(
                (n) => window.__myPaintPersistenceTest.writes.length > n && !document.querySelector('.busy'),
                writes,
            );
            const bytes = Uint8Array.from(
                await page.evaluate(() => [...window.__myPaintPersistenceTest.writes.at(-1).bytes]),
            );
            const image = png(bytes);
            let maxAlpha = 0,
                nonzero = 0;
            for (let yy = 32; yy < Math.min(180, 32 + record.preview.height); yy++)
                for (let xx = 32; xx < Math.min(320, 32 + record.preview.width); xx++) {
                    const a = image.pixels[(yy * 320 + xx) * 4 + 3];
                    maxAlpha = Math.max(maxAlpha, a);
                    if (a) nonzero++;
                }
            const expectedMax = Math.round(
                options.alpha + (options.background ?? 0) * (1 - options.alpha / 255),
            );
            record.png = {
                sha256: hash(bytes),
                maxAlpha,
                nonzero,
                expectedMax,
                blankAlpha: image.pixels[(33 * 320 + 33) * 4 + 3],
            };
            await fs.writeFile(path.join(path.dirname(output), name + '.png'), bytes);
            assert.equal(await editor.inputValue(), 'MMMM', 'Export must preserve pending text');
            const css = record.preview.color.match(/^rgba?\((.+)\)$/);
            assert(css);
            const channels = css[1].split(',').map(Number);
            assert.equal(
                Math.round((channels[3] ?? 1) * 255),
                options.alpha,
                'Editor preview alpha must match picked ink',
            );
            assert.equal(maxAlpha, expectedMax, 'PNG glyph/background alpha must compose exactly once');
            if (expectedMax) assert(nonzero > 0);
            else assert.equal(nonzero, 0);
            if (options.background !== undefined)
                assert.equal(
                    record.png.blankAlpha,
                    options.background,
                    'Blank text background must retain secondary alpha',
                );
            await editor.press('Escape');
            const cancelled = await save(page);
            assert.equal(hash(cancelled.layers[0].pixels), original);
            assert.equal(cancelled.layers[0].visible, !options.hidden);
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            await page.mouse.click(x + 32, y + 32);
            await page.getByRole('textbox', { name: /문자 입력/ }).fill('MMMM');
            const committed = await save(page),
                expectedChange = expectedMax > 0 || options.hidden;
            assert.equal(committed.layers[0].visible, true);
            if (!expectedChange) {
                assert.equal(hash(committed.layers[0].pixels), original);
                assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
                assert(!(await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled()));
            } else {
                if (!expectedMax) assert.equal(hash(committed.layers[0].pixels), original);
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                const undone = await save(page);
                assert.equal(hash(undone.layers[0].pixels), original);
                assert.equal(undone.layers[0].visible, !options.hidden);
                assert(!(await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled()));
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                const redone = await save(page);
                assert.equal(hash(redone.layers[0].pixels), hash(committed.layers[0].pixels));
                assert.equal(redone.layers[0].visible, true);
            }
            record.ok = true;
            result.checks.push(name);
        } catch (error) {
            record.error = String(error.stack || error);
            result.failures.push({ name, error: record.error });
        } finally {
            await context.close();
        }
    }
    assert.deepEqual(result.errors, []);
} catch (error) {
    result.failures.push({ error: String(error.stack || error) });
} finally {
    await browser.close();
    result.ok = result.checks.length === 8 && !result.errors.length && !result.failures.length;
    await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(
        JSON.stringify({
            output,
            ok: result.ok,
            checks: result.checks.length,
            failures: result.failures.map((f) => ({
                name: f.name,
                error: f.error.split('\n').slice(0, 2).join(' '),
            })),
            observations: result.cases.map((c) => ({ name: c.name, preview: c.preview, png: c.png })),
        }),
    );
    if (!result.ok) process.exitCode = 1;
}
