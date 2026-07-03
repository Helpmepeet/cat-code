# Permission boundary — C1–C4: the rich permission protocol through the sidecar

**Status: DECIDED 2026-07-03.** Branch `migration`. This settles the four open decisions the S2
spec raised (`specs/2026-07-03-S2-permission-update.md` §6) and **unblocks P2-4** (the Permissions
domain, the Phase-2 gate). Scope is the permission boundary only — the F3 session-addressing /
Phase-3 protocol-envelope work is a different decision and is not touched here.

The security baseline (`decisions/SECURITY-MINIMUM.md` — T4/T5a/T5b/T6/T7, plus the P1-0 additions
T6b and F6/F10) is **not weakened by anything below**; C1 restates T6b's guarantee in a form that
is equally strong and demonstrably enforced (§2, §7). All anchors re-verified against the working
tree on 2026-07-03; where this doc and source disagree, **source wins**.

| # | Question | Verdict |
|---|---|---|
| **C1** | "always allow" through the boundary | **DECIDED + IMPLEMENTED NOW** — suggestion **selection by index**, validated at the sidecar; renderer never authors update objects. Zero engine (`src/`) changes. |
| **C2** | mode switch | **DECIDED, spec'd for P2-4** — new inbound `permission.setMode` frame, session-destination only, `bypassPermissions` rejected at the boundary. Not implemented here. |
| **C3** | rules-editor read path | **DECIDED, spec'd for P2-4** — new read-only outbound `permission.context` snapshot frame, emitted on attach and on change, built from the engine's live context. Not implemented here. |
| **C4** | `deny.interrupt` | **CONFIRMED CUT** — `app.abort` already mass-denies all pendings and aborts the turn; no second kill path. |

---

## 1. The invariant, restated (why C1 is not a T6b weakening)

T6b's threat is **renderer authorship of durable policy**: a compromised renderer that can attach
`updatedPermissions` to an allow can install an arbitrary always-allow rule
(`persistPermissionUpdates`, applied+persisted in
`src/utils/permissions/PermissionPromptToolResultSchema.ts:95-106`). The P1-0 boundary therefore
rejects the key outright (`checkStrictKeys`, `app/sidecar/sidecarServer.ts:678`) and strips it in
the sanitizer backstop (`sidecarServer.ts:457`).

But the protocol has an asymmetry that makes a safe "always allow" possible: **the engine already
mints the rules itself.** An `ask` decision carries `suggestions?: PermissionUpdate[]`
(`src/types/permissions.ts:206`), and `createAppRuntimeCanUseTool` copies them onto the permission
request as `permission_suggestions` (`src/app-runtime/appRuntimeCanUseTool.ts:68`; request type
`SDKControlPermissionRequest`, `src/entrypoints/sdk/coreTypes.generated.ts:478-489`). The TUI's
"don't ask again" sends those suggestions back **verbatim** — allow-once is `onAllow(input, [])`
(`src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:346`), always-allow is
`onAllow(input, permissionResult.suggestions)` (`:399-404`), and the permanent flag is derived from
the updates being non-empty (`src/hooks/toolPermission/handlers/interactiveHandler.ts:154-166`,
`:275`).

So the boundary invariant is restated as:

> **No renderer byte ever becomes rule content, rule scope, or rule destination.** The renderer
> may (a) confirm or deny exactly what the engine gated (T6), and (b) **select, by index, among
> the update objects the engine itself minted for the exact pending request being answered** (C1).
> Everything else is rejected fail-closed.

Selection is not authorship. The worst a fully-compromised renderer gains from C1 is the ability
to accept the engine's own suggested rule for a prompt the engine raised — the same thing a human
click can do, and strictly less than what T5b already concedes (a compromised renderer can
auto-approve every prompt the engine raises, forever, invisibly). The one **marginal** power —
persistence beyond the compromised session — is analyzed and accepted in §7-A3.

---

