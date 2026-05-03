-- Posts table: AI-generated long-form SEO content.
-- Initial use case is cuisine listicles ("Best Italian in Sydney"), with
-- room to grow into suburb guides and monthly recaps.
--
-- All content is grounded in real restaurant data — `source_filter` records
-- which D1 query produced the source set, `featured_restaurants_json` lists
-- the IDs the post actually links to, and `og_image_restaurant_id` points at
-- whichever restaurant supplies the OG card thumbnail.
--
-- Slugs are stable; regenerating a post UPSERTs by (kind, source_filter) so
-- the URL stays the same and search engines see lastmod updates rather than
-- new pages.

CREATE TABLE IF NOT EXISTS posts (
  id                       INTEGER PRIMARY KEY,
  slug                     TEXT NOT NULL UNIQUE,
  kind                     TEXT NOT NULL,            -- 'cuisine' | 'suburb' | 'recap' (future)
  source_filter            TEXT NOT NULL,            -- e.g. 'Italian' (cuisine), 'surry-hills' (suburb)
  title                    TEXT NOT NULL,
  description              TEXT NOT NULL,            -- ≤160 chars for OG/Twitter
  body_md                  TEXT NOT NULL,            -- markdown
  og_image_restaurant_id   INTEGER REFERENCES restaurants(id) ON DELETE SET NULL,
  featured_restaurants_json TEXT NOT NULL DEFAULT '[]',  -- JSON array of restaurant IDs
  generated_at             INTEGER NOT NULL DEFAULT (unixepoch()),
  published_at             INTEGER,                  -- null = draft, populated when ready to surface
  model                    TEXT,                     -- e.g. 'claude-opus-4-7'
  status                   TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_kind_source ON posts(kind, source_filter);
CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(status, published_at);
