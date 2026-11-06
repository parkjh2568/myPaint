import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(
        process.env.PAINT_RENDER_PREPARATION_OUTPUT ||
            '../build-web-work/task-planning/render-preparation/result.json',
    ),
    out = path.dirname(output),
    hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex'),
    url = process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/';
await fs.mkdir(out, { recursive: true });
const results = {
    url,
    scope: 'Current application bundle served by PAINT_TEST_URL; this test does not build or select a historical reference. Eight public Chromium UI contracts at DPR1 and viewport1000x800 (main backing672x709 with fractional paper edges). Actual codec workers; native-harness models IPC, not OS dialogs/filesystem. The test fixes only the main Canvas context willReadFrequently:false before app initialization to avoid unspecified-readback policy transitions. MessagePort delivery is held only for ordering. Synthetic context events and one injected allocation exception are not real GPU/memory exhaustion or performance evidence. No private Studio/doc hooks.',
    checks: [],
    cases: [],
    errors: [],
    warnings: [],
    failures: [],
    assets: [],
    testSHA256: hash(await fs.readFile(new URL(import.meta.url))),
};
const large = createState(2048, 2048, [37, 83, 137, 255], desktopLimits);
const top = new Uint8ClampedArray(2048 * 2048 * 4);
const topWords = new Uint32Array(top.buffer);
const tint = new Uint32Array(Uint8Array.from([147, 39, 91, 128]).buffer)[0];
for (let y = 0; y < 2048; y++)
    for (let x = 0; x < 2048; x += 64)
        if ((Math.floor(y / 64) + Math.floor(x / 64)) % 2)
            topWords.fill(tint, y * 2048 + x, y * 2048 + x + 64);
