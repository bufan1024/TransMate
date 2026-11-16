const MAX_EVENT_LENGTH = 256_000;
const INVALID_STREAM = 'AI 服务返回的流式响应格式有误，请重试或更换模型。';

async function* readEventData(body, signal, onActivity) {
  const reader = body?.getReader();
  if (!reader) throw new Error(INVALID_STREAM);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  let buffer = '';
  let data = '';
  let ended = false;
  let skipLeadingLineFeed = false;
  try {
    while (!ended) {
      signal?.throwIfAborted();
      try {
        const { done, value } = await reader.read();
        ended = done;
        if (value?.byteLength) onActivity?.();
        buffer += decoder.decode(value, { stream: !done });
      } catch {
        signal?.throwIfAborted();
        throw new Error('读取 AI 服务的流式响应失败，请检查网络连接后重试。');
      }
      signal?.throwIfAborted();
      if (skipLeadingLineFeed && buffer) {
        if (buffer[0] === '\n') buffer = buffer.slice(1);
        skipLeadingLineFeed = false;
      }
      let lineEnd;
      while ((lineEnd = buffer.search(/[\r\n]/)) !== -1) {
        const carriageReturn = buffer[lineEnd] === '\r';
        skipLeadingLineFeed = carriageReturn && lineEnd === buffer.length - 1;
        const separator = carriageReturn && buffer[lineEnd + 1] === '\n' ? 2 : 1;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + separator);
        if (line === '' && data) {
          yield data.slice(0, -1);
          data = '';
          signal?.throwIfAborted();
        } else if (line === 'data' || line.startsWith('data:')) {
          data += `${line.slice(5).replace(/^ /, '')}\n`;
          if (data.length > MAX_EVENT_LENGTH) throw new Error(INVALID_STREAM);
        }
      }
      if (buffer.length > MAX_EVENT_LENGTH) throw new Error(INVALID_STREAM);
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!ended) cancel();
    reader.releaseLock();
  }
}

export async function* readCompletionDeltas(body, { signal, onActivity }) {
  for await (const data of readEventData(body, signal, onActivity)) {
    if (!data.trim()) continue;
    if (data.trim() === '[DONE]') return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error(INVALID_STREAM);
    }
    if (event?.error || !Array.isArray(event?.choices)) throw new Error(INVALID_STREAM);
    const choice = event.choices.find((item, index) => (item?.index ?? index) === 0);
    const finishReason = choice?.finish_reason;
    if (finishReason === 'length') {
      throw new Error('AI 服务返回的译文因长度限制而中断，请使用输出上限更高的模型。');
    }
    if (finishReason && finishReason !== 'stop') throw new Error(INVALID_STREAM);
    const content = choice?.delta?.content;
    if (typeof content === 'string' && content) yield content;
    if (finishReason === 'stop') return;
  }
  throw new Error('AI 服务的流式响应提前结束，请重试。');
}
