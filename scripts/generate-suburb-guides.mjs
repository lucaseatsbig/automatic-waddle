#!/usr/bin/env node
// AI-generated suburb listicle bot.
//
// Usage:
//   node scripts/generate-suburb-guides.mjs                       # all eligible suburbs, draft
//   node scripts/generate-suburb-guides.mjs --suburb=surry-hills  # one suburb (slug)
//   node scripts/generate-suburb-guides.mjs --publish             # mark posts published immediately
//   node scripts/generate-suburb-guides.mjs --dry-run             # log prompts, don't call API
//   node scripts/generate-suburb-guides.mjs --min=3               # min restaurants per suburb (default 3)
//   node scripts/generate-suburb-guides.mjs --limit=5             # max suburbs per run
//   node scripts/generate-suburb-guides.mjs --skip-voice-check    # bypass Haiku voice check

import { writeFileSync } from 'node:fs';
import { MODEL_OPUS, makeClient } from './lib/anthropic.mjs';
import { queryRemote } from './lib/wrangler.mjs';
import { slugify, sumUsage, estimateCost } from './lib/util.mjs';
import { buildPostUpsert } from './lib/post-upsert.mjs';
import { buildRelatedSql } from './lib/related-posts.mjs';
import { runVoiceCheck, formatVoiceIssues } from './lib/voice-check.mjs';

const OUTPUT_SQL = 'scripts/generate-suburb-guides.sql';
const DEFAULT_MIN_RESTAURANTS = 3;

const SYSTEM_PROMPT = `You are writing for Lucas Eats Big (lucaseatsbig.com), Lucas Leung's personal Sydney food review site. Voice: opinionated, warm, observational, first-person ("I"), no marketing fluff.

You write evergreen ranked guides for SEO. Each guide covers one Sydney suburb. Your audience: people Googling "best restaurants {suburb}", "where to eat {suburb}", "{suburb} food".

# Hard rules — non-negotiable

1. **Ground every claim in the data provided.** Use Lucas's actual ratings, his real commentary, his standout dishes. Do not invent visits, dishes, vibes, or details that are not in the source data.
2. **Only mention restaurants from the provided list.** Never reference other restaurants by name.
3. **Order by Lucas's rating, highest first.** If two are tied, more recent visit wins.
4. **Internal-link every restaurant** the first time you mention it: \`[Name](/restaurants/{slug})\`. Use the slug exactly as provided.
5. **Word count: 1200–1800.** SEO-substantive, not bloated.
6. **Structure:**
   - Short opening paragraph (~80 words) — Lucas's take on this suburb's food scene overall, what kind of eating it's good for, who it suits.
   - One \`## Heading\` per restaurant with the format \`## N. Restaurant Name — cuisine\`.
   - 2–3 paragraphs per restaurant covering: what it is, what to order (use the standout dishes), Lucas's verdict (incorporate his real commentary verbatim or paraphrased honestly).
   - If \`paa_questions\` is provided, include a final \`## Frequently asked\` section with 3–5 of the questions answered concisely (≤80 words each), grounded in the data.
   - Brief closing paragraph naming who each spot suits ("for date night", "for a casual lunch", "for groups", etc.) — only based on the data.
7. **Tone:** confident, specific, never generic. Avoid "hidden gem", "must-try", "foodie", "in the heart of", "amazing", "delicious", "mouth-watering", "go-to spot", "culinary", "gastronomic", "palate". Replace with sensory specifics from the data.
8. **No fabricated quotes from Lucas.** If you paraphrase his commentary, stay faithful to what he wrote.
9. **Lean into the suburb angle.** Mention the suburb by name in the opening, in 2–3 H2s where natural, and in the closing. Reference the cuisine mix you see across the data ("a heavy Italian lean", "leaning Thai and Japanese") rather than inventing one.

# Output format

Return JSON matching this schema exactly. No prose outside the JSON.

{
  "title": string,         // SEO title, ≤60 chars. Format: "Best Restaurants in <Suburb>, Sydney"
  "slug": string,          // URL slug, kebab-case. Format: "best-restaurants-<suburb>-sydney"
  "description": string,   // SEO meta description, ≤160 chars, hooks the reader, mentions the suburb
  "body_md": string,       // The full markdown article per the structure above
  "og_image_restaurant_id": number,
  "featured_restaurant_ids": number[],
  "faq": [{ "question": string, "answer": string }]
}`;

