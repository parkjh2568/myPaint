import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync, crc32 } from 'node:zlib';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(
        process.env.PAINT_MASKED_TRANSFORM_OUTPUT ||
            '../build-web-work/task-planning/masked-transform/results.json',
    ),
    out = path.dirname(output),
    hash = (b) => createHash('sha256').update(b).digest('hex'),
    qtBytes = await fs.readFile(new URL('./fixtures/masked-transform-qt-resize.json', import.meta.url)),
    qtFixture = JSON.parse(qtBytes),
    result = {
        url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
        testSha256: hash(await fs.readFile(new URL(import.meta.url))),
        scope: 'Public Chromium original-source masked transform/resize10cases. Two opaque/keyOFF pointer cases compare single versus distinct gestures; extra cancellation/ABA/discrete-bake/profile-failure cases check resize base lifetime and two lasso chains separate original Qt source mask from transformed payload. Explicit keyON dialog roundtrip then Arrow/Enter checks initial NoOp identity invalidation; cut compares the actual delivered PNG and input. Pointercancel and named wrong-profile failures are explicit injected boundary tests, normal Workers/copy data are not edited. Actual copied raw/PNG dimensions and coordinate-label literals are checked; no private Studio state, physical pointer/OS clipboard/native app/performance claim. Same-gesture intermediate dimensions are intended pointer targets, not privately inspected state. One synthetic public-event case counts only synchronous resize output constructions around repeated rounded dimensions, excluding rAF/caches/Workers and any timing or RSS claim.',
        qtOracle: {
            path: 'tests/fixtures/masked-transform-qt-resize.json',
            sha256: hash(qtBytes),
            originalOracleSha256: qtFixture.originalOracleSha256,
            case: 'opaque-rect-two-distinct-resize-gestures-3x2-2x3-3x2',
            sameGestureQtObserved: false,
        },
        cases: [],
        checks: [],
        failures: [],
        errors: [],
        assets: [],
    };
await fs.mkdir(out, { recursive: true });
const availableCases = [
    'single-handle-gesture-roundtrip',
    'two-distinct-handle-gestures',
    'cancel-next-gesture-retains-shrink-and-base',
    'through-base-ABA-keeps-fixed-gesture-source',
    'shrink-flip-resize-bakes-displayed-payload',
    'shrink-geometry-profile-failure-keeps-base',
    'triangle-original-mask-transform-settle',
    'hole-original-mask-transform-cut',
    'explicit-key-dialog-roundtrip-arrow',
    'repeat-rounded-target-keeps-current-output',
];
const selectedCases = process.env.PAINT_MASKED_TRANSFORM_CASES
    ? process.env.PAINT_MASKED_TRANSFORM_CASES.split(',')
    : availableCases;
assert.equal(new Set(selectedCases).size, selectedCases.length);
assert(selectedCases.length && selectedCases.every((name) => availableCases.includes(name)));
result.requestedCases = selectedCases;

