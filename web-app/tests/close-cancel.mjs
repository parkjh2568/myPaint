import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, encodePng, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';

// Public UI with a modeled native bridge; real filesystem collision tests live in Rust.
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
const initial = createState(64, 64, [0, 0, 0, 0], desktopLimits);
const files = [
    ['A.rpaint', encodeProject(initial, desktopLimits)],
    ['B.png', encodePng(64, 64, initial.layers[0].pixels, desktopLimits)],
];
let checked = 0;
async function previewPixels(page) {
    await page.getByRole('button', { name: '이미지 내보내기', exact: true }).click();
    const preview = page.locator('.export-preview[data-state=ready] canvas');
    await preview.waitFor();
    const pixels = await preview.evaluate((node) => node.toDataURL());
    await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
    return createHash('sha256').update(pixels).digest('hex');
}
try {
    for (const desktop of [false, true]) {
        for (const action of desktop
            ? [
                  'cancel-active-close',
                  'cancel-close',
                  'discard-close',
                  'cancel-picker',
                  'failed-save',
                  'save-close',
                  'cancel-quit',
                  'cancel-quit-picker',
                  'failed-quit',
                  'failed-quit-ipc',
              ]
            : ['cancel-active-close', 'cancel-close', 'discard-close']) {
            const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
            const page = await context.newPage();
            page.setDefaultTimeout(15000);
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            try {
                if (desktop) await page.addInitScript(installNativeHarness, {});
                await page.goto(process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/');
                await page.locator('canvas[data-ready=true]').waitFor();
                for (const [name, bytes] of files) {
                    if (desktop) {
                        await page.evaluate(
                            ({ name, bytes }) => window.__myPaintPersistenceTest.queueOpen(name, bytes, name),
                            { name, bytes: [...bytes] },
                        );
                        await page.getByRole('button', { name: '파일 열기', exact: true }).click();
                    } else {
                        const chooser = page.waitForEvent('filechooser');
                        await page.getByRole('button', { name: '파일 열기', exact: true }).click();
                        await (
                            await chooser
                        ).setFiles({
                            name,
                            mimeType: 'application/octet-stream',
                            buffer: Buffer.from(bytes),
                        });
                    }
                    await page.waitForFunction(
                        (name) =>
                            document
                                .querySelector('[role=tab][aria-selected=true]')
                                ?.textContent.includes(name) && !document.querySelector('.busy'),
                        name,
                    );
                }
                await page.getByRole('button', { name: '연필', exact: true }).click();
                const canvas = page.locator('.workspace canvas');
                let box = await canvas.boundingBox();
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                await page.getByRole('tab', { name: 'A.rpaint', exact: true }).click();
                await page.waitForFunction(() => !document.querySelector('.busy'));
                box = await canvas.boundingBox();
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                const redoPixels = await previewPixels(page);
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                await page.getByRole('button', { name: '문자', exact: true }).click();
                await page.mouse.click(box.x + box.width / 2 - 20, box.y + box.height / 2 - 20);
                const editor = page.getByRole('textbox', { name: /문자 입력/ });
                await editor.fill('Pending A');
                const before = await previewPixels(page);
                const native = desktop
                    ? await page.evaluate(() => ({
                          generation: window.__myPaintPersistenceTest.generation,
                          key: window.__myPaintPersistenceTest.key,
                      }))
                    : undefined;
                if (desktop)
                    await page.evaluate((action) => {
                        const state = window.__myPaintPersistenceTest;
                        if (action.includes('picker')) state.savePicks.push(null);
                        if (action.startsWith('failed'))
                            state.failNext(
                                action === 'failed-quit-ipc' ? 'close_window' : 'write_selected',
                                'Injected close failure',
                            );
                    }, action);
                if (action.includes('quit')) {
                    await page.evaluate(() => window.dispatchEvent(new Event('mypaint-close-request')));
                    await page
                        .getByRole('dialog')
                        .getByRole('button', { name: '저장하지 않고 버리기', exact: true })
                        .click();
                } else
                    await page
                        .getByRole('button', {
                            name: `${action === 'cancel-active-close' ? 'A.rpaint' : 'B.png'} 탭 닫기`,
                            exact: true,
                        })
                        .click();
                const dialog = page.getByRole('dialog');
                assert.match(
                    await dialog.textContent(),
                    action === 'cancel-active-close' ? /A.rpaint/ : /B.png/,
                );
                const save =
                    action.includes('picker') ||
                    (action.startsWith('failed') && action !== 'failed-quit-ipc') ||
                    action === 'save-close';
                await dialog
                    .getByRole('button', {
                        name: save
                            ? '저장'
                            : ['discard-close', 'failed-quit-ipc'].includes(action)
                              ? '저장하지 않고 버리기'
                              : '취소',
                        exact: true,
                    })
                    .click();
                if (action.startsWith('failed'))
                    await page.locator('.status').filter({ hasText: 'Injected close failure' }).waitFor();
                await page.waitForFunction(
                    () => !document.querySelector('.busy') && !document.querySelector('dialog[open]'),
                );
                assert.equal(await editor.inputValue(), 'Pending A', action);
                assert.equal(
                    await page.getByRole('tab', { name: /^A\.rpaint/ }).getAttribute('aria-selected'),
                    'true',
                );
                assert.equal(await previewPixels(page), before);
                assert.equal(
                    await page.getByRole('tablist', { name: '그림 탭' }).getByRole('tab').count(),
                    ['discard-close', 'save-close'].includes(action) ? 2 : 3,
                );
                if (desktop) {
                    const state = await page.evaluate(() => {
                        const value = window.__myPaintPersistenceTest;
                        return {
                            generation: value.generation,
                            key: value.key,
                            closes: value.calls.filter((call) => call.command === 'close_window').length,
                            writes: value.writes.map((write) => ({ ...write, bytes: [...write.bytes] })),
                        };
                    });
                    assert.equal(state.generation, native.generation);
                    assert.equal(state.key, native.key);
                    assert.equal(state.closes, action === 'failed-quit-ipc' ? 1 : 0);
                    if (action === 'save-close') {
                        assert.equal(state.writes.length, 1);
                        assert.equal(state.writes[0].name, 'B.rpaint');
                        assert.notDeepEqual(
                            decodeProject(Uint8Array.from(state.writes[0].bytes), desktopLimits).layers[0]
                                .pixels,
                            initial.layers[0].pixels,
                        );
                    } else assert.equal(state.writes.length, 0);
                }
                await page.getByRole('button', { name: '실행 취소', exact: true }).click(); // Cancel the pending text.
                const redo = page.getByRole('button', { name: '다시 실행', exact: true });
                assert.equal(await redo.isEnabled(), true);
                await redo.click();
                assert.equal(await previewPixels(page), redoPixels);
                assert.deepEqual(errors, []);
                checked++;
                console.log(
                    `${desktop ? 'native bridge' : 'web'} ${action}: pending edit, pixels and Redo preserved`,
                );
            } finally {
                await context.close();
            }
        }
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        await page.addInitScript(installNativeHarness, {});
        await page.goto(process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/');
        await page.locator('canvas[data-ready=true]').waitFor();
        for (const name of ['A.rpaint', 'C.rpaint']) {
            await page.evaluate(
                ({ name, bytes }) => window.__myPaintPersistenceTest.queueOpen(name, bytes, name),
                { name, bytes: [...files[0][1]] },
            );
            await page.getByRole('button', { name: '파일 열기', exact: true }).click();
            await page.waitForFunction(
                (name) =>
                    document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes(name) &&
                    !document.querySelector('.busy'),
                name,
            );
        }
        await page.evaluate(() =>
            window.__myPaintPersistenceTest.savePicks.push({ name: 'A.rpaint', path: 'A.rpaint' }),
        );
        await page.getByRole('button', { name: '이미지 내보내기', exact: true }).click();
        await page.locator('.export-preview[data-state=ready]').waitFor();
        await page.getByRole('dialog').getByRole('button', { name: '내보내기', exact: true }).click();
        await page.locator('.status').filter({ hasText: 'Export cannot replace an open project' }).waitFor();
        const protectedBytes = await page.evaluate(() => ({
            bytes: [...window.__myPaintPersistenceTest.files.get('A.rpaint').bytes],
            writes: window.__myPaintPersistenceTest.writes.length,
        }));
        assert.deepEqual(protectedBytes.bytes, [...files[0][1]]);
        assert.equal(protectedBytes.writes, 0);
        assert.equal(
            await page.getByRole('tab', { name: 'C.rpaint', exact: true }).getAttribute('aria-selected'),
            'true',
        );
        await page.evaluate(() =>
            window.__myPaintPersistenceTest.savePicks.push({ name: 'safe.png', path: 'safe.png' }),
        );
        await page.getByRole('button', { name: '이미지 내보내기', exact: true }).click();
        await page.locator('.export-preview[data-state=ready]').waitFor();
        await page.getByRole('dialog').getByRole('button', { name: '내보내기', exact: true }).click();
        await page.waitForFunction(
            () => window.__myPaintPersistenceTest.writes.length === 1 && !document.querySelector('.busy'),
        );
        assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.writes[0].path), 'safe.png');
        checked++;
        console.log('native bridge export conflict: inactive project preserved, safe export retries');
    } finally {
        await context.close();
    }
    console.log(`Close cancellation: ${checked} public UI cases passed`);
} finally {
    await browser.close();
}
