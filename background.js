import { selectionStorageKey, selectionWindowIdFromKey, shouldAcceptSelection } from './lib/selection.js';
import { createPageActions, PAGE_TRANSLATION_MENU, PAGE_SUMMARY_MENU } from './lib/page-actions.js';
import { DEFAULT_SETTINGS, TARGET_LANGUAGES } from './lib/config.js';
import { translate } from './lib/translator.js';

const MENU_ID = 'translate-selection';
const INLINE_TIMEOUT_MS = 25_000;
const INLINE_SCRIPT = 'content-script.js';
const INLINE_SESSION_PREFIX = 'inlineSelection:';
const INLINE_RETRY = 'TRANSMATE_INLINE_RETRY';
const INLINE_SWITCH_LANGUAGE = 'TRANSMATE_INLINE_SWITCH_LANGUAGE';
const SHORTCUT_HINT = '请先选中文字，再按快捷键翻译。';
const languageNames = new Intl.DisplayNames('zh-CN', { type: 'language', fallback: 'none' });

function displayTargetLanguage(language) {
  const supported = TARGET_LANGUAGES.find(({ id }) => id === language);
  if (supported) return supported.name;
  try {
    return languageNames.of(language) || language;
  } catch {
    return language;
  }
}

function targetLanguageInfo(targetLanguageId) {
  return { targetLanguageId, targetLanguage: displayTargetLanguage(targetLanguageId) };
}

function configuredTarget(settings) {
  return typeof settings?.targetLanguage === 'string' ? settings.targetLanguage.trim() : '';
}

// chrome.scripting serializes this function and runs it inside each frame.
function readSelectionInFrame() {
  const focusedElement = document.activeElement;
  const inline = globalThis.__transmateInlineTranslation;
  // The last card can still hold focus when the next shortcut reads the frame.
  const active = focusedElement === inline?.host && inline.previousFocus?.isConnected
    ? inline.previousFocus : focusedElement;
  const focused = document.hasFocus() && !(active instanceof HTMLIFrameElement);
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    if (active instanceof HTMLInputElement && active.type === 'password') return { text: '', focused };
    try {
      const { selectionStart, selectionEnd } = active;
      return {
        text: Number.isInteger(selectionStart) && Number.isInteger(selectionEnd)
          ? active.value.slice(selectionStart, selectionEnd) : '',
        focused,
      };
    } catch {
      return { text: '', focused };
    }
  }
  return { text: window.getSelection()?.toString() || '', focused };
}

function inlineSessionKey(tabId, requestId) {
  return `${INLINE_SESSION_PREFIX}${tabId}:${requestId}`;
}

function messageTarget(entry) {
  return entry.documentId ? { documentId: entry.documentId } : { frameId: entry.frameId };
}

function isInjectableUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (parsed.hostname === 'chromewebstore.google.com') return false;
    if (parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore')) return false;
    return true;
  } catch {
    return false;
  }
}

