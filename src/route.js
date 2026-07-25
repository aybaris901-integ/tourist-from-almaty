import { CONFIG as FEAR_CONFIG } from './fear.js';
import RADIO_LINES from './radio_lines.json';

const getLine = (id) => RADIO_LINES.find((l) => l.id === id);

// Almaty -> Istanbul as 5 fixed-duration waves. All difficulty numbers live
// here so balance tuning is data-only — nothing in threats.js is hardcoded
// per-country; it just reads whatever setWaveConfig() hands it.
export const WAVES = [
  {
    country: 'Kazakhstan',
    musicKey: 'kazakhstan', // audio.js's per-country synthesized loop (see setMusicCountry)
    duration: 95, // seconds of flight time before the next transition
    missileSpawnMin: 25,
    missileSpawnMax: 35,
    missileCount: 0, // the generic random spawner is off — scriptedTutorial below drives wave 1's missile(s) directly
    missileTurnRate: 45, // degrees/s, gentle
    missileSpeed: 420, // slower than the 520 default — more time to react to the dodge-window cue
    dodgeWindowEnter: 900, // wider than the 700 default: generous tutorial timing
    dodgeWindowBreak: 650,
    missilesPerSpawn: 1,
    fighterCount: 0,
    fighterCanShoot: false,
    calmMin: 20,
    calmMax: 25,
    activeMin: 40,
    activeMax: 50,
    // fogColor MUST match skyHorizon (same hex) — anything fog-blended (the
    // ground, decor, threats) asymptotically approaches fogColor at range,
    // and the sky texture IS skyHorizon at the horizon line; a mismatch
    // between the two draws a visible seam right where the ground plane
    // ends, no matter how far out the edge is pushed.
    fogColor: 0xe8d9a0,
    groundTint: 0xc9b37b,
    skyTop: '#4a80c9',
    skyHorizon: '#e8d9a0', // warm dusty horizon over the steppe
    decor: 'kazakhstan', // scattered yurts + Big Almaty Lake, see world.js
    // Kazakhstan's whole missile "wave" is this scripted sequence, driven by
    // route.js's _updateTutorial: brief the player, spawn one slow/wide-
    // window missile via threats.spawnScriptedMissile(), and on failure (a
    // forced near-miss — see threats.js's _resolveScriptedFail, never a real
    // hit) retry after retryDelay until they land a genuine dodge. Speed/
    // window multipliers apply on top of this wave's own missileSpeed/
    // dodgeWindowEnter/dodgeWindowBreak above.
    scriptedTutorial: {
      speedMultiplier: 0.7,
      windowMultiplier: 2,
      briefingDelay: 14, // seconds into the wave before the briefing line queues
      missileDelay: 6, // seconds after the briefing line before the missile spawns
      retryDelay: 10, // seconds after a forced near-miss before the next attempt
      lines: { briefing: 'kz_dodge_briefing', success: 'kz_dodge_success', fail: 'kz_dodge_fail' },
    },
  },
  {
    country: 'Caspian / Azerbaijan',
    musicKey: 'azerbaijan',
    duration: 100,
    missileSpawnMin: 15,
    missileSpawnMax: 15,
    missileCount: Infinity,
    missileTurnRate: 60,
    dodgeWindowEnter: 800,
    dodgeWindowBreak: 575,
    missilesPerSpawn: 1,
    fighterCount: 1, // first fighter appears
    fighterCanShoot: false,
    calmMin: 15,
    calmMax: 20,
    activeMin: 30,
    activeMax: 40,
    fogColor: 0x7fa6b0, // sea blue-grey
    groundTint: 0x5c7a88,
  },
  {
    country: 'Georgia',
    musicKey: 'georgia',
    duration: 105,
    missileSpawnMin: 12,
    missileSpawnMax: 12,
    missileCount: Infinity,
    missileTurnRate: 65,
    dodgeWindowEnter: 750,
    dodgeWindowBreak: 525,
    missilesPerSpawn: 1,
    fighterCount: 1,
    fighterCanShoot: true, // gun bursts unlock, stays on for the rest of the route
    calmMin: 12,
    calmMax: 18,
    activeMin: 25,
    activeMax: 35,
    fogColor: 0x7fae7a, // green hills
    groundTint: 0x4c7a45,
  },
  {
    country: 'Turkey — Inland',
    musicKey: 'turkey',
    duration: 110,
    missileSpawnMin: 14,
    missileSpawnMax: 18,
    missileCount: Infinity,
    missileTurnRate: 70,
    dodgeWindowEnter: 700,
    dodgeWindowBreak: 500,
    missilesPerSpawn: 2, // pairs
    fighterCount: 1,
    fighterCanShoot: true,
    calmMin: 8, // tighter calm gaps
    calmMax: 12,
    activeMin: 25,
    activeMax: 30,
    fogColor: 0xb37b5c, // red-brown
    groundTint: 0x8b4c3a,
  },
  {
    country: 'Istanbul Approach',
    musicKey: 'istanbul',
    duration: 120,
    missileSpawnMin: 10,
    missileSpawnMax: 14,
    missileCount: Infinity,
    missileTurnRate: 75,
    dodgeWindowEnter: 650,
    dodgeWindowBreak: 450,
    missilesPerSpawn: 2,
    fighterCount: 2,
    fighterCanShoot: true,
    calmMin: 6,
    calmMax: 10,
    activeMin: 20,
    activeMax: 25,
    fogColor: 0x9fb3c9, // hazy blue
    groundTint: 0x7a93a8,
  },
];

