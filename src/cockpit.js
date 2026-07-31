import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CONFIG as FEAR_CONFIG } from './fear.js';
import { smoothDamp, randRange, TOON_GRADIENT } from './utils.js';

const MODEL_URL = `${import.meta.env.BASE_URL}models/cockpit.glb`;

// Final fit for cockpit.glb, found by live-tuning against the (now removed)
// debug overlay and tuning keys. Fixed — do not recompute from the bbox.
export const COCKPIT_FIT = {
  scale: 4.2437,
  offsetX: 0,
  offsetY: -5.26,
  offsetZ: -0.533,
  rotY: Math.PI, // 180° — this model faces the opposite direction by default
};

// GLTFLoader strips '.' from node names (PropertyBinding.sanitizeNodeName
// treats it as reserved — it's the nodeName.property separator in animation
// track paths), so the glTF's "ConolYoke.001" etc. become "ConolYoke001" at
// runtime. Match the sanitized form, not the raw glTF name.
const YOKE_A_NAMES = ['ConolYoke001', 'ConolYoke002', 'ConolYoke003'];
const YOKE_B_NAMES = ['ConolYoke005', 'ConolYoke006', 'ConolYoke007'];
const YOKE_TREMBLE_MAX = THREE.MathUtils.degToRad(2); // hard cap per spec: ±2° at fear=100
const YOKE_TREMBLE_SMOOTH_TIME = 0.06; // spring-damped, not raw per-frame noise
const YOKE_RETARGET_MIN = 0.04;
const YOKE_RETARGET_MAX = 0.09;

const BOTTLE_COLOR = 0xfbe000; // vivid lemon yellow — the most saturated object in the cockpit
const BOTTLE_LIQUID_COLOR = 0xc98f0a;
const BOTTLE_CAP_COLOR = 0xf2f2ea;
const STRAP_COLOR = 0x1c1e21;
// Sized in COCKPIT_FIT's actual local-space units (the model's own bbox is
// ~73 units wide at this fit), not the old "meters, scale=1" assumption —
// that constant was calibrated against a since-abandoned auto-fit target
// and had gone stale. ~15% of the old visual footprint: soda-can-at-arm's-
// -length, not the barrel it used to read as.
const BOTTLE_HEIGHT = 1.0;
const BOTTLE_RADIUS = BOTTLE_HEIGHT * 0.36;
const BOTTLE_WOBBLE_MAX_TILT = THREE.MathUtils.degToRad(7);
const BOTTLE_WOBBLE_SMOOTH_TIME = 0.5;
// Fixed lean so it reads as casually set down, not machine-placed. Yaw is
// static (set once); the per-frame flight wobble in update() adds onto the
// static lean on X/Z rather than overwriting it.
const BOTTLE_CASUAL_TILT_Y = THREE.MathUtils.degToRad(25);
const BOTTLE_CASUAL_TILT_Z = THREE.MathUtils.degToRad(-9);
// Nudge from the left yoke's world position to the shelf at the base of the
// left canopy strut: further left, up onto the shelf, slightly forward.
const BOTTLE_SHELF_OFFSET = new THREE.Vector3(-1.3, 0.65, -0.45);
// Fear IS the health system now, so its physical tell on the dashboard
// needs to actually read as danger, not just a wobble — rattles on top of
// the anchored position, same SHAKE(20) threshold/curve as the camera's own
// micro-shake in flight.js, so the whole cockpit reads as one shaking rig.
const BOTTLE_RATTLE_MAX = 0.18; // world units of position jitter at fear=100
const BOTTLE_RATTLE_SMOOTH_TIME = 0.05;
const BOTTLE_RATTLE_RETARGET_MIN = 0.03;
const BOTTLE_RATTLE_RETARGET_MAX = 0.07;

function flatMat(color) {
  return new THREE.MeshBasicMaterial({ color, fog: false });
}

