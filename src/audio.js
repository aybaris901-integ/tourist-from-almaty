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

// --- Music -------------------------------------------------------------
// One synthesized, looping motif per country — no asset downloads, same
// "procedural over asset" rule as the 3D art (see CLAUDE.md). Crossfades
// MUSIC_CROSSFADE seconds on setMusicCountry() (route.js, on every wave
// change); ducks by MUSIC_DUCK_GAIN while a radio call is active
// (setMusicDucked(), called from radio.js's _startCall/_endCall); gets
// muffled (lowpassed) as fear climbs past the VIGNETTE(60) threshold — see
// update()'s `_musicFilter` handling. This is "the world" going muffled,
// deliberately NOT applied to the lock-tone/approach-ping/heartbeat, which
// need to stay piercing as warnings regardless of how scared you are.
const MUSIC_CROSSFADE = 3;
const MUSIC_LOOKAHEAD = 0.6; // seconds of notes scheduled ahead, per update()
const MUSIC_DUCK_GAIN = Math.pow(10, -6 / 20); // -6dB while radio.active
const MUSIC_MUFFLE_MIN_CUTOFF = 500; // lowpass Hz at fear=100
const MUSIC_MUFFLE_MAX_CUTOFF = 18000; // effectively unfiltered

// Each voice: rootFreq (Hz) + bpm define the grid; `pattern` is
// [semitoneOffsetFromRoot|null, beats][] (null = rest); `style` picks the
// envelope shape ('pluck' = fast attack/decay for dombra/saz, 'sustain' =
// held for duduk/mugham legato); `gain` is the per-note peak; `lowpass`/
// `vibrato`/`detuneCents` are optional per-instrument color.
const COUNTRY_MUSIC = {
  // Dombra-ish: plucky pentatonic minor, syncopated.
  kazakhstan: {
    voices: [
      {
        rootFreq: 110, bpm: 100, waveform: 'triangle', style: 'pluck', gain: 0.16,
        pattern: [[0, 1], [7, 0.5], [5, 0.5], [3, 1], [0, 1], [10, 0.5], [7, 0.5], [5, 1]],
      },
    ],
  },
  // Mugham-ish: Phrygian dominant scale (1 b2 3 4 5 b6 b7), slow ornamented sustain.
  azerbaijan: {
    voices: [
      {
        rootFreq: 147, bpm: 66, waveform: 'sawtooth', style: 'sustain', gain: 0.14, lowpass: 1200,
        vibrato: { rate: 4.5, cents: 12 },
        pattern: [[0, 2], [1, 1], [4, 1], [3, 2], [7, 2], [8, 1], [6, 1], [0, 2]],
      },
    ],
  },
  // Duduk-ish: natural minor, long legato reedy lead.
  georgia: {
    voices: [
      {
        rootFreq: 165, bpm: 58, waveform: 'sawtooth', style: 'sustain', gain: 0.15, lowpass: 800,
        vibrato: { rate: 5, cents: 8 },
        pattern: [[0, 3], [3, 2], [5, 3], [3, 2], [-2, 3], [0, 2], [-5, 4]],
      },
    ],
  },
  // Saz-ish: Hicaz-flavored (1 b2 3 4 5 b6 7), fast plucky arpeggios.
  turkey: {
    voices: [
      {
        rootFreq: 196, bpm: 128, waveform: 'sawtooth', style: 'pluck', gain: 0.13, detuneCents: 6,
        pattern: [[0, 0.5], [1, 0.5], [4, 0.5], [5, 0.5], [7, 0.5], [5, 0.5], [4, 0.5], [1, 0.5]],
      },
    ],
  },
  // Istanbul: the journey converges — soft layers of all three flavors together.
  istanbul: {
    voices: [
      {
        rootFreq: 110, bpm: 100, waveform: 'triangle', style: 'pluck', gain: 0.08,
        pattern: [[0, 1], [7, 0.5], [5, 0.5], [3, 1], [0, 1], [10, 0.5], [7, 0.5], [5, 1]],
      },
      {
        rootFreq: 165, bpm: 58, waveform: 'sawtooth', style: 'sustain', gain: 0.1, lowpass: 900,
        vibrato: { rate: 5, cents: 8 },
        pattern: [[0, 3], [3, 2], [5, 3], [3, 2], [-2, 3], [0, 2], [-5, 4]],
      },
      {
        rootFreq: 196, bpm: 128, waveform: 'sawtooth', style: 'pluck', gain: 0.09, detuneCents: 6,
        pattern: [[0, 0.5], [1, 0.5], [4, 0.5], [5, 0.5], [7, 0.5], [5, 0.5], [4, 0.5], [1, 0.5]],
      },
    ],
  },
};

