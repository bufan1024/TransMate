import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canReuseSavedKey,
  persistSettings,
  resolveSettings,
  revokeGrantedOrigin,
} from '../lib/settings-management.js';
import * as settingsManagement from '../lib/settings-management.js';

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

test('save writes the new configuration before retiring only the exact old origin', async () => {
  const calls = [];
  const storageArea = {
    setAccessLevel: async ({ accessLevel }) => { calls.push(['access', accessLevel]); },
    set: async ({ settings }) => { calls.push(['set', settings.provider]); },
  };
  const permissionsApi = {
    getAll: async () => { calls.push(['getAll']); return { origins: ['https://old.example/*', 'https://unrelated.example/*'] }; },
    remove: async ({ origins }) => { calls.push(['remove', origins]); return true; },
  };

  const result = await persistSettings({ nextSettings: next, previousSettings: saved, storageArea, permissionsApi });
  assert.deepEqual(result, { cleanupFailed: false, retiredOrigin: 'https://old.example/*' });
  assert.deepEqual(calls, [
    ['access', 'TRUSTED_CONTEXTS'],
    ['set', 'openai'],
    ['getAll'],
    ['remove', ['https://old.example/*']],
  ]);
});

test('failed storage write leaves old host permission untouched', async () => {
  let permissionsTouched = false;
  await assert.rejects(
    persistSettings({
      nextSettings: next,
      previousSettings: saved,
      storageArea: {
        setAccessLevel: async () => {},
        set: async () => { throw new Error('storage failure'); },
      },
      permissionsApi: { getAll: async () => { permissionsTouched = true; return { origins: [] }; } },
    }),
    /storage failure/,
  );
  assert.equal(permissionsTouched, false);
});

test('failed old-origin removal reports partial success after saving', async () => {
  let savedConfig;
  const result = await persistSettings({
    nextSettings: next,
    previousSettings: saved,
    storageArea: {
      setAccessLevel: async () => {},
      set: async ({ settings }) => { savedConfig = settings; },
    },
    permissionsApi: {
      getAll: async () => ({ origins: ['https://old.example/*'] }),
      remove: async () => false,
    },
  });
  assert.equal(savedConfig, next);
  assert.deepEqual(result, { cleanupFailed: true, retiredOrigin: null });
});

test('switching endpoints on the same host keeps its permission', async () => {
  let permissionsTouched = false;
  const result = await persistSettings({
    nextSettings: { ...saved, endpoint: 'https://old.example/other/chat/completions' },
    previousSettings: saved,
    storageArea: { setAccessLevel: async () => {}, set: async () => {} },
    permissionsApi: { getAll: async () => { permissionsTouched = true; return { origins: [] }; } },
  });
  assert.deepEqual(result, { cleanupFailed: false, retiredOrigin: null });
  assert.equal(permissionsTouched, false);
});

test('reset removes configuration before retiring the old origin', async () => {
  const calls = [];
  const result = await persistSettings({
    nextSettings: null,
    previousSettings: saved,
    storageArea: { remove: async (key) => { calls.push(['storage.remove', key]); } },
    permissionsApi: {
      getAll: async () => { calls.push(['getAll']); return { origins: ['https://old.example/*', 'https://leftover.example/*'] }; },
      remove: async ({ origins }) => { calls.push(['permissions.remove', origins]); return true; },
    },
  });
  assert.deepEqual(result, { cleanupFailed: false, retiredOrigin: 'https://old.example/*' });
  assert.deepEqual(calls, [
    ['storage.remove', 'settings'],
    ['getAll'],
    ['permissions.remove', ['https://old.example/*']],
    ['permissions.remove', ['https://leftover.example/*']],
  ]);
});

test('reset removes a canceled connection test grant even when no settings remain', async () => {
  const removed = [];
  const result = await persistSettings({
    nextSettings: null,
    previousSettings: null,
    storageArea: { remove: async () => {} },
    permissionsApi: {
      getAll: async () => ({ origins: ['https://leftover.example/*'] }),
      remove: async ({ origins }) => { removed.push(...origins); return true; },
    },
  });
  assert.deepEqual(removed, ['https://leftover.example/*']);
  assert.equal(result.cleanupFailed, false);
});

