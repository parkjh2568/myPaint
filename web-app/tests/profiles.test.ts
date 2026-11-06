import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    PaintDocument,
    createState,
    cloneState,
    validateSize,
    validate,
    composite,
    webLimits,
    desktopLimits,
    limits,
    profileById,
    validateProfile,
    type ResourceProfile,
} from '../src/engine/document';
import { encodePng, decodePng, encodeProject, decodeProject } from '../src/engine/format';
import { resizeState, transformState, shearState } from '../src/engine/operations';
import { runCodec, readArtwork } from '../src/platform/codec';

test('resource profiles are immutable canonical choices and the compatibility default stays web', async () => {
    assert.equal(limits, webLimits);
    assert.equal(new PaintDocument().historyBudget, 32 * 1024 * 1024);
    assert.equal(new PaintDocument(undefined, desktopLimits).historyBudget, 256 * 1024 * 1024);
    assert.equal(profileById('web'), webLimits);
    assert.equal(profileById('desktop'), desktopLimits);
    assert(Object.isFrozen(webLimits));
    assert(Object.isFrozen(desktopLimits));
    assert.equal(Reflect.set(desktopLimits, 'pixels', Infinity), false);
    for (const id of [undefined, null, 'native', 'android', {}, 'desktop\0'])
        assert.throws(() => profileById(id), /프로필/);
    const forged = { ...desktopLimits, id: 'web' } as ResourceProfile;
    assert.throws(() => validateProfile(forged), /프로필/);
    assert.throws(() => validateSize(1, 1, 1, forged), /프로필/);
    assert.throws(() => createState(1, 1, [0, 0, 0, 0], forged), /프로필/);
    assert.throws(() => decodePng(new Uint8Array(), forged), /프로필/);
    assert.throws(() => decodeProject(new Uint8Array(), forged), /프로필/);
    await assert.rejects(runCodec('project-read', undefined, new Uint8Array(), undefined, forged), /프로필/);
    assert.throws(() => createState(4096, 4096), /한도/);
    assert.throws(() => createState(32768, 1), /한도/);
    assert.doesNotThrow(() => validateSize(8192, 4096, 2, desktopLimits));
    assert.throws(() => validateSize(8192, 4096, 3, desktopLimits), /한도/);
    assert.throws(() => validateSize(32769, 1, 1, desktopLimits), /한도/);
    assert.throws(() => validateSize(1, 1, 17, desktopLimits), /한도/);
});

test('desktop 4096 square and 32768 by one PNG/project roundtrip real pixels while web rejects', () => {
    for (const [width, height] of [
        [4096, 4096],
        [32768, 1],
    ]) {
        const state = createState(width, height, [0, 0, 0, 0], desktopLimits);
        state.layers[0].name = '네이티브 프로필';
        state.layers[0].pixels.set([33, 72, 195, 128], 0);
        state.layers[0].pixels.set([7, 111, 231, 1], state.layers[0].pixels.length - 4);
        const png = encodePng(width, height, state.layers[0].pixels, desktopLimits);
        assert.deepEqual(decodePng(png, desktopLimits).pixels, state.layers[0].pixels);
        assert.throws(() => decodePng(png), /한도/);
        const project = encodeProject(state, desktopLimits),
            decoded = decodeProject(project, desktopLimits);
        assert.deepEqual(decoded, state);
        assert.throws(() => decodeProject(project), /한도/);
        assert.deepEqual(Object.keys(decoded).sort(), ['active', 'background', 'height', 'layers', 'width']);
        assert.equal(new TextDecoder().decode(project.subarray(0, 8)), 'RPAINT01');
    }
});