## 2. C1 — "always allow" via suggestion selection (IMPLEMENTED)

### Inbound frame contract

`PermissionResponseInput` (`app/shared/protocol.ts:182-196`) gains one optional field on the allow
arm — additive, so `PROTOCOL_VERSION` stays `1`:

```jsonc
// "always allow": select engine-minted suggestion(s) by index
{ "type": "permission.response", "requestId": "<engine-minted>",
  "response": { "behavior": "allow", "updatedInput": {}, "applySuggestions": [0] } }

// allow once (both forms equivalent; TUI parity: allow-once sends [])
{ "response": { "behavior": "allow", "updatedInput": {} } }
{ "response": { "behavior": "allow", "updatedInput": {}, "applySuggestions": [] } }
```

The indices refer to `request.permission_suggestions` **of the pending request being answered** —
the renderer already receives that array raw on `permission.requested` (raw-forwarding). The
renderer renders the engine's rules; it never re-derives them (the prototype's `ruleImplication`
stays CUT per S2 §7).

### Sidecar validation rule (the T6b-preserving core)

Order in `handlePermissionResponse` (`app/sidecar/sidecarServer.ts:363`): **T5a pending lookup →
selection validation → T6/T6b sanitize → attach → resolve.**

`validateSuggestionSelection` (`sidecarServer.ts:745`) rejects fail-closed (error frame
`bad_request`, request **stays pending**) unless ALL of:

1. `applySuggestions` absent or an array (never coerced);
2. behavior is `allow` (a deny carrying a selection is rejected, not ignored);
3. length ≤ `MAX_SUGGESTION_SELECTIONS` (16, `app/shared/limits.ts:50` — structural bound; real
   suggestion lists are 1–3 entries);
4. the pending request actually minted a non-empty `permission_suggestions` array;
5. every entry is an integer in `[0, suggestions.length)`, no duplicates.

On success the sidecar attaches `updatedPermissions: structuredClone(selectedEngineObjects)`
(`sidecarServer.ts:419`) to the **already-sanitized** response. Two properties make this stronger
than any compare-what-the-renderer-sent scheme:

- the attached objects are **taken from the engine's own pending-request entry, never from the
  wire** — byte-fidelity to the engine's mint is by construction, not by comparison;
- the clone prevents the response from aliasing the pending request object.

The renderer-facing key allowlist becomes `{behavior, updatedInput, message, applySuggestions}`
(`sidecarServer.ts:678`). A raw `updatedPermissions` key is still **rejected** by F10 and still
**stripped** by the sanitizer backstop — the pre-existing T6b tests are untouched and green.

One implementation subtlety, so nobody "simplifies" it away: the shared Zod schema
(`appClientMessageSchema` → engine `outputSchema`) **strips unknown response keys**, so
`applySuggestions` is read from the raw frame after the Zod parse succeeds
(`sidecarServer.ts:393`) and validated structurally there. The engine's shared vocabulary is
deliberately not extended (see §3 on blast radius).

### Engine mapping — zero `src/` changes

The attached updates ride the existing path end-to-end:
`respondToPermissionRequest` (`src/app-runtime/AppSessionController.ts:87-100`) resolves the
pending promise → `normalizePermissionResponse` spreads the response
(`src/app-runtime/appRuntimeCanUseTool.ts:90-96`) →
`permissionPromptToolResultToPermissionDecision` applies them to the live
`ToolPermissionContext` **and** persists (`PermissionPromptToolResultSchema.ts:95-106` →
`applyPermissionUpdates` `src/utils/permissions/PermissionUpdate.ts:196`,
`persistPermissionUpdates` `:349`, `session`-destination skipping persistence via
`supportsPersistence` `:208-216`). Destinations are whatever the engine chose when minting (e.g.
`localSettings`, `src/tools/BashTool/bashPermissions.ts:2534`) — the renderer has no influence.
`permission.resolved` echoes the response **including** the attached updates, which is the
multi-window "permanent" signal and the audit trail.

