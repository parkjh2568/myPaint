import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createState } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.PAINT_STORAGE_OUTPUT || '../build-web-work/task-planning/storage';
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const results = { checks: [], errors: [], browser: browser.version() };
page.on('pageerror', (error) => results.errors.push(error.message));
page.setDefaultTimeout(10000);
await page.addInitScript(() => {
    window.testBlobs = [];
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (this.name === 'retropaint-local-v1' && tx.mode === 'readonly')
            tx.addEventListener(
                'complete',
                () => {
                    window.testInitialRecoveryChecked = true;
                },
                { once: true },
            );
        return tx;
    };
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
        window.testBlobs.push(blob);
        return create(blob);
    };
});
const key = 'recovery-stale-clear-fixture';
const original = createState(8, 8, [0, 0, 0, 0]);
original.layers[0].pixels.set([17, 54, 93, 128]);
const first = Array.from(encodeProject(original));
const updated = createState(9, 8, [0, 0, 0, 0]);
updated.layers[0].pixels.set([22, 121, 234, 191]);
const latest = Array.from(encodeProject(updated));
async function putSnapshot(bytes, sequence, fixtureKey = key) {
    await page.evaluate(
        async ({ bytes, sequence, key }) => {
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open('retropaint-local-v1', 1);
                request.onupgradeneeded = () => {
                    request.result.createObjectStore('heads');
                    request.result.createObjectStore('snapshots');
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            try {
                await new Promise((resolve, reject) => {
                    const tx = db.transaction(['heads', 'snapshots'], 'readwrite');
                    tx.objectStore('heads').put(
                        { key, sequence, size: bytes.length, name: '복구 경쟁 fixture', at: Date.now() },
                        key,
                    );
                    tx.objectStore('snapshots').put(new Blob([Uint8Array.from(bytes)]), key);
                    tx.oncomplete = () => resolve();
                    tx.onabort = () => reject(tx.error);
                });
            } finally {
                db.close();
            }
        },
        { bytes, sequence, key: fixtureKey },
    );
}
async function readSnapshot(fixtureKey = key) {
    return await page.evaluate(async (key) => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('retropaint-local-v1', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        try {
            const result = await new Promise((resolve, reject) => {
                const tx = db.transaction(['heads', 'snapshots']),
                    head = tx.objectStore('heads').get(key),
                    blob = tx.objectStore('snapshots').get(key);
                tx.oncomplete = () => resolve({ head: head.result, blob: blob.result });
                tx.onabort = () => reject(tx.error);
            });
            return {
                head: result.head,
                bytes: result.blob ? Array.from(new Uint8Array(await result.blob.arrayBuffer())) : undefined,
            };
        } finally {
            db.close();
        }
    }, fixtureKey);
}
async function recoveryDialog() {
    await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '복구 사본', exact: true }).click();
    await page.getByLabel('시각 · 이름', { exact: true }).selectOption({ index: 0 });
}
try {
    await page.goto(process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/');
    await page.waitForSelector('canvas[data-ready=true]');
    // Observe the completed startup read instead of racing its asynchronous database open.
    await page.waitForFunction(() => window.testInitialRecoveryChecked === true);
    await putSnapshot(first, 1);
    await recoveryDialog();
    await putSnapshot(latest, 2);
    await page.getByLabel('동작', { exact: true }).selectOption('선택 사본 삭제');
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
    await page
        .getByRole('status')
        .filter({ hasText: /복구 사본이 변경됐습니다|선택 사본을 삭제했습니다/ })
        .waitFor();
    const preserved = await readSnapshot();
    assert.equal(preserved.head?.sequence, 2, 'stale delete removed the newer recovery head');
    assert.deepEqual(preserved.bytes, latest, 'stale delete removed or changed newer recovery pixels');
    results.checks.push('Stale recovery deletion preserves the newer generation in both stores');
    await recoveryDialog();
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '복구했습니다.' }).waitFor();
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.getByRole('button', { name: '파일 받기', exact: true }).waitFor();
    const restored = await page.evaluate(async () =>
        Array.from(new Uint8Array(await window.testBlobs.at(-1).arrayBuffer())),
    );
    assert.deepEqual(decodeProject(Uint8Array.from(restored)), updated);
    await page.getByRole('button', { name: '다운로드 닫기', exact: true }).click();
    results.checks.push('The preserved newer backup reopens through the actual UI with exact pixels');
    await recoveryDialog();
    await page.getByLabel('동작', { exact: true }).selectOption('선택 사본 삭제');
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '선택 사본을 삭제했습니다.' }).waitFor();
    assert.deepEqual(await readSnapshot(), { head: undefined, bytes: undefined });
    results.checks.push('An unchanged selected backup deletes its matching head and blob together');

    assert.notEqual(first.length, latest.length);
    await putSnapshot(first, 3);
    await recoveryDialog();
    await putSnapshot(latest, 3);
    await page.getByLabel('동작', { exact: true }).selectOption('선택 사본 삭제');
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '복구 사본이 변경됐습니다.' }).waitFor();
    assert.deepEqual((await readSnapshot()).bytes, latest);
    results.checks.push('A changed byte length also invalidates a pending delete');

    await putSnapshot(first, 4, 'corrupt-recovery-fixture');
    const validBeforeCorruption = await readSnapshot();
    await page.evaluate(
        async ({ key, head }) => {
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open('retropaint-local-v1', 1);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            try {
                await new Promise((resolve, reject) => {
                    const tx = db.transaction('heads', 'readwrite');
                    // A forged value key must not redirect deletion to another valid snapshot.
                    tx.objectStore('heads').put(head, key);
                    tx.oncomplete = () => resolve();
                    tx.onabort = () => reject(tx.error);
                });
            } finally {
                db.close();
            }
        },
        { key: 'corrupt-recovery-fixture', head: validBeforeCorruption.head },
    );
    await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '복구 사본', exact: true }).click();
    await page
        .getByRole('status')
        .filter({ hasText: '브라우저 복구 저장소에 접근할 수 없습니다.' })
        .waitFor();
    assert.deepEqual(await readSnapshot(), validBeforeCorruption);
    assert.deepEqual((await readSnapshot('corrupt-recovery-fixture')).bytes, first);
    assert.equal(await page.getByRole('dialog').count(), 0);
    results.checks.push('A recovery value cannot alias another primary key or delete its valid snapshot');

    await page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('retropaint-local-v1', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        try {
            await new Promise((resolve, reject) => {
                const tx = db.transaction('heads', 'readwrite');
                tx.objectStore('heads').put(null, 'corrupt-recovery-fixture');
                tx.oncomplete = () => resolve();
                tx.onabort = () => reject(tx.error);
            });
        } finally {
            db.close();
        }
    });
    await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '복구 사본', exact: true }).click();
    await page
        .getByRole('status')
        .filter({ hasText: '브라우저 복구 저장소에 접근할 수 없습니다.' })
        .waitFor();
    assert.deepEqual(await readSnapshot(), validBeforeCorruption);
    const corrupt = await readSnapshot('corrupt-recovery-fixture');
    assert.equal(corrupt.head, null);
    assert.deepEqual(corrupt.bytes, first);
    assert.equal(await page.getByRole('dialog').count(), 0);
    results.checks.push(
        'Malformed null metadata rejects safely without callbacks throwing or removing backups',
    );
    assert.deepEqual(results.errors, []);
    await context.close();
    const quotaContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await quotaContext.addInitScript(() => {
        window.testBlobs = [];
        const create = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => {
            window.testBlobs.push(blob);
            return create(blob);
        };
        const interval = window.setInterval.bind(window);
        window.setInterval = (handler, delay, ...args) => {
            if (delay === 30000 && typeof handler === 'function') {
                window.testAutosave = () => handler(...args);
                return 0;
            }
            return interval(handler, delay, ...args);
        };
        const transaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (...args) {
            const tx = transaction.apply(this, args);
            if (this.name === 'retropaint-local-v1' && tx.mode === 'readonly')
                tx.addEventListener(
                    'complete',
                    () => {
                        window.testInitialRecoveryChecked = true;
                    },
                    { once: true },
                );
            return tx;
        };
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
            const request = put.apply(this, args);
            if (window.testAbortRecoveryWrite && this.name === 'snapshots') {
                window.testAbortRecoveryWrite = false;
                request.addEventListener('success', () => this.transaction.abort(), { once: true });
            }
            return request;
        };
    });
    const quotaPage = await quotaContext.newPage();
    quotaPage.on('pageerror', (error) => results.errors.push(error.message));
    quotaPage.setDefaultTimeout(15000);
    await quotaPage.goto(process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/');
    await quotaPage.waitForFunction(
        () => window.testInitialRecoveryChecked === true && !!window.testAutosave,
    );
    const canvas = await quotaPage.locator('.workspace canvas').boundingBox();
    const origin = { x: canvas.x + (canvas.width - 800) / 2, y: canvas.y + (canvas.height - 600) / 2 };
    async function drawRow(y) {
        await quotaPage.mouse.move(origin.x + 40, origin.y + y);
        await quotaPage.mouse.down();
        await quotaPage.mouse.move(origin.x + 220, origin.y + y, { steps: 8 });
        await quotaPage.mouse.up();
    }
    async function projectBytes() {
        await quotaPage.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
        await quotaPage.getByRole('button', { name: '파일 받기', exact: true }).waitFor();
        const bytes = await quotaPage.evaluate(async () =>
            Array.from(new Uint8Array(await window.testBlobs.at(-1).arrayBuffer())),
        );
        await quotaPage.getByRole('button', { name: '다운로드 닫기', exact: true }).click();
        return bytes;
    }
    async function quotaState() {
        return await quotaPage.evaluate(async () => {
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open('retropaint-local-v1', 1);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            try {
                const rows = await new Promise((resolve, reject) => {
                    const tx = db.transaction(['heads', 'snapshots']);
                    const keys = tx.objectStore('heads').getAllKeys(),
                        heads = tx.objectStore('heads').getAll(),
                        blobs = tx.objectStore('snapshots').getAll(),
                        blobKeys = tx.objectStore('snapshots').getAllKeys();
                    tx.oncomplete = () =>
                        resolve(
                            keys.result.map((key, i) => ({
                                key,
                                head: heads.result[i],
                                blob: blobs.result[blobKeys.result.indexOf(key)],
                            })),
                        );
                    tx.onabort = () => reject(tx.error);
                });
                const result = [];
                for (const row of rows) {
                    const sha = row.blob
                        ? Array.from(
                              new Uint8Array(
                                  await crypto.subtle.digest('SHA-256', await row.blob.arrayBuffer()),
                              ),
                          )
                              .map((n) => n.toString(16).padStart(2, '0'))
                              .join('')
                        : undefined;
                    result.push({ key: row.key, head: row.head, blobSize: row.blob?.size, sha });
                }
                return result;
            } finally {
                db.close();
            }
        });
    }
    async function seedQuota(foreignCount, totalForeignBytes, keepOwn = false) {
        await quotaPage.evaluate(
            async ({ foreignCount, totalForeignBytes, keepOwn, first }) => {
                const db = await new Promise((resolve, reject) => {
                    const request = indexedDB.open('retropaint-local-v1', 1);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                try {
                    await new Promise((resolve, reject) => {
                        const tx = db.transaction(['heads', 'snapshots'], 'readwrite'),
                            heads = tx.objectStore('heads'),
                            snapshots = tx.objectStore('snapshots');
                        const read = heads.getAll();
                        read.onsuccess = () => {
                            const own = read.result.find(
                                (head) => head && !head.key.startsWith('quota-foreign-'),
                            );
                            const blob = own && keepOwn ? snapshots.get(own.key) : undefined;
                            const install = () => {
                                const ownBlob = blob?.result;
                                heads.clear();
                                snapshots.clear();
                                if (own && keepOwn) {
                                    heads.put(own, own.key);
                                    snapshots.put(ownBlob, own.key);
                                }
                                const sizes = Array(foreignCount).fill(first.length);
                                if (totalForeignBytes !== undefined) {
                                    sizes[0] =
                                        Math.floor(totalForeignBytes / 2) - (foreignCount - 2) * first.length;
                                    sizes[1] =
                                        totalForeignBytes - sizes[0] - (foreignCount - 2) * first.length;
                                }
                                for (let i = 0; i < foreignCount; i++) {
                                    const key = 'quota-foreign-' + String(i).padStart(2, '0'),
                                        size = sizes[i],
                                        data =
                                            size === first.length
                                                ? Uint8Array.from(first)
                                                : new Uint8Array(size);
                                    if (size !== first.length) data[0] = i + 1;
                                    heads.put(
                                        {
                                            key,
                                            size,
                                            sequence: 1,
                                            name: 'Quota fixture ' + i,
                                            at: 1700000000000 + i,
                                        },
                                        key,
                                    );
                                    snapshots.put(new Blob([data]), key);
                                }
                            };
                            if (blob) blob.onsuccess = install;
                            else install();
                        };
                        tx.oncomplete = () => resolve();
                        tx.onabort = () => reject(tx.error);
                    });
                } finally {
                    db.close();
                }
            },
            { foreignCount, totalForeignBytes, keepOwn, first },
        );
    }
    const autosave = () => quotaPage.evaluate(() => window.testAutosave());
    await seedQuota(31);
    await drawRow(60);
    await autosave();
    let rows = await quotaState();
    assert.equal(rows.length, 32);
    const ownKey = rows.find((row) => !row.key.startsWith('quota-foreign-')).key;
    const foreign = rows.filter((row) => row.key !== ownKey),
        initialOwn = rows.find((row) => row.key === ownKey);
    await drawRow(80);
    await autosave();
    rows = await quotaState();
    assert.equal(rows.length, 32);
    assert.deepEqual(
        rows.filter((row) => row.key !== ownKey),
        foreign,
    );
    assert.notEqual(rows.find((row) => row.key === ownKey).sha, initialOwn.sha);
    results.checks.push(
        'Actual autosave admits a 32nd head and replaces its own key at the 32-head boundary',
    );

    await seedQuota(32);
    await drawRow(100);
    const countBefore = await quotaState();
    await autosave();
    await quotaPage.getByRole('status').filter({ hasText: '복구 저장소 한도입니다.' }).waitFor();
    assert.deepEqual(await quotaState(), countBefore);
    results.checks.push(
        'A new autosave at 32 foreign heads fails without changing any existing head or blob',
    );

    const cap = 64 * 1024 * 1024,
        current = await projectBytes();
    await seedQuota(31, cap - current.length);
    await autosave();
    rows = await quotaState();
    assert.equal(rows.length, 32);
    assert.equal(
        rows.reduce((sum, row) => sum + row.head.size, 0),
        cap,
    );
    assert.equal(rows.find((row) => row.key === ownKey).blobSize, current.length);
    results.checks.push('Actual autosave succeeds at exactly the 64 MiB aggregate soft quota');

    await drawRow(120);
    const replacement = await projectBytes();
    await seedQuota(31, cap - replacement.length, true);
    const replacementBefore = await quotaState();
    await autosave();
    rows = await quotaState();
    assert.equal(
        rows.reduce((sum, row) => sum + row.head.size, 0),
        cap,
    );
    assert.deepEqual(
        rows.filter((row) => row.key !== ownKey),
        replacementBefore.filter((row) => row.key !== ownKey),
    );
    assert.equal(rows.find((row) => row.key === ownKey).blobSize, replacement.length);
    assert.notEqual(
        rows.find((row) => row.key === ownKey).sha,
        replacementBefore.find((row) => row.key === ownKey).sha,
    );
    results.checks.push('At 64 MiB, replacing the owned backup excludes its old bytes from the quota');

    await drawRow(140);
    const overCandidate = await projectBytes();
    await seedQuota(31, cap - overCandidate.length + 1, true);
    const bytesBefore = await quotaState();
    await autosave();
    await quotaPage.getByRole('status').filter({ hasText: '복구 저장소 한도입니다.' }).waitFor();
    assert.deepEqual(await quotaState(), bytesBefore);
    assert.deepEqual(await projectBytes(), overCandidate);
    results.checks.push(
        'Exceeding the 64 MiB soft quota by one byte preserves all backups and current UI pixels',
    );

    await seedQuota(31, undefined, true);
    const abortBefore = await quotaState();
    await quotaPage.evaluate(() => {
        window.testAbortRecoveryWrite = true;
    });
    await autosave();
    await quotaPage.getByRole('status').filter({ hasText: '복구 저장 실패:' }).waitFor();
    assert.deepEqual(await quotaState(), abortBefore);
    results.checks.push(
        'An actual IndexedDB transaction abort after a snapshot put rolls back head and blob together',
    );

    await quotaPage.evaluate(async (key) => {
        const db = await new Promise((resolve, reject) => {
            const r = indexedDB.open('retropaint-local-v1', 1);
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
        try {
            await new Promise((resolve, reject) => {
                const tx = db.transaction('heads', 'readwrite');
                tx.objectStore('heads').put(null, key);
                tx.oncomplete = () => resolve();
                tx.onabort = () => reject(tx.error);
            });
        } finally {
            db.close();
        }
    }, ownKey);
    const malformedBefore = await quotaState();
    await autosave();
    await quotaPage.getByRole('status').filter({ hasText: '복구 사본 정보가 올바르지 않습니다.' }).waitFor();
    assert.deepEqual(await quotaState(), malformedBefore);
    results.checks.push(
        'Malformed existing owned metadata prevents autosave replacement and preserves the prior blob',
    );
    results.quotaScope =
        'Application 32-head/64 MiB soft quota and transaction rollback only; physical browser storage exhaustion was not exercised';
    assert.deepEqual(results.errors, []);
    await quotaContext.close();
} catch (error) {
    results.failure = String(error.stack || error);
    await page.screenshot({ path: output + '/failure.png' }).catch(() => {});
    throw error;
} finally {
    await fs.writeFile(output + '/results.json', JSON.stringify(results, null, 2));
    await browser.close();
}
console.log(JSON.stringify(results, null, 2));
