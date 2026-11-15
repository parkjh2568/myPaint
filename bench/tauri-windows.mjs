import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const workspace = fileURLToPath(new URL('..', import.meta.url));
const workload = JSON.parse(await fs.readFile(new URL('./brush-workload.json', import.meta.url), 'utf8'));
const { width, height, wave, firstX, firstY, xStep, yStep } = workload;
const strokes = Array.from({ length: workload.strokes }, (_, row) => ({
    button: row % 2 ? 'right' : 'left',
    color: row % 2 ? [0, 0, 255, 255] : [255, 0, 0, 255],
    points: wave.map((dy, index) => [
        firstX + xStep * (row % 2 ? wave.length - 1 - index : index),
        firstY + yStep * row + dy,
    ]),
}));

const usage = [
    'TAURI_BINARY=<installed mypaint-desktop.exe> node bench/tauri-windows.mjs',
    'BENCH_ROOT      Root for separate run and WebView2 profiles. Default build-bench-tauri/.',
    'BENCH_RESULT    Summary JSON path. Default <new run directory>/results.json.',
    'BENCH_RUNS      Independent process launches (1–10). Default 3.',
    'BENCH_LAYERS    Visible transparent layers in the 2048×2048 fixture (1–16). Default 1.',
    'BENCH_VERIFY_RECOVERY=1 verifies recovery via a separate process on the last run without timing it.',
    'BENCH_GPUI_PROJECT accepts a GPUI-written project and verifies it in the installed Tauri recovery UI.',
    'BENCH_MEMORY=0 skips the app and descendant memory snapshot.',
].join('\n');

function boundedInteger(value, fallback, minimum, maximum) {
    const parsed = value === undefined ? fallback : Number(value);
    assert(Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum);
    return parsed;
}

function digest(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function statistics(samples) {
    const sorted = samples.toSorted((a, b) => a - b);
    if (!sorted.length) return { count: 0 };
    const percentile = (p) => sorted[Math.ceil(p * sorted.length) - 1];
    return {
        count: sorted.length,
        min: sorted[0],
        p50: percentile(0.5),
        p95: percentile(0.95),
        max: sorted.at(-1),
    };
}

async function unusedPort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    return address.port;
}

async function poll(check, description, timeoutMs = 25_000) {
    const limit = performance.now() + timeoutMs;
    while (performance.now() < limit) {
        const result = await check();
        if (result) return result;
        await delay(20);
    }
    throw Error('Timed out waiting for ' + description);
}

async function drainFrames(page) {
    const controller = new AbortController();
    try {
        await Promise.race([
            page.evaluate(
                () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            ),
            delay(7500, undefined, { signal: controller.signal }).then(() => {
                throw Error('WebView2 did not produce two animation-frame callbacks');
            }),
        ]);
    } finally {
        controller.abort();
    }
}

