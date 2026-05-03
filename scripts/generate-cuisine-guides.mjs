#!/usr/bin/env node
// AI-generated cuisine listicle bot.
//
// Usage:
//   node scripts/generate-cuisine-guides.mjs                # all eligible cuisines, draft
//   node scripts/generate-cuisine-guides.mjs --cuisine=Italian
//   node scripts/generate-cuisine-guides.mjs --publish      # mark posts published immediately
//   node scripts/generate-cuisine-guides.mjs --dry-run      # log prompts, don't call API
//   node scripts/generate-cuisine-guides.mjs --min=3        # min restaurants per cuisine (default 3)
//   node scripts/generate-cuisine-guides.mjs --limit=5      # max cuisines per run
//
// Reads ANTHROPIC_API_KEY from .dev.vars, queries the REMOTE D1 (source of
// truth) for restaurant data, calls Claude to generate one listicle per
// cuisine, and writes UPSERT SQL to scripts/generate-cuisine-guides.sql.
// Apply with:
//   wrangler d1 execute lucaseats-db --local --file=scripts/generate-cuisine-guides.sql
//   wrangler d1 execute lucaseats-db --remote --file=scripts/generate-cuisine-guides.sql

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';

// --- Config ---------------------------------------------------------------

const MODEL = 'claude-opus-4-7';
const OUTPUT_SQL = 'scripts/generate-cuisine-guides.sql';
const DEFAULT_MIN_RESTAURANTS = 3;

// Stable system prompt — kept short and lifted to the top of the request so
// every cuisine call hits the prompt cache. Volatile data (cuisine name,
// restaurant list) lives in the user message after the cache breakpoint.
const SYSTEM_PROMPT = `You are writing for Lucas Eats Big (lucaseatsbig.com), Lucas Leung's personal Sydney food review site. Voice: opinionated, warm, observational, first-person ("I"), no marketing fluff.

You write evergreen ranked guides for SEO. Each guide covers one cuisine in Sydney. Your audience: people Googling "best [cuisine] sydney".

# Hard rules — non-negotiable

1. **Ground every claim in the data provided.** Use Lucas's actual ratings, his real commentary, his standout dishes. Do not invent visits, dishes, vibes, or details that are not in the source data.
2. **Only mention restaurants from the provided list.** Never reference other restaurants by name.
3. **Order by Lucas's rating, highest first.** If two are tied, more recent visit wins.
4. **Internal-link every restaurant** the first time you mention it: \`[Name](/restaurants/{slug})\`. Use the slug exactly as provided.
5. **Word count: 1200–1800.** SEO-substantive, not bloated.
6. **Structure:**
   - Short opening paragraph (~80 words) — Lucas's take on the cuisine in Sydney overall.
   - One \`## Heading\` per restaurant with the format \`## N. Restaurant Name — suburb\`.
   - 2–3 paragraphs per restaurant covering: what it is, what to order (use the standout dishes), Lucas's verdict (incorporate his real commentary verbatim or paraphrased honestly).
   - Brief closing paragraph naming who each spot suits ("for date night", "for a casual lunch", etc.) — only based on the data.
7. **Tone:** confident, specific, never generic. Avoid "hidden gem", "must-try", "foodie", "in the heart of", "amazing", "delicious". Replace with sensory specifics from the data.
8. **No fabricated quotes from Lucas.** If you paraphrase his commentary, stay faithful to what he wrote.

# Output format

Return JSON matching this schema exactly. No prose outside the JSON.

{
  "title": string,         // SEO title, ≤60 chars. Format: "Best <Cuisine> in Sydney — Ranked"
  "slug": string,          // URL slug, kebab-case. Format: "best-<cuisine>-sydney"
  "description": string,   // SEO meta description, ≤160 chars, hooks the reader
  "body_md": string,       // The full markdown article per the structure above
  "og_image_restaurant_id": number,  // Choose the top-ranked restaurant's id from the source data
  "featured_restaurant_ids": number[]  // Every restaurant id mentioned, in the order they appear
}`;

// --- CLI parsing ----------------------------------------------------------

