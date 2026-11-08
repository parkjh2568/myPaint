import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createState } from '../src/engine/document.ts';
import { encodeProject, decodeProject, encodePng, decodePng } from '../src/engine/format.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(
    process.env.PAINT_CODEC_REPLY_OUTPUT ||
        '../build-web-work/task-planning/codec-reply-contract/ui/results.json',
);
await fs.mkdir(path.dirname(output), { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const result = {
    scope: 'Public normal-web chooser, editing, Undo/Redo, actual download files and codec Workers. Named test-only faults replace one real Worker reply; these are not naturally observed Worker faults. The large lasso path uses trusted pointerdown plus8193 synthetic public moves/release to reach the actual selection Worker. ClipboardItem/getType transport is modeled, without OS clipboard, native persistence, physical device or performance validation.',
    url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8962/',
    testSha256: hash(await fs.readFile(new URL(import.meta.url))),
    sourceSha256: Object.fromEntries(
        await Promise.all(
            ['main.ts', 'platform/codec.ts', 'workers/codec.worker.ts', 'engine/format.ts'].map(
                async (name) => [name, hash(await fs.readFile(new URL(`../src/${name}`, import.meta.url)))],
            ),
        ),
    ),
    sourceHashScope:
        'Current checkout sources at test start; not a historical before snapshot or proof that a remote served bundle matches this checkout. Loaded asset bodies are recorded separately.',
    assetHashScope:
        'Observed loaded asset URLs; response body hashes with same-URL HTTP fallback where Chromium makes terminated Worker response bodies unavailable. Static bundles are frozen during each run.',
    assets: [],
    cases: [],
    errors: [],
};
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
result.browser = browser.version();
const fixture = createState(32, 24, [11, 29, 47, 63]);
fixture.layers[0].name = '아래 α0 RGB';
fixture.layers.push(
    { name: '활성 반투명 ✏️', visible: true, pixels: new Uint8ClampedArray(3072) },
    { name: '숨김 원문', visible: false, pixels: new Uint8ClampedArray(3072) },
);
fixture.active = 1;
for (let i = 0; i < 768; i++) {
    fixture.layers[0].pixels.set([13, 79, 153, i % 3 ? 191 : 0], i * 4);
    fixture.layers[1].pixels.set([207, 91, 43, i % 4 ? 127 : 0], i * 4);
    fixture.layers[2].pixels.set([37, 149, 233, i % 2 ? 255 : 0], i * 4);
}
const fixtureBytes = encodeProject(fixture);
await fs.writeFile(path.join(path.dirname(output), 'fixture.rpaint'), fixtureBytes);
function instrument() {
    const p = (window.codecReplyTest = {
        arm: undefined,
        injected: 0,
        live: new Set(),
        clipboard: [],
        replies: [],
        inputs: [],
        initial: false,
    });
    const interval = window.setInterval.bind(window);
    window.setInterval = (cb, delay, ...args) => (delay === 30000 ? 0 : interval(cb, delay, ...args));
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
        const tx = Reflect.apply(transaction, this, args);
        if (this.name === 'retropaint-local-v1' && tx.mode === 'readonly')
            tx.addEventListener(
                'complete',
                () => {
                    p.initial = true;
                },
                { once: true },
            );
        return tx;
    };
    window.ClipboardItem = class {
        constructor(items) {
            this.items = items;
            this.types = Object.keys(items);
        }
        async getType(type) {
            return await this.items[type];
        }
        static supports(type) {
            return type === 'image/png';
        }
    };
    Object.defineProperty(navigator.clipboard, 'write', {
        configurable: true,
        value: async (items) => {
            if (items.length !== 1 || items[0].types[0] !== 'image/png') throw Error('Expected PNG item');
            const blob = await items[0].getType('image/png');
            if (!(blob instanceof Blob)) throw Error('Expected Blob');
            p.clipboard.push(blob);
        },
    });
    const Original = window.Worker;
    window.Worker = class extends Original {
        constructor(...args) {
            super(...args);
            p.live.add(this);
        }
        postMessage(message, transfer) {
            this.operation = message.operation;
            if (message.operation === 'project-write')
                p.inputs.push({
                    width: message.state.width,
                    height: message.state.height,
                    active: message.state.active,
                    background: Array.from(message.state.background),
                    layers: message.state.layers.map((l) => ({
                        name: l.name,
                        visible: l.visible,
                        pixels: Array.from(l.pixels),
                        pixelType: l.pixels.constructor.name,
                    })),
                });
            if (p.arm?.operation === message.operation) {
                this.fault = p.arm.mode;
                p.arm = undefined;
            }
            return super.postMessage(message, transfer);
        }
        set onmessage(listener) {
            super.onmessage = (event) => {
                const original = event.data;
                p.replies.push({
                    operation: this.operation,
                    ownImage: Object.hasOwn(original, 'image'),
                    imageUndefined: original.image === undefined,
                    keys: Object.keys(original),
                    bytesLength: original.bytes?.length,
                    error: original.error,
                });
                let data = original;
                if (this.fault) {
                    p.injected++;
                    data = { ...original };
                    if (this.fault === 'missing') delete data.bytes;
                    else if (this.fault === 'null') data.bytes = null;
                    else if (this.fault === 'empty') data.bytes = new Uint8Array();
                    else if (this.fault === 'missing-state') delete data.state;
                    else if (this.fault === 'missing-image') delete data.image;
                    else if (this.fault === 'array-state' || this.fault === 'uint8-state')
                        data.state = {
                            ...data.state,
                            layers: data.state.layers.map((l) => ({
                                ...l,
                                pixels:
                                    this.fault === 'array-state'
                                        ? Array.from(l.pixels)
                                        : new Uint8Array(l.pixels),
                            })),
                        };
                    else if (this.fault === 'roi') data.image = { ...data.image, left: 32, top: 24 };
                    this.fault = undefined;
                }
                listener.call(this, { data });
            };
        }
        terminate() {
            p.live.delete(this);
            return super.terminate();
        }
    };
}
async function menu(page, name) {
    await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
}
async function choose(page, bytes, name) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '파일 열기', exact: true }).click();
    await (
        await chooser
    ).setFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
    await page.waitForFunction(() => !document.querySelector('.busy'));
}
async function downloaded(page, record, label) {
    const promise = page.waitForEvent('download');
    await page.getByRole('button', { name: '파일 받기', exact: true }).click();
    const file = await promise,
        bytes = await fs.readFile(await file.path()),
        name = `${record.name}-${label}-${file.suggestedFilename()}`;
    await fs.writeFile(path.join(path.dirname(output), name), bytes);
    record.files ||= [];
    record.files.push({ label, name, size: bytes.length, sha256: hash(bytes) });
    await page.getByRole('button', { name: '다운로드 닫기', exact: true }).click();
    return new Uint8Array(bytes);
}
async function snapshot(page, record, label) {
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.busy'));
    if (!(await page.getByRole('button', { name: '파일 받기', exact: true }).count())) return undefined;
    return decodeProject(await downloaded(page, record, label));
}
async function point(page, x, y, tool = '연필') {
    await page.getByRole('button', { name: tool, exact: true }).click();
    await page.getByRole('button', { name: '화면에 맞추기', exact: true }).click();
    const box = await page.locator('.workspace canvas').boundingBox();
    await page.mouse.click(box.x + box.width / 2 - 16 + x + 0.5, box.y + box.height / 2 - 12 + y + 0.5);
    await page.waitForFunction(() => !document.querySelector('.busy'));
}
async function act(page, record) {
    const repliesBefore = await page.evaluate(
        (op) => window.codecReplyTest.replies.filter((r) => r.operation === op).length,
        record.operation,
    );
    if (record.cut) await menu(page, '잘라내기');
    else if (record.operation === 'project-write')
        await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    else if (record.operation.endsWith('-write')) {
        await page.getByRole('button', { name: '이미지 내보내기', exact: true }).click();
        await page.getByLabel('형식', { exact: true }).selectOption(record.operation.split('-')[0]);
        await page.getByRole('dialog').getByRole('button', { name: '내보내기', exact: true }).click();
    } else if (record.operation === 'project-read') await choose(page, fixtureBytes, 'replacement.rpaint');
    else if (record.operation === 'png-read')
        await choose(page, encodePng(32, 24, fixture.layers[0].pixels), 'replacement.png');
    else if (record.operation === 'geometry') await menu(page, '오른쪽 회전');
    else if (record.operation === 'layer-edit') await menu(page, '색 반전');
    else if (record.operation === 'fill') {
        if (record.mode === 'noop') {
            await page.getByLabel('HEX 색상', { exact: true }).fill('#1679ea');
            await page.getByLabel('HEX 색상', { exact: true }).press('Enter');
        }
        await point(page, record.mode === 'noop' ? 2 : 8, record.mode === 'noop' ? 2 : 8, '채우기');
    } else if (record.operation === 'selection') {
        await page.getByRole('button', { name: '자유 선택', exact: true }).click();
        await page.getByRole('button', { name: '화면에 맞추기', exact: true }).click();
        const b = await page.locator('.workspace canvas').boundingBox(),
            x = b.x + b.width / 2 - 16,
            y = b.y + b.height / 2 - 12;
        await page.mouse.move(x + 4.25, y + 4.25);
        await page.mouse.down();
        await page.evaluate(
            ({ x, y }) => {
                const canvas = document.querySelector('.workspace canvas');
                const points = [
                    [4, 4],
                    [18, 4],
                    [4, 17],
                ];
                for (let i = 1; i < 8193; i++) {
                    const q = points[i % 3];
                    canvas.dispatchEvent(
                        new PointerEvent('pointermove', {
                            pointerId: 1,
                            pointerType: 'mouse',
                            buttons: 1,
                            button: -1,
                            clientX: x + q[0] + 0.25,
                            clientY: y + q[1] + 0.25,
                            bubbles: true,
                        }),
                    );
                }
                const q = points[8192 % 3];
                canvas.dispatchEvent(
                    new PointerEvent('pointerup', {
                        pointerId: 1,
                        pointerType: 'mouse',
                        buttons: 0,
                        button: 0,
                        clientX: x + q[0] + 0.25,
                        clientY: y + q[1] + 0.25,
                        bubbles: true,
                    }),
                );
            },
            { x, y },
        );
        await page.mouse.up();
    }
    await page.waitForFunction(
        ({ operation, repliesBefore }) =>
            window.codecReplyTest.replies.filter((r) => r.operation === operation).length > repliesBefore &&
            window.codecReplyTest.live.size === 0 &&
            !document.querySelector('.busy'),
        { operation: record.operation, repliesBefore },
    );
    if (await page.getByRole('button', { name: '저장하지 않고 버리기', exact: true }).count()) {
        await page
            .getByRole('dialog')
            .getByRole('button', { name: '저장하지 않고 버리기', exact: true })
            .click();
        await page.waitForFunction(
            () => !document.querySelector('.busy') && !document.querySelector('dialog[open]'),
        );
    }
}
const specs = [];
for (const operation of ['project-write', 'png-write', 'jpg-write', 'bmp-write'])
    for (const mode of ['missing', 'null', 'empty'])
        specs.push({ name: `${operation}-${mode}`, operation, mode });
