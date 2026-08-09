# A05 — transcript projector and message model

## Verdict

This is the strongest-engineered code I have reviewed in this repo: `transcriptProjector.ts` is genuinely
zero-cast, every wire shape is runtime-narrowed, the read-time join discipline (status, agent completion,
hidden tier) is real and consistently applied, and stored rows are never mutated in place. The exhaustiveness
tripwires exist on both sides and all 19 `SDKMessage` members have fixture coverage today. The single most
important thing to fix is the `seenFrameIds` gap in `projectUserFrame`: a user frame that projects **no visible
rows** — which is what every `tool_result` carrier is, i.e. the majority of user frames in a tool-heavy session —
never records itself as seen, so a replayed copy re-folds its correlation, mints a fresh `ToolResultProjection`,
replaces the session slice and drops every read cache. That is the exact harm the code's own comment at
`:1040-1046` claims the ordering prevents, and the adjacent case is already pinned by a test.

Empirically verified with a scratch `bun test` harness against the real module (scratchpad, since deleted):
after replaying an identical `tool_result`-only user frame, `projectServerFrame` returned a **new** state object
and `selectNestedTranscriptRows` returned a **new** array, with `seenFrameIds` holding only the assistant uuid.

## Findings

### [HIGH] A user frame that projects no visible rows is never marked seen, so replay re-folds its tool result

- **Where**: `app/renderer/src/transcriptProjector.ts:1106` (`if (rows.length === 0) return state`), with
  `seenFrameIds` written only inside `appendFrameRows` (`:1295-1306`)
- **Type**: correctness
- **What**: `projectUserFrame` dedupes on `state.seenFrameIds[frameId]` at `:1046`, but the *only* writer of
  `seenFrameIds` on this path is `appendFrameRows`, reached only when `rows.length > 0`. A frame whose content is
  a bare `tool_result` block projects zero rows and returns at `:1106`, so its uuid is never recorded. Every
  redelivery of that frame re-runs `correlateToolResults` → `foldToolResultBlocks`, which unconditionally builds
  `next = { ...state.toolResultsByUseId, [toolUseId]: projection }` (`:1356`) with a **freshly allocated**
  `ToolResultProjection`.
- **Trigger / why it matters**: Verified live, not inferred. Project `assistant(tool_use tu1)` then
  `user(uuid U, content:[tool_result tu1])`, then project frame `U` again:

  ```
  state identical after replay?   false
  nested identical after replay?  false
  seenFrameIds:                   { "uuid-assistant-1": true }     ← U absent
  ```

  Because the projection object is new, `selectTranscriptRows`'s identity short-circuit at `:573-579`
  (`row.result === result`) fails for **every** `tool-use` row in the session, so all of them are cloned;
  `nestedRowsCache`/`revealedNestedRowsCache`/`displayItemsCache` all miss; the `React.memo`'d `TranscriptView`
  rows all re-render. One duplicated tool-result frame costs a whole-transcript re-render — precisely the harm
  spelled out at `:1042-1046` and asserted for the mixed-content case by
  `transcriptProjector.test.ts:1826-1830`. Redelivery is a real path the repo already models: the same test calls
  it "Replay-buffer double-delivery of the SAME frame", and `queryHelpers.ts:160-176` shows the live subagent path
  emits one such `tool_result`-only user frame per nested tool call.
- **Fix**: mark the frame seen on the no-visible-row path too. Replace `if (rows.length === 0) return state`
  with a branch that returns `{ ...state, seenFrameIds: { ...state.seenFrameIds, [frameId]: true } }`. (The
  assistant path already does the equivalent unconditionally at `:1028-1030`, which is why it has no such gap.)

### [MED] Every streamed text delta does O(rows) work over the whole transcript, six times over

