import * as THREE from 'three';

// Stage 7A finale, part 2 (scripted landing). main.js drives this instead of
// flight.update() while route.phase === 'landing' — never touches flight.js
// (off-limits, see CLAUDE.md): camera.position/quaternion and
// flight.position/speed/stick are all plain public fields, written directly
// here. Orientation math is reimplemented locally rather than reusing
// flight.js's verified sign chain, since this is a totally different context
// (a scripted path, not player stick input) and touching that chain at all
// is exactly what CLAUDE.md warns against.
const UP = new THREE.Vector3(0, 1, 0);
const FORWARD_Z = new THREE.Vector3(0, 0, -1);

export const LANDING_DURATION = 20;
const LOWPASS_END = 12;
const FLARE_END = 15;
const ROLLOUT_DURATION = LANDING_DURATION - FLARE_END; // 5s

const LOW_PASS_ALT = 350;
const RUNWAY_ALT = 25;
const GROUND_ALT = 6;

const GEAR_DOWN_T = 9; // seconds into the sequence — during the lowpass, before the flare
const BRIDGE_T = 6; // seconds into the lowpass where the Bosphorus crossing sits — world.js aligns set dressing to this via begin()'s return value

const HUD_FADE_START = 16;
const HUD_FADE_END = 19.5;

const LOOK_YAW_MAX = THREE.MathUtils.degToRad(22);
const LOOK_PITCH_MAX = THREE.MathUtils.degToRad(14);
const LOOK_DECAY = 3.5; // per-second exponential decay on the raw stick input — flight.js's own self-centering stick decay never runs while its update() is skipped, so this file re-does it
const LOOK_SMOOTH_RATE = 8;
const CAMERA_SMOOTH_RATE = 6; // exponential slerp rate, same magnitude as flight.js's CAMERA_ROT_LAG

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// Hand-authored pitch keyframes: level cruise -> shallow nose-down for the
// descent -> leveling out -> a small flare (nose up) right at touchdown ->
// settle level for the rollout.
function pitchDegAt(t) {
  if (t < 2) return lerp(0, -6, smoothstep(0, 2, t));
  if (t < 11) return -6;
  if (t < 14) return lerp(-6, -2, smoothstep(11, 14, t));
  if (t < 15.5) return lerp(-2, 3, smoothstep(14, 15.5, t));
  if (t < 17) return lerp(3, 0, smoothstep(15.5, 17, t));
  return 0;
}

function altAt(t, startAlt) {
  if (t < LOWPASS_END) return lerp(startAlt, LOW_PASS_ALT, smoothstep(0, LOWPASS_END, t));
  if (t < FLARE_END) return lerp(LOW_PASS_ALT, RUNWAY_ALT, smoothstep(LOWPASS_END, FLARE_END, t));
  return lerp(RUNWAY_ALT, GROUND_ALT, smoothstep(FLARE_END, LANDING_DURATION, t));
}

function speedAt(t, cruiseSpeed) {
  if (t <= FLARE_END) return cruiseSpeed;
  const frac = clamp01((t - FLARE_END) / ROLLOUT_DURATION);
  return cruiseSpeed * (1 - frac) * (1 - frac);
}

// Closed-form distance traveled (integral of speedAt), computed once at
// begin() and re-evaluated per-frame from the same t — so world.js can place
// the Bosphorus/bridge/minarets/runway at the exact distances this path will
// actually pass through, with no drift between "where dressing was placed"
// and "where the camera ends up."
function distanceAt(t, cruiseSpeed) {
  if (t <= FLARE_END) return cruiseSpeed * t;
  const frac = clamp01((t - FLARE_END) / ROLLOUT_DURATION);
  const integral = frac - frac * frac + (frac * frac * frac) / 3; // /(1-f)^2 df, 0..frac
  return cruiseSpeed * FLARE_END + cruiseSpeed * ROLLOUT_DURATION * integral;
}

export class LandingSequence {
  constructor(camera) {
    this.camera = camera;
    this.active = false;
    this.done = false;
    this.hudAlpha = 1;

    this._t = 0;
    this._origin = new THREE.Vector3();
    this._forward = new THREE.Vector3(0, 0, -1);
    this._right = new THREE.Vector3(1, 0, 0);
    this._startAlt = 1000;
    this._cruiseSpeed = 300;

    this._lookYaw = 0;
    this._lookPitch = 0;
    this._pos = new THREE.Vector3();
    this._pitchEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._pitchQuat = new THREE.Quaternion();
    this._headingQuat = new THREE.Quaternion();
    this._lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._lookQuat = new THREE.Quaternion();

    this._gearPlayed = false;
    this._touchdownPlayed = false;
  }

