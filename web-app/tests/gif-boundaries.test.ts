import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readArtwork } from '../src/platform/codec';
import { webLimits, desktopLimits } from '../src/engine/document';

// Independently generated red 8×6 GIF with a four-entry palette and per-pixel LZW clear codes.
const original = Uint8Array.from(
    Buffer.from(
        'R0lGODlhCAAGAIEAAAAAAP8AAAD/AAAA/yH5BAQCAAAALAAAAAAIAAYAAAIlDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwBQA7',
        'base64',
    ),
);
const descriptor = 33;

for (const [name, offset, value, profile] of [
    ['web first width', 5, 4097, webLimits],
    ['web first height', 7, 4097, webLimits],
    ['web first x extent', 1, 4096, webLimits],
    ['web first y extent', 3, 4096, webLimits],
    ['desktop first width', 5, 32769, desktopLimits],
    ['desktop first x extent', 1, 32768, desktopLimits],
] as const)
    test(`${name} rejects before the native decoder is called`, async () => {
        const bytes = original.slice(),
            view = new DataView(bytes.buffer),
            native = globalThis.createImageBitmap;
        view.setUint16(descriptor + offset, value, true);
        let calls = 0;
        globalThis.createImageBitmap = (async () => {
            calls++;
            throw Error('Unsafe native decoder entry');
        }) as typeof createImageBitmap;
        try {
            await assert.rejects(
                readArtwork(
                    { size: bytes.length, arrayBuffer: async () => bytes.buffer },
                    undefined,
                    profile,
                ),
                /이미지 크기 또는 레이어 메모리 한도/,
            );
            assert.equal(calls, 0);
        } finally {
            globalThis.createImageBitmap = native;
        }
    });

test('GIF first-frame extent enforces pixel area as well as each axis', async () => {
    const bytes = original.slice(),
        view = new DataView(bytes.buffer),
        native = globalThis.createImageBitmap;
    view.setUint16(descriptor + 5, 3000, true);
    view.setUint16(descriptor + 7, 2000, true);
    let calls = 0;
    globalThis.createImageBitmap = (async () => {
        calls++;
        throw Error('Unsafe native decoder entry');
    }) as typeof createImageBitmap;
    try {
        await assert.rejects(
            readArtwork({ size: bytes.length, arrayBuffer: async () => bytes.buffer }),
            /이미지 크기 또는 레이어 메모리 한도/,
        );
        assert.equal(calls, 0);
    } finally {
        globalThis.createImageBitmap = native;
    }
});

test('GIF first-frame preflight preserves bounded expansion and later-frame decoding policy', async () => {
    const native = globalThis.createImageBitmap,
        variants = [original.slice(), original.slice(), original.slice()];
    variants[0][4] = 55;
    new DataView(variants[1].buffer).setUint16(descriptor + 1, 24, true);
    new DataView(variants[2].buffer).setUint16(descriptor + 5, 12, true);
    variants.push(Uint8Array.from([...original.subarray(0, -1), 0x2c, 0, 0]));
    let calls = 0;
    globalThis.createImageBitmap = (async () => {
        calls++;
        throw Error('Expected native decoder entry');
    }) as typeof createImageBitmap;
    try {
        for (const bytes of variants)
            await assert.rejects(
                readArtwork({ size: bytes.length, arrayBuffer: async () => bytes.buffer }),
                /Expected native decoder entry/,
            );
        assert.equal(calls, variants.length);
    } finally {
        globalThis.createImageBitmap = native;
    }
});

test('GIF extension payload markers do not masquerade as the first image', async () => {
    const native = globalThis.createImageBitmap;
    let calls = 0;
    globalThis.createImageBitmap = (async () => {
        calls++;
        throw Error('Expected native decoder entry');
    }) as typeof createImageBitmap;
    try {
        for (const label of [0xfe, 0xff, 0x01, 0xee]) {
            const bytes = Uint8Array.from([
                ...original.subarray(0, 25),
                0x21,
                label,
                3,
                0x2c,
                0x21,
                0x3b,
                2,
                255,
                255,
                0,
                ...original.subarray(25),
            ]);
            await assert.rejects(
                readArtwork({ size: bytes.length, arrayBuffer: async () => bytes.buffer }),
                /Expected native decoder entry/,
            );
        }
        assert.equal(calls, 4);
    } finally {
        globalThis.createImageBitmap = native;
    }
});

test('GIF incomplete headers, palettes, extensions and first descriptors reject before native decoding', async () => {
    const native = globalThis.createImageBitmap,
        variants = [
            ...[8, 10, 12, 13, 24, 25, 26, 27, 30, 32, 33, 34, 41, 42].map((length) =>
                original.slice(0, length),
            ),
            Uint8Array.from([...original.subarray(0, 25), 0x3b]),
            Uint8Array.from([...original.subarray(0, 25), 0x21, 0xfe, 20, 0, 0]),
            Uint8Array.from([...original.subarray(0, 25), 0x21, 0xfe, 1, 0x2c]),
            original.slice(),
        ];
    variants.at(-1)![4] = 57;
    variants.at(-1)![5] = 122;
    let calls = 0;
    globalThis.createImageBitmap = (async () => {
        calls++;
        throw Error('Unsafe native decoder entry');
    }) as typeof createImageBitmap;
    try {
        for (const bytes of variants)
            await assert.rejects(
                readArtwork({ size: bytes.length, arrayBuffer: async () => bytes.buffer }),
                /GIF/,
            );
        assert.equal(calls, 0);
    } finally {
        globalThis.createImageBitmap = native;
    }
});

test('cancellation during a long GIF extension prefix stops before native decoding', async () => {
    const bytes = new Uint8Array(1024 * 1024 + original.length),
        native = globalThis.createImageBitmap,
        now = Object.getOwnPropertyDescriptor(performance, 'now'),
        controller = new AbortController();
    bytes.set(original.subarray(0, 25));
    let position = 25;
    while (position + 258 <= bytes.length - (original.length - 25)) {
        bytes.set([0x21, 0xfe, 254], position);
        position += 257;
        bytes[position++] = 0;
    }
    bytes.set(original.subarray(25), position);
    const input = bytes.slice(0, position + original.length - 25);
    let calls = 0,
        clock = 0;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => (clock += 5) });
    globalThis.createImageBitmap = (async () => {
        calls++;
        throw Error('Unexpected decoder entry after cancellation');
    }) as typeof createImageBitmap;
    const timer = setTimeout(() => controller.abort(), 0);
    try {
        await assert.rejects(
            readArtwork({ size: input.length, arrayBuffer: async () => input.buffer }, controller.signal),
            { name: 'AbortError' },
        );
        assert.equal(calls, 0);
    } finally {
        clearTimeout(timer);
        globalThis.createImageBitmap = native;
        if (now) Object.defineProperty(performance, 'now', now);
        else Reflect.deleteProperty(performance, 'now');
    }
});
