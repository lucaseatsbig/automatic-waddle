// Smart-search query parser. Takes a free-text input ("date night italian
// surry hills") and pulls out structured filters (cuisine, vibe, suburb,
// region) by matching the words against the page's known reference lists.
// Anything that doesn't match a known phrase falls back to the `q`
// free-text search after stopwords are stripped.
//
// Pure: no DOM, no fetch. Called by FilterBar and MobileFilterSheet on
// search-submit (Enter); the result is then turned into URL params and
// dispatched as a filter change.

export interface SmartParseRefData {
  cuisines: string[];
  regions: { slug: string; name: string }[];
  locations: { slug: string; name: string }[];
  tags: { slug: string; label: string; category?: string }[];
}

export interface SmartParseResult {
  cuisines: string[];
  regions: string[];
  suburbs: string[];
  vibes: string[];
  meal: string | null;
  /** Price tiers (1–5) extracted from phrases like "cheap" / "splurge" /
   *  "doesn't break the bank". Multi-value — matches any of them. */
  price: number[];
  remaining: string;
  /** True if any structured filter was extracted — caller can decide
   *  whether to act differently when the parser found nothing. */
  matched: boolean;
}

// Meal type extraction is deliberately disabled. The server's meal filter
// only matches restaurants that have been REVIEWED with that exact meal
// type, so a CBD dinner spot wouldn't surface for "lunch cbd" even if it
// serves lunch. Better to ignore meal words for now and let the structured
// filters (cuisine / suburb / vibe) do the work. Re-enable when meal data
// reflects what's actually available, not just what's been reviewed.
//
// Listed here so meal-type words can be stopworded and not pollute q.
const MEAL_WORDS = [
  'breakfast', 'brunch', 'lunch', 'dinner', 'dessert', 'snack', 'snacks',
  'drinks', 'drink', 'cocktail', 'cocktails', 'sweets', 'sweet',
  'brekkie', 'brekky',
];

// Natural-language price cues → tier sets. Tiers map to the canonical
// admin-form ranges (see RestaurantForm.astro):
//   1 = $0–20, 2 = $20–50, 3 = $50–100, 4 = $100–200, 5 = $200+
//
// All keys are normalised (lowercased, hyphens/apostrophes stripped) so
// "doesn't break the bank" and "doesnt break the bank" both hit the
// same key — the parser strips apostrophes before matching.
const PRICE_SYNONYMS: Record<string, number[]> = {
  // Cheap end
  'super cheap': [1],
  'very cheap': [1],
  'dirt cheap': [1],
  'cheap': [1, 2],
  'cheap eats': [1, 2],
  'budget': [1, 2],
  'affordable': [1, 2],
  // Mid range — "doesn't break the bank" etc. cover up to ~$100
  'mid range': [2, 3],
  'moderate': [2, 3],
  'reasonable': [1, 2, 3],
  'reasonably priced': [1, 2, 3],
  'doesnt break the bank': [1, 2, 3],
  'wont break the bank': [1, 2, 3],
  'not too expensive': [1, 2, 3],
  'not too pricey': [1, 2, 3],
  // Pricey end
  'pricey': [4, 5],
  'expensive': [4, 5],
  'splurge': [4, 5],
  'splurgy': [4, 5],
  'big spender': [4, 5],
  'blowout': [4, 5],
};

