// The glide path for 8D/16D.
//
// 1. A periodic C2 cubic spline through every point (smooth position, direction AND turning,
//    so there is no jolt anywhere), parameterised by the real distance between points.
// 2. Kept on the sphere and re-timed by arc length, so the glide speed is even.
// 3. A speed profile ("glide feel"): the sound eases through each marked point instead of
//    racing past it. The lap time stays exactly what you set.
//
// The result is two small tables (`table`, `phi`) that the audio thread and the 3D view
// both read, so what you see is exactly what you hear.

export const TABLE = 1024;

const norm3 = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

// Small dense solver (N is 8 or 16).
function solve(A, b) {
  const n = b.length;
  A = A.map(r => r.slice()); b = b.slice();
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = b[r]; for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k]; x[r] = s / A[r][r]; }
  return x;
}

/**
 * points: unit vectors [x,y,z] in visiting order (the path closes back to the first).
 * linger: 0 = perfectly even speed, 0.6 = clearly slows at each point.
 */
export function buildPath(points, { linger = 0.3 } = {}) {
  const N = points.length;
  const P = points.map(norm3);
  const h = P.map((p, i) => Math.max(1e-3, angle(p, P[(i + 1) % N])));

  // Periodic cubic spline, per axis: second derivatives M from the cyclic system.
  const M = [0, 1, 2].map(ax => {
    const A = [...Array(N)].map(() => new Array(N).fill(0)), b = new Array(N).fill(0);
    for (let i = 0; i < N; i++) {
      const im = (i - 1 + N) % N, ip = (i + 1) % N;
      A[i][im] += h[im]; A[i][i] += 2 * (h[im] + h[i]); A[i][ip] += h[i];
      b[i] = 6 * ((P[ip][ax] - P[i][ax]) / h[i] - (P[i][ax] - P[im][ax]) / h[im]);
    }
    return solve(A, b);
  });
  const seg = (i, tau) => {
    const ip = (i + 1) % N, hi = h[i], a = hi - tau;
    return norm3([0, 1, 2].map(ax =>
      M[ax][i] * a * a * a / (6 * hi) + M[ax][ip] * tau * tau * tau / (6 * hi)
      + (P[i][ax] / hi - M[ax][i] * hi / 6) * a + (P[ip][ax] / hi - M[ax][ip] * hi / 6) * tau));
  };

  // Dense samples along the spline, then arc length.
  const SS = 8192, T = h.reduce((a, b) => a + b, 0);
  const starts = []; { let acc = 0; for (let i = 0; i < N; i++) { starts.push(acc); acc += h[i]; } }
  const pts = new Array(SS + 1), nodeK = new Array(N);
  let i = 0;
  for (let k = 0; k <= SS; k++) {
    const t = (k / SS) * T;
    while (i < N - 1 && t >= starts[i + 1]) i++;
    pts[k] = seg(i, Math.min(t - starts[i], h[i]));
  }
  for (let j = 0; j < N; j++) nodeK[j] = Math.round((starts[j] / T) * SS);
  const L = new Float64Array(SS + 1);
  for (let k = 1; k <= SS; k++) L[k] = L[k - 1] + angle(pts[k - 1], pts[k]);
  const Ltot = L[SS];
  const nodeU = nodeK.map(k => L[k] / Ltot);

  // Resample evenly by arc length.
  const table = new Float32Array(TABLE * 3);
  let k = 0;
  for (let j = 0; j < TABLE; j++) {
    const target = (j / TABLE) * Ltot;
    while (k < SS - 1 && L[k + 1] < target) k++;
    const f = (target - L[k]) / Math.max(1e-12, L[k + 1] - L[k]);
    const v = norm3([0, 1, 2].map(ax => pts[k][ax] + (pts[k + 1][ax] - pts[k][ax]) * f));
    table[j * 3] = v[0]; table[j * 3 + 1] = v[1]; table[j * 3 + 2] = v[2];
  }

  return { table, phi: speedProfile(nodeU, linger), nodeU, N };
}

/** phi maps orbit time s (0..1, even in time) to path position u (0..1, even in distance). */
export function speedProfile(nodeU, linger) {
  const G = 4096, sigma = 0.3 / nodeU.length;
  const cum = new Float64Array(G + 1);
  for (let g = 0; g < G; g++) {
    const u = (g + 0.5) / G;
    let near = 0;
    for (const nu of nodeU) { let d = Math.abs(u - nu); d = Math.min(d, 1 - d); near += Math.exp(-(d / sigma) * (d / sigma)); }
    const speed = Math.max(0.25, 1 - linger * Math.min(1, near));
    cum[g + 1] = cum[g] + 1 / speed; // time spent in this slice
  }
  const total = cum[G];
  const phi = new Float32Array(TABLE);
  let g = 0;
  for (let j = 0; j < TABLE; j++) {
    const s = (j / TABLE) * total;
    while (g < G - 1 && cum[g + 1] < s) g++;
    const f = (s - cum[g]) / Math.max(1e-12, cum[g + 1] - cum[g]);
    phi[j] = (g + f) / G;
  }
  return phi;
}

