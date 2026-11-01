// The opening sound, made live (no audio file), timed to the intro animation:
//   0 – 2.7 s  a warm pad swells while an airy whoosh circles your head (a taste of 8D)
//   2.77 s     the headphones snap on: a deep sub drop with a soft click
//   2.75 – 3.2 s  one bright note per letter of "Cortex FM", left to right
//   3.4 s on   the chord settles and fades out
//
// Browsers only allow sound after you've touched the page. If sound is blocked, start()
// waits, and the first tap (other than Skip) plays the rest from where the animation is.

const KEY = 'cfm.introSound';
export const introSoundOn = () => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } };
export const setIntroSound = on => { try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* */ } };

const hz = midi => 440 * 2 ** ((midi - 69) / 12);
const PAD = [38, 45, 54, 61, 64];          // D maj9: D2 A2 F#3 C#4 E4
const SPARKS = [74, 76, 78, 81, 83, 85, 86, 88]; // D major pentatonic, rising, one per letter

function impulse(ctx, secs = 2.6) {
  const n = Math.floor(ctx.sampleRate * secs), b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2.6; }
  return b;
}

function noise(ctx, secs) {
  const n = Math.floor(ctx.sampleRate * secs), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

/** Schedule everything after `elapsed` seconds into the intro. Returns a stop(fade) function. */
function play(ctx, elapsed) {
  const now = ctx.currentTime + 0.03;
  const at = t => now + Math.max(0, t - elapsed);     // intro time → audio-clock time
  const master = new GainNode(ctx, { gain: 0.0001 });
  master.gain.exponentialRampToValueAtTime(0.85, now + 0.25);
  const comp = new DynamicsCompressorNode(ctx, { threshold: -14, ratio: 4, attack: 0.01, release: 0.3 });
  master.connect(comp).connect(ctx.destination);
  const verb = new ConvolverNode(ctx, { buffer: impulse(ctx) });
  const wet = new GainNode(ctx, { gain: 0.32 });
  verb.connect(wet).connect(master);
  const send = node => { node.connect(master); node.connect(verb); };
  const stops = [];

  // 1. Pad: detuned saws through a filter that opens as the brain builds.
  if (elapsed < 5.2) {
    const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 260, Q: 0.8 });
    const g = new GainNode(ctx, { gain: 0.0001 });
    lp.connect(g); send(g);
    lp.frequency.setValueAtTime(260 + 2200 * Math.min(1, elapsed / 2.7), now);
    lp.frequency.exponentialRampToValueAtTime(2600, at(2.7));
    lp.frequency.exponentialRampToValueAtTime(900, at(5.6));
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(elapsed < 2.7 ? 0.05 + 0.06 * elapsed / 2.7 : 0.11, now + 0.4);
    g.gain.exponentialRampToValueAtTime(0.11, at(2.7));
    g.gain.setTargetAtTime(0.0001, at(3.9), 0.55);
    PAD.forEach((m, i) => [-7, 7].forEach(cents => {
      const o = new OscillatorNode(ctx, { type: i < 2 ? 'triangle' : 'sawtooth', frequency: hz(m), detune: cents });
      const p = new StereoPannerNode(ctx, { pan: (cents > 0 ? 1 : -1) * (0.2 + i * 0.12) });
      o.connect(p).connect(lp); o.start(now); o.stop(at(6.4)); stops.push(o);
    }));
  }

  // 2. Whoosh: filtered noise circling your head, rising to the snap.
  if (elapsed < 2.7) {
    const src = new AudioBufferSourceNode(ctx, { buffer: noise(ctx, 3.2) });
    const bp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 400, Q: 2.2 });
    const g = new GainNode(ctx, { gain: 0.0001 });
    const pan = new StereoPannerNode(ctx);
    const lfo = new OscillatorNode(ctx, { frequency: 0.9 }), depth = new GainNode(ctx, { gain: 0.9 });
    lfo.connect(depth).connect(pan.pan);
    src.connect(bp).connect(g).connect(pan); send(pan);
    bp.frequency.setValueAtTime(400 + 3600 * elapsed / 2.7, now);
    bp.frequency.exponentialRampToValueAtTime(4800, at(2.75));
    lfo.frequency.setValueAtTime(0.9, now); lfo.frequency.linearRampToValueAtTime(3.2, at(2.75));
    g.gain.exponentialRampToValueAtTime(0.09, at(2.55));
    g.gain.exponentialRampToValueAtTime(0.0001, at(2.85));
    src.start(now); lfo.start(now); src.stop(at(2.9)); lfo.stop(at(2.9)); stops.push(src, lfo);
  }

  // 3. The snap: sub drop + click.
  if (elapsed < 2.9) {
    const t = at(2.77);
    const o = new OscillatorNode(ctx, { type: 'sine', frequency: 110 });
    const g = new GainNode(ctx, { gain: 0.0001 });
    o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(36, t + 0.6);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.75, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    o.connect(g).connect(master); o.start(t); o.stop(t + 1.5); stops.push(o);
    const c = new AudioBufferSourceNode(ctx, { buffer: noise(ctx, 0.05) });
    const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 2500 });
    const cg = new GainNode(ctx, { gain: 0.0001 });
    cg.gain.setValueAtTime(0.25, t); cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    c.connect(hp).connect(cg); send(cg); c.start(t); stops.push(c);
  }

  // 4. Sparkles: one note per letter, travelling left to right.
  SPARKS.forEach((m, i) => {
    const T = 2.75 + i * 0.055 + (i >= 6 ? 0.05 : 0);
    if (T < elapsed - 0.05) return;
    const t = at(T);
    const o = new OscillatorNode(ctx, { type: 'sine', frequency: hz(m) });
    const o2 = new OscillatorNode(ctx, { type: 'sine', frequency: hz(m) * 2.01 });
    const g = new GainNode(ctx, { gain: 0.0001 }), g2 = new GainNode(ctx, { gain: 0.25 });
    const p = new StereoPannerNode(ctx, { pan: -0.8 + 1.6 * i / (SPARKS.length - 1) });
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.07, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    o.connect(g); o2.connect(g2).connect(g); g.connect(p); send(p);
    o.start(t); o2.start(t); o.stop(t + 1.2); o2.stop(t + 1.2); stops.push(o, o2);
  });

  const end = at(6.6);
  const timer = setTimeout(() => ctx.close().catch(() => {}), (end - ctx.currentTime) * 1000 + 300);
  return (fade = 0.35) => {
    clearTimeout(timer);
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t); master.gain.setValueAtTime(master.gain.value, t); master.gain.setTargetAtTime(0.0001, t, fade / 3);
    setTimeout(() => ctx.close().catch(() => {}), fade * 1000 + 200);
  };
}

