import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cpus, platform, arch } from 'node:os';
import { composite, createState, type State } from '../src/engine/document';

// Frozen pre-optimization oracle; output allocation is included for both paths.
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

const rows = [];
for (const workload of ['opaque', 'mixed', 'transparent', 'translucent']) {
    const state = createState(1024, 1024, [0, 0, 0, 0]);
    state.layers.push({ name: 'upper', visible: true, pixels: new Uint8ClampedArray(1024 * 1024 * 4) });
    for (const layer of state.layers) {
        for (let i = 0; i < layer.pixels.length; i += 4) {
            const alpha =
                workload === 'opaque'
                    ? 255
                    : workload === 'transparent'
                      ? 0
                      : workload === 'translucent'
                        ? 128
                        : [0, 128, 255][(i / 4) % 3];
            layer.pixels.set([i & 255, (i >> 8) & 255, (i >> 16) & 255, alpha], i);
        }
    }
    assert.deepEqual(composite(state), reference(state));
    for (let warmup = 0; warmup < 5; warmup++) {
        reference(state);
        composite(state);
    }
    const baselineMs: number[] = [],
        optimizedMs: number[] = [];
    for (let sample = 0; sample < 21; sample++) {
        const methods =
            sample % 2
                ? ([
                      [composite, optimizedMs],
                      [reference, baselineMs],
                  ] as const)
                : ([
                      [reference, baselineMs],
                      [composite, optimizedMs],
                  ] as const);
        for (const [method, samples] of methods) {
            const start = performance.now();
            method(state);
            samples.push(performance.now() - start);
        }
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[10];
    rows.push({
        workload,
        baselineMs,
        optimizedMs,
        baselineMedianMs: median(baselineMs),
        optimizedMedianMs: median(optimizedMs),
    });
}
console.log(
    JSON.stringify(
        {
            node: process.version,
            platform: platform(),
            arch: arch(),
            cpu: cpus()[0]?.model,
            scope: 'Warm Node compositor only; shared host; 1024x1024 two visible layers; output allocation included; five warmups and 21 alternating-order samples. Not startup, RSS, UI latency or cross-platform acceptance.',
            rows,
        },
        null,
        2,
    ),
);
