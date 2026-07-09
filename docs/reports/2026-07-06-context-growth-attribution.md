# Context-token growth attribution (data side — Prompt A)

**Date:** 2026-07-06 · **Scope:** transcript + debug-log analysis only, no code read beyond confirming the usage mapping. Companion to the pipeline audit (Prompt B, `2026-07-06-context-growth-pipeline-audit.md`).

## Method

- Sessions analyzed (all gpt-5.5 via Codex, `~/.cat-code/projects/-Users-pt-cat-code/`):
  - `c487c2ae` (2026-07-06, 1.7MB, recon-heavy, effort=xhigh) — 21 main-loop calls, ctx 44.5k → 193.5k (~7.5k/call)
  - `f5f183a0` (2026-07-05, 4.5MB, long impl session, effort=xhigh) — 67 main-loop calls, ctx 22.0k → peak 225.4k → 95.7k after compact
  - `8011e696` (2026-07-06, light session) — 12 calls, 33.8k → 45.2k (~1.0k/call)
- Context per call = `input_tokens + cache_read + cache_creation` from `.message.usage` (mapping verified correct at `src/services/api/codex-fetch-adapter.ts:2473` — input exclusive of cached, so these are true request sizes, not double counting).
- For each call, the transcript content appended since the previous call was bucketed by type (chars/4 ≈ tokens) and compared against the real context delta. Debug logs (`~/.cat-code/debug/<session>.txt`, `[codex-cache]` lines) supplied request-side ground truth.
- Estimate quality: bucket estimates match real deltas within ~±10% per call and ~5% in aggregate, so the attribution below accounts for essentially all growth. **No duplication found** — no repeated tool results, no re-injected reminders. `<system-reminder>` count in all three GPT transcripts: **0**.

## Findings (ranked by contribution)

### F1 — Tool results are ~85–90% of visible context growth (inherent, but heavy)

| session | tool_result | user text | tool_use inputs | assistant text | thinking (summaries) |
|---|---|---|---|---|---|
| `c487c2ae` | ~151.6k tok | 3.8k | 2.7k | 3.7k | 1.8k |
| `f5f183a0` | ~178.4k tok | 32.6k | 18.8k | 9.8k | 8.7k |

Per-tool breakdown (result sizes):

| tool | `c487c2ae` | `f5f183a0` |
|---|---|---|
| Read | n=39, avg **2,719 tok**, max 8,044 | n=78, avg **1,667 tok**, max **13,457** |
| Grep | n=32, avg 1,423 tok, max 4,986 | n=57, avg 441 tok, max 2,500 |
| Bash | — | n=53, avg 418 tok, max 5,901 |

Single Read calls of 8–13k tokens are routine. Codex CLI reads files in ~250-line chunks and hard-caps command output; cat-code's Read returns up to 2000 lines with line-number prefixes. This is inherited Claude Code behavior, not a bug — but it is the main reason the context bar moves visibly faster per "read this file" action than in Codex.

### F2 — Encrypted reasoning items accumulate monotonically and are replayed on every request (suspected divergence — cross-check with B)

Debug logs show `replay reasoning item sig_len=…` lists that only ever grow within a thread:

- `c487c2ae`: 0 → **30 items / 74,352 B** replayed per request by request 36.
- `f5f183a0` main thread: 0 → **53 items / 218,408 B** replayed per request (req 163), reset only by compaction (req 165 restarts at 1).

Token cost: per-call `delta − transcript-estimate` gaps sum to **0.89–0.94× the cumulative output_tokens** of prior calls (f5f183a0: 33.2k gap vs 37.3k outputs; c487c2ae: 8.2k vs 8.8k). I.e. each turn's full reasoning (invisible in the transcript — the stored `thinking` blocks are only ~100-token summaries) stays in context for the rest of the thread. At `f5f183a0`'s peak that is roughly **~33k of the 225k context (~15%)**, and it compounds with effort: both heavy sessions ran `effort=xhigh` (single reasoning items of 5–12KB observed), so every expensive thought is paid for again on every subsequent call.

If Codex CLI prunes prior-turn reasoning items (B's question to answer), this is the clearest *implementation-level* divergence explaining "context grows faster than Codex".

### F3 — Auto-mode permission classifier: ~1.03M invisible input tokens in one session (bug-grade, quota not context)

Every auto-mode permission decision fires a separate gpt-5.5 request (`instructions=7444B`, `effort=none`, `messages=2`) that is **always 100% cache-COLD**:

- `f5f183a0`: **67 classifier calls, 1,031,702 input tokens total, avg 15.4k, max 35.6k, cached=0 on every one.** That is ~76% of the session's total uncached input (1.36M). 127 requests with that instruction hash were issued (some retried/unlogged).
- `8011e696`: 14 calls, 202,962 tokens — dwarfing the main loop of that light session.
- `c487c2ae`: 0 (different permission mode) — and it still grew fast, so F3 is orthogonal to the context bar.

This does not appear in the context indicator at all, but it burns the Codex usage window at a multiple of the main loop. Codex CLI has nothing comparable. Log signature: `[auto-mode] API usage: actualInputTokens=… (uncached=… cacheRead=0 …)`, e.g. `Slow permission decision: 5757ms for Bash`.

### F4 — Fixed baseline ≈ 22k tokens before any work

First main-loop call: COLD `cached=0/21998` (`f5f183a0`) / `0/22585` (`c487c2ae`). Composition: system prompt `instructions=42,599–44,493 B` (~11k tok) + 34 tool schemas + developer context (~2.8KB) + memory/skills listings. Doesn't grow, but starts the bar ~10–15% into a 200k window before the first user word — Codex CLI's baseline is a few k.

### F5 — Effort setting amplifier

Both heavy sessions ran `effort=xhigh` (the `/effort` display said "high"; requests logged `effort=xhigh` — worth checking the mapping). xhigh produces larger reasoning per call, which F2 then re-bills on every subsequent call.

## Working as intended (verified)

- **Compaction**: fired at 225k → 54k (`f5f183a0` call 52); replay list reset. **Microcompact**: −8.5k mid-session (call 13).
- **Usage accounting**: OpenAI→Anthropic usage mapping correct; context numbers are honest.
- **No reminder/dedup bloat**: zero system-reminders in GPT transcripts; no content re-sent twice at transcript level.

## Side anomalies (not context growth)

- End of `f5f183a0`: 7 identical requests (`messages=176`, reqs 302–308) — retry storm, burns quota.
- 14 `gpt-5.4-mini` title/side calls per session — negligible.

## Recommendation sketch (pending reconciliation with B)

1. **Prune replayed reasoning items** older than the current turn (or last N turns) if Codex CLI behavior confirms it's safe — saves ~0.9× cumulative output tokens, the only true "leak"-shaped growth.
2. **Cache or shrink the auto-mode classifier prompt** (stable 7.4KB instructions + transcript slice; 0% cache hit today) or route it to `gpt-5.4-mini` — ~1M tok/session at stake.
3. Consider Read/Grep output caps closer to Codex defaults for recon-heavy workflows (biggest lever on the visible bar, but changes agent behavior — judgment call).
