# S07 adversarial validation: session storage, restore, context accounting

> **Verification provenance:** Opus 5 lead at high effort, with two independent
> `general-purpose` subagents fanned out over the MED/LOW findings (their
> load-bearing reversals were re-checked by the lead against source before being
> accepted). Method: source review; **four scratch scripts that import the real
> repo modules** and exercise the write queue against a temp `CLAUDE_CONFIG_DIR`
> with induced `EACCES`; independent recomputation of every context denominator
> and numerator from the real functions; `git blame` / `merge-base --is-ancestor
> main` provenance on every cited line. One focused test file was run by a
> subagent (`bun test src/utils/sessionStorage.test.ts` → 24 pass / 0 fail). No
> whole-directory or bare `bun test`, no GUI, no desktop app, no repo edits.
> Branch `migration` at `a17e5e9`.

## Overall verdict

The original report is **substantially right on mechanism and substantially
wrong on blame and blast radius.** Every defect it describes exists in source;
almost none of them are the size, the shape, or the branch it says. Of 13
findings (the brief said 3 HIGH / 5 MED / 6 LOW — the report actually carries 3
HIGH / 5 MED / **5** LOW), 3 are confirmed, 3 are partially confirmed, 4 are
overstated, 1 is invalid, and 2 duplicate `X02a`'s HIGH on `removeMessageByUuid`
at the same line numbers. The single claim most worth acting on is the one the
report got right and understated: **`/context` reports `1%` on a conversation
that is 42% full**, because its headline divides fresh-input tokens by the raw
window, and the report's own headline defect — "permanently poisons every later
flush for the life of the process" — is **false**: one subsequent transcript
write clears it, proven by repro. The report's two most confident branch-attack
claims both invert on `git blame`: the `saveAiGeneratedTitle` call site is on
`main` and this branch *added* the mitigation that hides its orphan, and the
tombstone paths are byte-identical to `main`.

## Summary

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| F1 | HIGH | Three denominators, two numerators, lying comment | **CONFIRMED** | Recomputed independently: 1% / 42% / 44% / 49% for one usage object; the comment is false; `/context` also contradicts its own grid |
| F2 | HIGH | Failed append drops entries + permanently poisons flush | **PARTIALLY CONFIRMED** | Silent batch loss proven; "permanent" refuted by repro — the next `enqueueWrite` clears it; `REPL.tsx:3367` is mis-cited (real: `:3331`) |
| F3 | HIGH | Tombstone slow path truncates whole transcript | **DUPLICATE** | Same defect, same line `:1393`, in `X02a` §"[HIGH] `removeMessageByUuid` truncates the live transcript using a stale size" |
| F4 | MED | Tombstone fast path destroys concurrent appends | **DUPLICATE** | Same defect, same line `:1362`, same 100 ms-timer trigger, in the same `X02a` HIGH |
| F5 | MED | Unreadable transcript reported complete-and-empty | **INVALID** | Two upstream guards: `getLastSessionLog` returns `null` first, and `mergeDisplayHistoryWithSeed` fails closed with `truncated: true` |
| F6 | MED | New title call site reintroduces orphan pattern | **OVERSTATED** | Bypass is real and reproduced, but the call site is on `main` (`393e0c4c`), was never dead, and this branch added the filter that hides the orphan |
| F7 | MED | Anchor invalidation reaches 2 of 8 call sites | **PARTIALLY CONFIRMED** | It is 3 of 16; `query.ts:671` *does* pass the model; the `attachments.ts` 413 story is fabricated (triple-gated reminder nudge) |
| F8 | MED | `ProcessedResume` carries no type-level signal | **PARTIALLY CONFIRMED** | `agentDefinitions` are reloaded by the sidecar, so not lost; `threadGoal` genuinely is, and the desktop renders it |
| F9 | LOW | Em dash in a new user-visible notification | **OVERSTATED** | Real and new, but the rule's only checkable instrument is scoped to `app/renderer/src`, and `src/` carries 6,890 em dashes |
| F10 | LOW | `readLiteMetadata` spacing comment is wrong | **CONFIRMED** | Every writer goes through `jsonStringify` with no `space`; repo-wide and history search finds no spaced writer, ever |
| F11 | LOW | Unnecessary `as` cast | **CONFIRMED** | Probe proves `reasoningDisplay` is a top-level `SettingsSchema` key; one site is branch-new, the other is on `main` |
| F12 | LOW | `applyDisplayPreservedSegmentRelinks` illegible | **OVERSTATED** | Line range wrong by ~40 (real `2490-2577`), two cycle guards not three, 4 of 6 cited tests never reach the function |
| F13 | LOW | `generateSessionTitle` abort signal dead | **OVERSTATED** | True but pre-existing on `main`; the claimed unmounted-component consequence does not hold |

**Tally: CONFIRMED 3 · PARTIALLY CONFIRMED 3 · OVERSTATED 4 · INVALID 1 · DUPLICATE 2 · UNPROVEN 0.**

## Per finding

### F1 — [HIGH] Context percentage: three denominators, two numerators, and a comment that lies

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes, all of it. `analyzeContext.ts:1031` is
  `getContextWindowForModel(runtimeModel, getSdkBetas())`; `:1286-1288` is
  `totalFromAPI = apiUsage ? getFreshInputTokens(apiUsage) : null`; `:1465` is
  `percentage: Math.round((finalTotalTokens / contextWindow) * 100)`;
  `StatusLine.tsx:50-52` is `tokenCountWithEstimation(messages)` /
  `getEffectiveContextWindowSize(runtimeModel)` / `calculateContextPercentages`;
  `autoCompact.ts:40-56`, `:209-247`, `:274-283` are as described.
- **Reachable in production?**: Yes, but not identically for all three surfaces,
  and the report does not say so. I enumerated the consumers myself:
  - **`/context`** is unconditional. It renders `{model} · {totalTokens}/{rawMaxTokens} tokens ({percentage}%)`
    (`ContextVisualization.tsx:192`) and `**Tokens:** X / Y (Z%)`
    (`context-noninteractive.ts:112`).
  - **`StatusLine`** is **opt-in**: `statusLineShouldDisplay` returns
    `settings?.statusLine !== undefined` (`StatusLine.tsx:35-40`). A user with no
    custom status line never sees the 44%. **The report's "same conversation,
    same frame" scenario silently assumes a configured `statusLine`.**
  - **`TokenWarning`** is default-UI but appears only above the warning
    threshold (`TokenWarning.tsx:106-108`).
  No env gate, no feature flag, no test-only path on any of the three.
