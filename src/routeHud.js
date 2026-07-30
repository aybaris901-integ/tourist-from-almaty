import { WAVES } from './route.js';

const KOLONYA_URL = '/img/kolonya.png';

// WAVES[i].country is flavor text for the big transition card ("Turkey —
// Inland", "Istanbul Approach") — too long for a compact status line, so the
// route strip gets its own short labels. Flag art follows the same mapping:
// WAVES 3/4 are both Turkey (Istanbul reuses the Turkey track/flag, same as
// musicManager.js's TRACKS), so index 4 reuses the Turkey svg — but its
// label is ISTANBUL, not a second TURKEY, so the status line never reads
// "TURKEY → TURKEY". Istanbul (index 4) is the last geographic checkpoint;
// the bottle is a 6th, separate node after it.
const FLAG_KEYS = ['kazakhstan', 'azerbaijan', 'georgia', 'turkey', 'turkey'];
const SHORT_NAMES = ['KAZAKHSTAN', 'AZERBAIJAN', 'GEORGIA', 'TURKEY', 'ISTANBUL'];

// A single reusable 4-point star path, repositioned per flag — real flags'
// exact star geometry doesn't read at 18px HUD height anyway.
const STAR = (cx, cy) =>
  `M${cx} ${cy - 1.7} L${cx + 0.6} ${cy - 0.4} L${cx + 2} ${cy - 0.1} L${cx + 1} ${cy + 0.9} L${cx + 1.3} ${cy + 2.3} L${cx} ${cy + 1.6} L${cx - 1.3} ${cy + 2.3} L${cx - 1} ${cy + 0.9} L${cx - 2} ${cy - 0.1} L${cx - 0.6} ${cy - 0.4} Z`;

const FLAG_SVG = {
  kazakhstan: `<svg viewBox="0 0 30 20">
    <rect width="30" height="20" fill="#00afca"/>
    <circle cx="15" cy="10" r="4.2" fill="#fec50c"/>
    <g stroke="#fec50c" stroke-width="0.7" stroke-linecap="round">
      <line x1="15" y1="10" x2="15" y2="2"/>
      <line x1="15" y1="10" x2="21.5" y2="5.5"/>
      <line x1="15" y1="10" x2="24" y2="10"/>
      <line x1="15" y1="10" x2="21.5" y2="14.5"/>
      <line x1="15" y1="10" x2="15" y2="18"/>
      <line x1="15" y1="10" x2="8.5" y2="14.5"/>
      <line x1="15" y1="10" x2="6" y2="10"/>
      <line x1="15" y1="10" x2="8.5" y2="5.5"/>
    </g>
    <rect x="0" y="0" width="3" height="20" fill="#fec50c"/>
  </svg>`,
  azerbaijan: `<svg viewBox="0 0 30 20">
    <rect width="30" height="6.667" y="0" fill="#00b5e2"/>
    <rect width="30" height="6.667" y="6.667" fill="#ef3340"/>
    <rect width="30" height="6.667" y="13.333" fill="#509e2f"/>
    <circle cx="15.4" cy="10" r="3" fill="#fff"/>
    <circle cx="16.4" cy="10" r="2.4" fill="#ef3340"/>
    <path d="${STAR(19.6, 10)}" fill="#fff"/>
  </svg>`,
  georgia: `<svg viewBox="0 0 30 20">
    <rect width="30" height="20" fill="#fff"/>
    <rect x="12.3" y="0" width="5.4" height="20" fill="#d0132a"/>
    <rect x="0" y="7.3" width="30" height="5.4" fill="#d0132a"/>
    <g fill="#d0132a">
      <rect x="4.6" y="2.7" width="2.4" height="0.9"/>
      <rect x="5.5" y="1.8" width="0.9" height="2.4"/>
      <rect x="23" y="2.7" width="2.4" height="0.9"/>
      <rect x="23.9" y="1.8" width="0.9" height="2.4"/>
      <rect x="4.6" y="16.4" width="2.4" height="0.9"/>
      <rect x="5.5" y="15.5" width="0.9" height="2.4"/>
      <rect x="23" y="16.4" width="2.4" height="0.9"/>
      <rect x="23.9" y="15.5" width="0.9" height="2.4"/>
    </g>
  </svg>`,
  turkey: `<svg viewBox="0 0 30 20">
    <rect width="30" height="20" fill="#e30a17"/>
    <circle cx="12.5" cy="10" r="4.6" fill="#fff"/>
    <circle cx="13.9" cy="10" r="3.7" fill="#e30a17"/>
    <path d="${STAR(18.5, 10)}" fill="#fff"/>
  </svg>`,
};

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// kolonya.png ships as a full square promotional frame: the bottle on a flat
// gray background with its own baked-in glow, lots of empty margin. This
// chroma-keys the flat background out (same corner-sampling approach as
// menu.js's stripFlatBackground, kept separate here rather than shared —
// logo.png's badge framing shouldn't get auto-cropped, this asset should)
// and then crops to the opaque pixels' bounding box, so the route HUD gets a
// tight transparent cutout instead of "the original full promotional image
// with lemons and background". Never touches the source file itself.
function loadCroppedBottle(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const imageData = ctx.getImageData(0, 0, w, h);
        const px = imageData.data;
        const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + (w - 1)) * 4];
        let r = 0;
        let g = 0;
        let b = 0;
        for (const idx of corners) {
          r += px[idx];
          g += px[idx + 1];
          b += px[idx + 2];
        }
        r /= corners.length;
        g /= corners.length;
        b /= corners.length;

        const THRESH_IN = 18; // fully transparent within this color distance of the background
        const THRESH_OUT = 55; // fully opaque past this distance — soft ramp in between
        let minX = w;
        let minY = h;
        let maxX = 0;
        let maxY = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const dr = px[i] - r;
            const dg = px[i + 1] - g;
            const db = px[i + 2] - b;
            const dist = Math.sqrt(dr * dr + dg * dg + db * db);
            if (dist <= THRESH_IN) {
              px[i + 3] = 0;
            } else if (dist < THRESH_OUT) {
              px[i + 3] = Math.round((px[i + 3] * (dist - THRESH_IN)) / (THRESH_OUT - THRESH_IN));
            }
            if (px[i + 3] > 8) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        ctx.putImageData(imageData, 0, 0);

        if (maxX <= minX || maxY <= minY) {
          resolve(canvas.toDataURL('image/png')); // nothing survived the key — fall back to the untrimmed cutout
          return;
        }
        const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.03); // a little breathing room, not a hard crop to the pixel
        const cx0 = Math.max(0, minX - pad);
        const cy0 = Math.max(0, minY - pad);
        const cw = Math.min(w, maxX + pad) - cx0;
        const ch = Math.min(h, maxY + pad) - cy0;

        const cropped = document.createElement('canvas');
        cropped.width = cw;
        cropped.height = ch;
        cropped.getContext('2d').drawImage(canvas, cx0, cy0, cw, ch, 0, 0, cw, ch);
        resolve(cropped.toDataURL('image/png'));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = reject;
    img.src = url;
  });
}

