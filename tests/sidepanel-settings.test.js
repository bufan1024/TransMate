import assert from 'node:assert/strict';
import test from 'node:test';

const initialSettings = {
  provider: 'custom',
  endpoint: 'https://example.com/v1/chat/completions',
  apiKey: 'test-key',
  model: 'test-model',
  targetLanguage: 'zh-CN',
  prompt: '',
};

function fakeElement() {
  const listeners = new Map();
  return {
    value: '',
    textContent: '',
    hidden: false,
    disabled: false,
    style: {},
    addEventListener(type, listener) {
      const callbacks = listeners.get(type) || [];
      callbacks.push(listener);
      listeners.set(type, callbacks);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
    },
    click() { this.dispatchEvent({ type: 'click' }); },
  };
}

async function mountSidepanel() {
  const previous = {
    document: globalThis.document,
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
  };
  const elements = new Map();
  const requests = [];
  let onStorageChanged;

  globalThis.document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, fakeElement());
      return elements.get(selector);
    },
  };
  globalThis.chrome = {
    runtime: { openOptionsPage() {} },
    permissions: { contains: async () => true },
    windows: { getCurrent: async () => ({ id: 7 }) },
    storage: {
      local: {
        setAccessLevel: async () => {},
        get: async () => ({ settings: initialSettings }),
      },
      session: { get: async () => ({}), remove: async () => {} },
      onChanged: { addListener(listener) { onStorageChanged = listener; } },
    },
  };
  globalThis.fetch = (_url, options) => new Promise((resolve) => {
    requests.push({ options, resolve });
  });

  await import(`../sidepanel.js?settings-test=${Math.random()}`);
  await new Promise((resolve) => setImmediate(resolve));

  return {
    element: (selector) => elements.get(selector),
    requests,
    settingsChanged(nextSettings) {
      onStorageChanged({ settings: { newValue: nextSettings } }, 'local');
    },
    async flush() { await new Promise((resolve) => setImmediate(resolve)); },
    restore() {
      globalThis.document = previous.document;
      globalThis.chrome = previous.chrome;
      globalThis.fetch = previous.fetch;
    },
  };
}

function beginTranslation(app) {
  app.element('#source-text').value = 'Hello';
  app.element('#source-text').dispatchEvent({ type: 'input' });
  app.element('#translate-button').click();
}

function resolveTranslation(request, content) {
  request.resolve({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
}

test('changing translation settings cancels a pending request and ignores its late result', async () => {
  const app = await mountSidepanel();
  try {
    beginTranslation(app);
    await app.flush();
    assert.equal(app.requests.length, 1);
    assert.equal(app.element('#result-loading').hidden, false);

    app.settingsChanged({ ...initialSettings, targetLanguage: 'ja' });
    assert.equal(app.requests[0].options.signal.aborted, true);
    assert.equal(app.element('#source-text').value, 'Hello');
    assert.equal(app.element('#result-loading').hidden, true);
    assert.equal(app.element('#result-empty').hidden, false);
    assert.equal(app.element('#translate-button').disabled, false);
    assert.match(app.element('#target-label').textContent, /日语/);

    resolveTranslation(app.requests[0], '旧译文');
    await app.flush();
    assert.equal(app.element('#result-text').textContent, '');
    assert.equal(app.element('#copy-button').disabled, true);
    assert.equal(app.element('#result-empty').hidden, false);
  } finally {
    app.restore();
  }
});

test('changing translation settings clears a completed result but keeps the source text', async () => {
  const app = await mountSidepanel();
  try {
    beginTranslation(app);
    await app.flush();
    resolveTranslation(app.requests[0], '旧译文');
    await app.flush();
    assert.equal(app.element('#result-text').textContent, '旧译文');

    app.settingsChanged({ ...initialSettings, model: 'new-model' });
    assert.equal(app.element('#source-text').value, 'Hello');
    assert.equal(app.element('#result-text').textContent, '');
    assert.equal(app.element('#result-empty').hidden, false);
    assert.equal(app.element('#copy-button').disabled, true);
    assert.equal(app.element('#translate-button').disabled, false);
  } finally {
    app.restore();
  }
});

test('unrelated settings changes keep an active translation', async () => {
  const app = await mountSidepanel();
  try {
    beginTranslation(app);
    await app.flush();
    app.settingsChanged({ ...initialSettings, theme: 'dark' });
    assert.equal(app.requests[0].options.signal.aborted, false);
    assert.equal(app.element('#result-loading').hidden, false);

    resolveTranslation(app.requests[0], '当前译文');
    await app.flush();
    assert.equal(app.element('#result-text').textContent, '当前译文');
  } finally {
    app.restore();
  }
});
