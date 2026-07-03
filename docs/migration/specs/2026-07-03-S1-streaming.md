# S1 — Streaming behavioral spec (`stream_event` / `SDKPartialAssistantMessage`)

**Status: SPEC, 2026-07-03.** Branch `migration`. This is the confirmed behavioral spec the
INVENTORY requires before P2-3 ("Streaming/activity engine", Faked? **yes (S1)**) wires anything.
It replaces the prototype's scripted demo (`Chat.jsx` `runPlaygroundTurn` / `streamReply` /
`setInterval` timers — all CUT) with the real engine contract, traced to source. Every anchor
below was re-verified against the working tree on 2026-07-03; line numbers drift — re-grep the
symbol, not the number. Where this doc and source disagree, **source wins**.

Companion: `2026-07-03-S2-permission-update.md` (S2). Scope here is *incremental output only*:
what arrives per turn, in what order, and what UI state is derivable from it. tool_use↔tool_result
correlation and full variant coverage are P2-2/P2-0 scope, referenced but not specced here.

---

## 1. The emission pipeline (verified, end-to-end)

```
provider SSE (Anthropic native, or Codex adapter synthesizing the same shape)
  └─ claude.ts stream loop            for-await over raw parts
       ├─ per-part switch             accumulates blocks; yields ONE AssistantMessage
       │                              per content_block_stop (only that block)
       └─ after the switch            re-yields EVERY raw part as internal
                                      {type:'stream_event', event: part}
  └─ QueryEngine.submitMessage        case 'stream_event': usage/stop_reason bookkeeping;
                                      iff includePartialMessages → yields SDK frame
                                      {type:'stream_event', event, session_id,
                                       parent_tool_use_id: null, uuid}
  └─ AppSessionController.submit      wraps every SDKMessage as AppSessionEvent
                                      {type:'message', message} to subscribers
  └─ sidecar → IPC → renderer         raw-forward (P1-0; no lossy mapper — locked decision)
```

Anchors:

- **Type**: `SDKPartialAssistantMessage` — `src/entrypoints/sdk/coreTypes.generated.ts:114`
  (`type:'stream_event'`, `event?: unknown`, `parent_tool_use_id?`, `session_id?`, `uuid?`).
  The runtime schema pins `event` as `RawMessageStreamEventPlaceholder()`
  (`src/entrypoints/sdk/coreSchemas.ts:1525-1533`): the nested payload **is the Anthropic
  RawMessageStreamEvent, verbatim** — the engine never reshapes it.
- **Producer**: `src/services/api/claude.ts` — part switch at `:2139` (`message_start` `:2140`,
  `content_block_start` `:2155`, `content_block_delta` `:2229`, `content_block_stop` `:2350`,
  `message_delta` `:2394`, `message_stop` `:2486`); the unconditional re-yield of every part as
  `{type:'stream_event', event: part, ...(ttftMs on message_start)}` at `:2489-2494`.
- **Gate**: `includePartialMessages` (`src/QueryEngine.ts:238`, default **false**; SDK-frame wrap
  at `:876-884`). The app runtime turns it **on**:
  `src/app-runtime/createRuntimeBackedWebAppSession.ts:17` and
  `src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts:116`. P1-2 confirmed frames
  arrive live through the full renderer→IPC→sidecar path.
- **Seam**: `src/app-runtime/AppSessionController.ts:165-167` (`for await … emit(createMessageEvent)`),
  event type `src/app-runtime/sessionEvents.ts:20`.
- **Codex parity**: the Codex adapter synthesizes the identical Anthropic SSE shape, consumed by
  the SAME claude.ts loop — `src/services/api/codex-fetch-adapter.ts:1290` (`message_start`),
  `:1418/:1549/:1577` (`content_block_start` thinking/tool_use/text), `:1441/:1589/:1653/:1777`
  (`thinking_delta`/`text_delta`/`input_json_delta`/`signature_delta`), `:2479/:2496`
  (`message_delta`/`message_stop`). One loop, both providers.
