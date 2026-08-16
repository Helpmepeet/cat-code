# Claude Code compaction evolution: Cat Code versus current upstream

**Date:** 2026-08-09
**Scope:** Cat Code’s current source, installed upstream Claude Code 2.1.223, and the officially shipped 2.1.224 native artifact
**Status:** reverse-engineering report; no implementation changes
**Corrections:** §15 records a 2026-08-12 claim-by-claim verification of every
CAT-SOURCE claim in §4. Ten are wrong or imprecise, and most §4.8/§4.12 line
citations have drifted. Read §15 before acting on any §4 claim.
**Source basis:** Cat Code working-tree source plus static analysis of shipped upstream executables; source and executable control flow win over release notes

## 1. Executive conclusion

**Compaction has meaningfully evolved, but not into a completely different persistence architecture.** The durable core is still recognizable: generate a continuation summary, insert a compact boundary, rebuild active context after that boundary, and resume from an append-oriented transcript graph. The major architectural evolution is that current upstream no longer treats full-history replacement as its preferred compaction behavior.

Cat Code’s normal path still performs **traditional full compaction**:

```text
active post-boundary conversation
  -> summarize all active messages
  -> compact boundary
  -> synthetic continuation summary
  -> regenerated files/plans/skills/tools/agent attachments
  -> continue
```

Its ordinary `compactConversation()` returns no verbatim recent messages. Partial compaction and experimental session-memory compaction can preserve segments, but those are not the default automatic path.

Current upstream’s preferred path is **reactive prefix compaction**:

```text
active post-boundary conversation
  -> group complete API/assistant rounds
  -> summarize an older prefix
  -> preserve recent groups verbatim
  -> compact boundary with explicit preserved-message metadata
  -> regenerate dynamic state
  -> retry the interrupted request in the same turn
```

Upstream retains an older full compactor as a fallback. It also contains an experiment-gated background precomputation system that can generate and persist a validated summary before the threshold is crossed.

The most important findings are:

1. **Recent-turn preservation is the main compaction-quality improvement.** It reduces recursive summary loss, preserves exact tool/result and interruption context, and makes compaction recovery less disruptive.
2. **Modern upstream stores more structured compaction state outside summary prose.** This includes explicit preserved-message UUID lists, cumulative dropped-token metadata, deferred-tool discovery, independent transcript metadata, background-agent transcripts, and optional precomputed summaries.
3. **Neither implementation makes the summary the only state authority.** Both rebuild files, plans, tools, hooks, and agent/task information after compaction, and both restore other session state from independent records.
4. **“Full pre-compaction history is preserved” is not generally true upstream.** Upstream 2.1.223 physically compacts JSONL files above 5 MiB, preserving the latest boundary, explicitly retained messages, required parent bridges, file history, and last-wins metadata. Upstream 2.1.224 preserves older intervals in the live fullscreen reducer, but its large-transcript loader still does not reload every historical interval.
5. **Remote Control changes are mostly synchronization repairs, not a new compaction engine.** Upstream 2.1.224 forwards coarse compacting status, compact boundaries, and `/clear` resets through the shared bridge. Raw hook/start/end `compact_progress` events are still filtered from SDK output.
6. **Cat Code has already backported or independently built several post-fork ideas.** Its nominal version `2.1.87` understates the current source: it has PreCompact hooks, partial compaction, preserved-segment relinking, prompt-cache-sharing summary forks, deferred-tool restoration, Agent Mode state, Codex-specific prompt handling, and scaled model-aware thresholds.
7. **Cat Code still has a consequential default-path gap.** Reactive compaction call sites exist, but the implementation is absent and the feature is not in the normal build. Its default automatic compactor therefore discards exact recent turns from active context.
8. **Cat Code should use targeted architectural upgrades, not wholesale upstream copying.** The highest-value changes are reactive recent-group preservation, explicit preserved-message metadata, structured interrupted-turn continuation, and a durable hot/cold history design for always-on sessions.

## 2. Evidence standard and scope

### 2.1 Evidence labels

This report uses these evidence classes:

- **CAT-SOURCE:** confirmed by current Cat Code source.
- **UP223-STATIC:** confirmed by producer/consumer control flow in the shipped upstream 2.1.223 executable.
- **UP224-STATIC:** confirmed by control flow in the official upstream 2.1.224 darwin-arm64 package.
- **RUNTIME:** verified by running a local, non-network command such as `--version` or `--help`.
- **RELEASE:** described by the official changelog/release record but not independently established in an inspected executable.
- **INFERENCE:** the strongest explanation supported by surrounding evidence, but not directly observable as a complete behavior.

A string was not treated as behavioral proof unless its producer, consumer, or control-flow role was recovered.

### 2.2 Artifacts

Installed upstream launcher:

```text
/Users/pt/.local/bin/claude
  -> /Users/pt/.local/share/claude/versions/2.1.223
```

Installed 2.1.223 artifact:

- Mach-O arm64 Bun executable
- SHA-256: `a63e3ecbf6b58812fb314b8a8d99a12b45ec7c11209ad09598469542edbba8b3`
- Build time: `2026-08-05T18:12:31Z`
- Git SHA: `4535f69721056abf01650c73ee8a91c69ba00838`
- Embedded JavaScript in the Mach-O `__BUN` segment

An upstream-original local copy has SHA-256 `fcbe0b8d47570c501302dd1ad31cc26ac2810f022c45fa253936a6961dee32bf`. The installed executable differs in 271 bytes in streamed thinking-delta handling. The compaction, persistence, Remote Control, resume, and agent paths examined here match the upstream-original copy.

Official 2.1.224 native artifact:

- Package: `@anthropic-ai/claude-code-darwin-arm64@2.1.224`
- Archive SHA-256: `d4f3483f5f3f6e4c161b74406bcb846ffc5c49bcdc79f0d1b187050cfd247a31`
- Native executable SHA-256: `391df9d2ab04e4cf32199335720ac7715a582e91eaecfd4d2198a16f57ea59b3`
- Extracted embedded CLI SHA-256: `adfd916312ee4bafef7a8f184b01d95d881b36ef3b7b74562f101561a029d2d3`
- Build time: `2026-08-06T01:05:53Z`
- Git SHA: `8a2a469b68f918917492973f3b16bd1682b9f82c`

The registry reported 2.1.226 as latest by the end of the investigation. Official 2.1.225 and 2.1.226 archives were acquired and integrity metadata recorded, but their executables were not extracted or analyzed after the user asked to stop extending the research. No behavioral claim in this report is attributed to those versions.

### 2.3 Runtime boundary

**RUNTIME:**

```text
claude --version
2.1.223 (Claude Code)
```

`claude --help` confirmed the live parser exposes `--autocompact`, `--continue`, `--resume`, `--fork-session`, and `--no-session-persistence`.

No live compaction was run. Doing so would require an authenticated model call and usage. Remote server retention, worker-lease arbitration, mobile/web rendering, and backend archive lifetime remain outside what static client reverse engineering can establish.

## 3. Architecture at a glance

### 3.1 Cat Code today

```text
queryLoop()
  -> select latest compact boundary and later messages
  -> tool-result replacement budget
  -> optional history snip
  -> optional microcompact
  -> optional context-collapse projection
  -> resolve runtime model/provider
  -> estimate tokens and test autocompact threshold
  -> compactConversation()
       -> PreCompact hooks
       -> one-turn current-model summary fork
       -> fallback direct summary request
       -> compact boundary
       -> synthetic compact-summary user message
       -> rebuilt files/plans/skills/tools/MCP/agent attachments
       -> SessionStart/PostCompact hooks
  -> continue query loop with boundary-relative context
```

Primary owners:

- `src/query.ts:393-683,1119-1241,1581-1591`
- `src/services/compact/autoCompact.ts:35-508`
- `src/services/compact/compact.ts:302-800,1192-1676`
- `src/services/compact/prompt.ts:42-875`
- `src/utils/messages.ts:4719-4845`
- `src/utils/sessionStorage.ts:1442-1532,2348-2481,2685-2731,4160-4616`

### 3.2 Upstream 2.1.223/2.1.224

```text
query loop
  -> estimate current context from latest API usage plus later messages
  -> resolve native/effective/configured context window
  -> optional background precompute arm/consume
  -> threshold, prompt-too-long, media-too-large, or 1M-credit clamp
  -> reactive selector groups post-boundary conversation rounds
  -> summarize older prefix
  -> preserve recent groups verbatim
  -> boundary with preservedMessages/preservedSegment metadata
  -> regenerate dynamic state
  -> retry same turn
  -> fallback to traditional full compaction if reactive path unavailable
```

