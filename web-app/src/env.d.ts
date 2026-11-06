/// <reference types="vite/client" />
interface Window {
    __TAURI__?: {
        core: {
            invoke: <T = unknown>(
                command: string,
                args?: Record<string, unknown> | Uint8Array,
                options?: { headers: Record<string, string> },
            ) => Promise<T>;
        };
    };
}

declare module 'jpeg-js/lib/encoder.js' {
    const encode: typeof import('jpeg-js').encode;
    export default encode;
}
