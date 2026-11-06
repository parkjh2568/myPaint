import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(
        process.env.PAINT_FILL_KEY_OUTPUT ||
            '../build-web-work/task-planning/fill-cut-key/fill-ui/results.json',
    ),
    out = path.dirname(output),
    hash = (bytes) => createHash('sha256').update(bytes).digest('hex'),
    fixtureBytes = await fs.readFile(new URL('./fixtures/flood-key-qt.json', import.meta.url)),
    fixtures = JSON.parse(fixtureBytes),
    result = {
        url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
        scope: 'Public Chromium picker/fill with the actual codec Worker and modeled desktop file IPC. Six literal Qt connectivity/NoOp masks; straight RGBA storage is preserved without imposing Qt premultiplied RGB quantization. No private Studio hooks, worker-response edits, OS picker, physical input or performance acceptance.',
        testSha256: hash(await fs.readFile(new URL(import.meta.url))),
        fixtureSha256: hash(fixtureBytes),
        sourceSha256: {},
        assets: [],
        cases: [],
        checks: [],
        errors: [],
        failures: [],
    };
await fs.mkdir(out, { recursive: true });
for (const file of ['main.ts', 'engine/document.ts', 'engine/operations.ts', 'workers/codec.worker.ts'])
    result.sourceSha256[file] = hash(await fs.readFile(new URL('../src/' + file, import.meta.url)));
