# High/Medium fix progress — 2026-08-09

This is a live implementation ledger for the review. The original scope reports
remain historical evidence; this file records only fixes made after the review
and their verification. Entries are appended as checkpoints land.

**Progress: Fix 90/242** — counted against the review's original 61 High and
181 Medium findings. A checkpoint can resolve related findings together; the
count tracks individually verified findings, not commit count.

| Review finding(s) | Status | Implementation commit | Verification |
|---|---|---|---|
| A12 HIGH bypass-permissions launch gate | fixed | `82a43ae` | `sidecarServer` focused boundary tests |
| S04 / X02a credential-vault permissions and atomic Claude credential persistence | fixed | `7dced85`, `fd8e5eb`, `7744aa2` | focused account-pool tests; root development build |
| S07 / X02a transcript tombstone concurrency | fixed | `d2d35bb` | focused session-storage tests |
| X02a plugin-registry durability | fixed | `45d93d6` | focused plugin-registry tests |
| A09 host registry lost updates and restart rate cap | fixed | `4957f31`, `fab3254` | focused host registry/restart tests |
| A08 malformed frame session-id rejection | fixed | `dbb8e0a` | focused host IPC tests |
| S08 HIGH `--bare` policy bypass | fixed | `39f34c5` | Claude and GPT prompt-policy tests |
| A11 credential-bearing extension endpoint/hook details | fixed | `4401961` | sidecar extension snapshot tests |
| A02/A10 private sidecar socket allocation | fixed | `c8200f5` | focused supervisor test; app typecheck and renderer build |
| S02 HIGH mailbox truncate-write | fixed | `5baaaf8` | `teammateMailbox` suite (35 pass) and development build |
| A06 rejected-frame request correlation | fixed | `bc10e96` | focused protocol tests; app typecheck and renderer build |
| A12 HIGH restored-agent catalog; A12 MED restored goals/state and worktree cwd | fixed | `30d97ee` | app typecheck; controller + real-process resume probes (18 pass) |
| A12 MED subagent restore fan-out/budget; related replay dedupe/oversized-branch behavior | fixed | `71d0309` | app typecheck; `subagentHistory` suite (13 pass) |
| A12/A14 MED catalog failure diagnostics and unbounded transcript run-facts reads | fixed | `7c885b0` | app typecheck; catalog + run-facts suites (48 pass) |
| A03 HIGH removed sidecar connections can still submit late frames | fixed | `c4fa7c9` | app typecheck; focused regression passes (full boundary suite: 193 pass, 3 pre-existing account-snapshot failures) |
| A15 HIGH rejected/undeliverable session actions are invisible | fixed | `a0485b0` | app typecheck; session-action state/dialog suites (40 pass); renderer build |
| A05 HIGH replayed tool-result-only frame invalidates transcript projection caches | fixed | `f29949d` | app typecheck; full transcript-projector suite (74 pass) |
| S02 HIGH mailbox acknowledgement retry can redeliver one message per poll | fixed | `6408091` | poller suite (11 pass); mailbox suite (35 pass); focused lint; app typecheck |
| S02 MED mailbox lock stale/compromise handling | mitigated (not counted) | `6408091` | 60-second stale window and compromise logging; an explicit post-compromise recovery path remains |
| S02 MED unrenderable permission requests are acknowledged while the worker waits forever | fixed | `44347f7` | callback-registry regression (1 pass); poller + mailbox suites (46 pass); focused lint; app typecheck |
| S02 MED unacknowledgeable structured mailbox entries pin idle pollers | fixed | `7f8d65b` | poller + mailbox suites (46 pass); focused lint; app typecheck |
| A15 HIGH bulk export hangs when a session dies before its first result; related stale lifecycle reset can prematurely save a partial export | fixed | `3e38524` | session-action dialog/runtime suites (41 pass); app typecheck; renderer build |
| S03 HIGH post-launch spawn failure leaves a teammate running but unaddressable | fixed | `330089d` | spawn lifecycle regression (3 pass); focused lint; app typecheck |
| S03 HIGH pane teammate reports success when initial task-prompt delivery fails | fixed | `1768c62` | spawn + mailbox suites (38 pass); focused lint; app typecheck |
| S03 HIGH team-file reads can observe torn JSON during a write | fixed | `cb7e9c6` | swarm + mailbox suites (51 pass); focused lint; app typecheck |
| A20 HIGH hardening/demo harness `app.exit()` bypasses sidecar shutdown | fixed | `298cac6` | harness lifecycle source test (2 pass); app typecheck; full GUI smoke remains gated |
| S03 MED permission-request delivery failure leaves a swarm worker waiting forever | fixed | `5b2e019` | renderer-worker and in-process fallback regressions; focused swarm suites (11 pass); development build |
| S03 HIGH in-process teammate core prompt uses the leader model/provider | fixed | `6b665ef` | runtime model-forwarding regression (9 pass); development build |
| S03 MED in-process teammates drop built-in/plugin agent definitions | fixed | `d65f448` | built-in prompt/tool-filtering regression (13 pass); development build |
| V15 MED session-open route allows history opens after its cwd disappears | fixed | `446a52c` | session-catalog route regression (62 pass); renderer typecheck and production build |
| V26 HIGH default permission-mode update can clobber concurrent rules and leak merged rules into user settings | fixed | `b58fa2a` | user-scoped updater regression (1 pass); development build |
| V31 HIGH discarded deferred-continuation commands retain the session lock | fixed | `1caba13` | queue-clear deferred-registration regression (11 pass); development build |
| V29 HIGH fixture-key test assertions provide no independent wire-coverage evidence | fixed | `631e317` | removed three self-referential assertions while retaining the typed compile-time records; focused renderer suites (69 pass); renderer typecheck |
| V29 MED `effort.set` lacks a schema-level malformed-input rejection test | fixed | `63c4951` | real sidecar boundary regression (1 pass); full sidecar file has 194 pass and 3 pre-existing account-snapshot failures; renderer typecheck |
| V29 MED secret-guard projection fixture asserted its own keys rather than a real projection | fixed | `7de9d5d` | retained the real `scanForSecrets` check; secret-guard suite (27 pass) |
| V29 HIGH `account.rename` lacked sidecar boundary acceptance coverage | fixed | `d60880e` | seeded vault-backed account regression proves schema acceptance, executor dispatch, and correlated result (1 pass) |
| V29 MED context-breakdown failure path lacked a retry/no-cache regression | fixed | `e9b0a3d` | failed attach analysis stays silent and the next request re-runs it (7 pass) |
| V15 MED session-action verbs remained enabled when host and frame planes disagreed about engine reachability | fixed | `a9e0569` | disconnected-sidecar resolver regression; menu/resolver suites (41 pass); renderer typecheck and production build; GUI fidelity pending |
| V15 MED fresh-session catalog key flips discarded Sessions-page selection, rename draft, tag echo, and tag popover state | fixed | `d7ed71e` | catalog id-migration regression (21 pass); renderer typecheck and production build; GUI fidelity pending |
| V15 MED dead inspector seam selector claimed centralization that no production code used | fixed | `bf7f757` | removed unused selector and self-contained tests; inspector-state suite (19 pass); renderer typecheck and production build |
| V15 MED dev debug snapshot fabricated/inverted permission-suggestion labels | fixed | `ae90352` | reused the visible option formatter and covered allow/deny labels (1 pass); renderer typecheck and production build |
| V15 MED writable-row eligibility drifted across Sessions-page and App bulk-action paths | fixed | `5193cf5` | shared typed row selector regression; Sessions-page suites (40 pass); renderer typecheck and production build |
| V15 HIGH consumed export frames retained up to 32 MiB per session in renderer state | fixed | `8032c7f` | request-correlated discard regression preserves newer results; session-action suites (42 pass); renderer typecheck and production build |
| A07 HIGH Workspace-panel accessibility labels exposed raw host/connection plane values | fixed | `2ed7d32` | shared status-vocabulary regression; WorkspacePanels + status suites (13 pass); renderer typecheck and production build |
| A07 MED Workspace-panel labels exposed raw session identifiers | fixed | `2ed7d32` | named-session and no-identifier regressions; WorkspacePanels + status suites (13 pass); renderer typecheck and production build |
| A16 HIGH context gauge divided by raw model windows instead of the engine's effective compaction window | fixed | `b3f514a` | effective-window source and renderer-priority regressions (42 pass); renderer typecheck and production build; sidecar wrapper retains five pre-existing unrelated diagnostics |
| A13 HIGH trusted bypass launch capability overrode the engine's settings/managed bypass-disable policy | fixed | `c4a661a` | real settings-file plus trusted-launch regression; focused controller test passes; sidecar boundary suite security cases pass (212 pass, 3 pre-existing account-snapshot failures); renderer typecheck; Electron hardening not authorized |
| V15 MED `MergedSessionRow.messageCount` carried dead renderer state | fixed | `a0fb195` | removed only the renderer projection while retaining the wire catalog field; affected renderer suites (279 pass); renderer typecheck and production build |
| A19 MED PermissionPrompt keyboard actions could target an unseen cursor row | fixed | `60a311c` | listener/cursor-state alignment regression (34 pass); renderer typecheck and production build; GUI behavior remains operator-verifiable |
| A19 MED TasksDialog could stop a keyboard-selected task after it scrolled off-screen | fixed | `c2da0e8` | active-row scroll and accessibility regression (34 pass); renderer typecheck and production build; GUI behavior remains operator-verifiable |
| A19 MED MentionPicker could insert an active mention after it scrolled off-screen | fixed | `c2da0e8` | active-row scroll regression (34 pass); renderer typecheck and production build; GUI behavior remains operator-verifiable |
| A19 MED duplicated permission mode/source label tables had already drifted between surfaces | fixed | `48ffc5c` | central typed labels now serve the mode chip, rules editor, inspector, and suggestion formatter; focused renderer suites (86 pass); renderer typecheck and production build; GUI fidelity remains operator-verifiable |
| A19 MED PermissionRulesEditor could expose raw mode/source tokens and lacked a match-type union tripwire | fixed | `48ffc5c` | neutral unknown-value regression; match labels are a total wire-union record; focused renderer suites (86 pass); renderer typecheck and production build; GUI fidelity remains operator-verifiable |
| A19 MED composer slash/mention typeaheads were not connected to the focused text editor as comboboxes | fixed | `19727f2` | active listbox/option accessibility linkage, stable option ids, and slash dialog-role regression (67 pass); renderer typecheck and production build; GUI fidelity remains operator-verifiable |
| A17 MED outside-click popover dismissal discarded the focus stack's restore target | fixed | `b25e6e4` | stack-removal focus-target regression plus affected menu suites (73 pass); renderer typecheck and production build; GUI behavior remains operator-verifiable |
| A17 MED SettingsShell left its existing active-project binding selector unwired | fixed | `39d2a32` | live route now supplies the merged-roster binding; binding, Settings, and App suites (102 pass); renderer typecheck and production build; GUI fidelity remains operator-verifiable |
| A16 MED `permission_not_found` re-armed a renderer card that the engine had already removed | fixed | `f5ef9df` | engine-authoritative stale-card removal regression plus permission UI suites (67 pass); renderer typecheck and production build; GUI behavior remains operator-verifiable |
| A16 MED disconnected/parked tabs advertised pending permissions their panes could not render | fixed | `5f07489` | ready-connection attention gate with parked/disconnected regressions (31 pass); renderer typecheck and production build; GUI behavior remains operator-verifiable |
| A18 MED direct-connect success details vanished after the result effect ran | fixed | `a60d080` | request-correlated result regression; success details persist in component state and clear on the next attempt (37 pass); renderer typecheck and production build; GUI fidelity remains operator-verifiable |
| A18 MED SettingsShell accepted four unused live-session props and App recomputed them every render | fixed | `aca8b28` | removed discarded API surface and Settings/App suites (90 pass); renderer typecheck and production build; GUI fidelity remains operator-verifiable |
| A18 MED `DiagnosticsSection` and `WorkspaceTrustSection` were orphaned renderer modules | fixed | `42afa51` | removed both zero-import, zero-test modules; the active Settings/App/MetadataInspector suites pass (109 pass); renderer typecheck and production build; GUI fidelity remains operator-verifiable |
| A18 MED `StartupOAuth` handled a closed phase union without an exhaustiveness tripwire | fixed | `056c7d7` | phase switch now rejects future unhandled variants at typecheck; focused StartupSurfaces suite (17 pass); renderer typecheck and production build; GUI fidelity remains operator-verifiable |
| A18 MED Welcome-screen usage meters ignored the selected accent with hard-coded pink classes | fixed | `dfee305` | meters and labels now use the shared accent tokens; Welcome and Transcript suites (200 pass); renderer typecheck and production build; GUI fidelity remains operator-verifiable |
| A18 MED `CodeThemePreview` duplicated transcript highlighting plugin configuration | fixed | `0650b84` | preview and transcript now import one non-component markdown-plugin module; preview/transcript suites (182 pass); renderer typecheck and production build; GUI fidelity remains operator-verifiable |
| A18 MED Startup, Skills, Agents, and Settings exposed internal/unbuilt-feature vocabulary to users | fixed | `2a8947f` | copy now gives an operator action or a neutral configured state; affected renderer suites (63 pass); renderer typecheck and production build; GUI fidelity remains operator-verifiable |
| A18 MED Welcome-screen Codex usage grid left its usage-window cells unlabeled | fixed | `ec3a649` | named 5-hour/weekly progress values and reset labels, with visual percentages hidden from duplicate announcement; Welcome and Transcript suites (200 pass); renderer typecheck and production build; GUI fidelity remains operator-verifiable |
| A18 MED Agents, Memory, and Remote Settings retained unreachable standalone layouts | fixed | `926a7af` | removed the `embedded` APIs and dead standalone wrappers; affected Settings/Agents/Memory suites (51 pass); renderer typecheck and production build; GUI fidelity remains operator-verifiable |
| A18 MED session rows advertised a button role while containing nested controls | fixed | `124bde6` | keyboard opening now uses a named title button while the pointer row remains structural; Sessions state/action suites (67 pass); renderer typecheck and production build; GUI fidelity remains operator-verifiable |
| A18 MED Agents/Memory duplicated `PathCopyButton`, and Agents/Sessions duplicated `EmptyState` | fixed | `ea7cc43`, `b9540f5` | both pairs now use shared controls while Sessions retains its page-specific message selection; affected renderer suites (45 pass); renderer typecheck and production build; GUI fidelity remains operator-verifiable |
| A20 MED `scripts/preview-transcript.tsx` was outside every TypeScript program | fixed | `a84b22a` | app tsconfig now includes script TSX files; app typecheck and explicit compiler file-list inclusion pass; renderer production build |
| A20 MED hardening-harness success text implied coverage beyond its renderer/main-process checks | fixed | `9ef538a` | success and runner failure signals now name the renderer-document and main-policy scope; source regression (1 pass); app typecheck and renderer production build |
| A20 MED `dev.ts` armed SIGINT/SIGTERM cleanup only after Vite readiness | fixed | `6883ce0` | shutdown is armed immediately after Vite spawn and tolerates absent Electron; dev-launcher suite (15 pass); app typecheck and renderer production build |
| A20 MED `harness-demo.ts` duplicated child termination and left Electron alive on timeout | fixed | `6a4264a` | cleanup now owns both children and timeout awaits the shared bounded terminator; lifecycle source suites (17 pass); app typecheck and renderer production build |
| A15 HIGH removed sessions left unprunable connection, lease, task, and action-result state (including export payloads) | fixed | `c3c7c1a` | host removal now deletes all four state slices; reducer regressions (65 pass); app typecheck and renderer production build |
| A04 HIGH nested transcript projection replaced every unchanged row wrapper after a streamed update, defeating `React.memo` and re-parsing history | fixed | `a70957a` | source-keyed nested-row cache preserves wrappers when the direct-child source list is unchanged; projector/replay regressions (84 pass); app typecheck and renderer production build |
| A04 HIGH collapsed tool cards repeatedly parsed acknowledgement JSON, split Bash output, and counted diff hunks on every streamed render | fixed | `1a6c63d` | result-keyed WeakMap caches retain the three derived values and the body reuses the header acknowledgement parse; TranscriptView suite (177 pass); app typecheck and renderer production build |
| A19 HIGH AskQuestion keyboard handling could consume composer keys or act after another handler claimed them | fixed | `eb3aece` | flow now shares the permission key-owner predicate and bails on `defaultPrevented`; AskQuestion/PermissionPrompt/App renderer suites (123 pass); app typecheck and renderer production build; GUI event dispatch remains operator-verifiable |
| A06 HIGH a rejected, request-correlated inbound verb was ignored by every renderer outcome surface | fixed | `b421891` | correlated `bad_request` frames now join the existing verb-ack failure state and toast path, while uncorrelated framing errors remain ignored; verb-ack reducer regressions (17 pass); existing sidecar boundary tests verify request-id echoing; app typecheck and renderer production build |
| A04 MED injected system turns printed raw engine discriminants as trailing debug tags | fixed | `4e99145` | the operator-facing heading and sender remain, while raw `channel`/`teammate`/`coordinator`/continuation tags are absent; TranscriptView suite (177 pass); app typecheck and renderer production build; GUI fidelity remains operator-verifiable |
| A04 MED expanded Edit cards repeated their file path and ± totals in the shell and DiffView header | fixed | `104ea70` | DiffView is the single owner of the file/count header; regression asserts one addition and deletion total each; TranscriptView suite (177 pass); app typecheck and renderer production build; GUI fidelity remains operator-verifiable |
| A04 MED prose rebuilt a new blockquote component type each render, remounting quote-copy feedback during streaming | fixed | `6a9a553` | prose component map is memoized by raw content and reasoning heading uses a module-stable paragraph override; source identity regression and TranscriptView suite (178 pass); app typecheck and renderer production build; live copy timing remains operator-verifiable |
| A04 MED Tool Inspector re-split and re-searched all output on unrelated toolbar renders | fixed | `6f77c4e` | output search is memoized on body/query/match index, leaving Wrap and Copy changes out of the expensive path; Inspector/search suites (44 pass); app typecheck and renderer production build; large-output scrolling remains operator-verifiable |
| A07 MED parked-and-removed sessions retained full agent-mode snapshots, while lifecycle cleanup left undefined tombstones | fixed | `f246ced` | host removal now deletes the orchestrator entry alongside the other session-scoped stores; lifecycle cleanup is idempotent and deletes rather than retaining undefined; Orchestrator/App suites (69 pass); app typecheck and renderer production build |
| A04 MED inline-output “Show more” depth reset when a lone tool card regrouped into a tool run | fixed | `2817288` | inline reveal depth is now remembered by engine `tool_use` id beside expansion state, so every inline body remounts with the revealed depth; store/regroup regressions (184 pass); app typecheck and renderer production build |

## Known verification limitation

The full real-process sidecar restore/supervisor probe reaches Unix-domain
socket bind, which this sandbox denies. The resume and controller probes pass;
the socket-dependent process probe must be rerun in an environment that permits
Unix socket binding. GUI hardening verification is also still outstanding.

## Next active review item

Continue auditing the remaining confirmed High findings, prioritizing correctness
and security boundaries over structural refactors.
