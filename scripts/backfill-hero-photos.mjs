import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const apiKey = readFileSync('.dev.vars', 'utf8').match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim();
if (!apiKey) {
  console.error('No GOOGLE_MAPS_API_KEY in .dev.vars');
  process.exit(1);
}

console.log('Fetching restaurants with place_id but no hero_photo_name...');
const out = execSync(
  `npx wrangler d1 execute lucaseats-db --remote --json --command "SELECT id, name, place_id FROM restaurants WHERE place_id IS NOT NULL AND hero_photo_name IS NULL ORDER BY id"`,
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
  try {
    const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(r.place_id)}`;
    const resp = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'photos',
        Referer: 'https://lucaseatsbig.com',
      },
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.error(`[${i}/${rows.length} FAIL ${resp.status}] ${r.name}: ${body}`);
      failed++;
      if (failed >= 3) {
        console.error('\nAborting after 3 failures.');
        process.exit(1);
      }
      continue;
    }
    const j = await resp.json();
    const photoName = j.photos?.[0]?.name;
    if (photoName) {
      const escaped = photoName.replace(/'/g, "''");
      updates.push(`UPDATE restaurants SET hero_photo_name='${escaped}' WHERE id=${r.id};`);
      matched++;
      console.log(`[${i}/${rows.length} OK] ${r.name}`);
    } else {
      skipped++;
      console.log(`[${i}/${rows.length} NO PHOTO] ${r.name}`);
    }
  } catch (e) {
    console.error(`[${i}/${rows.length} ERR] ${r.name}: ${e.message}`);
    failed++;
  }
  await new Promise((r) => setTimeout(r, 80));
}

writeFileSync('scripts/backfill-hero-photos.sql', updates.join('\n') + '\n');
console.log(`\nMatched: ${matched}, no photo: ${skipped}, failed: ${failed}`);
console.log(`Wrote ${updates.length} updates to scripts/backfill-hero-photos.sql`);
