import * as THREE from 'three';
import { World } from './world.js';
import { Flight, CONFIG as FlightConfig, DEFAULT_MOUSE_SENSITIVITY } from './flight.js';
import { Cockpit } from './cockpit.js';
import { UI } from './ui.js';
import { RouteHud } from './routeHud.js';
import { Fear } from './fear.js';
import { PostFX } from './postfx.js';
import { FearAudio } from './audio.js';
import { playMenuMusic, pauseMenuMusic, setMenuMusicVolume } from './menuMusic.js';
import { Threats } from './threats.js';
import { Radio } from './radio.js';
import { Route, WAVES } from './route.js';
import { LandingSequence } from './landing.js';
import { CutscenePlayer } from './cutscenePlayer.js';
import { INTRO_SEQUENCE, WAVE_COMPLETE_CUTSCENE, FINALE_CUTSCENE_ID, DEBUG as CUTSCENE_DEBUG } from './cutscenes.js';
import { CREDITS_HTML } from './credits.js';
import { MenuUI, stripFlatBackground } from './menu.js';
import { loadProgress, saveProgress } from './progress.js';
import { loadSettings, saveSettings } from './settings.js';

const MENU_VIDEO_URL = '/video/menu.mp4'; // config path — swap here if it ever moves
const MENU_LOGO_URL = '/img/logo.png';

const sceneCanvas = document.getElementById('scene');
const hudCanvas = document.getElementById('hud');
const fpsElement = document.getElementById('fps-counter');
const hint = document.getElementById('pointer-lock-hint');
const blackout = document.getElementById('blackout');
const panicFreezeCanvas = document.getElementById('panic-freeze');
const panicFreezeCtx = panicFreezeCanvas.getContext('2d');
const cutsceneOverlay = document.getElementById('cutscene');
const cutsceneFrame = document.getElementById('cutscene-frame');
const cutsceneSubtitle = document.getElementById('cutscene-subtitle');
const cutsceneSkipLabel = document.getElementById('cutscene-skip');
const finaleFade = document.getElementById('finale-fade');
const creditsEl = document.getElementById('credits');
const menuShellEl = document.getElementById('menu-shell');
const menuVideoEl = document.getElementById('menu-video');
const menuScreensEl = document.getElementById('menu-screens');
const menuLogoEl = document.getElementById('menu-logo');
const pauseOverlayEl = document.getElementById('pause-overlay');
const pauseScreensEl = document.getElementById('pause-screens');
const panicOverlayEl = document.getElementById('panic-overlay');
const panicScreensEl = document.getElementById('panic-screens');
const routeHudEl = document.getElementById('route-hud');

