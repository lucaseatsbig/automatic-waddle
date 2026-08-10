-- Remove three dietary tags that were seeded in 0002 but never used:
-- Vegan options, Kosher, Nut-free. All three had zero restaurants behind them,
-- so nothing is lost — they only added noise to the admin tag picker.
--
-- The filter UI already hid them from visitors (empty options are suppressed);
-- this removes them from the admin entry form too, which lists every tag.
--
-- Deliberately NOT touched:
--   - 'vegetarian' (now "Great for vegetarians", 25 places) and 'halal' (7).
--   - The 'Vegan'/'Vegetarian' entries in cuisine_suggestions (migration 0003)
--     — those are cuisine options, a separate field from dietary tags.
--   - The vegan/vegetarian synonym group in src/lib/search-terms.ts, so a
--     search for "vegan" still finds vegetarian-friendly places by tag label.

-- Defensive: no rows exist today, but a tag acquired between writing and
-- applying this would otherwise leave an orphaned restaurant_tags row.
DELETE FROM restaurant_tags
 WHERE tag_id IN (SELECT id FROM tags WHERE slug IN ('vegan', 'kosher', 'nut-free'));

DELETE FROM tags WHERE slug IN ('vegan', 'kosher', 'nut-free');
