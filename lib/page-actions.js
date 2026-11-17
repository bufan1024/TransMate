import { translatePage } from './page-ai.js';
import { GLOSSARY_STORAGE_KEY } from './glossary.js';

export const PAGE_TRANSLATION_MENU = 'translate-page';
export const PAGE_SUMMARY_MENU = 'summarize-page';
export const PANEL_PAGE_ACTION = 'TRANSMATE_PANEL_PAGE_ACTION';
export const PAGE_SUMMARY_PREFIX = 'pendingPageSummary:';
export const PAGE_SUMMARY_MAX_AGE_MS = 30_000;

const PAGE_UNAVAILABLE = '无法读取当前网页。请在普通网页上重试。';
const PAGE_TRANSLATION_PREFIX = 'pageTranslation:';
const WORKER_ACTIVITY_INTERVAL_MS = 15_000;

function translationKey(tabId, requestId) {
  return `${PAGE_TRANSLATION_PREFIX}${tabId}:${requestId}`;
}

async function getSource(chromeApi, tabId) {
  const [injection] = await chromeApi.scripting.executeScript({
    target: { tabId, frameIds: [0] }, files: ['page-content.js'],
  });
  if (!injection?.documentId) throw new Error(PAGE_UNAVAILABLE);
  return { tabId, documentId: injection.documentId };
}

function sendPageMessage(chromeApi, source, type, details) {
  const { tabId, documentId } = source;
  return chromeApi.tabs.sendMessage(tabId, { type, ...details }, { documentId });
}

export async function readPage(chromeApi, source, requestId, mode) {
  let page;
  try {
    page = await sendPageMessage(chromeApi, source, 'TRANSMATE_PAGE_READ', { requestId, mode });
  } catch {
    throw new Error(PAGE_UNAVAILABLE);
  }
  if (!page?.ok) throw new Error(page?.error || PAGE_UNAVAILABLE);
  if (!page.blocks?.length) throw new Error('当前网页没有可读取的正文。');
  return page;
}

