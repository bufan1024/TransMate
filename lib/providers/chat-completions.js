import { DEFAULT_AUTH_TYPE } from '../config.js';
import { readCompletionDeltas } from '../completion-stream.js';

export const chatCompletions = {
  label: 'Chat Completions',

  prepareRequest(config, { text, system, stream }) {
    const authType = config.authType ?? DEFAULT_AUTH_TYPE;
    const headers = { 'Content-Type': 'application/json' };
    if (authType === DEFAULT_AUTH_TYPE) headers.Authorization = `Bearer ${config.apiKey}`;
    else if (authType !== 'none') headers[authType] = config.apiKey;
    return {
      headers,
      body: {
        model: config.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
        stream,
      },
    };
  },

  readText(data, { resultName, requireComplete }) {
    const choice = data?.choices?.[0];
    if (requireComplete && choice?.finish_reason === 'length') {
      throw new Error(`AI 服务返回的${resultName}因长度限制而中断，请使用输出上限更高的模型。`);
    }
    return choice?.message?.content;
  },

  readDeltas: readCompletionDeltas,
};
