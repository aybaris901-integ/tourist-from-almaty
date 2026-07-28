import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { randRange, smoothDamp, TOON_GRADIENT } from './utils.js';

const FORWARD = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);

const MISSILE_POOL_SIZE = 5; // headroom for wave 4/5 pairs overlapping a straggler
const FIGHTER_POOL_SIZE = 3; // wave 5 wants two concurrent fighters; headroom to test a third without tanking fps
const TRACER_POOL_SIZE = 8; // up to a few fighters bursting in overlapping windows
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

  // Fighter: real model (fighter.glb), loaded once and cloned per pool slot
  // (see _loadFighterModel/_attachFighterModel) — never loaded per fighter.
  // Per-instance state machine: PATROL (lazy orbit, presence fear) ->
  // ATTACK (swing to the player's rear quarter, telegraphed line-up, tracer
  // burst) -> COOLDOWN (breaks away) -> back to PATROL. (per-wave: count,
  // fighterCanAttack, attack interval, accuracy — see route.js's WAVES;
  // PATROL-only until a wave sets fighterCanAttack.)
  FIGHTER_MODEL_URL: '/models/fighter.glb',
  // This particular export is ~900 world units long (Sketchfab FBX scale
  // artifact) — the file's native scale is never trusted. On load the
  // bounding box's longest dimension is measured and the whole model
  // rescaled so nose-to-tail equals this constant.
  FIGHTER_LENGTH: 40,
  // Sketchfab_model/RootNode bakes an FBX rotation the glTF export didn't
  // undo — this is the wrapper yaw (radians) that points the nose down our
  // -Z forward convention (see FORWARD below). Tune by eye — fighter must
  // fly nose-first — with the KeyG/KeyH debug keys (_bindFighterDebugKeys);
  // the fix lives on the wrapper only, never on the AI's own heading math.
  FIGHTER_MODEL_YAW_OFFSET: 0,
  FIGHTER_TRI_WARN: 15000, // per-instance triangle budget warning
  FIGHTER_TOTAL_TRI_WARN: 45000, // rough scene-budget warning (draw calls/vertex processing still scale per instance even with shared geometry)
  FIGHTER_SPAWN_MIN: 20, // end-of-lifetime rotation delay: a fighter left, wait a while before the next one
  FIGHTER_SPAWN_MAX: 35,
  // Distinct, MUCH shorter delay used only when a fighter is forced out by
  // _enterCalm (see below) — it reappears promptly once the active phase
  // resumes, not after a fresh 20-35s roll. Without this, _enterCalm using
  // FIGHTER_SPAWN_MIN/MAX (or worse, leaving the fighter's already-elapsed
  // spawnTimer untouched, which was the actual shipped bug) meant the
  // fighter either vanished for a full active phase or popped back INSTANTLY
  // at a brand-new random position the moment calm ended — a jarring
  // "teleport."
  FIGHTER_RESPAWN_DELAY_MIN: 2,
  FIGHTER_RESPAWN_DELAY_MAX: 5,
  FIGHTER_LIFETIME_MIN: 25,
  FIGHTER_LIFETIME_MAX: 40,
  // Movement model: every state (PATROL/ATTACK/COOLDOWN) computes a target
  // point, then _steerFighter() flies toward it like an aircraft, not a
  // camera — heading turns at a bounded rate and position always advances
  // along that same heading (see _steerFighter). This is deliberate, not
  // just style: an earlier version used an exponential position-lerp
  // ("teleport a fraction of the way toward target each frame") with
  // orientation derived separately from the position delta. Against a
  // target that itself moves at player speed, that lerp's steady-state lag
  // is proportional to playerSpeed/lerpRate — easily hundreds of units, so
  // the fighter visibly fell behind and "wandered off." Flying along its
  // own heading instead makes nose == velocity true by construction (no
  // separate derivation to get out of sync) and bounds the lag to whatever
  // the speed/turn-rate budget below actually allows.
  FIGHTER_ORBIT_MIN: 800, // PATROL escort radius
  FIGHTER_ORBIT_MAX: 1200,
  // rad/s the escort anchor sweeps across the front arc. This has to stay
  // small: the anchor's OWN tangential speed from sweeping is
  // radius*sweepSpeed (up to 1200*sweepSpeed), and that has to leave
  // headroom under the patrol speed budget (1.05-1.15x player speed) on top
  // of whatever speed is already needed just to match the player's own
  // translation. The original 0.12 gave up to 144 units/s of tangential
  // speed alone — combined with tracking translation that regularly
  // exceeded the whole budget (especially at low player throttle), so the
  // fighter could never actually keep pace with its own anchor and ended up
  // wandering wherever it could, including behind the player. 0.025 keeps
  // the tangential contribution to ~30 units/s at max radius, comfortably
  // trackable so the front-hemisphere bias is something the player actually
  // SEES, not just something the anchor math technically satisfies.
  FIGHTER_ORBIT_SWEEP_SPEED: 0.025,
  // PATROL/escort anchor's RESTING zone stays within +/-this many degrees
  // of the player's OWN nose (bearing, not a world-fixed angle). 120 was
  // "front hemisphere" by math but well outside the cockpit canopy's real
  // sightline (~+/-55 deg horizontally, above the dashboard) — the fighter
  // could sit at your 9 o'clock, front arc by the numbers, invisible by
  // glass. 45 keeps the resting anchor comfortably inside what you can
  // actually see through the canopy; it can still swing wider mid-maneuver
  // (ATTACK's rear-quarter approach, COOLDOWN's breakaway — neither reads
  // this constant), just not at rest.
  FIGHTER_VISIBLE_ARC_DEG: 45,
  // PATROL/escort anchor's resting altitude, relative to the player — kept
  // consistently ABOVE (never oscillating through 0) so it silhouettes
  // against the sky in the upper canopy instead of getting cut off by the
  // dashboard or side struts. Randomized per fighter at spawn (see
  // f.altitudeOffset) for a little vertical variety between escorts.
  FIGHTER_ALTITUDE_OFFSET_MIN: 50,
  FIGHTER_ALTITUDE_OFFSET_MAX: 150,
  FIGHTER_TURN_RATE_DEG: 75, // heading turn rate, all states
  // PATROL's steady-state "holding formation" speed vs. the player's
  // CURRENT speed — always slightly faster, never snaps. NOT used for
  // closing a gap (see FIGHTER_CLOSING_DIST/FIGHTER_BRISK_SPEED_MULT
  // below): a 5-15% speed edge alone gives a pursuer chasing a
  // similarly-fast, laterally-drifting target (the escort anchor also
  // inherits the player's translation) so little closing power, combined
  // with the bounded turn rate, that it settles into a stable but LOOSE
  // orbit at nearly the full escort radius away from the anchor — never
  // actually arriving, and easily ending up outside the front bias as a
  // result. This speed is only for once it's already close.
  FIGHTER_PATROL_SPEED_MULT_MIN: 1.05,
  FIGHTER_PATROL_SPEED_MULT_MAX: 1.15,
  // Distance from the CURRENT target point past which a fighter uses
  // FIGHTER_BRISK_SPEED_MULT instead of its normal per-state speed,
  // regardless of state — this is what actually lets PATROL close the gap
  // to its escort slot instead of permanently trailing it (see above).
  // Once within this radius the fighter drops back to the gentler
  // per-state speed, so it settles into formation instead of oscillating.
  FIGHTER_CLOSING_DIST: 300,
  FIGHTER_BRISK_SPEED_MULT: 1.35, // closing distance, ATTACK closing/lineup/burst, COOLDOWN breakaway
  FIGHTER_CATCHUP_DIST: 2000, // straight-line distance from the PLAYER past which...
  FIGHTER_CATCHUP_SPEED_MULT: 1.4, // ...this multiplier overrides everything else, until back in range
  FIGHTER_VISIBLE_RANGE: 3000,
  FEAR_FIGHTER_PER_SEC: 3, // PATROL/COOLDOWN/closing presence, front hemisphere only
  FIGHTER_MAX_BANK_DEG: 60,
  FIGHTER_BANK_GAIN: 1.4, // converts yaw rate (rad/s) into a bank angle target
  FIGHTER_BANK_SMOOTH_TIME: 0.35,
  FIGHTER_TRAIL_LENGTH: 14, // 2x MISSILE_TRAIL_LENGTH — readability layer, independent of the real model
  FIGHTER_TRAIL_SAMPLE_INTERVAL: 0.045,

  // ATTACK: swing to the player's rear quarter, then a telegraphed line-up
  // (rattle cue + orange radar dot) before a tracer burst. Resolution
  // (hit/near-miss) is decided at line-up's end but only takes effect after
  // ATTACK_TRACER_TRAVEL_TIME into the burst — tracers travel, this isn't
  // hitscan.
  ATTACK_REAR_DIST_MIN: 300,
  ATTACK_REAR_DIST_MAX: 500,
  ATTACK_REAR_ANGLE_MIN: 20, // degrees off dead-astern, either side — a "quarter", not directly behind
  ATTACK_REAR_ANGLE_MAX: 55,
  ATTACK_CLOSING_TIMEOUT: 6, // safety net: abort to COOLDOWN if the slot is never reached
  ATTACK_SLOT_RADIUS: 180, // close enough to the ideal rear-quarter point to call it "in position"
  ATTACK_LINEUP_DURATION: 2,
  ATTACK_BURST_DURATION: 1,
  ATTACK_TRACER_TRAVEL_TIME: 0.35, // seconds into the burst before the shot resolves
  ATTACK_TRACER_SPAWN_INTERVAL: 0.1,
  ATTACK_TRACER_SPEED: 1600,
  ATTACK_TRACER_HIT_SPREAD: 20, // aim jitter around the player when the roll says "hit"
  ATTACK_TRACER_MISS_SPREAD: 160, // aim offset when the roll says "miss" — a clean, readable near-miss
  FEAR_FIGHTER_LINEUP_PER_SEC: 8, // being lined up on is scarier than mere presence
  COOLDOWN_MIN: 8,
  COOLDOWN_MAX: 12,
  ATTACK_INTERVAL_MIN: 12, // fallback if a wave doesn't set fighterAttackIntervalMin/Max
  ATTACK_INTERVAL_MAX: 20,
  ATTACK_ACCURACY_DEFAULT: 0.3,

  // A hit is deliberately lighter than a missile hit: shorter tumble/shake,
  // and +10 fear instead of +45 — still a real threat over multiple bursts,
  // not a one-shot.
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

