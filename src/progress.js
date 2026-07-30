// Persisted campaign progress — same try/catch localStorage pattern as
// cutscenePlayer.js's seen-cutscenes tracking. There's no fine-grained
// mid-flight save; this only remembers the furthest WAVES index the player
// has ever reached, which is what powers the menu's "Продолжить: <страна>"
// and "Выбор страны" (see main.js/route.js's startIndex).
const PROGRESS_KEY = 'tfa.progress';

export function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return { highestWaveReached: 0 };
    const parsed = JSON.parse(raw);
    const value = parsed.highestWaveReached;
    return { highestWaveReached: Number.isInteger(value) && value >= 0 ? value : 0 };
  } catch {
    return { highestWaveReached: 0 };
  }
}

export function saveProgress(highestWaveReached) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ highestWaveReached }));
  } catch {
    // localStorage unavailable (private mode, quota, etc.) — progress just
    // won't persist across reloads.
  }
}
