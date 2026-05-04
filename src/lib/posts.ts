// D1 query helpers for the `posts` table (AI-generated long-form guides).
// Mirrors the shape of src/lib/db.ts — keeps the runtime code path narrow:
// guides only need read-side queries; writes happen offline via
// scripts/generate-cuisine-guides.mjs producing SQL applied with
// `wrangler d1 execute --file=...`.

export type PostKind = 'cuisine' | 'suburb' | 'recap';
export type PostStatus = 'draft' | 'published';

export interface PostListItem {
  id: number;
  slug: string;
  kind: PostKind;
  source_filter: string;
  title: string;
  description: string;
  og_image_restaurant_id: number | null;
  og_image_cover_r2_key: string | null;
  og_image_hero_photo_name: string | null;
  published_at: number | null;
  generated_at: number;
}

export interface PostDetail extends PostListItem {
  body_md: string;
  featured_restaurant_ids: number[];
  status: PostStatus;
  model: string | null;
}

/**
 * Featured restaurants on a guide — minimum fields needed to render an
 * inline card link. Fetched in one batched query so we don't N+1 inside the
 * markdown renderer.
 */
export interface FeaturedRestaurantSummary {
  id: number;
  slug: string;
  name: string;
  cuisine: string | null;
  location: string | null;
  avg_overall: number | null;
  cover_r2_key: string | null;
  hero_photo_name: string | null;
}

export async function listPublishedPosts(db: D1Database): Promise<PostListItem[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.slug, p.kind, p.source_filter, p.title, p.description,
              p.og_image_restaurant_id, p.published_at, p.generated_at,
              cover.r2_key AS og_image_cover_r2_key,
              res.hero_photo_name AS og_image_hero_photo_name
         FROM posts p
         LEFT JOIN restaurants res ON res.id = p.og_image_restaurant_id
         LEFT JOIN (
           SELECT rv.restaurant_id, MIN(ph.r2_key) AS r2_key
             FROM photos ph
             JOIN reviews rv ON rv.id = ph.review_id
            WHERE ph.is_cover = 1
            GROUP BY rv.restaurant_id
         ) cover ON cover.restaurant_id = p.og_image_restaurant_id
        WHERE p.status = 'published'
        ORDER BY COALESCE(p.published_at, p.generated_at) DESC`
    )
    .all<PostListItem>();
  return results;
}

export async function getPostBySlug(
  db: D1Database,
  slug: string
): Promise<PostDetail | null> {
  const row = await db
    .prepare(
      `SELECT p.id, p.slug, p.kind, p.source_filter, p.title, p.description,
              p.body_md, p.og_image_restaurant_id, p.featured_restaurants_json,
              p.published_at, p.generated_at, p.status, p.model,
              cover.r2_key AS og_image_cover_r2_key,
              res.hero_photo_name AS og_image_hero_photo_name
         FROM posts p
         LEFT JOIN restaurants res ON res.id = p.og_image_restaurant_id
         LEFT JOIN (
           SELECT rv.restaurant_id, MIN(ph.r2_key) AS r2_key
             FROM photos ph
             JOIN reviews rv ON rv.id = ph.review_id
            WHERE ph.is_cover = 1
            GROUP BY rv.restaurant_id
         ) cover ON cover.restaurant_id = p.og_image_restaurant_id
        WHERE p.slug = ? AND p.status = 'published'
        LIMIT 1`
    )
    .bind(slug)
    .first<{
      id: number;
      slug: string;
      kind: PostKind;
      source_filter: string;
      title: string;
      description: string;
      body_md: string;
      og_image_restaurant_id: number | null;
      og_image_cover_r2_key: string | null;
      og_image_hero_photo_name: string | null;
      featured_restaurants_json: string;
      published_at: number | null;
      generated_at: number;
      status: PostStatus;
      model: string | null;
    }>();

  if (!row) return null;

  let featured: number[] = [];
  try {
    const parsed = JSON.parse(row.featured_restaurants_json);
    if (Array.isArray(parsed)) {
      featured = parsed.filter((n): n is number => typeof n === 'number');
    }
  } catch {
    // Ignore — corrupted row, treat as no featured list.
  }

  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    source_filter: row.source_filter,
    title: row.title,
    description: row.description,
    body_md: row.body_md,
    og_image_restaurant_id: row.og_image_restaurant_id,
    og_image_cover_r2_key: row.og_image_cover_r2_key,
    og_image_hero_photo_name: row.og_image_hero_photo_name,
    featured_restaurant_ids: featured,
    published_at: row.published_at,
    generated_at: row.generated_at,
    status: row.status,
    model: row.model,
  };
}

export interface RelatedPostSummary {
  slug: string;
  kind: PostKind;
  title: string;
  description: string;
  relation_type: string;
  weight: number;
  og_image_cover_r2_key: string | null;
  og_image_hero_photo_name: string | null;
}

/**
 * Fetch up to `limit` related published posts for the given post slug,
 * ordered by relation weight (more shared restaurants = higher).
 */
export async function getRelatedPosts(
  db: D1Database,
  slug: string,
  limit: number = 4
): Promise<RelatedPostSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT p.slug, p.kind, p.title, p.description, rp.relation_type, rp.weight,
              cover.r2_key AS og_image_cover_r2_key,
              res.hero_photo_name AS og_image_hero_photo_name
         FROM related_posts rp
         JOIN posts p ON p.slug = rp.related_slug AND p.status = 'published'
         LEFT JOIN restaurants res ON res.id = p.og_image_restaurant_id
         LEFT JOIN (
           SELECT rv.restaurant_id, MIN(ph.r2_key) AS r2_key
             FROM photos ph
             JOIN reviews rv ON rv.id = ph.review_id
            WHERE ph.is_cover = 1
            GROUP BY rv.restaurant_id
         ) cover ON cover.restaurant_id = p.og_image_restaurant_id
        WHERE rp.post_slug = ?
        ORDER BY rp.weight DESC, p.published_at DESC
        LIMIT ?`
    )
    .bind(slug, limit)
    .all<RelatedPostSummary>();
  return results;
}

