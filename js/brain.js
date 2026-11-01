// Wireframe brain wearing headphones. Each track's vibe sets its colour,
// how fast it oscillates (tempo) and how hard (energy). Changes are damped.
import * as THREE from 'three';
import { reducedMotion } from './motion.js';

// --- tiny 3D value noise for the folds (gyri) ---
function hash(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash(xi + dx, yi + dy, zi + dz);
  return l(l(l(c(0,0,0), c(1,0,0), u), l(c(0,1,0), c(1,1,0), u), v),
           l(l(c(0,0,1), c(1,0,1), u), l(c(0,1,1), c(1,1,1), u), v), w);
}
const ridged = (x, y, z) => {
  let s = 0, a = 0.5, f = 1;
  for (let o = 0; o < 3; o++) { s += a * (1 - Math.abs(noise(x * f, y * f, z * f) * 2 - 1)); a *= 0.5; f *= 2.1; }
  return s;
};

export function hemisphere(side) {
  const g = new THREE.SphereGeometry(1, 52, 38);
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    // Brain proportions: long front-to-back, flatter underneath, flat inner face.
    let x = v.x * 0.62, y = v.y * 0.74, z = v.z * 1.0;
    if (y < -0.25) y = -0.25 + (y + 0.25) * 0.55;
    if (z > 0.3 && y < 0) y *= 0.85; // frontal lobe tucks in
    const fold = ridged(v.x * 2.4 + side * 7, v.y * 2.4, v.z * 2.4);
    const r = 1 + (fold - 0.45) * 0.16;
    x *= r; y *= r; z *= r;
    if (x * side < 0.02) x = side * 0.02 + x * 0.12; // medial wall
    p.setXYZ(i, x + side * 0.34, y + 0.05, z);
  }
  g.computeVertexNormals();
  return g;
}

export function cerebellum() {
  const g = new THREE.SphereGeometry(0.42, 36, 18);
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const stripe = 1 + Math.sin(v.y * 60) * 0.025;
    p.setXYZ(i, v.x * 1.55 * stripe, v.y * 0.62 * stripe - 0.48, v.z * 0.9 * stripe - 0.62);
  }
  g.computeVertexNormals();
  return g;
}

const VERT = /* glsl */`
  uniform float uTime, uFreq, uAmp, uPulse, uBreath, uRipple;
  varying float vH; varying float vRim; varying float vY;
  void main() {
    vec3 p = position;
    vY = position.y;
    // A wave that travels front to back, like a thought crossing the cortex.
    float wave = sin(uTime * uFreq + p.z * 4.0 + p.y * 2.0);
    // A ring of energy that spreads out from the centre on each beat.
    float ripple = sin(length(position) * 9.0 - uTime * 7.0) * uRipple;
    // The whole brain swells and relaxes (uBreath), and kicks outward on the beat.
    p += normal * (wave * uAmp + uPulse * 0.07 + uBreath + ripple);
    vH = p.y;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vRim = 1.0 - abs(dot(normalize(normalMatrix * normal), vec3(0.0, 0.0, 1.0)));
    gl_Position = projectionMatrix * mv;
  }`;
const FRAG = /* glsl */`
  uniform vec3 uColorA, uColorB; uniform float uOpacity, uFlash, uReveal;
  varying float vH; varying float vRim; varying float vY;
  void main() {
    vec3 c = mix(uColorA, uColorB, smoothstep(-0.6, 0.8, vH));
    float a = uOpacity * (0.35 + vRim * 0.75 + uFlash * 0.5);
    if (uReveal < 1.0) {
      float edge = mix(-1.1, 1.1, uReveal);
      if (vY > edge) discard;
      float scan = 1.0 - smoothstep(0.0, 0.16, edge - vY); // bright line at the build front
      c = mix(c, vec3(1.0), scan * 0.85);
      a += scan * 0.9;
    }
    gl_FragColor = vec4(c + uFlash * 0.25, a);
  }`;

