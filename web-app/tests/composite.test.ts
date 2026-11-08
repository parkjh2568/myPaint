import assert from 'node:assert/strict';
import test from 'node:test';
import { composite, createState, type State } from '../src/engine/document';

// Preserve the previous compositor as an independent byte-for-byte oracle.
function reference(state: State): Uint8ClampedArray {
    const out = new Uint8ClampedArray(state.width * state.height * 4);
    for (const layer of state.layers)
        if (layer.visible)
            for (let i = 0; i < out.length; i += 4) {
                const alpha = layer.pixels[i + 3] / 255;
                if (alpha === 0) continue;
                const old = out[i + 3] / 255,
                    next = alpha + old * (1 - alpha);
                for (let channel = 0; channel < 3; channel++)
                    out[i + channel] = Math.round(
                        (layer.pixels[i + channel] * alpha + out[i + channel] * old * (1 - alpha)) / next,
                    );
                out[i + 3] = Math.round(next * 255);
            }
    return out;
}

test('composite preserves exact bytes for every pair of alpha values and mixed layers', () => {
    const state = createState(256, 256, [0, 0, 0, 0]);
    state.layers.push({ name: 'upper', visible: true, pixels: new Uint8ClampedArray(256 * 256 * 4) });
    for (let lower = 0; lower < 256; lower++)
        for (let upper = 0; upper < 256; upper++) {
            const i = (lower * 256 + upper) * 4;
            state.layers[0].pixels.set([lower, upper, (lower * 37 + upper) & 255, lower], i);
            state.layers[1].pixels.set([255 - upper, 255 - lower, (upper * 73 + lower) & 255, upper], i);
        }
    const originals = state.layers.map((layer) => layer.pixels.slice());
    assert.deepEqual(composite(state), reference(state));
    state.layers.push({ name: 'third', visible: true, pixels: originals[0].slice().reverse() });
    assert.deepEqual(composite(state), reference(state));
    state.layers[1].visible = false;
    assert.deepEqual(composite(state), reference(state));
    assert.deepEqual(state.layers[0].pixels, originals[0]);
    assert.deepEqual(state.layers[1].pixels, originals[1]);
});

test('opaque pixels replace prior color while transparent hidden RGB remains unpainted', () => {
    const state = createState(3, 1, [0, 0, 0, 0]);
    state.layers[0].pixels.set([17, 83, 201, 0, 30, 70, 90, 128, 90, 40, 20, 255]);
    state.layers.push({
        name: 'upper',
        visible: true,
        pixels: Uint8ClampedArray.from([99, 88, 77, 0, 5, 6, 7, 255, 11, 12, 13, 0]),
    });
    assert.deepEqual(Array.from(composite(state)), [0, 0, 0, 0, 5, 6, 7, 255, 90, 40, 20, 255]);
    const result = composite(state);
    result.fill(255);
    assert.equal(state.layers[1].pixels[0], 99);
    state.layers.forEach((layer) => {
        layer.visible = false;
    });
    assert.deepEqual(composite(state), new Uint8ClampedArray(12));
});
