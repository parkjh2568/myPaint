import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Native packaging is deliberately restricted to the supported desktop hosts.
const mode = process.argv[2];
const extra = process.argv.slice(3);
if (!['darwin', 'win32'].includes(process.platform)) {
    console.error('설치형은 Windows/macOS에서 빌드하세요. 모바일과 그 밖의 OS는 웹 버전을 사용합니다.');
    process.exit(1);
}
if (!['dev', 'build'].includes(mode) || extra.some((arg) => arg !== '--debug')) {
    console.error('사용법: npm run desktop 또는 npm run desktop:build -- [--debug]');
    process.exit(1);
}
const args = [mode];
if (mode === 'build') args.push('--bundles', process.platform === 'darwin' ? 'app' : 'nsis');
args.push(...extra);
const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'inherit',
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
