import { readMood, sequence, SHORTCUTS, rampColor, vibeIndex, rgb, vibeColor, DEFAULT_FILTERS, filteredOut, discoverQueries } from './mood.js';
import * as sp from './spotify.js';
import { DEMO_TRACKS } from './demo.js';
import { reducedMotion, motionPref, setMotionPref } from './motion.js';
import { savedTaste, MODES as STUDIO_MODES } from './studio.js';

const $ = id => document.getElementById(id);
const pref = {
  get: (k, d) => { try { return localStorage.getItem('cfm.pref.' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('cfm.pref.' + k, v); } catch { /* ignore */ } },
  json: (k, d) => { try { return JSON.parse(localStorage.getItem('cfm.pref.' + k)) ?? d; } catch { return d; } },
};

// Where songs can come from. `scope` = the Spotify permission it needs.
const SOURCES = [
  { id: 'top', label: 'Your top tracks', on: true },
  { id: 'liked', label: 'Liked Songs', scope: 'user-library-read', on: true },
  { id: 'playlists', label: 'Your playlists', on: true },
  { id: 'artists', label: 'Favourite artists', on: true },
  { id: 'recent', label: 'Recently played', scope: 'user-read-recently-played', on: false },
  { id: 'discover', label: 'New finds for this mood', on: true },
];

const state = {
  connected: sp.isConnected(),
  user: null,
  pools: {},            // source id (or discover query key) -> tracks
  vibed: new Map(),     // track id -> vibe fields, so each song is measured once
  reading: null,
  session: [],
  index: 0,
  playing: false,
  demoTimer: null,
  pollTimer: null,
  web: null,
  webReady: false,
  seed: 1,
  sources: pref.json('sources', SOURCES.filter(s => s.on).map(s => s.id)),
  filters: { ...DEFAULT_FILTERS, length: 18, ...pref.json('filters', {}) },
};

let brain = null;

// ---------- feedback ----------
let toastTimer;
function toast(msg, { error = false, html = false, ms = 4200 } = {}) {
  const t = $('toast');
  t.classList.toggle('error', error);
  html ? (t.innerHTML = msg) : (t.textContent = msg);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
const hideToast = () => $('toast').classList.remove('show');

function explain(err) {
  if (err?.reason === 'PREMIUM_REQUIRED') return 'Playback control needs Spotify Premium. You can still save sessions as playlists.';
  if (err?.reason === 'NO_ACTIVE_DEVICE' || err?.reason === 'DEVICE_RESTRICTED' || err?.reason === 'PLAYLIST_FORBIDDEN') return err.message;
  if (err?.reason === 'SESSION_ENDED' || err?.reason === 'NOT_CONNECTED') return 'Your Spotify login ended. Log in again to keep going.';
  if (err?.status === 404 && /device/i.test(err.message)) return 'That Spotify device went away. Open Spotify on your phone, then press Play again.';
  if (err?.status === 403 && /restriction/i.test(err.message)) return 'Spotify on that device refused the command. Open Spotify on your phone, play any song for a second, then press Play here again.';
  if (err?.status === 403) return 'Spotify refused that request. If your Spotify app is in development mode, add your account under User Management in the developer dashboard.';
  if (err?.status === 429) return 'Spotify is busy. Wait a few seconds and try again.';
  return err?.message || 'Something went wrong. Try again.';
}

function handleError(e, opts) {
  if (e?.reason === 'SESSION_ENDED' || e?.reason === 'NOT_CONNECTED') signedOut();
  toast(explain(e), { error: true, ms: 7000, ...opts });
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- vibe colour on the whole screen ----------
function paintVibe(track) {
  const t = vibeIndex(track);
  const a = rgb(rampColor(t)), b = rgb(rampColor(Math.min(1, t + 0.18)));
  document.documentElement.style.setProperty('--vibe-a', a);
  document.documentElement.style.setProperty('--vibe-b', b);
  brain?.setVibe(track, a, b);
  $('readout-title').textContent = `${track.name} · ${track.artist}`;
  $('fig-energy').textContent = track.energy.toFixed(2);
  $('fig-mood').textContent = track.valence.toFixed(2);
  $('fig-tempo').textContent = `${track.tempo} bpm`;
  const note = $('fig-note');
  note.hidden = false;
  note.textContent = track.sample ? 'Sample song, values set by hand'
    : track.measured ? `Energy from measured loudness (${track.gain} dB)${track.genres?.length ? `, ${track.genres.slice(0, 2).join(' / ')}` : ''}. Mood estimated.`
    : 'Estimated from the title. No loudness data for this song.';
}

// ---------- account + settings ----------
function renderAccount() {
  const btn = $('account');
  btn.classList.toggle('on', state.connected);
  btn.innerHTML = `<span class="dot"></span>${state.connected ? escapeHtml(state.user?.name || 'Spotify') : 'Connect Spotify'}`;
  btn.setAttribute('aria-label', state.connected ? `Logged in to Spotify as ${state.user?.name || 'you'}. Open settings.` : 'Log in with Spotify');
  $('connect').textContent = state.connected ? 'Log in again' : 'Log in with Spotify';
  $('disconnect').hidden = !state.connected;
  $('save').hidden = !state.connected;
  $('find').hidden = !state.connected;
  $('check').hidden = !state.connected;
  $('player-status').textContent = !state.connected ? '' :
    state.webReady ? 'Plays right here in this browser (device "Cortex FM"), or on your open Spotify app.' :
    'Plays on your open Spotify app (phone or computer). Sessions go into a private playlist called "Cortex FM · Now playing".';
  renderFilters();
}

function login() { sp.login().catch(e => handleError(e)); }

function signedOut(everywhere = false) {
  sp.logout(everywhere);
  state.web?.disconnect?.(); state.web = null; state.webReady = false;
  state.connected = false; state.user = null; state.pools = {};
  stopPolling();
  if (state.playing && !isSample()) setPlaying(false);
  renderAccount();
}

function bindSettings() {
  const dlg = $('settings');
  $('redirect').textContent = sp.redirectUri();
  $('client-id').value = sp.getClientId();
  $('setup-steps').hidden = sp.fromEnv();
  $('env-note').hidden = !sp.fromEnv();
  $('env-note').textContent = `Using the Client ID from .env (…${sp.getClientId().slice(-4)}). Redirect URI: ${sp.redirectUri()}`;

  $('open-settings').onclick = () => dlg.showModal();
  $('account').onclick = () => (state.connected || !sp.getClientId() ? dlg.showModal() : login());
  $('copy-redirect').onclick = async () => {
    try { await navigator.clipboard.writeText(sp.redirectUri()); toast('Redirect URI copied.'); }
    catch { toast('Select the address and copy it by hand.'); }
  };
  $('connect').onclick = () => {
    if (!sp.fromEnv()) {
      const id = $('client-id').value.trim();
      if (!/^[a-z0-9]{32}$/i.test(id)) { toast('That Client ID looks wrong. It is 32 letters and numbers from your app page.', { error: true }); $('client-id').focus(); return; }
      sp.setClientId(id);
    }
    login();
  };
  $('disconnect').onclick = () => { signedOut(true); toast('Logged out of Spotify.'); };
  $('check-btn').onclick = runPlaybackCheck;
  const mp = document.querySelector(`input[name=motion][value="${motionPref()}"]`);
  if (mp) mp.checked = true;
  document.querySelectorAll('input[name=motion]').forEach(r => r.addEventListener('change', e => {
    setMotionPref(e.target.value);
    toast('Animation setting saved. Reloading to apply it…');
    setTimeout(() => location.reload(), 900);
  }));
}

// ---------- filters ----------
const missingScope = s => s.scope && !sp.hasScope(s.scope);
const activeSources = () => SOURCES.filter(s => state.sources.includes(s.id) && !missingScope(s)).map(s => s.id);

function renderFilters() {
  const f = state.filters;
  $('sources').innerHTML = SOURCES.map(s => {
    const blocked = !state.connected || missingScope(s);
    const on = state.sources.includes(s.id) && !blocked;
    return `<button type="button" class="chip" data-src="${s.id}" aria-pressed="${on}" ${blocked ? 'disabled' : ''}>${s.label}</button>`;
  }).join('');
  $('scope-note').hidden = !state.connected || !SOURCES.some(missingScope);
  document.querySelectorAll('#leave-out .chip').forEach(b => {
    const tag = b.dataset.tag;
    b.setAttribute('aria-pressed', String(f.leaveOut.includes(tag)));
    b.disabled = tag === 'recent' && (!state.connected || !sp.hasScope('user-read-recently-played'));
  });
  document.querySelector(`input[name=origin][value="${f.origin}"]`).checked = true;
  document.querySelector(`input[name=per-artist][value="${f.maxPerArtist}"]`).checked = true;
  const len = document.querySelector(`input[name=length][value="${f.length}"]`);
  if (len) len.checked = true;
  $('familiarity').value = f.familiarity;
  $('variety').value = f.variety;
  $('fam-out').textContent = f.familiarity < 0.35 ? 'mostly new finds' : f.familiarity > 0.65 ? 'mostly songs you play' : 'a mix';
  $('var-out').textContent = f.variety < 0.2 ? 'closest fit' : f.variety > 0.6 ? 'lots of surprise' : 'a little surprise';

  const parts = [];
  if (state.connected) parts.push(`${activeSources().length} sources`);
  if (f.origin !== 'any') parts.push(f.origin === 'in' ? 'Indian only' : 'international only');
  parts.push(f.maxPerArtist ? `${f.maxPerArtist} per artist` : 'any per artist');
  if (f.leaveOut.length) parts.push(`${f.leaveOut.length} left out`);
  $('filter-sum').textContent = parts.join(', ');
}

let rebuildTimer;
function filtersChanged() {
  pref.set('filters', JSON.stringify(state.filters));
  pref.set('sources', JSON.stringify(state.sources));
  renderFilters();
  clearTimeout(rebuildTimer);
  if (state.reading) rebuildTimer = setTimeout(() => build(), 350);
}

function bindFilters() {
  $('sources').addEventListener('click', e => {
    const b = e.target.closest('[data-src]'); if (!b || b.disabled) return;
    const id = b.dataset.src;
    state.sources = state.sources.includes(id) ? state.sources.filter(x => x !== id) : [...state.sources, id];
    if (!activeSources().length) { state.sources = [id]; toast('Keep at least one source on.'); }
    filtersChanged();
  });
  $('leave-out').addEventListener('click', e => {
    const b = e.target.closest('[data-tag]'); if (!b || b.disabled) return;
    const tag = b.dataset.tag, lo = state.filters.leaveOut;
    state.filters.leaveOut = lo.includes(tag) ? lo.filter(x => x !== tag) : [...lo, tag];
    filtersChanged();
  });
  document.querySelectorAll('input[name=origin]').forEach(r => r.addEventListener('change', e => { state.filters.origin = e.target.value; filtersChanged(); }));
  document.querySelectorAll('input[name=per-artist]').forEach(r => r.addEventListener('change', e => { state.filters.maxPerArtist = Number(e.target.value); filtersChanged(); }));
  document.querySelectorAll('input[name=length]').forEach(r => r.addEventListener('change', e => { state.filters.length = Number(e.target.value); filtersChanged(); }));
  $('familiarity').addEventListener('input', e => { state.filters.familiarity = Number(e.target.value); filtersChanged(); });
  $('variety').addEventListener('input', e => { state.filters.variety = Number(e.target.value); filtersChanged(); });
  $('relogin').onclick = login;
  $('remix').onclick = () => { state.seed = (state.seed * 7 + 13) % 100000 + 1; if (state.filters.variety < 0.3) { state.filters.variety = 0.35; renderFilters(); } build(); };
}

// ---------- the song pool ----------
async function loadSource(id) {
  if (id === 'discover') {
    const qs = discoverQueries(state.reading, region());
    const key = 'discover:' + qs.join('|');
    return state.pools[key] ||= (await sp.discoverTracks(qs)).map(t => ({ ...t, from: 'discover' }));
  }
  if (state.pools[id]) return state.pools[id];
  let list = [];
  if (id === 'top') {
    for (const r of ['short_term', 'medium_term', 'long_term']) list.push(...await sp.topTracks(r).catch(() => []));
  } else if (id === 'liked') list = await sp.likedTracks(600);
  else if (id === 'recent') list = await sp.recentTracks();
  else if (id === 'artists') list = await sp.artistTracks(20);
  else if (id === 'playlists') {
    for (const p of await sp.playlists()) list.push(...await sp.playlistTracks(p.id, 300).catch(() => []));
  }
  return (state.pools[id] = list.map(t => ({ ...t, from: id })));
}

function region() {
  if (state.user?.country === 'IN') return 'IN';
  const top = state.pools.top || [];
  return top.length && top.filter(t => t.isrc?.startsWith('IN')).length / top.length > 0.35 ? 'IN' : '';
}

let recentCache = { at: 0, ids: new Set() };
async function recentIds() {
  if (!state.filters.leaveOut.includes('recent') || !sp.hasScope('user-read-recently-played')) return null;
  if (Date.now() - recentCache.at > 5 * 60000) recentCache = { at: Date.now(), ids: new Set((await sp.recentTracks().catch(() => [])).map(t => t.id)) };
  return recentCache.ids;
}

async function library() {
  if (!state.connected) return { tracks: DEMO_TRACKS, source: 'sample' };
  const ids = activeSources();
  const seen = new Map();
  let i = 0;
  for (const id of ids) {
    toast(`Gathering songs: ${SOURCES.find(s => s.id === id).label.toLowerCase()} (${++i} of ${ids.length})…`, { ms: 60000 });
    try { (await loadSource(id)).forEach(t => { const prev = seen.get(t.id); seen.set(t.id, prev ? { ...prev, familiar: prev.familiar || t.from !== 'discover' && t.from !== 'artists' } : { ...t, familiar: t.from !== 'discover' && t.from !== 'artists' }); }); }
    catch (e) { if (e.reason === 'SESSION_ENDED') throw e; console.warn('Source failed', id, e); }
  }
  // One version per song: "Party All Night" from the film and the single count once.
  const byTitle = new Map();
  for (const t of seen.values()) {
    const key = `${t.name.toLowerCase().replace(/\s*[([].*?[)\]]|\s+-\s+.*$/g, '').trim()}|${(t.mainArtist || '').toLowerCase()}`;
    const have = byTitle.get(key);
    if (!have || (t.familiar && !have.familiar)) byTitle.set(key, t);
  }
  const tracks = [...byTitle.values()];
  if (tracks.length < 4) throw new Error('Not enough songs from the chosen sources. Turn on more sources in Filters.');

  // Measure each song once (loudness + genres from Deezer, matched by release code).
  const todo = tracks.filter(t => !state.vibed.has(t.id));
  if (todo.length) {
    await sp.attachVibes(todo, (done, total) => toast(`Measuring how loud and lively each song is: ${done} of ${total}…`, { ms: 60000 }));
    todo.forEach(t => state.vibed.set(t.id, { energy: t.energy, valence: t.valence, tempo: t.tempo, measured: t.measured, estimated: t.estimated, genres: t.genres, tags: t.tags, gain: t.gain }));
  }
  tracks.forEach(t => Object.assign(t, state.vibed.get(t.id)));
  hideToast();
  return { tracks, source: 'mix' };
}

const SOURCE_NAMES = { sample: 'the sample library', picks: 'your search picks' };

// ---------- build a session ----------
async function build(text = state.lastText) {
  if (!text?.trim()) return;
  state.lastText = text;
  const reading = readMood(text);
  if (!reading.confident) {
    toast("I couldn't find a feeling in that. Try words like tired, anxious, happy, udaas, or \"need energy\".", { error: true });
    return;
  }
  const send = document.querySelector('.send');
  send.setAttribute('aria-busy', 'true');
  try {
    state.reading = reading;
    const lib = await library();
    const recent = await recentIds();
    stopDemo();
    const f = state.filters;
    state.session = sequence(lib.tracks, reading, f.length, { filters: f, seed: state.seed, recentIds: recent });
    if (!state.session.length) throw new Error('The filters left no songs. Loosen them in Filters.');
    state.source = lib.source;
    state.poolStats = {
      total: lib.tracks.length,
      measured: lib.tracks.filter(t => t.measured).length,
      left: lib.tracks.filter(t => filteredOut(t, f, recent)).length,
    };
    renderReading();
    renderSession();
    setCurrent(0);
    if (state.playing) startPlayback(0);
  } catch (e) {
    hideToast();
    handleError(e);
  } finally {
    send.removeAttribute('aria-busy');
  }
}

function renderReading() {
  const r = state.reading;
  $('reading').hidden = false;
  $('from-swatch').style.background = vibeColor(r.current);
  $('to-swatch').style.background = vibeColor(r.target);
  $('from-label').textContent = r.from;
  $('to-label').textContent = r.to;
  const feel = r.words.filter(w => w.role === 'feel').map(w => `<b>${escapeHtml(w.w)}</b>`);
  const want = r.words.filter(w => w.role === 'want').map(w => `<b>${escapeHtml(w.w)}</b>`);
  $('heard').innerHTML = [
    feel.length && `You said ${list(feel)}`,
    want.length ? `you want ${list(want)}` : 'so I\'ll steer you toward ' + r.to.toLowerCase(),
  ].filter(Boolean).join(', ') + '.';
}
const list = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a.at(-1);

const PHASES = { meet: 'Meeting you where you are', move: 'Moving', arrive: 'Arriving', pick: 'Your picks' };

// Keep the session across page changes (Mood ⇄ Studio) for this browser session.
function rememberSession() {
  try { sessionStorage.setItem('cfm.moodSession', JSON.stringify({ reading: state.reading, session: state.session, source: state.source, poolStats: state.poolStats, lastText: state.lastText, index: state.index })); } catch { /* too big or blocked */ }
}
function restoreSession() {
  try {
    const m = JSON.parse(sessionStorage.getItem('cfm.moodSession') || 'null');
    if (!m?.session?.length) return false;
    Object.assign(state, { reading: m.reading, session: m.session, source: m.source, poolStats: m.poolStats, lastText: m.lastText });
    if (m.lastText) $('mood-input').value = m.lastText;
    if (state.reading) renderReading();
    renderSession();
    setCurrent(m.index || 0);
    return true;
  } catch { return false; }
}

function renderSession() {
  rememberSession();
  $('empty').hidden = true;
  $('session').hidden = false;
  const s = state.session;
  $('session-title').textContent = state.reading && state.source !== 'picks' ? `${state.reading.from} to ${state.reading.to.toLowerCase()}` : 'Your picks';
  const mins = Math.round(s.reduce((a, t) => a + (t.duration || 200000), 0) / 60000);
  const ps = state.poolStats;
  $('session-meta').textContent = state.source === 'mix' && ps
    ? `${s.length} songs, ${mins} min. Picked from ${ps.total} songs (${ps.measured} with loudness data)${ps.left ? `; filters left out ${ps.left}` : ''}.`
    : `${s.length} songs, ${mins} min, from ${SOURCE_NAMES[state.source] || 'your music'}.`;
  $('remix').hidden = state.source === 'picks';

  const q = $('queue');
  q.innerHTML = '';
  let phase = null;
  s.forEach((t, i) => {
    const ph = t.phase || 'pick';
    if (ph !== phase) {
      phase = ph;
      const count = s.filter(x => (x.phase || 'pick') === phase).length;
      const h = document.createElement('li');
      h.className = 'phase';
      h.innerHTML = `<span>${PHASES[phase]}, ${count} songs</span><span>Energy</span>`;
      q.append(h);
    }
    const li = document.createElement('li');
    const taste = savedTaste(`${t.name} – ${t.mainArtist || t.artist}`);
    const style = taste ? (taste.mode === 'auto' ? 'Auto' : taste.mode === 'custom' ? 'Custom' : STUDIO_MODES[taste.mode]?.label) : '';
    const by = (t.from === 'discover' ? `${t.artist} · new find` : t.artist) + (style ? ` · ${style}` : '');
    li.innerHTML = `<button class="track" type="button" data-i="${i}" aria-label="Play ${escapeHtml(t.name)} by ${escapeHtml(t.artist)}">
      <span class="n">${i + 1}</span><span class="sw" style="background:${vibeColor(t)}"></span>
      <span class="t"><span class="name">${escapeHtml(t.name)}</span><span class="by">${escapeHtml(by)}</span></span>
      <span class="e${t.measured || t.sample ? '' : ' est'}" title="${t.measured ? 'From measured loudness' : 'Estimated'}">${t.measured || t.sample ? '' : '~'}${t.energy.toFixed(2)}</span></button>`;
    q.append(li);
  });
}

function setCurrent(i, { keepProgress = false } = {}) {
  state.index = Math.max(0, Math.min(i, state.session.length - 1));
  const t = state.session[state.index];
  if (!t) return;
  $('now-title').textContent = t.name;
  $('now-artist').textContent = `${t.artist} · ${state.index + 1} of ${state.session.length}`;
  $('now-art').style.backgroundImage = t.art ? `url("${t.art}")` : '';
  document.querySelectorAll('.track').forEach(b => {
    const n = Number(b.dataset.i);
    b.setAttribute('aria-current', n === state.index ? 'true' : 'false');
    b.classList.toggle('played', n < state.index);
  });
  if (!keepProgress) { state.progressMs = 0; state.durationMs = t.duration; state.progressAt = performance.now(); $('progress-fill').style.width = '0%'; }
  $('prev').disabled = state.index === 0;
  $('next').disabled = state.index === state.session.length - 1;
  paintVibe(t);
}

// ---------- playback ----------
function setPlaying(on) {
  state.playing = on;
  $('play').setAttribute('aria-pressed', String(on));
  $('play').setAttribute('aria-label', on ? 'Pause' : 'Play');
  brain?.setPlaying(on);
}

const isSample = () => state.source === 'sample' || !state.connected;

const SAMPLE_MS = 20000;
function startDemo() {
  stopDemo();
  state.demoStart = performance.now();
  state.demoTimer = setInterval(() => {
    if (state.index >= state.session.length - 1) { stopDemo(); setPlaying(false); return; }
    setCurrent(state.index + 1);
    state.demoStart = performance.now();
  }, SAMPLE_MS);
}
function stopDemo() { clearInterval(state.demoTimer); state.demoTimer = null; }

async function startPlayback(offset = state.index, uris = state.session.map(t => t.uri)) {
  if (isSample()) {
    setPlaying(true); startDemo();
    if (!state.sampleNoticeShown) { toast('Sample mode plays no sound. Each song lasts 20 seconds so you can watch the brain react. Log in with Spotify to hear your music.', { ms: 7000 }); state.sampleNoticeShown = true; }
    return;
  }
  $('play').setAttribute('aria-busy', 'true');
  try {
    const deviceId = state.webReady ? state.web.deviceId() : null;
    const device = await sp.play(uris, offset, deviceId);
    state.startedOnSpotify = true;
    state.device = device.name;
    markStarted(true);
    setPlaying(true);
    toast(deviceId ? 'Playing in this browser.' : `Playing on ${device.name}.`);
    startPolling();
  } catch (e) {
    setPlaying(false);
    handleError(e);
  } finally { $('play').removeAttribute('aria-busy'); }
}

async function togglePlay() {
  if (!state.session.length) return;
  state.web?.activate?.();
  if (!state.playing) {
    if (!isSample() && state.startedOnSpotify && state.sessionPlayed === state.session) {
      try { await sp.resume(); markStarted(false); setPlaying(true); startPolling(); return; } catch { /* fall through to a fresh start */ }
    }
    state.sessionPlayed = state.session;
    return startPlayback();
  }
  setPlaying(false);
  state.wantPlaying = false;
  if (isSample()) stopDemo();
  else { try { await sp.pause(); } catch (e) { handleError(e); } }
}

async function step(dir) {
  const target = state.index + dir;
  if (target < 0 || target >= state.session.length) return;
  if (isSample() || !state.playing) {
    setCurrent(target);
    if (state.playing) startDemo();
    return;
  }
  try { await (dir > 0 ? sp.next() : sp.previous()); markStarted(false); setCurrent(target); }
  catch (e) { handleError(e); }
}

function syncTo({ id, linkedId, paused, position, duration }) {
  const i = state.session.findIndex(t => t.id === id || t.id === linkedId);
  if (i >= 0 && i !== state.index) setCurrent(i, { keepProgress: true });
  if (paused === state.playing) setPlaying(!paused);
  state.progressMs = position; state.durationMs = duration; state.progressAt = performance.now();
}

// Some phones (battery saving, Spotify asleep in the background) stop a song a few
// seconds after another app starts it. When that happens soon after Cortex FM pressed
// play, restart it a few times, then explain the phone setting that causes it.
const AUTO_RESUME_WINDOW = 25000, MAX_AUTO_RESUMES = 3;
function markStarted(fresh) {
  state.wantPlaying = true;
  state.lastStartAt = Date.now();
  if (fresh) state.autoResumes = 0;
}

const PHONE_HELP = 'Your phone keeps stopping Spotify a few seconds after it starts. On the phone: Settings, Apps, Spotify, Battery, set it to Unrestricted, and take Spotify out of "Sleeping apps". Keep the Spotify app open in the background, then press Play here again.';

async function watchdog(np) {
  if (!state.wantPlaying || np.isPlaying || !np.id) return false;
  if (!state.session.some(t => t.id === np.id)) { state.wantPlaying = false; return false; } // someone chose something else
  if (Date.now() - state.lastStartAt > AUTO_RESUME_WINDOW) { state.wantPlaying = false; return false; } // a later pause is the listener's
  if ((state.autoResumes || 0) >= MAX_AUTO_RESUMES) {
    state.wantPlaying = false;
    toast(PHONE_HELP, { error: true, ms: 15000 });
    return false;
  }
  state.autoResumes = (state.autoResumes || 0) + 1;
  try {
    await sp.resume();
    state.lastStartAt = Date.now();
    toast(`${state.device || 'Your phone'} stopped the song by itself, so Cortex FM started it again (${state.autoResumes} of ${MAX_AUTO_RESUMES}).`);
    return true;
  } catch { return false; }
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (state.webReady && state.lastWebEvent > Date.now() - 15000) return;
    try {
      const np = await sp.nowPlaying();
      if (!np) return;
      if (await watchdog(np)) return;
      if (!np.id) return;
      if (state.session.some(t => t.id === np.id)) syncTo({ id: np.id, paused: !np.isPlaying, position: np.progress, duration: np.duration });
      else await followOutside(np);
    } catch (e) { if (e.reason === 'SESSION_ENDED') handleError(e); }
  }, 3000);
}
function stopPolling() { clearInterval(state.pollTimer); state.pollTimer = null; }

// Music started elsewhere (on the phone, another app): the brain still listens along.
async function followOutside(np) {
  if (state.playing && !isSample() && state.wantPlaying) return;
  const t = np.track;
  if (!t) return;
  if (state.outsideId !== t.id) {
    state.outsideId = t.id;
    if (!state.vibed.has(t.id)) { await sp.attachVibes([t]).catch(() => {}); state.vibed.set(t.id, { energy: t.energy ?? 0.5, valence: t.valence ?? 0.5, tempo: t.tempo ?? 110, measured: t.measured, estimated: !t.measured, genres: t.genres, tags: t.tags, gain: t.gain }); }
    Object.assign(t, state.vibed.get(t.id));
    paintVibe(t);
    $('readout-title').textContent = `${t.name} · ${t.artist} (on ${np.device || 'Spotify'})`;
  }
  brain?.setPlaying(np.isPlaying);
}

async function startWebPlayer() {
  if (state.web) return;
  state.web = 'starting';
  let failed = false;
  try {
    const { createWebPlayer } = await import('./player.js');
    const player = await createWebPlayer({
      onReady: () => { state.webReady = true; renderAccount(); },
      onNotReady: () => { state.webReady = false; renderAccount(); },
      onState: st => { state.lastWebEvent = Date.now(); syncTo(st); },
      onError: (kind, message) => {
        console.warn('Web player', kind, message);
        if (kind === 'auth') return handleError({ reason: 'SESSION_ENDED' });
        if (kind === 'account' || kind === 'init') { failed = true; state.web = false; state.webReady = false; renderAccount(); return; }
        if (kind === 'autoplay') return toast('Your browser blocked autoplay. Press Play to start.');
        toast("Spotify couldn't play that track. Skipping ahead may help.", { error: true });
      },
    });
    if (failed) player.disconnect(); else state.web = player;
  } catch (e) {
    console.warn('Web player unavailable', e);
    state.web = false; state.webReady = false;
  }
  renderAccount();
}

async function save() {
  if (!state.session.length) return;
  const btn = $('save');
  btn.disabled = true;
  try {
    const r = state.reading;
    const name = r && state.source !== 'picks' ? `Cortex FM · ${r.from} to ${r.to.toLowerCase()}` : 'Cortex FM · My picks';
    const desc = r ? `Made from "${state.lastText.slice(0, 120)}". Sequenced by Cortex FM.` : 'Picked in Cortex FM.';
    const url = await sp.savePlaylist(name, desc, state.session.map(t => t.uri));
    toast(`Saved to your Spotify. <a href="${escapeHtml(url)}" target="_blank" rel="noopener">Open playlist</a>`, { html: true, ms: 8000 });
  } catch (e) { handleError(e); }
  finally { btn.disabled = false; }
}

// ---------- playback check ----------
// Plays for 20 seconds on the phone and describes what the phone did.
async function runPlaybackCheck() {
  const btn = $('check-btn'), out = $('check-result');
  btn.disabled = true;
  out.textContent = 'Starting a song on your Spotify device…';
  stopPolling(); state.wantPlaying = false;
  try {
    let uris = state.session.map(t => t.uri).filter(Boolean);
    if (!uris.length) uris = (await sp.topTracks('short_term')).slice(0, 5).map(t => t.uri);
    const device = await sp.play(uris, 0);
    const log = [];
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const [np, devs] = await Promise.all([sp.nowPlaying().catch(() => null), sp.devices().catch(() => [])]);
      log.push({ t: (i + 1) * 2, playing: !!np?.isPlaying, pos: Math.round((np?.progress || 0) / 1000), present: devs.some(d => d.name === device.name), active: devs.some(d => d.name === device.name && d.is_active) });
      out.textContent = `Listening to ${device.name}… ${(i + 1) * 2} of 20 seconds`;
    }
    await sp.pause().catch(() => {});
    const everPlayed = log.some(l => l.playing || l.pos > 0);
    const firstStop = log.find((l, i) => i > 0 && log[i - 1].playing && !l.playing);
    const dropped = log.find(l => !l.present);
    const maxPos = Math.max(...log.map(l => l.pos));
    let verdict;
    if (!everPlayed) verdict = `${device.name} accepted the command but never started. Open the Spotify app on it, play any song for a second, then try again.`;
    else if (dropped) verdict = `${device.name} played for about ${maxPos} seconds, then dropped off Spotify completely. The phone closed the Spotify app in the background. ${PHONE_HELP.replace(/^Your phone keeps stopping Spotify a few seconds after it starts\. /, '')}`;
    else if (firstStop) verdict = `${device.name} played for about ${maxPos} seconds, then paused itself while still connected. That is the phone's power saving pausing Spotify, not Cortex FM. ${PHONE_HELP.replace(/^Your phone keeps stopping Spotify a few seconds after it starts\. /, '')} Cortex FM will also restart a stopped song up to 3 times.`;
    else verdict = `${device.name} played for the full 20 seconds without stopping. Playback works.`;
    out.textContent = verdict;
  } catch (e) {
    out.textContent = explain(e);
  } finally { btn.disabled = false; }
}