  // Captures the current flight state as the scripted path's origin/heading —
  // call once, the instant route.phase becomes 'landing'. Returns the
  // distances world.js needs to place set dressing at the exact spots this
  // path will actually fly over.
  begin(flight) {
    this.active = true;
    this.done = false;
    this._t = 0;
    this.hudAlpha = 1;
    this._gearPlayed = false;
    this._touchdownPlayed = false;

    this._origin.copy(flight.position);
    this._forward.copy(flight.forward);
    this._forward.y = 0;
    if (this._forward.lengthSq() < 1e-6) this._forward.set(0, 0, -1);
    this._forward.normalize();
    this._right.copy(this._forward).cross(UP).normalize();
    this._startAlt = flight.altitude;
    this._cruiseSpeed = Math.max(150, flight.speed);

    // Free-look starts centered, not wherever the stick happened to be
    // sitting the instant autopilot took over.
    flight.stick.x = 0;
    flight.stick.y = 0;
    this._lookYaw = 0;
    this._lookPitch = 0;

    const touchdownDist = this._cruiseSpeed * FLARE_END;
    const rolloutDist = (this._cruiseSpeed * ROLLOUT_DURATION) / 3;
    return {
      origin: this._origin.clone(),
      forward: this._forward.clone(),
      right: this._right.clone(),
      bridgeDist: this._cruiseSpeed * BRIDGE_T,
      touchdownDist,
      totalDist: touchdownDist + rolloutDist,
    };
  }

  // main.js calls this instead of flight.update() every frame while
  // route.phase === 'landing'.
  update(dt, flight, audio) {
    if (!this.active) return;
    this._t = Math.min(LANDING_DURATION, this._t + dt);
    const t = this._t;

    if (!this._gearPlayed && t >= GEAR_DOWN_T) {
      this._gearPlayed = true;
      audio.playGearDown();
    }
    if (!this._touchdownPlayed && t >= FLARE_END) {
      this._touchdownPlayed = true;
      audio.playTouchdownThud();
    }

    const speed = speedAt(t, this._cruiseSpeed);
    const dist = distanceAt(t, this._cruiseSpeed);
    const alt = altAt(t, this._startAlt);

    this._pos.copy(this._origin).addScaledVector(this._forward, dist);
    this._pos.y = alt;
    flight.position.copy(this._pos);
    flight.speed = speed;

    // Free look: decays flight.stick itself (flight.js's own decay never
    // runs while its update() is skipped) toward a small yaw/pitch offset
    // composed on top of the scripted nose direction — decoupled from the
    // aircraft's actual heading, same idea as flight.js's own fear-driven
    // glance effect (multiply onto the nose quaternion, not replace it).
    const rawDecay = Math.exp(-LOOK_DECAY * dt);
    flight.stick.x *= rawDecay;
    flight.stick.y *= rawDecay;
    const targetYaw = THREE.MathUtils.clamp(flight.stick.x, -1, 1) * LOOK_YAW_MAX;
    const targetPitch = THREE.MathUtils.clamp(-flight.stick.y, -1, 1) * LOOK_PITCH_MAX;
    const lookT = 1 - Math.exp(-LOOK_SMOOTH_RATE * dt);
    this._lookYaw = lerp(this._lookYaw, targetYaw, lookT);
    this._lookPitch = lerp(this._lookPitch, targetPitch, lookT);

    this._pitchEuler.set(THREE.MathUtils.degToRad(pitchDegAt(t)), 0, 0);
    this._pitchQuat.setFromEuler(this._pitchEuler);
    this._headingQuat.setFromUnitVectors(FORWARD_Z, this._forward);
    // headingQuat * pitchQuat: pitch applied first in the -Z reference frame,
    // then rotated to point along the scripted heading.
    this._pitchQuat.premultiply(this._headingQuat);

    this._lookEuler.set(this._lookPitch, this._lookYaw, 0);
    this._lookQuat.setFromEuler(this._lookEuler);
    this._pitchQuat.multiply(this._lookQuat);

    const camT = 1 - Math.exp(-CAMERA_SMOOTH_RATE * dt);
    this.camera.quaternion.slerp(this._pitchQuat, camT);
    this.camera.position.copy(this._pos);

    this.hudAlpha = 1 - smoothstep(HUD_FADE_START, HUD_FADE_END, t);

    if (t >= LANDING_DURATION) {
      this.active = false;
      this.done = true;
    }
  }
}
