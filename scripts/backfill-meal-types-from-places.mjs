#!/usr/bin/env node
// Auto-derive meal types from Google Places `regularOpeningHours`. Reads every
// restaurant that has a place_id, fetches its hours, applies time-window
// heuristics, and writes INSERT OR IGNORE statements to a SQL file.
//
// "OR IGNORE" so the script is idempotent: re-runs never delete rows that
// were curated manually in the admin form or added by the from-reviews
// backfill — only fills in genuinely missing ones.
//
// Heuristics (Sydney times):
//   - breakfast: open before 10:00 on a weekday (Mon–Fri)
//   - brunch:    open before 10:30 on a weekend (Sat or Sun)
//   - lunch:     open during [12:00, 14:00) any day
//   - dinner:    open during [18:00, 21:00) any day
//   - dessert / snack / drinks: not auto-derived (hours don't tell you that)
//
// Usage:
//   node scripts/backfill-meal-types-from-places.mjs
//   wrangler d1 execute lucaseats-db --remote --file=scripts/backfill-meal-types-from-places.sql

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const apiKey = readFileSync('.dev.vars', 'utf8').match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim();
if (!apiKey) {
  console.error('No GOOGLE_MAPS_API_KEY in .dev.vars');
  process.exit(1);
}

const SQL_SELECT = `SELECT id, name, place_id
                    FROM restaurants
                    WHERE place_id IS NOT NULL AND place_id <> ''
                    ORDER BY id`;

console.log('Fetching restaurants with place_id from remote...');
const out = execSync(
  `npx wrangler d1 execute lucaseats-db --remote --json --command "${SQL_SELECT.replace(/\s+/g, ' ').trim()}"`,
  { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }
);
const rows = JSON.parse(out)[0].results;
console.log(`Found ${rows.length} restaurant(s) with place_id`);

const FIELD_MASK = 'regularOpeningHours';

async function fetchHours(placeId) {
  const resp = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
    {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
        Referer: 'https://lucaseatsbig.com',
      },
    }
  );
  if (!resp.ok) {
    throw new Error(`Details ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  return await resp.json();
}

// Day-of-week numbering matches Places API: 0 = Sunday, 1 = Monday, ..., 6 = Saturday.
const WEEKDAYS = new Set([1, 2, 3, 4, 5]);
const WEEKEND = new Set([0, 6]);

// Convert { hour, minute } to minutes-since-midnight. Returns null if missing.
function toMin(t) {
  if (!t || typeof t.hour !== 'number') return null;
  return t.hour * 60 + (t.minute ?? 0);
}

// Does this period cover any minute in [winStart, winEnd) on its open day?
// If close.day differs from open.day (overnight wrap) or close is missing,
// treat the period as open until 24:00 on the open day.
function coversWindow(period, winStart, winEnd) {
  const o = toMin(period.open);
  if (o == null) return false;
  const sameDay = period.close && period.close.day === period.open.day;
  const c = sameDay ? toMin(period.close) ?? 24 * 60 : 24 * 60;
  return o < winEnd && c > winStart;
}

function deriveMealTypes(periods) {
  if (!periods || periods.length === 0) return [];
  const out = new Set();
  for (const p of periods) {
    if (!p || !p.open) continue;
    const day = p.open.day;
    const o = toMin(p.open);
    if (o == null) continue;

    if (WEEKDAYS.has(day) && o < 10 * 60) out.add('breakfast');
    if (WEEKEND.has(day) && o < 10 * 60 + 30) out.add('brunch');
    if (coversWindow(p, 12 * 60, 14 * 60)) out.add('lunch');
    if (coversWindow(p, 18 * 60, 21 * 60)) out.add('dinner');
  }
  return [...out];
}

const updates = [];
let derived = 0, noHours = 0, zeroDerived = 0, failed = 0;

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const tag = `[${i + 1}/${rows.length}]`;
  try {
    const place = await fetchHours(r.place_id);
    const periods = place?.regularOpeningHours?.periods;
    if (!periods || periods.length === 0) {
      noHours++;
      console.log(`${tag} no hours      ${r.name}`);
      continue;
    }
    const meals = deriveMealTypes(periods);
    if (meals.length === 0) {
      zeroDerived++;
      console.log(`${tag} 0 derived     ${r.name}`);
      continue;
    }
    for (const m of meals) {
      updates.push(
        `INSERT OR IGNORE INTO restaurant_meal_types (restaurant_id, meal_type) VALUES (${r.id}, '${m}');`
      );
    }
    derived++;
    console.log(`${tag} ${meals.join('+').padEnd(30)} ${r.name}`);
  } catch (e) {
    failed++;
    console.error(`${tag} ERR           ${r.name}: ${e.message}`);
    if (failed >= 5) {
      console.error('\nAborting after 5 failures. Fix the API issue and rerun.');
      break;
    }
  }
  await new Promise((res) => setTimeout(res, 80));
}

writeFileSync('scripts/backfill-meal-types-from-places.sql', updates.join('\n') + '\n');
console.log(
  `\nDerived: ${derived}, no hours: ${noHours}, 0 derived: ${zeroDerived}, failed: ${failed}`
);
console.log(`Wrote ${updates.length} INSERT statements to scripts/backfill-meal-types-from-places.sql`);
console.log('\nApply with:');
console.log('  wrangler d1 execute lucaseats-db --local  --file=scripts/backfill-meal-types-from-places.sql');
console.log('  wrangler d1 execute lucaseats-db --remote --file=scripts/backfill-meal-types-from-places.sql');
