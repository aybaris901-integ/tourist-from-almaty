// Generic keyboard-navigable screen-stack menu (Stage 7B) — reused for both
// the main menu shell and the pause overlay. Owns only rendering + nav;
// main.js supplies each screen's items (and what they do) via build functions
// so this file knows nothing about game state, settings, or progress.
//
// Item shapes (all besides 'panel' are focusable, arrows move between them):
//   { label, action }                          — plain button, Enter/click fires action
//   { type: 'toggle', label, value, onToggle }  — Enter/Left/Right/click flips it
//   { type: 'slider', label, fill, valueText, onAdjust(dir), onSet(fraction) } — Left/Right adjusts (dir -1/+1), click/drag on the track calls onSet(0..1)
//   { type: 'panel', html }                     — raw non-interactive HTML block
export class MenuUI {
  constructor(containerEl) {
    this.container = containerEl;
    this._stack = [];
    this.onEscapeAtRoot = null; // pause menu wires this to "resume"; main menu leaves it unset (no-op)
    this._onKeyDown = (e) => this._handleKey(e);
  }

  isOpen() {
    return this._stack.length > 0;
  }

  // main.js's credits screen can open on top of an already-open menu (e.g.
  // the main menu's "Титры" button) — it's a separate DOM overlay, so clicks
  // naturally can't reach the menu items underneath, but a window-level
  // keydown listener has no such visual scoping. Callers suspend() before
  // showing that overlay and resume() on dismiss; resume() is a no-op if
  // this menu was already closed in the meantime (e.g. the post-finale
  // credits, which have no menu open under them at all).
  suspend() {
    window.removeEventListener('keydown', this._onKeyDown);
  }

  resume() {
    if (this.isOpen()) window.addEventListener('keydown', this._onKeyDown);
  }

  // Clears any existing stack and shows `name` as the new root screen.
  // `build` is a zero-arg function returning this screen's items array —
  // called fresh after every interaction so displayed values (slider
  // fill, toggle state) never go stale.
  open(name, build) {
    this._stack = [{ name, build, focusIndex: null }];
    this.container.classList.remove('hidden');
    this._refresh();
    window.addEventListener('keydown', this._onKeyDown);
  }

  push(name, build) {
    this._stack.push({ name, build, focusIndex: null });
    this._refresh();
  }

  pop() {
    if (this._stack.length > 1) {
      this._stack.pop();
      this._refresh();
    }
  }

  close() {
    this._stack = [];
    this.container.classList.add('hidden');
    this.container.innerHTML = '';
    window.removeEventListener('keydown', this._onKeyDown);
  }

  _current() {
    return this._stack[this._stack.length - 1];
  }

  _focusableIndices(items) {
    const out = [];
    items.forEach((item, i) => {
      if (item.type !== 'panel') out.push(i);
    });
    return out;
  }

  _handleKey(e) {
    const screen = this._current();
    if (!screen) return;
    const items = screen.items || [];
    const focusable = this._focusableIndices(items);
    if (!focusable.length) return;

    if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
      e.preventDefault();
      const pos = focusable.indexOf(screen.focusIndex);
      const nextPos =
        e.code === 'ArrowDown'
          ? (pos + 1 + focusable.length) % focusable.length
          : (pos - 1 + focusable.length) % focusable.length;
      screen.focusIndex = focusable[nextPos < 0 ? 0 : nextPos];
      this._updateFocusClasses();
      return;
    }

    const item = items[screen.focusIndex];
    if (!item) return;