const renderer = new THREE.WebGLRenderer({ canvas: sceneCanvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 20000);
// The cockpit frame/dashboard are parented to the camera; the camera must be
// part of the scene graph for those children to be traversed and rendered.
scene.add(camera);

const world = new World(scene);
const flight = new Flight(camera, sceneCanvas);
const cockpit = new Cockpit(camera);
const ui = new UI(hudCanvas, fpsElement);
const routeHud = new RouteHud(routeHudEl);
const fear = new Fear();
const postfx = new PostFX(renderer, scene, camera);
const audio = new FearAudio();
const threats = new Threats(scene, audio);
const radio = new Radio(audio);
let route = new Route(threats, world, radio, fear, audio);
const landing = new LandingSequence(camera);
const cutscenePlayer = new CutscenePlayer(cutsceneOverlay, cutsceneFrame, cutsceneSubtitle, cutsceneSkipLabel);

// --- Stage 7B: menu shell, pause, settings, progress ----------------------
const progress = loadProgress(); // { highestWaveReached } — see progress.js
const settings = loadSettings(); // live mutable object — see settings.js
const mainMenu = new MenuUI(menuScreensEl);
const pauseMenu = new MenuUI(pauseScreensEl);

// Pushes the live settings object into every system that actually reads it.
// Called once on load (so a saved sensitivity/invert/volume applies before
// the player ever touches a control) and again after every slider/toggle
// change from either menu.
function applySettings() {
  FlightConfig.INVERT_ROLL = settings.invertRoll;
  FlightConfig.INVERT_PITCH = settings.invertPitch;
  FlightConfig.MOUSE_SENSITIVITY = DEFAULT_MOUSE_SENSITIVITY * settings.mouseSensitivity;
  // audio.setVolumes() defers internally (via _pendingVolumes) until
  // resume() actually builds the audio graph, same as setMusicCountry().
  audio.setVolumes({ master: settings.masterVolume, music: settings.musicVolume, sfx: settings.sfxVolume });
  // menuMusic.js has no separate master/music gain stages (just one
  // <audio> element) — combine the two sliders the same way they'd
  // multiply together in audio.js's graph.
  setMenuMusicVolume(settings.masterVolume * settings.musicVolume);
}
applySettings();

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function volumeSettingItem(label, key) {
  return {
    type: 'slider',
    label,
    fill: settings[key],
    valueText: `${Math.round(settings[key] * 100)}%`,
    onAdjust: (dir) => {
      settings[key] = Math.round(clamp(settings[key] + dir * 0.1, 0, 1) * 100) / 100;
      applySettings();
      saveSettings(settings);
    },
    onSet: (fraction) => {
      settings[key] = Math.round(clamp(fraction, 0, 1) * 100) / 100;
      applySettings();
      saveSettings(settings);
    },
  };
}

const SENSITIVITY_MIN = 0.3;
const SENSITIVITY_MAX = 2.5;
function sensitivitySettingItem() {
  return {
    type: 'slider',
    label: 'Чувствительность мыши',
    fill: (settings.mouseSensitivity - SENSITIVITY_MIN) / (SENSITIVITY_MAX - SENSITIVITY_MIN),
    valueText: `${settings.mouseSensitivity.toFixed(2)}x`,
    onAdjust: (dir) => {
      settings.mouseSensitivity = Math.round(clamp(settings.mouseSensitivity + dir * 0.1, SENSITIVITY_MIN, SENSITIVITY_MAX) * 100) / 100;
      applySettings();
      saveSettings(settings);
    },
    onSet: (fraction) => {
      settings.mouseSensitivity = Math.round(clamp(SENSITIVITY_MIN + fraction * (SENSITIVITY_MAX - SENSITIVITY_MIN), SENSITIVITY_MIN, SENSITIVITY_MAX) * 100) / 100;
      applySettings();
      saveSettings(settings);
    },
  };
}

function toggleSettingItem(label, key) {
  return {
    type: 'toggle',
    label,
    value: settings[key],
    onToggle: () => {
      settings[key] = !settings[key];
      applySettings();
      saveSettings(settings);
    },
  };
}

// Shared between the main menu's "Настройки" and the pause menu's
// "Настройки" — same live settings object either way, only the "Назад"
// action differs (which MenuUI instance is showing it). "Смотреть
// вступление" only makes sense from the main menu (pause mid-flight has
// nowhere sensible to suspend into for it), so it's added conditionally.
function buildSettingsItems(menuInstance) {
  const items = [
    volumeSettingItem('Общая громкость', 'masterVolume'),
    volumeSettingItem('Музыка', 'musicVolume'),
    volumeSettingItem('Звуки', 'sfxVolume'),
    sensitivitySettingItem(),
    toggleSettingItem('Инверсия крена', 'invertRoll'),
    toggleSettingItem('Инверсия тангажа', 'invertPitch'),
    toggleSettingItem('Упрощённая графика', 'simpleGraphics'),
  ];
  if (menuInstance === mainMenu) {
    items.push({ label: 'Смотреть вступление', action: () => watchIntroFromMenu() });
  }
  items.push({ label: 'Назад', action: () => menuInstance.pop() });
  return items;
}

// "Смотреть вступление" (Настройки, main menu only): replays the intro
// sequence on demand regardless of the seen-flag, then returns to the menu
// — NOT into flying, this is just a rewatch, not a fresh start. replayCutscene()
// bypasses both the persisted flag and the in-session guard on its own, so
// no resetIntroFlag() call is needed here (unlike startNewGame's forceIntro).
async function watchIntroFromMenu() {
  hideMenuShell();
  setState('CUTSCENE');
  audio.setCutsceneDuck(true);
  for (const id of INTRO_SEQUENCE) {
    await cutscenePlayer.replayCutscene(id);
  }
  audio.setCutsceneDuck(false);
  setState('MENU');
  showMenuShell();
}

function buildControlsItems(menuInstance) {
  return [
    {
      type: 'panel',
      html: `<div class="menu-panel-content">
        <div><b>Мышь</b> &mdash; крен / тангаж</div>
        <div><b>Стрелки</b> &mdash; крен / тангаж (клавиатура)</div>
        <div><b>W / Shift</b> &mdash; газ, <b>S / Ctrl</b> &mdash; тормоз</div>
        <div><b>1 / 2 / 3</b> &mdash; ответ по рации</div>
        <div><b>Esc</b> &mdash; пауза</div>
        <div><b>F</b> &mdash; FPS, <b>D</b> &mdash; отладка страха, <b>T</b> &mdash; отладка истребителей</div>
      </div>`,
    },
    { label: 'Назад', action: () => menuInstance.pop() },
  ];
}

function buildCountrySelectItems() {
  // Picking Kazakhstan specifically is the same "fresh story start" as
  // ЛЕТЕТЬ/Начать сначала — every other entry is a mid-route jump, so it
  // respects the seen-flag like Продолжить does.
  const items = WAVES.map((wave, i) =>
    i <= progress.highestWaveReached ? { label: wave.country, action: () => startNewGame(i, { forceIntro: i === 0 }) } : null
  ).filter(Boolean);
  items.push({ label: 'Назад', action: () => mainMenu.pop() });
  return items;
}

function buildMainMenuItems() {
  const items = [];
  if (progress.highestWaveReached > 0) {
    items.push({
      label: `Продолжить: ${WAVES[progress.highestWaveReached].country}`,
      action: () => startNewGame(progress.highestWaveReached),
    });
    items.push({ label: 'Начать сначала', action: () => startNewGame(0, { forceIntro: true }) });
  } else {
    items.push({ label: 'ЛЕТЕТЬ', action: () => startNewGame(0, { forceIntro: true }) });
  }
  items.push({ label: 'Выбор страны', action: () => mainMenu.push('country-select', buildCountrySelectItems) });
  items.push({ label: 'Настройки', action: () => mainMenu.push('settings', () => buildSettingsItems(mainMenu)) });
  items.push({ label: 'Управление', action: () => mainMenu.push('controls', () => buildControlsItems(mainMenu)) });
  items.push({ label: 'Титры', action: () => showCredits() });
  return items;
}

function buildPauseMainItems() {
  return [
    { label: 'Продолжить', action: () => resumeFromPause() },
    { label: 'Настройки', action: () => pauseMenu.push('settings', () => buildSettingsItems(pauseMenu)) },
    {
      label: 'Рестарт страны',
      action: () => {
        route.restartCurrentWave();
        resumeFromPause();
      },
    },
    {
      label: 'В меню',
      action: () => {
        pauseMenu.close();
        pauseOverlayEl.classList.add('hidden');
        resetToMenu();
      },
    },
  ];
}

// --- Menu shell video background ------------------------------------------
// Muted+loop+playsinline+autoplay is the only combination browsers allow
// without a user gesture. menu-video's own background-color (see style.css)
// covers the gap before the first frame decodes; if the file itself is
// missing/fails, hide the element entirely and let the live idle scene
// (already rendering underneath every frame — see the MENU branch below)
// show through instead.
menuVideoEl.src = MENU_VIDEO_URL;
menuVideoEl.addEventListener('error', () => menuVideoEl.classList.add('hidden'));

function playMenuVideo() {
  if (menuVideoEl.classList.contains('hidden')) return;
  const p = menuVideoEl.play();
  if (p && p.catch) p.catch(() => {});
}

function pauseMenuVideo() {
  if (!menuVideoEl.paused) menuVideoEl.pause();
}

// logo.png ships with a flat background — no image-editing tool was
// available to pre-process the file, so this chroma-keys it out at runtime
// (see menu.js). Falls back to the original file (already the <img>'s src
// via index.html) if that ever fails.
stripFlatBackground(MENU_LOGO_URL)
  .then((dataUrl) => {
    menuLogoEl.src = dataUrl;
  })
  .catch(() => {});

function showMenuShell() {
  menuShellEl.classList.remove('hidden');
  playMenuVideo();
  // menuMusic.js already started loading this at import time — this just
  // (re)starts/reuses the same persistent <audio> instance. If autoplay is
  // blocked (no user gesture yet), it retries itself on the page's first
  // pointerdown/keydown.
  playMenuMusic();
  mainMenu.open('main', buildMainMenuItems);
}

function hideMenuShell() {
  mainMenu.close();
  menuShellEl.classList.add('hidden');
  pauseMenuVideo();
  pauseMenuMusic();
}

// --- Credits ---------------------------------------------------------------
// Reused for both the post-finale credits (onDismiss = resetToMenu) and the
// main menu's "Титры" button (onDismiss defaults to a no-op — the main menu
// is already open underneath and needs no further action).
function showCredits(onDismiss = () => {}) {
  mainMenu.suspend(); // no-op if mainMenu isn't open (e.g. the post-finale case)
  creditsEl.innerHTML = CREDITS_HTML;
  creditsEl.classList.remove('hidden');

  const dismiss = (e) => {
    if (e.type === 'keydown' && e.code !== 'Enter' && e.code !== 'Escape') return;
    window.removeEventListener('keydown', dismiss);
    creditsEl.removeEventListener('click', dismiss);
    creditsEl.classList.add('hidden');
    mainMenu.resume();
    onDismiss();
  };
  window.addEventListener('keydown', dismiss);
  creditsEl.addEventListener('click', dismiss);
}

// --- Game state machine: MENU -> CUTSCENE -> FLYING -> PAUSED -------------
// In MENU, world/flight/cockpit idle-render but fear/radio/threats/route
// never tick and postfx is bypassed entirely (plain renderer.render), so
// nothing "runs" before the player picks something from the menu. fear.js's
// `frozen` flag is the other half of this — it blocks the debug [ / ] keys
// too, since those are bound independently of this loop. CUTSCENE and PAUSED
// both fully suspend the loop below (no updates, no render) — the cutscene
// overlay covers the whole viewport for the former, the pause overlay sits
// over the frozen last gameplay frame for the latter (canvases simply retain
// whatever they last drew when nothing redraws them).
let state = 'MENU';

// Centralizes pointer lock around every state transition (bug report: mouse
// clicks did nothing on overlay screens because lock stayed engaged —
// classic "stuck pointer lock", cursor hidden and clicks captured as raw
// deltas instead of real clicks). ALWAYS route state changes through this
// instead of assigning `state` directly, so no future overlay can
// reintroduce the same bug by forgetting to touch pointer lock itself.
// Note: the panic screen (route.phase === 'restart-flash') is a sub-phase of
// FLYING, not a separate top-level state, so it's handled by its own
// edge-detect in the render loop below, not here.
function setState(next) {
  const leavingFlying = state === 'FLYING' && next !== 'FLYING';
  const enteringFlying = state !== 'FLYING' && next === 'FLYING';
  state = next;
  if (leavingFlying && document.pointerLockElement === sceneCanvas) {
    document.exitPointerLock();
  }
  if (enteringFlying) {
    const req = sceneCanvas.requestPointerLock();
    if (req && req.catch) req.catch(() => {});
  }
}

function enterFlying() {
  setState('FLYING');
  fear.frozen = false;
  hint.classList.add('hidden');
  audio.setSuspended(false);
}

function canPause() {
  return state === 'FLYING' && (route.phase === 'flying' || route.phase === 'transition');
}

function openPause() {
  setState('PAUSED');
  audio.setSuspended(true);
  pauseOverlayEl.classList.remove('hidden');
  pauseMenu.onEscapeAtRoot = () => resumeFromPause();
  pauseMenu.open('main', buildPauseMainItems);
}

function resumeFromPause() {
  pauseMenu.close();
  pauseOverlayEl.classList.add('hidden');
  setState('FLYING'); // reacquires pointer lock itself
  audio.setSuspended(false);
}

// Suspends the loop, ducks music, plays `id`, then restores whatever state
// was active before (always 'FLYING' in practice — wave-complete/finale
// cutscenes only ever fire from inside the FLYING branch below). `replay`
// bypasses cutscenePlayer's play-once guard (window.tfaDebug.replayCutscene).
function gatedCutscene(id, { replay = false } = {}) {
  const prevState = state;
  setState('CUTSCENE');
  audio.setCutsceneDuck(true);
  const promise = replay ? cutscenePlayer.replayCutscene(id) : cutscenePlayer.playCutscene(id);
  return promise.then(() => {
    audio.setCutsceneDuck(false);
    setState(prevState); // reacquires pointer lock itself if prevState was 'FLYING'
  });
}

// Stage 7A finale, part 3: crossfade to black over the last landed frame,
// then hand off to the existing finale_offering clip — unlike every other
// cutscene, this one's own audio matters (see cutscenes.js's `unmuted`), so
// the game music is fully silenced (not just ducked) before it starts.
// Bypasses gatedCutscene() (used for every other cutscene) since this needs
// that different duck behavior and doesn't return to FLYING afterward —
// credits, then MENU, instead.
async function runFinaleSequence() {
  finaleFade.style.opacity = '1';
  await new Promise((resolve) => setTimeout(resolve, 1000));

  setState('CUTSCENE');
  audio.setCutsceneDuck(true, { full: true });
  audio.stopMusic();
  await cutscenePlayer.playCutscene(FINALE_CUTSCENE_ID);
  audio.setCutsceneDuck(false);

  finaleFade.style.opacity = '0';
  showCredits(resetToMenu);
}

// Resets every system a fresh playthrough touches, at `waveIndex`. Shared by
// resetToMenu() (always 0 — the MENU backdrop's Route is just an inert
// placeholder, never advanced/rendered with HUD) and startNewGame().
function resetGameState(waveIndex) {
  flight.reset();
  fear.value = 0;
  fear.panicActive = false;
  fear.panicTimer = 0;
  threats.resetForReplay();
  radio.resetForReplay();
  world.resetForReplay();
  audio.resetForReplay();
  routeHud.resetForReplay();
  route = new Route(threats, world, radio, fear, audio, waveIndex);
  preloadForWave(route.waveIndex);

  lastWaveIndex = route.waveIndex;
  routeCompleteHandled = false;
  calmPayoffHandled = false;
  landingStarted = false;
  wasPanicking = false;
  wasInPanicScreen = false;
}

// Stage 7A finale, part 4 / Stage 7B pause's "В меню": back to MENU without
// a page reload. Cutscenes are deliberately left alone (cutscenePlayer's
// play-once guards are permanent for the session/forever, matching the
// existing reload behavior documented in runIntroThenFly()).
function resetToMenu() {
  resetGameState(0);
  fear.frozen = true;
  setState('MENU');
  audio.setSuspended(true);
  showMenuShell();
}

// Stage 7B: ЛЕТЕТЬ / Продолжить / Начать сначала / country-select all funnel
// through here — there's no fine-grained mid-flight save, so "continue" and
// picking a country both just start that wave from its beginning.
// forceIntro: true for a genuine fresh story start (ЛЕТЕТЬ, Начать сначала,
// picking Kazakhstan from country-select) — always plays the intro
// regardless of the seen-flag, and clears it first. "Продолжить" and every
// other country-select entry leave it false and respect the seen-flag.
function startNewGame(waveIndex, { forceIntro = false } = {}) {
  resetGameState(waveIndex);
  hideMenuShell();
  audio.resume();
  const req = sceneCanvas.requestPointerLock();
  if (req && req.catch) req.catch(() => {});
  runIntroThenFly(forceIntro);
}

function preloadForWave(index) {
  const id = WAVE_COMPLETE_CUTSCENE[index];
  if (id) cutscenePlayer.preload(id);
  if (index === WAVES.length - 1) cutscenePlayer.preload(FINALE_CUTSCENE_ID);
}

INTRO_SEQUENCE.forEach((id) => cutscenePlayer.preload(id));
preloadForWave(route.waveIndex);

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === sceneCanvas;
  // Only meaningful once actually flying — the menu/pause overlays cover the
  // canvas entirely regardless, and runIntroThenFly() below no longer
  // depends on this event (it calls enterFlying() explicitly in both
  // branches), so this is now just the hint's own visibility. Also excluded
  // during the panic screen — a sub-phase of FLYING (see setState()'s
  // comment), which deliberately releases lock itself; showing "click to
  // regain mouse control" under the panic buttons would just be clutter.
  if (state === 'FLYING' && route.phase !== 'restart-flash') {
    hint.classList.toggle('hidden', locked);
  }
});

