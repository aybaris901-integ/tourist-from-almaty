// Real per-track music playback (menu + every per-country track), replacing
// the old synthesized loops. Owns loading/decoding/caching, crossfading
// between tracks, and seamless looping — nothing here knows about game
// state (menu vs flying vs cutscene); it just plays whatever key it's told
// into whatever destination node it's given. audio.js's setMusicForState()
// is the single place that decides which key that should be at any moment.
const CROSSFADE_SECONDS = 0.8; // spec: "crossfade 800ms (fade out old, fade in new)"

// audio.js's setMusicForState() key -> file under /public/audio/music/.
// 'menu' used to be its own separate plain <audio> element (menuMusic.js) so
// it could start loading/attempting playback before the AudioContext
// existed — now the context is built eagerly at FearAudio construction (see
// audio.js), so decoding it here works exactly like any country track, and
// "exactly one track ever audible" becomes a property of this one class
// rather than something two separate systems both have to promise. Istanbul
// reuses Turkey's key directly in WAVES (route.js) rather than having a
// second entry here pointing at the same file.
const TRACKS = {
  menu: `${import.meta.env.BASE_URL}audio/music/background.mp3`,
  kazakhstan: `${import.meta.env.BASE_URL}audio/music/kazakhstan.mp3`,
  azerbaijan: `${import.meta.env.BASE_URL}audio/music/azerbaijan.mp3`,
  georgia: `${import.meta.env.BASE_URL}audio/music/georgia.mp3`,
  turkey: `${import.meta.env.BASE_URL}audio/music/turkey.mp3`,
};

// Above this gain, a voice counts as "audible" for the stacked-voice
// assertion in update() — comfortably below where a crossfade spends most of
// its time, comfortably above true silence/rounding noise.
const AUDIBLE_GAIN_THRESHOLD = 0.02;

export class MusicManager {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this._destination = destination;

    this._buffers = new Map(); // key -> AudioBuffer (only successful decodes are cached)
    this._loadPromises = new Map(); // key -> in-flight Promise<AudioBuffer|null>, so concurrent callers share one fetch

    this._masterGain = ctx.createGain(); // single mix point for this manager's (possibly 2, mid-crossfade) voices
    this._masterGain.gain.value = 1;
    this._masterGain.connect(destination);

    this._currentKey = null;
    this._voices = []; // { source, gain, stopAt: number|null } — usually one, briefly two mid-crossfade

    // Monotonic call counter — see setTrack()'s race guard. Needed because
    // `this._currentKey !== key` alone doesn't catch a key cycling back to
    // its own value (menu -> flying -> menu) while an earlier call for that
    // same key is still awaiting its (shared, memoized) decode: both calls
    // would see _currentKey === key once it resolves and both would start a
    // voice, stacking two "current" loops for the same track — the exact
    // "duplicate loops after several restarts" risk this guards against.
    this._callToken = 0;
  }

  // Fetch+decode a track, memoized — including failures (cached as `null`),
  // so a missing/broken file only ever logs once and never gets re-fetched
  // just because both preload() and a later setTrack() touch the same key.
  // Never throws — a failed load resolves to null so callers can fall back
  // to silence instead of crashing.
  _load(key) {
    if (this._buffers.has(key)) return Promise.resolve(this._buffers.get(key));
    if (this._loadPromises.has(key)) return this._loadPromises.get(key);

    const url = TRACKS[key];
    if (!url) {
      console.error(`[music] no track mapped for key "${key}"`);
      this._buffers.set(key, null);
      return Promise.resolve(null);
    }

    const promise = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
        return res.arrayBuffer();
      })
      .then((data) => this.ctx.decodeAudioData(data))
      .then((buffer) => {
        this._buffers.set(key, buffer);
        return buffer;
      })
      .catch((err) => {
        console.error(`[music] failed to load "${key}" track (${url}):`, err);
        this._buffers.set(key, null);
        return null;
      })
      .finally(() => this._loadPromises.delete(key));

    this._loadPromises.set(key, promise);
    return promise;
  }

  // Kick off a load without switching to it — route.js calls this with the
  // NEXT wave's key as soon as the current one starts, so by the time the
  // player actually reaches that country the track is already decoded and
  // setTrack() resolves instantly (no gap).
  preload(key) {
    if (key) this._load(key);
  }

  // Crossfades CROSSFADE_SECONDS from whatever's currently playing into
  // `key`'s track — `key === null` just fades everything out to silence
  // (CUTSCENE/FINALE VIDEO: the clip carries its own audio). Fire-and-forget
  // (async internally to await decoding) — see _callToken for why a stale
  // call has to check more than just "is my key still current".
  async setTrack(key) {
    if (this._currentKey === key) return;
    this._currentKey = key;
    this._callToken += 1;
    const myToken = this._callToken;

    const now0 = this.ctx.currentTime;
    for (const voice of this._voices) {
      if (voice.stopAt !== null) continue; // already fading out from an earlier switch
      voice.gain.gain.cancelScheduledValues(now0);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now0);
      voice.gain.gain.linearRampToValueAtTime(0, now0 + CROSSFADE_SECONDS);
      voice.stopAt = now0 + CROSSFADE_SECONDS + 0.1;
    }

    if (key === null) return; // silence — nothing new to start

    const buffer = await this._load(key);
    if (this._callToken !== myToken) return; // a newer setTrack() call (any key) superseded this one while awaiting
    if (!buffer) return; // load failed — already logged in _load, stay silent

    const now = this.ctx.currentTime;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    // Native sample-accurate looping (default loopStart/loopEnd = whole
    // buffer) — the only way to guarantee no click at the seam from code;
    // any residual click would mean the source file's own waveform doesn't
    // meet itself cleanly, which no amount of JS-side gain shaping can fix.
    source.loop = true;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + CROSSFADE_SECONDS);

    source.connect(gain);
    gain.connect(this._masterGain);
    source.start(now);

    this._voices.push({ source, gain, stopAt: null });
  }

  // Called every frame, in every game state (audio.js's updateMusic(), called
  // unconditionally from main.js's render loop). Prunes voices whose
  // crossfade-out has finished, then asserts the actual invariant this class
  // exists to guarantee: at most one voice may be "current" (no scheduled
  // stop) at a time. More than one means two loops are both headed for/at
  // full volume — audible doubling, the exact class of bug a single
  // crossfade primitive (replacing the old separate menu-audio-element +
  // ad-hoc duck/gate flags) is supposed to make structurally impossible.
  update(now) {
    this._voices = this._voices.filter((voice) => {
      if (voice.stopAt !== null && now >= voice.stopAt) {
        try {
          voice.source.stop();
        } catch {
          // Already stopped/ended naturally — fine to ignore.
        }
        return false;
      }
      return true;
    });

    let audibleTargets = 0;
    for (const voice of this._voices) {
      if (voice.stopAt === null && voice.gain.gain.value > AUDIBLE_GAIN_THRESHOLD) audibleTargets++;
    }
    if (audibleTargets > 1) {
      console.warn(
        `[music] ASSERTION FAILED — ${audibleTargets} music voices are simultaneously "current" (expected at most 1). currentKey="${this._currentKey}"`
      );
    }
  }
}
