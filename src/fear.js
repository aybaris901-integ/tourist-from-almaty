// Central fear-meter state. Pure state + thresholds — no rendering/audio
// code here. Every other system (flight, cockpit, ui, postfx, audio) reads
// fear.value / fear.intensity(threshold) / fear.panicActive and implements
// its own reaction. All tuning knobs for every layer live in CONFIG so the
// whole feedback system can be balanced from this one file.
export const CONFIG = {
  MIN: 0,
  MAX: 100,
  DEBUG_STEP: 10,

  // Economy: fear only ever RISES from an actual threat (missile lock-on,
  // missile-close proximity, fighter presence, hits — all still driven by
  // threats.js's own addContinuous/addInstant calls, unchanged). There is no
  // flat ambient rise anymore — waiting is not what kills you. Whenever
  // threats.hasActiveThreats() is false ("genuinely calm air"), fear instead
  // DECAYS at CALM_DECAY_PER_SEC toward a floor that never lets the player
  // fully relax and gets a little higher deeper into the route:
  // floor = min(FEAR_FLOOR_BASE + FEAR_FLOOR_PER_WAVE*waveIndex, FEAR_FLOOR_MAX).
  CALM_DECAY_PER_SEC: 1.5,
  FEAR_FLOOR_BASE: 15,
  FEAR_FLOOR_PER_WAVE: 10,
  FEAR_FLOOR_MAX: 45,

  // Safety valve: fear > 85 with nothing actually attacking is an edge case
  // (e.g. a fight ends right as fear peaked, decay hasn't caught up yet) —
  // guarantee a radio lifeline rather than let the player panic from
  // nothing. See onSafetyValve (route.js wires it to radio.forceCallSoon).
  SAFETY_VALVE_THRESHOLD: 85,
  SAFETY_VALVE_CALL_DELAY: 3,

  THRESHOLDS: {
    SHAKE: 20, // camera micro-shake, stick tremble, input noise
    HUD_GLITCH: 40, // HUD flicker/garbage values, breathing audio
    VIGNETTE: 60, // vignette + chromatic aberration, sloppier controls
    WARP: 80, // screen warp, heartbeat audio, HUD near-unreadable
    PANIC: 100, // blackout + country restart — the failure state
  },

  PANIC_DURATION: 2, // seconds of blackout before the panic card/restart
  PANIC_RESET_VALUE: 40, // shaken, not reset to zero — this is a failure state, not a free pass

  // 20+: camera micro-shake / 3D stick tremble / noisy stick input.
  SHAKE_MAX_POSITION: 0.03, // camera jitter, world units, at fear=100
  SHAKE_MAX_ROTATION: 0.012, // camera jitter, radians, at fear=100
  STICK_TREMBLE_MAX: 0.09, // radians the visual cockpit stick trembles
  INPUT_NOISE_MAX: 0.1, // radians of noise added to pitch/roll targets

  // 40+: HUD flicker/garbage values, breathing audio fade-in.
  HUD_FLICKER_ALPHA: 0.5, // how far readout opacity can dip while flickering
  HUD_GLITCH_CHANCE_PER_SEC: 1.6, // avg garbage-value bursts/sec at fear=100
  HUD_GLITCH_DURATION: 0.2,
  BREATH_MAX_GAIN: 0.35,
  BREATH_FADE_TIME: 1.2,

  // 60+: vignette + chromatic aberration, sloppier controls (lag + drift).
  VIGNETTE_MAX: 0.85,
  ABERRATION_MAX: 0.006,
  CONTROL_SLOP_MAX: 0.2, // extra fraction of smoothing time at fear=100
  DRIFT_MAX_ANGLE: 0.05, // radians of uncommanded wander at fear=100

  // 80+: screen warp, heartbeat audio, HUD mostly unreadable.
  WARP_MAX: 0.012,
  WARP_SPEED: 1.6,
  HEARTBEAT_MAX_GAIN: 0.5,
  HEARTBEAT_MIN_INTERVAL: 0.7, // seconds between thumps at fear=100
  HEARTBEAT_MAX_INTERVAL: 1.15, // seconds between thumps at the 80 threshold
  HUD_UNREADABLE_JITTER: 6, // px of extra text jitter at fear=100

  // 80+: eyes drift toward the bottle on the dash. Negative pitch = look
  // down, negative yaw = look right (see flight.js's sign convention notes).
  GLANCE_PITCH_DEG: -6,
  GLANCE_YAW_DEG: -4,
  GLANCE_SMOOTH_TIME: 1.4,
};

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function fmt(n) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;
}

export class Fear {
  constructor() {
    this.value = 0;
    this.panicActive = false;
    this.panicTimer = 0;
    this.floor = CONFIG.FEAR_FLOOR_BASE; // recomputed every update(); ui.js's debug overlay reads this directly

    // route.js wires both: onPanic fires the instant fear hits 100 (blackout
    // begins — panicActive itself already freezes flight input, see
    // flight.js's fail-soft branches, and keeps the heartbeat pinned at max
    // via intensity(WARP)); onPanicResolved fires PANIC_DURATION later, once
    // value has been reset, to actually run the country-restart sequence.
    this.onPanic = null;
    this.onPanicResolved = null;
    // Safety valve (see CONFIG.SAFETY_VALVE_THRESHOLD) — route.js wires this
    // to radio.forceCallSoon().
    this.onSafetyValve = null;
    this._safetyValveArmed = false; // edge-triggers once per high-fear-while-calm episode

    // Frozen (default true — main.js's MENU state) means every mutation
    // entry point below is a no-op. main.js flips this false on entering
    // FLYING. This exists specifically so the debug [ / ] keys (bound right
    // here, independent of whether main.js's game loop calls update()) can't
    // move fear off 0 while still in the menu.
    this.frozen = true;

    // Continuous sources (lock-on, proximity, fighter presence, calm
    // decay...) are batched and flushed once/sec so tuning logs stay
    // readable instead of spamming a line every frame.
    this._logAccum = {};
    this._logTimer = 0;

    // Which continuous sources touched fear THIS frame — cleared at the top
    // of update(), populated by addContinuous() calls later in the same
    // frame (threats.js runs after fear.update() in main.js's loop), read by
    // ui.js's debug overlay (D key) right before it draws. Deliberately
    // excludes one-off addInstant() events (hits, dodges...) — this is about
    // ongoing economy forces, not momentary spikes.
    this._activeSources = new Set();

    this._bindDebugKeys();
  }

