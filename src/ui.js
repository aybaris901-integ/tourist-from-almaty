import { CONFIG as FEAR_CONFIG } from './fear.js';
import { CONFIG as RADIO_CONFIG } from './radio.js';
import { CONFIG as THREATS_CONFIG } from './threats.js';
import { WAVES } from './route.js';
import RADIO_LINES from './radio_lines.json';

const PANIC_LINES = RADIO_LINES.filter((l) => l.tags?.includes('panic'));
const PANIC_TITLE_FADE_DURATION = 0.5;

const TEXT_COLOR = '#f2f2ea';
const ACCENT_COLOR = '#f5c518'; // yellow accent, matches the cologne bottle later
const CROSSHAIR_SIZE = 20; // px, total span of the fixed nose-reference marker
const FEAR_LOW_COLOR = [245, 197, 24];
const FEAR_HIGH_COLOR = [214, 40, 40];

const RADAR_DIAMETER = 140;
const RADAR_MARGIN = 20;
const RADAR_ZOOM_LERP_RATE = 4; // per-second exponential smoothing toward the target range

const BREAK_CUE_DURATION = 0.5; // seconds the "BREAK!" crosshair flash holds
const DODGE_ONBOARDING_COUNT = 3; // past this many successful dodges, drop the arrows and keep just the word

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Draws the placeholder HUD (speed / altitude / fixed nose crosshair / fear
// bar) onto a full-screen 2D canvas overlay, and owns the top-left FPS
// counter element.
export class UI {
  constructor(hudCanvas, fpsElement) {
    this.canvas = hudCanvas;
    this.ctx = hudCanvas.getContext('2d');
    this.fpsElement = fpsElement;
    this.fpsVisible = true;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;

    // 40+ HUD glitch bursts: garbage readouts held for HUD_GLITCH_DURATION.
    this._glitchTimer = 0;
    this._glitchSpd = 0;
    this._glitchAlt = 0;

    this._radarRangeCurrent = THREATS_CONFIG.RADAR_RANGE;
    this._breakCueTimer = 0;

    // Panic screen (route.phase === 'restart-flash') — see _updatePanicScreen.
    this._panicScreenWasActive = false;
    this._panicScreenTimer = 0;
    this._panicLine = '';

    this._debugVisible = false; // D key — fear economy overlay, see _drawDebugOverlay
    this._fighterDebugVisible = false; // T key — fighter state/distance/bearing overlay, see _drawFighterDebugOverlay
  }

  resize(width, height, dpr) {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  toggleFps() {
    this.fpsVisible = !this.fpsVisible;
    this.fpsElement.style.display = this.fpsVisible ? 'block' : 'none';
  }

  setFps(fps) {
    this.fpsElement.textContent = `${Math.round(fps)} FPS`;
  }

  toggleDebug() {
    this._debugVisible = !this._debugVisible;
  }

  toggleFighterDebug() {
    this._fighterDebugVisible = !this._fighterDebugVisible;
  }

  update(flight, fear, dt, threats, radio, route, audio) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    ctx.clearRect(0, 0, w, h);

    // Panic screen replaces the whole cockpit HUD (crosshair, readouts, fear
    // bar, threats, radar, radio box) with its own full-screen presentation —
    // only the progress strip stays, so the highlighted country dot is still
    // visible (see _drawPanicScreen's "Заново: <country>" line).
    const inPanicScreen = route.phase === 'restart-flash';
    if (!inPanicScreen) {
      this._updateGlitch(fear, dt);
      this._drawCrosshair(w, h);
      this._updateBreakCue(threats, dt);
      this._drawBreakCue(threats, w, h);
      this._drawReadouts(flight, fear, w, h);
      this._drawFearBar(fear, w, h);
      this._drawThreatIndicators(threats, flight, w, h);
      this._drawRadar(threats, flight, fear, dt, w, h);
      this._drawRadio(radio, w, h);
    }
    this._drawProgressStrip(route, w, h);
    this._drawTransitionCard(route, w, h);
    this._drawEndCard(route, w, h);
    this._updatePanicScreen(route, audio, dt);
    this._drawPanicScreen(route, w, h);
    this._drawDebugOverlay(fear, threats, route, w, h);
    this._drawFighterDebugOverlay(threats, flight, w, h);
  }

  _updateGlitch(fear, dt) {
    if (this._glitchTimer > 0) {
      this._glitchTimer = Math.max(0, this._glitchTimer - dt);
      return;
    }
    const intensity = fear.intensity(FEAR_CONFIG.THRESHOLDS.HUD_GLITCH);
    if (intensity <= 0) return;
    const chance = FEAR_CONFIG.HUD_GLITCH_CHANCE_PER_SEC * intensity * dt;
    if (Math.random() < chance) {
      this._glitchTimer = FEAR_CONFIG.HUD_GLITCH_DURATION;
      this._glitchSpd = Math.round(Math.random() * 900);
      this._glitchAlt = Math.round(Math.random() * 5000);
    }
  }

  _drawCrosshair(w, h) {
    const ctx = this.ctx;
    const cx = w / 2;
    const cy = h / 2;
    const half = CROSSHAIR_SIZE / 2;
    const gap = 4;

    ctx.strokeStyle = ACCENT_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - half, cy);
    ctx.lineTo(cx - gap, cy);
    ctx.moveTo(cx + gap, cy);
    ctx.lineTo(cx + half, cy);
    ctx.moveTo(cx, cy - half);
    ctx.lineTo(cx, cy - gap);
    ctx.stroke();
  }

  // Drains threats.js's one-shot break-cue flag (set the frame a missile
  // crosses into its dodge_window_break range) and starts the crosshair
  // flash timer counting down.
  _updateBreakCue(threats, dt) {
    if (threats.consumeBreakCue()) this._breakCueTimer = BREAK_CUE_DURATION;
    else if (this._breakCueTimer > 0) this._breakCueTimer -= dt;
  }

  // "БРЕЙК!" doesn't tell a first-timer WHICH way to turn, so early on it
  // gets pulsing arrows on both sides (any direction works — see threats.js's
  // forgiving angular-velocity dodge check) to make that unmistakable. Once
  // the player has DODGE_ONBOARDING_COUNT successful dodges under their
  // belt, the arrows stop drawing — they've got it, no need to keep pointing.
  _drawBreakCue(threats, w, h) {
    if (this._breakCueTimer <= 0) return;
    const ctx = this.ctx;
    const t = this._breakCueTimer / BREAK_CUE_DURATION;
    const cx = w / 2;
    const cy = h / 2 + 46; // just below the crosshair, out of its way
    const alpha = Math.max(0, Math.min(1, t));

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '700 30px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffe14d';
    ctx.fillText('БРЕЙК!', cx, cy);

    if (threats.dodgeCount < DODGE_ONBOARDING_COUNT) {
      const now = performance.now() * 0.001;
      const pulse = 0.5 + 0.5 * Math.sin(now * 6);
      const arrowOffset = 78 + pulse * 12; // px from center, breathing outward
      ctx.fillText('←', cx - arrowOffset, cy);
      ctx.fillText('→', cx + arrowOffset, cy);
    }
    ctx.restore();
  }

  _drawReadouts(flight, fear, w, h) {
    const ctx = this.ctx;
    const glitching = this._glitchTimer > 0;
    const intensity40 = fear.intensity(FEAR_CONFIG.THRESHOLDS.HUD_GLITCH);
    const intensity80 = fear.intensity(FEAR_CONFIG.THRESHOLDS.WARP);

    const speed = glitching ? this._glitchSpd : Math.round(flight.speed);
    const altitude = glitching ? this._glitchAlt : Math.round(flight.altitude);

    // 40+: subtle continuous flicker; a glitch burst flickers much harder.
    let alpha = 1 - (intensity40 > 0 ? Math.random() * FEAR_CONFIG.HUD_FLICKER_ALPHA * intensity40 : 0);
    if (glitching) alpha *= 0.3 + Math.random() * 0.7;

    // 80+: readouts jitter around their normal spot, HUD "mostly unreadable".
    const jitter = FEAR_CONFIG.HUD_UNREADABLE_JITTER * intensity80;
    const jx = jitter > 0 ? (Math.random() - 0.5) * 2 * jitter : 0;
    const jy = jitter > 0 ? (Math.random() - 0.5) * 2 * jitter : 0;

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.translate(jx, jy);

    ctx.font = '600 22px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = glitching ? '#ff5a5a' : TEXT_COLOR;
    ctx.textBaseline = 'middle';

    ctx.textAlign = 'left';
    ctx.fillText(`SPD ${speed}`, w * 0.5 - 190, h - 46);
    ctx.textAlign = 'right';
    ctx.fillText(`ALT ${altitude}`, w * 0.5 + 190, h - 46);

    ctx.font = '400 13px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(242,242,234,0.7)';
    ctx.fillText('units/s', w * 0.5 - 190, h - 24);
    ctx.fillText('meters', w * 0.5 + 190, h - 24);
    ctx.restore();
  }

  // Fear IS the health system (no separate HP bar), so this needs to read as
  // the stakes bar it now is: wider than the old placeholder, pulsing red
  // above the WARP(80) threshold, with a skull tick marking the 100 = panic
  // line.
  _drawFearBar(fear, w, h) {
    const ctx = this.ctx;
    const barW = 15;
    const barH = h * 0.55;
    const x = 18;
    const yTop = (h - barH) / 2;
    const t = fear.normalized;

    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(x, yTop, barW, barH);

    const fillH = barH * t;
    const r = Math.round(lerp(FEAR_LOW_COLOR[0], FEAR_HIGH_COLOR[0], t));
    const g = Math.round(lerp(FEAR_LOW_COLOR[1], FEAR_HIGH_COLOR[1], t));
    const b = Math.round(lerp(FEAR_LOW_COLOR[2], FEAR_HIGH_COLOR[2], t));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, yTop + barH - fillH, barW, fillH);

    // 80+: the fill (and border) throb between normal and a hot red flash —
    // panic is one bad hit away, the bar needs to say so without words.
    const warpIntensity = fear.intensity(FEAR_CONFIG.THRESHOLDS.WARP);
    if (warpIntensity > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.012);
      ctx.fillStyle = `rgba(255,40,40,${(0.2 + 0.5 * pulse) * warpIntensity})`;
      ctx.fillRect(x - 2, yTop + barH - fillH - 2, barW + 4, fillH + 4);
    }

    ctx.strokeStyle = warpIntensity > 0 ? `rgba(255,80,80,${0.5 + 0.5 * warpIntensity})` : 'rgba(242,242,234,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, yTop + 0.5, barW - 1, barH - 1);

    // Skull tick at the 100 mark — small and always there, a fixed reference
    // for "this is where panic happens," not something that only appears
    // once you're already at risk.
    ctx.font = '12px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(242,242,234,0.8)';
    ctx.fillText('\u{1F480}', x + barW / 2, yTop - 3);
  }

  // RWR-style edge indicator: an open chevron (stroked ">" wedge, not a
  // filled shape) at the screen border toward each threat NOT already
  // visible on-screen. A filled triangle used to read as "the missile
  // itself" from a distance — a chevron can't be mistaken for that. Pulses
  // during lock-on (nothing else to see yet); steady once launched but still
  // off-screen (the real missile + trail carries it once it's in view, see
  // getBearings' `inView`).
  _drawThreatIndicators(threats, flight, w, h) {
    const bearings = threats.getBearings(flight);
    if (!bearings.length) return;

    const ctx = this.ctx;
    const cx = w / 2;
    const cy = h / 2;
    const marginW = w / 2 - 24;
    const marginH = h / 2 - 24;
    const now = performance.now() * 0.001;

    for (const b of bearings) {
      if (b.inView) continue; // the real missile + trail is on-screen; don't clutter with a redundant edge marker
      const dx = -Math.sin(b.angle);
      const dy = -Math.cos(b.angle);
      const scaleX = dx !== 0 ? marginW / Math.abs(dx) : Infinity;
      const scaleY = dy !== 0 ? marginH / Math.abs(dy) : Infinity;
      const scale = Math.min(scaleX, scaleY);
      const px = cx + dx * scale;
      const py = cy + dy * scale;
      const outward = Math.atan2(dy, dx);

      const pulse = b.warning ? 0.5 + 0.5 * Math.sin(now * 14) : 1;
      const size = 10 + (b.warning ? 4 * pulse : 0);
      const alpha = b.warning ? 0.5 + 0.5 * pulse : 0.85;

      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(outward);
      ctx.strokeStyle = `rgba(221,34,34,${alpha})`;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(-size * 0.5, -size * 0.6);
      ctx.lineTo(size * 0.6, 0);
      ctx.lineTo(-size * 0.5, size * 0.6);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Heading-up cockpit radar, bottom-right: the player's nose is always
  // "up" (localForward from threats.getRadarContacts), so contacts need no
  // rotation, just a straight coordinate scale from world units to px. This
  // is the main fix for "I don't know where missiles come from" — the edge
  // chevron only fires once a threat is already close to the view cone;
  // the radar shows it the moment it exists, from any direction.
  _drawRadar(threats, flight, fear, dt, w, h) {
    const ctx = this.ctx;
    const R = RADAR_DIAMETER / 2;
    const cx = w - RADAR_MARGIN - R;
    const cy = h - RADAR_MARGIN - R;

    // Auto-zoom: once the nearest homing missile closes inside
    // RADAR_ZOOM_TRIGGER_DIST, smoothly lerp from the default range down to
    // the tighter RADAR_ZOOM_RANGE so the endgame of a dodge (dot vs. player
    // dot separation) is actually readable, then relax back out once clear.
    const nearestDist = threats.nearestHomingMissileDist(flight);
    const targetRange = nearestDist < THREATS_CONFIG.RADAR_ZOOM_TRIGGER_DIST
      ? THREATS_CONFIG.RADAR_ZOOM_RANGE
      : THREATS_CONFIG.RADAR_RANGE;
    const zoomT = 1 - Math.exp(-RADAR_ZOOM_LERP_RATE * dt);
    this._radarRangeCurrent = lerp(this._radarRangeCurrent, targetRange, zoomT);
    const range = this._radarRangeCurrent;

    // 60+: flickers like every other cockpit instrument — it's part of the
    // panel, fear affects it same as the readouts (see _drawReadouts).
    const vignetteIntensity = fear.intensity(FEAR_CONFIG.THRESHOLDS.VIGNETTE);
    const alpha = vignetteIntensity > 0 ? 1 - Math.random() * FEAR_CONFIG.HUD_FLICKER_ALPHA * vignetteIntensity : 1;

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(8,12,10,0.55)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = ACCENT_COLOR;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(245,197,24,0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Player = center dot with a short nose tick (heading-up: this is fixed,
    // always pointing up — everything else moves around it).
    ctx.fillStyle = ACCENT_COLOR;
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = ACCENT_COLOR;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx, cy - 10);
    ctx.stroke();

    for (const c of threats.getRadarContacts(flight, range)) {
      const px = cx + (c.localRight / range) * R;
      const py = cy - (c.localForward / range) * R;

      // Expired missile: no dot to draw fresh, just a grey flash fading over
      // RADAR_ECHO_DURATION — the radar's confirmation that a dodge/near-miss
      // just resolved, since the missile itself is already gone.
      if (c.type === 'echo') {
        ctx.fillStyle = `rgba(154,160,166,${Math.max(0, c.alpha) * 0.9})`;
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      // Fighter dots go orange while lining up (rear-quarter attack
      // telegraphed — see threats.js's radarLineup), grey otherwise.
      const color = c.type === 'fighter' ? (c.lineup ? '#ff9633' : '#9aa0a6') : '#dd2222';

      // Fading trail of recent positions, drawn oldest-first (so the newest
      // segment paints on top) — this is what makes an overshoot/hard-turn
      // dodge readable on the radar, not just out the window.
      if (c.trail.length > 1) {
        ctx.strokeStyle = color;
        ctx.lineCap = 'round';
        for (let i = c.trail.length - 1; i > 0; i--) {
          const a = c.trail[i];
          const b = c.trail[i - 1];
          const ax = cx + (a.localRight / range) * R;
          const ay = cy - (a.localForward / range) * R;
          const bx = cx + (b.localRight / range) * R;
          const by = cy - (b.localForward / range) * R;
          ctx.globalAlpha = Math.max(0, Math.min(1, a.alpha)) * 0.6 * Math.max(0, Math.min(1, alpha));
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
        }
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      }

      // Dodge window is open for this missile: a pulsing ring around the dot
      // so the radar itself flags "this one's telegraphing," matching the
      // rising tone / crosshair flash (see threats.js's _updateDodgeWindow).
      if (c.dodgeWindow) {
        const now = performance.now() * 0.001;
        const pulse = 0.5 + 0.5 * Math.sin(now * 9);
        ctx.strokeStyle = `rgba(255,225,77,${0.35 + 0.5 * pulse})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(px, py, 5 + 3 * pulse, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, py, c.type === 'fighter' ? 2.5 : 3, 0, Math.PI * 2);
      ctx.fill();

      // Heading line: where the contact is going right now, not where it's
      // been — longer than the old stub tick so it reads as a direction, not
      // just a nub.
      if (c.dirRight !== null) {
        const tickLen = 12;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + c.dirRight * tickLen, py - c.dirForward * tickLen);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  _drawRadio(radio, w, h) {
    if (!radio.active) return;
    const ctx = this.ctx;
    const boxW = Math.min(720, w * 0.8);
    const x = (w - boxW) / 2;
    const y = h - 150;

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x, y, boxW, 96);

    ctx.font = '400 15px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = TEXT_COLOR;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(radio.subtitle, x + 16, y + 10, boxW - 32);

    ctx.font = '600 14px "Segoe UI", system-ui, sans-serif';
    radio.options.forEach((opt, i) => {
      ctx.fillStyle = ACCENT_COLOR;
      ctx.fillText(`${i + 1}. ${opt}`, x + 16, y + 40 + i * 18, boxW - 32);
    });

    const barW = boxW - 32;
    const frac = Math.max(0, radio.answerTimer) / RADIO_CONFIG.ANSWER_WINDOW;
    ctx.fillStyle = 'rgba(245,197,24,0.25)';
    ctx.fillRect(x + 16, y + 88, barW, 4);
    ctx.fillStyle = ACCENT_COLOR;
    ctx.fillRect(x + 16, y + 88, barW * Math.max(0, Math.min(1, frac)), 4);
  }

  // 5 dots (one per wave) + a tiny bottle icon at the end for Istanbul.
  _drawProgressStrip(route, w, h) {
    const ctx = this.ctx;
    const count = WAVES.length;
    const spacing = 32;
    const totalW = spacing * (count - 1);
    const startX = w / 2 - totalW / 2;
    const y = 24;

    for (let i = 0; i < count; i++) {
      const x = startX + i * spacing;
      const isCurrent = i === route.waveIndex;
      const isPast = i < route.waveIndex;
      const r = isCurrent ? 7 : 5;

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = isCurrent ? ACCENT_COLOR : isPast ? 'rgba(245,197,24,0.55)' : 'rgba(255,255,255,0.25)';
      ctx.fill();
      if (isCurrent) {
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    const bx = startX + spacing * (count - 1) + 24;
    this._drawBottleIcon(bx, y);
  }

  // The signature yellow cologne bottle, small and uncaptioned — used on the
  // progress strip (Istanbul's marker) and the panic screen's corner icon.
  _drawBottleIcon(x, y) {
    const ctx = this.ctx;
    ctx.fillStyle = ACCENT_COLOR;
    ctx.fillRect(x - 3, y - 7, 6, 10); // bottle body
    ctx.fillRect(x - 1.5, y - 10, 3, 4); // bottle neck
  }

  _drawTransitionCard(route, w, h) {
    if (route.phase !== 'transition') return;
    const ctx = this.ctx;
    const cx = w / 2;
    const cy = h / 2;

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(cx - 240, cy - 55, 480, 110);

    ctx.font = '700 34px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = ACCENT_COLOR;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(route.cardText, cx, cy - 10);

    ctx.font = '400 14px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(242,242,234,0.75)';
    ctx.fillText('Entering airspace...', cx, cy + 24);
    ctx.restore();
  }

  // PLACEHOLDER end screen: route.js's Stage 7 landing sequence doesn't
  // exist yet (see route.js's _completeRoute comment), so this is the only
  // thing that currently marks "you made it" once finale_offering (main.js)
  // has played and route.phase reaches 'complete' — reusing the transition
  // card's look rather than building real end-screen UI. Replace this with
  // the real landing/end screen once Stage 7 lands.
  _drawEndCard(route, w, h) {
    if (route.phase !== 'complete') return;
    const ctx = this.ctx;
    const cx = w / 2;
    const cy = h / 2;

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(cx - 240, cy - 55, 480, 110);

    ctx.font = '700 34px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = ACCENT_COLOR;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('СТАМБУЛ', cx, cy - 10);

    ctx.font = '400 14px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(242,242,234,0.75)';
    ctx.fillText('Одеколон уже близко.', cx, cy + 24);
    ctx.restore();

    this._drawBottleIcon(w / 2, cy + 66);
  }

  // Detects the panic screen's rising edge (route.phase just became
  // 'restart-flash') to reset its fade-in timer, pick a random dispatcher
  // line once per occurrence, and play the arrival sting — reusing
  // audio.playRadioBlip()'s filtered-noise blips, which already reads as a
  // short radio-static crackle, rather than adding a near-duplicate sound.
  _updatePanicScreen(route, audio, dt) {
    const active = route.phase === 'restart-flash';
    if (active && !this._panicScreenWasActive) {
      this._panicScreenTimer = 0;
      const line = PANIC_LINES[Math.floor(Math.random() * PANIC_LINES.length)];
      this._panicLine = line ? line.prompt : '';
      audio.playRadioBlip();
    }
    if (active) this._panicScreenTimer += dt;
    this._panicScreenWasActive = active;
  }

  // Full-screen failure interstitial: title fades in over
  // PANIC_TITLE_FADE_DURATION, dispatcher line, which country restarts, and
  // two HUD-styled buttons. Sits on top of main.js's desaturated cockpit
  // freeze-frame (#panic-freeze) — the dark scrim here keeps text readable
  // regardless of how bright that captured frame was. Interaction is
  // keyboard-only (Enter/Esc, handled in main.js), matching the radio's
  // digit-key choices — this game has no mouse-driven UI anywhere else.
  _drawPanicScreen(route, w, h) {
    if (route.phase !== 'restart-flash') return;
    const ctx = this.ctx;
    const cx = w / 2;
    const cy = h / 2;

    const fadeT = Math.min(this._panicScreenTimer / PANIC_TITLE_FADE_DURATION, 1);
    const eased = fadeT * fadeT * (3 - 2 * fadeT);

    ctx.save();
    ctx.fillStyle = 'rgba(10,10,8,0.45)';
    ctx.fillRect(0, 0, w, h);

    ctx.globalAlpha = eased;
    ctx.textAlign = 'center';

    ctx.font = '800 46px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f2f2ea';
    const title = 'ТЫ ЗАПАНИКОВАЛ';
    const titleY = cy - 100;
    ctx.fillText(title, cx, titleY);
    const titleWidth = ctx.measureText(title).width;
    ctx.fillStyle = ACCENT_COLOR;
    ctx.fillRect(cx - titleWidth / 2, titleY + 10, titleWidth, 4);

    if (this._panicLine) {
      ctx.font = '400 16px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = TEXT_COLOR;
      ctx.fillText(this._panicLine, cx, cy - 40, w * 0.75);
    }

    ctx.font = '600 15px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(242,242,234,0.75)';
    ctx.fillText(`Заново: ${WAVES[route.waveIndex].country}`, cx, cy + 4);

    this._drawPanicButton(cx - 150, cy + 50, 270, 52, '[ Соберись и лети ]');
    this._drawPanicButton(cx + 150, cy + 50, 190, 52, '[ В меню ]');

    ctx.restore();

    this._drawBottleIcon(w - 36, h - 36); // full opacity regardless of the title's fade
  }

  _drawPanicButton(centerX, y, width, height, label) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(10,14,10,0.7)';
    ctx.fillRect(centerX - width / 2, y, width, height);
    ctx.strokeStyle = ACCENT_COLOR;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(centerX - width / 2 + 0.5, y + 0.5, width - 1, height - 1);

    ctx.font = '700 16px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = ACCENT_COLOR;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, centerX, y + height / 2);
  }

  // D key — live view of the fear economy rebalance: current value vs. the
  // wave's floor, and which continuous sources (calm-decay, missile-lockon,
  // missile-close, fighter-presence...) are touching fear THIS frame. Plain
  // monospace panel, functional not pretty — this is a tuning tool.
  _drawDebugOverlay(fear, threats, route, w, h) {
    if (!this._debugVisible) return;
    const ctx = this.ctx;
    const x = 12;
    const y = 40; // below the FPS counter, which lives in the same top-left corner
    const lineH = 16;

    const sources = fear.activeSources;
    const lines = [
      'FEAR DEBUG (D to hide)',
      `value: ${fear.value.toFixed(1)}  floor: ${fear.floor.toFixed(1)}  wave: ${route.waveIndex}`,
      `threats active: ${threats.hasActiveThreats()}`,
      `sources: ${sources.length ? sources.join(', ') : '(none)'}`,
    ];

    ctx.font = '12px "Consolas", "Courier New", monospace';
    const panelW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20;
    const panelH = lines.length * lineH + 12;

    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x, y, panelW, panelH);
    ctx.strokeStyle = ACCENT_COLOR;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, panelW - 1, panelH - 1);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = ACCENT_COLOR;
    lines.forEach((line, i) => ctx.fillText(line, x + 10, y + 8 + i * lineH));
  }

  // T key — per-fighter state/distance/bearing, top-right so it doesn't
  // collide with the D overlay. The point is telling "orbiting me" from
  // "wandering off" at a glance during playtesting: dist/angle should stay
  // roughly within the escort radius and the +/-120 deg front bias while
  // PATROLling. noseDiv is threats.js's live nose-vs-actual-velocity check
  // (see getFighterDebugInfo) — should read ~0.0 always; a nonzero value
  // means something moved a fighter without going through _steerFighter.
  _drawFighterDebugOverlay(threats, flight, w, h) {
    if (!this._fighterDebugVisible) return;
    const ctx = this.ctx;
    const y = 40;
    const lineH = 16;

    const info = threats.getFighterDebugInfo(flight);
    const lines = [
      'FIGHTER DEBUG (T to hide)',
      ...(info.length
        ? info.map(
            (f, i) =>
              `#${i} ${f.state}${f.phase ? '/' + f.phase : ''}  dist:${f.dist}  angle:${f.angleDeg > 0 ? '+' : ''}${f.angleDeg}deg  noseDiv:${f.noseDivergenceDeg}deg`
          )
        : ['(no active fighters)']),
    ];

    ctx.font = '12px "Consolas", "Courier New", monospace';
    const panelW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20;
    const panelH = lines.length * lineH + 12;
    const x = w - panelW - 12;

    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x, y, panelW, panelH);
    ctx.strokeStyle = ACCENT_COLOR;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, panelW - 1, panelH - 1);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = ACCENT_COLOR;
    lines.forEach((line, i) => ctx.fillText(line, x + 10, y + 8 + i * lineH));
  }
}