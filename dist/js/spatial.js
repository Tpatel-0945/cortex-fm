// Spatial page: a wireframe sphere around the listener's head with 8 or 16 points.
// The song glides through them on a smooth closed curve; HRTF panning makes you hear it there.
import * as THREE from 'three';
import { hemisphere, cerebellum } from './brain.js';
import { rampColor } from './mood.js';
import { SpatialEngine } from './spatial-audio.js';
import * as sp from './spotify.js';
import * as dev from './devicefiles.js';
import { findPreview } from './preview.js';
import { reducedMotion } from './motion.js';
import { BANDS, MODES, autoTune, savedTaste, saveTaste } from './studio.js';

const $ = id => document.getElementById(id);
const R = 2.2; // sphere radius in the scene
const reduced = reducedMotion();

// ---------- the points ----------
// Directions use the listener's frame: front is -Z, right is +X, up is +Y.
function dir(azDeg, elDeg) {
  const a = THREE.MathUtils.degToRad(azDeg), e = THREE.MathUtils.degToRad(elDeg);
  return new THREE.Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a));
}
const CUBE_EL = 35.26; // a cube's corners sit 35.26° above and below the horizon

const LAYOUTS = {
  // The 8 corners of a cube, visited in a weave: around twice, swapping up and down.
  8: {
    note: 'Eight points at the corners of a cube. The song circles you twice, weaving between above and below.',
    points: [[45, 1], [135, -1], [225, 1], [315, -1], [45, -1], [135, 1], [225, -1], [315, 1]].map(([az, s]) => [az, s * CUBE_EL]),
  },
  // Two crowns of 8: an upper ring and a lower ring turned half a step, visited as a zigzag.
  16: {
    note: 'Sixteen points in two crowns of 8, the lower one turned half a step. The song zigzags between them on one slow lap.',
    points: [...Array(8)].flatMap((_, i) => [[i * 45, 35], [i * 45 + 22.5, -35]]),
  },
};

function describe(v) {
  const az = THREE.MathUtils.radToDeg(Math.atan2(v.x, -v.z));
  const el = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(v.y / v.length(), -1, 1)));
  const a = Math.abs(az);
  const side = a < 15 ? 'In front' : a > 165 ? 'Behind' : a < 70 ? (az > 0 ? 'Front right' : 'Front left') : a <= 110 ? (az > 0 ? 'Right' : 'Left') : (az > 0 ? 'Back right' : 'Back left');
  const height = el > 12 ? 'above you' : el < -12 ? 'below you' : 'at ear level';
  return `${side}, ${height}`;
}
const tri = (i, n) => 1 - Math.abs((2 * i) / n - 1); // calm -> intense -> calm around the lap
const colorFor = (i, n) => new THREE.Color().setRGB(...rampColor(tri(i, n)).map(c => c / 255), THREE.SRGBColorSpace);

// ---------- scene ----------
const canvas = $('orbit');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
const view = { theta: 0.35, phi: 1.2, dist: 9.2 }; // seen from behind and a little above

// Sphere: faint lattice plus the horizon and the front-back meridian, slightly brighter.
const world = new THREE.Group();
scene.add(world);
world.add(new THREE.Mesh(new THREE.SphereGeometry(R, 32, 20), new THREE.MeshBasicMaterial({ color: 0xb4bcdf, wireframe: true, transparent: true, opacity: 0.07, depthWrite: false })));
const ring = (rot, opacity) => {
  const pts = new THREE.EllipseCurve(0, 0, R, R, 0, Math.PI * 2).getPoints(128).map(p => new THREE.Vector3(p.x, p.y, 0));
  const l = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xdfe4ff, transparent: true, opacity }));
  l.rotation.set(...rot); world.add(l);
};
ring([Math.PI / 2, 0, 0], 0.3);   // horizon
ring([0, Math.PI / 2, 0], 0.16);  // front-back meridian
ring([0, 0, 0], 0.1);             // left-right meridian

// The listener: the wireframe brain with headphones, facing into the screen.
const head = new THREE.Group();
const headMat = new THREE.MeshBasicMaterial({ color: 0x9aa6dc, wireframe: true, transparent: true, opacity: 0.22, depthWrite: false });
[-1, 1].forEach(s => head.add(new THREE.Mesh(hemisphere(s), headMat)));
head.add(new THREE.Mesh(cerebellum(), headMat));
const phoneMat = new THREE.MeshBasicMaterial({ color: 0xf1f3ff, wireframe: true, transparent: true, opacity: 0.45 });
head.add(new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.06, 8, 64, Math.PI), phoneMat));
const cups = [-1, 1].map(s => {
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.3, 0.22, 24, 2), phoneMat);
  cup.rotation.z = Math.PI / 2; cup.position.set(s * 1.2, 0, 0); head.add(cup); return cup;
});
head.scale.setScalar(0.5);
head.rotation.y = Math.PI; // the brain model faces +Z; the listener faces -Z
world.add(head);

// Points, spokes, path, orb and trail are rebuilt when the layout changes.
let layer = null, nodes = [], curve = null, nodeU = [], labels = [];

