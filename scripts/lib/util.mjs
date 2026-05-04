// Small shared helpers used across generator scripts. Kept dependency-free
// (no Node-builtins beyond strings) so they're trivial to import from any
// script under scripts/.

export function escSql(v) {
  if (v == null) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Stable JSON serialiser — sorts object keys recursively. Used as the
 * `source_filter` for themed posts so the (kind, source_filter) UNIQUE
 * index doesn't get confused by key ordering differences.
 */
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}

/**
 * Cost estimator for Claude usage records. Rates are illustrative — the
 * /M-token figures are pulled from current Anthropic pricing for the listed
 * models. Update when pricing changes.
 */
const MODEL_RATES = {
  'claude-opus-4-7':   { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5':  { input: 0.8, output: 4 },
};

export function estimateCost(model, usage) {
  const rates = MODEL_RATES[model] ?? MODEL_RATES['claude-opus-4-7'];
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const freshInput = (usage.input_tokens ?? 0) - cacheRead - cacheWrite;
  const out = usage.output_tokens ?? 0;
  return (
    (freshInput * rates.input +
      cacheWrite * rates.input * 1.25 +
      cacheRead * rates.input * 0.1 +
      out * rates.output) /
    1_000_000
  );
}

/** Sum the four usage counters across multiple usage records. */
export function sumUsage(records) {
  return records.reduce(
    (acc, u) => ({
      input_tokens: acc.input_tokens + (u.input_tokens ?? 0),
      cache_read_input_tokens: acc.cache_read_input_tokens + (u.cache_read_input_tokens ?? 0),
      cache_creation_input_tokens: acc.cache_creation_input_tokens + (u.cache_creation_input_tokens ?? 0),
      output_tokens: acc.output_tokens + (u.output_tokens ?? 0),
    }),
    {
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
    }
  );
}