Relevant 2.1.223 minified aliases include:

| Alias | Recovered role |
|---|---|
| `Ew` / `j7p` | effective/native model context window |
| `v9` / `JEe` / `TEo` | configured window, usable capacity, compact threshold |
| `LR` / `GH` | current token estimate and message estimate |
| `y9s` | automatic threshold compaction |
| `iLo` / `YMo` / `zby` | reactive orchestration, prefix selection, summary fork |
| `GNo` | full fallback compactor |
| `QLy` | manual `/compact` reactive path |
| `tfn` | compact-boundary constructor |
| `u3s` / `uVb` | preserved-message metadata and resume relinking |
| `BXe` / `aLo` | postcompact active-context assembly and regenerated state |
| `DVr` / `HMe` | large-transcript scanning and resume loading |

Offsets and unique strings are recorded in the evidence sections below.

## 4. Cat Code today

### 4.1 Trigger and query-loop ownership

**CAT-SOURCE:** `queryLoop()` is the main compaction owner. On every iteration it projects messages from the latest compact boundary, applies enabled context reductions, resolves the runtime model/provider, tests automatic compaction, and then enforces a hard preflight limit before the provider call (`src/query.ts:393-683`). Prompt-too-long and media failures can be withheld for optional recovery (`src/query.ts:1119-1241`).

Traditional automatic compaction is the operational default. The repository contains call sites for reactive compaction and context collapse, but `REACTIVE_COMPACT`, `CONTEXT_COLLAPSE`, and `HISTORY_SNIP` are absent from the documented normal and `dev-full` feature sets (`scripts/build.ts:13-50,82-110`). The referenced reactive implementation is absent from the checkout.

Session-memory compaction exists, but its normal feature gates are off unless experiments or an explicit override enable it (`src/services/compact/sessionMemoryCompact.ts:408-441`; `src/services/SessionMemory/sessionMemory.ts:77-93`). Cached microcompaction is compiled into `dev-full`, while its runtime default is false (`src/services/compact/cachedMCConfig.ts:9-19`). Time-based microcompaction also defaults false (`src/services/compact/timeBasedMCConfig.ts:30-43`).

### 4.2 Token estimation

**CAT-SOURCE:** Cat Code does not fully retokenize the transcript before each request. `tokenCountWithEstimation()` searches backward for the latest assistant response with nonzero API usage, uses its input/cache/output totals as an anchor, and estimates only later messages (`src/utils/tokens.ts:296-397`).

A usage anchor includes:

```text
input_tokens
+ cache_creation_input_tokens
+ cache_read_input_tokens
+ output_tokens
```

Preserved messages can have stale usage zeroed during relinking. GPT usage is not reused after switching to Claude when Codex-side truncation could understate the logical transcript.

### 4.3 Context windows and thresholds

**CAT-SOURCE:** `getContextWindowForModel()` resolves:

1. Anthropic-only `CLAUDE_CODE_MAX_CONTEXT_TOKENS`.
2. Explicit `[1m]` model marker.
3. Claude 5 frontier behavior.
4. First-party model capability cache.
5. 1M beta/experiment eligibility.
6. GPT-5.6 Sol/Terra/Luna at 372,000.
7. Other `gpt-*` models at 272,000.
8. Unknown models at 200,000.

Owner: `src/utils/context.ts:8-136`.

Cat first reserves output capacity:

```text
effectiveContext = contextWindow - min(modelMaximumOutputTokens, 20,000)
```

It then uses a Cat-specific scaled recovery reserve:

```text
recoveryReserve = clamp(floor(effectiveContext * 0.08), 10,000, 50,000)
autocompactBuffer = 3,000 + recoveryReserve
autocompactThreshold = effectiveContext - autocompactBuffer
blockingLimit = effectiveContext - 3,000
```

Owners: `src/services/compact/autoCompact.ts:35-76,193-286`.

Derived defaults:

| Cat model category | Nominal window | Effective window | Autocompact | Blocking limit |
|---|---:|---:|---:|---:|
| Unknown non-GPT | 200,000 | 180,000 | 162,600 | 177,000 |
| Generic GPT | 272,000 | 252,000 | 228,840 | 249,000 |
| GPT-5.6 Sol/Terra/Luna | 372,000 | 352,000 | 320,840 | 349,000 |
| 1M / Claude 5 frontier | 1,000,000 | 980,000 | 927,000 | 977,000 |

The scaled 8% threshold came from Cat commit `aa03b988`; the 372K GPT window came from `f1f0518c`. These are confirmed Cat-specific changes rather than inherited 2.1.87 behavior.

Autocompaction is enabled by default but can be disabled by `DISABLE_COMPACT`, `DISABLE_AUTO_COMPACT`, or global configuration (`src/utils/config.ts:624-630`; `src/services/compact/autoCompact.ts:288-299`). Three nontransient failures open a per-session/per-agent circuit breaker (`src/services/compact/autoCompact.ts:388-508`).

### 4.4 Summary generation

**CAT-SOURCE:** `compactConversation()` runs PreCompact hooks, creates a summary request, and invokes a one-turn fork using the current main-loop model/provider (`src/services/compact/compact.ts:390-512,1192-1473`). It does not select a cheap secondary model.

The preferred fork has:

- `maxTurns: 1`
- no tools
- `skipCacheWrite: true`
- the current model/provider
- the existing request prefix for prompt-cache reuse

If the fork cannot produce a summary, the fallback still uses the current model/provider, disables thinking, and caps output at 20,000 tokens. Cat commit `2c45369d` repaired the Codex/OpenAI fallback’s provider instruction assembly.

If the summary request itself is too long, Cat retries up to three times while dropping the oldest API-round groups (`src/services/compact/compact.ts:463-512`).

### 4.5 Prompt and summary format

**CAT-SOURCE:** Claude-style and GPT-style prompts both demand text only, reject tool use, and ask for a structured continuity summary. The principal sections are:

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and fixes
5. Problem Solving
6. All user messages
7. Pending Tasks
8. Current Work
9. Optional Next Step

Owners:

- `src/services/compact/prompt.ts:42-56`
- Claude contract: `src/services/compact/prompt.ts:115-197`
- GPT contract: `src/services/compact/prompt.ts:319-396`
- selection/custom instructions: `src/services/compact/prompt.ts:661-709`

`formatCompactSummary()` strips the `<analysis>` drafting block and renders `<summary>` as `Summary:` (`src/services/compact/prompt.ts:711-741`). Automatic compaction tells the resumed model to continue directly rather than acknowledge or recap the summary (`src/services/compact/prompt.ts:808-875`).

Cat adds provider-specific GPT wording and Agent Mode continuity text. These are Cat modifications, not evidence that the core compactor changed upstream at the fork point.

### 4.6 What survives traditional compaction

**CAT-SOURCE:** The postcompact sequence is:

```text
boundaryMarker
summaryMessages
messagesToKeep
attachments
hookResults
```

`buildPostCompactMessages()` is at `src/services/compact/compact.ts:328-341`.

For traditional full compaction, `messagesToKeep` is empty. Exact old user, assistant, tool-call, and tool-result text therefore disappears from the model’s active context unless the generated summary captures it.

Cat rebuilds state outside summary prose:

- Up to 5 recently read files.
- Up to 5,000 tokens per file and 50,000 total.
- Current plan attachment.
- Plan-mode instructions.
- Invoked skills, up to 5,000 tokens each and 25,000 total.
- Running or unretrieved local-agent status/results.
- Deferred-tool delta.
- Agent-listing delta.
- MCP instruction delta.
- SessionStart and PostCompact hook output.

Owners: `src/services/compact/compact.ts:538-655,1492-1676`.

The boundary also records `preCompactDiscoveredTools`, allowing already-discovered deferred-tool schemas to survive when their original tool-reference blocks are summarized away (`src/services/compact/compact.ts:625-640`).

### 4.7 What can be lost

The following can be lost from active model context:

- Exact wording omitted or distorted by the summary.
- Old tool arguments and results not captured in the summary.
- Attachments beyond file/skill count and token caps.
- Old file contents that are no longer among the recent-file set.
- Dynamic task/agent detail not represented by rebuilt attachments.
- State represented only by ephemeral attachment messages without an independent durable owner.
- Details recursively compressed out during repeated traditional compactions.

Cat’s external-user build filters many attachment messages from ordinary transcript persistence (`src/utils/sessionStorage.ts:5208-5320`). Their underlying state may survive through dedicated records or regeneration, but the attachment text itself is not a reliable resume authority.