function buildLayout(n) {
  if (layer) world.remove(layer);
  layer = new THREE.Group();
  world.add(layer);
  const L = LAYOUTS[n];
  nodes = L.points.map(([az, el], i) => ({ dir: dir(az, el), color: colorFor(i, n), az, el }));

  // Smooth closed path through every point, kept on the sphere's surface.
  curve = new THREE.CatmullRomCurve3(nodes.map(p => p.dir.clone()), true, 'centripetal');

  // Where along the path each point sits.
  nodeU = nodes.map(p => {
    let best = 0, bd = Infinity;
    for (let k = 0; k < 2000; k++) { const d = curve.getPointAt(k / 2000).normalize().distanceToSquared(p.dir); if (d < bd) { bd = d; best = k / 2000; } }
    return best;
  });

  const samples = 720;
  const pathPts = [], pathCols = [];
  for (let k = 0; k <= samples; k++) {
    const u = k / samples;
    pathPts.push(curve.getPointAt(u % 1).normalize().multiplyScalar(R));
    const c = colorAt(u % 1); pathCols.push(c.r, c.g, c.b);
  }
  const pathGeo = new THREE.BufferGeometry().setFromPoints(pathPts);
  pathGeo.setAttribute('color', new THREE.Float32BufferAttribute(pathCols, 3));
  layer.add(new THREE.Line(pathGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5 })));

  nodes.forEach((p, i) => {
    const pos = p.dir.clone().multiplyScalar(R);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 12), new THREE.MeshBasicMaterial({ color: p.color }));
    dot.position.copy(pos);
    const halo = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.115, 40), new THREE.MeshBasicMaterial({ color: p.color, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
    halo.position.copy(pos); halo.lookAt(0, 0, 0);
    const spoke = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), pos]), new THREE.LineBasicMaterial({ color: p.color, transparent: true, opacity: 0.12 }));
    layer.add(dot, halo, spoke);
    p.halo = halo; p.dot = dot;
  });

  // The sound: a glowing orb with a fading trail and a faint ray to your head.
  orb.material.color.copy(nodes[0].color);
  layer.add(orb, glow, trail, ray);

  // Labels and the path list.
  $('labels').innerHTML = nodes.map((_, i) => `<span class="node-label">${i + 1}</span>`).join('');
  labels = [...$('labels').children];
  $('points').innerHTML = nodes.map((p, i) => `<li><span class="sw" style="background:#${p.color.getHexString(THREE.SRGBColorSpace)}"></span><span class="pn">${i + 1}</span><span>${describe(p.dir)}</span></li>`).join('');
  $('mode-note').textContent = L.note;
  trailHist.length = 0;
}

function colorAt(u) {
  // Blend between the colours of the points either side of u.
  const n = nodes.length;
  let i = nodeU.length ? nodeU.findIndex((nu, k) => u < nu && (k === 0 || u >= nodeU[k - 1])) : Math.floor(u * n);
  if (nodeU.length) {
    if (i <= 0) { const a = n - 1, b = 0; const span = (1 - nodeU[a]) + nodeU[b]; const t = ((u - nodeU[a] + 1) % 1) / span; return nodes[a].color.clone().lerp(nodes[b].color, t); }
    const t = (u - nodeU[i - 1]) / (nodeU[i] - nodeU[i - 1]);
    return nodes[i - 1].color.clone().lerp(nodes[i].color, t);
  }
  const t = u * n - i;
  return colorFor(i % n, n).lerp(colorFor((i + 1) % n, n), t);
}

const orb = new THREE.Mesh(new THREE.SphereGeometry(0.11, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffffff }));
const glowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.25, 'rgba(255,255,255,.45)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();
const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
glow.scale.setScalar(0.9);
const TRAIL = 120;
const trailHist = [];
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(TRAIL * 3), 3));
trailGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(TRAIL * 3), 3));
const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const ray = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18 }));

// ---------- audio + state ----------
const engine = new SpatialEngine();
const st = { n: 8, lap: 12, dist: 1.8, phase: 0, dragging: null, lastNode: -1 };

const pathDir = u => curve.getPointAt(((u % 1) + 1) % 1).normalize();

