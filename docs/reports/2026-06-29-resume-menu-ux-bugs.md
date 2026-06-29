# `/resume` Menu — UX Bug Report

**Date:** 2026-06-29
**Scope:** The `/resume` session picker. Two independent defects: (1) wrong timestamps and wrong list ordering, (2) generated session names are produced but never shown.
**Status:** Both fixes implemented and verified (2026-06-29). See "Implementation" at the end.

---

## Summary

The `/resume` picker has two distinct, unrelated bugs that together make it hard to use:

| # | Symptom | Root cause | Fix surface |
|---|---------|-----------|-------------|
| 1 | "X ago" time is wrong; list is sorted wrong | `LogOption.modified` = session file **mtime**, not the last message's timestamp | `enrichLog` / `readLiteMetadata` in `sessionStorage.ts` |
| 2 | Sessions show raw first-prompt text instead of a clean name | The Haiku short-name generated at session start is never persisted; the function that would persist it is dead code | wire `generateSessionTitle` → `saveAiGeneratedTitle` in `REPL.tsx` |

Both are small fixes. Neither was introduced by recent work — both predate this repo's squashed git baseline (`86051a8 Initial private publish snapshot`).

---

## How the picker builds a row

For each session the picker renders a **title** and a **metadata line** (time · branch · count · …):

- **Title:** [`getLogDisplayTitle`](../../src/utils/log.ts) (`src/utils/log.ts:30`)
  `agentName || customTitle || summary || firstPrompt || defaultTitle || sessionId[:8]`
- **Time:** [`formatLogMetadata`](../../src/utils/format.ts) → `formatRelativeTimeAgo(log.modified)` (`src/utils/format.ts:218`)
- **Order:** [`sortLogs`](../../src/types/logs.ts) sorts by `modified` desc (`src/types/logs.ts:362`)

The list is loaded in two stages for speed: an instant **lite** pass (filesystem stat only), then an **enrich** pass that reads each visible file's head/tail to fill in real metadata.

---

## Bug 1 — Wrong time and wrong order (`modified` = mtime)

### Root cause

`LogOption.modified` drives both the displayed time and the sort key, and it is set to the session **file's mtime** — never corrected to the timestamp of the last message in the conversation.

- The lite pass sets it from mtime:
  [`getSessionFilesLite`](../../src/utils/sessionStorage.ts) `src/utils/sessionStorage.ts:5392`
  ```ts
  modified: new Date(fileInfo.mtime),
  ```
- The enrich pass spreads `...log` and overrides `firstPrompt`, `gitBranch`, `customTitle`, etc. — **but never overrides `modified`**:
  [`enrichLog`](../../src/utils/sessionStorage.ts) `src/utils/sessionStorage.ts:5423`
- [`readLiteMetadata`](../../src/utils/sessionStorage.ts) (`src/utils/sessionStorage.ts:5131`) reads the file head + tail but **does not extract any timestamp**, so enrichment has nothing to correct `modified` with.

A *different* loader does it right — the synchronous path uses the last message:
`src/utils/sessionStorage.ts:5055` → `modified: new Date(leafMessage.timestamp)`. The lite/progressive path that the picker actually uses does not.

### Why mtime is the wrong signal

cat-code keeps **appending to the session file after the last real message**:
- `last-prompt` cache entries
- `file-history-snapshot` entries
- content-replacement records
- the `/resume` adoption / metadata-restore path

Every one of these bumps mtime without being a conversation message. (List is illustrative, not exhaustive — some `system` entries do carry a `timestamp` yet can still post-date the last human/assistant message and drift mtime. Across these 280 files, 127 end with a *timestamp-less* bookkeeping entry — `last-prompt`, `file-history-snapshot`, or `subagent-terminal`.) So mtime tracks bookkeeping, not "when I last talked to this session."

Because [`sortLogs`](../../src/types/logs.ts) (`src/types/logs.ts:362`) sorts by the same `modified`, the bad value corrupts **ordering** as well as the **label**: a session you last used days ago can sort above one you used an hour ago and show a misleadingly recent "X ago."