    if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
      const dir = e.code === 'ArrowRight' ? 1 : -1;
      if (item.type === 'slider') {
        e.preventDefault();
        item.onAdjust(dir);
        this._refresh();
      } else if (item.type === 'toggle') {
        e.preventDefault();
        item.onToggle();
        this._refresh();
      }
      return;
    }

    if (e.code === 'Enter') {
      e.preventDefault();
      if (item.type === 'toggle') item.onToggle();
      else if (item.action) item.action();
      this._refresh();
      return;
    }

    if (e.code === 'Escape') {
      e.preventDefault();
      if (this._stack.length > 1) this.pop();
      else this.onEscapeAtRoot?.();
    }
  }

  _refresh() {
    const screen = this._current();
    if (!screen) return;
    screen.items = screen.build();
    // First render of this screen (focusIndex still null), or the items
    // reshaped underneath the old focus (e.g. a panel now sits there) —
    // land on the first genuinely focusable item, not index 0 blindly (a
    // screen can legitimately start with a non-focusable 'panel' item, see
    // the Controls screen).
    const focusable = this._focusableIndices(screen.items);
    if (screen.focusIndex == null || !focusable.includes(screen.focusIndex)) {
      screen.focusIndex = focusable.length ? focusable[0] : 0;
    }
    this._render();
  }

  // Hover/arrow-key navigation only ever changes WHICH item is focused, never
  // the items themselves — toggling a class on the existing elements (rather
  // than tearing down and rebuilding the whole list via _render()) keeps
  // the DOM nodes under the cursor stable across a hover, which is what
  // makes click/hover reliable here: replacing an element out from under an
  // in-flight mousedown/mouseup is exactly the kind of thing that can eat a
  // click. Full _render() is still used wherever the actual items change
  // (see _refresh()).
  _updateFocusClasses() {
    const screen = this._current();
    if (!screen) return;
    const list = this.container.querySelector('.menu-list');
    if (!list) return;
    Array.from(list.children).forEach((el, i) => {
      el.classList.toggle('focused', i === screen.focusIndex);
    });
  }

  _render() {
    const screen = this._current();
    if (!screen) return;
    const items = screen.items || [];

    this.container.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'menu-list';

    items.forEach((item, i) => {
      const el = document.createElement('div');
      const focused = i === screen.focusIndex;
      el.className = `menu-item menu-item-${item.type || 'button'}${focused ? ' focused' : ''}`;

      if (item.type === 'panel') {
        el.innerHTML = item.html;
      } else if (item.type === 'slider') {
        el.innerHTML = `
          <span class="menu-item-label">${item.label}</span>
          <span class="menu-slider">
            <span class="menu-slider-track"><span class="menu-slider-fill" style="width:${Math.round(clamp01(item.fill) * 100)}%"></span></span>
            <span class="menu-slider-value">${item.valueText}</span>
          </span>`;
        el.addEventListener('mouseenter', () => {
          screen.focusIndex = i;
          this._updateFocusClasses();
        });
        // Click-to-set and drag-to-adjust on the track itself — arrow keys
        // alone can't satisfy "change volume with only the mouse".
        const track = el.querySelector('.menu-slider-track');
        if (track && item.onSet) {
          const setFromEvent = (ev) => {
            const rect = track.getBoundingClientRect();
            const fraction = rect.width > 0 ? clamp01((ev.clientX - rect.left) / rect.width) : 0;
            item.onSet(fraction);
          };
          track.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            screen.focusIndex = i;
            setFromEvent(ev);
            this._refresh();
            const onMove = (moveEv) => {
              setFromEvent(moveEv);
              this._refresh();
            };
            const onUp = () => {
              window.removeEventListener('mousemove', onMove);
              window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
          });
        }
      } else if (item.type === 'toggle') {
        el.innerHTML = `<span class="menu-item-label">${item.label}</span><span class="menu-toggle ${item.value ? 'on' : 'off'}">${item.value ? 'ВКЛ' : 'ВЫКЛ'}</span>`;
        el.addEventListener('click', () => {
          item.onToggle();
          this._refresh();
        });
        el.addEventListener('mouseenter', () => {
          screen.focusIndex = i;
          this._updateFocusClasses();
        });
      } else {
        el.textContent = item.label;
        el.addEventListener('click', () => {
          item.action?.();
          this._refresh();
        });
        el.addEventListener('mouseenter', () => {
          screen.focusIndex = i;
          this._updateFocusClasses();
        });
      }

      list.appendChild(el);
    });

    this.container.appendChild(list);
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// logo.png ships with a flat background (no image-editing tool was available
// to pre-process the file — see the commit that added this). Chroma-keys it
// out at runtime instead: samples the four corners for the background color,
// then punches a soft-edged hole wherever pixels are close to it. Resolves to
// a data URL for an <img>'s src; rejects (caller should just keep the
// original file as a fallback) if the image never loads.
export function stripFlatBackground(url) {
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
        for (let i = 0; i < px.length; i += 4) {
          const dr = px[i] - r;
          const dg = px[i + 1] - g;
          const db = px[i + 2] - b;
          const dist = Math.sqrt(dr * dr + dg * dg + db * db);
          if (dist <= THRESH_IN) px[i + 3] = 0;
          else if (dist < THRESH_OUT) px[i + 3] = Math.round((px[i + 3] * (dist - THRESH_IN)) / (THRESH_OUT - THRESH_IN));
        }
        ctx.putImageData(imageData, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = reject;
    img.src = url;
  });
}
