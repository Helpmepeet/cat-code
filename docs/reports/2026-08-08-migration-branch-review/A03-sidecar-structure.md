# A03 — sidecar server structure and quality

## Verdict

The security posture of this boundary is genuinely careful and the per-verb reasoning is
documented better than almost any code in the repo. The problem is structural: `sidecarServer.ts`
is a 4,262-line class that owns transport, framing, rate limiting, an idle janitor, inbound
routing, 11 verb handlers, 14 outbound snapshot fan-outs, the turn lifecycle, an engine
command-queue drain, the park gate, the entire permission/AskUserQuestion validation surface,
a context-breakdown cache, and 12 Zod schemas. Roughly 1,900 of those lines have an already-existing
or trivially-creatable home elsewhere, and the duplication is no longer cosmetic: the same
snapshot body is copy-pasted ten times with three different null protocols, and the queue drain
is a divergent hand-roll of `src/utils/queueProcessor.ts`, which is already React-free and
importable. The single most important thing to fix is the connection-lifetime invariant: a
connection removed at the trust boundary is not made inert, so frames arriving on that socket
afterwards are still validated and executed, including an `app.submit` that starts a real,
billed engine turn whose output goes nowhere.

`index.ts`, `initializeRuntime.ts`, `probeAdapter.ts`, and `engineTypeDriftCheck.ts` are clean and
appropriately small. `engineTypeDriftCheck.ts` in particular is an excellent pattern.

## Findings

### [HIGH] A removed connection is not inert: it can still drive the engine

- **Where**: `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:3370-3379` and `:778-802`; `/Users/pt/cat-code/app/sidecar/index.ts:330-335`
- **Type**: correctness
- **What**: `removeConnection` only does `this.connections.delete(connection)`. Nothing marks the
  `Connection` object as dead, and `handleData` never checks membership. The transport in `index.ts`
  keeps its `socketState` entry until Bun fires `close`, and feeds every subsequent chunk to
  `server.handleData(state.connection, …)`.
- **Trigger / why it matters**: two reachable paths.
  1. `send()` catches a socket write failure and calls `this.removeConnection(connection)` without
     ever calling `connection.socket.end()` (line 3378). The socket therefore never closes, `close`
     never fires, `socketState` is never cleaned, and the connection is a permanent zombie: it is
     out of `this.connections` so `broadcastEvent` early-returns at line 2553, but `handleData` still
     routes its frames. A user prompt on that socket reaches `handleSubmit` → `startTurn` →
     `controller.submit()`. A real model turn runs, tokens are billed, and not one event is
     delivered anywhere.
  2. The framing-error path (line 781-787) calls `removeConnection` then `connection.socket.end()`,
     but that `end()` is the backpressured wrapper's, which *defers* the real close while bytes are
     queued (`backpressuredSocket.ts:78-86`). Any chunk delivered in that window takes the same route.
- **Fix**: add `closed: boolean` to the `Connection` type, set it in `removeConnection`, and make
  `handleData` return immediately when set. Also call `connection.socket.end()` on the `send()`
  write-failure path so the transport actually tears the socket down.

### [HIGH] God file: 4,262 lines, ~8 unrelated responsibilities, ~1,900 lines with an existing home

- **Where**: `/Users/pt/cat-code/app/sidecar/sidecarServer.ts` (whole file)
- **Type**: design
- **What**: one class holds transport + routing + turn lifecycle + queue drain + park policy +
  permission validation + 14 snapshot fan-outs + the wire schemas. The band structure is:

  | Lines | Responsibility |
  |---|---|
  | 540-830, 3326-3417 | connection registry, framing, rate limiting, idle-TTL janitor, outbound `send`/`sendError` |
  | 836-1076 | inbound frame routing |
  | 1078-1372 | turn lifecycle + engine command-queue boundary drain |
  | 1374-1629 | submit gates + IDLE-PARK gate/latch |
  | 1631-2283 | 8 verb handlers (account, workspace, agent-mode, task-control, run-control, session-action, remoteSettings, settings) |
  | 2285-2516 | permission response + AskUserQuestion answer boundary |
  | 2518-3325 | ~700 lines of snapshot senders/broadcasters |
  | 3420-4262 | 12 Zod schemas, `checkStrictKeys`, and 9 pure validator/projection helpers |