### 4.8 Boundary and transcript graph

**CAT-SOURCE:** A compact boundary is a system message with subtype `compact_boundary`, visible content `Conversation compacted`, and compact metadata (`src/utils/messages.ts:4719-4744`; `src/types/message.ts:132-163,284-295`).

On persistence it becomes a new active root:

```text
parentUuid: null
logicalParentUuid: previous chain parent
```

Owner: `src/utils/sessionStorage.ts:1442-1532`.

This creates two views:

- **Active resume:** follow `parentUuid`, beginning at the latest compact boundary.
- **Archival display:** use `logicalParentUuid` to cross the boundary and display older history.

Owners: `src/utils/sessionStorage.ts:2685-2731,4574-4616`.

Compaction is therefore an active-context cut, not necessarily deletion of old Cat JSONL rows.

### 4.9 Preserved segments

**CAT-SOURCE:** Partial and session-memory paths can annotate the boundary with:

```text
preservedSegment: {
  headUuid,
  anchorUuid,
  tailUuid
}
```

Creation: `src/services/compact/compact.ts:343-370`.

On resume, `applyPreservedSegmentRelinks()` validates the tail-to-head walk, reconnects the head to the summary anchor, reconnects later children to the preserved tail, zeroes stale usage, and prunes obsolete active history (`src/utils/sessionStorage.ts:2348-2481`). If validation fails, Cat fails safe by retaining full history rather than constructing a broken chain.

This is useful but weaker than upstream’s explicit preserved-message UUID list. A head/tail walk assumes an intact linear segment; upstream can name every retained UUID and distinguish durable UUIDs from an in-process superset.

### 4.10 Partial and session-memory compaction

**CAT-SOURCE:** `partialCompactConversation()` supports:

- `from`: keep an older prefix and summarize a newer tail.
- `up_to`: summarize an older prefix and preserve a newer suffix.

Owner: `src/services/compact/compact.ts:809-1162`.

Session-memory compaction can preserve a recent verbatim tail. Defaults are at least 10,000 tokens and five text-bearing messages, capped at 40,000 tokens (`src/services/compact/sessionMemoryCompact.ts:48-70,325-406`). It avoids splitting tool-use/result pairs and Claude thinking invariants. It is not the normal default path.

### 4.11 Repeated compaction

**CAT-SOURCE:** Every full boundary becomes the next active root. `getMessagesAfterCompactBoundary()` selects the latest boundary and all later messages (`src/utils/messages.ts:4794-4845`).

Repeated traditional compaction therefore summarizes:

```text
prior summary
+ post-boundary messages
+ regenerated attachments still present
```

It does not automatically revisit the original detailed history. This is recursive lossy compression even though archival JSONL may still contain old rows.

### 4.12 Resume and interrupted turns

**CAT-SOURCE:** Resume loads the active transcript chain, reconstructs preserved segments, deserializes messages, runs resume SessionStart hooks, and restores independent state (`src/utils/conversationRecovery.ts:496-656`; `src/utils/sessionRestore.ts:110-167,639-833`). Restored state includes file history, attribution, context-collapse state, todos, thread goal, worktree state, metadata, and Agent Mode.

`deserializeMessagesWithInterruptDetection()` removes unresolved tool uses, orphan thinking-only records, malformed/empty assistants, and detects interrupted turns (`src/utils/conversationRecovery.ts:157-348`). It can append `Continue from where you left off.` after an interrupted tool trajectory and add a hidden assistant sentinel after a trailing user message for API validity.

This recovery is useful but less exact than upstream’s structured partial-output continuation tied to the transcript boundary UUID.

### 4.13 Agents and background state

**CAT-SOURCE:** Subagents use the same query machinery and can compact their own sidechain transcripts (`src/tools/AgentTool/runAgent.ts:859-919`). `resumeAgentBackground()` reloads the sidechain, filters incomplete state, restores content replacements and worktree context, and resumes it in the background (`src/tools/AgentTool/resumeAgent.ts:86-407`).

Agent Mode worker state exists independently of ordinary conversation text (`src/agent-mode/sessionState.ts:662-709`). Traditional compaction reads it and tries to include it in the continuity message (`src/services/compact/compact.ts:449-458,642-655`).

There is a confirmed integration mismatch:

- `readSessionState()` returns `objective`, `currentPhase`, `activeWorker`, `knownWorkers`, and `nextAction` (`src/agent-mode/sessionState.ts:662-688`).
- `formatAgentModeState()` expects a broader object containing `planSummary`, approval fields, blocked reason, execution target, verifier verdict, handoff, and optional nested `sessionState` (`src/services/compact/prompt.ts:743-805`).
- `compactConversation()` passes the narrow object directly rather than under `sessionState` (`src/services/compact/compact.ts:449-458,642-655`).

The result can render broad fields as `undefined` while omitting known-worker continuity. Existing prompt tests construct the broad shape manually and do not exercise this live integration.

### 4.14 Remote synchronization

**CAT-SOURCE:** Cat emits compaction lifecycle callbacks through `context.onCompactProgress` (`src/services/compact/compact.ts:413-438,614-623`) and persists compact boundaries to CCR v2 with `isCompaction: true` (`src/utils/sessionStorage.ts:1577-1812`). Remote hydration supports foreground and per-agent events and comments that CCR v2 returns events beginning at the latest compact boundary (`src/utils/sessionStorage.ts:2112-2235`).

The source evidence confirms production and persistence of compaction markers. This investigation did not establish that every Cat remote viewer consumes every fine-grained progress event.

### 4.15 `/clear`

**CAT-SOURCE:** `/clear` is architecturally different from compaction. `clearConversation()`:

- Runs SessionEnd hooks.
- Sends a provider-cache eviction hint.
- Empties active messages.
- Resets cost, file, metadata, plan, MCP, and session state.
- Generates a new session UUID.
- Runs SessionStart hooks for `clear`.

Owner: `src/commands/clear/conversation.ts:50-256`.

Background tasks are deliberately preserved unless they are foreground-only, and running local-agent output links are moved into the new session directory (`src/commands/clear/conversation.ts:88-108,139-229`).

| Operation | Session ID | Summary | Old active context | Eligible background tasks |
|---|---|---|---|---|
| Compaction | Preserved | Generated | Replaced by boundary/summary | Preserved |
| `/clear` | New | None | Empty | Deliberately preserved |

### 4.16 Prompt-cache behavior

**CAT-SOURCE:** Anthropic-style compaction forks use the existing prefix with `skipCacheWrite`, allowing cached-prefix reads without writing an ordinary new cache entry (`src/services/api/claude.ts:3375-3524`).

Codex uses the Cat session UUID as `prompt_cache_key` (`src/setup.ts:88-96`; `src/services/api/codex-fetch-adapter.ts:3289-3302`). Compaction preserves the UUID. `/clear` creates a new UUID.

Codex WebSocket continuation uses `previous_response_id` only when the next canonical input extends the previous baseline (`src/services/api/codex-websocket-transport.ts:669-759,944-1050`). Full compaction replaces the prefix, so the next request sends full context rather than a delta while retaining the same logical prompt-cache key.

## 5. Current upstream architecture

### 5.1 Core trigger model

**UP223-STATIC:** Upstream has three compaction paths:

1. **Reactive prefix compaction**, used by modern automatic and manual flows.
2. **Experiment-gated background precomputation**, which can prepare a prefix summary early.
3. **Traditional full compaction**, retained as fallback.

Automatic compaction can be triggered by:

- Configured or model-derived token threshold.
- Prompt-too-long provider response.
- Applicable image/media-size failure.
- Long-context entitlement failure that clamps a native 1M model to 200K.

The query engine withholds a recoverable provider error while compaction runs. On success it re-enters the same query loop with a transition reason such as `reactive_compact_retry` or `precomputed_compact_swap`.

### 5.2 Context-window resolution

**UP223-STATIC:** The native window resolver (`j7p`, near artifact offset `0xf1a9299`) considers:

- Explicit 1M aliases.
- Eligible 1M beta headers.
- Provider-native 1M models.
- Dynamic Sonnet windows.
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` for non-Claude custom models.
- A 200,000-token fallback.

The effective input capacity reserves up to 20,000 output tokens. The ordinary compact threshold (`TEo`) is then usually:

```text
effectiveInputCapacity - 13,000
```

Unlike Cat’s scaled 8% reserve, this buffer is normally fixed after output reservation.

The configured autocompact window resolver (`v9`) considers, in order:

1. `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.
2. Session/settings `autoCompactWindow`.
3. First-party client-data override.
4. Experiment override.
5. Model-specific default.
6. Unknown-model enforcement.
7. Native automatic behavior.

