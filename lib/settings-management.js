import { PROVIDERS, originPatternForEndpoint, validateSettings } from './config.js';

function serviceIdentity(draft) {
  if (!draft || typeof draft !== 'object') return null;
  const provider = PROVIDERS.find(({ id }) => id === draft.provider);
  if (!provider) return null;
  const endpoint = typeof draft.endpoint === 'string' && draft.endpoint.trim()
    ? draft.endpoint.trim() : provider.endpoint;
  try {
    return { provider: provider.id, endpoint: new URL(endpoint).href };
  } catch {
    return null;
  }
}

export function canReuseSavedKey(draft, savedSettings) {
  if (typeof savedSettings?.apiKey !== 'string' || !savedSettings.apiKey) return false;
  const identity = serviceIdentity(draft);
  return identity?.provider === savedSettings.provider && identity.endpoint === savedSettings.endpoint;
}

export function resolveSettings(draft, savedSettings) {
  const typedKey = typeof draft?.apiKey === 'string' ? draft.apiKey.trim() : '';
  if (typedKey) return validateSettings({ ...draft, apiKey: typedKey });
  if (canReuseSavedKey(draft, savedSettings)) {
    return validateSettings({ ...draft, apiKey: savedSettings.apiKey });
  }

  // Report endpoint/model errors before asking for a key, but never return this probe.
  validateSettings({ ...draft, apiKey: '__validation_only__' });
  throw new Error('请填写当前服务的 API Key；留空只可沿用同一服务和完整接口地址的已保存密钥。');
}

async function removeExactGrantedOrigin(origin, permissionsApi) {
  const granted = await permissionsApi.getAll();
  if (!granted?.origins?.includes(origin)) return { wasGranted: false, removed: false };
  const removed = await permissionsApi.remove({ origins: [origin] });
  return { wasGranted: true, removed };
}

export async function revokeGrantedOrigin(origin, permissionsApi) {
  return (await removeExactGrantedOrigin(origin, permissionsApi)).removed;
}

export async function persistSettings({ nextSettings, previousSettings, storageArea, permissionsApi }) {
  if (nextSettings === null) {
    await storageArea.remove('settings');
    try {
      const granted = await permissionsApi.getAll();
      let oldOrigin = null;
      try { oldOrigin = previousSettings?.endpoint ? originPatternForEndpoint(previousSettings.endpoint) : null; } catch {}
      let cleanupFailed = false;
      let retiredOrigin = null;
      for (const origin of new Set(granted?.origins || [])) {
        try {
          if (await permissionsApi.remove({ origins: [origin] })) {
            if (origin === oldOrigin) retiredOrigin = origin;
          } else cleanupFailed = true;
        } catch {
          cleanupFailed = true;
        }
      }
      return { cleanupFailed, retiredOrigin };
    } catch {
      return { cleanupFailed: true, retiredOrigin: null };
    }
  } else {
    await storageArea.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await storageArea.set({ settings: nextSettings });
  }

  try {
    const oldOrigin = previousSettings?.endpoint
      ? originPatternForEndpoint(previousSettings.endpoint) : null;
    const nextOrigin = nextSettings?.apiKey
      ? originPatternForEndpoint(nextSettings.endpoint) : null;
    if (!oldOrigin || oldOrigin === nextOrigin) {
      return { cleanupFailed: false, retiredOrigin: null };
    }
    const { wasGranted, removed } = await removeExactGrantedOrigin(oldOrigin, permissionsApi);
    if (wasGranted && !removed) return { cleanupFailed: true, retiredOrigin: null };
    return { cleanupFailed: false, retiredOrigin: removed ? oldOrigin : null };
  } catch {
    return { cleanupFailed: true, retiredOrigin: null };
  }
}
