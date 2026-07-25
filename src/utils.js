import * as THREE from 'three';

// Critically damped scalar smoothing (a.k.a. Unity's Mathf.SmoothDamp).
// velocityRef is a mutable {value:number} object used as an out-parameter.
export function smoothDamp(current, target, velocityRef, smoothTime, dt, maxSpeed = Infinity) {
  smoothTime = Math.max(0.0001, smoothTime);
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

  const maxChange = maxSpeed * smoothTime;
  let change = current - target;
  change = Math.min(Math.max(change, -maxChange), maxChange);
  const adjustedTarget = current - change;

  const temp = (velocityRef.value + omega * change) * dt;
  velocityRef.value = (velocityRef.value - omega * temp) * exp;
  let output = adjustedTarget + (change + temp) * exp;

  // Prevent overshoot past the original target.
  const origDelta = target - current;
  const outDelta = output - target;
  if (origDelta * outDelta > 0) {
    output = target;
    velocityRef.value = (output - target) / dt;
  }
  return output;
}

export function randRange(min, max) {
  return min + Math.random() * (max - min);
}

// Shared cel-shading lookup: a few discrete grey bands that MeshToonMaterial
// multiplies over its base color, giving the flat/toon look used across the
// whole outside world (ground, per-country decor, missiles, fighters).
function makeToonGradient(shades = [70, 140, 200, 255]) {
  const canvas = document.createElement('canvas');
  canvas.width = shades.length;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  shades.forEach((v, i) => {
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(i, 0, 1, 1);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

export const TOON_GRADIENT = makeToonGradient();