# Review implementation finding quality audit: consolidated appendices

Companion to [the main audit](2026-08-22-review-impl-finding-quality-audit.md). This document combines Appendices A through D in their original order.

## Source appendices

- [Appendix A: re-verification](2026-08-22-review-impl-audit-appendix-a-reverification.md)
- [Appendix B: finding corpus and taxonomy](2026-08-22-review-impl-audit-appendix-b-corpus.md)
- [Appendix C: escapes and recurring defect shapes](2026-08-22-review-impl-audit-appendix-c-escapes.md)
- [Appendix D: yield normalization and battery-catchability](2026-08-22-review-impl-audit-appendix-d-normalization.md)

---

## Appendix A — Re-verification of 33 VALID findings against source

A subagent was given the 382-row finding corpus, the session index, and read-only access to the
repository. It was **not** given any conclusion of the main report. Its brief was adversarial:
sample findings labeled VALID, establish the truth from current source and git history, and
actively hunt for cases where the finding was wrong.

Sample: **33 findings across 24 distinct sessions**, weighted toward concrete `file:line`
behavioral claims.

**Result: 0 of 33 refuted.**

### Verdict table

| # | Session | File / symbol | Finding | Verdict | Evidence |
|---|---|---|---|---|---|
| 1 | 66f06b65 | `systemPromptSections.ts:sectionCacheKey` | `#` in section name collides; `('a','ab#z')` and `('a#s4:ab',null)` both → `a#s4:ab#z` | REAL+FIXED | `d2783756` shows pre-fix `` `${name}#${encode()}` ``; both encodings recomputed by hand, byte-identical |
| 2 | 463ff374 | `fastMode.ts:getFastModeModel` | Fast Mode demotes Sol → Terra | REAL+FIXED | `3153a35a`: `- return 'gpt-5.6-terra'` / `+ return 'gpt-5.6-sol'` |
| 3 | 3aacc503 | `FileWriteTool.ts` read-before-write gate | Line-capped read satisfies the gate | REAL+FIXED | At `53be676f~1` the text path set only `{content,timestamp,offset,limit}`, gate tested only `isPartialView`. `53be676f` adds `isTruncatedView` |
| 4 | 62445105 | `analyzeContext.ts` → `toolSearch.ts:141` | Display estimate suppressed the `total===0` "API unavailable" sentinel | REAL+FIXED | `e1a49e94` restores the null contract; HEAD comment names `toolSearch.ts:141` |
| 5 | a9454c20 | `prompts.ts:getSystemPrompt` | Agent-Mode branch nulls doing-tasks *and* actions with no core policy | REAL+FIXED | At `bf7beca9` both were `isAgentMode ? null : …` with no `getCorePolicySection()`; `c951476a` adds it |
| 6 | a9454c20 | `rolePrompts.ts:getCodingWorkerSystemPrompt` | Two resolvers answer "which edit tool" — request vs session provider | REAL+FIXED | `c951476a` replaces `provider === 'openai' ? FILE_PATCH : FILE_EDIT` with `getAsyncAgentFileEditTool()` |
| 7 | 5df08177 | `AgentTool.tsx` lease comment | Comment claims `errors.ts` classifies the exhaustion; it does not | REAL+FIXED | Independently: `registerCodexLease` at `claude.ts:1175`, `queryModel`'s try opens at `:1984`. `2763a080` rewrites it |
| 8 | 36e61c86 | `sideQuery.ts` withRetry | `maxRetries: 0` exhausts after a successful owner failover | REAL+FIXED | `a554b4a1`: `- maxRetries` / `+ maxRetries: Math.max(1, maxRetries)`. Reachable — `validateModel.ts:68` passes `maxRetries: 0` |
| 9 | 36e61c86 | `AgentTool.cleanup.test.ts` | Module mock contaminates combined suites | REAL+FIXED | Pre-fix `70563f8e` has two top-level `mock.module(...)` with no restore; `a554b4a1` replaces with real lease-state assertions |
| 10 | 3d21ec77 | `messageQueueManager.ts:clearCommandQueue` | Docstring misattributes it to ESC | REAL+FIXED | Verified independently: only production callers are `useCancelRequest.ts:253` and `usePtcloveBridge.ts:466`. ESC uses `popAllEditable` |
| 11 | 3d21ec77 | `sidecarServer.ts:handlePromptRecall` | Synchronous `ok:false` unreachable; the reachable race reports clean success | REAL+FIXED (partial proof) | `stagedCount` captured at top of a synchronous handler; a corrections path at `:2162-2171` emits the late `ok:false`, consumed by `verbAckResultState.ts:177` |
| 12 | 3d21ec77 | `App.tsx` Queued row | Markup copy-duplicated inline, can drift | REAL+FIXED (later) | HEAD has one `QueuedRow`; `App.test.tsx:1004` pins `'Image attachment'` to exactly one source occurrence |
| 13 | 23f4d3f7 | `agentModeDomain.ts` | `dismissed` never cleared; resumed worker suppressed forever | REAL+FIXED | `bf30642f` adds `dismissedStillPending` |
| 14 | 23f4d3f7 | `workerInspection.ts:selectWorkerDismissTargetId` | Dismiss is a dead control on persisted-plane rows | REAL+FIXED | `bf30642f`. Pre-fix comment claimed the sidecar "fails closed on a target it cannot dismiss" — which *was* the bug |
| 15 | 6d0ce8ac | `sidecarServer.ts` boundary drain | `startTurn` with no rejection handler → prompt lost silently | REAL+FIXED | `7b0164b5` adds `onInputPersisted`/`onSettled` with requeue-once; commit body states the defect |
| 16 | 9b55eb47 | `subagentHistory.ts:projectBranchFrames` | Non-assistant/user frames spliced unstamped | REAL+FIXED | Transcript shows pre-fix pass-through `if (frame.type !== 'assistant' && frame.type !== 'user') return frame`; HEAD filters them |
| 17 | 379fa640 | `transcriptBackfill.ts` + `mainDecisions.ts` | Refresh gates test presence, not completeness → 30/44 caches keep `contextWindow: null` | REAL+FIXED | `89569a88` introduces `runFactsVersion` + `cacheHasCurrentRunFacts`; commit body gives the 30/44 count |
| 18 | 64fa9c9e | `TranscriptView.tsx:FILE_PATH_RE` | Root files and spaced backtick paths missed | REAL+FIXED | Pre-review regex required `/` in **every** alternative, so `README.md` could not match; HEAD adds a bare-filename alternative |
| 19 | 64fa9c9e | `TranscriptView.tsx:isWebPath` | Scheme-less web targets become file controls | REAL+FIXED | Pre-review guard was only `':/'`/`'//'`; `example.com/readme.md` matched the old regex. HEAD adds `WEB_PATH_RE` |
| 20 | 77a1d024 | `accountsPoolWorker.ts` | `__proto__` model name drops the row / reshapes the prototype | REAL+FIXED | Pre-fix `const out: Record<string,number> = {}`; `1d9c765e` → `Object.create(null)` |
| 21 | 2d5da6ab | `ComposerActionsBar.tsx` onCompact | `setOpen(false)` not `close()`, drops trigger focus restore | REAL+FIXED | Transcript shows the pre-review hunk using `setOpen(false)`; `composerPopover.ts:41` proves `close()` calls `restoreTriggerFocus()` |
| 22 | b7b41510 | `TranscriptView.tsx:agentToolSourceOf` | `identity.id` always null, id keying inert | REAL+FIXED | `41dfbac1` **adds** `const agentId = row.result?.agentId` — pre-fix absent, so the whole feature was a no-op |
| 23 | b7b41510 | `agentIdentity.ts` / `agentFace.ts` fills | 69% colour collision at five workers | REAL+FIXED | Math exact: `1 − P(10,5)/10⁵ = 69.76%`. HEAD has `takenFills` dedupe + `FACE_FILL_COUNT = 10` |
| 24 | 3da947dd | `TranscriptView.tsx:OrphanedAgentCard` | "N messages" counted projected rows | REAL+FIXED | `32c5d700`: `- const count = row.children.length` → `new Set(...messageId).size` |
| 25 | 48a3d62b | `tuiSessionStatus.ts:deriveLocalWaitingReason` | Non-blocking dialog suppresses a pending worker/sandbox request → false `idle` | REAL+FIXED | `2fa8640d`. Pre-fix doc said requests "only apply when no dialog is observed" — that *was* the bug |
| 26 | 55b8f9c3 | `App.tsx:liveTokens` | Walks the full raw log per delta for 30s before anything can display | REAL+FIXED | `7c6959f0` adds the `elapsedMs > SHOW_TOKENS_AFTER_MS` gate |
| 27 | 2d7b530b | `FileEditTool/types.ts:outputSchema` | Comment's mechanism wrong: `z.object` strips, does not reject | REAL+FIXED | **Ran it**: undeclared key → `success: true`, `data: {"a":"x"}`; declared key preserved |
| 28 | 62445105 | `contextBreakdownDomain.ts` | `loadConversationForResume` is not a reader | REAL+FIXED | All four side effects present in `conversationRecovery.ts`; `transcriptBackfillWorker.ts:42` sets `CLAUDE_CODE_SIMPLE=1` to neuter exactly that |
| 29 | f9b104ec | `TasksDialog.tsx` heading | `-ml-3` + `pl-3` cancel out: dead markup | REAL+FIXED (nuance) | Element sits inside a `border-l … pl-3` parent with no border or background of its own; offset does cancel. See caveat below |
| 30 | d595a8ba | `App.tsx` composer placeholder | Dead disjunct `\|\| status === 'ready'` | REAL+FIXED | `connectionState.ts:52` returns `CONNECTING` for a missing session; `selectComposerGate` requires `status==='ready'`. HEAD placeholder is a bare ternary |
| 31 | 77fbf5d0 | `codex-websocket-transport.ts:acquireConversationTurn` | Timer armed after `queue.pending++` but outside the `try`; a throw skips `releaseGate()` | REAL+FIXED | `141116ca` moves the arm inside the try |
| 32 | 77fbf5d0 | `query.ts` stop_hooks vs `query/stopHooks.ts:145` | 60s threshold collides with that path's own 60s guard | REAL+FIXED | HEAD `PHASE_THRESHOLD_MS = { stop_hooks: 90_000 }`; `stopHooks.ts:145` still `60_000` |
| 33 | 05d68ce0 | `TranscriptView.tsx:readRangeLabel` | Off by one; `offset` is 1-based, comment cited it backwards | REAL+FIXED | `FileReadTool.ts` does `const lineOffset = offset === 0 ? 0 : offset - 1` |