- **Existing reference consumer**: `handleMessageFromStream`
  (`src/utils/messages.ts:2961`, delta cases `:3153-3195`) — the Ink REPL's own projector over
  these events. P2-3 should mirror its semantics, not invent new ones.
- `convertStreamEvent` (`src/remote/sdkMessageAdapter.ts:45`) is the CCR/remote mapping; it
  passes `event` through untouched — confirming there is no richer engine-side shape to find.

**Subagent deltas never reach the app seam.** `runAgent` drops child `stream_event`s
(`src/tools/AgentTool/runAgent.ts:352` — the `onQueryProgress` comment documents the drop), and
the QueryEngine wrap hardcodes `parent_tool_use_id: null` (`QueryEngine.ts:881`). The field
exists in the type; at this seam it is always `null`. Do not build nested-stream UI on it.

---

## 2. The nested `event` variants (pinned, not guessed)

Six top-level `event.type`s — all observed live in P1-2 (STATUS row) and all handled by the
engine's own consumers:

| `event.type` | payload (fields the engine actually reads) | notes |
|---|---|---|
| `message_start` | `message: { id, usage, stop_reason: null, … }` | engine bolts on `ttftMs` (claude.ts:2493). `message.id` is the grouping key for everything that follows. |
| `content_block_start` | `index`, `content_block` | block types handled by name: `text`, `thinking`, `tool_use`, `server_tool_use`; everything else falls to a spread default (claude.ts:2216-2227). Codex adds non-standard `reasoning_kind: 'summary'\|'raw'` on thinking starts (claude.ts:2192-2214, codex-fetch-adapter.ts:1426). |
| `content_block_delta` | `index`, `delta` | `delta.type` ∈ `text_delta {text}` · `input_json_delta {partial_json}` · `thinking_delta {thinking}` · `signature_delta {signature}` · `citations_delta` (accepted, not accumulated — claude.ts:2261) · `connector_text_delta` (feature-gated `CONNECTOR_TEXT`, claude.ts:2243). |
| `content_block_stop` | `index` | closes the block; the per-block assistant SDKMessage is minted here (§4). |
| `message_delta` | `delta: { stop_reason }`, `usage` | the ONLY place the real `stop_reason` and final usage arrive (claude.ts:2394-2436). |
| `message_stop` | — | end of one API message; the turn may continue (§3). |

P1-3 additionally observed `input_json_delta` live (incremental tool input). `signature_delta`
is cryptographic material, not display content — the REPL deliberately excludes it from the
token counter (`utils/messages.ts:3189-3193`); do the same.

---

## 3. Event-ordering contract per turn (the thing P2-3 asserts against)

A **turn** (submit → `result`) contains **one or more API messages** — the agentic loop issues a
new API call after every tool round-trip, and each one replays the full message lifecycle:

```
turn :=
  system frames (init on first turn, status, …)*
  api_message+                       ← one per model call in the loop
  result                             ← type:'result' — the ONLY turn-end marker

api_message :=
  stream_event(message_start)                          # new message.id; reset per-message state
  block*                                               # blocks stream sequentially by index
  stream_event(message_delta)                          # real stop_reason + final usage
  stream_event(message_stop)
  [tool execution frames, when the message ended in tool_use:
     tool_progress* · user frame carrying tool_result(s) · system frames]

block :=
  stream_event(content_block_start(index))
  stream_event(content_block_delta(index))*            # zero or more, same index
  assistant SDKMessage                                 # ⚠ minted at block close — arrives
  stream_event(content_block_stop(index))              #   BEFORE the stop event (claude.ts:
                                                       #   :2391 `yield m` precedes :2489)
```

Hard rules a P2-3 implementation MUST hold:

1. **Key all streaming state by `(message.id, index)`.** `message_start` opens a message;
   deltas correlate to their block by `index` only within that message.