// Compact HUD-style route strip (top center, see index.html's #route-hud):
// one unified row — 5 country flags + the cologne bottle as a 6th node, all
// on one baseline, connected by a single continuous route line (track +
// yellow fill) that sits behind them. Driven from main.js's render loop the
// same way ui.js is, just as a sibling DOM system rather than a canvas one.
export class RouteHud {
  constructor(rootEl) {
    this.root = rootEl;
    this._visible = false;
    this._lastWaveIndex = -1;
    this._reached = false;

    this.root.innerHTML = `
      <div class="route-strip">
        <div class="route-row">
          <div class="route-line-track"></div>
          <div class="route-line-fill"></div>
          ${WAVES.map((_, i) => `<div class="route-flag" data-index="${i}">${FLAG_SVG[FLAG_KEYS[i]]}</div>`).join('')}
          <div class="route-bottle">
            <div class="route-bottle-ring"></div>
            <img class="route-bottle-img" src="${KOLONYA_URL}" alt="Limon kolonyası" />
          </div>
        </div>
        <div class="route-status">
          <span class="route-status-label"></span>
          <span class="route-status-distance"></span>
        </div>
      </div>
    `;

    this.stripEl = this.root.querySelector('.route-strip');
    this.lineFillEl = this.root.querySelector('.route-line-fill');
    this.flagEls = Array.from(this.root.querySelectorAll('.route-flag'));
    this.bottleEl = this.root.querySelector('.route-bottle');
    this.bottleImgEl = this.root.querySelector('.route-bottle-img');
    this.statusEl = this.root.querySelector('.route-status');
    this.statusLabelEl = this.root.querySelector('.route-status-label');
    this.statusDistEl = this.root.querySelector('.route-status-distance');

    // Falls back to the raw file (already the <img>'s src above) if cropping
    // ever fails — same fallback semantics as menu.js's stripFlatBackground.
    loadCroppedBottle(KOLONYA_URL)
      .then((dataUrl) => {
        this.bottleImgEl.src = dataUrl;
      })
      .catch(() => {});
  }

  setVisible(visible) {
    if (this._visible === visible) return;
    this._visible = visible;
    this.root.classList.toggle('hidden', !visible);
  }

  // main.js calls this from resetGameState(), alongside every other system's
  // resetForReplay(), so a fresh playthrough doesn't inherit a stale
  // "just crossed a border" / "already reached" edge from the previous one.
  resetForReplay() {
    this._lastWaveIndex = -1;
    this._reached = false;
    this.flagEls.forEach((el) => el.classList.remove('route-flag--enter'));
    this.bottleEl.classList.remove('is-reached', 'route-bottle--pulse');
    this.lineFillEl.classList.remove('route-line-fill--flash');
    this.statusEl.classList.remove('is-reached');
  }

