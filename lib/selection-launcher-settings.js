import { isInjectableUrl } from './selection.js';

export const SELECTION_LAUNCHER_KEY = 'selectionLauncherEnabled';
export const SELECTION_LAUNCHER_ORIGINS = ['https://*/*', 'http://*/*'];

const SCRIPT_ID = 'selection-launcher';
const SCRIPT_FILE = 'selection-launcher.js';
const STATE_MESSAGE = 'TRANSMATE_SELECTION_LAUNCHER_STATE';
const EXCLUDED_MATCHES = ['*://chromewebstore.google.com/*', '*://chrome.google.com/webstore*'];

export async function selectionLauncherAllowed(chromeApi) {
  const { [SELECTION_LAUNCHER_KEY]: enabled } = await chromeApi.storage.local.get(SELECTION_LAUNCHER_KEY);
  return enabled === true && await chromeApi.permissions.contains({ origins: SELECTION_LAUNCHER_ORIGINS });
}

async function syncOpenTabs(chromeApi, enabled) {
  const tabs = await chromeApi.tabs.query(enabled ? { url: SELECTION_LAUNCHER_ORIGINS } : {});
  await Promise.allSettled(tabs.filter(({ id, url }) =>
    Number.isInteger(id) && (!enabled || isInjectableUrl(url)),
  ).map(async ({ id }) => {
    // Unregistering only prevents future injections; update scripts already in open frames.
    await chromeApi.tabs.sendMessage(id, { type: STATE_MESSAGE, enabled }).catch(() => {});
    if (enabled) {
      await chromeApi.scripting.executeScript({
        target: { tabId: id }, files: [SCRIPT_FILE], injectImmediately: true,
      });
    }
  }));
}

// Serialize callers with the same settings lock used to change the preference.
export async function syncSelectionLauncher(chromeApi, { updateOpenTabs = false } = {}) {
  const enabled = await selectionLauncherAllowed(chromeApi);
  const { scripting } = chromeApi;
  const ids = [SCRIPT_ID];
  try {
    const [registered] = await scripting.getRegisteredContentScripts({ ids });
    if (enabled && !registered) {
      await scripting.registerContentScripts([{
        id: SCRIPT_ID,
        matches: SELECTION_LAUNCHER_ORIGINS,
        excludeMatches: EXCLUDED_MATCHES,
        js: [SCRIPT_FILE],
        allFrames: true,
        runAt: 'document_idle',
        persistAcrossSessions: true,
      }]);
    } else if (!enabled && registered) {
      await scripting.unregisterContentScripts({ ids });
    }
  } finally {
    if (updateOpenTabs) await syncOpenTabs(chromeApi, enabled);
  }
  return enabled;
}
