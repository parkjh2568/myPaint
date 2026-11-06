import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, gzipSync } from 'node:zlib';
import { decodePng, decodeProject } from '../src/engine/format';

// Independent wire fixtures: do not use the production PNG encoder as the decoder oracle.
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(type: string, data = Buffer.alloc(0)): Buffer {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    result.write(type, 4, 'ascii');
    data.copy(result, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, result.length - 4)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
}
function fixture(type: number, depth: number, interlace = 0, transparent = false) {
    const width = 13,
        height = 11,
        channels = type === 2 ? 3 : type === 4 ? 2 : type === 6 ? 4 : 1,
        max = 2 ** depth - 1,
        palette = Buffer.from([17, 31, 201, 244, 82, 9]),
        transparency = type === 3 ? Buffer.from([0, 123]) : Buffer.alloc(type === 0 ? 2 : 6),
        samples: number[][] = [],
        expected = new Uint8ClampedArray(width * height * 4);
    if (type === 2) for (let c = 0; c < 3; c++) transparency.writeUInt16BE((c * 1023) % (max + 1), c * 2);
    for (let p = 0; p < width * height; p++) {
        const values = Array.from({ length: channels }, (_, c) =>
            type === 3 ? p % 2 : (p * 223 + c * 1023) % (max + 1),
        );
        samples.push(values);
        const normalized = values.map((v) => Math.round((v * 255) / max));
        const rgb =
            type === 3
                ? Array.from(palette.subarray(values[0] * 3, values[0] * 3 + 3))
                : type === 0 || type === 4
                  ? [normalized[0], normalized[0], normalized[0]]
                  : normalized.slice(0, 3);
        const alpha =
            type === 3
                ? transparent
                    ? transparency[values[0]]
                    : 255
                : type === 4 || type === 6
                  ? normalized.at(-1)!
                  : transparent &&
                      values
                          .slice(0, type === 0 ? 1 : 3)
                          .every((v, c) => v === transparency.readUInt16BE(c * 2))
                    ? 0
                    : 255;
        expected.set([...rgb, alpha], p * 4);
    }
    const passes = interlace
            ? [
                  [0, 0, 8, 8],
                  [4, 0, 8, 8],
                  [0, 4, 4, 8],
                  [2, 0, 4, 4],
                  [0, 2, 2, 4],
                  [1, 0, 2, 2],
                  [0, 1, 1, 2],
              ]
            : [[0, 0, 1, 1]],
        scanlines: Buffer[] = [];
    for (const [ox, oy, dx, dy] of passes) {
        const w = Math.max(0, Math.ceil((width - ox) / dx)),
            h = Math.max(0, Math.ceil((height - oy) / dy));
        if (!w || !h) continue;
        let previous = Buffer.alloc(Math.ceil((w * channels * depth) / 8));
        for (let y = 0; y < h; y++) {
            const row = Buffer.alloc(previous.length),
                filter = y % 5,
                stride = Math.max(1, Math.ceil((channels * depth) / 8));
            for (let x = 0; x < w; x++)
                for (let c = 0; c < channels; c++) {
                    const bit = (x * channels + c) * depth,
                        value = samples[(oy + y * dy) * width + ox + x * dx][c];
                    if (depth === 16) row.writeUInt16BE(value, bit / 8);
                    else if (depth === 8) row[bit / 8] = value;
                    else row[Math.floor(bit / 8)] |= value << (8 - depth - (bit % 8));
                }
            const filtered = Buffer.alloc(row.length + 1);
            filtered[0] = filter;
            for (let i = 0; i < row.length; i++) {
                const a = i >= stride ? row[i - stride] : 0,
                    b = previous[i],
                    c = i >= stride ? previous[i - stride] : 0;
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
                filtered[i + 1] = (row[i] - predictor) & 255;
            }
            scanlines.push(filtered);
            previous = row;
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width);
    header.writeUInt32BE(height, 4);
    header[8] = depth;
    header[9] = type;
    header[12] = interlace;
    const chunks = [chunk('IHDR', header)];
    if (type === 3) chunks.push(chunk('PLTE', palette));
    if (transparent) chunks.push(chunk('tRNS', transparency));
    const compressed = deflateSync(Buffer.concat(scanlines)),
        halfway = Math.floor(compressed.length / 2);
    chunks.push(
        chunk('IDAT', compressed.subarray(0, halfway)),
        chunk('IDAT', compressed.subarray(halfway)),
        chunk('IEND'),
    );
    return {
        bytes: Buffer.concat([signature, ...chunks]),
        expected,
        width,
        height,
        header,
        compressed,
        palette,
    };
}

for (const [type, depths] of [
    [0, [1, 2, 4, 8, 16]],
    [2, [8, 16]],
    [3, [1, 2, 4, 8]],
    [4, [8, 16]],
    [6, [8, 16]],
] as const) {
    for (const depth of depths)
        for (const interlace of [0, 1]) {
            test(`PNG color type ${type}, depth ${depth}, interlace ${interlace}, five filters and exact alpha`, () => {
                const input = fixture(type, depth, interlace, type === 0 || type === 2 || type === 3),
                    actual = decodePng(input.bytes);
                assert.equal(actual.width, input.width);
                assert.equal(actual.height, input.height);
                assert.deepEqual(actual.pixels, input.expected);
            });
        }
}

test('PNG ignores unused trailing IDAT bytes as required for decoder compatibility', () => {
    const input = fixture(6, 8),
        bytes = Buffer.concat([
            signature,
            chunk('IHDR', input.header),
            chunk('IDAT', Buffer.concat([input.compressed, Buffer.from([7, 19, 0, 250, 81, 42, 91, 10])])),
            chunk('IEND'),
        ]);
    assert.deepEqual(decodePng(bytes).pixels, input.expected);
});

test('PNG rejects invalid required chunk ordering, duplicate palette and malformed transparency', () => {
    const input = fixture(3, 1),
        header = chunk('IHDR', input.header),
        palette = chunk('PLTE', input.palette),
        data = chunk('IDAT', input.compressed),
        end = chunk('IEND');
    const invalid = [
        ['palette after data', [header, data, palette, end]],
        ['duplicate palette', [header, palette, palette, data, end]],
        ['transparency exceeds palette', [header, palette, chunk('tRNS', Buffer.from([0, 1, 2])), data, end]],
        [
            'palette exceeds depth',
            [header, chunk('PLTE', Buffer.concat([input.palette, Buffer.from([1, 2, 3])])), data, end],
        ],
        [
            'non-consecutive IDAT',
            [
                header,
                palette,
                chunk('IDAT', input.compressed.subarray(0, 4)),
                chunk('tEXt', Buffer.from('k\0v')),
                chunk('IDAT', input.compressed.subarray(4)),
                end,
            ],
        ],
    ] as const;
    for (const [name, chunks] of invalid)
        assert.throws(() => decodePng(Buffer.concat([signature, ...chunks])), name);
});

test('RPAINT independent little-endian records accept Adam7 palette layer and preserve UTF8 metadata', () => {
    const input = fixture(3, 2, 1, true),
        name = Buffer.from('독립 레이어 🎨'),
        header = Buffer.alloc(28),
        record = Buffer.alloc(9 + name.length);
    header.write('RPAINT01');
    header.writeUInt32LE(input.width, 8);
    header.writeUInt32LE(input.height, 12);
    header.writeUInt32LE(1, 16);
    header.writeUInt32LE(0x80402010, 24);
    record.writeUInt32LE(name.length);
    name.copy(record, 4);
    record[4 + name.length] = 0;
    record.writeUInt32LE(input.bytes.length, 5 + name.length);
    const actual = decodeProject(Buffer.concat([header, record, input.bytes]));
    assert.deepEqual(actual.background, [64, 32, 16, 128]);
    assert.equal(actual.layers[0].name, '독립 레이어 🎨');
    assert.equal(actual.layers[0].visible, false);
    assert.deepEqual(actual.layers[0].pixels, input.expected);
});

test('PNG streams may split zlib header, deflate codes and Adler across single-byte IDAT chunks', () => {
    const input = fixture(6, 16, 1),
        bytes = Buffer.concat([
            signature,
            chunk('IHDR', input.header),
            ...Array.from(input.compressed, (value) => chunk('IDAT', Buffer.from([value]))),
            chunk('IEND'),
        ]);
    assert.deepEqual(decodePng(bytes).pixels, input.expected);
});

test('16-bit tRNS compares both source bytes before reducing samples to eight bits', () => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(2);
    header.writeUInt32BE(1, 4);
    header[8] = 16;
    header[9] = 0;
    const bytes = Buffer.concat([
        signature,
        chunk('IHDR', header),
        chunk('tRNS', Buffer.from([0, 1])),
        chunk('IDAT', deflateSync(Buffer.from([0, 0, 1, 0, 2]))),
        chunk('IEND'),
    ]);
    assert.deepEqual(Array.from(decodePng(bytes).pixels), [0, 0, 0, 0, 0, 0, 0, 255]);
});

