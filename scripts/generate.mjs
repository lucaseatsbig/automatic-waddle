#!/usr/bin/env node
// Topics-queue router. Reads queued topics from D1, picks the highest-priority
// ones with enough coverage, and dispatches each to the right generator
// (cuisine / suburb / themed). Always semi-autonomous — drafts only by
// default, you spot-check before publishing.
//
// Usage:
//   node scripts/generate.mjs --limit=3                  # generate 3 topics, drafts
//   node scripts/generate.mjs --limit=3 --publish        # mark new posts published immediately
//   node scripts/generate.mjs --type=cuisine --limit=5   # only cuisine topics
//   node scripts/generate.mjs --min-coverage=4           # require ≥4 restaurants in source-set
//   node scripts/generate.mjs --dry-run                  # show plan, don't run anything
//
// Topic priority order: monthly_volume DESC (NULLs last), coverage_count DESC.
// Topics are marked status='generating' before the generator runs and flipped
// to 'generated' on success. Failures revert to 'queued' so the next run
// retries them.

import { spawnSync } from 'node:child_process';
import { queryRemote, execRemote } from './lib/wrangler.mjs';

const args = process.argv.slice(2);
const flags = {
  limit: 3,
  type: null,                 // 'cuisine' | 'suburb' | 'themed' | null (any)
  minCoverage: 3,
  publish: false,
  dryRun: false,
  skipVoiceCheck: false,
};
for (const a of args) {
  if (a === '--publish') flags.publish = true;
  else if (a === '--dry-run') flags.dryRun = true;
  else if (a === '--skip-voice-check') flags.skipVoiceCheck = true;
  else if (a.startsWith('--limit=')) flags.limit = Number(a.slice('--limit='.length));
  else if (a.startsWith('--type=')) flags.type = a.slice('--type='.length);
  else if (a.startsWith('--min-coverage=')) flags.minCoverage = Number(a.slice('--min-coverage='.length));
  else {
    console.error(`Unknown flag: ${a}`);
    process.exit(1);
  }
}

console.log('Topics-queue router');
console.log(`  limit:        ${flags.limit}`);
console.log(`  type filter:  ${flags.type ?? '(any)'}`);
console.log(`  min coverage: ${flags.minCoverage}`);
console.log(`  publish:      ${flags.publish}`);
console.log();

// --- Pick topics ----------------------------------------------------------

const typeWhere = flags.type ? `AND type = '${flags.type.replace(/'/g, "''")}'` : '';

const queued = queryRemote(`
  SELECT id, query, type, filter_value, coverage_count, monthly_volume, paa_json
    FROM topics
   WHERE status = 'queued'
     AND coverage_count >= ${flags.minCoverage}
     ${typeWhere}
   ORDER BY (monthly_volume IS NULL), monthly_volume DESC, coverage_count DESC
   LIMIT ${flags.limit}
`);

if (queued.length === 0) {
  console.log('No queued topics meet the criteria. Things to try:');
  console.log('  - Lower --min-coverage (current minimum has too few matches)');
  console.log('  - Run scripts/crawl-trends.mjs first to populate the queue');
  console.log('  - Add more restaurant reviews to grow coverage_count');
  process.exit(0);
}

console.log(`Picked ${queued.length} topic(s):`);
for (const t of queued) {
  console.log(`  [${t.id}] (${t.type}) "${t.query}" — coverage ${t.coverage_count}${t.monthly_volume ? `, volume ${t.monthly_volume}` : ''}`);
}
console.log();

if (flags.dryRun) {
  console.log('[dry-run] not generating anything.');
  process.exit(0);
}

// --- Dispatch -------------------------------------------------------------

function generatorArgs(topic) {
  const baseFlags = ['--topic-id=' + topic.id];
  if (flags.publish) baseFlags.push('--publish');
  if (flags.skipVoiceCheck) baseFlags.push('--skip-voice-check');
  if (topic.paa_json && topic.paa_json !== '[]') {
    baseFlags.push(`--paa=${topic.paa_json}`);
  }

  if (topic.type === 'cuisine') {
    return {
      script: 'scripts/generate-cuisine-guides.mjs',
      args: [...baseFlags, `--cuisine=${topic.filter_value}`, '--limit=1'],
    };
  }
  if (topic.type === 'suburb') {
    return {
      script: 'scripts/generate-suburb-guides.mjs',
      args: [...baseFlags, `--suburb=${topic.filter_value}`, '--limit=1'],
    };
  }
  if (topic.type === 'themed') {
    let parsed;
    try {
      parsed = JSON.parse(topic.filter_value);
    } catch {
      throw new Error(`themed filter_value not JSON: ${topic.filter_value}`);
    }
    const themed = [...baseFlags];
    themed.push(`--slug=${parsed.slug}`);
    themed.push(`--title-hint=${parsed.query ?? topic.query}`);
    if (parsed.tags?.length) themed.push(`--tags=${parsed.tags.join(',')}`);
    if (parsed.meal) themed.push(`--meal=${parsed.meal}`);
    if (parsed.region) themed.push(`--region=${parsed.region}`);
    if (parsed.suburb) themed.push(`--suburb=${parsed.suburb}`);
    if (parsed.cuisine) themed.push(`--cuisine=${parsed.cuisine}`);
    return { script: 'scripts/generate-themed-guides.mjs', args: themed };
  }
  throw new Error(`Unknown topic type: ${topic.type}`);
}

let succeeded = 0, failed = 0;

for (const topic of queued) {
  console.log(`\n--- Topic ${topic.id}: ${topic.query} (${topic.type}) ---`);

  // Mark as generating so a parallel run wouldn't double-pick.
  execRemote(`UPDATE topics SET status='generating' WHERE id=${topic.id}`);

  let plan;
  try {
    plan = generatorArgs(topic);
  } catch (err) {
    console.error(`  ✗ Could not build args: ${err.message}`);
    execRemote(`UPDATE topics SET status='skipped', notes=${escSqlForRemote(err.message)} WHERE id=${topic.id}`);
    failed++;
    continue;
  }

  console.log(`  → node ${plan.script} ${plan.args.join(' ')}`);

  const child = spawnSync('node', [plan.script, ...plan.args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (child.status === 0) {
    // The generator wrote its own .sql file. We don't apply it here — the
    // user reviews per-script output before applying. The generator already
    // queued an UPDATE topics row inside its SQL, so applying that file
    // flips the topic to 'generated' atomically with the post creation.
    console.log(`  ✓ generator complete — review the .sql file before applying`);
    succeeded++;
  } else {
    console.error(`  ✗ generator exited ${child.status} — reverting topic to queued`);
    execRemote(`UPDATE topics SET status='queued' WHERE id=${topic.id}`);
    failed++;
  }
}

console.log(`\n--- Router summary ---`);
console.log(`Succeeded: ${succeeded}, Failed: ${failed}`);
console.log(`\nThe generators have each written their own .sql files (one per type).`);
console.log(`Review them, then apply with:`);
console.log(`  npx wrangler d1 execute lucaseats-db --local --file=scripts/generate-cuisine-guides.sql`);
console.log(`  npx wrangler d1 execute lucaseats-db --local --file=scripts/generate-suburb-guides.sql`);
console.log(`  npx wrangler d1 execute lucaseats-db --local --file=scripts/generate-themed-guides.sql`);
console.log(`Spot-check at http://localhost:4321/guides, then re-apply with --remote.`);

function escSqlForRemote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}
