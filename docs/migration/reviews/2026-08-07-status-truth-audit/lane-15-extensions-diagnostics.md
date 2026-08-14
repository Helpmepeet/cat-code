# Lane 15 — Settings extensions, remote, diagnostics, retention

**Auditor verdict:** YELLOW
**Rows audited:** 4 · TRUE 2 · OVERSTATED 1 · FALSE 0 · STALE 1 · UNVERIFIABLE-HEADLESS 0

Audited at `HEAD = d85f770`. None of this lane's owner files are dirty in
`git status`, so every anchor below is committed behavior, not another session's
work in flight.

## Row verdicts

### P4-47 — Retention `0` destroys history silently (A) + Remote rail advertises a cut SSH mode (B)

**Verdict:** TRUE (the row is `🟡 headless green`, GUI sitting owed; it does not
claim the dialog was seen)

**Claims checked:**
1. `cleanupPeriodDays: 0` opens an `SAModal` confirmation before anything is written.
2. The gate covers BOTH commit triggers (blur and Enter) through one pure decision.
3. Cancel restores the value still in effect.
4. A danger-toned warning persists on the row while a destructive value is RESOLVED.
5. The domain is NOT narrowed (7/45/365/3650 still commit ungated).
6. No second sentinel: `0` stays a value, `null` stays the clear channel, told
   apart structurally in `validateEditableSettingWrite`.
7. An EMPTY field was a second silent route to `0` (`Number('') === 0`), now gated.
8. `app/shared/settingsEditable.ts` untouched by the fix.
9. STATUS's own correction: the sweep is NOT reached from this app's engine
   processes, so the shipped copy promises no trigger.
10. (B) The Remote rail description names the bridge, its command filter, and
    connecting a remote session — no SSH mode.

**Evidence:**
- `app/renderer/src/settingsScope.ts:978-1003` — `selectSettingsIntCommit` is the
  single decision. `:994-996` rejects an empty/whitespace draft as `invalid`
  before `Number()` can turn it into a zero (claim 7). `:1001-1002` returns
  `{kind:'confirm'}` for a declared destructive value, `{kind:'write'}` otherwise.
- `app/renderer/src/SettingsEditors.tsx:503-530` — `commit()` switches on that
  decision; `:547` `onBlur={commit}` and `:549-553` Enter both call the same
  `commit`, so neither trigger is a hole (claim 2). `:560-570` mounts
  `DestructiveValueDialog` only on `pending`; `onCommit` (the actual write) fires
  only from `onConfirm` at `:564-568` (claim 1).
- `app/renderer/src/SettingsEditors.tsx:583-609` — the dialog is the shared
  `SAModal` with `onClose={onCancel}`, so Escape/backdrop land on cancel.
- `app/renderer/src/settingsScope.ts:1011-1013` + `SettingsEditors.tsx:532-536` —
  cancel repaints the field with the value still in effect (claim 3).
- `app/renderer/src/settingsScope.ts:951-962` + `SettingsEditors.tsx:204,210` —
  the persistent warning rides `Field`'s `error` slot, and `:958` correctly
  suppresses it on an `overridden` row (a value that is not in effect).
- `app/shared/settingsEditable.ts:271-277` — control is `{kind:'int', min:0,
  max:3650}`; no value except `0` is declared destructive, so the domain is not
  narrowed (claim 5).
- `app/shared/settingsEditable.ts:414-428` — `value === null` returns
  `{ok:true, clear:true}` BEFORE `validateEditableSettingValue`, so `0` and the
  clear channel are structurally distinct (claim 6). File carries no destructive
  logic (claim 8).
