// AI Studio: a sound-shaping chain with ready-made modes and an "Auto" mode that
// listens to the song and tunes the bands toward the chosen mode's target sound.
//
//   in ─► volume ─► sub ─► bass ─► low-mids ─► mids ─► vocals ─► presence ─► treble ─► air ─► drive ─► punch ─► limiter ─► out
//                                                                        (the analyser listens before the EQ, for Auto)

export const BANDS = [
  { id: 'sub', label: 'Sub-bass', type: 'lowshelf', freq: 55, q: 0.7 },
  { id: 'bass', label: 'Bass', type: 'peaking', freq: 110, q: 0.9 },
  { id: 'lowmid', label: 'Low-mids', type: 'peaking', freq: 300, q: 0.9 },
  { id: 'mid', label: 'Mids', type: 'peaking', freq: 1000, q: 0.8 },
  { id: 'vocal', label: 'Vocals', type: 'peaking', freq: 2500, q: 1.0 },
  { id: 'presence', label: 'Presence', type: 'peaking', freq: 5000, q: 1.0 },
  { id: 'treble', label: 'Treble', type: 'highshelf', freq: 9000, q: 0.7 },
  { id: 'air', label: 'Air', type: 'highshelf', freq: 14000, q: 0.7 },
];

const z = { sub: 0, bass: 0, lowmid: 0, mid: 0, vocal: 0, presence: 0, treble: 0, air: 0 };

/** Modes: band gains in dB, plus volume (dB), punch (0..1), drive (0..1) and room echo (0..1). */
export const MODES = {
  flat: { label: 'Original', bands: { ...z }, volume: 0, punch: 0, drive: 0, room: 0.2 },
  club: { label: 'Club', bands: { sub: 5, bass: 4, lowmid: -2, mid: -1, vocal: 1, presence: 2, treble: 3, air: 2 }, volume: -1, punch: 0.6, drive: 0.15, room: 0.3 },
  vocal: { label: 'Vocal', bands: { sub: -3, bass: -2, lowmid: -1, mid: 2, vocal: 5, presence: 3, treble: 1, air: 1 }, volume: 0, punch: 0.4, drive: 0, room: 0.3 },
  bass: { label: 'Bass', bands: { sub: 6, bass: 6, lowmid: 1, mid: 0, vocal: 0, presence: 0, treble: 1, air: 0 }, volume: -2, punch: 0.4, drive: 0.1, room: 0.2 },
  xbass: { label: 'Extreme Bass', bands: { sub: 12, bass: 10, lowmid: 2, mid: -2, vocal: -1, presence: 0, treble: 2, air: 0 }, volume: -5, punch: 0.8, drive: 0.35, room: 0.15 },
  acoustic: { label: 'Acoustic', bands: { sub: -2, bass: 1, lowmid: 2, mid: 1, vocal: 2, presence: 2, treble: 2, air: 3 }, volume: 0, punch: 0.2, drive: 0, room: 0.35 },
  night: { label: 'Night', bands: { sub: 2, bass: 2, lowmid: 1, mid: 0, vocal: -1, presence: -3, treble: -4, air: -4 }, volume: -4, punch: 0.5, drive: 0.05, room: 0.25 },
  cinema: { label: 'Cinema', bands: { sub: 6, bass: 3, lowmid: -1, mid: 0, vocal: 2, presence: 2, treble: 2, air: 2 }, volume: -2, punch: 0.5, drive: 0, room: 0.6 },
};

const dbToGain = db => Math.pow(10, db / 20);

function driveCurve(amount) {
  const n = 1024, k = amount * 40, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = k ? ((1 + k) * x) / (1 + k * Math.abs(x)) : x;
  }
  return curve;
}

