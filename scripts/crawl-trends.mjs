#!/usr/bin/env node
// Trends crawler — populates the `topics` queue with SEO topics worth
// generating guides for. Pulls from:
//
//   1. Seed queries (defined below — edit to taste)
//   2. Google autocomplete (free, unauthenticated, deterministic)
//   3. PAA (People Also Ask) via SerpAPI/ScraperAPI if a key is configured
//   4. DataForSEO keyword volume API if a key is configured (optional)
//
// Each discovered query is classified into cuisine / suburb / themed based
// on whether it matches a known cuisine, a known suburb slug, or neither
// (themed). Coverage_count is computed per-query so the router can skip
// queries that don't have enough Lucas-data yet.
//
// Usage:
//   node scripts/crawl-trends.mjs                    # full crawl, write all to topics table
//   node scripts/crawl-trends.mjs --dry-run          # log only, don't write
//   node scripts/crawl-trends.mjs --seeds-only       # skip autocomplete, just classify the seed list
//   node scripts/crawl-trends.mjs --max-per-seed=8   # cap autocomplete suggestions per seed

import { writeFileSync } from 'node:fs';
import { queryRemote } from './lib/wrangler.mjs';
import { fetchPAA, hasPaaProvider } from './lib/paa.mjs';
import { escSql, slugify, stableJson } from './lib/util.mjs';

const OUTPUT_SQL = 'scripts/crawl-trends.sql';

// Seed queries — these get expanded via autocomplete. Edit this list as you
// learn what your audience searches for.
const SEEDS = [
  'best restaurants sydney',
  'best italian sydney',
  'best japanese sydney',
  'best chinese sydney',
  'best korean sydney',
  'best thai sydney',
  'best vietnamese sydney',
  'best indian sydney',
  'best dumplings sydney',
  'best ramen sydney',
  'best pizza sydney',
  'best brunch sydney',
  'best coffee sydney',
  'best dessert sydney',
  'date night sydney',
  'best cheap eats sydney',
  'where to eat sydney',
  'where to eat surry hills',
  'where to eat newtown',
  'where to eat chinatown sydney',
  'where to eat bondi',
  'best restaurants cbd sydney',
];

// --- CLI ------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = {
  dryRun: args.includes('--dry-run'),
  seedsOnly: args.includes('--seeds-only'),
  maxPerSeed: 8,
};
for (const a of args) {
  if (a.startsWith('--max-per-seed=')) flags.maxPerSeed = Number(a.slice('--max-per-seed='.length));
}

// --- Helpers --------------------------------------------------------------

async function googleAutocomplete(query) {
  // Google's unauthenticated suggest endpoint. JSONP-y but accepts ?client=firefox
  // which returns plain JSON: [query, [suggestions...]]
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}&hl=en&gl=au`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; lucaseatsbig-trends-crawler/1.0)' },
    });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json) && Array.isArray(json[1]) ? json[1] : [];
  } catch {
    return [];
  }
}

function classify(query, knownCuisines, knownSuburbs) {
  const q = query.toLowerCase();
  // Suburb match wins first — "best italian surry hills" should be themed,
  // not pure suburb. Check pure suburb intent: "where to eat <suburb>" /
  // "best restaurants <suburb>" / "<suburb> restaurants" / "<suburb> food".
  for (const s of knownSuburbs) {
    const name = s.name.toLowerCase();
    const slug = s.slug.toLowerCase();
    if (
      (q.includes(`where to eat ${name}`) || q.includes(`where to eat ${slug}`) ||
       q.includes(`best restaurants ${name}`) || q.includes(`best restaurants ${slug}`) ||
       q.includes(`${name} restaurants`) || q.includes(`${slug} restaurants`) ||
       q.includes(`${name} food`) || q.includes(`${slug} food`)) &&
      !knownCuisines.some((c) => q.includes(c.toLowerCase()))
    ) {
      return { type: 'suburb', filter_value: s.slug };
    }
  }
  // Cuisine match: "best <cuisine> sydney" with no suburb in the phrase.
  for (const c of knownCuisines) {
    const cl = c.toLowerCase();
    if ((q.includes(`best ${cl} sydney`) || q.includes(`best ${cl} restaurants`) || q.match(new RegExp(`\\bbest ${cl}\\b`)))) {
      const hasSuburb = knownSuburbs.some((s) => q.includes(s.name.toLowerCase()) || q.includes(s.slug.toLowerCase()));
      if (!hasSuburb) return { type: 'cuisine', filter_value: c };
    }
  }
  // Otherwise themed — store the query as the slug-shaped filter.
  return {
    type: 'themed',
    filter_value: stableJson({ slug: slugify(query), query }),
  };
}

function coverageQuery(type, filterValue) {
  if (type === 'cuisine') {
    return `SELECT COUNT(DISTINCT res.id) AS n
              FROM restaurants res
              JOIN reviews rv ON rv.restaurant_id = res.id AND rv.status='published'
             WHERE LOWER(res.cuisine) = LOWER(${escSql(filterValue)})`;
  }
  if (type === 'suburb') {
    return `SELECT COUNT(DISTINCT res.id) AS n
              FROM restaurants res
              JOIN reviews rv ON rv.restaurant_id = res.id AND rv.status='published'
              JOIN locations loc ON loc.id = res.location_id AND loc.slug = ${escSql(filterValue)}`;
  }
  // themed: best-effort guess from the slug. Not perfect — the router will
  // do a more precise count when it routes the topic to the themed generator.
  return `SELECT 0 AS n`;
}

// --- Reference data -------------------------------------------------------

console.log('Loading reference cuisines + suburbs from remote...');

const cuisineList = queryRemote(`
  SELECT DISTINCT res.cuisine FROM restaurants res
  WHERE res.cuisine IS NOT NULL AND res.cuisine <> ''
