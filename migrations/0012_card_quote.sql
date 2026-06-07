-- A short first-person "verdict" shown on visited restaurant cards — the
-- counterpart to restaurants.wishlist_note (which only shows before a place
-- has any review). card_quote lets a reader get the vibe of the score at a
-- glance without opening the full review. One per restaurant, set/updated
-- whenever a visit is logged or from the restaurant edit form.
ALTER TABLE restaurants ADD COLUMN card_quote TEXT;