async function launchInstalled(binary, chromium, persistenceRoot, profile, expectRecovery = false) {
    await fs.mkdir(profile, { recursive: true });
    const endpoint = 'http://127.0.0.1:' + (await unusedPort());
    const started = performance.now();
    const child = spawn(binary, ['--persistence-root', persistenceRoot], {
        cwd: path.dirname(binary),
        env: {
            ...process.env,
            WEBVIEW2_USER_DATA_FOLDER: profile,
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + new URL(endpoint).port,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: false,
    });
    let launchError;
    let stderr = '';
    child.on('error', (error) => {
        launchError = error;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-32768);
    });

    let browser;
    let stopped = false;
    const close = async () => {
        if (stopped) return;
        stopped = true;
        // This session owns one exact process and one distinct WebView2 profile.
        // Terminate only this child so interactive Studio sessions stay outside the benchmark.
        if (child.exitCode === null && child.signalCode === null) child.kill();
        if (browser) await browser.close().catch(() => {});
        if (child.pid && child.exitCode === null && child.signalCode === null) {
            await poll(
                () => child.exitCode !== null || child.signalCode !== null,
                'the owned app process to exit',
                5000,
            );
        }
    };

    try {
        const version = await poll(async () => {
            if (launchError) throw launchError;
            if (child.exitCode !== null || child.signalCode !== null)
                throw Error('Installed Studio exited before debugger attach. ' + stderr);
            try {
                const response = await fetch(endpoint + '/json/version', {
                    signal: AbortSignal.timeout(750),
                });
                if (!response.ok) return undefined;
                const info = await response.json();
                return info.webSocketDebuggerUrl ? info : undefined;
            } catch {
                return undefined;
            }
        }, 'the isolated WebView2 debugging endpoint');
        browser = await chromium.connectOverCDP(endpoint, { timeout: 12000 });
        const page = await poll(
            () =>
                browser
                    .contexts()
                    .flatMap((context) => context.pages())
                    .find((target) => /^https?:\/\/tauri\.localhost\//.test(target.url())),
            'the installed Studio window',
        );
        page.setDefaultTimeout(12_000);
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.waitForFunction((expectRecovery) => {
            if (expectRecovery && document.querySelector('dialog[open] select[name=entry]')) return true;
            const canvas = document.querySelector('.workspace canvas');
            const paper = document.querySelector('.canvas-bounds');
            return Boolean(
                window.__TAURI__?.core && canvas?.dataset.ready === 'true' && paper && !paper.hidden,
            );
        }, expectRecovery);
        const startupMs = performance.now() - started;
        return {
            page,
            close,
            pid: child.pid,
            startupMs,
            webviewVersion: version.Browser,
            errors,
            diagnostics: () => stderr,
        };
    } catch (error) {
        await close();
        if (stderr) error.message += '\nWebView2: ' + stderr;
        throw error;
    }
}

async function prepareDocument(page, layers) {
    await page.getByRole('button', { name: '새 그림 탭', exact: true }).click();
    const dialog = page.locator('dialog[open]');
    await dialog.getByLabel('너비', { exact: true }).fill(String(width));
    await dialog.getByLabel('높이', { exact: true }).fill(String(height));
    await dialog.getByLabel('배경', { exact: true }).selectOption('투명');
    await dialog.getByRole('button', { name: '확인', exact: true }).click();
    await page.waitForFunction(
        ([width, height]) =>
            document.querySelector('.document-info')?.textContent === width + ' × ' + height + ' px' &&
            document.querySelector('.workspace canvas')?.dataset.ready === 'true',
        [width, height],
    );
    for (let index = 1; index < layers; index++)
        await page.getByRole('button', { name: '레이어 추가', exact: true }).click();
    await page.getByRole('button', { name: '브러시', exact: true }).click();
    await page.evaluate(
        (settings) => {
            for (const [id, value] of Object.entries(settings)) {
                const input = document.getElementById(id);
                input.value = String(value);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        },
        {
            size: 12,
            opacity: 100,
            hardness: 100,
            stabilization: 0,
            color: '#ff0000',
            secondary: '#0000ff',
        },
    );
    await page.locator('#pressure').uncheck();
    await page.locator('#square').uncheck();
    await drainFrames(page);
    assert.equal(await page.locator('.layer-row').count(), layers);
}

async function viewGeometry(page) {
    return page.evaluate(
        ([width, height]) => {
            const canvas = document.querySelector('.workspace canvas');
            const { x, y, width: viewWidth, height: viewHeight } = canvas.getBoundingClientRect();
            const paper = document.querySelector('.canvas-bounds').style;
            return {
                userAgent: navigator.userAgent,
                devicePixelRatio,
                screenCss: [screen.width, screen.height],
                windowCss: [innerWidth, innerHeight],
                canvasCss: { x, y, width: viewWidth, height: viewHeight },
                canvasBacking: [canvas.width, canvas.height],
                paperOrigin: [x + parseFloat(paper.left), y + parseFloat(paper.top)],
                documentZoom: [parseFloat(paper.width) / width, parseFloat(paper.height) / height],
            };
        },
        [width, height],
    );
}

async function observeBrushFrames(page) {
    await page.evaluate(() => {
        const canvas = document.querySelector('.workspace canvas');
        const tape = { stroke: -1, inputs: [] };
        window.__myPaintCompareProbe = tape;
        for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
            canvas.addEventListener(
                type,
                (event) => {
                    if (!event.isTrusted || (type === 'pointermove' && !event.buttons)) return;
                    const received = performance.now();
                    const entry = { stroke: tape.stroke, type, eventToHandlerMs: received - event.timeStamp };
                    tape.inputs.push(entry);
                    requestAnimationFrame(() => {
                        entry.handlerToNextRafMs = performance.now() - received;
                        requestAnimationFrame(() => {
                            entry.handlerToFollowingRafMs = performance.now() - received;
                        });
                    });
                },
                { capture: true, passive: true },
            );
        }
    });
}

async function verifyColoredPixels(page, geometry) {
    return page.evaluate(
        ({ geometry, expected }) => {
            const canvas = document.querySelector('.workspace canvas');
            const context = canvas.getContext('2d');
            const scaleX = canvas.width / geometry.canvasCss.width;
            const scaleY = canvas.height / geometry.canvasCss.height;
            return expected.map(({ point, color }) => {
                const x = Math.round(
                    (geometry.paperOrigin[0] - geometry.canvasCss.x + point[0] * geometry.documentZoom[0]) *
                        scaleX,
                );
                const y = Math.round(
                    (geometry.paperOrigin[1] - geometry.canvasCss.y + point[1] * geometry.documentZoom[1]) *
                        scaleY,
                );
                const small = context.getImageData(x - 2, y - 2, 5, 5).data;
                let bestDistance = Infinity;
                let sampled;
                for (let i = 0; i < small.length; i += 4) {
                    const pixel = Array.from(small.subarray(i, i + 4));
                    const distance = pixel.reduce(
                        (total, channel, index) => total + Math.abs(channel - color[index]),
                        0,
                    );
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        sampled = pixel;
                    }
                }
                return { point, color, sampled, distance: bestDistance };
            });
        },
        {
            geometry,
            expected: strokes.map(({ points, color }) => ({ point: points[8], color })),
        },
    );
}

