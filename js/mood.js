// Mood engine: reads free text into a point in mood space (energy, valence),
// decides where the listener wants to go, and sequences tracks along that path.
// Everything runs locally; no external AI service.

// Each word maps to the listener's CURRENT state: [energy 0..1, valence 0..1].
const STATE_WORDS = {
  dizzy: [0.25, 0.35], foggy: [0.25, 0.4], groggy: [0.2, 0.35], sleepy: [0.12, 0.45],
  tired: [0.18, 0.38], exhausted: [0.1, 0.3], drained: [0.12, 0.3], sluggish: [0.2, 0.4],
  lazy: [0.2, 0.5], bored: [0.28, 0.35], meh: [0.3, 0.4], numb: [0.2, 0.25],
  low: [0.22, 0.25], down: [0.22, 0.22], sad: [0.2, 0.15], blue: [0.25, 0.2],
  lonely: [0.22, 0.18], heartbroken: [0.2, 0.08], depressed: [0.12, 0.08], gloomy: [0.25, 0.18],
  hopeless: [0.15, 0.08], empty: [0.15, 0.2], unmotivated: [0.18, 0.3], sick: [0.15, 0.3],
  headache: [0.3, 0.3], nauseous: [0.3, 0.3], weak: [0.15, 0.35], slow: [0.2, 0.42],
  anxious: [0.75, 0.25], nervous: [0.7, 0.3], stressed: [0.78, 0.22], overwhelmed: [0.8, 0.2],
  panicky: [0.9, 0.15], restless: [0.72, 0.38], tense: [0.72, 0.3], worried: [0.65, 0.25],
  angry: [0.88, 0.12], mad: [0.85, 0.15], furious: [0.95, 0.08], frustrated: [0.75, 0.2],
  irritated: [0.7, 0.25], annoyed: [0.65, 0.3], wired: [0.85, 0.5], jittery: [0.8, 0.4],
  scattered: [0.7, 0.4], distracted: [0.62, 0.45], unfocused: [0.6, 0.42],
  calm: [0.25, 0.65], relaxed: [0.25, 0.7], peaceful: [0.2, 0.72], chill: [0.32, 0.65],
  content: [0.35, 0.72], fine: [0.45, 0.6], okay: [0.45, 0.55], ok: [0.45, 0.55],
  good: [0.55, 0.75], happy: [0.65, 0.85], great: [0.7, 0.85], joyful: [0.72, 0.92],
  excited: [0.85, 0.85], hyped: [0.92, 0.82], pumped: [0.92, 0.78], energetic: [0.85, 0.75],
  confident: [0.7, 0.8], grateful: [0.45, 0.85], loved: [0.5, 0.9], romantic: [0.45, 0.82],
  udaas: [0.2, 0.15], dukhi: [0.2, 0.12], khush: [0.65, 0.85], thaka: [0.15, 0.38], thaki: [0.15, 0.38], bore: [0.28, 0.35],
  pareshan: [0.72, 0.25], gussa: [0.88, 0.12], tension: [0.75, 0.22], tensed: [0.75, 0.22], neend: [0.12, 0.45],
  nostalgic: [0.35, 0.45], dreamy: [0.3, 0.6], thoughtful: [0.35, 0.5], focused: [0.5, 0.55],
};

// Words that name where the listener wants to GO. Override the default target.
const INTENT_WORDS = {
  energy: [0.88, 0.78], energetic: [0.88, 0.78], lift: [0.8, 0.8], boost: [0.85, 0.75],
  wake: [0.8, 0.7], awake: [0.8, 0.7], pump: [0.92, 0.75], hype: [0.92, 0.8],
  party: [0.92, 0.85], dance: [0.88, 0.85], workout: [0.95, 0.65], gym: [0.95, 0.65], run: [0.92, 0.7],
  calm: [0.2, 0.65], relax: [0.22, 0.68], chill: [0.32, 0.65], unwind: [0.25, 0.65],
  breathe: [0.18, 0.6], slow: [0.25, 0.55], soothe: [0.2, 0.62],
  sleep: [0.08, 0.5], rest: [0.12, 0.55], nap: [0.1, 0.5],
  focus: [0.45, 0.5], study: [0.4, 0.5], work: [0.5, 0.55], code: [0.5, 0.5], concentrate: [0.45, 0.5],
  happy: [0.7, 0.88], cheer: [0.72, 0.88], smile: [0.65, 0.9], uplift: [0.7, 0.85], better: [0.6, 0.78],
  cry: [0.2, 0.12], wallow: [0.2, 0.12],
  josh: [0.9, 0.78], sukoon: [0.2, 0.68], padhai: [0.42, 0.5], nachna: [0.92, 0.85], romantic: [0.45, 0.82], lofi: [0.3, 0.5], feel: null, romance: [0.45, 0.82],
};

