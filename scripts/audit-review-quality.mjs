#!/usr/bin/env node
// Audit how bot-ready each restaurant's review data is.
//
// No API calls, no writes — just reads remote D1 and prints a report. Run this
// before turning the SEO guide bot loose so you know which restaurants will
// produce thin paragraphs (because there's not enough commentary or standout
// dishes for Claude to write 2-3 grounded paragraphs without inventing).
//
// Usage:
//   node scripts/audit-review-quality.mjs                 # full report
//   node scripts/audit-review-quality.mjs --thin          # only show thin/missing
//   node scripts/audit-review-quality.mjs --by-cuisine    # group eligibility by cuisine
//   node scripts/audit-review-quality.mjs --by-suburb     # group eligibility by suburb
//   node scripts/audit-review-quality.mjs --by-tag        # group eligibility by tag (themed)
//   node scripts/audit-review-quality.mjs --by-meal       # group eligibility by meal_type
//   node scripts/audit-review-quality.mjs --csv > out.csv # machine-readable
//
// Thresholds (per restaurant, across all published reviews):
//   commentary words >= 60   AND   standout dishes >= 2   →  green  (bot-ready)
//   commentary words >= 30   OR    standout dishes >= 1   →  yellow (thin — usable but borderline)
//   below both                                              →  red    (skip — needs more notes)

import { queryRemote } from './lib/wrangler.mjs';

const GREEN_MIN_WORDS = 60;
const GREEN_MIN_STANDOUTS = 2;
const YELLOW_MIN_WORDS = 30;
const YELLOW_MIN_STANDOUTS = 1;

const args = process.argv.slice(2);
const flags = {
  thinOnly: args.includes('--thin'),
  byCuisine: args.includes('--by-cuisine'),
  bySuburb: args.includes('--by-suburb'),
  byTag: args.includes('--by-tag'),
  byMeal: args.includes('--by-meal'),
  csv: args.includes('--csv'),
};

if (!flags.csv) console.log('Fetching restaurant + review data from remote...\n');

const rows = queryRemote(`
  WITH pub AS (
    SELECT rv.restaurant_id,
           COUNT(*) AS visit_count,
           AVG(rv.rating_overall) AS avg_overall,
           SUM(LENGTH(COALESCE(rv.commentary, ''))) AS commentary_chars,
           SUM(
             (LENGTH(COALESCE(rv.commentary, '')) -
              LENGTH(REPLACE(COALESCE(rv.commentary, ''), ' ', ''))) + 1
           ) AS commentary_word_estimate
      FROM reviews rv
     WHERE rv.status = 'published'
     GROUP BY rv.restaurant_id
  ),
  standouts AS (
    SELECT rv.restaurant_id, COUNT(*) AS standout_count
      FROM standout_items si
      JOIN reviews rv ON rv.id = si.review_id
     WHERE rv.status = 'published' AND si.is_standout = 1
     GROUP BY rv.restaurant_id
  ),
  meals AS (
    SELECT rv.restaurant_id,
           GROUP_CONCAT(DISTINCT rv.meal_type) AS meals_blob
      FROM reviews rv
     WHERE rv.status = 'published' AND rv.meal_type IS NOT NULL
     GROUP BY rv.restaurant_id
  ),
  tagblobs AS (
    SELECT rt.restaurant_id, GROUP_CONCAT(t.slug) AS tag_slugs
      FROM restaurant_tags rt
      JOIN tags t ON t.id = rt.tag_id
     GROUP BY rt.restaurant_id
  )
  SELECT res.id, res.slug, res.name, res.cuisine,
         loc.name AS suburb,
         pub.visit_count, pub.avg_overall,
         pub.commentary_chars, pub.commentary_word_estimate,
         COALESCE(standouts.standout_count, 0) AS standout_count,
         meals.meals_blob,
         tagblobs.tag_slugs
    FROM restaurants res
    JOIN pub ON pub.restaurant_id = res.id
    LEFT JOIN locations loc ON loc.id = res.location_id
    LEFT JOIN standouts ON standouts.restaurant_id = res.id
    LEFT JOIN meals     ON meals.restaurant_id     = res.id
    LEFT JOIN tagblobs  ON tagblobs.restaurant_id  = res.id
   ORDER BY pub.avg_overall DESC, res.name ASC
`);

function classify(row) {
  const words = row.commentary_word_estimate ?? 0;
  const standouts = row.standout_count ?? 0;
  if (words >= GREEN_MIN_WORDS && standouts >= GREEN_MIN_STANDOUTS) return 'green';
  if (words >= YELLOW_MIN_WORDS || standouts >= YELLOW_MIN_STANDOUTS) return 'yellow';
  return 'red';
}

