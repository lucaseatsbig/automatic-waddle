-- Remove the "Open Late" tag (slug 'late-night', category 'other') entirely.
--
-- Unlike the tags dropped in 0013, this one WAS in use: 30 restaurants carried
-- it at the time of removal. It was never reachable as a filter, though — only
-- category='vibe' tags become filter options (see MobileFilterSheet.astro), so
-- 'other' tags render as card chips and nothing more. Lucas decided the tag
-- wasn't worth keeping rather than promoting it to a vibe.
--
-- The 30 slugs are recorded below so the tagging can be reconstructed without
-- trawling git history for a database dump. To restore: re-insert the tag, then
-- INSERT INTO restaurant_tags SELECT res.id, <tag_id> FROM restaurants res
-- WHERE res.slug IN (<list>).
--
--   40res, anason, bibo-wine-bar, bouillon-l-entrecote, callao,
--   chester-white-cured-diner, cucina-porto, dear-sainte-eloise, ennui,
--   esteban, fred-s, gelato-messina-randwick, hustlers-syd, kabul-house,
--   lana, mapo-newtown, margaret, matteo-downtown, maydanoz-restaurant-bar,
--   midden-by-mark-olive, new-york-burgers-mac-pty-ltd, oborozuki,
--   olympus-dining, ouzo-bar-dining, prefecture-48,
--   saray-turkish-pizza-and-kebabs-newtown, scala-lane, shaffa,
--   the-captains-balcony-crows-nest, the-white-horse

DELETE FROM restaurant_tags
 WHERE tag_id IN (SELECT id FROM tags WHERE slug = 'late-night');

DELETE FROM tags WHERE slug = 'late-night';