test('desktop document uses its own coordinate clamp, validation and geometry profile', () => {
    const state = createState(32768, 1, [0, 0, 0, 0], desktopLimits),
        document = new PaintDocument(state, desktopLimits);
    document.beginStroke(30000, 0, {
        color: [22, 121, 234, 255],
        size: 1,
        opacity: 1,
        hardness: 1,
        stabilization: 0,
        eraser: false,
        pressure: false,
        pixel: true,
    });
    document.endStroke(30000, 0);
    const retained = document.history[0].tiles!.reduce(
        (sum, tile) => sum + tile.before.byteLength + tile.after!.byteLength + tile.coverage.byteLength,
        0,
    );
    assert.equal(document.historyBytes, retained);
    assert(
        document.history[0].tiles!.every(
            (tile) =>
                tile.before.buffer !== document.state.layers[0].pixels.buffer &&
                tile.after!.buffer !== document.state.layers[0].pixels.buffer,
        ),
    );
    assert.deepEqual(
        [...document.state.layers[0].pixels.subarray(30000 * 4, 30000 * 4 + 4)],
        [22, 121, 234, 255],
    );
    assert.equal(document.state.layers[0].pixels[8192 * 4 + 3], 0);
    document.undo();
    assert(document.state.layers[0].pixels.every((value) => value === 0));
    document.redo();
    const before = cloneState(document.state);
    assert.throws(() => new PaintDocument(before), /한도/);
    assert.doesNotThrow(() => validate(before, desktopLimits));
    assert.throws(() => validate(before), /한도/);
    assert.deepEqual(composite(before, desktopLimits), before.layers[0].pixels);
    assert.throws(() => composite(before), /한도/);
    assert.equal(resizeState(before, 32768, 1, false, false, desktopLimits).width, 32768);
    assert.deepEqual(
        [
            transformState(before, 'rotate-right', desktopLimits).width,
            transformState(before, 'rotate-right', desktopLimits).height,
        ],
        [1, 32768],
    );
    assert.equal(shearState(before, 0, desktopLimits).width, 32768);
    assert.throws(() => resizeState(before, 32768, 1), /한도/);
    assert.throws(() => transformState(before, 'rotate-right'), /한도/);
    assert.throws(() => shearState(before, 0), /한도/);
    assert.throws(
        () =>
            document.edit('too wide', (candidate) => {
                candidate.width = 32769;
            }),
        /한도/,
    );
    assert.deepEqual(document.state, before);
});

test('invalid project active index and long names reject before any layer PNG is decoded', () => {
    const state = createState(1, 1, [0, 0, 0, 0]);
    state.layers[0].name = 'A';
    const project = encodeProject(state),
        active = project.slice();
    new DataView(active.buffer).setUint32(8, 4096, true);
    new DataView(active.buffer).setUint32(12, 4096, true);
    new DataView(active.buffer).setUint32(20, 99, true);
    active[42] = 0;
    assert.throws(() => decodeProject(active, desktopLimits), /활성 레이어/);
    const long = new Uint8Array(project.length + 256);
    long.set(project.subarray(0, 32));
    new DataView(long.buffer).setUint32(28, 257, true);
    long.fill(120, 32, 32 + 257);
    long.set(project.subarray(33), 32 + 257);
    long[32 + 257 + 5] = 0;
    assert.throws(() => decodeProject(long, desktopLimits), /레이어 이름/);
});

test('file limits are profile specific and reject before reading file bytes', async () => {
    for (const profile of [webLimits, desktopLimits]) {
        let read = false;
        const file = {
            size: profile.inputBytes + 1,
            arrayBuffer: async () => {
                read = true;
                return new ArrayBuffer(0);
            },
        } as File;
        await assert.rejects(
            readArtwork(file, undefined, profile),
            new RegExp(String(profile.inputBytes / 1048576) + ' MiB'),
        );
        assert.equal(read, false);
    }
});

