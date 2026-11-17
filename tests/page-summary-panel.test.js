import assert from 'node:assert/strict';
import test from 'node:test';

import { createPageSummaryPanel } from '../lib/page-summary-panel.js';

const settings = {
  provider: 'custom',
  endpoint: 'https://example.com/v1/chat/completions',
  apiKey: 'test-key',
  model: 'test-model',
  targetLanguage: 'zh-CN',
};
const source = {
  requestId: 'article-summary',
  windowId: 7,
  tabId: 17,
  documentId: 'article-document',
  order: 1,
};
const sourceKey = 'pendingPageSummary:7:article-summary';

function setupPanel({ failFirstRemoval = false } = {}) {
  const elements = new Map();
  const listeners = {};
  const reads = [];
  const removed = [];
  let activeTabId = source.tabId;
  const listen = (name) => ({ addListener(listener) { listeners[name] = listener; } });
  const root = {
    querySelector(id) {
      const callbacks = {};
      const element = {
        hidden: false,
        textContent: '',
        addEventListener(type, callback) { callbacks[type] = callback; },
        click() { callbacks.click?.(); },
      };
      elements.set(id, element);
      return element;
    },
  };
  const chromeApi = {
    permissions: { contains: async () => true },
    storage: {
      session: {
        async remove(key) {
          removed.push(key);
          if (failFirstRemoval && removed.length === 1) throw new Error('无法清理待处理记录');
        },
      },
    },
    tabs: {
      query: async () => [{ id: activeTabId }],
      sendMessage: async (tabId, message, target) => {
        reads.push({ tabId, message, target });
        return {
          ok: true,
          title: '<b>Origin article</b>',
          host: 'example.com',
          blocks: [{ id: 0, text: 'Origin content' }],
          truncated: false,
        };
      },
      onActivated: listen('activate'),
      onUpdated: listen('update'),
      onRemoved: listen('remove'),
      onDetached: listen('detach'),
    },
  };
  const summary = createPageSummaryPanel(chromeApi, root, () => settings);
  summary.initialize(source.windowId, {});
  return {
    summary, reads, removed, element: (id) => elements.get(id),
    start() { summary.receive(sourceKey, { ...source, createdAt: Date.now() }); },
    activate(tabId) {
      activeTabId = tabId;
      listeners.activate({ tabId, windowId: source.windowId });
    },
    navigate(tabId) { listeners.update(tabId, { status: 'loading' }); },
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

function response(content) {
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
}

test('the original document labels its summary and can be retried after returning to its tab', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(JSON.parse(options.body).messages[1].content);
    return requests.length === 1 ? { ok: false, status: 500 } : response('重试成功');
  });
  const app = setupPanel();
  app.start();
  await flush();

  assert.match(app.element('#page-summary-source')?.textContent ?? '', /<b>Origin article<\/b>.*example\.com/);
  assert.equal(app.element('#page-summary-retry').hidden, false);
  assert.equal(app.element('#page-summary-text').hidden, true);
  assert.deepEqual(app.removed, [sourceKey]);

  app.activate(19);
  assert.equal(app.element('#page-summary').hidden, true);
  app.element('#page-summary-retry').click();
  await flush();
  assert.equal(requests.length, 1);

  app.activate(source.tabId);
  assert.equal(app.element('#page-summary').hidden, false);
  app.element('#page-summary-retry').click();
  await flush();

  assert.equal(app.reads.length, 2);
  for (const { tabId, message, target } of app.reads) {
    assert.equal(tabId, source.tabId);
    assert.equal(target.documentId, source.documentId);
    assert.equal(message.mode, 'summary');
  }
  assert.deepEqual(requests.map((body) => JSON.parse(body)[0].text), ['Origin content', 'Origin content']);
  assert.equal(app.element('#page-summary-text').textContent, '重试成功');
  assert.equal(app.element('#page-summary-retry').hidden, true);

  app.activate(19);
  assert.equal(app.element('#page-summary').hidden, true);
  app.activate(source.tabId);
  assert.equal(app.element('#page-summary').hidden, false);
  assert.equal(app.element('#page-summary-text').textContent, '重试成功');
});

test('changing tabs preserves in-flight work while navigation aborts it and clears its result', async (t) => {
  let finishRequest;
  let requestSignal;
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((resolve) => {
    finishRequest = resolve;
    requestSignal = signal;
  }));
  const app = setupPanel();
  app.start();
  await flush();

  app.activate(19);
  try {
    assert.equal(app.element('#page-summary').hidden, true);
    assert.equal(requestSignal.aborted, false);
    app.activate(source.tabId);
    assert.equal(app.element('#page-summary').hidden, false);
    assert.match(app.element('#page-summary-status').textContent, /正在/);

    app.navigate(source.tabId);
    assert.equal(requestSignal.aborted, true);
    assert.equal(app.element('#page-summary').hidden, true);
  } finally {
    finishRequest(response('不应显示的旧结果'));
    await flush();
  }
  assert.equal(app.element('#page-summary-text').hidden, true);
  assert.equal(app.element('#page-summary-text').textContent, '');
});

test('retry consumes a saved summary event before sending if the first removal failed', async (t) => {
  const app = setupPanel({ failFirstRemoval: true });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    assert.deepEqual(app.removed, [sourceKey, sourceKey]);
    return response('移除事件后才总结');
  });
  app.start();
  await flush();
  assert.equal(requests, 0);
  assert.equal(app.element('#page-summary').hidden, false);
  assert.equal(app.element('#page-summary-retry').hidden, false);

  app.element('#page-summary-retry').click();
  await flush();
  assert.equal(requests, 1);
  assert.equal(app.element('#page-summary-text').textContent, '移除事件后才总结');
});