### Evidence (from `~/.cat-code/projects/-Users-pt-cat-code`)

- **76** session files have `mtime − last-message-timestamp > 60s`.
- Many diverge by hours; the worst by **~2.75 days** (`4223935b…`: last message `2026-06-20T11:53`, but the file's final two lines are a timestamp-less `last-prompt` entry and a `file-history-snapshot` written days later — exactly what mtime reflects).

### Fix direction

In `readLiteMetadata`, extract the last entry's `timestamp` from the tail; in `enrichLog`, set `modified` from it, falling back to mtime only when none is found. This corrects both the displayed time and the sort order. Minor wrinkle: not-yet-enriched lite rows still show mtime until enriched — acceptable, or re-sort after enrichment.

---

## Bug 2 — Generated session name is never shown

### What exists (all three pieces are present)

- **Producer:** [`generateSessionTitle`](../../src/utils/sessionTitle.ts) (`src/utils/sessionTitle.ts:89`) — a Haiku 6-word title generator, fired on the first user message:
  [`REPL.tsx:3017`](../../src/screens/REPL.tsx)
- **Persister:** [`saveAiGeneratedTitle`](../../src/utils/sessionStorage.ts) (`src/utils/sessionStorage.ts:2988`) — writes an `aiTitle` field into the session file.
- **Reader:** the picker already consumes `aiTitle` — [`getLogDisplayTitle`](../../src/utils/log.ts)'s `customTitle` slot and [`readLiteMetadata`](../../src/utils/sessionStorage.ts) both fall back to `aiTitle` (`src/utils/sessionStorage.ts:5166`).

The producer, the persister, and the reader all exist. **The wiring between them does not.**

### What's broken

1. **The generated title is never saved.** In the local REPL, `generateSessionTitle`'s result goes to `setHaikuTitle(title)` → React state only. Its sole consumer is the terminal/tab title:
   `src/screens/REPL.tsx:1220`
   ```ts
   const terminalTitle = sessionTitle ?? agentTitle ?? haikuTitle ?? 'Free Code';
   ```
   `haikuTitle` is **never** passed to any save/persist/cache function (verified by full-source search). It dies with the session.

2. **`saveAiGeneratedTitle` is dead code** — **zero callers** in `src/`. The one function whose job is to persist `aiTitle` is never invoked.

3. **The two remote paths persist to the backend; the local path persists nowhere.** The other `generateSessionTitle` callers both write to a remote backend, not the local session file, so `/resume` never sees them either:
   - the bridge path ([`initReplBridge.ts:356`](../../src/bridge/initReplBridge.ts)) → `updateBridgeSessionTitle` (remote bridge backend)
   - the CCR/teleport viewer ([`useRemoteSession.ts:522`](../../src/hooks/useRemoteSession.ts)) → `updateSessionTitle` → `axios.patch .../v1/sessions/…` (remote backend)

### Evidence (on disk)

Of **280** local session files in this project:
- **0** contain an `aiTitle` field
- **0** contain a `customTitle`

Not one session has ever had a generated or custom name written to it. That is why the picker always falls through to `firstPrompt` (raw first message) — the only title source that ever gets populated.

### Net effect

Every session generates a clean Haiku title at startup, flashes it in the terminal tab, then throws it away. The `/resume` menu — fully wired to display it — never receives it.

### Fix direction

After `generateSessionTitle` resolves in the local REPL (`src/screens/REPL.tsx:3017`), call `saveAiGeneratedTitle(getSessionId(), title)` alongside `setHaikuTitle(title)`. This connects the existing producer to the existing reader. (User-set titles still win: readers prefer `customTitle` over `aiTitle`.)

---

## Provenance (both bugs)

This repo's history is squashed at the fork (`86051a8 Initial private publish snapshot`; 156 commits total, 155 on top of it). Both defects are present in that baseline and were not touched by any later commit to the relevant files. The 2026-04-30 session-observability docs already refer to `getSessionFilesLite`/`enrichLogs` as **existing** ("don't redesign what works"), so the lite-loading path and its mtime shortcut were inherited at the fork, not authored here. The exact upstream origin is not recoverable from this repo's history.

---

## Recommended fix order

1. **Bug 1** (time + order) — highest impact, self-contained in `sessionStorage.ts`.
2. **Bug 2** (name) — one call site in `REPL.tsx`; activates already-present read + persist machinery. Only helps sessions created after the fix (existing files have no `aiTitle`).

---

## Implementation (landed 2026-06-29)

**Bug 1 — `modified` now reflects last activity, not mtime**
- `LiteMetadata` gains `lastTimestamp?: string` (`sessionStorage.ts`).
- `readLiteMetadata` extracts it via `extractLastJsonStringField(tail, 'timestamp')` — the **last in-file timestamp**, so timestamp-less bookkeeping tails are skipped. Semantics caveat: this is a flat scan, so the match can be a *timestamped* bookkeeping write (e.g. a `file-history-snapshot`'s nested `timestamp`) rather than the last message itself. That's acceptable — such writes happen during/at the end of the session, always within minutes of the last message and far closer to truth than a drifted mtime (which was off by **days**). The direction is safe: writing a message bumps mtime, so `mtime ≥ last-activity` always; the fix can only move `modified` *earlier* toward truth.
- `enrichLog` sets `modified` from `lastTimestamp` when present and parseable (NaN-guarded), otherwise keeps the mtime fallback.
- Ordering: both progressive loaders (`loadSameRepoMessageLogsProgressive`, `loadAllProjectsMessageLogsProgressive`) re-sort the enriched batch with `sortLogs` after enrichment; the append path in `ResumeConversation.tsx` (`loadMoreLogs`) merges into a fresh array then re-sorts. `allStatLogs` stays in mtime order (it drives progressive `nextIndex`).
- Known limitation: candidate selection is still mtime-ordered at the stat level (by design — instant, no file reads). Because `mtime ≥ last-activity` always, this can't hide a genuinely-recent session behind an old one, so the limitation is effectively unreachable. Within everything loaded, order is correct.

**Bug 2 — generated title is persisted**
- `REPL.tsx`: when `generateSessionTitle` resolves, it now also calls `saveAiGeneratedTitle(getSessionId() as UUID, title)` (guarded by `!getCurrentSessionTitle(...)` so a user `/rename` wins and to avoid a stale-write race). The picker already reads `aiTitle`.
- Backfill is not possible — existing session files have no `aiTitle`; only sessions created after this fix get a persisted name.

**Verification**
- New test in `sessionStorage.test.ts` ("enriched modified tracks last in-file timestamp, not drifted mtime"): writes a session with a realistic tail — last message, a timestamp-less `last-prompt`, and a `file-history-snapshot` with a nested `timestamp` — then bumps mtime days past it. Asserts lite `modified` == mtime, enriched `modified` == the snapshot timestamp (the last in-file timestamp), and enriched `modified` < drifted mtime (the days-off value can't leak through). Passes.
- Ran the real loader over the live project dir (280 files): of 120 enriched logs, 45 had `modified` corrected away from mtime (incl. report's divergent files), 75 legitimately unchanged (no drift).
- `bun run build:dev:full` passes (lint + bundle + compile).

**Post-review refinements (2026-06-29).** An external review verdict was "ship" with two nits, both addressed: (1) the test fixture now includes the nested `file-history-snapshot` timestamp it previously omitted, so it documents real JSONL behavior; (2) the `loadMoreLogs` comment's "fresh unshared objects" claim (false for the merged `prev` half) was corrected — the `value` re-stamp is inert (write-only field; selector keys off session id + option index) and kept only for consistency with the other load paths.

**Files changed:** `src/utils/sessionStorage.ts`, `src/utils/sessionStorage.test.ts`, `src/screens/ResumeConversation.tsx`, `src/screens/REPL.tsx`.