`).map((r) => r.cuisine);

const suburbList = queryRemote(`SELECT slug, name FROM locations`).map((r) => ({ slug: r.slug, name: r.name }));

console.log(`  cuisines: ${cuisineList.length}`);
console.log(`  suburbs:  ${suburbList.length}`);

// --- Crawl ----------------------------------------------------------------

const discovered = new Map();   // query (lowercased) → {query, source}

for (const seed of SEEDS) {
  discovered.set(seed.toLowerCase(), { query: seed, source: 'manual' });
}

if (!flags.seedsOnly) {
  console.log(`\nFetching autocomplete for ${SEEDS.length} seeds...`);
  for (const seed of SEEDS) {
    const suggestions = await googleAutocomplete(seed);
    let added = 0;
    for (const s of suggestions.slice(0, flags.maxPerSeed)) {
      const key = s.toLowerCase().trim();
      if (!key || discovered.has(key)) continue;
      // Filter to Sydney-relevant queries — anything mentioning "sydney" or
      // a known suburb. Drops "best italian melbourne" type noise.
      const looksRelevant =
        key.includes('sydney') ||
        suburbList.some((sb) => key.includes(sb.name.toLowerCase()) || key.includes(sb.slug.toLowerCase()));
      if (!looksRelevant) continue;
      discovered.set(key, { query: s, source: 'autocomplete' });
      added++;
    }
    console.log(`  "${seed}" → +${added}`);
  }
}

console.log(`\nTotal queries discovered: ${discovered.size}`);

// --- Classify + coverage --------------------------------------------------

const upserts = [];
const paaEnabled = hasPaaProvider();
if (!paaEnabled) console.log('  (no SERPAPI_KEY/SCRAPERAPI_KEY — PAA fetching disabled, paa_json will be empty)');

for (const [, info] of discovered) {
  const c = classify(info.query, cuisineList, suburbList);

  // Coverage: count restaurants that would land in the source-set.
  let coverage = 0;
  try {
    const rows = queryRemote(coverageQuery(c.type, c.filter_value));
    coverage = rows[0]?.n ?? 0;
  } catch {
    coverage = 0;
  }

  // PAA: only fetch for high-coverage queries to keep cost down.
  let paa = [];
  if (paaEnabled && coverage >= 3) {
    paa = await fetchPAA(info.query);
  }

  upserts.push(
    `INSERT INTO topics (query, type, filter_value, coverage_count, paa_json, source, refreshed_at)
VALUES (${escSql(info.query)}, ${escSql(c.type)}, ${escSql(c.filter_value)}, ${coverage}, ${escSql(JSON.stringify(paa))}, ${escSql(info.source)}, unixepoch())
ON CONFLICT (query) DO UPDATE SET
  type = excluded.type,
  filter_value = excluded.filter_value,
  coverage_count = excluded.coverage_count,
  paa_json = CASE WHEN excluded.paa_json <> '[]' THEN excluded.paa_json ELSE topics.paa_json END,
  refreshed_at = excluded.refreshed_at;`
  );
}

console.log(`\nClassified ${upserts.length} topic(s).`);

// --- Output ---------------------------------------------------------------

if (flags.dryRun) {
  console.log('\n--- Sample classifications (first 10) ---');
  let i = 0;
  for (const [, info] of discovered) {
    if (i++ >= 10) break;
    const c = classify(info.query, cuisineList, suburbList);
    console.log(`  ${info.query.padEnd(40)} → ${c.type.padEnd(8)} [${typeof c.filter_value === 'string' ? c.filter_value : '<themed>'}]`);
  }
  console.log('\n[dry-run] no SQL written.');
} else {
  const header = `-- Generated by scripts/crawl-trends.mjs.
-- Apply with:
--   wrangler d1 execute lucaseats-db --remote --file=${OUTPUT_SQL}

`;
  writeFileSync(OUTPUT_SQL, header + upserts.join('\n\n') + '\n');
  console.log(`\nWrote ${upserts.length} topic UPSERT(s) to ${OUTPUT_SQL}`);
  console.log(`\nNext: apply to remote with`);
  console.log(`  npx wrangler d1 execute lucaseats-db --remote --file=${OUTPUT_SQL}`);
  console.log(`\nThen run the router:`);
  console.log(`  node scripts/generate.mjs --limit=3 --min-coverage=3`);
}
