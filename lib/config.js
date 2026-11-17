export const AZURE_OPENAI_PROVIDER = 'azure-openai';

export const PROVIDERS = Object.freeze([
  { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions' },
  { id: 'deepseek', name: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions' },
  { id: 'openrouter', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions' },
  { id: AZURE_OPENAI_PROVIDER, name: 'Azure OpenAI', endpoint: '' },
  { id: 'custom', name: '自定义', endpoint: '' },
]);

export const DEFAULT_AUTH_TYPE = 'bearer';
const AUTH_TYPES = new Set([DEFAULT_AUTH_TYPE, 'x-api-key', 'api-key', 'none']);
const AZURE_AUTHORITY = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:openai\.azure\.com|services\.ai\.azure\.com)(?::443)?(?=\/|$)/i;
const AZURE_COMPLETIONS_PATH = '/openai/v1/chat/completions';
const AZURE_PATHS = new Set(['', '/', '/openai/v1', '/openai/v1/', AZURE_COMPLETIONS_PATH, AZURE_COMPLETIONS_PATH + '/']);
const LOOPBACK_AUTHORITY = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i;

export const DEFAULT_SETTINGS = Object.freeze({
  provider: 'openai',
  endpoint: PROVIDERS[0].endpoint,
  apiKey: '',
  model: '',
  targetLanguage: 'zh-CN',
  prompt: '',
});

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`请填写${field}。`);
  }
  return value.trim();
}

export function defaultAuthTypeForProvider(provider) {
  return provider === AZURE_OPENAI_PROVIDER ? 'api-key' : DEFAULT_AUTH_TYPE;
}

function parseAzureEndpoint(value) {
  const authority = value.match(AZURE_AUTHORITY)?.[0];
  if (!authority) {
    throw new Error('请填写 Azure 资源的 HTTPS 接口地址（openai.azure.com 或 services.ai.azure.com）。');
  }
  if (!AZURE_PATHS.has(value.slice(authority.length))) {
    throw new Error('请填写 Azure 资源根地址、/openai/v1 或完整的 /openai/v1/chat/completions 接口地址。');
  }
  return new URL(AZURE_COMPLETIONS_PATH, authority);
}

function parseEndpoint(value, provider) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('请填写完整的 Chat Completions 接口地址。');
  }
  if (/[\u0000-\u001f\u007f]/.test(value) || value.includes('?') || value.includes('#')) {
    throw new Error('接口地址不能包含控制字符、查询参数或片段。');
  }

  if (provider === AZURE_OPENAI_PROVIDER) return parseAzureEndpoint(value.trim());

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('接口地址不是有效 URL。');
  }

  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new Error('接口地址必须使用 HTTPS；仅 localhost 和 127.0.0.1 可使用 HTTP。');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('接口地址不能包含账号、密码、查询参数或片段。');
  }
  if (provider !== 'custom' && !url.pathname.endsWith('/chat/completions')) {
    throw new Error('请填写完整的 Chat Completions 接口地址。');
  }
  return url;
}

export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('请提供有效的翻译设置。');
  }

  const provider = typeof input.provider === 'string' ? input.provider.trim() : DEFAULT_SETTINGS.provider;
  const preset = PROVIDERS.find(({ id }) => id === provider);
  if (!preset) {
    throw new Error('请选择有效的 AI 服务。');
  }

  const endpointInput = typeof input.endpoint === 'string' && input.endpoint.trim()
    ? input.endpoint
    : preset.endpoint;
  const defaultAuthType = defaultAuthTypeForProvider(provider);
  const authType = input.authType ?? defaultAuthType;
  if (!AUTH_TYPES.has(authType) || (provider !== 'custom' && authType !== defaultAuthType)) {
    throw new Error('请选择服务支持的认证方式。');
  }
  const endpoint = parseEndpoint(endpointInput, provider);
  if (authType === 'none' && !LOOPBACK_AUTHORITY.test(endpointInput.trim())) {
    throw new Error('无需密钥只适用于 localhost 或 127.0.0.1 的 HTTP 或 HTTPS 接口。');
  }
  const apiKey = authType === 'none' ? '' : requiredString(input.apiKey, 'API Key');
  if (apiKey && /[\u0000-\u001f\u007f]/.test(input.apiKey)) {
    throw new Error('API Key 不能包含控制字符。');
  }
  const model = requiredString(input.model, provider === AZURE_OPENAI_PROVIDER ? '部署名称' : '模型名称');
  const targetLanguage = requiredString(input.targetLanguage, '目标语言');
  const prompt = input.prompt == null ? '' : input.prompt;
  if (typeof prompt !== 'string') {
    throw new Error('自定义提示词必须是文本。');
  }

  return {
    provider,
    endpoint: endpoint.href,
    ...(authType === DEFAULT_AUTH_TYPE ? {} : { authType }),
    apiKey,
    model,
    targetLanguage,
    prompt: prompt.trim(),
  };
}

export function normalizeEndpoint(endpoint, provider = DEFAULT_SETTINGS.provider) {
  return parseEndpoint(endpoint, provider).href;
}

export function originPatternForEndpoint(endpoint, provider = DEFAULT_SETTINGS.provider) {
  const url = parseEndpoint(endpoint, provider);
  return `${url.protocol}//${url.hostname}/*`;
}
