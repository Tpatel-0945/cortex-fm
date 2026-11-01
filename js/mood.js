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


// A much wider vocabulary of feelings, merged into STATE_WORDS. [energy, valence]
Object.assign(STATE_WORDS, {
  // sadness, hurt, loss
  sorrowful: [0.18, 0.12], miserable: [0.2, 0.08], grieving: [0.15, 0.06], grief: [0.15, 0.06], mourning: [0.15, 0.06],
  crushed: [0.2, 0.08], devastated: [0.2, 0.05], broken: [0.18, 0.07], hurt: [0.3, 0.15], wounded: [0.28, 0.12],
  melancholy: [0.22, 0.25], melancholic: [0.22, 0.25], wistful: [0.28, 0.4], teary: [0.25, 0.15], tearful: [0.25, 0.15],
  crying: [0.3, 0.1], weepy: [0.25, 0.15], disappointed: [0.3, 0.22], discouraged: [0.25, 0.22], dejected: [0.2, 0.15],
  despair: [0.15, 0.05], desperate: [0.6, 0.12], unhappy: [0.3, 0.2], upset: [0.55, 0.18], regretful: [0.28, 0.2],
  guilty: [0.4, 0.18], ashamed: [0.35, 0.15], embarrassed: [0.55, 0.25], humiliated: [0.55, 0.12], rejected: [0.3, 0.12],
  abandoned: [0.25, 0.1], isolated: [0.2, 0.18], alone: [0.22, 0.22], homesick: [0.28, 0.25], miss: [0.3, 0.28],
  longing: [0.33, 0.3], yearning: [0.38, 0.32], pining: [0.3, 0.28], worthless: [0.15, 0.08], insecure: [0.55, 0.25],
  vulnerable: [0.4, 0.3], fragile: [0.3, 0.3], sensitive: [0.4, 0.4], hollow: [0.15, 0.15], lost: [0.3, 0.25],
  helpless: [0.3, 0.12], powerless: [0.3, 0.15], defeated: [0.2, 0.12], heavy: [0.25, 0.2], gutted: [0.25, 0.08],
  sentimental: [0.3, 0.5], emotional: [0.4, 0.3], moody: [0.45, 0.3], hurting: [0.3, 0.12], suicidal: [0.15, 0.03],
  // tiredness and illness
  burnout: [0.12, 0.2], fatigued: [0.14, 0.35], weary: [0.18, 0.35], spent: [0.15, 0.38], lethargic: [0.15, 0.35],
  drowsy: [0.14, 0.45], zombie: [0.15, 0.35], hungover: [0.2, 0.3], jetlagged: [0.2, 0.38], ill: [0.18, 0.3],
  unwell: [0.2, 0.3], feverish: [0.3, 0.25], sore: [0.3, 0.35], pain: [0.35, 0.2], cramps: [0.3, 0.25], dull: [0.25, 0.38],
  // fear and worry
  scared: [0.75, 0.15], afraid: [0.72, 0.15], fearful: [0.72, 0.15], terrified: [0.92, 0.08], frightened: [0.85, 0.12],
  panicked: [0.9, 0.12], panic: [0.9, 0.12], uneasy: [0.62, 0.3], apprehensive: [0.62, 0.32], dread: [0.6, 0.12],
  paranoid: [0.78, 0.18], shaky: [0.7, 0.3], edgy: [0.72, 0.32], agitated: [0.8, 0.2], frazzled: [0.78, 0.25],
  burdened: [0.5, 0.2], pressured: [0.72, 0.25], pressure: [0.72, 0.25], rushed: [0.8, 0.35], hectic: [0.8, 0.35],
  busy: [0.7, 0.45], impatient: [0.75, 0.3], jealous: [0.68, 0.18], envious: [0.6, 0.2], suspicious: [0.6, 0.3],
  confused: [0.55, 0.35], uncertain: [0.5, 0.38], doubtful: [0.45, 0.32], insomnia: [0.65, 0.3], sleepless: [0.65, 0.3],
  // anger
  enraged: [0.97, 0.05], livid: [0.95, 0.06], outraged: [0.92, 0.08], raging: [0.95, 0.08], rage: [0.95, 0.08],
  fuming: [0.9, 0.1], pissed: [0.88, 0.12], bitter: [0.55, 0.15], resentful: [0.6, 0.15], hostile: [0.85, 0.1],
  grumpy: [0.5, 0.25], cranky: [0.55, 0.25], salty: [0.55, 0.3], disgusted: [0.65, 0.12], offended: [0.6, 0.2],
  betrayed: [0.55, 0.08], vengeful: [0.85, 0.1], aggressive: [0.9, 0.25], hateful: [0.85, 0.08],
  // calm, safe, settled
  serene: [0.18, 0.75], tranquil: [0.18, 0.75], mellow: [0.3, 0.65], cozy: [0.28, 0.72], cosy: [0.28, 0.72],
  comfy: [0.28, 0.7], safe: [0.3, 0.7], secure: [0.35, 0.72], balanced: [0.4, 0.68], centered: [0.38, 0.68],
  grounded: [0.38, 0.66], zen: [0.2, 0.72], easygoing: [0.38, 0.68], rested: [0.45, 0.72], relieved: [0.35, 0.75],
  satisfied: [0.4, 0.78], fulfilled: [0.45, 0.82], blessed: [0.45, 0.88], thankful: [0.45, 0.85], unbothered: [0.35, 0.6],
  meditative: [0.18, 0.6], spiritual: [0.25, 0.65], reflective: [0.3, 0.5], pensive: [0.3, 0.42], introspective: [0.3, 0.45],
  contemplative: [0.28, 0.5], tender: [0.3, 0.75], soft: [0.28, 0.65],
  // neutral and in-between
  indifferent: [0.3, 0.4], apathetic: [0.2, 0.3], neutral: [0.45, 0.5], normal: [0.45, 0.55], alright: [0.45, 0.58],
  decent: [0.5, 0.6], shy: [0.35, 0.45], awkward: [0.5, 0.35], curious: [0.58, 0.68], mysterious: [0.4, 0.45],
  dark: [0.5, 0.2], surprised: [0.75, 0.6], shocked: [0.8, 0.35], hungry: [0.5, 0.45],
  // joy and energy
  hopeful: [0.5, 0.72], optimistic: [0.6, 0.78], inspired: [0.7, 0.8], motivated: [0.78, 0.72], determined: [0.78, 0.6],
  driven: [0.8, 0.62], ambitious: [0.75, 0.65], productive: [0.65, 0.68], creative: [0.6, 0.72], playful: [0.7, 0.85],
  silly: [0.7, 0.82], goofy: [0.72, 0.82], cheerful: [0.68, 0.88], glad: [0.58, 0.82], delighted: [0.72, 0.9],
  ecstatic: [0.92, 0.95], elated: [0.88, 0.95], euphoric: [0.92, 0.95], thrilled: [0.88, 0.9], overjoyed: [0.88, 0.95],
  blissful: [0.55, 0.95], bliss: [0.55, 0.95], proud: [0.7, 0.85], accomplished: [0.65, 0.85], victorious: [0.88, 0.9],
  brave: [0.75, 0.7], bold: [0.78, 0.72], fearless: [0.8, 0.72], strong: [0.75, 0.72], powerful: [0.85, 0.75],
  unstoppable: [0.95, 0.8], invincible: [0.92, 0.8], alive: [0.78, 0.82], lively: [0.78, 0.8], vibrant: [0.8, 0.85],
  bubbly: [0.78, 0.88], sunny: [0.65, 0.88], fresh: [0.6, 0.78], refreshed: [0.6, 0.78], carefree: [0.55, 0.82],
  free: [0.6, 0.8], light: [0.5, 0.72], awesome: [0.75, 0.88], amazing: [0.75, 0.9], fantastic: [0.78, 0.9],
  wonderful: [0.65, 0.9], lit: [0.92, 0.82], vibing: [0.6, 0.78], groovy: [0.72, 0.8], funky: [0.75, 0.78],
  wild: [0.92, 0.75], crazy: [0.88, 0.6], reckless: [0.9, 0.5], rebellious: [0.85, 0.45], adventurous: [0.8, 0.78],
  savage: [0.9, 0.45], beast: [0.92, 0.6], hyper: [0.88, 0.55], amazed: [0.78, 0.85], awestruck: [0.65, 0.85],
  impressed: [0.65, 0.8], festive: [0.82, 0.9], celebratory: [0.85, 0.92], lucky: [0.65, 0.85],
  // love
  flirty: [0.62, 0.82], sexy: [0.65, 0.75], passionate: [0.75, 0.75], affectionate: [0.45, 0.85], sweet: [0.45, 0.82],
  smitten: [0.55, 0.88], adored: [0.5, 0.9], appreciated: [0.45, 0.85], crush: [0.55, 0.8], lovesick: [0.35, 0.4],
  // Hindi / Hinglish
  akela: [0.22, 0.18], akeli: [0.22, 0.18], tanha: [0.22, 0.18], tanhai: [0.22, 0.18], bechain: [0.72, 0.3],
  bechaini: [0.72, 0.3], bekarar: [0.7, 0.4], pyaar: [0.45, 0.85], pyar: [0.45, 0.85], ishq: [0.5, 0.85],
  mohabbat: [0.45, 0.85], dard: [0.3, 0.15], gham: [0.2, 0.1], yaad: [0.3, 0.35], mast: [0.65, 0.85], masti: [0.8, 0.85],
  bindaas: [0.7, 0.82], jhakaas: [0.8, 0.88], khushi: [0.65, 0.88], dukh: [0.2, 0.12], rona: [0.3, 0.1],
  chinta: [0.65, 0.25], darr: [0.75, 0.15], thakan: [0.15, 0.38], thakaan: [0.15, 0.38], sust: [0.2, 0.4],
  aalas: [0.2, 0.45], aalsi: [0.2, 0.45], junoon: [0.88, 0.7], tension: [0.75, 0.22], pagal: [0.85, 0.6],
  maza: [0.7, 0.85], mazaa: [0.7, 0.85], shaant: [0.2, 0.68], shant: [0.2, 0.68], bura: [0.3, 0.2], acha: [0.55, 0.72],
  accha: [0.55, 0.72], badhiya: [0.65, 0.82], zabardast: [0.8, 0.88], dhamaal: [0.9, 0.88], ghabrahat: [0.78, 0.2],
  udasi: [0.2, 0.15], naraz: [0.7, 0.18], naraaz: [0.7, 0.18], pareshaan: [0.72, 0.25], khafa: [0.7, 0.18],
  bimaar: [0.15, 0.3], beemar: [0.15, 0.3], umang: [0.75, 0.85],
});