### Relay note (main is UX-coercion, not the boundary)

`coercePermissionResponse` in Electron main (`app/main/main.ts:294`) passes a shape-valid
`applySuggestions` through and **drops the whole response** on a malformed one (fail-closed — a
silent field-drop would invisibly downgrade "always" to "once"). The sidecar remains the only
trust boundary (SECURITY-MINIMUM §2 R2).

### What C1 deliberately does NOT enable

All renderer-authored update flavors stay out; the affordance degrades to engine suggestions only:

- the TUI's **editable prefix rule** (`yes-prefix-edited` — user edits rule content,
  `BashPermissionRequest.tsx:348-357`, `bashToolUseOptions.tsx:56`);
- `yes-classifier-reviewed` client-built updates (`BashPermissionRequest.tsx:368-377`);
- plan-exit `allowedPrompts` addRules (Ant-only classifier feature,
  `ExitPlanModePermissionRequest.tsx:65-75`);
- `decisionClassification` (host-only telemetry field; nothing on this path consumes it).

If any of these is ever wanted through the boundary, it is a NEW decision with its own validation
design — do not bolt renderer-authored content onto `applySuggestions`.

### Tests (all in `app/sidecar/sidecarServer.test.ts`, passing)

- `:381` happy path — engine suggestion attached, deep-equal + cloned (not aliased), gated input
  still forwarded (T6 unchanged);
- `:422` empty selection = allow-once, nothing attached;
- `:453` out-of-range index → `bad_request`, request stays pending;
- `:484` selection against a request that minted no suggestions → rejected;
- `:515` non-integer / string / negative / duplicate / oversize / non-array → all six rejected;
- `:555` selection on a deny → rejected;
- `:586` two concurrent pendings: selection resolves against ITS OWN request's suggestions, the
  other stays pending (T5a discipline extended to selection).

Verification 2026-07-03: `bun test app/` **122 pass / 0 fail** (7 new C1 tests; every pre-existing
T6/T6b/F10 test untouched and green); `bunx tsc --noEmit -p app/tsconfig.json` clean;
`bun run --cwd app test:hardening` 9/9; `tsc -p app/sidecar/tsconfig.json` remains the
**pre-existing** P1-3 carry-forward red (5,642 errors, `MACRO`/strict-overlay class — zero errors
in any file this change touched).

---

## 3. C2 — mode switch: a dedicated inbound frame (SPEC — implement in P2-4)

**Verdict: approve a new inbound frame; do not reuse C1 for it; exclude `bypassPermissions` at the
boundary; session destination only.** Not implemented now: it needs capability threading through
`sessionController.ts` (below), and P2-4 wires the mode-switcher UI in the same change anyway.

Why C1 can't carry it: the engine does **not** mint per-mode suggestions — plan-exit's mode choice
is client-authored (`buildPermissionUpdates`,
`src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx:57-77`),
and a standalone mode switcher has no pending request to select from.

### Frame contract

```jsonc
{ "type": "permission.setMode", "requestId": "<client-request-id>", "mode": "acceptEdits" }
```

- **`mode` allowlist: `default | acceptEdits | plan | dontAsk`.** All four are within T5b's
  already-conceded surface: `acceptEdits` only removes prompts a compromised renderer could
  auto-approve anyway; `dontAsk` is strictly restrictive (converts ask → deny,
  `src/utils/permissions/permissions.ts:521-531`). `auto` is internal/feature-gated
  (`src/types/permissions.ts:28-36`) — excluded.
