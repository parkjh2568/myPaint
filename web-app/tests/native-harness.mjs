// This in-memory native bridge exercises client IPC ownership; it is not an OS filesystem test.
export function installNativeHarness(options = {}) {
    const state = {
        warnings: options.warnings || [],
        generation: 0,
        key: '',
        binding: undefined,
        tabBindings: new Map(),
        serial: 0,
        calls: [],
        writes: [],
        recoveryWrites: [],
        files: new Map(),
        readResponseSizes: new Map(),
        readTickets: new Map(),
        writeTickets: new Map(),
        recoveries: new Map(),
        recoveryTickets: new Map(),
        openQueue: [],
        savePicks: [],
        pickerCount: 0,
        holds: new Map(),
        pending: new Map(),
        failures: new Map(),
        idbOpens: 0,
        idbWrites: 0,
        codecJobs: [],
        liveWorkers: new Set(),
        lastCodecWorkerUrl: undefined,
    };
    window.__myPaintPersistenceTest = state;
    state.queueOpen = (name, bytes, path) => {
        const id = path || `input-${++state.serial}:${name}`;
        state.files.set(id, {
            path: id,
            name,
            bytes: bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes),
            version: 1,
        });
        state.openQueue.push(id);
        return id;
    };
    state.addRecovery = (entry) => {
        const previous = state.recoveries.get(entry.key);
        const bytes = entry.bytes instanceof Uint8Array ? entry.bytes : Uint8Array.from(entry.bytes);
        const record = {
            key: entry.key,
            sequence: entry.sequence || 1,
            name: entry.name,
            at: entry.at || Date.now(),
            bytes,
            source: entry.source || 'native',
            version: (previous?.version || 0) + 1,
        };
        state.recoveries.set(entry.key, record);
        return record;
    };
    state.holdNext = (command, stage = 'before') => state.holds.set(command, stage);
    state.failNext = (command, message) => state.failures.set(command, message);
    state.release = async (command) => {
        const pending = state.pending.get(command);
        if (!pending) throw Error('No pending mocked native command: ' + command);
        state.pending.delete(command);
        return pending.release();
    };
    for (const file of options.files || []) state.queueOpen(file.name, file.bytes, file.path);
    for (const recovery of options.recoveries || []) state.addRecovery(recovery);
    if (options.holdStartupList) state.holdNext('recovery_list');
    if (options.initFailure) state.failNext('activate_document', 'Test storage initialization failure');
    const originalOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) {
        state.idbOpens++;
        return originalOpen.apply(this, args);
    };
    const originalTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
        if (args[1] === 'readwrite') state.idbWrites++;
        return originalTransaction.apply(this, args);
    };
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
        constructor(url, workerOptions) {
            super(url, workerOptions);
            this.testWorkerUrl = String(url);
            state.liveWorkers.add(this);
        }
        postMessage(message, transfer) {
            if (message?.operation) {
                state.lastCodecWorkerUrl = this.testWorkerUrl;
                state.codecJobs.push({ operation: message.operation, profileId: message.profileId });
            }
            return super.postMessage(message, transfer);
        }
        terminate() {
            state.liveWorkers.delete(this);
            return super.terminate();
        }
    };
    state.createNoiseProject = async (name = 'large-noise.rpaint') => {
        if (!state.lastCodecWorkerUrl)
            throw Error('A real application codec Worker must run before creating this fixture');
        const pixels = new Uint8ClampedArray(4096 * 4096 * 4),
            words = new Uint32Array(pixels.buffer);
        let seed = 0x47a19f;
        for (let index = 0; index < words.length; index++) {
            seed ^= seed << 13;
            seed ^= seed >>> 17;
            seed ^= seed << 5;
            words[index] = seed >>> 0;
        }
        const worker = new Worker(state.lastCodecWorkerUrl, { type: 'module' });
        const bytes = await new Promise((resolve, reject) => {
            worker.onmessage = (event) => {
                if (event.data.error) reject(Error(event.data.error));
                else if (event.data.profileId !== 'desktop' || !(event.data.bytes instanceof Uint8Array))
                    reject(Error('Invalid fixture Worker response'));
                else resolve(event.data.bytes);
            };
            worker.onerror = (event) => {
                event.preventDefault();
                reject(Error(event.message));
            };
            worker.postMessage(
                {
                    operation: 'project-write',
                    profileId: 'desktop',
                    state: {
                        width: 4096,
                        height: 4096,
                        background: [0, 0, 0, 0],
                        active: 0,
                        layers: [{ name: 'noise', visible: true, pixels }],
                    },
                },
                [pixels.buffer],
            );
        }).finally(() => worker.terminate());
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
            .map((value) => value.toString(16).padStart(2, '0'))
            .join('');
        const id = state.queueOpen(name, bytes);
        return { id, name, bytes: bytes.length, sha256: hash };
    };
    window.__TAURI__ = {
        core: {
            invoke: async (command, args, invokeOptions) => {
                state.calls.push({
                    command,
                    args: args instanceof Uint8Array ? { bytes: args.length } : args,
                    headers: invokeOptions?.headers,
                });
                const execute = async () => {
                    const failure = state.failures.get(command);
                    if (failure) {
                        state.failures.delete(command);
                        throw Error(failure);
                    }
                    if (command === 'runtime_ready') return false;
                    if (command === 'set_dirty' || command === 'close_window') return;
                    if (command === 'activate_document') {
                        if (
                            !Number.isSafeInteger(args.generation) ||
                            args.generation < 1 ||
                            !/^[a-z0-9_-]{1,64}$/.test(args.key) ||
                            args.generation < state.generation
                        )
                            throw Error('Invalid mocked document generation');
                        if (args.generation === state.generation && args.key === state.key) return;
                        if (args.generation === state.generation) throw Error('Generation key changed');
                        let binding;
                        if (args.sourceToken) {
                            const source = state.readTickets.get(args.sourceToken);
                            const file = source && state.files.get(source.path);
                            if (
                                !source?.read ||
                                !file ||
                                file.version !== source.version ||
                                !/\.rpaint$/i.test(file.name) ||
                                new TextDecoder().decode(file.bytes.subarray(0, 8)) !== 'RPAINT01'
                            )
                                throw Error('Source is not a decoded project capability');
                            binding = { path: source.path, generation: args.generation };
                        }
                        if (!args.sourceToken && state.tabBindings.has(args.key))
                            binding = { path: state.tabBindings.get(args.key), generation: args.generation };
                        if (state.binding) state.tabBindings.set(state.key, state.binding.path);
                        state.generation = args.generation;
                        state.key = args.key;
                        state.binding = binding;
                        state.readTickets.clear();
                        return;
                    }
                    if (command === 'choose_open') {
                        const path = state.openQueue.shift();
                        if (!path) return null;
                        const file = state.files.get(path),
                            token = 'read-' + ++state.serial;
                        state.readTickets.set(token, { path, version: file.version, read: false });
                        return { token, name: file.name };
                    }
                    if (command === 'read_selected') {
                        const ticket = state.readTickets.get(args.token),
                            file = ticket && state.files.get(ticket.path);
                        if (!file || file.version !== ticket.version) throw Error('Selected file changed');
                        ticket.read = true;
                        if (state.readResponseSizes.has(file.name))
                            return new ArrayBuffer(state.readResponseSizes.get(file.name));
                        return file.bytes.buffer.slice(
                            file.bytes.byteOffset,
                            file.bytes.byteOffset + file.bytes.byteLength,
                        );
                    }
                    if (command === 'choose_save') {
                        if (args.generation !== state.generation)
                            throw Error('Save document generation changed');
                        let path, name;
                        if (args.project && !args.saveAs && state.binding?.generation === args.generation) {
                            path = state.binding.path;
                            name = state.files.get(path).name;
                        } else {
                            state.pickerCount++;
                            const selected = state.savePicks.shift();
                            if (selected === null) return null;
                            name = selected?.name || args.name;
                            path = selected?.path || 'output:' + name;
                        }
                        const token = 'write-' + ++state.serial,
                            old = state.files.get(path);
                        state.writeTickets.set(token, {
                            path,
                            name,
                            generation: args.generation,
                            project: args.project,
                            version: old?.version,
                            cancelled: false,
                        });
                        return { token, name, generation: args.generation };
                    }
                    if (command === 'cancel_write') {
                        const ticket = state.writeTickets.get(args.token);
                        if (ticket) ticket.cancelled = true;
                        return;
                    }
                    if (command === 'write_selected') {
                        const ticket = state.writeTickets.get(invokeOptions?.headers?.['x-save-token']);
                        if (!ticket || ticket.cancelled || ticket.generation !== state.generation)
                            throw Error('Save cancelled or document changed');
                        const old = state.files.get(ticket.path);
                        if (old?.version !== ticket.version) throw Error('Selected file changed');
                        if (!(args instanceof Uint8Array) || args.length < 1 || args.length > 300 * 1048576)
                            throw Error('Invalid mocked file bytes');
                        const file = {
                            path: ticket.path,
                            name: ticket.name,
                            bytes: args.slice(),
                            version: (old?.version || 0) + 1,
                        };
                        state.files.set(ticket.path, file);
                        if (ticket.project)
                            state.binding = { path: ticket.path, generation: ticket.generation };
                        state.writeTickets.delete(invokeOptions.headers['x-save-token']);
                        state.writes.push({
                            name: ticket.name,
                            bytes: file.bytes,
                            generation: ticket.generation,
                            project: ticket.project,
                            path: ticket.path,
                        });
                        return { name: ticket.name, generation: ticket.generation, project: ticket.project };
                    }
                    if (command === 'recovery_list') {
                        state.recoveryTickets.clear();
                        const entries = [...state.recoveries.values()]
                            .sort((a, b) => b.at - a.at)
                            .map((record) => {
                                const token = 'recover-' + ++state.serial;
                                state.recoveryTickets.set(token, {
                                    key: record.key,
                                    version: record.version,
                                });
                                return {
                                    key: record.key,
                                    sequence: record.sequence,
                                    name: record.name,
                                    size: record.bytes.length,
                                    at: record.at,
                                    token,
                                    source: record.source,
                                    readOnly: record.source === 'legacy',
                                };
                            });
                        return { entries, warnings: [...state.warnings] };
                    }
                    if (command === 'recovery_read' || command === 'recovery_clear') {
                        const ticket = state.recoveryTickets.get(args.token),
                            record = ticket && state.recoveries.get(ticket.key);
                        if (!record || record.version !== ticket.version)
                            throw Error('복구 사본이 변경됐습니다. 목록을 다시 여세요.');
                        if (command === 'recovery_clear') {
                            if (record.source === 'legacy')
                                throw Error('이전 앱의 복구 원본은 삭제하지 않습니다.');
                            state.recoveries.delete(ticket.key);
                            return;
                        }
                        return record.bytes.buffer.slice(
                            record.bytes.byteOffset,
                            record.bytes.byteOffset + record.bytes.byteLength,
                        );
                    }
                    if (command === 'recovery_write') {
                        const headers = invokeOptions.headers,
                            generation = Number(headers['x-recovery-generation']),
                            key = headers['x-recovery-key'],
                            sequence = Number(headers['x-recovery-sequence']);
                        if (
                            generation !== state.generation ||
                            key !== state.key ||
                            !Number.isSafeInteger(sequence) ||
                            sequence < 1
                        )
                            throw Error('이전 문서의 복구 작업입니다.');
                        if (
                            !(args instanceof Uint8Array) ||
                            args.length < 1 ||
                            args.length > 300 * 1048576 ||
                            new TextDecoder().decode(args.subarray(0, 8)) !== 'RPAINT01'
                        )
                            throw Error('복구 파일 형식 또는 크기 오류');
                        const old = state.recoveries.get(key);
                        if (old && sequence <= old.sequence) throw Error('오래된 복구 작업입니다.');
                        const title = new TextDecoder().decode(
                            Uint8Array.from(atob(headers['x-recovery-name']), (c) => c.charCodeAt(0)),
                        );
                        const record = state.addRecovery({
                            key,
                            sequence,
                            name: title,
                            bytes: args.slice(),
                            source: 'native',
                        });
                        state.recoveryWrites.push({
                            generation,
                            key,
                            sequence,
                            name: title,
                            bytes: record.bytes.length,
                            sha256: Array.from(
                                new Uint8Array(await crypto.subtle.digest('SHA-256', record.bytes)),
                            )
                                .map((value) => value.toString(16).padStart(2, '0'))
                                .join(''),
                        });
                        return;
                    }
                    throw Error('Unexpected mocked native command: ' + command);
                };
                const hold = state.holds.get(command);
                state.holds.delete(command);
                if (!hold) return execute();
                const completed = hold === 'after' ? await execute() : undefined;
                return new Promise((resolve, reject) => {
                    state.pending.set(command, {
                        release: async () => {
                            try {
                                resolve(hold === 'after' ? completed : await execute());
                            } catch (error) {
                                reject(error);
                            }
                        },
                    });
                });
            },
        },
    };
}
