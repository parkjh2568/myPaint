import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryStore } from '../src/platform/storage';
import { webLimits, desktopLimits } from '../src/engine/document';

test('invalid recovery writes reject before either backend, counters or ownership change', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'),
        previousIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    let opens = 0,
        invokes = 0;
    try {
        Object.defineProperty(globalThis, 'indexedDB', {
            configurable: true,
            value: {
                open() {
                    opens++;
                    throw Error('Invalid write reached IndexedDB');
                },
            },
        });
        for (const profile of [webLimits, desktopLimits]) {
            const oversized = new Uint8Array(profile.inputBytes + 1);
            for (const native of [false, true]) {
                Object.defineProperty(globalThis, 'window', {
                    configurable: true,
                    value: native
                        ? {
                              __TAURI__: {
                                  core: {
                                      async invoke() {
                                          invokes++;
                                          throw Error('Invalid write reached native IPC');
                                      },
                                  },
                              },
                          }
                        : {},
                });
                const store = new RecoveryStore(profile),
                    key = store.key;
                store.sequence = 7;
                store.generation = 5;
                for (const bytes of [
                    undefined,
                    null,
                    [],
                    { length: 1 },
                    new Uint16Array(1),
                    new Uint8Array(),
                    oversized,
                ]) {
                    await assert.rejects(
                        store.request('write', undefined, bytes as Uint8Array),
                        /복구 파일은.*MiB/,
                    );
                    assert.equal(store.key, key);
                    assert.equal(store.sequence, 7);
                    assert.equal(store.generation, 5);
                }
            }
        }
        assert.equal(opens, 0);
        assert.equal(invokes, 0);
    } finally {
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else Reflect.deleteProperty(globalThis, 'window');
        if (previousIndexedDB) Object.defineProperty(globalThis, 'indexedDB', previousIndexedDB);
        else Reflect.deleteProperty(globalThis, 'indexedDB');
    }
});

test('valid native recovery keeps exact bytes and encoded name and advances sequence once', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'),
        bytes = Uint8Array.of(17, 0, 255),
        calls: unknown[][] = [];
    try {
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: {
                __TAURI__: {
                    core: {
                        async invoke(...args: unknown[]) {
                            calls.push(args);
                        },
                    },
                },
            },
        });
        const store = new RecoveryStore(desktopLimits),
            key = store.key;
        store.generation = 5;
        store.sequence = 7;
        await store.request('write', undefined, bytes, '복구 그림');
        assert.equal(store.sequence, 8);
        assert.equal(store.generation, 5);
        assert.equal(store.key, key);
        assert.deepEqual(calls, [
            [
                'recovery_write',
                bytes,
                {
                    headers: {
                        'x-recovery-generation': '5',
                        'x-recovery-key': key,
                        'x-recovery-sequence': '8',
                        'x-recovery-name': Buffer.from('복구 그림').toString('base64'),
                    },
                },
            ],
        ]);
        assert.equal(calls[0][1], bytes);
        assert.deepEqual(Array.from(bytes), [17, 0, 255]);
    } finally {
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else Reflect.deleteProperty(globalThis, 'window');
    }
});
