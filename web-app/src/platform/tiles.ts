import { createSurface, context2D, type Context2D, type Surface } from './surface';

export interface PixelRect {
    x: number;
    y: number;
    width: number;
    height: number;
}
/** Exact backing-pixel culling supplied by a scene-generated world viewport. */
export interface TileViewport extends PixelRect {
    deviceBounds?: PixelRect;
}
export type TileTransform = (
    data: Uint8ClampedArray,
    x: number,
    y: number,
    width: number,
    height: number,
) => void;
interface ImageOwner {
    owner: object;
    pixels: Uint8ClampedArray;
    width: number;
    height: number;
    halo: number;
    factor: number;
    crop?: PixelRect;
    tiles: Map<number, PixelTile>;
}
interface PixelTile {
    owner: ImageOwner;
    key: number;
    sourceX: number;
    sourceY: number;
    surfaceX: number;
    surfaceY: number;
    sourceWidth: number;
    sourceHeight: number;
    surface: Surface;
    context: Context2D;
    image?: ImageData;
    pending: PixelRect[] | 'all';
    bytes: number;
}

/** Bounded renderer storage; authoritative pixels are never borrowed as writable ImageData. */
export class PixelTileCache {
    private owners = new WeakMap<object, ImageOwner>();
    private recent = new Map<PixelTile, undefined>();
    private bytes = 0;
    private evictions = 0;
    private uploadedBytes = 0;
    private uploads = 0;
    private largestSurface = 0;
    private transientTiles = 0;
    private lastTileSize = 510;
    private lastHalo = 1;
    private lastFactor = 1;
    private visibleRasterCount = 1;
    private preparation?: { key: unknown[]; owner: object; cursor: Generator<void, void, void> };
    constructor(
        readonly maxTiles = 64,
        readonly byteBudget = 128 * 1024 * 1024,
        private readonly cropToCanvas = false,
    ) {
        if (
            !Number.isSafeInteger(maxTiles) ||
            maxTiles < 1 ||
            maxTiles > 64 ||
            !Number.isSafeInteger(byteBudget) ||
            byteBudget < 512 * 512 * 8 ||
            byteBudget > 128 * 1024 * 1024 ||
            typeof cropToCanvas !== 'boolean'
        )
            throw Error('렌더 타일의 개수 또는 메모리 예산이 올바르지 않습니다.');
    }
    get stats(): {
        tiles: number;
        estimatedBytes: number;
        maxTiles: number;
        byteBudget: number;
        evictions: number;
        uploads: number;
        putImageDataBytes: number;
        largestSurfaceDimension: number;
        tileSize: number;
        halo: number;
        mipFactor: number;
    } {
        return {
            tiles: this.recent.size + this.transientTiles,
            estimatedBytes: this.bytes,
            maxTiles: this.maxTiles,
            byteBudget: this.byteBudget,
            evictions: this.evictions,
            uploads: this.uploads,
            putImageDataBytes: this.uploadedBytes,
            largestSurfaceDimension: this.largestSurface,
            tileSize: this.lastTileSize,
            halo: this.lastHalo,
            mipFactor: this.lastFactor,
        };
    }
    beginFrame(visibleRasterCount: number): void {
        if (!Number.isSafeInteger(visibleRasterCount) || visibleRasterCount < 0 || visibleRasterCount > 32)
            throw Error('표시할 래스터 개수가 올바르지 않습니다.');
        const next = Math.max(1, visibleRasterCount);
        if (next !== this.visibleRasterCount) this.cancelPrepare();
        this.visibleRasterCount = next;
    }
    private discard(tile: PixelTile): void {
        this.recent.delete(tile);
        tile.owner.tiles.delete(tile.key);
        this.bytes -= tile.bytes;
        tile.image = undefined;
        tile.pending = [];
        // Drop backing storage promptly instead of waiting for a detached Canvas to be collected.
        tile.surface.width = 0;
        tile.surface.height = 0;
    }
    retain(owners: Iterable<object>): void {
        const keep = new Set(owners);
        if (this.preparation && !keep.has(this.preparation.owner)) this.cancelPrepare();
        for (const tile of this.recent.keys()) {
            if (keep.has(tile.owner.owner)) continue;
            this.owners.delete(tile.owner.owner);
            this.discard(tile);
        }
    }
    clear(): void {
        this.cancelPrepare();
        for (const tile of this.recent.keys()) this.discard(tile);
        this.owners = new WeakMap();
    }
    private markDirty(image: ImageOwner, dirty?: PixelRect[] | 'all'): void {
        for (const tile of image.tiles.values()) {
            if (dirty === 'all') tile.pending = 'all';
            if (!dirty || dirty === 'all' || tile.pending === 'all') continue;
            for (const rect of dirty) {
                if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite))
                    throw Error('렌더 변경 영역이 올바르지 않습니다.');
                if (rect.width <= 0 || rect.height <= 0) continue;
                const x = Math.max(tile.sourceX, Math.floor(rect.x)),
                    y = Math.max(tile.sourceY, Math.floor(rect.y)),
                    right = Math.min(tile.sourceX + tile.sourceWidth, Math.ceil(rect.x + rect.width)),
                    bottom = Math.min(tile.sourceY + tile.sourceHeight, Math.ceil(rect.y + rect.height));
                if (x >= right || y >= bottom) continue;
                const w = right - x,
                    h = bottom - y;
                if (!tile.pending.some((r) => r.x === x && r.y === y && r.width === w && r.height === h))
                    tile.pending.push({ x, y, width: w, height: h });
                // Bound dirty-rectangle metadata; densely changed mip tiles refresh in full.
                if (tile.pending.length > 32) {
                    tile.pending = 'all';
                    break;
                }
            }
        }
    }
    /** Preserve source dirtiness even when final-scene hits skip this owner's draw. */
    invalidate(owner: object, dirty?: PixelRect[] | 'all'): void {
        if (!dirty) return;
        try {
            if (dirty !== 'all')
                for (const rect of dirty)
                    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite))
                        throw Error('렌더 변경 영역이 올바르지 않습니다.');
            this.cancelPrepare();
            const image = this.owners.get(owner);
            if (!image) return;
            if (dirty !== 'all' && image.factor > 1)
                dirty = dirty.map((rect) => {
                    const x = Math.floor(rect.x / image.factor),
                        y = Math.floor(rect.y / image.factor);
                    return {
                        x,
                        y,
                        width: Math.ceil((rect.x + rect.width) / image.factor) - x,
                        height: Math.ceil((rect.y + rect.height) / image.factor) - y,
                    };
                });
            this.markDirty(image, dirty);
        } catch (error) {
            this.clear();
            throw error;
        }
    }
    private drawReduced(
        context: Context2D,
        pixels: Uint8ClampedArray,
        width: number,
        height: number,
        viewport: PixelRect,
        offsetX: number,
        offsetY: number,
        transform: TileTransform | undefined,
        matrix: DOMMatrix,
    ): void {
        const imageLeft = matrix.e + offsetX * matrix.a,
            imageTop = matrix.f + offsetY * matrix.d,
            imageRight = imageLeft + width * matrix.a,
            imageBottom = imageTop + height * matrix.d,
            left = Math.max(0, Math.floor(imageLeft), Math.floor(matrix.e + viewport.x * matrix.a)),
            top = Math.max(0, Math.floor(imageTop), Math.floor(matrix.f + viewport.y * matrix.d)),
            right = Math.min(
                context.canvas.width,
                Math.ceil(imageRight),
                Math.ceil(matrix.e + (viewport.x + viewport.width) * matrix.a),
            ),
            bottom = Math.min(
                context.canvas.height,
                Math.ceil(imageBottom),
                Math.ceil(matrix.f + (viewport.y + viewport.height) * matrix.d),
            );
        // Extreme zoom can project an entire native document into a few pixels.
        // Sample only that device region; no source-sized Canvas or scratch image.
        for (let ty = top; ty < bottom; ty += 512)
            for (let tx = left; tx < right; tx += 512) {
                const w = Math.min(512, right - tx),
                    h = Math.min(512, bottom - ty),
                    bytes = w * h * 8;
                while (
                    this.recent.size + this.transientTiles >= this.maxTiles ||
                    this.bytes + bytes > this.byteBudget
                ) {
                    const oldest = this.recent.keys().next().value;
                    if (!oldest) throw Error('렌더 타일 메모리를 확보하지 못했습니다.');
                    this.discard(oldest);
                    this.evictions++;
                }
                let surface: Surface | undefined;
                this.bytes += bytes;
                this.transientTiles++;
                try {
                    surface = createSurface(w, h);
                    const image = new ImageData(w, h),
                        data = image.data;
                    for (let y = 0; y < h; y++)
                        for (let x = 0; x < w; x++) {
                            const deviceX = tx + x,
                                deviceY = ty + y,
                                sx = (deviceX + 0.5 - imageLeft) / matrix.a - 0.5,
                                sy = (deviceY + 0.5 - imageTop) / matrix.d - 0.5,
                                baseX = Math.floor(sx),
                                baseY = Math.floor(sy),
                                fractionX = sx - baseX,
                                fractionY = sy - baseY,
                                output = (y * w + x) * 4;
                            let alpha = 0,
                                red = 0,
                                green = 0,
                                blue = 0;
                            for (let yy = 0; yy < 2; yy++)
                                for (let xx = 0; xx < 2; xx++) {
                                    const px = Math.max(0, Math.min(width - 1, baseX + xx)),
                                        py = Math.max(0, Math.min(height - 1, baseY + yy)),
                                        source = (py * width + px) * 4,
                                        weight =
                                            (xx ? fractionX : 1 - fractionX) *
                                            (yy ? fractionY : 1 - fractionY);
                                    let r = pixels[source],
                                        g = pixels[source + 1],
                                        b = pixels[source + 2],
                                        a = pixels[source + 3];
                                    if (transform) {
                                        data.set(pixels.subarray(source, source + 4), output);
                                        transform(data.subarray(output, output + 4), px, py, 1, 1);
                                        r = data[output];
                                        g = data[output + 1];
                                        b = data[output + 2];
                                        a = data[output + 3];
                                    }
                                    const contribution = (a / 255) * weight;
                                    alpha += contribution;
                                    red += r * contribution;
                                    green += g * contribution;
                                    blue += b * contribution;
                                }
                            const coverageX = Math.max(
                                    0,
                                    Math.min(deviceX + 1, imageRight) - Math.max(deviceX, imageLeft),
                                ),
                                coverageY = Math.max(
                                    0,
                                    Math.min(deviceY + 1, imageBottom) - Math.max(deviceY, imageTop),
                                );
                            data[output] = alpha ? Math.round(red / alpha) : 0;
                            data[output + 1] = alpha ? Math.round(green / alpha) : 0;
                            data[output + 2] = alpha ? Math.round(blue / alpha) : 0;
                            data[output + 3] = Math.round(alpha * coverageX * coverageY * 255);
                        }
                    context2D(surface).putImageData(image, 0, 0);
                    this.uploads++;
                    this.uploadedBytes += w * h * 4;
                    this.largestSurface = Math.max(this.largestSurface, w, h);
                    context.save();
                    try {
                        context.setTransform(1, 0, 0, 1, 0, 0);
                        context.drawImage(surface, tx, ty);
                    } finally {
                        context.restore();
                    }
                } finally {
                    if (surface) {
                        surface.width = 0;
                        surface.height = 0;
                    }
                    this.bytes -= bytes;
                    this.transientTiles--;
                }
            }
    }
    /**
     * viewport is in document/world coordinates; offsets place this image in that world.
     * An omitted dirty list means unchanged pixels. 'all' invalidates existing tiles too.
     * transform receives fresh copied rows (height=1), including halo coordinates. It must
     * finish synchronously and must not retain the writable view. Its identity/parameters
     * belong to owner: use a new owner or dirty='all' when those parameters change.
     * estimatedBytes includes ImageData/Canvas RGBA estimates and bounded mip scratch, not RSS/GPU peaks.
     */
    draw(
        context: Context2D,
        owner: object,
        pixels: Uint8ClampedArray,
        width: number,
        height: number,
        viewport: TileViewport,
        dirty?: PixelRect[] | 'all',
        offsetX = 0,
        offsetY = 0,
        transform?: TileTransform,
    ): void {
        const cursor = this.walkTiles(
            context,
            owner,
            pixels,
            width,
            height,
            viewport,
            dirty,
            offsetX,
            offsetY,
            transform,
            false,
        );
        try {
            while (!cursor.next().done) {
                /* The synchronous API drains the same pixel algorithm. */
            }
        } finally {
            cursor.return();
        }
    }
    /** Advance bounded source rows without painting the destination (up to65536 samples). Stable arguments
     * resume the current cursor. Invalidate after pixel changes; transform parameters belong
     * to owner identity. factor1 remains the synchronous draw fast path. */
    prepare(
        context: Context2D,
        owner: object,
        pixels: Uint8ClampedArray,
        width: number,
        height: number,
        viewport: TileViewport,
        dirty?: PixelRect[] | 'all',
        offsetX = 0,
        offsetY = 0,
        transform?: TileTransform,
        matrix = context.getTransform(),
    ): boolean {
        const key: unknown[] = [
            context,
            owner,
            pixels,
            width,
            height,
            viewport.x,
            viewport.y,
            viewport.width,
            viewport.height,
            viewport.deviceBounds?.x,
            viewport.deviceBounds?.y,
            viewport.deviceBounds?.width,
            viewport.deviceBounds?.height,
            dirty,
            offsetX,
            offsetY,
            !!transform,
            matrix.a,
            matrix.b,
            matrix.c,
            matrix.d,
            matrix.e,
            matrix.f,
            context.canvas.width,
            context.canvas.height,
        ];
        let pending = this.preparation;
        if (
            !pending ||
            pending.key.length !== key.length ||
            key.some((value, index) => value !== pending!.key[index])
        ) {
            pending = {
                key,
                owner,
                cursor: this.walkTiles(
                    context,
                    owner,
                    pixels,
                    width,
                    height,
                    viewport,
                    dirty,
                    offsetX,
                    offsetY,
                    transform,
                    true,
                    matrix,
                ),
            };
        } else this.preparation = undefined;
        // Detach before next(): a failed running cursor must not re-enter itself through clear().
        const step = pending.cursor.next();
        this.preparation = step.done ? undefined : pending;
        return !!step.done;
    }
    cancelPrepare(): void {
        const pending = this.preparation;
        this.preparation = undefined;
        pending?.cursor.return();
    }
    private *walkTiles(
        context: Context2D,
        owner: object,
        pixels: Uint8ClampedArray,
        width: number,
        height: number,
        viewport: TileViewport,
        dirty: PixelRect[] | 'all' | undefined,
        offsetX: number,
        offsetY: number,
        transform: TileTransform | undefined,
        preparing: boolean,
        preparedMatrix?: DOMMatrix,
    ): Generator<void, void, void> {
        if (
            !Number.isSafeInteger(width) ||
            !Number.isSafeInteger(height) ||
            width < 1 ||
            height < 1 ||
            width > 32768 ||
            height > 32768 ||
            pixels.length !== width * height * 4 ||
            ![viewport.x, viewport.y, viewport.width, viewport.height, offsetX, offsetY].every(
                Number.isFinite,
            ) ||
            viewport.width < 0 ||
            viewport.height < 0
        )
            throw Error('렌더 이미지 또는 화면 영역이 올바르지 않습니다.');
        if (viewport.deviceBounds) {
            const bounds = viewport.deviceBounds;
            if (
                ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) ||
                bounds.x < 0 ||
                bounds.y < 0 ||
                bounds.width < 0 ||
                bounds.height < 0 ||
                bounds.x + bounds.width > context.canvas.width ||
                bounds.y + bounds.height > context.canvas.height
            )
                throw Error('렌더 device 표시 영역이 올바르지 않습니다.');
        }
        const originalWidth = width,
            originalHeight = height,
            matrix = preparedMatrix ? DOMMatrix.fromMatrix(preparedMatrix) : context.getTransform();
        if (matrix.b || matrix.c || matrix.a <= 0 || matrix.d <= 0)
            throw Error('렌더 타일은 축에 정렬된 양수 배율이 필요합니다.');
        this.cancelPrepare();
        const scale = Math.min(matrix.a, matrix.d);
        let factor = 1,
            surfaceLimit = 512,
            scratchBytes = 0;
        // Keep the complete visible working set inside the shared cache. Mip cells
        // average every source pixel in premultiplied alpha, including thin marks.
        if (scale < 1) {
            for (;;) {
                scratchBytes =
                    factor === 1
                        ? 0
                        : 512 * 4 * 8 + 512 + (transform ? Math.min(width, 512 * factor) * 4 : 0);
                surfaceLimit = Math.min(512, Math.floor(Math.sqrt((this.byteBudget - scratchBytes) / 8)));
                const mipWidth = Math.ceil(width / factor),
                    mipHeight = Math.ceil(height / factor),
                    mipScale = scale * factor,
                    mipHalo = mipScale >= 1 ? 1 : Math.ceil(0.5 / mipScale) + 1,
                    size = surfaceLimit - mipHalo * 2,
                    left = Math.max(0, (viewport.x - offsetX) / factor),
                    top = Math.max(0, (viewport.y - offsetY) / factor),
                    right = Math.min(mipWidth, (viewport.x + viewport.width - offsetX) / factor),
                    bottom = Math.min(mipHeight, (viewport.y + viewport.height - offsetY) / factor),
                    columns = Math.ceil(mipWidth / size),
                    rows = Math.ceil(mipHeight / size),
                    firstColumn = Math.max(0, Math.floor((left - 1) / size)),
                    lastColumn = Math.min(columns - 1, Math.floor(right / size)),
                    firstRow = Math.max(0, Math.floor((top - 1) / size)),
                    lastRow = Math.min(rows - 1, Math.floor(bottom / size)),
                    count =
                        left >= right || top >= bottom
                            ? 0
                            : (lastColumn - firstColumn + 1) * (lastRow - firstRow + 1);
                let columnPixels = 0,
                    rowPixels = 0;
                if (size > 0 && count > 0) {
                    for (let column = firstColumn; column <= lastColumn; column++)
                        columnPixels +=
                            Math.min(mipWidth, (column + 1) * size + mipHalo) -
                            Math.max(0, column * size - mipHalo);
                    for (let row = firstRow; row <= lastRow; row++)
                        rowPixels +=
                            Math.min(mipHeight, (row + 1) * size + mipHalo) -
                            Math.max(0, row * size - mipHalo);
                }
                if (
                    (size > 0 &&
                        mipScale >= 0.5 &&
                        count <= Math.max(1, Math.floor(this.maxTiles / this.visibleRasterCount)) &&
                        columnPixels * rowPixels * 8 <=
                            (this.byteBudget - scratchBytes) / this.visibleRasterCount) ||
                    factor >= 32768
                )
                    break;
                factor *= 2;
            }
        }
        if (factor >= 32768 && scale * factor < 0.5) {
            factor = 1;
            surfaceLimit = 512;
            scratchBytes = 0;
        }
        if (preparing && factor === 1) return;
        if (factor > 1) {
            width = Math.ceil(width / factor);
            height = Math.ceil(height / factor);
            viewport = {
                x: viewport.x / factor,
                y: viewport.y / factor,
                width: viewport.width / factor,
                height: viewport.height / factor,
            };
            offsetX /= factor;
            offsetY /= factor;
            matrix.scaleSelf(factor, factor);
            if (dirty && dirty !== 'all')
                dirty = dirty.map((rect) => {
                    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite))
                        throw Error('렌더 변경 영역이 올바르지 않습니다.');
                    const x = Math.floor(rect.x / factor),
                        y = Math.floor(rect.y / factor);
                    return {
                        x,
                        y,
                        width: Math.ceil((rect.x + rect.width) / factor) - x,
                        height: Math.ceil((rect.y + rect.height) / factor) - y,
                    };
                });
        }
        const mipScale = Math.min(matrix.a, matrix.d),
            halo = mipScale >= 1 ? 1 : Math.ceil(0.5 / mipScale) + 1,
            tileSize = surfaceLimit - halo * 2;
        this.lastFactor = factor;
        if (tileSize < 1) {
            const previous = this.owners.get(owner);
            if (previous) for (const tile of previous.tiles.values()) this.discard(tile);
            this.owners.delete(owner);
            this.lastTileSize = 0;
            this.lastHalo = halo;
            if (!preparing)
                this.drawReduced(
                    context,
                    pixels,
                    width,
                    height,
                    viewport,
                    offsetX,
                    offsetY,
                    transform,
                    matrix,
                );
            return;
        }
        this.lastTileSize = tileSize;
        this.lastHalo = halo;
        let crop: PixelRect | undefined;
        if (this.cropToCanvas && factor === 1) {
            // Use the whole Canvas, never the changing scene-miss rectangle.
            const x = Math.max(0, Math.min(width, Math.floor(-matrix.e / matrix.a - offsetX) - halo)),
                y = Math.max(0, Math.min(height, Math.floor(-matrix.f / matrix.d - offsetY) - halo));
            crop = {
                x,
                y,
                width: Math.max(
                    0,
                    Math.min(
                        width,
                        Math.ceil((context.canvas.width - matrix.e) / matrix.a - offsetX) + halo,
                    ) - x,
                ),
                height: Math.max(
                    0,
                    Math.min(
                        height,
                        Math.ceil((context.canvas.height - matrix.f) / matrix.d - offsetY) + halo,
                    ) - y,
                ),
            };
        }
        let image = this.owners.get(owner);
        if (
            image &&
            (image.pixels !== pixels ||
                image.width !== originalWidth ||
                image.height !== originalHeight ||
                image.halo !== halo ||
                image.factor !== factor ||
                image.crop?.x !== crop?.x ||
                image.crop?.y !== crop?.y ||
                image.crop?.width !== crop?.width ||
                image.crop?.height !== crop?.height)
        ) {
            for (const tile of image.tiles.values()) this.discard(tile);
            this.owners.delete(owner);
            image = undefined;
        }
        if (!image) {
            image = {
                owner,
                pixels,
                width: originalWidth,
                height: originalHeight,
                halo,
                factor,
                crop,
                tiles: new Map(),
            };
            this.owners.set(owner, image);
        }
        let scratchLease = 0,
            work = 0,
            sums: Float64Array | undefined,
            uniform: Uint8Array | undefined,
            sourceRow: Uint8ClampedArray | undefined,
            rowWords: Uint32Array | undefined;
        try {
            const sourceWords =
                pixels.byteOffset % 4 === 0
                    ? new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.length / 4)
                    : undefined;
            this.markDirty(image, dirty);
            const left = Math.max(0, viewport.x - offsetX),
                top = Math.max(0, viewport.y - offsetY),
                right = Math.min(width, viewport.x + viewport.width - offsetX),
                bottom = Math.min(height, viewport.y + viewport.height - offsetY);
            if (left >= right || top >= bottom) return;
            const viewLeft =
                    viewport.deviceBounds?.x ?? Math.max(0, Math.floor(matrix.e + viewport.x * matrix.a)),
                viewTop =
                    viewport.deviceBounds?.y ?? Math.max(0, Math.floor(matrix.f + viewport.y * matrix.d)),
                viewRight = viewport.deviceBounds
                    ? viewport.deviceBounds.x + viewport.deviceBounds.width
                    : Math.min(
                          context.canvas.width,
                          Math.ceil(matrix.e + (viewport.x + viewport.width) * matrix.a),
                      ),
                viewBottom = viewport.deviceBounds
                    ? viewport.deviceBounds.y + viewport.deviceBounds.height
                    : Math.min(
                          context.canvas.height,
                          Math.ceil(matrix.f + (viewport.y + viewport.height) * matrix.d),
                      );
            const columns = Math.ceil(width / tileSize),
                firstColumn = Math.max(0, Math.floor((left - 1) / tileSize)),
                firstRow = Math.max(0, Math.floor((top - 1) / tileSize)),
                lastColumn = Math.min(columns - 1, Math.floor(right / tileSize)),
                lastRow = Math.min(Math.ceil(height / tileSize) - 1, Math.floor(bottom / tileSize));
            for (let row = firstRow; row <= lastRow; row++) {
                for (let column = firstColumn; column <= lastColumn; column++) {
                    const x = column * tileSize,
                        y = row * tileSize,
                        w = Math.min(tileSize, width - x),
                        h = Math.min(tileSize, height - y);
                    // Internal boundaries partition device pixels instead of separately
                    // antialiasing two clip edges over translucent pixels.
                    const clipX =
                            x === 0
                                ? Math.floor(matrix.e + offsetX * matrix.a)
                                : Math.round(matrix.e + (offsetX + x) * matrix.a),
                        clipY =
                            y === 0
                                ? Math.floor(matrix.f + offsetY * matrix.d)
                                : Math.round(matrix.f + (offsetY + y) * matrix.d),
                        clipRight =
                            x + w === width
                                ? Math.ceil(matrix.e + (offsetX + width) * matrix.a)
                                : Math.round(matrix.e + (offsetX + x + w) * matrix.a),
                        clipBottom =
                            y + h === height
                                ? Math.ceil(matrix.f + (offsetY + height) * matrix.d)
                                : Math.round(matrix.f + (offsetY + y + h) * matrix.d);
                    if (
                        clipX >= clipRight ||
                        clipY >= clipBottom ||
                        clipRight <= viewLeft ||
                        clipX >= viewRight ||
                        clipBottom <= viewTop ||
                        clipY >= viewBottom
                    )
                        continue;
                    const key = row * columns + column,
                        previousTile = image.tiles.get(key);
                    if (
                        factor > 1 &&
                        !sums &&
                        (!previousTile || previousTile.pending === 'all' || previousTile.pending.length)
                    ) {
                        while (this.bytes + scratchBytes > this.byteBudget) {
                            const oldest = this.recent.keys().next().value;
                            if (!oldest) throw Error('렌더 작업 메모리를 확보하지 못했습니다.');
                            this.discard(oldest);
                            this.evictions++;
                        }
                        this.bytes += scratchBytes;
                        scratchLease = scratchBytes;
                        sums = new Float64Array(512 * 4);
                        uniform = new Uint8Array(512);
                        if (transform) {
                            sourceRow = new Uint8ClampedArray(Math.min(originalWidth, 512 * factor) * 4);
                            rowWords = new Uint32Array(sourceRow.buffer);
                        }
                    }
                    let tile = image.tiles.get(key);
                    if (!tile) {
                        const surfaceX = Math.max(0, x - halo),
                            surfaceY = Math.max(0, y - halo),
                            surfaceWidth = Math.min(width, x + w + halo) - surfaceX,
                            surfaceHeight = Math.min(height, y + h + halo) - surfaceY,
                            sourceX = Math.max(surfaceX, crop?.x ?? 0),
                            sourceY = Math.max(surfaceY, crop?.y ?? 0),
                            sourceWidth =
                                Math.min(width, x + w + halo, crop ? crop.x + crop.width : width) - sourceX,
                            sourceHeight =
                                Math.min(height, y + h + halo, crop ? crop.y + crop.height : height) -
                                sourceY,
                            bytes = (surfaceWidth * surfaceHeight + sourceWidth * sourceHeight) * 4;
                        if (sourceWidth <= 0 || sourceHeight <= 0) continue;
                        while (this.recent.size >= this.maxTiles || this.bytes + bytes > this.byteBudget) {
                            const oldest = this.recent.keys().next().value;
                            if (!oldest) throw Error('렌더 타일 메모리를 확보하지 못했습니다.');
                            this.discard(oldest);
                            this.evictions++;
                        }
                        let surface: Surface | undefined;
                        try {
                            surface = createSurface(surfaceWidth, surfaceHeight);
                            tile = {
                                owner: image,
                                key,
                                sourceX,
                                sourceY,
                                surfaceX,
                                surfaceY,
                                sourceWidth,
                                sourceHeight,
                                surface,
                                context: context2D(surface),
                                image: new ImageData(sourceWidth, sourceHeight),
                                pending: 'all',
                                bytes,
                            };
                        } catch (error) {
                            if (surface) {
                                surface.width = 0;
                                surface.height = 0;
                            }
                            throw error;
                        }
                        image.tiles.set(key, tile);
                        this.recent.set(tile, undefined);
                        this.bytes += bytes;
                        this.largestSurface = Math.max(this.largestSurface, surfaceWidth, surfaceHeight);
                    } else {
                        this.recent.delete(tile);
                        this.recent.set(tile, undefined);
                    }
                    const updates =
                        tile.pending === 'all'
                            ? [
                                  {
                                      x: tile.sourceX,
                                      y: tile.sourceY,
                                      width: tile.sourceWidth,
                                      height: tile.sourceHeight,
                                  },
                              ]
                            : tile.pending;
                    const data = tile.image!.data;
                    for (const rect of updates) {
                        const localX = rect.x - tile.sourceX,
                            localY = rect.y - tile.sourceY;
                        if (factor === 1)
                            for (let line = 0; line < rect.height; line++) {
                                const start = ((localY + line) * tile.sourceWidth + localX) * 4,
                                    end = start + rect.width * 4,
                                    source = ((rect.y + line) * width + rect.x) * 4;
                                data.set(pixels.subarray(source, source + rect.width * 4), start);
                                transform?.(data.subarray(start, end), rect.x, rect.y + line, rect.width, 1);
                            }
                        else {
                            const words = new Uint32Array(data.buffer, data.byteOffset, data.length / 4);
                            let constant =
                                sourceWords && !transform
                                    ? sourceWords[rect.y * factor * originalWidth + rect.x * factor]
                                    : undefined;
                            if (constant !== undefined) {
                                const left = rect.x * factor,
                                    right = Math.min(originalWidth, (rect.x + rect.width) * factor),
                                    top = rect.y * factor,
                                    bottom = Math.min(originalHeight, (rect.y + rect.height) * factor);
                                uniformBlock: for (let y = top; y < bottom; y++) {
                                    // Validated source rows are at most32768 pixels; keep checkpoints outside the hot loop.
                                    if (preparing) {
                                        if (work + right - left > 65536) {
                                            work = 0;
                                            yield;
                                        }
                                        work += right - left;
                                    }
                                    let at = y * originalWidth + left;
                                    const end = y * originalWidth + right;
                                    for (; at + 3 < end; at += 4) {
                                        if (
                                            sourceWords![at] !== constant ||
                                            sourceWords![at + 1] !== constant ||
                                            sourceWords![at + 2] !== constant ||
                                            sourceWords![at + 3] !== constant
                                        ) {
                                            constant = undefined;
                                            break uniformBlock;
                                        }
                                    }
                                    for (; at < end; at++) {
                                        if (sourceWords![at] !== constant) {
                                            constant = undefined;
                                            break uniformBlock;
                                        }
                                    }
                                }
                            }
                            if (constant !== undefined) {
                                if (!pixels[(rect.y * factor * originalWidth + rect.x * factor) * 4 + 3])
                                    constant = 0;
                                for (let line = 0; line < rect.height; line++) {
                                    if (preparing) {
                                        if (work + rect.width > 65536) {
                                            work = 0;
                                            yield;
                                        }
                                        work += rect.width;
                                    }
                                    const start = (localY + line) * tile.sourceWidth + localX;
                                    words.fill(constant, start, start + rect.width);
                                }
                            } else
                                for (let line = 0; line < rect.height; line++) {
                                    sums!.fill(0);
                                    uniform!.fill(1);
                                    const sourceY = (rect.y + line) * factor,
                                        bottom = Math.min(originalHeight, sourceY + factor),
                                        sourceX = rect.x * factor,
                                        rowWidth =
                                            Math.min(originalWidth, (rect.x + rect.width) * factor) - sourceX;
                                    for (let sy = sourceY; sy < bottom; sy++) {
                                        if (preparing) {
                                            if (work + rowWidth > 65536) {
                                                work = 0;
                                                yield;
                                            }
                                            work += rowWidth;
                                        }
                                        let input = pixels,
                                            inputWords = sourceWords,
                                            rowStart = sy * originalWidth * 4;
                                        if (sourceRow) {
                                            sourceRow.set(
                                                pixels.subarray(
                                                    rowStart + sourceX * 4,
                                                    rowStart + (sourceX + rowWidth) * 4,
                                                ),
                                            );
                                            transform!(
                                                sourceRow.subarray(0, rowWidth * 4),
                                                sourceX,
                                                sy,
                                                rowWidth,
                                                1,
                                            );
                                            input = sourceRow;
                                            inputWords = rowWords;
                                            rowStart = -sourceX * 4;
                                        }
                                        for (let column = 0; column < rect.width; column++) {
                                            const x = (rect.x + column) * factor,
                                                right = Math.min(originalWidth, x + factor),
                                                output =
                                                    ((localY + line) * tile.sourceWidth + localX + column) *
                                                    4,
                                                sum = column * 4;
                                            for (let sx = x; sx < right; sx++) {
                                                const at = rowStart + sx * 4;
                                                if (sy === sourceY && sx === x) {
                                                    if (inputWords && data.byteOffset % 4 === 0)
                                                        words[output / 4] = inputWords[at / 4];
                                                    else {
                                                        data[output] = input[at];
                                                        data[output + 1] = input[at + 1];
                                                        data[output + 2] = input[at + 2];
                                                        data[output + 3] = input[at + 3];
                                                    }
                                                    continue;
                                                }
                                                if (uniform![column]) {
                                                    const equal = inputWords
                                                        ? inputWords[at / 4] === words[output / 4]
                                                        : input[at] === data[output] &&
                                                          input[at + 1] === data[output + 1] &&
                                                          input[at + 2] === data[output + 2] &&
                                                          input[at + 3] === data[output + 3];
                                                    if (equal) continue;
                                                    uniform![column] = 0;
                                                    const matched = (sy - sourceY) * (right - x) + sx - x,
                                                        alpha = data[output + 3] * matched;
                                                    sums![sum] = data[output] * alpha;
                                                    sums![sum + 1] = data[output + 1] * alpha;
                                                    sums![sum + 2] = data[output + 2] * alpha;
                                                    sums![sum + 3] = alpha;
                                                }
                                                const alpha = input[at + 3];
                                                sums![sum] += input[at] * alpha;
                                                sums![sum + 1] += input[at + 1] * alpha;
                                                sums![sum + 2] += input[at + 2] * alpha;
                                                sums![sum + 3] += alpha;
                                            }
                                        }
                                    }
                                    for (let column = 0; column < rect.width; column++) {
                                        const output =
                                                ((localY + line) * tile.sourceWidth + localX + column) * 4,
                                            sum = column * 4;
                                        if (!uniform![column]) {
                                            const alpha = sums![sum + 3],
                                                count =
                                                    Math.min(
                                                        factor,
                                                        originalWidth - (rect.x + column) * factor,
                                                    ) *
                                                    (bottom - sourceY);
                                            data[output] = alpha ? Math.round(sums![sum] / alpha) : 0;
                                            data[output + 1] = alpha ? Math.round(sums![sum + 1] / alpha) : 0;
                                            data[output + 2] = alpha ? Math.round(sums![sum + 2] / alpha) : 0;
                                            data[output + 3] = Math.round(alpha / count);
                                        } else if (!data[output + 3])
                                            data[output] = data[output + 1] = data[output + 2] = 0;
                                    }
                                }
                        }
                        tile.context.putImageData(
                            tile.image!,
                            tile.sourceX - tile.surfaceX,
                            tile.sourceY - tile.surfaceY,
                            localX,
                            localY,
                            rect.width,
                            rect.height,
                        );
                        this.uploads++;
                        this.uploadedBytes += rect.width * rect.height * 4;
                    }
                    tile.pending = [];
                    if (preparing) continue;
                    const clip = new Path2D();
                    const left = factor === 1 ? clipX : Math.max(clipX, matrix.e + offsetX * matrix.a),
                        top = factor === 1 ? clipY : Math.max(clipY, matrix.f + offsetY * matrix.d),
                        right =
                            factor === 1
                                ? clipRight
                                : Math.min(
                                      clipRight,
                                      matrix.e + (offsetX + originalWidth / factor) * matrix.a,
                                  ),
                        bottom =
                            factor === 1
                                ? clipBottom
                                : Math.min(
                                      clipBottom,
                                      matrix.f + (offsetY + originalHeight / factor) * matrix.d,
                                  );
                    clip.rect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
                    context.save();
                    try {
                        context.setTransform(1, 0, 0, 1, 0, 0);
                        context.clip(clip);
                        context.setTransform(matrix);
                        context.drawImage(tile.surface, tile.surfaceX + offsetX, tile.surfaceY + offsetY);
                    } finally {
                        context.restore();
                    }
                }
            }
        } catch (error) {
            this.clear();
            throw error;
        } finally {
            this.bytes -= scratchLease;
        }
    }
}