// ---------- render loop ----------
const clock = new THREE.Clock();
const tmp = new THREE.Vector3();
let audioTick = 0, lastWhere = '';
function frame() {
  requestAnimationFrame(frame);
  if (document.hidden) { clock.getDelta(); return; } // audio keeps playing; skip drawing
  const dt = Math.min(clock.getDelta(), 0.05);
  const moving = st.kind === 'spotify' ? cable.playing : engine.playing;
  if (moving) st.phase = (st.phase + dt / st.lap) % 1;
  else if (!engine.buffer) st.phase = (st.phase + dt / (st.lap * 2.5)) % 1; // slow preview before a song is loaded

  const d = pathDir(st.phase);
  // 30 updates a second is plenty for smooth movement and keeps the audio thread light.
  audioTick += dt;
  if (audioTick >= 1 / 30) { audioTick = 0; engine.setPosition(d.x * st.dist, d.y * st.dist, d.z * st.dist); }

  const pos = d.clone().multiplyScalar(R);
  const level = engine.level();
  const col = colorAt(st.phase);
  orb.position.copy(pos); glow.position.copy(pos);
  orb.material.color.copy(col).lerp(new THREE.Color(1, 1, 1), 0.35);
  glow.material.color.copy(col);
  glow.scale.setScalar(0.75 + level * 1.6);
  orb.scale.setScalar(1 + level * 0.8);
  rayGeo.attributes.position.setXYZ(1, pos.x, pos.y, pos.z); rayGeo.attributes.position.needsUpdate = true;
  cups.forEach((c, i) => c.scale.setScalar(1 + level * 0.12 * (i === (d.x > 0 ? 1 : 0) ? 1.6 : 0.6)));

  // Trail: recent positions, fading toward the tail.
  const recycled = trailHist.length >= TRAIL ? trailHist.pop() : new THREE.Vector3();
  trailHist.unshift(recycled.copy(pos));
  const tp = trailGeo.attributes.position, tc = trailGeo.attributes.color;
  for (let k = 0; k < TRAIL; k++) {
    const p = trailHist[Math.min(k, trailHist.length - 1)];
    tp.setXYZ(k, p.x, p.y, p.z);
    const f = Math.pow(1 - k / TRAIL, 1.6);
    tc.setXYZ(k, col.r * f, col.g * f, col.b * f);
  }
  tp.needsUpdate = tc.needsUpdate = true;

  // Which point did we pass last?
  const cand = nodeU.map((u, i) => [((st.phase - u) % 1 + 1) % 1, i]).sort((a, b) => a[0] - b[0])[0];
  const last = cand ? cand[1] : 0;
  nodes.forEach((p, i) => {
    const near = Math.max(0, 1 - p.dir.distanceTo(d) / 0.6);
    p.halo.scale.setScalar(1 + near * 1.4);
    p.halo.material.opacity = 0.35 + near * 0.6;
  });
  if (last !== st.lastNode) {
    st.lastNode = last;
    $('where-title').textContent = `Passing point ${last + 1} of ${nodes.length}`;
    document.querySelectorAll('#points li').forEach((li, i) => li.toggleAttribute('data-active', i === last));
  }
  const where = describe(d);
  if (where !== lastWhere) { lastWhere = where; $('where').textContent = where; }

  // Camera orbit (slow drift when idle).
  if (!st.dragging && !reduced) view.theta += dt * 0.04;
  camera.position.setFromSphericalCoords(view.dist, view.phi, view.theta);
  camera.lookAt(0, -0.1, 0);

  // Number labels follow their points; ones on the far side fade.
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const camDir = camera.position.clone().normalize();
  nodes.forEach((p, i) => {
    tmp.copy(p.dir).multiplyScalar(R * 1.13).project(camera);
    const el = labels[i]; if (!el) return;
    const facing = p.dir.dot(camDir);
    el.style.transform = `translate(${(tmp.x * 0.5 + 0.5) * w}px, ${(-tmp.y * 0.5 + 0.5) * h}px) translate(-50%, -50%)`;
    el.style.opacity = (0.35 + 0.65 * (facing * 0.5 + 0.5)).toFixed(2);
    el.toggleAttribute('data-active', i === last);
  });

  updateTime();

  renderer.render(scene, camera);
}

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Full-screen canvas behind floating panels: centre the sphere in the open area.
  const wide = window.innerWidth >= 900;
  view.dist = Math.max(wide ? 9.2 : 8, 2.75 / (Math.tan(THREE.MathUtils.degToRad(18)) * (w / h))); // sphere + labels fit the width
  if (wide) camera.setViewOffset(w, h, Math.min(250, w * 0.2), 0, w, h);
  else camera.setViewOffset(w, h, 0, h * 0.2, w, h);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);

canvas.addEventListener('pointerdown', e => { st.dragging = { x: e.clientX, y: e.clientY, t: view.theta, p: view.phi }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', e => {
  if (!st.dragging) return;
  view.theta = st.dragging.t - (e.clientX - st.dragging.x) * 0.008;
  view.phi = THREE.MathUtils.clamp(st.dragging.p - (e.clientY - st.dragging.y) * 0.006, 0.35, 2.6);
});
canvas.addEventListener('pointerup', () => { st.dragging = null; });

// ---------- UI ----------
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let toastTimer;
function toast(msg, { error = false, html = false, ms = 4500 } = {}) {
  const t = $('toast');
  t.classList.toggle('error', error);
  html ? (t.innerHTML = msg) : (t.textContent = msg);
  t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function setPlayingUI(on) {
  $('play').setAttribute('aria-pressed', String(on));
  $('play').setAttribute('aria-label', on ? 'Pause' : 'Play');
}

// What kind of audio is playing: 'full' (your file), 'spotify' (full song through the cable), 'preview', 'demo'.
const KINDS = { full: 'Full song · 8D', spotify: 'Full song · Spotify', preview: 'Preview · 30 s', demo: 'Demo' };
function setKind(kind) {
  const k = $('song-kind');
  k.hidden = !kind; k.textContent = KINDS[kind] || ''; k.dataset.kind = kind || '';
  st.kind = kind;
}

function songLoaded(kind) {
  $('song-name').textContent = engine.name;
  $('song-sub').textContent = engine.isDemo ? 'A 16-second loop made in your browser' : `${fmt(engine.duration)} long`;
  ['play', 'seek', 'bypass', 'save'].forEach(id => { $(id).disabled = false; });
  $('t-total').textContent = fmt(engine.duration);
  $('save-note').textContent = '';
  st.phase = 0;
  setKind(kind);
  setPlayingUI(false);
  if (!engine.isDemo) restoreTaste(engine.name);
}

/** Add songs from this device: they are kept in the browser, listed under My music, and the first one plays. */
async function addFiles(files) {
  files = [...(files || [])].filter(f => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i.test(f.name));
  if (!files.length) return toast('Pick audio files: MP3, M4A, WAV, FLAC or OGG.', { error: true });
  $('song-name').textContent = files.length > 1 ? `Adding ${files.length} songs…` : `Adding ${files[0].name}…`;
  const ids = [];
  for (const f of files) { try { ids.push(await dev.addFile(f)); } catch { toast(`Couldn't store ${f.name} on this device (storage is full?).`, { error: true }); } }
  dev.keepStored();
  await loadMusic(false);
  await showTab('music');
  if (!ids.length) return;
  const first = lib.list.findIndex(t => t.localId === 'dev:' + ids[0]);
  if (first >= 0) playFromList(first);
  else $('song-name').textContent = 'Pick a song below';
  if (files.length > 1) toast(`${files.length} songs added. They stay on this device for next time.`);
}

function updateLabels() {
  $('speed-out').textContent = `one lap every ${st.lap} s`;
  $('dist-out').textContent = `${st.dist.toFixed(1)} m from your head`;
  $('room-out').textContent = `${Math.round(engine.roomAmount * 100)}%`;
  $('save').textContent = `Save ${st.n}D version as WAV`;
}

// Seek bar and times, called from the render loop.
function updateTime() {
  if (st.seeking) return;
  if (st.kind === 'spotify' && cable.durationMs) {
    const pos = cable.progressMs + (cable.playing ? performance.now() - cable.progressAt : 0);
    $('seek').value = Math.min(1, pos / cable.durationMs);
    $('t-now').textContent = fmt(pos / 1000); $('t-total').textContent = fmt(cable.durationMs / 1000);
  } else if (engine.buffer) {
    $('seek').value = engine.duration ? engine.currentTime / engine.duration : 0;
    $('t-now').textContent = fmt(engine.currentTime);
  }
}

$('file').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
$('add-file').onclick = () => $('file').click();
// Drop a file anywhere on the panel.
const rail = document.querySelector('.rail');
['dragenter', 'dragover'].forEach(ev => rail.addEventListener(ev, e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); rail.classList.add('over'); } }));
['dragleave', 'drop'].forEach(ev => rail.addEventListener(ev, e => { e.preventDefault(); rail.classList.remove('over'); }));
rail.addEventListener('drop', e => addFiles(e.dataTransfer.files));