async function processMemory(rootPid) {
    const pid = String(rootPid);
    assert(/^[0-9]+$/.test(pid));
    const script = [
        '$items = @(Get-CimInstance Win32_Process)',
        '$selected = @(' + pid + ')',
        'do { $previous = $selected.Count; $selected = @($selected + @($items | Where-Object { $_.ParentProcessId -in $selected } | ForEach-Object { [int]$_.ProcessId }) | Sort-Object -Unique) } while ($selected.Count -gt $previous)',
        '@(Get-Process -Id $selected -ErrorAction SilentlyContinue | Select-Object Id,Name,PrivateMemorySize64,WorkingSet64,CPU) | ConvertTo-Json -Compress -AsArray',
    ].join('\n');
    try {
        const { stdout } = await promisify(execFile)(
            'pwsh.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            { timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 },
        );
        const entries = JSON.parse(stdout);
        return {
            scope: 'Root process and descendants with current Windows parent-process IDs.',
            count: entries.length,
            privateBytes: entries.reduce((bytes, entry) => bytes + entry.PrivateMemorySize64, 0),
            workingSetBytes: entries.reduce((bytes, entry) => bytes + entry.WorkingSet64, 0),
            processes: entries,
        };
    } catch (error) {
        return { unavailable: String(error.message || error) };
    }
}

async function publishActiveRecovery(page, persistenceRoot) {
    const tabs = page.getByRole('tablist', { name: '그림 탭' }).getByRole('tab');
    assert((await tabs.count()) > 1);
    const active = page.getByRole('tablist', { name: '그림 탭' }).getByRole('tab', { selected: true });
    const activeKey = await active.getAttribute('data-tab');
    assert.match(activeKey || '', /^[a-zA-Z0-9_-]+$/);
    const original = path.join(persistenceRoot, 'app', 'recovery', activeKey + '.rprec');
    await tabs.first().click();
    const snapshot = await poll(async () => {
        try {
            const size = (await fs.stat(original)).size;
            assert(size <= 300 * 1024 * 1024 + 4108);
            return size > 28 ? await fs.readFile(original) : undefined;
        } catch (error) {
            if (error.code === 'ENOENT') return undefined;
            throw error;
        }
    }, 'native RPREC001 backup after tab switch');
    assert.equal(snapshot.toString('ascii', 0, 8), 'RPREC001');
    const payloadOffset = 12 + snapshot.readUInt32LE(8);
    assert.equal(snapshot.toString('ascii', payloadOffset, payloadOffset + 8), 'RPAINT01');
    return { original, snapshot, payload: snapshot.subarray(payloadOffset) };
}