- **Trigger**: I recomputed the whole thing from the real functions rather than
  trusting the report's arithmetic. Usage `{input 2000, cache_creation 1000, cache_read 150000, output 3000}`:

  | Surface | Numerator | Denominator | Reported |
  |---|---|---|---|
  | `/context` headline | N1 `getFreshInputTokens` = **3,000** | D1 raw = 372,000 | **1%** |
  | Desktop donut (`contextUsage.ts:377-381`) | N2 = **156,000** | D1 raw = 372,000 | **42%** |
  | `StatusLine` `used_percentage` | N2 = 156,000 | D2 effective = 352,000 | **44%** |
  | `TokenWarning` | N2 = 156,000 | D3 autocompact = 320,840 | **49% used** |

  The report's `~1% vs ~44%` arithmetic is **independently correct**.
  `getContextWindowForModel('gpt-5.6-terra')` really is `372_000`
  (`context.ts:117-123`), `getMaxOutputTokensForModel` returns 32,000, so
  D2 = 352,000.
- **Counter-arguments considered**:
  - *Does `apiUsage` come back null in the common case, making `/context` fall
    back to the sane estimated total?* No. `getCurrentUsage` (`tokens.ts:232-252`)
    returns the last assistant usage; on any session past the first response it
    is non-null, so N1 is the live basis.
  - *Is `tokenCountWithEstimation` really N2?* Yes —
    `getTokenCountFromUsage(usage) + roughTokenCountEstimationForMessages(...)`
    (`tokens.ts:390-393`), and `getTokenCountFromUsage` sums all four buckets
    including `cache_read_input_tokens` (`tokens.ts:52-59`).
  - *Could "the status line" in the comment mean something narrower?* The
    adjacent comment at `:1279-1280` ("same source of truth as the status line")
    **is** true — both call `getCurrentUsage`, and `StatusLine.tsx:101` ships the
    raw object as `current_usage`. Only the second sentence, "**the same
    fresh-input basis** as the status line" (`:1283-1285`), is false. That is a
    precise and fair hit.
  - *Is the desktop the culprit, as `A16`/`X02a` argue?* Partly. See the
    divergence answer below.
- **True consequence**: `/context` — the surface a user opens *specifically* to
  ask "how full is my context" — understates by the entire cached prefix on every
  turn after the first. Worse than the report says: **`/context` contradicts
  itself on its own screen.** The grid squares divide the *estimated category
  tokens* by D1 (`analyzeContext.ts:1313-1319`, `:1329`, `:1392`), and the
  reserved "Autocompact buffer" category comes from **D3**
  (`getAutoCompactThreshold`, `:1120-1123`). So the header reads
  `3.0k/372.0k tokens (1%)` above a grid that is roughly 40% filled. The
  strongest default-UI trigger is not the one the report gave: on
  `claude-opus-4-5` at that same usage, the footer renders
  `Context low (4% remaining)` while `/context` says `2%` used — no custom
  status line required.
- **Evidence**: scratch script
  `scratchpad/v27/context-math.ts` (imports `src/utils/tokens.ts`,
  `src/services/compact/autoCompact.ts`, `src/utils/context.ts`,
  `src/services/api/claude.ts`) — output reproduced in the table above.
  Denominator consumers enumerated with `rg -n "getEffectiveContextWindowSize" src/ app/ --glob '!*.test.*'`
  (all six cited D2 sites verified: `StatusLine.tsx:51`,
  `ExitPlanModePermissionRequest.tsx:759`, `attachments.ts:3969`, `:4102`,
  `autoCompact.ts:232`, `:259`). Desktop numerator confirmed at
  `app/renderer/src/contextUsage.ts:141-148` (`contextTokens` sums all four
  buckets) and denominator at `:377-381`.
  **Provenance: PRE-EXISTING.** `git blame -L 1279,1292 -- src/utils/analyzeContext.ts`
  → all `^86051a8` (2026-04-30), and `git merge-base --is-ancestor 86051a8 main`
  → ancestor of `main`. Not branch damage.
- **Disposition**: **Do not apply the report's fix as written.** It proposes
  changing *both* the numerator (N1→N2) *and* the denominator (D1→D2) so
  `/context` matches `StatusLine`. Switching the denominator breaks two things
  the report did not check: the grid, `percentageOfTotal`, and Free-space % all
  divide by `contextWindow` and would no longer reconcile with the header; and
  `analyzeContextUsage`'s `totalTokens`/`maxTokens` cross the wire to the desktop
  (`app/sidecar/contextBreakdownDomain.ts:164-173`), where `maxTokens` drives
  `percentOfWindow` for every category row and `usedTokens` feeds
  `isBreakdownTrustworthy` (`contextBreakdownState.ts:175-176`).
  Apply the **numerator half only**: make the headline
  `getTokenCountFromUsage(apiUsage)` and keep D1. That makes `/context` read 42%,
  agree with its own grid and with the desktop donut exactly, and sit 2 points
  from `StatusLine` — a difference that is explainable rather than 43 points of
  nonsense. Then delete the false sentence at `:1283-1285` and state which
  surface owns which denominator. Also drop the now-unused
  `getEffectiveContextWindowSize` import at `analyzeContext.ts:15`.

**Divergence classification (asked explicitly): BOTH, and neither `A16` nor
`S07` states it correctly.** `S07`'s correction — "the desktop gauge's raw window
matches D1, i.e. it agrees with `/context`" — is right about the *window* and
misleading about the *result*: the desktop shares `/context`'s denominator but
`StatusLine`'s numerator, so it reports 42% where `/context` reports 1%. It
agrees with neither. Conversely `A16`'s premise — "every user-facing context
percentage in the engine ... uses `getEffectiveContextWindowSize`" — is false for
`/context`, which is the engine's most explicit context surface. There are two
independent defects: **engine-internal** (`/context` uses a numerator no other
surface uses) and **desktop-vs-engine** (the donut uses a denominator no engine
*percentage* uses). Fixing `A16`'s D1→D2 alone would leave `/context` at 1%;
fixing `S07`'s numerator alone would leave the donut 2 points off `StatusLine`.
They need one owner.

### F2 — [HIGH] One failed append silently drops transcript entries and permanently poisons every later flush

- **Verdict**: **PARTIALLY CONFIRMED**
- **Cited location holds?**: Mostly. `scheduleDrain` is `:1051-1065`,
  `drainWriteQueue` `:1078-1119`, `appendToFile` `:1067-1076`, `flush` `:1290-1310`
  — all exact, and all four say what the report says. **One citation is wrong:**
  the report puts the `await flushCurrentTranscriptDurably(...)` at
  `REPL.tsx:3367`. Line 3367 is a closing brace of the `onBeforeQueryCallback`
  block; the real call is **`REPL.tsx:3331`**.
