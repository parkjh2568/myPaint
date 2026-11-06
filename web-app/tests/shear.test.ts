import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, cloneState } from '../src/engine/document';
import { shearState } from '../src/engine/operations';

// Captured from Qt 6.12.0 QImage::transformed(QTransform().shear(tan(angle),0), FastTransformation).
// Positive 45 degrees duplicates a border texel in that rasterizer; the new nearest-row path preserves each source texel once.
const qtOracle = [
    {
        width: 3,
        height: 3,
        angle: -60,
        outWidth: 9,
        rgba: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAzMwBVZjMzqpkzZv8AAAAAAAAAAAAAAAAAAAAAM2YzqmZmZv+ZZplVAAAAAAAAAAAAAAAAAAAAAAAAAAAzmWb/ZpmZVZmZzKoAAAAAAAAAAAAAAAAAAAAA',
    },
    {
        width: 3,
        height: 3,
        angle: -45,
        outWidth: 6,
        rgba: 'AAAAAAAAAAAAAAAAMzMAVWYzM6qZM2b/AAAAAAAAAAAzZjOqZmZm/5lmmVUAAAAAAAAAADOZZv9mmZlVmZnMqgAAAAAAAAAA',
    },
    {
        width: 3,
        height: 3,
        angle: -30,
        outWidth: 5,
        rgba: 'AAAAAAAAAAAzMwBVZjMzqpkzZv8AAAAAM2YzqmZmZv+ZZplVAAAAAAAAAAAzmWb/ZpmZVZmZzKoAAAAA',
    },
    {
        width: 3,
        height: 3,
        angle: -0.1,
        outWidth: 4,
        rgba: 'AAAAADMzAFVmMzOqmTNm/wAAAAAzZjOqZmZm/5lmmVUAAAAAM5lm/2aZmVWZmcyq',
    },
    {
        width: 3,
        height: 3,
        angle: -1e-11,
        outWidth: 3,
        rgba: 'MzMAVWYzM6qZM2b/M2YzqmZmZv+ZZplVM5lm/2aZmVWZmcyq',
    },
    {
        width: 3,
        height: 3,
        angle: 0,
        outWidth: 3,
        rgba: 'MzMAVWYzM6qZM2b/M2YzqmZmZv+ZZplVM5lm/2aZmVWZmcyq',
    },
    {
        width: 3,
        height: 3,
        angle: 1e-11,
        outWidth: 3,
        rgba: 'MzMAVWYzM6qZM2b/M2YzqmZmZv+ZZplVM5lm/2aZmVWZmcyq',
    },
    {
        width: 3,
        height: 3,
        angle: 0.1,
        outWidth: 4,
        rgba: 'MzMAVWYzM6qZM2b/AAAAADNmM6pmZmb/mWaZVQAAAAAzmWb/ZpmZVZmZzKoAAAAA',
    },
    {
        width: 3,
        height: 3,
        angle: 30,
        outWidth: 5,
        rgba: 'MzMAVWYzM6qZM2b/AAAAAAAAAAAAAAAAM2YzqmZmZv+ZZplVAAAAAAAAAAAzmWb/ZpmZVZmZzKoAAAAA',
    },
    {
        width: 3,
        height: 3,
        angle: 60,
        outWidth: 9,
        rgba: 'AAAAADMzAFVmMzOqmTNm/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM2YzqmZmZv+ZZplVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADOZZv9mmZlVmZnMqgAAAAAAAAAA',
    },
    {
        width: 3,
        height: 4,
        angle: -60,
        outWidth: 10,
        rgba: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMzMAVWYzM6qZM2b/AAAAAAAAAAAAAAAAAAAAAAAAAAAzZjOqZmZm/5lmmVUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAzmWb/ZpmZVZmZzKoAAAAAAAAAAAAAAAAAAAAAAAAAADPMmVVmzMyqmcwA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
    },
    {
        width: 3,
        height: 4,
        angle: -45,
        outWidth: 7,
        rgba: 'AAAAAAAAAAAAAAAAAAAAADMzAFVmMzOqmTNm/wAAAAAAAAAAAAAAADNmM6pmZmb/mWaZVQAAAAAAAAAAAAAAADOZZv9mmZlVmZnMqgAAAAAAAAAAAAAAADPMmVVmzMyqmcwA/wAAAAAAAAAAAAAAAA==',
    },
    {
        width: 3,
        height: 4,
        angle: -30,
        outWidth: 6,
        rgba: 'AAAAAAAAAAAAAAAAMzMAVWYzM6qZM2b/AAAAAAAAAAAzZjOqZmZm/5lmmVUAAAAAAAAAAAAAAAAzmWb/ZpmZVZmZzKoAAAAAAAAAADPMmVVmzMyqmcwA/wAAAAAAAAAA',
    },
    {
        width: 3,
        height: 4,
        angle: -0.1,
        outWidth: 4,
        rgba: 'AAAAADMzAFVmMzOqmTNm/wAAAAAzZjOqZmZm/5lmmVUAAAAAM5lm/2aZmVWZmcyqAAAAADPMmVVmzMyqmcwA/w==',
    },
    {
        width: 3,
        height: 4,
        angle: -1e-11,
        outWidth: 3,
        rgba: 'MzMAVWYzM6qZM2b/M2YzqmZmZv+ZZplVM5lm/2aZmVWZmcyqM8yZVWbMzKqZzAD/',
    },
    {
        width: 3,
        height: 4,
        angle: 0,
        outWidth: 3,
        rgba: 'MzMAVWYzM6qZM2b/M2YzqmZmZv+ZZplVM5lm/2aZmVWZmcyqM8yZVWbMzKqZzAD/',
    },
    {
        width: 3,
        height: 4,
        angle: 1e-11,
        outWidth: 3,
        rgba: 'MzMAVWYzM6qZM2b/M2YzqmZmZv+ZZplVM5lm/2aZmVWZmcyqM8yZVWbMzKqZzAD/',
    },
    {
        width: 3,
        height: 4,
        angle: 0.1,
        outWidth: 4,
        rgba: 'MzMAVWYzM6qZM2b/AAAAADNmM6pmZmb/mWaZVQAAAAAzmWb/ZpmZVZmZzKoAAAAAM8yZVWbMzKqZzAD/AAAAAA==',
    },
    {
        width: 3,
        height: 4,
        angle: 30,
        outWidth: 6,
        rgba: 'MzMAVWYzM6qZM2b/AAAAAAAAAAAAAAAAAAAAADNmM6pmZmb/mWaZVQAAAAAAAAAAAAAAADOZZv9mmZlVmZnMqgAAAAAAAAAAAAAAAAAAAAAzzJlVZszMqpnMAP8AAAAA',
    },
    {
        width: 3,
        height: 4,
        angle: 60,
        outWidth: 10,
        rgba: 'AAAAADMzAFVmMzOqmTNm/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADNmM6pmZmb/mWaZVQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM5lm/2aZmVWZmcyqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM8yZVWbMzKqZzAD/AAAAAA==',
    },
    {
        width: 4,
        height: 3,
        angle: -60,
        outWidth: 10,
        rgba: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAzMwBVZjMzqpkzZv/MM5lVAAAAAAAAAAAAAAAAAAAAADNmM6pmZmb/mWaZVcxmzKoAAAAAAAAAAAAAAAAAAAAAAAAAADOZZv9mmZlVmZnMqsyZAP8AAAAAAAAAAAAAAAAAAAAA',
    },
    {
        width: 4,
        height: 3,
        angle: -45,
        outWidth: 7,
        rgba: 'AAAAAAAAAAAAAAAAMzMAVWYzM6qZM2b/zDOZVQAAAAAAAAAAM2YzqmZmZv+ZZplVzGbMqgAAAAAAAAAAM5lm/2aZmVWZmcyqzJkA/wAAAAAAAAAA',
    },
    {
        width: 4,
        height: 3,
        angle: -30,
        outWidth: 6,
        rgba: 'AAAAAAAAAAAzMwBVZjMzqpkzZv/MM5lVAAAAADNmM6pmZmb/mWaZVcxmzKoAAAAAAAAAADOZZv9mmZlVmZnMqsyZAP8AAAAA',
    },
    {
        width: 4,
        height: 3,
        angle: -0.1,
        outWidth: 5,
        rgba: 'AAAAADMzAFVmMzOqmTNm/8wzmVUAAAAAM2YzqmZmZv+ZZplVzGbMqgAAAAAzmWb/ZpmZVZmZzKrMmQD/',
    },
    {
        width: 4,
        height: 3,
        angle: -1e-11,
        outWidth: 4,
        rgba: 'MzMAVWYzM6qZM2b/zDOZVTNmM6pmZmb/mWaZVcxmzKozmWb/ZpmZVZmZzKrMmQD/',
    },
    {
        width: 4,
        height: 3,
        angle: 0,
        outWidth: 4,
        rgba: 'MzMAVWYzM6qZM2b/zDOZVTNmM6pmZmb/mWaZVcxmzKozmWb/ZpmZVZmZzKrMmQD/',
    },
    {
        width: 4,
        height: 3,
        angle: 1e-11,
        outWidth: 4,
        rgba: 'MzMAVWYzM6qZM2b/zDOZVTNmM6pmZmb/mWaZVcxmzKozmWb/ZpmZVZmZzKrMmQD/',
    },
    {
        width: 4,
        height: 3,
        angle: 0.1,
        outWidth: 5,
        rgba: 'MzMAVWYzM6qZM2b/zDOZVQAAAAAzZjOqZmZm/5lmmVXMZsyqAAAAADOZZv9mmZlVmZnMqsyZAP8AAAAA',
    },
    {
        width: 4,
        height: 3,
        angle: 30,
        outWidth: 6,
        rgba: 'MzMAVWYzM6qZM2b/zDOZVQAAAAAAAAAAAAAAADNmM6pmZmb/mWaZVcxmzKoAAAAAAAAAADOZZv9mmZlVmZnMqsyZAP8AAAAA',
    },
    {
        width: 4,
        height: 3,
        angle: 60,
        outWidth: 10,
        rgba: 'AAAAADMzAFVmMzOqmTNm/8wzmVUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADNmM6pmZmb/mWaZVcxmzKoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM5lm/2aZmVWZmcyqzJkA/wAAAAAAAAAA',
    },
    {
        width: 4,
        height: 4,
        angle: -60,
        outWidth: 11,
        rgba: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMzMAVWYzM6qZM2b/zDOZVQAAAAAAAAAAAAAAAAAAAAAAAAAAM2YzqmZmZv+ZZplVzGbMqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADOZZv9mmZlVmZnMqsyZAP8AAAAAAAAAAAAAAAAAAAAAAAAAADPMmVVmzMyqmcwA/8zMM1UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    },
    {
        width: 4,
        height: 4,
        angle: -45,
        outWidth: 8,
        rgba: 'AAAAAAAAAAAAAAAAAAAAADMzAFVmMzOqmTNm/8wzmVUAAAAAAAAAAAAAAAAzZjOqZmZm/5lmmVXMZsyqAAAAAAAAAAAAAAAAM5lm/2aZmVWZmcyqzJkA/wAAAAAAAAAAAAAAADPMmVVmzMyqmcwA/8zMM1UAAAAAAAAAAAAAAAA=',
    },
    {
        width: 4,
        height: 4,
        angle: -30,
        outWidth: 7,
        rgba: 'AAAAAAAAAAAAAAAAMzMAVWYzM6qZM2b/zDOZVQAAAAAAAAAAM2YzqmZmZv+ZZplVzGbMqgAAAAAAAAAAAAAAADOZZv9mmZlVmZnMqsyZAP8AAAAAAAAAADPMmVVmzMyqmcwA/8zMM1UAAAAAAAAAAA==',
    },
    {
        width: 4,
        height: 4,
        angle: -0.1,
        outWidth: 5,
        rgba: 'AAAAADMzAFVmMzOqmTNm/8wzmVUAAAAAM2YzqmZmZv+ZZplVzGbMqgAAAAAzmWb/ZpmZVZmZzKrMmQD/AAAAADPMmVVmzMyqmcwA/8zMM1U=',
    },
    {
        width: 4,
        height: 4,
        angle: -1e-11,
        outWidth: 4,
        rgba: 'MzMAVWYzM6qZM2b/zDOZVTNmM6pmZmb/mWaZVcxmzKozmWb/ZpmZVZmZzKrMmQD/M8yZVWbMzKqZzAD/zMwzVQ==',
    },
    {
        width: 4,
        height: 4,
        angle: 0,
        outWidth: 4,
        rgba: 'MzMAVWYzM6qZM2b/zDOZVTNmM6pmZmb/mWaZVcxmzKozmWb/ZpmZVZmZzKrMmQD/M8yZVWbMzKqZzAD/zMwzVQ==',
    },
    {
        width: 4,
        height: 4,
        angle: 1e-11,
        outWidth: 4,
        rgba: 'MzMAVWYzM6qZM2b/zDOZVTNmM6pmZmb/mWaZVcxmzKozmWb/ZpmZVZmZzKrMmQD/M8yZVWbMzKqZzAD/zMwzVQ==',
    },
    {
        width: 4,
        height: 4,
        angle: 0.1,
        outWidth: 5,
        rgba: 'MzMAVWYzM6qZM2b/zDOZVQAAAAAzZjOqZmZm/5lmmVXMZsyqAAAAADOZZv9mmZlVmZnMqsyZAP8AAAAAM8yZVWbMzKqZzAD/zMwzVQAAAAA=',
    },
    {
        width: 4,
        height: 4,
        angle: 30,
        outWidth: 7,
        rgba: 'MzMAVWYzM6qZM2b/zDOZVQAAAAAAAAAAAAAAAAAAAAAzZjOqZmZm/5lmmVXMZsyqAAAAAAAAAAAAAAAAM5lm/2aZmVWZmcyqzJkA/wAAAAAAAAAAAAAAAAAAAAAzzJlVZszMqpnMAP/MzDNVAAAAAA==',
    },
    {
        width: 4,
        height: 4,
        angle: 60,
        outWidth: 11,
        rgba: 'AAAAADMzAFVmMzOqmTNm/8wzmVUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAzZjOqZmZm/5lmmVXMZsyqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAzmWb/ZpmZVZmZzKrMmQD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM8yZVWbMzKqZzAD/zMwzVQAAAAA=',
    },
];

