import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject, encodePng, decodePng } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output =
    process.env.PAINT_PENDING_OUTPUT || '../build-web-work/task-planning/pending-contract/results.json';
await fs.mkdir(path.dirname(output), { recursive: true });
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const results = {
    checks: [],
    failures: [],
    errors: [],
    browser: browser.version(),
    scope: 'Production public UI with modeled native IPC/clipboard. Passive observation copies the small real codec Worker input without changing it; no Studio/document hooks. Read-only 1:1 preview upload is compared with actual PNG for pending text/curve/polygon/selection; raw state, saved/dirty UI and observable Undo/Redo are checked. Numeric revision IDs and actual OS write failures are not directly inspected.',
};
const url = process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/';
const fixture = createState(64, 64, [0, 0, 0, 0], desktopLimits);
fixture.layers[0].name = '보존할 바닥';
fixture.layers.push({ name: '활성 잉크', visible: true, pixels: new Uint8ClampedArray(64 * 64 * 4) });
fixture.active = 1;
for (let i = 0; i < 64 * 64; i++) {
    fixture.layers[0].pixels.set([i % 251, 47, 99, 255], i * 4);
    fixture.layers[1].pixels.set([91, 132, i % 239, i % 5 ? 97 : 0], i * 4);
}
const fixtureBytes = encodeProject(fixture, desktopLimits);
const pasted = createState(7, 6, [231, 18, 57, 255], desktopLimits);
pasted.layers[0].pixels.set([71, 93, 117, 128], 4);
const pastedBytes = encodePng(7, 6, pasted.layers[0].pixels, desktopLimits);
const wireFixture = {
    ...fixture,
    layers: fixture.layers.map((layer) => ({ ...layer, pixels: Array.from(layer.pixels) })),
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function observe() {
    window.pendingTrace = undefined;
    window.pendingPreview = undefined;
    window.pendingClipboard = [];
    const putImageData = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (image, ...args) {
        if (this.canvas.closest?.('.export-preview'))
            window.pendingPreview = {
                width: image.width,
                height: image.height,
                pixels: Array.from(image.data),
            };
        return putImageData.call(this, image, ...args);
    };
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
        postMessage(message, transfer) {
            if (message.operation === 'png-write') {
                const state = message.state;
                // Observe the public export boundary before transfer, leaving the real Worker untouched.
                window.pendingTrace = {
                    width: state.width,
                    height: state.height,
                    background: Array.from(state.background),
                    active: state.active,
                    layers: state.layers.map((layer) => ({ ...layer, pixels: Array.from(layer.pixels) })),
                };
            }
            return super.postMessage(message, transfer);
        }
    };
    Object.defineProperty(navigator.clipboard, 'read', {
        configurable: true,
        value: async () => [
            {
                types: ['image/png'],
                getType: async () =>
                    new Blob([Uint8Array.from(window.pendingClipboard)], { type: 'image/png' }),
            },
        ],
    });
}
async function menu(page, name) {
    await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
}
async function capture(page) {
    const count = await page.evaluate(() => {
        window.pendingTrace = undefined;
        window.pendingPreview = undefined;
        return window.__myPaintPersistenceTest.writes.length;
    });
    await page.getByRole('button', { name: '이미지 내보내기', exact: true }).click();
    await page.getByLabel('형식', { exact: true }).selectOption('png');
    await page.getByRole('dialog').getByRole('button', { name: '내보내기', exact: true }).click();
    await page.waitForFunction(
        (count) => window.__myPaintPersistenceTest.writes.length > count && !document.querySelector('.busy'),
        count,
    );
    const value = await page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const canvas = document.querySelector('.workspace canvas');
        const rendered = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', rendered));
        const editor = document.querySelector('.text-editor');
        return {
            state: window.pendingTrace,
            preview: window.pendingPreview,
            bytes: Array.from(window.__myPaintPersistenceTest.writes.at(-1).bytes),
            frame: Array.from(digest),
            title: document.title,
            pendingTitle: document.querySelector('.title').textContent,
            active: document.querySelector('.layer-row.selected .name').textContent,
            undo: !document.querySelector('[data-command=undo]').disabled,
            redo: !document.querySelector('[data-command=redo]').disabled,
            editor: editor
                ? {
                      value: editor.value,
                      left: editor.style.left,
                      top: editor.style.top,
                      width: editor.style.width,
                      height: editor.style.height,
                  }
                : null,
        };
    });
    assert(value.state, 'The export must produce a fresh Worker input observation');
    const decoded = decodePng(Uint8Array.from(value.bytes), desktopLimits);
    assert.equal(decoded.width, value.state.width);
    assert.equal(decoded.height, value.state.height);
    assert.deepEqual(
        value.preview,
        { width: decoded.width, height: decoded.height, pixels: Array.from(decoded.pixels) },
        'The 1:1 pending preview must equal actual PNG pixels before Canvas premultiplication',
    );
    delete value.preview;
    delete value.bytes;
    value.png = { width: decoded.width, height: decoded.height, sha256: hash(decoded.pixels) };
    return value;
}
async function boot() {
    const context = await browser.newContext({
        viewport: { width: 1400, height: 1000 },
        deviceScaleFactor: 1,
    });
    try {
        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        page.on('pageerror', (error) => results.errors.push(error.message));
        await page.addInitScript({
            content: '(' + installNativeHarness.toString() + ')({});(' + observe.toString() + ')();',
        });
        await page.goto(url);
        await page.waitForFunction(
            () => window.__myPaintPersistenceTest.generation === 1 && !document.querySelector('dialog[open]'),
        );
        const input = await page.evaluate(
            (bytes) => window.__myPaintPersistenceTest.queueOpen('pending.rpaint', Uint8Array.from(bytes)),
            Array.from(fixtureBytes),
        );
        await page.getByRole('button', { name: '파일 열기', exact: true }).click();
        await page.waitForFunction(
            () => window.__myPaintPersistenceTest.generation === 2 && !document.querySelector('.busy'),
        );
        await page.getByRole('button', { name: '연필', exact: true }).click();
        const box = await page.locator('.workspace canvas').boundingBox();
        const origin = { x: box.x + box.width / 2 - 32, y: box.y + box.height / 2 - 32 };
        await page.mouse.move(origin.x + 45, origin.y + 52);
        await page.mouse.down();
        await page.mouse.move(origin.x + 55, origin.y + 52);
        await page.mouse.up();
        const previousRedo = await capture(page);
        assert.notDeepEqual(previousRedo.state, wireFixture);
        await page.getByRole('button', { name: '실행 취소', exact: true }).click();
        const baseline = await capture(page);
        assert.deepEqual(baseline.state, wireFixture);
        assert.equal(baseline.title.startsWith('*'), false);
        assert.equal(baseline.undo, false);
        assert.equal(baseline.redo, true);
        return { context, page, input, origin, baseline, previousRedo };
    } catch (error) {
        await context.close();
        throw error;
    }
}
async function addPending(page, kind, origin) {
    if (kind === 'paste') {
        await page.evaluate((bytes) => {
            window.pendingClipboard = bytes;
        }, Array.from(pastedBytes));
        await menu(page, '붙여넣기');
        await page.waitForFunction(() => !document.querySelector('.busy'));
    } else if (kind === 'selection') {
        await page.getByRole('button', { name: '사각 선택', exact: true }).click();
        await page.mouse.move(origin.x + 8, origin.y + 8);
        await page.mouse.down();
        await page.mouse.move(origin.x + 32, origin.y + 32);
        await page.mouse.up();
        await page.mouse.move(origin.x + 20, origin.y + 20);
        await page.mouse.down();
        await page.mouse.move(origin.x + 27, origin.y + 25);
        await page.mouse.up();
    } else if (kind === 'text') {
        await page.getByRole('button', { name: '문자', exact: true }).click();
        await page.mouse.click(origin.x + 4, origin.y + 4);
        await page.getByRole('textbox', { name: /문자 입력/ }).fill('보존 ABC');
    } else if (kind.startsWith('curve')) {
        await page.getByRole('button', { name: '곡선', exact: true }).click();
        await page.mouse.move(origin.x + 8, origin.y + 40);
        await page.mouse.down();
        await page.mouse.move(origin.x + 40, origin.y + 12);
        await page.mouse.up();
        if (kind === 'curve1') await page.mouse.click(origin.x + 12, origin.y + 8);
    } else {
        await page.getByRole('button', { name: '다각형', exact: true }).click();
        for (const [x, y] of [
            [8, 8],
            [32, 8],
            [28, 32],
        ])
            await page.mouse.click(origin.x + x, origin.y + y);
    }
}
const kinds = ['paste', 'selection', 'text', 'curve0', 'curve1', 'polygon'];
try {
    for (const kind of kinds) {
        for (const boundary of ['save_cancel', 'save_failure', 'close_cancel', 'size_cancel']) {
            const name = kind + ' / ' + boundary;
            if (process.env.PAINT_PENDING_FILTER === 'redo') continue;
            let context;
            try {
                const run = await boot();
                ({ context } = run);
                const { page, input, origin, baseline, previousRedo } = run;
                await addPending(page, kind, origin);
                const before = await capture(page);
                assert.notDeepEqual(
                    before.state,
                    baseline.state,
                    'The pending fixture must change visible data',
                );
                assert.notDeepEqual(
                    before.png,
                    baseline.png,
                    'The pending fixture must visibly change the export',
                );
                assert.equal(
                    before.title,
                    baseline.title,
                    'Pending must not change the committed dirty state',
                );
                assert.equal(before.pendingTitle.endsWith(' · 편집 중'), true);
                assert.equal(before.undo, true);
                assert.equal(before.redo, false);
                const fileBefore = await page.evaluate((id) => {
                    const model = window.__myPaintPersistenceTest;
                    const file = model.files.get(id);
                    window.pendingEditorOwner = document.querySelector('.text-editor');
                    return {
                        bytes: Array.from(file.bytes),
                        version: file.version,
                        binding: { ...model.binding },
                    };
                }, input);
                if (boundary === 'save_cancel') {
                    await page.evaluate(() => window.__myPaintPersistenceTest.savePicks.push(null));
                    await menu(page, '프로젝트 다른 이름 저장');
                    await page.waitForFunction(() => !document.querySelector('.busy'));
                } else if (boundary === 'save_failure') {
                    await page.evaluate(() =>
                        window.__myPaintPersistenceTest.failNext(
                            'write_selected',
                            'Injected pending write failure',
                        ),
                    );
                    await page
                        .getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true })
                        .click();
                    await page
                        .getByRole('status')
                        .filter({ hasText: 'Injected pending write failure' })
                        .waitFor();
                } else if (boundary === 'close_cancel') {
                    await page.evaluate(() => window.dispatchEvent(new Event('mypaint-close-request')));
                    await page
                        .getByRole('heading', { name: '변경한 내용을 저장하시겠습니까?', exact: true })
                        .waitFor();
                    await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
                    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
                } else {
                    for (const size of ['캔버스 크기', '이미지 크기']) {
                        await menu(page, size);
                        await page.getByLabel('너비', { exact: true }).fill('79');
                        await page.getByLabel('높이', { exact: true }).fill('83');
                        await page
                            .getByRole('dialog')
                            .getByRole('button', { name: '취소', exact: true })
                            .click();
                        assert.deepEqual(
                            await capture(page),
                            before,
                            size + ' cancellation changed the pending edit',
                        );
                    }
                }
                assert.deepEqual(
                    await capture(page),
                    before,
                    'Cancellation/failure changed the public document or pending state',
                );
                assert.deepEqual(
                    await page.evaluate((id) => {
                        const model = window.__myPaintPersistenceTest;
                        const file = model.files.get(id);
                        return {
                            bytes: Array.from(file.bytes),
                            version: file.version,
                            binding: { ...model.binding },
                        };
                    }, input),
                    fileBefore,
                );
                assert.equal(
                    await page.evaluate(
                        () => window.pendingEditorOwner === document.querySelector('.text-editor'),
                    ),
                    true,
                );
                assert.equal(
                    await page.evaluate(() =>
                        window.__myPaintPersistenceTest.calls.some((call) => call.command === 'close_window'),
                    ),
                    false,
                );
                await page.locator('.workspace canvas').focus();
                await page.keyboard.press('Escape');
                const cancelled = await capture(page);
                assert.deepEqual(cancelled.state, baseline.state);
                assert.equal(cancelled.title, baseline.title);
                assert.equal(cancelled.undo, false);
                assert.equal(cancelled.redo, true);
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                assert.deepEqual(
                    (await capture(page)).state,
                    previousRedo.state,
                    'Failure consumed the old Redo branch',
                );
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                await addPending(page, kind, origin);
                assert.deepEqual((await capture(page)).state, before.state);
                const writes = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
                await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
                await page.waitForFunction(
                    (count) =>
                        window.__myPaintPersistenceTest.writes.length > count &&
                        !document.querySelector('.busy'),
                    writes,
                );
                const savedBytes = Uint8Array.from(
                    await page.evaluate(() =>
                        Array.from(window.__myPaintPersistenceTest.writes.at(-1).bytes),
                    ),
                );
                const saved = decodeProject(savedBytes, desktopLimits);
                assert.deepEqual(
                    {
                        ...saved,
                        layers: saved.layers.map((layer) => ({ ...layer, pixels: Array.from(layer.pixels) })),
                    },
                    before.state,
                );
                const committed = await capture(page);
                assert.equal(committed.title.startsWith('*'), false);
                assert.equal(committed.pendingTitle.includes('편집 중'), false);
                assert.equal(committed.editor, null);
                assert.equal(committed.undo, true);
                assert.equal(committed.redo, false);
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                const undone = await capture(page);
                assert.deepEqual(
                    undone.state,
                    baseline.state,
                    'One Undo must remove exactly the pending commit',
                );
                assert.equal(undone.title.startsWith('*'), true);
                assert.equal(undone.undo, false);
                assert.equal(undone.redo, true);
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                const redone = await capture(page);
                assert.deepEqual(redone.state, before.state);
                assert.deepEqual(redone.png, before.png);
                assert.equal(redone.title.startsWith('*'), false);
                results.checks.push(name);
                console.log('PASS', name);
            } catch (error) {
                const lines = String(error.stack || error).split('\n');
                results.failures.push({
                    name,
                    error: [
                        ...lines.slice(0, 16),
                        ...lines.filter((line) => line.trim().startsWith('at ')),
                    ].join('\n'),
                });
                console.error('FAIL', name, lines[0]);
            } finally {
                await context?.close();
            }
        }
        for (const shortcut of ['Control+Shift+z', 'Control+y']) {
            const name = kind + ' / pending ' + shortcut + ' preserves pending and Redo';
            let context, observation;
            try {
                const run = await boot();
                ({ context } = run);
                const { page, origin, baseline, previousRedo } = run;
                await addPending(page, kind, origin);
                const before = await capture(page);
                assert.notDeepEqual(before.state, baseline.state);
                assert.notDeepEqual(before.png, baseline.png);
                await page.locator('.workspace canvas').focus();
                await page.keyboard.press(shortcut);
                const blocked = await capture(page);
                observation = {};
                for (const [stage, snapshot] of [
                    ['before', before],
                    ['after', blocked],
                ])
                    observation[stage] = {
                        rawStateSha256: hash(Buffer.from(JSON.stringify(snapshot.state))),
                        canvasSha256: Buffer.from(snapshot.frame).toString('hex'),
                        title: snapshot.title,
                        pendingTitle: snapshot.pendingTitle,
                        undo: snapshot.undo,
                        redo: snapshot.redo,
                    };
                assert.deepEqual(
                    blocked,
                    before,
                    'Disabled Redo must preserve the pending edit and document',
                );
                await page.locator('.workspace canvas').focus();
                await page.keyboard.press('Escape');
                const cancelled = await capture(page);
                assert.deepEqual(cancelled.state, baseline.state);
                assert.equal(cancelled.pendingTitle.includes('편집 중'), false);
                assert.equal(cancelled.editor, null);
                assert.equal(cancelled.title, baseline.title);
                assert.equal(cancelled.undo, false);
                assert.equal(cancelled.redo, true);
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                const redone = await capture(page);
                assert.deepEqual(redone.state, previousRedo.state);
                assert.equal(redone.title.startsWith('*'), true);
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                assert.deepEqual((await capture(page)).state, baseline.state);
                results.checks.push(name);
                console.log('PASS', name);
            } catch (error) {
                const lines = String(error.stack || error).split('\n');
                results.failures.push({
                    name,
                    observation,
                    error: [
                        ...lines.slice(0, 16),
                        ...lines.filter((line) => line.trim().startsWith('at ')),
                    ].join('\n'),
                });
                console.error('FAIL', name, lines[0]);
            } finally {
                await context?.close();
            }
        }
    }
} finally {
    await browser.close();
    await fs.writeFile(output, JSON.stringify(results, null, 2) + '\n');
}
if (results.errors.length || results.failures.length) process.exitCode = 1;
console.log(
    JSON.stringify({
        checks: results.checks.length,
        failures: results.failures.length,
        errors: results.errors.length,
    }),
);