/**
 * Start the intro sound. `onBlocked(show)` is told when the browser is holding sound back,
 * so the page can show a "Tap for sound" hint. Returns { stop(fade) }.
 */
export function startIntroSound({ onBlocked = () => {} } = {}) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx || !introSoundOn()) return { stop() {}, release() {} };
  const ctx = new Ctx({ latencyHint: 'playback' });
  const t0 = performance.now();
  let stopFn = null, done = false;
  const begin = () => { if (done || stopFn) return; stopFn = play(ctx, (performance.now() - t0) / 1000); onBlocked(false); };
  const onTap = e => {
    if (e.target?.closest?.('#intro-skip')) return;
    ctx.resume().then(begin).catch(() => {});
    off();
  };
  const off = () => { removeEventListener('pointerdown', onTap, true); removeEventListener('keydown', onTap, true); };
  ctx.resume().catch(() => {});
  setTimeout(() => {
    if (ctx.state === 'running') begin();
    else { onBlocked(true); addEventListener('pointerdown', onTap, true); addEventListener('keydown', onTap, true); }
  }, 60);
  return {
    /** The intro ended normally: let a playing sound ring out; if it never started, give up. */
    release() {
      done = true; off(); onBlocked(false);
      if (!stopFn) ctx.close().catch(() => {});
    },
    /** Skipped: fade out now. */
    stop(fade) {
      done = true; off(); onBlocked(false);
      if (stopFn) stopFn(fade); else ctx.close().catch(() => {});
    },
  };
}
