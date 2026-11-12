import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsers } from 'prettier/plugins/postcss';

// Static scope/cascade guards, not a substitute for the rendered browser contract.
type CssNode = {
    type: string;
    raws?: { selector?: string };
    nodes?: CssNode[];
    prop?: string;
    value?: { text?: string };
    name?: string;
    params?: { value?: string };
};
const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
const tree = (await parsers.css.parse(css, {} as Parameters<typeof parsers.css.parse>[1])) as CssNode;
const rules: { selector: string; media: string; declarations: Record<string, string> }[] = [];
function collect(node: CssNode, media = ''): void {
    if (node.type === 'css-atrule' && node.name === 'media') media = node.params?.value || '';
    if (node.type === 'css-rule') {
        const declarations = Object.fromEntries(
            (node.nodes || [])
                .filter((child) => child.type === 'css-decl')
                .map((child) => [child.prop!, child.value?.text || '']),
        );
        for (const selector of (node.raws?.selector || '').split(','))
            rules.push({ selector: selector.trim(), media, declarations });
    }
    for (const child of node.nodes || []) collect(child, media);
}
collect(tree);
const root = ":root[data-skin='classic']";
function rule(selector: string, media = ''): Record<string, string> {
    const found = rules.find((entry) => entry.selector === root + selector && entry.media === media);
    assert(found, `Missing Classic 98 rule: ${selector} (${media})`);
    return found.declarations;
}

test('Classic 98 remains scoped CSS without replacing layout or loading remote assets', () => {
    const classicRules = rules.filter((entry) => entry.selector.includes('data-skin'));
    assert(classicRules.length > 40);
    for (const entry of classicRules) {
        assert(entry.selector.startsWith(root), entry.selector);
        for (const property of ['display', 'grid-template-columns', 'grid-template-rows', 'order'])
            assert(!(property in entry.declarations), `${entry.selector}: ${property}`);
    }
    assert(!/@import\b/.test(css));
    assert(!/url\(['"]?https?:/.test(css));
    assert.equal(rule('')['--panel'], '#c0c0c0');
    assert.equal(rule('')['--accent'], '#000080');
    assert.equal(rule('')['--bg'], '#808080');
});

test('Classic 98 canvas hit areas stay transparent and preserve geometry', () => {
    for (const state of ['', ':hover', ':active']) {
        const handle = rule(' .canvas-handle' + state);
        assert.equal(handle.background, 'transparent');
        assert.equal(handle['box-shadow'], 'none');
        assert.equal(handle.border, '0');
        for (const property of ['width', 'height', 'min-width', 'min-height', 'transform'])
            assert(!(property in handle));
    }
    assert.equal(rule(' button:not(.canvas-handle)')['box-shadow'], 'var(--classic-raised)');
});

test('Classic 98 palette preserves real colors through pressed and focused states', () => {
    assert.equal(rule(' .swatches button').background, 'var(--swatch)');
    assert.equal(rule(' .swatches button:not(:disabled):active').background, 'var(--swatch)');
    const focus = rule(' .swatches button:focus-visible');
    assert.match(focus.outline, /dotted #000/);
    assert.match(focus['box-shadow'], /#fff/);
    assert.match(focus['box-shadow'], /#000/);
    assert.equal(
        rule(' .swatches button:not(:disabled):active:focus-visible')['box-shadow'],
        focus['box-shadow'],
    );
});

test('Classic 98 disabled fields override white input surfaces', () => {
    const disabled = rule(" input:not([type='range']):not([type='checkbox']):disabled");
    assert.equal(disabled['background-color'], 'var(--panel)');
    assert.equal(disabled.color, '#808080');
    assert.equal(rule(' button:disabled').opacity, '1');
});

test('Classic 98 forced colors keep borders, checkboxes, sliders and selection visible', () => {
    const media = '(forced-colors: active)';
    assert.equal(
        rule(" input:not([type='range']):not([type='checkbox'])", media).border,
        '1px solid ButtonText',
    );
    assert.equal(rule(' textarea:not(.text-editor)', media).border, '1px solid ButtonText');
    const checkbox = rule(" input[type='checkbox']", media);
    assert.equal(checkbox.appearance, 'auto');
    assert.equal(checkbox['background-image'], 'none');
    assert.equal(rule(" input[type='checkbox']:checked", media)['background-image'], 'none');
    for (const pseudo of [
        '::-webkit-slider-runnable-track',
        '::-webkit-slider-thumb',
        '::-moz-range-track',
        '::-moz-range-thumb',
    ]) {
        const slider = rule(" input[type='range']" + pseudo, media);
        assert.equal(slider.border, '1px solid ButtonText');
        assert.equal(slider['box-shadow'], 'none');
    }
    assert.equal(rule(' .layer-row.selected .name', media).color, 'HighlightText');
});