- **Trigger / why it matters**: the cost is already being paid. The snapshot band is ten byte-identical
  bodies (see the next finding), the routing band is an eleven-branch `if` chain with two different
  matching idioms, and the schema band duplicates vocabulary that `protocol.ts` already declares.
  Every new seam adds ~120 lines to a file no one can hold in their head, and the review surface for
  a security-critical boundary is diluted by 700 lines of snapshot boilerplate.
- **Fix**: four extractions, none of which touch a locked decision:
  1. **Snapshot fan-out → a table** (~700 lines → ~80). Every read-seam domain already exposes
     `getSnapshot(): T | null`. Replace the ten `sendXSnapshot`/`broadcastX` pairs with one registry
     of `{ domain, kind, payloadKey }` and two generic methods. The four that genuinely differ
     (agentMode is async, threadGoal deliberately sends `null`, contextBreakdown is coalesced,
     oauth progress is push-driven) stay hand-written.
  2. **Permission boundary → `app/sidecar/permissionBoundary.ts`** (~450 lines):
     `buildPermissionContextSnapshot`, `buildRuleMetadata`, `cloneRulesBySource`,
     `validateSuggestionSelection`, `sanitizePermissionResponse`, `extractGatedToolInput`,
     `narrowGatedQuestions`, `reconstructAskUserQuestionAnswers`, `deepEqual`. These are pure
     functions over engine objects with zero transport dependency other than `sendError`, which
     can be inverted to a result union. Note this is a *sibling* of `permissionDomain.ts`, not an
     addition to it — that module's header (`permissionDomain.ts:13-14`) deliberately pins
     "ZERO transport knowledge", and these validators respect that too.
  3. **Inbound schemas → `app/sidecar/inboundSchemas.ts`** (~470 lines): the 12 Zod schemas plus
     `checkStrictKeys`, with the per-type key allowlist derived from the `*_VERB_TYPES` constants
     in `protocol.ts` rather than hand-copied.
  4. **Context-breakdown coalescing → `contextBreakdownDomain.ts`**: the four private fields at
     lines 342-349 (`contextBreakdownInFlight`, `Pending`, `ComputedAt`, `Last`) plus
     `broadcastContextBreakdown`'s coalescing loop are *domain* policy about how often an expensive
     analysis may run. `createSidecarContextBreakdownDomain` (196-line module, 20-line factory) is
     currently a bare `try/catch → null` passthrough and is the natural owner.

### [MED] The queue drain re-implements `src/utils/queueProcessor.ts`, divergently

