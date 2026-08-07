# A14 — transcript backfill and cache pipeline

## Verdict

This is unusually careful code: the main↔worker boundary is one genuinely shared
validator that both ends run, the worker self-checks with main's own parser before
emitting, path construction is main-authored and re-validated (no renderer input
reaches the filesystem), and every JSONL parse degrades per-line. The HIGH the
brief anticipated — an unbounded JSONL read in the Electron main process — is not
present: main never opens a `.jsonl` at all, only size-checked `<uuid>.json` cache
files. The single most important thing to fix is that `runTranscriptBackfill`
lacks the terminated-latch both sibling runners have
(`app/main/transcriptBackfill.ts:192` vs `sessionsCatalogRunner.ts:117`), so after
main declares the worker untrustworthy it keeps parsing its output and keeps
writing caches. The second is that the backfill persist path does, twice per
session on Electron's main thread, exactly the full-parse-plus-recursive-secret-scan
that the discovery path eight lines earlier is written to avoid.

## Findings

### [MED] The backfill runner keeps trusting a worker it has already terminated
- **Where**: `app/main/transcriptBackfill.ts:192-263` (no latch), compare
  `app/main/sessionsCatalogRunner.ts:117` and `app/main/accountsPoolRunner.ts:119`
  (`if (protocolError) return`)
- **Type**: correctness
- **What**: every rejection path does `rejected += 1; terminate(); return`, but
  `terminate()` only sends SIGTERM and nothing stops the `stdout` `data` listener.
  Records already in the pipe, and records the worker writes before the signal
  lands, are re-entered on the next `data` event, fully parsed, and handed to
  `options.onSession` — which writes cache files to disk.
- **Trigger / why it matters**: `onSession` → `persistTranscriptBackfillResult` →
  `writeCache`, which rethrows on any fs error (ENOSPC/EACCES/EIO,
  `transcriptCache.ts:293-307`). Session 1 throws → `callbackError` set,
  `rejected += 1`, terminate. The worker emits each record with its own awaited
  `process.stdout.write` (`transcriptBackfillWorker.ts:289-300`), so sessions 2..n
  arrive as separate chunks and are still accepted and persisted before the child
  dies. The run then throws anyway, so main reports a failed run that nonetheless
  mutated disk. The worker's own comment
  (`transcriptBackfillWorker.ts:198-211`) states the opposite contract as fact:
  "every session still queued behind this one is silently abandoned". Secondary
  effect: `rejected` is incremented once per subsequent bad line, so the summary
  log at `main.ts:472-474` over-reports.
- **Fix**: add the sibling runners' latch — a `let terminated = false` set in
  `terminate()`, and `if (terminated) return` as the first line of the `data`
  handler.

### [MED] The persist path does on the main thread what discovery was rewritten to avoid — twice per session
- **Where**: `app/main/transcriptBackfill.ts:101` and `:118`; policy statement at
  `app/main/main.ts:399-403`
- **Type**: correctness (main-thread blocking)
- **What**: `persistTranscriptBackfillResult` calls `readCache` before the write
  (to decide `already_cached`) and again after the write (to classify
  `written`/`rejected`). Each `readCache` is a full `JSON.parse` plus a recursive
  `scanForSecrets` walk of the entire frame graph (`transcriptCache.ts:328-341`),
  and it runs synchronously inside the child's `stdout` `data` handler on
  Electron's main thread.
- **Trigger / why it matters**: `backfillTranscriptCaches` explicitly refuses to
  do this at discovery time — "Discovery must not synchronously parse + recursively
  secret-scan every cache on Electron's main thread" — and uses `listCachedSessionIds`
  plus a 4 KiB header probe instead. The persist path then pays that exact cost
  2× for every accepted session, up to `MAX_TRANSCRIPT_BACKFILL_SESSIONS` (32) per
  launch. Measured on the live store (`~/.cat-code/desktop/transcript-cache`):
  56 caches, 44.4 MB total, mean 793 KB, max 4.10 MB. That is ~50 MB of parse +
  object-graph walk on the window's thread, in ~50 ms hitches, during the
  post-paint window.
