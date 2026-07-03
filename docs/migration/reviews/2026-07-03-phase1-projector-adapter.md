# Phase-1 projector and adapter review — 2026-07-03

## Workstream verdict

**CLEARED, WITH PHASE-2 RESHAPING REQUIRED.** This workstream honestly cleared
the thin Phase-1 walking-skeleton gate: the renderer receives raw
`AppSessionEvent` values, the projector is separate from permission/domain
state, text and `tool_use` blocks are narrowed without casts, unknown message
and block variants have explicit no-op fallbacks, the normal sidecar derives 28
tools through `getTools()`, and Tailwind utilities are present in the built CSS.

It did **not** produce a Phase-2-ready row model. The projector discards the
engine message identity needed to group the real one-assistant-frame-per-block
stream, and the tests model a combined multi-block assistant frame that the
streaming producer does not emit. P2-0 can safely start, but it must begin by
fixing row identity and installing a realistic event-sequence fixture before
P2-1, P2-2, or P2-3 build on the current state shape.

The P1-3 implementation claims in `STATUS.md` are substantially accurate. The
overstatement is limited: the one-assistant-frame-per-content-block behavior is
compatible with the P1 renderer, but it is not actually modeled or asserted,
and `bun test app/` does not prove that the normal sidecar exposes tools to the
model. The documented operator-run live evidence is doing that work.

## Numbered findings

### 1. CONFIRMED — MEDIUM — Projected rows lose the identity required for real stream grouping

- **File anchor:** `app/renderer/src/transcriptProjector.ts:21-42`,
  `app/renderer/src/transcriptProjector.ts:71-77`;
  producer evidence: `src/services/api/claude.ts:2371-2391`.
- **Finding:** `AssistantTextRow` has no source identity, `ToolUseRow` keeps only
  the tool-use id, and `projectMessage()` passes a bare content block to the row
  mapper. The shared producer emits one assistant frame at every
  `content_block_stop`, with one content block and the shared
  `message.message.id`; the projector discards that id. `TranscriptView` then
  uses array indices as React keys (`app/renderer/src/TranscriptView.tsx:19-30`).
- **Concrete failure scenario:** one API message streams a text block followed
  by two tool-use blocks. Phase-2 streaming state is keyed by
  `(message.id, block index)`, but the authoritative assistant frames become
  three unrelated rows. The projector cannot reconcile a streamed preview with
  its final row or group the sibling blocks as one assistant message; later
  insertion/replacement also shifts index keys.
- **Phase-2 impact:** P2-0 must introduce stable row/source identity and retain
  enough message/block provenance before P2-2 correlation or P2-3 streaming
  uses this state. The current append-only array is a P1 display slice, not the
  Phase-2 transcript spine.

### 2. CONFIRMED — MEDIUM — The primary projector fixture does not match the real assistant-frame shape

- **File anchor:** `app/renderer/src/transcriptProjector.test.ts:7-45`;
  real shape: `src/services/api/claude.ts:2371-2391`.
- **Finding:** the main test places text and `tool_use` in one assistant
  frame. The real streaming producer constructs `content: [contentBlock]` and
  yields one assistant frame per block. No projector test sends consecutive
  assistant frames with the same `message.id`, interleaves their stream events,
  or proves that sibling frames remain correctly grouped and ordered.
- **Concrete failure scenario:** a projector change deduplicates assistant
  frames by `message.id`, dropping the second parallel tool use. The current
  test remains green because it supplies both blocks in one frame.
- **Phase-2 impact:** P2-0's exhaustive fixture must include realistic ordered
  multi-frame sequences, not only one object per discriminant. Otherwise P2-2
  can pass unit tests while losing sibling tool cards on a real multi-tool turn.

### 3. CONFIRMED — MEDIUM — Headless tests do not lock in the normal-path `getTools()` fix

- **File anchor:** `app/sidecar/sessionController.ts:37-60`,
  `app/sidecar/sessionController.test.ts:8-15`,
  `app/sidecar/roundtrip.probe.test.ts:85-124`.
- **Finding:** the fix is real: the normal controller calls
  `getTools(appStateStore.getState().toolPermissionContext)`, and an independent
  read returned 28 tools. But its test only asserts controller construction and
  idle state. The round-trip test sets `CATCODE_SIDECAR_PROBE=1` and validates a
  hand-injected `tool_use`; it bypasses normal model tool configuration.
- **Concrete failure scenario:** a setup refactor restores `tools: []` or
  derives tools from a different context. All current desktop tests, including
  the injected raw-forwarding probe, can remain green while real turns become
  text-only again.
- **Phase-2 impact:** before the multi-tool transcript gate is trusted, add a
  normal-path assertion at the session-config seam that the exposed tools are
  non-empty and derived from the same permission context. This is regression
  coverage for an already-proven P1 defect, not a new feature.

### 4. CONFIRMED — LOW — A projector comment directs future domain state into layer 2

