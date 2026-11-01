// Spatial audio engine: moves a song around the listener's head with HRTF panning.
// Live playback and offline rendering share the same graph, so the saved file
// sounds like what you heard.
//
//   source ─► studio (AI Studio EQ) ─┬─► air ─► panner(HRTF) ─┬─► dry ─────────┐
//                                    │                         └─► room echo ──┴─► spatial ─┐
//                                    └─────────────────────────────────────────────► direct ──┴─► master ─► analyser ─► speakers
//
// Everything here runs on the real-time audio thread (no convolution reverb helper thread),
// so the sound stays smooth when the phone's screen is off or the app is in the background.
// The trajectory worklet moves the panner and drives the room echo and the air filter.
//
// The source is a decoded song file, a 30-second preview, or the demo beat.
import { Studio } from './studio.js';
import { uOfS, dirAt } from './trajectory.js';

const WORKLET_URL = new URL('./trajectory-worklet.js', import.meta.url);

/**
 * Put the audio-thread trajectory into a graph: worklet → (x, y, z) → panner position,
 * and its fourth channel → extra room echo. Returns the node, or null if this browser
 * has no AudioWorklet (then the page moves the sound itself, as before).
 */
async function attachTrajectory(ctx, g, options) {
  if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return null;
  try {
    await ctx.audioWorklet.addModule(WORKLET_URL);
    const node = new AudioWorkletNode(ctx, 'cortex-trajectory', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [5], processorOptions: options,
    });
    const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 5 });
    node.connect(split);
    const p = g.panner;
    p.positionX.value = 0; p.positionY.value = 0; p.positionZ.value = 0; // the worklet supplies the whole position
    split.connect(p.positionX, 0); split.connect(p.positionY, 1); split.connect(p.positionZ, 2);
    split.connect(g.room.gain, 3);
    split.connect(g.air.frequency, 4);
    return node;
  } catch (e) {
    console.warn('Trajectory worklet unavailable, using the fallback', e);
    return null;
  }
}

/**
 * A small-room echo made only of delay lines and filters (a Schroeder/Freeverb-style design).
 * Unlike a convolution reverb, Chrome runs it entirely on the real-time audio thread, so a
 * phone that slows background work can't make it crackle or drop out.
 */
function makeRoom(ctx) {
  const input = new GainNode(ctx), output = new GainNode(ctx, { gain: 0.5 });
  const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 }), merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
  input.connect(split);
  const combs = [[25.3, 28.1, 30.7, 33.9], [26.1, 28.9, 31.6, 34.7]]; // ms, slightly different per ear
  [0, 1].forEach(ch => {
    const pre = new DelayNode(ctx, { delayTime: 0.011 + ch * 0.004, maxDelayTime: 0.05 });
    const sum = new GainNode(ctx, { gain: 0.26 });
    split.connect(pre, ch);
    for (const ms of combs[ch]) {
      const d = new DelayNode(ctx, { delayTime: ms / 1000, maxDelayTime: 0.1 });
      const damp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 4500, Q: 0.4 });
      const fb = new GainNode(ctx, { gain: 0.82 });
      pre.connect(d); d.connect(damp).connect(fb).connect(d); d.connect(sum);
    }
    const ap1 = new BiquadFilterNode(ctx, { type: 'allpass', frequency: 900, Q: 0.6 });
    const ap2 = new BiquadFilterNode(ctx, { type: 'allpass', frequency: 2800, Q: 0.6 });
    sum.connect(ap1).connect(ap2).connect(merge, 0, ch);
  });
  merge.connect(output);
  return { input, output };
}

// The 360° surround bed: six virtual speakers fixed around you (azimuth°, elevation°, delay ms).
export const BED = [[-110, 0, 6], [110, 0, 9], [-150, 8, 13], [150, 8, 17], [-40, 48, 11], [40, 48, 7]];
const bedDir = (az, el) => { const a = az * Math.PI / 180, e = el * Math.PI / 180; return [Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)]; };