export class Studio {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = new GainNode(ctx, { gain: 1 });
    this.volume = new GainNode(ctx, { gain: 1 });
    this.filters = BANDS.map(b => new BiquadFilterNode(ctx, { type: b.type, frequency: b.freq, Q: b.q, gain: 0 }));
    this.drive = new WaveShaperNode(ctx, { curve: driveCurve(0), oversample: '2x' });
    this.punch = new DynamicsCompressorNode(ctx, { threshold: 0, ratio: 1, attack: 0.01, release: 0.2, knee: 6 });
    this.makeup = new GainNode(ctx, { gain: 1 });
    // Safety limiter: keeps big bass boosts from clipping or getting painfully loud.
    this.limiter = new DynamicsCompressorNode(ctx, { threshold: -2, ratio: 20, attack: 0.003, release: 0.1, knee: 0 });
    this.output = this.limiter;
    this.analyser = new AnalyserNode(ctx, { fftSize: 4096, smoothingTimeConstant: 0.85 });
    this.input.connect(this.analyser);
    let node = this.input.connect(this.volume);
    for (const f of this.filters) node = node.connect(f);
    node.connect(this.drive).connect(this.punch).connect(this.makeup).connect(this.limiter);
    this.settings = structuredClone(MODES.flat);
    this.mode = 'flat';
  }

  /** Apply full settings: { bands, volume, punch, drive } (room is handled by the spatial engine). */
  apply(s, smooth = true) {
    this.settings = structuredClone(s);
    const now = this.ctx.currentTime, set = (p, v) => (smooth ? p.setTargetAtTime(v, now, 0.04) : (p.value = v));
    BANDS.forEach((b, i) => set(this.filters[i].gain, s.bands[b.id] || 0));
    set(this.volume.gain, dbToGain(s.volume || 0));
    const punch = s.punch || 0;
    set(this.punch.threshold, -punch * 24);
    set(this.punch.ratio, 1 + punch * 5);
    set(this.makeup.gain, dbToGain(punch * 7));
    this.drive.curve = driveCurve(s.drive || 0);
  }

  setMode(id) { this.mode = id; this.apply(MODES[id]); }

  /** Frequency response of the current settings, for drawing the curve. */
  response(freqs) {
    const mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length), total = new Float32Array(freqs.length).fill(1);
    for (const f of this.filters) { f.getFrequencyResponse(freqs, mag, ph); for (let i = 0; i < mag.length; i++) total[i] *= mag[i]; }
    return total;
  }

  /** Loudness (dB) of the incoming song in each band, read from the analyser. */
  measureBands() {
    const data = new Float32Array(this.analyser.frequencyBinCount);
    this.analyser.getFloatFrequencyData(data);
    const hzPerBin = this.ctx.sampleRate / this.analyser.fftSize;
    const edges = [[30, 80], [80, 180], [180, 500], [500, 1600], [1600, 3500], [3500, 7000], [7000, 12000], [12000, 18000]];
    return edges.map(([lo, hi]) => {
      let sum = 0, n = 0;
      for (let i = Math.floor(lo / hzPerBin); i <= Math.min(data.length - 1, Math.ceil(hi / hzPerBin)); i++) { if (isFinite(data[i])) { sum += Math.pow(10, data[i] / 10); n++; } }
      return n ? 10 * Math.log10(sum / n + 1e-12) : -100;
    });
  }
}

/**
 * Auto mode. Listens to the song (several snapshots), compares each band with a balanced
 * reference curve, corrects part of the difference, then adds the chosen mode's character.
 * Optional track facts (energy, genres) steer which character fits.
 */
export async function autoTune(studio, { baseMode = null, track = null, seconds = 4, onProgress } = {}) {
  const snaps = [];
  const steps = Math.round(seconds / 0.25);
  for (let i = 0; i < steps; i++) {
    await new Promise(r => setTimeout(r, 250));
    const m = studio.measureBands();
    if (m.some(v => v > -95)) snaps.push(m);
    onProgress?.((i + 1) / steps);
  }
  if (snaps.length < 3) throw new Error('Auto needs the song playing to listen to it. Press play, then try Auto again.');
  const avg = snaps[0].map((_, b) => snaps.reduce((s, m) => s + m[b], 0) / snaps.length);

  // Reference: how a well-balanced mix sits per band, falling a little faster than pink
  // noise toward the highs (per-bin loudness at each band's centre).
  const tilt = [0, -3, -7, -12, -16, -20, -24, -29];
  const level = avg.reduce((s, v, i) => s + (v - tilt[i]), 0) / avg.length;
  const correction = avg.map((v, i) => {
    let c = (tilt[i] + level - v) * 0.35;
    // Don't boost what the song barely has: that only lifts noise.
    if (v < tilt[i] + level - 18) c = Math.min(c, 1.5);
    return Math.max(-4, Math.min(4, c));
  });

  // Pick the character: the listener's choice, or one inferred from the song.
  let mode = baseMode;
  let reason = '';
  if (!mode || mode === 'flat') {
    const lowHeavy = avg[0] + avg[1] - (avg[3] + avg[4]);
    const genres = (track?.genres || []).join(' ');
    if (/Dance|Electro|Rap/.test(genres) || (track?.energy ?? 0) > 0.72) { mode = 'club'; reason = 'high-energy track'; }
    else if (/Classical|Jazz|Folk/.test(genres) || (track?.energy ?? 1) < 0.3) { mode = 'acoustic'; reason = 'soft, acoustic feel'; }
    else if (lowHeavy > 18) { mode = 'bass'; reason = 'already bass-led'; }
    else if (avg[4] - avg[1] > -6) { mode = 'vocal'; reason = 'voice-forward mix'; }
    else { mode = 'club'; reason = 'balanced mix'; }
  }
  const base = MODES[mode];
  const bands = {};
  BANDS.forEach((b, i) => {
    // Keep the mode's character: never cut much from a band the mode deliberately boosts.
    const c = base.bands[b.id] > 2 ? Math.max(correction[i], -1.5) : correction[i];
    bands[b.id] = Math.round((base.bands[b.id] + c) * 2) / 2;
  });
  const settings = { ...structuredClone(base), bands, label: `Auto (${base.label})` };
  studio.mode = 'auto';
  studio.apply(settings);
  return { settings, mode, reason, measured: avg };
}

// ---------- remembered taste per song ----------
const KEY = 'cfm.studio.songs';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
export const songKey = name => (name || '').toLowerCase().replace(/\s*[([].*?[)\]]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
export function savedTaste(name) { return load()[songKey(name)] || null; }
export function saveTaste(name, mode, settings) {
  const all = load();
  all[songKey(name)] = { mode, settings, at: Date.now() };
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage full */ }
}
