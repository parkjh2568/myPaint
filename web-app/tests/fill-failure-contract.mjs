import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject } from '../src/engine/format.ts';
import { installNativeHarness } from './native-harness.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(
    process.env.PAINT_FILL_FAILURE_OUTPUT || '../build-web-work/task-planning/fill-failure/results.json',
);
await fs.mkdir(path.dirname(output), { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const result = {
    url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
    scope: 'Public Chromium fill UI with real codec Worker and modeled native file IPC. Faults intercept Worker constructor/postMessage/message/error boundaries. Each page receives two faults before a real fill retry; timeout uses the unchanged production20s timer twice. Detached prior cancel is replayed during the next held task. No private Studio hooks, OS errors or physical input claim.',
    testSha256: hash(await fs.readFile(new URL(import.meta.url))),
    checks: [],
    cases: [],
    errors: [],
    failures: [],
};
function faults() {
    const Original = window.Worker;
    window.fillFault = {
        mode: 'normal',
        held: [],
        injected: 0,
        created: 0,
        terminated: 0,
        productionTimeouts: [],
        oldCancel: undefined,
    };
    const append = Element.prototype.append;
    Element.prototype.append = function (...nodes) {
        if (
            window.fillFault.mode === 'setup' &&
            nodes.some((node) => node instanceof HTMLElement && node.classList.contains('busy'))
        ) {
            window.fillFault.mode = 'normal';
            window.fillFault.injected++;
            throw Error('Injected fill setup append failure');
        }
        return append.apply(this, nodes);
    };
    const schedule = window.setTimeout;
    window.setTimeout = function (handler, delay, ...args) {
        if (delay === 20000 && window.fillFault.mode === 'timeout' && typeof handler === 'function') {
            const sample = { delay, scheduledAt: performance.now() };
            window.fillFault.productionTimeouts.push(sample);
            return schedule.call(
                window,
                function (...callbackArgs) {
                    sample.firedAt = performance.now();
                    return handler.apply(this, callbackArgs);
                },
                delay,
                ...args,
            );
        }
        return schedule.call(window, handler, delay, ...args);
    };
    window.Worker = class extends Original {
        constructor(...args) {
            if (window.fillFault.mode === 'construct') {
                window.fillFault.mode = 'normal';
                window.fillFault.injected++;
                throw Error('Injected fill constructor failure');
            }
            super(...args);
            window.fillFault.created++;
        }
        postMessage(message, transfer) {
            if (message.operation === 'fill') {
                this.fault = window.fillFault.mode;
                window.fillFault.mode = 'normal';
                if (this.fault !== 'normal') window.fillFault.injected++;
                if (this.fault === 'post') throw Error('Injected fill post failure');
            }
            return super.postMessage(message, transfer);
        }
        set onmessage(handler) {
            super.onmessage = (event) => {
                if (this.fault === 'hold' || this.fault === 'timeout') {
                    window.fillFault.held.push(() => handler.call(this, event));
                    return;
                }
                if (this.fault === 'error-event') {
                    this.dispatchEvent(
                        new ErrorEvent('error', {
                            message: 'Injected fill worker failure',
                            cancelable: true,
                        }),
                    );
                    return;
                }
                let data = event.data;
                if (this.fault === 'error-response')
                    data = { profileId: 'desktop', error: 'Injected fill response failure' };
                if (this.fault === 'profile') data = { ...data, profileId: 'wrong-profile' };
                if (this.fault === 'pixels')
                    data = { ...data, image: { ...data.image, pixels: new Uint8ClampedArray(3) } };
                if (this.fault === 'coordinates') data = { ...data, image: { ...data.image, left: NaN } };
                handler.call(this, { data });
            };
        }
        terminate() {
            window.fillFault.terminated++;
            return super.terminate();
        }
    };
}
async function save(page) {
    const n = await page.evaluate(() => window.__myPaintPersistenceTest.writes.length);
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.waitForFunction(
        (n) => window.__myPaintPersistenceTest.writes.length > n && !document.querySelector('.busy'),
        n,
    );
    return decodeProject(
        Uint8Array.from(await page.evaluate(() => [...window.__myPaintPersistenceTest.writes.at(-1).bytes])),
        desktopLimits,
    );
}
const modes =
    process.env.PAINT_FILL_FAILURE_SETUP_ONLY === '1'
        ? ['setup']
        : [
              'setup',
              'construct',
              'post',
              'error-event',
              'error-response',
              'profile',
              'pixels',
              'coordinates',
              'hold',
              'timeout',
          ];
result.execution = {
    modes,
    failedAttemptsPerPage: 2,
    productionTimeoutMs: 20000,
    lateDetachedCancelReplay: true,
};
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
result.browser = browser.version();
try {
    for (const mode of modes) {
        const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } }),
            page = await context.newPage(),
            record = { mode };
        result.cases.push(record);
        page.setDefaultTimeout(30000);
        page.on('pageerror', (error) => result.errors.push(error.message));
        try {
            const state = createState(64, 64, [0, 0, 0, 0], desktopLimits);
            state.layers.push({
                name: 'fill target',
                visible: false,
                pixels: new Uint8ClampedArray(64 * 64 * 4),
            });
            state.active = 1;
            for (let y = 0; y < 64; y++)
                for (let x = 0; x < 64; x++) {
                    state.layers[0].pixels.set([x, y, 99, 255], (y * 64 + x) * 4);
                    state.layers[1].pixels.set(
                        x >= 16 && x < 48 && y >= 16 && y < 48 ? [17, 61, 89, 96] : [255, 0, 0, 255],
                        (y * 64 + x) * 4,
                    );
                }
            const originals = state.layers.map((layer) => hash(layer.pixels));
            await page.addInitScript(installNativeHarness, {});
            await page.addInitScript(faults);
            await page.goto(result.url);
            await page.waitForFunction(
                () =>
                    window.__myPaintPersistenceTest?.generation === 1 &&
                    !document.querySelector('dialog[open]'),
            );
            await page.evaluate(
                (bytes) => window.__myPaintPersistenceTest.queueOpen('fill.rpaint', Uint8Array.from(bytes)),
                [...encodeProject(state, desktopLimits)],
            );
            await page.getByRole('button', { name: '파일 열기', exact: true }).click();
            await page.waitForFunction(
                () =>
                    window.__myPaintPersistenceTest.generation === 2 &&
                    !document.querySelector('.busy') &&
                    document.querySelector('.workspace canvas').dataset.ready === 'true',
            );
            const box = await page.locator('.workspace canvas').boundingBox(),
                x = box.x + box.width / 2 - 32,
                y = box.y + box.height / 2 - 32;
            await page.getByRole('button', { name: '연필', exact: true }).click();
            await page.mouse.click(x + 55.5, y + 55.5);
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            await page.getByRole('button', { name: '채우기', exact: true }).click();
            record.attempts = [];
            for (let attempt = 1; attempt <= 2; attempt++) {
                const observation = { attempt },
                    started = Date.now();
                record.attempts.push(observation);
                const beforeFault = await page.evaluate(() => ({
                    created: window.fillFault.created,
                    terminated: window.fillFault.terminated,
                }));
                await page.evaluate((mode) => {
                    window.fillFault.mode = mode;
                }, mode);
                await page.mouse.click(x + 32.5, y + 32.5);
                if (mode === 'hold') {
                    await page.waitForFunction(() => window.fillFault.held.length === 1);
                    if (attempt === 1) {
                        await page.evaluate(() => {
                            window.fillFault.oldCancel = document.querySelector('.busy button');
                        });
                    } else {
                        observation.detachedCancelPreservedNextBusy = await page.evaluate(async () => {
                            const old = window.fillFault.oldCancel;
                            if (!old || old.isConnected)
                                throw Error('Expected a detached previous-task cancel button');
                            old.click();
                            await new Promise((resolve) =>
                                requestAnimationFrame(() => requestAnimationFrame(resolve)),
                            );
                            return !!document.querySelector('.busy');
                        });
                        assert.equal(
                            observation.detachedCancelPreservedNextBusy,
                            true,
                            'Previous detached cancel must not abort the new task',
                        );
                    }
                    await page.getByRole('button', { name: '취소', exact: true }).click();
                }
                await page.waitForFunction(() => !document.querySelector('.busy'));
                observation.elapsedMs = Date.now() - started;
                observation.status = await page.locator('.status').textContent();
                observation.afterFailure = await page.evaluate(() => ({
                    busyOverlay: !!document.querySelector('.busy'),
                    inert: [...document.querySelectorAll('.topbar, .tools, .inspector')].map(
                        (element) => element.inert,
                    ),
                    undoDisabled: document.querySelector('[data-command="undo"]').disabled,
                    redoDisabled: document.querySelector('[data-command="redo"]').disabled,
                    title: document.querySelector('.title').textContent,
                    workers: window.__myPaintPersistenceTest.liveWorkers.size,
                    injected: window.fillFault.injected,
                    created: window.fillFault.created,
                    terminated: window.fillFault.terminated,
                }));
                assert.match(observation.status, /Injected|일치|픽셀|영역|취소|초과/);
                if (mode === 'timeout')
                    assert(observation.elapsedMs >= 19000, 'Do not shorten the production timeout');
                assert.equal(
                    observation.afterFailure.injected,
                    attempt,
                    'Each same-page attempt must reach its intended fault',
                );
                assert.equal(
                    observation.afterFailure.redoDisabled,
                    false,
                    'Redo must be usable after failure',
                );
                assert.equal(observation.afterFailure.undoDisabled, true);
                assert.equal(observation.afterFailure.title.includes('*'), false);
                assert.deepEqual(
                    observation.afterFailure.inert,
                    [false, false, false],
                    'Failure must release inert controls',
                );
                assert.equal(observation.afterFailure.workers, 0);
                const expectedWorkers = mode === 'setup' || mode === 'construct' ? 0 : 1;
                assert.equal(observation.afterFailure.created - beforeFault.created, expectedWorkers);
                assert.equal(observation.afterFailure.terminated - beforeFault.terminated, expectedWorkers);
                await page.evaluate(() => {
                    for (const deliver of window.fillFault.held.splice(0)) deliver();
                });
                const failed = await save(page);
                assert.equal(failed.active, 1);
                assert.equal(failed.layers[1].visible, false);
                assert.deepEqual(
                    failed.layers.map((layer) => hash(layer.pixels)),
                    originals,
                );
                assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
                observation.sourceAndRedoExact = true;
            }
            await page.getByRole('button', { name: '다시 실행', exact: true }).click();
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            await page.mouse.click(x + 32.5, y + 32.5);
            await page.waitForFunction(() => !document.querySelector('.busy'));
            const retried = await save(page);
            assert.equal(retried.active, 1);
            assert.equal(retried.layers[1].visible, true);
            assert.equal(hash(retried.layers[0].pixels), originals[0]);
            const expected = state.layers[1].pixels.slice();
            for (let yy = 16; yy < 48; yy++)
                for (let xx = 16; xx < 48; xx++) expected.set([22, 121, 234, 255], (yy * 64 + xx) * 4);
            assert.equal(hash(retried.layers[1].pixels), hash(expected));
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            const undone = await save(page);
            assert.deepEqual(
                undone.layers.map((l) => hash(l.pixels)),
                originals,
            );
            assert.equal(undone.layers[1].visible, false);
            assert(!(await page.getByRole('button', { name: '실행 취소', exact: true }).isEnabled()));
            await page.getByRole('button', { name: '다시 실행', exact: true }).click();
            const redone = await save(page);
            assert.deepEqual(
                redone.layers.map((l) => hash(l.pixels)),
                retried.layers.map((l) => hash(l.pixels)),
            );
            record.observation = await page.evaluate(() => ({
                injected: window.fillFault.injected,
                terminated: window.fillFault.terminated,
                workers: window.__myPaintPersistenceTest.liveWorkers.size,
                productionTimeouts: window.fillFault.productionTimeouts,
            }));
            assert.equal(record.observation.injected, 2);
            if (mode === 'timeout') {
                assert.equal(record.observation.productionTimeouts.length, 2);
                for (const timer of record.observation.productionTimeouts) {
                    assert.equal(timer.delay, 20000);
                    assert(
                        timer.firedAt - timer.scheduledAt >= 19000,
                        'The actual production timeout must fire twice',
                    );
                }
            }
            assert.equal(record.observation.workers, 0);
            record.ok = true;
            result.checks.push(mode);
        } catch (error) {
            record.error = String(error.stack || error);
            result.failures.push({ mode, error: record.error });
        } finally {
            await context.close();
        }
    }
} finally {
    await browser.close();
    result.ok = result.checks.length === modes.length && !result.errors.length && !result.failures.length;
    await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ output, ok: result.ok, checks: result.checks, failures: result.failures }));
    if (!result.ok) process.exitCode = 1;
}
