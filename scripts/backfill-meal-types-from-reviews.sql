-- One-off backfill: seed restaurant_meal_types from existing review history.
-- Any restaurant with a published review at meal_type X is at minimum an
-- X-spot. INSERT OR IGNORE so re-runs are safe and any rows curated manually
-- in the admin form (or added later by the Places-hours backfill) survive.
--
-- Apply once after migration 0011:
--   npm run db:migrate:local && \
--     wrangler d1 execute lucaseats-db --local --file=scripts/backfill-meal-types-from-reviews.sql
--   npm run db:migrate:remote && \
--     wrangler d1 execute lucaseats-db --remote --file=scripts/backfill-meal-types-from-reviews.sql

INSERT OR IGNORE INTO restaurant_meal_types (restaurant_id, meal_type)
SELECT DISTINCT rv.restaurant_id, rv.meal_type
FROM reviews rv
WHERE rv.status = 'published'
  AND rv.meal_type IS NOT NULL
  AND rv.meal_type IN ('breakfast', 'brunch', 'lunch', 'dinner', 'dessert', 'snack', 'drinks');
