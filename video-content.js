(() => {
  if (globalThis.__transmateVideoCaptions) return;
  globalThis.__transmateVideoCaptions = true;

  let active = null;

  function send(session, type, details = {}) {
    return chrome.runtime.sendMessage({ type, requestId: session.requestId, ...details });
  }

  function restoreTrack(session) {
    const { track, previousMode } = session;
    if (!track) return;
    track.removeEventListener('cuechange', session.update);
    if (previousMode === 'disabled' && track.mode === 'hidden') track.mode = previousMode;
    session.track = null;
  }

  function clear(notify = true) {
    if (!active) return;
    const session = active;
    active = null;
    restoreTrack(session);
    session.video?.removeEventListener('emptied', session.close);
    session.host?.remove();
    if (notify) void send(session, 'TRANSMATE_VIDEO_STOP').catch(() => {});
  }

  function readableTracks(video) {
    return [...video.textTracks].filter((track) => track.kind === 'subtitles' || track.kind === 'captions');
  }

  function findVideo(srcUrl) {
    const videos = [...document.querySelectorAll('video')];
    return videos.find((video) => srcUrl && (video.currentSrc === srcUrl || video.src === srcUrl))
      || videos.find((video) => readableTracks(video).length > 0);
  }

  function position() {
    if (!active?.video) return;
    const rect = active.video.getBoundingClientRect();
    const { caption } = active;
    const width = Math.min(innerWidth, rect.right) - Math.max(0, rect.left);
    caption.style.visibility = width < 80 || rect.bottom < 30 || rect.top >= innerHeight ? 'hidden' : '';
    caption.style.left = `${Math.max(0, rect.left) + width / 2}px`;
    caption.style.maxWidth = `${Math.max(80, width - 20)}px`;
    caption.style.top = `${Math.min(rect.bottom, innerHeight) - 28}px`;
  }

  async function update(session) {
    if (active !== session) return;
    const text = [...(session.track?.activeCues || [])].map((cue) =>
      (typeof cue.getCueAsHTML === 'function' ? cue.getCueAsHTML().textContent : cue.text) || '',
    ).join('\n').trim();
    const targetLanguage = session.target.value;
    const cueKey = JSON.stringify([targetLanguage, text]);
    if (cueKey === session.cueKey) return;
    session.cueKey = cueKey;
    const revision = ++session.revision;
    session.caption.hidden = true;
    session.status.textContent = '';
    if (!text) {
      void send(session, 'TRANSMATE_VIDEO_CUE', { text: '' }).catch(() => {});
      return;
    }
    try {
      let translation = session.cache.get(cueKey);
      if (!translation) {
        const response = await send(session, 'TRANSMATE_VIDEO_CUE', { text, targetLanguage });
        if (active !== session || session.revision !== revision) return;
        if (!response?.translation) throw new Error(response?.error || '请重新打开字幕翻译。');
        translation = response.translation;
        if (session.cache.size >= 100) session.cache.delete(session.cache.keys().next().value);
        session.cache.set(cueKey, translation);
      }
      if (active !== session || session.revision !== revision) return;
      session.caption.textContent = translation;
      session.caption.hidden = false;
      position();
    } catch (error) {
      if (active === session && session.revision === revision) session.status.textContent = error.message;
    }
  }

  function chooseTrack(session, track) {
    restoreTrack(session);
    session.track = track;
    session.previousMode = track.mode;
    if (track.mode === 'disabled') track.mode = 'hidden';
    track.addEventListener('cuechange', session.update);
    session.cueKey = null;
    void session.update();
  }

  function mount(message) {
    clear(false);
    const video = findVideo(message.srcUrl);
    const tracks = video ? readableTracks(video) : [];
    const host = document.createElement('div');
    host.id = 'transmate-video-captions';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
        :host { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; color-scheme: light dark; }
        [hidden] { display: none !important; }
        .toolbar { position: fixed; inset: 12px 12px auto auto; max-width: calc(100vw - 24px); box-sizing: border-box;
          padding: 9px 10px; border: 1px solid color-mix(in srgb, CanvasText 24%, Canvas); border-radius: 10px;
          color: CanvasText; background: Canvas; font: 13px/1.5 system-ui, sans-serif; pointer-events: auto; }
        .controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        button, select { font: inherit; min-height: 30px; }
        .status { margin: 5px 0 0; max-width: 300px; word-wrap: break-word; }
        .status:empty { margin: 0; }
        .caption { position: fixed; margin: 0; box-sizing: border-box; transform: translate(-50%, -100%);
          padding: 5px 12px; border-radius: 5px; background: #171918eb; color: #fff;
          font: 600 clamp(15px, 2vw, 22px)/1.45 system-ui, sans-serif; text-align: center;
          white-space: pre-wrap; overflow-wrap: anywhere; }
    `;
    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    const controls = document.createElement('div');
    controls.className = 'controls';
    const heading = document.createElement('strong');
    heading.textContent = '字幕翻译';
    const trackSelect = document.createElement('select');
    trackSelect.className = 'track';
    trackSelect.setAttribute('aria-label', '原字幕');
    const target = document.createElement('select');
    target.className = 'target';
    target.setAttribute('aria-label', '字幕目标语言');
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'stop';
    stop.textContent = '关闭';
    controls.append(heading, trackSelect, target, stop);
    const status = document.createElement('p');
    status.className = 'status';
    status.setAttribute('role', 'status');
    toolbar.append(controls, status);
    const caption = document.createElement('p');
    caption.className = 'caption';
    caption.dir = 'auto';
    caption.hidden = true;
    root.append(style, toolbar, caption);
    const session = {
      requestId: message.requestId, host, video, target, track: null, cache: new Map(),
      status, caption, cueKey: null, revision: 0, close: () => clear(),
    };
    active = session;
    session.update = () => update(session);
    document.documentElement.append(host);
    stop.addEventListener('click', session.close);
    video?.addEventListener('emptied', session.close, { once: true });
    if (tracks.length === 0) {
      trackSelect.hidden = true;
      target.hidden = true;
      session.status.textContent = '当前视频没有可读取的标准字幕轨。';
      return;
    }
    tracks.forEach((track, index) => {
      trackSelect.add(new Option(track.label || track.language || `字幕 ${index + 1}`, String(index)));
    });
    target.add(new Option('默认语言', ''));
    message.languages.forEach(({ id, name }) => target.add(new Option(name, id)));
    const showing = tracks.findIndex((track) => track.mode === 'showing');
    trackSelect.selectedIndex = Math.max(showing, 0);
    trackSelect.addEventListener('change', (event) => {
      if (event.isTrusted && tracks[trackSelect.selectedIndex]) chooseTrack(session, tracks[trackSelect.selectedIndex]);
    });
    target.addEventListener('change', (event) => {
      if (event.isTrusted) void session.update();
    });
    chooseTrack(session, tracks[trackSelect.selectedIndex]);
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'TRANSMATE_VIDEO_START') {
      mount(message);
      respond({ ok: true });
    } else if (message?.type === 'TRANSMATE_VIDEO_HIDE' && active?.requestId === message.requestId) {
      clear(false);
      respond({ ok: true });
    }
  });
  window.addEventListener('scroll', position, true);
  window.addEventListener('resize', position);
  window.addEventListener('pagehide', () => clear());
})();