top.set([193, 71, 117, 0], (20 * 2048 + 28) * 4);
large.layers.push({ name: 'transparent checker', visible: true, pixels: top });
large.active = 1;
const tiny = createState(64, 64, [71, 151, 43, 255], desktopLimits);
tiny.layers[0].pixels.set([193, 71, 117, 0], (20 * 64 + 28) * 4);
const fixtures = {
    large: { state: large, bytes: encodeProject(large, desktopLimits), name: 'A-large.rpaint' },
    tiny: { state: tiny, bytes: encodeProject(tiny, desktopLimits), name: 'B-tiny.rpaint' },
};
results.fixtures = Object.fromEntries(
    Object.entries(fixtures).map(([key, f]) => [
        key,
        {
            width: f.state.width,
            height: f.state.height,
            layers: f.state.layers.length,
            authoritativeBytes: f.state.layers.reduce((sum, l) => sum + l.pixels.byteLength, 0),
            encodedBytes: f.bytes.length,
            encodedSHA256: hash(f.bytes),
            layerSHA256: f.state.layers.map((l) => hash(l.pixels)),
        },
    ]),
);
function installGate() {
    const Original = window.MessageChannel,
        image = window.ImageData,
        get = HTMLCanvasElement.prototype.getContext;
    const probe = (window.__renderPreparationTest = {
        held: false,
        queue: [],
        posted: 0,
        replayed: 0,
        closed: 0,
        livePorts: 0,
        offscreenPuts: 0,
        failImageData: false,
        injectedAllocations: 0,
        events: [],
        wheels: [],
    });
    HTMLCanvasElement.prototype.getContext = function (type, options, ...rest) {
        if (type !== '2d' || !this.matches('.workspace canvas'))
            return get.call(this, type, options, ...rest);
        const context = get.call(this, type, { ...options, willReadFrequently: false }, ...rest);
        probe.contextAttributes = context?.getContextAttributes?.();
        return context;
    };
    window.ImageData = new Proxy(image, {
        construct(Type, args) {
            if (probe.failImageData) {
                probe.failImageData = false;
                probe.injectedAllocations++;
                throw Error('Injected source preparation ImageData allocation failure');
            }
            return Reflect.construct(Type, args);
        },
    });
    if (window.OffscreenCanvasRenderingContext2D) {
        const put = OffscreenCanvasRenderingContext2D.prototype.putImageData;
        OffscreenCanvasRenderingContext2D.prototype.putImageData = function (...args) {
            probe.offscreenPuts++;
            return put.apply(this, args);
        };
    }
    window.MessageChannel = new Proxy(Original, {
        construct(Type, args) {
            const channel = Reflect.construct(Type, args);
            const send = channel.port2.postMessage.bind(channel.port2);
            probe.livePorts += 2;
            channel.port2.postMessage = (...args) => {
                probe.posted++;
                if (probe.held)
                    probe.queue.push(() => {
                        probe.replayed++;
                        send(...args);
                    });
                else send(...args);
            };
            for (const port of [channel.port1, channel.port2]) {
                const close = port.close.bind(port);
                let closed = false;
                port.close = () => {
                    if (!closed) {
                        closed = true;
                        probe.closed++;
                        probe.livePorts--;
                    }
                    return close();
                };
            }
            return channel;
        },
    });
    probe.release = () => {
        probe.held = false;
        const queue = probe.queue.splice(0);
        for (const send of queue) send();
        return queue.length;
    };
    document.addEventListener('DOMContentLoaded', () => {
        const canvas = document.querySelector('.workspace canvas');
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'])
            canvas.addEventListener(
                type,
                (e) =>
                    probe.events.push({
                        type,
                        ready: canvas.dataset.ready,
                        busy: canvas.getAttribute('aria-busy'),
                        x: e.clientX,
                        y: e.clientY,
                        buttons: e.buttons,
                    }),
                { passive: true },
            );
        canvas.addEventListener('wheel', (e) => probe.wheels.push({ deltaX: e.deltaX, deltaY: e.deltaY }), {
            passive: true,
        });
        new MutationObserver(() =>
            probe.events.push({
                ready: canvas.dataset.ready,
                busy: canvas.getAttribute('aria-busy'),
                generation: window.__myPaintPersistenceTest.generation,
            }),
        ).observe(canvas, { attributes: true, attributeFilter: ['data-ready', 'aria-busy'] });
    });
}
let browser;
const live = new Set();
async function boot(name) {
    const context = await browser.newContext({
        viewport: { width: 1000, height: 800 },
        deviceScaleFactor: 1,
    });
    live.add(context);
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', (e) => results.errors.push({ name, message: e.message }));
    page.on('console', (message) => {
        if (message.type() === 'warning') results.warnings.push({ name, text: message.text() });
    });
    page.on('request', (r) => {
        if (/\.(js|css)(?:$|\?)/.test(r.url()) && !results.assets.includes(r.url()))
            results.assets.push(r.url());
    });
    await page.addInitScript(installNativeHarness, {});
    await page.addInitScript(installGate);
    await page.goto(url);
    await page.waitForFunction(
        () => window.__myPaintPersistenceTest?.generation === 1 && !document.querySelector('dialog[open]'),
    );
    await ready(page, 1);
    // Drain the delayed startup recovery lookup before any failure/race is armed.
    await page.waitForTimeout(750);
    await ready(page, 1);
    assert.equal(
        await page.evaluate(() => window.__renderPreparationTest.contextAttributes.willReadFrequently),
        false,
    );
    return { name, context, page };
}
async function ready(page, generation) {
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.waitForFunction((generation) => {
        const canvas = document.querySelector('.workspace canvas');
        return (
            window.__myPaintPersistenceTest.generation === generation &&
            canvas.dataset.ready === 'true' &&
            !canvas.hasAttribute('aria-busy') &&
            !document.querySelector('.busy')
        );
    }, generation);
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
}
async function open(t, key, generation, held = false) {
    const f = fixtures[key];
    await t.page.evaluate(
        ({ bytes, name, held }) => {
            window.__renderPreparationTest.held = held;
            window.__myPaintPersistenceTest.queueOpen(name, Uint8Array.from(bytes));
        },
        { bytes: Array.from(f.bytes), name: f.name, held },
    );
    await t.page.getByRole('button', { name: '파일 열기', exact: true }).click();
    await t.page.waitForFunction(
        (g) => window.__myPaintPersistenceTest.generation === g && !document.querySelector('.busy'),
        generation,
    );
    if (held) await gate(t.page);
    else await ready(t.page, generation);
}
async function gate(page) {
    await page.waitForFunction(() => {
        const c = document.querySelector('.workspace canvas'),
            p = window.__renderPreparationTest;
        return c.dataset.ready === 'false' && c.getAttribute('aria-busy') === 'true' && p.queue.length > 0;
    });
}
async function canvasHash(page) {
    return page.locator('.workspace canvas').evaluate(async (c) => {
        const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        const digest = await crypto.subtle.digest('SHA-256', pixels);
        return {
            width: c.width,
            height: c.height,
            sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''),
        };
    });
}
async function saved(t) {
    const count = await t.page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    await t.page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await t.page.waitForFunction(
        (n) => window.__myPaintPersistenceTest.writes.length > n && !document.querySelector('.busy'),
        count,
    );
    const bytes = Uint8Array.from(
        await t.page.evaluate(() => Array.from(window.__myPaintPersistenceTest.writes.at(-1).bytes)),
    );
    return decodeProject(bytes, desktopLimits);
}
function exact(actual, expected) {
    assert.deepEqual(
        { ...actual, layers: actual.layers.map(({ pixels, ...rest }) => rest) },
        { ...expected, layers: expected.layers.map(({ pixels, ...rest }) => rest) },
    );
    assert.deepEqual(
        actual.layers.map((l) => hash(l.pixels)),
        expected.layers.map((l) => hash(l.pixels)),
    );
}
async function controls(page) {
    return {
        dirty: (await page.title()).startsWith('* '),
        undo: await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(),
        redo: await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled(),
    };
}
async function record(t, data) {
    results.checks.push(t.name);
    results.cases.push({
        name: t.name,
        ...data,
        probe: await t.page.evaluate(() => {
            const p = window.__renderPreparationTest;
            return {
                posted: p.posted,
                replayed: p.replayed,
                closed: p.closed,
                livePorts: p.livePorts,
                offscreenPuts: p.offscreenPuts,
                injectedAllocations: p.injectedAllocations,
                queued: p.queue.length,
                contextAttributes: p.contextAttributes,
                events: p.events,
                wheels: p.wheels,
            };
        }),
    });
    await fs.writeFile(path.join(out, 'partial.json'), JSON.stringify(results, null, 2) + '\n');
    await t.context.close();
    live.delete(t.context);
}
try {
    browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PAINT_BROWSER_PATH || undefined,
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    results.browser = browser.version();
    {
        const t = await boot('synthetic-context-loss-remains-locked-through-wheel-and-tool-redraw');
        await open(t, 'tiny', 2);
        await t.page.locator('.workspace canvas').evaluate((c) => c.dispatchEvent(new Event('contextlost')));
        assert.equal(await t.page.locator('.workspace canvas').getAttribute('data-ready'), 'false');
        await t.page.locator('.workspace canvas').hover();
        await t.page.mouse.wheel(10, 12);
        await t.page.getByRole('button', { name: '연필', exact: true }).click();
        await t.page.evaluate(
            () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        assert.equal(await t.page.locator('.workspace canvas').getAttribute('data-ready'), 'false');
        await t.page
            .locator('.workspace canvas')
            .evaluate((c) => c.dispatchEvent(new Event('contextrestored')));
        await ready(t.page, 2);
        exact(await saved(t), tiny);
        assert.deepEqual(await controls(t.page), { dirty: false, undo: false, redo: false });
        await record(t, { sourceExact: true, syntheticOnly: true });
    }
    {
        const t = await boot('held-cold-preparation-preserves-backing-and-rejects-new-drawing');
        await open(t, 'tiny', 2);
        const previous = await canvasHash(t.page);
        await open(t, 'large', 3, true);
        assert.deepEqual(await canvasHash(t.page), previous, 'Cold preparation must retain old backing');
        const box = await t.page.locator('.workspace canvas').boundingBox();
        const x = box.x + box.width / 2,
            y = box.y + box.height / 2;
        await t.page.mouse.move(x, y);
        await t.page.mouse.down();
        await t.page.mouse.move(x + 20, y + 10);
        await t.page.mouse.up();
        assert.deepEqual(await controls(t.page), { dirty: false, undo: false, redo: false });
        await t.page.evaluate(() => window.__renderPreparationTest.release());
        await ready(t.page, 3);
        exact(await saved(t), large);
        assert.deepEqual(await controls(t.page), { dirty: false, undo: false, redo: false });
        await record(t, { preservedBacking: previous, sourceExact: true, newDrawingRejected: true });
    }
    {
        const t = await boot('tiny-document-supersedes-held-large-frame-and-late-delivery');
        await open(t, 'tiny', 2);
        const baseline = await canvasHash(t.page);
        await open(t, 'large', 3, true);
        // Keep A's actual MessagePort send withheld until B is fully published.
        await open(t, 'tiny', 4);
        const beforeLate = await canvasHash(t.page);
        assert.deepEqual(beforeLate, baseline);
        const replayed = await t.page.evaluate(() => window.__renderPreparationTest.release());
        assert(replayed > 0);
        await t.page.waitForTimeout(2000);
        await ready(t.page, 4);
        assert.deepEqual(await canvasHash(t.page), beforeLate);
        exact(await saved(t), tiny);
        assert.deepEqual(await controls(t.page), { dirty: false, undo: false, redo: false });
        await record(t, { baseline, replayedOldPosts: replayed, sourceExact: true, noLateFrame: true });
    }
    {
        const t = await boot('same-pixels-Undo-Redo-during-held-preparation-publishes-latest-frame');
        await open(t, 'large', 2);
        await t.page.getByRole('button', { name: '연필', exact: true }).click();
        await ready(t.page, 2);
        const box = await t.page.locator('.workspace canvas').boundingBox();
        await t.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await t.page.mouse.down();
        await t.page.mouse.move(box.x + box.width / 2 + 15, box.y + box.height / 2 + 3);
        await t.page.mouse.up();
        await ready(t.page, 2);
        const drawn = await saved(t),
            paintedCanvas = await canvasHash(t.page);
        assert.notEqual(hash(drawn.layers[1].pixels), hash(large.layers[1].pixels));
        await t.page.getByRole('button', { name: '실행 취소', exact: true }).click();
        await ready(t.page, 2);
        const originalCanvas = await canvasHash(t.page);
        assert.notEqual(originalCanvas.sha256, paintedCanvas.sha256);
        await t.page.getByRole('button', { name: '다시 실행', exact: true }).click();
        await ready(t.page, 2);
        assert.deepEqual(await canvasHash(t.page), paintedCanvas);
        await t.page.evaluate(() => {
            window.__renderPreparationTest.held = true;
            const c = document.querySelector('.workspace canvas');
            c.dispatchEvent(new Event('contextlost'));
            c.dispatchEvent(new Event('contextrestored'));
        });
        await gate(t.page);
        await t.page.getByRole('button', { name: '실행 취소', exact: true }).click();
        await gate(t.page);
        assert.deepEqual(await controls(t.page), { dirty: true, undo: false, redo: true });
        await t.page.getByRole('button', { name: '다시 실행', exact: true }).click();
        assert.deepEqual(await controls(t.page), { dirty: false, undo: true, redo: false });
        await t.page.evaluate(() => window.__renderPreparationTest.release());
        await ready(t.page, 2);
        assert.deepEqual(await canvasHash(t.page), paintedCanvas);
        exact(await saved(t), drawn);
        await t.page.getByRole('button', { name: '실행 취소', exact: true }).click();
        await ready(t.page, 2);
        assert.deepEqual(await canvasHash(t.page), originalCanvas);
        exact(await saved(t), large);
        await record(t, { paintedCanvas, originalCanvas, latestRedoExact: true, nextUndoExact: true });
    }
    {
        const t = await boot('warm-tool-and-skin-changes-reuse-source-and-accept-first-real-stroke');
        await open(t, 'large', 2);
        const before = await t.page.evaluate(() => ({
            puts: window.__renderPreparationTest.offscreenPuts,
            events: window.__renderPreparationTest.events.length,
            posts: window.__renderPreparationTest.posted,
        }));
        for (const tool of ['지우개', '브러시', '연필']) {
            await t.page.getByRole('button', { name: tool, exact: true }).click();
            await ready(t.page, 2);
        }
        await t.page.getByRole('button', { name: '환경설정', exact: true }).click();
        await t.page.getByLabel('스킨', { exact: true }).selectOption('Classic 98');
        await t.page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
        await ready(t.page, 2);
        assert.equal(await t.page.evaluate(() => document.documentElement.dataset.skin), 'classic');
        const after = await t.page.evaluate(
            (index) => ({
                puts: window.__renderPreparationTest.offscreenPuts,
                posts: window.__renderPreparationTest.posted,
                cold: window.__renderPreparationTest.events.slice(index).filter((e) => e.busy === 'true')
                    .length,
            }),
            before.events,
        );
        assert.equal(after.puts, before.puts, 'Warm tool/skin changes must not upload source ImageData');
        assert.equal(
            after.posts,
            before.posts,
            'Warm changes must not create another preparation continuation',
        );
        assert.equal(after.cold, 0);
        const box = await t.page.locator('.workspace canvas').boundingBox();
        await t.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await ready(t.page, 2);
        assert.deepEqual(await controls(t.page), { dirty: true, undo: true, redo: false });
        const expected = {
            ...large,
            layers: large.layers.map((l, i) => (i === 1 ? { ...l, pixels: l.pixels.slice() } : l)),
        };
        expected.layers[1].pixels.set([22, 121, 234, 255], (1024 * 2048 + 1024) * 4);
        exact(await saved(t), expected);
        await t.page.getByRole('button', { name: '실행 취소', exact: true }).click();
        await ready(t.page, 2);
        exact(await saved(t), large);
        assert.equal(await t.page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(), false);
        await record(t, { before, after, firstStrokeExact: true, singleUndoExact: true });
    }
    {
        const t = await boot('injected-preparation-allocation-failure-preserves-frame-history-and-retries');
        await open(t, 'large', 2);
        await t.page.getByRole('button', { name: '연필', exact: true }).click();
        await ready(t.page, 2);
        const box = await t.page.locator('.workspace canvas').boundingBox();
        await t.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await ready(t.page, 2);
        assert.equal(await t.page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled(), true);
        await t.page.getByRole('button', { name: '실행 취소', exact: true }).click();
        await ready(t.page, 2);
        const sourceControls = await controls(t.page),
            backing = await canvasHash(t.page);
        assert.deepEqual(sourceControls, { dirty: false, undo: false, redo: true });
        await t.page.evaluate(() => {
            window.__renderPreparationTest.held = true;
            const canvas = document.querySelector('.workspace canvas');
            canvas.dispatchEvent(new Event('contextlost'));
            canvas.dispatchEvent(new Event('contextrestored'));
        });
        await gate(t.page);
        assert.deepEqual(await canvasHash(t.page), backing);
        const activePorts = await t.page.evaluate(() => window.__renderPreparationTest.livePorts);
        assert.equal(activePorts, 2, 'A real paused preparation channel must exist before injection');
        await t.page.evaluate(() => {
            window.__renderPreparationTest.failImageData = true;
            window.__renderPreparationTest.release();
        });
        await t.page.waitForFunction(() =>
            document
                .querySelector('.status')
                ?.textContent.includes('Injected source preparation ImageData allocation failure'),
        );
        const failure = await t.page.evaluate(() => ({
            injected: window.__renderPreparationTest.injectedAllocations,
            livePorts: window.__renderPreparationTest.livePorts,
            ready: document.querySelector('.workspace canvas').dataset.ready,
            busy: document.querySelector('.workspace canvas').getAttribute('aria-busy'),
        }));
        assert.deepEqual(failure, { injected: 1, livePorts: 0, ready: 'false', busy: null });
        assert.deepEqual(
            await canvasHash(t.page),
            backing,
            'Preparation failed before painting: preserve the complete backing',
        );
        assert.deepEqual(await controls(t.page), sourceControls);
        await t.page.evaluate(
            () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        assert.equal(
            await t.page.locator('.workspace canvas').getAttribute('data-ready'),
            'false',
            'No uncontrolled retry after failure',
        );
        await t.page.getByRole('button', { name: '화면에 맞추기', exact: true }).click();
        await ready(t.page, 2);
        assert.deepEqual(await canvasHash(t.page), backing);
        assert.deepEqual(await controls(t.page), sourceControls);
        exact(await saved(t), large);
        assert.deepEqual(await controls(t.page), sourceControls);
        assert.equal(await t.page.evaluate(() => window.__renderPreparationTest.livePorts), 0);
        await record(t, {
            injectedFailure: true,
            failure,
            backing,
            sourceExact: true,
            historyPreserved: true,
            retryExact: true,
        });
    }
    {
        const t = await boot('latest-zoom-and-pan-supersede-a-held-frame-with-exact-final-canvas');
        await open(t, 'large', 2);
        for (let i = 0; i < 2; i++) {
            await t.page.getByRole('button', { name: '확대', exact: true }).click();
            await ready(t.page, 2);
        }
        await t.page.locator('.workspace canvas').hover();
        let wheels = await t.page.evaluate(() => window.__renderPreparationTest.wheels.length);
        await t.page.mouse.wheel(37, 23);
        await t.page.waitForFunction((n) => window.__renderPreparationTest.wheels.length > n, wheels);
        await ready(t.page, 2);
        const baseline = await canvasHash(t.page),
            zoom = await t.page.locator('#zoom').textContent();
        exact(await saved(t), large);
        assert.equal(zoom, '49%');
        await open(t, 'tiny', 3);
        await open(t, 'large', 4, true);
        const initialQueued = await t.page.evaluate(() => window.__renderPreparationTest.queue.length);
        for (let i = 0; i < 2; i++) await t.page.getByRole('button', { name: '확대', exact: true }).click();
        await t.page.locator('.workspace canvas').hover();
        wheels = await t.page.evaluate(() => window.__renderPreparationTest.wheels.length);
        await t.page.mouse.wheel(37, 23);
        await t.page.waitForFunction((n) => window.__renderPreparationTest.wheels.length > n, wheels);
        await gate(t.page);
        assert.equal(await t.page.locator('#zoom').textContent(), zoom);
        assert.deepEqual(await controls(t.page), { dirty: false, undo: false, redo: false });
        const replayed = await t.page.evaluate(() => window.__renderPreparationTest.release());
        assert(replayed >= initialQueued && replayed > 0);
        await ready(t.page, 4);
        assert.deepEqual(
            await canvasHash(t.page),
            baseline,
            'Latest camera must match the same actions after a ready frame',
        );
        exact(await saved(t), large);
        assert.equal(await t.page.evaluate(() => window.__renderPreparationTest.livePorts), 0);
        await record(t, {
            baseline,
            zoom,
            replayedPosts: replayed,
            sourceExact: true,
            latestCameraExact: true,
        });
    }
    {
        const t = await boot('context-loss-during-preparation-closes-channel-and-restores-a-complete-frame');
        await open(t, 'large', 2);
        const baseline = await canvasHash(t.page),
            before = await controls(t.page);
        await t.page.evaluate(() => {
            window.__renderPreparationTest.held = true;
            const canvas = document.querySelector('.workspace canvas');
            canvas.dispatchEvent(new Event('contextlost'));
            canvas.dispatchEvent(new Event('contextrestored'));
        });
        await gate(t.page);
        assert.equal(await t.page.evaluate(() => window.__renderPreparationTest.livePorts), 2);
        // This loss occurs after a real preparation channel exists. The DOM status is outside Canvas.
        await t.page.locator('.workspace canvas').evaluate((c) => c.dispatchEvent(new Event('contextlost')));
        const lost = await t.page.evaluate(() => ({
            ready: document.querySelector('.workspace canvas').dataset.ready,
            livePorts: window.__renderPreparationTest.livePorts,
            status: document.querySelector('.status').textContent,
            statusRole: document.querySelector('.status').getAttribute('role'),
            statusLive: document.querySelector('.status').getAttribute('aria-live'),
        }));
        assert.equal(lost.ready, 'false');
        assert.equal(lost.livePorts, 0);
        assert.match(lost.status, /화면 연결이 중단/);
        assert.equal(lost.statusRole, 'status');
        assert.equal(lost.statusLive, 'polite');
        assert.deepEqual(await canvasHash(t.page), baseline);
        await t.page.getByRole('button', { name: '연필', exact: true }).click();
        const replayed = await t.page.evaluate(() => window.__renderPreparationTest.release());
        assert(replayed > 0);
        await t.page.evaluate(
            () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        assert.equal(await t.page.locator('.workspace canvas').getAttribute('data-ready'), 'false');
        assert.equal(await t.page.evaluate(() => window.__renderPreparationTest.livePorts), 0);
        assert.deepEqual(await controls(t.page), before);
        await t.page
            .locator('.workspace canvas')
            .evaluate((c) => c.dispatchEvent(new Event('contextrestored')));
        await ready(t.page, 2);
        assert.equal(await t.page.locator('.workspace canvas').getAttribute('aria-busy'), null);
        assert.doesNotMatch(await t.page.locator('.status').textContent(), /화면 연결이 중단/);
        assert.deepEqual(await canvasHash(t.page), baseline);
        exact(await saved(t), large);
        assert.deepEqual(await controls(t.page), before);
        assert.equal(await t.page.evaluate(() => window.__renderPreparationTest.livePorts), 0);
        await record(t, {
            baseline,
            lost,
            replayedCancelledPosts: replayed,
            sourceExact: true,
            syntheticOnly: true,
            restoredExact: true,
        });
    }
    assert.deepEqual(results.errors, []);
    const renderWarnings = results.warnings.filter((w) => w.text.startsWith('myPaint rendering failed'));
    assert.equal(renderWarnings.length, 1);
    assert.equal(
        renderWarnings[0].name,
        'injected-preparation-allocation-failure-preserves-frame-history-and-retries',
    );
} catch (error) {
    results.failures.push(String(error.stack || error));
    console.error(error);
    for (const context of live)
        for (const page of context.pages()) {
            try {
                results.failurePage = await page.evaluate(() => ({
                    url: location.href,
                    title: document.title,
                    info: document.querySelector('.document-info')?.textContent,
                    ready: document.querySelector('canvas')?.dataset.ready,
                    busy: document.querySelector('.workspace canvas')?.getAttribute('aria-busy'),
                    queued: window.__renderPreparationTest?.queue.length,
                    posted: window.__renderPreparationTest?.posted,
                    events: window.__renderPreparationTest?.events.slice(-30),
                    generation: window.__myPaintPersistenceTest?.generation,
                }));
                await page.screenshot({ path: path.join(out, 'failure.png') });
            } catch (error) {
                results.failureCaptureError = String(error);
            }
        }
    process.exitCode = 1;
} finally {
    for (const context of live) await context.close().catch(() => {});
    if (browser) await browser.close();
    results.ok = !results.failures.length && !results.errors.length && results.checks.length === 8;
    await fs.writeFile(output, JSON.stringify(results, null, 2) + '\n');
    console.log(
        JSON.stringify({
            output,
            checks: results.checks,
            errors: results.errors,
            failures: results.failures,
            ok: results.ok,
        }),
    );
}
