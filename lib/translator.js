import { message as localize } from './i18n.js';
import { originPatternForEndpoint, validateSettings } from './config.js';
import { readCompletionDeltas } from './completion-stream.js';

export const MAX_TEXT_LENGTH = 5000;

function httpStatus(response) {
  return Number.isInteger(response?.status) ? `HTTP ${response.status}` : localize('httpStatusUnknown', 'HTTP 状态未知');
}

function httpFailure(response) {
  const status = response?.status;
  const prefix = localize('providerHttpPrefix', `翻译服务返回 ${httpStatus(response)}：`, httpStatus(response));
  if (status === 401) return localize('unauthorizedProvider', `${prefix}认证失败，请检查 API Key 是否正确或已过期。`, prefix);
  if (status === 403) return localize('forbiddenProvider', `${prefix}访问被拒绝，请检查 API Key、账户和模型权限。`, prefix);
  if (status === 404) return localize('missingProviderModel', `${prefix}接口地址或模型未找到，请核对 Chat Completions 地址和模型 ID。`, prefix);
  if (status === 408 || status === 504) return localize('upstreamTimeout', `${prefix}服务响应超时，请稍后重试并检查服务状态。`, prefix);
  if (status === 429) return localize('rateLimited', `${prefix}请求过于频繁或额度不足，请稍后重试并检查配额。`, prefix);
  if (status >= 500 && status < 600) return localize('upstreamUnavailable', `${prefix}AI 服务暂时异常，请稍后重试或查看服务状态。`, prefix);
  return localize('requestFailed', `${prefix}请求未成功，请检查接口地址、模型 ID 和服务状态。`, prefix);
}

export async function translate({
  text,
  settings,
  fetchImpl,
  permissionsApi,
  signal,
} = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(localize('selectText', '请选择需要翻译的文字。'));
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(localize('selectionLimit', `选中文字不能超过 ${MAX_TEXT_LENGTH} 个字符。`, MAX_TEXT_LENGTH));
  }
  return requestCompletion({
    text,
    settings,
    fetchImpl,
    permissionsApi,
    signal,
    makeSystemPrompt: (config) => [
      `Translate the user's text into ${config.targetLanguage}. Preserve its meaning, tone, and formatting. Return only the translation.`,
      config.prompt,
    ].filter(Boolean).join('\n'),
  });
}

async function fetchCompletion({
  text,
  settings,
  makeSystemPrompt,
  stream = false,
  fetchImpl = globalThis.fetch,
  permissionsApi = globalThis.chrome?.permissions,
  signal,
}) {
  const config = validateSettings(settings);
  if (typeof fetchImpl !== 'function') {
    throw new Error(localize('noNetwork', '当前环境不支持网络请求。'));
  }
  if (signal?.aborted) {
    throw new Error(localize('translationCancelled', '翻译已取消。'));
  }

  if (permissionsApi?.contains) {
    let granted;
    try {
      granted = await permissionsApi.contains({ origins: [originPatternForEndpoint(config.endpoint)] });
    } catch {
      throw new Error(localize('providerPermissionUnknown', '无法确认 AI 服务的网站访问权限，请在设置页重新保存配置并授权。'));
    }
    if (!granted) {
      throw new Error(localize('providerPermissionMissing', '缺少 AI 服务的网站访问权限，请在设置页重新保存配置并允许授权。'));
    }
  }
  if (signal?.aborted) {
    throw new Error(localize('translationCancelled', '翻译已取消。'));
  }

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
          { role: 'system', content: makeSystemPrompt(config) },
          { role: 'user', content: text },
        ],
        stream,
      }),
      signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) {
      throw new Error(localize('translationCancelled', '翻译已取消。'));
    }
    throw new Error(localize('fetchFailed', '网络请求失败，请检查接口地址、网络连接和代理设置后重试。'));
  }

  if (!response?.ok) {
    throw new Error(httpFailure(response));
  }
  return response;
}

async function readCompletion(response, { resultName = localize('translation', '译文'), requireComplete = false }) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(localize('invalidCompletion', `翻译服务返回 ${httpStatus(response)}，但响应不是有效的 Chat Completions JSON；请检查接口地址和服务兼容性。`, httpStatus(response)));
  }
  const choice = data?.choices?.[0];
  if (requireComplete && choice?.finish_reason === 'length') {
    throw new Error(localize('resultLengthLimit', `AI 服务返回的${resultName}因长度限制而中断，请使用输出上限更高的模型。`, resultName));
  }
  const content = choice?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(localize('missingCompletion', `翻译服务返回 ${httpStatus(response)}，但未返回有效${resultName}；请确认模型支持 Chat Completions 响应格式。`, httpStatus(response), resultName));
  }
  return content.trim();
}

export async function requestCompletion(options) {
  const response = await fetchCompletion(options);
  return readCompletion(response, options);
}

export async function* streamCompletion(options, onActivity) {
  const response = await fetchCompletion({ ...options, stream: true });
  const contentType = response.headers?.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'text/event-stream') {
    yield { content: await readCompletion(response, options), streaming: false };
    return;
  }
  for await (const content of readCompletionDeltas(response.body, { signal: options.signal, onActivity })) {
    yield { content, streaming: true };
  }
}
