-- related_posts: cross-link graph between guides.
--
-- Populated by the generator pipeline after a post is created. Surfaces a
-- "see also" panel on each guide so a reader landing on "Best Italian Sydney"
-- can hop to "Best Restaurants in Surry Hills" (shared restaurants), or to
-- "Date Night Sydney" (overlapping featured set).
--
-- Internal-link compounding is the main SEO win once you have ≥10 guides —
-- this table is what powers it.

CREATE TABLE IF NOT EXISTS related_posts (
  post_slug      TEXT NOT NULL,
  related_slug   TEXT NOT NULL,
  relation_type  TEXT NOT NULL,    -- 'shared-restaurants' | 'same-cuisine' | 'same-suburb' | 'manual'
  weight         REAL NOT NULL DEFAULT 1.0,    -- ranking signal (more shared restaurants = higher)
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (post_slug, related_slug)
);

CREATE INDEX IF NOT EXISTS idx_related_post   ON related_posts(post_slug, weight DESC);
