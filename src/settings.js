// Persisted player settings (Настройки) — same try/catch localStorage
// pattern as progress.js/cutscenePlayer.js. Pure load/save only; main.js
// owns the live mutable object and pushes changes into flight.CONFIG,
// audio.setVolumes(), and the postfx bypass flag (see applySettings()).
const SETTINGS_KEY = 'tfa.settings';

export const DEFAULT_SETTINGS = {
  masterVolume: 1,
  musicVolume: 1,
  sfxVolume: 1,
  mouseSensitivity: 1, // multiplier on flight.js's DEFAULT_MOUSE_SENSITIVITY
  invertRoll: false,
  invertPitch: false,
  simpleGraphics: false, // disables postfx — see ui.js's boosted fear bar
};

function clamp01(v) {
  return typeof v === 'number' && v >= 0 && v <= 1 ? v : null;
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      masterVolume: clamp01(parsed.masterVolume) ?? DEFAULT_SETTINGS.masterVolume,
      musicVolume: clamp01(parsed.musicVolume) ?? DEFAULT_SETTINGS.musicVolume,
      sfxVolume: clamp01(parsed.sfxVolume) ?? DEFAULT_SETTINGS.sfxVolume,
      mouseSensitivity:
        typeof parsed.mouseSensitivity === 'number' ? parsed.mouseSensitivity : DEFAULT_SETTINGS.mouseSensitivity,
      invertRoll: !!parsed.invertRoll,
      invertPitch: !!parsed.invertPitch,
      simpleGraphics: !!parsed.simpleGraphics,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // localStorage unavailable — settings just won't persist across reloads.
  }
}
