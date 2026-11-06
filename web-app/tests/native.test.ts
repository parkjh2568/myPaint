import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDesktop, saveNative, openNative, activateNative } from '../src/platform/native';
import { createState } from '../src/engine/document';
import { encodeProject, encodePng } from '../src/engine/format';

const fixture = createState(1, 1, [0, 0, 0, 0]);
const projectBytes = encodeProject(fixture);

test('browser has no native file or document activation access', async () => {
    Object.assign(globalThis, { window: {} });
    assert.equal(isDesktop(), false);
    assert.equal(await saveNative(projectBytes, 'drawing.rpaint'), undefined);
    assert.equal(await openNative(), undefined);
    await activateNative(1, 'doc-a');
});

test('an already aborted native save never selects a target', async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];
    Object.assign(globalThis, {
        window: {
            __TAURI__: {
                core: {
                    invoke: async (command: string) => {
                        calls.push(command);
                    },
                },
            },
        },
    });
    await assert.rejects(saveNative(projectBytes, 'drawing.rpaint', controller.signal), {
        name: 'AbortError',
    });
    assert.deepEqual(calls, []);
});

test('cancelling the OS save picker releases only the selected write ticket', async () => {
    const controller = new AbortController(),
        calls: { command: string; args: unknown }[] = [];
    Object.assign(globalThis, {
        window: {
            __TAURI__: {
                core: {
                    invoke: async (command: string, args: unknown) => {
                        calls.push({ command, args });
                        if (command === 'choose_save') {
                            controller.abort();
                            return { token: '7', name: 'drawing.rpaint', generation: 1 };
                        }
                    },
                },
            },
        },
    });
    await assert.rejects(saveNative(projectBytes, 'drawing.rpaint', controller.signal), {
        name: 'AbortError',
    });
    assert.deepEqual(
        calls.map((value) => value.command),
        ['choose_save', 'cancel_write'],
    );
    assert.deepEqual(calls[1].args, { token: '7' });
});

test('write cancellation addresses its own ticket and preserves the native failure', async () => {
    const controller = new AbortController(),
        calls: string[] = [];
    Object.assign(globalThis, {
        window: {
            __TAURI__: {
                core: {
                    invoke: async (command: string, args: unknown) => {
                        calls.push(command);
                        if (command === 'choose_save')
                            return { token: '8', name: 'drawing.rpaint', generation: 1 };
                        if (command === 'write_selected') {
                            controller.abort();
                            throw Error('cancelled');
                        }
                        if (command === 'cancel_write') assert.deepEqual(args, { token: '8' });
                    },
                },
            },
        },
    });
    await assert.rejects(saveNative(projectBytes, 'drawing.rpaint', controller.signal), /cancelled/);
    assert.deepEqual(calls, ['choose_save', 'write_selected', 'cancel_write']);
});

test('a completed durable native write remains successful after late cancellation', async () => {
    const controller = new AbortController();
    Object.assign(globalThis, {
        window: {
            __TAURI__: {
                core: {
                    invoke: async (command: string) => {
                        if (command === 'choose_save')
                            return { token: '9', name: 'drawing.rpaint', generation: 1 };
                        if (command === 'write_selected') {
                            controller.abort();
                            return { name: 'drawing.rpaint', generation: 1, project: true };
                        }
                    },
                },
            },
        },
    });
    assert.equal(await saveNative(projectBytes, 'drawing.rpaint', controller.signal), 'drawing.rpaint');
});

test('native save options preserve project/export purpose and generation', async () => {
    const calls: { command: string; args: unknown; options: unknown }[] = [];
    Object.assign(globalThis, {
        window: {
            __TAURI__: {
                core: {
                    invoke: async (command: string, args: unknown, options: unknown) => {
                        calls.push({ command, args, options });
                        if (command === 'choose_save')
                            return { token: 'export-1', name: 'image.png', generation: 7 };
                        if (command === 'write_selected')
                            return { name: 'image.png', generation: 7, project: false };
                    },
                },
            },
        },
    });
    const bytes = encodePng(1, 1, fixture.layers[0].pixels);
    assert.equal(
        await saveNative(bytes, 'image.png', undefined, { generation: 7, project: false, saveAs: true }),
        'image.png',
    );
    assert.deepEqual(calls[0].args, { name: 'image.png', generation: 7, project: false, saveAs: true });
    assert.deepEqual(calls[1].args, bytes);
    assert.deepEqual(calls[1].options, { headers: { 'x-save-token': 'export-1' } });
});

test('cancelled Save As returns without sending bytes', async () => {
    const calls: string[] = [];
    Object.assign(globalThis, {
        window: {
            __TAURI__: {
                core: {
                    invoke: async (command: string) => {
                        calls.push(command);
                        return null;
                    },
                },
            },
        },
    });
    assert.equal(
        await saveNative(projectBytes, 'drawing.rpaint', undefined, {
            generation: 3,
            project: true,
            saveAs: true,
        }),
        undefined,
    );
    assert.deepEqual(calls, ['choose_save']);
});

