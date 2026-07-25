// ART PASSES MUST NOT TOUCH THIS FILE OR CAMERA PARENTING
//
// The roll/pitch/yaw sign chain here (input mapping -> targetRoll ->
// bank-to-turn yaw -> nose quaternion -> camera.quaternion) was deliberately
// re-derived and verified correct. A visual-only change (cockpit meshes,
// lighting, a new group between camera and scene, a scale on that group)
// can silently invert perceived roll without touching a single sign in this
// file, because roll direction depends on: (a) this file's math, AND
// (b) the camera being a direct, unscaled child of `scene` with no rotated
// parent in between (see main.js). If steering ever looks inverted again,
// check camera parenting/scale FIRST, then diff this file — do not "fix" it
// by flipping a sign or toggling CONFIG.INVERT_ROLL here.
import * as THREE from 'three';
import { smoothDamp } from './utils.js';
import { CONFIG as FEAR_CONFIG } from './fear.js';

const BASE_SPEED = 250; // units/s
const THROTTLE_MIN = 0.7;
const THROTTLE_MAX = 1.4;
const THROTTLE_RAMP_TIME = 1.6; // seconds to go from 0 to full throttle input

const MAX_PITCH = THREE.MathUtils.degToRad(45);
const MAX_ROLL = THREE.MathUtils.degToRad(60);
const TURN_RATE = 0.7; // yaw rad/s induced per radian of roll (bank-to-turn)

const STICK_DECAY = 3.5; // per-second return-to-center rate
const MOUSE_SENSITIVITY = 0.0022;
const KEY_STICK_RATE = 1.6; // per-second stick deflection from arrow keys

const PITCH_SMOOTH_TIME = 0.35;
const ROLL_SMOOTH_TIME = 0.28;
const THROTTLE_SMOOTH_TIME = 0.7;
const AUTO_LEVEL_SMOOTH_TIME = 0.5; // panic recovery: snap pitch/roll back to level

const TUMBLE_SPIN_RATE = THREE.MathUtils.degToRad(260); // roll spin while tumbling, rad/s
const TUMBLE_YAW_RATE = THREE.MathUtils.degToRad(150);
const TUMBLE_PITCH_AMPLITUDE = THREE.MathUtils.degToRad(30);
const TUMBLE_PITCH_FREQ = 2.3;

const CAMERA_ROT_LAG = 7.5; // higher = less lag, exponential smoothing rate

const ALT_MIN = 500;
const ALT_MAX = 4000;
const ALT_SOFT_MARGIN = 450;
const ALT_MAX_BIAS = THREE.MathUtils.degToRad(22);

// User-configurable axis inversion. Applied at the raw-input mapping stage
// (see _bindInput / _updateStick) so every downstream stage (roll angle,
// camera tilt, bank-to-turn yaw) only ever consumes an already-correct sign.
export const CONFIG = {
  INVERT_ROLL: false,
  INVERT_PITCH: false,
};

export class Flight {
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;

    this.position = new THREE.Vector3(0, 2000, 0);
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.speed = BASE_SPEED;

    this._pitchVel = { value: 0 };
    this._rollVel = { value: 0 };
    this._throttleVel = { value: 0 };

    this.stick = { x: 0, y: 0 };
    // Start throttle so the default multiplier is ~1.0 (neutral cruise speed).
    this._throttleInput = (1 - THROTTLE_MIN) / (THROTTLE_MAX - THROTTLE_MIN);
    this._throttleCurrent = this._throttleInput;

    this.keys = new Set();
    this._pointerLocked = false;

    this._forwardQuat = new THREE.Quaternion();
    this._noseQuat = new THREE.Quaternion();
    this._noseEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._forwardEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._forward = new THREE.Vector3();
    this._shakeEuler = new THREE.Euler();
    this._shakeQuat = new THREE.Quaternion();
    this._driftPhase = 0;

    this._glanceAmt = 0;
    this._glanceVel = { value: 0 };
    this._glanceEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._glanceQuat = new THREE.Quaternion();

    this.tumbleActive = false;
    this.tumbleTimer = 0;
    this._tumbleClock = 0;

