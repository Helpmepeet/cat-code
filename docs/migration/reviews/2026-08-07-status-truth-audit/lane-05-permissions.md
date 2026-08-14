# Lane 05 — Permissions, end to end

**Auditor verdict:** RED
**Rows audited:** 4 · TRUE 2 · OVERSTATED 0 · FALSE 0 · STALE 2 · UNVERIFIABLE-HEADLESS 0

All source citations are against committed `HEAD` (`d85f770`). `PermissionRulesEditor.tsx`,
`PermissionModeChip.tsx`, `permissionDomain.ts` and `sessionController.ts` are dirty in the
working tree from a concurrent session; that is recorded as context in F1, not as a finding.

## Row verdicts

### P2-4 — Permissions domain, real queue + round-trip (the domain-recipe template)

**Verdict:** STALE — headline TRUE; the C2 sub-claim "bypass rejected — decision §3" was
deleted from the boundary by `b74b583` (2026-08-06). See F1.

**Claims checked:**
1. C3 `permission.context` snapshot carries mode + settings-loaded rules + additional dirs.
2. C1 always-allow = engine suggestion applied live, panel updates with no reload.
3. Allow-once and deny both resolve the engine request.
4. C2 `permission.setMode` round-trips, session-only, **bypass boundary-rejected**.
5. Domain uses `transitionPermissionMode` and reads/subscribes the SAME store `canUseTool` reads.
6. §8 fix: the sidecar loads REAL settings rules, not `getEmptyToolPermissionContext`.
7. UI = `PermissionQueue` + `PermissionRulesEditor`, read-only C3 + C1 selection writes.
8. "This templates the domain recipe every later W4 domain copies."

**Evidence:**
- (1) `app/sidecar/sidecarServer.ts:3955-3985` `buildPermissionContextSnapshot` emits mode, the
  three rule maps cloned by source, `ruleMetadata` built with the engine's own
  `permissionRuleValueFromString`, additional dirs, and the two display facts.
  Emission is store-subscription driven (`:482-487`), so engine-side mutations with no boundary
  involvement (C1 applies, hooks) still produce a snapshot.
- (2) `sidecarServer.ts:4033-4092` `validateSuggestionSelection` — index selection only, into
  `request.permission_suggestions`; non-array, non-integer, negative, out-of-range, duplicate,
  oversize, selection-on-deny, and no-suggestions all reject fail-closed. `:2337-2346`
  re-attaches `structuredClone(selection.updates)` — the engine's own objects. T6b holds.
- (3)/(4) `handlePermissionResponse` `:2284-2305` looks the requestId up in
  `controller.getPendingPermissionRequests()` before anything else (T5a). `handleSetMode`
  `:1639-1755`. **Sub-claim 4 fails:** there is no `bypassPermissions` check anywhere in
  `handleSetMode`; `bypassPermissions` is in `PERMISSION_SET_MODE_MODES`
  (`app/shared/protocol.ts:99-107`) and `permissionSetModeMessageSchema` (`:3620-3624`) accepts it.
- (5) `app/sidecar/permissionDomain.ts:102-111` (`transitionPermissionMode`), `:114-116`
  (`appStateStore.getState().toolPermissionContext`). That is the same field the engine's gate
  reads at `src/utils/permissions/permissions.ts:1282-1289`.
- (6) `app/sidecar/sessionController.ts:130-172` builds the context from
  `initialPermissionModeFromCLI` + `initializeToolPermissionContext` + the CLI's two post-steps,
  mirroring the engine runtime at `src/main.tsx:1452`, `:1808`, `:1828-1831`. Consumed at
  `sessionController.ts:286-301`. **No stub context at this seam.**
- (7) `PermissionQueue.tsx:59-84`, `PermissionRulesEditor.tsx:126-340`. Note the rules editor no
  longer mounts under Settings (CC-19 moved it); it mounts on the session inspector
  (`MetadataInspector.tsx:388-397`, `showModes={false}`) and mode switching lives on
  `PermissionModeChip` in the composer.
- (8) Template judgement below.