export function createPageActions(chromeApi, {
  privateStorageReady, nextOrder, isInjectableUrl, translatePageImpl = translatePage,
}) {
  const translations = new Map();
  const summaryIntents = new Map();
  let settingsInvalidatedBefore = 0;

  function send(entry, type, details) {
    return sendPageMessage(chromeApi, entry.source, type, { requestId: entry.requestId, ...details });
  }

  function forget(entry) {
    return chromeApi.storage.session.remove(translationKey(entry.tabId, entry.requestId)).catch(() => {});
  }

  function cancel(tabId, { clear = true } = {}) {
    const entry = translations.get(tabId);
    if (!entry) return;
    translations.delete(tabId);
    entry.controller.abort();
    void forget(entry);
    if (clear && entry.source) void send(entry, 'TRANSMATE_PAGE_CLEAR').catch(() => {});
  }

  async function clearStored({ tabId, clear = true, before = Infinity } = {}) {
    const prefix = tabId === undefined ? PAGE_TRANSLATION_PREFIX : `${PAGE_TRANSLATION_PREFIX}${tabId}:`;
    const stored = await chromeApi.storage.session.get(null);
    await Promise.allSettled(Object.entries(stored).filter(([key, record]) => key.startsWith(prefix)
      && record?.order <= before && translations.get(record.tabId)?.requestId !== record.requestId)
      .map(async ([key, record]) => {
        await chromeApi.storage.session.remove(key);
        if (clear) await send({ requestId: record.requestId, source: record }, 'TRANSMATE_PAGE_CLEAR');
      }));
  }

  function leavePage(tabId, options) {
    cancel(tabId, options);
    void clearStored({ tabId, ...options }).catch(() => {});
    for (const [windowId, intent] of summaryIntents) {
      if (intent.tabId === tabId) summaryIntents.delete(windowId);
    }
  }

  async function status(entry, status, message) {
    const response = await send(entry, 'TRANSMATE_PAGE_STATUS', { status, message });
    if (!response?.ok) throw new Error(PAGE_UNAVAILABLE);
  }

  async function failTranslation(entry, error) {
    if (entry.controller.signal.aborted) return;
    entry.ready = false;
    await forget(entry);
    if (!entry.controller.signal.aborted && entry.shown) {
      await status(entry, 'error', error?.message || '网页翻译失败，请重试。').catch(() => {});
    }
  }

  async function runDemand(entry) {
    if (!entry.ready) return;
    if (entry.running) {
      entry.moreRequested = true;
      return;
    }
    entry.running = true;
    const { signal } = entry.controller;
    try {
      while (!signal.aborted) {
        entry.moreRequested = false;
        const page = await send(entry, 'TRANSMATE_PAGE_NEXT');
        if (signal.aborted) return;
        if (!page?.ok) throw new Error(page?.error || PAGE_UNAVAILABLE);
        const { blocks, completed, total, truncated } = page;
        if (!blocks.length) {
          const scope = truncated ? '已达到网页内容上限。' : '';
          const finished = completed === total;
          const hint = finished ? '' : '继续滚动以翻译其他正文。';
          await status(entry, finished ? 'success' : 'paused', `已翻译 ${completed} 段。${hint}${scope}`);
          if (!entry.moreRequested || finished) return;
          continue;
        }

        const { settings, [GLOSSARY_STORAGE_KEY]: glossary } = await chromeApi.storage.local.get([
          'settings', GLOSSARY_STORAGE_KEY,
        ]);
        if (signal.aborted) return;
        await status(entry, 'translating', `正在翻译正文（${completed} / ${total} 段）…`);
        if (signal.aborted) return;
        let lastExtensionCall = Date.now();
        await translatePageImpl({
          blocks, settings, glossary, signal, permissionsApi: chromeApi.permissions,
          onStreamActivity: () => {
            const now = Date.now();
            if (signal.aborted || now - lastExtensionCall < WORKER_ACTIVITY_INTERVAL_MS) return;
            lastExtensionCall = now;
            // A stream can be active for a long paragraph before it has a complete line to display.
            void chromeApi.storage.session.get(translationKey(entry.tabId, entry.requestId)).catch(() => {});
          },
          onChunk: async (translations) => {
            if (signal.aborted) return;
            lastExtensionCall = Date.now();
            const response = await send(entry, 'TRANSMATE_PAGE_APPEND', { translations });
            if (signal.aborted) return;
            if (!response?.ok) throw new Error(response?.error || '无法显示译文，请重试。');
            await status(entry, 'translating', `正在翻译正文（${response.completed} / ${total} 段）…`);
          },
        });
      }
    } catch (error) {
      await failTranslation(entry, error);
    } finally {
      entry.running = false;
    }
  }

  async function startTranslation(tab, { waitForDemand = true } = {}) {
    if (!Number.isInteger(tab?.id) || !isInjectableUrl(tab.url)) return;
    cancel(tab.id);
    void clearStored({ tabId: tab.id }).catch(() => {});
    const controller = new AbortController();
    const entry = {
      tabId: tab.id, requestId: crypto.randomUUID(), order: nextOrder(), controller,
      source: null, shown: false, ready: false, running: false, moreRequested: false,
    };
    translations.set(tab.id, entry);
    const { signal } = controller;
    try {
      if (!await privateStorageReady || signal.aborted) return;
      entry.source = await getSource(chromeApi, tab.id);
      if (signal.aborted) return;
      await status(entry, 'reading', '正在读取网页正文…');
      entry.shown = true;
      if (signal.aborted) return;
      const page = await send(entry, 'TRANSMATE_PAGE_READ', { mode: 'translation' });
      if (signal.aborted) return;
      if (!page?.ok) throw new Error(page?.error || PAGE_UNAVAILABLE);
      // Retain the opt-in and document identity through worker idle, never the page text.
      await chromeApi.storage.session.set({
        [translationKey(entry.tabId, entry.requestId)]: {
          ...entry.source, requestId: entry.requestId, order: entry.order,
        },
      });
      if (signal.aborted) {
        await forget(entry);
        return;
      }
      entry.ready = true;
      const demand = runDemand(entry);
      if (waitForDemand) await demand;
      return true;
    } catch (error) {
      await failTranslation(entry, error);
    } finally {
      if (!entry.shown && translations.get(tab.id) === entry) translations.delete(tab.id);
    }
  }

  async function openSummary(tab, { panelIsOpen = false } = {}) {
    if (!Number.isInteger(tab?.id) || !Number.isInteger(tab.windowId)) return;
    const { id: tabId, windowId } = tab;
    const requestId = crypto.randomUUID();
    const order = nextOrder();
    const intent = { requestId, tabId };
    summaryIntents.set(windowId, intent);
    try {
      // Open before awaiting so the menu or keyboard gesture is preserved.
      const panel = panelIsOpen ? undefined : chromeApi.sidePanel.open({ windowId });
      const source = privateStorageReady.then((ready) => {
        if (ready && summaryIntents.get(windowId) === intent && isInjectableUrl(tab.url)) {
          return getSource(chromeApi, tabId).catch(() => null);
        }
      });
      const [, page] = await Promise.all([panel, source]);
      if (summaryIntents.get(windowId) !== intent || (panelIsOpen && !page)) return;
      const key = `${PAGE_SUMMARY_PREFIX}${windowId}:${requestId}`;
      await chromeApi.storage.session.set({
        [key]: {
          requestId, windowId, tabId, order, createdAt: Date.now(),
          documentId: page?.documentId || null,
        },
      });
      return true;
    } finally {
      if (summaryIntents.get(windowId) === intent) summaryIntents.delete(windowId);
    }
  }

  function matchesDocument(entry, message, sender) {
    return entry?.requestId === message.requestId && entry.order > settingsInvalidatedBefore
      && entry.source?.documentId === sender.documentId;
  }

  async function handleMessage(message, sender) {
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(tabId) || sender.frameId !== 0 || !sender.documentId
        || typeof message.requestId !== 'string' || !message.requestId) return;
    let entry = translations.get(tabId);
    if (!entry) {
      if (!await privateStorageReady) return;
      const key = translationKey(tabId, message.requestId);
      const saved = (await chromeApi.storage.session.get(key))[key];
      entry = translations.get(tabId);
      if (!entry && saved?.tabId === tabId) {
        entry = {
          ...saved, source: saved, controller: new AbortController(), shown: true,
          ready: true, running: false, moreRequested: false,
        };
        if (matchesDocument(entry, message, sender)) translations.set(tabId, entry);
      }
    }
    if (!matchesDocument(entry, message, sender)) return;
    if (message.type === 'TRANSMATE_PAGE_CANCEL') cancel(tabId, { clear: false });
    else await runDemand(entry);
  }

  function cancelAll() {
    settingsInvalidatedBefore = nextOrder();
    for (const tabId of translations.keys()) cancel(tabId);
    void clearStored({ before: settingsInvalidatedBefore }).catch(() => {});
  }

  return { startTranslation, openSummary, handleMessage, leavePage, cancelAll };
}
