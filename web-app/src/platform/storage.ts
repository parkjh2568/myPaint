import { isDesktop } from './native';
import { webLimits, validateProfile, type ResourceProfile } from '../engine/document';
export interface RecoveryEntry {
    key: string;
    sequence: number;
    size: number;
    name: string;
    at: number;
    source?: 'browser' | 'legacy-browser' | 'native' | 'legacy';
    token?: string;
    readOnly?: boolean;
}
const browserDatabase = 'mypaint-studio-recovery-v2';
const legacyBrowserDatabase = 'retropaint-local-v1';
const maxBrowserHeads = 32;
const maxBrowserBytes = 64 * 1024 * 1024;

function openBrowserRecovery(legacy: boolean): Promise<IDBDatabase | undefined> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(legacy ? legacyBrowserDatabase : browserDatabase, 1);
        let absent = false,
            blocked = false;
        request.onupgradeneeded = () => {
            if (legacy) {
                // Abort database creation when this origin has no legacy store.
                absent = true;
                request.transaction!.abort();
                return;
            }
            request.result.createObjectStore('heads');
            request.result.createObjectStore('snapshots');
        };
        request.onerror = () => (absent ? resolve(undefined) : reject(request.error));
        request.onblocked = () => {
            blocked = true;
            reject(Error('다른 탭에서 복구 저장소를 사용 중입니다.'));
        };
        request.onsuccess = () => {
            if (blocked) request.result.close();
            else resolve(request.result);
        };
    });
}

function validEntry(value: unknown, key: IDBValidKey, profile: ResourceProfile): value is RecoveryEntry {
    if (!value || typeof value !== 'object') return false;
    const entry = value as RecoveryEntry;
    return (
        typeof entry.key === 'string' &&
        entry.key.length > 0 &&
        entry.key.length <= 64 &&
        entry.key === key &&
        Number.isSafeInteger(entry.sequence) &&
        entry.sequence >= 1 &&
        Number.isSafeInteger(entry.size) &&
        entry.size >= 1 &&
        entry.size <= profile.inputBytes &&
        typeof entry.name === 'string' &&
        entry.name.length <= 256 &&
        Number.isSafeInteger(entry.at) &&
        entry.at >= 0 &&
        entry.at <= 8640000000000000
    );
}

function sameBrowserEntry(value: unknown, expected: RecoveryEntry): value is RecoveryEntry {
    return (
        validEntry(value, expected.key, webLimits) &&
        value.sequence === expected.sequence &&
        value.size === expected.size &&
        value.at === expected.at &&
        value.name === expected.name
    );
}

