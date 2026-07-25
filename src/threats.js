import * as THREE from 'three';
import { randRange, TOON_GRADIENT } from './utils.js';

const FORWARD = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);

const MISSILE_POOL_SIZE = 5; // headroom for wave 4/5 pairs overlapping a straggler
const FIGHTER_POOL_SIZE = 2; // wave 5 wants two concurrent fighters
const PUFF_POOL_SIZE = 4;

// All threat tuning in one place, same convention as fear.js's CONFIG.
// Fields also documented as "per-wave" are the fallback/default values used
// before route.js calls setWaveConfig(); route.js's WAVES array overrides
// them per country.
export const CONFIG = {
  // Calm-stretch wave pacing: alternates an active threat phase with a gap.
  // (per-wave: calm gap length)
  ACTIVE_MIN: 30,
  ACTIVE_MAX: 50,
  CALM_MIN: 15,
  CALM_MAX: 25,
  CALM_DRAIN_PER_SEC: 2,

  // Missiles. (per-wave: spawn interval, turn rate)
  MISSILE_SPAWN_MIN: 12,
  MISSILE_SPAWN_MAX: 20,
  MISSILE_TURN_RATE: 65, // degrees/s, limited so a hard break can force an overshoot
  MISSILE_LOCKON_DURATION: 1.5,
  // Spawning ~2500 units out (was 550-900, essentially on top of the player)
  // means a straight-line approach at the old MISSILE_SPEED (220) would take
  // ~11s, longer than the old 8s lifetime — speed and lifetime both bumped
  // so the missile reliably closes the distance and is on-screen long enough
  // to read, without dragging the encounter out.
  MISSILE_LIFETIME: 11,
  MISSILE_SPEED: 340,
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
    this._missilesPerSpawn = 1;
    this._maxMissilesThisWave = Infinity;
    this._missilesThisWave = 0;
    this._nextMissileTimer = randRange(this._missileSpawnMin, this._missileSpawnMax);

    this._maxFighters = 0;
    this._fighterCanShoot = false;

    this._missiles = Array.from({ length: MISSILE_POOL_SIZE }, () => ({
      mesh: createMissileMesh(),
      trail: Array.from({ length: CONFIG.MISSILE_TRAIL_LENGTH }, () => createTrailPuff()),
      trailHistory: [],
      trailTimer: 0,
      active: false,
      state: 'idle',
      lockTimer: 0,
      lifeTimer: 0,
      spawnPos: new THREE.Vector3(),
      position: new THREE.Vector3(),
      direction: new THREE.Vector3(),
      minDistance: Infinity,
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

    if (this._wavePhase === 'calm') {
      fear.addContinuous('calm-drain', -CONFIG.CALM_DRAIN_PER_SEC, dt);
    } else {
      this._updateMissileSpawning(dt, flight);
    }

    this._updateMissiles(dt, gameDt, flight, fear, radio);
    this._updateFighters(dt, gameDt, flight, fear);
    this._updatePuffs(gameDt);
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

    this.audio.startLockTone();
    console.log('[threats] lock-on warning');
  }

  _launchMissile(m, flight) {
    m.state = 'homing';
    m.lifeTimer = CONFIG.MISSILE_LIFETIME;
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

  _updateMissiles(dt, gameDt, flight, fear, radio) {
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

      // Homing: turn-rate-limited pursuit of the player's current position.
      const desired = flight.position.clone().sub(m.position).normalize();
      const angle = m.direction.angleTo(desired);
      if (angle > 1e-4) {
        const axis = new THREE.Vector3().crossVectors(m.direction, desired);
        if (axis.lengthSq() > 1e-8) {
          axis.normalize();
          const turn = Math.min(angle, this._missileTurnRate * gameDt);
          m.direction.applyAxisAngle(axis, turn).normalize();
        }
      }
      m.position.addScaledVector(m.direction, CONFIG.MISSILE_SPEED * gameDt);
      m.mesh.position.copy(m.position);
      m.mesh.quaternion.setFromUnitVectors(FORWARD, m.direction);
      m.lifeTimer -= gameDt;
      this._updateTrail(m, gameDt);

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

  _resolveHit(m, flight, fear) {
    fear.addInstant('missile-hit', CONFIG.FEAR_HIT_INSTANT);
    flight.triggerTumble(CONFIG.TUMBLE_DURATION);
    flight.triggerImpactShake(CONFIG.IMPACT_SHAKE_DURATION, CONFIG.IMPACT_SHAKE_MAG);
    this.audio.playImpactThud();
    this._spawnPuff(m.position, 0xffb066);
    this._despawnMissile(m);
    this._lockImmuneTimer = CONFIG.POST_HIT_LOCK_IMMUNITY;

    console.log('[threats] HIT');
  }

  _resolveExpiry(m, fear, radio) {
    if (m.minDistance <= CONFIG.MISSILE_NEAR_MISS_RADIUS) {
      fear.addInstant('near-miss-explosion', CONFIG.FEAR_NEAR_MISS_INSTANT);
      this._spawnPuff(m.position, 0xff6644);
    } else if (m.minDistance <= CONFIG.MISSILE_DODGE_RADIUS) {
      fear.addInstant('successful-dodge', -CONFIG.FEAR_DODGE_INSTANT);
      this._spawnPuff(m.position, 0xffffff);
      this.audio.playWhoosh();
      this._triggerSlowmo();
      radio.notifyDodge();
      console.log('[threats] dodge!');
    } else {
      this._spawnPuff(m.position, 0xffffff);
    }
    this._despawnMissile(m);
  }

  _despawnMissile(m) {
    m.active = false;
    m.state = 'idle';
    m.mesh.visible = false;
    for (const s of m.trail) s.visible = false;
    m.trailHistory.length = 0;
    m.trailTimer = 0;
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
  // fighters and for missiles still locking on (nothing moving yet).
  getRadarContacts(flight) {
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
      if (p.dist < 1 || p.dist > CONFIG.RADAR_RANGE) continue;
      const homing = m.state === 'homing';
      results.push({
        type: 'missile',
        localRight: p.right,
        localForward: p.forward,
        warning: !homing,
        dirRight: homing ? m.direction.dot(flatRight) : null,
        dirForward: homing ? m.direction.dot(flatForward) : null,
      });
    }

    for (const f of this._fighters) {
      if (!f.active) continue;
      const p = project(f.mesh.position);
      if (p.dist < 1 || p.dist > CONFIG.RADAR_RANGE) continue;
      results.push({ type: 'fighter', localRight: p.right, localForward: p.forward, warning: false, dirRight: null, dirForward: null });
    }

    return results;
  }
}