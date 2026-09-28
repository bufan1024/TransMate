import { validateSettings } from './config.js';

const MAX_TEXT_LENGTH = 5000;

export async function translate({ text, settings, fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('请选择需要翻译的文字。');
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(`选中文字不能超过 ${MAX_TEXT_LENGTH} 个字符。`);
  }
  const config = validateSettings(settings);
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前环境不支持网络请求。');
  }

  const systemPrompt = [
    `Translate the user's text into ${config.targetLanguage}. Preserve its meaning, tone, and formatting. Return only the translation.`,
    config.prompt,
  ].filter(Boolean).join('\n');

  let response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
        stream: false,
      }),
      signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) {
      throw new Error('翻译已取消。');
    }
    throw new Error('网络请求失败，请检查连接和接口地址。');
  }

  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? ` HTTP ${response.status}` : '';
    throw new Error(`翻译服务请求失败${status}，请检查 API Key、模型或服务状态。`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('翻译服务返回了无法解析的数据。');
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('翻译服务未返回有效译文。');
  }
  return content.trim();
}