test('shear matches Qt Fast oracle pixels and bounds for 40 regular-angle fixtures', () => {
    for (const fixture of qtOracle) {
        const source = createState(fixture.width, fixture.height, [0, 0, 0, 0]);
        for (let y = 0; y < source.height; y++)
            for (let x = 0; x < source.width; x++)
                source.layers[0].pixels.set(
                    [51 * ((x + 1) % 5), 51 * ((y + 1) % 5), 51 * ((x + y) % 5), 85 * (((x + y) % 3) + 1)],
                    (y * source.width + x) * 4,
                );
        const result = shearState(source, fixture.angle);
        assert.deepEqual(
            [result.width, result.height],
            [fixture.outWidth, fixture.height],
            JSON.stringify(fixture),
        );
        assert.deepEqual(
            result.layers[0].pixels,
            new Uint8ClampedArray(Buffer.from(fixture.rgba, 'base64')),
            `Qt oracle ${fixture.width}x${fixture.height}, ${fixture.angle}°`,
        );
    }
});
test('positive 45-degree shear preserves all source RGBA once without clipping or border duplication', () => {
    const source = createState(3, 3, [0, 0, 0, 0]);
    const colors = [
        [7, 11, 213, 1],
        [33, 72, 195, 128],
        [201, 0, 41, 0],
    ];
    for (let y = 0; y < 3; y++)
        for (let x = 0; x < 3; x++) source.layers[0].pixels.set(colors[x], (y * 3 + x) * 4);
    const before = cloneState(source),
        result = shearState(source, 45);
    assert.equal(result.width, 6);
    assert.deepEqual(source, before);
    for (let y = 0; y < 3; y++) {
        const row = result.layers[0].pixels.subarray(y * result.width * 4, (y + 1) * result.width * 4);
        const expected: Uint8ClampedArray = new Uint8ClampedArray(result.width * 4);
        expected.set(before.layers[0].pixels.subarray(y * 12, (y + 1) * 12), y * 4);
        assert.deepEqual(row, expected);
    }
    result.layers[0].pixels.fill(0);
    assert.deepEqual(source, before);
});
test('negative shear expands left bounds and keeps layer metadata and independent pixels', () => {
    const source = createState(2, 3, [3, 9, 27, 85]);
    source.layers.push({ name: '숨김', visible: false, pixels: source.layers[0].pixels.slice() });
    source.active = 1;
    const before = cloneState(source),
        result = shearState(source, -45);
    assert.equal(result.width, 5);
    assert.equal(result.active, 1);
    assert.deepEqual(result.background, source.background);
    assert.equal(result.layers[1].name, '숨김');
    assert.equal(result.layers[1].visible, false);
    const shifts = [3, 2, 1];
    for (let y = 0; y < 3; y++)
        assert.deepEqual(
            result.layers[1].pixels.subarray((y * 5 + shifts[y]) * 4, (y * 5 + shifts[y] + 2) * 4),
            source.layers[1].pixels.subarray(y * 8, (y + 1) * 8),
        );
    result.layers[1].pixels[12] = 99;
    assert.deepEqual(source, before);
});
test('zero and fuzzy-zero shear preserve pixel values without shared mutable buffers', () => {
    const source = createState(4, 3, [17, 61, 89, 128]);
    for (const angle of [0, -0, 1e-11, -1e-11]) {
        const result = shearState(source, angle);
        assert.deepEqual(result, source);
        assert.notEqual(result.layers[0].pixels, source.layers[0].pixels);
    }
});
test('invalid angle, expanded dimension and aggregate limits reject without mutating source', () => {
    const source = createState(4096, 1, [0, 0, 0, 0]),
        before = cloneState(source);
    for (const angle of [NaN, Infinity, -Infinity, -61, 61])
        assert.throws(() => shearState(source, angle), /-60/);
    assert.throws(() => shearState(source, 1), /한도/);
    assert.deepEqual(source, before);
    const layers = createState(1024, 1024, [0, 0, 0, 0]);
    for (let i = 1; i < 6; i++)
        layers.layers.push({ name: `Layer ${i}`, visible: true, pixels: layers.layers[0].pixels.slice() });
    const oldBuffers = layers.layers.map((layer) => layer.pixels);
    assert.throws(() => shearState(layers, 1), /한도/);
    assert(
        layers.layers.every(
            (layer, i) => layer.pixels === oldBuffers[i] && layer.pixels.every((v) => v === 0),
        ),
    );
});