async function save(page, name) {
    const before = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.waitForFunction(
        (n) => window.__myPaintPersistenceTest.writes.length > n && !document.querySelector('.busy'),
        before,
    );
    const bytes = Uint8Array.from(
        await page.evaluate(() => [...window.__myPaintPersistenceTest.writes.at(-1).bytes]),
    );
    await fs.writeFile(path.join(out, name + '.rpaint'), bytes);
    return decodeProject(bytes, desktopLimits);
}
function exact(actual, expected) {
    assert.equal(actual.width, expected.width);
    assert.equal(actual.height, expected.height);
    assert.equal(actual.active, expected.active);
    assert.deepEqual(actual.background, expected.background);
    assert.equal(actual.layers.length, expected.layers.length);
    for (let i = 0; i < expected.layers.length; i++) {
        assert.equal(actual.layers[i].name, expected.layers[i].name);
        assert.equal(actual.layers[i].visible, expected.layers[i].visible);
        assert.deepEqual(
            actual.layers[i].pixels,
            expected.layers[i].pixels,
            'Full layer raw RGBA must match literal expectation',
        );
    }
}
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
result.browser = browser.version();
try {
    assert.equal(fixtures.cases.length, 6);
    for (const [index, fixture] of fixtures.cases.entries()) {
        const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } }),
            page = await context.newPage(),
            record = { name: fixture.name, changed: fixture.changed, changedMask: fixture.changedMask };
        result.cases.push(record);
        page.setDefaultTimeout(30000);
        page.on('pageerror', (error) => result.errors.push(error.message));
        page.on('request', (request) => {
            if (/\.js(?:[?#]|$)/.test(request.url()) && !result.assets.includes(request.url()))
                result.assets.push(request.url());
        });
        try {
            const state = createState(64, 64, [0, 0, 0, 0], desktopLimits);
            state.layers[0].name = 'visible picker sample';
            state.layers[0].pixels.set(fixture.replacement, (50 * 64 + 50) * 4);
            state.layers.push({
                name: 'hidden fill target',
                visible: false,
                pixels: new Uint8ClampedArray(64 * 64 * 4),
            });
            state.active = 1;
            for (let at = 0; at < state.layers[1].pixels.length; at += 4)
                state.layers[1].pixels.set([99, 99, 99, 255], at);
            for (let y = 0; y < fixture.height; y++)
                for (let x = 0; x < fixture.width; x++)
                    state.layers[1].pixels.set(
                        fixture.palette[fixture.rows[y][x]],
                        ((10 + y) * 64 + 10 + x) * 4,
                    );
            const input = encodeProject(state, desktopLimits),
                prefix = String(index + 1).padStart(2, '0');
            await fs.writeFile(path.join(out, prefix + '-input.rpaint'), input);
            record.inputSha256 = hash(input);
            record.originalLayerSha256 = state.layers.map((layer) => hash(layer.pixels));
            await page.addInitScript(installNativeHarness, {});
            await page.goto(result.url);
            await page.waitForFunction(
                () =>
                    window.__myPaintPersistenceTest?.generation === 1 &&
                    !document.querySelector('dialog[open]'),
            );
            await page.evaluate(
                (bytes) =>
                    window.__myPaintPersistenceTest.queueOpen('fill-key.rpaint', Uint8Array.from(bytes)),
                [...input],
            );
            await page.getByRole('button', { name: '파일 열기', exact: true }).click();
            await page.waitForFunction(
                () =>
                    window.__myPaintPersistenceTest.generation === 2 &&
                    !document.querySelector('.busy') &&
                    document.querySelector('.workspace canvas').dataset.ready === 'true',
            );
            assert.equal(await page.locator('#zoom').textContent(), '100%');
            const box = await page.locator('.workspace canvas').boundingBox(),
                left = box.x + box.width / 2 - 32,
                top = box.y + box.height / 2 - 32;
            await page.getByRole('button', { name: '연필', exact: true }).click();
            await page.mouse.click(left + 55.5, top + 55.5);
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            assert(!(await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled()));
            assert(!(await page.title()).startsWith('* '));
            await page.getByRole('button', { name: '스포이트', exact: true }).click();
            await page.mouse.click(left + 50.5, top + 50.5);
            assert(
                await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled(),
                'Picker must preserve Redo',
            );
            assert(!(await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled()));
            assert(!(await page.title()).startsWith('* '));
            exact(await save(page, prefix + '-picked-source'), state);
            const previousJobs = await page.evaluate(
                () =>
                    window.__myPaintPersistenceTest.codecJobs.filter((job) => job.operation === 'fill')
                        .length,
            );
            await page.getByRole('button', { name: '채우기', exact: true }).click();
            await page.mouse.click(left + 10 + fixture.start[0] + 0.5, top + 10 + fixture.start[1] + 0.5);
            await page.waitForFunction(
                (n) =>
                    window.__myPaintPersistenceTest.codecJobs.filter((job) => job.operation === 'fill')
                        .length ===
                        n + 1 && !document.querySelector('.busy'),
                previousJobs,
            );
            record.afterFill = {
                dirty: (await page.title()).startsWith('* '),
                undo: await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
                redo: await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled(),
            };
            assert.deepEqual(record.afterFill, {
                dirty: fixture.changed,
                undo: fixture.changed,
                redo: !fixture.changed,
            });
            const expected = {
                ...state,
                layers: state.layers.map((layer) => ({ ...layer, pixels: layer.pixels.slice() })),
            };
            expected.layers[1].visible = fixture.changed;
            for (let y = 0; y < fixture.height; y++)
                for (let x = 0; x < fixture.width; x++)
                    if (fixture.changedMask[y][x] === '#')
                        expected.layers[1].pixels.set(fixture.replacement, ((10 + y) * 64 + 10 + x) * 4);
            const filled = await save(page, prefix + '-filled');
            exact(filled, expected);
            if (fixture.changed) {
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                exact(await save(page, prefix + '-undo'), state);
                assert(!(await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled()));
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                exact(await save(page, prefix + '-redo'), expected);
            } else {
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                const seeded = {
                    ...state,
                    layers: state.layers.map((layer) => ({ ...layer, pixels: layer.pixels.slice() })),
                };
                seeded.layers[1].visible = true;
                seeded.layers[1].pixels.set([22, 121, 234, 255], (55 * 64 + 55) * 4);
                exact(await save(page, prefix + '-preserved-redo'), seeded);
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                exact(await save(page, prefix + '-undo-preserved-redo'), state);
            }
            record.finalLayerSha256 = filled.layers.map((layer) => hash(layer.pixels));
            record.workers = await page.evaluate(() => window.__myPaintPersistenceTest.liveWorkers.size);
            assert.equal(record.workers, 0);
            record.ok = true;
            result.checks.push(fixture.name);
        } catch (error) {
            record.error = String(error.stack || error);
            result.failures.push({ name: fixture.name, error: record.error });
        } finally {
            await context.close();
        }
    }
} finally {
    await browser.close();
    result.ok = result.checks.length === 6 && !result.failures.length && !result.errors.length;
    await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ output, ok: result.ok, checks: result.checks, failures: result.failures }));
    if (!result.ok) process.exitCode = 1;
}
