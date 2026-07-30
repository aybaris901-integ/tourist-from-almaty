// Main-menu background music — a single persistent HTMLAudioElement, kept
// deliberately separate from the Web Audio API graph in audio.js/
// musicManager.js. That system exists for the fear-reactive per-country
// gameplay tracks (crossfade, ducking, muffling) and only ever unlocks its
// AudioContext once the player actually starts flying — fine for gameplay
// music, but it meant menu music didn't even start FETCHING until a click.
// A plain <audio> element has no such gate: assigning src/calling load()
// needs no user gesture, only play() does, so this module can start loading
// the moment it's imported (see main.js's top-level import) instead of
// waiting on a button handler.
const MENU_MUSIC_URL = '/audio/music/background.mp3';
const FADE_MS = 400;

// Created once, at module load, and reused for the app's whole lifetime —
// every showMenuShell()/hideMenuShell() cycle just play()s/pause()s this
// same instance, never a new one.
const menuMusicEl = new Audio();
menuMusicEl.src = MENU_MUSIC_URL;
menuMusicEl.loop = true;
menuMusicEl.preload = 'auto';
menuMusicEl.load();

// Chrome (and others) treat an <audio> element's own preload/load() as an
// advisory hint, not a guarantee — it can defer the actual byte fetch until
// something more "committed" happens (attaching to the DOM, calling play()),
// which defeats "start loading immediately" for an element nobody has
// played yet. A plain fetch() has no such heuristic, so use one purely to
// put the request on the wire and warm the HTTP cache the moment this
// module is imported; the response body itself is never touched — by the
// time playMenuMusic() -> menuMusicEl.play() actually pulls the bytes,
// they're already cached, so this never causes a second real download.
fetch(MENU_MUSIC_URL, { credentials: 'same-origin' }).catch(() => {});

let targetVolume = 1; // settings.masterVolume * settings.musicVolume, see main.js's applySettings()
let fadeHandle = null;
let unlockAttached = false;
let wantsPlaying = false; // whether the menu currently wants music playing, independent of whether autoplay has actually succeeded yet

function cancelFade() {
  if (fadeHandle !== null) {
    cancelAnimationFrame(fadeHandle);
    fadeHandle = null;
  }
}

function fadeTo(target, durationMs, onDone) {
  cancelFade();
  const start = menuMusicEl.volume;
  const startTime = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - startTime) / durationMs);
    menuMusicEl.volume = start + (target - start) * t;
    if (t < 1) {
      fadeHandle = requestAnimationFrame(step);
    } else {
      fadeHandle = null;
      if (onDone) onDone();
    }
  };
  fadeHandle = requestAnimationFrame(step);
}

// Most browsers refuse autoplay with sound before the page has seen a user
// gesture — play() then rejects. Fall back to the page's very first
// pointerdown/keydown (self-removing, and only ever attached once for the
// app's lifetime): if the menu still wants music playing when that gesture
// finally arrives, retry.
function attemptPlay() {
  menuMusicEl.volume = 0; // fade in from silence rather than popping in at target volume
  const playResult = menuMusicEl.play();
  const onStarted = () => fadeTo(targetVolume, FADE_MS);
  if (!playResult || !playResult.then) {
    onStarted();
    return;
  }
  playResult.then(onStarted).catch(() => {
    if (unlockAttached) return;
    unlockAttached = true;
    const retry = () => {
      if (wantsPlaying) attemptPlay();
    };
    window.addEventListener('pointerdown', retry, { once: true });
    window.addEventListener('keydown', retry, { once: true });
  });
}

// main.js calls this from showMenuShell() — idempotent (a menu re-open while
// already playing just re-affirms the fade target, it doesn't restart the
// track) and safe to call before the network load finishes (play() on a
// still-loading element just starts once enough data is buffered).
export function playMenuMusic() {
  wantsPlaying = true;
  if (!menuMusicEl.paused) {
    fadeTo(targetVolume, FADE_MS);
    return;
  }
  attemptPlay();
}

// main.js calls this from hideMenuShell() — fades out then pauses (not a new
// instance, not a src reset) so returning to the menu later resumes the same
// element instantly instead of re-fetching/re-decoding anything.
export function pauseMenuMusic() {
  wantsPlaying = false;
  if (menuMusicEl.paused) return;
  fadeTo(0, FADE_MS, () => {
    if (!wantsPlaying) menuMusicEl.pause(); // still false unless playMenuMusic() interrupted the fade first
  });
}

// main.js's applySettings() calls this with masterVolume * musicVolume,
// matching how audio.js's separate master/music gain stages combine for the
// gameplay tracks — kept as a single element here since there's only ever
// one <audio> to drive.
export function setMenuMusicVolume(volume) {
  targetVolume = Math.max(0, Math.min(1, volume));
  if (!menuMusicEl.paused && fadeHandle === null) {
    menuMusicEl.volume = targetVolume;
  }
}