specs.push({ name: 'cut-png-write-missing', operation: 'png-write', mode: 'missing', cut: true });
for (const operation of ['project-read', 'geometry', 'layer-edit'])
    for (const mode of ['missing-state', 'array-state', 'uint8-state'])
        specs.push({ name: `${operation}-${mode}`, operation, mode });
specs.push(
    { name: 'png-read-missing-image', operation: 'png-read', mode: 'missing-image' },
    { name: 'fill-missing-image', operation: 'fill', mode: 'missing-image' },
    { name: 'fill-roi', operation: 'fill', mode: 'roi' },
    { name: 'fill-noop', operation: 'fill', mode: 'noop' },
    { name: 'selection-missing', operation: 'selection', mode: 'missing' },
);
const requested = process.env.PAINT_CODEC_REPLY_CASES?.split(','),
    pendingAssets = [];
try {
    for (const spec of specs.filter((s) => !requested || requested.includes(s.name))) {
        const record = { ...spec, checks: {}, observed: {} };
        result.cases.push(record);
        const context = await browser.newContext({
            viewport: { width: 1280, height: 900 },
            acceptDownloads: true,
        });
        try {
            await context.addInitScript(instrument);
            const page = await context.newPage();
            page.setDefaultTimeout(15000);
            page.on('pageerror', (e) => result.errors.push({ case: record.name, message: e.message }));
            page.on('response', (response) => {
                if (/\.(?:js|css)(?:[?#]|$)/.test(response.url()))
                    pendingAssets.push(
                        response
                            .body()
                            .catch(async () => {
                                const fetched = await context.request.get(response.url());
                                if (!fetched.ok()) throw Error('Asset hash fetch failed');
                                return fetched.body();
                            })
                            .then((bytes) => {
                                if (!result.assets.some((a) => a.url === response.url()))
                                    result.assets.push({
                                        url: response.url(),
                                        sha256: hash(bytes),
                                        size: bytes.length,
                                    });
                            })
                            .catch((e) => result.errors.push({ asset: response.url(), message: e.message })),
                    );
            });
            await page.goto(result.url);
            await page.waitForFunction(
                () => window.codecReplyTest.initial && document.querySelector('canvas[data-ready=true]'),
            );
            await choose(page, fixtureBytes, 'reply-fixture.rpaint');
            const opened = await snapshot(page, record, 'opened');
            assert.deepEqual(opened, fixture, 'Chooser preserves raw planes/metadata');
            await point(page, 2, 2);
            await point(page, 3, 3);
            const redone = await snapshot(page, record, 'redo-target');
            assert.notDeepEqual(redone, fixture);
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            const before = await snapshot(page, record, 'source-before');
            assert.notDeepEqual(before, redone);
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            record.assumptions = {
                fixtureExact: true,
                publicPencilChanged: true,
                oldRedoAvailable: true,
                sourceLayers: before.layers.map((l) => ({
                    name: l.name,
                    visible: l.visible,
                    sha256: hash(l.pixels),
                })),
            };
            const start = await page.evaluate(() => ({
                    injected: window.codecReplyTest.injected,
                    clipboard: window.codecReplyTest.clipboard.length,
                })),
                statusBefore = await page.locator('.status').textContent();
            if (record.mode !== 'noop')
                await page.evaluate(({ operation, mode }) => {
                    window.codecReplyTest.arm = { operation, mode };
                }, record);
            await act(page, record);
            record.observed.status = await page.locator('.status').textContent();
            record.observed.downloadPrepared = !!(await page
                .getByRole('button', { name: '파일 받기', exact: true })
                .count());
            record.observed.instrument = await page.evaluate(() => ({
                injected: window.codecReplyTest.injected,
                live: window.codecReplyTest.live.size,
                clipboard: window.codecReplyTest.clipboard.length,
                replies: window.codecReplyTest.replies,
            }));
            if (record.observed.downloadPrepared) {
                const bytes = await downloaded(page, record, 'fault-output');
                record.observed.faultOutput = {
                    length: bytes.length,
                    sha256: hash(bytes),
                    utf8Prefix: new TextDecoder().decode(bytes.subarray(0, 32)),
                };
            }
            if (record.cut && record.observed.instrument.clipboard > start.clipboard) {
                const bytes = Uint8Array.from(
                    await page.evaluate(async () =>
                        Array.from(
                            new Uint8Array(await window.codecReplyTest.clipboard.at(-1).arrayBuffer()),
                        ),
                    ),
                );
                await fs.writeFile(
                    path.join(path.dirname(output), `${record.name}-fault-clipboard.bin`),
                    bytes,
                );
                record.observed.clipboard = {
                    length: bytes.length,
                    sha256: hash(bytes),
                    utf8Prefix: new TextDecoder().decode(bytes.subarray(0, 32)),
                };
            }
            const after = await snapshot(page, record, 'source-after');
            record.observed.sourceWriteCandidate = await page.evaluate(() =>
                window.codecReplyTest.inputs.at(-1),
            );
            record.checks.sourcePreserved = !!after && JSON.stringify(after) === JSON.stringify(before);
            record.checks.redoPreserved = await page
                .getByRole('button', { name: '다시 실행', exact: true })
                .isEnabled();
            if (record.checks.redoPreserved) {
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                const replay = await snapshot(page, record, 'redo-after-fault');
                record.checks.redoPixelsExact = !!replay && JSON.stringify(replay) === JSON.stringify(redone);
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            }
            if (record.mode === 'noop') {
                record.checks.actualOwnUndefinedNoOp = record.observed.instrument.replies.some(
                    (r) => r.operation === 'fill' && r.ownImage && r.imageUndefined && !r.error,
                );
                record.checks.noOpNoFailure = record.observed.status === statusBefore;
            } else {
                record.checks.injectedOnce = record.observed.instrument.injected === start.injected + 1;
                record.checks.failureMessage =
                    /(?:실패|올바르지|결과|출력|응답|이미지 작업|Cannot read|undefined|데이터)/.test(
                        record.observed.status,
                    ) && record.observed.status !== statusBefore;
                record.checks.noInvalidDownload = !record.observed.downloadPrepared;
                record.checks.noInvalidClipboard = record.observed.instrument.clipboard === start.clipboard;
            }
            record.checks.workerCleanup = record.observed.instrument.live === 0;
            if (record.checks.sourcePreserved) {
                const retryRepliesBefore = await page.evaluate(() => window.codecReplyTest.replies.length);
                await act(page, record);
                record.observed.retryStatus = await page.locator('.status').textContent();
                if (record.operation.endsWith('-write') && !record.cut) {
                    assert(await page.getByRole('button', { name: '파일 받기', exact: true }).count());
                    const bytes = await downloaded(page, record, 'valid-retry');
                    if (record.operation === 'project-write') assert.deepEqual(decodeProject(bytes), before);
                    else if (record.operation === 'png-write')
                        assert.deepEqual([decodePng(bytes).width, decodePng(bytes).height], [32, 24]);
                    else if (record.operation === 'jpg-write') {
                        const { decode } = await import('jpeg-js');
                        const image = decode(bytes, { useTArray: true });
                        assert.deepEqual([image.width, image.height, image.data.length], [32, 24, 3072]);
                    } else {
                        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                        assert.equal(bytes.length, 54 + 3072);
                        assert.deepEqual(Array.from(bytes.subarray(0, 2)), [66, 77]);
                        assert.equal(view.getUint32(2, true), bytes.length);
                        assert.deepEqual(
                            [view.getInt32(18, true), view.getInt32(22, true), view.getUint16(28, true)],
                            [32, 24, 32],
                        );
                    }
                } else if (record.cut) {
                    assert(
                        (await page.evaluate(() => window.codecReplyTest.clipboard.length)) > start.clipboard,
                    );
                    const bytes = Uint8Array.from(
                        await page.evaluate(async () =>
                            Array.from(
                                new Uint8Array(await window.codecReplyTest.clipboard.at(-1).arrayBuffer()),
                            ),
                        ),
                    );
                    assert.deepEqual([decodePng(bytes).width, decodePng(bytes).height], [32, 24]);
                    await fs.writeFile(
                        path.join(path.dirname(output), `${record.name}-valid-clipboard.png`),
                        bytes,
                    );
                    const cleared = structuredClone(before);
                    cleared.layers[cleared.active].pixels.fill(0);
                    assert.deepEqual(await snapshot(page, record, 'valid-cut-source'), cleared);
                    await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                    assert.deepEqual(await snapshot(page, record, 'valid-cut-undo'), before);
                }
                if (
                    ['project-read', 'png-read', 'geometry', 'layer-edit', 'fill'].includes(record.operation)
                ) {
                    const retried = await snapshot(page, record, 'valid-retry-source');
                    let expected = structuredClone(before);
                    if (record.operation === 'project-read') expected = fixture;
                    else if (record.operation === 'png-read')
                        expected = {
                            width: 32,
                            height: 24,
                            active: 0,
                            background: [255, 255, 255, 255],
                            layers: [{ name: '이미지', visible: true, pixels: fixture.layers[0].pixels }],
                        };
                    else if (record.operation === 'geometry') {
                        expected.width = 24;
                        expected.height = 32;
                        for (let l = 0; l < before.layers.length; l++) {
                            const pixels = new Uint8ClampedArray(3072);
                            for (let y = 0; y < 24; y++)
                                for (let x = 0; x < 32; x++)
                                    pixels.set(
                                        before.layers[l].pixels.subarray(
                                            (y * 32 + x) * 4,
                                            (y * 32 + x + 1) * 4,
                                        ),
                                        (x * 24 + (23 - y)) * 4,
                                    );
                            expected.layers[l].pixels = pixels;
                        }
                    } else if (record.operation === 'layer-edit') {
                        const pixels = expected.layers[expected.active].pixels;
                        for (let i = 0; i < pixels.length; i += 4)
                            for (let c = 0; c < 3; c++) pixels[i + c] = 255 - pixels[i + c];
                    } else if (record.operation === 'fill' && record.mode !== 'noop') {
                        for (let y = 0; y < 24; y++)
                            expected.layers[expected.active].pixels.set(
                                [22, 121, 234, 255],
                                (y * 32 + 8) * 4,
                            );
                    }
                    assert.deepEqual(retried, expected);
                } else if (record.operation === 'selection') {
                    const count = await page.evaluate(() => window.codecReplyTest.clipboard.length);
                    await menu(page, '복사');
                    await page.waitForFunction(
                        (count) =>
                            window.codecReplyTest.clipboard.length === count + 1 &&
                            !document.querySelector('.busy'),
                        count,
                    );
                    const bytes = Uint8Array.from(
                        await page.evaluate(async () =>
                            Array.from(
                                new Uint8Array(await window.codecReplyTest.clipboard.at(-1).arrayBuffer()),
                            ),
                        ),
                    );
                    assert.deepEqual([decodePng(bytes).width, decodePng(bytes).height], [14, 13]);
                    await fs.writeFile(
                        path.join(path.dirname(output), `${record.name}-valid-clipboard.png`),
                        bytes,
                    );
                    await page.locator('.workspace canvas').focus();
                    await page.keyboard.press('Escape');
                    assert.deepEqual(await snapshot(page, record, 'selection-cancel-source'), before);
                }
                record.observed.retryReplies = await page.evaluate(
                    (n) => window.codecReplyTest.replies.slice(n),
                    retryRepliesBefore,
                );
                assert(
                    record.observed.retryReplies.some((r) => r.operation === record.operation && !r.error),
                );
                record.checks.validRetry = true;
            } else record.checks.validRetry = false;
            record.ok = Object.values(record.checks).every(Boolean);
        } catch (error) {
            record.ok = false;
            record.error = error.stack || String(error);
        } finally {
            await Promise.all(pendingAssets);
            await context.close();
        }
        await Promise.all(pendingAssets);
        await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
        process.stdout.write(
            JSON.stringify({
                case: record.name,
                ok: record.ok,
                checks: record.checks,
                status: record.observed.status,
                faultOutput: record.observed.faultOutput,
                clipboard: record.observed.clipboard,
                error: record.error,
            }) + '\n',
        );
    }
} finally {
    await browser.close();
}
await Promise.all(pendingAssets);
result.ok = result.cases.length > 0 && result.cases.every((c) => c.ok) && result.errors.length === 0;
await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
process.stdout.write(
    JSON.stringify({ output, ok: result.ok, cases: result.cases.length, errors: result.errors.length }) +
        '\n',
);
if (!result.ok) process.exitCode = 1;
