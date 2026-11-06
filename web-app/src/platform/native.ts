export function isDesktop(): boolean {
    return typeof window !== 'undefined' && !!window.__TAURI__?.core;
}
export interface NativeSaveOptions {
    generation: number;
    project: boolean;
    saveAs: boolean;
}
export async function activateNative(generation: number, key: string, sourceToken?: string): Promise<void> {
    if (!isDesktop()) return;
    if (!Number.isSafeInteger(generation) || generation < 1 || !/^[a-z0-9_-]{1,64}$/.test(key))
        throw Error('문서 세대가 올바르지 않습니다.');
    await window.__TAURI__!.core.invoke('activate_document', { generation, key, sourceToken });
}
export async function openNative(
    signal?: AbortSignal,
): Promise<{ token: string; name: string; bytes: Uint8Array; isProject: boolean } | undefined> {
    if (!isDesktop()) return;
    signal?.throwIfAborted();
    const invoke = window.__TAURI__!.core.invoke;
    const target = await invoke<{ token: string; name: string } | null>('choose_open');
    signal?.throwIfAborted();
    if (!target) return;
    if (typeof target.token !== 'string' || !target.token || typeof target.name !== 'string' || !target.name)
        throw Error('선택한 파일 정보가 올바르지 않습니다.');
    const response = await invoke<ArrayBuffer>('read_selected', { token: target.token });
    signal?.throwIfAborted();
    if (!(response instanceof ArrayBuffer) || response.byteLength < 1 || response.byteLength > 300 * 1048576)
        throw Error('파일 데이터 또는 크기가 올바르지 않습니다.');
    const bytes = new Uint8Array(response);
    return {
        ...target,
        bytes,
        isProject:
            /\.rpaint$/i.test(target.name) && new TextDecoder().decode(bytes.subarray(0, 8)) === 'RPAINT01',
    };
}
export async function saveNative(
    bytes: Uint8Array,
    suggestedName: string,
    signal?: AbortSignal,
    options: NativeSaveOptions = { generation: 1, project: true, saveAs: false },
): Promise<string | undefined> {
    if (!isDesktop()) return;
    signal?.throwIfAborted();
    if (
        !Number.isSafeInteger(options.generation) ||
        options.generation < 1 ||
        !bytes.length ||
        bytes.length > 300 * 1048576
    )
        throw Error('저장할 문서 세대 또는 파일 크기가 올바르지 않습니다.');
    const invoke = window.__TAURI__!.core.invoke;
    const target = await invoke<{ token: string; name: string; generation: number } | null>('choose_save', {
        name: suggestedName,
        ...options,
    });
    if (!target) return;
    if (
        typeof target.token !== 'string' ||
        !target.token ||
        typeof target.name !== 'string' ||
        !target.name ||
        target.generation !== options.generation
    )
        throw Error('저장 대상의 문서 세대가 변경됐습니다.');
    const cancel = () => {
        void invoke('cancel_write', { token: target.token }).catch(() => {});
    };
    if (signal?.aborted) {
        cancel();
        signal.throwIfAborted();
    }
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        const receipt = await invoke<{ name: string; generation: number; project: boolean }>(
            'write_selected',
            bytes,
            { headers: { 'x-save-token': target.token } },
        );
        if (
            !receipt ||
            receipt.generation !== options.generation ||
            receipt.name !== target.name ||
            receipt.project !== options.project
        )
            throw Error('파일 저장 응답을 확인하지 못했습니다. 현재 편집은 유지합니다.');
        // Atomic replacement has succeeded, including when cancellation arrived after commit.
        return receipt.name;
    } finally {
        signal?.removeEventListener('abort', cancel);
    }
}
