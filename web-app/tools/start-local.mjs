import { fileURLToPath } from 'node:url';

// Keep the server in this process so terminal signals also close Vite's watcher.
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
    console.log('npm run start:local [-- --port 18922] (127.0.0.1 only; default port 8922)');
    process.exit(0);
}
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--port' || !/^[0-9]+$/.test(args[1]))) {
    console.error('Usage: npm run start:local [-- --port 18922]');
    process.exit(1);
}
const port = args.length ? Number(args[1]) : 8922;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('Port must be an integer from 1 to 65535.');
    process.exit(1);
}
if (Number(process.versions.node.split('.')[0]) < 24) {
    console.error('Use Node.js 24 or later, then run npm ci --prefix web-app once from the repository root.');
    process.exit(1);
}

let createServer;
try {
    ({ createServer } = await import('vite'));
} catch (error) {
    console.error('Cannot load Vite. From the repository root, run npm ci --prefix web-app first.');
    console.error(error.message);
    process.exit(1);
}

const root = fileURLToPath(new URL('../', import.meta.url));
let server;
let stopping = false;
async function stop() {
    if (stopping) return;
    stopping = true;
    try {
        await server.close();
        console.log('myPaint local server stopped.');
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
try {
    server = await createServer({
        root,
        configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
        server: { host: '127.0.0.1', port, strictPort: true, open: false },
    });
    process.once('SIGINT', stop);
    // Vite owns SIGTERM and closes its server before exiting with signal status.
    await server.listen();
    console.log(`myPaint local: http://127.0.0.1:${port}/ — stop with Ctrl+C`);
} catch (error) {
    console.error(`Cannot start myPaint on 127.0.0.1:${port}: ${error.message}`);
    console.error('If the port is occupied, leave that service running and choose -- --port 18922.');
    if (server) await stop();
    process.exitCode = 1;
}
