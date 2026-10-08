# P4-24c — the composer Model / Reasoning / Fast faces are live per-session run-controls

**Status: RULED + BUILT 2026-07-13.** Makes the P4-24 read-only composer faces (Model,
Reasoning-effort, Fast) interactive: clicking each changes THIS session's setting and the change
reflects **live in the same session, no respawn**. Builds ON TOP of the read-only half a prior
session shipped (the `DiagnosticsSnapshot` model/effort/fast fields + the borderless faces in
`ComposerActionsBar.tsx`). All anchors verified against the working tree; where this doc and
source disagree, source wins. The account switcher is OUT of scope (P4-5); Recap is out (no seam).

## The decision — reuse the engine's OWN per-session setters, no new state logic

Each face drives the engine's real `/model`, `/effort`, `/fast` write, dispatched through the
sidecar's `runControlsDomain` executor seam, NOT a re-implementation and NOT a respawn:

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

## The wire path (app-owned inbound verbs)

Like the P4-5 account verbs, P4-15 workspace-trust accept, and P4-19 settings write, these are
**app-owned inbound vocabulary** the engine's shared
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
- **Per-row effort options** (`RunControlModelOption.effortOptions`, added 2026-09-06) answer the
  same two engine functions for a row the user has NOT picked yet: the option's `value` is a
  selection, so it is resolved through the engine's own `parseUserSpecifiedModel` /
  `getDefaultMainLoopModel` first, then read with `modelSupportsEffort` /
  `getSupportedEffortLevels` (`effortOptionsForSelection`, `app/sidecar/runControlsDomain.ts`).
  Resolution is the whole point: `modelSupportsEffort` is false for the alias `opus` and true for
  the id it resolves to. It exists because the model card became two faces — pick a model, then set
  that model's effort — and the card has to know BEFORE the click whether a row leads anywhere,
  which `effort.options` cannot say because it answers only for the current model. Additive; the
  snapshot's own `effort` slice is unchanged.

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

## Cache-expired indicator (2026-10-08)

The operator settled the visual in
[`2026-10-08-cache-expired-notice.html`](../../design-html/2026-10-08-cache-expired-notice.html):
an amber clock immediately before the active-account face, with the former
context-warning face's 22px size, 14px glyph, 2px stroke and warning tone.
It is display-only, outside toolbar roving navigation. Its hover label reads
exactly **Cache expired**, using the composer's raised-surface, seam, typography
and shadow treatment. There is no native title, click action or popover.
The separate context-low triangle and its popover are removed by explicit user
decision; the context ring's pressure tones and usage panel remain.

**Truth requirement:** expired means the next request will actually miss the
provider cache, not that the local session has been idle for a typical retention
period or that an earlier request reported zero cached tokens.

`RunControlsSnapshot.cacheExpired` is an additive, read-only nullable boolean.
Only literal `true` renders the indicator. `false` clears it; null or an absent
field means unknown and also hides it. The existing snapshot transport and
per-session reducer carry the field unchanged. The composer reads only the live
snapshot, so a retained snapshot cannot keep an expiry claim after disconnect,
parking or restart. No inbound verb, renderer timer, persisted cache deadline,
provider request, cache-key change or caching-policy change is added.

### Provider evidence and present limitation

As inspected on 2026-10-08, **all current routes emit null**. This is a rendered
indicator and conservative read seam, not an active expiry detector.

