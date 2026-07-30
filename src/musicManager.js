// Real per-country music playback, replacing the old synthesized loops.
// Owns loading/decoding/caching, crossfading between tracks, and seamless
// looping — nothing here knows about fear/ducking/muffling; it just plays
// into whatever destination node it's given (audio.js connects that
// destination into its existing fear-reactive chain, so ducking/muffling
// keep working unchanged on top of these real tracks).
const CROSSFADE_SECONDS = 1.5; // "~1-2 seconds" per spec

// route.js's WAVES musicKey -> file under /public/audio/music/. Istanbul
// reuses Turkey's key directly in WAVES (see route.js) rather than having a
// second entry here pointing at the same file. 'menu' is main.js's main-menu
// background track (see showMenuShell) — same crossfade/loop machinery as
// every country track, just keyed off the menu instead of a wave.
const TRACKS = {
  menu: '/audio/music/background.mp3',
  kazakhstan: '/audio/music/kazakhstan.mp3',
  azerbaijan: '/audio/music/azerbaijan.mp3',
  georgia: '/audio/music/georgia.mp3',
  turkey: '/audio/music/turkey.mp3',
};

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
  }

  // Fetch+decode a track, memoized — including failures (cached as `null`),
  // so a missing/broken file only ever logs once and never gets re-fetched
  // just because both preload() and a later setCountry() touch the same
  // key. Never throws — a failed load resolves to null so callers can fall
  // back to silence instead of crashing.
  _load(key) {
    if (this._buffers.has(key)) return Promise.resolve(this._buffers.get(key));
    if (this._loadPromises.has(key)) return this._loadPromises.get(key);

    const url = TRACKS[key];
    if (!url) {
      console.error(`[music] no track mapped for country key "${key}"`);
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
  // setCountry() resolves instantly (no gap).
  preload(key) {
    if (key) this._load(key);
  }

  // Crossfades CROSSFADE_SECONDS from whatever's currently playing into
  // `key`'s track. Fire-and-forget (async internally to await decoding) —
  // if `key` changes again before the load resolves, the stale result is
  // discarded rather than clobbering whatever's actually current by then.
  async setCountry(key) {
    if (this._currentKey === key) return;
    this._currentKey = key;

    const now0 = this.ctx.currentTime;
    for (const voice of this._voices) {
      if (voice.stopAt !== null) continue; // already fading out from an earlier switch
      voice.gain.gain.cancelScheduledValues(now0);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now0);
      voice.gain.gain.linearRampToValueAtTime(0, now0 + CROSSFADE_SECONDS);
      voice.stopAt = now0 + CROSSFADE_SECONDS + 0.1;
    }

    const buffer = await this._load(key);
    if (this._currentKey !== key) return; // superseded while awaiting the load
    if (!buffer) return; // load failed — already logged in _load; stay silent

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

  // Called every frame (audio.js's update()) — stops and drops voices whose
  // crossfade-out has finished. No per-frame scheduling needed otherwise;
  // real buffers just play/loop natively once started.
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
  }
}