// More places to go.
Object.assign(INTENT_WORDS, {
  energize: [0.88, 0.78], energise: [0.88, 0.78], motivate: [0.8, 0.75], motivation: [0.8, 0.75], inspire: [0.7, 0.8],
  celebrate: [0.88, 0.9], celebration: [0.88, 0.9], vibe: [0.6, 0.75], groove: [0.75, 0.8], drive: [0.7, 0.72],
  travel: [0.65, 0.75], meditate: [0.15, 0.62], meditation: [0.15, 0.62], yoga: [0.25, 0.65], heal: [0.3, 0.65],
  healing: [0.3, 0.65], comfort: [0.3, 0.7], hug: [0.35, 0.75], read: [0.3, 0.55], reading: [0.3, 0.55],
  cook: [0.55, 0.7], cooking: [0.55, 0.7], clean: [0.7, 0.7], cleaning: [0.7, 0.7], shower: [0.65, 0.75],
  sing: [0.7, 0.8], karaoke: [0.8, 0.85], jam: [0.75, 0.8], cardio: [0.95, 0.7], sprint: [0.95, 0.7],
  cycle: [0.85, 0.7], walk: [0.55, 0.7], jog: [0.8, 0.7], date: [0.5, 0.85], love: [0.5, 0.88], vent: [0.85, 0.2],
  scream: [0.95, 0.2], sad: [0.22, 0.15], dark: [0.5, 0.2], emotional: [0.3, 0.25], nostalgia: [0.35, 0.45],
  throwback: [0.6, 0.7], retro: [0.6, 0.72], forget: [0.6, 0.6], distract: [0.65, 0.7], escape: [0.6, 0.65],
  dream: [0.3, 0.6], float: [0.3, 0.62], drift: [0.2, 0.6], lullaby: [0.08, 0.55], garba: [0.9, 0.88],
  bhangra: [0.92, 0.88], dhol: [0.9, 0.85], shaadi: [0.85, 0.9], wedding: [0.8, 0.9], birthday: [0.82, 0.92],
  festival: [0.85, 0.9], diwali: [0.75, 0.9], holi: [0.9, 0.9], bhakti: [0.3, 0.7], prayer: [0.2, 0.68],
  pray: [0.2, 0.68], peace: [0.2, 0.7], hype: [0.92, 0.8], rage: [0.95, 0.15], confidence: [0.75, 0.8],
  hustle: [0.8, 0.65], grind: [0.8, 0.6], game: [0.85, 0.65], gaming: [0.85, 0.65],
});