- **`bypassPermissions` is REJECTED at the sidecar**, always. It escalates beyond T5b: no
  per-action prompt is ever raised, killing both the round-trip and its audit trail, and the TUI /
  bridge double-gate it behind a launch-level trust flag
  (`isBypassPermissionsModeDisabled()` + `isBypassPermissionsModeAvailable`,
  `src/hooks/useReplBridge.tsx:427-440`; cycle gate `getNextPermissionMode.ts:42,62`). The
  sidecar's context ships `isBypassPermissionsModeAvailable: false`
  (`src/Tool.ts:142-150`) so it would also fail engine-side — but the boundary rejects it
  explicitly rather than leaning on that default. If the desktop app ever wants bypass, the grant
  must come from a **trusted surface** (Electron-main native dialog or launch flag), which is a
  separate future decision — do not widen this frame.
- **No `destination` on the wire — pinned `session` at the sidecar.** A renderer must never
  persist `permissions.defaultMode` (a compromised renderer writing
  `defaultMode: bypassPermissions` into `userSettings` would disarm every future session — a
  persistence escalation with no TUI analogue; TUI mode switching is session-state too).

### Apply idiom (the part that's easy to get wrong)

Mirror the bridge's remote mode switch (`useReplBridge.tsx:449-461`): policy guards first, then

```ts
setAppState(prev => {
  const current = prev.toolPermissionContext.mode
  if (current === mode) return prev
  const next = transitionPermissionMode(current, mode, prev.toolPermissionContext)
  return { ...prev, toolPermissionContext: { ...next, mode } }
})
```

— NOT a bare `applyPermissionUpdate({type:'setMode'})`, which skips the transition cleanup
(`prePlanMode` stash/clear, plan-exit flag, auto-mode strip/restore —
`src/utils/permissions/permissionSetup.ts:597`). The sidecar reaches the store by threading a
capability from `createSidecarSessionController` (which owns `appStateStore`,
`app/sidecar/sessionController.ts:37-43`) into `SidecarServerOptions`; construction site
`app/sidecar/index.ts:53-60`.

### Schema home

Sidecar-local: add `permission.setMode` to `checkStrictKeys` and validate with a sidecar-local
Zod schema. **Do NOT extend the engine's shared `appClientMessageSchema`**
(`src/web/appSessionProtocol.ts:43-48`) — the WS server shares it
(`AppSessionWebSocketServer.ts:113`) and must not silently start accepting a frame it has no
handler for. Phase-3's F3 envelope work owns any consolidation.

### Plan-exit composition

Plan-exit through this boundary = a plain C1-style allow on the `ExitPlanMode` request **plus** a
`permission.setMode` frame for the chosen resume mode (send `setMode` first; either order is a
benign one-extra-prompt race). The `allowedPrompts` rule flavor stays out (§2).

Frame limits: existing T7 caps cover it; a mode change is idempotent and cheap.

---

## 4. C3 — rules-editor read path: outbound snapshot frame (SPEC — implement in P2-4)

**Verdict: a read-only OUTBOUND `permission.context` `ServerFrame` kind** — no inbound query
needed, no engine types touched.

```ts
// app/shared/protocol.ts (app-owned)
export type PermissionContextFrame = {
  kind: 'permission.context'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  context: {
    mode: string
    alwaysAllowRules: Record<string, string[]>   // keyed by PermissionRuleSource
    alwaysDenyRules: Record<string, string[]>
    alwaysAskRules: Record<string, string[]>
    additionalWorkingDirectories: Array<{ path: string; source: string }>
    isBypassPermissionsModeAvailable: boolean
  }
}
```

- **Emit on attach** (immediately after `ready` — do NOT widen the engine-owned `AppReadyPayload`,
  `src/web/appSessionProtocol.ts:157-165`) **and on every change**, by subscribing to the
  sidecar's own `appStateStore` (`createStore(...).subscribe`, `src/state/store.ts:29-32`) and
  re-emitting when `toolPermissionContext` reference-changes. Store-subscription (not
  emit-after-boundary-writes) is required because the context also mutates **without** boundary
  involvement (PermissionRequest hooks apply+persist mid-turn,
  `src/utils/permissions/permissions.ts:443-452`).
