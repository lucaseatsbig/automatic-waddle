// Shared `posts` UPSERT generator. Used by all three guide generators so
// the SQL stays consistent and (kind, source_filter) UNIQUE behaviour is
// identical across cuisine / suburb / themed.

import { escSql } from './util.mjs';

/**
 * @param {{
 *   kind: 'cuisine' | 'suburb' | 'themed',
 *   source_filter: string,
 *   slug: string,
 *   title: string,
 *   description: string,
 *   body_md: string,
 *   og_image_restaurant_id: number,
 *   featured_restaurant_ids: number[],
 *   model: string,
 *   publish: boolean,
 * }} args
 * @returns string SQL statement (terminated with ';')
 */
export function buildPostUpsert(args) {
  const status = args.publish ? 'published' : 'draft';
  const publishedAt = args.publish ? 'unixepoch()' : 'NULL';
  return `INSERT INTO posts (slug, kind, source_filter, title, description, body_md,
                          og_image_restaurant_id, featured_restaurants_json,
                          model, status, published_at, generated_at)
VALUES (${escSql(args.slug)}, ${escSql(args.kind)}, ${escSql(args.source_filter)},
        ${escSql(args.title)}, ${escSql(args.description)},
        ${escSql(args.body_md)}, ${args.og_image_restaurant_id},
        ${escSql(JSON.stringify(args.featured_restaurant_ids))},
        ${escSql(args.model)}, '${status}', ${publishedAt}, unixepoch())
ON CONFLICT (kind, source_filter) DO UPDATE SET
  slug = excluded.slug,
  title = excluded.title,
  description = excluded.description,
  body_md = excluded.body_md,
  og_image_restaurant_id = excluded.og_image_restaurant_id,
  featured_restaurants_json = excluded.featured_restaurants_json,
  model = excluded.model,
  status = excluded.status,
  published_at = excluded.published_at,
  generated_at = unixepoch();`;
}
