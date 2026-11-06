import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
const output = path.resolve(
    process.env.PAINT_CORE_FIXTURES_DIR ||
        '../build-web-work/task-planning/current-tests/matched-core/fixtures',
);
const specBytes = await fs.readFile(new URL('./fixtures/matched-core.json', import.meta.url));
const spec = JSON.parse(specBytes);
assert.equal(spec.schema, 1);
assert.equal(spec.fixtures.length, 6);
assert.equal(new Set(spec.fixtures.map((f) => f.id)).size, 6);
await fs.mkdir(path.dirname(output), { recursive: true });
assert.equal(
    await fs.lstat(output).then(
        () => true,
        () => false,
    ),
    false,
    'Fixture destination must be new',
);
// Exclusive directory ownership prevents adopting another run's existing destination.
await fs.mkdir(output, { recursive: false });
const stage = output;
try {
    const manifest = {
        ...spec,
        specSha256: createHash('sha256').update(specBytes).digest('hex'),
        producerSha256: createHash('sha256')
            .update(await fs.readFile(new URL(import.meta.url)))
            .digest('hex'),
        node: process.version,
        zlib: process.versions.zlib,
        totalWireBytes: 0,
    };
    for (const fixture of manifest.fixtures) {
        const { width, height } = fixture;
        assert(/^[a-z0-9-]+$/.test(fixture.id));
        assert(
            Number.isInteger(width) &&
                Number.isInteger(height) &&
                width > 0 &&
                height > 0 &&
                width <= 4096 &&
                height <= 4096 &&
                width * height <= 4194304 &&
                width * height * fixture.layers.length <= 6291456,
        );
        const records = [];
        for (const layer of fixture.layers) {
            const pixels = Buffer.alloc(width * height * 4);
            if (fixture.kind === 'white') pixels.fill(255);
            else {
                assert.equal(fixture.kind, 'rgb');
                let seed = layer.seed;
                for (let i = 0; i < pixels.length; i += 4) {
                    seed ^= seed << 13;
                    seed ^= seed >>> 17;
                    seed ^= seed << 5;
                    seed >>>= 0;
                    pixels[i] = seed & 255;
                    pixels[i + 1] = (seed >>> 8) & 255;
                    pixels[i + 2] = (seed >>> 16) & 255;
                    pixels[i + 3] = 255;
                }
            }
            assert.deepEqual(Array.from(pixels.subarray(0, 16)), layer.prefix);
            assert.equal(
                createHash('sha256').update(pixels).digest('hex'),
                layer.sha256,
                'Independent Python plane must match',
            );
            const raw = Buffer.alloc(height * (width * 4 + 1));
            for (let y = 0; y < height; y++)
                pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
            const header = Buffer.alloc(13);
            header.writeUInt32BE(width);
            header.writeUInt32BE(height, 4);
            header[8] = 8;
            header[9] = 6;
            const chunks = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])];
            for (const [tag, data] of [
                ['IHDR', header],
                ['IDAT', deflateSync(raw, { level: 1 })],
                ['IEND', Buffer.alloc(0)],
            ]) {
                const chunk = Buffer.alloc(data.length + 12);
                chunk.writeUInt32BE(data.length);
                chunk.write(tag, 4, 'ascii');
                data.copy(chunk, 8);
                chunk.writeUInt32BE(crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4);
                chunks.push(chunk);
            }
            const png = Buffer.concat(chunks),
                name = Buffer.from(layer.name, 'utf8');
            assert(png.length <= 20 * 1048576 && name.length <= 1024);
            const record = Buffer.alloc(9 + name.length);
            record.writeUInt32LE(name.length);
            name.copy(record, 4);
            record[4 + name.length] = Number(layer.visible);
            record.writeUInt32LE(png.length, 5 + name.length);
            records.push(record, png);
            layer.pngBytes = png.length;
        }
        const header = Buffer.alloc(28);
        header.write('RPAINT01');
        header.writeUInt32LE(width, 8);
        header.writeUInt32LE(height, 12);
        header.writeUInt32LE(fixture.layers.length, 16);
        header.writeUInt32LE(fixture.active, 20);
        const [r, g, b, a] = fixture.background;
        header.writeUInt32LE(((a << 24) | (r << 16) | (g << 8) | b) >>> 0, 24);
        const wire = Buffer.concat([header, ...records]);
        assert(wire.length <= 40 * 1048576);
        fixture.wireBytes = wire.length;
        fixture.wireSha256 = createHash('sha256').update(wire).digest('hex');
        manifest.totalWireBytes += wire.length;
        await fs.writeFile(path.join(stage, fixture.id + '.rpaint'), wire, { flag: 'wx' });
    }
    await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
        flag: 'wx',
    });

    console.log(
        JSON.stringify({
            output,
            fixtures: manifest.fixtures.length,
            bytes: manifest.totalWireBytes,
            specSha256: manifest.specSha256,
        }),
    );
} catch (error) {
    console.error('Fixture generation failed; incomplete owned output retained at ' + output);
    throw error;
}
