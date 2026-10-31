// Runs on the audio thread. Every audio sample it works out where the sound is and feeds
// that straight into the 3D panner, so the movement is perfectly smooth and never depends
// on the page (screen off, app in the background).
//
// Movement = the smooth orbit through your 8/16 points, plus, now and then, a surprise move
// (fly-over, whisper at your ear, spiral, sweep, pull-away, halo) blended in and out.
//
// Output channels: 0 = x, 1 = y, 2 = z (metres around your head),
//                  3 = extra room echo, 4 = "air" (high-frequency loss when far away).

const TABLE = 1024;

function uOfS(phi, s) {
  s -= Math.floor(s);
  const x = s * TABLE, i = Math.floor(x), f = x - i;
  const a = phi[i], b = i + 1 < TABLE ? phi[i + 1] : 1;
  return a + (b - a) * f;
}

function dirAt(table, u, out) {
  u -= Math.floor(u);
  const x = u * TABLE, i = Math.floor(x), f = x - i, f2 = f * f, f3 = f2 * f;
  const i0 = ((i - 1 + TABLE) % TABLE) * 3, i1 = (i % TABLE) * 3, i2 = ((i + 1) % TABLE) * 3, i3 = ((i + 2) % TABLE) * 3;
  for (let a = 0; a < 3; a++) {
    const p0 = table[i0 + a], p1 = table[i1 + a], p2 = table[i2 + a], p3 = table[i3 + a];
    out[a] = 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
  }
  return norm(out);
}

function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= l; v[1] /= l; v[2] /= l; return v; }
// Listener frame: front is -Z, right is +X, up is +Y.
function fromAzEl(az, el, out) { out[0] = Math.cos(el) * Math.sin(az); out[1] = Math.sin(el); out[2] = -Math.cos(el) * Math.cos(az); return out; }
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Spherical blend between two directions (stays on the sphere, no shortcut through your head).
function slerp(a, b, w, out) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (dot < -0.995) { b = norm([b[0], b[1] + 0.25, b[2]]); dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; } // go over the top, not through
  dot = Math.min(1, Math.max(-1, dot));
  const th = Math.acos(dot);
  if (th < 1e-4) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return out; }
  const s = Math.sin(th), k0 = Math.sin((1 - w) * th) / s, k1 = Math.sin(w * th) / s;
  out[0] = a[0] * k0 + b[0] * k1; out[1] = a[1] * k0 + b[1] * k1; out[2] = a[2] * k0 + b[2] * k1;
  return norm(out);
}

function rng(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }

// The surprise moves. d0/r0 = where the orbit is; e = this move's random choices; tau 0..1.
const MOVES = {
  flyover: { secs: 5, name: 'Fly-over above your head', at(tau, e, d0, r0, out) {
    const th = Math.PI * tau; // front → straight up → behind
    const x = 0, y = Math.sin(th), z = -Math.cos(th);
    out[0] = x * Math.cos(e.yaw) + z * Math.sin(e.yaw); out[1] = y; out[2] = -x * Math.sin(e.yaw) + z * Math.cos(e.yaw);
    return r0; } },
  whisper: { secs: 4.5, name: 'Whisper at your ear', at(tau, e, d0, r0, out) {
    fromAzEl(e.side * (Math.PI / 2 - 0.25 + 0.5 * tau), 0.08, out);
    return Math.min(r0, 0.45); } },
  spiral: { secs: 7, name: 'Spiral around you', at(tau, e, d0, r0, out) {
    fromAzEl(e.az0 + e.turn * 4 * Math.PI * tau, -0.65 + 1.75 * tau, out);
    return r0 * 0.85; } },
  sweep: { secs: 4.5, name: 'Left–right sweep', at(tau, e, d0, r0, out) {
    fromAzEl(e.side * 1.3 * Math.sin(2 * Math.PI * 2.5 * tau), 0.1, out);
    return r0 * 0.9; } },
  away: { secs: 6, name: 'Pulling far away', at(tau, e, d0, r0, out) {
    out[0] = d0[0]; out[1] = d0[1]; out[2] = d0[2];
    return r0 * (1 + 1.8 * Math.sin(Math.PI * tau)); } },
  halo: { secs: 6.5, name: 'Halo over your head', at(tau, e, d0, r0, out) {
    fromAzEl(e.az0 + e.turn * 2 * Math.PI * tau, 1.12, out);
    return r0; } },
};
const MOVE_KEYS = Object.keys(MOVES);