- **Fix**: use the existing bounded header probe for the pre-write gate
  (`cacheHasCurrentRunFacts` + `cacheWrittenAt` already answer exactly this
  question from 4 KiB), and drop the post-write re-read or reduce it to a
  `statSync` size check.

### [MED] Backfill always replaces an on-close cache, and its frame budget is half the on-close one
- **Where**: `app/main/transcriptBackfill.ts:101-108`; `app/main/transcriptCache.ts:158-184`;
  `app/shared/limits.ts:141-142` vs `app/main/replayBuffer.ts:72-74`
- **Type**: correctness
- **What**: the `already_cached` early return requires
  `(existing.header.runFactsVersion ?? 0) >= TRANSCRIPT_CACHE_RUN_FACTS_VERSION`.
  An on-close cache can never satisfy that: `distill` calls `createTranscriptCache`
  without `runFacts`, so the header omits both `runFacts` and `runFactsVersion`
  (`transcriptCache.ts:178-180`). So every on-close cache is unconditionally
  overwritten by the next launch's backfill — and the backfill's budget is
  `MAX_HISTORY_REPLAY_FRAMES` 4,000 / `MAX_HISTORY_REPLAY_BYTES` 4 MiB, while the
  on-close cache is distilled from a buffer budgeted at
  `DEFAULT_MAX_BUFFERED_FRAMES` 8,000 / `DEFAULT_MAX_BUFFERED_BYTES` 8 MiB.
