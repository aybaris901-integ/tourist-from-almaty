import { CONFIG as FEAR_CONFIG } from './fear.js';

const LOCK_BEEP_INTERVAL_START = 0.45; // seconds between RWR beeps at lock-on progress=0
const LOCK_BEEP_INTERVAL_END = 0.12; // ...at progress=1 (about to launch)

// Post-launch "inbound" ping: lower-pitched than the lock-on beep (700Hz vs
// 1400-1800Hz) so the two are distinguishable by ear — still locking vs.
// already flying at you — and ramps louder/faster as the missile closes,
// same shape as the lock-on ramp but driven by distance instead of a timer.
const APPROACH_PING_FREQ = 700;
const APPROACH_INTERVAL_FAR = 0.6;
const APPROACH_INTERVAL_NEAR = 0.15;
const APPROACH_GAIN_FAR = 0.15;
const APPROACH_GAIN_NEAR = 0.45;

// Procedural placeholder audio, no asset downloads: breathing/heartbeat tied
// to the fear meter, plus threat/radio one-shots (RWR lock tone, whoosh,
// impact thud, radio blip). Everything is synthesized with the Web Audio API.
export class FearAudio {
  constructor() {
    this.ctx = null;
    this._started = false;
    this._heartbeatTimer = 0;

    this._lockActive = false;
    this._lockProgress = 0;
    this._lockPan = 0;
    this._lockBeepTimer = 0;

    this._approachActive = false;
    this._approachProximity = 0;
    this._approachPan = 0;
    this._approachTimer = 0;
  }