- **Reachable in production?**: Yes. No env gate. `appendToFile` retries once
  behind `mkdir(..., {recursive: true})`; the second `fsAppendFile` propagates
  ENOSPC / EDQUOT / EROFS / EACCES / EIO. `flushCurrentTranscriptDurably` is
  branch-new (`6171e8c`, 2026-07-15, **not** an ancestor of `main`) and is real:
  `REPL.tsx:3331` and `deferredContinuationRunner.ts:498`. The drain machinery
  itself is `^86051a8`, pre-existing on `main` — the report says so correctly.
  **No test anywhere covers the failure path**: `rg -n "drainWriteQueue|appendToFile|ENOSPC|EACCES|activeDrain"
  src/utils/sessionStorage.test.ts` returns nothing.
- **Trigger**: pre-create the transcript `0400` so `fsAppendFile` raises EACCES,
  enqueue two entries, wait past `FLUSH_INTERVAL_MS`.
- **Counter-arguments considered** — this is where the finding breaks:
  - **Is the poisoning permanent? No.** `scheduleDrain` early-returns only
    `if (this.flushTimer)`, and the timer is nulled at the top of its own
    callback (`:1056`) *before* the throw. So the very next `enqueueWrite` —
    i.e. the next transcript entry of any kind — schedules a fresh drain that
    reassigns `this.activeDrain`. **Proven**: after a poisoned drain, three
    consecutive `flushSessionStorage()` calls threw; one intervening
    `recordContentReplacement` made the next two resolve.
  - **Do the un-run resolvers matter? No.** All 21 `enqueueWrite` call sites are
    `void this.enqueueWrite(...)` (`:1609`-`:1696`); nothing awaits an individual
    write, so "no resolver runs" hangs nothing. The report's proposed fix
    ("reject its resolvers") would convert this into 21 *new* unhandled
    rejections — **do not apply it.**
  - **Does nothing log? Almost.** An `unhandledRejection` **does** fire (observed
    once per failure), and `gracefulShutdown.ts:328-348` handles it — but only
    into `logForDiagnosticsNoPII` + `logEvent`. Nothing reaches the user, and
    nothing reaches stderr. The report's "nothing logs" is wrong in letter, right
    in effect.
  - *Is a full disk the only way in?* No — a read-only transcript, a read-only
    FS, EDQUOT, or an EIO all reach it. Not exotic.
- **True consequence**: On an append failure, the spliced batch is **permanently
  and silently lost** — confirmed on disk, the two lost entries never appear even
  after permissions are restored. `flushSessionStorage()` then rejects **until the
  next enqueued write drains**, not for the life of the process. The report's
  "after one transient failure every deferred continuation for the rest of the
  session classifies as `transcript_persistence` failure and **never recovers**"
  is false on the last clause.
- **Evidence**: `scratchpad/v27/drain-poison2.ts` (imports the real module,
  temp `CLAUDE_CONFIG_DIR`, `NODE_ENV=production`):
  ```
  phase 1 healthy                         lines: 1
  phase 2 file 0400, two writes           lines: 1 | unhandled: 1
  phase 3 perms restored, 3 flushes       flush 1/2/3: THREW EACCES   (poisoned)
  phase 4 ONE new write                   lines: 2
          two more flushes                flush 1/2: RESOLVED         (recovered)
  phase 6 flushCurrentTranscriptDurably   THREW EACCES
  final file: only "ok-1" and "after-1" — LOST-1, LOST-2, LOST-3 gone forever
  ```
- **Disposition**: Wrap the `scheduleDrain` body in `try/finally` so
  `this.activeDrain = null` and the reschedule always run. Log the append failure
  once at error level from inside `drainWriteQueue` (this is the only place that
  knows *which* file and *how many* entries died). **Resolve, do not reject**, the
  batch's resolvers. Re-queueing the batch at the head — the report's other
  suggestion — needs a retry bound, or a persistent ENOSPC turns into an
  unbounded in-memory queue plus a hot retry loop; prefer a single retry then a
  logged drop. Severity: still worth fixing, but this is a **MED**, not the HIGH
  the report assigned, because the poisoning self-heals on the next write.

### F3 — [HIGH] Tombstone slow path truncates the whole transcript with a swallowing catch

