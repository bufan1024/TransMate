import assert from 'node:assert/strict';
import test from 'node:test';

import { selectionStorageKey } from '../lib/selection.js';

const settings = {
  provider: 'custom',
  endpoint: 'https://example.com/v1/chat/completions',
  apiKey: 'test-key',
  model: 'test-model',
  targetLanguage: 'zh-CN',
  prompt: '',
};

function selection(windowId, id, text, order) {
  return { windowId, id, text, order, createdAt: Date.now() };
}

function fakeElement() {
  const listeners = new Map();
  return {
    value: '', textContent: '', hidden: false, disabled: false, style: {},
    addEventListener(type, listener) {
      const list = listeners.get(type) || [];
      list.push(listener);
      listeners.set(type, list);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
    },
  };
}

async function mountPanel({ windowId = 7, store = new Map(), delayedSnapshot = false,
  delayedWindow = false, snapshotOverride = null, delayedRemovalKey = null } = {}) {
  const previous = { document: globalThis.document, chrome: globalThis.chrome, fetch: globalThis.fetch };
  const elements = new Map();
  const requests = [];
  const removed = [];
  let onChanged;
  let releaseSnapshot;
  let releaseWindow;
  let releaseRemoval;

  globalThis.document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, fakeElement());
      return elements.get(selector);
    },
  };
  globalThis.chrome = {
    runtime: { openOptionsPage() {} },
    permissions: { contains: async () => true },
    windows: {
      getCurrent: async () => delayedWindow
        ? new Promise((resolve) => { releaseWindow = () => resolve({ id: windowId }); })
        : { id: windowId },
    },
    storage: {
      local: { setAccessLevel: async () => {}, get: async () => ({ settings }) },
      session: {
        get: async () => {
          const snapshot = snapshotOverride ?? Object.fromEntries(store);
          if (!delayedSnapshot) return snapshot;
          return new Promise((resolve) => { releaseSnapshot = () => resolve(snapshot); });
        },
        remove: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          removed.push(...list);
          if (list.includes(delayedRemovalKey)) {
            await new Promise((resolve) => { releaseRemoval = resolve; });
          }
          for (const key of list) store.delete(key);
        },
      },
      onChanged: { addListener(listener) { onChanged = listener; } },
    },
  };
  globalThis.fetch = async (_url, options) => {
    const text = JSON.parse(options.body).messages[1].content;
    requests.push({ text, options });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: `译:${text}` } }] }) };
  };

  await import(`../sidepanel.js?selection-test=${Math.random()}`);
  const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); };
  await flush();

  return {
    store, requests, removed, flush,
    element: (selector) => elements.get(selector),
    emit(value) {
      const key = selectionStorageKey(value.windowId, value.id);
      store.set(key, value);
      onChanged({ [key]: { newValue: value } }, 'session');
      return key;
    },
    releaseSnapshot() { releaseSnapshot?.(); },
    releaseWindow() { releaseWindow?.(); },
    releaseRemoval() { releaseRemoval?.(); },
    restore() {
      globalThis.document = previous.document;
      globalThis.chrome = previous.chrome;
      globalThis.fetch = previous.fetch;
    },
  };
}

test('a panel consumes only the latest selection for its window from a shared snapshot', async () => {
  const older = selection(7, 'old', 'Window A old', 100);
  const newer = selection(7, 'new', 'Window A new', 200);
  const other = selection(8, 'other', 'Window B', 300);
  const store = new Map([older, newer, other].map((value) => [selectionStorageKey(value.windowId, value.id), value]));
  const app = await mountPanel({ store });
  try {
    await app.flush();
    assert.deepEqual(app.requests.map(({ text }) => text), ['Window A new']);
    assert.equal(app.element('#source-text').value, 'Window A new');
    assert.equal(app.element('#result-text').textContent, '译:Window A new');
    assert.equal(store.has(selectionStorageKey(7, 'old')), false);
    assert.equal(store.has(selectionStorageKey(7, 'new')), false);
    assert.equal(store.has(selectionStorageKey(8, 'other')), true);
  } finally {
    app.restore();
  }

  const otherPanel = await mountPanel({ windowId: 8, store });
  try {
    await otherPanel.flush();
    assert.deepEqual(otherPanel.requests.map(({ text }) => text), ['Window B']);
    assert.equal(store.has(selectionStorageKey(8, 'other')), false);
  } finally {
    otherPanel.restore();
  }
});

test('a late startup snapshot cannot replace a newer storage event', async () => {
  const older = selection(7, 'old', 'Old', 100);
  const store = new Map([[selectionStorageKey(7, 'old'), older]]);
  const app = await mountPanel({ store, delayedSnapshot: true });
  try {
    app.emit(selection(7, 'new', 'New', 200));
    await app.flush();
    app.releaseSnapshot();
    await app.flush();
    assert.deepEqual(app.requests.map(({ text }) => text), ['New']);
    assert.equal(app.element('#source-text').value, 'New');
    assert.equal(store.has(selectionStorageKey(7, 'old')), false);
  } finally {
    app.restore();
  }
});

test('an event received before window lookup survives an empty startup snapshot', async () => {
  const app = await mountPanel({ delayedWindow: true, snapshotOverride: {} });
  try {
    app.emit(selection(7, 'early', 'Early', 100));
    app.emit(selection(8, 'foreign', 'Foreign', 200));
    app.releaseWindow();
    await app.flush();
    assert.deepEqual(app.requests.map(({ text }) => text), ['Early']);
    assert.equal(app.element('#source-text').value, 'Early');
    assert.equal(app.store.has(selectionStorageKey(8, 'foreign')), true);
  } finally {
    app.restore();
  }
});

test('deleting an older event cannot remove a newer event or trigger a duplicate request on reopen', async () => {
  const store = new Map();
  const olderKey = selectionStorageKey(7, 'old');
  const app = await mountPanel({ store, delayedRemovalKey: olderKey });
  try {
    app.emit(selection(7, 'old', 'Old', 100));
    await app.flush();
    app.emit(selection(7, 'new', 'New', 200));
    await app.flush();
    app.releaseRemoval();
    await app.flush();
    assert.deepEqual(app.requests.map(({ text }) => text), ['New']);
    assert.equal(store.size, 0);
    assert.deepEqual(app.removed.sort(), [olderKey, selectionStorageKey(7, 'new')].sort());
  } finally {
    app.restore();
  }

  const reopened = await mountPanel({ store });
  try {
    await reopened.flush();
    assert.equal(reopened.requests.length, 0);
  } finally {
    reopened.restore();
  }
});
