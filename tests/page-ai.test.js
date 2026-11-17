import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizePage, translatePage } from '../lib/page-ai.js';

const settings = {
  provider: 'custom',
  endpoint: 'https://example.com/v1/chat/completions',
  apiKey: 'test-key',
  model: 'example-model',
  targetLanguage: '简体中文',
  prompt: 'Preserve names.',
};

function mockService(reply) {
  return async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    const content = await reply(JSON.parse(messages[1].content), messages[0].content, options.signal);
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };
}

function openEventStream() {
  const encoder = new TextEncoder();
  let writer;
  const stream = {
    cancelled: false,
    records: [],
    fetch: async (_url, options) => {
      stream.records.push(JSON.parse(options.body));
      return response;
    },
    send: (value, oneByteAtATime = false) => {
      const bytes = encoder.encode(value);
      if (oneByteAtATime) {
        for (const byte of bytes) writer.enqueue(Uint8Array.of(byte));
      } else {
        writer.enqueue(bytes);
      }
    },
    close: () => writer.close(),
  };
  const response = {
    ok: true,
    headers: new Headers({ 'Content-Type': 'text/event-stream; charset=utf-8' }),
    body: new ReadableStream({
      start: (controller) => { writer = controller; },
      cancel: () => { stream.cancelled = true; },
    }),
  };
  return stream;
}