const args = process.argv.slice(2);
const flags = {
  cuisine: null,
  publish: false,
  dryRun: false,
  minRestaurants: DEFAULT_MIN_RESTAURANTS,
  limit: null,
};
for (const a of args) {
  if (a === '--publish') flags.publish = true;
  else if (a === '--dry-run') flags.dryRun = true;
  else if (a.startsWith('--cuisine=')) flags.cuisine = a.slice('--cuisine='.length);
  else if (a.startsWith('--min=')) flags.minRestaurants = Number(a.slice('--min='.length));
  else if (a.startsWith('--limit=')) flags.limit = Number(a.slice('--limit='.length));
  else {
    console.error(`Unknown flag: ${a}`);
    process.exit(1);
  }
}

// --- Setup ----------------------------------------------------------------

const apiKey = readFileSync('.dev.vars', 'utf8').match(/ANTHROPIC_API_KEY=(.+)/)?.[1]?.trim();
if (!apiKey && !flags.dryRun) {
  console.error('No ANTHROPIC_API_KEY in .dev.vars. Add one or use --dry-run.');
  process.exit(1);
}

const anthropic = apiKey ? new Anthropic({ apiKey }) : null;

// --- Helpers --------------------------------------------------------------

function escSql(v) {
  if (v == null) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function queryRemote(sql) {
  // wrangler d1 --json returns an array; the first element holds .results.
  const out = execSync(
    `npx wrangler d1 execute lucaseats-db --remote --json --command "${sql.replace(/"/g, '\\"').replace(/\s+/g, ' ').trim()}"`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }
  );
  return JSON.parse(out)[0].results;
}

// --- Source data ----------------------------------------------------------

console.log('Fetching cuisine candidates from remote...');

const cuisineRows = queryRemote(`
  SELECT res.cuisine,
         COUNT(DISTINCT res.id) AS n
    FROM restaurants res
    JOIN reviews rv ON rv.restaurant_id = res.id AND rv.status = 'published'
   WHERE res.cuisine IS NOT NULL AND res.cuisine <> ''
   GROUP BY res.cuisine
  HAVING n >= ${flags.minRestaurants}
   ORDER BY n DESC
`);

let cuisinesToProcess = flags.cuisine
  ? cuisineRows.filter((c) => c.cuisine.toLowerCase() === flags.cuisine.toLowerCase())
  : cuisineRows;

if (flags.cuisine && cuisinesToProcess.length === 0) {
  console.error(`No cuisine "${flags.cuisine}" with ≥${flags.minRestaurants} entries on remote.`);
  process.exit(1);
}

if (flags.limit) cuisinesToProcess = cuisinesToProcess.slice(0, flags.limit);

console.log(`\nWill generate guides for ${cuisinesToProcess.length} cuisine(s):`);
for (const c of cuisinesToProcess) console.log(`  - ${c.cuisine} (${c.n} restaurants)`);
console.log();

// --- Per-cuisine source-set query (one round-trip per cuisine) -----------

