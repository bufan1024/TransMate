import assert from 'node:assert/strict';
import test from 'node:test';

import * as profiles from '../lib/settings-management.js';

const original = {
  provider: 'custom',
  endpoint: 'https://old.example/v1/chat/completions',
  apiKey: 'legacy-key',
  model: 'model-a',
  targetLanguage: 'zh-CN',
  prompt: '',
};
const second = {
  ...original,
  endpoint: 'https://new.example/v1/chat/completions',
  apiKey: 'second-key',
  model: 'model-b',
};
const oldOrigin = 'https://old.example/*';
const newOrigin = 'https://new.example/*';
const unrelatedOrigin = 'https://canceled-test.example/*';

function fixture(settings = original, grantList = [oldOrigin, newOrigin]) {
  const store = settings ? { settings } : {};
  const origins = new Set(grantList);
  const writes = [];
  let queue = Promise.resolve();
  let trusted = false;
  const storageArea = {
    async get() { return structuredClone(store); },
    async setAccessLevel({ accessLevel }) { trusted = accessLevel === 'TRUSTED_CONTEXTS'; },
    async set(fields) {
      assert.equal(trusted, true, 'credentials must be written to trusted storage');
      writes.push(structuredClone(fields));
      Object.assign(store, structuredClone(fields));
    },
    async remove(keys) {
      for (const key of [keys].flat()) delete store[key];
    },
  };
  const permissionsApi = {
    async contains({ origins: requested }) { return requested.every((origin) => origins.has(origin)); },
    async getAll() { return { origins: [...origins] }; },
    async remove({ origins: removed }) {
      for (const origin of removed) origins.delete(origin);
      return true;
    },
  };
  const lockManager = {
    request(name, { mode }, op) {
      assert.equal(name, 'transmate-settings');
      assert.equal(mode, 'exclusive');
      const operation = queue.then(op);
      queue = operation.catch(() => {});
      return operation;
    },
  };
  return { store, origins, writes, storageArea, permissionsApi, lockManager };
}

test('creating a second profile migrates the legacy key and keeps the active settings projection', async () => {
  const env = fixture();
  const { profile } = await profiles.saveSettingsWithPermission({
    ...env, profileId: null, name: '备用配置', draft: second,
  });
  assert.deepEqual(env.store.settings, original);
  assert.equal(env.writes.length, 1);
  assert.deepEqual(Object.keys(env.writes[0]).sort(), ['serviceProfiles', 'settings']);
  assert.equal(env.store.serviceProfiles.profiles.length, 2);
  const migrated = env.store.serviceProfiles.profiles.find(({ id }) => id === env.store.serviceProfiles.activeId);
  assert.deepEqual(migrated.settings, original);
  assert.deepEqual(profile.settings, second);
  assert.deepEqual([...env.origins], [oldOrigin, newOrigin]);
});

test('a first saved profile becomes active, and another profile cannot borrow its key', async () => {
  const env = fixture(null);
  const { profile } = await profiles.saveSettingsWithPermission({
    ...env, profileId: null, name: '常用配置', draft: original,
  });
  assert.equal(env.store.serviceProfiles.activeId, profile.id);
  assert.deepEqual(env.store.settings, original);
  await assert.rejects(() => profiles.saveSettingsWithPermission({
    ...env, profileId: null, name: '名称不同的新配置', draft: { ...original, apiKey: '' },
  }), /API Key/);
  assert.equal(env.store.serviceProfiles.profiles.length, 1);
});

test('settings and active metadata change together when switching profiles', async () => {
  const env = fixture();
  const { profile } = await profiles.saveSettingsWithPermission({
    ...env, profileId: null, name: '备用配置', draft: second,
  });
  const { state } = await profiles.activateServiceProfile({ ...env, profileId: profile.id, expectedOrigin: newOrigin });
  assert.equal(state.activeId, profile.id);
  assert.deepEqual(env.writes.at(-1), { settings: second, serviceProfiles: state });
  assert.deepEqual([...env.origins], [oldOrigin, newOrigin]);
});

