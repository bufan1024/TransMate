export const HISTORY_KEY = 'translationHistory';
const MAX_ENTRIES = 100;
const MAX_TEXT = 10_000;
const HISTORY_LOCK = 'transmate-translation-history';

export function historyState(value) {
  return {
    enabled: value?.enabled === true,
    entries: Array.isArray(value?.entries) ? value.entries : [],
  };
}

async function updateHistory(storage, locks, update) {
  if (typeof locks?.request !== 'function') throw new Error('无法安全更新本机翻译历史。');
  return locks.request(HISTORY_LOCK, async () => {
    const current = historyState((await storage.get(HISTORY_KEY))[HISTORY_KEY]);
    const next = update(current);
    if (next) await storage.set({ [HISTORY_KEY]: next });
    return next || current;
  });
}

export function setHistoryEnabled(storage, locks, enabled) {
  return updateHistory(storage, locks, (current) => ({ ...current, enabled }));
}

export function clearHistory(storage, locks) {
  return updateHistory(storage, locks, (current) => ({ ...current, entries: [] }));
}

export function deleteHistoryEntry(storage, locks, id) {
  return updateHistory(storage, locks, (current) => ({
    ...current, entries: current.entries.filter((entry) => entry.id !== id),
  }));
}

export async function recordTranslation(storage, locks, { source, translation, targetLanguage }) {
  if (typeof source !== 'string' || typeof translation !== 'string' || !source.trim() || !translation.trim()
      || source.length > MAX_TEXT || translation.length > MAX_TEXT) return;
  const stored = historyState((await storage.get(HISTORY_KEY))[HISTORY_KEY]);
  if (!stored.enabled) return;

  await updateHistory(storage, locks, (current) => {
    if (!current.enabled) return null;
    const entry = { id: crypto.randomUUID(), source, translation, targetLanguage, createdAt: Date.now() };
    return { ...current, entries: [entry, ...current.entries].slice(0, MAX_ENTRIES) };
  });
}
