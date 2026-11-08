import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createState, webLimits } from '../src/engine/document.ts';
import { encodeProject, decodeProject, decodePng } from '../src/engine/format.ts';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(
        process.env.PAINT_TOUCH_VIEWPORT_OUTPUT ||
            '../build-web-work/task-planning/touch-viewport/ui/results.json',
    ),
    out = path.dirname(output),
    hash = (bytes) => createHash('sha256').update(bytes).digest('hex'),
    result = {
        url: process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/',
        scope: 'Public normal-web Chromium DOM/Canvas/Workers and real file chooser/download fixtures, without native IPC model or private Studio hooks. Coarse touch, rotation, virtual keyboard height and composition events are emulated; no physical mobile/IME/native acceptance or performance claim. Position-only safe-area padding and17px desktop scrollbar gutter are controlled CSS emulations. Released asynchronous resize jobs remain in selection-resize-contract, not duplicated here.',
        testSha256: hash(await fs.readFile(new URL(import.meta.url))),
        sourceSha256: {},
        assets: [],
        cases: [],
        checks: [],
        errors: [],
        failures: [],
    };
await fs.mkdir(out, { recursive: true });
for (const file of ['main.ts', 'style.css', 'engine/document.ts', 'engine/operations.ts'])
    result.sourceSha256[file] = hash(await fs.readFile(new URL('../src/' + file, import.meta.url)));
const original = createState(64, 64, [255, 255, 255, 255], webLimits);
original.layers[0].pixels.set([0, 0, 0, 0], 0);
for (let y = 32; y < 36; y++)
    for (let x = 32; x < 36; x++) original.layers[0].pixels.set([255, 0, 0, 255], (y * 64 + x) * 4);
