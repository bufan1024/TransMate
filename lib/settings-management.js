import { message as localize } from './i18n.js';
import {
  DEFAULT_SETTINGS, PROVIDERS, defaultAuthTypeForProvider, normalizeEndpoint, originPatternForEndpoint, validateSettings,
} from './config.js';

import { readPageTranslationSites } from './page-translation-sites.js';
import { SELECTION_LAUNCHER_KEY, SELECTION_LAUNCHER_ORIGINS } from './selection-launcher-settings.js';

export const SERVICE_PROFILES_KEY = 'serviceProfiles';
export const DEFAULT_PROFILE_NAME = localize('defaultProfileName', '默认配置');
const SETTINGS_KEYS = ['settings', SERVICE_PROFILES_KEY];
const LEGACY_PROFILE_ID = 'legacy';

function serviceIdentity(draft) {
  if (!draft || typeof draft !== 'object') return null;
  const providerId = typeof draft.provider === 'string' ? draft.provider.trim() : DEFAULT_SETTINGS.provider;
  const provider = PROVIDERS.find(({ id }) => id === providerId);
  if (!provider) return null;
  const endpoint = typeof draft.endpoint === 'string' && draft.endpoint.trim()
    ? draft.endpoint.trim() : provider.endpoint;
  try {
    return { provider: provider.id, endpoint: normalizeEndpoint(endpoint, provider.id) };
  } catch {
    return null;
  }
}

export function canReuseSavedKey(draft, savedSettings) {
  if (typeof savedSettings?.apiKey !== 'string' || !savedSettings.apiKey) return false;
  const identity = serviceIdentity(draft);
  const previous = serviceIdentity(savedSettings);
  if (!identity || !previous || identity.provider !== previous.provider || identity.endpoint !== previous.endpoint) {
    return false;
  }
  const defaultAuthType = defaultAuthTypeForProvider(identity.provider);
  const authType = draft.authType ?? defaultAuthType;
  return authType !== 'none' && authType === (savedSettings.authType ?? defaultAuthType);
}

export function resolveSettings(draft, savedSettings) {
  if (draft?.authType === 'none') return validateSettings(draft);
  const typedKey = typeof draft?.apiKey === 'string' ? draft.apiKey.trim() : '';
  if (typedKey) return validateSettings({ ...draft, apiKey: typedKey });
  if (canReuseSavedKey(draft, savedSettings)) {
    return validateSettings({ ...draft, apiKey: savedSettings.apiKey });
  }

  // Report endpoint/model errors before asking for a key, but never return this probe.
  validateSettings({ ...draft, apiKey: '__validation_only__' });
  throw new Error(localize('keyNeeded', '请填写当前服务的 API Key；留空只可沿用服务、完整接口地址与认证方式均相同的已保存密钥。'));
}

export class SettingsOperationError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'SettingsOperationError';
    this.kind = kind;
  }
}

