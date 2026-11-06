import { type State, type Color, type ResourceProfile, webLimits, validate, validateSize } from './document';
export type GeometryChange =
    | { kind: 'resize'; width: number; height: number; scale?: boolean; smooth?: boolean }
    | { kind: 'transform'; operation: string }
    | { kind: 'shear'; angle: number }
    | { kind: 'crop'; x: number; y: number; width: number; height: number };
export function polygonMask(
    points: readonly { x: number; y: number }[],
    left: number,
    top: number,
    width: number,
    height: number,
    profile: ResourceProfile = webLimits,
): Uint8Array {
    validateSize(width, height, 1, profile);
    const coordinateLimit = 8388607;
    if (
        !Number.isInteger(left) ||
        !Number.isInteger(top) ||
        Math.abs(left) + width > coordinateLimit ||
        Math.abs(top) + height > coordinateLimit
    )
        throw Error('선택 경로 좌표가 너무 큽니다.');
    let vertices = points,
        needsClip = false;
    for (const point of points) {
        const x = Math.floor(point.x),
            y = Math.floor(point.y);
        if (
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            Math.max(Math.abs(x), Math.abs(y)) > coordinateLimit
        )
            throw Error('선택 경로 좌표가 너무 큽니다.');
        if (x < left - 1024 || x > left + width + 1024 || y < top - 1024 || y > top + height + 1024)
            needsClip = true;
    }
    if (needsClip) {
        vertices = points.map((point) => ({ x: Math.floor(point.x), y: Math.floor(point.y) }));
        // The legacy rasterizer clips distant paths before quantizing their new intersections.
        for (const [axis, bound, minimum] of [
            ['x', left, true],
            ['x', left + width, false],
            ['y', top, true],
            ['y', top + height, false],
        ] as const) {
            const clipped: { x: number; y: number }[] = [];
            for (let i = 0; i < vertices.length; i++) {
                const a = vertices[i],
                    b = vertices[(i + 1) % vertices.length],
                    aInside = minimum ? a[axis] >= bound : a[axis] <= bound,
                    bInside = minimum ? b[axis] >= bound : b[axis] <= bound;
                if (aInside) clipped.push(a);
                if (aInside !== bInside) {
                    const ratio = (bound - a[axis]) / (b[axis] - a[axis]),
                        intersection = { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
                    intersection[axis] = bound;
                    clipped.push(intersection);
                }
            }
            vertices = clipped;
        }
    }
    const edges: { top: number; bottom: number; x: number; step: number }[] = [];
    for (let i = 0; i < vertices.length; i++) {
        const a = vertices[i],
            b = vertices[(i + 1) % vertices.length];
        let ax = needsClip ? Math.round((a.x - left) * 64) + left * 64 : Math.floor(a.x) * 64,
            ay = needsClip ? Math.round((a.y - top) * 64) + top * 64 : Math.floor(a.y) * 64,
            bx = needsClip ? Math.round((b.x - left) * 64) + left * 64 : Math.floor(b.x) * 64,
            by = needsClip ? Math.round((b.y - top) * 64) + top * 64 : Math.floor(b.y) * 64;
        if (ay > by) {
            [ax, bx] = [bx, ax];
            [ay, by] = [by, ay];
        }
        const first = Math.max(top, Math.floor((ay + 32) / 64)),
            end = Math.min(top + height, Math.floor((by - 32) / 64) + 1);
        if (first >= end) continue;
        // Keep aliased edge quantization; floating intersections change boundary pixels.
        const step = Math.trunc(((bx - ax) * 65536) / (by - ay)),
            x = ax * 1024 + 32768 + Math.floor(step * (first + 0.5 - ay / 64));
        edges.push({ top: first, bottom: end, x, step });
    }
    const mask = new Uint8Array(width * height),
        active: typeof edges = [];
    edges.sort((a, b) => a.top - b.top);
    let next = 0,
        columns: Uint8Array | undefined;
    for (let y = edges[0]?.top ?? top; y < top + height && (next < edges.length || active.length); y++) {
        while (next < edges.length && edges[next].top === y) active.push(edges[next++]);
        // Dense even-odd crossings share integer columns; odd counts retain the pair fallback.
        if (active.length >= 64 && active.length >= width / 2 && active.length % 2 === 0) {
            columns ||= new Uint8Array(width + 1);
            columns.fill(0);
            for (const edge of active) {
                const column = Math.max(0, Math.min(width, Math.floor(edge.x / 65536) - left));
                columns[column] ^= 1;
            }
            let start = -1;
            for (let x = 0; x <= width; x++)
                if (columns[x]) {
                    if (start < 0) start = x;
                    else {
                        mask.fill(255, (y - top) * width + start, (y - top) * width + x);
                        start = -1;
                    }
                }
        } else {
            active.sort((a, b) => a.x - b.x);
            for (let i = 0; i + 1 < active.length; i += 2) {
                const start = Math.max(0, Math.floor(active[i].x / 65536) - left),
                    end = Math.min(width, Math.floor(active[i + 1].x / 65536) - left);
                if (end > start) mask.fill(255, (y - top) * width + start, (y - top) * width + end);
            }
        }
        let retained = 0;
        for (const edge of active)
            if (edge.bottom > y + 1) {
                edge.x += edge.step;
                active[retained++] = edge;
            }
        active.length = retained;
    }
    return mask;
}
// Mutates only the caller-owned selection candidate; stored RGB remains unquantized.
export function applySelectionMask(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
    left: number,
    top: number,
    path: readonly { x: number; y: number }[] | undefined,
    key: Color,
    transparent: boolean,
    profile: ResourceProfile = webLimits,
): Uint8Array | undefined {
    validateSize(width, height, 1, profile);
    if (
        !(pixels instanceof Uint8ClampedArray) ||
        pixels.length !== width * height * 4 ||
        !Array.isArray(key) ||
        key.length !== 4 ||
        key.some((value) => !Number.isInteger(value) || value < 0 || value > 255) ||
        typeof transparent !== 'boolean'
    )
        throw Error('선택 영역 입력이 올바르지 않습니다.');
    const mask = path ? polygonMask(path, left, top, width, height, profile) : undefined,
        keyRed = Math.round((key[0] * key[3]) / 255),
        keyGreen = Math.round((key[1] * key[3]) / 255),
        keyBlue = Math.round((key[2] * key[3]) / 255);
    for (let i = 0; i < pixels.length; i += 4) {
        if (mask && !mask[i / 4]) pixels[i + 3] = 0;
        // Match the legacy premultiplied key without quantizing stored RGB.
        if (
            transparent &&
            pixels[i + 3] === key[3] &&
            Math.round((pixels[i] * key[3]) / 255) === keyRed &&
            Math.round((pixels[i + 1] * key[3]) / 255) === keyGreen &&
            Math.round((pixels[i + 2] * key[3]) / 255) === keyBlue
        )
            pixels[i + 3] = 0;
    }
    return mask;
}
// The caller retains an unchanged source until completion; yielded candidates stay private.
export function* resizeNearestSteps(
    state: State,
    width: number,
    height: number,
    profile: ResourceProfile = webLimits,
): Generator<void, State, unknown> {
    validate(state, profile);
    validateSize(width, height, state.layers.length, profile);
    const result: State = { ...state, width, height, layers: [] },
        xIndices = new Int32Array(width),
        rows = Math.max(1, Math.floor(65536 / width));
    for (let x = 0; x < width; x++)
        // Qt FastTransformation chooses the lower index at exact pixel boundaries.
        xIndices[x] = Math.ceil(((2 * x + 1) * state.width) / (2 * width)) - 1;
    yield;
    for (const l of state.layers) {
        const pixels = new Uint8ClampedArray(width * height * 4);
        const sourceWords =
                l.pixels.byteOffset % 4 === 0
                    ? new Uint32Array(l.pixels.buffer, l.pixels.byteOffset, l.pixels.length / 4)
                    : undefined,
            targetWords = sourceWords ? new Uint32Array(pixels.buffer) : undefined;
        let previousSourceRow = -1;
        for (let y = 0; y < height; y++) {
            const sourceRow = (Math.ceil(((2 * y + 1) * state.height) / (2 * height)) - 1) * state.width,
                targetRow = y * width;
            if (sourceRow === previousSourceRow)
                pixels.copyWithin(targetRow * 4, (targetRow - width) * 4, targetRow * 4);
            else if (width === state.width)
                pixels.set(l.pixels.subarray(sourceRow * 4, (sourceRow + width) * 4), targetRow * 4);
            else if (width === state.width * 2 && sourceWords && targetWords) {
                for (let x = 0; x < state.width; x++) {
                    const word = sourceWords[sourceRow + x],
                        i = targetRow + x * 2;
                    targetWords[i] = word;
                    targetWords[i + 1] = word;
                }
            } else if (sourceWords && targetWords)
                for (let x = 0; x < width; x++)
                    targetWords[targetRow + x] = sourceWords[sourceRow + xIndices[x]];
            else
                for (let x = 0; x < width; x++) {
                    const i = (targetRow + x) * 4,
                        j = (sourceRow + xIndices[x]) * 4;
                    pixels[i] = l.pixels[j];
                    pixels[i + 1] = l.pixels[j + 1];
                    pixels[i + 2] = l.pixels[j + 2];
                    pixels[i + 3] = l.pixels[j + 3];
                }
            previousSourceRow = sourceRow;
            if ((y + 1) % rows === 0 || y + 1 === height) yield;
        }
        result.layers.push({ ...l, pixels });
    }
    return result;
}
export function resizeState(
    state: State,
    width: number,
    height: number,
    scale = false,
    smooth = false,
    profile: ResourceProfile = webLimits,
): State {
    if (scale && !smooth) {
        const steps = resizeNearestSteps(state, width, height, profile);
        let step = steps.next();
        while (!step.done) step = steps.next();
        return step.value;
    }
    validate(state, profile);
    validateSize(width, height, state.layers.length, profile);
    const result: State = { ...state, width, height, layers: [] };
    for (let n = 0; n < state.layers.length; n++) {
        const l = state.layers[n];
        let pixels: Uint8ClampedArray;
        if (scale) {
            pixels = new Uint8ClampedArray(width * height * 4);
            for (let y = 0; y < height; y++)
                for (let x = 0; x < width; x++) {
                    const i = (y * width + x) * 4;
                    const sx = ((x + 0.5) * state.width) / width - 0.5,
                        sy = ((y + 0.5) * state.height) / height - 0.5;
                    let alpha = 0;
                    const color = [0, 0, 0];
                    for (let yy = 0; yy < 2; yy++)
                        for (let xx = 0; xx < 2; xx++) {
                            const px = Math.max(0, Math.min(state.width - 1, Math.floor(sx) + xx)),
                                py = Math.max(0, Math.min(state.height - 1, Math.floor(sy) + yy)),
                                j = (py * state.width + px) * 4,
                                w =
                                    (xx ? sx - Math.floor(sx) : 1 - sx + Math.floor(sx)) *
                                    (yy ? sy - Math.floor(sy) : 1 - sy + Math.floor(sy)),
                                a = l.pixels[j + 3] / 255;
                            alpha += a * w;
                            for (let c = 0; c < 3; c++) color[c] += l.pixels[j + c] * a * w;
                        }
                    for (let c = 0; c < 3; c++) pixels[i + c] = alpha ? Math.round(color[c] / alpha) : 0;
                    pixels[i + 3] = Math.round(alpha * 255);
                }
        } else {
            pixels = new Uint8ClampedArray(width * height * 4);
            if (n === 0) {
                const color = new Uint32Array(new Uint8ClampedArray(state.background).buffer)[0];
                if (color) new Uint32Array(pixels.buffer).fill(color);
            }
            for (let y = 0; y < Math.min(height, state.height); y++)
                pixels.set(
                    l.pixels.subarray(
                        y * state.width * 4,
                        (y * state.width + Math.min(width, state.width)) * 4,
                    ),
                    y * width * 4,
                );
        }
        result.layers.push({ ...l, pixels });
    }
    return result;
}
export function cropState(
    state: State,
    x: number,
    y: number,
    width: number,
    height: number,
    profile: ResourceProfile = webLimits,
): State {
    validate(state, profile);
    validateSize(width, height, state.layers.length, profile);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) throw Error('자르기 좌표가 올바르지 않습니다.');
    const left = Math.max(0, x),
        top = Math.max(0, y),
        right = Math.min(state.width, x + width),
        bottom = Math.min(state.height, y + height);
    return {
        ...state,
        width,
        height,
        layers: state.layers.map((layer, index) => {
            const pixels = new Uint8ClampedArray(width * height * 4);
            if (index === 0) {
                const color = new Uint32Array(new Uint8ClampedArray(state.background).buffer)[0];
                if (color) new Uint32Array(pixels.buffer).fill(color);
            }
            if (right > left)
                for (let row = top; row < bottom; row++) {
                    pixels.set(
                        layer.pixels.subarray(
                            (row * state.width + left) * 4,
                            (row * state.width + right) * 4,
                        ),
                        ((row - y) * width + left - x) * 4,
                    );
                }
            return { ...layer, pixels };
        }),
    };
}
export function transformState(state: State, operation: string, profile: ResourceProfile = webLimits): State {
    validate(state, profile);
    if (!['rotate-left', 'rotate-right', 'flip-x', 'flip-y'].includes(operation))
        throw Error('지원하지 않는 변형입니다.');
    const rotate = operation === 'rotate-left' || operation === 'rotate-right',
        width = rotate ? state.height : state.width,
        height = rotate ? state.width : state.height;
    validateSize(width, height, state.layers.length, profile);
    return {
        ...state,
        width,
        height,
        layers: state.layers.map((l) => {
            const pixels = new Uint8ClampedArray(l.pixels.length);
            for (let y = 0; y < state.height; y++)
                for (let x = 0; x < state.width; x++) {
                    const nx =
                            operation === 'flip-x'
                                ? state.width - x - 1
                                : operation === 'rotate-right'
                                  ? state.height - y - 1
                                  : operation === 'rotate-left'
                                    ? y
                                    : x,
                        ny =
                            operation === 'flip-y'
                                ? state.height - y - 1
                                : operation === 'rotate-right'
                                  ? x
                                  : operation === 'rotate-left'
                                    ? state.width - x - 1
                                    : y;
                    pixels.set(
                        l.pixels.subarray((y * state.width + x) * 4, (y * state.width + x) * 4 + 4),
                        (ny * width + nx) * 4,
                    );
                }
            return { ...l, pixels };
        }),
    };
}
export function shearState(state: State, angleDegrees: number, profile: ResourceProfile = webLimits): State {
    if (!Number.isFinite(angleDegrees) || angleDegrees < -60 || angleDegrees > 60)
        throw Error('기울기는 -60도에서 60도 사이여야 합니다.');
    validate(state, profile);
    let factor = Math.tan((angleDegrees * Math.PI) / 180);
    if (Math.abs(factor) <= 1e-12) factor = 0;
    const width = Math.ceil(state.width + Math.abs(factor) * state.height),
        height = state.height,
        offset = factor < 0 ? Math.ceil(-factor * height) : 0;
    validateSize(width, height, state.layers.length, profile);
    return {
        ...state,
        width,
        height,
        background: [...state.background],
        layers: state.layers.map((layer) => {
            const pixels = new Uint8ClampedArray(width * height * 4);
            for (let y = 0; y < height; y++) {
                const shift = offset + Math.round(factor * (y + 0.5));
                pixels.set(
                    layer.pixels.subarray(y * state.width * 4, (y + 1) * state.width * 4),
                    (y * width + shift) * 4,
                );
            }
            return { ...layer, pixels };
        }),
    };
}
export function flood(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
    x: number,
    y: number,
    color: Color,
    profile: ResourceProfile = webLimits,
): { left: number; top: number; width: number; height: number; pixels: Uint8ClampedArray } | undefined {
    validateSize(width, height, 1, profile);
    if (pixels.length !== width * height * 4) throw Error('픽셀 크기 불일치');
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const start = (y * width + x) * 4,
        keyAlpha = pixels[start + 3],
        keyRed = Math.round((pixels[start] * keyAlpha) / 255),
        keyGreen = Math.round((pixels[start + 1] * keyAlpha) / 255),
        keyBlue = Math.round((pixels[start + 2] * keyAlpha) / 255);
    // Match legacy premultiplied keys while retaining straight RGB outside the filled region.
    if (
        color[3] === keyAlpha &&
        Math.round((color[0] * keyAlpha) / 255) === keyRed &&
        Math.round((color[1] * keyAlpha) / 255) === keyGreen &&
        Math.round((color[2] * keyAlpha) / 255) === keyBlue
    )
        return;
    const visited = new Uint8Array(width * height),
        stack = new Int32Array(width * height);
    let stackSize = 1;
    stack[0] = y * width + x;
    visited[stack[0]] = 2;
    let left = x,
        right = x,
        top = y,
        bottom = y;
    while (stackSize) {
        const p = stack[--stackSize];
        if (visited[p] === 1) continue;
        const py = Math.floor(p / width),
            px = p % width;
        let lo = px,
            hi = px;
        while (
            lo > 0 &&
            visited[py * width + lo - 1] !== 1 &&
            pixels[(py * width + lo - 1) * 4 + 3] === keyAlpha &&
            (keyAlpha === 0 ||
                (keyAlpha === 255
                    ? pixels[(py * width + lo - 1) * 4] === keyRed &&
                      pixels[(py * width + lo - 1) * 4 + 1] === keyGreen &&
                      pixels[(py * width + lo - 1) * 4 + 2] === keyBlue
                    : Math.round((pixels[(py * width + lo - 1) * 4] * keyAlpha) / 255) === keyRed &&
                      Math.round((pixels[(py * width + lo - 1) * 4 + 1] * keyAlpha) / 255) === keyGreen &&
                      Math.round((pixels[(py * width + lo - 1) * 4 + 2] * keyAlpha) / 255) === keyBlue))
        )
            lo--;
        while (
            hi + 1 < width &&
            visited[py * width + hi + 1] !== 1 &&
            pixels[(py * width + hi + 1) * 4 + 3] === keyAlpha &&
            (keyAlpha === 0 ||
                (keyAlpha === 255
                    ? pixels[(py * width + hi + 1) * 4] === keyRed &&
                      pixels[(py * width + hi + 1) * 4 + 1] === keyGreen &&
                      pixels[(py * width + hi + 1) * 4 + 2] === keyBlue
                    : Math.round((pixels[(py * width + hi + 1) * 4] * keyAlpha) / 255) === keyRed &&
                      Math.round((pixels[(py * width + hi + 1) * 4 + 1] * keyAlpha) / 255) === keyGreen &&
                      Math.round((pixels[(py * width + hi + 1) * 4 + 2] * keyAlpha) / 255) === keyBlue))
        )
            hi++;
        let aboveRun = false,
            belowRun = false;
        for (let xx = lo; xx <= hi; xx++) {
            const index = py * width + xx;
            if (visited[index] === 1) continue;
            visited[index] = 1;
            for (const dy of [-1, 1]) {
                const ny = py + dy,
                    np = ny * width + xx;
                const match =
                        ny >= 0 &&
                        ny < height &&
                        visited[np] !== 1 &&
                        pixels[np * 4 + 3] === keyAlpha &&
                        (keyAlpha === 0 ||
                            (keyAlpha === 255
                                ? pixels[np * 4] === keyRed &&
                                  pixels[np * 4 + 1] === keyGreen &&
                                  pixels[np * 4 + 2] === keyBlue
                                : Math.round((pixels[np * 4] * keyAlpha) / 255) === keyRed &&
                                  Math.round((pixels[np * 4 + 1] * keyAlpha) / 255) === keyGreen &&
                                  Math.round((pixels[np * 4 + 2] * keyAlpha) / 255) === keyBlue)),
                    run = dy === -1 ? aboveRun : belowRun;
                if (match && !run && visited[np] === 0) {
                    visited[np] = 2;
                    stack[stackSize++] = np;
                }
                if (dy === -1) aboveRun = match;
                else belowRun = match;
            }
        }
        left = Math.min(left, lo);
        right = Math.max(right, hi);
        top = Math.min(top, py);
        bottom = Math.max(bottom, py);
    }
    const w = right - left + 1,
        h = bottom - top + 1,
        data = new Uint8ClampedArray(w * h * 4);
    const words = new Uint32Array(data.buffer),
        replacement = new Uint32Array(new Uint8ClampedArray(color).buffer)[0];
    for (let yy = 0; yy < h; yy++) {
        const row = (top + yy) * width + left,
            marks = visited.subarray(row, row + w);
        let first = marks.indexOf(1),
            end = first < 0 ? -1 : marks.indexOf(0, first);
        if (first === 0 && end < 0) {
            words.fill(replacement, yy * w, (yy + 1) * w);
            continue;
        }
        data.set(pixels.subarray(row * 4, (row + w) * 4), yy * w * 4);
        // All queued pixels are processed; marks now contain only 0 or 1.
        while (first >= 0) {
            if (end < 0) end = w;
            words.fill(replacement, yy * w + first, yy * w + end);
            first = marks.indexOf(1, end);
            end = first < 0 ? -1 : marks.indexOf(0, first);
        }
    }
    return { left, top, width: w, height: h, pixels: data };
}
