import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.resolve(
    process.env.PAINT_TILE_OUTPUT || path.join(root, '../build-web-work/task-planning/tiles'),
);
await fs.mkdir(output, { recursive: true });
const snapshot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mypaint-tiles-'))),
    sources = {};
for (const file of [
    'src/platform/tiles.ts',
    'src/platform/surface.ts',
    'src/engine/document.ts',
    'src/engine/format.ts',
]) {
    const target = path.join(snapshot, file),
        data = await fs.readFile(path.join(root, file));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    sources[file] = crypto.createHash('sha256').update(data).digest('hex');
}
await fs.writeFile(
    path.join(snapshot, 'index.html'),
    '<!doctype html><html><body>Tile renderer verification</body></html>',
);
await fs.writeFile(path.join(snapshot, 'package.json'), '{"type":"module"}');
await fs.symlink(path.join(root, 'node_modules'), path.join(snapshot, 'node_modules'), 'dir');
const server = await createServer({
    root: snapshot,
    configFile: false,
    optimizeDeps: { include: ['fflate'] },
    cacheDir: path.join(snapshot, '.vite-cache'),
    server: { host: '127.0.0.1', port: 8941, strictPort: true, fs: { allow: [snapshot, root] } },
    logLevel: 'warn',
});
const report = {
    sources,
    snapshot,
    pixelOracleBackend: 'CPU Canvas2D (willReadFrequently:true); byte-exact comparisons',
    gpuProbeScope: 'Independent browser rasterization diagnostics only; not GPU byte identity guarantees',
    checks: [],
    pageErrors: [],
};
let browser, watchdog;
try {
    await server.listen();
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PAINT_BROWSER_PATH || undefined,
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    watchdog = setTimeout(() => {
        report.timeout = true;
        void browser.close();
    }, 120000);
    const page = await browser.newPage();
    page.on('pageerror', (e) => report.pageErrors.push(e.message));
    report.browser = browser.version();
    await page.goto('http://127.0.0.1:8941/');
    report.checks = await page.evaluate(async () => {
        const { PixelTileCache, FinalSceneCache } = await import('/src/platform/tiles.ts'),
            { decodePng } = await import('/src/engine/format.ts');
        const OriginalCanvas = OffscreenCanvas,
            OriginalImage = ImageData,
            surfaces = [],
            checks = [];
        let guarding = false,
            largestCreated = 0,
            imageDataLargest = 0;
        globalThis.OffscreenCanvas = new Proxy(OriginalCanvas, {
            construct(target, args) {
                if (guarding && Math.max(args[0], args[1]) > 512) throw Error('Oversized cached Canvas');
                const canvas = Reflect.construct(target, args);
                if (guarding) {
                    surfaces.push(canvas);
                    largestCreated = Math.max(largestCreated, args[0], args[1]);
                }
                return canvas;
            },
        });
        globalThis.ImageData = new Proxy(OriginalImage, {
            construct(target, args) {
                if (guarding && typeof args[0] === 'number') {
                    if (Math.max(args[0], args[1]) > 512) throw Error('Oversized cached ImageData');
                    imageDataLargest = Math.max(imageDataLargest, args[0], args[1]);
                }
                return Reflect.construct(target, args);
            },
        });
        const createElement = document.createElement.bind(document);
        document.createElement = function (name, ...args) {
            const node = createElement(name, ...args);
            if (guarding && name.toLowerCase() === 'canvas') surfaces.push(node);
            return node;
        };
        for (const key of ['width', 'height']) {
            const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, key);
            Object.defineProperty(HTMLCanvasElement.prototype, key, {
                ...descriptor,
                set(value) {
                    if (guarding && value > 512) throw Error('Oversized fallback Canvas');
                    return descriptor.set.call(this, value);
                },
            });
        }
        function surface(width, height) {
            // Byte-exact pixel oracles require a deterministic raster backend.
            // Chromium GPU coverage can round an identical fractional outer edge
            // differently when a draw/clip span is split (see independent probes).
            // Keep production surfaces unchanged; GPU probes below opt in explicitly.
            const canvas = new OriginalCanvas(width, height),
                context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) throw Error('No reference 2D context');
            return { canvas, context };
        }
        function pattern(width, height) {
            const pixels = new Uint8ClampedArray(width * height * 4),
                alpha = [0, 17, 64, 128, 200, 255];
            for (let y = 0; y < height; y++)
                for (let x = 0; x < width; x++) {
                    const p = (y * width + x) * 4;
                    pixels[p] = (x * 17 + y * 3) & 255;
                    pixels[p + 1] = (y * 9 + x) & 255;
                    pixels[p + 2] = (x ^ y) & 255;
                    pixels[p + 3] = alpha[(Math.floor(x / 7) + Math.floor(y / 11)) % alpha.length];
                }
            return pixels;
        }
        function draw(cache, ...args) {
            guarding = true;
            try {
                cache.draw(...args);
            } finally {
                guarding = false;
            }
            if (
                cache.stats.tiles > cache.stats.maxTiles ||
                cache.stats.estimatedBytes > cache.stats.byteBudget
            )
                throw Error('Tile cache exceeded its budget');
        }
        async function compare(name, actual, reference, extra = {}) {
            const a = decodePng(
                    new Uint8Array(
                        await (await actual.canvas.convertToBlob({ type: 'image/png' })).arrayBuffer(),
                    ),
                ),
                b = decodePng(
                    new Uint8Array(
                        await (await reference.canvas.convertToBlob({ type: 'image/png' })).arrayBuffer(),
                    ),
                );
            let mismatchedChannels = 0,
                maxChannelError = 0,
                maxPremultipliedError = 0,
                texelTieMismatches = 0,
                nonTieInteriorMismatches = 0;
            const first = [],
                areas = { boundary: 0, interior: 0, outer: 0 };
            for (let i = 0; i < a.pixels.length; i++)
                if (a.pixels[i] !== b.pixels[i]) {
                    mismatchedChannels++;
                    maxChannelError = Math.max(maxChannelError, Math.abs(a.pixels[i] - b.pixels[i]));
                    const pixel = Math.floor(i / 4) * 4,
                        c = i % 4,
                        px = Math.floor(i / 4) % a.width,
                        py = Math.floor(i / 4 / a.width);
                    maxPremultipliedError = Math.max(
                        maxPremultipliedError,
                        c === 3
                            ? Math.abs(a.pixels[i] - b.pixels[i])
                            : Math.abs(
                                  Math.round((a.pixels[i] * a.pixels[pixel + 3]) / 255) -
                                      Math.round((b.pixels[i] * b.pixels[pixel + 3]) / 255),
                              ),
                    );
                    if (extra.mapping) {
                        const m = extra.mapping,
                            x = (px + 0.5 - m.tx) / m.scale,
                            y = (py + 0.5 - m.ty) / m.scale,
                            kx = Math.round(x / m.step),
                            ky = Math.round(y / m.step);
                        if (Math.abs(x - Math.round(x)) < 1e-5 || Math.abs(y - Math.round(y)) < 1e-5)
                            texelTieMismatches++;
                        if (x < 3 || y < 3 || x >= m.width - 3 || y >= m.height - 3) areas.outer++;
                        else if (
                            (kx > 0 && kx * m.step < m.width && Math.abs((x - kx * m.step) * m.scale) <= 2) ||
                            (ky > 0 && ky * m.step < m.height && Math.abs((y - ky * m.step) * m.scale) <= 2)
                        )
                            areas.boundary++;
                        else {
                            areas.interior++;
                            if (Math.abs(x - Math.round(x)) >= 1e-5 && Math.abs(y - Math.round(y)) >= 1e-5)
                                nonTieInteriorMismatches++;
                        }
                    }
                    if (first.length < 8)
                        first.push({ x: px, y: py, channel: c, actual: a.pixels[i], expected: b.pixels[i] });
                }
            checks.push({
                name,
                width: a.width,
                height: a.height,
                mismatchedChannels,
                maxChannelError,
                maxPremultipliedError,
                texelTieMismatches,
                nonTieInteriorMismatches,
                mismatchesByArea: areas,
                first,
                ...extra,
            });
        }
        // Diagnose browser rasterization independently of PixelTileCache. Splitting
        // the same source and clip must not change its mathematical coverage.
        for (const readFrequently of [false, true]) {
            const w = 513,
                h = 257,
                src = surface(w, h),
                image = pattern(w, h);
            src.context.putImageData(new OriginalImage(image, w, h), 0, 0);
            const render = (split, tiled) => {
                const canvas = new OriginalCanvas(530, 280),
                    context = canvas.getContext('2d', { willReadFrequently: readFrequently });
                for (let x = 0; x < w; x += 510) {
                    let input = src.canvas,
                        offset = 0;
                    if (tiled) {
                        offset = Math.max(0, x - 1);
                        const tile = surface(Math.min(w, x + 511) - offset, h);
                        tile.context.putImageData(new OriginalImage(image, w, h), -offset, 0);
                        input = tile.canvas;
                    }
                    context.save();
                    context.beginPath();
                    context.rect(split ? 3 + x : 3, 5, split ? Math.min(510, 512.375 - x) : 512.375, 256.625);
                    context.clip();
                    context.drawImage(input, 3 + offset, 5);
                    context.restore();
                    if (!split) break;
                }
                return { canvas, context };
            };
            const reference = render(false, false);
            await compare(
                'Browser clip diagnostic full source, split clip CPU=' + readFrequently,
                render(true, false),
                reference,
                { informational: !readFrequently },
            );
            await compare(
                'Browser clip diagnostic tiled source, split clip CPU=' + readFrequently,
                render(true, true),
                reference,
                { informational: !readFrequently },
            );
            // Independent fractional nearest-neighbor outer-edge probe, without
            // PixelTileCache, mip generation, or the production tile implementation.
            const rgba = pattern(1024, 560),
                full = surface(1024, 560),
                renderRgba = (tiled) => {
                    const canvas = new OriginalCanvas(1200, 760),
                        context = canvas.getContext('2d', { willReadFrequently: readFrequently });
                    context.imageSmoothingEnabled = false;
                    if (!tiled) context.drawImage(full.canvas, 3.25, 5.125);
                    else
                        for (let y = 0; y < 560; y += 510)
                            for (let x = 0; x < 1024; x += 510) {
                                const ox = Math.max(0, x - 1),
                                    oy = Math.max(0, y - 1),
                                    tile = surface(Math.min(1024, x + 511) - ox, Math.min(560, y + 511) - oy),
                                    left = x ? Math.round(3.25 + x) : 3,
                                    top = y ? Math.round(5.125 + y) : 5,
                                    right = x + 510 >= 1024 ? 1028 : Math.round(3.25 + x + 510),
                                    bottom = y + 510 >= 560 ? 566 : Math.round(5.125 + y + 510);
                                tile.context.putImageData(new OriginalImage(rgba, 1024, 560), -ox, -oy);
                                context.save();
                                context.beginPath();
                                context.rect(left, top, right - left, bottom - top);
                                context.clip();
                                context.drawImage(tile.canvas, 3.25 + ox, 5.125 + oy);
                                context.restore();
                            }
                    return { canvas, context };
                };
            full.context.putImageData(new OriginalImage(rgba, 1024, 560), 0, 0);
            await compare(
                'Browser fractional RGBA diagnostic CPU=' + readFrequently,
                renderRgba(true),
                renderRgba(false),
                { informational: !readFrequently },
            );
        }
        const width = 1024,
            height = 560,
            pixels = pattern(width, height),
            before = pixels.slice(),
            source = surface(width, height);
        source.context.putImageData(new OriginalImage(pixels, width, height), 0, 0);
        for (const [scale, tx, ty] of [
            [1, 3, 5],
            [1, 3.25, 5.125],
            [0.65, 3.25, 7.125],
            [0.215, 1.75, 2.25],
            [1.25, -130.25, -60.125],
            [4, -1800.5, -1900.25],
            [4, -1800, -1900],
        ]) {
            const a = surface(1200, 760),
                b = surface(1200, 760),
                cache = new PixelTileCache();
            for (const t of [a, b]) {
                t.context.setTransform(scale, 0, 0, scale, tx, ty);
                t.context.imageSmoothingEnabled = scale < 1;
                t.context.imageSmoothingQuality = 'low';
            }
            b.context.drawImage(source.canvas, 0, 0);
            draw(cache, a.context, {}, pixels, width, height, {
                x: -tx / scale,
                y: -ty / scale,
                width: 1200 / scale,
                height: 760 / scale,
            });
            await compare('RGBA seams scale ' + scale + ' offset ' + tx, a, b, {
                stats: cache.stats,
                informational: scale !== 1 && (scale % 1 !== 0 || tx % 1 !== 0 || ty % 1 !== 0),
                mapping: { scale, tx, ty, width, height, step: cache.stats.tileSize * cache.stats.mipFactor },
            });
            cache.clear();
        }
        for (const kind of ['uniform-alpha', 'uniform-opacity', 'continuous-gradient'])
            for (const scale of [0.65, 0.215, 1.25]) {
                const w = 1024,
                    h = 560,
                    image = new Uint8ClampedArray(w * h * 4),
                    tx = 3.25,
                    ty = 7.125,
                    opacity = kind === 'uniform-opacity' ? 0.625 : 1;
                for (let y = 0; y < h; y++)
                    for (let x = 0; x < w; x++) {
                        const i = (y * w + x) * 4;
                        image[i] = kind.startsWith('uniform') ? 45 : Math.round((x * 255) / (w - 1));
                        image[i + 1] = kind.startsWith('uniform') ? 120 : Math.round((y * 255) / (h - 1));
                        image[i + 2] = 210;
                        image[i + 3] = 128;
                    }
                const src = surface(w, h),
                    a = surface(1400, 800),
                    b = surface(1400, 800),
                    cache = new PixelTileCache();
                src.context.putImageData(new OriginalImage(image, w, h), 0, 0);
                for (const target of [a, b]) {
                    target.context.setTransform(scale, 0, 0, scale, tx, ty);
                    target.context.globalAlpha = opacity;
                    target.context.imageSmoothingEnabled = scale < 1;
                    target.context.imageSmoothingQuality = 'low';
                }
                b.context.drawImage(src.canvas, 0, 0);
                draw(cache, a.context, {}, image, w, h, {
                    x: -tx / scale,
                    y: -ty / scale,
                    width: 1400 / scale,
                    height: 800 / scale,
                });
                const actual = decodePng(
                        new Uint8Array(
                            await (await a.canvas.convertToBlob({ type: 'image/png' })).arrayBuffer(),
                        ),
                    ).pixels,
                    expected = decodePng(
                        new Uint8Array(
                            await (await b.canvas.convertToBlob({ type: 'image/png' })).arrayBuffer(),
                        ),
                    ).pixels;
                let interiorMismatches = 0,
                    seamMismatches = 0,
                    otherMismatches = 0,
                    seamChannels = 0,
                    otherChannels = 0,
                    maxInteriorError = 0,
                    alphaMismatch = 0,
                    maxSeamJump = 0,
                    maxOtherJump = 0;
                for (let py = 0; py < 800; py++)
                    for (let px = 0; px < 1400; px++) {
                        const dx = (px + 0.5 - tx) / scale,
                            dy = (py + 0.5 - ty) / scale;
                        if (dx < 3 || dy < 3 || dx >= w - 3 || dy >= h - 3) continue;
                        const i = (py * 1400 + px) * 4,
                            sx = Math.abs(px + 0.5 - (tx + cache.stats.tileSize * scale)) <= 2,
                            sy = Math.abs(py + 0.5 - (ty + cache.stats.tileSize * scale)) <= 2;
                        if (actual[i + 3] !== Math.round(128 * opacity)) alphaMismatch++;
                        for (let c = 0; c < 4; c++) {
                            const difference = Math.abs(actual[i + c] - expected[i + c]);
                            maxInteriorError = Math.max(maxInteriorError, difference);
                            if (difference) {
                                interiorMismatches++;
                                if (sx || sy) seamMismatches++;
                                else otherMismatches++;
                            }
                            if (sx || sy) seamChannels++;
                            else otherChannels++;
                        }
                        if (dx < w - 4) {
                            const jump = Math.abs(actual[i] - actual[i + 4]);
                            if (sx) maxSeamJump = Math.max(maxSeamJump, jump);
                            else maxOtherJump = Math.max(maxOtherJump, jump);
                        }
                        if (dy < h - 4) {
                            const jump = Math.abs(actual[i + 1] - actual[i + 1400 * 4 + 1]);
                            if (sy) maxSeamJump = Math.max(maxSeamJump, jump);
                            else maxOtherJump = Math.max(maxOtherJump, jump);
                        }
                    }
                const extraBoundaryGradientJump = Math.max(0, maxSeamJump - maxOtherJump),
                    contractFailures =
                        alphaMismatch +
                        (kind.startsWith('uniform') ? interiorMismatches : extraBoundaryGradientJump);
                checks.push({
                    name: kind + ' fractional boundary ' + scale,
                    contractFailures,
                    alphaInteriorMismatches: alphaMismatch,
                    uniformInteriorMismatchedChannels: kind.startsWith('uniform')
                        ? interiorMismatches
                        : undefined,
                    extraBoundaryGradientJump,
                    maxSeamJump,
                    maxOtherJump,
                    maxInteriorError,
                    seamMismatches,
                    otherMismatches,
                    seamChannels,
                    otherChannels,
                    note: 'No epsilon: uniform interior and alpha are byte exact. Gradient boundary jumps cannot exceed interior quantized jumps; whole-image fractional resampling differences are reported separately.',
                });
                cache.clear();
            }
        {
            const cache = new PixelTileCache(2, 4 * 1024 * 1024),
                a = surface(1200, 760),
                b = surface(1200, 760);
            b.context.drawImage(source.canvas, 0, 0);
            draw(cache, a.context, {}, pixels, width, height, { x: 0, y: 0, width: 1200, height: 760 });
            await compare('Eviction preserves already drawn pixels', a, b, { stats: cache.stats });
            if (!cache.stats.evictions || cache.stats.tiles > 2) throw Error('LRU eviction not exercised');
            const live = surfaces.filter((s) => s.width && s.height);
            if (
                live.length !== cache.stats.tiles ||
                live.reduce((n, s) => n + s.width * s.height * 8, 0) !== cache.stats.estimatedBytes
            )
                throw Error('Released surface accounting mismatch');
            cache.retain([]);
            if (cache.stats.tiles || cache.stats.estimatedBytes || surfaces.some((s) => s.width && s.height))
                throw Error('Retain failed to release backing stores');
        }
        {
            const cache = new PixelTileCache(64, 2 * 1024 * 1024),
                a = surface(1200, 760),
                b = surface(1200, 760);
            b.context.drawImage(source.canvas, 0, 0);
            draw(cache, a.context, {}, pixels, width, height, { x: 0, y: 0, width: 1200, height: 760 });
            if (
                !cache.stats.evictions ||
                cache.stats.estimatedBytes > 2 * 1024 * 1024 ||
                cache.stats.tiles >= 64
            )
                throw Error('Byte budget was not independently enforced');
            await compare('Byte budget evicts before tile-count cap', a, b, { stats: cache.stats });
            cache.clear();
        }
        {
            const image = pattern(1024, 128),
                cache = new PixelTileCache(),
                owner = {},
                a = surface(1024, 128),
                b = surface(1024, 128),
                view = { x: 0, y: 0, width: 1024, height: 128 };
            draw(cache, a.context, owner, image, 1024, 128, view);
            const start = cache.stats.putImageDataBytes;
            for (let y = 0; y < 128; y++)
                for (let x = 384; x < 512; x++) image.set([21, 51, 201, 128], (y * 1024 + x) * 4);
            a.context.clearRect(0, 0, 1024, 128);
            draw(cache, a.context, owner, image, 1024, 128, view, [
                { x: 384, y: 0, width: 128, height: 128 },
            ]);
            b.context.putImageData(new OriginalImage(image, 1024, 128), 0, 0);
            const updateBytes = cache.stats.putImageDataBytes - start;
            if (updateBytes !== (127 + 3) * 128 * 4)
                throw Error('Dirty upload exceeds intersections: ' + updateBytes);
            await compare('Only128px dirty and halo intersections update', a, b, { updateBytes });
            cache.clear();
        }
        {
            const image = pattern(2048, 64),
                cache = new PixelTileCache(),
                owner = {},
                a = surface(300, 64),
                b = surface(300, 64);
            draw(cache, a.context, owner, image, 2048, 64, { x: 0, y: 0, width: 300, height: 64 });
            image.set([250, 10, 20, 200], (12 * 2048 + 10) * 4);
            a.context.setTransform(1, 0, 0, 1, -900, 0);
            draw(cache, a.context, owner, image, 2048, 64, { x: 900, y: 0, width: 300, height: 64 }, [
                { x: 0, y: 0, width: 128, height: 64 },
            ]);
            a.context.setTransform(1, 0, 0, 1, 0, 0);
            a.context.clearRect(0, 0, 300, 64);
            draw(cache, a.context, owner, image, 2048, 64, { x: 0, y: 0, width: 300, height: 64 });
            const crop = new Uint8ClampedArray(300 * 64 * 4);
            for (let y = 0; y < 64; y++)
                crop.set(image.subarray(y * 2048 * 4, (y * 2048 + 300) * 4), y * 300 * 4);
            b.context.putImageData(new OriginalImage(crop, 300, 64), 0, 0);
            await compare('Offscreen invalidation refreshes on revisit', a, b);
            cache.clear();
        }
        {
            const image = pattern(1100, 128),
                immutable = image.slice(),
                expected = image.slice(),
                cache = new PixelTileCache(),
                a = surface(1100, 128),
                b = surface(1100, 128),
                owner = {},
                view = { x: 0, y: 0, width: 1100, height: 128 };
            const hook = (data, x, y, w, h) => {
                for (let row = 0; row < h; row++)
                    for (let col = 0; col < w; col++)
                        if (x + col >= 500 && x + col < 530)
                            data[(row * w + col) * 4 + 3] = Math.round(data[(row * w + col) * 4 + 3] / 2);
            };
            hook(expected, 0, 0, 1100, 128);
            draw(cache, a.context, owner, image, 1100, 128, view, undefined, 0, 0, hook);
            a.context.clearRect(0, 0, 1100, 128);
            draw(
                cache,
                a.context,
                owner,
                image,
                1100,
                128,
                view,
                [{ x: 500, y: 0, width: 30, height: 128 }],
                0,
                0,
                hook,
            );
            b.context.putImageData(new OriginalImage(expected, 1100, 128), 0, 0);
            if (image.some((v, i) => v !== immutable[i])) throw Error('Preview hook changed authority');
            await compare('Preview fresh rows avoid accumulated erasure', a, b);
            cache.clear();
        }
        {
            const image = pattern(4096, 4096),
                cache = new PixelTileCache(),
                a = surface(500, 300),
                b = surface(500, 300),
                view = { x: 1800, y: 1900, width: 500, height: 300 };
            a.context.setTransform(1, 0, 0, 1, -view.x, -view.y);
            draw(cache, a.context, {}, image, 4096, 4096, view);
            const crop = new Uint8ClampedArray(500 * 300 * 4);
            for (let y = 0; y < 300; y++)
                crop.set(
                    image.subarray(
                        ((view.y + y) * 4096 + view.x) * 4,
                        ((view.y + y) * 4096 + view.x + 500) * 4,
                    ),
                    y * 500 * 4,
                );
            b.context.putImageData(new OriginalImage(crop, 500, 300), 0, 0);
            if (cache.stats.tiles > 4) throw Error('Large viewport not culled');
            await compare('4096square bounded viewport', a, b, { stats: cache.stats });
            cache.clear();
        }
        {
            const image = pattern(32768, 1),
                cache = new PixelTileCache(),
                a = surface(1024, 8),
                b = surface(1024, 8),
                view = { x: 31744, y: -3, width: 1024, height: 8 };
            a.context.setTransform(1, 0, 0, 1, -view.x, 3);
            draw(cache, a.context, {}, image, 32768, 1, view);
            b.context.putImageData(new OriginalImage(image.slice(view.x * 4), 1024, 1), 0, 3);
            await compare('32768x1 without full-width Canvas', a, b, { stats: cache.stats });
            cache.clear();
        }
        {
            const saved = globalThis.OffscreenCanvas;
            globalThis.OffscreenCanvas = undefined;
            try {
                const image = pattern(700, 200),
                    cache = new PixelTileCache(),
                    a = surface(700, 200),
                    b = surface(700, 200);
                draw(cache, a.context, {}, image, 700, 200, { x: 0, y: 0, width: 700, height: 200 });
                b.context.putImageData(new OriginalImage(image, 700, 200), 0, 0);
                await compare('HTML Canvas bounded fallback', a, b, { stats: cache.stats });
                cache.clear();
            } finally {
                globalThis.OffscreenCanvas = saved;
            }
        }
        {
            const w = 4096,
                h = 4096,
                image = new Uint8ClampedArray(w * h * 4),
                cache = new PixelTileCache();
            for (let y = 0; y < h; y++)
                for (let x = 0; x < w; x++) {
                    const i = (y * w + x) * 4;
                    image[i] = x >> 4;
                    image[i + 1] = y >> 4;
                    image[i + 2] = 80;
                    image[i + 3] = 128;
                }
            const a = surface(8, 8),
                b = surface(8, 8),
                expected = new Uint8ClampedArray(8 * 8 * 4);
            a.context.setTransform(1 / 1024, 0, 0, 1 / 1024, -1, 0);
            draw(cache, a.context, {}, image, w, h, { x: 1024, y: 0, width: 8192, height: 8192 });
            for (let y = 0; y < 4; y++)
                for (let x = 0; x < 3; x++)
                    expected.set([96 + x * 64, 32 + y * 64, 80, 128], (y * 8 + x) * 4);
            b.context.putImageData(new OriginalImage(expected, 8, 8), 0, 0);
            await compare('Minimum1over1024 linear gradient and viewport clipping', a, b, {
                stats: cache.stats,
            });
            cache.clear();
            for (let y = 0; y < h; y++)
                for (let x = 0; x < w; x++) {
                    const i = (y * w + x) * 4,
                        opaque = Math.floor(x / 512) % 2 === 1;
                    image[i] = opaque ? 0 : 255;
                    image[i + 1] = 0;
                    image[i + 2] = opaque ? 255 : 0;
                    image[i + 3] = opaque ? 255 : 0;
                }
            const c = surface(8, 8),
                d = surface(8, 8),
                blue = new Uint8ClampedArray(8 * 8 * 4);
            c.context.setTransform(1 / 1024, 0, 0, 1 / 1024, 0, 0);
            c.context.globalAlpha = 0.5;
            draw(cache, c.context, {}, image, w, h, { x: 0, y: 0, width: 8192, height: 8192 });
            for (let y = 0; y < 4; y++)
                for (let x = 0; x < 4; x++) blue.set([0, 0, 255, 64], (y * 8 + x) * 4);
            d.context.putImageData(new OriginalImage(blue, 8, 8), 0, 0);
            await compare('Minimum zoom alpha-aware samples and global opacity', c, d, {
                stats: cache.stats,
            });
            cache.clear();
            const e = surface(8, 8),
                f = surface(8, 8),
                halved = new Uint8ClampedArray(8 * 8 * 4);
            e.context.setTransform(1 / 1024, 0, 0, 1 / 1024, 0, 0);
            e.context.globalAlpha = 0.5;
            const halfAlpha = (data) => {
                for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i] / 2);
            };
            draw(
                cache,
                e.context,
                {},
                image,
                w,
                h,
                { x: 0, y: 0, width: 8192, height: 8192 },
                undefined,
                0,
                0,
                halfAlpha,
            );
            for (let y = 0; y < 4; y++)
                for (let x = 0; x < 4; x++) halved.set([0, 0, 255, 32], (y * 8 + x) * 4);
            f.context.putImageData(new OriginalImage(halved, 8, 8), 0, 0);
            await compare('Minimum zoom preview hook preserves alpha-aware sampling', e, f, {
                stats: cache.stats,
            });
            cache.clear();
            let rejected = false;
            try {
                draw(
                    cache,
                    e.context,
                    {},
                    image,
                    w,
                    h,
                    { x: 0, y: 0, width: 8192, height: 8192 },
                    undefined,
                    0,
                    0,
                    () => {
                        throw Error('preview failed');
                    },
                );
            } catch (error) {
                rejected = String(error).includes('preview failed');
            }
            if (
                !rejected ||
                cache.stats.tiles ||
                cache.stats.estimatedBytes ||
                surfaces.some((s) => s.width && s.height)
            )
                throw Error('Failed preview retained transient backing stores');
            checks.push({
                name: 'Extreme zoom failed preview releases bounded scratch',
                mismatchedChannels: 0,
                stats: cache.stats,
            });
            const narrow = pattern(32768, 1),
                n = surface(40, 8),
                reference = surface(40, 8);
            n.context.setTransform(1 / 1024, 0, 0, 1 / 1024, 0, 0.5);
            draw(cache, n.context, {}, narrow, 32768, 1, { x: 0, y: -512, width: 40960, height: 8192 });
            await compare('Minimum zoom32768x1 bounded projected output', n, reference, {
                stats: cache.stats,
            });
            cache.clear();
        }
        function boxReference(pixels, width, height, factor) {
            const w = Math.ceil(width / factor),
                h = Math.ceil(height / factor),
                out = new Uint8ClampedArray(w * h * 4);
            for (let y = 0; y < h; y++)
                for (let x = 0; x < w; x++) {
                    let alpha = 0,
                        red = 0,
                        green = 0,
                        blue = 0,
                        count = 0;
                    for (let sy = y * factor; sy < Math.min(height, (y + 1) * factor); sy++)
                        for (let sx = x * factor; sx < Math.min(width, (x + 1) * factor); sx++) {
                            const i = (sy * width + sx) * 4,
                                a = pixels[i + 3];
                            alpha += a;
                            red += pixels[i] * a;
                            green += pixels[i + 1] * a;
                            blue += pixels[i + 2] * a;
                            count++;
                        }
                    const i = (y * w + x) * 4;
                    out[i] = alpha ? Math.round(red / alpha) : 0;
                    out[i + 1] = alpha ? Math.round(green / alpha) : 0;
                    out[i + 2] = alpha ? Math.round(blue / alpha) : 0;
                    out[i + 3] = Math.round(alpha / count);
                }
            return { pixels: out, width: w, height: h };
        }
        // Each source is only 131x19 RGBA (9,956 bytes); scale forces actual factor8.
        // Inspect uploaded bytes as well as Canvas pixels: alpha1 RGB can disappear in a Canvas roundtrip.
        for (const kind of [
            'opaque-white',
            'raw-zero',
            'hidden-rgb-constant',
            'hidden-rgb',
            'low-alpha-rounding',
            'late-mismatch',
            'transform-rollback',
        ]) {
            const w = 131,
                h = 19,
                image = new Uint8ClampedArray(w * h * 4),
                cache = new PixelTileCache(4, 2 * 1024 * 1024),
                originalOwner = {},
                previewOwner = {},
                a = surface(20, 8),
                b = surface(20, 8),
                scale = 1 / 16,
                viewport = { x: -32, y: -32, width: 320, height: 128 };
            for (let y = 0; y < h; y++)
                for (let x = 0; x < w; x++) {
                    const at = (y * w + x) * 4;
                    if (kind === 'opaque-white' || kind === 'late-mismatch') image.fill(255, at, at + 4);
                    else if (kind === 'hidden-rgb-constant') image.set([193, 71, 117, 0], at);
                    else if (kind === 'hidden-rgb')
                        image.set([x % 256, (y * 17) % 256, (x ^ y) % 256, 0], at);
                    else if (kind === 'low-alpha-rounding' || kind === 'transform-rollback') {
                        const cell = Math.floor(x / 8) % 3,
                            half = x % 8 >= 4;
                        image.set(
                            cell === 0
                                ? half
                                    ? [1, 0, 101, 2]
                                    : [0, 255, 101, 1]
                                : cell === 1
                                  ? [Number(half), 73, 109, 1]
                                  : half
                                    ? [2, 99, 201, 1]
                                    : [255, 19, 211, 0],
                            at,
                        );
                    }
                }
            if (kind === 'late-mismatch') image.set([0, 37, 83, 255], image.length - 4);
            const original = image.slice(),
                expectedOriginal = boxReference(image, w, h, 8),
                originalPut = OffscreenCanvasRenderingContext2D.prototype.putImageData,
                uploaded = [];
            if (kind === 'low-alpha-rounding') {
                for (const [cell, expected] of [
                    [0, [1, 85, 101, 2]],
                    [1, [1, 73, 109, 1]],
                    [2, [2, 99, 201, 1]],
                ])
                    if (
                        expectedOriginal.pixels
                            .subarray(cell * 4, cell * 4 + 4)
                            .some((v, i) => v !== expected[i])
                    )
                        throw Error('Independent low-alpha fixture lost its rounding threshold');
            }
            OffscreenCanvasRenderingContext2D.prototype.putImageData = function (data, ...args) {
                if (guarding)
                    uploaded.push({
                        width: data.width,
                        height: data.height,
                        pixels: data.data.slice(),
                    });
                return originalPut.call(this, data, ...args);
            };
            cache.beginFrame(1);
            try {
                const phases =
                    kind === 'transform-rollback'
                        ? ['original', 'preview', 'cancel', 'dirty', 'rollback']
                        : ['original'];
                const hook = (data, x, y, width) => {
                    for (let sx = 0; sx < width; sx++)
                        if (x + sx >= 7 && x + sx < 18 && y >= 3 && y < 12)
                            data.set([43, 181, 79, 83], sx * 4);
                };
                for (const phase of phases) {
                    let dirty, transform;
                    if (phase === 'preview') transform = hook;
                    if (phase === 'dirty') image.set([217, 33, 91, 144], (8 * w + 15) * 4);
                    if (phase === 'rollback')
                        image.set(
                            original.subarray((8 * w + 15) * 4, (8 * w + 15) * 4 + 4),
                            (8 * w + 15) * 4,
                        );
                    if (phase === 'dirty' || phase === 'rollback')
                        dirty = [{ x: 15, y: 8, width: 1, height: 1 }];
                    for (const target of [a, b]) {
                        target.context.setTransform(1, 0, 0, 1, 0, 0);
                        target.context.clearRect(0, 0, 20, 8);
                    }
                    a.context.setTransform(scale, 0, 0, scale, 2, 2);
                    const before = cache.stats,
                        firstUpload = uploaded.length;
                    draw(
                        cache,
                        a.context,
                        phase === 'preview' ? previewOwner : originalOwner,
                        image,
                        w,
                        h,
                        viewport,
                        dirty,
                        0,
                        0,
                        transform,
                    );
                    if (cache.stats.mipFactor !== 8)
                        throw Error('Small exact mip fixture did not exercise factor8');
                    if (phase === 'cancel' && cache.stats.uploads !== before.uploads)
                        throw Error('Mip transform cancel did not reuse the unchanged original owner');
                    const expectedSource = image.slice();
                    if (transform)
                        for (let y = 0; y < h; y++)
                            hook(expectedSource.subarray(y * w * 4, (y + 1) * w * 4), 0, y, w, 1);
                    const mip = boxReference(expectedSource, w, h, 8),
                        src = surface(mip.width, mip.height);
                    if (phase !== 'cancel') {
                        if (uploaded.length - firstUpload !== 1)
                            throw Error('Small mip fixture must upload exactly one source tile');
                        const actual = uploaded[firstUpload];
                        if (
                            actual.width !== mip.width ||
                            actual.height !== mip.height ||
                            actual.pixels.some((v, i) => v !== mip.pixels[i])
                        )
                            throw Error(
                                'Raw uploaded mip differs from independent boxReference: ' +
                                    kind +
                                    '/' +
                                    phase,
                            );
                    }
                    src.context.putImageData(new OriginalImage(mip.pixels, mip.width, mip.height), 0, 0);
                    b.context.setTransform(scale * 8, 0, 0, scale * 8, 2, 2);
                    b.context.save();
                    b.context.beginPath();
                    b.context.rect(0, 0, w / 8, h / 8);
                    b.context.clip();
                    b.context.drawImage(src.canvas, 0, 0);
                    b.context.restore();
                    await compare('Small box mip ' + kind + '/' + phase, a, b, {
                        factor: 8,
                        rawUploadChecked: phase !== 'cancel',
                        sourceBytes: image.byteLength,
                        stats: cache.stats,
                    });
                    if (phase !== 'dirty' && image.some((v, i) => v !== original[i]))
                        throw Error('Small mip render/transform changed authoritative pixels');
                }
            } finally {
                OffscreenCanvasRenderingContext2D.prototype.putImageData = originalPut;
                cache.clear();
            }
        }
        for (const kind of ['thin-alpha', 'checker-alpha', 'odd-gradient', 'preview-hook', 'unaligned']) {
            const w = 4099,
                h = 2053,
                storage = new Uint8ClampedArray(w * h * 4 + (kind === 'unaligned' ? 1 : 0)),
                image = kind === 'unaligned' ? storage.subarray(1) : storage,
                cache = new PixelTileCache(4, 8 * 1024 * 1024),
                owner = {};
            cache.beginFrame(2);
            for (let y = 0; y < h; y++)
                for (let x = 0; x < w; x++) {
                    const i = (y * w + x) * 4;
                    if (kind === 'thin-alpha')
                        image.set(
                            x === 4080 || y === 1024 || (x === 5 && y === 7)
                                ? [255, 0, 0, 255]
                                : [0, 0, 255, 0],
                            i,
                        );
                    else if (kind === 'checker-alpha')
                        image.set((x + y) % 2 ? [255, 70, 10, 128] : [0, 0, 255, 0], i);
                    else image.set([x % 256, y % 256, (x ^ y) % 256, (x * 17 + y * 13) % 256], i);
                }
            const sourceBefore = image.slice(),
                a = surface(530, 280),
                b = surface(530, 280),
                scale = 1 / 8,
                tx = 3,
                ty = 5,
                viewport = { x: -tx / scale, y: -ty / scale, width: 530 / scale, height: 280 / scale },
                hook =
                    kind === 'preview-hook'
                        ? (data, x, y, width) => {
                              for (let i = 0; i < width; i++)
                                  if ((x + i + y) % 7 === 0) data.set([42, 170, 95, 83], i * 4);
                          }
                        : undefined;
            a.context.setTransform(scale, 0, 0, scale, tx, ty);
            a.context.imageSmoothingEnabled = true;
            const coldStart = performance.now();
            const rawUploads = [],
                originalPut = OffscreenCanvasRenderingContext2D.prototype.putImageData;
            OffscreenCanvasRenderingContext2D.prototype.putImageData = function (data, ...args) {
                rawUploads.push({ width: data.width, height: data.height, pixels: data.data.slice() });
                return originalPut.call(this, data, ...args);
            };
            try {
                draw(cache, a.context, owner, image, w, h, viewport, undefined, 0, 0, hook);
            } finally {
                OffscreenCanvasRenderingContext2D.prototype.putImageData = originalPut;
            }
            const coldMs = performance.now() - coldStart,
                factor = cache.stats.mipFactor,
                initial = { ...cache.stats };
            if (factor !== 8) throw Error('Expected factor8 odd-size fixture');
            const expectedSource = image.slice();
            if (hook)
                for (let y = 0; y < h; y++)
                    hook(expectedSource.subarray(y * w * 4, (y + 1) * w * 4), 0, y, w, 1);
            const mip = boxReference(expectedSource, w, h, factor),
                src = surface(mip.width, mip.height);
            src.context.putImageData(new OriginalImage(mip.pixels, mip.width, mip.height), 0, 0);
            let rawMismatches = 0;
            for (let tileIndex = 0; tileIndex < rawUploads.length; tileIndex++) {
                const uploaded = rawUploads[tileIndex],
                    sourceX = Math.max(0, tileIndex * cache.stats.tileSize - 1);
                for (let y = 0; y < uploaded.height; y++)
                    for (let x = 0; x < uploaded.width; x++)
                        for (let c = 0; c < 4; c++)
                            if (
                                uploaded.pixels[(y * uploaded.width + x) * 4 + c] !==
                                mip.pixels[(y * mip.width + sourceX + x) * 4 + c]
                            )
                                rawMismatches++;
            }
            checks.push({
                name: 'Large raw box mip oracle ' + kind,
                contractFailures: rawMismatches,
                rawUploads: rawUploads.length,
            });
            b.context.setTransform(scale * factor, 0, 0, scale * factor, tx, ty);
            b.context.imageSmoothingEnabled = true;
            b.context.save();
            b.context.beginPath();
            b.context.rect(0, 0, w / factor, h / factor);
            b.context.clip();
            b.context.drawImage(src.canvas, 0, 0);
            b.context.restore();
            await compare('Box mip exact odd edges and ' + kind, a, b, {
                factor,
                coldMs,
                stats: cache.stats,
            });
            a.context.save();
            a.context.setTransform(1, 0, 0, 1, 0, 0);
            a.context.clearRect(0, 0, 530, 280);
            a.context.restore();
            const steadyStart = performance.now();
            draw(cache, a.context, owner, image, w, h, viewport, undefined, 0, 0, hook);
            const steadyMs = performance.now() - steadyStart;
            if (cache.stats.uploads !== initial.uploads || cache.stats.evictions !== initial.evictions)
                throw Error('Steady mip repainted or evicted visible tiles');
            await compare('Box mip steady cached ' + kind, a, b, { coldMs, steadyMs, stats: cache.stats });
            if (image.some((v, i) => v !== sourceBefore[i]))
                throw Error('Mip renderer modified authoritative pixels');
            if (kind === 'thin-alpha') {
                image.set([0, 255, 0, 255], (1024 * w + 4080) * 4);
                a.context.save();
                a.context.setTransform(1, 0, 0, 1, 0, 0);
                a.context.clearRect(0, 0, 530, 280);
                a.context.restore();
                const uploadBefore = cache.stats.putImageDataBytes;
                draw(cache, a.context, owner, image, w, h, viewport, [
                    { x: 4080, y: 1024, width: 1, height: 1 },
                ]);
                const changed = boxReference(image, w, h, factor);
                src.context.putImageData(
                    new OriginalImage(changed.pixels, changed.width, changed.height),
                    0,
                    0,
                );
                b.context.save();
                b.context.setTransform(1, 0, 0, 1, 0, 0);
                b.context.clearRect(0, 0, 530, 280);
                b.context.restore();
                b.context.save();
                b.context.beginPath();
                b.context.rect(0, 0, w / factor, h / factor);
                b.context.clip();
                b.context.drawImage(src.canvas, 0, 0);
                b.context.restore();
                const uploaded = cache.stats.putImageDataBytes - uploadBefore;
                if (uploaded > 16 || uploaded < 4)
                    throw Error('Single source pixel dirtied unrelated mip cells');
                await compare('Box mip dirty one pixel crossing tile halos', a, b, {
                    uploadedBytes: uploaded,
                    stats: cache.stats,
                });
            }
            cache.clear();
        }
        {
            const w = 32768,
                h = 1,
                image = new Uint8ClampedArray(w * 4),
                cache = new PixelTileCache(1, 2 * 1024 * 1024),
                a = surface(270, 8),
                b = surface(270, 8),
                owner = {},
                scale = 1 / 128;
            for (let x = 0; x < w; x++) image.set([x % 256, 70, 210, 255], x * 4);
            a.context.setTransform(scale, 0, 0, scale, 3, 2);
            draw(cache, a.context, owner, image, w, h, { x: -384, y: -256, width: 34560, height: 1024 });
            const factor = cache.stats.mipFactor,
                mip = boxReference(image, w, h, factor),
                src = surface(mip.width, mip.height);
            src.context.putImageData(new OriginalImage(mip.pixels, mip.width, mip.height), 0, 0);
            b.context.setTransform(scale * factor, 0, 0, scale * factor, 3, 2);
            b.context.save();
            b.context.beginPath();
            b.context.rect(0, 0, w / factor, h / factor);
            b.context.clip();
            b.context.drawImage(src.canvas, 0, 0);
            b.context.restore();
            await compare('Box mip32768x1 fractional short-axis edge', a, b, { factor, stats: cache.stats });
            cache.clear();
        }
        function paintScene(cache, target, rasters, options = {}) {
            const {
                    scale = 1,
                    zoom = scale,
                    tx = 0,
                    ty = 0,
                    background = '#18212c',
                    checker = '#dde0e5',
                    keep = [],
                    finish = true,
                } = options,
                ctx = target.context,
                paperWidth = rasters[0].width,
                paperHeight = rasters[0].height,
                finalScene = cache instanceof FinalSceneCache;
            let viewport;
            ctx.save();
            try {
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.fillStyle = background;
                ctx.fillRect(0, 0, target.canvas.width, target.canvas.height);
                ctx.setTransform(scale, 0, 0, scale, tx, ty);
                ctx.imageSmoothingEnabled = zoom < 1;
                ctx.imageSmoothingQuality = 'low';
                viewport = {
                    x: -tx / scale,
                    y: -ty / scale,
                    width: target.canvas.width / scale,
                    height: target.canvas.height / scale,
                };
                if (finalScene) {
                    guarding = true;
                    try {
                        viewport = cache.prepare(
                            ctx,
                            { zoom, paperWidth, paperHeight, background, checker, viewport },
                            rasters,
                        );
                    } finally {
                        guarding = false;
                    }
                } else cache.beginFrame(rasters.length);
                const sourceCache = finalScene ? cache.source : cache;
                sourceCache.retain([...rasters.map((r) => r.owner), ...keep]);
                if (viewport) {
                    ctx.save();
                    try {
                        ctx.beginPath();
                        ctx.rect(0, 0, paperWidth, paperHeight);
                        ctx.clip();
                        ctx.fillStyle = '#fff';
                        ctx.fillRect(0, 0, paperWidth, paperHeight);
                        ctx.fillStyle = checker;
                        const step = 12 / zoom;
                        for (let y = 0; y < paperHeight; y += step)
                            for (let x = 0; x < paperWidth; x += step)
                                if ((Math.round(x / step) + Math.round(y / step)) % 2 === 0)
                                    ctx.fillRect(x, y, step, step);
                        for (const raster of rasters)
                            draw(
                                sourceCache,
                                ctx,
                                raster.owner,
                                raster.pixels,
                                raster.width,
                                raster.height,
                                viewport,
                                finalScene ? undefined : raster.dirty,
                                raster.x ?? 0,
                                raster.y ?? 0,
                                raster.transform,
                            );
                    } finally {
                        ctx.restore();
                    }
                }
                if (finalScene && finish) {
                    guarding = true;
                    try {
                        cache.finish(ctx);
                    } finally {
                        guarding = false;
                    }
                }
            } finally {
                ctx.restore();
            }
            if (
                cache.stats.tiles > cache.stats.maxTiles ||
                cache.stats.estimatedBytes > cache.stats.byteBudget
            )
                throw Error('Final scene exceeded the shared resource budget');
            return viewport;
        }
        {
            const rasters = Array.from({ length: 5 }, (_, index) => {
                    const image = pattern(768, 64);
                    for (let at = 0; at < image.length; at += 4) image[at] = (image[at] + index * 29) & 255;
                    return { owner: image, pixels: image, width: 768, height: 64 };
                }),
                before = rasters.map((r) => r.pixels.slice()),
                cache = new FinalSceneCache(4),
                reference = new PixelTileCache(4),
                a = surface(1100, 136),
                b = surface(1100, 136);
            const camera = { scale: 2, zoom: 1 };
            paintScene(reference, b, rasters, camera);
            paintScene(cache, a, rasters, camera);
            if (cache.stats.sceneTiles !== 3 || cache.source.maxTiles !== 1)
                throw Error('Retina fixture did not split device cells or reserve source capacity');
            await compare('Final scene Retina alpha/order cold exact', a, b, { stats: cache.stats });
            const initial = cache.stats;
            paintScene(reference, b, rasters, camera);
            paintScene(cache, a, rasters, camera);
            if (
                cache.stats.uploads !== initial.uploads ||
                cache.stats.sceneCaptures !== initial.sceneCaptures
            )
                throw Error('Unchanged final scene uploaded or recaptured');
            await compare('Final scene unchanged uploads zero', a, b, { stats: cache.stats });
            const ordered = rasters.slice();
            [ordered[0], ordered[3]] = [ordered[3], ordered[0]];
            const fractional = { scale: 1.5, zoom: 0.75, tx: 0.5, ty: 5.125, checker: '#9cb1c8' };
            paintScene(reference, b, ordered, fractional);
            paintScene(cache, a, ordered, fractional);
            await compare('Final scene fractional smoothing and reorder exact', a, b, { stats: cache.stats });
            const image = ordered[4].pixels,
                at = (8 * 768 + 340) * 4,
                old = image.slice(at, at + 4);
            image.set([255, 0, 255, 255], at);
            const changed = ordered.map((r, i) =>
                i === 4 ? { ...r, dirty: [{ x: 340, y: 8, width: 1, height: 1 }] } : r,
            );
            paintScene(reference, b, changed, fractional);
            paintScene(cache, a, changed, fractional);
            await compare('Final scene dirty bilinear halo across device512 exact', a, b, {
                stats: cache.stats,
            });
            image.set(old, at);
            paintScene(reference, b, changed, fractional);
            paintScene(cache, a, changed, fractional);
            await compare('Final scene dirty rollback exact', a, b, { stats: cache.stats });
            const cutOwner = {},
                selected = { owner: {}, pixels: pattern(64, 32), width: 64, height: 32, x: 510, y: 12 },
                preview = ordered.flatMap((r, i) =>
                    i === 2
                        ? [
                              {
                                  ...r,
                                  owner: cutOwner,
                                  transform: (data, x, y, w) => {
                                      if (y < 12 || y >= 44) return;
                                      for (let col = 0; col < w; col++)
                                          if (x + col >= 480 && x + col < 544)
                                              data.fill(0, col * 4, col * 4 + 4);
                                  },
                              },
                              selected,
                          ]
                        : [r],
                );
            paintScene(reference, b, preview, fractional);
            paintScene(cache, a, preview, fractional);
            await compare('Final scene selection cut and overlay exact', a, b, { stats: cache.stats });
            for (let i = 0; i < rasters.length; i++)
                if (rasters[i].pixels.some((v, at) => v !== before[i][at]))
                    throw Error('Final scene changed authoritative pixels');
            cache.clear();
            reference.clear();
            if (cache.stats.tiles || cache.stats.estimatedBytes)
                throw Error('Final scene clear retained resources');
        }
        {
            const image = pattern(64, 64),
                original = { owner: image, pixels: image, width: 64, height: 64 },
                cache = new FinalSceneCache(4),
                reference = new PixelTileCache(4),
                a = surface(64, 64),
                b = surface(64, 64),
                camera = { scale: 0.5 };
            paintScene(reference, b, [original], camera);
            paintScene(cache, a, [original], camera);
            const sourceCache = cache.source,
                cut = { ...original, owner: {}, transform: (data) => data.fill(0) };
            paintScene(reference, b, [cut], { ...camera, keep: [image] });
            paintScene(cache, a, [cut], { ...camera, keep: [image] });
            const before = cache.stats;
            paintScene(reference, b, [original], camera);
            paintScene(cache, a, [original], camera);
            if (
                cache.source !== sourceCache ||
                cache.stats.sceneTiles ||
                cache.source.maxTiles !== 4 ||
                cache.stats.uploads !== before.uploads
            )
                throw Error('Fallback selection cancellation discarded the original source cache');
            await compare('Final scene fallback selection Esc reuses original', a, b, { stats: cache.stats });
            for (let y = 8; y < 12; y++)
                for (let x = 8; x < 12; x++) image.set([255, 0, 0, 255], (y * 64 + x) * 4);
            const changed = { ...original, dirty: [{ x: 8, y: 8, width: 4, height: 4 }] },
                initial = cache.stats;
            paintScene(reference, b, [changed], camera);
            paintScene(cache, a, [changed], camera);
            if (
                cache.stats.uploads - initial.uploads !== 1 ||
                cache.stats.putImageDataBytes - initial.putImageDataBytes !== 64
            )
                throw Error('Prepared source dirty patch was not uploaded exactly once');
            await compare('Final scene prepare dirty single patch upload', a, b, { stats: cache.stats });
            paintScene(reference, b, [original]);
            paintScene(cache, a, [original]);
            if (cache.stats.sceneTiles || cache.source.maxTiles !== 4)
                throw Error('Small working set reserved scenes');
            await compare('Final scene small working set full-budget fallback', a, b, { stats: cache.stats });
            cache.clear();
            reference.clear();
        }
        for (const kind of ['minified', 'scene-does-not-fit']) {
            const w = kind === 'minified' ? 768 : 2048,
                rasters = Array.from({ length: 5 }, () => {
                    const image = pattern(w, 64);
                    return { owner: image, pixels: image, width: w, height: 64 };
                }),
                cache = new FinalSceneCache(4),
                reference = new PixelTileCache(4),
                a = surface(kind === 'minified' ? 700 : 1600, 80),
                b = surface(a.canvas.width, 80),
                camera = { scale: kind === 'minified' ? 0.5 : 1 };
            paintScene(reference, b, rasters, camera);
            paintScene(cache, a, rasters, camera);
            if (
                cache.stats.sceneTiles ||
                cache.source.maxTiles !== 4 ||
                cache.source.byteBudget !== cache.byteBudget ||
                cache.stats.mipFactor !== reference.stats.mipFactor
            )
                throw Error('Fallback changed source capacity or minification choice');
            await compare('Final scene ' + kind + ' preserves full source budget', a, b, {
                stats: cache.stats,
            });
            cache.clear();
            reference.clear();
        }
        {
            const rasters = Array.from({ length: 5 }, () => {
                    const image = pattern(128, 64);
                    return { owner: image, pixels: image, width: 128, height: 64 };
                }),
                cache = new FinalSceneCache(4),
                reference = new PixelTileCache(4),
                a = surface(64, 64),
                b = surface(64, 64);
            paintScene(reference, b, rasters);
            paintScene(cache, a, rasters);
            rasters[4].pixels.set([255, 0, 255, 255], (10 * 128 + 100) * 4);
            const changed = rasters.map((r, i) =>
                    i === 4 ? { ...r, dirty: [{ x: 100, y: 10, width: 1, height: 1 }] } : r,
                ),
                initial = cache.stats;
            paintScene(reference, b, changed);
            paintScene(cache, a, changed);
            if (
                cache.stats.uploads !== initial.uploads ||
                cache.stats.sceneCaptures !== initial.sceneCaptures
            )
                throw Error('Offscreen dirty unnecessarily repainted the visible scene');
            const c = surface(64, 64),
                d = surface(64, 64),
                probe = new PixelTileCache(4);
            for (const target of [c, d]) {
                target.context.fillStyle = '#fff';
                target.context.fillRect(0, 0, 64, 64);
                target.context.setTransform(1, 0, 0, 1, -64, 0);
            }
            draw(cache.source, c.context, rasters[4].owner, rasters[4].pixels, 128, 64, {
                x: 64,
                y: 0,
                width: 64,
                height: 64,
            });
            draw(probe, d.context, rasters[4].owner, rasters[4].pixels, 128, 64, {
                x: 64,
                y: 0,
                width: 64,
                height: 64,
            });
            const pixel = c.context.getImageData(36, 10, 1, 1).data;
            if (pixel[0] !== 255 || pixel[1] !== 0 || pixel[2] !== 255 || pixel[3] !== 255)
                throw Error('Skipped source draw lost a prepared offscreen dirty pixel');
            await compare('Final scene offscreen hit preserves source pending dirtiness', c, d, {
                stats: cache.stats,
            });
            paintScene(reference, b, rasters, { tx: -64 });
            paintScene(cache, a, rasters, { tx: -64 });
            await compare('Final scene offscreen dirty then pan exact', a, b, { stats: cache.stats });
            cache.clear();
            reference.clear();
            probe.clear();
        }
        {
            // Five 1027x65 RGBA layers total about 1.27 MiB; a narrow Canvas exercises source cropping.
            const w = 1027,
                h = 65,
                rasters = Array.from({ length: 5 }, (_, layer) => {
                    const image = new Uint8ClampedArray(w * h * 4);
                    for (let y = 0; y < h; y++)
                        for (let x = 0; x < w; x++)
                            image.set(
                                [
                                    (x * 17 + layer * 29) % 256,
                                    (y * 19 + x) % 256,
                                    (x ^ y ^ layer) % 256,
                                    [0, 1, 64, 128, 255][(x + y + layer) % 5],
                                ],
                                (y * w + x) * 4,
                            );
                    return { owner: image, pixels: image, width: w, height: h };
                }),
                originals = rasters.map((r) => r.pixels.slice()),
                cache = new FinalSceneCache(4),
                reference = new PixelTileCache(4),
                a = surface(91, 73),
                b = surface(91, 73);
            try {
                for (const [name, camera] of [
                    ['fractional smoothing off', { scale: 1.25, zoom: 1, tx: -620.375, ty: -0.625 }],
                    ['same matrix smoothing on', { scale: 1.25, zoom: 0.625, tx: -620.375, ty: -0.625 }],
                    ['fractional paper edge', { scale: 1.5, zoom: 0.75, tx: 0.375, ty: 0.625 }],
                ]) {
                    paintScene(reference, b, rasters, camera);
                    paintScene(cache, a, rasters, camera);
                    if (!cache.stats.sceneTiles)
                        throw Error('Narrow viewport did not activate scene cropping');
                    if (
                        name === 'fractional smoothing off' &&
                        cache.stats.putImageDataBytes >= reference.stats.putImageDataBytes
                    )
                        throw Error(
                            'Narrow viewport did not reduce uploads compared with uncropped default mode',
                        );
                    await compare('Final scene cropped viewport ' + name, a, b, {
                        stats: cache.stats,
                        referenceStats: reference.stats,
                    });
                }
                const camera = { scale: 1.5, zoom: 0.75, tx: -750.125, ty: 5.125 },
                    simultaneous = [...rasters, { ...rasters[4], x: 11.25, y: -2.5 }];
                for (const phase of ['simultaneous placements', 'cached repeat']) {
                    const before = cache.stats;
                    paintScene(reference, b, simultaneous, camera);
                    paintScene(cache, a, simultaneous, camera);
                    if (
                        phase === 'cached repeat' &&
                        (cache.stats.uploads !== before.uploads ||
                            cache.stats.sceneCaptures !== before.sceneCaptures)
                    )
                        throw Error('Repeated same-owner placements uploaded or recaptured pixels');
                    await compare('Final scene cropped same owner ' + phase, a, b, { stats: cache.stats });
                }
                paintScene(reference, b, rasters, camera);
                paintScene(cache, a, rasters, camera);
                const at = (17 * w + 499) * 4,
                    old = rasters[4].pixels.slice(at, at + 4),
                    beforeHalo = b.context.getImageData(0, 0, 1, b.canvas.height).data.slice(),
                    changed = rasters.map((r, i) =>
                        i === 4 ? { ...r, dirty: [{ x: 499, y: 17, width: 1, height: 1 }] } : r,
                    );
                // The viewport starts at x=500.0833...; source pixel 499 still contributes through bilinear sampling.
                rasters[4].pixels.set([255, 0, 255, 255], at);
                paintScene(reference, b, changed, camera);
                paintScene(cache, a, changed, camera);
                const afterHalo = b.context.getImageData(0, 0, 1, b.canvas.height).data;
                if (!afterHalo.some((v, i) => v !== beforeHalo[i]))
                    throw Error('Outside source pixel did not affect the first visible column');
                await compare('Final scene cropped outside pixel contributes one-pixel halo', a, b, {
                    stats: cache.stats,
                });
                rasters[4].pixels.set(old, at);
                paintScene(reference, b, changed, camera);
                paintScene(cache, a, changed, camera);
                await compare('Final scene cropped halo rollback exact', a, b, { stats: cache.stats });

                const guardedImage = globalThis.ImageData,
                    allocatedAt = surfaces.length;
                let failed = false,
                    precedingSourceCanvas;
                globalThis.ImageData = new Proxy(guardedImage, {
                    construct() {
                        precedingSourceCanvas = surfaces.at(-1);
                        throw Error('Injected cropped ImageData allocation failure');
                    },
                });
                try {
                    paintScene(cache, a, rasters, { ...camera, tx: camera.tx + 19.375 });
                } catch (error) {
                    if (!String(error).includes('Injected cropped ImageData allocation failure')) throw error;
                    failed = true;
                } finally {
                    globalThis.ImageData = guardedImage;
                }
                const sourceFailureStats = cache.source.stats;
                if (
                    !failed ||
                    sourceFailureStats.tiles ||
                    sourceFailureStats.estimatedBytes ||
                    !precedingSourceCanvas ||
                    precedingSourceCanvas.width ||
                    precedingSourceCanvas.height
                )
                    throw Error(
                        'ImageData failure retained source pixels or its preceding Canvas allocation',
                    );
                // main.draw owns final-scene cleanup and resets the backing Canvas when source rendering fails.
                cache.clear();
                a.canvas.width = a.canvas.width;
                if (
                    cache.stats.tiles ||
                    cache.stats.estimatedBytes ||
                    surfaces.slice(allocatedAt).some((s) => s.width || s.height)
                )
                    throw Error('Main render failure cleanup retained scene/source surfaces');
                paintScene(reference, b, rasters, camera);
                paintScene(cache, a, rasters, camera);
                await compare('Final scene cropped ImageData failure releases Canvas and retries', a, b, {
                    stats: cache.stats,
                    sourceFailureStats,
                    failureCleanupOwner: 'main.draw catch',
                });
                for (let i = 0; i < rasters.length; i++)
                    if (rasters[i].pixels.some((v, at) => v !== originals[i][at]))
                        throw Error('Cropped viewport rendering changed authoritative pixels');
            } finally {
                cache.clear();
                reference.clear();
            }
        }
        for (const kind of ['allocation', 'context', 'capture', 'abandoned', 'resize']) {
            const rasters = Array.from({ length: 5 }, () => {
                    const image = pattern(64, 64);
                    return { owner: image, pixels: image, width: 64, height: 64 };
                }),
                cache = new FinalSceneCache(4),
                reference = new PixelTileCache(4),
                a = surface(64, 64),
                b = surface(64, 64),
                guardedCanvas = globalThis.OffscreenCanvas,
                contextPrototype = Object.getPrototypeOf(a.context),
                originalDrawImage = contextPrototype.drawImage,
                allocatedAt = surfaces.length;
            let failed = false;
            try {
                if (kind === 'allocation' || kind === 'context')
                    globalThis.OffscreenCanvas = new Proxy(guardedCanvas, {
                        construct(target, args) {
                            if (kind === 'allocation') throw Error('Injected scene allocation failure');
                            const canvas = Reflect.construct(target, args);
                            canvas.getContext = () => null;
                            return canvas;
                        },
                    });
                if (kind === 'capture')
                    contextPrototype.drawImage = function (image, ...args) {
                        if (image === a.canvas) throw Error('Injected final-scene capture failure');
                        return originalDrawImage.call(this, image, ...args);
                    };
                paintScene(cache, a, rasters, { finish: kind !== 'abandoned' && kind !== 'resize' });
                if (kind === 'resize') {
                    a.canvas.width = 65;
                    cache.finish(a.context);
                }
            } catch {
                failed = true;
            } finally {
                globalThis.OffscreenCanvas = guardedCanvas;
                contextPrototype.drawImage = originalDrawImage;
                guarding = false;
            }
            const attempted = surfaces.slice(allocatedAt);
            if (kind !== 'abandoned') {
                if (
                    !failed ||
                    cache.stats.tiles ||
                    cache.stats.estimatedBytes ||
                    attempted.some((s) => s.width && s.height)
                )
                    throw Error('Final-scene failure retained resources: ' + kind);
            } else if (failed) throw Error('Abandoned paint failed before the retry');
            if (kind === 'resize') a.canvas.width = 64;
            paintScene(reference, b, rasters);
            paintScene(cache, a, rasters);
            if (kind === 'abandoned' && attempted.some((s) => s.width && s.height))
                throw Error('Retry retained an abandoned scene/source surface');
            await compare('Final scene ' + kind + ' releases resources and retries', a, b, {
                stats: cache.stats,
            });
            cache.clear();
            reference.clear();
        }
        {
            // Two 1792² RGBA layers are 24.5 MiB authority, not the 256 MiB UI fixture.
            // This actual Chrome matrix reprojects the integer 355 edge below 355.
            const size = 1792,
                rasters = Array.from({ length: 2 }, () => {
                    const image = pattern(size, size);
                    return { owner: image, pixels: image, width: size, height: size };
                }),
                cache = new FinalSceneCache(6),
                reference = new PixelTileCache(6),
                a = surface(700, 700),
                b = surface(700, 700),
                camera = {
                    scale: 2.5343005657196045,
                    zoom: 1.2671502828598022,
                    tx: -3522.70654296875,
                    ty: -3522.70654296875,
                };
            paintScene(reference, b, rasters, camera);
            paintScene(cache, a, rasters, camera);
            if (!cache.stats.sceneTiles) throw Error('Roundtrip fixture did not activate final scenes');
            await compare('Final scene actual float32 roundtrip cold exact', a, b, { stats: cache.stats });
            const image = rasters[1].pixels,
                at = (1600 * size + 1600) * 4,
                old = image.slice(at, at + 4),
                changed = rasters.map((r, i) =>
                    i === 1 ? { ...r, dirty: [{ x: 1600, y: 1600, width: 1, height: 1 }] } : r,
                );
            image.set([255, 0, 255, 255], at);
            paintScene(reference, b, changed, camera);
            const region = paintScene(cache, a, changed, camera),
                bounds = region?.deviceBounds;
            if (!bounds || bounds.x !== 355 || bounds.y !== 355)
                throw Error('Missing exact integer device bounds for the real roundtrip counterexample');
            const roundtripLeft = camera.tx + region.x * camera.scale,
                roundtripTop = camera.ty + region.y * camera.scale;
            if (!(roundtripLeft < bounds.x && roundtripTop < bounds.y))
                throw Error('Roundtrip fixture did not reproduce the observed precision loss');
            await compare('Final scene actual float32 dirty keeps exact device bounds', a, b, {
                bounds,
                roundtripLeft,
                roundtripTop,
                stats: cache.stats,
            });
            const initial = cache.stats;
            paintScene(reference, b, changed, camera);
            paintScene(cache, a, changed, camera);
            const repeatedUploads = cache.stats.uploads - initial.uploads;
            if (repeatedUploads > 1)
                throw Error('Interior repeated dirty reloaded unrelated source cells: ' + repeatedUploads);
            await compare('Final scene actual float32 repeat avoids unrelated uploads', a, b, {
                repeatedUploads,
                stats: cache.stats,
            });
            image.set(old, at);
            paintScene(reference, b, changed, camera);
            paintScene(cache, a, changed, camera);
            await compare('Final scene actual float32 rollback exact', a, b, { stats: cache.stats });
            cache.clear();
            reference.clear();
        }
        {
            const width = 1280,
                height = 80,
                rasters = Array.from({ length: 3 }, () => {
                    const image = pattern(width, height);
                    return { owner: image, pixels: image, width, height };
                }),
                cache = new FinalSceneCache(6),
                reference = new PixelTileCache(6),
                a = surface(1100, 136),
                b = surface(1100, 136),
                camera = { scale: 1.5, zoom: 0.75, tx: -700.125, ty: 5.125 },
                image = rasters[2].pixels,
                original = image.slice();
            paintScene(reference, b, rasters, camera);
            paintScene(cache, a, rasters, camera);
            if (!cache.stats.sceneTiles) throw Error('Source boundary fixture did not activate final scenes');
            const dirty = [
                    { x: 508, y: 6, width: 4, height: 4 },
                    { x: 1018, y: 6, width: 4, height: 4 },
                ],
                changed = rasters.map((r, i) => (i === 2 ? { ...r, dirty } : r));
            for (const rect of dirty)
                for (let y = rect.y; y < rect.y + rect.height; y++)
                    for (let x = rect.x; x < rect.x + rect.width; x++)
                        image.set([255, 0, 255, 255], (y * width + x) * 4);
            paintScene(reference, b, changed, camera);
            paintScene(cache, a, changed, camera);
            await compare('Final scene source510 and1020 boundary dirty exact', a, b, { stats: cache.stats });
            image.set(original);
            paintScene(reference, b, changed, camera);
            paintScene(cache, a, changed, camera);
            await compare('Final scene source510 and1020 boundary rollback exact', a, b, {
                stats: cache.stats,
            });
            if (image.some((value, index) => value !== original[index]))
                throw Error('Source boundary rollback changed authoritative pixels');
            cache.clear();
            reference.clear();
        }
        {
            const image = pattern(8, 8),
                original = image.slice(),
                cache = new PixelTileCache(4),
                a = surface(8, 8),
                b = surface(8, 8),
                viewport = { x: 0, y: 0, width: 8, height: 8 };
            draw(cache, a.context, image, image, 8, 8, viewport);
            b.context.drawImage(a.canvas, 0, 0);
            const initial = JSON.stringify(cache.stats),
                valid = { x: 0, y: 0, width: 8, height: 8 },
                invalid = [
                    { ...valid, x: -1 },
                    { ...valid, y: -1 },
                    { ...valid, width: -1 },
                    { ...valid, height: -1 },
                    { ...valid, x: 0.5 },
                    { ...valid, width: 0.5 },
                    { ...valid, x: NaN },
                    { ...valid, height: Infinity },
                    { ...valid, x: Number.MAX_SAFE_INTEGER + 1 },
                    { ...valid, x: 1 },
                    { ...valid, y: 1 },
                ];
            for (const deviceBounds of invalid) {
                let rejected = false;
                try {
                    draw(cache, a.context, image, image, 8, 8, { ...viewport, deviceBounds });
                } catch {
                    rejected = true;
                }
                if (!rejected)
                    throw Error('Invalid device bounds were accepted: ' + JSON.stringify(deviceBounds));
                if (JSON.stringify(cache.stats) !== initial)
                    throw Error('Rejected device bounds mutated retained cache state');
            }
            draw(cache, a.context, image, image, 8, 8, {
                ...viewport,
                deviceBounds: { x: 0, y: 0, width: 0, height: 0 },
            });
            await compare('Invalid device bounds reject before painting or cache mutation', a, b, {
                rejectedCases: invalid.length,
                emptyBoundsAcceptedWithoutPainting: true,
            });
            if (image.some((value, index) => value !== original[index]))
                throw Error('Rejected device bounds changed authoritative pixels');
            cache.clear();
        }
        if (pixels.some((v, i) => v !== before[i])) throw Error('Rendering changed authoritative pixels');
        // Cooperative cases reuse the independent box oracle; task turns below belong to
        // this bounded test driver, not Studio's elapsed-time scheduler or a latency claim.
        function prepareStep(cache, ...args) {
            guarding = true;
            let ready;
            try {
                ready = cache.prepare(...args);
            } finally {
                guarding = false;
            }
            const stats = cache.stats;
            if (
                stats.tiles > stats.maxTiles ||
                stats.estimatedBytes < 0 ||
                stats.estimatedBytes > stats.byteBudget ||
                stats.largestSurfaceDimension > 512
            )
                throw Error('Cooperative preparation exceeded its resource bounds');
            return ready;
        }
        async function finishPreparation(cache, args) {
            let steps = 0,
                taskTurns = 0;
            while (++steps <= 32) {
                if (prepareStep(cache, ...args)) return { steps, taskTurns };
                await new Promise((resolve) =>
                    setTimeout(() => {
                        taskTurns++;
                        resolve();
                    }, 0),
                );
            }
            throw Error('Cooperative preparation did not finish in32 bounded steps');
        }
        const cooperativePut = OffscreenCanvasRenderingContext2D.prototype.putImageData;
        let cooperativeUploads = [];
        OffscreenCanvasRenderingContext2D.prototype.putImageData = function (image, ...args) {
            if (guarding)
                cooperativeUploads.push({
                    width: image.width,
                    height: image.height,
                    pixels: image.data.slice(),
                    args,
                });
            return cooperativePut.call(this, image, ...args);
        };
        try {
            for (const kind of ['late-mismatch', 'low-alpha', 'unaligned-odd', 'transform-rollback']) {
                const w = 131,
                    h = 19,
                    storage = new Uint8ClampedArray(w * h * 4 + (kind === 'unaligned-odd' ? 1 : 0)),
                    image = kind === 'unaligned-odd' ? storage.subarray(1) : storage,
                    cache = new PixelTileCache(4, 2 * 1024 * 1024),
                    originalOwner = {},
                    previewOwner = {},
                    actual = surface(20, 8),
                    reference = surface(20, 8),
                    matrix = new DOMMatrix([1 / 16, 0, 0, 1 / 16, 2, 2]),
                    viewport = { x: -32, y: -32, width: 320, height: 128 };
                for (let y = 0; y < h; y++)
                    for (let x = 0; x < w; x++) {
                        const at = (y * w + x) * 4;
                        image.set(
                            kind === 'late-mismatch'
                                ? [255, 255, 255, 255]
                                : [(x * 17) % 256, (y * 19) % 256, (x ^ y) % 256, [0, 1, 2, 128][x % 4]],
                            at,
                        );
                    }
                if (kind === 'late-mismatch') image.set([0, 37, 83, 255], image.length - 4);
                const original = image.slice(),
                    hook = (data, x, y, width) => {
                        for (let col = 0; col < width; col++)
                            if (x + col >= 7 && x + col < 18 && y >= 3 && y < 12)
                                data.set([43, 181, 79, 83], col * 4);
                    };
                try {
                    for (const phase of kind === 'transform-rollback'
                        ? ['original', 'preview', 'cancel']
                        : ['original']) {
                        for (const target of [actual, reference]) {
                            target.context.setTransform(1, 0, 0, 1, 0, 0);
                            target.context.fillStyle = '#123456';
                            target.context.fillRect(0, 0, 20, 8);
                        }
                        const beforeCanvas = actual.context.getImageData(0, 0, 20, 8).data.slice(),
                            transform = phase === 'preview' ? hook : undefined,
                            owner = phase === 'preview' ? previewOwner : originalOwner,
                            before = cache.stats;
                        cooperativeUploads = [];
                        const progress = await finishPreparation(cache, [
                            actual.context,
                            owner,
                            image,
                            w,
                            h,
                            viewport,
                            undefined,
                            0,
                            0,
                            transform,
                            matrix,
                        ]);
                        if (
                            actual.context
                                .getImageData(0, 0, 20, 8)
                                .data.some((v, i) => v !== beforeCanvas[i])
                        )
                            throw Error('Preparation painted the destination Canvas');
                        if (cache.stats.mipFactor !== 8)
                            throw Error('Small cooperative fixture must use factor8');
                        const expectedSource = original.slice();
                        if (transform)
                            for (let y = 0; y < h; y++)
                                hook(expectedSource.subarray(y * w * 4, (y + 1) * w * 4), 0, y, w, 1);
                        const mip = boxReference(expectedSource, w, h, 8);
                        if (phase === 'cancel') {
                            if (cooperativeUploads.length || cache.stats.uploads !== before.uploads)
                                throw Error('Preview cancellation rebuilt unchanged original tiles');
                        } else if (
                            cooperativeUploads.length !== 1 ||
                            cooperativeUploads[0].width !== mip.width ||
                            cooperativeUploads[0].height !== mip.height ||
                            cooperativeUploads[0].pixels.some((v, i) => v !== mip.pixels[i])
                        )
                            throw Error('Cooperative raw mip differs from independent boxReference');
                        const uploads = cache.stats.uploads;
                        actual.context.setTransform(matrix);
                        draw(cache, actual.context, owner, image, w, h, viewport, undefined, 0, 0, transform);
                        if (cache.stats.uploads !== uploads)
                            throw Error('Drawing a prepared mip rebuilt pixels');
                        const src = surface(mip.width, mip.height);
                        src.context.putImageData(new OriginalImage(mip.pixels, mip.width, mip.height), 0, 0);
                        reference.context.setTransform(0.5, 0, 0, 0.5, 2, 2);
                        reference.context.save();
                        reference.context.beginPath();
                        reference.context.rect(0, 0, w / 8, h / 8);
                        reference.context.clip();
                        reference.context.drawImage(src.canvas, 0, 0);
                        reference.context.restore();
                        await compare('Cooperative exact ' + kind + '/' + phase, actual, reference, {
                            ...progress,
                            stats: cache.stats,
                            rawUploadChecked: phase !== 'cancel',
                        });
                        if (image.some((v, i) => v !== original[i]))
                            throw Error('Preparation mutated authoritative RGBA');
                    }
                } catch (error) {
                    checks.push({
                        name: 'Cooperative exact ' + kind,
                        contractFailures: 1,
                        error: String(error.stack || error),
                    });
                } finally {
                    cache.clear();
                }
            }
            {
                const w = 1025,
                    h = 129,
                    image = new Uint8ClampedArray(w * h * 4),
                    original = image.slice(),
                    cache = new PixelTileCache(4, 2 * 1024 * 1024),
                    target = surface(4, 4),
                    owner = {},
                    viewport = { x: 0, y: 0, width: 8192, height: 8192 },
                    matrix = new DOMMatrix([1 / 4096, 0, 0, 1 / 4096, 0, 0]);
                image.set([215, 31, 63, 144], image.length - 4);
                original.set(image);
                try {
                    target.context.fillStyle = '#123456';
                    target.context.fillRect(0, 0, 4, 4);
                    const beforeCanvas = target.context.getImageData(0, 0, 4, 4).data.slice();
                    cooperativeUploads = [];
                    const progress = await finishPreparation(cache, [
                        target.context,
                        owner,
                        image,
                        w,
                        h,
                        viewport,
                        undefined,
                        0,
                        0,
                        undefined,
                        matrix,
                    ]);
                    const mip = boxReference(image, w, h, 2048);
                    if (cache.stats.mipFactor !== 2048 || progress.taskTurns < 4 || progress.steps > 8)
                        throw Error(
                            'Uniform scan and averaging must both yield inside the single output cell',
                        );
                    if (
                        cooperativeUploads.length !== 1 ||
                        cooperativeUploads[0].width !== 1 ||
                        cooperativeUploads[0].height !== 1 ||
                        cooperativeUploads[0].pixels.some((v, i) => v !== mip.pixels[i])
                    )
                        throw Error('Resumed single-cell average differs from boxReference');
                    if (cache.stats.estimatedBytes !== 8)
                        throw Error('Completed single-cell preparation retained scratch');
                    if (
                        target.context.getImageData(0, 0, 4, 4).data.some((v, i) => v !== beforeCanvas[i]) ||
                        image.some((v, i) => v !== original[i])
                    )
                        throw Error('Resumed preparation changed target or authority');
                    checks.push({
                        name: 'Cooperative single-cell source checkpoints and task progress',
                        ...progress,
                        sourceBytes: image.byteLength,
                        stats: cache.stats,
                        rawUploadChecked: true,
                    });
                } catch (error) {
                    checks.push({
                        name: 'Cooperative single-cell source checkpoints and task progress',
                        contractFailures: 1,
                        error: String(error.stack || error),
                    });
                } finally {
                    cache.clear();
                }
            }
            for (const mode of [
                'cancel',
                'invalidate',
                'unknown-owner-invalidate',
                'retain-remove',
                'retain-keep',
                'clear',
                'replacement',
                'draw',
            ]) {
                const w = 1025,
                    h = 129,
                    image = new Uint8ClampedArray(w * h * 4).fill(255),
                    cache = new PixelTileCache(4, 2 * 1024 * 1024),
                    owner = {},
                    target = surface(4, 4),
                    viewport = { x: 0, y: 0, width: 8192, height: 8192 },
                    matrix = new DOMMatrix([1 / 4096, 0, 0, 1 / 4096, 0, 0]);
                image.set([0, 37, 83, 255], image.length - 4);
                try {
                    cooperativeUploads = [];
                    if (
                        prepareStep(
                            cache,
                            target.context,
                            owner,
                            image,
                            w,
                            h,
                            viewport,
                            undefined,
                            0,
                            0,
                            undefined,
                            matrix,
                        )
                    )
                        throw Error('Cancellation fixture must pause');
                    const paused = cache.stats;
                    if (paused.uploads || paused.estimatedBytes <= 8)
                        throw Error('Paused cursor must reserve scratch before upload');
                    if (mode === 'retain-keep') cache.retain([owner]);
                    else {
                        for (let i = 0; i < 65536; i++) image.set([0, 0, 0, 255], i * 4);
                        if (mode === 'cancel') cache.cancelPrepare();
                        else if (mode === 'invalidate')
                            cache.invalidate(owner, [{ x: 0, y: 0, width: w, height: 64 }]);
                        else if (mode === 'unknown-owner-invalidate') cache.invalidate({}, 'all');
                        else if (mode === 'retain-remove') cache.retain([]);
                        else if (mode === 'clear') cache.clear();
                    }
                    if (
                        ['cancel', 'invalidate', 'unknown-owner-invalidate'].includes(mode) &&
                        cache.stats.estimatedBytes !== 8
                    )
                        throw Error('Cancellation did not immediately release the scratch lease');
                    if (
                        ['retain-remove', 'clear'].includes(mode) &&
                        (cache.stats.estimatedBytes || cache.stats.tiles)
                    )
                        throw Error('Owner removal did not immediately release paused resources');
                    let progress;
                    if (mode === 'draw') {
                        target.context.setTransform(matrix);
                        draw(cache, target.context, owner, image, w, h, viewport);
                        progress = { steps: 1, taskTurns: 0 };
                    } else {
                        const source = mode === 'replacement' ? image.slice() : image;
                        progress = await finishPreparation(cache, [
                            target.context,
                            owner,
                            source,
                            w,
                            h,
                            viewport,
                            undefined,
                            0,
                            0,
                            undefined,
                            matrix,
                        ]);
                        if (mode === 'retain-keep' && progress.steps !== 4)
                            throw Error('Retaining a paused owner restarted rather than resumed its cursor');
                    }
                    const mip = boxReference(image, w, h, 2048);
                    if (
                        cooperativeUploads.length !== 1 ||
                        cooperativeUploads[0].pixels.some((v, i) => v !== mip.pixels[i])
                    )
                        throw Error('Cancelled preparation published stale source pixels');
                    if (cache.stats.estimatedBytes !== 8)
                        throw Error('Cancelled cursor leaked or double-released scratch');
                    cache.cancelPrepare();
                    cache.cancelPrepare();
                    cache.clear();
                    cache.clear();
                    if (cache.stats.estimatedBytes !== 0 || cache.stats.tiles !== 0)
                        throw Error('Repeated cooperative cleanup retained resources');
                    checks.push({
                        name: 'Cooperative ownership ' + mode,
                        ...progress,
                        paused,
                        released: cache.stats,
                    });
                } catch (error) {
                    checks.push({
                        name: 'Cooperative ownership ' + mode,
                        contractFailures: 1,
                        error: String(error.stack || error),
                    });
                } finally {
                    cache.clear();
                }
            }
            {
                const w = 513,
                    h = 257,
                    image = new Uint8ClampedArray(w * h * 4).fill(255),
                    cache = new PixelTileCache(4, 2 * 1024 * 1024),
                    owner = {},
                    target = surface(130, 66),
                    viewport = { x: 0, y: 0, width: 520, height: 264 },
                    matrix = new DOMMatrix([0.25, 0, 0, 0.25, 0, 0]);
                image.set([0, 37, 83, 255], image.length - 4);
                try {
                    cache.beginFrame(1);
                    cooperativeUploads = [];
                    if (
                        prepareStep(
                            cache,
                            target.context,
                            owner,
                            image,
                            w,
                            h,
                            viewport,
                            undefined,
                            0,
                            0,
                            undefined,
                            matrix,
                        )
                    )
                        throw Error('Frame-count fixture must pause');
                    const paused = cache.stats;
                    if (paused.mipFactor !== 2)
                        throw Error('Initial frame-count fixture must select factor2');
                    cache.beginFrame(32);
                    if (cache.stats.estimatedBytes !== paused.estimatedBytes - 16896)
                        throw Error('Changed raster count did not release the pending scratch lease');
                    const progress = await finishPreparation(cache, [
                            target.context,
                            owner,
                            image,
                            w,
                            h,
                            viewport,
                            undefined,
                            0,
                            0,
                            undefined,
                            matrix,
                        ]),
                        mip = boxReference(image, w, h, 8);
                    if (
                        cache.stats.mipFactor !== 8 ||
                        cooperativeUploads.length !== 1 ||
                        cooperativeUploads[0].width !== mip.width ||
                        cooperativeUploads[0].height !== mip.height ||
                        cooperativeUploads[0].pixels.some((v, i) => v !== mip.pixels[i])
                    )
                        throw Error('Changed raster count reused the stale factor/budget plan');
                    const uploads = cache.stats.uploads;
                    target.context.setTransform(matrix);
                    draw(cache, target.context, owner, image, w, h, viewport);
                    if (cache.stats.uploads !== uploads)
                        throw Error('Drawing the new frame rebuilt a prepared mip');
                    checks.push({
                        name: 'Cooperative changed visible-raster count cancels and replans factor2 to8',
                        ...progress,
                        paused,
                        stats: cache.stats,
                    });
                } catch (error) {
                    checks.push({
                        name: 'Cooperative changed visible-raster count cancels and replans factor2 to8',
                        contractFailures: 1,
                        error: String(error.stack || error),
                    });
                } finally {
                    cache.clear();
                }
            }
            for (const kind of ['surface', 'image', 'context', 'transform', 'upload']) {
                const w = 1025,
                    h = 129,
                    image = new Uint8ClampedArray(w * h * 4).fill(255),
                    cache = new PixelTileCache(4, 2 * 1024 * 1024),
                    target = surface(4, 4),
                    owner = {},
                    viewport = { x: 0, y: 0, width: 8192, height: 8192 },
                    matrix = new DOMMatrix([1 / 4096, 0, 0, 1 / 4096, 0, 0]),
                    Canvas = globalThis.OffscreenCanvas,
                    Image = globalThis.ImageData,
                    get = OriginalCanvas.prototype.getContext,
                    put = OffscreenCanvasRenderingContext2D.prototype.putImageData,
                    firstSurface = surfaces.length;
                let fired = false,
                    rows = 0,
                    rejected = false;
                image.set([0, 37, 83, 255], image.length - 4);
                const hook = () => {
                    if (++rows === 70) {
                        fired = true;
                        throw Error('Injected cooperative transform failure');
                    }
                };
                try {
                    if (kind === 'surface')
                        globalThis.OffscreenCanvas = new Proxy(Canvas, {
                            construct(Type, args) {
                                if (guarding && !fired) {
                                    fired = true;
                                    throw Error('Injected cooperative surface failure');
                                }
                                return Reflect.construct(Type, args);
                            },
                        });
                    if (kind === 'image')
                        globalThis.ImageData = new Proxy(Image, {
                            construct(Type, args) {
                                if (guarding && !fired) {
                                    fired = true;
                                    throw Error('Injected cooperative image failure');
                                }
                                return Reflect.construct(Type, args);
                            },
                        });
                    if (kind === 'context')
                        OriginalCanvas.prototype.getContext = function (...args) {
                            if (guarding && !fired) {
                                fired = true;
                                return null;
                            }
                            return get.apply(this, args);
                        };
                    if (kind === 'upload')
                        OffscreenCanvasRenderingContext2D.prototype.putImageData = function (...args) {
                            if (guarding && !fired) {
                                fired = true;
                                throw Error('Injected cooperative upload failure');
                            }
                            return put.apply(this, args);
                        };
                    try {
                        await finishPreparation(cache, [
                            target.context,
                            owner,
                            image,
                            w,
                            h,
                            viewport,
                            undefined,
                            0,
                            0,
                            kind === 'transform' ? hook : undefined,
                            matrix,
                        ]);
                    } catch (error) {
                        if (kind !== 'context' && !String(error).includes('Injected cooperative'))
                            throw error;
                        rejected = true;
                    }
                    if (
                        !fired ||
                        !rejected ||
                        cache.stats.tiles ||
                        cache.stats.estimatedBytes ||
                        surfaces.slice(firstSurface).some((s) => s.width && s.height)
                    )
                        throw Error('Cooperative failure retained scratch or partial surfaces: ' + kind);
                    checks.push({
                        name: 'Cooperative failure cleanup ' + kind,
                        rejected,
                        released: cache.stats,
                    });
                } catch (error) {
                    checks.push({
                        name: 'Cooperative failure ' + kind,
                        contractFailures: 1,
                        error: String(error.stack || error),
                    });
                } finally {
                    globalThis.OffscreenCanvas = Canvas;
                    globalThis.ImageData = Image;
                    OriginalCanvas.prototype.getContext = get;
                    OffscreenCanvasRenderingContext2D.prototype.putImageData = put;
                }
                try {
                    cooperativeUploads = [];
                    const progress = await finishPreparation(cache, [
                            target.context,
                            owner,
                            image,
                            w,
                            h,
                            viewport,
                            undefined,
                            0,
                            0,
                            undefined,
                            matrix,
                        ]),
                        mip = boxReference(image, w, h, 2048);
                    if (
                        cooperativeUploads.length !== 1 ||
                        cooperativeUploads[0].pixels.some((v, i) => v !== mip.pixels[i])
                    )
                        throw Error('Retry after cooperative failure differs from boxReference');
                    checks.push({
                        name: 'Cooperative failure retry ' + kind,
                        ...progress,
                        stats: cache.stats,
                    });
                } catch (error) {
                    checks.push({
                        name: 'Cooperative failure retry ' + kind,
                        contractFailures: 1,
                        error: String(error.stack || error),
                    });
                } finally {
                    cache.clear();
                }
            }
            {
                const image = pattern(131, 19),
                    cache = new PixelTileCache(4, 2 * 1024 * 1024),
                    target = surface(20, 8),
                    owner = {},
                    viewport = { x: 0, y: 0, width: 320, height: 128 },
                    matrix = new DOMMatrix([1 / 16, 0, 0, 1 / 16, 0, 0]),
                    Float = globalThis.Float64Array;
                let allocations = 0;
                try {
                    if (!prepareStep(cache, target.context, owner, image, 131, 19, viewport))
                        throw Error('factor1 preparation unexpectedly yielded');
                    if (cache.stats.tiles || cache.stats.estimatedBytes || cache.stats.uploads)
                        throw Error('factor1 preparation performed pixel work');
                    await finishPreparation(cache, [
                        target.context,
                        owner,
                        image,
                        131,
                        19,
                        viewport,
                        undefined,
                        0,
                        0,
                        undefined,
                        matrix,
                    ]);
                    const initial = cache.stats;
                    globalThis.Float64Array = new Proxy(Float, {
                        construct(Type, args) {
                            if (guarding) allocations++;
                            return Reflect.construct(Type, args);
                        },
                    });
                    if (
                        !prepareStep(
                            cache,
                            target.context,
                            owner,
                            image,
                            131,
                            19,
                            viewport,
                            undefined,
                            0,
                            0,
                            undefined,
                            matrix,
                        )
                    )
                        throw Error('Ready mip hit yielded');
                    if (
                        allocations ||
                        cache.stats.uploads !== initial.uploads ||
                        cache.stats.estimatedBytes !== initial.estimatedBytes
                    )
                        throw Error('Ready mip hit rebuilt pixels or allocated scratch');
                    image.set([215, 31, 63, 144], (8 * 131 + 15) * 4);
                    cache.invalidate(owner, [{ x: 15, y: 8, width: 1, height: 1 }]);
                    const before = cache.stats;
                    if (
                        !prepareStep(
                            cache,
                            target.context,
                            owner,
                            image,
                            131,
                            19,
                            viewport,
                            undefined,
                            0,
                            0,
                            undefined,
                            matrix,
                        )
                    )
                        throw Error('One mip-cell dirty patch yielded');
                    const bytes = cache.stats.putImageDataBytes - before.putImageDataBytes;
                    if (bytes !== 4) throw Error('Small dirty patch uploaded more than one mip cell');
                    checks.push({
                        name: 'Cooperative factor1 ready-hit and small-dirty fast paths',
                        hitScratchAllocations: 0,
                        dirtyBytes: bytes,
                        stats: cache.stats,
                    });
                } catch (error) {
                    checks.push({
                        name: 'Cooperative factor1 ready-hit and small-dirty fast paths',
                        contractFailures: 1,
                        error: String(error.stack || error),
                    });
                } finally {
                    globalThis.Float64Array = Float;
                    cache.clear();
                }
            }
        } finally {
            OffscreenCanvasRenderingContext2D.prototype.putImageData = cooperativePut;
        }
        if (surfaces.some((s) => s.width && s.height)) throw Error('Test left retained tile surfaces');
        checks.push({
            name: 'Independent allocation guards',
            largestCreated,
            imageDataLargest,
            retainedSurfaceCount: 0,
            mismatchedChannels: 0,
        });
        return checks;
    });
    if (
        report.pageErrors.length ||
        report.checks.some((c) => c.contractFailures || (!c.informational && c.mismatchedChannels))
    )
        process.exitCode = 1;
} catch (error) {
    report.failure = String(error.stack || error);
    process.exitCode = 1;
} finally {
    clearTimeout(watchdog);
    await browser?.close();
    await server.close();
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
