import { CONFIG as FEAR_CONFIG } from './fear.js';

// Almaty -> Istanbul as 5 fixed-duration waves. All difficulty numbers live
// here so balance tuning is data-only — nothing in threats.js is hardcoded
// per-country; it just reads whatever setWaveConfig() hands it.
export const WAVES = [
  {
    country: 'Kazakhstan',
    duration: 95, // seconds of flight time before the next transition
    missileSpawnMin: 25,
    missileSpawnMax: 35,
    missileCount: 1, // tutorial: exactly one missile, ever, this wave
    missileTurnRate: 45, // degrees/s, gentle
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
    radioIntro: {
      prompt: 'Almaty Center: "...is that an F-22? Sir, please state your intentions."',
      options: ['[funny reply A]', '[funny reply B]', '[funny reply C]'],
    },
  },
  {
    country: 'Caspian / Azerbaijan',
    duration: 100,
    missileSpawnMin: 15,
    missileSpawnMax: 15,
    missileCount: Infinity,
    missileTurnRate: 60,
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
    duration: 105,
    missileSpawnMin: 12,
    missileSpawnMax: 12,
    missileCount: Infinity,
    missileTurnRate: 65,
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
    duration: 110,
    missileSpawnMin: 14,
    missileSpawnMax: 18,
    missileCount: Infinity,
    missileTurnRate: 70,
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
    duration: 120,
    missileSpawnMin: 10,
    missileSpawnMax: 14,
    missileCount: Infinity,
    missileTurnRate: 75,
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
const RESTART_FLASH_DURATION = 2.5; // brief card on a panic restart
const RESTART_CALM_DURATION = 4; // breathing room after a restart
const FINALE_CALM_DURATION = 12; // scripted calm after the last wave, before Stage 7 landing
const RADIO_INTRO_DELAY = 6; // seconds into wave 1 before the tutorial call rings

// Drives country/wave progression: fixed flight time per wave, then an 8s
// transition (big text card + fog/ground retint) before the next one.
export class Route {
  constructor(threats, world, radio, fear) {
    this.threats = threats;
    this.world = world;
    this.radio = radio;
    this.fear = fear;

    this.waveIndex = 0;
    this.waveElapsed = 0;
    this.phase = 'transition'; // 'flying' | 'transition' | 'restart-flash' | 'complete'
    this.transitionTimer = INTRO_CARD_DURATION;
    this.cardText = WAVES[0].country;
    this._isFinalTransition = false;
    this._radioIntroQueued = false;

    // Fear IS the health system now — the only failure/restart trigger is
    // fear hitting 100 (fear.js's panic blackout), not a separate hit
    // counter. onPanic fires the instant it happens (freezes threats for the
    // whole blackout+card+calm span); onPanicResolved fires PANIC_DURATION
    // later, once fear has already been reset, to actually run the restart.
    fear.onPanic = () => this._onPanicStart();
    fear.onPanicResolved = () => this._onPanicResolved();

    threats.forceCalmFor(INTRO_CARD_DURATION);
    this._applyWave(0);
    console.log(`[route] departing ${WAVES[0].country}`);
  }

  update(dt) {
    if (this.phase === 'transition' || this.phase === 'restart-flash') {
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

    if (this.phase === 'complete') return;

    // 'flying'
    this.waveElapsed += dt;

    if (!this._radioIntroQueued && this.waveIndex === 0 && WAVES[0].radioIntro) {
      this._radioIntroQueued = true;
      this.radio.queueIntro(WAVES[0].radioIntro, RADIO_INTRO_DELAY);
    }

    if (this.waveElapsed >= WAVES[this.waveIndex].duration) {
      this._advanceWave();
    }
  }

  _applyWave(index) {
    const wave = WAVES[index];
    this.threats.setWaveConfig(wave);
    this.world.setCountry(wave);
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

  // Fear just crossed 100: freeze the whole blackout -> card -> post-restart
  // calm span in one shot. The 2s blackout itself is fear.js's/main.js's
  // concern (panicActive + the #blackout div + flight.js's existing
  // fail-soft auto-level) — route.js has no separate phase for it.
  _onPanicStart() {
    if (this.phase !== 'flying') return; // already transitioning/complete, ignore
    this.threats.forceCalmFor(FEAR_CONFIG.PANIC_DURATION + RESTART_FLASH_DURATION + RESTART_CALM_DURATION);
  }

  // Blackout just ended (fear already reset to PANIC_RESET_VALUE) — clear
  // whatever was mid-attack and show the panic card.
  _onPanicResolved() {
    if (this.phase !== 'flying') return;
    this.threats.clearAllThreats();
    this.waveElapsed = 0;
    this.phase = 'restart-flash';
    this.transitionTimer = RESTART_FLASH_DURATION;
    this.cardText = 'Ты запаниковал';
    console.log(`[route] panicked — restarting ${WAVES[this.waveIndex].country}`);
  }
}