const TRANSITION_DURATION = 8; // guaranteed calm between countries
const INTRO_CARD_DURATION = 5; // first country card at game start
const RESTART_CALM_DURATION = 4; // breathing room once the player retries out of the panic screen
const FINALE_CALM_DURATION = 12; // scripted calm after the last wave, before Stage 7 landing
const RADIO_INTRO_DELAY = 6; // seconds into wave 1 before the tutorial call rings

// Drives country/wave progression: fixed flight time per wave, then an 8s
// transition (big text card + fog/ground retint) before the next one.
export class Route {
  constructor(threats, world, radio, fear, audio) {
    this.threats = threats;
    this.world = world;
    this.radio = radio;
    this.fear = fear;
    this.audio = audio;

    this.waveIndex = 0;
    this.waveElapsed = 0;
    this.phase = 'transition'; // 'flying' | 'transition' | 'restart-flash' | 'complete'
    this.transitionTimer = INTRO_CARD_DURATION;
    this.cardText = WAVES[0].country;
    this._isFinalTransition = false;
    this._radioIntroQueued = false;
    // Kazakhstan's scripted dodge tutorial: 'briefing' -> 'waiting_to_spawn'
    // -> 'active' -> 'done'. See _updateTutorial.
    this._tutorial = WAVES[0].scriptedTutorial
      ? { phase: 'briefing', timer: WAVES[0].scriptedTutorial.briefingDelay }
      : null;

    // Fear IS the health system now — the only failure/restart trigger is
    // fear hitting 100 (fear.js's panic blackout), not a separate hit
    // counter. onPanic fires the instant it happens (freezes threats for the
    // whole blackout+card+calm span); onPanicResolved fires PANIC_DURATION
    // later, once fear has already been reset, to actually run the restart.
    fear.onPanic = () => this._onPanicStart();
    fear.onPanicResolved = () => this._onPanicResolved();
    // Safety valve: fear > 85 with no active threat is an edge case (see
    // fear.js's CONFIG.SAFETY_VALVE_THRESHOLD) — guarantee a radio lifeline
    // rather than let the player panic from nothing.
    fear.onSafetyValve = () => this.radio.forceCallSoon(FEAR_CONFIG.SAFETY_VALVE_CALL_DELAY);

    threats.forceCalmFor(INTRO_CARD_DURATION);
    this._applyWave(0);
    console.log(`[route] departing ${WAVES[0].country}`);
  }

  update(dt, flight) {
    if (this.phase === 'transition') {
      this.transitionTimer -= dt;
      if (this.transitionTimer <= 0) {
        if (this._isFinalTransition) {
          this.phase = 'complete';
          console.log('[route] Istanbul reached — awaiting landing sequence (Stage 7)');
        } else {
          this.phase = 'flying';
          this.waveElapsed = 0;
        }
      }
      return;
    }

    // The panic screen waits indefinitely for the player (Enter/Esc — see
    // main.js), not a timer — but threats still need to stay off for however
    // long that takes, so keep refreshing a short calm window every frame
    // rather than pre-computing one fixed total up front (see
    // retryFromPanic() for the follow-up breathing room once flying resumes).
    if (this.phase === 'restart-flash') {
      this.threats.forceCalmFor(1);
      return;
    }

    if (this.phase === 'complete') return;

    // 'flying'
    this.waveElapsed += dt;

    if (!this._radioIntroQueued && this.waveIndex === 0) {
      this._radioIntroQueued = true;
      this.radio.queueIntro(getLine('kazakhstan_intro'), RADIO_INTRO_DELAY);
    }

    if (this.waveIndex === 0 && this._tutorial) {
      this._updateTutorial(dt, flight);
    }

    if (this.waveElapsed >= WAVES[this.waveIndex].duration) {
      this._advanceWave();
    }
  }

