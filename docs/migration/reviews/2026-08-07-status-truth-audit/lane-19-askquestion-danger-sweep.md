# Lane 19 — AskUserQuestion, the danger sweep, and orphan transcripts

**Auditor verdict:** YELLOW
**Rows audited:** 4 · TRUE 3 · OVERSTATED 1 · FALSE 0 · STALE 0 · UNVERIFIABLE-HEADLESS 0

## Row verdicts

### P4-20 — AskUserQuestion interactive answer flow (PARITY-LEDGER §7 DANGER cluster)
**Verdict:** TRUE

**Claims checked:**
1. A live-turn `AskUserQuestion` renders the prototype flow instead of a raw-JSON permission card.
2. A NEW app-owned inbound frame `askUserQuestion.answer` carries per-question option INDICES + freeform "Other…".
3. The sidecar validates with a sidecar-LOCAL schema, does a T5a pending lookup, gates on tool name, re-reads the ENGINE's gated questions, reconstructs `updatedInput.answers` server-side, and resolves via the engine's own `respondToPermissionRequest`.
4. Zero `src/` changes.
5. Renderer excluded from the generic queue and from `selectVisiblePermission`; own keyboard.
6. Round-1 fix (1): `isActivePane` gate threaded App → SessionPane → flow.
7. Round-1 fix (2): `requestId` read BEFORE `safeParse` so a rejected answer clears the renderer's in-flight guard.
8. Round-1 fix (3): a malformed 0-question ask stays in the generic queue, visible and deniable.
9. Cancel = existing `permission.response` deny; no cancel verb.
10. Static accent classes, no dynamic-class trap.
11. Bridge allowlist / hardening inventory updated.

**Evidence:**
- Frame contract `app/shared/protocol.ts:135-155` (`AskUserQuestionAnswer`, `AskUserQuestionAnswerMessage`), in the inbound union at `:477`.
- Sidecar handler `app/sidecar/sidecarServer.ts:2441-2516`. `requestId` is read at `:2449-2451`, **before** `safeParse` at `:2452` — round-1 fix (2) confirmed at source. T5a pending lookup `:2467-2479`. Tool gate `:2483-2492` against `ASK_USER_QUESTION_TOOL_NAME` imported from the real engine tool (`:57`). Resolve through the engine's own path `:2512-2515`, attaching only `answers` onto the engine's own `gatedInput`.
- Closed key-set `checkStrictKeys` entry `sidecarServer.ts:3499` = `{type, requestId, answers}`. Zod schema `:3649-3660`; inner object is `.strict()`.
- Label re-attachment is engine-sourced: `narrowGatedQuestions` `:4138-4166` reads labels off the pending request; `reconstructAskUserQuestionAnswers` `:4176-4229` range-checks every index against `question.options.length`, rejects duplicates, rejects arity mismatch, rejects multi-component answers on a single-select. **No renderer byte becomes an option label** — only the bounded freeform crosses (`MAX_QUESTION_ANSWER_CHARS`). This is the T5a-shaped guarantee the lane asked about, and it holds: an answer cannot be forged for a question the engine did not ask, and it cannot be aimed at a non-AskUserQuestion gate.
- Duplicate-question-TEXT rejection `:4149` is a genuine extra: the tool allows 1-4 questions with no uniqueness rule, and the answer map is keyed by text, so two identically-worded questions would have collapsed into a partial answer reported as success. Fail-closed.
- Renderer selector `app/renderer/src/askQuestionState.ts:107-124`; the SAME readability test drives the generic-queue exclusion `:132-144` — round-1 fix (3) confirmed.
- Keyboard gate `app/renderer/src/AskQuestionFlow.tsx:119-124` (`if (!isActivePane) return`), plus an in-flight guard `:129` and a "never hijack an unrelated field" guard `:150`.
- Preload fixed sender `app/preload/preload.ts:112-124`; main light-coerce + fail-closed drop `app/main/main.ts:975-994`; hardening bridge inventory `app/scripts/hardening-smoke.ts:241`; preload-source pin `app/preload/preloadSource.test.ts:17,79`.

