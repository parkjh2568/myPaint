import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
        const bytes = encodeProject(createState(64, 64, color, desktopLimits), desktopLimits);
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
        await page.waitForFunction(
            (n) => window.__myPaintPersistenceTest.writes.length > n && !document.querySelector('.busy'),
            count,
        );
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
    const firstTab = page.locator('[data-tab]').filter({ hasText: 'A.rpaint' });
    await firstTab.click();
    await page.waitForFunction(() => !document.querySelector('.busy'));
    const firstKey = await firstTab.getAttribute('data-tab');
    assert(firstKey);
    assert.equal(await page.title().then((title) => title.startsWith('*')), false);
    await page.getByRole('button', { name: '문자', exact: true }).click();
    const canvas = await page.locator('.workspace canvas').boundingBox();
    assert(canvas);
    await page.mouse.click(canvas.x + canvas.width / 2 - 24, canvas.y + canvas.height / 2 - 24);
    await page.getByRole('textbox', { name: /문자 입력/ }).fill('ABC');
    assert.equal(await page.title().then((title) => title.startsWith('*')), false);
    await page.getByRole('tab', { name: 'B.rpaint', exact: true }).click();
    await page.waitForFunction(
        (key) => window.__myPaintPersistenceTest.recoveryWrites.some((write) => write.key === key),
        firstKey,
    );
    const backup = await page.evaluate(
        (key) => [...window.__myPaintPersistenceTest.recoveries.get(key).bytes],
        firstKey,
    );
    const recovered = decodeProject(Uint8Array.from(backup), desktopLimits);
    assert.notDeepEqual(recovered.layers[0].pixels, createState(64, 64, [255, 0, 0, 255]).layers[0].pixels);
    await firstTab.click();
    await page.waitForFunction(() => !document.querySelector('.busy'));
    const count = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.waitForFunction(
        (n) => window.__myPaintPersistenceTest.writes.length > n && !document.querySelector('.busy'),
        count,
    );
    const written = await page.evaluate(() => {
        const write = window.__myPaintPersistenceTest.writes.at(-1);
        return { path: write.path, bytes: [...write.bytes] };
    });
    assert.equal(written.path, 'A.rpaint');
    assert.deepEqual(decodeProject(Uint8Array.from(written.bytes), desktopLimits), recovered);

    await page.getByRole('button', { name: '파일 및 편집 메뉴' }).click();
    await page.getByRole('tab', { name: '설정', exact: true }).click();
    await page.getByRole('button', { name: '테마 · 환경설정', exact: true }).last().waitFor();
    assert.equal(await page.getByRole('button', { name: '이미지 크기', exact: true }).count(), 0);
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    const close = page.getByRole('button', { name: 'A.rpaint 탭 닫기', exact: true });
    await page.evaluate(() =>
        window.__myPaintPersistenceTest.failNext('activate_document', 'Injected close activation failure'),
    );
    await close.click();
    await page.locator('.status').filter({ hasText: 'Injected close activation failure' }).waitFor();
    assert.equal(await firstTab.getAttribute('aria-selected'), 'true');
    assert.equal(await page.getByRole('tablist', { name: '그림 탭' }).getByRole('tab').count(), 3);
    await close.click();
    await firstTab.waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('tablist', { name: '그림 탭' }).getByRole('tab').count(), 2);
    const closed = await page.evaluate((key) => {
        const native = window.__myPaintPersistenceTest;
        return {
            closed: !native.tabBindings.has(key) && !native.tabGenerations.has(key),
            recoveries: native.recoveryWrites.filter((write) => write.key === key).length,
            bytes: [...native.recoveries.get(key).bytes],
        };
    }, firstKey);
    assert.equal(closed.closed, true);
    assert.equal(closed.recoveries, 1);
    assert.deepEqual(closed.bytes, backup);
    console.log('Document tabs: bindings, pending recovery, failed close, and successful release passed.');

    const web = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    await web.addInitScript(() => {
        const nativeCreate = URL.createObjectURL.bind(URL),
            nativeRevoke = URL.revokeObjectURL.bind(URL),
            post = Worker.prototype.postMessage;
        window.downloadTest = { created: [], revoked: [] };
        URL.createObjectURL = (blob) => {
            const url = nativeCreate(blob);
            if (blob.type === 'application/octet-stream') window.downloadTest.created.push(url);
            return url;
        };
        URL.revokeObjectURL = (url) => {
            window.downloadTest.revoked.push(url);
            nativeRevoke(url);
        };
        Worker.prototype.postMessage = function (message, ...options) {
            if (window.downloadTest.hold && message.operation === 'project-write') return;
            return post.call(this, message, ...options);
        };
    });
    await web.goto(process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/');
    const saveProject = web.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true });
    const tabs = web.getByRole('tablist', { name: '그림 탭' }).getByRole('tab');
    const file = web.getByRole('button', { name: '파일 받기', exact: true });
    for (const key of ['Enter', 'Space', 'Escape']) {
        await web.evaluate(() => (window.downloadTest.hold = true));
        await saveProject.focus();
        await web.keyboard.press('Enter');
        const cancel = web.locator('.busy').getByRole('button', { name: '취소', exact: true });
        await cancel.waitFor();
        assert.equal(await cancel.evaluate((element) => element === document.activeElement), true);
        await web.keyboard.press(key);
        await cancel.waitFor({ state: 'detached' });
        assert.equal(await saveProject.evaluate((element) => element === document.activeElement), true);
        await web.locator('.status').filter({ hasText: '작업을 취소했습니다' }).waitFor();
    }
    await web.evaluate(() => (window.downloadTest.hold = false));
    await saveProject.click();
    await file.waitFor();
    const firstUrl = await web.evaluate(() => window.downloadTest.created.at(-1));
    await web.getByRole('button', { name: '새 그림 탭', exact: true }).click();
    const newDialog = web.getByRole('dialog').filter({ has: web.getByLabel('너비', { exact: true }) });
    await newDialog.getByLabel('너비', { exact: true }).fill('16');
    await newDialog.getByLabel('높이', { exact: true }).fill('8');
    await newDialog.getByRole('button', { name: '확인', exact: true }).click();
    await file.waitFor({ state: 'detached' });
    await saveProject.click();
    await file.waitFor();
    const secondUrl = await web.evaluate(() => window.downloadTest.created.at(-1));
    assert.notEqual(secondUrl, firstUrl);
    await tabs.nth(0).click();
    await file.waitFor();
    const downloaded = web.waitForEvent('download');
    await file.click();
    assert.equal(decodeProject(new Uint8Array(await readFile(await (await downloaded).path()))).width, 800);
    const closeSecond = web.locator('.document-tab').nth(1).locator('[data-close-tab]');
    await closeSecond.focus();
    await web.keyboard.press('Enter');
    await closeSecond.waitFor({ state: 'detached' });
    assert.equal(await tabs.nth(0).evaluate((element) => element === document.activeElement), true);
    assert.deepEqual(await web.evaluate(() => window.downloadTest.revoked), [secondUrl]);
    await web.evaluate(() => document.querySelector('[data-command="layer-add"]').click());
    await tabs.nth(0).filter({ hasText: '●' }).waitFor();
    assert.equal(await tabs.nth(0).evaluate((element) => element === document.activeElement), true);
    await web.getByRole('button', { name: '다운로드 닫기', exact: true }).click();
    assert.deepEqual(await web.evaluate(() => window.downloadTest.revoked), [secondUrl, firstUrl]);
    console.log('Document tabs: keyboard cancel/focus and per-tab web downloads passed.');
    await web.close();
} finally {
    await browser.close();
}