- `app/renderer/src/settingsScope.ts:913-928` — the copy. No em dash, no
  engineering notes, and it deliberately names no trigger ("The deletion is not
  immediate, but once it runs it cannot be undone").
- (B) `app/renderer/src/settingsScope.ts:333-342` — the `remote` rail item reads
  `'The Remote Control bridge, its command filter, and connecting a remote
  session'`, with a code comment citing `PAIRED-DEVICES.md` §1-§3. `rg -i ssh`
  over `app/renderer/src` returns no user-visible hit. Claim 10 holds.

**The destruction path itself, traced (the lane's headline question):**
Retention `0` still destroys history. The fix converts *silent* into *confirmed*;
it does not disarm the value, and STATUS does not claim it does.
- Write suppression: `src/utils/sessionStorage.ts:1409-1419` `shouldSkipPersistence()`
  returns true when `getSettings_DEPRECATED()?.cleanupPeriodDays === 0`; it gates
  `appendEntry` (`:1578`) and `materializeSessionFile` (`:1429`). Real and
  unconditional.
- Deletion: `src/utils/cleanup.ts:25-31` `getCutoffDate()` returns
  `now - 0ms === now`, so `cleanupOldSessionFiles` (`:155-156`) treats every
  stored transcript as expired.
- Trigger: `cleanupOldMessageFilesInBackground` (`src/utils/cleanup.ts:575`) is
  reached ONLY from `startBackgroundHousekeeping`
  (`src/utils/backgroundHousekeeping.ts:31`, sweep call at `:57-60`), whose only
  two call sites are `src/main.tsx:2919` and `src/screens/REPL.tsx:4474` — both
  terminal-engine entrypoints. `rg` over `app/sidecar` finds no import of either.
  STATUS's correction to its own prompt is verified: the desktop app has no
  deletion trigger of its own.
- **Therefore the real hazard is cross-surface, and it is not stated anywhere:**
  the desktop app writes the same `~/.cat-code` settings the terminal CLI reads,
  so confirming `0` in the app arms a sweep that fires in the user's next
  *terminal* `cat-code` session, ~10 minutes in. The dialog copy ("the deletion
  is not immediate") is accurate and is the right call for a copy that must not
  guess a trigger, but a reader of STATUS should not conclude the app is safe
  because the app cannot run the sweep. It writes the fuse; another process
  lights it.

**Reachable-path trace:** `App.tsx:3218` mounts `SettingsShell` when
`activeView === 'settings'` → rail item `privacy`
(`settingsScope.ts:299-303`, in `CORE_ITEMS` for both `user` and `project`
scopes, `:373-405`) → `SettingsShell.tsx:575-585` renders `SettingsPane
pane="privacy"` → `SettingsEditors.tsx:324-334` picks `IntField` for the `int`
control → user types `0`, blurs or presses Enter → dialog.

**Anchor drift:** STATUS cites `src/main.tsx:2910` for `startBackgroundHousekeeping`;
actual is `:2919`. The in-code comment at `settingsScope.ts:896-899` cites
`sessionStorage.ts:1408` (actual `:1409`), `cleanup.ts:24-31` (actual `:25-31`),
and `cleanupOldSessionFiles` at `cleanup.ts:151` (actual `:155`). All small, all
still land on the right symbol.

---

### P4-12 — Settings extensions (MCP / Plugins / Skills / Hooks / Elicitation)

**Verdict:** OVERSTATED

**Claims checked:**
1. Four panels built over one read-only `extensions.snapshot` seam.
2. Plugged into `SettingsShell.tsx` as mcp/plugins/skills/hooks routes.
3. Built at spawn from the SAME loaded catalogs the runtime uses (skills ⊂
   `commands`, plugin provides ⊂ `agentDefinitions`) + `getClaudeCodeMcpConfigs` /
   `loadAllPlugins` / `getAllHooks`.
4. Emitted after agent-config, before replay; secretGuard-clean by construction.
5. MCP live wiring deferred; entries are config-only.
6. Elicitation deferred (row body), yet named in the row title.

**Evidence:**
- Claim 1: `app/renderer/src/SettingsExtensions.tsx:124`, `:173`, `:280`, `:376`
  export `McpPanel` / `PluginsPanel` / `SkillsPanel` / `HooksPanel`, each reading
  the `ExtensionsSnapshot` prop, with three honest states per panel (waiting /
  unreadable-null / empty).
- Claim 2: `app/renderer/src/SettingsShell.tsx:604-611` routes all four;
  `settingsScope.ts:382-388` puts them in `EXTENSION_ITEMS`, present in the `user`
  and `project` rails (`:393-404`). Reachable.
- Claim 3 (the house stub-context defect — clean here):
  `app/sidecar/sessionController.ts:325-329` calls `loadExtensionsSnapshot` with
  the already-loaded `commands`, `agentDefinitions.allAgents`, and
  `appStateStore.getState()` — the same objects the runtime config is built from,
  not a re-load. `app/sidecar/extensionsDomain.ts:102` `getClaudeCodeMcpConfigs()`,
  `:192` `loadAllPlugins()`, `:327` `getAllHooks(appState)`. No `[]`, no empty
  default, no fixture. Verified anchors: `src/services/mcp/config.ts:1071`,
  `src/utils/hooks/hooksSettings.ts:92`.
- Claim 4: producer is `app/sidecar/sidecarServer.ts:2702-2723` (`sendExtensionsSnapshot`),
  called at `:662` in the attach sequence. Every outbound frame passes
  `scanForSecrets` in `send()` (`sidecarServer.ts`, the `frame.kind !== 'error'`
  branch) and the `MAX_OUTBOUND_FRAME_BYTES` cap. `extensionsDomain.ts:14-17`
  documents the posture and the code matches: `buildMcpEntry` (`:112-132`) copies
  `url`/`command`/`argCount` but never `env` or `headers`; `buildSkillEntries`
  (`:153-183`) copies no prompt body; `buildPluginEntries` copies no option values.
- Claim 5: the stub is `app/sidecar/sessionController.ts:170-171`
  (`const mcpClients: [] = []`), and the MCP panel renders a `Configured` pill
  only (`SettingsExtensions.tsx:153`) — it does not invent a connection state.
- Claim 6 — **the failing sub-claim.** `rg -i elicitation app/ --glob '!*.test.*'`
  returns only `sdk-types.snapshot.d.ts` type names and one
  `sdkMessageFixtures.ts` fixture. No component, no frame, no dialog. The row
  BODY flags it correctly ("ElicitationDialog DEFERRED (owner: elicitation
  round-trip session)"), but the row TITLE and its ✅ name five surfaces and four
  exist. A reader scanning STATUS reads five shipped.

**Reachable-path trace:** sidecar `loadExtensionsSnapshot`
(`sessionController.ts:325`) → `sidecarServer.ts:2702` frame → renderer
`extensionsState.ts:38` reducer → `App.tsx` `selectExtensionsSnapshot` prop into
`SettingsShell` → `SettingsShell.tsx:604-611` → four panels. Confirmed end to end.

**Anchor drift:** STATUS cites `sessionController.ts:176-177` for the
empty-mcpClients stub; actual is `:170-171`. `src/utils/hooks.ts:338` (cited for
"hook last-run outcome not persisted") is now `export interface HookResult` — the
claim is still true, the line no longer shows it.

---

### P4-13 — RemoteSettings (cut scope, D3)

**Verdict:** TRUE

**Claims checked:**
1. Cut scope honored: bridge toggle/status + read-only command filter +
   direct-connect form; NO device model, NO roster/wizard, NO SSH mode.
2. `remoteSettingsDomain.getSnapshot()` reads THIS session's real `AppStateStore`
   and THIS session's real command catalog via `isBridgeSafeCommand`.
3. `runVerb()` dispatches the two verbs against the real primitives; direct
   connect is called with the SESSION's own cwd, never renderer-authored (HC1).
4. `RemoteRolePill` survives only as a session-level label on a successful
   direct connect; the `viewer` branch was cut.
5. §0 flag (1): the toggle sets the real flag but establishes no live connection.
6. §0 flag (3): the mock JWT/clients meta chips were dropped.
7. Review fix: chip reads `Enabled`, not `Publishing`.
8. Review fix: a 15s app-side timeout so direct connect cannot hang forever.

**Evidence:**
- Claims 1/4/6/7: `app/renderer/src/RemoteSettingsPage.tsx:40-48` renders exactly
  three sections. `:88-106` `RemoteRolePill` has only a `control` label, rendered
  at `:308` behind `connected`. `:161` the chip reads `Enabled` / `Offline`. No
  per-device state, no roster, no JWT/client-count chips anywhere in the file.
  `rg -i ssh` over the file: zero hits.
- Claim 2: `app/sidecar/remoteSettingsDomain.ts:37` imports the engine's own
  `isBridgeSafeCommand`; `:121` classifies the session's real catalog into
  skill/opt-in/blocked; `:136-141` reads `replBridgeEnabled` off the shared
  app-state. Anchors verified: `src/commands.ts:697` (the `BRIDGE_SAFE_COMMANDS`
  block), `src/state/AppStateStore.ts:138` (`replBridgeEnabled: boolean`).
- Claim 3: `remoteSettingsDomain.ts:206-207` calls the real
  `createDirectConnectSession({serverUrl, cwd})`; anchor
  `src/server/createDirectConnectSession.ts:26` verified. `:289-313` reads the
  current flag then writes `replBridgeEnabled: true`.
- Claim 5: `RemoteSettingsPage.tsx:163-168` says so on screen, in plain user
  language ("A live web or mobile connection is not served from the desktop app
  yet"). This is the honest-partial pattern, not a fake.
- Claim 8: `remoteSettingsDomain.ts:161` `withTimeout`, wrapping the connect at
  `:206`, with the rationale at `:152-155`.

**Reachable-path trace:** `settingsScope.ts:398` puts `remote` in the `user`
rail → `SettingsShell.tsx:612-620` renders `RemoteSettingsPage` with
`onVerb={onRemoteVerb}` → `App.tsx` `sendRemoteSettingsVerb` → preload
`remoteSettingsVerb` channel → sidecar `handleRemoteSettingsVerb`. Reachable.

**Anchor drift:** none found. All five cited `src/…` anchors still land on the
named symbol.

**Carried forward, not a new finding:** STATUS's own GUI note records that
"Start bridge" is non-functional in the dev build because the bridge feature is
not compiled in. `scripts/build.ts:19` does list `BRIDGE_MODE` in
`fullExperimentalFeatures`, so the gate is a build/runtime question for the
sidecar rather than a missing flag; it is already logged as a separate follow-up
and is out of this row's scope.

---

### P4-14 — Diagnostics + WorkspaceTrust sections

**Verdict:** STALE — superseded by `deae5ec` (2026-07-27, CC-19)

**Claims checked:**
1. `workspaceTrustDomain.ts` reads `isPathTrusted(cwd)` + `getGithubRepo()` into
   a `workspace-trust.snapshot` frame.
2. "Additional trusted directories" reuses the C3 permission context via
   `selectAdditionalWorkingDirectories`, not a second seam.
3. `diagnosticsDomain.ts` reads `MACRO.VERSION`, live `mainLoopModel`,
   `SandboxManager.isSandboxingEnabled()`, and the three plain-data builders.
4. **"UI = `WorkspaceTrustSection.tsx` + `DiagnosticsSection.tsx` … wired into
   `SettingsShell.tsx`'s `workspace`/`diagnostics` categories."**
5. Review fix: `.map(String)` coercion on the warning builders.
6. Review fix: `key={`${index}:${item}`}` on warning rows.

**Evidence — the data half (claims 1/2/3/5/6 all hold):**
- `app/sidecar/workspaceTrustDomain.ts:42,47,85` — real `isPathTrusted` /
  `getGithubRepo`. Anchor `src/utils/git.ts:504` verified;
  `src/utils/config.ts:790` has drifted to `:787`.
- `app/renderer/src/permissionState.ts:319` — `selectAdditionalWorkingDirectories`
  exists and reads the C3 context. No second seam.
- `app/sidecar/diagnosticsDomain.ts:111-125` — every field real; anchor
  `src/utils/sandbox/sandbox-adapter.ts:933` verified. The `.map(String)`
  coercion is at `:123-125` with its rationale at `:119-122` (claim 5).
- `app/renderer/src/DiagnosticsSection.tsx:39` — the `${index}:${item}` key
  (claim 6). Both review fixes are present in the file, which is itself the
  problem below.

**Evidence — the UI half (claim 4 is no longer true):**
- `app/renderer/src/settingsScope.ts:235-250` `SETTINGS_RAIL_ITEM_IDS` contains
  no `workspace` and no `diagnostics`. **The categories do not exist in the
  navigation at all**, so there is no page a user could reach where these would
  mount. `SettingsShell.tsx:602-625` has no case for either.
- `git show deae5ec -- app/renderer/src/SettingsShell.tsx` shows the removal
  explicitly: `-import { DiagnosticsSection }`, `-import { WorkspaceTrustSection }`,
  `-{ id: 'workspace', label: 'Workspace' }`, `-{ id: 'diagnostics', label: 'Diagnostics' }`,
  `-if (category === 'workspace')`. The commit message states the intent:
  "Law 1: live session state (permission context/mode, workspace trust, IDE/LSP,
  diagnostics) leaves Settings for the session inspector."
- `app/renderer/src/DiagnosticsSection.tsx:64` and
  `app/renderer/src/WorkspaceTrustSection.tsx:14` still export their components,
  and `rg` across all of `app/` finds no importer of either. Both are dead code.
- `SettingsShell.tsx:173-181` is a documented, deliberate transitional deferral
  of the now-unused props, not a defect. Not written up as one.

**Silent-parity check between the orphan components and the relocation — clean,
the relocation is a superset.** `MetadataInspector.tsx` renders every element
the two orphans did, and more:
| Orphan element | Where it lives now |
|---|---|
| Installation / Health / Context-usage warnings | `MetadataInspector.tsx:542-550` `EngineDiagnostics` |
| Bash sandbox enabled/disabled | `MetadataInspector.tsx:545-547` |
| Version | `MetadataInspector.tsx:543-545` |
| Model | `MetadataInspector.tsx:504-509` (`Model override` + `Resolved model`, finer than the orphan's single row) |
| Setting sources (comma-joined labels) | `MetadataInspector.tsx:414-440` `Effective settings` — per-layer badge, origin path, key count. Strictly richer. |
| Trust state badge | `MetadataInspector.tsx:347-349` |
| Working directory | `MetadataInspector.tsx:342-344` |
| Detected repo | `MetadataInspector.tsx:353-355` |
| Trust root | `MetadataInspector.tsx:350-352` — **added** by the relocation; the orphan never had it |
| Additional trusted directories (path list) | `MetadataInspector.tsx:361-368` shows the count + per-source breakdown, and `:388-400` `PermissionRulesEditor` renders the authoritative paths from the same snapshot. Deliberate de-duplication, documented at `:333-336`. |
| Disabled `Trust`/`Untrust` button | Not carried over. It could never be enabled (mutation is P4-15's session-create gate), so dropping a permanently-dead control is an improvement, not a cut. |

So no user-visible capability was lost. What is wrong is the STATUS row: it names
a UI location that has not existed since 2026-07-27, and it leaves two orphan
components behind.

**Reachable-path trace (as relocated):** sidecar
`workspaceTrustDomain` / `diagnosticsDomain` → `sidecarServer` frames →
`workspaceTrustState.ts` / `diagnosticsState.ts` selectors → `App.tsx:3142`
mounts `MetadataInspector` (reached from the tab ⋯ overflow, `App.tsx:2966`) →
`WorkspaceFacts` / `EngineDiagnostics`. The trust snapshot is additionally
consumed live at `App.tsx:2808-2814` (the trust gate) and `:1132-1143` (the
welcome launcher's recents), so that seam is load-bearing, not decorative.

**Anchor drift:** claim 4's two component anchors and the `SettingsShell.tsx`
category anchor are all stale. `src/utils/config.ts:790` → `:787`.

**Why nothing went red on this — generalizable past this lane.** Unused *members
of a props interface* are not unused locals, so `strict` tsc has nothing to
report about `SettingsShell.tsx:178-181`; a component with zero importers is a
valid module, so tsc has nothing to report about the two orphans either; and the
`app/` renderer suite is SSR-only and never mounts the settings page, so no test
observed that a category disappeared. A relocation can therefore orphan an entire
rendered surface while typecheck and all 2799 tests stay green. Any future audit
for the "built but never rendered" class should grep for zero-importer exported
components directly, because no gate in this repo detects them.

## Findings

| # | Severity | Row | Defect | Evidence | Failure scenario |
|---|---|---|---|---|---|
| F1 | Medium | P4-14 | The ✅ row names a UI location that no longer exists: the `workspace` and `diagnostics` settings categories were deleted by `deae5ec`, and `DiagnosticsSection.tsx` / `WorkspaceTrustSection.tsx` are now zero-importer dead code. The behavior survives in the session inspector, so this is anchor drift plus orphaned code, not a missing render. | `settingsScope.ts:235-250` (no such rail ids) · `SettingsShell.tsx:602-625` (no such cases) · `DiagnosticsSection.tsx:64`, `WorkspaceTrustSection.tsx:14` (exported, no importers) | An engineer trusts the row, opens `DiagnosticsSection.tsx` to change what Diagnostics shows, ships an edit nothing renders, and the batteries stay green. |
| F2 | Medium | P4-12 (P4-47-B class) | The Hooks rail advertises a capability that does not exist, and the page contradicts itself. The rail reads "Event hooks by event, with recent run results"; the panel body says "Last-run results are not shown, because cat-code does not keep per-hook run history". P4-12's own §0 flag records that hook last-run outcome was DROPPED because it is not persisted. This is the exact defect P4-47-B fixed one rail item away. | `settingsScope.ts:327-331` (rail desc) vs `SettingsExtensions.tsx:393-397` (panel copy) | A user picks Hooks specifically to see which hook last failed, and the page tells them the feature does not exist. |
| F3 | Low | P4-12 | The row title and its ✅ name five extension surfaces; Elicitation was never built in any form. The body flags it DEFERRED with an owner, so this is a headline/body mismatch, not a hidden cut. | `rg -i elicitation app/ --glob '!*.test.*'` returns only SDK type names and one message fixture; no component, frame, or dialog | Anyone counting shipped surfaces from STATUS titles counts five and gets four. |
| F4 | Low | P4-13 | Internal engine vocabulary rendered to the user on the Remote page: "Ink-UI commands are always blocked", the card title "Blocked: Ink UI", and the note "local-jsx renders a terminal picker". `local-jsx` is a source-level command `type`, and Ink is the terminal UI library. | `RemoteSettingsPage.tsx:209-212`, `:217` | A desktop user reads three terms that describe the codebase, not their app. |
| F5 | Low | P4-12 | Engineering note rendered on the Skills panel: "toggling is deferred to a settings writer". Per the operator rules this should tell the user what to DO, not why the team has not built it. | `SettingsExtensions.tsx:301-302` | Same class as the `DeferredNote` component deleted 2026-07-27. |
| F6 | Low | P4-47 | The confirmation copy is present-tense ("stops this app saving new sessions"), but the engine's settings cache is session-scoped and is not reset by a settings write, so an already-running session keeps persisting until its process restarts. The error is in the safe direction (less deletion than promised), and only the first clause is affected; the deletion clause is correctly future-tense. | `src/utils/settings/settings.ts:912-914,956-967` (session cache, "valid for entire session") · `app/sidecar/settingsDomain.ts:8-13` (the sidecar deliberately does not reset it) · `settingsScope.ts:917-919` | A user confirms `0`, keeps working in the open session, and finds that session was saved after all. |
| F7 | Low | all four | Anchor drift on cited `file:line`. STATUS: `src/main.tsx:2910`→`:2919`; `sessionController.ts:176-177`→`:170-171`; `src/utils/config.ts:790`→`:787`; `src/utils/hooks.ts:338` no longer shows the persistence claim. In-code: `settingsScope.ts:896-899` cites `sessionStorage.ts:1408`→`:1409`, `cleanup.ts:24-31`→`:25-31`, `cleanup.ts:151`→`:155`. Every one still lands on or beside the right symbol. | as listed | A future auditor jumps to a cited line and reads unrelated code. |

**Explicitly NOT a finding:** `SettingsShell.tsx:178-181`. The four unused props
carry a comment at `:173-177` stating they are accepted-but-not-rendered because
CC-19's Law 1 moved live session state to the inspector, and naming the
follow-up. I verified the comment's claim that `MetadataInspector.tsx` renders
all of them; it does. That is a documented deferral.

**Explicitly NOT a finding — the security check came back clean.** The
diagnostics and debug-state surfaces cannot carry credentials to the renderer.
`diagnosticsDomain.ts:111-125` emits a fixed field set (version, model strings,
effort, fastMode, sandbox bool, git branch, three `string[]` warning lists) with
no env dump and no arbitrary object. `extensionsDomain.ts` copies config metadata
only, never MCP `env`/`headers`, never skill or hook prompt bodies, never plugin
option values. Every outbound frame passes `scanForSecrets` in
`sidecarServer.ts` `send()` and the `MAX_OUTBOUND_FRAME_BYTES` cap; the debug
state file (`app/shared/debugState.ts`) is a bounded shape of ids, titles, tones,
and tool names, and its channel is double-gated on `IS_DEV` and
`CATCODE_DEBUG_STATE=1` (`app/main/main.ts:1533,1546`). One residual, deliberately
not promoted: a `command`-type hook's `displayLine` is the raw shell command
(`getHookDisplayText`, `src/utils/hooks/hooksSettings.ts:76-78`), so a user who
inlined a token into their own hook command sees it echoed on the Hooks panel.
`secretGuard` is key-name based and cannot catch that. It is the user's own
config shown back to the same user in a local process, it matches the documented
posture at `extensionsDomain.ts:14-17`, and no credential crosses a trust
boundary. Noted, not filed.

**Code execution via settings surfaces — checked, none.** No panel in this lane
can execute anything. All four extension panels are pure reads with zero write
verbs (`SettingsExtensions.tsx` has one `onClick`, the Installed/Marketplace tab
switch at `:199`). Elicitation, the one round-trip that would execute, does not
exist. The only two verbs in the lane are Remote's `bridgeToggle` and
`directConnect`, both sidecar-validated with a renderer-minted `requestId`
correlated on the result, and `directConnect` takes cwd from the session, never
from the renderer (`remoteSettingsDomain.ts:206-207`, HC1).

## Operator steps required (UNVERIFIABLE-HEADLESS rows only)

None of the four rows is graded UNVERIFIABLE-HEADLESS. P4-47 is already `🟡`
with the GUI sitting owed, and the row itself lists what is unproven. For
completeness, the exact sitting that would close it:

1. Launch a fresh dev app (`cd /Users/pt/cat-code && bun run --cwd app dev`) and
   open a session so Settings has a snapshot.
2. Settings → My defaults → Privacy & Data → "Transcript retention (days)".
   Select the field, type `0`, press Tab to blur. Expect the modal titled
   "Delete every saved session?" with buttons "Cancel" and "Delete saved
   sessions".
3. Click Cancel. Expect the field to repaint to the value that was there before
   (30 if unset), not `0`, and no warning under the row.
4. Repeat with `0` and press Enter instead of Tab. Expect the same modal (this is
   the second trigger the shared decision exists to cover).
5. Clear the field to empty and blur. Expect the inline error "Enter a number.",
   and NOT the modal and NOT a write.
6. Confirm with "Delete saved sessions". Expect the field to hold `0` and a
   danger-toned warning to persist under the row: "Every saved session will be
   deleted, and new ones are not kept. Set this above 0 to keep them." Leave and
   re-enter the Privacy page and confirm the warning is still there.
7. Set it back to `30` before doing anything else, then verify
   `~/.cat-code/settings.json` no longer holds `cleanupPeriodDays: 0`. Step 6
   arms a real deletion in the next terminal session.

## Nits

- `RemoteSettingsPage.tsx:69` header reads "Remote Control bridge and connect
  transports." "connect transports" is not a phrase a user has a referent for;
  the rail's own description one level up is clearer.
- `SettingsExtensions.tsx:106` "Open a session to see its extensions." appears in
  all four panels via `WaitingRow`, while `DiagnosticsSection.tsx:74` and
  `RemoteSettingsPage.tsx:77-79` each spell their own variant. Three phrasings of
  one state.
- `settingsScope.ts:400` comment says Remote is absent from the project rail
  because it is "machine-level durable config (sshConfigs, default environment)",
  citing two things `PAIRED-DEVICES.md` cut and `RemoteSettingsSnapshot` does not
  carry. Comment only, so exempt from the text rules, but it is the same stale
  premise P4-47-B removed from the user-visible copy.
- `diagnosticsDomain.ts` now emits `gitBranch`, `reasoningEffort`, `fastMode` and
  `mainLoopModelForSession`, none of which the P4-14 row mentions. Later work
  extended the frame; the row was never updated. Additive, harmless.
