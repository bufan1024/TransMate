import { message as localize } from './i18n.js';

export const AZURE_OPENAI_PROVIDER = 'azure-openai';

export const PROVIDERS = Object.freeze([
  { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions' },
  { id: 'deepseek', name: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions' },
  { id: 'openrouter', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions' },
  { id: 'anthropic', name: 'Claude', endpoint: 'https://api.anthropic.com/v1/messages', protocol: 'anthropic' },
  { id: 'gemini', name: 'Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'gemini' },
  { id: AZURE_OPENAI_PROVIDER, name: 'Azure OpenAI', endpoint: '' },
  { id: 'custom', name: localize('customProvider', '自定义'), endpoint: '' },
]);

export const TARGET_LANGUAGES = Object.freeze([
  { id: 'zh-CN', name: localize('langChineseSimplified', '简体中文') },
  { id: 'zh-TW', name: localize('langChineseTraditional', '繁体中文') },
  { id: 'en', name: localize('langEnglish', '英语') },
  { id: 'ja', name: localize('langJapanese', '日语') },
  { id: 'ko', name: localize('langKorean', '韩语') },
  { id: 'fr', name: localize('langFrench', '法语') },
  { id: 'de', name: localize('langGerman', '德语') },
  { id: 'es', name: localize('langSpanish', '西班牙语') },
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
    throw new Error(localize('requiredField', `请填写${field}。`, field));
  }
  return value.trim();
}

export function defaultAuthTypeForProvider(provider) {
  return provider === AZURE_OPENAI_PROVIDER ? 'api-key' : DEFAULT_AUTH_TYPE;
}

function parseAzureEndpoint(value) {
  const authority = value.match(AZURE_AUTHORITY)?.[0];
  if (!authority) {
    throw new Error(localize('azureEndpointHost', '请填写 Azure 资源的 HTTPS 接口地址（openai.azure.com 或 services.ai.azure.com）。'));
  }
  if (!AZURE_PATHS.has(value.slice(authority.length))) {
    throw new Error(localize('azureEndpointPath', '请填写 Azure 资源根地址、/openai/v1 或完整的 /openai/v1/chat/completions 接口地址。'));
  }
  return new URL(AZURE_COMPLETIONS_PATH, authority);
}

function parseEndpoint(value, provider) {
  let format = 'Chat Completions';
  if (provider === 'anthropic') format = 'Claude Messages';
  if (provider === 'gemini') format = 'Gemini API base';
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(localize('providerEndpointRequired', `请填写完整的 ${format} 接口地址。`, format));
  }
  if (/[\u0000-\u001f\u007f]/.test(value) || value.includes('?') || value.includes('#')) {
    throw new Error(localize('endpointForbiddenData', '接口地址不能包含控制字符、查询参数或片段。'));
  }

  if (provider === AZURE_OPENAI_PROVIDER) return parseAzureEndpoint(value.trim());

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(localize('endpointInvalid', '接口地址不是有效 URL。'));
  }

  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new Error(localize('endpointHTTPS', '接口地址必须使用 HTTPS；仅 localhost 和 127.0.0.1 可使用 HTTP。'));
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(localize('endpointNoCredentials', '接口地址不能包含账号、密码、查询参数或片段。'));
  }
  if (provider === 'gemini') {
    if (!/^\/v1(?:beta)?\/?$/.test(url.pathname)) {
      throw new Error(localize('geminiEndpointPath', '请输入以 /v1 或 /v1beta 结尾的 Gemini API 基础地址。'));
    }
    return url;
  }
  const path = provider === 'anthropic' ? '/v1/messages' : '/chat/completions';
  if (provider !== 'custom' && !url.pathname.endsWith(path)) {
    throw new Error(localize('providerEndpointRequired', `请填写完整的 ${format} 接口地址。`, format));
  }
  return url;
}

export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(localize('invalidSettings', '请提供有效的翻译设置。'));
  }

  const provider = typeof input.provider === 'string' ? input.provider.trim() : DEFAULT_SETTINGS.provider;
  const preset = PROVIDERS.find(({ id }) => id === provider);
  if (!preset) {
    throw new Error(localize('invalidProvider', '请选择有效的 AI 服务。'));
  }

  const endpointInput = typeof input.endpoint === 'string' && input.endpoint.trim()
    ? input.endpoint
    : preset.endpoint;
  const defaultAuthType = defaultAuthTypeForProvider(provider);
  const authType = input.authType ?? defaultAuthType;
  if (!AUTH_TYPES.has(authType) || (provider !== 'custom' && authType !== defaultAuthType)) {
    throw new Error(localize('invalidAuthType', '请选择服务支持的认证方式。'));
  }
  const endpoint = parseEndpoint(endpointInput, provider);
  if (authType === 'none' && !LOOPBACK_AUTHORITY.test(endpointInput.trim())) {
    throw new Error(localize('noKeyLocalOnly', '无需密钥只适用于 localhost 或 127.0.0.1 的 HTTP 或 HTTPS 接口。'));
  }
  const apiKey = authType === 'none' ? '' : requiredString(input.apiKey, 'API Key');
  if (apiKey && /[\u0000-\u001f\u007f]/.test(input.apiKey)) {
    throw new Error(localize('apiKeyControlCharacters', 'API Key 不能包含控制字符。'));
  }
  const model = requiredString(input.model, provider === AZURE_OPENAI_PROVIDER ? localize('azureDeploymentName', '部署名称') : localize('modelName', '模型名称'));
  if (provider === 'gemini' && !/^(?:models\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model)) {
    throw new Error(localize('invalidGeminiModel', '请填写 Gemini 模型 ID，可包含 models/ 前缀。'));
  }
  const targetLanguage = requiredString(input.targetLanguage, localize('targetLanguage', '目标语言'));
  const prompt = input.prompt == null ? '' : input.prompt;
  if (typeof prompt !== 'string') {
    throw new Error(localize('invalidPrompt', '自定义提示词必须是文本。'));
  }
  let workspaceId = '';
  if (provider === 'anthropic' && input.workspaceId != null) {
    if (typeof input.workspaceId !== 'string') throw new Error(localize('invalidClaudeWorkspace', '请填写有效的 Claude 工作区 ID。'));
    workspaceId = input.workspaceId.trim();
    if (workspaceId && !/^wrkspc_[A-Za-z0-9]+$/.test(workspaceId)) {
      throw new Error(localize('invalidClaudeWorkspacePrefix', '请填写以 wrkspc_ 开头的 Claude 工作区 ID。'));
    }
  }

  return {
    provider,
    endpoint: endpoint.href,
    ...(authType === DEFAULT_AUTH_TYPE ? {} : { authType }),
    ...(workspaceId ? { workspaceId } : {}),
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