const originalBytes = encodeProject(original, webLimits);
result.fixtureSha256 = hash(originalBytes);
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
});
result.browser = browser.version();
const watchdog = setTimeout(() => {
    result.failures.push({ name: 'suite-watchdog', error: '240s suite deadline' });
    void browser.close();
}, 240000);
async function command(page, name) {
    const button = page.getByRole('button', { name, exact: true });
    if (await button.isVisible()) await button.click();
    else {
        await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
    }
}
async function boot(context) {
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => result.errors.push(error.message));
    page.on('response', (response) => {
        if (response.status() >= 400) result.errors.push(response.status() + ' ' + response.url());
        if (/\.js(?:[?#]|$)/.test(response.url()) && !result.assets.includes(response.url()))
            result.assets.push(response.url());
    });
    await page.addInitScript(() => {
        const probe = (window.touchViewportTest = { blobs: [], pointer: undefined }),
            create = URL.createObjectURL;
        URL.createObjectURL = function (blob) {
            probe.blobs.push(blob);
            return create.call(this, blob);
        };
        document.addEventListener(
            'pointerdown',
            (event) => {
                if (event.target.matches('.workspace canvas')) probe.pointer = event.pointerId;
            },
            true,
        );
    });
    await page.goto(result.url);
    await page.waitForFunction(
        () =>
            document.querySelector('.workspace canvas')?.dataset.ready === 'true' &&
            !document.querySelector('dialog[open]'),
    );
    await page.waitForTimeout(650);
    return page;
}
async function preferences(page, skin, manual = false) {
    await command(page, '환경설정');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('스킨', { exact: true }).selectOption(skin);
    await dialog.getByLabel('조작부 크기', { exact: true }).selectOption(manual ? '터치' : '자동');
    await dialog.getByRole('button', { name: '확인', exact: true }).click();
    await page.waitForFunction(
        ({ skin, manual }) =>
            document.documentElement.dataset.skin === (skin === 'Classic 98' ? 'classic' : 'studio') &&
            document.documentElement.dataset.density ===
                (manual || matchMedia('(any-pointer:coarse)').matches ? 'touch' : 'mouse'),
        { skin, manual },
    );
}
async function targets(page, selector, record, label) {
    const count = await page.locator(selector).count(),
        measurements = [];
    record.states.push({ name: label, measurements });
    for (let index = 0; index < count; index++) {
        const control = page.locator(selector).nth(index);
        if (
            !(await control.evaluate(
                (element) =>
                    element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
                    !element.matches(':disabled') &&
                    element.getAttribute('aria-disabled') !== 'true',
            ))
        )
            continue;
        // Associated checkbox labels are the real enlarged click targets. The
        // pointer must hit that label/control, not an unrelated nested button.
        await control.evaluate((element) => {
            const target = (element.matches('input[type=checkbox]') && element.labels?.[0]) || element;
            target.scrollIntoView({ block: 'center', inline: 'nearest' });
        });
        const observation = await control.evaluate((element) => {
            const target = (element.matches('input[type=checkbox]') && element.labels?.[0]) || element,
                r = target.getBoundingClientRect(),
                modal = document.querySelector('dialog:modal'),
                density = document.documentElement.dataset.density;
            let left = Math.max(0, r.left),
                top = Math.max(0, r.top),
                right = Math.min(innerWidth, r.right),
                bottom = Math.min(innerHeight, r.bottom);
            for (let a = target.parentElement; a; a = a.parentElement) {
                const style = getComputedStyle(a),
                    b = a.getBoundingClientRect();
                if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
                    left = Math.max(left, b.left);
                    right = Math.min(right, b.left + a.clientLeft + a.clientWidth);
                }
                if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
                    top = Math.max(top, b.top);
                    bottom = Math.min(bottom, b.top + a.clientTop + a.clientHeight);
                }
            }
            const points = [
                ['center', r.x + r.width / 2, r.y + r.height / 2],
                ['left', r.left + 1, r.y + r.height / 2],
                ['right', r.right - 1, r.y + r.height / 2],
                ['top', r.x + r.width / 2, r.top + 1],
                ['bottom', r.x + r.width / 2, r.bottom - 1],
            ].map(([kind, x, y]) => {
                const hit = document.elementFromPoint(x, y),
                    foreignButton = hit?.closest('button');
                return {
                    kind,
                    hit: hit
                        ? {
                              tag: hit.tagName,
                              id: hit.id,
                              name: hit.getAttribute('aria-label') || hit.textContent?.trim().slice(0, 60),
                          }
                        : null,
                    accepts: Boolean(
                        hit &&
                            (hit === target || target.contains(hit)) &&
                            !(
                                target.tagName === 'LABEL' &&
                                foreignButton &&
                                !element.contains(foreignButton)
                            ),
                    ),
                };
            });
            return {
                name:
                    element.getAttribute('aria-label') ||
                    element.getAttribute('title') ||
                    element.textContent?.trim().slice(0, 70),
                tag: element.tagName,
                type: element.getAttribute('type'),
                id: element.id,
                targetTag: target.tagName,
                density,
                coarse: matchMedia('(any-pointer:coarse)').matches,
                rect: { x: r.x, y: r.y, width: r.width, height: r.height },
                visible: { width: Math.max(0, right - left), height: Math.max(0, bottom - top) },
                modalBlocked: Boolean(modal && !modal.contains(element)),
                points,
            };
        });
        if (observation.modalBlocked) continue;
        measurements.push(observation);
        assert(
            observation.visible.width >= observation.rect.width - 0.01 &&
                observation.visible.height >= observation.rect.height - 0.01,
            label + ' target clipped after scrolling: ' + observation.name,
        );
        if (observation.density === 'touch')
            assert(
                observation.rect.width >= 48 && observation.rect.height >= 48,
                label +
                    ' target must be48 CSSpx: ' +
                    observation.name +
                    ' ' +
                    observation.rect.width +
                    'x' +
                    observation.rect.height,
            );
        assert(
            observation.points.every((point) => point.accepts),
            label +
                ' target hit test blocked: ' +
                observation.name +
                ' ' +
                JSON.stringify(observation.points),
        );
    }
    assert(measurements.length > 0, label + ' must inspect actual controls');
}
async function modalBackground(page, record) {
    const observation = await page.evaluate(() => {
        const dialog = document.querySelector('dialog:modal'),
            button = document.querySelector('[data-command=menu]'),
            r = button.getBoundingClientRect(),
            hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return {
            modal: !!dialog,
            backgroundBlocked: hit !== button && !button.contains(hit),
            rootInert: document.querySelector('#app').inert,
        };
    });
    assert(
        observation.modal && observation.backgroundBlocked,
        'Native modal top layer must block background controls',
    );
    record.modalFocus ||= [];
    for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Tab');
        const focus = await page.evaluate(() => ({
            inside: Boolean(document.querySelector('dialog:modal')?.contains(document.activeElement)),
            tag: document.activeElement?.tagName,
            hasFocus: document.hasFocus(),
            background: Boolean(document.activeElement?.closest('#app')),
            modalOpen: Boolean(document.querySelector('dialog:modal')),
        }));
        record.modalFocus.push(focus);
        assert(focus.modalOpen && !focus.background, 'Modal Tab must not focus application background');
        // Native Chromium dialogs may yield one neutral BODY step to browser
        // chrome. A bare HTML-dialog control confirms this is not app escape.
        if (!focus.inside) {
            assert(
                focus.tag === 'BODY' && !focus.hasFocus,
                'Only unfocused native BODY is an allowed neutral step',
            );
            await page.keyboard.press('Tab');
            const returned = await page.evaluate(() =>
                Boolean(document.querySelector('dialog:modal')?.contains(document.activeElement)),
            );
            assert(returned, 'The next Tab after native neutral focus must return to the modal');
        }
    }
    record.modal = observation;
}
async function loadFixture(page) {
    const chooser = page.waitForEvent('filechooser');
    await command(page, '파일 열기');
    await (
        await chooser
    ).setFiles({
        name: 'touch64.rpaint',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(originalBytes),
    });
    await page.waitForFunction(
        () =>
            document.querySelector('.document-info').textContent.includes('64') &&
            !document.querySelector('.busy') &&
            document.querySelector('.workspace canvas').dataset.ready === 'true',
    );
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.equal(await page.locator('#zoom').textContent(), '100%');
    const box = await page.locator('.workspace canvas').boundingBox(),
        left = box.x + (box.width - 64) / 2,
        top = box.y + (box.height - 64) / 2;
    await page.getByRole('button', { name: '연필', exact: true }).click();
    await page.mouse.click(left + 10.5, top + 10.5);
    await command(page, '실행 취소');
    assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
    return { left, top };
}
async function download(page, png = false) {
    const before = await page.evaluate(() => window.touchViewportTest.blobs.length);
    if (png) {
        await command(page, '이미지 내보내기');
        await page.waitForFunction(
            () => document.querySelector('.export-preview')?.dataset.state === 'ready',
        );
        await page.getByRole('dialog').getByRole('button', { name: '내보내기', exact: true }).click();
    } else await command(page, '프로젝트 저장 또는 다운로드');
    await page.getByRole('button', { name: '파일 받기', exact: true }).waitFor();
    assert(await page.evaluate((n) => window.touchViewportTest.blobs.length > n, before));
    const bytes = Uint8Array.from(
        await page.evaluate(async () =>
            Array.from(new Uint8Array(await window.touchViewportTest.blobs.at(-1).arrayBuffer())),
        ),
    );
    await page.getByRole('button', { name: '다운로드 닫기', exact: true }).click();
    return png ? bytes : decodeProject(bytes, webLimits);
}
async function canvasState(page) {
    return page.locator('.workspace canvas').evaluate((c) => {
        const r = c.getBoundingClientRect();
        return {
            backing: [c.width, c.height],
            origin: [r.x, r.y],
            css: [r.width, r.height],
            dpr: Math.min(devicePixelRatio || 1, 2),
            ready: c.dataset.ready,
        };
    });
}

