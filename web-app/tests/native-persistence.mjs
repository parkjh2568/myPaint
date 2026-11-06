import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createState, composite, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, encodePng, decodeProject, decodePng } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output =
    process.env.PAINT_NATIVE_PERSISTENCE_OUTPUT ||
    '../build-web-work/task-planning/native-persistence/client.json';
await fs.mkdir(path.dirname(output), { recursive: true });
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const results = {
    checks: [],
    errors: [],
    failures: [],
    browser: browser.version(),
    scope: 'Public UI in Chromium with an in-memory native IPC/filesystem model. This verifies client ownership and routing, not actual OS I/O, WKWebView, permissions or atomic replacement.',
};
const url = process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/';
const projectA = createState(64, 64, [0, 0, 0, 0], desktopLimits);
projectA.layers[0].pixels.set([45, 72, 183, 255], 0);
const projectB = createState(80, 48, [0, 0, 0, 0], desktopLimits);
projectB.layers[0].pixels.set([203, 19, 45, 128], 0);
const bytesA = encodeProject(projectA, desktopLimits),
    bytesB = encodeProject(projectB, desktopLimits);
const image = encodePng(64, 64, projectA.layers[0].pixels, desktopLimits);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function boot(options = {}) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } }),
        page = await context.newPage();
    page.setDefaultTimeout(45000);
    page.on('pageerror', (error) => results.errors.push(error.message));
    await page.addInitScript(installNativeHarness, options);
    await page.clock.install();
    await page.goto(url);
    await page.waitForSelector('canvas[data-ready=true]');
    if (options.initFailure) await page.getByRole('button', { name: '다시 시도', exact: true }).waitFor();
    else if (options.holdStartupList)
        await page.waitForFunction(() => window.__myPaintPersistenceTest.pending.has('recovery_list'));
    else {
        await page.waitForFunction(() =>
            window.__myPaintPersistenceTest.calls.some((call) => call.command === 'recovery_list'),
        );
        await page.waitForFunction(() => window.__myPaintPersistenceTest.idbOpens > 0);
    }
    return { context, page };
}
async function menu(page, name) {
    await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
}
async function open(page, name, bytes) {
    const id = await page.evaluate(
        ({ name, bytes }) => window.__myPaintPersistenceTest.queueOpen(name, Uint8Array.from(bytes)),
        { name, bytes: Array.from(bytes) },
    );
    await page.getByRole('button', { name: '파일 열기', exact: true }).click();
    await page.waitForFunction(
        (name) =>
            document.querySelector('.title')?.textContent.includes(name) && !document.querySelector('.busy'),
        name,
    );
    return id;
}
async function save(page, shortcut = false) {
    const count = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    if (shortcut) {
        await page.locator('.workspace canvas').focus();
        await page.keyboard.press('Control+s');
    } else await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.waitForFunction(
        (count) => window.__myPaintPersistenceTest.writes.length > count && !document.querySelector('.busy'),
        count,
    );
    return page.evaluate(() => {
        const written = window.__myPaintPersistenceTest.writes.at(-1);
        return {
            name: written.name,
            path: written.path,
            generation: written.generation,
            project: written.project,
            bytes: Array.from(written.bytes),
        };
    });
}
async function png(page) {
    const count = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    await page.getByRole('button', { name: '이미지 내보내기', exact: true }).click();
    await page.getByLabel('형식', { exact: true }).selectOption('png');
    await page.getByRole('dialog').getByRole('button', { name: '내보내기', exact: true }).click();
    await page.waitForFunction(
        (count) => window.__myPaintPersistenceTest.writes.length > count && !document.querySelector('.busy'),
        count,
    );
    const bytes = await page.evaluate(() => Array.from(window.__myPaintPersistenceTest.writes.at(-1).bytes));
    return decodePng(Uint8Array.from(bytes), desktopLimits);
}
async function stroke(page, offset = 0) {
    await page.getByRole('button', { name: '연필', exact: true }).click();
    const box = await page.locator('.workspace canvas').boundingBox(),
        x = box.x + box.width / 2,
        y = box.y + box.height / 2 + offset;
    await page.mouse.move(x - 8, y);
    await page.mouse.down();
    await page.mouse.move(x + 8, y, { steps: 4 });
    await page.mouse.up();
    await page.waitForFunction(() => document.title.startsWith('*'));
}
async function newDocument(page, discard = false) {
    const generation = await page.evaluate(() => window.__myPaintPersistenceTest.generation);
    await menu(page, '새 그림');
    await page.getByLabel('너비', { exact: true }).fill('64');
    await page.getByLabel('높이', { exact: true }).fill('64');
    await page.getByLabel('배경', { exact: true }).selectOption('투명');
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
    if (discard) {
        await page
            .getByRole('dialog')
            .getByRole('button', { name: '저장하지 않고 버리기', exact: true })
            .click();
    }
    await page.waitForFunction(
        (generation) =>
            window.__myPaintPersistenceTest.generation > generation &&
            document.querySelector('.document-info')?.textContent.includes('64 × 64') &&
            !document.querySelector('.busy'),
        generation,
    );
}
async function recovery(page, name, action = '열기', confirm = true) {
    await menu(page, '복구 사본');
    const field = page.getByLabel('시각 · 이름', { exact: true });
    const value = await field.evaluate(
        (select, name) => [...select.options].find((option) => option.textContent.includes(name))?.value,
        name,
    );
    assert(value, 'Recovery entry missing: ' + name);
    await field.selectOption(value);
    await page.getByLabel('동작', { exact: true }).selectOption(action);
    if (confirm) await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
}
async function seedRecovery(page, name, bytes, source = 'native', key = 'backup-a') {
    await page.evaluate(
        ({ name, bytes, source, key }) =>
            window.__myPaintPersistenceTest.addRecovery({
                key,
                sequence: 1,
                name,
                bytes: Uint8Array.from(bytes),
                source,
            }),
        { name, bytes: Array.from(bytes), source, key },
    );
}
const cases = [
    [
        'Close save picker cancellation preserves pending text, source bytes and Undo, and allows editing',
        async (page) => {
            const input = await open(page, 'source.png', image);
            await stroke(page);
            const box = await page.locator('.workspace canvas').boundingBox();
            await page.getByRole('button', { name: '문자', exact: true }).click();
            await page.mouse.click(box.x + box.width / 2 - 24, box.y + box.height / 2 - 24);
            const editor = page.getByRole('textbox', { name: /문자 입력/ });
            await editor.fill('A');
            const before = await png(page),
                writes = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length),
                pickers = await page.evaluate(() => window.__myPaintPersistenceTest.pickerCount);
            await page.evaluate(() => {
                window.__myPaintPersistenceTest.savePicks.push(null);
                window.dispatchEvent(new Event('mypaint-close-request'));
            });
            await page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }).click();
            await page.waitForFunction(
                (pickers) =>
                    window.__myPaintPersistenceTest.pickerCount === pickers + 1 &&
                    !document.querySelector('.busy'),
                pickers,
            );
            assert.equal(
                await page.evaluate(
                    () =>
                        window.__myPaintPersistenceTest.calls.filter(
                            (call) => call.command === 'close_window',
                        ).length,
                ),
                0,
            );
            assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.writes.length), writes);
            assert.equal(await page.evaluate(() => document.querySelector('#app').inert), false);
            assert.equal(await editor.inputValue(), 'A');
            assert.equal(await editor.evaluate((element) => element.readOnly), false);
            assert.deepEqual(await png(page), before);
            assert.deepEqual(
                Uint8Array.from(
                    await page.evaluate(
                        (id) => Array.from(window.__myPaintPersistenceTest.files.get(id).bytes),
                        input,
                    ),
                ),
                image,
            );
            await editor.fill('B');
            assert.notDeepEqual((await png(page)).pixels, before.pixels);
            await editor.press('Escape');
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual((await png(page)).pixels, projectA.layers[0].pixels);
        },
    ],
    [
        'Close save write failure preserves pending text, binding and original file, and permits retry',
        async (page) => {
            const input = await open(page, 'project-a.rpaint', bytesA);
            await stroke(page);
            const box = await page.locator('.workspace canvas').boundingBox();
            await page.getByRole('button', { name: '문자', exact: true }).click();
            await page.mouse.click(box.x + box.width / 2 - 24, box.y + box.height / 2 - 24);
            const editor = page.getByRole('textbox', { name: /문자 입력/ });
            await editor.fill('A');
            const before = await png(page);
            await page.evaluate(() => {
                window.__myPaintPersistenceTest.failNext('write_selected', 'Injected close save failure');
                window.dispatchEvent(new Event('mypaint-close-request'));
            });
            await page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }).click();
            await page.getByRole('status').filter({ hasText: 'Injected close save failure' }).waitFor();
            assert.equal(
                await page.evaluate(
                    () =>
                        window.__myPaintPersistenceTest.calls.filter(
                            (call) => call.command === 'close_window',
                        ).length,
                ),
                0,
            );
            assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.binding.path), input);
            assert.equal(await page.evaluate(() => document.querySelector('#app').inert), false);
            assert.equal(await editor.inputValue(), 'A');
            assert.equal(await editor.evaluate((element) => element.readOnly), false);
            assert.deepEqual(await png(page), before);
            assert.deepEqual(
                Uint8Array.from(
                    await page.evaluate(
                        (id) => Array.from(window.__myPaintPersistenceTest.files.get(id).bytes),
                        input,
                    ),
                ),
                bytesA,
            );
            await editor.fill('B');
            assert.notDeepEqual((await png(page)).pixels, before.pixels);
            await editor.press('Escape');
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            const retry = await save(page);
            assert.equal(retry.path, input);
            assert.deepEqual(decodeProject(Uint8Array.from(retry.bytes), desktopLimits), projectA);
        },
    ],
    [
        'Approved close freezes input; close IPC failure restores drawing, Undo and saving',
        async (page) => {
            const input = await open(page, 'project-a.rpaint', bytesA),
                before = await png(page),
                box = await page.locator('.workspace canvas').boundingBox();
            await page.evaluate(() => {
                window.__myPaintPersistenceTest.holdNext('close_window');
                window.dispatchEvent(new Event('mypaint-close-request'));
            });
            await page.waitForFunction(() => window.__myPaintPersistenceTest.pending.has('close_window'));
            assert.equal(await page.evaluate(() => document.querySelector('#app').inert), true);
            await page.mouse.move(box.x + box.width / 2 - 8, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2);
            await page.mouse.up();
            await page.keyboard.press('Control+n');
            assert.equal(await page.getByRole('dialog').count(), 0);
            await page.evaluate(() => window.dispatchEvent(new Event('mypaint-close-request')));
            assert.equal(
                await page.evaluate(
                    () =>
                        window.__myPaintPersistenceTest.calls.filter(
                            (call) => call.command === 'close_window',
                        ).length,
                ),
                1,
            );
            await page.evaluate(async () => {
                window.__myPaintPersistenceTest.failNext('close_window', 'Injected close IPC failure');
                await window.__myPaintPersistenceTest.release('close_window');
            });
            await page.getByRole('status').filter({ hasText: 'Injected close IPC failure' }).waitFor();
            assert.equal(await page.evaluate(() => document.querySelector('#app').inert), false);
            assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.binding.path), input);
            assert.deepEqual(await png(page), before);
            await stroke(page);
            assert.notDeepEqual((await png(page)).pixels, before.pixels);
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await png(page), before);
            const retry = await save(page);
            assert.equal(retry.path, input);
            assert.deepEqual(decodeProject(Uint8Array.from(retry.bytes), desktopLimits), projectA);
        },
    ],
    [
        'image open cannot silently overwrite its source as a project',
        async (page) => {
            const input = await open(page, 'image.rpaint', image);
            assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.binding), undefined);
            await page.evaluate(() =>
                window.__myPaintPersistenceTest.savePicks.push({ name: 'converted.rpaint' }),
            );
            const saved = await save(page);
            assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.pickerCount), 1);
            assert.notEqual(saved.path, input);
            assert(saved.project);
            const original = await page.evaluate(
                (id) => Array.from(window.__myPaintPersistenceTest.files.get(id).bytes),
                input,
            );
            assert.deepEqual(Uint8Array.from(original), image);
        },
    ],
    [
        'opened project Ctrl+S reuses its path and image export cannot hijack binding',
        async (page) => {
            const input = await open(page, 'project-a.rpaint', bytesA);
            await stroke(page);
            const first = await save(page, true);
            assert.equal(first.path, input);
            assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.pickerCount), 0);
            await png(page);
            assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.binding.path), input);
            const pickerCount = await page.evaluate(() => window.__myPaintPersistenceTest.pickerCount);
            const second = await save(page, true);
            assert.equal(second.path, input);
            assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.pickerCount), pickerCount);
        },
    ],
    [
        'cancelled Save As preserves binding, pending text and prior Undo history',
        async (page) => {
            const input = await open(page, 'project-a.rpaint', bytesA);
            await stroke(page);
            await save(page);
            const box = await page.locator('.workspace canvas').boundingBox();
            await page.getByRole('button', { name: '문자', exact: true }).click();
            await page.mouse.click(box.x + box.width / 2 - 24, box.y + box.height / 2 - 24);
            const editor = page.getByRole('textbox', { name: /문자 입력/ });
            await editor.fill('pending 한글');
            const before = await png(page);
            await page.evaluate(() => window.__myPaintPersistenceTest.savePicks.push(null));
            await menu(page, '프로젝트 다른 이름 저장');
            await page.waitForFunction(() => !document.querySelector('.busy'));
            assert.equal(await editor.inputValue(), 'pending 한글');
            assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.binding.path), input);
            assert.equal(hash((await png(page)).pixels), hash(before.pixels));
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.equal(await editor.count(), 0);
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual((await png(page)).pixels, composite(projectA, desktopLimits));
        },
    ],
    [
        'held native save freezes its input owner and cancellation keeps pending edits',
        async (page) => {
            const input = await open(page, 'project-a.rpaint', bytesA),
                box = await page.locator('.workspace canvas').boundingBox();
            await page.getByRole('button', { name: '문자', exact: true }).click();
            await page.mouse.click(box.x + box.width / 2 - 24, box.y + box.height / 2 - 24);
            const editor = page.getByRole('textbox', { name: /문자 입력/ });
            await editor.fill('owned pending');
            await page.evaluate(() => window.__myPaintPersistenceTest.holdNext('write_selected'));
            await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
            await page.waitForFunction(() => window.__myPaintPersistenceTest.pending.has('write_selected'));
            const generation = await page.evaluate(() => window.__myPaintPersistenceTest.generation);
            await page.keyboard.press('Control+n');
            assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.generation), generation);
            assert.equal(await editor.evaluate((element) => element.readOnly), true);
            await page.locator('.busy').getByRole('button', { name: '취소', exact: true }).click();
            await page.evaluate(() => window.__myPaintPersistenceTest.release('write_selected'));
            await page.waitForFunction(() => !document.querySelector('.busy'));
            assert.equal(await editor.inputValue(), 'owned pending');
            assert.equal(await editor.evaluate((element) => element.readOnly), false);
            assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.binding.path), input);
            assert.deepEqual(
                Uint8Array.from(
                    await page.evaluate(
                        (id) => Array.from(window.__myPaintPersistenceTest.files.get(id).bytes),
                        input,
                    ),
                ),
                bytesA,
            );
        },
    ],
    [
        'late native read after cancellation cannot replace the document or binding',
        async (page) => {
            const input = await open(page, 'project-a.rpaint', bytesA);
            await page.evaluate((bytes) => {
                const native = window.__myPaintPersistenceTest;
                native.queueOpen('project-b.rpaint', Uint8Array.from(bytes));
                native.holdNext('read_selected');
            }, Array.from(bytesB));
            await page.getByRole('button', { name: '파일 열기', exact: true }).click();
            await page.waitForFunction(() => window.__myPaintPersistenceTest.pending.has('read_selected'));
            await page.keyboard.press('Control+n');
            assert.equal(await page.locator('.document-info').textContent(), '64 × 64 px');
            await page.locator('.busy').getByRole('button', { name: '취소', exact: true }).click();
            await page.evaluate(() => window.__myPaintPersistenceTest.release('read_selected'));
            await page.waitForFunction(() => !document.querySelector('.busy'));
            assert.equal((await save(page, true)).path, input);
            assert.deepEqual(
                decodeProject(
                    Uint8Array.from(
                        await page.evaluate(() =>
                            Array.from(window.__myPaintPersistenceTest.writes.at(-1).bytes),
                        ),
                    ),
                    desktopLimits,
                ),
                projectA,
            );
        },
    ],
    [
        'delayed manual recovery list cannot open over a newly activated document',
        async (page) => {
            await seedRecovery(page, 'old recovery', bytesB);
            await page.evaluate(() => window.__myPaintPersistenceTest.holdNext('recovery_list'));
            await menu(page, '복구 사본');
            await page.waitForFunction(() => window.__myPaintPersistenceTest.pending.has('recovery_list'));
            await newDocument(page);
            const generation = await page.evaluate(() => window.__myPaintPersistenceTest.generation);
            await page.evaluate(() => window.__myPaintPersistenceTest.release('recovery_list'));
            await save(page);
            assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.generation), generation);
            assert.equal(await page.getByRole('dialog').count(), 0);
            assert.equal(await page.locator('.document-info').textContent(), '64 × 64 px');
            assert.equal(
                await page.evaluate(
                    () =>
                        window.__myPaintPersistenceTest.calls.filter(
                            (call) => call.command === 'recovery_read',
                        ).length,
                ),
                0,
            );
        },
    ],
    [
        'rejected old recovery discovery preserves the new document status, pixels and Redo',
        async (page) => {
            await open(page, 'old-document.rpaint', bytesA);
            await page.evaluate(() => window.__myPaintPersistenceTest.holdNext('recovery_list'));
            await menu(page, '복구 사본');
            await page.waitForFunction(() => window.__myPaintPersistenceTest.pending.has('recovery_list'));
            await open(page, 'new-document.rpaint', bytesB);
            await stroke(page);
            const before = decodeProject(Uint8Array.from((await save(page)).bytes), desktopLimits);
            await stroke(page, 8);
            const redo = decodeProject(Uint8Array.from((await save(page)).bytes), desktopLimits);
            assert.notDeepEqual(before, redo);
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(decodeProject(Uint8Array.from((await save(page)).bytes), desktopLimits), before);
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            const status = await page.locator('.status').textContent(),
                title = await page.title(),
                generation = await page.evaluate(() => window.__myPaintPersistenceTest.generation);
            await page.evaluate(() => {
                const model = window.__myPaintPersistenceTest;
                model.failNext('recovery_list', 'Old document discovery failure');
                model.release('recovery_list');
            });
            await page.clock.runFor(32);
            assert.equal(
                await page.evaluate(() => window.__myPaintPersistenceTest.failures.has('recovery_list')),
                false,
                'The held old request must actually reject before checking the new document',
            );
            assert.equal(await page.locator('.status').textContent(), status);
            assert.equal(await page.title(), title);
            assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.generation), generation);
            assert.equal(await page.getByRole('dialog').count(), 0);
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            assert.deepEqual(decodeProject(Uint8Array.from((await save(page)).bytes), desktopLimits), before);
            await page.getByRole('button', { name: '다시 실행', exact: true }).click();
            assert.deepEqual(decodeProject(Uint8Array.from((await save(page)).bytes), desktopLimits), redo);
            await menu(page, '복구 사본');
            await page.waitForFunction(() =>
                document.querySelector('.status')?.textContent.includes('복구 사본이 없습니다.'),
            );
            assert.equal(
                await page.evaluate(
                    () =>
                        window.__myPaintPersistenceTest.calls.filter(
                            (call) => call.command === 'recovery_list',
                        ).length,
                ),
                3,
                'Startup, rejected old request and new request must remain independently owned',
            );
        },
    ],
    [
        'Qt legacy restore remains read-only and stale recovery deletion preserves the newer snapshot',
        async (page) => {
            await open(page, 'project-a.rpaint', bytesA);
            await seedRecovery(page, 'Qt legacy source', bytesB, 'legacy', 'legacy-qt');
            await seedRecovery(page, 'native current', bytesA, 'native', 'native-current');
            await recovery(page, 'Qt legacy source');
            await page.waitForFunction(
                () =>
                    document.querySelector('.document-info')?.textContent.includes('80 × 48') &&
                    !document.querySelector('.busy'),
            );
            assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.binding), undefined);
            const pickers = await page.evaluate(() => window.__myPaintPersistenceTest.pickerCount);
            await save(page);
            assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.pickerCount), pickers + 1);
            await recovery(page, 'Qt legacy source', '선택 사본 삭제');
            await page
                .getByRole('status')
                .filter({ hasText: /원본.*삭제/ })
                .waitFor();
            assert.deepEqual(
                Uint8Array.from(
                    await page.evaluate(() =>
                        Array.from(window.__myPaintPersistenceTest.recoveries.get('legacy-qt').bytes),
                    ),
                ),
                bytesB,
            );
            await recovery(page, 'native current', '선택 사본 삭제', false);
            await seedRecovery(page, 'native current newer', bytesB, 'native', 'native-current');
            await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
            await page.getByRole('status').filter({ hasText: /변경/ }).waitFor();
            assert.deepEqual(
                Uint8Array.from(
                    await page.evaluate(() =>
                        Array.from(window.__myPaintPersistenceTest.recoveries.get('native-current').bytes),
                    ),
                ),
                bytesB,
            );
        },
    ],
    [
        'visible recovery warnings do not hide a valid native snapshot',
        async (page) => {
            await seedRecovery(page, 'valid native snapshot', bytesB);
            await page.evaluate(() => {
                window.__myPaintPersistenceTest.warnings = ['이전 Qt 복구 파일이 손상되어 건너뛰었습니다.'];
            });
            await menu(page, '복구 사본');
            await page
                .getByRole('dialog')
                .getByText('이전 Qt 복구 파일이 손상되어 건너뛰었습니다.', { exact: false })
                .waitFor();
            await page.screenshot({ path: path.join(path.dirname(output), 'recovery-warning.png') });
            const field = page.getByLabel('시각 · 이름', { exact: true }),
                value = await field.evaluate(
                    (select) =>
                        [...select.options].find((option) =>
                            option.textContent.includes('valid native snapshot'),
                        )?.value,
                );
            assert(value);
            await field.selectOption(value);
            await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
            await page.waitForFunction(
                () =>
                    document.querySelector('.document-info')?.textContent.includes('80 × 48') &&
                    !document.querySelector('.busy'),
            );
        },
    ],
    [
        'background recovery completion from an old generation cannot replace a new generation backup',
        async (page) => {
            await newDocument(page);
            await stroke(page);
            await page.clock.fastForward(31000);
            await page.waitForFunction(() => window.__myPaintPersistenceTest.recoveryWrites.length === 1);
            const old = await page.evaluate(() => window.__myPaintPersistenceTest.recoveryWrites[0]);
            await stroke(page, 8);
            await page.evaluate(() => window.__myPaintPersistenceTest.holdNext('recovery_write'));
            await page.clock.fastForward(31000);
            await page.waitForFunction(() => window.__myPaintPersistenceTest.pending.has('recovery_write'));
            await newDocument(page, true);
            await page.evaluate(() => window.__myPaintPersistenceTest.release('recovery_write'));
            await stroke(page, 4);
            await page.clock.fastForward(31000);
            await page.waitForFunction(() => window.__myPaintPersistenceTest.recoveryWrites.length === 2);
            const latest = await page.evaluate(() => window.__myPaintPersistenceTest.recoveryWrites[1]);
            assert.notEqual(latest.generation, old.generation);
            assert.notEqual(latest.key, old.key);
            assert.equal(
                await page.evaluate(
                    (key) => window.__myPaintPersistenceTest.recoveries.get(key).sequence,
                    old.key,
                ),
                1,
            );
        },
    ],
    [
        'real greater-than-64MiB codec output uses native filesystem recovery without IndexedDB writes',
        async (page) => {
            await save(page);
            const generated = await page.evaluate(() => window.__myPaintPersistenceTest.createNoiseProject());
            assert(generated.bytes > 64 * 1048576);
            await page.getByRole('button', { name: '파일 열기', exact: true }).click();
            await page.waitForFunction(
                () =>
                    document.querySelector('.title')?.textContent.includes('large-noise.rpaint') &&
                    !document.querySelector('.busy'),
            );
            for (
                let step = 0;
                step < 20 && Number.parseInt(await page.locator('#zoom').textContent(), 10) < 100;
                step++
            )
                await page.getByRole('button', { name: '확대', exact: true }).click();
            await stroke(page);
            const before = await page.evaluate(() => ({
                reads: window.__myPaintPersistenceTest.idbOpens,
                writes: window.__myPaintPersistenceTest.idbWrites,
            }));
            await page.clock.fastForward(31000);
            await page.waitForFunction(() =>
                window.__myPaintPersistenceTest.recoveryWrites.some((write) => write.bytes > 64 * 1048576),
            );
            const written = await page.evaluate(() =>
                window.__myPaintPersistenceTest.recoveryWrites.find((write) => write.bytes > 64 * 1048576),
            );
            assert.notEqual(written.sha256, generated.sha256);
            assert.deepEqual(
                await page.evaluate(() => ({
                    reads: window.__myPaintPersistenceTest.idbOpens,
                    writes: window.__myPaintPersistenceTest.idbWrites,
                })),
                before,
            );
            assert.equal(written.name, 'large-noise.rpaint');
            results.largeRecovery = {
                source: generated,
                written,
                note: '4096² deterministic random RGBA encoded by the real application codec Worker; no large-byte JSON transfer or fabricated codec output.',
            };
        },
    ],
];
try {
    const initialization = await boot({ initFailure: true });
    try {
        const { page } = initialization;
        await page.getByRole('button', { name: '다시 시도', exact: true }).waitFor({ state: 'visible' });
        await page.waitForFunction(
            () =>
                ![...document.querySelectorAll('button')].find((button) => button.textContent === '다시 시도')
                    .disabled,
        );
        const initialTitle = await page.title();
        const box = await page.locator('.workspace canvas').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2);
        await page.mouse.up();
        await page.keyboard.press('Control+n');
        assert.equal(await page.title(), initialTitle);
        assert.equal(await page.evaluate(() => window.__myPaintPersistenceTest.generation), 0);
        assert.equal(await page.getByRole('dialog').count(), 1);
        await page.screenshot({ path: path.join(path.dirname(output), 'startup-failure.png') });
        await page.getByRole('button', { name: '다시 시도', exact: true }).click();
        await page.waitForFunction(
            () => window.__myPaintPersistenceTest.generation === 1 && !document.querySelector('dialog[open]'),
        );
        assert.equal(
            await page.evaluate(
                () =>
                    window.__myPaintPersistenceTest.calls.filter(
                        (call) => call.command === 'activate_document',
                    ).length,
            ),
            2,
        );
        await stroke(page);
        await save(page);
        results.checks.push(
            'Native initialization failure blocks drawing and commands; retry activates the same document and restores usable UI',
        );
    } finally {
        await initialization.context.close();
    }
    for (const [name, run] of cases) {
        const { context, page } = await boot();
        try {
            await run(page);
            results.checks.push(name);
            console.log('PASS ' + name);
        } catch (error) {
            results.failures.push({
                name,
                error: String(error.stack || error),
                state: await page.evaluate(() => ({
                    generation: window.__myPaintPersistenceTest.generation,
                    key: window.__myPaintPersistenceTest.key,
                    title: document.title,
                    calls: window.__myPaintPersistenceTest.calls,
                    recoveryWrites: window.__myPaintPersistenceTest.recoveryWrites,
                })),
                status: await page
                    .locator('.status')
                    .textContent()
                    .catch(() => undefined),
            });
            throw error;
        } finally {
            await context.close();
        }
    }
    const { context, page } = await boot({
        holdStartupList: true,
        recoveries: [
            {
                key: 'startup-legacy',
                sequence: 1,
                name: 'startup legacy',
                source: 'legacy',
                bytes: Array.from(bytesB),
            },
        ],
    });
    try {
        await stroke(page);
        await save(page);
        await page.evaluate(() => window.__myPaintPersistenceTest.release('recovery_list'));
        await save(page, true);
        assert.equal(await page.getByRole('dialog').count(), 0);
        results.checks.push(
            'Delayed startup recovery discovery does not interrupt a document edited and durably saved while discovery was pending',
        );
    } finally {
        await context.close();
    }
    assert.deepEqual(results.errors, []);
} finally {
    await fs.writeFile(output, JSON.stringify(results, null, 2) + '\n');
    await browser.close();
}
console.log(JSON.stringify(results, null, 2));