**Reachable-path trace:** engine `AskUserQuestionTool` `requiresUserInteraction` → `permission.requested` event → `permissionState` queue → `selectAskQuestion(permissions, sessionId)` gated on `status === 'ready'` (`App.tsx:2383-2386`) → passed as `askQuestion` into `SessionPane` (`App.tsx:2662`) → mounted at `App.tsx:4284-4294` with `isActivePane={sessionId === activeSessionId}` (`App.tsx:2489`) → user clicks/keys an option → `onAnswerQuestions` (`App.tsx:2663-2686`) → `getBridge().answerQuestions(...)` → preload → `CH_ANSWER_QUESTIONS` → main → sidecar → engine. Cancel path `App.tsx:2687-2696` reuses `buildDenyResponse`.

**Anchor drift:** STATUS cites `handleAgentModeSet:1198` / `handleRunControlVerb:1254`; actual `sidecarServer.ts:1836` / `:1952`. STATUS cites `WorkspacePanels.tsx:139`; the panel map is now `:143`. STATUS's `permissionState.ts:162` for the `&& frame.requestId` reducer guard is **still exact**.

**Did the independent review measurably change outcome quality here? Yes — and this is the lane's one unambiguously positive result.** Both round-1 majors are of the class the SSR-only suite is structurally blind to, and both are still correct at source today, 3 weeks on:
- The split-pane keyboard defect was a genuine cross-session data-loss shape: one `Escape` in a split workspace denied every pending request in every pane. No headless test in this repo could have found it; the fix is source-only and is still in place at `AskQuestionFlow.tsx:124`.
- The `bad_request`-with-`requestId: undefined` deadlock is an *honest-user* trap (over-long paste ⇒ permanently stranded request, every control disabled). The reviewer found it by reading the reducer guard against the sidecar's error emission — a two-module trace no single-layer test performs.
Round-1 also caught a documentation overclaim (tests claimed but absent). That is exactly the failure mode this whole audit exists to detect, caught by the review rather than by the author. **P4-20 is the most trustworthy row I audited**, and the delta is attributable to the review, not to the implementation being easier.

**But the review's own stated blocker never arrived.** P4-20 recorded a `⚠️ STRUCTURAL GAP (needs operator sign-off)`: the `app/` renderer suite is SSR-only, so the keyboard fix is source-verified but not testable. As of today there is **no DOM harness**: `app/package.json` devDependencies contain no `happy-dom`, no `jsdom`, no `@testing-library/*`, no `react-dom/client` test usage; 47 renderer test files still go through `renderToStaticMarkup`, and sibling suites still carry the "adding happy-dom needs sign-off" comment verbatim (`AccountsPage.test.tsx:27-28`, `SettingsEditors.test.tsx:3`, `replayBatchRender.test.tsx:12`). The same caveat is now restated in CC-28 and P4-34. The gap was recorded and then inherited, never closed.

---

### P4-34 — Scattered danger-list sweep (CC-1 §8 · §9 · §11 · §23 · §7 · §29)
**Verdict:** TRUE

Sweep rows are the easiest place for a silent partial, so each of the six was verified independently.

