import { selectionStorageKey, selectionWindowIdFromKey, shouldAcceptSelection } from './lib/selection.js';

const MENU_ID = 'translate-selection';

export function registerBackground(chromeApi) {
  let lastSelectionOrder = 0;

  chromeApi.runtime.onInstalled.addListener(() => {
    chromeApi.contextMenus.create({
      id: MENU_ID,
      title: '用 TransMate 翻译',
      contexts: ['selection'],
    });
  });

  chromeApi.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => console.warn('无法设置侧边栏打开方式'));

  chromeApi.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID || !info.selectionText?.trim() || !Number.isInteger(tab?.windowId)) return;

    const createdAt = Date.now();
    lastSelectionOrder = Math.max(createdAt * 1000, lastSelectionOrder + 1);
    const pendingSelection = {
      id: crypto.randomUUID(),
      text: info.selectionText.trim(),
      createdAt,
      order: lastSelectionOrder,
      windowId: tab.windowId,
    };
    const key = selectionStorageKey(tab.windowId, pendingSelection.id);
    // Keep the user gesture available for sidePanel.open; the panel also listens
    // for storage changes, so either completion order is safe.
    chromeApi.storage.session
      .set({ [key]: pendingSelection })
      .catch(() => console.warn('无法保存选中的文字'));
    chromeApi.sidePanel
      .open({ windowId: tab.windowId })
      .catch(() => console.warn('无法打开翻译侧边栏'));

    // Each event has its own key, so cleaning old events cannot remove a new one.
    chromeApi.storage.session.get(null).then((items) => {
      const expiredKeys = Object.entries(items).filter(([itemKey, item]) => {
        const windowId = selectionWindowIdFromKey(itemKey);
        return windowId !== null && !shouldAcceptSelection(item, windowId);
      }).map(([itemKey]) => itemKey);
      if (expiredKeys.length) return chromeApi.storage.session.remove(expiredKeys);
    }).catch(() => console.warn('无法清理过期选文'));
  });
}

if (typeof chrome !== 'undefined') registerBackground(chrome);
