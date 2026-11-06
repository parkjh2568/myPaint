import { zlibSync } from 'fflate';
import { Inflate } from 'pako';
import {
    type State,
    type ResourceProfile,
    validate,
    validateProfile,
    validateSize,
    webLimits,
} from './document';
const encoder = new TextEncoder(),
    decoder = new TextDecoder('utf-8', { fatal: true });
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
}
function crc(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
export function encodePng(
    width: number,
    height: number,
    pixels: Uint8ClampedArray,
    profile: ResourceProfile = webLimits,
): Uint8Array {
    validateSize(width, height, 1, profile);
    if (pixels.length !== width * height * 4) throw Error('픽셀 크기 불일치');
    const raw = new Uint8Array(height * (width * 4 + 1));
    for (let y = 0; y < height; y++)
        raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
    const header = new Uint8Array(13),
        view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = 8;
    header[9] = 6;
    const chunks: Uint8Array[] = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)];
    for (const [name, data] of [
        ['IHDR', header],
        ['IDAT', zlibSync(raw, { level: 1 })],
        ['IEND', new Uint8Array()],
    ] as const) {
        const chunk = new Uint8Array(data.length + 12),
            v = new DataView(chunk.buffer);
        v.setUint32(0, data.length);
        chunk.set(encoder.encode(name), 4);
        chunk.set(data, 8);
        v.setUint32(data.length + 8, crc(chunk.subarray(4, data.length + 8)));
        chunks.push(chunk);
    }
    const size = chunks.reduce((n, c) => n + c.length, 0);
    if (size > profile.inputBytes)
        throw Error(`PNG 출력은 ${profile.inputBytes / 1048576} MiB 이내여야 합니다.`);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
        result.set(c, offset);
        offset += c.length;
    }
    return result;
}
export function decodePng(
    bytes: Uint8Array,
    profile: ResourceProfile = webLimits,
): { width: number; height: number; pixels: Uint8ClampedArray } {
    validateProfile(profile);
    if (
        bytes.length > profile.inputBytes ||
        bytes.length < 33 ||
        !Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10).every((v, i) => bytes[i] === v)
    )
        throw Error('올바른 PNG 파일이 아닙니다.');
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8,
        width = 0,
        height = 0,
        depth = 0,
        type = -1,
        interlace = 0,
        ended = false,
        dataStarted = false,
        dataEnded = false,
        dataOffset = 0,
        dataEnd = 0;
    let palette: Uint8Array | undefined, transparency: Uint8Array | undefined;
    while (offset + 12 <= bytes.length) {
        const size = v.getUint32(offset);
        if (size > profile.inputBytes || size > bytes.length - offset - 12) throw Error('잘린 PNG 데이터');
        const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)),
            data = bytes.subarray(offset + 8, offset + 8 + size);
        if (!/^[A-Za-z]{4}$/.test(name) || (offset === 8 && name !== 'IHDR'))
            throw Error('PNG 청크 이름 또는 순서 오류');
        if (dataStarted && name !== 'IDAT') dataEnded = true;
        if (crc(bytes.subarray(offset + 4, offset + 8 + size)) !== v.getUint32(offset + 8 + size))
            throw Error('PNG 체크섬 오류');
        if (name === 'IHDR') {
            if (offset !== 8 || size !== 13) throw Error('PNG 헤더 오류');
            width = v.getUint32(offset + 8);
            height = v.getUint32(offset + 12);
            validateSize(width, height, 1, profile);
            depth = data[8];
            type = data[9];
            interlace = data[12];
            if (data[10] || data[11] || interlace > 1) throw Error('지원하지 않는 PNG 구성');
        } else if (name === 'PLTE') {
            if (
                palette ||
                dataStarted ||
                transparency ||
                type === 0 ||
                type === 4 ||
                size < 3 ||
                size > 768 ||
                size % 3 ||
                (type === 3 && size / 3 > 2 ** depth)
            )
                throw Error('PNG 팔레트 구성 오류');
            palette = data;
        } else if (name === 'tRNS') {
            if (
                transparency ||
                dataStarted ||
                (type === 0
                    ? size !== 2
                    : type === 2
                      ? size !== 6
                      : type === 3
                        ? !palette || size > palette.length / 3
                        : true)
            )
                throw Error('PNG 투명도 구성 오류');
            transparency = data;
        } else if (name === 'IDAT') {
            if (dataEnded || (type === 3 && !palette)) throw Error('PNG 이미지 청크 순서 오류');
            dataStarted = true;
            if (!dataOffset) dataOffset = offset;
            dataEnd = offset + size + 12;
        } else if (name === 'IEND') {
            if (size || !dataStarted) throw Error('PNG 종료 오류');
            ended = true;
            offset += 12;
            break;
        } else if (!(bytes[offset + 4] & 32)) throw Error('지원하지 않는 PNG 필수 청크');
        offset += size + 12;
    }
    const channels = type === 0 ? 1 : type === 2 ? 3 : type === 3 ? 1 : type === 4 ? 2 : type === 6 ? 4 : 0;
    if (
        !ended ||
        offset !== bytes.length ||
        !channels ||
        ![1, 2, 4, 8, 16].includes(depth) ||
        ((type === 2 || type === 4 || type === 6) && depth < 8) ||
        (type === 3 && (depth === 16 || !palette || palette.length % 3))
    )
        throw Error('PNG 형식이 올바르지 않습니다.');
    const passes = interlace
        ? [
              [0, 0, 8, 8],
              [4, 0, 8, 8],
              [0, 4, 4, 8],
              [2, 0, 4, 4],
              [0, 2, 2, 4],
              [1, 0, 2, 2],
              [0, 1, 1, 2],
          ]
        : [[0, 0, 1, 1]];
    let expected = 0;
    for (const [x, y, dx, dy] of passes) {
        const w = Math.max(0, Math.ceil((width - x) / dx)),
            h = Math.max(0, Math.ceil((height - y) / dy));
        if (w && h) expected += h * (1 + Math.ceil((w * channels * depth) / 8));
    }
    // The declared image bounds own the output buffer; compressed input cannot grow it.
    const raw = new Uint8Array(expected),
        inflator = new Inflate({ windowBits: 15, chunkSize: 65536 });
    let inflated = 0;
    inflator.onData = (chunk) => {
        if (chunk.length > expected - inflated) throw Error('PNG 해제 길이 오류');
        raw.set(chunk, inflated);
        inflated += chunk.length;
    };
    // Revisit the validated contiguous IDAT range without retaining one view per chunk.
    for (let chunkOffset = dataOffset; chunkOffset < dataEnd && !inflator.ended; ) {
        const length = v.getUint32(chunkOffset),
            next = chunkOffset + length + 12;
        if (!inflator.push(bytes.subarray(chunkOffset + 8, next - 4), next === dataEnd))
            throw Error('PNG 압축 데이터 오류: ' + inflator.msg);
        chunkOffset = next;
    }
    if (!inflator.ended || inflator.err || inflated !== expected) throw Error('PNG 해제 길이 오류');
    const pixels = new Uint8ClampedArray(width * height * 4);
    let pos = 0;
    for (const [ox, oy, dx, dy] of passes) {
        const w = Math.max(0, Math.ceil((width - ox) / dx)),
            h = Math.max(0, Math.ceil((height - oy) / dy));
        if (!w || !h) continue;
        const rowBytes = Math.ceil((w * channels * depth) / 8),
            stride = Math.max(1, Math.ceil((channels * depth) / 8));
        let previous = new Uint8Array(rowBytes);
        for (let y = 0; y < h; y++) {
            const filter = raw[pos++];
            if (filter > 4) throw Error('PNG 필터 오류');
            const row = raw.slice(pos, pos + rowBytes);
            pos += rowBytes;
            for (let i = 0; i < rowBytes; i++) {
                const a = i >= stride ? row[i - stride] : 0,
                    b = previous[i],
                    c = i >= stride ? previous[i - stride] : 0;
                let predictor = 0;
                if (filter === 1) predictor = a;
                else if (filter === 2) predictor = b;
                else if (filter === 3) predictor = Math.floor((a + b) / 2);
                else if (filter === 4) {
                    const q = a + b - c,
                        pa = Math.abs(q - a),
                        pb = Math.abs(q - b),
                        pc = Math.abs(q - c);
                    predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
                }
                row[i] = (row[i] + predictor) & 255;
            }
            if (!interlace && type === 6 && depth === 8) {
                pixels.set(row, y * width * 4);
                previous = row;
                continue;
            }
            for (let x = 0; x < w; x++) {
                const samples: number[] = [];
                for (let c = 0; c < channels; c++) {
                    const bit = (x * channels + c) * depth;
                    const sample =
                        depth === 16
                            ? (row[bit / 8] << 8) | row[bit / 8 + 1]
                            : depth === 8
                              ? row[bit / 8]
                              : (row[Math.floor(bit / 8)] >> (8 - depth - (bit % 8))) & ((1 << depth) - 1);
                    samples.push(sample);
                }
                const i = ((oy + y * dy) * width + ox + x * dx) * 4,
                    scale = depth === 16 ? 257 : ((1 << depth) - 1) / 255;
                let r = 0,
                    g = 0,
                    b = 0,
                    a = 255;
                if (type === 3) {
                    const index = samples[0];
                    if (!palette || index * 3 + 2 >= palette.length) throw Error('PNG 팔레트 오류');
                    r = palette[index * 3];
                    g = palette[index * 3 + 1];
                    b = palette[index * 3 + 2];
                    a = transparency?.[index] ?? 255;
                } else {
                    r = samples[0] / scale;
                    g = (type === 0 || type === 4 ? samples[0] : samples[1]) / scale;
                    b = (type === 0 || type === 4 ? samples[0] : samples[2]) / scale;
                    if (type === 4 || type === 6) a = samples[channels - 1] / scale;
                    else if (transparency) {
                        const tv = new DataView(
                            transparency.buffer,
                            transparency.byteOffset,
                            transparency.length,
                        );
                        if (
                            type === 0 &&
                            tv.byteLength === 2 &&
                            samples[0] === (tv.getUint16(0) & (2 ** depth - 1))
                        )
                            a = 0;
                        if (
                            type === 2 &&
                            tv.byteLength === 6 &&
                            samples
                                .slice(0, 3)
                                .every((s, c) => s === (tv.getUint16(c * 2) & (2 ** depth - 1)))
                        )
                            a = 0;
                    }
                }
                pixels.set([r, g, b, a], i);
            }
            previous = row;
        }
    }
    return { width, height, pixels };
}
export function encodeProject(state: State, profile: ResourceProfile = webLimits): Uint8Array {
    validate(state, profile);
    let size = 28;
    const records = state.layers.map((layer) => {
        const name = encoder.encode(layer.name),
            png = encodePng(state.width, state.height, layer.pixels, profile);
        if (name.length > 1024 || png.length > profile.layerBytes)
            throw Error(`레이어 출력은 ${profile.layerBytes / 1048576} MiB 이내여야 합니다.`);
        size += 9 + name.length + png.length;
        if (size > profile.inputBytes)
            throw Error(`프로젝트 출력은 ${profile.inputBytes / 1048576} MiB 이내여야 합니다.`);
        return { layer, name, png };
    });
    const bytes = new Uint8Array(size),
        v = new DataView(bytes.buffer);
    bytes.set(encoder.encode('RPAINT01'));
    v.setUint32(8, state.width, true);
    v.setUint32(12, state.height, true);
    v.setUint32(16, state.layers.length, true);
    v.setUint32(20, state.active, true);
    const [r, g, b, a] = state.background;
    v.setUint32(24, ((a << 24) | (r << 16) | (g << 8) | b) >>> 0, true);
    let pos = 28;
    for (const { layer, name, png } of records) {
        v.setUint32(pos, name.length, true);
        pos += 4;
        bytes.set(name, pos);
        pos += name.length;
        bytes[pos++] = layer.visible ? 1 : 0;
        v.setUint32(pos, png.length, true);
        pos += 4;
        bytes.set(png, pos);
        pos += png.length;
    }
    return bytes;
}
export function decodeProject(bytes: Uint8Array, profile: ResourceProfile = webLimits): State {
    validateProfile(profile);
    if (
        bytes.length > profile.inputBytes ||
        bytes.length < 28 ||
        decoder.decode(bytes.subarray(0, 8)) !== 'RPAINT01'
    )
        throw Error('올바른 프로젝트가 아닙니다.');
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        width = v.getUint32(8, true),
        height = v.getUint32(12, true),
        count = v.getUint32(16, true),
        active = v.getUint32(20, true),
        bg = v.getUint32(24, true);
    validateSize(width, height, count, profile);
    if (active >= count) throw Error('활성 레이어 번호가 올바르지 않습니다.');
    const state: State = {
        width,
        height,
        active,
        background: [(bg >>> 16) & 255, (bg >>> 8) & 255, bg & 255, bg >>> 24],
        layers: [],
    };
    let pos = 28;
    for (let i = 0; i < count; i++) {
        if (pos + 4 > bytes.length) throw Error('잘린 프로젝트');
        const n = v.getUint32(pos, true);
        pos += 4;
        if (n > 1024 || n > bytes.length - pos - 5) throw Error('레이어 이름 길이 오류');
        const name = decoder.decode(bytes.subarray(pos, pos + n));
        if (
            name.length > 256 ||
            /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(name)
        )
            throw Error('레이어 이름이 올바르지 않습니다.');
        pos += n;
        const visible = bytes[pos++],
            length = v.getUint32(pos, true);
        pos += 4;
        if (visible > 1 || length < 1 || length > profile.layerBytes || length > bytes.length - pos)
            throw Error('레이어 레코드 오류');
        // Match the first IHDR before decoding so a corrupt layer cannot exceed the declared aggregate.
        if (length < 24 || v.getUint32(pos + 16) !== width || v.getUint32(pos + 20) !== height)
            throw Error('레이어 크기 불일치');
        const image = decodePng(bytes.subarray(pos, pos + length), profile);
        pos += length;
        if (image.width !== width || image.height !== height) throw Error('레이어 크기 불일치');
        state.layers.push({ name, visible: !!visible, pixels: image.pixels });
    }
    if (pos !== bytes.length) throw Error('프로젝트 뒤에 불필요한 데이터가 있습니다.');
    validate(state, profile);
    return state;
}
