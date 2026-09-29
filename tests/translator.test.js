import assert from 'node:assert/strict';
import test from 'node:test';

import { translate } from '../lib/translator.js';

const settings = {
  provider: 'custom',
  endpoint: 'https://example.com/v1/chat/completions',
  apiKey: 'private-key',
  model: 'example-model',
  targetLanguage: '简体中文',
  prompt: 'Preserve names.',
};

test('translate sends a non-streaming Chat Completions request and returns its text', async () => {
  let request;
  const signal = new AbortController().signal;
  const result = await translate({
    text: 'Hello, world!',
    settings,
    signal,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '  你好，世界！  ' } }] }) };
    },
  });

  assert.equal(result, '你好，世界！');
  assert.equal(request.url, settings.endpoint);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer private-key');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.equal(request.options.signal, signal);
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.credentials, 'omit');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'example-model');
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages.map(({ role }) => role), ['system', 'user']);
  assert.match(body.messages[0].content, /简体中文/);
  assert.match(body.messages[0].content, /Preserve names\./);
  assert.equal(body.messages[1].content, 'Hello, world!');
});

test('translate rejects empty and overlong text before a network request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('should not fetch'); };
  for (const text of ['', '   ', 'a'.repeat(5001)]) {
    await assert.rejects(() => translate({ text, settings, fetchImpl }), Error);
  }
  assert.equal(calls, 0);
});

test('translate accepts exactly 5000 characters', async () => {
  const result = await translate({
    text: 'a'.repeat(5000),
    settings,
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '译文' } }] }) }),
  });
  assert.equal(result, '译文');
});

test('translate reports HTTP status without exposing provider response or API key', async () => {
  const responseSecret = 'upstream private details';
  let bodyRead = false;
  await assert.rejects(
    () => translate({
      text: 'Hello',
      settings,
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        text: async () => { bodyRead = true; return responseSecret; },
      }),
    }),
    (error) => error instanceof Error && /401/.test(error.message)
      && !error.message.includes(responseSecret)
      && !error.message.includes(settings.apiKey),
  );
  assert.equal(bodyRead, false);
});

test('translate gives distinct next steps for provider HTTP failures', async () => {
  const cases = [
    { status: 401, expected: /认证失败.*API Key/ },
    { status: 403, expected: /访问被拒绝.*权限/ },
    { status: 404, expected: /接口地址/ },
    { status: 408, expected: /服务响应超时/ },
    { status: 429, expected: /请求过于频繁.*稍后重试/ },
    { status: 503, expected: /服务暂时异常.*稍后重试/ },
    { status: 504, expected: /服务响应超时/ },
  ];
  for (const { status, expected } of cases) {
    let bodyRead = false;
    await assert.rejects(
      () => translate({
        text: 'Hello',
        settings,
        fetchImpl: async () => ({
          ok: false,
          status,
          text: async () => { bodyRead = true; return 'private provider detail'; },
        }),
      }),
      (error) => error instanceof Error
        && error.message.includes(`HTTP ${status}`)
        && expected.test(error.message)
        && !error.message.includes('private provider detail')
        && !error.message.includes(settings.apiKey),
    );
    assert.equal(bodyRead, false);
  }
});

test('translate explains missing host permission before sending a request', async () => {
  let requestedOrigin;
  let sent = false;
  await assert.rejects(
    () => translate({
      text: 'Hello',
      settings,
      permissionsApi: {
        contains: async ({ origins }) => {
          [requestedOrigin] = origins;
          return false;
        },
      },
      fetchImpl: async () => { sent = true; throw new Error('should not send'); },
    }),
    /网站访问权限.*设置页.*授权/,
  );
  assert.equal(requestedOrigin, 'https://example.com/*');
  assert.equal(sent, false);
});

test('translate does not expose permission API errors', async () => {
  await assert.rejects(
    () => translate({
      text: 'Hello',
      settings,
      permissionsApi: { contains: async () => { throw new Error('private-key internal failure'); } },
      fetchImpl: async () => { throw new Error('should not send'); },
    }),
    (error) => error instanceof Error && /网站访问权限/.test(error.message)
      && !error.message.includes(settings.apiKey),
  );
});

test('translate does not send after cancellation during the permission check', async () => {
  const controller = new AbortController();
  let sent = false;
  await assert.rejects(
    () => translate({
      text: 'Hello',
      settings,
      signal: controller.signal,
      permissionsApi: { contains: async () => { controller.abort(); return true; } },
      fetchImpl: async () => { sent = true; throw new Error('should not send'); },
    }),
    /翻译已取消/,
  );
  assert.equal(sent, false);
});

test('translate hides network error details', async () => {
  await assert.rejects(
    () => translate({
      text: 'Hello',
      settings,
      fetchImpl: async () => { throw new Error('Request failed with private-key'); },
    }),
    (error) => error instanceof Error && !error.message.includes(settings.apiKey),
  );
});

test('translate rejects malformed or empty provider responses', async () => {
  for (const payload of [{}, { choices: [] }, { choices: [{ message: { content: '' } }] }]) {
    await assert.rejects(() => translate({
      text: 'Hello',
      settings,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => payload }),
    }), /HTTP 200.*Chat Completions/);
  }
});

test('translate guides the user when the response is not JSON', async () => {
  await assert.rejects(
    () => translate({
      text: 'Hello',
      settings,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('private-key'); } }),
    }),
    (error) => error instanceof Error && /HTTP 200.*Chat Completions/.test(error.message)
      && !error.message.includes(settings.apiKey),
  );
});