// --- CLI ------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = {
  suburb: null,
  publish: false,
  dryRun: false,
  minRestaurants: DEFAULT_MIN_RESTAURANTS,
  limit: null,
  skipVoiceCheck: false,
  topicId: null,
  paaJson: null,
};
for (const a of args) {
  if (a === '--publish') flags.publish = true;
  else if (a === '--dry-run') flags.dryRun = true;
  else if (a === '--skip-voice-check') flags.skipVoiceCheck = true;
  else if (a.startsWith('--suburb=')) flags.suburb = a.slice('--suburb='.length);
  else if (a.startsWith('--min=')) flags.minRestaurants = Number(a.slice('--min='.length));
  else if (a.startsWith('--limit=')) flags.limit = Number(a.slice('--limit='.length));
  else if (a.startsWith('--topic-id=')) flags.topicId = Number(a.slice('--topic-id='.length));
  else if (a.startsWith('--paa=')) flags.paaJson = a.slice('--paa='.length);
  else {
    console.error(`Unknown flag: ${a}`);
    process.exit(1);
  }
}

const anthropic = makeClient();
if (!anthropic && !flags.dryRun) {
  console.error('No ANTHROPIC_API_KEY in .dev.vars. Add one or use --dry-run.');
  process.exit(1);
}

// --- Source data ----------------------------------------------------------

console.log('Fetching suburb candidates from remote...');

const suburbRows = queryRemote(`
  SELECT loc.slug, loc.name, COUNT(DISTINCT res.id) AS n
    FROM locations loc
    JOIN restaurants res ON res.location_id = loc.id
    JOIN reviews rv ON rv.restaurant_id = res.id AND rv.status = 'published'
   GROUP BY loc.id
  HAVING n >= ${flags.minRestaurants}
   ORDER BY n DESC
`);

let suburbsToProcess = flags.suburb
  ? suburbRows.filter((s) => s.slug.toLowerCase() === flags.suburb.toLowerCase())
  : suburbRows;

if (flags.suburb && suburbsToProcess.length === 0) {
  console.error(`No suburb "${flags.suburb}" with ≥${flags.minRestaurants} entries on remote.`);
  console.error(`Tip: pass the suburb slug, not the display name (e.g. "surry-hills" not "Surry Hills").`);
  process.exit(1);
}

if (flags.limit) suburbsToProcess = suburbsToProcess.slice(0, flags.limit);

console.log(`\nWill generate guides for ${suburbsToProcess.length} suburb(s):`);
for (const s of suburbsToProcess) console.log(`  - ${s.name} (${s.n} restaurants)`);
console.log();

