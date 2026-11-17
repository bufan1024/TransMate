import { message as localize } from './lib/i18n.js';
import {
  compareSelections, isInjectableUrl, selectionStorageKey, selectionWindowIdFromKey, shouldAcceptSelection,
} from './lib/selection.js';
import { createPageActions, PAGE_TRANSLATION_MENU, PAGE_SUMMARY_MENU, PANEL_PAGE_ACTION } from './lib/page-actions.js';
import { DEFAULT_SETTINGS, TARGET_LANGUAGES } from './lib/config.js';
import { recordTranslation } from './lib/translation-history.js';
import { MAX_LONG_TEXT_LENGTH } from './lib/long-translation.js';
import { MAX_TEXT_LENGTH, translate } from './lib/translator.js';
import { GLOSSARY_STORAGE_KEY, glossaryAffectsTranslations } from './lib/glossary.js';
import { createVideoActions, VIDEO_CUE, VIDEO_MENU, VIDEO_STOP } from './lib/video-actions.js';
import {
  PAGE_TRANSLATION_SITES, SITE_MENU_PATTERNS, forgetRevokedTranslationSites, pageTranslationSite, storedSites,
} from './lib/page-translation-sites.js';
import { withSettingsLock } from './lib/settings-management.js';
import { SELECTION_LAUNCHER_ORIGINS, selectionLauncherAllowed, syncSelectionLauncher } from './lib/selection-launcher-settings.js';

const MENU_ID = 'translate-selection';
const SITE_SETTINGS_MENU = 'page-translation-site-settings';
const INLINE_TIMEOUT_MS = 25_000;
const INLINE_SCRIPT = 'content-script.js';
const INLINE_SESSION_PREFIX = 'inlineSelection:';
const INLINE_RETRY = 'TRANSMATE_INLINE_RETRY';
const INLINE_SWITCH_LANGUAGE = 'TRANSMATE_INLINE_SWITCH_LANGUAGE';
const INLINE_OPEN_PANEL = 'TRANSMATE_INLINE_OPEN_PANEL';
const INLINE_EXPORT_RESULT = 'TRANSMATE_INLINE_EXPORT_RESULT';
const SELECTION_LAUNCHER_STATUS = 'TRANSMATE_SELECTION_LAUNCHER_STATUS';
const SELECTION_LAUNCHER_START = 'TRANSMATE_SELECTION_LAUNCHER_START';
const SHORTCUT_HINT = localize('selectFirst', '请先选中文字，再按快捷键翻译。');
const locale = localize('locale', 'zh-CN');
const maxSelectionLength = MAX_LONG_TEXT_LENGTH.toLocaleString(locale);
const LONG_SELECTION_LIMIT = localize('longSelectionLimit',
  `选中内容最多支持 ${maxSelectionLength} 字符，请缩短选区后重试。`, maxSelectionLength);
const languageNames = new Intl.DisplayNames(locale, { type: 'language', fallback: 'none' });

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