const classified = rows.map((r) => ({
  ...r,
  status: classify(r),
  meals: (r.meals_blob ?? '').split(',').filter(Boolean),
  tags: (r.tag_slugs ?? '').split(',').filter(Boolean),
}));

// --- CSV mode -------------------------------------------------------------

if (flags.csv) {
  console.log('id,slug,name,cuisine,suburb,visits,avg_rating,commentary_words,standouts,meals,tags,status');
  for (const r of classified) {
    const fields = [
      r.id, r.slug, r.name, r.cuisine ?? '', r.suburb ?? '',
      r.visit_count, r.avg_overall != null ? Number(r.avg_overall).toFixed(1) : '',
      r.commentary_word_estimate ?? 0, r.standout_count ?? 0,
      r.meals.join('|'), r.tags.join('|'), r.status,
    ];
    console.log(fields.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
  }
  process.exit(0);
}

// --- Counts ---------------------------------------------------------------

const total = classified.length;
const green = classified.filter((r) => r.status === 'green').length;
const yellow = classified.filter((r) => r.status === 'yellow').length;
const red = classified.filter((r) => r.status === 'red').length;

const ICON = { green: '🟢', yellow: '🟡', red: '🔴' };

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n - 1) + '…' : s + ' '.repeat(n - s.length);
}

const visible = flags.thinOnly ? classified.filter((r) => r.status !== 'green') : classified;

console.log(pad('Status', 8) + pad('Name', 36) + pad('Cuisine', 18) + pad('Suburb', 18) + pad('Words', 8) + pad('Dishes', 8) + 'Avg');
console.log('-'.repeat(96));
for (const r of visible) {
  console.log(
    pad(`${ICON[r.status]} ${r.status}`, 8) +
    pad(r.name, 36) +
    pad(r.cuisine ?? '—', 18) +
    pad(r.suburb ?? '—', 18) +
    pad(r.commentary_word_estimate ?? 0, 8) +
    pad(r.standout_count ?? 0, 8) +
    (r.avg_overall != null ? Number(r.avg_overall).toFixed(1) : '—')
  );
}

// --- Group breakdowns -----------------------------------------------------

function groupBy(label, getKeys) {
  const groups = new Map();
  for (const r of classified) {
    for (const k of getKeys(r) ?? []) {
      if (!k) continue;
      if (!groups.has(k)) groups.set(k, { green: 0, yellow: 0, red: 0, total: 0 });
      const g = groups.get(k);
      g[r.status]++;
      g.total++;
    }
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].green - a[1].green || b[1].total - a[1].total);

  console.log(`\n--- Bot-readiness by ${label} ---`);
  console.log(pad(label, 24) + pad('Green', 8) + pad('Yellow', 8) + pad('Red', 8) + pad('Total', 8) + 'Eligible for guide?');
  console.log('-'.repeat(80));
  for (const [k, g] of sorted) {
    const eligible = g.green >= 3
      ? `✓ yes (${g.green} green)`
      : g.green + g.yellow >= 3
        ? `~ borderline (${g.green}g + ${g.yellow}y)`
        : `✗ no — need ${3 - g.green - g.yellow} more bot-ready`;
    console.log(pad(k, 24) + pad(g.green, 8) + pad(g.yellow, 8) + pad(g.red, 8) + pad(g.total, 8) + eligible);
  }
}

if (flags.byCuisine) groupBy('Cuisine', (r) => [r.cuisine ?? '(none)']);
if (flags.bySuburb) groupBy('Suburb', (r) => [r.suburb ?? '(none)']);
if (flags.byMeal) groupBy('Meal type', (r) => r.meals.length ? r.meals : ['(none)']);
if (flags.byTag) groupBy('Tag (themed)', (r) => r.tags.length ? r.tags : ['(none)']);

// --- Summary --------------------------------------------------------------

console.log('\n--- Summary ---');
console.log(`Total restaurants with published reviews: ${total}`);
console.log(`🟢 Bot-ready (green):  ${green}  (≥${GREEN_MIN_WORDS} words and ≥${GREEN_MIN_STANDOUTS} standouts)`);
console.log(`🟡 Thin (yellow):      ${yellow}  (some data, but the bot will struggle)`);
console.log(`🔴 Not usable (red):   ${red}  (needs more commentary / standouts)`);

if (red > 0 || yellow > 0) {
  console.log(`\nNext: top up commentary or mark standouts in /admin/entry/... for the yellow/red rows.`);
  console.log(`Re-run this audit until enough cuisines/suburbs/tags have ≥3 green restaurants to support a guide.`);
}