- **Where**: `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:1107-1247` and `:3432-3447`; engine original at `/Users/pt/cat-code/src/utils/queueProcessor.ts:52-80`
- **Type**: design (named recurring mistake #10)
- **What**: `scheduleBoundaryDrain` / `drainOneQueuedPrompt` / `drainOneTaskNotification` /
  `isDeliverableParentPrompt` / `isDeliverableParentTaskNotification` hand-roll the between-turn
  drain. The engine's `processQueueIfReady` already does exactly this and is **React-free** — only
  its caller `src/hooks/useQueueProcessor.ts:59` is React-bound. `rg` confirms nothing in `app/`
  imports it.
- **Trigger / why it matters**: the hand-roll is not equivalent. `processQueueIfReady` drains **all
  same-mode main-thread commands at once** via `dequeueAllMatching` and hands them to one
  `executeInput([a,b,c])` call; the sidecar's `drainOneQueuedPrompt` dequeues exactly one and starts
  a turn, whose finalizer schedules the next drain. Concrete divergence: the user types three
  prompts during a turn and the turn ends without a tool round. Terminal: one turn carrying three
  user messages. Desktop: three sequential turns, three round trips, three times the prefill. The
  code even acknowledges the resulting ordering wobble at lines 1179-1184 ("with several queued
  prompts a refused one loses its place") — a symptom the engine's version does not have.
- **Fix**: call `processQueueIfReady({ executeInput })` with an `executeInput` that maps the command
  array onto one `startTurn`, and delete the two local predicates in favour of the engine's
  `isMainThread` rule. Keep the sidecar-specific reservation/latch logic on top.

### [MED] `dispatch` has no `never` tripwire, and the inbound vocabulary lives in four unsynchronised places

- **Where**: `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:1035-1076`; allowlist at `:3487-3552`; routing chain at `:879-1015`; schemas at `:3620-3941`
- **Type**: convention / design
- **What**: the `switch (message.type)` over `AppClientMessage` has four cases and no
  `default: const _never: never = message` guard, in a repo whose convention explicitly requires one.
  Separately, the same vocabulary is declared four times with no cross-check: the
  `*_VERB_TYPES` arrays in `protocol.ts`, the hand-written `allowedByType` map in `checkStrictKeys`,
  the routing chain (which mixes `startsWith('account.')`-style prefixes with
  `RUN_CONTROL_VERB_TYPES.includes(...)`-style membership for no stated reason), and the per-verb
  Zod schemas.
- **Trigger / why it matters**: `appClientMessageSchema` is **engine-owned and shared with the WS
  server** (`src/web/appSessionProtocol.ts:43-48`). A fifth member added there plus a matching
  `allowedByType` entry compiles clean and produces a frame that passes strict-key checking, passes
  the Zod parse, reaches `dispatch`, matches no case, and falls out of the function — no effect, no
  error frame, no ack. The renderer's `requestId` is never answered and its in-flight guard never
  clears. The tripwire is the one thing that would have made this a compile error.
- **Fix**: add the `never` default to `dispatch`. Derive `allowedByType`'s keys from the exported
  `*_VERB_TYPES` constants so the allowlist cannot silently disagree with `protocol.ts`, and use one
  matching idiom (membership) for every family.

### [MED] The context-breakdown freshness floor is bypassed on exactly the expensive path

- **Where**: `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:3003-3008` and `:3043-3052`
- **Type**: correctness
- **What**: the floor gate is `if (this.contextBreakdownLast && age < CONTEXT_BREAKDOWN_MIN_INTERVAL_MS)`.
  Both `contextBreakdownLast` and `contextBreakdownComputedAt` are assigned only inside
  `if (!raw) return`'s success branch (lines 3044-3048), so a null result updates neither.
- **Trigger / why it matters**: `createSidecarContextBreakdownDomain` returns `null` on **any** thrown
  error (`contextBreakdownDomain.ts:188-191`). So whenever the analysis is failing, `contextBreakdownLast`
  stays null forever and every single `context-breakdown.request` runs a full analysis with no rate
  limit at all. Per this file's own comment at lines 458-468, a failing analysis is the *expensive*
  case: `analyzeContextUsage` fans out to ~10 `countTokens` calls, and on failure falls back to
  **Haiku sampling**. Open and close the popover ten times on a session where the analysis fails and
  you pay ten uncapped fan-outs — the precise spend the floor was written to bound.
- **Fix**: stamp `contextBreakdownComputedAt = Date.now()` regardless of the result, and gate on the
  timestamp rather than on `contextBreakdownLast` being non-null (send the last snapshot only if one
  exists).

### [MED] Every `bad_request` rejection is invisible to the user

- **Where**: `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:3391-3407` (~40 call sites); consumer at `/Users/pt/cat-code/app/renderer/src/connectionState.ts:261-272`
- **Type**: correctness
- **What**: `sendError` is the sidecar's only feedback channel for a rejected submit. The renderer's
  only handler for `kind: 'error'` maps three connection-status codes and returns state unchanged for
  everything else; `rg` finds no other consumer of an error frame's `message` outside
  `rawMessageLog.ts` (a developer inspector).
- **Trigger / why it matters**: the user pastes a prompt over `MAX_PROMPT_BYTES` (96 KiB), or sends
  a 33rd message while `MAX_QUEUED_PROMPTS` (32) are already queued. The sidecar rejects with
  `bad_request` and prose that was clearly written to be read — "Too many messages are already
  waiting for this response." (line 1486). The renderer drops the frame. The prompt has left the
  composer, no user message was broadcast (the reject returns *before* `enqueueMidTurnPrompt`), and
  nothing appears. From the user's seat the message simply vanished.
- **Fix**: the ultimate fix is renderer-side, but flag it here because it makes ~40 `sendError` call
  sites in this file dead prose. Either surface `bad_request`/`unauthorized`/`internal_error` message
  text in the renderer, or stop writing user-facing sentences into a frame the app discards.

### [MED] History replay traverses each restored message six times, per connection, on the hot attach path

- **Where**: `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:709-765`
- **Type**: quality (performance)
- **What**: for every restored message, `sendHistoryReplay` runs `prepareOutboundPayload`
  (`structuredClone` + `omitUndefinedObjectProperties` + `checkJsonSafe` = three walks), then
  `JSON.stringify(frame)` purely to measure bytes, then `send()` runs `scanForSecrets` (a fourth
  walk) and `encodeFrame` (a second `JSON.stringify`). Six full traversals per message. It is called
  from `addConnection`, so the whole computation is redone from scratch on every attach even though
  `this.history` is `readonly` and fixed at construction.
- **Trigger / why it matters**: the caps are `MAX_HISTORY_REPLAY_FRAMES = 4_000` and
  `MAX_HISTORY_REPLAY_BYTES = 4 MiB` (`app/shared/limits.ts:141-142`). Restoring a large session
  therefore does ~24 MiB of synchronous traversal on the event loop before a single byte leaves,
  blocking the idle timer, the queue drain, and every other connection. A renderer reload pays it again.
- **Fix**: compute the retained `ServerFrame[]` and the truncation flag once, lazily, and memoise
  them on the instance; reuse `encodeFrame`'s output length instead of a separate `JSON.stringify`
  for sizing.

### [MED] Ten byte-identical snapshot senders, three different null protocols

- **Where**: `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:2634-2660, 2667-2693, 2702-2728, 2773-2799, 2896-2922, 3098-3124, 3208-3234, 3241-3267, 3275-3301` (senders) and `:2760-2767, 2801-2808, 2840-2847, 2924-2931, 2965-2972, 3126-3133, 3194-3201, 3303-3310, 3317-3324` (broadcasters)
- **Type**: quality (duplication)
- **What**: nine senders are the same eight statements with three identifiers changed, and nine
  broadcasters are the same three statements. The copies have already drifted into three different
  null contracts: most do `if (!raw) return` then `if (!snapshot) return`;
  `sendThreadGoalSnapshot` (line 2742) deliberately distinguishes a real `null` snapshot from a
  clone failure with `if (snapshot === null && raw !== null) return`; `sendTasksSnapshot` (line 2820)
  and `sendRunControlsSnapshot` (line 2945) skip the `raw` guard entirely and rely on
  `if (!snapshot) return`, which conflates "the domain has nothing" with "the clone or JSON-safety
  check failed".
- **Trigger / why it matters**: no live bug today (the two guardless ones return objects/arrays,
  which are truthy), but the third variant means a domain whose snapshot legitimately becomes
  falsy would be silently indistinguishable from a serialisation failure, and the log line would
  say nothing. This is the concrete cost of the copy-paste, not a hypothetical one.
- **Fix**: the table-driven fan-out from the god-file finding, with one explicit null contract.

### [MED] `parsed.data as XVerbMessage` casts hide schema-vs-type drift at the trust boundary

- **Where**: `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:1736, 1924, 1979, 2175, 2232`
- **Type**: types
- **What**: five verb handlers cast the Zod output to the hand-written `protocol.ts` type. The
  sidecar-local schema and the protocol type are maintained independently, and the cast is the only
  thing joining them — so a divergence (a field added to the type but not the schema, or a
  nullability difference like `RunControlModelSetMessage.model`) compiles clean and produces a value
  whose static type lies about what the boundary actually validated.
- **Trigger / why it matters**: `handleSessionActionVerb` at line 2050 already does this correctly —
  `const verb: SessionActionVerbMessage = parsed.data`, an *assignment* that makes tsc prove the
  schema output is assignable to the protocol type. The other five bypass exactly that proof, in the
  file whose whole job is validating untrusted input.
- **Fix**: replace each `as` with a typed annotation, as `handleSessionActionVerb` does. Any that
  fails to compile is a genuine drift the cast was hiding.

### [LOW] Dead `try/catch` around `controller.submit`, and the error it can never catch is reported as the wrong thing

- **Where**: `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:1289-1302` and `:1531-1539`
- **Type**: dead-code
- **What**: `AppSessionController.submit` is declared `async` (`src/app-runtime/AppSessionController.ts:134`),
  so it cannot throw synchronously — even its `throw new Error('Session turn already running')` at
  line 139 surfaces as a rejected promise, which the `.catch` at line 1306 already handles. The
  `try/catch` is unreachable, its `error` binding is unused, and it swallows without logging. The
  `if (!started)` fallback in `handleSubmit` then reports `turn_already_running` — which would be a
  lie for any other cause, if the branch were reachable at all (both of `startTurn`'s refusal
  conditions are re-checked by `handleSubmit` immediately above).
- **Fix**: delete the `try/catch`; make `startTurn` return `void` or keep the boolean but drop the
  dead `!started` error frame.

### [LOW] `retriedQueuedPromptKeys` grows without bound

- **Where**: `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:387` and `:1166-1176`
- **Type**: correctness (leak)
- **What**: a key is added on the first refusal and deleted only by `onInputPersisted`. On the
  second refusal the handler logs "giving up" and returns **without deleting the key**. The comment
  at line 385-387 claims entries "are removed as soon as a turn durably accepts the prompt, so this
  only ever holds failures" — which is precisely the set that never empties.
- **Trigger / why it matters**: every permanently-failing queued prompt leaves a uuid in the set for
  the life of the process. Small per entry, but unbounded and, more importantly, the invariant the
  comment states is not the one the code implements.
- **Fix**: `this.retriedQueuedPromptKeys.delete(retryKey)` in the give-up branch.

### [LOW] The durable-acceptance latch is cleared before the submit can still be rejected

- **Where**: `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:1461`, with rejections at `:1481-1490` and `:1497-1509`
- **Type**: correctness
- **What**: `taskNotificationAwaitingDurableAcceptance = false` is set with the comment "A human turn
  is a new, explicitly accepted safe boundary", but two gates below it can still reject the submit
  outright.
- **Trigger / why it matters**: a worker result is deferred awaiting a fresh boundary. The user's
  next submit is rejected because `MAX_QUEUED_PROMPTS` is already full. No turn ran, but the latch
  is now clear, so the next boundary re-attempts the deferred worker-result handoff against exactly
  the unsafe condition the latch was protecting.
- **Fix**: move the clear to after the last rejection gate, immediately before `startTurn`/`enqueueMidTurnPrompt`.

### [LOW] Orphaned doc comment describes the wrong function

- **Where**: `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:2974-2990`
- **Type**: quality (naming/comments)
- **What**: two JSDoc blocks are stacked above `handleContextBreakdownRequest`. The first
  (lines 2974-2981) describes `broadcastContextBreakdown` — coalescing, "A null snapshot … sends
  nothing at all" — and now sits on a function that does none of that. It reads as documentation
  for the code it precedes.
- **Fix**: move the first block onto `broadcastContextBreakdown` (line 3030), where it belongs.

### [LOW] `broadcastAgentModeSnapshot` serialises a file-backed engine read per connection

- **Where**: `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:2880-2887`
- **Type**: quality
- **What**: `for (const connection of this.connections) { await this.sendAgentModeSnapshot(connection) }`,
  and `sendAgentModeSnapshot` awaits `this.agentMode.getSnapshot()`, documented at line 2851-2853 as
  a file-backed `readSessionState`. N connections means N sequential disk reads for one identical payload.
- **Fix**: read the snapshot once, then fan the prepared frame out synchronously — the shape the
  other twelve broadcasters already use.

### [LOW] `refreshAccountsUsageOnce` swallows every failure with no trace

- **Where**: `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:3185`
- **Type**: quality (error handling)
- **What**: `.catch(() => {})`. Every other best-effort path in this file logs (`sendSettingsSnapshot`,
  `sendLeaseSnapshot`, `broadcastContextBreakdown`, and so on all `this.log(...)`).
- **Trigger / why it matters**: an expired token, an offline pool, or a changed usage endpoint leaves
  the accounts panel showing 0/null usage forever with zero diagnostic anywhere. That is a real
  support-path cost, and it is one line from being debuggable.
- **Fix**: `.catch(error => this.log(...))`, matching the surrounding idiom.

### [LOW] MCP is stubbed out of the live session

- **Where**: `/Users/pt/cat-code/app/sidecar/sessionController.ts:318-319` (`mcpClients: []`, `availableMcpServers: []`, and `mcpTools: []`/`mcpCommands: []`/`mcpResources: {}` at `:377-379`)
- **Type**: design (named recurring mistake #1, disclosed)
- **What**: the desktop session is constructed with an empty MCP client set, so no MCP server's tools
  or commands reach a turn — while `extensionsDomain.ts` reads the real MCP *config* off disk and
  ships it to the settings surface.
- **Trigger / why it matters**: a user with configured MCP servers sees them listed in the app and
  gets none of their tools in a turn. Flagged as LOW rather than higher because it is **explicitly
  disclosed** as a deferral in `extensionsDomain.ts:19-22` ("the empty-mcpClients stub in
  `sessionController.ts`, an app-runtime extract not a sidecar hand-wire"), so it is tracked, not drift.
  Noting it so the reviewer can weigh whether the settings surface should say so.
- **Fix**: none proposed; confirm the deferral still has an owner, and consider whether the extensions
  surface should indicate the servers are configured but not connected in this session.

## What is good here

- **`engineTypeDriftCheck.ts`** is 29 lines that make snapshot-vs-engine type drift a compile error
  with `IsMutuallyAssignable`. Zero runtime cost, catches a whole class of silent breakage. This
  pattern deserves to be copied to the other snapshot boundary (`sdk-types.snapshot.d.ts`).
- **`sessionController.ts` builds real engine context, and says why.** `getTools(...)` from the same
  permission context the runtime enforces, `getCommands(cwd)`, `initializeToolPermissionContext`
  mirroring `main.tsx:1787-1811`, the real agent definitions, `getInitialEffortSetting()`. Every one
  carries a `src/…:line` citation and a note about the stub-context defect it fixes. This is the
  §8.1 rule working as intended.
- **The distinction between fail-closed and degrade-gracefully is applied consistently.** Inbound
  frames are rejected at the boundary with a typed code; every outbound snapshot sender is wrapped so
  one bad read can never strand an attaching connection or skip history replay. That asymmetry is
  correct and rare.
- **`createBackpressuredSocket`** is a small, well-scoped fix for a genuinely subtle bug (a short
  `write()` return desyncing a length-prefixed stream), with the failure mode spelled out in the
  header and an overflow bound rather than unbounded queueing.
- **The comments explain constraints rather than narrating code.** Lines 458-468 on why there is no
  per-turn context-breakdown refresh, and lines 1463-1475 on why a mid-turn submit is queued rather
  than refused, both encode real reasoning with source citations that a reader could not recover
  from the code.

## Not reviewed / uncertain

- **Security-specific judgements were left to the parallel reviewer.** I read the T4/T5a/T6/T6b/C1/F10
  logic closely enough to review its *shape* (it is well factored for its size), but I did not audit
  the allowlists for coverage gaps.
- **`sessionController.ts` and `permissionDomain.ts` are dirty in the working tree** from another
  live session (`isBypassPermissionsModeAvailable` is being changed from a `CATCODE_ALLOW_BYPASS`
  env gate to unconditional `true`). I reviewed neither hunk and neither finding above touches them;
  the `mcpClients: []` stub I cite is committed code, not that session's edit.
- **The exact width of the removed-connection window (HIGH #1, path 2)** depends on whether Bun
  delivers buffered `data` events after `socket.end()` on a Unix socket. I did not run the app to
  measure it. Path 1 (the `send()` write-failure zombie) needs no such window and is unconditional:
  the socket is never ended at all. A probe test that writes an oversize frame followed immediately
  by a valid `app.submit` on the same socket, then asserts `controller.submit` was never called,
  would settle both.
- **I did not run any test suite** (contract: read-only, no full suites). Claims about drain
  divergence, the freshness-floor bypass, and the missing tripwire are from source reading and
  `rg` sweeps only.
