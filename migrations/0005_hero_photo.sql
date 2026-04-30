-- Cache the first Google Places photo resource name per restaurant so
-- card grids can render a hero photo without a per-render Places API call.
ALTER TABLE restaurants ADD COLUMN hero_photo_name TEXT;
