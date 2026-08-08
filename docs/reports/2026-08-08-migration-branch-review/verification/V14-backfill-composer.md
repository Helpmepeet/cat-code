# V14 adversarial validation: transcript backfill + composer/permission/context state

> **Verification provenance:** Claude Opus 5, high effort. Source review of the
> A14 pipeline (`app/main/transcriptBackfill.ts`, `transcriptCache.ts`,
> `sessionsCatalogBaseline.ts`, `mainDecisions.ts`, `replayBuffer.ts`,
> `attachmentGate.ts`, `app/shared/transcriptBackfill.ts`,
> `app/sidecar/transcriptBackfillWorker.ts`, `transcriptRunFacts.ts`) and the A16
> modules (`contextUsage.ts`, `tokenWarning.ts`, `permissionState.ts`,
> `permissionPromptModel.ts`, `composerState.ts`, `ComposerInput.tsx`,
> `tabStatus.ts`, `askQuestionState.ts`, `planState.ts`, `composerPopover.ts`,
> `slashCommandPickerModel.ts`, the nine snapshot-domain modules) plus the engine
> denominators (`src/utils/analyzeContext.ts`, `src/utils/tokens.ts`,
> `src/services/compact/autoCompact.ts`, `src/components/StatusLine.tsx`,
> `TokenWarning.tsx`, `ExitPlanModePermissionRequest.tsx`, `scripts/build.ts`).
> **Seven standalone scratch scripts** importing the REAL repo modules, run under
> Bun outside the repo
> (`/private/tmp/claude-501/.../scratchpad/v14/`): context-denominator
> arithmetic, the tab-badge frame sequence through the real reducers, a
> `selectUsedTokens` benchmark at the 8,000-message cap, a REAL-process backfill
> spawn, a fake-child backfill runner, a live-store cache census, and a
> header-probe poisoning repro. One focused test file
> (`bun test app/renderer/src/contextUsage.test.ts` — 29 pass / 0 fail). No GUI,
> no app launch, no full suite, no repo edits. Branch `migration` at `a1012b1`.

## Overall verdict

Of 26 findings, **14 are CONFIRMED, 9 PARTIALLY CONFIRMED, 1 OVERSTATED, 1
INVALID, 1 UNPROVEN.** Both reports are substantially right about mechanisms and
wrong about consequences more often than about code. **A14's clean bills survive
almost intact** — I attacked all seven and broke only one phrasing (a renderer id
*does* reach `join()`, behind two gates); main really never opens a `.jsonl`, the
boundary validator really is shared, and every JSONL parse really does degrade
per-line. But A14's *evidence* is weaker than its findings: its corroboration for
F3 ("the two largest live caches … i.e. already truncated artifacts") is wrong —
one of the two carries no truncation notice at all and the other's notice comes
from a different, now-deleted code path — and its F2 cost figure overstates the
measured hitch by 3–6×. **A16's one HIGH is half right and half false**, and the
half that survives is the desktop-internal contradiction, not the
desktop-vs-engine one; its premise "every user-facing context percentage in the
engine divides by the effective window" is false for `/context` *and* for the
default `TokenWarning`, and one of its three cited engine sites sits behind a
feature flag that is **not in `scripts/build.ts`'s list at all**. The single most
dangerous item in either report is **A16's LOW "`describeSuggestion` is
production-dead"**: it is not — `debugStateReport.ts:88` calls it — so applying
its "delete the function" fix breaks the build. That is the false-dead-claim the
brief warned about, and it is the one finding I would refuse outright.

## Summary

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| **A16-F1** | HIGH | Context gauge divides by the raw window | **PARTIALLY CONFIRMED** | Donut/glyph contradiction reproduced exactly (84% vs 0% left); but `/context` and default `TokenWarning` also do NOT use the effective window, and `TokenWarning.tsx:144` is behind an uncompiled feature flag |
| A16-F2 | MED | Tab attention badge has no connection gate | PARTIALLY CONFIRMED | Divergence reproduced through the real reducers; "pulse forever" refuted — every death path delivers a `lifecycle` frame that clears the queue |
| A16-F3 | MED | `permission_not_found` re-arms the card | UNPROVEN | Code shape exact, but the engine cannot drop a pending request without emitting `permission.resolved`; and the claimed transport-error banner does not exist on this path |
| A16-F4 | MED | `selectUsedTokens` rescans the whole log | OVERSTATED | Three unbounded passes are real; measured 0.063–0.203 ms/call at the 8,000 cap, against 0.038 ms the store already spends per delta |
| A16-F5 | MED | Seven identical snapshot-domain modules | PARTIALLY CONFIRMED | Under-counted (nine, not seven); "token-identical down to the comment across all seven" is false — 2 of the 7 lack it, and 2 modules it missed have it |
| A16-F6 | LOW | `reducePasteRemoved` production-dead | CONFIRMED | Only importer is `composerState.test.ts` |
| **A16-F7** | LOW | `describeSuggestion` production-dead | **INVALID** | `debugStateReport.ts:15,88` imports and calls it; the proposed deletion breaks compilation |
| A16-F8 | LOW | `composerPopover.ts` unused imports + re-export | CONFIRMED | Both symbols unreferenced in the body; consumer split verified (a 7th consumer missed) |
| A16-F9 | LOW | `selectGenericPermissionQueue` signature/doc | CONFIRMED | Takes a queue, siblings take state, composition is at `App.tsx:2391-2393` |
| A16-F10 | LOW | `addSessionPaste` writes from a stale closure | CONFIRMED | Non-functional `setPasteState` at `:2225`; other three sites use `prev =>` |
| A16-F11 | LOW | External draft write lost during IME composition | PARTIALLY CONFIRMED | `onCompositionEnd` → `handleInput()` → DOM read wins, verified; the parked-release race itself not demonstrated |
| A16-F12 | LOW | `buildAllowResponse` ignores its first parameter | CONFIRMED | `_request` unread; both call sites `.find()` purely to feed it |
| A16-F13 | LOW | `nextSlashIndex` also drives the mention picker | CONFIRMED | True, but the cited mention call sites are wrong (`:4053,:4059`, not `:4160,:4165`) |
| A14-F1 | MED | Backfill runner keeps trusting a terminated worker | PARTIALLY CONFIRMED | Handler property proven with a controlled child; a REAL spawn never reproduced it at 0–60 ms record spacing |
| A14-F2 | MED | Persist path full-parses twice per session on the main thread | PARTIALLY CONFIRMED | Both `readCache` calls exact; measured 7.6 ms worst / 15.3 ms per session, not "~50 ms hitches" |
| A14-F3 | MED | Backfill always replaces an on-close cache; half the budget | PARTIALLY CONFIRMED | Mechanism exact (`runFactsVersion ?? 0` vs 1; 4k/4MiB vs 8k/8MiB); the disk corroboration is wrong |
| A14-F4 | MED | Cache freshness stamped at write time | CONFIRMED | `writtenAt: Date.now()` at persist; window is sub-second but the staleness miss is permanent |
| A14-F5 | MED | Read gate weaker than the write gate | CONFIRMED | `isTranscriptCacheFrame` (18 lines) vs `parseTranscriptFrame` (~260); renderer compensates downstream |
| A14-F6 | MED | `readTranscriptRunFacts` reads with no size bound | CONFIRMED | `readFileSync(path,'utf8').split('\n')`; sibling call 20 lines away passes `maxBytes` |
| A14-F7 | LOW | `MAX_OUTBOUND_FRAME_BYTES` check is dead | CONFIRMED | Redundant sub-condition; wrong cap cited in a directional-limit-sensitive file |
| A14-F8 | LOW | Orphaned `.tmp` cache files can never be reaped | CONFIRMED | `listCachedSessionIds` filters `.json`; GC enumerates only through it |
| A14-F9 | LOW | Header probe regexes over raw frame bytes | PARTIALLY CONFIRMED | Poisoning **reproduced** for `runFactsVersion` via a JSON *key*; REFUTED for `writtenAt`, and the report's own "pasting this review" trigger does not work |
| A14-F10 | LOW | `String()` coercion inside the fail-closed parser | CONFIRMED | Reproduced: `reason: ["invalid"]` is accepted and returned as an array |
| A14-F11 | LOW | `isRecord` defined 3×, two meanings | CONFIRMED | Counts reproduced: 15 `isRecord` defs, 4 `UUID_RE` copies under `app/` |
| A14-F12 | LOW | Content-block allowlist three types behind | PARTIALLY CONFIRMED | Two behind, not three: `compaction` is a stream block, not a history block. Scan independently reproduced |
| A14-F13 | LOW | Truncation notice misdescribes two of three paths | CONFIRMED | Both `continue` branches drop mid-transcript; `N===0` slips the `frames.length===0` guard |

---

# Part 1 — the contested HIGH, settled

### A16-F1 — [HIGH] Context gauge divides by the raw window; every engine context percentage divides by the effective window

- **Verdict**: **PARTIALLY CONFIRMED**
- **Cited location holds?**: Yes for the desktop half. `contextUsage.ts:376-380`
  is `if (contextWindow <= 0) contextWindow = DEFAULT_CONTEXT_WINDOW` followed by
  `percentUsed = clamp(round(usedTokens / contextWindow * 100))`;
  `runControlsDomain.ts:573-578` is `readContextWindow` returning
  `getContextWindowForModel(model, getSdkBetas())`. `src/utils/tokens.ts:52-59`
  is `getTokenCountFromUsage` and `autoCompact.ts:40-56` is
  `getEffectiveContextWindowSize`, both exactly as quoted. **Two of the three
  engine citations do not hold as characterised** (below).

### The settled picture — every numerator/denominator pair and its consumer

Recomputed from the real functions
(`scratchpad/v14/context-denominators.ts`), not from either prior report.
`D1` = `getContextWindowForModel` (raw). `D2` = `getEffectiveContextWindowSize`
= `min(D1, CLAUDE_CODE_AUTO_COMPACT_WINDOW?) − min(getMaxOutputTokensForModel, 20_000)`.
`D3` = `getAutoCompactThreshold` = `D2 − (3_000 + clamp(0.08·D2, 10_000, 50_000))`.
`N1` = `getFreshInputTokens` (input + cache_creation). `N2` =
`getTokenCountFromUsage` (all four buckets), `N2+est` adds
`roughTokenCountEstimationForMessages`. `N4` = three input buckets, **no output**.

