-- Many-to-many meal-type relation. Pre-0011 the only signal of "does this
-- place serve lunch" was the meal_type on individual reviews — so a CBD spot
-- reviewed only at dinner wouldn't surface for "lunch cbd" even if it serves
-- lunch every day. This table stores meal-types per restaurant (independent
-- of any review) so the meal filter and the smart-search parser can be
-- re-enabled with accurate data.
--
-- Values come from src/lib/types.ts:MealType
--   breakfast | brunch | lunch | dinner | dessert | snack | drinks
--
-- Two backfill scripts seed this:
--   scripts/backfill-meal-types-from-reviews.mjs  (one-off, from review history)
--   scripts/backfill-meal-types-from-places.mjs   (from Google Places hours)
-- Both are additive — they only INSERT OR IGNORE, never DELETE — so manual
-- edits in the admin form survive re-runs.

CREATE TABLE IF NOT EXISTS restaurant_meal_types (
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  meal_type     TEXT NOT NULL,
  PRIMARY KEY (restaurant_id, meal_type)
);

CREATE INDEX IF NOT EXISTS idx_restaurant_meal_types_meal
  ON restaurant_meal_types(meal_type);

CREATE INDEX IF NOT EXISTS idx_restaurant_meal_types_restaurant
  ON restaurant_meal_types(restaurant_id);