// Synonyms map natural-language phrasings onto tag slugs. The parser
// only indexes a synonym if its target slug actually exists in the
// page's tag list — so the map can carry future-tag aliases harmlessly.
//
// Lowercase phrase → list of tag slugs to apply when matched. Multi-word
// phrases match before single words (longest-first sort) so "date night"
// wins over "night" in isolation.
//
// IMPORTANT: target values are TAG SLUGS (the `slug` column on `tags`),
// not labels. Current vibe slugs in the DB:
//   casual, date, dine-in, fine-dining, music, loud, outdoor, quiet,
//   takeaway, upscale
// Update these targets if you ever change a slug.
const TAG_SYNONYMS: Record<string, string[]> = {
  // Date / occasion → "Date spot" (slug: date)
  'date night': ['date'],
  'romantic': ['date'],
  // Vibe — quiet
  'low-key': ['quiet'],
  'low key': ['quiet'],
  'intimate': ['quiet'],
  'chill': ['quiet'],
  'calm': ['quiet'],
  // Vibe — loud
  'lively': ['loud'],
  'noisy': ['loud'],
  'buzzing': ['loud'],
  'energetic': ['loud'],
  // Upscale / fine dining
  'fancy': ['upscale', 'fine-dining'],
  'high end': ['upscale', 'fine-dining'],
  'high-end': ['upscale', 'fine-dining'],
  'special occasion': ['upscale', 'fine-dining'],
  'white tablecloth': ['fine-dining'],
  // Outdoor → "Outdoor seating" (slug: outdoor)
  'alfresco': ['outdoor'],
  'outside': ['outdoor'],
  'outdoors': ['outdoor'],
  'outdoor seating': ['outdoor'],
  'patio': ['outdoor'],
  // Takeaway / dine-in
  'takeout': ['takeaway'],
  'to go': ['takeaway'],
  'to-go': ['takeaway'],
  'sit down': ['dine-in'],
  'sit-down': ['dine-in'],
  'eat in': ['dine-in'],
  // Live music → "Live music" (slug: music)
  'live music': ['music'],
  'live band': ['music'],
  'live show': ['music'],
};

// Cuisine synonyms — same idea but for cuisine names. Only fires when a
// matching cuisine value exists in the page's cuisine list (case-insensitive).
const CUISINE_SYNONYMS: Record<string, string[]> = {
  'japo': ['Japanese'],
  'japa': ['Japanese'],
  'sushi': ['Japanese'],
  'ramen': ['Japanese'],
  'pho': ['Vietnamese'],
  'banh mi': ['Vietnamese'],
  'dimsum': ['Chinese'],
  'dim sum': ['Chinese'],
  'yum cha': ['Chinese'],
  'pasta': ['Italian'],
  'pizza': ['Italian'],
  'taco': ['Mexican'],
  'tacos': ['Mexican'],
  'burrito': ['Mexican'],
  'kebab': ['Middle Eastern'],
  'curry': ['Indian'],
  'bbq': ['American'],
  'burger': ['American'],
  'burgers': ['American'],
};

// Common English glue words and ambient terms ("sydney", "food",
// "restaurant") that we don't want to keep as a literal text-search term
// after the structured matches are pulled out. Doesn't filter cuisine
// names — those are already extracted before this list is checked.
const STOPWORDS = new Set([
  'a', 'an', 'the',
  'in', 'on', 'at', 'near', 'by', 'around',
  'and', 'or', 'with', 'without', 'for', 'to', 'of', 'from',
  'good', 'best', 'great',
  'sydney', 'sydneys',
  'food', 'eats', 'eat', 'eating',
  'place', 'places', 'spot', 'spots',
  'restaurant', 'restaurants', 'cafe', 'cafes',
  'i', 'im', "i'm", 'me', 'we', 'us',
  'want', 'wanted', 'looking', 'find',
  // Connective price/meta words — let phrases like "moderate price" or
  // "expensive food" reduce to just the price/meal extraction without
  // leaking "price" or "cost" into q as a literal text-search term.
  'price', 'priced', 'pricing', 'cost', 'budget',
  // Meal-type words — see MEAL_WORDS comment above for rationale.
  ...MEAL_WORDS,
]);

/**
 * Build a flat phrase list across all reference data, sorted longest-first
 * so multi-word phrases ("modern australian", "eastern suburbs") match
 * before any single-word substring of them. Phrases are lowercased; matches
 * are checked with whitespace-padded boundaries so "italian" doesn't
 * fire on "italianas".
 */
type Phrase = {
  phrase: string;
  type: 'cuisine' | 'region' | 'suburb' | 'vibe' | 'meal' | 'price';
  /** For non-price types, the filter value (e.g. "Italian", "surry-hills").
   *  For price, a comma-joined string of tier numbers (e.g. "1,2,3") so
   *  the index can stay homogeneous. */
  value: string;
};