- **Serialization:** the snapshot must be built as a JSON POJO — `additionalWorkingDirectories`
  is a `Map` in `ToolPermissionContext` (`src/types/permissions.ts:427-441`) and `checkJsonSafe`
  fail-closes on Maps (`app/shared/jsonSafe.ts:135-137`). Convert to the array-of-entries shape
  above at the sidecar.
- **Security:** it flows through `send()` like every outbound frame, so the F6 secret-key scan
  applies automatically (`sidecarServer.ts` send path; `app/shared/secretGuard.ts:52`). Content is
  permission policy the user already sees in the TUI; no credential-shaped keys exist in the
  snapshot type. Read-only, so T-neutral.
- **Faithfulness rule (S2 §6 C3):** the snapshot comes from the engine's live context object —
  never reconstructed renderer-side by replaying update echoes (settings-file and hook-applied
  rules would be invisible).
- **Writes:** reuse C1 (request-scoped selection). The P2-4 rules editor ships **read-only** plus
  the C1 always-allow affordance. General rule CRUD from the editor is NOT enabled at this
  boundary: adding allow rules or removing deny rules is exactly T6b's escalation. If a later
  phase wants editor writes, the sanctioned shape is **select-to-remove over the C3 snapshot**
  (the renderer references an existing engine-known rule string; restrictive changes only) — a
  follow-up decision, not this one.
- Renderer rule: don't render the editor before the first snapshot; a fresh snapshot supersedes
  any optimistic local state.

---

## 5. C4 — `deny.interrupt` stays cut (CONFIRMED)

`app.abort` already provides the affordance: it denies **all** pendings with the abort reason and
aborts the turn (`AppSessionController.ts:102-125`; S2 §2 rule 4). The per-card "deny and stop"
button maps to the existing `app.abort` frame. `checkStrictKeys` continues to reject
`deny.interrupt` (test `sidecarServer.test.ts` "F10 — deny+interrupt … is rejected"). No second
kill path is added, matching SECURITY-MINIMUM's one-channel posture.

---

## 6. Rejected alternatives

- **R1 — validated `updatedPermissions` subset** (renderer sends update objects; sidecar
  schema+destination allowlist): the renderer authors bytes, so the sidecar becomes a policy
  engine that must re-implement the engine's rule grammar (`Bash()` ≡ `Bash(*)` ≡ `Bash`
  normalization, destination semantics, future update types) and drifts. Strictly weaker than
  selection for strictly more code.
- **R2 — engine-side "apply update" control message**: new privileged engine surface duplicating
  an existing engine path; C1 needed zero engine changes. Bigger blast radius, same guarantee.
- **R3 — echo-suggestions-and-deep-equal** (renderer echoes full objects; sidecar compares):
  security-equivalent only if the compare is perfect; more bytes on the wire; breakable by benign
  re-serialization differences. Index selection is strictly simpler and carries no objects at all.
