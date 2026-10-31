// Spotify Web API with Authorization Code + PKCE.
// No client secret anywhere. The Client ID and Redirect URI come from .env
// (served by server.js as /config.js); Settings can override them for static hosting.
import { vibeFromFacts } from './mood.js';

const API = 'https://api.spotify.com/v1';
const CFG = window.CORTEX_CONFIG || {};

export const SCOPES = [
  'user-read-private', 'user-top-read', 'playlist-read-private',
  'playlist-modify-public', 'playlist-modify-private', 'streaming',
  'user-read-playback-state', 'user-modify-playback-state',
  'user-read-email',            // required by the Web Playback SDK alongside streaming + user-read-private
  'user-library-read',          // Liked Songs as a song source
  'user-read-recently-played',  // recent plays as a source, and "skip what I just heard"
].join(' ');

const store = {
  get(k) { try { return localStorage.getItem('cfm.' + k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem('cfm.' + k) : localStorage.setItem('cfm.' + k, v); } catch { /* storage blocked */ } },
};

export const fromEnv = () => !!CFG.clientId;
// On a hosted copy the login address is the app's own folder, e.g. https://name.github.io/cortex-fm/
export const redirectUri = () => CFG.redirectUri || location.origin + location.pathname.replace(/[^/]*$/, '');
export const getClientId = () => CFG.clientId || store.get('clientId') || '';
export const setClientId = id => store.set('clientId', id.trim() || null);
export const isConnected = () => !!store.get('refresh');
/** True when the current login granted this permission. Old logins may lack the newer ones. */
export const hasScope = s => (store.get('scope') || '').split(' ').includes(s);
/** Where the app lives (the callback path is inside it). */
const appHome = () => new URL('./', redirectUri()).pathname;

export class SpotifyError extends Error {
  constructor(message, status, reason) { super(message); this.status = status; this.reason = reason; }
}

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- login / logout ----------

export async function login() {
  const clientId = getClientId();
  if (!clientId) throw new SpotifyError('No Spotify Client ID. Add it to .env (or Settings) first.');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem('cfm.verifier', verifier);
  sessionStorage.setItem('cfm.state', state);
  const q = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri(),
    code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state,
  });
  location.assign('https://accounts.spotify.com/authorize?' + q);
}

/** Finish login if Spotify just sent us back. Returns true when a login completed. */
export async function handleRedirect() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return false;
  history.replaceState(null, '', appHome());
  const verifier = sessionStorage.getItem('cfm.verifier');
  const expected = sessionStorage.getItem('cfm.state');
  sessionStorage.removeItem('cfm.verifier');
  sessionStorage.removeItem('cfm.state');
  if (p.get('error')) throw new SpotifyError(p.get('error') === 'access_denied' ? 'Spotify login was cancelled.' : 'Spotify login failed: ' + p.get('error'));
  if (!verifier || p.get('state') !== expected) throw new SpotifyError('Login check failed (the login started in another tab or expired). Please connect again.');
  store.set('user', null);
  await tokenRequest({ grant_type: 'authorization_code', code: p.get('code'), redirect_uri: redirectUri(), code_verifier: verifier });
  return true;
}

let refreshing = null;
async function tokenRequest(params) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: getClientId(), ...params }),
  }).catch(() => { throw new SpotifyError("Couldn't reach Spotify. Check your connection."); });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (params.grant_type === 'refresh_token') { logout(true); throw new SpotifyError('Your Spotify session ended. Please log in again.', 401, 'SESSION_ENDED'); }
    if (data.error === 'invalid_client') throw new SpotifyError('Spotify does not recognise this Client ID. Check SPOTIFY_CLIENT_ID in .env.', res.status);
    if (/redirect/i.test(data.error_description || '')) throw new SpotifyError(`Redirect URI mismatch. Add exactly ${redirectUri()} in the Spotify dashboard.`, res.status);
    throw new SpotifyError(data.error_description || 'Could not sign in to Spotify.', res.status);
  }
  store.set('access', data.access_token);
  store.set('expires', String(Date.now() + (data.expires_in - 60) * 1000));
  if (data.scope) store.set('scope', data.scope);
  if (data.refresh_token) {
    store.set('refresh', data.refresh_token); // Spotify may rotate it
    rememberOnServer();
  }
}

