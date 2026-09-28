(() => {
  const SINGLETON_KEY = '__transmateInlineTranslation';
  if (globalThis[SINGLETON_KEY]) return;

  const MESSAGE = {
    show: 'TRANSMATE_INLINE_SHOW',
    result: 'TRANSMATE_INLINE_RESULT',
    invalidate: 'TRANSMATE_INLINE_INVALIDATE',
    hide: 'TRANSMATE_INLINE_HIDE',
    cancel: 'TRANSMATE_INLINE_CANCEL',
    retry: 'TRANSMATE_INLINE_RETRY',
    options: 'TRANSMATE_INLINE_OPEN_OPTIONS',
  };
  const WATCHDOG_MS = 30_000;
  const state = {
    requestId: null,
    invalidatedRequestId: null,
    latestOrder: 0,
    retryingRequestId: null,
    source: '',
    translation: '',
    error: '',
    status: 'loading',
    anchor: null,
    host: null,
    elements: null,
    positionFrame: null,
    watchdog: null,
    copyReset: null,
  };
  globalThis[SINGLETON_KEY] = state;

  const styles = `
    :host { all: initial; color-scheme: light; }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .card {
      max-height: min(530px, calc(100vh - 24px));
      overflow: auto;
      border: 1px solid #e5dfd3;
      border-radius: 16px;
      background: #fffdf8;
      box-shadow: 0 18px 52px rgba(30, 32, 27, .18), 0 3px 10px rgba(30, 32, 27, .08);
      color: #20231f;
      font: 13px/1.55 "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    button { font: inherit; cursor: pointer; }
    button:focus-visible { outline: 2px solid #d75a2e; outline-offset: 2px; }
    button:disabled { cursor: default; opacity: .42; }
    .header { display: flex; align-items: center; gap: 9px; padding: 13px 14px 10px; }
    .mark { display: grid; place-items: center; width: 27px; height: 27px; flex: none; border-radius: 7px; background: #20231f; color: #fffdf8; font-family: Georgia, serif; font-size: 17px; font-weight: 700; }
    .brand { flex: 1; font-family: Georgia, "Songti SC", serif; font-size: 16px; font-weight: 700; letter-spacing: -.3px; }
    .close { width: 28px; height: 28px; border: 0; border-radius: 7px; background: transparent; color: #777b72; font-size: 20px; line-height: 1; }
    .close:hover { background: #f5f1e8; color: #20231f; }
    .body { padding: 0 14px 12px; }
    .section { border-top: 1px solid #e7e1d6; padding-top: 10px; }
    .label { margin: 0 0 5px; color: #85877f; font-size: 10px; font-weight: 700; letter-spacing: .5px; }
    .source { max-height: 90px; overflow: auto; margin: 0 0 11px; color: #5d6259; font-size: 12px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
    .result { min-height: 55px; max-height: 220px; overflow: auto; margin: 0; color: #20231f; font-size: 14px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
    .loading { display: flex; align-items: center; gap: 9px; min-height: 55px; color: #777b72; font-size: 12px; }
    .spinner { width: 15px; height: 15px; flex: none; border: 2px solid #e8d8ca; border-top-color: #d75a2e; border-radius: 50%; animation: spin .8s linear infinite; }
    .error { min-height: 55px; margin: 0; color: #9e3524; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
    .footer { display: flex; justify-content: flex-end; gap: 5px; padding: 9px 14px 12px; border-top: 1px solid #eee9df; }
    .action { min-height: 28px; padding: 3px 9px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: #4d534b; font-size: 11px; font-weight: 700; }
    .action:not(:disabled):hover { background: #f5f1e8; }
    .action.primary { border-color: #20231f; background: #20231f; color: #fffdf8; }
    .action.primary:not(:disabled):hover { background: #394038; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2s; } }
  `;

  function element(tag, className, label) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (label !== undefined) node.textContent = label;
    return node;
  }

  function send(message) {
    try {
      return Promise.resolve(chrome.runtime.sendMessage(message));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function sendCancel(requestId) {
    if (requestId) send({ type: MESSAGE.cancel, requestId }).catch(() => {});
  }

  function clearWatchdog() {
    if (state.watchdog !== null) clearTimeout(state.watchdog);
    state.watchdog = null;
  }

  function startWatchdog(requestId) {
    clearWatchdog();
    state.watchdog = setTimeout(() => {
      if (state.requestId !== requestId || state.status !== 'loading') return;
      if (state.retryingRequestId === requestId) state.retryingRequestId = null;
      state.status = 'error';
      state.error = '翻译等待超时，请重试。';
      render();
      sendCancel(requestId);
    }, WATCHDOG_MS);
  }

  function selectedRect() {
    try {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.rangeCount) {
        const range = selection.getRangeAt(0);
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
        const rect = rects.at(-1) || range.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        }
      }
    } catch {
      // The page may replace the selection while the context menu is closing.
    }

    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (Number.isInteger(start) && Number.isInteger(end) && start !== end) {
        const rect = active.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        }
      }
    }
    return null;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(value, maximum));
  }

  function position() {
    state.positionFrame = null;
    if (!state.host?.isConnected) return;
    const margin = 12;
    const gap = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = state.host.getBoundingClientRect().width;
    const height = state.host.getBoundingClientRect().height;
    const anchor = selectedRect() || state.anchor;
    if (anchor) state.anchor = anchor;

    let left = anchor ? anchor.left : viewportWidth - width - margin;
    let top = anchor ? anchor.bottom + gap : margin;
    if (anchor && top + height > viewportHeight - margin && anchor.top - height - gap >= margin) {
      top = anchor.top - height - gap;
    }
    left = clamp(left, margin, Math.max(margin, viewportWidth - width - margin));
    top = clamp(top, margin, Math.max(margin, viewportHeight - height - margin));
    state.host.style.left = `${Math.round(left)}px`;
    state.host.style.top = `${Math.round(top)}px`;
  }

  function schedulePosition() {
    if (state.positionFrame !== null) return;
    state.positionFrame = requestAnimationFrame(position);
  }

  function close(cancel) {
    const requestId = state.requestId;
    if (!requestId) return;
    state.requestId = null;
    state.invalidatedRequestId = null;
    state.retryingRequestId = null;
    state.translation = '';
    state.error = '';
    clearWatchdog();
    if (state.copyReset !== null) clearTimeout(state.copyReset);
    state.copyReset = null;
    if (state.positionFrame !== null) cancelAnimationFrame(state.positionFrame);
    state.positionFrame = null;
    state.host?.remove();
    if (cancel) sendCancel(requestId);
  }

  function ensureUI() {
    if (state.host) {
      if (!state.host.isConnected) document.documentElement?.append(state.host);
      return Boolean(state.host.isConnected);
    }
    if (!document.documentElement) return false;

    const host = document.createElement('div');
    host.id = 'transmate-inline-host';
    host.style.setProperty('all', 'initial');
    host.style.setProperty('position', 'fixed');
    host.style.setProperty('left', '12px');
    host.style.setProperty('top', '12px');
    host.style.setProperty('width', 'min(360px, calc(100vw - 24px))');
    host.style.setProperty('z-index', '2147483647');
    host.style.setProperty('pointer-events', 'auto');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = styles;
    shadow.append(style);

    const card = element('section', 'card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'TransMate 划词翻译');
    const header = element('div', 'header');
    header.append(element('span', 'mark', '译'), element('span', 'brand', 'TransMate'));
    const closeButton = element('button', 'close', '×');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', '关闭翻译');
    header.append(closeButton);

    const body = element('div', 'body');
    const sourceSection = element('div', 'section');
    const sourceLabel = element('p', 'label', '原文');
    const source = element('p', 'source');
    sourceSection.append(sourceLabel, source);
    const resultSection = element('div', 'section');
    const resultLabel = element('p', 'label', '译文');
    const loading = element('div', 'loading');
    loading.append(element('span', 'spinner'), element('span', '', '翻译中…'));
    const result = element('p', 'result');
    result.setAttribute('aria-live', 'polite');
    const error = element('p', 'error');
    error.setAttribute('role', 'alert');
    resultSection.append(resultLabel, loading, result, error);
    body.append(sourceSection, resultSection);

    const footer = element('div', 'footer');
    const optionsButton = element('button', 'action', '设置');
    const retryButton = element('button', 'action', '重试');
    const copyButton = element('button', 'action primary', '复制译文');
    for (const button of [optionsButton, retryButton, copyButton]) button.type = 'button';
    footer.append(optionsButton, retryButton, copyButton);
    card.append(header, body, footer);
    shadow.append(card);
    document.documentElement.append(host);

    closeButton.addEventListener('click', () => close(true));
    optionsButton.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      if (state.requestId) {
        send({ type: MESSAGE.options, requestId: state.requestId }).catch(() => {});
      }
    });
    retryButton.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      const requestId = state.requestId;
      if (!requestId || state.status === 'loading') return;
      state.status = 'loading';
      state.translation = '';
      state.error = '';
      state.retryingRequestId = requestId;
      render();
      startWatchdog(requestId);
      send({ type: MESSAGE.retry, requestId }).catch(() => {
        if (state.retryingRequestId === requestId) state.retryingRequestId = null;
        if (state.requestId !== requestId) return;
        clearWatchdog();
        state.status = 'error';
        state.error = '无法重新发起翻译，请稍后重试。';
        render();
      });
    });
    copyButton.addEventListener('click', async (event) => {
      if (!event.isTrusted) return;
      if (state.status !== 'success' || !state.translation) return;
      const requestId = state.requestId;
      try {
        await navigator.clipboard.writeText(state.translation);
        if (state.requestId !== requestId) return;
        copyButton.textContent = '已复制';
      } catch {
        if (state.requestId !== requestId) return;
        copyButton.textContent = '复制失败';
      }
      if (state.copyReset !== null) clearTimeout(state.copyReset);
      state.copyReset = setTimeout(() => {
        if (state.requestId === requestId) copyButton.textContent = '复制译文';
        state.copyReset = null;
      }, 1800);
    });

    state.host = host;
    state.elements = { source, loading, result, error, retryButton, copyButton };
    return true;
  }

  function render() {
    if (!state.elements) return;
    const { source, loading, result, error, retryButton, copyButton } = state.elements;
    source.textContent = state.source;
    loading.hidden = state.status !== 'loading';
    result.hidden = state.status !== 'success';
    error.hidden = state.status !== 'error';
    result.textContent = state.status === 'success' ? state.translation : '';
    error.textContent = state.status === 'error' ? state.error : '';
    retryButton.disabled = state.status === 'loading';
    copyButton.disabled = state.status !== 'success';
    copyButton.textContent = '复制译文';
    schedulePosition();
  }

  function show(message) {
    if (typeof message.requestId !== 'string' || !message.requestId || typeof message.text !== 'string'
        || !Number.isSafeInteger(message.order)) return false;
    if (message.order < state.latestOrder
        || (message.order === state.latestOrder && message.requestId !== state.requestId)) return false;
    if (message.retryOf && (state.requestId !== message.retryOf
        || state.retryingRequestId !== message.retryOf)) return false;
    const oldRequestId = state.requestId;
    if (!ensureUI()) return false;
    if (oldRequestId && oldRequestId !== message.requestId
        && !(state.retryingRequestId === oldRequestId && message.retryOf === oldRequestId)) {
      sendCancel(oldRequestId);
    }
    state.retryingRequestId = null;
    if (state.copyReset !== null) clearTimeout(state.copyReset);
    state.copyReset = null;
    state.requestId = message.requestId;
    state.invalidatedRequestId = null;
    state.latestOrder = message.order;
    state.source = message.text;
    state.translation = '';
    state.error = '';
    state.status = 'loading';
    state.anchor = selectedRect();
    render();
    startWatchdog(message.requestId);
    return true;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === MESSAGE.show) {
      sendResponse({ ok: show(message) });
      return;
    }
    if (message.type === MESSAGE.result) {
      if (message.requestId !== state.requestId) {
        sendResponse({ ok: false });
        return;
      }
      if (state.invalidatedRequestId === message.requestId) {
        sendResponse({ ok: true });
        return;
      }
      clearWatchdog();
      if (typeof message.translation === 'string' && message.translation.trim()) {
        state.status = 'success';
        state.translation = message.translation;
        state.error = '';
      } else {
        state.status = 'error';
        state.translation = '';
        state.error = typeof message.error === 'string' && message.error.trim()
          ? message.error : '翻译失败，请重试。';
      }
      render();
      sendResponse({ ok: true });
      return;
    }
    if (message.type === MESSAGE.invalidate) {
      if (message.requestId !== state.requestId) {
        sendResponse({ ok: false });
        return;
      }
      clearWatchdog();
      state.invalidatedRequestId = message.requestId;
      state.status = 'error';
      state.translation = '';
      state.error = typeof message.error === 'string' && message.error.trim()
        ? message.error : '翻译配置已更新，请重试。';
      render();
      sendResponse({ ok: true });
      return;
    }
    if (message.type === MESSAGE.hide) {
      const matched = message.requestId === state.requestId;
      if (matched) close(false);
      sendResponse({ ok: matched });
    }
  });

  document.addEventListener('pointerdown', (event) => {
    if (!state.requestId || !state.host?.isConnected) return;
    if (!event.composedPath().includes(state.host)) close(true);
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !state.requestId) return;
    close(true);
    event.stopPropagation();
  }, true);
  window.addEventListener('blur', () => {
    if (state.requestId) close(true);
  });
  window.addEventListener('resize', schedulePosition);
  window.addEventListener('scroll', schedulePosition, true);
})();
