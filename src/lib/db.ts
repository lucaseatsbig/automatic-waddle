import type {
  AdminRestaurantRow,
  Filters,
  Location,
  MealType,
  RestaurantCardData,
  RestaurantDetail,
  RestaurantEditData,
  ReviewDetail,
  ReviewEditData,
  ReviewListRow,
  ReviewStatus,
  Tag,
  TagCategory,
} from './types';
import { getRegion } from './regions';

// Worker-lifetime memoization for read-mostly reference data used to populate
// the FilterBar / MobileFilterSheet on every request. The underlying tables
// (`tags`, `locations`, plus DISTINCT cuisines from `restaurants`) only change
// when an admin saves a new entry, so a short TTL keeps three D1 round-trips
// off the hot path for normal traffic. Admin endpoints can call
// `invalidateReferenceCache()` after writes to force-refresh.
const REFERENCE_CACHE_TTL_MS = 5 * 60 * 1000;
type CacheEntry<T> = { value: T; expiresAt: number };
const referenceCache = new Map<string, CacheEntry<unknown>>();

async function memoizeReference<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = referenceCache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await fn();
  referenceCache.set(key, { value, expiresAt: Date.now() + REFERENCE_CACHE_TTL_MS });
  return value;
}

export function invalidateReferenceCache(): void {
  referenceCache.clear();
}

export async function getLocations(db: D1Database): Promise<Location[]> {
  const { results } = await db
    .prepare('SELECT id, slug, name FROM locations ORDER BY name')
    .all<Location>();
  return results;
}