// Radio voice: Animal-Crossing-style gibberish, a distinct pitch profile per
// character (radio_lines.json's `speaker` field) so Bagdat and the NATO
// pilot are audibly different, not the same blip replayed.
const VOICE_PROFILES = {
  bagdat: { baseFreq: 190, freqJitter: 35, formant: 900 },
  nato_pilot: { baseFreq: 255, freqJitter: 45, formant: 1500 },
};

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

    // Music (see COUNTRY_MUSIC / setMusicCountry / _updateMusic).
    this._musicTracks = []; // { voices: [{...def, nextTime, nextIndex}], gain: GainNode, stopAt: number|null }
    this._musicCountry = null;
    this._pendingMusicCountry = null; // setMusicCountry() called before resume() — applied once the context exists
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
      this._buildMusicBus();
      if (this._pendingMusicCountry) {
        const key = this._pendingMusicCountry;
        this._pendingMusicCountry = null;
        this.setMusicCountry(key);
      }
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

  // Music signal chain: per-country tracks -> _musicBus (mix point) ->
  // _musicFilter (the "muffle the world" lowpass, see update()) ->
  // _musicDuckGain (the -6dB radio duck, see setMusicDucked) -> destination.
  _buildMusicBus() {
    const ctx = this.ctx;
    this._musicBus = ctx.createGain();
    this._musicBus.gain.value = 1;

    this._musicFilter = ctx.createBiquadFilter();
    this._musicFilter.type = 'lowpass';
    this._musicFilter.frequency.value = MUSIC_MUFFLE_MAX_CUTOFF;

    this._musicDuckGain = ctx.createGain();
    this._musicDuckGain.gain.value = 1;

    this._musicBus.connect(this._musicFilter);
    this._musicFilter.connect(this._musicDuckGain);
    this._musicDuckGain.connect(ctx.destination);
  }

  // Country transition (route.js's _applyWave, on every wave change):
  // crossfades MUSIC_CROSSFADE seconds from whatever's currently playing
  // into `key`'s loop. Safe to call before the AudioContext exists (the
  // very first wave applies before the player's first click) — remembered
  // in _pendingMusicCountry and applied once resume() actually builds it.
  setMusicCountry(key) {
    if (!this._started) {
      this._pendingMusicCountry = key;
      return;
    }
    if (this._musicCountry === key) return;
    this._musicCountry = key;
    const now = this.ctx.currentTime;

    for (const entry of this._musicTracks) {
      if (entry.stopAt !== null) continue; // already fading out from an earlier transition
      entry.gain.gain.cancelScheduledValues(now);
      entry.gain.gain.setValueAtTime(entry.gain.gain.value, now);
      entry.gain.gain.linearRampToValueAtTime(0, now + MUSIC_CROSSFADE);
      entry.stopAt = now + MUSIC_CROSSFADE + 0.2;
    }

    const def = COUNTRY_MUSIC[key];
    if (!def) return;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + MUSIC_CROSSFADE);
    gain.connect(this._musicBus);

    const voices = def.voices.map((v) => ({ ...v, nextTime: now + 0.05, nextIndex: 0 }));
    this._musicTracks.push({ voices, gain, stopAt: null });
  }

  // radio.js calls this from _startCall/_endCall — smoothly ducks/restores
  // the whole music bus by MUSIC_DUCK_GAIN while a call is up.
  setMusicDucked(active) {
    if (!this._started) return;
    const now = this.ctx.currentTime;
    this._musicDuckGain.gain.setTargetAtTime(active ? MUSIC_DUCK_GAIN : 1, now, 0.15);
  }

  // Lookahead scheduler: each update() schedules any notes due within the
  // next MUSIC_LOOKAHEAD seconds, per voice, per active track (there are two
  // tracks briefly during a crossfade). Tracks whose fade-out has finished
  // are dropped here rather than via a timer, so cleanup stays on the same
  // clock as scheduling.
  _updateMusic(now) {
    for (const entry of this._musicTracks) {
      for (const v of entry.voices) {
        while (v.nextTime < now + MUSIC_LOOKAHEAD) {
          const [semis, beats] = v.pattern[v.nextIndex % v.pattern.length];
          const dur = beats * (60 / v.bpm);
          if (semis !== null) this._playMusicNote(entry.gain, v, semis, v.nextTime, dur);
          v.nextTime += dur;
          v.nextIndex += 1;
        }
      }
    }
    this._musicTracks = this._musicTracks.filter((entry) => !(entry.stopAt !== null && now >= entry.stopAt));
  }

  _playMusicNote(destination, v, semis, time, dur) {
    const ctx = this.ctx;
    const freq = v.rootFreq * Math.pow(2, semis / 12);

    const osc = ctx.createOscillator();
    osc.type = v.waveform;
    osc.frequency.value = freq;
    if (v.detuneCents) osc.detune.value = v.detuneCents;

    let node = osc;
    if (v.lowpass) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = v.lowpass;
      osc.connect(filter);
      node = filter;
    }

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, time);
    if (v.style === 'pluck') {
      env.gain.linearRampToValueAtTime(v.gain, time + 0.008);
      env.gain.exponentialRampToValueAtTime(0.0001, time + Math.min(dur * 0.95, 0.6));
    } else {
      // 'sustain': legato hold through most of the note, then release.
      env.gain.linearRampToValueAtTime(v.gain, time + Math.min(dur * 0.25, 0.2));
      env.gain.setValueAtTime(v.gain, time + Math.max(dur - 0.15, dur * 0.5));
      env.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    }

    node.connect(env);
    env.connect(destination);
    osc.start(time);
    osc.stop(time + dur + 0.05);

    if (v.vibrato) {
      // Audio-rate signals connected to an AudioParam ADD to its intrinsic
      // value, so this composes fine with detuneCents above.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = v.vibrato.rate;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = v.vibrato.cents;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.detune);
      lfo.start(time);
      lfo.stop(time + dur + 0.05);
    }
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

  // One-shot "dodge window is open" telegraph: a rising sweep, deliberately
  // unlike the RWR lock-tone (square, falling-interval beeps) or the
  // approach ping (flat 700Hz blips) so it reads as its own distinct cue —
  // "the break is coming," not just another beep in the same family.
  playDodgeCue() {
    if (!this._started) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const duration = 0.35;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(500, now);
    osc.frequency.exponentialRampToValueAtTime(1400, now + duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.35, now + 0.04);
    env.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(env);
    env.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
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

  // Short ascending major arpeggio, layered right alongside playWhoosh() on
  // a successful dodge — the whoosh is the physical sound (air), this is the
  // emotional payoff.
  playDodgeSting() {
    if (!this._started) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const root = 523.25; // C5
    const notes = [0, 4, 7, 12]; // major triad up an octave

    notes.forEach((semis, i) => {
      const t = now + i * 0.05;
      const freq = root * Math.pow(2, semis / 12);

      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;

      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.25, t + 0.01);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.3);

      osc.connect(env);
      env.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.32);
    });
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

  // Radio voice: a run of short pitched blips (Animal-Crossing-style
  // gibberish) whose count scales with the line's length, bookended by a
  // static crackle swell in/out. `speaker` (radio_lines.json's `speaker`
  // field) selects VOICE_PROFILES so Bagdat and the NATO pilot read as
  // distinct characters, not the same blip replayed.
  playVoiceLine(speaker, textLength) {
    if (!this._started) return;
    const profile = VOICE_PROFILES[speaker] || VOICE_PROFILES.bagdat;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    this._playStaticSwell(now, 0.18, true);

    const syllables = Math.max(3, Math.min(14, Math.round(textLength / 5)));
    let t = now + 0.2;
    for (let i = 0; i < syllables; i++) {
      const dur = 0.06 + Math.random() * 0.05;
      this._playVoiceBlip(t, profile, dur);
      t += dur + 0.02 + Math.random() * 0.03;
    }

    this._playStaticSwell(t + 0.05, 0.18, false);
  }

  _playVoiceBlip(time, profile, dur) {
    const ctx = this.ctx;
    const freq = profile.baseFreq + (Math.random() * 2 - 1) * profile.freqJitter;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, time);
    osc.frequency.exponentialRampToValueAtTime(freq * (0.85 + Math.random() * 0.3), time + dur);

    const formant = ctx.createBiquadFilter();
    formant.type = 'bandpass';
    formant.frequency.value = profile.formant;
    formant.Q.value = 3;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(0.28, time + dur * 0.2);
    env.gain.exponentialRampToValueAtTime(0.001, time + dur);

    osc.connect(formant);
    formant.connect(env);
    env.connect(ctx.destination);
    osc.start(time);
    osc.stop(time + dur + 0.02);
  }

  // Bookends a voice line: swells in (attack ramps up) or out (release ramps
  // down then cuts) — same filtered-noise building block as playRadioBlip(),
  // shaped as one continuous swell instead of discrete blips.
  _playStaticSwell(time, duration, swellIn) {
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = this._noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1800;
    filter.Q.value = 0.8;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, time);
    if (swellIn) {
      env.gain.exponentialRampToValueAtTime(0.3, time + duration * 0.6);
      env.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    } else {
      env.gain.exponentialRampToValueAtTime(0.3, time + duration * 0.3);
      env.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    }

    source.connect(filter);
    filter.connect(env);
    env.connect(ctx.destination);
    source.start(time);
    source.stop(time + duration + 0.02);
  }

  update(dt, fear) {
    if (!this._started) return;
    const now = this.ctx.currentTime;

    this._updateMusic(now);

    // 60+: "the world" (music) muffles under a closing lowpass — the
    // lock-tone/approach-ping/heartbeat deliberately stay untouched, since
    // those need to keep cutting through as warnings regardless of fear.
    const muffleIntensity = fear.intensity(FEAR_CONFIG.THRESHOLDS.VIGNETTE);
    const cutoff = MUSIC_MUFFLE_MAX_CUTOFF + (MUSIC_MUFFLE_MIN_CUTOFF - MUSIC_MUFFLE_MAX_CUTOFF) * muffleIntensity;
    this._musicFilter.frequency.setTargetAtTime(cutoff, now, 0.3);

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