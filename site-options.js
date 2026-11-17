import {
  PAGE_TRANSLATION_SITES, disablePageTranslationSite, enablePageTranslationSite,
  pageTranslationSite, readPageTranslationSites,
} from './lib/page-translation-sites.js';
import { message as localize } from './lib/i18n.js';
import { withSettingsLock } from './lib/settings-management.js';

const form = document.querySelector('#site-translation-form');
const address = document.querySelector('#site-translation-address');
const enable = document.querySelector('#enable-site-translation');
const list = document.querySelector('#site-translation-list');
const status = document.querySelector('#site-translation-status');
let busy = false;
let refreshNumber = 0;

function show(message, tone) {
  status.textContent = message;
  status.dataset.tone = tone;
  status.hidden = false;
}

function setBusy(value) {
  busy = value;
  enable.disabled = value;
  address.disabled = value;
  for (const button of list.querySelectorAll('button')) button.disabled = value;
}

async function refresh() {
  const refresh = ++refreshNumber;
  try {
    const sites = await readPageTranslationSites(chrome.storage.local);
    if (refresh !== refreshNumber) return;
    list.replaceChildren();
    if (!sites.length) {
      const empty = document.createElement('li');
      empty.className = 'permission-empty';
      empty.textContent = localize('noAutoTranslationSites', '尚未启用任何站点。');
      list.append(empty);
      return;
    }
    for (const site of sites.sort((first, second) => first.origin.localeCompare(second.origin))) {
      const row = document.createElement('li');
      const origin = document.createElement('span');
      origin.textContent = site.origin;
      const disable = document.createElement('button');
      disable.type = 'button';
      disable.className = 'permission-revoke';
      disable.textContent = localize('close', '关闭');
      disable.setAttribute('aria-label', localize('disableSiteAutoTranslation', `关闭 ${site.origin} 的自动翻译`, site.origin));
      disable.disabled = busy;
      disable.addEventListener('click', () => turnOff(site));
      row.append(origin, disable);
      list.append(row);
    }
  } catch {
    if (refresh === refreshNumber) show(localize('sitePreferencesReadError', '无法读取站点偏好，请重新打开设置页。'), 'error');
  }
}

async function turnOff(site) {
  if (busy) return;
  setBusy(true);
  try {
    const released = await withSettingsLock(globalThis.navigator?.locks, () =>
      disablePageTranslationSite(site, chrome.storage.local, chrome.permissions));
    show(released ? localize('siteAutoTranslationDisabled', `已关闭 ${site.origin} 的自动翻译。`, site.origin)
      : localize('siteDisabledWithPermission', `已关闭 ${site.origin} 的自动翻译。网站授权仍可在 Chrome 扩展设置中处理。`, site.origin),
    released ? 'success' : 'error');
  } catch {
    show(localize('disableSiteAutoTranslationError', '无法关闭站点自动翻译，请重试。'), 'error');
  } finally {
    await refresh();
    setBusy(false);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const site = pageTranslationSite(address.value.trim());
  if (!site) {
    show(localize('invalidAutoTranslationSite', '请输入普通 HTTPS 网页的地址。HTTP 仅支持 localhost 和 127.0.0.1。'), 'error');
    return;
  }

  setBusy(true);
  try {
    // The optional site grant must be requested during the submit gesture.
    const granted = await chrome.permissions.request({ origins: [site.pattern] });
    if (!granted) {
      show(localize('sitePermissionDenied', '未授予访问权限。站点偏好保持原状。'), 'error');
      return;
    }
    await withSettingsLock(globalThis.navigator?.locks, () =>
      enablePageTranslationSite(site, chrome.storage.local, chrome.permissions));
    address.value = '';
    show(localize('siteAutoTranslationEnabled', `已启用 ${site.origin} 的自动翻译，下次加载该站点页面时生效。`, site.origin), 'success');
  } catch {
    show(localize('enableSiteAutoTranslationError', '无法启用站点自动翻译，请检查 Chrome 的站点权限后重试。'), 'error');
  } finally {
    await refresh();
    setBusy(false);
  }
});

const prefilled = pageTranslationSite(new URL(location.href).searchParams.get('site'));
if (prefilled) address.value = prefilled.origin;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[PAGE_TRANSLATION_SITES]) void refresh();
});
void refresh();
