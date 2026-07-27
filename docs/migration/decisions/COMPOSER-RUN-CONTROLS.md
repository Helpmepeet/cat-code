# P4-24c — the composer Model / Reasoning / Fast faces are live per-session run-controls

**Status: RULED + BUILT 2026-07-13.** Makes the P4-24 read-only composer faces (Model,
Reasoning-effort, Fast) interactive: clicking each changes THIS session's setting and the change
reflects **live in the same session, no respawn**. Builds ON TOP of the read-only half a prior
session shipped (the `DiagnosticsSnapshot` model/effort/fast fields + the borderless faces in
`ComposerActionsBar.tsx`). All anchors verified against the working tree; where this doc and
source disagree, source wins. The account switcher is OUT of scope (P4-5); Recap is out (no seam).

## The decision — reuse the engine's OWN per-session setters, no new state logic

Each face drives the engine's real `/model`, `/effort`, `/fast` write, dispatched through a
domain executor seam (the `agentModeDomain` recipe), NOT a re-implementation and NOT a respawn:

- **Model** — the engine reads `getMainLoopModel()` (→ `getMainLoopModelOverride()`) per turn
  (`QueryEngine.ts:283`). The desktop sidecar's app-state store has **no `onChangeAppState`
  wired** (the REPL's is what normally syncs `AppState.mainLoopModel` → the global override at
  `onChangeAppState.ts:104-112`), so the executor sets the override **directly**:
  `setSessionProvider(resolveModelSelectionProvider(model))` +
  `setMainLoopModelOverride(model)`
  (`src/bootstrap/state.ts:864,878`), plus the store's `mainLoopModel` for display. N-process
  (LOCKED) scopes the process-global override to THIS session. **Session-scoped only** — NOT
  persisted to global startup preference or user settings from a composer tweak.
- **Effort** — the engine reads `AppState.effortValue` per request (`query.ts:744`). The executor
  calls the engine's own `executeEffort` (`src/commands/effort/effort.tsx:113` — validates the
  level / `auto` / `unset`, persists via `setEffortValue`/`toPersistableEffort`) and applies the
  returned value to the store. Takes effect live on the next turn.
- **Fast** — the executor calls the engine's own `applyFastMode` (`src/commands/fast/fast.tsx:15`,
  newly `export`ed) — clears the cooldown, honours `isFastModeSupportedByModel`, and (when
  enabling on a non-fast model) switches to a fast-capable one; the executor then re-syncs the
  model override for that switch (the same sync `onChangeAppState` would do).

The read model is a live `RunControlsSnapshot` built from the engine's OWN
`getModelOptions()` / `getSupportedEffortLevels()` / `modelSupportsEffort()` / fast-mode helpers —
never a renderer-invented model list.

No locked decision is touched: transport, N-process, raw-event fidelity, die-with-window, and the
two-id model are all unchanged. Live per-session setters need none of them.

## Live re-emit — the load-bearing part (proven with a live-path test)

The P4-14 diagnostics snapshot is spawn-frozen, so a `*.set` cannot move the face through it.
Instead a **dedicated `run-controls.snapshot`** re-broadcasts on change. The domain's `subscribe`
wraps the app-state store's subscription with **change-detection over only the run-control fields**
(model / effort / fast), so it re-emits on a real change — whether from a `*.set` verb OR any
engine-side path that moves those fields — and stays silent through the per-token store mutations
of a turn (no re-broadcast storm). The verb handler does NOT re-broadcast explicitly: the setter's
store mutation drives the subscription, so the frame proven on the wire is the REAL live path, not
a synthetic action-driven one (the 2026-07-09 gate lesson). Boundary tests
(`sidecarServer.test.ts`) send a valid `model.set` and assert a fresh `run-controls.snapshot` with
the new model; the domain LIVE test (`runControlsDomain.test.ts`) drives the REAL executor and
asserts `getMainLoopModelOverride()`/`getMainLoopModel()` flip and `AppState.effortValue`/`fastMode`
take effect.

## The wire path (app-owned inbound verbs — the P4-15 / P4-8b template)

Like the P4-5 account verbs, the P4-8b agent-mode set, the P4-15 workspace-trust accept, and the
P4-19 settings write, these are **app-owned inbound vocabulary** the engine's shared
`appClientMessageSchema` does NOT carry. Three distinct verbs under one family
(`RUN_CONTROL_VERB_TYPES = ['model.set','effort.set','fast.set']`), chosen over one parameterized
verb so each carries exactly its own bounded value and gets its own closed `checkStrictKeys`
allowlist entry:

