const rasterNumberBits = new DataView(new ArrayBuffer(8));

// Geometry needs one rounding for multiply-add at clip and scanline boundaries.
// Raster coordinates are finite and bounded; the exact integer sum stays in the normal float range.
function rasterMultiplyAdd(x: number, y: number, z: number): number {
    const product = x * y;
    if (!x || !y || !z) return product + z;
    if (
        Number.isInteger(x) &&
        Number.isInteger(y) &&
        Number.isInteger(z) &&
        Math.abs(product) + Math.abs(z) <= Number.MAX_SAFE_INTEGER
    )
        return product + z;
    let multiplied = 1n,
        multipliedPower = 0,
        added = 0n,
        addedPower = 0;
    for (let part = 0; part < 3; part++) {
        rasterNumberBits.setFloat64(0, part === 0 ? x : part === 1 ? y : z);
        const bits = rasterNumberBits.getBigUint64(0),
            exponent = Number((bits >> 52n) & 0x7ffn),
            fraction = (bits & 0xfffffffffffffn) | (exponent ? 0x10000000000000n : 0n),
            signed = bits >> 63n ? -fraction : fraction,
            power = exponent ? exponent - 1075 : -1074;
        if (part < 2) {
            multiplied *= signed;
            multipliedPower += power;
        } else {
            added = signed;
            addedPower = power;
        }
    }
    const power = Math.min(multipliedPower, addedPower),
        exact = (multiplied << BigInt(multipliedPower - power)) + (added << BigInt(addedPower - power));
    return Number(exact) * 2 ** power;
}

export type Color = readonly [number, number, number, number];
export interface Layer {
    name: string;
    visible: boolean;
    pixels: Uint8ClampedArray;
}
export interface State {
    width: number;
    height: number;
    background: Color;
    active: number;
    layers: Layer[];
}
export type ResourceProfileId = 'web' | 'desktop';
export interface ResourceProfile {
    readonly id: ResourceProfileId;
    readonly dimension: number;
    readonly pixels: number;
    readonly totalPixels: number;
    readonly layers: number;
    readonly inputBytes: number;
    readonly layerBytes: number;
}
export const webLimits: ResourceProfile = Object.freeze({
    id: 'web',
    dimension: 4096,
    pixels: 4 * 1024 * 1024,
    totalPixels: 6 * 1024 * 1024,
    layers: 16,
    inputBytes: 40 * 1024 * 1024,
    layerBytes: 20 * 1024 * 1024,
});
export const desktopLimits: ResourceProfile = Object.freeze({
    id: 'desktop',
    dimension: 32768,
    pixels: 32 * 1024 * 1024,
    totalPixels: 64 * 1024 * 1024,
    layers: 16,
    inputBytes: 300 * 1024 * 1024,
    layerBytes: 140 * 1024 * 1024,
});
export const limits = webLimits;
export function profileById(id: unknown): ResourceProfile {
    if (id === 'web') return webLimits;
    if (id === 'desktop') return desktopLimits;
    throw Error('알 수 없는 자원 프로필입니다.');
}
export function validateProfile(profile: ResourceProfile): void {
    if (profile !== webLimits && profile !== desktopLimits) throw Error('알 수 없는 자원 프로필입니다.');
}
export function validateSize(
    width: number,
    height: number,
    layers = 1,
    profile: ResourceProfile = webLimits,
): void {
    validateProfile(profile);
    if (
        ![width, height, layers].every(Number.isSafeInteger) ||
        width < 1 ||
        height < 1 ||
        width > profile.dimension ||
        height > profile.dimension ||
        width * height > profile.pixels ||
        layers < 1 ||
        layers > profile.layers ||
        width * height * layers > profile.totalPixels
    )
        throw Error('이미지 크기 또는 레이어 메모리 한도를 초과합니다.');
}
export function validate(state: State, profile: ResourceProfile = webLimits): void {
    validateSize(state.width, state.height, state.layers.length, profile);
    if (
        !Number.isInteger(state.active) ||
        state.active < 0 ||
        state.active >= state.layers.length ||
        state.background.length !== 4 ||
        state.background.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
    )
        throw Error('문서 상태가 올바르지 않습니다.');
    for (const layer of state.layers)
        if (
            layer.pixels.length !== state.width * state.height * 4 ||
            typeof layer.visible !== 'boolean' ||
            layer.name.length > 256 ||
            /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(layer.name)
        )
            throw Error('레이어 데이터가 올바르지 않습니다.');
}
export function createState(
    width = 800,
    height = 600,
    background: Color = [255, 255, 255, 255],
    profile: ResourceProfile = webLimits,
): State {
    validateSize(width, height, 1, profile);
    if (
        background.length !== 4 ||
        background.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
    )
        throw Error('문서 바탕 색상이 올바르지 않습니다.');
    const pixels = new Uint8ClampedArray(width * height * 4),
        color = new Uint8ClampedArray(background),
        word = new Uint32Array(color.buffer)[0];
    if (word !== 0) new Uint32Array(pixels.buffer).fill(word);
    return {
        width,
        height,
        background: [...background],
        active: 0,
        layers: [{ name: '배경', visible: true, pixels }],
    };
}
export function cloneState(s: State): State {
    return {
        ...s,
        background: [...s.background],
        layers: s.layers.map((l) => ({ ...l, pixels: l.pixels.slice() })),
    };
}
function sameState(candidate: State, previous: State): boolean {
    return (
        candidate.width === previous.width &&
        candidate.height === previous.height &&
        candidate.active === previous.active &&
        candidate.background.every((v, i) => v === previous.background[i]) &&
        candidate.layers.length === previous.layers.length &&
        candidate.layers.every((layer, index) => {
            const oldLayer = previous.layers[index];
            if (layer.name !== oldLayer.name || layer.visible !== oldLayer.visible) return false;
            const pixels = layer.pixels,
                before = oldLayer.pixels;
            if (pixels === before) return true;
            if (pixels.byteOffset % 4 === 0 && before.byteOffset % 4 === 0) {
                const words = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.length / 4),
                    oldWords = new Uint32Array(before.buffer, before.byteOffset, before.length / 4);
                for (let i = 0; i < words.length; i++) if (words[i] !== oldWords[i]) return false;
            } else {
                for (let i = 0; i < pixels.length; i++) if (pixels[i] !== before[i]) return false;
            }
            return true;
        })
    );
}
export function composite(s: State, profile: ResourceProfile = webLimits): Uint8ClampedArray {
    validate(s, profile);
    const out = new Uint8ClampedArray(s.width * s.height * 4);
    for (const l of s.layers)
        if (l.visible)
            for (let i = 0; i < out.length; i += 4) {
                const alpha = l.pixels[i + 3];
                if (alpha === 0) continue;
                if (alpha === 255) {
                    out[i] = l.pixels[i];
                    out[i + 1] = l.pixels[i + 1];
                    out[i + 2] = l.pixels[i + 2];
                    out[i + 3] = 255;
                    continue;
                }
                const a = alpha / 255,
                    old = out[i + 3] / 255,
                    next = a + old * (1 - a);
                for (let c = 0; c < 3; c++)
                    out[i + c] = Math.round((l.pixels[i + c] * a + out[i + c] * old * (1 - a)) / next);
                out[i + 3] = Math.round(next * 255);
            }
    return out;
}
export interface BrushSettings {
    color: Color;
    size: number;
    opacity: number;
    hardness: number;
    stabilization: number;
    eraser: boolean;
    pressure: boolean;
    square?: boolean;
    pixel?: boolean;
    dabsOnly?: boolean;
    matchColor?: Color;
}
interface Tile {
    x: number;
    y: number;
    width: number;
    height: number;
    before: Uint8ClampedArray;
    after?: Uint8ClampedArray;
    coverage: Uint8Array;
}
export type MetadataChange =
    | { kind: 'layer-name'; layer: number; name: string }
    | { kind: 'layer-visible'; layer: number; visible: boolean }
    | { kind: 'background'; background: Color }
    | { kind: 'layer-reorder'; layer: number; to: number };