Configured values are capped to the model’s resolved window and accepted between 100K and 1M.

### 5.3 Unknown/custom models

**UP223-STATIC:** A genuinely unknown model defaults to an assumed 200K window unless `CLAUDE_CODE_MAX_CONTEXT_TOKENS` supplies another valid value. Unknown-model enforcement returns the assumed native window as both the configured and enforced value, with source `unknown-model`. This is executable trigger routing, not merely a UI label.

Recognized aliases and overrides inherit their mapped model behavior. Managed gateway cases can be exempt when the CLI cannot infer the deployed model’s real limit.

This is an important reliability change: an unrecognized model no longer silently bypasses local context enforcement merely because the CLI lacks a catalog entry.

### 5.4 1M models and forced 200K behavior

**UP223-STATIC:** A long-context entitlement error such as `Extra usage is required for long context` sets a session-global credits-blocked latch. When the native window is above 200K, the effective window resolver then returns 200K. Reactive compaction treats the same entitlement error as a prompt-too-long equivalent and seeds its target gap from approximately:

```text
estimatedConversationTokens - 200,000
```

This is the implementation behind forced 200K behavior after 1M entitlement failure.

**RELEASE, supported by surrounding static machinery:** 2.1.223 generalized `CLAUDE_CODE_DISABLE_1M_CONTEXT` from a fixed model list to native-1M models and described enforcing the standard window through autocompaction. The exact environment-variable branch was not isolated as completely as the entitlement-latch path.

Cat’s current context resolver can disable its 1M paths, but it does not expose upstream’s same explicit distinction among native window, entitled window, configured autocompact window, and failure-induced effective clamp.

### 5.5 Reactive message selection

**UP223-STATIC:** Reactive selection begins after the latest compact boundary and removes progress-only records. It groups messages around complete assistant API message IDs rather than treating every split assistant block as an independent turn. Incomplete-thinking continuation records remain in the same logical group.

Initial policy:

- Preserve one recent trailing group.
- Summarize every earlier group.

If the summary request is too large, upstream preserves progressively more trailing groups. When a provider supplies a token gap, it estimates group sizes and advances by enough groups to close the gap. Without a parsed gap, it advances one group at a time.

This grouping protects:

- Tool-use/tool-result adjacency.
- Partial assistant continuations.
- Exact recent user intent.
- The active failure/retry trajectory.

If only one group exists, reactive compaction reports that compaction is impossible rather than manufacturing a malformed split.

On media-size failure it can replace image/document blocks with textual placeholders and retry once.

### 5.6 Manual and partial compaction

**UP223-STATIC:** Current `/compact` uses the reactive prefix-preserving implementation. It does not normally invoke the full-replacement compactor.

Partial “summarize from here” and “summarize up to here” flows remain separate and use direction-specific prompts. Boundary metadata records direction, summarized-message count, optional user focus, and preserved-message topology.

### 5.7 Summary prompt and response

**UP223-STATIC:** Upstream’s prompt has the same broad nine-section continuity structure now present in Cat. It also says:

```text
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
```

The summary is generated as a one-turn fork with tools denied, transcript writing disabled, cache writing skipped, and fallback-model policy available. The response parser removes `<analysis>` and renders `<summary>` as `Summary:`.

The continuation wrapper includes:

- The transcript path for exact historical details.
- Whether recent messages are preserved verbatim.
- Whether a REPL VM was cleared.
- A direction to continue without recapping the summary.

The compact summary is internally a user-role message marked `isCompactSummary` and transcript-only, not an ordinary human-authored prompt.

**RELEASE:** 2.1.139 changed the compact prompt to preserve sensitive/security-relevant instructions. This was a prompt-only change, not a new boundary or persistence model.

### 5.8 Boundary state

**UP223-STATIC:** Upstream’s `compact_boundary` can contain:

- trigger
- pre/post token counts
- cumulative dropped tokens
- duration
- user context
- summarized-message count
- precomputed flag
- discovered deferred tools
- legacy `preservedSegment`
- explicit `preservedMessages`
- logical parent UUID

The explicit representation is:

```text
preservedMessages: {
  anchorUuid,
  uuids,
  allUuids?
}
```

`uuids` names durable loggable records. `allUuids` is an in-process superset that may include messages not persisted to JSONL. Resume re-links the named UUIDs rather than relying only on a tail-to-head walk.

The boundary serves several independent purposes:

1. Active-context root.
2. Resume relinking anchor.
3. Archival/fork lineage through `logicalParentUuid`.
4. Token/drop accounting.
5. Deferred-tool continuity.
6. Remote synchronization marker.
7. UI compacted-state event.

### 5.9 State outside the summary

**UP223-STATIC:** Upstream reconstructs dynamic context after compaction rather than requiring prose to carry all state. Confirmed categories include:

- Recently read files, with file and token caps.
- Plan file and plan-mode state.
- Unretrieved local-agent task status/results.
- Invoked skills.
- Tool/MCP state and deferred-tool deltas.
- Memory and system-context attachments.
- SessionStart hook output for `compact`.
- Discovered deferred-tool names in boundary metadata.

The transcript loader separately restores title, mode, permission mode, isolation state, worktree state, PR links, bridge metadata, file history, attribution, content replacements, and context-collapse metadata.

### 5.10 Background precomputation

**UP223-STATIC:** Upstream contains an experiment-gated precompute system. Its hardcoded local fallback is off, so static inspection cannot say whether a particular account receives it.

When enabled, it can arm around 80% of usable context, create the same kind of prefix summary before the actual compact threshold, and persist:

```text
<session>.precompact.json
```

The sidecar is:

- Schema version 1.
- Mode `0600`.
- Limited to 8,000,000 bytes.
- Rejected after seven days.
- Bound to session ID and model.
- Bound to the transcript UUID where it was generated.
- Rejected for excessive growth, shrinkage, missing boundary, or missing preserved UUIDs.

It stores summary messages, preserved UUIDs, token estimates, attempt/group counts, API usage, and hook display text. Later messages are appended to the preserved set when the prepared result is consumed.

This is genuine new persisted compaction state, but it is primarily a latency optimization. It does not improve summary fidelity by itself.

### 5.11 Repeated compaction and history retention

**UP223-STATIC:** Active repeated compaction begins at the latest boundary. It recursively summarizes the previous summary plus subsequent activity. The summarizer does not reread every original pre-first-compaction message on each cycle.

The normal transcript is append-oriented until physical compaction runs. Once a JSONL file exceeds 5 MiB, upstream’s transcript compactor retains:

- Latest boundary onward.
- Explicit preserved messages.
- Required parent bridges.
- Associated file-history records.
- Accumulating and last-wins metadata.

It does not retain every earlier raw conversation interval. A 20 MiB backstop and a 50 MiB tombstone-removal read cap further bound this path.

**UP224-STATIC:** 2.1.224 changes the live fullscreen reducer. Instead of trimming everything before the newest boundary, it removes only UUIDs duplicated by preserved-message reinsertion and appends the boundary. This preserves earlier intervals in the live fullscreen UI.

The >5 MiB fast loader remains materially unchanged. Therefore 2.1.224 does not establish durable full-history resume for very large transcripts.

### 5.12 Resume and interrupted-turn recovery

**UP223-STATIC:** Upstream writes a synthetic interruption marker carrying an interrupted message ID and an `interruptedByShutdown` flag. Resume can determine that the original user turn is still unanswered even when partial assistant content and compact-summary/meta records follow it.

A reply-on-resume path can continue without a new user prompt. If a partial-output snapshot is bound to the current transcript leaf/boundary, upstream injects the exact pre-interruption text as quoted data and instructs the model to continue without repeating it. A boundary mismatch discards the hint rather than applying it to the wrong history.

Incomplete-thinking continuations remain one compaction group. This is more precise than a generic “Continue from where you left off” message.

### 5.13 Background agents and unattended sessions

**UP223-STATIC:** Compaction does not cancel the task registry. Subagent transcripts are independent sidechains. After process exit, upstream classifies orphaned agents using durable metadata and transcript evidence:

- Eligible recent Agent/forked-skill sessions can auto-resume.
- Existing but ineligible transcripts become stopped and resumable.
- Missing evidence becomes failed.
- Background shell commands stop after restart.
- Workflows can retain a run ID for continuation.

