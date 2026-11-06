import { decodeProject, decodePng, encodeProject, encodePng } from '../engine/format';
import {
    flood,
    applySelectionMask,
    resizeState,
    transformState,
    shearState,
    cropState,
    type GeometryChange,
} from '../engine/operations';
import {
    composite,
    profileById,
    validate,
    type Color,
    type State,
    type ResourceProfile,
} from '../engine/document';
import type { SelectionRequest } from '../platform/codec';
const channel = globalThis as unknown as {
    onmessage: (event: MessageEvent) => void;
    postMessage: (value: unknown, transfer?: Transferable[]) => void;
};
channel.onmessage = async (event: MessageEvent) => {
    let profile: ResourceProfile | undefined;
    try {
        profile = profileById(event.data?.profileId);
        const { operation, state, bytes, selection } = event.data as {
            operation: string;
            state: State;
            bytes?: Uint8Array;
            selection?: SelectionRequest;
        };
        if (bytes && (!(bytes instanceof Uint8Array) || bytes.length > profile.inputBytes))
            throw Error('이미지 입력 한도를 초과합니다.');
        let result: Record<string, unknown>;
        let transfer: Transferable[] = [];
        if (operation === 'project-read') {
            if (!bytes) throw Error('프로젝트 데이터가 없습니다.');
            const decoded = decodeProject(bytes, profile);
            result = { state: decoded };
            transfer = decoded.layers.map((layer) => layer.pixels.buffer as ArrayBuffer);
        } else if (operation === 'png-read') {
            if (!bytes) throw Error('PNG 데이터가 없습니다.');
            const image = decodePng(bytes, profile);
            result = { image };
            transfer = [image.pixels.buffer as ArrayBuffer];
        } else if (operation === 'project-write') {
            const encoded = encodeProject(state, profile);
            result = { bytes: encoded };
            transfer = [encoded.buffer as ArrayBuffer];
        } else if (operation === 'png-write') {
            const encoded = encodePng(state.width, state.height, composite(state, profile), profile);
            result = { bytes: encoded };
            transfer = [encoded.buffer as ArrayBuffer];
        } else if (operation === 'jpg-write' || operation === 'bmp-write') {
            if (!bytes || bytes.length !== 4) throw Error('출력 바탕색이 올바르지 않습니다.');
            const pixels = composite(state, profile);
            for (let i = 0; i < pixels.length; i += 4) {
                const alpha = pixels[i + 3] / 255;
                for (let c = 0; c < 3; c++)
                    pixels[i + c] = Math.round(pixels[i + c] * alpha + bytes[c] * (1 - alpha));
                pixels[i + 3] = 255;
            }
            let encoded: Uint8Array;
            if (operation === 'bmp-write') {
                const size = 54 + state.width * state.height * 4;
                if (size > profile.inputBytes)
                    throw Error(`BMP 출력은 ${profile.inputBytes / 1048576} MiB 이내여야 합니다.`);
                encoded = new Uint8Array(size);
                const view = new DataView(encoded.buffer);
                encoded.set([66, 77]);
                view.setUint32(2, size, true);
                view.setUint32(10, 54, true);
                view.setUint32(14, 40, true);
                view.setInt32(18, state.width, true);
                view.setInt32(22, state.height, true);
                view.setUint16(26, 1, true);
                view.setUint16(28, 32, true);
                for (let y = 0; y < state.height; y++)
                    for (let x = 0; x < state.width; x++) {
                        const source = (y * state.width + x) * 4,
                            target = 54 + ((state.height - y - 1) * state.width + x) * 4;
                        encoded.set([pixels[source + 2], pixels[source + 1], pixels[source], 255], target);
                    }
            } else {
                const scope = globalThis as unknown as { Buffer?: unknown };
                if (!scope.Buffer) scope.Buffer = (await import('buffer/index.js')).Buffer;
                const encode = (await import('jpeg-js/lib/encoder.js')).default;
                const jpeg = encode({ width: state.width, height: state.height, data: pixels }, 95).data;
                if (jpeg.byteLength > profile.inputBytes)
                    throw Error(`JPEG 출력은 ${profile.inputBytes / 1048576} MiB 이내여야 합니다.`);
                encoded =
                    jpeg.byteOffset === 0 && jpeg.byteLength === jpeg.buffer.byteLength
                        ? new Uint8Array(jpeg.buffer as ArrayBuffer)
                        : Uint8Array.from(jpeg);
            }
            result = { bytes: encoded };
            transfer = [encoded.buffer as ArrayBuffer];
        } else if (operation === 'selection') {
            validate(state, profile);
            if (
                state.layers.length !== 1 ||
                state.active !== 0 ||
                !selection ||
                !(selection.points instanceof Float64Array) ||
                selection.points.length % 2 ||
                !(selection.points.buffer instanceof ArrayBuffer) ||
                selection.points.byteOffset !== 0 ||
                selection.points.byteLength !== selection.points.buffer.byteLength ||
                state.layers[0].pixels.byteOffset !== 0 ||
                state.layers[0].pixels.byteLength !== state.layers[0].pixels.buffer.byteLength ||
                !Number.isSafeInteger(selection.left) ||
                !Number.isSafeInteger(selection.top) ||
                selection.left < 0 ||
                selection.top < 0 ||
                selection.left + state.width > profile.dimension ||
                selection.top + state.height > profile.dimension
            )
                throw Error('선택 영역 매개변수가 올바르지 않습니다.');
            const path: { x: number; y: number }[] = [];
            for (let i = 0; i < selection.points.length; i += 2) {
                const x = selection.points[i],
                    y = selection.points[i + 1];
                if (
                    !Number.isFinite(x) ||
                    !Number.isFinite(y) ||
                    Math.max(Math.abs(Math.floor(x)), Math.abs(Math.floor(y))) > 8388607
                )
                    throw Error('선택 경로 좌표가 너무 큽니다.');
                path.push({ x, y });
            }
            const pixels = state.layers[0].pixels,
                mask = applySelectionMask(
                    pixels,
                    state.width,
                    state.height,
                    selection.left,
                    selection.top,
                    path,
                    selection.key,
                    selection.transparent,
                    profile,
                )!;
            result = { image: { width: state.width, height: state.height, pixels }, bytes: mask };
            transfer = [pixels.buffer as ArrayBuffer, mask.buffer as ArrayBuffer];
        } else if (operation === 'fill') {
            validate(state, profile);
            if (state.layers.length !== 1 || state.active !== 0 || !bytes || bytes.length !== 8)
                throw Error('색상 처리 입력이 올바르지 않습니다.');
            const x = bytes[0] + bytes[1] * 256,
                y = bytes[2] + bytes[3] * 256,
                color = Array.from(bytes.subarray(4, 8)) as unknown as Color,
                image = flood(state.layers[0].pixels, state.width, state.height, x, y, color, profile);
            result = { image };
            transfer = image ? [image.pixels.buffer as ArrayBuffer] : [];
        } else if (operation === 'layer-edit') {
            validate(state, profile);
            if (!bytes || bytes.length > 64) throw Error('레이어 편집 매개변수가 올바르지 않습니다.');
            const kind = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            const active = state.active;
            if (kind === 'clear') {
                const color = new Uint32Array(
                    new Uint8ClampedArray(state.layers.length === 1 ? state.background : [0, 0, 0, 0]).buffer,
                )[0];
                new Uint32Array(
                    state.layers[active].pixels.buffer,
                    state.layers[active].pixels.byteOffset,
                    state.width * state.height,
                ).fill(color);
            } else if (kind === 'invert') {
                const pixels = state.layers[active].pixels;
                for (let i = 0; i < pixels.length; i += 4) {
                    pixels[i] = 255 - pixels[i];
                    pixels[i + 1] = 255 - pixels[i + 1];
                    pixels[i + 2] = 255 - pixels[i + 2];
                }
            } else if (kind === 'merge') {
                if (active < 1) throw Error('병합할 아래 레이어가 없습니다.');
                if (!state.layers[active].visible || !state.layers[active - 1].visible)
                    throw Error('두 레이어를 먼저 표시하세요.');
                state.layers[active - 1].pixels = composite(
                    { ...state, active: 0, layers: [state.layers[active - 1], state.layers[active]] },
                    profile,
                );
                state.layers.splice(active, 1);
                state.active--;
            } else throw Error('지원하지 않는 레이어 편집입니다.');
            result = { state };
            transfer = state.layers.map((layer) => layer.pixels.buffer as ArrayBuffer);
        } else if (operation === 'geometry') {
            if (!bytes || bytes.length > 1024) throw Error('변형 매개변수가 올바르지 않습니다.');
            const change = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            ) as GeometryChange;
            if (!change || typeof change !== 'object') throw Error('변형 매개변수가 올바르지 않습니다.');
            let candidate: State;
            if (change.kind === 'resize') {
                if (
                    typeof change.width !== 'number' ||
                    typeof change.height !== 'number' ||
                    (change.scale !== undefined && typeof change.scale !== 'boolean') ||
                    (change.smooth !== undefined && typeof change.smooth !== 'boolean')
                )
                    throw Error('크기 변경 매개변수가 올바르지 않습니다.');
                candidate = resizeState(
                    state,
                    change.width,
                    change.height,
                    change.scale,
                    change.smooth,
                    profile,
                );
            } else if (change.kind === 'transform') {
                if (typeof change.operation !== 'string') throw Error('변형 종류가 올바르지 않습니다.');
                candidate = transformState(state, change.operation, profile);
            } else if (change.kind === 'shear') {
                if (typeof change.angle !== 'number') throw Error('기울기가 올바르지 않습니다.');
                candidate = shearState(state, change.angle, profile);
            } else if (change.kind === 'crop') {
                candidate = cropState(state, change.x, change.y, change.width, change.height, profile);
            } else throw Error('지원하지 않는 변형입니다.');
            result = { state: candidate };
            transfer = candidate.layers.map((layer) => layer.pixels.buffer as ArrayBuffer);
        } else throw Error('지원하지 않는 작업');
        channel.postMessage({ profileId: profile.id, ...result }, transfer);
    } catch (error) {
        channel.postMessage({
            profileId: profile?.id,
            error: error instanceof Error ? error.message : String(error),
        });
    }
};
