import * as THREE from 'three';
import { randRange, TOON_GRADIENT } from './utils.js';

// 4x the original size — pushes the finite plane's edge far past where fog
// (and the cloud/decor recycle radius) already fully obscures the view, so
// the player should never be able to see it, at the horizon or elsewhere.
const GROUND_SIZE = 96000;

const SKY_TOP = '#3d7fd6';
const SKY_HORIZON = '#bcd9ee';
const FOG_COLOR = 0xbcd9ee;
// Denser than the first pass — the ground/sky boundary needs to be fully
// fog-obscured well before the geometric horizon, or it reads as a razor
// edge (and the fear shader's chromatic aberration fringes that edge pink).
const FOG_DENSITY = 0.0004;
// Distance where FogExp2 has ~90% obscured everything: solving
// 1-exp(-(density*dist)^2)=0.9 for dist. Reused below as both the cloud
// recycle radius and the fade-to-zero distance, so clouds are never even
// rendered beyond where fog would hide them anyway.
const FOG_FADE_DISTANCE = Math.sqrt(Math.log(10)) / FOG_DENSITY;

const CLOUD_COUNT = 40;
const CLOUD_MIN_R = 800;
const CLOUD_MAX_R = FOG_FADE_DISTANCE;
const CLOUD_FADE_START_R = FOG_FADE_DISTANCE * 0.65; // opacity starts easing toward 0 here...
const CLOUD_FADE_END_R = FOG_FADE_DISTANCE; // ...and hits 0 right at the fog-fade distance — no pop
const CLOUD_REL_ALT_MIN = -300; // never more than 300m below the player
const CLOUD_REL_ALT_MAX = 800; // never more than 800m above the player
const CLOUD_ABS_ALT_MIN = 800; // hard floor regardless of player altitude
const CLOUD_ABS_ALT_MAX = 4800; // safety ceiling (player's own ceiling is ~4000)
const CLOUD_WIND = { x: 6, z: 2 }; // units/s, shared drift + small per-cloud variance
const CLOUD_SUN_WARMTH = 0.06; // max tint shift on the sun-aligned side — subtle, not a glow
// Horizontal direction toward the sun (matches World's DirectionalLight
// position below); used only to fake a very subtle sun-side warm tint on
// otherwise-white cloud sprites (billboards have no real "near/far side").
const SUN_DIR_FLAT = new THREE.Vector2(-400, 500).normalize();

const DECOR_COUNT = 26;
const DECOR_MIN_R = 600;
const DECOR_MAX_R = 6000;

