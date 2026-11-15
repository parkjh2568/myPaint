import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { desktopLimits } from '../web-app/src/engine/document.ts';
import { decodeProject, encodeProject } from '../web-app/src/engine/format.ts';

// Run with Node's tsx loader from web-app so this uses the exact baseline codecs.
const binaryPath = process.env.GPUI_BINARY;
if (!binaryPath) throw Error('GPUI_BINARY must name the GPUI executable');
const binary = path.resolve(binaryPath);
assert.ok((await fs.stat(binary)).isFile(), 'GPUI_BINARY must be a file');

const outputPath = process.env.PAINT_CODEC_INTEROP_OUTPUT;
let output;
if (outputPath) {
    output = path.resolve(outputPath);
    await fs.mkdir(output);
} else {
    const parent = fileURLToPath(new URL('../build-codec-interop/', import.meta.url));
    await fs.mkdir(parent, { recursive: true });
    output = await fs.mkdtemp(path.join(parent, 'run-'));
}

const launch = promisify(execFile);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fingerprint = ({ width, height, active, background, layers }) => ({
    width,
    height,
    active,
    background: [...background],
    layers: layers.map(({ name, visible, pixels }) => ({ name, visible, rgbaSha256: sha256(pixels) })),
});
const readProject = async (file) => decodeProject(await fs.readFile(file), desktopLimits);
const qt = JSON.parse(
    await fs.readFile(new URL('../web-app/tests/fixtures/qt-project.json', import.meta.url), 'utf8'),
);

function studioProject() {
    const width = 73;
    const height = 47;
    const layers = ['반투명 선 🎨', '숨김 레이어', '투명 RGB'].map((name, layer) => {
        const pixels = new Uint8ClampedArray(width * height * 4);
        for (let pixel = 0; pixel < width * height; pixel++) {
            pixels.set(
                [
                    (pixel + 71 * layer) % 256,
                    (pixel * 17 + layer * 9) % 256,
                    (pixel * 31 + layer * 77) % 256,
                    [0, 1, 64, 127, 128, 255][(pixel + layer) % 6],
                ],
                pixel * 4,
            );
        }
        return { name, visible: layer !== 1, pixels };
    });
    return encodeProject({ width, height, active: 0, background: [187, 63, 211, 32], layers }, desktopLimits);
}

const evidence = {
    platform: process.platform,
    arch: process.arch,
    baselineCodecSha256: sha256(
        await fs.readFile(new URL('../web-app/src/engine/format.ts', import.meta.url)),
    ),
    gpuiBinary: binary,
    gpuiSha256: sha256(await fs.readFile(binary)),
    scope: 'Baseline TypeScript codec and GPUI executable codec/persistence commands; no GUI or installer checks',
    cases: [],
};

const cases = [
    ['qt-original-wire', Buffer.from(qt.projectBase64, 'base64')],
    ['tauri-studio-wire', studioProject()],
];
const tauriArtifact = process.env.TAURI_INTEROP_FILE;
if (tauriArtifact) {
    const metadata = await fs.stat(tauriArtifact);
    assert.ok(metadata.isFile() && metadata.size <= desktopLimits.inputBytes, 'Invalid TAURI_INTEROP_FILE');
    cases.push(['tauri-installed-app-wire', await fs.readFile(tauriArtifact)]);
}

for (const [name, original] of cases) {
    const directory = path.join(output, name);
    await fs.mkdir(directory);
    const source = path.join(directory, 'source.rpaint');
    await fs.writeFile(source, original, { flag: 'wx' });
    const destination = path.join(directory, 'native-recovery');
    const expected = await readProject(source);
    const expectedOriginal = fingerprint(expected);
    const pixel = expected.layers[expected.active].pixels;
    [0x61, 0x33, 0x27, 0x81].forEach((delta, channel) => {
        pixel[channel] ^= delta;
    });
    const expectedRecovery = fingerprint(expected);

    const runProbe = async (verb, ...paths) => {
        const { stdout, stderr } = await launch(binary, ['--interop', verb, ...paths], {
            encoding: 'utf8',
            maxBuffer: 2 * 1024 * 1024,
            timeout: 120_000,
            windowsHide: true,
        });
        const report = JSON.parse(stdout);
        await fs.writeFile(path.join(directory, `${verb}.json`), `${JSON.stringify(report, null, 2)}\n`);
        if (stderr.trim()) await fs.writeFile(path.join(directory, `${verb}.stderr.txt`), stderr);
        return report;
    };

    const inspection = await runProbe('inspect', source);
    assert.deepEqual(inspection, expectedOriginal);
    const roundtrip = await runProbe('exercise', source, destination);
    assert.deepEqual(roundtrip.original, expectedOriginal);
    assert.deepEqual(roundtrip.roundtrip, expectedOriginal);
    assert.deepEqual(roundtrip.recoveryExpected, expectedRecovery);
    assert.equal(roundtrip.closedSnapshotRejected, true);
    assert.equal(roundtrip.closedSavePathReleased, true);
    const published = path.join(destination, 'roundtrip.rpaint');
    assert.deepEqual(fingerprint(await readProject(published)), expectedOriginal);

    // The first invocation has exited, so this reopens recovery in a new OS process.
    const recovery = await runProbe('recover', destination);
    const recovered = path.join(destination, 'recovered.rpaint');
    assert.deepEqual(recovery.recovered, expectedRecovery);
    assert.deepEqual(fingerprint(await readProject(recovered)), expectedRecovery);
    assert.notDeepEqual(expectedRecovery, expectedOriginal);
    assert.equal(sha256(await fs.readFile(source)), sha256(original));
    evidence.cases.push({
        name,
        sourceSha256: sha256(original),
        roundtripSha256: sha256(await fs.readFile(published)),
        recoveredSha256: sha256(await fs.readFile(recovered)),
        roundtripFingerprint: expectedOriginal,
        recoveredFingerprint: expectedRecovery,
        sourcePreserved: true,
        closedSnapshotRejected: roundtrip.closedSnapshotRejected,
        closedSavePathReleased: roundtrip.closedSavePathReleased,
    });
}

const reportPath = path.join(output, 'results.json');
await fs.writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, report: reportPath, cases: evidence.cases.length }));