test('a stale save target is rejected before writing bytes', async () => {
    const calls: string[] = [];
    Object.assign(globalThis, {
        window: {
            __TAURI__: {
                core: {
                    invoke: async (command: string) => {
                        calls.push(command);
                        if (command === 'choose_save')
                            return { token: 'old', name: 'drawing.rpaint', generation: 2 };
                    },
                },
            },
        },
    });
    await assert.rejects(
        saveNative(projectBytes, 'drawing.rpaint', undefined, {
            generation: 3,
            project: true,
            saveAs: false,
        }),
    );
    assert.equal(calls.includes('write_selected'), false);
});

test('malformed or stale write receipts never report save success', async () => {
    for (const receipt of [
        undefined,
        { name: 'drawing.rpaint', generation: 2, project: true },
        { name: 'drawing.rpaint', generation: 1, project: false },
        { name: 7, generation: 1, project: true },
    ]) {
        Object.assign(globalThis, {
            window: {
                __TAURI__: {
                    core: {
                        invoke: async (command: string) => {
                            if (command === 'choose_save')
                                return { token: 'ticket', name: 'drawing.rpaint', generation: 1 };
                            if (command === 'write_selected') return receipt;
                        },
                    },
                },
            },
        });
        await assert.rejects(saveNative(projectBytes, 'drawing.rpaint'));
    }
});

test('invalid document generations are rejected before native target selection', async () => {
    const calls: string[] = [];
    Object.assign(globalThis, {
        window: {
            __TAURI__: {
                core: {
                    invoke: async (command: string) => {
                        calls.push(command);
                    },
                },
            },
        },
    });
    for (const generation of [0, -1, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(
            saveNative(projectBytes, 'drawing.rpaint', undefined, {
                generation,
                project: true,
                saveAs: false,
            }),
        );
    }
    assert.deepEqual(calls, []);
});

test('native open requires both project magic and a project filename for binding eligibility', async () => {
    for (const [name, projectMagic, eligible] of [
        ['drawing.rpaint', true, true],
        ['image.rpaint', false, false],
        ['drawing.png', true, false],
        ['drawing.RPAINT', true, true],
    ] as const) {
        const bytes = new Uint8Array(28);
        bytes.set(projectMagic ? new TextEncoder().encode('RPAINT01') : Uint8Array.of(137, 80, 78, 71));
        Object.assign(globalThis, {
            window: {
                __TAURI__: {
                    core: {
                        invoke: async (command: string, args: unknown) => {
                            if (command === 'choose_open') return { token: 'read-1', name };
                            if (command === 'read_selected') {
                                assert.deepEqual(args, { token: 'read-1' });
                                return bytes.buffer;
                            }
                            throw Error(
                                'Open must not activate a document before the artwork decoder succeeds',
                            );
                        },
                    },
                },
            },
        });
        const opened = await openNative();
        assert(opened);
        assert.equal(opened.isProject, eligible);
        assert.equal(opened.name, name);
        assert.equal(opened.token, 'read-1');
        assert.deepEqual(opened.bytes, bytes);
    }
});

test('native open cancels without invoking a read and does not misuse write cancellation for read tokens', async () => {
    const controller = new AbortController(),
        calls: string[] = [];
    Object.assign(globalThis, {
        window: {
            __TAURI__: {
                core: {
                    invoke: async (command: string) => {
                        calls.push(command);
                        if (command === 'choose_open') {
                            controller.abort();
                            return { token: 'read-late', name: 'drawing.rpaint' };
                        }
                    },
                },
            },
        },
    });
    await assert.rejects(openNative(controller.signal), { name: 'AbortError' });
    assert.deepEqual(calls, ['choose_open']);
});

test('native open rejects late read completion after cancellation', async () => {
    const controller = new AbortController(),
        bytes = new TextEncoder().encode('RPAINT01payload');
    Object.assign(globalThis, {
        window: {
            __TAURI__: {
                core: {
                    invoke: async (command: string) => {
                        if (command === 'choose_open') return { token: 'read', name: 'drawing.rpaint' };
                        if (command === 'read_selected') {
                            controller.abort();
                            return bytes.buffer;
                        }
                    },
                },
            },
        },
    });
    await assert.rejects(openNative(controller.signal), { name: 'AbortError' });
});

test('native open rejects non-binary IPC results before artwork parsing', async () => {
    for (const payload of [[82, 80, 65, 73, 78, 84, 48, 49], 'RPAINT01', {}, null]) {
        Object.assign(globalThis, {
            window: {
                __TAURI__: {
                    core: {
                        invoke: async (command: string) => {
                            if (command === 'choose_open') return { token: 'read', name: 'drawing.rpaint' };
                            if (command === 'read_selected') return payload;
                        },
                    },
                },
            },
        });
        await assert.rejects(openNative());
    }
});

test('document activation sends the explicit generation/key and decoded source token', async () => {
    const calls: { command: string; args: unknown }[] = [];
    Object.assign(globalThis, {
        window: {
            __TAURI__: {
                core: {
                    invoke: async (command: string, args: unknown) => {
                        calls.push({ command, args });
                    },
                },
            },
        },
    });
    await activateNative(9, 'doc-9', 'read-valid');
    assert.deepEqual(calls, [
        { command: 'activate_document', args: { generation: 9, key: 'doc-9', sourceToken: 'read-valid' } },
    ]);
});