/**
 * Normalise a string for phrase matching: lowercase, drop apostrophes
 * ("doesn't" → "doesnt"), hyphens / slashes → spaces, strip everything
 * else non-alphanumeric, collapse whitespace. Run on both query and
 * phrases so "low-key" / "low key" / "doesnt" / "doesn't" all hit the
 * same cell.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[-/]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildPhraseIndex(ref: SmartParseRefData): Phrase[] {
  const phrases: Phrase[] = [];

  for (const c of ref.cuisines) {
    phrases.push({ phrase: normalize(c), type: 'cuisine', value: c });
  }
  for (const r of ref.regions) {
    phrases.push({ phrase: normalize(r.name), type: 'region', value: r.slug });
    // Slug-as-words too, in case the slug differs from the display name
    // (e.g. "eastern-suburbs" vs. "Eastern Suburbs" — same after norm,
    // but the call is cheap and protects against future mismatches).
    const slugWords = normalize(r.slug);
    if (slugWords && slugWords !== normalize(r.name)) {
      phrases.push({ phrase: slugWords, type: 'region', value: r.slug });
    }
  }
  for (const l of ref.locations) {
    phrases.push({ phrase: normalize(l.name), type: 'suburb', value: l.slug });
    const slugWords = normalize(l.slug);
    if (slugWords && slugWords !== normalize(l.name)) {
      phrases.push({ phrase: slugWords, type: 'suburb', value: l.slug });
    }
  }

  // Vibe tags — direct label, slug-as-words, AND any synonyms whose
  // target slug actually exists on the page.
  const vibeSlugs = new Set(
    ref.tags
      .filter((t) => !t.category || t.category === 'vibe')
      .map((t) => t.slug)
  );
  for (const t of ref.tags) {
    if (t.category && t.category !== 'vibe') continue;
    phrases.push({ phrase: normalize(t.label), type: 'vibe', value: t.slug });
    const slugWords = normalize(t.slug);
    if (slugWords && slugWords !== normalize(t.label)) {
      phrases.push({ phrase: slugWords, type: 'vibe', value: t.slug });
    }
  }
  for (const [phrase, targets] of Object.entries(TAG_SYNONYMS)) {
    for (const target of targets) {
      if (vibeSlugs.has(target)) {
        phrases.push({ phrase: normalize(phrase), type: 'vibe', value: target });
      }
    }
  }

  // Cuisine synonyms.
  const cuisineByLower = new Map(ref.cuisines.map((c) => [c.toLowerCase(), c]));
  for (const [phrase, targets] of Object.entries(CUISINE_SYNONYMS)) {
    for (const target of targets) {
      const actual = cuisineByLower.get(target.toLowerCase());
      if (actual) {
        phrases.push({ phrase: normalize(phrase), type: 'cuisine', value: actual });
      }
    }
  }

  // Meal types are deliberately not indexed (see MEAL_WORDS comment).

  // Price cues — normalise the synonym keys; values are encoded as a
  // comma-joined tier list so the Phrase shape stays a flat string.
  for (const [phrase, tiers] of Object.entries(PRICE_SYNONYMS)) {
    phrases.push({ phrase: normalize(phrase), type: 'price', value: tiers.join(',') });
  }

  // Dedupe (same phrase + type + value can be added by both label-pass
  // and slug-pass) and sort longest-first so multi-word phrases win.
  const seen = new Set<string>();
  const dedup: Phrase[] = [];
  for (const p of phrases) {
    if (!p.phrase) continue;
    const key = `${p.type}|${p.value}|${p.phrase}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(p);
  }
  dedup.sort((a, b) => b.phrase.length - a.phrase.length);
  return dedup;
}

/**
 * Builds a single-word lookup keyed by individual words from multi-word
 * location and cuisine phrases. Lets "surry" match "Surry Hills", "cbd"
 * match "Sydney CBD", "modern" match "Modern Australian", "asian" match
 * "Asian Fusion", etc. — without needing the full phrase typed.
 *
 * Vibe tags are deliberately excluded; they tend to be either single
 * words ("Casual", "Loud") that already match exactly, or compound
 * phrases ("Fine Dining") whose words ("fine") are too ambiguous on
 * their own.
 *
 * Words that appear in multiple distinct phrases (e.g. "eastern" in
 * both "Middle Eastern" cuisine and "Eastern Suburbs" region) are
 * filtered out by the parser's ambiguity check at apply-time.
 */
