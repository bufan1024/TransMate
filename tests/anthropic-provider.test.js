import assert from 'node:assert/strict';
import test from 'node:test';

import { checkConnection } from '../lib/connection-check.js';
import { summarizePage, translatePage } from '../lib/page-ai.js';
import { streamCompletion, translate } from '../lib/translator.js';

const settings = {
  provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages', apiKey: 'private-test-key',
  workspaceId: 'wrkspc_test01', model: 'claude-test-model', targetLanguage: 'zh-CN', prompt: 'Keep product names.',
};
const messageStart = { type: 'message_start', message: { type: 'message', content: [], stop_reason: null } };
const blockStart = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const blockStop = { type: 'content_block_stop', index: 0 };
const messageStop = { type: 'message_stop' };

function delta(text) {
  return { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
}

function finish(stopReason) {
  return { type: 'message_delta', delta: { stop_reason: stopReason } };
}

function eventWire(...events) {
  return events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('');
}

function message(content, reason = 'end_turn') {
  return Response.json({ type: 'message', stop_reason: reason, content });
}

test('Claude connection checks send the native Messages wire request and return text blocks only', async () => {
  const permissions = [];
  const result = await checkConnection({
    settings,
    permissionsApi: { contains: async (request) => { permissions.push(request); return true; } },
    fetchImpl: async (url, options) => {
      assert.equal(url, settings.endpoint);
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.headers['x-api-key'], settings.apiKey);
      assert.equal(options.headers['anthropic-version'], '2026-10-21');
      assert.equal(options.headers['anthropic-dangerous-direct-browser-access'], 'true');
      assert.equal(options.headers['anthropic-workspace-id'], settings.workspaceId);
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.equal(Object.hasOwn(options.headers, 'Authorization'), false);
      const body = JSON.parse(options.body);
      assert.equal(body.model, settings.model);
      assert.equal(body.max_tokens, 4096);
      assert.equal(body.stream, false);
      assert.match(body.system, /zh-CN.*Keep product names\./s);
      assert.deepEqual(body.messages, [{ role: 'user', content: 'Hello, world.' }]);
      return message([
        { type: 'thinking', thinking: 'hidden reasoning' },
        { type: 'text', text: '你好，' },
        { type: 'text', text: '世界！' },
      ]);
    },
  });
  assert.deepEqual(permissions, [{ origins: ['https://api.anthropic.com/*'] }]);
  assert.equal(result.translation, '你好，世界！');
});

test('Claude normal responses report truncation, refusal and API failures without raw provider details', async () => {
  for (const reason of ['max_tokens', 'model_context_window_exceeded']) {
    await assert.rejects(() => translate({
      text: 'Hello', settings,
      fetchImpl: async () => message([{ type: 'text', text: 'private partial output' }], reason),
    }), /长度限制/);
  }
  await assert.rejects(() => translate({
    text: 'Hello', settings,
    fetchImpl: async () => Response.json({
      type: 'message', stop_reason: 'refusal', content: [], stop_details: { explanation: 'private upstream explanation' },
    }),
  }), (error) => /未能完成/.test(error.message) && !error.message.includes('private'));
  await assert.rejects(() => translate({
    text: 'Hello', settings,
    fetchImpl: async () => Response.json({ error: { message: 'private overload' } }, { status: 529 }),
  }), (error) => /529/.test(error.message) && !error.message.includes('private'));
});

test('Claude streaming emits only text, retains its spacing, and completes on message_stop', async () => {
  const headers = { 'content-type': 'text/event-stream' };
  let stream;
  const body = new ReadableStream({ start(controller) { stream = controller; } });
  const iterator = streamCompletion({
    text: 'Test', settings, makeSystemPrompt: () => 'Test prompt',
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).stream, true);
      return new Response(body, { headers });
    },
  });
  const encoder = new TextEncoder();
  stream.enqueue(encoder.encode(eventWire(
    messageStart,
    { type: 'ping' },
    { type: 'future_type' },
    { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'private thought' } },
    { type: 'content_block_stop', index: 1 },
    blockStart, delta('你好，'),
  )));
  assert.deepEqual(await iterator.next(), { value: { content: '你好，', streaming: true }, done: false });
  stream.enqueue(encoder.encode(eventWire(delta(' 世界！'), blockStop, finish('end_turn'), messageStop)));
  stream.close();
  assert.equal((await iterator.next()).value.content, ' 世界！');
  assert.equal((await iterator.next()).done, true);
});

test('Claude terminal and streamed provider errors reject the operation with a safe message', async () => {
  for (const [events, reason] of [
    [[finish('max_tokens'), messageStop], /长度限制/],
    [[{ type: 'error', error: { type: 'overloaded_error', message: 'private detail' } }], /繁忙|超负荷/],
    [[finish('end_turn')], /提前结束/],
  ]) {
    const sequence = eventWire(messageStart, blockStart, delta('部分文字'), blockStop, ...events);
    await assert.rejects(async () => {
      for await (const _ of streamCompletion({
        text: 'Test', settings, makeSystemPrompt: () => 'Test prompt',
        fetchImpl: async () => new Response(sequence, { headers: { 'Content-Type': 'text/event-stream' } }),
      })) { /* consume the complete protocol */ }
    }, (error) => reason.test(error.message) && !error.message.includes('private'));
  }
});

test('webpage translation streams and summarization reads native Claude responses', async () => {
  const blocks = [{ id: 3, text: 'Article heading' }];
  const paragraphs = [];
  await translatePage({
    blocks, settings, onChunk: (blocks) => paragraphs.push(...blocks),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.stream, true);
      assert.match(body.system, /Translate the following webpage/);
      const [{ id }] = JSON.parse(body.messages[0].content);
      const reply = eventWire(messageStart, blockStart,
        delta(JSON.stringify({ id, text: '标题' }) + '\n'), blockStop, finish('end_turn'), messageStop);
      return new Response(reply, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  assert.deepEqual(paragraphs, [{ id: 3, text: '标题' }]);
  const summary = await summarizePage({
    blocks, settings,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.stream, false);
      assert.match(body.system, /Summarize the following webpage/);
      return message([{ type: 'text', text: '• 摘要' }]);
    },
  });
  assert.equal(summary, '• 摘要');
});