| Surface | Consumer / gate | Numerator | Denominator |
|---|---|---|---|
| `/context` headline `percentage` (`analyzeContext.ts:1465`) | terminal `/context`, no gate | **N1** (`:1286`), falling back to the estimated total | **D1** (`:1031`) |
| `/context` grid squares + category % | same screen | estimated category tokens | **D1** |
| `/context` "Autocompact buffer" row | same screen | — | **D3** |
| `StatusLine` `used_percentage` / `context_window_size` (`StatusLine.tsx:51-52,100-102`) | **opt-in**: `settings.statusLine !== undefined` (`:35-40`) | **N2+est** | **D2** |
| `TokenWarning` default footer (`calculateTokenWarningState`, `autoCompact.ts:257-264`) | default UI, only above the warning threshold | **N2+est** | **D3** (or D2 when auto-compact is off) |
| `TokenWarning.tsx:144` (`reactiveOnlyMode`/`collapseMode`) | **`feature('REACTIVE_COMPACT')` / `feature('CONTEXT_COLLAPSE')` — neither name is in `scripts/build.ts`'s `defaultFeatures` or `fullExperimentalFeatures`, so it is compiled out of every build incl. `dev-full`** | N2+est | D2 |
| `ExitPlanModePermissionRequest.getContextUsedPercent` (`:759-765`) | plan-approval prompt | **N4** (drops output) | **D2** |
| **Desktop donut** `selectContextUsage` (`contextUsage.ts:377-381`) | always on in the composer rail | **N2** (stream fold, no estimate) | **D1** (result frame's `modelUsage[].contextWindow`, else `RunControlsSnapshot.model.contextWindow`, else 200k) |
| Desktop auto-compact glyph `selectTokenWarning` (`tokenWarning.ts:69-72`) | rail, above warning threshold | **N2** | **D3** (sidecar-supplied `autoCompact.threshold`) |
| Desktop breakdown rows `percentOfWindow` (`contextBreakdownState.ts:202`) | context popover | per-category tokens | `ContextBreakdownSnapshot.contextWindow` = `analyzeContextUsage.maxTokens` = **D1** |
| Desktop preview donut (`previewTranscriptState.ts:231`) | preview pane | N2 | **D1** (no `modelContextWindow` passed at all) |

**Which specific A16 claims survive:**

1. **"`selectContextUsage` divides by the model's raw context window."** SURVIVES,
   exactly.
2. **"On a 200k model that is an 8-percentage-point understatement."** SURVIVES
   *for A16's own worked example*. Measured: 140,000 used on a 200k model →
   donut 70%, StatusLine 78%, **gap = 8 points exactly**. It is not a constant —
   the gap scales with usage (9 pt at 167k, 10 pt at 180k, and only 2–5 pt on
   `gpt-5.6-terra`, whose D1 is 372k). A16 states it as if general; it is not.
3. **"It makes the composer rail contradict itself (donut 84% beside a glyph
   reading 0% left)."** SURVIVES and is the strongest part of the finding.
   Reproduced end to end through the REAL desktop functions at 167,000 used on a
   200k model:
   ```
   selectContextUsage = {"usedTokens":167000,"contextWindow":200000,"percentUsed":84} tone = warn
   selectTokenWarning = {"percentLeft":0,"autoCompactEnabled":true}
   ```
   And 167k is genuinely reachable: `getBlockingLimit` on that model is 177,000.
   This is a *desktop-internal* contradiction between two numbers on one rail —
   no engine surface is involved — which is why it survives regardless of how the
   engine-side dispute resolves.
4. **"Every user-facing context percentage in the engine divides by
   `getEffectiveContextWindowSize`."** **DOES NOT SURVIVE.** `/context` — the
   engine's most explicit context surface — divides by D1 (`analyzeContext.ts:1031,1465`),
   and the default `TokenWarning` divides by D3, not D2. V27 is right on this
   point and A16's premise as written is false.
5. **"consumed by … `TokenWarning.tsx:144`."** **MIS-LOCATED AND UNREACHABLE.**
   That line lives inside `if (reactiveOnlyMode || collapseMode)`, set only under
   `feature('REACTIVE_COMPACT')` / `feature('CONTEXT_COLLAPSE')`. Neither name
   appears in `scripts/build.ts` (`defaultFeatures = ['TRANSCRIPT_CLASSIFIER','VOICE_MODE']`;
   `fullExperimentalFeatures` runs `AGENT_MEMORY_SNAPSHOT`…`VOICE_MODE` with
   neither), so `bun build --feature=…` never enables it and the branch is folded
   away in every build. The default path's denominator is D3.
6. **"consumed by … `ExitPlanModePermissionRequest.tsx:19-20`."** The citation is
   the *import* line; the use is `:759-765`. It does use D2 — but with a fourth
   numerator (N4, no output tokens), so it is not evidence for "the numerator
   matches".
7. **"The numerator matches (`getTokenCountFromUsage`, all four buckets)."**
   Survives only against `StatusLine` (modulo the rough estimate the renderer
   deliberately omits). It is false against `/context` (N1) and against
   ExitPlanMode (N4).

### Reconciliation with V27 and V30

- **V27 is right that A16's premise is false for `/context`**, and its
  1% / 42% / 44% / 49% table is arithmetically correct — I re-derived D1/D2/D3
  for `gpt-5.6-terra` and got the same 372,000 / 352,000 / 320,840.
- **V27 is wrong to conclude the donut "agrees with neither."** That is true of
  the *reported number* but conflates two questions. On denominators the donut
  agrees with `/context` and the breakdown page (all D1) and disagrees with
  StatusLine (D2) and both TokenWarnings (D3). On numerators the donut agrees
  with StatusLine and both TokenWarnings (N2) and disagrees with `/context` (N1).
  The two defects are independent and V27 says so; but "agrees with neither" is
  the wrong summary of a gauge that shares a denominator with two engine surfaces
  and a numerator with three.
- **V30's "no 8-point figure in the source report"** is about X02a, not A16. A16
  *does* state it, and it is right for its example.
- **V30's "the red band is unreachable"** is CONFIRMED for a 200k model
  (max donut before the engine blocks = 88% → `pressureTone` = `warn`) but
  **REFUTED as a general claim**: on `gpt-5.6-terra`, blocking is at 349,000 of a
  372,000 window → 94% → `pressureTone` = `danger`. The red band is dead UI on
  Claude 200k models only.

### Does A16's proposed fix break the grid or the breakdown wire fields?

**No — V27's warning is mis-applied to A16.** V27's caution is about changing
`/context`'s denominator in `analyzeContext.ts`, which would desync the grid,
`percentageOfTotal`, `Free space`, and `ContextBreakdownSnapshot.maxTokens`. A16
proposes something different: change `readContextWindow` at
`runControlsDomain.ts:573`. I traced every consumer of what that feeds:

- `readContextWindow` → `runControlsDomain.ts:458` → `RunControlsSnapshot.model.contextWindow`
  (`protocol.ts:1618`) → **exactly one renderer read**, `App.tsx:3924`, passed to
  `selectContextUsage`. Nothing else in `app/` reads it.
- The breakdown panel's window is a **different wire field**,
  `ContextBreakdownSnapshot.contextWindow = data.maxTokens`
  (`contextBreakdownDomain.ts:172`, `protocol.ts:1064`), untouched by that change.

So the fix is narrower than V27 feared. It nevertheless has **three real
problems A16 did not state**:

1. **It only half-fixes the gauge.** `selectContextUsage` prefers the *result
   frame's* `modelUsage[model].contextWindow` (raw, from `src/cost-tracker.ts:107`)
   and falls back to `modelContextWindow`. A16's second sentence ("use
   `modelContextWindow` in preference") acknowledges this, but the preview path
   (`previewTranscriptState.ts:231`) calls `selectContextUsage(messages, model)`
   with **no** `modelContextWindow` at all, so previewed sessions would keep the
   raw window while live ones moved. Three code paths, one number.
2. **It breaks a live test.** `runControlsDomain.test.ts:393-396` asserts
   `opus.contextWindow === 1_000_000` **and** `=== getContextWindowForModel('claude-opus-5', getSdkBetas())`;
   `:405-407` asserts the same identity for `haiku`. Both fail.
3. **It falsifies the field's own doc.** `protocol.ts:1607-1618` states this field
   is "resolved at the sidecar by the engine's own `getContextWindowForModel` …
   the very function whose output the live gauge otherwise reads off a `result`
   frame".

- **Reachable in production?**: Yes for every surviving half — the donut is the
  always-on composer rail gauge with no gate, and the glyph is default UI above
  the warning threshold. The one *unreachable* piece is the `TokenWarning.tsx:144`
  citation (feature-flag, above).
- **Counter-arguments considered**: (a) *Is the raw window a deliberate choice?*
  Yes, and `contextUsage.ts:57-76` argues for it under the don't-re-derive rule
  (§10) — the value on the wire is legitimately the engine's own. The defect is
  only that `percentUsed` and `pressureTone` divide by it while the glyph beside
  them divides by D3. (b) *Does `tokenWarning.ts` already reconcile them?* No, and
  `tokenWarning.ts:41-47` says so verbatim. (c) *Is `contextUsage.ts` dirty in a
  way that invalidates the citation?* It is dirty, but `git diff` shows a
  **comment-only** change to `pressureTone`'s doc block (`@@ -86,15 +86,19 @@`);
  the arithmetic at `:376-380` is untouched, and `bun test app/renderer/src/contextUsage.test.ts`
  is 29 pass / 0 fail on the working tree.
- **True consequence**: The composer rail shows two numbers about the same
  quantity computed on two bases, and at the moment that matters they read 84%
  and "0% left". The donut under-reports pressure by 8–10 points against
  `StatusLine` on a 200k model (2–5 on GPT), and its `danger` band is dead UI on
  200k models. The gauge does NOT contradict `/context`'s denominator — that is a
  separate, engine-internal numerator defect that belongs to V27/S07.
- **Evidence**: `scratchpad/v14/context-denominators.ts` (output above);
  `scripts/build.ts:13-50,83-110,180-183`; `rg -n "getEffectiveContextWindowSize" src/ app/ --glob '!*.test.*'`
  (11 non-test hits, enumerated in the table); `rg -n "runControlsContextWindow" app/renderer/src`
  (3 hits, all in the one memo).
- **Disposition**: **Do not apply the report's fix as written.** Fix the
  *contradiction*, not the *denominator*, and do it in one place the whole rail
  reads. Concretely: ship the effective window as a NEW additive field beside the
  raw one (`RunControlsSnapshot.model.effectiveContextWindow`), have
  `selectContextUsage` take it as an explicit third input used only for
  `percentUsed`/`pressureTone` while `contextWindow` keeps meaning the raw window
  (so the breakdown, the wire doc and `runControlsDomain.test.ts` all stay true),
  and re-base `pressureTone`'s 90/70 ladder on the sidecar's own
  `autoCompact.threshold` rather than a fixed percentage — that is the only
  threshold the engine actually acts on, and keying off it makes the donut and the
  glyph agree by construction instead of by coincidence. Also fix the preview path
  (`previewTranscriptState.ts:231`) in the same change or the two panes disagree.
  Finally, strike `TokenWarning.tsx:144` from the finding: it is behind an
  uncompiled feature.

---

# Part 2 — A16's remaining findings

### A16-F2 — [MED] The tab "permission request waiting" badge has no connection gate; the pane that would satisfy it does

- **Verdict**: **PARTIALLY CONFIRMED** (mechanism yes; "indefinitely" no)
- **Cited location holds?**: Yes, all of it. `permissionState.ts:291-300` is
  `selectPendingPermissionCount` with no connection condition;
  `tabStatus.ts:108` and `:131` both return
  `needsAttention: pendingPermissionCount > 0 && !isActive`;
  `TabBar.tsx:269` is the `", permission request waiting"` aria-label and `:285`
  the `<AttentionBadge/>`; `App.tsx:2371-2394` gates the queue, the plan review
  and the ask flow on `sessionConnection.status === 'ready'` in all three places;
  `permissionState.ts:154-160` resets only on `lifecycle` and `:162-170` touches
  only `submittedRequestIds`; `connectionState.ts:260-268` maps the three error
  codes to `dead`/`starting`/`disconnected`.
- **Reachable in production?**: Yes. Wired live at `App.tsx:1067-1074` inside the
  `tabs` memo, whose deps include `connection` and `permissions`.
- **Trigger**: Reproduced against the real reducers
  (`scratchpad/v14/a16-badge.ts`), feeding one frame sequence to
  `reducePermissionState` + `reduceConnectionState` and reading
  `deriveTabVisualState` and the rail's own gate:
  ```
  after ready           : conn=ready        pendingCount=0 rail=0 needsAttention=false
  after permission.req  : conn=ready        pendingCount=1 rail=1 needsAttention=true
  after error(disconn.) : conn=disconnected pendingCount=1 rail=0 needsAttention=true   <- badge over an empty rail
  after error(not_found): conn=dead         pendingCount=1 rail=0 needsAttention=true
  after error(not_ready): conn=starting     pendingCount=1 rail=0 needsAttention=true
  after lifecycle       : conn=disconnected pendingCount=0 rail=0 needsAttention=false  <- cleared
  ```
