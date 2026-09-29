import { originPatternForEndpoint, validateSettings } from './config.js';

const MAX_TEXT_LENGTH = 5000;

function httpStatus(response) {
  return Number.isInteger(response?.status) ? `HTTP ${response.status}` : 'HTTP 状态未知';
}

function httpFailure(response) {
  const status = response?.status;
  const prefix = `翻译服务返回 ${httpStatus(response)}：`;
  if (status === 401) return `${prefix}认证失败，请检查 API Key 是否正确或已过期。`;
  if (status === 403) return `${prefix}访问被拒绝，请检查 API Key、账户和模型权限。`;
  if (status === 404) return `${prefix}接口地址或模型未找到，请核对 Chat Completions 地址和模型 ID。`;
  if (status === 408 || status === 504) return `${prefix}服务响应超时，请稍后重试并检查服务状态。`;
  if (status === 429) return `${prefix}请求过于频繁或额度不足，请稍后重试并检查配额。`;
  if (status >= 500 && status < 600) return `${prefix}AI 服务暂时异常，请稍后重试或查看服务状态。`;
  return `${prefix}请求未成功，请检查接口地址、模型 ID 和服务状态。`;
}

export async function translate({
  text,
  settings,
  fetchImpl = globalThis.fetch,
  permissionsApi = globalThis.chrome?.permissions,
  signal,
} = {}) {
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
  if (signal?.aborted) {
    throw new Error('翻译已取消。');
  }

  if (permissionsApi?.contains) {
    let granted;
    try {
      granted = await permissionsApi.contains({ origins: [originPatternForEndpoint(config.endpoint)] });
    } catch {
      throw new Error('无法确认 AI 服务的网站访问权限，请在设置页重新保存配置并授权。');
    }
    if (!granted) {
      throw new Error('缺少 AI 服务的网站访问权限，请在设置页重新保存配置并允许授权。');
    }
  }
  if (signal?.aborted) {
    throw new Error('翻译已取消。');
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
    throw new Error('网络请求失败，请检查接口地址、网络连接和代理设置后重试。');
  }

  if (!response?.ok) {
    throw new Error(httpFailure(response));
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`翻译服务返回 ${httpStatus(response)}，但响应不是有效的 Chat Completions JSON；请检查接口地址和服务兼容性。`);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(`翻译服务返回 ${httpStatus(response)}，但未返回有效译文；请确认模型支持 Chat Completions 响应格式。`);
  }
  return content.trim();
}
