import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { decodeProject, encodePng } from '../src/engine/format.ts';
import { createState } from '../src/engine/document.ts';
import { resizeState } from '../src/engine/operations.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.PAINT_EDITING_OUTPUT || '../build-web-work/task-planning/editing.json';
await fs.mkdir(path.dirname(output), { recursive: true });
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const result = { checks: [], errors: [], browser: browser.version() };
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
let page = await context.newPage();
page.setDefaultTimeout(15000);
page.on('pageerror', (error) => result.errors.push(error.message));
const captureDownloads = () => {
    window.editingBlobs = [];
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
        window.editingBlobs.push(blob);
        return create(blob);
    };
};
await page.addInitScript(captureDownloads);
async function menu(name) {
    await page.getByRole('button', { name: '파일 및 편집 메뉴', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
}
async function snapshot() {
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.getByRole('button', { name: '파일 받기', exact: true }).waitFor();
    const bytes = await page.evaluate(async () =>
        Array.from(new Uint8Array(await window.editingBlobs.at(-1).arrayBuffer())),
    );
    await page.getByRole('button', { name: '다운로드 닫기', exact: true }).click();
    return decodeProject(Uint8Array.from(bytes));
}
async function origin(size = 64) {
    await page.getByRole('button', { name: '화면에 맞추기', exact: true }).click();
    const box = await page.locator('.workspace canvas').boundingBox();
    return { x: box.x + box.width / 2 - size / 2, y: box.y + box.height / 2 - size / 2 };
}
async function pendingPolygon() {
    await page.getByRole('button', { name: '다각형', exact: true }).click();
    const paper = await origin();
    for (const [x, y] of [
        [8, 8],
        [30, 8],
        [30, 30],
    ])
        await page.mouse.click(paper.x + x, paper.y + y);
    return snapshot();
}
async function resize(width, height) {
    await menu('이미지 크기');
    await page.getByLabel('너비', { exact: true }).fill(String(width));
    await page.getByLabel('높이', { exact: true }).fill(String(height));
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
}
try {
    await page.goto(process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/');
    await page.waitForSelector('canvas[data-ready=true]');
    await menu('새 그림');
    await page.getByLabel('너비', { exact: true }).fill('64');
    await page.getByLabel('높이', { exact: true }).fill('64');
    await page.getByLabel('배경', { exact: true }).selectOption('투명');
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
    const blank = await snapshot();
    const polygon = await pendingPolygon();
    assert(polygon.layers[0].pixels.some((value, index) => index % 4 === 3 && value > 0));
    await resize(128, 128);
    const expected = resizeState(polygon, 128, 128, true, false);
    assert.deepEqual((await snapshot()).layers[0].pixels, expected.layers[0].pixels);
    await page.locator('.workspace canvas').focus();
    await page.keyboard.press('Enter');
    assert.deepEqual((await snapshot()).layers[0].pixels, expected.layers[0].pixels);
    await page.getByRole('button', { name: '실행 취소', exact: true }).click();
    assert.deepEqual(await snapshot(), blank);
    result.checks.push('Pending polygon resizes exactly once and one Undo restores the original document');
    const originalPolygon = await pendingPolygon();
    await menu('문서 지우기 바탕');
    await page.getByLabel('바탕', { exact: true }).selectOption('색상');
    await page.getByLabel('색상', { exact: true }).fill('#eaf1ff');
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
    const changedBackground = await snapshot();
    assert.deepEqual(changedBackground.background, [234, 241, 255, 255]);
    assert.deepEqual(changedBackground.layers[0].pixels, originalPolygon.layers[0].pixels);
    await page.locator('.workspace canvas').focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await snapshot(), changedBackground);
    await page.getByRole('button', { name: '실행 취소', exact: true }).click();
    assert.deepEqual(await snapshot(), blank);
    result.checks.push('Background change commits a pending polygon once without repainting existing pixels');
    await page.getByRole('button', { name: '곡선', exact: true }).click();
    const paper = await origin();
    await page.mouse.move(paper.x + 8, paper.y + 40);
    await page.mouse.down();
    await page.mouse.move(paper.x + 40, paper.y + 10);
    await page.mouse.up();
    await page.mouse.click(paper.x + 12, paper.y + 8);
    const curve = await snapshot();
    await resize(4096, 4096);
    await page.getByRole('status').filter({ hasText: /한도/ }).waitFor();
    assert.deepEqual(await snapshot(), curve);
    result.checks.push('Rejected image dimensions preserve the pending curve and document');
    await resize(96, 64);
    const expectedCurve = resizeState(curve, 96, 64, true, false);
    assert.deepEqual((await snapshot()).layers[0].pixels, expectedCurve.layers[0].pixels);
    await page.locator('.workspace canvas').focus();
    await page.keyboard.press('Enter');
    assert.deepEqual((await snapshot()).layers[0].pixels, expectedCurve.layers[0].pixels);
    await page.getByRole('button', { name: '실행 취소', exact: true }).click();
    assert.deepEqual(await snapshot(), blank);
    result.checks.push('Partially controlled pending curve resizes once with a single atomic Undo');
    await menu('새 그림');
    await page.getByLabel('너비', { exact: true }).fill('64');
    await page.getByLabel('높이', { exact: true }).fill('64');
    await page.getByLabel('배경', { exact: true }).selectOption('투명');
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
    await page.getByRole('button', { name: '곡선', exact: true }).click();
    const retryPaper = await origin();
    await page.mouse.move(retryPaper.x + 8, retryPaper.y + 40);
    await page.mouse.down();
    await page.mouse.move(retryPaper.x + 40, retryPaper.y + 10);
    await page.mouse.up();
    await page.mouse.click(retryPaper.x + 12, retryPaper.y + 8);
    const beforeFailure = await snapshot();
    await page.evaluate(() => {
        const proto = OffscreenCanvasRenderingContext2D.prototype;
        window.originalShapeReadback = proto.getImageData;
        window.rejectNextShapeReadback = true;
        proto.getImageData = function (...args) {
            if (window.rejectNextShapeReadback) {
                window.rejectNextShapeReadback = false;
                throw Error('Injected shape readback failure');
            }
            return window.originalShapeReadback.apply(this, args);
        };
    });
    await page.mouse.click(retryPaper.x + 38, retryPaper.y + 42);
    await page.getByRole('status').filter({ hasText: 'Injected shape readback failure' }).waitFor();
    assert.deepEqual(await snapshot(), beforeFailure);
    await page.mouse.click(retryPaper.x + 38, retryPaper.y + 42);
    const retriedCurve = await snapshot();
    assert.notDeepEqual(retriedCurve.layers[0].pixels, beforeFailure.layers[0].pixels);
    await page.getByRole('button', { name: '실행 취소', exact: true }).click();
    assert.deepEqual(await snapshot(), blank);
    assert.equal(await page.getByRole('button', { name: '다시 실행', exact: true }).isEnabled(), true);
    await page.getByRole('button', { name: '다시 실행', exact: true }).click();
    assert.deepEqual(await snapshot(), retriedCurve);
    await page.evaluate(() => {
        OffscreenCanvasRenderingContext2D.prototype.getImageData = window.originalShapeReadback;
    });
    result.checks.push(
        'Failed second curve control readback preserves pending shape and permits a committed retry',
    );

    await page.getByRole('button', { name: '문자', exact: true }).click();
    const textPaper = await origin();
    await page.mouse.click(textPaper.x + 2, textPaper.y + 2);
    const editor = page.getByRole('textbox', { name: /문자 입력/ });
    await editor.fill('x'.repeat(65536));
    await editor.evaluate((element) => element.setSelectionRange(0, element.value.length));
    await page.evaluate(() => {
        window.originalEditingClipboard = navigator.clipboard;
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { readText: async () => '가' },
        });
    });
    await menu('붙여넣기');
    await page.waitForFunction(() => document.querySelector('.text-editor')?.value === '가');
    result.checks.push('Text paste replaces a selected maximum-length value using the resulting length');

    await editor.fill('기존 문자');
    await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
                readText: () =>
                    new Promise((resolve) => {
                        window.finishTextPaste = resolve;
                    }),
            },
        });
    });
    await menu('붙여넣기');
    await page.waitForFunction(() => typeof window.finishTextPaste === 'function');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('textbox', { name: /문자 입력/ }).count(), 0);
    await page.getByRole('button', { name: '문자', exact: true }).click();
    await page.mouse.click(textPaper.x + 16, textPaper.y + 16);
    const replacementEditor = page.getByRole('textbox', { name: /문자 입력/ });
    await replacementEditor.fill('새 문자');
    await page.evaluate(() => window.finishTextPaste('늦은 붙여넣기'));
    assert.equal(await replacementEditor.inputValue(), '새 문자');
    await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: window.originalEditingClipboard,
        });
    });
    result.checks.push('Late text clipboard resolution cannot mutate a replacement editor');
    const touchContext = await browser.newContext({
        viewport: { width: 1400, height: 1000 },
        hasTouch: true,
    });
    page = await touchContext.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => result.errors.push(error.message));
    await page.addInitScript(captureDownloads);
    await page.goto(process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/');
    await page.waitForSelector('canvas[data-ready=true]');
    await menu('새 그림');
    await page.getByLabel('너비', { exact: true }).fill('64');
    await page.getByLabel('높이', { exact: true }).fill('64');
    await page.getByLabel('배경', { exact: true }).selectOption('투명');
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
    const touchPaper = await origin();
    await page.getByRole('button', { name: '브러시', exact: true }).click();
    await page.mouse.move(touchPaper.x + 10, touchPaper.y + 14);
    await page.mouse.down();
    await page.mouse.move(touchPaper.x + 30, touchPaper.y + 14);
    await page.mouse.up();
    await page.getByRole('button', { name: '사각 선택', exact: true }).click();
    await page.mouse.move(touchPaper.x + 1, touchPaper.y + 1);
    await page.mouse.down();
    await page.mouse.move(touchPaper.x + 48, touchPaper.y + 40);
    await page.mouse.up();
    const beforeTouch = await snapshot();
    const cdp = await touchContext.newCDPSession(page);
    for (const drag of [
        { name: 'move', x: 20, y: 15, endX: 30, endY: 15 },
        { name: 'resize', x: 47, y: 39, endX: 58, endY: 55 },
    ]) {
        const first = {
            x: Math.round(touchPaper.x + drag.x),
            y: Math.round(touchPaper.y + drag.y),
            id: 1,
            force: 1,
        };
        const moved = {
            ...first,
            x: Math.round(touchPaper.x + drag.endX),
            y: Math.round(touchPaper.y + drag.endY),
        };
        const second = {
            x: Math.round(touchPaper.x + 130),
            y: Math.round(touchPaper.y + 20),
            id: 2,
            force: 1,
        };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [moved] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [moved, second] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        assert.deepEqual(await snapshot(), beforeTouch);
        result.checks.push(`Two-finger navigation restores a provisional selection ${drag.name}`);
    }
    await page.getByRole('button', { name: '곡선', exact: true }).click();
    await page.mouse.move(touchPaper.x + 8, touchPaper.y + 55);
    await page.mouse.down();
    await page.mouse.move(touchPaper.x + 55, touchPaper.y + 8);
    await page.mouse.up();
    await page.mouse.click(touchPaper.x + 12, touchPaper.y + 8);
    const beforeControlTakeover = await snapshot();
    const control = { x: Math.round(touchPaper.x + 48), y: Math.round(touchPaper.y + 48), id: 1, force: 1 };
    const second = { x: Math.round(touchPaper.x + 130), y: Math.round(touchPaper.y + 20), id: 2, force: 1 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [control] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [control, second] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    assert.deepEqual(await snapshot(), beforeControlTakeover);
    result.checks.push('Two-finger takeover cannot commit a pending second curve control');
    await page.keyboard.press('Escape');
    const beforePreset = await pendingPolygon();
    await page.getByRole('button', { name: '픽셀', exact: true }).click();
    assert.equal(
        await page.getByRole('button', { name: '연필', exact: true }).getAttribute('aria-pressed'),
        'true',
    );
    assert.deepEqual(await snapshot(), beforePreset);
    await page.getByRole('button', { name: '실행 취소', exact: true }).click();
    assert.deepEqual(await snapshot(), beforeTouch);
    result.checks.push(
        'Pixel preset settles a pending polygon before switching tools and preserves one Undo',
    );
    await menu('활성 레이어 지우기');
    await page.getByRole('dialog').getByRole('button', { name: '지우기', exact: true }).click();
    const cleared = await snapshot();
    await page.getByRole('button', { name: '채우기', exact: true }).click();
    await page.mouse.click(touchPaper.x + 32, touchPaper.y + 32);
    const beforeLasso = await snapshot();
    assert(beforeLasso.layers[0].pixels.every((value, index) => index % 4 !== 3 || value === 255));
    await page.getByRole('button', { name: '자유 선택', exact: true }).click();
    await page.mouse.move(touchPaper.x + 5, touchPaper.y + 5);
    await page.mouse.down();
    for (const [x, y] of [
        [40, 10],
        [10, 40],
        [5, 5],
    ]) {
        await page.mouse.move(touchPaper.x + x, touchPaper.y + y, { steps: 7 });
    }
    await page.mouse.up();
    await page.keyboard.press('ArrowRight');
    const movedLasso = await snapshot();
    assert(movedLasso.layers[0].pixels.some((value, index) => index % 4 === 3 && value === 0));
    assert(
        movedLasso.layers[0].pixels.every((value, index) => index % 4 !== 3 || value === 0 || value === 255),
    );
    await page.keyboard.press('ArrowLeft');
    assert.deepEqual(await snapshot(), beforeLasso);
    await page.locator('.workspace canvas').focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await snapshot(), beforeLasso);
    await page.getByRole('button', { name: '실행 취소', exact: true }).click();
    assert.deepEqual(await snapshot(), cleared);
    result.checks.push(
        'Lasso movement has a discrete alpha mask and a return to origin is an exact pixel and history no-op',
    );

    const hidden = createState(64, 64, [0, 0, 0, 0]);
    for (let index = 0; index < hidden.layers[0].pixels.length; index += 4) {
        hidden.layers[0].pixels.set([17, 91, 203, 0], index);
    }
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '파일 열기', exact: true }).click();
    await (
        await chooser
    ).setFiles({
        name: 'hidden-rgb.png',
        mimeType: 'image/png',
        buffer: Buffer.from(encodePng(hidden.width, hidden.height, hidden.layers[0].pixels)),
    });
    await page.getByRole('dialog').getByRole('button', { name: '저장하지 않고 버리기', exact: true }).click();
    const loadedHidden = await snapshot();
    assert.deepEqual(loadedHidden.layers[0].pixels, hidden.layers[0].pixels);
    await page.getByRole('button', { name: '문자', exact: true }).click();
    const hiddenPaper = await origin();
    await page.mouse.click(hiddenPaper.x + 8, hiddenPaper.y + 8);
    const hiddenEditor = page.getByRole('textbox', { name: /문자 입력/ });
    await hiddenEditor.fill('L');
    const textOverHidden = await snapshot();
    assert(textOverHidden.layers[0].pixels.some((value, index) => index % 4 === 3 && value > 0));
    for (let index = 0; index < textOverHidden.layers[0].pixels.length; index += 4) {
        if (textOverHidden.layers[0].pixels[index + 3] === 0) {
            assert.deepEqual(
                [...textOverHidden.layers[0].pixels.subarray(index, index + 4)],
                [17, 91, 203, 0],
            );
        }
    }
    await hiddenEditor.focus();
    await page.keyboard.press('Control+Enter');
    assert.deepEqual((await snapshot()).layers[0].pixels, textOverHidden.layers[0].pixels);
    await page.getByRole('button', { name: '실행 취소', exact: true }).click();
    assert.deepEqual(await snapshot(), loadedHidden);
    result.checks.push(
        'Text overlay preserves hidden RGB bytes in unpainted transparent pixels through commit and Undo',
    );
    await touchContext.close();
    assert.deepEqual(result.errors, []);
} catch (error) {
    result.failure = String(error.stack || error);
    throw error;
} finally {
    await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
    await browser.close();
}
console.log(JSON.stringify(result, null, 2));
