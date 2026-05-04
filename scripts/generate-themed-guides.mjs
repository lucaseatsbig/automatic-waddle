#!/usr/bin/env node
// AI-generated themed roundup bot.
//
// Themed posts target queries like "date night sydney", "best dumplings cbd",
// "post-beach lunch bondi" — intent + place + vibe combinations that aren't
// pure cuisine or suburb listings. Source-set is built from any combination
// of: tag(s), meal_type, region (group of suburbs), suburb, cuisine.
//
// Usage:
//   node scripts/generate-themed-guides.mjs --slug=date-night-sydney --title-hint="Date Night Sydney" --tags=date-night
//   node scripts/generate-themed-guides.mjs --slug=cbd-dumplings --title-hint="Best Dumplings in Sydney CBD" --cuisine=Chinese --suburb=sydney-cbd
//   node scripts/generate-themed-guides.mjs --slug=brunch-eastern --title-hint="Best Brunch Spots in Sydney's East" --meal=brunch --region=eastern-suburbs
//
// Required: --slug AND --title-hint AND at least one filter (--tags, --meal, --region, --suburb, or --cuisine).
// Optional: --publish, --dry-run, --min=3, --skip-voice-check, --topic-id=N, --paa='[...]'

import { writeFileSync } from 'node:fs';
import { MODEL_OPUS, makeClient } from './lib/anthropic.mjs';
import { queryRemote } from './lib/wrangler.mjs';
import { slugify, sumUsage, estimateCost, stableJson } from './lib/util.mjs';
import { buildPostUpsert } from './lib/post-upsert.mjs';
import { buildRelatedSql } from './lib/related-posts.mjs';
import { runVoiceCheck, formatVoiceIssues } from './lib/voice-check.mjs';

const OUTPUT_SQL = 'scripts/generate-themed-guides.sql';
const DEFAULT_MIN_RESTAURANTS = 3;

const SYSTEM_PROMPT = `You are writing for Lucas Eats Big (lucaseatsbig.com), Lucas Leung's personal Sydney food review site. Voice: opinionated, warm, observational, first-person ("I"), no marketing fluff.

You write evergreen themed roundups for SEO. Each post answers a specific intent ("where do I go for X in Sydney") — date night, post-beach lunch, late dinner, group brunch, etc. The user provides the THEME and a filtered set of restaurants from Lucas's data; you write the guide.

# Hard rules — non-negotiable

1. **Ground every claim in the data provided.** Use Lucas's actual ratings, his real commentary, his standout dishes. Never invent visits, dishes, or details.
2. **Only mention restaurants from the provided list.** Never reference other restaurants by name.
3. **Order by Lucas's rating, highest first.** If two are tied, more recent visit wins.
4. **Internal-link every restaurant** the first time you mention it: \`[Name](/restaurants/{slug})\`. Use the slug exactly as provided.
5. **Word count: 1200–1800.**
6. **Structure:**
   - Short opening paragraph (~100 words) — what makes a place fit THIS theme, why these picks (use the theme, the filter context, and Lucas's data).
   - One \`## Heading\` per restaurant with the format \`## N. Restaurant Name — suburb · cuisine\`.
   - 2–3 paragraphs per restaurant covering: why this place fits the theme, what to order (use the standout dishes), Lucas's verdict.
   - If \`paa_questions\` is provided, include a final \`## Frequently asked\` section with 3–5 of the questions answered concisely (≤80 words each), grounded in the data.
   - Brief closing paragraph naming when each spot suits the theme best (specific occasions / time of day / who you're with).
7. **Tone:** confident, specific, never generic. Avoid "hidden gem", "must-try", "foodie", "in the heart of", "amazing", "delicious", "mouth-watering", "go-to spot", "culinary", "gastronomic", "palate". Replace with sensory specifics from the data.
8. **No fabricated quotes from Lucas.**
9. **Lean into the theme.** Mention the theme phrase in the opening, in 2–3 H2s where natural, and in the closing.

# Output format

Return JSON matching this schema exactly. No prose outside the JSON.

{
  "title": string,         // SEO title, ≤60 chars. Should match the title_hint provided, refined for SEO.
  "slug": string,          // URL slug, kebab-case. Should match the slug provided.
  "description": string,   // SEO meta description, ≤160 chars, hooks the reader, mentions the theme
  "body_md": string,
  "og_image_restaurant_id": number,
  "featured_restaurant_ids": number[],
  "faq": [{ "question": string, "answer": string }]
}`;

