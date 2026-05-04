-- Topics queue: discovered SEO topics waiting to be turned into guides.
--
-- Populated by scripts/crawl-trends.mjs (Google autocomplete + optional
-- DataForSEO volume enrichment). Consumed by scripts/generate.mjs which
-- routes each topic to the right generator (cuisine / suburb / themed)
-- based on `type`.
--
-- The `coverage_count` field is recomputed each crawl: it tells the router
-- which topics already have enough Lucas-data to support a guide. Topics
-- below the minimum coverage stay queued but get skipped — they become
-- eligible later as Lucas adds more reviews.

CREATE TABLE IF NOT EXISTS topics (
  id              INTEGER PRIMARY KEY,
  query           TEXT NOT NULL UNIQUE,             -- "best italian sydney"
  type            TEXT NOT NULL,                    -- 'cuisine' | 'suburb' | 'themed'
  filter_value    TEXT NOT NULL,                    -- 'Italian' | 'surry-hills' | JSON for themed
  monthly_volume  INTEGER,                          -- nullable; populated from DataForSEO if available
  intent          TEXT,                             -- 'commercial' | 'informational' | NULL
  coverage_count  INTEGER NOT NULL DEFAULT 0,       -- restaurants in source-set at last crawl
  paa_json        TEXT,                             -- JSON array of "People Also Ask" suggestions
  status          TEXT NOT NULL DEFAULT 'queued'    -- 'queued' | 'generating' | 'generated' | 'skipped'
                    CHECK (status IN ('queued', 'generating', 'generated', 'skipped')),
  source          TEXT,                             -- 'autocomplete' | 'paa' | 'manual'
  notes           TEXT,                             -- skip reason, manual annotations, etc.
  post_slug       TEXT,                             -- back-pointer to posts.slug after generation
  discovered_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  generated_at    INTEGER,                          -- when router picked it up
  refreshed_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_topics_status_volume
  ON topics(status, monthly_volume DESC, coverage_count DESC);
CREATE INDEX IF NOT EXISTS idx_topics_type ON topics(type);
