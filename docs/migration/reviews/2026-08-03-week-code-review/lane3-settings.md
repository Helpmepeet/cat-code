# Lane 3: Settings surfaces

## Scope reviewed

The week rebuilt the Settings surface on `docs/migration/specs/2026-07-27-settings-redesign.md`: the page's subject became an explicitly chosen SCOPE (My defaults / a named Project / This app / Enforced) instead of "whatever session is focused", the rail went back to functional categories, and `targetSourceFor` resolve-time write targeting was deleted in favour of Law 3 (the scope decides the write layer). New pure modules carry the decisions the SSR-only suite can actually call: `settingsScope.ts` (scope, rail, row grammar, reset, destructive-value gate), `settingsReadState.ts` (unread vs read-and-empty), `settingsProjectBinding.ts` (which project the page is bound to), `settingsEditorModel.ts` / `settingsFieldModel.ts` (pane specs, badge labels). `SettingsEditors.tsx` gained reset-to-default (P4-41), a destructive-value confirm for `cleanupPeriodDays: 0` (P4-47), and a "Save" affordance so an unset row can be pinned. P4-56 added `autoMemoryEnabled` to the memory pane. `accountsPageModel.ts` is an unrelated extraction of AccountsPage verb builders and tone helpers.

I read the full current files (none of my lane's files are dirty in the working tree), plus the write path they drive: `app/sidecar/settingsDomain.ts`, `app/shared/settingsEditable.ts`, `src/utils/settings/settings.ts`, `src/utils/settings/settingsCache.ts`.

## Findings

### [HIGH] A settings write silently erases a concurrent write from another session — CONFIRMED

**Location:** `src/utils/settings/settings.ts:512` (via `:348-351` → `:179-200`), `src/utils/settings/settingsCache.ts:45-58`, `app/sidecar/settingsDomain.ts:98-103` and `:337-342`

**Defect:** The "fresh on-disk read under the cross-process lock" that makes the `SettingsUpdater` form safe is served from a process-global, never-invalidated `parseFileCache`, so the updater computes the next file from a stale snapshot and writes it verbatim — clobbering everything another process wrote since this process last read.

**Failure scenario:** Two sessions open (N-process: two sidecars).
1. Sidecar A spawns; `createSidecarSettingsDomain()` reads `~/.cat-code/settings.json` → A's `parseFileCache` now holds `{respectGitignore:true}`.
2. Operator focuses session B, Settings → My defaults, turns Fast mode on. B's sidecar writes; disk is now `{respectGitignore:true, fastMode:true}`. B calls `resetSettingsCache()` — in B's process only.
3. Operator focuses session A, Settings → My defaults, turns Always-on thinking off. A's sidecar takes the lock, calls `getSettingsForSourceUncached('userSettings')`, gets a **cache hit from step 1**, and the updater returns `{respectGitignore:true, alwaysThinkingEnabled:false}` — written verbatim (updater form = no merge).
4. `fastMode: true` is gone. `runVerb` returns `{ok:true}`, no toast, no error.

Verified by running the real domain against a temp `CLAUDE_CONFIG_DIR`, with the "other process" simulated by a direct `writeFileSync` (indistinguishable from another process's syscall, since the cache is per-process and the lock is released):

```
after B wrote:  {"respectGitignore": true, "fastMode": true}
A write result: {"ok":true,"message":"Updated alwaysThinkingEnabled.","changed":true}
final on disk:  {"respectGitignore":true,"alwaysThinkingEnabled":false}
fastMode survived? undefined
```

**Evidence:** `updateSettingsForSource` is careful about the wrong cache:

```ts
release = acquireSettingsLockSync(filePath)
// Try to get existing settings with validation. Bypass the per-source
// cache — mergeWith below mutates its target ...
let existingSettings = getSettingsForSourceUncached(source)
```

`getSettingsForSourceUncached` bypasses `perSourceCache` but goes straight into the **cached** `parseSettingsFile(settingsFilePath)` (`settings.ts:350`), and `parseFileCache` (`settingsCache.ts:45`) is a bare `Map<string, ParsedSettings>` with no mtime check. Its only invalidator is `resetSettingsCache()`, which is process-local. The engine mitigates this with a chokidar watcher — but `settingsChangeDetector.initialize()` is called from exactly one place, `src/main.tsx:436` ("File change detectors deferred from init() to unblock first render"), and the sidecar bootstrap is `init()` only (`app/sidecar/initializeRuntime.ts:38-41`). So a sidecar process **never** learns that a settings file changed underneath it, and the staleness window is not a race — it is "everything since this process's own last write".

`app/sidecar/settingsDomain.ts:100-102` asserts the opposite in a doc comment, which is why nothing downstream guards it:

> The engine writer is the cross-process single writer (lockfile + fresh under-lock read), so this cannot lose a concurrent update.

Blast radius is larger than the editable-settings allowlist: `persistPermissionUpdate` uses the same `updateSettingsForSource` updater form (`src/utils/permissions/PermissionUpdate.ts:247`), and `addPermissionRulesToSettings` writes the same files. So an always-allow rule saved in session B can be removed by an unrelated toggle in session A. This is the same lost-update class the repo already recorded once (`persistPermissionUpdates` stale-view full write, P3-5a/DR-2); the lock and the updater form fixed the caller and left the reader.

Cheapest correct fix is at the reader, not in this lane's files: make the under-lock read use `parseSettingsFileUncached` (or drop the path-cache entry for `filePath` before reading), so the updater genuinely sees disk.

---

### [MEDIUM] A row can display a value borrowed from a different layer than its badge names — CONFIRMED

**Location:** `app/renderer/src/settingsScope.ts:631` used at `:636-646`, `:674-685`, `:687-701`

**Defect:** Three of the four `selectSettingsRow` branches read the value with the key-only `selectEditableValue`, which returns the highest-precedence entry that EXISTS. When the winning layer's stored value was dropped by the sidecar's per-key validator, that lookup silently falls through to a lower layer and the row attributes the borrowed value to the winner.

**Failure scenario:** `~/.cat-code/settings.json` holds `cleanupPeriodDays: 30`; `<repo>/.cat-code/settings.json` holds `cleanupPeriodDays: 5000`. That project value is schema-valid (`z.number().nonnegative().int()`, `src/utils/settings/types.ts:325-329` — no maximum) but outside the editable control's `{min:0, max:3650}`, so `buildSettingsSnapshot` drops it from `editableValues` while still recording `projectSettings` as the winner in `resolved`. Traced through the real builder and the real selector:

```
editableValues: [{"key":"cleanupPeriodDays","value":30,"source":"userSettings"}]
resolved:       [{"key":"cleanupPeriodDays","source":"projectSettings",...}]

PROJECT ROW: read {"kind":"set","value":30,"source":"projectSettings"}
             annotation {"kind":"set-here","origin":"/repo/.cat-code/settings.json"}
```

Settings → Project → Shared → Privacy therefore renders "Transcript retention (days) = 30" with a **Project** badge pointing at the project settings file, and `settingsRowNote` returns null (`set-here` is the ordinary case), so nothing hints at a problem. The file says 5000. The same shape with the policy layer is worse — I got `read {"kind":"set","value":30,"source":"policySettings"}, annotation "enforced"`, i.e. the page states that organization policy enforces 30 days when policy says 5000, on a disabled control the operator cannot correct.

**Evidence:** The module already has the correct helper and uses it in exactly one branch:

```ts
function layerValue(snapshot, source, key) {
  return (snapshot.editableValues ?? []).find(
    entry => entry.key === key && entry.source === source,
  )?.value ?? null
}
```

Its doc comment states the rule ("This answers 'what does MY scope's file say' … It returns null wherever the snapshot only carries the winner"), but only the `overridden` branch calls it (`:661`). The `managed`, `set-here` and `inherited` branches all use `const value = selectEditableValue(snapshot, key)` from `:631`, which is `.find(entry => entry.key === key)` — source-blind. Replacing those three with `layerValue(snapshot, winner.source, key)` produces the honest `unreadable` read that the surrounding design already handles.

Secondary: when that `unreadable` read IS reached, `settingsRowNote` appends "This app reads the resolved value only, so your own value here cannot be shown" (`:1066`). In the `set-here` case the real reason is that the stored value is out of the control's domain, not a resolved-value limitation, so the explanation is wrong even when the state is right.

---

### [MEDIUM] The project binding is unwired, so the Project scope silently follows the focused session — CONFIRMED

**Location:** `app/renderer/src/settingsProjectBinding.ts` (entire 149-line module), `app/renderer/src/App.tsx:2885-2906`, `app/renderer/src/SettingsShell.tsx:190-213`

**Defect:** `SettingsShell` accepts `projectBinding` and `projects`, and App passes neither. `selectSettingsProjectBinding` has no production caller at all.

**Failure scenario:** With `projects` undefined and `projectBinding` undefined, `selectSettingsProjects(undefined, activeCwd)` returns exactly one choice: the focused session's cwd. Two consequences:
1. `selectedProject` can only ever be the active session's project, so `selectProjectEngine` always returns `live` and the entire `engine: 'absent'` grammar (the `no-engine` read kind, `settingsNoEngineNote`, the `ScopeBody` gate at `SettingsShell.tsx:508-516`, the shell tests at `:362` and `:403`) is unreachable in the shipped app. The stated v1 limit is enforced by an accident of the picker having one entry, not by the guard that was built for it.
2. Law 2 ("Scope is chosen, never inherited… Switching session tabs never changes it") does not hold for the project identity: if `activeSessionId` changes while the Settings view is mounted, `projectChoices` is rebuilt, the stored `projectCwd` no longer matches, and `selectedProject` falls back to `projectChoices[0]` — the new session's project. Edits then land in a different repo's `.cat-code/settings.json` than the one the header named a moment earlier.
3. The project label is `settingsProjectLabel(cwd)` (bare last segment), which is precisely the ambiguity `settingsProjectBinding.ts:118-121` documents as operator-reported on 2026-07-26: `/Users/pt/cat-code/app` and `/Users/pt/PTClove/app` both render as `app`. The full cwd is shown beside the picker, which softens it, but the scope tab itself reads `Project: app`.

**Evidence:** `rg` over `app/` for `selectSettingsProjectBinding` returns only its own definition and its test. `SettingsShell.tsx:157-159` says "App wires this in one line when it is free to edit" — the wiring never landed, and nothing fails when it does not.

---

### [MEDIUM] The auto-memory pane promises a runtime effect that other open sessions do not get — CONFIRMED

**Location:** `app/renderer/src/SettingsShell.tsx:273-275`

**Defect:** The memory pane replaces the safe global note with a stronger claim that holds only for the one session whose sidecar received the write.

**Failure scenario:** Three sessions open. Operator focuses session A, Settings → Memory, turns Auto memory off. The header states "Auto memory edits are saved immediately. Features use the new value when they next check the setting." The write is routed to the **active** session's sidecar (`App.tsx:1376-1391`, `getBridge().settingsVerb(activeSessionId, …)`), which calls `resetSettingsCache()` in its own process, so A's next `isAutoMemoryEnabled()` (`src/memdir/paths.ts:50-53` → `getInitialSettings()` → the session-level cache at `settings.ts:944-956`) does re-read and returns false. Sessions B and C never reset their caches (same missing watcher as the HIGH finding), so they keep reading `autoMemoryEnabled: true` and keep writing automatic memories until they are restarted. The operator has been told the opposite, on a privacy-adjacent setting.

**Evidence:** The generic `SETTINGS_APPLY_NOTE` ("Edits apply to sessions started afterwards, not to sessions already running") is the statement that is true for every session; `a27d979` replaced it for the memory pane specifically to claim in-session effect. Correct copy would scope the claim, or stay with the global note.

---

### [LOW] An emptied integer field commits `0` — CONFIRMED

**Location:** `app/renderer/src/settingsScope.ts:980`

**Defect:** `Number(draft.trim())` maps `''` (and `'   '`) to `0`, so clearing the field is indistinguishable from typing zero.

**Failure scenario:** Settings → Privacy, transcript retention. The operator selects the field contents, deletes them, then clicks elsewhere. Blur fires `commit` → `Number('')` → `0` → valid for `{min:0,max:3650}` → the "Delete every saved session?" modal appears. Today the destructive declaration catches it, so the outcome is a startling dialog rather than data loss. But the coupling is backwards: the gate that saves it is per-key, and `IntField` is generic over every int key, so the next int setting added inherits "empty means zero" with no gate at all. `Number('0x10')` → 16 and `Number('1e3')` → 1000 land in the same helper.

**Evidence:** `selectSettingsIntCommit` validates `Number(draft.trim())` with no empty-string guard; `validateEditableSettingValue` only sees the already-coerced number.

---

### [LOW] "Not built yet" / "Not readable from this app yet" copy — CONFIRMED

**Location:** `app/renderer/src/SettingsShell.tsx:735`, `:767-771`

**Defect:** Two rows explain why we have not built something instead of telling the operator what to do, which CLAUDE.md §7 names explicitly (the `DeferredNote` precedent).

**Failure scenario:** Settings → My defaults → Interface shows "Keyboard shortcuts / One file for this machine. Not readable from this app yet." with the value `unknown` and no action. Settings → This app → Notifications shows "Not built yet. This app raises in-window toasts only, so it needs the window visible." Compare `PermissionsPane` two panes over, which gets it right: "The mode a session starts in. Change it from the CLI." The keybindings row has an obvious equivalent (name the file, or say to edit it from the CLI); notifications has none, which is an argument for not rendering the rail item rather than for rendering an apology.

**Evidence:** `userVisibleText.test.ts:41-46` documents this exact blind spot — the word list "catches the mechanical leak … but not the judgment-level half of §7 — copy that explains why we have not built something … reads perfectly clean here."

---

### [LOW] Raw policy-source discriminator rendered to the user — CONFIRMED

**Location:** `app/renderer/src/SettingsShell.tsx:922-927`

**Defect:** `policyOrigin` is the engine's internal union `'remote' | 'plist' | 'hklm' | 'file' | 'hkcu'` (`src/utils/settings/settings.ts:376-382`) and is printed verbatim.

**Failure scenario:** An operator on Windows with an HKCU policy opens Settings → Enforced and reads "policy source: hkcu · C:\…". `hkcu` and `hklm` are registry hive abbreviations with no rendered meaning; the surface has a `Record`-over-the-union idiom for exactly this (`SETTINGS_LAYER_PHRASE`, `SETTINGS_PROJECT_UNBOUND_NOTE`) and does not use it here. The §7 sweep cannot see it because the value is a variable, not a literal.

---

### [LOW] Settings still opens on Agents under My defaults — CONFIRMED

**Location:** `app/renderer/src/App.tsx:2895` vs `app/renderer/src/SettingsShell.tsx:136`

**Defect:** The rebuild made `initialCategory` default to `'general'` and made My defaults the landing scope, but App still passes `initialCategory="agents"` (unchanged since `70a9dc5`, P4-7).

**Failure scenario:** Every visit to Settings lands on the Agents pane, which renders `AgentsPage` and none of the scope's editable rows, under a header whose write-target sentence ("Anything this page does not show lives in the same file: `~/.cat-code/settings.json`") is not true of agent definitions. This is the "a diff hides interactions with untouched code" case: nothing in the lane is wrong on its own.

---

### [LOW] Contradictory empty state in Project scope with no session open — CONFIRMED

**Location:** `app/renderer/src/SettingsShell.tsx:407-414` and `:508-516`

**Defect:** With no session, the two halves of the Project scope state different things about the same nonexistent project.

**Failure scenario:** Launch the app with every tab closed, open Settings, click Project. The header says "No project is open, so there is none to name. Open a session in a project to edit its settings files." Immediately below, the pane says "No engine is running in this project, so its settings files have not been read. Open a session in that project to see and edit them." — "this project" and "that project" refer to nothing, and the pane's message is the wrong one for the state (`settingsReadState.ts` draws exactly this distinction one module over, and `ScopeBody` does not consult it before the `engine === 'absent'` gate).

## Coverage gaps

- **The cross-process write path has no test.** `app/sidecar/settingsDomain.test.ts:346` "two sequential writes read-modify-write under lock — no lost update" runs both writes through the same domain in the same process, where `updateSettingsForSource` resets the cache between them. It cannot observe the HIGH finding by construction: the defeat requires an *external* writer. A probe that writes the file directly between two `runVerb` calls fails immediately (shown above) and would be a two-line addition to that file.
- **The sidecar-builder ↔ renderer-selector seam is untested.** Every renderer test hand-builds a `SettingsSnapshot` literal; `rg buildSettingsSnapshot app/renderer/` returns nothing. `settingsDomain.test.ts:272` proves the builder drops a mistyped value, and `settingsScope.test.ts` proves the selectors' behaviour on well-formed snapshots, but no test feeds a real dropped-value snapshot into `selectSettingsRow` — which is precisely where the MEDIUM borrowed-value finding lives.
- **No test covers `selectSettingsIntCommit` with an empty or whitespace draft.** `settingsScope.test.ts:1237` covers the destructive gate for a typed `0`, not for `''`.
- **The unwired props have no wiring assertion.** `settingsProjectBinding.test.ts` (175 lines) tests a module nothing calls, and `SettingsShell.test.tsx:362`/`:403` test a `no-engine` branch production cannot reach; both suites are green and both describe behaviour the app does not have.

## Clean

- **Law 3 write targeting holds.** `selectSettingsWriteLayer` is a total function over the scope union with a `never` tripwire; `SettingsPane` passes it down as `layer` and every row's `writeTarget` is that layer or null. The trap the comment at `settingsScope.ts:653-658` describes (making an overridden row unwritable once `definesHere` flips) is genuinely closed.
- **The sidecar boundary is intact.** `applySettingsVerb` re-checks source, key allowlist, per-key value validation, and dynamic-enum membership against the spawn-captured options, fails closed with no options, and never echoes the rejected value. `null` as the clear channel is outside the value domain at type, validator and schema level. Renderer-authored values cannot widen the key set: `EDITABLE_SETTINGS` is the single source for both planes.
- **The destructive-value gate is well-built.** One selector decides both triggers (blur and Enter), a cancel restores the value in effect rather than the typed one, the persistent row warning is deliberately separate from `settingsRowNote` so a provenance rule cannot suppress a data-loss warning, and the `overridden` exclusion in `selectSettingsDestructiveWarning` correctly avoids promising a deletion that will not happen.
- **Forward-compatible keys survive a write.** `SettingsSchema` is `.passthrough()` (`src/utils/settings/types.ts:1099`), so unknown keys the renderer does not model round-trip through the read-modify-write. Non-target keys in the same file are preserved (`settingsDomain.test.ts:504`, `:605`).
- **Failed writes are surfaced.** `settings.result` reaches `verbAckResultState.ts` and `App.tsx:1507-1516` toasts the sidecar's real message on failure; success relies on the re-broadcast snapshot rather than an optimistic guess.
- **Unread vs read-and-empty is respected.** Every pane I checked branches on `settingsWereRead` / the `unread` read kind before asserting anything, including the Enforced pane's "No managed settings on this machine", and `SETTINGS_UNREAD_WITH_SESSION_NOTE` correctly stops claiming no session is open.
- **Project rules.** No em dash outside comments in any lane file (`rg -n '—'` minus comment lines is empty). No `style={{}}`, no interpolated arbitrary-value Tailwind classes — every conditional class is a whole static string. `SettingsShell.tsx` and `SettingsEditors.tsx` export only components at runtime (plus type-only exports), so the Fast Refresh boundary holds. Naming follows `select<X>` throughout. The only `as` casts are on internal constant data (`settingsScope.ts:477`, `:982`), not on data crossing a boundary.
- **`settingsRowNote`'s "say only what is surprising" discipline held** across the new notes: it returns null for both ordinary annotations, and the new destructive warning was deliberately kept out of it rather than folded in.