async function openRecoveryDialog(page, expectedWidth, expectedHeight) {
    const dialog = page.locator('dialog[open]');
    if (!(await dialog.isVisible())) {
        await delay(850);
        if (!(await dialog.isVisible())) {
            await page.getByRole('button', { name: '파일 및 편집 메뉴' }).click();
            await dialog.getByRole('tab', { name: '파일', exact: true }).click();
            await dialog.getByRole('button', { name: '복구 사본', exact: true }).click();
        }
    }
    await dialog.getByRole('heading', { name: '이 기기의 복구 사본', exact: true }).waitFor();
    const choice = dialog.locator('select[name=entry]');
    const label = await choice.locator('option').first().textContent();
    await choice.selectOption({ index: 0 });
    await dialog.getByRole('button', { name: '확인', exact: true }).click();
    await page.waitForFunction(
        ([width, height]) =>
            document.querySelector('.document-info')?.textContent === width + ' × ' + height + ' px' &&
            document.querySelector('.workspace canvas')?.dataset.ready === 'true' &&
            document.querySelectorAll('[role=tablist] [role=tab]').length > 1 &&
            !document.querySelector('dialog[open]'),
        [expectedWidth, expectedHeight],
    );
    return label;
}

async function openGpuiProject(binary, chromium, requireWebApp, sourcePath, root) {
    const source = path.resolve(sourcePath);
    const info = await fs.stat(source);
    assert(info.isFile() && info.size <= 300 * 1024 * 1024);
    const input = await fs.readFile(source);
    const { register } = requireWebApp('tsx/esm/api');
    const loader = register({ namespace: 'myPaintReverseInterop' });
    let decodeProject;
    let desktopLimits;
    try {
        ({ decodeProject } = await loader.import('../web-app/src/engine/format.ts', import.meta.url));
        ({ desktopLimits } = await loader.import('../web-app/src/engine/document.ts', import.meta.url));
    } finally {
        await loader.unregister();
    }
    const fingerprint = (bytes) => {
        const { width, height, active, background, layers } = decodeProject(bytes, desktopLimits);
        return {
            width,
            height,
            active,
            background,
            layers: layers.map(({ name, visible, pixels }) => ({
                name,
                visible,
                rgbaSha256: digest(pixels),
            })),
        };
    };
    const expected = fingerprint(input);
    const persistenceRoot = path.join(root, 'persistence');
    const legacy = path.join(persistenceRoot, 'legacy');
    await fs.mkdir(legacy, { recursive: true });
    const staged = path.join(legacy, 'recovery.rpaint');
    await fs.writeFile(staged, input, { flag: 'wx' });
    const app = await launchInstalled(binary, chromium, persistenceRoot, path.join(root, 'webview2'), true);
    try {
        const entry = await openRecoveryDialog(app.page, expected.width, expected.height);
        assert.match(entry, /읽기 전용/);
        const { payload, snapshot } = await publishActiveRecovery(app.page, persistenceRoot);
        const actual = fingerprint(payload);
        assert.deepEqual(actual, expected);
        assert.equal(digest(await fs.readFile(staged)), digest(input));
        assert.equal(digest(await fs.readFile(source)), digest(input));
        assert.deepEqual(app.errors, []);
        return {
            scope: 'GPUI-written wire opened via the real installed Tauri recovery dialog, then read from the native RPREC001 snapshot produced on switching away.',
            source,
            sourceSha256: digest(input),
            inputBytes: input.length,
            entry,
            tauriSnapshotBytes: snapshot.length,
            tauriSnapshotSha256: digest(snapshot),
            tauriPayloadSha256: digest(payload),
            actual,
            expected,
        };
    } finally {
        await app.close();
    }
}

