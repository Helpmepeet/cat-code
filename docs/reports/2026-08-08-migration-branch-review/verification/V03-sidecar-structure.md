# A03 adversarial validation: sidecar structure

> **Verification provenance:** Independent `gpt-5.6-sol` subagent at max effort. `gpt-5.6-luna` was requested, but the runtime ignored the same-family downgrade from the Sol parent. Read-only source review; no tests or GUI run.

## Overall verdict

At `migration` SHA `a17e5e992997da02a68d3bc6e53ec916795c05a1`, 9 of 16 findings are confirmed, but the report overstates its broad god-file thesis and misses an existing renderer error surface. The highest-priority defect remains the removed-connection invariant: a connection deleted from the registry can still submit frames. The only dirty reviewed source is `/Users/pt/cat-code/app/sidecar/sessionController.ts`; its uncommitted bypass-permission edit is unrelated to the MCP finding and neither fixes nor obscures it.

## Finding classifications

### 1. CONFIRMED: removed connections remain executable [defect, original HIGH]

- **Evidence:** `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:141-146` has no liveness field; `removeConnection` only deletes from the set at `:767-775`; `handleData` never checks membership at `:778-800`; the write-failure path removes without ending at `:3370-3379`. `/Users/pt/cat-code/app/sidecar/index.ts:330-334` continues routing while `socketState` exists. Deferred close is real at `/Users/pt/cat-code/app/sidecar/backpressuredSocket.ts:78-86`.
- **Trigger/cost:** after removal, a later valid `app.submit` can still reach `controller.submit`. With no remaining registered connection, turn output is discarded while model usage is billed.
- **Disposition:** add a membership/liveness guard at the start of `handleData`, end the socket on write failure, and add a regression test. A new `closed` field is optional; `this.connections.has(connection)` is sufficient.

### 2. OVERSTATED: 4,262-line god file and proposed four-way extraction [structural, original HIGH]

- **Evidence:** `/Users/pt/cat-code/app/sidecar/sidecarServer.ts` is 4,262 lines and does combine routing, turn policy, validation, snapshots, and framing. However, the actual Unix listener and socket-state lifecycle live in `/Users/pt/cat-code/app/sidecar/index.ts:280-356`, so “owns transport” is imprecise.
- **Cost:** the file is difficult to review, especially around security-sensitive changes. But the claimed “~1,900 lines with an existing home” is an estimate, not a verified source fact.
- **Disposition:** do not schedule the proposed wholesale refactor as a HIGH fix. Extract independently testable schemas or pure permission helpers incrementally. A heterogeneous generic snapshot table could weaken type-specific null handling and security reviewability.

### 3. PARTIALLY CONFIRMED: queue processing duplicates only part of engine policy [structural, original MED]

- **Evidence:** `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:1107-1247` drains one prompt at a time; `/Users/pt/cat-code/src/utils/queueProcessor.ts:52-86` batches all matching non-slash commands. The terminal then turns the command array into multiple user messages at `/Users/pt/cat-code/src/utils/handlePromptSubmit.ts:552-608`.
- **Trigger/cost:** three queued prompts can become three desktop turns instead of one terminal turn.
- **Qualification:** this is not a drop-in duplication. Sidecar `startTurn` accepts one `AppSessionPrompt` and adds durable-acceptance, reservation, retry, and worker-result policy absent from `processQueueIfReady`.
- **Disposition:** first decide whether desktop should preserve terminal batching. If yes, share/extract queue-selection policy and add an app-runtime batch adapter. Do not directly replace the sidecar drain with `processQueueIfReady`.

### 4. PARTIALLY CONFIRMED: missing exhaustiveness guard and duplicated vocabulary [structural, original MED]

- **Evidence:** `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:1040-1075` lacks a `never` default. The current engine union has exactly four members at `/Users/pt/cat-code/src/web/appSessionProtocol.ts:43-48`, and all four are handled. App-owned routing and strict-key declarations are duplicated at `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:879-1015` and `:3487-3552`.
- **Cost:** a future engine-union extension could compile without a dispatch implementation.
- **Qualification:** there is no currently dropped union member. Prefix routing is also protected by `checkStrictKeys` running first, and sidecar-local schemas are deliberate trust-boundary artifacts.
- **Disposition:** add the `never` tripwire and compile-time vocabulary coverage. Do not force every family into one routing idiom or claim field allowlists can be derived from type-name arrays alone.

