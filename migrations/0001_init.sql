-- Lucas Eats Big — initial schema

CREATE TABLE locations (
  id   INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE tags (
  id       INTEGER PRIMARY KEY,
  slug     TEXT NOT NULL UNIQUE,
  label    TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('vibe','dietary','other'))
);

CREATE TABLE restaurants (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  cuisine       TEXT,
  location_id   INTEGER REFERENCES locations(id),
  address       TEXT,
  price_tier    INTEGER CHECK(price_tier BETWEEN 1 AND 5),
  website_url   TEXT,
  menu_url      TEXT,
  wishlist_note TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE restaurant_tags (
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  tag_id        INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (restaurant_id, tag_id)
);

CREATE TABLE reviews (
  id              INTEGER PRIMARY KEY,
  restaurant_id   INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL UNIQUE,
  visit_date      TEXT NOT NULL,
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

CREATE TABLE standout_items (
  id           INTEGER PRIMARY KEY,
  review_id    INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  note         TEXT,
  is_standout  INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE photos (
  id         INTEGER PRIMARY KEY,
  review_id  INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  r2_key     TEXT NOT NULL,
  alt        TEXT,
  width      INTEGER,
  height     INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_cover   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_reviews_restaurant  ON reviews(restaurant_id);
CREATE INDEX idx_reviews_status_date ON reviews(status, visit_date DESC);
CREATE INDEX idx_reviews_meal        ON reviews(meal_type);
CREATE INDEX idx_photos_review       ON photos(review_id);
CREATE INDEX idx_standout_review     ON standout_items(review_id);
CREATE INDEX idx_restaurant_location ON restaurants(location_id);
