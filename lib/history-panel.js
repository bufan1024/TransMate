import { message as localize } from './i18n.js';
import { TARGET_LANGUAGES } from "./config.js";
import {
  clearHistory, deleteHistoryEntry, HISTORY_KEY, historyState, setHistoryEnabled,
} from './translation-history.js';

export function createHistoryPanel(chromeApi, root) {
  const enable = root.querySelector('#enable-translation-history');
  const list = root.querySelector('#translation-history-list');
  const status = root.querySelector('#translation-history-status');
  const clear = root.querySelector('#clear-translation-history');
  let state = historyState();
  let version = 0;
  let initialized = false;
  let busy = false;

  function render() {
    if (!busy) enable.checked = state.enabled;
    enable.disabled = !initialized || busy;
    clear.disabled = busy || !state.entries.length;
    const expanded = new Set([...list.querySelectorAll("details[open]")].map((details) => details.dataset.historyId));
    const items = state.entries.map((entry) => {
      const item = root.createElement('li');
      const details = root.createElement('details');
      const title = root.createElement('summary');
      const source = root.createElement('p');
      const languageLabel = root.createElement('small');
      const translation = root.createElement('p');
      const remove = root.createElement('button');
      const language = TARGET_LANGUAGES.find(({ id }) => id === entry.targetLanguage)?.name || entry.targetLanguage;
      details.dataset.historyId = entry.id;
      details.open = expanded.has(entry.id);
      const name = entry.source.replace(/\s+/g, ' ').trim();
      title.textContent = name.length > 44 ? name.slice(0, 44) + '…' : name;
      source.textContent = entry.source;
      source.dir = 'auto';
      languageLabel.textContent = language ? localize('translateToLanguage', `译为${language}`, language) : localize('translation', '译文');
      translation.textContent = entry.translation;
      translation.dir = 'auto';
      translation.className = 'history-result';
      remove.type = 'button';
      remove.className = 'secondary-button';
      remove.textContent = localize('delete', '删除');
      remove.setAttribute('aria-label', localize('deleteHistoryEntry', '删除此条翻译历史'));
      remove.disabled = busy;
      remove.addEventListener('click', () => mutate(deleteHistoryEntry, entry.id));
      details.append(title, source, languageLabel, translation, remove);
      item.append(details);
      return item;
    });
    list.replaceChildren(...items);
    status.textContent = state.enabled
      ? state.entries.length ? '' : localize('emptyHistory', '暂无翻译历史。')
      : localize('historyDisabled', '记录已关闭。');
  }

  function initialize(stored, snapshotVersion) {
    if (snapshotVersion === version) state = historyState(stored);
    initialized = true;
    render();
  }

  function receive(value) {
    version += 1;
    state = historyState(value);
    render();
  }

  async function mutate(operation, ...args) {
    if (busy || !initialized) return;
    const previousVersion = version;
    busy = true;
    render();
    let failed = false;
    try {
      const result = await operation(chromeApi.storage.local, globalThis.navigator?.locks, ...args);
      if (version === previousVersion) state = result;
    } catch {
      failed = true;
    } finally {
      busy = false;
      render();
      if (failed) status.textContent = localize('historyUpdateError', '无法更新本机历史，请重试。');
    }
  }

  enable.addEventListener('change', () => mutate(setHistoryEnabled, enable.checked));
  clear.addEventListener('click', () => mutate(clearHistory));
  return { initialize, receive, get version() { return version; } };
}