- **Where**: `app/renderer/src/transcriptProjector.ts:1688` → `upsertStreamingRows` (`:1762-1784`)
- **Type**: correctness (performance)
- **What**: The `content_block_delta` branch calls `upsertStreamingRows(state.rows, [row])`, which does
  `rows.map(...)` plus `new Set(rows.map(row => row.id))` — two full passes and two allocations sized to the whole
  transcript — to replace **one** row it already knows is the streaming tail. It then returns a new state, so the
  slice changes and `selectNestedTranscriptRows` recomputes: `selectTranscriptRows` (filter/flatMap + agent-id Set),
  the `byToolUseId` map, the tree build, and `groupAgentDelegates`. That is roughly six full passes over `rows` per
  delta.
- **Trigger / why it matters**: Live frames are delivered one per IPC message (`app/main/main.ts:887,1592`
  `deliver(attachmentGate.onFrame(...))`); only the bootstrap/replay window is coalesced. So each streamed chunk
  from the provider pays the full cost. `rows` has no retention cap at all (unlike `rawMessageLog`, capped at
  8,000 messages / 8 MiB), so in a long session at a few thousand rows this is hundreds of thousands of
  element-visits and object allocations per second during streaming — the jank is worst exactly when the
  transcript is longest.
- **Fix**: smallest change is in `upsertStreamingRows`: a streaming row is always the tail, so check
  `rows[rows.length - 1]?.id === replacement.id` and return `[...rows.slice(0, -1), replacement]` (or push) before
  falling back to the general scan. That removes the two O(n) scans per delta; the downstream selector recompute
  is inherent to the current design and is a separate, larger call.

### [MED] `previewTranscriptState` casts to `SDKMessage` in the one place its doc promises it does not

- **Where**: `app/renderer/src/previewTranscriptState.ts:207`
- **Type**: quality (types)
- **What**: `selectRunFactsFromFrames` narrows only `isRecord(message) && typeof message.type === 'string'` and
  then does `messages.push(message as SDKMessage)`. The function's own doc at `:150-157` says "Runtime-narrowed
  with no casts, projector-style: a cache is JSON that was on disk, so nothing about its shape is guaranteed."
  The cast makes that claim false, and the array is then handed to `selectContextUsage` and read with
  `message.type === 'result'` as if the shape were verified.
- **Trigger / why it matters**: No crash today — `selectContextUsage` re-narrows everything with `isRecord`/`readNum`
  — so the cost is that the type system now asserts a guarantee the code does not provide, and the next consumer
  of this array will trust it. This is one of only three `as` casts in the whole scope (`transcriptProjector.ts`
  itself has zero, which is the bar), and it is the only unsound one.
- **Fix**: keep the local array typed `Record<string, unknown>[]` and read `type`/`message` off it positionally
  the way `readStringField` and `readSendPathEffort` already do; `selectContextUsage` already accepts tolerant
  input. Also add the missing `!Array.isArray(value)` guard to this file's private `isRecord` (`:265`), which is
  the only one of the four copies in scope that admits arrays.

### [MED] The fixture's `expectRows` contract no longer detects a silent drop of a hidden-tier row

- **Where**: `app/renderer/src/transcriptProjector.test.ts:525` (`selectTranscriptRows(next, 'session-1')`),
  contract stated at `app/renderer/src/sdkMessageFixtures.ts:87-92`
- **Type**: quality (test coverage)
- **What**: `SdkMessageSample.expectRows` is documented as "Rows `projectMessage` must add … more = phantom rows,
  fewer = the silent drop P2-0 forbids", but the loop measures the **default** view, which P4-36 filters by
  `hiddenFrameIds`. A hidden row that *is* stored and a hidden row that was *dropped* both read as 0.
- **Trigger / why it matters**: The `user: synthetic/meta message (isSynthetic)` sample
  (`sdkMessageFixtures.ts:865-878`) declares `expectRows: 0`, yet the projector genuinely appends a `user-text`
  row for it. If a future change reverted `projectUserFrame` to the pre-P4-36 `if (message.isSynthetic === true)
  return state`, the whole fixture suite would still pass green while the reveal control silently showed nothing
  — the exact regression `:1054-1063` was written to prevent. Same blindness applies to the `tool_result` carrier
  samples.
