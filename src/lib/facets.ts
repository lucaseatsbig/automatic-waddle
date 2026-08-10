// Which filter options are actually worth offering?
//
// A control that can only ever return zero results is a dead end — the user
// taps "Live music", the list empties, and the only lesson learned is that the
// filter bar lies. This module narrows the reference lists (cuisines, suburbs,
// regions, tags) and the fixed option sets (price tiers, status, top-rated)
// down to the ones at least one restaurant can satisfy. The filter UI renders
// from the result, so unbacked options are never drawn.
//
// Two deliberate rules:
//   1. Availability is computed against the FULL restaurant set, never the
//      currently-filtered subset. Options that appeared and vanished as the
//      user narrowed down would be far more disorienting than a filter that
//      happens to return nothing in combination with another.
//   2. Anything currently selected is always kept, even if nothing backs it.
//      Otherwise a shared/bookmarked URL carrying a now-empty filter would
//      render no control to switch it off.
//
// Pure: no DOM, no D1, no network.

import type { FilterableRestaurant } from './filter';
import { REGIONS, type Region } from './regions';
import type { Filters, Location, Tag } from './types';

/** Rating floor behind the "Top rated" toggle. Canonical — the filter UI
 *  imports this rather than re-declaring it. NOTE: the client-side script in
 *  src/pages/all.astro re-declares this value (it can't import from here);
 *  change both together or server and client filtering disagree. */
export const TOP_RATED_THRESHOLD = 8;

export interface AvailableFacets {
  /** Reference lists, narrowed to values in use (plus current selections). */
  cuisines: string[];
  locations: Location[];
  regions: Region[];
  tags: Tag[];
  /** Price tiers (1–5) with at least one restaurant priced at that tier. */
  priceTiers: number[];
  /** Meal types at least one place serves. Has no pill of its own — the
   *  meal filter is reachable only through smart-search ("lunch cbd") — but
   *  the parser uses it so a phrase can't apply an empty meal filter. */
  meals: string[];
  /**
   * Is there at least one visited place? Previously drove the Status filter's
   * "Visited" option; no consumer reads it since that control was removed
   * (wishlist places now sort last in every sort instead). Kept because it's
   * cheap and a future "hide wishlist" toggle would want it.
   */
  visited: boolean;
  /** Is there at least one not-yet-visited place? Unused — see `visited`. */
  wishlist: boolean;
  /** Any place rated TOP_RATED_THRESHOLD or above? Drives the Top rated toggle. */
  topRated: boolean;
}

export interface FacetReferenceLists {
  cuisines: string[];
  locations: Location[];
  tags: Tag[];
  regions?: Region[];
}

const norm = (s: string) => s.trim().toLowerCase();

export function buildAvailableFacets(
  restaurants: FilterableRestaurant[],
  refs: FacetReferenceLists,
  filters: Filters
): AvailableFacets {
  // Cuisine — mirror matchesFilter's source of truth: the multi-cuisine array
  // when present, else the legacy single `cuisine` column. Compared
  // case-insensitively, same as the filter predicate.
  const usedCuisines = new Set<string>();
  for (const r of restaurants) {
    const own = r.cuisines && r.cuisines.length > 0 ? r.cuisines : r.cuisine ? [r.cuisine] : [];
    for (const c of own) usedCuisines.add(norm(c));
  }
  const selectedCuisines = new Set((filters.cuisines ?? []).map(norm));
  const cuisines = refs.cuisines.filter(
    (c) => usedCuisines.has(norm(c)) || selectedCuisines.has(norm(c))
  );

  // Suburbs — a restaurant only matches a location filter via its own suburb
  // slug, so an empty suburb is an empty filter no matter how it's reached.
  const usedSuburbs = new Set<string>();
  for (const r of restaurants) {
    if (r.location_slug) usedSuburbs.add(r.location_slug);
  }
  const selectedSuburbs = new Set(filters.locations ?? []);
  const locations = refs.locations.filter(
    (l) => usedSuburbs.has(l.slug) || selectedSuburbs.has(l.slug)
  );

  // Regions expand to a set of suburbs — available if any one of them is in use.
  const selectedRegions = new Set(filters.regions ?? []);
  const regions = (refs.regions ?? REGIONS).filter(
    (r) => r.suburbs.some((s) => usedSuburbs.has(s)) || selectedRegions.has(r.slug)
  );

  // Tags (vibe + dietary) — the case this whole module exists for.
  const usedTagSlugs = new Set<string>();
  for (const r of restaurants) {
    for (const t of r.tags) usedTagSlugs.add(t.slug);
  }
  const selectedTags = new Set([...(filters.vibes ?? []), ...(filters.dietary ?? [])]);
  const tags = refs.tags.filter((t) => usedTagSlugs.has(t.slug) || selectedTags.has(t.slug));

  // Price tiers — rows without a tier can never match a price filter.
  const usedTiers = new Set<number>();
  for (const r of restaurants) {
    if (r.price_tier != null) usedTiers.add(r.price_tier);
  }
  const selectedTiers = new Set(filters.price ?? []);
  const priceTiers = [1, 2, 3, 4, 5].filter((t) => usedTiers.has(t) || selectedTiers.has(t));

  // Meal types — union across the curated join table and published reviews
  // (already merged into meal_types upstream).
  const meals = new Set<string>();
  for (const r of restaurants) {
    for (const m of r.meal_types) meals.add(m);
  }
  if (filters.meal) meals.add(filters.meal);

  return {
    cuisines,
    locations,
    regions,
    tags,
    priceTiers,
    meals: [...meals],
    visited: restaurants.some((r) => r.visited) || filters.visited === 'yes',
    wishlist: restaurants.some((r) => !r.visited) || filters.visited === 'no',
    topRated:
      restaurants.some((r) => r.avg_overall != null && r.avg_overall >= TOP_RATED_THRESHOLD) ||
      (filters.minRating != null && filters.minRating >= TOP_RATED_THRESHOLD),
  };
}

/** Everything on. Used as the default when a filter component is rendered
 *  without availability data (it then behaves exactly as it did before). */
export const ALL_FACETS_AVAILABLE: Pick<
  AvailableFacets,
  'priceTiers' | 'visited' | 'wishlist' | 'topRated'
> = {
  priceTiers: [1, 2, 3, 4, 5],
  visited: true,
  wishlist: true,
  topRated: true,
};
