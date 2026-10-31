// Loudness and genres for a song, from Deezer's public catalogue (matched by ISRC).
// Browsers can't call Deezer directly, so the hosted copy asks this small function.
export default async (req) => {
  const isrc = decodeURIComponent(new URL(req.url).pathname.split('/').pop() || '').toUpperCase();
  const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });
  if (!/^[A-Z0-9]{12}$/.test(isrc)) return json({ error: 'bad isrc' }, 400);
  try {
    const t = await (await fetch(`https://api.deezer.com/track/isrc:${isrc}`)).json();
    if (!t || t.error) return json({ found: false }, 200, { 'cache-control': 'public, max-age=86400' });
    let genres = [];
    if (t.album?.id) {
      const al = await fetch(`https://api.deezer.com/album/${t.album.id}`).then(r => r.json()).catch(() => null);
      genres = (al?.genres?.data || []).map(g => g.name);
    }
    return json({ found: true, gain: typeof t.gain === 'number' ? t.gain : null, bpm: t.bpm || null, rank: t.rank || null, explicit: !!t.explicit_lyrics, genres }, 200, { 'cache-control': 'public, max-age=86400' });
  } catch {
    return json({ found: false, error: true }, 200);
  }
};

export const config = { path: '/api/vibe/*' };