export function registerBackground(chromeApi, {
  translateImpl = translate, timeoutMs = INLINE_TIMEOUT_MS, translatePageImpl,
} = {}) {
  let lastSelectionOrder = 0;
  let lastInlineOrder = 0;
  const activeByTab = new Map();
  const latestIntentByTab = new Map();
  const latestPanelSelectionByWindow = new Map();
  // local storage is otherwise exposed to content scripts by default. Keep
  // provider credentials in trusted extension contexts before injecting one.
  const privateStorageReady = Promise.all([
    chromeApi.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    chromeApi.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }),
  ]).then(() => true, () => false);
  const pageActions = createPageActions(chromeApi, {
    privateStorageReady, nextOrder: nextInlineOrder, isInjectableUrl, translatePageImpl,
  });

  const videoActions = createVideoActions(chromeApi, { privateStorageReady, isInjectableUrl });

  function reconcileSelectionLauncher(options) {
    void withSettingsLock(globalThis.navigator?.locks, () => syncSelectionLauncher(chromeApi, options)).catch(() => {});
  }

  chromeApi.runtime.onStartup?.addListener(() => reconcileSelectionLauncher());

  chromeApi.runtime.onInstalled.addListener(() => {
    reconcileSelectionLauncher();
    chromeApi.contextMenus.create({
      id: MENU_ID,
      title: localize('translateSelectionMenu', '用 TransMate 翻译'),
      contexts: ['selection'],
    });
    chromeApi.contextMenus.create({
      id: VIDEO_MENU, title: localize('videoTranslateMenu', '翻译视频字幕'), contexts: ['page', 'video'], documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
    chromeApi.contextMenus.create({
      id: SITE_SETTINGS_MENU, title: localize('siteTranslationMenu', '本站自动翻译设置'), contexts: ['page'], documentUrlPatterns: SITE_MENU_PATTERNS,
    });
    for (const [id, title] of [[PAGE_TRANSLATION_MENU, localize('pageTranslateMenu', '整页双语翻译')], [PAGE_SUMMARY_MENU, localize('pageSummaryMenu', '总结网页重点')]]) {
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
    const keys = Object.keys(items).filter((key) => (key.startsWith(prefix)
      && key !== inlineSessionKey(tabId, activeId))
      || (selectionWindowIdFromKey(key) !== null && items[key]?.tabId === tabId));
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

  function createPanelSelection(windowId) {
    const createdAt = Date.now();
    lastSelectionOrder = Math.max(createdAt * 1000, lastSelectionOrder + 1);
    latestPanelSelectionByWindow.set(windowId, lastSelectionOrder);
    return { id: crypto.randomUUID(), createdAt, order: lastSelectionOrder, windowId };
  }

  async function prunePanelSelections(selection) {
    const items = await chromeApi.storage.session.get(null);
    const obsolete = Object.entries(items).filter(([key, item]) => {
      const windowId = selectionWindowIdFromKey(key);
      return windowId !== null && (!shouldAcceptSelection(item, windowId)
        || (Number.isInteger(item.tabId) && windowId === selection.windowId && compareSelections(item, selection) < 0));
    }).map(([key]) => key);
    if (obsolete.length) await chromeApi.storage.session.remove(obsolete);
  }

  function fallbackToPanel(text, windowId) {
    if (!Number.isInteger(windowId)) return;
    if (text.length > MAX_LONG_TEXT_LENGTH) {
      chromeApi.sidePanel.open({ windowId }).catch(() => console.warn('无法打开翻译侧边栏'));
      return;
    }
    const selection = { ...createPanelSelection(windowId), text };
    const key = selectionStorageKey(windowId, selection.id);
    chromeApi.storage.session.set({ [key]: selection })
      .catch(() => console.warn('无法保存选中的文字'));
    chromeApi.sidePanel.open({ windowId })
      .catch(() => console.warn('无法打开翻译侧边栏'));
    void prunePanelSelections(selection).catch(() => console.warn('无法清理过期选文'));
  }

  async function readTranslationOptions(entry) {
    const { settings, [GLOSSARY_STORAGE_KEY]: glossary } = await chromeApi.storage.local.get([
      'settings', GLOSSARY_STORAGE_KEY,
    ]);
    if (entry.targetLanguageOverride && settings && typeof settings === 'object' && !Array.isArray(settings)) {
      return { settings: { ...settings, targetLanguage: entry.targetLanguageOverride }, glossary };
    }
    return { settings, glossary };
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
      ...(entry.text.length > MAX_TEXT_LENGTH ? { sourceOnly: true } : {}),
      ...languageData,
    });
    if (response?.ok !== true) throw new Error(localize('cannotDisplayCard', '无法显示翻译浮层'));
    entry.shown = true;
  }

  async function runTranslation(entry, { settings, glossary }) {
    if (!current(entry)) return;
    if (entry.configInvalidated) {
      try {
        await send(entry, {
          type: 'TRANSMATE_INLINE_RESULT', requestId: entry.requestId,
          error: localize('translationSettingsUpdated', '翻译配置已更新，请重试。'),
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
      onAbort = () => reject(new Error(localize('translationCancelled', '翻译已取消。')));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });

    let result;
    try {
      const translation = await Promise.race([
        translateImpl({
          text: entry.text,
          settings,
          glossary,
          permissionsApi: chromeApi.permissions,
          signal: controller.signal,
          onDelta: async (delta) => {
            if (!current(entry) || controller.signal.aborted) return;
            await send(entry, { type: 'TRANSMATE_INLINE_PROGRESS', requestId: entry.requestId, delta });
          },
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
        ? localize('cardTimeout', `等待翻译超过 ${Math.ceil(timeoutMs / 1000)} 秒，请重试。`, Math.ceil(timeoutMs / 1000))
        : error instanceof Error && error.message
          ? error.message
          : localize('translationRetryLater', '翻译失败，请稍后重试。');
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
          error: localize('cardTimeout', `等待翻译超过 ${Math.ceil(timeoutMs / 1000)} 秒，请重试。`, Math.ceil(timeoutMs / 1000)),
        }
        : result);
      if (response?.ok !== true) cancel(entry);
      else if (current(entry) && !entry.configInvalidated && !timedOut && result.translation) {
        void recordTranslation(chromeApi.storage.local, globalThis.navigator?.locks, {
          source: entry.text, translation: result.translation, targetLanguage: result.targetLanguageId,
        }).catch(() => {});
      }
    } catch {
      cancel(entry);
    }
  }

  async function inject(entry, frameId, documentId) {
    const target = documentId
      ? { tabId: entry.tabId, documentIds: [documentId] }
      : { tabId: entry.tabId, frameIds: [frameId] };
    const results = await chromeApi.scripting.executeScript({ target, files: [INLINE_SCRIPT] });
    const frame = results?.[0];
    if (!frame) throw new Error(localize('cannotInjectCard', '无法注入翻译浮层'));
    entry.frameId = Number.isInteger(frame.frameId) ? frame.frameId : frameId;
    entry.documentId = frame.documentId;
  }

  async function startInline({ text, frameId = 0, documentId, notice = false, keyboard = false }, tab, order) {
    const tabId = tab.id;
    const windowId = tab.windowId;
    if (!intentCurrent(tabId, order)) return;
    const overLimit = text.length > MAX_LONG_TEXT_LENGTH;
    const entry = {
      tabId, windowId, text: overLimit ? '' : text, frameId, documentId: null,
      requestId: crypto.randomUUID(), controller: null,
      shown: false, configInvalidated: false, order, notice: notice || overLimit,
    };
    activeByTab.set(tabId, entry);
    try {
      if (!await privateStorageReady) throw new Error(localize('privateSettingsUnavailable', '无法保护本机配置'));
      if (!current(entry) || !intentCurrent(tabId, order)) return;
      try {
        await inject(entry, entry.frameId, documentId);
      } catch (error) {
        if (documentId || entry.frameId === 0) throw error;
        await inject(entry, 0);
      }
      if (!current(entry) || !intentCurrent(tabId, order)) return;
      if (documentId && entry.documentId !== documentId) {
        cancel(entry, { hide: true });
        return;
      }
      const options = entry.notice ? {} : await readTranslationOptions(entry);
      if (!current(entry) || !intentCurrent(tabId, order)) return;
      await show(entry, options.settings, { keyboard });
      if (!current(entry) || !intentCurrent(tabId, order)) return;
      if (entry.notice) {
        await send(entry, {
          type: 'TRANSMATE_INLINE_RESULT', requestId: entry.requestId,
          error: overLimit ? LONG_SELECTION_LIMIT : SHORTCUT_HINT,
        });
        return;
      }
      await persist(entry);
      if (!current(entry) || !intentCurrent(tabId, order)) return;
      if (entry.text.length <= MAX_TEXT_LENGTH) await runTranslation(entry, options);
    } catch {
      if (!current(entry)) return;
      cancel(entry, { hide: true });
      if (!documentId || entry.documentId === documentId) fallbackToPanel(text, windowId);
    }
  }

  function launcherSender(sender) {
    return sender?.id === chromeApi.runtime.id && Number.isInteger(sender.tab?.id)
      && Number.isInteger(sender.frameId) && typeof sender.documentId === 'string' && sender.documentId
      && (!sender.documentLifecycle || sender.documentLifecycle === 'active')
      && isInjectableUrl(sender.url);
  }

  async function handleSelectionLauncher(message, sender) {
    if (message.type === SELECTION_LAUNCHER_STATUS) {
      const enabled = Boolean(launcherSender(sender) && await privateStorageReady && await selectionLauncherAllowed(chromeApi));
      return { enabled, maxTextLength: MAX_LONG_TEXT_LENGTH };
    }

    if (!launcherSender(sender) || typeof message.text !== 'string') return { ok: false };
    const text = message.text.trim().slice(0, MAX_LONG_TEXT_LENGTH + 1);
    if (!text) return { ok: false };
    const order = nextInlineOrder();
    const { tab, frameId, documentId } = sender;
    if (!await privateStorageReady || !await selectionLauncherAllowed(chromeApi)
        || !claimIntent(tab.id, order)) return { ok: false };
    void startInline({ text, frameId, documentId }, tab, order);
    return { ok: true };
  }

  async function onClicked(info, tab) {
    if (info.menuItemId === VIDEO_MENU) return videoActions.start(tab, info);
    if (info.menuItemId === SITE_SETTINGS_MENU) {
      const site = pageTranslationSite(tab?.url);
      if (site) await chromeApi.tabs.create({
        url: `${chromeApi.runtime.getURL('options.html')}?site=${encodeURIComponent(site.origin)}#site-translation`,
      });
      return;
    }
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

  async function openInlinePanel(message, sender) {
    const { id: tabId, windowId } = sender?.tab || {};
    if (sender?.id !== chromeApi.runtime.id || !Number.isInteger(tabId) || !Number.isInteger(windowId)
        || !Number.isInteger(sender.frameId) || !sender.documentId
        || typeof message.requestId !== 'string' || !message.requestId) return { ok: false };
    const matches = (entry) => entry && !entry.notice && !entry.configInvalidated
      && entry.requestId === message.requestId && entry.windowId === windowId
      && entry.documentId === sender.documentId && senderMatches(entry, sender);
    const active = activeByTab.get(tabId);
    if (active && !matches(active)) return { ok: false };

    // Chrome requires this call to run in the click's activation. The persisted
    // request and current document are checked before the side panel gets data.
    const opened = chromeApi.sidePanel.open({ windowId }).then(() => true, () => false);
    const selection = createPanelSelection(windowId);
    const entry = await recoverEntry(message, sender);
    if (!matches(entry) || !current(entry)) return { ok: false };
    const exported = send(entry, { type: INLINE_EXPORT_RESULT, requestId: entry.requestId });
    const [result, didOpen] = await Promise.all([exported, opened]);
    const target = configuredTarget({ targetLanguage: result?.targetLanguageId });
    if (!didOpen || !current(entry) || !matches(entry)
        || latestPanelSelectionByWindow.get(windowId) !== selection.order) return { ok: false };
    const sourceOnly = entry.text.length > MAX_TEXT_LENGTH && entry.text.length <= MAX_LONG_TEXT_LENGTH;
    if (sourceOnly ? result?.sourceOnly !== true
      : typeof result?.translation !== 'string' || !result.translation.trim() || !target) return { ok: false };

    const handoff = {
      ...selection, tabId, text: entry.text,
      ...(sourceOnly ? {} : { result: { translation: result.translation, ...targetLanguageInfo(target) } }),
    };
    const key = selectionStorageKey(windowId, handoff.id);
    await chromeApi.storage.session.set({ [key]: handoff });
    void prunePanelSelections(handoff).catch(() => console.warn('无法清理过期选文'));
    return { ok: true };
  }

  async function restart(entry, targetLanguageOverride) {
    entry.controller?.abort();
    const replacement = {
      ...entry, targetLanguageOverride, requestId: crypto.randomUUID(), parentRequestId: entry.requestId,
      controller: null, configInvalidated: false, shown: false, order: nextInlineOrder(),
    };
    activeByTab.set(entry.tabId, replacement);
    try {
      const options = await readTranslationOptions(replacement);
      if (!current(replacement)) return { ok: false };
      await show(replacement, options.settings, { retryOf: entry.requestId });
      if (current(replacement)) await persist(replacement);
      if (!current(replacement)) {
        send(replacement, { type: 'TRANSMATE_INLINE_HIDE', requestId: replacement.requestId }).catch(() => {});
        return { ok: false };
      }
      void runTranslation(replacement, options);
      return { ok: true };
    } catch {
      if (current(replacement)) cancel(replacement, { hide: true });
      return { ok: false };
    }
  }

  async function handlePanelPageAction(message, sender) {
    const error = localize('panelPageUnavailable', '无法访问当前网页。请切到普通网页后从网页右键菜单启动。');
    const { action, windowId } = message;
    if (sender?.url !== chromeApi.runtime.getURL('sidepanel.html') || (sender.frameId != null && sender.frameId !== 0)
        || !Number.isInteger(windowId) || windowId < 0
        || (action !== PAGE_TRANSLATION_MENU && action !== PAGE_SUMMARY_MENU)) return { ok: false, error };
    const [tab] = await chromeApi.tabs.query({ active: true, windowId });
    if (tab?.windowId !== windowId || !isInjectableUrl(tab.url)) return { ok: false, error };
    const started = action === PAGE_TRANSLATION_MENU
      ? await pageActions.startTranslation(tab, { waitForDemand: false })
      : await pageActions.openSummary(tab, { panelIsOpen: true });
    return started ? { ok: true } : { ok: false, error };
  }

  async function onMessage(message, sender) {
    if (!message || typeof message !== 'object') return;
    if (message.type === SELECTION_LAUNCHER_STATUS || message.type === SELECTION_LAUNCHER_START) {
      return handleSelectionLauncher(message, sender);
    }
    if (message.type === VIDEO_CUE || message.type === VIDEO_STOP) return videoActions.handle(message, sender);
    if (message.type === INLINE_OPEN_PANEL) return openInlinePanel(message, sender);
    if (message.type === PANEL_PAGE_ACTION) return handlePanelPageAction(message, sender);
    if (message.type === 'TRANSMATE_PAGE_CANCEL' || message.type === 'TRANSMATE_PAGE_MORE'
        || message.type === 'TRANSMATE_PAGE_RETRY') {
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
    if (entry.notice || entry.text.length > MAX_TEXT_LENGTH || message.requestId !== entry.requestId) return { ok: false };
    return restart(entry, switching ? message.targetLanguage : entry.targetLanguageOverride);
  }

  chromeApi.contextMenus.onClicked.addListener((info, tab) => {
    void onClicked(info, tab).catch(() => console.warn('无法执行 TransMate 网页操作'));
  });
  chromeApi.commands.onCommand.addListener((command, tab) => {
    void onCommand(command, tab).catch(() => console.warn('无法处理快捷键翻译'));
  });
  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === INLINE_SWITCH_LANGUAGE || message?.type === INLINE_RETRY
        || message?.type === INLINE_OPEN_PANEL || message?.type === SELECTION_LAUNCHER_STATUS
        || message?.type === SELECTION_LAUNCHER_START) {
      void onMessage(message, sender).then(sendResponse, () => sendResponse?.({ ok: false }));
      return true;
    }
    if (message?.type === VIDEO_CUE) {
      void onMessage(message, sender).then(sendResponse, () => sendResponse?.());
      return true;
    }
    if (message?.type === PANEL_PAGE_ACTION) {
      void onMessage(message, sender).then(sendResponse, () => sendResponse({ ok: false }));
      return true;
    }
    if (message?.type === 'TRANSMATE_PAGE_MORE' || message?.type === 'TRANSMATE_PAGE_RETRY') {
      void onMessage(message, sender).then(() => sendResponse?.(), () => sendResponse?.());
      return true;
    }
    void onMessage(message, sender).catch(() => console.warn('无法处理翻译浮层操作'));
  });
  chromeApi.tabs.onRemoved?.addListener((tabId) => {
    videoActions.leave(tabId, { hide: false });
    pageActions.leavePage(tabId, { clear: false });
    latestIntentByTab.delete(tabId);
    const entry = activeByTab.get(tabId);
    if (entry) cancel(entry);
    void forgetTab(tabId).catch(() => {});
  });
  chromeApi.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === 'loading') {
      videoActions.leave(tabId);
      pageActions.leavePage(tabId);
      latestIntentByTab.delete(tabId);
      const entry = activeByTab.get(tabId);
      if (entry) cancel(entry, { hide: true });
      void forgetTab(tabId, { hide: true }).catch(() => {});
    }
    if (changeInfo.status === 'complete') {
      void pageActions.startTranslation(tab, { auto: true }).catch(() => {});
    }
  });

  chromeApi.permissions.onRemoved?.addListener(({ origins = [] } = {}) => {
    if (origins.some((origin) => SELECTION_LAUNCHER_ORIGINS.includes(origin))) {
      reconcileSelectionLauncher({ updateOpenTabs: true });
    }
    void withSettingsLock(globalThis.navigator?.locks, () =>
      forgetRevokedTranslationSites(chromeApi.storage.local, chromeApi.permissions)).catch(() => {});
  });
  chromeApi.windows?.onRemoved?.addListener((windowId) => latestPanelSelectionByWindow.delete(windowId));

  function invalidate(entry) {
    if (entry.notice || entry.text.length > MAX_TEXT_LENGTH) return;
    if (entry.configInvalidated) return;
    entry.configInvalidated = true;
    entry.controller?.abort();
    entry.controller = null;
    if (!entry.shown) return;
    send(entry, {
      type: 'TRANSMATE_INLINE_INVALIDATE', requestId: entry.requestId,
      error: localize('translationSettingsUpdated', '翻译配置已更新，请重试。'),
    }).then((response) => {
      if (response?.ok !== true) cancel(entry);
    }).catch(() => cancel(entry));
  }

  chromeApi.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    const changedSites = changes[PAGE_TRANSLATION_SITES];
    if (changedSites) {
      const enabled = new Set(storedSites(changedSites.newValue).map(({ origin }) => origin));
      const disabled = storedSites(changedSites.oldValue).map(({ origin }) => origin).filter((origin) => !enabled.has(origin));
      pageActions.cancelAutoSites(new Set(disabled));
    }
    if (!changes.settings && !glossaryAffectsTranslations(changes[GLOSSARY_STORAGE_KEY])) return;
    if (changes.settings) videoActions.cancelAll();
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