  update(route, flight) {
    const count = WAVES.length;
    const waveIndex = route.waveIndex;
    const wave = WAVES[waveIndex];

    this.flagEls.forEach((el, i) => {
      el.classList.toggle('is-current', i === waveIndex);
      el.classList.toggle('is-past', i < waveIndex);
      el.classList.toggle('is-upcoming', i > waveIndex);
    });

    if (this._lastWaveIndex !== -1 && waveIndex !== this._lastWaveIndex) {
      this._flashCrossing(waveIndex);
    }
    this._lastWaveIndex = waveIndex;

    // Continuous route-line fill: 0 at departure -> 1 at Istanbul's arrival,
    // smoothly advancing within a leg (segT) as well as stepping between
    // legs — this is also what "fills toward the bottle" on the final leg,
    // no separate case needed.
    const segT = route.phase === 'flying' ? clamp01(route.waveElapsed / wave.duration) : 0;
    const progress = clamp01((waveIndex + segT) / (count - 1));
    const reached = route.phase === 'calm-payoff' || route.phase === 'landing' || route.phase === 'complete';

    if (reached && !this._reached) {
      this._reached = true;
      this._flashReached();
    }

    this.stripEl.style.setProperty('--route-fill', reached ? '1' : progress.toFixed(3));

    // Bottle opacity/glow: 3 fixed steps, not a continuous ramp — subtle
    // before the final country, stronger on the final segment, full once
    // actually reached.
    const onFinalSegment = waveIndex === count - 1;
    const bottleOpacity = reached ? 1 : onFinalSegment ? 0.8 : 0.45;
    this.bottleEl.style.setProperty('--bottle-opacity', bottleOpacity.toFixed(2));
    this.bottleEl.classList.toggle('is-reached', reached);

    if (reached) {
      this.statusLabelEl.textContent = 'DESTINATION REACHED · LIMON KOLONYASI';
      this.statusDistEl.style.display = 'none';
      this.statusEl.classList.add('is-reached');
      return;
    }
    this.statusDistEl.style.display = '';
    this.statusEl.classList.remove('is-reached');

    // Distance: remaining wave time (s) * flight.speed, normalized to km.
    // flight.speed is labeled "units/s" in the cockpit SPD readout (see
    // ui.js), but its actual magnitude (BASE_SPEED 250, see flight.js) only
    // makes sense as meters/second — 250 m/s = 900 km/h, a plausible fighter
    // cruise speed. Treating it as literal km/h or km/s either stalls the
    // route (900 km/h * seconds without /3600 is still huge) or produces the
    // "25050 KM"-scale bug this replaces: dividing by 1000 (m/s -> km/s) is
    // the only branch that lands in a sane tens-to-low-hundreds km range.
    const remainingTimeSeconds = Math.max(0, wave.duration - route.waveElapsed);
    const remainingDistanceKm = (remainingTimeSeconds * flight.speed) / 1000;
    const displayDistanceKm = Math.max(0, Math.round(remainingDistanceKm / 10) * 10);

    const current = SHORT_NAMES[waveIndex];
    const next = waveIndex < count - 1 ? SHORT_NAMES[waveIndex + 1] : 'LIMON KOLONYASI';
    this.statusLabelEl.textContent = `${current} → ${next} ·`;
    this.statusDistEl.textContent = `${displayDistanceKm} KM`;
  }

  // Border-crossing: the completed line section flashes yellow, the newly-
  // current flag slides/scales into place, the previous one just dims via
  // its own is-past CSS transition (no extra animation needed there).
  // `animationend` (not a timer) drives cleanup so nothing lingers if a
  // frame hitch stretches the CSS animation's real duration.
  _flashCrossing(waveIndex) {
    this.lineFillEl.classList.remove('route-line-fill--flash');
    void this.lineFillEl.offsetWidth; // restart the animation if one's already mid-flight
    this.lineFillEl.classList.add('route-line-fill--flash');
    this.lineFillEl.addEventListener(
      'animationend',
      () => this.lineFillEl.classList.remove('route-line-fill--flash'),
      { once: true }
    );

    const enteringEl = this.flagEls[waveIndex];
    enteringEl.classList.remove('route-flag--enter');
    void enteringEl.offsetWidth;
    enteringEl.classList.add('route-flag--enter');
    enteringEl.addEventListener('animationend', () => enteringEl.classList.remove('route-flag--enter'), {
      once: true,
    });
  }

  // Final destination: bottle scale-up-and-back plus a ring pulse (the
  // is-reached class above already handles the settle-into-place opacity/
  // glow via a plain CSS transition — this is just the one-shot flourish).
  _flashReached() {
    this.bottleEl.classList.add('route-bottle--pulse');
    this.bottleEl.addEventListener('animationend', () => this.bottleEl.classList.remove('route-bottle--pulse'), {
      once: true,
    });
  }
}