$('demo').onclick = async () => {
  stopCableSong();
  engine.ensure().resume(); // unlock audio inside the tap
  $('song-name').textContent = 'Making the demo beat…';
  await new Promise(r => setTimeout(r, 30));
  engine.loadDemo(); songLoaded('demo'); await engine.play(); setPlayingUI(true);
};

$('play').onclick = async () => {
  if (st.kind === 'spotify') {
    const on = !cable.playing;
    try { await (on ? sp.resume() : sp.pause()); cable.playing = on; cable.progressAt = performance.now(); setPlayingUI(on); }
    catch (e) { toast(e.message, { error: true }); }
    return;
  }
  if (engine.playing) { engine.pause(); setPlayingUI(false); }
  else { await engine.play(); setPlayingUI(true); }
};

$('seek').addEventListener('input', e => {
  st.seeking = true;
  const total = st.kind === 'spotify' ? cable.durationMs / 1000 : engine.duration;
  $('t-now').textContent = fmt(e.target.value * total);
});
$('seek').addEventListener('change', e => {
  if (st.kind === 'spotify') {
    const ms = e.target.value * cable.durationMs;
    sp.seek(ms).then(() => { cable.progressMs = ms; cable.progressAt = performance.now(); }).catch(err => toast(err.message, { error: true }));
  } else {
    const t = e.target.value * engine.duration;
    engine.seek(t); st.phase = (t / st.lap) % 1;
  }
  st.seeking = false;
});

document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', e => {
  st.n = Number(e.target.value);
  buildLayout(st.n); st.lastNode = -1; updateLabels(); renderLib();
}));
$('speed').addEventListener('input', e => { st.lap = Number(e.target.value); updateLabels(); });
$('dist').addEventListener('input', e => { st.dist = Number(e.target.value); updateLabels(); });
$('room').addEventListener('input', e => { engine.setRoom(Number(e.target.value)); updateLabels(); rememberTaste(); });
$('bypass').addEventListener('change', e => engine.setBypass(e.target.checked));

$('save').onclick = async () => {
  const btn = $('save');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = `Making the ${st.n}D version…`;
  $('save-note').textContent = engine.duration > 120 ? 'A full song takes a few seconds. Keep this tab open.' : '';
  try {
    const lap = st.lap, dist = st.dist, n = st.n;
    const blob = await engine.render(t => { const d = pathDir(t / lap); return [d.x * dist, d.y * dist, d.z * dist]; });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `${engine.name} (${n}D).wav` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    $('save-note').textContent = `Saved "${engine.name} (${n}D).wav" (${(blob.size / 1048576).toFixed(1)} MB) to your downloads.`;
  } catch (e) {
    toast(e.message || "Couldn't make the file. Try a shorter song.", { error: true });
    $('save-note').textContent = '';
  } finally { btn.textContent = label; btn.disabled = st.kind === 'spotify'; }
};

// Tint the page from the current path colour.
setInterval(() => {
  if (!nodes.length) return;
  const c = colorAt(st.phase), c2 = colorAt((st.phase + 0.15) % 1);
  document.documentElement.style.setProperty('--vibe-a', `#${c.getHexString(THREE.SRGBColorSpace)}`);
  document.documentElement.style.setProperty('--vibe-b', `#${c2.getHexString(THREE.SRGBColorSpace)}`);
}, 400);

// ---------- views: Spatial (where it moves) and Studio (how it sounds) ----------
function setView(v) {
  v = v === 'studio' ? 'studio' : 'spatial';
  $('view-spatial').hidden = v !== 'spatial';
  $('view-studio').hidden = v !== 'studio';
  document.querySelectorAll('.tabs [data-view]').forEach(a => a.toggleAttribute('aria-current', a.dataset.view === v));
  document.querySelectorAll('.tabs [data-view]').forEach(a => { if (a.dataset.view === v) a.setAttribute('aria-current', 'page'); });
  document.title = v === 'studio' ? 'Cortex FM Studio' : 'Cortex FM Spatial';
  document.querySelector('.rail').scrollTop = 0;
}
document.querySelectorAll('.tabs [data-view]').forEach(a => a.addEventListener('click', e => {
  e.preventDefault();
  history.replaceState(null, '', '#' + a.dataset.view);
  setView(a.dataset.view);
}));
window.addEventListener('hashchange', () => setView(location.hash.slice(1)));

// ---------- Studio ----------
const studioUI = { mode: 'flat', trackFacts: null, saveTimer: null };
const fmtDb = v => `${v > 0 ? '+' : ''}${Number(v).toFixed(v % 1 ? 1 : 0)} dB`;

