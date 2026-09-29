import test from 'node:test';
import assert from 'node:assert/strict';
import { registerBackground } from '../background.js';
import { selectionStorageKey } from '../lib/selection.js';

function fakeChrome(stored = {}) {
  const listeners = {};
  const calls = { menus: [], behavior: [], writes: [], opens: [], removals: [] };
  const api = {
    runtime: { onInstalled: { addListener: (fn) => { listeners.installed = fn; } } },
    contextMenus: {
      create: (item) => { calls.menus.push(item); },
      onClicked: { addListener: (fn) => { listeners.clicked = fn; } },
    },
    sidePanel: {
      setPanelBehavior: (behavior) => { calls.behavior.push(behavior); return Promise.resolve(); },
      open: (target) => { calls.opens.push(target); return Promise.resolve(); },
    },
    storage: { session: {
      set: (value) => { calls.writes.push(value); return Promise.resolve(); },
      get: async () => stored,
      remove: async (keys) => { calls.removals.push(keys); },
    } },
  };
  return { api, calls, listeners };
}

test('installs a selection-only translation menu and opens the panel from the toolbar', () => {
  const { api, calls, listeners } = fakeChrome();
  registerBackground(api);
  listeners.installed();
  assert.deepEqual(calls.menus, [{ id: 'translate-selection', title: '用 TransMate 翻译', contexts: ['selection'] }]);
  assert.deepEqual(calls.behavior, [{ openPanelOnActionClick: true }]);
});

test('right-click translation hands selected text to the side panel', () => {
  const { api, calls, listeners } = fakeChrome();
  registerBackground(api);
  listeners.clicked({ menuItemId: 'translate-selection', selectionText: '  Hello world  ' }, { windowId: 7 });
  assert.equal(calls.writes.length, 1);
  const [key, selection] = Object.entries(calls.writes[0])[0];
  assert.equal(key, selectionStorageKey(7, selection.id));
  assert.equal(selection.text, 'Hello world');
  assert.equal(selection.windowId, 7);
  assert.ok(selection.id);
  assert.equal(typeof selection.createdAt, 'number');
  assert.equal(Number.isSafeInteger(selection.order), true);
  assert.deepEqual(calls.opens, [{ windowId: 7 }]);
});

test('rapid selections in two windows keep distinct keys and their click order', () => {
  const { api, calls, listeners } = fakeChrome();
  registerBackground(api);
  listeners.clicked({ menuItemId: 'translate-selection', selectionText: 'Window A' }, { windowId: 7 });
  listeners.clicked({ menuItemId: 'translate-selection', selectionText: 'Window B' }, { windowId: 8 });
  listeners.clicked({ menuItemId: 'translate-selection', selectionText: 'Window A newer' }, { windowId: 7 });

  assert.equal(calls.writes.length, 3);
  const entries = calls.writes.map((write) => Object.entries(write)[0]);
  assert.equal(new Set(entries.map(([key]) => key)).size, 3);
  assert.deepEqual(entries.map(([, selection]) => selection.windowId), [7, 8, 7]);
  assert.deepEqual(entries.map(([, selection]) => selection.text), ['Window A', 'Window B', 'Window A newer']);
  assert.ok(entries[0][1].order < entries[1][1].order);
  assert.ok(entries[1][1].order < entries[2][1].order);
  assert.deepEqual(calls.opens, [{ windowId: 7 }, { windowId: 8 }, { windowId: 7 }]);
});

test('new clicks remove expired selection keys without touching recent events', async () => {
  const now = Date.now();
  const old = { id: 'old', text: 'Old', windowId: 7, createdAt: now - 30_001 };
  const recent = { id: 'recent', text: 'Recent', windowId: 8, createdAt: now };
  const oldKey = selectionStorageKey(7, old.id);
  const recentKey = selectionStorageKey(8, recent.id);
  const { api, calls, listeners } = fakeChrome({ [oldKey]: old, [recentKey]: recent });
  registerBackground(api);
  listeners.clicked({ menuItemId: 'translate-selection', selectionText: 'New' }, { windowId: 7 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.removals, [[oldKey]]);
  assert.deepEqual(calls.opens, [{ windowId: 7 }]);
});

test('ignores unrelated clicks and empty selections', () => {
  const { api, calls, listeners } = fakeChrome();
  registerBackground(api);
  listeners.clicked({ menuItemId: 'other', selectionText: 'Hello' }, { windowId: 7 });
  listeners.clicked({ menuItemId: 'translate-selection', selectionText: '   ' }, { windowId: 7 });
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(calls.opens, []);
});
