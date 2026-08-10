#!/usr/bin/env node
/**
 * Classifies restaurants as "Great for vegetarians" using Claude, from the
 * evidence already in the database: name, cuisines, standout dish names, and
 * Lucas's own review commentary.
 *
 * The tag is deliberately selective. Google's `servesVegetarianFood` field
 * means "has at least one vegetarian item", which is true of ~87% of the list
 * and makes for a filter that filters nothing. This asks the narrower question:
 * would someone who doesn't eat meat actually eat *well* here?
 *
 *   node scripts/classify-vego.mjs                  # dry run, 25 places, writes nothing
 *   node scripts/classify-vego.mjs --limit 60       # bigger dry run
 *   node scripts/classify-vego.mjs --all --apply    # classify everything, write SQL
 *
 * --apply only writes scripts/classify-vego.sql. Applying it to D1 is a
 * separate, deliberate step:
 *   npx wrangler d1 execute lucaseats-db --remote --file=scripts/classify-vego.sql
 */

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { makeClient, MODEL_OPUS_5 } from './lib/anthropic.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const APPLY = flag('--apply');
const LIMIT = flag('--all') ? null : Number(value('--limit', '25'));
// Batched so one call classifies several places — fewer round trips, and the
// model sees siblings side by side, which keeps the bar consistent.
const BATCH_SIZE = 10;

const client = makeClient();
if (!client) {
  console.error('No ANTHROPIC_API_KEY in .dev.vars — add one and re-run.');
  process.exit(1);
}

// ---------------------------------------------------------------- fetch data

const sql = `
  SELECT res.slug,
         res.name,
         COALESCE((SELECT GROUP_CONCAT(DISTINCT cuisine) FROM restaurant_cuisines
                    WHERE restaurant_id = res.id), '')                       AS cuisines,
         COALESCE((SELECT GROUP_CONCAT(DISTINCT si.name)
                     FROM standout_items si
                     JOIN reviews rv ON rv.id = si.review_id
                    WHERE rv.restaurant_id = res.id AND si.is_standout = 1), '') AS dishes,
         COALESCE((SELECT GROUP_CONCAT(rv.commentary, ' | ')
                     FROM reviews rv
                    WHERE rv.restaurant_id = res.id AND rv.status = 'published'
                      AND rv.commentary IS NOT NULL), '')                    AS commentary
    FROM restaurants res
   ORDER BY ${LIMIT ? 'RANDOM()' : 'res.name'}
`.replace(/\s+/g, ' ').trim();
// A limited run is a sample, so it must span the catalogue — ordering by name
// and taking the first N gives you the A–B slice (all wine bars and
// steakhouses here) and tells you nothing about how the bar treats the
// cuisines that should score well. Full runs stay alphabetical for a stable,
// diffable output order.

console.log('Fetching restaurants from remote D1...');
const raw = execSync(
  `npx wrangler d1 execute lucaseats-db --remote --json --command "${sql}"`,
  { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], maxBuffer: 32 * 1024 * 1024 }
);
let rows = JSON.parse(raw.slice(raw.indexOf('['))) [0].results;
if (LIMIT) rows = rows.slice(0, LIMIT);
console.log(`Classifying ${rows.length} places with ${MODEL_OPUS_5}\n`);

// ------------------------------------------------------------------ classify

const SYSTEM = `You judge whether a restaurant is genuinely good for vegetarians, for a Sydney restaurant guide.

The bar is "would a vegetarian eat well here", not "is there something they could technically order". Almost every restaurant has a side salad; that does not count.

Rate each restaurant:
- "great"   — a proper vegetarian menu, or a cuisine where vegetarians eat genuinely well (Indian, Lebanese, Middle Eastern, much of Thai/Vietnamese/Chinese), or reviewer notes describing standout vegetable dishes.
- "decent"  — a few real vegetarian mains, but the kitchen's strengths lie elsewhere.
- "limited" — steakhouses, burger joints, seafood specialists, yakitori, and anywhere the evidence points at meat.

Judge whether someone could eat a full meal well, not whether the food happens to contain no meat. Dessert shops, bakeries, ice-cream places and juice bars are therefore never "great" however meat-free they are — the tag is for places a vegetarian would choose for dinner. Rate those on whatever savoury food they serve, usually "decent" or "limited".

Judge only from the evidence given. When a place has nothing but a name and a cuisine, reason from the cuisine and mark confidence "low" — do not invent menu detail. Keep each reason under 15 words.`;

const SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          verdict: { type: 'string', enum: ['great', 'decent', 'limited'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          reason: { type: 'string' },
        },
        required: ['slug', 'verdict', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

function describe(r) {
  const parts = [`slug: ${r.slug}`, `name: ${r.name}`];
  if (r.cuisines) parts.push(`cuisines: ${r.cuisines}`);
  if (r.dishes) parts.push(`standout dishes: ${r.dishes}`);
  // Commentary is the strongest signal but also the longest field; cap it so a
  // few verbose reviews can't crowd out the rest of the batch.
  if (r.commentary) parts.push(`review notes: ${r.commentary.slice(0, 600)}`);
  return parts.join('\n');
}

const verdicts = [];
for (let i = 0; i < rows.length; i += BATCH_SIZE) {
  const batch = rows.slice(i, i + BATCH_SIZE);
  const res = await client.messages.create({
    model: MODEL_OPUS_5,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    messages: [{
      role: 'user',
      content: `Classify each restaurant. Return one result per slug.\n\n${
        batch.map(describe).join('\n\n---\n\n')
      }`,
    }],
  });

  if (res.stop_reason === 'refusal') {
    console.error(`Batch ${i / BATCH_SIZE + 1} refused: ${res.stop_details?.category ?? 'unknown'}`);
    continue;
  }
  const text = res.content.find((b) => b.type === 'text')?.text ?? '';
  const parsed = JSON.parse(text);
  verdicts.push(...parsed.results);
  console.log(`  batch ${i / BATCH_SIZE + 1}/${Math.ceil(rows.length / BATCH_SIZE)} — ${parsed.results.length} classified`);
}

// -------------------------------------------------------------------- report

const byName = new Map(rows.map((r) => [r.slug, r]));
const order = { great: 0, decent: 1, limited: 2 };
verdicts.sort((a, b) => order[a.verdict] - order[b.verdict] || a.slug.localeCompare(b.slug));

console.log('\n' + 'VERDICT   CONF    RESTAURANT'.padEnd(60) + 'WHY');
console.log('-'.repeat(110));
for (const v of verdicts) {
  const name = (byName.get(v.slug)?.name ?? v.slug).slice(0, 32);
  console.log(
    `${v.verdict.padEnd(9)} ${v.confidence.padEnd(7)} ${name.padEnd(34)}${v.reason}`
  );
}

const counts = verdicts.reduce((acc, v) => ({ ...acc, [v.verdict]: (acc[v.verdict] ?? 0) + 1 }), {});
console.log('\n' + JSON.stringify(counts));

const tagged = verdicts.filter((v) => v.verdict === 'great');
console.log(`\n${tagged.length} of ${verdicts.length} would get the tag.`);

// ----------------------------------------------------------------- write SQL

if (!APPLY) {
  console.log('\nDry run — nothing written. Re-run with --apply to generate SQL.');
  process.exit(0);
}

// Keyed on the tag's SLUG, not its label. The label is what this script
// renames ("Vegetarian options" reads as the permissive meaning — anything
// with a side salad qualifies); the slug is what /all?dietary=vegetarian links
// use, so it must not change or every existing filter URL breaks.
//
// Idempotent: clears the tag from every place first, then re-adds it to the
// current "great" set, so a re-run after prompt tweaks converges rather than
// accumulating stale tags.
const slugList = tagged.map((v) => `'${v.slug.replace(/'/g, "''")}'`).join(', ');
const out = [
  `-- Generated by scripts/classify-vego.mjs on ${new Date().toISOString()}`,
  `-- ${tagged.length} of ${verdicts.length} places classified "great for vegetarians".`,
  ``,
  `UPDATE tags SET label = 'Great for vegetarians' WHERE slug = 'vegetarian';`,
  ``,
  `DELETE FROM restaurant_tags`,
  ` WHERE tag_id = (SELECT id FROM tags WHERE slug = 'vegetarian');`,
  ``,
  `INSERT INTO restaurant_tags (restaurant_id, tag_id)`,
  `SELECT res.id, (SELECT id FROM tags WHERE slug = 'vegetarian')`,
  `  FROM restaurants res`,
  ` WHERE res.slug IN (${slugList});`,
  ``,
].join('\n');
writeFileSync('scripts/classify-vego.sql', out);
console.log(`\nWrote scripts/classify-vego.sql (${tagged.length} tag inserts).`);
console.log('Review it, then apply with:');
console.log('  npx wrangler d1 execute lucaseats-db --remote --file=scripts/classify-vego.sql');