// ---------- search ----------
let searchSeq = 0;
async function runSearch(q) {
  const out = $('results');
  const seq = ++searchSeq;
  if (!q.trim()) { out.innerHTML = ''; $('results-note').textContent = ''; return; }
  $('results-note').textContent = 'Searching…';
  try {
    const tracks = await sp.searchTracks(q);
    if (seq !== searchSeq) return;
    state.results = tracks;
    $('results-note').textContent = tracks.length ? '' : `No songs found for "${q}".`;
    out.innerHTML = tracks.map((t, i) => `<li class="result">
      <span class="r-art" style="${t.art ? `background-image:url('${escapeHtml(t.art)}')` : ''}"></span>
      <span class="t"><span class="name">${escapeHtml(t.name)}</span><span class="by">${escapeHtml(t.artist)}</span></span>
      <button class="icon-btn" type="button" data-play="${i}" aria-label="Play ${escapeHtml(t.name)} now"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>
      <button class="icon-btn" type="button" data-add="${i}" aria-label="Add ${escapeHtml(t.name)} to the session"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
    </li>`).join('');
  } catch (e) {
    if (seq === searchSeq) { $('results-note').textContent = ''; handleError(e); }
  }
}

async function addPick(t, playNow) {
  state.web?.activate?.();
  await sp.attachVibes([t]).catch(() => {});
  if (t.energy == null) Object.assign(t, { energy: 0.5, valence: 0.5, tempo: 110, estimated: true });
  if (!state.session.length || isSample()) {
    stopDemo();
    state.source = 'picks';
    state.session = [{ ...t, phase: 'pick' }];
    $('reading').hidden = true;
  } else if (!state.session.some(x => x.id === t.id)) {
    state.session = [...state.session, { ...t, phase: state.session.at(-1).phase }];
  }
  renderSession();
  const i = state.session.findIndex(x => x.id === t.id);
  if (playNow) { setCurrent(i); state.sessionPlayed = state.session; startPlayback(i); }
  else { setCurrent(state.index, { keepProgress: true }); toast(`Added ${t.name} to the session. It plays in the session after you press Play again.`); }
}