- **File anchor:** `app/renderer/src/transcriptProjector.ts:61-67`; current
  separation: `app/renderer/src/App.tsx:36-45`.
- **Finding:** the implementation currently respects the three-layer boundary:
  transcript and permissions use separate reducers. However, the projector says
  permission, goal, and abort events will become projector row kinds in later
  phases. That conflicts with PROGRAM-PLAN §5's requirement that domain
  services/selectors remain separate and never extend the transcript projector.
- **Concrete failure scenario:** P2-4 follows the local comment and adds
  permission queue/resolution state to `TranscriptState`; subsequent domains
  follow that precedent, turning the projector into the prohibited cross-domain
  reducer.
- **Phase-2 impact:** keep transcript-derived notices distinct from live domain
  state and make P2-4 consume its own selector/reducer, as the current
  `permissionState` implementation already does.

### 5. PLAUSIBLE — LOW — Malformed tool-use blocks become valid-looking, uncorrelatable rows

- **File anchor:** `app/renderer/src/transcriptProjector.ts:99-116`;
  asserted behavior: `app/renderer/src/transcriptProjector.test.ts:47-71`.
- **Finding:** block access is safely narrowed, but a `tool_use` needs only a
  string `name`; a missing/non-string id becomes `null` and a non-record input
  becomes `{}`. This is an explicit fallback, but it converts adapter drift into
  a normal-looking card rather than preserving a diagnostic/unhandled state.
- **Concrete failure scenario:** a changed or malformed runtime block has a
  valid name but no string id. The UI renders it, then the matching tool result
  cannot correlate and its derived status never completes.
- **Phase-2 impact:** P2-0 should decide fail-closed row requirements versus an
  explicit unknown/malformed row. P2-2 must not treat `null` as a usable
  correlation key.

## Carry-forward

| Item | Reason | Suggested Phase-2 owner | Source finding |
|---|---|---|---|
| Add stable row ids and retain message/block provenance | Required for one-frame-per-block grouping, streaming reconciliation, and stable UI updates | P2-0 projector completeness | 1 |
| Build a realistic ordered event fixture | Current combined-block fixture cannot catch sibling-frame loss or bad stream ordering | P2-0 fixture owner | 2 |
| Assert normal sidecar tool exposure/config alignment | Prevents recurrence of the `tools: []` defect while injected probes stay green | P2-0 with sidecar adapter owner | 3 |
| Keep permission/goal/abort domain state outside the transcript projector | Preserves PROGRAM-PLAN §5 layer 2/layer 3 separation | P2-0 and P2-4 owners | 4 |
| Define malformed block policy before tool-result correlation | Avoids valid-looking rows with unusable correlation keys | P2-0, consumed by P2-2 | 5 |

## Test evidence

| Evidence read or run | What it actually proves | What it does not prove |
|---|---|---|
| `bun test app/renderer/src/transcriptProjector.test.ts app/renderer/src/TranscriptView.test.tsx app/renderer/src/App.test.tsx app/sidecar/sessionController.test.ts` — 8 pass, 0 fail, 21 assertions | P1 text/tool mapping, malformed-block fallbacks, explicit no-ops, basic markdown/card rendering, app surface presence, and normal controller construction | Real per-block assistant sequences, stable row identity, stream reconciliation, tool-result correlation, or normal-path model tool availability |
| `bun test app/` — 122 pass, 0 fail, 295 assertions | Current desktop protocol, sidecar, renderer, replay, permission, and injected raw-forwarding tests are green | A live credentialed model turn; the `tool_use` round-trip test uses the probe adapter |
| `bunx tsc --noEmit -p app/tsconfig.json` — pass | The snapshot-isolated Electron/preload/renderer graph, including projector types, compiles | Runtime completeness of the SDK union or semantic correctness of unknown block handling |
| `bun run --cwd app renderer:build` — pass; generated CSS 8,246 bytes and contains `.flex`, `.rounded`, `.bg-app-bg`, and `.text-accent` | `theme.css:5` imports Tailwind, Vite's Tailwind plugin runs, and renderer utility classes are generated | Visual fidelity in a live Electron window |
| Direct evaluation of `getTools(getDefaultAppState().toolPermissionContext)` — 28 tools | The P1-3 `getTools()` claim is true for the current default app state | That `sessionController.test.ts` would catch future loss or divergence of the configured list |
| Snapshot comparison against `src/entrypoints/sdk/coreTypes.generated.ts` | The SDK snapshot content still matches the canonical generated type file apart from its snapshot header | Exhaustive projector behavior; most SDK variants still deliberately fall through |
| Source read at `src/services/api/claude.ts:2350-2392` | One assistant frame with one content block is yielded at each `content_block_stop`; this is provider-shared behavior | That the current projector preserves the shared message identity or that its tests model this sequence |

No live credentialed turn was run in this review. The operator evidence recorded
in `STATUS.md` remains the only evidence here that the normal model path emitted
and rendered real tools end to end.
