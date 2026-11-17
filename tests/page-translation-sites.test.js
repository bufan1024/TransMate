import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAGE_TRANSLATION_SITES, canAutomaticallyTranslate, disablePageTranslationSite, enablePageTranslationSite,
  forgetRevokedTranslationSites, pageTranslationSite, storedSites,
} from '../lib/page-translation-sites.js';

function fakeStore(origins = [], settings, serviceProfiles) {
  const data = { [PAGE_TRANSLATION_SITES]: origins, settings, serviceProfiles };
  const storage = {
    get: async (keys) => Object.fromEntries([keys].flat().map((key) => [key, data[key]])),
    set: async (values) => { Object.assign(data, values); },
  };
  return { data, storage };
}

function fakePermissions(...patterns) {
  const granted = new Set(patterns);
  const removed = [];
  const api = {
    contains: async ({ origins }) => origins.every((origin) => granted.has(origin)),
    getAll: async () => ({ origins: [...granted] }),
    remove: async ({ origins }) => { removed.push(...origins); return origins.every((origin) => granted.delete(origin)); },
  };
  return { api, granted, removed };
}

test('site preferences retain precise origins while requesting only their scheme and host', () => {
  assert.deepEqual(pageTranslationSite('https://example.test:8143/path?secret=x#hash'),
    { origin: 'https://example.test:8143', pattern: 'https://example.test/*' });
  assert.deepEqual(pageTranslationSite('http://localhost:5000/article'),
    { origin: 'http://localhost:5000', pattern: 'http://localhost/*' });
  for (const invalid of [
    'http://example.test', 'https://*.example.test', 'https://user:pass@example.test',
    'file:///tmp/example', 'https://chromewebstore.google.com/detail/test', 'https://chrome.google.com/webstore/detail/test',
  ]) {
    assert.equal(pageTranslationSite(invalid), null);
  }
  assert.deepEqual(storedSites(['https://example.test/', 'https://example.test', 'https://example.test']), [
    { origin: 'https://example.test', pattern: 'https://example.test/*' },
  ]);
});

test('site translation requires an exact opt-in and an existing permission', async () => {
  const site = pageTranslationSite('https://example.test:8443/read');
  const otherPort = pageTranslationSite('https://example.test:8444/read');
  const { data, storage } = fakeStore();
  const { api, granted } = fakePermissions();
  assert.equal(await canAutomaticallyTranslate(site, storage, api), false);
  await assert.rejects(enablePageTranslationSite(site, storage, api), /授权已变更/);
  assert.deepEqual(data[PAGE_TRANSLATION_SITES], []);
  granted.add(site.pattern);
  await enablePageTranslationSite(site, storage, api);
  assert.deepEqual(data[PAGE_TRANSLATION_SITES], [site.origin]);
  assert.equal(await canAutomaticallyTranslate(site, storage, api), true);
  assert.equal(await canAutomaticallyTranslate(otherPort, storage, api), false);
  granted.clear();
  assert.equal(await canAutomaticallyTranslate(site, storage, api), false);
  await forgetRevokedTranslationSites(storage, api);
  assert.deepEqual(data[PAGE_TRANSLATION_SITES], []);
});

test('disabling a site retains a grant used by another port or the configured AI service', async () => {
  const site = pageTranslationSite('https://example.test:8443/read');
  const otherPort = pageTranslationSite('https://example.test:8444/read');
  const { data, storage } = fakeStore([site.origin, otherPort.origin], {
    apiKey: 'saved-key', endpoint: 'https://example.test/v1/chat/completions', model: 'test-model', targetLanguage: 'zh-CN',
  });
  const { api, removed } = fakePermissions(site.pattern);
  await disablePageTranslationSite(site, storage, api);
  assert.deepEqual(data[PAGE_TRANSLATION_SITES], [otherPort.origin]);
  assert.deepEqual(removed, []);
  await disablePageTranslationSite(otherPort, storage, api);
  assert.deepEqual(data[PAGE_TRANSLATION_SITES], []);
  assert.deepEqual(removed, []);
  data.settings = null;
  await enablePageTranslationSite(site, storage, api);
  await disablePageTranslationSite(site, storage, api);
  assert.deepEqual(removed, [site.pattern]);
});

test('disabling a site retains a grant used by an inactive unauthenticated local profile', async () => {
  const site = pageTranslationSite('http://localhost:8443/read');
  const activeSettings = {
    apiKey: 'saved-key', endpoint: 'https://example.test/v1/chat/completions', model: 'test-model', targetLanguage: 'zh-CN',
  };
  const inactiveSettings = {
    provider: 'custom', authType: 'none', endpoint: 'http://localhost:8000/translate',
    model: 'local-test-model', targetLanguage: 'zh-CN',
  };
  const { data, storage } = fakeStore([site.origin], activeSettings, {
    activeId: 'active',
    profiles: [
      { id: 'active', name: 'Active', settings: activeSettings },
      { id: 'local', name: 'Local', settings: inactiveSettings },
    ],
  });
  const { api, removed } = fakePermissions(site.pattern);
  assert.equal(await disablePageTranslationSite(site, storage, api), true);
  assert.deepEqual(data[PAGE_TRANSLATION_SITES], []);
  assert.deepEqual(removed, []);
});
