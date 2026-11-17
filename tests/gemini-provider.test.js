import assert from 'node:assert/strict';
import test from 'node:test';

import { geminiGenerateContent } from '../lib/providers/gemini.js';
import { streamCompletion, translate } from '../lib/translator.js';

const config = {
  endpoint: 'https://generativelanguage.googleapis.com/v1beta/',
  apiKey: 'private-gemini-key',
  model: 'models/gemini-example',
};

function response(parts, finishReason = 'STOP') {
  return { candidates: [{ index: 0, content: { parts }, finishReason }] };
}

test('Gemini requests separate system instructions and user input with API key only in headers', () => {
  const request = geminiGenerateContent.prepareRequest(config, { text: 'original', system: 'instruction' });
  assert.equal(request.endpoint, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-example:generateContent');
  assert.deepEqual(request.headers, { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey });
  assert.deepEqual(request.body, {
    systemInstruction: { parts: [{ text: 'instruction' }] },
    contents: [{ role: 'user', parts: [{ text: 'original' }] }],
  });
  const stream = geminiGenerateContent.prepareRequest(config, { text: 'original', system: 'instruction', stream: true });
  assert.equal(stream.endpoint, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-example:streamGenerateContent?alt=sse');
  assert.equal(new URL(stream.endpoint).searchParams.has('key'), false);
});

test('Gemini ignores thought and nontext parts and uses its first candidate', () => {
  const data = response([{ text: '应该隐藏', thought: true }, { text: '译' }, { functionCall: {} }, { text: '文' }]);
  data.candidates.unshift({ index: 1, content: { parts: [{ text: '其他候选' }] } });
  assert.equal(geminiGenerateContent.readText(data), '译文');
});

test('Gemini finish and error handling omits raw vendor messages', () => {
  for (const finishReason of ['MAX_TOKENS', 'CONTINUATION']) {
    assert.throws(() => geminiGenerateContent.readText(response([{ text: 'partial' }], finishReason),
      { resultName: '总结' }), /总结因长度限制而中断/);
  }
  for (const data of [
    { promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'private upstream detail' } },
    { candidates: [{ finishReason: 'PROHIBITED_CONTENT', finishMessage: 'private upstream detail' }] },
    { error: { message: 'private upstream detail' } },
  ]) {
    assert.throws(() => geminiGenerateContent.readText(data), (error) =>
      /Gemini/.test(error.message) && !/private upstream detail/.test(error.message));
  }
});

function sse(...events) {
  const data = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
  const encoded = new TextEncoder().encode(data);
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < encoded.length; offset += 7) {
        controller.enqueue(encoded.slice(offset, offset + 7));
      }
      controller.close();
    },
  });
}

test('Gemini reads fragmented SSE asynchronously and stops at the final candidate', async () => {
  const chunks = [];
  let received = 0;
  const body = sse(
    response([{ text: '不输出', thought: true }], ''),
    { usageMetadata: { promptTokenCount: 2 } },
    response([{ text: '你好' }], 'FINISH_REASON_UNSPECIFIED'),
    response([{ text: '，世界！' }], 'STOP'),
    response([{ text: 'ignored after STOP' }], 'STOP'),
  );
  for await (const text of geminiGenerateContent.readDeltas(body, { onActivity: () => { received += 1; } })) {
    chunks.push(text);
  }
  assert.deepEqual(chunks, ['你好', '，世界！']);
  assert.ok(received > 1);
});

test('Gemini streaming rejects safety blocks, truncation, and an early end', async () => {
  async function consume(...frames) {
    for await (const _ of geminiGenerateContent.readDeltas(sse(...frames))) {
      // Consume until the stream emits its terminal result or rejects.
    }
  }
  await assert.rejects(consume(response([{ text: 'partial' }], '')), /流式响应提前结束/);
  await assert.rejects(consume(response([{ text: 'partial' }], 'MAX_TOKENS')), /长度限制/);
  await assert.rejects(consume({ promptFeedback: { blockReason: 'SAFETY' } }), /内容过滤/);
  await assert.rejects(consume({ error: { message: 'private upstream detail' } }), (error) =>
    /Gemini/.test(error.message) && !/private upstream detail/.test(error.message));
});

test('shared Gemini transport validates the host and accepts JSON fallback from the streaming route', async () => {
  const settings = { ...config, provider: 'gemini', targetLanguage: 'zh-CN' };
  const allowed = [];
  const result = [];
  for await (const chunk of streamCompletion({
    text: 'source', settings, makeSystemPrompt: () => 'instruction',
    permissionsApi: { contains: async ({ origins }) => { allowed.push(...origins); return true; } },
    fetchImpl: async (url, request) => {
      assert.match(url, /:streamGenerateContent\?alt=sse$/);
      assert.equal(request.redirect, 'error');
      return Response.json(response([{ text: 'Gemini 译文' }]));
    },
  })) {
    result.push(chunk);
  }
  assert.deepEqual(allowed, ['https://generativelanguage.googleapis.com/*']);
  assert.deepEqual(result, [{ content: 'Gemini 译文', streaming: false }]);
});

test('shared Gemini transport gives safe HTTP 400 guidance without reading the vendor error body', async () => {
  const settings = { ...config, provider: 'gemini', targetLanguage: 'zh-CN' };
  let readError = false;
  await assert.rejects(translate({
    text: 'source', settings,
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => { readError = true; } }),
  }), /HTTP 400.*Gemini API Key.*模型 ID/);
  assert.equal(readError, false);
});
