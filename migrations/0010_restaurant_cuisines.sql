-- Many-to-many cuisine relation. The original `restaurants.cuisine` column
-- stored a single text value, sometimes comma-separated for fusion places
-- (e.g. "American, Japanese"). That made the filter dropdown clunky — every
-- combo became its own option and a restaurant only matched the exact
-- combined string. This table stores one row per cuisine per restaurant so
-- a place tagged American + Japanese matches both filters independently.
--
-- restaurants.cuisine is kept around as the single "primary" / display
-- cuisine for cards. The join table is the source of truth for filtering
-- and for the cuisines list shown in the filter UI.
--
-- Backfill is handled by scripts/backfill-cuisines.mjs — run once after
-- applying this migration to local + remote.

CREATE TABLE IF NOT EXISTS restaurant_cuisines (
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  cuisine       TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,  -- 0 = primary (display on cards)
  PRIMARY KEY (restaurant_id, cuisine)
);

-- Lookup index for the cuisine filter — case-insensitive so "american" and
-- "American" don't fragment the dropdown.
CREATE INDEX IF NOT EXISTS idx_restaurant_cuisines_cuisine
  ON restaurant_cuisines(cuisine COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_restaurant_cuisines_restaurant
  ON restaurant_cuisines(restaurant_id);
