# P2-0 Cold Review — Transcript projector completeness + exhaustive SDKMessage fixture — 2026-07-04

## Executive verdict

**GREEN — with two process cautions, zero spine defects.**

P2-0 does what it claims. The projector dispatches over every one of the 19 `SDKMessage`
union members, the exhaustive fixture is real (55 mint-anchored samples over all 15 top-level
discriminants), both compile-time tripwires fire under a real `tsc` negative test, and every
claimed census/anchor/reachability number I recomputed from source held. I attacked each of the
twelve claims looking for a spine defect that would re-block P2-1/P2-2/P2-3 and found none:
row identity is stable and correctly keyed, the no-op discriminants are genuinely reference-equal,
the microcompact uninhabitability proof is independently reproducible, and the subagent
`parent_tool_use_id` finding — the one that changed the row model — traces end-to-end to a real
engine yield at the app seam.

The two cautions are hygiene, not correctness. **(1)** The whole of P2-0 was committed bundled
into an unrelated 72-file, 10.6k-insertion mega-commit (`12a590d`, "Phase-3 backlog + D2–D5
decisions") alongside the parallel session's app/ infra churn — a §5 conflict-checkpoint / one-
feature-per-change discipline miss, though the P2-0 *content* landed intact. **(2)** A cluster of
`reach:'app-seam'` labels on system subtypes (`task_*`, `session_state_changed`, `account_diagnostic`,
`api_retry`) is defensible but rests on engine paths (`sdkEventQueue` drain, headless-gated emit)
that do **not** demonstrably fire through the in-proc `AppSessionController.submit` seam today; the
label overstates certainty. Neither blocks the dependents.

P2-1, P2-2, and P2-3 may proceed. Carry the two cautions below into P2-2 (which owns the
tool-family reach question) and into whoever next commits migration work.

## Scope & method

Reviewed the five P2-0 files at their on-disk state, which — note — became **committed** in
`12a590d` during this review (the prompt was written when they were uncommitted working-tree
changes; content is byte-identical to what I audited). Ground truth recomputed from
`src/entrypoints/sdk/coreTypes.generated.ts` and `coreSchemas.ts` by re-grepping every symbol.
The parallel session's ~2,600-line app/ churn was treated as out of scope and not attributed to
P2-0. I ran the two negative-tripwire experiments against copies, then restored and re-verified
green. No `git checkout/restore/stash/clean` was ever run.

---

## Per-claim verdicts

### C1 — Union census — **CONFIRMED**

Recounted from source, not from the handed citation.

- **Type union `SDKMessage` (`coreTypes.generated.ts:760`): 19 members.** Enumerated the union
  arm list (`:761-779`): SDKAssistantMessage, SDKAssistantMessageError, SDKCompactBoundaryMessage,
  SDKPartialAssistantMessage, SDKPermissionDenial, SDKResultMessage, SDKResultSuccess,
  SDKStatusMessage, SDKAccountDiagnosticMessage, SDKSystemMessage, SDKToolProgressMessage,
  SDKUserMessage, SDKUserMessageReplay, SDKAuthStatusMessage, SDKRateLimitEventMessage,
  SDKToolUseSummaryMessage, SDKPromptSuggestionMessage, SDKStreamlinedTextMessage,
  SDKStreamlinedToolUseSummaryMessage = **19**. ✔
- **15 top-level `type` discriminants.** Grouping the 19 by their `type:` literal: `system` covers
  3 (SDKSystemMessage `:171`, SDKCompactBoundaryMessage `:234` which is `SDKSystemMessage & {subtype}`,
  SDKAccountDiagnosticMessage `:238` same), `result` covers 2 (SDKResultMessage `:122`, SDKResultSuccess
  `:143`), `user` covers 2 (SDKUserMessage `:299`, SDKUserMessageReplay `:314` = `SDKUserMessage & {isReplay}`).
  19 − 4 collapses = **15**. Matches `Object.keys(SDK_MESSAGE_FIXTURE)` (asserted in the test at
  `transcriptProjector.test.ts:247-263`). ✔
- **Runtime `SDKMessageSchema` (`coreSchemas.ts:1910`): 25 entries.** Counted the union arms
  `:1911-1936` = **25**. ✔ Reconciliation as claimed: 13 map 1:1, 12 expand `system` subtypes
  (status, api_retry, local_command_output, hook_started/progress/response, files_persisted,
  task_notification/started/progress, session_state_changed, elicitation_complete), 4 type members
  absent from the runtime union (SDKAssistantMessageError — schema is the embedded `error` enum
  `:1256`, not a message; SDKPermissionDenial — `SDKPermissionDenialSchema:1428` is the
  `result.permission_denials` entry object; both streamlined_* — schemas at `:1398/:1413` but not
  in the union). I also independently confirmed `post_turn_summary` (`SDKPostTurnSummaryMessageSchema:1600`)
  is in **neither** union — the fixture header states this correctly. ✔
- **Name-collision drift CONFIRMED.** `SDKStatusMessageSchema` (`:1562`) is
  `type:'system', subtype:'status'`; the TYPE `SDKStatusMessage` (`:166`) is `type:'status'`. Same
  name, different discriminant, and no `type:'status'` mint site exists in src/. ✔
- **Snapshot byte-identical.** Diffed the `SDKMessage` union block snapshot
  (`app/shared/sdk-types.snapshot.d.ts`) vs live — **identical**. I extended the check: a
  block-by-block diff of all 87 `export type` declarations the snapshot carries against
  `coreTypes.generated.ts` reported **zero** differing or missing types. No drift. ✔

### C2 — Anchor audit — **CONFIRMED (one meaning-preserving imprecision, Low)**

Re-grepped every symbol. Anchors verified at their cited (or symbol-adjacent) lines:
`claude.ts:2371` (the `const m: AssistantMessage` mint) and `:2391` (`yield m` precedes the
`:2489` stream re-yield — the S1 ordering claim holds in source); `queryHelpers.ts:110` assistant
wrap, `:115` `error: _.error`, `:127-140` progress re-emit with `parent_tool_use_id:
message.parentToolUseID`, `:189` tool_progress, `:203/:214` user; `QueryEngine.ts` compact_boundary
`:998`, api_retry `:1004`, tool_use_summary `:1020`, result success `:1195`, error_max_turns `:911`;
`systemInit.ts:57` `buildSystemInitMessage`; `accountDiagnostics.ts:399` `buildAccountDiagnosticMessage`;
`sdkEventQueue.ts:126` task_notification; `task/framework.ts:98` task_started; `task/sdkProgress.ts:23`
task_progress; `sessionState.ts:130` session_state_changed; all `cli/print.ts` stdout anchors
(hooks `:648`, status `:1085/:2217`, auth_status `:1126`, rate_limit `:1141`, files_persisted `:2276`,
elicitation `:1385`, prompt_suggestion `:2318`); `streamlinedTransform.ts:152` streamlined_text.

- **Low imprecision:** the `result: error_during_execution` sample anchors "`QueryEngine.ts:1040
  region`" — the actual `error_during_execution` yield is `:1143`; `:1041` is
  `error_max_budget_usd`. The shape is still a faithful result-error frame, so this is a wrong-line
  anchor, not a wrong-shape sample. Fix the line.

### C3 — Fixture realism — **CONFIRMED**

Diffed sample fields against real mint shapes, prioritizing `app-seam` samples.

- **system init** matches `buildSystemInitMessage` field-for-field (`systemInit.ts:57-97`): tools,
  mcp_servers `{name,status}`, model, permissionMode, slash_commands, apiKeySource, betas,
  claude_code_version, output_style, agents, skills, plugins, fast_mode_state. ✔
- **result success/error** match the QueryEngine terminal yields (`:1195`, `:911`) — usage,
  modelUsage, permission_denials, fast_mode_state, stop_reason present. ✔
- **tool_progress** matches `queryHelpers.ts:189` (tool_use_id, tool_name, parent_tool_use_id,
  elapsed_time_seconds). ✔ **tool_use_summary** matches `QueryEngine.ts:1020`
  (summary + preceding_tool_use_ids). ✔
- **stream events** — all six nested event types plus citations/thinking/signature/input_json
  deltas match the S1 §2 table and the claude.ts part switch (`:2140/:2155/:2229/:2350/:2394/:2486`).
  Codex `reasoning_kind:'summary'` on the thinking-start sample matches
  `codex-fetch-adapter.ts:1426`. ✔
- **Every assistant sample carries `stop_reason:null` (S1 §4)** — verified all 9 assistant
  samples: text, tool_use, thinking, redacted_thinking, server_tool_use, compaction, non-streaming
  fallback, subagent, api-error frame all have `stop_reason: null`. ✔
- **account_diagnostic** matches `buildAccountDiagnosticMessage` + `SDKAccountDiagnosticMessageSchema`
  required fields (version/code/severity/provider/recoverable). ✔

No sample was found whose shape the engine could not emit.

### C4 — Reachability map — **PARTIAL (system-subtype `app-seam` labels overstate certainty; Medium)**

Traced each variant's real path. The `type-only` trio is correct and the stdout-only labels are
correct, but a cluster of system-subtype `app-seam` labels is not demonstrated at the seam:

- **`type-only` trio — CONFIRMED.** `type:'status'` — no mint site (`REPL.tsx:1379` `type:'status'`
  is the **web-UI bus** `webUIBus.emitToWeb`, a different shape entirely, not an SDKMessage).
  `assistant_error` top-level — only *read* at `appSessionEventMapper.ts:68`, never minted (all
  `error:'...'` assignments populate the `error` FIELD, e.g. `errors.ts`, `claude.ts:2466`).
  `permission_denial` — no mint site; live flow is the control channel. All three correctly labeled. ✔
- **stdout-only — CONFIRMED.** hooks/files_persisted/elicitation/auth_status/rate_limit/
  prompt_suggestion/streamlined_* all mint only inside `cli/print.ts` or `streamlinedTransform.ts`
  (used only by print.ts). ✔
- **`app-seam` that genuinely reach — CONFIRMED.** assistant, stream_event, user, result,
  system-init, compact_boundary, api_retry, tool_use_summary, tool_progress, account_diagnostic all
  flow through `QueryEngine.submitMessage` yields or the `withStreamJsonAccountDiagnosticHook`
  wrapper that `AppSessionController.submit` installs (`AppSessionController.ts:143-152`). ✔
- **⚠ Medium finding — `task_notification`/`task_started`/`task_progress`/`session_state_changed`
  labeled `app-seam` are not demonstrably reachable at the app seam.** These are minted via
  `enqueueSdkEvent` (`sdkEventQueue.ts`) and reach a stream only through `drainSdkEvents()`, whose
  **only** production caller is `cli/print.ts` (`:2231/:2253/:2387/:2479`); the AgentTool reference
  is a comment. Worse, `enqueueSdkEvent` early-returns unless `getIsNonInteractiveSession()`
  (`sdkEventQueue.ts:79-81`) — and I found no evidence the sidecar app session sets that flag or
  drains this queue (`grep` for `drainSdkEvents`/`sdkEventQueue` in `app-runtime/` and `app/sidecar/`
  = empty). `session_state_changed` additionally gates on
  `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` (`sessionState.ts:127`). So these four are, on today's
  code, closer to `sdk-stdout-only` than `app-seam`. This is a **mislabel, corrected label =
  `sdk-stdout-only` (or "app-seam-pending-drain-wiring")**. Impact is bounded: they're covered as
  no-ops either way and expectRows is 0, so P2-1/P2-2 lose nothing — but the reach map should not
  claim they arrive at the seam today. This is exactly the §5 conflict-checkpoint ("extend engine
  vs change UI") that P2-1 will have to resolve if it wants task/session-state rows.

### C5 — Microcompact uninhabitability proof — **CONFIRMED (independently reproduced)**

Wrote a scratch `.ts` importing the snapshot `SDKMessage` and ran real `tsc`:
- Control (`subtype:'compact_boundary'`) — **accepted**.
- Under test (`subtype:'microcompact_boundary'`) — **rejected**: `TS2322 … Type
  '"microcompact_boundary"' is not assignable to type '"init" | "status" | "compact_boundary" | …'`.
The intersection `SDKCompactBoundaryMessage = SDKSystemMessage & {subtype:'compact_boundary'|
'microcompact_boundary'}` (`:234`) collapses against the base subtype union (`:172-189`, which lacks
microcompact) to `'compact_boundary'` alone. Runtime agrees: `SDKCompactBoundaryMessageSchema:1538`
literal-accepts only `'compact_boundary'`, and QueryEngine's system-forwarding switch
(`:975-1015`) yields only compact_boundary/api_retry — the internal microcompact message
(`messages.ts:4685` `SystemMicrocompactBoundaryMessage`) never becomes an SDK frame. **W3
`MicrocompactBoundaryRow` correctly confirmed CUT.** ✔

### C6 — Subagent `parent_tool_use_id` finding — **CONFIRMED (traced end-to-end)**

This is the highest-value claim (it added `RowSource.parentToolUseId`) and it holds:
- `AgentTool.tsx:1175/1631` emits `{type:'agent_progress', message}` (skill path analogous).
- `QueryEngine.ts:840` — `case 'progress': … yield* normalizeMessage(message)`. This is the
  **in-proc engine loop the app seam consumes** (not the SDK stdout path).
- `normalizeMessage` (`queryHelpers.ts:126-140`) — for `agent_progress`/`skill_progress`, re-emits
  the inner assistant frame with `parent_tool_use_id: message.parentToolUseID` (**non-null**),
  complementing S1's "subagent *stream deltas* never arrive" (which is about `stream_event`, hard-
  coded null at `QueryEngine.ts:881`). Both statements are simultaneously true and non-contradictory.
- `AppSessionController.submit` forwards every yielded message via `createMessageEvent`
  (`AppSessionController.ts:160`). So a full subagent assistant frame with non-null
  `parent_tool_use_id` **does** reach the seam.
The field is **not** speculative scope creep — it's grounded. The projector preserves it
(`transcriptProjector.ts:255-259`) and the test asserts it (`transcriptProjector.test.ts:345-367`).
P2-0's STATUS note flags the "interleave vs nest is a P2-2/D2 decision" adequately. One note for
**P2-2's STATUS row**: its bullet (c) "subagent deltas never arrive (`parent_tool_use_id` hardcoded
null)" is true *for stream_event only* and could be misread as "subagents never carry a parent id" —
P2-2 should read S1 §1 + this finding together, not the row alone.

### C7 — Behavior preservation vs the P1-3 seed — **CONFIRMED**

Read the seed via `git show 3decd20:app/renderer/src/transcriptProjector.ts` (the P1-0..P1-3
commit) — the seed used `projectSessionEvent(state, AppSessionEvent)` with a flat `rows[]` and no
per-session/id/blockIndex machinery. The rewrite is a superset. Deltas beyond the two sanctioned
ones (added `parentToolUseId`; the `!isRecord(body)||!Array.isArray(body.content)` hardening guard):
- message.id grouping, stream-position fallback indexing, uuid dedupe (`seenFrameIds`),
  malformed-block skipping, and **unknown-session rejection** (`projectServerFrame` returns state
  when `!session`, `:117-118`) are all **new capabilities the seed did not have** (the seed had no
  session keying at all) — this is additive, and it is the exact identity/grouping groundwork the
  P1 review told P2-0 to build. Not an unannounced behavioral regression; it's the announced P2-0
  scope. The malformed-message-body guard and parentToolUseId are the only *new field-level*
  behaviors and both are documented. ✔

### C8 — Tripwires actually fire — **CONFIRMED (both, under real tsc)**

Premise first: `bun test` strips types, so exhaustiveness is tsc-only — confirmed (the `never`
assignment and the mapped type are pure type-level constructs). Negative tests, each on a scratch
copy, then restored byte-identical:
1. **Deleted `case 'prompt_suggestion':` from the projector** →
   `bunx tsc --noEmit -p app/tsconfig.json` errored:
   `transcriptProjector.ts(221,13): error TS2322: Type 'SDKPromptSuggestionMessage' is not
   assignable to type 'never'.` ✔ Union growth breaks the build.
2. **Deleted the `status:` key from the fixture** → tsc errored:
   `sdkMessageFixtures.ts(98,14): error TS2741: Property 'status' is missing in type … but required
   in type '{ readonly status: readonly SdkMessageSample<SDKStatusMessage>[]; … }'.` ✔ The mapped
   type `{[K in SDKMessage['type']]: …}` is the mirror tripwire.
Both files restored and re-verified: `tsc` green, `bun test app/` 170 pass.

### C9 — Test honesty — **CONFIRMED**

- **Reference-equality suite covers all no-op discriminants.** `transcriptProjector.test.ts:318-332`
  loops every sample, skips only `{assistant, stream_event}`, and throws by sample name if any other
  discriminant mutated state (`next !== state`). Covers all 13 no-op discriminants, not silently. ✔
- **Per-sample loop fails loudly by name.** `:301-316` throws `"${sample.name}: expected N row(s),
  got M"`. ✔
- **Whole-fixture-sequence total is NOT tautological.** I replayed all 55 samples into one session
  and traced the 5 resulting rows: they come from 4 distinct row-producing frames (text=1, tool_use=1,
  multi-block fallback=2, subagent=1) with all-distinct `id`s and correct block indexes
  (msg_01Fix001 text→0 / tool_use→1 via `nextBlockIndexByMessageId` carryover; msg_01Fix006
  thinking→drop / text→1 / tool_use→2; msg_01Fix007 subagent→0). The total is composed of
  independently-verified per-frame projections plus real cross-frame block-index carryover — a
  genuine integration assertion. ✔
- **S1 turn-grammar replay is real.** `:392-559` encodes assistant-frame-BEFORE-content_block_stop
  ordering (assistant played, then `content_block_stop`), the non-streaming fallback (new msg id, no
  stream events), and the uuid-dedupe redelivery (`:538-558` replays uuid `…000107`, asserts
  `state === before`). Asserts kind/messageId/blockIndex sequences and id uniqueness — not a
  can't-fail assertion. ✔

### C10 — Extensibility judgment — **CONFIRMED (sound groundwork)**

- **tool_result correlation (P2-2)** can live as a new `case 'user':` projection + a layer-3 selector
  without touching existing row ids — tool_use rows are keyed
  `sessionId:messageId:blockIndex:toolUseId` and a later correlation pass keys off `toolUseId`
  without rewriting them. No baked-in rework.
- **Single-slot `currentStreamMessageId/BlockIndex`** is adequate for P2-0's grouping-position need
  and does **not** preclude P2-3's `(message.id, index)` keying: P2-3 owns delta accumulation in its
  own state; the projector's single-slot tracker only carries the fallback block index for the *next
  assistant frame*, which is exactly the streaming contract (one open block at a time per message).
  P2-3 will add its own keyed map; it doesn't have to un-bake this. Judgment: correct altitude.
- **`parentToolUseId` on `RowSource`** is the right home: it's producer identity (like messageId/
  frameId), read off the frame, not a derived/domain concern. A layer-3 selector deciding *nest vs
  hide* reads this field — the field itself belongs on the row. ✔