function fetchSuburbSourceSet(suburbSlug) {
  const escaped = suburbSlug.replace(/'/g, "''");
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
    SELECT res.id, res.slug, res.name, res.cuisine, res.address, res.price_tier,
           loc.name AS location, loc.slug AS location_slug,
           pub.visit_count, pub.avg_overall, pub.latest_visit_date,
           commentary.commentary_blob,
           standouts.standouts_blob,
           tagblobs.tags_blob
      FROM restaurants res
      JOIN pub ON pub.restaurant_id = res.id
      JOIN locations loc ON loc.id = res.location_id AND loc.slug = '${escaped}'
      LEFT JOIN commentary ON commentary.restaurant_id = res.id
      LEFT JOIN standouts  ON standouts.restaurant_id  = res.id
      LEFT JOIN tagblobs   ON tagblobs.restaurant_id   = res.id
     ORDER BY pub.avg_overall DESC, pub.latest_visit_date DESC, res.name ASC
  `);
}

// --- Claude call ----------------------------------------------------------

async function generateGuide(suburb, restaurants, paaQuestions) {
  const dataPayload = {
    suburb: suburb.name,
    suburb_slug: suburb.slug,
    paa_questions: paaQuestions ?? [],
    restaurants: restaurants.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      cuisine: r.cuisine,
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

  const userMessage = `Suburb: ${suburb.name}\n\nRestaurant data (already ordered by Lucas's average rating, descending):\n\n${JSON.stringify(
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

  const response = await anthropic.messages.create({
    model: MODEL_OPUS,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text block in response');

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    const fenced = textBlock.text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) parsed = JSON.parse(fenced[1]);
    else throw new Error(`Could not parse Claude response as JSON:\n${textBlock.text.slice(0, 500)}`);
  }

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

  parsed.slug = slugify(parsed.slug || `best-restaurants-${suburb.slug}-sydney`);
  if (!Array.isArray(parsed.faq)) parsed.faq = [];

  return { parsed, usage: response.usage };
}

// --- Main loop ------------------------------------------------------------

const sqlStatements = [];
const usageRecords = [];
const voiceUsageRecords = [];
let succeeded = 0, failed = 0, voiceFailed = 0;

for (let i = 0; i < suburbsToProcess.length; i++) {
  const suburb = suburbsToProcess[i];
  const tag = `[${i + 1}/${suburbsToProcess.length}]`;
  console.log(`\n${tag} Generating "${suburb.name}" guide (${suburb.n} restaurants)...`);

  try {
    const restaurants = fetchSuburbSourceSet(suburb.slug);
    const paa = flags.paaJson ? JSON.parse(flags.paaJson) : [];
    const result = await generateGuide(suburb, restaurants, paa);
    if (!result) continue;

    const { parsed, usage } = result;
    usageRecords.push(usage);

    let voiceResult = { severity: 'pass', issues: [], usage: null, skipped: true };
    if (!flags.skipVoiceCheck) {
      console.log(`${tag}   running voice check...`);
      voiceResult = await runVoiceCheck(anthropic, parsed.body_md);
      if (voiceResult.usage) voiceUsageRecords.push(voiceResult.usage);
    }
    if (voiceResult.severity === 'fail') {
      console.error(`${tag} ✗ Voice check FAILED — skipping post.`);
      console.error(formatVoiceIssues(voiceResult));
      voiceFailed++;
      failed++;
      continue;
    }
    if (voiceResult.severity === 'warn') {
      console.warn(`${tag}   voice check: WARN`);
      console.warn(formatVoiceIssues(voiceResult));
    }

    sqlStatements.push(
      buildPostUpsert({
        kind: 'suburb',
        source_filter: suburb.slug,
        slug: parsed.slug,
        title: parsed.title,
        description: parsed.description,
        body_md: parsed.body_md,
        og_image_restaurant_id: parsed.og_image_restaurant_id,
        featured_restaurant_ids: parsed.featured_restaurant_ids,
        model: MODEL_OPUS,
        publish: flags.publish,
      })
    );

    const relatedSql = buildRelatedSql({
      slug: parsed.slug,
      kind: 'suburb',
      source_filter: suburb.slug,
      featured_restaurant_ids: parsed.featured_restaurant_ids,
    });
    sqlStatements.push(...relatedSql);

    if (flags.topicId) {
      sqlStatements.push(
        `UPDATE topics SET status='generated', generated_at=unixepoch(), post_slug='${parsed.slug.replace(/'/g, "''")}' WHERE id=${flags.topicId};`
      );
    }

    console.log(`${tag} ✓ "${parsed.title}" — ${parsed.featured_restaurant_ids.length} restaurants featured, ${relatedSql.length / 2} related links`);
    console.log(`${tag}   tokens: in=${usage.input_tokens}, cached=${usage.cache_read_input_tokens ?? 0}, out=${usage.output_tokens}`);
    succeeded++;
  } catch (err) {
    console.error(`${tag} ✗ Failed: ${err.message}`);
    failed++;
  }
}

if (sqlStatements.length > 0) {
  const header = `-- Generated by scripts/generate-suburb-guides.mjs.
-- Apply with:
--   wrangler d1 execute lucaseats-db --local --file=${OUTPUT_SQL}
--   wrangler d1 execute lucaseats-db --remote --file=${OUTPUT_SQL}

`;
  writeFileSync(OUTPUT_SQL, header + sqlStatements.join('\n\n') + '\n');
  console.log(`\nWrote ${sqlStatements.length} statement(s) to ${OUTPUT_SQL}`);
}

console.log('\n--- Summary ---');
console.log(`Succeeded: ${succeeded}, Failed: ${failed}${voiceFailed ? ` (voice: ${voiceFailed})` : ''}`);
if (!flags.dryRun && usageRecords.length > 0) {
  const opusTotal = sumUsage(usageRecords);
  const haikuTotal = voiceUsageRecords.length > 0 ? sumUsage(voiceUsageRecords) : null;
  const opusCost = estimateCost(MODEL_OPUS, opusTotal);
  const haikuCost = haikuTotal ? estimateCost('claude-haiku-4-5', haikuTotal) : 0;
  console.log(`Tokens (Opus): in=${opusTotal.input_tokens}, cache_read=${opusTotal.cache_read_input_tokens}, cache_write=${opusTotal.cache_creation_input_tokens}, out=${opusTotal.output_tokens}`);
  if (haikuTotal) console.log(`Tokens (Haiku voice check): in=${haikuTotal.input_tokens}, out=${haikuTotal.output_tokens}`);
  console.log(`Estimated cost: $${(opusCost + haikuCost).toFixed(4)}`);
  console.log(`\nNext: review ${OUTPUT_SQL}, then apply with:`);
  console.log(`  npx wrangler d1 execute lucaseats-db --local --file=${OUTPUT_SQL}`);
  console.log(`  npx wrangler d1 execute lucaseats-db --remote --file=${OUTPUT_SQL}`);
  if (!flags.publish) {
    console.log(`\nPosts created as DRAFTS — they won't show on /guides until you UPDATE status='published'.`);
    console.log(`Re-run with --publish to mark them live on creation.`);
  }
}