function makeCheckerTexture() {
  const size = 256;
  const tiles = 8;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cell = size / tiles;
  for (let y = 0; y < tiles; y++) {
    for (let x = 0; x < tiles; x++) {
      const even = (x + y) % 2 === 0;
      // Subtle noise per-tile so it doesn't read as a perfectly flat checkerboard.
      const noise = Math.floor(randRange(-10, 10));
      const base = even ? 92 : 76;
      const g = Math.max(0, Math.min(255, base + noise));
      ctx.fillStyle = `rgb(${g - 20}, ${g + 10}, ${g - 25})`;
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(GROUND_SIZE / 40, GROUND_SIZE / 40);
  texture.anisotropy = 4;
  return texture;
}

function makeSkyTexture(topColor, horizonColor) {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, topColor);
  gradient.addColorStop(1, horizonColor);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// 'puffy' = dense round core, 'soft' = airier round falloff, 'streak' = the
// same soft falloff squashed into a wispy horizontal streak. Three shared
// sprite materials give the cloud layer visual variety for ~0 extra cost —
// every cloud instance just references one of these three.
function makeCloudTexture(kind) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  if (kind === 'streak') {
    ctx.translate(size / 2, size / 2);
    ctx.scale(1, 0.4);
    ctx.translate(-size / 2, -size / 2);
  }

  // Softer core opacity than a first pass at this — several overlapping
  // sprites stacking via alpha blending was reading as a blown-out glow.
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  if (kind === 'puffy') {
    gradient.addColorStop(0, 'rgba(255,255,255,0.8)');
    gradient.addColorStop(0.5, 'rgba(255,255,255,0.42)');
  } else {
    gradient.addColorStop(0, 'rgba(255,255,255,0.6)');
    gradient.addColorStop(0.55, 'rgba(255,255,255,0.28)');
  }
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function scatterAround(center, minR, maxR) {
  const angle = randRange(0, Math.PI * 2);
  const r = randRange(minR, maxR);
  return {
    x: center.x + Math.cos(angle) * r,
    z: center.z + Math.sin(angle) * r,
  };
}

function clearGroup(group) {
  while (group.children.length) group.remove(group.children[0]);
}

const PLAYER_START_ALT = 2000; // matches Flight's spawn altitude in flight.js

// Clouds are seeded/recycled relative to a reference altitude (the player's
// current altitude at recycle time) so they stay near flight level instead
// of sitting at a fixed world-Y band that can end up far below the player —
// which, viewed near the horizon, was pooling into a single bright blob.
function cloudAltitudeNear(refAlt) {
  const y = refAlt + randRange(CLOUD_REL_ALT_MIN, CLOUD_REL_ALT_MAX);
  return THREE.MathUtils.clamp(y, CLOUD_ABS_ALT_MIN, CLOUD_ABS_ALT_MAX);
}

// --- Per-country decoration palettes -------------------------------------
// Each palette owns a small set of SHARED geometries/materials (built once
// per country) and a make() factory that wires up fresh Mesh/Group instances
// referencing them — cheap to stamp out across the whole decoration pool.

function buildEmptyPalette() {
  return { geometries: [], materials: [], make: () => new THREE.Group() };
}

function buildKazakhstanPalette() {
  const bodyGeo = new THREE.CylinderGeometry(13, 15, 9, 10);
  const bodyMat = new THREE.MeshToonMaterial({ color: 0xf1ead2, gradientMap: TOON_GRADIENT, fog: true });
  const roofGeo = new THREE.ConeGeometry(15, 7, 10);
  const roofMat = new THREE.MeshToonMaterial({ color: 0xb98f55, gradientMap: TOON_GRADIENT, fog: true });

  return {
    geometries: [bodyGeo, roofGeo],
    materials: [bodyMat, roofMat],
    make() {
      const group = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, bodyMat);
      body.position.y = 4.5;
      const roof = new THREE.Mesh(roofGeo, roofMat);
      roof.position.y = 12.5;
      group.add(body, roof);
      group.rotation.y = Math.random() * Math.PI * 2;
      group.scale.setScalar(randRange(0.8, 1.3));
      return group;
    },
  };
}

const PALETTES = {
  kazakhstan: buildKazakhstanPalette,
};

// --- Stage 7A finale set dressing (Bosphorus/bridge/minarets/runway) ------
// Placeholder primitive geometry only (CLAUDE.md: art passes stay
// flat-color/procedural) — built once, at the exact distances landing.js's
// scripted flight path will actually pass through (see World.
// buildFinaleSetDressing, called from main.js with landing.begin()'s return
// value).

// Aligns an object's local +Z axis with `forward` (both horizontal, so this
// is a pure yaw — no roll ambiguity) — local +X then lands on `right`
// automatically. Used instead of PlaneGeometry's rotateX(-90) convention,
// which is unambiguous only for axis-aligned/square geometry like the main
// ground plane.
function orientToPath(object, forward) {
  object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), forward);
}

function makeOrientedBox(width, height, depth, color) {
  const geo = new THREE.BoxGeometry(width, height, depth);
  const mat = new THREE.MeshToonMaterial({ color, gradientMap: TOON_GRADIENT, fog: true });
  return new THREE.Mesh(geo, mat);
}

function buildMinaret() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshToonMaterial({ color: 0xf1ead2, gradientMap: TOON_GRADIENT, fog: true });
  const capMat = new THREE.MeshToonMaterial({ color: 0x8fae9a, gradientMap: TOON_GRADIENT, fog: true });
  const height = randRange(150, 210);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(13, 15, height, 10), bodyMat);
  body.position.y = height / 2;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(18, 34, 10), capMat);
  cap.position.y = height + 17;
  group.add(body, cap);
  return group;
}

