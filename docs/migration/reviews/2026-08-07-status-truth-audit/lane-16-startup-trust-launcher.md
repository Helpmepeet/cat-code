# Lane 16 — Startup, the trust gate, and the launcher

**Auditor verdict:** YELLOW
**Rows audited:** 8 · TRUE 7 · OVERSTATED 1 · FALSE 0 · STALE 0 · UNVERIFIABLE-HEADLESS 0

All eight owner files were CLEAN at `HEAD` when audited (`git status --porcelain` empty for
`StartupSurfaces.tsx`, `WelcomeScreen.tsx`, `WorkspaceTrustSection.tsx`, `workspaceTrustState.ts`,
`pathUtils.ts`, `App.tsx`, `sidecarServer.ts`, `sessionsCatalogState.ts`), so every verdict below is
against committed source, not another session's in-flight work.

## Row verdicts

### P4-15 — Startup + trust gate + first-run OAuth + reauth banner
**Verdict:** OVERSTATED

**Claims checked:**
1. Reauth banner built in `app/renderer/src/reauthBannerState.ts`, wired `App.tsx:1269,847`, with
   `selectAuthSubmitBlocked` death-wall and (2026-07-12 revision) a × close button, floating
   overlay, and `localStorage['catcode:dismissedReauth']` persistence.
2. Trust gate + first-run OAuth built in `StartupSurfaces.tsx`, read-only/switch-prompt/blocking
   modal ABSENT.
3. Wired at `App.tsx:1336` (trust, post-spawn overlay off `workspace-trust.snapshot`, trust
   precedence over OAuth) and `App.tsx:1347` (first-run `poolCount===0`).
4. New `workspace.trust` accept verb: protocol types, preload `CH_WORKSPACE_TRUST_VERB`, main
   forward, sidecar Zod + strict-keys + re-broadcast, `acceptTrust` via `saveCurrentProjectConfig`.
5. §0 adapted: trust ENFORCED at the sidecar `handleSubmit`, so no renderer path can run a turn at
   an untrusted cwd; hooks do not self-gate on the non-interactive path.
6. Security: verb carries only `{type,requestId}` (HC1, no path, no token); outbound secretGuard.
7. 2026-07-19: OAuth `waiting_for_login→waiting_for_alias→success/error` live transitions +
   paste-code URL now drive off a live progress back-channel.

