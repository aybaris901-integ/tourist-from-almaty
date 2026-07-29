import { CUTSCENES, SEEN_STORAGE_KEY, DEBUG } from './cutscenes.js';

const SKIP_DELAY = 0.5; // seconds of real (non-backgrounded) time before any input can skip
const DEFAULT_ASPECT = 16 / 9; // used until a clip's real metadata loads
const HARD_TIMEOUT_MARGIN = 4; // seconds past a clip's declared duration before force-finishing a stalled video that never fires 'ended'/'error'

const byId = (id) => CUTSCENES.find((c) => c.id === id);

function loadSeen() {
  try {
    const raw = localStorage.getItem(SEEN_STORAGE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function markSeen(id) {
  try {
    const seen = loadSeen();
    seen.add(id);
    localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify([...seen]));
  } catch {
    // localStorage unavailable (private mode, quota, etc.) — play-once
    // across reloads just won't persist; never let this break playback.
  }
}

// Fullscreen letterboxed cutscene playback: one <video> at a time (built
// fresh or handed off from preload()), a poster-image fallback, and a JSON
// subtitle track. This class owns only the overlay/media/subtitles — main.js
// owns pausing the game loop/input/HUD around playCutscene(). playCutscene()
// NEVER rejects: a missing manifest id, missing file, decode failure, or a
// stalled video that never fires 'ended' all resolve the same promise rather
// than risk soft-locking the game.
export class CutscenePlayer {
  constructor(overlayEl, frameEl, subtitleEl) {
    this.overlay = overlayEl;
    this.frame = frameEl;
    this.subtitleEl = subtitleEl;

    this._aspect = DEFAULT_ASPECT;
    this._preloaded = new Map(); // id -> HTMLVideoElement, buffered ahead of trigger time, not yet in the DOM
    this._subs = new Map(); // id -> Promise<Array<{t,d,text}>>, cached
    this._sessionSeen = new Set(); // ids already fired THIS page load — never replay within one playthrough
    this._active = null; // the in-flight clip's state, or null between clips

    document.addEventListener('visibilitychange', () => this._onVisibilityChange());
  }

  // Call from main.js's existing resize() alongside ui.resize()/cockpit.resize().
  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    let fw = w;
    let fh = fw / this._aspect;
    if (fh > h) {
      fh = h;
      fw = fh * this._aspect;
    }
    this.frame.style.width = `${Math.round(fw)}px`;
    this.frame.style.height = `${Math.round(fh)}px`;
  }

  // Has the intro sequence ever completed (any prior playthrough, any
  // reload)? main.js uses this so a reload goes straight to flying instead
  // of replaying the three intro clips.
  hasSeenIntro() {
    return loadSeen().has('cockpit_reveal');
  }

  // Kick off buffering for `id` without displaying anything — call this
  // during the preceding gameplay leg (same ahead-of-time pattern as
  // audio.js's preloadMusicCountry) so playCutscene() has zero load gap.
  preload(id) {
    if (this._preloaded.has(id)) return;
    const entry = byId(id);
    if (!entry) return;
    const video = this._buildVideoElement(entry);
    video.load();
    this._preloaded.set(id, video);
    this._loadSubs(id);
  }

  _loadSubs(id) {
    if (this._subs.has(id)) return this._subs.get(id);
    const entry = byId(id);
    const promise = fetch(entry.subs)
      .then((res) => (res.ok ? res.json() : []))
      .catch(() => [])
      .then((track) => (Array.isArray(track) ? track : []));
    this._subs.set(id, promise);
    return promise;
  }

  _buildVideoElement(entry) {
    const video = document.createElement('video');
    video.className = 'cutscene-media';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    // webm first (smaller, optional) — browsers fall through to the next
    // <source> on a load error, so a missing .webm sibling just costs one
    // failed request and silently resolves to the .mp4.
    const webmSource = document.createElement('source');
    webmSource.src = entry.webm;
    webmSource.type = 'video/webm';
    const mp4Source = document.createElement('source');
    mp4Source.src = entry.video;
    mp4Source.type = 'video/mp4';
    video.appendChild(webmSource);
    video.appendChild(mp4Source);
    return video;
  }

  // Debug-only: bypasses the play-once guard entirely, for a console/debug-menu replay.
  replayCutscene(id) {
    if (!byId(id)) {
      console.warn(`[cutscene] unknown id "${id}"`);
      return Promise.resolve();
    }
    this._sessionSeen.delete(id);
    return this.playCutscene(id);
  }

  playCutscene(id) {
    return new Promise((resolve) => {
      const entry = byId(id);
      if (!entry) {
        console.warn(`[cutscene] unknown id "${id}" — skipping`);
        resolve();
        return;
      }
      if (this._active) this._finish(this._active); // defensive: never overlap two clips
      if (DEBUG.skipAll || this._sessionSeen.has(id)) {
        resolve();
        return;
      }
      this._sessionSeen.add(id);
      markSeen(id);

      const ctx = {
        id,
        entry,
        mode: 'video',
        video: null,
        posterImg: null,
        subs: [],
        wallElapsed: 0,
        lastTick: null,
        skipEnabled: false,
        finished: false,
        wasPlaying: false,
        rafId: null,
        resolve,
      };
      this._active = ctx;
      this.subtitleEl.textContent = '';
      this.overlay.classList.remove('hidden');

      this._loadSubs(id).then((subs) => {
        if (this._active === ctx) ctx.subs = subs;
      });

      ctx.onKeyDown = (e) => {
        if (e.code === 'Escape') return; // Escape exits pointer lock — must never double as skip
        if (ctx.skipEnabled) this._finish(ctx);
      };
      ctx.onPointerDown = () => {
        if (ctx.skipEnabled) this._finish(ctx);
      };
      window.addEventListener('keydown', ctx.onKeyDown);
      this.overlay.addEventListener('pointerdown', ctx.onPointerDown);

      const preloaded = this._preloaded.get(id);
      this._preloaded.delete(id);
      const video = preloaded || this._buildVideoElement(entry);
      this._attachVideo(ctx, video);

      ctx.rafId = requestAnimationFrame((t) => this._tick(ctx, t));
    });
  }

  _attachVideo(ctx, video) {
    video.classList.add('active');
    video.currentTime = 0;
    this.frame.insertBefore(video, this.subtitleEl);
    ctx.video = video;
    ctx.mode = 'video';

    ctx.onError = () => this._fallbackToPoster(ctx);
    ctx.onEnded = () => this._finish(ctx);
    ctx.onLoadedMeta = () => {
      this._aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : DEFAULT_ASPECT;
      this.resize();
    };
    video.addEventListener('error', ctx.onError);
    video.addEventListener('ended', ctx.onEnded, { once: true });
    video.addEventListener('loadedmetadata', ctx.onLoadedMeta, { once: true });

    const playResult = video.play();
    if (playResult && playResult.catch) playResult.catch(() => this._fallbackToPoster(ctx));
  }

  _fallbackToPoster(ctx) {
    if (ctx.finished || ctx.mode === 'poster') return;
    console.warn(`[cutscene] "${ctx.id}" video failed to load/play (${ctx.entry.video}) — falling back to poster`);

    if (ctx.video) {
      if (ctx.onError) ctx.video.removeEventListener('error', ctx.onError);
      if (ctx.onEnded) ctx.video.removeEventListener('ended', ctx.onEnded);
      if (ctx.onLoadedMeta) ctx.video.removeEventListener('loadedmetadata', ctx.onLoadedMeta);
      ctx.video.pause();
      if (ctx.video.parentNode) ctx.video.parentNode.removeChild(ctx.video);
      ctx.video = null;
    }

    ctx.mode = 'poster';
    ctx.wallElapsed = 0; // show the fallback for the clip's full nominal duration, not whatever time the failed video attempt already burned

    const img = document.createElement('img');
    img.className = 'cutscene-media active';
    img.alt = '';
    img.onerror = () => console.warn(`[cutscene] "${ctx.id}" poster also failed to load (${ctx.entry.poster})`);
    img.src = ctx.entry.poster;
    this.frame.insertBefore(img, this.subtitleEl);
    ctx.posterImg = img;
  }

  _tick(ctx, now) {
    if (ctx.finished) return;
    const dt = ctx.lastTick != null ? Math.max(0, (now - ctx.lastTick) / 1000) : 0;
    ctx.lastTick = now;
    if (!document.hidden) ctx.wallElapsed += dt;

    const clock = ctx.mode === 'video' && ctx.video ? ctx.video.currentTime : ctx.wallElapsed;
    this._updateSubtitle(ctx, clock);
    ctx.skipEnabled = ctx.wallElapsed >= SKIP_DELAY;

    if (ctx.mode === 'poster' && ctx.wallElapsed >= ctx.entry.duration) {
      this._finish(ctx);
      return;
    }
    if (ctx.mode === 'video' && ctx.wallElapsed >= ctx.entry.duration + HARD_TIMEOUT_MARGIN) {
      console.warn(`[cutscene] "${ctx.id}" exceeded its expected duration without firing "ended" — forcing it to finish`);
      this._finish(ctx);
      return;
    }

    ctx.rafId = requestAnimationFrame((t) => this._tick(ctx, t));
  }

  _updateSubtitle(ctx, t) {
    const line = ctx.subs.find((s) => t >= s.t && t < s.t + s.d);
    const text = line ? line.text : '';
    if (this.subtitleEl.textContent !== text) this.subtitleEl.textContent = text;
  }

  _onVisibilityChange() {
    const ctx = this._active;
    if (!ctx || ctx.finished) return;
    if (document.hidden) {
      if (ctx.mode === 'video' && ctx.video && !ctx.video.paused) {
        ctx.wasPlaying = true;
        ctx.video.pause();
      }
    } else {
      ctx.lastTick = performance.now(); // discard the backgrounded gap instead of counting it as one huge dt
      if (ctx.mode === 'video' && ctx.video && ctx.wasPlaying) {
        ctx.wasPlaying = false;
        const p = ctx.video.play();
        if (p && p.catch) p.catch(() => this._fallbackToPoster(ctx));
      }
    }
  }

  _finish(ctx) {
    if (ctx.finished) return;
    ctx.finished = true;
    if (ctx.rafId) cancelAnimationFrame(ctx.rafId);
    window.removeEventListener('keydown', ctx.onKeyDown);
    this.overlay.removeEventListener('pointerdown', ctx.onPointerDown);
    this._detachMedia(ctx);
    if (this._active === ctx) this._active = null;
    this.overlay.classList.add('hidden');
    this.subtitleEl.textContent = '';
    ctx.resolve();
  }

  _detachMedia(ctx) {
    if (ctx.video) {
      if (ctx.onError) ctx.video.removeEventListener('error', ctx.onError);
      if (ctx.onEnded) ctx.video.removeEventListener('ended', ctx.onEnded);
      if (ctx.onLoadedMeta) ctx.video.removeEventListener('loadedmetadata', ctx.onLoadedMeta);
      ctx.video.pause();
      while (ctx.video.firstChild) ctx.video.removeChild(ctx.video.firstChild);
      ctx.video.removeAttribute('src');
      ctx.video.load(); // stop any in-flight buffering now that sources are gone
      if (ctx.video.parentNode) ctx.video.parentNode.removeChild(ctx.video);
      ctx.video = null;
    }
    if (ctx.posterImg) {
      if (ctx.posterImg.parentNode) ctx.posterImg.parentNode.removeChild(ctx.posterImg);
      ctx.posterImg = null;
    }
  }
}
