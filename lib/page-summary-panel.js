import { message as localize } from './i18n.js';
import { summarizePage } from './page-ai.js';
import { PAGE_SUMMARY_MAX_AGE_MS, PAGE_SUMMARY_PREFIX, readPage } from './page-actions.js';

export function createPageSummaryPanel(chromeApi, root, getSettings) {
  const panel = root.querySelector('#page-summary');
  const source = root.querySelector('#page-summary-source');
  const status = root.querySelector('#page-summary-status');
  const result = root.querySelector('#page-summary-text');
  const cancel = root.querySelector('#page-summary-cancel');
  const retry = root.querySelector('#page-summary-retry');
  const copy = root.querySelector('#page-summary-copy');
  const queued = new Map();
  let windowId = null;
  let initialized = false;
  let newestOrder = 0;
  let current = null;
  let activeTabId = null;
  let activationVersion = 0;

  function updateVisibility() {
    panel.hidden = !current || current.request.tabId !== activeTabId;
  }

  async function refreshActiveTab() {
    const version = activationVersion;
    const [tab] = await chromeApi.tabs.query({ active: true, windowId });
    if (version !== activationVersion) return;
    activeTabId = tab?.id;
    updateVisibility();
  }

  function reset() {
    current?.controller?.abort();
    current = null;
    updateVisibility();
    source.textContent = '';
    status.textContent = '';
    result.textContent = '';
    result.hidden = true;
    copy.hidden = true;
    cancel.hidden = true;
    retry.hidden = true;
  }

  async function runSummary(intent, { retrying = false } = {}) {
    const { request } = intent;
    const controller = new AbortController();
    intent.controller = controller;
    const { signal } = controller;
    const previousStatus = status.textContent;
    status.textContent = localize('readingPage', '正在读取网页正文…');
    cancel.hidden = false;
    retry.hidden = true;
    try {
      // Consume the exact event before issuing any paid request.
      const consume = intent.pendingKey && chromeApi.storage.session.remove(intent.pendingKey).then(() => {
        intent.pendingKey = null;
      });
      await Promise.all([consume, refreshActiveTab()]);
      if (signal.aborted) return;
      if (retrying && activeTabId !== request.tabId) {
        status.textContent = previousStatus;
        retry.hidden = false;
        return;
      }
      if (!request.documentId) throw new Error(localize('readPageError', '无法读取当前网页。请在普通网页上重试。'));
      const page = await readPage(chromeApi, request, request.requestId, 'summary');
      if (signal.aborted) return;
      const label = page.title === page.host ? page.title : [page.title, page.host].filter(Boolean).join(' · ');
      if (label) source.textContent = localize('pageSummarySource', `来源 ${label}`, label);
      const settings = getSettings();
      if (!settings) throw new Error(localize('openConfiguredService', '请先在设置中填写 AI 服务、模型和 API Key。'));
      const summary = await summarizePage({
        blocks: page.blocks, settings, signal, permissionsApi: chromeApi.permissions,
        onProgress({ phase, batch, total }) {
          if (signal.aborted) return;
          if (phase === 'combine') {
            status.textContent = total > 1
              ? localize('pageSummaryCombineBatch', `正在汇总各部分重点（第 ${batch} / ${total} 批）…`, batch, total)
              : localize('pageSummaryCombine', '正在汇总各部分重点…');
          } else {
            status.textContent = total > 1
              ? localize('pageSummaryExtractBatch', `正在提取正文重点（第 ${batch} / ${total} 批）…`, batch, total)
              : localize('summarizingPage', '正在总结网页重点…');
          }
        },
      });
      if (signal.aborted) return;
      status.textContent = page.truncated ? localize('summaryLimit', '已达到网页内容上限，总结仅涵盖已读取部分。') : '';
      result.textContent = summary;
      result.hidden = false;
      copy.hidden = false;
    } catch (error) {
      if (!signal.aborted) {
        status.textContent = error?.message || localize('summaryFailed', '网页总结失败，请重试。');
        retry.hidden = !request.documentId;
      }
    } finally {
      if (current === intent) {
        intent.controller = null;
        cancel.hidden = true;
      }
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
    current = { controller: null, pendingKey: key, request };
    updateVisibility();
    source.textContent = localize('pageSummarySource', '来源 当前网页', localize('pageSummaryCurrentPage', '当前网页'));
    copy.textContent = localize('copySummary', '复制总结');
    void runSummary(current);
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
  retry.addEventListener('click', () => {
    if (current && !current.controller && !panel.hidden && !retry.hidden) {
      void runSummary(current, { retrying: true });
    }
  });
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
    if (activatedWindow !== windowId) return;
    activationVersion += 1;
    activeTabId = tabId;
    updateVisibility();
  });
  chromeApi.tabs?.onUpdated?.addListener((tabId, change) => {
    if (tabId === current?.request.tabId && (change.url || change.status === 'loading')) reset();
  });
  chromeApi.tabs?.onRemoved?.addListener((tabId) => {
    if (tabId === current?.request.tabId) reset();
  });
  chromeApi.tabs?.onDetached?.addListener((tabId) => {
    if (tabId === current?.request.tabId) reset();
  });
  chromeApi.tabs?.onReplaced?.addListener((_addedTabId, removedTabId) => {
    if (removedTabId === current?.request.tabId) reset();
  });
  if (typeof window !== 'undefined') window.addEventListener('pagehide', reset);

  return { initialize, receive, reset };
}
