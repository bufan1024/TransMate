(() => {
  const SINGLETON_KEY = '__transmatePageTranslation';
  if (window !== window.top || globalThis[SINGLETON_KEY]) return;
  globalThis[SINGLETON_KEY] = true;

  const MAX_CHARACTERS = 30_000;
  const MAX_BLOCKS = 300;
  const MAX_BLOCKS_PER_VIEW = 12;
  const SCROLL_DEBOUNCE_MS = 120;
  const MIN_SCROLL_DISTANCE = 4;
  const PREFETCH_VIEWPORT_FRACTION = 0.5;
  const STATUS_ID = 'transmate-page-status';
  const TRANSLATION_ATTRIBUTE = 'data-transmate-page-translation';
  const PAGE_CHANGED = '网页正文已变动，请重新启动翻译。';
  const EXCLUDED = [
    'nav', 'aside', 'footer', 'form', 'button', 'input', 'select', 'textarea', 'datalist', 'option',
    'dialog', 'summary', 'script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas',
    'audio', 'video', 'object', 'embed', '[hidden]', '[inert]', '[aria-hidden="true"]',
    '[role="banner"]', '[role="navigation"]', '[role="complementary"]', '[role="contentinfo"]',
    '[role="button"]', '[role="menu"]', '[role="menubar"]', '[role="menuitem"]', '[role="textbox"]',
    '[role="search"]', '[role="dialog"]', '[role="toolbar"]', '[role="tablist"]', '[role="combobox"]',
    '[role="checkbox"]', '[role="radio"]', '[role="slider"]', '[role="switch"]',
    `#${STATUS_ID}`, '#transmate-inline-host', `[${TRANSLATION_ATTRIBUTE}]`,
  ].join(',');
  const TEXT_BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, dt, dd, td, th, pre, blockquote, figcaption, caption';
  const TRANSLATE_AFTER = 'p, h1, h2, h3, h4, h5, h6, pre, blockquote, a';
  const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);
  const STATUS_LABELS = {
    reading: '取消翻译', translating: '取消翻译', paused: '移除译文', success: '移除译文',
    retryable: '关闭', error: '关闭',
  };

  let session = null;
  let status = null;
  let dismissedRequestId = null;

  function readableStyle(element) {
    if (element.isContentEditable || element.matches(EXCLUDED)) return null;
    if (element.tagName === 'DETAILS' && !element.open) return null;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility !== 'visible' || style.opacity === '0'
        || style.contentVisibility === 'hidden') return null;
    if (style.position === 'absolute' && (style.clip !== 'auto' || style.clipPath === 'inset(50%)')) return null;
    return style;
  }

  function readableLandmark(element) {
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      if (!readableStyle(ancestor)) return false;
    }
    return true;
  }

  function startsBlock(element, style) {
    return element.matches(TEXT_BLOCKS) || (!style.display.startsWith('inline') && style.display !== 'contents');
  }

  function afterAnchor(run, wholeBlock) {
    let anchor = run.container;
    if (!wholeBlock || !anchor.matches(TRANSLATE_AFTER)) {
      anchor = run.lastTextNode;
      while (anchor.parentNode !== run.container) anchor = anchor.parentNode;
    }
    return anchor.parentElement.closest('a[href]') || anchor;
  }

  function extract(root) {
    const blocks = [];
    const anchors = new Map();
    let length = 0;
    let truncated = false;

    function record(run, final = false) {
      const joined = run.parts.join('');
      const text = (run.preformatted ? joined : joined.replace(/ *\n */g, '\n').replace(/ {2,}/g, ' ')).trim();
      run.parts.length = 0;
      if (!text) return;
      const after = afterAnchor(run, final && !run.divided);
      const firstTextNode = run.firstTextNode;
      const lastTextNode = run.lastTextNode;
      run.firstTextNode = null;
      run.lastTextNode = null;
      const remaining = MAX_CHARACTERS - length;
      if (blocks.length >= MAX_BLOCKS || !remaining) {
        truncated = true;
        return;
      }
      const id = blocks.length + 1;
      let included = text;
      if (text.length > remaining) {
        included = text.slice(0, remaining).replace(/[\uD800-\uDBFF]$/, '').trimEnd();
        truncated = true;
      }
      if (!included) return;
      blocks.push({ id, text: included });
      anchors.set(id, { after, parent: after.parentNode, firstTextNode, lastTextNode });
      length += included.length;
    }

    function readChildren(element, run) {
      for (const child of element.childNodes) {
        if (truncated) return;
        if (child.nodeType === Node.TEXT_NODE) {
          const text = run.preformatted ? child.data : child.data.replace(/\s+/g, ' ');
          run.parts.push(text);
          if (text.trim()) {
            run.firstTextNode ||= child;
            run.lastTextNode = child;
          }
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const style = readableStyle(child);
          if (!style) continue;
          if (child.tagName === 'BR') {
            run.parts.push('\n');
          } else if (startsBlock(child, style)) {
            record(run);
            run.divided = true;
            if (!truncated) readContainer(child);
          } else {
            readChildren(child, run);
          }
        }
      }
    }

    function readContainer(container) {
      const run = {
        container, parts: [], firstTextNode: null, lastTextNode: null,
        divided: false, preformatted: container.tagName === 'PRE',
      };
      readChildren(container, run);
      if (!truncated) record(run, true);
    }

    if (root) readContainer(root);
    return { blocks, anchors, truncated };
  }

  function extractPage() {
    const main = Array.from(document.querySelectorAll('main, [role="main"]')).find(readableLandmark);
    let root = main;
    if (!root) {
      const articles = Array.from(document.querySelectorAll('article, [role="article"]'))
        .filter((article) => !article.parentElement.closest('article, [role="article"]') && readableLandmark(article));
      if (articles.length === 1) [root] = articles;
    }
    const body = document.body && readableStyle(document.body) ? document.body : null;
    const result = extract(root || body);
    return root && !result.blocks.length ? extract(body) : result;
  }

  function scrollPosition(element) {
    return { left: element.scrollLeft, top: element.scrollTop };
  }

  function viewportFor(element, view, boundsByElement, positions) {
    if (!element || element === document.body || element === document.documentElement) return view;
    if (boundsByElement.has(element)) return boundsByElement.get(element);
    const outer = viewportFor(element.parentElement, view, boundsByElement, positions);
    const { overflowX, overflowY } = getComputedStyle(element);
    let bounds = outer;
    if (overflowX !== 'visible' || overflowY !== 'visible') {
      const rect = element.getBoundingClientRect();
      const left = rect.left + element.clientLeft;
      const top = rect.top + element.clientTop;
      const prefetch = SCROLLABLE_OVERFLOW.has(overflowY) ? element.clientHeight * PREFETCH_VIEWPORT_FRACTION : 0;
      bounds = {
        left: overflowX === 'visible' ? outer.left : Math.max(outer.left, left),
        right: overflowX === 'visible' ? outer.right : Math.min(outer.right, left + element.clientWidth),
        top: overflowY === 'visible' ? outer.top : Math.max(outer.top, top),
        bottom: overflowY === 'visible' ? outer.bottom : Math.min(outer.bottom, top + element.clientHeight + prefetch),
      };
      positions.set(element, scrollPosition(element));
    }
    boundsByElement.set(element, bounds);
    return bounds;
  }

  function selectSource(range, { firstTextNode, lastTextNode }) {
    range.setStartBefore(firstTextNode);
    range.setEndAfter(lastTextNode);
  }

  function sourceMatches(range, anchor) {
    if (!anchor.firstTextNode.isConnected || !anchor.lastTextNode.isConnected
        || anchor.after.parentNode !== anchor.parent) return false;
    selectSource(range, anchor);
    return range.toString() === anchor.originalText;
  }

  function captureDemand(entry) {
    const view = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight * (1 + PREFETCH_VIEWPORT_FRACTION) };
    const boundsByElement = new Map();
    const positions = new Map();
    const demand = new Set();
    const range = document.createRange();
    if (document.scrollingElement) positions.set(document.scrollingElement, scrollPosition(document.scrollingElement));
    for (const { id } of entry.blocks) {
      if (entry.inserted.has(id)) continue;
      const anchor = entry.anchors.get(id);
      const { firstTextNode, lastTextNode } = anchor;
      if (!firstTextNode.isConnected || !lastTextNode.isConnected) continue;
      const bounds = viewportFor(firstTextNode.parentElement, view, boundsByElement, positions);
      if (bounds.left >= bounds.right || bounds.top >= bounds.bottom) continue;
      selectSource(range, anchor);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.top < bounds.bottom && rect.bottom > bounds.top
          && rect.left < bounds.right && rect.right > bounds.left) demand.add(id);
    }
    entry.scrollPositions = positions;
    const changed = [...demand].some((id) => !entry.demand.has(id));
    entry.demand = demand;
    return changed;
  }

  function sendPageEvent(type, requestId) {
    if (!chrome.runtime?.id) return Promise.resolve();
    return chrome.runtime.sendMessage({ type, requestId }).catch(() => {});
  }

  function observeScroll(entry) {
    if (entry.onScroll) return;
    entry.onScroll = ({ target }) => {
      const scroller = target === document ? document.scrollingElement : target;
      const before = entry.scrollPositions.get(scroller);
      if (!before) return;
      const current = scrollPosition(scroller);
      if (Math.abs(current.top - before.top) < MIN_SCROLL_DISTANCE
          && Math.abs(current.left - before.left) < MIN_SCROLL_DISTANCE) return;
      clearTimeout(entry.scrollTimer);
      entry.scrollTimer = setTimeout(() => {
        if (session === entry && captureDemand(entry)) sendPageEvent('TRANSMATE_PAGE_MORE', entry.requestId);
      }, SCROLL_DEBOUNCE_MS);
    };
    document.addEventListener('scroll', entry.onScroll, { capture: true, passive: true });
  }

  function stopObserving(entry) {
    if (entry.onScroll) document.removeEventListener('scroll', entry.onScroll, true);
    entry.onScroll = null;
    clearTimeout(entry.scrollTimer);
  }

  function clearSession() {
    if (!session) return;
    stopObserving(session);
    for (const node of session.inserted.values()) node.remove();
    session = null;
  }

  function clear(requestId) {
    if (requestId === undefined || session?.requestId === requestId) clearSession();
    if (status && (requestId === undefined || status.requestId === requestId)) {
      status.host.remove();
      status = null;
    }
    return { ok: true };
  }

  function dismiss(requestId) {
    if (!requestId) return;
    dismissedRequestId = requestId;
    clear(requestId);
    sendPageEvent('TRANSMATE_PAGE_CANCEL', requestId);
  }

  function read({ requestId, mode }) {
    if (typeof requestId !== 'string' || !requestId || requestId === dismissedRequestId) {
      return { ok: false, error: '此页面操作已结束。' };
    }
    if (mode !== 'summary') clearSession();
    const { blocks, anchors, truncated } = extractPage();
    if (!blocks.length) return { ok: false, error: '此页面没有可处理的正文。请在有正文的网页上重试。' };
    if (mode === 'summary') return { ok: true, blocks, truncated };
    const range = document.createRange();
    for (const anchor of anchors.values()) {
      selectSource(range, anchor);
      anchor.originalText = range.toString();
    }
    session = {
      requestId, blocks, anchors, truncated, demand: new Set(), lastBatch: new Set(),
      inserted: new Map(), renderedByAnchor: new Map(),
    };
    captureDemand(session);
    observeScroll(session);
    return { ok: true, total: blocks.length, completed: 0, truncated };
  }

  function next({ requestId, retry }) {
    if (!session || session.requestId !== requestId) return { ok: false, error: '此页面翻译已结束。' };
    const { blocks, anchors, demand, lastBatch, inserted, truncated } = session;
    const requestedIds = retry ? lastBatch : demand;
    const requested = blocks.filter(({ id }) => requestedIds.has(id) && !inserted.has(id)).slice(0, MAX_BLOCKS_PER_VIEW);
    const range = document.createRange();
    if (requested.some(({ id }) => !sourceMatches(range, anchors.get(id)))) return { ok: false, error: PAGE_CHANGED };
    if (retry) captureDemand(session);
    session.lastBatch = new Set(requested.map(({ id }) => id));
    return { ok: true, blocks: requested, total: blocks.length, completed: inserted.size, truncated };
  }

  function append({ requestId, translations }) {
    if (!session || session.requestId !== requestId || !Array.isArray(translations)) {
      return { ok: false, error: '此页面翻译已结束。' };
    }
    const pending = new Map();
    const range = document.createRange();
    for (const entry of translations) {
      if (session.inserted.has(entry?.id)) continue;
      const target = session.anchors.get(entry?.id);
      if (!target || typeof entry.text !== 'string' || !entry.text.trim()) {
        return { ok: false, error: '译文与网页段落不匹配，请重新翻译。' };
      }
      if (!sourceMatches(range, target)) return { ok: false, error: PAGE_CHANGED };
      pending.set(entry.id, { target, text: entry.text });
    }

    for (const [id, { target, text }] of pending) {
      const node = document.createElement('span');
      node.setAttribute(TRANSLATION_ATTRIBUTE, String(id));
      node.setAttribute('translate', 'no');
      node.style.cssText = `display: block; color: inherit; margin: .45em 0 .8em;
        border-inline-start: 2px solid #c45632; padding-inline-start: .65em;
        font-size: 1em; font-weight: normal; white-space: pre-wrap; overflow-wrap: anywhere;`;
      node.textContent = text;
      const rendered = session.renderedByAnchor.get(target.after) || [];
      const previous = rendered.findLast((item) => item.id < id && item.node.parentNode === target.parent);
      (previous?.node || target.after).after(node);
      rendered.push({ id, node });
      rendered.sort((first, second) => first.id - second.id);
      session.renderedByAnchor.set(target.after, rendered);
      session.inserted.set(id, node);
    }
    if (pending.size) {
      // Adding a translation can shift the browser's scroll anchor. Refresh the
      // positions after layout without collecting another set of blocks.
      document.documentElement.getBoundingClientRect();
      for (const element of session.scrollPositions.keys()) session.scrollPositions.set(element, scrollPosition(element));
    }
    return { ok: true, completed: session.inserted.size };
  }

  function showStatus({ requestId, status: kind, message }) {
    if (typeof requestId !== 'string' || !requestId || requestId === dismissedRequestId
        || !Object.hasOwn(STATUS_LABELS, kind)) return { ok: false };
    if (status?.requestId !== requestId && kind !== 'reading' && session?.requestId !== requestId) {
      return { ok: false };
    }
    if (session?.requestId === requestId) {
      if (kind === 'success' || kind === 'error' || kind === 'retryable') stopObserving(session);
      else if (kind === 'translating' || kind === 'paused') observeScroll(session);
    }
    if (status?.requestId !== requestId || !status.host.isConnected) {
      status?.host.remove();
      const host = document.createElement('div');
      host.id = STATUS_ID;
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `
        :host { all: initial; position: fixed; z-index: 2147483647; inset: auto 16px 16px auto;
          max-width: min(340px, calc(100vw - 32px)); color-scheme: light; }
        div { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid #e5dfd3;
          border-radius: 10px; background: #fffdf8; color: #20231f; box-shadow: 0 4px 18px #20231f26;
          font: 13px/1.5 system-ui, sans-serif; }
        span { overflow-wrap: anywhere; }
        .actions { display: inline-flex; gap: 6px; flex: none; }
        button { flex: none; border: 1px solid #e5dfd3; border-radius: 6px; background: #fffdf8;
          color: #20231f; padding: 5px 8px; font: inherit; cursor: pointer; }
        button:hover { background: #f5f1e8; }
        button:focus-visible { outline: 2px solid #c45632; outline-offset: 1px; }
      `;
      const card = document.createElement('div');
      const label = document.createElement('span');
      label.setAttribute('role', 'status');
      const button = document.createElement('button');
      button.type = 'button';
      button.addEventListener('click', (event) => {
        if (!event.isTrusted || status?.requestId !== requestId) return;
        dismiss(requestId);
      });
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '重试未完成段落';
      retry.addEventListener('click', (event) => {
        if (!event.isTrusted || status?.requestId !== requestId || status.kind !== 'retryable' || retry.disabled) return;
        retry.disabled = true;
        void sendPageEvent('TRANSMATE_PAGE_RETRY', requestId).finally(() => { retry.disabled = false; });
      });
      const actions = document.createElement('span');
      actions.className = 'actions';
      actions.append(retry, button);
      card.append(label, actions);
      shadow.append(style, card);
      (document.body || document.documentElement).append(host);
      status = { requestId, host, label, button, retry };
    }
    const retryHadFocus = status.host.shadowRoot.activeElement === status.retry;
    status.kind = kind;
    status.label.textContent = typeof message === 'string' ? message : '';
    status.button.textContent = STATUS_LABELS[kind];
    status.retry.hidden = kind !== 'retryable';
    if (retryHadFocus && status.retry.hidden) status.button.focus({ preventScroll: true });
    return { ok: true };
  }

  // The worker can go idle after completion while the document keeps its DOM.
  window.navigation?.addEventListener('currententrychange', ({ from }) => {
    if (from?.url && from.url !== location.href) dismiss(status?.requestId || session?.requestId);
  });
  window.addEventListener('pagehide', () => dismiss(status?.requestId || session?.requestId));

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case 'TRANSMATE_PAGE_READ':
        sendResponse(read(message));
        break;
      case 'TRANSMATE_PAGE_NEXT':
        sendResponse(next(message));
        break;
      case 'TRANSMATE_PAGE_APPEND':
        sendResponse(append(message));
        break;
      case 'TRANSMATE_PAGE_CLEAR':
        sendResponse(clear(message.requestId));
        break;
      case 'TRANSMATE_PAGE_STATUS':
        sendResponse(showStatus(message));
        break;
    }
  });
})();
