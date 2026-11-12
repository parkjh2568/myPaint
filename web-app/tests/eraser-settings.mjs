// Public UI regression. The native bridge is modeled, not an actual OS package.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
await page.addInitScript(installNativeHarness, {});
async function ready() {
    await page.waitForFunction(
        () => window.__myPaintPersistenceTest?.generation >= 1 && !document.querySelector('.busy'),
    );
}
async function save() {
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
try {
    await page.goto(process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/');
    await ready();
    const initial = await save();
    assert.equal(
        initial.layers[0].pixels.every((v) => v === 0),
        true,
    );
    assert.deepEqual(initial.background, [0, 0, 0, 0]);
    for (const layerCount of [1, 2])
        for (const mode of ['transparent', 'background'])
            for (const square of [false, true]) {
                const state = createState(64, 64, [40, 120, 200, 255], desktopLimits);
                if (layerCount === 2)
                    state.layers.push({ ...state.layers[0], pixels: state.layers[0].pixels.slice() });
                state.active = layerCount - 1;
                const generation = await page.evaluate(() => window.__myPaintPersistenceTest.generation);
                await page.evaluate(
                    (bytes) =>
                        window.__myPaintPersistenceTest.queueOpen('input.rpaint', Uint8Array.from(bytes)),
                    Array.from(encodeProject(state, desktopLimits)),
                );
                await page.getByRole('button', { name: '파일 열기', exact: true }).click();
                await page.waitForFunction(
                    (g) => window.__myPaintPersistenceTest.generation > g && !document.querySelector('.busy'),
                    generation,
                );
                await page.getByRole('button', { name: '지우개', exact: true }).click();
                await page.locator('#eraser-mode').selectOption(mode);
                if (mode === 'background')
                    await page.locator('#eraser-color').evaluate((input) => {
                        input.value = '#aa55ff';
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    });
                await page.locator('#square').setChecked(square);
                const box = await page.locator('.workspace canvas').boundingBox();
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                const changed = await save(),
                    at = (32 * 64 + 32) * 4;
                assert.deepEqual(
                    Array.from(changed.layers[changed.active].pixels.slice(at, at + 4)),
                    mode === 'transparent' ? [0, 0, 0, 0] : [170, 85, 255, 255],
                );
                assert.deepEqual(changed.background, state.background);
                if (layerCount === 2) assert.deepEqual(changed.layers[0], state.layers[0]);
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                assert.deepEqual(await save(), state);
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                assert.deepEqual(await save(), changed);
            }
    await page.reload();
    await ready();
    assert.equal(await page.locator('#eraser-mode').inputValue(), 'background');
    assert.equal(await page.locator('#eraser-color').inputValue(), '#aa55ff');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.getByRole('button', { name: '테마 · 환경설정', exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '테마 · 환경설정', exact: true }).click();
    assert.equal(await page.locator('dialog[open]').count(), 1);
    console.log(
        'PASS: initial alpha, both eraser modes, single/multiple layers, round/square, history, preference reload, narrow settings access',
    );
} finally {
    await browser.close();
}
