import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PaintDocument, createState, cloneState, type Color } from '../src/engine/document';

interface Input {
    fill: Color;
    opacity: number;
    hardness: number;
    stabilization: number;
    right: boolean;
    square: boolean;
    redoSeed: boolean;
    tablet: boolean;
    pressure: number;
    zoom: number;
    aliases: [number, number, ...Color][];
}
interface QtCase {
    name: string;
    from: [number, number];
    to: [number, number];
    thickness: number;
    foregroundRGBA: Color;
    targetRGBA: Color;
    keyPremultipliedRGBA: Color;
    targetPremultipliedRGBA: Color;
    changedRows: [number, number, number][];
    changedCount: number;
    committedDuringDrag: boolean;
    visibilityBefore: boolean;
    pendingVisibility: boolean;
    visibilityAfter: boolean;
    dirty: boolean;
    canUndo: boolean;
    canRedoBefore: boolean;
    canRedoAfter: boolean;
    cancel: boolean;
    undoExact?: boolean;
    undoClean?: boolean;
    redoExact?: boolean;
    observedTargetStraightRGBA: Color | null;
    input: Partial<Input>;
}
const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/color-eraser-qt.json', import.meta.url), 'utf8'),
) as {
    width: number;
    height: number;
    generatorSha256: string;
    defaults: Input;
    cases: QtCase[];
};

test('the compact Qt oracle retains its reproducible generator identity and all 18 captures', () => {
    // Generator preserved in Git c10a29a; frozen expectations do not require its SDK.
    assert.equal(fixture.generatorSha256, '81c7544efd0fd153b66f2a94d339ce7d3249f7fea82e0a43256615884d2e4a44');
    assert.equal(fixture.cases.length, 18);
    assert.equal(new Set(fixture.cases.map((entry) => entry.name)).size, 18);
});

for (const captured of fixture.cases)
    test(`real Qt color eraser: ${captured.name}`, () => {
        const input = { ...fixture.defaults, ...captured.input },
            state = createState(fixture.width, fixture.height, input.fill);
        state.layers[0].visible = captured.visibilityBefore;
        for (const [x, y, ...color] of input.aliases)
            state.layers[0].pixels.set(color, (y * fixture.width + x) * 4);
        const doc = new PaintDocument(state);
        let redoState;
        if (input.redoSeed) {
            const candidate = cloneState(doc.state);
            candidate.layers[0].pixels.set([255, 255, 0, 255], (22 * fixture.width + 30) * 4);
            doc.commitState('redo seed', candidate);
            redoState = cloneState(doc.state);
            doc.undo();
        }
        const original = cloneState(doc.state),
            revision = doc.revision,
            savedRevision = doc.savedRevision;
        assert.equal(doc.canRedo, captured.canRedoBefore);
        assert.deepEqual(
            captured.foregroundRGBA.map((value, channel) =>
                channel === 3 ? value : Math.round((value * captured.foregroundRGBA[3]) / 255),
            ),
            captured.keyPremultipliedRGBA,
        );
        // Right-button routing belongs to the UI. Qt's captured right case uses the same key/target.
        doc.beginStroke(
            ...captured.from,
            {
                color: captured.targetRGBA,
                matchColor: captured.foregroundRGBA,
                size: captured.thickness,
                opacity: input.opacity / 100,
                hardness: input.hardness / 100,
                stabilization: input.stabilization,
                square: input.square,
                eraser: false,
                pressure: input.tablet,
            },
            input.pressure,
        );
        doc.moveStroke(...captured.to, input.pressure);
        assert.equal(captured.committedDuringDrag, false);
        assert.equal(doc.revision, revision);
        assert.equal(doc.savedRevision, savedRevision);
        assert.equal(doc.state.layers[0].visible, captured.pendingVisibility);
        if (captured.cancel) doc.cancelStroke();
        else doc.endStroke(...captured.to);

        const expected = cloneState(original);
        let count = 0;
        for (const [y, left, right] of captured.changedRows)
            for (let x = left; x <= right; x++) {
                expected.layers[0].pixels.set(captured.targetRGBA, (y * fixture.width + x) * 4);
                count++;
            }
        assert.equal(count, captured.changedCount);
        expected.layers[0].visible = captured.visibilityAfter;
        // Full raw equality also checks every untouched pixel, including alpha-zero hidden RGB.
        assert.deepEqual(doc.state, expected);
        if (count) {
            assert.deepEqual(
                captured.targetRGBA.map((value, channel) =>
                    channel === 3 ? value : Math.round((value * captured.targetRGBA[3]) / 255),
                ),
                captured.targetPremultipliedRGBA,
            );
            // Qt pixelColor unpremultiplies; the raw model intentionally keeps the exact input target.
            if (captured.targetRGBA[3] === 128)
                assert.deepEqual(captured.observedTargetStraightRGBA, [78, 143, 219, 128]);
        }
        assert.equal(doc.dirty, captured.dirty);
        assert.equal(doc.canUndo, captured.canUndo);
        assert.equal(doc.canRedo, captured.canRedoAfter);
        assert.equal(doc.savedRevision, savedRevision);
        assert.equal(doc.state.active, original.active);
        if (captured.canUndo) {
            assert.equal(captured.undoExact, true);
            assert.equal(captured.undoClean, true);
            assert.equal(captured.redoExact, true);
            assert.equal(doc.history.length, 1);
            const afterRevision = doc.revision;
            assert.notEqual(afterRevision, revision);
            doc.undo();
            assert.deepEqual(doc.state, original);
            assert.equal(doc.revision, revision);
            assert.equal(doc.dirty, false);
            assert.equal(doc.canUndo, false);
            doc.redo();
            assert.deepEqual(doc.state, expected);
            assert.equal(doc.revision, afterRevision);
        } else {
            assert.equal(doc.revision, revision);
            assert.deepEqual(doc.state, original);
            if (redoState) {
                doc.redo();
                assert.deepEqual(doc.state, redoState);
                doc.undo();
                assert.deepEqual(doc.state, original);
                assert.equal(doc.dirty, false);
            }
        }
    });