function renderStudioModes() {
  const modes = Object.entries(MODES).map(([id, m]) => `<button type="button" class="chip" data-mode="${id}" role="radio" aria-checked="${studioUI.mode === id}">${m.label}</button>`);
  if (studioUI.mode === 'auto' || studioUI.mode === 'custom') modes.push(`<button type="button" class="chip" data-mode="${studioUI.mode}" role="radio" aria-checked="true">${studioUI.mode === 'auto' ? 'Auto' : 'Custom'}</button>`);
  $('studio-modes').innerHTML = modes.join('');
}

function renderBands() {
  const s = engine.studio.settings;
  $('bands').innerHTML = BANDS.map(b => `<label class="band"><span>${b.label}<output>${fmtDb(s.bands[b.id])}</output></span>
    <input type="range" min="-12" max="12" step="0.5" value="${s.bands[b.id]}" data-band="${b.id}" aria-label="${b.label}, ${b.freq < 1000 ? b.freq + ' Hz' : b.freq / 1000 + ' kHz'}"></label>`).join('');
  $('vol').value = s.volume; $('punch').value = s.punch; $('drive').value = s.drive;
  $('vol-out').textContent = fmtDb(s.volume);
  $('punch-out').textContent = s.punch < 0.05 ? 'off' : `${Math.round(s.punch * 100)}%`;
  $('drive-out').textContent = s.drive < 0.05 ? 'off' : `${Math.round(s.drive / 0.6 * 100)}%`;
}

function applyRoom(room) {
  if (typeof room !== 'number') return;
  engine.setRoom(room); $('room').value = room; updateLabels();
}

function applyStudio(settings, mode) {
  studioUI.mode = mode;
  engine.studio.apply(settings);
  applyRoom(settings.room);
  renderStudioModes(); renderBands();
  rememberTaste();
}

function rememberTaste() {
  if (!engine.name || engine.isDemo) return;
  clearTimeout(studioUI.saveTimer);
  const name = engine.name;
  studioUI.saveTimer = setTimeout(() => { saveTaste(name, studioUI.mode, { ...engine.studio.settings, room: engine.roomAmount }); renderLib(); }, 600);
}

/** When a song starts, bring back the sound you chose for it last time. */
function restoreTaste(name) {
  const t = savedTaste(name);
  if (!t) return false;
  studioUI.mode = t.mode;
  engine.studio.apply(t.settings);
  applyRoom(t.settings.room);
  renderStudioModes(); renderBands();
  toast(`Using your saved ${t.mode === 'auto' ? 'Auto' : MODES[t.mode]?.label || 'custom'} sound for this song.`);
  return true;
}

$('studio-modes').addEventListener('click', e => {
  const b = e.target.closest('[data-mode]'); if (!b || !MODES[b.dataset.mode]) return;
  applyStudio(structuredClone(MODES[b.dataset.mode]), b.dataset.mode);
  $('studio-note').textContent = b.dataset.mode === 'xbass' ? 'Extreme Bass is loud in the low end. A limiter keeps it safe, but start with the volume low.' : `${MODES[b.dataset.mode].label} mode. Fine-tune any band below.`;
});
$('bands').addEventListener('input', e => {
  const id = e.target.dataset.band; if (!id) return;
  const s = structuredClone(engine.studio.settings);
  s.bands[id] = Number(e.target.value);
  e.target.previousElementSibling.querySelector('output').textContent = fmtDb(s.bands[id]);
  studioUI.mode = 'custom';
  engine.studio.apply(s); renderStudioModes(); rememberTaste();
});
[['vol', 'volume'], ['punch', 'punch'], ['drive', 'drive']].forEach(([el, key]) => $(el).addEventListener('input', e => {
  const s = structuredClone(engine.studio.settings);
  s[key] = Number(e.target.value);
  studioUI.mode = 'custom';
  engine.studio.apply(s); renderStudioModes(); renderBands(); rememberTaste();
}));
$('reset-studio').onclick = () => { applyStudio(structuredClone(MODES.flat), 'flat'); $('studio-note').textContent = 'Original sound. Pick a mode or press Auto-tune.'; };

$('auto').onclick = async () => {
  if (!engine.playing) return toast('Play a song first, so Auto-tune can listen to it.', { error: true });
  const btn = $('auto');
  btn.disabled = true;
  const base = MODES[studioUI.mode] && studioUI.mode !== 'flat' ? studioUI.mode : null;
  try {
    const r = await autoTune(engine.studio, { baseMode: base, track: studioUI.trackFacts, onProgress: p => { btn.textContent = `Listening… ${Math.round(p * 100)}%`; } });
    studioUI.mode = 'auto';
    applyRoom(r.settings.room);
    renderStudioModes(); renderBands(); rememberTaste();
    const moved = BANDS.map(b => [b.label, r.settings.bands[b.id] - MODES[r.mode].bands[b.id]]).filter(([, d]) => Math.abs(d) >= 1.5)
      .map(([l, d]) => `${l.toLowerCase()} ${d > 0 ? '+' : ''}${d} dB`);
    $('studio-note').textContent = `Auto-tune chose ${MODES[r.mode].label}${r.reason ? ` (${r.reason})` : ''}.` + (moved.length ? ` It also evened out the mix: ${moved.join(', ')}.` : ' The mix was already balanced.');
  } catch (e) { toast(e.message, { error: true }); }
  finally { btn.disabled = false; btn.textContent = 'Auto-tune'; }
};

