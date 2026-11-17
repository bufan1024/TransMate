import { DEFAULT_SETTINGS, TARGET_LANGUAGES, validateSettings } from './config.js';
import { message as localize } from './i18n.js';
import { translate } from './translator.js';

export const VIDEO_MENU = 'translate-video-captions';
export const VIDEO_CUE = 'TRANSMATE_VIDEO_CUE';
export const VIDEO_STOP = 'TRANSMATE_VIDEO_STOP';

const PREFIX = 'captionSession:';

export function createVideoActions(chromeApi, { privateStorageReady, isInjectableUrl }) {
  const sessions = new Map();
  const pendingStarts = new Map();
  let lastOrder = 0;
  const key = (tabId, requestId) => `${PREFIX}${tabId}:${requestId}`;

  function nextOrder() {
    lastOrder = Math.max(Date.now() * 1_000, lastOrder + 1);
    return lastOrder;
  }

  function send(entry, message) {
    return chromeApi.tabs.sendMessage(entry.tabId, message, { documentId: entry.documentId });
  }

  async function retire(entry, { hide = false } = {}) {
    entry.closed = true;
    entry.controller?.abort();
    try {
      await chromeApi.storage.session.remove(key(entry.tabId, entry.requestId));
    } finally {
      if (sessions.get(entry.tabId) === entry) sessions.delete(entry.tabId);
      if (hide) await send(entry, { type: 'TRANSMATE_VIDEO_HIDE', requestId: entry.requestId }).catch(() => {});
    }
  }

  async function retireStored(before, { tabId, hide = true } = {}) {
    const stored = await chromeApi.storage.session.get(null);
    const prefix = tabId === undefined ? PREFIX : `${PREFIX}${tabId}:`;
    await Promise.allSettled(Object.entries(stored)
      .filter(([storageKey, entry]) => storageKey.startsWith(prefix) && entry?.order <= before
        && sessions.get(entry.tabId)?.requestId !== entry.requestId)
      .map(([, entry]) => retire(entry, { hide })));
  }

  function leave(tabId, { hide = true } = {}) {
    pendingStarts.delete(tabId);
    const entry = sessions.get(tabId);
    if (entry && !entry.closed) void retire(entry, { hide }).catch(() => {});
    void retireStored(nextOrder(), { tabId, hide }).catch(() => {});
  }

  async function start(tab, { frameId = 0, srcUrl = '' } = {}) {
    if (!Number.isInteger(tab?.id) || !isInjectableUrl(tab.url)) return;
    const tabId = tab.id;
    const requestId = crypto.randomUUID();
    const order = nextOrder();
    pendingStarts.set(tabId, requestId);
    const previous = sessions.get(tabId);
    if (previous && !previous.closed) void retire(previous, { hide: true }).catch(() => {});
    try {
      if (!await privateStorageReady || pendingStarts.get(tabId) !== requestId) return;
      const [frame] = await chromeApi.scripting.executeScript({
        target: { tabId, frameIds: [frameId] }, files: ['video-content.js'],
      });
      if (!frame?.documentId || pendingStarts.get(tabId) !== requestId) return;
      const entry = { tabId, frameId: frame.frameId, documentId: frame.documentId, requestId, order };
      sessions.set(tabId, entry);
      await chromeApi.storage.session.set({ [key(tabId, requestId)]: entry });
      if (sessions.get(tabId) !== entry || entry.closed) {
        await retire(entry);
        return;
      }
      void retireStored(order - 1, { tabId }).catch(() => {});
      const response = await send(entry, { type: 'TRANSMATE_VIDEO_START', requestId, srcUrl, languages: TARGET_LANGUAGES });
      if (!response?.ok && sessions.get(tabId) === entry) leave(tabId);
    } catch {
      if (pendingStarts.get(tabId) === requestId) leave(tabId);
    } finally {
      if (pendingStarts.get(tabId) === requestId) pendingStarts.delete(tabId);
    }
  }

  async function handle(message, sender) {
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(tabId) || !sender.documentId || !message.requestId) return;
    let entry = sessions.get(tabId);
    if (!entry && !pendingStarts.has(tabId)) {
      const storageKey = key(tabId, message.requestId);
      const { [storageKey]: saved } = await chromeApi.storage.session.get(storageKey);
      entry = sessions.get(tabId);
      if (!entry && !pendingStarts.has(tabId) && saved?.requestId === message.requestId
          && saved.documentId === sender.documentId && saved.frameId === sender.frameId) {
        entry = saved;
        sessions.set(tabId, entry);
      }
    }
    if (entry?.requestId !== message.requestId || entry.closed || entry.documentId !== sender.documentId
        || entry.frameId !== sender.frameId) return;
    if (message.type === VIDEO_STOP) {
      leave(tabId, { hide: false });
      return;
    }

    if (message.targetLanguage && !TARGET_LANGUAGES.some(({ id }) => id === message.targetLanguage)) return;
    entry.controller?.abort();
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!text) return;
    const controller = new AbortController();
    entry.controller = controller;
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const { settings } = await chromeApi.storage.local.get('settings');
      if (controller.signal.aborted) return;
      const config = validateSettings({
        ...settings,
        targetLanguage: message.targetLanguage || settings?.targetLanguage || DEFAULT_SETTINGS.targetLanguage,
      });
      const translation = await translate({
        text, settings: config, permissionsApi: chromeApi.permissions, signal: controller.signal,
      });
      if (controller.signal.aborted || sessions.get(tabId) !== entry) return;
      return { translation };
    } catch (error) {
      const message = controller.signal.aborted
        ? localize('captionCancelled', '字幕翻译已取消或超时。')
        : error?.message || localize('captionTranslationFailed', '无法翻译字幕。');
      return { error: message };
    } finally {
      clearTimeout(timer);
      if (entry.controller === controller) entry.controller = null;
    }
  }

  function cancelAll() {
    pendingStarts.clear();
    for (const entry of sessions.values()) {
      if (!entry.closed) void retire(entry, { hide: true }).catch(() => {});
    }
    void retireStored(nextOrder()).catch(() => {});
  }

  return { start, handle, leave, cancelAll };
}
