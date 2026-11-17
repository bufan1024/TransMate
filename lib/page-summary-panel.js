import { message as localize } from './i18n.js';
import { summarizePage } from './page-ai.js';
import { PAGE_SUMMARY_MAX_AGE_MS, PAGE_SUMMARY_PREFIX, readPage } from './page-actions.js';

export function createPageSummaryPanel(chromeApi, root, getSettings) {
  const panel = root.querySelector('#page-summary');
  const status = root.querySelector('#page-summary-status');
  const result = root.querySelector('#page-summary-text');
  const cancel = root.querySelector('#page-summary-cancel');
  const copy = root.querySelector('#page-summary-copy');
  const queued = new Map();
  let windowId = null;
  let initialized = false;
  let newestOrder = 0;
  let current = null;

  function reset() {
    current?.controller.abort();
    current = null;
    panel.hidden = true;
    status.textContent = '';
    result.textContent = '';
    result.hidden = true;
    copy.hidden = true;
    cancel.hidden = true;
  }

  async function consume(key, intent) {
    const { controller, request } = intent;
    const { signal } = controller;
    try {
      // Consume the exact event before issuing any paid request.
      await chromeApi.storage.session.remove(key);
      const [activeTab] = await chromeApi.tabs.query({ active: true, windowId });
      if (signal.aborted) return;
      if (activeTab?.id !== request.tabId) {
        reset();
        return;
      }
      if (!request.documentId) throw new Error(localize('readPageError', '无法读取当前网页。请在普通网页上重试。'));
      const settings = getSettings();
      if (!settings) throw new Error(localize('openConfiguredService', '请先在设置中填写 AI 服务、模型和 API Key。'));
      const page = await readPage(chromeApi, request, request.requestId, 'summary');
      if (signal.aborted) return;
      status.textContent = localize('summarizingPage', '正在总结网页重点…');
      const summary = await summarizePage({ blocks: page.blocks, settings, signal, permissionsApi: chromeApi.permissions });
      if (signal.aborted) return;
      status.textContent = page.truncated ? localize('summaryLimit', '已达到网页内容上限，总结仅涵盖已读取部分。') : '';
      result.textContent = summary;
      result.hidden = false;
      copy.hidden = false;
    } catch (error) {
      if (!signal.aborted) status.textContent = error?.message || localize('summaryFailed', '网页总结失败，请重试。');
    } finally {
      if (current === intent) cancel.hidden = true;
    }
  }

  function receive(key, request) {
    if (!key.startsWith(PAGE_SUMMARY_PREFIX) || !request) return;
    if (!initialized) {
      queued.set(key, request);
      return;
    }
    if (windowId === null || request.windowId !== windowId
        || key !== `${PAGE_SUMMARY_PREFIX}${windowId}:${request.requestId}`) return;
    const age = Date.now() - request.createdAt;
    if (!Number.isInteger(request.tabId) || !Number.isSafeInteger(request.order) || request.order <= newestOrder
        || !Number.isFinite(age) || age < 0 || age > PAGE_SUMMARY_MAX_AGE_MS) {
      void chromeApi.storage.session.remove(key).catch(() => {});
      return;
    }
    newestOrder = request.order;
    reset();
    current = { controller: new AbortController(), request };
    panel.hidden = false;
    cancel.hidden = false;
    copy.textContent = localize('copySummary', '复制总结');
    status.textContent = localize('readingPage', '正在读取网页正文…');
    void consume(key, current);
  }

  function initialize(id, session) {
    windowId = id;
    initialized = true;
    const pending = new Map([...Object.entries(session), ...queued]);
    const entries = [...pending].filter(([key, request]) => key.startsWith(PAGE_SUMMARY_PREFIX) && request);
    entries.sort((left, right) => right[1].order - left[1].order);
    for (const [key, request] of entries) receive(key, request);
    queued.clear();
  }

  cancel.addEventListener('click', reset);
  copy.addEventListener('click', async () => {
    const intent = current;
    try {
      await navigator.clipboard.writeText(result.textContent);
      if (current === intent) copy.textContent = localize('copied', '已复制');
    } catch {
      if (current === intent) copy.textContent = localize('copyFailed', '复制失败');
    }
  });
  chromeApi.tabs?.onActivated?.addListener(({ tabId, windowId: activatedWindow }) => {
    if (current && activatedWindow === windowId && tabId !== current.request.tabId) reset();
  });
  chromeApi.tabs?.onUpdated?.addListener((tabId, change) => {
    if (tabId === current?.request.tabId && (change.url || change.status === 'loading')) reset();
  });
  chromeApi.tabs?.onRemoved?.addListener((tabId) => {
    if (tabId === current?.request.tabId) reset();
  });
  if (typeof window !== 'undefined') window.addEventListener('pagehide', reset);

  return { initialize, receive, reset };
}