/**
 * Like a Dolby Atmos "bed": the song's spacious part (left minus right, plus a little of the
 * rest above the bass) feeds six fixed HRTF speakers around and above you. Each gets its own
 * short delay, phase filter and polarity so they blend into one surround instead of six copies.
 * The moving sound (the "object") still carries the song's centre.
 */
function makeBed(ctx) {
  const input = new GainNode(ctx), out = new GainNode(ctx, { gain: 0 });
  const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
  input.connect(split);
  const amb = new GainNode(ctx, { gain: 1 });
  const sideL = new GainNode(ctx, { gain: 0.5 }), sideR = new GainNode(ctx, { gain: -0.5 });
  split.connect(sideL, 0); split.connect(sideR, 1); sideL.connect(amb); sideR.connect(amb);
  const mid = new GainNode(ctx, { gain: 0.16 }), hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 160, Q: 0.5 });
  split.connect(mid, 0); split.connect(mid, 1); mid.connect(hp).connect(amb);
  BED.forEach(([az, el, ms], i) => {
    const d = new DelayNode(ctx, { delayTime: ms / 1000, maxDelayTime: 0.05 });
    const ap = new BiquadFilterNode(ctx, { type: 'allpass', frequency: 500 + i * 450, Q: 0.7 });
    const pol = new GainNode(ctx, { gain: (i % 2 ? -1 : 1) * 0.55 });
    const p = new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1, rolloffFactor: 0.3, channelCount: 1, channelCountMode: 'explicit' });
    const [x, y, z] = bedDir(az, el).map(c => c * 2.4);
    p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
    amb.connect(d).connect(ap).connect(pol).connect(p).connect(out);
  });
  return { input, out };
}

function buildGraph(ctx) {
  const studio = new Studio(ctx);
  // channelCount 1: fold the song to one point so the whole song moves around you.
  const panner = new PannerNode(ctx, {
    panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1, maxDistance: 50, rolloffFactor: 0.6,
    channelCount: 1, channelCountMode: 'explicit',
  });
  // "Air": far-away sound loses treble, like in a real room (the worklet lowers this).
  const air = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 20000, Q: 0.5 });
  studio.output.connect(air).connect(panner);
  const dry = new GainNode(ctx, { gain: 1 });
  const roomNet = makeRoom(ctx);
  const room = new GainNode(ctx, { gain: 0.35 });
  const spatial = new GainNode(ctx, { gain: 1 });
  const direct = new GainNode(ctx, { gain: 0 });
  const master = new GainNode(ctx, { gain: 0.9 });
  panner.connect(dry).connect(spatial);
  panner.connect(roomNet.input); roomNet.output.connect(room).connect(spatial);
  spatial.connect(master);
  direct.connect(master);
  // Listener sits at the origin, facing -Z, head up +Y (Web Audio's default).
  const L = ctx.listener;
  if (L.positionX) { L.positionX.value = 0; L.positionY.value = 0; L.positionZ.value = 0; L.forwardX.value = 0; L.forwardY.value = 0; L.forwardZ.value = -1; L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0; }
  else { L.setPosition(0, 0, 0); L.setOrientation(0, 0, -1, 0, 1, 0); }
  studio.output.connect(direct);
  // 360° surround bed (off until setSurround turns it up).
  const bed = makeBed(ctx);
  bed.out.connect(spatial);
  return { studio, air, panner, dry, room, roomNet, bed, spatial, direct, master, inputs: [studio.input] };
}

/** One second of silence on loop, as a media element the phone can show controls for. */
function silentTrack() {
  try {
    const sr = 8000, n = sr, view = new DataView(new ArrayBuffer(44 + n * 2));
    const str = (o, t) => [...t].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sr, true);
    view.setUint32(28, sr * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, n * 2, true);
    const el = new Audio(URL.createObjectURL(new Blob([view], { type: 'audio/wav' })));
    el.loop = true; el.setAttribute('playsinline', ''); el.preload = 'auto';
    return el;
  } catch { return null; }
}