function buildWordIndex(ref: SmartParseRefData): Map<string, Phrase[]> {
  const idx = new Map<string, Phrase[]>();
  const add = (word: string, p: Phrase) => {
    if (!word || word.length < 3 || STOPWORDS.has(word)) return;
    const list = idx.get(word) ?? [];
    if (!list.some((e) => e.type === p.type && e.value === p.value)) list.push(p);
    idx.set(word, list);
  };
  for (const r of ref.regions) {
    const phrase: Phrase = { phrase: normalize(r.name), type: 'region', value: r.slug };
    for (const w of normalize(r.name).split(' ')) add(w, phrase);
    for (const w of normalize(r.slug).split(' ')) add(w, phrase);
  }
  for (const l of ref.locations) {
    const phrase: Phrase = { phrase: normalize(l.name), type: 'suburb', value: l.slug };
    for (const w of normalize(l.name).split(' ')) add(w, phrase);
    for (const w of normalize(l.slug).split(' ')) add(w, phrase);
  }
  // Cuisines too — but only multi-word ones (single-word cuisines like
  // "Italian" are already caught by full-phrase matching).
  for (const c of ref.cuisines) {
    const norm = normalize(c);
    if (!norm.includes(' ')) continue;
    const phrase: Phrase = { phrase: norm, type: 'cuisine', value: c };
    for (const w of norm.split(' ')) add(w, phrase);
  }
  return idx;
}

export function smartParse(query: string, ref: SmartParseRefData): SmartParseResult {
  const phrases = buildPhraseIndex(ref);
  const wordIndex = buildWordIndex(ref);

  let working = ' ' + normalize(query) + ' ';
  const matched = {
    cuisines: new Set<string>(),
    regions: new Set<string>(),
    suburbs: new Set<string>(),
    vibes: new Set<string>(),
    meal: null as string | null,
    price: new Set<number>(),
  };

  const addMatch = (p: Phrase) => {
    if (p.type === 'cuisine') matched.cuisines.add(p.value);
    else if (p.type === 'region') matched.regions.add(p.value);
    else if (p.type === 'suburb') matched.suburbs.add(p.value);
    else if (p.type === 'vibe') matched.vibes.add(p.value);
    else if (p.type === 'meal') matched.meal = p.value;
    else if (p.type === 'price') {
      for (const tier of p.value.split(',')) {
        const n = Number(tier);
        if (Number.isFinite(n) && n >= 1 && n <= 5) matched.price.add(n);
      }
    }
  };

  // Pass 1 — multi-word phrase matches, longest first. Each match excises
  // its span from `working` so it can't be re-matched by a shorter phrase.
  for (const p of phrases) {
    if (!p.phrase) continue;
    const padded = ' ' + p.phrase + ' ';
    let idx = working.indexOf(padded);
    while (idx >= 0) {
      working = working.slice(0, idx) + ' ' + working.slice(idx + padded.length);
      addMatch(p);
      idx = working.indexOf(padded);
    }
  }

  // Pass 2 — single-word fallback for locations + multi-word cuisines.
  // Lets partial typings like "cbd" (→ Sydney CBD), "surry" (→ Surry
  // Hills), "modern" (→ Modern Australian), "asian" (→ Asian Fusion)
  // still light up filters without needing the full phrase.
  //
  // Ambiguity guard: a word that maps to multiple distinct (type, value)
  // pairs (e.g. "eastern" → both "Middle Eastern" cuisine and "Eastern
  // Suburbs" region) is skipped — applying both would intersect into
  // empty results. The leftover token falls through to q text-search.
  const surviving = working.split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 0);
  const consumedTokens = new Set<string>();
  for (const tok of surviving) {
    if (STOPWORDS.has(tok)) continue;
    const hits = wordIndex.get(tok);
    if (!hits || hits.length === 0) continue;
    // Distinct values across the hits (collapse same-value-different-type
    // dupes — e.g. a region and suburb that share a slug).
    const distinctValues = new Set(hits.map((h) => `${h.type}:${h.value}`));
    const distinctSlugValues = new Set(hits.map((h) => h.value));
    // If the hits collapse to a single underlying value (regardless of
    // type), apply them all — same conceptual filter expressed via
    // multiple URL params is fine (filter logic ANDs across types).
    // Otherwise it's a genuine ambiguity (e.g. "eastern") — skip.
    if (distinctSlugValues.size > 1) continue;
    for (const p of hits) addMatch(p);
    consumedTokens.add(tok);
    // distinctValues kept above for future debugging — silence unused.
    void distinctValues;
  }

  // What's left after both passes — stopwords stripped — becomes q.
  const remainingTokens = surviving.filter(
    (t) => !STOPWORDS.has(t) && !consumedTokens.has(t)
  );

  const matchedAnything =
    matched.cuisines.size > 0 ||
    matched.regions.size > 0 ||
    matched.suburbs.size > 0 ||
    matched.vibes.size > 0 ||
    matched.meal !== null ||
    matched.price.size > 0;

  // When structured filters extracted, drop unmatched leftover words
  // (treat them as noise instead of running them as a token-AND text
  // search that would wipe the structured results). When nothing
  // structured matched, keep the leftover as q so pure-text queries
  // ("tonkotsu", "rooftop") still hit the text-search path.
  const remaining = matchedAnything ? '' : remainingTokens.join(' ');

  return {
    cuisines: [...matched.cuisines],
    regions: [...matched.regions],
    suburbs: [...matched.suburbs],
    vibes: [...matched.vibes],
    meal: matched.meal,
    price: [...matched.price].sort((a, b) => a - b),
    remaining,
    matched: matchedAnything,
  };
}

