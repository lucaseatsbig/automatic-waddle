# SEO content bot — plan & handoff

> **Status (2026-05-04):** All scaffolding complete. Cuisine, suburb, and themed generators are live. Trends crawler, topics queue, router, voice-check, related-posts graph, and FAQ/Article JSON-LD all wired up. **Nothing has been generated yet** — gated on (1) the Anthropic API key, (2) applying the new migrations to remote D1, and (3) the data audit.

---

## What we're building

A semi-autonomous bot that writes long-form, SEO-optimised guides for [lucaseatsbig.com](https://lucaseatsbig.com), grounded in Lucas's real visited-restaurant data. The goal is organic search traffic on Sydney food queries — without sacrificing voice or honesty.

**Hard constraint that drives every design choice:** the bot must never invent restaurants, ratings, dishes, or opinions. Every factual claim has to trace back to a row in the D1 database. We use external trends to **prioritise topics**, but the body of the post is always grounded in Lucas's data.

---

## Operating loop (semi-autonomous, fully built)

```
crawl-trends.mjs ─► topics queue ─► generate.mjs ─► generators ─► .sql files
                                                                       │
                                                                       ▼
                                              Lucas spot-checks markdown
                                                                       │
                                                                       ▼
                                                  apply locally → preview
                                                                       │
                                                                       ▼
                                                  apply remote → deploy
```

You don't chat with the bot. You invoke a script, it writes a `.sql` file, you spot-check, you ship. The router (`generate.mjs`) orchestrates the picking + dispatching; individual generators do the writing; the voice-check (Haiku) auto-rejects drafts that drift from voice.

---

## Pieces (all built)

### Generators (the things that actually call Claude)

| Script | Purpose | Filter |
|---|---|---|
| [scripts/generate-cuisine-guides.mjs](scripts/generate-cuisine-guides.mjs) | "Best Italian Sydney" | `restaurants.cuisine = ?` |
| [scripts/generate-suburb-guides.mjs](scripts/generate-suburb-guides.mjs) | "Best Restaurants in Surry Hills" | `locations.slug = ?` |
| [scripts/generate-themed-guides.mjs](scripts/generate-themed-guides.mjs) | "Date Night Sydney", "Best Dumplings CBD" | tag(s) + meal + region + suburb + cuisine combos |

All three:
- Pull source-set straight from D1 (commentary, standout dishes, tags, ratings)
- Validate every restaurant ID Claude returns is in the source set
- Run a **voice-check pass** (Haiku) before writing SQL — auto-rejects drafts with banned phrases
- Write **related-posts UPSERTs** alongside the post (cross-link graph)
- Emit drafts by default; `--publish` is opt-in
- Accept `--paa='[...]'` so PAA suggestions feed into the system prompt and become a `## Frequently asked` section

### Audit (zero API calls)

[scripts/audit-review-quality.mjs](scripts/audit-review-quality.mjs)

- Reports per-restaurant 🟢/🟡/🔴 readiness based on commentary words + standout dishes
- Groups by cuisine, suburb, **tag**, and **meal_type** so you can see eligibility for any guide type before generating
- `--csv` mode for spreadsheets

### Trends discovery

[scripts/crawl-trends.mjs](scripts/crawl-trends.mjs)

- Pulls Google autocomplete (free, no auth) for ~22 seed queries (edit `SEEDS` in the file to add your own)
- Classifies each discovered query as `cuisine` / `suburb` / `themed` automatically
- Computes `coverage_count` per query (how many of your restaurants would be in the source-set)
- Optional: fetches People Also Ask questions if `SERPAPI_KEY` or `SCRAPERAPI_KEY` is set in `.dev.vars`
- Writes UPSERTs to `scripts/crawl-trends.sql` for the `topics` table

### Router

[scripts/generate.mjs](scripts/generate.mjs)

- Reads queued topics from D1, ordered by `monthly_volume DESC` then `coverage_count DESC`
- Filters by minimum coverage so we don't try to write guides without data
- Dispatches each topic to the right generator with `--topic-id=N` so the post creation atomically updates the topics row
- Hands back to you for spot-check + apply (semi-autonomous — your call)

### Shared libraries (extracted to keep generators consistent)

| Module | Purpose |
|---|---|
| [scripts/lib/wrangler.mjs](scripts/lib/wrangler.mjs) | Thin wrappers around `wrangler d1 execute` (queryRemote / queryLocal / execRemote) |
| [scripts/lib/anthropic.mjs](scripts/lib/anthropic.mjs) | API key load + client factory; model constants |
| [scripts/lib/util.mjs](scripts/lib/util.mjs) | escSql, slugify, stableJson, cost estimator |
| [scripts/lib/voice-check.mjs](scripts/lib/voice-check.mjs) | Haiku voice check + local banned-phrase pre-filter |
| [scripts/lib/paa.mjs](scripts/lib/paa.mjs) | People Also Ask fetcher (SerpAPI / ScraperAPI / no-op) |
| [scripts/lib/post-upsert.mjs](scripts/lib/post-upsert.mjs) | Shared `posts` UPSERT generator |
| [scripts/lib/related-posts.mjs](scripts/lib/related-posts.mjs) | Computes related_posts edges based on featured-restaurant overlap |

### Database

| Migration | Purpose |
|---|---|
| [migrations/0007_posts.sql](migrations/0007_posts.sql) | `posts` table (already applied locally; **NOT YET** on remote) |
| [migrations/0008_topics.sql](migrations/0008_topics.sql) | `topics` queue (NEW — apply to local + remote) |
| [migrations/0009_related_posts.sql](migrations/0009_related_posts.sql) | Cross-link graph (NEW — apply to local + remote) |

### Frontend (already wired to render new content)

| File | Adds |
|---|---|
| [src/lib/posts.ts](src/lib/posts.ts) | `getRelatedPosts(db, slug)` |
| [src/components/RelatedGuides.astro](src/components/RelatedGuides.astro) | "See also" panel rendered at the bottom of each guide |
| [src/pages/guides/[slug].astro](src/pages/guides/[slug].astro) | Renders RelatedGuides + emits **FAQPage** + **Article** JSON-LD (with dateModified for freshness) |

The detail page already renders any `kind` (cuisine / suburb / themed) without needing per-type code. Sitemap (`/sitemap-guides.xml`) picks up new posts automatically.

---

## What you need to do (before any content gets generated)

### 1. Apply the new migrations

```sh
npx wrangler d1 migrations apply lucaseats-db --local
npx wrangler d1 migrations apply lucaseats-db --remote
```

Adds the `topics` and `related_posts` tables.

### 2. Add your Anthropic API key

```
# in .dev.vars
ANTHROPIC_API_KEY=sk-ant-...
```

Optional, for PAA enrichment:
```
SERPAPI_KEY=...        # ~$50/mo for 5000 searches
# or
SCRAPERAPI_KEY=...     # ~$5/mo, less reliable
```

### 3. Run the audit — see what data you have

```sh
node scripts/audit-review-quality.mjs --by-cuisine --by-suburb --by-tag --by-meal
```

This tells you which cuisines/suburbs/tags already have ≥3 🟢 restaurants. Anywhere with `✗ no — need N more` is a gap to fill via [/admin/entry/](/admin/entry/) before generating.

### 4. Crawl trends to populate the queue

```sh
node scripts/crawl-trends.mjs --dry-run    # preview classifications
node scripts/crawl-trends.mjs              # write SQL
npx wrangler d1 execute lucaseats-db --remote --file=scripts/crawl-trends.sql
```

### 5. Generate your first guide

Either pick a topic manually:
```sh
node scripts/generate-cuisine-guides.mjs --cuisine=Italian --dry-run
node scripts/generate-cuisine-guides.mjs --cuisine=Italian
```

Or let the router pick from the queue:
```sh
node scripts/generate.mjs --limit=1 --dry-run    # show what it'd do
node scripts/generate.mjs --limit=1
```

### 6. Review + apply + deploy

```sh
# Preview
npx wrangler d1 execute lucaseats-db --local --file=scripts/generate-cuisine-guides.sql
npm run dev   # then http://localhost:4321/guides

# Ship
npx wrangler d1 execute lucaseats-db --remote --file=scripts/generate-cuisine-guides.sql

# Optional: publish drafts in one go
npx wrangler d1 execute lucaseats-db --remote --command \
  "UPDATE posts SET status='published', published_at=unixepoch() WHERE source_filter='Italian'"

npm run deploy
```

---

## Cost model

Claude Opus 4.7 with prompt caching on, plus Haiku voice check:

| Scenario | Cost |
|---|---|
| First run of a guide (Opus + Haiku check) | ~$0.20–$0.30 |
| Regenerations (cached system prompt) | ~$0.05–$0.10 |
| Voice check alone (Haiku) | ~$0.001 |
| Trends crawler (autocomplete only) | free |
| Trends crawler (with SerpAPI for PAA) | ~$0.005/query |

**Realistic monthly spend** at 4 new guides + 2 regens/week: **$5–$10**.

To cut it further: edit `scripts/lib/anthropic.mjs` to swap in `claude-sonnet-4-6` (~$0.05/guide) for the body generation. Voice check stays on Haiku.

---

## Data thresholds (per restaurant)

🟢 **Bot-ready:** ≥60 commentary words AND ≥2 standout dishes
🟡 **Thin:** ≥30 words OR ≥1 standout
🔴 **Skip:** below both

For a guide to make sense:
- **Min 3 🟢 restaurants** in the source-set (set via `--min=N`, default 3)
- **Ideal 5–7** so the ranking has weight
- **Site-wide for compounding traffic**: 80–100 visited places

---

## Quality guardrails (non-negotiable)

1. Every fact traceable to a row in D1 — no fabrication
2. Auto-reject if Claude returns a `restaurant_id` not in the source-set
3. **Voice check (Haiku)** — auto-fails on banned phrases ("hidden gem", "must-try", "foodie", etc.). Edit the list in [scripts/lib/voice-check.mjs](scripts/lib/voice-check.mjs).
4. Word count cap: 1200–1800 words per guide
5. No fabricated quotes from Lucas
6. Order by Lucas's rating, highest first; ties broken by recency
7. **Drafts by default** — `--publish` is opt-in
8. Topics with `coverage_count < min-coverage` skipped by the router

---

## SEO baked in

- **Title** with primary keyword, ≤60 chars
- **Meta description** with keyword in first 120 chars, ≤160 total
- **URL slug** is keyword-shaped
- **H1** uses the primary keyword once
- **H2 per restaurant** — natural keyword density
- **Internal link** on every restaurant first mention
- **`## Frequently asked` section** when PAA data is provided
- **JSON-LD ItemList** (rankings) + **FAQPage** (rich-result questions) + **Article** (with `dateModified` for freshness)
- **OG image** routed through `/api/og/[slug].jpg`
- **Sitemap** at `/sitemap-guides.xml`
- **Cross-links** between guides via `related_posts` table → "See also" panel on each guide page

---

## File map

```
migrations/
  0007_posts.sql             posts table (existing)
  0008_topics.sql            topics queue (NEW)
  0009_related_posts.sql     cross-link graph (NEW)

scripts/
  audit-review-quality.mjs   data-readiness audit
  crawl-trends.mjs           trends → topics queue
  generate.mjs               router (reads queue, dispatches)
  generate-cuisine-guides.mjs
  generate-suburb-guides.mjs
  generate-themed-guides.mjs
  lib/
    anthropic.mjs
    paa.mjs
    post-upsert.mjs
    related-posts.mjs
    util.mjs
    voice-check.mjs
    wrangler.mjs

src/
  lib/posts.ts               + getRelatedPosts()
  components/RelatedGuides.astro      (NEW)
  pages/guides/[slug].astro  + RelatedGuides + FAQPage/Article JSON-LD
```

Output files (regenerated each run, gitignored):
```
scripts/generate-cuisine-guides.sql
scripts/generate-suburb-guides.sql
scripts/generate-themed-guides.sql
scripts/crawl-trends.sql
```

---

## Decisions / things to revisit later

- **Drafts by default** — keep until voice-check has 20+ pass-without-edit runs.
- **PAA without paid API** — currently no-op. Manual override via `--paa='["Q1?","Q2?"]'` works. Wire SerpAPI when budget allows.
- **DataForSEO volume** — not implemented; topics get NULL `monthly_volume`. Router falls back to `coverage_count` ordering. Add when you want a real volume signal.
- **Region resolution** — themed generator's `--region=` does substring match on suburb slug. Fine for "eastern-suburbs" naming convention. Replace with a `regions → suburbs` lookup table when you formalise regions.
- **Voice drift** — banned-phrase list is in [scripts/lib/voice-check.mjs](scripts/lib/voice-check.mjs). Add to it as you spot patterns in early outputs.
- **Cron** — router can be wrapped in a shell script + cron job. Not done yet because semi-autonomous review is the right default for the first ~20 posts.

---

## What's NOT done (intentionally — out of scope until you've shipped a few real posts)

- Cron / scheduling — you trigger runs manually for now
- DataForSEO volume enrichment
- A "regenerate all top performers quarterly" pass
- Automatic publish-on-pass (you flip `--publish` once you trust it)
- A web UI for browsing the topics queue (CLI only)
- Image-alt-text generation for guide hero images
