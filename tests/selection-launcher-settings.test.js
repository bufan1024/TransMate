import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SELECTION_LAUNCHER_KEY, SELECTION_LAUNCHER_ORIGINS, selectionLauncherAllowed, syncSelectionLauncher,
} from '../lib/selection-launcher-settings.js';

function fixture() {
  let enabled;
  let granted = false;
  const registered = new Map();
  const calls = [];
  const api = {
    storage: { local: { get: async () => ({ [SELECTION_LAUNCHER_KEY]: enabled }) } },
    permissions: {
      async contains({ origins }) {
        assert.deepEqual(origins, SELECTION_LAUNCHER_ORIGINS);
        return granted;
      },
    },
    scripting: {
      async getRegisteredContentScripts({ ids }) {
        return ids.filter((id) => registered.has(id)).map((id) => registered.get(id));
      },
      async registerContentScripts(scripts) {
        for (const script of scripts) {
          assert.equal(registered.has(script.id), false);
          registered.set(script.id, script);
        }
      },
      async unregisterContentScripts({ ids }) {
        for (const id of ids) assert.equal(registered.delete(id), true);
      },
      async executeScript({ target, files }) { calls.push(['inject', target.tabId, files]); },
    },
    tabs: {
      async query() {
        return [
          { id: 1, url: 'https://example.test/article' },
          { id: 2, url: 'https://chromewebstore.google.com/' },
          { id: 3, url: 'chrome://settings/' },
        ];
      },
      async sendMessage(id, message) { calls.push(['state', id, message.enabled]); },
    },
  };
  return {
    api, registered, calls,
    setPreference(value) { enabled = value; },
    setPermission(value) { granted = value; },
  };
}

test('launcher requires both opt-in and browser permission', async () => {
  const { api, setPreference, setPermission, registered } = fixture();
  setPermission(true);
  assert.equal(await selectionLauncherAllowed(api), false);
  setPreference(true);
  setPermission(false);
  assert.equal(await syncSelectionLauncher(api), false);
  assert.equal(registered.size, 0);
});

test('launcher is registered once and existing scripts are turned off when authorization is revoked', async () => {
  const { api, setPreference, setPermission, registered, calls } = fixture();
  setPreference(true);
  setPermission(true);
  assert.equal(await syncSelectionLauncher(api, { updateOpenTabs: true }), true);
  assert.equal(await syncSelectionLauncher(api), true);
  assert.equal(registered.size, 1);
  assert.equal(registered.values().next().value.persistAcrossSessions, true);
  assert.deepEqual(calls, [
    ['state', 1, true],
    ['inject', 1, ['selection-launcher.js']],
  ]);

  setPermission(false);
  assert.equal(await syncSelectionLauncher(api, { updateOpenTabs: true }), false);
  assert.equal(registered.size, 0);
  assert.ok(calls.some(([operation, id, value]) => operation === 'state' && id === 1 && value === false));
});