async function runIntroThenFly(forceIntro = false) {
  if (forceIntro) {
    // A fresh story start (see startNewGame's forceIntro) must always show
    // the intro, so clear both the persisted flag and this session's guard
    // first — otherwise a stale "seen" from an earlier playthrough/test this
    // same session would still skip it below.
    cutscenePlayer.resetIntroFlag();
  } else if (cutscenePlayer.hasSeenIntro()) {
    // Already played on a prior playthrough/reload (localStorage flag —
    // persists across Ctrl+Shift+R, and is also set by tfaDebug.playCutscene/
    // replayCutscene('cockpit_reveal'), not just a real playthrough). Log it
    // explicitly so a skipped intro is never mistaken for a silent failure —
    // see window.tfaDebug.resetIntroFlag() to force it to replay.
    console.log('[intro] skipping — already seen (see cutscenePlayer.hasSeenIntro / tfaDebug.resetIntroFlag)');
    enterFlying();
    return;
  }

  setState('CUTSCENE');
  hint.classList.add('hidden');
  audio.setCutsceneDuck(true);
  for (const id of INTRO_SEQUENCE) {
    await cutscenePlayer.playCutscene(id);
  }
  audio.setCutsceneDuck(false);
  enterFlying();
  // Match cut into gameplay is the premise here — no fade, no menu flash.
  // Pointer lock can be lost mid-clip (e.g. Escape); reclaim it silently.
  // Browsers may refuse without a fresh user gesture (the original click's
  // transient activation has likely expired by now) — if so, keyboard
  // flight still works and the player can click to regain mouse control.
  if (document.pointerLockElement !== sceneCanvas) {
    const req = sceneCanvas.requestPointerLock();
    if (req && req.catch) req.catch(() => {});
  }
}