No High rework-forcing finding.

### C11 — Scope & security discipline — **PARTIAL (one process finding, Medium; code discipline clean)**

- **Code footprint is renderer-only.** P2-0's code changes live entirely in
  `app/renderer/src/` (+ `docs/migration/STATUS.md`). Projector imports are types + `../../shared/
  protocol.js` + `./connectionState.js` only — no main/preload/supervisor/sidecar/shared code touched
  by P2-0. ✔
- **No god-object.** Grepped the projector for permission/account/abort/submit/setMode logic: 6 hits,
  **all comments or the `permission_denial` case label** — zero domain logic fused in. §5 layer
  discipline held. ✔ No locked decision reopened (raw forwarding, N-process, socket transport all
  untouched). T4/T5a/T6/T7 live in main/preload/sidecar — untouched by P2-0's diff. ✔
- **⚠ Medium process finding — bundled commit.** The entire P2-0 change is committed inside
  `12a590d` ("migration(pre-P2/P3): Phase-3 backlog + D2–D5 decisions"), a **72-file /
  10,631-insertion** commit that also contains the parallel session's ~22 app/ infra files
  (main/preload/supervisor/sidecar) and unrelated Phase-3 backlog + decision docs. This violates the
  §6 one-surface-per-session / conflict-checkpoint hygiene and makes P2-0 un-revertable in isolation.
  The *content* is intact and correct — this is a commit-hygiene miss, not a code defect — but it
  should be called out so future migration commits stay per-session.

