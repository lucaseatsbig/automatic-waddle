-- Add Google Maps fields to restaurants and make reviews.visit_date optional.

ALTER TABLE restaurants ADD COLUMN place_id TEXT;
ALTER TABLE restaurants ADD COLUMN lat      REAL;
ALTER TABLE restaurants ADD COLUMN lng      REAL;
ALTER TABLE restaurants ADD COLUMN maps_url TEXT;

CREATE INDEX IF NOT EXISTS idx_restaurant_place_id ON restaurants(place_id);

-- SQLite can't change a NOT NULL constraint in place, so rebuild the reviews table.
PRAGMA foreign_keys = OFF;

CREATE TABLE reviews_new (
  id              INTEGER PRIMARY KEY,
  restaurant_id   INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL UNIQUE,
  visit_date      TEXT,
  meal_type       TEXT,
  rating_overall  REAL NOT NULL,
  rating_food     REAL,
  rating_vibe     REAL,
  rating_service  REAL,
  rating_value    REAL,
  rating_size     REAL,
  commentary      TEXT,
  would_return    INTEGER NOT NULL,
  instagram_url   TEXT,
  status          TEXT NOT NULL DEFAULT 'published'
                    CHECK(status IN ('draft','published')),
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO reviews_new
  (id, restaurant_id, slug, visit_date, meal_type,
   rating_overall, rating_food, rating_vibe, rating_service, rating_value, rating_size,
   commentary, would_return, instagram_url, status, created_at, updated_at)
SELECT
  id, restaurant_id, slug, visit_date, meal_type,
  rating_overall, rating_food, rating_vibe, rating_service, rating_value, rating_size,
  commentary, would_return, instagram_url, status, created_at, updated_at
FROM reviews;

DROP TABLE reviews;
ALTER TABLE reviews_new RENAME TO reviews;

CREATE INDEX idx_reviews_restaurant  ON reviews(restaurant_id);
CREATE INDEX idx_reviews_status_date ON reviews(status, visit_date DESC);
CREATE INDEX idx_reviews_meal        ON reviews(meal_type);

PRAGMA foreign_keys = ON;