**Evidence:**
- Claim 1 **FAILS.** `app/renderer/src/reauthBannerState.ts` does not exist. `rg` over `app/` finds
  zero references to `reauthBannerState`, `selectVisibleReauthBanners`, `selectAuthSubmitBlocked`,
  or `ReauthWall` outside two negative-assertion tripwires (`App.test.tsx:2176` asserts the source
  does NOT contain `dismissedReauth`; `StartupSurfaces.test.tsx:225` asserts `ReauthOAuthProgress`
  is not exported). The surface was deleted in `f6e4bc1` ("remove reauth alert surface +
  submit-block (#12)"), an operator ruling recorded in `decisions/STARTUP-GATES.md:152-173`, and
  `appModel.ts:42` documents `'reauth'` being dropped from `OAuthContext`. The P4-15 row was never
  amended and still presents the banner as a live deliverable, including a revision paragraph
  describing behaviour of a file that no longer exists.
- Claims 2/3 hold. `StartupSurfaces.tsx:162-228` (`WorkspaceTrustGate`) and `:392-523`
  (`StartupOAuth`); no read-only gate, no `WorkspaceSwitchPrompt`, no blocking `ReauthGate`.
  Wiring is `App.tsx:2812-2817` (`showTrustGate` / `shouldShowFirstRunOAuth`) and the render
  ternary at `App.tsx:3334-3348` (trust) / `:3349-3365` (OAuth) — trust branch precedes OAuth
  branch, so precedence holds structurally.
- Claim 4 holds: `protocol.ts:2376-2394` (`WORKSPACE_TRUST_VERB_TYPES`, `WorkspaceTrustMessage`,
  `WorkspaceTrustResultFrame`), `preload/preload.ts:58,133-140`,
  `sidecarServer.ts:1785-1825` (schema at `:3733`), `workspaceTrustDomain.ts:139-176`.
- Claim 5 holds and is stronger than stated (see P4-25): `sidecarServer.ts:1407` gates
  `handleSubmit`; the other two `startTurn` call sites are gated identically at `:1133-1138`
  (queued-prompt drain) and `:1197-1202` (task-notification drain). `startTurn` has exactly three
  call sites (`:1155`, `:1213`, `:1514`) and all three are behind a trust check.
- Claim 6 holds: `WorkspaceTrustMessage` is `{type, requestId}` only; the snapshot goes out through
  `prepareOutboundPayload(raw, 'workspace-trust.snapshot')` (`sidecarServer.ts:3217`).
- Claim 7 holds in source: `protocol.ts:2000-2030` (`oauth.login.progress` states),
  `accountsDomain.ts:630,688-689,725-741`, `App.tsx:2824-2834` maps the live states into
  `StartupOAuthView`, `StartupSurfaces.tsx:279-319` renders the paste-code fallback.

**Reachable-path trace (trust gate):** sidecar `createSidecarWorkspaceTrustDomain(cwd)`
(`sessionController.ts:605`) → `workspace-trust.snapshot` frame (`sidecarServer.ts:3221`) →
`reduceWorkspaceTrustState` (`workspaceTrustState.ts:41-46`) → `selectWorkspaceTrustSnapshot`
(`App.tsx:2808`) → `showTrustGate` (`:2813`) → `<WorkspaceTrustGate>` (`:3339`) → user clicks
"Trust workspace" → `sendWorkspaceTrust` → preload verb → `handleWorkspaceTrustVerb` →
`acceptTrust()` → `saveCurrentProjectConfig` → re-broadcast → gate unmounts.

**Anchor drift:** severe. STATUS cites `App.tsx:1269,847` (reauth, file gone), `App.tsx:1336/1347`
(actual `3334`/`3349`), `sidecarServer.ts:969` (actual `1785`), `sidecarServer.ts:724` (actual
`1407`, and the cited `=== false` predicate is now `!== true` after P4-25),
`workspaceTrustDomain.ts:109` (actual `139`), `sidecarServer.ts:1887` (secretGuard, actual `3217`).

### P4-17 — Welcome/launcher (derived recents, D5)
**Verdict:** TRUE

**Claims checked:** (1) `WelcomeScreen.tsx` replaces `EmptyShell` at App's empty state; (2) recents
reuse the shared P4-6 `selectMergedSessionRows` via `selectRecentWorkspaces`, no second merge and no
store; (3) reads the P4-5 pool, agent-mode, and P4-15 trust as a per-cwd best-effort join; (4)
orchestrator is read-only on the launcher and interactive in-session; (5) the 2026-08-02 meta-strip
fix makes Branch read the session's own `diagnostics.snapshot` `gitBranch` with the catalog as
fallback; (6) `Start in` reports `Sandboxed` vs `Locally` off the same snapshot.

**Evidence:** `EmptyShell` survives only as a word in a doc comment (`WelcomeScreen.tsx:5`) — the
component is gone. `App.tsx:1143-1146` builds `welcomeRecents` from `sessionCatalogRows` (the shared
merged selector) plus `welcomeTrustByCwd` (`:1132-1142`, joined from live descriptors' trust
snapshots). `sessionsCatalogState.ts:656-710` is a pure projection over already-merged rows; no new
store or feed. `WelcomeScreen.tsx:196-201` renders `OrchestratorReflect` with `onToggle` only in the
session variant (`:116-117`), and `:445-506` renders a real `role="switch"` button when a toggle is
supplied and an `aria-readonly` reflect otherwise. Branch: `App.tsx:2428-2431`
`panelDiagnostics?.gitBranch ?? catalog gitBranch ?? null`; producer is
`diagnosticsDomain.ts:103,118` and the wire field is `protocol.ts:2446`. Sandboxed:
`WelcomeScreen.tsx:176-178` off `props.sandboxed`, sourced at `App.tsx:2434`.

**Reachable-path trace:** engine/registry → `selectMergedSessionRows` → `selectRecentWorkspaces` →
`<WelcomeScreen variant="launcher">` mounted at `App.tsx:3371` in the
`workspacePanels.length === 0 || !activeSessionId` branch → user sees it on a cold launch.

**Anchor drift:** the row's cited symbols all still exist; no line anchors are cited for the
launcher itself. The `sessionStorage.ts:1464` citation for `gitBranch` is reproduced verbatim in
`App.tsx:2420` and matches.

### P4-25 — Trust-gate fail-closed fix (P4-REVIEW B1)
**Verdict:** TRUE

**Claims checked:** (1) producer never returns bare null: `trusted` computed in its own try,
defaulting false; (2) `detectedRepo` read in a separate try so a git failure cannot discard trust;
(3) consumer inverted to require `trusted === true`; (4) domain-absent probe path stays permissive;
(5) a `handleSubmit`-under-null boundary test exists and fails against the pre-fix gate.

**Evidence:**
- `workspaceTrustDomain.ts:187-197` — `let trusted = false`, `try { trusted =
  executor.isTrusted() } catch { trusted = false }`. `:198-209` reads `detectedRepo` in its own
  try. `:214-224` reads `trustRoot` in a third, independent try. The function returns
  `{ trusted, detectedRepo, trustRoot }` unconditionally (`:225`) — it cannot return null.
- `sidecarServer.ts:1407` — `if (this.workspaceTrust && this.workspaceTrust.getSnapshot()?.trusted
  !== true)` → typed `unauthorized`, `return`. `undefined`, `null`, and `false` all block.
- Every other engine-turn entry is gated the same way: `:1133-1138` and `:1197-1202`. There are
  exactly three `startTurn` call sites and no fourth path starts a turn.
- Domain-absent permissiveness is deliberate and real: `sessionController.ts:548` sets
  `workspaceTrust: null` **only** in the `probe` branch; the real session branch always constructs
  it (`:605`). So a live session can never take the permissive path.
- Corrupted / unreadable trust state: `isPathTrusted` (`src/utils/config.ts:788-796`) reads
  `getGlobalConfig()` and returns false when no ancestor key carries
  `hasTrustDialogAccepted`; a throw is caught at `workspaceTrustDomain.ts:190` and defaults to
  false. Both failure shapes land on UNTRUSTED.
- Tripwire: `sidecarServer.test.ts:5782-5813` builds a server with `fakeWorkspaceTrust(null)`,
  submits, and asserts `code === 'unauthorized'`, `turnRan === false`, and that no `event` frame was
  emitted. A second test at `:5544` covers the queued-drain path.
- Race between gate check and spawn: the snapshot is read once at session construction
  (`sessionController.ts:605`, before the server accepts frames), so no submit can be processed
  before the trust fact exists. An out-of-band trust GRANT after spawn leaves a stale `false`
  (fails closed, and `acceptTrust` re-reads); an out-of-band REVOKE leaves a stale `true`, which is
  the upstream engine's own per-process behaviour and is out of scope for this row.

**Reachable-path trace:** renderer `app.submit` → `handleFrame` → `handleSubmit` →
`sidecarServer.ts:1407` gate → error frame, no `startTurn`, no tools, no hooks.

**Anchor drift:** STATUS cites `sidecarServer.ts:734` and `workspaceTrustDomain.ts:152-163` as the
PRE-fix locations, which is legitimate historical description; the post-fix code now lives at
`sidecarServer.ts:1407` and `workspaceTrustDomain.ts:179-226`.

### P4-40 — Welcome recents are inert for terminal-only projects
**Verdict:** TRUE

**Claims checked:** (1) `resolveRecentOpenRoute` delegates to `resolveSessionOpenRoute` (the one
open decision, P4-29); (2) the launcher routes a recent through `applyOpenRoute` →
`openHistorySession(engineSessionId)`; (3) HC1 holds, only an id crosses; (4) `historySessionId` is
adopted from the newest terminal-created session whose workspace is non-empty AND still on disk
(`cwdExists`); (5) both renderer early-returns are gone, openability is a single expression; (6) the
disabled branch is still reachable (folder gone from disk) and carries actionable copy.

**Evidence:** `sessionsCatalogState.ts:723-737` — early `kind:'none'` when neither identity exists,
otherwise `resolveSessionOpenRoute`. `:626-630` `openableHistoryId` requires
`!row.inRegistry && row.appSessionId == null && cwd.trim().length > 0 && row.cwdExists`.
`WelcomeScreen.tsx:382` — `const openable = resolveRecentOpenRoute(recent).kind !== 'none'`, the
only openability rule in the component; `recent.appSessionId == null` appears nowhere in the file.
`App.tsx:2030-2034` `openRecentWorkspace` → `applyOpenRoute(resolveRecentOpenRoute(recent))`;
`:2008-2014` routes `kind:'history'` to `openHistorySession(route.engineSessionId)`, which calls
`bridge.openHistorySession(engineSessionId)` (`:1983`) — an id, never a path. Main resolves the cwd
from the engine-written catalog cache (`app/main/openHistorySession.ts:14-20`, UUID pre-reject at
`:50-51`). The disabled branch is genuinely reachable: registry rows always carry a non-null
`appSessionId` (`sessionsCatalogState.ts:193`) and are forced `cwdExists: true` (`:197`), so the
disabled state is exactly "terminal-only project whose folder is gone", which is what the copy says.

**Reachable-path trace:** engine transcripts → sidecar catalog → `selectMergedSessionRows` →
`selectRecentWorkspaces` → `<RecentItem>` inside the ProjectPicker menu (`WelcomeScreen.tsx:327-336`)
→ click → `onOpenRecent` → `applyOpenRoute` → `bridge.openHistorySession`.

**Anchor drift:** none cited by line; every cited symbol exists.

### P4-48 — The launcher never tells a first-run user what to do first
**Verdict:** TRUE

**Claims checked:** (1) one line of copy under the greeting reading `Open a project to start. Sign
in once it opens.`; (2) gated on `shouldShowFirstRunOAuth` evaluated against the session-free
snapshot the launcher already receives; (3) any pooled account, `anthropicRouteAvailable`, or an
unreported null snapshot silences it; (4) the `'session'` variant never carries it; (5) launcher and
sign-in card are mutually exclusive branches, so the copy can never sit beside the control it
describes; (6) no new verb, frame, or preload method.

**Evidence:** `WelcomeScreen.tsx:127-128` computes `showFirstRunOrder = props.variant !== 'session'
&& shouldShowFirstRunOAuth(accounts, false)`; `:147-151` renders the exact string. The predicate is
`appModel.ts:19-31` and requires `snapshot !== null && initialized && anthropicInitialized &&
!anthropicRouteAvailable && poolCount + anthropicPoolCount === 0` — claims 2/3 confirmed literally.
The launcher's `accounts` prop is `activeAccountsSnapshot ?? selectGlobalAccountsSnapshot(accounts)`
(`App.tsx:3373`), and `selectGlobalAccountsSnapshot` (`accountsState.ts:152-156`) prefers
`state.pool`, which is fed by the **session-free** `accounts-pool` host event
(`hostApi.ts:226`, produced at `main.ts:544`, dispatched at `App.tsx:931`, reduced at
`accountsState.ts:62-63`). This is the load-bearing detail: on a genuine cold launch with zero
sessions the line still renders once main's pool worker reports, because the feed does not depend on
a session. Claim 5 holds structurally: `showFirstRunOAuthSurface` and the WelcomeScreen are separate
arms of the same ternary (`App.tsx:3349` vs `:3366`).

**Reachable-path trace:** main accounts-pool worker → `accounts-pool` host event → `dispatchAccounts
{type:'pool'}` → `selectGlobalAccountsSnapshot` → `<WelcomeScreen accounts=…>` (`App.tsx:3373`) →
`shouldShowFirstRunOAuth` → the `<p>` at `WelcomeScreen.tsx:148`.

**Anchor drift:** STATUS cites `appModel.ts:14-27` (actual `19-31`) and `App.tsx:2908` (the
WelcomeScreen mount is `3371`, the props are `3372-3380`).

### P4-59 — Remove the launcher's false ⌘O affordance
**Verdict:** TRUE

**Claims checked:** (1) only the unbound shortcut hint was removed; (2) the Open folder menu item,
`close()`, and `onOpenFolder()` route are unchanged; (3) App's document-level meta/ctrl router
handles K/T/W/1-9 only; (4) Electron main registers no `Menu`, `globalShortcut`, accelerator, or
`before-input-event`; (5) the focused test's negative assertion is the sole remaining `⌘O`
app-source reference.

**Evidence:** `WelcomeScreen.tsx:344-359` — the `role="menuitem"` button with `close()` then
`onOpenFolder()`, label `Open folder…`, no shortcut span. `App.tsx:2325-2355` — the keydown handler
returns unless meta/ctrl and not alt, then branches on `k`, `t`, `w`, and `'1'..'9'`; there is no
`o` branch. `rg -n "metaKey|ctrlKey" app/renderer/src/App.tsx` returns only `:2327` and `:4105`
(a shift/alt/meta guard elsewhere). `rg -n "globalShortcut|Menu\.|setApplicationMenu|
before-input-event|accelerator" app/main/*.ts` returns **zero** hits. A repo-wide sweep for `⌘O` in
`app/` returns exactly one hit: `WelcomeScreen.test.tsx:113` `expect(picker).not.toContain('⌘O')`.
(`AskQuestionFlow.tsx:183` matches `key === 'o'` but is an in-card option key, not a command chord.)

**Reachable-path trace:** launcher → Project trigger → menu opens → `Open folder…` menuitem →
`onOpenFolder` → `App.tsx:3378 newSession()` → `bridge.pickDirectory` → `bridge.createSession`.

**Anchor drift:** STATUS cites `App.tsx:2064-2094` for the router; actual is `2325-2355`.

### CC-9 — Desktop trust prompt understated its scope
**Verdict:** TRUE

**Claims checked:** (1) `executor.getTrustRoot()` returns `getProjectPathForConfig()`, the SAME
function that keys the write, so displayed scope cannot drift from stored scope; (2) it is read in
its own try/catch independent of `trusted`; (3) carried as additive `WorkspaceTrustSnapshot.trustRoot`
on the existing outbound frame with no new frame, version bump, or inbound vocabulary; (4) three
cases covered: root wider than cwd, root == cwd, root unresolved; (5) the change is wording-only,
the path box is byte-identical, and a tripwire test enforces exactly one `<code>` box; (6) P4-25
fail-closed re-verified with two new tests; (7) residual: `WorkspaceTrustSection` has `trustRoot`
but does not render it, deliberately.

**Evidence — this is the claim the lane brief flagged as the highest-risk shape, and it holds:**
`workspaceTrustDomain.ts:97-101` returns `getProjectPathForConfig()`. The WRITE key is the same call:
`saveCurrentProjectConfig` computes `const absolutePath = getProjectPathForConfig()`
(`src/utils/config.ts:1672`) and writes `current.projects?.[absolutePath]` (`:1681`). Displayed root
=== stored root by construction, not by convention. The prompt does NOT say "this folder" while
storing parent scope: `StartupSurfaces.tsx:205-211` renders, for the wider case, `Trust is stored per
git repository. Approving saves trust for ${trustRoot} and covers every folder under it, including
sibling projects, both here and in the terminal CLI, which share this setting.` — which is exactly
what `isPathTrusted` does (`src/utils/config.ts:788-796` walks UP from the queried dir, so any
descendant of a trusted key reads trusted). The root-unresolved case (`:207`) states the uncertainty
rather than asserting narrow scope. Independence of the read: `workspaceTrustDomain.ts:214-224`, its
own try, defaulting to null, with `trusted` already computed at `:187-197` — a `getTrustRoot()`
throw can never turn an untrusted workspace into an open gate. Domain tests pin both directions
(`workspaceTrustDomain.test.ts:78-84` real-executor equality with `getProjectPathForConfig()`;
`:87-100` throw degrades to null; `:104-114` a throw does not discard `trusted:true`). The frame is
additive (`protocol.ts:2347`, same `workspace-trust.snapshot` kind); no inbound vocabulary changed.
Visual restraint holds: `StartupSurfaces.tsx:199-204` is a single `Workspace` box with one `<code>`,
and the scope sentence is one `<p>` at `:205`.

**Reachable-path trace:** `getProjectPathForConfig()` → `readWorkspaceTrustSnapshotOnce`
(`workspaceTrustDomain.ts:216`) → `WorkspaceTrustSnapshot.trustRoot` → `sendWorkspaceTrustSnapshot`
(`sidecarServer.ts:3221`) → `reduceWorkspaceTrustState` → `activeTrustSnapshot?.trustRoot`
(`App.tsx:3343`) → `WorkspaceTrustGate` copy (`StartupSurfaces.tsx:209`).

**Anchor drift:** STATUS's `src/utils/config.ts:1626-1638` / `:1675` for
`getProjectPathForConfig`/`saveCurrentProjectConfig` are off by a few lines (the write key is read
at `:1672`); `config.ts:752-778,790-799` for the read is now `740-777` / `788-796`. Cosmetic.

**Bypass check (brief's explicit ask):** neither open-from-history nor a deep link can skip the
gate. Open-from-history spawns a normal session at the resolved cwd, and the trust domain is
constructed unconditionally for every non-probe session (`sessionController.ts:605`), so the same
`sidecarServer.ts:1407` gate applies. There is no deep-link surface at all:
`rg "setAsDefaultProtocolClient|open-url|deep.?link"` over `app/main` and `app/host` returns nothing
(only a `second-instance` focus handler at `main.ts:1806`). `navigationPolicy.ts:27-64` pins
navigation to the exact dev renderer document or the exact packaged index file, and
`decideWindowOpen` (`:77-82`) always denies, handing only `https:` to the OS browser (`:85-91`).

### CC-15 — Welcome-launcher recents carried the sidebar's basename collision
**Verdict:** TRUE

**Claims checked:** (1) the helper `disambiguateWorkspaceLabels` was REUSED, not forked; (2)
`groupByWorkspace` is byte-identical and its CC-14 tests untouched; (3) disambiguation happens AFTER
the cap, over exactly the entries that render; (4) cwd keying, newest-first sort, cap, openable-id
adoption, `sessionCount`, and the `trusted` join are preserved; (5) read-time only, no new field or
seam; (6) the "⚠ Premise correction": dropdown rows render the full `recent.cwd` and `name`'s only
consumer is the collapsed picker trigger.

**Evidence:** one implementation, module-private, at `sessionsCatalogState.ts:487-522`, called from
`groupByWorkspace` (`:556`, the sidebar/Sessions path) and from `selectRecentWorkspaces` (`:703`,
the launcher). No second implementation exists in `app/`. Ordering is provably after-cap:
`:700-703` sorts, `.slice(0, limit)`, then disambiguates over `visible`. Preserved behaviour is
visible in the same function: cwd keying (`:670`), empty-cwd skip (`:669`), newest-first sort
(`:701`), both openable-id adoptions (`:690-698`), `sessionCount` (`:684`), `trusted` join (`:679`).
Depth 1 is `basename(cwd) || cwd` (`:462-463`), so an uncontested label is unchanged. Read-time
only — `RecentWorkspace` gained no wire field.

Claim 6 is **no longer true of current source**, which strengthens rather than weakens the fix:
`RecentItem` now renders `{recent.name}` with the full path in `title` (`WelcomeScreen.tsx:393-398`),
so the disambiguated label has two consumers, not one. The row's own §0 item (b) explicitly left
"whether the dropdown rows should switch from full cwd to the disambiguated `name`" as a parity
question "to the operator, not silently changed" — and it was subsequently changed with no record in
this row. See F2.

**Reachable-path trace:** merged rows → `selectRecentWorkspaces` (`App.tsx:1143`) → `recents` prop →
`ProjectPicker` trigger label `recents[0]!.name` (`WelcomeScreen.tsx:297`) and each `RecentItem`
label (`:397`).

**Anchor drift:** heavy. STATUS cites `sessionsCatalogState.ts:583` (pre-fix `basename`, now `:674`),
`:449-484` for the helper (actual `487-522`), `App.tsx:883-892` for the trust join (actual
`1132-1142`), `App.tsx:894` for the merge feed (actual `1143`), `WelcomeScreen.tsx:296` for the
RecentItem cwd render (actual `:395` `title`, with `:397` now rendering `name`), and
`WelcomeScreen.tsx:219` for the trigger (actual `:297`).

## Findings

| # | Severity | Row | Defect | Evidence | Failure scenario |
|---|---|---|---|---|---|
| F1 | Medium | P4-15 | The row's title and its deliverable (1) present a **reauth banner** that no longer exists. `reauthBannerState.ts`, `selectAuthSubmitBlocked`, `selectVisibleReauthBanners`, `ReauthWall`, and the `catcode:dismissedReauth` key were deleted by ruling #12 (`f6e4bc1`) and P4-34; the row was never amended and even carries a detailed 2026-07-12 revision paragraph describing the deleted file's behaviour. | file absent; `App.test.tsx:2176` and `StartupSurfaces.test.tsx:225` assert its absence; `decisions/STARTUP-GATES.md:152-173` records the removal; `appModel.ts:36-42` records the `'reauth'` context drop | Anyone reading STATUS to answer "what startup surfaces exist" believes a dismissible reauth banner with a zero-healthy submit-block ships. It does not, and rebuilding against that belief would reverse an operator ruling. |
| F2 | Medium | CC-15 | A §0 item the row explicitly parked for the operator ("whether the dropdown rows should switch from full cwd to the disambiguated `name` is a *parity* question … left to the operator, not silently changed") was later changed anyway, with no record in this row or a successor row. | `WelcomeScreen.tsx:397` renders `{recent.name}`; the row's "⚠ Premise correction" says rows render `recent.cwd` | The parked-flag mechanism is the program's guard against silent parity drift. A flag that gets resolved by a later session without an entry means the ledger of open operator decisions understates what was decided. |
| F3 | Medium | P4-15 / P4-25 | Renderer/sidecar trust predicates are asymmetric: the sidecar blocks on `trusted !== true` (`sidecarServer.ts:1407`) but the gate renders only on `trusted === false` (`App.tsx:2813`). When a snapshot is absent (lifecycle reset nulls it at `workspaceTrustState.ts:54-59`, or `prepareOutboundPayload` drops the frame at `sidecarServer.ts:3217-3220`), the user gets **no gate** while every submit is refused. | `App.tsx:2813` vs `sidecarServer.ts:1407` | Composer submits return "Workspace is not trusted. Accept the trust prompt before running a turn." while no trust prompt is on screen and none can be summoned. Fails closed (not a security hole) but is an unrecoverable dead end without a restart. |
| F4 | Low | P4-15 | `WorkspaceTrustSection` describes an untrusted workspace as `Read-only: tools and file access are blocked for this workspace`. Read-only mode was CUT by the D4/Q1 ruling and does not exist; untrusted actually refuses the whole turn. | `WorkspaceTrustSection.tsx:31`; the cut is recorded at `StartupSurfaces.tsx:7-9` | A user reads "read-only" and expects the session to still answer questions without tools. It answers nothing. |
| F5 | Low | P4-40 | The disabled-recent's actionable copy exists only as a `title` tooltip on the row; nothing visible on the row explains why it is dimmed. STATUS says the branch stays "with copy that says what to do". | `WelcomeScreen.tsx:428` | A user sees a greyed project that does not respond to clicks and, without hovering and waiting, never learns the folder is missing from disk. |
| F6 | Low | all 8 | Systematic anchor drift. Every line anchor cited by P4-15, P4-25, P4-48, P4-59, CC-9, and CC-15 now points at unrelated code; P4-15's `App.tsx:1269,847` points into a deleted feature. A source comment repeats it: `app/main/openHistorySession.ts:41` cites the trust gate at `sidecarServer.ts:987`, actual `1407`. | listed per row above | A future session reads a STATUS anchor, opens the wrong code, and reasons from it. This is the "trusting a dated doc over source" defect class §8.2 already names. |

No Critical or High findings. The trust gate itself — the security control this lane owns — verified
clean on every path I could construct: producer cannot return null, all three turn-start sites are
gated on `!== true`, the permissive branch is unreachable for real sessions, the displayed trust
scope is read through the exact function that keys the write, and neither open-from-history nor any
navigation/deep-link surface bypasses it.

## Operator steps required (UNVERIFIABLE-HEADLESS rows only)

None of the eight rows is verdicted UNVERIFIABLE-HEADLESS. Two claims inside otherwise-verified rows
are source-verified but not behaviourally verified, and I performed **no login and no token
refresh**:

1. **P4-15, live OAuth round-trip.** Source proves the `oauth.login.progress` back-channel, the four
   sub-state views, and the paste-code verb. It does not prove a real browser round-trip renders
   them. Operator step: with a disposable `CAT_CODE_CONFIG_DIR` (never the real `~/.cat-code`), launch
   `bun run --cwd app dev`, and on the launcher confirm the line `Open a project to start. Sign in
   once it opens.` is present; open a folder, then on the sign-in card click `Open browser to sign
   in` under `Codex · ChatGPT subscription` and confirm the card advances spinner → `Name this
   account` → `Signed in` without a manual reload. Do not run this against a real account pool.
2. **CC-9 / CC-15, gate and label rendering.** Operator step: open a project that is a subdirectory of
   a git root (e.g. `~/cat-code/app`) whose root is not yet trusted, and read the paragraph under the
   Workspace box — it must name the repo root path and the words "including sibling projects", not
   just the session folder. Then, with two projects sharing a basename among the six most recent,
   open the launcher's Project trigger and confirm both the trigger and the dropdown rows read
   `cat-code/app` / `PTClove/app`, not two rows reading `app`.

## Nits

- `App.tsx` lines 2367-3412 (357 lines) are indented with hard tabs while the rest of the file uses
  spaces. Outside this lane's rows; committed at `HEAD`; cosmetic only.
- `WorkspaceTrustSection.tsx:72-73` renders `--add-dir` and `permissions.additionalDirectories` to
  the user. The CLI flag is defensible; the settings key edges toward internal vocabulary.
- Em-dash sweep on all six renderer owner files: every hit is inside a code comment or JSX comment.
  No user-visible string violates the rule. No rendered session ids or `file.ts:line` citations found
  in any of the audited surfaces.
- `StartupSurfaces.tsx` retains a `ReadOnlyModeGate`/`WorkspaceSwitchPrompt`/`ReauthGate`
  "do not add" comment block (`:7-18`) that is accurate and worth keeping.
