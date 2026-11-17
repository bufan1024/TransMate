import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canReuseSavedKey,
  resolveSettings,
  revokeGrantedOrigin,
  withSettingsLock,
} from '../lib/settings-management.js';

const saved = {
  provider: 'custom',
  endpoint: 'https://old.example/v1/chat/completions',
  apiKey: 'private-key',
  model: 'model-a',
  targetLanguage: 'zh-CN',
  prompt: '',
};

const next = {
  ...saved,
  provider: 'openai',
  endpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: 'new-private-key',
};

test('blank key is reused only for the same provider and complete endpoint', () => {
  const draft = { ...saved, apiKey: '', model: 'model-b' };
  assert.equal(canReuseSavedKey(draft, saved), true);
  assert.equal(resolveSettings(draft, saved).apiKey, 'private-key');
  assert.equal(resolveSettings(draft, saved).model, 'model-b');
  assert.equal(canReuseSavedKey({ ...draft, provider: 'openai' }, saved), false);
  assert.equal(canReuseSavedKey({ ...draft, endpoint: 'https://old.example/v2/chat/completions' }, saved), false);
  assert.equal(canReuseSavedKey(draft, { ...saved, apiKey: '' }), false);
  assert.throws(() => resolveSettings({ ...draft, provider: 'openai' }, saved), /API Key/);
  assert.throws(() => resolveSettings({ ...draft, endpoint: 'https://old.example/v2/chat/completions' }, saved), /API Key/);
});

test('typed key replaces the saved key for a new service', () => {
  assert.equal(resolveSettings({ ...next, apiKey: '  new-private-key  ' }, saved).apiKey, 'new-private-key');
});

test('saved credentials are reused only with the same authentication method', () => {
  const headerProfile = { ...saved, authType: 'x-api-key' };
  assert.equal(resolveSettings({ ...headerProfile, apiKey: '' }, headerProfile).apiKey, saved.apiKey);
  assert.equal(canReuseSavedKey({ ...headerProfile, apiKey: '' }, saved), false);
  assert.equal(canReuseSavedKey({ ...headerProfile, authType: 'api-key' }, headerProfile), false);
  assert.throws(() => resolveSettings({ ...headerProfile, authType: 'api-key', apiKey: '' }, headerProfile), /API Key/);
  assert.equal(canReuseSavedKey({ ...saved, authType: 'bearer' }, saved), true);
  const local = { ...saved, endpoint: 'http://localhost:5000/complete', authType: 'none', apiKey: '' };
  assert.deepEqual(resolveSettings(local, saved), local);
});

test('an Azure key can be reused only for an equivalent URL on the same configured resource', () => {
  const resource = 'https://resource-a.openai.azure.com';
  const endpoint = resource + '/openai/v1/chat/completions';
  const azure = { ...saved, provider: 'azure-openai', endpoint, authType: 'api-key' };
  const draft = { ...azure, endpoint: resource + '/openai/v1/', apiKey: '', authType: undefined, model: 'deployment-b' };
  assert.deepEqual(resolveSettings(draft, azure), { ...azure, model: 'deployment-b' });
  for (const changed of [
    { endpoint: 'https://resource-b.openai.azure.com' },
    { endpoint: 'https://resource-a.services.ai.azure.com' },
    { endpoint: 'https://resource-a.openai.azure.com:8443' },
    { provider: 'custom', endpoint, authType: 'api-key' },
    { authType: 'bearer' },
  ]) {
    assert.equal(canReuseSavedKey({ ...draft, ...changed }, azure), false);
  }
});

test('manual removal targets only a currently granted exact origin', async () => {
  const calls = [];
  const permissionsApi = {
    getAll: async () => ({ origins: ['https://old.example/*'] }),
    remove: async ({ origins }) => { calls.push(origins); return true; },
  };
  assert.equal(await revokeGrantedOrigin('https://old.example/*', permissionsApi), true);
  assert.equal(await revokeGrantedOrigin('https://other.example/*', permissionsApi), false);
  assert.deepEqual(calls, [['https://old.example/*']]);
});

test('settings mutation fails closed when Web Locks are unavailable', async () => {
  let changed = false;
  await assert.rejects(
    withSettingsLock(undefined, async () => { changed = true; }),
    /不支持安全的多页面设置操作/,
  );
  assert.equal(changed, false);
});
