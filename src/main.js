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
import { Route } from './route.js';

const sceneCanvas = document.getElementById('scene');
const hudCanvas = document.getElementById('hud');
const fpsElement = document.getElementById('fps-counter');
const hint = document.getElementById('pointer-lock-hint');
const blackout = document.getElementById('blackout');

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
const route = new Route(threats, world, radio, fear);

// --- Game state machine: MENU -> FLYING (-> PAUSED later) -----------------
// In MENU, world/flight/cockpit idle-render but fear/radio/threats/route
// never tick and postfx is bypassed entirely (plain renderer.render), so
// nothing "runs" before the player clicks. fear.js's `frozen` flag is the
// other half of this — it blocks the debug [ / ] keys too, since those are
// bound independently of this loop.
let state = 'MENU';

function enterFlying() {
  if (state === 'FLYING') return;
  state = 'FLYING';
  fear.frozen = false;
  hint.classList.add('hidden');
}

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === sceneCanvas;
  // Once flying, the hint must never reappear — even if lock is later lost
  // (e.g. Escape) — since that's exactly how it could end up coexisting
  // with the radio box again. No PAUSED state yet, so this is a one-way door.
  if (state !== 'FLYING') {
    hint.classList.toggle('hidden', locked);
  }
  if (locked) enterFlying();
});

// AudioContext requires a user gesture; reuse the same click that engages
// pointer lock to fly.
sceneCanvas.addEventListener('click', () => audio.resume());

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
}
window.addEventListener('resize', resize);
resize();

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyF') ui.toggleFps();
});

const clock = new THREE.Clock();
let fpsAccum = 0;
let fpsFrames = 0;

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);

  if (state === 'FLYING') {
    // threats.timeScale dips briefly on a clean dodge (satisfying slow-mo);
    // gameplay motion uses gameDt, scheduling/fear/UI/audio stay on real dt.
    const gameDt = dt * threats.timeScale;

    fear.update(dt);
    route.update(dt);
    threats.update(dt, gameDt, flight, fear, radio);
    radio.update(dt, fear);
    flight.update(gameDt, fear);
    world.update(flight.position, gameDt);
    cockpit.update(flight.stick, fear, gameDt);
    ui.update(flight, fear, dt, threats, radio, route);
    audio.update(dt, fear);
    blackout.style.opacity = fear.panicBlackAlpha;
    postfx.render(dt, fear.normalized);
  } else {
    // MENU: world/flight idle so the backdrop isn't a frozen frame, but no
    // fear/radio/threats/route ticking, no HUD, no post-processing.
    flight.update(dt, fear);
    world.update(flight.position, dt);
    cockpit.update(flight.stick, fear, dt);
    renderer.render(scene, camera);
  }

  fpsAccum += dt;
  fpsFrames += 1;
  if (fpsAccum >= 0.4) {
    ui.setFps(fpsFrames / fpsAccum);
    fpsAccum = 0;
    fpsFrames = 0;
  }
});