import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync, crc32 } from 'node:zlib';
import { createState, webLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright'),
    output = path.resolve(
        process.env.PAINT_CAMERA_VIEWPORT_OUTPUT ||
            '../build-web-work/task-planning/camera-viewport-contract/ui/results.json',
    ),
    out = path.dirname(output),
    hash = (bytes) => createHash('sha256').update(bytes).digest('hex'),
    filter = process.env.PAINT_CAMERA_CASE || '',
    result = {
        url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
        scope: 'Public normal-web Chromium DOM/Canvas/Workers and actual CDP input/page scale/browser panning. Controlled VisualViewport/media events are test-only API models, not physical keyboard/IME/device changes. Filechooser receives fixture bytes and application download Blobs are read back; no OS file dialogs, native persistence, private Studio hooks or performance acceptance. Released resize uses trusted down plus captured synthetic move/up with held original MessagePort delivery; no result edits.',
        filter,
        testSha256: hash(await fs.readFile(new URL(import.meta.url))),
        sourceSha256: {},
        assets: [],
        cases: [],
        checks: [],
        errors: [],
        failures: [],
    };
await fs.mkdir(out, { recursive: true });
for (const file of ['main.ts', 'style.css', 'engine/document.ts', 'engine/operations.ts'])
    result.sourceSha256[file] = hash(await fs.readFile(new URL('../src/' + file, import.meta.url)));
const original = createState(64, 64, [255, 255, 255, 255], webLimits);
original.layers[0].pixels.set([0, 0, 0, 0], 0);
for (let y = 32; y < 36; y++)
    for (let x = 32; x < 36; x++) original.layers[0].pixels.set([255, 0, 0, 255], (y * 64 + x) * 4);
function instrumentation(options) {
    const nativeVV = window.visualViewport,
        nativeMedia = window.matchMedia.bind(window),
        coarse = nativeMedia('(any-pointer: coarse)'),
        p = (window.cameraContract = {
            blobs: [],
            doc: options.doc,
            matrix: undefined,
            pointer: undefined,
            events: [],
            boxes: [],
            measure: false,
            slices: [],
            allocations: [],
            jobs: [],
            coarse: options.coarse ?? coarse.matches,
            vvOverride: undefined,
            armChannel: false,
            holdChannel: true,
            ports: [],
            held: [],
            closed: 0,
            holdFile: false,
            fileHeld: [],
        });
    const url = URL.createObjectURL;
    URL.createObjectURL = function (blob) {
        p.blobs.push(blob);
        return url.call(this, blob);
    };
    const mql = new EventTarget();
    Object.defineProperties(mql, { media: { value: coarse.media }, matches: { get: () => p.coarse } });
    window.matchMedia = (query) =>
        query.replace(/\s/g, '') === '(any-pointer:coarse)' ? mql : nativeMedia(query);
    p.setCoarse = (value) => {
        p.coarse = value;
        mql.dispatchEvent(new MediaQueryListEvent('change', { media: coarse.media, matches: value }));
    };
    const viewport = new EventTarget();
    for (const key of ['width', 'height', 'scale', 'offsetLeft', 'offsetTop', 'pageLeft', 'pageTop'])
        Object.defineProperty(viewport, key, {
            get: () => (p.vvOverride && key in p.vvOverride ? p.vvOverride[key] : nativeVV[key]),
        });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => viewport });
    for (const name of ['resize', 'scroll'])
        nativeVV.addEventListener(name, () => viewport.dispatchEvent(new Event(name)));
    p.setVV = (value, event = 'resize') => {
        p.vvOverride = value;
        viewport.dispatchEvent(new Event(event));
    };
    p.nativeVV = () => ({
        width: nativeVV.width,
        height: nativeVV.height,
        scale: nativeVV.scale,
        offsetLeft: nativeVV.offsetLeft,
        offsetTop: nativeVV.offsetTop,
    });
    const rect = CanvasRenderingContext2D.prototype.rect,
        strokeRect = CanvasRenderingContext2D.prototype.strokeRect;
    CanvasRenderingContext2D.prototype.rect = function (x, y, w, h) {
        if (
            this.canvas.matches?.('.workspace canvas') &&
            x === 0 &&
            y === 0 &&
            w === p.doc[0] &&
            h === p.doc[1]
        ) {
            const m = this.getTransform();
            p.matrix = [m.a, m.b, m.c, m.d, m.e, m.f];
        }
        return rect.call(this, x, y, w, h);
    };
    CanvasRenderingContext2D.prototype.strokeRect = function (x, y, w, h) {
        if (this.canvas.matches?.('.workspace canvas')) p.boxes.push({ x, y, width: w, height: h });
        return strokeRect.call(this, x, y, w, h);
    };
    for (const type of ['pointerdown', 'pointerup', 'wheel'])
        document.addEventListener(
            type,
            (event) => {
                if (type === 'pointerdown' && event.target.matches('.workspace canvas'))
                    p.pointer = event.pointerId;
                p.events.push({
                    type,
                    trusted: event.isTrusted,
                    target: event.target.tagName,
                    canvas: event.target.matches('.workspace canvas'),
                    client: [event.clientX, event.clientY],
                    ctrl: event.ctrlKey,
                    delta: [event.deltaX, event.deltaY],
                });
            },
            true,
        );
    for (const name of ['Uint8ClampedArray', 'Uint8Array']) {
        const Type = window[name],
            slice = Type.prototype.slice;
        window[name] = new Proxy(Type, {
            construct(target, args) {
                const value = Reflect.construct(target, args);
                if (p.measure && !(args[0] instanceof ArrayBuffer))
                    p.allocations.push({ kind: name, bytes: value.byteLength });
                return value;
            },
        });
        Type.prototype.slice = function (...args) {
            const value = slice.apply(this, args);
            if (p.measure) p.slices.push({ kind: name, bytes: value.byteLength, stack: new Error().stack });
            return value;
        };
    }
    const WorkerNative = window.Worker;
    window.Worker = class extends WorkerNative {
        postMessage(message, transfer) {
            if (p.measure) p.jobs.push(message.operation);
            return super.postMessage(message, transfer);
        }
    };
    const fileRead = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
        if (p.holdFile && this.name === 'camera-held.rpaint') {
            p.holdFile = false;
            return new Promise((resolve) => p.fileHeld.push(() => resolve(fileRead.call(this))));
        }
        return fileRead.call(this);
    };
    const Channel = window.MessageChannel,
        descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage'),
        close = MessagePort.prototype.close;
    window.MessageChannel = class extends Channel {
        constructor() {
            super();
            if (p.armChannel) {
                p.armChannel = false;
                p.ports.push(this.port1, this.port2);
            }
        }
    };
    Object.defineProperty(MessagePort.prototype, 'onmessage', {
        ...descriptor,
        set(handler) {
            return descriptor.set.call(
                this,
                typeof handler === 'function' && p.ports.includes(this)
                    ? function (event) {
                          if (p.holdChannel) p.held.push(() => handler.call(this, event));
                          else return handler.call(this, event);
                      }
                    : handler,
            );
        },
    });
    MessagePort.prototype.close = function () {
        if (p.ports.includes(this)) p.closed++;
        return close.call(this);
    };
}
async function command(page, name) {
    const button = page.getByRole('button', { name, exact: true });
    if (await button.isVisible()) await button.click();
    else {
        await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
    }
}
async function frames(page) {
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
}
async function world(page, x, y) {
    return page.locator('.workspace canvas').evaluate(
        (canvas, [x, y]) => {
            const r = canvas.getBoundingClientRect(),
                p = new DOMMatrix(window.cameraContract.matrix).transformPoint(new DOMPoint(x, y));
            return { x: r.x + (p.x * r.width) / canvas.width, y: r.y + (p.y * r.height) / canvas.height };
        },
        [x, y],
    );
}
async function camera(page) {
    return page.evaluate(() => ({
        matrix: window.cameraContract.matrix,
        zoom: document.querySelector('#zoom').textContent,
        density: document.documentElement.dataset.density,
    }));
}
async function wheel(page) {
    await page.mouse.wheel(8, 0);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await frames(page);
}
async function download(page, png = false) {
    const n = await page.evaluate(() => window.cameraContract.blobs.length);
    if (png) {
        await command(page, '이미지 내보내기');
        await page.waitForFunction(
            () => document.querySelector('.export-preview')?.dataset.state === 'ready',
        );
        await page.getByRole('dialog').getByRole('button', { name: '내보내기', exact: true }).click();
    } else await command(page, '프로젝트 저장 또는 다운로드');
    await page.getByRole('button', { name: '파일 받기', exact: true }).waitFor();
    assert(await page.evaluate((n) => window.cameraContract.blobs.length > n, n));
    const bytes = Uint8Array.from(
        await page.evaluate(async () =>
            Array.from(new Uint8Array(await window.cameraContract.blobs.at(-1).arrayBuffer())),
        ),
    );
    await page.getByRole('button', { name: '다운로드 닫기', exact: true }).click();
    return png ? bytes : decodeProject(bytes, webLimits);
}
async function selection(page) {
    await page.getByRole('button', { name: '사각 선택', exact: true }).click();
    assert.equal(
        await page.locator('#transparent-selection').isChecked(),
        false,
        'Fresh selection fixture requires the default opaque selection option',
    );
    const a = await world(page, 28.1, 28.1),
        b = await world(page, 39.9, 39.9);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y);
    await page.mouse.up();
    await page.keyboard.press('ArrowRight');
}
function shifted(shift) {
    const expected = original.layers[0].pixels.slice();
    for (let y = 32; y < 36; y++)
        for (let x = 32; x < 36; x++) expected.set([255, 255, 255, 255], (y * 64 + x) * 4);
    for (let y = 32; y < 36; y++)
        for (let x = 32 + shift; x < 36 + shift; x++) expected.set([255, 0, 0, 255], (y * 64 + x) * 4);
    return expected;
}
async function preferences(page, density) {
    await command(page, '환경설정');
    await page.getByRole('dialog').getByLabel('조작부 크기', { exact: true }).selectOption(density);
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
    await page.waitForFunction((d) => {
        const mode = d === '터치' ? 'touch' : d === '마우스' ? 'mouse' : 'auto',
            saved = JSON.parse(localStorage.getItem('mypaint.ui.v1') || '{}');
        return (
            !document.querySelector('dialog[open]') &&
            saved.density === mode &&
            document.documentElement.dataset.density ===
                (mode === 'auto' ? (matchMedia('(any-pointer:coarse)').matches ? 'touch' : 'mouse') : mode)
        );
    }, density);
}
async function bounds(page, selector) {
    return page.locator(selector).evaluate((element) => {
        const r = element.getBoundingClientRect();
        return {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
        };
    });
}
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
result.browser = browser.version();
const watchdog = setTimeout(() => {
    result.failures.push({ name: 'watchdog', error: '240s suite deadline' });
    void browser.close();
}, 240000);
async function run(name, options, work) {
    if (filter && !name.includes(filter)) return;
    const source = options.source || original,
        context = await browser.newContext({
            viewport: options.viewport || { width: 1280, height: 800 },
            deviceScaleFactor: 1,
            hasTouch: !!options.touch,
            isMobile: !!options.touch,
        }),
        record = { name };
    result.cases.push(record);
    try {
        await context.addInitScript(instrumentation, {
            doc: [source.width, source.height],
            coarse: options.coarse ?? null,
        });
        const page = await context.newPage(),
            cdp = await context.newCDPSession(page);
        page.setDefaultTimeout(15000);
        page.on('pageerror', (error) => result.errors.push(error.message));
        page.on('response', (response) => {
            if (response.status() >= 400) result.errors.push(response.status() + ' ' + response.url());
            if (/\.js(?:[?#]|$)/.test(response.url()) && !result.assets.includes(response.url()))
                result.assets.push(response.url());
        });
        await page.goto(result.url);
        await page.waitForSelector('.workspace canvas[data-ready=true]');
        await page.waitForTimeout(650);
        const bytes = encodeProject(source, webLimits),
            chooser = page.waitForEvent('filechooser');
        record.inputSha256 = hash(bytes);
        await command(page, '파일 열기');
        await (
            await chooser
        ).setFiles({
            name: 'camera.rpaint',
            mimeType: 'application/octet-stream',
            buffer: Buffer.from(bytes),
        });
        await page.waitForFunction(
            (width) =>
                document.querySelector('.document-info').textContent.includes(String(width)) &&
                !document.querySelector('.busy') &&
                document.querySelector('.workspace canvas').dataset.ready === 'true' &&
                window.cameraContract.matrix,
            source.width,
        );
        await frames(page);
        await page.locator('.workspace canvas').focus();
        await page.keyboard.press('n');
        const seed = await world(page, 10.5, 10.5);
        await page.mouse.click(seed.x, seed.y);
        await command(page, '실행 취소');
        assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
        await work({ page, cdp, record, source });
        record.ok = true;
        result.checks.push(name);
    } catch (error) {
        record.error = String(error.stack || error);
        result.failures.push({ name, error: record.error });
    } finally {
        await context.close();
        await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
    }
}
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
            assert(width > 0 && height > 0 && width <= 1024 && height <= 1024);
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

try {
    for (const tool of ['연필', '브러시', '스포이트', 'navigation'])
        await run(
            'live-wheel-ignored-' + tool,
            { touch: tool === 'navigation', coarse: false },
            async ({ page, cdp, record }) => {
                if (tool === 'navigation') {
                    const a = await world(page, 15, 15),
                        b = await world(page, 25, 25);
                    await cdp.send('Input.dispatchTouchEvent', {
                        type: 'touchStart',
                        touchPoints: [
                            { x: a.x, y: a.y, id: 1 },
                            { x: b.x, y: b.y, id: 2 },
                        ],
                    });
                    await page.evaluate(() => window.cameraContract.setCoarse(true));
                    assert.equal((await camera(page)).density, 'mouse', 'Navigation defers auto density');
                    record.before = await camera(page);
                    await wheel(page);
                    assert.deepEqual(await camera(page), record.before);
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                    await page.waitForFunction(() => document.documentElement.dataset.density === 'touch');
                    assert.deepEqual(await download(page), original);
                    assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
                    return;
                }
                await page.getByRole('button', { name: tool, exact: true }).click();
                if (tool === '브러시') {
                    for (const [id, value] of [
                        ['size', '1'],
                        ['opacity', '100'],
                        ['hardness', '100'],
                        ['stabilization', '0'],
                    ])
                        await page.locator('#' + id).evaluate((input, value) => {
                            input.value = value;
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                        }, value);
                    await page.locator('#pressure').uncheck();
                }
                const a = await world(page, 15.5, 15.5),
                    b = await world(page, 20.5, 15.5);
                await page.mouse.move(a.x, a.y);
                await page.mouse.down();
                if (tool !== '스포이트') await page.mouse.move(b.x, b.y);
                record.before = await camera(page);
                await wheel(page);
                assert.deepEqual(
                    await camera(page),
                    record.before,
                    'Live pointer keeps camera unchanged, without rolling back stroke',
                );
                await page.mouse.up();
                const actual = await download(page),
                    expected = {
                        ...original,
                        layers: original.layers.map((layer) => ({ ...layer, pixels: layer.pixels.slice() })),
                    };
                if (tool !== '스포이트')
                    for (let x = 15; x <= 20; x++)
                        expected.layers[0].pixels.set([22, 121, 234, 255], (15 * 64 + x) * 4);
                assert.deepEqual(actual, expected);
                record.redo = await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled();
                assert.equal(record.redo, tool === '스포이트');
                record.events = await page.evaluate(() =>
                    window.cameraContract.events.filter((event) => event.type === 'wheel'),
                );
                assert(record.events.length === 2 && record.events.every((e) => e.trusted));
            },
        );
    await run('held-selection-drag-wheel-ignored', {}, async ({ page, record }) => {
        await page.getByRole('button', { name: '사각 선택', exact: true }).click();
        const selectA = await world(page, 20.1, 20.1),
            selectB = await world(page, 43.9, 43.9);
        await page.mouse.move(selectA.x, selectA.y);
        await page.mouse.down();
        await page.mouse.move(selectB.x, selectB.y);
        await page.mouse.up();
        await page.keyboard.press('ArrowRight');
        const a = await world(page, 22.5, 21.5),
            b = await world(page, 25.5, 21.5);
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        await page.mouse.move(b.x, b.y);
        record.before = await camera(page);
        await wheel(page);
        assert.deepEqual(await camera(page), record.before);
        await page.mouse.up();
        const payload = await download(page, true);
        record.pngSha256 = hash(payload);
        await fs.writeFile(path.join(out, 'held-selection-payload.png'), payload);
        record.selectionBox = await page.evaluate(() => window.cameraContract.boxes.at(-1));
        assert.deepEqual(readPng(payload).pixels, shifted(4));
        await page.locator('.workspace canvas').focus();
        await page.keyboard.press('Escape');
        assert.deepEqual(await download(page), original);
        assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
    });
    await run('stationary-pending-wheel-allowed', {}, async ({ page, record }) => {
        await selection(page);
        const before = await download(page, true);
        assert.deepEqual(readPng(before).pixels, shifted(1));
        const at = await world(page, 20.5, 15.5);
        await page.mouse.move(at.x, at.y);
        record.before = await camera(page);
        await wheel(page);
        record.after = await camera(page);
        assert.notDeepEqual(record.after.matrix, record.before.matrix);
        assert.deepEqual(await download(page, true), before);
        await page.locator('.workspace canvas').focus();
        await page.keyboard.press('Escape');
        assert.deepEqual(await download(page), original);
        assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
    });
    await run('busy-and-modal-wheel-blocked', {}, async ({ page, record }) => {
        await page.evaluate(() => {
            window.cameraContract.holdFile = true;
        });
        const chooser = page.waitForEvent('filechooser');
        await command(page, '파일 열기');
        await (
            await chooser
        ).setFiles({
            name: 'camera-held.rpaint',
            mimeType: 'application/octet-stream',
            buffer: Buffer.from(encodeProject(original, webLimits)),
        });
        await page.waitForFunction(
            () => window.cameraContract.fileHeld.length === 1 && document.querySelector('.busy'),
        );
        record.busyBefore = await camera(page);
        await wheel(page);
        assert.deepEqual(await camera(page), record.busyBefore);
        await page.locator('.busy').getByRole('button', { name: '취소', exact: true }).click();
        await page.evaluate(() => window.cameraContract.fileHeld.splice(0).forEach((release) => release()));
        await page.waitForFunction(() => !document.querySelector('.busy'));
        assert.deepEqual(await download(page), original);
        await command(page, '이미지 내보내기');
        await page.waitForFunction(
            () => document.querySelector('.export-preview')?.dataset.state === 'ready',
        );
        record.modalBefore = await camera(page);
        await wheel(page);
        assert.deepEqual(await camera(page), record.modalBefore);
        await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
        assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
        record.route =
            'Actual busy overlay/native modal input routing; no synthetic event bypass of inert surfaces.';
    });
    await run('released-resize-wheel-and-density-flush', { coarse: false }, async ({ page, record }) => {
        await page.locator('.workspace canvas').focus();
        await page.keyboard.press('Control+a');
        await frames(page);
        const a = await world(page, 63.5, 63.5),
            b = await world(page, 512, 512);
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        await page.evaluate(
            ({ x, y }) => {
                const p = window.cameraContract,
                    c = document.querySelector('.workspace canvas');
                p.armChannel = true;
                c.dispatchEvent(
                    new PointerEvent('pointermove', {
                        pointerId: p.pointer,
                        pointerType: 'mouse',
                        button: -1,
                        buttons: 1,
                        clientX: x,
                        clientY: y,
                        bubbles: true,
                    }),
                );
            },
            { x: b.x, y: b.y },
        );
        await page.waitForFunction(() => window.cameraContract.held.length > 0);
        await page.evaluate(
            ({ x, y }) => {
                const p = window.cameraContract;
                document.querySelector('.workspace canvas').dispatchEvent(
                    new PointerEvent('pointerup', {
                        pointerId: p.pointer,
                        pointerType: 'mouse',
                        button: 0,
                        buttons: 0,
                        clientX: x,
                        clientY: y,
                        bubbles: true,
                    }),
                );
            },
            { x: b.x, y: b.y },
        );
        await page.mouse.up();
        await page.evaluate(() => window.cameraContract.setCoarse(true));
        assert.equal((await camera(page)).density, 'mouse');
        record.before = await camera(page);
        await wheel(page);
        record.after = await camera(page);
        assert.notDeepEqual(
            record.after.matrix,
            record.before.matrix,
            'Released resize allows viewer camera change',
        );
        await page.evaluate(() => {
            const p = window.cameraContract;
            p.holdChannel = false;
            p.held.splice(0).forEach((run) => run());
        });
        await page.waitForFunction(
            () =>
                document.querySelector('.resize-cancel').hidden &&
                document.documentElement.dataset.density === 'touch' &&
                window.cameraContract.boxes.some((box) => box.width === 512 && box.height === 512),
        );
        const png = readPng(await download(page, true));
        assert.deepEqual([png.width, png.height], [512, 512]);
        const expected = new Uint8ClampedArray(512 * 512 * 4);
        expected.fill(255);
        for (let y = 256; y < 288; y++)
            for (let x = 256; x < 288; x++) expected.set([255, 0, 0, 255], (y * 512 + x) * 4);
        assert.deepEqual(
            png.pixels,
            expected,
            'Real released nearest resize uses the unchanged original source',
        );
        record.closedPorts = await page.evaluate(() => window.cameraContract.closed);
        assert(record.closedPorts >= 2);
        await page.locator('.workspace canvas').focus();
        await page.keyboard.press('Escape');
        assert.deepEqual(await download(page), original);
        assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
    });
    await run(
        'controlled-visual-viewport-bounds-and-pending',
        { viewport: { width: 390, height: 844 }, touch: true },
        async ({ page, record }) => {
            await selection(page);
            const expected = await download(page, true);
            assert.deepEqual(readPng(expected).pixels, shifted(1));
            record.bounds = [];
            await command(page, '이미지 내보내기');
            await page.waitForFunction(
                () => document.querySelector('.export-preview')?.dataset.state === 'ready',
            );
            for (const top of [50, 100]) {
                await page.evaluate(
                    (top) =>
                        window.cameraContract.setVV(
                            { width: 390, height: 500, scale: 1, offsetLeft: 0, offsetTop: top },
                            top === 50 ? 'resize' : 'scroll',
                        ),
                    top,
                );
                await frames(page);
                const rect = await bounds(page, 'dialog[open]');
                record.bounds.push(rect);
                assert(rect.left >= 0 && rect.right <= 390 && rect.top >= top && rect.bottom <= top + 500);
            }
            const anchor = await bounds(page, 'dialog[open]');
            for (const sample of [
                { width: 130, height: 500 / 3, scale: 3, offsetLeft: 80, offsetTop: 120 },
                { width: 97.5, height: 125, scale: 4, offsetLeft: 0, offsetTop: 220 },
            ]) {
                await page.evaluate((value) => window.cameraContract.setVV(value, 'scroll'), sample);
                await frames(page);
                assert.deepEqual(
                    await bounds(page, 'dialog[open]'),
                    anchor,
                    'Unusable visual viewport freezes prior overlay bounds/anchor',
                );
                assert.equal(
                    await page.evaluate(() =>
                        document.documentElement.style.getPropertyValue('--panel-overscroll'),
                    ),
                    'auto',
                );
            }
            await page.evaluate(() =>
                window.cameraContract.setVV({
                    width: 390,
                    height: 500,
                    scale: 1,
                    offsetLeft: 0,
                    offsetTop: 100,
                }),
            );
            const beforeInvalid = await page.evaluate(() => document.documentElement.style.cssText);
            await page.evaluate(() =>
                window.cameraContract.setVV({
                    width: NaN,
                    height: 500,
                    scale: 1,
                    offsetLeft: 0,
                    offsetTop: 100,
                }),
            );
            await frames(page);
            assert.equal(
                await page.evaluate(() => document.documentElement.style.cssText),
                beforeInvalid,
                'Nonfinite viewport inputs are ignored',
            );
            await page.evaluate(() =>
                window.cameraContract.setVV({
                    width: 390,
                    height: 500,
                    scale: 1,
                    offsetLeft: 0,
                    offsetTop: 100,
                }),
            );
            await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
            await page.evaluate(() => window.cameraContract.setVV(null));
            await command(page, '색상과 브러시');
            for (const top of [50, 100]) {
                await page.evaluate(
                    (top) =>
                        window.cameraContract.setVV(
                            { width: 390, height: 500, scale: 1, offsetLeft: 0, offsetTop: top },
                            'scroll',
                        ),
                    top,
                );
                await frames(page);
                const rect = await bounds(page, '.inspector.open');
                record.bounds.push(rect);
                assert(rect.left >= 0 && rect.right <= 390 && rect.top >= top && rect.bottom <= top + 500);
            }
            await page.getByRole('button', { name: '패널 닫기', exact: true }).click();
            assert.deepEqual(await download(page, true), expected);
            await page.evaluate(() => window.cameraContract.setVV(null));
            await page.locator('.workspace canvas').focus();
            await page.keyboard.press('Escape');
            assert.deepEqual(await download(page), original);
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            record.scope =
                'Controlled API dimensions/offsets/invalid input and freeze; physical keyboard/panning is not modeled here.';
        },
    );
    await run(
        'controlled-offset300-editor-preservation',
        { viewport: { width: 390, height: 844 }, touch: true },
        async ({ page, record }) => {
            // T is a public shortcut for the secondary text tool on phone layouts.
            await page.locator('.workspace canvas').focus();
            await page.keyboard.press('t');
            const at = await world(page, 8.5, 8.5);
            await page.mouse.click(at.x, at.y);
            const editor = page.getByRole('textbox', { name: /문자 입력/ });
            await editor.fill(
                Array.from({ length: 40 }, (_, i) => 'line ' + i + ' abcdefghijklmnopqrstuvwxyz').join('\n'),
            );
            await editor.evaluate((e) => {
                e.setSelectionRange(60, 66);
                e.scrollTop = 48;
            });
            const before = await download(page, true);
            await editor.focus();
            record.before = await editor.evaluate((e) => ({
                value: e.value,
                width: e.clientWidth,
                height: e.clientHeight,
                start: e.selectionStart,
                end: e.selectionEnd,
                scrollTop: e.scrollTop,
                scrollLeft: e.scrollLeft,
            }));
            assert(record.before.scrollTop > 0);
            await page.evaluate(() =>
                window.cameraContract.setVV({
                    width: 390,
                    height: 500,
                    scale: 1,
                    offsetLeft: 0,
                    offsetTop: 300,
                }),
            );
            await frames(page);
            record.after = await editor.evaluate((e) => ({
                value: e.value,
                width: e.clientWidth,
                height: e.clientHeight,
                start: e.selectionStart,
                end: e.selectionEnd,
                scrollTop: e.scrollTop,
                scrollLeft: e.scrollLeft,
            }));
            assert.deepEqual(record.after, record.before);
            record.bounds = await bounds(page, '.text-editor');
            assert(
                record.bounds.top >= 300 &&
                    record.bounds.bottom <= 800 &&
                    record.bounds.left >= 0 &&
                    record.bounds.right <= 390,
                'Focused editor must fit the actual usable visual viewport at large offset',
            );
            assert.deepEqual(
                await download(page, true),
                before,
                'Offset anchoring changes the camera, not the document text raster',
            );
            await page.evaluate(() => window.cameraContract.setVV(null));
            await page.locator('.workspace canvas').focus();
            await page.keyboard.press('Escape');
            assert.deepEqual(await download(page), original);
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
        },
    );
    await run(
        'actual-cdp-page-pinch-and-footer-pan',
        { viewport: { width: 390, height: 844 }, touch: true },
        async ({ page, cdp, record }) => {
            const read = () =>
                page.evaluate(() => ({
                    visual: window.cameraContract.nativeVV(),
                    app: [
                        document.querySelector('#app').getBoundingClientRect().width,
                        document.querySelector('#app').getBoundingClientRect().height,
                    ],
                    origin: [
                        document.querySelector('#app').getBoundingClientRect().left,
                        document.querySelector('#app').getBoundingClientRect().top,
                    ],
                    height: document.documentElement.style.getPropertyValue('--app-height'),
                    zoom: document.querySelector('#zoom').textContent,
                }));
            record.before = await read();
            await command(page, '이미지 내보내기');
            await page.waitForFunction(
                () => document.querySelector('.export-preview')?.dataset.state === 'ready',
            );
            record.scales = [];
            for (const scale of [2, 3]) {
                await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: scale });
                await page.waitForFunction(
                    (scale) => Math.abs(window.cameraContract.nativeVV().scale - scale) < 0.001,
                    scale,
                );
                await frames(page);
                const sample = await read();
                record.scales.push(sample);
                assert.deepEqual(
                    sample.app,
                    record.before.app,
                    'Pure page pinch preserves layout/app height',
                );
                assert.equal(sample.height, record.before.height);
                assert.equal(sample.zoom, record.before.zoom);
            }
            const anchor = await bounds(page, 'dialog[open]');
            record.pans = [];
            for (let i = 0; i < 6; i++) {
                const target = await bounds(page, 'dialog[open] button[value=ok]'),
                    v = (await read()).visual,
                    cx = (target.left + target.right) / 2,
                    cy = (target.top + target.bottom) / 2;
                if (
                    target.left >= v.offsetLeft + 2 &&
                    target.right <= v.offsetLeft + v.width - 2 &&
                    target.top >= v.offsetTop + 2 &&
                    target.bottom <= v.offsetTop + v.height - 2
                )
                    break;
                const needX = target.left < v.offsetLeft + 2 || target.right > v.offsetLeft + v.width - 2,
                    dx = cx - v.offsetLeft - v.width * 0.5,
                    dy = cy - v.offsetTop - v.height * 0.5;
                await cdp.send('Input.synthesizeScrollGesture', {
                    x: needX ? v.width * (dx >= 0 ? 0.85 : 0.15) : v.width * 0.5,
                    y: needX ? v.height * 0.5 : v.height * (dy >= 0 ? 0.85 : 0.15),
                    xDistance: needX ? -Math.max(-v.width * 0.7, Math.min(v.width * 0.7, dx)) : 0,
                    yDistance: needX ? 0 : -Math.max(-v.height * 0.7, Math.min(v.height * 0.7, dy)),
                    speed: 800,
                    preventFling: true,
                    gestureSourceType: 'touch',
                });
                await frames(page);
                record.pans.push(await read());
                assert.deepEqual(
                    await bounds(page, 'dialog[open]'),
                    anchor,
                    'Narrow page pinch must not make overlay chase browser pan',
                );
            }
            const target = await bounds(page, 'dialog[open] button[value=ok]'),
                v = (await read()).visual,
                x = (target.left + target.right) / 2 - v.offsetLeft,
                y = (target.top + target.bottom) / 2 - v.offsetTop;
            record.footer = { target, visual: v, input: { x, y } };
            assert(
                record.pans.length > 0 && v.offsetLeft > 0,
                'Actual browser pan must expose the right footer',
            );
            assert(
                x >= 0 && x < v.width && y >= 0 && y < v.height,
                'Footer must be in actual3x visual viewport',
            );
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mousePressed',
                x,
                y,
                button: 'left',
                buttons: 1,
                clickCount: 1,
            });
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x,
                y,
                button: 'left',
                buttons: 0,
                clickCount: 1,
            });
            await page.getByRole('button', { name: '파일 받기', exact: true }).waitFor();
            await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
            await frames(page);
            const last = await read();
            record.scales.push(last);
            assert.deepEqual(last.app, record.before.app);
            assert.equal(last.height, record.before.height);
            assert.equal(last.zoom, record.before.zoom);
            const bytes = Uint8Array.from(
                await page.evaluate(async () =>
                    Array.from(new Uint8Array(await window.cameraContract.blobs.at(-1).arrayBuffer())),
                ),
            );
            assert.deepEqual(
                readPng(bytes).pixels,
                original.layers[0].pixels,
                'Actual exposed footer executes real PNG export',
            );
            await page.getByRole('button', { name: '다운로드 닫기', exact: true }).click();
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            await page.screenshot({ path: path.join(out, 'page-pinch-restored.png') });
        },
    );
    for (const mode of ['pencil-up', 'picker-up', 'brush-cancel', 'picker-cancel'])
        await run('auto-media-deferred-' + mode, { coarse: false }, async ({ page, record }) => {
            const tool = mode.startsWith('picker') ? '스포이트' : mode === 'brush-cancel' ? '브러시' : '연필';
            await page.getByRole('button', { name: tool, exact: true }).click();
            if (tool === '브러시') {
                await page.locator('#size').evaluate((input) => {
                    input.value = '1';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                });
            }
            const at = await world(page, 15.5, 15.5);
            await page.mouse.move(at.x, at.y);
            await page.mouse.down();
            await page.evaluate(() => window.cameraContract.setCoarse(true));
            assert.equal(
                (await camera(page)).density,
                'mouse',
                'Auto API change waits for live pointer terminal, including picker without drag',
            );
            if (mode.endsWith('cancel'))
                await page.locator('.workspace canvas').evaluate((canvas) =>
                    canvas.dispatchEvent(
                        new PointerEvent('pointercancel', {
                            pointerId: window.cameraContract.pointer,
                            pointerType: 'mouse',
                            bubbles: true,
                        }),
                    ),
                );
            await page.mouse.up();
            await page.waitForFunction(() => document.documentElement.dataset.density === 'touch');
            const actual = await download(page),
                expected = {
                    ...original,
                    layers: original.layers.map((layer) => ({ ...layer, pixels: layer.pixels.slice() })),
                };
            if (mode === 'pencil-up') expected.layers[0].pixels.set([22, 121, 234, 255], (15 * 64 + 15) * 4);
            assert.deepEqual(actual, expected);
            if (mode !== 'pencil-up')
                assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            record.density = (await camera(page)).density;
        });
    await run('manual-density-preference-survives-media-changes', { coarse: false }, async ({ page }) => {
        await preferences(page, '마우스');
        await page.evaluate(() => window.cameraContract.setCoarse(true));
        assert.equal((await camera(page)).density, 'mouse');
        await preferences(page, '터치');
        await page.evaluate(() => window.cameraContract.setCoarse(false));
        assert.equal((await camera(page)).density, 'touch');
        assert.deepEqual(await download(page), original);
        assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
    });
    const large = createState(1024, 1024, [255, 255, 255, 255], webLimits),
        top = new Uint8ClampedArray(1024 * 1024 * 4);
    new Uint32Array(top.buffer).fill(new Uint32Array(Uint8Array.from([0, 0, 255, 128]).buffer)[0]);
    large.layers.push({ name: 'top half-blue', visible: true, pixels: top });
    await run(
        'unmodified-selection-noop-tool-click-zero-slices',
        { source: large },
        async ({ page, record, source }) => {
            await page.locator('.workspace canvas').focus();
            await page.keyboard.press('Control+a');
            await frames(page);
            assert(
                await page.evaluate(() =>
                    window.cameraContract.boxes.some((box) => box.width === 1024 && box.height === 1024),
                ),
                'Actually observe selected full-size outline',
            );
            await page.evaluate(() => {
                const p = window.cameraContract;
                p.boxes = [];
                p.slices = [];
                p.allocations = [];
                p.jobs = [];
                p.measure = true;
            });
            await page.getByRole('button', { name: '연필', exact: true }).click();
            record.ledger = await page.evaluate(() => {
                const p = window.cameraContract;
                p.measure = false;
                return { slices: p.slices, allocations: p.allocations, jobs: p.jobs };
            });
            assert.deepEqual(
                record.ledger.slices,
                [],
                'Synchronous unmodified-selection settle must not clone pixel planes',
            );
            assert(
                record.ledger.allocations.every((value) => value.bytes < 1024 * 1024 * 4),
                'No new full-plane constructor copy',
            );
            assert.deepEqual(record.ledger.jobs, []);
            await frames(page);
            assert.equal(
                await page.evaluate(() => window.cameraContract.boxes.length),
                0,
                'Tool click actually releases unmodified selection',
            );
            assert.deepEqual(await download(page), source);
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            assert(!(await page.title()).startsWith('* '));
            record.scope =
                'Public1024x1024 two-layer whole raw preservation and typed-slice/constructor/Worker ledger over tool-click wall interval only; not timing, RSS or all browser allocations.';
        },
    );
} finally {
    clearTimeout(watchdog);
    await browser.close();
    result.ok =
        result.cases.length > 0 &&
        (Boolean(filter) || result.cases.length === 17) &&
        result.cases.every((c) => c.ok) &&
        !result.errors.length &&
        !result.failures.length;
    await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ output, ok: result.ok, checks: result.checks, failures: result.failures }));
    if (!result.ok) process.exitCode = 1;
}