### The one loose case

**#29** (`TasksDialog` `-ml-3`/`pl-3`) was scored REAL, but its *reasoning* is looser than its
verdict implies. The finding says the classes "cancel out exactly, no visual effect". A
negative left margin also widens the box by 12px, so text wrapping and any hover background
would differ. On that particular element — a short flex heading with no border and no
background of its own — the claim holds in practice. It is the only finding in the sample
whose argument is weaker than its conclusion.

### User-impact split of the 33 confirmed-real findings

| Band | Count | Examples |
|---|---:|---|
| **A user would have noticed** | 19 | Silent whole-file overwrite after a partial read (#3); lost prompt on a refused turn (#15); Fast Mode silently downgrading the model (#2); recall reporting success then delivering anyway (#11); a Dismiss button that did nothing under a contradicting toast (#14); session reporting `idle` while blocked, letting goal continuation fire (#25); a worker's compact boundary rendering in the main transcript (#16); the face-identity feature inert plus 69% colour collisions (#22, #23); wrong message count on screen (#24); a read-only popover running SessionStart hooks in the live process (#28); permanently-suppressed resumed worker (#13); hang from a skipped `releaseGate()` (#31); a worker prompt naming an edit tool it does not have (#6); spurious side-query failure after successful failover (#8); context donut stuck with no window (#17); mis-linkified paths (#18, #19); keyboard focus dropping to `<body>` (#21) |
| **Internal only** | 10 | #1, #4, #5, #9, #12, #20, #26, #29, #30, #32 — cache-key hardening, gated model-behavior change, latent prompt-array branch, test isolation, markup duplication, `__proto__` hardening, per-delta perf, dead markup, dead disjunct, false diagnostic record |
| **Prose only** | 4 | #7, #10, #27, #33 |

### Stated limits of this lane

Reproduced from the subagent's own report rather than paraphrased, because the caveats are
load-bearing:

- **Self-selection.** 30 of 33 defects were fixed within minutes to hours by the same session,
  so the VALID label is closer to "I confirmed this before changing it" than to a blind
  judgment.
- **Sampling filter.** A `file:line` citation was required, which favors findings concrete
  enough to be right. A vague VALID finding is both likelier to be wrong and likelier to have
  been excluded. The 0/33 rate applies to the concrete cited subset — roughly 152 of the 291
  VALID rows.
- **Uncommitted-code provenance.** `/review-impl` reviews just-written, usually uncommitted
  code, so for about six findings git cannot show the "before" state; the finding and its fix
  land in one commit. Those were recovered from session JSONL — solid evidence, different
  provenance.
- **#11** was scored REAL on partial proof; true unreachability would require auditing every
  stage/unstage site in `query.ts` and `sidecarServer.ts`.
- **#2** proved `getFastModeModel()` returned Terra pre-fix, but did not independently confirm
  that Sol was the Codex default on 2026-08-17; that rests on the fix commit's own framing.

What would change the verdict, in the subagent's own terms: a NOT-REAL case surfacing among
findings marked VALID and **not** fixed — those leave no diff and are much harder to sample —
or a finding whose fix commit contradicts the finding's own stated mechanism. Both were looked
for; neither was found.

---

## Appendix B — Finding corpus, taxonomy, and why the review over-fires

---

### 1. Corpus shape

382 deduped finding rows, 30 sessions, 2026-07-26 → 2026-08-22.

> **Superseded in part by [Appendix D](2026-08-22-review-impl-audit-appendix-d-normalization.md) §1.**
> The real corpus is **34 review runs** across 38 invocations, and ~375 distinct findings. The
> scrape these tables are built on drops every validation table with a non-numeric `#` column —
> four whole reviews (`76e10e2b`, `cc9feb6e`, `97b04c6f`, `1ba97aa9`, 46 findings between them)
> — and double-counts findings restated in a Step-4/5 summary, inflating by ~10%. The shares in
> this appendix are computed over the 382 scraped rows and remain internally consistent; treat
> them as proportions, not as a census.

| Verdict as self-labeled | Rows | Share |
|---|---:|---:|
| VALID | 291 | 76.2% |
| FALSE POSITIVE | 36 | 9.4% |
| DEFERRED | 22 | 5.8% |
| Deferred to a new session | 15 | 3.9% |
| Not labeled in the row text | 18 | 4.7% |

201 rows (53%) cite a concrete `file.ts:line`.

Only **19 rows in the entire corpus carry an explicit HIGH / MED / LOW label.** That is not a
reporting oversight in this audit; it is the finding. See Appendix C §1 for why: the severity
column was requested on 2026-08-08, written to a skill mirror instead of the canonical file,
and overwritten ~14 hours later by a `--force` republish. The 19 labeled rows cluster almost
entirely in the two reviews that ran inside that window.

---

### 2. Taxonomy

**Method caveat, stated up front: these buckets are keyword-derived from the row text and are
approximate.** Several rows are visibly misfiled — a row whose text contains "blocking" lands
in Performance even when it describes a correctness bug. Treat the shares as indicative. The
verdict counts in §1, the re-verification table in Appendix A, and the operator-reaction
evidence are exact; these are not.

| Bucket | Rows | Share |
|---|---:|---:|
| Behavior bug — wrong output, lost data, bad state | 196 | 51.3% |
| Doc or comment states something false about the code | 72 | 18.8% |
| False positive | 36 | 9.4% |
| Performance / resource | 24 | 6.3% |
| UI copy, naming, accessibility | 22 | 5.8% |
| Test gap, or a test that cannot fail | 19 | 5.0% |
| Dead or inert code just written | 13 | 3.4% |

Cross-cutting counts over the same corpus, independent of bucket:

| Signal | Rows |
|---|---:|
| Mentions silent loss, dropping, or swallowing | 46 |
| Stale or false doc/comment language | 25 |
| Dead / inert / never-fires | 18 |
| Explicitly about **pre-existing** code, not the session's diff | 18 |
| Agent explicitly attributing the defect to its own work this session | 17 |
| Empirically proven — reproduced, measured, or the real function was run | 23 |
| Test that cannot fail / proves nothing | 5 |

The **18 pre-existing rows out of 382 (~5%)** is the number that reframes the whole question.
`/review-impl` is not auditing a mature codebase. It reviews the diff the session wrote minutes
earlier and has usually never executed. High yield on that material is expected.

---

### 3. Why the ~19% doc-and-comment bucket is not pedantry

This is the bucket that looks most like nitpicking and is not. Three independent lines converge:

1. **Appendix A** found the doc findings were factually right every time they were checked —
   including a zod-semantics claim that was verified by running it, and a "this function is not
   a reader" claim whose four alleged side effects were all present in source.
2. **`docs/migration/reviews/2026-08-03-week-code-review.md`**, a different review path weeks
   earlier, reached a blunter conclusion: *"in this codebase a confident doc comment is
   currently a signal to check, not a reason not to. Four of the five HIGHs sit directly under
   one."*
3. **Appendix C §4** shows this is the single most common recurring shape in the corpus —
   present in at least 14 of 30 sessions — with **no automated prevention whatsoever**, because
   `bun run lint` enables zero rules (all 19 custom rules are `createNoopRule()` stubs).

One case compounds: a commit propagated a pre-existing error into fresh prose with a specific
wrong `file:line`, which then *"misled the next reviewer inside this very review."*

---

### 4. Where the review genuinely over-fires

36 findings were rejected as FALSE POSITIVE. **None of them is a style complaint.** They cluster
into five recognizable causes, all of them context gaps.

#### Cause 1 — flags code outside the task-scoped diff (largest class)

> `2d5da6ab` — "No feedback when clicked mid-turn" → *"Agent itself confirms this is
> pre-existing behavior of every mid-turn submit, not introduced here"*

> `3dd55442` — "Role-less row loses trailing slot" → *"pre-existing line I never touched, and
> `AgentTypeChip` returned null for that case too, so no regression"*

> `463ff374` — "Round linecap makes the arc read ~3.7% past its end" → *"pre-existing; removing
> the cap breaks the documented empty-state dot"*

Note the tension with Appendix C: this same instinct, applied one step too aggressively, caused
escape 2 — a defect correctly identified and then discarded as "pre-existing" when the surface
asserting it was new. Scope discipline cuts both ways.

#### Cause 2 — unaware a behavior is deliberate parity with the terminal engine

> `6d0ce8ac` — "Abort mid-drain-window can re-deliver" → *"Identical in the terminal —
> `removeFromQueue` is at `:1699` there too. Engine-shared semantics, and the user still sees
> one row. Parity, not a desktop defect."*

> `d595a8ba` — "Stop/Esc fires the queued prompt instead of dropping it" → *"The terminal does
> the same: `useCancelRequest.ts:96-101` cancels the turn and returns, leaving the queue"*

#### Cause 3 — reasons about a branch that cannot execute

> `6d0ce8ac` — "Requeue-to-tail inverts order" → *"Arm is unreachable: no await between the
> `parking`/`activeTurn` check and `startTurn`."*

> `55b8f9c3` — "Subagent filter inconsistent with sibling" → *"`QueryEngine.ts:941` stamps
> `parent_tool_use_id: null` on every stream event, so the guard would be inert; adding it
> would read as protection that isn't there"*

> `66f06b65` — "`-0`/`0`, sparse arrays encode alike" → *"No numeric or array-with-holes input
> exists or is constructible via the typed helpers"*

#### Cause 4 — objects to a conscious, documented tradeoff

> `66f06b65` — "Over-keys names when only `.length>0` is read" → *"Deliberate. Under-keying
> yields a silently wrong prompt; over-keying costs a Map entry. Safe direction wins."*

> `77a1d024` — "'Loading usage analytics' vs bare 'Loading'" → *"deliberate; the chart
> placeholder is a large empty region that must name itself, the inline ones sit under their
> own headings"*

#### Cause 5 — demands a test the harness structurally cannot express

> `64fa9c9e` — "No live click test" → *"This renderer suite is server-render-only and cannot
> dispatch DOM events"*

> `aee64f62` — "Grep pins one spelling" → *"That file's header argues this limitation
> explicitly; a runtime test needs main.ts wiring extracted, disproportionate here"*

This cause is the review colliding with the SSR-only renderer suite — the same structural gap
the week code review named as the reason *"2333 pass does not mean what it looks like it
means."* The reviewer is not wrong that the coverage is absent; it is wrong that this diff can
supply it.

#### Cost of over-firing

Low, and worth stating precisely: **every false positive was killed by the main agent's own
Step-3 validation before any code changed.** Over-firing costs turns, not correctness. One
session recorded *"Zero false positives across both reviewers."*

---

### 5. Operator disposition of deferred work (NOT evidence of finding quality)

> **Retracted as corroboration, 2026-08-22, at the operator's correction.** This section
> originally read operator follow-up as evidence that the findings were valid. **It is not**,
> and the report no longer relies on it. Full reasoning in the main report §3.

The operator generally **did not inspect the individual findings**. When they asked about a
DEFERRED item they were asking *why* it was deferred, and when the answer was size, time, or
risk they accepted that cost. That is a disposition decision, not a technical judgment. Every
quote collected for this section decides cost, timing, or ownership:

| Quote | What it actually decides |
|---|---|
| "how hard for these deferred?" · "give me 1-10 score" | cost |
| "what is deffered now? does anything worth it?" | delegates worth back to the agent |
| "if what deferred worth the fix then it fine. Just gix it" | conditional on the agent's own assessment |
| "you can just fix both open now. no one gonna do it if not you" | ownership |
| "I think we fix it now. Dont defer" · "nah, i think we do it now" | timing |

The absence of rejection carries near-zero signal for the same reason: you cannot reject what
you did not read.

**Where the operator did judge independently, they rejected.** Their genuine observations were
about visible outcomes, and those were negative: *"So i telling you that it not passed"*,
*"This is current. The color is gone."*, *"Why i didnt see the change at all?"*, *"i didnt
change anything but now the donut gauge when clicked look like this now"*. Two are the escapes
in Appendix C §2. Read correctly, operator behavior is at best neutral for the review and at
worst mildly adverse.

The one durable item here is **operator doubt**, not endorsement. Session `3aacc503`,
2026-08-14:

> "what? why so many problem foudn"

The answer given then, which this audit confirms and which was subsequently not acted on:

> "The raw count is misleading — I relayed the agents' itemized list without triaging it."

---

### 6. Reproducing this corpus

The extraction is non-obvious in one respect worth recording. Grepping transcripts for the
string `review-impl` matches almost every session in the history, because the skill name
appears in the available-skills listing injected into every session's context. The invocations
must be matched on the literal command tag instead:

```
grep -rl 'command-name>/review-impl<' ~/.claude/projects/ ~/.cat-code/projects/
```

That yields 41 files, of which 7 are compaction-summary artifacts carrying another session's
text and must be excluded. Findings are then recovered from assistant turns after the
invocation line that contain the Step-3 verdict vocabulary, and deduped — several sessions
print the validation table repeatedly as it fills in.

---

## Appendix C — Escapes, reverted fixes, and recurring defect shapes

This lane tested the review from the direction the other lanes could not: **what got through
anyway.** Method — for each of the 30 review sessions, take the reviewed diff and its cited
files, then search later human messages (2,116 across 396 transcripts) and later commits
touching those same files.

---

### 1. The severity column was requested, applied to the wrong file, and overwritten

This is the most actionable finding in the entire audit, because it means the fix recommended
by the main report is not a new idea — it is a restoration.

**2026-08-08 15:49, session `99d05643`:**

> "In review impl skill, i think the table missing the severity. Can you tell the model to add
> it?"

The agent made three edits — the Step 3 table column, plus Agent 1 and Agent 2B reporting
instructions — and wrote them to the **mirror** at `~/.claude/skills/review-impl/SKILL.md`,
never to the canonical `~/.agents/skills/`.

**2026-08-09 05:44, session `9f66db0e`:** a different session edited the canonical file for an
unrelated reason and ran `publish-skill.mjs publish global … --force`. The publish reported:

> `claude-code: replace divergent mirror (/Users/pt/.claude/skills/review-impl)`

That divergent mirror *was* the severity change. It was overwritten roughly 14 hours after it
was written.

**Verified at the time of this audit:** all three copies — canonical `~/.agents/`, and the
`~/.claude/` and `~/.cat-code/` mirrors — are byte-identical (`md5 b0c40d43…`) and contain
**zero** occurrences of "sever".

**The effect is measurable in the finding corpus.** Severity labels appear in 11 of 11 findings
for session `f9b104ec` and throughout `1ba97aa9` — the two reviews that ran during the ~14-hour
window the change was live — and in only 2 of the 15 reviews after the republish.

This is a textbook instance of the failure mode the skill-publisher architecture exists to
prevent: **edit the canonical source, publish, verify — never edit a mirror.**

---

### 2. Escapes — defects that survived a review pass

Two user-visible escapes are firmly established, two more are same-class recurrences in
adjacent code, one is latent but real.

| Complaint | When | Area | Inside a reviewed diff? | Could the review have caught it? |
|---|---|---|---|---|
| "i didnt change anything but now the donut gauge when clicked look like this now" + screenshot showing `Context 71% · 262k / 372k` with only `Skills 2.6k` and `Free 318k` | 2026-08-04 18:54, **3h45m after its own review** | Context breakdown popover; root cause in `analyzeContext.ts:countTokensWithFallback` | Yes for the display contract; **no for the failing callee** | **Yes — and it nearly did.** See below |
| "So i telling you that it not passed" (rejecting GUI acceptance on a screenshot showing `Main thread 0s`) | 2026-08-08 18:17, **22 min after its review table** | `leaseState.ts` / `TasksDialog.tsx`; root cause `synthesizeMainLease` | The asserting surface was; the synthesising function was not | **It did catch it, then discarded it.** See below |
| "the model name, effort, mode, fast mode, selected account, context token is missing when that session is disconnected" | 2026-08-08 18:35 | Transcript run-facts / cached session preview | Adjacent, not inside — a *different writer* than the one reviewed | Partly. Fixed 19 min later by `e2fc6054` |
| (internal) core policy dropped in bare mode | 2026-08-09 | `prompts.ts` `CLAUDE_CODE_SIMPLE` branch | **Same function, different branch** than the one fixed 07-30 | Yes, trivially, by enumerating the mode matrix. `39f34c5e` had to extend the review's own test helper |
| (internal) popover header and legend rows read two different snapshots | 2026-08-09, `7b64f855` | `ComposerActionsBar.tsx` + `contextBreakdownState.ts` | **Yes**, both in the reviewed diff | Yes. The review found an adjacent basis mismatch but not this one |

#### Escape 1 — the review wrote down the cause and filed it under the wrong heading

At 15:25:43 the review's own validation text said:

> "Confirmed the sharp edge: `getAnthropicClient` re-derives the provider from the model
> string, so on a `gpt-*` session `countTokens` takes the Codex path, **fails**, and falls
> through to real Haiku sampling."

It filed that as finding #3 under **Performance** — *"~10 count_tokens calls … VALID —
bounded; design decision open"* — and never asked the Correctness question: what does the panel
render when those counts return null? The user hit it 3h45m later. The fix commit `5ad863a0`
opens:

> "Reported: the popover listed only 'Skills 2.6k' and 'Free 318k' beside a header reading
> '71% · 262k / 372k'. Three contradictory numbers."

#### Escape 2 — the review found it and waved it off as pre-existing

Review Agent 1, at 17:36:58, in its own *not-a-finding* list:

> "`held` reading `0s` for a synthesised main lease: real, but it comes from the engine
> re-minting `createdAt` at snapshot time (`codexAccountLeaseManager.ts:427-432`) and
> **predates this diff**."

The session's own words at 18:20, after the user rejected the GUI acceptance:

> "I had this finding in review and waved it off as pre-existing; that was wrong, because the
> panel asserting it is new and mine."

#### The structural pattern

Both hard escapes sat **one hop outside the diff, on the callee side.** The skill tells Agent 1
to *"Review only the task-scoped diff and the touched files"*, and Agent 2B's blast-radius lens
looks at **callers** of the new code. Nothing looks at whether what the new code **calls**
actually works in this app's runtime configuration.

#### Ruled out as escapes

The Accounts usage-analytics complaint (2026-08-15) — that code arrived via `fa3531c4`, never
reviewed. "Agent 'Wilkes' stuck above the composer" (2026-08-08) — `OrchestratorRoster.tsx`,
not in any reviewed diff. The subagent lease-account complaints (2026-08-20/21) — `bd29c3ff`
was never review-impl'd. The renderer OOM line — none of its commits went through this skill.

---

### 3. Reverted or wrong fixes

**Zero review-driven fixes were git-reverted.** Seven distinctive symbols introduced by review
fixes were sampled — `STRANDED_KEY`, `isBreakdownTrustworthy`, `NON_LEASE_SELECTION_KINDS`,
`cacheHasCurrentRunFacts`, `runFactsVersion`, `projectContextBreakdown`, `ProjectableLease` —
and **all survive at HEAD**.

Four cases of rework or wrongness, none of them a revert:

1. **The severity-column loss** — section 1 above.
2. **`30ce2b8f perf(app): make the context breakdown attach-scoped`** was the review's own
   Performance remediation, reworked 39 minutes later by `57dc5fa6` after the agent conceded
   *"That's a real downgrade from what I showed you earlier"* and the user replied *"I dont
   really understand but i just want a real implementation."* The rework also reversed a
   documented design decision recorded in `ca5e8835`.
3. **A fix's blast-radius claim was wrong and changed model behaviour.** `5ad863a0` asserted
   *"countTokensWithFallback is private to that file, so the blast radius is /context and this
   popover."* The session's **second** review pass proved that false — `e1a49e94`:
   *"countTokensWithFallback's null is a load-bearing sentinel: toolSearch.ts:141 reads a 0 as
   'token API unavailable' … Returning an estimate from the shared helper suppressed that
   sentinel and changed when tool search auto-enables, **which is model behaviour, not
   display**."*
4. **Two review-driven fixes shipped dead.** In `3d21ec77`, round 2 found round 1's work
   inert: *"The recall correction never reaches the user … **My fix from last round is dead
   code**"* and *"**The retained FIFO doesn't fix its bug.** One submit produces ≥3 `settled`
   signals — I measured `["settled","settled","settled"]`."* Round 1 also introduced a new
   `TS2305` in an owned file. All caught only because a second round ran.

Also ruled out: `43ca5a19` → `31b468ec` is not review-driven; it was reverted 6 minutes later
because the reported crash was in a different repository.

---

### 4. Recurring defect shapes, and what prevents them

Seven shapes recur across 7 to 14 separate sessions each. **Exactly one has ever received an
automated guard, and that guard is partial.** This half of the analysis needs no counterfactual,
which makes it the more robust half.

| Shape | Sessions | Prevention |
|---|---|---|
| **A comment, docstring, or ledger row asserts something the code does not do** | ≥14 of 30 | **None.** `bun run lint` enables zero rules — all 19 custom rules are `createNoopRule()` stubs. `3d21ec77` recorded the compounding case: a commit propagated a pre-existing error into fresh prose with a wrong `file:line`, which then *"misled the next reviewer inside this very review"* |
| **Shipped code that never runs; a fix that is inert** | 12+ | None. `48a3d62b` found a case where the *guard against this* is itself inert: a `never` tripwire killed by `case undefined:` under `strictNullChecks:false` |
| **A test that cannot fail** | 10+ | None automated — no mutation testing. Examples: *"3 of 4 new tests don't fail on revert"*, *"two tests that can no longer fail"*, *"asserts a test-local array lacks a string the author never wrote"* |
| **A failure silently degraded to a valid-looking value** | 10 | None. CLAUDE.md §7's "inbound fail closed / display degrade gracefully" rule is the convention this violates, unenforced |
| **Two surfaces disagree about one fact** | 7 | None. *"Two contradictory numbers on one screen"*, *"card and finish row disagree"*, *"'2 messages' for one message"* |
| **Raw ids / engineering nouns / a11y gaps on user-visible surfaces (§7)** | 14 | **Partial, and the gap is known.** `userVisibleText.test.ts` enforces the "no engineering notes" half repo-wide, but judges a string's *shape*, not its content; the em-dash half has no check |
| **A literal NUL byte written into a TypeScript source** — makes git treat the file as binary and makes `rg` skip it during traversal | 3 occurrences: `3f359ce` (07-28), `183276f5` (07-30), `f9b104ec` (08-08) | **Module-local, three times.** Each fix added a test that reads *its own module* and asserts no NUL. Verified at audit time: 5 such per-module tests exist and **no repo-wide sweep**. Zero NUL bytes in tracked TS sources today, but nothing prevents the fourth |

The NUL case is worth dwelling on: its first occurrence *"has already produced two wrong 'no
call sites, therefore dead code' conclusions."* It recurred 2 days later, then 9 days after
that, in a different area each time, because every fix guarded one module.

---

### 5. Verdict from this lane

**Not eagerly enough — but the miss is in scoping, not appetite.** The review does not need to
look at more things. It needs to stop discarding what it already found.

- **Volume and precision are healthy.** 291 VALID (76%), 36 FALSE POSITIVE (9.4%). Every false
  positive was killed by the main agent's Step-3 validation before any code changed, so
  over-firing costs turns, not correctness. One session reported *"Zero false positives across
  both reviewers."*
- **Almost nothing had to be undone.** Zero git reverts; all seven sampled fix symbols survive.
- **Both hard escapes were seen by the review and filed away.** Neither was a coverage gap.
  Both were **verdict errors**, and the skill's vocabulary caused them: Step 3 offers only
  VALID / FALSE POSITIVE / DEFERRED, with *"Everything else should be VALID."* There is no
  verdict for *"real, user-visible, asserted by my new surface, but rooted outside my diff"* —
  so both got dropped rather than escalated.
- **Nothing in the skill checks effect.** Every step is static reading. From the `62445105`
  session's own report: *"I shipped this whole path on server-rendered evidence and never once
  ran it. You asked for a real implementation and I gave you one that typechecks and passes
  2578 tests without a single execution of the actual feature."* The review ran on that same
  evidence base and inherited the same blindness.
- **Where a second round ran, it paid immediately.** Four sessions ran two rounds; three of the
  four found a defect in round 1's own fixes. That is the sharpest single argument against
  "too strict."

#### Two levers, in order of value

1. **Give Step 3 a fourth verdict** for *the defect my new surface now asserts, whose mechanism
   lives outside my diff.* That one change would have caught both escapes.
2. **Restore the severity column to the canonical `~/.agents/skills/review-impl/SKILL.md` and
   republish** — the only tuning request made in the whole window was applied to a mirror and
   overwritten the next morning.

#### Where this lane is thin

30 reviews over four weeks with two user-visible escapes is a small sample, and the
counterfactual is unmeasurable — there is no way to count the defects that did *not* escape
because the pass ran. The recurring-shape data in section 4 is the sturdier half, because it
requires no counterfactual.

---

## Appendix D — Yield normalization, trend, and battery-catchability

This lane supplies the denominators. It also corrects the corpus figures used elsewhere in
this report set; §1 is the correction and takes precedence.

---

### 1. Corpus correction

**The real corpus is 34 review runs, not 30, and 38 invocations.**

- `index.txt`'s 41 lines include 6 unrelated subagent transcripts (`agent-acompact-*`, dated
  April and June, before the skill existed) and one forked duplicate (`84680d00` duplicates
  `463ff374`'s single invocation).
- **Four sessions were almost entirely missed by the scrape** because their validation tables
  use `F1` / `C1` / `H2`-style ids rather than integers: `76e10e2b` (12 findings, scraped as 1),
  `cc9feb6e` (13, prose report, 0 scraped), `97b04c6f` (11, 0 scraped), `1ba97aa9` (10, 0
  scraped).
- **Four sessions ran `/review-impl` twice** — `05d68ce0`, `62445105`, `8f9051b7`, `3d21ec77`.

**`rows.txt` also double-counts.** The same finding is routinely listed once in the Step-3
validation table and again in a Step-4/5 summary. 382 scraped rows collapse to **~341 distinct
findings** (~10% restatement, concentrated in `3d21ec77` 33→~26, `77fbf5d0` 33→~22, `970c440d`
20→~18, `a9454c20` 17→~16).

**Best estimate of distinct findings across all 34 runs: ~375.** The scraped count is a floor in
one direction and inflated in another; both corrections are roughly a wash at corpus scale, but
neither should be quoted without the other. Figures below use raw rows so they stay comparable
to the 382 used elsewhere — discount ~10% for the true rate.

#### One review found nothing

**`f6a7c289` (2026-08-09, 121-line diff, 1 agent) returned zero findings.** Its report walks
four specific claims and clears each. This is a real zero, not a scrape gap — which retires the
premise that the skill "always finds a problem."

---

### 2. Per-run table

`prov`: **S** = stated by the agent in-transcript · **G** = recovered from git using the exact
SHAs or file list handed to the reviewers · **P** = partial (patch-file line count only).

| session | date | diff | prov | agents | findings | VALID | f/100 | area |
|---|---|---:|---|---|---:|---:|---:|---|
| cc9feb6e | 07-26 | 694 | P | 2 | 13 | 13 | 1.87 | app |
| 379fa640 | 07-28 | 158 | S+G | 2 | 12 | 12 | 7.59 | app |
| 66f06b65 | 07-30 | 427 | G | 2 | 10 | 7 | 2.34 | src |
| a9454c20 | 07-30 | 1411 | S+G | 2 | 17 | 13 | 1.20 | src |
| d595a8ba | 08-02 | 210 | S+G | 2 | 8 | 5 | 3.81 | app |
| 55b8f9c3 | 08-02 | 820 | S+G | 2 | 14 | 10 | 1.71 | app |
| 2d7b530b | 08-04 | 515 | S+G | 2 | 9 | 5 | 1.75 | src |
| 62445105 | 08-04 | 1751 | S+G | 2+2 | 19 | 18 | 1.09 | app |
| 05d68ce0 | 08-04 | ~1300 | **P** | 2+2 | 16 | 15 | 1.23 | app |
| 970c440d | 08-05 | 406 | G | 3+3 | 20 | 16 | 4.93 | app |
| 6d0ce8ac | 08-05 | 518 | **G only** | 2 | 8 | 5 | 1.54 | app |
| 3dd55442 | 08-07 | 225 | S | 2 | 7 | 6 | 3.11 | app |
| 8f9051b7 | 08-07 | 1905 | G | 2+1 | 28 | 27 | 1.47 | app |
| 9b55eb47 | 08-07 | 620 | S | 2 | 10 | 9 | 1.61 | app |
| 1ba97aa9 | 08-08 | 140 | S+G | 1 | 10 | 8 | 7.14 | app |
| 2d5da6ab | 08-08 | 120 | S (soft) | 1 | 9 | 4 | 7.50 | app |
| 3aacc503 | 08-08 | 243 | S+G | 2 | 9 | 6 | 3.70 | src |
| f9b104ec | 08-08 | 530 | S+G | 2 | 11 | 11 | 2.08 | app |
| 23f4d3f7 | 08-09 | 868 | S+G | 2 | 12 | 6 | 1.38 | app |
| 4326538f | 08-09 | 384 | S+G | 2 | 7 | 6 | 1.82 | src |
| 76e10e2b | 08-09 | 358 | G | 2 | 12 | 11 | 3.35 | app |
| 97b04c6f | 08-09 | 316 | S+G | 2 | 11 | 10 | 3.48 | app |
| **f6a7c289** | 08-09 | 121 | **G only** | 1 | **0** | 0 | **0.00** | app |
| 77fbf5d0 | 08-10 | 2446 | G | 3+1 | 33 | 19 | 1.35 | app |
| 64fa9c9e | 08-13 | 277 | S+G | 2 | 6 | 4 | 2.17 | app |
| 36e61c86 | 08-13 | 1517 | **G only** | 2 | 6 | 3 | 0.40 | src |
| aee64f62 | 08-15 | 91 | S+G | 1 | 12 | 10 | 13.19 | app |
| 77a1d024 | 08-15 | 937 | S+G | 2 | 11 | 8 | 1.17 | app |
| 3d21ec77 | 08-16 | 4277 | G | 4+5 | 33 | 32 | 0.77 | app |
| 463ff374 | 08-17 | 379 | S+G | 2 | 11 | 5 | 2.90 | src |
| 3da947dd | 08-19 | 364 | S+G | 2 | 8 | 6 | 2.20 | app |
| 48a3d62b | 08-21 | 1604 | S+G | 4 | 10 | 5 | 0.62 | src |
| b7b41510 | 08-21 | 623 | S+G | 2 | 15 | 12 | 2.41 | app |
| 5df08177 | 08-22 | 192 | S+G | 2 | 10 | 6 | 5.21 | src |

**Zero UNKNOWN denominators.** 25 are stated-and-git-confirmed, 4 git-only, 3 genuinely soft.

---

### 3. The finding that undermines "findings per 100 lines"

- Findings per 100 lines: median **1.97**, IQR 1.32–3.54, mean 2.89
- VALID per 100: median **1.51**, IQR 0.95–2.77
- Pooled: 427 findings / 26,747 lines = **1.60 per 100**

**Spearman(diff size, findings per 100) = −0.78.** Spearman(diff size, *absolute* findings) is
only **+0.53**. A 4,277-line review produced 33 findings; a 91-line review produced 12.

**The reviewers return a roughly fixed budget of findings — median 10, IQR 8–13 — almost
regardless of how much code they were given.** Median by size band: 4.51 (&lt;300 lines), 2.20
(300–700), 1.22 (700–1600), 1.09 (&gt;1600).

Two consequences worth stating plainly:

1. **"Findings per 100 lines" is not a size-invariant quality metric here.** It is largely a
   proxy for `1/diff-size`. Any argument built on it — including the instinct to normalize that
   motivated this lane — has to be discounted accordingly.
2. **The absolute count is partly a property of the reviewer's reporting budget, not purely of
   defect density.** A review that reports ~10 items will report ~10 items on a clean 90-line
   diff and on a messy 4,000-line one. This is the strongest available explanation for why the
   count *feels* constant and alarming: to a first approximation, it is constant.

#### Outliers

**High.** `aee64f62` 13.19/100 is the smallest diff in the corpus (91 lines) and half its rows
are restatements — really ~6.6/100, all six findings being comment-accuracy items on a logging
change, the cheapest class to find per line. `379fa640` 7.59 and `2d5da6ab` 7.50 are likewise
restatement artifacts (→ ~3.8 and ~4.2). **`1ba97aa9` 7.14/100 is the genuine high**: a small
model-display fix where two `??` operators each resurrected a stale override because `null` was
a meaningful value.

**Low.** `f6a7c289` 0.00 (the real zero). `36e61c86` 0.40 — 1,517 lines, 6 findings, **3 of them
false positives**, and 682 of those lines are a docs audit report. `3d21ec77` 0.77 has the
largest diff, the most agents, the lowest normalized yield **and the highest VALID ratio in the
corpus** — the size penalty is mechanical, not a quality signal.

---

### 4. Trend over four weeks: flat

- Spearman(date, findings per 100) = **−0.06**
- Spearman(date, absolute findings) = **−0.09**
- Spearman(date, diff size) = **−0.04**

All three are noise.

| | window | median diff | median findings | median f/100 | pooled f/100 |
|---|---|---:|---:|---:|---:|
| T1 | 07-26 → 08-05 (n=11) | 518 | 13.0 | 1.75 | 1.78 |
| T2 | 08-07 → 08-09 (n=11) | 358 | 10.0 | 3.11 | 2.21 |
| T3 | 08-09 → 08-22 (n=12) | 501 | 10.5 | 1.76 | 1.21 |

**Neither story the main report asked us to distinguish is true.** Diffs did not get bigger
(median 518 → 358 → 501, correlation ≈ 0) and raw counts did not rise (13 → 10 → 10.5, a mild
decline if anything). T2's median bump is entirely that window containing the corpus's cluster
of small diffs. T3's *pooled* drop is one session — `3d21ec77`'s 4,277-line denominator is 32%
of all lines in T3; remove it and T3 pools to 1.53.

**Over four weeks and 34 runs the yield is statistically indistinguishable.** The code is not
getting sloppier, and the review is not getting stricter.

---

### 5. Reviewer count does not inflate findings

The skill's 1-or-2 rule was followed in **27 of 34 runs**. Seven exceeded it, and every one
announced the deviation in-transcript — `77fbf5d0` split Agent 1 into app-runtime and
engine-runtime lanes because *"~2,000 lines of engine and desktop code would be spread too
thin"*; `3d21ec77` round 2 stated *"I'll go with 5 agents"*. Four runs used 1 agent, all
correctly under the 150-line threshold.

Comparing within the only band where both counts occur (diffs under 250 lines):

| | n | median diff | median findings | median f/100 |
|---|---:|---:|---:|---:|
| 1 agent | 4 | 120 | 9.5 | 7.32 |
| 2 agents | 5 | 210 | 9.0 | 5.21 |

**Same absolute yield.** The raw Spearman(agents, f/100) = −0.35 is pure confound: agent count
is *assigned by* diff size, and f/100 is dominated by diff size.

The second agent adds a **lens**, not volume — visible in composition rather than count.
`8f9051b7` rows 16–21 are all Agent-2A ledger and parity findings that Agent 1 structurally
cannot see. Findings per agent falls monotonically: 9.5 (1 agent) → 5.0 (2) → 4.0 (3+).

---

### 6. Battery-catchability: 1 in 210

**Rubric, stated because the answer hinges on it.** Each of 416 rows was classified *behavioral*
(the running system does the wrong thing) or *non-behavioral* (comment wrong, doc stale, missing
coverage, dead code, undisclosed deviation). **210 of 416 (50%) are behavioral.** A behavioral
defect counts as gate-catchable if `build:dev:full`, `bun test app/` or the focused engine
suites, `bun run --cwd app typecheck`, or `test:hardening` would have gone red *without someone
first writing a new test*. Per CLAUDE.md §3, no credit was given to root `bun run typecheck`
(known-red, 1,974 pre-existing errors, explicitly not a gate), the sidecar wrapper's ~5.5k
upstream diagnostics, or `bun run lint` (all 19 rules are `createNoopRule()` stubs).

**Result: 1 of 210 behavioral defects — 0.5%.** On the widest defensible reading, 3 of 210
(1.4%).

- **The one clean catch** — `463ff374`: *"switch-account.test.ts:451 — test still asserted
  Terra; I committed it red."* The gate existed, was skipped, and the review substituted for it.
- **Two only under gates the repo has deliberately switched off** — a genuinely new `TS2305`
  (`UUID` imported from `types/ids.ts`, which exports no such member; `import type` erases at
  runtime so no test fails, and root typecheck is known-red), and a module mock that contaminates
  combined suites, which a combined `bun test src/tools/` would expose except CLAUDE.md forbids
  running suites combined.

**~33 rows (8% of the corpus) are findings about the gates themselves being blind:** inert
tripwires (`case undefined:` killing narrowing under `strictNullChecks:false`), 8 ×
`as unknown as SDKMessage` making fixtures unchecked, *"3 of 4 new tests do not fail on
revert"*, *"my own new tripwire passed vacuously"*, and one case where deleting a single token
(`assertAllowed(payload, 'diagnostics')`) kept 1,958 tests green while restoring the exact
starvation the decision exists to prevent.

#### Four defects no gate could plausibly have caught

1. **Closing a parked tab that holds a queued prompt re-spawns a real, billed engine process
   and sends the message into it.** Costs money every time. The renderer suite is SSR-only and
   cannot execute the effect.
2. **A requeued prompt is destroyed on restore** — `drainOneQueuedPrompt` re-enqueues the same
   command after a failed turn, so the log reads `enqueue A · dequeue A · enqueue A` and the real
   function returns `[]`. A test covered the area and stayed green; the defect is in the
   interaction of two correct-looking primitives.
3. **`loadConversationForResume` is not a reader** — it runs SessionStart hooks, appends their
   output, trips `suppressNextSkillListing`, and copies plan and file history to disk. It was
   called from a **display** path. No gate can express "this function that typechecks fine has
   side effects the caller does not want."
4. **A line-capped read now satisfies the read-before-write gate**, so the model can overwrite a
   file it only ever saw two thirds of. A data-integrity regression created by a correctly-typed,
   fully-tested change to a limit constant.

---

### 7. Area split: findings track where the code was

| area | findings | share | reviewed diff | share | findings/100 |
|---|---:|---:|---:|---:|---:|
| `app/` | 307 | 73.8% | 18,897 | 71.1% | **1.62** |
| `src/` | 103 | 24.8% | 6,540 | 24.6% | **1.57** |
| `docs/` | 6 | 1.4% | 1,137 | 4.3% | 0.53 |
| `web/` | 0 | 0% | 0 | 0% | — |

**Once normalized the concentration disappears.** `app/` looks dominant only because it was 71%
of the reviewed code; engine and desktop yield the same rate to within 3%. `web/` never appeared
in any reviewed diff.

Note the asymmetry: findings *about* docs vastly outnumber findings *in* docs. A large share of
the `app/`- and `src/`-attributed rows are stale comments, wrong `file:line` citations, and
ledger drift living inside code files.

---

### 8. How much rests on inference

**The denominators are the strongest part.** 25 of 34 are corroborated twice — stated in
transcript *and* reproduced from git. Where the two disagreed, git won and the disagreement is
recorded: `66f06b65` (agent said ~800, git 427 — it counted `+++`/`---` patch headers),
`77fbf5d0` (agent ~2,000, git 2,446), `8f9051b7` (agent 1,268, git 1,252).

**Four are git-only**, reconstructed from the exact file or SHA list in the command that built
the reviewers' packet; the risk there is wrong scope, not wrong arithmetic.

**Three are genuinely soft.** `2d5da6ab`'s 120 counts only *added* lines in files another session
was concurrently editing — the raw three-file dirty diff was 521 patch lines, so it could be
understated 2–4×, and it is one of the four high outliers. `3dd55442`'s 225 is an agent-scoped
estimate after excluding a third session's hunks (raw numstat 336). `05d68ce0`'s second round is
inferred from a 1,940-line patch containing six whole new modules, so ~1,300 could be off by
±300.

**The finding counts are weaker than the denominators.** `rows.txt` double-counts restated
findings (~10%) and silently drops every table whose `#` column is non-numeric — which is how a
12-finding review appears as 1 and three whole reviews appear as 0. Four such sessions were
recovered; an estimated further ~28 non-numeric rows scattered across sessions already in the
table were not (7 of them are `8f9051b7`'s round-2 `F1`–`F7`, which would raise that row from 28
to ~36). **The finding column is a floor.**

**The battery-catchability count is the most judgment-laden number here.** A different reader
drawing the behavioral line differently on perf and user-visible-text findings could move the
210/206 split by ±25 either way. The conclusion is robust to that: at 250 behavioral defects the
catch rate is 0.4%, at 150 it is 0.7%. Exactly one finding's text says a running gate would have
gone red, and the lane went looking specifically for more.