export async function getLocationsInUse(db: D1Database): Promise<Location[]> {
  return memoizeReference('locationsInUse', async () => {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT l.id, l.slug, l.name
           FROM locations l
           INNER JOIN restaurants r ON r.location_id = l.id
           ORDER BY l.name`
      )
      .all<Location>();
    return results;
  });
}

export async function getTags(db: D1Database): Promise<Tag[]> {
  return memoizeReference('tags', async () => {
    const { results } = await db
      .prepare('SELECT id, slug, label, category FROM tags ORDER BY category, label')
      .all<Tag>();
    return results;
  });
}

export async function getCuisines(db: D1Database): Promise<string[]> {
  return memoizeReference('cuisines', async () => {
    const { results } = await db
      .prepare(
        "SELECT DISTINCT cuisine FROM restaurants WHERE cuisine IS NOT NULL AND cuisine <> '' ORDER BY cuisine"
      )
      .all<{ cuisine: string }>();
    return results.map((r) => r.cuisine);
  });
}

export async function getCuisineSuggestions(db: D1Database): Promise<string[]> {
  // Merge seeded suggestions with any user-entered cuisines.
  const [{ results: seeds }, { results: used }] = await Promise.all([
    db
      .prepare("SELECT name FROM cuisine_suggestions ORDER BY name")
      .all<{ name: string }>()
      .catch(() => ({ results: [] as { name: string }[] })),
    db
      .prepare(
        "SELECT DISTINCT cuisine AS name FROM restaurants WHERE cuisine IS NOT NULL AND cuisine <> ''"
      )
      .all<{ name: string }>(),
  ]);
  const set = new Set<string>();
  for (const r of seeds) set.add(r.name);
  for (const r of used) set.add(r.name);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export async function getAllRestaurantsBasic(
  db: D1Database
): Promise<{ id: number; name: string; slug: string }[]> {
  const { results } = await db
    .prepare('SELECT id, name, slug FROM restaurants ORDER BY name')
    .all<{ id: number; name: string; slug: string }>();
  return results;
}

export async function findRestaurantByName(
  db: D1Database,
  name: string
): Promise<{ id: number } | null> {
  return db
    .prepare('SELECT id FROM restaurants WHERE LOWER(name) = LOWER(?) LIMIT 1')
    .bind(name.trim())
    .first<{ id: number }>();
}

export async function getOrCreateLocationByName(
  db: D1Database,
  name: string | null
): Promise<number | null> {
  if (!name || !name.trim()) return null;
  const trimmed = name.trim();
  const existing = await db
    .prepare('SELECT id FROM locations WHERE LOWER(name) = LOWER(?) LIMIT 1')
    .bind(trimmed)
    .first<{ id: number }>();
  if (existing) return existing.id;

  const { slugify } = await import('./slug');
  let slug = slugify(trimmed);
  // Ensure unique slug
  let n = 1;
  let candidate = slug;
  while (true) {
    const clash = await db
      .prepare('SELECT id FROM locations WHERE slug = ? LIMIT 1')
      .bind(candidate)
      .first();
    if (!clash) break;
    n += 1;
    candidate = `${slug}-${n}`;
  }
  const res = await db
    .prepare('INSERT INTO locations (slug, name) VALUES (?, ?)')
    .bind(candidate, trimmed)
    .run();
  return Number(res.meta.last_row_id);
}

// Generate plural ↔ singular variants of a search token. English-only and
// deliberately conservative — only handles the patterns that won't produce
// false positives. Words ending in "ss" / "us" / very short words are skipped.
function expandPluralVariants(token: string): string[] {
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

export async function searchRestaurants(
  db: D1Database,
  f: Filters
): Promise<RestaurantCardData[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (f.q) {
    // Tokenize the query and expand each token to its plural/singular variants
    // so "burgers" finds "burger", "pastries" finds "pastry", "dishes" finds
    // "dish", etc. Each token must match (AND across tokens), but any of its
    // variants may match (OR within a token).
    const tokens = f.q.toLowerCase().trim().split(/\s+/).filter((t) => t.length > 0);
    for (const tok of tokens) {
      const variants = expandPluralVariants(tok);
      const orClauses = variants.map(() => `(
        res.name LIKE ?
        OR res.cuisine LIKE ?
        OR loc.name LIKE ?
        OR EXISTS (
          SELECT 1 FROM reviews rv
          JOIN standout_items si ON si.review_id = rv.id
          WHERE rv.restaurant_id = res.id AND rv.status = 'published'
            AND si.name LIKE ?
        )
      )`).join(' OR ');
      where.push('(' + orClauses + ')');
      for (const v of variants) {
        const like = `%${v}%`;
        params.push(like, like, like, like);
      }
    }
  }
  if (f.cuisines && f.cuisines.length > 0) {
    where.push(`res.cuisine IN (${f.cuisines.map(() => '?').join(',')})`);
    params.push(...f.cuisines);
  }
  // Combine selected regions (each expands to its suburbs) and explicit suburb
  // selections into a single OR'd suburb-slug list.
  const suburbSlugs = new Set<string>();
  for (const slug of f.locations ?? []) suburbSlugs.add(slug);
  for (const regionSlug of f.regions ?? []) {
    const region = getRegion(regionSlug);
    if (region) for (const s of region.suburbs) suburbSlugs.add(s);
  }
  const anyLocationSelected = (f.locations?.length ?? 0) + (f.regions?.length ?? 0) > 0;
  if (suburbSlugs.size > 0) {
    const arr = Array.from(suburbSlugs);
    where.push(`loc.slug IN (${arr.map(() => '?').join(',')})`);
    params.push(...arr);
  } else if (anyLocationSelected) {
    // Selected something but it expanded to no suburbs (region with empty list).
    where.push('1 = 0');
  }
  if (f.meal) {
    where.push(`EXISTS (
      SELECT 1 FROM reviews rv
      WHERE rv.restaurant_id = res.id AND rv.status = 'published' AND rv.meal_type = ?
    )`);
    params.push(f.meal);
  }
  if (f.visited === 'yes') {
    where.push('COALESCE(pub.review_count, 0) > 0');
  } else if (f.visited === 'no') {
    where.push('COALESCE(pub.review_count, 0) = 0');
  }
  if (f.price && f.price.length > 0) {
    where.push(`res.price_tier IN (${f.price.map(() => '?').join(',')})`);
    params.push(...f.price);
  }
  if (f.minRating != null) {
    where.push('pub.avg_overall >= ?');
    params.push(f.minRating);
  }
  const tagSlugs = [...(f.vibes ?? []), ...(f.dietary ?? [])];
  if (tagSlugs.length > 0) {
    // Restaurant must have ALL selected tags (AND across filter categories).
    where.push(`(
      SELECT COUNT(DISTINCT t.slug)
      FROM restaurant_tags rt
      JOIN tags t ON t.id = rt.tag_id
      WHERE rt.restaurant_id = res.id AND t.slug IN (${tagSlugs.map(() => '?').join(',')})
    ) = ?`);
    params.push(...tagSlugs, tagSlugs.length);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  let orderBy: string;
  switch (f.sort) {
    case 'recent':
      orderBy = `
        CASE WHEN COALESCE(pub.review_count, 0) > 0 THEN 0 ELSE 1 END,
        latest_meta.visit_date DESC,
        res.name ASC
      `;
      break;
    case 'name':
      orderBy = `res.name ASC`;
      break;
    case 'rating':
    default:
      orderBy = `pub.avg_overall DESC NULLS LAST, latest_meta.visit_date DESC, res.name ASC`;
  }

  const sql = `
    WITH pub AS (
      SELECT r.restaurant_id,
             COUNT(*) AS review_count,
             AVG(r.rating_overall) AS avg_overall,
             MAX(r.visit_date) AS latest_visit_date
      FROM reviews r
      WHERE r.status = 'published'
      GROUP BY r.restaurant_id
    ),
    latest AS (
      SELECT r.restaurant_id, MAX(r.id) AS review_id, MAX(r.visit_date) AS visit_date
      FROM reviews r
      JOIN pub p
        ON p.restaurant_id = r.restaurant_id
       AND p.latest_visit_date = r.visit_date
      WHERE r.status = 'published'
      GROUP BY r.restaurant_id
    ),
    latest_meta AS (
      SELECT l.restaurant_id, l.review_id, l.visit_date, rv.meal_type
      FROM latest l
      JOIN reviews rv ON rv.id = l.review_id
    ),
    cover AS (
      SELECT review_id, MIN(r2_key) AS r2_key
      FROM photos
      WHERE is_cover = 1
      GROUP BY review_id
    )
    SELECT
      res.id, res.slug, res.name, res.cuisine, res.price_tier, res.wishlist_note,
      loc.name AS location,
      COALESCE(pub.review_count, 0) AS review_count,
      pub.avg_overall,
      latest_meta.visit_date AS latest_visit_date,
      latest_meta.meal_type  AS latest_meal_type,
      cover.r2_key           AS cover_r2_key,
      res.hero_photo_name    AS hero_photo_name,
      CASE WHEN COALESCE(pub.review_count, 0) > 0 THEN 1 ELSE 0 END AS visited
    FROM restaurants res
    LEFT JOIN locations   loc         ON loc.id = res.location_id
    LEFT JOIN pub                     ON pub.restaurant_id         = res.id
    LEFT JOIN latest_meta             ON latest_meta.restaurant_id = res.id
    LEFT JOIN cover                   ON cover.review_id           = latest_meta.review_id
    ${whereSql}
    ORDER BY ${orderBy}
  `;

  const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
  const { results } = await stmt.all<Record<string, unknown>>();

  // Inline integer IDs into the IN clause to avoid D1's 100-bound-param ceiling
  // and the multi-round-trip chunking it forced. The IDs come straight from D1
  // (an INTEGER column), but `Number.isInteger` guards against any oddball
  // coercion before string-interpolation into SQL.
  const ids = results
    .map((r) => Number(r.id))
    .filter((n) => Number.isInteger(n) && n > 0);
  const tagsByRestaurant = new Map<number, { slug: string; label: string; category: TagCategory }[]>();
  if (ids.length > 0) {
    const tagSql = `
      SELECT rt.restaurant_id, t.slug, t.label, t.category
      FROM restaurant_tags rt
      JOIN tags t ON t.id = rt.tag_id
      WHERE rt.restaurant_id IN (${ids.join(',')})
      ORDER BY t.category, t.label
    `;
    const { results: tagRows } = await db
      .prepare(tagSql)
      .all<{ restaurant_id: number; slug: string; label: string; category: TagCategory }>();
    for (const row of tagRows) {
      const arr = tagsByRestaurant.get(row.restaurant_id) ?? [];
      arr.push({ slug: row.slug, label: row.label, category: row.category });
      tagsByRestaurant.set(row.restaurant_id, arr);
    }
  }

  return results.map((r): RestaurantCardData => ({
    id: r.id as number,
    slug: r.slug as string,
    name: r.name as string,
    cuisine: (r.cuisine as string | null) ?? null,
    location: (r.location as string | null) ?? null,
    price_tier: (r.price_tier as number | null) ?? null,
    wishlist_note: (r.wishlist_note as string | null) ?? null,
    visited: r.visited === 1,
    review_count: (r.review_count as number) ?? 0,
    avg_overall: (r.avg_overall as number | null) ?? null,
    latest_visit_date: (r.latest_visit_date as string | null) ?? null,
    latest_meal_type: (r.latest_meal_type as string | null) ?? null,
    cover_r2_key: (r.cover_r2_key as string | null) ?? null,
    hero_photo_name: (r.hero_photo_name as string | null) ?? null,
    tags: tagsByRestaurant.get(r.id as number) ?? [],
  }));
}

export async function getRestaurantBySlug(
  db: D1Database,
  slug: string
): Promise<RestaurantDetail | null> {
  const row = await db
    .prepare(
      `SELECT res.id, res.slug, res.name, res.cuisine, res.address, res.price_tier,
              res.website_url, res.maps_url, res.place_id, res.lat, res.lng, res.wishlist_note,
              loc.name AS location
       FROM restaurants res
       LEFT JOIN locations loc ON loc.id = res.location_id
       WHERE res.slug = ?`
    )
    .bind(slug)
    .first<{
      id: number; slug: string; name: string; cuisine: string | null;
      address: string | null; price_tier: number | null;
      website_url: string | null; maps_url: string | null;
      place_id: string | null; lat: number | null; lng: number | null;
      wishlist_note: string | null; location: string | null;
    }>();
  if (!row) return null;

  const [{ results: tagRows }, { results: reviewRows }] = await Promise.all([
    db
      .prepare(
        `SELECT t.slug, t.label, t.category
         FROM restaurant_tags rt
         JOIN tags t ON t.id = rt.tag_id
         WHERE rt.restaurant_id = ?
         ORDER BY t.category, t.label`
      )
      .bind(row.id)
      .all<{ slug: string; label: string; category: TagCategory }>(),
    db
      .prepare(
        `SELECT id, visit_date, meal_type, rating_overall, rating_size,
                commentary, would_return, instagram_url
         FROM reviews
         WHERE restaurant_id = ? AND status = 'published'
         ORDER BY COALESCE(visit_date, '0000-00-00') DESC, id DESC`
      )
      .bind(row.id)
      .all<{
        id: number; visit_date: string | null; meal_type: MealType | null;
        rating_overall: number | null; rating_size: number | null;
        commentary: string | null;
        would_return: number; instagram_url: string | null;
      }>(),
  ]);

  const reviewIds = reviewRows.map((r) => r.id);
  const photosByReview = new Map<number, ReviewDetail['photos']>();
  const standoutsByReview = new Map<number, ReviewDetail['standout_items']>();

  if (reviewIds.length > 0) {
    const placeholders = reviewIds.map(() => '?').join(',');
    const [{ results: photoRows }, { results: itemRows }] = await Promise.all([
      db
        .prepare(
          `SELECT review_id, r2_key, alt, is_cover
           FROM photos
           WHERE review_id IN (${placeholders})
           ORDER BY is_cover DESC, sort_order, id`
        )
        .bind(...reviewIds)
        .all<{ review_id: number; r2_key: string; alt: string | null; is_cover: number }>(),
      db
        .prepare(
          `SELECT review_id, name, note, is_standout
           FROM standout_items
           WHERE review_id IN (${placeholders})
           ORDER BY sort_order, id`
        )
        .bind(...reviewIds)
        .all<{ review_id: number; name: string; note: string | null; is_standout: number }>(),
    ]);
    for (const p of photoRows) {
      const arr = photosByReview.get(p.review_id) ?? [];
      arr.push({ r2_key: p.r2_key, alt: p.alt, is_cover: p.is_cover === 1 });
      photosByReview.set(p.review_id, arr);
    }
    for (const it of itemRows) {
      const arr = standoutsByReview.get(it.review_id) ?? [];
      arr.push({ name: it.name, note: it.note, is_standout: it.is_standout === 1 });
      standoutsByReview.set(it.review_id, arr);
    }
  }

  const reviews: ReviewDetail[] = reviewRows.map((r) => ({
    id: r.id,
    visit_date: r.visit_date,
    meal_type: r.meal_type,
    rating_overall: r.rating_overall,
    rating_size: r.rating_size,
    commentary: r.commentary,
    would_return: r.would_return === 1,
    instagram_url: r.instagram_url,
    standout_items: standoutsByReview.get(r.id) ?? [],
    photos: photosByReview.get(r.id) ?? [],
  }));

  const ratings = reviews.map((r) => r.rating_overall).filter((n): n is number => n != null);
  const avg_overall = ratings.length > 0 ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
  const visitDates = reviews.map((r) => r.visit_date).filter((d): d is string => !!d);
  const latest_visit_date = visitDates.length > 0 ? visitDates.sort().slice(-1)[0] : null;

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    cuisine: row.cuisine,
    location: row.location,
    address: row.address,
    price_tier: row.price_tier,
    website_url: row.website_url,
    maps_url: row.maps_url,
    place_id: row.place_id,
    lat: row.lat,
    lng: row.lng,
    wishlist_note: row.wishlist_note,
    tags: tagRows,
    reviews,
    visit_count: reviews.length,
    avg_overall,
    latest_visit_date,
  };
}

export async function getSimilarByCuisine(
  db: D1Database,
  cuisine: string,
  excludeId: number,
  limit: number = 3
): Promise<RestaurantCardData[]> {
  const { results } = await db
    .prepare(
      `WITH pub AS (
         SELECT r.restaurant_id,
                COUNT(*) AS review_count,
                AVG(r.rating_overall) AS avg_overall,
                MAX(r.visit_date) AS latest_visit_date
         FROM reviews r
         WHERE r.status = 'published'
         GROUP BY r.restaurant_id
       ),
       latest AS (
         SELECT r.restaurant_id, MAX(r.id) AS review_id
         FROM reviews r
         JOIN pub p
           ON p.restaurant_id = r.restaurant_id
          AND p.latest_visit_date = r.visit_date
         WHERE r.status = 'published'
         GROUP BY r.restaurant_id
       ),
       cover AS (
         SELECT review_id, MIN(r2_key) AS r2_key
         FROM photos
         WHERE is_cover = 1
         GROUP BY review_id
       )
       SELECT
         res.id, res.slug, res.name, res.cuisine, res.price_tier, res.wishlist_note,
         loc.name AS location,
         COALESCE(pub.review_count, 0) AS review_count,
         pub.avg_overall,
         pub.latest_visit_date,
         NULL AS latest_meal_type,
         cover.r2_key AS cover_r2_key,
         res.hero_photo_name AS hero_photo_name,
         CASE WHEN COALESCE(pub.review_count, 0) > 0 THEN 1 ELSE 0 END AS visited
       FROM restaurants res
       LEFT JOIN locations loc ON loc.id = res.location_id
       LEFT JOIN pub           ON pub.restaurant_id   = res.id
       LEFT JOIN latest        ON latest.restaurant_id = res.id
       LEFT JOIN cover         ON cover.review_id     = latest.review_id
       WHERE res.cuisine = ? AND res.id <> ?
       ORDER BY
         pub.avg_overall DESC NULLS LAST,
         pub.latest_visit_date DESC,
         res.name ASC
       LIMIT ?`
    )
    .bind(cuisine, excludeId, limit)
    .all<Record<string, unknown>>();

  return results.map((r): RestaurantCardData => ({
    id: r.id as number,
    slug: r.slug as string,
    name: r.name as string,
    cuisine: (r.cuisine as string | null) ?? null,
    location: (r.location as string | null) ?? null,
    price_tier: (r.price_tier as number | null) ?? null,
    wishlist_note: (r.wishlist_note as string | null) ?? null,
    visited: r.visited === 1,
    review_count: (r.review_count as number) ?? 0,
    avg_overall: (r.avg_overall as number | null) ?? null,
    latest_visit_date: (r.latest_visit_date as string | null) ?? null,
    latest_meal_type: null,
    cover_r2_key: (r.cover_r2_key as string | null) ?? null,
    hero_photo_name: (r.hero_photo_name as string | null) ?? null,
    tags: [],
  }));
}

// ---- Editorial homepage queries --------------------------------------------

export interface FeaturedPlaceData extends RestaurantCardData {
  commentary: string | null;
  rating_size: number | null;
  rating_overall: number | null;
}

export async function getFeaturedRecent(
  db: D1Database,
  limit = 10
): Promise<FeaturedPlaceData[]> {
  const sql = `
    WITH pub AS (
      SELECT r.restaurant_id,
             COUNT(*) AS review_count,
             AVG(r.rating_overall) AS avg_overall,
             MAX(r.visit_date) AS latest_visit_date
      FROM reviews r
      WHERE r.status = 'published'
      GROUP BY r.restaurant_id
    ),
    latest AS (
      SELECT r.restaurant_id, MAX(r.id) AS review_id
      FROM reviews r
      WHERE r.status = 'published'
      GROUP BY r.restaurant_id
    ),
    cover AS (
      SELECT review_id, MIN(r2_key) AS r2_key
      FROM photos
      WHERE is_cover = 1
      GROUP BY review_id
    )
    SELECT
      res.id, res.slug, res.name, res.cuisine, res.price_tier, res.wishlist_note,
      res.hero_photo_name,
      loc.name AS location,
      pub.review_count,
      pub.avg_overall,
      pub.latest_visit_date,
      rv.meal_type AS latest_meal_type,
      rv.commentary,
      rv.rating_overall,
      rv.rating_size,
      cover.r2_key AS cover_r2_key
    FROM restaurants res
    JOIN pub               ON pub.restaurant_id = res.id
    JOIN latest            ON latest.restaurant_id = res.id
    JOIN reviews rv        ON rv.id = latest.review_id
    LEFT JOIN locations loc ON loc.id = res.location_id
    LEFT JOIN cover         ON cover.review_id = latest.review_id
    ORDER BY COALESCE(pub.latest_visit_date, '0000-00-00') DESC, pub.avg_overall DESC
    LIMIT ?
  `;
  const { results } = await db.prepare(sql).bind(limit).all<Record<string, unknown>>();

  const ids = results.map((r) => r.id as number);
  const tagsByRestaurant = new Map<number, { slug: string; label: string; category: TagCategory }[]>();
  if (ids.length > 0) {
    const tagSql = `
      SELECT rt.restaurant_id, t.slug, t.label, t.category
      FROM restaurant_tags rt
      JOIN tags t ON t.id = rt.tag_id
      WHERE rt.restaurant_id IN (${ids.map(() => '?').join(',')})
      ORDER BY t.category, t.label
    `;
    const { results: tagRows } = await db
      .prepare(tagSql)
      .bind(...ids)
      .all<{ restaurant_id: number; slug: string; label: string; category: TagCategory }>();
    for (const row of tagRows) {
      const arr = tagsByRestaurant.get(row.restaurant_id) ?? [];
      arr.push({ slug: row.slug, label: row.label, category: row.category });
      tagsByRestaurant.set(row.restaurant_id, arr);
    }
  }

  return results.map((r): FeaturedPlaceData => ({
    id: r.id as number,
    slug: r.slug as string,
    name: r.name as string,
    cuisine: (r.cuisine as string | null) ?? null,
    location: (r.location as string | null) ?? null,
    price_tier: (r.price_tier as number | null) ?? null,
    wishlist_note: (r.wishlist_note as string | null) ?? null,
    visited: true,
    review_count: (r.review_count as number) ?? 0,
    avg_overall: (r.avg_overall as number | null) ?? null,
    latest_visit_date: (r.latest_visit_date as string | null) ?? null,
    latest_meal_type: (r.latest_meal_type as string | null) ?? null,
    cover_r2_key: (r.cover_r2_key as string | null) ?? null,
    hero_photo_name: (r.hero_photo_name as string | null) ?? null,
    commentary: (r.commentary as string | null) ?? null,
    rating_overall: (r.rating_overall as number | null) ?? null,
    rating_size: (r.rating_size as number | null) ?? null,
    tags: tagsByRestaurant.get(r.id as number) ?? [],
  }));
}

export async function getWishlistPreview(
  db: D1Database,
  limit = 20
): Promise<RestaurantCardData[]> {
  const sql = `
    SELECT
      res.id, res.slug, res.name, res.cuisine, res.price_tier, res.wishlist_note,
      res.hero_photo_name,
      loc.name AS location
    FROM restaurants res
    LEFT JOIN locations loc ON loc.id = res.location_id
    LEFT JOIN reviews rv ON rv.restaurant_id = res.id AND rv.status = 'published'
    WHERE rv.id IS NULL
    GROUP BY res.id
    ORDER BY res.created_at DESC
    LIMIT ?
  `;
  const { results } = await db.prepare(sql).bind(limit).all<Record<string, unknown>>();
  return results.map((r): RestaurantCardData => ({
    id: r.id as number,
    slug: r.slug as string,
    name: r.name as string,
    cuisine: (r.cuisine as string | null) ?? null,
    location: (r.location as string | null) ?? null,
    price_tier: (r.price_tier as number | null) ?? null,
    wishlist_note: (r.wishlist_note as string | null) ?? null,
    visited: false,
    review_count: 0,
    avg_overall: null,
    latest_visit_date: null,
    latest_meal_type: null,
    cover_r2_key: null,
    hero_photo_name: (r.hero_photo_name as string | null) ?? null,
    tags: [],
  }));
}

// ---- Admin queries ----------------------------------------------------------

export async function adminListRestaurants(db: D1Database): Promise<AdminRestaurantRow[]> {
  const { results } = await db
    .prepare(
      `
      SELECT
        res.id, res.slug, res.name, res.cuisine, res.price_tier,
        loc.name AS location,
        COALESCE(SUM(CASE WHEN rv.id IS NOT NULL THEN 1 ELSE 0 END), 0)                      AS review_count,
        COALESCE(SUM(CASE WHEN rv.status = 'published' THEN 1 ELSE 0 END), 0)                AS published_count,
        COALESCE(SUM(CASE WHEN rv.status = 'draft'     THEN 1 ELSE 0 END), 0)                AS draft_count,
        MAX(CASE WHEN rv.status = 'published' THEN rv.visit_date END)                        AS latest_visit_date
      FROM restaurants res
      LEFT JOIN locations loc ON loc.id = res.location_id
      LEFT JOIN reviews   rv  ON rv.restaurant_id = res.id
      GROUP BY res.id
      ORDER BY res.updated_at DESC, res.name ASC
      `
    )
    .all<AdminRestaurantRow>();
  return results;
}

export async function getRestaurantForEdit(
  db: D1Database,
  id: number
): Promise<RestaurantEditData | null> {
  const row = await db
    .prepare(
      `SELECT id, slug, name, cuisine, location_id, address, price_tier,
              website_url, maps_url, place_id, lat, lng, wishlist_note
       FROM restaurants WHERE id = ?`
    )
    .bind(id)
    .first<Omit<RestaurantEditData, 'tag_ids'>>();
  if (!row) return null;

  const { results: tagRows } = await db
    .prepare('SELECT tag_id FROM restaurant_tags WHERE restaurant_id = ?')
    .bind(id)
    .all<{ tag_id: number }>();
  return { ...row, tag_ids: tagRows.map((t) => t.tag_id) };
}

export interface RestaurantInput {
  slug: string;
  name: string;
  cuisine: string | null;
  location_id: number | null;
  address: string | null;
  price_tier: number | null;
  website_url: string | null;
  maps_url: string | null;
  place_id: string | null;
  lat: number | null;
  lng: number | null;
  wishlist_note: string | null;
  tag_ids: number[];
}

export async function createRestaurant(db: D1Database, data: RestaurantInput): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO restaurants
       (slug, name, cuisine, location_id, address, price_tier,
        website_url, maps_url, place_id, lat, lng, wishlist_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      data.slug,
      data.name,
      data.cuisine,
      data.location_id,
      data.address,
      data.price_tier,
      data.website_url,
      data.maps_url,
      data.place_id,
      data.lat,
      data.lng,
      data.wishlist_note
    )
    .run();
  const id = Number(res.meta.last_row_id);
  await replaceRestaurantTags(db, id, data.tag_ids);
  return id;
}

export async function updateRestaurant(
  db: D1Database,
  id: number,
  data: RestaurantInput
): Promise<void> {
  await db
    .prepare(
      `UPDATE restaurants SET
         slug = ?, name = ?, cuisine = ?, location_id = ?, address = ?,
         price_tier = ?, website_url = ?, maps_url = ?, place_id = ?, lat = ?, lng = ?,
         wishlist_note = ?, updated_at = unixepoch()
       WHERE id = ?`
    )
    .bind(
      data.slug,
      data.name,
      data.cuisine,
      data.location_id,
      data.address,
      data.price_tier,
      data.website_url,
      data.maps_url,
      data.place_id,
      data.lat,
      data.lng,
      data.wishlist_note,
      id
    )
    .run();
  await replaceRestaurantTags(db, id, data.tag_ids);
}

async function replaceRestaurantTags(
  db: D1Database,
  restaurantId: number,
  tagIds: number[]
): Promise<void> {
  await db.prepare('DELETE FROM restaurant_tags WHERE restaurant_id = ?').bind(restaurantId).run();
  if (tagIds.length === 0) return;
  const stmt = db.prepare('INSERT INTO restaurant_tags (restaurant_id, tag_id) VALUES (?, ?)');
  await db.batch(tagIds.map((tid) => stmt.bind(restaurantId, tid)));
}

export async function deleteRestaurant(db: D1Database, id: number): Promise<string[]> {
  // Collect R2 keys of photos that will be cascade-deleted so the caller can remove them from R2.
  const { results: photoRows } = await db
    .prepare(
      `SELECT p.r2_key
       FROM photos p
       JOIN reviews rv ON rv.id = p.review_id
       WHERE rv.restaurant_id = ?`
    )
    .bind(id)
    .all<{ r2_key: string }>();
  await db.prepare('DELETE FROM restaurants WHERE id = ?').bind(id).run();
  return photoRows.map((r) => r.r2_key);
}

export async function getReviewsForRestaurant(
  db: D1Database,
  restaurantId: number
): Promise<ReviewListRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, slug, visit_date, meal_type, rating_overall, status
       FROM reviews
       WHERE restaurant_id = ?
       ORDER BY visit_date DESC, id DESC`
    )
    .bind(restaurantId)
    .all<ReviewListRow>();
  return results;
}

export async function getReviewForEdit(
  db: D1Database,
  id: number
): Promise<ReviewEditData | null> {
  const row = await db
    .prepare(
      `SELECT rv.id, rv.restaurant_id, res.name AS restaurant_name, rv.slug,
              rv.visit_date, rv.meal_type, rv.rating_overall, rv.rating_size,
              rv.commentary, rv.would_return, rv.instagram_url, rv.status
       FROM reviews rv
       JOIN restaurants res ON res.id = rv.restaurant_id
       WHERE rv.id = ?`
    )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) return null;

  const { results: items } = await db
    .prepare(
      `SELECT id, name, note, is_standout, sort_order
       FROM standout_items
       WHERE review_id = ?
       ORDER BY sort_order, id`
    )
    .bind(id)
    .all<{ id: number; name: string; note: string | null; is_standout: number; sort_order: number }>();

  const { results: photos } = await db
    .prepare(
      `SELECT id, r2_key, alt, is_cover, sort_order
       FROM photos
       WHERE review_id = ?
       ORDER BY is_cover DESC, sort_order, id`
    )
    .bind(id)
    .all<{ id: number; r2_key: string; alt: string | null; is_cover: number; sort_order: number }>();

  return {
    id: row.id as number,
    restaurant_id: row.restaurant_id as number,
    restaurant_name: row.restaurant_name as string,
    slug: row.slug as string,
    visit_date: (row.visit_date as string | null) ?? null,
    meal_type: (row.meal_type as MealType | null) ?? null,
    rating_overall: row.rating_overall as number,
    rating_size: (row.rating_size as number | null) ?? null,
    commentary: (row.commentary as string | null) ?? null,
    would_return: row.would_return === 1,
    instagram_url: (row.instagram_url as string | null) ?? null,
    status: row.status as ReviewStatus,
    standout_items: items.map((i) => ({
      id: i.id,
      name: i.name,
      note: i.note,
      is_standout: i.is_standout === 1,
      sort_order: i.sort_order,
    })),
    photos: photos.map((p) => ({
      id: p.id,
      r2_key: p.r2_key,
      alt: p.alt,
      is_cover: p.is_cover === 1,
      sort_order: p.sort_order,
    })),
  };
}