2. **The assistant SDKMessage interleaves *inside* the stream** — after that block's last delta,
   *before* its `content_block_stop` event. Do not assume "all stream events, then assistant"
   (P1-2's STATUS row lists counts by type, not wire order).
3. **A turn is over at `result`, not `message_stop`.** `message_stop` ends one API message; the
   loop may start another `message_start` immediately (multi-tool turns).
4. **Streams can end without `message_stop`.** claude.ts has an idle watchdog + non-streaming
   fallback (`:2532-2560`): a stream can die mid-block and the SAME content then arrives as
   plain assistant frames under a **new** `message.id` with **no** stream events at all.
   Incomplete per-message streaming state must be discardable at any time; render nothing
   durable from stream events alone.
5. **Stream events are optional garnish, assistant frames are the content.** The projector must
   render a correct transcript with the stream events filtered out entirely (that is exactly
   the non-streaming fallback path). P1-3's projector already treats them as skippable.

---

## 4. Accumulation rules (how deltas become content)

Mirror the engine's own accumulation (claude.ts `:2155-2348`, REPL consumer
`utils/messages.ts:3103-3195`):

- **text**: start from `''` — claude.ts explicitly discards any text pre-filled on
  `content_block_start` because the SDK sometimes duplicates it in the first delta
  (`:2183-2190`). Append `text_delta.text` in arrival order.
- **tool_use input**: start from `''` (engine overwrites `input` with `''` at block start,
  `:2160-2163`); append `input_json_delta.partial_json`. The accumulated string is **unparsed
  JSON**; the engine parses it only at block close via `normalizeContentFromAPI`
  (`src/utils/messages.ts:2677` — `safeParseJSON`; empty string → `{}`; parse-fail → `{}` except
  `Apply_patch`, which wraps the raw string). The **parsed, authoritative** input arrives in the
  per-block assistant frame. UI may best-effort-parse partials for a live preview but MUST
  reconcile to the assistant frame's input.
- **thinking**: append `thinking_delta.thinking`; keep `reasoning_kind` from the start event
  (Codex `summary` vs `raw`); `signature_delta` is stored by the engine but is not display
  content.
- **Reconciliation**: when the per-block assistant frame arrives, it **replaces** that block's
  accumulated preview (same `message.id`, same block — it is the engine's normalized version of
  what you just accumulated). Grouping stays keyed by `message.id`.

**Per-block assistant frames are provider-independent** (P1-3 field-note correction). The
"Codex emits ONE assistant msg PER content block (same id)" observation is not a Codex quirk:
`claude.ts:2371-2392` mints one `AssistantMessage` containing exactly `[contentBlock]` from the
shared `partialMessage` at **every** `content_block_stop`, for every provider on the streaming
path. Grouping must never assume 1 assistant frame per message, on any provider.

**⚠ The stop_reason/usage trap (real, IPC-specific).** The engine yields each per-block
assistant frame with `stop_reason: null` and message_start-era usage, then **mutates its own
in-memory copy** when `message_delta` arrives (`claude.ts:2419-2438` — deliberate direct
mutation for the transcript queue). The sidecar serialized the frame at emit time, so the
renderer's copy **never** gets the write-back. Renderer rules: per-message `stop_reason`/usage
come from the `message_delta` stream event; turn totals come from the `result` frame
(`usage`, `modelUsage`, `total_cost_usd`, `num_turns` — `coreTypes.generated.ts:122-141`).
Never read them off a streamed assistant frame.

---

## 5. Activity / "typing" state — derivable vs invented

The prototype's activity chrome (`Chat.jsx:355-380`: `phase`, `activity {verb, tool, target}`,
`liveTokens`, `elapsed`, `runStats`, `paused`) is a legitimate UX target, but the prototype
*populated* it from script. Real derivations:

| Prototype state | Real derivation | Anchor |
|---|---|---|
| turn running / `idle` | submit accepted → until `result` frame; `abort.status` events for interrupts | `AppSessionController.ts:165-183`, `sessionEvents.ts:41-44` |
| `connecting` | submit sent, no `message_start` yet this turn (`ttftMs` on message_start marks its end) | claude.ts:2493 |
| `thinking` | open `thinking` block (start seen, stop not) | §3 |
| `responding` | open `text` block | §3 |
| `tool` (input streaming) | open `tool_use` block | §3 |
| `tool` (executing) | assistant `tool_use` frame seen, matching `tool_result` not yet — plus engine-pushed `tool_progress` frames (`tool_use_id`, `tool_name`, `elapsed_time_seconds`) for long runs | `coreTypes.generated.ts:258-266` (P2-2 owns full correlation) |
| `paused` (permission) | pending `permission.requested` on the S2 channel — real, was `pendingPermissions > 0` in the prototype | S2 spec §2 |
| `liveTokens` | Σ chars of `text_delta` + `input_json_delta` + `thinking_delta` this turn ÷ 4, excluding `signature_delta` — the REPL's exact metric | `REPL.tsx:1540` (`responseLengthRef`), `utils/messages.ts:3153-3195` (accumulation), `SpinnerAnimationRow.tsx:159-160` (÷4 display; `SHOW_TOKENS_AFTER_MS = 30_000` at `:19`) |
| `elapsed` | UI-owned wall clock from submit — legitimately client-side (the TUI does the same) | `SpinnerAnimationRow.tsx` |
| `runStats {files, added, removed}` | NOT in the stream. Derivable only from tool_result diffs (P2-2); ship later or cut | — |
| compaction/status notices | `status` frames (`SDKStatus = 'compacting' \| string \| null`) + `system` subtypes (`api_retry`, `hook_*`, `task_*`, …) | `coreTypes.generated.ts:58`, `:166-169`, `:171-193` |

Note the prototype's own good idea worth keeping: it scopes the live spinner to the session that
owns the turn (`turnSessionRef`, Chat.jsx:375-380). With N sessions that rule becomes "activity
state is per-session, derived from that session's event stream only".

---

## 6. Prototype-invented — CUT list

From `~/catcode_prototype/cat-app/Chat.jsx` (the W3 "Streaming/activity engine" row, ⚓6):

- `runPlaygroundTurn` (`:596-629`), `buildPermReq` (`:562-595`), `ppSleep` — the scripted
  permission-playground turn. CUT (S2 replaces the permission side).
- `streamReply` (`:458-472`) — `setInterval` word-chunk streaming of a canned `FINAL_REPLY`
  (`:456`). CUT; §3/§4 replace it.
- The `at()`-timer demo turn (`:483-546`): hardcoded thinking/Read/Edit/Bash sequence, scripted
  `toolStatus: 'running'→'done'` flips, scripted `runStats` values, scripted phase transitions
  at fixed ms offsets. CUT wholesale — phases become derived state (§5).
- `phase: 'connecting'` as a *timed step* — keep the phase, derive it (§5 row 2).
- Message-shape inventions riding on the demo: flat `{type:'tool', toolStatus, toolDiff,
  toolOutput}` rows mutated in place. Real tool rendering = `tool_use`/`tool_result` block
  correlation (P2-2); streaming only contributes the live `tool_use` input preview.

Kept (real-anchored even in the prototype): the turn-scoped token counter (`turnCharsRef` ÷ 4 —
matches `responseLengthRef`), spinner-after-30s (`SHOW_TOKENS_AFTER_MS`), per-session spinner
scoping, elapsed clock as UI state.

---

## 7. Decided / open

**Decided (by source):** everything in §1–§4. The contract is stable against the engine pin;
`event` is Anthropic RawMessageStreamEvent verbatim; per-block assistant frames; `result` is the
turn-end marker; stream events are droppable garnish.

**Open (build-time, P2-3's call, flagged not resolved):**
- Whether the live preview renders `input_json_delta` partials (best-effort JSON parse) or just
  a byte count — both satisfy this spec; reconciliation rule in §4 is mandatory either way.
- Throttling/batching of delta re-renders (the wire can deliver many small frames; P1-2 saw 13
  for a one-liner). Pure renderer concern.
- `connector_text_delta` / `citations_delta` handling — feature-gated / unaccumulated in the
  engine today; a documented no-op `default` is the correct P2-0-style posture.