- **Counter-arguments considered** — this is where the finding narrows:
  1. *Does anything clear `pending` when the session dies?* **Yes, and the report
     missed it.** Any `lifecycle` frame resets the queue outright
     (`permissionState.ts:154-160`), and main mints a `lifecycle` frame from
     every supervisor `exit` and every terminal `status`
     (`mainDecisions.ts:70-84`). So the divergence lasts only from the `error`
     frame until the `lifecycle` frame — bounded by the supervisor's
     `disconnectSettleMs ?? 250` (`supervisor.ts:181,547-560`), or zero when the
     child already exited.
  2. *Does idle-park hold it open?* **No.** I ran the park path with the real
     `PARKED_EXIT_CODE` lifecycle frame: `pendingCount` drops to 0 and
     `needsAttention` goes false. Park is a lifecycle frame by construction —
     `connectionState` reads the park exit code off it — so it always clears.
  3. *Does the report's own citation support "forever"?* **No.**
     `App.tsx:1892-1895` says a **parked session closed by the user** never
     receives a lifecycle frame. A closed session has no tab, so it has no badge.
     That comment cannot support a claim about a background *tab*.
  4. *Could the sidecar keep emitting `permission.requested` while
     `connectionState` is stuck non-`ready`?* I looked for a route and found
     none: only a `ready` frame restores `ready`, and every path that leaves
     `ready` also produces a lifecycle frame that empties the queue.
- **True consequence**: A background tab pulses amber with a
  ", permission request waiting" aria-label over an empty rail for the window
  between a failed verb's `error` frame and the session's `lifecycle` frame —
  typically ≤250 ms, occasionally longer if the socket drop settles slowly. Real
  and worth fixing on consistency grounds; not the indefinite stranding claimed.
- **Evidence**: `scratchpad/v14/a16-badge.ts` (output above);
  `supervisor.ts:181,535-560`; `mainDecisions.ts:70-84`.
- **Disposition**: Apply the report's second option (gate
  `selectPendingPermissionCount` the same way the rail is gated), not its first.
  Passing the status into `deriveTabVisualState`'s attention calculation means
  writing the same predicate in two files again; putting the gate in the selector
  keeps one answer. Reclassify as **LOW** — a ≤250 ms visual mismatch is not MED
  work. Note `PermissionQueue.tsx:47-51` already documents that
  `selectPendingPermissionCount` "measures the whole session (including the plan
  and question surfaces that own their own cards)", so any gate added must not
  quietly change that second meaning.

### A16-F3 — [MED] `permission_not_found` re-arms the card instead of removing the request

- **Verdict**: **UNPROVEN** (leaning INVALID)
- **Cited location holds?**: Yes. `permissionState.ts:162-170` ignores
  `frame.code` and un-submits any error whose `requestId` is in
  `submittedRequestIds`. `sidecarServer.ts:2296-2306` (permission responses) and
  `:2467-2478` (AskUserQuestion answers) both mint `permission_not_found` from
  the same `getPendingPermissionRequests()` lookup.
- **Reachable in production?**: **The reducer branch is; the state it needs is
  not, as far as I can establish.** The finding's stated precondition is "a
  `permission.resolved` event is ever missed". `AppSessionController`'s
  `pendingPermissionRequests` map is mutated in exactly two places
  (`src/app-runtime/AppSessionController.ts:235` set-with-`permission.requested`-emit,
  `:104` delete-with-`permission.resolved`-emit) — including inside `abort()`
  (`:124-128`), which resolves every pending request with a deny rather than
  dropping them. There is no path by which the engine forgets a request without
  telling the renderer. Frame loss would have to come from transport, and a
  transport failure produces a `lifecycle` frame (queue reset) or a reload
  (`ready` rebuild from the engine snapshot, `permissionState.ts:112-138`).
- **Trigger**: I could not construct one. The nearest reachable state is a race:
  the user clicks Allow at the same moment the engine aborts the turn. Then
  `permission.resolved` and the `permission_not_found` error are both in flight;
  whichever order they arrive in, `removeRequest` deletes the card. There is no
  loop.