function readPng(bytes) {
    assert.deepEqual(Array.from(bytes.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        data = [];
    let width = 0,
        height = 0,
        ended = false,
        offset = 8;
    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset);
        assert(length <= bytes.length - offset - 12);
        const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)),
            chunk = bytes.subarray(offset + 8, offset + 8 + length);
        assert.equal(
            crc32(bytes.subarray(offset + 4, offset + 8 + length)),
            view.getUint32(offset + 8 + length),
        );
        if (name === 'IHDR') {
            assert.equal(offset, 8);
            assert.equal(length, 13);
            width = view.getUint32(offset + 8);
            height = view.getUint32(offset + 12);
            assert(width > 0 && height > 0 && width <= 128 && height <= 128);
            assert.deepEqual(
                Array.from(chunk.subarray(8)),
                [8, 6, 0, 0, 0],
                'This independent reader requires non-interlaced PNG8 RGBA output',
            );
        } else if (name === 'IDAT') data.push(chunk);
        else if (name === 'IEND') {
            assert.equal(length, 0);
            ended = true;
            offset += 12;
            break;
        }
        offset += length + 12;
    }
    assert(ended);
    assert.equal(offset, bytes.length);
    const rowBytes = width * 4,
        raw = inflateSync(Buffer.concat(data), { maxOutputLength: height * (rowBytes + 1) + 1 });
    assert.equal(raw.length, height * (rowBytes + 1));
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (rowBytes + 1)];
        assert(filter <= 4);
        for (let x = 0; x < rowBytes; x++) {
            const a = x >= 4 ? pixels[y * rowBytes + x - 4] : 0,
                b = y ? pixels[(y - 1) * rowBytes + x] : 0,
                c = y && x >= 4 ? pixels[(y - 1) * rowBytes + x - 4] : 0;
            let predictor = 0;
            if (filter === 1) predictor = a;
            if (filter === 2) predictor = b;
            if (filter === 3) predictor = Math.floor((a + b) / 2);
            if (filter === 4) {
                const p = a + b - c,
                    pa = Math.abs(p - a),
                    pb = Math.abs(p - b),
                    pc = Math.abs(p - c);
                predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            pixels[y * rowBytes + x] = (raw[y * (rowBytes + 1) + 1 + x] + predictor) & 255;
        }
    }
    return { width, height, pixels };
}
function instrument() {
    const probe = (window.maskedTransform = {
            writes: [],
            inputs: [],
            projects: [],
            profileFault: false,
            injected: 0,
            pointerId: undefined,
            trackOutputSize: undefined,
            outputAllocations: 0,
        }),
        Original = window.Worker;
    const OriginalPixels = window.Uint8ClampedArray;
    window.Uint8ClampedArray = new Proxy(OriginalPixels, {
        construct(target, args) {
            if (probe.trackOutputSize !== undefined && args.length === 1 && args[0] === probe.trackOutputSize)
                probe.outputAllocations++;
            return Reflect.construct(target, args, target);
        },
    });
    window.addEventListener(
        'pointerdown',
        (event) => {
            if (event.target instanceof HTMLCanvasElement) probe.pointerId = event.pointerId;
        },
        true,
    );
    window.Worker = class extends Original {
        postMessage(message, transfer) {
            if (message.operation === 'png-write')
                probe.inputs.push({
                    width: message.state.width,
                    height: message.state.height,
                    pixels: Array.from(message.state.layers[0].pixels),
                });
            if (message.operation === 'project-write')
                probe.projects.push({
                    width: message.state.width,
                    height: message.state.height,
                    active: message.state.active,
                    background: [...message.state.background],
                    layers: message.state.layers.map((layer) => ({
                        ...layer,
                        pixels: Array.from(layer.pixels),
                    })),
                });
            if (message.operation === 'geometry' && probe.profileFault) {
                probe.profileFault = false;
                probe.injected++;
                this.wrongProfile = true;
            }
            return super.postMessage(message, transfer);
        }
        set onmessage(handler) {
            super.onmessage = (event) =>
                handler.call(
                    this,
                    this.wrongProfile ? { data: { ...event.data, profileId: 'wrong-profile' } } : event,
                );
        }
    };
    Object.defineProperty(navigator.clipboard, 'write', {
        configurable: true,
        value: async (items) => {
            if (items.length !== 1 || items[0].types.length !== 1 || items[0].types[0] !== 'image/png')
                throw Error('Expected actual PNG ClipboardItem');
            probe.writes.push(await items[0].getType('image/png'));
        },
    });
}
function check(record, stage, work) {
    try {
        work();
        record.stages.push({ stage, ok: true });
    } catch (error) {
        const failure = { name: record.name, stage, error: String(error.stack || error) };
        record.stages.push({ stage, ok: false, error: failure.error });
        result.failures.push(failure);
    }
}
async function menu(page, name) {
    await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
}
async function controls(page) {
    return {
        dirty: (await page.title()).startsWith('* '),
        undo: await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
        redo: await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled(),
    };
}
async function copied(page, name) {
    const n = await page.evaluate(() => window.maskedTransform.writes.length);
    await menu(page, '복사');
    await page.waitForFunction(
        (n) => window.maskedTransform.writes.length === n + 1 && !document.querySelector('.busy'),
        n,
    );
    const value = await page.evaluate(async () => ({
        input: window.maskedTransform.inputs.at(-1),
        bytes: Array.from(new Uint8Array(await window.maskedTransform.writes.at(-1).arrayBuffer())),
    }));
    const bytes = Uint8Array.from(value.bytes);
    await fs.writeFile(path.join(out, name + '.png'), bytes);
    return { input: value.input, image: readPng(bytes), pngSha256: hash(bytes) };
}
async function saved(page, name) {
    const n = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.waitForFunction(
        (n) => window.__myPaintPersistenceTest.writes.length > n && !document.querySelector('.busy'),
        n,
    );
    const bytes = Uint8Array.from(
        await page.evaluate(() => [...window.__myPaintPersistenceTest.writes.at(-1).bytes]),
    );
    await fs.writeFile(path.join(out, name + '.rpaint'), bytes);
    return decodeProject(bytes, desktopLimits);
}
function exact(actual, expected) {
    assert.deepEqual(
        [actual.width, actual.height, actual.active, actual.background],
        [expected.width, expected.height, expected.active, expected.background],
    );
    assert.equal(actual.layers.length, expected.layers.length);
    for (let i = 0; i < actual.layers.length; i++) {
        assert.deepEqual(
            [actual.layers[i].name, actual.layers[i].visible],
            [expected.layers[i].name, expected.layers[i].visible],
        );
        assert.deepEqual(actual.layers[i].pixels, expected.layers[i].pixels);
    }
}
async function selected(page, origin) {
    await page.getByRole('button', { name: '사각 선택', exact: true }).click();
    await page.mouse.move(origin.x + 8, origin.y + 8);
    await page.mouse.down();
    await page.mouse.move(origin.x + 11, origin.y + 10);
    await page.mouse.up();
}
async function roundTrip(page, origin, separate, label, record) {
    await page.mouse.move(origin.x + 10.75, origin.y + 9.75);
    await page.mouse.down();
    await page.mouse.move(origin.x + 10, origin.y + 11);
    if (separate) {
        await page.mouse.up();
        const down = await copied(page, label + '-down');
        record.downsamples.push(down.input);
        check(record, label + '-actual2x3', () => {
            assert.deepEqual([down.input.width, down.input.height], [2, 3]);
            const indices = qtFixture.case.stages[0].sourceIndexRows.flat(),
                expected = indices.flatMap((index) => [
                    17 + index * 13,
                    31 + index * 17,
                    101 + index * 19,
                    255,
                ]);
            assert.deepEqual(down.input.pixels, expected);
        });
        await page.mouse.move(origin.x + 9.75, origin.y + 10.75);
        await page.mouse.down();
    }
    await page.mouse.move(origin.x + 11, origin.y + 10);
    await page.mouse.up();
    const returned = await copied(page, label + '-returned');
    record.returned.push(returned.input);
    check(record, label + '-original6labels-restored', () => {
        assert.deepEqual([returned.input.width, returned.input.height], [3, 2]);
        assert.deepEqual(
            returned.input.pixels,
            Array.from({ length: 6 }, (_, index) => [
                17 + index * 13,
                31 + index * 17,
                101 + index * 19,
                255,
            ]).flat(),
        );
        assert.deepEqual([...returned.image.pixels], returned.input.pixels);
    });
    return returned;
}
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
result.browser = browser.version();
try {
    for (const separate of [false, true]) {
        const name = separate ? 'two-distinct-handle-gestures' : 'single-handle-gesture-roundtrip',
            record = {
                name,
                separate,
                stages: [],
                downsamples: [],
                returned: [],
                pointerTargets: {
                    sourceRect: [8, 8, 3, 2],
                    press: [10.75, 9.75],
                    downTarget: [10, 11],
                    secondPress: [9.75, 10.75],
                    returnTarget: [11, 10],
                },
            },
            context = await browser.newContext({
                viewport: { width: 1400, height: 1000 },
                deviceScaleFactor: 1,
            }),
            page = await context.newPage();
        if (!selectedCases.includes(record.name)) {
            await context.close();
            continue;
        }
        result.cases.push(record);
        page.setDefaultTimeout(25000);
        page.on('pageerror', (error) => result.errors.push(error.message));
        page.on('request', (request) => {
            if (/\.js(?:[?#]|$)/.test(request.url()) && !result.assets.includes(request.url()))
                result.assets.push(request.url());
        });
        try {
            const state = createState(64, 48, [0, 0, 0, 0], desktopLimits);
            state.layers[0].name = 'base';
            state.layers.push(
                {
                    name: 'visible original source',
                    visible: true,
                    pixels: new Uint8ClampedArray(64 * 48 * 4),
                },
                { name: 'unrelated upper', visible: true, pixels: new Uint8ClampedArray(64 * 48 * 4) },
            );
            state.active = 1;
            for (let y = 0; y < 48; y++)
                for (let x = 0; x < 64; x++) {
                    const at = (y * 64 + x) * 4;
                    state.layers[0].pixels.set([11 + x, 17 + y, 77, 255], at);
                    state.layers[1].pixels.set([121 + x, 51 + y, 193, 255], at);
                    state.layers[2].pixels.set([31 + x, 11 + y, 97, (x + y) % 3 ? 64 : 0], at);
                }
            for (let i = 0; i < 6; i++)
                state.layers[1].pixels.set(
                    [17 + i * 13, 31 + i * 17, 101 + i * 19, 255],
                    ((8 + Math.floor(i / 3)) * 64 + 8 + (i % 3)) * 4,
                );
            const input = encodeProject(state, desktopLimits);
            await fs.writeFile(path.join(out, name + '-input.rpaint'), input);
            record.inputSha256 = hash(input);
            await page.addInitScript(installNativeHarness, {});
            await page.addInitScript(instrument);
            await page.goto(result.url);
            await page.waitForFunction(
                () =>
                    window.__myPaintPersistenceTest?.generation === 1 &&
                    !document.querySelector('dialog[open]'),
            );
            await page.evaluate(
                (bytes) =>
                    window.__myPaintPersistenceTest.queueOpen('roundtrip.rpaint', Uint8Array.from(bytes)),
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
                origin = { x: box.x + box.width / 2 - 32, y: box.y + box.height / 2 - 24 };
            await page.getByRole('button', { name: '연필', exact: true }).click();
            await page.mouse.click(origin.x + 55.5, origin.y + 40.5);
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await controls(page), { dirty: false, undo: false, redo: true });
            await selected(page, origin);
            await roundTrip(page, origin, separate, name + '-first', record);
            await page.locator('.workspace canvas').focus();
            await page.keyboard.press('Escape');
            const canceled = await saved(page, name + '-cancel-original'),
                canceledControls = await controls(page);
            check(record, 'cancel-original-old-redo', () => {
                exact(canceled, state);
                assert.deepEqual(canceledControls, { dirty: false, undo: false, redo: true });
            });
            await page.getByRole('button', { name: '다시 실행', exact: true }).click();
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            await selected(page, origin);
            await roundTrip(page, origin, separate, name + '-replay', record);
            await page.locator('.workspace canvas').focus();
            await page.keyboard.press('Enter');
            const settledControls = await controls(page),
                settled = await saved(page, name + '-settled');
            record.settledControls = settledControls;
            check(record, 'restored-opaque-settle-is-noop', () => {
                exact(settled, state);
                assert.deepEqual(settledControls, { dirty: false, undo: false, redo: true });
            });
            record.resources = await page.evaluate(() => ({
                workers: window.__myPaintPersistenceTest.liveWorkers.size,
                busy: !!document.querySelector('.busy'),
                inert: [...document.querySelectorAll('.topbar,.tools,.inspector')].map((node) => node.inert),
            }));
            check(record, 'resource-release', () =>
                assert.deepEqual(record.resources, { workers: 0, busy: false, inert: [false, false, false] }),
            );
            record.ok = record.stages.every((stage) => stage.ok);
            if (record.ok) result.checks.push(name);
        } catch (error) {
            record.error = String(error.stack || error);
            result.failures.push({ name, stage: 'execution', error: record.error });
        } finally {
            await context.close();
        }
    }
    await extraCases(browser);
    if (selectedCases.includes('explicit-key-dialog-roundtrip-arrow')) await keyArrowCase(browser);
} finally {
    await browser.close();
    result.ok =
        result.checks.length === selectedCases.length && !result.errors.length && !result.failures.length;
    await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ output, ok: result.ok, checks: result.checks, failures: result.failures }));
    if (!result.ok) process.exitCode = 1;
}
function payloadExact(copy, pixels, width, height) {
    assert.deepEqual([copy.input.width, copy.input.height], [width, height]);
    assert.deepEqual(Uint8ClampedArray.from(copy.input.pixels), pixels);
    const png = pixels.slice();
    for (let i = 0; i < png.length; i += 4) if (!png[i + 3]) png.fill(0, i, i + 4);
    assert.deepEqual([copy.image.width, copy.image.height], [width, height]);
    assert.deepEqual(copy.image.pixels, png);
}
function labels(rows) {
    return Uint8ClampedArray.from(
        rows.flatMap((row) => row.flatMap((i) => [17 + i * 13, 31 + i * 17, 101 + i * 19, 255])),
    );
}
async function handle(page, origin, width, height, nextWidth, nextHeight) {
    await page.mouse.move(origin.x + 8 + width - 0.25, origin.y + 8 + height - 0.25);
    await page.mouse.down();
    await page.mouse.move(origin.x + 8 + nextWidth, origin.y + 8 + nextHeight);
    await page.mouse.up();
}
async function transform(page, kind, width, height) {
    const n = await page.evaluate(
        () => window.__myPaintPersistenceTest.codecJobs.filter((job) => job.operation === 'geometry').length,
    );
    if (kind === 'resize') {
        await menu(page, '선택 크기');
        await page.getByLabel('너비', { exact: true }).fill(String(width));
        await page.getByLabel('높이', { exact: true }).fill(String(height));
        await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
    } else await menu(page, kind === 'rotate' ? '오른쪽 회전' : '좌우 반전');
    await page.waitForFunction(
        (n) =>
            window.__myPaintPersistenceTest.codecJobs.filter((job) => job.operation === 'geometry').length ===
                n + 1 &&
            !document.querySelector('.busy') &&
            window.__myPaintPersistenceTest.liveWorkers.size === 0,
        n,
    );
}
async function lasso(page, origin, points) {
    await page.getByRole('button', { name: '자유 선택', exact: true }).click();
    await page.mouse.move(origin.x + points[0][0], origin.y + points[0][1]);
    await page.mouse.down();
    for (const [x, y] of points.slice(1)) await page.mouse.move(origin.x + x, origin.y + y);
    await page.mouse.move(origin.x + points[0][0], origin.y + points[0][1]);
    await page.mouse.up();
}
async function extraCases(browser) {
    const literal = JSON.parse(
            await fs.readFile(new URL('./fixtures/masked-transform-literal.json', import.meta.url), 'utf8'),
        ),
        palette = [
            [180, 30, 70, 255],
            [240, 20, 80, 1],
            [250, 10, 100, 1],
            [80, 144, 220, 128],
            [255, 255, 255, 128],
            [255, 255, 255, 255],
            [23, 89, 210, 0],
            [230, 12, 59, 0],
        ],
        specifications = [
            { name: 'cancel-next-gesture-retains-shrink-and-base', kind: 'cancel' },
            { name: 'through-base-ABA-keeps-fixed-gesture-source', kind: 'aba' },
            { name: 'repeat-rounded-target-keeps-current-output', kind: 'repeat' },
            { name: 'shrink-flip-resize-bakes-displayed-payload', kind: 'bake' },
            { name: 'shrink-geometry-profile-failure-keeps-base', kind: 'profile' },
            ...literal.cases.map((f) => ({ ...f, kind: 'mask' })),
        ];
    for (const spec of specifications) {
        const context = await browser.newContext({
                viewport: { width: 1400, height: 1000 },
                deviceScaleFactor: 1,
            }),
            page = await context.newPage(),
            record = { name: spec.name, stages: [] };
        if (!selectedCases.includes(record.name)) {
            await context.close();
            continue;
        }
        result.cases.push(record);
        page.setDefaultTimeout(25000);
        page.on('pageerror', (error) => result.errors.push(error.message));
        page.on('request', (request) => {
            if (/\.js(?:[?#]|$)/.test(request.url()) && !result.assets.includes(request.url()))
                result.assets.push(request.url());
        });
        try {
            const state = createState(64, 48, [0, 0, 0, 0], desktopLimits);
            state.layers[0].name = 'base';
            state.layers.push(
                {
                    name: spec.kind === 'mask' ? 'hidden original masked source' : 'visible original source',
                    visible: spec.kind !== 'mask',
                    pixels: new Uint8ClampedArray(64 * 48 * 4),
                },
                { name: 'unrelated upper', visible: true, pixels: new Uint8ClampedArray(64 * 48 * 4) },
            );
            state.active = 1;
            for (let y = 0; y < 48; y++)
                for (let x = 0; x < 64; x++) {
                    const at = (y * 64 + x) * 4;
                    state.layers[0].pixels.set([11 + x, 17 + y, 77, 255], at);
                    state.layers[1].pixels.set(
                        spec.kind === 'mask' ? palette[(x + 3 * y) % 8] : [121 + x, 51 + y, 193, 255],
                        at,
                    );
                    state.layers[2].pixels.set([31 + x, 11 + y, 97, (x + y) % 3 ? 64 : 0], at);
                }
            if (spec.kind !== 'mask')
                for (let i = 0; i < 6; i++)
                    state.layers[1].pixels.set(
                        [17 + i * 13, 31 + i * 17, 101 + i * 19, 255],
                        ((8 + Math.floor(i / 3)) * 64 + 8 + (i % 3)) * 4,
                    );
            else {
                state.layers[0].pixels.set([250, 10, 100, 1], (40 * 64 + 55) * 4);
                state.layers[2].pixels.set([193, 71, 117, 0], (40 * 64 + 55) * 4);
            }
            const input = encodeProject(state, desktopLimits);
            await fs.writeFile(path.join(out, spec.name + '-input.rpaint'), input);
            record.inputSha256 = hash(input);
            await page.addInitScript(installNativeHarness, {});
            await page.addInitScript(instrument);
            await page.goto(result.url);
            await page.waitForFunction(
                () =>
                    window.__myPaintPersistenceTest?.generation === 1 &&
                    !document.querySelector('dialog[open]'),
            );
            await page.evaluate(
                (bytes) =>
                    window.__myPaintPersistenceTest.queueOpen('mask-chain.rpaint', Uint8Array.from(bytes)),
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
                origin = { x: box.x + box.width / 2 - 32, y: box.y + box.height / 2 - 24 };
            await page.getByRole('button', { name: '연필', exact: true }).click();
            await page.mouse.click(origin.x + 55.5, origin.y + 40.5);
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert.deepEqual(await controls(page), { dirty: false, undo: false, redo: true });
            if (spec.kind !== 'mask') {
                await selected(page, origin);
                await handle(page, origin, 3, 2, 2, 3);
                const down = await copied(page, spec.name + '-shrink');
                check(record, 'shrink-literal2x3', () =>
                    payloadExact(
                        down,
                        labels([
                            [0, 2],
                            [0, 2],
                            [3, 5],
                        ]),
                        2,
                        3,
                    ),
                );
                if (spec.kind === 'cancel') {
                    await page.mouse.move(origin.x + 9.75, origin.y + 10.75);
                    await page.mouse.down();
                    await page.mouse.move(origin.x + 12, origin.y + 12);
                    record.cancelSignal = await page.locator('.workspace canvas').evaluate((canvas) => {
                        const pointerId = window.maskedTransform.pointerId,
                            hadCapture = canvas.hasPointerCapture(pointerId);
                        canvas.dispatchEvent(
                            new PointerEvent('pointercancel', {
                                pointerId,
                                pointerType: 'mouse',
                                bubbles: true,
                            }),
                        );
                        return { hadCapture, released: !canvas.hasPointerCapture(pointerId) };
                    });
                    await page.mouse.up();
                    const canceled = await copied(page, spec.name + '-canceled-current');
                    check(record, 'cancel-restores-current-shrink', () => {
                        assert.deepEqual(record.cancelSignal, { hadCapture: true, released: true });
                        payloadExact(
                            canceled,
                            labels([
                                [0, 2],
                                [0, 2],
                                [3, 5],
                            ]),
                            2,
                            3,
                        );
                    });
                    await handle(page, origin, 2, 3, 3, 2);
                    const restored = await copied(page, spec.name + '-restore-base');
                    check(record, 'cancel-retains-original-base', () =>
                        payloadExact(
                            restored,
                            labels([
                                [0, 1, 2],
                                [3, 4, 5],
                            ]),
                            3,
                            2,
                        ),
                    );
                } else if (spec.kind === 'repeat') {
                    await page.mouse.move(origin.x + 9.75, origin.y + 10.75);
                    await page.mouse.down();
                    record.allocationSignal = await page
                        .locator('.workspace canvas')
                        .evaluate((canvas, origin) => {
                            const probe = window.maskedTransform,
                                pointerId = probe.pointerId,
                                counts = [];
                            probe.outputAllocations = 0;
                            try {
                                probe.trackOutputSize = 4 * 5 * 4;
                                for (const delta of [0, 0.1, 0.2, 0.3]) {
                                    const before = probe.outputAllocations;
                                    canvas.dispatchEvent(
                                        new PointerEvent('pointermove', {
                                            pointerId,
                                            pointerType: 'mouse',
                                            buttons: 1,
                                            button: -1,
                                            clientX: origin.x + 12 + delta,
                                            clientY: origin.y + 13 + delta,
                                            bubbles: true,
                                        }),
                                    );
                                    counts.push(probe.outputAllocations - before);
                                }
                                const before = probe.outputAllocations;
                                canvas.dispatchEvent(
                                    new PointerEvent('pointerup', {
                                        pointerId,
                                        pointerType: 'mouse',
                                        buttons: 0,
                                        button: 0,
                                        clientX: origin.x + 12.3,
                                        clientY: origin.y + 13.3,
                                        bubbles: true,
                                    }),
                                );
                                counts.push(probe.outputAllocations - before);
                            } finally {
                                probe.trackOutputSize = undefined;
                            }
                            return { perEvent: counts, total: probe.outputAllocations };
                        }, origin);
                    await page.mouse.up();
                    const repeated = await copied(page, spec.name + '-repeated');
                    check(record, 'same-rounded-move-and-release-reuse-current-output', () => {
                        assert.deepEqual(record.allocationSignal, { perEvent: [1, 0, 0, 0, 0], total: 1 });
                        payloadExact(
                            repeated,
                            labels([
                                [0, 1, 1, 2],
                                [0, 1, 1, 2],
                                [0, 1, 1, 2],
                                [3, 4, 4, 5],
                                [3, 4, 4, 5],
                            ]),
                            4,
                            5,
                        );
                    });
                    await handle(page, origin, 4, 5, 3, 2);
                    const restored = await copied(page, spec.name + '-restore');
                    check(record, 'changed-target-still-restores-original-base', () =>
                        payloadExact(
                            restored,
                            labels([
                                [0, 1, 2],
                                [3, 4, 5],
                            ]),
                            3,
                            2,
                        ),
                    );
                    await page.locator('.workspace canvas').focus();
                    await page.keyboard.press('Enter');
                    const finalControls = await controls(page);
                    check(record, 'base-return-settle-noop', () =>
                        assert.deepEqual(finalControls, { dirty: false, undo: false, redo: true }),
                    );
                } else if (spec.kind === 'aba') {
                    await page.mouse.move(origin.x + 9.75, origin.y + 10.75);
                    await page.mouse.down();
                    await page.mouse.move(origin.x + 11, origin.y + 10);
                    await page.mouse.move(origin.x + 12, origin.y + 13);
                    await page.mouse.up();
                    const enlarged = await copied(page, spec.name + '-larger');
                    check(record, 'through-base-still-samples-original3x2', () =>
                        payloadExact(
                            enlarged,
                            labels([
                                [0, 1, 1, 2],
                                [0, 1, 1, 2],
                                [0, 1, 1, 2],
                                [3, 4, 4, 5],
                                [3, 4, 4, 5],
                            ]),
                            4,
                            5,
                        ),
                    );
                } else {
                    if (spec.kind === 'profile') {
                        await page.evaluate(() => (window.maskedTransform.profileFault = true));
                        await transform(page, 'flip');
                        await page.waitForFunction(() =>
                            document.querySelector('.status').textContent.includes('일치'),
                        );
                        const failed = await copied(page, spec.name + '-failed');
                        check(record, 'profile-error-retains-current', () =>
                            payloadExact(
                                failed,
                                labels([
                                    [0, 2],
                                    [0, 2],
                                    [3, 5],
                                ]),
                                2,
                                3,
                            ),
                        );
                        await handle(page, origin, 2, 3, 3, 2);
                        const base = await copied(page, spec.name + '-base-after-failure');
                        check(record, 'profile-error-retains-base', () =>
                            payloadExact(
                                base,
                                labels([
                                    [0, 1, 2],
                                    [3, 4, 5],
                                ]),
                                3,
                                2,
                            ),
                        );
                        await handle(page, origin, 3, 2, 2, 3);
                    }
                    await transform(page, 'flip');
                    const flipped = await copied(page, spec.name + '-flipped');
                    check(record, 'flip-uses-displayed-shrink', () =>
                        payloadExact(
                            flipped,
                            labels([
                                [2, 0],
                                [2, 0],
                                [5, 3],
                            ]),
                            2,
                            3,
                        ),
                    );
                    await handle(page, origin, 2, 3, 3, 2);
                    const after = await copied(page, spec.name + '-resize-after-flip');
                    check(record, 'nonresize-bakes-new-base', () =>
                        payloadExact(
                            after,
                            labels([
                                [2, 2, 0],
                                [5, 5, 3],
                            ]),
                            3,
                            2,
                        ),
                    );
                }
                await page.locator('.workspace canvas').focus();
                await page.keyboard.press('Escape');
                const source = await saved(page, spec.name + '-escaped-source'),
                    sourceControls = await controls(page);
                check(record, 'escape-original-old-redo', () => {
                    exact(source, state);
                    assert.deepEqual(sourceControls, { dirty: false, undo: false, redo: true });
                });
            } else {
                await page.getByRole('button', { name: '스포이트', exact: true }).click();
                await page.mouse.click(origin.x + 55.5, origin.y + 40.5);
                await page.getByRole('button', { name: '전경색 보조색 바꾸기', exact: true }).click();
                await page.locator('#transparent-selection').setChecked(spec.transparent);
                const [left, top, width, height] = spec.sourceRect,
                    lifted = new Uint8ClampedArray(width * height * 4);
                for (let y = 0; y < height; y++)
                    for (let x = 0; x < width; x++) {
                        const j = (y * width + x) * 4,
                            i = ((top + y) * 64 + left + x) * 4;
                        lifted.set(state.layers[1].pixels.subarray(i, i + 4), j);
                        if (
                            spec.maskRows[y][x] !== '#' ||
                            (spec.transparent &&
                                lifted[j + 3] === 1 &&
                                Math.round(lifted[j] / 255) === 1 &&
                                Math.round(lifted[j + 1] / 255) === 0 &&
                                Math.round(lifted[j + 2] / 255) === 0)
                        )
                            lifted[j + 3] = 0;
                    }
                await lasso(page, origin, spec.rawPoints);
                const initial = await copied(page, spec.name + '-initial');
                check(record, 'original-Qt-mask-raw-png', () => payloadExact(initial, lifted, width, height));
                await page.locator('.workspace canvas').focus();
                for (let i = 0; i < left + 3; i++) await page.keyboard.press('ArrowLeft');
                for (let i = 0; i < top + 2; i++) await page.keyboard.press('ArrowUp');
                let current = lifted,
                    currentWidth = width,
                    currentHeight = height;
                for (const [n, step] of spec.steps.entries()) {
                    if (spec.profileFaultBeforeStep === n) {
                        await page.evaluate(() => (window.maskedTransform.profileFault = true));
                        await transform(
                            page,
                            step.kind,
                            step.sourceIndexRows[0].length,
                            step.sourceIndexRows.length,
                        );
                        await page.waitForFunction(() =>
                            document.querySelector('.status').textContent.includes('일치'),
                        );
                        const failed = await copied(page, spec.name + '-failed-step-' + n);
                        check(record, 'failed-transform-keeps-current-and-mask', () =>
                            payloadExact(failed, current, currentWidth, currentHeight),
                        );
                    }
                    await transform(
                        page,
                        step.kind,
                        step.sourceIndexRows[0].length,
                        step.sourceIndexRows.length,
                    );
                    const expected = new Uint8ClampedArray(
                        step.sourceIndexRows.length * step.sourceIndexRows[0].length * 4,
                    );
                    for (let y = 0; y < step.sourceIndexRows.length; y++)
                        for (let x = 0; x < step.sourceIndexRows[0].length; x++) {
                            const index = step.sourceIndexRows[y][x];
                            expected.set(
                                lifted.subarray(index * 4, index * 4 + 4),
                                (y * step.sourceIndexRows[0].length + x) * 4,
                            );
                        }
                    current = expected;
                    currentWidth = step.sourceIndexRows[0].length;
                    currentHeight = step.sourceIndexRows.length;
                    const observed = await copied(page, spec.name + '-step-' + n);
                    check(record, 'literal-payload-step-' + n, () =>
                        payloadExact(observed, current, currentWidth, currentHeight),
                    );
                }
                const before = await page.evaluate(() => ({
                    picks: window.__myPaintPersistenceTest.pickerCount,
                    writes: window.__myPaintPersistenceTest.writes.length,
                }));
                await page.evaluate(() => window.__myPaintPersistenceTest.savePicks.push(null));
                await menu(page, '프로젝트 다른 이름 저장');
                await page.waitForFunction(
                    (n) =>
                        window.__myPaintPersistenceTest.pickerCount === n + 1 &&
                        !document.querySelector('.busy'),
                    before.picks,
                );
                const canceled = await copied(page, spec.name + '-save-canceled'),
                    writes = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
                check(record, 'save-cancel-payload', () => {
                    assert.equal(writes, before.writes);
                    payloadExact(canceled, current, currentWidth, currentHeight);
                });
                const expected = structuredClone(state),
                    destination = expected.layers[1].pixels;
                for (let y = 0; y < height; y++)
                    for (let x = 0; x < width; x++)
                        if (spec.maskRows[y][x] === '#')
                            destination.set([0, 0, 0, 0], ((top + y) * 64 + left + x) * 4);
                if (spec.action === 'settle') {
                    expected.layers[1].visible = true;
                    for (let y = 0; y < currentHeight; y++)
                        for (let x = 0; x < currentWidth; x++) {
                            const tx = x - 3,
                                ty = y - 2;
                            if (tx < 0 || ty < 0 || tx >= 64 || ty >= 48) continue;
                            const i = (ty * 64 + tx) * 4,
                                j = (y * currentWidth + x) * 4,
                                a = current[j + 3] / 255;
                            if (!a) continue;
                            const b = destination[i + 3] / 255,
                                alpha = a + b * (1 - a);
                            for (let c = 0; c < 3; c++)
                                destination[i + c] = Math.round(
                                    (current[j + c] * a + destination[i + c] * b * (1 - a)) / alpha,
                                );
                            destination[i + 3] = Math.round(alpha * 255);
                        }
                    await page.locator('.workspace canvas').focus();
                    await page.keyboard.press('Enter');
                } else {
                    const n = await page.evaluate(() => window.maskedTransform.writes.length);
                    await menu(page, '잘라내기');
                    await page.waitForFunction(
                        (n) =>
                            window.maskedTransform.writes.length === n + 1 &&
                            !document.querySelector('.busy'),
                        n,
                    );
                }
                if (spec.action === 'cut') {
                    const delivered = await page.evaluate(async () => ({
                        input: window.maskedTransform.inputs.at(-1),
                        bytes: Array.from(
                            new Uint8Array(await window.maskedTransform.writes.at(-1).arrayBuffer()),
                        ),
                    }));
                    const deliveredBytes = Uint8Array.from(delivered.bytes);
                    await fs.writeFile(path.join(out, spec.name + '-cut-delivered.png'), deliveredBytes);
                    check(record, 'actual-transformed-cut-png-and-input', () =>
                        payloadExact(
                            { input: delivered.input, image: readPng(deliveredBytes) },
                            current,
                            currentWidth,
                            currentHeight,
                        ),
                    );
                }
                const committed = await saved(page, spec.name + '-committed');
                check(record, 'original-source-mask-clear-not-payload-geometry', () =>
                    exact(committed, expected),
                );
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                const undone = await saved(page, spec.name + '-undo'),
                    oneUndo = !(await page
                        .getByRole('button', { name: '실행 취소', exact: true })
                        .isEnabled());
                check(record, 'one-undo-original-all-layers', () => {
                    exact(undone, state);
                    assert(oneUndo);
                });
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                const redone = await saved(page, spec.name + '-redo');
                check(record, 'redo-exact', () => exact(redone, committed));
            }
            record.resources = await page.evaluate(() => ({
                workers: window.__myPaintPersistenceTest.liveWorkers.size,
                busy: !!document.querySelector('.busy'),
                inert: [...document.querySelectorAll('.topbar,.tools,.inspector')].map((node) => node.inert),
                injected: window.maskedTransform.injected,
            }));
            check(record, 'resource-release', () =>
                assert.deepEqual(record.resources, {
                    workers: 0,
                    busy: false,
                    inert: [false, false, false],
                    injected:
                        spec.kind === 'profile' ||
                        (spec.profileFaultBeforeStep !== undefined && spec.profileFaultBeforeStep !== null)
                            ? 1
                            : 0,
                }),
            );
            record.ok = record.stages.every((stage) => stage.ok);
            if (record.ok) result.checks.push(spec.name);
        } catch (error) {
            record.error = String(error.stack || error);
            result.failures.push({ name: spec.name, stage: 'execution', error: record.error });
        } finally {
            await context.close();
        }
    }
}
async function keyArrowCase(browser) {
    const name = 'explicit-key-dialog-roundtrip-arrow',
        context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 }),
        page = await context.newPage(),
        record = { name, stages: [] };
    result.cases.push(record);
    page.setDefaultTimeout(25000);
    page.on('pageerror', (error) => result.errors.push(error.message));
    page.on('request', (request) => {
        if (/\.js(?:[?#]|$)/.test(request.url()) && !result.assets.includes(request.url()))
            result.assets.push(request.url());
    });
    try {
        const state = createState(64, 48, [0, 0, 0, 0], desktopLimits);
        state.layers[0].name = 'base';
        state.layers.push(
            { name: 'visible key source', visible: true, pixels: new Uint8ClampedArray(64 * 48 * 4) },
            { name: 'unrelated upper', visible: true, pixels: new Uint8ClampedArray(64 * 48 * 4) },
        );
        state.active = 1;
        for (let y = 0; y < 48; y++)
            for (let x = 0; x < 64; x++) {
                const i = (y * 64 + x) * 4;
                state.layers[0].pixels.set([11 + x, 17 + y, 77, 255], i);
                state.layers[1].pixels.set([121 + x, 51 + y, 193, 255], i);
                state.layers[2].pixels.set([31 + x, 11 + y, 97, (x + y) % 3 ? 64 : 0], i);
            }
        const colors = [
                [255, 255, 255, 255],
                [193, 71, 117, 255],
                [17, 91, 203, 255],
                [61, 137, 89, 255],
                [255, 255, 255, 255],
                [219, 83, 151, 255],
            ],
            payload = Uint8ClampedArray.from(colors.flat()),
            expected = structuredClone(state);
        for (let index = 0; index < 6; index++) {
            const i = ((8 + Math.floor(index / 3)) * 64 + 8 + (index % 3)) * 4;
            state.layers[1].pixels.set(colors[index], i);
            expected.layers[1].pixels.set(index === 0 || index === 4 ? [0, 0, 0, 0] : colors[index], i);
            if (index === 0 || index === 4) payload[index * 4 + 3] = 0;
        }
        const input = encodeProject(state, desktopLimits);
        await fs.writeFile(path.join(out, name + '-input.rpaint'), input);
        record.inputSha256 = hash(input);
        await page.addInitScript(installNativeHarness, {});
        await page.addInitScript(instrument);
        await page.goto(result.url);
        await page.waitForFunction(
            () =>
                window.__myPaintPersistenceTest?.generation === 1 && !document.querySelector('dialog[open]'),
        );
        await page.evaluate(
            (bytes) =>
                window.__myPaintPersistenceTest.queueOpen('key-roundtrip.rpaint', Uint8Array.from(bytes)),
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
            origin = { x: box.x + box.width / 2 - 32, y: box.y + box.height / 2 - 24 };
        await page.getByRole('button', { name: '연필', exact: true }).click();
        await page.mouse.click(origin.x + 55.5, origin.y + 40.5);
        await page.getByRole('button', { name: '실행 취소', exact: true }).click();
        assert.deepEqual(await controls(page), { dirty: false, undo: false, redo: true });
        await page.locator('#secondary').evaluate((input) => {
            input.value = '#ffffff';
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.locator('#transparent-selection').check();
        for (const replay of [false, true]) {
            await selected(page, origin);
            await transform(page, 'resize', 2, 3);
            await transform(page, 'resize', 3, 2);
            await page.locator('.workspace canvas').focus();
            await page.keyboard.press('ArrowRight');
            await page.keyboard.press('ArrowLeft');
            const copiedValue = await copied(page, name + (replay ? '-replay' : '-first') + '-arrow-copy');
            check(record, (replay ? 'replay' : 'first') + '-key-payload-after-arrow', () =>
                payloadExact(copiedValue, payload, 3, 2),
            );
            if (!replay) {
                const before = await page.evaluate(() => ({
                    picks: window.__myPaintPersistenceTest.pickerCount,
                    writes: window.__myPaintPersistenceTest.writes.length,
                    projects: window.maskedTransform.projects.length,
                }));
                await page.evaluate(() => window.__myPaintPersistenceTest.savePicks.push(null));
                await menu(page, '프로젝트 다른 이름 저장');
                await page.waitForFunction(
                    (n) =>
                        window.__myPaintPersistenceTest.pickerCount === n + 1 &&
                        !document.querySelector('.busy'),
                    before.picks,
                );
                const candidate = await page.evaluate(() => window.maskedTransform.projects.at(-1)),
                    projectCount = await page.evaluate(() => window.maskedTransform.projects.length),
                    writeCount = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length),
                    pendingControls = await controls(page);
                check(record, 'canceled-save-candidate-keeps-explicit-key-edit', () => {
                    assert.equal(projectCount, before.projects + 1);
                    assert.equal(writeCount, before.writes);
                    assert.deepEqual(pendingControls, { dirty: false, undo: true, redo: false });
                    const decoded = {
                        ...candidate,
                        layers: candidate.layers.map((layer) => ({
                            ...layer,
                            pixels: Uint8ClampedArray.from(layer.pixels),
                        })),
                    };
                    exact(decoded, expected);
                });
                const afterCancel = await copied(page, name + '-after-save-cancel');
                check(record, 'save-cancel-keeps-payload', () => payloadExact(afterCancel, payload, 3, 2));
                await page.locator('.workspace canvas').focus();
                await page.keyboard.press('Escape');
                const source = await saved(page, name + '-escaped-source'),
                    sourceControls = await controls(page);
                check(record, 'escape-source-old-redo', () => {
                    exact(source, state);
                    assert.deepEqual(sourceControls, { dirty: false, undo: false, redo: true });
                });
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            } else {
                await page.locator('.workspace canvas').focus();
                await page.keyboard.press('Enter');
                const committedControls = await controls(page),
                    committed = await saved(page, name + '-committed');
                check(record, 'explicit-key-edit-survives-enter', () => {
                    exact(committed, expected);
                    assert.deepEqual(committedControls, { dirty: true, undo: true, redo: false });
                });
                await page.getByRole('button', { name: '실행 취소', exact: true }).click();
                const undone = await saved(page, name + '-undo'),
                    oneUndo = !(await page
                        .getByRole('button', { name: '실행 취소', exact: true })
                        .isEnabled());
                check(record, 'one-undo-original', () => {
                    exact(undone, state);
                    assert(oneUndo);
                });
                await page.getByRole('button', { name: '다시 실행', exact: true }).click();
                const redone = await saved(page, name + '-redo');
                check(record, 'redo-key-edit', () => exact(redone, expected));
            }
        }
        record.resources = await page.evaluate(() => ({
            workers: window.__myPaintPersistenceTest.liveWorkers.size,
            busy: !!document.querySelector('.busy'),
            inert: [...document.querySelectorAll('.topbar,.tools,.inspector')].map((node) => node.inert),
        }));
        check(record, 'resource-release', () =>
            assert.deepEqual(record.resources, { workers: 0, busy: false, inert: [false, false, false] }),
        );
        record.ok = record.stages.every((stage) => stage.ok);
        if (record.ok) result.checks.push(name);
    } catch (error) {
        record.error = String(error.stack || error);
        result.failures.push({ name, stage: 'execution', error: record.error });
    } finally {
        await context.close();
    }
}
