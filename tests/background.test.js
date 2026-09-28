import test from 'node:test';
import assert from 'node:assert/strict';
import { registerBackground } from '../background.js';

function fakeChrome() {
  const listeners = {};
  const calls = { menus: [], behavior: [], writes: [], opens: [] };
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
    storage: { session: { set: (value) => { calls.writes.push(value); return Promise.resolve(); } } },
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
  assert.equal(calls.writes[0].pendingSelection.text, 'Hello world');
  assert.equal(calls.writes[0].pendingSelection.windowId, 7);
  assert.ok(calls.writes[0].pendingSelection.id);
  assert.equal(typeof calls.writes[0].pendingSelection.createdAt, 'number');
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
