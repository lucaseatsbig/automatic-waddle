#!/usr/bin/env node
// Read scripts/notion-export.csv.csv and emit scripts/notion-import.sql
// Apply with:  npx wrangler d1 execute lucaseats-db --local --file=scripts/notion-import.sql
// Then:        npx wrangler d1 execute lucaseats-db --remote --file=scripts/notion-import.sql

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = join(__dirname, 'notion-export.csv.csv');
const OUT_PATH = join(__dirname, 'notion-import.sql');

// --------- CSV parser (RFC 4180-ish) ---------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { inQuotes = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// --------- Helpers ---------------------------------------------------------
const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sqOrNull = (s) => (s == null || s === '' ? 'NULL' : sq(s));
const numOrNull = (n) => (n == null || Number.isNaN(n) ? 'NULL' : String(n));

function slugify(input) {
  return (
    String(input)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'item'
  );
}

function splitMulti(cell) {
  return String(cell ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function cleanUrl(u) {
  const s = String(u ?? '').trim();
  if (!s || s.toUpperCase() === 'N/A') return null;
  return s;
}

function parsePriceTier(cell) {
  const parts = splitMulti(cell).filter((p) => /^\$+$/.test(p));
  if (parts.length === 0) return null;
  const tiers = parts.map((p) => p.length).filter((n) => n >= 1 && n <= 5);
  if (tiers.length === 0) return null;
  const avg = tiers.reduce((a, b) => a + b, 0) / tiers.length;
  return Math.round(avg);
}

const MEAL_TYPES = new Set(['breakfast', 'brunch', 'lunch', 'dinner', 'dessert', 'snack', 'drinks']);
function parseMealType(cell) {
  const first = splitMulti(cell)[0];
  if (!first) return null;
  const lower = first.toLowerCase();
  return MEAL_TYPES.has(lower) ? lower : null;
}

// Map common Notion vibes to seeded tag slugs. Anything unknown gets a new tag created.
const VIBE_MAP = {
  'date': 'date',
  'dine-in': 'dine-in',
  'takeaway': 'takeaway',
  'casual dining': 'casual',
  'upscale dining': 'upscale',
  'fine dining': 'fine-dining',
  'small groups': 'small-group',
  'larger groups': 'large-group',
  'pub': 'pub',
  'cafe': 'cafe',
  'bar': 'bar',
};
function vibeToSlug(label) {
  const key = label.trim().toLowerCase();
  return VIBE_MAP[key] ?? slugify(label);
}

function parseRating(cell) {
  const s = String(cell ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n;
}

// --------- Read + parse ----------------------------------------------------
const csv = readFileSync(CSV_PATH, 'utf8');
const rows = parseCsv(csv);
const header = rows.shift();
const idx = (name) => {
  const i = header.findIndex((h) => h.trim().toLowerCase().startsWith(name.toLowerCase()));
  if (i < 0) throw new Error(`Header not found: ${name}`);
  return i;
};

const COL = {
  name: idx('Name'),
  cuisine: idx('Cuisine'),
  ig: idx('Link to Instagram'),
  web: idx('Link to Website'),
  loc: idx('Location'),
  meal: idx('Meal Type'),
  overall: idx('Overall Rating'),
  price: idx('Price'),
  size: idx('Size Rating'),
  standout: idx('Standout'),
  vibes: idx('Vibes'),
  visited: idx('Visited'),
};

const usedSlugs = new Set();
function uniqueSlug(base) {
  let candidate = slugify(base);
  let n = 1;
  while (usedSlugs.has(candidate)) {
    n += 1;
    candidate = `${slugify(base)}-${n}`;
  }
  usedSlugs.add(candidate);
  return candidate;
}

const locationsSeen = new Set(); // slug → name
const locationsMap = new Map();
const vibesSeen = new Map(); // slug → label

const restaurants = []; // { slug, name, cuisine, location_slug, address, price_tier, website_url, wishlist_note, vibe_slugs }
const reviews = [];     // { restaurant_slug, slug, meal_type, rating_overall, rating_size, instagram_url, standouts }

for (const cells of rows) {
  if (!cells || cells.length === 0) continue;
  const name = (cells[COL.name] ?? '').trim();
  if (!name) continue;

  const visited = (cells[COL.visited] ?? '').trim().toLowerCase() === 'yes';
  const cuisine = (cells[COL.cuisine] ?? '').trim() || null;
  const igRaw = cleanUrl(cells[COL.ig]);
  const webRaw = cleanUrl(cells[COL.web]);
  const priceTier = parsePriceTier(cells[COL.price]);
  const mealType = parseMealType(cells[COL.meal]);
  const overall = parseRating(cells[COL.overall]);
  const sizeRating = parseRating(cells[COL.size]);
  const standoutCell = cells[COL.standout] ?? '';
  const standouts = splitMulti(standoutCell).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

  // Locations: take all comma-separated, but only the first one becomes the FK.
  const locationLabels = splitMulti(cells[COL.loc]);
  const primaryLocation = locationLabels[0] ?? null;
  const extraLocations = locationLabels.slice(1);
  let locSlug = null;
  if (primaryLocation) {
    locSlug = slugify(primaryLocation);
    if (!locationsMap.has(locSlug)) locationsMap.set(locSlug, primaryLocation);
  }

  // Vibes
  const vibeLabels = splitMulti(cells[COL.vibes]);
  const vibeSlugs = vibeLabels.map((v) => {
    const slug = vibeToSlug(v);
    if (!vibesSeen.has(slug)) vibesSeen.set(slug, v.trim());
    return slug;
  });

  const restaurantSlug = uniqueSlug(name);

  // For chains with several listed locations, stash the rest into address as a plain note.
  const addressNote = extraLocations.length > 0 ? `Also at: ${extraLocations.join(', ')}` : null;

  restaurants.push({
    slug: restaurantSlug,
    name,
    cuisine,
    location_slug: locSlug,
    address: addressNote,
    price_tier: priceTier,
    website_url: webRaw,
    wishlist_note: null,
    vibe_slugs: vibeSlugs,
  });

  // Only emit a review if visited AND we have a rating (rating_overall is NOT NULL).
  if (visited && overall != null) {
    reviews.push({
      restaurant_slug: restaurantSlug,
      slug: uniqueSlug(`${restaurantSlug}-undated`),
      meal_type: mealType,
      rating_overall: overall,
      rating_size: sizeRating,
      instagram_url: igRaw,
      standouts,
    });
  }
}

// --------- Emit SQL --------------------------------------------------------
const out = [];
out.push('-- Auto-generated from Notion export. Re-run scripts/import-notion.mjs to regenerate.');
out.push('-- Apply with: npx wrangler d1 execute lucaseats-db --local --file=scripts/notion-import.sql');
out.push('');

out.push('-- Locations -------------------------------------------------------');
for (const [slug, name] of locationsMap) {
  out.push(`INSERT OR IGNORE INTO locations (slug, name) VALUES (${sq(slug)}, ${sq(name)});`);
}
out.push('');

out.push('-- Vibe tags (creates any new ones not in the seed) ---------------');
for (const [slug, label] of vibesSeen) {
  out.push(
    `INSERT OR IGNORE INTO tags (slug, label, category) VALUES (${sq(slug)}, ${sq(label)}, 'vibe');`
  );
}
out.push('');

out.push('-- Restaurants ----------------------------------------------------');
for (const r of restaurants) {
  const locExpr = r.location_slug ? `(SELECT id FROM locations WHERE slug = ${sq(r.location_slug)})` : 'NULL';
  out.push(
    `INSERT INTO restaurants (slug, name, cuisine, location_id, address, price_tier, website_url, wishlist_note) ` +
      `VALUES (${sq(r.slug)}, ${sq(r.name)}, ${sqOrNull(r.cuisine)}, ${locExpr}, ${sqOrNull(r.address)}, ` +
      `${numOrNull(r.price_tier)}, ${sqOrNull(r.website_url)}, ${sqOrNull(r.wishlist_note)});`
  );
}
out.push('');

out.push('-- Restaurant ↔ tag links ----------------------------------------');
for (const r of restaurants) {
  for (const slug of r.vibe_slugs) {
    out.push(
      `INSERT OR IGNORE INTO restaurant_tags (restaurant_id, tag_id) VALUES ` +
        `((SELECT id FROM restaurants WHERE slug = ${sq(r.slug)}), (SELECT id FROM tags WHERE slug = ${sq(slug)}));`
    );
  }
}
out.push('');

out.push('-- Reviews + standout items --------------------------------------');
for (const rv of reviews) {
  out.push(
    `INSERT INTO reviews (restaurant_id, slug, visit_date, meal_type, rating_overall, rating_size, would_return, instagram_url, status) VALUES ` +
      `((SELECT id FROM restaurants WHERE slug = ${sq(rv.restaurant_slug)}), ${sq(rv.slug)}, NULL, ` +
      `${sqOrNull(rv.meal_type)}, ${numOrNull(rv.rating_overall)}, ${numOrNull(rv.rating_size)}, 1, ` +
      `${sqOrNull(rv.instagram_url)}, 'published');`
  );
  for (let i = 0; i < rv.standouts.length; i++) {
    const item = rv.standouts[i];
    out.push(
      `INSERT INTO standout_items (review_id, name, note, is_standout, sort_order) VALUES ` +
        `((SELECT id FROM reviews WHERE slug = ${sq(rv.slug)}), ${sq(item)}, NULL, 0, ${i});`
    );
  }
}
out.push('');

writeFileSync(OUT_PATH, out.join('\n'));

const skippedVisited = rows.filter((c) => {
  if (!c[COL.name]?.trim()) return false;
  const visited = (c[COL.visited] ?? '').trim().toLowerCase() === 'yes';
  const overall = parseRating(c[COL.overall]);
  return visited && overall == null;
}).length;

console.log(`Wrote ${OUT_PATH}`);
console.log(`  ${restaurants.length} restaurants`);
console.log(`  ${reviews.length} reviews`);
console.log(`  ${locationsMap.size} unique locations`);
console.log(`  ${vibesSeen.size} unique vibe tags (new ones get created on apply)`);
if (skippedVisited > 0) {
  console.log(`  ${skippedVisited} visited rows skipped (no Overall Rating) — restaurants imported without reviews`);
}
