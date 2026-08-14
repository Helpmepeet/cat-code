# Lane 04 — Tool cards, correlation, and the streaming/activity engine

**Auditor verdict:** GREEN
**Rows audited:** 3 · TRUE 2 · OVERSTATED 1 · FALSE 0 · STALE 0 · UNVERIFIABLE-HEADLESS 0

No Critical or High findings. Every headline claim in all three rows traces to a
reachable user path in current source. The one OVERSTATED verdict is a parity
sub-claim inside CC-27, not its user-visible outcome.

---

## Row verdicts

### P2-2 — Tool-card families + `tool_use`/`tool_result` correlation
**Verdict:** TRUE

**Claims checked:**
1. Status is derived at read time, never stored on the row.
2. A `toolResultsByUseId` correlation map lives in session state, keyed by `tool_use_id`.
3. `foldToolResultBlocks` populates it from BOTH the client round-trip (`tool_result` on a `user` frame) AND server-executed tools whose result rides inline on an `assistant` frame.
4. `selectTranscriptRows` joins the map on to each `tool-use` row, `pending`→`success`/`error` off the result's own `is_error`; the stored row is never mutated.
5. `toolFamily` is derived from real wire-verified tool names (client `*_TOOL_NAME` constants + the SDK's separate server-tool name space).
6. `extractDiffProjection` narrows `tool_use_result` to the FileEditTool patch shape at runtime, zero casts, malformed → `diff: null`.
7. D2/C4 subagent nesting is implemented as a read-time transform (`selectNestedTranscriptRows`), orphaned child degrades to top level.
8. That nesting is wired into `TranscriptView.tsx` / `App.tsx` for real rendering.

**Evidence:**
- Correlation map declared `transcriptProjector.ts:416`, initialised `:466`, written only by `foldToolResultBlocks` `:1343-1359`. It rebuilds a new record and returns a NEW session state; it never touches a `ToolUseRow`.
- Both producers confirmed: the `user`-frame path via `correlateToolResults` `:1316-1323`, and the inline server-tool path via `foldToolResultBlocks(state, body.content)` inside the assistant projector at `:967`. The accepted result-block discriminants are a closed list at `:1370-1384` covering `tool_result` plus the seven server/mcp result types.
- Read-time join at `:562-580`: `status` is computed from `session.toolResultsByUseId[row.toolUseId]`, and the row is only cloned when something changed (identity-preserving). Nothing writes `status` at projection time — `:1847` explicitly stores a placeholder and defers to read.
- `deriveToolFamily` `:1549-1596` — every case matches an engine constant I re-verified: `Bash` (`BashTool/toolName.ts:2`), `Read` (`FileReadTool/prompt.ts:5`), `Write` (`FileWriteTool/prompt.ts:5`), `Edit` (`FileEditTool/constants.ts:2`), `Apply_patch` (`FilePatchTool/constants.ts:1`), `Grep` (`GrepTool/prompt.ts:6`), `Glob` (`GlobTool/prompt.ts:1`), `Agent`/`Task` (`AgentTool/constants.ts:1,3`), `ResumeAgent` (`ResumeAgentTool/constants.ts:1`), `SendMessage` (`SendMessageTool/constants.ts:1`), `GenerateImage` (`GenerateImageTool.ts:24`), `NotebookEdit`, `LSP`, `Skill`, `ToolSearch`, `PowerShell`, `WebFetch`/`WebSearch`. `mcp__*` prefix → `mcp`; everything else → `other`.
- **Family-render diff (the OVERSTATED test for this row): passes.** `FAMILY_STYLE` (`TranscriptView.tsx:939-963`) is a `Record<ToolFamily, …>` — tsc-exhaustive — and every one of the 14 families gets its own mark, word and colour. The row claims families for CARD GROUPING, which is what this is; per-family BODIES are P4-18b's scope and `ToolCardBody` `:1969-1996` dispatches `bash`/`grep`/`read`/`write`/`imagegen` with a tolerant `PlainLinesBody` default. No family claimed here falls to a generic card that the row said was dedicated.
- `extractDiffProjection` at `:1482`, reached from `projectToolResultBlock` `:1403`.
- Nesting: `NestedTranscriptRow` `:629`, `selectNestedTranscriptRows` `:652-680`, orphan-to-top-level at `:673`. Mounted: `App.tsx:4205` renders `<TranscriptView>`; `TranscriptView.tsx:297-299` derives the item list and `:455-471` dispatches it.

**Reachable-path trace:**
sidecar `AppSessionController` → raw `AppSessionEvent` → `projectServerFrame` → `projectAssistantFrame` (tool_use row) + `projectUserFrame`→`correlateToolResults` (result map) → `selectTranscriptRows` join → `selectNestedTranscriptRows` → `TranscriptView.tsx:462/464` → `ToolCard`/`ToolCardShell` → mounted at `App.tsx:4205`.

**Concurrency scenarios constructed and checked (the risk this lane was asked about):**
- *Parallel batch.* One assistant message with six `tool_use` blocks: `normalizeMessages` (`src/utils/messages.ts:775-807`) splits it into one frame per block, each getting a distinct `blockIndex`, so `rowId` (`:2264-2266` = `session:messageId:blockIndex:kind`) cannot collide. Results arrive as six separate `user` frames; the engine mints one message per completed tool (`query.ts:1439-1455`), so the shared `tool_use_result` field cannot be mis-attached across a batch. **Handled.**
- *Out-of-order results.* Correlation is a map join performed at READ time, not an in-place mutation at arrival time, so arrival order is irrelevant by construction. **Handled.**
- *Result for a `tool_use` the renderer never saw.* `foldToolResultBlocks` writes the entry unconditionally; no row exists to join it, so it is inert — no phantom row, no crash. The orphan entry is never reclaimed (see Nits). **Handled, degraded not dropped.**
- *Replayed/duplicate frame.* `projectUserFrame:1046` dedupes on `seenFrameIds` BEFORE folding, with a comment stating why the ordering is load-bearing; `projectAssistantFrame` sets `seenFrameIds` at `:1028-1030`. A replay is a total no-op rather than a re-fold that would clone every tool row. **Handled.**
- *A `tool_result`-only user frame splitting a run.* `projectUserContentBlock` `:1906-1921` returns a row only for `text`/`image`; a `tool_result` block yields `null`, so a result frame adds no row. This is what keeps sequential reads adjacent for CC-27's grouping. **Handled.**

**Anchor drift:** THREE citations in this row (also repeated in shipped source comments) no longer point at what they describe. See F2. All three claims re-verified TRUE against the CURRENT location, so the drift changed no conclusion.

---

### P2-3 — Streaming/activity engine
**Verdict:** TRUE

**Claims checked:**
1. Text deltas surface in-progress assistant rows keyed by `(message.id, index)`.
2. Those rows reconcile to the authoritative FULL assistant frames.
3. A stream-event-stripped transcript equals the final streamed transcript.
4. `result` prunes orphan previews and is the only turn-end marker.
5. Assistant `stop_reason`/`usage` are ignored.

**Evidence — this row is the classic Potemkin risk, so I traced the whole wire:**
- **Producer exists.** `app/sidecar/sessionController.ts:372` spreads `createQueryEngineAppSessionConfigFromSetup(...)`, which sets `includePartialMessages: true` at `src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts:116`. Without that flag no `stream_event` is ever minted, and this is exactly the link a reducer test cannot prove. It is set, from the engine's own config builder, not a sidecar-local stub.
- **Projector.** `projectStreamEvent` `transcriptProjector.ts:1608-1701`: `message_start` captures `currentStreamMessageId`; `content_block_start` opens a keyed block; `content_block_delta` (text only, `:1667`) appends and mints a row via `createStreamingTextRow` `:1703-1722` with `isStreaming: true`; `message_stop` clears the tracker.
- **Keyed by `(message.id, index)`** — `streamBlockKey` `:1786-1788`.
- **Reconciliation is real, not hopeful.** `rowId` `:2264` excludes `frameId`, so the preview row and the authoritative row share an id whenever `messageId`+`blockIndex` agree; `upsertRows` `:1748-1760` replaces by id. `projectAssistantFrame:1006-1018` deletes the matching `streamingTextBlocks` entry. I checked the awkward case: because `normalizeMessages` emits one frame per block and `message_stop` clears the tracker before the full frames arrive, `firstBlockIndex` falls to `nextBlockIndexByMessageId` and the indices line up.
- **`result` is the only pruner** — `projectMessage:864-871` calls `finalizeStreamingTurn(state)` (`:1724-1746`) only on the `result` case; no other case touches it.
- **Component + mount.** `TranscriptView.tsx:505` `<AssistantProse content={row.content} streaming={row.isStreaming} />`; `AssistantProse` at `:636-680` renders an animated caret when `streaming` and suppresses the copy affordance. Mounted at `App.tsx:4205`.
- **Tests are live-path, not shape-only.** `transcriptProjector.test.ts:253-273` projects the real fixture turn twice (with and without `stream_event` frames) and asserts equality; `:275+` proves `result` is the only turn-end marker and `stop_reason` never reaches a row. `TranscriptRow`'s closed union has no `stopReason`/`usage` member, so the last claim is also structurally enforced.

**Reachable-path trace:**
`includePartialMessages:true` (`createQueryEngineAppSessionConfigFromSetup.ts:116`) → engine `stream_event` SDKMessage → `AppSessionEvent` frame → `projectStreamEvent` `:1608` → `AssistantTextRow{isStreaming:true}` in `state.rows` → `selectTranscriptRows` → `TranscriptView.tsx:505` → `AssistantProse` caret `:672` → `App.tsx:4205`. Every link present.

**Anchor drift:** none — this row cites no `file:line`.

**Scope note (not a finding).** The row's TITLE says "streaming/activity engine"; its BODY claims only text deltas, which is what shipped. The activity indicator was delivered later by P4-18c and is recorded in `PARITY-LEDGER.md:359`, so it is not a silent cut. Live THINKING deltas were never claimed and are not built (`content_block_delta` handles `text_delta` only, `:1667`; zero `thinking_delta` references in the renderer) — see Nits.

---

### CC-27 — A parallel batch of reads stacked six identical cards, none showing a directory
**Verdict:** OVERSTATED
*(Headline outcome TRUE and fully wired. One cited-parity sub-claim is contradicted by the source it cites — F1.)*

**Claims checked:**
1. `groupToolRuns` is a read-time derivation over already-projected rows, no new frame/message kind, no row mutation.
2. It uses the same C3 discipline as `groupAgentDelegates`/`groupReasoningRuns`: WeakMap input-reference cache, pass-through by reference, returns the INPUT array when nothing groups.
3. The grouping rule mirrors the engine's own `collapseReadSearchGroups`.
4. Only `read` and `grep` group; edit/write deliberately excluded, with both authorities checked.
5. The head hoists the shared directory via `commonDirPrefix`, which never hoists a bare root and whose prefix is a total invariant.
6. The grep digest is parsed off the exact strings `GrepTool.mapToolResultToToolResultBlockParam` writes; three modes report three units; context lines excluded.
7. A ranged read states its range, and `offset` is one-based.
8. Renderer-only: no frame kind, preload channel, inbound vocabulary, sidecar, protocol or security-boundary change.
9. Card expansion moved to a store keyed on `toolUseId`, above the derivations, so a regroup does not snap an open card shut; the run head keys on its first member.
10. `toolsExpanded` is threaded to the member; a call with nested children never groups; a run reports the worst member outcome.

**Evidence:**
- (1)(2) `toolRunLayout.ts:99-151`. WeakMap at `:85-88`; `const result = foundRun ? grouped : items` at `:148` really does return the input array by reference; every non-member item is pushed by reference at `:144`. Members are the projected rows themselves (`:124`), never copies.
- (4) `TOOL_RUN_FAMILIES = ['read','grep']` `:44`. Verified against the engine: `isNonCollapsibleToolUse` (`src/utils/collapseReadSearch.ts:345-367`) breaks a group on any tool that is not search-or-read, so edit/write genuinely break there too.
- (5) `commonDirPrefix` `app/renderer/src/pathUtils.ts:45-84`. Requires ≥2 paths (`:46`), compares whole SEGMENTS not characters (`:57-63`), refuses an all-empty (bare-root) prefix (`:65`), cuts from the ORIGINAL string so Windows separators survive (`:70-77`), and closes with a total check that the prefix really prefixes every input (`:83`). Consumed at `TranscriptView.tsx:1324` and stripped per row at `:1545-1547`.
- (6) `grepResult.ts:28-64` against `src/tools/GrepTool/GrepTool.ts:262-308`: `'No files found'` (`:299`), `'No matches found'` (`:269,282`), `Found N files` (`:303`), `\n\nFound M total occurrences across N files.` (`:285`) — all four literals match the tool byte for byte. `MATCH_LINE` `/^(.*?):\d+:/` counts only rg's colon locator, so `-A`/`-B`/`-C` context lines (`path-N-`) are excluded as claimed. `totalGrepDigest:83-102` returns null on mixed units and distinguishes a measured zero (`unit:'none'`) from the refusal.
- (7) `readRangeLabel` `TranscriptView.tsx:1575-1587` states `offset` itself. Verified one-based at source: the schema describes it as "The line number to start reading from" (`FileReadTool.ts:228-230`), it defaults to `1` (`:496`), and it becomes `startLine` (`:1036`) which is what `addLineNumbers` prints. The row's account of the earlier off-by-one is accurate.
- (8) Confirmed: no diff to `app/shared/protocol.ts`, `app/preload/`, or `app/sidecar/` is implied — every file in this change set is under `app/renderer/src/`, and the derivation consumes already-projected rows. Security baseline untouched (no new inbound vocabulary, no renderer-authored permission data, nothing reaching a frame).
- (9) `toolCardExpansion.ts` — store keyed on `toolUseId` (`:30-34`, `:50-58`), a Map behind a ref rather than React state (`:44-49`, with the re-render cost stated), consumed by `ToolCardShell` via `expansionKey` (`TranscriptView.tsx:1100`, `:1103`), by `ToolRunRow` on `row.toolUseId` (`:1449`), and by the run head on `run:<first member toolUseId>` (`:1259`, `:1278`) which does not move as the run grows. The member toggle pins its run (`:1458-1461`) so closing the member that auto-opened the run cannot collapse the group — the second-order bug the row describes is genuinely fixed in source.
- (10) `toolsExpanded` threaded at `:1448`; children guard at `toolRunLayout.ts:75`; worst-outcome fold with a closed-union tripwire at `TranscriptView.tsx:1390-1397`.
- **Tailwind dynamic-class trap: clean.** `FAMILY_STYLE`/`STATE_STYLE` are static literal maps (`:939-963`, `:972-989`) and the new rows compose them as `` `text-[11px] ${st.color}` `` — a static arbitrary literal plus a variable holding a whole class name, never `` text-[${hex}] ``. I swept every non-test `.tsx` in `app/renderer/src` for an interpolated arbitrary value and found none.
- **Perf claims hold.** Digests are cached on the RESULT object, not the row (`:1366-1367`, `:1370-1379`, `:1610-1611`), which is the correct key: `selectNestedTranscriptRows` rebuilds rows each frame while `result` is copied by reference.
- **User-visible text rules: clean.** No em dash in any string in the owned files (the only two hits are doc comments in `ToolInspector.tsx:133,372`); no rendered file:line, session id, or internal vocabulary in any label. Digests read `3 files` / `6 matches` / `no matches`; the head reads `N files` / `N patterns`.

**Reachable-path trace:**
`selectNestedTranscriptRows` → `groupAgentDelegates` → `groupDisplayItems` → `groupToolRuns` (`TranscriptView.tsx:297-299`) → `items.map` → `DisplayItemView` case `'tool-run'` (`:461-462`) → `ToolRunCard` (`:1239`) → `ToolCardShell` head + `ToolRunRow` members (`:1282`) → mounted via `TranscriptView` at `App.tsx:4205`. Also applied inside nested rows (`:482`), so a delegated agent's reads group the same way.

**Focused test run (allowed single-file check):** `bun test app/renderer/src/toolRunLayout.test.ts app/renderer/src/grepResult.test.ts app/renderer/src/toolCardExpansion.test.ts` → **30 pass / 0 fail**, consistent with the row's claimed 14 + 12 + expansion tests.

**Anchor drift:** none. I re-verified every anchor this row cites: `collapseReadSearch.ts:762` (`collapseReadSearchGroups` is exactly at 762), `collapseReadSearch.ts:345-368` (`isNonCollapsibleToolUse` at 345-367), `Messages.jsx:1057-1085` (`ReadGroupRow`), `Messages.jsx:1088-1091` (`GroupedToolGroup` dispatching on `groupKind`), `GrepTool.ts:52-56` (the three output modes), `GrepTool.ts:254` (`mapToolResultToToolResultBlockParam`). All correct. This row's citation hygiene is the best in the lane.

**Why OVERSTATED rather than TRUE:** claim (3). See F1.

---

## Findings

| # | Severity | Row | Defect | Evidence | Failure scenario |
|---|---|---|---|---|---|
| F1 | Medium | CC-27 | The row claims the grouping rule "mirrors the engine's own" and that "every non-groupable display item is that break here … the same rule stated over the renderer's item stream". The engine does the opposite for skippable messages: it explicitly does NOT flush a group on thinking / attachment / system messages, it DEFERS them past the collapsed group so the badge stays at the first tool use. The renderer flushes on any non-groupable item. | Engine: `src/utils/collapseReadSearch.ts:918-932` (`shouldSkipMessage` branch, `deferredSkippable.push(msg)`, comment "Don't flush the group for skippable messages (thinking, attachments, system)"). Renderer: `app/renderer/src/toolRunLayout.ts:143` (`flush()` on every item that is not a groupable `single` tool-use row). | With interleaved thinking on (Claude interleaved-thinking, or Codex raw reasoning between tool calls), a sequence read → thinking → read → thinking → read renders as three separate cards in the desktop app while the terminal renders one collapsed group. The operator's actual ask — a PARALLEL batch issued in one assistant message — is unaffected, because those `tool_use` blocks are contiguous and the intervening `tool_result` user frames project no row (`transcriptProjector.ts:1906-1921`). So the shipped outcome is right and the parity claim is what overstates. |
| F2 | Low | P2-2 | Anchor drift in three citations, present in BOTH the STATUS row and the shipped source comments that repeat them. Every underlying claim re-verified TRUE at the current location, so no behaviour is wrong. | (a) `queryHelpers.ts:478` cited for `content.is_error !== true` — actual `src/utils/queryHelpers.ts:499`; the stale anchor is also baked into `app/renderer/src/transcriptProjector.ts:1388`. (b) `FileEditTool/types.ts:63-80` cited for `structuredPatch: StructuredPatchHunk[]` — the cited range is the `filePath`/`oldString`/`newString`/`originalFile` fields; `structuredPatch` is at `src/tools/FileEditTool/types.ts:81`. (c) `messages.ts:1306-1328` cited for "orphan-if-unresolved handling" — that range builds the tool-result lookup; the orphan marking for `server_tool_use`/`mcp_tool_use` is at `src/utils/messages.ts:1377-1400`. | A later session following (a) reads Write-tool timestamp handling instead of the `is_error` read and either duplicates the narrowing or concludes the projector's stated basis is wrong. |
| F3 | Low | P2-2 | Two `projectMessage` cases carry comments declaring themselves "P2-2 scope" while returning `state` unchanged, and P2-2 is ✅. Unlike the neighbouring no-op cases, neither comment records WHY it is safe (both frames are effectively unreachable at this seam), so the code reads as an unfinished P2-2 obligation. | `app/renderer/src/transcriptProjector.ts:876-884` (`tool_progress` → "P2-2 scope: live activity on the correlated tool card"; `tool_use_summary` → "P2-2 scope: summary chip"). Reachability I checked: `tool_progress` is minted only under `CLAUDE_CODE_REMOTE`/`CLAUDE_CODE_CONTAINER_ID` (`src/utils/queryHelpers.ts:184-189`); `tool_use_summary` is gated on `config.gates.emitToolUseSummaries`, which reads `process.env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES` (`src/query/config.ts:36-38`) and is off by default. | A future auditor or session reads these as a shipped-but-broken P2-2 deliverable and either "fixes" a no-op that is correct, or files a false regression. Comment-only fix: state the gate, as the `rate_limit_event` / `prompt_suggestion` cases already do. |

---

## Operator steps required (UNVERIFIABLE-HEADLESS rows only)

None. All three rows were settled from source; no row in this lane required a live GUI to reach its verdict.

CC-27 already carries its own `⬜ operator GUI acceptance PENDING` marker in STATUS, which this audit does not clear and does not need to: the claim I could not settle headlessly (that a CLICK on a member row expands it) is wired at `TranscriptView.tsx:1468-1472` (`onClick={() => toggle(!open)}`, `aria-expanded={open}`) and its decision logic is unit-tested at store level. That is a wiring verification, not an interaction verification, and the row is already honest about the distinction ("proves the derivations and the markup, NOT the click").

---

## Nits

- Orphan correlation entries are never reclaimed: a `tool_result` for a `tool_use` the renderer never saw stays in `toolResultsByUseId` for the life of the session (`transcriptProjector.ts:1343-1359`). Bounded by tool-call count, harmless in practice, worth knowing.
- `Glob` maps to family `grep` (`transcriptProjector.ts:1564`), so a Glob with zero results renders the digest `no matches` (`grepResult.ts:47-49,68`) when it measured files. Its non-empty result is a bare filename list with no `Found N files` header, so it correctly renders no digest at all. Cosmetic only.
- `readRangeLabel` uses `Math.max(0, …)` (`TranscriptView.tsx:1581`), so an explicit `offset: 0` — which the schema permits (`FileReadTool.ts:228`, `nonnegative`) — would print `from line 0`. Matches what the gutter would print for the same call, so it is consistent rather than wrong.
- P2-3's title says "streaming/activity engine" but only TEXT deltas stream. There is no `thinking_delta` handling anywhere in the renderer (`content_block_delta` narrows to `text_delta` at `transcriptProjector.ts:1667`; zero matches for `thinking_delta` in `transcriptProjector.ts` or `reasoningLayout.ts`), so the desktop app shows no live reasoning while the terminal does. **P2-3 never claimed it and no STATUS row does**, so this is an unclaimed gap rather than a false ✅ — flagged here because whichever lane owns P2-1 / reasoning display should know it is unowned.
- Concurrent edit in flight: `app/renderer/src/sdkMessageFixtures.ts` and `app/renderer/src/transcriptProjector.test.ts` are dirty from another session. `transcriptProjector.ts` itself and every other file I audited are clean at HEAD; all verdicts above are against committed HEAD.
