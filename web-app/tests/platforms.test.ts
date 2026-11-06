import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('native build entry point refuses mobile commands and targets', () => {
    const driver = fileURLToPath(new URL('../tools/desktop.mjs', import.meta.url));
    for (const args of [['android'], ['ios'], ['build', '--target', 'aarch64-linux-android']]) {
        const result = spawnSync(process.execPath, [driver, ...args], { encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /사용법|Windows\/macOS/);
    }
});
