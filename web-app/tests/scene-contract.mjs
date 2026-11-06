import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { encodePng } from '../src/engine/format.ts';
import { desktopLimits } from '../src/engine/document.ts';
import { installNativeHarness } from './native-harness.mjs';
const mode = process.env.PAINT_SCENE_MODE;
assert(['record', 'compare'].includes(mode), 'Set PAINT_SCENE_MODE=record or compare explicitly');
const output = path.resolve(
        process.env.PAINT_SCENE_OUTPUT || `../build-web-work/task-planning/scene-contract/${mode}.json`,
    ),
    referencePath = process.env.PAINT_SCENE_REFERENCE && path.resolve(process.env.PAINT_SCENE_REFERENCE);
assert(mode === 'record' || referencePath, 'Compare requires PAINT_SCENE_REFERENCE to the recorded JSON');
const reference = referencePath ? JSON.parse(await fs.readFile(referencePath, 'utf8')) : undefined,
    framesDirectory = path.join(path.dirname(output), path.basename(output, '.json') + '-frames');
await fs.mkdir(framesDirectory, { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const results = {
    mode,
    url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
    reference: referencePath,
    browser: browser.version(),
    testSha256: hash(await fs.readFile(new URL(import.meta.url))),
    fixtures: [],
    frames: [],
    documents: [],
    faults: [],
    assets: [],
    checks: [],
    errors: [],
    failures: [],
    scope: 'Actual production main UI and complete workspace Canvas RGBA at DPR1/2, preserving one Canvas element per DPR session. Native files/clipboard are modeled; source pixels are actual 2048²x16 layers. Gzip transports raw getImageData bytes without Canvas PNG/premultiply conversion. Record mode creates a reference only; compare mode performs byte-for-byte comparisons. Timing is not a performance verdict.',
};
const assets = [],
    seenAssets = new Set();
// Build small encoded input without retaining/JSON-transferring all 256MiB source RGBA.
function fixture(name, width, height, count, seed = 0) {
    const header = Buffer.alloc(28),
        parts = [header],
        pixels = new Uint8ClampedArray(width * height * 4),
        layers = [];
    header.write('RPAINT01');
    header.writeUInt32LE(width, 8);
    header.writeUInt32LE(height, 12);
    header.writeUInt32LE(count, 16);
    header.writeUInt32LE(count - 1, 20);
    const block = width > 512 ? 64 : 8;
    for (let layer = 0; layer < count; layer++) {
        for (let by = 0; by < height; by += block) {
            const row = new Uint8ClampedArray(width * 4);
            for (let x = 0; x < width; x++) {
                const bx = Math.floor(x / block),
                    y = Math.floor(by / block),
                    i = x * 4;
                row[i] = (seed + layer * 17 + bx * 11 + y * 3) % 256;
                row[i + 1] = (seed + layer * 29 + bx * 5 + y * 13) % 256;
                row[i + 2] = (seed + layer * 7 + bx * 19 + y * 23) % 256;
                row[i + 3] = layer === 0 ? 255 : 32 + ((layer * 13) % 96);
            }
            for (let y = by; y < Math.min(height, by + block); y++) pixels.set(row, y * width * 4);
        }
        const title = `${name} layer ${String(layer + 1).padStart(2, '0')}`,
            label = Buffer.from(title),
            png = encodePng(width, height, pixels, desktopLimits),
            record = Buffer.alloc(label.length + 9);
        record.writeUInt32LE(label.length);
        label.copy(record, 4);
        record[4 + label.length] = 1;
        record.writeUInt32LE(png.length, 5 + label.length);
        parts.push(record, png);
        layers.push({ name: title, rgbaSha256: hash(pixels) });
    }
    const bytes = Buffer.concat(parts),
        value = { name, width, height, count, bytes, layers };
    results.fixtures.push({
        name,
        width,
        height,
        count,
        authoritativeRGBABytes: width * height * count * 4,
        encodedBytes: bytes.length,
        projectSha256: hash(bytes),
        layers,
    });
    return value;
}
const large = fixture('large', 2048, 2048, 16),
    small = fixture('small', 96, 72, 2, 31),
    replacement = fixture('replacement', 64, 80, 2, 79);
if (reference)
    assert.deepEqual(
        results.fixtures,
        reference.fixtures,
        'Both runs must use identical encoded input and raw layer fixtures',
    );
function instrumentation() {
    const state = {
        puts: 0,
        putBytes: 0,
        captures: 0,
        capturePixels: 0,
        faults: 0,
        armCapture: false,
        failedSurface: undefined,
        main: undefined,
        clipboardWrites: 0,
    };
    window.__sceneContractTest = state;
    for (const prototype of [
        CanvasRenderingContext2D.prototype,
        globalThis.OffscreenCanvasRenderingContext2D?.prototype,
    ].filter(Boolean)) {
        const put = prototype.putImageData,
            draw = prototype.drawImage;
        prototype.putImageData = function (...args) {
            state.puts++;
            state.putBytes += (args.length >= 7 ? args[5] * args[6] : args[0].width * args[0].height) * 4;
            return put.apply(this, args);
        };
        prototype.drawImage = function (...args) {
            const main = document.querySelector('.workspace canvas');
            if (main && args[0] === main && this.canvas !== main) {
                state.captures++;
                state.capturePixels +=
                    args.length === 9 ? args[7] * args[8] : this.canvas.width * this.canvas.height;
                if (state.armCapture) {
                    state.armCapture = false;
                    state.faults++;
                    state.failedSurface = this.canvas;
                    throw Error('Injected scene capture failure');
                }
            }
            return draw.apply(this, args);
        };
    }
    Object.defineProperty(navigator.clipboard, 'write', {
        configurable: true,
        value: async (items) => {
            for (const item of items) await item.getType('image/png');
            state.clipboardWrites++;
        },
    });
}
async function menu(page, name) {
    await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
}
async function resetMetrics(page) {
    await page.evaluate(() => {
        const s = window.__sceneContractTest;
        s.puts = 0;
        s.putBytes = 0;
        s.captures = 0;
        s.capturePixels = 0;
    });
}
async function frame(page, dpr, name, sameAs) {
    const capture = await page.locator('.workspace canvas').evaluate(async (canvas) => {
        let geometry = '',
            stable = 0;
        for (let attempt = 0; attempt < 16; attempt++) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const rect = canvas.getBoundingClientRect(),
                next = [canvas.width, canvas.height, rect.width, rect.height].join(':');
            stable = next === geometry ? stable + 1 : 0;
            geometry = next;
            if (stable >= 2) break;
        }
        if (stable < 2) throw Error('Workspace geometry did not settle');
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const state = window.__sceneContractTest;
        if (!state.main) state.main = canvas;
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data,
            rect = canvas.getBoundingClientRect(),
            compressed = await new Response(
                new Blob([pixels]).stream().pipeThrough(new CompressionStream('gzip')),
            ).arrayBuffer();
        return {
            width: canvas.width,
            height: canvas.height,
            cssWidth: rect.width,
            cssHeight: rect.height,
            canvasStable: state.main === canvas,
            zoom: document.querySelector('#zoom').textContent,
            skin: document.documentElement.dataset.skin,
            dpr: devicePixelRatio,
            bytes: Array.from(new Uint8Array(compressed)),
            metrics: {
                puts: state.puts,
                putBytes: state.putBytes,
                captures: state.captures,
                capturePixels: state.capturePixels,
            },
        };
    });
    assert(capture.canvasStable, 'The application replaced the workspace Canvas element');
    assert.equal(capture.dpr, dpr);
    const packed = Buffer.from(capture.bytes),
        raw = gunzipSync(packed, { maxOutputLength: capture.width * capture.height * 4 + 1 });
    assert.equal(raw.length, capture.width * capture.height * 4);
    for (let i = 3; i < raw.length; i += 4)
        if (raw[i] !== 255) assert.fail(`Workspace background alpha=${raw[i]} at pixel ${(i - 3) / 4}`);
    const id = `dpr${dpr}-${name}`,
        file = path.join(framesDirectory, id + '.rgba.gz'),
        record = {
            id,
            dpr,
            name,
            width: capture.width,
            height: capture.height,
            cssWidth: capture.cssWidth,
            cssHeight: capture.cssHeight,
            zoom: capture.zoom,
            skin: capture.skin,
            canvasStable: capture.canvasStable,
            rgbaSha256: hash(raw),
            rgbaBytes: raw.length,
            file,
            metrics: capture.metrics,
        };
    await fs.writeFile(file, gzipSync(raw, { level: 1 }));
    if (sameAs) {
        const prior = results.frames.find((item) => item.id === `dpr${dpr}-${sameAs}`);
        assert(prior, 'Missing same-run comparison ' + sameAs);
        const expected = gunzipSync(await fs.readFile(prior.file));
        assert.equal(raw.equals(expected), true, `${id} changed pixels relative to ${prior.id}`);
        record.sameAs = prior.id;
    }
    if (reference) {
        const prior = reference.frames.find((item) => item.id === id);
        assert(prior, 'Missing recorded frame ' + id);
        for (const key of ['width', 'height', 'cssWidth', 'cssHeight', 'zoom', 'skin', 'canvasStable'])
            assert.equal(record[key], prior[key], `${id} ${key} differs from reference`);
        const expected = gunzipSync(await fs.readFile(prior.file));
        record.byteEqual = raw.equals(expected);
        if (!record.byteEqual) {
            let mismatches = 0,
                first = -1;
            for (let i = 0; i < raw.length; i++)
                if (raw[i] !== expected[i]) {
                    mismatches++;
                    if (first < 0) first = i;
                }
            record.mismatchedChannels = mismatches;
            record.firstMismatch = first;
        }
        results.frames.push(record);
        assert.equal(
            record.byteEqual,
            true,
            `${id}: actual Canvas RGBA differs (${record.mismatchedChannels} channels, first ${record.firstMismatch})`,
        );
    } else results.frames.push(record);
    console.log(
        'FRAME ' +
            id +
            ' ' +
            record.rgbaSha256 +
            ' uploads=' +
            record.metrics.putBytes +
            ' captures=' +
            record.metrics.captures,
    );
    return record;
}
async function open(page, input) {
    const generation = await page.evaluate(() => window.__myPaintPersistenceTest.generation);
    await page.evaluate(
        ({ name, bytes }) =>
            window.__myPaintPersistenceTest.queueOpen(name + '.rpaint', Uint8Array.from(bytes)),
        { name: input.name, bytes: Array.from(input.bytes) },
    );
    await page.getByRole('button', { name: '파일 열기', exact: true }).click();
    await page.waitForFunction(
        (generation) =>
            window.__myPaintPersistenceTest.generation > generation && !document.querySelector('.busy'),
        generation,
    );
}
async function documentBytes(page, format) {
    const count = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    if (format === 'png') {
        await page.getByRole('button', { name: '이미지 내보내기', exact: true }).click();
        await page.getByLabel('형식', { exact: true }).selectOption('png');
        await page.getByRole('dialog').getByRole('button', { name: '내보내기', exact: true }).click();
    } else await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.waitForFunction(
        (count) => window.__myPaintPersistenceTest.writes.length > count && !document.querySelector('.busy'),
        count,
    );
    return Buffer.from(
        await page.evaluate(() => Array.from(window.__myPaintPersistenceTest.writes.at(-1).bytes)),
    );
}
async function preservation(page, dpr, input, phase, originalPng) {
    const project = await documentBytes(page, 'rpaint');
    assert.equal(project.equals(input.bytes), true, `${input.name}/${phase}: canonical RPaint bytes changed`);
    const png = await documentBytes(page, 'png'),
        file = path.join(framesDirectory, `dpr${dpr}-${input.name}-${phase}.png`);
    await fs.writeFile(file, png);
    if (originalPng)
        assert.equal(png.equals(originalPng), true, `${input.name}/${phase}: raw PNG bytes changed`);
    const record = { dpr, name: input.name, phase, projectSha256: hash(project), pngSha256: hash(png), file };
    if (reference) {
        const prior = reference.documents.find(
            (item) => item.dpr === dpr && item.name === input.name && item.phase === phase,
        );
        assert(prior);
        assert.equal(record.projectSha256, prior.projectSha256);
        assert.equal(png.equals(await fs.readFile(prior.file)), true, 'Raw PNG differs from reference');
        record.byteEqual = true;
    }
    results.documents.push(record);
    return png;
}
async function center(page) {
    const box = await page.locator('.workspace canvas').boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function rename(page, name) {
    await page.getByRole('button', { name: '레이어 이름 변경', exact: true }).click();
    await page.getByLabel('이름', { exact: true }).fill(name);
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
}
try {
    for (const dpr of [1, 2]) {
        const context = await browser.newContext({
                viewport: { width: 1400, height: 1000 },
                deviceScaleFactor: dpr,
            }),
            page = await context.newPage();
        page.setDefaultTimeout(60000);
        page.on('pageerror', (error) => results.errors.push(error.message));
        page.on('response', (response) => {
            if (!/\.js(?:\?|$)/.test(response.url()) || seenAssets.has(response.url())) return;
            seenAssets.add(response.url());
            assets.push(
                response
                    .body()
                    .then((body) => results.assets.push({ url: response.url(), sha256: hash(body) })),
            );
        });
        await page.addInitScript({
            content: `(${installNativeHarness.toString()})({});(${instrumentation.toString()})();`,
        });
        try {
            await page.goto(results.url);
            await page.waitForSelector('canvas[data-ready=true]');
            await page.waitForFunction(
                () =>
                    window.__myPaintPersistenceTest.generation === 1 &&
                    !document.querySelector('dialog[open]'),
            );
            await open(page, large);
            const largePng = await preservation(page, dpr, large, 'before');
            while (Number.parseInt(await page.locator('#zoom').textContent(), 10) < 100)
                await page.getByRole('button', { name: '확대', exact: true }).click();
            await page.getByRole('button', { name: '화면 이동', exact: true }).click();
            let point = await center(page);
            await page.mouse.move(point.x, point.y);
            await page.mouse.down();
            await page.mouse.move(point.x + 240, point.y);
            await page.mouse.up();
            await frame(page, dpr, 'large-working');
            if (mode === 'compare')
                assert(
                    (await page.evaluate(() => window.__sceneContractTest.captures)) > 0,
                    'Representative 16-layer working set did not exercise public main-Canvas capture',
                );
            await resetMetrics(page);
            await rename(page, 'metadata-only');
            await frame(page, dpr, 'large-metadata', 'large-working');
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            await page.getByRole('button', { name: '브러시', exact: true }).click();
            await page.getByLabel('HEX 색상', { exact: true }).fill('#ff0000');
            await page.getByLabel('HEX 색상', { exact: true }).press('Tab');
            await page.locator('#stabilization').evaluate((input) => {
                input.value = '0';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            point = await center(page);
            const cdp = await context.newCDPSession(page);
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mousePressed',
                x: point.x - 60,
                y: point.y,
                button: 'left',
                buttons: 1,
                clickCount: 1,
            });
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: point.x - 10,
                y: point.y,
                button: 'left',
                buttons: 1,
            });
            await frame(page, dpr, 'stroke-provisional');
            await resetMetrics(page);
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: point.x + 60,
                y: point.y,
                button: 'left',
                buttons: 0,
                clickCount: 1,
            });
            await frame(page, dpr, 'stroke-commit');
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            await frame(page, dpr, 'stroke-undo', 'large-working');
            await page.getByRole('button', { name: '다시 실행', exact: true }).click();
            await frame(page, dpr, 'stroke-redo', 'stroke-commit');
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            const touch = { x: point.x - 50, y: point.y + 35, id: 41, force: 1 };
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [{ ...touch, x: point.x + 20 }],
            });
            await frame(page, dpr, 'stroke-cancel-provisional');
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
            await frame(page, dpr, 'stroke-cancelled', 'large-working');
            await cdp.detach();
            await page.locator('.layer-list input[type=checkbox]').first().uncheck();
            await frame(page, dpr, 'large-hide');
            await page.locator('.layer-list input[type=checkbox]').first().check();
            await frame(page, dpr, 'large-unhide', 'large-working');
            await page.getByRole('button', { name: '레이어 아래로 이동', exact: true }).click();
            await frame(page, dpr, 'large-reorder');
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            await frame(page, dpr, 'large-reorder-undo', 'large-working');
            await page.getByRole('button', { name: '사각 선택', exact: true }).click();
            await page.mouse.move(point.x - 30, point.y - 20);
            await page.mouse.down();
            await page.mouse.move(point.x + 10, point.y + 10);
            await page.mouse.up();
            await page.mouse.move(point.x - 20, point.y - 10);
            await page.mouse.down();
            await page.mouse.move(point.x - 4, point.y - 2);
            await page.mouse.up();
            await frame(page, dpr, 'large-selection-move');
            await page.keyboard.press('Escape');
            await frame(page, dpr, 'large-selection-cancelled', 'large-working');
            await page.getByRole('button', { name: '사각형', exact: true }).click();
            await page.mouse.move(point.x - 30, point.y - 20);
            await page.mouse.down();
            await page.mouse.move(point.x + 30, point.y + 20);
            await frame(page, dpr, 'large-shape-preview');
            await page.keyboard.press('Escape');
            await page.mouse.up();
            await frame(page, dpr, 'large-shape-cancelled', 'large-working');
            await preservation(page, dpr, large, 'after', largePng);
            // The same public fault is armed in both runs; only a scene-enabled candidate captures the main Canvas.
            await page.evaluate(() => (window.__sceneContractTest.armCapture = true));
            await page.getByRole('button', { name: '화면 이동', exact: true }).click();
            await page.mouse.move(point.x, point.y);
            await page.mouse.down();
            await page.mouse.move(point.x + 32, point.y);
            await page.mouse.up();
            if (mode === 'compare') {
                await page.waitForFunction(() => window.__sceneContractTest.faults === 1);
                assert.deepEqual(
                    await page.evaluate(() => {
                        const surface = window.__sceneContractTest.failedSurface;
                        return [surface.width, surface.height];
                    }),
                    [0, 0],
                    'Failed scene capture backing storage was not released',
                );
            }
            await page.evaluate(() => (window.__sceneContractTest.armCapture = false));
            await page.getByRole('button', { name: '브러시', exact: true }).click();
            await frame(page, dpr, 'capture-failure-retry');
            results.faults.push({
                dpr,
                injected: await page.evaluate(() => window.__sceneContractTest.faults),
                failedSurfaceReleased: await page.evaluate(() => {
                    const surface = window.__sceneContractTest.failedSurface;
                    return !surface || (!surface.width && !surface.height);
                }),
            });
            await preservation(page, dpr, large, 'after-fault', largePng);
            await open(page, small);
            const smallPng = await preservation(page, dpr, small, 'before');
            await frame(page, dpr, 'small-replacement');
            point = await center(page);
            const left = point.x - 48,
                top = point.y - 36;
            await page.getByRole('button', { name: '사각 선택', exact: true }).click();
            await page.mouse.move(left + 8, top + 8);
            await page.mouse.down();
            await page.mouse.move(left + 32, top + 28);
            await page.mouse.up();
            const clipboardWrites = await page.evaluate(() => window.__sceneContractTest.clipboardWrites);
            await menu(page, '잘라내기');
            await page.waitForFunction(
                (count) =>
                    window.__sceneContractTest.clipboardWrites > count && !document.querySelector('.busy'),
                clipboardWrites,
            );
            await frame(page, dpr, 'small-selection-cut');
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            await frame(page, dpr, 'small-cut-undo', 'small-replacement');
            await page.getByRole('button', { name: '곡선', exact: true }).click();
            await page.mouse.move(left + 10, top + 50);
            await page.mouse.down();
            await page.mouse.move(left + 70, top + 10);
            await page.mouse.up();
            await frame(page, dpr, 'small-curve-preview');
            await page.keyboard.press('Escape');
            await frame(page, dpr, 'small-curve-cancelled', 'small-replacement');
            await page.getByRole('button', { name: '화면 이동', exact: true }).click();
            await page.mouse.move(point.x, point.y);
            await page.mouse.down();
            await page.mouse.move(point.x + 13, point.y - 7);
            await page.mouse.up();
            await frame(page, dpr, 'small-pan');
            for (let i = 0; i < 5; i++) await page.getByRole('button', { name: '축소', exact: true }).click();
            await frame(page, dpr, 'small-physical-fallback');
            assert((Number.parseInt(await page.locator('#zoom').textContent(), 10) / 100) * dpr < 1);
            await page.setViewportSize({ width: 1417, height: 997 });
            await frame(page, dpr, 'small-resize');
            await page.getByRole('button', { name: '환경설정', exact: true }).click();
            await page.getByLabel('스킨', { exact: true }).selectOption('Classic 98');
            await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
            await frame(page, dpr, 'small-classic');
            await page.getByRole('button', { name: '환경설정', exact: true }).click();
            await page.getByLabel('스킨', { exact: true }).selectOption('Studio Dark');
            await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
            await frame(page, dpr, 'small-studio');
            await preservation(page, dpr, small, 'after', smallPng);
            await open(page, replacement);
            await frame(page, dpr, 'second-document-replacement');
            await preservation(page, dpr, replacement, 'after');
            results.checks.push(
                `DPR${dpr}: fixed Canvas lifecycle, ${mode === 'record' ? 'reference frames' : 'exact reference RGBA'}, source preservation and scene retry`,
            );
            console.log('PASS DPR' + dpr + ' ' + mode);
        } catch (error) {
            results.failures.push({
                dpr,
                error: String(error.stack || error),
                status: await page
                    .locator('.status')
                    .textContent()
                    .catch(() => undefined),
            });
            await page
                .screenshot({ path: path.join(path.dirname(output), `failure-dpr${dpr}.png`) })
                .catch(() => {});
            throw error;
        } finally {
            await context.close();
        }
    }
    assert.deepEqual(results.errors, []);
} finally {
    const assetResults = await Promise.allSettled(assets);
    for (const item of assetResults)
        if (item.status === 'rejected') results.errors.push('Asset capture failed: ' + String(item.reason));
    try {
        await fs.writeFile(output, JSON.stringify(results, null, 2) + '\n');
    } finally {
        await browser.close();
    }
}
assert.deepEqual(results.errors, []);
console.log(JSON.stringify(results, null, 2));
