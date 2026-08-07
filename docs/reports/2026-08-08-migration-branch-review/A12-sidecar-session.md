# A12 — sidecar session lifecycle, resume, catalog, subagent history

## Verdict

The resume path passes its most important test: `sessionResume.ts` genuinely composes the
engine's real machinery (`loadConversationForResume` → `processResumedConversation`) rather
than reimplementing it, and it fails loud instead of falling through to a fresh session. But
it composes that machinery with a **stub context** — the exact recurring mistake CLAUDE.md §8
rule 1 names — and then **throws away everything the engine restored except `messages`**. The
single most important thing to fix is the uncommitted change at `sessionController.ts:159-164`,
which removes the `bypassPermissions` trusted-launch gate and justifies it with a compensating
control (the engine's bypass killswitch) that is not wired anywhere in `app/`. Everything else
here is smaller: an uncapped parallel read on subagent restore, a fully silent catalog failure
path, and an early-exit in `transcriptRunFacts` that is unreachable on non-Codex sessions.

## Findings

### [HIGH] Uncommitted change removes the last leg of the bypass-permissions gate; its stated compensating control does not exist in `app/`
- **Where**: `app/sidecar/sessionController.ts:159-164` (UNCOMMITTED — this line is in the dirty diff), plus `app/sidecar/sessionController.test.ts:445-448` (also dirty)
- **Type**: security
- **What**: The working-tree diff replaces `isBypassPermissionsModeAvailable: process.env.CATCODE_ALLOW_BYPASS === '1'` with an unconditional `true`, and rewrites the test to assert `true`. The new comment claims "The engine's own bypass killswitch remains authoritative when the mode is applied." It does not. `checkAndDisableBypassPermissions` (`src/utils/permissions/permissionSetup.ts:1450`) is called only from `src/main.tsx:2759`; `checkAndDisableBypassPermissionsIfNeeded` / `useKickOffCheckAndDisableBypassPermissionsIfNeeded` (`src/utils/permissions/bypassPermissionsKillswitch.ts`) only from `src/screens/REPL.tsx:740,3136` and `src/commands/login/login.tsx:58`; `isBypassPermissionsModeDisabled()` in `src/state/AppState.tsx:64` is the React `AppStateProvider`, which the sidecar never mounts — it builds its store with a bare `createStore` (`sessionController.ts:280`). Zero call sites in `app/`.
- **Trigger / why it matters**: The chain is now ungated end to end. `app/renderer/src/PermissionModeChip.tsx:86-93,98-104` offers `bypassPermissions` in the picker with no availability check; `app/sidecar/sidecarServer.ts:1639-1694` `handleSetMode` gates only `auto`; the Zod enum accepts it (`app/shared/protocol.ts:99-106`); and this dirty line makes the engine context report it available. A T1-compromised renderer sends one `setPermissionMode(sessionId, 'bypassPermissions')` and every subsequent tool call in that session runs with no prompt and no permission round-trip. `docs/migration/decisions/PERMISSION-BOUNDARY.md:16,196-212` is still the recorded decision and still says "Default (no env var): unavailable + boundary-rejected, identical to the prior always-reject", and `docs/migration/STATUS.md:111` still asserts the gate. Note: `docs/migration/reviews/2026-08-07-status-truth-audit/lane-02-security-baseline.md` F1/F3 independently established the `sidecarServer.ts` half (gate removed in `b74b583`) and reached the same conclusion about the missing killswitch; this finding adds the `sessionController.ts` leg, which is the piece still uncommitted.
- **Fix**: Either restore the env gate here (and the `!== true` reject in `handleSetMode`), or — if the operator has ruled that bypass is a normal app mode — amend `PERMISSION-BOUNDARY.md` §3 and the STATUS row in the same change and delete the false killswitch claim from this comment and from `protocol.ts:91-92,2795-2797`. Do not ship the code change with the decision doc unamended.

### [HIGH] Resume is wired with an EMPTY agent-definition set, so a restored session silently loses its agent
- **Where**: `app/sidecar/sessionResume.ts:93-99`
- **Type**: correctness
- **What**: `processResumedConversation` is handed `agentDefinitions: { activeAgents: [], allAgents: [] }`, `mainThreadAgentDefinition: undefined`, `cliAgents: []`. The engine's `restoreAgentFromSession` (`src/utils/sessionRestore.ts:236-245`) looks the transcript's recorded `agentSetting` up in `agentDefinitions.activeAgents` — against an empty array it can never match, so it takes the "no longer available" branch, logs, calls `setMainThreadAgentType(undefined)`, and returns `agentType: undefined`. It also skips the agent's model application (`:250-256`). `refreshAgentDefinitionsForModeSwitch` (`:795`) is fed the same empty set.
- **Trigger / why it matters**: Restore any desktop session that ran under a custom agent (`agentSetting` recorded in the transcript) → it comes back as a plain session with the main-thread agent type cleared, silently. The doc comment on those lines calls this an acceptable degradation, but the real builder is available at that exact moment: `getAgentDefinitionsWithOverrides(cwd)` is called ~30 lines later in the same startup, via `loadAgentDefinitionsForRuntime` (`sessionController.ts:192-205`, invoked at `:317`). This is CLAUDE.md §8 mistake 1 (`tools: []` / `commands: []` / `getEmptyToolPermissionContext`) in its third documented form.
- **Fix**: Hoist `loadAgentDefinitionsForRuntime(cwd)` in `index.ts` to run before `resumeEngineSession`, pass the result into both `resumeEngineSession` and `createSidecarSessionController`, and cite `src/tools/AgentTool/loadAgentsDir.ts` as the shared source.

### [MED] Everything `processResumedConversation` restores except `messages` is discarded; the thread goal is lost on every restore
- **Where**: `app/sidecar/sessionResume.ts:112` (`return { engineSessionId, messages: processed.messages }`)
- **Type**: correctness
- **What**: `ProcessedResume` (`src/utils/sessionRestore.ts:293-301`) carries `initialState` (with `threadGoal`, `agent`, `attribution`, `standaloneAgentContext`, `agentDefinitions`), `restoredAgentDef`, `fileHistorySnapshots`, and `contentReplacements`. The sidecar keeps only `messages`. The app-state store is then built fresh from `getDefaultAppState()` (`sessionController.ts:280-293`), and nothing in `app/sidecar/**` ever writes `threadGoal` into app state (grep: only `goalDomain.ts:19` reads it; `parseThreadGoal` in `sidecarServer.ts:63` feeds the separate `AppSessionController.goalSnapshot` field, not app state).
- **Trigger / why it matters**: A session with a live thread goal is quit and restored. `loadConversationForResume` does load the goal (`src/utils/conversationRecovery.ts:489`) and `processResumedConversation` does return it (`src/utils/sessionRestore.ts:829`), but `createSidecarGoalDomain.getSnapshot()` reads `null` from the default state — so the goal surface the renderer renders (`App.tsx:3149,3247` via `selectThreadGoalSnapshot`) comes back empty on a session that plainly had one. The whole read-seam is a no-op after restore.
- **Fix**: Return `processed.initialState` (or at minimum `threadGoal` and `agent`) from `resumeEngineSession`, thread it into `createNormalSidecarQueryEngineConfig`'s `createStore` seed alongside the existing `toolPermissionContext` / `effortValue` overrides.

### [MED] Worktree restore moves the process cwd out from under every consumer that uses `args.cwd`
- **Where**: `app/sidecar/index.ts:145` (resume) vs `:176-180` (`cwd: args.cwd`)
- **Type**: correctness
- **What**: `processResumedConversation` calls `restoreWorktreeForResume` (`src/utils/sessionRestore.ts:350-373`), which does `process.chdir(worktreeSession.worktreePath)` plus `setCwd` / `setOriginalCwd` and clears the memory-file and system-prompt caches. `index.ts` captured `args.cwd` in `parseArgs()` before that and keeps using it afterwards for `createSidecarSessionController({ cwd: args.cwd })`, which roots `getCommands(cwd)`, `getAgentDefinitionsWithOverrides(cwd)`, `loadAvailableSettingOptions(cwd)`, `createSidecarWorkspaceTrustDomain(cwd)`, and `createSidecarRemoteSettingsDomain({ cwd })`.
- **Trigger / why it matters**: Restore a session that had entered a worktree (`EnterWorktree` tool, or `--worktree`). The engine's tools then operate inside the worktree while the session's slash commands, agent definitions, settings precedence, workspace-trust verdict and diagnostics all describe the parent repo. There is no warning; the two cwds simply disagree for the life of the session.
- **Fix**: After `resumeEngineSession`, re-read the engine's own cwd (`getCwd()` / `getOriginalCwd()`) and use that as the value passed to `createSidecarSessionController`, rather than the pre-resume `args.cwd`.

### [MED] Subagent restore loads every reachable sidechain transcript in full, in parallel, before the frame budget is applied
- **Where**: `app/sidecar/subagentHistory.ts:239-263`
- **Type**: correctness (resource)
- **What**: Each wave does `await Promise.all(matched.map(... getAgentTranscriptForSession ...))` with no concurrency cap and no per-branch size cap, projects every loaded transcript through `projectResumedHistory`, and only *then* applies `budget` when deciding which branches to keep. The module doc claims the eager cost is "paid for … by the frame budget below", but the budget bounds what is *retained*, not what is *read*.
- **Trigger / why it matters**: Restore a session with many subagents. On this machine right now: `~/.cat-code/projects/-Users-pt-cat-code/3f88d40c-…/subagents` holds 53 sidechain transcripts totalling 21 MB, and `00d21f29-…/subagents` holds 33 totalling 27 MB (largest single sidechain file 19 MB). All of those are read and parsed into `Message` maps concurrently at restore, and most of the resulting frames are then dropped because `budget = 4000 - assembled.length` (`limits.ts:141`) is usually small after the main display load already ran with `maxMessages: MAX_HISTORY_REPLAY_FRAMES`.
- **Fix**: Cap the wave — process candidates sequentially (or in a small batch) and stop as soon as `budget` reaches 0, so the number of transcripts read is bounded by the budget rather than by how many subagents the session ever spawned.

### [MED] Catalog enumeration failures are completely undiagnosable
- **Where**: `app/sidecar/sessionsCatalogDomain.ts:86-90`
- **Type**: quality (error handling)
- **What**: `enumerateSessionsCatalog` wraps the whole `loadAllProjectsMessageLogsProgressive` + build + `annotateCwdExistence` in a bare `catch { return null }` — no message, no stderr, error object discarded. The worker then emits `{ type: 'failure', reason: 'internal' }` (`sessionsCatalogWorker.ts:67-71`) with no detail either, and main keeps its last good snapshot.
- **Trigger / why it matters**: If enumeration starts failing (a permissions change on the projects dir, a corrupt transcript that trips the loader, an OOM at the raised `SESSIONS_CATALOG_ENRICH_LIMIT = 600`), the Sessions page silently freezes on stale data forever and there is nothing in any log to explain it. The same file's sibling paths do log — the worker writes `[catalog-worker] baseline cache write skipped: …` for the strictly less important cache write (`sessionsCatalogWorker.ts:82-84`).
- **Fix**: `catch (error) { process.stderr.write(...); return null }` with the error message, matching the cache-write path.

### [MED] `readTranscriptRunFacts` reads whole transcripts uncapped, and its early-exit is unreachable on non-Codex sessions
- **Where**: `app/sidecar/transcriptRunFacts.ts:76` and `:118-126`
- **Type**: correctness (resource)
- **What**: Two compounding problems. (1) `readFileSync(path, 'utf8').split('\n')` reads the entire transcript with no byte cap and materializes a string array of every line — while the sibling read on the exact same code path is bounded (`loadDisplayTranscriptFromJsonlPath(..., { maxBytes: MAX_HISTORY_REPLAY_BYTES * 2 })`, `transcriptBackfillWorker.ts:152-158`). (2) The early exit requires `facts.effort !== null`, but `effort` is only harvested from a `system`/`codex_send_path` record, which only the Codex send path writes (`src/utils/sessionStorage.ts:486,518`). On any Anthropic-provider session `facts.effort` stays null forever, so the exit never fires and every line of the file is `JSON.parse`d even after the authoritative `run_facts` snapshot has already been found and will overwrite three of the four values anyway.
- **Trigger / why it matters**: The backfill worker calls this per item (`transcriptBackfillWorker.ts:188`). Largest transcript on this machine is 19 MB; total corpus ~1 GB across ~3,000 files. Every Anthropic session pays a full read + full line-by-line parse to recover at most one still-missing field.
- **Fix**: Drop `facts.effort` from the exit condition once `snapshot !== null` (only `usedTokens` is still needed at that point), and give the read the same byte cap as its sibling — tail-read is sufficient since the scan is newest-first.

### [LOW] Sibling instances of the raw-fs-error leak already confirmed on `export`
- **Where**: `app/sidecar/sessionActionsDomain.ts:160-163`, `:194-197`, `:218-221`
- **Type**: security (information disclosure)
- **What**: `rename`, `branch` and `tag` interpolate `error.message` into a renderer-visible string exactly as `export` does (`:177-180`, the established finding). `saveCustomTitle` / `saveTag` / `createFork` all perform engine transcript writes, so an ENOENT/EACCES arrives carrying absolute paths under `~/.cat-code/projects/…`.
- **Trigger / why it matters**: Same trigger as the established one — any fs failure during a Rename / Branch / Tag surfaces the config-home layout in a toast. Reporting the three siblings so a fix for `export` is not applied to one of four call sites.
- **Fix**: One shared `redactActionError(verb, error)` helper: a fixed user-facing sentence, with the raw message logged to stderr instead.

### [LOW] Budget `break` drops subagent branches that would have fit
- **Where**: `app/sidecar/subagentHistory.ts:258-263`
- **Type**: correctness
- **What**: The accumulation loop does `if (branch.frames.length > budget) break` — one oversized branch aborts the whole loop. The candidates were already removed from `pending` at `:236-238`, so the smaller branches after it are never retried on the next wave.
- **Trigger / why it matters**: Session with a chatty first subagent (say 3,000 frames) and several short ones. The long one blows the remaining budget, `break` fires, and the short branches that would each have fit are silently dropped — their Agent cards restore empty even though there was room.
- **Fix**: `continue` instead of `break`, so each branch is considered against the remaining budget independently.

### [LOW] `seenUuids` is computed once per wave, so sibling fork-agent branches cannot dedupe against each other
- **Where**: `app/sidecar/subagentHistory.ts:238`
- **Type**: correctness
- **What**: `seenUuids = collectUuids(assembled)` is captured before the parallel load, so it only reflects frames already spliced — never frames another branch in the *same* wave contributes.
- **Trigger / why it matters**: Two fork agents spawned from one assistant turn both inherit the parent context written with the SAME uuids (`src/utils/sessionStorage.ts:1681`, cited in this file's own doc). Both branches keep those duplicate frames and both spend replay budget on them. The renderer does dedupe on uuid (`transcriptProjector.ts:952-955`, `:1039`) so no duplicate rows render — the cost is purely wasted budget, i.e. real content evicted for frames that will be discarded. That is precisely the cost the `seenUuids` parameter exists to prevent.
- **Fix**: Fold each branch's uuids into the working set as branches are accepted, rather than snapshotting once per wave.

### [LOW] Seed/display uuid alignment treats two missing uuids as a match
- **Where**: `app/sidecar/historyProjection.ts:48`
- **Type**: correctness
- **What**: `displayHistory[start + index]?.uuid === message.uuid` returns true when both sides are `undefined`. The same module's neighbours defensively runtime-check uuids (`subagentHistory.ts:91`, `:122`), so an absent uuid is a real possibility on this type.
- **Trigger / why it matters**: A seed tail whose frames carry no uuid can align at a position it does not actually occupy, producing a merged history with a wrong archival prefix and `truncated: false` — a silently divergent transcript rather than the honest fail-closed the doc comment promises.
- **Fix**: Require both sides to be non-empty strings before comparing; treat a missing uuid as a non-match.

### [LOW] Backfill worker calls `withRestoredSubagentHistory` with no `onError`, so nesting failures are fully silent there
- **Where**: `app/sidecar/transcriptBackfillWorker.ts:164-167` (consumer of `subagentHistory.ts:213-217`)
- **Type**: quality (error handling)
- **What**: The live path passes a stderr sink (`index.ts:207-211`); the backfill path omits the optional third argument.
- **Trigger / why it matters**: An unreadable sidechain file makes cached previews show Agent cards with no children while the live restore of the same session shows them with children — exactly the divergence the comment at `:161-163` says the call exists to prevent — and nothing anywhere records why.
- **Fix**: Pass the same stderr sink the worker already uses for its other diagnostics.

### [LOW] Catalog cache writer is unbounded while its only reader caps at 4 MB
- **Where**: `app/sidecar/sessionsCatalogCache.ts:54-88` vs `app/main/sessionsCatalogBaseline.ts:34,54`
- **Type**: correctness
- **What**: The writer performs no size check. The reader rejects anything over `MAX_SESSIONS_CATALOG_CACHE_BYTES` before parsing and returns `null`. Entry titles come from `customTitle` / `summary` / `firstPrompt` with no length cap (`sessionsCatalogDomain.ts:267-276`), and `SESSIONS_CATALOG_ENRICH_LIMIT` has already been raised once (50 → 600).
- **Trigger / why it matters**: A corpus whose 600 enriched rows carry long first prompts crosses 4 MB. The worker writes the file happily, the emit path also throws at the same 4 MB (`sessionsCatalogWorker.ts:111-113`) → `exit(1)`, and every cold launch thereafter silently reads `null`. Currently ~40x headroom (600 rows measured ~100 KB), which is why this is LOW rather than MED — but the failure is permanent and produces no signal on either side.
- **Fix**: Cap `resolveEntryTitle`'s fallback length, and have the writer refuse (with a stderr line) anything over the reader's limit rather than writing a file that can never be read.

### [LOW] `SessionCatalogEntry.sessionId` is an engine session id in a codebase where `SessionId` means the app-session address
- **Where**: `app/shared/protocol.ts:2495-2497`, populated at `app/sidecar/sessionsCatalogDomain.ts:189`
- **Type**: quality (naming)
- **What**: The field is documented as "matches a live row's `engineSessionId`", but every other place on this wire that means the transcript key spells it `engineSessionId` (`transcriptBackfillWorker.ts:180`, `index.ts:219`). `SessionId` is a bare `string` alias (`protocol.ts:2782`), so a swap type-checks clean.
- **Trigger / why it matters**: The two-id model's only defence is naming discipline; this field breaks it at the one place where a catalog row is joined against a registry row.
- **Fix**: Rename to `engineSessionId` (additive at the wire boundary: accept both, prefer the new one, drop the old after a release).

## What is good here

- **`sessionResume.ts` is a genuine composition, not a reimplementation.** It calls the same two engine entry points the TUI's `--resume` uses — `loadConversationForResume` (`src/utils/conversationRecovery.ts:510`, also used at `src/main.tsx:3776,3817,3861`) and `processResumedConversation` (`src/utils/sessionRestore.ts:646`, `src/main.tsx:3778,3819,3870`) — pins the adopted id via `sessionIdOverride`, then *re-asserts* `getSessionId() === resumeEngineSessionId` and throws `SidecarResumeError` rather than writing to the wrong transcript. `index.ts:402-405` maps that to a dedicated exit code. That is the anti-Potemkin posture done correctly, and it is worth copying.
- **`spliceSubagentBranches` gets the hard part right.** Splicing after the spawning frame (rather than appending) so the newest-first replay cap does not let subagent chatter outrank the parent's recent turns; dropping frames that cannot carry `parent_tool_use_id` rather than letting them land unparented in the main transcript; and `byParent.delete` so a repeated parent id cannot duplicate a branch. All three are covered by tests that state *why* (`subagentHistory.test.ts:58-60,77-78,104-112`).
- **`readSessionsCatalogCache` narrows the untrusted disk shape field by field with zero `as` casts** (`app/main/sessionsCatalogBaseline.ts:84-131`), and every additive field defaults toward the pre-fix behaviour (`cwdExists → true` never wrongly hides; `transcriptTitle → null` never outranks the registry). This is the right shape for a fail-closed parse boundary.
- **`annotateCwdExistence` was deliberately kept off the pure builder** so `buildSessionsCatalogSnapshot` stays filesystem-free and unit-testable, with the `isExistingDir` probe injectable (`sessionsCatalogDomain.ts:106-125`). Good separation under real pressure to just inline the `stat`.
- **`readTranscriptRunFacts`'s wholesale-vs-field-merge rule** (`transcriptRunFacts.ts:129-138`): taking the `run_facts` snapshot as a *unit* because its value is that the four values coexisted in one request, and explicitly accepting bounded staleness rather than rebuilding an incoherent pairing. The reasoning is stated where the code cannot show it.

## Not reviewed / uncertain

- **Whether the bypass-gate removal is operator-ratified.** I found no STATUS row, no `§0` deviation flag, and no amendment to `PERMISSION-BOUNDARY.md`; `protocol.ts` and the renderer have already been changed to match, which reads deliberate. `lane-02-security-baseline.md` reached the same impasse. Only the operator can resolve it — I am reporting the code/decision-doc contradiction, not asserting intent.
- **`sidecarServer.ts` internals** are another reviewer's scope; I traced `handleSetMode` (`:1639-1694`) and the title-generator wiring (`:445-448`, `:1315`) only far enough to establish the bypass chain and the two-id usage. I did note in passing that `handleSetMode`'s sibling at `:1303-1307` catches a synchronous `controller.submit` throw into an unused `error` binding and returns `false` with no log — flagging it only so it is not lost, since it is outside my files.
- **Whether `initializeSidecarModelProvider` pinning the transcript's provider-returned model id** (`sessionController.ts:218,254-267`) is intended to survive alias upgrades. A resumed session adopts a concrete dated model id rather than the alias the user picked. The comment says this is deliberate; I did not find a decision record either way, and did not trace what the run-controls picker then displays.
- **No batteries run.** Per the contract this was read-only; I did not run `bun test app/`, the sidecar typecheck wrapper, or the hardening smoke. Several findings above touch files another session is actively editing (`sessionController.ts`, `sessionController.test.ts`, `permissionDomain.ts` are all dirty), so a battery result would not have been attributable anyway.
