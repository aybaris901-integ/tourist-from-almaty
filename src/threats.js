import * as THREE from 'three';
import { randRange, TOON_GRADIENT } from './utils.js';

const FORWARD = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);

const MISSILE_POOL_SIZE = 5; // headroom for wave 4/5 pairs overlapping a straggler
const FIGHTER_POOL_SIZE = 2; // wave 5 wants two concurrent fighters
const PUFF_POOL_SIZE = 4;
const RADAR_ECHO_POOL_SIZE = 5; // matches MISSILE_POOL_SIZE headroom

// All threat tuning in one place, same convention as fear.js's CONFIG.
// Fields also documented as "per-wave" are the fallback/default values used
// before route.js calls setWaveConfig(); route.js's WAVES array overrides
// them per country.
export const CONFIG = {
  // Calm-stretch wave pacing: alternates an active threat phase (missiles/
  // fighters allowed to spawn) with a gap (nothing spawns). No fear side
  // effect here anymore — fear.js's own calm-decay-toward-floor already
  // covers this window (and any other genuinely threat-free moment) via
  // hasActiveThreats() below. (per-wave: calm gap length)
  ACTIVE_MIN: 30,
  ACTIVE_MAX: 50,
  CALM_MIN: 15,
  CALM_MAX: 25,

  // Missiles. (per-wave: spawn interval, turn rate)
  MISSILE_SPAWN_MIN: 12,
  MISSILE_SPAWN_MAX: 20,
  MISSILE_TURN_RATE: 65, // degrees/s, limited so a hard break can force an overshoot
  MISSILE_LOCKON_DURATION: 1.5,
  // Player top speed is BASE_SPEED*THROTTLE_MAX in flight.js (250*1.4 =
  // 350) — kept in sync manually here since flight.js is off-limits to
  // edit (see CLAUDE.md). MISSILE_SPEED must always exceed this: outrunning
  // a missile by throttle alone would make dodging optional, and the whole
  // point of the fear meter is that you dodge by maneuvering, not fleeing.
  PLAYER_MAX_SPEED: 350,
  MISSILE_SPEED: 520,
  // Lifetime is computed per-missile at launch (see _launchMissile), not a
  // fixed constant: life = spawnDist / (MISSILE_SPEED - PLAYER_MAX_SPEED) +
  // MISSILE_LIFETIME_MARGIN. That's the time to close the gap if the player
  // flies dead straight at full throttle the instant the missile launches —
  // guarantees a straight-line flier gets hit instead of the missile timing
  // out first, while a maneuvering player still gets the overshoot/dodge.
  MISSILE_LIFETIME_MARGIN: 2,
  MISSILE_SPAWN_DIST_MIN: 2200,
  MISSILE_SPAWN_DIST_MAX: 2800,
  MISSILE_SPAWN_ANGLE_MIN: 30, // degrees off the nose
  MISSILE_SPAWN_ANGLE_MAX: 120, // both sides — front-side arcs so it visibly crosses the canopy
  MISSILE_SPAWN_ALT_SPREAD: 200, // +/- player altitude
  MISSILE_SCALE: 4, // exaggerated 3-5x real proportions so it reads at 1000+ units, arcade not realism
  MISSILE_HIT_RADIUS: 30,
  MISSILE_CLOSE_RADIUS: 300,
  MISSILE_NEAR_MISS_RADIUS: 120, // closest-approach below this = scary near-miss, not a "clean" dodge
  MISSILE_DODGE_RADIUS: 500,
  MISSILE_TRAIL_LENGTH: 7, // pooled puffs per missile
  MISSILE_TRAIL_SAMPLE_INTERVAL: 0.045, // seconds between recorded trail points
  RADAR_RANGE: 3000, // ui.js's heading-up radar; also the fighter cutoff below
  RADAR_ZOOM_RANGE: 1500, // ui.js lerps to this tighter range once a missile is close
  RADAR_ZOOM_TRIGGER_DIST: 1200,
  // Separate from the 3D exhaust trail above (MISSILE_TRAIL_LENGTH), which
  // only spans ~0.3s and lives in world space near the mesh. This is a
  // longer, radar-only history of recent positions so the 2D dot on the HUD
  // shows where the missile has BEEN, independent of how the 3D view reads.
  RADAR_TRAIL_DURATION: 1.5,
  RADAR_TRAIL_SAMPLE_INTERVAL: 0.08,
  // How long an expired missile's radar dot flashes grey and fades — the
  // only on-radar confirmation that a dodge/near-miss/clean expiry just
  // happened, since the 3D puff can be off-screen or hard to place.
  RADAR_ECHO_DURATION: 1,

  // Dodge-window telegraph (per-wave: dodgeWindowEnter/dodgeWindowBreak,
  // missileSpeed): tells the player exactly when a hard break will work,
  // instead of leaving the timing a guess. Entering DODGE_WINDOW_ENTER
  // starts a distinct rising tone + a pulsing radar dot; crossing
  // DODGE_WINDOW_BREAK flashes the "BREAK!" crosshair cue. These are the
  // fallback defaults; route.js's WAVES widens/slows wave 1 and tightens
  // later waves.
  DODGE_WINDOW_ENTER: 700,
  DODGE_WINDOW_BREAK: 500,
  // Forgiving dodge check: from the moment the window opens, ANY hard yank
  // of the stick — roll or pitch, either direction — permanently breaks the
  // missile's lock (see _updateDodgeWindow/_updatePlayerAngularState).
  // Deliberately not a "turn correctly" check: a new player doesn't know
  // which way is right, so any decisive input counts, with one exception —
  // swinging the nose INTO the missile's own flight direction (within
  // DODGE_INTO_MISSILE_EXCLUDE_DEG) doesn't count, since that's turning
  // toward its path, not away from it, and shouldn't read as evasion.
  DODGE_ANGULAR_VELOCITY_THRESHOLD: 90, // deg/s, combined roll-rate + pitch-rate magnitude
  DODGE_INTO_MISSILE_EXCLUDE_DEG: 15,

  // Kazakhstan's scripted first missile (see route.js/spawnScriptedMissile):
  // it can never actually hit — failing to dodge in time forces a big,
  // harmless near-miss instead, so onboarding never costs a real hit.
  SCRIPTED_MISSILE_LIFETIME: 18, // fixed, not the geometric formula: this missile can be slower than the player, which that formula assumes never happens
  SCRIPTED_FAIL_FEAR: 20,

  FEAR_LOCKON_PER_SEC: 6,
  FEAR_CLOSE_PER_SEC: 12,
  FEAR_NEAR_MISS_INSTANT: 15,
  FEAR_DODGE_INSTANT: 12,
  FEAR_HIT_INSTANT: 45, // fear IS the health system — no separate hit counter/HP bar

  TUMBLE_DURATION: 2,
  IMPACT_SHAKE_DURATION: 0.6,
  IMPACT_SHAKE_MAG: 0.5,
  // A hit threatens the fear-100 panic/restart now, so it must guarantee
  // counterplay: a window with no NEW lock-ons so the player can claw fear
  // back down (radio, calm stretch) instead of getting chain-locked into
  // panic off a single bad moment.
  POST_HIT_LOCK_IMMUNITY: 3,

  SLOWMO_SCALE: 0.25,
  SLOWMO_DURATION: 0.3,
  SLOWMO_RECOVER_TIME: 0.35,

  PUFF_DURATION: 0.4,
  PUFF_MAX_SCALE: 60,

  // Fighter: presence + (from Georgia on) short gun bursts. (per-wave: count)
  FIGHTER_SPAWN_MIN: 20,
  FIGHTER_SPAWN_MAX: 35,
  FIGHTER_LIFETIME_MIN: 25,
  FIGHTER_LIFETIME_MAX: 40,
  FIGHTER_ORBIT_MIN: 500,
  FIGHTER_ORBIT_MAX: 900,
  FIGHTER_ORBIT_SPEED: 0.12,
  FIGHTER_STEER_RATE: 0.6,
  FIGHTER_VISIBLE_RANGE: 3000,
  FEAR_FIGHTER_PER_SEC: 3,

  // Gun bursts (per-wave: enabled via fighterCanShoot). A hit is deliberately
  // lighter than a missile hit: shorter tumble/shake, and +10 fear instead
  // of +45 — still a real threat over multiple bursts, not a one-shot.
  GUN_BURST_INTERVAL_MIN: 3,
  GUN_BURST_INTERVAL_MAX: 6,
  GUN_HIT_CHANCE: 0.3,
  FEAR_GUN_NEAR_MISS_INSTANT: 8,
  FEAR_GUN_HIT_INSTANT: 10,
  GUN_HIT_TUMBLE_DURATION: 1,
  GUN_HIT_IMPACT_SHAKE_DURATION: 0.3,
  GUN_HIT_IMPACT_SHAKE_MAG: 0.25,
};

