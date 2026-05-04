// Client-callable filter / sort logic for the /all page. The server uses
// searchRestaurants() (in db.ts) for the SSR pass — that's the canonical
// query and must stay in sync with this file's predicates so initial paint
// matches what the client renders after rehydration.
//
// Pure: takes a denormalised restaurant card + a Filters object, returns
// a boolean. No DOM, no D1, no network.

import type { Filters, RestaurantCardData, SortOption } from './types';
import { getRegion } from './regions';

/**
 * Naive plural/singular variant expansion so a search for "burgers" finds
 * "burger" and vice versa. Mirrors the server's expandPluralVariants in
 * db.ts — keep the two in sync.
 */
export function expandPluralVariants(token: string): string[] {
  const set = new Set<string>([token]);
  const t = token;
  if (t.length > 3 && t.endsWith('ies')) {
    set.add(t.slice(0, -3) + 'y');
  } else if (t.length > 3 && t.endsWith('es') && !t.endsWith('ses')) {
    set.add(t.slice(0, -2));
  }
  if (t.length > 2 && t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us')) {
    set.add(t.slice(0, -1));
  }
  if (t.length > 2 && !t.endsWith('s')) {
    set.add(t + 's');
    if (t.endsWith('y') && t.length > 2) set.add(t.slice(0, -1) + 'ies');
  }
  return Array.from(set);
}

/**
 * Extra fields the client needs that aren't on RestaurantCardData. Built
 * once on the server alongside the standard card data and shipped as JSON.
 */
export interface FilterableRestaurant extends RestaurantCardData {
  /** Suburb slug (the card data only carries the display name). */
  location_slug: string | null;
  /** All distinct meal_type values across this restaurant's published reviews. */
  meal_types: string[];
  /** All cuisines tagged on this restaurant (per migration 0010). The
   *  card-level `cuisine` field still holds just the primary, used for
   *  display; this array is the filter-side source of truth. */
  cuisines: string[];
  /**
   * Pre-concatenated lowercase haystack: name, cuisine(s), suburb name,
   * all standout-dish names, all tag labels. Used by the text-search
   * filter to avoid having to grep across multiple fields per keystroke.
   */
  search_text: string;
}

export function matchesFilter(r: FilterableRestaurant, f: Filters): boolean {
  // Cuisine — multi-OR. A restaurant matches if ANY of its cuisines is in
  // the selected filter list (case-insensitive).
  if (f.cuisines && f.cuisines.length > 0) {
    const own = (r.cuisines && r.cuisines.length > 0
      ? r.cuisines
      : (r.cuisine ? [r.cuisine] : [])
    ).map((c) => c.toLowerCase());
    const wanted = f.cuisines.map((c) => c.toLowerCase());
    if (!own.some((c) => wanted.includes(c))) return false;
  }

  // Location — explicit suburbs + region-expanded suburbs union.
  const requiredSuburbs = new Set<string>();
  for (const slug of f.locations ?? []) requiredSuburbs.add(slug);
  for (const regionSlug of f.regions ?? []) {
    const region = getRegion(regionSlug);
    if (region) for (const s of region.suburbs) requiredSuburbs.add(s);
  }
  const anyLocationSelected = (f.locations?.length ?? 0) + (f.regions?.length ?? 0) > 0;
  if (anyLocationSelected) {
    if (requiredSuburbs.size === 0) return false; // selected something that expanded to nothing
    if (!r.location_slug || !requiredSuburbs.has(r.location_slug)) return false;
  }

  // Meal type — has the restaurant been reviewed with this meal at least once?
  if (f.meal && !r.meal_types.includes(f.meal)) return false;

  // Visited / wishlist.
  if (f.visited === 'yes' && !r.visited) return false;
  if (f.visited === 'no' && r.visited) return false;

  // Price tier.
  if (f.price && f.price.length > 0) {
    if (r.price_tier == null || !f.price.includes(r.price_tier)) return false;
  }

  // Min rating (server compares against avg_overall; rows without an avg are
  // excluded — same here).
  if (f.minRating != null) {
    if (r.avg_overall == null || r.avg_overall < f.minRating) return false;
  }

  // Tags — restaurant must have ALL selected tags (AND across categories).
  const tagSlugs = [...(f.vibes ?? []), ...(f.dietary ?? [])];
  if (tagSlugs.length > 0) {
    const have = new Set(r.tags.map((t) => t.slug));
    for (const slug of tagSlugs) {
      if (!have.has(slug)) return false;
    }
  }

  // Text search — token AND, plural-variant OR within each token.
  if (f.q) {
    const tokens = f.q.toLowerCase().trim().split(/\s+/).filter((t) => t.length > 0);
    for (const tok of tokens) {
      const variants = expandPluralVariants(tok);
      const anyHit = variants.some((v) => r.search_text.includes(v));
      if (!anyHit) return false;
    }
  }

  return true;
}