Remote transcript synchronization backfills main and subagent events, capped at 20 eligible subagents for historical backfill. The cap does not apply to live streaming.

This persistence architecture is adjacent to compaction rather than part of summary generation. It matters because an unattended session cannot rely on compact-summary prose to reconstruct live worker ownership.

### 5.14 Remote Control in 2.1.223 and 2.1.224

**UP223-STATIC:** 2.1.223 already produces detailed internal lifecycle events:

```text
compact_progress hooks_start/pre_compact
sdk_status compacting
compact_progress compact_start
compact_progress hooks_start/post_compact
compact_progress compact_end
sdk_status clear
```

It serializes coarse status and compact boundaries into SDK shapes. Some remote consumers already understand `system/status`, `system/compact_boundary`, and `conversation_reset`, but the general shared bridge path does not consistently forward all of them. Raw `compact_progress` reaches an intermediate event stream but is ignored by the remote adapter’s unknown-message/default path.

**UP224-STATIC:** 2.1.224 repairs the shared bridge:

- `sdk_status` is queued and forwarded as `system/status`.
- `compact_boundary` becomes bridge-eligible.
- `/clear` emits and forwards `conversation_reset`.
- Remote consumers clear compacting state on the boundary and reset local transcript/tool/loading state on conversation reset.

Raw detailed events are still filtered by a switch equivalent to:

```text
case "compact_progress":
case "stream_mode":
case "response_length":
  continue
```

Thus “compaction progress propagation” means coarse status propagation, not full hook/start/end telemetry.

### 5.15 Disconnect, reconnect, and stale sessions

**UP223/224-STATIC:** Remote Control persists a last-wins bridge-session record with session ID, sequence number, declared dialog kinds, and grouping ID. Reattachment uses explicit environment/caller state first and persisted transcript state afterward.

The worker transport carries epochs, heartbeat, batching, credential refresh, and error-specific rebuild behavior. Those client decisions are confirmed; server lease arbitration is not.

2.1.224 adds identity-sensitive remint behavior. A transcript head or bridge-eligible index mismatch indicates that resume, compaction, or another transcript rewrite invalidated the old remote attachment. It then:

- Suppresses reattachment to the stale server session.
- Mints a fresh remote session.
- Allows the old session’s delayed archive to execute.
- Suppresses inappropriate history backfill into the fresh session.

2.1.224 also persists a blank bridge marker to an explicit transcript path when Remote Control is disabled by an SDK host. Resume still reattaches when a genuinely nonempty bridge ID is present; the fix prevents an old ID from surviving an explicit disable.

### 5.16 `/clear`

**UP223/224-STATIC:** `/clear` creates a new conversation identity and empty active context. It does not create a compact boundary or summary. The old transcript remains resumable.

2.1.224 generalizes the existing `conversation_reset` shape through the shared bridge. Attached clients clear rendered messages, streaming tool state, in-progress IDs, loading state, cached title, and pending-clear bookkeeping, then adopt the new conversation ID.

### 5.17 Prompt-cache behavior

**UP223-STATIC:** Reactive and full summary requests use a one-turn fork with the existing prefix, `skipTranscript`, and `skipCacheWrite`. Telemetry records cache-read and cache-creation usage. If the cache-sharing path fails, upstream uses a direct one-turn summary request with prompt caching disabled.

Postcompact local cache clears do not prove that provider-side cache objects are deleted. The safe conclusion is that compaction changes the request prefix, reuses an old prefix where possible for summary generation, resets local continuation state, and lets abandoned provider cache entries expire under provider policy.

## 6. Evolution from the Cat fork point

Cat’s `2.1.87` version is not an exact architecture baseline because its source has diverged substantially. The official 2.1.87 package still establishes which broad mechanisms predated the fork.

| Version/range | Evolution | Classification | Cat today |
|---|---|---|---|
| At or before 2.1.87 | Summary compaction, compact boundaries, `/clear`, resume, Remote Control, background subagents, print/headless interrupted-turn resume | Inherited architecture | Present, heavily modified |
| 2.1.89-2.1.101 | Thrash breaker, chain repair, bounded large-session caches, attachment/transcript reliability | Reliability/persistence | Several equivalent protections present |
| 2.1.105 | Blockable PreCompact hooks | Lifecycle architecture | Present |
| 2.1.113-2.1.121 | Resumed long-context compaction, faster large resume, fork parent-pointer hydration, corrupt-line and memory fixes | Persistence/reliability | Cat has its own resume graph and relinking |
| 2.1.139 | Sensitive-instruction summary wording | Prompt-only | Equivalent safety wording appears in current prompts |
| 2.1.139-2.1.144 | Daemon-backed Agent View and first-class background-session resume | Separate agent/session architecture | Cat has different Agent Mode/task machinery |
| 2.1.141 | “Summarize up to here” | Context behavior | Present as partial compaction |
| 2.1.142 onward | Reactive overflow-aware prefix selection | Compaction architecture | Call sites exist; implementation absent/default off |
| 2.1.144-2.1.181 | Background resume, long rendering, leaks, partial-response and idle-history repairs | Reliability | Mixed Cat-specific equivalents |
| 2.1.191-2.1.196 | Recoverable `/clear` timeline and remote/background process handoff | Persistence/architecture | Cat’s behavior differs; no direct equivalence assumed |
| 2.1.198-2.1.218 | Reconnect recovery, late-join snapshots, context-limit fixes, postcompact usage, large-agent resume | Reliability/distributed state | Some Cat CCR/task mechanisms present |
| 2.1.221 | Correct falsy parsing for interrupted-turn auto-resume | Minor implementation | Separate Cat path |
| 2.1.223 | Native-1M/200K enforcement and unknown-model window enforcement | Context-management behavior | Cat has model-aware windows but a different policy model |
| 2.1.224 | Shared-bridge compact status/boundary/reset repairs; fullscreen interval retention; stale-session archival | Distributed-state reliability | Cat has boundary persistence, exact client parity unproven |

The evolution is therefore not one single rewrite. It consists of:

- **Prompt-only changes:** security-sensitive summary wording and worker instructions.
- **Minor implementation fixes:** environment boolean parsing and edge-case token accounting.
- **Reliability fixes:** transcript chain recovery, bounded loaders, stale usage removal, reconnect and resume repairs.
- **New persistent state:** preserved UUID lists, precompact sidecars, background-session metadata, partial-output snapshots.
- **New context behavior:** reactive prefix selection, same-turn retry, unknown-model enforcement, 1M-to-200K clamps.
- **Distributed architecture:** persistent background sessions and Remote Control state synchronization.

## 7. Concrete Cat-versus-upstream delta

| Area | Cat Code today | Upstream 2.1.223/2.1.224 | Behavioral impact |
|---|---|---|---|
| Default automatic compaction | Full active-history summary | Reactive older-prefix summary with recent groups retained | Upstream preserves exact immediate intent and tool trajectory |
| Manual `/compact` | Traditional full path unless alternative feature selected | Reactive prefix-preserving path | Upstream manual compact is less disruptive |
| Reactive retry | Call sites/gates, implementation absent from checkout | Same-turn prompt-too-long/media/credit-clamp recovery | Cat is more likely to surface failure or lose recent exact context |
| Summary prompt | Nine-section Claude/GPT variants plus Agent Mode text | Similar nine-section contract and security wording | Mostly prompt parity, not the main gap |
| Summary model | Current model/provider; cache-sharing fork | Current/fallback policy; cache-sharing fork | Broadly aligned |
| Recent verbatim messages | Empty in normal full compact | One or more complete recent groups | Major long-session quality difference |
| Preserved topology | Legacy head/anchor/tail segment | Explicit durable UUID list plus in-process UUID superset and legacy segment | Upstream handles non-linear/virtual message sets more explicitly |
| Boundary metadata | Trigger, tokens, context, segment, discovered tools | Adds post tokens, cumulative dropped tokens, duration, precomputed flag, explicit preserved UUIDs | Better diagnostics and repeated-compaction accounting upstream |
| State attachments | Files, plan, plan mode, skills, agents, deferred tools, MCP, hooks | Similar categories | Both correctly keep state outside summary prose |
| Agent authority | Cat task/Agent Mode state and subagent sidechains | Persistent agent/background-session metadata and sidechains | Different architectures; concepts transfer, code does not |
| Agent Mode compact injection | Confirmed narrow/broad shape mismatch | No equivalent Cat-specific formatter | Cat can lose authoritative worker continuity despite separate state |
| Interrupted turns | Cleanup plus generic continuation prompt | Structured shutdown marker and leaf-bound partial-output continuation | Upstream reduces duplicated or misapplied continuation |
| Repeated compact | Recursive summary of latest active root | Recursive summary, but with recent exact groups retained | Both remain lossy; upstream degrades more slowly |
| Old raw history | Archival parent linkage; no equivalent upstream physical-prune behavior established in Cat | Physical pruning above 5 MiB; 2.1.224 live fullscreen keeps old intervals | Upstream bounds resources but sacrifices durable full raw history |
| Precomputation | No equivalent persisted summary sidecar in normal path | Experiment-gated `.precompact.json` | Upstream can reduce compact latency; not required for correctness |
| 1M policy | Cat model-specific windows and scaled threshold | Native/configured/entitled window distinctions; 200K clamp | Upstream handles entitlement drift more explicitly |
| Unknown models | 200K fallback and hard blocking | Assumed-window enforcement with source/provenance | Similar safe default; upstream policy provenance is clearer |
| Remote progress | Producer callback and boundary persistence confirmed | 2.1.224 forwards coarse status/boundary/reset; raw detail still filtered | Upstream’s distributed clients converge more reliably |
| `/clear` | New session; substantial reset; preserves eligible background tasks | New conversation plus shared remote reset event | Core semantics align; propagation differs |
| Prompt cache | Prefix-sharing summary fork; Codex session key; full resend after compact | Prefix-sharing summary fork; local cache reset | Broadly aligned |

