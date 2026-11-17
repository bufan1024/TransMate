import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
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
  selectionResults = [], currentTab = tab(),
} = {}) {
  const sessionState = { ...session };
  const listeners = {};
  const calls = {
    menus: [], behavior: [], accessLevels: [], injections: [], messages: [],
    writes: [], opens: [], removals: [], queries: [], badges: [], titles: [], options: 0,
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
    commands: {
      onCommand: { addListener: (fn) => { listeners.command = fn; } },
    },
    action: {
      setBadgeText: async (details) => { calls.badges.push(details); },
      setTitle: async (details) => { calls.titles.push(details); },
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
        if (details.func) return typeof selectionResults === 'function'
          ? selectionResults(details) : selectionResults;
        if (inject) return inject(details);
        const frameId = details.target.frameIds[0];
        return [{ frameId, documentId: 'doc-' + details.target.tabId + '-' + frameId }];
      },
    },
    tabs: {
      query: async (query) => {
        calls.queries.push(query);
        return currentTab ? [currentTab] : [];
      },
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

function mockPageDemand(api, blocks) {
  const sendMessage = api.tabs.sendMessage;
  const completed = new Set();
  let visible = blocks.slice(0, 1);
  api.tabs.sendMessage = async (tabId, message, options) => {
    await sendMessage(tabId, message, options);
    const progress = { completed: completed.size, total: blocks.length, truncated: false };
    if (message.type === 'TRANSMATE_PAGE_READ') return { ok: true, ...progress };
    if (message.type === 'TRANSMATE_PAGE_NEXT') {
      return { ok: true, ...progress, blocks: visible.filter(({ id }) => !completed.has(id)) };
    }
    if (message.type === 'TRANSMATE_PAGE_APPEND') {
      for (const { id } of message.translations) completed.add(id);
      return { ok: true, completed: completed.size };
    }
    return { ok: true };
  };
  return { reveal: (...indices) => { visible = indices.map((index) => blocks[index]); } };
}

test('side panel starts page actions only for the active tab in its window', async () => {
  const { api, calls } = fakeChrome();
  api.runtime.getURL = (resource) => `chrome-extension://transmate/${resource}`;
  const router = registerBackground(api);
  const message = { type: 'TRANSMATE_PANEL_PAGE_ACTION', action: 'summarize-page', windowId: 7 };

  const fromPage = { url: 'https://example.test/not-the-panel', tab: tab(), frameId: 0 };
  assert.equal((await router.onMessage(message, fromPage)).ok, false);
  assert.deepEqual(calls.queries, []);
  const panel = { url: 'chrome-extension://transmate/sidepanel.html' };
  assert.equal((await router.onMessage(message, panel)).ok, true);
  assert.deepEqual(calls.queries, [{ active: true, windowId: 7 }]);
  assert.equal(calls.opens.length, 0);
  const [published] = Object.values(calls.writes[0]);
  assert.equal(published.tabId, 17);
  assert.equal(published.documentId, 'doc-17-0');
});

test('side panel reports unavailable page access and does not request a translation', async () => {
  const { api, calls } = fakeChrome({ currentTab: tab(17, 7, 'chrome://extensions') });
  api.runtime.getURL = (resource) => `chrome-extension://transmate/${resource}`;
  const router = registerBackground(api, { translatePageImpl: async () => assert.fail('unexpected translation') });
  const panel = { url: 'chrome-extension://transmate/sidepanel.html' };
  const outcome = await router.onMessage({
    type: 'TRANSMATE_PANEL_PAGE_ACTION', action: 'translate-page', windowId: 7,
  }, panel);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /网页/);
  assert.equal(calls.injections.length, 0);
});

test('installs selection and page menus, preserves toolbar side panel, and protects local settings', () => {
  const { api, calls, listeners } = fakeChrome();
  registerBackground(api);
  listeners.installed();
  assert.deepEqual(calls.menus, [
    { id: 'translate-selection', title: '用 TransMate 翻译', contexts: ['selection'] },
    { id: 'translate-page', title: '整页双语翻译', contexts: ['page'], documentUrlPatterns: ['http://*/*', 'https://*/*'] },
    { id: 'summarize-page', title: '总结网页重点', contexts: ['page'], documentUrlPatterns: ['http://*/*', 'https://*/*'] },
  ]);
  assert.deepEqual(calls.behavior, [{ openPanelOnActionClick: true }]);
  assert.deepEqual(calls.accessLevels, [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
});

test('page summary hands off only a reference to the originating document', async () => {
  const { api, calls } = fakeChrome();
  const router = registerBackground(api);
  await router.onClicked({ menuItemId: 'summarize-page' }, tab());

  assert.deepEqual(calls.opens, [{ windowId: 7 }]);
  assert.deepEqual(calls.injections, [{ target: { tabId: 17, frameIds: [0] }, files: ['page-content.js'] }]);
  assert.equal(calls.messages.length, 0);
  const [[key, value]] = Object.entries(calls.writes[0]);
  assert.equal(key, `pendingPageSummary:7:${value.requestId}`);
  assert.deepEqual(value, {
    windowId: 7, tabId: 17, documentId: 'doc-17-0',
    requestId: value.requestId, order: value.order, createdAt: value.createdAt,
  });
});

test('summary shortcut opens the side panel within the command gesture and reads the originating page', async () => {
  const { api, calls } = fakeChrome();
  const router = registerBackground(api);
  const operation = router.onCommand('summarize-page', tab());
  assert.deepEqual(calls.opens, [{ windowId: 7 }]);
  assert.equal(calls.queries.length, 0);

  await operation;
  const [[key, value]] = Object.entries(calls.writes[0]);
  assert.equal(key, `pendingPageSummary:7:${value.requestId}`);
  assert.equal(value.tabId, 17);
  assert.equal(value.documentId, 'doc-17-0');
  assert.equal(calls.injections.length, 1);
  assert.equal(calls.injections[0].files[0], 'page-content.js');
});

test('page translation pauses outside the viewport and resumes after a worker restart for its original document', async () => {
  const { api, calls, sessionState } = fakeChrome();
  const blocks = [{ id: 1, text: 'first viewport' }, { id: 2, text: 'second viewport' }];
  const { reveal } = mockPageDemand(api, blocks);
  const requested = [];
  const dependencies = {
    translatePageImpl: async ({ blocks, onChunk }) => {
      requested.push(blocks);
      await onChunk(blocks.map(({ id }) => ({ id, text: `译文 ${id}` })));
    },
  };

  await registerBackground(api, dependencies).onCommand('translate-page', tab());
  assert.deepEqual(requested, [[blocks[0]]]);
  assert.equal(messages(calls, 'TRANSMATE_PAGE_STATUS').at(-1).message.status, 'paused');
  const [key] = Object.keys(sessionState);
  const { requestId } = sessionState[key];
  assert.deepEqual(Object.keys(sessionState[key]).sort(), ['documentId', 'order', 'requestId', 'tabId']);

  const restarted = registerBackground(api, dependencies);
  reveal(1);
  const more = { type: 'TRANSMATE_PAGE_MORE', requestId };
  await restarted.onMessage(more, sender(17, 0, 'different-document'));
  await restarted.onMessage(more, sender(17, 1, 'doc-17-0'));
  assert.equal(requested.length, 1);
  await restarted.onMessage(more, sender());
  assert.deepEqual(requested, [[blocks[0]], [blocks[1]]]);
  assert.equal(messages(calls, 'TRANSMATE_PAGE_STATUS').at(-1).message.status, 'success');
  await restarted.onMessage({ type: 'TRANSMATE_PAGE_CANCEL', requestId }, sender());
  assert.deepEqual(sessionState, {});
});

test('page translation retry preserves completed blocks and requires explicit action after worker restart', async () => {
  const { api, calls, sessionState } = fakeChrome();
  const blocks = [{ id: 1, text: 'first' }, { id: 2, text: 'second' }];
  mockPageDemand(api, blocks).reveal(0, 1);
  const requested = [];
  const finishRetry = deferred();
  const dependencies = {
    translatePageImpl: async ({ blocks: requestedBlocks, onChunk }) => {
      requested.push(requestedBlocks);
      if (requested.length === 1) {
        await onChunk([{ id: 1, text: '保留的译文' }]);
        throw new Error('AI 服务暂时异常。');
      }
      await finishRetry.promise;
      await onChunk([{ id: 2, text: '重试后的译文' }]);
    },
  };
  await registerBackground(api, dependencies).onCommand('translate-page', tab());
  assert.equal(messages(calls, 'TRANSMATE_PAGE_STATUS').at(-1).message.status, 'retryable');
  const [record] = Object.values(sessionState);
  const { requestId } = record;
  assert.equal(record.retryable, true);
  assert.equal(messages(calls, 'TRANSMATE_PAGE_CLEAR').length, 0);

  const restarted = registerBackground(api, dependencies);
  await restarted.onMessage({ type: 'TRANSMATE_PAGE_MORE', requestId }, sender());
  const retry = { type: 'TRANSMATE_PAGE_RETRY', requestId };
  await restarted.onMessage(retry, sender(17, 0, 'different-document'));
  await restarted.onMessage(retry, sender(17, 1, 'doc-17-0'));
  assert.deepEqual(requested, [blocks]);

  const retried = restarted.onMessage(retry, sender());
  await waitFor(() => requested.length === 2);
  await restarted.onMessage(retry, sender());
  assert.deepEqual(requested, [blocks, [blocks[1]]]);
  assert.equal(messages(calls, 'TRANSMATE_PAGE_NEXT').at(-1).message.retry, true);
  finishRetry.resolve();
  await retried;
  assert.equal(messages(calls, 'TRANSMATE_PAGE_STATUS').at(-1).message.status, 'success');
  assert.equal(Object.values(sessionState)[0].retryable, undefined);
});

test('page translation reports an injection failure on the toolbar and clears it on navigation', async () => {
  const { api, calls, listeners } = fakeChrome({
    inject: () => { throw new Error('sensitive tab information'); },
  });
  const router = registerBackground(api);
  await router.onCommand('translate-page', tab());
  assert.deepEqual(calls.badges.at(-1), { tabId: 17, text: '!' });
  assert.match(calls.titles.at(-1).title, /普通网页上重试/);
  assert.doesNotMatch(calls.titles.at(-1).title, /sensitive/);
  assert.equal(messages(calls, 'TRANSMATE_PAGE_NEXT').length, 0);
  listeners.updated(17, { status: 'loading' });
  assert.deepEqual(calls.badges.at(-1), { tabId: 17, text: '' });
});

test('closing a page translation aborts the active stream and discards a late chunk', async () => {
  const { api, calls, sessionState } = fakeChrome();
  mockPageDemand(api, [{ id: 1, text: 'first viewport' }]);
  const started = deferred();
  const finish = deferred();
  const router = registerBackground(api, {
    translatePageImpl: async ({ signal, onChunk }) => {
      started.resolve(signal);
      await finish.promise;
      await onChunk([{ id: 1, text: '迟到的译文' }]);
    },
  });
  const operation = router.onClicked({ menuItemId: 'translate-page' }, tab());
  const signal = await started.promise;
  const { requestId } = Object.values(sessionState)[0];
  await router.onMessage({ type: 'TRANSMATE_PAGE_CANCEL', requestId }, sender());
  assert.equal(signal.aborted, true);
  finish.resolve();
  await operation;
  assert.deepEqual(messages(calls, 'TRANSMATE_PAGE_APPEND'), []);
  assert.deepEqual(sessionState, {});
});

test('settings changes retire an idle page translation before it can resume', async () => {
  const requestId = 'idle-request';
  const key = `pageTranslation:17:${requestId}`;
  const { api, calls, listeners, sessionState } = fakeChrome({
    session: { [key]: { tabId: 17, documentId: 'doc-17-0', requestId, order: Date.now() * 1000 - 1 } },
  });
  const router = registerBackground(api);
  listeners.storageChanged({ settings: { newValue: {} } }, 'local');
  await router.onMessage({ type: 'TRANSMATE_PAGE_MORE', requestId }, sender());
  await waitFor(() => messages(calls, 'TRANSMATE_PAGE_CLEAR').length === 1);
  assert.equal(messages(calls, 'TRANSMATE_PAGE_NEXT').length, 0);
  assert.equal(sessionState[key], undefined);
});

test('navigation while opening the page summary discards the old request', async () => {
  const { api, calls, listeners } = fakeChrome();
  const panel = deferred();
  api.sidePanel.open = () => panel.promise;
  const router = registerBackground(api);

  const pendingSummary = router.onClicked({ menuItemId: 'summarize-page' }, tab());
  await waitFor(() => calls.injections.length === 1);
  listeners.updated(17, { status: 'loading' });
  panel.resolve();
  await pendingSummary;

  assert.equal(calls.writes.length, 0);
});

test('right-click sends the target language of the result without exposing provider settings', async () => {
  const settings = {
    apiKey: 'very-private-key', endpoint: 'https://api.example.test/chat/completions', targetLanguage: ' zh-CN ',
  };
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
  assert.equal(show.message.keyboard, undefined);
  assert.equal(show.message.targetLanguageId, 'zh-CN');
  assert.ok(show.message.languages.some(({ id, name }) => id === 'ja' && name === '日语'));
  assert.deepEqual(result.message, {
    type: 'TRANSMATE_INLINE_RESULT', requestId: show.message.requestId,
    translation: '你好，世界', targetLanguage: '简体中文', targetLanguageId: 'zh-CN',
  });
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
  assert.equal(JSON.stringify(calls.messages).includes(settings.endpoint), false);
});

test('shortcut reads the selected frame and translates in the existing inline card', async () => {
  const settings = { apiKey: 'shortcut-private-key' };
  const { api, calls, listeners } = fakeChrome({
    settings,
    selectionResults: [
      { frameId: 0, documentId: 'doc-17-0', result: { text: '' } },
      { frameId: 3, documentId: 'doc-17-3', result: { text: '  Hello shortcut  ', focused: true } },
    ],
  });
  const translated = [];
  const router = registerBackground(api, {
    translateImpl: async (request) => { translated.push(request); return '快捷键译文'; },
  });

  assert.equal(typeof listeners.command, 'function');
  await router.onCommand('translate-selection', tab());

  assert.deepEqual(calls.injections[0].target, { tabId: 17, allFrames: true });
  assert.equal(typeof calls.injections[0].func, 'function');
  assert.deepEqual(calls.injections[1], {
    target: { tabId: 17, frameIds: [3] }, files: ['content-script.js'],
  });
  const [show] = messages(calls, 'TRANSMATE_INLINE_SHOW');
  const [result] = messages(calls, 'TRANSMATE_INLINE_RESULT');
  assert.equal(show.message.text, 'Hello shortcut');
  assert.equal(show.message.keyboard, true);
  assert.deepEqual(show.options, { documentId: 'doc-17-3' });
  assert.equal(result.message.translation, '快捷键译文');
  assert.equal(result.message.requestId, show.message.requestId);
  assert.equal(translated.length, 1);
  assert.equal(translated[0].text, 'Hello shortcut');
  assert.equal(translated[0].settings, settings);
  assert.deepEqual(calls.opens, []);
  assert.equal(JSON.stringify(calls.messages).includes(settings.apiKey), false);
});

test('shortcut can read the original input when the inline card still has focus', async () => {
  const host = {};
  class Input {}
  const input = Object.assign(new Input(), {
    type: 'text', isConnected: true, value: 'before selected after', selectionStart: 7, selectionEnd: 15,
  });
  const { api, calls } = fakeChrome({
    selectionResults: ({ func }) => [{
      frameId: 0, documentId: 'doc-17-0',
      result: runInNewContext(`(${func})()`, {
        document: { activeElement: host, hasFocus: () => true },
        window: { getSelection: () => null },
        HTMLInputElement: Input, HTMLTextAreaElement: class {}, HTMLIFrameElement: class {},
        __transmateInlineTranslation: { host, previousFocus: input },
      }),
    }],
  });
  const router = registerBackground(api, { translateImpl: async ({ text }) => `译文:${text}` });

  await router.onCommand('translate-selection', tab());

  assert.equal(messages(calls, 'TRANSMATE_INLINE_SHOW')[0].message.text, 'selected');
  assert.equal(messages(calls, 'TRANSMATE_INLINE_RESULT')[0].message.translation, '译文:selected');
});

test('shortcut finds the active tab when Chrome omits the onCommand tab argument', async () => {
  const activeTab = tab(23, 9, 'https://example.test/other');
  const { api, calls } = fakeChrome({
    currentTab: activeTab,
    selectionResults: [{ frameId: 0, documentId: 'doc-23-0', result: { text: 'Active tab text', focused: true } }],
  });
  const router = registerBackground(api, { translateImpl: async () => '当前页译文' });

  await router.onCommand('translate-selection');

  assert.deepEqual(calls.queries, [{ active: true, currentWindow: true }]);
  assert.deepEqual(calls.injections[0].target, { tabId: 23, allFrames: true });
  assert.equal(messages(calls, 'TRANSMATE_INLINE_SHOW')[0].tabId, 23);
  assert.equal(messages(calls, 'TRANSMATE_INLINE_RESULT')[0].message.translation, '当前页译文');
});

test('unknown shortcut command does not inspect the page or call the provider', async () => {
  const { api, calls } = fakeChrome({
    selectionResults: [{ frameId: 0, result: { text: 'Should be ignored' } }],
  });
  let translations = 0;
  const router = registerBackground(api, {
    translateImpl: async () => { translations += 1; return '译文'; },
  });

  await router.onCommand('unrelated-command', tab());

  assert.deepEqual(calls.injections, []);
  assert.deepEqual(calls.messages, []);
  assert.deepEqual(calls.queries, []);
  assert.equal(translations, 0);
});

test('shortcut with no selection shows a hint without calling the provider', async () => {
  const { api, calls } = fakeChrome({
    selectionResults: [{ frameId: 0, documentId: 'doc-17-0', result: { text: '', focused: true } }],
  });
  let translations = 0;
  const router = registerBackground(api, {
    translateImpl: async () => { translations += 1; return 'Should not be sent'; },
  });

  await router.onCommand('translate-selection', tab());

  const [show] = messages(calls, 'TRANSMATE_INLINE_SHOW');
  const [result] = messages(calls, 'TRANSMATE_INLINE_RESULT');
  assert.equal(show.message.text, '');
  assert.equal(show.message.keyboard, true);
  assert.equal(result.message.requestId, show.message.requestId);
  assert.equal(result.message.error, '请先选中文字，再按快捷键翻译。');
  assert.equal(translations, 0);
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(calls.opens, []);
});

test('shortcut ignores stale selection in an unfocused frame', async () => {
  const { api, calls } = fakeChrome({
    selectionResults: [
      { frameId: 0, result: { text: '', focused: true } },
      { frameId: 3, result: { text: 'Stale text', focused: false } },
    ],
  });
  let translations = 0;
  const router = registerBackground(api, {
    translateImpl: async () => { translations += 1; return 'Should not be sent'; },
  });
  await router.onCommand('translate-selection', tab());

  assert.equal(messages(calls, 'TRANSMATE_INLINE_SHOW')[0].message.text, '');
  assert.equal(translations, 0);
});

test('shortcut ignores all residual selections when no page frame has focus', async () => {
  const { api, calls } = fakeChrome({
    selectionResults: [{ frameId: 0, result: { text: 'Residual text', focused: false } }],
  });
  let translations = 0;
  const router = registerBackground(api, {
    translateImpl: async () => { translations += 1; return 'Should not be sent'; },
  });
  await router.onCommand('translate-selection', tab());

  assert.equal(messages(calls, 'TRANSMATE_INLINE_SHOW')[0].message.text, '');
  assert.equal(translations, 0);
});

test('shortcut cannot start a paid request when selection access or card injection fails', async () => {
  for (const failure of ['selection', 'card', 'storage']) {
    const { api, calls } = fakeChrome({
      storageAccessError: failure === 'storage',
      selectionResults: failure === 'selection'
        ? () => { throw new Error('Selection access denied'); }
        : [{ frameId: 0, documentId: 'doc-17-0', result: { text: 'Private text', focused: true } }],
      inject: failure === 'card'
        ? async () => { throw new Error('Content script denied'); }
        : undefined,
    });
    let translations = 0;
    const router = registerBackground(api, {
      translateImpl: async () => { translations += 1; return 'Should not be sent'; },
    });

    await router.onCommand('translate-selection', tab());

    assert.equal(translations, 0, failure);
    assert.deepEqual(messages(calls, 'TRANSMATE_INLINE_RESULT'), [], failure);
  }
});

test('a slower shortcut selection read cannot replace a newer context-menu translation', async () => {
  const pendingSelection = deferred();
  const selectionStarted = deferred();
  const { api, calls } = fakeChrome({
    selectionResults: async () => {
      selectionStarted.resolve();
      return pendingSelection.promise;
    },
  });
  const translated = [];
  const router = registerBackground(api, {
    translateImpl: async ({ text }) => { translated.push(text); return `译文:${text}`; },
  });
  const shortcut = router.onCommand('translate-selection', tab());
  await selectionStarted.promise;
  await router.onClicked(selected('Newer menu text'), tab());
  pendingSelection.resolve([
    { frameId: 0, documentId: 'doc-17-0', result: { text: 'Stale shortcut text', focused: true } },
  ]);
  await shortcut;

  assert.deepEqual(translated, ['Newer menu text']);
  assert.deepEqual(messages(calls, 'TRANSMATE_INLINE_SHOW').map(({ message }) => message.text),
    ['Newer menu text']);
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

test('retry restores the text after worker restart and labels the result with its current target', async () => {
  const { api, calls, sessionState } = fakeChrome({
    selectionResults: [{ frameId: 0, documentId: 'doc-17-0', result: { text: 'Persisted text', focused: true } }],
  });
  let settings = { targetLanguage: 'en' };
  api.storage.local.get = async () => ({ settings });
  const firstWorker = registerBackground(api, { translateImpl: async () => '第一次译文' });
  await firstWorker.onCommand('translate-selection', tab());
  const firstId = firstWorker.activeByTab.get(17).requestId;
  assert.ok(Object.keys(sessionState).some((key) => key.endsWith(firstId)));
  assert.equal(messages(calls, 'TRANSMATE_INLINE_RESULT')[0].message.targetLanguage, '英语');

  settings = { targetLanguage: 'Brazilian Portuguese' };
  const restartedWorker = registerBackground(api, { translateImpl: async ({ text }) => `重试:${text}` });
  assert.equal(restartedWorker.activeByTab.size, 0);
  await restartedWorker.onMessage({ type: 'TRANSMATE_INLINE_RETRY', requestId: firstId }, sender());
  const shows = messages(calls, 'TRANSMATE_INLINE_SHOW');
  const latest = shows.at(-1).message;
  assert.equal(latest.text, 'Persisted text');
  assert.equal(latest.retryOf, firstId);
  assert.equal(latest.keyboard, undefined);
  assert.notEqual(latest.requestId, firstId);
  assert.equal(messages(calls, 'TRANSMATE_INLINE_RESULT').at(-1).message.translation, '重试:Persisted text');
  assert.equal(messages(calls, 'TRANSMATE_INLINE_RESULT').at(-1).message.targetLanguage, 'Brazilian Portuguese');
  assert.equal(Object.keys(sessionState).some((key) => key.endsWith(firstId)), false);
  assert.equal(calls.opens.length, 0);
});

test('switching the inline target replaces an in-flight translation and rejects stale or invalid choices', async () => {
  const pending = [];
  const settings = { targetLanguage: 'zh-CN', apiKey: 'unchanged-test-key' };
  const { api, calls } = fakeChrome({ settings });
  const router = registerBackground(api, {
    translateImpl: ({ text, settings: requestSettings, signal }) => {
      const task = deferred();
      pending.push({ text, requestSettings, signal, ...task });
      return task.promise;
    },
  });
  const original = router.onClicked(selected('Same text'), tab());
  await waitFor(() => pending.length === 1);
  const firstId = router.activeByTab.get(17).requestId;
  const switchLanguage = (requestId, targetLanguage, source = sender()) => router.onMessage({
    type: 'TRANSMATE_INLINE_SWITCH_LANGUAGE', requestId, targetLanguage,
  }, source);

  try {
    assert.deepEqual(await switchLanguage(firstId, 'arbitrary prompt'), { ok: false });
    assert.deepEqual(await switchLanguage(firstId, 'ja', sender(17, 0, 'wrong-doc')), { ok: false });
    assert.equal(pending[0].signal.aborted, false);

    const accepted = switchLanguage(firstId, 'ja');
    const duplicate = switchLanguage(firstId, 'ko');
    assert.deepEqual(await accepted, { ok: true });
    assert.deepEqual(await duplicate, { ok: false });
    await waitFor(() => pending.length === 2);
    const secondId = router.activeByTab.get(17).requestId;
    assert.equal(pending[0].signal.aborted, true);
    assert.equal(pending[1].requestSettings.targetLanguage, 'ja');
    assert.deepEqual(await switchLanguage(firstId, 'ko'), { ok: false });
    assert.deepEqual(await switchLanguage(secondId, 'fr'), { ok: true });
    await waitFor(() => pending.length === 3);
    const thirdId = router.activeByTab.get(17).requestId;
    assert.equal(pending[1].signal.aborted, true);
    assert.equal(pending[2].requestSettings.targetLanguage, 'fr');
    assert.equal(pending[2].text, 'Same text');
    assert.equal(settings.targetLanguage, 'zh-CN');
    assert.deepEqual(messages(calls, 'TRANSMATE_INLINE_SHOW').slice(1).map(({ message }) => [
      message.retryOf, message.targetLanguageId, message.targetLanguage,
    ]), [[firstId, 'ja', '日语'], [secondId, 'fr', '法语']]);
    pending[0].resolve('stale Chinese');
    pending[1].resolve('stale Japanese');
    pending[2].resolve('French result');
    await waitFor(() => messages(calls, 'TRANSMATE_INLINE_RESULT').length === 1);
    assert.deepEqual(messages(calls, 'TRANSMATE_INLINE_RESULT')[0].message, {
      type: 'TRANSMATE_INLINE_RESULT', requestId: thirdId, translation: 'French result',
      targetLanguageId: 'fr', targetLanguage: '法语',
    });
  } finally {
    for (const task of pending) task.resolve('cleanup');
    await original;
  }
});

test('temporary inline language survives worker restart and retry and resets with a new selection', async () => {
  const settings = { targetLanguage: 'en', apiKey: 'unchanged-test-key' };
  const { api, calls, sessionState } = fakeChrome({ settings });
  const translated = [];
  const translateImpl = async ({ text, settings: requestSettings }) => {
    translated.push([text, requestSettings.targetLanguage]);
    return 'Translation';
  };
  const worker = registerBackground(api, { translateImpl });
  await worker.onClicked(selected('First text'), tab());
  const firstId = worker.activeByTab.get(17).requestId;
  const message = {
    type: 'TRANSMATE_INLINE_SWITCH_LANGUAGE', requestId: firstId, targetLanguage: 'de',
  };
  assert.deepEqual(await worker.onMessage(message, sender()), { ok: true });
  await waitFor(() => messages(calls, 'TRANSMATE_INLINE_RESULT').length === 2);
  const overrideId = worker.activeByTab.get(17).requestId;
  assert.ok(Object.keys(sessionState).some((key) => key.endsWith(overrideId)));

  const restarted = registerBackground(api, { translateImpl });
  await restarted.onMessage({ type: 'TRANSMATE_INLINE_RETRY', requestId: overrideId }, sender());
  await restarted.onClicked(selected('Second text'), tab());
  assert.deepEqual(translated, [
    ['First text', 'en'], ['First text', 'de'], ['First text', 'de'], ['Second text', 'en'],
  ]);
  assert.deepEqual(await api.storage.local.get('settings'), { settings });
  assert.equal(Object.keys(sessionState).length, 1);
  assert.doesNotMatch(JSON.stringify(sessionState), /unchanged-test-key/);
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
