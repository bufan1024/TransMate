import { originPatternForEndpoint } from './config.js';

export const PAGE_TRANSLATION_SITES = 'pageTranslationSites';
export const SITE_MENU_PATTERNS = ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'];

export function pageTranslationSite(input) {
  try {
    const url = new URL(input);
    if (url.username || url.password || !url.hostname || url.hostname.includes('*')) return null;
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) return null;
    if (url.hostname === 'chromewebstore.google.com'
        || (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'))) return null;
    return { origin: url.origin, pattern: `${url.protocol}//${url.hostname}/*` };
  } catch {
    return null;
  }
}

export function storedSites(value) {
  const sites = new Map();
  for (const origin of Array.isArray(value) ? value : []) {
    const site = pageTranslationSite(origin);
    if (site?.origin === origin) sites.set(origin, site);
  }
  return [...sites.values()];
}

export async function readPageTranslationSites(storageArea) {
  const stored = await storageArea.get?.(PAGE_TRANSLATION_SITES);
  return storedSites(stored?.[PAGE_TRANSLATION_SITES]);
}

export async function canAutomaticallyTranslate(site, storageArea, permissionsApi) {
  try {
    const sites = await readPageTranslationSites(storageArea);
    return sites.some(({ origin }) => origin === site.origin)
      && await permissionsApi.contains({ origins: [site.pattern] });
  } catch {
    return false;
  }
}

export async function enablePageTranslationSite(site, storageArea, permissionsApi) {
  if (!await permissionsApi.contains({ origins: [site.pattern] })) {
    throw new Error('网站授权已变更，请重新点击授权并启用。');
  }
  const sites = await readPageTranslationSites(storageArea);
  if (sites.some(({ origin }) => origin === site.origin)) return;
  await storageArea.set({ [PAGE_TRANSLATION_SITES]: [...sites.map(({ origin }) => origin), site.origin] });
}

export async function disablePageTranslationSite(site, storageArea, permissionsApi) {
  const sites = await readPageTranslationSites(storageArea);
  const next = sites.filter(({ origin }) => origin !== site.origin);
  if (next.length === sites.length) return true;
  await storageArea.set({ [PAGE_TRANSLATION_SITES]: next.map(({ origin }) => origin) });
  if (next.some(({ pattern }) => pattern === site.pattern)) return true;

  try {
    const { settings } = await storageArea.get('settings');
    if (settings?.apiKey && originPatternForEndpoint(settings.endpoint) === site.pattern) return true;
    const { origins = [] } = await permissionsApi.getAll();
    return !origins.includes(site.pattern) || await permissionsApi.remove({ origins: [site.pattern] });
  } catch {
    return false;
  }
}

export async function forgetRevokedTranslationSites(storageArea, permissionsApi) {
  const sites = await readPageTranslationSites(storageArea);
  const next = [];
  for (const site of sites) {
    if (await permissionsApi.contains({ origins: [site.pattern] })) next.push(site.origin);
  }
  if (next.length !== sites.length) await storageArea.set({ [PAGE_TRANSLATION_SITES]: next });
}