async function sha256(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class RecoveryStore {
    constructor(readonly profile: ResourceProfile = webLimits) {
        validateProfile(profile);
    }
    key = crypto.randomUUID();
    sequence = 0;
    generation = 1;
    warnings: string[] = [];
    async request(
        operation: 'list' | 'write' | 'clear',
        entry?: RecoveryEntry,
        bytes?: Uint8Array,
        name = '제목 없음',
    ): Promise<RecoveryEntry[] | Uint8Array | void> {
        const profile = this.profile;
        if (
            operation === 'write' &&
            (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > profile.inputBytes)
        )
            throw Error(`복구 파일은 ${profile.inputBytes / 1048576} MiB 이내여야 합니다.`);
        if (operation === 'list') this.warnings = [];
        let nativeEntries: RecoveryEntry[] | undefined;
        if (isDesktop()) {
            const invoke = window.__TAURI__!.core.invoke;
            if (operation === 'write') {
                const key = this.key,
                    generation = this.generation,
                    sequence = ++this.sequence;
                let title = name.slice(0, 256);
                if (/[\uD800-\uDBFF]$/.test(title)) title = title.slice(0, -1);
                const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(title)));
                await invoke('recovery_write', bytes, {
                    headers: {
                        'x-recovery-generation': String(generation),
                        'x-recovery-key': key,
                        'x-recovery-sequence': String(sequence),
                        'x-recovery-name': encoded,
                    },
                });
                return;
            }
            if (operation === 'clear' && entry?.source !== 'browser' && entry?.source !== 'legacy-browser') {
                if (!entry?.token || entry.readOnly || entry.source !== 'native')
                    throw Error('이전 앱의 복구 원본은 삭제하지 않습니다.');
                await invoke('recovery_clear', { token: entry.token });
                return;
            }
            if (operation === 'list') {
                const result = await invoke<{ entries: RecoveryEntry[]; warnings: string[] }>(
                    'recovery_list',
                );
                if (
                    !result ||
                    !Array.isArray(result.warnings) ||
                    result.warnings.length > 64 ||
                    result.warnings.some((warning) => typeof warning !== 'string' || warning.length > 1024)
                )
                    throw Error('복구 목록 경고가 올바르지 않습니다.');
                nativeEntries = result.entries;
                if (
                    !Array.isArray(nativeEntries) ||
                    nativeEntries.length > 64 ||
                    nativeEntries.some(
                        (entry) =>
                            !entry ||
                            !validEntry(entry, entry.key, profile) ||
                            typeof entry.token !== 'string' ||
                            !entry.token ||
                            !['native', 'legacy'].includes(entry.source || '') ||
                            entry.readOnly !== (entry.source === 'legacy'),
                    )
                )
                    throw Error('파일 복구 목록이 올바르지 않습니다.');
                this.warnings = result.warnings;
            }
        }
        if (operation === 'write' && bytes) {
            if (bytes.length > webLimits.inputBytes)
                throw Error(`복구 파일은 ${webLimits.inputBytes / 1048576} MiB 이내여야 합니다.`);
            await this.writeBrowser(
                {
                    key: this.key,
                    sequence: ++this.sequence,
                    size: bytes.length,
                    name: name.slice(0, 256),
                    at: Date.now(),
                },
                new Blob([bytes as Uint8Array<ArrayBuffer>]),
            );
            return;
        }
        if (operation === 'clear') {
            if (!entry || !validEntry(entry, entry.key, webLimits))
                throw Error('복구 사본 정보가 올바르지 않습니다.');
            if (entry.readOnly || entry.source === 'legacy-browser')
                throw Error('이전 웹의 복구 원본은 삭제하지 않습니다.');
            const db = (await openBrowserRecovery(false))!;
            try {
                await new Promise<void>((resolve, reject) => {
                    const tx = db.transaction(['heads', 'snapshots'], 'readwrite'),
                        heads = tx.objectStore('heads');
                    let changed = false;
                    tx.oncomplete = () => resolve();
                    tx.onabort = () =>
                        reject(changed ? Error('복구 사본이 변경됐습니다. 목록을 다시 여세요.') : tx.error);
                    const current = heads.get(entry.key);
                    current.onsuccess = () => {
                        if (!sameBrowserEntry(current.result, entry)) {
                            changed = true;
                            tx.abort();
                            return;
                        }
                        heads.delete(entry.key);
                        tx.objectStore('snapshots').delete(entry.key);
                    };
                });
            } finally {
                db.close();
            }
            return;
        }
        const [current, legacy] = await Promise.allSettled([this.listBrowser(false), this.listBrowser(true)]);
        if (!nativeEntries && current.status === 'rejected' && legacy.status === 'rejected')
            throw current.reason;
        const entries = [...(nativeEntries ?? [])];
        for (const result of [current, legacy]) {
            if (result.status === 'fulfilled') entries.push(...result.value);
            else this.warnings.push('일부 웹 복구 저장소를 읽지 못했습니다. 기존 사본은 보존합니다.');
        }
        return entries.sort((a, b) => b.at - a.at);
    }

    private async listBrowser(legacy: boolean): Promise<RecoveryEntry[]> {
        const db = await openBrowserRecovery(legacy);
        if (!db) return [];
        try {
            return await new Promise<RecoveryEntry[]>((resolve, reject) => {
                const tx = db.transaction(['heads', 'snapshots']),
                    request = tx.objectStore('heads').openCursor();
                const entries: RecoveryEntry[] = [];
                let count = 0,
                    damaged = false;
                tx.oncomplete = () => {
                    if (damaged)
                        this.warnings.push(
                            '복구 사본 정보가 올바르지 않은 항목을 건너뛰었습니다. 기존 사본은 보존합니다.',
                        );
                    resolve(entries);
                };
                tx.onabort = () => reject(tx.error || Error('복구 목록 읽기 실패'));
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) return;
                    if (++count > maxBrowserHeads) {
                        damaged = true;
                        return;
                    }
                    const entry: unknown = cursor.value;
                    if (validEntry(entry, cursor.primaryKey, webLimits)) {
                        const { key, sequence, size, name, at } = entry;
                        entries.push({
                            key,
                            sequence,
                            size,
                            name,
                            at,
                            source: legacy ? 'legacy-browser' : 'browser',
                            readOnly: legacy,
                        });
                    } else damaged = true;
                    cursor.continue();
                };
            });
        } finally {
            db.close();
        }
    }

    private async writeBrowser(
        head: RecoveryEntry,
        snapshot: Blob,
        importing = false,
    ): Promise<Blob | undefined> {
        const db = (await openBrowserRecovery(false))!;
        try {
            return await new Promise<Blob | undefined>((resolve, reject) => {
                const tx = db.transaction(['heads', 'snapshots'], 'readwrite'),
                    heads = tx.objectStore('heads'),
                    snapshots = tx.objectStore('snapshots');
                let failure: string | undefined, copied: Blob | undefined;
                const fail = (message: string) => {
                    failure = message;
                    tx.abort();
                };
                tx.oncomplete = () => resolve(copied);
                tx.onabort = () => reject(failure ? Error(failure) : tx.error || Error('복구 저장 실패'));
                let count = 0,
                    otherCount = 0,
                    total = snapshot.size,
                    present = false;
                const request = heads.openCursor();
                request.onsuccess = () => {
                    if (!importing && head.key !== this.key) {
                        fail('이전 문서의 복구 요청입니다.');
                        return;
                    }
                    const cursor = request.result;
                    if (cursor) {
                        const current: unknown = cursor.value;
                        if (++count > maxBrowserHeads || !validEntry(current, cursor.primaryKey, webLimits)) {
                            fail('복구 사본 정보가 올바르지 않습니다. 기존 사본을 보존합니다.');
                            return;
                        }
                        if (current.key === head.key) {
                            if (importing && !sameBrowserEntry(current, head)) {
                                fail('복제한 복구 사본 정보가 올바르지 않습니다.');
                                return;
                            }
                            if (!importing && current.sequence >= head.sequence) {
                                fail('이전 문서의 복구 요청입니다.');
                                return;
                            }
                            present = true;
                        } else {
                            otherCount++;
                            total += current.size;
                        }
                        cursor.continue();
                        return;
                    }
                    if (importing && present) {
                        const existing = snapshots.get(head.key);
                        existing.onsuccess = () => {
                            if (!(existing.result instanceof Blob) || existing.result.size !== head.size)
                                fail('복제한 복구 사본이 손상됐습니다.');
                            else copied = existing.result;
                        };
                        return;
                    }
                    if (otherCount >= maxBrowserHeads || total > maxBrowserBytes) {
                        fail('복구 저장소 한도입니다. 프로젝트를 다운로드하거나 복구 사본을 정리하세요.');
                        return;
                    }
                    snapshots.put(snapshot, head.key);
                    heads.put(head, head.key);
                };
            });
        } finally {
            db.close();
        }
    }

    // The caller validates the complete project with the decoder before copying the same bytes.
    async copyLegacyBrowser(entry: RecoveryEntry, snapshot: Blob): Promise<void> {
        if (
            entry.source !== 'legacy-browser' ||
            !entry.readOnly ||
            !validEntry(entry, entry.key, webLimits) ||
            snapshot.size !== entry.size
        )
            throw Error('이전 웹 복구 사본 정보가 올바르지 않습니다.');
        const digest = await sha256(await snapshot.arrayBuffer());
        const identity = new TextEncoder().encode(
            JSON.stringify([entry.key, entry.sequence, entry.size, entry.name, entry.at, digest]),
        );
        const key = await sha256(identity);
        const copied = await this.writeBrowser(
            { key, sequence: entry.sequence, size: entry.size, name: entry.name, at: entry.at },
            snapshot,
            true,
        );
        if (copied && (await sha256(await copied.arrayBuffer())) !== digest)
            throw Error('복제한 복구 사본이 손상됐습니다.');
    }
    async read(entry: RecoveryEntry): Promise<Uint8Array> {
        const profile = this.profile;
        if (isDesktop() && entry.source !== 'browser' && entry.source !== 'legacy-browser') {
            if (!entry.token || !validEntry(entry, entry.key, profile))
                throw Error('복구 사본 정보가 올바르지 않습니다.');
            const data = await window.__TAURI__!.core.invoke<ArrayBuffer>('recovery_read', {
                token: entry.token,
            });
            if (
                !(data instanceof ArrayBuffer) ||
                data.byteLength !== entry.size ||
                data.byteLength > profile.inputBytes
            )
                throw Error('복구 사본이 변경됐거나 손상됐습니다.');
            return new Uint8Array(data);
        }
        if (!entry || !validEntry(entry, entry.key, webLimits))
            throw Error('복구 사본 정보가 올바르지 않습니다.');
        const db = await openBrowserRecovery(entry.source === 'legacy-browser');
        if (!db) throw Error('복구 사본 없음');
        try {
            const blob = await new Promise<Blob>((resolve, reject) => {
                const tx = db.transaction(['heads', 'snapshots']),
                    h = tx.objectStore('heads').get(entry.key);
                let found: Blob | undefined;
                let error: unknown;
                h.onsuccess = () => {
                    if (!sameBrowserEntry(h.result, entry)) {
                        error = Error('복구 사본이 변경됐습니다.');
                        tx.abort();
                        return;
                    }
                    const r = tx.objectStore('snapshots').get(entry.key);
                    r.onsuccess = () => {
                        if (!(r.result instanceof Blob) || r.result.size !== entry.size) {
                            error = Error('복구 사본이 손상됐습니다.');
                            tx.abort();
                            return;
                        }
                        found = r.result;
                    };
                };
                tx.oncomplete = () => (found ? resolve(found) : reject(Error('복구 사본 없음')));
                tx.onabort = () => reject(error || tx.error);
                tx.onerror = () => reject(tx.error);
            });
            return new Uint8Array(await blob.arrayBuffer());
        } finally {
            db.close();
        }
    }
    reset(key = crypto.randomUUID(), generation = this.generation + 1): void {
        this.key = key;
        this.generation = generation;
        this.sequence = 0;
    }
}
