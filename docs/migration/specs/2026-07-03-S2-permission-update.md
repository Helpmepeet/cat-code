# S2 — Permission request/response/update behavioral spec

**Status: SPEC, 2026-07-03.** Branch `migration`. This is the confirmed behavioral spec the
INVENTORY requires before P2-4 ("Permissions domain", `PermissionQueue` Faked? **yes (S2)**,
`PermissionRulesEditor` partial) wires anything. The real protocol is materially richer than
both the prototype's mock allow/deny queue **and** what P1-4 exercised (P1-4 drove exactly one
bare-allow round-trip). Every anchor re-verified against the working tree 2026-07-03; re-grep
symbols, line numbers drift. Where this doc and source disagree, **source wins**.

Companion: `2026-07-03-S1-streaming.md`. The security baseline (T5a/T6/T6b/T7,
`decisions/SECURITY-MINIMUM.md`) is a hard gate this spec layers on top of — §6 is explicit
about where the full protocol collides with it.

---

## 1. The round-trip pipeline (verified, end-to-end)

```
tool call → canUseTool chain → PermissionResult
  behavior 'allow'/'deny'  → returned immediately, NO app round-trip
  behavior 'ask'           → appRuntimeCanUseTool builds SDKControlPermissionRequest
                              (engine-computed permission_suggestions ride along)
  └─ AppSessionController.waitForPermissionResponse
       pendingPermissionRequests.set(requestId, …)      # Map — N concurrent pendings
       emit {type:'permission.requested', request}       # → sidecar → IPC → renderer
  └─ renderer answers: permission.response {requestId, response}
  └─ sidecar sanitizePermissionResponse                  # T6 echo-only, T6b strip (§6)
  └─ AppSessionController.respondToPermissionRequest
       unknown/duplicate requestId → false → error frame (T5a)
       resolve(response); emit {type:'permission.resolved', request, response}
  └─ permissionPromptToolResultToPermissionDecision
       allow: applyPermissionUpdates (in-memory) + persistPermissionUpdates (files)
              updatedInput {} ⇒ "use original input"
       deny:  message becomes the model-visible refusal; interrupt ⇒ abort turn
  └─ tool runs (or doesn't); turn continues
```

Anchors:

- **Gate + request build**: `createAppRuntimeCanUseTool`
  (`src/app-runtime/appRuntimeCanUseTool.ts:26-83`) — only an `ask` result reaches the app; the
  request is minted with `requestId = randomUUID()` and carries the ask-decision's
  `suggestions`/`blockedPath`/`message` as `permission_suggestions`/`blocked_path`/
  `decision_reason` (`:62-74`). `normalizePermissionResponse` (`:85-102`) backfills
  `updatedInput`/`toolUseID` engine-side.
- **Pending state machine**: `src/app-runtime/AppSessionController.ts` —
  `waitForPermissionResponse` `:203-220` (auto-deny if already aborted `:206-211`),
  `respondToPermissionRequest` `:87-100` (unknown id → `false`; delete-then-resolve makes a
  second answer to the same id also `false`), `abort()` denies **all** pendings with
  `{behavior:'deny', message: reason}` before aborting `:102-125` (mass-deny loop `:116-121`),
  `getPendingPermissionRequests()` snapshot for late attach `:78-81`.
- **Events**: `src/app-runtime/sessionEvents.ts:8-13` (`AppPermissionRequest`), `:30-39`
  (`permission.requested` / `permission.resolved` — resolved echoes request **and** response,
  the multi-window ack signal).
- **Request type**: `SDKControlPermissionRequest`
  (`src/entrypoints/sdk/coreTypes.generated.ts:478-489`): `subtype:'can_use_tool'`, `tool_name`,
  `input`, `permission_suggestions?: PermissionUpdate[]`, `blocked_path?`, `decision_reason?`,
  `title?`, `display_name?`, `tool_use_id`, `agent_id?`, `description?`.
- **Response schema**: `src/utils/permissions/PermissionPromptToolResultSchema.ts` (`Output` =
  `AppPermissionResponse`, `sessionEvents.ts:14`):
  - allow: `{behavior:'allow', updatedInput: Record<string,unknown> (required),
    updatedPermissions?: PermissionUpdate[] (malformed → dropped via .catch, not rejected),
    toolUseID?, decisionClassification?: 'user_temporary'|'user_permanent'|'user_reject'}`
  - deny: `{behavior:'deny', message: string (required), interrupt?: boolean, toolUseID?,
    decisionClassification?}`
