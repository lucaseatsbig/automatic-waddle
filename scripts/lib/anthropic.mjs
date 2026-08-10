// Anthropic client setup shared across generator scripts. Centralises the
// API key load (from .dev.vars) and lets each script swap models via flag.

import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

export const MODEL_OPUS = 'claude-opus-4-7';
export const MODEL_SONNET = 'claude-sonnet-4-6';
export const MODEL_HAIKU = 'claude-haiku-4-5';

// Current-generation default for new scripts. The three above are left alone
// so the existing guide generators keep the exact models they were tuned on —
// swapping those is a separate, deliberate migration.
export const MODEL_OPUS_5 = 'claude-opus-5';

export function loadApiKey() {
  try {
    const raw = readFileSync('.dev.vars', 'utf8');
    return raw.match(/ANTHROPIC_API_KEY=(.+)/)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Returns an Anthropic client, or null when the key is missing. */
export function makeClient() {
  const apiKey = loadApiKey();
  return apiKey ? new Anthropic({ apiKey }) : null;
}