// ---- evaluation (the audio worklet has an identical copy) ----

export function uOfS(phi, s) {
  s -= Math.floor(s);
  const x = s * TABLE, i = Math.floor(x), f = x - i;
  const a = phi[i], b = i + 1 < TABLE ? phi[i + 1] : 1;
  return a + (b - a) * f;
}

/** Direction (unit vector) at path position u, Catmull-Rom between table points. */
export function dirAt(table, u, out = [0, 0, 0]) {
  u -= Math.floor(u);
  const x = u * TABLE, i = Math.floor(x), f = x - i, f2 = f * f, f3 = f2 * f;
  const i0 = ((i - 1 + TABLE) % TABLE) * 3, i1 = (i % TABLE) * 3, i2 = ((i + 1) % TABLE) * 3, i3 = ((i + 2) % TABLE) * 3;
  for (let a = 0; a < 3; a++) {
    const p0 = table[i0 + a], p1 = table[i1 + a], p2 = table[i2 + a], p3 = table[i3 + a];
    out[a] = 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
  }
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= l; out[1] /= l; out[2] /= l;
  return out;
}

// ---- trajectory shapes ----
// Each shape is a closed curve f(t), t in 0..1, returning a unit direction in the listener's
// frame (front -Z, right +X, up +Y). It is sampled into 8 or 16 marked points, then the same
// smooth path builder runs on it, so every shape glides just as smoothly.

const v = (az, el) => { const a = az * Math.PI / 180, e = el * Math.PI / 180; return [Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)]; };
const ease = x => x * x * (3 - 2 * x);
function rng(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
const TAU = 2 * Math.PI;

export const SHAPES = {
  classic: { label: 'Classic orbit', note: null },
  wave: { label: 'Wave orbit', pick: true,
    note: 'Circles all the way around you, rising and dipping twice per lap. Our pick for a full Atmos-style tour.',
    at: t => v(360 * t, 32 * Math.sin(2 * TAU * t)) },
  glide: { label: 'Spiral glide',
    note: 'Spirals down around you from above your head to below it, then floats back up.',
    at: t => { const down = t < 0.5 ? t / 0.5 : (1 - t) / 0.5; return v(720 * t, 62 - 110 * ease(down)); } },
  pendulum: { label: 'Pendulum',
    note: 'Swings from ear to ear in front of you, rising a little at each end, like a slow pendulum.',
    at: t => v(85 * Math.sin(TAU * t), 14 * Math.sin(TAU * t) ** 2 + 7 * Math.cos(TAU * t)) },
  figure8: { label: 'Figure-8',
    note: 'Draws a figure of eight around your head, crossing behind you.',
    at: t => v(150 * Math.sin(TAU * t), 30 * Math.sin(2 * TAU * t)) },
  halo: { label: 'Halo',
    note: 'A circle above your head, like a halo.',
    at: t => v(360 * t, 66) },
  loop: { label: 'Over-the-top loop',
    note: 'From in front of you, up over your head, behind you, and back round underneath.',
    at: t => norm3([0.18 * Math.sin(2 * TAU * t), Math.sin(TAU * t), -Math.cos(TAU * t)]) },
  wander: { label: 'Wander',
    note: 'An organic drift all around you. Tap Wander again for a different one.',
    at: (t, seed) => {
      const r = rng(seed), p = [r(), r(), r(), r()].map(x => x * TAU);
      return v(360 * t + 45 * Math.sin(3 * TAU * t + p[0]) + 18 * Math.sin(5 * TAU * t + p[1]), 30 * Math.sin(2 * TAU * t + p[2]) + 14 * Math.sin(3 * TAU * t + p[3]));
    } },
  custom: { label: 'Draw your own', note: 'Your own path. Tap the circle to place points in order (front is at the top); drag a point to move it.' },
};

/** n marked points for a shape (not for classic or custom). */
export function shapePoints(id, n, seed = 1) {
  return [...Array(n)].map((_, i) => SHAPES[id].at(i / n, seed));
}

/** az/el in degrees → unit vector (exported for the draw-your-own pad). */
export const dirFromAzEl = v;
