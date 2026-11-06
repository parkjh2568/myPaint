import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createState } from '../src/engine/document.ts';
import { encodeProject } from '../src/engine/format.ts';

assert.ok(
    ['darwin', 'win32'].includes(process.platform),
    'Actual native smoke requires macOS or Windows. Mobile uses the web application.',
);
const webRoot = fileURLToPath(new URL('../', import.meta.url));
const binary = path.resolve(
    process.env.PAINT_DESKTOP_BINARY ||
        path.join(
            webRoot,
            'src-tauri/target/release',
            ...(process.platform === 'darwin'
                ? ['bundle/macos/myPaint Studio.app/Contents/MacOS/mypaint-desktop']
                : ['mypaint-desktop.exe']),
        ),
);
const output = path.resolve(
    process.env.PAINT_NATIVE_DESKTOP_OUTPUT ||
        path.join(webRoot, '../build-web-work/task-planning/current-tests/native-desktop/results.json'),
);
const result = {
    platform: process.platform,
    architecture: process.arch,
    binary,
    scope: 'Actual bundled native UI, IPC and isolated filesystem recovery, plus isolated 4096²/32768×1 codec, native quit-ownership and final-scene rendering runs; macOS runs WKWebView. Does not exercise OS file picker dialogs, manual visual acceptance, physical Android or another host platform.',
    timeoutMs: 120000,
    fixtures: [],
    ok: false,
};
let temporary;
let retainTemporary = false;
const appBundle =
    process.platform === 'darwin' ? binary.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/)?.[1] : undefined;
const launchMode = process.env.PAINT_NATIVE_LAUNCH_MODE ?? (appBundle ? 'foreground' : 'direct');
result.launchMode = launchMode;
result.launchModeSelection =
    process.env.PAINT_NATIVE_LAUNCH_MODE === undefined ? 'platform-default' : 'explicit-override';

