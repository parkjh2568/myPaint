import { createSurface, context2D } from './surface';
import {
    type State,
    type Color,
    type ResourceProfile,
    cloneState,
    webLimits,
    validateProfile,
    validate,
    validateSize,
} from '../engine/document';
import type { GeometryChange } from '../engine/operations';
export type { GeometryChange } from '../engine/operations';
export interface Raster {
    width: number;
    height: number;
    pixels: Uint8ClampedArray;
}
export interface SelectionRequest {
    points: Float64Array;
    left: number;
    top: number;
    key: Color;
    transparent: boolean;
}
let active = 0;
export async function runCodec(
    operation: string,
    state?: State,
    bytes?: Uint8Array,
    signal?: AbortSignal,
    profile: ResourceProfile = webLimits,
    selection?: SelectionRequest,
): Promise<{ state?: State; image?: Raster; bytes?: Uint8Array }> {
    validateProfile(profile);
    if (
        ![
            'project-read',
            'png-read',
            'project-write',
            'png-write',
            'jpg-write',
            'bmp-write',
            'selection',
            'fill',
            'layer-edit',
            'geometry',
        ].includes(operation)
    )
        throw Error('지원하지 않는 작업');
    signal?.throwIfAborted();
    if (state) validate(state, profile);
    if (bytes && bytes.length > profile.inputBytes)
        throw Error(`입력은 ${profile.inputBytes / 1048576} MiB 이내여야 합니다.`);
    if (active >= 2) throw Error('이미지 작업이 진행 중입니다. 잠시 후 다시 시도하세요.');
    const sourceWidth = state?.width,
        sourceHeight = state?.height;
    active++;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
        return await new Promise((resolve, reject) => {
            worker = new Worker(new URL('../workers/codec.worker.ts', import.meta.url), { type: 'module' });
            abort = () => reject(Error('작업을 취소했습니다.'));
            timer = setTimeout(
                () => reject(Error('이미지 작업 시간이 초과됐습니다. 현재 그림은 유지됩니다.')),
                20000,
            );
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) {
                abort();
                return;
            }
            worker.onmessage = (event) => {
                try {
                    const result = event.data;
                    if (
                        !result ||
                        typeof result !== 'object' ||
                        Array.isArray(result) ||
                        result.profileId !== profile.id
                    )
                        throw Error('이미지 작업의 자원 프로필이 일치하지 않습니다.');
                    if (Object.prototype.hasOwnProperty.call(result, 'error'))
                        throw Error(
                            typeof result.error === 'string' && result.error
                                ? result.error
                                : '이미지 작업 실패',
                        );
                    if (
                        (['project-read', 'layer-edit', 'geometry'].includes(operation) && !result.state) ||
                        ((operation === 'png-read' || operation === 'selection') && !result.image) ||
                        ((operation.endsWith('-write') || operation === 'selection') && !result.bytes) ||
                        (operation === 'fill' && !Object.prototype.hasOwnProperty.call(result, 'image'))
                    )
                        throw Error('이미지 작업 결과가 올바르지 않습니다.');
                    if (result.state !== undefined) {
                        const candidate = result.state as State;
                        if (
                            !candidate ||
                            !Array.isArray(candidate.layers) ||
                            !Array.isArray(candidate.background) ||
                            candidate.layers.length < 1 ||
                            candidate.layers.length > profile.layers ||
                            candidate.layers.some(
                                (layer) =>
                                    !layer ||
                                    typeof layer.name !== 'string' ||
                                    !(layer.pixels instanceof Uint8ClampedArray),
                            )
                        )
                            throw Error('이미지 작업의 문서 픽셀이 올바르지 않습니다.');
                        for (let index = 0; index < 4; index++)
                            if (!Object.prototype.hasOwnProperty.call(candidate.background, index))
                                throw Error('이미지 작업의 바탕색이 올바르지 않습니다.');
                        validate(candidate, profile);
                    }
                    if (result.image !== undefined) {
                        const image = result.image as Raster;
                        if (!image || typeof image !== 'object')
                            throw Error('이미지 작업 결과가 올바르지 않습니다.');
                        validateSize(image.width, image.height, 1, profile);
                        if (
                            !(image.pixels instanceof Uint8ClampedArray) ||
                            image.pixels.length !== image.width * image.height * 4
                        )
                            throw Error('이미지 작업의 픽셀 크기가 올바르지 않습니다.');
                        if (operation === 'fill') {
                            const region = image as Raster & { left: number; top: number };
                            if (
                                !Number.isSafeInteger(region.left) ||
                                !Number.isSafeInteger(region.top) ||
                                region.left < 0 ||
                                region.top < 0 ||
                                sourceWidth === undefined ||
                                sourceHeight === undefined ||
                                region.left + region.width > sourceWidth ||
                                region.top + region.height > sourceHeight
                            )
                                throw Error('색상 처리 결과 영역이 올바르지 않습니다.');
                        }
                    }
                    if (
                        result.bytes !== undefined &&
                        (!(result.bytes instanceof Uint8Array) ||
                            result.bytes.length < 1 ||
                            result.bytes.length > profile.inputBytes)
                    )
                        throw Error(`이미지 출력은 ${profile.inputBytes / 1048576} MiB 이내여야 합니다.`);
                    if (
                        operation === 'selection' &&
                        (result.image.width !== sourceWidth ||
                            result.image.height !== sourceHeight ||
                            result.bytes.length !== result.image.width * result.image.height)
                    )
                        throw Error('선택 영역 결과 크기가 올바르지 않습니다.');
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            };
            worker.onerror = (event) => {
                event.preventDefault();
                reject(Error(event.message || '이미지 작업 실패'));
            };
            worker.onmessageerror = () => reject(Error('이미지 작업 결과를 읽지 못했습니다.'));
            const transfer: ArrayBuffer[] = [];
            if (state) for (const l of state.layers) transfer.push(l.pixels.buffer as ArrayBuffer);
            if (bytes) transfer.push(bytes.buffer as ArrayBuffer);
            if (selection) transfer.push(selection.points.buffer as ArrayBuffer);
            worker.postMessage({ operation, state, bytes, selection, profileId: profile.id }, transfer);
        });
    } finally {
        clearTimeout(timer);
        if (abort) signal?.removeEventListener('abort', abort);
        worker?.terminate();
        active--;
    }
}