function createMissileMesh() {
  const geo = new THREE.ConeGeometry(4 * CONFIG.MISSILE_SCALE, 20 * CONFIG.MISSILE_SCALE, 8);
  geo.rotateX(-Math.PI / 2); // apex now points local -Z, aligned with FORWARD
  const mat = new THREE.MeshToonMaterial({ color: 0xdd2222, gradientMap: TOON_GRADIENT, fog: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.visible = false;
  return mesh;
}

// Single shared soft-dot texture for every trail puff (one canvas, one
// texture — cheap); each puff still gets its own SpriteMaterial instance so
// opacity/color can differ per-puff (a shared material can't do that).
let _trailTexture = null;
function getTrailTexture() {
  if (_trailTexture) return _trailTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,250,235,0.9)');
  g.addColorStop(0.5, 'rgba(255,250,235,0.35)');
  g.addColorStop(1, 'rgba(255,250,235,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  _trailTexture = new THREE.CanvasTexture(canvas);
  return _trailTexture;
}

function createTrailPuff() {
  const mat = new THREE.SpriteMaterial({
    map: getTrailTexture(),
    color: 0xfff5e0, // bright warm-white, reads as exhaust/smoke against the sky
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: true,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.visible = false;
  return sprite;
}

function createFighterMesh() {
  const geo = new THREE.BoxGeometry(30, 12, 40);
  const mat = new THREE.MeshToonMaterial({ color: 0x777d85, gradientMap: TOON_GRADIENT, fog: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.visible = false;
  return mesh;
}

function createPuffMesh() {
  const geo = new THREE.SphereGeometry(1, 8, 6);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.visible = false;
  return mesh;
}

export class Threats {
  constructor(scene, audio) {
    this.audio = audio;
    this.timeScale = 1;
    this.spawningEnabled = true;

    this._slowmoHold = 0;
    this._slowmoRecover = 0;
    this._lockImmuneTimer = 0; // ticks down after any hit; blocks new lock-ons while > 0

    this._wavePhase = 'active';
    this._calmMin = CONFIG.CALM_MIN;
    this._calmMax = CONFIG.CALM_MAX;
    this._activeMin = CONFIG.ACTIVE_MIN;
    this._activeMax = CONFIG.ACTIVE_MAX;
    this._waveTimer = randRange(this._activeMin, this._activeMax);

    this._missileSpawnMin = CONFIG.MISSILE_SPAWN_MIN;
    this._missileSpawnMax = CONFIG.MISSILE_SPAWN_MAX;
    this._missileTurnRate = THREE.MathUtils.degToRad(CONFIG.MISSILE_TURN_RATE);
    this._missileSpeed = CONFIG.MISSILE_SPEED;
    this._dodgeWindowEnter = CONFIG.DODGE_WINDOW_ENTER;
    this._dodgeWindowBreak = CONFIG.DODGE_WINDOW_BREAK;
    this._missilesPerSpawn = 1;
    this._maxMissilesThisWave = Infinity;
    this._missilesThisWave = 0;
    this._nextMissileTimer = randRange(this._missileSpawnMin, this._missileSpawnMax);
    this._breakCuePending = false; // one-shot flag, drained by ui.js via consumeBreakCue()
    this._scriptedResult = null; // one-shot 'success'|'fail', drained by route.js via consumeScriptedResult()
    this.dodgeCount = 0; // total successful dodges this session — ui.js drops the BREAK cue's arrows past 3

    // Player angular-velocity tracking for the forgiving dodge check (see
    // _updatePlayerAngularState/_updateDodgeWindow) — frame-to-frame deltas
    // of flight.roll/pitch/forward, since flight.js exposes positions, not
    // rates.
    this._prevRoll = 0;
    this._prevPitch = 0;
    this._prevForward = new THREE.Vector3(0, 0, -1);
    this._headingDelta = new THREE.Vector3();
    this._headingDeltaValid = false;
    this._angularVelDeg = 0;

    this._maxFighters = 0;
    this._fighterCanShoot = false;

    this._missiles = Array.from({ length: MISSILE_POOL_SIZE }, () => ({
      mesh: createMissileMesh(),
      trail: Array.from({ length: CONFIG.MISSILE_TRAIL_LENGTH }, () => createTrailPuff()),
      trailHistory: [],
      trailTimer: 0,
      radarTrailHistory: [], // { pos: Vector3, age: seconds since sampled }, oldest-last
      radarTrailTimer: 0,
      active: false,
      state: 'idle',
      lockTimer: 0,
      lifeTimer: 0,
      spawnPos: new THREE.Vector3(),
      position: new THREE.Vector3(),
      direction: new THREE.Vector3(),
      minDistance: Infinity,
      dodgeWindowState: 'none', // 'none' -> 'entered' -> 'broken', see _updateDodgeWindow
      lockLost: false, // set once a hard turn is detected inside the dodge window; freezes homing
      scripted: false, // Kazakhstan's scripted tutorial missile — see spawnScriptedMissile
      scriptedSpeed: 0,
      scriptedWindowEnter: 0,
      scriptedWindowBreak: 0,
    }));
    for (const m of this._missiles) {
      scene.add(m.mesh);
      for (const s of m.trail) scene.add(s);
    }

    this._puffs = Array.from({ length: PUFF_POOL_SIZE }, () => ({
      mesh: createPuffMesh(),
      active: false,
      timer: 0,
      duration: 0,
    }));

    // Radar-only "echo" markers: no 3D mesh, just a world position + timer
    // that ui.js's radar draws as a fading grey dot when a missile expires
    // (see _resolveExpiry / _spawnRadarEcho).
    this._radarEchoes = Array.from({ length: RADAR_ECHO_POOL_SIZE }, () => ({
      active: false,
      timer: 0,
      position: new THREE.Vector3(),
    }));
    for (const p of this._puffs) scene.add(p.mesh);

    this._fighters = Array.from({ length: FIGHTER_POOL_SIZE }, () => ({
      mesh: createFighterMesh(),
      active: false,
      spawnTimer: randRange(CONFIG.FIGHTER_SPAWN_MIN, CONFIG.FIGHTER_SPAWN_MAX),
      lifeTimer: 0,
      orbitAngle: 0,
      orbitRadius: 0,
      prevPos: new THREE.Vector3(),
      burstTimer: 0,
      inFront: false, // mirrors _updateFighters' local `inFront`, so hasActiveThreats() can read it
    }));
    for (const f of this._fighters) scene.add(f.mesh);
  }

  // Called by route.js at every country transition (and left untouched on a
  // same-wave restart, since threats._restartCountry already resets what
  // that needs). All per-wave difficulty numbers live in route.js's WAVES.
  setWaveConfig(wave) {
    this._missileSpawnMin = wave.missileSpawnMin;
    this._missileSpawnMax = wave.missileSpawnMax;
    this._missileTurnRate = THREE.MathUtils.degToRad(wave.missileTurnRate);
    this._missileSpeed = wave.missileSpeed ?? CONFIG.MISSILE_SPEED;
    this._dodgeWindowEnter = wave.dodgeWindowEnter ?? CONFIG.DODGE_WINDOW_ENTER;
    this._dodgeWindowBreak = wave.dodgeWindowBreak ?? CONFIG.DODGE_WINDOW_BREAK;
    this._missilesPerSpawn = wave.missilesPerSpawn || 1;
    this._maxMissilesThisWave = wave.missileCount ?? Infinity;
    this._missilesThisWave = 0;
    this._nextMissileTimer = randRange(this._missileSpawnMin, this._missileSpawnMax);

    this._maxFighters = wave.fighterCount ?? 0;
    this._fighterCanShoot = !!wave.fighterCanShoot;

    this._calmMin = wave.calmMin;
    this._calmMax = wave.calmMax;
    this._activeMin = wave.activeMin;
    this._activeMax = wave.activeMax;
  }

  // Entering calm (natural gap, forced transition, or restart) clears any
  // active fighter immediately — they're presence-only with no resolution
  // tied to natural expiry, and their lifetime can outlast the calm window,
  // so leaving one up would silently break the "no threats" guarantee (and
  // keep ticking fighter-presence fear). An in-flight missile is left alone
  // to resolve naturally (hit/dodge/near-miss) — its bounded 8s lifetime
  // fits inside any calm window this short, so cutting it off would only
  // rob the player of a dodge payoff without buying anything.
  _enterCalm(duration) {
    this._wavePhase = 'calm';
    this._waveTimer = duration;
    for (const f of this._fighters) {
      f.active = false;
      f.mesh.visible = false;
    }
  }

  // route.js uses this to guarantee a calm window (country transitions,
  // post-restart breathing room) regardless of whatever timer was running.
  forceCalmFor(seconds) {
    this._enterCalm(seconds);
  }

  update(dt, gameDt, flight, fear, radio) {
    if (this._lockImmuneTimer > 0) this._lockImmuneTimer -= dt;
    this._updateSlowmo(dt);
    this._updateWave(dt);

    if (this._wavePhase !== 'calm') {
      this._updateMissileSpawning(dt, flight);
    }

    this._updateMissiles(dt, gameDt, flight, fear, radio);
    this._updateFighters(dt, gameDt, flight, fear);
    this._updatePuffs(gameDt);
    this._updateRadarEchoes(gameDt);
  }

  _updateSlowmo(dt) {
    if (this._slowmoHold > 0) {
      this._slowmoHold -= dt;
      this.timeScale = CONFIG.SLOWMO_SCALE;
    } else if (this._slowmoRecover > 0) {
      this._slowmoRecover -= dt;
      const t = THREE.MathUtils.clamp(1 - this._slowmoRecover / CONFIG.SLOWMO_RECOVER_TIME, 0, 1);
      this.timeScale = THREE.MathUtils.lerp(CONFIG.SLOWMO_SCALE, 1, t);
    } else {
      this.timeScale = 1;
    }
  }

  _triggerSlowmo() {
    this._slowmoHold = CONFIG.SLOWMO_DURATION;
    this._slowmoRecover = CONFIG.SLOWMO_RECOVER_TIME;
  }

  _updateWave(dt) {
    // Once spawning is permanently disabled (route.js's post-finale scripted
    // calm), freeze in whatever phase forceCalmFor set — otherwise this would
    // eventually flip back to 'active' and silently stop draining fear.
    if (!this.spawningEnabled) return;

    this._waveTimer -= dt;
    if (this._waveTimer > 0) return;

    if (this._wavePhase === 'active') {
      this._enterCalm(randRange(this._calmMin, this._calmMax));
      console.log('[threats] calm stretch begins');
    } else {
      this._wavePhase = 'active';
      this._waveTimer = randRange(this._activeMin, this._activeMax);
      console.log('[threats] active phase begins');
    }
  }

  _updateMissileSpawning(dt, flight) {
    if (!this.spawningEnabled) return;
    if (this._missilesThisWave >= this._maxMissilesThisWave) return;
    // Post-hit counterplay window: no NEW lock-ons while immune (timer just
    // holds where it was, so the player gets the full normal interval once
    // immunity lapses rather than an instant spawn).
    if (this._lockImmuneTimer > 0) return;

    this._nextMissileTimer -= dt;
    if (this._nextMissileTimer > 0) return;

    const count = Math.min(this._missilesPerSpawn, this._maxMissilesThisWave - this._missilesThisWave);
    for (let i = 0; i < count; i++) {
      const slot = this._missiles.find((m) => !m.active);
      if (!slot) break;
      this._beginLockOn(slot, flight);
      this._missilesThisWave += 1;
    }
    this._nextMissileTimer = randRange(this._missileSpawnMin, this._missileSpawnMax);
  }

  _beginLockOn(slot, flight) {
    // Front-side arcs (30-120 deg off the nose, either side) so the homing
    // approach crosses the player's actual forward view instead of chasing
    // in from behind, where the cockpit literally cannot see it — that was
    // the readability bug: the missile was never on-screen until it was
    // already on top of the player.
    const side = Math.random() < 0.5 ? 1 : -1;
    const angleRad = side * THREE.MathUtils.degToRad(randRange(CONFIG.MISSILE_SPAWN_ANGLE_MIN, CONFIG.MISSILE_SPAWN_ANGLE_MAX));
    const bearingDir = flight.forward.clone().setY(0).normalize().applyAxisAngle(UP, angleRad);
    const spawnDist = randRange(CONFIG.MISSILE_SPAWN_DIST_MIN, CONFIG.MISSILE_SPAWN_DIST_MAX);

    slot.spawnPos.copy(flight.position).addScaledVector(bearingDir, spawnDist);
    slot.spawnPos.y = THREE.MathUtils.clamp(
      flight.position.y + randRange(-CONFIG.MISSILE_SPAWN_ALT_SPREAD, CONFIG.MISSILE_SPAWN_ALT_SPREAD),
      400,
      4200
    );

    slot.active = true;
    slot.state = 'lockon';
    slot.lockTimer = CONFIG.MISSILE_LOCKON_DURATION;
    slot.minDistance = Infinity;
    slot.trailHistory.length = 0;
    slot.trailTimer = 0;
    slot.radarTrailHistory.length = 0;
    slot.radarTrailTimer = 0;
    slot.dodgeWindowState = 'none';
    slot.lockLost = false;
    slot.scripted = false;

    this.audio.startLockTone();
    console.log('[threats] lock-on warning');
  }

  // route.js drives Kazakhstan's scripted dodge tutorial through this
  // instead of the generic random-timer spawner (that wave's missileCount
  // is 0). Overrides this one missile's speed and dodge-window thresholds
  // relative to whatever the wave's own values are (see setWaveConfig) — the
  // multipliers are the wave's scriptedTutorial config in route.js.
  spawnScriptedMissile(flight, { speedMultiplier, windowMultiplier }) {
    const slot = this._missiles.find((m) => !m.active);
    if (!slot) return;
    this._beginLockOn(slot, flight);
    slot.scripted = true;
    slot.scriptedSpeed = this._missileSpeed * speedMultiplier;
    slot.scriptedWindowEnter = this._dodgeWindowEnter * windowMultiplier;
    slot.scriptedWindowBreak = this._dodgeWindowBreak * windowMultiplier;
  }

  // One-shot result drained by route.js's tutorial state machine — null
  // while the scripted missile is still in flight (or none has spawned
  // yet), 'success' or 'fail' the frame it resolves.
  consumeScriptedResult() {
    const result = this._scriptedResult;
    this._scriptedResult = null;
    return result;
  }

  _launchMissile(m, flight) {
    m.state = 'homing';
    if (m.scripted) {
      // Fixed, not the geometric formula — a slow scripted missile can be
      // slower than the player, which that formula assumes never happens.
      m.lifeTimer = CONFIG.SCRIPTED_MISSILE_LIFETIME;
    } else {
      const spawnDist = m.spawnPos.distanceTo(flight.position);
      m.lifeTimer = spawnDist / (this._missileSpeed - CONFIG.PLAYER_MAX_SPEED) + CONFIG.MISSILE_LIFETIME_MARGIN;
    }
    m.position.copy(m.spawnPos);
    m.direction.copy(flight.position).sub(m.position).normalize();
    m.mesh.position.copy(m.position);
    m.mesh.quaternion.setFromUnitVectors(FORWARD, m.direction);
    m.mesh.visible = true;
    this.audio.stopLockTone();
    console.log('[threats] missile launched');
  }

  // Stereo pan for a world position, from the player's own heading (not
  // compass): +1 = hard right, -1 = hard left. localRight/dist IS sin(the
  // bearing angle) for a vector decomposed into an orthonormal right/forward
  // frame, so this needs no acos/atan2 round-trip to match "90 deg left =
  // fully left channel."
  _panFor(worldPos, flight, flatRight) {
    const rel = worldPos.clone().sub(flight.position);
    rel.y = 0;
    const dist = rel.length();
    if (dist < 1) return 0;
    return THREE.MathUtils.clamp(rel.dot(flatRight) / dist, -1, 1);
  }

  // Solves the classic pursuit-triangle quadratic for the time at which a
  // `speed`-fast missile starting at missilePos would meet the player if the
  // player held their current velocity (flight.forward * flight.speed)
  // indefinitely: |delta + v*t| = speed*t, i.e.
  // (v.v - s^2)t^2 + 2(delta.v)t + delta.delta = 0. For a normal missile
  // (always faster than the player's max speed) a real positive root always
  // exists (verified: a<0, c>=0 => roots have opposite sign, so exactly one
  // positive root when delta != 0); the scripted tutorial missile can be
  // SLOWER than the player (a>=0), where that guarantee doesn't hold, hence
  // the `<= 0` guard falling back to interceptTime=0 (aim at raw position).
  _leadIntercept(missilePos, flight, speed) {
    const playerVel = flight.forward.clone().multiplyScalar(flight.speed);
    const delta = flight.position.clone().sub(missilePos);
    const a = playerVel.lengthSq() - speed * speed;
    const b = 2 * delta.dot(playerVel);
    const c = delta.lengthSq();
    const disc = b * b - 4 * a * c;
    let interceptTime = 0;
    if (disc >= 0 && Math.abs(a) > 1e-6) {
      const sq = Math.sqrt(disc);
      const t1 = (-b + sq) / (2 * a);
      const t2 = (-b - sq) / (2 * a);
      if (t1 > 0 && t2 > 0) interceptTime = Math.min(t1, t2);
      else if (t1 > 0) interceptTime = t1;
      else if (t2 > 0) interceptTime = t2;
    }
    return flight.position.clone().addScaledVector(playerVel, interceptTime);
  }

  // Frame-to-frame angular-velocity tracking for the forgiving dodge check.
  // flight.js exposes roll/pitch/forward as positions, not rates, so the
  // rate has to be diffed here — computed once per frame (not once per
  // missile) and read by every missile's _updateDodgeWindow call this frame.
  _updatePlayerAngularState(dt, flight) {
    if (dt <= 0) return;
    const rollRate = (flight.roll - this._prevRoll) / dt;
    const pitchRate = (flight.pitch - this._prevPitch) / dt;
    this._angularVelDeg = THREE.MathUtils.radToDeg(Math.hypot(rollRate, pitchRate));

    this._headingDelta.copy(flight.forward).sub(this._prevForward);
    this._headingDeltaValid = this._headingDelta.lengthSq() > 1e-10;
    if (this._headingDeltaValid) this._headingDelta.normalize();

    this._prevRoll = flight.roll;
    this._prevPitch = flight.pitch;
    this._prevForward.copy(flight.forward);
  }

  // Dodge-window telegraph: as a homing missile closes past its dodge-window
  // enter range, cue the player (rising tone; getRadarContacts' flag lets
  // ui.js pulse the dot) — past the break range, flash the crosshair
  // "BREAK!" cue once (ui.js drains it via consumeBreakCue()). From the
  // moment the window opens, ANY hard yank of the stick (roll or pitch,
  // either direction — see _updatePlayerAngularState) sets lockLost, which
  // the homing loop uses to stop correcting entirely for the rest of this
  // missile's life. The one exception: swinging the nose INTO the missile's
  // own flight direction doesn't count (see DODGE_INTO_MISSILE_EXCLUDE_DEG).
  _updateDodgeWindow(m, dist) {
    const enterRange = m.scripted ? m.scriptedWindowEnter : this._dodgeWindowEnter;
    const breakRange = m.scripted ? m.scriptedWindowBreak : this._dodgeWindowBreak;

    if (m.dodgeWindowState === 'none' && dist <= enterRange) {
      m.dodgeWindowState = 'entered';
      this.audio.playDodgeCue();
    }
    if (m.dodgeWindowState === 'entered' && dist <= breakRange) {
      m.dodgeWindowState = 'broken';
      this._breakCuePending = true;
    }

    if (m.lockLost || m.dodgeWindowState === 'none') return;
    if (this._angularVelDeg < CONFIG.DODGE_ANGULAR_VELOCITY_THRESHOLD) return;
    if (this._headingDeltaValid) {
      const towardMissileDeg = THREE.MathUtils.radToDeg(this._headingDelta.angleTo(m.direction));
      if (towardMissileDeg <= CONFIG.DODGE_INTO_MISSILE_EXCLUDE_DEG) return;
    }
    m.lockLost = true;
  }

  // One-shot flag drained by ui.js each frame — true at most once per
  // missile crossing into the "BREAK!" range.
  consumeBreakCue() {
    const pending = this._breakCuePending;
    this._breakCuePending = false;
    return pending;
  }

  _updateMissiles(dt, gameDt, flight, fear, radio) {
    this._updatePlayerAngularState(dt, flight);
    let anyLockOn = false;
    const flatForward = flight.forward.clone().setY(0).normalize();
    const flatRight = flatForward.clone().cross(UP);
    // Only the nearest lock-on and nearest homing missile drive audio — one
    // beep and one ping, not a chorus, same "most urgent threat wins"
    // simplification the old single-lock-tone system already assumed.
    let nearestLockOn = null;
    let nearestHoming = null;

    for (const m of this._missiles) {
      if (!m.active) continue;

      if (m.state === 'lockon') {
        anyLockOn = true;
        fear.addContinuous('missile-lockon', CONFIG.FEAR_LOCKON_PER_SEC, dt);
        m.lockTimer -= dt;
        const dist = m.spawnPos.distanceTo(flight.position);
        if (!nearestLockOn || dist < nearestLockOn.dist) {
          nearestLockOn = { dist, progress: 1 - m.lockTimer / CONFIG.MISSILE_LOCKON_DURATION, pan: this._panFor(m.spawnPos, flight, flatRight) };
        }
        if (m.lockTimer <= 0) this._launchMissile(m, flight);
        continue;
      }

      const speed = m.scripted ? m.scriptedSpeed : this._missileSpeed;

      // Dodge-window telegraph + lock-loss check, using last frame's
      // distance (this frame's hasn't been computed yet) so the cue lands on
      // the same frame the player would perceive the threshold being crossed.
      this._updateDodgeWindow(m, m.position.distanceTo(flight.position));

      // Homing: turn-rate-limited pursuit of a PREDICTED intercept point, not
      // the player's raw current position. Pure pursuit (chasing "where they
      // are right now") needs ever-tighter curvature as the gap closes, and
      // at a bounded turn rate that can fail to converge at all for some
      // spawn geometries — verified by simulating this exact loop offline:
      // wave 1's 45deg/s turn rate never caught a dead-straight flier from
      // some spawn angles, no matter how long the missile's lifetime was.
      // Leading the target keeps the required turn budget roughly constant
      // through the whole chase, which is what actually makes "fly straight
      // = get hit" true. this._leadIntercept solves the classic
      // closing-triangle quadratic each frame using the player's current
      // velocity; it falls back to the player's raw position (old behavior)
      // if no positive-time solution exists.
      // Once lockLost (a hard yank during the dodge window, see
      // _updateDodgeWindow), turning stops entirely — the missile just keeps
      // its current heading, which is what turns "overshoot" from "usually"
      // into "guaranteed" for a player who breaks on cue.
      if (!m.lockLost) {
        const desired = this._leadIntercept(m.position, flight, speed).sub(m.position).normalize();
        const angle = m.direction.angleTo(desired);
        if (angle > 1e-4) {
          const axis = new THREE.Vector3().crossVectors(m.direction, desired);
          if (axis.lengthSq() > 1e-8) {
            axis.normalize();
            const turn = Math.min(angle, this._missileTurnRate * gameDt);
            m.direction.applyAxisAngle(axis, turn).normalize();
          }
        }
      }
      m.position.addScaledVector(m.direction, speed * gameDt);
      m.mesh.position.copy(m.position);
      m.mesh.quaternion.setFromUnitVectors(FORWARD, m.direction);
      m.lifeTimer -= gameDt;
      this._updateTrail(m, gameDt);
      this._updateRadarTrail(m, gameDt);

      const dist = m.position.distanceTo(flight.position);
      m.minDistance = Math.min(m.minDistance, dist);

      if (!nearestHoming || dist < nearestHoming.dist) {
        const proximity = 1 - THREE.MathUtils.clamp(dist / CONFIG.MISSILE_SPAWN_DIST_MAX, 0, 1);
        nearestHoming = { dist, proximity, pan: this._panFor(m.position, flight, flatRight) };
      }

      if (dist < CONFIG.MISSILE_HIT_RADIUS) {
        this._resolveHit(m, flight, fear);
        continue;
      }
      if (dist < CONFIG.MISSILE_CLOSE_RADIUS) {
        fear.addContinuous('missile-close', CONFIG.FEAR_CLOSE_PER_SEC, dt);
      }
      if (m.lifeTimer <= 0) {
        this._resolveExpiry(m, fear, radio);
      }
    }

    if (nearestLockOn) this.audio.updateLockTone(nearestLockOn.progress, nearestLockOn.pan);
    if (!anyLockOn) this.audio.stopLockTone();

    if (nearestHoming) {
      this.audio.startApproachPing();
      this.audio.updateApproachPing(nearestHoming.pan, nearestHoming.proximity);
    } else {
      this.audio.stopApproachPing();
    }
  }

  // Pooled smoke trail: samples the missile's position at a fixed interval
  // (not every frame — that would bunch puffs on top of each other at high
  // speed) into a small history buffer, then maps history[i] onto trail
  // sprite[i] every frame so newer puffs stay bright/small near the nose and
  // older ones fade out and grow, like dispersing exhaust. This (not the
  // tiny bare cone) is what makes a missile readable at range.
  _updateTrail(m, gameDt) {
    m.trailTimer -= gameDt;
    if (m.trailTimer <= 0) {
      m.trailTimer = CONFIG.MISSILE_TRAIL_SAMPLE_INTERVAL;
      m.trailHistory.unshift(m.position.clone());
      if (m.trailHistory.length > CONFIG.MISSILE_TRAIL_LENGTH) m.trailHistory.length = CONFIG.MISSILE_TRAIL_LENGTH;
    }

    // Doubled from the first pass (was 3.5/8.5 near/far, 0.65 peak opacity):
    // with the HUD edge marker suppressed once a missile is on-screen (see
    // getBearings/ui.js), the trail is the ONLY thing carrying it — it has
    // to read on its own, not just as a supporting detail next to a marker.
    const puffNear = 7 * CONFIG.MISSILE_SCALE;
    const puffFar = 17 * CONFIG.MISSILE_SCALE;
    for (let i = 0; i < m.trail.length; i++) {
      const sprite = m.trail[i];
      const histPos = m.trailHistory[i];
      if (!histPos) {
        sprite.visible = false;
        continue;
      }
      const t = i / CONFIG.MISSILE_TRAIL_LENGTH; // 0 = newest (at the missile), 1 = oldest
      sprite.visible = true;
      sprite.position.copy(histPos);
      sprite.material.opacity = (1 - t) * 0.85;
      sprite.scale.setScalar(THREE.MathUtils.lerp(puffNear, puffFar, t));
    }
  }

  // Radar-only position history, independent of the 3D exhaust trail above:
  // ages every recorded sample every frame and drops anything past
  // RADAR_TRAIL_DURATION, so ui.js's radar can draw a ~1.5s fading path for
  // the dot regardless of what the 3D trail (which only spans ~0.3s) is doing.
  _updateRadarTrail(m, gameDt) {
    for (const p of m.radarTrailHistory) p.age += gameDt;
    while (m.radarTrailHistory.length && m.radarTrailHistory[m.radarTrailHistory.length - 1].age > CONFIG.RADAR_TRAIL_DURATION) {
      m.radarTrailHistory.pop();
    }
    m.radarTrailTimer -= gameDt;
    if (m.radarTrailTimer <= 0) {
      m.radarTrailTimer = CONFIG.RADAR_TRAIL_SAMPLE_INTERVAL;
      m.radarTrailHistory.unshift({ pos: m.position.clone(), age: 0 });
    }
  }

  // Radar-only fading marker left behind when a missile expires (dodge,
  // near-miss, or clean) — the only on-radar confirmation that the missile
  // is gone and didn't just fly off the edge of the display.
  _spawnRadarEcho(position) {
    const slot = this._radarEchoes.find((e) => !e.active) || this._radarEchoes[0];
    slot.active = true;
    slot.timer = CONFIG.RADAR_ECHO_DURATION;
    slot.position.copy(position);
  }

  _updateRadarEchoes(gameDt) {
    for (const e of this._radarEchoes) {
      if (!e.active) continue;
      e.timer -= gameDt;
      if (e.timer <= 0) e.active = false;
    }
  }

  _resolveHit(m, flight, fear) {
    if (m.scripted) {
      this._resolveScriptedFail(m, flight, fear);
      return;
    }
    fear.addInstant('missile-hit', CONFIG.FEAR_HIT_INSTANT);
    flight.triggerTumble(CONFIG.TUMBLE_DURATION);
    flight.triggerImpactShake(CONFIG.IMPACT_SHAKE_DURATION, CONFIG.IMPACT_SHAKE_MAG);
    this.audio.playImpactThud();
    this._spawnPuff(m.position, 0xffb066);
    this._despawnMissile(m);
    this._lockImmuneTimer = CONFIG.POST_HIT_LOCK_IMMUNITY;

    console.log('[threats] HIT');
  }

  // Kazakhstan's scripted first missile can never actually hit — failing to
  // dodge in time instead forces a big, scary-but-harmless near-miss (shake
  // + fear, no tumble) so a brand-new player never eats a real hit during
  // onboarding. route.js reads the result via consumeScriptedResult() and
  // schedules a retry.
  _resolveScriptedFail(m, flight, fear) {
    fear.addInstant('scripted-tutorial-fail', CONFIG.SCRIPTED_FAIL_FEAR);
    flight.triggerImpactShake(CONFIG.IMPACT_SHAKE_DURATION, CONFIG.IMPACT_SHAKE_MAG);
    this.audio.playImpactThud();
    this._spawnPuff(m.position, 0xff6644);
    this._spawnRadarEcho(m.position);
    this._scriptedResult = 'fail';
    this._despawnMissile(m);
    console.log('[threats] scripted tutorial: forced near-miss (no dodge)');
  }

  _resolveExpiry(m, fear, radio) {
    const scripted = m.scripted;
    if (m.minDistance <= CONFIG.MISSILE_NEAR_MISS_RADIUS) {
      fear.addInstant('near-miss-explosion', CONFIG.FEAR_NEAR_MISS_INSTANT);
      this._spawnPuff(m.position, 0xff6644);
    } else if (m.minDistance <= CONFIG.MISSILE_DODGE_RADIUS) {
      fear.addInstant('successful-dodge', -CONFIG.FEAR_DODGE_INSTANT);
      this._spawnPuff(m.position, 0xffffff);
      this.audio.playWhoosh();
      this.audio.playDodgeSting();
      this._triggerSlowmo();
      radio.notifyDodge();
      this.dodgeCount += 1;
      console.log('[threats] dodge!');
    } else {
      this._spawnPuff(m.position, 0xffffff);
    }
    this._spawnRadarEcho(m.position);
    this._despawnMissile(m);
    // Any non-hit resolution counts as tutorial success, not just the
    // "successful-dodge" branch above — surviving is what the scripted
    // sequence is checking for, not the exact closest-approach bucket.
    if (scripted) this._scriptedResult = 'success';
  }

  _despawnMissile(m) {
    m.active = false;
    m.state = 'idle';
    m.mesh.visible = false;
    for (const s of m.trail) s.visible = false;
    m.trailHistory.length = 0;
    m.trailTimer = 0;
    m.radarTrailHistory.length = 0;
    m.radarTrailTimer = 0;
  }

  // Called by route.js when a fear-100 panic resolves into a country
  // restart, so the player doesn't come back mid-dodge against a missile
  // that was already tracking them pre-blackout.
  clearAllThreats() {
    for (const m of this._missiles) this._despawnMissile(m);
    for (const f of this._fighters) {
      f.active = false;
      f.mesh.visible = false;
      f.spawnTimer = randRange(CONFIG.FIGHTER_SPAWN_MIN, CONFIG.FIGHTER_SPAWN_MAX);
    }
  }

  _spawnPuff(position, color) {
    const slot = this._puffs.find((p) => !p.active) || this._puffs[0];
    slot.active = true;
    slot.timer = 0;
    slot.duration = CONFIG.PUFF_DURATION;
    slot.mesh.position.copy(position);
    slot.mesh.material.color.setHex(color);
    slot.mesh.material.opacity = 1;
    slot.mesh.scale.setScalar(4);
    slot.mesh.visible = true;
  }

  _updatePuffs(gameDt) {
    for (const p of this._puffs) {
      if (!p.active) continue;
      p.timer += gameDt;
      const t = THREE.MathUtils.clamp(p.timer / p.duration, 0, 1);
      p.mesh.scale.setScalar(THREE.MathUtils.lerp(4, CONFIG.PUFF_MAX_SCALE, t));
      p.mesh.material.opacity = 1 - t;
      if (t >= 1) {
        p.active = false;
        p.mesh.visible = false;
      }
    }
  }

  _updateFighters(dt, gameDt, flight, fear) {
    for (const f of this._fighters) {
      if (!f.active) {
        if (!this.spawningEnabled || this._wavePhase === 'calm') continue;
        f.spawnTimer -= dt;
        const activeCount = this._fighters.filter((x) => x.active).length;
        if (f.spawnTimer <= 0 && activeCount < this._maxFighters) {
          this._spawnFighter(f, flight);
        }
        continue;
      }

      f.lifeTimer -= dt;
      f.orbitAngle += CONFIG.FIGHTER_ORBIT_SPEED * gameDt;
      const target = flight.position.clone().add(
        new THREE.Vector3(
          Math.cos(f.orbitAngle) * f.orbitRadius,
          Math.sin(f.orbitAngle * 0.6) * 150,
          Math.sin(f.orbitAngle) * f.orbitRadius
        )
      );
      f.mesh.position.lerp(target, 1 - Math.exp(-CONFIG.FIGHTER_STEER_RATE * gameDt));

      const vel = f.mesh.position.clone().sub(f.prevPos);
      if (vel.lengthSq() > 1e-6) {
        f.mesh.quaternion.setFromUnitVectors(FORWARD, vel.normalize());
      }
      f.prevPos.copy(f.mesh.position);

      const toFighter = f.mesh.position.clone().sub(flight.position);
      const dist = toFighter.length();
      const flatForward = flight.forward.clone().setY(0).normalize();
      const inFront = dist > 1 && dist < CONFIG.FIGHTER_VISIBLE_RANGE && flatForward.dot(toFighter.normalize()) > 0;
      f.inFront = inFront; // hasActiveThreats() reads this

      if (inFront) {
        fear.addContinuous('fighter-presence', CONFIG.FEAR_FIGHTER_PER_SEC, dt);
        if (this._fighterCanShoot) {
          f.burstTimer -= dt;
          if (f.burstTimer <= 0) {
            this._resolveGunBurst(flight, fear);
            f.burstTimer = randRange(CONFIG.GUN_BURST_INTERVAL_MIN, CONFIG.GUN_BURST_INTERVAL_MAX);
          }
        }
      }

      if (f.lifeTimer <= 0) {
        f.active = false;
        f.mesh.visible = false;
        f.spawnTimer = randRange(CONFIG.FIGHTER_SPAWN_MIN, CONFIG.FIGHTER_SPAWN_MAX);
        console.log('[threats] fighter leaves');
      }
    }
  }

  _spawnFighter(f, flight) {
    f.active = true;
    f.lifeTimer = randRange(CONFIG.FIGHTER_LIFETIME_MIN, CONFIG.FIGHTER_LIFETIME_MAX);
    f.orbitAngle = Math.random() * Math.PI * 2;
    f.orbitRadius = randRange(CONFIG.FIGHTER_ORBIT_MIN, CONFIG.FIGHTER_ORBIT_MAX);
    f.burstTimer = randRange(CONFIG.GUN_BURST_INTERVAL_MIN, CONFIG.GUN_BURST_INTERVAL_MAX);
    f.mesh.position.copy(flight.position).add(new THREE.Vector3(f.orbitRadius, 0, 0));
    f.prevPos.copy(f.mesh.position);
    f.mesh.visible = true;
    console.log('[threats] fighter appears');
  }

  // Georgia onward: fighters fire short bursts. A hit is lighter than a
  // missile hit (fear, tumble, shake all reduced) but still counts as "any
  // hit" for the post-hit lock-on immunity.
  _resolveGunBurst(flight, fear) {
    if (Math.random() < CONFIG.GUN_HIT_CHANCE) {
      fear.addInstant('fighter-gun-hit', CONFIG.FEAR_GUN_HIT_INSTANT);
      flight.triggerTumble(CONFIG.GUN_HIT_TUMBLE_DURATION);
      flight.triggerImpactShake(CONFIG.GUN_HIT_IMPACT_SHAKE_DURATION, CONFIG.GUN_HIT_IMPACT_SHAKE_MAG);
      this.audio.playImpactThud();
      this._lockImmuneTimer = CONFIG.POST_HIT_LOCK_IMMUNITY;
      console.log('[threats] fighter gun HIT');
    } else {
      fear.addInstant('fighter-gun-near-miss', CONFIG.FEAR_GUN_NEAR_MISS_INSTANT);
      console.log('[threats] fighter gun burst (near miss)');
    }
  }

  // Signed bearing (radians, 0=ahead, +/- toward either side) of every active
  // missile relative to the player's heading, for the HUD edge indicator.
  // `inView` marks missiles whose real 3D mesh (+ trail) is already visible
  // inside the camera's horizontal FOV — the edge marker is redundant (and
  // confusing clutter) once the actual missile is readable on-screen, so
  // ui.js only draws it for bearings where inView is false. Only 'homing'
  // missiles have a mesh to see at all; 'lockon' ones are still just a beep.
  getBearings(flight) {
    const results = [];
    const flatForward = flight.forward.clone().setY(0).normalize();
    const camera = flight.camera;
    const vFovRad = THREE.MathUtils.degToRad(camera.fov);
    const halfHFovRad = Math.atan(Math.tan(vFovRad / 2) * camera.aspect);

    for (const m of this._missiles) {
      if (!m.active) continue;
      const targetPos = m.state === 'lockon' ? m.spawnPos : m.position;
      const toTarget = targetPos.clone().sub(flight.position);
      toTarget.y = 0;
      const dist = toTarget.length();
      if (dist < 1) continue;
      toTarget.normalize();

      const dot = THREE.MathUtils.clamp(flatForward.dot(toTarget), -1, 1);
      let angle = Math.acos(dot);
      const cross = new THREE.Vector3().crossVectors(flatForward, toTarget);
      if (cross.y < 0) angle = -angle;

      const inView = m.state === 'homing' && Math.abs(angle) < halfHFovRad;
      results.push({ angle, warning: m.state === 'lockon', distance: dist, inView });
    }
    return results;
  }

  // Heading-up radar contacts (ui.js's cockpit radar): coordinates are in the
  // player's OWN reference frame (localRight/localForward), not a compass
  // bearing angle — "up" on a heading-up display is always the nose, so the
  // player's forward axis IS the display's vertical axis, no rotation logic
  // needed beyond this dot-product projection. dirRight/dirForward give a
  // homing missile's travel direction for the velocity tick; null for
  // fighters and for missiles still locking on (nothing moving yet). `range`
  // is passed in (not CONFIG.RADAR_RANGE directly) so ui.js's auto-zoom can
  // request contacts against whatever range it's currently displaying.
  getRadarContacts(flight, range = CONFIG.RADAR_RANGE) {
    const results = [];
    const flatForward = flight.forward.clone().setY(0).normalize();
    const flatRight = flatForward.clone().cross(UP);

    const project = (worldPos) => {
      const rel = worldPos.clone().sub(flight.position);
      rel.y = 0;
      return { right: rel.dot(flatRight), forward: rel.dot(flatForward), dist: rel.length() };
    };

    for (const m of this._missiles) {
      if (!m.active) continue;
      const targetPos = m.state === 'lockon' ? m.spawnPos : m.position;
      const p = project(targetPos);
      if (p.dist < 1 || p.dist > range) continue;
      const homing = m.state === 'homing';
      // Fading path of recent positions, oldest last — only meaningful once
      // homing (lock-on hasn't moved yet).
      const trail = homing
        ? m.radarTrailHistory.map((h) => {
            const tp = project(h.pos);
            return { localRight: tp.right, localForward: tp.forward, alpha: 1 - h.age / CONFIG.RADAR_TRAIL_DURATION };
          })
        : [];
      results.push({
        type: 'missile',
        localRight: p.right,
        localForward: p.forward,
        warning: !homing,
        dirRight: homing ? m.direction.dot(flatRight) : null,
        dirForward: homing ? m.direction.dot(flatForward) : null,
        trail,
        dodgeWindow: m.dodgeWindowState !== 'none', // ui.js pulses the dot while true
      });
    }

    for (const f of this._fighters) {
      if (!f.active) continue;
      const p = project(f.mesh.position);
      if (p.dist < 1 || p.dist > range) continue;
      results.push({ type: 'fighter', localRight: p.right, localForward: p.forward, warning: false, dirRight: null, dirForward: null, trail: [], dodgeWindow: false });
    }

    for (const e of this._radarEchoes) {
      if (!e.active) continue;
      const p = project(e.position);
      if (p.dist < 1 || p.dist > range) continue;
      results.push({
        type: 'echo',
        localRight: p.right,
        localForward: p.forward,
        warning: false,
        dirRight: null,
        dirForward: null,
        trail: [],
        alpha: e.timer / CONFIG.RADAR_ECHO_DURATION,
      });
    }

    return results;
  }

  // Closest active homing missile's straight-line distance, or Infinity if
  // none — ui.js's radar uses this to decide when to auto-zoom in.
  nearestHomingMissileDist(flight) {
    let best = Infinity;
    for (const m of this._missiles) {
      if (!m.active || m.state !== 'homing') continue;
      const d = m.position.distanceTo(flight.position);
      if (d < best) best = d;
    }
    return best;
  }

  // "Genuinely calm air": true while any missile is locking-on or homing, or
  // any fighter is currently in front — main.js reads this once per frame
  // (before fear.update()) and it's what gates fear.js's calm-decay-toward-
  // floor and safety valve. Broader than "currently adding continuous fear
  // right now" on purpose: a homing missile still 2000 units out isn't yet
  // within MISSILE_CLOSE_RADIUS, but it's absolutely not calm air either.
  hasActiveThreats() {
    for (const m of this._missiles) {
      if (m.active && (m.state === 'lockon' || m.state === 'homing')) return true;
    }
    for (const f of this._fighters) {
      if (f.active && f.inFront) return true;
    }
    return false;
  }
}