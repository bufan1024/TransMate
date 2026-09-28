import test from 'node:test';
import assert from 'node:assert/strict';
import { registerBackground } from '../background.js';
import { selectionStorageKey } from '../lib/selection.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('background event did not reach the expected state');
}

function fakeChrome({
  settings = { apiKey: 'private-test-key' }, session = {}, inject, storageAccessError = false,
} = {}) {
  const sessionState = { ...session };
  const listeners = {};
  const calls = {
    menus: [], behavior: [], accessLevels: [], injections: [], messages: [],
    writes: [], opens: [], removals: [], options: 0,
  };
  const api = {
    runtime: {
      onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
      openOptionsPage: async () => { calls.options += 1; },
    },
    contextMenus: {
      create: (item) => { calls.menus.push(item); },
      onClicked: { addListener: (fn) => { listeners.clicked = fn; } },
    },
    sidePanel: {
      setPanelBehavior: (value) => { calls.behavior.push(value); return Promise.resolve(); },
      open: (value) => { calls.opens.push(value); return Promise.resolve(); },
    },
    storage: {
      local: {
        setAccessLevel: async (value) => {
          calls.accessLevels.push(value);
          if (storageAccessError) throw new Error('access level denied');
        },
        get: async () => ({ settings }),
      },
      session: {
        set: async (value) => { calls.writes.push(value); Object.assign(sessionState, value); },
        get: async (keys) => {
          if (keys === null) return { ...sessionState };
          if (typeof keys === 'string') return keys in sessionState ? { [keys]: sessionState[keys] } : {};
          if (Array.isArray(keys)) return Object.fromEntries(keys
            .filter((key) => key in sessionState).map((key) => [key, sessionState[key]]));
          return { ...sessionState };
        },
        remove: async (value) => {
          calls.removals.push(value);
          for (const key of Array.isArray(value) ? value : [value]) delete sessionState[key];
        },
      },
      onChanged: { addListener: (fn) => { listeners.storageChanged = fn; } },
    },
    scripting: {
      executeScript: async (details) => {
        calls.injections.push(details);
        if (inject) return inject(details);
        const frameId = details.target.frameIds[0];
        return [{ frameId, documentId: 'doc-' + details.target.tabId + '-' + frameId }];
      },
    },
    tabs: {
      sendMessage: async (tabId, message, options) => {
        calls.messages.push({ tabId, message, options });
        return { ok: true };
      },
      onRemoved: { addListener: (fn) => { listeners.removed = fn; } },
      onUpdated: { addListener: (fn) => { listeners.updated = fn; } },
    },
    permissions: { contains: async () => true },
  };
  return { api, calls, listeners, sessionState };
}

const tab = (id = 17, windowId = 7, url = 'https://example.test/article') => ({ id, windowId, url });
const selected = (text, frameId = 0) => ({
  menuItemId: 'translate-selection', selectionText: text, frameId,
});
const sender = (id = 17, frameId = 0, documentId = 'doc-' + id + '-' + frameId) => ({
  tab: { id }, frameId, documentId,
});
const messages = (calls, type) => calls.messages.filter(({ message }) => message.type === type);

