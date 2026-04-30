import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const apiKey = readFileSync('.dev.vars', 'utf8').match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim();
if (!apiKey) {
  console.error('No GOOGLE_MAPS_API_KEY in .dev.vars');
  process.exit(1);
}

console.log('Fetching restaurants without place_id from remote...');
const out = execSync(
  `npx wrangler d1 execute lucaseats-db --remote --json --command "SELECT res.id, res.name, loc.name AS suburb FROM restaurants res LEFT JOIN locations loc ON loc.id = res.location_id WHERE res.place_id IS NULL ORDER BY res.id"`,
  { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }
);
const data = JSON.parse(out);
const rows = data[0].results;
console.log(`Found ${rows.length} to backfill`);

const updates = [];
let matched = 0, skipped = 0, failed = 0;

let i = 0;
for (const r of rows) {
  i++;
  const q = `${r.name}${r.suburb ? ' ' + r.suburb : ''} Sydney`;
  try {
    const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName',
        'Content-Type': 'application/json',
        Referer: 'https://lucaseatsbig.com',
      },
      body: JSON.stringify({ textQuery: q, regionCode: 'AU' }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.error(`[${i}/${rows.length} FAIL ${resp.status}] ${r.name}: ${body}`);
      failed++;
      if (failed >= 3) {
        console.error('\nAborting after 3 failures. Fix the API issue and rerun.');
        process.exit(1);
      }
      continue;
    }
    const j = await resp.json();
    const place = j.places?.[0];
    if (place?.id) {
      const escapedId = place.id.replace(/'/g, "''");
      updates.push(`UPDATE restaurants SET place_id='${escapedId}' WHERE id=${r.id};`);
      matched++;
      console.log(`[${i}/${rows.length} OK] ${r.name} → ${place.displayName?.text ?? place.id}`);
    } else {
      skipped++;
      console.log(`[${i}/${rows.length} NO RESULT] ${r.name} (query: "${q}")`);
    }
  } catch (e) {
    console.error(`[${i}/${rows.length} ERR] ${r.name}: ${e.message}`);
    failed++;
  }
  await new Promise((r) => setTimeout(r, 80));
}

writeFileSync('scripts/backfill-places.sql', updates.join('\n') + '\n');
console.log(`\nMatched: ${matched}, no result: ${skipped}, failed: ${failed}`);
console.log(`Wrote ${updates.length} updates to scripts/backfill-places.sql`);
