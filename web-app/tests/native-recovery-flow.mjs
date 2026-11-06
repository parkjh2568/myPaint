import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createState, cloneState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output =
    process.env.PAINT_NATIVE_RECOVERY_FLOW_OUTPUT ||
    '../build-web-work/task-planning/current-tests/native-recovery-flow/results.json';
await fs.mkdir(path.dirname(output), { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const harness = await fs.readFile(new URL('./native-harness.mjs', import.meta.url), 'utf8');
await fs.writeFile(path.join(path.dirname(output), 'native-harness.mjs'), harness);
await fs.copyFile(new URL(import.meta.url), path.join(path.dirname(output), 'driver.mjs'));
const source = createState(32, 24, [11, 29, 47, 63], desktopLimits);
source.layers[0].name = '원본 아래 hidden RGB';
source.layers.push(
    {
        name: '활성 반투명 ✏️',
        visible: true,
        pixels: new Uint8ClampedArray(3072),
    },
    { name: '숨김 원문', visible: false, pixels: new Uint8ClampedArray(3072) },
);
source.active = 1;
for (let i = 0; i < 768; i++) {
    source.layers[0].pixels.set([13, 79, 153, i % 3 ? 191 : 0], i * 4);
    source.layers[1].pixels.set([207, 91, 43, i % 4 ? 127 : 0], i * 4);
    source.layers[2].pixels.set([37, 149, 233, i % 2 ? 255 : 0], i * 4);
}
const backup = cloneState(source);
backup.layers[1].name = '복구의 활성';
backup.layers[1].pixels.set([37, 149, 233, 231], 0);
const sourceBytes = encodeProject(source, desktopLimits),
    backupBytes = encodeProject(backup, desktopLimits);
await fs.writeFile(path.join(path.dirname(output), 'source.rpaint'), sourceBytes);
await fs.writeFile(path.join(path.dirname(output), 'backup.rpaint'), backupBytes);
const result = {
    scope: 'Actual Chromium public buttons, trusted pointer editing, native-save/readback codec Workers and500ms production startup callback. Corrected in-memory native IPC clears recovery tokens on every list exactly like Rust. Explicit held IPC promise controls overlap; no private Studio access, OS picker/native filesystem/WKWebView/physical device/performance claim.',
    url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
    driverSha256: hash(await fs.readFile(new URL(import.meta.url))),
    harnessSha256: hash(Buffer.from(harness)),
    assets: [],
    cases: [],
    errors: [],
};
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
result.browser = browser.version();
const pendingAssets = [];
async function clickMenu(page, name) {
    await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click({ force: true });
    const dialog = page.locator('dialog').filter({ has: page.locator('.menu-grid') });
    await dialog.getByRole('button', { name, exact: true }).click({ force: true });
    await dialog.waitFor({ state: 'detached' });
}
async function saveReadback(page, record, label) {
    const count = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    await page
        .getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true })
        .click({ force: true });
    await page.waitForFunction(
        (count) => window.__myPaintPersistenceTest.writes.length > count && !document.querySelector('.busy'),
        count,
    );
    const bytes = Uint8Array.from(
        await page.evaluate(() => Array.from(window.__myPaintPersistenceTest.writes.at(-1).bytes)),
    );
    const name = `${record.name}-${label}.rpaint`;
    await fs.writeFile(path.join(path.dirname(output), name), bytes);
    record.files ??= [];
    record.files.push({ name, sha256: hash(bytes), size: bytes.length });
    return decodeProject(bytes, desktopLimits);
}
async function drawPoint(page, x, y) {
    await page.getByRole('button', { name: '연필', exact: true }).click({ force: true });
    await page.getByRole('button', { name: '화면에 맞추기', exact: true }).click({ force: true });
    const box = await page.locator('.workspace canvas').boundingBox();
    await page.mouse.click(box.x + box.width / 2 - 16 + x + 0.5, box.y + box.height / 2 - 12 + y + 0.5);
}
try {
    const specifications = [];
    for (const schedule of ['manual-first', 'startup-first'])
        for (const action of ['열기', '선택 사본 삭제'])
            specifications.push({
                name: `${schedule}-${action === '열기' ? 'open' : 'delete'}`,
                schedule,
                action,
            });
    for (const control of ['list-error', 'dialog-cancel', 'read-error'])
        specifications.push({
            name: `guard-release-${control}`,
            schedule: 'guard-release',
            action: '열기',
            control,
        });
    for (const specification of specifications) {
        const { schedule, action, control } = specification;
        const record = { ...specification, checks: {} };
        result.cases.push(record);
        const context = await browser.newContext({
            viewport: { width: 1280, height: 900 },
        });
        try {
            await context.addInitScript(installNativeHarness, {});
            const page = await context.newPage();
            page.setDefaultTimeout(12000);
            page.on('pageerror', (error) =>
                result.errors.push({ case: record.name, message: error.message }),
            );
            page.on('response', (response) => {
                if (/\.(?:js|css)(?:[?#]|$)/.test(response.url()))
                    pendingAssets.push(
                        response
                            .body()
                            .catch(async () => {
                                const fetched = await context.request.get(response.url());
                                assert(fetched.ok());
                                return fetched.body();
                            })
                            .then((bytes) => {
                                if (!result.assets.some((a) => a.url === response.url()))
                                    result.assets.push({
                                        url: response.url(),
                                        sha256: hash(bytes),
                                        size: bytes.length,
                                    });
                            }),
                    );
            });
            const clockTime = new Date('2026-11-06T00:00:00.000Z');
            await page.clock.install({ time: clockTime });
            await page.clock.pauseAt(new Date(clockTime.getTime() + 1000));
            await page.goto(result.url);
            await page.clock.runFor(32);
            await page.waitForSelector('canvas[data-ready=true]');
            await page.waitForFunction(() => window.__myPaintPersistenceTest.generation === 1);
            await page.evaluate(
                (bytes) => window.__myPaintPersistenceTest.queueOpen('source.rpaint', Uint8Array.from(bytes)),
                Array.from(sourceBytes),
            );
            await page.getByRole('button', { name: '파일 열기', exact: true }).click({ force: true });
            await page.waitForFunction(
                () => window.__myPaintPersistenceTest.generation === 2 && !document.querySelector('.busy'),
            );
            assert.deepEqual(await saveReadback(page, record, 'opened'), source);
            await drawPoint(page, 2, 2);
            const saved = await saveReadback(page, record, 'saved-before-redo');
            assert.notDeepEqual(saved, source);
            await drawPoint(page, 3, 3);
            const redone = await saveReadback(page, record, 'redo-target');
            await page.getByRole('button', { name: '실행 취소', exact: true }).click({ force: true });
            // Mark the returned older revision saved while retaining its forward branch, using the normal Save command.
            const before = await saveReadback(page, record, 'source-before');
            assert.deepEqual(before, saved);
            assert.notDeepEqual(before, redone);
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            await page.evaluate(
                (bytes) =>
                    window.__myPaintPersistenceTest.addRecovery({
                        key: 'backup-current',
                        sequence: 1,
                        name: '선택한 복구 사본',
                        bytes: Uint8Array.from(bytes),
                        source: 'native',
                    }),
                Array.from(backupBytes),
            );
            record.assumptions = {
                fixtureExact: true,
                savedRevisionWithOldRedo: true,
                startupNotYetListed: await page.evaluate(
                    () => !window.__myPaintPersistenceTest.calls.some((c) => c.command === 'recovery_list'),
                ),
            };
            assert(record.assumptions.startupNotYetListed);
            if (control) {
                if (control === 'list-error') {
                    await page.evaluate(() =>
                        window.__myPaintPersistenceTest.failNext(
                            'recovery_list',
                            'Injected recovery list failure',
                        ),
                    );
                    await clickMenu(page, '복구 사본');
                    await page.waitForFunction(() =>
                        document
                            .querySelector('.status')
                            ?.textContent.includes('Injected recovery list failure'),
                    );
                } else {
                    await clickMenu(page, '복구 사본');
                    await page.getByLabel('시각 · 이름', { exact: true }).waitFor();
                    await page.getByLabel('시각 · 이름', { exact: true }).selectOption({ index: 0 });
                    if (control === 'dialog-cancel')
                        await page
                            .getByRole('dialog')
                            .getByRole('button', { name: '취소', exact: true })
                            .click({ force: true });
                    else {
                        await page.evaluate(() =>
                            window.__myPaintPersistenceTest.failNext(
                                'recovery_read',
                                'Injected recovery read failure',
                            ),
                        );
                        await page
                            .getByRole('dialog')
                            .getByRole('button', { name: '확인', exact: true })
                            .click({ force: true });
                        await page.waitForFunction(
                            () =>
                                document
                                    .querySelector('.status')
                                    ?.textContent.includes('Injected recovery read failure') &&
                                !document.querySelector('.busy'),
                        );
                    }
                }
                await page.waitForFunction(
                    () => !document.querySelector('dialog[open]') && !document.querySelector('.busy'),
                );
                record.controlStatus = await page.locator('.status').textContent();
                assert.deepEqual(await saveReadback(page, record, 'control-source'), before);
                assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
                await page.getByRole('button', { name: '다시 실행', exact: true }).click({ force: true });
                assert.deepEqual(await saveReadback(page, record, 'control-redo'), redone);
                await page.getByRole('button', { name: '실행 취소', exact: true }).click({ force: true });
                assert.deepEqual(await saveReadback(page, record, 'control-clean-restored'), before);
                record.checks.failureOrCancelPreservesSourceRedo = true;
            }
            if (schedule === 'startup-first') {
                await page.evaluate(() => window.__myPaintPersistenceTest.holdNext('recovery_list'));
                await page.clock.runFor(600);
                await page.waitForFunction(() =>
                    window.__myPaintPersistenceTest.pending.has('recovery_list'),
                );
            }
            await clickMenu(page, '복구 사본');
            if (schedule === 'startup-first') {
                const issued = await page.evaluate(
                    () =>
                        window.__myPaintPersistenceTest.calls.filter((c) => c.command === 'recovery_list')
                            .length,
                );
                record.manualCoalesced = issued === 1;
                if (record.manualCoalesced)
                    await page.evaluate(() => window.__myPaintPersistenceTest.release('recovery_list'));
            }
            await page.getByLabel('시각 · 이름', { exact: true }).waitFor();
            await page.getByLabel('시각 · 이름', { exact: true }).selectOption({ index: 0 });
            await page.getByLabel('동작', { exact: true }).selectOption(action);
            record.listCallsAtDialog = await page.evaluate(
                () =>
                    window.__myPaintPersistenceTest.calls.filter((c) => c.command === 'recovery_list').length,
            );
            if (schedule === 'manual-first') await page.clock.runFor(600);
            else if (schedule === 'startup-first' && !record.manualCoalesced)
                await page.evaluate(() => window.__myPaintPersistenceTest.release('recovery_list'));
            await page.waitForFunction(() => !window.__myPaintPersistenceTest.pending.has('recovery_list'));
            record.listCallsAfterOverlap = await page.evaluate(
                () =>
                    window.__myPaintPersistenceTest.calls.filter((c) => c.command === 'recovery_list').length,
            );
            record.openDialogsBeforeConfirm = await page.getByRole('dialog').count();
            const command = action === '열기' ? 'recovery_read' : 'recovery_clear';
            const calls = await page.evaluate(
                (command) =>
                    window.__myPaintPersistenceTest.calls.filter((c) => c.command === command).length,
                command,
            );
            await page
                .getByRole('dialog')
                .getByRole('button', { name: '확인', exact: true })
                .click({ force: true });
            await page.waitForFunction(
                ({ command, calls }) =>
                    window.__myPaintPersistenceTest.calls.filter((c) => c.command === command).length >
                        calls && !document.querySelector('.busy'),
                { command, calls },
            );
            record.status = await page.locator('.status').textContent();
            record.expired = /만료|변경/.test(record.status);
            record.currentTitle = await page.locator('.title').textContent();
            const after = await saveReadback(page, record, 'source-after');
            record.sourcePreserved = isDeepStrictEqual(after, before);
            record.backupPresent = await page.evaluate(() =>
                window.__myPaintPersistenceTest.recoveries.has('backup-current'),
            );
            record.redoAvailable = await page
                .getByRole('button', { name: '다시 실행', exact: true })
                .isEnabled();
            if (record.redoAvailable) {
                await page.getByRole('button', { name: '다시 실행', exact: true }).click({ force: true });
                assert.deepEqual(await saveReadback(page, record, 'redo-after'), redone);
                record.redoExact = true;
                await page.getByRole('button', { name: '실행 취소', exact: true }).click({ force: true });
            }
            record.calls = await page.evaluate(() =>
                window.__myPaintPersistenceTest.calls.map((c) => ({
                    command: c.command,
                    args: c.args,
                })),
            );
            record.checks.noExpiredCapability = !record.expired;
            record.checks.oneDialog = record.openDialogsBeforeConfirm === 1;
            record.checks.listOwnerReleasedOrSerialized = record.listCallsAfterOverlap === (control ? 2 : 1);
            if (action === '열기') {
                record.checks.recoveryOpenedExact = isDeepStrictEqual(after, backup);
                record.checks.backupKept = record.backupPresent;
            } else {
                record.checks.sourceAndRedoPreserved = record.sourcePreserved && record.redoExact;
                record.checks.backupDeleted = !record.backupPresent;
            }
            record.ok = Object.values(record.checks).every(Boolean);
        } catch (error) {
            record.ok = false;
            record.error = error.stack || String(error);
        } finally {
            await Promise.all(pendingAssets);
            await context.close();
        }
        await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
        console.log(
            JSON.stringify({
                case: record.name,
                ok: record.ok,
                status: record.status,
                expired: record.expired,
                sourcePreserved: record.sourcePreserved,
                redoExact: record.redoExact,
                listCalls: [record.listCallsAtDialog, record.listCallsAfterOverlap],
                error: record.error,
            }),
        );
    }
} finally {
    await browser.close();
}
result.ok = result.cases.every((c) => c.ok) && result.errors.length === 0;
await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(
    JSON.stringify({
        output,
        ok: result.ok,
        cases: result.cases.length,
        errors: result.errors.length,
        sha256: hash(await fs.readFile(output)),
    }),
);
if (!result.ok) process.exitCode = 1;