interface MetadataFrame {
    background: Color;
    active: number;
    layers: { name: string; visible: boolean }[];
}
interface MetadataPatch {
    width: number;
    height: number;
    before: MetadataFrame;
    after: MetadataFrame;
    forward: number[];
    reverse: number[];
}
interface Change {
    label: string;
    beforeId: number;
    afterId: number;
    bytes: number;
    layer?: number;
    tiles?: Tile[];
    before?: State;
    after?: State;
    visible?: boolean;
    metadata?: MetadataPatch;
}
export class PaintDocument {
    state: State;
    revision = 1;
    savedRevision = 1;
    nextRevision = 2;
    history: Change[] = [];
    cursor = 0;
    historyBytes = 0;
    private budgetBytes = 32 * 1024 * 1024;
    stroke?: {
        settings: BrushSettings;
        tiles: Map<number, Tile>;
        dirty: Set<number>;
        x: number;
        y: number;
        fx: number;
        fy: number;
        pressure: number;
        layer: number;
        visible: boolean;
        insideCanvas: boolean;
    };
    constructor(
        state = createState(),
        readonly profile: ResourceProfile = webLimits,
    ) {
        validate(state, profile);
        this.state = state;
        this.historyBudget = profile.id === 'desktop' ? 256 * 1024 * 1024 : 32 * 1024 * 1024;
    }
    get historyBudget(): number {
        return this.budgetBytes;
    }
    set historyBudget(bytes: number) {
        if (!Number.isSafeInteger(bytes)) throw Error('이력 메모리 예산은 안전한 정수 바이트여야 합니다.');
        const budget = Math.max(0, bytes);
        if (budget === this.budgetBytes) return;
        let retained = this.historyBytes,
            cursor = this.cursor,
            first = 0,
            last = this.history.length;
        while ((retained > budget || last - first > 4096) && last - first > 1) {
            if (cursor > 0) {
                retained -= this.history[first++].bytes;
                cursor--;
            } else retained -= this.history[--last].bytes;
        }
        const history =
            first || last !== this.history.length ? this.history.slice(first, last) : this.history;
        this.budgetBytes = budget;
        this.history = history;
        this.cursor = cursor;
        this.historyBytes = retained;
    }
    get dirty(): boolean {
        return this.revision !== this.savedRevision;
    }
    get canUndo(): boolean {
        return !!this.stroke || this.cursor > 0;
    }
    get canRedo(): boolean {
        return !this.stroke && this.cursor < this.history.length;
    }
    reset(state: State, saved = true): void {
        validate(state, this.profile);
        this.cancelStroke();
        this.state = state;
        this.history = [];
        this.cursor = 0;
        this.historyBytes = 0;
        this.revision = this.nextRevision++;
        this.savedRevision = saved ? this.revision : 0;
    }
    markSaved(revision: number): void {
        if (this.revision === revision && !this.stroke) this.savedRevision = revision;
    }
    private record(change: Change): void {
        const next = this.history.slice(0, this.cursor);
        next.push(change);
        let bytes = next.reduce((sum, c) => sum + c.bytes, 0);
        while ((bytes > this.historyBudget || next.length > 4096) && next.length > 1)
            bytes -= next.shift()!.bytes;
        this.history = next;
        this.cursor = next.length;
        this.historyBytes = bytes;
        this.revision = change.afterId;
        this.nextRevision++;
    }
    prepareState(
        label: string,
        result: State,
    ):
        | {
              owner: PaintDocument;
              base: number;
              baseCursor: number;
              baseHistory: Change[];
              budget: number;
              active: number;
              state: State;
              history: Change[];
              bytes: number;
              id: number;
          }
        | undefined {
        if (this.stroke) throw Error('현재 그리기를 마친 뒤 실행하세요.');
        validate(result, this.profile);
        const old = this.state;
        if (sameState(result, old)) return;
        const after = cloneState(result),
            bytes =
                (old.width * old.height * old.layers.length +
                    result.width * result.height * result.layers.length) *
                4;
        const change: Change = {
            label,
            beforeId: this.revision,
            afterId: this.nextRevision,
            bytes,
            before: old,
            after,
        };
        const history = this.history.slice(0, this.cursor);
        history.push(change);
        let total = history.reduce((n, c) => n + c.bytes, 0);
        while ((total > this.historyBudget || history.length > 4096) && history.length > 1)
            total -= history.shift()!.bytes;
        return {
            owner: this,
            base: this.revision,
            baseCursor: this.cursor,
            baseHistory: this.history,
            budget: this.historyBudget,
            active: old.active,
            state: result,
            history,
            bytes: total,
            id: this.nextRevision,
        };
    }
    installPrepared(prepared: NonNullable<ReturnType<PaintDocument['prepareState']>>): void {
        if (
            prepared.owner !== this ||
            prepared.base !== this.revision ||
            prepared.baseCursor !== this.cursor ||
            prepared.baseHistory !== this.history ||
            prepared.budget !== this.historyBudget ||
            prepared.active !== this.state.active ||
            prepared.id !== this.nextRevision ||
            this.stroke
        )
            throw Error('준비한 편집의 문서가 변경됐습니다.');
        validate(prepared.state, this.profile);
        const expected = prepared.history.at(-1)?.after;
        if (!expected || !sameState(prepared.state, expected))
            throw Error('준비한 편집 후보가 변경됐습니다. 다시 실행하세요.');
        this.state = prepared.state;
        this.history = prepared.history;
        this.historyBytes = prepared.bytes;
        this.cursor = prepared.history.length;
        this.revision = prepared.id;
        this.nextRevision++;
    }
    commitState(label: string, candidate: State): void {
        const prepared = this.prepareState(label, candidate);
        if (!prepared) return;
        this.state = prepared.state;
        this.history = prepared.history;
        this.historyBytes = prepared.bytes;
        this.cursor = prepared.history.length;
        this.revision = prepared.id;
        this.nextRevision++;
    }
    edit(label: string, work: (state: State) => State | void): void {
        if (this.stroke) throw Error('현재 그리기를 마친 뒤 실행하세요.');
        const next = cloneState(this.state),
            result = work(next) || next;
        this.commitState(label, result);
    }
    editMetadata(label: string, change: MetadataChange): void {
        if (this.stroke) throw Error('현재 그리기를 마친 뒤 실행하세요.');
        validate(this.state, this.profile);
        const old = this.state,
            order = old.layers.map((_, index) => index),
            candidate: State = {
                ...old,
                background: [...old.background],
                layers: old.layers.map((layer) => ({ ...layer })),
            };
        if (
            'layer' in change &&
            (!Number.isInteger(change.layer) || change.layer < 0 || change.layer >= old.layers.length)
        )
            throw Error('레이어 번호가 올바르지 않습니다.');
        switch (change.kind) {
            case 'layer-name':
                if (typeof change.name !== 'string') throw Error('레이어 이름이 올바르지 않습니다.');
                candidate.layers[change.layer].name = change.name;
                break;
            case 'layer-visible':
                if (typeof change.visible !== 'boolean') throw Error('레이어 표시 값이 올바르지 않습니다.');
                candidate.layers[change.layer].visible = change.visible;
                break;
            case 'background':
                candidate.background = [...change.background];
                break;
            case 'layer-reorder': {
                if (!Number.isInteger(change.to) || change.to < 0 || change.to >= old.layers.length)
                    throw Error('레이어 위치가 올바르지 않습니다.');
                order.splice(change.to, 0, order.splice(change.layer, 1)[0]);
                candidate.layers = order.map((index) => ({ ...old.layers[index] }));
                candidate.active = order.indexOf(old.active);
                break;
            }
            default:
                throw Error('지원하지 않는 문서 속성 변경입니다.');
        }
        validate(candidate, this.profile);
        if (
            order.every((index, position) => index === position) &&
            candidate.active === old.active &&
            candidate.background.every((value, index) => value === old.background[index]) &&
            candidate.layers.every(
                (layer, index) =>
                    layer.name === old.layers[index].name && layer.visible === old.layers[index].visible,
            )
        )
            return;
        const before: MetadataFrame = {
                background: [...old.background],
                active: old.active,
                layers: old.layers.map(({ name, visible }) => ({ name, visible })),
            },
            after: MetadataFrame = {
                background: [...candidate.background],
                active: candidate.active,
                layers: candidate.layers.map(({ name, visible }) => ({ name, visible })),
            },
            reverse = order.map((_, index) => order.indexOf(index)),
            bytes =
                32 +
                order.length * 10 +
                [...before.layers, ...after.layers].reduce((sum, layer) => sum + layer.name.length * 2, 0);
        // Pixel arrays stay mutable in the active document. History owns only
        // copied metadata and index permutations, never shared pixel snapshots.
        this.record({
            label,
            beforeId: this.revision,
            afterId: this.nextRevision,
            bytes,
            metadata: { width: old.width, height: old.height, before, after, forward: order, reverse },
        });
        this.state = candidate;
    }
    replacePixels(
        label: string,
        layer: number,
        left: number,
        top: number,
        width: number,
        height: number,
        data: Uint8ClampedArray,
        over = false,
    ): void {
        if (this.stroke) throw Error('현재 획을 마치세요.');
        if (
            !Number.isInteger(layer) ||
            layer < 0 ||
            layer >= this.state.layers.length ||
            ![left, top, width, height].every(Number.isInteger) ||
            width < 1 ||
            height < 1 ||
            data.length !== width * height * 4
        )
            throw Error('픽셀 영역이 올바르지 않습니다.');
        const x = Math.max(0, left),
            y = Math.max(0, top),
            w = Math.min(this.state.width, left + width) - x,
            h = Math.min(this.state.height, top + height) - y;
        if (w <= 0 || h <= 0) return;
        const image = this.state.layers[layer].pixels,
            before = new Uint8ClampedArray(w * h * 4),
            after = new Uint8ClampedArray(w * h * 4);
        for (let row = 0; row < h; row++) {
            before.set(
                image.subarray(
                    ((y + row) * this.state.width + x) * 4,
                    ((y + row) * this.state.width + x + w) * 4,
                ),
                row * w * 4,
            );
            after.set(
                data.subarray(
                    ((y + row - top) * width + x - left) * 4,
                    ((y + row - top) * width + x - left + w) * 4,
                ),
                row * w * 4,
            );
        }
        if (over)
            for (let i = 0; i < after.length; i += 4) {
                // Transparent source pixels must not normalize the destination's hidden RGB.
                if (after[i + 3] === 0) {
                    after[i] = before[i];
                    after[i + 1] = before[i + 1];
                    after[i + 2] = before[i + 2];
                    after[i + 3] = before[i + 3];
                    continue;
                }
                const a = after[i + 3] / 255,
                    b = before[i + 3] / 255,
                    oa = a + b * (1 - a);
                for (let c = 0; c < 3; c++)
                    after[i + c] = oa ? Math.round((after[i + c] * a + before[i + c] * b * (1 - a)) / oa) : 0;
                after[i + 3] = Math.round(oa * 255);
            }
        if (!after.some((v, i) => v !== before[i]) && this.state.layers[layer].visible) return;
        const change: Change = {
            label,
            beforeId: this.revision,
            afterId: this.nextRevision,
            bytes: before.byteLength + after.byteLength,
            layer,
            visible: this.state.layers[layer].visible,
            tiles: [{ x, y, width: w, height: h, before, after, coverage: new Uint8Array() }],
        };
        this.record(change);
        for (let row = 0; row < h; row++)
            image.set(after.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * this.state.width + x) * 4);
        this.state.layers[layer].visible = true;
    }
    beginStroke(x: number, y: number, settings: BrushSettings, pressure = 1): void {
        if (this.stroke) throw Error('이미 그리는 중입니다.');
        if (
            ![
                x,
                y,
                pressure,
                settings.size,
                settings.opacity,
                settings.hardness,
                settings.stabilization,
            ].every(Number.isFinite)
        )
            throw Error('입력 값이 올바르지 않습니다.');
        for (const color of [settings.color, settings.matchColor])
            if (color && (color.length !== 4 || color.some((v) => !Number.isInteger(v) || v < 0 || v > 255)))
                throw Error('입력 색상이 올바르지 않습니다.');
        x = Math.max(-this.profile.dimension, Math.min(this.profile.dimension * 2, x));
        y = Math.max(-this.profile.dimension, Math.min(this.profile.dimension * 2, y));
        const hardSquare = settings.square && !settings.pixel && !settings.dabsOnly && !settings.matchColor;
        if (settings.matchColor || hardSquare) {
            x = Math.floor(x);
            y = Math.floor(y);
        }
        pressure = settings.pressure ? Math.max(0, Math.min(1, pressure)) : 1;
        this.stroke = {
            settings: {
                ...settings,
                color: [...settings.color],
                matchColor: settings.matchColor ? [...settings.matchColor] : undefined,
                size: Math.max(1, Math.min(100, hardSquare ? Math.floor(settings.size) : settings.size)),
                opacity: hardSquare ? 1 : Math.max(0, Math.min(1, settings.opacity)),
                hardness: hardSquare ? 1 : Math.max(0, Math.min(1, settings.hardness)),
                stabilization: hardSquare ? 0 : Math.max(0, Math.min(75, settings.stabilization)),
                pressure: hardSquare ? false : settings.pressure,
            },
            tiles: new Map(),
            dirty: new Set(),
            x,
            y,
            fx: x,
            fy: y,
            pressure,
            layer: this.state.active,
            visible: this.state.layers[this.state.active].visible,
            insideCanvas: x >= 0 && y >= 0 && x < this.state.width && y < this.state.height,
        };
        this.state.layers[this.state.active].visible = true;
        this.moveStroke(x, y, pressure);
    }
    private captureStrokeTile(
        stroke: NonNullable<PaintDocument['stroke']>,
        tx: number,
        ty: number,
        key: number,
        trackCoverage = true,
    ): Tile {
        const state = this.state,
            image = state.layers[stroke.layer].pixels,
            width = Math.min(128, state.width - tx * 128),
            height = Math.min(128, state.height - ty * 128),
            before = new Uint8ClampedArray(width * height * 4);
        for (let row = 0; row < height; row++)
            before.set(
                image.subarray(
                    ((ty * 128 + row) * state.width + tx * 128) * 4,
                    ((ty * 128 + row) * state.width + tx * 128 + width) * 4,
                ),
                row * width * 4,
            );
        const tile = {
            x: tx * 128,
            y: ty * 128,
            width,
            height,
            before,
            coverage: new Uint8Array(trackCoverage ? width * height : 0),
        };
        stroke.tiles.set(key, tile);
        return tile;
    }
    moveStroke(x: number, y: number, pressure = 1, finish = false): void {
        const stroke = this.stroke;
        if (!stroke) return;
        if (![x, y, pressure].every(Number.isFinite)) throw Error('입력 좌표가 올바르지 않습니다.');
        const { settings: s } = stroke;
        if (s.square && !s.pixel && !s.dabsOnly && !s.matchColor) {
            this.moveSquareStroke(x, y);
            return;
        }
        const state = this.state,
            image = state.layers[stroke.layer].pixels;
        x = Math.max(-this.profile.dimension, Math.min(this.profile.dimension * 2, x));
        y = Math.max(-this.profile.dimension, Math.min(this.profile.dimension * 2, y));
        if (s.matchColor) {
            x = Math.floor(x);
            y = Math.floor(y);
        }
        pressure = s.pressure ? Math.max(0, Math.min(1, pressure)) : 1;
        if (x >= 0 && y >= 0 && x < state.width && y < state.height) stroke.insideCanvas = true;
        const weight = 1 - s.stabilization * 0.008,
            fx = finish || s.pixel || s.dabsOnly || s.matchColor ? x : stroke.fx + (x - stroke.fx) * weight,
            fy = finish || s.pixel || s.dabsOnly || s.matchColor ? y : stroke.fy + (y - stroke.fy) * weight;
        const ex = finish || s.pixel || s.dabsOnly || s.matchColor ? x : (stroke.fx + fx) / 2,
            ey = finish || s.pixel || s.dabsOnly || s.matchColor ? y : (stroke.fy + fy) / 2;
        const length =
            Math.hypot(stroke.x - stroke.fx, stroke.y - stroke.fy) +
            Math.hypot(stroke.fx - ex, stroke.fy - ey);
        const steps =
            s.dabsOnly || s.matchColor
                ? 1
                : s.pixel
                  ? Math.max(
                        1,
                        Math.abs(Math.floor(x) - Math.floor(stroke.x)),
                        Math.abs(Math.floor(y) - Math.floor(stroke.y)),
                    )
                  : Math.max(1, Math.ceil(length / Math.max(0.25, s.size * 0.12)));
        const cols = Math.ceil(state.width / 128),
            dx = x - stroke.x,
            dy = y - stroke.y,
            segmentLength = dx * dx + dy * dy,
            match = s.matchColor?.map((value, channel) =>
                channel === 3 ? value : Math.floor((value * s.matchColor![3] + 127) / 255),
            ),
            // Erasing and replacement may write alpha0; transparent normal ink is a no-op.
            paint = !!match || (s.opacity > 0 && (s.eraser || s.color[3] !== 0));
        for (let step = s.dabsOnly || match ? 1 : 0; paint && step <= steps; step++) {
            const t = step / steps,
                u = 1 - t,
                cx =
                    s.dabsOnly || match
                        ? x
                        : s.pixel
                          ? Math.round(u * Math.floor(stroke.x) + t * Math.floor(x)) + 0.5
                          : u * u * stroke.x + 2 * u * t * stroke.fx + t * t * ex,
                cy =
                    s.dabsOnly || match
                        ? y
                        : s.pixel
                          ? Math.round(u * Math.floor(stroke.y) + t * Math.floor(y)) + 0.5
                          : u * u * stroke.y + 2 * u * t * stroke.fy + t * t * ey;
            const force = stroke.pressure + (pressure - stroke.pressure) * t,
                r = match ? s.size / 2 : Math.max(0.5, (s.size * (0.2 + 0.8 * (s.pressure ? force : 1))) / 2),
                inner = r * s.hardness;
            const left = Math.max(
                    0,
                    Math.floor(match ? Math.min(stroke.x, x) - r : s.pixel ? cx : cx - r - 0.5),
                ),
                right = Math.min(
                    state.width - 1,
                    Math.ceil(match ? Math.max(stroke.x, x) + r : s.pixel ? Math.floor(cx) : cx + r + 0.5),
                ),
                top = Math.max(
                    0,
                    Math.floor(match ? Math.min(stroke.y, y) - r : s.pixel ? cy : cy - r - 0.5),
                ),
                bottom = Math.min(
                    state.height - 1,
                    Math.ceil(match ? Math.max(stroke.y, y) + r : s.pixel ? Math.floor(cy) : cy + r + 0.5),
                );
            for (let py = top; py <= bottom; py++) {
                let rowLeft = left,
                    rowRight = right;
                if (match && dy) {
                    // Bound long diagonal strokes by the segment's crossing of this row band.
                    const first = Math.max(0, Math.min((py - r - stroke.y) / dy, (py + r - stroke.y) / dy)),
                        last = Math.min(1, Math.max((py - r - stroke.y) / dy, (py + r - stroke.y) / dy));
                    if (first > last) continue;
                    rowLeft = Math.max(
                        left,
                        Math.floor(Math.min(stroke.x + first * dx, stroke.x + last * dx) - r),
                    );
                    rowRight = Math.min(
                        right,
                        Math.ceil(Math.max(stroke.x + first * dx, stroke.x + last * dx) + r),
                    );
                }
                for (let px = rowLeft; px <= rowRight; px++) {
                    const i = (py * state.width + px) * 4;
                    if (
                        match &&
                        (image[i + 3] !== match[3] ||
                            Math.floor((image[i] * image[i + 3] + 127) / 255) !== match[0] ||
                            Math.floor((image[i + 1] * image[i + 3] + 127) / 255) !== match[1] ||
                            Math.floor((image[i + 2] * image[i + 3] + 127) / 255) !== match[2] ||
                            (image[i] === s.color[0] &&
                                image[i + 1] === s.color[1] &&
                                image[i + 2] === s.color[2] &&
                                image[i + 3] === s.color[3]))
                    )
                        continue;
                    const position =
                            match && segmentLength
                                ? Math.max(
                                      0,
                                      Math.min(
                                          1,
                                          ((px - stroke.x) * dx + (py - stroke.y) * dy) / segmentLength,
                                      ),
                                  )
                                : 0,
                        distance = match
                            ? Math.hypot(px - stroke.x - position * dx, py - stroke.y - position * dy)
                            : s.square
                              ? Math.max(Math.abs(px + 0.5 - cx), Math.abs(py + 0.5 - cy))
                              : Math.hypot(px + 0.5 - cx, py + 0.5 - cy),
                        edge = Math.max(0, Math.min(1, (distance - inner) / (r + 0.5 - inner))),
                        alpha = match
                            ? distance <= r
                                ? 255
                                : 0
                            : Math.round(255 * (s.pixel ? 1 : 1 - edge * edge * (3 - 2 * edge)) * s.opacity);
                    if (alpha === 0) continue;
                    const tx = Math.floor(px / 128),
                        ty = Math.floor(py / 128),
                        key = ty * cols + tx;
                    let tile = stroke.tiles.get(key);
                    // Judge transparency before this stroke, not after partial-coverage rounding.
                    if (
                        !match &&
                        s.eraser &&
                        s.color[3] === 0 &&
                        (tile
                            ? tile.before[((py - tile.y) * tile.width + px - tile.x) * 4 + 3]
                            : image[i + 3]) === 0
                    )
                        continue;
                    if (!tile) tile = this.captureStrokeTile(stroke, tx, ty, key);
                    const local = (py - tile.y) * tile.width + px - tile.x;
                    if (alpha <= tile.coverage[local]) continue;
                    tile.coverage[local] = alpha;
                    stroke.dirty.add(key);
                    const j = local * 4,
                        a = alpha / 255,
                        b = tile.before;
                    if (match) image.set(s.color, i);
                    else if (s.eraser) {
                        const ba = b[j + 3] / 255,
                            ta = s.color[3] / 255,
                            oa = ta * a + ba * (1 - a);
                        for (let c = 0; c < 3; c++)
                            image[i + c] = oa
                                ? Math.round((s.color[c] * ta * a + b[j + c] * ba * (1 - a)) / oa)
                                : 0;
                        image[i + 3] = Math.round(oa * 255);
                    } else {
                        const sa = (a * s.color[3]) / 255,
                            ba = b[j + 3] / 255,
                            oa = sa + ba * (1 - sa);
                        for (let c = 0; c < 3; c++)
                            image[i + c] = oa
                                ? Math.round((s.color[c] * sa + b[j + c] * ba * (1 - sa)) / oa)
                                : 0;
                        image[i + 3] = Math.round(oa * 255);
                    }
                }
            }
        }
        stroke.x = ex;
        stroke.y = ey;
        stroke.fx = fx;
        stroke.fy = fy;
        stroke.pressure = pressure;
    }
    private moveSquareStroke(x: number, y: number): void {
        const stroke = this.stroke!,
            s = stroke.settings,
            state = this.state,
            image = state.layers[stroke.layer].pixels;
        x = Math.floor(Math.max(-this.profile.dimension, Math.min(this.profile.dimension * 2, x)));
        y = Math.floor(Math.max(-this.profile.dimension, Math.min(this.profile.dimension * 2, y)));
        if (x >= 0 && y >= 0 && x < state.width && y < state.height) stroke.insideCanvas = true;
        if (!s.eraser && s.color[3] === 0) {
            stroke.x = stroke.fx = x;
            stroke.y = stroke.fy = y;
            stroke.pressure = 1;
            return;
        }
        const dx = x - stroke.x,
            dy = y - stroke.y,
            segmentLength = dx * dx + dy * dy,
            cols = Math.ceil(state.width / 128);
        let squareEdges: number[] | undefined,
            squareTop = 0,
            squareBottom = -1,
            squareAxis: number[] | undefined,
            squareFirst = 0,
            squareLast = -1,
            squarePhase = 0,
            squareIncrement = 0,
            squareHorizontal = false;
        if (segmentLength && s.size === 1) {
            let first = 0,
                last = 1;
            const anchors: (number | undefined)[][] = [[], []];
            for (const [direction, distance, axis, boundary] of [
                [-dx, stroke.x + 1, 0, -1],
                [dx, state.width + 1 - stroke.x, 0, state.width + 1],
                [-dy, stroke.y + 1, 1, -1],
                [dy, state.height + 1 - stroke.y, 1, state.height + 1],
            ]) {
                if (!direction) {
                    if (distance < 0) {
                        last = -1;
                        break;
                    }
                    continue;
                }
                const t = distance / direction,
                    endpoint = direction < 0 ? 0 : 1;
                if (direction < 0 ? t > first : t < last) {
                    if (endpoint === 0) first = t;
                    else last = t;
                    anchors[endpoint] = [];
                    anchors[endpoint][axis] = boundary;
                } else if (t === (endpoint === 0 ? first : last)) anchors[endpoint][axis] = boundary;
                if (first > last) break;
            }
            if (first <= last) {
                // Keep an intersected clip coordinate exact before fixed-point conversion.
                const ax = Math.trunc((anchors[0][0] ?? stroke.x + dx * first) * 64),
                    ay = Math.trunc((anchors[0][1] ?? stroke.y + dy * first) * 64),
                    bx = Math.trunc((anchors[1][0] ?? stroke.x + dx * last) * 64),
                    by = Math.trunc((anchors[1][1] ?? stroke.y + dy * last) * 64);
                squareHorizontal = Math.abs(bx - ax) >= Math.abs(by - ay);
                let m0 = squareHorizontal ? ax : ay,
                    n0 = squareHorizontal ? ay : ax,
                    m1 = squareHorizontal ? bx : by,
                    n1 = squareHorizontal ? by : bx;
                if (m0 > m1) [m0, n0, m1, n1] = [m1, n1, m0, n0];
                if (m1 > m0) {
                    squareIncrement = Math.trunc(((n1 - n0) * 65536) / (m1 - m0));
                    squareFirst = Math.floor(m0 / 64);
                    squareLast = Math.floor(m1 / 64);
                    squarePhase =
                        n0 * 1024 -
                        Math.floor(squareIncrement / 2) +
                        Math.floor(
                            ((squareFirst * 64 - m0 + 32 + (squareIncrement > 0 ? 32 : 0)) *
                                squareIncrement) /
                                64,
                        );
                }
            }
        } else if (segmentLength) {
            const relative = s.size / Math.sqrt(segmentLength),
                shiftX = 0.5 * relative * dx,
                shiftY = 0.5 * relative * dy,
                ends = [
                    [stroke.x - shiftX, stroke.y - shiftY],
                    [x + shiftX, y + shiftY],
                ];
            let empty = false;
            for (let axis = 0; axis < 2; axis++) {
                const margin = Math.abs(axis === 0 ? dy : dx) * relative * 0.5,
                    lower = -margin,
                    upper = (axis === 0 ? state.width : state.height) + margin;
                for (let which = 0; which < 2; which++) {
                    const own = ends[which],
                        other = ends[1 - which],
                        bound = own[axis] < lower ? lower : own[axis] > upper ? upper : undefined;
                    if (bound === undefined) continue;
                    const denominator = other[axis] - own[axis],
                        t = (bound - own[axis]) / denominator;
                    if (!denominator || t < 0 || t > 1) {
                        empty = true;
                        break;
                    }
                    const slope = (other[1 - axis] - own[1 - axis]) / denominator;
                    own[1 - axis] = rasterMultiplyAdd(slope, bound - own[axis], own[1 - axis]);
                    own[axis] = bound;
                }
                if (empty) break;
            }
            squareEdges = [];
            if (!empty) {
                const cx = ends[1][0] - ends[0][0],
                    cy = ends[1][1] - ends[0][1],
                    norm = rasterMultiplyAdd(cx, cx, cy * cy);
                if (norm) {
                    const recovered = relative * Math.sqrt(segmentLength / norm);
                    if (!dx || !dy) {
                        if (!dy) {
                            const center = (ends[0][0] + ends[1][0]) * 0.5,
                                halfHeight = recovered * (Math.abs(cx) * 0.5),
                                high = ends[0][1] - halfHeight,
                                low = ends[0][1] + halfHeight,
                                halfWidth = 0.5 * (1 / recovered) * (low - high);
                            squareAxis = [center - halfWidth, high, center + halfWidth, low];
                        } else {
                            const high = Math.min(ends[0][1], ends[1][1]),
                                low = Math.max(ends[0][1], ends[1][1]),
                                halfWidth = 0.5 * recovered * (low - high);
                            squareAxis = [ends[0][0] - halfWidth, high, ends[0][0] + halfWidth, low];
                        }
                    } else {
                        const nx = (cy * recovered) / 2,
                            ny = (-cx * recovered) / 2,
                            vertices = [
                                ends[0][0] + nx,
                                ends[0][1] + ny,
                                ends[1][0] + nx,
                                ends[1][1] + ny,
                                ends[1][0] - nx,
                                ends[1][1] - ny,
                                ends[0][0] - nx,
                                ends[0][1] - ny,
                            ].map((value) => Math.floor(value * 64) / 64),
                            top = Math.min(vertices[1], vertices[3], vertices[5], vertices[7]);
                        let area = 0;
                        for (let edge = 0; edge < 8; edge += 2) {
                            const next = (edge + 2) % 8;
                            area += vertices[edge] * vertices[next + 1] - vertices[next] * vertices[edge + 1];
                        }
                        squareTop = state.height;
                        for (let edge = 0; edge < 8; edge += 2) {
                            const next = (edge + 2) % 8;
                            let ax = vertices[edge],
                                ay = vertices[edge + 1],
                                bx = vertices[next],
                                by = vertices[next + 1];
                            const direction = by - ay;
                            if (!direction) continue;
                            const left = area * direction < 0;
                            if (ay > by) [ax, ay, bx, by] = [bx, by, ax, ay];
                            const slope = (bx - ax) / (by - ay),
                                first =
                                    ay === top
                                        ? Math.trunc(ay + 0.5)
                                        : ay < 0.5
                                          ? 0
                                          : Math.trunc(ay - 0.5) + 1,
                                last = by < 0.5 ? -1 : Math.trunc(by - 0.5),
                                phase = Math.trunc(
                                    rasterMultiplyAdd(first + 0.5 - ay, slope, ax + (left ? 0.5 : -0.5)) *
                                        65536,
                                ),
                                increment = Math.trunc(slope * 65536);
                            squareEdges.push(left ? 1 : 0, first, last, phase, increment);
                            squareTop = Math.min(squareTop, Math.max(0, first));
                            squareBottom = Math.max(squareBottom, Math.min(state.height - 1, last));
                        }
                    }
                }
            }
        }
        const squarePoint = !segmentLength,
            squareThin = segmentLength && s.size === 1,
            count = squarePoint ? 2 : squareThin ? squareLast - squareFirst : 1;
        for (let step = squarePoint || squareEdges ? 1 : 0; step <= count; step++) {
            let left = 0,
                right = -1,
                top = 0,
                bottom = -1;
            if (squareThin) {
                const major = squareFirst + step,
                    minor = Math.floor((squarePhase + step * squareIncrement) / 65536),
                    px = squareHorizontal ? major : minor,
                    py = squareHorizontal ? minor : major;
                left = Math.max(0, px);
                right = Math.min(state.width - 1, px);
                top = Math.max(0, py);
                bottom = Math.min(state.height - 1, py);
            } else if (squarePoint) {
                left = Math.max(0, x - Math.floor(s.size / 2));
                right = Math.min(state.width - 1, x - Math.floor(s.size / 2) + s.size - 1);
                top = Math.max(0, y - Math.floor(s.size / 2));
                bottom = Math.min(state.height - 1, y - Math.floor(s.size / 2) + s.size - 1);
                if (s.size > 1 && (step === 1 || s.color[3] === 255)) {
                    // Line and opaque point have separate axis normalization and rounding.
                    const travel = step === 1 ? s.size : x + 1 / 63 - x,
                        ratio = step === 1 ? 1 : s.size / Math.abs(travel),
                        cap = 0.5 * ratio * travel,
                        start = Math.max(0, x - cap),
                        end = Math.min(state.width, step === 1 ? x + cap : x + travel + cap);
                    if (end <= start) continue;
                    const center = (start + end) * 0.5,
                        span = end - start,
                        recovered = ratio * Math.sqrt((travel * travel) / (span * span)),
                        halfHeight = recovered * (Math.abs(span) * 0.5),
                        high = y - halfHeight,
                        low = y + halfHeight,
                        halfWidth = 0.5 * (1 / recovered) * (low - high);
                    squareAxis = [center - halfWidth, high, center + halfWidth, low];
                } else squareAxis = undefined;
            } else if (squareEdges) {
                left = 0;
                right = state.width - 1;
                top = squareTop;
                bottom = squareBottom;
            }
            if (squareAxis) {
                const l = Math.max(0, Math.min(state.width, squareAxis[0])),
                    t = Math.max(0, Math.min(state.height, squareAxis[1])),
                    r = Math.max(0, Math.min(state.width, squareAxis[2])),
                    b = Math.max(0, Math.min(state.height, squareAxis[3]));
                left = Math.floor(l + 0.5);
                right = Math.min(state.width - 1, r < 0.5 ? -1 : Math.floor(r - 0.5));
                top = Math.floor(t + 0.5);
                bottom = Math.min(state.height - 1, b < 0.5 ? -1 : Math.floor(b - 0.5));
            }
            for (let py = top; py <= bottom; py++) {
                let rowLeft = left,
                    rowRight = right;
                if (squareEdges && !squareAxis) {
                    let first = Infinity,
                        last = -Infinity;
                    for (let edge = 0; edge < squareEdges.length; edge += 5) {
                        const anchor = squareEdges[edge + 1];
                        if (anchor <= py && py <= squareEdges[edge + 2]) {
                            const at = Math.floor(
                                (squareEdges[edge + 3] + (py - anchor) * squareEdges[edge + 4]) / 65536,
                            );
                            if (squareEdges[edge]) first = at;
                            else last = at;
                        }
                    }
                    rowLeft = Math.max(rowLeft, first);
                    rowRight = Math.min(rowRight, last);
                }
                for (let px = rowLeft; px <= rowRight; px++) {
                    const i = (py * state.width + px) * 4,
                        tx = Math.floor(px / 128),
                        ty = Math.floor(py / 128),
                        key = ty * cols + tx;
                    let tile = stroke.tiles.get(key);
                    if (
                        s.eraser &&
                        s.color[3] === 0 &&
                        (tile
                            ? tile.before[((py - tile.y) * tile.width + px - tile.x) * 4 + 3]
                            : image[i + 3]) === 0
                    )
                        continue;
                    if (!tile) tile = this.captureStrokeTile(stroke, tx, ty, key, false);
                    stroke.dirty.add(key);
                    if (s.eraser) image.set(s.color, i);
                    else {
                        const sourceAlpha = s.color[3] / 255,
                            beforeAlpha = image[i + 3] / 255,
                            alpha = sourceAlpha + beforeAlpha * (1 - sourceAlpha);
                        for (let channel = 0; channel < 3; channel++)
                            image[i + channel] = Math.round(
                                (s.color[channel] * sourceAlpha +
                                    image[i + channel] * beforeAlpha * (1 - sourceAlpha)) /
                                    alpha,
                            );
                        image[i + 3] = Math.round(alpha * 255);
                    }
                }
            }
        }
        stroke.x = stroke.fx = x;
        stroke.y = stroke.fy = y;
        stroke.pressure = 1;
    }
    endStroke(x: number, y: number): void {
        const s = this.stroke;
        if (!s) return;
        try {
            const settings = s.settings,
                hardSquare = settings.square && !settings.pixel && !settings.dabsOnly && !settings.matchColor;
            if (!hardSquare || Math.floor(x) !== s.x || Math.floor(y) !== s.y)
                this.moveStroke(x, y, s.pressure, true);
            const image = this.state.layers[s.layer].pixels;
            const tiles: Tile[] = [];
            let bytes = 0;
            for (const tile of s.tiles.values()) {
                const after = new Uint8ClampedArray(tile.before.length);
                for (let y = 0; y < tile.height; y++)
                    after.set(
                        image.subarray(
                            ((tile.y + y) * this.state.width + tile.x) * 4,
                            ((tile.y + y) * this.state.width + tile.x + tile.width) * 4,
                        ),
                        y * tile.width * 4,
                    );
                if (after.some((v, i) => v !== tile.before[i])) {
                    tiles.push({ ...tile, after, coverage: new Uint8Array() });
                    bytes += tile.before.byteLength + after.byteLength;
                }
            }
            if (tiles.length || (!s.visible && (s.tiles.size > 0 || s.insideCanvas)))
                this.record({
                    label: s.settings.matchColor ? '색 교체' : '그리기',
                    beforeId: this.revision,
                    afterId: this.nextRevision,
                    bytes,
                    layer: s.layer,
                    tiles,
                    visible: s.visible,
                });
            else this.state.layers[s.layer].visible = s.visible;
            this.stroke = undefined;
        } catch (error) {
            this.cancelStroke();
            throw error;
        }
    }
    cancelStroke(): void {
        const s = this.stroke;
        if (!s) return;
        const image = this.state.layers[s.layer].pixels;
        for (const tile of s.tiles.values())
            for (let y = 0; y < tile.height; y++)
                image.set(
                    tile.before.subarray(y * tile.width * 4, (y + 1) * tile.width * 4),
                    ((tile.y + y) * this.state.width + tile.x) * 4,
                );
        this.state.layers[s.layer].visible = s.visible;
        this.stroke = undefined;
    }
    undo(): void {
        if (this.stroke) {
            this.cancelStroke();
            return;
        }
        if (this.cursor === 0) return;
        this.apply(this.history[this.cursor - 1], false);
        this.cursor--;
    }
    redo(): void {
        if (!this.canRedo) return;
        this.apply(this.history[this.cursor], true);
        this.cursor++;
    }
    private apply(c: Change, forward: boolean): void {
        if (c.metadata) {
            const patch = c.metadata,
                frame = forward ? patch.after : patch.before,
                order = forward ? patch.forward : patch.reverse,
                current = this.state;
            if (
                current.width !== patch.width ||
                current.height !== patch.height ||
                current.layers.length !== order.length
            )
                throw Error('속성 변경의 문서 크기 또는 레이어가 일치하지 않습니다.');
            const candidate: State = {
                ...current,
                background: [...frame.background],
                active: frame.active,
                layers: order.map((index, position) => ({
                    ...current.layers[index],
                    name: frame.layers[position].name,
                    visible: frame.layers[position].visible,
                })),
            };
            validate(candidate, this.profile);
            this.state = candidate;
        } else if (c.before && c.after) this.state = cloneState(forward ? c.after : c.before);
        else
            for (const t of c.tiles!) {
                const data = forward ? t.after! : t.before;
                for (let y = 0; y < t.height; y++)
                    this.state.layers[c.layer!].pixels.set(
                        data.subarray(y * t.width * 4, (y + 1) * t.width * 4),
                        ((t.y + y) * this.state.width + t.x) * 4,
                    );
            }
        if (c.layer !== undefined && c.visible !== undefined)
            this.state.layers[c.layer].visible = forward ? true : c.visible;
        this.revision = forward ? c.afterId : c.beforeId;
    }
}
