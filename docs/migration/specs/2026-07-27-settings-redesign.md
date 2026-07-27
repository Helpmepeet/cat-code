# Settings, rebuilt from first principles

**Status: PROPOSAL — awaiting operator judgment. Nothing here is implemented.**

Replaces the philosophy of the current Settings surface (`app/renderer/src/SettingsShell.tsx`),
which the operator rejected wholesale: *"very bad in grouping and everything… needs a full
rebuild in philosophy."* This document leads with the reasoning, per the operator's process
constraint; the concrete structure follows from it and is stated fully enough to build from.

---

## 1 · Diagnosis: the one error behind both complaints

The operator's two concrete complaints are the same mistake seen twice:

- *"it doesn't make sense if we change something in settings to change the session scope"* —
  the page silently binds to whichever session is focused, because settings resolve engine-side
  against the session's cwd (`settingsState.ts:63-69`; `src/utils/settings/settings.ts:240-248`
  → `getOriginalCwd()`). Switch tabs, and most panes silently change meaning.
- *"the mode is session dependant. Why would we able to change the mode on setting?"* — a live
  session value (the running engine's permission mode) was displayed under a heading ("Default
  mode") that promises durable configuration.

Both are instances of one error: **the page displayed the resolver's output instead of editing
the operator's files.** It answered *"what did the engine compute for whoever happens to be
focused?"* — a diagnostic question about a running process — where a Settings page must answer
*"what will happen next time, and for whom?"* — a question about durable files.

The rejected rail (Resolved / This project / This machine) doubled down: it promoted the
resolver's own vocabulary to the top of the information architecture. Making the implicit
session-binding *visible* was the wrong fix. The right fix is making the subject *chosen*.

## 2 · Philosophy

There are exactly four kinds of settings-shaped information in this system, and they have
different owners, lifetimes, and edit semantics. The old page mixed all four; the new page
separates them, and two of them leave Settings entirely.

| Kind | Examples | Lifetime | Belongs |
|---|---|---|---|
| **Durable configuration** | user/project/local `settings.json`, keybindings file, CLAUDE.md | outlives every session | **Settings — this is what Settings is for** |
| **Live session state** | current permission mode, live model, trust, IDE/LSP status, effective rules | dies with the session | the session's own surfaces (composer chips, session inspector) |
| **Installed inventory** | agents, skills, plugins, MCP servers, hooks, output styles | durable, but library-shaped | Settings, as a library with provenance — not preference rows |
| **Enforced policy** | managed-settings keys | machine truth, read-only | Settings, as a visible floor |

Three laws govern the surface:

**Law 1 — Settings edits sources; sessions show state.**
The Settings surface reads and writes configuration *files*. It never displays a live session
value. Everything present-tense — the running mode, the connected servers, the trust state of an
open workspace, doctor output — moves to the session surface. The complement holds too: *"what
does this session actually resolve to?"* is a real and useful question, but it is a question
about a **session**, so it belongs on the session inspector as an "Effective settings" view. The
per-session snapshot machinery the old page was built on is not wasted — it was a session
inspector feature mounted on the wrong surface.

**Law 2 — Scope is chosen, never inherited.**
The page's subject is an explicit scope the operator picks: **My defaults**, a **named
project**, **This app**, or **Enforced**. Opening Settings lands on My defaults. Switching
session tabs never changes what Settings shows — ever. The focused session's project may be
*offered first* in the project picker, labeled "current", but selecting it is an act. (This is
the VS Code User/Workspace model, which is almost certainly the operator's existing mental
model, and it is proven.)

**Law 3 — Every write names its file before it happens.**
The chosen scope determines the write target, period. The current behavior — `targetSourceFor`
(`SettingsEditors.tsx:87-100`) writes back to *whichever layer the key currently resolves at*,
so editing a value with a project override silently lands in that project's file — is abolished.
In project scope there is one further explicit choice per write: **Shared** (checked-in
`.cat-code/settings.json`) vs **Just me** (`settings.local.json`, gitignored). Editing an
inherited value while in project scope is explicitly an "Override for this project" act; editing
in My defaults while a project overrides it still writes the user file, with an annotation
("overridden in *cat-code*") — never a redirected write.

Two supporting principles:

**Curate the UI; keep the JSON escape hatch.** The engine schema
(`src/utils/settings/types.ts:255-1099`) has ~70 top-level keys. The page shows the ones a
person revisits; every scope carries an "Open settings.json" affordance so the tail stays
reachable without becoming UI. This makes "this setting doesn't merit a control" a cheap
decision instead of a cut.

**Provenance is an annotation, not an organizing axis.** Per-row badges survive — "inherited
from your defaults", "overridden by local", "enforced by policy" — but the resolver's vocabulary
never again structures the nav. The old five-way source taxonomy redistributes completely:
user/project/local become the scope selector; the flag layer (per-session CLI args) is session
state → session inspector; policy is an in-place annotation plus the Enforced scope. Nothing the
old page could express is lost.

One honesty rule follows from the architecture: the engine reads settings at spawn and the
sidecar snapshot is captured once (`app/sidecar/settingsDomain.ts:16-17,29-33`), so **edits
apply to sessions started afterward**. The page says this once, globally, instead of implying
live effect. (If a key is ever proven live-applied, it can carry a "applies immediately" badge —
proof first, never assumed.)

## 3 · The surface

### Scope selector (page head — not the rail)

```
[ My defaults ]  [ Project: cat-code ⌄ ]  [ This app ]  [ Enforced 🔒 ]
```

- **My defaults** — the user layer: `~/.cat-code/settings.json`, the machine keybindings file,
  user-scope extensions, user CLAUDE.md/memory. The landing scope.
- **Project ⌄** — explicit picker over known projects (the merged workspace roster,
  `groupByWorkspace` — the same population `settingsProjectBinding.ts` already draws labels
  from, plus Welcome recents). Shows project + local layers, project extensions, project
  CLAUDE.md. The focused session's project is listed first and labeled "current"; it is never
  auto-selected.
- **This app** — desktop-owned preferences: engine-free, stored app-side, identical whatever
  session or project exists. Today this is one orphan control (reasoning layout); see §5 for
  what belongs here.
- **Enforced** — the read-only policy view (today's Managed pane survives nearly intact; it was
  already correct).

### Functional rail (within a scope)

The prototype's functional instinct was right; the categories get rebuilt on it. Within **My
defaults**:

| Category | Contents |
|---|---|
| General | editor, update channel, attribution, language, git behavior (`includeGitInstructions`, `respectGitignore`) |
| Model & Reasoning | default model (owner: needs model-list seam), effort, thinking, fast mode, reasoning display/summaries |
| Permissions | durable `permissions.defaultMode` (edit is security-gated — §7), durable allow/deny/ask rules **read-only**, durable `additionalDirectories` |
| Interface | output style, syntax highlighting, reduced motion, keybindings (machine file — annotated "one file for this machine; projects cannot override") |
| Privacy & Data | transcript retention, auto-memory / auto-dream toggles |
| Memory | user CLAUDE.md files, memory directory, `claudeMdExcludes` |
| Extensions | Agents · Skills · Plugins · MCP · Hooks — one library, source-badged, enable/disable per scope |
| Remote | `sshConfigs`, `remote.defaultEnvironmentId` (durable config only — §4 for the live half) |

**Project scope** shows the same functional rail filtered to what is meaningful per project:
each row displays the value *as this project will resolve it*, with inheritance annotations, and
edits follow Law 3. Extensions filtered to project-sourced items and project enablement; Memory
shows the project's CLAUDE.md.

**Search** searches within the current scope (v1); cross-scope search is a later enhancement.

### Row grammar

Every row: label · control (or read-only value) · one annotation line. Annotation states, in
priority order: *enforced by policy* (control disabled, links to Enforced) → *overridden by
[local | project | a project]* (when editing a lower layer) → *inherited from your defaults*
(project scope, no override here) → *set here* (with the target filename). The write target is
visible **before** the edit, not disclosed after.

## 4 · Disposition of all 18 current categories

| Current category | Verdict | Where it lands |
|---|---|---|
| General | **keep**, curated | My defaults / General — terminal-only keys drop from UI (§5) |
| Model & Inference | **keep** | My defaults / Model & Reasoning |
| Permissions | **split** | durable half stays (default mode, read-only rules, durable dirs); live context, live mode, classifier state → session inspector |
| Workspace | **move out** | trust + live working dirs are facts about a running session's cwd → session inspector |
| Memory | **keep** | Memory per scope (user CLAUDE.md ↔ My defaults; project CLAUDE.md ↔ project scope) |
| Privacy | **keep** | My defaults / Privacy & Data |
| Keybindings | **keep** | My defaults / Interface (machine-file annotation) |
| Theme & Output | **split** | engine keys (output style, syntax) → My defaults / Interface; app visuals (accent, code theme/font, reasoning layout) → This app / Appearance |
| Transcript | **dissolve** | its one control (reasoning layout) → This app / Appearance; the category was a symptom of having no This-app scope |
| Agents | **keep** | Extensions library |
| MCP | **keep** | Extensions library |
| Plugins | **keep** | Extensions library — provenance badging stays a known limit (`enabledPlugins` is read post-flatten, `pluginLoader.ts:1896`; fixing it is an engine change + protocol bump, out of this redesign) |
| Skills | **keep** | Extensions library |
| Hooks | **keep** | Extensions library |
| IDE & LSP | **move out / defer** | live connection + LSP status → session inspector; no durable engine keys exist today, so no Settings pane until real keys exist (never invent) |
| Remote | **split** | durable config stays (My defaults / Remote); the live bridge/pairing operational surface is the same species as Accounts — operator decision §7 |
| Diagnostics | **move out** | doctor/status is inspection of a running engine, not configuration → session inspector or a standalone Doctor surface |
| Managed | **keep** | becomes the Enforced scope, structure intact |

**Session inspector** (destination for the moved halves): the seed exists —
`MetadataInspector.tsx`, wired to the tab ⋯ overflow (P4-6b). It grows: Effective settings (the
existing per-session snapshot, relocated), live permission context and mode, workspace trust +
this-session extra dirs, IDE/LSP status, per-engine diagnostics, and the flag layer ("this
session was started with `--model …`").

## 5 · Removed from UI · added to UI

**Removed (each stays reachable via the JSON escape hatch):**

- `includeCoAuthoredBy` — currently in the editable allowlist while the schema marks it
  *deprecated* in favor of `attribution` (`types.ts:372-378`). Replaced, not kept alongside.
- `spinnerTipsEnabled`, `terminalTitleFromRename` — terminal-presentation keys (Ink spinner,
  terminal tab titles) currently shipped as desktop UI. The desktop edits files shared with the
  CLI, but foregrounding CLI cosmetics in a desktop Settings page is noise. JSON tail.
- The resolution-order legend as a General-pane fixture — resolution mechanics become a help
  popover; the *effective* result lives on the session inspector.
- The scope-grouped rail headings ("Resolved for X" / "This project" / "This machine") — gone
  with the philosophy that produced them.

**Added:**

- **The entire This-app scope** — the desktop currently pretends every preference is engine
  config. Belongs here: reasoning layout (relocated), appearance (accent, code theme/font — the
  deferred Theme items), **notifications** (system notifications for turn completion and
  permission requests; only in-window toasts exist today), window & startup behavior.
- `attribution` (replacing the deprecated key), `language`, `showThinkingSummaries`,
  `prefersReducedMotion`, `autoMemoryEnabled`, `autoDreamEnabled` — real schema keys a person
  revisits, currently unreachable.
- Default model select — already known-deferred on the model-list read-seam; this design names
  its home (My defaults / Model & Reasoning) so the seam work has a destination.

## 6 · Mechanics — how it reads and writes

**Constraint honored:** settings resolve engine-side; there is no engine without a session
(N-process, locked). Nothing here reverses transport, process model, or event fidelity.

**Reads.** The per-session spawn-time snapshot is replaced as the page's source by
**scope-addressed, on-demand reads**:

- *This app* scope: app-owned state, always available.
- *My defaults*: the user layer is session-invariant — **any** live sidecar can serve it. App
  routes a `settings.refresh` verb (additive protocol: closed vocabulary, sidecar-validated,
  boundary-tested) to any live sidecar and gets a fresh file read back. Zero live sessions →
  the pane renders the honest unread state (`settingsReadState.ts` doctrine: "no engine is
  running; open any session to edit") rather than stale or invented values.
- *Project P*: v1 routes to a live sidecar whose cwd is in P. Projects without a live session
  are listed but marked "no engine in this project — open a session there to edit". This is the
  honest v1 limit, stated on screen.

Fresh-read caveat to verify at build time: if the engine caches settings loads in-process, the
refresh needs a cache-bypassing entry point — verify in `src/utils/settings/` before wiring.

**Writes.** The existing verb shape (`{source, key, value}`), sidecar allowlist
(`app/shared/settingsEditable.ts`), and engine cross-process writer are kept. Two changes:
scope determines `source` (Law 3 — `targetSourceFor` resolve-time targeting is deleted), and
the verb is routed to a sidecar *of the target project*, not the focused session. After a
successful write the serving sidecar re-reads and the app refreshes every open Settings view.
Known engine gap, unchanged by this design but inherited: the same-cwd concurrent-write race
(`persistPermissionUpdates` lost-update, P3-8 rider) — the engine-side read-merge/lock fix
remains owned there.

**Versioned path to full decoupling:**

- **v1 (no engine change):** scope UI + `settings.refresh` + routing via live sidecars, with
  the honest limits above.
- **v2 (small engine change, recommended):** parameterize project-layer settings I/O by
  explicit directory (today cwd-implicit at `settings.ts:240-248`) — additive engine API reusing
  the same loader/writer/locking. Any sidecar can then serve any project; the picker limit
  disappears. This kills the operator's complaint *at the root*: the desktop's silent binding
  was inherited from the engine's cwd-implicitness.
- **v3 (only if the operator wants zero-session editing):** a utility engine process for
  settings I/O when no session is live. This adds a non-session process kind next to the locked
  per-session N-process model — adjacent to a locked decision, so it is an operator decision,
  not a default (§7).

**Security posture — unchanged.** Renderer never authors permission rules; inbound vocabulary
stays a closed allowlist validated at the sidecar; `settings.refresh` is the only new inbound
kind (schema + boundary test + decision reference per SECURITY-MINIMUM); allowlist growth is
per-key review; directional frame limits untouched.

## 7 · Open decisions for the operator

1. **`permissions.defaultMode` editability.** The schema key exists and CC-13 made it *visible*;
   making it *writable* from the renderer means adding a permission-family key to the write
   allowlist. Recommendation: allow it — it is a durable default, not a rule, and the sidecar
   validates the closed enum — but only with an explicit PERMISSION-BOUNDARY review recorded.
   Until then it renders read-only with "change via CLI".
2. **Remote's home.** Recommendation: durable keys in Settings; the live bridge/pairing surface
   moves out to sit beside Accounts (both are machine-level operational surfaces with actions,
   and Accounts already lives outside Settings — `App.tsx:551`). Alternative: keep the whole
   Remote pane in Settings with a hard visual split. Either fixes the `remoteLastResult`
   session-keying bug en route (it becomes keyed to the surface, not a session).
3. **Zero-session editing (v3).** Is "Settings works with the welcome screen only" worth a new
   utility-process kind? Recommendation: no for now — v1's honest limit plus v2 covers the real
   workflows; revisit only if the limit annoys in practice.
4. **Accounts in Settings.** Recommendation: leave Accounts as its own top-level surface; give
   Settings no Accounts pane (a rail item that just navigates away is clutter). Alternative: a
   pointer row under My defaults.
5. **Extensions presentation.** One library with a type filter vs five rail items.
   Recommendation: five rail items under an Extensions group (matches prototype instinct,
   smaller change), same underlying source-badged list component.

## 8 · Known bugs this design absorbs (owners on build)

- `remoteLastResult` cross-session bleed — resolved by decision §7.2's re-homing.
- Durable vs ephemeral trusted directories both tagged `cliArg`
  (`permissionSetup.ts:1030-1036`) — the split becomes *visible* by design (durable list in
  Settings / Permissions; this-session extras in the session inspector) and needs the engine
  tag fix to render truthfully.
- Stale Theme deferred-note (output style shipped in `82dbb0b`) — superseded by the rebuilt
  Interface pane.

## 9 · Build sketch (sessions, orderable after operator judgment)

1. **Scope shell** — scope selector + functional rail + row grammar; My defaults read-only
   first (reuses `Field`/`SourceBadge`/`PaneSection` primitives, which survive intact).
2. **`settings.refresh` + routing** — sidecar verb, boundary tests, any-sidecar routing for
   user scope; write-path re-targeting (delete `targetSourceFor`).
3. **Project scope** — picker over the workspace roster, project/local write choice,
   inheritance annotations; live-sidecar routing per project.
4. **Session inspector growth** — relocate effective-settings/permission-context/trust/
   diagnostics onto `MetadataInspector`.
5. **This-app scope** — reasoning layout relocation + notifications + appearance.
6. **v2 engine enabler** — directory-parameterized settings I/O (engine change, own session,
   engine battery).

Each session runs the full `app/` battery (`bun test app/`, both typechecks, hardening,
`renderer:build`); protocol additions carry sidecar schema + boundary test + decision citation
per SECURITY-MINIMUM.