- **R4 (C2) — mode change as a C1 selection**: the engine mints no per-mode suggestions
  (plan-exit's are client-built), and a standalone switcher has no pending request.
- **R5 (C2/C1) — extend the shared `appClientMessageSchema`**: shared with the WS server; a new
  inbound type would parse there with no handler. Sidecar-local schema keeps the blast radius at
  the boundary that owns it.
- **R6 (C3) — widen `AppReadyPayload`**: engine-owned type; a separate app-owned frame kind keeps
  `app/shared/protocol.ts` the only change site.
- **R7 (C3) — renderer-side rule reconstruction from update echoes**: invisible settings/hook
  rules; permanent drift. Rejected by S2 §6 already; confirmed.

---

## 7. Adversarial self-review

- **A1 — Can a hostile renderer smuggle authorship through selection?** No. The wire carries only
  integers; the attached objects come from the sidecar's own pending-map entry for that requestId.
  There is no code path in which renderer bytes reach `updatedPermissions` — fidelity is by
  construction, not comparison (see §2 tests `:381`, `:586`).
- **A2 — TOCTOU between `permission.requested` and the selection?** The pending entry is set once
  (`AppSessionController.ts:213-219`) and nothing mutates `permission_suggestions` between mint
  (`appRuntimeCanUseTool.ts:62-74`) and resolve; the renderer's copy came from the same object via
  the raw-forwarded event. The response-side `structuredClone` prevents aliasing back into engine
  state.
- **A3 — Marginal power over T5b (the honest residual):** a compromised renderer can now make its
  approval **durable** (a persisted engine-scoped allow rule outlives the compromised session),
  which pure prompt-auto-approval cannot. Accepted because: the rule is engine-authored and
  gate-scoped (never broader than what the engine would have offered the human); the install is
  observable three ways (the `permission.resolved` echo carries the updates; the C3 snapshot
  displays them; they land in human-readable settings files); and the threat premise (T1-class
  renderer compromise) already concedes live auto-approval of everything. The mitigation for the
  family remains "keep T1/T2 impossible", per SECURITY-MINIMUM T5b.
- **A4 — Destination abuse?** Destinations ride inside engine-minted objects; the renderer cannot
  express one. `session`/`cliArg` skip persistence via `supportsPersistence`
  (`PermissionUpdate.ts:208-216`).
- **A5 — DoS via selection?** Bounded by `MAX_SUGGESTION_SELECTIONS` plus the existing T7
  frame/rate caps; validation is O(n) over ≤16 integers.
- **A6 — The `.catch(undefined)` trap (S2 §5):** the engine silently drops malformed
  `updatedPermissions`. C1's are engine-minted, so schema-valid by construction; the theoretical
  degradation is allow-once, identical to the TUI's failure mode.
- **A7 — Race with abort/multi-window:** selection validates against a pending entry; if abort's
  mass-deny or another window wins first, the answer gets `permission_not_found` — the normal S2
  §2 race, unchanged.
- **A8 — Zod-strip bypass:** reading `applySuggestions` from the raw frame is bounded by F10's key
  allowlist (the key is now allowlisted, values validated structurally) and carries indices only.
  No other raw-frame field is read.
- **A9 — Why is `dontAsk` in C2's allowlist but not the TUI cycle?** It is strictly
  capability-reducing (ask→deny); the prototype mode surface lists it; excluding it would buy no
  security. `bypassPermissions` is the only mode with real escalation, and it is rejected.
- **A10 — C3 leak surface:** rule strings are user-authored policy already shown by the TUI's
  `/permissions` surface; `scanForSecrets` guards key names on the frame like all outbound
  traffic. A user who writes a credential INTO a rule string exposes it to their own renderer —
  same exposure as the TUI. Accepted.

---

## 8. Carry-forwards (flagged, deliberately not solved here)

- **DEFECT → P2-4 must fix (same class as P1-3's `tools: []`):** the sidecar session builds its
  permission context from `getEmptyToolPermissionContext()`
  (`app/sidecar/sessionController.ts:37` → `AppStateStore.ts:535-538` → `src/Tool.ts:142-150`).
  Settings-file rules and `defaultMode` are **never loaded** into a desktop session (the CLI path
  is `applyPermissionRulesToPermissionContext`, `src/utils/permissions/permissionSetup.ts:1000`).
  Consequence today: a C1-persisted rule takes effect immediately in the same session (in-memory
  apply) and is correctly written to the settings file, but a **new** sidecar session will not
  honor it — and C3 snapshots would show empty rules — until session bootstrap wires the loader.
- **DR-2 (Phase-3, referenced not solved):** `persistPermissionUpdate` is read-modify-write with
  no cross-process lock — last-writer-wins under N-process
  (`reviews/2026-07-02-direction-review.md` §DR-2). C1 adds **no new settings-write path**; it
  reuses the engine's existing decision path, so DR-2's blast radius is unchanged.
- `decisionClassification` deliberately not exposed inbound (host-only; nothing consumes it here).
- ESLint root config still doesn't cover `app/**` (Phase-5 CI).
