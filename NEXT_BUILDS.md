# Next builds — parked ideas

Things we discussed but didn't ship. Each entry has enough scope detail to
pick up cold. Ranked by my (Claude's) read of "useful × distinctive" —
top of the list first.

---

## 1. Voice memo → review (top recommendation)

**The blocker it solves:** getting content into the database. Right now
every review is a manual form fill — slow, easy to skip on the walk home
from dinner. Voice memo on the spot, form pre-filled by AI, you review +
save.

### Flow

1. On `/admin/entry/new` (or a dedicated `/admin/voice`), tap a mic
   button → browser MediaRecorder captures audio
2. Tap stop → audio uploads to a Cloudflare Worker endpoint →
   forwarded to **OpenAI Whisper** for transcription
3. Transcript + restaurant DB context + extraction system prompt →
   **Claude Sonnet** call
4. Claude returns JSON:
   ```json
   {
     "restaurant": { "name": "...", "cuisine_guess": "...", "suburb_guess": "..." },
     "review": { "rating_overall": 8, "rating_food": 8.5, ... },
     "commentary": "cleaned prose, edited for flow",
     "standout_items": [{ "name": "burrata", "note": "best in Sydney" }],
     "tags": ["casual", "outdoor"]
   }
   ```
5. Form pre-fills with everything → you review, tweak, click Save
   (or "Save and add another")

### Optional: chat-style follow-up

After the initial extraction you can voice-add ("actually the calamari
was incredible") and the system patches the form — adds a standout item,
refines commentary, etc. Same Whisper + Sonnet pair, just an "amend"
prompt instead of "extract from scratch".

### Cost

- Whisper: ~$0.006/min audio
- Sonnet: ~$0.005–0.01 per review (3–5k input tokens + 1k output)
- **Total: ~$0.02/review.** 100 reviews/month = $2.

### Build effort

~1–2 weeks of real work:
- Browser audio recorder UI (mic permission, waveform, timer, retry)
- Worker endpoint that proxies to Whisper (needs `OPENAI_API_KEY` secret)
- Restaurant matcher (existing-name lookup vs new-restaurant flow with
  Google Places enrichment — already wired in `entry.ts`)
- Claude extraction prompt with grounded examples — prompt engineering
  to get rating-from-tone right
- Form pre-fill UI + diff highlighting (show what AI inferred vs filled
  in blanks)
- Error handling for low-confidence extractions ("I wasn't sure about
  the cuisine — please pick")

### Honest tradeoff

Extracting accurate **numerical ratings** from voice is the hard part.
"It was really good" → 7? 8? 9? Two solutions:
- Say the rating explicitly in the memo ("I'd give the food an eight")
- Treat ratings as AI suggestions you confirm before save

Narrative parts (commentary, standout dishes, tags) are where the real
time savings live.

### Files to touch

- New: `src/pages/admin/voice.astro` — recorder + review UI
- New: `src/pages/api/admin/voice-extract.ts` — Worker endpoint
- New: `src/components/admin/VoiceRecorder.astro` — capture component
- Existing: `src/pages/api/admin/entry.ts` — already handles save flow,
  may need a `mode=ai` flag to track AI-assisted entries

---

## 2. AI Vibe-Finder

**What it is:** chat-style discovery for visitors. They describe what
they want in plain English ("romantic but not pretentious near Bondi,
around $80pp, walking distance from a bar"), Claude reads the brief +
the restaurant DB + Lucas's actual commentary text, returns a 3–5 spot
shortlist with **per-pick reasoning**.

### Why it's different from the existing smart search

- Smart search **filters** — token AND across known dimensions, fast,
  free, deterministic. "I know what I want, narrow the list."
- Vibe-Finder **synthesises** — weighs subjective signals (vibe tags +
  Lucas's prose tone), trades off across dimensions, explains why.
  "I don't know what I want, help me decide."

They're sequential, not parallel: search for browsing, finder for "I'm
planning something specific."

### Concrete contrasting query

> "Italian for my parents' anniversary, they hate noisy places, around
> CBD, not stuffy."

- **Smart search** → cuisine=Italian + location≈CBD + maybe price=$$$ →
  8 places, you scroll for "noisy"/"stuffy" yourself.
- **Vibe-Finder** → reads Lucas's commentary on those 8, picks 3 with
  reasoning: *"Pick A — Lucas describes it as 'warm, conversation-
  friendly'. Skip B — loud after 8. Skip C — fine but Lucas finds the
  staff snobby."*

### Cost & build effort

- Cost: ~$0.01–0.05 per query (Sonnet with the restaurant DB as
  context, prompt-cached so subsequent queries are cheap)
- Build: ~1 week. New `/find` or `/ask` page, single Claude call per
  query, render the response as cards + narrative.

### Design direction (from a mockup Lucas put together)

A page called **"Ask the menu"** with the structure:

- Headline: *"Tell me what you're hungry for."*
- Sub: *"Describe the night out, the mood, the budget — anything. I'll
  pull from every place I've eaten in Sydney and put together a shortlist."*
- Big multiline textarea, terracotta "Find me a place →" CTA, "Clear" link
- Hint row under the input: `Enter to ask · Shift+Enter for new line`
- **Starter prompt cards** ("Date night, somewhere with candles" /
  "Birthday dinner for the group" / "Quick lunch, nothing fussy") —
  click pre-fills the input. Lowers first-use friction massively.
- After submit, an interpretation strip: *"YOU ASKED: …" / "I READ THAT
  AS:"* with extracted filter chips (special occasion, good for groups)
  that have an × to remove and re-run. Trust + control layer.
- Below: 3–5 picks rendered as standard `HomeListCard`s, each preceded
  by a one-paragraph AI reasoning blurb that cites Lucas's commentary.
- "Start over ×" link top-right when results are showing.

The interpretation chips are the killer UX detail — users see how the
AI parsed them, can yank a wrong tag, re-run. Better than just showing
reasoning per pick.

### Recommended pipeline

Hybrid to keep cost / latency low:

1. **Pre-Claude (free, instant):** existing smart-parser extracts
   structured filters from the query → renders the chip strip
   immediately (synchronous, no API). Same code already powering the
   `/all` search bar.
2. **Claude call (single, on submit):** Sonnet with the FULL restaurant
   DB as cached context + the chip set + raw query → returns ordered
   restaurant IDs + per-pick reasoning paragraphs. One round-trip.
3. **Render:** picks use existing card components. Reasoning paragraph
   in italic-serif above each card to match the editorial voice.

### Open questions before building

- Where does it live in the nav? `/ask` is the natural URL; do we add
  it to the masthead alongside All Places, About, Guides?
- Cite restaurant slugs in reasoning so users can click through? Yes,
  link inline with `[Name](/restaurants/{slug})`.
- Should the chips be editable in-place (click to swap value) or just
  removable? Removable-only is simpler and probably enough.

### Site-wide IA implication

Lucas's vision: the homepage forks by intent — "do you know what you
want?" → existing `/all` filter page; "don't know" → `/ask` vibe finder.
Two complementary modes promoted side by side.

Concrete change:
- Home hero adds a second pill CTA next to "Find a restaurant here":
  **"Help me decide →"** linking to `/ask`. Order: filter first
  (default for most users), Ask second (distinctive but less frequent).
- Masthead nav adds "Ask" between "All places" and "Guides" so users
  who land on a guide / detail page can still find it without going
  back to home.
- Don't make it an explicit "are you a knower / explorer?" fork on the
  page — frame the buttons by what each does, not who the user is.

### Next steps — design handoff (2026-05)

Three concrete polish items from the latest mockups (`all-places.jsx`
desktop + `mobile/m-variant-prompt.jsx` mobile). All target the
production All Places / Ask page (`/all`). Cards are out of scope —
do not touch `HomeListCard.astro`, `FeaturedCard`, `CompactRow`,
`WishlistCard`.

1. **Mobile · Enter submits the prompt.** Add `onKeyDown` +
   `enterKeyHint="go"` to the textarea so the soft keyboard shows a
   "go" affordance and Enter triggers the same submit as the button.
   Shift+Enter still inserts a newline; gate on
   `!e.nativeEvent.isComposing` for IME safety; whitespace-only input
   does nothing. File: `src/components/ask/PromptHero.tsx` (or its
   production equivalent — verify the path before editing, the repo
   is Astro-first).

2. **Mobile · FAB relabel "Ask" → "Ask something else".** Pure copy
   change on the post-submit floating button, for parity with desktop's
   `AskAgainPill`. Icon (sparkle), position (`bottom: 22; right: 18`),
   and visibility rule (appears once user scrolls past the hero) all
   stay. On screens ≤340px, drop the icon before truncating the label.
   File: `src/components/ask/AskFab.tsx` (verify path).

3. **Desktop · Filter button left of view toggle.** New pill button on
   the right-side toolbar of `/all`, sitting *before* the view-mode
   toggle (Photo grid / Compact / By suburb), separated by a 1px
   18px-tall divider with 12px gaps each side. Pill is `1px solid
   var(--rule)` default, fills `var(--forest)` when ≥1 filter is
   active, with a terracotta-deep badge showing `activeFilterCount`.
   Count derivation:

   ```ts
   const activeFilterCount =
     (filters.cuisine ? 1 : 0) +
     (filters.suburb ? 1 : 0) +
     (filters.eightPlus ? 1 : 0) +
     (filters.price ? 1 : 0) +
     (filters.tags?.length ?? 0);
   ```

   `q` (the prompt itself) and sort are **not** counted — the prompt
   is surfaced by the "You asked" strip. Clicking opens the existing
   filter sheet (`MFilterSheet` on mobile / existing `FilterBar` on
   desktop) as a right-side drawer or centered modal — match the rest
   of the app's overlay pattern. Files: `src/pages/all.astro` for the
   button, `src/components/FilterBar.astro` for open/close wiring.

**Acceptance**

- [ ] Mobile: typing a prompt + Enter (or "go" on soft keyboard)
      triggers the same flow as tapping "Find me a place".
- [ ] Mobile: Shift+Enter still inserts a newline.
- [ ] Mobile: post-submit FAB reads "Ask something else".
- [ ] Desktop: Filter button sits left of view toggle, divider between.
- [ ] Desktop: badge shows count of active filters; clicking opens the
      existing filter panel.
- [ ] No restaurant card markup or styles changed.

---

## 3. Saved lists + magic-link accounts

Visitors save restaurants to "to try" / "been there" / custom lists,
share via URL, get email digests when Lucas reviews something on their
list.

### What it adds

- Real new system: auth (magic link via Resend), per-user schema,
  sharing UI, email pipeline
- Less AI than the others
- Genuine repeat-visit value (people come back to their list)

### Build effort

~1–2 weeks. Schema for `users` + `saved_lists` + `list_items`, magic
link flow, list CRUD UI, share-via-URL, optional email digest cron.

### Why I'd build this third

It's broadly valuable but doesn't lean on what makes lucaseatsbig
distinctive (Lucas's voice). The voice-memo and Vibe-Finder both
amplify that voice; saved lists is "a thing every food site has."

---

## 4. Map-first browsing rebuild

Cluster pins, hover-preview cards, geolocation "what's around me" mode,
multi-stop tour planner ("3 spots within walking distance, mixed
cuisines"). Substantial frontend work, no auth needed, complements the
existing list view.

Lower priority than the AI builds — it polishes existing UX rather than
adding a new capability.

---

## Quick "things you could do without much building" list

If the appetite for big builds passes, smaller wins worth shipping:

- **Generate the SEO guides we already built infra for** — the bot is
  ready, just hasn't been run. Costs ~$0.20/guide. See
  [SEO_BOT_PLAN.md](SEO_BOT_PLAN.md) for the runbook.
- **Add more synonyms / cuisine aliases to smart-parse** — every term
  Lucas's audience uses for a cuisine that the parser misses is a
  one-line PR
- **Refine the voice prompt's banned-phrase list** as you read more
  generated guides ([scripts/lib/voice-check.mjs](scripts/lib/voice-check.mjs))
- **Audit thin reviews** with `node scripts/audit-review-quality.mjs`
  and beef up the 🟡 / 🔴 ones so future SEO guides have more material
