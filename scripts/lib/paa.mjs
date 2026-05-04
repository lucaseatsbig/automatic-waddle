// "People Also Ask" fetcher.
//
// Two strategies, picked by what's configured in .dev.vars:
//
//   1. SERPAPI_KEY set      → use SerpAPI (reliable, ~$0.005/query, $50/mo plans)
//   2. SCRAPERAPI_KEY set   → use ScraperAPI's Google endpoint (~$0.002/query)
//   3. Neither set          → returns [] gracefully (so the rest of the
//                             pipeline still works without paid services)
//
// We never scrape Google directly — it's brittle, breaks under load, and
// can get the originating IP soft-blocked. If you want PAA without paying,
// add suggestions manually via `scripts/import-paa.mjs --query=... --paa=...`
// (or insert into the topics.paa_json column directly).

import { readFileSync } from 'node:fs';

function loadKeys() {
  let raw = '';
  try {
    raw = readFileSync('.dev.vars', 'utf8');
  } catch {
    return {};
  }
  return {
    serpApi: raw.match(/SERPAPI_KEY=(.+)/)?.[1]?.trim() ?? null,
    scraperApi: raw.match(/SCRAPERAPI_KEY=(.+)/)?.[1]?.trim() ?? null,
  };
}

async function fetchViaSerpApi(query, key) {
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&google_domain=google.com.au&gl=au&hl=en&api_key=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SerpAPI ${res.status}: ${await res.text().catch(() => '')}`);
  const json = await res.json();
  const block = json.related_questions ?? [];
  return block.map((q) => q.question).filter(Boolean);
}

async function fetchViaScraperApi(query, key) {
  const target = `https://www.google.com.au/search?q=${encodeURIComponent(query)}&hl=en&gl=au`;
  const url = `https://api.scraperapi.com/?api_key=${key}&url=${encodeURIComponent(target)}&country_code=au`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ScraperAPI ${res.status}`);
  const html = await res.text();
  // Coarse heuristic — Google's PAA boxes have predictable role attributes.
  // This is best-effort; if it stops working, switch to SerpAPI.
  const matches = [...html.matchAll(/role="heading"[^>]*>([^<]{8,140})<\/[^>]+>/g)];
  return [...new Set(matches.map((m) => m[1].trim()))]
    .filter((q) => /\?\s*$/.test(q))
    .slice(0, 6);
}

/**
 * Fetch up to ~6 People Also Ask questions for `query`. Falls back to []
 * silently when no provider is configured.
 */
export async function fetchPAA(query) {
  const keys = loadKeys();
  try {
    if (keys.serpApi) return await fetchViaSerpApi(query, keys.serpApi);
    if (keys.scraperApi) return await fetchViaScraperApi(query, keys.scraperApi);
    return [];
  } catch (err) {
    console.error(`  ! PAA fetch failed for "${query}": ${err.message}`);
    return [];
  }
}

export function hasPaaProvider() {
  const keys = loadKeys();
  return Boolean(keys.serpApi || keys.scraperApi);
}