test('clearing the stored key retires its unused origin', async () => {
  const result = await persistSettings({
    nextSettings: { ...saved, apiKey: '' },
    previousSettings: saved,
    storageArea: { setAccessLevel: async () => {}, set: async () => {} },
    permissionsApi: {
      getAll: async () => ({ origins: ['https://old.example/*'] }),
      remove: async () => true,
    },
  });
  assert.equal(result.retiredOrigin, 'https://old.example/*');
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

function createLockManager() {
  let previous = Promise.resolve();
  return {
    request(_name, options, callback) {
      assert.equal(options.mode, 'exclusive');
      const current = previous.then(() => callback({}));
      previous = current.then(() => {}, () => {});
      return current;
    },
  };
}

function createSharedSettings(initialSettings, initialOrigins) {
  let currentSettings = initialSettings;
  const origins = new Set(initialOrigins);
  const storageArea = {
    async get() { return currentSettings ? { settings: currentSettings } : {}; },
    async setAccessLevel() {},
    async set({ settings }) { currentSettings = settings; },
    async remove() { currentSettings = null; },
  };
  const permissionsApi = {
    async contains({ origins: requested }) { return requested.every((origin) => origins.has(origin)); },
    async getAll() { return { origins: [...origins] }; },
    async remove({ origins: removed }) {
      for (const origin of removed) origins.delete(origin);
      return true;
    },
  };
  return { storageArea, permissionsApi, origins, get settings() { return currentSettings; } };
}

test('concurrent saves cannot leave the final service without its host permission', async () => {
  const state = createSharedSettings(saved, ['https://old.example/*', 'https://api.openai.com/*']);
  const lockManager = createLockManager();
  let reads = 0;
  const read = state.storageArea.get;
  state.storageArea.get = async (...args) => { reads += 1; return read(...args); };
  let releaseFirstCleanup;
  let firstCleanupStarted;
  const reachedCleanup = new Promise((resolve) => { firstCleanupStarted = resolve; });
  const getAll = state.permissionsApi.getAll;
  let first = true;
  state.permissionsApi.getAll = async () => {
    if (first) {
      first = false;
      firstCleanupStarted();
      await new Promise((resolve) => { releaseFirstCleanup = resolve; });
    }
    return getAll();
  };

  const saveNew = settingsManagement.saveSettingsWithPermission({
    draft: next, storageArea: state.storageArea, permissionsApi: state.permissionsApi, lockManager,
  });
  await reachedCleanup;
  const saveOld = settingsManagement.saveSettingsWithPermission({
    draft: saved, storageArea: state.storageArea, permissionsApi: state.permissionsApi, lockManager,
  });
  const rejectedSaveOld = assert.rejects(saveOld, /授权已变化/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1, 'the second page must wait before reading settings');
  releaseFirstCleanup();
  await saveNew;
  await rejectedSaveOld;
  assert.equal(state.settings.endpoint, next.endpoint);
  assert.deepEqual([...state.origins], ['https://api.openai.com/*']);
});

test('a save queued behind reset cannot persist settings after its grant is revoked', async () => {
  const state = createSharedSettings(saved, ['https://old.example/*', 'https://api.openai.com/*']);
  const lockManager = createLockManager();
  let reads = 0;
  const read = state.storageArea.get;
  state.storageArea.get = async (...args) => { reads += 1; return read(...args); };
  let releaseReset;
  let resetStarted;
  const reachedReset = new Promise((resolve) => { resetStarted = resolve; });
  const reset = settingsManagement.withSettingsLock(lockManager, async () => {
    const previousSettings = (await state.storageArea.get('settings')).settings || null;
    resetStarted();
    await new Promise((resolve) => { releaseReset = resolve; });
    return persistSettings({ nextSettings: null, previousSettings, storageArea: state.storageArea, permissionsApi: state.permissionsApi });
  });
  await reachedReset;
  const saveNew = settingsManagement.saveSettingsWithPermission({
    draft: next, storageArea: state.storageArea, permissionsApi: state.permissionsApi, lockManager,
  });
  const rejectedSaveNew = assert.rejects(saveNew, /授权已变化/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1, 'the save must wait for reset before reading settings');
  releaseReset();
  await reset;
  await rejectedSaveNew;
  assert.equal(state.settings, null);
  assert.equal(state.origins.size, 0);
});

test('settings mutation fails closed when Web Locks are unavailable', async () => {
  let changed = false;
  await assert.rejects(
    settingsManagement.withSettingsLock(undefined, async () => { changed = true; }),
    /不支持安全的多页面设置操作/,
  );
  assert.equal(changed, false);
});