- **Fix**: assert against `selectTranscriptRows(next, id, true)` (the revealed view) in the loop at `:525`, or add
  a second `expectHiddenRows` field. Either makes "was it stored" testable independently of "is it shown".

### [MED] Both exhaustiveness tripwires are per-discriminant, not per-union-member

- **Where**: `app/renderer/src/transcriptProjector.ts:929-937` (`const _exhaustive: never = message`) and
  `app/renderer/src/sdkMessageFixtures.ts:104-108` (`{ readonly [K in SDKMessage['type']]: … }`)
- **Type**: quality (types)
- **What**: Both tripwires key on `SDKMessage['type']`. The union has **19 members over 15 discriminants**
  (`system` ×3, `result` ×2, `user` ×2 — the fixture header states this itself at `:8-15`). Adding a new member
  under an existing discriminant — a new `system` subtype member, a `SDKUserMessageV2` — compiles clean on both
  sides: the projector's `case 'user'` already exists and the fixture record already has a `user` key.
- **Trigger / why it matters**: The prompt asked exactly which fixture entries are missing. **None are** — I
  checked all 19 members against the fixture and every one has at least one sample (`assistant`,
  `assistant_error`, `stream_event`, `user` + replay, `system` init/compact_boundary/cat_code_account_diagnostic,
  `result` success + 2 error subtypes, `status`, `permission_denial`, `tool_progress`, `tool_use_summary`,
  `auth_status`, `rate_limit_event`, `prompt_suggestion`, `streamlined_text`,
  `streamlined_tool_use_summary`). The gap is that nothing *keeps* it complete: coverage of the 4 members that
  share a discriminant with another member is maintained by hand, and the build will not notice when it lapses.
  The file's carefully maintained census comment is doing work the type system could do.
- **Fix**: add a compile-time member census beside the discriminant map, e.g. a mapped/conditional type that
  fails when `SDKMessage` gains a member no sample's `message` is assignable to. Cheapest approximation: a
  `type _MemberCount = Assert<UnionLength<SDKMessage>, 19>` tripwire so a member addition breaks the build and
  forces a conscious re-census.

### [MED] `ToolUseRow`'s type cannot distinguish a stored row from a projected one

- **Where**: `app/renderer/src/transcriptProjector.ts:103-120` (`status`, `result`, `agentCompletion` declared
  required), minted with placeholders at `:1846-1852`
- **Type**: design
- **What**: The module's headline invariant — "`status`/`result` are NEVER stored" (`:97-101`) — is enforced only
  by convention. Stored rows in `state.sessions[id].rows` always carry `status:'pending'`, `result:null`,
  `agentCompletion:null`; the real values exist only on the clones `selectTranscriptRows` returns. Nothing in the
  type stops a consumer from reading `state.sessions[id].rows[i].status`.
- **Trigger / why it matters**: Any code that reaches into the raw slice — a future selector, a debug export, a
  devtools panel — sees every tool card as permanently pending with no result and no compile error. The
  identity short-circuit at `:573-579` also silently depends on the placeholders matching the derived
  no-correlation values; change either default and the "return the same object when nothing changed"
  optimisation quietly stops firing.
- **Fix**: split the type. `type StoredToolUseRow = Omit<ToolUseRow, 'status'|'result'|'agentCompletion'>` for
  `TranscriptSessionState.rows`, with the three fields added only by the selector's return type. The projector
  stops minting placeholders and the invariant becomes checkable rather than documented.

### [MED] Raw-log eviction copies both arrays once per evicted message, and allocates a `TextEncoder` per frame