export interface ReviewInput {
  restaurant_id: number;
  slug: string;
  visit_date: string | null;
  meal_type: MealType | null;
  rating_overall: number;
  rating_size: number | null;
  commentary: string | null;
  would_return: boolean;
  instagram_url: string | null;
  status: ReviewStatus;
  standout_items: { name: string; note: string | null; is_standout: boolean }[];
}

export async function createReview(db: D1Database, data: ReviewInput): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO reviews
       (restaurant_id, slug, visit_date, meal_type,
        rating_overall, rating_size, commentary, would_return, instagram_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      data.restaurant_id,
      data.slug,
      data.visit_date,
      data.meal_type,
      data.rating_overall,
      data.rating_size,
      data.commentary,
      data.would_return ? 1 : 0,
      data.instagram_url,
      data.status
    )
    .run();
  const id = Number(res.meta.last_row_id);
  await replaceStandoutItems(db, id, data.standout_items);
  return id;
}

export async function updateReview(
  db: D1Database,
  id: number,
  data: ReviewInput
): Promise<void> {
  await db
    .prepare(
      `UPDATE reviews SET
         slug = ?, visit_date = ?, meal_type = ?, rating_overall = ?, rating_size = ?,
         commentary = ?, would_return = ?, instagram_url = ?, status = ?,
         updated_at = unixepoch()
       WHERE id = ?`
    )
    .bind(
      data.slug,
      data.visit_date,
      data.meal_type,
      data.rating_overall,
      data.rating_size,
      data.commentary,
      data.would_return ? 1 : 0,
      data.instagram_url,
      data.status,
      id
    )
    .run();
  await replaceStandoutItems(db, id, data.standout_items);
}