### 5. CONFIRMED: failed context analyses bypass the freshness floor [defect, original MED]

- **Evidence:** the gate requires a non-null prior snapshot at `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:3003-3008`; the timestamp is written only after success at `:3043-3048`. `/Users/pt/cat-code/app/sidecar/contextBreakdownDomain.ts:187-193` converts analyzer failures to `null`.
- **Trigger/cost:** sequential requests after failed analyses each rerun transcript loading and token analysis. The generic frame-rate cap remains, so “no rate limit at all” is too absolute, but the dedicated 15-second floor is bypassed.
- **Disposition:** record a last-attempt timestamp on every completion. Also route or suppress the pending rerun at `:3061-3064`; stamping alone does not stop that direct retry after a null result.

### 6. INVALID: `bad_request` errors are invisible [defect claim, original MED]

- **Evidence:** every error frame is recorded at `/Users/pt/cat-code/app/renderer/src/rawMessageLog.ts:116-122` and rendered directly above the composer at `/Users/pt/cat-code/app/renderer/src/App.tsx:4305-4307`. Git blame dates that render path to 2026-07-12, before A03.
- **Trigger/outcome:** an oversized or queue-overflow submit clears the draft, but its sidecar message is visibly rendered in danger text. The claim that `rawMessageLog` is only a developer inspector is false.
- **Disposition:** none within this finding.

### 7. CONFIRMED: history replay repeats six structural traversals [quality/performance, original MED]

- **Evidence:** `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:718-763` prepares and separately stringifies each frame; preparation performs clone plus two walks at `:2522-2549`; `send` scans and encodes at `:3332-3371`. `encodeFrame` stringifies again at `/Users/pt/cat-code/app/shared/framing.ts:21-25`.
- **Trigger/cost:** every attach repeats the work over up to 4 MiB of retained history. The actual latency impact is unmeasured, but the duplicated work is concrete.
- **Disposition:** memoize prepared retained frames and measured byte counts. Preserve per-send secret scanning and outbound-size enforcement; do not bypass those security gates merely to cache encoded bytes.

### 8. DUPLICATE/DEPENDENT: repeated snapshot senders and null protocols [quality, original MED]

- **Evidence:** the repeated senders and broadcasters remain at `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:2634-3309`.
- **Cost:** maintenance duplication is real, but it is already a principal premise of finding 2. The claimed live falsy-snapshot hazard does not exist for the current object/array snapshot types; the special thread-goal `null` contract is intentional.
- **Disposition:** no separate remediation ticket. If extraction proceeds, use narrowly typed helpers for genuinely identical non-null synchronous snapshots rather than one heterogeneous registry.

### 9. CONFIRMED: five casts suppress schema/type checking [type safety, original MED]

- **Evidence:** casts remain at `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:1736`, `:1924`, `:1979`, `:2175`, and `:2232`. The correctly checked assignment remains at `:2050`.
- **Trigger/cost:** protocol-required fields or nullability can drift from Zod output while handlers and domains receive a falsely asserted type.
- **Disposition:** replace the casts with typed assignments or bind each schema to its protocol output type with a compile-time constraint.

### 10. CONFIRMED: synchronous `try/catch` around async `submit` is dead [dead code, original LOW]

- **Evidence:** `/Users/pt/cat-code/src/app-runtime/AppSessionController.ts:135-196` declares `submit` async. The unreachable catch is `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:1289-1302`; promise rejection is already handled at `:1304-1320`. The misleading `!started` response is at `:1531-1539`.
- **Cost:** dead control flow suggests synchronous failures are handled when they are not and can emit the wrong classification if later made reachable.
- **Disposition:** delete the catch and the unreachable `handleSubmit` fallback; retain the boolean return only where queue drains use it.

### 11. CONFIRMED: failed-prompt retry keys leak [defect, original LOW]

- **Evidence:** success deletes the key at `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:1162-1165`; the second-refusal branch returns without deletion at `:1168-1174`.
- **Trigger/cost:** every permanently refused queued prompt retains one UUID for the sidecar process lifetime.
- **Disposition:** delete the retry key immediately before the give-up return.

### 12. PARTIALLY CONFIRMED: durable-acceptance latch clears before rejection [defect, original LOW]