### 7.1 Normal coding sessions

For ordinary sessions that compact once near the end of a task, Cat’s existing summary plus regenerated attachments is often adequate. The main visible difference is that upstream retains exact recent turns and can recover transparently from prompt-too-long in the same request.

### 7.2 Very long or always-on sessions

The differences compound:

- Recursive full summaries progressively erase detail.
- Background workers can outlive the conversational evidence that created them.
- Interrupted turns and reconnects become routine rather than exceptional.
- Remote clients can attach during a compact/reset transition.
- Transcript size and reconstruction cost become first-order concerns.
- Entitlement and model-window state can change while the session remains alive.

For this target, Cat’s current default path is not sufficient merely because it has a good prompt. The active-context, durable-state, and archival-history planes need clearer separation.

## 8. Answers to the key architectural questions

### Has the core architecture changed?

Yes, but incrementally. Boundary-plus-summary remains. The meaningful redesign is reactive prefix selection, verbatim recent-group preservation, and same-turn retry. Persistent agent sessions and Remote Control synchronization evolved alongside compaction rather than inside the summary generator.

### What triggers automatic compaction now?

Upstream uses configured/model-derived thresholds, prompt-too-long errors, eligible media failures, and 1M entitlement clamps. Cat normally uses its scaled token threshold and optional recovery gates.

### What is preserved?

Both preserve a generated summary, boundary metadata, regenerated dynamic state, and independent session metadata. Upstream additionally preserves selected recent message groups by explicit UUID. Cat’s normal full path does not.

### What is discarded?

Cat discards all preboundary exact content from active context during normal full compaction. Upstream discards the summarized prefix from active context but keeps a recent suffix. Upstream may also physically remove old JSONL intervals after 5 MiB.

### Did the summary format or prompt change?

Yes, including security-sensitive wording around 2.1.139, but the current Cat and upstream prompts are broadly similar. Prompt changes are not the primary architectural difference.

### Does state survive outside the summary?

Yes. Files, plans, tools, hooks, tasks, agent transcripts, file history, attribution, modes, worktree state, and remote metadata have independent owners. The exact set and persistence guarantees differ.

### How are tools and results handled?

Cat summarizes old calls/results in its normal path and regenerates tool availability. Upstream preserves complete recent API groups and tool/result relationships while summarizing older groups. Both retain deferred-tool discovery outside prose.

### How are agents/subagents handled?

Subagents have separate transcripts and can compact independently. Live task/agent state is not serialized solely into summary prose. Upstream has mature process-restart classification; Cat has its own task and Agent Mode persistence, including a currently mismatched compaction formatter.

### How are interrupted turns handled?

Cat repairs transcript validity and can synthesize a generic continuation. Upstream persists more structured interruption identity and can attach exact partial output only when its boundary UUID matches the resumed leaf.

### How does repeated compaction behave?

Both recurse from the newest boundary rather than rereading every original message. Upstream’s preserved suffix slows information loss; neither avoids recursive summary degradation entirely.

### Can modern upstream access pre-compaction history?

Sometimes. The continuation summary includes the transcript path, and small/uncompacted files may retain old rows. Large files can be physically pruned. Upstream 2.1.224’s fullscreen fix preserves live UI intervals, not a durable all-history guarantee.

### What is the boundary for?

It is an active-context root, persistence seam, relinking anchor, lineage pointer, token-accounting record, remote event, and UI marker. It is more than a visual separator.

### How does `/resume` work after compaction?

It loads transcript records, applies boundary/preserved-message relinking, selects the active leaf, restores independent metadata/state, normalizes interrupted turns, and continues from the compact summary plus retained suffix.

### How does `/clear` differ?

`/clear` creates a new conversation/session identity and empty active context. Compaction preserves identity and creates continuation context. The old cleared session remains separately resumable.

### How do 1M models work?

A model can have a native 1M window while the effective allowed window is smaller. Upstream can clamp to 200K after entitlement failure or disable policy, then compact to fit. Cat currently resolves model-specific windows and can disable 1M paths, but its entitlement/effective-window policy is less explicit.

### How are unknown models handled?

Both default conservatively to 200K unless configured otherwise. Upstream now treats that assumption as an enforced autocompact window rather than merely a display estimate.

### Did prompt-cache behavior change?

The modern compaction fork reuses an existing prefix where possible and avoids writing a normal summary-fork transcript/cache entry. After compaction, the main request prefix changes. Cat’s Anthropic and Codex paths already implement equivalent high-level behavior.

## 9. Interesting non-changelog findings

1. **The modern manual `/compact` is reactive.** The old full compactor still exists, which can make string-based reverse engineering falsely conclude it is primary.
2. **`preservedMessages` is executable resume topology.** It is consumed to rewrite parent links, not merely emitted for diagnostics.
3. **`allUuids` and `uuids` have different durability.** In-process continuity can include nonloggable messages that cannot be recovered after process loss.
4. **The precompute sidecar is bounded and validated persistent state.** It is not just an in-memory speculative summary.
5. **The 1M-to-200K path is a session state transition.** A provider entitlement error latches a smaller effective window and feeds reactive target sizing.
6. **Remote “progress” is coarse.** Upstream 2.1.224 forwards compacting status but still filters raw detailed progress events.
7. **The 2.1.224 full-history claim is a live reducer repair.** It does not change the large-transcript loader into a full archival loader.
8. **Large upstream transcripts are physically reduced.** Append-oriented logical history does not imply permanent raw-history retention.
9. **Remote stale-session repair keys off transcript identity.** Resume/compaction mismatch suppresses reattach and lets the stale remote session archive.
10. **Cat’s Agent Mode state exists outside prose but is passed to the compact formatter incorrectly.** Durable state alone is not sufficient if reinjection is wired to the wrong shape.
11. **Cat’s source is not an upstream 2.1.87 snapshot.** Several modern ideas are already present, and squashed history prevents precise provenance for every one.

## 10. Recommendation for Cat Code

### 10.1 Adopt now: reactive prefix compaction

Replace the normal automatic and manual full-compaction choice with a Cat-native reactive path that:

1. Groups complete logical API rounds.
2. Preserves at least the latest complete group.
3. Expands the preserved suffix when the summary request is itself too large.
4. Keeps tool-use/result and incomplete-thinking invariants intact.
5. Retries the interrupted main request in the same turn.
6. Retains full compaction only as a fallback.

**Expected benefit:** exact current intent, tool trajectory, permission context, and partial work survive. Recursive summary degradation slows substantially. Prompt-too-long becomes recoverable rather than user-visible.

This is the highest-value upstream concept to adapt.

### 10.2 Adopt now: explicit preserved-message metadata

Evolve Cat’s `preservedSegment` into an additive explicit structure equivalent in concept to:

```text
{
  anchorUuid,
  durableUuids,
  liveUuids
}
```

Keep legacy segment reading for existing transcripts, but write explicit lists for new compactions.

**Expected benefit:** reliable relinking for non-linear, virtual, or nonloggable messages; clearer process-loss semantics; better corruption diagnostics.

### 10.3 Fix now: Agent Mode compaction state wiring — DONE (`b723ac7b`, see §15.3)

