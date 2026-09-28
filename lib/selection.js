const SELECTION_MAX_AGE_MS = 30_000;

export function shouldAcceptSelection(selection, windowId, now = Date.now()) {
  if (!selection || typeof selection !== 'object') return false;
  if (typeof selection.id !== 'string' || !selection.id.trim()) return false;
  if (typeof selection.text !== 'string' || !selection.text.trim()) return false;
  if (!Number.isInteger(windowId) || selection.windowId !== windowId) return false;
  if (!Number.isFinite(selection.createdAt)) return false;
  return selection.createdAt <= now && now - selection.createdAt <= SELECTION_MAX_AGE_MS;
}