test('PNG rejects truncated zlib, bad Adler, gzip and output exceeding declared bounds', () => {
    const input = fixture(6, 8),
        broken = input.compressed.slice();
    broken[broken.length - 1] ^= 1;
    const streams = [
        input.compressed.subarray(0, input.compressed.length - 1),
        broken,
        gzipSync(Buffer.alloc(13 * 11 * 4 + 11)),
        deflateSync(Buffer.alloc(4 * 1024 * 1024)),
    ];
    for (const stream of streams)
        assert.throws(() =>
            decodePng(
                Buffer.concat([signature, chunk('IHDR', input.header), chunk('IDAT', stream), chunk('IEND')]),
            ),
        );
    assert.throws(
        () =>
            decodePng(
                Buffer.concat([
                    signature,
                    chunk('IHDR', input.header),
                    chunk('IDAT', Buffer.concat([broken, input.compressed.subarray(-4)])),
                    chunk('IEND'),
                ]),
            ),
        'An appended valid checksum must not conceal the damaged stream checksum',
    );
});

test('Unknown ancillary chunks including the reserved property bit do not reject valid pixels', () => {
    const input = fixture(6, 8),
        bytes = Buffer.concat([
            signature,
            chunk('IHDR', input.header),
            chunk('teSt', Buffer.from('metadata')),
            chunk('test', Buffer.from('future reserved bit')),
            chunk('IDAT', input.compressed),
            chunk('IEND'),
        ]);
    assert.deepEqual(decodePng(bytes).pixels, input.expected);
    assert.throws(() =>
        decodePng(
            Buffer.concat([
                signature,
                chunk('IHDR', input.header),
                chunk('TeST'),
                chunk('IDAT', input.compressed),
                chunk('IEND'),
            ]),
        ),
    );
});

