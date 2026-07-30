import { CUTSCENES, INTRO_SEQUENCE, SEEN_STORAGE_KEY, DEBUG } from './cutscenes.js';

const SKIP_DELAY = 0.5; // seconds of real (non-backgrounded) time before any input can skip
const DEFAULT_ASPECT = 16 / 9; // used until a clip's real metadata loads
const HARD_TIMEOUT_MARGIN = 4; // seconds PAST WHEN PLAYBACK ACTUALLY STARTED before force-finishing a video that started fine but never fired 'ended'
const STARTUP_GRACE_SECONDS = 3; // seconds to wait for "playing"/"timeupdate" before treating a video as stalled-before-start and falling back — separate from HARD_TIMEOUT_MARGIN, and much shorter, since there's no reason to wait out a whole clip's duration for something that never began

// HTMLMediaElement.error.code / .networkState numeric constants have no
// built-in string form — spelled out here purely so debug logs are readable.
const MEDIA_ERROR_NAMES = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
const NETWORK_STATE_NAMES = { 0: 'NETWORK_EMPTY', 1: 'NETWORK_IDLE', 2: 'NETWORK_LOADING', 3: 'NETWORK_NO_SOURCE' };

const byId = (id) => CUTSCENES.find((c) => c.id === id);

// _finish() reasons that count as "the player actually saw this" — see
// markSeen()'s call site there. Deliberately excludes 'ended-forced-timeout'
// (started, then stuck — nothing shown) and 'superseded'/'unknown' (never
// really ran at all).
const MARK_SEEN_REASONS = new Set([
  'ended-natural',
  'ended-natural-fallback',
  'ended-natural-fallback-subs',
  'skipped-by-user-key',
  'skipped-by-user-click',
]);

