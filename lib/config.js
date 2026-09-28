export const PROVIDERS = Object.freeze([
  { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions' },
  { id: 'deepseek', name: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions' },
  { id: 'openrouter', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions' },
  { id: 'custom', name: '自定义', endpoint: '' },
]);

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

function parseEndpoint(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('请填写完整的 Chat Completions 接口地址。');
  }
  if (/[\u0000-\u001f\u007f]/.test(value) || value.includes('?') || value.includes('#')) {
    throw new Error('接口地址不能包含控制字符、查询参数或片段。');
  }

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
  if (!url.pathname.endsWith('/chat/completions')) {
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
  const endpoint = parseEndpoint(endpointInput).href;
  const apiKey = requiredString(input.apiKey, 'API Key');
  if (/[\u0000-\u001f\u007f]/.test(input.apiKey)) {
    throw new Error('API Key 不能包含控制字符。');
  }
  const model = requiredString(input.model, '模型名称');
  const targetLanguage = requiredString(input.targetLanguage, '目标语言');
  const prompt = input.prompt == null ? '' : input.prompt;
  if (typeof prompt !== 'string') {
    throw new Error('自定义提示词必须是文本。');
  }

  return {
    provider,
    endpoint,
    apiKey,
    model,
    targetLanguage,
    prompt: prompt.trim(),
  };
}

export function originPatternForEndpoint(endpoint) {
  const url = parseEndpoint(endpoint);
  return `${url.protocol}//${url.hostname}/*`;
}