| Actual request route | Established evidence | Why no expiry claim |
| --- | --- | --- |
| OpenAI/Codex, including GPT models selected in an Anthropic session | `resolveRequestProvider` routes `gpt-*` to OpenAI. `getAnthropicClient` uses `createCodexFetch`; HTTP and WebSocket requests use ChatGPT's Codex backend. The adapter sends `store:false` and a stable account/model/conversation-derived `prompt_cache_key`, with no explicit cache retention option. It maps `input_tokens_details.cached_tokens` to cache-read usage and reports cache creation as zero. | No backend expiry timestamp or maximum-retention guarantee is exposed. Public API retention rules cannot be assumed to govern ChatGPT OAuth traffic. A past cache read or miss does not predict the next request. |
| First-party Anthropic API and Claude subscription traffic | Explicit ephemeral breakpoints use the default 5-minute TTL or the session-latched, query-source-gated 1-hour TTL in `getCacheControl` / `should1hCacheTTL`. Anthropic documents free refresh on cache use, TTL measured from request start, and organization/workspace isolation rather than session isolation. | Matching requests can refresh shared prefixes outside this process. Tools/system/message breakpoints are separate, so expiry of a conversation entry also does not establish a full-request miss. Subscription/internal `scope:global` behavior is not covered by a public next-request guarantee. |
| Bedrock Claude | The SDK route uses the same explicit cache controls; `ENABLE_PROMPT_CACHING_1H_BEDROCK` can opt into 1 hour. AWS documents model-dependent 5-minute/1-hour TTLs, reset on successful cache hits, prefix lookback, and cross-region routing. | No session-exclusive cache or authoritative live expiry signal. Shared-prefix refresh and region selection prevent a local-idle guarantee. GPT Bedrock documentation does not describe this application's GPT route, which resolves to Codex. |
| Vertex Claude | The engine uses `AnthropicVertex` and the Claude-shaped breakpoint/usage path. Anthropic's platform documentation lists 1-hour caching availability and organization-level isolation for Google Cloud. | The separate Google page did not expose usable article text to the documentation fetch. No provider-specific next-request guarantee was established, and shared-prefix refresh remains unobservable. |
| Foundry Claude | The engine uses `AnthropicFoundry` and the same Claude-shaped controls. Anthropic documents 1-hour availability and workspace isolation for Foundry. | Workspace isolation is not session-exclusive. No authoritative next-request expiry signal or refresh visibility was established. |
| Custom base URLs, deployment IDs and fetch overrides | Routing and model names alone do not establish the endpoint's cache contract. | Unknown contracts stay unknown. |

Provider documentation:

- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
- [OpenAI API prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
  Current GPT-5.6-and-later documentation gives a **minimum** 30-minute
  eligibility window and permits longer retention, not an expiry deadline.
  Older API models distinguish typical inactivity windows from maximum
  in-memory/extended retention. None establishes this Codex backend's deadline.
- [AWS prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html).
- [Vertex Claude prompt caching](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/prompt-caching)
  was fetched, but only navigation was available. It is not treated as verified
  TTL evidence.

Existing response data corroborates caching, not predictable expiry. A bounded
2026-10-08 Codex transcript sample reports 296,320 cached tokens at 07:27:09 UTC,
after its preceding cache diagnostic at 07:12:39 UTC. Those are completion
diagnostics, not a controlled measurement of request-start inactivity, but they
rule out deriving an expired indicator merely from the diagnostic gap. An
existing 2026-07-28 Claude Opus 4.6 response reports 14,470 cache-write tokens,
7,333 cache-read tokens, and a creation breakdown of 14,470 five-minute tokens
and zero one-hour tokens. No sampled response supplies a live expiry deadline.
No new credentialed request was made for this investigation, and cloud-provider
usage was not observed.

Relevant engine owners: `src/utils/model/providers.ts`,
`src/services/api/{client,claude,codex-fetch-adapter}.ts`,
`src/utils/api.ts` (`splitSysPromptPrefix`) and
`src/utils/forkedAgent.ts` (`CacheSafeParams`). Forks deliberately share the
parent's prefix; the diagnostic TTL buckets in
`promptCacheBreakDetection.ts` are described as likely causes, not provider
expiry guarantees, and cannot drive this indicator.

### Operator check

No GUI launch or driving is authorized by this work. After choosing to run a
live check, launch **Cat Code Dev** yourself:

```sh
cd /Users/pt/cat-code && CATCODE_TEST_CWD_ALLOWLIST=/Users/pt/cat-code CATCODE_DEBUG_STATE=1 bun run --cwd app dev
```

Wait for `[main] renderer ready`, open a project or an existing session, and
confirm there is no context-low triangle beside the context ring. A session
whose existing context is high should retain its amber/red ring and usage
panel. Do not send paid turns solely to make the context grow.

All present providers are unknown, so the live app must show no cache clock,
including after more than five minutes idle. The mock's state switches show
the settled warm/expired/hover/context-low visual for comparison. Expired and
hover rendering are covered with synthetic snapshot tests only; they cannot
be honestly triggered from a real provider with the current evidence. Live
expired-state visual acceptance remains unverified.

## Parity (§0 flags)

- **🔁 adapted** — the Fast face is offered only when the model supports fast (or it is already on
  so it can be turned off), rather than auto-switching an arbitrary model to Opus. The user picks a
  fast-capable model first. Provider-local Default is built.
- Failed `run-control.result` frames are consumed by `verbAckResultState` and surfaced as danger
  toasts; successful writes remain silent because the live snapshot already updates the face.
- **UNVERIFIED (operator GUI)** — the popover open/click/keyboard interaction and the live face
  update are hover/click surfaces; headless tests cover the reducer, the SSR-rendered chips, the
  boundary, and the live re-emit, but the operator drives the final GUI acceptance.