function tickProgress() {
  if (!state.playing || !state.session.length) return;
  const pct = isSample()
    ? (performance.now() - state.demoStart) / SAMPLE_MS
    : state.durationMs ? (state.progressMs + (performance.now() - state.progressAt)) / state.durationMs : 0;
  $('progress-fill').style.width = Math.min(100, Math.max(0, pct * 100)) + '%';
}
setInterval(tickProgress, 300);

// ---------- wiring ----------
function bindUI() {
  const input = $('mood-input');
  $('ask').addEventListener('submit', e => { e.preventDefault(); build(input.value); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); build(input.value); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; });

  $('chips').innerHTML = SHORTCUTS.map((s, i) => `<button class="chip" type="button" data-i="${i}">${s.label}</button>`).join('');
  $('chips').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    input.value = SHORTCUTS[b.dataset.i].text;
    build(input.value);
  });

  $('play').onclick = togglePlay;
  $('next').onclick = () => step(1);
  $('prev').onclick = () => step(-1);
  $('save').onclick = save;
  $('to-studio').onclick = () => {
    if (!state.session.length) return;
    const title = state.reading && state.source !== 'picks' ? `${state.reading.from} to ${state.reading.to.toLowerCase()}` : 'Your picks';
    const tracks = state.session.map(t => ({ id: t.id, name: t.name, artist: t.artist, mainArtist: t.mainArtist || t.artist, art: t.art, isrc: t.isrc, energy: t.energy, valence: t.valence, tempo: t.tempo, genres: t.genres }));
    try { sessionStorage.setItem('cfm.studioQueue', JSON.stringify({ title, tracks })); } catch { /* ignore */ }
    if (state.playing && !isSample()) sp.pause().catch(() => {});
    location.href = 'spatial.html#queue';
  };
  $('queue').addEventListener('click', e => {
    const b = e.target.closest('.track'); if (!b) return;
    state.web?.activate?.();
    const i = Number(b.dataset.i);
    setCurrent(i);
    if (!isSample()) { state.sessionPlayed = state.session; startPlayback(i); }
    else if (state.playing) startDemo();
  });

  let debounce;
  $('search').addEventListener('input', e => { clearTimeout(debounce); debounce = setTimeout(() => runSearch(e.target.value), 350); });
  $('find').addEventListener('submit', e => { e.preventDefault(); clearTimeout(debounce); runSearch($('search').value); });
  $('results').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const t = state.results?.[Number(b.dataset.play ?? b.dataset.add)];
    if (t) addPick({ ...t }, b.dataset.play != null);
  });
}

