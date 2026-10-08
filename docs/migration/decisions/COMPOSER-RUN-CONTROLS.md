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

The operator supplied the untracked local reference
`docs/design-html/2026-10-08-cache-expired-notice.html`. The settled visual is
an amber clock immediately before the active-account face, with the former
context-warning face's 22px size, 14px glyph, 2px stroke and warning tone.
It is display-only, outside toolbar roving navigation. Its hover label reads
exactly **Cache expired**, using the composer's raised-surface, seam, typography
and shadow treatment. There is no native title, click action or popover.
The separate context-low triangle and its popover are removed by explicit user
decision; the context ring's pressure tones and usage panel remain.

**Operator amendment, 2026-10-08:** the original guaranteed-next-request-miss
requirement left the first implementation inactive. The operator subsequently
approved **estimation**. The clock now represents an idle-time estimate, not a
provider-issued expiry deadline or a promise that the next request misses.
Its settled visual and exact hover label remain unchanged.

### Provider estimates and evidence

| Actual request route | Idle estimate | Evidence and limit |
| --- | --- | --- |
| Codex/GPT, including GPT requests from an Anthropic-labelled session | 24 hours | Conservative retention-policy lead: the public SDK describes `prompt_cache_retention: "24h"` as a maximum policy, independently of the newer 30-minute minimum TTL. A captured Codex response also echoes `24h`. This is not a verified per-entry deadline for the current ChatGPT backend; it may evict much sooner. Eligible input is at least 1,024 tokens. |
| First-party Claude | Configured 5 minutes or 1 hour | Live duration comes from the engine's own `getCacheControl({querySource:"sdk"})`, not the Codex policy. Cache-read/write usage must be observed. Reported one-hour writes take precedence over a shorter hint. Matching requests outside this session can refresh shared prefixes, so the display remains an estimate. |
| Bedrock, Vertex and Foundry Claude | Same engine-selected 5-minute/1-hour duration when model identity and usage can be matched | Bedrock's one-hour environment opt-in is honored by the existing engine helper. Cloud isolation/routing can change reuse; no new cloud-provider usage probe was made. Canonical model names must match the actual response. Unknown deployment aliases remain unavailable. |
| Historical Claude responses | Reported write TTL, otherwise conservative 1 hour | A cache-read count alone does not state its TTL. The longer fallback avoids inventing a five-minute expiry for an old one-hour entry. |
| Custom endpoints, unmatched models and dynamic `opusplan` routing in Plan mode | Unknown | Model strings alone do not establish their current cache route. No clock until there is usable, correctly paired evidence. |

Provider documentation:

- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
- [OpenAI API prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
  The newer 30-minute value is a **minimum**, not the point at which entries die.
- [Pinned public SDK retention contract](https://github.com/openai/openai-python/blob/4e152cdefe1844c2d5d78653310e9b9c0195c44e/src/openai/types/responses/response_create_params.py#L169-L201)
  distinguishes maximum retention from minimum lifetime.
- openai/codex#32037 contains the historical `24h` response echo, including
  `store:false`. It is a captured lead, not a reproduced current-server guarantee.
- In openai/codex#18815, an OpenAI contributor said on 2026-04-21 that expiry
  information was unavailable to clients. That older statement does not prove
  it can never become available.
- [Prompt-cache diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics)
  can compare requests after sending them. No preflight validity query was found;
  applicability to this ChatGPT OAuth route remains unverified.
- [AWS prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html).
- [Vertex Claude prompt caching](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/prompt-caching)
  was fetched, but only navigation was available. It is not treated as verified
  TTL evidence.

Existing response data showed a Codex cache read after a 14.5-minute diagnostic
gap, ruling out a blind five-minute countdown. It also exposed an important
serialization seam: saved Codex assistant frames can have zero initial usage.
Final counts arrive in later stream events and completed
`codex_stream_surface` diagnostics. No new credentialed request was made.

### Observation, transport and restoration

The sidecar observes raw engine-originated main-thread assistant/stream events.
It folds final usage rather than treating early zeros as a cache miss.
Ordinary tool/user activity and subagent frames do not renew the live estimate.
Model, effort, Fast or permission-mode changes, compaction, and account switches
invalidate the old observation instead of carrying it to another request path.

The existing read-only snapshot carries `cacheExpiresAt` plus `cacheExpired`
at snapshot time. Both are optional additions; there is no new inbound command
or protocol-version change. The renderer derives display state from the deadline,
updates while idle, catches elapsed time on focus/visibility, and cleans up its
timer/listeners. A fresh observed response clears the icon. Retained deadlines
remain display-only after park/disconnect; they never arm a control.

History uses the real API-response timestamp, not transcript length, file mtime,
cache `writtenAt`, or session creation. The existing bounded run-facts reader
excludes synthetic/error rows, invalid/future timestamps, model mismatches and
compaction-preserved stale responses. For valid GPT rows with zero initial usage,
it can use a completed matching-model stream-surface diagnostic from the same
bounded tail. Prefix-only old diagnostics cannot distinguish same-model
subagents, so that fallback is conservative matching-model activity in the owning
transcript, not proof of main-thread reuse. Missing usable evidence stays unknown.

Live resume seeds from these same facts; cached previews receive the optional
deadline without a new model turn. The derived-facts stamp is 2. New cache writers
use `transcript-cache-v3`, because older readers reject the extra field and can
delete an artifact they cannot parse. Reads fall back through v2 then v1; normal
writes and startup GC leave old-generation copies untouched. Explicit session
removal still deletes all copies. Canonical transcripts, settings and credentials
are not migrated. The worker boundary accepts only the optional bounded numeric
deadline in addition to its existing exact key list.

### Operator check

No GUI launch or driving is authorized by this work. After choosing to run a
live check, launch **Cat Code Dev** yourself:

```sh
cd /Users/pt/cat-code && CATCODE_TEST_CWD_ALLOWLIST=/Users/pt/cat-code CATCODE_DEBUG_STATE=1 bun run --cwd app dev
```

Wait for `[main] renderer ready`. Open an existing GPT session whose last usable
API activity is more than 24 hours old. Its live or cached composer should show
the amber clock immediately before the account, without needing a new request.
Hover it: the label must read exactly “Cache expired”. Clicking must do nothing.
A recent eligible session should show no clock; session length alone is irrelevant.

Confirm there is no context-low triangle. A high-context session should retain
its amber/red ring and usage panel. If you choose to send an ordinary request,
the clock should clear when its final usage arrives; no extra paid probe is needed.
Older cache metadata may require the background enrichment pass before the
preview deadline appears. An existing dev process/sidecar retains loaded code,
so use a fresh dev launch to exercise this change.

Native hover appearance and current-backend lifetime remain unverified. Headless
checks prove the estimator and display plumbing, not that every cache actually
dies at the estimated deadline.

## Parity (§0 flags)

- **🔁 adapted** — the Fast face is offered only when the model supports fast (or it is already on
  so it can be turned off), rather than auto-switching an arbitrary model to Opus. The user picks a
  fast-capable model first. Provider-local Default is built.
- Failed `run-control.result` frames are consumed by `verbAckResultState` and surfaced as danger
  toasts; successful writes remain silent because the live snapshot already updates the face.
- **UNVERIFIED (operator GUI)** — the popover open/click/keyboard interaction and the live face
  update are hover/click surfaces; headless tests cover the reducer, the SSR-rendered chips, the
  boundary, and the live re-emit, but the operator drives the final GUI acceptance.