Pass the durable `AgentModeSessionState` under the formatter’s `sessionState` field, or build the full expected compact-state object from the real Agent Mode owners. Add an integration test that calls `readSessionState()` and then the real compact-summary formatter.

**Expected benefit:** worker identity, phase, and next action remain authoritative after compaction instead of becoming `undefined` prose.

### 10.4 Adopt now: structured interrupted-turn continuation

Persist a partial-turn record tied to:

- session ID,
- active transcript leaf/boundary UUID,
- interrupted assistant/tool message ID,
- exact partial output,
- interruption reason.

Use it only when the resumed leaf still matches. Otherwise discard it safely.

**Expected benefit:** unattended and remote sessions continue without repeating output or applying stale partial text to a different history branch.

### 10.5 Adapt differently: durable hot/cold history

Do not copy upstream’s 5 MiB physical history pruning as Cat’s always-on design. Separate:

- **Hot active transcript:** latest boundary, retained suffix, active metadata.
- **Cold immutable archive:** every original message interval, checksummed and indexed.
- **Compaction ledger:** summary ID, covered archive ranges, parent summary, preserved UUIDs, model/prompt version, token counts.

The model should access cold history through bounded search/retrieval rather than being instructed to read a multi-gigabyte JSONL file.

**Expected benefit:** bounded resume cost without sacrificing forensic history or long-term personal-agent memory.

This is the largest always-on-specific redesign. Upstream’s current client does not solve it.

### 10.6 Adapt: explicit context-window policy

Represent separately:

- advertised/native window,
- provider-entitled window,
- configured autocompact window,
- effective session window,
- provenance/reason for each clamp.

Retain Cat’s scaled reserve rather than copying upstream’s fixed 13K buffer. Add the upstream idea of reacting to entitlement errors by shrinking the effective session window and compacting to fit.

**Expected benefit:** stable behavior across 1M entitlement changes, unknown models, custom providers, and always-on sessions that outlive configuration updates.

### 10.7 Adopt selectively: remote generation/state propagation

Ensure every remotely attached Cat client receives, in order:

1. Compaction started/status.
2. New compact boundary and metadata.
3. New active transcript generation.
4. Compaction completed or failed.
5. `/clear` with the new conversation ID.

Use a generation/sequence value so a reconnect cannot combine a precompact transcript with postcompact status. Archive stale remote attachments when transcript identity changes.

**Expected benefit:** attached, disconnected, and reconnecting clients converge on one active context generation.

Do not copy Anthropic-specific endpoints, worker epochs, or server lease policy. Reimplement the state-machine concept in Cat’s own bridge/desktop transport.

### 10.8 Defer: background precomputation

The validated `.precompact.json` concept is useful if compaction latency becomes a measured problem, especially during unattended idle periods. It does not improve correctness and consumes model usage before compaction is certain.

Defer it until reactive compaction, archive separation, and structured state are correct. If later adopted, bind it to transcript generation, model, prompt version, expiry, and preserved UUIDs as upstream does.

### 10.9 Do not copy

Do not copy:

- Upstream’s physical deletion policy for old transcript intervals.
- Fixed 13K threshold buffering in place of Cat’s scaled reserve.
- Anthropic server-specific Remote Control endpoints or lease semantics.
- Prompt-only changes as a substitute for structured state.
- `allUuids`-style in-process continuity without explicitly documenting that it is not crash durable.

## 11. Recommended sequencing

1. ~~Fix Agent Mode compact-state integration and add a live-path test.~~ DONE (`b723ac7b`, §15.3).
2. Add explicit preserved-message metadata while retaining legacy read compatibility.
3. Implement reactive prefix selection and same-turn retry behind a Cat feature gate.
4. Make manual `/compact` use reactive behavior, retaining full compact as fallback.
5. Persist structured interrupted-turn continuation tied to the active leaf.
6. Add context-window provenance and dynamic effective-window clamps.
7. Define compaction-generation events for local, desktop, and remote clients.
   Designed 2026-08-16: `docs/plans/2026-08-16-compaction-generation-events-design.md`.
8. Design hot active transcript plus cold immutable archive before adding any physical pruning.
   Designed 2026-08-16: `docs/plans/2026-08-16-compaction-hot-cold-history-design.md`.
9. Consider precomputation only after latency evidence justifies its usage cost.

## 12. Final verdict

Cat Code does **not** need a wholesale compaction rewrite or an upstream code transplant. Its existing boundary graph, cache-sharing summary fork, state regeneration, subagent sidechains, and model-aware thresholding are strong foundations.

It does need a substantial change to the **default compaction policy**: full replacement should become fallback behavior, while reactive older-prefix summarization with an exact recent suffix becomes normal. For an always-on personal agent, that should be paired with structured worker/interruption state and a durable cold-history archive that upstream itself does not currently provide.

The practical recommendation is therefore:

> Targeted architectural backports for active-context quality, plus a Cat-specific archival design for long-term continuity.

## 13. Uncertainties and limits

- No authenticated compaction request was run, so provider-side token accounting and cache retention were not runtime measured.
- Upstream server retention before/after compaction is opaque. Client event fields do not prove backend retention duration.
- Mobile, web, and VS Code consumer rendering was not present in the inspected native CLI bundle.
- Upstream precomputation is experiment-gated; static code proves capability, not account enablement.
- Cat’s squashed initial history prevents exact provenance classification for every inherited-looking function.
- 2.1.225 and 2.1.226 artifacts were downloaded but not reverse engineered after research was stopped. This report’s fully inspected upstream endpoint is 2.1.224, with installed 2.1.223 used for the deep baseline.
- The Cat Agent Mode formatter mismatch is source-confirmed, but no live compaction was run to capture its rendered output.

## 14. Verification

```text
VERIFICATION
- git diff --check
  passed (exit 0)
- git diff --no-index --check -- /dev/null docs/reports/2026-08-09-claude-code-compaction-evolution.md
  passed; exit 1 from no-index content difference was normalized only after --check reported no defects
- bun run maps:lint
  passed: 18 maps, 8 pre-existing recommended-section warnings
- cited repository path audit
  passed: all 25 cited src/, scripts/, and docs/ paths exist
- stale-reference sweep
  N/A: this investigation adds no rename, removal, import, configuration key, or runtime interface
- code tests/builds
  not run: report-only change; no runtime source was modified
```

## 15. Post-publication verification (2026-08-12)

Four independent read-only audits re-derived every CAT-SOURCE claim in §4
against the working tree at `b8f679f5`, split by owner file so no two audits
shared a source. Verdicts were CONFIRMED / WRONG / PARTIALLY-WRONG /
UNVERIFIABLE, each requiring `file:line` plus quoted code.

**The report's architecture survives.** The central premise (§4.6, traditional
compaction keeps zero verbatim messages) is CONFIRMED from three independent
angles: the success return at `compact.ts:775-785` carries no `messagesToKeep`
key; `query.ts:578-585` replaces rather than appends; and
`annotateBoundaryWithPreservedSegment` no-ops on an empty keep set and is never
called by the full path. §4.3's derived threshold table was recomputed from
source constants and every cell matches. The §10-11 recommendations stand.

Ten claims are wrong or imprecise. Two would misdirect an implementer.

The audits were split by owner file, which created one blind spot: a claim
spanning two files can be judged against only one of them. §4.2's usage claim
was initially graded WRONG on `tokens.ts` alone, when the mechanism it names
lives in `sessionStorage.ts`. Both halves are recorded below. Treat any
single-lane verdict on a cross-file claim as provisional.

### 15.1 Corrections that change an implementation decision

| § | Claim as written | Source |
|---|---|---|
| 4.4 | The summary fork has "no tools" | **WRONG.** The fork sends the parent's ENTIRE tool set, which is mandatory for the cache-key match (`prompt.ts:42-44`, `compact.ts:1238-1241`). Only tool *execution* is blocked (`createCompactCanUseTool`, `compact.ts:1181-1190`). The streaming fallback sends `FileReadTool`, plus tool-search and MCP tools when enabled (`compact.ts:1337-1346`). Dropping tools to shrink the request would destroy the prompt-cache reuse of §4.16. |
| 4.2 | Preserved messages "can have stale usage zeroed during relinking" | **CONFIRMED**, and there are two distinct mechanisms, both load-bearing for §10.2. On **resume**, `applyPreservedSegmentRelinks` zeroes `input_tokens`/`output_tokens`/`cache_*` on preserved assistant messages in the loaded map (`sessionStorage.ts:2611-2627`) — without it, resume triggers an immediate autocompact spiral. During a **live session** nothing is mutated; the usage walk instead *skips* preserved messages, which keep their original usage (`tokens.ts:106-109,435-438`). An explicit preserved-UUID list must drive both. |
| 4.16 | "`/clear` creates a new UUID", implying a new Codex cache key | **WRONG, and a live defect.** `regenerateSessionId()` (`bootstrap/state.ts:460-477`) never emits `sessionSwitched`, so the rebind at `setup.ts:95-97` never fires, and `resetCodexCacheContext()` is not called from the clear path. After `/clear` the pre-clear `prompt_cache_key` is reused for the life of the process. See §15.4. |

