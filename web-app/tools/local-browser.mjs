// Development checks run only when explicitly started on this computer.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const groups = {
    core: [
        'test:browser',
        'test:usability',
        'test:fill-failure',
        'test:gif-input',
        'test:jpeg-orientation',
        'test:native-profile',
        'test:native-persistence',
        'test:native-recovery-flow',
        'test:spray-contract',
        'test:bulk-edit',
        'test:render-preparation',
    ],
    drawing: [
        'test:pointer-contract',
        'test:color-eraser-contract',
        'test:shape-color-contract',
        'test:roundrect-contract',
        'test:export-preview',
        'test:eraser-settings',
    ],
    viewport: [
        'test:touch-viewport',
        'test:camera-viewport',
        'test:recovery-contract',
        'test:codec-reply',
        'test:alpha-contract',
    ],
    selection: [
        'test:selection-preparation',
        'test:selection-resize',
        'test:selection-contract',
        'test:selection-source',
        'test:masked-transform',
        'test:fill-key',
        'test:cut-key',
        'test:eraser-picker-contract',
        'test:square-contract',
        'test:clipboard-contract',
    ],
    pending: ['test:pending-contract', 'test:document-tabs', 'test:close-cancel', 'test:storage'],
    raster: ['test:tiles', 'test:scene-contract'],
};
const group = process.argv[2];
if (!group || group === '--list') {
    for (const [name, suites] of Object.entries(groups)) console.log(`${name}: ${suites.join(' ')}`);
    console.log('Run: npm run test:local-browser -- <group|all>');
} else if (group !== 'all' && !Object.hasOwn(groups, group)) {
    console.error('Unknown browser group: ' + group);
    process.exitCode = 2;
} else if (!process.env.PAINT_TEST_URL || !process.env.npm_execpath) {
    console.error('Start the local preview server, set PAINT_TEST_URL, and use npm run test:local-browser.');
    process.exitCode = 2;
} else {
    const suites = group === 'all' ? Object.values(groups).flat() : groups[group];
    for (const suite of suites) {
        console.log('Running local browser check: ' + suite);
        const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', suite], {
            cwd: fileURLToPath(new URL('..', import.meta.url)),
            env: process.env,
            stdio: 'inherit',
        });
        if (result.error) console.error(result.error.message);
        if (result.error || result.status !== 0) {
            console.error('FAILED: ' + suite);
            process.exitCode = 1;
        }
    }
}