**Reachable-path trace (C2):** `ComposerActionsBar.tsx:1212` `PermissionModeChip` →
`App.tsx:2722-2724` → `preload.ts:107 setPermissionMode` → `sidecarServer.handleSetMode` →
`permissionDomain.setMode` → store → `subscribeToolPermissionContext` → `permission.context`
frame → `permissionState.ts:302-309` → chip re-renders. User action: click the mode chip in the
composer rail.
**Reachable-path trace (C1/queue):** engine `appRuntimeCanUseTool.ts:62-73` mints the request →
`permission.requested` → `permissionState` → `App.tsx:4296 PermissionQueue` → `PermissionPrompt`
rows → `onAllow(applySuggestions)` → `respondToPermission` → sidecar.

**Is the recipe sound?** Yes, with one named weakness. The four properties every later domain
copies are correct and are the reason this seam has no stub-context defect: (a) a narrow
capability type with zero transport knowledge; (b) `create…Domain(appStateStore)` implemented with
the engine's OWN idioms rather than a re-derivation; (c) change emission by store subscription,
not by emit-after-boundary-write, so engine-internal mutations are not lost; (d) read-only
display facts computed at snapshot time so the renderer cannot reconstruct policy.
**The weakness:** the recipe puts *policy enforcement at the boundary and application in the
domain*, with no domain-side backstop. `permissionDomain.ts:98-101` asserts in a comment that
"`bypassPermissions` reaches here only when the trusted launch flag enabled it" — that guard was
deleted from `handleSetMode` and the domain applied the mode anyway, comment intact. A single
deletion in one file silently removed a recorded security gate. Any later domain that gates a
privileged verb the same way carries the same single-point-of-failure.

**Anchor drift:** row cites no `file:line` for the domain, so none in STATUS. In-code drift:
`sessionController.ts:121-124` cites `src/main.tsx:1787-1811` / `:1802-1811`; actual is `:1808`
and `:1828-1831`.

### P4-42 — Permission prompts show raw JSON instead of the command or the diff