async function replaceStandoutItems(
  db: D1Database,
  reviewId: number,
  items: { name: string; note: string | null; is_standout: boolean }[]
): Promise<void> {
  await db.prepare('DELETE FROM standout_items WHERE review_id = ?').bind(reviewId).run();
  if (items.length === 0) return;
  const stmt = db.prepare(
    'INSERT INTO standout_items (review_id, name, note, is_standout, sort_order) VALUES (?, ?, ?, ?, ?)'
  );
  await db.batch(
    items.map((it, i) => stmt.bind(reviewId, it.name, it.note, it.is_standout ? 1 : 0, i))
  );
}

export async function deleteReview(db: D1Database, id: number): Promise<string[]> {
  const { results: photoRows } = await db
    .prepare('SELECT r2_key FROM photos WHERE review_id = ?')
    .bind(id)
    .all<{ r2_key: string }>();
  await db.prepare('DELETE FROM reviews WHERE id = ?').bind(id).run();
  return photoRows.map((r) => r.r2_key);
}

export async function insertPhoto(
  db: D1Database,
  reviewId: number,
  r2Key: string,
  alt: string | null,
  width: number | null,
  height: number | null,
  makeCover: boolean
): Promise<number> {
  // Next sort_order = current max + 1
  const maxRow = await db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM photos WHERE review_id = ?')
    .bind(reviewId)
    .first<{ max_order: number }>();
  const sortOrder = (maxRow?.max_order ?? -1) + 1;

  if (makeCover) {
    await db.prepare('UPDATE photos SET is_cover = 0 WHERE review_id = ?').bind(reviewId).run();
  }

  const res = await db
    .prepare(
      `INSERT INTO photos (review_id, r2_key, alt, width, height, sort_order, is_cover)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(reviewId, r2Key, alt, width, height, sortOrder, makeCover ? 1 : 0)
    .run();
  return Number(res.meta.last_row_id);
}

export async function deletePhoto(db: D1Database, id: number): Promise<string | null> {
  const row = await db
    .prepare('SELECT r2_key FROM photos WHERE id = ?')
    .bind(id)
    .first<{ r2_key: string }>();
  if (!row) return null;
  await db.prepare('DELETE FROM photos WHERE id = ?').bind(id).run();
  return row.r2_key;
}

export async function setPhotoCover(db: D1Database, photoId: number): Promise<void> {
  const row = await db
    .prepare('SELECT review_id FROM photos WHERE id = ?')
    .bind(photoId)
    .first<{ review_id: number }>();
  if (!row) return;
  await db.batch([
    db.prepare('UPDATE photos SET is_cover = 0 WHERE review_id = ?').bind(row.review_id),
    db.prepare('UPDATE photos SET is_cover = 1 WHERE id = ?').bind(photoId),
  ]);
}
