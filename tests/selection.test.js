import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSelections, selectionStorageKey, selectionStoragePrefix, shouldAcceptSelection } from '../lib/selection.js';

const now = 1_800_000_000_000;
const selection = { id: 'request-1', text: 'Hello', windowId: 4, createdAt: now - 1000 };

test('accepts only a recent selection from the same window', () => {
  assert.equal(shouldAcceptSelection(selection, 4, now), true);
  assert.equal(shouldAcceptSelection(selection, 5, now), false);
  assert.equal(shouldAcceptSelection({ ...selection, createdAt: now - 30_001 }, 4, now), false);
  assert.equal(shouldAcceptSelection({ ...selection, createdAt: now + 1 }, 4, now), false);
});

test('rejects incomplete or empty selections', () => {
  assert.equal(shouldAcceptSelection(null, 4, now), false);
  assert.equal(shouldAcceptSelection({ ...selection, id: '' }, 4, now), false);
  assert.equal(shouldAcceptSelection({ ...selection, text: '  ' }, 4, now), false);
  assert.equal(shouldAcceptSelection({ ...selection, windowId: undefined }, 4, now), false);
  assert.equal(shouldAcceptSelection(selection, undefined, now), false);
});

test('selection keys isolate windows and events, and order breaks same-millisecond ties', () => {
  assert.equal(selectionStorageKey(4, 'request-1'), 'pendingSelection:4:request-1');
  assert.equal(selectionStoragePrefix(4), 'pendingSelection:4:');
  assert.notEqual(selectionStorageKey(4, 'request-1'), selectionStorageKey(5, 'request-1'));
  assert.notEqual(selectionStorageKey(4, 'request-1'), selectionStorageKey(4, 'request-2'));
  assert.ok(compareSelections({ ...selection, order: 100 }, { ...selection, id: 'request-2', order: 101 }) < 0);
});
