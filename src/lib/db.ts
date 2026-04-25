import type {
  AdminRestaurantRow,
  Filters,
  Location,
  MealType,
  RestaurantCardData,
  RestaurantEditData,
  ReviewEditData,
  ReviewListRow,
  ReviewStatus,
  Tag,
  TagCategory,
} from './types';

export async function getLocations(db: D1Database): Promise<Location[]> {
  const { results } = await db
    .prepare('SELECT id, slug, name FROM locations ORDER BY name')
    .all<Location>();
  return results;
}

export async function getTags(db: D1Database): Promise<Tag[]> {
  const { results } = await db
    .prepare('SELECT id, slug, label, category FROM tags ORDER BY category, label')
    .all<Tag>();
  return results;
}

export async function getCuisines(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT DISTINCT cuisine FROM restaurants WHERE cuisine IS NOT NULL AND cuisine <> '' ORDER BY cuisine"
    )
    .all<{ cuisine: string }>();
  return results.map((r) => r.cuisine);
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

export async function searchRestaurants(
  db: D1Database,
  f: Filters
): Promise<RestaurantCardData[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (f.q) {
    where.push(`(
      res.name LIKE ?
      OR EXISTS (
        SELECT 1 FROM reviews rv
        JOIN standout_items si ON si.review_id = rv.id
        WHERE rv.restaurant_id = res.id AND rv.status = 'published'
          AND si.name LIKE ?
      )
    )`);
    const like = `%${f.q}%`;
    params.push(like, like);
  }
  if (f.cuisine) {
    where.push('res.cuisine = ?');
    params.push(f.cuisine);
  }
  if (f.location) {
    where.push('loc.slug = ?');
    params.push(f.location);
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
      CASE WHEN COALESCE(pub.review_count, 0) > 0 THEN 1 ELSE 0 END AS visited
    FROM restaurants res
    LEFT JOIN locations   loc         ON loc.id = res.location_id
    LEFT JOIN pub                     ON pub.restaurant_id         = res.id
    LEFT JOIN latest_meta             ON latest_meta.restaurant_id = res.id
    LEFT JOIN cover                   ON cover.review_id           = latest_meta.review_id
    ${whereSql}
    ORDER BY
      CASE WHEN COALESCE(pub.review_count, 0) > 0 THEN 0 ELSE 1 END,
      latest_meta.visit_date DESC,
      res.name ASC
  `;

  const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
  const { results } = await stmt.all<Record<string, unknown>>();

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
    tags: tagsByRestaurant.get(r.id as number) ?? [],
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
              rv.visit_date, rv.meal_type,
              rv.rating_overall, rv.rating_food, rv.rating_vibe, rv.rating_service,
              rv.rating_value, rv.rating_size,
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
    rating_food: (row.rating_food as number | null) ?? null,
    rating_vibe: (row.rating_vibe as number | null) ?? null,
    rating_service: (row.rating_service as number | null) ?? null,
    rating_value: (row.rating_value as number | null) ?? null,
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
  rating_food: number | null;
  rating_vibe: number | null;
  rating_service: number | null;
  rating_value: number | null;
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
        rating_overall, rating_food, rating_vibe, rating_service, rating_value, rating_size,
        commentary, would_return, instagram_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      data.restaurant_id,
      data.slug,
      data.visit_date,
      data.meal_type,
      data.rating_overall,
      data.rating_food,
      data.rating_vibe,
      data.rating_service,
      data.rating_value,
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
         slug = ?, visit_date = ?, meal_type = ?,
         rating_overall = ?, rating_food = ?, rating_vibe = ?, rating_service = ?,
         rating_value = ?, rating_size = ?,
         commentary = ?, would_return = ?, instagram_url = ?, status = ?,
         updated_at = unixepoch()
       WHERE id = ?`
    )
    .bind(
      data.slug,
      data.visit_date,
      data.meal_type,
      data.rating_overall,
      data.rating_food,
      data.rating_vibe,
      data.rating_service,
      data.rating_value,
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
