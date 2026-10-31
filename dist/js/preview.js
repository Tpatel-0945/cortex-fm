// Free 30-second previews, looked up straight from the browser (Apple's public search allows this),
// so it works on a hosted copy with no server. Spotify's own audio can't be used by apps.
const clean = s => (s || '').toLowerCase().replace(/\s*[([].*?[)\]]/g, '').replace(/\s+-\s+.*$/, '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
const cache = new Map();

export async function findPreview(title, artist = '', country = 'US') {
  const key = `${country}|${clean(title)}|${clean(artist)}`;
  if (cache.has(key)) return cache.get(key);
  const firstArtist = artist.split(',')[0];
  let best = null, bestScore = -1;
  for (const term of [`${clean(title)} ${clean(firstArtist)}`.trim(), clean(title)]) {
    const r = await fetch(`https://itunes.apple.com/search?media=music&entity=song&limit=10&country=${country}&term=${encodeURIComponent(term)}`).catch(() => null);
    const data = r?.ok ? await r.json().catch(() => null) : null;
    for (const s of data?.results || []) {
      if (!s.previewUrl) continue;
      const t = clean(s.trackName), want = clean(title);
      let score = t === want ? 3 : t.includes(want) || want.includes(t) ? 2 : 0;
      const artists = clean(s.artistName);
      if (firstArtist && artists.includes(clean(firstArtist))) score += 2;
      else if (artist && artist.split(',').some(a => artists.includes(clean(a)))) score += 1;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    if (bestScore >= 4) break;
  }
  const out = best && bestScore >= 2
    ? { found: true, url: best.previewUrl, title: best.trackName, artist: best.artistName, exact: bestScore >= 4 }
    : { found: false };
  if (out.found || bestScore < 0) cache.set(key, out);
  return out;
}
