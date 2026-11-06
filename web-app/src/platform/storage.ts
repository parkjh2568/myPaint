import { isDesktop } from './native';
import { webLimits, validateProfile, type ResourceProfile } from '../engine/document';
export interface RecoveryEntry {
    key: string;
    sequence: number;
    size: number;
    name: string;
    at: number;
    source?: 'browser' | 'native' | 'legacy';
    token?: string;
    readOnly?: boolean;
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
            if (operation === 'clear' && entry?.source !== 'browser') {
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
        if (operation === 'clear' && (!entry || !validEntry(entry, entry.key, profile)))
            throw Error('복구 사본 정보가 올바르지 않습니다.');
        const key = this.key,
            serial = ++this.sequence;
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const r = indexedDB.open('retropaint-local-v1', 1);
            let blocked = false;
            r.onupgradeneeded = () => {
                r.result.createObjectStore('heads');
                r.result.createObjectStore('snapshots');
            };
            r.onerror = () => reject(r.error);
            r.onblocked = () => {
                blocked = true;
                reject(Error('다른 탭에서 복구 저장소를 사용 중입니다.'));
            };
            r.onsuccess = () => {
                if (blocked) {
                    r.result.close();
                    return;
                }
                resolve(r.result);
            };
        }).catch((error) => {
            if (nativeEntries) {
                this.warnings.push('이전 웹 복구 저장소를 읽지 못했습니다. 기존 사본은 보존합니다.');
                console.warn('myPaint previous browser recovery unavailable', error);
                return undefined;
            }
            throw error;
        });
        if (!db) return nativeEntries;
        try {
            const result = await new Promise<RecoveryEntry[] | Uint8Array | void>((resolve, reject) => {
                const tx = db.transaction(
                    ['heads', 'snapshots'],
                    operation === 'list' ? 'readonly' : 'readwrite',
                );
                let value: RecoveryEntry[] | Uint8Array | undefined;
                let failure: unknown;
                const heads = tx.objectStore('heads'),
                    snapshots = tx.objectStore('snapshots');
                tx.oncomplete = () => resolve(value);
                tx.onabort = () => reject(failure || tx.error || Error('복구 작업 실패'));
                tx.onerror = () => reject(failure || tx.error);
                if (operation === 'list') {
                    const entries: RecoveryEntry[] = [];
                    const r = heads.openCursor();
                    r.onsuccess = () => {
                        const cursor = r.result;
                        if (!cursor) {
                            value = entries.sort((a, b) => b.at - a.at);
                            return;
                        }
                        const entry: unknown = cursor.value;
                        if (entries.length >= 32 || !validEntry(entry, cursor.primaryKey, profile)) {
                            failure = Error('복구 사본 정보가 올바르지 않습니다. 기존 사본을 보존합니다.');
                            tx.abort();
                            return;
                        }
                        entries.push(entry);
                        cursor.continue();
                    };
                } else if (operation === 'write' && bytes) {
                    if (key !== this.key) {
                        failure = Error('오래된 문서의 복구 요청입니다.');
                        tx.abort();
                        return;
                    }
                    let count = 0,
                        otherCount = 0,
                        total = bytes.length;
                    const r = heads.openCursor();
                    r.onsuccess = () => {
                        const cursor = r.result;
                        if (cursor) {
                            const current: unknown = cursor.value;
                            if (count >= 32 || !validEntry(current, cursor.primaryKey, profile)) {
                                failure = Error(
                                    '복구 사본 정보가 올바르지 않습니다. 기존 사본을 보존합니다.',
                                );
                                tx.abort();
                                return;
                            }
                            count++;
                            if (current.key !== key) {
                                otherCount++;
                                total += current.size;
                            }
                            cursor.continue();
                            return;
                        }
                        if (key !== this.key) {
                            failure = Error('이전 문서의 복구 요청입니다.');
                            tx.abort();
                            return;
                        }
                        if (otherCount >= 32 || total > 64 * 1024 * 1024) {
                            failure = Error(
                                '복구 저장소 한도입니다. 프로젝트를 다운로드하거나 복구 사본을 정리하세요.',
                            );
                            tx.abort();
                            return;
                        }
                        snapshots.put(new Blob([bytes as Uint8Array<ArrayBuffer>]), key);
                        heads.put(
                            {
                                key,
                                sequence: serial,
                                size: bytes.length,
                                name: name.slice(0, 256),
                                at: Date.now(),
                            },
                            key,
                        );
                    };
                } else if (operation === 'clear' && entry) {
                    const r = heads.get(entry.key);
                    r.onsuccess = () => {
                        const current = r.result as RecoveryEntry | undefined;
                        if (
                            !validEntry(current, entry.key, profile) ||
                            current.sequence !== entry.sequence ||
                            current.size !== entry.size
                        ) {
                            failure = Error('복구 사본이 변경됐습니다. 목록을 다시 여세요.');
                            tx.abort();
                            return;
                        }
                        heads.delete(entry.key);
                        snapshots.delete(entry.key);
                    };
                }
            });
            if (nativeEntries && Array.isArray(result))
                return [
                    ...nativeEntries,
                    ...result.map((entry) => ({ ...entry, source: 'browser' as const })),
                ].sort((a, b) => b.at - a.at);
            return result;
        } catch (error) {
            if (nativeEntries) {
                this.warnings.push('이전 웹 복구 저장소를 읽지 못했습니다. 기존 사본은 보존합니다.');
                console.warn('myPaint previous browser recovery unavailable', error);
                return nativeEntries;
            }
            throw error;
        } finally {
            db.close();
        }
    }
    async read(entry: RecoveryEntry): Promise<Uint8Array> {
        const profile = this.profile;
        if (isDesktop() && entry.source !== 'browser') {
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
        if (!entry || !validEntry(entry, entry.key, profile))
            throw Error('복구 사본 정보가 올바르지 않습니다.');
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const r = indexedDB.open('retropaint-local-v1', 1);
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
        try {
            const blob = await new Promise<Blob>((resolve, reject) => {
                const tx = db.transaction(['heads', 'snapshots']),
                    h = tx.objectStore('heads').get(entry.key);
                let found: Blob | undefined;
                let error: unknown;
                h.onsuccess = () => {
                    const current = h.result as RecoveryEntry | undefined;
                    if (
                        !validEntry(current, entry.key, profile) ||
                        current.sequence !== entry.sequence ||
                        current.size !== entry.size
                    ) {
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