async function verifyRecovery(binary, chromium, persistenceRoot, runRoot, owner) {
    const originalGeometry = await viewGeometry(owner.page);
    const originalPixels = await verifyColoredPixels(owner.page, originalGeometry);
    const { original, snapshot, payload } = await publishActiveRecovery(owner.page, persistenceRoot);
    const recoveredProject = path.join(runRoot, 'tauri-brush-recovered.rpaint');
    await fs.writeFile(recoveredProject, payload, { flag: 'wx' });

    // Exercise the real closed-process recovery path using this run's disposable profile.
    await owner.close();
    const restart = await launchInstalled(
        binary,
        chromium,
        persistenceRoot,
        path.join(runRoot, 'webview2-restart'),
        true,
    );
    try {
        await openRecoveryDialog(restart.page, width, height);
        let restoredPixels;
        let restoredGeometry;
        try {
            await poll(
                async () => {
                    await drainFrames(restart.page);
                    restoredGeometry = await viewGeometry(restart.page);
                    restoredPixels = await verifyColoredPixels(restart.page, restoredGeometry);
                    return restoredPixels.every(
                        (sample, index) =>
                            sample.distance <= 32 &&
                            sample.sampled.every(
                                (channel, component) => channel === originalPixels[index].sampled[component],
                            ),
                    );
                },
                'the painted red/blue samples in the restored canvas',
                12000,
            );
        } catch (error) {
            const canvasColors = await restart.page.evaluate(() => {
                const canvas = document.querySelector('.workspace canvas');
                const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
                const colors = { red: 0, blue: 0 };
                for (let index = 0; index < pixels.length; index += 4) {
                    if (pixels[index] >= 240 && pixels[index + 1] <= 16 && pixels[index + 2] <= 16)
                        colors.red++;
                    if (pixels[index + 2] >= 240 && pixels[index + 1] <= 16 && pixels[index] <= 16)
                        colors.blue++;
                }
                return { ...colors, status: document.querySelector('.status')?.textContent };
            });
            throw Error(
                error.message +
                    '\n' +
                    JSON.stringify({ originalGeometry, restoredGeometry, restoredPixels, canvasColors }),
            );
        }
        assert.equal(digest(await fs.readFile(original)), digest(snapshot));
        assert.deepEqual(restart.errors, []);
        return {
            scope: 'Actual tab-switch persistence, forced exit of the owned process and visible recovery dialog.',
            bytes: snapshot.length,
            backupSha256: digest(snapshot),
            payloadBytes: payload.length,
            payloadSha256: digest(payload),
            recoveredProject,
            matchingCanvasSamples: restoredPixels.length,
        };
    } finally {
        await restart.close();
    }
}

async function measureRun(binary, chromium, layers, runRoot, verify) {
    await fs.mkdir(runRoot);
    const persistenceRoot = path.join(runRoot, 'persistence');
    const app = await launchInstalled(binary, chromium, persistenceRoot, path.join(runRoot, 'webview2'));
    try {
        const { page } = app;
        await prepareDocument(page, layers);
        const geometry = await viewGeometry(page);
        await observeBrushFrames(page);
        const wallMsByStroke = [];
        for (const [index, stroke] of strokes.entries()) {
            await page.evaluate((index) => {
                window.__myPaintCompareProbe.stroke = index;
            }, index);
            const screenPoints = stroke.points.map(([x, y]) => [
                geometry.paperOrigin[0] + x * geometry.documentZoom[0],
                geometry.paperOrigin[1] + y * geometry.documentZoom[1],
            ]);
            const [start, ...moves] = screenPoints;
            await page.mouse.move(...start);
            const started = performance.now();
            await page.mouse.down({ button: stroke.button });
            for (const point of moves) await page.mouse.move(...point);
            await page.mouse.up({ button: stroke.button });
            await drainFrames(page);
            wallMsByStroke.push(performance.now() - started);
        }
        const tape = await page.evaluate(() => window.__myPaintCompareProbe);
        assert.equal(tape.inputs.filter((input) => input.type === 'pointerdown').length, strokes.length);
        assert.equal(tape.inputs.filter((input) => input.type === 'pointerup').length, strokes.length);
        assert(
            tape.inputs.some(
                (input) => input.type === 'pointermove' && input.handlerToFollowingRafMs !== undefined,
            ),
        );
        const colors = await verifyColoredPixels(page, geometry);
        for (const sample of colors)
            assert(sample.distance <= 32, 'Unexpected post-stroke canvas pixels ' + JSON.stringify(sample));
        await page.getByRole('button', { name: '실행 취소', exact: true }).click();
        await drainFrames(page);
        const undo = await verifyColoredPixels(page, geometry);
        assert(undo.at(-1).distance > 32, 'Undo must remove the last blue stroke');
        await page.getByRole('button', { name: '다시 실행', exact: true }).click();
        await drainFrames(page);
        assert.deepEqual(await verifyColoredPixels(page, geometry), colors);
        const memory = process.env.BENCH_MEMORY === '0' ? undefined : await processMemory(app.pid);
        assert.deepEqual(app.errors, []);
        let recovery;
        let recoveryFailure;
        if (verify) {
            try {
                recovery = await verifyRecovery(binary, chromium, persistenceRoot, runRoot, app);
            } catch (error) {
                recoveryFailure = error.stack || String(error);
            }
        }
        return {
            startupMs: app.startupMs,
            webviewVersion: app.webviewVersion,
            geometry,
            strokeCommandAndTwoRafMs: wallMsByStroke,
            eventFrames: tape.inputs,
            colors,
            undoRedo: true,
            memory,
            recovery,
            recoveryFailure,
            webviewStderr: app.diagnostics(),
        };
    } finally {
        await app.close();
    }
}

