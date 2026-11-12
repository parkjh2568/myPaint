import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { decodeProject } from '../src/engine/format.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.PAINT_TEST_OUTPUT || '../build-web-work/task-planning/browser';
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAINT_BROWSER_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const results = { checks: [], errors: [], browser: browser.version() };
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
const page = await context.newPage();
page.on('pageerror', (e) => results.errors.push(e.message));
page.setDefaultTimeout(15000);
await page.addInitScript(() => {
    window.testBlobs = [];
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
        window.testBlobs.push(blob);
        return create(blob);
    };
});
async function snapshot(target = page) {
    await target.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await target.getByRole('button', { name: '파일 받기', exact: true }).waitFor();
    const data = await target.evaluate(async () =>
        Array.from(new Uint8Array(await window.testBlobs.at(-1).arrayBuffer())),
    );
    await target.getByRole('button', { name: '다운로드 닫기' }).click();
    return decodeProject(Uint8Array.from(data));
}
async function menu(name) {
    await page.getByRole('button', { name: '파일 및 편집 메뉴' }).click();
    await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
}
try {
    await page.goto(process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/');
    await page.getByRole('button', { name: '브러시', exact: true }).waitFor();
    await page.waitForSelector('canvas[data-ready=true]');
    await page.waitForFunction(() => {
        const c = document.querySelector('canvas'),
            p = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        return p.some((v, i) => i % 4 === 0 && v === 255 && p[i + 1] === 255 && p[i + 2] === 255);
    });
    const paper = await page.evaluate(() => {
        const c = document.querySelector('canvas'),
            ctx = c.getContext('2d'),
            p = ctx.getImageData(0, 0, c.width, c.height).data;
        let best = { x: 0, y: 0, length: 0 };
        const white = (x, y) => {
            const i = (y * c.width + x) * 4;
            return p[i] === 255 && p[i + 1] === 255 && p[i + 2] === 255;
        };
        for (let y = 0; y < c.height; y += 12) {
            let start = 0;
            for (let x = 0; x <= c.width; x++) {
                if (x < c.width && white(x, y)) continue;
                if (x - start > best.length) best = { x: start, y, length: x - start };
                start = x + 1;
            }
        }
        let y = best.y;
        while (y > 0 && white((best.x + best.length / 2) | 0, y - 1)) y--;
        const r = c.getBoundingClientRect();
        return { x: r.x + (best.x * r.width) / c.width, y: r.y + (y * r.height) / c.height };
    });
    await page.mouse.move(paper.x + 40, paper.y + 70);
    await page.mouse.down();
    for (let x = 50; x <= 260; x += 10)
        await page.mouse.move(paper.x + x, paper.y + 70 + Math.sin(x / 30) * 15);
    await page.mouse.up();
    const drawn = await snapshot();
    assert.equal(drawn.width, 800);
    const i = (70 * 800 + 40) * 4;
    assert.deepEqual([...drawn.layers[0].pixels.subarray(i, i + 4)], [22, 121, 234, 255]);
    results.checks.push('Actual stroke and rpaint exported pixels');
    await page.getByRole('button', { name: '실행 취소', exact: true }).press('Enter');
    const undone = await snapshot();
    assert.notDeepEqual(undone.layers[0].pixels, drawn.layers[0].pixels);
    await page.getByRole('button', { name: '다시 실행', exact: true }).press('Space');
    assert.deepEqual((await snapshot()).layers[0].pixels, drawn.layers[0].pixels);
    results.checks.push('Downloads preserve Undo/Redo');
    const studioLayout = await page.locator('.body').evaluate((body) => ({
        columns: getComputedStyle(body).gridTemplateColumns,
        children: [...body.children].map((child) => child.className),
        tools: [...body.querySelectorAll('[data-tool]')].map((button) => button.dataset.tool),
    }));
    await page.getByRole('button', { name: '환경설정', exact: true }).click();
    await page.getByLabel('스킨', { exact: true }).selectOption('Classic 98');
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.skin === 'classic');
    assert.deepEqual((await snapshot()).layers[0].pixels, drawn.layers[0].pixels);
    results.checks.push('Skin changes preserve exact pixels');
    assert.deepEqual(
        await page.locator('.body').evaluate((body) => ({
            columns: getComputedStyle(body).gridTemplateColumns,
            children: [...body.children].map((child) => child.className),
            tools: [...body.querySelectorAll('[data-tool]')].map((button) => button.dataset.tool),
        })),
        studioLayout,
    );
    for (const handle of await page.locator('.canvas-handle').all()) {
        const style = await handle.evaluate((element) => {
            const css = getComputedStyle(element);
            return { background: css.backgroundColor, shadow: css.boxShadow, border: css.borderTopWidth };
        });
        assert.deepEqual(style, { background: 'rgba(0, 0, 0, 0)', shadow: 'none', border: '0px' });
    }
    results.checks.push('Classic skin retains layout/tool order and invisible canvas resize hit areas');
    const palette = await page.locator('.swatches button').evaluateAll((buttons) =>
        buttons.map((button) => ({
            label: button.getAttribute('aria-label'),
            background: getComputedStyle(button).backgroundColor,
        })),
    );
    assert.equal(palette.length, 16);
    for (const swatch of palette) {
        const hex = swatch.label.slice(-7),
            rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        assert.equal(swatch.background, `rgb(${rgb.join(', ')})`, swatch.label);
    }
    for (const hex of ['#000000', '#ffffff']) {
        const swatch = page.getByRole('button', { name: '전경색 ' + hex, exact: true });
        await swatch.focus();
        await page.keyboard.down('Space');
        const pressed = await swatch.evaluate((element) => {
            const css = getComputedStyle(element);
            return {
                active: element.matches(':active'),
                background: css.backgroundColor,
                image: css.backgroundImage,
                outline: css.outlineStyle,
                shadow: css.boxShadow,
            };
        });
        await page.keyboard.up('Space');
        assert.equal(pressed.active, true);
        assert.equal(pressed.background, hex === '#000000' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)');
        assert.equal(pressed.image, 'none');
        assert.equal(pressed.outline, 'dotted');
        assert.match(pressed.shadow, /rgb\(255, 255, 255\)/);
        assert.match(pressed.shadow, /rgb\(0, 0, 0\)/);
    }
    await page.emulateMedia({ forcedColors: 'active' });
    assert.equal(
        await page.locator('#pressure').evaluate((element) => getComputedStyle(element).backgroundImage),
        'none',
    );
    const forcedField = await page.locator('#hex').evaluate((element) => {
        const css = getComputedStyle(element);
        return { border: css.borderTopWidth, color: css.borderTopColor, style: css.borderTopStyle };
    });
    assert.equal(forcedField.border, '1px');
    assert.equal(forcedField.style, 'solid');
    assert.notEqual(forcedField.color, 'rgba(0, 0, 0, 0)');
    await page.emulateMedia({ forcedColors: 'none' });
    results.checks.push(
        'Classic palette stays true while Space-pressed; focus and forced-color fields remain visible',
    );
    await page.getByRole('button', { name: '전경색 #8058e8', exact: true }).press('Enter');
    assert.equal(await page.getByLabel('HEX 색상', { exact: true }).inputValue(), '#8058e8');
    await page.getByRole('button', { name: '전경색 #1679ea', exact: true }).press('Space');
    assert.equal(await page.getByLabel('HEX 색상', { exact: true }).inputValue(), '#1679ea');
    results.checks.push('Classic palette displays its labeled colors and supports Enter/Space selection');
    const roundValues = await page.evaluate(() =>
        Object.fromEntries(
            ['size', 'opacity', 'hardness', 'stabilization', 'pressure', 'square'].map((id) => {
                const input = document.getElementById(id);
                return [id, input.type === 'checkbox' ? input.checked : input.value];
            }),
        ),
    );
    await page.getByRole('button', { name: '연필', exact: true }).click();
    for (const id of Object.keys(roundValues)) assert.equal(await page.locator('#' + id).isDisabled(), true);
    assert.equal(await page.locator('#size').inputValue(), '1');
    assert.equal(await page.locator('#size-value').textContent(), '1 px');
    assert.match(await page.locator('.square-hint').textContent(), /연필은 1px/);
    await page.locator('.workspace canvas').focus();
    await page.keyboard.press(']');
    await page.getByRole('button', { name: '브러시', exact: true }).click();
    for (const [id, value] of Object.entries(roundValues)) {
        const input = page.locator('#' + id);
        assert.equal(await input.isDisabled(), false);
        assert.equal(typeof value === 'boolean' ? await input.isChecked() : await input.inputValue(), value);
    }
    assert.equal(await page.locator('.square-hint').isVisible(), false);
    results.checks.push('Pencil shows fixed 1px options and preserves round settings through size shortcuts');
    const fileChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '파일 열기', exact: true }).click();
    await (
        await fileChooser
    ).setFiles({
        name: 'broken.rpaint',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from('RPAINT01bad'),
    });
    await page
        .getByRole('status')
        .filter({ hasText: /프로젝트|잘린/ })
        .waitFor();
    assert.deepEqual((await snapshot()).layers[0].pixels, drawn.layers[0].pixels);
    results.checks.push('Malformed file preserves current document');
    await menu('새 그림');
    await page.getByLabel('너비', { exact: true }).fill('64');
    await page.getByLabel('높이', { exact: true }).fill('64');
    await page.getByLabel('배경', { exact: true }).selectOption('투명');
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '저장하지 않고 버리기', exact: true }).click();
    const transparent = await snapshot();
    assert.equal(transparent.width, 64);
    assert(transparent.layers[0].pixels.every((v) => v === 0));
    results.checks.push('New transparent document exports real alpha');
    const small = await page.locator('.workspace canvas').boundingBox();
    const origin = { x: small.x + small.width / 2 - 32, y: small.y + small.height / 2 - 32 };
    await page.getByRole('button', { name: '사각 선택', exact: true }).click();
    await page.mouse.move(origin.x + 4, origin.y + 4);
    await page.mouse.down();
    await page.mouse.move(origin.x + 12, origin.y + 12);
    await page.mouse.up();
    assert.match(await page.locator('.title').textContent(), /편집 중/);
    await page.getByRole('button', { name: '전경색 #35b69a', exact: true }).press('Enter');
    assert.equal(await page.getByLabel('HEX 색상', { exact: true }).inputValue(), '#35b69a');
    assert.match(await page.locator('.title').textContent(), /편집 중/);
    await page.locator('.workspace canvas').focus();
    await page.keyboard.press('Enter');
    assert.doesNotMatch(await page.locator('.title').textContent(), /편집 중/);
    assert.deepEqual((await snapshot()).layers[0].pixels, transparent.layers[0].pixels);
    await page.getByRole('button', { name: '전경색 #1679ea', exact: true }).press('Space');
    results.checks.push('Focused palette Enter preserves pending selection; canvas Enter settles it');
    await page.getByRole('button', { name: '브러시', exact: true }).click();
    await page.mouse.move(origin.x + 10, origin.y + 14);
    await page.mouse.down();
    await page.mouse.move(origin.x + 30, origin.y + 14, { steps: 5 });
    await page.mouse.up();
    await page.getByRole('button', { name: '사각 선택', exact: true }).click();
    await page.mouse.move(origin.x + 1, origin.y + 1);
    await page.mouse.down();
    await page.mouse.move(origin.x + 40, origin.y + 32);
    await page.mouse.up();
    await menu('선택 크기');
    await page.getByLabel('너비', { exact: true }).fill('16');
    await page.getByLabel('높이', { exact: true }).fill('12');
    await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
    const pendingSelection = await snapshot();
    assert(pendingSelection.layers[0].pixels.some((v, i) => i % 4 === 3 && v > 0));
    await page.evaluate(() => {
        window.originalClipboard = navigator.clipboard;
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
                write: async () => {
                    throw new DOMException('Clipboard denied', 'NotAllowedError');
                },
            },
        });
    });
    await menu('잘라내기');
    await page.getByRole('status').filter({ hasText: 'Clipboard denied' }).waitFor();
    assert.deepEqual((await snapshot()).layers[0].pixels, pendingSelection.layers[0].pixels);
    await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: window.originalClipboard,
        });
    });
    results.checks.push('Resized pending selection survives denied clipboard cut');
    await page.locator('.workspace canvas').focus();
    await page.keyboard.press('Enter');
    assert.deepEqual((await snapshot()).layers[0].pixels, pendingSelection.layers[0].pixels);
    await page.getByRole('button', { name: '문자', exact: true }).click();
    await page.mouse.click(origin.x + 5, origin.y + 30);
    const editor = page.getByRole('textbox', { name: /문자 입력/ });
    await editor.fill('한글 A');
    await editor.evaluate((e) => e.dispatchEvent(new CompositionEvent('compositionstart', { data: '글' })));
    await page.getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '문자 조합을 먼저 확정하세요.' }).waitFor();
    assert.equal(await editor.inputValue(), '한글 A');
    await editor.evaluate((e) => e.dispatchEvent(new CompositionEvent('compositionend', { data: '글' })));
    const textSnapshot = await snapshot();
    assert.notDeepEqual(textSnapshot.layers[0].pixels, pendingSelection.layers[0].pixels);
    assert.equal(await editor.count(), 1);
    await editor.focus();
    await page.keyboard.press('Control+Enter');
    assert.deepEqual((await snapshot()).layers[0].pixels, textSnapshot.layers[0].pixels);
    results.checks.push('IME pending text blocks save and export preserves text until commit');
    await page.screenshot({ path: output + '/desktop.png' });
    const mobile = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
    });
    await mobile.addInitScript(() => {
        window.testBlobs = [];
        const create = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => {
            window.testBlobs.push(blob);
            return create(blob);
        };
    });
    const phone = await mobile.newPage();
    phone.on('pageerror', (e) => results.errors.push(e.message));
    await phone.goto(process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/');
    await phone.getByRole('button', { name: '브러시', exact: true }).waitFor();
    await phone.getByRole('button', { name: '색상과 브러시' }).click();
    await phone.getByRole('button', { name: '패널 닫기' }).click();
    const canvas = await phone.locator('.workspace canvas').boundingBox();
    assert(canvas.width >= 380 && canvas.height > 600 && canvas.x + canvas.width <= 390);
    for (const width of [320, 360, 390]) {
        await phone.setViewportSize({ width, height: 844 });
        const save = await phone
            .getByRole('button', { name: '프로젝트 저장 또는 다운로드', exact: true })
            .boundingBox();
        assert(save.x >= 0 && save.x + save.width <= width, `save button clipped at ${width}px`);
        assert(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.screenshot({ path: output + '/mobile.png' });
    results.checks.push('390px mobile workspace and touch panels accessible');
    assert.equal(await phone.evaluate(() => !!window.__TAURI__), false);
    const beforeTouch = await snapshot(phone),
        cdp = await mobile.newCDPSession(phone),
        x = Math.round(canvas.x + 120),
        y = Math.round(canvas.y + canvas.height / 2);
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, id: 1, force: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + 20, y, id: 1, force: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
            { x: x + 20, y, id: 1, force: 1 },
            { x: x + 100, y: y + 20, id: 2, force: 1 },
        ],
    });
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
            { x: x + 10, y, id: 1, force: 1 },
            { x: x + 130, y: y + 20, id: 2, force: 1 },
        ],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    assert.deepEqual((await snapshot(phone)).layers[0].pixels, beforeTouch.layers[0].pixels);
    results.checks.push('Mobile browser two-finger navigation cancels provisional finger stroke');
    await mobile.close();
    const tabletContext = await browser.newContext({
        viewport: { width: 1024, height: 768 },
        hasTouch: true,
        deviceScaleFactor: 2,
    });
    const tablet = await tabletContext.newPage();
    tablet.on('pageerror', (error) => results.errors.push(error.message));
    await tablet.goto(process.env.PAINT_TEST_URL || 'http://127.0.0.1:8922/');
    await tablet.waitForSelector('canvas[data-ready=true]');
    assert.equal(await tablet.evaluate(() => document.documentElement.dataset.density), 'touch');
    const tabletCanvas = await tablet.locator('.workspace canvas').boundingBox();
    assert(tabletCanvas.width > 600 && tabletCanvas.height > 500);
    await tablet.screenshot({ path: output + '/tablet.png' });
    await tabletContext.close();
    results.checks.push('Tablet web layout uses touch density without a native runtime');
    assert.deepEqual(results.errors, []);
} catch (error) {
    results.failure = String(error.stack || error);
    await page.screenshot({ path: output + '/failure.png' }).catch(() => {});
    throw error;
} finally {
    await fs.writeFile(output + '/results.json', JSON.stringify(results, null, 2));
    await browser.close();
}
console.log(JSON.stringify(results, null, 2));
