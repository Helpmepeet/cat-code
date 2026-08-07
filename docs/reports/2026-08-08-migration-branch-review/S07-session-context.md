# S07 — session storage, restore, context accounting

## Verdict

The new code in this scope is careful and unusually well-reasoned: the orphan-transcript
fix (`getOwnedTranscriptPath`), the deferred-continuation resume locking, and the two new
untracked provider-routing tests are all correct and genuinely wired. The problems are
concentrated in two places the branch inherited but did not reconcile. First, **context
accounting has three live denominators and two different numerators**, so `/context` and
the status line report wildly different percentages for the same conversation (~1% vs ~44%
on a cached turn), and a code comment asserts they agree. Second, **`sessionStorage.ts`
has no atomic-write story at all**: a single failed append silently discards a batch of
transcript entries *and* permanently poisons every subsequent `flushSessionStorage()` for
the life of the process — which the branch just made load-bearing by routing the new
`flushCurrentTranscriptDurably` through it. Fix the flush poisoning first; it converts a
transient disk hiccup into a permanent, silent, whole-session failure.

Findings marked **(pre-existing)** are not introduced by this branch but sit squarely in
the audit scope I was given and are made more consequential by the branch's new consumers.

## Findings

### [HIGH] Context percentage: three denominators, two numerators, and a comment that lies
- **Where**: `/Users/pt/cat-code/src/utils/analyzeContext.ts:1031`, `:1286`, `:1465`;
  `/Users/pt/cat-code/src/components/StatusLine.tsx:50-52`;
  `/Users/pt/cat-code/src/services/compact/autoCompact.ts:40-56`, `:209-247`, `:274-283`
