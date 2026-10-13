// A WebGL layer behind the 2D scenes: a soft field of light drifting in depth. It only adds
// depth and glow; every shot's content stays in the 2D page above it. Everything is a pure
// function of time t, so any frame can be rendered on its own.
import * as THREE from 'three';

// Colours are the page's sRGB hex values, used as they are, so the backdrop matches the CSS.
THREE.ColorManagement.enabled = false;

const W = 1920;
const H = 1080;
const COUNT = 2600;

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  preserveDrawingBuffer: true,
  alpha: false,
});
renderer.setSize(W, H);
renderer.setPixelRatio(window.devicePixelRatio || 1); // 4/3 for the 2K final
renderer.domElement.style.position = 'absolute';
renderer.domElement.style.inset = '0';
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, W / H, 0.1, 200);
camera.position.set(0, 0, 10);

// Background: navy with a lighter centre, drawn as a full-screen quad.
const bg = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.ShaderMaterial({
    depthWrite: false,
    depthTest: false,
    uniforms: { uTint: { value: new THREE.Color(0x13203d) } },
    vertexShader:
      'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `varying vec2 vUv; uniform vec3 uTint;
      void main() {
        // the same glow as the page's radial-gradient(ellipse 70% 60% at 50% 45%, ... 70%)
        vec2 p = (vUv - vec2(0.5, 0.55)) * vec2(1920.0 / 1344.0, 1080.0 / 648.0);
        float d = clamp(length(p) / 0.7, 0.0, 1.0);
        vec3 col = mix(uTint, vec3(0.039, 0.059, 0.110), d);
        gl_FragColor = vec4(col, 1.0);
      }`,
  }),
);
bg.renderOrder = -1;
bg.frustumCulled = false;
scene.add(bg);

// The light field: soft points in a long box in front of the camera, recycled as they pass it.
const seed = (i) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const base = new Float32Array(COUNT * 3);
const sizes = new Float32Array(COUNT);
for (let i = 0; i < COUNT; i++) {
  base[i * 3] = (seed(i) - 0.5) * 60;
  base[i * 3 + 1] = (seed(i + 9999) - 0.5) * 34;
  base[i * 3 + 2] = -seed(i + 4242) * 90;
  sizes[i] = 0.4 + seed(i + 777) * 1.6;
}
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(base, 3));
geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
const field = new THREE.Points(
  geo,
  new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTravel: { value: 0 },
      uLeft: { value: new THREE.Color(0x4dabf7) },
      uRight: { value: new THREE.Color(0x4dabf7) },
      uGain: { value: 1 },
      uTime: { value: 0 },
    },
    vertexShader: `attribute float size; uniform float uTravel; uniform float uTime;
      varying float vFade; varying float vX;
      void main() {
        vec3 p = position;
        p.z = mod(p.z + uTravel, 90.0) - 80.0;           // flow towards the camera, then wrap
        p.x += sin(uTime * 0.15 + position.y * 0.3) * 0.6;
        p.y += cos(uTime * 0.12 + position.x * 0.2) * 0.4;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = size * 300.0 / -mv.z;
        float depth = clamp((p.z + 80.0) / 90.0, 0.0, 1.0);
        vFade = smoothstep(0.0, 0.25, depth) * (1.0 - smoothstep(0.85, 1.0, depth));
        vX = clamp(gl_Position.x / gl_Position.w * 0.5 + 0.5, 0.0, 1.0);
      }`,
    fragmentShader: `uniform vec3 uLeft; uniform vec3 uRight; uniform float uGain;
      varying float vFade; varying float vX;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        float a = exp(-r * r * 18.0) * vFade * 0.55 * uGain;
        gl_FragColor = vec4(mix(uLeft, uRight, vX) * a, a);
      }`,
  }),
);
scene.add(field);

// Per-act mood: how fast the field travels, its colours left and right, and its brightness.
const BLUE = new THREE.Color(0x4dabf7);
const MOODS = [
  {
    at: 0,
    speed: 0.6,
    left: new THREE.Color(0x7a8299),
    right: new THREE.Color(0x7a8299),
    gain: 0.5,
  }, // the lag
  { at: 12.2, speed: 2.2, left: new THREE.Color(0x7048e8), right: BLUE, gain: 1.0 }, // the race and the number
  { at: 32, speed: 1.4, left: BLUE, right: BLUE, gain: 0.8 }, // using it
  { at: 50, speed: 0.8, left: BLUE, right: BLUE, gain: 0.6 }, // the turn to trust
  { at: 54, speed: 0.9, left: new THREE.Color(0xff6b6b), right: BLUE, gain: 0.9 }, // untrusted to trusted
  { at: 80, speed: 1.4, left: BLUE, right: BLUE, gain: 0.8 },
  { at: 89.2, speed: 2.6, left: BLUE, right: new THREE.Color(0x8db8ff), gain: 1.1 }, // end card
];
// Travel is the integral of speed, so the field never jumps when the speed changes.
function travel(t) {
  let z = 0;
  for (let i = 0; i < MOODS.length; i++) {
    const a = MOODS[i].at;
    const b = i + 1 < MOODS.length ? MOODS[i + 1].at : Infinity;
    if (t <= a) break;
    z += (Math.min(t, b) - a) * MOODS[i].speed;
  }
  return z;
}
const mix = (c1, c2, k) => c1.clone().lerp(c2, k);

export function render(t) {
  let i = 0;
  while (i + 1 < MOODS.length && t >= MOODS[i + 1].at) i++;
  const cur = MOODS[i];
  const prev = MOODS[Math.max(0, i - 1)];
  const k = Math.min(1, (t - cur.at) / 1.2); // ease colours over 1.2 s after each change
  const u = field.material.uniforms;
  u.uTravel.value = travel(t);
  u.uTime.value = t;
  u.uLeft.value.copy(mix(prev.left, cur.left, k));
  u.uRight.value.copy(mix(prev.right, cur.right, k));
  u.uGain.value = prev.gain + (cur.gain - prev.gain) * k;
  camera.position.x = Math.sin(t * 0.07) * 0.8;
  camera.position.y = Math.cos(t * 0.05) * 0.4;
  camera.lookAt(0, 0, -30);
  renderer.render(scene, camera);
}
