// Spatial audio engine: moves a song around the listener's head with HRTF panning.
// Live playback and offline rendering share the same graph, so the saved file
// sounds like what you heard.
//
//   source ─► studio (AI Studio EQ) ─┬─► panner(HRTF) ─┬─► dry ──┐
//                                    │                 └─► room ─┴─► spatial ─┐
//                                    └──────────────────────────────► direct ──┴─► master ─► analyser ─► out
//
// The source is a decoded song file, a 30-second preview, or the demo beat.
import { Studio } from './studio.js';

function makeImpulse(ctx, seconds = 2.4, decay = 3) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return ir;
}

function buildGraph(ctx) {
  const studio = new Studio(ctx);
  // channelCount 1: fold the song to one point so the whole song moves around you.
  const panner = new PannerNode(ctx, {
    panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1, maxDistance: 50, rolloffFactor: 0.6,
    channelCount: 1, channelCountMode: 'explicit',
  });
  studio.output.connect(panner);
  const dry = new GainNode(ctx, { gain: 1 });
  const convolver = new ConvolverNode(ctx, { buffer: makeImpulse(ctx) });
  const room = new GainNode(ctx, { gain: 0.35 });
  const spatial = new GainNode(ctx, { gain: 1 });
  const direct = new GainNode(ctx, { gain: 0 });
  const master = new GainNode(ctx, { gain: 0.9 });
  panner.connect(dry).connect(spatial);
  panner.connect(convolver).connect(room).connect(spatial);
  spatial.connect(master);
  direct.connect(master);
  // Listener sits at the origin, facing -Z, head up +Y (Web Audio's default).
  const L = ctx.listener;
  if (L.positionX) { L.positionX.value = 0; L.positionY.value = 0; L.positionZ.value = 0; L.forwardX.value = 0; L.forwardY.value = 0; L.forwardZ.value = -1; L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0; }
  else { L.setPosition(0, 0, 0); L.setOrientation(0, 0, -1, 0, 1, 0); }
  studio.output.connect(direct);
  return { studio, panner, dry, room, spatial, direct, master, inputs: [studio.input] };
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
  constructor() { this.ctx = null; this.buffer = null; this.src = null; this.offset = 0; this.playing = false; this.bypass = false; this.roomAmount = 0.35; }

  ensure() {
    if (this.ctx) return this.ctx;
    this.ctx = new AudioContext({ latencyHint: 'playback' });
    this.g = buildGraph(this.ctx);
    this.analyser = new AnalyserNode(this.ctx, { fftSize: 512, smoothingTimeConstant: 0.75 });
    this.g.master.connect(this.analyser).connect(this.ctx.destination);
    this.levels = new Uint8Array(this.analyser.frequencyBinCount);
    return this.ctx;
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
  }

  stopStream() {
    if (this.streamSrc) { this.streamSrc.disconnect(); this.streamSrc = null; }
    this.stream = null;
    if (this.streaming) { this.streaming = false; this.playing = false; }
  }

  get currentTime() {
    if (!this.playing) return this.offset;
    const t = this.ctx.currentTime - this.startedAt + this.offset;
    return this.loop ? t % this.duration : Math.min(t, this.duration);
  }

  async play() {
    if (!this.buffer || this.playing) return;
    await this.ensure().resume();
    const src = new AudioBufferSourceNode(this.ctx, { buffer: this.buffer, loop: this.loop });
    this.g.inputs.forEach(n => src.connect(n));
    src.onended = () => { if (this.src === src && !this.loop) { this.playing = false; this.offset = 0; this.onEnded?.(); } };
    src.start(0, this.offset % this.duration);
    this.src = src; this.startedAt = this.ctx.currentTime; this.playing = true;
  }

  pause() { if (!this.playing) return; this.offset = this.currentTime; this.stopSource(); this.playing = false; }
  seek(t) { const was = this.playing; this.pause(); this.offset = Math.max(0, Math.min(t, this.duration - 0.05)); if (was) this.play(); }
  stopSource() { if (this.src) { this.src.onended = null; try { this.src.stop(); } catch { /* already stopped */ } this.src.disconnect(); this.src = null; } }

  /** Where the sound is, in metres around the listener. */
  setPosition(x, y, z) {
    if (!this.ctx) return;
    const p = this.g.panner, now = this.ctx.currentTime;
    p.positionX.setTargetAtTime(x, now, 0.015); p.positionY.setTargetAtTime(y, now, 0.015); p.positionZ.setTargetAtTime(z, now, 0.015);
  }

  setRoom(amount) { this.roomAmount = amount; if (this.ctx) this.g.room.gain.setTargetAtTime(amount, this.ctx.currentTime, 0.05); }

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
   * Render the whole song moving along `pathAt(seconds) -> [x,y,z]` into a WAV Blob.
   * The panner is automated 60 times a second, which is smooth for any glide speed.
   */
  async render(pathAt) {
    if (this.streaming) throw new Error("Full Spotify songs play live and can't be saved. Saving works for files and previews.");
    if (!this.buffer) throw new Error('Load a song first.');
    const sr = this.buffer.sampleRate, len = this.buffer.length;
    const off = new OfflineAudioContext(2, len, sr);
    const g = buildGraph(off);
    g.room.gain.value = this.roomAmount;
    g.direct.gain.value = 0;
    g.studio.apply(this.g.studio.settings, false); // the saved file gets your Studio sound too
    const src = new AudioBufferSourceNode(off, { buffer: this.buffer });
    g.inputs.forEach(n => src.connect(n));
    g.master.connect(off.destination);
    const step = 1 / 60, p = g.panner;
    const [x0, y0, z0] = pathAt(0);
    p.positionX.setValueAtTime(x0, 0); p.positionY.setValueAtTime(y0, 0); p.positionZ.setValueAtTime(z0, 0);
    for (let t = step; t < this.duration; t += step) {
      const [x, y, z] = pathAt(t);
      p.positionX.linearRampToValueAtTime(x, t); p.positionY.linearRampToValueAtTime(y, t); p.positionZ.linearRampToValueAtTime(z, t);
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
