# Appendix A — Re-verification of 33 VALID findings against source

Companion to [the main audit](2026-08-22-review-impl-finding-quality-audit.md).

A subagent was given the 382-row finding corpus, the session index, and read-only access to the
repository. It was **not** given any conclusion of the main report. Its brief was adversarial:
sample findings labeled VALID, establish the truth from current source and git history, and
actively hunt for cases where the finding was wrong.

Sample: **33 findings across 24 distinct sessions**, weighted toward concrete `file:line`
behavioral claims.

**Result: 0 of 33 refuted.**

## Verdict table

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

## The one loose case

**#29** (`TasksDialog` `-ml-3`/`pl-3`) was scored REAL, but its *reasoning* is looser than its
verdict implies. The finding says the classes "cancel out exactly, no visual effect". A
negative left margin also widens the box by 12px, so text wrapping and any hover background
would differ. On that particular element — a short flex heading with no border and no
background of its own — the claim holds in practice. It is the only finding in the sample
whose argument is weaker than its conclusion.

## User-impact split of the 33 confirmed-real findings

| Band | Count | Examples |
|---|---:|---|
| **A user would have noticed** | 19 | Silent whole-file overwrite after a partial read (#3); lost prompt on a refused turn (#15); Fast Mode silently downgrading the model (#2); recall reporting success then delivering anyway (#11); a Dismiss button that did nothing under a contradicting toast (#14); session reporting `idle` while blocked, letting goal continuation fire (#25); a worker's compact boundary rendering in the main transcript (#16); the face-identity feature inert plus 69% colour collisions (#22, #23); wrong message count on screen (#24); a read-only popover running SessionStart hooks in the live process (#28); permanently-suppressed resumed worker (#13); hang from a skipped `releaseGate()` (#31); a worker prompt naming an edit tool it does not have (#6); spurious side-query failure after successful failover (#8); context donut stuck with no window (#17); mis-linkified paths (#18, #19); keyboard focus dropping to `<body>` (#21) |
| **Internal only** | 10 | #1, #4, #5, #9, #12, #20, #26, #29, #30, #32 — cache-key hardening, gated model-behavior change, latent prompt-array branch, test isolation, markup duplication, `__proto__` hardening, per-delta perf, dead markup, dead disjunct, false diagnostic record |
| **Prose only** | 4 | #7, #10, #27, #33 |

## Stated limits of this lane

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
