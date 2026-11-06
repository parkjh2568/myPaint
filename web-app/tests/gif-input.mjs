import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject, decodePng } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';

const fixturesPath = new URL('./fixtures/gif-input.json', import.meta.url),
    fixtureBytes = await fs.readFile(fixturesPath),
    fixtures = JSON.parse(fixtureBytes),
    output = process.env.PAINT_GIF_OUTPUT || '../build-web-work/task-planning/gif-input/results.json',
    { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright'),
    hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const item of fixtures.cases) {
    const bytes = Buffer.from(item.base64, 'base64');
    assert.equal(bytes.length, item.bytes);
    assert.equal(hash(bytes), item.sha256);
}
await fs.mkdir(path.dirname(output), { recursive: true });
const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PAINT_BROWSER_PATH || undefined,
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    }),
    original = createState(32, 24, [255, 255, 255, 255], desktopLimits),
    result = {
        url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
        browser: browser.version(),
        testSha256: hash(await fs.readFile(new URL(import.meta.url))),
        fixtureSha256: hash(fixtureBytes),
        checks: [],
        cases: [],
        errors: [],
        failures: [],
        assets: [],
        scope: 'Production public UI with actual tiny Chromium GIF decoding and modeled native file IPC. Literal fixture RGBA runs are the first-frame oracle. This is not a WebKit/ImageIO or browser-intermediate-memory guarantee. Metadata-only oversized fixtures are blocked by an init-installed bitmap spy before any real decoder call if app preflight regresses.',
    };
