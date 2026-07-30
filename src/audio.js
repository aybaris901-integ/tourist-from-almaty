import { CONFIG as FEAR_CONFIG } from './fear.js';
import { MusicManager } from './musicManager.js';

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
// Real per-country tracks (musicManager.js), fed into a shared fear-reactive
// chain: MusicManager -> _musicBus (mix point) -> _musicFilter ("muffle the
// world" lowpass, see update()) -> _musicDuckGain (-6dB while a radio call
// is active, see setMusicDucked()) -> destination. Deliberately NOT applied
// to the lock-tone/approach-ping/heartbeat, which need to stay piercing as
// warnings regardless of how scared you are.
const MUSIC_DUCK_GAIN = Math.pow(10, -6 / 20); // -6dB while radio.active
const CUTSCENE_DUCK_GAIN = 0.4; // ~40% while a cutscene plays (main.js) — deeper than the radio duck, but never fully silent, so music continuity through the intro clips is audible
const MUSIC_MUFFLE_MIN_CUTOFF = 500; // lowpass Hz at fear=100
const MUSIC_MUFFLE_MAX_CUTOFF = 18000; // effectively unfiltered

// Radio voice: Animal-Crossing-style gibberish, a distinct pitch profile per
// character (radio_lines.json's `speaker` field) so Bagdat and the NATO
// pilot are audibly different, not the same blip replayed.
const VOICE_PROFILES = {
  bagdat: { baseFreq: 190, freqJitter: 35, formant: 900 },
  nato_pilot: { baseFreq: 255, freqJitter: 45, formant: 1500 },
};