/** A 16-second synthesized loop so the effect can be tried without a file. */
function makeDemoBuffer(ctx) {
  const sr = ctx.sampleRate, secs = 16, len = sr * secs;
  const buf = ctx.createBuffer(2, len, sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const bpm = 96, beat = 60 / bpm;
  const chords = [[220, 261.63, 329.63], [174.61, 220, 261.63], [196, 246.94, 293.66], [164.81, 207.65, 246.94]];
  const arp = [440, 523.25, 659.25, 880, 659.25, 523.25];
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < len; i++) {
    const t = i / sr, b = t / beat, inBeat = (b % 1) * beat;
    const bar = Math.floor(b / 4) % 4, ch = chords[bar];
    let s = 0;
    // kick on every beat
    s += Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-inBeat * 30)) * inBeat) * Math.exp(-inBeat * 7) * 0.8;
    // hat on the off-beat
    const off = ((b + 0.5) % 1) * beat;
    s += rnd() * Math.exp(-off * 60) * 0.12;
    // pad
    const padEnv = 0.5 + 0.5 * Math.sin(Math.PI * ((b % 4) / 4));
    for (const f of ch) s += (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)) * 0.05 * padEnv;
    // plucked arpeggio on eighth notes
    const e = (b * 2) % 1 * beat / 2, note = arp[Math.floor(b * 2) % arp.length];
    s += Math.sin(2 * Math.PI * note * t) * Math.exp(-e * 9) * 0.16;
    L[i] = R[i] = Math.tanh(s * 0.9);
  }
  return buf;
}

export class SpatialEngine {
  constructor() {
    this.ctx = null; this.buffer = null; this.src = null; this.offset = 0; this.playing = false; this.bypass = false; this.roomAmount = 0.35; this.roomOn = true; this.surround = 0.6; this.bedOn = false;
    this.path = null;                                   // { table, phi } from trajectory.js
    this.traj = { lap: 12, dist: 1.8, breath: 0.05, surprise: 0.5, seed: (Math.random() * 2 ** 31) | 0 };
    this.reports = [];                                  // recent positions from the audio thread
    this.orbit = { s: 0, rate: 0, t: 0 };               // last report from the audio thread
    this.fb = { s: 0, rate: 0, dist: 1.8, tick: 0 };    // fallback state when there is no worklet
  }

  ensure() {
    if (this.ctx) return this.ctx;
    // A bigger output buffer (~0.2 s) rides out the phone slowing the app in the background.
    try { this.ctx = new AudioContext({ latencyHint: 0.2 }); } catch { this.ctx = new AudioContext({ latencyHint: 'playback' }); }
    this.g = buildGraph(this.ctx);
    this.analyser = new AnalyserNode(this.ctx, { fftSize: 512, smoothingTimeConstant: 0.75 });
    this.g.master.connect(this.analyser).connect(this.ctx.destination);
    this.levels = new Uint8Array(this.analyser.frequencyBinCount);

    this.setSurround(this.surround);

    // A silent looping track: the phone sees a media player, keeps the app alive and shows
    // lock-screen controls. The music itself goes straight to the speakers (no extra path).
    this.el = silentTrack();

    // If the phone suspends the audio, start it again.
    this.ctx.addEventListener('statechange', () => { if (this.ctx.state !== 'running' && this.playing) this.ctx.resume().catch(() => {}); });
    // Stop sending positions to a hidden page (saves work in the background).
    document.addEventListener('visibilitychange', () => this.worklet?.port.postMessage({ type: 'report', on: !document.hidden }));

    this.worklet = null;
    this.ready = attachTrajectory(this.ctx, this.g, this.workletOptions({ run: false, s: this.orbit.s })).then(node => {
      this.worklet = node;
      if (!node) return;
      node.port.onmessage = e => { this.orbit = e.data; this.reports.push(e.data); if (this.reports.length > 60) this.reports.shift(); };
      // Anything changed while the audio thread was starting up: send the latest.
      if (this.path) node.port.postMessage({ type: 'path', table: this.path.table, phi: this.path.phi });
      node.port.postMessage({ type: 'cfg', ...this.traj, room: this.roomAmount });
    });
    return this.ctx;
  }

