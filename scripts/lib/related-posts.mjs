// Related-posts graph builder. After a post is generated, we compute which
// other already-published posts share content with it (overlapping featured
// restaurants, same cuisine, same suburb) and emit UPSERT SQL into the
// `related_posts` table. The detail page reads this to render a "see also"
// panel — that's where the internal-link compounding happens.
//
// Symmetric edges: each link is written in both directions so the panel
// works regardless of which post the visitor lands on.

import { queryRemote } from './wrangler.mjs';
import { escSql } from './util.mjs';

/**
 * Build UPSERT statements for related_posts. The caller is generating
 * `current` (it's not yet committed to D1), so we pass its featured set in
 * memory and look up published peers from D1.
 *
 * @param {{slug: string, kind: 'cuisine'|'suburb'|'themed', source_filter: string, featured_restaurant_ids: number[]}} current
 * @returns string[] of UPSERT SQL statements (already terminated with ';')
 */
export function buildRelatedSql(current) {
  const featuredIds = current.featured_restaurant_ids ?? [];
  if (featuredIds.length === 0) return [];

  // Find all other published posts whose featured set overlaps with ours.
  // Limit to recent / non-zero overlaps so the panel doesn't bloat.
  const peers = queryRemote(`
    SELECT slug, kind, source_filter, featured_restaurants_json
      FROM posts
     WHERE status = 'published'
       AND slug <> '${(current.slug ?? '').replace(/'/g, "''")}'
  `);

  const currentSet = new Set(featuredIds);
  const edges = [];

  for (const peer of peers) {
    let peerIds = [];
    try {
      const arr = JSON.parse(peer.featured_restaurants_json ?? '[]');
      if (Array.isArray(arr)) peerIds = arr.filter((n) => typeof n === 'number');
    } catch {
      continue;
    }
    const overlap = peerIds.filter((id) => currentSet.has(id)).length;
    if (overlap === 0) continue;

    let relationType = 'shared-restaurants';
    if (peer.kind === current.kind && peer.source_filter === current.source_filter) continue;
    if (peer.kind === 'cuisine' && current.kind === 'cuisine') relationType = 'same-cuisine-family';
    else if (peer.kind === 'suburb' && current.kind === 'suburb') relationType = 'same-suburb-family';

    // Weight scales with overlap count — caps to avoid one mega-restaurant
    // dominating the graph.
    const weight = Math.min(overlap, 5);

    edges.push({ peerSlug: peer.slug, relationType, weight });
  }

  // Keep top 5 peers per current — anything more clutters the panel.
  edges.sort((a, b) => b.weight - a.weight);
  const top = edges.slice(0, 5);

  const sql = [];
  for (const e of top) {
    // Symmetric: write current → peer AND peer → current.
    sql.push(
      `INSERT INTO related_posts (post_slug, related_slug, relation_type, weight)
VALUES (${escSql(current.slug)}, ${escSql(e.peerSlug)}, ${escSql(e.relationType)}, ${e.weight})
ON CONFLICT (post_slug, related_slug) DO UPDATE SET
  relation_type = excluded.relation_type,
  weight = excluded.weight;`,
      `INSERT INTO related_posts (post_slug, related_slug, relation_type, weight)
VALUES (${escSql(e.peerSlug)}, ${escSql(current.slug)}, ${escSql(e.relationType)}, ${e.weight})
ON CONFLICT (post_slug, related_slug) DO UPDATE SET
  relation_type = excluded.relation_type,
  weight = excluded.weight;`
    );
  }
  return sql;
}