### 15.2 Precision corrections

| § | Correction |
|---|---|
| 4.3 | `effectiveContext` subtracts the model's **default** max-output, not its maximum (`autoCompact.ts:42-58`), and that default is capped to 8,000 when growthbook `tengu_otk_slot_v1` is on (`claude.ts:3726-3742`), which shifts the whole table (200,000 becomes effective 192,000 / autocompact 173,640 / blocking 189,000). `CLAUDE_CODE_AUTO_COMPACT_WINDOW` also clamps the nominal window first. The table is correct under stock defaults only. |
| 4.3 | The resolution order has **nine** steps, not eight: an ant-only `resolveAntModel(model).contextWindow` lookup sits between the `gpt-` branch and the 200,000 fallback (`context.ts:129-134`). Every 1M path is nullified by `CLAUDE_CODE_DISABLE_1M_CONTEXT`. |
| 4.4 | The fallback output cap is `min(20,000, model max)` (`compact.ts:1394-1397`), not a flat 20,000. |
| 4.6 | **PostCompact hook output never enters model context.** `executePostCompactHooks` returns only `{ userDisplayMessage?: string }` (`hooks.ts:4041-4043`). Only SessionStart output becomes `hookResults` (`compact.ts:619-623`). A design relying on PostCompact hooks to reinject state would silently do nothing. |
| 4.7 | The attachment filter is **total, not partial**: for non-ant users `isLoggableMessage` (`sessionStorage.ts:5413-5429`) drops every attachment message, with one exception for `hook_additional_context` behind `CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT`. Cited range `5208-5320` is wrong. |
| 4.11 | Omission: the post-compact summary **already instructs the model** to read the full transcript at `transcriptPath` for pre-compaction detail (`prompt.ts:837-839`). §10.5 therefore replaces an existing naive escape hatch rather than adding a missing capability. |
| 4.12 | "Malformed/empty assistants" is specifically *whitespace-only-text* assistants (`conversationRecovery.ts:209-211`). The `Continue from where you left off.` trigger is broader than an interrupted tool trajectory: `interrupted_turn` also fires on a trailing attachment (`:342-345`). |
| 4.15 | The "provider-cache eviction hint" is only an analytics event, `logEvent('tengu_cache_eviction_hint', …)` (`clear/conversation.ts:78-86`). No request field or provider call exists. |
| 4.16 | `prompt_cache_key` is not the session UUID; it is a UUIDv5-shaped `sha256(sessionUUID ‖ "\0" ‖ accountId:model)` (`codex-fetch-adapter.ts:183-193`), so it is per-account and per-model and already rotates when either changes. The in-file comment at `:3309-3312` asserts otherwise and is stale. |

### 15.3 §4.13 Agent Mode mismatch: confirmed, larger than described, now fixed

Parts (a), (b), (c) and (e) CONFIRMED, corroborated by two `TS2345` errors
already sitting in the known-red baseline at `compact.ts:654` and `:1088`.

Part (d) was PARTIALLY-WRONG in a way that changed the fix. Executing the real
formatter against a narrow object shows it does not throw, and only
`approvalStatus` renders the literal `undefined` (the sole interpolation without
a `??` fallback). The material harm is the other half: `state.sessionState` is
`undefined`, so `formatAgentModeSessionState` never runs and **the worker roster
and active worker are silently dropped**. A fix scoped to "stop rendering
undefined" would have missed the actual defect.

Blast radius was three paths, not the one described: manual/partial compaction
repeats it (`compact.ts:848-849`, `:1088`), and session-memory compaction
dropped Agent Mode state entirely, reading it into a dead local
(`sessionMemoryCompact.ts:559`) while both callers passed `null`.

**Fixed in `b723ac7b`.** `toAgentModeCompactState()` is now the single supported
widening path and is used on all three paths; `AgentModeCompactState` became a
union so `AgentModeSessionState` is assignable to neither member (the two phase
unions are identical, so an all-optional shape would have re-admitted the
defect); the run-state block is emitted only when a caller supplies run fields.
`prompt.test.ts` now drives the real `readSessionState()` into the real
formatter without a cast. Recommendation §10.3 is closed.

### 15.4 New open item, not in the original report

`/clear` does not reset the Codex prompt-cache key (§15.1). The Anthropic path
signals cache eviction on clear while the Codex path silently does not, which
looks unintended rather than designed. Not fixed: confirm intent first. A fix
would rebind in `clearConversation`, either by emitting `sessionSwitched` from
`regenerateSessionId` or by calling `resetCodexCacheContext()` directly.

**Resolved 2026-08-16, treated as a defect.** `regenerateSessionId` now emits
`sessionSwitched` (`bootstrap/state.ts`), which reaches both existing
subscribers. Two corrections to the paragraph above. First, the same missing
emit also left the PID file's sessionId stale after `/clear`, so `claude ps`
read the pre-clear transcript (`utils/concurrentSessions.ts:101`); one emit
fixes both, which is why it was preferred over calling the setter directly.
Second, the emit alone would have been cosmetic: `conversationIdsByCacheKey`
memoizes the derived `conversation_id` per `accountId:model` and nothing
invalidated it, so `setCodexPromptCacheKey` now clears it when the key changes
(`services/api/codex-fetch-adapter.ts`). That also makes the pre-existing
`--resume` rebind at `setup.ts:95` real for a mid-session `/resume`, which it
was not. Covered by `services/api/providerSessionIdentity.test.ts`.

### 15.5 Line-citation drift

Substance verified at the current lines; the cites below are stale. All `§4.13`,
`compact.ts` and `prompt.ts` cites in §4.4-§4.6 were exact.

| § | As cited | Current |
|---|---|---|
| 4.2 | `tokens.ts:296-397` | `403-516` |
| 4.7 | `sessionStorage.ts:5208-5320` | `5413-5429` |
| 4.8 | `sessionStorage.ts:1442-1532` | `1605-1660` |
| 4.8 | `sessionStorage.ts:2685-2731,4574-4616` | `2854-2894`, `4630-4634`, `4775` |
| 4.9 | `sessionStorage.ts:2348-2481` | `2527-2644` |
| 4.11 | `messages.ts:4794-4845` | `4832-4845` |
| 4.14 | `sessionStorage.ts:1577-1812` | `1928` |
| 4.14 | `sessionStorage.ts:2112-2235` | `2320` |
| 4.16 | `codex-fetch-adapter.ts:3289-3302` | `3314-3321` |
| 4.16 | `codex-websocket-transport.ts:669-759,944-1050` | `764-…`, `1049-1075` |

### 15.6 One §4.1 distinction worth keeping

All three of `REACTIVE_COMPACT`, `CONTEXT_COLLAPSE` and `HISTORY_SNIP` were
absent from the build lists (`scripts/build.ts`), as stated. They were not in
the same state on disk, and the difference is not the one an earlier revision of
this section claimed. Verified by reading the modules, not just checking that
files exist:

- `REACTIVE_COMPACT`: no module. `autoCompact.ts` records why
  (`REACTIVE_COMPACT is ant-only`). **Implemented in `4980de08`** and added to
  the dev-full build list; `defaultFeatures` is still untouched, so this is not
  default-on.
- `CONTEXT_COLLAPSE`: `src/services/contextCollapse/` is a **stub**, not a
  complete implementation. `index.ts` is 67 lines whose
  `isContextCollapseEnabled()` returns a literal `false`, and `operations.ts`
  and `persist.ts` are 3 and 4 lines. Compiling it in would do nothing.
  `docs/maps/query-provider-runtime.md` already stated this correctly.
- `HISTORY_SNIP`: `snipCompact.ts` / `snipProjection.ts` are real
  implementations, uncompiled.

The correction matters beyond bookkeeping: "the file exists" is not evidence
that a feature is implemented, and treating it as such is how a build-list edit
gets mistaken for shippable work.