  // AudioContext must be created/resumed from a user gesture; call this from
  // a click handler.
  resume() {
    if (!this._started) {
      this._started = true;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this._buildNoiseBuffer();
      this._buildBreathing();
      this._buildHeartbeatBus();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  _buildNoiseBuffer() {
    const ctx = this.ctx;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this._noiseBuffer = buffer;
  }

  _buildBreathing() {
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = this._noiseBuffer;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 380;

    this._breathGain = ctx.createGain();
    this._breathGain.gain.value = 0;

    source.connect(filter);
    filter.connect(this._breathGain);
    this._breathGain.connect(ctx.destination);
    source.start();
  }

  _buildHeartbeatBus() {
    this._heartbeatBus = this.ctx.createGain();
    this._heartbeatBus.gain.value = 0;
    this._heartbeatBus.connect(this.ctx.destination);
  }

  _playThump(bus, startFreq, endFreq, duration) {
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(endFreq, now + duration * 0.5);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(1, now + duration * 0.06);
    env.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(env);
    env.connect(bus);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  // 20-ish ms sine blip, used for the RWR lock-on beep and the post-launch
  // approach ping. `pan` (-1 full left .. +1 full right) is bearing-relative
  // to the player's own nose, not compass — a fresh StereoPannerNode per
  // call since each beep is already a fresh oscillator/gain pair.
  _playBeep(freq, gain = 0.3, pan = 0) {
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(gain, now + 0.005);
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.07);

    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));

    osc.connect(env);
    env.connect(panner);
    panner.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.08);
  }

  // RWR-style beeping ramp: call update each frame with 0..1 lock progress
  // and the current bearing pan; beep interval shrinks as launch approaches.
  // stopLockTone() when it ends.
  startLockTone() {
    this._lockActive = true;
    this._lockBeepTimer = 0;
  }

  updateLockTone(progress, pan = 0) {
    if (!this._started || !this._lockActive) return;
    this._lockProgress = progress;
    this._lockPan = pan;
  }

  stopLockTone() {
    this._lockActive = false;
  }

  // Post-launch inbound ping. startApproachPing() is idempotent (won't reset
  // the beep rhythm every frame just because a homing missile is still
  // present) — call it every frame a homing missile exists; only the FIRST
  // call while inactive actually (re)starts the ramp.
  startApproachPing() {
    if (this._approachActive) return;
    this._approachActive = true;
    this._approachTimer = 0;
  }

  updateApproachPing(pan, proximity) {
    if (!this._started || !this._approachActive) return;
    this._approachPan = pan;
    this._approachProximity = proximity;
  }

  stopApproachPing() {
    this._approachActive = false;
  }

  playWhoosh() {
    if (!this._started) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const duration = 0.4;

    const source = ctx.createBufferSource();
    source.buffer = this._noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 0.7;
    filter.frequency.setValueAtTime(1800, now);
    filter.frequency.exponentialRampToValueAtTime(220, now + duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.5, now + 0.03);
    env.gain.exponentialRampToValueAtTime(0.001, now + duration);

    source.connect(filter);
    filter.connect(env);
    env.connect(ctx.destination);
    source.start(now);
    source.stop(now + duration + 0.02);
  }

  playImpactThud() {
    if (!this._started) return;
    this._playThump(this.ctx.destination, 90, 35, 0.35);
  }

  playRadioBlip() {
    if (!this._started) return;
    const ctx = this.ctx;
    const start = ctx.currentTime;
    const blips = 4 + Math.floor(Math.random() * 3);

    for (let i = 0; i < blips; i++) {
      const t = start + i * 0.09 + Math.random() * 0.02;
      const source = ctx.createBufferSource();
      source.buffer = this._noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 900 + Math.random() * 500;
      filter.Q.value = 4;

      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.25, t + 0.01);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.06);

      source.connect(filter);
      filter.connect(env);
      env.connect(ctx.destination);
      source.start(t);
      source.stop(t + 0.08);
    }
  }

  update(dt, fear) {
    if (!this._started) return;
    const now = this.ctx.currentTime;

    const breathIntensity = fear.intensity(FEAR_CONFIG.THRESHOLDS.HUD_GLITCH);
    this._breathGain.gain.setTargetAtTime(
      breathIntensity * FEAR_CONFIG.BREATH_MAX_GAIN,
      now,
      FEAR_CONFIG.BREATH_FADE_TIME * 0.3
    );

    const heartIntensity = fear.intensity(FEAR_CONFIG.THRESHOLDS.WARP);
    this._heartbeatBus.gain.setTargetAtTime(heartIntensity * FEAR_CONFIG.HEARTBEAT_MAX_GAIN, now, 0.2);

    if (heartIntensity > 0) {
      this._heartbeatTimer -= dt;
      if (this._heartbeatTimer <= 0) {
        this._playThump(this._heartbeatBus, 70, 38, 0.22);
        const interval =
          FEAR_CONFIG.HEARTBEAT_MAX_INTERVAL -
          (FEAR_CONFIG.HEARTBEAT_MAX_INTERVAL - FEAR_CONFIG.HEARTBEAT_MIN_INTERVAL) * heartIntensity;
        this._heartbeatTimer = interval;
      }
    } else {
      this._heartbeatTimer = 0;
    }

    if (this._lockActive) {
      this._lockBeepTimer -= dt;
      if (this._lockBeepTimer <= 0) {
        this._playBeep(1400 + this._lockProgress * 400, 0.3, this._lockPan);
        this._lockBeepTimer =
          LOCK_BEEP_INTERVAL_START - (LOCK_BEEP_INTERVAL_START - LOCK_BEEP_INTERVAL_END) * this._lockProgress;
      }
    }

    if (this._approachActive) {
      this._approachTimer -= dt;
      if (this._approachTimer <= 0) {
        const gain = APPROACH_GAIN_FAR + (APPROACH_GAIN_NEAR - APPROACH_GAIN_FAR) * this._approachProximity;
        this._playBeep(APPROACH_PING_FREQ, gain, this._approachPan);
        this._approachTimer =
          APPROACH_INTERVAL_FAR - (APPROACH_INTERVAL_FAR - APPROACH_INTERVAL_NEAR) * this._approachProximity;
      }
    }
  }
}