// Breathing/heartbeat tied to the fear meter, threat/radio one-shots (RWR
// lock tone, whoosh, impact thud, radio blip) synthesized with the Web
// Audio API, plus real per-country music playback (musicManager.js).
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

    // Fighter engine drone (see _buildFighterEngine) — a persistent node,
    // not a repeated one-shot like the approach ping, since it needs to
    // hold a continuous tone while a fighter is nearby in any state.
    this._engineActive = false;

    // Music (see musicManager.js / setMusicCountry / preloadMusicCountry).
    // AudioContext (and therefore MusicManager, which needs it to decode
    // audio) doesn't exist until resume() — setMusicCountry()/
    // preloadMusicCountry() called before that just queue up here and are
    // replayed once resume() actually builds everything. This mirrors the
    // browser's autoplay policy: nothing loads or plays before the player's
    // first click/keypress triggers resume().
    this._music = null;
    this._pendingMusicCountry = null;
    this._pendingPreloadKey = null;

    // Stage 7B settings (master/music/sfx volume) — see setVolumes().
    this._pendingVolumes = null;
  }

  // AudioContext must be created/resumed from a user gesture; call this from
  // a click handler.
  resume() {
    if (!this._started) {
      this._started = true;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this._buildNoiseBuffer();
      this._buildMasterBus();
      this._buildBreathing();
      this._buildHeartbeatBus();
      this._buildFighterEngine();
      this._buildMusicBus();
      if (this._pendingMusicCountry) {
        const key = this._pendingMusicCountry;
        this._pendingMusicCountry = null;
        this.setMusicCountry(key);
      }
      if (this._pendingPreloadKey) {
        const key = this._pendingPreloadKey;
        this._pendingPreloadKey = null;
        this.preloadMusicCountry(key);
      }
      if (this._pendingVolumes) {
        const volumes = this._pendingVolumes;
        this._pendingVolumes = null;
        this.setVolumes(volumes);
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
    this._breathGain.connect(this._sfxGain);
    source.start();
  }

  _buildHeartbeatBus() {
    this._heartbeatBus = this.ctx.createGain();
    this._heartbeatBus.gain.value = 0;
    this._heartbeatBus.connect(this._sfxGain);
  }

  // Persistent low drone for a nearby fighter (threats.js's _updateFighters
  // picks the nearest active one each frame) — a continuous node rather
  // than a repeated beep, since "engine noise" has to sit there humming, not
  // pulse like a warning. Gain starts at 0 and idles silently until a
  // fighter is actually in range (see startFighterEngine/updateFighterEngine).
  _buildFighterEngine() {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 80;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;

    this._engineGain = ctx.createGain();
    this._engineGain.gain.value = 0;

    this._enginePanner = ctx.createStereoPanner();

    osc.connect(filter);
    filter.connect(this._engineGain);
    this._engineGain.connect(this._enginePanner);
    this._enginePanner.connect(this._sfxGain);
    osc.start();
    this._engineOsc = osc;
  }

  // Stage 7B settings: everything ends up at _masterGain -> destination.
  // Sfx (one-shots, breathing/heartbeat/engine) route through _sfxGain;
  // music gets its own _musicVolumeGain (see _buildMusicBus) so the two
  // sliders are independent. Built first, before anything that connects to
  // either bus.
  _buildMasterBus() {
    const ctx = this.ctx;
    this._masterGain = ctx.createGain();
    this._masterGain.gain.value = 1;
    this._masterGain.connect(ctx.destination);

    this._sfxGain = ctx.createGain();
    this._sfxGain.gain.value = 1;
    this._sfxGain.connect(this._masterGain);
  }

  // Fear-reactive chain that MusicManager's real playback feeds into:
  // MusicManager -> _musicBus (mix point) -> _musicFilter ("muffle the
  // world" lowpass, see update()) -> _musicDuckGain (transient ducking —
  // radio/cutscene, see setMusicDucked/setCutsceneDuck) -> _musicVolumeGain
  // (persistent user music-volume setting, see setVolumes) -> _masterGain.
  _buildMusicBus() {
    const ctx = this.ctx;
    this._musicBus = ctx.createGain();
    this._musicBus.gain.value = 1;

    this._musicFilter = ctx.createBiquadFilter();
    this._musicFilter.type = 'lowpass';
    this._musicFilter.frequency.value = MUSIC_MUFFLE_MAX_CUTOFF;

    this._musicDuckGain = ctx.createGain();
    this._musicDuckGain.gain.value = 1;

    this._musicVolumeGain = ctx.createGain();
    this._musicVolumeGain.gain.value = 1;

    this._musicBus.connect(this._musicFilter);
    this._musicFilter.connect(this._musicDuckGain);
    this._musicDuckGain.connect(this._musicVolumeGain);
    this._musicVolumeGain.connect(this._masterGain);

    this._music = new MusicManager(ctx, this._musicBus);
  }

  // Country transition (route.js's _applyWave, on every wave change):
  // crossfades into `key`'s real track (musicManager.js). Safe to call
  // before the AudioContext exists (the very first wave applies before the
  // player's first click) — remembered in _pendingMusicCountry and applied
  // once resume() actually builds everything, same deferral the browser's
  // autoplay policy already requires of us.
  setMusicCountry(key) {
    if (!this._started) {
      this._pendingMusicCountry = key;
      return;
    }
    this._music.setCountry(key);
  }

  // route.js calls this with the NEXT wave's key as soon as the current one
  // starts, so the track is already decoded by the time the player gets
  // there — no gap on the actual transition. Same pre-start deferral as
  // setMusicCountry() if called before the player's first click.
  preloadMusicCountry(key) {
    if (!this._started) {
      this._pendingPreloadKey = key;
      return;
    }
    this._music.preload(key);
  }

  // radio.js calls this from _startCall/_endCall — smoothly ducks/restores
  // the whole music bus by MUSIC_DUCK_GAIN while a call is up.
  setMusicDucked(active) {
    if (!this._started) return;
    const now = this.ctx.currentTime;
    this._musicDuckGain.gain.setTargetAtTime(active ? MUSIC_DUCK_GAIN : 1, now, 0.15);
  }

  // main.js calls this around every cutscenePlayer.playCutscene() — ducks the
  // same bus setMusicDucked() uses. Shares the node rather than adding a
  // second one: radio.update() never runs while a cutscene has the game loop
  // suspended, so the two ducks can't actually fight over it in practice.
  // `full` (the finale video only) ducks all the way to silence instead of
  // CUTSCENE_DUCK_GAIN, since that clip's own audio needs to be heard clean.
  setCutsceneDuck(active, { full = false } = {}) {
    if (!this._started) return;
    const now = this.ctx.currentTime;
    const target = active ? (full ? 0 : CUTSCENE_DUCK_GAIN) : 1;
    this._musicDuckGain.gain.setTargetAtTime(target, now, 0.15);
  }

  // route.js's calm-payoff -> landing sequence: a warm sustained chord layered
  // over whatever country track is already playing, synthesized rather than
  // a new music asset (no "final track" mp3 exists — see CLAUDE.md's "no huge
  // asset downloads" rule).
  playFinaleSwell() {
    if (!this._started) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const root = 261.63; // C4
    const notes = [0, 4, 7, 12, 16]; // major triad + octave + tenth — warm, not tense

    notes.forEach((semis, i) => {
      const freq = root * Math.pow(2, semis / 12);
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;

      const env = ctx.createGain();
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(0.12, now + 2.5 + i * 0.15);
      env.gain.linearRampToValueAtTime(0.09, now + 8);
      env.gain.exponentialRampToValueAtTime(0.001, now + 13);

      osc.connect(env);
      env.connect(this._sfxGain);
      osc.start(now);
      osc.stop(now + 13.2);
    });
  }

  // Landing sequence: gear-down whir (bandpass noise sweep) ending in a
  // locked-down clunk.
  playGearDown() {
    if (!this._started) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const duration = 1.1;

    const source = ctx.createBufferSource();
    source.buffer = this._noiseBuffer;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.2;
    filter.frequency.setValueAtTime(500, now);
    filter.frequency.linearRampToValueAtTime(220, now + duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.22, now + 0.1);
    env.gain.linearRampToValueAtTime(0.16, now + duration * 0.8);
    env.gain.linearRampToValueAtTime(0.0001, now + duration);

    source.connect(filter);
    filter.connect(env);
    env.connect(this._sfxGain);
    source.start(now);
    source.stop(now + duration + 0.05);

    this._playThump(this._sfxGain, 160, 60, 0.25, now + duration - 0.05);
  }

  // Landing sequence: touchdown — a heavy low thump plus a short rumble.
  playTouchdownThud() {
    if (!this._started) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    this._playThump(this._sfxGain, 110, 30, 0.5);

    const source = ctx.createBufferSource();
    source.buffer = this._noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.35, now);
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    source.connect(filter);
    filter.connect(env);
    env.connect(this._sfxGain);
    source.start(now);
    source.stop(now + 0.45);
  }

  // Finale video handoff: fades the raw per-country music bus itself to
  // silence (not just the duck node) — the video's own audio needs a clean
  // stage, and unlike the duck this doesn't get restored until a fresh
  // playthrough (see resetForReplay()).
  stopMusic() {
    if (!this._started) return;
    this._musicBus.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
  }

  // main.js calls this when returning to MENU after the credits — undoes
  // stopMusic()/any lingering duck so a fresh playthrough's music works.
  resetForReplay() {
    if (!this._started) return;
    const now = this.ctx.currentTime;
    this._musicBus.gain.setTargetAtTime(1, now, 0.05);
    this._musicDuckGain.gain.setTargetAtTime(1, now, 0.05);
  }

  // menu.js's settings screen (Настройки). Deferred the same way
  // setMusicCountry/preloadMusicCountry are if called before the
  // AudioContext exists (main.js applies saved settings on load, before the
  // player's first click). Any field left undefined is left unchanged.
  setVolumes({ master, music, sfx } = {}) {
    if (!this._started) {
      this._pendingVolumes = { master, music, sfx }; // main.js always calls with all three set — last call wins
      return;
    }
    const now = this.ctx.currentTime;
    if (master != null) this._masterGain.gain.setTargetAtTime(master, now, 0.05);
    if (music != null) this._musicVolumeGain.gain.setTargetAtTime(music, now, 0.05);
    if (sfx != null) this._sfxGain.gain.setTargetAtTime(sfx, now, 0.05);
  }

  _playThump(bus, startFreq, endFreq, duration, when) {
    const ctx = this.ctx;
    const now = when ?? ctx.currentTime;

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
    panner.connect(this._sfxGain);
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

  // Fighter engine drone, panned/pitched by the nearest active fighter's
  // bearing/proximity (threats.js's _updateFighters calls this every frame
  // one exists, same idempotent-start pattern as startApproachPing above).
  startFighterEngine() {
    this._engineActive = true;
  }

  updateFighterEngine(pan, proximity) {
    if (!this._started || !this._engineActive) return;
    const now = this.ctx.currentTime;
    const clampedProximity = Math.max(0, Math.min(1, proximity));
    const gain = 0.06 + 0.22 * clampedProximity;
    const freq = 80 + 70 * clampedProximity;
    this._engineGain.gain.setTargetAtTime(gain, now, 0.15);
    this._engineOsc.frequency.setTargetAtTime(freq, now, 0.2);
    this._enginePanner.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), now, 0.1);
  }

  stopFighterEngine() {
    this._engineActive = false;
    if (!this._started) return;
    this._engineGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
  }

  // ATTACK line-up warning: a rapid rattle of ascending clicks — deliberately
  // NOT a single sweep like playDodgeCue below, so the two telegraphs (missile
  // dodge window vs. a fighter lining up on your six) don't get confused for
  // each other by ear.
  playFighterLineupCue(pan = 0) {
    if (!this._started) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const clicks = 6;

    for (let i = 0; i < clicks; i++) {
      const t = now + i * 0.055;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 260 + i * 12;

      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.22, t + 0.006);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.045);

      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));

      osc.connect(env);
      env.connect(panner);
      panner.connect(this._sfxGain);
      osc.start(t);
      osc.stop(t + 0.05);
    }
  }

  // Gun burst: filtered-noise rounds, same bandpass-noise building block as
  // playRadioBlip but tighter/faster so it reads as automatic fire, not
  // static. One call per ATTACK burst (threats.js fires it once, at the
  // moment the burst phase begins).
  playGunBurst(pan = 0) {
    if (!this._started) return;
    const ctx = this.ctx;
    const start = ctx.currentTime;
    const rounds = 8;

    for (let i = 0; i < rounds; i++) {
      const t = start + i * 0.05 + Math.random() * 0.01;
      const source = ctx.createBufferSource();
      source.buffer = this._noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1400 + Math.random() * 300;
      filter.Q.value = 2.5;

      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.3, t + 0.005);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.04);

      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));

      source.connect(filter);
      filter.connect(env);
      env.connect(panner);
      panner.connect(this._sfxGain);
      source.start(t);
      source.stop(t + 0.05);
    }
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
    env.connect(this._sfxGain);
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
    env.connect(this._sfxGain);
    source.start(now);
    source.stop(now + duration + 0.02);
  }

  playImpactThud() {
    if (!this._started) return;
    this._playThump(this._sfxGain, 90, 35, 0.35);
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
      env.connect(this._sfxGain);
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
      env.connect(this._sfxGain);
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
    env.connect(this._sfxGain);
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
    env.connect(this._sfxGain);
    source.start(time);
    source.stop(time + duration + 0.02);
  }

  update(dt, fear) {
    if (!this._started) return;
    const now = this.ctx.currentTime;

    this._music.update(now);

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