// --- CLI ------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = {
  slug: null,
  titleHint: null,
  tags: [],
  meal: null,
  region: null,
  suburb: null,
  cuisine: null,
  publish: false,
  dryRun: false,
  minRestaurants: DEFAULT_MIN_RESTAURANTS,
  skipVoiceCheck: false,
  topicId: null,
  paaJson: null,
};
for (const a of args) {
  if (a === '--publish') flags.publish = true;
  else if (a === '--dry-run') flags.dryRun = true;
  else if (a === '--skip-voice-check') flags.skipVoiceCheck = true;
  else if (a.startsWith('--slug=')) flags.slug = slugify(a.slice('--slug='.length));
  else if (a.startsWith('--title-hint=')) flags.titleHint = a.slice('--title-hint='.length);
  else if (a.startsWith('--tags=')) flags.tags = a.slice('--tags='.length).split(',').map((s) => s.trim()).filter(Boolean);
  else if (a.startsWith('--meal=')) flags.meal = a.slice('--meal='.length);
  else if (a.startsWith('--region=')) flags.region = a.slice('--region='.length);
  else if (a.startsWith('--suburb=')) flags.suburb = a.slice('--suburb='.length);
  else if (a.startsWith('--cuisine=')) flags.cuisine = a.slice('--cuisine='.length);
  else if (a.startsWith('--min=')) flags.minRestaurants = Number(a.slice('--min='.length));
  else if (a.startsWith('--topic-id=')) flags.topicId = Number(a.slice('--topic-id='.length));
  else if (a.startsWith('--paa=')) flags.paaJson = a.slice('--paa='.length);
  else {
    console.error(`Unknown flag: ${a}`);
    process.exit(1);
  }
}

if (!flags.slug || !flags.titleHint) {
  console.error('Required: --slug=... --title-hint="..."');
  process.exit(1);
}
const hasFilter = flags.tags.length > 0 || flags.meal || flags.region || flags.suburb || flags.cuisine;
if (!hasFilter) {
  console.error('Required: at least one filter (--tags, --meal, --region, --suburb, --cuisine)');
  process.exit(1);
}

const anthropic = makeClient();
if (!anthropic && !flags.dryRun) {
  console.error('No ANTHROPIC_API_KEY in .dev.vars. Add one or use --dry-run.');
  process.exit(1);
}

// --- Source-set --------------------------------------------------------

console.log(`Building source-set for theme "${flags.titleHint}" (slug: ${flags.slug})...`);

function buildSourceSetSql() {
  const wheres = ['rv.status = \'published\''];
  if (flags.cuisine) {
    wheres.push(`LOWER(res.cuisine) = LOWER('${flags.cuisine.replace(/'/g, "''")}')`);
  }
  if (flags.suburb) {
    wheres.push(`loc.slug = '${flags.suburb.replace(/'/g, "''")}'`);
  }
  if (flags.region) {
    // Region membership comes from src/lib/regions.ts; the topics-router
    // expands it before invoking us. For direct CLI use, accept the region
    // slug and resolve to suburb slugs via a lookup table in the DB if
    // present, else fall back to using the region slug as a substring match
    // on suburb slug — coarse but workable.
    wheres.push(`loc.slug LIKE '%${flags.region.replace(/'/g, "''")}%'`);
  }
  if (flags.meal) {
    wheres.push(`rv.meal_type = '${flags.meal.replace(/'/g, "''")}'`);
  }
  if (flags.tags.length > 0) {
    const tagList = flags.tags.map((t) => `'${t.replace(/'/g, "''")}'`).join(',');
    wheres.push(`res.id IN (
      SELECT rt.restaurant_id FROM restaurant_tags rt
        JOIN tags t ON t.id = rt.tag_id
       WHERE t.slug IN (${tagList})
    )`);
  }
  return `
    WITH pub AS (
      SELECT rv.restaurant_id,
             COUNT(*) AS visit_count,
             AVG(rv.rating_overall) AS avg_overall,
             MAX(rv.visit_date) AS latest_visit_date
        FROM reviews rv
        JOIN restaurants res ON res.id = rv.restaurant_id
        LEFT JOIN locations loc ON loc.id = res.location_id
       WHERE ${wheres.join(' AND ')}
       GROUP BY rv.restaurant_id
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
      LEFT JOIN locations loc ON loc.id = res.location_id
      LEFT JOIN commentary    ON commentary.restaurant_id = res.id
      LEFT JOIN standouts     ON standouts.restaurant_id  = res.id
      LEFT JOIN tagblobs      ON tagblobs.restaurant_id   = res.id
     ORDER BY pub.avg_overall DESC, pub.latest_visit_date DESC, res.name ASC
  `;
}

const restaurants = queryRemote(buildSourceSetSql());

if (restaurants.length < flags.minRestaurants) {
  console.error(`Not enough restaurants in source-set: ${restaurants.length} found, need ≥${flags.minRestaurants}.`);
  console.error(`Loosen the filters or top up commentary/tags via the audit script.`);
  process.exit(1);
}

console.log(`Source-set: ${restaurants.length} restaurants:`);
for (const r of restaurants.slice(0, 10)) console.log(`  - ${r.name} (${r.location ?? '?'}, ${r.cuisine ?? '?'})`);
if (restaurants.length > 10) console.log(`  ... and ${restaurants.length - 10} more`);
console.log();