- **Where**: `app/renderer/src/rawMessageLog.ts:166-175` and `:197-199`
- **Type**: correctness (performance)
- **What**: The eviction loop does `messages = messages.slice(1)` and `sizes = sizes.slice(1)` **inside** the
  `while`, so evicting *k* messages copies two arrays *k* times — O(k·n). Separately,
  `serializedUtf8Bytes` constructs `new TextEncoder()` on every single message frame.
- **Trigger / why it matters**: A restore replays up to `MAX_HISTORY_REPLAY_FRAMES` = 4,000 frames
  (`app/shared/limits.ts:141`) into a log already holding up to `DEFAULT_MAX_RAW_MESSAGES` = 8,000. Each arriving
  frame evicts one, and each eviction copies two ~8,000-element arrays: ~64M element copies for one restore,
  plus 4,000 `TextEncoder` allocations and 4,000 full `JSON.stringify` passes over messages that were *just*
  deserialized off the socket. All of it on the render thread. (I checked termination: `sizes[0]` is read before
  `sizes` is sliced, so an oversized single message drains to empty and exits — no infinite loop.)
- **Fix**: compute the drop count first and slice once (`messages.slice(dropCount)` / `sizes.slice(dropCount)`),
  and hoist the encoder to a module-level `const TEXT_ENCODER = new TextEncoder()`.

### [LOW] A cyclic `parentToolUseId` chain silently deletes rows, contradicting the selector's own doc

- **Where**: `app/renderer/src/transcriptProjector.ts:669-689` (`selectNestedTranscriptRows`)
- **Type**: correctness
- **What**: The doc at `:620-628` promises "A child row whose parent never arrived (or isn't a tool-use row)
  surfaces at top level rather than being silently dropped — degraded placement, not data loss." That holds for a
  *missing* parent but not a *cyclic* one: if a row's `parentToolUseId` resolves to a row that is itself a child
  (or to itself), nothing lands in `topLevel` and `attachChildren` is never invoked, so the rows vanish from the
  display entirely.
- **Trigger / why it matters**: Verified with the same scratch harness. An assistant frame carrying
  `tool_use{id:'cycle'}` with `parent_tool_use_id:'cycle'` yields `top-level rows = 0`; a mutual pair (A parented
  to B, B parented to A) also yields `0`. No crash and no stack overflow — the rows are simply gone. The engine
  does not mint such a frame today, so this is robustness against wire drift rather than a live bug, but the
  transcript pane is exactly where "degrade gracefully, never lose data" is the stated rule.
- **Fix**: after partitioning, push any row that ended up in `childrenByParentId` but whose parent is not in
  `topLevel`-reachable position back to top level — or more simply, only treat a parent as valid when the parent
  row's own `parentToolUseId` chain terminates, and otherwise fall through to `topLevel.push(row)`.

### [LOW] Four divergent `isRecord`s, two `nonEmptyString`s, and `normalizeAgentName` duplicated from the engine

- **Where**: `transcriptProjector.ts:1790`, `messageMetadata.ts:235`, `previewTranscriptState.ts:265`,
  `app/sidecar/subagentHistory.ts:50`; `transcriptProjector.ts:2276` vs `subagentHistory.ts:54`;
  `transcriptProjector.ts:1446` vs `src/utils/queryHelpers.ts:113-117`
- **Type**: quality (duplication)
- **What**: Four private copies of the same guard, one of which (`previewTranscriptState.ts:265`) omits the
  `!Array.isArray` check the other three have. Two `nonEmptyString`s whose contracts differ silently — the
  projector's returns `string | null`, the sidecar's returns `string | undefined`. `normalizeAgentName`
  (`.trim().replace(/^@/,'').trim()`) is a byte-for-byte reimplementation of `progressAgentName`'s normalization
  in the engine.
- **Trigger / why it matters**: The renderer-bundle-stays-engine-free rule justifies not importing from `src/`
  (the file says so explicitly for `COMMAND_OUTPUT_NO_CONTENT` at `:2126-2134`), but it does not justify four
  copies *within* `app/`, nor two that disagree. The array-admitting `isRecord` is a latent narrowing hole.
