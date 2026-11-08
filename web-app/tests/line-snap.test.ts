import assert from 'node:assert/strict';
import test from 'node:test';
import { snapLineDelta } from '../src/engine/operations';

test('line snapping has exact equal diagonal components in all four quadrants', () => {
    for (const [dx, dy] of [
        [20, 10],
        [10, 20],
        [-20, 10],
        [-10, 20],
        [-20, -10],
        [-10, -20],
        [20, -10],
        [10, -20],
    ]) {
        const result = snapLineDelta(dx, dy);
        assert.equal(Math.abs(result.x), Math.abs(result.y));
        assert.equal(Math.sign(result.x), Math.sign(dx));
        assert.equal(Math.sign(result.y), Math.sign(dy));
        assert(Math.abs(Math.hypot(result.x, result.y) - Math.hypot(dx, dy)) < 1e-12);
    }
});

test('cardinal snapping has exactly zero orthogonal displacement and preserves length', () => {
    for (const [dx, dy] of [
        [20, 1],
        [-20, 1],
        [1, 20],
        [1, -20],
    ]) {
        const result = snapLineDelta(dx, dy);
        if (Math.abs(dx) > Math.abs(dy)) {
            assert.equal(result.y, 0);
            assert.equal(result.x, Math.sign(dx) * Math.hypot(dx, dy));
        } else {
            assert.equal(result.x, 0);
            assert.equal(result.y, Math.sign(dy) * Math.hypot(dx, dy));
        }
    }
    assert.deepEqual(snapLineDelta(0, 0), { x: 0, y: 0 });
});

test('snapping preserves octant selection on either side of the 22.5 degree boundary', () => {
    for (let octant = 0; octant < 8; octant++) {
        for (const side of [-1, 1]) {
            const angle = ((octant + 0.5) * Math.PI) / 4 + side * 1e-8,
                result = snapLineDelta(Math.cos(angle) * 30, Math.sin(angle) * 30),
                selected = (octant + (side === 1 ? 1 : 0)) % 8,
                expectedX = [1, 1, 0, -1, -1, -1, 0, 1][selected],
                expectedY = [0, 1, 1, 1, 0, -1, -1, -1][selected];
            assert.equal(Math.sign(result.x), expectedX);
            assert.equal(Math.sign(result.y), expectedY);
            if (selected % 2) assert.equal(Math.abs(result.x), Math.abs(result.y));
        }
    }
});