original.layers[0].pixels.set([193, 71, 117, 0], (2 * 32 + 2) * 4);
function observeBitmap() {
    const real = globalThis.createImageBitmap,
        state = { deny: false, attempts: 0, realCalls: 0, accepted: 0, closed: 0, dimensions: [] };
    window.gifInputObservation = state;
    globalThis.createImageBitmap = async (...args) => {
        state.attempts++;
        if (state.deny) throw Error('Metadata-only fixture: real GIF decoder deliberately disabled');
        state.realCalls++;
        const bitmap = await real(...args),
            close = bitmap.close.bind(bitmap);
        state.accepted++;
        state.dimensions.push([bitmap.width, bitmap.height]);
        bitmap.close = () => {
            state.closed++;
            return close();
        };
        return bitmap;
    };
}
async function boot() {
    const context = await browser.newContext({
            viewport: { width: 1400, height: 1000 },
            deviceScaleFactor: 1,
        }),
        page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => result.errors.push(error.message));
    page.on('request', (request) => {
        if (/\.js(?:[?#]|$)/.test(request.url()) && !result.assets.includes(request.url()))
            result.assets.push(request.url());
    });
    await page.addInitScript(installNativeHarness, {});
    await page.addInitScript(observeBitmap);
    await page.goto(result.url);
    await page.waitForSelector('canvas[data-ready=true]');
    await page.waitForFunction(
        () => window.__myPaintPersistenceTest.generation === 1 && !document.querySelector('dialog[open]'),
    );
    await page.evaluate(
        (bytes) => window.__myPaintPersistenceTest.queueOpen('original.rpaint', Uint8Array.from(bytes)),
        Array.from(encodeProject(original, desktopLimits)),
    );
    await page.getByRole('button', { name: '파일 열기', exact: true }).click();
    await page.waitForFunction(
        () => window.__myPaintPersistenceTest.generation === 2 && !document.querySelector('.busy'),
    );
    const box = await page.locator('.workspace canvas').boundingBox();
    return { context, page, x: box.x + box.width / 2 - 16, y: box.y + box.height / 2 - 12 };
}
async function openFixture(target, fixture) {
    const before = await target.page.evaluate(() => ({
        generation: window.__myPaintPersistenceTest.generation,
        reads: window.__myPaintPersistenceTest.calls.filter((call) => call.command === 'read_selected')
            .length,
        binding: window.__myPaintPersistenceTest.binding,
        title: document.querySelector('.title').textContent,
    }));
    await target.page.evaluate(
        ({ name, bytes, deny }) => {
            const state = window.gifInputObservation;
            state.deny = deny;
            state.attempts = 0;
            state.realCalls = 0;
            state.accepted = 0;
            state.closed = 0;
            state.dimensions = [];
            window.__myPaintPersistenceTest.queueOpen(name + '.gif', Uint8Array.from(bytes));
        },
        {
            name: fixture.name,
            bytes: Array.from(Buffer.from(fixture.base64, 'base64')),
            deny: !!fixture.metadataOnly,
        },
    );
    await target.page.getByRole('button', { name: '파일 열기', exact: true }).click();
    await target.page.waitForFunction(
        ({ reads, generation, reject }) => {
            const state = window.__myPaintPersistenceTest;
            return (
                state.calls.filter((call) => call.command === 'read_selected').length > reads &&
                !document.querySelector('.busy') &&
                (reject || state.generation > generation)
            );
        },
        { reads: before.reads, generation: before.generation, reject: !!fixture.reject },
    );
    await target.page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const after = await target.page.evaluate(() => ({
        generation: window.__myPaintPersistenceTest.generation,
        binding: window.__myPaintPersistenceTest.binding,
        title: document.querySelector('.title').textContent,
        bitmap: { ...window.gifInputObservation },
    }));
    return { before, after };
}
async function save(target, png = false) {
    const count = await target.page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    if (png) {
        await target.page.getByRole('button', { name: '이미지 내보내기', exact: true }).click();
        await target.page.getByLabel('형식', { exact: true }).selectOption('png');
        await target.page.getByRole('dialog').getByRole('button', { name: '내보내기', exact: true }).click();
    } else
        await target.page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await target.page.waitForFunction(
        (count) => window.__myPaintPersistenceTest.writes.length > count && !document.querySelector('.busy'),
        count,
    );
    const bytes = Uint8Array.from(
        await target.page.evaluate(() => Array.from(window.__myPaintPersistenceTest.writes.at(-1).bytes)),
    );
    return png ? { bytes, ...decodePng(bytes, desktopLimits) } : decodeProject(bytes, desktopLimits);
}
try {
    {
        const target = await boot();
        try {
            for (const fixture of fixtures.cases.filter((item) => !item.reject)) {
                const expected = fixture.chromiumExpected,
                    pixels = new Uint8ClampedArray(expected.width * expected.height * 4);
                let offset = 0;
                for (const [count, r, g, b, a] of expected.rgbaRuns)
                    for (let n = 0; n < count; n++) {
                        pixels.set([r, g, b, a], offset);
                        offset += 4;
                    }
                assert.equal(offset, pixels.length);
                const observation = await openFixture(target, fixture),
                    state = await save(target);
                result.cases.push({
                    name: fixture.name,
                    ...observation,
                    expectedSize: [expected.width, expected.height],
                    actualSize: [state.width, state.height],
                    actualPixelSha256: hash(state.layers[0].pixels),
                    expectedPixelSha256: hash(pixels),
                });
                assert.equal(state.width, expected.width);
                assert.equal(state.height, expected.height);
                assert.equal(state.layers.length, 1);
                assert.deepEqual(state.layers[0].pixels, pixels);
                assert.equal(observation.after.bitmap.attempts, 1);
                assert.equal(observation.after.bitmap.realCalls, 1);
                assert.equal(observation.after.bitmap.accepted, 1);
                assert.equal(observation.after.bitmap.closed, 1);
                assert.deepEqual(observation.after.bitmap.dimensions, [[expected.width, expected.height]]);
                result.checks.push('GIF first-frame import: ' + fixture.name);
            }
        } finally {
            await target.context.close();
        }
    }
    {
        const target = await boot();
        try {
            for (const fixture of fixtures.cases.filter((item) => item.reject)) {
                const observation = await openFixture(target, fixture);
                result.cases.push({
                    name: fixture.name,
                    ...observation,
                    rejectedBeforeBitmap: fixture.beforeBitmap,
                });
                if (fixture.beforeBitmap)
                    assert.equal(
                        observation.after.bitmap.attempts,
                        0,
                        'Malformed/oversized first metadata must be rejected before bitmap decode',
                    );
                if (fixture.metadataOnly)
                    assert.equal(
                        observation.after.bitmap.realCalls,
                        0,
                        'Metadata-only fixture must never reach the real decoder',
                    );
                assert.equal(observation.after.generation, observation.before.generation);
                assert.deepEqual(observation.after.binding, observation.before.binding);
                assert.equal(observation.after.title, observation.before.title);
                assert.equal(
                    await target.page.getByRole('button', { name: '실행 취소', exact: true }).isDisabled(),
                    true,
                );
                assert.deepEqual(await save(target), original);
                result.checks.push('GIF invalid input preserves original: ' + fixture.name);
            }
        } finally {
            await target.context.close();
        }
    }
    {
        const name = 'Oversized first offset preserves original, clean state and the existing Redo branch',
            target = await boot();
        try {
            await target.page.getByRole('button', { name: '연필', exact: true }).click();
            await target.page.getByLabel('HEX 색상', { exact: true }).fill('#ff0000');
            await target.page.getByLabel('HEX 색상', { exact: true }).press('Tab');
            await target.page.mouse.move(target.x + 4, target.y + 8);
            await target.page.mouse.down();
            await target.page.mouse.move(target.x + 12, target.y + 8);
            await target.page.mouse.up();
            const painted = await save(target),
                expected = structuredClone(original);
            for (let x = 4; x <= 12; x++) expected.layers[0].pixels.set([255, 0, 0, 255], (8 * 32 + x) * 4);
            assert.deepEqual(painted, expected);
            await target.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await save(target), original);
            assert.equal(
                await target.page.getByRole('button', { name: '다시 실행', exact: true }).isDisabled(),
                false,
            );
            const observation = await openFixture(
                target,
                fixtures.cases.find((item) => item.name === 'oversized-first-offset'),
            );
            result.cases.push({ name, ...observation });
            assert.equal(observation.after.bitmap.attempts, 0);
            assert.equal(observation.after.bitmap.realCalls, 0);
            assert.equal(observation.after.generation, observation.before.generation);
            assert.deepEqual(observation.after.binding, observation.before.binding);
            assert.equal(observation.after.title, observation.before.title);
            assert.deepEqual(await save(target), original);
            assert.equal(
                await target.page.getByRole('button', { name: '다시 실행', exact: true }).isDisabled(),
                false,
            );
            await target.page.getByRole('button', { name: '다시 실행', exact: true }).click();
            assert.deepEqual(await save(target), painted);
            result.checks.push(name);
        } finally {
            await target.context.close();
        }
    }
    {
        const name =
                'Oversized first height preserves pending polygon, pixels, color and one-history continuation',
            target = await boot();
        try {
            await target.page.getByRole('button', { name: '다각형', exact: true }).click();
            await target.page.getByLabel('HEX 색상', { exact: true }).fill('#ff0000');
            await target.page.getByLabel('HEX 색상', { exact: true }).press('Tab');
            await target.page.locator('#secondary').evaluate((input) => {
                input.value = '#0000ff';
                input.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await target.page.locator('#size').evaluate((input) => {
                input.value = '2';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            for (const [x, y] of [
                [4, 4],
                [20, 4],
                [20, 16],
            ])
                await target.page.mouse.click(target.x + x, target.y + y, { button: 'right' });
            const before = await save(target, true),
                sample = (4 * 32 + 12) * 4;
            assert.deepEqual(Array.from(before.pixels.slice(sample, sample + 4)), [0, 0, 255, 255]);
            const observation = await openFixture(
                target,
                fixtures.cases.find((item) => item.name === 'oversized-first-height'),
            );
            result.cases.push({ name, ...observation });
            assert.equal(observation.after.bitmap.attempts, 0);
            assert.equal(observation.after.bitmap.realCalls, 0);
            assert.equal(observation.after.generation, observation.before.generation);
            assert.deepEqual(observation.after.binding, observation.before.binding);
            assert.equal(observation.after.title, observation.before.title);
            const after = await save(target, true);
            assert.deepEqual(
                after.bytes,
                before.bytes,
                'Rejected GIF must not settle or alter pending geometry/colors',
            );
            await target.page.mouse.click(target.x + 4, target.y + 16, { button: 'left' });
            const continued = await save(target, true);
            assert.deepEqual(Array.from(continued.pixels.slice(sample, sample + 4)), [255, 0, 0, 255]);
            await target.page.keyboard.press('Enter');
            const state = await save(target),
                expectedRaw = continued.pixels.slice();
            // PNG composition normalizes invisible RGB; the untouched RPaint sentinel must survive.
            expectedRaw.set([193, 71, 117, 0], (2 * 32 + 2) * 4);
            assert.deepEqual(state.layers[0].pixels, expectedRaw);
            await target.page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await save(target), original);
            assert.equal(
                await target.page.getByRole('button', { name: '실행 취소', exact: true }).isDisabled(),
                true,
            );
            result.checks.push(name);
        } finally {
            await target.context.close();
        }
    }
    assert.deepEqual(result.errors, []);
} catch (error) {
    result.failures.push(String(error.stack || error));
    throw error;
} finally {
    await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
    await browser.close();
}
console.log(JSON.stringify(result, null, 2));