const INTENT_CUES = ['need', 'want', 'help', 'make me', 'get me', 'to', 'into', 'for', "let's", 'lets', 'play', 'give', 'gimme', 'wanna', 'needs', 'craving', 'chahiye', 'karna', 'karni', 'chaiye'];
const NEGATIONS = new Set(['not', "don't", 'dont', 'no', 'never', "isn't", "can't", 'cant', 'cannot', "won't", 'wont', "wasn't", "aren't", "ain't", 'hardly', 'barely', 'mat']);
// Hindi puts the "not" after the feeling: "khush nahi".
const POST_NEGATIONS = new Set(['nahi', 'nahin', 'nai', 'nhi']);
const INTENSIFIERS = { very: 1.25, so: 1.2, really: 1.2, super: 1.3, extremely: 1.4, totally: 1.25, too: 1.2, quite: 1.1, pretty: 1.1,
  mega: 1.3, utterly: 1.4, absolutely: 1.35, incredibly: 1.35, insanely: 1.4, deeply: 1.3, completely: 1.35, seriously: 1.25, damn: 1.2,
  bahut: 1.25, bohot: 1.25, bahot: 1.25, kaafi: 1.15, ekdum: 1.3, bilkul: 1.3,
  bit: 0.7, little: 0.7, slightly: 0.6, kinda: 0.75, somewhat: 0.75, sorta: 0.75, thoda: 0.7, thodi: 0.7, halka: 0.7 };

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

