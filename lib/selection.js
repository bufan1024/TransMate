const SELECTION_MAX_AGE_MS = 30_000;
const SELECTION_STORAGE_PREFIX = 'pendingSelection:';

export function selectionStoragePrefix(windowId) {
  return `${SELECTION_STORAGE_PREFIX}${windowId}:`;
}

export function selectionStorageKey(windowId, selectionId) {
  return `${selectionStoragePrefix(windowId)}${selectionId}`;
}

export function selectionWindowIdFromKey(key) {
  const match = /^pendingSelection:(\d+):[^:]+$/.exec(key);
  return match ? Number(match[1]) : null;
}

export function compareSelections(left, right) {
  const leftOrder = Number.isSafeInteger(left.order) ? left.order : left.createdAt * 1000;
  const rightOrder = Number.isSafeInteger(right.order) ? right.order : right.createdAt * 1000;
  return leftOrder - rightOrder || left.id.localeCompare(right.id);
}

export function shouldAcceptSelection(selection, windowId, now = Date.now()) {
  if (!selection || typeof selection !== 'object') return false;
  if (typeof selection.id !== 'string' || !selection.id.trim()) return false;
  if (typeof selection.text !== 'string' || !selection.text.trim()) return false;
  if (Object.hasOwn(selection, 'result')) {
    const { result } = selection;
    if (typeof result?.translation !== 'string' || !result.translation.trim()
        || typeof result.targetLanguageId !== 'string' || !result.targetLanguageId.trim()
        || typeof result.targetLanguage !== 'string' || !result.targetLanguage.trim()) return false;
  }
  if (!Number.isInteger(windowId) || selection.windowId !== windowId) return false;
  if (!Number.isFinite(selection.createdAt)) return false;
  return selection.createdAt <= now && now - selection.createdAt <= SELECTION_MAX_AGE_MS;
}

export function isInjectableUrl(url) {
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