// source_filter for posts table — stable JSON of all the filter inputs so
// regenerating the same theme UPSERTs into the same row.
const sourceFilter = stableJson({
  slug: flags.slug,
  tags: flags.tags.length > 0 ? flags.tags : undefined,
  meal: flags.meal ?? undefined,
  region: flags.region ?? undefined,
  suburb: flags.suburb ?? undefined,
  cuisine: flags.cuisine ?? undefined,
});

// --- Claude call ----------------------------------------------------------

async function generateGuide() {
  const dataPayload = {
    theme_title: flags.titleHint,
    theme_slug: flags.slug,
    filters: {
      tags: flags.tags,
      meal: flags.meal,
      region: flags.region,
      suburb: flags.suburb,
      cuisine: flags.cuisine,
    },
    paa_questions: flags.paaJson ? JSON.parse(flags.paaJson) : [],
    restaurants: restaurants.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      suburb: r.location,
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

  const userMessage = `Theme: ${flags.titleHint}\nSlug: ${flags.slug}\n\nRestaurant data (already ordered by Lucas's average rating, descending):\n\n${JSON.stringify(
    dataPayload,
    null,
    2
  )}\n\nWrite the guide. Return JSON only.`;

  if (flags.dryRun) {
    console.log(`\n[dry-run] System prompt: ${SYSTEM_PROMPT.length} chars`);
    console.log(`[dry-run] User message: ${userMessage.length} chars`);
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

  // Force the slug we asked for — Claude's drift here would break our queue.
  parsed.slug = flags.slug;
  if (!Array.isArray(parsed.faq)) parsed.faq = [];

  return { parsed, usage: response.usage };
}

// --- Run ------------------------------------------------------------------

const sqlStatements = [];
const usageRecords = [];
const voiceUsageRecords = [];
let voiceFailed = false;

try {
  const result = await generateGuide();
  if (!result) {
    console.log('\n[dry-run] complete.');
    process.exit(0);
  }
  const { parsed, usage } = result;
  usageRecords.push(usage);

  let voiceResult = { severity: 'pass', issues: [], usage: null, skipped: true };
  if (!flags.skipVoiceCheck) {
    console.log('Running voice check...');
    voiceResult = await runVoiceCheck(anthropic, parsed.body_md);
    if (voiceResult.usage) voiceUsageRecords.push(voiceResult.usage);
  }
  if (voiceResult.severity === 'fail') {
    console.error('✗ Voice check FAILED — not writing SQL.');
    console.error(formatVoiceIssues(voiceResult));
    voiceFailed = true;
  } else {
    if (voiceResult.severity === 'warn') {
      console.warn('Voice check: WARN');
      console.warn(formatVoiceIssues(voiceResult));
    }
    sqlStatements.push(
      buildPostUpsert({
        kind: 'themed',
        source_filter: sourceFilter,
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
      kind: 'themed',
      source_filter: sourceFilter,
      featured_restaurant_ids: parsed.featured_restaurant_ids,
    });
    sqlStatements.push(...relatedSql);
    if (flags.topicId) {
      sqlStatements.push(
        `UPDATE topics SET status='generated', generated_at=unixepoch(), post_slug='${parsed.slug.replace(/'/g, "''")}' WHERE id=${flags.topicId};`
      );
    }
    console.log(`✓ "${parsed.title}" — ${parsed.featured_restaurant_ids.length} restaurants featured, ${relatedSql.length / 2} related links`);
  }
} catch (err) {
  console.error(`✗ Failed: ${err.message}`);
  process.exit(1);
}

if (sqlStatements.length > 0) {
  const header = `-- Generated by scripts/generate-themed-guides.mjs.
-- Apply with:
--   wrangler d1 execute lucaseats-db --local --file=${OUTPUT_SQL}
--   wrangler d1 execute lucaseats-db --remote --file=${OUTPUT_SQL}

`;
  writeFileSync(OUTPUT_SQL, header + sqlStatements.join('\n\n') + '\n');
  console.log(`\nWrote ${sqlStatements.length} statement(s) to ${OUTPUT_SQL}`);
}

console.log('\n--- Summary ---');
if (!flags.dryRun && usageRecords.length > 0) {
  const opusTotal = sumUsage(usageRecords);
  const haikuTotal = voiceUsageRecords.length > 0 ? sumUsage(voiceUsageRecords) : null;
  const opusCost = estimateCost(MODEL_OPUS, opusTotal);
  const haikuCost = haikuTotal ? estimateCost('claude-haiku-4-5', haikuTotal) : 0;
  console.log(`Tokens (Opus): in=${opusTotal.input_tokens}, out=${opusTotal.output_tokens}`);
  if (haikuTotal) console.log(`Tokens (Haiku voice check): in=${haikuTotal.input_tokens}, out=${haikuTotal.output_tokens}`);
  console.log(`Estimated cost: $${(opusCost + haikuCost).toFixed(4)}`);
}
if (voiceFailed) process.exit(2);