    this._impactShakeTimer = 0;
    this._impactShakeDuration = 0;
    this._impactShakeMag = 0;

    this.camera.position.copy(this.position);

    this._bindInput();
  }

  _bindInput() {
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    this.domElement.addEventListener('click', () => {
      this.domElement.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this._pointerLocked = document.pointerLockElement === this.domElement;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this._pointerLocked) return;
      const rollSign = CONFIG.INVERT_ROLL ? 1 : -1;
      const pitchSign = CONFIG.INVERT_PITCH ? -1 : 1;
      this.stick.x += rollSign * e.movementX * MOUSE_SENSITIVITY;
      this.stick.y += pitchSign * e.movementY * MOUSE_SENSITIVITY;
      this.stick.x = THREE.MathUtils.clamp(this.stick.x, -1, 1);
      this.stick.y = THREE.MathUtils.clamp(this.stick.y, -1, 1);
    });
  }

  get isPointerLocked() {
    return this._pointerLocked;
  }

  get forward() {
    return this._forward;
  }

  // Getting hit: big screen shake + a chaotic 2s spin before auto-recovering.
  triggerTumble(duration) {
    this.tumbleActive = true;
    this.tumbleTimer = duration;
    this._tumbleClock = 0;
  }

  triggerImpactShake(duration, magnitude) {
    this._impactShakeTimer = duration;
    this._impactShakeDuration = duration;
    this._impactShakeMag = magnitude;
  }

  update(dt, fear) {
    if (dt <= 0) return;
    if (this.tumbleActive) {
      this.tumbleTimer -= dt;
      if (this.tumbleTimer <= 0) {
        this.tumbleActive = false;
        // Roll accumulated many full turns during the spin; wrap it back to
        // an equivalent angle (visually identical) and clear stale smoothDamp
        // velocity so the post-tumble recovery eases in at a normal rate
        // instead of lurching to cover a huge numeric distance.
        this.roll = THREE.MathUtils.euclideanModulo(this.roll + Math.PI, Math.PI * 2) - Math.PI;
        this._rollVel.value = 0;
        this._pitchVel.value = 0;
      }
    }
    if (this._impactShakeTimer > 0) {
      this._impactShakeTimer = Math.max(0, this._impactShakeTimer - dt);
    }

    this._updateStick(dt, fear);
    this._updateThrottle(dt);
    this._updateOrientation(dt, fear);
    this._updatePosition(dt);
    this._updateCamera(dt, fear);
  }

  _updateStick(dt, fear) {
    if (this.tumbleActive || fear.panicActive) {
      // Tumble/auto-level take full control; don't let residual input snap
      // back in once they end.
      this.stick.x = 0;
      this.stick.y = 0;
      return;
    }

    const k = this.keys;
    let kx = 0;
    let ky = 0;
    if (k.has('ArrowLeft')) kx -= 1;
    if (k.has('ArrowRight')) kx += 1;
    if (k.has('ArrowUp')) ky -= 1;
    if (k.has('ArrowDown')) ky += 1;

    // Decay toward center (self-centering stick), then apply any key deflection.
    // Same rollSign/pitchSign convention as the mousemove mapping in _bindInput.
    const rollSign = CONFIG.INVERT_ROLL ? 1 : -1;
    const pitchSign = CONFIG.INVERT_PITCH ? -1 : 1;
    const decay = Math.exp(-STICK_DECAY * dt);
    this.stick.x *= decay;
    this.stick.y *= decay;
    this.stick.x += rollSign * kx * KEY_STICK_RATE * dt;
    this.stick.y += pitchSign * ky * KEY_STICK_RATE * dt;
    this.stick.x = THREE.MathUtils.clamp(this.stick.x, -1, 1);
    this.stick.y = THREE.MathUtils.clamp(this.stick.y, -1, 1);
  }

  _updateThrottle(dt) {
    const k = this.keys;
    if (k.has('KeyW') || k.has('ShiftLeft') || k.has('ShiftRight')) {
      this._throttleInput = Math.min(1, this._throttleInput + dt / THROTTLE_RAMP_TIME);
    }
    if (k.has('KeyS') || k.has('ControlLeft') || k.has('ControlRight')) {
      this._throttleInput = Math.max(0, this._throttleInput - dt / THROTTLE_RAMP_TIME);
    }
    this._throttleCurrent = smoothDamp(
      this._throttleCurrent,
      this._throttleInput,
      this._throttleVel,
      THROTTLE_SMOOTH_TIME,
      dt
    );
    const multiplier = THROTTLE_MIN + this._throttleCurrent * (THROTTLE_MAX - THROTTLE_MIN);
    this.speed = BASE_SPEED * multiplier;
  }

  _updateOrientation(dt, fear) {
    if (this.tumbleActive) {
      // Chaotic uncontrolled spin; smoothDamp naturally eases pitch/roll back
      // toward the player's actual target once tumbleActive clears, so no
      // special-cased recovery blend is needed here.
      this._tumbleClock += dt;
      this.roll += TUMBLE_SPIN_RATE * dt;
      this.pitch = Math.sin(this._tumbleClock * TUMBLE_PITCH_FREQ) * TUMBLE_PITCH_AMPLITUDE;
      this.yaw += TUMBLE_YAW_RATE * dt;
      return;
    }

    if (fear.panicActive) {
      // Fail-soft: ignore input, snap wings/nose level, hold heading.
      this.pitch = smoothDamp(this.pitch, 0, this._pitchVel, AUTO_LEVEL_SMOOTH_TIME, dt);
      this.roll = smoothDamp(this.roll, 0, this._rollVel, AUTO_LEVEL_SMOOTH_TIME, dt);
      return;
    }

    let targetPitch = -this.stick.y * MAX_PITCH;
    let targetRoll = this.stick.x * MAX_ROLL;

    // Soft altitude limits: bias the pitch target back toward safe altitude
    // near the edges of the band. Never a hard clamp on position.
    const alt = this.position.y;
    if (alt < ALT_MIN + ALT_SOFT_MARGIN) {
      const t = THREE.MathUtils.clamp((ALT_MIN + ALT_SOFT_MARGIN - alt) / ALT_SOFT_MARGIN, 0, 1);
      targetPitch += t * t * ALT_MAX_BIAS;
    } else if (alt > ALT_MAX - ALT_SOFT_MARGIN) {
      const t = THREE.MathUtils.clamp((alt - (ALT_MAX - ALT_SOFT_MARGIN)) / ALT_SOFT_MARGIN, 0, 1);
      targetPitch -= t * t * ALT_MAX_BIAS;
    }

    // 20+: tiny high-frequency noise on the input itself.
    const noiseAmp = FEAR_CONFIG.INPUT_NOISE_MAX * fear.intensity(FEAR_CONFIG.THRESHOLDS.SHAKE);
    if (noiseAmp > 0) {
      targetPitch += (Math.random() - 0.5) * 2 * noiseAmp;
      targetRoll += (Math.random() - 0.5) * 2 * noiseAmp;
    }

    // 60+: slow uncommanded drift layered on top of the noise.
    const driftIntensity = fear.intensity(FEAR_CONFIG.THRESHOLDS.VIGNETTE);
    if (driftIntensity > 0) {
      this._driftPhase += dt;
      const driftAmp = FEAR_CONFIG.DRIFT_MAX_ANGLE * driftIntensity;
      targetPitch += Math.sin(this._driftPhase * 0.6) * Math.sin(this._driftPhase * 0.23 + 1.7) * driftAmp;
      targetRoll += Math.sin(this._driftPhase * 0.5 + 2.1) * Math.sin(this._driftPhase * 0.31) * driftAmp;
    }

    targetPitch = THREE.MathUtils.clamp(targetPitch, -MAX_PITCH, MAX_PITCH);

    // 60+: sloppier controls — extra smoothing lag on top of the base feel.
    const slop = 1 + FEAR_CONFIG.CONTROL_SLOP_MAX * driftIntensity;

    this.pitch = smoothDamp(this.pitch, targetPitch, this._pitchVel, PITCH_SMOOTH_TIME * slop, dt);
    this.roll = smoothDamp(this.roll, targetRoll, this._rollVel, ROLL_SMOOTH_TIME * slop, dt);

    // Bank-to-turn: roll angle induces a yaw rate, no direct yaw input needed.
    // Positive roll = left bank (right-vector's Y component is sin(roll)>0,
    // i.e. right wing rises), which must curve the heading left, i.e. yaw up.
    this.yaw += this.roll * TURN_RATE * dt;
  }

  _updatePosition(dt) {
    this._forwardEuler.set(this.pitch, this.yaw, 0);
    this._forwardQuat.setFromEuler(this._forwardEuler);
    this._forward.set(0, 0, -1).applyQuaternion(this._forwardQuat);
    this.position.addScaledVector(this._forward, this.speed * dt);
  }

  _updateCamera(dt, fear) {
    this._noseEuler.set(this.pitch, this.yaw, this.roll);
    this._noseQuat.setFromEuler(this._noseEuler);

    const t = 1 - Math.exp(-CAMERA_ROT_LAG * dt);
    this.camera.quaternion.slerp(this._noseQuat, t);
    this.camera.position.copy(this.position);

    // 80+: eyes drift toward the bottle on the dash. Eased with its own
    // smoothDamp (not fear.intensity directly) so an instant fear spike
    // crossing the threshold doesn't snap the view — it drifts in.
    const glanceTarget = fear.intensity(FEAR_CONFIG.THRESHOLDS.WARP);
    this._glanceAmt = smoothDamp(this._glanceAmt, glanceTarget, this._glanceVel, FEAR_CONFIG.GLANCE_SMOOTH_TIME, dt);
    if (this._glanceAmt > 0.001) {
      this._glanceEuler.set(
        THREE.MathUtils.degToRad(FEAR_CONFIG.GLANCE_PITCH_DEG) * this._glanceAmt,
        THREE.MathUtils.degToRad(FEAR_CONFIG.GLANCE_YAW_DEG) * this._glanceAmt,
        0
      );
      this._glanceQuat.setFromEuler(this._glanceEuler);
      this.camera.quaternion.multiply(this._glanceQuat);
    }

    // 20+: micro-shake, applied fresh each frame (not smoothed/accumulated)
    // so it reads as a crisp tremor rather than a damped wobble.
    const shakeIntensity = fear.intensity(FEAR_CONFIG.THRESHOLDS.SHAKE);
    if (shakeIntensity > 0) {
      const posAmp = FEAR_CONFIG.SHAKE_MAX_POSITION * shakeIntensity;
      const rotAmp = FEAR_CONFIG.SHAKE_MAX_ROTATION * shakeIntensity;
      this.camera.position.x += (Math.random() - 0.5) * 2 * posAmp;
      this.camera.position.y += (Math.random() - 0.5) * 2 * posAmp;
      this.camera.position.z += (Math.random() - 0.5) * 2 * posAmp;
      this._shakeEuler.set(
        (Math.random() - 0.5) * 2 * rotAmp,
        (Math.random() - 0.5) * 2 * rotAmp,
        (Math.random() - 0.5) * 2 * rotAmp
      );
      this._shakeQuat.setFromEuler(this._shakeEuler);
      this.camera.quaternion.multiply(this._shakeQuat);
    }

    // Getting hit: a big, separate shake that decays over its own duration,
    // additive on top of the fear-driven shake above.
    if (this._impactShakeTimer > 0) {
      const decay = this._impactShakeTimer / this._impactShakeDuration;
      const posAmp = this._impactShakeMag * decay;
      this.camera.position.x += (Math.random() - 0.5) * 2 * posAmp;
      this.camera.position.y += (Math.random() - 0.5) * 2 * posAmp;
      this.camera.position.z += (Math.random() - 0.5) * 2 * posAmp;
      this._shakeEuler.set(
        (Math.random() - 0.5) * 2 * posAmp * 0.3,
        (Math.random() - 0.5) * 2 * posAmp * 0.3,
        (Math.random() - 0.5) * 2 * posAmp * 0.3
      );
      this._shakeQuat.setFromEuler(this._shakeEuler);
      this.camera.quaternion.multiply(this._shakeQuat);
    }
  }

  get altitude() {
    return this.position.y;
  }
}