function fetchCuisineSourceSet(cuisine) {
  const escaped = cuisine.replace(/'/g, "''");
  return queryRemote(`
    WITH pub AS (
      SELECT r.restaurant_id,
             COUNT(*) AS visit_count,
             AVG(r.rating_overall) AS avg_overall,
             MAX(r.visit_date) AS latest_visit_date
        FROM reviews r
       WHERE r.status = 'published'
       GROUP BY r.restaurant_id
    ),
    commentary AS (
      SELECT rv.restaurant_id,
             GROUP_CONCAT(rv.commentary, ' || ') AS commentary_blob
        FROM reviews rv
       WHERE rv.status = 'published' AND rv.commentary IS NOT NULL AND rv.commentary <> ''
       GROUP BY rv.restaurant_id
    ),
    standouts AS (
      SELECT rv.restaurant_id,
             GROUP_CONCAT(si.name, ', ') AS standouts_blob
        FROM standout_items si
        JOIN reviews rv ON rv.id = si.review_id
       WHERE rv.status = 'published' AND si.is_standout = 1
       GROUP BY rv.restaurant_id
    ),
    tagblobs AS (
      SELECT rt.restaurant_id,
             GROUP_CONCAT(t.label, ', ') AS tags_blob
        FROM restaurant_tags rt
        JOIN tags t ON t.id = rt.tag_id
       GROUP BY rt.restaurant_id
    )
    SELECT res.id, res.slug, res.name, res.address, res.price_tier,
           loc.name AS location,
           pub.visit_count, pub.avg_overall, pub.latest_visit_date,
           commentary.commentary_blob,
           standouts.standouts_blob,
           tagblobs.tags_blob
      FROM restaurants res
      JOIN pub ON pub.restaurant_id = res.id
      LEFT JOIN locations  loc        ON loc.id = res.location_id
      LEFT JOIN commentary            ON commentary.restaurant_id = res.id
      LEFT JOIN standouts             ON standouts.restaurant_id = res.id
      LEFT JOIN tagblobs              ON tagblobs.restaurant_id = res.id
     WHERE LOWER(res.cuisine) = LOWER('${escaped}')
     ORDER BY pub.avg_overall DESC, pub.latest_visit_date DESC, res.name ASC
  `);
}

// --- Claude call ----------------------------------------------------------

async function generateGuide(cuisine, restaurants) {
  const dataPayload = {
    cuisine,
    restaurants: restaurants.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      suburb: r.location,
      address: r.address,
      price_tier: r.price_tier,
      avg_rating: r.avg_overall != null ? Number(r.avg_overall).toFixed(1) : null,
      visit_count: r.visit_count,
      latest_visit: r.latest_visit_date,
      commentary: r.commentary_blob,
      standout_dishes: r.standouts_blob,
      tags: r.tags_blob,
    })),
  };

  const userMessage = `Cuisine: ${cuisine}\n\nRestaurant data (already ordered by Lucas's average rating, descending):\n\n${JSON.stringify(
    dataPayload,
    null,
    2
  )}\n\nWrite the guide. Return JSON only.`;

  if (flags.dryRun) {
    console.log(`\n[dry-run] System prompt: ${SYSTEM_PROMPT.length} chars`);
    console.log(`[dry-run] User message: ${userMessage.length} chars`);
    console.log(`[dry-run] First restaurant: ${restaurants[0]?.name}`);
    return null;
  }

  // Adaptive thinking + cached system prompt. The system prompt is the
  // expensive-to-cache portion (~700 tokens with the rules above); cuisines
  // share it, so we mark it for the cache.
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text block in response');

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (err) {
    // Sometimes the model wraps in ```json fences despite instructions.
    const fenced = textBlock.text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) parsed = JSON.parse(fenced[1]);
    else throw new Error(`Could not parse Claude response as JSON:\n${textBlock.text.slice(0, 500)}`);
  }

  // Validate the response shape and that referenced restaurant IDs exist.
  const required = ['title', 'slug', 'description', 'body_md', 'og_image_restaurant_id', 'featured_restaurant_ids'];
  for (const k of required) {
    if (!(k in parsed)) throw new Error(`Missing field "${k}" in Claude response`);
  }
  const validIds = new Set(restaurants.map((r) => r.id));
  if (!validIds.has(parsed.og_image_restaurant_id)) {
    throw new Error(`og_image_restaurant_id ${parsed.og_image_restaurant_id} not in source set`);
  }
  parsed.featured_restaurant_ids = parsed.featured_restaurant_ids.filter((id) => validIds.has(id));
  if (parsed.featured_restaurant_ids.length === 0) {
    throw new Error('No valid restaurant IDs in featured_restaurant_ids');
  }

  // Force slug to a safe form even if Claude drifted.
  parsed.slug = slugify(parsed.slug || `best-${cuisine}-sydney`);

  return {
    parsed,
    usage: response.usage,
  };
}

// --- Main loop ------------------------------------------------------------

const upsertSqlHeader = `-- Generated by scripts/generate-cuisine-guides.mjs.
-- Idempotent: ON CONFLICT (kind, source_filter) DO UPDATE refreshes the
-- existing post and bumps generated_at.
-- Apply with:
--   wrangler d1 execute lucaseats-db --local --file=scripts/generate-cuisine-guides.sql
--   wrangler d1 execute lucaseats-db --remote --file=scripts/generate-cuisine-guides.sql

`;

