Module.paintBrowser = (() => {
    let databasePromise;
    let documentKey = crypto.randomUUID();
    let sequence = 0;
    let droppedFile;
    let downloadUrl;
    const api = {dirty: false};

    function reply(id, result, bytes = new Uint8Array()) {
        const metadata = new TextEncoder().encode(JSON.stringify(result));
        let meta = 0, data = 0;
        try {
            meta = _malloc(metadata.length || 1);
            if (bytes.length) data = _malloc(bytes.length);
            if (!meta || (bytes.length && !data)) throw new Error("브라우저 메모리가 부족합니다.");
            HEAPU8.set(metadata, meta);
            if (bytes.length) HEAPU8.set(bytes, data);
            Module._retropaint_browser_result(id, meta, metadata.length, data, bytes.length);
        } finally {
            if (meta) _free(meta);
            if (data) _free(data);
        }
    }
    function database() {
        if (!databasePromise) {
            databasePromise = new Promise((resolve, reject) => {
                const request = indexedDB.open("retropaint-local-v1", 1);
                request.onupgradeneeded = () => {
                    request.result.createObjectStore("heads");
                    request.result.createObjectStore("snapshots");
                };
                request.onerror = () => reject(request.error);
                let blocked = false;
                request.onblocked = () => { blocked = true; reject(new Error("다른 탭에서 복구 저장소를 사용 중입니다.")); };
                request.onsuccess = () => {
                    const db = request.result;
                    if (blocked) { db.close(); return; }
                    db.onversionchange = () => { db.close(); databasePromise = undefined; };
                    resolve(db);
                };
            }).catch(error => { databasePromise = undefined; throw error; });
        }
        return databasePromise;
    }
    function transaction(db, mode, work) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(["heads", "snapshots"], mode);
            let result;
            let failure;
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(failure || tx.error || new Error("복구 저장 실패"));
            tx.onabort = () => reject(failure || tx.error || new Error("복구 저장 취소"));
            try {
                work(tx, value => { result = value; }, error => { failure = error; tx.abort(); });
            } catch (error) { failure = error; tx.abort(); }
        });
    }
    async function readFile(file, limit) {
        if (!file) return {cancelled: true};
        if (file.size > limit) throw new Error(`파일은 ${limit / 1048576} MiB 이내여야 합니다.`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length > limit) throw new Error("파일 읽기 한도를 초과했습니다.");
        return {bytes, name: file.name.slice(0, 256)};
    }
    api.initialize = () => {
        window.addEventListener("beforeunload", event => {
            if (api.dirty) { event.preventDefault(); event.returnValue = ""; }
        });
        document.addEventListener("dragover", event => {
            if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
        }, true);
        document.addEventListener("drop", event => {
            if (!event.dataTransfer?.files.length) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            droppedFile = event.dataTransfer.files[0];
            Module._retropaint_browser_drop();
            droppedFile = undefined;
        }, true);
    };
    api.request = async (id, options, bytes) => {
        const operation = options.operation;
        try {
            if (operation === "open" || operation === "drop") {
                let file;
                if (operation === "drop") file = droppedFile;
                else {
                    file = await new Promise(resolve => {
                        const input = document.createElement("input");
                        input.type = "file";
                        input.accept = options.imageOnly ? ".png,.jpg,.jpeg,.bmp,.gif" : ".rpaint,.png,.jpg,.jpeg,.bmp,.gif";
                        input.hidden = true;
                        input.onchange = () => { const file = input.files[0]; input.remove(); resolve(file); };
                        input.oncancel = () => { input.remove(); resolve(undefined); };
                        document.body.append(input);
                        try { input.click(); } catch (error) { input.remove(); throw error; }
                    });
                }
                const result = await readFile(file, options.limit);
                reply(id, {ok: true, name: result.name, cancelled: result.cancelled}, result.bytes);
            } else if (operation === "download") {
                const previousUrl = downloadUrl;
                const nextUrl = URL.createObjectURL(new Blob([bytes], {type: options.mime}));
                const panel = document.getElementById("downloads");
                if (!panel) { URL.revokeObjectURL(nextUrl); throw new Error("다운로드 화면을 준비하지 못했습니다."); }
                const text = document.createElement("span");
                text.textContent = `${options.name} (${new Date().toLocaleTimeString()} 기준) 준비됨. 다운로드 위치에서 파일을 확인하세요. `;
                const button = document.createElement("button");
                button.textContent = "파일 받기";
                button.onclick = () => {
                    const anchor = document.createElement("a");
                    if (downloadUrl !== nextUrl) return;
                    anchor.href = nextUrl;
                    anchor.download = options.name;
                    document.body.append(anchor);
                    anchor.click();
                    anchor.remove();
                    text.textContent = "다운로드 요청됨. 실제 저장된 파일을 확인하세요. ";
                };
                const cancel = document.createElement("button");
                cancel.textContent = "닫기";
                cancel.onclick = () => {
                    if (downloadUrl !== nextUrl) return;
                    URL.revokeObjectURL(nextUrl); downloadUrl = undefined; panel.replaceChildren();
                };
                panel.replaceChildren(text, button, cancel);
                downloadUrl = nextUrl;
                if (previousUrl) URL.revokeObjectURL(previousUrl);
                reply(id, {ok: true});
            } else if (operation === "clipboardWrite") {
                if (options.textMode) await navigator.clipboard.writeText(options.text);
                else {
                    if (!globalThis.ClipboardItem) throw new Error("이미지 복사를 지원하지 않습니다. PNG 내보내기를 사용하세요.");
                    await navigator.clipboard.write([new ClipboardItem({"image/png": new Blob([bytes], {type: "image/png"})})]);
                }
                reply(id, {ok: true});
            } else if (operation === "clipboardRead") {
                let data;
                if (options.textMode) {
                    const text = await navigator.clipboard.readText();
                    if (text.length > 65536) throw new Error("문자는 65536자 이내로 붙여넣으세요.");
                    data = new TextEncoder().encode(text);
                }
                else {
                    const items = await navigator.clipboard.read();
                    const item = items.find(item => item.types.includes("image/png"));
                    if (!item) throw new Error("클립보드에 PNG 이미지가 없습니다. 파일 열기를 사용하세요.");
                    const blob = await item.getType("image/png");
                    if (blob.size > options.limit) throw new Error("클립보드 이미지가 너무 큽니다.");
                    data = new Uint8Array(await blob.arrayBuffer());
                }
                if (data.length > options.limit) throw new Error("클립보드 데이터가 너무 큽니다.");
                reply(id, {ok: true}, data);
            } else if (operation === "store") {
                const key = documentKey, serial = ++sequence;
                const db = await database();
                await transaction(db, "readwrite", (tx, done, fail) => {
                    const heads = tx.objectStore("heads"), snapshots = tx.objectStore("snapshots");
                    const get = heads.getAll(null, 33);
                    get.onsuccess = () => {
                        try {
                            if (key !== documentKey) return fail(new Error("다른 문서의 복구 결과를 취소했습니다."));
                            const existing = get.result.filter(head => head.key !== key);
                            if (existing.some(head => !Number.isSafeInteger(head.size) || head.size < 1 || head.size > options.limit))
                                return fail(new Error("복구 사본 정보가 손상되었습니다. 기존 사본을 보존합니다."));
                            if (existing.length >= 32 || existing.reduce((sum, head) => sum + head.size, bytes.length) > 64 * 1048576)
                                return fail(new Error("복구 저장소 한도입니다. 프로젝트를 다운로드하거나 복구 사본을 정리하세요."));
                            snapshots.put(new Blob([bytes]), key);
                            heads.put({key, sequence: serial, size: bytes.length, name: options.name, at: Date.now()}, key);
                        } catch (error) { fail(error); }
                    };
                });
                reply(id, {ok: true});
            } else if (operation === "recover") {
                const db = await database();
                const heads = await transaction(db, "readonly", (tx, done) => {
                    const get = tx.objectStore("heads").getAll(null, 33);
                    get.onsuccess = () => done(get.result);
                });
                if (heads.length > 32) throw new Error("복구 사본 개수 한도를 초과했습니다.");
                if (heads.some(head => typeof head.key !== "string" || head.key.length > 64 ||
                    typeof head.name !== "string" || head.name.length > 256 ||
                    !Number.isSafeInteger(head.at) || head.at < 0))
                    throw new Error("복구 사본 정보가 올바르지 않습니다. 기존 사본을 보존합니다.");
                heads.sort((a, b) => b.at - a.at);
                if (!options.key) {
                    reply(id, {ok: true, empty: !heads.length, entries: heads.map(head => ({key: head.key, name: head.name, at: head.at,
                        size: Number.isSafeInteger(head.size) && head.size >= 0 ? head.size : 0,
                        sequence: Number.isSafeInteger(head.sequence) ? head.sequence : 0}))});
                    return;
                }
                const {head, blob} = await transaction(db, "readonly", (tx, done, fail) => {
                    const get = tx.objectStore("heads").get(options.key);
                    get.onsuccess = () => {
                        const head = get.result;
                        if (!head || head.key !== options.key || head.sequence !== options.sequence)
                            return fail(new Error("선택한 복구 사본이 다른 탭에서 갱신되거나 삭제되었습니다. 목록을 다시 여세요."));
                        if (!Number.isSafeInteger(head.size) || head.size < 1 || head.size > options.limit)
                            return fail(new Error("복구 사본 크기가 올바르지 않습니다."));
                        const snapshot = tx.objectStore("snapshots").get(head.key);
                        snapshot.onsuccess = () => done({head, blob: snapshot.result});
                    };
                });
                if (!(blob instanceof Blob) || blob.size !== head.size) throw new Error("복구 사본이 손상되었습니다.");
                reply(id, {ok: true, name: head.name, at: head.at}, new Uint8Array(await blob.arrayBuffer()));
            } else if (operation === "reset") {
                const previous = documentKey;
                documentKey = crypto.randomUUID();
                sequence = 0;
                const db = await database();
                await transaction(db, "readwrite", tx => {
                    tx.objectStore("heads").delete(previous);
                    tx.objectStore("snapshots").delete(previous);
                });
            } else if (operation === "clear") {
                const db = await database();
                await transaction(db, "readwrite", tx => {
                    tx.objectStore("heads").clear();
                    tx.objectStore("snapshots").clear();
                });
                reply(id, {ok: true});
            }
        } catch (error) {
            reply(id, {ok: false, error: String(error?.message || error)});
        }
    };
    return api;
})();