  // Kazakhstan's scripted dodge tutorial: brief once, then spawn/retry a
  // single teach missile until the player lands a genuine dodge (any
  // non-hit resolution — see threats.js's _resolveExpiry), then hand off to
  // wave 1's normal "no more missiles" state (missileCount: 0 means nothing
  // else ever spawns here).
  _updateTutorial(dt, flight) {
    const t = this._tutorial;
    const cfg = WAVES[0].scriptedTutorial;

    if (t.phase === 'briefing') {
      t.timer -= dt;
      if (t.timer <= 0) {
        this.radio.queueIntro(getLine(cfg.lines.briefing), 1);
        t.phase = 'waiting_to_spawn';
        t.timer = cfg.missileDelay;
      }
      return;
    }

    if (t.phase === 'waiting_to_spawn') {
      t.timer -= dt;
      if (t.timer <= 0) {
        this.threats.spawnScriptedMissile(flight, {
          speedMultiplier: cfg.speedMultiplier,
          windowMultiplier: cfg.windowMultiplier,
        });
        t.phase = 'active';
      }
      return;
    }

    if (t.phase === 'active') {
      const result = this.threats.consumeScriptedResult();
      if (result === 'success') {
        this.radio.queueIntro(getLine(cfg.lines.success), 1);
        t.phase = 'done';
      } else if (result === 'fail') {
        this.radio.queueIntro(getLine(cfg.lines.fail), 1);
        t.phase = 'waiting_to_spawn';
        t.timer = cfg.retryDelay;
      }
    }
  }

  _applyWave(index) {
    const wave = WAVES[index];
    this.threats.setWaveConfig(wave);
    this.world.setCountry(wave);
    this.audio.setMusicCountry(wave.musicKey);
  }

  _advanceWave() {
    if (this.waveIndex >= WAVES.length - 1) {
      this._completeRoute();
      return;
    }
    this.waveIndex += 1;
    this.phase = 'transition';
    this.transitionTimer = TRANSITION_DURATION;
    this.cardText = WAVES[this.waveIndex].country;
    this.threats.forceCalmFor(TRANSITION_DURATION);
    this._applyWave(this.waveIndex);
    console.log(`[route] transitioning to ${this.cardText}`);
  }

  _completeRoute() {
    this.phase = 'transition';
    this.transitionTimer = FINALE_CALM_DURATION;
    this.cardText = 'Istanbul';
    this._isFinalTransition = true;
    this.threats.spawningEnabled = false;
    this.threats.forceCalmFor(FINALE_CALM_DURATION);
    console.log('[route] finale cleared — scripted calm before landing');
  }

  // Fear just crossed 100: freeze threats for the 2s blackout itself (fear.js's/
  // main.js's concern — panicActive + the #blackout div + flight.js's existing
  // fail-soft auto-level). The panic SCREEN that follows is indefinite (waits
  // for the player, see update()'s 'restart-flash' branch), so there's no
  // fixed total to pre-compute here anymore — a small buffer is enough to
  // bridge to that per-frame refresh.
  _onPanicStart() {
    if (this.phase !== 'flying') return; // already transitioning/complete, ignore
    this.threats.forceCalmFor(FEAR_CONFIG.PANIC_DURATION + 1);
  }

  // Blackout just ended (fear already reset to PANIC_RESET_VALUE) — clear
  // whatever was mid-attack and show the panic screen. ui.js draws it
  // (title/radio line/buttons); this phase only ends via retryFromPanic().
  _onPanicResolved() {
    if (this.phase !== 'flying') return;
    this.threats.clearAllThreats();
    // clearAllThreats() wipes any in-flight scripted missile without ever
    // resolving through threats.js's _resolveHit/_resolveExpiry, so a
    // mid-sequence tutorial would otherwise be stuck in 'active' forever
    // waiting for a result that will never come. Re-attempt (not a full
    // re-briefing — the player already heard it) rather than leaving it
    // stalled.
    if (this._tutorial && this._tutorial.phase === 'active') {
      this._tutorial.phase = 'waiting_to_spawn';
      this._tutorial.timer = WAVES[0].scriptedTutorial.retryDelay;
    }
    this.phase = 'restart-flash';
    console.log(`[route] panicked — awaiting retry (${WAVES[this.waveIndex].country})`);
  }

  // Player pressed Enter on the panic screen (main.js). Resumes flying the
  // same country (threats already cleared by _onPanicResolved) with a fresh
  // breathing-room calm window now that flying is actually resuming.
  retryFromPanic() {
    if (this.phase !== 'restart-flash') return;
    this.waveElapsed = 0;
    this.phase = 'flying';
    this.threats.forceCalmFor(RESTART_CALM_DURATION);
    console.log(`[route] retrying ${WAVES[this.waveIndex].country}`);
  }
}