// Common phrases rewritten into words the vocabulary knows.
const PHRASES = [
  [/\b(can'?t|cannot|unable to|not able to) (focus|concentrate|think)\b/g, 'distracted need focus'],
  [/\b(can'?t|cannot) sleep\b/g, 'restless need sleep'],
  [/\b(wake me up|get me going)\b/g, 'need energy'],
  [/\b(calm me down|chill me out)\b/g, 'need calm'],
  [/\bhead ?ache\b/g, 'headache'],
  [/\bburn(t|ed)? ?out\b/g, 'burnout'],
  [/\bfed up\b/g, 'frustrated'],
  [/\bover ?think\w*\b/g, 'anxious worried'],
  [/\bin love\b/g, 'loved romantic'],
  [/\bbutterflies\b/g, 'excited loved'],
  [/\b(on top of the world|on cloud nine|over the moon)\b/g, 'ecstatic'],
  [/\b(heart ?break|broken heart|heart is broken|break ?up|broke up|dumped)\b/g, 'heartbroken'],
  [/\bmiss(ing)? (him|her|them|you|someone|somebody|home|my \w+|mom|dad|family|friends?)\b/g, 'longing'],
  [/\bmood (is )?(off|kharab|kharaab|bad)\b/g, 'low annoyed'],
  [/\bmood (is )?(on|set|good|great)\b/g, 'happy'],
  [/\bdil (toot|tut)\w*\b/g, 'heartbroken'],
  [/\bdil (khush|garden)\w*\b/g, 'joyful'],
  [/\b(stress(ed)?|freak(ed|ing)?|psyched) out\b/g, 'panicky'],
  [/\bon edge\b/g, 'tense'],
  [/\b(on fire|killing it|crushing it)\b/g, 'unstoppable'],
  [/\b(feel|feeling|felt) (like )?(crap|shit|trash|garbage|rubbish)\b/g, 'miserable'],
  [/\b(sleep deprived|no sleep|didn'?t sleep|up all night)\b/g, 'exhausted'],
  [/\b(long|rough|bad|tough|hard|terrible|awful) (day|week|night)\b/g, 'drained stressed'],
  [/\b(good|great|amazing|best|awesome) (day|week|night)\b/g, 'happy'],
  [/\b(rainy|cloudy|grey|gray) (day|weather|evening|morning)\b/g, 'wistful'],
  [/\b(road ?trip|long drive)\b/g, 'want drive'],
  [/\b(getting|get) (ready|dressed)\b/g, 'want hype'],
  [/\bgood vibes?\b/g, 'want happy'],
  [/\b(let off steam|blow off steam)\b/g, 'want vent'],
  [/\b(lonely|alone) at night\b/g, 'lonely'],
  [/\b(late|lonely) night drive\b/g, 'wistful want drive'],
  [/\bfeeling myself\b/g, 'confident'],
  [/\b(mind|head) (is )?(racing|spinning)\b/g, 'anxious restless'],
  [/\bcan'?t stop crying\b/g, 'crying heartbroken'],
  // emojis
  [/(😭|😢|😞|😔|☹️|🙁|💔|🥺)/gu, ' sad '],
  [/(😡|🤬|😠|👿)/gu, ' angry '],
  [/(😴|🥱|💤)/gu, ' sleepy '],
  [/(😰|😟|😨|😱|😬)/gu, ' anxious '],
  [/(😊|😄|😁|😃|🙂|☺️|😀|😆)/gu, ' happy '],
  [/(🥳|🎉|🎊|🪩)/gu, ' want party '],
  [/(🔥|⚡)/gu, ' hyped '],
  [/(😍|🥰|❤️|💕|💖|😘|💘)/gu, ' loved '],
  [/(😌|🧘|🌿|🍃)/gu, ' calm '],
  [/(😎|💯)/gu, ' confident '],
  [/(🤯|😵)/gu, ' overwhelmed '],
  [/(😐|😑|😶)/gu, ' meh '],
  [/(🤒|🤢|🤮|🤕)/gu, ' sick '],
  [/(💪|🏋️|🏃)/gu, ' want workout '],
  [/(🌧️|☔|🌙)/gu, ' wistful '],
];

function tokenize(text) {
  let t = text.toLowerCase().replace(/[’‘]/g, "'").replace(/\b(\w+?)(\w)\2{2,}\b/g, '$1$2'); // "sooo" → "so", "happyyy" → "happy"
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
    const negated = NEGATIONS.has(prev) || NEGATIONS.has(prev2) || POST_NEGATIONS.has(tokens[i + 1]);
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

  const seen = new Set();
  const unique = words.filter(x => { const k = x.role + x.w; if (seen.has(k)) return false; seen.add(k); return true; });
  return { current, target, from: describe(current), to: describe(target), words: unique, confident };
}

// Music-therapy rule of thumb: lift low states, settle tense ones, ride good ones.
function defaultTarget({ energy: e, valence: v }) {
  if (e < 0.45 && v < 0.32) return { energy: 0.62, valence: 0.75 };     // sad, heartbroken, missing someone -> gentle lift
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
  { label: 'Missing someone', text: "I'm missing someone, feeling nostalgic" },
  { label: 'Heartbroken', text: "I'm heartbroken, can't stop crying" },
  { label: 'Celebrate', text: "I'm thrilled, let's celebrate" },
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

// Specific feelings get their own searches, so "nostalgic" finds throwbacks, not just "chill".
const FLAVOUR = {
  nostalgic: 'throwback', nostalgia: 'throwback', throwback: 'throwback', retro: 'retro', homesick: 'nostalgic',
  heartbroken: 'heartbreak', longing: 'missing you', miss: 'missing you', yaad: 'yaad', lonely: 'lonely', akela: 'tanhai',
  romantic: 'romantic', loved: 'love songs', love: 'love songs', pyaar: 'pyaar', ishq: 'ishq', smitten: 'love songs', crush: 'crush',
  angry: 'rage', furious: 'rage', rage: 'rage', vent: 'angry', pissed: 'rage', betrayed: 'betrayal',
  motivated: 'motivation', motivate: 'motivation', determined: 'motivation', hustle: 'hustle', grind: 'grind',
  confident: 'confidence', unstoppable: 'anthem', celebrate: 'celebration', birthday: 'birthday', wedding: 'wedding',
  shaadi: 'shaadi', garba: 'garba', bhangra: 'bhangra', diwali: 'diwali', holi: 'holi', bhakti: 'bhajan', prayer: 'devotional',
  meditate: 'meditation', meditation: 'meditation', yoga: 'yoga', sleep: 'sleep', lullaby: 'lullaby', rain: 'rain',
  wistful: 'rainy day', drive: 'road trip', travel: 'travel', sukoon: 'sukoon', peaceful: 'peaceful', serene: 'ambient',
  gaming: 'gaming', game: 'gaming', workout: 'workout', gym: 'gym', run: 'running', study: 'study', focus: 'focus',
  hopeful: 'hopeful', grateful: 'grateful', blessed: 'grateful', euphoric: 'euphoric', dark: 'dark', melancholy: 'melancholy',
  grief: 'grief', grieving: 'grief', burnout: 'healing', heal: 'healing', comfort: 'comfort',
};

/** Catalogue searches that should surface songs for the start and end of this mood path. */
export function discoverQueries(reading, region = '') {
  const zone = ({ energy: e, valence: v }) =>
    e >= 0.62 ? (v >= 0.5 ? ['party', 'dance', 'workout'] : ['rap', 'rock anthem', 'phonk'])
    : e >= 0.4 ? (v >= 0.5 ? ['feel good', 'upbeat'] : ['sad', 'emotional'])
    : v >= 0.5 ? ['romantic', 'acoustic', 'chill'] : v >= 0.3 ? ['chill', 'lofi', 'soft'] : ['sad', 'heartbreak', 'lofi'];
  const flavour = [...new Set((reading.words || []).map(x => FLAVOUR[x.w.replace(/^not /, '')]).filter(Boolean))].slice(0, 2);
  const words = [...new Set([...flavour, ...zone(reading.current).slice(0, 2), ...zone(reading.target)])];
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
