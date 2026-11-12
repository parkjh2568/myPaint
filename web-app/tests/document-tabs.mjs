import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.addInitScript(installNativeHarness, {});
try {
    await page.goto(process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/');
    await page.waitForFunction(
        () => window.__myPaintPersistenceTest?.generation >= 1 && !document.querySelector('.busy'),
    );
    for (const [name, color] of [
        ['A.rpaint', [255, 0, 0, 255]],
        ['B.rpaint', [0, 0, 255, 255]],
    ]) {
        const bytes = encodeProject(createState(16, 16, color, desktopLimits), desktopLimits);
        await page.evaluate(
            ({ name, bytes }) => window.__myPaintPersistenceTest.queueOpen(name, bytes, name),
            { name, bytes: [...bytes] },
        );
        await page.getByRole('button', { name: '파일 열기', exact: true }).click();
        await page.getByRole('tab', { name, exact: true }).waitFor();
    }
    assert.equal(await page.getByRole('tablist', { name: '그림 탭' }).getByRole('tab').count(), 3);
    for (const [name, color] of [
        ['A.rpaint', [255, 0, 0, 255]],
        ['B.rpaint', [0, 0, 255, 255]],
    ]) {
        await page.getByRole('tab', { name, exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.busy'));
        const count = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
        await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
        await page.waitForFunction((n) => window.__myPaintPersistenceTest.writes.length > n, count);
        const write = await page.evaluate(() => {
            const w = window.__myPaintPersistenceTest.writes.at(-1);
            return { ...w, bytes: [...w.bytes] };
        });
        assert.deepEqual(
            [...decodeProject(Uint8Array.from(write.bytes), desktopLimits).layers[0].pixels.slice(0, 4)],
            color,
        );
        assert.equal(write.path, name);
    }
    await page.getByRole('button', { name: '파일 및 편집 메뉴' }).click();
    await page.getByRole('tab', { name: '설정', exact: true }).click();
    await page.getByRole('button', { name: '테마 · 환경설정', exact: true }).last().waitFor();
    assert.equal(await page.getByRole('button', { name: '이미지 크기', exact: true }).count(), 0);
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    await page.getByRole('button', { name: 'A.rpaint 탭 닫기', exact: true }).click();
    assert.equal(await page.getByRole('tablist', { name: '그림 탭' }).getByRole('tab').count(), 2);
} finally {
    await browser.close();
}
