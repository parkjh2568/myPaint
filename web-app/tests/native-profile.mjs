import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { installNativeHarness } from './native-harness.mjs';
import { encodeProject, decodeProject, decodePng } from '../src/engine/format.ts';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output =
    process.env.PAINT_NATIVE_PROFILE_OUTPUT || '../build-web-work/task-planning/native-profile.json';
await fs.mkdir(path.dirname(output), { recursive: true });
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const result = {
    checks: [],
    errors: [],
    browser: browser.version(),
    scope: 'Chromium with a mocked native bridge verifies UI, profile propagation, pixels and failure boundaries; it does not verify Windows/macOS, WKWebView or OS file I/O.',
    canvasGuard:
        'Main-thread canvases are restricted to 2048 per axis and 4 Mi pixels; Worker canvas allocations are not instrumented.',
};
const url = process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/';
const native = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
const page = await native.newPage();
page.setDefaultTimeout(45000);
page.on('pageerror', (error) => result.errors.push(error.message));
const instrumentNativeProfile = () => {
    window.nativeProfileWrites = window.__myPaintPersistenceTest.writes;
    window.nativeProfileJobs = [];
    window.nativeProfileSurfaces = [];
    window.nativeProfileLiveWorkers = new Set();
    window.nativeProfileHugeAllocations = [];
    const checkSurface = (width, height) => {
        window.nativeProfileSurfaces.push({ width, height });
        if (width > 2048 || height > 2048 || width * height > 4 * 1024 * 1024) {
            throw Error(`Canvas test cap exceeded: ${width}x${height}`);
        }
    };
    const OriginalOffscreen = window.OffscreenCanvas;
    if (OriginalOffscreen) {
        window.OffscreenCanvas = new Proxy(OriginalOffscreen, {
            construct(target, args, newTarget) {
                checkSurface(args[0], args[1]);
                return Reflect.construct(target, args, newTarget);
            },
        });
    }
    for (const property of ['width', 'height']) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, property);
        Object.defineProperty(HTMLCanvasElement.prototype, property, {
            ...descriptor,
            set(value) {
                checkSurface(
                    property === 'width' ? value : this.width,
                    property === 'height' ? value : this.height,
                );
                descriptor.set.call(this, value);
            },
        });
    }
    const OriginalArray = window.Uint8ClampedArray;
    window.Uint8ClampedArray = new Proxy(OriginalArray, {
        construct(target, args, newTarget) {
            if (
                window.observeNativeProfileAllocations &&
                typeof args[0] === 'number' &&
                args[0] > 128 * 1024 * 1024
            )
                window.nativeProfileHugeAllocations.push(args[0]);
            return Reflect.construct(target, args, newTarget);
        },
    });
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
        constructor(...args) {
            super(...args);
            window.nativeProfileLiveWorkers.add(this);
        }
        postMessage(message, transfer) {
            window.nativeProfileJobs.push({ operation: message.operation, profileId: message.profileId });
            if (message.operation === 'geometry' && window.failNativeProfileGeometry) {
                const mode = window.failNativeProfileGeometry;
                window.failNativeProfileGeometry = undefined;
                if (mode === 'error')
                    setTimeout(
                        () =>
                            this.dispatchEvent(
                                new ErrorEvent('error', {
                                    message: 'Injected geometry worker failure',
                                    cancelable: true,
                                }),
                            ),
                        0,
                    );
                else window.nativeProfileHangingGeometry = true;
                return;
            }
            return super.postMessage(message, transfer);
        }
        terminate() {
            window.nativeProfileLiveWorkers.delete(this);
            return super.terminate();
        }
    };
};
await page.addInitScript({
    content: `(${installNativeHarness.toString()})({});\n(${instrumentNativeProfile.toString()})();`,
});
function summarize(state) {
    return {
        width: state.width,
        height: state.height,
        active: state.active,
        background: state.background,
        layers: state.layers.map((layer) => ({
            name: layer.name,
            visible: layer.visible,
            sha256: createHash('sha256').update(layer.pixels).digest('hex'),
            samples: [
                0,
                (Math.floor(state.height / 2) * state.width + Math.floor(state.width / 2)) * 4,
                (state.width * state.height - 1) * 4,
            ].map((index) => [...layer.pixels.subarray(index, index + 4)]),
        })),
    };
}
async function menu(target, name) {
    await target.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
    await target.getByRole('dialog').getByRole('button', { name, exact: true }).click();
}
async function writeResult() {
    await page.waitForFunction(
        () => window.nativeProfileWrites.length > 0 && !document.querySelector('.busy'),
    );
    const written = await page.evaluate(() => {
        const value = window.nativeProfileWrites.at(-1);
        window.nativeProfileWrites.length = 0;
        return { name: value.name, bytes: Array.from(value.bytes) };
    });
    return { name: written.name, bytes: Uint8Array.from(written.bytes) };
}
async function snapshot() {
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    const written = await writeResult();
    assert.match(written.name, /\.rpaint$/);
    return summarize(decodeProject(written.bytes, desktopLimits));
}
async function exportRaster(format) {
    await page.getByRole('button', { name: '이미지 내보내기', exact: true }).click();
    await page.getByLabel('형식', { exact: true }).selectOption(format);
    await page.getByLabel('JPG/BMP 바탕색', { exact: true }).fill('#ffffff');
    await page.getByRole('dialog').getByRole('button', { name: '내보내기', exact: true }).click();
    return writeResult();
}
async function pngSnapshot() {
    const written = await exportRaster('png');
    const image = decodePng(written.bytes, desktopLimits);
    return {
        width: image.width,
        height: image.height,
        sha256: createHash('sha256').update(image.pixels).digest('hex'),
    };
}
async function openFile(target, name, bytes) {
    if (await target.evaluate(() => !!window.__myPaintPersistenceTest)) {
        await target.evaluate(
            ({ name, bytes }) => {
                const native = window.__myPaintPersistenceTest;
                native.queueOpen(name, Uint8Array.from(bytes));
                if (name === 'oversized-native.rpaint') native.readResponseSizes.set(name, 301 * 1048576);
            },
            { name, bytes: Array.from(bytes) },
        );
        await target.getByRole('button', { name: '파일 열기', exact: true }).click();
    } else {
        const chooser = target.waitForEvent('filechooser');
        await target.getByRole('button', { name: '파일 열기', exact: true }).click();
        await (
            await chooser
        ).setFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
    }
}
async function resize(width, height) {
    await menu(page, '이미지 크기');
    await page.getByLabel('너비', { exact: true }).fill(String(width));
    await page.getByLabel('높이', { exact: true }).fill(String(height));
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
}
function projectHeader(width, height, layers = 1) {
    const bytes = new Uint8Array(28),
        view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode('RPAINT01'));
    view.setUint32(8, width, true);
    view.setUint32(12, height, true);
    view.setUint32(16, layers, true);
    return bytes;
}
const fixtures = [];
try {
    await page.goto(url);
    await page.waitForSelector('canvas[data-ready=true]');
    await menu(page, '새 그림');
    assert.equal(await page.getByLabel('너비', { exact: true }).getAttribute('max'), '32768');
    await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
    result.checks.push(
        'Mocked native runtime selects desktop UI dimensions; mobile/native OS behavior is outside this test',
    );
    for (const [width, height] of [
        [4096, 4096],
        [32768, 1],
    ]) {
        const state = createState(width, height, [0, 0, 0, 0], desktopLimits);
        state.layers[0].pixels.set([7, 11, 213, 255], 0);
        const bytes = encodeProject(state, desktopLimits),
            expected = summarize(state);
        fixtures.push({ name: `native-${width}x${height}.rpaint`, bytes });
        await openFile(page, fixtures.at(-1).name, bytes);
        await page.waitForFunction(
            ({ width, height }) =>
                document.querySelector('.document-info')?.textContent.includes(`${width} × ${height}`),
            { width, height },
        );
        assert.deepEqual(await snapshot(), expected);
        await page.getByRole('button', { name: '화면에 맞추기', exact: true }).click();
        for (let step = 0; step < 32; step++) {
            if (Number.parseInt(await page.locator('#zoom').textContent(), 10) >= 100) break;
            await page.getByRole('button', { name: '확대', exact: true }).click();
        }
        const box = await page.locator('.workspace canvas').boundingBox(),
            center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await page.getByRole('button', { name: '연필', exact: true }).click();
        await page.mouse.move(center.x, center.y);
        await page.mouse.down();
        await page.mouse.move(center.x + 20, center.y, { steps: 5 });
        await page.mouse.up();
        const drawn = await snapshot();
        assert.notEqual(drawn.layers[0].sha256, expected.layers[0].sha256);
        await page.waitForFunction(() => {
            const canvas = document.querySelector('.workspace canvas'),
                pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            return pixels.some(
                (value, index) =>
                    index % 4 === 2 && value > pixels[index - 2] + 12 && value > pixels[index - 1] + 5,
            );
        });
        await page.getByRole('button', { name: '실행 취소', exact: true }).click();
        assert.deepEqual(await snapshot(), expected);
        await page.getByRole('button', { name: '다시 실행', exact: true }).click();
        assert.deepEqual(await snapshot(), drawn);
        const png = await pngSnapshot();
        assert.deepEqual(png, { width, height, sha256: drawn.layers[0].sha256 });
        result.checks.push(
            `${width}x${height}: real project input, visible pixel stroke, one Undo/Redo and PNG/RPAINT roundtrip`,
        );

        await page.getByRole('button', { name: height === 1 ? '직선' : '사각형', exact: true }).click();
        await page.mouse.move(center.x + 50, center.y + (height === 1 ? 0 : 25));
        await page.mouse.down();
        await page.mouse.move(center.x + 75, center.y + (height === 1 ? 0 : 45));
        await page.mouse.up();
        const shaped = await snapshot();
        assert.notEqual(shaped.layers[0].sha256, drawn.layers[0].sha256);
        await page.getByRole('button', { name: '실행 취소', exact: true }).click();
        assert.deepEqual(await snapshot(), drawn);
        result.checks.push(
            `${width}x${height}: bounded shape raster commits once and Undo restores the previous pixels`,
        );

        await menu(page, '전체 선택');
        await page.waitForFunction(
            () => document.querySelector('[data-tool=select]')?.getAttribute('aria-pressed') === 'true',
        );
        await page.locator('.workspace canvas').focus();
        await page.keyboard.press(width === 32768 ? 'ArrowLeft' : 'ArrowRight');
        const moved = await pngSnapshot();
        assert.equal(moved.width, width === 32768 ? width : width + 1);
        assert.equal(moved.height, height);
        await page.keyboard.press(width === 32768 ? 'ArrowRight' : 'ArrowLeft');
        assert.deepEqual(await pngSnapshot(), { width, height, sha256: drawn.layers[0].sha256 });
        await page.keyboard.press('Escape');
        assert.deepEqual(await snapshot(), drawn);
        result.checks.push(
            `${width}x${height}: full-size selection preview and return preserve original pixels without a full document canvas`,
        );

        await page.evaluate(() => {
            window.failNativeProfileGeometry = 'error';
        });
        await resize(width - 1, height);
        await page.getByRole('status').filter({ hasText: 'Injected geometry worker failure' }).waitFor();
        assert.deepEqual(await snapshot(), drawn);
        await page.evaluate(() => {
            window.failNativeProfileGeometry = 'hang';
            window.nativeProfileHangingGeometry = false;
        });
        await resize(width - 1, height);
        await page.waitForFunction(() => window.nativeProfileHangingGeometry);
        await page.locator('.busy').getByRole('button', { name: '취소', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.busy'));
        assert.deepEqual(await snapshot(), drawn);
        result.checks.push(
            `${width}x${height}: geometry Worker failure and cancellation preserve the document and release work`,
        );
        await resize(width - 1, height);
        const resized = await snapshot();
        assert.equal(resized.width, width - 1);
        assert.equal(resized.height, height);
        await page.getByRole('button', { name: '실행 취소', exact: true }).click();
        assert.deepEqual(await snapshot(), drawn);
        result.checks.push(
            `${width}x${height}: actual geometry Worker resize supports desktop dimensions with atomic Undo`,
        );
        const jpeg = await exportRaster('jpg');
        assert.match(jpeg.name, /\.jpg$/);
        assert.deepEqual([...jpeg.bytes.subarray(0, 2)], [255, 216]);
        assert.deepEqual([...jpeg.bytes.subarray(-2)], [255, 217]);
        const jpegName = `native-photo-${width}.jpg`;
        await openFile(page, jpegName, jpeg.bytes);
        await page.waitForFunction(
            (name) => document.querySelector('.title')?.textContent.includes(name),
            jpegName,
        );
        const importedJpeg = await snapshot();
        assert.equal(importedJpeg.width, width);
        assert.equal(importedJpeg.height, height);
        assert.equal(importedJpeg.layers[0].name, '이미지');
        assert.deepEqual(importedJpeg.background, [255, 255, 255, 255]);
        assert.deepEqual(importedJpeg.layers[0].samples[2], [255, 255, 255, 255]);
        assert(importedJpeg.layers[0].samples.every((sample) => sample[3] === 255));
        result.checks.push(
            `${width}x${height}: actual JPEG Worker output reopens through tiled bitmap input with an opaque white matte`,
        );
        if (width === 32768) {
            const bmp = await exportRaster('bmp');
            assert.match(bmp.name, /\.bmp$/);
            assert.deepEqual([...bmp.bytes.subarray(0, 2)], [66, 77]);
            assert.equal(new DataView(bmp.bytes.buffer).getInt32(18, true), width);
            await openFile(page, 'native-wide.bmp', bmp.bytes);
            await page.waitForFunction(() =>
                document.querySelector('.title')?.textContent.includes('native-wide.bmp'),
            );
            assert.deepEqual(await snapshot(), importedJpeg);
            result.checks.push(
                '32768x1: actual BMP Worker output and tiled bitmap input preserve every opaque RGBA byte',
            );
        }
    }
    const beforeInvalid = await snapshot();
    await page.evaluate(() => {
        window.observeNativeProfileAllocations = true;
    });
    await menu(page, '새 그림');
    await page.getByLabel('너비', { exact: true }).fill('8192');
    await page.getByLabel('높이', { exact: true }).fill('8192');
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
    await page.getByRole('status').filter({ hasText: /한도/ }).waitFor();
    assert.deepEqual(await snapshot(), beforeInvalid);
    assert.deepEqual(await page.evaluate(() => window.nativeProfileHugeAllocations), []);
    result.checks.push(
        'Over-limit desktop new-document dimensions are rejected before an oversized pixel allocation',
    );
    for (const [name, bytes] of [
        ['over-total.rpaint', projectHeader(8192, 4096, 3)],
        ['over-layer.rpaint', projectHeader(8192, 4097)],
        ['oversized-native.rpaint', projectHeader(1, 1)],
    ]) {
        const jobCount = await page.evaluate(() => window.nativeProfileJobs.length);
        await openFile(page, name, bytes);
        await page
            .getByRole('status')
            .filter({ hasText: /한도|MiB|크기/ })
            .waitFor();
        if (name === 'oversized-native.rpaint')
            assert.equal(await page.evaluate(() => window.nativeProfileJobs.length), jobCount);
        assert.deepEqual(await snapshot(), beforeInvalid);
    }
    result.checks.push(
        'Desktop aggregate/pixel headers and oversized native binary IPC data are rejected before artwork parsing without replacing the document',
    );
    const nativeEvidence = await page.evaluate(() => ({
        jobs: window.nativeProfileJobs,
        surfaces: window.nativeProfileSurfaces,
        workers: window.nativeProfileLiveWorkers.size,
    }));
    assert(nativeEvidence.jobs.length > 0);
    assert(nativeEvidence.jobs.every((job) => job.profileId === 'desktop'));
    assert.equal(nativeEvidence.workers, 0);
    assert(
        nativeEvidence.surfaces.every(
            (surface) =>
                surface.width <= 2048 &&
                surface.height <= 2048 &&
                surface.width * surface.height <= 4 * 1024 * 1024,
        ),
    );
    result.nativeEvidence = nativeEvidence;
    await native.close();

    const web = await browser.newContext({ viewport: { width: 1400, height: 1000 } }),
        webPage = await web.newPage();
    webPage.setDefaultTimeout(45000);
    webPage.on('pageerror', (error) => result.errors.push(error.message));
    await webPage.addInitScript(() => {
        window.webProfileBlobs = [];
        const create = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => {
            window.webProfileBlobs.push(blob);
            return create(blob);
        };
    });
    await webPage.goto(url);
    await webPage.waitForSelector('canvas[data-ready=true]');
    assert.equal(await webPage.evaluate(() => !!window.__TAURI__), false);
    await menu(webPage, '새 그림');
    assert.equal(await webPage.getByLabel('너비', { exact: true }).getAttribute('max'), '4096');
    await webPage.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
    for (const fixture of fixtures) {
        await openFile(webPage, fixture.name, fixture.bytes);
        await webPage.getByRole('status').filter({ hasText: /한도/ }).waitFor();
        await webPage.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
        await webPage.getByRole('button', { name: '파일 받기', exact: true }).waitFor();
        const saved = await webPage.evaluate(async () =>
            Array.from(new Uint8Array(await window.webProfileBlobs.at(-1).arrayBuffer())),
        );
        const state = decodeProject(Uint8Array.from(saved));
        assert.equal(state.width, 800);
        assert.equal(state.height, 600);
        assert(state.layers[0].pixels.every((value) => value === 255));
        await webPage.getByRole('button', { name: '다운로드 닫기', exact: true }).click();
    }
    await web.close();
    result.checks.push(
        'An ordinary browser retains web limits and rejects both desktop fixtures while preserving its initial document',
    );
    assert.deepEqual(result.errors, []);
} catch (error) {
    result.failure = String(error.stack || error);
    result.lastNativeStatus = await page
        .locator('.status')
        .textContent()
        .catch(() => undefined);
    throw error;
} finally {
    await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
    await browser.close();
}
console.log(
    JSON.stringify(
        {
            ...result,
            nativeEvidence: result.nativeEvidence
                ? {
                      jobs: result.nativeEvidence.jobs.length,
                      surfaces: result.nativeEvidence.surfaces.length,
                      workers: result.nativeEvidence.workers,
                  }
                : undefined,
        },
        null,
        2,
    ),
);