- **Evidence:** the clear precedes active-turn rejection gates at `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:1459-1509`.
- **Qualification:** the report’s direct narrative is incomplete. The latch is normally set after `activeTurn` is cleared (`:1221-1228`, `:1312-1313`), so the next ordinary submit starts a turn and cannot hit those gates. A reachable problematic state exists when the scheduler starts a queued human prompt first (`:1107-1117`, `:1131-1177`) while leaving the latch set; a rejected mid-turn submit can then clear it prematurely.
- **Disposition:** move the clear below all rejection gates and clear it from the queued prompt’s `onInputPersisted`, not merely when any new frame arrives.

### 13. CONFIRMED: context-breakdown JSDoc is attached to the wrong method [quality, original LOW]

- **Evidence:** two blocks are stacked above `handleContextBreakdownRequest` at `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:2974-2991`; the first describes `broadcastContextBreakdown` at `:3030`.
- **Cost:** readers are given incorrect lifecycle and null-behavior documentation at the request handler.
- **Disposition:** move the first block to `broadcastContextBreakdown`.

### 14. CONFIRMED: agent-mode broadcast performs one file read per connection [quality/performance, original LOW]

- **Evidence:** `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:2880-2886` awaits one sender per connection; each sender calls `getSnapshot` at `:2855-2861`. That method reads persisted state at `/Users/pt/cat-code/app/sidecar/agentModeDomain.ts:103-108` and `:153-158`.
- **Trigger/cost:** overlapping/reconnect or multi-client connections receive one identical snapshot after N sequential file reads. Normal operation usually has one connection, limiting current impact.
- **Disposition:** read and prepare once per broadcast, then fan out the same immutable frame.

### 15. PARTIALLY CONFIRMED: account-usage rejection catch is silent [error handling, original LOW]

- **Evidence:** `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:3173-3185` has an empty catch.
- **Qualification:** ordinary offline, HTTP, and expired-token failures do not reject. `/Users/pt/cat-code/src/services/api/codexUsage.ts:213-249` converts and logs them, and `:277-309` returns a snapshot with errors. Therefore the proposed catch logger would cover only unexpected rejections, not the report’s principal triggers.
- **Disposition:** log unexpected rejection at the current catch. If expected per-account failures need stronger diagnostics, propagate or log `PoolUsageSnapshot.errors` in the real executor rather than relying on promise rejection.

### 16. CONFIRMED: desktop MCP runtime remains stubbed [deferred feature defect, original LOW]

- **Evidence:** `/Users/pt/cat-code/app/sidecar/sessionController.ts:318-319` sets empty clients/servers and `:376-379` passes empty tools, commands, clients, and resources. The configuration UI honestly labels rows “Configured” at `/Users/pt/cat-code/app/renderer/src/SettingsExtensions.tsx:140-167`. Engine startup machinery exists at `/Users/pt/cat-code/src/main.tsx:2473-2530` and is handed into app-runtime configuration at `:3233-3251`; `/Users/pt/cat-code/src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts:84-101` already consumes complete MCP state.
- **Trigger/cost:** configured MCP tools and commands are unavailable to desktop turns.
- **Disposition:** keep this as an explicit product deferral, but give it a current owner. Extract the engine MCP startup into `src/app-runtime/` and consume it from both paths. Do not hand-copy startup into the sidecar or render an engineering warning in Settings.

## Counts

| Classification | HIGH | MED | LOW | Total |
|---|---:|---:|---:|---:|
| CONFIRMED | 1 | 3 | 5 | 9 |
| PARTIALLY CONFIRMED | 0 | 2 | 2 | 4 |
| STALE/ALREADY FIXED | 0 | 0 | 0 | 0 |
| OVERSTATED | 1 | 0 | 0 | 1 |
| DUPLICATE/DEPENDENT | 0 | 1 | 0 | 1 |
| INVALID | 0 | 1 | 0 | 1 |
| **Original severity totals** | **2** | **7** | **7** | **16** |

## Prioritized confirmed remediation

1. Make removed connections inert and tear down write-failed sockets (#1).
2. Rate-limit failed context-breakdown attempts, including pending retries (#5).
3. Restore trust-boundary type proofs and delete failed retry keys (#9, #11).
4. Assign and implement the MCP runtime extraction through `src/app-runtime/` (#16).
5. Cache history preparation and read agent-mode snapshots once per broadcast while preserving every outbound security check (#7, #14).
6. Remove the dead async catch/fallback and relocate the orphaned JSDoc (#10, #13).

No GUI or tests were run; none was necessary to settle these source-level claims. No files, processes, git state, or working-tree contents were modified.
