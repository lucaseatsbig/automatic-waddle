// Thin wrappers around `wrangler d1 execute` so generator scripts don't
// have to redo the JSON-stripping or stderr handling. Reads use --remote
// because remote is the source of truth for restaurants/reviews/posts.

import { execSync } from 'node:child_process';

function run(args) {
  const out = execSync(`npx wrangler d1 execute lucaseats-db ${args}`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    maxBuffer: 32 * 1024 * 1024,
  });
  return out;
}

/** Run a SELECT against remote D1, return parsed result rows. */
export function queryRemote(sql) {
  const flat = sql.replace(/"/g, '\\"').replace(/\s+/g, ' ').trim();
  const out = run(`--remote --json --command "${flat}"`);
  return JSON.parse(out)[0].results;
}

/** Run a SELECT against local D1 — used by audits when you only have a local snapshot. */
export function queryLocal(sql) {
  const flat = sql.replace(/"/g, '\\"').replace(/\s+/g, ' ').trim();
  const out = run(`--local --json --command "${flat}"`);
  return JSON.parse(out)[0].results;
}

/** Apply a writeable command (INSERT/UPDATE/DELETE) to remote. */
export function execRemote(sql) {
  const flat = sql.replace(/"/g, '\\"').replace(/\s+/g, ' ').trim();
  run(`--remote --command "${flat}"`);
}

/** Apply a writeable command to local. */
export function execLocal(sql) {
  const flat = sql.replace(/"/g, '\\"').replace(/\s+/g, ' ').trim();
  run(`--local --command "${flat}"`);
}