  workletOptions(extra = {}) {
    return { table: this.path?.table || null, phi: this.path?.phi || null, ...this.traj, room: this.roomAmount, ...extra };
  }

  /** Call inside a tap: unlocks audio and the lock-screen keep-alive. */
  unlock() {
    const ctx = this.ensure();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    if (this.el?.paused) this.el.play().catch(() => {});
  }

  /** Stop holding the phone's media session (after you pause or the list ends). */
  releaseOutput() { if (this.el && !this.el.paused) this.el.pause(); }

  // ---- the glide ----

  /** New path (8D/16D layout or glide feel). */
  setPath(path) {
    this.path = { table: path.table, phi: path.phi };
    this.worklet?.port.postMessage({ type: 'path', table: path.table, phi: path.phi });
  }

  /** lap (seconds per orbit), dist (metres), breath (0..0.1). */
  setTrajectory(cfg) {
    Object.assign(this.traj, cfg);
    this.worklet?.port.postMessage({ type: 'cfg', ...cfg });
  }

  setRun(on) { this.worklet?.port.postMessage({ type: 'run', on }); }

  setOrbit(s) {
    this.orbit = { s, rate: this.orbit.rate, t: this.ctx?.currentTime || 0 };
    this.fb.s = s;
    this.worklet?.port.postMessage({ type: 'seek', s });
  }

  /**
   * Where the sound is right now as you hear it: { s, x, y, z, r, move } (x,y,z a unit direction).
   * Uses the audio thread's reports, shifted back by the output delay so the 3D view matches your ears.
   */
  orbitNow() {
    if (!this.worklet || !this.reports.length) return null;
    const lat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    const t = this.ctx.currentTime - lat, R = this.reports;
    let i = R.length - 1;
    while (i > 0 && R[i - 1].t >= t) i--;
    const b = R[i], a = R[Math.max(0, i - 1)];
    if (a === b || b.t <= a.t) return b;
    const f = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
    const x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f, z = a.z + (b.z - a.z) * f, l = Math.hypot(x, y, z) || 1;
    return { s: b.s, x: x / l, y: y / l, z: z / l, r: a.r + (b.r - a.r) * f, move: f < 0.5 ? a.move : b.move };
  }

  /** Where the orbit is now (0..1 of a lap), for drawing. */
  orbitPhase() {
    if (!this.worklet) return this.fb.s;
    const o = this.orbit, now = this.ctx?.currentTime ?? o.t;
    return ((o.s + o.rate * Math.max(0, now - o.t)) % 1 + 1) % 1;
  }

  /** Only used without AudioWorklet: move the sound from the page, as before. */
  update(dt) {
    if (this.worklet || !this.ctx || !this.path) return;
    const f = this.fb, ease = 1 - Math.exp(-dt / 0.4);
    f.rate += ((this.playing ? 1 / this.traj.lap : 0) - f.rate) * ease;
    f.dist += (this.traj.dist - f.dist) * ease;
    f.s = (f.s + f.rate * dt) % 1;
    if ((f.tick += dt) < 1 / 30) return;
    f.tick = 0;
    const d = dirAt(this.path.table, uOfS(this.path.phi, f.s));
    const r = f.dist * (1 + this.traj.breath * Math.sin(4 * Math.PI * f.s));
    this.setPosition(d[0] * r, d[1] * r, d[2] * r);
  }

  async loadFile(file) {
    const ctx = this.ensure();
    this.stopStream();
    const data = await file.arrayBuffer();
    try { this.buffer = await ctx.decodeAudioData(data); }
    catch { throw new Error(`Couldn't read "${file.name}". Try an MP3, WAV, M4A, OGG or FLAC file.`); }
    this.loop = false; this.isDemo = false; this.name = file.name.replace(/\.[^.]+$/, '');
    this.reset();
  }