// EQ curve over the live spectrum.
const eqCanvas = $('eq-canvas'), eqCtx = eqCanvas.getContext('2d');
const EQ_POINTS = 160;
const eqFreqs = new Float32Array(EQ_POINTS).map((_, i) => 20 * Math.pow(1000, i / (EQ_POINTS - 1)));
let eqLast = 0;
function drawEq(now) {
  requestAnimationFrame(drawEq);
  if ($('view-studio').hidden || document.hidden || now - eqLast < 50) return;
  eqLast = now;
  const dpr = Math.min(devicePixelRatio, 1.5), w = eqCanvas.clientWidth, h = eqCanvas.clientHeight;
  if (!w) return;
  if (eqCanvas.width !== Math.round(w * dpr)) { eqCanvas.width = Math.round(w * dpr); eqCanvas.height = Math.round(h * dpr); }
  const g = eqCtx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const cs = getComputedStyle(document.documentElement);
  const colA = cs.getPropertyValue('--vibe-a').trim() || '#3b5bdb', colB = cs.getPropertyValue('--vibe-b').trim() || '#20c997';
  g.strokeStyle = 'rgba(214,222,255,.12)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
  const xOf = f => Math.log(f / 20) / Math.log(1000) * w;
  BANDS.forEach(b => { g.beginPath(); g.moveTo(xOf(b.freq), 4); g.lineTo(xOf(b.freq), h - 4); g.stroke(); });
  if (!engine.ctx) return;
  if (engine.playing) {
    const an = engine.studio.analyser, data = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(data);
    const hz = engine.ctx.sampleRate / an.fftSize;
    g.fillStyle = 'rgba(214,222,255,.10)';
    for (let x = 0; x < w; x += 3) {
      const f = 20 * Math.pow(1000, x / w), v = data[Math.min(data.length - 1, Math.round(f / hz))] / 255;
      g.fillRect(x, h - v * h * 0.9, 2, v * h * 0.9);
    }
  }
  const resp = engine.studio.response(eqFreqs);
  const grad = g.createLinearGradient(0, 0, w, 0); grad.addColorStop(0, colA); grad.addColorStop(1, colB);
  g.strokeStyle = grad; g.lineWidth = 2.5; g.beginPath();
  resp.forEach((m, i) => { const db = 20 * Math.log10(m), x = i / (EQ_POINTS - 1) * w, y = h / 2 - db / 15 * (h / 2 - 6); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.stroke();
}

// ---------- full Spotify songs through the virtual audio cable ----------
// Spotify desktop app → "CABLE Input" (set in Windows) → "CABLE Output" → Cortex FM (8D + Studio) → your headphones.
const CABLE_KEY = 'cfm.cable';
// The virtual cable needs Chrome or Edge on a Windows/Mac computer. Phones and tablets use files and previews.
const canCable = !!navigator.mediaDevices?.getUserMedia && !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) && !(navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)) && window.innerWidth >= 700;
if (!canCable) $('cable').hidden = true;
const cable = { stream: null, deviceId: null, label: '', ready: false, playing: false, progressMs: 0, durationMs: 0, progressAt: 0, poll: null, trackId: null };

async function findCable() {
  const list = await navigator.mediaDevices.enumerateDevices();
  return list.find(d => d.kind === 'audioinput' && /cable output|vb-audio/i.test(d.label)) || null;
}

/** Ask for the cable once; Chrome remembers the permission for this site. */
async function connectCable(interactive) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot take audio input. Use Chrome or Edge on your computer.');
  let dev = await findCable().catch(() => null);
  if (!dev || !dev.label) {
    if (!interactive) return false;
    // A first permission prompt reveals device names.
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach(t => t.stop());
    dev = await findCable();
  }
  if (!dev) throw new Error('No virtual cable found. Install VB-Audio Virtual Cable, restart the PC, then press Connect again.');
  cable.stream?.getTracks().forEach(t => t.stop());
  cable.stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: dev.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },
  });
  cable.deviceId = dev.deviceId; cable.label = dev.label; cable.ready = true;
  try { localStorage.setItem(CABLE_KEY, '1'); } catch { /* ignore */ }
  renderCable();
  return true;
}

function renderCable() {
  const on = cable.ready;
  $('cable-state').textContent = on ? 'Connected. Full Spotify songs play here in 8D.' : 'Not set up yet.';
  $('cable-state').dataset.on = on;
  $('cable-connect').textContent = on ? 'Reconnect' : 'Connect the cable';
  $('cable-steps').hidden = on;
}

async function playSpotifyFull(list, i) {
  const pc = await sp.computerDevice();
  if (!pc) throw new Error('Open the Spotify app on this computer first (any song, then pause). Then pick the song again.');
  engine.ensure().resume();
  engine.startStream(cable.stream);
  setKind('spotify');
  const t = list[i];
  $('song-name').textContent = `${t.name} – ${t.mainArtist || t.artist}`;
  $('song-sub').textContent = `Full song from Spotify on ${pc.name}, moving in ${st.n}D`;
  ['play', 'seek', 'bypass'].forEach(id => { $(id).disabled = false; });
  $('save').disabled = true;
  $('save-note').textContent = 'Full Spotify songs play live, so they can\'t be saved. Saving works for your files.';
  // Play the rest of the list too, so Spotify moves on by itself.
  const uris = $('autoplay').checked ? list.slice(i).map(x => x.uri).filter(Boolean) : [t.uri];
  await sp.play(uris, 0, pc);
  engine.name = $('song-name').textContent;
  cable.playing = true; cable.trackId = t.id; cable.progressMs = 0; cable.durationMs = t.duration || 0; cable.progressAt = performance.now();
  setPlayingUI(true);
  studioUI.trackFacts = t; sp.attachVibes([t]).catch(() => {});
  restoreTaste(engine.name);
  startCablePoll();
}

