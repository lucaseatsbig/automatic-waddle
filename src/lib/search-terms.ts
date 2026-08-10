// Query-token expansion for the free-text search on /all.
//
// Single source of truth for both search paths: searchRestaurants() in db.ts
// (the SSR pass) and matchesFilter() in filter.ts (the client pass). These used
// to carry duplicate copies of expandPluralVariants with a "keep in sync"
// comment; they now both call expandSearchToken() from here.
//
// Matching is substring-based against a pre-built lowercase haystack of
// name + cuisines + suburb + standout dish names + tag labels (see the
// search_text field built in db.ts). So an expansion only needs to name the
// word as it would appear in that text — no stemming beyond plurals.

/**
 * Naive plural/singular variant expansion so a search for "burgers" finds
 * "burger" and vice versa. Deliberately conservative — only handles the
 * patterns that won't produce false positives. Words ending in "ss" / "us"
 * and very short words are skipped.
 */
export function expandPluralVariants(token: string): string[] {
  const set = new Set<string>([token]);
  const t = token;
  if (t.length > 3 && t.endsWith('ies')) {
    // pastries → pastry, fries → fry
    set.add(t.slice(0, -3) + 'y');
  } else if (t.length > 3 && t.endsWith('es') && !t.endsWith('ses')) {
    // dishes → dish, brunches → brunch (skip "ses" to avoid mangling "courses")
    set.add(t.slice(0, -2));
  }
  if (t.length > 2 && t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us')) {
    // burgers → burger, tacos → taco
    set.add(t.slice(0, -1));
  }
  // Add a naive plural too so "burger" finds "burgers" in the data.
  if (t.length > 2 && !t.endsWith('s')) {
    set.add(t + 's');
    if (t.endsWith('y') && t.length > 2) set.add(t.slice(0, -1) + 'ies');
  }
  return Array.from(set);
}

/**
 * Related-term groups. Every member of a group expands to every other member,
 * so the relation is symmetric: "seafood" finds a place whose only clue is a
 * "yuzu scallop ramen", and searching "scallop" finds it too.
 *
 * Curation rules, learned the hard way — symmetry cuts both ways:
 *
 *  1. Only put a dish in a cuisine's group when that dish is *distinctive* to
 *     it. "biryani" belongs with Indian; "curry" does not, because Thai,
 *     Malaysian and Japanese places all serve curry and the symmetry would
 *     make "indian" match all of them.
 *  2. Skip words under ~4 characters and words that appear inside longer
 *     unrelated words. Matching is substring-based, so "bug" (as in Moreton
 *     Bay bug) would hit "bugs" in any context.
 *  3. Prefer words that actually occur in the data — restaurant names,
 *     standout dish names, cuisine labels, and the tag list.
 *
 * Terms may appear in more than one group; expansion unions them all. That's
 * intentional for genuinely ambiguous words ("laksa" is both a noodle dish and
 * a Malaysian marker).
 */