// Real cockpit model (cockpit.glb) parented under our own camera, styled to
// match the game's toon/flat look, with the fear tremble hooked onto the
// yoke nodes. The bottle stays our own hand-built mesh, anchored to the
// loaded model's actual yoke positions once available.
export class Cockpit {
  constructor(camera) {
    this.camera = camera;
    this.cockpitRig = new THREE.Group();
    camera.add(this.cockpitRig);

    // MeshToonMaterial needs light to not render black; ambient covers faces
    // the directional sun doesn't reach. This affects the whole scene (a
    // light's effect isn't scoped by where it's parented) — a minor,
    // accepted side effect of fixing "the hull renders near-black."
    this.ambient = new THREE.AmbientLight(0xffffff, 0.4);
    camera.add(this.ambient);

    this.ready = false;
    this.model = null;
    // { node, baseQuat }[] per yoke group — tremble composes onto baseQuat
    // each frame rather than overwriting authored rotation.
    this.yokeANodes = null;
    this.yokeBNodes = null;

    this._yokeTrembleX = 0;
    this._yokeTrembleZ = 0;
    this._yokeTrembleTargetX = 0;
    this._yokeTrembleTargetZ = 0;
    this._yokeTrembleVelX = { value: 0 };
    this._yokeTrembleVelZ = { value: 0 };
    this._yokeRetargetTimer = 0;
    this._trembleQuat = new THREE.Quaternion();
    this._trembleEuler = new THREE.Euler();

    this._wobbleVelX = { value: 0 };
    this._wobbleVelZ = { value: 0 };
    this._wobbleX = 0;
    this._wobbleZ = 0;

    // Anchored shelf position, separate from this.bottle.position — the
    // rattle offset below is added on top each frame rather than mutating
    // the anchor itself, so _placeBottleOnConsole can keep re-deriving it
    // from the real yoke position without fighting the jitter.
    this._bottleBasePos = new THREE.Vector3();
    this._bottleRattleX = 0;
    this._bottleRattleZ = 0;
    this._bottleRattleTargetX = 0;
    this._bottleRattleTargetZ = 0;
    this._bottleRattleVelX = { value: 0 };
    this._bottleRattleVelZ = { value: 0 };
    this._bottleRattleRetargetTimer = 0;

    // Calm payoff's "bottle catches a highlight" — see triggerBottleHighlight().
    this._highlightTimer = 0;
    this._highlightDuration = 2.5;

    this._buildBottle();
    this._bindDebugKeys();
    this._loadModel();
  }

  _loadModel() {
    const loader = new GLTFLoader();
    loader.load(
      MODEL_URL,
      (gltf) => this._onModelLoaded(gltf),
      undefined,
      (err) => console.error('[cockpit] failed to load cockpit.glb:', err)
    );
  }

  _onModelLoaded(gltf) {
    const model = gltf.scene;
    model.updateMatrixWorld(true);

    this._styleMaterials(model);

    // Must be added to the live graph (cockpitRig -> camera -> scene) before
    // the yoke/bottle placement below, since both read real WORLD positions.
    this.cockpitRig.add(model);
    this.model = model;

    this._applyFit();
    this._rigYokes(model);
    this._placeBottleOnConsole();

    this.ready = true;

    let triCount = 0;
    let meshCount = 0;
    model.traverse((child) => {
      if (!child.isMesh) return;
      meshCount++;
      const geo = child.geometry;
      triCount += geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
    });
    console.log(`[cockpit] loaded cockpit.glb — ${Math.round(triCount)} tris across ${meshCount} meshes`);
  }