const upserts = [];
let totalInputTokens = 0, totalCacheRead = 0, totalCacheWrite = 0, totalOutputTokens = 0;
let succeeded = 0, failed = 0;

for (let i = 0; i < cuisinesToProcess.length; i++) {
  const { cuisine, n } = cuisinesToProcess[i];
  const tag = `[${i + 1}/${cuisinesToProcess.length}]`;
  console.log(`\n${tag} Generating "${cuisine}" guide (${n} restaurants)...`);

  try {
    const restaurants = fetchCuisineSourceSet(cuisine);
    const result = await generateGuide(cuisine, restaurants);
    if (!result) continue; // dry-run

    const { parsed, usage } = result;
    totalInputTokens += usage.input_tokens ?? 0;
    totalCacheRead += usage.cache_read_input_tokens ?? 0;
    totalCacheWrite += usage.cache_creation_input_tokens ?? 0;
    totalOutputTokens += usage.output_tokens ?? 0;

    const status = flags.publish ? 'published' : 'draft';
    const publishedAt = flags.publish ? 'unixepoch()' : 'NULL';

    upserts.push(
      `INSERT INTO posts (slug, kind, source_filter, title, description, body_md,
                          og_image_restaurant_id, featured_restaurants_json,
                          model, status, published_at, generated_at)
VALUES (${escSql(parsed.slug)}, 'cuisine', ${escSql(cuisine)},
        ${escSql(parsed.title)}, ${escSql(parsed.description)},
        ${escSql(parsed.body_md)}, ${parsed.og_image_restaurant_id},
        ${escSql(JSON.stringify(parsed.featured_restaurant_ids))},
        ${escSql(MODEL)}, '${status}', ${publishedAt}, unixepoch())
ON CONFLICT (kind, source_filter) DO UPDATE SET
  slug = excluded.slug,
  title = excluded.title,
  description = excluded.description,
  body_md = excluded.body_md,
  og_image_restaurant_id = excluded.og_image_restaurant_id,
  featured_restaurants_json = excluded.featured_restaurants_json,
  model = excluded.model,
  status = excluded.status,
  published_at = excluded.published_at,
  generated_at = unixepoch();`
    );

    console.log(`${tag} ✓ "${parsed.title}" — ${parsed.featured_restaurant_ids.length} restaurants featured`);
    console.log(`${tag}   tokens: in=${usage.input_tokens}, cached=${usage.cache_read_input_tokens ?? 0}, out=${usage.output_tokens}`);
    succeeded++;
  } catch (err) {
    console.error(`${tag} ✗ Failed: ${err.message}`);
    failed++;
  }
}

// --- Write output ---------------------------------------------------------

if (upserts.length > 0) {
  writeFileSync(OUTPUT_SQL, upsertSqlHeader + upserts.join('\n\n') + '\n');
  console.log(`\nWrote ${upserts.length} UPSERT(s) to ${OUTPUT_SQL}`);
}

// --- Summary --------------------------------------------------------------

console.log('\n--- Summary ---');
console.log(`Succeeded: ${succeeded}, Failed: ${failed}`);
if (!flags.dryRun) {
  // Opus 4.7: $5/M input, $25/M output. Cache reads ~0.1×, writes ~1.25×.
  const cost =
    ((totalInputTokens - totalCacheRead - totalCacheWrite) * 5 +
      totalCacheWrite * 5 * 1.25 +
      totalCacheRead * 5 * 0.1 +
      totalOutputTokens * 25) /
    1_000_000;
  console.log(`Tokens: in=${totalInputTokens}, cache_read=${totalCacheRead}, cache_write=${totalCacheWrite}, out=${totalOutputTokens}`);
  console.log(`Estimated cost: $${cost.toFixed(4)}`);
  console.log(`\nNext: review ${OUTPUT_SQL}, then apply with:`);
  console.log(`  npx wrangler d1 execute lucaseats-db --local --file=${OUTPUT_SQL}`);
  console.log(`  npx wrangler d1 execute lucaseats-db --remote --file=${OUTPUT_SQL}`);
  if (!flags.publish) {
    console.log(`\nPosts created as DRAFTS — they won't show on /guides until you UPDATE status='published'.`);
    console.log(`Re-run with --publish to mark them live on creation.`);
  }
}
