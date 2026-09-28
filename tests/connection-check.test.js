import assert from 'node:assert/strict';
import test from 'node:test';

import { checkConnection } from '../lib/connection-check.js';

const settings = {
  provider: 'custom',
  endpoint: 'https://example.com/v1/chat/completions',
  apiKey: 'test-key',
  model: 'test-model',
  targetLanguage: 'zh-CN',
  prompt: '',
};

function abortablePendingFetch(_url, { signal }) {
  return new Promise((_, reject) => {
    const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

test('connection check sends a real sample translation and reports its duration', async () => {
  let sample;
  const result = await checkConnection({
    settings,
    fetchImpl: async (_url, options) => {
      sample = JSON.parse(options.body).messages[1].content;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '你好，世界。' } }] }) };
    },
  });
  assert.equal(sample, 'Hello, world.');
  assert.equal(result.translation, '你好，世界。');
  assert.ok(result.durationMs >= 0);
});

test('connection check can be cancelled', async () => {
  const controller = new AbortController();
  const pending = checkConnection({ settings, signal: controller.signal, fetchImpl: abortablePendingFetch });
  controller.abort();
  await assert.rejects(pending, /已取消/);
});

test('connection check times out a stalled request', async () => {
  await assert.rejects(
    checkConnection({ settings, timeoutMs: 5, fetchImpl: abortablePendingFetch }),
    /超时/,
  );
});

test('connection check does not treat a successful HTTP response without translation as connected', async () => {
  await assert.rejects(
    checkConnection({ settings, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [] }) }) }),
    /未返回有效译文/,
  );
});