// Dev-only cutscene tools — see console. skipAllCutscenes bypasses every
// clip (still resolves normally, just instantly) for playtesting a specific
// leg. forceCalmPayoff/forceRouteComplete skip straight to a given point in
// Stage 7A without ~9-10 minutes of flawless flying through all 5 waves —
// forceCalmPayoff for the calm-payoff/landing sequence, forceRouteComplete
// straight past landing to the finale video/credits/menu handoff.
// playCutscene/listCutscenes are the "which of the 9 clips actually play"
// audit tools — playCutscene works from ANY state (gatedCutscene saves/
// restores whatever state was active), listCutscenes checks file existence
// + codec support for every registered id without touching game state at
// all. Every cutscene's play/skip/error/finish path also logs to the
// console on its own now (see cutscenePlayer.js's log()) — no silent
// advances, whether triggered from here or from normal gameplay.
window.tfaDebug = {
  replayCutscene: (id) => gatedCutscene(id, { replay: true }),
  playCutscene: (id) => gatedCutscene(id, { replay: true }),
  listCutscenes: () => cutscenePlayer.listCutscenes(),
  resetIntroFlag: () => cutscenePlayer.resetIntroFlag(),
  skipAllCutscenes: (skip = true) => {
    CUTSCENE_DEBUG.skipAll = skip;
  },
  forceCalmPayoff: () => {
    if (route.phase === 'flying' || route.phase === 'transition') route._completeRoute();
  },
  forceRouteComplete: () => {
    route.phase = 'complete';
  },
};

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio, 2);

  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  postfx.resize(width, height);
  ui.resize(width, height, dpr);
  cockpit.resize();
  cutscenePlayer.resize();

  panicFreezeCanvas.width = Math.round(width * dpr);
  panicFreezeCanvas.height = Math.round(height * dpr);
  panicFreezeCanvas.style.width = `${width}px`;
  panicFreezeCanvas.style.height = `${height}px`;
}
window.addEventListener('resize', resize);
resize();

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyF') ui.toggleFps();
  if (e.code === 'KeyD') ui.toggleDebug();
  if (e.code === 'KeyT') ui.toggleFighterDebug();
  // Panic screen's own Enter/Escape are handled by panicMenu's own keydown
  // listener now (attached while it's open — see the route.phase edge-detect
  // in the render loop below), not here — Enter activates whichever button
  // is actually focused (mouse hover moves that focus too), Escape maps to
  // onEscapeAtRoot ("В меню"), same mechanism as every other menu.
  if (e.code === 'Escape' && canPause()) openPause();
});

