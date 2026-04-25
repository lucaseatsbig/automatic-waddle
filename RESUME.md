# lucaseats — resume notes

Last update: 2026-04-25

## What we're building

**lucaseats** — your personal food-review site. Public site at `/` (filterable list of restaurants), password-gated admin at `/admin`. Stack: Astro 6 (server output) + Cloudflare Workers, D1 (`DB`), R2 (`PHOTOS`), KV sessions. Single-author admin, public read.

## Current progress

**Done**
- ✅ **Unified entry form** at `/admin/entry/new` ([UnifiedEntryForm.astro](src/components/admin/UnifiedEntryForm.astro)) — restaurant + review + photos in one submission. After save redirects to `/admin`.
- ✅ **Google Places autocomplete** on the Name field. Picking a result fills name, address, website, suburb, plus stores `place_id`, `lat`, `lng` and a canonical Google Maps deep link (`maps_url`).
- ✅ **In-form photo picker** — local thumbnails, client-side JPEG resize on submit, batched into the multipart POST. First photo auto-becomes the cover.
- ✅ **Visit date is optional** — stored as NULL when blank. Reviews with no date show as "Undated".
- ✅ **Maps URL replaces Menu URL** in the UI (column kept in DB for safety).
- ✅ **Admin dashboard** ([admin/index.astro](src/pages/admin/index.astro)) is now a responsive card grid (~4 cols desktop) with client-side filters: search, All/Visited/Wishlist, cuisine, suburb. Whole card is clickable.
- ✅ **Old multi-step pages deleted** — `admin/restaurants/new`, `admin/restaurants/[id]/reviews/new`, plus their POST endpoints. The `+ New review` button on a restaurant page now links to the unified form with `?name=` prefill.
- ✅ **Notion import** — 232 restaurants + 120 reviews imported from `scripts/notion-export.csv.csv` via [scripts/import-notion.mjs](scripts/import-notion.mjs) → [scripts/notion-import.sql](scripts/notion-import.sql). Both local and remote DBs populated.
- ✅ **DB migrations 0001–0004** applied locally and remotely.
- ✅ **Backup workflow file** at [.github/workflows/backup-d1.yml](.github/workflows/backup-d1.yml) — runs Sundays 16:00 UTC, prunes dumps >12 weeks, commits to `backups/` on main.
- ✅ **`.dev.vars` added to .gitignore** so local secrets aren't accidentally pushed.

**In flight / not yet wired**
- ⚠️ **Code not yet deployed** to prod — remote DB has new schema, deployed Worker still runs old code. Need `npm run deploy`.
- ⚠️ **2 demo seed rows still in remote DB** (`chaco-bar`, `saint-peter`) — counted 234 instead of 232.
- ⚠️ **Google Maps API key not set on prod** — `wrangler secret put GOOGLE_MAPS_API_KEY` not run yet.
- ⚠️ **Backup workflow secrets not set** on GitHub — no `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` yet.
- ⚠️ **First push to GitHub not done** — `git log` shows no commits, even though origin is set.

## Key decisions (and why)

- **One-form save flow** redirects to `/admin` instead of the review edit page. *Why:* you wanted visible confirmation that the entry saved by seeing it in the list.
- **Photos sent in the same multipart POST** rather than uploaded incrementally to a staging bucket. *Why:* simpler mental model; an 8-photo upload at ~300 KB each is well within Worker request limits.
- **`visit_date` and `rating_overall` nullable** for reviews. *Why:* importing past entries from Notion where dates/ratings often weren't recorded.
- **`maps_url` added; `menu_url` left in the DB** but removed from UI. *Why:* non-destructive — easy to recover if you change your mind.
- **Card grid + client-side filters** rather than pagination/server-side filtering. *Why:* 232 rows in DOM is fine for browsers; the user is single-author and admin-only, so the simplest path wins.
- **Notion import is one-shot SQL, not idempotent.** *Why:* re-imports would be rare; if you do, wipe with `DELETE FROM restaurants` (cascades) and re-apply.
- **Backups in repo (not R2).** *Why:* repo can stay private (your call), restore is a `git checkout` away, survives Cloudflare account issues, and the data isn't sensitive to you.

## Next steps (in order)

### 1. Clean up demo seeds on prod
```
npm run db:query:remote -- "DELETE FROM restaurants WHERE slug IN ('chaco-bar','saint-peter')"
npm run db:query:remote -- "SELECT COUNT(*) FROM restaurants"
```
Confirm count is **232**.

