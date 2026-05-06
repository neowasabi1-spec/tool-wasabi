# Copywriting Knowledge Base

Curated direct-response copywriting frameworks injected into every Claude
call as a **cached system block**. This is what makes Claude in this app
respond like a senior copywriter who has actually read RMBC, COS Engine,
Tony Flores, Evaldo, Anghelache, etc. — instead of a generic AI.

---

## How it works (in 30 seconds)

Every Anthropic call goes through `src/lib/anthropic-with-knowledge.ts`,
which builds a multi-block system prompt:

```
system: [
  { type: 'text', text: <instructions + Tier 1 KB>, cache_control: ephemeral },
  { type: 'text', text: <Tier 2 task pack>,         cache_control: ephemeral }, // optional
]
messages: [
  { role: 'user', content: '# PRODUCT BRIEF\n...\n\n# MARKET RESEARCH\n...\n\n# REQUEST\n...' }
]
```

- **Tier 1 (always loaded, ~28K tokens)** — COS Engine + 5 distilled frameworks.
  Cached at first call, costs ~10% on cache hits within ~5 min.
- **Tier 2 (per task, currently empty)** — Phase 2 work: distill RMBC and
  Swipe Mastery into per-task packs (`vsl`, `pdp`, `email`, `ad`, etc.).
- **Brief + Market Research** — go in the user message, NOT cached
  (they vary per project).

Result: rich copywriter context with low marginal cost per call.

---

## Setup (one-time)

The raw `.md` files are NOT in git directly — too large and partially
copyrighted. Populate them locally:

```powershell
pwsh ./scripts/setup-knowledge.ps1
```

The script copies from `C:\Users\Neo\Downloads` (edit `$SourceDir` if needed)
into `src/knowledge/copywriting/raw/` with canonical filenames.

Files expected:

| Filename                          | Tier | Loaded at runtime? |
|-----------------------------------|------|--------------------|
| `cos-engine.md`                   | 1    | yes                |
| `tony-flores-mechanisms.md`       | 1    | yes                |
| `evaldo-16-word.md`               | 1    | yes                |
| `anghelache-crash-course.md`      | 1    | yes                |
| `savage-system.md`                | 1    | yes                |
| `108-split-tests.md`              | 1    | yes                |
| `swipe-mastery-full-book.md`      | 3    | no (archive)       |
| `rmbc-full-course.md`             | 3    | no (archive)       |

---

## Using the helper from a route

```ts
import { callClaudeWithKnowledge } from '@/lib/anthropic-with-knowledge';

const { reply, usage } = await callClaudeWithKnowledge({
  task: 'vsl',                                // optional, defaults to 'general'
  instructions: 'You are an expert VSL copywriter...',
  brief: productBriefText,                    // optional
  marketResearch: marketResearchText,         // optional
  messages: [{ role: 'user', content: 'Write a 5-min VSL lead.' }],
  maxTokens: 4096,
});
```

The helper handles:
- KB injection with proper `cache_control` blocks
- Brief + market research prefixed to the latest user message
- Anthropic API call + error handling
- `usage` returned for cost tracking (incl. `cache_read_input_tokens`)

---

## Adding a new endpoint

1. Replace your existing `fetch('https://api.anthropic.com/...')` call with
   `callClaudeWithKnowledge({ ... })`.
2. Pick a `task` value that matches what the endpoint does (`'vsl'`,
   `'pdp'`, `'email'`, `'ad'`, `'headline'`, `'mechanism'`, `'split-test'`,
   `'advertorial'`, `'upsell'`, or `'general'`).
3. Pass `brief` and `marketResearch` if the endpoint receives them from
   the client.

That's it. The KB is automatically applied + cached.

---

## Adding a new knowledge source (Tier 1)

1. Drop the `.md` file into `src/knowledge/copywriting/raw/`.
2. Add an entry to the `SOURCES` array in `index.ts`:
   ```ts
   {
     id: 'my-new-source',
     title: 'Author — Source Title',
     filename: 'my-new-source.md',
     tier: 1,
     approxTokens: 5000,
   }
   ```
3. Done — the next call will include it. Cache will rebuild on first call
   after the change.

⚠️ Keep total Tier 1 below ~50K tokens. Above that, consider promoting
some content to Tier 2 (task-specific) to keep the always-loaded core lean.

---

## Adding Tier 2 task packs (Phase 2)

The current `getKnowledgeForTask()` returns an empty string. To add packs:

1. Distill the relevant RMBC / Swipe Mastery sections into smaller `.md`
   files, e.g. `pack-vsl.md`, `pack-email.md`.
2. Place them in `raw/` and add `tier: 2` entries in `SOURCES` with a
   `tasks: ['vsl']` array.
3. Update `getKnowledgeForTask()` to filter SOURCES by `tier === 2 &&
   tasks.includes(task)` and concatenate them.

---

## Cost notes

Anthropic Claude Sonnet 4 pricing (May 2026):
- Input: $3 / Mtok
- Output: $15 / Mtok
- Cache write: $3.75 / Mtok (1.25× input)
- Cache read: $0.30 / Mtok (0.10× input)

With ~28K tokens of Tier 1 KB:
- First call:  ~$0.105 KB cost (cache write)
- Cached call: ~$0.0084 KB cost (cache read)

Cache TTL is ~5 minutes from last hit. For a busy app this means
effectively pennies per call.
