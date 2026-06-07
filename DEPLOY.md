# Deploy & database notes

Quick ops reference for lucaseats (Astro + Cloudflare Workers + D1).

## Deploying

> ⚠️ **Migrations first, then deploy.** If a change adds a file under
> `migrations/`, apply it to the remote DB **before** (or together with)
> shipping the code. Deploying code that reads a new column while the
> production DB still lacks it makes every query fail — the whole site 500s.
> (This is exactly what happened with `0012_card_quote` on 2026-06-07.)

Normal release:

```bash
# 1. If this release includes a new migration, apply it to prod first:
npm run db:migrate:remote

# 2. Build + deploy the Worker:
npm run deploy
```

To check whether a migration is pending on prod:

```bash
npx wrangler d1 migrations list lucaseats-db --remote
```

After deploy, sanity-check a couple of pages return 200:

```bash
for p in / /all /about; do
  echo "$p -> $(curl -s -o /dev/null -w '%{http_code}' https://lucaseatsbig.com$p)"
done
```

## Migrations

- Local:  `npm run db:migrate:local`
- Remote: `npm run db:migrate:remote`

Apply to **both**. Local keeps `npm run dev` working; remote is what production
serves. They drift apart if you only do one.

## Refresh local DB from production

The local dev DB (`.wrangler/state/v3/d1/...`) is a separate copy and goes
stale — notes/tags you add on the live site won't appear locally until you
re-sync. To pull a fresh copy of prod down to local:

```bash
# 1. Export production (schema + data) to a file:
npx wrangler d1 export lucaseats-db --remote --output=tmp/prod-export.sql

# 2. Stop `npm run dev` (it locks the local DB file), then wipe the local DB:
#    delete .wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite*
#    (keep metadata.sqlite)

# 3. Re-import. The export inserts child rows (standout_items, photos) before
#    the reviews table exists, which trips foreign-key enforcement on import.
#    If `db:execute --local --file=...` fails with "no such table" / FK errors,
#    reorder the dump so CREATE TABLEs run first and parent rows insert before
#    child rows (group inserts: locations/tags/restaurants → reviews →
#    standout_items/photos). Then:
npx wrangler d1 execute lucaseats-db --local --file=tmp/prod-reordered.sql

# 4. Verify, then clean up tmp/:
npx wrangler d1 execute lucaseats-db --local --command "PRAGMA foreign_key_check;"
```

## Handy queries

```bash
# Ad-hoc read against prod (read-only is safe):
npx wrangler d1 execute lucaseats-db --remote --command "SELECT ..."

# Same against local:
npx wrangler d1 execute lucaseats-db --local  --command "SELECT ..."
```
