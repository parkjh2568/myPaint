import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { decodeProject } from '../src/engine/format.ts';
const output = path.resolve(
    process.env.PAINT_RECOVERY_FAULT_OUTPUT ||
        '../build-web-work/task-planning/recovery-snapshot-contract/ui/results.json',
);
const hash = (b) => createHash('sha256').update(b).digest('hex');
const result = {
    scope: 'Public normal-web editing, actual production timer callback/Worker/IndexedDB and project readback. Test-only fault injection replaces selected Worker reply once; not a naturally observed normal-Worker fault or OS/native/device claim.',
    driverSha256: hash(await fs.readFile(new URL(import.meta.url))),
    url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
    sourceSha256: {},
    assets: [],
    cases: [],
    errors: [],
};
for (const f of ['main.ts', 'platform/storage.ts', 'platform/codec.ts'])
    result.sourceSha256[f] = hash(await fs.readFile(new URL('../src/' + f, import.meta.url)));
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
function instrument() {
    const p = (window.recoveryFault = {
        mode: 'valid',
        observing: false,
        attempts: 0,
        blobs: [],
        tick: undefined,
        initial: false,
        release: undefined,
    });
    const interval = window.setInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => {
        if (delay === 30000 && typeof callback === 'function') {
            p.tick = async () => {
                p.observing = true;
                try {
                    return await callback(...args);
                } finally {
                    p.observing = false;
                }
            };
            return 0;
        }
        return interval(callback, delay, ...args);
    };
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => {
        p.blobs.push(b);
        return create(b);
    };
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
        const tx = Reflect.apply(transaction, this, args);
        if (this.name === 'retropaint-local-v1' && tx.mode === 'readonly')
            tx.addEventListener('complete', () => (p.initial = true), { once: true });
        return tx;
    };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
        mode;
        owner = false;
        postMessage(value, transfer) {
            if (value.operation === 'project-write' && p.observing) {
                p.attempts++;
                this.owner = true;
                this.mode = p.mode;
                p.mode = 'valid';
            }
            return super.postMessage(value, transfer);
        }
        set onmessage(listener) {
            this.addEventListener('message', (event) => {
                if (!this.owner) return listener.call(this, event);
                let data = event.data;
                if (this.mode === 'missing') data = { profileId: data.profileId };
                else if (this.mode === 'null') data = { profileId: data.profileId, bytes: null };
                else if (this.mode === 'empty') data = { profileId: data.profileId, bytes: new Uint8Array() };
                else if (this.mode === 'error' || this.mode === 'hold-error')
                    data = { profileId: data.profileId, error: 'injected recovery codec failure' };
                if (this.mode === 'hold-error') {
                    p.release = () => listener.call(this, { data });
                    return;
                }
                listener.call(this, { data });
            });
        }
    };
}
async function project(page) {
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.getByRole('button', { name: '파일 받기', exact: true }).waitFor();
    const bytes = await page.evaluate(async () =>
        Array.from(new Uint8Array(await window.recoveryFault.blobs.at(-1).arrayBuffer())),
    );
    await page.getByRole('button', { name: '다운로드 닫기', exact: true }).click();
    return Uint8Array.from(bytes);
}
async function stored(page) {
    return page.evaluate(async () => {
        const db = await new Promise((r, j) => {
            const q = indexedDB.open('retropaint-local-v1', 1);
            q.onsuccess = () => r(q.result);
            q.onerror = () => j(q.error);
        });
        try {
            return await new Promise((r, j) => {
                const t = db.transaction(['heads', 'snapshots']);
                const q = t.objectStore('heads').getAll();
                let values = [];
                q.onsuccess = () => {
                    values = q.result;
                };
                t.oncomplete = async () => {
                    const bytes = [];
                    for (const entry of values) {
                        const tx = db.transaction('snapshots');
                        const blob = await new Promise((res, rej) => {
                            const req = tx.objectStore('snapshots').get(entry.key);
                            req.onsuccess = () => res(req.result);
                            req.onerror = () => rej(req.error);
                        });
                        bytes.push(Array.from(new Uint8Array(await blob.arrayBuffer())));
                    }
                    r({ heads: values, bytes });
                };
                t.onabort = () => j(t.error);
            });
        } finally {
            db.close();
        }
    });
}
await fs.mkdir(path.dirname(output), { recursive: true });
try {
    for (const mode of (
        process.env.PAINT_RECOVERY_FAULT_CASES || 'missing,null,empty,error,hold-error'
    ).split(',')) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }),
            record = { mode };
        result.cases.push(record);
        try {
            await context.addInitScript(instrument);
            const page = await context.newPage();
            const responses = [];
            page.on('response', (response) => {
                if (/\.js(?:[?#]|$)/.test(response.url()))
                    responses.push(
                        response.body().then((bytes) => {
                            const sha256 = hash(bytes);
                            if (!result.assets.some((asset) => asset.url === response.url()))
                                result.assets.push({ url: response.url(), sha256 });
                        }),
                    );
            });
            context.pendingResponses = responses;
            page.on('pageerror', (e) => result.errors.push(e.message));
            page.setDefaultTimeout(15000);
            await page.goto(result.url);
            await page.waitForFunction(
                () =>
                    window.recoveryFault?.initial &&
                    window.recoveryFault.tick &&
                    document.querySelector('.workspace canvas')?.dataset.ready === 'true',
            );
            await page.getByRole('button', { name: '연필', exact: true }).click();
            const c = await page.locator('.workspace canvas').boundingBox(),
                z = Math.min(1, (c.width - 32) / 800, (c.height - 32) / 600),
                x = c.x + (c.width - 800 * z) / 2,
                y = c.y + (c.height - 600 * z) / 2;
            await page.mouse.click(x + 20 * z, y + 20 * z);
            await page.evaluate(() => window.recoveryFault.tick());
            record.seed = await stored(page);
            assert.equal(record.seed.heads.length, 1);
            await page.mouse.click(x + 21 * z, y + 21 * z);
            await page.mouse.click(x + 22 * z, y + 22 * z);
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            const expected = decodeProject(await project(page));
            record.expectedPixelSha256 = expected.layers.map((l) => hash(l.pixels));
            if (mode === 'hold-error') {
                await page.evaluate(() => {
                    window.recoveryFault.mode = 'hold-error';
                    window.recoveryFault.pending = window.recoveryFault.tick();
                });
                await page.waitForFunction(() => window.recoveryFault.release);
                await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
                await page.getByRole('dialog').getByRole('button', { name: '새 그림', exact: true }).click();
                await page.getByLabel('너비', { exact: true }).fill('64');
                await page.getByLabel('높이', { exact: true }).fill('64');
                await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
                await page
                    .getByRole('dialog')
                    .getByRole('button', { name: '저장하지 않고 버리기', exact: true })
                    .click();
                await page.waitForFunction(
                    () =>
                        document.querySelector('.document-info')?.textContent.includes('64 × 64') &&
                        !document.querySelector('dialog[open]'),
                );
                const nextDocument = decodeProject(await project(page));
                record.nextDocumentBefore = {
                    width: nextDocument.width,
                    height: nextDocument.height,
                    pixelSha256: nextDocument.layers.map((layer) => hash(layer.pixels)),
                };
                record.statusBefore = await page.locator('.status').textContent();
                await page.evaluate(async () => {
                    window.recoveryFault.release();
                    await window.recoveryFault.pending;
                });
                record.statusAfter = await page.locator('.status').textContent();
                record.oldBackup = await stored(page);
                assert.equal(
                    record.statusAfter,
                    record.statusBefore,
                    'Old-document recovery error must not overwrite current-document status',
                );
                assert.deepEqual(record.oldBackup, record.seed);
                assert.deepEqual(decodeProject(await project(page)), nextDocument);
                const nextCanvas = await page.locator('.workspace canvas').boundingBox();
                await page.mouse.click(
                    nextCanvas.x + nextCanvas.width / 2 - 22,
                    nextCanvas.y + nextCanvas.height / 2 - 22,
                );
                const nextEdited = decodeProject(await project(page));
                await page.evaluate(() => window.recoveryFault.tick());
                record.nextBackups = await stored(page);
                assert.equal(record.nextBackups.heads.length, 2);
                const previous = record.nextBackups.heads.findIndex(
                        (entry) => entry.key === record.seed.heads[0].key,
                    ),
                    next = 1 - previous;
                assert(previous >= 0);
                assert.deepEqual(record.nextBackups.bytes[previous], record.seed.bytes[0]);
                assert.deepEqual(decodeProject(Uint8Array.from(record.nextBackups.bytes[next])), nextEdited);
                record.nextDocumentPreservedAndRecovered = true;
            } else {
                await page.evaluate(async (mode) => {
                    window.recoveryFault.mode = mode;
                    await window.recoveryFault.tick();
                }, mode);
                record.afterFault = await stored(page);
                record.status = await page.locator('.status').textContent();
                assert.match(record.status, /^복구 저장 실패:/);
                assert.deepEqual(record.afterFault, record.seed, 'Rejected reply preserves prior backup');
                record.attemptsAfterFault = await page.evaluate(() => window.recoveryFault.attempts);
                await page.evaluate(() => window.recoveryFault.tick());
                record.attemptsAfterRetry = await page.evaluate(() => window.recoveryFault.attempts);
                record.afterRetry = await stored(page);
                assert.equal(
                    record.attemptsAfterRetry,
                    record.attemptsAfterFault + 1,
                    'Same revision must retry after invalid recovery output',
                );
                assert.equal(record.afterRetry.heads.length, 1);
                const recovered = decodeProject(Uint8Array.from(record.afterRetry.bytes[0]));
                assert.deepEqual(recovered, expected);
                assert.deepEqual(decodeProject(await project(page)), expected);
                assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            }
            record.ok = true;
        } catch (error) {
            record.ok = false;
            record.error = String(error.stack || error);
        } finally {
            await Promise.all(context.pendingResponses || []);
            await context.close();
            await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
        }
    }
} finally {
    await browser.close();
    result.ok =
        result.cases.length ===
            (process.env.PAINT_RECOVERY_FAULT_CASES || 'missing,null,empty,error,hold-error').split(',')
                .length &&
        result.cases.every((c) => c.ok) &&
        !result.errors.length;
    await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(
        JSON.stringify({
            ok: result.ok,
            cases: result.cases.map(({ mode, ok, error }) => ({ mode, ok, error })),
        }),
    );
    if (!result.ok) process.exitCode = 1;
}