- **Verdict**: **DUPLICATE**
- **Duplicates**: `docs/reports/2026-08-08-migration-branch-review/X02a-atomic-writes-duplication.md`,
  finding **"[HIGH] `removeMessageByUuid` truncates the live transcript using a
  stale size, deleting entries the flush queue appended in the same process"**.
  `X02a` cites `src/utils/sessionStorage.ts:1319-1400` and calls out **the same
  line**: *"The slow path at `:1393` adds a second failure: a truncating
  full-file rewrite with no temp+rename, so a crash there leaves a half-written
  transcript."* `X02a` also carries it in its sweep table as row 4 with severity
  HIGH. The S07 report even alludes to it ("already confirmed four times on this
  branch") without naming the report that owns it.
- **Cited location holds?**: Yes. `:1383-1395` is `readFile` → filter →
  `writeFile(this.sessionFile, lines.join('\n'))`, wrapped by
  `catch { // Silently ignore errors - the file might not exist yet }` at
  `:1396-1398`. `writeFile` does default to flag `'w'`.
- **Reachable in production?**: Yes, but doubly rare. One production caller
  (`REPL.tsx:2964`), reached only when `streamingFallbackOccured`
  (`query.ts:765-771`). The slow path additionally needs the target UUID to be
  outside the 64 KB tail window and the file ≤ `MAX_TOMBSTONE_REWRITE_BYTES`
  (50 MB, `:153` — verified).
- **Counter-arguments considered**: `MAX_TOMBSTONE_REWRITE_BYTES` caps the
  at-risk write at 50 MB, so the destructive window is bounded but not small.
  `trackWrite` (`:1030-1037`) is only a counter — it serializes nothing. There is
  no temp-file or rename anywhere on this path, and `atomicWriteJson`
  (`src/services/deferredContinuation.ts:329`) is already in the repo, so the
  report's "the correct pattern is already here" is accurate.
- **True consequence**: On the success path it rewrites the file minus one line —
  **it does not "truncate the whole transcript"**, which the report's *title*
  claims. The whole-transcript loss requires a crash or a write error after the
  `'w'` open, which the body of the report describes correctly. The swallowing
  catch is the part `X02a` does not emphasise and is a fair addition.
- **Evidence**: `git blame -L 1383,1398 -- src/utils/sessionStorage.ts` → 16/16
  lines `^86051a8`; `git merge-base --is-ancestor 86051a8 main` → ancestor.
  **PRE-EXISTING**, byte-identical on `main`.
- **Disposition**: Fix it under `X02a`'s owner, not S07's — one temp+rename plus
  a narrowed catch covers both the fast and slow paths in one change. Retitle it:
  the defect is "a non-atomic rewrite that can lose the transcript on failure",
  not "truncates the whole transcript".

### F4 — [MED] Tombstone fast path destroys entries appended during its own await window

- **Verdict**: **DUPLICATE**
- **Duplicates**: the same `X02a` HIGH, which cites the destructive call at
  `:1362` and describes the identical trigger — *"`removeMessageByUuid` awaits
  four times ... so the timer fires inside that window, `drainWriteQueue` →
  `appendToFile` appends N bytes at EOF, and the subsequent
  `fh.truncate(absLineStart)` chops the file back past them."*
- **Cited location holds?**: Yes. `fh.read` `:1334`, `fh.truncate` `:1363`,
  `fh.write` `:1365`. The report's `drainWriteQueue`'s `fsAppendFile (:1069)` is
  slightly loose — `:1069` is inside `appendToFile`, which `drainWriteQueue`
  calls at `:1093`/`:1106`. `appendEntryToFile`'s sync append is at `:3223`, not
  `:3222`.
- **Reachable in production?**: Yes, and it does fire mid-stream: `query.ts:765`
  yields tombstones from inside the `for await` over the API generator, which
  then continues and yields the fallback attempt's real assistant messages.
- **Trigger**: reproduced against the real module. With the tombstone's await
  window overlapping the 100 ms drain timer, a genuine appended line is destroyed
  by the bare `ftruncate` even in the documented common case (`afterLen === 0`):
  ```
  delayTicks=0    orphanRemoved=true  REAL_message_survived=true   235->248 bytes
  delayTicks=10   orphanRemoved=true  REAL_message_survived=false  235->109 bytes
  alignedSync   lost 3/100 appended lines
  asyncAppend   depth=6 lost 6/40 · depth=10 lost 7/40
  ```
- **Counter-arguments considered**: `trackWrite` serializes nothing (counter
  only, consumed by `flush()` at `:1304`). The `afterLen > 0` branch is *not* the
  dangerous one — it produced clean files in testing; the bare truncate is.
  Measured tombstone duration `min 0.097 / med 0.171 / max 2.937 ms` against a
  100 ms timer, so per-tombstone overlap probability is roughly 0.2–3%, **and
  only after a streaming fallback** (`claude.ts:2774`, `:2906`).
- **True consequence**: real but low-probability silent transcript line loss,
  not the routine "a completed assistant turn missing from the transcript" the
  report's phrasing implies. One genuinely new sub-observation neither report
  makes: because the tombstone never joins the write queue, an orphan still
  sitting in the queue is simply **not removed** — a correctness miss rather than
  data loss.
- **Evidence**: subagent scratch repro against `setSessionFileForTesting` +
  `removeTranscriptMessage`; `git blame -L 1312,1400` → 89/89 `^86051a8`;
  `git show main:src/utils/sessionStorage.ts` contains the identical fast path.
  **PRE-EXISTING.**
- **Disposition**: The report's fix (route the tombstone through the write queue)
  is correct in principle but is the expensive version. The cheap correct variant:
  re-`fh.stat()` immediately before `fh.truncate` and fall through to the slow
  path if `size` changed since the snapshot. Do **not** wrap it in a mutex around
  `trackWrite` — that still does not order it against the timer-driven drain.
  Fix once, under `X02a`.

### F5 — [MED] An unreadable transcript is reported to the desktop as complete-and-empty

- **Verdict**: **INVALID**
- **Cited location holds?**: Locally, yes. `loadDisplayTranscriptFromJsonlPath`
  is `:4574-4616` (cited `4586-4614` is inside it); the swallowing catch is
  `:4452-4454` (cited `:4453` — exact); `parseJSONL`'s silent skips are
  `json.ts:146-149`/`:169-172`. `sourceTruncated` is set `true` only at `:4268`
  under `if (start > 0)`, so an IO failure leaves it `false`. The claimed return
  shape reproduces exactly:
  ```
  all lines malformed  => { messages: 0, truncated: false }
  chmod 000            => { messages: 0, truncated: false }
  healthy control      => { messages: 2, truncated: false }
  ```
- **Reachable in production?**: **No.** The claim dies at both consumers.
- **Trigger**: none exists.
- **Counter-arguments considered** — two independent guards, both verified by me
  in source after the subagent found them:
  1. **The corrupt case never reaches the display loader.** Both cited sites run
     the resume loader first, and `getLastSessionLog` bails at
     `sessionStorage.ts:4688` `if (messages.size === 0) return null`.
     `app/sidecar/index.ts:190` is inside `if (resumedMessages !== undefined)`,
     and `resumeEngineSession` (`app/sidecar/sessionResume.ts:69-77`) **throws
     `SidecarResumeError`** on null — the sidecar fails loudly, which is exactly
     the "never fall through to a fresh session" clause the report itself quotes
     as the *contrast*. `transcriptBackfillWorker.ts:153` is preceded by
     `if (!loaded) { … reason:'invalid'; continue }`.
  2. **Even standalone, `truncated` comes out `true`, not `false`.**
     `mergeDisplayHistoryWithSeed` (`app/sidecar/historyProjection.ts:29-59`)
     fails closed: with an empty display history and a non-empty seed, the
     prefix-match loop never executes and it returns
     `{ history: seedHistory, truncated: true }`. The claimed `{[], false}` shape
     occurs only when the seed is *also* empty — i.e. when there is no
     conversation to lose. Additionally `sidecarServer.ts:709` returns early on
     `history.length === 0 && !historySourceTruncated`, so nothing is emitted at
     all: it does not "assert it is complete".
- **True consequence**: none via the cited path. The residual is a hygiene item:
  a partially-torn transcript drops the torn lines with no signal.
- **Evidence**: subagent scratch scripts calling the real
  `loadDisplayTranscriptFromJsonlPath`, `getLastSessionLog`, and
  `mergeDisplayHistoryWithSeed`; lead re-read
  `app/sidecar/historyProjection.ts:29-59` and `sessionStorage.ts:4688`.
- **Disposition**: No change for the stated claim. If touched at all, have the
  catch at `:4452` distinguish ENOENT from a real read failure — a LOW hygiene
  item, not the MED assigned.

### F6 — [MED] The branch's new title call site reintroduces the orphan-transcript pattern it just fixed

- **Verdict**: **OVERSTATED**
- **Cited location holds?**: Yes. `saveAiGeneratedTitle` (`:3310-3316`) really
  does `appendEntryToFile(getTranscriptPathForSession(sessionId), …)` with no
  `Project` and no `shouldSkipPersistence()`. `REPL.tsx:3083` is the call.
- **Reachable in production?**: Yes, and the bypass is **reproduced**: with
  `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` and a temp `CLAUDE_CONFIG_DIR`,
  `saveAiGeneratedTitle` created
  `<projects>/<slug>/<sessionId>.jsonl` containing exactly one `ai-title` line,
  while `recordCodexSendPath` and `recordRunFacts` correctly no-op'd in the same
  run. No guard exists between `REPL.tsx:3083` and the write: the enclosing gate
  is `!titleDisabled && !sessionTitle && !agentTitle && !haikuTitleAttemptedRef.current`,
  and `titleDisabled` is `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` (`REPL.tsx:629`) —
  a terminal-title flag, unrelated to persistence.
- **Counter-arguments considered** — three, and they gut the framing:
  1. **It is not the branch's new call site.** `git blame -L 3073,3090 -- src/screens/REPL.tsx`
     → `393e0c4c` (2026-06-29, *"fix(resume): correct session-picker time,
     ordering, and missing names"*), and `git merge-base --is-ancestor 393e0c4c main`
     → **ancestor of `main`**. `git show main:src/screens/REPL.tsx` has the same
     call at its line 3024. **PRE-EXISTING.**
  2. **It was therefore not "dead code the branch now wires in".** It has been
     live on `main` for six weeks.
  3. **The branch improved this.** The `hasConversation === false` filter the
     report cites as what "hides the symptom" is itself **branch-new**
     (`566972fe`, 2026-07-20, not an ancestor of `main`), at `:5974` (report said
     `:5971`). On `main` the orphan file *would* appear as a `(session)` row; on
     `migration` it is filtered from `/resume` **and** from the desktop sidebar
     (`app/sidecar/sessionsCatalogDomain.ts:186`).
  4. **"Permanent" is wrong for one of the three configurations.** Under
     `cleanupPeriodDays: 0`, `getCutoffDate()` (`src/utils/cleanup.ts:25-31`)
     computes `Date.now() - 0`, so the orphan is removed on the next cleanup.
  5. **`saveAiGeneratedTitle` is not special.** The same unguarded
     `appendEntryToFile(getTranscriptPathForSession(...))` shape appears in
     `saveCustomTitle` (`:3268`), `saveTaskSummary` (`:3325`), `saveThreadGoal`
     (`:3337`), `clearThreadGoal` (`:3348`), `saveTag` (`:3379`),
     `linkSessionToPR` (`:3399`), `saveAgentName` (`:3516`), `saveAgentColor`,
     `saveAgentSetting` — nine upstream siblings.
- **True consequence**: one ~120-byte `ai-title` line per session, containing a
  model-generated summary of the user's first prompt, written despite an explicit
  no-persistence instruction. That is a genuine small privacy defect — but an
  **upstream** one, invisible on this branch, and the branch is the thing that
  made it invisible.
- **Evidence**: subagent scratch repro; lead verified
  `git merge-base --is-ancestor 393e0c4c main` → on main,
  `git show main:src/screens/REPL.tsx | rg saveAiGeneratedTitle` → line 3024, and
  `git merge-base --is-ancestor 566972fe main` → BRANCH-NEW.
- **Disposition**: The report's fix ("route them through `getOwnedTranscriptPath()`
  the same way the diagnostic appenders now are") is **wrong and would break
  things**: `saveCustomTitle`, `saveTag`, and `linkSessionToPR` are legitimately
  called with an explicit `fullPath` for *other* sessions (`/resume` rename, PR
  link), which an owned-path resolver cannot serve. Instead export
  `shouldSkipPersistence()` as a module-level predicate (currently `private` on
  `Project`, `:1409`) and early-return from the nine module-level metadata
  appenders, exempting the explicit-`fullPath` cross-session calls. Severity as
  a *branch* finding: **none**; as an upstream privacy nit: LOW.

### F7 — [MED] The new gpt→claude anchor invalidation reaches only 2 of 8 call sites

- **Verdict**: **PARTIALLY CONFIRMED**
- **Cited location holds?**: Yes. `tokens.ts:321-334` is the signature and
  comment; the gate is `:335-337`
  (`currentModel !== undefined && getProviderForModel(currentModel) !== 'openai'`);
  the bail is `:361-368`, additionally conditioned on the *anchor* being an
  openai assistant record.
- **Reachable in production?**: Yes. **I settled the subagent's one open
  uncertainty myself**: Codex assistant records really do carry a `gpt-*` string
  in `message.message.model` — `codex-fetch-adapter.ts:2642-2644` sets
  `model: startedMessage?.model ?? codexModel`, and `codexModel` comes from
  `mapClaudeModelToCodex` (`:567-574`) which returns only `gpt-*` values. So
  `getProviderForModel(message.message.model) === 'openai'` fires and the
  mechanism is live, not inert. `c5738776` (2026-07-06), **not** an ancestor of
  `main` → **BRANCH-NEW**.
- **Trigger**: mid-session switch from a gpt model to a Claude model, in the
  window between the switch and the first Claude assistant record with usage —
  one turn. Measured divergence on a synthetic transcript with a large
  untruncated tool result before a gpt anchor: `8,020` (no model passed) vs
  `200,004` (Claude passed) — a 191,984-token understatement.
- **Counter-arguments considered**:
  - **The enumeration is wrong. It is 3 of 16, not 2 of 8.** `rg -n
    "tokenCountWithEstimation\(" src/ --glob '!*.test.*'` returns 16 non-test call
    sites. Three pass the model: `autoCompact.ts:372`, `Notifications.tsx:94`,
    **and `query.ts:671`** — which the report lists as a *miss*. Verified at HEAD:
    `tokenCountWithEstimation(messagesForQuery, toolUseContext.options.mainLoopModel)`.
    `query.ts` is clean in `git status`, so this is not a working-tree artifact.
  - **The `attachments.ts:4103` severity argument is fabricated.** That call is
    inside `getCompactionReminderAttachment` (`:4085`), which injects a *reminder
    nudge*, not an attachment-fits decision. It is triple-gated: statsig
    `tengu_marble_fox` defaulting `false` (`:4089`), `isAutoCompactEnabled()`
    (`:4093`), and `contextWindow < 1_000_000 → return []` (`:4097-4100`). It
    cannot produce a 413; the worst case is a missing nudge. Verified by reading
    `:4085-4106`.
  - **`yoloClassifier.ts:794` is not a defect** — the surrounding comment says
    the count is computed "unconditionally for telemetry"; it is debug-log only.
  - The 413-critical paths — `query.ts`'s blocking-limit preempt,
    `autoCompact`, the warning banner — are **all covered**.
- **True consequence**: a one-turn display/telemetry discrepancy on a handful of
  surfaces (`StatusLine.tsx:50`, which needs a configured status line;
  `REPL.tsx:1789`/`:3309`/`:5203` goal footer; `inProcessRunner.ts:1349` swarm
  compaction gate). Not "autocompact fires while the status line shows 30%" as a
  systemic condition, and not a 413 risk.
- **Evidence**: subagent scratch probe; lead re-read `src/query.ts:665-677`,
  `src/utils/attachments.ts:4085-4106`, `src/screens/REPL.tsx:5200-5207`, and
  `codex-fetch-adapter.ts:567-574`, `:2635-2650`.
- **Disposition**: Thread `mainLoopModel` into the four sites that already have
  it in scope — `StatusLine.tsx:50`, `REPL.tsx:1789`/`:3309`/`:5203`,
  `inProcessRunner.ts:1349`. Leave `yoloClassifier`, `compact.ts`,
  `sessionMemory.ts`, and `attachments.ts` alone. Do **not** apply the report's
  alternative ("derive the current model inside `tokenCountWithEstimation`") —
  `tokens.ts` is a pure utility with no session state, and reaching for a global
  model there would make every caller's behavior implicit.

### F8 — [MED] `ProcessedResume` fields that the engine's own restore path applies carry no type-level signal

- **Verdict**: **PARTIALLY CONFIRMED**
- **Cited location holds?**: Yes, with two off-by-twos. Type at
  `sessionRestore.ts:293-301`; construction `:815-832`; `recordContentReplacement`
  at `:712` (report said `:710`); `setProviderSwitchLocked` at `:720` (report said
  `:719`). Engine caller `src/main.tsx:3304` and `:3317` — exact. The sidecar
  really does `return { engineSessionId, messages: processed.messages }`
  (`app/sidecar/sessionResume.ts:112`).
- **Reachable in production?**: Yes for the half that survives.
- **Counter-arguments considered**:
  - **`agentDefinitions` are NOT lost.** `app/sidecar/index.ts:144-145` runs
    resume before the controller is built, and `sessionController.ts:317` then
    does `const agentDefinitions = await loadAgentDefinitionsForRuntime(cwd)` — a
    fresh disk load, newer than `refreshedAgentDefs`. That half of the finding is
    **invalid**, and it is the half the report leads with.
  - **`threadGoal` genuinely is lost, and there is no alternate route.**
    `conversationRecovery.ts:489-491` reads it from the transcript →
    `sessionRestore.ts:829` puts it on `initialState.threadGoal` → the sidecar
    drops it. `app/sidecar/goalDomain.ts:19` reads
    `appStateStore.getState().threadGoal`, and that store is built from
    `getDefaultAppState()` (`sessionController.ts:280-281`), whose `threadGoal` is
    `null`. `threadGoalSnapshot()` is a pure projection of that same store, so the
    host plane is not a second source.
- **True consequence**: resume a desktop session that had a thread goal and the
  goal is gone — `MetadataInspector.tsx:167-179` renders Objective, status,
  tokens, time and Goal ID, and shows nothing. `attribution` and
  `standaloneAgentContext` are lost too. This is a **shipped desktop behavior
  bug**, not the "design smell" the report's title frames.
- **Evidence**: lead verified `app/sidecar/sessionResume.ts:85-112`,
  `app/sidecar/sessionController.ts:317`, `src/utils/sessionRestore.ts:824-832`.
  Provenance MIXED: the type and construction are `86051a8`/`d085b5fe`, both
  ancestors of `main`; the sidecar drop is `c1932581` (P3-1), **branch-new**.
- **Disposition**: Not the type-level redesign the report proposes. Have
  `app/sidecar/sessionResume.ts` return `processed.initialState.threadGoal` and
  seed it into the store `createSessionController` builds. One field, one seam.
  The `applied`-vs-`mustApply` type split is a defensible follow-up but is a
  `src/`-wide refactor for a bug that has exactly one victim.

### F9 — [LOW] Em dash in a new user-visible notification

- **Verdict**: **OVERSTATED**
- **Cited location holds?**: Yes, exactly. `src/screens/REPL.tsx:3716`, U+2014,
  and it is genuinely user-visible — `addNotification({ key, text, priority: 'immediate' })`
  through `useNotifications`.
- **Reachable in production?**: Yes. **BRANCH-NEW** (`ce722da6`, 2026-07-12, not
  an ancestor of `main`).
- **Counter-arguments considered**: CLAUDE.md §7's prose is unscoped, but its
  only checkable instrument is `rg -n '—' app/renderer/src --glob '!*.test.*'` —
  scoped to the renderer. Against the repo's own "every rule is checkable"
  preamble, the enforceable scope is `app/renderer/src`. Prevalence settles the
  "regression" framing: `rg -o '—' src/ --glob '!*.test.*' | wc -l` → **6,890**
  hits across 875 files, including user-visible ones
  (`BashTool.tsx:530`, `FilePatchTool.tsx:156`, `errors.ts:619`). The report is
  honest about this itself.
- **True consequence**: one more instance of a convention that is not currently
  enforced in `src/`.
- **Evidence**: as above.
- **Disposition**: Rewrite the string if it is being touched anyway. The
  higher-value action is a CLAUDE.md §7 decision: either extend the rule to `src/`
  and accept a 6,890-hit backlog, or state the scope explicitly. Filing this as a
  per-string finding will not converge.

### F10 — [LOW] `readLiteMetadata`'s spacing-variant comment is factually wrong

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes, `:5672-5676` (report said `:5675`). Verbatim:
  *"Both spacing variants are matched: the transcript writer emits compact JSON
  while the diagnostic appenders emit spaced JSON."*
- **Reachable in production?**: The comment gates a heuristic that decides
  whether a session appears in `/resume` at all (`:5974`) and in the desktop
  sidebar (`app/sidecar/sessionsCatalogDomain.ts:186`), so a future reader acting
  on it matters.
- **Trigger**: the two spaced `chunk.includes` predicates can never match.
- **Counter-arguments considered** — searched hard for a spaced writer and found
  none:
  - Both named appenders (`recordCodexSendPath` `:516`, `recordCodexStreamSurface`
    `:565`) go through `appendEntryToFile` `:3218`, whose line is
    `jsonStringify(entry) + '\n'`; `jsonStringify` is
    `JSON.stringify(value, replacer, space)` with `space` undefined at every call
    site (`src/utils/slowOperations.ts:180-194` — verified by reading).
  - Repo-wide `rg -n 'JSON\.stringify\([^)]*,\s*(null|undefined)\s*,\s*[0-9]' src/ app/ scripts/`
    → 30 hits, none writing a session `.jsonl`.
  - `src/bridge/sessionRunner.ts:277` writes a `.jsonl` but to `tmpdir()`, not the
    projects dir, and in compact NDJSON.
  - History: `git log -S'JSON.stringify(entry, null, 2)' -- src/utils/sessionStorage.ts`
    → empty. There was never a spaced writer.
- **True consequence**: zero behavioral impact; a false comment plus two dead
  predicates on a filter that now gates `/resume` visibility.
- **Evidence**: as above. **BRANCH-NEW** (`566972fe`, 2026-07-20).
- **Disposition**: Delete the two `"type": "…"` spaced predicates and replace the
  second sentence with the true one (all transcript writers go through
  `jsonStringify`, so entries are compact). The report's alternative — keep them
  as "defensive against a hypothetical future writer" — is worse: it preserves
  dead code justified by a hypothetical.

### F11 — [LOW] Unnecessary `as` cast hides a real settings type

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes, with one detail wrong.
  `src/utils/reasoningDisplay.ts:23` casts to `{ reasoningDisplay?: unknown }`;
  `src/commands/reasoning/reasoning.tsx:16` casts to
  `{ reasoningDisplay?: string }` — not `unknown` as the report says, and `string`
  additionally widens away the literal union.
- **Reachable in production?**: The cast compiles unconditionally; there is no
  gate.
- **Trigger**: rename or remove `reasoningDisplay` from the schema and both files
  keep compiling, silently reverting every user to the `'summary'` default with no
  type error.
- **Counter-arguments considered**: the strongest possible refutation would be
  that `getInitialSettings()`'s return type does not include the field. It does:
  `getInitialSettings(): SettingsJson` (`src/utils/settings/settings.ts:912`),
  `SettingsJson = z.infer<ReturnType<typeof SettingsSchema>>`
  (`src/utils/settings/types.ts:1131`), and
  `reasoningDisplay: z.enum(['off','summary','raw']).optional().catch(undefined)`
  at `types.ts:725-731`. A runtime probe confirmed it is a **top-level** key of
  that schema (79 top-level keys, `has reasoningDisplay: true`, parse round-trip
  `"raw"`), not nested — so `z.infer` includes it. Also registered at
  `ConfigTool/supportedSettings.ts:113-119`.
- **True consequence**: cosmetic today (root tsconfig is `strict: false`, and both
  sites re-narrow with a literal check). The cost is the lost compile-time link to
  the schema.
- **Evidence**: as above. Provenance **SPLIT**: `reasoningDisplay.ts:23` is
  `a65f4c1d` (2026-07-13), **branch-new**; `reasoning.tsx:16` is `86051a8`, **on
  `main`**. So "duplicated" describes a new copy of an old pattern.
- **Disposition**: Drop both casts. The literal comparisons at
  `reasoningDisplay.ts:25` and `isMode()` at `reasoning.tsx:17` still typecheck.

### F12 — [LOW] `applyDisplayPreservedSegmentRelinks` is 85 lines of un-legible pointer surgery

- **Verdict**: **OVERSTATED**
- **Cited location holds?**: **No.** The function is
  `src/utils/sessionStorage.ts:2490-2577`, not `2530-2614` — the report's range is
  off by ~40 lines and its start lands inside a different function's body. Real
  length 87 lines, so "85 lines" is fair.
- **Reachable in production?**: Yes.
- **Trigger**: none alleged — this is a readability finding.
- **Counter-arguments considered**: three of the report's four supporting details
  do not survive checking. **Four passes: correct** (`:2504-2513`, `:2521-2530`,
  `:2545-2560`, `:2569-2575`). **Three cycle guards: wrong — there are two**
  (`!preservedUuids.has(...)` `:2504`, `!archivalSeen.has(...)` `:2521`; the
  `reachedHead` break at `:2506` is a termination condition and `:2531` is a
  containment check). **Mutation while iterating: present but safe** — every
  `set` targets an already-existing key, which in JS `Map` iteration replaces in
  place without re-visiting or reordering; no trigger constructible. **Test
  citations wrong**: actual test starts are `252, 351, 476, 581, 610, 638`, not
  `337/461/564/602/630/657`, and only **two** of the six construct a
  `preservedSegment` and therefore reach this function; the other three are
  message-cap/byte-boundary truncation tests.
- **True consequence**: none. `bun test src/utils/sessionStorage.test.ts` → **24
  pass / 0 fail / 65 expect()**.
- **Evidence**: as above. **BRANCH-NEW** (`a3d7c1d`, 2026-08-03).
- **Disposition**: **No change.** Do not apply the report's extract-three-helpers
  refactor: it touches branch-new code with two passing behavioral tests and no
  alleged defect, on the strength of a claim whose own line numbers, guard count,
  and test citations are wrong. The one genuinely useful follow-up is a test with
  **two** compact boundaries in a single transcript — the outer loop's
  per-candidate mutation makes multi-boundary ordering the only unexercised shape.

### F13 — [LOW] `generateSessionTitle`'s abort signal is dead by construction

- **Verdict**: **OVERSTATED**
- **Cited location holds?**: Yes. `REPL.tsx:3076` constructs
  `new AbortController().signal` inline and discards the controller;
  `sessionTitle.ts:131` (report said `:130`) threads it into the query.
- **Reachable in production?**: Yes, but **PRE-EXISTING**:
  `git blame -L 3072,3080 -- src/screens/REPL.tsx` → line 3076 is `^86051a8`, and
  `86051a8` is an ancestor of `main`. The report labels it "(pre-existing; the
  surrounding block is new)" — correct, and it should not have been counted as a
  branch finding.
- **Trigger**: exiting while the title request is in flight.
- **Counter-arguments considered**: `src/bridge/initReplBridge.ts:356` passes a
  **real** signal (`AbortSignal.timeout(15_000)`), so the parameter is not dead
  everywhere — but `src/hooks/useRemoteSession.ts:522-524` has the same dead
  pattern, so it is 2 dead of 3. The claimed consequence fails twice:
  `setHaikuTitle` is called from the REPL, the process-lifetime top-level screen,
  so "fires on an unmounted component" is not a realistic path, and React 18
  removed that warning regardless; and `generateSessionTitle` never rejects (it
  wraps its body and returns `null`, `sessionTitle.ts:155-162`). The working-tree
  diff on `sessionTitle.ts` is entirely
  `getSmallFastModel()` → `getSmallFastModelForProvider()` and does not touch the
  signal.
- **True consequence**: a small side request that cannot be cancelled early.
- **Evidence**: as above.
- **Disposition**: None, or the trivial one — mirror the bridge and pass
  `AbortSignal.timeout(15_000)` at both dead sites. Do **not** apply the report's
  fix (hold the controller in a ref and abort from unmount cleanup): the REPL does
  not meaningfully unmount, so it adds a ref and a cleanup for a path that does
  not run.

## Verification of the report's "fixed" claims

The brief asked for these to be treated as falsifiable. Both hold, with one
qualification the report does not state.

- **"`saveAiGeneratedTitle` is no longer dead code — it is called from
  `REPL.tsx:3083`, correctly guarded against clobbering a user-set title."**
  **TRUE, but not this branch's doing.** The call exists and the guard is real
  (`if (!getCurrentSessionTitle(getSessionId()))`, `REPL.tsx:3082`;
  `getCurrentSessionTitle` at `:3425-3433` returns the cached
  `currentSessionTitle` for the current session only). End-to-end round trip
  verified: the written `aiTitle` field is read back by `readLiteMetadata` at
  `:5637-5638`, ranked below `customTitle`. **But it was fixed on `main` in
  `393e0c4c` (2026-06-29), not on `migration`** — see F6. Attributing it to this
  branch is wrong in the same direction as F6, just with the opposite sign.

- **"`/resume` ordering no longer uses mtime."** **TRUE.** All three links
  verified: `readLiteMetadata` extracts `lastTimestamp` from the tail
  (`:5670`), `enrichLog` substitutes it for the mtime fallback with the reason
  stated (`:5918-5926`), and both `getSessionLogs` (`:4937-4944`) and
  `loadAllProjectsMessageLogsProgressive` (`:4874-4882`) re-sort on the corrected
  value.
  **Qualification the report omits:** the re-sort covers only the enriched
  prefix. `INITIAL_ENRICH_COUNT = 50` (`:276`), and `allStatLogs` is explicitly
  left in mtime order for progressive loading (`:4875-4876`). Sessions past the
  first 50 still order by mtime until they are enriched, and the initial
  `getStatOnlyLogsForWorktrees(worktreePaths, limit)` selection is itself
  mtime-ordered — so a session whose mtime has drifted far enough could still be
  cut before the correction runs. The fix is right for the visible list; it is
  not unconditional.

## Findings the original report missed

Each verified to the same bar as the above.

1. **`flush()` cancels a freshly scheduled drain and then throws, stranding the
   new batch — the durability call actively makes things less durable.**
   `flush()` clears `this.flushTimer` (`:1292-1295`) *before* awaiting
   `this.activeDrain` (`:1297-1299`). After a poisoned drain, a newly enqueued
   entry schedules a timer; `flush()` kills that timer, throws on the stale
   rejection, and never reaches `await this.drainWriteQueue()` at `:1301`. The
   entry then sits in `writeQueues` with **no scheduled drain at all**, until an
   unrelated later write happens to reschedule.
   **Proven** (`scratchpad/v27/flush-cancels-drain.ts`):
   ```
   flush: THREW -> EACCES
   after 800ms, file contains: (empty)      SHOULD-LAND present? false
   after a later unrelated write:            SHOULD-LAND present now? true
   ```
   This makes `flushCurrentTranscriptDurably` — whose entire purpose is
   durability before a deferred continuation — the mechanism that delays the
   write it was called to guarantee. Fix with the same `try/finally` as F2, plus
   moving the `clearTimeout` after the `activeDrain` await.

2. **A poisoned drain at process exit silently loses the session's title and
   tag.** `getProject()`'s cleanup handler (`:876-891`) is
   `await project?.flush()` followed by `project?.reAppendSessionMetadata()`. A
   throw at the `flush()` skips the metadata re-append entirely — and that
   re-append is the whole reason the handler exists (its own comment: without it,
   "`--resume` shows the auto-generated firstPrompt instead" of the user's
   `/rename`). `runCleanupFunctions` uses `Promise.all`
   (`src/utils/cleanupRegistry.ts:24`) and `gracefulShutdown.ts:457-460` catches
   and discards. So one failed append during the session costs the user their
   session title in `/resume`, with no error anywhere. Fix: wrap the `flush()` in
   its own try/catch inside that handler, matching the try/catch already around
   `reAppendSessionMetadata`.

3. **`/context` contradicts itself, not just the other surfaces.** Covered under
   F1 — the header percentage (N1/D1), the grid fill (category estimates/D1), and
   the reserved "Autocompact buffer" category (D3) are three different bases on
   one screen. The report treats `/context` as internally coherent and only
   compares it outward.

4. **Unused import.** `getEffectiveContextWindowSize` is imported at
   `src/utils/analyzeContext.ts:15` and never called (`grep -c` → 1, the import
   line). Trivial, but it is the exact symbol whose absence from this file is the
   F1 defect, so leaving it imported is actively misleading.

## Uncertainty

- **The `hasConversation` heuristic's false-negative rate** (which the original
  report also flagged as unresolved) remains unsettled here. I confirmed the
  filter is branch-new and that it hides the F6 orphan, but I did not run a corpus
  scan. What would settle it: assert `hasConversation === true` for every
  transcript in a real `~/.cat-code/projects` for which `loadTranscriptFile`
  returns at least one user/assistant message.
- **`fsync` on an `O_RDONLY` descriptor** in `flushCurrentTranscriptDurably`
  (`:2091`): I confirmed empirically on this machine that neither the file fd nor
  the directory fd throws on Darwin. That establishes it does not error; it does
  **not** establish that the flush is durable. A live power-loss or `fsync`-tracing
  test on both target platforms would settle it. Worth a source comment either way.
- **`X02a` ownership overlap — resolved, not uncertain.** `V30-atomic-writes.md`
  landed during this pass and marks that finding **CONFIRMED at HIGH**
  (`V30` F3: *"Reproduced; the report's flush-timer trigger is the rare one,
  concurrent tombstones the common one"*), citing the same `:1362` and covering
  the whole of `removeMessageByUuid`. So the defect behind my F3/F4 duplicates is
  live and owned there; nothing needs re-inheriting to S07. `V30` additionally
  found the trigger S07 and I both under-weighted — `REPL.tsx:2964` fires
  `void removeTranscriptMessage(...)` once per orphaned message, so a multi-message
  tombstone burst produces concurrent unserialized calls by construction, which is
  a far likelier collision than the 100 ms timer coincidence I measured.