/**
 * Apply a SmartParseResult to the current URL by appending the matched
 * filter values (preserving any existing user-set filters of the same
 * type — we add, never remove) and replacing the `q` param with the
 * leftover free-text. Returns the new URL string ready for replaceState.
 */
export function applySmartParseToUrl(currentHref: string, result: SmartParseResult): string {
  const url = new URL(currentHref);
  const addUnique = (name: string, value: string) => {
    if (!url.searchParams.getAll(name).includes(value)) {
      url.searchParams.append(name, value);
    }
  };
  for (const c of result.cuisines) addUnique('cuisine', c);
  for (const r of result.regions) addUnique('location', `region:${r}`);
  for (const s of result.suburbs) addUnique('location', s);
  for (const v of result.vibes) addUnique('vibes', v);
  for (const p of result.price) addUnique('price', String(p));
  if (result.meal) url.searchParams.set('meal', result.meal);
  // q is single-value: replace with the leftover (or strip if empty).
  url.searchParams.delete('q');
  if (result.remaining) url.searchParams.set('q', result.remaining);
  return url.toString();
}

/**
 * Inverse of applySmartParseToUrl — strips the values that a previous
 * smart-parse run added, leaving any other filter values (including ones
 * the user added manually via pills) untouched. Used when the user clears
 * the search input: we want the structured filters that came from their
 * search to disappear, but anything they ticked separately should stay.
 *
 * Caller is responsible for clearing `q` separately if they want to.
 */
export function undoSmartParseFromUrl(currentHref: string, result: SmartParseResult): string {
  const url = new URL(currentHref);
  const removeValue = (name: string, value: string) => {
    const all = url.searchParams.getAll(name);
    url.searchParams.delete(name);
    for (const v of all) if (v !== value) url.searchParams.append(name, v);
  };
  for (const c of result.cuisines) removeValue('cuisine', c);
  for (const r of result.regions) removeValue('location', `region:${r}`);
  for (const s of result.suburbs) removeValue('location', s);
  for (const v of result.vibes) removeValue('vibes', v);
  for (const p of result.price) removeValue('price', String(p));
  if (result.meal && url.searchParams.get('meal') === result.meal) {
    url.searchParams.delete('meal');
  }
  return url.toString();
}