try {
    const viewports = [
        { name: 'phone320', width: 320, height: 844, touch: true },
        { name: 'phone360', width: 360, height: 844, touch: true },
        { name: 'phone390', width: 390, height: 844, touch: true },
        { name: 'tablet768', width: 768, height: 1024, touch: true },
        { name: 'landscape844', width: 844, height: 390, touch: true },
        { name: 'desktop1280', width: 1280, height: 800, touch: false },
        { name: 'desktop-manual-touch', width: 1280, height: 800, touch: false, manual: true },
    ];
    for (const setup of viewports)
        for (const skin of ['Studio Dark', 'Classic 98']) {
            const name = setup.name + '-' + skin,
                context = await browser.newContext({
                    viewport: { width: setup.width, height: setup.height },
                    deviceScaleFactor: 1,
                    hasTouch: setup.touch,
                    isMobile: setup.touch,
                }),
                record = { name, setup, skin, states: [] };
            result.cases.push(record);
            try {
                const page = await boot(context);
                await preferences(page, skin, setup.manual);
                record.media = await page.evaluate(() => ({
                    coarse: matchMedia('(any-pointer:coarse)').matches,
                    density: document.documentElement.dataset.density,
                    skin: document.documentElement.dataset.skin,
                }));
                assert.equal(record.media.density, setup.touch || setup.manual ? 'touch' : 'mouse');
                await targets(page, '.topbar button,.tools button,.statusbar button', record, 'base');
                assert(
                    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                    'No horizontal document overflow',
                );
                for (const [state, buttonName] of [
                    ['properties', '색상과 브러시'],
                    ['layers', '레이어 패널'],
                ]) {
                    const button = page.getByRole('button', { name: buttonName, exact: true });
                    if (await button.isVisible()) await button.click();
                    await targets(
                        page,
                        '.inspector button,.inspector input,.inspector select',
                        record,
                        state,
                    );
                    const close = page.getByRole('button', { name: '패널 닫기', exact: true });
                    if (await page.locator('.inspector.open').count()) {
                        const accessible = await close.evaluate((button) => {
                            const r = button.getBoundingClientRect(),
                                hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                            return (
                                r.x >= 0 &&
                                r.y >= 0 &&
                                r.right <= innerWidth &&
                                r.bottom <= innerHeight &&
                                Boolean(hit && (button === hit || button.contains(hit)))
                            );
                        });
                        assert(
                            accessible,
                            'Panel close remains visible and hittable after scrolling all controls',
                        );
                        await close.click();
                    }
                }
                await command(page, '파일 및 편집 메뉴');
                await targets(page, 'dialog[open] button', record, 'menu');
                await modalBackground(page, record);
                await page.keyboard.press('Escape');
                await command(page, '이미지 내보내기');
                await page.waitForFunction(
                    () => document.querySelector('.export-preview')?.dataset.state === 'ready',
                );
                await targets(
                    page,
                    'dialog[open] button,dialog[open] input,dialog[open] select',
                    record,
                    'export',
                );
                await modalBackground(page, record);
                if (setup.name === 'phone390') {
                    await page.screenshot({
                        path: path.join(out, '390-' + skin.replaceAll(' ', '-') + '.png'),
                    });
                    await page.getByRole('dialog').getByLabel('파일 이름', { exact: true }).focus();
                    await page.setViewportSize({ width: 390, height: 500 });
                    await targets(
                        page,
                        'dialog[open] button,dialog[open] input,dialog[open] select',
                        record,
                        'keyboard-height-emulation',
                    );
                }
                await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
                record.ok = true;
                result.checks.push(name);
            } catch (error) {
                record.error = String(error.stack || error);
                result.failures.push({ name, error: record.error });
            } finally {
                await context.close();
            }
        }
    for (const ending of ['pointercancel', 'pointerup']) {
        const name = 'material-viewport-change-rolls-back-' + ending,
            record = { name },
            context = await browser.newContext({
                viewport: { width: 1280, height: 800 },
                deviceScaleFactor: 1,
            });
        result.cases.push(record);
        try {
            const page = await boot(context),
                { left, top } = await loadFixture(page);
            assert.deepEqual(await download(page), original);
            await page.mouse.move(left + 15.5, top + 15.5);
            await page.mouse.down();
            await page.mouse.move(left + 20.5, top + 15.5);
            await page.setViewportSize({ width: 390, height: 844 });
            await page.evaluate(
                () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            );
            if (ending === 'pointercancel')
                await page.locator('.workspace canvas').evaluate((c) =>
                    c.dispatchEvent(
                        new PointerEvent('pointercancel', {
                            pointerId: window.touchViewportTest.pointer,
                            pointerType: 'mouse',
                            isPrimary: true,
                            bubbles: true,
                        }),
                    ),
                );
            await page.mouse.up();
            await page.evaluate(
                () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            );
            record.after = await canvasState(page);
            assert.deepEqual(
                record.after.backing,
                record.after.css.map((value) => Math.max(1, Math.round(value * record.after.dpr))),
                'Backing must match current geometry after material resize cancels provisional gesture',
            );
            assert.deepEqual(
                await download(page),
                original,
                'Provisional stroke cancelled by geometry change must restore full source, including normal-up afterward',
            );
            assert(
                await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled(),
                'Rollback preserves old Redo',
            );
            const target = await page.locator('.workspace canvas').evaluate((c) => {
                const r = c.getBoundingClientRect(),
                    bounds = document.querySelector('.canvas-bounds').getBoundingClientRect(),
                    scaleX = bounds.width / 64,
                    scaleY = bounds.height / 64,
                    pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data,
                    point = (x, y) => ({ x: bounds.x + x * scaleX, y: bounds.y + y * scaleY }),
                    sample = ({ x, y }) => {
                        const bx = Math.floor(((x - r.x) * c.width) / r.width),
                            by = Math.floor(((y - r.y) * c.height) / r.height),
                            i = (by * c.width + bx) * 4;
                        return Array.from(pixels.slice(i, i + 4));
                    },
                    target = point(40.5, 32.5);
                // A displayed backing pixel is quantized, not the continuous document origin.
                // Keep the old visual scan as evidence, not as a coordinate calibration.
                let firstRed;
                for (let y = 0; y < c.height && !firstRed; y++)
                    for (let x = 0; x < c.width; x++) {
                        const i = (y * c.width + x) * 4;
                        if (
                            pixels[i] === 255 &&
                            pixels[i + 1] === 0 &&
                            pixels[i + 2] === 0 &&
                            pixels[i + 3] === 255
                        ) {
                            firstRed = {
                                x,
                                y,
                                oldTargetDocumentX:
                                    (r.x + ((x + 8.5) * r.width) / c.width - bounds.x) / scaleX,
                                oldTargetDocumentY:
                                    (r.y + ((y + 0.5) * r.height) / c.height - bounds.y) / scaleY,
                            };
                            break;
                        }
                    }
                return {
                    ...target,
                    scaleX,
                    scaleY,
                    firstRed,
                    marker: sample(point(33.5, 33.5)),
                    destination: sample(target),
                    hitsCanvas: document.elementFromPoint(target.x, target.y) === c,
                };
            });
            record.retryTarget = target;
            assert.equal(target.scaleX, 1, 'The small document remains at 100% after viewport change');
            assert.equal(target.scaleY, 1);
            assert(target.firstRed, 'Original displayed marker missing');
            assert.deepEqual(target.marker, [255, 0, 0, 255], 'Document marker must remain visibly aligned');
            assert.deepEqual(target.destination, [255, 255, 255, 255], 'Retry must start on blank source');
            assert(target.hitsCanvas, 'First retry point must hit the canvas, not a resize control');
            await page.mouse.click(target.x, target.y);
            const expected = {
                ...original,
                layers: original.layers.map((layer) => ({ ...layer, pixels: layer.pixels.slice() })),
            };
            expected.layers[0].pixels.set([22, 121, 234, 255], (32 * 64 + 40) * 4);
            assert.deepEqual(
                await download(page),
                expected,
                'First next visual click must hit exact document pixel',
            );
            await command(page, '실행 취소');
            assert.deepEqual(await download(page), original, 'One Undo restores source after retry');
            record.ok = true;
            result.checks.push(name);
        } catch (error) {
            record.error = String(error.stack || error);
            result.failures.push({ name, error: record.error });
        } finally {
            await context.close();
        }
    }
    for (const kind of ['stationary-selection', 'stationary-text-ime']) {
        const name = kind + '-manual-zoom-camera-preservation',
            record = { name },
            context = await browser.newContext({
                viewport: { width: 1280, height: 800 },
                deviceScaleFactor: 1,
            });
        result.cases.push(record);
        try {
            const page = await boot(context);
            await loadFixture(page);
            await command(page, '확대');
            assert.equal(await page.locator('#zoom').textContent(), '125%');
            const box = await page.locator('.workspace canvas').boundingBox(),
                left = box.x + (box.width - 80) / 2,
                top = box.y + (box.height - 80) / 2;
            let editor;
            if (kind === 'stationary-selection') {
                await page.getByRole('button', { name: '사각 선택', exact: true }).click();
                await page.locator('#transparent-selection').uncheck();
                await page.mouse.move(left + 28.1 * 1.25, top + 28.1 * 1.25);
                await page.mouse.down();
                await page.mouse.move(left + 39.9 * 1.25, top + 39.9 * 1.25);
                await page.mouse.up();
                await page.keyboard.press('ArrowRight');
            } else {
                await page.getByRole('button', { name: '문자', exact: true }).click();
                await page.mouse.click(left + 8.5 * 1.25, top + 8.5 * 1.25);
                editor = page.getByRole('textbox', { name: /문자 입력/ });
                await editor.fill(
                    Array.from({ length: 40 }, (_, i) => 'line ' + i + ' abcdefghijklmnopqrstuvwxyz').join(
                        '\n',
                    ),
                );
                await editor.evaluate((e) => {
                    e.setSelectionRange(60, 66);
                    e.scrollTop = 48;
                    e.scrollLeft = 0;
                });
            }
            const pngBefore = await download(page, true);
            record.pngBeforeSha256 = hash(pngBefore);
            const pendingPixels = decodePng(pngBefore, webLimits).pixels;
            assert.notDeepEqual(
                pendingPixels,
                original.layers[0].pixels,
                'Pending fixture must visibly differ from original; an all-white move is not a geometry oracle',
            );
            if (kind === 'stationary-selection') {
                const expected = original.layers[0].pixels.slice();
                for (let y = 32; y < 36; y++)
                    for (let x = 32; x < 36; x++) expected.set([255, 255, 255, 255], (y * 64 + x) * 4);
                for (let y = 32; y < 36; y++)
                    for (let x = 33; x < 37; x++) expected.set([255, 0, 0, 255], (y * 64 + x) * 4);
                assert.deepEqual(
                    pendingPixels,
                    expected,
                    'Literal4x4 red marker shifts one pixel right before viewport changes',
                );
                record.pendingLiteralSha256 = hash(expected);
            }
            if (editor) {
                await editor.focus();
                record.editorBefore = await editor.evaluate((e) => ({
                    value: e.value,
                    width: e.clientWidth,
                    height: e.clientHeight,
                    start: e.selectionStart,
                    end: e.selectionEnd,
                    scrollTop: e.scrollTop,
                    scrollLeft: e.scrollLeft,
                }));
                assert(record.editorBefore.scrollTop > 0, 'Fixture must exercise nonzero editor scroll');
                await editor.dispatchEvent('compositionstart', { data: '한' });
            }
            for (const viewport of [
                { width: 390, height: 500 },
                { width: 320, height: 500 },
                { width: 360, height: 844 },
                { width: 844, height: 390 },
            ]) {
                await page.setViewportSize(viewport);
                await page.evaluate(
                    () =>
                        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
                );
                assert.equal(
                    await page.locator('#zoom').textContent(),
                    '125%',
                    'Manual zoom must not auto-fit on viewport change',
                );
                const dimensions = await canvasState(page);
                assert.deepEqual(
                    dimensions.backing,
                    dimensions.css.map((value) => Math.max(1, Math.round(value * dimensions.dpr))),
                );
                if (editor) {
                    const actual = await editor.evaluate((e) => ({
                        value: e.value,
                        width: e.clientWidth,
                        height: e.clientHeight,
                        start: e.selectionStart,
                        end: e.selectionEnd,
                        scrollTop: e.scrollTop,
                        scrollLeft: e.scrollLeft,
                    }));
                    assert.deepEqual(
                        actual,
                        record.editorBefore,
                        'Stationary editor value/client dimensions/caret/scroll must survive viewport change',
                    );
                    const visible = await editor.evaluate((e) => {
                        const r = e.getBoundingClientRect(),
                            w = e.closest('.workspace').getBoundingClientRect();
                        return {
                            left: r.left,
                            top: r.top,
                            right: r.right,
                            bottom: r.bottom,
                            width: r.width,
                            height: r.height,
                            workspace: {
                                left: w.left,
                                top: w.top,
                                right: w.right,
                                bottom: w.bottom,
                                width: w.width,
                                height: w.height,
                            },
                        };
                    });
                    assert(
                        visible.left >= visible.workspace.left - 0.01 &&
                            visible.top >= visible.workspace.top - 0.01,
                        'Text camera must keep leading edges visible',
                    );
                    if (visible.width <= visible.workspace.width)
                        assert(visible.right <= visible.workspace.right + 0.01);
                    else
                        assert(
                            visible.left <= visible.workspace.left + 16,
                            'Oversized editor prioritizes its leading edge instead of chasing the trailing edge',
                        );
                    if (visible.height <= visible.workspace.height)
                        assert(visible.bottom <= visible.workspace.bottom + 0.01);
                    await editor.press('Control+Enter');
                    assert(
                        await editor.isVisible(),
                        'Synthetic composition remains protected from commit across viewport change',
                    );
                }
            }
            if (editor) await editor.dispatchEvent('compositionend', { data: '한' });
            const pngAfter = await download(page, true);
            record.pngAfterSha256 = hash(pngAfter);
            assert.deepEqual(pngAfter, pngBefore, 'Stationary pending actual PNG must remain byte-exact');
            await page.locator('.workspace canvas').focus();
            await page.keyboard.press('Escape');
            assert.deepEqual(
                await download(page),
                original,
                'Cancel stationary pending restores original source',
            );
            assert(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled());
            record.ok = true;
            result.checks.push(name);
        } catch (error) {
            record.error = String(error.stack || error);
            result.failures.push({ name, error: record.error });
        } finally {
            await context.close();
        }
    }

    {
        const name = 'position-only-safe-area-swap-rolls-back',
            record = { name },
            context = await browser.newContext({
                viewport: { width: 1280, height: 800 },
                deviceScaleFactor: 1,
            });
        result.cases.push(record);
        try {
            const page = await boot(context);
            await page.locator('#app').evaluate((app) => {
                app.style.paddingLeft = '10px';
                app.style.paddingRight = '50px';
            });
            const { left, top } = await loadFixture(page);
            assert.deepEqual(await download(page), original);
            record.before = await canvasState(page);
            await page.mouse.move(left + 15.5, top + 15.5);
            await page.mouse.down();
            await page.mouse.move(left + 20.5, top + 15.5);
            // Equal total padding changes the public canvas origin, not its size.
            // This is controlled safe-area CSS emulation, not an OS inset event.
            await page.locator('#app').evaluate((app) => {
                app.style.paddingLeft = '50px';
                app.style.paddingRight = '10px';
            });
            record.moved = await canvasState(page);
            assert.deepEqual(record.moved.css, record.before.css, 'Fixture must preserve dimensions');
            assert.equal(
                record.moved.origin[0] - record.before.origin[0],
                40,
                'Fixture must move canvas origin40 CSSpx',
            );
            await page.mouse.up();
            await page.evaluate(
                () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            );
            assert.deepEqual(
                await download(page),
                original,
                'Origin-only change cancels provisional stroke before real mouse-up',
            );
            assert(
                await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled(),
                'Origin rollback preserves old Redo',
            );
            const target = await page.locator('.workspace canvas').evaluate((c) => {
                const r = c.getBoundingClientRect(),
                    pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                for (let y = 0; y < c.height; y++)
                    for (let x = 0; x < c.width; x++) {
                        const i = (y * c.width + x) * 4;
                        if (
                            pixels[i] === 255 &&
                            pixels[i + 1] === 0 &&
                            pixels[i + 2] === 0 &&
                            pixels[i + 3] === 255
                        )
                            return {
                                x: r.x + ((x + 8.5) * r.width) / c.width,
                                y: r.y + ((y + 0.5) * r.height) / c.height,
                            };
                    }
                throw Error('Displayed original red marker is required');
            });
            await page.mouse.click(target.x, target.y);
            const expected = {
                ...original,
                layers: original.layers.map((layer) => ({ ...layer, pixels: layer.pixels.slice() })),
            };
            expected.layers[0].pixels.set([22, 121, 234, 255], (32 * 64 + 40) * 4);
            assert.deepEqual(
                await download(page),
                expected,
                'First next visual gesture after origin move maps to literal pixel',
            );
            await command(page, '실행 취소');
            assert.deepEqual(await download(page), original, 'One Undo restores the origin-safe retry');
            record.ok = true;
            result.checks.push(name);
        } catch (error) {
            record.error = String(error.stack || error);
            result.failures.push({ name, error: record.error });
        } finally {
            await context.close();
        }
    }
    {
        const name = 'manual-touch-tablet-forced-scrollbar-gutter',
            record = { name, states: [] },
            context = await browser.newContext({
                viewport: { width: 768, height: 1024 },
                deviceScaleFactor: 1,
                hasTouch: false,
                isMobile: false,
            });
        result.cases.push(record);
        try {
            const page = await boot(context);
            await preferences(page, 'Classic 98', true);
            await page.addStyleTag({
                content:
                    '.tools { overflow-y: scroll !important; scrollbar-gutter: stable !important; } .tools::-webkit-scrollbar { width:17px !important; }',
            });
            record.gutter = await page.locator('.tools').evaluate((nav) => {
                const r = nav.getBoundingClientRect(),
                    button = nav.querySelector('button'),
                    b = button.getBoundingClientRect(),
                    left = r.left + nav.clientLeft,
                    right = left + nav.clientWidth;
                return {
                    rail: r.width,
                    clientWidth: nav.clientWidth,
                    scrollWidth: nav.scrollWidth,
                    reserved: r.width - nav.clientWidth,
                    buttonWidth: b.width,
                    shownWidth: Math.max(0, Math.min(b.right, right) - Math.max(b.left, left)),
                    columns: getComputedStyle(nav.parentElement).gridTemplateColumns,
                    density: document.documentElement.dataset.density,
                    coarse: matchMedia('(any-pointer:coarse)').matches,
                };
            });
            assert.equal(record.gutter.density, 'touch');
            assert.equal(
                record.gutter.coarse,
                false,
                'Fixture is desktop manual touch, not physical coarse hardware',
            );
            assert(record.gutter.reserved >= 17, 'Forced gutter must actually reserve17 CSSpx');
            assert(record.gutter.rail >= 79, 'Rail must account for padding,48px control and17px gutter');
            assert(record.gutter.clientWidth >= 62);
            assert.equal(record.gutter.buttonWidth, 48);
            assert.equal(record.gutter.shownWidth, 48, 'Real client viewport must show all48px');
            await targets(page, '.tools button', record, 'forced-gutter-tool-hits');
            assert(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                'Forced gutter must not overflow the document',
            );
            record.ok = true;
            result.checks.push(name);
        } catch (error) {
            record.error = String(error.stack || error);
            result.failures.push({ name, error: record.error });
        } finally {
            await context.close();
        }
    }
} finally {
    clearTimeout(watchdog);
    await browser.close();
    result.ok = result.checks.length === 20 && !result.errors.length && !result.failures.length;
    await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ output, ok: result.ok, checks: result.checks, failures: result.failures }));
    if (!result.ok) process.exitCode = 1;
}
