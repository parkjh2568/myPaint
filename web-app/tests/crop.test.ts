import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, cloneState, desktopLimits } from '../src/engine/document';
import { cropState } from '../src/engine/operations';

test('crop copies exact source bytes and fills only exposed bottom-layer pixels from document background', () => {
    const source = createState(5, 4, [19, 31, 83, 128]);
    source.layers[0].name = '바닥';
    source.layers.push({ name: 'hidden', visible: false, pixels: new Uint8ClampedArray(5 * 4 * 4) });
    source.active = 1;
    for (let l = 0; l < 2; l++)
        for (let i = 0; i < source.layers[l].pixels.length; i++)
            source.layers[l].pixels[i] = (i * 29 + l * 17) % 256;
    const original = cloneState(source);
    for (const [x, y, width, height] of [
        [1, 1, 3, 2],
        [-2, -1, 8, 7],
        [4, 3, 3, 3],
        [-20, -20, 2, 2],
        [20, 20, 2, 2],
        [0, 0, 5, 4],
    ]) {
        const result = cropState(source, x, y, width, height);
        assert.equal(result.active, 1);
        assert.deepEqual(result.background, source.background);
        for (let l = 0; l < 2; l++) {
            assert.notEqual(result.layers[l].pixels, source.layers[l].pixels);
            assert.equal(result.layers[l].name, source.layers[l].name);
            assert.equal(result.layers[l].visible, source.layers[l].visible);
            for (let py = 0; py < height; py++)
                for (let px = 0; px < width; px++) {
                    const sx = x + px,
                        sy = y + py,
                        expected =
                            sx >= 0 && sx < source.width && sy >= 0 && sy < source.height
                                ? source.layers[l].pixels.subarray(
                                      (sy * source.width + sx) * 4,
                                      (sy * source.width + sx + 1) * 4,
                                  )
                                : l === 0
                                  ? source.background
                                  : [0, 0, 0, 0];
                    assert.deepEqual(
                        Array.from(
                            result.layers[l].pixels.subarray(
                                (py * width + px) * 4,
                                (py * width + px + 1) * 4,
                            ),
                        ),
                        Array.from(expected),
                        `${x},${y} layer${l} destination${px},${py}`,
                    );
                }
        }
    }
    assert.deepEqual(source, original);
});

test('crop preserves hidden RGB under alpha zero in copied and exposed pixels', () => {
    const source = createState(2, 1, [37, 59, 61, 0]);
    source.layers[0].pixels.set([11, 22, 33, 0, 44, 55, 66, 0]);
    assert.deepEqual(
        Array.from(cropState(source, -1, 0, 4, 1).layers[0].pixels),
        [37, 59, 61, 0, 11, 22, 33, 0, 44, 55, 66, 0, 37, 59, 61, 0],
    );
});

test('crop rejects non-integer coordinates and profile-overflow dimensions without mutating input', () => {
    const source = createState(3, 2),
        original = cloneState(source);
    for (const coordinate of [NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => cropState(source, coordinate, 0, 1, 1));
        assert.throws(() => cropState(source, 0, coordinate, 1, 1));
    }
    for (const size of [0, -1, 0.5, Infinity, 32769])
        assert.throws(() => cropState(source, 0, 0, size, 1, desktopLimits));
    assert.throws(() => cropState(source, 0, 0, 4096, 4096));
    assert.deepEqual(source, original);
    assert.equal(cropState(source, 0, 0, 32768, 1, desktopLimits).width, 32768);
});

test('shipped geometry Worker applies crop with explicit resource profile and rejects malformed input', async () => {
    const scope = globalThis as unknown as {
        onmessage?: (event: MessageEvent) => Promise<void>;
        postMessage?: (result: unknown) => void;
    };
    const previousHandler = scope.onmessage,
        previousPost = scope.postMessage;
    const source = createState(4, 3, [12, 19, 23, 255]);
    source.layers[0].pixels.set([51, 52, 53, 0], 20);
    let response: { state?: typeof source; error?: string; profileId?: string } | undefined;
    scope.postMessage = (value) => {
        response = value as typeof response;
    };
    try {
        await import('../src/workers/codec.worker');
        await scope.onmessage!({
            data: {
                operation: 'geometry',
                profileId: 'web',
                state: cloneState(source),
                bytes: new TextEncoder().encode(
                    JSON.stringify({ kind: 'crop', x: -1, y: 1, width: 6, height: 3 }),
                ),
            },
        } as MessageEvent);
        assert.equal(response?.profileId, 'web');
        assert.deepEqual(response?.state, cropState(source, -1, 1, 6, 3));
        await scope.onmessage!({
            data: {
                operation: 'geometry',
                profileId: 'web',
                state: cloneState(source),
                bytes: new TextEncoder().encode(
                    JSON.stringify({ kind: 'crop', x: '0', y: 0, width: 2, height: 2 }),
                ),
            },
        } as MessageEvent);
        assert.match(response?.error || '', /좌표/);
    } finally {
        scope.onmessage = previousHandler;
        scope.postMessage = previousPost;
    }
});
