export function message(name, fallback, ...values) {
  return globalThis.chrome?.i18n?.getMessage?.(name, values.map(String)) || fallback;
}

export function localizeDocument(root = document) {
  if (!root.documentElement) return;
  root.documentElement.lang = message('locale', 'zh-CN');
  for (const element of root.querySelectorAll('[data-i18n]')) {
    element.textContent = message(element.dataset.i18n, element.textContent);
  }
  for (const attribute of ['aria-label', 'title', 'placeholder', 'label']) {
    for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      const key = element.getAttribute(`data-i18n-${attribute}`);
      element.setAttribute(attribute, message(key, element.getAttribute(attribute)));
    }
  }
}
