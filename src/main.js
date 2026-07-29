import * as THREE from 'three';
import { World } from './world.js';
import { Flight } from './flight.js';
import { Cockpit } from './cockpit.js';
import { UI } from './ui.js';
import { Fear } from './fear.js';
import { PostFX } from './postfx.js';
import { FearAudio } from './audio.js';
import { Threats } from './threats.js';
import { Radio } from './radio.js';
import { Route, WAVES } from './route.js';
import { CutscenePlayer } from './cutscenePlayer.js';
import { INTRO_SEQUENCE, WAVE_COMPLETE_CUTSCENE, FINALE_CUTSCENE_ID, DEBUG as CUTSCENE_DEBUG } from './cutscenes.js';

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
const fear = new Fear();
const postfx = new PostFX(renderer, scene, camera);
const audio = new FearAudio();
const threats = new Threats(scene, audio);
const radio = new Radio(audio);
const route = new Route(threats, world, radio, fear, audio);
const cutscenePlayer = new CutscenePlayer(cutsceneOverlay, cutsceneFrame, cutsceneSubtitle);

// --- Game state machine: MENU -> CUTSCENE -> FLYING (-> PAUSED later) -----
// In MENU, world/flight/cockpit idle-render but fear/radio/threats/route
// never tick and postfx is bypassed entirely (plain renderer.render), so
// nothing "runs" before the player clicks. fear.js's `frozen` flag is the
// other half of this — it blocks the debug [ / ] keys too, since those are
// bound independently of this loop. CUTSCENE fully suspends the loop below
// (no updates, no render — the cutscene overlay covers the whole screen).
let state = 'MENU';

function enterFlying() {
  if (state === 'FLYING') return;
  state = 'FLYING';
  fear.frozen = false;
  hint.classList.add('hidden');
}

// Suspends the loop, ducks music, plays `id`, then restores whatever state
// was active before (always 'FLYING' in practice — wave-complete/finale
// cutscenes only ever fire from inside the FLYING branch below). `replay`
// bypasses cutscenePlayer's play-once guard (window.tfaDebug.replayCutscene).
function gatedCutscene(id, { replay = false } = {}) {
  const prevState = state;
  state = 'CUTSCENE';
  audio.setCutsceneDuck(true);
  const promise = replay ? cutscenePlayer.replayCutscene(id) : cutscenePlayer.playCutscene(id);
  return promise.then(() => {
    audio.setCutsceneDuck(false);
    state = prevState;
  });
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
  // Once flying, the hint must never reappear — even if lock is later lost
  // (e.g. Escape) — since that's exactly how it could end up coexisting
  // with the radio box again. No PAUSED state yet, so this is a one-way door.
  // Gated on CUTSCENE too: pointer lock resolves almost immediately after
  // the click, well before the intro clips finish, and must not hand off to
  // FLYING early — runIntroThenFly() does that explicitly once they end.
  if (state !== 'FLYING') {
    hint.classList.toggle('hidden', locked);
  }
  if (locked && state !== 'CUTSCENE') enterFlying();
});

// AudioContext requires a user gesture; reuse the same click that engages
// pointer lock (requested first, by flight.js's own click listener on this
// same element — registered before this one, so it always runs first) to
// also kick off the intro sequence.
let clickStarted = false;
sceneCanvas.addEventListener('click', () => {
  if (clickStarted) return;
  clickStarted = true;
  audio.resume();
  runIntroThenFly();
});

async function runIntroThenFly() {
  if (cutscenePlayer.hasSeenIntro()) return; // already played on a prior playthrough/reload — pointerlockchange's enterFlying() above handles the rest, same as before this feature existed

  state = 'CUTSCENE';
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
// leg. forceRouteComplete is TEMPORARY: route.js has no Stage 7 landing
// sequence yet, so route.phase==='complete' is otherwise only reached by
// ~9-10 minutes of flawless flying through all 5 waves. Replace this call
// site with the real landing-sequence-complete condition once it exists.
window.tfaDebug = {
  replayCutscene: (id) => gatedCutscene(id, { replay: true }),
  skipAllCutscenes: (skip = true) => {
    CUTSCENE_DEBUG.skipAll = skip;
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
  // Panic screen (route.phase === 'restart-flash') is the only place these
  // fire — see ui.js's panic screen and route.js's retryFromPanic().
  if (route.phase === 'restart-flash') {
    if (e.code === 'Enter') route.retryFromPanic();
    // No separate menu scene exists yet (MENU is just this same page before
    // its first click-to-fly) — reloading is the simplest correct way back
    // to it, and Escape already force-exits pointer lock regardless.
    if (e.code === 'Escape') window.location.reload();
  }
});

const clock = new THREE.Clock();
let fpsAccum = 0;
let fpsFrames = 0;
let wasPanicking = false; // edge-detects the instant fear.panicActive turns true, to capture the freeze-frame exactly once
let lastWaveIndex = route.waveIndex; // edge-detects a wave completing, to fire that wave's flyover cutscene exactly once
let routeCompleteHandled = false; // edge-detects route.phase reaching 'complete', to fire finale_offering exactly once

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

    if (route.waveIndex !== lastWaveIndex) {
      const completedIndex = lastWaveIndex;
      lastWaveIndex = route.waveIndex;
      const cutsceneId = WAVE_COMPLETE_CUTSCENE[completedIndex];
      if (cutsceneId) gatedCutscene(cutsceneId);
      preloadForWave(route.waveIndex);
    }
    if (!routeCompleteHandled && route.phase === 'complete') {
      routeCompleteHandled = true;
      gatedCutscene(FINALE_CUTSCENE_ID);
    }

    threats.update(dt, gameDt, flight, fear, radio);
    radio.update(dt, fear, route.waveIndex);
    flight.update(gameDt, fear);
    world.update(flight.position, gameDt);
    cockpit.update(flight.stick, fear, gameDt);
    ui.update(flight, fear, dt, threats, radio, route, audio);
    audio.update(dt, fear);
    blackout.style.opacity = fear.panicBlackAlpha;
    postfx.render(dt, fear.normalized);

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
  }
  // state === 'CUTSCENE': loop fully suspended — the cutscene overlay is
  // opaque and covers the whole viewport, so there's nothing to update or
  // render underneath it.

  fpsAccum += dt;
  fpsFrames += 1;
  if (fpsAccum >= 0.4) {
    ui.setFps(fpsFrames / fpsAccum);
    fpsAccum = 0;
    fpsFrames = 0;
  }
});