- **Fix**: one `app/renderer/src/narrow.ts` (or `app/shared/`) exporting `isRecord`, `nonEmptyString`,
  `normalizeAgentName`; keep the engine-free posture, drop the divergence.

### [LOW] Orphaned doc block: `logLineClass`'s documentation is attached to `PEEK_LINES`

- **Where**: `app/renderer/src/transcriptViewModel.ts:24-59`
- **Type**: quality
- **What**: A 36-line doc comment describing the "Semantic output-line tint … port of the prototype's
  `logLineColor`", including a tagged deviation flag, sits immediately above `const PEEK_LINES = 3` (`:61`) and is
  itself immediately followed by a *second* doc comment for `PEEK_LINES` (`:60`). The function it documents,
  `logLineClass`, is 140 lines further down at `:199`.
- **Trigger / why it matters**: The block carries a live parity deviation ("🔁 ONE DEVIATION, deliberate and
  unapproved") that a reader landing on `logLineClass` will never see, and a reader landing on `PEEK_LINES` will
  read as being about the peek window. This is the "reverted design leaves stale prose" pattern — prose that
  outlived the code motion it described.
- **Fix**: move the block to sit directly above `logLineClass` at `:199`.

### [LOW] Every `system/init` frame replaces the session slice, dropping all read caches once per turn

- **Where**: `app/renderer/src/transcriptProjector.ts:1209-1213`
- **Type**: quality (performance)
- **What**: The `init` case returns `{ ...state, seenFrameIds: …, slashCommands }` unconditionally. The catalog is
  "Re-emitted on every turn's init frame" (`:433-436`) and each init has a fresh uuid, so this allocates a new
  slice and a new `slashCommands` array every turn even when the catalog is byte-identical and no row changed.
- **Trigger / why it matters**: A new slice misses `nestedRowsCache`, `revealedNestedRowsCache` and
  `displayItemsCache`, so the whole transcript is re-projected and re-grouped at the start of every turn for a
  frame that adds zero rows. Cheap per occurrence, but it defeats the F3 caching for the one moment the user is
  most likely to be watching.
- **Fix**: short-circuit when the catalog is unchanged — compare against `state.slashCommands` element-wise and
  reuse the existing array, returning only the `seenFrameIds` update (or nothing, if the frame is otherwise inert).

### [LOW] `messageUuid` widens with a cast where the file's siblings narrow

- **Where**: `app/renderer/src/rawMessageLog.ts:203`
- **Type**: quality (types)
- **What**: `const uuid = (message as { uuid?: unknown }).uuid`. Sound in practice (it widens rather than
  narrows), but it is the odd one out in a codebase whose stated bar for this layer is zero casts, and it
  duplicates the `readString`-style helper `messageMetadata.ts:256` already provides.
- **Fix**: `isRecord(message) ? message.uuid : undefined`, using the shared guard from the previous finding.

### [LOW] Three different names for the same reducer role across three files in one folder

- **Where**: `transcriptProjector.ts:808` `projectServerFrame`, `rawMessageLog.ts:86` `reduceServerFrame`,
  `previewTranscriptState.ts:85` `reduceLiveTranscriptState` / `:98` `reducePreviewTranscriptState`
- **Type**: convention
- **What**: All four have the shape `(state, action) => state` and are dispatched through the same `withBatch`
  wrapper, but follow three naming schemes. CLAUDE.md §7 pins renderer state modules to
  `create<X>State` / `reduce<X>State` / `select<X>`; `previewTranscriptState` follows it, the other two do not.
- **Trigger / why it matters**: `serverFrameBatch.ts`'s handler bundle already has to name these by hand
  (`dispatchRawLog`, `dispatchTranscript`) precisely because the underlying functions do not read as a family.
- **Fix**: not worth a rename of `projectServerFrame` (it is cited by name in a dozen comments and decision docs);
  the cheap version is renaming `rawMessageLog.reduceServerFrame` → `reduceRawMessageLogState` and noting the
  projector's deliberate exception in its header.

## What is good here

- **The read-time join is real, and the identity short-circuit makes it free.** `selectTranscriptRows:573-579`
  returns the *same object* when the derived status/result/completion already match what the row holds, so the
  "never store status" discipline costs nothing on the overwhelmingly common path. This is the pattern other
  renderer stores should copy.
- **`transcriptProjector.ts` is genuinely zero-cast across 2,300 lines**, including the two hardest shapes:
  `content: unknown[]` (narrowed block-by-block in `projectAssistantContentBlock`) and `tool_use_result: unknown`
  (narrowed field-by-field in `extractDiffProjection` / `narrowStructuredPatch`, with malformed hunks dropped
  individually rather than failing the whole diff).
- **Comments cite the `src/…:line` mint site for every projection decision**, which is exactly what §8 rule 1
  asks for, and several record the bug and the date that motivated the branch (`:284-297` task notifications,
  `:2067-2087` command output, `:477-487` the 2026-08-05 session-forgetting incident). That turned this review
  from archaeology into verification.
- **`applyPreviewHandover` (`previewTranscriptState.ts:386-406`) extracts order-dependent React-callback logic
  into a pure function** with the ordering rationale written down, specifically because the renderer suite is
  SSR-only and a subscription callback would never be exercised. That is the right response to a known structural
  test blind spot.
- **`agentProgressBadge`'s three-source precedence** (`TranscriptView.tsx:1749-1765`) with the explicit
  `settledUsage.totalTokens > 0` guard against the engine's persisted `?? 0` — it refuses to render "we never got
  usage" as the claim "0 tokens". Small, and exactly the kind of care that separates a correct projection from a
  plausible one.

## Not reviewed / uncertain

- **Whether a live frame can interleave with a mid-flight history backfill.** `rows` is strictly append-in-arrival-
  order and carries no sequence key or sortable timestamp, so any interleaving is *permanent* — unlike
  `rawMessageLog.ts:150-157`, which documents its own transient inversion and proves convergence. I did not trace
  `app/main/attachmentGate.ts`'s ordering guarantee (out of scope). Resolution: confirm the gate holds live frames
  until replay drains, or add a monotonic per-session sequence to `EventFrame` and sort at projection.
- **Whether an `event` frame can still reach `projectServerFrame:824-825` before its session's `ready`.** I found
  no such path after commit `c3aa4ed` — `applyPreviewHandover` scopes `resetLiveSession` to batches containing a
  `ready`, and `resetTranscriptSession` empties rather than forgets. But the drop remains **completely silent**:
  no counter, no dev-mode warning, nothing distinguishes "no frames yet" from "N frames discarded". And
  `contextBreakdownState.ts:34-39` accepts snapshots for a session the projector has never heard of, which is
  precisely the divergence signature the repo has already hit (empty pane beside a live context %). Resolution:
  a `import.meta.env.DEV` warn (or a dropped-frame counter on the slice) at the `if (!session) return state`
  branch would make the next occurrence take minutes instead of hours. I did not run the app.
- **Row-identity collisions from two assistant frames sharing a `messageId` while `currentStreamBlockIndex` is
  stale.** `upsertRows` would replace the first row rather than append. I traced the documented S1 grammar
  (`content_block_start` always advances the index before the next frame) and could not construct a trigger, so
  I am not reporting it as a finding. Resolution: a fuzz over out-of-order stream-event sequences.
- **Batteries not run.** Per the read-only contract I ran no repo test suite; the only execution was a scratch
  `bun test` file in the scratchpad importing `transcriptProjector.ts` directly, used for the two empirical
  claims above (`seenFrameIds` gap, cyclic-parent row loss) and since deleted.