export async function readArtwork(
    file: Pick<File, 'size' | 'arrayBuffer'>,
    signal?: AbortSignal,
    profile: ResourceProfile = webLimits,
): Promise<State> {
    validateProfile(profile);
    signal?.throwIfAborted();
    const size = file.size;
    if (!Number.isSafeInteger(size) || size < 0) throw Error('파일 크기 정보가 올바르지 않습니다.');
    if (size > profile.inputBytes) throw Error(`파일은 ${profile.inputBytes / 1048576} MiB 이내여야 합니다.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    signal?.throwIfAborted();
    if (bytes.byteLength > profile.inputBytes)
        throw Error(`파일은 ${profile.inputBytes / 1048576} MiB 이내여야 합니다.`);
    if (bytes.byteLength !== size) throw Error('읽은 파일의 크기가 파일 정보와 일치하지 않습니다.');
    if (bytes.length < 8) throw Error('잘린 파일입니다.');
    if (new TextDecoder().decode(bytes.subarray(0, 8)) === 'RPAINT01')
        return (await runCodec('project-read', undefined, bytes, signal, profile)).state!;
    if (bytes[0] === 137 && bytes[1] === 80) {
        const image = (await runCodec('png-read', undefined, bytes, signal, profile)).image!;
        return {
            width: image.width,
            height: image.height,
            background: [255, 255, 255, 255],
            active: 0,
            layers: [{ name: '이미지', visible: true, pixels: image.pixels }],
        };
    }
    const view = new DataView(bytes.buffer);
    let width = 0,
        height = 0;
    if (bytes[0] === 66 && bytes[1] === 77 && bytes.length >= 26) {
        const dib = view.getUint32(14, true);
        width = dib === 12 ? view.getUint16(18, true) : Math.abs(view.getInt32(18, true));
        height = dib === 12 ? view.getUint16(20, true) : Math.abs(view.getInt32(22, true));
    } else if (String.fromCharCode(...bytes.subarray(0, 3)) === 'GIF') {
        const signature = String.fromCharCode(...bytes.subarray(0, 6));
        if (bytes.length < 13 || (signature !== 'GIF87a' && signature !== 'GIF89a'))
            throw Error('GIF 헤더 오류');
        width = view.getUint16(6, true);
        height = view.getUint16(8, true);
        validateSize(width, height, 1, profile);
        let position = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0),
            checkpoint = position + 256 * 1024,
            started = performance.now();
        for (;;) {
            if (position >= bytes.length) throw Error('잘린 GIF');
            const block = bytes[position++];
            if (block === 0x2c) {
                if (bytes.length - position < 9) throw Error('잘린 GIF 이미지');
                // Decoders may expand the logical screen to include the first frame.
                width = Math.max(width, view.getUint16(position, true) + view.getUint16(position + 4, true));
                height = Math.max(
                    height,
                    view.getUint16(position + 2, true) + view.getUint16(position + 6, true),
                );
                break;
            }
            if (block !== 0x21 || position >= bytes.length) throw Error('GIF 이미지 헤더 오류');
            position++;
            for (;;) {
                if (position >= bytes.length) throw Error('잘린 GIF 확장 블록');
                const length = bytes[position++];
                if (length > bytes.length - position) throw Error('잘린 GIF 확장 블록');
                position += length;
                if (position >= checkpoint) {
                    if (performance.now() - started >= 4) {
                        await new Promise<void>((resolve) => setTimeout(resolve, 0));
                        signal?.throwIfAborted();
                        started = performance.now();
                    }
                    checkpoint = position + 256 * 1024;
                }
                if (!length) break;
            }
        }
    } else if (bytes[0] === 255 && bytes[1] === 216) {
        let pos = 2;
        while (pos + 4 <= bytes.length) {
            if (bytes[pos++] !== 255) throw Error('JPEG 헤더 오류');
            while (bytes[pos] === 255) pos++;
            const marker = bytes[pos++];
            if (marker === 217 || marker === 218) break;
            if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
            const length = view.getUint16(pos);
            if (length < 2 || length > bytes.length - pos) throw Error('잘린 JPEG');
            if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
                if (length < 7) throw Error('JPEG 크기 오류');
                height = view.getUint16(pos + 3);
                width = view.getUint16(pos + 5);
                break;
            }
            pos += length;
        }
    } else throw Error('PNG, JPEG, BMP, GIF, rpaint 파일만 열 수 있습니다.');
    validateSize(width, height, 1, profile);
    signal?.throwIfAborted();
    const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
        imageOrientation: 'from-image',
    });
    let tile: ReturnType<typeof createSurface> | undefined;
    try {
        signal?.throwIfAborted();
        validateSize(bitmap.width, bitmap.height, 1, profile);
        const pixels = new Uint8ClampedArray(bitmap.width * bitmap.height * 4);
        tile = createSurface(Math.min(512, bitmap.width), Math.min(512, bitmap.height));
        const ctx = context2D(tile);
        for (let y = 0; y < bitmap.height; y += 512)
            for (let x = 0; x < bitmap.width; x += 512) {
                signal?.throwIfAborted();
                const width = Math.min(512, bitmap.width - x),
                    height = Math.min(512, bitmap.height - y);
                ctx.clearRect(0, 0, tile.width, tile.height);
                ctx.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
                const data = ctx.getImageData(0, 0, width, height).data;
                for (let row = 0; row < height; row++)
                    pixels.set(
                        data.subarray(row * width * 4, (row + 1) * width * 4),
                        ((y + row) * bitmap.width + x) * 4,
                    );
                if ((x / 512 + (y / 512) * Math.ceil(bitmap.width / 512)) % 8 === 7)
                    await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
        return {
            width: bitmap.width,
            height: bitmap.height,
            background: [255, 255, 255, 255],
            active: 0,
            layers: [{ name: '이미지', visible: true, pixels }],
        };
    } finally {
        bitmap.close();
        if (tile) {
            tile.width = 0;
            tile.height = 0;
        }
    }
}
export async function exportBytes(
    state: State,
    format: string,
    matte: Color = [255, 255, 255, 255],
    signal?: AbortSignal,
    profile: ResourceProfile = webLimits,
): Promise<Uint8Array> {
    validate(state, profile);
    signal?.throwIfAborted();
    if (!['rpaint', 'png', 'jpg', 'bmp'].includes(format)) throw Error('지원하지 않는 출력 형식');
    if (matte.length !== 4 || matte.some((value) => !Number.isInteger(value) || value < 0 || value > 255))
        throw Error('출력 바탕색이 올바르지 않습니다.');
    const operation =
        format === 'rpaint'
            ? 'project-write'
            : format === 'png'
              ? 'png-write'
              : format === 'jpg'
                ? 'jpg-write'
                : 'bmp-write';
    const background = format === 'jpg' || format === 'bmp' ? Uint8Array.from(matte) : undefined;
    return (await runCodec(operation, cloneState(state), background, signal, profile)).bytes!;
}

export async function runGeometry(
    candidate: State,
    change: GeometryChange,
    signal?: AbortSignal,
    profile: ResourceProfile = webLimits,
): Promise<State> {
    validate(candidate, profile);
    signal?.throwIfAborted();
    const bytes = new TextEncoder().encode(JSON.stringify(change));
    if (bytes.length > 1024) throw Error('변형 매개변수가 너무 큽니다.');
    // The caller owns this candidate; transfer detaches its pixels, never the live document.
    return (await runCodec('geometry', candidate, bytes, signal, profile)).state!;
}
