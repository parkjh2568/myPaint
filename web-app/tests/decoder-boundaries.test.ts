import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePng, decodePng, decodeProject } from '../src/engine/format';
import { readArtwork } from '../src/platform/codec';
import { webLimits } from '../src/engine/document';

function project(width: number, height: number, layers: Uint8Array[]): Uint8Array {
    const bytes = new Uint8Array(28 + layers.reduce((sum, layer) => sum + 10 + layer.length, 0)),
        view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode('RPAINT01'));
    view.setUint32(8, width, true);
    view.setUint32(12, height, true);
    view.setUint32(16, layers.length, true);
    let position = 28;
    for (const layer of layers) {
        view.setUint32(position, 1, true);
        position += 4;
        bytes[position++] = 76;
        bytes[position++] = 1;
        view.setUint32(position, layer.length, true);
        position += 4;
        bytes.set(layer, position);
        position += layer.length;
    }
    return bytes;
}

for (const [width, height] of [
    [256, 128],
    [16, 4],
    [4, 16],
])
    test(`project rejects inner PNG ${width}x${height} before its pixel allocation`, () => {
        const good = encodePng(8, 8, new Uint8ClampedArray(8 * 8 * 4)),
            bad = encodePng(width, height, new Uint8ClampedArray(width * height * 4)),
            decoded = decodePng(bad),
            wire = project(8, 8, [good, bad]),
            padded = new Uint8Array(wire.length + 7),
            Original = Uint8ClampedArray,
            allocations: number[] = [];
        assert.equal(decoded.width, width);
        assert.equal(decoded.height, height);
        assert.equal(decodeProject(project(8, 8, [good, good])).layers.length, 2);
        padded.set(wire, 3);
        globalThis.Uint8ClampedArray = new Proxy(Original, {
            construct(target, args) {
                if (typeof args[0] === 'number') allocations.push(args[0]);
                return Reflect.construct(target, args);
            },
        });
        try {
            assert.throws(() => decodeProject(padded.subarray(3, 3 + wire.length)), /레이어 크기 불일치/);
        } finally {
            globalThis.Uint8ClampedArray = Original;
        }
        assert.deepEqual(
            allocations,
            [8 * 8 * 4],
            'Only the preceding valid layer may allocate decoded pixels',
        );
        assert.deepEqual(padded.subarray(3, 3 + wire.length), wire);
    });

test('project preflight preserves PNG validation for truncated and bad-CRC layers', () => {
    const png = encodePng(8, 8, new Uint8ClampedArray(8 * 8 * 4));
    for (const length of [1, 23, 24, 32])
        assert.throws(() => decodeProject(project(8, 8, [png.slice(0, length)])));
    const corrupt = png.slice();
    corrupt[29] ^= 1;
    assert.throws(() => decodeProject(project(8, 8, [corrupt])), /체크섬/);
});

test('the actual project Worker reports a mismatched layer without constructing its pixel buffer', async () => {
    const good = encodePng(8, 8, new Uint8ClampedArray(8 * 8 * 4)),
        bad = encodePng(256, 128, new Uint8ClampedArray(256 * 128 * 4)),
        originalPost = globalThis.postMessage,
        originalMessage = globalThis.onmessage,
        Original = Uint8ClampedArray,
        allocations: number[] = [],
        messages: { error?: string; profileId?: string; state?: unknown }[] = [];
    globalThis.postMessage = ((value: (typeof messages)[number]) =>
        messages.push(value)) as typeof postMessage;
    try {
        await import('../src/workers/codec.worker');
        globalThis.Uint8ClampedArray = new Proxy(Original, {
            construct(target, args) {
                if (typeof args[0] === 'number') allocations.push(args[0]);
                return Reflect.construct(target, args);
            },
        });
        const receive = globalThis.onmessage as unknown as (event: MessageEvent) => Promise<void>;
        await receive({
            data: { operation: 'project-read', bytes: project(8, 8, [good, bad]), profileId: 'web' },
        } as MessageEvent);
    } finally {
        globalThis.Uint8ClampedArray = Original;
        globalThis.postMessage = originalPost;
        globalThis.onmessage = originalMessage;
    }
    assert.deepEqual(allocations, [8 * 8 * 4]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].profileId, 'web');
    assert.match(messages[0].error || '', /레이어 크기 불일치/);
    assert.equal(messages[0].state, undefined);
});

test('invalid or excessive declared file sizes reject before reading bytes', async () => {
    let reads = 0;
    for (const size of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, webLimits.inputBytes + 1])
        await assert.rejects(
            readArtwork({
                size,
                arrayBuffer: async () => {
                    reads++;
                    return new ArrayBuffer(0);
                },
            }),
        );
    assert.equal(reads, 0);
});

test('actual file bytes must match the captured size before native decoding', async () => {
    const bytes = Uint8Array.from(
            Buffer.from(
                'R0lGODlhCAAGAIEAAAAAAP8AAAD/AAAA/yH5BAQCAAAALAAAAAAIAAYAAAIlDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwBQA7',
                'base64',
            ),
        ),
        original = globalThis.createImageBitmap;
    let decoderCalls = 0,
        sizeReads = 0;
    globalThis.createImageBitmap = (async () => {
        decoderCalls++;
        throw Error('native decoder reached');
    }) as typeof createImageBitmap;
    try {
        await assert.rejects(
            readArtwork({
                get size() {
                    return ++sizeReads === 1 ? 8 : bytes.length;
                },
                arrayBuffer: async () => bytes.buffer,
            }),
            /파일 정보와 일치/,
        );
        assert.equal(sizeReads, 1);
        assert.equal(decoderCalls, 0);
        await assert.rejects(
            readArtwork({ size: bytes.length, arrayBuffer: async () => bytes.buffer }),
            /native decoder reached/,
        );
        assert.equal(decoderCalls, 1);
    } finally {
        globalThis.createImageBitmap = original;
    }
});

test('read cancellation wins before descriptor access and after byte acquisition', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    let accesses = 0;
    await assert.rejects(
        readArtwork(
            {
                get size() {
                    accesses++;
                    return 13;
                },
                arrayBuffer: async () => {
                    accesses++;
                    return new ArrayBuffer(13);
                },
            },
            cancelled.signal,
        ),
        { name: 'AbortError' },
    );
    assert.equal(accesses, 0);
    const duringRead = new AbortController();
    await assert.rejects(
        readArtwork(
            {
                size: 13,
                arrayBuffer: async () => {
                    duringRead.abort();
                    return new ArrayBuffer(13);
                },
            },
            duringRead.signal,
        ),
        { name: 'AbortError' },
    );
});