1. `ComposerActionsBar` face → a borderless popover (Model list / effort levels+Auto / Fast toggle).
2. App → `getBridge().runControlVerb(sessionId, verb)` (HC3 fixed preload sender
   `catcode:run-control-verb`); the renderer authors ONLY the value/selection + a `requestId`.
3. Electron main light-coerces `verb.type ∈ RUN_CONTROL_VERB_TYPES` and forwards (NOT the trust
   boundary).
4. **Sidecar (the trust boundary)** validates with `checkStrictKeys` (closed key allowlist per
   verb) + a sidecar-LOCAL Zod discriminated union (`runControlVerbMessageSchema`), then dispatches
   to `runControlsDomain.setModel/setEffort/setFast` → the engine's own setter. A `run-control.result`
   frame echoes the `requestId` (T5a-analog); the `run-controls.snapshot` re-broadcast follows from
   the store subscription.

## Security posture (SECURITY-MINIMUM — hard gate, all preserved)

- Closed inbound allowlist validated **at the sidecar**, never only at the preload; boundary tests
  accept a valid frame and reject malformed ones (non-string `model`, non-boolean `active`, missing
  `requestId`, extra key → `bad_request`, NO result frame, executor never called; domain-absent →
  `internal_error`, fail-closed).
- The renderer authors ONLY a value/selection — a model id from the sidecar-minted option list, an
  effort level string, or a boolean. No engine object, no path (HC1), no token crosses either way.
  Secrets stay engine-side; the read snapshot is secretGuard-clean by construction (model ids /
  effort levels / booleans only). Directional frame limits (`MAX_FRAME_BYTES` in /
  `MAX_OUTBOUND_FRAME_BYTES` out) unchanged; `MAX_TEXT_FIELD_CHARS` bounds the value strings.
- New bridge method `runControlVerb` added to the hardening bridge-method allowlist; `test:hardening`
  19/19 (bridge exposes exactly the allowlisted methods).

## Provider conditionality (from source, not the mock)

- **Model options** come from the engine's `getModelOptions()` (`src/utils/model/modelOptions.ts`)
  — tier/provider/allowlist-dependent. The 2026-07-13 OpenAI-only desktop filter was reversed by
  the operator's 2026-07-27 Anthropic-restoration goal. Before a session has spent tokens, an
  OpenAI-started session may show credentialed Anthropic options as well; selecting one resolves
  to the configured Anthropic route (first-party, Bedrock, Vertex, or Foundry) through
  `resolveModelSelectionProvider()`. GPT-family selections resolve to OpenAI. The
  provider-local Default option is carried as `null`; selecting it clears the explicit model
  override without crossing provider families.
- **Effort options** come from `getSupportedEffortLevels(model)` and the control is shown only when
  `modelSupportsEffort(model)` — so `gpt-5.6-luna` (no `ultra`) and non-effort Anthropic models get
  the right set, matching `ReasoningChip`'s intent. The snapshot distinguishes the raw selection
  from the effective applied tier after env/session/default precedence, so the face does not claim
  an effort value the request path will clamp or override. A model change that does not support the
  raw selected tier reconciles the selection back to Auto, so every visible effective tier has a
  truthful checked-row state.
- **Fast** is offered only when `isFastModeSupportedByModel(model)` and enabled only when
  `isFastModeAvailable()`; the real `getFastModeUnavailableReason()` becomes the disabled tooltip.
  When off AND the model can't run fast, the ⚡ is hidden. The sidecar repeats both gates at the
  mutation boundary, so a forged/stale renderer request cannot enable unavailable Fast mode.

Provider-family selection locks as soon as the first submit is accepted (not after usage settlement).
The lock is explicit session state, seeded from restored provider-bound history rather than inferred
only from cost counters. The picker, sidecar domain, `/model`, model catalog, and `/switch-account`
all enforce it; a rejected selection returns a correlated `run-control.result`. Resume seeds the
provider/model from the latest real assistant message in the restored transcript (excluding
`<synthetic>` local-command output and API-error rows) before constructing QueryEngine, so a Claude
session cannot silently resume on today's OpenAI default (and vice versa).

## Parity (§0 flags)

- **🔁 adapted** — the Fast face is offered only when the model supports fast (or it is already on
  so it can be turned off), rather than auto-switching an arbitrary model to Opus. The user picks a
  fast-capable model first. Provider-local Default is built.
- Failed `run-control.result` frames are consumed by `verbAckResultState` and surfaced as danger
  toasts; successful writes remain silent because the live snapshot already updates the face.
- **UNVERIFIED (operator GUI)** — the popover open/click/keyboard interaction and the live face
  update are hover/click surfaces; headless tests cover the reducer, the SSR-rendered chips, the
  boundary, and the live re-emit, but the operator drives the final GUI acceptance.