// ---------- remembered login ----------
// The local server keeps the login so you sign in once, whichever browser or tab you use.
function rememberOnServer() {
  fetch('/api/session', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh: store.get('refresh'), scope: store.get('scope') || '' }) }).catch(() => {});
}

/** Bring back a login the server remembers. Call once at start-up. Returns true when connected. */
export async function restore() {
  if (store.get('refresh')) { rememberOnServer(); return true; }
  try {
    const r = await fetch('/api/session', { cache: 'no-store' });
    const s = r.ok ? await r.json() : {};
    if (!s.refresh) return false;
    store.set('refresh', s.refresh);
    if (s.scope) store.set('scope', s.scope);
    return true;
  } catch { return false; } // static hosting: no server memory
}

/** Forget this browser's login. `everywhere` also clears the server's memory (the Log out button). */
export function logout(everywhere = false) {
  ['access', 'expires', 'refresh', 'user', 'scope'].forEach(k => store.set(k, null));
  if (everywhere) fetch('/api/session', { method: 'DELETE' }).catch(() => {});
}

/** A valid access token, refreshing it when expired (or when forced after a 401). */
export async function token(force = false) {
  if (!store.get('refresh')) throw new SpotifyError('Not connected to Spotify.', 401, 'NOT_CONNECTED');
  if (force || !store.get('access') || Date.now() > Number(store.get('expires'))) {
    refreshing ||= tokenRequest({ grant_type: 'refresh_token', refresh_token: store.get('refresh') }).finally(() => { refreshing = null; });
    await refreshing;
  }
  return store.get('access');
}