export function compareSort(a: FilterableRestaurant, b: FilterableRestaurant, sort: SortOption | undefined): number {
  switch (sort) {
    case 'recent': {
      // Visited (have reviews) first, then by latest visit desc, then name asc.
      const av = a.visited ? 0 : 1;
      const bv = b.visited ? 0 : 1;
      if (av !== bv) return av - bv;
      const ad = a.latest_visit_date ?? '';
      const bd = b.latest_visit_date ?? '';
      if (ad !== bd) return ad < bd ? 1 : -1; // desc
      return a.name.localeCompare(b.name);
    }
    case 'rating': {
      // avg_overall desc NULLS LAST, then latest visit desc, then name asc.
      const an = a.avg_overall ?? -Infinity;
      const bn = b.avg_overall ?? -Infinity;
      if (an !== bn) return bn - an;
      const ad = a.latest_visit_date ?? '';
      const bd = b.latest_visit_date ?? '';
      if (ad !== bd) return ad < bd ? 1 : -1;
      return a.name.localeCompare(b.name);
    }
    case 'name':
    default:
      return a.name.localeCompare(b.name);
  }
}

/**
 * Parse a URL's search params into a Filters object — same shape the server
 * uses. Lets the client URL stay the canonical source of truth for filter
 * state across reloads, share-links, and history nav.
 */
export function parseFiltersFromUrl(searchParams: URLSearchParams): Filters {
  const validMeals = ['breakfast', 'brunch', 'lunch', 'dinner', 'dessert', 'snack', 'drinks'];
  const meal = searchParams.get('meal');
  const visited = searchParams.get('visited');
  const sort = searchParams.get('sort');

  const rawLocations = searchParams.getAll('location').filter(Boolean);
  const regions = rawLocations.filter((v) => v.startsWith('region:')).map((v) => v.slice('region:'.length));
  const locations = rawLocations.filter((v) => !v.startsWith('region:'));

  const minRatingRaw = searchParams.get('minRating');
  const minRatingNum = minRatingRaw != null ? Number(minRatingRaw) : NaN;

  return {
    q: searchParams.get('q')?.trim() || undefined,
    cuisines: searchParams.getAll('cuisine').filter(Boolean) || undefined,
    meal: meal && validMeals.includes(meal) ? (meal as Filters['meal']) : undefined,
    locations: locations.length ? locations : undefined,
    regions: regions.length ? regions : undefined,
    visited: visited === 'yes' ? 'yes' : visited === 'no' ? 'no' : undefined,
    price: searchParams.getAll('price').map(Number).filter((n) => Number.isFinite(n) && n >= 1 && n <= 5),
    minRating: Number.isFinite(minRatingNum) && minRatingNum >= 0 && minRatingNum <= 10 ? minRatingNum : undefined,
    vibes: searchParams.getAll('vibes').filter(Boolean),
    dietary: searchParams.getAll('dietary').filter(Boolean),
    sort: sort === 'rating' || sort === 'name' || sort === 'recent' ? sort : undefined,
  };
}