  /** Load audio from a URL (a 30-second preview). */
  async loadUrl(url, name) {
    const ctx = this.ensure();
    this.stopStream();
    const r = await fetch(url).catch(() => null);
    if (!r?.ok) throw new Error("Couldn't download the preview. Check your connection and try again.");
    try { this.buffer = await ctx.decodeAudioData(await r.arrayBuffer()); }
    catch { throw new Error("This browser couldn't read that preview. Try another song, or drop in a file."); }
    this.loop = false; this.isDemo = false; this.name = name;
    this.reset();
  }

  loadDemo() {
    this.stopStream();
    this.buffer = makeDemoBuffer(this.ensure());
    this.loop = true; this.isDemo = true; this.name = 'Demo beat';
    this.reset();
  }

  reset() { this.stopSource(); this.offset = 0; this.playing = false; }
  get duration() { return this.buffer?.duration || 0; }
  get studio() { return this.ensure() && this.g.studio; }

  /**
   * Live input: full Spotify songs arriving through the virtual audio cable.
   * Processed in real time (8D/16D + Studio) and played to your headphones; nothing is recorded.
   */
  startStream(stream) {
    const ctx = this.ensure();
    if (this.streamSrc && this.stream === stream) return;
    this.stopSource(); this.stopStream();
    this.stream = stream;
    this.streamSrc = ctx.createMediaStreamSource(stream);
    this.g.inputs.forEach(n => this.streamSrc.connect(n));
    this.streaming = true; this.playing = true; this.buffer = null;
    ctx.resume();
    this.unlock();
    this.ready?.then(() => this.setRun(true));
  }

  stopStream() {
    if (this.streamSrc) { this.streamSrc.disconnect(); this.streamSrc = null; }
    this.stream = null;
    if (this.streaming) { this.streaming = false; this.playing = false; this.setRun(false); }
  }

  get currentTime() {
    if (!this.playing) return this.offset;
    const t = this.ctx.currentTime - this.startedAt + this.offset;
    return this.loop ? t % this.duration : Math.min(t, this.duration);
  }

  async play() {
    if (!this.buffer || this.playing) return;
    this.unlock();
    await this.ensure().resume();
    await this.ready;
    this.setRun(true);
    const src = new AudioBufferSourceNode(this.ctx, { buffer: this.buffer, loop: this.loop });
    this.g.inputs.forEach(n => src.connect(n));
    src.onended = () => { if (this.src === src && !this.loop) { this.playing = false; this.offset = 0; this.onEnded?.(); } };
    src.start(0, this.offset % this.duration);
    this.src = src; this.startedAt = this.ctx.currentTime; this.playing = true;
  }

  pause() { if (!this.playing) return; this.offset = this.currentTime; this.stopSource(); this.playing = false; this.setRun(false); }
  seek(t) {
    const was = this.playing;
    if (was) { this.offset = this.currentTime; this.stopSource(); this.playing = false; }
    this.offset = Math.max(0, Math.min(t, this.duration - 0.05));
    this.setOrbit((this.offset / this.traj.lap) % 1); // the orbit follows the song position
    if (was) this.play();
  }
  stopSource() { if (this.src) { this.src.onended = null; try { this.src.stop(); } catch { /* already stopped */ } this.src.disconnect(); this.src = null; } }

  /** Where the sound is, in metres around the listener. */
  setPosition(x, y, z) {
    if (!this.ctx) return;
    const p = this.g.panner, now = this.ctx.currentTime;
    p.positionX.setTargetAtTime(x, now, 0.015); p.positionY.setTargetAtTime(y, now, 0.015); p.positionZ.setTargetAtTime(z, now, 0.015);
  }

  /** 360° surround amount, 0..1. At 0 the bed is taken out of the graph and costs nothing. */
  setSurround(amount) {
    this.surround = amount;
    if (!this.ctx) return;
    this.g.bed.out.gain.setTargetAtTime(amount * 0.9, this.ctx.currentTime, 0.08);
    const on = amount > 0.005;
    if (on === this.bedOn) return;
    this.bedOn = on;
    clearTimeout(this.bedTimer);
    if (on) this.g.studio.output.connect(this.g.bed.input);
    else this.bedTimer = setTimeout(() => { if (!this.bedOn) try { this.g.studio.output.disconnect(this.g.bed.input); } catch { /* */ } }, 400);
  }