export async function getFeaturedRestaurantsForPost(
  db: D1Database,
  ids: number[]
): Promise<FeaturedRestaurantSummary[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const sql = `
    WITH pub AS (
      SELECT r.restaurant_id, AVG(r.rating_overall) AS avg_overall
        FROM reviews r
       WHERE r.status = 'published'
       GROUP BY r.restaurant_id
    ),
    cover AS (
      SELECT rv.restaurant_id, MIN(ph.r2_key) AS r2_key
        FROM photos ph
        JOIN reviews rv ON rv.id = ph.review_id
       WHERE ph.is_cover = 1
       GROUP BY rv.restaurant_id
    )
    SELECT res.id, res.slug, res.name, res.cuisine,
           res.hero_photo_name,
           loc.name AS location,
           pub.avg_overall,
           cover.r2_key AS cover_r2_key
      FROM restaurants res
      LEFT JOIN locations loc ON loc.id = res.location_id
      LEFT JOIN pub             ON pub.restaurant_id   = res.id
      LEFT JOIN cover           ON cover.restaurant_id = res.id
     WHERE res.id IN (${placeholders})
  `;
  const { results } = await db
    .prepare(sql)
    .bind(...ids)
    .all<FeaturedRestaurantSummary>();

  // Preserve the order of `ids` so the markdown's mention order matches the
  // card grid below it.
  const byId = new Map(results.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is FeaturedRestaurantSummary => !!r);
}

/**
 * Source-set query for cuisine listicles: every visited restaurant matching
 * the cuisine, with all the data the AI needs to write a grounded post.
 * Used by the offline generation script, but lives here so the SQL is shared.
 */
export interface CuisineSourceRow {
  id: number;
  slug: string;
  name: string;
  cuisine: string | null;
  location: string | null;
  address: string | null;
  price_tier: number | null;
  avg_overall: number | null;
  visit_count: number;
  latest_visit_date: string | null;
  cover_r2_key: string | null;
  hero_photo_name: string | null;
  /** Concatenated commentary across all published reviews, separated by ` || `. */
  commentary_blob: string | null;
  /** Comma-separated list of standout dish names. */
  standouts_blob: string | null;
  /** Comma-separated list of tag labels. */
  tags_blob: string | null;
}

export async function getCuisineSourceSet(
  db: D1Database,
  cuisine: string
): Promise<CuisineSourceRow[]> {
  const { results } = await db
    .prepare(
      `WITH pub AS (
         SELECT r.restaurant_id,
                COUNT(*) AS visit_count,
                AVG(r.rating_overall) AS avg_overall,
                MAX(r.visit_date) AS latest_visit_date
           FROM reviews r
          WHERE r.status = 'published'
          GROUP BY r.restaurant_id
       ),
       cover AS (
         SELECT rv.restaurant_id, MIN(ph.r2_key) AS r2_key
           FROM photos ph
           JOIN reviews rv ON rv.id = ph.review_id
          WHERE ph.is_cover = 1
          GROUP BY rv.restaurant_id
       ),
       commentary AS (
         SELECT rv.restaurant_id,
                GROUP_CONCAT(rv.commentary, ' || ') AS commentary_blob
           FROM reviews rv
          WHERE rv.status = 'published' AND rv.commentary IS NOT NULL AND rv.commentary <> ''
          GROUP BY rv.restaurant_id
       ),
       standouts AS (
         SELECT rv.restaurant_id,
                GROUP_CONCAT(si.name, ', ') AS standouts_blob
           FROM standout_items si
           JOIN reviews rv ON rv.id = si.review_id
          WHERE rv.status = 'published' AND si.is_standout = 1
          GROUP BY rv.restaurant_id
       ),
       tagblobs AS (
         SELECT rt.restaurant_id,
                GROUP_CONCAT(t.label, ', ') AS tags_blob
           FROM restaurant_tags rt
           JOIN tags t ON t.id = rt.tag_id
          GROUP BY rt.restaurant_id
       )
       SELECT res.id, res.slug, res.name, res.cuisine, res.address, res.price_tier,
              res.hero_photo_name,
              loc.name AS location,
              pub.visit_count, pub.avg_overall, pub.latest_visit_date,
              cover.r2_key AS cover_r2_key,
              commentary.commentary_blob,
              standouts.standouts_blob,
              tagblobs.tags_blob
         FROM restaurants res
         JOIN pub        ON pub.restaurant_id     = res.id
         LEFT JOIN locations loc ON loc.id        = res.location_id
         LEFT JOIN cover         ON cover.restaurant_id      = res.id
         LEFT JOIN commentary    ON commentary.restaurant_id = res.id
         LEFT JOIN standouts     ON standouts.restaurant_id  = res.id
         LEFT JOIN tagblobs      ON tagblobs.restaurant_id   = res.id
        WHERE LOWER(res.cuisine) = LOWER(?)
        ORDER BY pub.avg_overall DESC NULLS LAST, pub.latest_visit_date DESC, res.name ASC`
    )
    .bind(cuisine)
    .all<CuisineSourceRow>();
  return results;
}