function buildAlmatyLake() {
  const geo = new THREE.CircleGeometry(420, 28);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0x2fb8b0, fog: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(600, 0.6, -300); // fixed, near spawn — never recycled
  return mesh;
}

export class World {
  constructor(scene) {
    this.scene = scene;

    this._skyTexture = makeSkyTexture(SKY_TOP, SKY_HORIZON);
    scene.background = this._skyTexture;
    scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);

    // Single directional sun (no shadow map — stays cheap) + a soft
    // sky/ground hemisphere fill so shaded toon faces never go pure black.
    this.sun = new THREE.DirectionalLight(0xfff4e0, 1.4);
    this.sun.position.set(-400, 900, 500);
    this.sun.target.position.set(0, 0, 0);
    scene.add(this.sun, this.sun.target);

    this.fill = new THREE.HemisphereLight(0xbcd9ee, 0x55503f, 0.65);
    scene.add(this.fill);

    const groundGeo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE);
    groundGeo.rotateX(-Math.PI / 2);
    const groundMat = new THREE.MeshToonMaterial({
      map: makeCheckerTexture(),
      gradientMap: TOON_GRADIENT,
      fog: true,
    });
    this.ground = new THREE.Mesh(groundGeo, groundMat);
    this.ground.position.y = 0;
    scene.add(this.ground);

    // Cloud sprite textures shared by kind, but each sprite gets its OWN
    // material instance (cheap — just a JS object, not a new draw call) so
    // it can carry its own sun-side tint. fog:false and explicit
    // NormalBlending are both deliberate: fog was bleeding each country's
    // warm fog color across the whole cloud layer, and stacked alpha from
    // overlapping sprites was reading as an additive glow.
    const cloudTextures = { puffy: makeCloudTexture('puffy'), soft: makeCloudTexture('soft'), streak: makeCloudTexture('streak') };
    const cloudKinds = Object.keys(cloudTextures);
    this.clouds = [];
    this._cloudDrift = [];
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const kind = cloudKinds[Math.floor(Math.random() * cloudKinds.length)];
      const material = new THREE.SpriteMaterial({
        map: cloudTextures[kind],
        color: 0xffffff,
        transparent: true,
        depthWrite: false,
        fog: false,
        blending: THREE.NormalBlending,
      });
      const sprite = new THREE.Sprite(material);
      const scale = randRange(300, 900);
      sprite.scale.set(scale * randRange(1.4, 2.2), scale, 1);
      const pos = scatterAround(new THREE.Vector3(), CLOUD_MIN_R, CLOUD_MAX_R);
      // PLAYER_START_ALT matches Flight's spawn altitude (see flight.js) —
      // clouds are seeded relative to it, same as they're recycled relative
      // to the player's live altitude afterward.
      sprite.position.set(pos.x, cloudAltitudeNear(PLAYER_START_ALT), pos.z);
      this._tintCloud(sprite);
      scene.add(sprite);
      this.clouds.push(sprite);
      this._cloudDrift.push({ x: CLOUD_WIND.x + randRange(-2, 2), z: CLOUD_WIND.z + randRange(-2, 2) });
    }

    this.decorations = [];
    for (let i = 0; i < DECOR_COUNT; i++) {
      const group = new THREE.Group();
      const pos = scatterAround(new THREE.Vector3(), DECOR_MIN_R, DECOR_MAX_R);
      group.position.set(pos.x, 0, pos.z);
      scene.add(group);
      this.decorations.push(group);
    }
    this._decorPalette = null;
    this.almatyLake = null;

    // Stage 7A finale: see beginFinaleClear/buildFinaleSetDressing below.
    this._finaleClearActive = false;
    this._finaleClearTimer = 0;
    this._finaleClearDuration = 1;
    this._finaleFogStart = FOG_DENSITY;
    this._finaleFogTarget = FOG_DENSITY;
    this._finaleSunStart = this.sun.intensity;
    this._finaleSunTarget = this.sun.intensity;
    this._finaleObjects = [];
  }

  // route.js calls this at every country transition: fog/ground tint (always),
  // sky gradient + decoration set (only once that country's art pass exists —
  // wave.skyTop/skyHorizon/decor are left undefined for countries not done yet).
  setCountry(wave) {
    this.scene.fog.color.setHex(wave.fogColor);
    this.ground.material.color.setHex(wave.groundTint);

    if (wave.skyTop && wave.skyHorizon) {
      this._skyTexture.dispose();
      this._skyTexture = makeSkyTexture(wave.skyTop, wave.skyHorizon);
      this.scene.background = this._skyTexture;
    }

    this._setDecor(wave.decor);
  }

  _setDecor(kind) {
    if (this._decorPalette) {
      for (const g of this._decorPalette.geometries) g.dispose();
      for (const m of this._decorPalette.materials) m.dispose();
    }
    const build = PALETTES[kind] || buildEmptyPalette;
    this._decorPalette = build();
    for (const group of this.decorations) {
      clearGroup(group);
      group.add(this._decorPalette.make());
    }

    if (kind === 'kazakhstan' && !this.almatyLake) {
      this.almatyLake = buildAlmatyLake();
      this.scene.add(this.almatyLake);
    }
  }

  // Calm payoff's "world haze lifts, sun breaks through" — eases fog density
  // down and sun intensity up over `duration` seconds. Called once, from
  // main.js, the instant route.phase becomes 'calm-payoff'.
  beginFinaleClear(duration) {
    this._finaleClearActive = true;
    this._finaleClearTimer = 0;
    this._finaleClearDuration = duration;
    this._finaleFogStart = this.scene.fog.density;
    this._finaleFogTarget = FOG_DENSITY * 0.15;
    this._finaleSunStart = this.sun.intensity;
    this._finaleSunTarget = this.sun.intensity * 1.5;
  }

  // Placeholder Bosphorus crossing for the Stage 7A landing lowpass: a water
  // strip + a simple suspension-bridge silhouette at `bridgeDist`, a minaret
  // cluster near the touchdown point, and a runway strip spanning
  // touchdownDist..totalDist. `origin`/`forward`/`right` and the distances
  // all come straight from landing.js's begin() so the geometry lines up
  // with the actual scripted flight path exactly.
  buildFinaleSetDressing(origin, forward, right, { bridgeDist, touchdownDist, totalDist }) {
    const at = (dist, lateral = 0, y = 0) =>
      origin.clone().addScaledVector(forward, dist).addScaledVector(right, lateral).setY(y);

    const water = makeOrientedBox(6000, 3, 500, 0x1f5f8b);
    orientToPath(water, forward);
    water.position.copy(at(bridgeDist, 0, 1));
    this.scene.add(water);

    const towerMat = 0x8b8f96;
    const towerL = new THREE.Mesh(new THREE.CylinderGeometry(40, 46, 220, 8), new THREE.MeshToonMaterial({ color: towerMat, gradientMap: TOON_GRADIENT, fog: true }));
    towerL.position.copy(at(bridgeDist, -950, 110));
    const towerR = towerL.clone();
    towerR.position.copy(at(bridgeDist, 950, 110));
    this.scene.add(towerL, towerR);

    const deck = makeOrientedBox(2100, 16, 55, 0x3d4147);
    orientToPath(deck, forward);
    deck.position.copy(at(bridgeDist, 0, 195));
    this.scene.add(deck);

    const minaretCount = 5;
    for (let i = 0; i < minaretCount; i++) {
      const minaret = buildMinaret();
      const lateralSide = i % 2 === 0 ? 1 : -1;
      const lateral = lateralSide * randRange(650, 1350);
      const dist = touchdownDist + randRange(-900, 300);
      minaret.position.copy(at(dist, lateral, 0));
      minaret.rotation.y = Math.random() * Math.PI * 2;
      this.scene.add(minaret);
      this._finaleObjects.push(minaret);
    }

    const runwayStart = touchdownDist - 300;
    const runwayEnd = totalDist + 500;
    const runway = makeOrientedBox(60, 1.5, runwayEnd - runwayStart, 0x2b2d30);
    orientToPath(runway, forward);
    runway.position.copy(at((runwayStart + runwayEnd) / 2, 0, 1));
    this.scene.add(runway);

    this._finaleObjects.push(water, towerL, towerR, deck, runway);
  }

  // main.js's Stage 7A "return to MENU" — undoes beginFinaleClear()'s haze
  // lift and removes the Bosphorus/bridge/minaret/runway set dressing so a
  // fresh playthrough's Kazakhstan doesn't fly past a leftover runway.
  resetForReplay() {
    this._finaleClearActive = false;
    this.scene.fog.density = FOG_DENSITY;
    this.sun.intensity = 1.4; // DirectionalLight's own constructor default
    for (const obj of this._finaleObjects) this.scene.remove(obj);
    this._finaleObjects.length = 0;
  }

  update(playerPosition, dt) {
    if (this._finaleClearActive) {
      this._finaleClearTimer += dt;
      const t = Math.min(1, this._finaleClearTimer / this._finaleClearDuration);
      const eased = t * t * (3 - 2 * t);
      this.scene.fog.density = THREE.MathUtils.lerp(this._finaleFogStart, this._finaleFogTarget, eased);
      this.sun.intensity = THREE.MathUtils.lerp(this._finaleSunStart, this._finaleSunTarget, eased);
      if (t >= 1) this._finaleClearActive = false;
    }

    // Recenter the ground under the player so the checker texture reads as an
    // effectively infinite surface without needing enormous geometry.
    this.ground.position.x = playerPosition.x;
    this.ground.position.z = playerPosition.z;

    for (let i = 0; i < this.clouds.length; i++) {
      const cloud = this.clouds[i];
      const drift = this._cloudDrift[i];
      cloud.position.x += drift.x * dt;
      cloud.position.z += drift.z * dt;
      this._tintCloud(cloud);

      // Fade out with horizontal distance from the player, all the way to 0
      // right at the recycle radius — no distance cue was left after fog was
      // turned off for clouds, so distant/boundary sprites rendered at full
      // strength and piled up into a bright blob near the horizon.
      const dx = cloud.position.x - playerPosition.x;
      const dz = cloud.position.z - playerPosition.z;
      const dist = Math.hypot(dx, dz);
      const fadeT = THREE.MathUtils.clamp(
        (dist - CLOUD_FADE_START_R) / (CLOUD_FADE_END_R - CLOUD_FADE_START_R),
        0,
        1
      );
      cloud.material.opacity = 1 - fadeT;
    }

    this._recycle(this.clouds, playerPosition, CLOUD_MIN_R, CLOUD_MAX_R, (obj, center) =>
      cloudAltitudeNear(center.y)
    );
    this._recycle(this.decorations, playerPosition, DECOR_MIN_R, DECOR_MAX_R, () => 0);
  }

  // Clouds stay white/light-grey; only the side of the sky roughly aligned
  // with the sun gets a barely-there warm shift. Recomputed cheaply each
  // frame from world position so it tracks as clouds drift/recycle.
  _tintCloud(sprite) {
    const x = sprite.position.x;
    const z = sprite.position.z;
    const len = Math.hypot(x, z);
    const alignment = len > 1 ? (x * SUN_DIR_FLAT.x + z * SUN_DIR_FLAT.y) / len : 0;
    const warmth = THREE.MathUtils.clamp(alignment, 0, 1) * CLOUD_SUN_WARMTH;
    sprite.material.color.setRGB(1, 1 - warmth * 0.4, 1 - warmth * 0.8);
  }

  _recycle(objects, center, minR, maxR, getY) {
    for (const obj of objects) {
      const dx = obj.position.x - center.x;
      const dz = obj.position.z - center.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > maxR * maxR) {
        const pos = scatterAround(center, minR, maxR);
        obj.position.x = pos.x;
        obj.position.z = pos.z;
        obj.position.y = getY(obj, center);
      }
    }
  }
}