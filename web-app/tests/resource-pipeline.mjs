import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { createState, desktopLimits } from '../src/engine/document.ts';
import { decodeProject, encodeProject } from '../src/engine/format.ts';

assert(['darwin', 'linux'].includes(process.platform), 'Host RSS sampling requires ps on macOS or Linux');
const url = new URL(process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/');
assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'Use the local Studio preview');
const folder = await mkdtemp(path.join(os.tmpdir(), 'paint-resource-pipeline-'));
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
const cdp = await browser.newBrowserCDPSession();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const errors = [];
const samples = [];
let stage = 'initial';
let running = true;
let workers = 0;
page.on('pageerror', (error) => errors.push(String(error)));
page.on('worker', () => workers++);
const ps = promisify(execFile);

async function sample() {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    const pids = [...new Set(processInfo.map((entry) => entry.id))];
    const { stdout } = await ps('ps', ['-o', 'rss=', '-p', pids.join(',')]);
    samples.push({
        stage,
        memoryBytes: stdout
            .trim()
            .split(/\s+/)
            .reduce((sum, kib) => sum + Number(kib) * 1024, 0),
    });
}
try {
    await page.goto(url.href);
    await page.waitForSelector('canvas[data-ready=true]');
    await sample();
    const report = (async () => {
        while (running) {
            await setTimeout(40);
            if (running) await sample();
        }
    })();
    try {
        const width = 2048;
        const height = 2048;
        const fixture = path.join(folder, 'resource-fixture.rpaint');
        const input = createState(width, height, [16, 32, 48, 255], desktopLimits);
        await writeFile(fixture, encodeProject(input, desktopLimits));
        stage = 'worker-open';
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: '파일 열기', exact: true }).click();
        await (await chooser).setFiles(fixture);
        await page.getByRole('tab', { name: 'resource-fixture.rpaint', exact: true }).waitFor();
        const canvas = page.locator('.workspace canvas');
        const box = await canvas.boundingBox();
        assert(box);
        stage = 'edit-and-recovery';
        await page.getByRole('button', { name: '브러시', exact: true }).click();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 24, { steps: 20 });
        await page.mouse.up();
        stage = 'download-and-recovery';
        await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
        const fileButton = page.getByRole('button', { name: '파일 받기', exact: true });
        await fileButton.waitFor();
        const event = page.waitForEvent('download');
        await fileButton.click();
        const downloaded = await readFile(await (await event).path());
        const saved = decodeProject(new Uint8Array(downloaded), desktopLimits);
        assert.equal(saved.width, width);
        assert.equal(saved.height, height);
        assert.notDeepEqual(saved.layers[0].pixels, input.layers[0].pixels);
        await page.waitForFunction(async () => {
            const db = await new Promise((resolve, reject) => {
                const open = indexedDB.open('mypaint-studio-recovery-v2');
                open.onsuccess = () => resolve(open.result);
                open.onerror = () => reject(open.error);
            });
            try {
                if (!db.objectStoreNames.contains('snapshots')) return false;
                return await new Promise((resolve, reject) => {
                    const req = db.transaction('snapshots').objectStore('snapshots').count();
                    req.onsuccess = () => resolve(req.result > 0);
                    req.onerror = () => reject(req.error);
                });
            } finally {
                db.close();
            }
        });
        await sample();
        await page.getByRole('button', { name: '다운로드 닫기', exact: true }).click();
        assert(workers > 0);
        assert.deepEqual(errors, []);
        const baseline = samples[0].memoryBytes;
        console.log(
            JSON.stringify({
                browser: browser.version(),
                width,
                height,
                workerCount: workers,
                rpaintBytes: downloaded.length,
                baselineRssBytes: baseline,
                sampledPeakRssDelta: Math.max(...samples.map((value) => value.memoryBytes)) - baseline,
                stagePeaks: Object.fromEntries(
                    [...new Set(samples.map((value) => value.stage))].map((name) => [
                        name,
                        Math.max(
                            ...samples
                                .filter((value) => value.stage === name)
                                .map((value) => value.memoryBytes),
                        ),
                    ]),
                ),
                samples: samples.length,
            }),
        );
    } finally {
        running = false;
        await report;
    }
} finally {
    await browser.close();
    await rm(folder, { recursive: true, force: true });
}