// Panic screen (route.phase === 'restart-flash') — a sub-phase of FLYING,
// not its own top-level `state`, so setState() doesn't cover it. Its two
// buttons are real DOM (panicMenu, a MenuUI instance) laid over ui.js's
// canvas-drawn title/lines, not canvas-drawn themselves (canvas can't be
// clicked). Pointer lock must release the instant this phase is entered —
// this is the actual fix for "clicks do nothing on the panic screen":
// `state` stayed 'FLYING' throughout, so setState() alone never ran.
const panicMenu = new MenuUI(panicScreensEl);
let wasInPanicScreen = false; // edge-detects entering/leaving 'restart-flash', see the render loop

function retryFromPanicScreen() {
  route.retryFromPanic();
}

function exitPanicToMenu() {
  panicMenu.close();
  panicOverlayEl.classList.add('hidden');
  wasInPanicScreen = false; // resetGameState() below also resets this, but the new route needs it clear immediately, not next frame
  resetToMenu();
}

function buildPanicItems() {
  return [
    { label: 'Соберись и лети', action: () => retryFromPanicScreen() },
    { label: 'В меню', action: () => exitPanicToMenu() },
  ];
}

showMenuShell();

const clock = new THREE.Clock();
let fpsAccum = 0;
let fpsFrames = 0;
let wasPanicking = false; // edge-detects the instant fear.panicActive turns true, to capture the freeze-frame exactly once
let lastWaveIndex = route.waveIndex; // edge-detects a wave completing, to fire that wave's flyover cutscene exactly once
let routeCompleteHandled = false; // edge-detects route.phase reaching 'complete', to run the finale video/credits/menu sequence exactly once
let calmPayoffHandled = false; // edge-detects route.phase reaching 'calm-payoff', to kick off the one-shot world/audio/cockpit finale cues exactly once
let landingStarted = false; // edge-detects route.phase reaching 'landing', to call landing.begin()/buildFinaleSetDressing() exactly once

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);

  if (state === 'FLYING') {
    // threats.timeScale dips briefly on a clean dodge (satisfying slow-mo);
    // gameplay motion uses gameDt, scheduling/fear/UI/audio stay on real dt.
    const gameDt = dt * threats.timeScale;

    // hasActiveThreats() reflects the end of the PREVIOUS frame's
    // threats.update() (which runs below, after fear.update()) — a
    // one-frame lag that doesn't matter for a per-second fear economy.
    fear.update(dt, threats.hasActiveThreats(), route.waveIndex);
    route.update(dt, flight);

    // Panic screen entry/exit — see the setState() block above for why this
    // can't just be a state transition: route.phase is a sub-phase of
    // FLYING, so `state` never changes here on its own.
    const inPanicScreen = route.phase === 'restart-flash';
    if (inPanicScreen !== wasInPanicScreen) {
      wasInPanicScreen = inPanicScreen;
      if (inPanicScreen) {
        if (document.pointerLockElement === sceneCanvas) document.exitPointerLock();
        audio.setSuspended(true);
        panicOverlayEl.classList.remove('hidden');
        panicMenu.onEscapeAtRoot = () => exitPanicToMenu();
        panicMenu.open('main', buildPanicItems);
      } else {
        // Only reached via retryFromPanicScreen() (exitPanicToMenu already
        // closes the overlay itself and leaves FLYING entirely, so this
        // branch never runs for that path) — reacquire lock to keep flying.
        panicMenu.close();
        panicOverlayEl.classList.add('hidden');
        audio.setSuspended(false);
        const req = sceneCanvas.requestPointerLock();
        if (req && req.catch) req.catch(() => {});
      }
    }

    if (route.waveIndex !== lastWaveIndex) {
      const completedIndex = lastWaveIndex;
      lastWaveIndex = route.waveIndex;
      if (route.waveIndex > progress.highestWaveReached) {
        progress.highestWaveReached = route.waveIndex;
        saveProgress(progress.highestWaveReached);
      }
      const cutsceneId = WAVE_COMPLETE_CUTSCENE[completedIndex];
      if (cutsceneId) gatedCutscene(cutsceneId);
      preloadForWave(route.waveIndex);
    }

    // Stage 7A finale: calm-payoff's one-shot cues (world haze lift, music
    // swell, bottle highlight), then landing's one-shot setup (capture the
    // scripted path's origin/heading, build the Bosphorus/bridge/minaret/
    // runway set dressing at the exact distances that path will fly over).
    if (!calmPayoffHandled && route.phase === 'calm-payoff') {
      calmPayoffHandled = true;
      world.beginFinaleClear(15);
      audio.playFinaleSwell();
      cockpit.triggerBottleHighlight();
    }
    if (!landingStarted && route.phase === 'landing') {
      landingStarted = true;
      const path = landing.begin(flight);
      world.buildFinaleSetDressing(path.origin, path.forward, path.right, path);
    }
    if (!routeCompleteHandled && route.phase === 'complete') {
      routeCompleteHandled = true;
      runFinaleSequence();
    }

    // 'complete' is a brief handoff window (runFinaleSequence's 1s
    // crossfade-to-black, already under way by the time phase reaches this
    // value) — the plane just holds exactly where landing.js parked it, no
    // stick control, same as 'landing' itself.
    const suspendFlight = route.phase === 'landing' || route.phase === 'complete';
    if (route.phase === 'landing') {
      // Autopilot: no stick control, only a light camera-look offset (see
      // landing.js) — flight.update() is skipped entirely this frame.
      landing.update(dt, flight, audio);
      if (landing.done) route.completeLanding();
    } else if (!suspendFlight) {
      threats.update(dt, gameDt, flight, fear, radio);
      if (route.phase !== 'calm-payoff') radio.update(dt, fear, route.waveIndex); // no incoming calls during the calm-down
      flight.update(gameDt, fear);
    }
    world.update(flight.position, gameDt);
    cockpit.update(flight.stick, fear, gameDt);
    ui.update(flight, fear, dt, threats, radio, route, audio, settings.simpleGraphics);
    audio.update(dt, fear);
    // Matches the old canvas progress strip's own visibility rule (drawn
    // whenever !inLanding) — hidden during the scripted landing rollout,
    // visible everywhere else in FLYING including the panic screen.
    routeHud.setVisible(route.phase !== 'landing');
    routeHud.update(route, flight);
    hudCanvas.style.opacity = suspendFlight ? landing.hudAlpha : 1;
    blackout.style.opacity = fear.panicBlackAlpha;
    // Упрощённая графика: skip the postfx composer entirely (cheaper for a
    // weak laptop) — ui.js's fear bar pulses harder/earlier to make up for
    // losing the vignette/aberration/warp read on fear.
    if (settings.simpleGraphics) {
      renderer.render(scene, camera);
    } else {
      postfx.render(dt, fear.normalized);
    }

    // Grab the panic screen's freeze-frame on the exact frame the blackout
    // begins — sceneCanvas still holds this frame's just-rendered pixels
    // (drawImage on a WebGL canvas works without preserveDrawingBuffer as
    // long as it happens before the browser composites/clears, i.e. later
    // in this same callback — which this is).
    if (fear.panicActive && !wasPanicking) {
      panicFreezeCtx.filter = 'grayscale(0.7) brightness(0.45)';
      panicFreezeCtx.drawImage(sceneCanvas, 0, 0, panicFreezeCanvas.width, panicFreezeCanvas.height);
      panicFreezeCtx.filter = 'none';
    }
    wasPanicking = fear.panicActive;
    panicFreezeCanvas.style.opacity = fear.panicActive || route.phase === 'restart-flash' ? '1' : '0';
  } else if (state === 'MENU') {
    // MENU: world/flight idle so the backdrop isn't a frozen frame, but no
    // fear/radio/threats/route ticking, no HUD, no post-processing.
    flight.update(dt, fear);
    world.update(flight.position, dt);
    cockpit.update(flight.stick, fear, dt);
    renderer.render(scene, camera);
    routeHud.setVisible(false);
  }
  // state === 'CUTSCENE'/'PAUSED': loop fully suspended — the cutscene
  // overlay/pause overlay covers the relevant part of the viewport, and
  // whatever was last drawn to the canvases underneath simply stays there.

  fpsAccum += dt;
  fpsFrames += 1;
  if (fpsAccum >= 0.4) {
    ui.setFps(fpsFrames / fpsAccum);
    fpsAccum = 0;
    fpsFrames = 0;
  }
});
