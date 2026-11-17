import { translatePage } from './page-ai.js';

export const PAGE_TRANSLATION_MENU = 'translate-page';
export const PAGE_SUMMARY_MENU = 'summarize-page';
export const PAGE_SUMMARY_PREFIX = 'pendingPageSummary:';
export const PAGE_SUMMARY_MAX_AGE_MS = 30_000;

const PAGE_UNAVAILABLE = '无法读取当前网页。请在普通网页上重试。';
const PAGE_TRANSLATION_PREFIX = 'pageTranslation:';
const WORKER_ACTIVITY_INTERVAL_MS = 15_000;

class PageDisplayError extends Error {}

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

  async function persist(entry) {
    await chromeApi.storage.session.set({
      [translationKey(entry.tabId, entry.requestId)]: {
        tabId: entry.tabId, documentId: entry.source.documentId,
        requestId: entry.requestId, order: entry.order,
        ...(entry.retryable ? { retryable: true } : {}),
      },
    });
    if (entry.controller.signal.aborted) await forget(entry);
  }

  async function toolbarStatus(tabId, message = '') {
    if (!chromeApi.action) return;
    const title = message || chromeApi.runtime.getManifest?.().action?.default_title || '打开 TransMate';
    await Promise.allSettled([
      chromeApi.action.setBadgeText({ tabId, text: message ? '!' : '' }),
      chromeApi.action.setTitle({ tabId, title }),
    ]);
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
    if (options?.clear !== false) void toolbarStatus(tabId);
    void clearStored({ tabId, ...options }).catch(() => {});
    for (const [windowId, intent] of summaryIntents) {
      if (intent.tabId === tabId) summaryIntents.delete(windowId);
    }
  }

  async function status(entry, status, message) {
    const response = await send(entry, 'TRANSMATE_PAGE_STATUS', { status, message }).catch(() => null);
    if (!response?.ok) throw new PageDisplayError(PAGE_UNAVAILABLE);
  }

  async function failTranslation(entry, error, retryable = false) {
    const { signal } = entry.controller;
    if (signal.aborted) return;
    entry.ready = false;
    entry.retryable = retryable;
    if (retryable) {
      try {
        await persist(entry);
      } catch {
        entry.retryable = false;
      }
    }
    if (!entry.retryable) await forget(entry);
    if (signal.aborted) return;
    const message = error?.message || '网页翻译失败，请重试。';
    if (entry.shown) {
      try {
        await status(entry, entry.retryable ? 'retryable' : 'error', message);
        return;
      } catch {
        // Toolbar feedback remains available when the page cannot render a status.
      }
    }
    if (!signal.aborted) await toolbarStatus(entry.tabId, PAGE_UNAVAILABLE);
  }

  async function runDemand(entry, retryBatch = false) {
    if (!entry.ready) return;
    if (entry.running) {
      entry.moreRequested = true;
      return;
    }
    entry.running = true;
    const { signal } = entry.controller;
    let providerStarted = false;
    let failure;
    try {
      while (!signal.aborted) {
        entry.moreRequested = false;
        const page = await send(entry, 'TRANSMATE_PAGE_NEXT', retryBatch ? { retry: true } : undefined)
          .catch(() => null);
        if (signal.aborted) return;
        if (!page?.ok) throw new PageDisplayError(page?.error || PAGE_UNAVAILABLE);
        const { blocks, completed, total, truncated } = page;
        const wasRetry = retryBatch;
        retryBatch = false;
        if (!blocks.length) {
          if (wasRetry) continue;
          const scope = truncated ? '已达到网页内容上限。' : '';
          const finished = completed === total;
          const hint = finished ? '' : '继续滚动以翻译其他正文。';
          await status(entry, finished ? 'success' : 'paused', `已翻译 ${completed} 段。${hint}${scope}`);
          if (!entry.moreRequested || finished) return;
          continue;
        }

        const { settings } = await chromeApi.storage.local.get('settings');
        if (signal.aborted) return;
        await status(entry, 'translating', `正在翻译正文（${completed} / ${total} 段）…`);
        if (signal.aborted) return;
        let lastExtensionCall = Date.now();
        providerStarted = true;
        await translatePageImpl({
          blocks, settings, signal, permissionsApi: chromeApi.permissions,
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
            const response = await send(entry, 'TRANSMATE_PAGE_APPEND', { translations }).catch(() => null);
            if (signal.aborted) return;
            if (!response?.ok) throw new PageDisplayError(response?.error || PAGE_UNAVAILABLE);
            await status(entry, 'translating', `正在翻译正文（${response.completed} / ${total} 段）…`);
          },
        });
        providerStarted = false;
      }
    } catch (error) {
      failure = { error, retryable: providerStarted && !(error instanceof PageDisplayError) };
    } finally {
      entry.running = false;
    }
    if (failure) await failTranslation(entry, failure.error, failure.retryable);
  }

  async function retryTranslation(entry) {
    if (!entry.retryable || entry.running || entry.controller.signal.aborted) return;
    // Claim retry before awaiting storage, so it cannot race repeated clicks or scrolling.
    entry.retryable = false;
    try {
      await persist(entry);
    } catch {
      await failTranslation(entry, new Error('无法恢复网页翻译，请重新启动翻译。'));
      return;
    }
    if (entry.controller.signal.aborted) return;
    entry.ready = true;
    await runDemand(entry, true);
  }

  async function startTranslation(tab) {
    if (!Number.isInteger(tab?.id)) return;
    cancel(tab.id);
    void clearStored({ tabId: tab.id }).catch(() => {});
    if (!isInjectableUrl(tab.url)) {
      await toolbarStatus(tab.id, PAGE_UNAVAILABLE);
      return;
    }
    void toolbarStatus(tab.id);
    const controller = new AbortController();
    const entry = {
      tabId: tab.id, requestId: crypto.randomUUID(), order: nextOrder(), controller,
      source: null, shown: false, ready: false, running: false, moreRequested: false, retryable: false,
    };
    translations.set(tab.id, entry);
    const { signal } = controller;
    try {
      if (!await privateStorageReady) throw new PageDisplayError(PAGE_UNAVAILABLE);
      if (signal.aborted) return;
      entry.source = await getSource(chromeApi, tab.id);
      if (signal.aborted) return;
      await status(entry, 'reading', '正在读取网页正文…');
      entry.shown = true;
      if (signal.aborted) return;
      const page = await send(entry, 'TRANSMATE_PAGE_READ', { mode: 'translation' }).catch(() => null);
      if (signal.aborted) return;
      if (!page?.ok) throw new PageDisplayError(page?.error || PAGE_UNAVAILABLE);
      // Retain the opt-in and document identity through worker idle, never the page text.
      await persist(entry);
      if (signal.aborted) return;
      entry.ready = true;
      await runDemand(entry);
    } catch (error) {
      await failTranslation(entry, error);
    } finally {
      if (!entry.shown && translations.get(tab.id) === entry) translations.delete(tab.id);
    }
  }

  async function openSummary(tab) {
    if (!Number.isInteger(tab?.id) || !Number.isInteger(tab.windowId)) return;
    const { id: tabId, windowId } = tab;
    const requestId = crypto.randomUUID();
    const order = nextOrder();
    const intent = { requestId, tabId };
    summaryIntents.set(windowId, intent);
    try {
      // Open before awaiting so the menu or keyboard gesture is preserved.
      const panel = chromeApi.sidePanel.open({ windowId });
      const source = privateStorageReady.then((ready) => {
        if (ready && summaryIntents.get(windowId) === intent && isInjectableUrl(tab.url)) {
          return getSource(chromeApi, tabId).catch(() => null);
        }
      });
      const [, page] = await Promise.all([panel, source]);
      if (summaryIntents.get(windowId) !== intent) return;
      const key = `${PAGE_SUMMARY_PREFIX}${windowId}:${requestId}`;
      await chromeApi.storage.session.set({
        [key]: {
          requestId, windowId, tabId, order, createdAt: Date.now(),
          documentId: page?.documentId || null,
        },
      });
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
          ready: !saved.retryable, running: false, moreRequested: false,
        };
        if (matchesDocument(entry, message, sender)) translations.set(tabId, entry);
      }
    }
    if (!matchesDocument(entry, message, sender)) return;
    if (message.type === 'TRANSMATE_PAGE_CANCEL') {
      cancel(tabId, { clear: false });
      void toolbarStatus(tabId);
    } else if (message.type === 'TRANSMATE_PAGE_RETRY') {
      await retryTranslation(entry);
    } else {
      await runDemand(entry);
    }
  }

  function cancelAll() {
    settingsInvalidatedBefore = nextOrder();
    for (const tabId of translations.keys()) cancel(tabId);
    void clearStored({ before: settingsInvalidatedBefore }).catch(() => {});
  }

  return { startTranslation, openSummary, handleMessage, leavePage, cancelAll };
}