// The four fixtures share ownership of one launched process, its bounded output and timeout cleanup.
async function launchNative(args, record) {
    const rootIndex = args.indexOf('--persistence-root');
    assert.ok(rootIndex >= 0);
    const persistenceRoot = args[rootIndex + 1];
    assert.ok(persistenceRoot && path.isAbsolute(persistenceRoot));
    record.arguments = args;
    record.launchMode = launchMode;
    record.launcherExitCode = null;
    record.appExitCode = null;
    record.appExitObserved = false;
    record.waitCompleted = false;
    const maxBuffer = 1024 * 1024;
    const options = {
        cwd: webRoot,
        timeout: result.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
    };
    let logFiles;
    let monitor;
    let logLimitExceeded = false;
    let logMonitorError;
    let execution;
    try {
        if (launchMode === 'foreground') {
            const logs = path.join(temporary, 'launcher-logs');
            await fs.mkdir(logs, { recursive: true });
            const label = persistenceRoot === temporary ? 'persistence' : path.basename(persistenceRoot);
            logFiles = [path.join(logs, label + '.stdout'), path.join(logs, label + '.stderr')];
            for (const file of logFiles) await fs.writeFile(file, '', { flag: 'wx', mode: 0o600 });
            record.logTransport =
                'owned temporary files; 1 MiB per stream, monitored and checked before read';
            record.launcher = '/usr/bin/open';
            execution = promisify(execFile)(
                '/usr/bin/open',
                [
                    '-n',
                    '-W',
                    '-a',
                    appBundle,
                    '--stdout',
                    logFiles[0],
                    '--stderr',
                    logFiles[1],
                    '--args',
                    ...args,
                ],
                options,
            );
            monitor = setInterval(() => {
                try {
                    if (logFiles.some((file) => statSync(file).size > maxBuffer)) {
                        logLimitExceeded = true;
                        execution.child.kill('SIGKILL');
                    }
                } catch (error) {
                    logMonitorError = error;
                    execution.child.kill('SIGKILL');
                }
            }, 100);
        } else {
            record.launcher = binary;
            execution = promisify(execFile)(binary, args, options);
        }
        const completed = await execution;
        record.waitCompleted = true;
        if (launchMode === 'foreground') record.launcherExitCode = 0;
        else {
            record.appExitCode = 0;
            record.appExitObserved = true;
        }
        if (logMonitorError) throw logMonitorError;
        if (logFiles) {
            const metadata = await Promise.all(logFiles.map((file) => fs.stat(file)));
            if (logLimitExceeded || metadata.some((stat) => stat.size > maxBuffer))
                throw Error('Native foreground output exceeded the 1 MiB per-stream capture limit');
            const streams = await Promise.all(logFiles.map((file) => fs.readFile(file, 'utf8')));
            assert.ok(streams.every((stream) => Buffer.byteLength(stream) <= maxBuffer));
            record.stdoutBytes = metadata[0].size;
            record.stderrBytes = metadata[1].size;
            return { stdout: streams[0], stderr: streams[1] };
        }
        return completed;
    } catch (error) {
        record.captureLimitExceeded = logLimitExceeded || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        if (launchMode === 'foreground') {
            if (typeof error.code === 'number') record.launcherExitCode = error.code;
        } else {
            if (typeof error.code === 'number') record.appExitCode = error.code;
            record.appExitObserved = typeof error.code === 'number' || Boolean(error.signal);
        }
        if (error.signal) record[launchMode === 'foreground' ? 'launcherSignal' : 'appSignal'] = error.signal;
        record.cleanup = { matchedPids: [], killedPids: [], remainingPids: [] };
        try {
            if (process.platform === 'darwin') {
                const realBinary = await fs.realpath(binary);
                const listing = await promisify(execFile)(
                    '/bin/ps',
                    ['-ax', '-o', 'pid=', '-o', 'command='],
                    { maxBuffer, encoding: 'utf8', timeout: 5000, shell: false },
                );
                const rootArgument = ' --persistence-root ' + persistenceRoot;
                for (const line of listing.stdout.split(/\r?\n/)) {
                    const match = line.trim().match(/^(\d+)\s+(.+)$/);
                    if (!match) continue;
                    const pid = Number(match[1]),
                        command = match[2];
                    if (
                        pid === process.pid ||
                        ![binary, realBinary].some((file) => command.startsWith(file + ' '))
                    )
                        continue;
                    if (!command.endsWith(rootArgument) && !command.includes(rootArgument + ' ')) continue;
                    record.cleanup.matchedPids.push(pid);
                    try {
                        process.kill(pid, 'SIGKILL');
                        record.cleanup.killedPids.push(pid);
                    } catch (failure) {
                        if (failure.code !== 'ESRCH') throw failure;
                    }
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
                const after = await promisify(execFile)('/bin/ps', ['-ax', '-o', 'pid=', '-o', 'command='], {
                    maxBuffer,
                    encoding: 'utf8',
                    timeout: 5000,
                    shell: false,
                });
                for (const line of after.stdout.split(/\r?\n/)) {
                    const match = line.trim().match(/^(\d+)\s+(.+)$/);
                    if (!match) continue;
                    const command = match[2];
                    if (
                        [binary, realBinary].some((file) => command.startsWith(file + ' ')) &&
                        (command.endsWith(rootArgument) || command.includes(rootArgument + ' '))
                    )
                        record.cleanup.remainingPids.push(Number(match[1]));
                }
                if (record.cleanup.remainingPids.length) retainTemporary = true;
            } else {
                record.cleanup.directChildOnly = true;
                record.cleanup.note =
                    'execFile owns the exact binary/arguments; its timeout terminates only that child';
            }
        } catch (failure) {
            record.cleanup.error = failure instanceof Error ? failure.message : String(failure);
            retainTemporary = true;
        }
        // A failed LaunchServices request can race its app launch; retain the unique root for diagnosis.
        if (launchMode === 'foreground') retainTemporary = true;
        if (logFiles) {
            try {
                const streams = [];
                for (const file of logFiles) {
                    const handle = await fs.open(file, 'r');
                    try {
                        const size = (await handle.stat()).size;
                        const bytes = Buffer.alloc(Math.min(size, maxBuffer));
                        const read = await handle.read(bytes, 0, bytes.length, 0);
                        streams.push(bytes.subarray(0, read.bytesRead).toString('utf8'));
                    } finally {
                        await handle.close();
                    }
                }
                error.stdout = streams[0];
                error.stderr = streams[1];
            } catch (failure) {
                record.logReadError = failure instanceof Error ? failure.message : String(failure);
            }
        }
        if (logLimitExceeded)
            error.message =
                'Native foreground output exceeded the 1 MiB per-stream capture limit: ' + error.message;
        throw error;
    } finally {
        if (monitor) clearInterval(monitor);
    }
}
try {
    assert.ok(
        ['direct', 'foreground'].includes(launchMode),
        'PAINT_NATIVE_LAUNCH_MODE must be direct or foreground',
    );
    assert.ok(
        launchMode !== 'foreground' || appBundle,
        'Foreground mode requires a macOS bundled .app binary',
    );
    const binaryBytes = await fs.readFile(binary);
    result.binarySha256 = createHash('sha256').update(binaryBytes).digest('hex');
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mypaint-native-desktop-'));
    const legacy = path.join(temporary, 'legacy');
    await fs.mkdir(legacy);
    const fixtures = [
        {
            name: 'recovery.rpaint',
            bytes: Buffer.from(encodeProject(createState(2, 1, [12, 34, 56, 78]))),
        },
        {
            name: 'session.lock',
            bytes: Buffer.from(`2147483647\nmypaint-desktop-smoke-fixture\n${os.hostname()}\n\n\n`),
        },
    ];
    for (const fixture of fixtures) {
        await fs.writeFile(path.join(legacy, fixture.name), fixture.bytes, { flag: 'wx' });
        const metadata = await fs.lstat(path.join(legacy, fixture.name), { bigint: true });
        result.fixtures.push({
            name: fixture.name,
            before: {
                bytes: fixture.bytes.length,
                sha256: createHash('sha256').update(fixture.bytes).digest('hex'),
                mtimeNs: String(metadata.mtimeNs),
                inode: String(metadata.ino),
                device: String(metadata.dev),
                mode: Number(metadata.mode),
            },
        });
    }
    const started = performance.now();
    const execution = await launchNative(['--smoke', '--persistence-root', temporary], result);
    result.elapsedMs = Math.round(performance.now() - started);
    const success = execution.stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith('myPaint native smoke: ok=true '));
    assert.equal(success.length, 1, `Expected one native success record. ${execution.stdout}`);
    result.checks = JSON.parse(success[0].slice('myPaint native smoke: ok=true '.length));
    assert.ok(Number.isSafeInteger(result.checks.encodedBytes));
    assert.ok(result.checks.encodedBytes > 64 * 1048576, 'Native IPC fixture must exceed 64 MiB');
    for (const check of ['pixelRoundtrip', 'staleRead', 'staleClear', 'legacyClear', 'oldGeneration'])
        assert.equal(result.checks[check], true, `Native smoke failed: ${check}`);
    const codecRoot = path.join(temporary, 'codec-run');
    const codecArguments = ['--smoke', '--codec-smoke', '--persistence-root', codecRoot];
    result.codecRun = { arguments: codecArguments, ok: false };
    const codecStarted = performance.now();
    try {
        const codecExecution = await launchNative(codecArguments, result.codecRun);
        result.codecRun.elapsedMs = Math.round(performance.now() - codecStarted);
        const codecSuccess = codecExecution.stdout
            .split(/\r?\n/)
            .filter((line) => line.startsWith('myPaint native smoke: ok=true '));
        assert.equal(
            codecSuccess.length,
            1,
            `Expected one native codec success record. ${codecExecution.stdout}`,
        );
        result.codecRun.checks = JSON.parse(codecSuccess[0].slice('myPaint native smoke: ok=true '.length));
        assert.equal(
            result.codecRun.checks.codec,
            true,
            'Expected the codec branch, not filesystem smoke output',
        );
        assert.deepEqual(result.codecRun.checks.checks, [
            'gif-static-red-8x6',
            'gif-animation-first-red',
            'gif-transparent-rgba',
        ]);
        result.codecRun.successRecord = codecSuccess[0];
        result.codecRun.ok = true;
        if (codecExecution.stderr.trim()) result.codecRun.stderr = codecExecution.stderr.trim().slice(-16384);
    } catch (error) {
        result.codecRun.elapsedMs = Math.round(performance.now() - codecStarted);
        result.codecRun.error = error instanceof Error ? error.message : String(error);
        if (error.signal) result.codecRun.signal = error.signal;
        if (error.stdout) result.codecRun.stdout = String(error.stdout).slice(-16384);
        if (error.stderr) result.codecRun.stderr = String(error.stderr).slice(-16384);
        throw error;
    }
    const quitRoot = path.join(temporary, 'quit-run');
    const quitArguments = ['--smoke', '--quit-smoke', '--persistence-root', quitRoot];
    result.quitRun = { arguments: quitArguments, ok: false };
    const quitStarted = performance.now();
    try {
        const quitExecution = await launchNative(quitArguments, result.quitRun);
        result.quitRun.elapsedMs = Math.round(performance.now() - quitStarted);
        const quitSuccess = quitExecution.stdout
            .split(/\r?\n/)
            .filter((line) => line.startsWith('myPaint native quit smoke:'));
        assert.equal(
            quitSuccess.length,
            1,
            `Expected one native quit success record. ${quitExecution.stdout}`,
        );
        assert.equal(
            quitExecution.stdout.split(/\r?\n/).filter((line) => line.startsWith('myPaint native smoke:'))
                .length,
            0,
            'Quit mode must not silently execute the filesystem or codec smoke branch',
        );
        assert.ok(
            quitSuccess[0].startsWith('myPaint native quit smoke: ok=true '),
            'Native quit fixture reported failure',
        );
        result.quitRun.checks = JSON.parse(
            quitSuccess[0].slice('myPaint native quit smoke: ok=true '.length),
        );
        assert.ok(
            result.quitRun.checks &&
                typeof result.quitRun.checks === 'object' &&
                !Array.isArray(result.quitRun.checks),
        );
        assert.deepEqual(
            result.quitRun.checks.modes,
            process.platform === 'darwin' ? ['runtime', 'native'] : ['runtime'],
        );
        for (const check of [
            'unsavedCancel',
            'pendingCancel',
            'busyPreserved',
            'repeatedQuitPreserved',
            'readyForApprovedClose',
        ])
            assert.equal(result.quitRun.checks[check], true, `Native quit smoke failed: ${check}`);
        // The marker plus a completed direct/LaunchServices wait requires the approved close; app exit code may be unobserved.
        result.quitRun.finalApprovedClose = true;
        result.quitRun.successRecord = quitSuccess[0];
        result.quitRun.ok = true;
        if (quitExecution.stderr.trim()) result.quitRun.stderr = quitExecution.stderr.trim().slice(-16384);
    } catch (error) {
        result.quitRun.elapsedMs = Math.round(performance.now() - quitStarted);
        result.quitRun.error = error instanceof Error ? error.message : String(error);
        if (error.signal) result.quitRun.signal = error.signal;
        if (error.killed) result.quitRun.killed = true;
        if (error.stdout) result.quitRun.stdout = String(error.stdout).slice(-16384);
        if (error.stderr) result.quitRun.stderr = String(error.stderr).slice(-16384);
        throw error;
    }
    const sceneRoot = path.join(temporary, 'render-run');
    const sceneArguments = ['--smoke', '--render-smoke', '--persistence-root', sceneRoot];
    result.sceneRun = { arguments: sceneArguments, ok: false };
    const sceneStarted = performance.now();
    try {
        const sceneExecution = await launchNative(sceneArguments, result.sceneRun);
        result.sceneRun.elapsedMs = Math.round(performance.now() - sceneStarted);
        const sceneSuccess = sceneExecution.stdout
            .split(/\r?\n/)
            .filter((line) => line.startsWith('myPaint native smoke: ok=true '));
        assert.equal(
            sceneSuccess.length,
            1,
            `Expected one native scene success record. ${sceneExecution.stdout}`,
        );
        result.sceneRun.checks = JSON.parse(sceneSuccess[0].slice('myPaint native smoke: ok=true '.length));
        const checks = result.sceneRun.checks;
        assert.equal(checks.scene, true, 'Expected the dedicated scene smoke branch');
        assert.deepEqual(checks.checks, [
            'cold',
            'unchanged',
            'rename',
            'dirty-boundary',
            'rollback',
            'selection',
            'selection-move',
            'selection-cancel',
            'hide',
            'unhide',
            'fractional-paper-edge',
            'minified-fallback',
            'restore-camera',
            'restored-unchanged',
            'authoritative-rgba-preserved',
            'color-eraser-capsule',
            'color-eraser-cancel-redo',
            'color-eraser-low-alpha',
            'square-thin-clipped',
            'square-wide-fixed-boundary',
            'square-event-source-over',
        ]);
        assert.ok(Number.isSafeInteger(checks.maxTiles) && checks.maxTiles >= 0 && checks.maxTiles <= 64);
        assert.ok(
            Number.isSafeInteger(checks.maxBytes) && checks.maxBytes >= 0 && checks.maxBytes <= 128 * 1048576,
        );
        assert.equal(checks.unchangedUploads, 0, 'Unchanged scenes must not upload source tiles');
        assert.deepEqual(
            checks.renderTimings.map((sample) => sample.phase),
            [
                'cache-empty-cold',
                ...Array.from({ length: 9 }, (_, index) => 'unchanged-' + index),
                'dirty',
                'rollback',
            ],
        );
        assert.deepEqual(
            checks.correctnessCosts.map((sample) => sample.phase),
            checks.checks.slice(0, 14),
        );
        assert.equal(checks.authorityDigests.length, 16);
        for (const digest of checks.authorityDigests) assert.match(digest, /^(?:\d{1,3},){31}\d{1,3}$/);
        for (const sample of checks.renderTimings) {
            for (const key of ['renderMs', 'queueMs', 'uploads', 'putImageDataBytes', 'captures'])
                assert.ok(Number.isFinite(sample[key]) && sample[key] >= 0, `Invalid native metric ${key}`);
            assert.deepEqual(sample.document, [2048, 2048, 16]);
            assert.deepEqual(sample.canvas, checks.renderTimings[0].canvas);
            assert.deepEqual(sample.view, checks.renderTimings[0].view);
            assert.deepEqual(sample.derivedPaperMatrix, checks.renderTimings[0].derivedPaperMatrix);
            assert.ok(sample.stats.tiles <= 64 && sample.stats.estimatedBytes <= 128 * 1048576);
            assert.ok(sample.stats.largestSurfaceDimension <= 512);
            if (sample.phase.startsWith('unchanged-')) {
                assert.equal(sample.uploads, 0);
                assert.equal(sample.captures, 0);
            }
        }
        result.sceneRun.successRecord = sceneSuccess[0];
        result.sceneRun.ok = true;
        if (sceneExecution.stderr.trim()) result.sceneRun.stderr = sceneExecution.stderr.trim().slice(-16384);
    } catch (error) {
        result.sceneRun.elapsedMs = Math.round(performance.now() - sceneStarted);
        result.sceneRun.error = error instanceof Error ? error.message : String(error);
        if (error.signal) result.sceneRun.signal = error.signal;
        if (error.killed) result.sceneRun.killed = true;
        if (error.stdout) result.sceneRun.stdout = String(error.stdout).slice(-16384);
        if (error.stderr) result.sceneRun.stderr = String(error.stderr).slice(-16384);
        throw error;
    }
    for (const [index, fixture] of fixtures.entries()) {
        const file = path.join(legacy, fixture.name);
        const bytes = await fs.readFile(file);
        const metadata = await fs.lstat(file, { bigint: true });
        assert.ok(metadata.isFile() && !metadata.isSymbolicLink(), `${fixture.name} was replaced`);
        result.fixtures[index].after = {
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            mtimeNs: String(metadata.mtimeNs),
            inode: String(metadata.ino),
            device: String(metadata.dev),
            mode: Number(metadata.mode),
        };
        assert.deepEqual(bytes, fixture.bytes, `${fixture.name} contents changed`);
        assert.deepEqual(
            result.fixtures[index].after,
            result.fixtures[index].before,
            `${fixture.name} metadata changed`,
        );
        result.fixtures[index].unchanged = true;
    }
    result.ok = true;
    if (execution.stderr.trim()) result.stderr = execution.stderr.trim().slice(-16384);
} catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    if (error.signal) result.signal = error.signal;
    if (error.killed) result.killed = true;
    if (error.stdout) result.stdout = String(error.stdout).slice(-16384);
    if (error.stderr) result.stderr = String(error.stderr).slice(-16384);
    throw error;
} finally {
    try {
        if (temporary && !retainTemporary) await fs.rm(temporary, { recursive: true, force: true });
        if (temporary && retainTemporary) result.retainedTemporaryRoot = temporary;
    } finally {
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, JSON.stringify(result) + '\n');
        console.log(JSON.stringify(result));
    }
}
