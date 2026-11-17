import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AZURE_OPENAI_PROVIDER,
  DEFAULT_SETTINGS,
  PROVIDERS,
  originPatternForEndpoint,
  validateSettings,
} from '../lib/config.js';

const valid = {
  provider: 'custom',
  endpoint: 'https://example.com/v1/chat/completions',
  apiKey: 'secret-key',
  model: 'example-model',
  targetLanguage: '简体中文',
  prompt: '',
};

test('provider presets point to their documented API endpoints', () => {
  assert.deepEqual(
    PROVIDERS.filter(({ id }) => id !== 'custom').map(({ id, endpoint }) => ({ id, endpoint })),
    [
      { id: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions' },
      { id: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions' },
      { id: 'openrouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions' },
      { id: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages' },
      { id: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta' },
      { id: AZURE_OPENAI_PROVIDER, endpoint: '' },
    ],
  );
  assert.equal(DEFAULT_SETTINGS.provider, 'openai');
  assert.equal(DEFAULT_SETTINGS.endpoint, 'https://api.openai.com/v1/chat/completions');
});

test('Claude settings select its Messages path and optional workspace ID', () => {
  const input = { ...valid, provider: 'anthropic', endpoint: '', workspaceId: ' wrkspc_example01 ' };
  assert.equal(validateSettings(input).endpoint, 'https://api.anthropic.com/v1/messages');
  assert.equal(validateSettings(input).workspaceId, 'wrkspc_example01');
  assert.equal(originPatternForEndpoint('https://api.anthropic.com/v1/messages', 'anthropic'), 'https://api.anthropic.com/*');
  assert.throws(() => validateSettings({ ...input, endpoint: 'https://example.com/v1/chat/completions' }), /Messages/);
  assert.throws(() => validateSettings({ ...input, workspaceId: 'unsafe\r\nid' }), /工作区 ID/);
  assert.equal(Object.hasOwn(validateSettings({ ...valid, workspaceId: input.workspaceId }), 'workspaceId'), false);
});

test('default target language uses the options select value for Simplified Chinese', () => {
  assert.equal(DEFAULT_SETTINGS.targetLanguage, 'zh-CN');
});

test('Gemini validates an API base URL and a single model path segment', () => {
  const input = { ...valid, provider: 'gemini', endpoint: '', model: 'models/gemini-example' };
  assert.equal(validateSettings(input).endpoint, 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(validateSettings(input).model, 'models/gemini-example');
  assert.equal(originPatternForEndpoint('https://generativelanguage.googleapis.com/v1beta', 'gemini'),
    'https://generativelanguage.googleapis.com/*');
  assert.equal(validateSettings({ ...input, endpoint: 'http://localhost:3000/v1/' }).endpoint,
    'http://localhost:3000/v1/');
  for (const endpoint of [
    'https://generativelanguage.googleapis.com/v1beta?key=fixture',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-example:generateContent',
    'https://generativelanguage.googleapis.com/v1/chat/completions',
  ]) {
    assert.throws(() => validateSettings({ ...input, endpoint }), /地址/);
  }
  for (const model of ['models/../secret', 'gemini-x?key=fixture', 'models//gemini-x', 'model with spaces']) {
    assert.throws(() => validateSettings({ ...input, model }), /模型 ID/);
  }
});

test('validateSettings trims editable fields and keeps a custom prompt', () => {
  assert.deepEqual(validateSettings({
    ...valid,
    endpoint: '  https://example.com/v1/chat/completions  ',
    apiKey: '  secret-key  ',
    model: '  example-model  ',
    targetLanguage: '  日本語  ',
    prompt: '  Keep names unchanged.  ',
  }), {
    provider: 'custom',
    endpoint: 'https://example.com/v1/chat/completions',
    apiKey: 'secret-key',
    model: 'example-model',
    targetLanguage: '日本語',
    prompt: 'Keep names unchanged.',
  });
});

test('validateSettings supplies the selected preset endpoint when omitted', () => {
  assert.equal(
    validateSettings({ ...valid, provider: 'deepseek', endpoint: '' }).endpoint,
    'https://api.deepseek.com/chat/completions',
  );
});

test('validateSettings rejects incomplete configuration and unknown providers', () => {
  for (const change of [
    { provider: 'unknown' },
    { provider: 'custom', endpoint: '' },
    { apiKey: '  ' },
    { model: '' },
    { targetLanguage: '' },
  ]) {
    assert.throws(() => validateSettings({ ...valid, ...change }), Error);
  }
});

test('validateSettings keeps host restrictions and only custom providers can use another path', () => {
  for (const endpoint of [
    'http://api.example.com/v1/chat/completions',
    'ftp://example.com/v1/chat/completions',
    'https://user:password@example.com/v1/chat/completions',
    'https://example.com/v1/chat/completions?token=secret',
    'https://example.com/v1/chat/completions#fragment',
    'https://example.com/v1/chat/completions\n',
  ]) {
    assert.throws(() => validateSettings({ ...valid, endpoint }), Error, endpoint);
  }
  assert.equal(
    validateSettings({ ...valid, endpoint: 'http://localhost:1234/v1/chat/completions' }).endpoint,
    'http://localhost:1234/v1/chat/completions',
  );
  assert.equal(
    validateSettings({ ...valid, endpoint: 'http://127.0.0.1:8080/chat/completions' }).endpoint,
    'http://127.0.0.1:8080/chat/completions',
  );
  assert.equal(validateSettings({ ...valid, endpoint: 'https://example.com/gateway/v3/respond' }).endpoint,
    'https://example.com/gateway/v3/respond');
  assert.throws(() => validateSettings({
    ...valid, provider: 'openai', endpoint: 'https://example.com/gateway/v3/respond',
  }), /完整的 Chat Completions 接口地址/);
});

test('custom services can choose only the supported authentication methods', () => {
  for (const authType of ['x-api-key', 'api-key']) {
    const normalized = validateSettings({ ...valid, authType });
    assert.equal(normalized.authType, authType);
    assert.equal(normalized.apiKey, valid.apiKey);
    assert.throws(() => validateSettings({ ...valid, authType, apiKey: '' }), /API Key/);
    assert.throws(() => validateSettings({ ...valid, provider: 'openai', authType }), /认证方式/);
  }
  assert.throws(() => validateSettings({ ...valid, authType: 'Cookie' }), /认证方式/);
  assert.throws(() => validateSettings({ ...valid, authType: 'x-api-key', apiKey: 'key\r\nx-other: value' }), /控制字符/);
  assert.deepEqual(validateSettings({ ...valid, authType: 'bearer' }), validateSettings(valid));
});

test('no-key authentication only applies to literal localhost and 127.0.0.1', () => {
  for (const endpoint of [
    'http://localhost:3180/translate',
    'https://localhost/translate',
    'http://127.0.0.1:8180/translate',
    'https://127.0.0.1/completion',
  ]) {
    const normalized = validateSettings({ ...valid, endpoint, authType: 'none' });
    assert.equal(normalized.endpoint, endpoint);
    assert.equal(normalized.authType, 'none');
    assert.equal(normalized.apiKey, '', 'disabling authentication discards any previously typed key');
  }
  for (const endpoint of [
    'https://api.example.com/v1/chat/completions',
    'https://localhost.example.com/translate',
    'http://127.1/translate',
    'https://localhost./translate',
    'http://[::1]/translate',
  ]) {
    assert.throws(() => validateSettings({ ...valid, endpoint, authType: 'none' }), Error, endpoint);
  }
  assert.throws(() => validateSettings({
    ...valid, provider: 'openai', endpoint: 'http://localhost/v1/chat/completions', authType: 'none',
  }), /认证方式/);
});

test('originPatternForEndpoint returns a Chrome host permission pattern without port', () => {
  assert.equal(originPatternForEndpoint('https://api.example.com/v1/chat/completions'), 'https://api.example.com/*');
  assert.equal(originPatternForEndpoint('http://localhost:1234/v1/chat/completions'), 'http://localhost/*');
  assert.equal(originPatternForEndpoint('http://localhost:1234/translate', 'custom'), 'http://localhost/*');
  assert.throws(() => originPatternForEndpoint('http://localhost:1234/translate', 'openai'), Error);
  assert.throws(() => originPatternForEndpoint('http://example.com/v1/chat/completions'), Error);
});

test('Azure OpenAI accepts public resource roots and v1 paths and uses the deployment name', () => {
  for (const suffix of ['openai.azure.com', 'services.ai.azure.com']) {
    const resource = `https://test-resource.${suffix}`;
    const endpoint = resource + '/openai/v1/chat/completions';
    for (const input of [resource, resource + '/', resource + '/openai/v1', endpoint, endpoint + '/']) {
      const config = validateSettings({ ...valid, provider: AZURE_OPENAI_PROVIDER, endpoint: input, model: ' my-deployment ' });
      assert.equal(config.endpoint, endpoint);
      assert.equal(config.authType, 'api-key');
      assert.equal(config.model, 'my-deployment');
      assert.equal(originPatternForEndpoint(input, AZURE_OPENAI_PROVIDER), resource + '/*');
    }
  }
  const config = validateSettings({
    ...valid, provider: AZURE_OPENAI_PROVIDER, endpoint: 'HTTPS://TEST-RESOURCE.OPENAI.AZURE.COM:443/openai/v1/',
  });
  assert.equal(config.endpoint, 'https://test-resource.openai.azure.com/openai/v1/chat/completions');
});

test('Azure OpenAI rejects non-resource hosts, non-v1 paths and every other authentication method', () => {
  const azure = { ...valid, provider: AZURE_OPENAI_PROVIDER, endpoint: 'https://test-resource.openai.azure.com' };
  for (const endpoint of [
    'http://test-resource.openai.azure.com',
    'https://test-resource.openai.azure.com:444',
    'http://localhost:4000/openai/v1',
    'https://openai.azure.com',
    'https://prefix.test-resource.openai.azure.com',
    'https://test-resource.openai.azure.com.example.com/openai/v1',
    'https://test-resource.openai.azure.com@example.com/openai/v1',
    'https://%74est-resource.openai.azure.com/openai/v1',
    'https://test-resource.openai.azure.com/openai/deployments/demo/chat/completions',
    'https://test-resource.openai.azure.com/openai/v1/chat/completions?api-version=2025-01-01',
    'https://test-resource.openai.azure.com/openai/v1/chat/completions#anchor',
    'https://test-resource.openai.azure.com/openai/v1/../v1/',
    'https://test-resource.openai.azure.com/v1/chat/completions',
  ]) {
    assert.throws(() => validateSettings({ ...azure, endpoint }), /接口地址/, endpoint);
  }
  for (const authType of ['bearer', 'x-api-key', 'none']) {
    assert.throws(() => validateSettings({ ...azure, authType }), /认证方式/);
  }
  assert.throws(() => validateSettings({ ...azure, apiKey: '' }), /API Key/);
  assert.throws(() => validateSettings({ ...azure, model: '' }), /部署名称/);
});