test('shipped Worker handler keeps explicit profile IDs across geometry and large JPEG/BMP codecs', async () => {
    const channel = globalThis as unknown as {
        onmessage?: (event: MessageEvent) => void | Promise<void>;
        postMessage?: (value: unknown) => void;
    };
    const previousMessage = channel.onmessage,
        previousPost = channel.postMessage;
    const replies: Array<{
        profileId?: string;
        state?: ReturnType<typeof createState>;
        bytes?: Uint8Array;
        error?: string;
    }> = [];
    try {
        channel.postMessage = (value) => replies.push(value as (typeof replies)[number]);
        await import('../src/workers/codec.worker');
        const wide = createState(32768, 1, [0, 0, 0, 0], desktopLimits);
        wide.layers[0].pixels.set([33, 72, 195, 128]);
        const bytes = encodeProject(wide, desktopLimits);
        const send = (data: unknown) => {
            channel.onmessage!(new MessageEvent('message', { data }));
            return replies.at(-1)!;
        };
        for (const profileId of [undefined, 'native', {}, null])
            assert.match(send({ profileId, operation: 'project-read', bytes }).error!, /프로필/);
        assert.match(
            send({ profileId: 'web', profile: desktopLimits, operation: 'project-read', bytes }).error!,
            /한도/,
        );
        const decoded = send({ profileId: 'desktop', operation: 'project-read', bytes });
        assert.equal(decoded.profileId, 'desktop');
        assert.deepEqual(decoded.state, wide);
        const encoded = send({ profileId: 'desktop', operation: 'project-write', state: wide });
        assert.equal(encoded.profileId, 'desktop');
        assert.deepEqual(decodeProject(encoded.bytes!, desktopLimits), wide);
        const geometry = new TextEncoder().encode(
            JSON.stringify({ kind: 'transform', operation: 'rotate-right' }),
        );
        const rotated = send({ profileId: 'desktop', operation: 'geometry', state: wide, bytes: geometry });
        assert.equal(rotated.profileId, 'desktop');
        assert.deepEqual([rotated.state!.width, rotated.state!.height], [1, 32768]);
        assert.deepEqual([...rotated.state!.layers[0].pixels.subarray(0, 4)], [33, 72, 195, 128]);
        assert.match(
            send({ profileId: 'web', operation: 'geometry', state: wide, bytes: geometry }).error!,
            /한도/,
        );
        const malformed = new TextEncoder().encode(
            JSON.stringify({ kind: 'resize', width: 1, height: 1, scale: 'yes' }),
        );
        assert.match(
            send({ profileId: 'desktop', operation: 'geometry', state: wide, bytes: malformed }).error!,
            /매개변수/,
        );
        const { decode: decodeJpeg } = await import('jpeg-js');
        for (const [width, height] of [
            [4096, 4096],
            [32768, 1],
        ]) {
            const source = createState(width, height, [0, 0, 0, 0], desktopLimits);
            await channel.onmessage!(
                new MessageEvent('message', {
                    data: {
                        profileId: 'desktop',
                        operation: 'jpg-write',
                        state: source,
                        bytes: Uint8Array.of(17, 34, 51, 255),
                    },
                }),
            );
            const jpeg = replies.at(-1)!;
            assert.equal(jpeg.error, undefined);
            assert.equal(jpeg.profileId, 'desktop');
            assert(jpeg.bytes);
            assert.deepEqual([...jpeg.bytes.subarray(0, 2)], [255, 216]);
            const image = decodeJpeg(jpeg.bytes, {
                useTArray: true,
                tolerantDecoding: false,
                maxResolutionInMP: desktopLimits.pixels / 1000000,
                maxMemoryUsageInMB: 512,
            });
            assert.deepEqual([image.width, image.height], [width, height]);
            for (const offset of [0, image.data.length - 4]) {
                for (let c = 0; c < 3; c++) assert(Math.abs(image.data[offset + c] - [17, 34, 51][c]) <= 3);
                assert.equal(image.data[offset + 3], 255);
            }
            assert(source.layers[0].pixels.every((value) => value === 0));
        }
        await channel.onmessage!(
            new MessageEvent('message', {
                data: {
                    profileId: 'desktop',
                    operation: 'bmp-write',
                    state: wide,
                    bytes: Uint8Array.of(17, 34, 51, 255),
                },
            }),
        );
        const bmp = replies.at(-1)!.bytes!,
            bmpHeader = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);
        assert.deepEqual([bmpHeader.getInt32(18, true), bmpHeader.getInt32(22, true)], [32768, 1]);
        assert.deepEqual([...bmp.subarray(bmp.length - 4)], [51, 34, 17, 255]);
    } finally {
        channel.onmessage = previousMessage;
        channel.postMessage = previousPost;
    }
});
