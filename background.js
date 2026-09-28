const MENU_ID = 'translate-selection';

export function registerBackground(chromeApi) {
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
    if (info.menuItemId !== MENU_ID || !info.selectionText?.trim() || tab?.windowId === undefined) return;

    const pendingSelection = {
      id: crypto.randomUUID(),
      text: info.selectionText.trim(),
      createdAt: Date.now(),
      windowId: tab.windowId,
    };
    // Keep the user gesture available for sidePanel.open; the panel also listens
    // for storage changes, so either completion order is safe.
    chromeApi.storage.session
      .set({ pendingSelection })
      .catch(() => console.warn('无法保存选中的文字'));
    chromeApi.sidePanel
      .open({ windowId: tab.windowId })
      .catch(() => console.warn('无法打开翻译侧边栏'));
  });
}

if (typeof chrome !== 'undefined') registerBackground(chrome);