// Follow Spotify: song changes, pauses, position, so the bar and the Studio sound keep up.
function startCablePoll() {
  clearInterval(cable.poll);
  cable.poll = setInterval(async () => {
    if (st.kind !== 'spotify') return clearInterval(cable.poll);
    const np = await sp.nowPlaying().catch(() => null);
    if (!np) return;
    cable.playing = np.isPlaying; setPlayingUI(np.isPlaying);
    cable.progressMs = np.progress || 0; cable.durationMs = np.duration || cable.durationMs; cable.progressAt = performance.now();
    if (np.track && np.id !== cable.trackId) {
      cable.trackId = np.id;
      engine.name = `${np.track.name} – ${np.track.mainArtist}`;
      $('song-name').textContent = engine.name;
      studioUI.trackFacts = np.track;
      if (!restoreTaste(engine.name)) { /* keep the current sound */ }
      const idx = (lib.playingList || []).findIndex(x => x.id === np.id);
      if (idx >= 0) { lib.current = idx; renderLib(); }
    }
  }, 2500);
}

function stopCableSong() {
  if (st.kind !== 'spotify') return;
  clearInterval(cable.poll);
  sp.pause().catch(() => {});
  engine.stopStream();
  cable.playing = false;
}

$('cable-connect').onclick = async () => {
  try { await connectCable(true); toast('Cable connected. Pick any Spotify song: it plays in full, in 8D.'); }
  catch (e) { toast(e.name === 'NotAllowedError' ? 'Microphone permission was blocked. Allow it in the address bar, then try again.' : e.message, { error: true, ms: 8000 }); renderCable(); }
};