test('installs selection menu, preserves toolbar side panel, and protects local settings', () => {
  const { api, calls, listeners } = fakeChrome();
  registerBackground(api);
  listeners.installed();
  assert.deepEqual(calls.menus, [
    { id: 'translate-selection', title: '用 TransMate 翻译', contexts: ['selection'] },
  ]);
  assert.deepEqual(calls.behavior, [{ openPanelOnActionClick: true }]);
  assert.deepEqual(calls.accessLevels, [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
});

test('right-click uses inline SHOW and RESULT without opening panel or leaking API Key', async () => {
  const settings = { apiKey: 'very-private-key', endpoint: 'https://api.example.test/chat/completions' };
  const translated = [];
  const { api, calls } = fakeChrome({ settings });
  const router = registerBackground(api, {
    translateImpl: async (request) => { translated.push(request); return '你好，世界'; },
  });
  await router.onClicked(selected('  Hello world  ', 2), tab());

  assert.deepEqual(calls.injections, [{
    target: { tabId: 17, frameIds: [2] }, files: ['content-script.js'],
  }]);
  const [show] = messages(calls, 'TRANSMATE_INLINE_SHOW');
  const [result] = messages(calls, 'TRANSMATE_INLINE_RESULT');
  assert.equal(show.message.text, 'Hello world');
  assert.equal(result.message.translation, '你好，世界');
  assert.equal(result.message.requestId, show.message.requestId);
  assert.deepEqual(show.options, { documentId: 'doc-17-2' });
  assert.deepEqual(result.options, show.options);
  assert.equal(translated[0].settings, settings);
  assert.equal(translated[0].text, 'Hello world');
  assert.equal(translated[0].permissionsApi, api.permissions);
  assert.deepEqual(calls.opens, []);
  assert.equal(calls.writes.length, 1);
  assert.ok(Object.keys(calls.writes[0])[0].startsWith('inlineSelection:17:'));
  assert.equal(JSON.stringify(calls.writes).includes(settings.apiKey), false);
  assert.equal(JSON.stringify(calls.messages).includes(settings.apiKey), false);
});

test('restricted page falls back to panel with the selected text', async () => {
  const { api, calls } = fakeChrome();
  const router = registerBackground(api);
  await router.onClicked(selected('  Translate me  '), tab(17, 7, 'chrome://settings'));
  assert.deepEqual(calls.injections, []);
  assert.deepEqual(calls.messages, []);
  assert.deepEqual(calls.opens, [{ windowId: 7 }]);
  const [key, pending] = Object.entries(calls.writes[0])[0];
  assert.equal(key, selectionStorageKey(7, pending.id));
  assert.equal(pending.text, 'Translate me');
  assert.equal(pending.windowId, 7);
});

test('unknown tab URL falls back while the context-menu gesture is active', async () => {
  const { api, calls } = fakeChrome();
  const router = registerBackground(api);
  await router.onClicked(selected('Unknown page'), { id: 17, windowId: 7 });
  assert.deepEqual(calls.injections, []);
  assert.deepEqual(calls.opens, [{ windowId: 7 }]);
});

test('inaccessible child frame falls back to a top-frame inline card', async () => {
  const { api, calls } = fakeChrome({
    inject: async ({ target }) => {
      const frameId = target.frameIds[0];
      if (frameId === 5) throw new Error('child frame denied');
      return [{ frameId, documentId: 'top-doc' }];
    },
  });
  const router = registerBackground(api, { translateImpl: async () => '译文' });
  await router.onClicked(selected('Embedded text', 5), tab());
  assert.deepEqual(calls.injections.map(({ target }) => target.frameIds), [[5], [0]]);
  assert.equal(messages(calls, 'TRANSMATE_INLINE_SHOW')[0].message.text, 'Embedded text');
  assert.deepEqual(messages(calls, 'TRANSMATE_INLINE_SHOW')[0].options, { documentId: 'top-doc' });
  assert.deepEqual(calls.opens, []);
});

test('top-frame injection failure falls back to the panel', async () => {
  const { api, calls } = fakeChrome({ inject: async () => { throw new Error('denied'); } });
  const router = registerBackground(api);
  await router.onClicked(selected('Fallback text'), tab());
  assert.equal(messages(calls, 'TRANSMATE_INLINE_SHOW').length, 0);
  assert.deepEqual(calls.opens, [{ windowId: 7 }]);
  assert.equal(Object.values(calls.writes[0])[0].text, 'Fallback text');
});

test('failure to protect local credentials prevents content-script injection', async () => {
  const { api, calls } = fakeChrome({ storageAccessError: true });
  const router = registerBackground(api);
  await router.onClicked(selected('Sensitive selection'), tab());
  assert.deepEqual(calls.injections, []);
  assert.deepEqual(calls.opens, [{ windowId: 7 }]);
});

test('new selection cancels the earlier request; late result cannot replace it', async () => {
  const pending = [];
  const { api, calls } = fakeChrome();
  const router = registerBackground(api, {
    translateImpl: ({ text, signal }) => {
      const task = deferred();
      pending.push({ text, signal, ...task });
      return task.promise;
    },
  });
  const first = router.onClicked(selected('First'), tab());
  await waitFor(() => pending.length === 1);
  const firstId = messages(calls, 'TRANSMATE_INLINE_SHOW')[0].message.requestId;
  const second = router.onClicked(selected('Second'), tab());
  await waitFor(() => pending.length === 2);
  const secondId = messages(calls, 'TRANSMATE_INLINE_SHOW')[1].message.requestId;
  assert.equal(pending[0].signal.aborted, true);
  assert.notEqual(firstId, secondId);
  assert.deepEqual(messages(calls, 'TRANSMATE_INLINE_HIDE').map(({ message }) => message.requestId), [firstId]);
  pending[1].resolve('Second translated');
  await second;
  pending[0].resolve('Stale translated');
  await first;
  assert.deepEqual(messages(calls, 'TRANSMATE_INLINE_RESULT').map(({ message }) =>
    [message.requestId, message.translation]), [[secondId, 'Second translated']]);
  assert.deepEqual(calls.opens, []);
});

test('only matching tab, frame, document and request can cancel', async () => {
  const pending = deferred();
  let signal;
  const { api, calls } = fakeChrome();
  const router = registerBackground(api, {
    translateImpl: ({ signal: requestSignal }) => {
      signal = requestSignal;
      return pending.promise;
    },
  });
  const running = router.onClicked(selected('Cancel me'), tab());
  await waitFor(() => Boolean(signal));
  const requestId = router.activeByTab.get(17).requestId;
  const wrong = [
    [requestId, sender(99)],
    [requestId, sender(17, 1)],
    [requestId, sender(17, 0, 'wrong-doc')],
    ['old-id', sender()],
  ];
  for (const [id, source] of wrong) {
    await router.onMessage({ type: 'TRANSMATE_INLINE_CANCEL', requestId: id }, source);
    assert.equal(signal.aborted, false);
    assert.equal(router.activeByTab.has(17), true);
  }
  await router.onMessage({ type: 'TRANSMATE_INLINE_CANCEL', requestId }, sender());
  assert.equal(signal.aborted, true);
  assert.equal(router.activeByTab.has(17), false);
  pending.resolve('Too late');
  await running;
  assert.deepEqual(messages(calls, 'TRANSMATE_INLINE_RESULT'), []);
});

test('only matching sender may retry or open options, and retry gets a new ID', async () => {
  const { api, calls } = fakeChrome();
  const router = registerBackground(api, { translateImpl: async ({ text }) => '译文:' + text });
  await router.onClicked(selected('Again'), tab());
  const firstId = router.activeByTab.get(17).requestId;
  await router.onMessage({ type: 'TRANSMATE_INLINE_RETRY', requestId: firstId }, sender(17, 0, 'wrong-doc'));
  await router.onMessage({ type: 'TRANSMATE_INLINE_RETRY', requestId: 'old-id' }, sender());
  await router.onMessage({ type: 'TRANSMATE_INLINE_OPEN_OPTIONS' }, sender(99));
  assert.equal(messages(calls, 'TRANSMATE_INLINE_SHOW').length, 1);
  assert.equal(calls.options, 0);

  await router.onMessage({ type: 'TRANSMATE_INLINE_RETRY', requestId: firstId }, sender());
  const secondId = router.activeByTab.get(17).requestId;
  assert.notEqual(secondId, firstId);
  assert.equal(messages(calls, 'TRANSMATE_INLINE_SHOW').length, 2);
  assert.deepEqual(messages(calls, 'TRANSMATE_INLINE_RESULT').at(-1).message, {
    type: 'TRANSMATE_INLINE_RESULT', requestId: secondId, translation: '译文:Again',
  });
  await router.onMessage({ type: 'TRANSMATE_INLINE_OPEN_OPTIONS', requestId: secondId }, sender());
  assert.equal(calls.options, 1);
});

test('retry restores the selected text after the service worker loses memory', async () => {
  const { api, calls, sessionState } = fakeChrome();
  const firstWorker = registerBackground(api, { translateImpl: async () => '第一次译文' });
  await firstWorker.onClicked(selected('Persisted text'), tab());
  const firstId = firstWorker.activeByTab.get(17).requestId;
  assert.ok(Object.keys(sessionState).some((key) => key.endsWith(firstId)));

  const restartedWorker = registerBackground(api, { translateImpl: async ({ text }) => `重试:${text}` });
  assert.equal(restartedWorker.activeByTab.size, 0);
  await restartedWorker.onMessage({ type: 'TRANSMATE_INLINE_RETRY', requestId: firstId }, sender());
  const shows = messages(calls, 'TRANSMATE_INLINE_SHOW');
  const latest = shows.at(-1).message;
  assert.equal(latest.text, 'Persisted text');
  assert.equal(latest.retryOf, firstId);
  assert.notEqual(latest.requestId, firstId);
  assert.equal(messages(calls, 'TRANSMATE_INLINE_RESULT').at(-1).message.translation, '重试:Persisted text');
  assert.equal(Object.keys(sessionState).some((key) => key.endsWith(firstId)), false);
  assert.equal(calls.opens.length, 0);
});

test('a new selection after worker restart removes the old session selection', async () => {
  const { api, sessionState } = fakeChrome();
  const firstWorker = registerBackground(api, { translateImpl: async () => 'First result' });
  await firstWorker.onClicked(selected('First source'), tab());
  assert.deepEqual(Object.values(sessionState).filter((value) => value?.text === 'First source').length, 1);

  const restartedWorker = registerBackground(api, { translateImpl: async () => 'Second result' });
  await restartedWorker.onClicked(selected('Second source'), tab());
  const selections = Object.values(sessionState).filter((value) => value?.requestId && value?.tabId === 17);
  assert.deepEqual(selections.map(({ text }) => text), ['Second source']);
});

test('closing while retry SHOW is pending cannot reopen the card or send a new request', async () => {
  const { api, calls } = fakeChrome();
  let translations = 0;
  const router = registerBackground(api, {
    translateImpl: async () => { translations += 1; return '译文'; },
  });
  await router.onClicked(selected('Race'), tab());
  const firstId = router.activeByTab.get(17).requestId;
  const showStarted = deferred();
  const releaseShow = deferred();
  const originalSend = api.tabs.sendMessage;
  api.tabs.sendMessage = async (tabId, message, options) => {
    if (message.type === 'TRANSMATE_INLINE_SHOW' && message.retryOf === firstId) {
      showStarted.resolve();
      await releaseShow.promise;
    }
    return originalSend(tabId, message, options);
  };
  const retrying = router.onMessage({ type: 'TRANSMATE_INLINE_RETRY', requestId: firstId }, sender());
  await showStarted.promise;
  const retryId = router.activeByTab.get(17).requestId;
  await router.onMessage({ type: 'TRANSMATE_INLINE_CANCEL', requestId: firstId }, sender());
  assert.equal(router.activeByTab.has(17), false);
  releaseShow.resolve();
  await retrying;
  assert.equal(translations, 1);
  assert.ok(messages(calls, 'TRANSMATE_INLINE_HIDE').some(({ message }) => message.requestId === retryId));
});

test('configuration change during injection shows an error without starting an old request', async () => {
  const injected = deferred();
  const releaseInjection = deferred();
  const { api, calls, listeners } = fakeChrome({
    inject: async ({ target }) => {
      injected.resolve();
      await releaseInjection.promise;
      return [{ frameId: target.frameIds[0], documentId: 'doc-17-0' }];
    },
  });
  let translations = 0;
  const router = registerBackground(api, {
    translateImpl: async () => { translations += 1; return '旧译文'; },
  });
  const clicking = router.onClicked(selected('Old settings'), tab());
  await injected.promise;
  listeners.storageChanged({ settings: { newValue: { model: 'new' } } }, 'local');
  releaseInjection.resolve();
  await clicking;
  assert.equal(translations, 0);
  assert.equal(messages(calls, 'TRANSMATE_INLINE_SHOW').length, 1);
  assert.deepEqual(messages(calls, 'TRANSMATE_INLINE_RESULT').map(({ message }) => message.error),
    ['翻译配置已更新，请重试。']);
});

test('settings change invalidates a card after worker restart', async () => {
  const { api, calls, listeners } = fakeChrome();
  const firstWorker = registerBackground(api, { translateImpl: async () => 'Old translation' });
  await firstWorker.onClicked(selected('Old source'), tab());
  const requestId = firstWorker.activeByTab.get(17).requestId;

  registerBackground(api, { translateImpl: async () => 'New translation' });
  listeners.storageChanged({ settings: { newValue: { model: 'new' } } }, 'local');
  await waitFor(() => messages(calls, 'TRANSMATE_INLINE_INVALIDATE').length === 1);
  assert.equal(messages(calls, 'TRANSMATE_INLINE_INVALIDATE')[0].message.requestId, requestId);
});

test('settings change aborts translation and its late result cannot overwrite the error', async () => {
  const pending = deferred();
  let signal;
  const { api, calls, listeners } = fakeChrome();
  const router = registerBackground(api, {
    translateImpl: ({ signal: requestSignal }) => {
      signal = requestSignal;
      return pending.promise;
    },
  });
  const running = router.onClicked(selected('Old model'), tab());
  await waitFor(() => Boolean(signal));
  const requestId = router.activeByTab.get(17).requestId;
  listeners.storageChanged({ settings: { newValue: { model: 'new-model' } } }, 'local');
  assert.equal(signal.aborted, true);
  assert.deepEqual(messages(calls, 'TRANSMATE_INLINE_INVALIDATE').map(({ message }) => message), [{
    type: 'TRANSMATE_INLINE_INVALIDATE', requestId,
    error: '翻译配置已更新，请重试。',
  }]);
  pending.resolve('Old model result');
  await running;
  assert.equal(messages(calls, 'TRANSMATE_INLINE_RESULT').length, 0);
});

test('background timeout ends a translation that ignores abort', async () => {
  let signal;
  const { api, calls } = fakeChrome();
  const router = registerBackground(api, {
    timeoutMs: 10,
    translateImpl: ({ signal: requestSignal }) => {
      signal = requestSignal;
      return new Promise(() => {});
    },
  });
  await router.onClicked(selected('Slow service'), tab());
  assert.equal(signal.aborted, true);
  assert.deepEqual(messages(calls, 'TRANSMATE_INLINE_RESULT').map(({ message }) => message.error),
    ['等待翻译超过 1 秒，请重试。']);
  assert.deepEqual(calls.opens, []);
});

test('navigation and tab removal cancel requests without delivering stale results', async () => {
  const pending = [];
  const { api, calls, listeners } = fakeChrome();
  const router = registerBackground(api, {
    translateImpl: ({ signal }) => {
      const task = deferred();
      pending.push({ signal, ...task });
      return task.promise;
    },
  });
  const navigating = router.onClicked(selected('Before navigation'), tab());
  await waitFor(() => pending.length === 1);
  listeners.updated(17, { status: 'loading' });
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(router.activeByTab.has(17), false);
  assert.equal(messages(calls, 'TRANSMATE_INLINE_HIDE').length, 1);
  pending[0].resolve('Old page result');
  await navigating;

  const closing = router.onClicked(selected('Before close'), tab());
  await waitFor(() => pending.length === 2);
  listeners.removed(17);
  assert.equal(pending[1].signal.aborted, true);
  assert.equal(router.activeByTab.has(17), false);
  pending[1].resolve('Closed tab result');
  await closing;
  assert.deepEqual(messages(calls, 'TRANSMATE_INLINE_RESULT'), []);
});

test('same-document URL changes hide a restored card after worker restart', async () => {
  const { api, calls, listeners } = fakeChrome();
  const firstWorker = registerBackground(api, { translateImpl: async () => 'Visible result' });
  await firstWorker.onClicked(selected('SPA source'), tab());
  const requestId = firstWorker.activeByTab.get(17).requestId;
  registerBackground(api);
  listeners.updated(17, { url: 'https://example.test/article#next' });
  await waitFor(() => messages(calls, 'TRANSMATE_INLINE_HIDE').some(
    ({ message }) => message.requestId === requestId));
});

test('unrelated menu clicks and empty selections do nothing', async () => {
  const { api, calls } = fakeChrome();
  const router = registerBackground(api);
  await router.onClicked({ menuItemId: 'other', selectionText: 'Hello' }, tab());
  await router.onClicked(selected('   '), tab());
  assert.deepEqual(calls.injections, []);
  assert.deepEqual(calls.messages, []);
  assert.deepEqual(calls.opens, []);
  assert.deepEqual(calls.writes, []);
});