function delta(content, finishReason = null) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }] })}\r\n\r\n`;
}

test('page translation publishes each completed paragraph before the event stream ends', async () => {
  const stream = openEventStream();
  const results = [];
  let showFirstParagraph;
  const firstParagraph = new Promise((resolve) => { showFirstParagraph = resolve; });
  const operation = translatePage({
    blocks: [{ id: 8, text: 'First' }, { id: 3, text: 'Second' }],
    settings,
    fetchImpl: stream.fetch,
    onChunk: (translations, progress) => {
      results.push({ translations, progress });
      showFirstParagraph();
    },
  });

  stream.send(delta('{"id":0,"text":"你') + delta('好😀"}\r\n'), true);
  await Promise.race([firstParagraph, operation.then(() => assert.fail('The stream ended before any paragraph'))]);
  assert.equal(stream.records[0].stream, true);
  assert.deepEqual(results, [{
    translations: [{ id: 8, text: '你好😀' }], progress: { completed: 1, total: 2 },
  }]);

  stream.send(delta('{"id":1,"text":"第二段"}') + 'data: [DONE]\r\n\r\n');
  stream.close();
  await operation;
  assert.deepEqual(results[1], {
    translations: [{ id: 3, text: '第二段' }], progress: { completed: 2, total: 2 },
  });
});

test('invalid stream IDs do not publish unverified paragraphs', async () => {
  const stream = openEventStream();
  const results = [];
  stream.send(delta('{"id":0,"text":"第一段"}\n{"id":9,"text":"不属于原文的内容"}\n'));
  stream.close();
  await assert.rejects(() => translatePage({
    blocks: [{ id: 8, text: 'First' }, { id: 3, text: 'Second' }],
    settings,
    fetchImpl: stream.fetch,
    onChunk: (translations) => results.push(...translations),
  }), /逐段译文/);
  assert.deepEqual(results, [{ id: 8, text: '第一段' }]);
});

test('page translation treats an unfinished event stream as incomplete', async () => {
  for (const [termination, expected] of [
    ['', /流式响应提前结束/],
    [delta(null, 'length') + 'data: [DONE]\n\n', /译文因长度限制而中断/],
  ]) {
    const stream = openEventStream();
    const results = [];
    stream.send(delta('{"id":0,"text":"第一段"}\n{"id":1,"text":"未完成') + termination);
    stream.close();
    await assert.rejects(() => translatePage({
      blocks: [{ id: 8, text: 'First' }, { id: 3, text: 'Second' }],
      settings,
      fetchImpl: stream.fetch,
      onChunk: (translations) => results.push(...translations),
    }), expected);
    assert.deepEqual(results, [{ id: 8, text: '第一段' }]);
  }
});

test('page translation does not expose error details from the event stream', async () => {
  const stream = openEventStream();
  stream.send('data: {"error":{"message":"private endpoint data"}}\n\n');
  stream.close();
  await assert.rejects(() => translatePage({
    blocks: [{ id: 8, text: 'First' }],
    settings,
    fetchImpl: stream.fetch,
    onChunk: () => assert.fail('Unexpected paragraph'),
  }), (error) => error.message.includes('流式响应格式有误') && !error.message.includes('private endpoint data'));
});

test('cancellation releases the pending stream and rejects late paragraphs', async () => {
  const controller = new AbortController();
  const stream = openEventStream();
  const results = [];
  let showFirstParagraph;
  const firstParagraph = new Promise((resolve) => { showFirstParagraph = resolve; });
  const operation = translatePage({
    blocks: [{ id: 8, text: 'First' }, { id: 3, text: 'Second' }],
    settings,
    signal: controller.signal,
    fetchImpl: stream.fetch,
    onChunk: (translations) => {
      results.push(...translations);
      showFirstParagraph();
    },
  });

  stream.send(delta('{"id":0,"text":"第一段"}\n'));
  await Promise.race([firstParagraph, operation.then(() => assert.fail('The stream ended before any paragraph'))]);
  controller.abort();
  await assert.rejects(operation, { name: 'AbortError' });
  assert.equal(stream.cancelled, true);
  assert.deepEqual(results, [{ id: 8, text: '第一段' }]);
});

test('page translation matches reordered responses to the original block IDs', async () => {
  const results = [];
  await translatePage({
    blocks: [{ id: 8, text: 'First' }, { id: 3, text: 'Second' }],
    settings,
    fetchImpl: mockService((blocks, prompt) => {
      assert.match(prompt, /简体中文/);
      assert.match(prompt, /Preserve names\./);
      return JSON.stringify([
        { id: blocks[1].id, text: '第二段' }, { id: blocks[0].id, text: '第一段' },
      ]);
    }),
    onChunk: (translations, progress) => results.push({ translations, progress }),
  });

  assert.deepEqual(results, [{
    translations: [{ id: 8, text: '第一段' }, { id: 3, text: '第二段' }],
    progress: { completed: 2, total: 2 },
  }]);
});

test('long paragraphs are requested in bounded pieces and published once', async () => {
  const longText = '😀\\"'.repeat(1500);
  const received = [];
  const results = [];
  await translatePage({
    blocks: [{ id: 7, text: longText }],
    settings,
    fetchImpl: mockService((blocks) => {
      assert.ok(JSON.stringify(blocks).length <= 5000);
      for (const { text } of blocks) {
        assert.doesNotMatch(text, /[\uD800-\uDFFF]/u);
        received.push(text);
      }
      return JSON.stringify(blocks.map(({ id }) => ({ id, text: '译文' })));
    }),
    onChunk: (translations) => results.push(...translations),
  });

  assert.ok(received.length > 1);
  assert.equal(received.join(''), longText);
  assert.deepEqual(results, [{ id: 7, text: Array(received.length).fill('译文').join(' ') }]);
});

test('page translation does not display partial batches with missing or duplicate IDs', async () => {
  for (const faultyResponse of [
    ({ id }) => [{ id, text: '第一段' }],
    ({ id }) => [{ id, text: '第一段' }, { id, text: '重复' }],
  ]) {
    const results = [];
    await assert.rejects(() => translatePage({
      blocks: [{ id: 8, text: 'First' }, { id: 3, text: 'Second' }],
      settings,
      fetchImpl: mockService(([first]) => JSON.stringify(faultyResponse(first))),
      onChunk: (translations) => results.push(...translations),
    }), /逐段译文/);
    assert.deepEqual(results, []);
  }
});

test('cancelling after the first translated batch prevents remaining requests', async () => {
  const controller = new AbortController();
  let requests = 0;
  await assert.rejects(() => translatePage({
    blocks: [{ id: 1, text: 'a'.repeat(4000) }, { id: 2, text: 'b'.repeat(4000) }],
    settings,
    signal: controller.signal,
    fetchImpl: mockService((blocks) => {
      requests += 1;
      return JSON.stringify(blocks.map(({ id }) => ({ id, text: '译文' })));
    }),
    onChunk: () => controller.abort(),
  }), { name: 'AbortError' });
  assert.equal(requests, 1);
});

test('page summary synthesizes the findings from both beginning and end of a long article', async () => {
  const first = 'Front '.repeat(660);
  const last = 'End '.repeat(990);
  const progress = [];
  const result = await summarizePage({
    blocks: [{ id: 5, text: first }, { id: 6, text: last }],
    settings,
    onProgress: (step) => progress.push(step),
    fetchImpl: mockService((blocks, prompt) => {
      if (prompt.startsWith('Combine ')) {
        assert.deepEqual(blocks.map(({ text }) => text), ['开头重点', '结尾重点']);
        return '• 开头重点\n• 结尾重点';
      }
      assert.match(prompt, /简体中文/);
      assert.equal(blocks.length, 1);
      if (blocks[0].text === first) return '开头重点';
      assert.equal(blocks[0].text, last);
      return '结尾重点';
    }),
  });
  assert.equal(result, '• 开头重点\n• 结尾重点');
  assert.deepEqual(progress, [
    { phase: 'extract', batch: 1, total: 2 },
    { phase: 'extract', batch: 2, total: 2 },
    { phase: 'combine', batch: 1, total: 1 },
  ]);
});

test('page summary times out an unanswered service request', async () => {
  let requestAborted = false;
  await assert.rejects(() => summarizePage({
    blocks: [{ id: 1, text: 'Article' }],
    settings,
    requestTimeoutMs: 10,
    fetchImpl: mockService((_blocks, _prompt, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        requestAborted = true;
        reject(signal.reason);
      }, { once: true });
    })),
  }), /AI 服务响应超时/);
  assert.equal(requestAborted, true);
});

test('page summary reports provider truncation instead of showing partial findings', async () => {
  await assert.rejects(() => summarizePage({
    blocks: [{ id: 1, text: 'Article' }],
    settings,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '• Partial' } }] }),
    }),
  }), /总结因长度限制而中断/);
});
