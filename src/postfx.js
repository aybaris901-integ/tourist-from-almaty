import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { CONFIG as FEAR_CONFIG } from './fear.js';

// Single cheap shader pass driving vignette (60+), chromatic aberration (60+)
// and a slow sine screen warp (80+), all gated off one uFear (0..1) uniform.
const FearShader = {
  uniforms: {
    tDiffuse: { value: null },
    uFear: { value: 0 },
    uTime: { value: 0 },
    uVignetteMax: { value: FEAR_CONFIG.VIGNETTE_MAX },
    uAberrationMax: { value: FEAR_CONFIG.ABERRATION_MAX },
    uWarpMax: { value: FEAR_CONFIG.WARP_MAX },
    uWarpSpeed: { value: FEAR_CONFIG.WARP_SPEED },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uFear;
    uniform float uTime;
    uniform float uVignetteMax;
    uniform float uAberrationMax;
    uniform float uWarpMax;
    uniform float uWarpSpeed;
    varying vec2 vUv;

    void main() {
      float vignetteAmt = smoothstep(0.6, 1.0, uFear);
      float aberrationAmt = smoothstep(0.6, 1.0, uFear);
      float warpAmt = smoothstep(0.8, 1.0, uFear);

      vec2 uv = vUv;
      vec2 centered = uv - 0.5;

      float warpPhase = uTime * uWarpSpeed;
      vec2 warpOffset = vec2(
        sin(centered.y * 6.0 + warpPhase),
        cos(centered.x * 6.0 + warpPhase * 0.8)
      ) * uWarpMax * warpAmt;
      uv += warpOffset;

      float dist = length(centered);
      vec2 dir = dist > 0.0001 ? centered / dist : vec2(0.0);
      float aberrationPx = uAberrationMax * aberrationAmt;
      float r = texture2D(tDiffuse, uv + dir * aberrationPx).r;
      float g = texture2D(tDiffuse, uv).g;
      float b = texture2D(tDiffuse, uv - dir * aberrationPx).b;
      vec3 color = vec3(r, g, b);

      float vignette = 1.0 - smoothstep(0.35, 0.75, dist) * uVignetteMax * vignetteAmt;
      color *= vignette;

      gl_FragColor = vec4(color, 1.0);
    }
  `,
};

export class PostFX {
  constructor(renderer, scene, camera) {
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));

    this.fearPass = new ShaderPass(FearShader);
    this.fearPass.renderToScreen = true;
    this.composer.addPass(this.fearPass);
  }

  resize(width, height) {
    this.composer.setSize(width, height);
  }

  render(dt, fearNormalized) {
    this.fearPass.uniforms.uFear.value = fearNormalized;
    this.fearPass.uniforms.uTime.value += dt;
    this.composer.render(dt);
  }
}