test('shared grants remain until the last usable profile releases them', async () => {
  const env = fixture(original, [oldOrigin, newOrigin, unrelatedOrigin]);
  const { profile: shared, state } = await profiles.saveSettingsWithPermission({
    ...env, profileId: null, name: '共享域名', draft: { ...original, endpoint: 'https://old.example/other/chat/completions' },
  });
  const before = state.activeId;
  const { profile: other } = await profiles.saveSettingsWithPermission({
    ...env, profileId: null, name: '独立域名', draft: second,
  });
  await profiles.clearServiceProfileKey({ ...env, profileId: before });
  assert.equal(env.store.settings.apiKey, '');
  assert.equal(env.store.serviceProfiles.activeId, before, 'clearing a key does not change the active provider');
  assert.deepEqual([...env.origins], [oldOrigin, newOrigin, unrelatedOrigin]);

  await profiles.deleteServiceProfile({ ...env, profileId: shared.id });
  assert.deepEqual([...env.origins], [newOrigin, unrelatedOrigin]);
  await profiles.deleteServiceProfile({ ...env, profileId: before });
  assert.equal(env.store.serviceProfiles.activeId, other.id);
  assert.deepEqual(env.store.settings, second);
  await profiles.deleteServiceProfile({ ...env, profileId: other.id });
  assert.deepEqual(env.store, {});
  assert.deepEqual([...env.origins], [unrelatedOrigin]);
});

test('saving the same host retains its grant, while changing hosts retires only the orphan', async () => {
  const env = fixture(original, [oldOrigin, newOrigin, unrelatedOrigin]);
  const { activeId } = await profiles.readServiceProfiles(env.storageArea);
  const getAll = env.permissionsApi.getAll;
  env.permissionsApi.getAll = async () => {
    assert.equal(env.store.settings.endpoint, second.endpoint, 'the new settings are committed before cleanup');
    return getAll();
  };
  await profiles.saveSettingsWithPermission({
    ...env, profileId: activeId, name: '同域名', draft: { ...original, endpoint: 'https://old.example/other/chat/completions' },
  });
  assert.deepEqual([...env.origins], [oldOrigin, newOrigin, unrelatedOrigin]);
  await profiles.saveSettingsWithPermission({ ...env, profileId: activeId, name: '切换域名', draft: second });
  assert.deepEqual([...env.origins], [newOrigin, unrelatedOrigin]);
});

test('a keyless local configuration keeps its host grant until the profile is deleted', async () => {
  const localOrigin = 'http://127.0.0.1/*';
  const local = {
    ...original, endpoint: 'http://127.0.0.1:5000/complete', authType: 'none', apiKey: '',
  };
  const env = fixture(original, [oldOrigin, localOrigin]);
  const checked = [];
  const contains = env.permissionsApi.contains;
  env.permissionsApi.contains = (request) => {
    checked.push(...request.origins);
    return contains(request);
  };
  const { activeId } = await profiles.readServiceProfiles(env.storageArea);
  const { profile } = await profiles.saveSettingsWithPermission({
    ...env, profileId: null, name: '本机服务', draft: { ...local, apiKey: original.apiKey },
  });
  await profiles.activateServiceProfile({ ...env, profileId: profile.id, expectedOrigin: localOrigin });
  assert.deepEqual(env.store.settings, local);
  assert.deepEqual(checked, [localOrigin, localOrigin]);

  await profiles.deleteServiceProfile({ ...env, profileId: activeId });
  assert.deepEqual([...env.origins], [localOrigin]);
  assert.equal((await profiles.clearServiceProfileKey({ ...env, profileId: profile.id })).noKey, true);
  assert.deepEqual([...env.origins], [localOrigin]);
  await profiles.deleteServiceProfile({ ...env, profileId: profile.id });
  assert.deepEqual([...env.origins], []);
});

test('failed persistence leaves grants untouched and failed permission cleanup reports partial success', async () => {
  const env = fixture();
  const { activeId } = await profiles.readServiceProfiles(env.storageArea);
  const set = env.storageArea.set;
  env.storageArea.set = async () => { throw new Error('storage failure'); };
  const change = { ...env, profileId: activeId, name: '新域名', draft: second };
  await assert.rejects(() => profiles.saveSettingsWithPermission(change), /storage failure/);
  assert.deepEqual([...env.origins], [oldOrigin, newOrigin]);
  assert.deepEqual(env.store.settings, original);

  env.storageArea.set = set;
  env.permissionsApi.remove = async () => false;
  const { cleanupFailed } = await profiles.saveSettingsWithPermission(change);
  assert.equal(cleanupFailed, true);
  assert.deepEqual(env.store.settings, second);
  assert.deepEqual([...env.origins], [oldOrigin, newOrigin]);
});