export interface SceneRaster {
    owner: object;
    pixels: Uint8ClampedArray;
    width: number;
    height: number;
    dirty?: PixelRect[] | 'all';
    x?: number;
    y?: number;
    /** Parameters belong to owner identity, as in PixelTileCache.draw. */
    transform?: TileTransform;
}
interface SceneCell extends PixelRect {
    surface?: Surface;
    context?: Context2D;
    valid: boolean;
}

/**
 * Opaque final paper/layer cache, captured before transient UI overlays.
 * Source ImageData/Canvas and scene Canvas share an RGBA estimate, not RSS/GPU bounds.
 * Paint an opaque app background, draw prepare's viewport through source, restore the
 * paper clip, then always call finish, including when prepare reports a complete hit.
 * Call source.retain with all reusable owners; prepare registers dirty changes, so
 * subsequent source.draw calls omit dirty instead of registering the same edit twice.
 */
export class FinalSceneCache {
    source: PixelTileCache;
    private cells: SceneCell[] = [];
    private sceneBytes = 0;
    private key = '';
    private identities = new WeakMap<object, number>();
    private nextIdentity = 1;
    private target?: Surface;
    private targetWidth = 0;
    private targetHeight = 0;
    private uploads = 0;
    private uploadedBytes = 0;
    private evictions = 0;
    private largestSurface = 0;
    private captures = 0;
    private capturedPixels = 0;
    constructor(
        readonly maxTiles = 64,
        readonly byteBudget = 128 * 1024 * 1024,
    ) {
        this.source = new PixelTileCache(maxTiles, byteBudget);
    }
    get stats() {
        const source = this.source.stats;
        return {
            ...source,
            tiles: source.tiles + this.cells.length,
            estimatedBytes: source.estimatedBytes + this.sceneBytes,
            maxTiles: this.maxTiles,
            byteBudget: this.byteBudget,
            uploads: this.uploads + source.uploads,
            putImageDataBytes: this.uploadedBytes + source.putImageDataBytes,
            evictions: this.evictions + source.evictions,
            largestSurfaceDimension: Math.max(this.largestSurface, source.largestSurfaceDimension),
            sceneTiles: this.cells.length,
            sceneBytes: this.sceneBytes,
            sourceTiles: source.tiles,
            sourceEstimatedBytes: source.estimatedBytes,
            sceneCaptures: this.captures,
            // Logical Canvas copy area, not a measurement of GPU traffic.
            sceneCapturePixels: this.capturedPixels,
        };
    }
    clear(): void {
        const previous = this.source.stats;
        this.uploads += previous.uploads;
        this.uploadedBytes += previous.putImageDataBytes;
        this.evictions += previous.evictions;
        this.largestSurface = Math.max(this.largestSurface, previous.largestSurfaceDimension);
        this.source.clear();
        for (const cell of this.cells)
            if (cell.surface) {
                cell.surface.width = 0;
                cell.surface.height = 0;
            }
        this.cells = [];
        this.sceneBytes = 0;
        this.key = '';
        this.target = undefined;
        this.source = new PixelTileCache(this.maxTiles, this.byteBudget);
    }
    /** Mip preparation cannot retain an unfinished final-scene capture target. */
    fallbackSource(): PixelTileCache {
        if (this.cells.length || this.target) this.clear();
        return this.source;
    }
    prepare(
        ctx: Context2D,
        frame: {
            zoom: number;
            paperWidth: number;
            paperHeight: number;
            background: string;
            checker: string;
            viewport: PixelRect;
        },
        rasters: SceneRaster[],
    ): TileViewport | undefined {
        try {
            // An abandoned paint cannot validate a partially drawn main Canvas.
            if (this.target) this.clear();
            const matrix = ctx.getTransform(),
                width = ctx.canvas.width,
                height = ctx.canvas.height,
                viewport = frame.viewport;
            if (
                ![
                    matrix.a,
                    matrix.b,
                    matrix.c,
                    matrix.d,
                    matrix.e,
                    matrix.f,
                    frame.zoom,
                    frame.paperWidth,
                    frame.paperHeight,
                    viewport.x,
                    viewport.y,
                    viewport.width,
                    viewport.height,
                ].every(Number.isFinite) ||
                frame.zoom <= 0 ||
                frame.paperWidth <= 0 ||
                frame.paperHeight <= 0 ||
                viewport.width < 0 ||
                viewport.height < 0 ||
                rasters.length > 32
            )
                throw Error('최종 화면의 표시 영역이 올바르지 않습니다.');
            const signature: unknown[] = [
                width,
                height,
                matrix.a,
                matrix.b,
                matrix.c,
                matrix.d,
                matrix.e,
                matrix.f,
                frame.zoom,
                frame.paperWidth,
                frame.paperHeight,
                frame.background,
                frame.checker,
                viewport.x,
                viewport.y,
                viewport.width,
                viewport.height,
                ctx.imageSmoothingEnabled,
                ctx.imageSmoothingQuality,
            ];
            for (const raster of rasters) {
                if (
                    !Number.isSafeInteger(raster.width) ||
                    !Number.isSafeInteger(raster.height) ||
                    raster.width < 1 ||
                    raster.height < 1 ||
                    raster.width > 32768 ||
                    raster.height > 32768 ||
                    raster.pixels.length !== raster.width * raster.height * 4 ||
                    ![raster.x ?? 0, raster.y ?? 0].every(Number.isFinite)
                )
                    throw Error('표시할 래스터가 올바르지 않습니다.');
                if (raster.dirty && raster.dirty !== 'all')
                    for (const rect of raster.dirty)
                        if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite))
                            throw Error('렌더 변경 영역이 올바르지 않습니다.');
                for (const identity of [raster.owner, raster.pixels])
                    if (!this.identities.has(identity)) this.identities.set(identity, this.nextIdentity++);
                signature.push([
                    this.identities.get(raster.owner),
                    this.identities.get(raster.pixels),
                    raster.width,
                    raster.height,
                    raster.x ?? 0,
                    raster.y ?? 0,
                ]);
            }
            const key = JSON.stringify(signature);
            if (key !== this.key) {
                const planned: SceneCell[] = [],
                    working = new Set<string>(),
                    viewLeft = Math.max(0, Math.floor(matrix.e + viewport.x * matrix.a)),
                    viewTop = Math.max(0, Math.floor(matrix.f + viewport.y * matrix.d)),
                    viewRight = Math.min(
                        width,
                        Math.ceil(matrix.e + (viewport.x + viewport.width) * matrix.a),
                    ),
                    viewBottom = Math.min(
                        height,
                        Math.ceil(matrix.f + (viewport.y + viewport.height) * matrix.d),
                    );
                let reserved = 0;
                if (!matrix.b && !matrix.c && matrix.a === matrix.d && matrix.a >= 1) {
                    // Same510px source grid/device culling; stop once the full cache cannot fit.
                    for (const raster of rasters) {
                        const ox = raster.x ?? 0,
                            oy = raster.y ?? 0,
                            left = Math.max(0, viewport.x - ox),
                            top = Math.max(0, viewport.y - oy),
                            right = Math.min(raster.width, viewport.x + viewport.width - ox),
                            bottom = Math.min(raster.height, viewport.y + viewport.height - oy),
                            columns = Math.ceil(raster.width / 510);
                        if (left >= right || top >= bottom) continue;
                        for (
                            let row = Math.max(0, Math.floor((top - 1) / 510));
                            row <= Math.min(Math.ceil(raster.height / 510) - 1, Math.floor(bottom / 510)) &&
                            working.size <= this.maxTiles;
                            row++
                        )
                            for (
                                let col = Math.max(0, Math.floor((left - 1) / 510));
                                col <= Math.min(columns - 1, Math.floor(right / 510)) &&
                                working.size <= this.maxTiles;
                                col++
                            ) {
                                const x = col * 510,
                                    y = row * 510,
                                    w = Math.min(510, raster.width - x),
                                    h = Math.min(510, raster.height - y),
                                    l =
                                        x === 0
                                            ? Math.floor(matrix.e + ox * matrix.a)
                                            : Math.round(matrix.e + (ox + x) * matrix.a),
                                    t =
                                        y === 0
                                            ? Math.floor(matrix.f + oy * matrix.d)
                                            : Math.round(matrix.f + (oy + y) * matrix.d),
                                    r =
                                        x + w === raster.width
                                            ? Math.ceil(matrix.e + (ox + raster.width) * matrix.a)
                                            : Math.round(matrix.e + (ox + x + w) * matrix.a),
                                    b =
                                        y + h === raster.height
                                            ? Math.ceil(matrix.f + (oy + raster.height) * matrix.d)
                                            : Math.round(matrix.f + (oy + y + h) * matrix.d);
                                if (
                                    l < r &&
                                    t < b &&
                                    l < viewRight &&
                                    r > viewLeft &&
                                    t < viewBottom &&
                                    b > viewTop
                                )
                                    working.add(
                                        this.identities.get(raster.owner) + ':' + (row * columns + col),
                                    );
                            }
                        if (working.size > this.maxTiles) break;
                    }
                    if (working.size > this.maxTiles) {
                        const firstColumn = Math.max(0, Math.floor((Math.max(0, viewport.x) - 1) / 510)),
                            lastColumn = Math.min(
                                Math.ceil(frame.paperWidth / 510) - 1,
                                Math.floor(Math.min(frame.paperWidth, viewport.x + viewport.width) / 510),
                            ),
                            firstRow = Math.max(0, Math.floor((Math.max(0, viewport.y) - 1) / 510)),
                            lastRow = Math.min(
                                Math.ceil(frame.paperHeight / 510) - 1,
                                Math.floor(Math.min(frame.paperHeight, viewport.y + viewport.height) / 510),
                            );
                        // Preserve original source clip boundaries; split only inside a projected source cell.
                        planning: for (let row = firstRow; row <= lastRow; row++)
                            for (let column = firstColumn; column <= lastColumn; column++) {
                                const sx = column * 510,
                                    sy = row * 510,
                                    sw = Math.min(510, frame.paperWidth - sx),
                                    sh = Math.min(510, frame.paperHeight - sy),
                                    left = Math.max(
                                        viewLeft,
                                        column === 0
                                            ? Math.floor(matrix.e)
                                            : Math.round(matrix.e + sx * matrix.a),
                                    ),
                                    top = Math.max(
                                        viewTop,
                                        row === 0
                                            ? Math.floor(matrix.f)
                                            : Math.round(matrix.f + sy * matrix.d),
                                    ),
                                    right = Math.min(
                                        viewRight,
                                        sx + sw === frame.paperWidth
                                            ? Math.ceil(matrix.e + frame.paperWidth * matrix.a)
                                            : Math.round(matrix.e + (sx + sw) * matrix.a),
                                    ),
                                    bottom = Math.min(
                                        viewBottom,
                                        sy + sh === frame.paperHeight
                                            ? Math.ceil(matrix.f + frame.paperHeight * matrix.d)
                                            : Math.round(matrix.f + (sy + sh) * matrix.d),
                                    );
                                for (let y = top; y < bottom; y += 512)
                                    for (let x = left; x < right; x += 512) {
                                        const x2 = Math.min(right, x + 512),
                                            y2 = Math.min(bottom, y + 512),
                                            bytes = (x2 - x) * (y2 - y) * 4;
                                        if (
                                            planned.length >= this.maxTiles - 1 ||
                                            reserved + bytes + 512 * 512 * 8 > this.byteBudget
                                        ) {
                                            planned.length = 0;
                                            reserved = 0;
                                            break planning;
                                        }
                                        planned.push({
                                            x,
                                            y,
                                            width: x2 - x,
                                            height: y2 - y,
                                            valid: false,
                                        });
                                        reserved += bytes;
                                    }
                            }
                    }
                }
                // Preserve full-budget source reuse across fallback-to-fallback camera changes.
                if (this.cells.length || planned.length) this.clear();
                if (planned.length) {
                    this.cells = planned;
                    this.sceneBytes = reserved;
                    for (const cell of this.cells) {
                        cell.surface = createSurface(cell.width, cell.height);
                        cell.context = context2D(cell.surface);
                        this.largestSurface = Math.max(this.largestSurface, cell.width, cell.height);
                    }
                    this.source = new PixelTileCache(
                        this.maxTiles - planned.length,
                        this.byteBudget - reserved,
                        true,
                    );
                }
                this.key = key;
            }
            this.source.beginFrame(rasters.length);
            for (const raster of rasters) {
                this.source.invalidate(raster.owner, raster.dirty);
                if (!raster.dirty) continue;
                const halo = Math.ceil(matrix.a) + 1;
                for (const cell of this.cells) {
                    if (raster.dirty === 'all') {
                        cell.valid = false;
                        continue;
                    }
                    if (
                        raster.dirty.some((rect) => {
                            if (rect.width <= 0 || rect.height <= 0) return false;
                            const left = matrix.e + ((raster.x ?? 0) + rect.x) * matrix.a - halo,
                                top = matrix.f + ((raster.y ?? 0) + rect.y) * matrix.d - halo;
                            return (
                                left < cell.x + cell.width &&
                                top < cell.y + cell.height &&
                                left + rect.width * matrix.a + 2 * halo > cell.x &&
                                top + rect.height * matrix.d + 2 * halo > cell.y
                            );
                        })
                    )
                        cell.valid = false;
                }
            }
            if (!this.cells.length) return viewport;
            this.target = ctx.canvas;
            this.targetWidth = width;
            this.targetHeight = height;
            let left = Infinity,
                top = Infinity,
                right = -Infinity,
                bottom = -Infinity;
            for (const cell of this.cells)
                if (!cell.valid) {
                    left = Math.min(left, cell.x);
                    top = Math.min(top, cell.y);
                    right = Math.max(right, cell.x + cell.width);
                    bottom = Math.max(bottom, cell.y + cell.height);
                }
            return left === Infinity
                ? undefined
                : {
                      x: (left - matrix.e) / matrix.a,
                      y: (top - matrix.f) / matrix.d,
                      width: (right - left) / matrix.a,
                      height: (bottom - top) / matrix.d,
                      deviceBounds: {
                          x: left,
                          y: top,
                          width: right - left,
                          height: bottom - top,
                      },
                  };
        } catch (error) {
            this.clear();
            throw error;
        }
    }
    finish(ctx: Context2D): void {
        if (!this.target) return;
        try {
            if (
                ctx.canvas !== this.target ||
                ctx.canvas.width !== this.targetWidth ||
                ctx.canvas.height !== this.targetHeight
            )
                throw Error('그리는 동안 화면 크기 또는 대상이 변경되었습니다.');
            ctx.save();
            try {
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.imageSmoothingEnabled = false;
                ctx.globalAlpha = 1;
                ctx.globalCompositeOperation = 'source-over';
                for (const cell of this.cells) {
                    if (!cell.valid) {
                        cell.context!.imageSmoothingEnabled = false;
                        cell.context!.drawImage(
                            ctx.canvas,
                            cell.x,
                            cell.y,
                            cell.width,
                            cell.height,
                            0,
                            0,
                            cell.width,
                            cell.height,
                        );
                        cell.valid = true;
                        this.captures++;
                        this.capturedPixels += cell.width * cell.height;
                    } else ctx.drawImage(cell.surface!, cell.x, cell.y);
                }
            } finally {
                ctx.restore();
            }
        } catch (error) {
            this.clear();
            throw error;
        } finally {
            this.target = undefined;
        }
    }
}