// ---------- floating launcher, shown once each time the app is opened ----------
function firstName(name = '') {
  const w = name.split(/\s+/).find(x => /^[a-z]{2,}$/i.test(x));
  return w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : '';
}

function closeLauncher() {
  const l = $('launch');
  if (l.hidden || l.classList.contains('leaving')) return;
  l.classList.add('leaving');
  setTimeout(() => { l.hidden = true; l.classList.remove('leaving'); }, 340);
}

// True the first time the app is opened in this browser session (not on every page change).
const FIRST_OPEN = (() => {
  if (new URLSearchParams(location.search).has('code')) return false;
  try { const seen = sessionStorage.getItem('cfm.launched') === '1'; sessionStorage.setItem('cfm.launched', '1'); return !seen; } catch { return false; }
})();
const WANTS_INTRO = FIRST_OPEN && !reducedMotion();
if (WANTS_INTRO) document.body.classList.add('intro-on'); // hide the floating UI before first paint

/** The opening: the brain builds itself, the headphones snap on, the name appears. */
async function playIntro() {
  if (!WANTS_INTRO || !brain) { document.body.classList.remove('intro-on'); return; }
  const el = $('intro');
  el.hidden = false;
  let finished = false;
  const finish = () => {
    if (finished) return; finished = true;
    brain.skipIntro();
    el.classList.add('out');
    document.body.classList.remove('intro-on');
    setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, 700);
  };
  const skip = () => finish();
  $('intro-skip').onclick = skip;
  const keySkip = e => { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') skip(); };
  document.addEventListener('keydown', keySkip, { once: true });
  await Promise.race([brain.playIntro(4.2).then(() => new Promise(r => setTimeout(r, 650))), new Promise(r => $('intro-skip').addEventListener('click', r, { once: true }))]);
  document.removeEventListener('keydown', keySkip);
  finish();
  await new Promise(r => setTimeout(r, 450));
}