test('manual revoke leaves profiles intact, and switch must verify the grant again', async () => {
  const env = fixture();
  const { profile } = await profiles.saveSettingsWithPermission({
    ...env, profileId: null, name: '备用配置', draft: second,
  });
  assert.equal(await profiles.revokeGrantedOrigin(newOrigin, env.permissionsApi), true);
  await assert.rejects(() => profiles.activateServiceProfile({
    ...env, profileId: profile.id, expectedOrigin: newOrigin,
  }), /授权已变化/);
  assert.equal(env.store.serviceProfiles.profiles.length, 2);
  assert.deepEqual(env.store.settings, original);
});

test('switch checks the origin when another tab has edited the profile', async () => {
  const env = fixture();
  const { profile } = await profiles.saveSettingsWithPermission({
    ...env, profileId: null, name: '备用配置', draft: second,
  });
  await profiles.saveSettingsWithPermission({
    ...env, profileId: profile.id, name: '其他页面已编辑', draft: original,
  });
  await assert.rejects(() => profiles.activateServiceProfile({
    ...env, profileId: profile.id, expectedOrigin: newOrigin,
  }), /域名已变更/);
  assert.deepEqual(env.store.settings, original);
});

test('reset clears all records and grants before a queued save can recheck permissions', async () => {
  const env = fixture(original, [oldOrigin, newOrigin, unrelatedOrigin]);
  let release;
  let startCleanup;
  const entered = new Promise((resolve) => { startCleanup = resolve; });
  const getAll = env.permissionsApi.getAll;
  env.permissionsApi.getAll = async () => {
    startCleanup();
    await new Promise((resolve) => { release = resolve; });
    return getAll();
  };
  const reset = profiles.resetServiceProfiles(env);
  await entered;
  assert.deepEqual(env.store, {});
  const save = profiles.saveSettingsWithPermission({
    ...env, profileId: null, name: '另一个页面的草稿', draft: second,
  });
  const rejectedSave = assert.rejects(save, /授权已变化/);
  release();
  await reset;
  await rejectedSave;
  assert.deepEqual(env.store, {});
  assert.deepEqual([...env.origins], []);
});

test('reset removes a canceled connection test grant without any saved profiles', async () => {
  const env = fixture(null, [unrelatedOrigin]);
  assert.deepEqual(await profiles.resetServiceProfiles(env), { cleanupFailed: false });
  assert.deepEqual([...env.origins], []);
});

test('saving a host that another operation just retired requires a fresh grant', async () => {
  const env = fixture();
  const { activeId } = await profiles.readServiceProfiles(env.storageArea);
  let release;
  let startCleanup;
  const entered = new Promise((resolve) => { startCleanup = resolve; });
  const getAll = env.permissionsApi.getAll;
  env.permissionsApi.getAll = async () => {
    startCleanup();
    await new Promise((resolve) => { release = resolve; });
    return getAll();
  };
  const move = profiles.saveSettingsWithPermission({ ...env, profileId: activeId, name: '改用新域名', draft: second });
  await entered;
  const saveOld = profiles.saveSettingsWithPermission({
    ...env, profileId: null, name: '另一页面的新配置', draft: original,
  });
  const rejectedSave = assert.rejects(saveOld, /授权已变化/);
  release();
  await move;
  await rejectedSave;
  assert.equal(env.store.serviceProfiles.profiles.length, 1);
  assert.deepEqual(env.store.settings, second);
  assert.deepEqual([...env.origins], [newOrigin]);
});

test('concurrent profile edits preserve other profiles and reject a deleted edit target', async () => {
  const env = fixture();
  const { profile, state } = await profiles.saveSettingsWithPermission({
    ...env, profileId: null, name: '备用配置', draft: second,
  });
  const old = state.activeId;
  const editFirst = profiles.saveSettingsWithPermission({
    ...env, profileId: old, name: '常用配置', draft: { ...original, apiKey: '', model: 'updated-model' },
  });
  const editSecond = profiles.saveSettingsWithPermission({
    ...env, profileId: profile.id, name: '已更新备用', draft: { ...second, apiKey: '' },
  });
  await Promise.all([editFirst, editSecond]);
  assert.equal(env.store.settings.model, 'updated-model');
  assert.deepEqual(env.store.serviceProfiles.profiles.map(({ name, settings: item }) => [name, item.apiKey]), [
    ['常用配置', original.apiKey],
    ['已更新备用', second.apiKey],
  ]);
  await profiles.deleteServiceProfile({ ...env, profileId: profile.id });
  await assert.rejects(() => profiles.saveSettingsWithPermission({
    ...env, profileId: profile.id, name: '旧标签页', draft: second,
  }), /配置已被删除/);
  assert.equal(env.store.serviceProfiles.profiles.length, 1);
});
