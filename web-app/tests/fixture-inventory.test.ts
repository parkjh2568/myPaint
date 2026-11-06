import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { toolDefinitions } from '../src/ui/icons';

test('legacy reference inventory retains all fixes, tool inputs, policy owners and frozen data', () => {
    const root = new URL('../../', import.meta.url),
        inventory = JSON.parse(
            readFileSync(new URL('./fixtures/legacy-contracts.json', import.meta.url), 'utf8'),
        );
    assert.equal(inventory.schema, 1);
    assert.deepEqual(
        inventory.fixes.map((entry: { id: string }) => entry.id).sort(),
        Array.from({ length: 10 }, (_, index) => 'F' + String(index + 1).padStart(2, '0')),
    );
    assert.deepEqual(
        inventory.tools.map((entry: { id: string }) => entry.id).sort(),
        toolDefinitions.map(([id]) => id).sort(),
    );
    assert.deepEqual(
        inventory.domains.map((entry: { id: string }) => entry.id).sort(),
        [
            'layers',
            'undo',
            'pending-selection',
            'pending-text',
            'storage-failure',
            'clipboard-recovery',
        ].sort(),
    );
    for (const entry of [...inventory.fixes, ...inventory.tools, ...inventory.domains]) {
        assert(entry.input && entry.expected && entry.deferred, entry.id);
        assert(entry.policies.length > 0, entry.id);
        for (const policy of entry.policies) assert(inventory.policies[policy], `${entry.id}: ${policy}`);
        assert(
            entry.references.some((ref: { role: string }) => ref.role === 'legacy-input-and-assertion'),
            entry.id,
        );
        assert(
            entry.references.some((ref: { role: string }) => ref.role === 'studio-consumer'),
            entry.id,
        );
        for (const reference of entry.references) {
            assert(!reference.path.includes('..') && /^(tests|web-app\/tests)\//.test(reference.path));
            assert.equal(typeof reference.anchor, 'string');
            assert(reference.anchor.length > 0);
            const text = readFileSync(new URL(reference.path, root), 'utf8');
            assert(text.includes(reference.anchor), `${entry.id}: missing reference ${reference.anchor}`);
        }
    }
    for (const data of inventory.data) {
        assert(data.path.startsWith('web-app/tests/') && !data.path.includes('..'));
        const bytes = readFileSync(new URL(data.path, root));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), data.sha256, data.path);
        assert(data.kind && data.scope, data.path);
    }
    assert(
        inventory.formats.validProject &&
            inventory.formats.independentWire &&
            inventory.formats.malformed &&
            inventory.formats.transparentPng,
    );
});
