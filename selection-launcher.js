(() => {
  if (globalThis.__transmateSelectionLauncher) return;
  globalThis.__transmateSelectionLauncher = true;

  const STATUS = 'TRANSMATE_SELECTION_LAUNCHER_STATUS';
  const STATE = 'TRANSMATE_SELECTION_LAUNCHER_STATE';
  const START = 'TRANSMATE_SELECTION_LAUNCHER_START';
  const BUTTON_SIZE = 30;
  const GAP = 6;
  const EXCLUDED = [
    'input', 'textarea', 'select', '#transmate-inline-host', '#transmate-selection-launcher',
    '#transmate-page-status', '#transmate-video-captions',
  ].join(', ');

  let enabled = false;
  let maxTextLength = 0;
  let statusRevision = 0;
  let pointerId = null;
  let frame = 0;
  let selection = null;
  let host = null;

  async function send(message) {
    return chrome.runtime.sendMessage(message);
  }

  function dismiss() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    selection = null;
    host?.remove();
  }

  function allowedNode(node) {
    const element = node instanceof Element ? node : node?.parentElement;
    return element && !element.isContentEditable && !element.closest(EXCLUDED);
  }

  function currentSelection() {
    const focused = document.activeElement;
    if (!enabled || document.hidden || !document.hasFocus() || document.designMode === 'on'
        || (focused !== host && !allowedNode(focused)) || globalThis.__transmateInlineTranslation?.host?.isConnected) return null;
    const current = window.getSelection();
    if (!current || current.isCollapsed || current.rangeCount !== 1) return null;
    const range = current.getRangeAt(0);
    if (!allowedNode(range.startContainer) || !allowedNode(range.endContainer)) return null;
    return { current, range };
  }

  function matchingRange() {
    const next = currentSelection();
    if (!next || !selection) return null;
    const { range } = next;
    return range.startContainer === selection.start && range.startOffset === selection.startOffset
      && range.endContainer === selection.end && range.endOffset === selection.endOffset ? next : null;
  }

  function selectedText(current) {
    return current.toString().trim().slice(0, maxTextLength + 1);
  }

  function createHost() {
    const launcher = document.createElement('div');
    launcher.id = 'transmate-selection-launcher';
    const root = launcher.attachShadow({ mode: 'open' });
    const styles = document.createElement('style');
    styles.textContent = `
      :host {
        all: initial !important;
        position: fixed !important;
        display: block !important;
        left: var(--transmate-launcher-x) !important;
        top: var(--transmate-launcher-y) !important;
        z-index: 2147483647 !important;
      }
      button {
        appearance: none;
        position: relative;
        display: block;
        width: ${BUTTON_SIZE}px;
        height: ${BUTTON_SIZE}px;
        box-sizing: border-box;
        padding: 0;
        border: 1px solid #41483b;
        border-radius: 8px;
        background: #23271f;
        box-shadow: 0 2px 8px rgb(29 34 26 / .26);
        cursor: pointer;
      }
      button:hover { background: #343b30; }
      button:focus-visible { outline: 2px solid #bd5a34; outline-offset: 2px; }
      button::before, button::after {
        position: absolute;
        left: 50%;
        translate: -50% 0;
        border-radius: 2px;
        content: '';
      }
      button::before { top: 7px; width: 16px; height: 3px; background: #ed794d; }
      button::after { top: 10px; width: 3px; height: 11px; background: #fffdf9; }
      @media (prefers-color-scheme: dark) {
        button { border-color: #727969; box-shadow: 0 2px 9px rgb(0 0 0 / .55); }
        button:focus-visible { outline-color: #ed946e; }
      }
      @media (forced-colors: active) {
        button { background: ButtonFace; border-color: ButtonText; }
        button::before, button::after { background: ButtonText; forced-color-adjust: none; }
        button:focus-visible { outline-color: Highlight; }
      }
    `;
    const button = document.createElement('button');
    button.type = 'button';
    const label = chrome.i18n.getMessage('selectionLauncherButton') || '用 TransMate 翻译';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.addEventListener('pointerdown', (event) => {
      if (event.button === 0) event.preventDefault();
    });
    button.addEventListener('click', (event) => {
      if (!event.isTrusted || !launcher.isConnected) return;
      const next = matchingRange();
      const text = next ? selectedText(next.current) : '';
      const stillSelected = text && text === selection?.text;
      dismiss();
      if (stillSelected) void send({ type: START, text }).catch(() => {});
    });
    root.append(styles, button);
    return launcher;
  }

  function place() {
    const next = matchingRange();
    if (!next) {
      dismiss();
      return;
    }
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + GAP;
    const top = (viewport?.offsetTop ?? 0) + GAP;
    const right = left + (viewport?.width ?? window.innerWidth) - 2 * GAP;
    const bottom = top + (viewport?.height ?? window.innerHeight) - 2 * GAP;

    const rects = Array.from(next.range.getClientRects()).filter((rect) =>
      rect.width > 0 && rect.height > 0 && rect.right > left && rect.left < right
      && rect.bottom > top && rect.top < bottom);
    const anchor = selection.backward ? rects[0] : rects.at(-1);
    if (!anchor || right - left < BUTTON_SIZE || bottom - top < BUTTON_SIZE) {
      host?.remove();
      return;
    }
    const beside = selection.backward ? anchor.left - BUTTON_SIZE - GAP : anchor.right + GAP;
    const fitBeside = beside >= left && beside + BUTTON_SIZE <= right;
    const x = fitBeside ? beside : (selection.backward ? anchor.left : anchor.right - BUTTON_SIZE);
    const below = anchor.bottom + GAP;
    const y = fitBeside ? anchor.top + (anchor.height - BUTTON_SIZE) / 2
      : (below + BUTTON_SIZE <= bottom ? below : anchor.top - BUTTON_SIZE - GAP);

    host ??= createHost();
    host.style.setProperty('--transmate-launcher-x', `${Math.max(left, Math.min(x, right - BUTTON_SIZE))}px`);
    host.style.setProperty('--transmate-launcher-y', `${Math.max(top, Math.min(y, bottom - BUTTON_SIZE))}px`);
    if (!host.isConnected) document.documentElement.append(host);
  }

  function schedule(callback) {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      callback();
    });
  }

  function capture() {
    const next = currentSelection();
    const text = next ? selectedText(next.current) : '';
    if (!text) {
      dismiss();
      return;
    }
    const { current, range } = next;
    selection = {
      text,
      start: range.startContainer,
      startOffset: range.startOffset,
      end: range.endContainer,
      endOffset: range.endOffset,
      backward: current.focusNode === range.startContainer && current.focusOffset === range.startOffset,
    };
    place();
  }

  function reposition() {
    if (selection && !frame) schedule(place);
  }

  function clearInteraction() {
    pointerId = null;
    dismiss();
  }

  function refreshStatus() {
    const revision = ++statusRevision;
    void send({ type: STATUS }).then((status) => {
      if (revision !== statusRevision) return;
      maxTextLength = Number.isSafeInteger(status?.maxTextLength) ? status.maxTextLength : 0;
      enabled = status?.enabled === true && maxTextLength > 0;
      if (!enabled) clearInteraction();
    }).catch(() => {
      if (revision !== statusRevision) return;
      enabled = false;
      clearInteraction();
    });
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'TRANSMATE_INLINE_SHOW') {
      clearInteraction();
    } else if (message?.type === STATE) {
      if (message.enabled) {
        refreshStatus();
      } else {
        statusRevision += 1;
        enabled = false;
        clearInteraction();
      }
    }
  });

  document.addEventListener('pointerdown', (event) => {
    if (!enabled || !event.isTrusted || event.composedPath().includes(host)) return;
    clearInteraction();
    if (event.isPrimary && event.button === 0 && allowedNode(event.target)) pointerId = event.pointerId;
  }, true);
  document.addEventListener('pointerup', (event) => {
    if (!event.isTrusted || pointerId !== event.pointerId) return;
    pointerId = null;
    schedule(capture);
  }, true);
  document.addEventListener('pointercancel', (event) => {
    if (pointerId === event.pointerId) clearInteraction();
  }, true);
  document.addEventListener('selectionchange', () => {
    if (selection && !matchingRange()) dismiss();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') clearInteraction();
  }, true);
  document.addEventListener('keyup', (event) => {
    if (!enabled || !event.isTrusted) return;
    const extending = event.shiftKey && /^(Arrow\w+|Home|End|PageUp|PageDown)$/.test(event.key);
    const selectAll = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a';
    if (extending || selectAll) schedule(capture);
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearInteraction();
  });
  window.addEventListener('blur', clearInteraction);
  window.addEventListener('pagehide', clearInteraction);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) refreshStatus();
  });
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
  window.visualViewport?.addEventListener('scroll', reposition);
  window.visualViewport?.addEventListener('resize', reposition);
  refreshStatus();
})();