| Item | Claim | Verified at |
|---|---|---|
| §11 `:812` Default-model select | Dynamic-enum over the engine's own `getModelOptions()`, unfiltered; null "Default (recommended)" row crosses as a reserved token the sidecar treats as *remove the key* | Catalog row `app/shared/settingsEditable.ts:206-222` (`kind: 'dynamic-enum'`, `default: SETTINGS_ENGINE_DEFAULT`); reserved token `:130`; options loaded from the real engine registry `app/sidecar/settingsDomain.ts:422-427` (`getModelOptions()` imported `:52`); write path clears the key on the token `settingsDomain.ts:335`; the `dynamic-enum` control renders at `app/renderer/src/SettingsEditors.tsx:300-320`, disabled when no live options. **Real engine source, not stub context.** |
| §11 `:823` Accent swatch | App-local, painted from the composition root via `data-accent` so it applies before Settings opens and survives restart | `AccentThemeProvider.tsx:66` stamps `data-accent` on a wrapper above the app; four rules `theme.css:89,94,99,104`; five swatches `SettingsShell.tsx:801-816`. Mount is above the router, so it is not gated on Settings being open. |
| §11 `:822` CodeThemePreview | Needed no work, already built | `app/renderer/src/CodeThemePreview.tsx`, consumed by `SettingsShell.tsx`. Real component, not a lookalike. |
| §23 Agent memory | Additive outbound snapshot from the engine's own `activeAgents` + `getAgentMemoryDir`, paths and counts only | Type `protocol.ts:975`, carried on the snapshot `:988`; built in `app/sidecar/memoryDomain.ts:140` from the real `src/tools/AgentTool/agentMemory.js` (`:12`); **rendered** at `MemoryPage.tsx:293-304`. Reachable, not built-and-unmounted. |
| §23 `ReauthOAuthProgress` | DELETED, not re-homed | Zero live references. Only three explanatory comments and one **negative** test remain: `StartupSurfaces.test.tsx:225` asserts the key is absent from `startupSurfaces`. |
| §8/§9/§7 (Lane 2) | PermissionRules engine-backed match type + managed-only policy + classifier facts; ⌘K palette real recents + divider + real slash catalog; worker relay chrome from real SDK `agent_id` | C3 fields `protocol.ts:647,650`; built from the engine's real predicates at `app/sidecar/permissionDomain.ts:56` (`shouldAllowManagedPermissionRulesOnly()`) — no stub context; palette recents `commandPaletteModel.ts:225-253` are a projection of real session-local invocations, slash rows from the live `slashCatalog` `:208`; the divider actually renders at `CommandPalette.tsx:162-172`; relay chrome reads `request.request.agent_id` at `PermissionPrompt.tsx:127` with an explicit empty-string-is-absent guard. |
| §29 `/workspace` openSignal | DEFERRED-BLOCKED: no engine `/workspace` command exists, so a renderer branch would be dead code | Confirmed: no `/workspace` in `src/commands.ts` or `src/commands/`, and **no orphan renderer branch was shipped** — the deferral was actually honoured rather than half-implemented. This is the correct outcome for a blocked item. |

**Reachable-path trace (representative, the model select):** engine `getModelOptions()` → sidecar `loadAvailableSettingOptions` at spawn → `AvailableSettingOptions` on the settings snapshot → `SettingsEditors` `dynamic-enum` branch → user picks a row → write path → `SETTINGS_ENGINE_DEFAULT` branch clears the key rather than writing a fabricated default.

**Anchor drift:** none found; P4-34's citations are ledger anchors (`§11 :812`), not source line numbers.

**Note (not a finding):** the row itself is honest about what it does **not** claim — "Fidelity NOT claimed", six operator-only prototype comparisons outstanding, `⬜ operator GUI acceptance PENDING`, one `§0 OPEN`. The 🟡 is correct; nothing here reads as a silent partial.

---

### CC-11 — Codex diagnostic appenders mint orphan transcripts (LIVE, not latent)
**Verdict:** TRUE

**Claims checked:**
1. `recordCodexSendPath` / `recordCodexStreamSurface` were live, invoked from `codex-fetch-adapter.ts`.
2. An ownership predicate `getOwnedTranscriptPath()` gates on `Project.sessionFile !== null` and reads the module singleton directly.
3. Extended to `recordPromptCacheBreak`, whose agent branch uses `getOwnedAgentTranscriptPath()` grounded in `activeSubagents`.
4. `cleanupRegistry.ts` is purely additive; no cleanup/shutdown behavior changed.
5. The residual is an existence *proxy* on the agent branch: cannot create, could append to a stale transcript under a recycled id.