export function registerBackground(chromeApi, {
  translateImpl = translate, timeoutMs = INLINE_TIMEOUT_MS, translatePageImpl,
} = {}) {
  let lastSelectionOrder = 0;
  let lastInlineOrder = 0;
  const activeByTab = new Map();
  const latestIntentByTab = new Map();
  // local storage is otherwise exposed to content scripts by default. Keep
  // provider credentials in trusted extension contexts before injecting one.
  const privateStorageReady = Promise.all([
    chromeApi.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    chromeApi.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }),
  ]).then(() => true, () => false);
  const pageActions = createPageActions(chromeApi, {
    privateStorageReady, nextOrder: nextInlineOrder, isInjectableUrl, translatePageImpl,
  });

  chromeApi.runtime.onInstalled.addListener(() => {
    chromeApi.contextMenus.create({
      id: MENU_ID,
      title: '用 TransMate 翻译',
      contexts: ['selection'],
    });
    for (const [id, title] of [[PAGE_TRANSLATION_MENU, '整页双语翻译'], [PAGE_SUMMARY_MENU, '总结网页重点']]) {
      chromeApi.contextMenus.create({
        id, title, contexts: ['page'], documentUrlPatterns: ['http://*/*', 'https://*/*'],
      });
    }
  });

  chromeApi.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => console.warn('无法设置侧边栏打开方式'));

  function current(entry) {
    return activeByTab.get(entry.tabId) === entry;
  }

  function send(entry, message) {
    return chromeApi.tabs.sendMessage(entry.tabId, message, messageTarget(entry));
  }

  function nextInlineOrder() {
    lastInlineOrder = Math.max(Date.now() * 1000, lastInlineOrder + 1);
    return lastInlineOrder;
  }

  async function persist(entry) {
    const key = inlineSessionKey(entry.tabId, entry.requestId);
    await chromeApi.storage.session.set({
      [key]: {
        tabId: entry.tabId, windowId: entry.windowId, text: entry.text,
        frameId: entry.frameId, documentId: entry.documentId,
        requestId: entry.requestId, order: entry.order, createdAt: Date.now(),
        ...(entry.targetLanguageOverride ? { targetLanguageOverride: entry.targetLanguageOverride } : {}),
      },
    });
    if (!current(entry)) {
      await chromeApi.storage.session.remove(key);
      return;
    }
    const items = await chromeApi.storage.session.get(null);
    if (!current(entry)) return;
    const prefix = `${INLINE_SESSION_PREFIX}${entry.tabId}:`;
    const olderKeys = Object.keys(items).filter((itemKey) => itemKey.startsWith(prefix) && itemKey !== key);
    if (olderKeys.length) await chromeApi.storage.session.remove(olderKeys);
  }

  function forget(entry) {
    const keys = [inlineSessionKey(entry.tabId, entry.requestId)];
    if (entry.parentRequestId) keys.push(inlineSessionKey(entry.tabId, entry.parentRequestId));
    chromeApi.storage.session.remove(keys).catch(() => {});
  }

  async function forgetTab(tabId, { hide = false } = {}) {
    const items = await chromeApi.storage.session.get(null);
    const prefix = `${INLINE_SESSION_PREFIX}${tabId}:`;
    const activeId = activeByTab.get(tabId)?.requestId;
    const keys = Object.keys(items).filter((key) => key.startsWith(prefix)
      && key !== inlineSessionKey(tabId, activeId));
    if (hide) {
      await Promise.allSettled(keys.map((key) => {
        const saved = items[key];
        if (!saved || !Number.isInteger(saved.frameId)) return Promise.resolve();
        return send(saved, { type: 'TRANSMATE_INLINE_HIDE', requestId: saved.requestId });
      }));
    }
    if (keys.length) await chromeApi.storage.session.remove(keys);
  }

  function cancel(entry, { hide = false } = {}) {
    entry.controller?.abort();
    if (current(entry)) activeByTab.delete(entry.tabId);
    forget(entry);
    if (hide && Number.isInteger(entry.frameId)) {
      send(entry, { type: 'TRANSMATE_INLINE_HIDE', requestId: entry.requestId }).catch(() => {});
    }
  }

  function claimIntent(tabId, order) {
    if (!Number.isInteger(tabId) || (latestIntentByTab.get(tabId) || 0) > order) return false;
    latestIntentByTab.set(tabId, order);
    const previous = activeByTab.get(tabId);
    if (previous) cancel(previous, { hide: true });
    return true;
  }

  function intentCurrent(tabId, order) {
    return latestIntentByTab.get(tabId) === order;
  }

  function fallbackToPanel(text, windowId) {
    if (!Number.isInteger(windowId)) return;
    const createdAt = Date.now();
    lastSelectionOrder = Math.max(createdAt * 1000, lastSelectionOrder + 1);
    const pendingSelection = {
      id: crypto.randomUUID(), text, createdAt, order: lastSelectionOrder, windowId,
    };
    const key = selectionStorageKey(windowId, pendingSelection.id);
    chromeApi.storage.session.set({ [key]: pendingSelection })
      .catch(() => console.warn('无法保存选中的文字'));
    chromeApi.sidePanel.open({ windowId })
      .catch(() => console.warn('无法打开翻译侧边栏'));

    chromeApi.storage.session.get(null).then((items) => {
      const expiredKeys = Object.entries(items).filter(([itemKey, item]) => {
        const itemWindowId = selectionWindowIdFromKey(itemKey);
        return itemWindowId !== null && !shouldAcceptSelection(item, itemWindowId);
      }).map(([itemKey]) => itemKey);
      if (expiredKeys.length) return chromeApi.storage.session.remove(expiredKeys);
    }).catch(() => console.warn('无法清理过期选文'));
  }

  async function readSettings(entry) {
    const { settings } = await chromeApi.storage.local.get('settings');
    if (entry.targetLanguageOverride && settings && typeof settings === 'object' && !Array.isArray(settings)) {
      return { ...settings, targetLanguage: entry.targetLanguageOverride };
    }
    return settings;
  }

  async function show(entry, settings, { retryOf, keyboard = false } = {}) {
    const languageData = entry.notice ? {} : {
      languages: TARGET_LANGUAGES,
      ...targetLanguageInfo(entry.targetLanguageOverride || configuredTarget(settings) || DEFAULT_SETTINGS.targetLanguage),
    };
    const response = await send(entry, {
      type: 'TRANSMATE_INLINE_SHOW', requestId: entry.requestId, text: entry.text,
      order: entry.order, ...(entry.notice ? { notice: true } : {}),
      ...(retryOf ? { retryOf } : {}),
      ...(keyboard ? { keyboard: true } : {}),
      ...languageData,
    });
    if (response?.ok !== true) throw new Error('无法显示翻译浮层');
    entry.shown = true;
  }

  async function runTranslation(entry, settings) {
    if (!current(entry)) return;
    if (entry.configInvalidated) {
      try {
        await send(entry, {
          type: 'TRANSMATE_INLINE_RESULT', requestId: entry.requestId,
          error: '翻译配置已更新，请重试。',
        });
      } catch {
        cancel(entry);
      }
      return;
    }
    const controller = new AbortController();
    entry.controller = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let onAbort;
    const interrupted = new Promise((_, reject) => {
      onAbort = () => reject(new Error('翻译已取消。'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });

    let result;
    try {
      const translation = await Promise.race([
        translateImpl({
          text: entry.text,
          settings,
          permissionsApi: chromeApi.permissions,
          signal: controller.signal,
        }),
        interrupted,
      ]);
      if (translation === null) return;
      const target = configuredTarget(settings);
      result = {
        type: 'TRANSMATE_INLINE_RESULT', requestId: entry.requestId, translation,
        ...(target ? targetLanguageInfo(target) : {}),
      };
    } catch (error) {
      const message = timedOut
        ? `等待翻译超过 ${Math.ceil(timeoutMs / 1000)} 秒，请重试。`
        : error instanceof Error && error.message
          ? error.message
          : '翻译失败，请稍后重试。';
      result = { type: 'TRANSMATE_INLINE_RESULT', requestId: entry.requestId, error: message };
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onAbort);
      if (entry.controller === controller) entry.controller = null;
    }

    if (!current(entry) || entry.configInvalidated) return;
    try {
      const response = await send(entry, timedOut
        ? {
          type: 'TRANSMATE_INLINE_RESULT', requestId: entry.requestId,
          error: `等待翻译超过 ${Math.ceil(timeoutMs / 1000)} 秒，请重试。`,
        }
        : result);
      if (response?.ok !== true) cancel(entry);
    } catch {
      cancel(entry);
    }
  }

  async function inject(entry, frameId) {
    const results = await chromeApi.scripting.executeScript({
      target: { tabId: entry.tabId, frameIds: [frameId] },
      files: [INLINE_SCRIPT],
    });
    const frame = results?.[0];
    if (!frame) throw new Error('无法注入翻译浮层');
    entry.frameId = Number.isInteger(frame.frameId) ? frame.frameId : frameId;
    entry.documentId = frame.documentId;
  }

  async function startInline({ text, frameId = 0, documentId, notice = false, keyboard = false }, tab, order) {
    const tabId = tab.id;
    const windowId = tab.windowId;
    if (!intentCurrent(tabId, order)) return;
    const entry = {
      tabId, windowId, text, frameId, documentId: null,
      requestId: crypto.randomUUID(), controller: null,
      shown: false, configInvalidated: false, order, notice,
    };
    activeByTab.set(tabId, entry);
    try {
      if (!await privateStorageReady) throw new Error('无法保护本机配置');
      if (!current(entry) || !intentCurrent(tabId, order)) return;
      try {
        await inject(entry, entry.frameId);
      } catch (error) {
        if (entry.frameId === 0) throw error;
        await inject(entry, 0);
      }
      if (!current(entry) || !intentCurrent(tabId, order)) return;
      if (documentId && entry.documentId && entry.documentId !== documentId) {
        cancel(entry, { hide: true });
        return;
      }
      const settings = notice ? undefined : await readSettings(entry);
      if (!current(entry) || !intentCurrent(tabId, order)) return;
      await show(entry, settings, { keyboard });
      if (!current(entry) || !intentCurrent(tabId, order)) return;
      if (notice) {
        await send(entry, {
          type: 'TRANSMATE_INLINE_RESULT', requestId: entry.requestId, error: SHORTCUT_HINT,
        });
        return;
      }
      await persist(entry);
      if (!current(entry) || !intentCurrent(tabId, order)) return;
      await runTranslation(entry, settings);
    } catch {
      if (!current(entry)) return;
      cancel(entry, { hide: true });
      fallbackToPanel(text, windowId);
    }
  }

  async function onClicked(info, tab) {
    if (info.menuItemId === PAGE_TRANSLATION_MENU) return pageActions.startTranslation(tab);
    if (info.menuItemId === PAGE_SUMMARY_MENU) return pageActions.openSummary(tab);
    if (info.menuItemId !== MENU_ID || !info.selectionText?.trim()) return;
    const text = info.selectionText.trim();
    const tabId = tab?.id;
    const order = nextInlineOrder();
    if (Number.isInteger(tabId) && !claimIntent(tabId, order)) return;
    // Restricted browser pages cannot host content scripts. This branch still
    // opens the panel in the context-menu user gesture.
    if (!Number.isInteger(tabId) || !isInjectableUrl(tab?.url)) {
      fallbackToPanel(text, tab?.windowId);
      return;
    }
    await startInline({ text, frameId: info.frameId ?? 0 }, tab, order);
  }

  async function onCommand(command, commandTab) {
    if (command !== MENU_ID && command !== PAGE_TRANSLATION_MENU && command !== PAGE_SUMMARY_MENU) return;
    const order = nextInlineOrder();
    let tab = commandTab;
    if (!Number.isInteger(tab?.id)) {
      const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
      tab = tabs?.[0];
    }
    if (command === PAGE_TRANSLATION_MENU) return pageActions.startTranslation(tab);
    if (command === PAGE_SUMMARY_MENU) return pageActions.openSummary(tab);
    if (!Number.isInteger(tab?.id) || !claimIntent(tab.id, order)) return;
    if (!isInjectableUrl(tab.url)) {
      chromeApi.sidePanel.open({ windowId: tab.windowId })
        .catch(() => console.warn('无法打开翻译侧边栏'));
      return;
    }

    let results;
    try {
      results = await chromeApi.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true }, func: readSelectionInFrame,
      });
    } catch {
      try {
        results = await chromeApi.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [0] }, func: readSelectionInFrame,
        });
      } catch {
        if (intentCurrent(tab.id, order)) {
          chromeApi.sidePanel.open({ windowId: tab.windowId })
            .catch(() => console.warn('无法打开翻译侧边栏'));
        }
        return;
      }
    }
    if (!intentCurrent(tab.id, order)) return;
    const chosen = (results || []).find(({ result }) => result?.focused === true
      && typeof result.text === 'string' && result.text.trim());
    if (chosen) {
      await startInline({
        text: chosen.result.text.trim(), frameId: chosen.frameId,
        documentId: chosen.documentId, keyboard: true,
      }, tab, order);
    } else {
      await startInline({ text: '', notice: true, keyboard: true }, tab, order);
    }
  }

  function senderMatches(entry, sender) {
    return sender?.tab?.id === entry.tabId
      && sender.frameId === entry.frameId
      && (!entry.documentId || sender.documentId === entry.documentId);
  }

  async function recoverEntry(message, sender) {
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(tabId)) return null;
    const currentEntry = activeByTab.get(tabId);
    if (currentEntry) return currentEntry;
    if (typeof message.requestId !== 'string' || !message.requestId) return null;
    const key = inlineSessionKey(tabId, message.requestId);
    const stored = (await chromeApi.storage.session.get(key))[key];
    if (!stored || stored.tabId !== tabId || stored.requestId !== message.requestId
        || typeof stored.text !== 'string' || !Number.isInteger(stored.frameId)
        || (latestIntentByTab.get(tabId) || 0) > stored.order) return null;
    const entry = { ...stored, controller: null, shown: true, configInvalidated: false };
    if (!senderMatches(entry, sender)) return null;
    const newer = activeByTab.get(tabId);
    if (newer) return newer;
    activeByTab.set(tabId, entry);
    return entry;
  }

  async function restart(entry, targetLanguageOverride) {
    entry.controller?.abort();
    const replacement = {
      ...entry, targetLanguageOverride, requestId: crypto.randomUUID(), parentRequestId: entry.requestId,
      controller: null, configInvalidated: false, shown: false, order: nextInlineOrder(),
    };
    activeByTab.set(entry.tabId, replacement);
    try {
      const settings = await readSettings(replacement);
      if (!current(replacement)) return { ok: false };
      await show(replacement, settings, { retryOf: entry.requestId });
      if (current(replacement)) await persist(replacement);
      if (!current(replacement)) {
        send(replacement, { type: 'TRANSMATE_INLINE_HIDE', requestId: replacement.requestId }).catch(() => {});
        return { ok: false };
      }
      void runTranslation(replacement, settings);
      return { ok: true };
    } catch {
      if (current(replacement)) cancel(replacement, { hide: true });
      return { ok: false };
    }
  }

  async function onMessage(message, sender) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'TRANSMATE_PAGE_CANCEL' || message.type === 'TRANSMATE_PAGE_MORE') {
      return pageActions.handleMessage(message, sender);
    }
    const switching = message.type === INLINE_SWITCH_LANGUAGE;
    const restarting = switching || message.type === INLINE_RETRY;
    if (switching && !TARGET_LANGUAGES.some(({ id }) => id === message.targetLanguage)) return { ok: false };
    const recovered = await recoverEntry(message, sender);
    const entry = recovered && activeByTab.get(recovered.tabId);
    if (!entry || !senderMatches(entry, sender)) return restarting ? { ok: false } : undefined;

    if (message.type === 'TRANSMATE_INLINE_OPEN_OPTIONS') {
      if (message.requestId !== entry.requestId) return;
      await chromeApi.runtime.openOptionsPage();
      return;
    }
    if (message.type === 'TRANSMATE_INLINE_CANCEL') {
      if (message.requestId === entry.requestId || message.requestId === entry.parentRequestId) {
        cancel(entry, { hide: true });
      }
      return;
    }
    if (!restarting) return;
    if (entry.notice || message.requestId !== entry.requestId) return { ok: false };
    return restart(entry, switching ? message.targetLanguage : entry.targetLanguageOverride);
  }

  chromeApi.contextMenus.onClicked.addListener((info, tab) => {
    void onClicked(info, tab).catch(() => console.warn('无法执行 TransMate 网页操作'));
  });
  chromeApi.commands.onCommand.addListener((command, tab) => {
    void onCommand(command, tab).catch(() => console.warn('无法处理快捷键翻译'));
  });
  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === INLINE_SWITCH_LANGUAGE || message?.type === INLINE_RETRY) {
      void onMessage(message, sender).then(sendResponse, () => sendResponse?.({ ok: false }));
      return true;
    }
    if (message?.type === 'TRANSMATE_PAGE_MORE') {
      void onMessage(message, sender).then(() => sendResponse?.(), () => sendResponse?.());
      return true;
    }
    void onMessage(message, sender).catch(() => console.warn('无法处理翻译浮层操作'));
  });
  chromeApi.tabs.onRemoved?.addListener((tabId) => {
    pageActions.leavePage(tabId, { clear: false });
    latestIntentByTab.delete(tabId);
    const entry = activeByTab.get(tabId);
    if (entry) cancel(entry);
    void forgetTab(tabId).catch(() => {});
  });
  chromeApi.tabs.onUpdated?.addListener((tabId, changeInfo) => {
    if (!changeInfo.url && changeInfo.status !== 'loading') return;
    pageActions.leavePage(tabId);
    latestIntentByTab.delete(tabId);
    const entry = activeByTab.get(tabId);
    if (entry) cancel(entry, { hide: true });
    void forgetTab(tabId, { hide: true }).catch(() => {});
  });
  function invalidate(entry) {
    if (entry.notice) return;
    if (entry.configInvalidated) return;
    entry.configInvalidated = true;
    entry.controller?.abort();
    entry.controller = null;
    if (!entry.shown) return;
    send(entry, {
      type: 'TRANSMATE_INLINE_INVALIDATE', requestId: entry.requestId,
      error: '翻译配置已更新，请重试。',
    }).then((response) => {
      if (response?.ok !== true) cancel(entry);
    }).catch(() => cancel(entry));
  }

  chromeApi.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    pageActions.cancelAll();
    for (const entry of activeByTab.values()) invalidate(entry);
    // MV3 may have restarted the worker while a completed card remained open.
    // Restore those cards from session storage so a settings change clears them.
    void chromeApi.storage.session.get(null).then((items) => {
      for (const [key, stored] of Object.entries(items)) {
        if (!key.startsWith(INLINE_SESSION_PREFIX) || !Number.isInteger(stored?.tabId)
            || typeof stored.requestId !== 'string' || !Number.isInteger(stored.frameId)) continue;
        const existing = activeByTab.get(stored.tabId);
        if (existing && existing.requestId !== stored.requestId) continue;
        const entry = existing || {
          ...stored, controller: null, shown: true, configInvalidated: false,
        };
        if (!existing) activeByTab.set(entry.tabId, entry);
        invalidate(entry);
      }
    }).catch(() => {});
  });

  return { onClicked, onCommand, onMessage, activeByTab };
}

export const backgroundRouter = typeof chrome !== 'undefined' ? registerBackground(chrome) : null;
