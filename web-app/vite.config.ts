import { defineConfig } from 'vite';
export default defineConfig({
    base: './',
    worker: { format: 'es' },
    server: { port: 8922, strictPort: true },
    build: { target: 'es2022', sourcemap: false },
});