const WHITE = new THREE.Color(0xffffff);

export class Brain {
  constructor(canvas) {
    this.canvas = canvas;
    this.reduced = reducedMotion();
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); // sharp enough for wireframe, much lighter
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 50);
    this.camera.position.set(0, 0.25, 6.2);

    // Current and target vibe; the render loop eases one toward the other.
    this.cur = { freq: 1.2, amp: 0.012, a: new THREE.Color('#3b5bdb'), b: new THREE.Color('#20c997'), tempo: 80 };
    this.tgt = { freq: 1.2, amp: 0.012, a: this.cur.a.clone(), b: this.cur.b.clone(), tempo: 80 };
    this.playing = false;

    this.uniforms = {
      uTime: { value: 0 }, uFreq: { value: 1.2 }, uAmp: { value: 0.01 }, uPulse: { value: 0 },
      uBreath: { value: 0 }, uRipple: { value: 0 }, uFlash: { value: 0 }, uReveal: { value: 1 },
      uColorA: { value: this.cur.a }, uColorB: { value: this.cur.b }, uOpacity: { value: 0.48 },
    };
    const brainMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      wireframe: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });

    this.head = new THREE.Group();
    [-1, 1].forEach(s => this.head.add(new THREE.Mesh(hemisphere(s), brainMat)));
    this.head.add(new THREE.Mesh(cerebellum(), brainMat));
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.09, 0.6, 10, 4, true), brainMat);
    stem.position.set(0, -0.72, -0.28); stem.rotation.x = 0.35;
    this.head.add(stem);

    // Headphones: band over the top, a cup on each side.
    this.phoneMat = new THREE.MeshBasicMaterial({ color: 0xf1f3ff, wireframe: true, transparent: true, opacity: 0.55 });
    const phones = new THREE.Group();
    const band = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.06, 6, 48, Math.PI), this.phoneMat);
    band.position.y = 0.02;
    phones.add(band);
    this.band = band;
    // A little equalizer riding on the headband.
    this.eqMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
    const barGeo = new THREE.BoxGeometry(0.05, 0.3, 0.05).translate(0, 0.15, 0);
    this.bars = [...Array(11)].map((_, i) => {
      const a = Math.PI * (0.18 + 0.64 * i / 10);
      const bar = new THREE.Mesh(barGeo, this.eqMat);
      bar.position.set(Math.cos(a) * 1.28, Math.sin(a) * 1.28 + 0.02, 0);
      bar.rotation.z = a - Math.PI / 2;
      phones.add(bar);
      return bar;
    });
    const inner = new THREE.Mesh(new THREE.TorusGeometry(1.12, 0.025, 4, 48, Math.PI), this.phoneMat);
    inner.position.y = 0.02; phones.add(inner);
    this.cups = [-1, 1].map(s => {
      const cup = new THREE.Group();
      const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.3, 0.22, 28, 2), this.phoneMat);
      shell.rotation.z = Math.PI / 2;
      const pad = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.07, 6, 24), this.phoneMat);
      pad.rotation.y = Math.PI / 2; pad.position.x = -s * 0.13;
      const yoke = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.02, 4, 20, Math.PI), this.phoneMat);
      yoke.rotation.y = Math.PI / 2;
      // Speaker cone on the outside face: it pumps with the beat and spins slowly.
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.12, 16, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.7 }));
      cone.rotation.z = s * Math.PI / 2; cone.position.x = s * 0.14;
      cup.add(shell, pad, yoke, cone);
      cup.userData = { side: s, cone };
      cup.position.set(s * 1.2, -0.02, 0);
      phones.add(cup);
      return cup;
    });
    this.head.add(phones);
    this.phones = phones;

    // Sound rings that leave the cups on each beat.
    this.rings = [];
    const ringGeo = new THREE.RingGeometry(0.3, 0.315, 40);
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
      m.rotation.y = Math.PI / 2; m.visible = false;
      this.head.add(m); this.rings.push({ m, life: 0, side: i % 2 ? 1 : -1 });
    }

    this.head.rotation.set(0.08, -0.55, 0);
    this.scene.add(this.head);

    this.drag = null; this.spinOffset = 0;
    canvas.addEventListener('pointerdown', e => { this.drag = { x: e.clientX, o: this.spinOffset }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', e => { if (this.drag) this.spinOffset = this.drag.o + (e.clientX - this.drag.x) * 0.01; });
    canvas.addEventListener('pointerup', () => { this.drag = null; });

    this.clock = new THREE.Clock();
    this.beatClock = 0;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the whole head in frame on tall, narrow screens.
    // The canvas fills the screen behind floating panels. Centre the head in the open
    // area: left of the panel on wide screens, the top half on phones.
    const wide = window.innerWidth >= 900;
    // Far enough back that the head with headphones (about 3.4 units wide) fits the width.
    const fitZ = 1.8 / (Math.tan(THREE.MathUtils.degToRad(17)) * (w / h));
    this.baseZ = Math.max(wide ? 7.4 : 6.4, fitZ);
    this.camera.position.set(0, 0.25, this.baseZ);
    this.camera.lookAt(0, 0, 0);
    this.view = { w, h, x: wide ? Math.min(250, w * 0.2) : 0, y: wide ? 0 : h * 0.2 };
    // Intro framing: the head centred in the space above the "Cortex FM" title, small enough
    // to fit there (the title takes `introReserve` px at the bottom).
    const free = Math.max(h * 0.4, h - (this.introReserve || 0));
    const visH = 3.4 * h / (free * 0.86);                    // world units the screen must show
    this.introZ = Math.max(this.baseZ, visH / (2 * Math.tan(THREE.MathUtils.degToRad(17))));
    this.introY = (h - free) / 2 - free * 0.07; // a little low in that space, so head and title read as one
    this.applyView(this.intro ? this.intro.k : 1);
  }

  /** Shift the head toward its resting spot beside the panels (k = 0 centred, 1 resting). */
  applyView(k) {
    const v = this.view; if (!v) return;
    const iy = this.introY || 0;
    this.camera.setViewOffset(v.w, v.h, v.x * k, iy + (v.y - iy) * k, v.w, v.h);
    this.camera.updateProjectionMatrix();
  }

  /**
   * The opening: a line of light builds the brain from the bottom up, the headphones
   * fly in from both sides and snap on with a burst of sound rings, then the head
   * glides to its place. Resolves when it is done.
   */
  playIntro(duration = 4.2) {
    if (this.reduced) return Promise.resolve();
    this.intro = { t: 0, duration, snapped: false, k: 0, leave: -1 };
    this.uniforms.uReveal.value = 0;
    this.resize();
    return new Promise(res => { this.intro.done = res; });
  }

  /** End the intro: finish building at once (if skipped) and glide to the resting place. */
  skipIntro() { if (this.intro) { this.intro.t = Math.max(this.intro.t, this.intro.duration); if (this.intro.leave < 0) this.intro.leave = 0; } }

  /** Set the vibe of the track that is playing now. */
  setVibe({ energy, valence, tempo }, colorA, colorB) {
    this.tgt.freq = 0.6 + (tempo / 60) * 1.4;   // faster songs, faster waves
    this.tgt.amp = 0.016 + energy * 0.075;       // louder songs, bigger waves
    this.tgt.tempo = tempo;
    this.tgt.a.set(colorA); this.tgt.b.set(colorB);
    this.tgt.valence = valence;
  }

  setPlaying(on) { this.playing = on; }

  loop() {
    requestAnimationFrame(this.loop);
    if (document.hidden) { this.clock.getDelta(); return; } // no work while the tab is hidden
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    const k = 1 - Math.exp(-dt * 1.6); // damped: settles in about a second, no overshoot
    const motion = this.reduced ? 0.15 : 1;
    // Always alive: full movement while music plays, a slower breathing motion otherwise.
    const live = this.playing ? 1 : 0.55;
    const pace = this.playing ? 1 : 0.5;

    this.cur.freq += (this.tgt.freq * pace - this.cur.freq) * k;
    this.cur.amp += (this.tgt.amp * live * motion - this.cur.amp) * k;
    this.cur.tempo += (this.tgt.tempo - this.cur.tempo) * k;
    this.cur.a.lerp(this.tgt.a, k); this.cur.b.lerp(this.tgt.b, k);

    this.uniforms.uTime.value = t;
    this.uniforms.uFreq.value = this.cur.freq;
    this.uniforms.uAmp.value = this.cur.amp;

    // Beat clock: full beats while music plays, one slow breath every three beats otherwise.
    const beatLen = 60 / this.cur.tempo;
    const len = this.playing ? beatLen : beatLen * 3;
    this.beatClock += dt;
    let beat = false;
    if (this.beatClock >= len) { this.beatClock %= len; beat = true; }
    const motionOn = !this.reduced;
    const pulse = motionOn ? Math.pow(1 - this.beatClock / len, 3) * (this.playing ? 1 : 0.4) : 0;
    if (beat && motionOn) {
      const r = this.rings.find(r => r.life <= 0);
      if (r) { r.life = 1; r.side = -r.side; r.speed = this.playing ? 0.9 : 0.45; }
      this.ripple = this.playing ? 0.035 + this.cur.amp * 0.6 : 0.012;
    }
    this.ripple = (this.ripple || 0) * Math.exp(-dt * 3);

    // Breathing: the brain swells and relaxes, bigger and faster with the music.
    const breathRate = this.playing ? (this.cur.tempo / 60) * Math.PI / 2 : 1.1;
    this.breathPhase = (this.breathPhase || 0) + dt * breathRate;
    const breathSize = motionOn ? (this.playing ? 0.035 + this.cur.amp * 0.5 : 0.022) : 0.004;
    const breath = Math.sin(this.breathPhase) * breathSize;

    this.uniforms.uPulse.value = pulse * (0.4 + this.cur.amp * 8);
    this.uniforms.uBreath.value = breath;
    this.uniforms.uRipple.value = this.ripple;
    this.uniforms.uFlash.value = pulse * (this.playing ? 0.5 : 0.15);
    this.head.scale.setScalar(1 + breath * 0.9 + pulse * 0.025);

    // Headphones: cups push out and pump, cones vibrate and spin, the band flexes.
    this.phoneMat.color.copy(this.cur.b).lerp(WHITE, 0.6);
    this.eqMat.color.copy(this.cur.a).lerp(WHITE, 0.25);
    const hz = this.cur.tempo / 60;
    this.cups.forEach(c => {
      const s = c.userData.side, cone = c.userData.cone;
      c.position.x = s * (1.2 + pulse * 0.07);
      c.scale.setScalar(1 + pulse * 0.08);
      const buzz = motionOn ? Math.sin(t * hz * Math.PI * 4) * (0.01 + this.cur.amp * 0.4) * (this.playing ? 1 : 0.2) : 0;
      cone.position.x = s * (0.14 + buzz);
      cone.rotation.x += dt * (this.playing ? 1.4 : 0.3);
      cone.material.color.copy(this.cur.a).lerp(WHITE, 0.3);
    });
    this.band.scale.set(1 + pulse * 0.03, 1 + pulse * 0.05 + breath * 0.6, 1);
    // Equalizer: each bar bounces at its own rate; louder songs bounce higher.
    const level = this.playing ? 0.35 + this.cur.amp * 9 : 0.12;
    this.bars.forEach((b, i) => {
      const v = motionOn ? (0.5 + 0.5 * Math.sin(t * (3 + i * 0.7) * (this.cur.tempo / 100) + i * 1.7)) * (0.6 + pulse * 0.8) : 0.3;
      b.scale.y = 0.15 + v * level * 2.2;
    });

    this.rings.forEach(r => {
      if (r.life <= 0) { r.m.visible = false; return; }
      r.life -= dt * (r.speed || 0.9);
      const g = 1 - r.life;
      r.m.visible = true;
      r.m.position.set(r.side * (1.38 + g * 0.9), -0.02, 0);
      r.m.scale.setScalar(1 + g * 1.8);
      r.m.material.opacity = r.life * (this.playing ? 0.55 : 0.25);
      r.m.material.color.copy(this.cur.a);
    });

    // Sway with the music; idle drift when paused.
    const sway = this.reduced ? 0 : Math.sin(t * this.cur.freq * 0.5) * (0.06 + this.cur.amp * 1.2);
    this.head.rotation.y = -0.55 + this.spinOffset + (this.drag || this.reduced ? 0 : t * 0.08) + sway * 0.6;
    this.head.rotation.z = sway * 0.25;
    this.head.position.y = this.reduced ? 0 : Math.sin(t * this.cur.freq) * this.cur.amp * 1.5;

    if (this.intro) this.stepIntro(dt);
    this.renderer.render(this.scene, this.camera);
  }

  stepIntro(dt) {
    const I = this.intro;
    I.t += dt;
    const p = Math.min(I.t / I.duration, 1);
    const seg = (a, b) => Math.min(Math.max((p - a) / (b - a), 0), 1);
    const outCubic = x => 1 - Math.pow(1 - x, 3);
    const outBack = x => 1 + 2.4 * Math.pow(x - 1, 3) + 1.4 * Math.pow(x - 1, 2);

    // 1. The scan line builds the brain (0% to 42%).
    this.uniforms.uReveal.value = p >= 0.42 ? 1 : outCubic(seg(0.03, 0.42));
    // 2. Headphones fly in from both sides and the band drops onto the head (40% to 66%).
    const fly = seg(0.4, 0.66);
    this.phones.visible = p > 0.4;
    this.cups.forEach(c => { const s = c.userData.side; c.position.x = s * (1.2 + (1 - outBack(fly)) * 4.5); c.rotation.x = (1 - fly) * s * 3; });
    this.band.position.y = 0.02 + (1 - outBack(fly)) * 2.6;
    this.bars.forEach((b, i) => { b.visible = fly > 0.9 - i * 0.02; });
    // 3. Snap: a burst of rings from both ears and a flash (at 66%).
    if (!I.snapped && p >= 0.66) {
      I.snapped = true;
      this.rings.forEach((r, i) => { if (i < 6) { r.life = 1 - i * 0.12; r.side = i % 2 ? 1 : -1; r.speed = 0.7; } });
      this.ripple = 0.09;
    }
    if (I.snapped) this.uniforms.uFlash.value = Math.max(this.uniforms.uFlash.value, (1 - seg(0.66, 0.8)) * 0.9);
    // 4. The head spins in and the camera glides in, stopping centred above the title.
    const settle = outCubic(seg(0, 1));
    this.head.rotation.y += (1 - settle) * -Math.PI * 1.6;
    const iz = this.introZ || this.baseZ;
    // 5. Once the title fades (skipIntro), glide to the resting place beside the panels.
    if (I.leave >= 0) I.leave = Math.min(1, I.leave + dt / 0.9);
    I.k = I.leave < 0 ? 0 : outCubic(Math.max(0, I.leave));
    this.camera.position.z = iz + (1 - outCubic(seg(0, 0.7))) * 5 + (this.baseZ - iz) * I.k;
    this.applyView(I.k);

    if (p >= 1) {
      this.uniforms.uReveal.value = 1;
      this.phones.visible = true;
      this.band.position.y = 0.02;
      this.cups.forEach(c => { c.rotation.x = 0; });
      this.bars.forEach(b => { b.visible = true; });
      if (I.done) { const done = I.done; I.done = null; done(); }
      if (I.leave >= 1) {
        this.camera.position.z = this.baseZ;
        this.intro = null;
        this.applyView(1);
      }
    }
  }
}