export const SYNONYM_GROUPS: string[][] = [
  // --- Proteins & produce -------------------------------------------------
  [
    'seafood', 'fish', 'prawn', 'shrimp', 'oyster', 'scallop', 'squid',
    'calamari', 'octopus', 'crab', 'lobster', 'mussel', 'clam', 'sashimi',
    'marinara', 'barramundi', 'salmon', 'tuna', 'snapper', 'unagi', 'anchovy',
  ],
  ['steak', 'beef', 'wagyu', 'ribeye', 'sirloin', 'porterhouse', 'brisket', 'tartare'],
  ['chicken', 'poultry', 'karaage', 'schnitzel', 'spatchcock', 'jidori', 'parmi', 'parma'],
  ['pork', 'bacon', 'pancetta', 'tonkatsu', 'char siu', 'ssam', 'jowl'],
  ['lamb', 'mutton', 'shank', 'shoulder'],
  ['duck', 'confit'],
  ['vegetarian', 'vegan', 'veggie', 'plant-based', 'meat-free', 'meatless'],

  // --- Dish families ------------------------------------------------------
  ['noodle', 'ramen', 'pho', 'udon', 'soba', 'laksa', 'vermicelli', 'hokkien'],
  [
    'pasta', 'spaghetti', 'rigatoni', 'tagliatelle', 'linguine', 'lasagna',
    'lasagne', 'ravioli', 'gnocchi', 'pappardelle', 'carbonara', 'cacio',
    'ragu', 'penne', 'fettuccine',
  ],
  ['dumpling', 'gyoza', 'xiao long bao', 'wonton', 'har gow', 'manti', 'pierogi'],
  ['burger', 'cheeseburger', 'smashburger', 'patty'],
  ['sandwich', 'sanga', 'panini', 'bagel', 'banh mi', 'toastie', 'sub', 'reuben'],
  ['pizza', 'pizzeria', 'margherita', 'napoletana', 'calzone'],
  ['bakery', 'bread', 'sourdough', 'focaccia', 'pastry', 'croissant', 'baguette'],
  [
    'dessert', 'sweet', 'cake', 'tiramisu', 'gelato', 'ice cream', 'tart',
    'chocolate', 'pudding', 'mille-feuille', 'pistachio', 'cannoli', 'affogato',
  ],
  ['bbq', 'barbecue', 'barbeque', 'grill', 'grilled', 'charcoal', 'skewer', 'yakitori', 'kebab'],
  ['breakfast', 'brunch', 'eggs', 'benedict', 'pancake', 'toast', 'menemen', 'omelette'],
  ['coffee', 'cafe', 'espresso', 'latte', 'flat white', 'brew', 'roaster'],
  ['spicy', 'chilli', 'chili', 'szechuan', 'sichuan', 'hot pot', 'hotpot'],

  // --- Cuisines: only distinctive markers, per rule 1 above ---------------
  ['japanese', 'japan', 'izakaya', 'sushi', 'sashimi', 'yakitori', 'tempura', 'donburi', 'omakase'],
  ['chinese', 'china', 'cantonese', 'yum cha', 'dim sum', 'szechuan', 'sichuan'],
  ['korean', 'korea', 'kbbq', 'bibimbap', 'kimchi', 'bulgogi'],
  ['thai', 'thailand', 'pad thai', 'tom yum', 'som tum'],
  ['vietnamese', 'vietnam', 'pho', 'banh mi'],
  ['indian', 'india', 'biryani', 'naan', 'masala', 'tikka', 'dosa', 'tandoori'],
  ['italian', 'italy', 'trattoria', 'osteria', 'aperitivo'],
  ['mexican', 'mexico', 'taco', 'burrito', 'quesadilla', 'tortilla', 'oaxacan', 'mezcal'],
  ['greek', 'greece', 'souvlaki', 'gyros', 'saganaki'],
  ['spanish', 'spain', 'tapas', 'paella', 'jamon'],
  ['french', 'france', 'bistro', 'brasserie', 'gateau'],
  ['turkish', 'turkey', 'menemen', 'pide', 'lahmacun'],
  ['lebanese', 'middle eastern', 'falafel', 'shawarma', 'hummus', 'mezze'],
  ['malaysian', 'malaysia', 'laksa', 'roti', 'satay'],

  // --- Vibe words that map onto the tag vocabulary ------------------------
  ['fancy', 'fine dining', 'upscale', 'degustation', 'tasting menu', 'michelin'],
  ['casual', 'chill', 'relaxed', 'laid-back'],
  ['date', 'date spot', 'romantic', 'intimate'],
  ['group', 'groups', 'large groups', 'party'],
  ['late', 'open late', 'late night'],
  ['quiet', 'peaceful'],
  ['outdoor', 'outdoor seating', 'alfresco', 'courtyard', 'terrace'],
  ['takeaway', 'take away', 'takeout'],
  ['gluten-free', 'gluten free', 'coeliac', 'celiac'],
  ['halal'],
  ['wine', 'wine bar', 'sommelier', 'vino'],
  ['cocktail', 'bar', 'mixology'],
];

/**
 * term → every related term (including itself), unioned across every group
 * the term belongs to. Built once at module load.
 */
const SYNONYM_LOOKUP: Map<string, string[]> = (() => {
  const map = new Map<string, Set<string>>();
  for (const group of SYNONYM_GROUPS) {
    for (const term of group) {
      const key = term.toLowerCase();
      const bucket = map.get(key) ?? new Set<string>();
      for (const other of group) bucket.add(other.toLowerCase());
      map.set(key, bucket);
    }
  }
  return new Map([...map].map(([k, v]) => [k, [...v]]));
})();

/**
 * Expand one lowercase query token into every string worth substring-matching
 * against `search_text`: the token itself, its plural/singular variants, and
 * any synonym group it belongs to (each of those pluralised too).
 *
 * Returns an OR-group — a restaurant matches the token if ANY variant hits.
 * Callers still AND across tokens, so "cheap seafood" narrows as expected.
 */
export function expandSearchToken(token: string): string[] {
  const t = token.toLowerCase();
  const out = new Set<string>();

  const forms = expandPluralVariants(t);
  for (const v of forms) out.add(v);

  // Look the synonym table up under every plural/singular form, not just the
  // token as typed — the groups are written in the singular, so searching
  // "dumplings" would otherwise find no synonyms at all while "dumpling" did.
  const related = new Set<string>();
  for (const form of forms) {
    for (const syn of SYNONYM_LOOKUP.get(form) ?? []) related.add(syn);
  }

  // A multi-word synonym ("banh mi") can't be reached by single-token lookup
  // here — the caller splits the query on whitespace — but it still works as
  // an expansion target, which is the direction that matters.
  for (const syn of related) {
    if (syn.includes(' ')) {
      out.add(syn);
    } else {
      for (const v of expandPluralVariants(syn)) out.add(v);
    }
  }

  return [...out];
}
