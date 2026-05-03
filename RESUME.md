# Resume — SEO content bot scaffolding (2026-05-02)

> **Status:** scaffolding complete. Nothing deployed. Local D1 has the schema; remote D1 does not. No content has been generated yet — that's gated on your API key.

Search Console verification token (kept here for reference):
`google-site-verification=x3oyO4f7fopeK2kN1gE06ZG7iUtV0zuFj3H20Dlkd4U`

---

## What's done (autonomous — no API calls made)

**Schema**
- New migration [migrations/0007_posts.sql](migrations/0007_posts.sql) adds a `posts` table for AI-generated long-form content (cuisine listicles, future suburb guides + recaps).
- Applied to **local** D1 only. Remote needs `npx wrangler d1 migrations apply lucaseats-db --remote` when you're ready.

**Routes (server-rendered, live as soon as the table has rows)**
- [src/pages/guides/index.astro](src/pages/guides/index.astro) — list of all published guides at `/guides`.
- [src/pages/guides/[slug].astro](src/pages/guides/[slug].astro) — individual guide. Renders markdown body via `marked`, includes JSON-LD `ItemList`, OG image routed through the existing `/api/og/[slug].jpg` endpoint.
- [src/pages/sitemap-guides.xml.ts](src/pages/sitemap-guides.xml.ts) — runtime sitemap, same shape as `sitemap-restaurants.xml`.
- [public/robots.txt](public/robots.txt) updated to reference the new sitemap.

**Library code**
- [src/lib/posts.ts](src/lib/posts.ts) — `listPublishedPosts`, `getPostBySlug`, `getFeaturedRestaurantsForPost`, `getCuisineSourceSet`. Read-only — writes happen offline via the generator script.
- [src/env.d.ts](src/env.d.ts) gains optional `ANTHROPIC_API_KEY`.
- [.dev.vars.example](.dev.vars.example) documents the var.

**Content generator**
- [scripts/generate-cuisine-guides.mjs](scripts/generate-cuisine-guides.mjs) — the bot. Queries remote D1 for visited restaurants by cuisine, calls Claude Opus 4.7 with a stable cached system prompt, gets back structured JSON, writes UPSERT SQL to `scripts/generate-cuisine-guides.sql`. Idempotent (UPSERT on `(kind, source_filter)`).
- Uses adaptive thinking + `effort: high` + prompt caching on the system prompt → repeat runs cost ~10% of the first run.
- Validates that every restaurant ID Claude returns actually exists in the source set (no hallucination).
- Posts default to `status='draft'` — they don't appear on `/guides` until you flip them or pass `--publish`.

**Dependencies installed**
- `@anthropic-ai/sdk` (the bot)
- `marked` (markdown rendering on the detail page)

**Build**
- `npx astro build` passes clean.

---

## What you need to do

### 1. Add your Anthropic API key

```
# in .dev.vars
ANTHROPIC_API_KEY=sk-ant-...
```

Get one at [console.anthropic.com](https://console.anthropic.com). Costs ~$0.10 per cuisine guide (~$2 for the full first run of ~20 cuisines), more like $0.01 each on regen runs thanks to prompt caching.

### 2. Apply the migration to remote D1

```sh
npx wrangler d1 migrations apply lucaseats-db --remote
```

This creates the `posts` table on the production D1. Safe — additive only.

### 3. Try it on one cuisine first

```sh
node scripts/generate-cuisine-guides.mjs --cuisine=Italian --dry-run
```

`--dry-run` validates the source-set query without calling the API. Confirms wrangler auth works and the data shape is right.

Then run for real on a single cuisine:

```sh
node scripts/generate-cuisine-guides.mjs --cuisine=Italian
```

Reads the SQL it produced — `scripts/generate-cuisine-guides.sql`. **Spot-check the markdown.** Apply locally to preview:

```sh
npx wrangler d1 execute lucaseats-db --local --file=scripts/generate-cuisine-guides.sql
npx astro dev   # then open http://localhost:4321/guides
```

If it looks good, apply to remote and deploy:

```sh
npx wrangler d1 execute lucaseats-db --remote --file=scripts/generate-cuisine-guides.sql
# Optional: publish drafts in one go (otherwise the post is invisible on /guides)
npx wrangler d1 execute lucaseats-db --remote --command "UPDATE posts SET status='published', published_at=unixepoch() WHERE source_filter='Italian'"
npm run deploy
```

### 4. Generate the rest

```sh
node scripts/generate-cuisine-guides.mjs --limit=5      # batch in 5s if you want to spot-check progressively
node scripts/generate-cuisine-guides.mjs --publish      # mark them live on creation (skips the manual UPDATE step)
node scripts/generate-cuisine-guides.mjs --min=4        # only cuisines with ≥4 restaurants (default 3)
```

`--cuisine=X` is exact-match (case-insensitive). Run `npx wrangler d1 execute lucaseats-db --remote --command "SELECT cuisine, COUNT(*) n FROM restaurants r JOIN reviews rv ON rv.restaurant_id=r.id AND rv.status='published' WHERE cuisine IS NOT NULL GROUP BY cuisine HAVING n>=3 ORDER BY n DESC"` to see the eligible list.

### 5. Submit the new sitemap to Search Console

Search Console → Sitemaps → Add `sitemap-guides.xml` (the input field already has the `https://lucaseatsbig.com/` prefix).

---

## Caveats / things I made decisions on

- **Slug shape**: the bot generates `best-<cuisine>-sydney`. If it drifts (e.g. weird unicode), the script normalizes to a safe kebab-case slug.
- **Internal linking**: Claude is instructed to write `[Name](/restaurants/{slug})` in the markdown — standard internal links, parsed by `marked` into `<a>` tags. This is the SEO win.
- **Featured-card rendering**: the detail page renders all featured restaurants as compact cards under the markdown body (cross-link real estate). The order matches the order they're mentioned in the article.
- **OG image**: each guide's social card uses the top-ranked restaurant's photo, transformed via the existing `/api/og/[slug].jpg` endpoint (1200×630).
- **Drafts by default**: I deliberately default to `--draft`. Generated posts aren't visible until you publish — so you always get a chance to review.
- **Cost ceiling**: pass `--limit=N` for the first run to bound spend if you want.
- **Rate limit**: SDK retries 429s automatically. If a single cuisine fails, others still write to the SQL file — no all-or-nothing.

---

## What I didn't do (intentionally)

- **Did not deploy.** No `npm run deploy`.
- **Did not apply migration to remote.** Only local.
- **Did not call the Anthropic API.** No content generated.
- **Did not run the script even in dry-run.** Would have hit your remote D1 with your wrangler auth — felt like the safer call to leave to you.

---

## Older notes (kept)

- "Lucas's" → "Lucas" — was probably already done; verify in the rendered home/about pages.
- "Visit website" + "Open in Maps" buttons in the review section — already shipped.
