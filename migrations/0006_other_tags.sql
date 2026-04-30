-- Relabel existing 'other' tags and add "Good for Large Groups".
-- Slugs are kept stable so existing restaurant_tags rows keep working.
UPDATE tags SET label = 'Takes Bookings' WHERE slug = 'bookings';
UPDATE tags SET label = 'Walk-In'        WHERE slug = 'walk-in';
UPDATE tags SET label = 'Open Late'      WHERE slug = 'late-night';

INSERT OR IGNORE INTO tags (slug, label, category)
VALUES ('good-for-large-groups', 'Good for Large Groups', 'other');

-- Merge the legacy vibe tag 'large-group' into the new 'good-for-large-groups',
-- preserving the ~33 existing associations. OR IGNORE handles any (unlikely)
-- pre-existing duplicate (restaurant_id, new_tag_id) row.
UPDATE OR IGNORE restaurant_tags
   SET tag_id = (SELECT id FROM tags WHERE slug = 'good-for-large-groups')
 WHERE tag_id = (SELECT id FROM tags WHERE slug = 'large-group');

-- Drop the old 'large-group' vibe tag (associations are already moved above,
-- so the cascade is a no-op).
DELETE FROM tags WHERE slug = 'large-group';

-- Drop 'small-group' entirely — small-group fit is the default assumption,
-- so the tag was noise. ON DELETE CASCADE strips the ~117 join rows.
DELETE FROM tags WHERE slug = 'small-group';