### 2. Deploy the code
```
npm run deploy
```
Visit your Worker URL. Hit `/admin`, log in, confirm:
- Card grid shows ~232 restaurants with filters working
- A few cards open and render reviews / standout items correctly
- `/admin/entry/new` loads

### 3. Set Google Maps key on prod
```
npx wrangler secret put GOOGLE_MAPS_API_KEY
```
Paste the same key from `.dev.vars`. Then redeploy:
```
npm run deploy
```
Test autocomplete in the live admin's Name field.

### 4. Wire up the backup workflow

**4a. Make sure repo is private** (Settings → General → bottom of page → "Change visibility" if currently public).

**4b. Create a Cloudflare API token**
- Go to https://dash.cloudflare.com/profile/api-tokens → **Create Token** → **Custom token**
- Name: `lucaseats-d1-backup`
- Permissions: **Account → D1 → Edit**
- Account Resources: limit to your account
- Create → **copy the token immediately** (shown only once)

**4c. Find your Cloudflare Account ID**
- Cloudflare dashboard home → right sidebar → "Account ID"

**4d. Add both as GitHub repo secrets**
- Go to https://github.com/lucaseatsbig/automatic-waddle/settings/secrets/actions
- **New repository secret** twice:
  - `CLOUDFLARE_API_TOKEN` → the token
  - `CLOUDFLARE_ACCOUNT_ID` → the account ID

**4e. Make first commit + push** (verify `.dev.vars` is NOT staged before committing):
```
git status
git add .
git commit -m "Initial lucaseats commit"
git push -u origin main
```

**4f. Trigger workflow manually to test**
- Go to https://github.com/lucaseatsbig/automatic-waddle/actions → **Backup D1** → **Run workflow**
- Should finish in ~1 min and create `backups/<today>.sql` on main

### 5. Day-2 polish (open-ended, low priority)
- Fill in the 16 "visited but no rating" entries via the unified form
- Upload photos to your top ~20 entries
- Clean up multi-location chains (Chargrill Charlie's etc. — first location only; rest in `address` as "Also at: ...")
- Public site design pass once content density is real

## Important files / commands

| Path | Purpose |
|---|---|
| [src/pages/admin/index.astro](src/pages/admin/index.astro) | Admin dashboard with card grid + filters |
| [src/pages/admin/entry/new.astro](src/pages/admin/entry/new.astro) | Unified entry page |
| [src/components/admin/UnifiedEntryForm.astro](src/components/admin/UnifiedEntryForm.astro) | The big one — Google Places, photo picker, submit handler |
| [src/pages/api/admin/entry.ts](src/pages/api/admin/entry.ts) | Single-shot save endpoint (restaurant + review + photos) |
| [src/lib/db.ts](src/lib/db.ts) | All D1 queries |
| [src/lib/types.ts](src/lib/types.ts) | TypeScript types for the DB layer |
| [migrations/0004_maps_and_optional_date.sql](migrations/0004_maps_and_optional_date.sql) | Latest schema migration |
| [scripts/import-notion.mjs](scripts/import-notion.mjs) | Notion CSV → SQL importer (re-runnable) |
| [scripts/notion-import.sql](scripts/notion-import.sql) | Generated import SQL |
| [.github/workflows/backup-d1.yml](.github/workflows/backup-d1.yml) | Weekly D1 backup |

### Environment

`.dev.vars` (local, gitignored):
```
ADMIN_PASSWORD=...
SESSION_SECRET=...
PUBLIC_PHOTOS_URL=https://photos.lucaseatsbig.com
GOOGLE_MAPS_API_KEY=AIza...
```

### Common commands

```
# Local dev
npm run dev

# Apply migrations
npm run db:migrate:local
npm run db:migrate:remote

# Notion import (idempotent for tags+locations, NOT for restaurants)
npm run db:import:notion              # regenerates SQL from CSV
npm run db:import:apply:local
npm run db:import:apply:remote

# Ad-hoc queries
npm run db:query:local  -- "SELECT COUNT(*) FROM restaurants"
npm run db:query:remote -- "SELECT COUNT(*) FROM restaurants"

# Deploy
npm run deploy
```

### Restore from a backup

```
# Find the backup commit
git log --oneline -- backups/

# Pick a date and restore
git show <commit>:backups/<date>.sql > restore.sql
npm run db:query:remote -- "DELETE FROM restaurants"   # cascades to reviews/photos/tags
npx wrangler d1 execute lucaseats-db --remote --file=restore.sql
```
