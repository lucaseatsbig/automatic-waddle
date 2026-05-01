// Backfills website_url, maps_url, lat, lng, address (and place_id when missing)
// for any restaurant that's missing one or more of those fields.
//
// - If a row already has place_id, we fetch its details directly (1 API call).
// - If place_id is missing, we run text search first to find it, then read the
//   same fields from the search response.
//
// Only fills in fields that are currently NULL/empty — it never overwrites
// data you've manually curated.
//
// Output is written to scripts/backfill-place-details.sql. Apply with:
//   wrangler d1 execute lucaseats-db --remote --file=scripts/backfill-place-details.sql

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const apiKey = readFileSync('.dev.vars', 'utf8').match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim();
if (!apiKey) {
  console.error('No GOOGLE_MAPS_API_KEY in .dev.vars');
  process.exit(1);
}

const SQL_SELECT = `SELECT res.id, res.name, res.place_id, res.website_url, res.maps_url, res.lat, res.lng, res.address, loc.name AS suburb
                    FROM restaurants res
                    LEFT JOIN locations loc ON loc.id = res.location_id
                    WHERE res.place_id IS NULL
                       OR res.website_url IS NULL OR res.website_url = ''
                       OR res.maps_url IS NULL    OR res.maps_url    = ''
                       OR res.lat IS NULL OR res.lng IS NULL
                       OR res.address IS NULL     OR res.address     = ''
                    ORDER BY res.id`;

console.log('Fetching restaurants missing place details from remote...');
const out = execSync(
  `npx wrangler d1 execute lucaseats-db --remote --json --command "${SQL_SELECT.replace(/\s+/g, ' ').trim()}"`,
  { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }
);
const data = JSON.parse(out);
const rows = data[0].results;
console.log(`Found ${rows.length} restaurant(s) needing one or more fields filled in`);

const FIELD_MASK_DETAILS = 'id,displayName,formattedAddress,websiteUri,googleMapsUri,location';
const FIELD_MASK_SEARCH  = 'places.id,places.displayName,places.formattedAddress,places.websiteUri,places.googleMapsUri,places.location';

function escSql(v) {
  if (v == null) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function fetchDetails(placeId) {
  const resp = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK_DETAILS,
      Referer: 'https://lucaseatsbig.com',
    },
  });
  if (!resp.ok) throw new Error(`Details ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return await resp.json();
}

async function searchPlace(name, suburb) {
  const q = `${name}${suburb ? ' ' + suburb : ''} Sydney`;
  const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK_SEARCH,
      'Content-Type': 'application/json',
      Referer: 'https://lucaseatsbig.com',
    },
    body: JSON.stringify({ textQuery: q, regionCode: 'AU' }),
  });
  if (!resp.ok) throw new Error(`Search ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const j = await resp.json();
  return j.places?.[0] ?? null;
}

const updates = [];
let filled = 0, alreadyComplete = 0, noResult = 0, failed = 0;

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const tag = `[${i + 1}/${rows.length}]`;
  try {
    const place = r.place_id
      ? await fetchDetails(r.place_id)
      : await searchPlace(r.name, r.suburb);

    if (!place || !place.id) {
      noResult++;
      console.log(`${tag} NO RESULT  ${r.name}`);
      continue;
    }

    const sets = [];
    if (!r.place_id && place.id) sets.push(`place_id=${escSql(place.id)}`);
    if ((!r.website_url || r.website_url === '') && place.websiteUri) {
      sets.push(`website_url=${escSql(place.websiteUri)}`);
    }
    if (!r.maps_url || r.maps_url === '') {
      const mapsUrl = place.googleMapsUri ?? `https://www.google.com/maps/place/?q=place_id:${place.id}`;
      sets.push(`maps_url=${escSql(mapsUrl)}`);
    }
    if (r.lat == null && place.location?.latitude != null) sets.push(`lat=${place.location.latitude}`);
    if (r.lng == null && place.location?.longitude != null) sets.push(`lng=${place.location.longitude}`);
    if ((!r.address || r.address === '') && place.formattedAddress) {
      sets.push(`address=${escSql(place.formattedAddress)}`);
    }

    if (sets.length === 0) {
      alreadyComplete++;
      console.log(`${tag} OK already  ${r.name}`);
      continue;
    }

    updates.push(`UPDATE restaurants SET ${sets.join(', ')} WHERE id=${r.id};`);
    filled++;
    console.log(`${tag} FILL ${sets.length}     ${r.name}`);
  } catch (e) {
    failed++;
    console.error(`${tag} ERR        ${r.name}: ${e.message}`);
    if (failed >= 5) {
      console.error('\nAborting after 5 failures. Fix the API issue and rerun.');
      break;
    }
  }
  await new Promise((res) => setTimeout(res, 80));
}

writeFileSync('scripts/backfill-place-details.sql', updates.join('\n') + '\n');
console.log(`\nFilled: ${filled}, already complete: ${alreadyComplete}, no result: ${noResult}, failed: ${failed}`);
console.log(`Wrote ${updates.length} updates to scripts/backfill-place-details.sql`);
console.log(`\nApply with: wrangler d1 execute lucaseats-db --remote --file=scripts/backfill-place-details.sql`);