function log(id, msg) {
  console.log(`[cutscene:${id}] ${msg}`);
}

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
  constructor(overlayEl, frameEl, subtitleEl, skipLabelEl) {
    this.overlay = overlayEl;
    this.frame = frameEl;
    this.subtitleEl = subtitleEl;
    this.skipLabelEl = skipLabelEl;

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
  // of replaying the three intro clips. Deliberately persistent (not
  // session-only) — a returning player shouldn't have to re-sit through it
  // just because they refreshed. See resetIntroFlag() for the dev/test
  // escape hatch, and note markSeen() fires for tfaDebug.playCutscene()/
  // replayCutscene() too, not just real playthroughs — testing cockpit_reveal
  // standalone marks the whole intro seen forever, same as actually playing it.
  hasSeenIntro() {
    return loadSeen().has('cockpit_reveal');
  }

  // window.tfaDebug.resetIntroFlag() — clears the persisted seen-flag AND
  // the in-session guard for every clip in the intro sequence, so it
  // replays on the very next call with no reload needed (main.js's "Начать
  // сначала" and "Смотреть вступление" both call this before replaying).
  // Does NOT change hasSeenIntro()'s persistence model above for the normal
  // "Продолжить" path — this only forces a specific future play.
  resetIntroFlag() {
    try {
      const seen = loadSeen();
      let changed = false;
      for (const id of INTRO_SEQUENCE) {
        changed = seen.delete(id) || changed;
        this._sessionSeen.delete(id);
      }
      localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify([...seen]));
      console.log(
        changed
          ? '[cutscene] intro seen-flags cleared — next ЛЕТЕТЬ/Начать сначала will replay the intro sequence'
          : '[cutscene] intro seen-flags were already clear'
      );
    } catch (err) {
      console.warn('[cutscene] resetIntroFlag failed:', err);
    }
  }

  // window.tfaDebug.listCutscenes() — audits every registered cutscene
  // (cutscenes.js's CUTSCENES) without touching game state: does the .mp4/
  // .webm file actually exist on disk (HEAD request), and does this browser
  // even claim to support its codec (canPlayType)? A cutscene that "silently
  // fails" in-game is almost always one of these two coming back negative.
  // Logs a console.table and resolves to the same rows.
  async listCutscenes() {
    const probe = document.createElement('video');
    // res.ok alone isn't enough: Vite's dev server (appType 'spa') answers a
    // missing /cutscenes/foo.webm with 200 text/html (index.html's SPA
    // fallback), not a 404 — verified against this repo's dev server, which
    // has no netlify.toml/_redirects to reproduce that in production, but a
    // plain status check here would still misreport a missing file as
    // "exists" while developing locally. Cross-check the content-type
    // actually looks like the requested asset, not the app shell.
    const checkFile = async (url, expectedTypePrefix) => {
      try {
        const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        const contentType = res.headers.get('content-type') || '';
        const looksReal = res.ok && (!expectedTypePrefix || contentType.startsWith(expectedTypePrefix));
        return { exists: looksReal, status: res.status, contentType };
      } catch (err) {
        return { exists: false, status: `fetch failed: ${err.message}`, contentType: '' };
      }
    };

    const rows = await Promise.all(
      CUTSCENES.map(async (entry) => {
        const [mp4, webm, subs] = await Promise.all([
          checkFile(entry.video, 'video/'),
          checkFile(entry.webm, 'video/'),
          checkFile(entry.subs, 'application/json'),
        ]);
        return {
          id: entry.id,
          video: entry.video,
          videoExists: mp4.exists,
          videoStatus: mp4.status,
          videoContentType: mp4.contentType,
          canPlayMp4: probe.canPlayType('video/mp4') || '(unsupported)',
          webmExists: webm.exists,
          canPlayWebm: probe.canPlayType('video/webm') || '(unsupported)',
          subsExists: subs.exists,
          seenThisSession: this._sessionSeen.has(entry.id),
          seenEver: loadSeen().has(entry.id),
        };
      })
    );

    console.table(rows);
    return rows;
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
    video.muted = !entry.unmuted;
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
        console.warn(`[cutscene] unknown id "${id}" — no such cutscene registered in cutscenes.js — skipping`);
        resolve();
        return;
      }
      if (this._active) this._finish(this._active, 'superseded'); // defensive: never overlap two clips
      if (DEBUG.skipAll) {
        log(id, 'skipped (window.tfaDebug.skipAllCutscenes is on)');
        resolve();
        return;
      }
      if (this._sessionSeen.has(id)) {
        log(id, 'skipped (already played this session — play-once guard; use tfaDebug.playCutscene to force it)');
        resolve();
        return;
      }
      this._sessionSeen.add(id);
      log(id, `started (video=${entry.video})`);

      const ctx = {
        id,
        entry,
        mode: 'video', // 'video' | 'card' (fixed fallbackText) | 'subs' (generic failsafe — see _fallbackToFailsafe)
        video: null,
        cardEl: null,
        subs: [],
        fallbackDuration: 0,
        wallElapsed: 0,
        lastTick: null,
        skipEnabled: false,
        finished: false,
        wasPlaying: false,
        // Readiness gating (see _tick): the "never fired ended" timeout only
        // starts counting once playback has ACTUALLY started (a "playing" or
        // "timeupdate>0" event), not from the moment we called play() — a
        // clip that never starts at all gets caught by the much shorter
        // STARTUP_GRACE_SECONDS check instead, well before HARD_TIMEOUT_MARGIN.
        playbackStarted: false,
        playStartWallElapsed: 0,
        rafId: null,
        resolve,
      };
      this._active = ctx;
      this.subtitleEl.textContent = '';
      if (this.skipLabelEl) this.skipLabelEl.classList.add('hidden');
      this.overlay.classList.remove('hidden');

      this._loadSubs(id).then((subs) => {
        if (this._active === ctx) ctx.subs = subs;
      });

      ctx.onKeyDown = (e) => {
        if (e.code === 'Escape' && !entry.escSkips) return; // Escape exits pointer lock — must never double as skip (the finale is the one exception, see cutscenes.js)
        if (ctx.skipEnabled) this._finish(ctx, 'skipped-by-user-key');
      };
      ctx.onPointerDown = () => {
        if (ctx.skipEnabled) this._finish(ctx, 'skipped-by-user-click');
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

    ctx.onError = () => {
      const err = video.error;
      const errName = err ? MEDIA_ERROR_NAMES[err.code] || `code ${err.code}` : '(no MediaError object)';
      const netName = NETWORK_STATE_NAMES[video.networkState] ?? video.networkState;
      log(ctx.id, `video error — ${errName}, networkState=${netName}`);
      this._fallbackToFailsafe(ctx);
    };
    ctx.onEnded = () => this._finish(ctx, 'ended-natural');
    ctx.onLoadedMeta = () => {
      this._aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : DEFAULT_ASPECT;
      this.resize();
    };
    ctx.onLoadedData = () => log(ctx.id, `first frame rendered (loadeddata) — ${ctx.wallElapsed.toFixed(2)}s after play() was called`);
    // Readiness race fix: only THIS (not play() resolving, not loadeddata)
    // is what actually gates the "never fired ended" timeout in _tick — a
    // video can sit at currentTime 0 indefinitely after play() resolves if
    // it stalls buffering, and loadeddata only means a frame's data is
    // available, not that playback is advancing.
    ctx.onPlaying = () => {
      if (ctx.playbackStarted) return;
      ctx.playbackStarted = true;
      ctx.playStartWallElapsed = ctx.wallElapsed;
      log(ctx.id, `playback started (playing event, currentTime=${video.currentTime.toFixed(2)}s)`);
    };
    ctx.onTimeUpdate = () => {
      if (ctx.playbackStarted || video.currentTime <= 0) return;
      ctx.playbackStarted = true;
      ctx.playStartWallElapsed = ctx.wallElapsed;
      log(ctx.id, `playback started (timeupdate, currentTime=${video.currentTime.toFixed(2)}s)`);
    };
    video.addEventListener('error', ctx.onError);
    video.addEventListener('ended', ctx.onEnded, { once: true });
    video.addEventListener('loadedmetadata', ctx.onLoadedMeta, { once: true });
    video.addEventListener('loadeddata', ctx.onLoadedData, { once: true });
    video.addEventListener('playing', ctx.onPlaying);
    video.addEventListener('timeupdate', ctx.onTimeUpdate);

    log(ctx.id, `video.play() called (readyState=${video.readyState}, muted=${video.muted})`);
    const playResult = video.play();
    if (playResult && playResult.then) {
      playResult.then(
        () => log(ctx.id, 'video.play() resolved'),
        (err) => {
          log(ctx.id, `video.play() rejected — ${err && err.name}: ${err && err.message}`);
          this._fallbackToFailsafe(ctx);
        }
      );
    } else {
      log(ctx.id, 'video.play() returned no promise (old browser) — assuming it started');
    }
  }

  // Failsafe for a video that errors, gets its play() rejected, or simply
  // never starts within STARTUP_GRACE_SECONDS (see _tick). The story beat
  // must never just vanish, so this never leaves the clip silently skipped:
  // an entry with fixed fallbackText (currently only finale_offering) shows
  // that; everything else replays its OWN .subs.json lines as text cards
  // over black, for as long as those lines actually run (or the clip's
  // normal duration, whichever is longer) — no poster .jpg sibling exists on
  // disk for any clip today, so that's not a real option here.
  _fallbackToFailsafe(ctx) {
    if (ctx.finished || ctx.mode === 'card' || ctx.mode === 'subs') return;
    log(ctx.id, `falling back — video failed/stalled (${ctx.entry.video})`);

    if (ctx.video) {
      if (ctx.onError) ctx.video.removeEventListener('error', ctx.onError);
      if (ctx.onEnded) ctx.video.removeEventListener('ended', ctx.onEnded);
      if (ctx.onLoadedMeta) ctx.video.removeEventListener('loadedmetadata', ctx.onLoadedMeta);
      if (ctx.onLoadedData) ctx.video.removeEventListener('loadeddata', ctx.onLoadedData);
      if (ctx.onPlaying) ctx.video.removeEventListener('playing', ctx.onPlaying);
      if (ctx.onTimeUpdate) ctx.video.removeEventListener('timeupdate', ctx.onTimeUpdate);
      ctx.video.pause();
      if (ctx.video.parentNode) ctx.video.parentNode.removeChild(ctx.video);
      ctx.video = null;
    }

    ctx.wallElapsed = 0; // show the fallback for its own full duration, not whatever time the failed video attempt already burned

    if (ctx.entry.fallbackText) {
      ctx.mode = 'card';
      const card = document.createElement('div');
      card.className = 'cutscene-media active cutscene-fallback-card';
      card.textContent = ctx.entry.fallbackText;
      this.frame.insertBefore(card, this.subtitleEl);
      ctx.cardEl = card;
      return;
    }

    ctx.mode = 'subs';
    const card = document.createElement('div');
    card.className = 'cutscene-media active cutscene-fallback-card';
    this.frame.insertBefore(card, this.subtitleEl);
    ctx.cardEl = card;
    // ctx.subs may still be empty here if _loadSubs() hasn't resolved yet —
    // its .then() (see playCutscene) mutates ctx.subs in place regardless of
    // mode, so lines that arrive after this point still show up; only the
    // total duration computed here won't retroactively stretch for them.
    const lastSubEnd = ctx.subs.reduce((max, s) => Math.max(max, s.t + s.d), 0);
    ctx.fallbackDuration = Math.max(ctx.entry.duration, lastSubEnd);
  }

  _tick(ctx, now) {
    if (ctx.finished) return;
    const dt = ctx.lastTick != null ? Math.max(0, (now - ctx.lastTick) / 1000) : 0;
    ctx.lastTick = now;
    if (!document.hidden) ctx.wallElapsed += dt;

    if (ctx.mode === 'subs') {
      this._updateFallbackCard(ctx, ctx.wallElapsed);
    } else {
      const clock = ctx.mode === 'video' && ctx.video ? ctx.video.currentTime : ctx.wallElapsed;
      this._updateSubtitle(ctx, clock);
    }

    const wasSkippable = ctx.skipEnabled;
    ctx.skipEnabled = ctx.wallElapsed >= (ctx.entry.skipDelay ?? SKIP_DELAY);
    if (ctx.skipEnabled && !wasSkippable && this.skipLabelEl) this.skipLabelEl.classList.remove('hidden');

    if (ctx.mode === 'card' && ctx.wallElapsed >= ctx.entry.duration) {
      this._finish(ctx, 'ended-natural-fallback');
      return;
    }
    if (ctx.mode === 'subs' && ctx.wallElapsed >= ctx.fallbackDuration) {
      this._finish(ctx, 'ended-natural-fallback-subs');
      return;
    }
    if (ctx.mode === 'video') {
      const video = ctx.video;
      if (!ctx.playbackStarted) {
        // Readiness race fix: this is what actually catches "intro_bedroom
        // silently fails right after clicking ЛЕТЕТЬ" — a video that never
        // even starts advancing gets caught here, in STARTUP_GRACE_SECONDS,
        // instead of sitting frozen for the full entry.duration +
        // HARD_TIMEOUT_MARGIN with nothing on screen.
        if (ctx.wallElapsed >= STARTUP_GRACE_SECONDS) {
          log(
            ctx.id,
            `playback never started within ${STARTUP_GRACE_SECONDS}s — readyState=${video ? video.readyState : 'n/a'}, ` +
              `networkState=${video ? NETWORK_STATE_NAMES[video.networkState] ?? video.networkState : 'n/a'}, paused=${video ? video.paused : 'n/a'} — falling back`
          );
          this._fallbackToFailsafe(ctx);
        }
      } else if (ctx.wallElapsed - ctx.playStartWallElapsed >= ctx.entry.duration + HARD_TIMEOUT_MARGIN) {
        log(
          ctx.id,
          `${ctx.entry.duration}s + ${HARD_TIMEOUT_MARGIN}s margin elapsed since playback started without firing "ended" — ` +
            `readyState=${video ? video.readyState : 'n/a'} — forcing it to finish`
        );
        this._finish(ctx, 'ended-forced-timeout');
        return;
      }
    }

    ctx.rafId = requestAnimationFrame((t) => this._tick(ctx, t));
  }

  _updateSubtitle(ctx, t) {
    const line = ctx.subs.find((s) => t >= s.t && t < s.t + s.d);
    const text = line ? line.text : '';
    if (this.subtitleEl.textContent !== text) this.subtitleEl.textContent = text;
  }

  // 'subs' fallback mode: the clip's own dialogue lines, shown full-size on
  // the fallback card itself (not the small caption bar) since there's no
  // video underneath to caption. Every .subs.json on disk is currently an
  // empty [] (no dialogue authored yet) — rather than show a blank black
  // card for the whole duration in that case, name the beat that was
  // supposed to play so a silent failure is still visibly a *specific*
  // failure. Starts showing real lines automatically once any clip's
  // .subs.json actually has content.
  _updateFallbackCard(ctx, t) {
    const line = ctx.subs.find((s) => t >= s.t && t < s.t + s.d);
    const text = line ? line.text : ctx.subs.length === 0 ? ctx.id.replace(/_/g, ' ') : '';
    if (ctx.cardEl && ctx.cardEl.textContent !== text) ctx.cardEl.textContent = text;
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
        if (p && p.catch) {
          p.catch((err) => {
            log(ctx.id, `video.play() rejected after tab regained focus — ${err && err.name}: ${err && err.message}`);
            this._fallbackToFailsafe(ctx);
          });
        }
      }
    }
  }

  _finish(ctx, reason = 'unknown') {
    if (ctx.finished) return;
    ctx.finished = true;
    log(ctx.id, `finished — ${reason}`);
    // Only persist "seen" for a reason that means the player actually saw
    // the content through to its end — a real "ended", or a fallback (fixed
    // card / subs-over-black) that itself ran its full course, or a
    // deliberate skip. NEVER for 'ended-forced-timeout' (started playing,
    // then got stuck — nothing was actually shown) — that's exactly the bug
    // report this guards against: a stalled clip marking itself seen forever.
    if (MARK_SEEN_REASONS.has(reason)) markSeen(ctx.id);
    if (ctx.rafId) cancelAnimationFrame(ctx.rafId);
    window.removeEventListener('keydown', ctx.onKeyDown);
    this.overlay.removeEventListener('pointerdown', ctx.onPointerDown);
    this._detachMedia(ctx);
    if (this._active === ctx) this._active = null;
    this.overlay.classList.add('hidden');
    this.subtitleEl.textContent = '';
    if (this.skipLabelEl) this.skipLabelEl.classList.add('hidden');
    ctx.resolve();
  }

  _detachMedia(ctx) {
    if (ctx.video) {
      if (ctx.onError) ctx.video.removeEventListener('error', ctx.onError);
      if (ctx.onEnded) ctx.video.removeEventListener('ended', ctx.onEnded);
      if (ctx.onLoadedMeta) ctx.video.removeEventListener('loadedmetadata', ctx.onLoadedMeta);
      if (ctx.onLoadedData) ctx.video.removeEventListener('loadeddata', ctx.onLoadedData);
      if (ctx.onPlaying) ctx.video.removeEventListener('playing', ctx.onPlaying);
      if (ctx.onTimeUpdate) ctx.video.removeEventListener('timeupdate', ctx.onTimeUpdate);
      ctx.video.pause();
      while (ctx.video.firstChild) ctx.video.removeChild(ctx.video.firstChild);
      ctx.video.removeAttribute('src');
      ctx.video.load(); // stop any in-flight buffering now that sources are gone
      if (ctx.video.parentNode) ctx.video.parentNode.removeChild(ctx.video);
      ctx.video = null;
    }
    if (ctx.cardEl) {
      if (ctx.cardEl.parentNode) ctx.cardEl.parentNode.removeChild(ctx.cardEl);
      ctx.cardEl = null;
    }
  }
}