- **Trigger / why it matters**: a session whose on-close cache exceeded 4,000
  frames or 4 MiB loses rows on the next launch and gains a
  "Only the N most recent messages are shown." notice, purely so the header can
  gain a model/effort/usage string. `transcriptCache.ts:186-198` argues the exact
  opposite trade for the guard-version stamp ("destroying it to gain a display
  detail would be a strictly worse trade"); the refresh path makes that trade
  anyway, just by truncation instead of deletion. Corroborating evidence on disk:
  the two largest live caches are 4,095,318 and 4,031,116 bytes — pinned right
  under the 4 MiB backfill cap, i.e. already truncated artifacts.
- **Fix**: keep the larger artifact. Either compare frame counts/bytes before
  overwriting, or merge the worker's `runFacts` into the existing header instead
  of replacing the whole cache when the existing frame set is longer.

### [MED] Cache freshness is stamped at write time, not at the moment the transcript was read
- **Where**: `app/main/transcriptCache.ts:177` (`writtenAt: Date.now()`),
  `app/main/main.ts:363-383` (`transcriptMtimeMs` / `isTranscriptNewerThanCache`)
- **Type**: correctness
- **What**: the worker reads the JSONL at T0 and main stamps `writtenAt = T1`
  when it persists. The staleness test is `transcriptMtime > writtenAt`, so any
  turn appended to the transcript in `(T0, T1]` is both absent from the cache and
  invisible to the freshness check.
- **Trigger / why it matters**: `restorable` means "no DESKTOP engine is live for
  this row", not "no process is writing this transcript". Since sessions were
  unified the sidebar lists terminal-created rows, and this repo routinely runs
  several engine processes over the same files (CLAUDE.md §4). A transcript being
  appended to by a terminal session is therefore a normal backfill candidate; if
  its last append lands inside the worker's read window, the preview is
  permanently pinned to a prefix of that conversation with no marker, until some
  later append moves mtime past `writtenAt`.
- **Fix**: have the worker report the transcript `mtimeMs`/`size` it actually
  read (the boundary is versioned and additive), and stamp `writtenAt` from that
  or reject the record when the file changed under it.

### [MED] The cache-at-rest read gate is a materially weaker allowlist than the write gate
- **Where**: `app/main/transcriptCache.ts:116-134` + `:405-445` (loose) vs
  `app/shared/transcriptBackfill.ts:250-512` (strict)
- **Type**: design
- **What**: two implementations of "is this frame allowed in a transcript cache".
  The strict one (~260 lines: `parseTranscriptFrame` → `isBackfillSdkMessage` →
  `isBackfillContentBlock`) gates the worker→main boundary. The loose one
  (`isTranscriptCacheFrame`, 18 lines) gates `readCache`, and checks only
  `frame.kind === 'event' && event.type === 'message' && typeof message.type === 'string'`.
  It does not check per-frame `protocolVersion`, `frame.sessionId === header.appSessionId`,
  `replay === true`, or `message.session_id`.
- **Trigger / why it matters**: this is the concept duplication the brief asked
  about, and it matters because the module doc at `transcriptCache.ts:24-28`
  claims reads are "runtime schema-validated … any corruption / schema drift ⇒
  the cache is discarded AND the file deleted", which overstates what
  `parseTranscriptCache` actually enforces. The renderer happens to compensate —
  `projectPreviewTranscriptCache` filters `frame.sessionId === header.appSessionId`
  (`app/renderer/src/previewTranscriptState.ts:125`) — so a frame addressed to
  another session is dropped at display rather than rendered. That means today's
  behavior is safe by a downstream accident, not by the gate the doc names.
- **Fix**: have `parseTranscriptCache` reuse the shared strict frame parser
  (`parseTranscriptFrame` already takes `appSessionId`/`engineSessionId`), or at
  minimum add the three cheap per-frame invariants (`protocolVersion`,
  `sessionId`, `replay`).

### [MED] `readTranscriptRunFacts` reads the whole transcript with no size bound
- **Where**: `app/sidecar/transcriptRunFacts.ts:76`
- **Type**: correctness
- **What**: `readFileSync(path, 'utf8').split('\n')` — no cap — while the call
  20 lines earlier in the same worker iteration passes an explicit
  `maxBytes: MAX_HISTORY_REPLAY_BYTES * 2`
  (`transcriptBackfillWorker.ts:153-159`). The same file is also read in full a
  third time by `loadConversationForResume`.
- **Trigger / why it matters**: the worker allocates the file as a UTF-16 string
  plus a full line array — roughly 3× the file size — per item, serially for up to
  32 items. Measured worst case in the live store: 18.9 MB
  (`~/.cat-code/projects/-Users-pt-cat-code/9962367c-…/subagents/agent-acompact-…jsonl`),
  8 transcripts over 8 MB, so no OOM today. The absent bound is the finding: if
  the worker does die on one item, main throws out of `runTranscriptBackfill` and
  every session queued behind it is skipped — the same "one atypical session
  abandons the queue" failure the 2026-07-28 comment at
  `transcriptBackfillWorker.ts:198-211` was written to close, reached through
  process death instead of a rejected record.
- **Fix**: read a bounded tail (the function already scans newest-first) with the
  same `MAX_HISTORY_REPLAY_BYTES * 2` budget the sibling call uses.

### [LOW] The `MAX_OUTBOUND_FRAME_BYTES` check in `buildBoundedFrames` is dead
- **Where**: `app/sidecar/transcriptBackfillWorker.ts:263-270`
- **Type**: quality
- **What**: `bytes > MAX_OUTBOUND_FRAME_BYTES` (32 MiB) sits in the same `||` as
  `retainedBytes + bytes > MAX_HISTORY_REPLAY_BYTES` (4 MiB). Since
  `retainedBytes >= 0`, the first condition can never be the one that fires.
- **Trigger / why it matters**: it reads as the security baseline's outbound cap
  being enforced here, and it is not — nor should it be, since a backfill frame
  never crosses the sidecar's outbound socket; it goes into a cache file and then
  over IPC. Citing the wrong cap invites someone to "align" the two directional
  limits the baseline says must never be unified.
- **Fix**: drop the sub-condition, or replace it with the bound that actually
  applies to this artifact (`MAX_TRANSCRIPT_BACKFILL_RECORD_BYTES`).

### [LOW] Orphaned `.tmp` cache files can never be reaped
- **Where**: `app/main/transcriptCache.ts:280-307` (writes `.<id>.<pid>.<uuid>.tmp`)
  vs `:361-375` (`listCachedSessionIds` returns only `.json`)
- **Type**: correctness (resource leak)
- **What**: `writeCache` unlinks its temp file on a caught error, but a process
  death between `openSync` and `renameSync` leaves it behind. `gcTranscriptCache`
  (`main.ts:348-356`) enumerates via `listCachedSessionIds`, which filters on
  `.json`, so nothing ever sees a stray `.tmp`.
- **Trigger / why it matters**: the synchronous quit path calls
  `persistTranscriptCache` for every live session inside `host.shutdownAll()`; a
  force-quit or SIGKILL during that loop strands up to 8 MiB per occurrence,
  permanently. (0 present on this machine today.)
- **Fix**: have the GC also unlink `.tmp` entries older than a few minutes, or
  write the temp file into a subdirectory the GC clears wholesale.

### [LOW] The header probes regex over raw frame bytes, not the header
- **Where**: `app/main/transcriptCache.ts:199-223` with `HEADER_PROBE_BYTES = 4096`
  (`:257`)
- **Type**: correctness
- **What**: `cacheHasCurrentRunFacts` matches `/"runFactsVersion"\s*:\s*(\d{1,9})/`
  and `cacheWrittenAt` matches `/"writtenAt"\s*:\s*(\d{1,15})/` against the first
  4096 raw bytes. The comment at `:258` puts real headers at ~330 bytes, so ~3.7 KiB
  of the probe window is FRAME content — i.e. user prompt and tool text.
- **Trigger / why it matters**: a session whose first cached message contains the
  literal text `"runFactsVersion": 1` (pasting this review, for instance) makes a
  cache with no run facts read as current, so it is never refreshed; the same for
  a bogus `"writtenAt"` changing the staleness verdict. Not a security issue —
  the payoff is only a wrong refresh decision — but it is silent and permanent.
- **Fix**: cut the probe at the first `,"frames"` (or `"frames":`) before matching.

### [LOW] `String()` coercion inside the fail-closed boundary parser
- **Where**: `app/shared/transcriptBackfill.ts:142-152`, `:564`, `:587`
- **Type**: correctness
- **What**: `['missing','invalid','session_mismatch','internal'].includes(String(value.reason))`
  followed by `value.reason as TranscriptBackfillFailureResult['reason']`; likewise
  `includes(String(value.file_type))` and `includes(String(value.media_type))`.
- **Trigger / why it matters**: the input is `JSON.parse`d, and a single-element
  array coerces to its element — `String(['invalid']) === 'invalid'` — so
  `reason: ["invalid"]` or `media_type: ["image/png"]` passes a parser whose whole
  job is to reject anything it cannot vouch for, and is then `as`-cast to a string
  type it does not have. Harm is bounded (the worker is main's own child, and the
  values are only displayed), but this is the one place in the module where the
  strict-narrowing discipline lapses.
- **Fix**: `typeof value.reason === 'string' && REASONS.has(value.reason)` against
  a module-level `Set`, which also stops re-allocating the array per call.

### [LOW] `isRecord` is defined three times in this feature, with two different meanings
- **Where**: `app/shared/transcriptBackfill.ts:630`, `app/main/transcriptCache.ts:447`
  (both exclude arrays) vs `app/sidecar/transcriptRunFacts.ts:227` (arrays pass)
- **Type**: quality
- **What**: same name, same feature, divergent semantics. `UUID_RE`/`isUuid` is
  likewise duplicated between `transcriptBackfill.ts:32` and `transcriptCache.ts:104`
  even though `transcriptCache.ts` already imports `parseTranscriptRunFacts` from
  that module (`:61`).
- **Trigger / why it matters**: no live defect — a JSONL line that is a JSON array
  passes `transcriptRunFacts`' guard and then reads `undefined` off every field —
  but a name that means two things across three files in one pipeline is the kind
  of drift the next reader will not check for. (This is repo-wide: 15 `isRecord`
  definitions and 4 `UUID_RE` copies under `app/`.)
- **Fix**: export `isRecord`/`isUuid` from `app/shared/transcriptBackfill.ts` and
  import them in the other two, which already depend on it.

### [LOW] The content-block allowlist is a hand-maintained mirror with no tripwire, currently three types behind
- **Where**: `app/shared/transcriptBackfill.ts:374-396`
- **Type**: quality
- **What**: `BACKFILL_CONTENT_BLOCK_TYPES` mirrors the engine's own passthrough
  vocabulary (`src/utils/messages.ts:2831-2835`) and the renderer projector's
  (`app/renderer/src/transcriptProjector.ts:1834`, `:1891`). It is missing
  `mcp_tool_use`, `mcp_tool_result`, and `compaction`, all three of which both of
  those treat as first class.
- **Trigger / why it matters**: I scanned all 1,780 transcripts under
  `~/.cat-code/projects` (203,640 user/assistant records): **zero** occurrences of
  any block type outside the allowlist, so this is not currently triggered — which
  is why it is LOW rather than a correctness finding. The cost when it does trigger
  is documented in the file itself (`:390-394`) and pinned by
  `transcriptBackfillWorker.probe.test.ts:291-371`: one unknown block type turns
  the whole session into a `failure` record, so it never gets a cache, is re-queued
  on every launch, fails again, and consumes one of the 32 candidate slots forever.
  The same omission already happened once with `tool_reference`.
- **Fix**: derive the set from the engine's own union (the snapshot types are
  already in `app/shared/`) so a new block type is a compile error, rather than
  re-listing it by hand.