async function showLauncher() {
  if (!FIRST_OPEN) return;
  const l = $('launch');
  const h = new Date().getHours();
  const part = h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const name = firstName(state.user?.name);
  $('launch-hi').textContent = name ? `${part}, ${name}.` : `${part}.`;
  l.hidden = false;
  setTimeout(() => $('launch-input').focus(), 300);
  if (state.connected) {
    const np = await sp.nowPlaying().catch(() => null);
    if (np?.track && np.isPlaying) { $('launch-now').hidden = false; $('launch-now').textContent = `Playing on ${np.device || 'Spotify'}: ${np.track.name} by ${np.track.mainArtist}`; }
  }
}

function bindLauncher() {
  $('launch-close').onclick = closeLauncher;
  $('launch').addEventListener('click', e => { if (e.target.id === 'launch') closeLauncher(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLauncher(); });
  $('tile-mood').onclick = () => { closeLauncher(); setTimeout(() => $('mood-input').focus(), 360); };
  $('launch-ask').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('launch-input').value.trim();
    if (!v) return $('launch-input').focus();
    $('mood-input').value = v;
    closeLauncher();
    build(v);
  });
}

async function boot() {
  bindUI();
  bindSettings();
  bindFilters();
  bindLauncher();

  try {
    if (await sp.handleRedirect()) { state.connected = true; toast('Logged in with Spotify. Tell me how you feel.'); }
  } catch (e) { handleError(e); }
  if (!state.connected) state.connected = await sp.restore(); // remembered login: no need to sign in again
  else sp.restore();

  if (state.connected) {
    try { state.user = await sp.me(); }
    catch (e) { if (e.status === 401 || e.reason) signedOut(); else console.warn(e); }
  }
  renderAccount();
  if (state.connected) { startWebPlayer(); startPolling(); }

  try {
    const { Brain } = await import('./brain.js');
    brain = new Brain($('brain'));
    brain.setVibe({ energy: 0.3, valence: 0.5, tempo: 72 }, '#3b5bdb', '#20c997');
  } catch (e) {
    console.warn('3D view unavailable', e);
    $('readout-title').textContent = 'The 3D view needs WebGL, which this browser has turned off.';
  }
  restoreSession();
  await playIntro();
  showLauncher();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