export async function withSettingsLock(lockManager, operation) {
  if (typeof lockManager?.request !== 'function') {
    throw new SettingsOperationError('lock', localize('settingsLockUnsupported', '当前浏览器不支持安全的多页面设置操作，请升级 Chrome 后重试。'));
  }
  return lockManager.request('transmate-settings', { mode: 'exclusive' }, operation);
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function normalizeServiceProfiles({ settings, serviceProfiles }) {
  if (serviceProfiles === undefined) {
    return isRecord(settings)
      ? { activeId: LEGACY_PROFILE_ID, profiles: [{ id: LEGACY_PROFILE_ID, name: DEFAULT_PROFILE_NAME, settings }] }
      : { activeId: null, profiles: [] };
  }
  const { activeId, profiles } = serviceProfiles || {};
  const ids = new Set();
  if (!Array.isArray(profiles) || profiles.some((profile) => {
    if (!profile || typeof profile.id !== 'string' || !profile.id || ids.has(profile.id)
        || typeof profile.name !== 'string' || !profile.name.trim() || !isRecord(profile.settings)) return true;
    ids.add(profile.id);
    return false;
  }) || (profiles.length ? !ids.has(activeId) : activeId !== null)) {
    throw new SettingsOperationError('validation', localize('profileCatalogReadFailed', '无法读取本机的服务配置，请检查配置或重置。'));
  }
  return { activeId, profiles };
}

export async function readServiceProfiles(storageArea) {
  return normalizeServiceProfiles(await storageArea.get(SETTINGS_KEYS));
}

export function profileOrigin(profile) {
  try {
    const config = validateSettings(profile.settings);
    return originPatternForEndpoint(config.endpoint, config.provider);
  } catch {
    return null;
  }
}

function requireProfile(state, id) {
  const profile = state.profiles.find((item) => item.id === id);
  if (!profile) throw new SettingsOperationError('conflict', localize('profileRemoved', '该配置已被删除。请选择其他配置或新建。'));
  return profile;
}

async function confirmOrigin(origin, permissionsApi) {
  let granted;
  try {
    granted = await permissionsApi.contains({ origins: [origin] });
  } catch {
    throw new SettingsOperationError('permission', localize('cannotCheckGrant', '无法确认服务域名授权，请重试并允许授权。'));
  }
  if (!granted) {
    throw new SettingsOperationError('permission', localize('grantChanged', '服务域名授权已变化，请重试并允许授权。'));
  }
}

export async function revokeGrantedOrigin(origin, permissionsApi) {
  const granted = await permissionsApi.getAll();
  if (!granted?.origins?.includes(origin)) return false;
  return permissionsApi.remove({ origins: [origin] });
}

async function retireOrigins(permissionsApi, storageArea, orphaned = null) {
  if (orphaned?.size === 0) return { cleanupFailed: false };
  let cleanupFailed = false;
  try {
    const retainedSites = new Set((await readPageTranslationSites(storageArea)).map(({ pattern }) => pattern));
    const granted = await permissionsApi.getAll();
    const grantedOrigins = new Set(granted?.origins || []);
    if (!orphaned && SELECTION_LAUNCHER_ORIGINS.some((origin) => grantedOrigins.has(origin))) {
      const { [SELECTION_LAUNCHER_KEY]: enabled } = await storageArea.get(SELECTION_LAUNCHER_KEY);
      for (const origin of SELECTION_LAUNCHER_ORIGINS) {
        const scheme = origin.split('*')[0];
        // A site's grant can be covered by a wildcard without its own entry.
        if (enabled === true || [...retainedSites].some((site) =>
          site.startsWith(scheme) && !grantedOrigins.has(site))) {
          retainedSites.add(origin);
        }
      }
    }
    for (const origin of grantedOrigins) {
      if (retainedSites.has(origin) || (orphaned && !orphaned.has(origin))) continue;
      try {
        if (!await permissionsApi.remove({ origins: [origin] })) cleanupFailed = true;
      } catch {
        cleanupFailed = true;
      }
    }
  } catch {
    cleanupFailed = true;
  }
  return { cleanupFailed };
}

async function persistProfileState(state, previous, { storageArea, permissionsApi }) {
  const active = state.profiles.find(({ id }) => id === state.activeId);
  if (active) {
    await storageArea.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    // Translation contexts still read the active settings key. Write both
    // views together so a switch cannot expose half of a profile update.
    await storageArea.set({ [SERVICE_PROFILES_KEY]: state, settings: active.settings });
  } else {
    await storageArea.remove(SETTINGS_KEYS);
  }
  const referenced = new Set(state.profiles.map(profileOrigin));
  const orphaned = new Set(previous.profiles.map(profileOrigin)
    .filter((origin) => origin && !referenced.has(origin)));
  return { state, ...await retireOrigins(permissionsApi, storageArea, orphaned) };
}

export function saveSettingsWithPermission({ draft, name, profileId, ...environment }) {
  return withSettingsLock(environment.lockManager, async () => {
    const previous = await readServiceProfiles(environment.storageArea);
    const saved = profileId === null ? null : requireProfile(previous, profileId);
    let settings;
    try {
      name = typeof name === 'string' ? name.trim() : '';
      if (!name || name.length > 48) throw new Error(localize('profileNameLength', '请输入 1 到 48 个字符的配置名称。'));
      settings = resolveSettings(draft, saved?.settings);
    } catch (error) {
      throw new SettingsOperationError('validation', error.message);
    }
    await confirmOrigin(originPatternForEndpoint(settings.endpoint, settings.provider), environment.permissionsApi);
    const profile = { id: saved?.id ?? crypto.randomUUID(), name, settings };
    const profiles = saved
      ? previous.profiles.map((item) => item.id === profile.id ? profile : item)
      : [...previous.profiles, profile];
    const state = { activeId: previous.activeId ?? profile.id, profiles };
    return { profile, ...await persistProfileState(state, previous, environment) };
  });
}

export function activateServiceProfile({ profileId, expectedOrigin, ...environment }) {
  return withSettingsLock(environment.lockManager, async () => {
    const previous = await readServiceProfiles(environment.storageArea);
    const profile = requireProfile(previous, profileId);
    const origin = profileOrigin(profile);
    if (!origin) {
      throw new SettingsOperationError('validation', localize('profileIncomplete', '请先到设置中为这套配置补齐服务信息和 API Key。'));
    }
    if (expectedOrigin !== origin) {
      throw new SettingsOperationError('permission', localize('activateOriginChanged', '服务域名已变更，请重新选择配置并授权。'));
    }
    await confirmOrigin(origin, environment.permissionsApi);
    if (profileId === previous.activeId) return { state: previous };
    return persistProfileState({ ...previous, activeId: profileId }, previous, environment);
  });
}

export function clearServiceProfileKey({ profileId, ...environment }) {
  return withSettingsLock(environment.lockManager, async () => {
    const previous = await readServiceProfiles(environment.storageArea);
    const saved = requireProfile(previous, profileId);
    if (!saved.settings.apiKey) return { state: previous, noKey: true };
    const profile = { ...saved, settings: { ...saved.settings, apiKey: '' } };
    const profiles = previous.profiles.map((item) => item.id === profile.id ? profile : item);
    return persistProfileState({ ...previous, profiles }, previous, environment);
  });
}

export function deleteServiceProfile({ profileId, ...environment }) {
  return withSettingsLock(environment.lockManager, async () => {
    const previous = await readServiceProfiles(environment.storageArea);
    requireProfile(previous, profileId);
    const profiles = previous.profiles.filter(({ id }) => id !== profileId);
    const fallback = profiles.find(profileOrigin) ?? profiles[0];
    const activeId = previous.activeId === profileId ? fallback?.id ?? null : previous.activeId;
    return persistProfileState({ activeId, profiles }, previous, environment);
  });
}

export function resetServiceProfiles({ storageArea, permissionsApi, lockManager }) {
  return withSettingsLock(lockManager, async () => {
    await storageArea.remove(SETTINGS_KEYS);
    return retireOrigins(permissionsApi, storageArea);
  });
}
