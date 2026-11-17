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
  const VIEWPORT_MARGIN = 12;
  const ANCHOR_GAP = 8;
  const state = {
    requestId: null,
    invalidatedRequestId: null,
    latestOrder: 0,
    retryingRequestId: null,
    notice: false,
    source: '',
    sourceExpanded: false,
    translation: '',
    targetLanguage: '',
    error: '',
    status: 'loading',
    anchor: null,
    previousFocus: null,
    host: null,
    elements: null,
    positionFrame: null,
    watchdog: null,
    copyReset: null,
  };
  globalThis[SINGLETON_KEY] = state;

  const styles = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .sr-only {
      position: absolute;
      clip-path: inset(50%);
      inline-size: 1px;
      block-size: 1px;
      margin: -1px;
      overflow: hidden;
      white-space: nowrap;
    }

    .card {
      --paper: #fffdf9;
      --inset: #f3efe7;
      --line: #e7e0d4;
      --ink: #1e211d;
      --muted-ink: #5f6559;
      --accent: #9d3f1d;
      --accent-hover: #823015;
      --on-accent: #fffdf9;
      --error-ink: #8f3520;
      --shadow: 0 10px 28px rgba(60, 52, 38, .14), 0 2px 5px rgba(60, 52, 38, .08);
      color-scheme: light;
      display: flex;
      flex-direction: column;
      max-block-size: min(400px, var(--available-height, calc(100dvh - 24px)));
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 13px;
      background: var(--paper);
      box-shadow: var(--shadow);
      color: var(--ink);
      font: 13px/1.5 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    @media (prefers-color-scheme: dark) {
      .card {
        --paper: #1f221d;
        --inset: #191c18;
        --line: #383d34;
        --ink: #eceee6;
        --muted-ink: #b0b5a9;
        --accent: #e58b5b;
        --accent-hover: #f0a072;
        --on-accent: #1a1c18;
        --error-ink: #eda58c;
        --shadow: 0 10px 30px rgba(0, 0, 0, .38), 0 2px 6px rgba(0, 0, 0, .24);
        color-scheme: dark;
      }
    }

    button {
      appearance: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-block-size: 32px;
      border: 1px solid transparent;
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    button svg { inline-size: 15px; block-size: 15px; flex: none; }

    .card:focus { outline: none; }
    .card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button:focus-visible, .body:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    button:disabled { cursor: default; }

    .header {
      display: flex;
      flex: none;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 5px 7px 0 14px;
    }
    .eyebrow {
      margin: 0;
      min-inline-size: 0;
      overflow-wrap: anywhere;
      color: var(--accent);
      font-size: 12px;
      font-weight: 650;
    }
    .close {
      flex: none;
      inline-size: 32px;
      padding: 0;
      border-radius: 7px;
      color: var(--muted-ink);
    }
    .close:hover { background: var(--inset); color: var(--ink); }

    .body {
      min-block-size: 0;
      overflow: auto;
      overscroll-behavior: contain;
      padding: 1px 14px 8px;
    }
    .result, .error, .source {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .result { font-size: 17px; font-weight: 550; line-height: 1.58; }
    .error { color: var(--error-ink); font-size: 13px; line-height: 1.6; }
    .card[data-notice="true"] .error { color: var(--ink); }
    .loading {
      display: flex;
      align-items: center;
      gap: 8px;
      min-block-size: 27px;
      color: var(--muted-ink);
    }
    .spinner {
      inline-size: 13px;
      block-size: 13px;
      flex: none;
      border: 2px solid var(--line);
      border-block-start-color: var(--accent);
      border-radius: 50%;
      animation: spin .8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(1turn); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }

    .source-section {
      margin-block-start: 8px;
      padding: 6px 9px;
      border-radius: 7px;
      background: var(--inset);
      color: var(--muted-ink);
    }
    .source { font-size: 12px; line-height: 1.55; }
    .source-section[data-collapsed="true"] .source {
      display: -webkit-box;
      overflow: hidden;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }
    .source-toggle {
      min-block-size: 32px;
      margin-block-start: 1px;
      padding: 0 5px;
      border-radius: 5px;
      color: var(--accent);
      font-size: 12px;
      font-weight: 600;
    }
    .source-toggle:hover { text-decoration: underline; }

    .footer {
      display: flex;
      flex: none;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      padding: 7px 13px 9px;
      border-block-start: 1px solid var(--line);
    }
    .action {
      padding: 0 8px;
      border-radius: 7px;
      color: var(--muted-ink);
      font-size: 12px;
      font-weight: 600;
    }
    .action:not(:disabled):hover { background: var(--inset); color: var(--ink); }
    .action.primary {
      padding-inline: 9px;
      background: var(--accent);
      color: var(--on-accent);
    }
    .action.primary:not(:disabled):hover { background: var(--accent-hover); color: var(--on-accent); }
    .action.primary:focus-visible { outline-color: var(--on-accent); }

    @media (forced-colors: active) {
      .card, .footer, .source-section, button { border-color: CanvasText; }
      .source-section { border: 1px solid; }
      .eyebrow, .source-toggle { color: LinkText; }
      .action.primary { background: Highlight; color: HighlightText; }
      .card:focus-visible, button:focus-visible, .body:focus-visible { outline-color: Highlight; }
      .action.primary:focus-visible { outline-color: HighlightText; }
      .spinner { border-color: Canvas; border-block-start-color: CanvasText; }
    }
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

  function focusedElement() {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  }

  function captureAnchor(text, active) {
    if (!text) return null;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (Number.isInteger(start) && Number.isInteger(end) && start !== end
          && active.value.slice(start, end).trim() === text) {
        return { element: active };
      }
    }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount
        && selection.toString().trim().replace(/\s+/g, ' ') === text.replace(/\s+/g, ' ')) {
      const range = selection.getRangeAt(0).cloneRange();
      return { range, start: range.startContainer, end: range.endContainer };
    }
    return null;
  }

  function anchorRect(anchor) {
    if (anchor?.element?.isConnected) {
      const rect = anchor.element.getBoundingClientRect();
      if (rect.width && rect.height) return rect;
    }
    if (anchor?.start?.isConnected && anchor.end.isConnected && !anchor.range.collapsed) {
      const rects = anchor.range.getClientRects();
      for (let index = rects.length - 1; index >= 0; index -= 1) {
        if (rects[index].width && rects[index].height) return rects[index];
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
    const { host, elements } = state;
    const { body, source, sourceToggle } = elements;
    const viewport = window.visualViewport;
    const viewportX = viewport?.offsetLeft ?? 0;
    const viewportY = viewport?.offsetTop ?? 0;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const leftEdge = viewportX + VIEWPORT_MARGIN;
    const rightEdge = viewportX + viewportWidth - VIEWPORT_MARGIN;
    const topEdge = viewportY + VIEWPORT_MARGIN;
    const bottomEdge = viewportY + viewportHeight - VIEWPORT_MARGIN;
    const anchor = anchorRect(state.anchor);
    const below = anchor ? clamp(anchor.bottom + ANCHOR_GAP, topEdge, bottomEdge) : topEdge;
    const above = anchor ? clamp(anchor.top - ANCHOR_GAP, topEdge, bottomEdge) : topEdge;
    const roomBelow = bottomEdge - below;
    const roomAbove = above - topEdge;
    // If both sides are very tight, keep the controls and some content on screen.
    const availableHeight = Math.max(roomAbove, roomBelow);
    host.style.width = `${Math.min(340, Math.max(0, rightEdge - leftEdge))}px`;
    host.style.setProperty('--available-height', `${Math.floor(
      availableHeight >= 125 ? availableHeight : Math.max(0, bottomEdge - topEdge),
    )}px`);
    sourceToggle.hidden = state.notice || (!state.sourceExpanded && source.scrollHeight <= source.clientHeight + 1);
    const { width, height } = host.getBoundingClientRect();
    const left = clamp(anchor?.left ?? rightEdge - width, leftEdge, Math.max(leftEdge, rightEdge - width));
    const preferredTop = height <= roomBelow || roomBelow >= roomAbove ? below : above - height;
    const top = clamp(preferredTop, topEdge, Math.max(topEdge, bottomEdge - height));
    state.host.style.left = `${Math.round(left)}px`;
    state.host.style.top = `${Math.round(top)}px`;
    body.tabIndex = body.scrollHeight > body.clientHeight + 1 ? 0 : -1;
  }

  function schedulePosition() {
    if (!state.requestId || state.positionFrame !== null) return;
    state.positionFrame = requestAnimationFrame(position);
  }

  function close(cancel, { restoreFocus = true } = {}) {
    const requestId = state.requestId;
    if (!requestId) return;
    const focusReturn = restoreFocus && document.activeElement === state.host ? state.previousFocus : null;
    state.requestId = null;
    state.invalidatedRequestId = null;
    state.retryingRequestId = null;
    state.translation = '';
    state.error = '';
    state.anchor = null;
    state.previousFocus = null;
    clearWatchdog();
    if (state.copyReset !== null) clearTimeout(state.copyReset);
    state.copyReset = null;
    if (state.positionFrame !== null) cancelAnimationFrame(state.positionFrame);
    state.positionFrame = null;
    state.host?.remove();
    if (focusReturn?.isConnected) focusReturn.focus({ preventScroll: true });
    if (cancel) sendCancel(requestId);
  }

  function icon(pathData) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', pathData);
    svg.append(path);
    return svg;
  }

  function ensureUI() {
    if (state.host) {
      if (!state.host.isConnected) document.documentElement?.append(state.host);
      return Boolean(state.host.isConnected);
    }
    if (!document.documentElement) return false;

    const host = document.createElement('div');
    host.id = 'transmate-inline-host';
    host.lang = 'zh-CN';
    host.dir = 'ltr';
    host.style.setProperty('all', 'initial');
    host.style.setProperty('position', 'fixed');
    host.style.setProperty('left', '12px');
    host.style.setProperty('top', '12px');
    host.style.setProperty('width', 'min(340px, calc(100vw - 24px))');
    host.style.setProperty('z-index', '2147483647');
    host.style.setProperty('pointer-events', 'auto');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = styles;
    shadow.append(style);

    const card = element('section', 'card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'TransMate 划词翻译');
    card.tabIndex = -1;
    const header = element('div', 'header');
    const heading = element('p', 'eyebrow', '划词翻译');
    const closeButton = element('button', 'close');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', '关闭翻译');
    closeButton.append(icon('M6 6l12 12M18 6L6 18'));
    header.append(heading, closeButton);

    const body = element('div', 'body');
    body.setAttribute('role', 'region');
    body.setAttribute('aria-label', '翻译内容');
    const sourceSection = element('div', 'source-section');
    sourceSection.setAttribute('role', 'group');
    sourceSection.setAttribute('aria-label', '原文');
    const source = element('p', 'source');
    source.id = 'transmate-inline-source';
    source.dir = 'auto';
    const sourceToggle = element('button', 'source-toggle', '展开原文');
    sourceToggle.type = 'button';
    sourceToggle.hidden = true;
    sourceToggle.setAttribute('aria-controls', source.id);
    sourceSection.append(source, sourceToggle);
    const loading = element('div', 'loading');
    const spinner = element('span', 'spinner');
    spinner.setAttribute('aria-hidden', 'true');
    loading.append(spinner, element('span', '', '正在翻译…'));
    const result = element('p', 'result');
    result.dir = 'auto';
    const error = element('p', 'error');
    const announcement = element('p', 'sr-only');
    announcement.setAttribute('role', 'status');
    body.append(loading, result, error, sourceSection);

    const footer = element('div', 'footer');
    const optionsButton = element('button', 'action', '去设置');
    const retryButton = element('button', 'action', '重试');
    const stopButton = element('button', 'action', '停止翻译');
    const copyButton = element('button', 'action primary');
    const copyLabel = element('span', '', '复制译文');
    copyButton.append(icon('M9 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2ZM16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1'), copyLabel);
    for (const button of [optionsButton, retryButton, stopButton, copyButton]) button.type = 'button';
    footer.append(copyButton, retryButton, optionsButton, stopButton);
    card.append(header, body, footer, announcement);
    shadow.append(card);
    document.documentElement.append(host);

    closeButton.addEventListener('click', () => close(true));
    stopButton.addEventListener('click', () => close(true));
    sourceToggle.addEventListener('click', () => {
      state.sourceExpanded = !state.sourceExpanded;
      updateSourcePreview();
      schedulePosition();
    });
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
        if (state.requestId !== requestId || state.status !== 'success') return;
        copyLabel.textContent = '已复制';
      } catch {
        if (state.requestId !== requestId || state.status !== 'success') return;
        copyLabel.textContent = '复制失败';
      }
      announcement.textContent = copyLabel.textContent;
      if (state.copyReset !== null) clearTimeout(state.copyReset);
      state.copyReset = setTimeout(() => {
        if (state.requestId === requestId) copyLabel.textContent = '复制译文';
        state.copyReset = null;
      }, 1800);
    });

    state.host = host;
    state.elements = {
      card, heading, body, sourceSection, source, sourceToggle, loading, result, error, announcement,
      footer, retryButton, optionsButton, stopButton, copyButton, copyLabel,
    };
    new ResizeObserver(schedulePosition).observe(body);
    return true;
  }

  function updateSourcePreview() {
    const { sourceSection, sourceToggle } = state.elements;
    sourceSection.dataset.collapsed = String(!state.sourceExpanded);
    sourceToggle.textContent = state.sourceExpanded ? '收起原文' : '展开原文';
    sourceToggle.setAttribute('aria-expanded', String(state.sourceExpanded));
  }

  function render() {
    if (!state.elements) return;
    const {
      card, heading, sourceSection, source, loading, result, error, announcement, footer,
      retryButton, optionsButton, stopButton, copyButton, copyLabel,
    } = state.elements;
    const focused = state.host.shadowRoot.activeElement;
    const succeeded = state.status === 'success';
    const failed = state.status === 'error';
    const pending = state.status === 'loading';
    const needsSettings = failed && /API Key|授权|域名权限|接口地址|翻译设置|目标语言/.test(state.error);
    if (source.textContent !== state.source) source.textContent = state.source;
    updateSourcePreview();
    sourceSection.hidden = state.notice;
    heading.textContent = succeeded && state.targetLanguage ? `译为${state.targetLanguage}` : '划词翻译';
    card.dataset.notice = String(state.notice);
    loading.hidden = !pending || state.notice;
    result.hidden = !succeeded;
    error.hidden = !failed;
    result.textContent = succeeded ? state.translation : '';
    error.textContent = failed ? state.error : '';
    footer.hidden = state.notice;
    retryButton.hidden = !succeeded && !failed;
    retryButton.textContent = succeeded ? '重新翻译' : '重试';
    optionsButton.hidden = !failed;
    optionsButton.classList.toggle('primary', needsSettings);
    retryButton.classList.toggle('primary', failed && !needsSettings);
    copyButton.hidden = !succeeded;
    copyLabel.textContent = '复制译文';
    stopButton.hidden = !pending;
    if (focused?.closest('[hidden]')) card.focus({ preventScroll: true });
    announcement.textContent = succeeded ? '翻译完成。' : failed ? state.error : state.notice ? '' : '正在翻译。';
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
    const active = oldRequestId && document.activeElement === state.host
      ? state.previousFocus : focusedElement();
    if (!ensureUI()) return false;
    if (oldRequestId && oldRequestId !== message.requestId && !message.retryOf) {
      sendCancel(oldRequestId);
    }
    state.retryingRequestId = null;
    if (state.copyReset !== null) clearTimeout(state.copyReset);
    state.copyReset = null;
    state.requestId = message.requestId;
    state.invalidatedRequestId = null;
    state.latestOrder = message.order;
    state.notice = message.notice === true;
    state.source = message.text;
    state.translation = '';
    state.targetLanguage = '';
    state.error = '';
    state.status = 'loading';
    if (!message.retryOf) {
      state.anchor = captureAnchor(message.text, active);
      state.sourceExpanded = false;
      state.previousFocus = active;
      state.elements.body.scrollTop = 0;
    }
    render();
    if (message.keyboard === true) state.elements.card.focus({ preventScroll: true });
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
        state.targetLanguage = typeof message.targetLanguage === 'string' ? message.targetLanguage : '';
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
    if (!event.composedPath().includes(state.host)) close(true, { restoreFocus: false });
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !state.requestId) return;
    close(true);
    event.stopPropagation();
  }, true);
  window.addEventListener('blur', () => {
    if (state.requestId) close(true, { restoreFocus: false });
  });
  window.addEventListener('resize', schedulePosition);
  window.addEventListener('scroll', schedulePosition, true);
  window.visualViewport?.addEventListener('resize', schedulePosition);
  window.visualViewport?.addEventListener('scroll', schedulePosition);
})();