### [LOW] The truncation notice misdescribes two of the three ways it can fire
- **Where**: `app/sidecar/transcriptBackfillWorker.ts:275-285`, with the `continue`
  branches at `:247` and `:252`; guard at `app/main/transcriptBackfill.ts:92`
- **Type**: correctness
- **What**: the notice is always "Only the N most recent messages are shown.",
  which describes head truncation. Two paths reach it without truncating the head:
  a `structuredClone` failure and a `checkJsonSafe`/`scanForSecrets` failure both
  `continue`, dropping a message from the MIDDLE and leaving a silent hole under a
  notice that claims otherwise. Separately, `N` can be 1 ("Only the 1 most recent
  messages are shown.") or 0.
- **Trigger / why it matters**: I measured the secret-scan path across all 1,780
  transcripts — 0 of 203,640 records would trip `scanForSecrets`, so the gap case
  is currently unreachable. The grammar case is reachable now: the largest single
  user/assistant record on this machine is 3,688,634 bytes against a 4 MiB cap, so
  a session ending in one such message yields exactly one retained frame. The
  `N === 0` case would produce a cache containing only the notice and no transcript
  rows — precisely what `transcriptBackfill.ts:89-92` says must never be written,
  which its `result.frames.length === 0` check misses because it counts frames
  rather than message frames. Current headroom to that case: 12%.
- **Fix**: count message frames in the persist guard; pluralize the notice; and
  give the mid-transcript drop its own wording, or drop the whole tail from that
  point so the head-truncation claim stays true.

## What is good here

- **The boundary schema is genuinely shared, not duplicated.**
  `parseTranscriptBackfillRequest`/`parseTranscriptBackfillResult` live once in
  `app/shared/` and both ends run them. The worker validating its own output with
  main's authoritative parser before emitting
  (`transcriptBackfillWorker.ts:212-218`) is the right shape for a
  fail-closed boundary that must not be brittle: drift becomes a per-session
  `failure` rather than a batch abort, and the probe test at
  `transcriptBackfillWorker.probe.test.ts:291` proves it on a real process.
- **Path handling is airtight.** No session id from the renderer reaches the
  filesystem. Items are built by main from its own registry
  (`main.ts:416-417` via `defaultTranscriptPath`), and the boundary parser still
  requires absolute + UUID `engineSessionId` + `basename === "<engineSessionId>.jsonl"`
  (`transcriptBackfill.ts:94-105`), so a traversal or absolute-path escape has no
  entry point. The cache filename is UUID-gated independently
  (`transcriptCache.ts:266-269`).
- **Parse robustness against a mid-write engine crash is real end to end.**
  `readTranscriptRunFacts` try/catches per line (`transcriptRunFacts.ts:86-91`),
  and the engine loader it delegates to skips malformed lines
  (`src/utils/json.ts:168-172`) after trimming a partial first line at the read
  boundary (`src/utils/sessionStorage.ts:4266-4275`). A truncated tail costs one
  record, never the session.
- **`resolvePreview` is a pure function over two injected deps**
  (`transcriptCache.ts:383-393`) — the read-vs-vouch decision is testable without
  Electron or disk, and it is what makes the "main never reads a cache the host
  does not vouch for" boundary claim checkable rather than asserted.
- **The worker is genuinely read-only against files other processes own.** It
  calls `switchSession` + the engine's own read accessors and never
  `processResumedConversation`; `switchSession(id, dirname(transcriptPath))`
  correctly supplies the *project dir* that `getSessionProjectDir()` feeds to
  `getAgentTranscriptPath` (`src/bootstrap/state.ts:495-506`,
  `src/utils/sessionStorage.ts:306-316`), so subagent branches resolve without a
  second directory walk in `app/`.
- **Fixtures are correctly quarantined.** All four `*.fixture.ts` in scope are
  referenced only from `*.test.ts`/`*.probe.test.ts`, and every probe that spawns
  one sets `CLAUDE_CONFIG_DIR` to a temp home — which matters, because
  `mintTranscript`/`resumeProbe`/`resumeSeedProbe` all call the full `init()` that
  the production worker deliberately avoids for account-pool reasons
  (`transcriptBackfillWorker.ts:80-85`).

## Not reviewed / uncertain

- **Packaging exclusion (focus 8) could not be verified: there is no packaging
  config.** `app/package.json` has no electron-builder/forge section and no
  `files` field, and the worker entry is resolved as a source `.ts` path spawned
  through `bun run` (`main.ts:604-632`), so the whole `app/sidecar` tree ships as
  source by construction. I can state the fixtures are unreachable from
  production code; I cannot state they are excluded from a bundle that does not
  exist yet. When packaging lands, `mintTranscript.fixture.ts` is a spawnable
  entry that runs `init()` and writes real transcripts into any cwd — worth an
  explicit exclusion then.
- **Renderer-side interleaving of a preview and a live transcript for the same
  session** (`swappedPreviewsRef`, `preview-live-reset`, `openPreloadedPreview`)
  is outside this scope and I did not audit it. What I did verify is that no
  interleaving can originate in this pipeline: candidacy filters `restorable`
  (`mainDecisions.ts:296-321`), `canPreview` is exactly `restorable`, which
  `isRestorable` forces false while a process is live (`host.ts:673-693`),
  `onSession` re-checks against a fresh descriptor with no `await` in between
  (`main.ts:435-452`), and main is the only cache writer on a single thread.
- **Whether the projector's replayed-`tool_result` cache-identity bug is reached
  from this path.** Backfill does emit `replay: true` user frames carrying
  `tool_result` blocks, and `projectPreviewTranscriptCache` feeds them through
  `projectServerFrameBatched` — so the frames do reach the folding code
  (`transcriptProjector.ts:1047-1063`). I did not trace the fold to a conclusion
  because that projector is another reviewer's scope; the pipeline-side fact worth
  handing over is that a preview is projected into a *fresh* `createTranscriptState()`
  with a synthetic `ready` head, so the "drops every read cache" symptom would
  present as a cold projection rather than a mutation of live state.
- **Total on-disk bound for the cache directory** is `MAX_REGISTRY_SESSIONS`
  (256, `app/host/registry.ts:72`) × `MAX_TRANSCRIPT_CACHE_BYTES` (~8.25 MiB) ≈
  2.1 GiB. Nothing enforces an aggregate; GC is purely "delete what the host no
  longer vouches for" (`main.ts:348-356`). Current actual: 56 files / 44.4 MB.
  I am flagging the number rather than filing it, because whether 2.1 GiB is
  acceptable is a product call I cannot make from source.
