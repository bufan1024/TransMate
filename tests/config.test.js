import assert from 'node:assert/strict';
import test from 'node:test';

import {
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

test('provider presets point to the documented Chat Completions endpoints', () => {
  assert.deepEqual(
    PROVIDERS.filter(({ id }) => id !== 'custom').map(({ id, endpoint }) => ({ id, endpoint })),
    [
      { id: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions' },
      { id: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions' },
      { id: 'openrouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions' },
    ],
  );
  assert.equal(DEFAULT_SETTINGS.provider, 'openai');
  assert.equal(DEFAULT_SETTINGS.endpoint, 'https://api.openai.com/v1/chat/completions');
});

test('default target language uses the options select value for Simplified Chinese', () => {
  assert.equal(DEFAULT_SETTINGS.targetLanguage, 'zh-CN');
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

test('validateSettings restricts endpoints to complete chat/completions URLs', () => {
  for (const endpoint of [
    'http://api.example.com/v1/chat/completions',
    'ftp://example.com/v1/chat/completions',
    'https://user:password@example.com/v1/chat/completions',
    'https://example.com/v1/chat/completions?token=secret',
    'https://example.com/v1/chat/completions#fragment',
    'https://example.com/v1',
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
});

test('originPatternForEndpoint returns a Chrome host permission pattern without port', () => {
  assert.equal(originPatternForEndpoint('https://api.example.com/v1/chat/completions'), 'https://api.example.com/*');
  assert.equal(originPatternForEndpoint('http://localhost:1234/v1/chat/completions'), 'http://localhost/*');
  assert.throws(() => originPatternForEndpoint('http://example.com/v1/chat/completions'), Error);
});
