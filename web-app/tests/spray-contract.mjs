import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createState, cloneState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(
    process.env.PAINT_SPRAY_OUTPUT || '../build-web-work/task-planning/current-tests/spray/results.json',
);
await fs.mkdir(path.dirname(output), { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixturePath = new URL('./fixtures/spray-literal.json', import.meta.url);
const fixtureBytes = await fs.readFile(fixturePath);
const fixture = JSON.parse(fixtureBytes);
const runtimeFiles = [
    'src/engine/document.ts',
    'src/engine/format.ts',
    'src/engine/operations.ts',
    'src/env.d.ts',
    'src/main.ts',
    'src/platform/codec.ts',
    'src/platform/native-smoke.ts',
    'src/platform/native.ts',
    'src/platform/storage.ts',
    'src/platform/surface.ts',
    'src/platform/tiles.ts',
    'src/style.css',
    'src/ui/icons.ts',
    'src/workers/codec.worker.ts',
    'src-tauri/src/lifecycle.rs',
    'src-tauri/src/main.rs',
    'src-tauri/src/persistence.rs',
];
const result = {
    scope: 'Public Chromium tool controls, trusted pointer/keyboard, actual drawing and project codec Worker. Only Math.random values and clock/tick delivery are fixed. Native file/IPC transport is modeled; no private Studio hooks, Qt random-distribution equivalence, OS picker, physical timing or performance acceptance.',
    url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
    driverSha256: hash(await fs.readFile(new URL(import.meta.url))),
    fixtureSha256: hash(fixtureBytes),
    sourcesBefore: {},
    sourcesAfter: {},
    assets: [],
    cases: [],
    errors: [],
};
for (const file of runtimeFiles)
    result.sourcesBefore[file] = hash(await fs.readFile(new URL('../' + file, import.meta.url)));
const original = createState(
    fixture.document.width,
    fixture.document.height,
    fixture.document.background,
    desktopLimits,
);
original.active = fixture.document.active;
original.layers = fixture.document.layers.map((layer) => ({
    name: layer.name,
    visible: layer.visible,
    pixels: Uint8ClampedArray.from(
        { length: fixture.document.width * fixture.document.height * 4 },
        (_, index) => layer.rgba[index % 4],
    ),
}));
const encoded = encodeProject(original, desktopLimits);
await fs.writeFile(path.join(path.dirname(output), 'source.rpaint'), encoded);
const expected = cloneState(original);
for (const [x, y] of fixture.expected.inkPixels)
    expected.layers[expected.active].pixels.set(fixture.input.rgba, (y * fixture.document.width + x) * 4);
const oldRedo = cloneState(original);
oldRedo.layers[oldRedo.active].pixels.set(
    fixture.input.rgba,
    (fixture.expected.redoSeedPixel[1] * fixture.document.width + fixture.expected.redoSeedPixel[0]) * 4,
);
function instrument() {
    const p = (window.sprayLiteralTest = {
        armed: false,
        values: [],
        randomCalls: 0,
        ticks: 0,
        active: new Set(),
        pointer: undefined,
        nativeRandom: Math.random,
    });
    Math.random = () => {
        if (!p.armed) return p.nativeRandom();
        const index = p.randomCalls++;
        if (index >= p.values.length) throw Error('Spray consumed unrecorded random input');
        return p.values[index];
    };
    document.addEventListener(
        'pointerdown',
        (event) => {
            if (event.target instanceof HTMLCanvasElement) p.pointer = event.pointerId;
        },
        { passive: true },
    );
}
async function snapshot(page, record, label) {
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
    record.files ||= [];
    record.files.push({ name, size: bytes.length, sha256: hash(bytes) });
    return decodeProject(bytes, desktopLimits);
}
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
result.browser = browser.version();
const assetRequests = [];
try {
    for (const mode of ['release', 'cancel-with-old-redo']) {
        const record = { name: mode, checks: {} };
        result.cases.push(record);
        const context = await browser.newContext({
            viewport: { width: 1280, height: 900 },
            deviceScaleFactor: 1,
        });
        try {
            await context.addInitScript(installNativeHarness, {});
            await context.addInitScript(instrument);
            const page = await context.newPage();
            page.setDefaultTimeout(15000);
            page.on('pageerror', (error) => result.errors.push({ case: mode, message: error.message }));
            page.on('response', (response) => {
                if (!/\.(?:js|css)(?:[?#]|$)/.test(response.url())) return;
                assetRequests.push(
                    response
                        .body()
                        .catch(async () => {
                            const fetched = await context.request.get(response.url());
                            assert(fetched.ok());
                            return fetched.body();
                        })
                        .then((bytes) => {
                            if (!result.assets.some((asset) => asset.url === response.url()))
                                result.assets.push({
                                    url: response.url(),
                                    size: bytes.length,
                                    sha256: hash(bytes),
                                });
                        }),
                );
            });
            const time = new Date('2026-11-06T00:00:00.000Z');
            await page.clock.install({ time });
            await page.clock.pauseAt(new Date(time.getTime() + 1000));
            await page.goto(result.url);
            await page.clock.runFor(32);
            await page.waitForFunction(
                () =>
                    window.__myPaintPersistenceTest?.generation === 1 &&
                    document.querySelector('canvas[data-ready=true]'),
            );
            await page.evaluate(
                (bytes) =>
                    window.__myPaintPersistenceTest.queueOpen('spray-source.rpaint', Uint8Array.from(bytes)),
                Array.from(encoded),
            );
            await page.getByRole('button', { name: '파일 열기', exact: true }).click({ force: true });
            await page.waitForFunction(
                () => window.__myPaintPersistenceTest.generation === 2 && !document.querySelector('.busy'),
            );
            await page.getByRole('button', { name: '화면에 맞추기', exact: true }).click({ force: true });
            await page.getByLabel('HEX 색상', { exact: true }).fill(fixture.input.opaqueHex);
            await page.getByLabel('HEX 색상', { exact: true }).press('Tab');
            await page.locator('#size').evaluate((input, value) => {
                input.value = String(value);
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }, fixture.input.size);
            await page.locator('#opacity').evaluate((input) => {
                input.value = '100';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            assert.equal(await page.locator('#zoom').textContent(), '100%');
            assert.deepEqual(await snapshot(page, record, 'opened'), original);
            const box = await page.locator('.workspace canvas').boundingBox();
            const origin = {
                x: box.x + box.width / 2 - fixture.document.width / 2,
                y: box.y + box.height / 2 - fixture.document.height / 2,
            };
            await page.evaluate(() => {
                const p = window.sprayLiteralTest;
                const set = window.setInterval.bind(window),
                    clear = window.clearInterval.bind(window);
                window.setInterval = (callback, delay, ...args) => {
                    if (delay !== 35) return set(callback, delay, ...args);
                    const id = set(() => {
                        p.ticks++;
                        return callback(...args);
                    }, delay);
                    p.active.add(id);
                    return id;
                };
                window.clearInterval = (id) => {
                    p.active.delete(id);
                    return clear(id);
                };
            });
            if (mode === 'cancel-with-old-redo') {
                await page.getByRole('button', { name: '연필', exact: true }).click({ force: true });
                await page.mouse.click(
                    origin.x + fixture.expected.redoSeedPixel[0] + 0.5,
                    origin.y + fixture.expected.redoSeedPixel[1] + 0.5,
                );
                assert.deepEqual(await snapshot(page, record, 'old-redo-target'), oldRedo);
                await page.getByRole('button', { name: '실행 취소', exact: true }).click({ force: true });
                assert.deepEqual(await snapshot(page, record, 'old-redo-source'), original);
                assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            }
            await page.getByRole('button', { name: '스프레이', exact: true }).click({ force: true });
            await page.evaluate((values) => {
                window.sprayLiteralTest.values = values;
                window.sprayLiteralTest.armed = true;
            }, fixture.input.random);
            await page.mouse.move(origin.x + fixture.input.center[0], origin.y + fixture.input.center[1]);
            await page.mouse.down();
            await page.clock.runFor(fixture.input.tickMs);
            await page.clock.runFor(16);
            record.during = await page.evaluate(
                ({ origin, points }) => {
                    const p = window.sprayLiteralTest,
                        canvas = document.querySelector('.workspace canvas'),
                        box = canvas.getBoundingClientRect(),
                        ctx = canvas.getContext('2d');
                    return {
                        ticks: p.ticks,
                        randomCalls: p.randomCalls,
                        activeTimers: p.active.size,
                        captured: canvas.hasPointerCapture(p.pointer),
                        points: points.map(([x, y]) =>
                            Array.from(
                                ctx.getImageData(
                                    Math.floor(((origin.x + x + 0.5 - box.x) * canvas.width) / box.width),
                                    Math.floor(((origin.y + y + 0.5 - box.y) * canvas.height) / box.height),
                                    1,
                                    1,
                                ).data,
                            ),
                        ),
                    };
                },
                { origin, points: fixture.expected.inkPixels },
            );
            assert.equal(record.during.ticks, fixture.expected.tickCount);
            assert.equal(record.during.randomCalls, fixture.expected.randomCalls);
            assert.equal(record.during.activeTimers, 1);
            assert.equal(record.during.captured, true);
            assert.deepEqual(
                record.during.points,
                fixture.expected.inkPixels.map(() => fixture.input.rgba),
            );
            if (mode === 'cancel-with-old-redo') await page.keyboard.press('Escape');
            await page.mouse.up();
            await page.clock.runFor(fixture.input.tickMs * 4);
            record.after = await page.evaluate(() => {
                const p = window.sprayLiteralTest,
                    canvas = document.querySelector('.workspace canvas');
                return {
                    ticks: p.ticks,
                    randomCalls: p.randomCalls,
                    activeTimers: p.active.size,
                    captured: canvas.hasPointerCapture(p.pointer),
                };
            });
            assert.deepEqual(record.after, {
                ticks: fixture.expected.tickCount,
                randomCalls: fixture.expected.randomCalls,
                activeTimers: 0,
                captured: false,
            });
            record.checks.oneDeterministicTickAndTimerStopped = true;
            await page.evaluate(() => {
                window.sprayLiteralTest.armed = false;
            });
            const actual = await snapshot(page, record, 'after');
            if (mode === 'release') {
                assert.deepEqual(
                    actual,
                    expected,
                    'Every active RGBA byte, other layer and metadata must match the literal fixture',
                );
                await page.getByRole('button', { name: '실행 취소', exact: true }).click({ force: true });
                assert.deepEqual(await snapshot(page, record, 'undo'), original);
                assert(await page.getByRole('button', { name: '실행 취소', exact: true }).isDisabled());
                await page.getByRole('button', { name: '다시 실행', exact: true }).click({ force: true });
                assert.deepEqual(await snapshot(page, record, 'redo'), expected);
                record.checks.literalFullStateAndOneUndoRedo = true;
            } else {
                assert.deepEqual(actual, original);
                assert(await page.getByRole('button', { name: '실행 취소', exact: true }).isDisabled());
                assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
                await page.getByRole('button', { name: '다시 실행', exact: true }).click({ force: true });
                assert.deepEqual(await snapshot(page, record, 'old-redo-replay'), oldRedo);
                await page.getByRole('button', { name: '실행 취소', exact: true }).click({ force: true });
                assert.deepEqual(await snapshot(page, record, 'old-redo-undo'), original);
                record.checks.cancelSourceAndOldRedoExact = true;
            }
            record.ok = true;
        } catch (error) {
            record.ok = false;
            record.error = error.stack || String(error);
        } finally {
            await Promise.all(assetRequests);
            await context.close();
        }
        await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
        console.log(
            JSON.stringify({
                case: record.name,
                ok: record.ok,
                during: record.during,
                after: record.after,
                error: record.error,
            }),
        );
    }
} finally {
    await browser.close();
}
for (const file of runtimeFiles)
    result.sourcesAfter[file] = hash(await fs.readFile(new URL('../' + file, import.meta.url)));
result.runtimeSourcesUnchanged = JSON.stringify(result.sourcesBefore) === JSON.stringify(result.sourcesAfter);
result.ok =
    result.cases.every((record) => record.ok) && result.errors.length === 0 && result.runtimeSourcesUnchanged;
await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(
    JSON.stringify({
        output,
        ok: result.ok,
        cases: result.cases.length,
        errors: result.errors.length,
        runtimeSourcesUnchanged: result.runtimeSourcesUnchanged,
    }),
);
if (!result.ok) process.exitCode = 1;
