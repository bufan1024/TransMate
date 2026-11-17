import { message as localize } from './lib/i18n.js';
import { withSettingsLock } from './lib/settings-management.js';
import {
  SELECTION_LAUNCHER_KEY, SELECTION_LAUNCHER_ORIGINS, selectionLauncherAllowed, syncSelectionLauncher,
} from './lib/selection-launcher-settings.js';

const toggle = document.querySelector('#selection-launcher-enabled');
const status = document.querySelector('#selection-launcher-status');
let busy = false;
let revision = 0;

function show(message, tone) {
  status.textContent = message;
  status.dataset.tone = tone;
  status.hidden = false;
}

async function refresh() {
  const version = ++revision;
  try {
    const enabled = await selectionLauncherAllowed(chrome);
    if (revision === version && !busy) toggle.checked = enabled;
  } catch {
    if (revision === version && !busy) {
      show(localize('selectionLauncherReadError', '无法读取划词图标设置，请重新打开设置页。'), 'error');
    }
  } finally {
    if (revision === version && !busy) toggle.disabled = false;
  }
}

toggle.addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  revision += 1;
  toggle.disabled = true;
  const enable = toggle.checked;
  try {
    // Host permissions must be requested from the original user gesture.
    if (enable && !await chrome.permissions.request({ origins: SELECTION_LAUNCHER_ORIGINS })) {
      show(localize('selectionLauncherDenied', 'Chrome 未授予网页访问权限，划词图标未启用。'), 'error');
      return;
    }
    const enabled = await withSettingsLock(navigator.locks, async () => {
      if (enable && !await chrome.permissions.contains({ origins: SELECTION_LAUNCHER_ORIGINS })) {
        throw new Error('Selection launcher permissions changed');
      }
      const storage = chrome.storage.local;
      await storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      await storage.set({ [SELECTION_LAUNCHER_KEY]: enable });
      try {
        const registered = await syncSelectionLauncher(chrome, { updateOpenTabs: true });
        if (enable && !registered) throw new Error('Selection launcher permissions changed');
        return registered;
      } catch (error) {
        if (enable) {
          await storage.set({ [SELECTION_LAUNCHER_KEY]: false });
          await syncSelectionLauncher(chrome, { updateOpenTabs: true }).catch(() => {});
        }
        throw error;
      }
    });
    show(enabled
      ? localize('selectionLauncherOn', '已启用。选中文字后，点击旁边的 TransMate 图标即可翻译。')
      : localize('selectionLauncherOff', '已关闭划词图标。网页访问权限可在已授权的域名列表中管理。'), 'success');
  } catch {
    show(localize('selectionLauncherSaveError', '无法更新划词图标设置，请检查 Chrome 的网页访问权限后重试。'), 'error');
  } finally {
    busy = false;
    await refresh();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SELECTION_LAUNCHER_KEY] && !busy) void refresh();
});
chrome.permissions.onAdded?.addListener(() => { if (!busy) void refresh(); });
chrome.permissions.onRemoved?.addListener(() => { if (!busy) void refresh(); });
void refresh();