### C12 — Seam completeness + STATUS accuracy — **CONFIRMED (numbers exact; one reach caveat from C4)**

- **(a) Is QueryEngine the only producer at the seam?** Nearly. Two producers feed
  `AppSessionController.submit`'s subscribers: (i) the adapter's `runTurn` async-iterable, which is
  `QueryEngine.submitMessage` (`createQueryEngineAppSession.ts:43`), and (ii) the
  `withStreamJsonAccountDiagnosticHook` wrapper that lets `buildAccountDiagnosticMessage` emit
  account-diagnostic frames **out-of-band** (`AppSessionController.ts:143`). P2-0's fixture covers
  both (account_diagnostic sample present). No *other* synthesizer was found — the sidecar
  raw-forwards, it does not mint. The only reach map gap is the C4 `sdkEventQueue`-drained system
  subtypes, which are labeled `app-seam` but aren't drained at this seam today. ✔ with the C4 caveat.
- **(b) STATUS numbers.** 55 samples — confirmed (`allSdkMessageSamples().length === 55`, 55 unique
  uuids). 15 discriminants — confirmed. `bun test app/` **170 pass / 0 fail** — reproduced. Renderer
  `tsc` clean — reproduced. "Zero sidecar errors in renderer files" — confirmed: sidecar tsc is
  ~5.5k errors (I counted 5,544 `error TS` lines) but **`grep app/renderer` = 0**; the red is the
  pre-existing engine-graph strict overlay, none in renderer files. ✔

