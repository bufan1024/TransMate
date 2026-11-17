import { readEventData } from '../completion-stream.js';

const API_VERSION = '2026-10-21';
const MAX_OUTPUT_TOKENS = 4096;
const INVALID_STREAM = 'Claude 返回的流式响应格式有误，请重试或检查接口。';

function assertComplete(reason, resultName) {
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') {
    throw new Error(`Claude 返回的${resultName}因长度限制而中断，请缩短原文后重试。`);
  }
  if (reason === 'refusal') {
    throw new Error(`Claude 未能完成此次${resultName}，请检查内容后重试。`);
  }
  if (reason !== 'end_turn' && reason !== 'stop_sequence') {
    throw new Error(`Claude 未返回完整的${resultName}，请重试。`);
  }
}

function providerError(type) {
  if (type === 'overloaded_error') return new Error('Claude 服务繁忙，请稍后重试。');
  if (type === 'rate_limit_error') return new Error('Claude 请求过于频繁，请稍后重试并检查配额。');
  return new Error('Claude 响应处理失败，请稍后重试。');
}

async function* readDeltas(body, { signal, onActivity, resultName = '译文' }) {
  const blocks = new Map();
  let started = false;
  let completed = false;

  for await (const data of readEventData(body, { signal, onActivity })) {
    if (!data.trim()) continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error(INVALID_STREAM);
    }
    if (typeof event?.type !== 'string') throw new Error(INVALID_STREAM);
    switch (event.type) {
      case 'error':
        throw providerError(event.error?.type);
      case 'message_start':
        if (started) throw new Error(INVALID_STREAM);
        started = true;
        break;
      case 'content_block_start': {
        const block = event.content_block;
        if (!started || completed || !Number.isSafeInteger(event.index) || event.index < 0
            || blocks.has(event.index) || typeof block?.type !== 'string') throw new Error(INVALID_STREAM);
        blocks.set(event.index, block.type);
        if (block.type === 'text' && typeof block.text === 'string' && block.text) yield block.text;
        break;
      }
      case 'content_block_delta':
        if (!blocks.has(event.index)) throw new Error(INVALID_STREAM);
        if (blocks.get(event.index) === 'text' && event.delta?.type === 'text_delta'
            && typeof event.delta.text === 'string' && event.delta.text) yield event.delta.text;
        break;
      case 'content_block_stop':
        if (!blocks.delete(event.index)) throw new Error(INVALID_STREAM);
        break;
      case 'message_delta':
        if (!started || blocks.size) throw new Error(INVALID_STREAM);
        if (event.delta?.stop_reason != null) {
          assertComplete(event.delta.stop_reason, resultName);
          completed = true;
        }
        break;
      case 'message_stop':
        if (!completed) throw new Error(INVALID_STREAM);
        return;
      // Ping events and future event kinds do not carry translation text.
    }
  }
  throw new Error('Claude 的流式响应提前结束，请重试。');
}

export const anthropicMessages = {
  label: 'Claude Messages',

  httpError(status) {
    if (status === 400) return '请核对 Claude 接口地址、模型 ID 和工作区 ID。';
    if (status === 529) return 'Claude 服务繁忙，请稍后重试。';
    return undefined;
  },

  prepareRequest(config, { text, system, stream }) {
    return {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
        ...(config.workspaceId ? { 'anthropic-workspace-id': config.workspaceId } : {}),
      },
      body: {
        model: config.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        messages: [{ role: 'user', content: text }],
        stream,
      },
    };
  },

  readText(data, { resultName }) {
    if (data?.type === 'error') throw providerError(data.error?.type);
    if (data?.type !== 'message' || !Array.isArray(data.content)) return undefined;
    assertComplete(data.stop_reason, resultName);
    return data.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map(({ text }) => text)
      .join('');
  },

  readDeltas,
};