  // Toon-shaded to match the rest of the world's flat/cel style; base color
  // and texture map are preserved. MeshToonMaterial has no metalness/
  // roughness concept at all, so the swap itself kills the PBR metal
  // workflow; emissive is set to black explicitly. DoubleSide is forced
  // (not preserved from the source material) so backfaces render — with the
  // camera potentially inside the hull, "inward-facing" geometry is exactly
  // what you're looking at, and single-sided culling would hide it.
  _styleMaterials(model) {
    model.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      const next = materials.map((old) => {
        const mat = new THREE.MeshToonMaterial({
          color: old.color ? old.color.clone() : 0xffffff,
          map: old.map || null,
          gradientMap: TOON_GRADIENT,
          transparent: old.transparent,
          opacity: old.opacity,
          alphaTest: old.alphaTest || 0,
          side: THREE.DoubleSide,
          emissive: 0x000000,
          fog: false, // cockpit interior, not affected by outdoor haze
        });
        old.dispose();
        return mat;
      });
      child.material = Array.isArray(child.material) ? next : next[0];
    });
  }

  // Composes a small spring-damped tremble quaternion onto each yoke node's
  // OWN authored rotation every frame (see update()), rather than re-
  // parenting them under a wrapper group — simpler and can't disturb their
  // baked pose if the re-parent math were ever subtly wrong.
  _rigYokes(model) {
    const collect = (names) => {
      const found = [];
      for (const name of names) {
        const node = model.getObjectByName(name);
        if (node) found.push({ node, baseQuat: node.quaternion.clone() });
      }
      return found.length ? found : null;
    };

    this.yokeANodes = collect(YOKE_A_NAMES);
    this.yokeBNodes = collect(YOKE_B_NAMES);

    if (!this.yokeANodes && !this.yokeBNodes) {
      console.warn(
        '[cockpit] no yoke nodes found (expected ConolYoke001-003 / 005-007) — fear tremble has nothing to shake'
      );
    }
  }

  _buildBottle() {
    this.bottle = new THREE.Group();
    this.cockpitRig.add(this.bottle);
    // Default placement until the model loads and we can anchor it onto the
    // left shelf (see _placeBottleOnConsole) — a reasonable guess so there's
    // no visible pop once the real anchor lands.
    this._bottleBasePos.set(-1.3, -2.2, -7.0);
    this.bottle.position.copy(this._bottleBasePos);
    this.bottle.rotation.y = BOTTLE_CASUAL_TILT_Y;

    // Cheap fake translucency (two nested cylinders) instead of
    // MeshPhysicalMaterial transmission — real glass transmission needs its
    // own render-target pass per transmissive material per frame, which
    // isn't worth it for a single dashboard prop when this reads the same
    // from the cockpit's normal viewing distance. shininess+specular gives
    // the "one subtle highlight" the glass look needs.
    const shellMat = new THREE.MeshPhongMaterial({
      color: BOTTLE_COLOR,
      shininess: 150,
      specular: 0xffffff,
      transparent: true,
      opacity: 0.5,
      fog: false,
    });
    this.bottleBody = new THREE.Mesh(new THREE.CylinderGeometry(BOTTLE_RADIUS, BOTTLE_RADIUS * 1.05, BOTTLE_HEIGHT, 14), shellMat);
    this.bottle.add(this.bottleBody);

    // Opaque liquid rendered first (three.js draws opaque before transparent
    // regardless of add order), so the translucent shell correctly blends
    // over it with no manual depth/renderOrder trickery needed.
    const liquidMat = new THREE.MeshPhongMaterial({ color: BOTTLE_LIQUID_COLOR, shininess: 35, fog: false });
    const liquidH = BOTTLE_HEIGHT * 0.7;
    this.bottleLiquid = new THREE.Mesh(new THREE.CylinderGeometry(BOTTLE_RADIUS * 0.8, BOTTLE_RADIUS * 0.84, liquidH, 14), liquidMat);
    this.bottleLiquid.position.y = -BOTTLE_HEIGHT / 2 + liquidH / 2 + BOTTLE_HEIGHT * 0.03;
    this.bottle.add(this.bottleLiquid);

    const capMat = new THREE.MeshPhongMaterial({ color: BOTTLE_CAP_COLOR, shininess: 40, fog: false });
    this.bottleCap = new THREE.Mesh(
      new THREE.CylinderGeometry(BOTTLE_RADIUS * 0.5, BOTTLE_RADIUS * 0.62, BOTTLE_HEIGHT * 0.24, 14),
      capMat
    );
    this.bottleCap.position.y = BOTTLE_HEIGHT * 0.5 + BOTTLE_HEIGHT * 0.12;
    this.bottle.add(this.bottleCap);

    const strapMat = flatMat(STRAP_COLOR);
    this.bottleStrap = new THREE.Mesh(
      new THREE.CylinderGeometry(BOTTLE_RADIUS * 1.15, BOTTLE_RADIUS * 1.15, BOTTLE_HEIGHT * 0.1, 14),
      strapMat
    );
    this.bottleStrap.position.y = -BOTTLE_HEIGHT * 0.12;
    this.bottle.add(this.bottleStrap);

    // Debug: bright magenta wireframe box around the bottle's bounds,
    // toggled with 'B'. depthTest:false so it draws on top of anything that
    // might be occluding the real bottle.
    const debugMat = new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true, fog: false, depthTest: false });
    this.bottleDebugBox = new THREE.Mesh(
      new THREE.BoxGeometry(BOTTLE_RADIUS * 2.6, BOTTLE_HEIGHT * 1.6, BOTTLE_RADIUS * 2.6),
      debugMat
    );
    this.bottleDebugBox.visible = false;
    this.bottleDebugBox.renderOrder = 999;
    this.bottle.add(this.bottleDebugBox);
  }

  // Anchors the bottle onto the shelf by whichever yoke sits further left
  // (more negative local X) — data-driven off the actual loaded model
  // instead of a guessed screen-space fraction. Anchoring to the AVERAGE of
  // both yokes put the bottle dead center, right behind the crosshair; the
  // left yoke + a fixed shelf offset keeps it off to the side instead.
  _placeBottleOnConsole() {
    const groups = [this.yokeANodes, this.yokeBNodes].filter(Boolean);
    if (!groups.length) return;

    const tmp = new THREE.Vector3();
    const avgLocalPos = (group) => {
      const sum = new THREE.Vector3();
      for (const { node } of group) {
        node.getWorldPosition(tmp);
        sum.add(tmp);
      }
      sum.divideScalar(group.length);
      return this.cockpitRig.worldToLocal(sum); // world -> cockpitRig-local, valid regardless of the camera's current position in the game world
    };

    let leftAnchor = avgLocalPos(groups[0]);
    for (let i = 1; i < groups.length; i++) {
      const candidate = avgLocalPos(groups[i]).clone();
      if (candidate.x < leftAnchor.x) leftAnchor = candidate;
    }

    this._bottleBasePos.set(
      leftAnchor.x + BOTTLE_SHELF_OFFSET.x,
      leftAnchor.y + BOTTLE_SHELF_OFFSET.y,
      leftAnchor.z + BOTTLE_SHELF_OFFSET.z
    );
  }

  _applyFit() {
    if (!this.model) return;
    this.model.scale.setScalar(COCKPIT_FIT.scale);
    this.model.position.set(COCKPIT_FIT.offsetX, COCKPIT_FIT.offsetY, COCKPIT_FIT.offsetZ);
    this.model.rotation.y = COCKPIT_FIT.rotY;
    this.model.updateMatrixWorld(true);
  }

  // Bottle bounding-box wireframe only; the fit/see-through/visibility debug
  // keys are gone now that COCKPIT_FIT is hardcoded.
  _bindDebugKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyB') this.bottleDebugBox.visible = !this.bottleDebugBox.visible;
    });
  }

  // Calm payoff, one-shot: a warm glow rises and fades on the bottle over
  // _highlightDuration — see update()'s emissive pulse.
  triggerBottleHighlight() {
    this._highlightTimer = this._highlightDuration;
  }

  resize() {
    // The GLB cockpit is a real 3D object at a fixed world-scale transform,
    // not a screen-fraction graphic overlay like the old primitive build —
    // it doesn't need FOV/aspect-driven relayout.
  }

  update(playerStick, fear, dt) {
    if (this.ready) {
      const trembleAmt = YOKE_TREMBLE_MAX * fear.intensity(FEAR_CONFIG.THRESHOLDS.SHAKE);
      this._yokeRetargetTimer -= dt;
      if (this._yokeRetargetTimer <= 0) {
        this._yokeTrembleTargetX = (Math.random() - 0.5) * 2 * trembleAmt;
        this._yokeTrembleTargetZ = (Math.random() - 0.5) * 2 * trembleAmt;
        this._yokeRetargetTimer = randRange(YOKE_RETARGET_MIN, YOKE_RETARGET_MAX);
      }
      this._yokeTrembleX = smoothDamp(
        this._yokeTrembleX,
        this._yokeTrembleTargetX,
        this._yokeTrembleVelX,
        YOKE_TREMBLE_SMOOTH_TIME,
        dt
      );
      this._yokeTrembleZ = smoothDamp(
        this._yokeTrembleZ,
        this._yokeTrembleTargetZ,
        this._yokeTrembleVelZ,
        YOKE_TREMBLE_SMOOTH_TIME,
        dt
      );

      this._trembleEuler.set(this._yokeTrembleX, 0, this._yokeTrembleZ);
      this._trembleQuat.setFromEuler(this._trembleEuler);

      for (const group of [this.yokeANodes, this.yokeBNodes]) {
        if (!group) continue;
        for (const { node, baseQuat } of group) {
          node.quaternion.copy(baseQuat).multiply(this._trembleQuat);
        }
      }
    }

    // Bottle wobble runs regardless of model-load state (it's our own mesh,
    // visible from frame one). Sign convention matches flight.js/the old
    // cockpit: stick.x>0 = left bank, stick.y>0 = dive.
    const wobbleTargetX = -THREE.MathUtils.clamp(playerStick.y, -1, 1) * BOTTLE_WOBBLE_MAX_TILT;
    const wobbleTargetZ = THREE.MathUtils.clamp(playerStick.x, -1, 1) * BOTTLE_WOBBLE_MAX_TILT;
    this._wobbleX = smoothDamp(this._wobbleX, wobbleTargetX, this._wobbleVelX, BOTTLE_WOBBLE_SMOOTH_TIME, dt);
    this._wobbleZ = smoothDamp(this._wobbleZ, wobbleTargetZ, this._wobbleVelZ, BOTTLE_WOBBLE_SMOOTH_TIME, dt);
    // Wobble composes onto the static casual lean (Z), not the yaw (Y, set
    // once in _buildBottle and left alone).
    this.bottle.rotation.x = this._wobbleX;
    this.bottle.rotation.z = BOTTLE_CASUAL_TILT_Z + this._wobbleZ;

    // Rattles harder as fear rises: same random-retarget-then-smoothDamp
    // shake as the yoke tremble above, applied as a position jitter added on
    // top of the anchored shelf position rather than replacing it.
    const rattleAmt = BOTTLE_RATTLE_MAX * fear.intensity(FEAR_CONFIG.THRESHOLDS.SHAKE);
    this._bottleRattleRetargetTimer -= dt;
    if (this._bottleRattleRetargetTimer <= 0) {
      this._bottleRattleTargetX = (Math.random() - 0.5) * 2 * rattleAmt;
      this._bottleRattleTargetZ = (Math.random() - 0.5) * 2 * rattleAmt;
      this._bottleRattleRetargetTimer = randRange(BOTTLE_RATTLE_RETARGET_MIN, BOTTLE_RATTLE_RETARGET_MAX);
    }
    this._bottleRattleX = smoothDamp(
      this._bottleRattleX,
      this._bottleRattleTargetX,
      this._bottleRattleVelX,
      BOTTLE_RATTLE_SMOOTH_TIME,
      dt
    );
    this._bottleRattleZ = smoothDamp(
      this._bottleRattleZ,
      this._bottleRattleTargetZ,
      this._bottleRattleVelZ,
      BOTTLE_RATTLE_SMOOTH_TIME,
      dt
    );
    this.bottle.position.set(
      this._bottleBasePos.x + this._bottleRattleX,
      this._bottleBasePos.y,
      this._bottleBasePos.z + this._bottleRattleZ
    );

    if (this._highlightTimer > 0) this._highlightTimer = Math.max(0, this._highlightTimer - dt);
    const glow = this._highlightTimer > 0 ? Math.sin(Math.PI * (1 - this._highlightTimer / this._highlightDuration)) : 0;
    this.bottleBody.material.emissive.setRGB(glow, glow * 0.85, glow * 0.2);
    this.bottleLiquid.material.emissive.setRGB(glow * 0.6, glow * 0.45, glow * 0.05);
  }
}