test('PNG tRNS masks unused high bits for sub-sixteen-bit gray and RGB samples', () => {
    for (const depth of [1, 2, 4, 8]) {
        const header = Buffer.alloc(13);
        header.writeUInt32BE(1);
        header.writeUInt32BE(1, 4);
        header[8] = depth;
        header[9] = 0;
        const sample = depth === 8 ? 23 : 1,
            transparency = Buffer.alloc(2);
        transparency.writeUInt16BE((65535 ^ (2 ** depth - 1)) | sample);
        const image = decodePng(
            Buffer.concat([
                signature,
                chunk('IHDR', header),
                chunk('tRNS', transparency),
                chunk('IDAT', deflateSync(Buffer.from([0, sample << (8 - depth)]))),
                chunk('IEND'),
            ]),
        );
        assert.equal(image.pixels[3], 0, `gray depth${depth}`);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 2;
    assert.deepEqual(
        Array.from(
            decodePng(
                Buffer.concat([
                    signature,
                    chunk('IHDR', header),
                    chunk('tRNS', Buffer.from([255, 23, 254, 41, 253, 61])),
                    chunk('IDAT', deflateSync(Buffer.from([0, 23, 41, 61]))),
                    chunk('IEND'),
                ]),
            ).pixels,
        ),
        [23, 41, 61, 0],
    );
});

test('RGBA8 rows preserve literal hidden RGB, all filters, offset input and independent output ownership', () => {
    const colors = [
        [17, 83, 201, 0],
        [252, 7, 33, 1],
        [19, 207, 64, 128],
        [91, 32, 253, 255],
    ];
    for (const width of [1, 3, 7])
        for (const height of [1, 3])
            for (let filter = 0; filter < 5; filter++) {
                const expected = new Uint8ClampedArray(width * height * 4),
                    raw = Buffer.alloc(height * (width * 4 + 1)),
                    header = Buffer.alloc(13);
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++)
                        expected.set(colors[(x + y) % colors.length], (y * width + x) * 4);
                    raw[y * (width * 4 + 1)] = filter;
                    for (let i = 0; i < width * 4; i++) {
                        const left = i >= 4 ? expected[y * width * 4 + i - 4] : 0,
                            up = y ? expected[(y - 1) * width * 4 + i] : 0,
                            corner = y && i >= 4 ? expected[(y - 1) * width * 4 + i - 4] : 0,
                            p = left + up - corner,
                            candidates = [left, up, corner];
                        const paeth = candidates.reduce((best, value) =>
                            Math.abs(p - value) < Math.abs(p - best) ? value : best,
                        );
                        const predictor = [0, left, up, Math.floor((left + up) / 2), paeth][filter];
                        raw[y * (width * 4 + 1) + i + 1] = (expected[y * width * 4 + i] - predictor) & 255;
                    }
                }
                header.writeUInt32BE(width);
                header.writeUInt32BE(height, 4);
                header[8] = 8;
                header[9] = 6;
                const wire = Buffer.concat([
                        signature,
                        chunk('IHDR', header),
                        chunk('IDAT', deflateSync(raw)),
                        chunk('IEND'),
                    ]),
                    padded = new Uint8Array(wire.length + 9).fill(0xa7);
                padded.set(wire, 3);
                const original = padded.slice(),
                    input = padded.subarray(3, 3 + wire.length),
                    first = decodePng(input),
                    second = decodePng(input);
                assert.deepEqual([first.width, first.height], [width, height]);
                assert.deepEqual(first.pixels, expected);
                assert.deepEqual(second.pixels, expected);
                assert.notEqual(first.pixels.buffer, input.buffer);
                assert.notEqual(first.pixels.buffer, second.pixels.buffer);
                first.pixels.fill(0);
                assert.deepEqual(second.pixels, expected);
                assert.deepEqual(padded, original);
            }
});

