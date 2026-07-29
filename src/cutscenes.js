// Single source of truth for cutscene ids, asset paths, and trigger wiring —
// retune timing/paths here without touching cutscenePlayer.js or main.js.
const RAW = [
  { id: 'intro_bedroom', duration: 4 },
  { id: 'intro_cologne', duration: 3 },
  { id: 'cockpit_reveal', duration: 4 },
  { id: 'flyover_kazakhstan', duration: 4 },
  { id: 'flyover_azerbaijan', duration: 4 },
  { id: 'flyover_caucasus', duration: 4 }, // clip covers the Georgia wave (route.js's WAVES[2].country) — id renamed from the misleading "flyover_greece" the asset shipped as
  { id: 'flyover_turkey', duration: 5 },
  { id: 'finale_offering', duration: 4 },
];

export const CUTSCENES = RAW.map((c) => ({
  ...c,
  video: `/cutscenes/${c.id}.mp4`,
  webm: `/cutscenes/${c.id}.webm`,
  poster: `/cutscenes/${c.id}.jpg`,
  subs: `/cutscenes/${c.id}.subs.json`,
}));

// Played back to back on the click that starts the game, before the first
// gameplay frame (see main.js).
export const INTRO_SEQUENCE = ['intro_bedroom', 'intro_cologne', 'cockpit_reveal'];

// route.js's WAVES index -> cutscene id, fired the instant that wave's
// transition begins (i.e. on completing it), before the next wave's gameplay
// is visible. Wave 4 (Istanbul Approach) has no flyover — its completion
// instead fires FINALE_CUTSCENE_ID below.
export const WAVE_COMPLETE_CUTSCENE = {
  0: 'flyover_kazakhstan', // Kazakhstan done
  1: 'flyover_azerbaijan', // Caspian/Azerbaijan done
  2: 'flyover_caucasus', // Georgia done
  3: 'flyover_turkey', // Turkey — Inland done
};

export const FINALE_CUTSCENE_ID = 'finale_offering';

export const SEEN_STORAGE_KEY = 'tfa.cutscenes.seen';

// window.tfaDebug.skipAllCutscenes(true) flips this for playtesting — every
// playCutscene() call still resolves its promise normally, just instantly.
export const DEBUG = {
  skipAll: false,
};