- **Counter-arguments considered**: (a) *Does the `answered` guard save it?*
  Only until the error lands — `App.tsx:2272-2276` reads `submitted` from the very
  list the error branch clears, and `App.tsx:2269-2271` already documents this
  exact interaction in a comment ("that rejection un-marks the card as
  answered"). So the mechanism is real and known. (b) *Does the second click
  really raise a banner, as claimed?* **No.** `setTransportErrors` is called at
  `App.tsx:2285` only when `sendPermissionResponse` returns a *send* error; an
  inbound `error` frame carrying `permission_not_found` raises nothing at all —
  it is not one of `connectionState`'s three codes either. The claimed
  "another transport-error banner" does not exist on this path. (c) *Is the
  blanket un-submit wrong for other codes?* No — for `bad_request` (an invalid
  suggestion selection) the request genuinely stays pending engine-side, so
  re-enabling is correct. `permission_not_found` is the only code where it
  inverts.
- **True consequence**: A latent inversion. If a `permission.resolved` were ever
  lost, the card would re-arm instead of disappearing; today nothing loses one,
  and the loudest half of the described consequence (repeated banners) is wrong.
- **Evidence**: `AppSessionController.ts:86-128,225-240`;
  `App.tsx:2263-2290`; `permissionState.ts:112-138,162-199`.
- **Disposition**: Apply the fix anyway — it is three lines
  (`if (frame.code === 'permission_not_found') return updateSession(state, sid, removeRequest(session, frame.requestId))`)
  and makes a fail-closed reducer branch honest — but file it as **LOW /
  defensive**, not a MED correctness defect, and drop the "banner after banner"
  narrative from the rationale. Do NOT let it justify a wider refactor of the
  error branch: every other code's current behaviour is correct.

### A16-F4 — [MED] `selectUsedTokens` rescans the whole session log on every streamed frame

- **Verdict**: **OVERSTATED**
- **Cited location holds?**: Yes. `contextUsage.ts:286-291` is the unconditional
  forward pass collecting `message_start` indices; `:296-316` the backwards group
  fold; `:318-330` the second backwards pass over assistant frames; `:350-367` the
  third backwards pass for the newest `result` frame.
  `rawMessageLog.ts:37` is `DEFAULT_MAX_RAW_MESSAGES = 8_000`. The memo is at
  `App.tsx:3925-3928` with `activeLog.messages` in the dep array, and
  `rawMessageLog.ts:160-161` really does build a fresh array per appended message
  (`messages = [...session.messages, frame.event.message]`).
- **Reachable in production?**: Yes, every streamed delta on the active pane.
- **Trigger**: Benchmarked at the cap (`scratchpad/v14/a16-perf.ts`), 8,000
  retained messages:
  ```
  no result frame:  0.070 ms/call
  with result frame: 0.063 ms/call
  all-zero (Codex message_start seed) worst case: 0.203 ms/call
  rawMessageLog append at the 8,000 cap: 0.038 ms/frame (already O(n) copy + JSON.stringify)
  ```
- **Counter-arguments considered**: (a) *Is the "long first turn" case really
  worse?* Barely — 0.070 vs 0.063 ms; the third pass is a cheap type check. The
  report's "during a long first turn all three passes run at full length on every
  delta" is true and immaterial. (b) *Is this new cost or marginal cost?* Marginal:
  the store the memo depends on already spends 0.038 ms per delta copying the
  array and `JSON.stringify`ing the message for its byte budget, so the selector
  roughly doubles-to-quintuples an existing per-delta O(n) cost rather than
  introducing one. (c) *Is the "8,000–16,000 iterations" arithmetic right?* Yes,
  and the true worst case is ~3n ≈ 24,000 — but iteration count was never the
  question.
- **True consequence**: ~0.06–0.2 ms of main-thread work per streamed delta on a
  maxed-out session. Below any frame budget, and the report itself concedes it
  never profiled.
- **Evidence**: `scratchpad/v14/a16-perf.ts`; `rawMessageLog.ts:158-184`.
- **Disposition**: Do not fix now. The incremental-fold rewrite the report
  proposes would trade a measured 0.2 ms for new state that must stay correct
  across compaction boundaries, the Codex zero-seed walk-back and the
  preserved-tail skip — three subtleties the current code documents at length and
  gets right (see the clean bill below). If it is ever profiled as real, the cheap
  half is bounding the *third* pass (stop the `result` scan after the newest
  `message_start` group), which is free of those subtleties.

### A16-F5 — [MED] Seven renderer modules are the same snapshot-per-session domain copy-pasted

- **Verdict**: **PARTIALLY CONFIRMED** (under-counted, and the "token-identical"
  claim is false)
- **Cited location holds?**: Partly. The pattern
  (`{sessions: Record<SessionId, T|null>}` + `create`/`reduce`/`select`, one
  snapshot kind, `lifecycle` nulls a tracked key, `?? null` selector) is present
  in **nine** modules, not seven: the seven named plus
  **`remoteSettingsState.ts`** and **`settingsState.ts`**, which the report missed.
- **What does not survive**: "The bodies are token-identical down to the comment
  … which is literally duplicated across all seven."
  `rg -l "A process/transport reset drops the stale snapshot" app/renderer/src`
  returns **six** files: `contextBreakdownState.ts`, `runControlsState.ts`,
  `diagnosticsState.ts`, `extensionsState.ts`, `workspaceTrustState.ts`, and
  `settingsState.ts` — i.e. five of the seven named, plus one it did not name.
  **`slashCatalogState.ts` and `verbAckResultState.ts` do not carry it.** And
  `verbAckResultState.ts` is not the same module: its state key is `lastBySession`
  (not `sessions`), it discriminates a **four-kind** frame union
  (`agent-mode.set.result | task-control.result | run-control.result | settings.result`)
  with an explicit `||` chain written specifically so TS narrows without a cast,
  and its comment says "drops the stale **ack**". Even among the five that share
  the comment, the trailing clause differs ("mirrors diagnosticsState" /
  "mirrors settingsState" / "mirrors the other domains").
- **Reachable in production?**: n/a — quality.
- **Trigger**: none; this is duplication, correctly typed.
- **Counter-arguments considered**: whether the differences make a factory
  impossible — they do not for the eight `sessions`-shaped ones, but
  `verbAckResultState` would need either a kind *set* parameter or to stay
  hand-written, which is exactly the kind of exception that makes a factory earn
  less than it looks like it will.
- **True consequence**: ~250–300 lines of near-duplication across nine modules
  and nine places to change if the reset semantics move, plus the one real
  divergence the report correctly spots (`selectSlashCatalog` returns `[]` where
  the others return `null`).
- **Evidence**: per-file greps above; `verbAckResultState.ts:37-88`;
  `runControlsState.ts:17-61`; `diagnosticsState.ts:12-59`.
  Note `contextBreakdownState.ts` is **DIRTY** — `git diff` adds `colorHex` from
  `:75` down; the reducer at `:18-62` the report cites is untouched.
- **Disposition**: Apply the factory to the **eight** `sessions`-shaped modules
  and leave `verbAckResultState.ts` alone (its four-kind union is the reason it
  is hand-written and the reason it is cast-free). Fold in the two modules the
  report missed, or the "seven places to change" becomes "two places the factory
  does not reach", which is worse than nine consistent copies. Fix
  `selectSlashCatalog`'s `[]`/`null` divergence in the same change or record it as
  deliberate.

### A16-F6 — [LOW] `reducePasteRemoved` is production-dead and encodes the behaviour the code elsewhere calls a bug

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `composerState.ts:169` is the definition;
  `rg -n "reducePasteRemoved" app/` returns the definition plus
  `composerState.test.ts:22` (import) and `:168` (the single assertion) — zero
  production call sites. `removeSessionPaste` (`App.tsx:2235-2253`) calls
  `removePasteOccurrence` instead and carries the quoted comment verbatim at
  `:2245-2249`.
- **Reachable in production?**: No — that is the finding.
- **Trigger**: n/a (dead code); the risk is a future contributor reaching for it.
- **Counter-arguments considered**: whether it is re-exported or used through an
  index barrel — it is not; `composerState.ts` is imported by name everywhere.
  Whether the test pins behaviour worth keeping — it pins the *wrong* behaviour
  (dropping the entry outright), which is the point.
- **True consequence**: A supported-looking reducer whose semantics the adjacent
  production path explicitly rejects.
- **Disposition**: Apply as written — delete the function and its test.

### A16-F7 — [LOW] `describeSuggestion` is production-dead and prints the raw engine `behavior` enum

- **Verdict**: **INVALID**
- **Cited location holds?**: The code claims hold — `permissionPromptModel.ts:154-173`
  is the function, `:160` emits `` `${update.behavior} ${rules} · …` ``,
  `describeSuggestionOption` is at `:201` (module-local, not exported) and
  `BEHAVIOR_LEAD` at `:181`. **The deadness claim does not.**
- **Reachable in production?**: **Yes.** `rg -n "\bdescribeSuggestion\b" app/`
  returns, besides the definition and `PermissionPrompt.test.tsx`:
  ```
  app/renderer/src/debugStateReport.ts:15:import { describeSuggestion } from './permissionPromptModel.js'
  app/renderer/src/debugStateReport.ts:88:  suggestion => `Always allow: ${describeSuggestion(suggestion)}`
  ```
  The report's "the only callers are in `PermissionPrompt.test.tsx`" is simply
  false. `debugStateReport.ts` is a production module (`import.meta.env.DEV`-gated
  at its call site, `App.tsx:1286`, but compiled and type-checked unconditionally).
- **Trigger**: n/a — the premise is wrong.
- **Counter-arguments considered**: (a) *Does "production-dead" survive on the
  dev gate?* No. A dev-gated caller is still a caller: `bun run --cwd app typecheck`
  compiles `debugStateReport.ts`, so deleting the export is a compile error, and
  the report's fix is "delete it and fold its coverage into
  `describeSuggestionOption`'s tests". (b) *Is the underlying complaint real?*
  Yes, but it belongs to a different finding: **V15's F8** already reports
  precisely this — the debug snapshot fabricating "Always allow: " over a raw
  `behavior` enum, wrong for five of six update types — and correctly identifies
  `debugStateReport.ts:88` as the sole production consumer.
- **True consequence**: Applying this finding as written breaks the desktop
  typecheck. The real defect is V15-F8's, already filed with the right fix.
- **Evidence**: `rg -n "\bdescribeSuggestion\b" app/`;
  `debugStateReport.ts:15,88`; `App.tsx:1285-1300`;
  `docs/reports/.../verification/V15-renderer-session-state.md` §F8.
- **Disposition**: **Do not apply.** Mark as a duplicate of V15-F8 and take that
  fix instead (build the label from `describeSuggestionOption` and join
  `pre + code + post`), which keeps the function and makes the snapshot match the
  screen. If the intent is genuinely to remove `describeSuggestion`, the
  consumer must be migrated first — deletion cannot lead.

### A16-F8 — [LOW] `composerPopover.ts` has unused imports and creates a second import path for one function

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes, exactly. `composerPopover.ts:8-9` imports
  `handleMenuRovingKeyDown` and `nextMenuRovingIndex`; the only symbol from that
  import block referenced in the body is `usePopoverFocus` at `:36`. `:13` is the
  separate `export { … } from './overlayFocus.js'` pass-through.
- **Reachable in production?**: Yes; the split import graph is live.
- **Trigger**: The consumer split is precisely as claimed — via
  `composerPopover.js`: `ComposerActionsBar.tsx:12`, `PermissionModeChip.tsx:2`,
  `WelcomeScreen.tsx:56`, `AccountsPage.tsx:75`; via `overlayFocus.js`:
  `PlanPanel.tsx:3`, `SessionsPage.tsx:44`. The report **missed a seventh
  consumer**, `SessionActionsMenu.tsx:28` (via `overlayFocus.js`), which only
  strengthens it — 4 vs 3 rather than 4 vs 2.
- **Counter-arguments considered**: whether the re-export is load-bearing for a
  circular-import reason (the module's own header cites a circular import between
  `ComposerActionsBar` and `PermissionModeChip`) — it is not: both already import
  `overlayFocus.js`-owned symbols indirectly, and `overlayFocus.ts` imports
  neither, so pointing them at `overlayFocus.js` introduces no cycle.
- **True consequence**: `rg handleMenuRovingKeyDown` under-reports call sites
  unless you know to follow two paths; two unused imports survive because ESLint
  runs zero rules in this repo (CLAUDE.md §3).
- **Evidence**: greps above. **DIRTY**: `ComposerActionsBar.tsx` and
  `PermissionModeChip.tsx` are both modified in the working tree — the fix touches
  another session's files, so coordinate or defer.
- **Disposition**: Apply, but only after the two dirty consumers settle. Add
  `SessionActionsMenu.tsx` to the consumer census in the commit message so the
  next reader's grep is complete.

### A16-F9 — [LOW] `selectGenericPermissionQueue` takes a queue while its siblings take state, and its doc claims a composition it does not perform

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `askQuestionState.ts:126-131` is the doc
  ("Composed on top of `selectNonPlanPermissionQueue` so the plan exclusion stays
  single-sourced in `planState.ts`"); `:132-144` takes
  `queue: PermissionQueueItem[]` and filters only AskUserQuestion. The composition
  is at `App.tsx:2391-2393`. The siblings `selectPlanReview` (`planState.ts:81`)
  and `selectAskQuestion` (`askQuestionState.ts:107`) both take `(state, sessionId)`.
- **Reachable in production?**: One call site today, and it composes correctly.
- **Trigger**: none today — the risk is a second call site passing
  `selectPermissionQueue(...)` directly, which would put the `ExitPlanMode`
  request back in the generic queue alongside `PlanPanel`'s own card.
- **Counter-arguments considered**: whether the type system prevents the misuse —
  it does not: `selectNonPlanPermissionQueue` and `selectPermissionQueue` both
  return `PermissionQueueItem[]`, so the wrong one type-checks. Whether the doc is
  defensible as describing the *call site* — it says "Composed on top of", present
  tense, about the function.
- **True consequence**: A comment that actively misleads about where an invariant
  lives, in the one seam where two renderers can double-render one `requestId`.
- **Disposition**: Apply — give it the sibling signature `(state, sessionId)` and
  perform the composition inside. `planState.ts` is **DIRTY** (comment-only diff,
  verified), so re-read it immediately before editing.

### A16-F10 — [LOW] `addSessionPaste` writes paste state from a stale closure instead of an updater

- **Verdict**: **CONFIRMED** (as filed: latent)
- **Cited location holds?**: Yes. `App.tsx:2209-2233`; `reducePasteAdded(pasteState, …)`
  at `:2220` reads the render closure and `setPasteState(nextPasteState)` at
  `:2225` writes the whole object. The other three paste mutations use the
  functional form: `:2080` (`prev => reduceSessionPastesCleared`), `:2202`, and
  the `edit` prune.
- **Reachable in production?**: The code path is; the double-call is not
  demonstrated.
- **Trigger**: two `addSessionPaste` calls in one React batch. `handlePaste`
  (`App.tsx:3989-4003`) fires once per paste event and the drop handler routes
  through the same single call, so I could not construct one either.
- **Counter-arguments considered**: whether `useCallback`'s `[pasteState, …]` dep
  makes it safe — it does not; the dep makes the closure *fresh per render*, which
  is exactly the window a same-batch second call falls into. Whether the
  overwrite would be visible — yes: `composerState.ts:159-165` keys on
  `session.nextId`, so the second entry replaces the first at the same key while
  both `[Pasted text #1]` tokens remain in the draft.
- **True consequence**: Latent. Correctly self-limited by the report.
- **Disposition**: Apply — it is a one-line change to the form every sibling
  already uses, and the token must come from the same reducer result.

### A16-F11 — [LOW] An external draft write during IME composition is silently discarded

- **Verdict**: **PARTIALLY CONFIRMED**
- **Cited location holds?**: Yes. `ComposerInput.tsx:175-226` is the sync layout
  effect with `if (isComposingRef.current) return` at `:180`; `:244-248` is
  `handleInput`, which also early-returns while composing; `:327-331` is
  `onCompositionEnd`, which clears the flag and then calls `handleInput()` — so
  the DOM read does win.
- **Reachable in production?**: The mechanism is deterministic given the
  conjunction; the conjunction itself I could not schedule.
- **Trigger**: (a) an IME composition is active, and (b) something writes `value`
  during it. The composition commits, `handleInput` reads the pre-write DOM and
  calls `onValueChange(readComposerText(root))`, replacing the external write.
  Both halves are individually reachable — `releasePendingSubmit`
  (`App.tsx:1776-1789`) and `history-nav` both write the draft asynchronously —
  but I could not demonstrate them coinciding without a real browser (the
  renderer suite is SSR-only, so no composition events).
- **Counter-arguments considered**: (a) *Does the layout effect re-run after
  `onValueChange` and restore the external text?* No — by then `value` has been
  set to the DOM text, so the effect renders what it just read. (b) *Is there a
  pending-write record anywhere?* `renderedPastesRef` tracks pastes and
  `pendingCaretRef` tracks caret, but nothing records a skipped `value` sync.
  (c) *Does `pendingSubmits` re-deliver?* No: `restoreDraftWithPending` writes the
  draft once and shows the banner.
- **True consequence**: If a parked prompt is released (or a history recall lands)
  mid-composition, the banner promises text the composer then drops. Real,
  unguarded, timing-dependent.
- **Disposition**: Apply the report's fix (record that a sync was skipped; on
  `compositionend` re-run from `value`, splicing in the committed text). Do not
  attempt to prove it with a unit test — the renderer suite cannot fire
  composition events; this needs either a jsdom composition harness or an
  operator GUI step, and should be labelled UNVERIFIED until one exists.

### A16-F12 — [LOW] `buildAllowResponse` ignores its first parameter

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `permissionState.ts:333-344`: `_request` is
  never read; the body forwards only `applySuggestions` and the `updatedInput: {}`
  sentinel. Both call sites run a `.find()` over `sessionPermissionQueue` purely
  to produce the discarded argument (`App.tsx:2608-2618` and `:2637-2647` — the
  report's `:2610-2617`/`:2640-2648` are within two lines).
- **Reachable in production?**: Yes, both call sites are live.
- **Trigger**: n/a (signature quality).
- **Counter-arguments considered**: whether the parameter is a deliberate
  type-level reminder of the C1 boundary — the doc comment already carries that,
  and `buildDenyResponse` (`:349`) takes no request at all, so the pair is
  inconsistent rather than intentional.
- **True consequence**: A signature that implies the response is derived from the
  request, which is the exact thing PERMISSION-BOUNDARY.md C1 forbids.
- **Disposition**: Apply — drop the parameter, keep the call-site `.find()` as the
  existence guard it actually is.

### A16-F13 — [LOW] `nextSlashIndex` also drives the mention picker

- **Verdict**: **CONFIRMED** (call sites mis-located)
- **Cited location holds?**: The definition does — `slashCommandPickerModel.ts:25-32`
  is the generic wrap-around step. **The mention call sites do not**: they are
  `App.tsx:4053` and `:4059`, not `:4160,4165`. (`App.tsx` is clean in the working
  tree and unchanged since `fee4292`, so this is a citation error, not drift.)
  `mentionPickerModel.ts` is 10 lines beside a 36-line `slashCommandPickerModel.ts`,
  as claimed.
- **Reachable in production?**: Yes — four live call sites, two slash, two mention.
- **Trigger**: n/a (naming).
- **Counter-arguments considered**: whether the function is genuinely generic — it
  is: `(activeIndex, length, direction) => (activeIndex + direction + length) % length`,
  with no slash-specific behaviour.
- **True consequence**: A generic primitive named after one of two consumers.
- **Disposition**: Apply the rename half only (`nextPickerIndex`). Merging the two
  picker-model files is a file move for a naming win and should ride a change that
  is already touching both.

---

## A16 — the clean bill, re-derived

The brief asked me to re-derive two claims. One holds; one does not.

**"The permission queue is a correct engine-authoritative model with real
dedupe/rebuild semantics." — CONFIRMED.** Re-derived from the reducer, not the
prose:
- The `ready` branch (`permissionState.ts:112-138`) **replaces** `pending`
  outright from `frame.payload.pendingPermissionRequests` and filters both
  `dismissedRequestIds` and `submittedRequestIds` down to ids still in the
  engine's snapshot. That is genuine authority transfer, not a merge.
- Dedupe is real: `permission.requested` (`:174-191`) filters out any existing
  entry with the same `requestId` before pushing, and simultaneously clears that
  id from `dismissed`/`submitted` — so a re-minted request cannot arrive
  pre-snoozed or pre-answered.
- Removal has exactly one non-reset path (`permission.resolved` → `removeRequest`,
  `:193-199`), which matches the engine's single delete site
  (`AppSessionController.ts:104`), so the two cannot drift.
- `lifecycle` resets to `createSessionPermissionState()` (`:154-160`).
- The ordering of the guards is load-bearing and right: `ready` (`:112`) and
  `permission.context` (`:142`) are handled **before** the
  `if (!session) return state` guard at `:151-152`, so they can create a session
  slot, while every other frame kind is ignored for an unknown session. That is
  the C3 "a snapshot is standalone truth" rule implemented, not asserted.
- The one wrinkle is the report's own uncertainty note (`permission.requested`
  re-appends to the end, reordering the arrival-order queue). Given
  `AppSessionController.ts:235`, a `requestId` is minted once per `Promise`, so I
  found no engine path that re-emits one. Correctly left unfiled.

**"Every runtime narrowing is cast-free." — REFUTED.** A scan of the A16 scope
for `as <Type>` / `as unknown` / `any` (excluding `as const` and type-import
aliases) returns four:
- `askQuestionState.ts:65` and `:77` — `const record = value as Record<string, unknown>`
  inside `narrowOption`/`narrowQuestion`;
- `planState.ts:59` — the same idiom in `narrowAllowedPrompt` (file is **DIRTY**;
  the diff is comment-only and does not touch this line);
- `PermissionPrompt.tsx:55` — `(element as HTMLElement).isContentEditable === true`,
  which is the genuinely unsound one (an `SVGElement` has no such property).
Plus two conventional DOM casts (`composerPopover.ts:49`, `ComposerActionsBar.tsx:1118`
— `event.target as Node`). The three narrowing casts are guarded by a preceding
`typeof === 'object' && !== null`, so they are safe today — but the codebase's own
cast-free idiom exists twenty lines away (`contextUsage.ts:112` `isRecord`), and
CLAUDE.md §7 says "zero `as` casts in projector-style code". The claim as written
is false; the code is close to earning it.

Two smaller clean-bill claims I checked and which **do** hold:
`permissionKeysAreLive` (`permissionPromptModel.ts:106-111`) really does use
`closest(FOCUSED_KEY_OWNER_SELECTOR)` with `[contenteditable]` in the list
(`:65-69`); `PASTE_REF_RE` (`composerState.ts:127`) is `/g` and every consumer
builds a fresh instance (`composerDom.ts:168`, `composerState.ts:299`) except the
one `String.replace` at `:246`, which the spec resets; `resolvePendingSubmit`
(`composerState.ts:604-625`) has a real `never` tripwire at `:622-623`; and there
is **zero** module-level mutable state (`let`/`var`) in any A16 module.

---

# Part 3 — A14, with the clean bills attacked first

## A14's clean bills

Because A14 is the only scope in the review with no HIGH, its all-clears carry
more weight than its findings. I checked all seven.

1. **"The boundary schema is genuinely shared, not duplicated." — CONFIRMED.**
   `parseTranscriptBackfillRequest` / `parseTranscriptBackfillResult` are defined
   once in `app/shared/transcriptBackfill.ts:77,114`. Main runs the request parser
   on the manifest it builds (`transcriptBackfill.ts:126-130`) and the result
   parser on every inbound line (`:214`); the worker runs the *same* result parser
   on its own output before emitting (`transcriptBackfillWorker.ts:212-218`). The
   probe test proves it on a real process:
   `transcriptBackfillWorker.probe.test.ts:291` asserts a session the shared
   parser rejects becomes a `failure` record, `expect(emitted.every(Boolean)).toBe(true)`,
   and the run still ends with `{type:'done', attempted:1}`. That is a shared
   validator, not two schemas that happen to agree.
2. **"Main never opens a `.jsonl` at all." — CONFIRMED**, with one addition A14
   omitted. `rg -n "readFileSync|readFile\(|createReadStream|openSync" app/main/*.ts --glob '!*.test.*'`
   returns exactly five non-test hits: `transcriptCache.ts:239` (the 4 KiB header
   probe), `:287` (the temp-file write), `:328` (`readCache`, size-checked at
   `:325`), `sessionsCatalogBaseline.ts:55` (`sessions-catalog.json`, size-checked
   at `:54` against `MAX_SESSIONS_CATALOG_CACHE_BYTES`), and `devHarness.ts:352`
   (a write). Main's contact with a transcript is `statSync(...).mtimeMs`
   (`main.ts:363-370`) and `existsSync` — never an open. A14 named only the
   transcript cache; the catalog baseline is a second read, and it is bounded too.
3. **"Path handling is airtight … No session id from the renderer reaches the
   filesystem." — the conclusion holds; the sentence does not.** A renderer id
   *does* reach a path join: `previewSession(appSessionId)` (`preload.ts:288`) →
   `main.ts:1371` `resolvePreview` → `readCache(dir, id)` → `cacheFilePath`
   (`transcriptCache.ts:265-269`). What makes it safe is two gates, not absence:
   `resolvePreview` refuses any id the host does not vouch for as restorable
   (`transcriptCache.ts:383-392`), and `cacheFilePath` returns `null` unless
   `isUuid(id)` (`:104-109`). Traversal and absolute-path escape are both
   impossible, so the *security* claim stands — but "no renderer id reaches the
   filesystem" is the wrong reason, and a future reader who trusts it might drop a
   gate. The backfill half of the claim is exact: items are built by main from its
   own registry (`main.ts:416-417` via `defaultTranscriptPath`), and the boundary
   parser independently re-requires absolute + UUID + `basename === "<engineSessionId>.jsonl"`
   (`transcriptBackfill.ts:94-105`).
4. **"Every JSONL parse degrades per-line." — CONFIRMED.**
   `transcriptRunFacts.ts:86-91` try/catches `JSON.parse` per line and `continue`s;
   the engine loader it delegates to skips malformed lines
   (`src/utils/json.ts:168-172`) after trimming a partial first line
   (`src/utils/sessionStorage.ts:4266-4275`). A truncated tail costs one record.
5. **"`resolvePreview` is a pure function over two injected deps." — CONFIRMED**
   (`transcriptCache.ts:383-392`): three guards, no disk, no Electron.
6. **"The worker is genuinely read-only." — CONFIRMED.**
   `rg -n "writeFileSync|appendFile|mkdirSync|unlink|rmSync|processResumedConversation" app/sidecar/transcriptBackfillWorker.ts app/sidecar/transcriptRunFacts.ts`
   returns **zero** hits. Its only mutation of shared state is
   `switchSession(item.engineSessionId, dirname(item.transcriptPath))`
   (`:126`), process-local. The account-pool avoidance is real too: the worker
   runs `ensureEngineMacro()` + `enableConfigs()` instead of `init()`
   (`:80-87`), with the reason stated in-file.
7. **"Fixtures are correctly quarantined." — CONFIRMED, and there are six, not
   four.** `app/main/transcriptBackfillRunner.fixture.ts`,
   `app/sidecar/{agentModeDomain,mintTranscript,resumeProbe,resumeSeedProbe,sessionStartHookControl}.fixture.ts`
   — each referenced only from `*.test.ts` / `*.probe.test.ts`. The packaging
   caveat also holds: `rg -n "electron-builder|forge|\"files\"|\"build\"" app/package.json`
   returns nothing, so there is no bundle to exclude them from yet.

## A14 per finding

### A14-F1 — [MED] The backfill runner keeps trusting a worker it has already terminated

- **Verdict**: **PARTIALLY CONFIRMED**
- **Cited location holds?**: Yes. `transcriptBackfill.ts:192` opens
  `child.stdout.on('data', chunk => {` with **no** guard, against
  `sessionsCatalogRunner.ts:117` and `accountsPoolRunner.ts:119`, which both open
  with `if (protocolError) return`. Every rejection arm in the backfill handler
  (`:201-205`, `:207-213`, `:214-219`, `:220-228`, `:229-238`, `:246-254`,
  `:259-262`) does `rejected += 1; terminate(); return` and nothing latches.
  `terminate()` (`:170-172`) only sends SIGTERM. No test pins the missing latch
  (`rg -n "terminate|latch|protocolError" app/main/transcriptBackfill.test.ts` →
  no hits).
- **Reachable in production?**: The handler property is; the report's stated
  trigger largely is not.
- **Trigger — split in two**:
  - **Handler property (PROVEN).** With a controlled child whose stdout chunks I
    schedule exactly (`scratchpad/v14/a14-f1-fakechild.ts`), using the real
    `runTranscriptBackfill`:
    ```
    after chunk A: kill signals sent = [ "SIGTERM" ]  onSession calls = 1
    after chunk B: onSession calls = [ ...s1, ...s2, ...s3 ]
    => records from a worker main had ALREADY terminated were parsed and persisted: true
    ```
    So a second `data` event after `terminate()` is fully processed and handed to
    `options.onSession` — which in production is `persistTranscriptBackfillResult`
    → `writeCache`.
  - **Real process (DID NOT REPRODUCE).** With a real `bun` child emitting the
    same four records at 0, 1, 5, 20 and 60 ms spacing
    (`scratchpad/v14/a14-f1-latch.ts` + `a14-f1-d{0,1,5,20}.ts`), **every** run
    gave `onSession called for: [s1]` and
    `records AFTER the first rejection were still handed to onSession: false`.
    At 0 ms all four records land in one chunk, where the `return` after
    `terminate()` *is* an effective latch (the remainder stays in `pending` and
    the child dies before another `data` fires). At ≥1 ms SIGTERM wins.
- **Counter-arguments considered**: (a) *Does the real worker's write pattern
  favour the trigger?* **No — it works against it.** The worker awaits
  `process.stdout.write` per record (`transcriptBackfillWorker.ts:288-300`) and
  spends the interval between records reading and projecting the next transcript
  (seconds), so SIGTERM lands in the gap. The trigger needs records already
  buffered in the pipe when the signal arrives — plausible for a run of cheap
  `failure` records, not for the `session` records that carry the disk write.
  (b) *Does the run still fail?* Yes: `callbackError !== null` throws at `:286-290`,
  and the other arms reach `code !== 0` or the `doneAttempted`/`seen` checks at
  `:296-306`. Main does report a failed run. (c) *Is anything persisted
  unvalidated?* **No.** Every post-termination record still passes
  `parseTranscriptBackfillResult`, `scanForSecrets`, the identity check and the
  `seen` de-dupe. "Trusting an untrustworthy worker" overstates it: main
  re-validates everything; what it loses is the fail-closed *abort*.
  (d) *Is the worker's own comment contradicted, as claimed?* Yes —
  `transcriptBackfillWorker.ts:198-211` states sessions behind a rejected one are
  "silently abandoned", which the handler property falsifies.
- **True consequence**: A latent fail-closed gap plus a real documentation
  contradiction and an over-counted `rejected` in the summary log
  (`main.ts:470-472`). Under the current worker's serialized write pattern the
  window is very narrow, and anything that does slip through is fully validated.
- **Evidence**: both scratch scripts above; `sessionsCatalogRunner.ts:117`;
  `accountsPoolRunner.ts:119`; `transcriptBackfill.ts:170-263`.
  **DIRTY**: `app/main/main.ts` is modified in the working tree, but the diff is a
  comment-only change at `:998`; the backfill code at `:348-480` is untouched.
- **Disposition**: Apply the report's fix — it is four lines and makes three
  runners identical — but **reclassify to LOW**, and correct the rationale: the
  motive is the fail-closed contract and the false in-file comment, not a
  demonstrated disk mutation. While there, fix the summary log's `rejected`
  over-count, which the latch closes for free.

### A14-F2 — [MED] The persist path does on the main thread what discovery was rewritten to avoid — twice per session

- **Verdict**: **PARTIALLY CONFIRMED** (mechanism exact, cost overstated)
- **Cited location holds?**: Yes. `transcriptBackfill.ts:101` is the pre-write
  `readCache` and `:118` the post-write one, both inside `onSession`, which
  `main.ts:435-471` runs synchronously in the child's `stdout` `data` handler on
  Electron's main thread. `readCache` (`transcriptCache.ts:321-348`) is
  `JSON.parse` + `parseTranscriptCache` + a recursive `scanForSecrets(cache.frames)`.
  The policy statement is at `main.ts:399-402` verbatim ("Discovery must not
  synchronously parse + recursively secret-scan every cache on Electron's main
  thread").
- **Reachable in production?**: Yes, once per accepted session per launch, up to
  `MAX_TRANSCRIPT_BACKFILL_SESSIONS` (32).
- **Trigger**: Measured against the **live** store
  (`scratchpad/v14/a14-cachestats.ts`, `~/.cat-code/desktop/transcript-cache`):
  ```
  files=58 totalMB=48.6 meanKB=819 maxBytes=4192564
  readCache on the largest cache (4,192,564 B): 7.6 ms per call -> 15.3 ms per accepted session (2 calls)
  readCache over ALL 58 caches once: 69 ms
  ```
- **Counter-arguments considered**: (a) *Is the "~50 ms hitches" figure right?*
  **No.** The worst single cache is 7.6 ms, so the worst per-session pause is
  ~15 ms, and reading the entire 48.6 MB store once costs 69 ms — so the report's
  "~50 MB of parse + object-graph walk … in ~50 ms hitches" overstates the hitch
  by 3–6× while understating nothing. (b) *Does the post-write read do anything the
  pre-write one does not?* Yes — it is the verification that the just-written file
  survives `readCache`'s own gates, which is how `persisted === 'rejected'`
  (`main.ts:463-468`) is detected. Removing it removes a real check. (c) *Does the
  discovery path really avoid it?* Yes — `main.ts:401-415` uses
  `listCachedSessionIds` plus the 4 KiB `readHeaderPrefix`.
- **True consequence**: Up to 32 synchronous 2–15 ms pauses on the main thread in
  the post-paint window. Perceptible in aggregate, not the per-hitch stall
  claimed.
- **Evidence**: `scratchpad/v14/a14-cachestats.ts`; `transcriptCache.ts:225-250,321-348`.
- **Disposition**: Apply the **pre-write** half only — `cacheHasCurrentRunFacts` +
  `cacheWrittenAt` answer exactly the `already_cached` question from 4 KiB, and
  the file even says the two gates "must agree, or discovery queues a session that
  persistence then refuses to write" (`transcriptBackfill.ts:99-100`), so routing
  both through the probe makes them agree by construction. **Do not** replace the
  post-write read with a `statSync` size check as the report suggests: size proves
  nothing about `parseTranscriptCache` or the secret re-scan, and that read is the
  only thing that produces the `'rejected'` verdict main logs. Halving the cost is
  the win; the verification is not the half to drop.

### A14-F3 — [MED] Backfill always replaces an on-close cache, and its frame budget is half the on-close one

- **Verdict**: **PARTIALLY CONFIRMED** (mechanism CONFIRMED; the disk evidence is
  wrong)
- **Cited location holds?**: Yes for every code claim.
  `transcriptBackfill.ts:101-108` gates on
  `(existing.header.runFactsVersion ?? 0) >= TRANSCRIPT_CACHE_RUN_FACTS_VERSION`;
  `TRANSCRIPT_CACHE_RUN_FACTS_VERSION = 1` (`transcriptCache.ts:82`); `distill`
  (`transcriptCache.ts:144-151`) calls `createTranscriptCache` **without**
  `runFacts`, and `:177-180` spreads the `runFacts`/`runFactsVersion` pair only
  when the argument is present — so an on-close header has neither and
  `0 >= 1` is false, every time. Budgets confirmed:
  `MAX_HISTORY_REPLAY_FRAMES = 4_000` / `MAX_HISTORY_REPLAY_BYTES = 4 MiB`
  (`limits.ts:141-142`) for the worker's `buildBoundedFrames`, versus
  `DEFAULT_MAX_BUFFERED_FRAMES = 8_000` / `DEFAULT_MAX_BUFFERED_BYTES = 8 MiB`
  (`replayBuffer.ts:72,74`) behind the on-close cache. The contradiction with
  `transcriptCache.ts:186-198` ("destroying it to gain a display detail would be a
  strictly worse trade") is real.
- **Reachable in production?**: Yes. `selectTranscriptBackfillCandidates`
  (`mainDecisions.ts:296-321`) queues any restorable row where
  `!cacheHasCurrentRunFacts(...)`, which is every on-close cache.
- **Trigger**: A session closed inside the desktop app with >4,000 frames or
  >4 MiB of frames; the next launch re-derives it under the smaller budget and
  writes a truncated artifact carrying "Only the N most recent messages are shown."
- **Counter-arguments considered — and this is where the report breaks**:
  I censused the live store and checked each cache's first frame rather than
  inferring from size (`scratchpad/v14/a14-cachestats.ts`, `a14-notices.ts`):
  - Only **6 of 58** caches carry any truncation notice.
  - The report's evidence — "the two largest live caches are 4,095,318 and
    4,031,116 bytes … i.e. already truncated artifacts" — does not hold.
    `c1715ae4…` (4,031,116 B, 700 frames) carries **no truncation notice at all**;
    it is simply a large untruncated cache that happens to sit under 4 MiB.
    `b55a1acc…` (4,095,318 B, 118 frames) carries
    `"Restored history was truncated to 117 recent events."` — a string that
    **does not exist anywhere in the current source**
    (`git log -S` → removed in `f600da5`), i.e. a legacy artifact from the
    sidecar's history-replay path, not the backfill worker's.
  - Not one cache in the store has exactly 4,000 frames.
  - The only cache carrying the *worker's* wording at that size (`3fa714c3…`,
    4,192,564 B, 1,404 frames, `"Only the 1403 most recent messages are shown."`)
    has `runFactsVersion: undefined` — so it is an **on-close** cache truncated by
    the replay buffer, which is the opposite of the report's story.
  So: the mechanism is certainly present in the code, but **no artifact on this
  machine demonstrates it**, and the three the report reasoned from by size alone
  say something else.
- **True consequence**: A real, unconditional overwrite of every on-close cache
  under a halved budget. Whether it has ever cost rows here is unproven; the
  store's 56/58 caches with `runFactsVersion: 1` say the overwrite happens
  constantly, and its 0 caches at the frame cap say nothing has been long enough
  to lose by it yet.
- **Evidence**: both scratch scripts; `transcriptCache.ts:82,144-151,177-180,186-198`;
  `limits.ts:141-142`; `replayBuffer.ts:72-74`;
  `git log --oneline -S "Restored history was truncated" -- app/`.
- **Disposition**: Apply the report's second option (merge the worker's `runFacts`
  into the existing header when the existing frame set is longer), not the first —
  comparing byte counts across two differently-budgeted producers invites the same
  class of confusion the report itself fell into. And **strip the corroborating
  paragraph**: it draws a conclusion from file size that the file contents
  contradict.

### A14-F4 — [MED] Cache freshness is stamped at write time, not at the moment the transcript was read

- **Verdict**: **CONFIRMED** (severity narrower than filed)
- **Cited location holds?**: Yes. `transcriptCache.ts:177` is
  `writtenAt: Date.now()` inside `createTranscriptCache`, which main calls at
  persist time (`transcriptBackfill.ts:111-117`), long after the worker read.
  `main.ts:363-370` is `transcriptMtimeMs`; `:378-383` is
  `isTranscriptNewerThanCache` = `transcriptMtimeMs(session) > writtenAt`.
- **Reachable in production?**: Yes. `restorable` really does mean "no desktop
  engine is live", not "no process is writing"; `mainDecisions.ts:296-321` filters
  only on `restorable`, and terminal-created rows are in the same list.
- **Trigger**: An append lands in `(T0_worker_read, T1_main_stamp]`. It is absent
  from the cache and `mtime <= writtenAt`, so the staleness test says fresh. If
  that append was the conversation's last, the preview is pinned to a prefix
  permanently.
- **Counter-arguments considered**: (a) *How wide is the window?* Narrow — the
  worker emits a session's record immediately after building it, and main persists
  on the next `data` event, so T1−T0 is sub-second per session, not the length of
  the whole batch. (b) *Is anything else self-healing?* Yes, partially: any
  **later** append moves mtime past `writtenAt` and re-queues the row. Only a
  conversation whose final append fell in the window stays stale. (c) *Is the
  boundary really additive-friendly for the fix?* Yes —
  `TranscriptBackfillSessionResult` is `hasExactKeys`-validated
  (`transcriptBackfill.ts:154-163`), so adding a field is a boundary-version
  change the schema already supports.
- **True consequence**: A sub-second race whose *effect* is permanent for the
  affected session: a preview and a rail (model/effort/usage) frozen one turn
  behind, with no marker.
- **Evidence**: `transcriptCache.ts:170-183`; `main.ts:358-383`;
  `transcriptBackfill.ts:63-121`.
- **Disposition**: Apply the report's fix, taking the **reject** variant rather
  than the re-stamp: have the worker report the `mtimeMs`/`size` it read and have
  `persistTranscriptBackfillResult` drop the record when the file moved under it.
  Re-stamping `writtenAt` from T0 makes every cache look older than it is and
  would re-queue rows that are actually current. Severity **LOW**.

### A14-F5 — [MED] The cache-at-rest read gate is a materially weaker allowlist than the write gate

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `isTranscriptCacheFrame`
  (`transcriptCache.ts:116-134`) is 18 lines and, for `kind === 'event'`, checks
  only `event.type === 'message'` and `typeof message.type === 'string'` — no
  per-frame `protocolVersion`, no `frame.sessionId === header.appSessionId`, no
  `replay === true`, no `message.session_id`. `parseTranscriptCache`
  (`:405-444`) validates the header and then defers to it per frame. The strict
  side (`app/shared/transcriptBackfill.ts:250-512`,
  `parseTranscriptFrame` → `isBackfillSdkMessage` → `isBackfillContentBlock`)
  enforces all four plus a content-block allowlist. The downstream compensation is
  real: `previewTranscriptState.ts:125` filters
  `frame.sessionId === header.appSessionId`.
- **Reachable in production?**: The read gate runs on every `readCache`.
- **Trigger**: A cache file whose frames carry a foreign `sessionId`, a stale
  `protocolVersion`, or `replay` absent, passes `readCache` and reaches the
  renderer, where only the `sessionId` mismatch is caught.
- **Counter-arguments considered**: (a) *Is this a security finding?* No, and the
  report does not claim it is: the file is written by main alone, 0600, in
  `~/.cat-code/desktop/`, so producing such a file already requires write access to
  the user's home. (b) *Does `readCache` compensate elsewhere?* Partly — it checks
  the **header's** `protocolVersion` and `guardVersion` (`:333-339`), rejects a
  header whose `appSessionId` disagrees with the filename, and re-runs
  `scanForSecrets` over all frames (`:343`). So version drift at the *cache* level
  is caught; only per-frame drift is not. (c) *Is the module doc really
  overstated?* Mildly. `:22-27` promises "runtime schema-validated … any
  corruption / schema drift ⇒ discarded AND deleted", which is exactly what
  `readCache` does — against *its own* schema. The report's real point is that the
  schema is weaker than its sibling, not that the doc lies.
- **True consequence**: One concept ("is this frame allowed in a transcript
  cache") with two implementations of very different strength, and today's safety
  on the weak side owes to a renderer-side filter the cache module does not know
  about.
- **Evidence**: line citations above; `previewTranscriptState.ts:125`.
- **Disposition**: Take the report's **minimum** option, not its first: add the
  three cheap per-frame invariants (`protocolVersion`, `sessionId`, `replay`) to
  `isTranscriptCacheFrame`. Do **not** route `parseTranscriptCache` through
  `parseTranscriptFrame`: that parser also enforces `BACKFILL_CONTENT_BLOCK_TYPES`,
  which A14-F12 shows is already two block types behind — adopting it would make
  every *existing* cache containing a future block type fail its read and be
  **deleted** (`discard`), converting a display gap into data loss.

### A14-F6 — [MED] `readTranscriptRunFacts` reads the whole transcript with no size bound

- **Verdict**: **CONFIRMED** (consequence self-healing)
- **Cited location holds?**: Yes. `transcriptRunFacts.ts:76` is
  `lines = readFileSync(path, 'utf8').split('\n')` with no cap, inside a
  try/catch. The sibling call in the same worker iteration passes
  `maxBytes: MAX_HISTORY_REPLAY_BYTES * 2` (`transcriptBackfillWorker.ts:153-159`).
- **Reachable in production?**: Yes, once per item, serially, up to 32 per launch.
- **Trigger**: A transcript large enough to exhaust the worker's heap. Measured on
  the live store (`scratchpad/v14/a14-blockscan.ts`): 1,808 transcripts, largest
  **18.9 MB** (`~/.cat-code/projects/-Users-pt-cat-code/9962367c-…/subagents/agent-acompact-….jsonl`),
  8 over 8 MB — matching A14's numbers exactly. At ~3× file size for the UTF-16
  string plus the line array, that is ~57 MB transient. No OOM today.
- **Counter-arguments considered**: (a) *Is the memory freed between items?* Yes —
  the loop is serial and `lines` goes out of scope, so the peak is one file, not
  32. (b) *Is the claimed consequence right?* Partly. If the worker does die, the
  `close` handler resolves with a non-zero code, `runTranscriptBackfill` throws at
  `:296-300`, and `backfillTranscriptCaches` catches (`main.ts:474+`) — so
  sessions queued behind it are skipped **for that launch**. But
  `selectTranscriptBackfillCandidates` re-queues every uncached row on the next
  launch, so it is a deferred failure, not the permanent abandonment the
  2026-07-28 comment was written to prevent. (c) *Is the file read three times?*
  Yes — `readTranscriptRunFacts`, `loadDisplayTranscriptFromJsonlPath`, and
  `loadConversationForResume` — which triples the transient cost the report names.
- **True consequence**: An unbounded allocation with a comfortable margin today
  and a self-healing failure mode. The absent bound is the finding, correctly.
- **Evidence**: `scratchpad/v14/a14-blockscan.ts`; `transcriptRunFacts.ts:74-80`;
  `transcriptBackfillWorker.ts:153-159`; `transcriptBackfill.ts:296-300`.
- **Disposition**: Apply — read a bounded tail with the sibling's
  `MAX_HISTORY_REPLAY_BYTES * 2` budget. The function already scans newest-first
  (`:83`), so a tail read is a strict improvement with no behaviour change. Note it
  is a **run-facts** read: a bound that cut off an early `system/run_facts` record
  would null the model face, so bound generously and keep the newest-first walk.

### A14-F7 — [LOW] The `MAX_OUTBOUND_FRAME_BYTES` check in `buildBoundedFrames` is dead

- **Verdict**: **CONFIRMED** (one word imprecise)
- **Cited location holds?**: Yes. `transcriptBackfillWorker.ts:263-267`:
  `bytes > MAX_OUTBOUND_FRAME_BYTES || retained.length + 1 > MAX_HISTORY_REPLAY_FRAMES || retainedBytes + bytes > MAX_HISTORY_REPLAY_BYTES`.
  `MAX_OUTBOUND_FRAME_BYTES` is 32 MiB, `MAX_HISTORY_REPLAY_BYTES` 4 MiB, and
  `retainedBytes >= 0`, so any frame tripping the first also trips the third.
- **Reachable in production?**: The `||` short-circuits, so the first sub-condition
  *is* evaluated first and can be the one that returns true — "can never be the one
  that fires" is imprecise. It can never change the **outcome**, which is the real
  point.
- **Trigger**: n/a — redundant, not wrong.
- **Counter-arguments considered**: whether a backfill frame ever crosses the
  sidecar's outbound socket, which would make the cap correct — it does not: the
  worker writes NDJSON to stdout for main, bounded by
  `MAX_TRANSCRIPT_BACKFILL_RECORD_BYTES`, and the frames then live in a cache file
  and travel over IPC.
- **True consequence**: A directional-limit constant cited where it does not apply,
  in a repo whose security baseline says `MAX_FRAME_BYTES` and
  `MAX_OUTBOUND_FRAME_BYTES` "must never be swapped or unified".
- **Disposition**: Apply — replace with `MAX_TRANSCRIPT_BACKFILL_RECORD_BYTES`,
  which is the bound that actually governs this artifact and would otherwise fire
  only later, inside `emit()` (`:288-291`), as a thrown error rather than a
  truncation.

### A14-F8 — [LOW] Orphaned `.tmp` cache files can never be reaped

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `writeCache` (`transcriptCache.ts:276-307`)
  writes `.${appSessionId}.${pid}.${randomUUID()}.tmp` and unlinks it only inside
  its own `catch`. `listCachedSessionIds` (`:361-375`) skips anything not ending
  in `.json`, and `gcTranscriptCache` (`main.ts:348-356`) enumerates exclusively
  through it. `deleteCache` removes `<id>.json` only.
- **Reachable in production?**: Yes — any death between `openSync` and
  `renameSync`.
- **Trigger**: A force-quit or SIGKILL during the synchronous quit path, which
  calls `persistTranscriptCache` for every live session inside `host.shutdownAll()`.
- **Counter-arguments considered**: whether anything else sweeps the directory —
  nothing does; and whether the leading dot hides them from the user — it does,
  which is why the leak is silent. Current count on this machine: **0**.
- **True consequence**: Up to 8 MiB of hidden, permanently unreferenced bytes per
  occurrence.
- **Disposition**: Apply — the subdirectory variant is the cleaner of the two
  (a `tmp/` the GC clears wholesale needs no age heuristic and cannot race a
  concurrent writer's fresh temp file the way an "older than N minutes" rule can).

### A14-F9 — [LOW] The header probes regex over raw frame bytes, not the header

- **Verdict**: **PARTIALLY CONFIRMED** — proven for `runFactsVersion`, **REFUTED**
  for `writtenAt`, and the report's own stated trigger does not work
- **Cited location holds?**: Yes. `HEADER_PROBE_BYTES = 4096` (`:257`),
  `RUN_FACTS_VERSION_RE = /"runFactsVersion"\s*:\s*(\d{1,9})/` (`:259`), matched
  against `readHeaderPrefix`'s raw 4096-byte window (`:234-246`), and the "~330
  bytes" comment at `:258`.
- **Reachable in production?**: Yes for `cacheHasCurrentRunFacts`.
- **Trigger — PROVEN, but not the one the report gives**
  (`scratchpad/v14/a14-f9.ts`, real `writeCache`/`readCache`/`cacheHasCurrentRunFacts`
  into a temp dir):
  ```
  header carries runFactsVersion: undefined
  raw file contains unescaped stamp: true
  bytes before the stamp: 557 (probe window = 4096)
  => cacheHasCurrentRunFacts: true   (TRUE means the poisoned cache is never refreshed)
  => cacheWrittenAt: 1786177276080   real header writtenAt: 1786177276080
  ```
  The poison is a **JSON key**, not message text: a `tool_use` block whose
  `input` contains a property named `runFactsVersion` serializes as an unescaped
  `"runFactsVersion":9`. `isBackfillContentBlock` accepts `tool_use` with any
  `input !== undefined` (`transcriptBackfill.ts:415-421`), so this is a legitimate
  transcript.
- **Counter-arguments considered — two of the report's claims fail here**:
  1. *The report's stated trigger is "a session whose first cached message
     contains the literal text `"runFactsVersion": 1` (pasting this review, for
     instance)."* **That does not work.** I ran it: message text is JSON-escaped
     to `\"runFactsVersion\"`, and the regex requires an unescaped closing quote,
     so it does not match. `cacheHasCurrentRunFacts` correctly returned `false`.
  2. *"the same for a bogus `writtenAt` changing the staleness verdict."*
     **Refuted.** `writtenAt` is **always** present in the header
     (`transcriptCache.ts:177`), and the header serializes before `frames`, so the
     regex's first match is always the real value. I confirmed
     `cacheWrittenAt === header.writtenAt` even with a planted
     `"writtenAt":4102444800000` in the frames.
  So exactly one probe is poisonable, only when the header lacks the field —
  i.e. only for an on-close cache — and only via an unescaped JSON key.
- **True consequence**: An on-close cache for a session that ever ran a tool with
  a `runFactsVersion` input key is treated as already carrying current run facts,
  so it is never queued for backfill and never gains a model/effort/usage face.
  Silent and permanent, as the report says; far narrower a trigger than it gives.
- **Evidence**: `scratchpad/v14/a14-f9.ts` and `a14-lows.ts` (the negative
  text-poisoning control).
- **Disposition**: Apply the report's fix (cut the probe at the first `"frames"`
  before matching) — it closes the real trigger and costs nothing. Correct the
  finding text: drop the `writtenAt` half and the "pasting this review" example,
  both of which are wrong, and replace them with the JSON-key case.

### A14-F10 — [LOW] `String()` coercion inside the fail-closed boundary parser

- **Verdict**: **CONFIRMED** (reproduced)
- **Cited location holds?**: Yes. `app/shared/transcriptBackfill.ts:140-142`
  (`['missing','invalid','session_mismatch','internal'].includes(String(value.reason))`)
  followed by `value.reason as TranscriptBackfillFailureResult['reason']` at
  `:148`; the same idiom for `file_type` and `media_type` at `:564` and `:587`.
- **Reachable in production?**: Yes — this is main's parser for every line the
  worker writes.
- **Trigger**: Reproduced (`scratchpad/v14/a14-lows.ts`):
  ```
  F10 reason:["invalid"] accepted: true
      {"type":"failure","appSessionId":"…","engineSessionId":"…","reason":["invalid"]}
  F10 typeof accepted reason: object
  F10 reason:["nope"] rejected: true
  ```
  A single-element array coerces to its element, passes `includes`, and is then
  `as`-cast to a string union it does not inhabit.
- **Counter-arguments considered**: (a) *Is harm bounded?* Yes — the worker is
  main's own child, and `reason` is only counted (`failed += 1`), never rendered
  from this record. (b) *Do the other two sites matter more?* `file_type` and
  `media_type` DO reach display through a cached document/image block, so an
  array-valued `media_type` would flow into the renderer as a non-string. Still
  bounded (the renderer runtime-narrows), but it is the sharper of the three.
  (c) *Does `hasExactKeys` prevent it?* No — it checks key sets, not value types.
- **True consequence**: The one place in a module whose entire job is strict
  narrowing where a non-string passes as a string. No live defect.
- **Disposition**: Apply as written — module-level `Set`s plus
  `typeof value.x === 'string'`, which also removes three per-call array
  allocations.

### A14-F11 — [LOW] `isRecord` is defined three times in this feature, with two different meanings

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes, exactly. `app/shared/transcriptBackfill.ts:630`
  and `app/main/transcriptCache.ts:447` are
  `typeof value === 'object' && value !== null && !Array.isArray(value)`;
  `app/sidecar/transcriptRunFacts.ts:227` omits the array clause, so arrays pass.
  `UUID_RE`/`isUuid` is duplicated at `transcriptBackfill.ts:32,626` and
  `transcriptCache.ts:104,107`, even though `transcriptCache.ts` already imports
  `parseTranscriptRunFacts` from that module (`:61`).
- **Reachable in production?**: Yes; the divergence is live but harmless.
- **Trigger**: A JSONL line that parses to a JSON array passes
  `transcriptRunFacts`' guard and then reads `undefined` off every field —
  producing the same result as rejecting it.
- **Counter-arguments considered**: whether the repo-wide numbers hold — they do:
  `rg -c "function isRecord" app --glob '!*.test.*'` matches **15** files and
  `rg -l "const UUID_RE" app --glob '!*.test.*'` returns **4**.
- **True consequence**: No defect; a name meaning two things across three files in
  one pipeline.
- **Disposition**: Apply the narrow half (export both from
  `app/shared/transcriptBackfill.ts`, import in the other two). Do **not** attempt
  the repo-wide 15-copy consolidation on this finding's authority — that is a
  separate change across trust boundaries, and `app/shared` is the only module all
  three of these already depend on.

### A14-F12 — [LOW] The content-block allowlist is a hand-maintained mirror with no tripwire, currently three types behind

- **Verdict**: **PARTIALLY CONFIRMED** (two behind, not three)
- **Cited location holds?**: Yes for the allowlist —
  `BACKFILL_CONTENT_BLOCK_TYPES` at `app/shared/transcriptBackfill.ts:374-395`,
  seventeen entries, no `mcp_tool_use`, no `mcp_tool_result`, no `compaction`.
- **What does not survive**: **`compaction` is not a history content block.** Its
  only occurrence in the engine is `src/utils/messages.ts:3217`, inside a
  `content_block_start` **stream-event** switch — not the history passthrough at
  `:2831-2835` the report cites, and it appears nowhere in
  `app/renderer/src/transcriptProjector.ts`. `mcp_tool_use` and `mcp_tool_result`
  are genuinely first-class in both (`messages.ts:2832-2833`;
  `transcriptProjector.ts:1832`, `:1890`). So the gap is two, and both are MCP.
- **Reachable in production?**: Not currently. I re-ran the scan independently
  (`scratchpad/v14/a14-blockscan.ts`, walking `~/.cat-code/projects`):
  ```
  transcripts=1808 user/assistant records=213187
  block types OUTSIDE the backfill allowlist: NONE
  ```
  (A14 reported 1,780 / 203,640 — the store has grown since; the conclusion is
  identical.)
- **Trigger**: An MCP server emitting rich output. `isBackfillContentBlock` returns
  false, `parseTranscriptFrame` returns null, the whole session becomes a
  `failure` record — pinned by `transcriptBackfillWorker.probe.test.ts:291-371`,
  which asserts exactly this shape on a real spawned process. The session then has
  no cache, so `selectTranscriptBackfillCandidates`' `!hasCache` clause re-queues
  it every launch, forever.
- **Counter-arguments considered**: whether the `tool_reference` precedent is
  really the same shape — it is, and the in-file comment at `:388-393` says so
  ("Omitting it made every session that ever ran a tool search unvalidatable").
- **True consequence**: A latent per-session permanent failure for any MCP-rich
  session, plus a wasted candidate slot per launch. Zero occurrences today.
- **Disposition**: Apply — derive the set from the engine union in the
  `app/shared` snapshot types so a new block type is a compile error. Correct the
  count to two and drop `compaction` from the finding. **Cross-reference A14-F5's
  disposition**: this is precisely why `parseTranscriptCache` must not adopt
  `parseTranscriptFrame` wholesale — a stale allowlist there would *delete*
  existing caches rather than merely refuse new ones.

### A14-F13 — [LOW] The truncation notice misdescribes two of the three ways it can fire

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `transcriptBackfillWorker.ts:275-285` unshifts
  the single notice `` `Only the ${retained.length} most recent messages are shown.` ``;
  the `structuredClone` failure `continue`s at `:247` and the
  `checkJsonSafe`/`scanForSecrets` failure `continue`s at `:252`, both setting
  `truncated = true` while dropping a message from the **middle**. Only the
  budget arm at `:263-269` `break`s, which is the head truncation the sentence
  describes. `transcriptBackfill.ts:92` is `if (result.frames.length === 0) return 'ineligible'`.
- **Reachable in production?**: The grammar case is; the gap case is not.
  Independently re-measured: zero of 213,187 records across 1,808 transcripts
  would trip `scanForSecrets`. The single-frame grammar case is reachable — the
  largest single user/assistant record I found is well under, but the mechanism is
  `retained.length === 1` after one oversized message, and `N === 0` after a first
  message over 4 MiB.
- **Trigger**: For `N === 0`: the newest message alone exceeds
  `MAX_HISTORY_REPLAY_BYTES`, so the loop `break`s immediately, `retained` is
  empty, the notice is unshifted, and `frames.length === 1` — which slips
  `transcriptBackfill.ts:92`'s guard because it counts **frames**, not **message**
  frames. The result is a cache containing only a notice, i.e. exactly what
  `:89-92`'s comment says must never be written ("A cache with no transcript
  frames is worse than no cache").
- **Counter-arguments considered**: (a) *Is the notice unique to the worker?* No —
  the same sentence is minted at `replayBuffer.ts:283` and `sidecarServer.ts:758`,
  so any fix should decide whether all three share wording. My live-store census
  found 6 caches carrying a truncation notice across two distinct wordings, one of
  which (`"Restored history was truncated to N recent events."`) no longer exists
  in source. (b) *Does the renderer distinguish them?* No — all three use
  `HISTORY_REPLAY_TRUNCATION_REQUEST_ID`.
- **True consequence**: A user-visible sentence that is wrong about *what* was
  lost in two of three paths, ungrammatical at N=1, and a persist guard that a
  notice-only cache walks straight past.
- **Disposition**: Apply all three halves, and count **message** frames in the
  persist guard first — that is the only half with a data consequence rather than
  a wording one. Note §7: the notice is user-visible text, so the mid-drop wording
  must not name the mechanism (`structuredClone`, secret scan) on screen.

---

## Findings the original reports missed

### [MED] `runControlsDomain.test.ts` pins the exact identity A16's HIGH proposes to break

Neither A16 nor V27 nor V30 checked whether the proposed sidecar change has test
coverage. It does: `app/sidecar/runControlsDomain.test.ts:393-396` asserts
`opus.contextWindow === 1_000_000` **and**
`=== getContextWindowForModel('claude-opus-5', getSdkBetas())`, and `:405-407`
repeats the identity for `haiku`. Making `readContextWindow` return
`getEffectiveContextWindowSize` fails both. Anyone acting on A16-F1's fix line
will hit this in the first battery run; it belongs in the finding, because it is
also the clearest statement of what that field *means* on the wire.

### [LOW] The preview donut cannot be fixed by A16's proposal at all

`previewTranscriptState.ts:231` calls `selectContextUsage(messages, model)` with
**no** `modelContextWindow` argument, so a previewed session's donut takes its
window from the cached `result` frame's raw `modelUsage[].contextWindow` or the
200k default. Whatever denominator the live rail moves to, the preview rail keeps
the raw one unless this call site changes too — two panes, one gauge, two bases.
Neither A16 nor either prior verifier noticed the second call site.

### [LOW] Two truncation wordings coexist on disk, one of them from deleted code

Six of 58 live caches carry a truncation notice, in two wordings:
`"Only the N most recent messages are shown."` (current, minted in three places)
and `"Restored history was truncated to N recent events."` — a string that
`git log -S` shows was removed in `f600da5` and exists nowhere in the tree. So
the preview surface today shows users a sentence no current code can produce, and
`transcriptCache`'s refresh logic has no way to notice a cache is that old
(`guardVersion` did not move). Relevant to A14-F3 and A14-F13 together: if
wording is being changed anyway, a cache-era marker would let the refresh path
prefer a current artifact over a legacy one.

---

## Working-tree state

All `app/` files in both scopes are branch-new relative to `main`. **Dirty files
touched by these findings, and whether the dirt matters:**

| File | Findings | Diff | Affects the citation? |
|---|---|---|---|
| `app/renderer/src/contextUsage.ts` | A16-F1, A16-F4 | comment-only, `pressureTone` doc block | **No** — `:281-333`, `:350-381` unchanged; its test file is 29 pass / 0 fail on the working tree |
| `app/renderer/src/contextBreakdownState.ts` | A16-F5 | additive `colorHex` from `:75` down | **No** — the reducer at `:18-62` is untouched |
| `app/renderer/src/planState.ts` | A16-F9 (referenced), cast census | comment-only, `PlanApprovalMode` doc | **No** — `:59` cast and `selectNonPlanPermissionQueue` unchanged |
| `app/renderer/src/ComposerActionsBar.tsx`, `PermissionModeChip.tsx` | A16-F8 | modified (another session) | **The fix touches them** — coordinate before editing |
| `app/main/main.ts` | A14-F1, A14-F2 | comment-only at `:998` | **No** — backfill code at `:348-480` untouched |

`app/sidecar/permissionDomain.ts` and `sessionController.ts` are also dirty but
are outside both scopes' citations.

## Unresolved uncertainty

- **A16-F3 (`permission_not_found`)** is UNPROVEN, not INVALID, because I proved
  only that the *engine* cannot drop a pending request silently
  (`AppSessionController` mutates its map in two places, each with an emit). I did
  not exhaustively rule out frame loss in the socket/attachment-gate path under
  backpressure. What would settle it: a probe that drops one
  `permission.resolved` frame in transit and observes the card, or an audit of
  `attachmentGate`'s coalescing limits against a burst of permission events.
- **A16-F11 (IME)** cannot be tested in the current renderer suite (SSR-only, no
  composition events). The DOM-read-wins half is certain from source; the specific
  parked-release collision is not demonstrated and should be marked UNVERIFIED in
  any fix.
- **A14-F1's real-world reachability** rests on my measurement that SIGTERM beats
  the next record at 0–60 ms spacing on this machine. A slower main thread (the
  post-paint window is exactly when it is busiest) or a burst of cheap `failure`
  records could invert that. I did not attempt to build the burst case against a
  real worker.
- **A14-F3** has no on-disk artifact demonstrating the truncation it predicts.
  What would settle it: run one desktop session past 4,000 frames, close it, and
  compare the on-close cache's frame count before and after the next launch's
  backfill. That is an operator GUI step, not something I can do here.
