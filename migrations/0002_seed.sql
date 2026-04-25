-- Lucas Eats Big — seed data (Sydney locations, starter tags, a few demo restaurants).
-- The demo restaurants are just so the dev page isn't empty — delete them once you
-- start adding real entries through the admin UI.

INSERT INTO locations (slug, name) VALUES
  ('cbd', 'Sydney CBD'),
  ('surry-hills', 'Surry Hills'),
  ('newtown', 'Newtown'),
  ('darlinghurst', 'Darlinghurst'),
  ('chippendale', 'Chippendale'),
  ('redfern', 'Redfern'),
  ('paddington', 'Paddington'),
  ('bondi', 'Bondi'),
  ('potts-point', 'Potts Point'),
  ('kings-cross', 'Kings Cross'),
  ('glebe', 'Glebe'),
  ('marrickville', 'Marrickville'),
  ('enmore', 'Enmore'),
  ('chinatown', 'Chinatown'),
  ('barangaroo', 'Barangaroo'),
  ('pyrmont', 'Pyrmont'),
  ('alexandria', 'Alexandria'),
  ('rosebery', 'Rosebery');

INSERT INTO tags (slug, label, category) VALUES
  ('date',        'Date spot',          'vibe'),
  ('upscale',     'Upscale',            'vibe'),
  ('large-group', 'Large group',        'vibe'),
  ('small-group', 'Small group',        'vibe'),
  ('loud',        'Loud',               'vibe'),
  ('quiet',       'Quiet',              'vibe'),
  ('music',       'Live music',         'vibe'),
  ('dine-in',     'Dine-in',            'vibe'),
  ('takeaway',    'Takeaway',           'vibe'),
  ('casual',      'Casual',             'vibe'),
  ('cozy',        'Cozy',               'vibe'),
  ('outdoor',     'Outdoor seating',    'vibe'),
  ('vegetarian',  'Vegetarian options', 'dietary'),
  ('vegan',       'Vegan options',      'dietary'),
  ('gluten-free', 'Gluten-free',        'dietary'),
  ('halal',       'Halal',              'dietary'),
  ('kosher',      'Kosher',             'dietary'),
  ('nut-free',    'Nut-free',           'dietary'),
  ('bookings',    'Takes bookings',     'other'),
  ('walk-in',     'Walk-in only',       'other'),
  ('late-night',  'Open late',          'other');

-- Demo restaurants (2 visited, 1 wishlist). Delete these once you have real data.
INSERT INTO restaurants (slug, name, cuisine, location_id, address, price_tier, website_url, menu_url, wishlist_note) VALUES
  ('chaco-bar',   'Chaco Bar',         'Japanese',          (SELECT id FROM locations WHERE slug='darlinghurst'), '238 Crown St, Darlinghurst',                       3, 'https://www.chacobar.com.au',    'https://www.chacobar.com.au/menu', NULL),
  ('ester',       'Ester',             'Modern Australian', (SELECT id FROM locations WHERE slug='chippendale'),  '46-52 Meagher St, Chippendale',                    4, 'https://ester-restaurant.com.au', NULL,                                NULL),
  ('saint-peter', 'Saint Peter',       'Seafood',           (SELECT id FROM locations WHERE slug='paddington'),   'The Grand National, 161 Underwood St, Paddington', 5, 'https://saintpeter.com.au',      NULL,                                'Heard the whole-fish butchery is a religious experience. Want to try the omakase bar.');

INSERT INTO restaurant_tags (restaurant_id, tag_id) VALUES
  ((SELECT id FROM restaurants WHERE slug='chaco-bar'),   (SELECT id FROM tags WHERE slug='small-group')),
  ((SELECT id FROM restaurants WHERE slug='chaco-bar'),   (SELECT id FROM tags WHERE slug='casual')),
  ((SELECT id FROM restaurants WHERE slug='chaco-bar'),   (SELECT id FROM tags WHERE slug='date')),
  ((SELECT id FROM restaurants WHERE slug='ester'),       (SELECT id FROM tags WHERE slug='upscale')),
  ((SELECT id FROM restaurants WHERE slug='ester'),       (SELECT id FROM tags WHERE slug='date')),
  ((SELECT id FROM restaurants WHERE slug='ester'),       (SELECT id FROM tags WHERE slug='bookings')),
  ((SELECT id FROM restaurants WHERE slug='saint-peter'), (SELECT id FROM tags WHERE slug='upscale')),
  ((SELECT id FROM restaurants WHERE slug='saint-peter'), (SELECT id FROM tags WHERE slug='date'));

INSERT INTO reviews (restaurant_id, slug, visit_date, meal_type, rating_overall, rating_food, rating_vibe, rating_service, rating_value, rating_size, commentary, would_return, status) VALUES
  ((SELECT id FROM restaurants WHERE slug='chaco-bar'), 'chaco-bar-2026-02-14', '2026-02-14', 'dinner', 9.0,  9.5,  8.5, 8.0, 8.0, 7.0, 'Yakitori was immaculate. The chicken oyster skewer alone is worth the trip. Small, buzzy, no reservations.', 1, 'published'),
  ((SELECT id FROM restaurants WHERE slug='ester'),     'ester-2026-01-22',     '2026-01-22', 'dinner', 9.5, 10.0, 9.0, 9.5, 7.5, 8.0, 'Wood-fired everything. The blood sausage sanga was a revelation. Service flawless.',                            1, 'published');

INSERT INTO standout_items (review_id, name, note, is_standout, sort_order) VALUES
  ((SELECT id FROM reviews WHERE slug='chaco-bar-2026-02-14'), 'Chicken oyster skewer',  'Get two.',      1, 0),
  ((SELECT id FROM reviews WHERE slug='chaco-bar-2026-02-14'), 'Chicken rice',           NULL,            1, 1),
  ((SELECT id FROM reviews WHERE slug='ester-2026-01-22'),     'Blood sausage sanga',    'Menu legend.',  1, 0),
  ((SELECT id FROM reviews WHERE slug='ester-2026-01-22'),     'Wood-fired flatbread',   NULL,            1, 1);