**Evidence:**
- Both appenders are live: `src/services/api/codex-fetch-adapter.ts:255` and `:1668` (found with `rg -a`; the file's literal NUL byte is still present, so plain `rg` traversal remains unreliable there).
- Guard `src/utils/sessionStorage.ts:481-483` — `project?.sessionFile ?? null`, reading the singleton directly. Applied at `:514-515` (send path), `:563-564` (stream surface), `:635` (`recordRunFacts`), `:727-728` (`recordPromptCacheBreak`). Every one returns early on `null` **before** `appendEntryToFile`, so no file is created.
- Agent branch `:589-599`: registered path first (`getActiveSubagentTranscriptPath`, `cleanupRegistry.ts:62`), then a derived path accepted **only if `statSync` succeeds** — it can never create. The `LocalMainSessionTask` fallback the row describes is exactly this second tier.
- `recordPromptCacheBreak` caller confirmed live at `src/services/api/promptCacheBreakDetection.ts:845`.

**Reachable-path trace:** Codex request → `codex-fetch-adapter` prewarm send (fires before any user message, the orphan-minting window) → `recordCodexSendPath` → `getOwnedTranscriptPath()` returns `null` because `project.sessionFile` is unmaterialized → early return, no file written.

**Already-minted orphans (the lane's second question):** they are **not** surfaced to the user. `readLiteMetadata` computes `hasConversation` from the head+tail windows it already reads (`sessionStorage.ts:5677-5683`, matching both spacing variants, which matters because the diagnostic appenders emit spaced JSON while the transcript writer emits compact). `/resume` drops `hasConversation === false` at `:5974`; the desktop sessions catalog drops it at `app/sidecar/sessionsCatalogDomain.ts:186`, before a registry row is minted (so an orphan cannot evict a real restorable session against `MAX_REGISTRY_SESSIONS`). `undefined` (unscanned lite row) is correctly **not** treated as empty in both places. Both surfaces covered; no third listing surface found.

**Anchor drift:** STATUS cites `sessionStorage.ts:465,502` for the two appenders; actual `:497` and `:538`. STATUS cites `promptCacheBreakDetection.ts:821`; actual is `src/services/api/promptCacheBreakDetection.ts:845` (STATUS also omits the `services/api/` path segment). STATUS cites `recordPromptCacheBreak (:626)`; actual `:679`.

---

### CC-28 — An intentionally parked session announced itself as an unexpected crash
**Verdict:** OVERSTATED

**Claims checked:**
1. A renderer-local `'parked'` connection status is classified off the same `PARKED_EXIT_CODE` the host classifies on; no protocol change, no new inbound vocabulary.
2. `'parked'` is non-terminal, so it gets a neutral tone and **no recovery sentence by construction**.
3. The tab drops its danger dot and its Restart button.
4. Honest failures preserved: only `code:5` on an `exited` frame is a park.
5. `parseVisibleSessions` boundary validation at main; one fixed one-way preload sender; host control plane, not sidecar vocabulary.
6. `⬜` Four descriptor-derived surfaces still say "crashed" (§1b).
7. **"A park no longer presents as a failure in the chat view; it still does elsewhere."**

**Evidence — claims 1-6 all hold:**
- Classification `app/renderer/src/connectionState.ts:202-208`; only `frame.status === 'exited' && frame.exit?.code === PARKED_EXIT_CODE` reclassifies, so `disconnected`/`failed`/other codes stay honest (claim 4 ✓).
- No recovery sentence: `connectionRecoveryMessage` `:159-185` returns `null` for `'parked'`, grouped with the transient statuses (claim 2 ✓).
- Tab presentation `app/renderer/src/tabStatus.ts:98-110` returns `{label:'idle', tone:'busy', restartable:false}` (claim 3 ✓), triple-gated on `descriptor.status !== 'spawning' && !== 'ready' && descriptor.restorable` — the third gate is the honesty gate for a never-ran session (§1c).
- Downgrade refusal `connectionState.ts:288` keeps a stray verb from a parked pane from re-crashing it.
- Main-side validation `CH_HOST_VISIBLE_SESSIONS` at `app/main/main.ts:1226-1228`, `parseVisibleSessions` in `mainDecisions.ts` — no sidecar vocabulary added (claim 5 ✓).
- §1b confirmed exactly as recorded: `app/renderer/src/sessionStatusVisual.ts` contains **zero** occurrences of `parked` and maps `disconnected` + `restorable` → `{tone:'dead', label:'crashed'}` at `:59`. Its consumers are `App.tsx`, `sidebarState.ts:237`, `SessionsPage.tsx`, `debugStateReport.ts:54`, `commandPaletteModel.ts:185` (which also puts the label into the row's `ariaLabel` at `:194`). So a parked session still reads `crashed` on the Sessions page, in the ⌘K palette (label + aria-label + keywords), in the Sidebar, and in the debug export. **The row is truthful about this**; it is marked `⬜` and 🟡, not ✅.

**Why OVERSTATED — claim 7 fails, and it fails on the one surface the row says it fixed.** The `'parked'` classification lives **only** in the renderer's in-memory `ConnectionState` (`createConnectionState()` returns `{sessions: {}}`, `connectionState.ts:42-44`). Nothing persists it: IDLE-PARK §11 deliberately keeps it off the `SessionDescriptor`, and main evicts the session's replay buffer at the terminal frame. On any renderer reload with main alive — `did-start-navigation` resets the attachment gate at `main.ts:792-796`, and the replay was already evicted — the reloaded renderer never re-receives that session's lifecycle frame. `selectConnection` then returns the `CONNECTING` default (`:50`), so the `connection.status === 'parked'` gate at `tabStatus.ts:99` cannot match and control falls through to `sessionStatusVisual(disconnected, restorable:true)` → **`crashed`, `dead` tone, and `restartable = true` at `tabStatus.ts:117-123`** — the danger dot and the Restart button, on the tab, which is precisely the surface §1a claims to have fixed. Renderer reload is not hypothetical here: this row's own changelog fixes a bug that begins "a renderer reload left main protecting pre-reload ids", so it is an acknowledged live scenario in this very row. The §1b entry enumerates four descriptor-derived surfaces; this is a fifth path, on a surface §1b explicitly excludes, and it is unrecorded. Note the fork §1b describes — option (B), a `parked` field on `SessionDescriptor` — would close this reload gap too, while option (A) (threading a renderer signal through ~7 modules) would **not**, since the renderer signal is exactly what a reload destroys. That materially changes the fork's cost/benefit and is not stated in the row.

**Anchor drift:** STATUS cites `supervisor.ts:280-281` for the status-set-inside-`child.on('exit')`; that region is now the record-construction block (`app/supervisor/supervisor.ts:275-285`) — the cited behavior is not at the cited line. STATUS also records CC-28 as "**UNCOMMITTED** by operator instruction"; it is committed at HEAD as `217985b fix(app): stop an intentional idle-park presenting as a crash`, and the named files are clean in `git status`.

## Findings

| # | Severity | Row | Defect | Evidence | Failure scenario |
|---|---|---|---|---|---|
| F1 | Medium | CC-28 | Park-vs-crash distinction is renderer-run-local and survives no renderer reload, so the tab regresses to `crashed` + danger dot + Restart on the surface §1a claims fixed. Unrecorded; §1b's four-surface list excludes the tab, and its option-(A) fork would not fix it. | `connectionState.ts:42-44,50` · `main.ts:792-796` · `tabStatus.ts:99,117-123` | Session parks; user reloads the window (or the renderer restarts under a live main); the parked tab now shows the red crash dot and a Restart button, and clicking Restart discards the park's lazy-restore in favour of a full re-spawn. This is the originally reported CC-28 symptom, reachable again. |
| F2 | Medium | P4-20 | The row's own `⚠️ STRUCTURAL GAP (needs operator sign-off)` — a DOM harness for the SSR-only renderer suite — never arrived, and the caveat has since been inherited verbatim by CC-28 and P4-34 rather than resolved. | `app/package.json` devDependencies (no happy-dom / jsdom / @testing-library) · `AccountsPage.test.tsx:27-28` · `SettingsEditors.test.tsx:3` · 47 files using `renderToStaticMarkup` | Every interaction fix in this lane (the `isActivePane` keydown gate, the parked composer gate, the accent repaint, the palette divider) is source-verified only. A future edit that breaks one of them stays green. |
| F3 | Low | P4-20, CC-11, CC-28 | Anchor drift in STATUS citations. | P4-20: `handleAgentModeSet:1198`→`1836`, `handleRunControlVerb:1254`→`1952`, `WorkspacePanels.tsx:139`→`143`. CC-11: appenders `465,502`→`497,538`; `recordPromptCacheBreak :626`→`:679`; `promptCacheBreakDetection.ts:821`→`src/services/api/promptCacheBreakDetection.ts:845`. CC-28: `supervisor.ts:280-281` no longer holds the cited behavior. | A future session follows a cited line, finds unrelated code, and either re-derives from scratch or concludes the claim was false. |
| F4 | Low | CC-28 | STATUS records the work as "**UNCOMMITTED** by operator instruction"; it is committed at HEAD (`217985b`) and the named files are clean. | `git log -- app/main/idleParkDriver.ts` · `git status --porcelain` on the row's files | A session reads the row, believes the work is uncommitted and at risk, and re-does or re-commits it.

## Operator steps required (UNVERIFIABLE-HEADLESS rows only)

None of the four rows is verdicted UNVERIFIABLE-HEADLESS; each row's *wiring* was traced from source. The rows' own declared-open GUI items remain outstanding and are restated here because they gate the ✅, not the verdict:

- **P4-20** — In a SPLIT workspace with two sessions, trigger an `AskUserQuestion` in the left pane. (a) Click an option in the LEFT pane and confirm the answer lands and the turn continues. (b) With focus on the RIGHT pane, press `Escape` and then `1`, and confirm the left pane's pending request is **not** denied and **not** answered. (c) Paste >`MAX_QUESTION_ANSWER_CHARS` into "Other…", press Enter, and confirm the field caps the text and the request is still answerable rather than frozen with every control disabled.
- **F1 (CC-28)** — Open a session, switch away from it, wait for the sweep to park it, return and confirm the tab reads `idle`. Then press `Cmd-R` (or `View → Reload`) **without quitting the app**, and re-read the same tab: if it now shows a red dot, the word `crashed`, or a Restart button, F1 is confirmed live.
- **P4-34** — Six prototype-vs-app screenshot pairs (`PermissionRules.jsx`, `CommandPalette.jsx`, `Permissions.jsx`, `Settings.jsx`, `MemoryPage.jsx`, `Welcome.jsx`); plus pick Amber in the accent swatch, quit and relaunch, and confirm the accent survives restart and that no pink ring remains on the account hero, the live dot, or the cat wordmark.

## Nits

- `sessionStatusVisual.ts`'s header claims it "replaces FOUR drifted copies of the same switch" and exists so "no third status vocabulary is invented"; `tabStatus.ts:98-110` now returns a fifth label+tone decision before calling it. The comment is now self-contradicting. (Mechanism already recorded in CC-28 §1b; only the stale comment is new.)
- No em-dash violations found in `AskQuestionFlow.tsx`, `CommandPalette.tsx`, `ToastHost.tsx`, or `BannerStack.tsx` — every `—` hit in those files is a code comment. No rendered engineering notes, no session ids, and no `MAX_*` names in user-visible strings; the sidecar's `SETTINGS_ENGINE_DEFAULT` token is explicitly kept out of the UI (`settingsDomain.ts:314` notes it is "internal vocabulary no user" should see). No interpolated Tailwind arbitrary-value classes in any file audited.
- `saveCustomTitle` (`sessionStorage.ts:3268`) and `saveAiGeneratedTitle` (`:3311`) still append to a *derived* path with no ownership check. They are rename paths, not diagnostic appenders, and are outside CC-11's claim — but they are the remaining shape that could materialise a metadata-only file. Noted for whoever owns the `LocalMainSessionTask` registry ruling.
- `src/services/api/codex-fetch-adapter.ts` still contains the literal NUL byte, so plain `rg` traversal of that file remains unreliable. CC-11 recorded the fix as deliberately not done (another session held edits there); still not done.