async function main() {
    if (process.argv.includes('--help')) {
        console.log(usage);
        return;
    }
    assert.equal(process.platform, 'win32', 'Use an actual Windows desktop with WebView2');
    assert(process.env.TAURI_BINARY, usage);
    const requireWebApp = createRequire(new URL('../web-app/package.json', import.meta.url));
    const { chromium } = requireWebApp('playwright');
    const binary = path.resolve(process.env.TAURI_BINARY);
    const parent = path.resolve(process.env.BENCH_ROOT || path.join(workspace, 'build-bench-tauri'));
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, 'run-'));
    const output = path.resolve(process.env.BENCH_RESULT || path.join(root, 'results.json'));
    await fs.mkdir(path.dirname(output), { recursive: true });
    const file = await fs.open(output, 'wx');
    const count = boundedInteger(process.env.BENCH_RUNS, 3, 1, 10);
    const layers = boundedInteger(process.env.BENCH_LAYERS, 1, 1, 16);
    const report = {
        platform: process.platform,
        arch: process.arch,
        binary,
        binarySha256: digest(await fs.readFile(binary)),
        scratch: root,
        measuredAt: new Date().toISOString(),
        measurement: {
            startup:
                'Spawn through attached CDP observing the first writable canvas. Includes attach and poll latency.',
            scriptWall:
                'Browser automation command round trips for one stroke plus two animation frame callbacks.',
            scheduling:
                'Trusted pointer event delivered in the app plus first and following animation-frame callbacks. Frame callbacks do not expose physical display presentation.',
            pixelReadback: 'Canvas pixels sampled after replay, outside timed phases.',
        },
        workload: {
            width,
            height,
            layers,
            brushSize: 12,
            opacity: 1,
            hardness: 1,
            stabilization: 0,
            strokes,
        },
        runs: [],
    };
    try {
        if (process.env.BENCH_GPUI_PROJECT) {
            report.reverseInterop = await openGpuiProject(
                binary,
                chromium,
                requireWebApp,
                process.env.BENCH_GPUI_PROJECT,
                root,
            );
            report.ok = true;
            return;
        }
        for (let run = 0; run < count; run++) {
            const verify = process.env.BENCH_VERIFY_RECOVERY === '1' && run === count - 1;
            report.runs.push(
                await measureRun(binary, chromium, layers, path.join(root, String(run + 1)), verify),
            );
        }
        const events = report.runs.flatMap((run) => run.eventFrames);
        report.timing = {
            startupMs: statistics(report.runs.map((run) => run.startupMs)),
            strokeCommandAndTwoRafMs: statistics(report.runs.flatMap((run) => run.strokeCommandAndTwoRafMs)),
            eventToHandlerMs: statistics(
                events.map((event) => event.eventToHandlerMs).filter(Number.isFinite),
            ),
            handlerToNextRafMs: statistics(
                events.map((event) => event.handlerToNextRafMs).filter(Number.isFinite),
            ),
            handlerToFollowingRafMs: statistics(
                events.map((event) => event.handlerToFollowingRafMs).filter(Number.isFinite),
            ),
        };
        report.failure = report.runs.find((run) => run.recoveryFailure)?.recoveryFailure;
        report.ok = report.failure === undefined;
        if (!report.ok) process.exitCode = 1;
    } catch (error) {
        report.ok = false;
        report.failure = error.stack || String(error);
        process.exitCode = 1;
    } finally {
        try {
            await file.writeFile(JSON.stringify(report, null, 2) + '\n');
        } finally {
            await file.close();
        }
        console.log(
            JSON.stringify({ ok: report.ok, output, timing: report.timing, failure: report.failure }),
        );
    }
}

await main();
