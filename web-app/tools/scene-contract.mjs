import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('..', import.meta.url)),
    output = path.resolve(
        app,
        process.env.PAINT_SCENE_RUN_OUTPUT || '../build-web-work/task-planning/scene-regression',
    ),
    candidate = new URL(process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/');
assert(
    candidate.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(candidate.hostname) &&
        !candidate.username &&
        !candidate.password &&
        !candidate.search &&
        !candidate.hash &&
        candidate.pathname.endsWith('/'),
    'PAINT_TEST_URL must be a loopback HTTP directory URL without credentials, query or fragment',
);
await fs.mkdir(output, { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex'),
    metadata = {
        scope: 'Current-source reference bypasses only final scene capture/reuse in a private build. It retains the current PixelTileCache and physical background fill. This repeatable regression is distinct from the separately recorded legacy f3 reference comparison; it does not independently certify source-cache changes or timing.',
        candidate: candidate.href,
        testSha256: hash(await fs.readFile(path.join(app, 'tests/scene-contract.mjs'))),
        source: [],
        referenceSource: [],
        referenceBundles: [],
        commands: [],
        changes: [],
        status: 'running',
    };
let mirror, server, child, cancelled;
async function hashTree(directory, relative = '') {
    const files = [];
    for (const item of (await fs.readdir(path.join(directory, relative), { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
    )) {
        const name = path.join(relative, item.name);
        if (item.isDirectory()) files.push(...(await hashTree(directory, name)));
        else {
            assert(item.isFile(), 'Unexpected non-file in build input/output: ' + name);
            files.push({
                path: name.split(path.sep).join('/'),
                sha256: hash(await fs.readFile(path.join(directory, name))),
            });
        }
    }
    return files;
}
const stopRequests = new WeakMap();
function stopChild(processChild) {
    if (!processChild?.pid) return Promise.resolve();
    const pending = stopRequests.get(processChild);
    if (pending) return pending;
    if (processChild.exitCode !== null || processChild.signalCode !== null) return Promise.resolve();
    const cleanup = (async () => {
        if (process.platform === 'win32') {
            await new Promise((resolve) =>
                execFile(
                    'taskkill',
                    ['/PID', String(processChild.pid), '/T', '/F'],
                    { windowsHide: true },
                    () => resolve(),
                ),
            );
        } else {
            // Playwright may put Chromium in its own process group. Capture descendants
            // before stopping the Node owner so interruption cannot orphan that browser.
            const tree = await new Promise((resolve, reject) =>
                    execFile('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }, (error, stdout) =>
                        error ? reject(error) : resolve(stdout),
                    ),
                ),
                rows = tree
                    .trim()
                    .split('\n')
                    .map((row) => row.trim().split(/\s+/).map(Number)),
                owned = new Set([processChild.pid]);
            for (let previous = -1; previous !== owned.size; ) {
                previous = owned.size;
                for (const [pid, parent] of rows) if (owned.has(parent) && pid > 1) owned.add(pid);
            }
            for (const signal of ['SIGTERM', 'SIGKILL']) {
                for (const pid of [-processChild.pid, ...[...owned].reverse()]) {
                    try {
                        process.kill(pid, signal);
                    } catch (error) {
                        if (error.code !== 'ESRCH') throw error;
                    }
                }
                if (signal === 'SIGTERM') await new Promise((resolve) => setTimeout(resolve, 200));
            }
        }
    })();
    stopRequests.set(processChild, cleanup);
    // Signal/timeout hooks start cleanup; run/finally joins this original promise.
    void cleanup.catch(() => {});
    return cleanup;
}
async function run(name, args, cwd, env = process.env) {
    assert(!cancelled, 'Scene regression interrupted');
    const command = { name, executable: process.execPath, args, cwd, status: 'running' };
    metadata.commands.push(command);
    let timedOut = false;
    const result = await new Promise((resolve) => {
        child = execFile(
            process.execPath,
            args,
            {
                cwd,
                env,
                detached: process.platform !== 'win32',
                windowsHide: true,
                encoding: 'utf8',
                maxBuffer: 32 * 1024 * 1024,
            },
            (error, stdout, stderr) => resolve({ error, stdout, stderr }),
        );
        const timer = setTimeout(
            () => {
                timedOut = true;
                void stopChild(child);
            },
            20 * 60 * 1000,
        );
        child.once('close', () => clearTimeout(timer));
    });
    const completed = child;
    child = undefined;
    await stopChild(completed);
    await fs.writeFile(path.join(output, name + '.log'), result.stdout + result.stderr);
    command.status = result.error || timedOut || cancelled ? 'failed' : 'passed';
    command.code = result.error?.code ?? 0;
    command.signal = result.error?.signal;
    if (result.error || timedOut || cancelled)
        throw Object.assign(
            Error(
                `${name} failed; see ${path.join(output, name + '.log')}${timedOut ? ' (20 minute timeout)' : ''}`,
            ),
            {
                exitCode:
                    Number.isInteger(result.error?.code) && result.error.code > 0 && result.error.code < 256
                        ? result.error.code
                        : 1,
            },
        );
}
const interrupt = (signal) => {
    cancelled = signal;
    if (child) void stopChild(child);
};
const onInterrupt = () => interrupt('SIGINT'),
    onTerminate = () => interrupt('SIGTERM');
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);
try {
    mirror = await fs.mkdtemp(path.join(os.tmpdir(), 'mypaint-scene-contract-'));
    const inputs = [
        'src',
        'public',
        'tests',
        'index.html',
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'vite.config.ts',
    ];
    for (const name of inputs)
        await fs.cp(path.join(app, name), path.join(mirror, name), { recursive: true });
    await fs.symlink(
        await fs.realpath(path.join(app, 'node_modules')),
        path.join(mirror, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
    );
    for (const name of inputs) {
        const full = path.join(mirror, name);
        if ((await fs.stat(full)).isDirectory())
            metadata.source.push(
                ...(await hashTree(full)).map((item) => ({ ...item, path: name + '/' + item.path })),
            );
        else metadata.source.push({ path: name, sha256: hash(await fs.readFile(full)) });
    }
    const mainPath = path.join(mirror, 'src/main.ts'),
        original = await fs.readFile(mainPath, 'utf8'),
        property = 'sceneCache = new FinalSceneCache();',
        anchor = 'class Studio {',
        replacement = 'sceneCache: FinalSceneCache = new ReferenceSceneCache();',
        referenceClass = `class ReferenceSceneCache extends FinalSceneCache {
    override prepare(
        _ctx: Parameters<FinalSceneCache['prepare']>[0],
        frame: Parameters<FinalSceneCache['prepare']>[1],
        rasters: SceneRaster[],
    ): PixelRect {
        this.source.beginFrame(rasters.length);
        for (const raster of rasters) this.source.invalidate(raster.owner, raster.dirty);
        return frame.viewport;
    }
}
`;
    assert.equal(
        original.split(property).length - 1,
        1,
        'Reference property replacement must match exactly once',
    );
    assert.equal(
        original.split(anchor).length - 1,
        1,
        'Reference subclass insertion must match exactly once',
    );
    const modified = original.replace(property, replacement).replace(anchor, referenceClass + anchor);
    await fs.writeFile(mainPath, modified);
    metadata.changes.push({
        path: 'src/main.ts',
        originalSha256: hash(original),
        referenceSha256: hash(modified),
        property: { from: property, to: replacement },
        insertedBefore: anchor,
        insertedSource: referenceClass,
        inheritedFinish:
            'No-op: subclass prepare never assigns the private target. Source cache retains its default 64 tiles / 128MiB budget.',
    });
    metadata.referenceSource = await hashTree(path.join(mirror, 'src'));
    await run('reference-check', [path.join(app, 'node_modules/typescript/bin/tsc'), '--noEmit'], mirror);
    await run('reference-build', [path.join(app, 'node_modules/vite/bin/vite.js'), 'build'], mirror);
    const dist = await fs.realpath(path.join(mirror, 'dist'));
    metadata.referenceBundles = await hashTree(dist);
    server = createServer((request, response) => {
        void (async () => {
            if (!['GET', 'HEAD'].includes(request.method)) {
                response.writeHead(405).end();
                return;
            }
            const url = new URL(request.url, 'http://127.0.0.1'),
                pathname = decodeURIComponent(url.pathname);
            if (!pathname.startsWith('/mypaint/')) {
                response.writeHead(404).end();
                return;
            }
            const relative = pathname.slice('/mypaint/'.length) || 'index.html',
                target = path.resolve(dist, relative);
            if (!target.startsWith(dist + path.sep)) {
                response.writeHead(403).end();
                return;
            }
            let real;
            try {
                real = await fs.realpath(target);
            } catch (error) {
                if (['ENOENT', 'ENOTDIR', 'EINVAL'].includes(error.code)) {
                    response.writeHead(404).end();
                    return;
                }
                throw error;
            }
            if (!real.startsWith(dist + path.sep) || !(await fs.stat(real)).isFile()) {
                response.writeHead(403).end();
                return;
            }
            const bytes = await fs.readFile(real),
                type =
                    {
                        '.html': 'text/html',
                        '.js': 'text/javascript',
                        '.css': 'text/css',
                        '.txt': 'text/plain',
                        '.json': 'application/json',
                        '.wasm': 'application/wasm',
                    }[path.extname(real)] || 'application/octet-stream';
            response.writeHead(200, {
                'Content-Type': type,
                'Content-Length': bytes.length,
                'Cache-Control': 'no-store',
            });
            response.end(request.method === 'HEAD' ? undefined : bytes);
        })().catch((error) => {
            response.writeHead(error instanceof URIError ? 400 : 500).end();
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    metadata.referenceUrl = `http://127.0.0.1:${server.address().port}/mypaint/`;
    await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(metadata, null, 2) + '\n');
    const referenceReport = path.join(output, 'reference.json'),
        candidateReport = path.join(output, 'candidate.json'),
        test = path.join(app, 'tests/scene-contract.mjs');
    await run('reference', ['--import', 'tsx', test], app, {
        ...process.env,
        PAINT_SCENE_MODE: 'record',
        PAINT_SCENE_OUTPUT: referenceReport,
        PAINT_SCENE_REFERENCE: '',
        PAINT_TEST_URL: metadata.referenceUrl,
    });
    await run('candidate', ['--import', 'tsx', test], app, {
        ...process.env,
        PAINT_SCENE_MODE: 'compare',
        PAINT_SCENE_OUTPUT: candidateReport,
        PAINT_SCENE_REFERENCE: referenceReport,
        PAINT_TEST_URL: candidate.href,
    });
    const reference = JSON.parse(await fs.readFile(referenceReport, 'utf8')),
        comparison = JSON.parse(await fs.readFile(candidateReport, 'utf8'));
    assert.equal(reference.testSha256, metadata.testSha256);
    assert.equal(comparison.testSha256, metadata.testSha256);
    assert.equal(hash(await fs.readFile(test)), metadata.testSha256, 'Test source changed during the run');
    assert.equal(comparison.frames.length, 56);
    assert(comparison.frames.every((frame) => frame.byteEqual));
    assert.equal(comparison.documents.length, 12);
    assert(comparison.documents.every((document) => document.byteEqual));
    metadata.reports = {
        reference: hash(await fs.readFile(referenceReport)),
        candidate: hash(await fs.readFile(candidateReport)),
    };
    metadata.candidateBundles = comparison.assets;
    metadata.status = 'passed';
    console.log(
        `Scene regression passed: 56 Canvas comparisons and 12 preserved document outputs. ${path.join(output, 'manifest.json')}`,
    );
} catch (error) {
    metadata.status = 'failed';
    metadata.error = error.stack || String(error);
    console.error(error.message || error);
    process.exitCode = cancelled ? (cancelled === 'SIGINT' ? 130 : 143) : error.exitCode || 1;
} finally {
    await stopChild(child);
    if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    if (mirror) await fs.rm(mirror, { recursive: true, force: true });
    metadata.cleanedUp = true;
    await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(metadata, null, 2) + '\n');
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
}