**Verdict:** TRUE (the row's own status is 🟡 headless-green, operator GUI pending, which is honest)

**Claims checked:**
1. Each family promotes the field that tool's own `renderToolUseMessage` renders, keyed on
   `tool_name`.
2. The map keys are the engine's `*_TOOL_NAME` constants behind each `case` in the engine's
   tool-object switch.
3. Edit renders a change view over `old_string`/`new_string` with NO line numbering.
4. A tool outside the map renders the request input, OPENED.
5. Fence honoured: `TranscriptView.tsx` untouched; AskUserQuestion / ExitPlanMode still `denyOnly`.
6. The card gained one focusable `Show input` / `Hide input` `<button aria-expanded>`.

**Evidence:** `permissionPromptModel.ts:453-481` `previewShapeForTool` (Bash/PowerShell→`command`,
Edit→`old_string`/`new_string`, Write→`content`, Read→`file_path`, Glob/Grep→`pattern`,
WebFetch→`url`, Skill→`skill`, NotebookEdit→`notebook_path`); `:508-530` `buildChangeLines`
produces `{kind,text}` only, no number field exists to render;
`PermissionPrompt.tsx:163` `useState(preview === null)` opens the disclosure when nothing could be
promoted; `:437-444` the disclosure button. Engine anchors re-verified:
`src/tools/BashTool/toolName.ts:2` `'Bash'`, `src/tools/FileEditTool/constants.ts:2` `'Edit'`,
`src/tools/SkillTool/constants.ts:1` `'Skill'`, `src/components/permissions/PermissionRequest.tsx:47-81`
is still the tool-object switch, `src/app-runtime/appRuntimeCanUseTool.ts:65` `tool_name: tool.name`.
`denyOnly` is applied at `PermissionQueue.tsx:65`; plan requests never reach this queue
(`permissionState.ts:267-282`). No interpolated Tailwind classes: `PermissionPrompt.tsx:30-34` is a
static `Record` of literal class strings.

**Reachable-path trace:** engine `canUseTool` → `permission.requested` → `permissionState` →
`App.tsx:4296` `PermissionQueue` (docked above the composer, chat view) → `PermissionPrompt` →
`PermissionPreviewBlock` (`:616-654`). User action: any gated Bash/Edit/Write call.

**Anchor drift:** STATUS cites `PermissionPrompt.tsx:154-170` for the disclosure; actual is
`:437-444`. STATUS cites `appRuntimeCanUseTool.ts:66`; actual `:65`. Its self-declared drift
("§07 rows citing `PermissionPrompt.tsx:88-107` / `:109-148` shifted by ~13 lines") is now much
larger: the whole card was rebuilt on 2026-08-07 (F3).

### P4-43 — The permission card's advertised keyboard shortcuts are dead

**Verdict:** STALE — the mechanism the row describes was narrowed by `20fdf1a` (2026-08-03) and
relocated by `3b9f798` (2026-08-07). In the dominant flow the keys are still dead. See F2.

**Claims checked:**
1. The keyboard answers the same engine-minted request id the buttons do; T5a untouched.
2. The `role="alertdialog"` trap is real and the card marks itself `data-permission-key-host`.
3. The target card takes focus on appear and hands it back on unmount.
4. The listener is a `document` listener that did not move; `dedicatedFlowOwnsKeyboard` untouched.
5. The hint renders only while `keyboardTarget && keysLive && !denyOnly`.
6. Focus on the disclosure button, an option button, or the deny-feedback input makes keys dead.

**Evidence:**
- (1) TRUE. `permissionState.ts:267-282` `selectVisiblePermission` picks the card;
  `App.tsx:2306-2311` derives `permissionKeyTargetRequestId` from the same value; the card's
  `pickAt` (`PermissionPrompt.tsx:216-224`) calls the same `onAllow`/`onDeny` the rows do. The
  renderer still mints no request id.
- (2) TRUE. `PermissionPrompt.tsx:314` `role="alertdialog"`, `:310` `data-permission-key-host`,
  predicate at `permissionPromptModel.ts:65-111` (`closest()` match, then `hasAttribute`).
- (3) **Narrowed.** `PermissionPrompt.tsx:183-211`: if `document.activeElement` is an input,
  textarea, or contenteditable (`isEditableElement`, `:51-56`), the effect returns WITHOUT
  focusing. The composer is a contenteditable div (`ComposerInput.tsx:325,346`) and nothing blurs
  it on submit, so after the ordinary "type a prompt, press Enter" the card never takes focus and
  none of the four keys fire until the user clicks the card. The hint correctly hides in that
  state, so nothing lies — but the advertised keys are unavailable in the common path.
- (4) **Superseded.** The listener now lives in the card (`PermissionPrompt.tsx:244-292`), moved by
  `3b9f798`; it is still a `document` listener and `dedicatedFlowOwnsKeyboard`
  (`App.tsx:2300-2302`) is intact, so the double-resolve guard survives.
- (5) TRUE, at `:294` and `:435-436`.
- (6) Partly superseded: the deny-feedback `<input>` no longer exists — `e1d5ba7` rebuilt the card
  as a select list whose deny row calls `onDeny()` with no message. Buttons are still in
  `FOCUSED_KEY_OWNER_SELECTOR`, so the disclosure and option rows do disable the keys.

**Reachable-path trace:** `App.tsx:2306-2311` → `PermissionQueue.tsx:56-67` `keyboardTarget` →
`PermissionPrompt.tsx:183-211` focus effect + `:244-292` listener. Mount point is the chat pane;
only the active pane is ever handed a target (`App.tsx:2699-2703`).

**Anchor drift:** every anchor in the row has moved. `PermissionPrompt.tsx:90` →`:314`;
`:104-124` → `:183-211`; `:126`/`:253-257` → `:294`/`:435-436`;
`permissionPromptModel.ts:24-78` → `:65-111`; `App.tsx:2001-2003` → `:2300-2302`.

### CC-13 — Settings → Permissions stuck on "Waiting for the engine's permission context…"

**Verdict:** TRUE

**Claims checked:**
1. The all-or-nothing `context === null` gate is gone; no state renders a never-resolving wait.
2. "Default mode" shows the persisted `permissions.defaultMode` SETTING with a source badge, or an
   explicit "not set" / "unknown", never a borrowed session value.
3. The session's live mode moved under a "This session" heading keeping the
   `Current permission mode: <mode>` aria-label.
4. `permissionDefaultMode` rides the EXISTING `settings.snapshot` frame, additive, read-only, and
   is deliberately excluded from `EDITABLE_SETTINGS`.
5. `defaultMode` resolves on its own axis, not the top-level `seen` set.
6. The no-session case is a terminal statement, not a wait.
7. Live-path proof: a real settings read through the engine's own `getSettingsForSource`.

**Evidence:** `PermissionRulesEditor.tsx:126-182` renders the Default-mode section unconditionally,
outside the `context` guard; `:143-162` the three-state read (`set` / `not set` / `unknown`) with
`SourceBadge`; `:186-205` the "This session" heading and the preserved aria-label;
`:334-341` the terminal "No session is attached…" statement. `app/shared/protocol.ts:793`
`permissionDefaultMode?: { value, source }` on `SettingsSnapshot` (additive, no new frame kind).
`app/sidecar/settingsDomain.ts:172-184` resolves it high→low OUTSIDE the `seen` set, with the
deep-merge rationale in the comment; `:374` reads layers via the engine's own
`getSettingsForSource`. `rg 'Waiting for the engine'` over `app/` returns only test assertions and
a `userVisibleText.test.ts` fixture — the string is gone from production source.

**Reachable-path trace:** sidecar `getSettingsForSource` → `buildSettingsSnapshot` →
`settings.snapshot` frame → `settingsState.ts:134-137 selectPermissionDefaultMode` → two consumers:
`MetadataInspector.tsx:388-397` (tab ⋯ → Session metadata, `App.tsx:3142`) and
`SettingsShell.tsx` `PermissionsPane` (`:644-700`). Neither can render a never-resolving wait.

**Anchor drift:** the row's cited `PermissionRulesEditor.tsx:35-41` and
`SettingsShell.tsx:349-364` no longer exist as described — CC-19 (`deae5ec`, 2026-07-27) moved the
live half off Settings entirely, one day after CC-13 landed. The bug stays fixed; the pane the row
describes is not the pane that ships. Recorded as F4 (Low).

## Findings

| # | Severity | Row | Defect | Evidence | Failure scenario |
|---|---|---|---|---|---|
| F1 | Critical | P2-4 | The sidecar's `bypassPermissions` gate (PERMISSION-BOUNDARY.md §3, 2026-07-13) was deleted. `handleSetMode` no longer checks `isBypassPermissionsModeAvailable`, so a `permission.setMode {mode:'bypassPermissions'}` frame is applied unconditionally and every subsequent tool call auto-allows. The decision doc still mandates the gate; the engine's bypass killswitch (`checkAndDisableBypassPermissions`) is never called anywhere in `app/`; `permissionDomain.ts:98-101` and `PermissionModeChip.tsx:16-20,85-88` still assert the gate exists. The only remaining guard is the renderer's disabled button — the inverted trust boundary the security baseline forbids. Removed by `b74b583` (2026-08-06), a commit titled "deliver a mid-response message to the running turn" whose body says "No new frame kind, preload channel, inbound vocabulary or error code". Its boundary test was rewritten from "rejected without a launch flag" to "available without a launch flag". Deliberate at code level, unratified at decision level, unrecorded in STATUS. | removed hunk in `git show b74b583 -- app/sidecar/sidecarServer.ts`; current `sidecarServer.ts:1639-1665` (no bypass branch); `docs/migration/decisions/PERMISSION-BOUNDARY.md:196-212`; `src/utils/permissions/permissions.ts:1286-1289`; `app/sidecar/sidecarServer.test.ts` "C2 — bypassPermissions is available without a launch flag" | A compromised or buggy renderer sends one `permission.setMode` frame and every later `Bash`, `Write` and `WebFetch` in that session executes with no prompt and no audit row. The operator sees a mode chip change, nothing else. |
| F2 | Medium | P4-43 | The card takes focus only when the previously focused element is not editable. The composer is a contenteditable div that keeps focus through submit, so in the ordinary "type a prompt, press Enter, card appears" flow the card never focuses and Enter / N / ⌫ / Esc do nothing until the user clicks the card. The hint hides correctly, so the row's honesty claim holds, but its headline ("make the advertised keys work") is not delivered on the dominant path. Narrowed after the row was written, by `20fdf1a`. | `PermissionPrompt.tsx:183-198` (early return on `isEditableElement`), `:51-56`; `ComposerInput.tsx:325,346` (contenteditable), no `blur()` on submit anywhere in `ComposerInput.tsx` / `App.tsx` | User submits a prompt, a Bash permission card appears, they press Enter expecting the highlighted row to confirm. Nothing happens. They must click the card first. |
| F3 | Medium | P4-42 · P4-43 | STATUS does not record the permission-card rebuild. Four commits on 2026-08-07 (`e1d5ba7`, `39096bf`, `3b9f798`, `fee4292`) replaced the Allow/Deny-button card with the prototype's select list, moved the keyboard into the card, and deleted the deny-feedback input. The newest STATUS rows for this surface are still P4-42/P4-43 (2026-07-31) and describe the superseded design; `rg 'select list' docs/migration/STATUS.md` returns nothing. Every anchor in both rows has moved. | `git log --oneline -- app/renderer/src/PermissionPrompt.tsx`; STATUS lines 400-401 | A reader trusting STATUS believes the shipped card has a deny-feedback input and an App-level keyboard listener. Neither exists. Both rows' operator-GUI steps target a UI that is gone. |
| F4 | Low | CC-13 | CC-13's cited Settings pane no longer exists: CC-19 (`deae5ec`, 2026-07-27, one day later) moved the whole live permission half to the session inspector. The row's "P4-34 Lane 2 is now reachable" claim is true only via the inspector route, not the one described. | `SettingsShell.tsx:628-644` (comment: rendered on `MetadataInspector` instead); `MetadataInspector.tsx:388-397` | Anyone following CC-13's description clicks Settings → Permissions and does not find the rules, mode or classifier sections it says it restructured. |
| F5 | Low | P2-4 | In-code anchor drift: `sessionController.ts:121-124` cites `src/main.tsx:1787-1811` / `:1802-1811` for the CLI bootstrap it mirrors; actual is `:1808` and `:1828-1831`. The mirroring itself is correct. | `app/sidecar/sessionController.ts:119-137`; `src/main.tsx:1452,1808,1828-1831` | A future session verifying the "same source as the engine" property follows a dead anchor. |

## Operator steps required (UNVERIFIABLE-HEADLESS rows only)

None of the four rows is graded UNVERIFIABLE-HEADLESS, but two findings need a live run to settle:

- **F1 (do this first).** Launch a fresh dev app with NO `CATCODE_ALLOW_BYPASS` set. Open a
  session, click the permission mode chip in the composer rail, and check whether "Bypass" is
  selectable. At HEAD the renderer disables it; a concurrent session's uncommitted edit to
  `PermissionModeChip.tsx` removes that disable. Either way the sidecar accepts the frame, so the
  question for you is whether opening bypass in the app picker is a decision you made. If it is,
  `PERMISSION-BOUNDARY.md` §3 and §A8 need amending and P2-4's row needs correcting. If it is not,
  the gate deleted in `b74b583` needs restoring in `handleSetMode`.
- **F2.** Fresh dev app. Click into the composer, type `run ls`, press Enter, and when the
  permission card appears press Enter again WITHOUT clicking anything. Expected at HEAD: nothing
  happens and no `↑↓ · 1–9 · ↵ · esc` hint is shown. Then click once on the card's body (not on a
  row or a button) and press Enter: the highlighted row should now resolve.

## Nits

- `SettingsShell.tsx` `PermissionsPane` renders the raw engine token (`acceptEdits`, `dontAsk`) via
  `String(row.read.value)`, while `PermissionRulesEditor` renders human labels ("Accept edits",
  "Don't ask") for the same setting. Two vocabularies for one value across two surfaces.
- Em-dash sweep clean across all six owned renderer files: every `—` hit is a code comment.
- No interpolated Tailwind arbitrary-value classes anywhere in the lane's files; the diff washes are
  a static `Record` (`PermissionPrompt.tsx:30-34`).
- `readPermissionDisplayFacts()` runs twice per app-state notification inside
  `subscribeToolPermissionContext` and reaches `getMainLoopModel()`. Guarded by try/catch and
  correct, but it is on a hot path during streaming.