// Shown inside each fighter's group until the real model (fighter.glb,
// loaded once — see _loadFighterModel) finishes loading and gets swapped in;
// keeps the pool spawnable from frame one instead of blocking on the async
// load.
function createFighterPlaceholder() {
  const geo = new THREE.BoxGeometry(30, 12, 40);
  const mat = new THREE.MeshToonMaterial({ color: 0x777d85, gradientMap: TOON_GRADIENT, fog: true });
  return new THREE.Mesh(geo, mat);
}

// Visible tracer streak for a fighter's gun burst — travels from the
// fighter to its aim point over ATTACK_TRACER_SPEED (see _spawnTracer),
// which is what makes the burst read as "not hitscan."
function createTracerMesh() {
  const geo = new THREE.BoxGeometry(2, 2, 24);
  geo.rotateX(-Math.PI / 2); // long axis now local -Z, aligned with FORWARD
  const mat = new THREE.MeshBasicMaterial({ color: 0xfff3b0, fog: true });
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
    this._fighterCanAttack = false;
    this._fighterAttackMin = CONFIG.ATTACK_INTERVAL_MIN;
    this._fighterAttackMax = CONFIG.ATTACK_INTERVAL_MAX;
    this._fighterAccuracy = CONFIG.ATTACK_ACCURACY_DEFAULT;

    // Real fighter model: loaded once, cloned into every pool slot once
    // ready (see _loadFighterModel/_attachFighterModel). Not skinned in the
    // current export (no <skin> in fighter.glb) but detected dynamically —
    // SkeletonUtils.clone() only for a skinned source, plain clone()
    // otherwise, per the loader contract.
    this._fighterTemplate = null;
    this._fighterSkinned = false;

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

    this._tracers = Array.from({ length: TRACER_POOL_SIZE }, () => ({
      mesh: createTracerMesh(),
      active: false,
      dir: new THREE.Vector3(),
      speed: 0,
      traveled: 0,
      maxDist: 0,
    }));
    for (const t of this._tracers) scene.add(t.mesh);

    this._fighters = Array.from({ length: FIGHTER_POOL_SIZE }, () => {
      const placeholder = createFighterPlaceholder();
      const group = new THREE.Group();
      group.add(placeholder);
      group.visible = false;
      return {
        mesh: group,
        modelPlaceholder: placeholder,
        modelInstance: null, // real model clone, swapped in once _fighterTemplate is ready (see _attachFighterModel)
        active: false,
        state: 'patrol', // 'patrol' | 'attack' | 'cooldown'
        attackPhase: null, // 'closing' | 'lineup' | 'burst', only meaningful while state==='attack'
        spawnTimer: randRange(CONFIG.FIGHTER_SPAWN_MIN, CONFIG.FIGHTER_SPAWN_MAX),
        lifeTimer: 0,
        orbitAngle: 0,
        orbitRadius: 0,
        patrolSpeedMult: 1.1, // randomized per-spawn within FIGHTER_PATROL_SPEED_MULT_MIN/MAX
        altitudeOffset: 100, // randomized per-spawn within FIGHTER_ALTITUDE_OFFSET_MIN/MAX
        heading: new THREE.Vector3(0, 0, -1), // unit vector — position always advances along this, so nose == velocity by construction (see _steerFighter)
        bank: 0,
        bankVel: { value: 0 },
        _diagPrevPos: new THREE.Vector3(), // debug-overlay only: lets getFighterDebugInfo report real vel-vs-heading divergence
        inFront: false,
        threatening: false, // hasActiveThreats() reads this: front-hemisphere presence OR any ATTACK phase
        radarLineup: false, // ui.js's radar draws an orange dot while true
        attackTimer: 0, // PATROL countdown to the next attack attempt
        attackSide: 1,
        attackAngle: 0,
        attackDist: 0,
        closingTimer: 0,
        lineupTimer: 0,
        burstTimer: 0,
        burstJustStarted: false, // one-shot flag for the gun-burst sound cue
        attackHit: false, // decided at line-up's end; tracer aim + the delayed resolution both read it
        tracerSpawnTimer: 0,
        cooldownTimer: 0,
        trail: Array.from({ length: CONFIG.FIGHTER_TRAIL_LENGTH }, () => createTrailPuff()),
        trailHistory: [],
        trailTimer: 0,
      };
    });
    for (const f of this._fighters) {
      scene.add(f.mesh);
      for (const s of f.trail) scene.add(s);
    }

    this._loadFighterModel();
    this._bindFighterDebugKeys();
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
    this._fighterCanAttack = !!wave.fighterCanAttack;
    this._fighterAttackMin = wave.fighterAttackIntervalMin ?? CONFIG.ATTACK_INTERVAL_MIN;
    this._fighterAttackMax = wave.fighterAttackIntervalMax ?? CONFIG.ATTACK_INTERVAL_MAX;
    this._fighterAccuracy = wave.fighterAccuracy ?? CONFIG.ATTACK_ACCURACY_DEFAULT;

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
  //
  // MUST go through _despawnFighter (not just active=false/visible=false
  // inline) — that's what resets spawnTimer. Fighters never reset it
  // themselves on spawn, so an inline hide here left it holding whatever
  // near-zero/negative value it had from before the fighter was already
  // flying; the instant calm ended, _updateFighters saw spawnTimer<=0 and
  // respawned it THAT SAME FRAME at a brand-new random position — the
  // "portal teleport" players were seeing. FIGHTER_RESPAWN_DELAY_MIN/MAX
  // (a couple seconds, not the full end-of-lifetime 20-35s) keeps it
  // reappearing promptly once the active phase resumes.
  _enterCalm(duration) {
    this._wavePhase = 'calm';
    this._waveTimer = duration;
    for (const f of this._fighters) {
      if (!f.active) continue;
      this._despawnFighter(f);
      f.spawnTimer = randRange(CONFIG.FIGHTER_RESPAWN_DELAY_MIN, CONFIG.FIGHTER_RESPAWN_DELAY_MAX);
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
    this._updateTracers(gameDt);
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
    for (const f of this._fighters) this._despawnFighter(f);
    for (const t of this._tracers) {
      t.active = false;
      t.mesh.visible = false;
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

  // --- Fighter model loading (load once, clone per pool slot) -------------

  _loadFighterModel() {
    const loader = new GLTFLoader();
    loader.load(
      CONFIG.FIGHTER_MODEL_URL,
      (gltf) => this._onFighterModelLoaded(gltf),
      undefined,
      (err) => console.error('[threats] failed to load fighter.glb:', err)
    );
  }

  // Toon-shaded to match the rest of the world (same treatment as
  // cockpit.js's _styleMaterials), base colors kept. Styled ONCE on the
  // shared template — every per-instance clone below just references these
  // same material objects, so this never runs per fighter.
  _styleFighterMaterials(model) {
    model.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      const next = materials.map((old) => {
        const mat = new THREE.MeshToonMaterial({
          color: old.color ? old.color.clone() : 0xffffff,
          map: old.map || null,
          gradientMap: TOON_GRADIENT,
          transparent: old.transparent,
          opacity: old.opacity,
          alphaTest: old.alphaTest || 0,
          emissive: 0x000000,
          fog: true, // outdoor, unlike the cockpit interior
        });
        old.dispose();
        return mat;
      });
      child.material = Array.isArray(child.material) ? next : next[0];
    });
  }

  _onFighterModelLoaded(gltf) {
    const model = gltf.scene;
    model.updateMatrixWorld(true);
    this._styleFighterMaterials(model);

    let triCount = 0;
    let meshCount = 0;
    let skinned = false;
    model.traverse((child) => {
      if (!child.isMesh) return;
      meshCount++;
      if (child.isSkinnedMesh) skinned = true;
      const geo = child.geometry;
      triCount += geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
    });
    triCount = Math.round(triCount);
    console.log(`[threats] loaded fighter.glb — ${triCount} tris across ${meshCount} meshes`);
    if (triCount > CONFIG.FIGHTER_TRI_WARN) {
      console.warn(`[threats] fighter.glb is ${triCount} tris — over the ${CONFIG.FIGHTER_TRI_WARN}-tri per-instance budget`);
    }
    if (triCount * FIGHTER_POOL_SIZE > CONFIG.FIGHTER_TOTAL_TRI_WARN) {
      console.warn(
        `[threats] ${FIGHTER_POOL_SIZE}x fighter.glb ~= ${triCount * FIGHTER_POOL_SIZE} tris — over the ${CONFIG.FIGHTER_TOTAL_TRI_WARN} scene budget (draw calls/vertex processing scale per instance even though geometry is shared)`
      );
    }

    // SCALE NORMALIZATION: this file's native scale is never trusted (~900
    // world units long as exported) — measure the bbox and rescale so the
    // longest dimension (nose to tail) equals FIGHTER_LENGTH.
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const length = Math.max(size.x, size.y, size.z) || 1;
    model.scale.setScalar(CONFIG.FIGHTER_LENGTH / length);

    // FORWARD AXIS: baked FBX rotations live on the imported hierarchy
    // (Sketchfab_model/RootNode) — wrap it in our own Group and rotate THAT
    // to point the nose down -Z (FORWARD, same convention as missiles). The
    // fix lives on this wrapper only; the AI's own heading math never
    // changes.
    const wrapper = new THREE.Group();
    wrapper.rotation.y = CONFIG.FIGHTER_MODEL_YAW_OFFSET;
    wrapper.add(model);

    this._fighterTemplate = wrapper;
    this._fighterSkinned = skinned;

    // Any pool slots that already exist (all of them — the pool is built
    // up-front in the constructor) get the real model swapped in for their
    // placeholder box now, whether currently active or not.
    for (const f of this._fighters) this._attachFighterModel(f);
  }

  _attachFighterModel(f) {
    if (!this._fighterTemplate || f.modelInstance) return;
    const instance = this._fighterSkinned ? cloneSkinned(this._fighterTemplate) : this._fighterTemplate.clone();
    f.mesh.remove(f.modelPlaceholder);
    f.mesh.add(instance);
    f.modelInstance = instance;
  }

  // Dev aid for tuning FIGHTER_MODEL_YAW_OFFSET by eye (CLAUDE.md: "verify
  // visually, fix the wrapper, never the AI"). KeyG/KeyH nudge the wrapper
  // yaw ±15° on the template (so future clones inherit it) and on every
  // already-attached instance, logging the new offset in degrees.
  _bindFighterDebugKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyG' && e.code !== 'KeyH') return;
      const step = THREE.MathUtils.degToRad(15) * (e.code === 'KeyG' ? -1 : 1);
      CONFIG.FIGHTER_MODEL_YAW_OFFSET += step;
      if (this._fighterTemplate) this._fighterTemplate.rotation.y = CONFIG.FIGHTER_MODEL_YAW_OFFSET;
      for (const f of this._fighters) {
        if (f.modelInstance) f.modelInstance.rotation.y = CONFIG.FIGHTER_MODEL_YAW_OFFSET;
      }
      console.log(`[threats] FIGHTER_MODEL_YAW_OFFSET = ${THREE.MathUtils.radToDeg(CONFIG.FIGHTER_MODEL_YAW_OFFSET).toFixed(0)}deg`);
    });
  }

  // --- Fighter state machine: PATROL -> ATTACK -> COOLDOWN -> PATROL ------

  _updateFighters(dt, gameDt, flight, fear) {
    const flatForward = flight.forward.clone().setY(0).normalize();
    const flatRight = flatForward.clone().cross(UP);

    let nearestEngineDist = Infinity;
    let engineFighter = null;

    for (const f of this._fighters) {
      if (!f.active) {
        if (!this.spawningEnabled || this._wavePhase === 'calm') continue;
        // Only counts down while actually eligible to spawn (a free slot
        // exists) — the pool has more slots than most waves ever use at
        // once (FIGHTER_POOL_SIZE headroom), so the unused slots would
        // otherwise drain their spawnTimer deeply negative while sitting
        // blocked behind maxFighters, then spawn INSTANTLY — at a fresh
        // random position, unrelated to wherever the fighter that just left
        // was — the moment a vacancy finally opened. That read as a
        // same-frame teleport to a different fighter.
        const activeCount = this._fighters.filter((x) => x.active).length;
        if (activeCount >= this._maxFighters) continue;
        f.spawnTimer -= dt;
        if (f.spawnTimer <= 0) {
          this._spawnFighter(f, flight);
        }
        continue;
      }

      f.lifeTimer -= dt;

      let targetPos;
      let speedMult;
      if (f.state === 'patrol') {
        targetPos = this._patrolTarget(f, gameDt, flight);
        speedMult = f.patrolSpeedMult;
        if (this._fighterCanAttack) {
          f.attackTimer -= dt;
          if (f.attackTimer <= 0) this._beginAttack(f);
        }
      } else if (f.state === 'attack') {
        targetPos = this._updateAttack(f, dt, gameDt, flight, fear, flatRight);
        speedMult = CONFIG.FIGHTER_BRISK_SPEED_MULT;
      } else {
        targetPos = this._cooldownTarget(f, flight);
        speedMult = CONFIG.FIGHTER_BRISK_SPEED_MULT; // brisk breakaway, not a lazy drift
        f.cooldownTimer -= dt;
        if (f.cooldownTimer <= 0) {
          f.state = 'patrol';
          f.orbitAngle = Math.random() * Math.PI * 2;
          f.orbitRadius = randRange(CONFIG.FIGHTER_ORBIT_MIN, CONFIG.FIGHTER_ORBIT_MAX);
          f.attackTimer = randRange(this._fighterAttackMin, this._fighterAttackMax);
        }
      }

      this._steerFighter(f, targetPos, flight, gameDt, speedMult);
      this._updateFighterTrail(f, gameDt);

      const toFighter = f.mesh.position.clone().sub(flight.position);
      const dist = toFighter.length();
      const inFront = dist > 1 && dist < CONFIG.FIGHTER_VISIBLE_RANGE && flatForward.dot(toFighter.clone().normalize()) > 0;
      const lineupActive = f.state === 'attack' && f.attackPhase === 'lineup';
      f.inFront = inFront;
      // hasActiveThreats() reads this: an attacking fighter is a real threat
      // even while approaching from behind (outside the front-hemisphere
      // check below), which is the whole point of a rear-quarter attack.
      f.threatening = f.state === 'attack' || inFront;

      const presencePhase = f.state === 'patrol' || f.state === 'cooldown' || (f.state === 'attack' && f.attackPhase === 'closing');
      if (inFront && presencePhase) {
        fear.addContinuous('fighter-presence', CONFIG.FEAR_FIGHTER_PER_SEC, dt);
      }
      if (lineupActive) {
        fear.addContinuous('fighter-lineup', CONFIG.FEAR_FIGHTER_LINEUP_PER_SEC, dt);
      }
      if (f.burstJustStarted) {
        this.audio.playGunBurst(this._panFor(f.mesh.position, flight, flatRight));
        f.burstJustStarted = false;
      }

      if (dist < CONFIG.FIGHTER_VISIBLE_RANGE && dist < nearestEngineDist) {
        nearestEngineDist = dist;
        engineFighter = { dist, pan: this._panFor(f.mesh.position, flight, flatRight) };
      }

      // Mid-attack fighters ignore their lifetime clock — cutting an attack
      // off mid-line-up/burst would rob the payoff without buying anything;
      // COOLDOWN's own timer (or the next PATROL loop) despawns it instead.
      if (f.lifeTimer <= 0 && f.state !== 'attack') {
        this._despawnFighter(f);
      }
    }

    if (engineFighter) {
      this.audio.startFighterEngine();
      const proximity = 1 - THREE.MathUtils.clamp(engineFighter.dist / CONFIG.FIGHTER_VISIBLE_RANGE, 0, 1);
      this.audio.updateFighterEngine(engineFighter.pan, proximity);
    } else {
      this.audio.stopFighterEngine();
    }
  }

  // flight.forward can be a zero vector before flight.js has ever run its
  // own update() once (e.g. a fighter can spawn on the very first frame,
  // before that) — THREE.Vector3.normalize() on a zero-length vector
  // silently stays zero instead of throwing, and a zero direction anywhere
  // in the fighter steering chain (spawn bearing, PATROL/ATTACK target,
  // heading) can never fix itself afterward (see _steerFighter's own
  // degenerate-heading guard for the other half of this). Every fighter
  // target/spawn calculation that flattens flight.forward goes through
  // here instead of inlining `.clone().setY(0).normalize()`, so there's one
  // place that catches it, not three copies of the same latent bug.
  _safeFlatForward(flight) {
    const flat = flight.forward.clone().setY(0);
    return flat.lengthSq() > 1e-6 ? flat.normalize() : new THREE.Vector3(0, 0, -1);
  }

  // Player-relative escort point, recomputed fresh off flight.position/
  // flight.forward every frame (a moving anchor, not a world-fixed ellipse —
  // that was the earlier bug: the old version built the offset directly in
  // world X/Z, so it didn't track the player's facing at all). The bearing
  // sweeps sinusoidally within +/-FIGHTER_VISIBLE_ARC_DEG of the player's
  // OWN nose — narrow enough to stay inside the cockpit canopy's real
  // sightline, not just "front hemisphere" by the math — and the altitude
  // stays consistently ABOVE the player (f.altitudeOffset, set at spawn) so
  // it silhouettes against the sky instead of getting cut off by the
  // dashboard or side struts. The small sine bob rides on TOP of that
  // offset, not through zero, so it never dips back down to dashboard
  // height.
  _patrolTarget(f, gameDt, flight) {
    f.orbitAngle += CONFIG.FIGHTER_ORBIT_SWEEP_SPEED * gameDt;
    const bearingRad = Math.sin(f.orbitAngle) * THREE.MathUtils.degToRad(CONFIG.FIGHTER_VISIBLE_ARC_DEG);
    const bearingDir = this._safeFlatForward(flight).applyAxisAngle(UP, bearingRad);
    const vertical = f.altitudeOffset + Math.sin(f.orbitAngle * 0.6) * 25;
    return flight.position.clone().addScaledVector(bearingDir, f.orbitRadius).add(new THREE.Vector3(0, vertical, 0));
  }

  _cooldownTarget(f, flight) {
    const away = f.mesh.position.clone().sub(flight.position).setY(0);
    if (away.lengthSq() < 1) away.set(1, 0, 0);
    away.normalize();
    return flight.position.clone().addScaledVector(away, CONFIG.FIGHTER_ORBIT_MAX).setY(f.mesh.position.y);
  }

  _beginAttack(f) {
    f.state = 'attack';
    f.attackPhase = 'closing';
    f.attackSide = Math.random() < 0.5 ? 1 : -1;
    f.attackAngle = randRange(CONFIG.ATTACK_REAR_ANGLE_MIN, CONFIG.ATTACK_REAR_ANGLE_MAX);
    f.attackDist = randRange(CONFIG.ATTACK_REAR_DIST_MIN, CONFIG.ATTACK_REAR_DIST_MAX);
    f.closingTimer = 0;
    console.log('[threats] fighter swings to attack');
  }

  // Rear-quarter slot: behind the player, off dead-astern by attackAngle
  // toward attackSide — "a quarter," not a dead-six attack straight down
  // the player's tail.
  _attackTargetPos(f, flight) {
    const flatForward = this._safeFlatForward(flight);
    const backDir = flatForward.clone().negate().applyAxisAngle(UP, f.attackSide * THREE.MathUtils.degToRad(f.attackAngle));
    return flight.position.clone().addScaledVector(backDir, f.attackDist);
  }

  _abortAttack(f) {
    f.state = 'cooldown';
    f.attackPhase = null;
    f.radarLineup = false;
    f.cooldownTimer = randRange(CONFIG.COOLDOWN_MIN, CONFIG.COOLDOWN_MAX);
    console.log('[threats] fighter aborts attack (never reached slot)');
  }

  _updateAttack(f, dt, gameDt, flight, fear, flatRight) {
    const targetPos = this._attackTargetPos(f, flight);

    if (f.attackPhase === 'closing') {
      f.closingTimer += dt;
      if (f.mesh.position.distanceTo(targetPos) < CONFIG.ATTACK_SLOT_RADIUS) {
        f.attackPhase = 'lineup';
        f.lineupTimer = CONFIG.ATTACK_LINEUP_DURATION;
        f.radarLineup = true;
        this.audio.playFighterLineupCue(this._panFor(f.mesh.position, flight, flatRight));
        console.log('[threats] fighter lining up');
      } else if (f.closingTimer > CONFIG.ATTACK_CLOSING_TIMEOUT) {
        this._abortAttack(f);
      }
      return targetPos;
    }

    if (f.attackPhase === 'lineup') {
      f.lineupTimer -= dt;
      if (f.lineupTimer <= 0) {
        f.attackPhase = 'burst';
        f.attackHit = Math.random() < this._fighterAccuracy;
        f.burstTimer = CONFIG.ATTACK_BURST_DURATION;
        f.burstResolved = false;
        f.tracerSpawnTimer = 0;
        f.radarLineup = false;
        f.burstJustStarted = true;
        console.log('[threats] fighter opens fire');
      }
      return targetPos;
    }

    // burst
    f.burstTimer -= dt;
    f.tracerSpawnTimer -= gameDt;
    if (f.tracerSpawnTimer <= 0) {
      f.tracerSpawnTimer = CONFIG.ATTACK_TRACER_SPAWN_INTERVAL;
      this._spawnTracer(f, flight);
    }
    if (!f.burstResolved && f.burstTimer <= CONFIG.ATTACK_BURST_DURATION - CONFIG.ATTACK_TRACER_TRAVEL_TIME) {
      this._resolveAttackBurst(f, flight, fear);
      f.burstResolved = true;
    }
    if (f.burstTimer <= 0) {
      f.state = 'cooldown';
      f.attackPhase = null;
      f.cooldownTimer = randRange(CONFIG.COOLDOWN_MIN, CONFIG.COOLDOWN_MAX);
      console.log('[threats] fighter breaks away');
    }
    return targetPos;
  }

  // Hit/miss is decided at line-up's end (f.attackHit) so every tracer this
  // burst aims consistently; the fear/tumble/shake consequence lands here,
  // ATTACK_TRACER_TRAVEL_TIME into the burst — not instantly on trigger,
  // matching the tracers' actual travel time.
  _resolveAttackBurst(f, flight, fear) {
    if (f.attackHit) {
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

  _spawnTracer(f, flight) {
    const slot = this._tracers.find((t) => !t.active) || this._tracers[0];
    const start = f.mesh.position;
    const spread = f.attackHit ? CONFIG.ATTACK_TRACER_HIT_SPREAD : CONFIG.ATTACK_TRACER_MISS_SPREAD;
    const jitter = new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2);
    const aim = flight.position.clone().addScaledVector(jitter, spread);

    const dir = aim.clone().sub(start);
    const dist = dir.length();
    if (dist < 1) return;
    dir.normalize();

    slot.active = true;
    slot.dir.copy(dir);
    slot.speed = CONFIG.ATTACK_TRACER_SPEED;
    slot.traveled = 0;
    slot.maxDist = dist + 150; // flies a bit past the aim point rather than vanishing right at it
    slot.mesh.position.copy(start);
    slot.mesh.quaternion.setFromUnitVectors(FORWARD, dir);
    slot.mesh.visible = true;
  }

  _updateTracers(gameDt) {
    for (const t of this._tracers) {
      if (!t.active) continue;
      const step = t.speed * gameDt;
      t.traveled += step;
      t.mesh.position.addScaledVector(t.dir, step);
      if (t.traveled >= t.maxDist) {
        t.active = false;
        t.mesh.visible = false;
      }
    }
  }

  // Flies like an aircraft, not a camera: f.heading turns toward the target
  // direction at a bounded rate, then position advances along THAT SAME
  // heading — so the rendered nose (FORWARD rotated by f.mesh.quaternion)
  // and the real frame-to-frame velocity are identical by construction,
  // not two independently-derived quantities that can drift apart. Speed
  // is always a multiple of the player's CURRENT speed (speedMult, e.g.
  // FIGHTER_PATROL_SPEED_MULT_MIN/MAX), so a fighter chasing a target that
  // itself moves at player speed can actually close the gap instead of
  // settling into a permanent lag — and if it ever ends up more than
  // FIGHTER_CATCHUP_DIST from the player regardless (a wave transition
  // teleport, a stall recovery, anything), FIGHTER_CATCHUP_SPEED_MULT
  // overrides speedMult until it's back in range. Banking is a pure roll
  // about the heading axis (rollQuat rotates AROUND f.heading itself), so
  // by the same construction it can never rotate the nose off of heading —
  // verified: q*FORWARD = baseQuat*(rollQuat*FORWARD) = baseQuat*FORWARD =
  // heading, for any roll angle.
  _steerFighter(f, targetPos, flight, gameDt, speedMult) {
    const toTarget = targetPos.clone().sub(f.mesh.position);
    const distToTarget = toTarget.length();
    const desired = toTarget.lengthSq() > 1e-6 ? toTarget.normalize() : f.heading.clone();

    // Self-correcting fallback: a zero-length f.heading can otherwise never
    // recover on its own — crossVectors against a zero vector is always
    // zero, so the turn step below would silently no-op forever and the
    // fighter would freeze in world space permanently (this is exactly how
    // a fighter whose heading got initialized from a not-yet-valid
    // flight.forward — see _safeFlatForward — used to get stuck for its
    // whole lifetime). Snap straight to the desired direction this one
    // time; there's no meaningful "previous heading" to turn from anyway.
    if (f.heading.lengthSq() < 1e-6) {
      f.heading.copy(desired.lengthSq() > 1e-6 ? desired : FORWARD);
    }

    const maxTurn = THREE.MathUtils.degToRad(CONFIG.FIGHTER_TURN_RATE_DEG) * gameDt;
    const angle = f.heading.angleTo(desired);
    let signedTurn = 0;
    if (angle > 1e-4) {
      const axis = new THREE.Vector3().crossVectors(f.heading, desired);
      if (axis.lengthSq() > 1e-8) {
        axis.normalize();
        const turn = Math.min(angle, maxTurn);
        f.heading.applyAxisAngle(axis, turn).normalize();
        signedTurn = axis.y < 0 ? -turn : turn;
      }
    }

    // Speed: the caller's speedMult is a "holding formation" number
    // (PATROL's 1.05-1.15x) — fine once actually close to the target, but
    // nowhere near enough closing power against a target that itself
    // inherits the player's translation (see FIGHTER_CLOSING_DIST's
    // comment): a pursuer with only a 5-15% speed edge and a bounded turn
    // rate settles into a stable, LOOSE orbit around a laterally-drifting
    // target instead of ever arriving. FIGHTER_BRISK_SPEED_MULT kicks in
    // whenever still far from THIS FRAME's target, regardless of state;
    // FIGHTER_CATCHUP_SPEED_MULT is the separate, harder override for the
    // "somehow ended up far from the PLAYER entirely" safety net.
    const distToPlayer = f.mesh.position.distanceTo(flight.position);
    const closingMult =
      distToTarget > CONFIG.FIGHTER_CLOSING_DIST ? Math.max(speedMult, CONFIG.FIGHTER_BRISK_SPEED_MULT) : speedMult;
    const speed =
      distToPlayer > CONFIG.FIGHTER_CATCHUP_DIST
        ? flight.speed * CONFIG.FIGHTER_CATCHUP_SPEED_MULT
        : flight.speed * closingMult;
    f.mesh.position.addScaledVector(f.heading, speed * gameDt);

    const yawRate = gameDt > 0 ? signedTurn / gameDt : 0;
    const maxBank = THREE.MathUtils.degToRad(CONFIG.FIGHTER_MAX_BANK_DEG);
    const targetBank = THREE.MathUtils.clamp(-yawRate * CONFIG.FIGHTER_BANK_GAIN, -maxBank, maxBank);
    f.bank = smoothDamp(f.bank, targetBank, f.bankVel, CONFIG.FIGHTER_BANK_SMOOTH_TIME, gameDt);

    const baseQuat = new THREE.Quaternion().setFromUnitVectors(FORWARD, f.heading);
    const rollQuat = new THREE.Quaternion().setFromAxisAngle(FORWARD, f.bank);
    f.mesh.quaternion.copy(baseQuat).multiply(rollQuat);
  }

  // Contrail ribbon: same pooled-puff technique as a missile's exhaust trail
  // (_updateTrail) but twice as long and plain white — a readability layer
  // that's independent of whatever the real model looks like up close.
  _updateFighterTrail(f, gameDt) {
    f.trailTimer -= gameDt;
    if (f.trailTimer <= 0) {
      f.trailTimer = CONFIG.FIGHTER_TRAIL_SAMPLE_INTERVAL;
      f.trailHistory.unshift(f.mesh.position.clone());
      if (f.trailHistory.length > CONFIG.FIGHTER_TRAIL_LENGTH) f.trailHistory.length = CONFIG.FIGHTER_TRAIL_LENGTH;
    }
    for (let i = 0; i < f.trail.length; i++) {
      const sprite = f.trail[i];
      const histPos = f.trailHistory[i];
      if (!histPos) {
        sprite.visible = false;
        continue;
      }
      const t = i / CONFIG.FIGHTER_TRAIL_LENGTH;
      sprite.visible = true;
      sprite.position.copy(histPos);
      sprite.material.opacity = (1 - t) * 0.7;
      sprite.scale.setScalar(THREE.MathUtils.lerp(4, 10, t));
    }
  }

  _spawnFighter(f, flight) {
    f.active = true;
    f.mesh.visible = true;
    f.state = 'patrol';
    f.attackPhase = null;
    f.radarLineup = false;
    f.lifeTimer = randRange(CONFIG.FIGHTER_LIFETIME_MIN, CONFIG.FIGHTER_LIFETIME_MAX);
    f.orbitAngle = Math.random() * Math.PI * 2;
    f.orbitRadius = randRange(CONFIG.FIGHTER_ORBIT_MIN, CONFIG.FIGHTER_ORBIT_MAX);
    f.patrolSpeedMult = randRange(CONFIG.FIGHTER_PATROL_SPEED_MULT_MIN, CONFIG.FIGHTER_PATROL_SPEED_MULT_MAX);
    f.altitudeOffset = randRange(CONFIG.FIGHTER_ALTITUDE_OFFSET_MIN, CONFIG.FIGHTER_ALTITUDE_OFFSET_MAX);
    f.attackTimer = randRange(this._fighterAttackMin, this._fighterAttackMax);

    // Spawns already inside the visible arc AND above the player, so it
    // reads as "appearing ahead of you, against the sky," never popping in
    // on your six or below the dashboard line. Uses _safeFlatForward, not a
    // raw flight.forward.clone().setY(0).normalize() — flight.forward can
    // be a zero vector this early (see _safeFlatForward's comment), and a
    // zero spawn bearing means the fighter spawns AT the player (dist 0)
    // with a zero f.heading that _steerFighter could never turn away from
    // on its own.
    const flatForward = this._safeFlatForward(flight);
    const bearingRad = (Math.random() * 2 - 1) * THREE.MathUtils.degToRad(CONFIG.FIGHTER_VISIBLE_ARC_DEG);
    const bearingDir = flatForward.clone().applyAxisAngle(UP, bearingRad);
    f.mesh.position
      .copy(flight.position)
      .addScaledVector(bearingDir, f.orbitRadius)
      .add(new THREE.Vector3(0, f.altitudeOffset, 0));
    f.heading.copy(flatForward);
    f._diagPrevPos.copy(f.mesh.position);
    f.bank = 0;
    f.bankVel.value = 0;
    console.log('[threats] fighter appears');
  }

  _despawnFighter(f) {
    f.active = false;
    f.mesh.visible = false;
    f.state = 'patrol';
    f.attackPhase = null;
    f.radarLineup = false;
    f.spawnTimer = randRange(CONFIG.FIGHTER_SPAWN_MIN, CONFIG.FIGHTER_SPAWN_MAX);
    for (const s of f.trail) s.visible = false;
    f.trailHistory.length = 0;
    f.trailTimer = 0;
    console.log('[threats] fighter leaves');
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
      results.push({
        type: 'fighter',
        localRight: p.right,
        localForward: p.forward,
        warning: false,
        dirRight: null,
        dirForward: null,
        trail: [],
        dodgeWindow: false,
        lineup: f.radarLineup, // ui.js draws the dot orange while true
      });
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
  // any fighter is currently threatening (in front, or mid-attack — see
  // f.threatening in _updateFighters) — main.js reads this once per frame
  // (before fear.update()) and it's what gates fear.js's calm-decay-toward-
  // floor and safety valve. Broader than "currently adding continuous fear
  // right now" on purpose: a homing missile still 2000 units out isn't yet
  // within MISSILE_CLOSE_RADIUS, but it's absolutely not calm air either.
  hasActiveThreats() {
    for (const m of this._missiles) {
      if (m.active && (m.state === 'lockon' || m.state === 'homing')) return true;
    }
    for (const f of this._fighters) {
      if (f.active && f.threatening) return true;
    }
    return false;
  }

  // T-key debug overlay (ui.js's _drawFighterDebugOverlay): per active
  // fighter, state/phase, straight-line distance, and bearing off the
  // player's nose — the numbers needed to tell "orbiting me" from
  // "wandering off" at a glance. Also reports noseDivergenceDeg, the angle
  // between the fighter's rendered nose and its ACTUAL frame-to-frame
  // displacement — this is a live sanity check on _steerFighter's core
  // invariant (nose == velocity by construction) and should read ~0 always;
  // a nonzero value here would mean something is moving f.mesh.position
  // without going through _steerFighter.
  getFighterDebugInfo(flight) {
    const flatForward = flight.forward.clone().setY(0).normalize();
    return this._fighters
      .filter((f) => f.active)
      .map((f) => {
        const toFighter = f.mesh.position.clone().sub(flight.position);
        const dist = toFighter.length();
        toFighter.setY(0);
        let angleDeg = 0;
        if (toFighter.lengthSq() > 1e-6) {
          toFighter.normalize();
          const dot = THREE.MathUtils.clamp(flatForward.dot(toFighter), -1, 1);
          let angle = Math.acos(dot);
          const cross = new THREE.Vector3().crossVectors(flatForward, toFighter);
          if (cross.y < 0) angle = -angle;
          angleDeg = THREE.MathUtils.radToDeg(angle);
        }

        const realVel = f.mesh.position.clone().sub(f._diagPrevPos);
        let noseDivergenceDeg = 0;
        if (realVel.lengthSq() > 1e-8) {
          noseDivergenceDeg = THREE.MathUtils.radToDeg(realVel.normalize().angleTo(f.heading));
        }
        f._diagPrevPos.copy(f.mesh.position);

        return {
          state: f.state,
          phase: f.attackPhase,
          dist: Math.round(dist),
          angleDeg: Math.round(angleDeg),
          noseDivergenceDeg: Math.round(noseDivergenceDeg * 10) / 10,
        };
      });
  }
}