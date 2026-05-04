// Voice-check pass — a cheap Haiku call after the Opus generation that
// flags banned phrases and obvious voice drift. Generators call this
// before writing the SQL: if the check returns severity 'fail', the
// generator throws and skips the post.
//
// Cost: ~$0.001 per check (Haiku, ~2k input + ~200 output).

import { MODEL_HAIKU } from './anthropic.mjs';

// Phrases Lucas hates — adapted from the system prompt. Kept here so we
// can iterate on the list without touching every generator.
const BANNED_PHRASES = [
  'hidden gem',
  'must-try',
  'must try',
  'foodie',
  'in the heart of',
  'amazing',
  'delicious',
  'mouth-watering',
  'mouthwatering',
  'go-to spot',
  'culinary',
  'gastronomic',
  'palate',
  'tantalising',
  'tantalizing',
];

const VOICE_CHECK_PROMPT = `You are a strict editor checking AI-generated copy for Lucas's Sydney food blog.

Voice rules:
- First-person ("I"), opinionated, observational, warm but never marketingy
- No clichés. No filler superlatives. No invented experiences.
- Concrete sensory details over generic adjectives.

Check the supplied markdown for:
1. Banned phrases (exact or near-exact match): hidden gem, must-try, foodie, in the heart of, amazing, delicious, mouth-watering, go-to spot, culinary, gastronomic, palate, tantalising
2. Generic filler ("a wonderful place", "great vibes", "great food")
3. Marketing-speak ("nestled", "boasts", "elevated", "experience")
4. Fabricated-sounding specifics (over-rounded numbers, suspiciously vivid claims)

Return JSON only:
{
  "severity": "pass" | "warn" | "fail",
  "issues": [{ "phrase": string, "context": string, "category": string }]
}

severity rules:
- "pass": zero banned phrases, zero filler/marketing-speak, no fabrication red flags
- "warn": 1-2 minor issues (mild filler, single near-miss banned phrase) — caller can choose to ship anyway
- "fail": ≥3 issues, OR any direct banned-phrase hit, OR any obvious fabrication
`;

/**
 * Quick local pre-filter for banned phrases — runs before the Haiku call so
 * we can short-circuit on direct hits without spending API credits.
 * Returns a list of `{phrase, index}` matches.
 */
export function scanBannedPhrases(text) {
  const haystack = text.toLowerCase();
  const hits = [];
  for (const p of BANNED_PHRASES) {
    let idx = 0;
    while ((idx = haystack.indexOf(p, idx)) !== -1) {
      hits.push({ phrase: p, index: idx });
      idx += p.length;
    }
  }
  return hits;
}

/**
 * Run the full voice check. Returns { severity, issues, usage } where
 * `severity` is one of 'pass' | 'warn' | 'fail'. The caller decides whether
 * to ship on 'warn'; 'fail' should be treated as a hard reject.
 */
export async function runVoiceCheck(anthropic, body_md, { skipModelCheck = false } = {}) {
  // Local pre-filter — direct banned phrase = automatic fail, no API call.
  const localHits = scanBannedPhrases(body_md);
  if (localHits.length > 0) {
    return {
      severity: 'fail',
      issues: localHits.map((h) => ({
        phrase: h.phrase,
        context: body_md.slice(Math.max(0, h.index - 30), h.index + h.phrase.length + 30),
        category: 'banned-phrase (local match)',
      })),
      usage: null,
      skipped: false,
    };
  }

  if (skipModelCheck || !anthropic) {
    return { severity: 'pass', issues: [], usage: null, skipped: true };
  }

  const response = await anthropic.messages.create({
    model: MODEL_HAIKU,
    max_tokens: 1024,
    system: VOICE_CHECK_PROMPT,
    messages: [{ role: 'user', content: `Markdown to check:\n\n${body_md}\n\nReturn JSON only.` }],
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    parsed = fenced ? JSON.parse(fenced[1]) : { severity: 'warn', issues: [{ phrase: '', context: 'unparseable response', category: 'meta' }] };
  }

  return {
    severity: parsed.severity ?? 'warn',
    issues: parsed.issues ?? [],
    usage: response.usage,
    skipped: false,
  };
}

export function formatVoiceIssues(result) {
  if (!result.issues || result.issues.length === 0) return '(no issues)';
  return result.issues
    .slice(0, 5)
    .map((i, n) => `  ${n + 1}. [${i.category}] "${i.phrase}" — ${i.context?.slice(0, 80)}`)
    .join('\n');
}