  setRoom(amount) {
    this.roomAmount = amount;
    if (this.ctx) {
      this.g.room.gain.setTargetAtTime(amount, this.ctx.currentTime, 0.05);
      // Echo at 0: take the echo out of the graph entirely so it costs nothing.
      const on = amount > 0.005;
      if (on !== this.roomOn) {
        this.roomOn = on;
        clearTimeout(this.roomTimer);
        if (on) { try { this.g.panner.connect(this.g.roomNet.input); } catch { /* */ } }
        else this.roomTimer = setTimeout(() => { if (!this.roomOn) try { this.g.panner.disconnect(this.g.roomNet.input); } catch { /* */ } }, 300);
      }
    }
    this.worklet?.port.postMessage({ type: 'cfg', room: amount });
  }

  /** Hear the untouched song for comparison. */
  setBypass(on) {
    this.bypass = on;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.g.spatial.gain.setTargetAtTime(on ? 0 : 1, now, 0.04);
    this.g.direct.gain.setTargetAtTime(on ? 1 : 0, now, 0.04);
  }

  /** 0..1 loudness for visuals. */
  level() {
    if (!this.analyser || !this.playing) return 0;
    this.analyser.getByteFrequencyData(this.levels);
    let s = 0; for (let i = 2; i < 48; i++) s += this.levels[i];
    return s / (46 * 255);
  }

  /**
   * Render the whole song into a WAV Blob with the same audio-thread trajectory you hear live.
   * `pathAt(seconds) -> [x,y,z]` is only used by browsers without AudioWorklet.
   */
  async render(pathAt) {
    if (this.streaming) throw new Error("Full Spotify songs play live and can't be saved. Saving works for files and previews.");
    if (!this.buffer) throw new Error('Load a song first.');
    const sr = this.buffer.sampleRate, len = this.buffer.length;
    const off = new OfflineAudioContext(2, len, sr);
    const g = buildGraph(off);
    g.room.gain.value = this.roomAmount;
    g.direct.gain.value = 0;
    if (this.surround > 0.005) { g.studio.output.connect(g.bed.input); g.bed.out.gain.value = this.surround * 0.9; } // the saved file gets the 360° surround too
    g.studio.apply(this.g.studio.settings, false); // the saved file gets your Studio sound too
    const src = new AudioBufferSourceNode(off, { buffer: this.buffer });
    g.inputs.forEach(n => src.connect(n));
    g.master.connect(off.destination);
    const node = this.path ? await attachTrajectory(off, g, this.workletOptions({ run: true, s: 0, report: false })) : null;
    if (!node) {
      const step = 1 / 60, p = g.panner;
      const [x0, y0, z0] = pathAt(0);
      p.positionX.setValueAtTime(x0, 0); p.positionY.setValueAtTime(y0, 0); p.positionZ.setValueAtTime(z0, 0);
      for (let t = step; t < this.duration; t += step) {
        const [x, y, z] = pathAt(t);
        p.positionX.linearRampToValueAtTime(x, t); p.positionY.linearRampToValueAtTime(y, t); p.positionZ.linearRampToValueAtTime(z, t);
      }
    }
    src.start(0);
    const out = await off.startRendering();
    return encodeWav(out);
  }
}

function encodeWav(buf) {
  const ch = buf.numberOfChannels, sr = buf.sampleRate, n = buf.length;
  // Normalise so the HRTF and room never clip.
  let peak = 0;
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i])); }
  const gain = peak > 0.98 ? 0.98 / peak : 1;
  const bytes = 44 + n * ch * 2, view = new DataView(new ArrayBuffer(bytes));
  const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, bytes - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, ch, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * ch * 2, true); view.setUint16(32, ch * 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, n * ch * 2, true);
  const chans = [...Array(ch)].map((_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, chans[c][i] * gain)); view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
  return new Blob([view], { type: 'audio/wav' });
}