class CortexTrajectory extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.table = o.table || null;
    this.phi = o.phi || null;
    this.lap = o.lap || 12;
    this.dist = this.targetDist = o.dist || 1.8;
    this.breath = o.breath ?? 0.05;
    this.room = o.room ?? 0.35;
    this.surprise = o.surprise ?? 0.5;
    this.run = !!o.run;
    this.s = o.s || 0;
    this.rate = this.run ? 1 / this.lap : 0;
    this.report = o.report !== false;
    this.rand = rng(o.seed || 1);
    this.elapsed = 0;                               // seconds of movement so far
    this.nextMove = this.gap(true);
    this.move = null; this.lastMove = '';
    this.glide = 0;
    this.pos = null; this.mod = 0; this.air = 0; this.since = 0;
    this.d0 = [0, 0, -1]; this.de = [0, 0, -1]; this.d = [0, 0, -1];
    this.port.onmessage = e => {
      const m = e.data;
      if (m.type === 'path') { this.table = m.table; this.phi = m.phi; this.glide = 0.35; }
      else if (m.type === 'cfg') {
        if (m.lap) this.lap = m.lap;
        if (m.dist) this.targetDist = m.dist;
        if (m.breath != null) this.breath = m.breath;
        if (m.room != null) this.room = m.room;
        if (m.surprise != null) { this.surprise = m.surprise; this.nextMove = Math.min(this.nextMove, this.elapsed + this.gap()); }
      }
      else if (m.type === 'run') this.run = !!m.on;
      else if (m.type === 'seek') { this.s = ((m.s % 1) + 1) % 1; this.glide = 0.25; }
      else if (m.type === 'report') this.report = !!m.on;
    };
  }

  // Seconds until the next surprise: rarer at low settings, never back-to-back.
  gap(first) {
    if (this.surprise <= 0) return Infinity;
    const mean = 45 - 36 * this.surprise; // 45 s … 9 s
    return (first ? 6 : 0) + mean * (0.6 + 0.8 * this.rand());
  }

  startMove() {
    let key;
    do { key = MOVE_KEYS[Math.floor(this.rand() * MOVE_KEYS.length)]; } while (key === this.lastMove);
    this.lastMove = key;
    const az0 = Math.atan2(this.d0[0], -this.d0[2]);
    this.move = { key, t0: this.elapsed, secs: MOVES[key].secs, e: { yaw: (this.rand() - 0.5) * 1.6, side: this.d0[0] >= 0 ? 1 : -1, az0, turn: this.rand() < 0.5 ? 1 : -1 } };
  }

  process(_inputs, outputs) {
    const out = outputs[0], n = out[0].length, dt = n / sampleRate;

    const ease = 1 - Math.exp(-dt / 0.4);
    this.rate += ((this.run ? 1 / this.lap : 0) - this.rate) * ease;
    this.dist += (this.targetDist - this.dist) * ease;
    this.s = (this.s + this.rate * dt) % 1;
    if (this.run) this.elapsed += dt;

    let x = 0, y = 0, z = -this.dist, mod = 0, air = 0, r = this.dist;
    if (this.table && this.phi) {
      // 1. The smooth orbit through your points, with a gentle in-and-out breath.
      dirAt(this.table, uOfS(this.phi, this.s), this.d0);
      const r0 = this.dist * (1 + this.breath * Math.sin(4 * Math.PI * this.s));
      let d = this.d0; r = r0;

      // 2. Now and then, a surprise move, blended in and out so there is never a jump.
      if (!this.move && this.run && this.elapsed >= this.nextMove) this.startMove();
      if (this.move) {
        const mv = this.move, tau = (this.elapsed - mv.t0) / mv.secs;
        if (tau >= 1) { this.move = null; this.nextMove = this.elapsed + this.gap(); }
        else {
          const w = smooth(0, 0.2, tau) * (1 - smooth(0.8, 1, tau));
          const re = MOVES[mv.key].at(tau, mv.e, this.d0, r0, this.de);
          d = slerp(this.d0, this.de, w, this.d);
          r = r0 + (re - r0) * w;
        }
      }
      x = d[0] * r; y = d[1] * r; z = d[2] * r;

      // 3. Like a real room: farther = more echo and less treble; behind/above = a bit more echo.
      const far = Math.min(1, Math.max(0, (r / this.dist - 1) / 1.5));
      mod = this.room * (0.35 * Math.max(0, d[2]) + 0.15 * Math.max(0, d[1]) + 0.6 * far);
      air = -11000 * far;
    }

    // Smooth follower (20 ms, longer right after a jump), interpolated across the block.
    if (!this.pos) this.pos = [x, y, z];
    const tau = 0.02 + this.glide;
    this.glide *= Math.exp(-dt / 0.5);
    const a = 1 - Math.exp(-dt / tau);
    const p0 = this.pos[0], p1 = this.pos[1], p2 = this.pos[2], m0 = this.mod, a0 = this.air;
    this.pos[0] += (x - p0) * a; this.pos[1] += (y - p1) * a; this.pos[2] += (z - p2) * a;
    this.mod += (mod - m0) * a; this.air += (air - a0) * a;
    const d0 = this.pos[0] - p0, d1 = this.pos[1] - p1, d2 = this.pos[2] - p2, dm = this.mod - m0, da = this.air - a0;
    for (let i = 0; i < n; i++) {
      const f = (i + 1) / n;
      if (out[0]) out[0][i] = p0 + d0 * f;
      if (out[1]) out[1][i] = p1 + d1 * f;
      if (out[2]) out[2][i] = p2 + d2 * f;
      if (out[3]) out[3][i] = m0 + dm * f;
      if (out[4]) out[4][i] = a0 + da * f;
    }

    // Tell the page where the sound is (for the 3D view), ~50 times a second while it's visible.
    if (this.report && (this.since += n) >= sampleRate * 0.02) {
      this.since = 0;
      const len = Math.hypot(this.pos[0], this.pos[1], this.pos[2]) || 1;
      this.port.postMessage({ s: this.s, rate: this.rate, t: currentTime, x: this.pos[0] / len, y: this.pos[1] / len, z: this.pos[2] / len, r: len, move: this.move ? MOVES[this.move.key].name : null });
    }
    return true;
  }
}

registerProcessor('cortex-trajectory', CortexTrajectory);