const INTENT_CUES = ['need', 'want', 'help', 'make me', 'get me', 'to', 'into', 'for', "let's", 'lets'];
const NEGATIONS = new Set(['not', "don't", 'dont', 'no', 'never', "isn't", "can't", 'cant', 'cannot']);
const INTENSIFIERS = { very: 1.25, so: 1.2, really: 1.2, super: 1.3, extremely: 1.4, totally: 1.25, bit: 0.7, little: 0.7, slightly: 0.6, kinda: 0.75 };

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

// Common phrases rewritten into words the vocabulary knows.
const PHRASES = [
  [/\b(can'?t|cannot|unable to|not able to) (focus|concentrate|think)\b/g, 'distracted need focus'],
  [/\b(can'?t|cannot) sleep\b/g, 'restless need sleep'],
  [/\b(wake me up|get me going)\b/g, 'need energy'],
  [/\b(calm me down|chill me out)\b/g, 'need calm'],
  [/\bhead ?ache\b/g, 'headache'],
];

function tokenize(text) {
  let t = text.toLowerCase().replace(/[’‘]/g, "'");
  for (const [re, sub] of PHRASES) t = t.replace(re, sub);
  return t.replace(/[^a-z'\s]/g, ' ').split(/\s+/).filter(Boolean);
}

// Small stemmer so "lifting", "calmer", "tiredness" still match.
function lookup(dict, word) {
  if (word in dict) return [word, dict[word]];
  for (const suf of ['ness', 'ing', 'ed', 'er', 'ly', 's', 'y']) {
    if (word.endsWith(suf)) {
      const base = word.slice(0, -suf.length);
      if (base in dict) return [base, dict[base]];
      if (base + 'e' in dict) return [base + 'e', dict[base + 'e']];
    }
  }
  return null;
}

/** Read free text. Returns { current, target, from, to, words, confident }. */
export function readMood(text) {
  const tokens = tokenize(text);
  let cur = [0, 0], curW = 0, tgt = null, tgtW = 0;
  const words = [];
  let intentMode = false;

  tokens.forEach((tok, i) => {
    const prev = tokens[i - 1], prev2 = tokens[i - 2];
    if (INTENT_CUES.includes(tok) || (tok === 'me' && prev === 'make')) intentMode = true;
    const negated = NEGATIONS.has(prev) || NEGATIONS.has(prev2);
    const boost = INTENSIFIERS[prev] || INTENSIFIERS[prev2] || 1;

    const intent = lookup(INTENT_WORDS, tok);
    const state = lookup(STATE_WORDS, tok);

    if (intent && intent[1] && (intentMode || !state)) {
      if (!negated) { tgt = tgt ? tgt.map((v, k) => v + intent[1][k]) : [...intent[1]]; tgtW++; words.push({ w: intent[0], role: 'want' }); }
      return;
    }
    if (state) {
      let [e, v] = state[1];
      if (negated) { e = 1 - e * 0.6 - 0.2; v = 1 - v; }
      // Intensity pushes the point away from the neutral centre.
      e = clamp(0.5 + (e - 0.5) * boost); v = clamp(0.5 + (v - 0.5) * boost);
      cur[0] += e; cur[1] += v; curW++;
      words.push({ w: (negated ? 'not ' : '') + state[0], role: 'feel' });
    }
  });

  const confident = curW + tgtW > 0;
  const current = curW ? { energy: cur[0] / curW, valence: cur[1] / curW } : { energy: 0.45, valence: 0.5 };
  const target = tgtW ? { energy: tgt[0] / tgtW, valence: tgt[1] / tgtW } : defaultTarget(current);

  return { current, target, from: describe(current), to: describe(target), words, confident };
}

// Music-therapy rule of thumb: lift low states, settle tense ones, ride good ones.
function defaultTarget({ energy: e, valence: v }) {
  if (e < 0.45 && v < 0.25) return { energy: 0.62, valence: 0.75 };     // sad, heartbroken -> gentle lift
  if (e < 0.45 && v < 0.5) return { energy: 0.85, valence: 0.8 };       // dizzy, tired, foggy -> energetic
  if (e >= 0.6 && v < 0.45) return { energy: 0.25, valence: 0.65 };      // anxious, angry -> calm
  if (e < 0.45) return { energy: 0.6, valence: Math.max(v, 0.7) };       // calm/dreamy -> gentle lift
  if (v >= 0.6) return { energy: clamp(e + 0.05), valence: clamp(v + 0.05) }; // happy -> keep riding
  return { energy: 0.5, valence: 0.7 };                                  // in-between -> steady and bright
}

/** Plain-language name for a point in mood space. */
export function describe({ energy: e, valence: v }) {
  if (e < 0.16) return v < 0.4 ? 'Drained' : 'Sleepy';
  if (e < 0.42) return v < 0.35 ? 'Low' : v < 0.6 ? 'Slow and foggy' : 'Calm';
  if (e < 0.62) return v < 0.35 ? 'Uneasy' : v < 0.6 ? 'Steady' : 'Bright and easy';
  if (e < 0.8) return v < 0.35 ? 'Tense' : v < 0.65 ? 'Restless' : 'Upbeat';
  return v < 0.35 ? 'Wound up' : v < 0.6 ? 'Wired' : 'Energetic';
}

/** Quick shortcut moods for the chips. */
export const SHORTCUTS = [
  { label: 'Dizzy, need energy', text: "I'm feeling dizzy and slow, need energy" },
  { label: "Can't focus", text: "I'm distracted and scattered, need to focus" },
  { label: 'Anxious', text: "I'm anxious and tense, help me calm down" },
  { label: 'Feeling low', text: "I'm feeling low and lonely" },
  { label: 'Party mode', text: "I'm happy, let's party" },
  { label: 'Wind down', text: "I'm wired and restless, need sleep" },
];

const dist = (a, b) => Math.hypot((a.energy - b.energy) * 1.15, a.valence - b.valence);
const ease = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** Filters the listener can set. All optional. */
export const DEFAULT_FILTERS = {
  maxPerArtist: 2,      // 0 = no limit
  familiarity: 0.5,     // 0 = prefer new finds, 1 = prefer songs you already play
  variety: 0.25,        // 0 = closest match every time, 1 = more surprise
  origin: 'any',        // 'any' | 'in' (Indian releases) | 'intl'
  leaveOut: [],         // tags: explicit, slowed, remix, devotional, calmtrack, recent
};

/** Why a track was left out by the filters, or null if it stays. */
export function filteredOut(t, f, recentIds) {
  const tags = t.tags || [];
  for (const tag of f.leaveOut || []) {
    if (tag === 'explicit' && t.explicit) return tag;
    if (tag === 'recent' && recentIds?.has(t.id)) return tag;
    if (tags.includes(tag)) return tag;
  }
  if (f.origin === 'in' && !(t.isrc || '').startsWith('IN')) return 'origin';
  if (f.origin === 'intl' && (t.isrc || '').startsWith('IN')) return 'origin';
  return null;
}

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) ^ (s + 0x9e3779b9)) >>> 0) / 4294967296; }

/**
 * Sequence tracks from the current state to the target (the "iso principle":
 * meet the listener first, then move gradually). Returns tracks with a `phase`.
 * opts: filters (see DEFAULT_FILTERS), seed (changes the mix), recentIds (Set).
 */
export function sequence(tracks, reading, length = 18, opts = {}) {
  const f = { ...DEFAULT_FILTERS, ...(opts.filters || {}) };
  const rand = rng(opts.seed || 1);
  const pool = tracks.filter(t => !filteredOut(t, f, opts.recentIds));
  const n = Math.min(length, pool.length);
  if (!n) return [];
  const { current: a, target: b } = reading;
  const meetCount = Math.max(2, Math.round(n * 0.22));
  const arriveCount = Math.max(2, Math.round(n * 0.25));
  const noise = new Map(pool.map(t => [t.id, rand()]));
  const perArtist = new Map();
  const out = [];
  let prev = null;

  for (let i = 0; i < n; i++) {
    let t;
    if (i < meetCount) t = (i / meetCount) * 0.12;
    else if (i >= n - arriveCount) t = 1;
    else t = 0.12 + 0.88 * ease((i - meetCount + 1) / (n - meetCount - arriveCount + 1));
    const want = { energy: a.energy + (b.energy - a.energy) * t, valence: a.valence + (b.valence - a.valence) * t };

    let best = -1, bestScore = Infinity, bestDist = 0;
    pool.forEach((tr, k) => {
      const count = perArtist.get(tr.mainArtist || tr.artist) || 0;
      if (f.maxPerArtist && count >= f.maxPerArtist) return;
      const d = dist(tr, want);
      let s = d;
      if (prev) {
        s += Math.min(Math.abs(tr.tempo - prev.tempo) / 400, 0.12);  // smooth tempo jumps
        if ((tr.mainArtist || tr.artist) === (prev.mainArtist || prev.artist)) s += 0.12; // no back-to-back artist
        if (tr.albumId && tr.albumId === prev.albumId) s += 0.05;
      }
      s += count * 0.04;                                              // spread artists out
      s += (tr.familiar ? -1 : 1) * (f.familiarity - 0.5) * 0.12;      // familiar vs new
      s += tr.measured ? 0 : 0.03;                                    // trust measured songs a bit more
      s += noise.get(tr.id) * f.variety * 0.22;                       // surprise
      if (s < bestScore) { bestScore = s; best = k; bestDist = d; }
    });
    if (best < 0) break; // artist limit used everything up
    const [pick] = pool.splice(best, 1);
    const key = pick.mainArtist || pick.artist;
    perArtist.set(key, (perArtist.get(key) || 0) + 1);
    prev = pick;
    const phase = i < meetCount ? 'meet' : i >= n - arriveCount ? 'arrive' : 'move';
    out.push({ ...pick, phase, fit: clamp(1 - bestDist * 1.6) });
  }
  return out;
}

/** Catalogue searches that should surface songs for the start and end of this mood path. */
export function discoverQueries(reading, region = '') {
  const zone = ({ energy: e, valence: v }) =>
    e >= 0.62 ? (v >= 0.5 ? ['party', 'dance', 'workout'] : ['rap', 'rock anthem', 'phonk'])
    : e >= 0.4 ? (v >= 0.5 ? ['feel good', 'upbeat'] : ['sad', 'emotional'])
    : v >= 0.5 ? ['romantic', 'acoustic', 'chill'] : v >= 0.3 ? ['chill', 'lofi', 'soft'] : ['sad', 'heartbreak', 'lofi'];
  const words = [...new Set([...zone(reading.current).slice(0, 2), ...zone(reading.target)])];
  const regional = region === 'IN' ? words.map(w => `${w} hindi`) : [];
  return [...new Set([...regional.slice(0, 3), ...words.slice(0, 3)])].slice(0, 6);
}

// --- Working out a track's vibe ---
// Energy comes mostly from measured loudness (Deezer's "gain"); genre and the
// title's words (English and Hindi) adjust energy and supply mood.

const GENRES = {
  // genre: [energy shift, typical mood]
  'Dance': [0.15, 0.78], 'Electro': [0.15, 0.62], 'Rap/Hip Hop': [0.1, 0.5], 'Rock': [0.1, 0.5], 'Metal': [0.2, 0.3],
  'Alternative': [0.02, 0.45], 'Pop': [0.05, 0.66], 'Latin Music': [0.1, 0.8], 'Reggae': [0, 0.8], 'R&B': [-0.05, 0.55],
  'Soul & Funk': [0.05, 0.7], 'Jazz': [-0.1, 0.62], 'Blues': [-0.08, 0.32], 'Folk': [-0.1, 0.5], 'Country': [-0.05, 0.62],
  'Classical': [-0.3, 0.45], 'Opera': [-0.2, 0.45], 'Films/Games': [0, 0.52], 'Film Scores': [-0.05, 0.48],
  'Bollywood': [0.05, 0.6], 'Indian Music': [0, 0.52], 'Asian Music': [0, 0.52], 'Kids': [0.05, 0.85], 'Relaxation': [-0.3, 0.6],
};

// [pattern, energy shift, mood shift, tag]
const WORDS = [
  [/\b(sad|cry|crying|tears|alone|lonely|broken|hurt|goodbye|miss you|pain|tanha|tanhai|judaai|judai|dard|bewafa|alvida|aansu|aansoo|toota|tuta|barbaad|tadap|rona|udaas|gham|gam|bichhad|bichad|akela|intezaar|zakhm|dhokha|khamoshi|channa mereya|agar tum saath)\b/, -0.08, -0.22],
  [/\b(ishq|pyaar|pyar|mohabbat|sanam|humsafar|love|kahaani|kahani|dil|jaan|tera|tujhe|saiyaara|raanjhana|romance)\b/, -0.02, 0.08],
  [/\b(party|dance|nachle|naach|nach|dhol|balle|bhangra|garba|tauba|jhoom|masti|thumka|chamma|lit|banger|swag|gaddi|peg|daaru|sharaab|club|hookah|disco|desi|jumme|mehbooba|kala chashma)\b/, 0.18, 0.18],
  [/\b(power|alive|run|jump|workout|gym|beast|warrior|josh|zinda|junoon|fire|wild|energy|rise|fight|bad|boss|king)\b/, 0.12, 0.04],
  [/\b(happy|smile|sun|sunshine|good|celebrate|mubarak|khushi|khush|badhai|shine|gold)\b/, 0.05, 0.16],
  [/\b(bappa|ganpati|ganesh|krishna|shiv|shiva|mahadev|ram|hanuman|mata|maa|aarti|bhajan|mantra|om|dwarika|naath|sai|waheguru|maula|khwaja|kun faya|shyam|radhe|jai)\b/, -0.08, 0.12, 'devotional'],
  [/\b(meditation|sleep|lullaby|calm|rain|ocean|ambient|flute|instrumental|healing|hz|binaural|white noise)\b/, -0.25, 0.05, 'calmtrack'],
  [/\b(slowed|reverb|lofi|lo-fi|lo fi|unplugged|acoustic|reprise|sad version|female version|piano version)\b/, -0.18, -0.04, 'slowed'],
  [/\b(remix|mix|mashup|club mix|dj|edm|bass boosted|phonk|funk|drill|trap)\b/, 0.15, 0.04, 'remix'],
];

function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * Energy, mood and tempo for a Spotify track, given Deezer facts (or null).
 * Returns { energy, valence, tempo, measured, estimated, genres, tags, gain }.
 */
export function vibeFromFacts(t, facts) {
  const text = `${t.name} ${t.album || ''}`.toLowerCase();
  const genres = facts?.genres || [];
  const tags = [];
  let eShift = 0, vShift = 0, matched = 0;
  for (const [re, de, dv, tag] of WORDS) if (re.test(text)) { eShift += de; vShift += dv; matched++; if (tag) tags.push(tag); }

  let gE = 0, gV = 0, gw = 0;
  for (const g of genres) if (GENRES[g]) { gE += GENRES[g][0]; gV += GENRES[g][1]; gw++; }
  if (gw) { gE /= gw; gV /= gw; }
  if (genres.includes('Classical') || genres.includes('Relaxation')) tags.push('calmtrack');

  const measured = typeof facts?.gain === 'number';
  let energy = measured
    ? clamp((facts.gain + 16) / 13)                         // -16 dB ≈ very soft, -3 dB ≈ very loud
    : 0.45 + (hash01(t.id + 'e') - 0.5) * 0.2 + ((t.popularity ?? 50) - 50) / 600;
  energy = clamp(energy * 0.8 + 0.1 + gE + eShift, 0.03, 0.98);

  let valence = gw ? gV : 0.5 + (hash01(t.id + 'v') - 0.5) * 0.2;
  valence = clamp(valence + vShift + (energy - 0.5) * 0.15, 0.04, 0.96);

  const tempo = facts?.bpm > 40 ? Math.round(facts.bpm) : Math.round(70 + energy * 80);
  return { energy, valence, tempo, measured, estimated: !measured, genres, tags: [...new Set(tags)], gain: facts?.gain ?? null, wordsMatched: matched };
}

/** Older name kept for the sample library and any static-hosted build. */
export const estimateVibe = t => vibeFromFacts(t, null);

// --- The mood-ring colour ramp: colour is data, not decoration ---

export const RAMP = [
  [0.0, [59, 91, 219]],   // calm blue
  [0.3, [32, 201, 151]],  // teal
  [0.55, [250, 176, 5]],  // amber
  [0.75, [253, 126, 20]], // orange
  [1.0, [230, 73, 128]],  // magenta
];

/** Where a vibe sits on the ring (0 calm .. 1 intense). */
export const vibeIndex = ({ energy, valence }) => clamp(energy * 0.7 + valence * 0.3);

export function rampColor(t) {
  t = clamp(t);
  for (let i = 1; i < RAMP.length; i++) {
    const [t1, c1] = RAMP[i], [t0, c0] = RAMP[i - 1];
    if (t <= t1) {
      const k = (t - t0) / (t1 - t0);
      return c0.map((c, j) => Math.round(c + (c1[j] - c) * k));
    }
  }
  return RAMP[RAMP.length - 1][1];
}

// Comma syntax so both CSS and Three.js colour parsing accept it.
export const rgb = c => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
export const vibeColor = f => rgb(rampColor(vibeIndex(f)));