async function call(path, { method = 'GET', body, query, retried = false } = {}) {
  const url = (path.startsWith('http') ? path : API + path) + (query ? '?' + new URLSearchParams(query) : '');
  let res;
  try {
    res = await fetch(url, {
      method, headers: { Authorization: 'Bearer ' + await token(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e instanceof SpotifyError) throw e;
    throw new SpotifyError("Couldn't reach Spotify. Check your connection and try again.");
  }
  if (res.status === 204 || res.status === 202) return null;
  if (res.status === 401 && !retried) { await token(true); return call(path, { method, body, query, retried: true }); }
  if (res.status === 429 && !retried) {
    const wait = Math.min(Number(res.headers.get('Retry-After') || 2), 10);
    await sleep(wait * 1000);
    return call(path, { method, body, query, retried: true });
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* some endpoints answer with plain text */ }
  if (!res.ok) throw new SpotifyError(data?.error?.message || `Spotify said ${res.status}`, res.status, data?.error?.reason);
  return data;
}

// ---------- profile ----------

export async function me() {
  const cached = store.get('user');
  if (cached) return JSON.parse(cached);
  const u = await call('/me');
  const user = { id: u.id, name: u.display_name || u.id, product: u.product, country: u.country };
  store.set('user', JSON.stringify(user));
  return user;
}

// ---------- songs ----------

export const toTrack = t => t && t.id && t.type === 'track' && !t.is_local && {
  id: t.id, uri: t.uri, name: t.name, artist: t.artists.map(a => a.name).join(', '),
  artistIds: t.artists.map(a => a.id).filter(Boolean), mainArtist: t.artists[0]?.name || '',
  album: t.album?.name || '', albumId: t.album?.id || '',
  isrc: t.external_ids?.isrc || '', explicit: !!t.explicit, popularity: t.popularity ?? null,
  art: t.album?.images?.at(-1)?.url || t.album?.images?.[0]?.url || '', duration: t.duration_ms,
  year: Number((t.album?.release_date || '').slice(0, 4)) || null,
};

const dedupe = list => { const seen = new Map(); list.forEach(t => { if (t && !seen.has(t.id)) seen.set(t.id, t); }); return [...seen.values()]; };

/**
 * Your playlists whose songs this app may read. Spotify only lets new developer
 * apps read playlists you own or collaborate on, so followed ones are left out.
 */
export async function playlists() {
  const { id: myId } = await me();
  const out = [];
  let next = '/me/playlists?limit=50';
  while (next && out.length < 200) {
    const page = await call(next);
    (page?.items || []).filter(p => p && (p.owner?.id === myId || p.collaborative) && p.id !== store.get('queuePlaylist'))
      .forEach(p => out.push({ id: p.id, name: p.name, total: p.tracks?.total ?? p.items?.total ?? 0 }));
    next = page?.next;
  }
  return out;
}

/** Your most-played tracks for one range: short_term (4 weeks), medium_term (6 months), long_term (years). */
export async function topTracks(range = 'medium_term') {
  const out = [];
  for (const offset of [0, 49]) {
    const page = await call('/me/top/tracks', { query: { time_range: range, limit: 50, offset } });
    (page?.items || []).forEach(t => out.push(toTrack(t)));
    if (!page?.next) break;
  }
  return dedupe(out.filter(Boolean));
}

export async function topArtists(limit = 12) {
  const page = await call('/me/top/artists', { query: { time_range: 'medium_term', limit } });
  return (page?.items || []).map(a => ({ id: a.id, name: a.name }));
}

async function pages(first, max, pick = it => it.track) {
  const out = [];
  let next = first;
  while (next && out.length < max) {
    const page = await call(next);
    (page?.items || []).forEach(it => { const t = toTrack(pick(it)); if (t) out.push(t); });
    next = page?.next;
  }
  return out;
}

export const likedTracks = (max = 600) => pages('/me/tracks?limit=50', max);
export const recentTracks = () => pages('/me/player/recently-played?limit=50', 50);

export async function playlistTracks(id, max = 400) {
  try { return await pages(`/playlists/${id}/items?limit=50`, max, it => it.track || it.item); }
  catch (e) {
    if (e.status === 404) return pages(`/playlists/${id}/tracks?limit=50`, max, it => it.track || it.item);
    if (e.status === 403) throw new SpotifyError("Spotify only lets this app read playlists you made. Pick one of yours.", 403, 'PLAYLIST_FORBIDDEN');
    throw e;
  }
}

/** Search the Spotify catalogue for songs. Spotify caps search at 10 results per request. */
export async function searchTracks(q, limit = 10, offset = 0) {
  if (!q.trim()) return [];
  const data = await call('/search', { query: { q: q.trim(), type: 'track', limit: Math.min(limit, 10), offset } });
  return (data?.tracks?.items || []).map(toTrack).filter(Boolean);
}

/** Up to `per` songs by each of your favourite artists, found through search. */
export async function artistTracks(per = 20) {
  const artists = await topArtists(10);
  const out = [];
  await mapLimit(artists, 3, async a => {
    for (let off = 0; off < per; off += 10) {
      const found = await searchTracks(`artist:"${a.name}"`, 10, off).catch(() => []);
      out.push(...found.filter(t => t.artistIds.includes(a.id)));
      if (found.length < 10) break;
    }
  });
  return dedupe(out);
}

/** Fresh songs for a mood: catalogue searches built from mood words (and your region's music). */
export async function discoverTracks(queries) {
  const out = [];
  await mapLimit(queries, 3, async q => {
    for (const off of [0, 10]) out.push(...await searchTracks(q, 10, off).catch(() => []));
  });
  return dedupe(out);
}

async function mapLimit(items, n, fn) {
  let i = 0;
  await Promise.all([...Array(Math.min(n, items.length))].map(async () => { while (i < items.length) await fn(items[i++]); }));
}

// ---------- vibe facts ----------
// Loudness, tempo and genres come from Deezer's public catalogue via our server
// (Spotify no longer shares audio features or genres with new apps).

const vibeCache = (() => { try { return JSON.parse(localStorage.getItem('cfm.vibes') || '{}'); } catch { return {}; } })();
const saveVibes = () => { try { localStorage.setItem('cfm.vibes', JSON.stringify(vibeCache)); } catch { /* full or blocked */ } };

async function factsFor(isrc) {
  if (!isrc) return null;
  if (vibeCache[isrc]) return vibeCache[isrc];
  try {
    const r = await fetch(`/api/vibe/${encodeURIComponent(isrc)}`);
    if (!r.ok) return null;
    const f = await r.json();
    if (!f.error) vibeCache[isrc] = f;
    return f;
  } catch { return null; } // static hosting has no /api: titles still give a rough read
}

/** Attach energy / valence / tempo to every track. onProgress(done, total). */
export async function attachVibes(tracks, onProgress) {
  let done = 0, measured = 0;
  await mapLimit(tracks, 8, async t => {
    const f = await factsFor(t.isrc);
    Object.assign(t, vibeFromFacts(t, f));
    if (t.measured) measured++;
    if (++done % 10 === 0 || done === tracks.length) onProgress?.(done, tracks.length);
  });
  saveVibes();
  return { tracks, measured };
}

// ---------- playback ----------
// Phones ignore "play this list of songs" requests (Spotify answers 204, then nothing plays),
// but they do play playlists. So each session is written into one private playlist,
// "Cortex FM · Now playing", which is reused and overwritten every time.

const QUEUE_NAME = 'Cortex FM · Now playing';

async function createPlaylist(name, description) {
  const body = { name, description, public: false };
  try { return await call('/me/playlists', { method: 'POST', body }); }
  catch (e) { if (e.status === 401) throw e; return call(`/users/${(await me()).id}/playlists`, { method: 'POST', body }); }
}

async function writeItems(id, uris, replace) {
  const method = replace ? 'PUT' : 'POST';
  try { return await call(`/playlists/${id}/items`, { method, body: { uris } }); }
  catch (e) { if (e.status === 401 || e.status === 404 && !replace) throw e; return call(`/playlists/${id}/tracks`, { method, body: { uris } }); }
}

async function fillQueue(uris) {
  uris = uris.filter(Boolean).slice(0, 100);
  let id = store.get('queuePlaylist');
  if (id) {
    try { await writeItems(id, uris, true); return id; }
    catch (e) { if (e.status === 401) throw e; id = null; } // deleted or unreadable: make a new one
  }
  const pl = await createPlaylist(QUEUE_NAME, 'Cortex FM keeps this playlist updated with the session you are playing. Safe to delete.');
  store.set('queuePlaylist', pl.id);
  await writeItems(pl.id, uris, true);
  return pl.id;
}

export async function devices() {
  const d = await call('/me/player/devices');
  return d?.devices || [];
}

/**
 * Play `uris` from position `offset`. Prefers `deviceId` (this browser), then the active
 * device, then any available one (waking it first). Premium only.
 */
export async function play(uris, offset = 0, deviceId = null) {
  let device;
  if (deviceId && typeof deviceId === 'object') device = deviceId;
  else if (deviceId) device = { id: deviceId, name: 'this browser', is_active: true };
  else {
    const list = await devices();
    device = list.find(d => d.is_active) || list.find(d => !d.is_restricted);
  }
  if (!device) throw new SpotifyError('No Spotify device found. Open Spotify on your phone or computer, then press Play again.', 404, 'NO_ACTIVE_DEVICE');
  if (device.is_restricted) throw new SpotifyError(`${device.name} doesn't allow remote control. Open Spotify on another device.`, 403, 'DEVICE_RESTRICTED');

  const playlistId = await fillQueue(uris);
  if (!device.is_active) {
    await call('/me/player', { method: 'PUT', body: { device_ids: [device.id], play: false } }).catch(() => {});
    await sleep(700);
  }
  await sleep(400); // give Spotify a moment to see the new playlist contents
  await call('/me/player/play', { method: 'PUT', query: { device_id: device.id }, body: { context_uri: `spotify:playlist:${playlistId}`, offset: { position: offset } } });
  return device;
}

export const pause = () => call('/me/player/pause', { method: 'PUT' });
export const seek = ms => call('/me/player/seek', { method: 'PUT', query: { position_ms: Math.max(0, Math.round(ms)) } });

/** The Spotify app on this computer (not a phone, not the in-browser player). */
export async function computerDevice() {
  const list = await devices();
  return list.find(d => d.type === 'Computer' && d.name !== 'Cortex FM' && d.is_active)
    || list.find(d => d.type === 'Computer' && d.name !== 'Cortex FM') || null;
}
export const resume = () => call('/me/player/play', { method: 'PUT' });
export const next = () => call('/me/player/next', { method: 'POST' });
export const previous = () => call('/me/player/previous', { method: 'POST' });

/** What's playing right now on any device (uses user-read-playback-state). */
export async function nowPlaying() {
  const d = await call('/me/player');
  if (!d) return null;
  return { id: d.item?.id || null, isPlaying: d.is_playing, progress: d.progress_ms, duration: d.item?.duration_ms, device: d.device?.name, track: d.item ? toTrack(d.item) : null };
}

// ---------- playlists ----------

/** Save tracks as a new private playlist. Returns its Spotify URL. */
export async function savePlaylist(name, description, uris) {
  const pl = await createPlaylist(name, description);
  for (let i = 0; i < uris.length; i += 100) await writeItems(pl.id, uris.slice(i, i + 100), false);
  return pl.external_urls?.spotify || `https://open.spotify.com/playlist/${pl.id}`;
}