- **Engine-side effect of a response**: `permissionPromptToolResultToPermissionDecision`
  (same file, bottom) — on allow, `updatedPermissions` are applied to the live
  `ToolPermissionContext` **and** persisted; `updatedInput: {}` means "use the original input"
  (mobile-push carve-out); `deny + interrupt` calls `toolUseContext.abortController.abort()`.
- **P1-4 proved the bare path live**: allow with `updatedInput` echo (T6), `updatedPermissions`
  stripped (T6b), deny with message, `Esc` dismiss (= just don't respond). Nothing beyond that
  is exercised yet.

**Concurrency facts P2-4 builds on:** one turn at a time per session (`submit` throws on
`activeTurn`, `AppSessionController.ts:131`), but **multiple permission requests can be pending
simultaneously within a turn** (parallel tool calls; the Map is the queue). There is **no
timeout** — an unanswered request pends until answered or the turn is aborted. "Keep pending"
is therefore free: do nothing.

---

## 2. The state machine (per request, renderer's view)

```
            permission.requested(request)
                     │
                 [PENDING]  ──────────────────────────────┐
                     │                                     │
        permission.response sent                     app.abort sent
                     │                                     │
        ┌────────────┴───────────┐                         │
   allow (sanitized §6)     deny {message}                 │
        │                        │                         │
        └──────────┬─────────────┘                         │
                   ▼                                       ▼
        permission.resolved(request, response)   permission.resolved × N
                   │                             (deny, message = abort reason)
               [RESOLVED]                        + abort.status events
```

Renderer rules:

1. **Queue = the set of `permission.requested` minus `permission.resolved`,** rebuilt on attach
   from `getPendingPermissionRequests()` (exposed via the ready payload / P1-0 replay). Never
   invent client-side ids — only engine-minted `requestId`s resolve (T5a).
2. **`permission.resolved` is the single dismiss signal** — it fires whether *this* window
   answered, another surface answered, or an abort mass-denied. Remove the card on resolved,
   not on send (the send can be rejected with `permission_not_found`, protocol.ts:117).
3. **Answering a request another path already resolved is a normal race,** not an error state:
   expect `permission_not_found` and treat it as "already handled".
4. **Turn-abort denies everything pending** with the abort reason as the deny message
   (`AppSessionController.ts:116-121`) — the prototype's per-card "Abort turn" button maps to
   the existing `app.abort` frame, not to a new permission verb.
5. A request arriving while `abort` is already requested is auto-denied engine-side
   (`:206-211`); the renderer may never see it as pending.

---

## 3. Update types × destinations (the full matrix)

`permissionUpdateSchema` — `src/utils/permissions/PermissionUpdateSchema.ts:42-78`. Destination
enum `permissionUpdateDestinationSchema` — `:27-40`. In-memory application
`applyPermissionUpdate` — `src/utils/permissions/PermissionUpdate.ts:55-188`; persistence
`persistPermissionUpdate(s)` — `:222-353` gated by `supportsPersistence` `:208-216`.
(The task brief's `permissions.ts:41-44` anchor is the *import* of these; the definitions live
in `PermissionUpdate.ts`. `permissions.ts:443-452` is a consumer — the PermissionRequest-hook
path doing apply+persist.)

| update type | payload | in-memory effect (`ToolPermissionContext`) | persisted effect (settings file) |
|---|---|---|---|
| `addRules` | `rules: {toolName, ruleContent?}[]`, `behavior: allow\|deny\|ask`, `destination` | append serialized rules to `always{Allow,Deny,Ask}Rules[destination]` | `addPermissionRulesToSettings` into `permissions.{allow,deny,ask}` |
| `replaceRules` | same as addRules | **replace** that destination's whole list for that behavior | overwrite `permissions.{behavior}` |
| `removeRules` | same as addRules | filter rules out (exact serialized match) | filter with parse→serialize normalization (`Bash()`≡`Bash(*)`≡`Bash`, `:277-287`) |
| `setMode` | `mode` (external enum), `destination` | `context.mode = mode` — destination **ignored** in-memory | `permissions.defaultMode` |
| `addDirectories` | `directories: string[]`, `destination` | Map insert, `source = destination` | `permissions.additionalDirectories` (deduped) |
| `removeDirectories` | `directories`, `destination` | Map delete | filter `additionalDirectories` |

Destinations (×6 types each — all combinations schema-legal):

| destination | meaning | persists? |
|---|---|---|
| `userSettings` | global `~/.claude` settings | ✅ |
| `projectSettings` | shared per-directory settings | ✅ |
| `localSettings` | gitignored local settings | ✅ |
| `session` | in-memory, this session only | ❌ (dies with the process) |
| `cliArg` | launch-flag scope | ❌ (not writable) |

Supporting enums/serialization: behavior `allow|deny|ask`
(`PermissionRule.ts:25-27`); rule value `{toolName, ruleContent?}` (`:35-40`) serialized as
`Tool` / `Tool(content)` (`permissionRuleParser.ts` — parens escaped, `Bash()`/`Bash(*)`
normalize to bare `Bash`); external modes `acceptEdits | bypassPermissions | default | dontAsk |
plan` (`src/types/permissions.ts:16-22`; internal adds feature-gated `auto`).

**⚠ Cross-process caveat (reference, not solved here — DR-2).** `persistPermissionUpdate` is a
read-modify-write via `updateSettingsForSource` with no cross-process lock. Under the locked
N-process topology, two sessions persisting rules concurrently are last-writer-wins — the same
shared-external-state class as the Codex token-rotation race
(`docs/migration/reviews/2026-07-02-direction-review.md` §DR-2, which already names
`persistPermissionUpdates` explicitly). P2-4 must not add its own settings-write path on top;
the DR-2 task owns the mitigation.

---

## 4. UI affordances each protocol piece implies (the P2-4 recipe map)

| protocol piece | UI affordance (prototype analogue) |
|---|---|
| `permission.requested` + pending Map | queue card(s); badge count; `paused` composer state (S1 §5) |
| `request.tool_name` / `input` / `title` / `display_name` / `description` | card header + payload preview (Bash command, Edit diff target, URL, …) |
| `request.decision_reason` | "why you're being asked" line (rule/mode/hook that forced the ask) |
| `request.permission_suggestions` | the **"Yes, and don't ask again for `<scope>`"** option — engine-authored; render its rules, don't re-derive them (`ruleImplication` in the prototype is a client-side fake of this) |
| `request.blocked_path` | filesystem-scope hint for directory prompts |
| allow + `updatedPermissions=[]` | "Yes" (allow once) — TUI: `onAllow(input, [])`, `BashPermissionRequest.tsx:346` |
| allow + `updatedPermissions=suggestions` | "Yes, don't ask again" — TUI sends the engine's suggestions back verbatim (`interactiveHandler.ts:154-166`; permanent-flag derived from non-empty updates `:275`) — **boundary-gated, see §6** |
| deny + `message` | "No, and tell Cat Code what to do differently" — the message is REQUIRED and is what the model reads; free-text feedback belongs here |
| deny + `interrupt` | "deny and stop the turn" — **CUT at this boundary**; `app.abort` already provides the equivalent (§2 rule 4) |
| `setMode` update / `set_permission_mode` control (`coreTypes.generated.ts:492-496`) | mode switcher (default / acceptEdits / plan / bypassPermissions / dontAsk) — **no app-seam path yet, see §6** |
| `addDirectories` update | "allow access to `<dir>`" affordance (`createReadRuleSuggestion`, `PermissionUpdate.ts:361-389`, shows the engine's own dir→rule idiom) |
| `permission.resolved` | card dismissal + cross-surface sync + activity un-pause |
| denial tracking (`denialTracking.ts:12`, `DENIAL_LIMITS`) | "recent denials" meter — real but **engine-internal**; read-only surface at best |

---

## 5. Exact payloads per path (copy-paste contract)

Renderer → sidecar frame (today's protocol, `app/shared/protocol.ts:179-181`):

```jsonc
// allow once (T6-conformant: echo or empty; sidecar forwards the GATED input regardless)
{ "type": "permission.response", "requestId": "<engine-minted>",
  "response": { "behavior": "allow", "updatedInput": { /* echo of request.input, or {} */ } } }

// deny with feedback (message required — it is the model-visible refusal)
{ "type": "permission.response", "requestId": "<engine-minted>",
  "response": { "behavior": "deny", "message": "Use pnpm, not npm" } }
```

Engine-level response shapes (what the sidecar mediates toward, full schema §1):

```jsonc
// "always allow" — engine semantics: allow + engine-authored suggestions echoed back
{ "behavior": "allow", "updatedInput": { …gated input… },
  "updatedPermissions": [ { "type": "addRules", "behavior": "allow",
      "rules": [{ "toolName": "Bash", "ruleContent": "npm test:*" }],
      "destination": "localSettings" } ] }

// mode change riding an allow (e.g. plan-exit picks the resume mode)
{ "behavior": "allow", "updatedInput": { … },
  "updatedPermissions": [ { "type": "setMode", "mode": "acceptEdits",
      "destination": "session" } ] }

// deny and kill the turn (host-only today)
{ "behavior": "deny", "message": "stop", "interrupt": true }
```

Semantics guaranteed by source:

- `updatedInput: {}` ⇒ engine substitutes the original input
  (`PermissionPromptToolResultSchema.ts`, mobile carve-out) — but the sidecar neutralizes this
  by always forwarding the gated input (§6), so through THIS boundary `{}` is just "confirm".
- Malformed `updatedPermissions` are **dropped, not fatal** (`.catch(undefined)`), so a bad
  update array silently degrades to allow-once. Don't rely on engine-side validation errors to
  surface UI bugs.
- On allow, updates are applied to the live context **and** persisted in the same call
  (`permissionPromptToolResultToPermissionDecision`); `session`-destination updates skip
  persistence by `supportsPersistence`.

---

## 6. Where the full protocol collides with the boundary (surface, don't silently resolve)

Current renderer-facing contract is deliberately narrower than the engine schema.
`PermissionResponseInput` (`app/shared/protocol.ts:179-181`) = bare allow/deny.
`checkStrictKeys` (`app/sidecar/sidecarServer.ts:638` — `allowedResponseKeys =
{behavior, updatedInput, message}`) **rejects** any frame carrying `updatedPermissions`,
`interrupt`, `toolUseID`, or `decisionClassification`; `sanitizePermissionResponse`
(`:420-468`) additionally forwards only the engine-gated input (T6 echo-only, F1 strong form)
and documents the T6b strip.

Consequences P2-4 must design around — **decision open, options flagged**:

- **C1 — "always allow" cannot flow today.** The engine's own idiom (return
  `permission_suggestions` as `updatedPermissions`) is exactly what T6b blocks, because it
  would let a compromised renderer author durable policy. The T6-spirit-preserving extension:
  the renderer answers with a **selection reference** (e.g. indices into
  `request.permission_suggestions`), and the **sidecar** re-attaches the engine-authored update
  objects after validating selection ⊆ suggested — renderer confirms engine-authored data,
  never authors rules. Weaker alternative: allowlist a validated `updatedPermissions` subset
  (schema + destination allowlist) at the sidecar. Bigger alternative: a separate engine-side
  "apply update" control message. Pick ONE in P2-4 and record it in `decisions/`; the TUI's
  editable-prefix rule (`bashToolUseOptions.tsx:56` — user edits rule content) is
  renderer-authored content and stays out unless the chosen design explicitly validates it.
- **C2 — mode switcher has no seam path.** In-engine, mode changes ride `setMode` updates or
  the `set_permission_mode` control request; the app protocol has no inbound frame for either
  (inbound = submit/abort/permission.response/ping only, P1-0 default-deny). A GUI mode
  switcher (prototype `PermissionRules.jsx:233-238`, plan-exit mode options
  `Permissions.jsx:95-105`) requires a deliberate protocol addition with its own sanitizer —
  same decision moment as C1.
- **C3 — rules editor has no read path.** `PermissionRulesEditor` needs the current rules +
  mode + directories, i.e. a redacted `ToolPermissionContext` snapshot; the seam exposes no
  query for it (controller exposes only abort state / goal / pendings). P2-4 (or a follow-up)
  must add a read-only snapshot frame — read-only, so it's T-neutral, but it must come from the
  engine's context, not from replaying updates the renderer sent (settings-file rules would be
  invisible).
- **C4 — `deny.interrupt` stays cut.** Equivalent affordance exists via `app.abort`
  (mass-deny + turn abort, §2). Don't add a second kill path.

None of these reopen locked decisions; they are the S2-shaped extension points the P1-0
protocol's `PROTOCOL_VERSION` slot exists for.

---

## 7. Prototype real vs invented (CUT list)

From `~/catcode_prototype/cat-app/Permissions.jsx` (⚓6) / `PermissionRules.jsx` (⚓2):

**Real-backed (keep, wire to §1–§5):**
- Head-of-queue, resolve-then-next, numbered/arrow-key options, Esc = reject-ish
  (`PermissionQueue`, `Permissions.jsx:327-410`). Multiple pendings are real (§1); the
  strict-priority *lane* ordering mirrors the REPL's real dialog priority
  (`getFocusedInputDialog`, `src/screens/REPL.tsx:2203`) — but as **UI policy**, since the
  protocol itself is an unordered pending set.
- Option semantics "Yes" / "Yes, and don't ask again for `<scope>`" / "No, and tell Cat Code
  what to do differently" (`optionsFor`, `Permissions.jsx:87-133`) — maps 1:1 to §5 payloads;
  the scope shown must come from `permission_suggestions`, not the invented `ruleImplication`
  string.
- Rule CRUD grouped by tool with behavior pills + destination badges
  (`PermissionRulesEditor`, `PermissionRules.jsx:207-318`) — maps to
  add/replace/removeRules × destinations (§3), pending C3's read path.
- Plan-exit "approval is a MODE choice" (`Permissions.jsx:95-105`) — real TUI behavior
  (`ExitPlanModePermissionRequest`), lands as a `setMode`-class decision → gated by C2.
- Denial tracker (`PermissionRules.jsx:148-179`) — real counters (`denialTracking.ts`), but
  engine-internal: read-only surface, no protocol for it yet.
- "Managed-rules-only" notice — real (`shouldAllowManagedPermissionRulesOnly`,
  `permissionsLoader.ts`), display-only.

**Invented — CUT (or re-derive):**
- The whole mock queue driver: `window.catcodeRequestPermission`, `buildPermReq` keyword
  classifier, three-way `'allow'|'always'|'deny'` string decisions (`Chat.jsx:562-629`). The
  real decision object is §5's payloads.
- `ruleImplication` client-side rule synthesis (`Bash(npm:*)` guessed from the first token) —
  the engine sends real suggestions; rendering a guessed rule that differs from what would be
  persisted is a correctness bug, not chrome.
- `stale` cards as a first-class item state — reality is the §2 resolved/`permission_not_found`
  race; model it as "resolved elsewhere", not a separate queue entry kind.
- `onKeepPending` as an action — no-op in the real protocol (no timeout); at most a UI
  "snooze" that reorders local display.
- The inline debug panel's fabricated "last request / matched rule" strings
  (`PermissionRules.jsx:303-310`) — a real variant would surface `decision_reason` from
  requests (`PermissionDecisionDebugInfo.tsx` is the TUI reference), not fixtures.
- Lane accent colors/tags as *protocol* concepts — pendings are just requests; lanes are
  display grouping.

---

## 8. Decided / open

**Decided (by source):** §1 pipeline; §2 state machine (Map-queue, no timeout, mass-deny on
abort, resolved-as-dismiss, T5a id discipline); §3 full matrix incl. persistence gate; §5
payloads incl. `{}`-confirm and malformed-updates-drop semantics; T6/T6b behavior of the
current boundary; DR-2 ownership of the settings-write race.

**Open (must be decided in P2-4, flagged here):** C1 always-allow transport (recommended:
suggestion-selection validated at the sidecar), C2 mode-change inbound frame, C3 rules/context
read path. Each is a protocol-version bump decision to be recorded under
`docs/migration/decisions/`, and none may weaken T5a/T6/T6b/T7 as stated in SECURITY-MINIMUM.