// ---------- your songs ----------
const lib = { tab: 'music', lists: {}, list: [], current: -1, playingList: null, seq: 0, music: [] };
const norm = s => (s || '').toLowerCase().replace(/\s*[([].*?[)\]]/g, '').replace(/\s+-\s+.*$/, '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Is this Spotify song in your music folder? Title must match; artist or file name must agree. */
function localMatch(t) {
  if (t.localId) return lib.music.find(m => m.id === t.localId);
  const title = norm(t.name);
  if (title.length < 2) return null;
  const artists = (t.artist || '').split(',').map(norm).filter(Boolean);
  return lib.music.find(m => {
    const mt = norm(m.title), file = norm(m.file);
    const titleOk = mt === title || (title.length > 3 && (mt.startsWith(title) || file.startsWith(title) || file.includes(` ${title} `)));
    if (!titleOk) return false;
    const ma = norm(m.artist) + ' ' + file;
    return !artists.length || artists.some(a => ma.includes(a.split(' ')[0])) || mt === title;
  }) || null;
}

function sessionFromMood() {
  try { return JSON.parse(sessionStorage.getItem('cfm.studioQueue') || 'null'); } catch { return null; }
}
const styleOf = name => {
  const s = savedTaste(name);
  return s ? (s.mode === 'auto' ? 'Auto' : s.mode === 'custom' ? 'Custom' : MODES[s.mode]?.label) : '';
};

function rowKind(t) {
  if (t.localId || localMatch(t)) return 'full';
  if (t.uri && cable.ready) return 'spotify';
  return 'preview';
}

function renderLib() {
  const list = lib.list, same = lib.playingList === list;
  $('lib-list').innerHTML = list.map((t, i) => {
    const on = same && i === lib.current;
    const kind = rowKind(t);
    const style = styleOf(`${t.name} – ${t.mainArtist || t.artist}`);
    const badge = kind === 'full' ? 'Full' : kind === 'spotify' ? 'Full' : 'Preview';
    return `<li class="result${on ? ' on' : ''}">
      <span class="r-art" style="${t.art ? `background-image:url('${esc(t.art)}')` : ''}"></span>
      <span class="t"><span class="name">${esc(t.name)}</span><span class="by"><em class="badge" data-kind="${kind}">${badge}</em>${esc(t.artist || 'Unknown artist')}${style ? ` · <em class="style-tag">${esc(style)}</em>` : ''}</span></span>
      ${t.device ? `<button class="icon-btn small" type="button" data-remove="${i}" aria-label="Remove ${esc(t.name)} from this device"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>` : ''}
      <button class="ghost small" type="button" data-i="${i}" ${on ? 'aria-pressed="true"' : ''}>${on ? `Playing ${st.n}D` : `Play ${st.n}D`}</button></li>`;
  }).join('');
}

async function loadMusic(rescan) {
  let server = [];
  try {
    const r = await fetch('/api/music' + (rescan ? '?rescan=1' : ''));
    const data = r.ok && (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
    if (data) { server = data.songs || []; lib.hasServer = true; }
  } catch { /* no PC server: a hosted copy or a phone */ }
  const onDevice = (await dev.listFiles()).map(f => ({ id: 'dev:' + f.id, devId: f.id, device: true, title: f.title, artist: f.artist, file: f.name.replace(/\.[^.]+$/, '') }));
  lib.music = [...server, ...onDevice];
  lib.lists.music = lib.music.map(m => ({ id: 'local:' + m.id, localId: m.id, device: !!m.device, name: m.title, artist: m.artist, mainArtist: (m.artist || '').split(',')[0] }));
}

async function showTab(tab) {
  lib.tab = tab;
  const radio = document.querySelector(`input[name=lib][value="${tab}"]`);
  if (radio) radio.checked = true;
  $('spot').hidden = tab !== 'search';
  if (tab === 'music') {
    lib.list = lib.lists.music || [];
    const where = lib.hasServer ? 'your Music and Downloads folders and this device' : 'this device';
    $('lib-note').innerHTML = lib.list.length
      ? `${lib.list.length} ${lib.list.length === 1 ? 'song' : 'songs'} from ${where}. They play in full, in 8D/16D, with your Studio sound.${lib.hasServer ? ' <button class="linkish" type="button" id="rescan">Look again</button>' : ''}`
      : `Press <b>Add songs</b> and pick audio files from this device. They play in full, in 8D/16D, and stay here for next time, even offline.`;
  } else if (tab === 'session') {
    const q = sessionFromMood();
    lib.list = q?.tracks || [];
    $('lib-note').textContent = q ? `"${q.title}" from your Mood tab, ${lib.list.length} songs.` : 'No Mood session yet. Build one on the Mood tab and press Style in Studio.';
  } else if (tab === 'top') {
    $('lib-note').textContent = 'Loading your top tracks…';
    lib.lists.top ||= await sp.topTracks('short_term').then(a => a.length ? a : sp.topTracks('medium_term')).catch(() => []);
    lib.list = lib.lists.top;
    $('lib-note').textContent = lib.list.length ? 'Your most played songs lately.' : "Couldn't load your top tracks.";
  } else {
    lib.list = lib.lists.search || [];
    $('lib-note').textContent = lib.list.length ? '' : 'Search any song or artist on Spotify.';
    setTimeout(() => $('spot-search').focus(), 50);
  }
  renderLib();
}

// The simple rule for every song you pick:
//   1. in your music folder  → the full file, in 8D/16D (and it can be saved)
//   2. cable connected       → the full song from Spotify, live in 8D/16D
//   3. otherwise             → the 30-second preview, in 8D/16D
async function playFromList(i) {
  const list = lib.list, t = list[i];
  if (!t) return;
  engine.ensure().resume(); // unlock audio inside the tap
  lib.current = i; lib.playingList = list; renderLib();
  const kind = rowKind(t);
  $('song-name').textContent = `Loading ${t.name}…`;
  try {
    if (kind === 'full') {
      if (st.kind === 'spotify') stopCableSong();
      const m = localMatch(t);
      const who = t.mainArtist || t.artist || m.artist;
      const label = who ? `${t.name} – ${who}` : t.name;
      if (m.device) { await engine.loadFile(await dev.getFile(m.devId)); engine.name = label; }
      else await engine.loadUrl(`/api/music/file/${encodeURIComponent(m.id)}`, label);
      engine.loop = !$('autoplay').checked;
      studioUI.trackFacts = t;
      songLoaded('full');
      $('song-sub').textContent = `Full song from ${m.device ? 'this device' : 'your music folder'} (${fmt(engine.duration)})`;
      await engine.play(); setPlayingUI(true);
    } else if (kind === 'spotify') {
      await playSpotifyFull(list, i);
    } else {
      if (st.kind === 'spotify') stopCableSong();
      const user = await sp.me().catch(() => null);
      const found = await findPreview(t.name, t.artist, user?.country || 'US');
      if (!found.found) throw new Error(`"${t.name}" has no free preview. ${canCable ? 'Connect the cable to play it in full.' : 'Add the song file to play it in full.'}`);
      await engine.loadUrl(found.url, `${t.name} – ${t.mainArtist || t.artist}`);
      engine.loop = !$('autoplay').checked;
      studioUI.trackFacts = t; sp.attachVibes([t]).catch(() => {});
      songLoaded('preview');
      $('song-sub').textContent = canCable ? 'Only a 30-second preview. Connect the cable for the full song.' : 'Only a 30-second preview. Add the song file to play it in full.';
      await engine.play(); setPlayingUI(true);
    }
    renderLib();
  } catch (e) {
    $('song-name').textContent = 'Pick a song below';
    toast(e.message, { error: true, ms: 7000 });
  }
}

engine.onEnded = () => {
  setPlayingUI(false);
  const list = lib.playingList;
  if ($('autoplay').checked && list && lib.current + 1 < list.length) { lib.list = list; playFromList(lib.current + 1); }
};
$('autoplay').addEventListener('change', e => { if (engine.buffer && !engine.isDemo) engine.loop = !e.target.checked; });
$('lib-list').addEventListener('click', async e => {
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    const t = lib.list[Number(rm.dataset.remove)];
    if (t?.localId?.startsWith('dev:')) { await dev.removeFile(t.localId.slice(4)); await loadMusic(false); await showTab(lib.tab); toast(`Removed ${t.name} from this device.`); }
    return;
  }
  const b = e.target.closest('[data-i]'); if (b) playFromList(Number(b.dataset.i));
});
$('lib-note').addEventListener('click', async e => { if (e.target.id === 'rescan') { await loadMusic(true); showTab('music'); } });
document.querySelectorAll('input[name=lib]').forEach(r => r.addEventListener('change', e => showTab(e.target.value)));

async function search(q) {
  const seq = ++lib.seq;
  if (!q.trim()) { lib.lists.search = []; if (lib.tab === 'search') { lib.list = []; renderLib(); } return; }
  try {
    const found = await sp.searchTracks(q);
    if (seq !== lib.seq) return;
    lib.lists.search = found;
    if (lib.tab === 'search') { lib.list = found; $('lib-note').textContent = found.length ? '' : `No songs found for "${q}".`; renderLib(); }
  } catch (e) { toast(e.message || "Spotify search didn't work. Try again.", { error: true }); }
}
let searchDeb;
$('spot-search').addEventListener('input', e => { clearTimeout(searchDeb); searchDeb = setTimeout(() => search(e.target.value), 350); });
$('spot').addEventListener('submit', e => { e.preventDefault(); search($('spot-search').value); });

// ---------- start ----------
buildLayout(8);
updateLabels();
resize();
requestAnimationFrame(frame);
engine.ensure();
renderStudioModes(); renderBands();
requestAnimationFrame(drawEq);
setView(location.hash.slice(1));
renderCable();
(async () => {
  await loadMusic(false);
  const connected = await sp.restore();
  if (canCable && localStorage.getItem(CABLE_KEY) === '1') connectCable(false).catch(() => {}); // reconnect quietly if allowed before
  if (!connected) {
    document.querySelectorAll('input[name=lib]:not([value=music])').forEach(r => { r.disabled = true; });
  }
  await showTab(sessionFromMood() && location.hash === '#queue' ? 'session' : 'music');
})();