test('RGBA8 rejects a valid-CRC valid-zlib PNG containing filter5', () => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 6;
    const wire = Buffer.concat([
            signature,
            chunk('IHDR', header),
            chunk('IDAT', deflateSync(Buffer.from([5, 17, 83, 201, 0]))),
            chunk('IEND'),
        ]),
        original = Buffer.from(wire);
    assert.throws(() => decodePng(wire), /PNG 필터 오류/);
    assert.deepEqual(wire, original);
});

test('RGBA8 pixel allocation failure preserves input and permits a normal retry', () => {
    const input = fixture(6, 8),
        original = Buffer.from(input.bytes),
        Original = Uint8ClampedArray,
        failure = new RangeError('one-shot pixel allocation failure');
    let injected = 0;
    globalThis.Uint8ClampedArray = new Proxy(Original, {
        construct(target, args) {
            if (!injected && args[0] === input.width * input.height * 4) {
                injected++;
                throw failure;
            }
            return Reflect.construct(target, args);
        },
    });
    try {
        assert.throws(
            () => decodePng(input.bytes),
            (error) => error === failure,
        );
    } finally {
        globalThis.Uint8ClampedArray = Original;
    }
    assert.equal(injected, 1);
    assert.deepEqual(input.bytes, original);
    assert.deepEqual(decodePng(input.bytes).pixels, input.expected);
});
