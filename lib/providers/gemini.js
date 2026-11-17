import { message as localize } from '../i18n.js';
import { readEventData } from '../completion-stream.js';

const INVALID_RESPONSE = localize('geminiInvalidResponse', 'Gemini API 返回的响应格式有误，请检查模型后重试。');
const BLOCKED_RESPONSE = localize('geminiContentFiltered', 'Gemini 的内容过滤阻止了本次请求，请调整原文或更换模型。');
const BLOCKED_FINISH_REASONS = new Set([
  'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'ESCALATION', 'PUP_LIMITED_DISABLED',
]);

function readCandidate(data) {
  if (data?.error) throw new Error(localize('geminiError', 'Gemini API 返回错误，请检查服务后重试。'));
  const blockReason = data?.promptFeedback?.blockReason;
  if (blockReason && blockReason !== 'BLOCK_REASON_UNSPECIFIED') throw new Error(BLOCKED_RESPONSE);
  if (data?.candidates != null && !Array.isArray(data.candidates)) throw new Error(INVALID_RESPONSE);
  return data?.candidates?.find((candidate, index) => (candidate?.index ?? index) === 0);
}

function textFromCandidate(candidate) {
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.filter((part) => part?.thought !== true && typeof part?.text === 'string')
    .map(({ text }) => text).join('');
}

function checkFinish(finishReason, resultName = localize('translation', '译文'), requireComplete = true) {
  if (!finishReason || finishReason === 'FINISH_REASON_UNSPECIFIED' || finishReason === 'STOP') return;
  if (finishReason === 'MAX_TOKENS' || finishReason === 'CONTINUATION') {
    if (!requireComplete) return;
    throw new Error(localize('resultLengthLimit', `AI 服务返回的${resultName}因长度限制而中断，请使用输出上限更高的模型。`, resultName));
  }
  if (BLOCKED_FINISH_REASONS.has(finishReason)) throw new Error(BLOCKED_RESPONSE);
  if (finishReason === 'LANGUAGE') throw new Error(localize('geminiUnsupportedLanguage', 'Gemini 模型不支持此次请求的语言，请更换模型。'));
  throw new Error(INVALID_RESPONSE);
}

export const geminiGenerateContent = {
  label: 'Gemini GenerateContent',

  prepareRequest(config, { text, system, stream }) {
    const endpoint = new URL(config.endpoint);
    const model = encodeURIComponent(config.model.replace(/^models\//, ''));
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/models/${model}:${stream ? 'streamGenerateContent' : 'generateContent'}`;
    if (stream) endpoint.searchParams.set('alt', 'sse');
    return {
      endpoint: endpoint.href,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text }] }],
      },
    };
  },

  httpError(status) {
    if (status === 400) return localize('geminiHttpFailure', '请求参数无效，请核对 Gemini API Key、版本和模型 ID。');
  },

  readText(data, { resultName, requireComplete } = {}) {
    const candidate = readCandidate(data);
    checkFinish(candidate?.finishReason, resultName, requireComplete);
    return textFromCandidate(candidate);
  },

  async *readDeltas(body, { signal, onActivity, resultName } = {}) {
    for await (const payload of readEventData(body, { signal, onActivity })) {
      if (!payload.trim()) continue;
      let data;
      try {
        data = JSON.parse(payload);
      } catch {
        throw new Error(INVALID_RESPONSE);
      }
      const candidate = readCandidate(data);
      const finishReason = candidate?.finishReason;
      checkFinish(finishReason, resultName);
      const text = textFromCandidate(candidate);
      if (text) yield text;
      if (finishReason === 'STOP') return;
    }
    throw new Error(localize('geminiEarlyStreamEnd', 'Gemini 的流式响应提前结束，请重试。'));
  },
};