---

## Findings, ranked

| # | Sev | Claim | Finding | Repro / fix |
|---|-----|-------|---------|-------------|
| F1 | Medium | C4 | `task_notification`/`task_started`/`task_progress`/`session_state_changed` labeled `reach:'app-seam'` are not demonstrably reachable at the `AppSessionController.submit` seam: minted via `enqueueSdkEvent` (headless-gated `sdkEventQueue.ts:79`), drained only by `cli/print.ts` `drainSdkEvents()`; no drain wiring found in `app-runtime/` or `app/sidecar/`. `session_state_changed` also env-gated (`sessionState.ts:127`). | `rg drainSdkEvents src/app-runtime app/sidecar` → empty. Relabel to `sdk-stdout-only` (or note "app-seam pending drain wiring"). No expectRows change (all 0). P2-1 must treat task/session-state rows as a §5 extend-engine decision, not a today-arriving frame. |
| F2 | Medium | C11 | P2-0 committed inside a 72-file/10.6k-insertion mega-commit (`12a590d`) mixing the parallel session's app/ infra + Phase-3 docs. Un-revertable in isolation; §6 hygiene miss. | Content intact; process-only. Keep future migration commits per-session. |
| F3 | Low | C2/C3 | `result: error_during_execution` sample anchors "`QueryEngine.ts:1040 region`" but the real yield is `:1143` (`:1041` is `error_max_budget_usd`). Shape still valid. | One-line anchor fix in the fixture. |
| F4 | Low | C6 | P2-2 STATUS bullet (c) "subagent deltas never arrive (`parent_tool_use_id` hardcoded null)" is true only for `stream_event`; full subagent frames DO carry a non-null parent id (this review's C6). Risk of misreading the row in isolation. | Reword P2-2 row to scope the "hardcoded null" to stream_event and cross-ref C6. |

No Critical, no High. No spine defect. Nothing re-blocks P2-1/P2-2/P2-3.

---

## What I re-ran (exact outputs)

- `bun test app/` (from repo root) → **170 pass / 0 fail**, 474 expect() calls, 23 files.
  (Note: running from inside `app/` makes `initializeRuntime.test.ts` fail on a `cwd:
  process.cwd()` child-spawn assertion — a test-harness cwd sensitivity, unrelated to P2-0; green
  from repo root.)
- `bun test app/renderer/src/transcriptProjector.test.ts app/renderer/src/TranscriptView.test.tsx`
  → **17 pass / 0 fail**, 104 expect() calls.
- `bunx tsc --noEmit -p app/tsconfig.json` → **clean** (RENDERER-TSC-CLEAN).
- `bunx tsc --noEmit -p app/sidecar/tsconfig.json` → **5,544 `error TS` lines**, `grep app/renderer`
  → **0**. Pre-existing engine-graph overlay; left alone per instructions.
- **C8 tripwire 1** (delete `case 'prompt_suggestion'`): `tsc` →
  `transcriptProjector.ts(221,13): error TS2322: Type 'SDKPromptSuggestionMessage' is not assignable
  to type 'never'.` → restored byte-identical (`cmp` clean).
- **C8 tripwire 2** (delete fixture `status:` key): `tsc` →
  `sdkMessageFixtures.ts(98,14): error TS2741: Property 'status' is missing…` → restored
  byte-identical (`cmp` clean), `tsc` green, `bun test app/` 170 pass.
- **C5 scratch proof**: control `compact_boundary` accepted, `microcompact_boundary` rejected
  (`TS2322`) under isolated `tsc`.
- **Census**: `SDKMessage` union block snapshot vs live = identical; 87-type block diff = zero
  differences; `allSdkMessageSamples().length === 55`, 55 unique uuids; runtime union = 25 arms.
- **C9 sequence trace**: full-fixture replay → 5 rows, all distinct ids, correct block indexes.

## Overall verdict

**GREEN.** The spine is sound: full-union dispatch with both tripwires firing under real tsc, an
honest 55-sample fixture whose shapes and anchors trace to source, stable row identity that P2-1/2/3
extend without rework, and the load-bearing subagent-parent-id and microcompact-cut findings both
independently reproduced. P2-1, P2-2, P2-3 are unblocked. Carry F1 (reach relabel — it's the §5
extend-engine decision P2-1 will hit) and F2 (commit hygiene) forward; F3/F4 are one-line
doc fixes.
