# Bot runbook — quick command reference

> Pure recipes. Open [SEO_BOT_PLAN.md](SEO_BOT_PLAN.md) for the why behind any of this.

## One-time setup

```sh
# Anthropic key in .dev.vars (already done if you've generated anything)
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .dev.vars

# Migrations applied to local + remote
npx wrangler d1 migrations apply lucaseats-db --local
npx wrangler d1 migrations apply lucaseats-db --remote
```

---

## Recipe A — "I added new reviews; what should I do?"

```sh
# 1. See where your data stands
node scripts/audit-review-quality.mjs --by-cuisine --by-suburb --by-tag --by-meal

# 2. Refresh the topics queue (recomputes coverage_count)
node scripts/crawl-trends.mjs
npx wrangler d1 execute lucaseats-db --remote --file=scripts/crawl-trends.sql

# 3. Generate the next 1-3 guides the router thinks are highest priority
node scripts/generate.mjs --limit=1 --dry-run    # shows what it'd pick
node scripts/generate.mjs --limit=1              # actually generates

# 4. Spot-check the markdown locally
npx wrangler d1 execute lucaseats-db --local --file=scripts/generate-cuisine-guides.sql
npx wrangler d1 execute lucaseats-db --local --file=scripts/generate-suburb-guides.sql
npx wrangler d1 execute lucaseats-db --local --file=scripts/generate-themed-guides.sql
npm run dev    # then http://localhost:4321/guides

# 5. Ship to remote + deploy
npx wrangler d1 execute lucaseats-db --remote --file=scripts/generate-cuisine-guides.sql
# (repeat for suburb / themed if those .sql files were written)

# 6. Publish drafts (skip if you ran the generator with --publish)
npx wrangler d1 execute lucaseats-db --remote --command \
  "UPDATE posts SET status='published', published_at=unixepoch() WHERE status='draft' AND published_at IS NULL"

npm run deploy
```

---

## Recipe B — "Generate a specific guide on demand"

### Cuisine
```sh
node scripts/generate-cuisine-guides.mjs --cuisine=Italian --dry-run
node scripts/generate-cuisine-guides.mjs --cuisine=Italian
# review scripts/generate-cuisine-guides.sql, then apply (see Recipe A step 4-5)
```

### Suburb (use the slug, not the name)
```sh
node scripts/generate-suburb-guides.mjs --suburb=surry-hills --dry-run
node scripts/generate-suburb-guides.mjs --suburb=surry-hills
```

### Themed (any combo of filters)
```sh
# Date night
node scripts/generate-themed-guides.mjs \
  --slug=date-night-sydney \
  --title-hint="Date Night Sydney" \
  --tags=date-night

# Best dumplings in CBD
node scripts/generate-themed-guides.mjs \
  --slug=best-dumplings-sydney-cbd \
  --title-hint="Best Dumplings in Sydney CBD" \
  --cuisine=Chinese --suburb=sydney-cbd

# Brunch in the east
node scripts/generate-themed-guides.mjs \
  --slug=brunch-eastern-suburbs \
  --title-hint="Best Brunch in Sydney's East" \
  --meal=brunch --region=eastern
```

---

## Recipe C — "Regenerate a guide for freshness"

```sh
# Just re-run the same command — generators UPSERT by (kind, source_filter)
# so the URL stays the same, body refreshes, generated_at bumps.
node scripts/generate-cuisine-guides.mjs --cuisine=Italian
npx wrangler d1 execute lucaseats-db --remote --file=scripts/generate-cuisine-guides.sql
npm run deploy
```

---

## Recipe D — "Publish a draft I'd left as draft"

```sh
# All drafts at once
npx wrangler d1 execute lucaseats-db --remote --command \
  "UPDATE posts SET status='published', published_at=unixepoch() WHERE status='draft'"

# One specific post
npx wrangler d1 execute lucaseats-db --remote --command \
  "UPDATE posts SET status='published', published_at=unixepoch() WHERE slug='best-italian-sydney'"

npm run deploy
```

---

## Recipe E — "Unpublish a guide"

```sh
npx wrangler d1 execute lucaseats-db --remote --command \
  "UPDATE posts SET status='draft' WHERE slug='best-italian-sydney'"
npm run deploy
```

---

## Recipe F — "What's in the topics queue?"

```sh
# Top 20 queued topics ordered by router priority
npx wrangler d1 execute lucaseats-db --remote --command \
  "SELECT id, query, type, coverage_count, monthly_volume, status FROM topics WHERE status='queued' ORDER BY (monthly_volume IS NULL), monthly_volume DESC, coverage_count DESC LIMIT 20"

# Topics blocked on coverage (need more restaurant data)
npx wrangler d1 execute lucaseats-db --remote --command \
  "SELECT query, type, coverage_count FROM topics WHERE status='queued' AND coverage_count < 3 ORDER BY coverage_count DESC LIMIT 20"

# Manually skip a topic you don't want
npx wrangler d1 execute lucaseats-db --remote --command \
  "UPDATE topics SET status='skipped', notes='not relevant' WHERE id=42"
```

---

## Common flags (work on most generators)

| Flag | Effect |
|---|---|
| `--dry-run` | Log only, no API call, no SQL written |
| `--publish` | Mark new posts published immediately (skip the manual UPDATE) |
| `--skip-voice-check` | Bypass the Haiku voice-check pass |
| `--limit=N` | Generate at most N guides this run |
| `--min=N` | Require at least N restaurants in source-set (default 3) |

---

## Troubleshooting

### "No cuisine X with ≥3 entries on remote"
→ Cuisine doesn't have enough visited+published restaurants. Run the audit (`--by-cuisine`) to see what's eligible.

### "Voice check FAILED — skipping post"
→ Generated copy hit a banned phrase. Either (a) re-run (Claude is non-deterministic, often passes second time), or (b) add `--skip-voice-check` if you want to ship anyway, or (c) tighten the prompt and re-run.

### "og_image_restaurant_id ... not in source set"
→ Rare — Claude returned an ID outside the data we passed it. Just re-run.

### "Could not parse Claude response as JSON"
→ Usually a fence `\`\`\`json ... \`\`\`` issue handled automatically. If it persists, the response was truncated — bump `max_tokens` in the generator file.

### Want to inspect what the generator is sending Claude?
→ Run with `--dry-run`. It logs the system + user message lengths and the first restaurant in the source set without calling the API.

---

## What the audit colours mean

Run: `node scripts/audit-review-quality.mjs`

- 🟢 **green** — bot-ready: ≥60 commentary words AND ≥2 standout dishes
- 🟡 **yellow** — thin: ≥30 words OR ≥1 standout. Will produce a thin paragraph.
- 🔴 **red** — skip: not enough material; bot would have to invent

A guide needs **at least 3 🟢 restaurants** in its source-set to be worth generating. Borderline (≥3 yellow) works but reads weaker.

---

## Cost expectations

- **First-run guide**: ~$0.20–$0.30 (Opus + Haiku check)
- **Regenerated guide**: ~$0.05–$0.10 (cached system prompt)
- **Voice check alone**: ~$0.001
- **Trends crawler**: free (autocomplete only) or ~$0.005/query (with SerpAPI)

Set a monthly budget cap in [console.anthropic.com](https://console.anthropic.com) → Settings → Limits if you want hard guardrails.