  _bindDebugKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'BracketLeft') this.addInstant('debug', -CONFIG.DEBUG_STEP);
      if (e.code === 'BracketRight') this.addInstant('debug', CONFIG.DEBUG_STEP);
    });
  }

  // Immediate, discrete fear change (missile hit, dodge, radio answer...).
  // Rare/meaningful enough to log the instant it happens.
  addInstant(source, amount) {
    if (this.frozen) return;
    this.value = clamp(this.value + amount, CONFIG.MIN, CONFIG.MAX);
    console.log(`[fear] ${source} ${fmt(amount)} -> ${this.value.toFixed(1)}`);
    this._checkPanic();
  }

  // Continuous per-second rate (lock-on, proximity, fighter presence, calm
  // decay...). Applied every frame; logged in the once/sec batch via
  // _flushLog, and tracked in _activeSources for the debug overlay.
  addContinuous(source, perSecond, dt) {
    if (this.frozen) return;
    const amount = perSecond * dt;
    this.value = clamp(this.value + amount, CONFIG.MIN, CONFIG.MAX);
    this._logAccum[source] = (this._logAccum[source] || 0) + amount;
    this._activeSources.add(source);
    this._checkPanic();
  }

  // Absolute set (panic reset, country restart...), still logged with the
  // effective delta for tuning visibility.
  setAbsolute(source, value) {
    if (this.frozen) return;
    const before = this.value;
    this.value = clamp(value, CONFIG.MIN, CONFIG.MAX);
    console.log(`[fear] ${source} set -> ${this.value.toFixed(1)} (${fmt(this.value - before)})`);
  }

  _checkPanic() {
    if (this.panicActive || this.value < CONFIG.THRESHOLDS.PANIC) return;
    this.panicActive = true;
    this.panicTimer = CONFIG.PANIC_DURATION;
    console.log('[fear] PANIC triggered — blackout');
    this.onPanic?.();
  }

  get normalized() {
    return this.value / CONFIG.MAX;
  }

  // ui.js's debug overlay (D key) — continuous sources that touched fear
  // this frame (see _activeSources / update()).
  get activeSources() {
    return Array.from(this._activeSources);
  }

  // 0 at `threshold`, ramping to 1 as value approaches MAX. Used by every
  // consuming system to scale its own effect strength for that layer.
  intensity(threshold) {
    return clamp((this.value - threshold) / (CONFIG.MAX - threshold), 0, 1);
  }

  // Solid black for the full blackout, not a sine pulse — this is a failure
  // state now, not a soft flinch. main.js drives the #blackout div opacity
  // from this every frame.
  get panicBlackAlpha() {
    return this.panicActive ? 1 : 0;
  }

  // `threatsActive` (threats.hasActiveThreats(), from main.js) gates the
  // calm decay and safety valve below; `waveIndex` (route.waveIndex) sets
  // this update's floor. Both reflect the END of the PREVIOUS frame's
  // threats/route state (main.js calls this before route.update()/
  // threats.update() run for the current frame) — a one-frame lag that
  // doesn't matter for a per-second economy.
  update(dt, threatsActive, waveIndex) {
    this._activeSources.clear();
    this.floor = Math.min(CONFIG.FEAR_FLOOR_BASE + CONFIG.FEAR_FLOOR_PER_WAVE * waveIndex, CONFIG.FEAR_FLOOR_MAX);

    if (this.panicActive) {
      this.panicTimer -= dt;
      if (this.panicTimer <= 0) {
        this.panicActive = false;
        this.panicTimer = 0;
        this.setAbsolute('panic-reset', CONFIG.PANIC_RESET_VALUE);
        this.onPanicResolved?.();
      }
      return;
    }

    if (!threatsActive && this.value > this.floor) {
      // Decay toward the floor, never past it in one step.
      const decayed = Math.max(this.floor, this.value - CONFIG.CALM_DECAY_PER_SEC * dt);
      const delta = decayed - this.value;
      this.value = decayed;
      this._logAccum['calm-decay'] = (this._logAccum['calm-decay'] || 0) + delta;
      this._activeSources.add('calm-decay');
    }

    if (!this.frozen && !threatsActive && this.value > CONFIG.SAFETY_VALVE_THRESHOLD) {
      if (!this._safetyValveArmed) {
        this._safetyValveArmed = true;
        console.log('[fear] safety valve: high fear with no active threat — forcing a radio call');
        this.onSafetyValve?.();
      }
    } else {
      this._safetyValveArmed = false;
    }

    this._logTimer += dt;
    if (this._logTimer >= 1) {
      this._flushLog();
      this._logTimer = 0;
    }
  }

  _flushLog() {
    const entries = Object.entries(this._logAccum).filter(([, v]) => Math.abs(v) > 0.01);
    if (entries.length) {
      const summary = entries.map(([k, v]) => `${k} ${fmt(v)}`).join(', ');
      console.log(`[fear] ${summary} -> value=${this.value.toFixed(1)}`);
    }
    this._logAccum = {};
  }
}