- **Type**: correctness
- **What**: The engine is **not** internally consistent. `/context` divides
  `getFreshInputTokens(apiUsage)` (input + cache_creation, **excluding cache_read**) by the
  **raw** window. `StatusLine` divides `tokenCountWithEstimation(messages)` (which uses
  `getTokenCountFromUsage` = input + cache_creation + **cache_read** + output) by the
  **effective** window. `TokenWarning` divides by a **third** value. The comment at
  `analyzeContext.ts:1283-1285` claims `/context` uses "the same fresh-input basis as the
  status line" — the status line does not use a fresh-input basis at all.

  Complete denominator inventory (the deliverable asked for):

  | # | Denominator | Definition | Consumers |
  |---|---|---|---|
  | D1 | **Raw window** | `getContextWindowForModel(model, getSdkBetas())` | `analyzeContext.ts:1031` → grid squares (`:1317-1327`), per-category `percentageOfTotal` (`:1319`), Free-space % (`:1392`), headline `percentage` (`:1465`), `maxTokens`/`rawMaxTokens` (`:1463-1464`); persisted as `run_facts.contextWindow` (`src/services/api/claude.ts:1949`); the desktop gauge |
  | D2 | **Effective window** | D1 − `min(getMaxOutputTokensForModel(model), 20_000)`, then clamped by `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (`autoCompact.ts:40-56`) | `StatusLine.tsx:51`, `ExitPlanModePermissionRequest.tsx:759`, `attachments.ts:3969` and `:4102`, `getBlockingLimit` (`autoCompact.ts:231`), `calculateTokenWarningState` when autocompact is **off** (`autoCompact.ts:259`) |
  | D3 | **Autocompact threshold** | D2 − (`MANUAL_COMPACT_BUFFER_TOKENS` 3_000 + recovery window `clamp(0.08·D2, min, 50_000)`), or `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`% of D2 (`autoCompact.ts:209-247`) | `calculateTokenWarningState` when autocompact is **on** → `TokenWarning.tsx:144`, `shouldAutoCompact` (`autoCompact.ts:383`) |

  Correction to the incoming premise: the desktop gauge's raw window matches **D1**, i.e.
  it agrees with `/context`. The divergence is that `/context` (D1) disagrees with
  `StatusLine` (D2) and `TokenWarning` (D3) inside the terminal, on the same screen.
- **Trigger / why it matters**: A `gpt-5.6-terra` session (`contextWindow` 372_000, taken
  from a real `run_facts` line in `~/.cat-code/projects/-Users-pt-cat-code-app/966bc02d….jsonl`)
  after a cached turn with `input=2000, cache_creation=1000, cache_read=150000, output=3000`:
  `/context` reports `3000 / 372000` = **1%**; the status line reports
  `156000 / ~352000` = **44%**. Same conversation, same frame. Cache reads occupy the
  context window, so `/context`'s headline is the wrong metric for "context used" and
  understates by the full cached prefix on every Anthropic turn after the first.
- **Fix**: Make `analyzeContext`'s headline use `getTokenCountFromUsage(apiUsage)` and
  divide by `getEffectiveContextWindowSize(runtimeModel)` so it matches `StatusLine`; keep
  the cache-read split as a separate reported line rather than by excluding it from the
  total. Delete the false "same fresh-input basis" comment. If D1 must stay for the grid,
  say so explicitly in the comment and name which surface owns which denominator.

### [HIGH] One failed append silently drops transcript entries and permanently poisons every later flush
- **Where**: `/Users/pt/cat-code/src/utils/sessionStorage.ts:1051-1065` (`scheduleDrain`),
  `:1078-1119` (`drainWriteQueue`), `:1067-1076` (`appendToFile`), `:1290-1310` (`flush`)
- **Type**: correctness *(pre-existing infrastructure, newly load-bearing)*
- **What**: `drainWriteQueue` does `queue.splice(0)` **first**, then `await this.appendToFile(...)`.
  If that append rejects, the spliced batch is already gone from the queue and is never
  retried, no resolver runs, and nothing logs. `scheduleDrain`'s `setTimeout(async () => { …
  await this.activeDrain; this.activeDrain = null; … })` has no try/catch, so
  `this.activeDrain` is left holding a **rejected promise forever** and the "more items
  arrived" reschedule never runs. `flush()` then re-throws that same rejection on
  `if (this.activeDrain) await this.activeDrain` on **every subsequent call**, for the rest
  of the process.
- **Trigger / why it matters**: `appendToFile` retries once behind `mkdir(..., {recursive:true})`;
  the second `fsAppendFile` throws on ENOSPC / EDQUOT / EROFS / EACCES / EIO. A momentary
  disk-full while the user is mid-conversation (a) loses up to a full 100 ms batch of
  real user/assistant messages with no error surfaced anywhere, and (b) makes every later
  `flushSessionStorage()` reject. The branch's new `flushCurrentTranscriptDurably`
  (`:2078`) is the first line of that function, and `REPL.tsx:3367` awaits it inside the
  deferred-continuation path — so after one transient failure every deferred continuation
  for the rest of the session classifies as `transcript_persistence` failure and never
  recovers, with the root cause invisible (the unhandled rejection is swallowed by the
  handler at `src/utils/gracefulShutdown.ts:328`, which logs and returns).
- **Fix**: Wrap the drain body in `try/finally` so `this.activeDrain = null` and the
  reschedule always run; on append failure, put the batch back at the head of its queue
  (or reject its resolvers) and surface the error once via `logForDebugging(..., {level:'error'})`
  plus a user-visible notification. Do not let a rejected promise persist in `activeDrain`.

### [HIGH] Tombstone slow path truncates the whole transcript with a swallowing catch
- **Where**: `/Users/pt/cat-code/src/utils/sessionStorage.ts:1383-1398`
- **Type**: correctness *(pre-existing)*
- **What**: `readFile` → filter lines → `writeFile(this.sessionFile, lines.join('\n'))`.
  `writeFile` defaults to flag `'w'`: it truncates to zero and then writes. The entire
  block is wrapped in `catch { // Silently ignore errors - the file might not exist yet }`.
- **Trigger / why it matters**: If the process dies, or the write fails with ENOSPC /
  EIO, after the truncate but before the content lands, the user's **entire session
  transcript** is left empty or half-written, and the catch guarantees nobody hears about
  it. This is exactly the systemic non-atomic-write pattern already confirmed four times
  on this branch; the correct pattern (`atomicWriteJson`, and
  `src/services/api/codexAccountPool.ts:761`) is already in the repo. Additionally, any
  entry appended between the `readFile` and the `writeFile` is silently destroyed.
- **Fix**: Write to `<path>.tmp` in the same directory and `rename()` over the original.
  Narrow the catch so a write failure is logged at error level rather than being
  indistinguishable from "file does not exist yet".

### [MED] Tombstone fast path destroys entries appended during its own await window
- **Where**: `/Users/pt/cat-code/src/utils/sessionStorage.ts:1334-1367`, called
  fire-and-forget from `/Users/pt/cat-code/src/screens/REPL.tsx:2964`
- **Type**: correctness *(pre-existing)*
- **What**: The function snapshots the last 64 KB (`fh.read`), then — across at least one
  await boundary — calls `fh.truncate(absLineStart)` and re-writes only the bytes from that
  stale snapshot. Nothing serializes this against `drainWriteQueue`'s `fsAppendFile`
  (`:1069`) or against the sync `appendEntryToFile` (`:3222`) that the diagnostic recorders
  fire straight from the API path.
- **Trigger / why it matters**: `REPL.tsx:2964` calls `void removeTranscriptMessage(...)`
  while a stream is live. The 100 ms write-queue timer fires during the tombstone's await
  window, appends a real assistant message at the then-EOF, and `fh.truncate` removes it.
  Result: a completed assistant turn missing from the transcript on next resume, silently.
- **Fix**: Route the tombstone through the same per-file write queue as
  `enqueueWrite`/`drainWriteQueue` so appends and the splice are serialized, instead of
  operating on a raw fd in parallel with them.

### [MED] An unreadable transcript is reported to the desktop as complete-and-empty
- **Where**: `/Users/pt/cat-code/src/utils/sessionStorage.ts:4586-4614`
  (`loadDisplayTranscriptFromJsonlPath`), `:4453` (the swallowing catch in `loadTranscriptFile`)
- **Type**: correctness
- **What**: `loadTranscriptFile` wraps all IO and parsing in `try { … } catch { /* File
  doesn't exist or can't be read */ }`, and `parseJSONL` skips malformed lines silently
  (`src/utils/json.ts:145`, `:167`). So a transcript whose lines are all malformed, or
  whose `stat`/`read` fails, produces zero messages, `sourceTruncated === false`, `tip ===
  undefined`, and the function returns `{ messages: [], truncated: false }`.
- **Trigger / why it matters**: `truncated` is authoritative for both desktop consumers —
  `app/sidecar/index.ts:190` and `app/sidecar/transcriptBackfillWorker.ts:153` feed it into
  `buildBoundedFrames(..., display.truncated || merged.truncated)`, which drives the
  "earlier messages not shown" affordance. A corrupted or partially-written transcript
  therefore renders as an empty conversation that *asserts it is complete*, with no
  indication anything went wrong. Note the sidecar's *other* loader already fails closed
  here (`app/sidecar/sessionResume.ts:73`: "never fall through to a fresh session") — the
  display loader silently does the opposite.
- **Fix**: Distinguish the three outcomes. Have `loadTranscriptFile` record whether the
  read/parse actually failed (a `sourceUnreadable` flag alongside `sourceTruncated`) and
  have `loadDisplayTranscriptFromJsonlPath` either throw or return `truncated: true` when
  the source could not be read, so the display never claims completeness it cannot back.

### [MED] The branch's new title call site reintroduces the orphan-transcript pattern it just fixed
- **Where**: `/Users/pt/cat-code/src/screens/REPL.tsx:3083` (new) calling
  `/Users/pt/cat-code/src/utils/sessionStorage.ts:3310` (`saveAiGeneratedTitle`)
- **Type**: correctness / design
- **What**: The branch correctly rerouted four diagnostic appenders through
  `getOwnedTranscriptPath()` (`:81`) precisely so an unowned write cannot mint an orphan
  transcript, and inherits `shouldSkipPersistence()` (`:1409`) for free. `saveAiGeneratedTitle`
  is a module-level function that calls `appendEntryToFile(getTranscriptPathForSession(sessionId), …)`
  directly, so it bypasses `Project.appendEntry` and therefore bypasses
  `shouldSkipPersistence()` entirely. Previously this was dead code (the documented past
  bug); the branch now wires it into every session's first turn.
- **Trigger / why it matters**: Run under `--no-session-persistence` (or `cleanupPeriodDays: 0`,
  or `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, which `tmuxSocket.ts` sets for test sessions). Have
  a conversation. `REPL.tsx:3083` creates `~/.cat-code/projects/<slug>/<sessionId>.jsonl`
  containing exactly one `ai-title` line, against the user's explicit instruction not to
  persist. The comment at `sessionStorage.ts:1426-1428` already names this exact hazard for
  `reAppendSessionMetadata`. The new `hasConversation === false` filter (`:5971`) hides the
  file from `/resume`, so the symptom is invisible, and `cleanupPeriodDays: 0` disables the
  cleanup that would eventually remove it.
- **Fix**: Route `saveAiGeneratedTitle` (and the sibling metadata appenders `saveCustomTitle`,
  `saveTag`, `saveTaskSummary`) through `getOwnedTranscriptPath()` the same way the
  diagnostic appenders now are, or gate them on `shouldSkipPersistence()`.

### [MED] The new gpt→claude anchor invalidation reaches only 2 of 8 call sites
- **Where**: `/Users/pt/cat-code/src/utils/tokens.ts:321-337` (new `currentModel` parameter)
- **Type**: correctness
- **What**: The new parameter forces a full re-estimation when a gpt-produced usage anchor
  would understate a Claude request. It is passed at `src/services/compact/autoCompact.ts:372`
  and `src/components/PromptInput/Notifications.tsx:94`. It is **not** passed at
  `src/components/StatusLine.tsx:50`, `src/utils/attachments.ts:4103`, `src/query.ts:671`,
  `src/utils/permissions/yoloClassifier.ts:794`, `src/screens/REPL.tsx:5203`, or
  `src/utils/swarm/inProcessRunner.ts:1349`.
- **Trigger / why it matters**: Switch mid-session from `gpt-5.6-terra` to a Claude model.
  Autocompact now correctly re-estimates and can fire; the status line still trusts the
  stale openai anchor and reports a much lower percentage. The user watches a 30% status
  line while autocompact triggers. Worse, `attachments.ts:4103` uses the un-invalidated
  count to decide whether an attachment fits — the same understatement the parameter exists
  to prevent, at the gate where it causes a 413.
- **Fix**: Either pass the model at every call site (they all have one in scope), or make
  the invalidation unconditional by deriving the current model inside
  `tokenCountWithEstimation` rather than accepting it as an optional argument that most
  callers forget.

### [MED] `ProcessedResume` fields that the engine's own restore path applies carry no type-level signal
- **Where**: `/Users/pt/cat-code/src/utils/sessionRestore.ts:293-301` (type),
  `:815-832` (construction)
- **Type**: design
- **What**: `processResumedConversation` returns some restore results as **side effects**
  (`recordContentReplacement` at `:710`, `setProviderSwitchLocked` at `:719`,
  `restoreSessionMetadata`, `adoptResumedSessionFile`) and others only as **return values**:
  `restoredAgentDef` and `initialState`. `initialState` is where the restored `threadGoal`,
  `agentDefinitions`, `agent` type, `attribution`, and `standaloneAgentContext` live
  (`:824-831`). Nothing in the type distinguishes "already applied" from "you must apply this".
- **Trigger / why it matters**: The engine's own caller applies both — `src/main.tsx:3304`
  (`mainThreadAgentDefinition = loaded.restoredAgentDef`) and `:3317`
  (`initialState: loaded.initialState`). A caller that keeps only `messages`
  (`app/sidecar/sessionResume.ts:110` returns `{ engineSessionId, messages: processed.messages }`)
  silently loses the resumed session's thread goal and refreshed agent definitions. The
  sidecar comment explicitly acknowledges the *agent* degradation but says nothing about
  `initialState`, which suggests the drop was not deliberate.
- **Fix**: Either apply `initialState`'s engine-owned parts as side effects inside
  `processResumedConversation` (matching how `contentReplacements` and the provider lock are
  already handled), or split the return type into `applied` vs `mustApply` so dropping the
  second is a compile error rather than a silent behavior change.

### [LOW] Em dash in a new user-visible notification
- **Where**: `/Users/pt/cat-code/src/screens/REPL.tsx:3716`
- **Type**: convention
- **What**: `` `/${getCommandName(matchingCommand)} is waiting for another command to finish — try again in a moment` ``
  is a toast rendered to the user and contains an em dash.
- **Trigger / why it matters**: CLAUDE.md §7 states the rule unscoped for user-readable
  text; the review contract restates it unscoped. Noting honestly that the rule's stated
  verification command is scoped to `app/renderer/src` and `src/` already carries
  pre-existing violations (`REPL.tsx:1897`, `:2589`, `:5277`), so this is a convention drift
  rather than a regression — but it is a **new** line, which is the cheapest moment to fix it.
- **Fix**: `… is waiting for another command to finish. Try again in a moment`.

### [LOW] `readLiteMetadata`'s spacing-variant comment is factually wrong
- **Where**: `/Users/pt/cat-code/src/utils/sessionStorage.ts:5672-5675`
- **Type**: quality
- **What**: The comment justifies matching both `"type":"user"` and `"type": "user"` with
  "the transcript writer emits compact JSON while the diagnostic appenders emit spaced JSON."
  Both go through `jsonStringify` (`:3220` and `:1089`), which is `JSON.stringify` with no
  `space` argument (`src/utils/slowOperations.ts:189`). Every writer emits compact JSON;
  the spaced variants match nothing.
- **Trigger / why it matters**: The comment is the entire justification for a heuristic that
  now gates whether a session appears in `/resume` at all (`:5971`) and in the desktop
  sidebar (`app/sidecar/sessionsCatalogDomain.ts:186`). A future reader will trust a
  premise that is not true and reason wrongly about the filter's coverage.
- **Fix**: Correct the comment to say the spaced variants are defensive against a
  hypothetical future writer, or drop them.

### [LOW] Unnecessary `as` cast hides a real settings type
- **Where**: `/Users/pt/cat-code/src/utils/reasoningDisplay.ts:23`, duplicated at
  `/Users/pt/cat-code/src/commands/reasoning/reasoning.tsx:16`
- **Type**: quality
- **What**: `(getInitialSettings() as { reasoningDisplay?: unknown }).reasoningDisplay`.
  `reasoningDisplay` is a declared top-level settings field with a `z.enum(['off','summary','raw'])`
  schema (`src/utils/settings/types.ts:725`) and is registered in
  `src/tools/ConfigTool/supportedSettings.ts:113`, so `SettingsJson` already types it exactly.
- **Trigger / why it matters**: The cast widens a precise union to `unknown` and would keep
  compiling if the setting were renamed or removed from the schema, silently reverting
  every user to the `'summary'` default with no type error. The manual re-validation on the
  next line then exists only because the cast threw the type away.
- **Fix**: Drop the cast and read `getInitialSettings().reasoningDisplay` directly; the
  narrowing check becomes redundant.

### [LOW] `applyDisplayPreservedSegmentRelinks` is 85 lines of un-legible pointer surgery
- **Where**: `/Users/pt/cat-code/src/utils/sessionStorage.ts:2530-2614`
- **Type**: quality
- **What**: One function performs four distinct passes over a mutable `Map` — collect the
  preserved segment, walk the archival chain backwards, rewrite every archival parent
  forwards, then a full `for (const [uuid, message] of messages)` sweep to re-target
  anchor children — with three separate cycle guards and mutation of the map it is
  iterating. It is O(K·N) in boundaries × messages.
- **Trigger / why it matters**: This is the code that decides whether a restored desktop
  transcript shows history around a compaction seam exactly once or duplicated. The
  correctness argument (mutating a `Map` while its `values()` iterator is live is safe here
  only because `Map.set` on an existing key preserves position, and because candidates are
  processed in file order so no candidate is its own ancestor) is nowhere stated and is not
  obvious. There are tests (`sessionStorage.test.ts:337`, `:461`, `:564`, `:602`, `:630`,
  `:657`), which is why this is LOW rather than higher.
- **Fix**: Extract the three phases into named helpers (`collectPreservedUuids`,
  `walkArchivalChain`, `rewriteArchivalParents`) and state the map-mutation invariant in a
  comment, since it is the load-bearing assumption.

### [LOW] `generateSessionTitle`'s abort signal is dead by construction
- **Where**: `/Users/pt/cat-code/src/screens/REPL.tsx:3076`
- **Type**: quality *(pre-existing; the surrounding block is new)*
- **What**: `generateSessionTitle(deferredSessionTitleText, new AbortController().signal)` —
  the controller is constructed inline and no reference is retained, so `.abort()` can never
  be called. `sessionTitle.ts:130` threads the signal all the way into the API call, where
  it is inert.
- **Trigger / why it matters**: The user exits the session while the title request is in
  flight; the request cannot be cancelled and continues to run (and `setHaikuTitle` fires on
  an unmounted component). The function's `signal` parameter reads as working cancellation
  plumbing at every other call site.
- **Fix**: Hold the controller in a ref and abort it from the REPL's unmount cleanup.

## What is good here

- **`getOwnedTranscriptPath` / `getOwnedAgentTranscriptPath`** (`sessionStorage.ts:81`, `:588`)
  are the right fix at the right layer: they replace "derive a path from an id" with "ask an
  owner", read the singleton directly so a diagnostic cannot construct the `Project` as a
  side effect, and the doc comments state the failure they prevent with the actual count
  (162 of 514 files). This is the pattern the metadata appenders should adopt (see the MED
  finding above).
- **The two new untracked tests are behavioral, not implementation restatements.** Both
  `src/utils/sessionTitle.test.ts` and `src/commands/rename/generateSessionName.test.ts`
  mock at the real seam (`queryModelWithoutStreaming`) and assert the observable output —
  the model and provider actually sent. They exercise the genuine decision path:
  `getSmallFastModelForProvider` (`src/utils/model/model.ts:60-65`) branches on exactly the
  `isCodexSubscriber()` the tests flip. Reverting to `getSmallFastModel()` makes the first
  test in each file fail. (Honest caveat: the *second* test in each file — "keeps the
  Anthropic default off the Codex fork" — passes with or without the fix, so only one of the
  two is a regression guard.)
- **Both documented past bugs are genuinely fixed.** `saveAiGeneratedTitle` is no longer
  dead code — it is called from `REPL.tsx:3083`, correctly guarded against clobbering a
  user-set title. `/resume` ordering no longer uses mtime: `readLiteMetadata` extracts
  `lastTimestamp` from the tail (`sessionStorage.ts:5669`), `enrichLog` substitutes it for
  the mtime fallback (`:5922-5925`), and `getSessionLogs` re-sorts on the corrected value
  with the reason stated (`:4937-4941`).
- **`setLatestMapValue`** (`sessionStorage.ts:35`) is a small, well-explained fix for a
  genuinely subtle bug: `Map.set` does not reposition an existing key, so iteration order
  only represents append order if you delete first. The comment says exactly that.
- **The deferred-continuation resume locking** (`sessionRestore.ts:123-204`) gets the hard
  parts right: it probes-and-releases rather than holding a REPL-lifetime lock, re-acquires
  around the actual adopt to close the after-probe window, runs the check before any state
  is touched so a blocked resume changes nothing, and leaves staleness to the store so a
  crashed worker cannot brick resume. `restoreTrustedDeferredContinuationContext` (`:43`)
  `realpath`s both sides before the `relative()` containment check, so symlink escapes are
  resolved rather than compared textually.
- **Every new module and export in scope is wired.** `immediateCommand.ts` and
  `reasoningDisplay.ts` both have real production consumers (`REPL.tsx`,
  `handlePromptSubmit.ts`, `processSlashCommand.tsx`, `commands/{model,fast,effort}/index.ts`,
  `Message.tsx`, `Messages.tsx`, `messages.ts`), as do `loadDisplayTranscriptFromJsonlPath`,
  `recordRunFacts`, `recordDeferredContinuationResult`, `flushCurrentTranscriptDurably`, and
  `hasConversation`. No dead code found in this scope.

## Explicit answers to the audit questions

- **NUL bytes (scope item 5): verified negative.** No write path in scope can introduce a
  raw NUL into a file on disk. Every transcript write goes through `jsonStringify`
  (`sessionStorage.ts:3220`, `:1089`) = `JSON.stringify` (`src/utils/slowOperations.ts:189`),
  which escapes U+0000 to the six-character sequence `\u0000` (backslash-u-zero-zero-zero-zero) (verified empirically). The
  only raw-bytes write in scope is `removeMessageByUuid`'s slow path, and its content comes
  from the file itself. All nine scoped source files are themselves NUL-free.
  Separately: `attachments.ts`'s `+212` is entirely the teammate-mailbox classification
  path — it contains **no** changes to file-attachment path handling, traversal, size limits,
  or binary handling, so those sub-questions have no new surface to review on this branch.
- **Corrupt/truncated transcripts degrade rather than throw (scope item 2): confirmed at the
  parse layer.** `parseJSONL` skips malformed lines (`src/utils/json.ts:145`, `:167`), and
  `loadTranscriptFile`'s IO+parse is inside a catch (`sessionStorage.ts:4453`), including the
  new `keepCompactedHistory` byte-window branch. The new branch also correctly discards a
  leading partial line when the window does not start at a newline (`:4271-4278`). The
  problem is not that it throws — it is that it degrades *too* quietly (see the MED finding).
- **Growth bounds:** nothing in `sessionStorage.ts` prunes a transcript. Growth is bounded
  only externally, by the `cleanupPeriodDays` age-based sweep, which the user can disable
  (and setting it to `0` disables persistence entirely). Read paths are bounded
  (`LITE_READ_BUF_SIZE` 64 KB head+tail, `SKIP_PRECOMPACT_THRESHOLD`,
  `MAX_TOMBSTONE_REWRITE_BYTES` 50 MB, `MAX_JSONL_READ_BYTES` 100 MB, the new `maxReadBytes`),
  but a single session's file has no size cap. This appears intentional; flagging it as a
  documented property rather than a finding.

## Not reviewed / uncertain

- **Multi-*process* append interleaving.** `appendEntryToFile` uses `fs.appendFileSync`
  (O_APPEND). POSIX makes the seek-to-end and write atomic per `write(2)` call, but Node
  loops `writeSync` until all bytes land, so an entry large enough to be split across
  multiple syscalls could in principle interleave with another process's append. I could
  not produce a concrete trigger — regular-file writes generally complete in one call — so
  I am **not** reporting it. What would resolve it: a test that appends a >8 MB entry from
  two processes concurrently and checks for a torn line. Note the branch's new
  deferred-continuation locking (`sessionRestore.ts`) already prevents the realistic
  cross-process case (a background runner appending to a transcript being resumed).
- **`hasConversation` false negatives.** I convinced myself the heuristic is safe — `type`
  is serialized early in every user/assistant line (byte ~100, verified against a real
  transcript), so the 64 KB head window catches it, and escaped content (`\"type\":\"user\"`)
  cannot false-positive. I did **not** exhaustively enumerate entry shapes. What would
  resolve it: a corpus scan asserting `hasConversation === true` for every transcript that
  `loadTranscriptFile` returns at least one user/assistant message for.
- **`fsync` on an O_RDONLY descriptor** in `flushCurrentTranscriptDurably`
  (`sessionStorage.ts:2086-2091`). Linux and Darwin both permit this and it does flush the
  file's dirty pages, so I did not report it — but it is unusual enough to be worth a
  comment in the source. What would resolve it: a live durability test on the target
  platforms.
- **Whether `initialState` being dropped by the sidecar is deliberate.** I verified the
  engine caller applies it and the sidecar does not, and that the sidecar's comment
  acknowledges only the *agent* degradation. Whether the thread-goal loss is a known,
  accepted deviation is a question for the desktop-side owner, not something I could
  settle from `src/`.
- I did not run any test suite. All claims above are from source reading, one real
  transcript on disk, and a single `node -e` check of `JSON.stringify` NUL escaping.
