# Lane 11 — Accounts, models, leases, and pool health

**Auditor verdict:** YELLOW
**Rows audited:** 5 · TRUE 3 · OVERSTATED 1 · FALSE 0 · STALE 1 · UNVERIFIABLE-HEADLESS 0

Audited committed `HEAD` = `d85f770`. `src/utils/model/modelOptions.ts` and
`src/utils/model/anthropic5PickerLabels.test.ts` are dirty from a concurrent
session; every engine claim below was read via `git show HEAD:<path>`. Every
`app/` owner file in this lane is CLEAN at HEAD (`app/main/main.ts` is dirty but
the accounts wiring I cite is at HEAD too). No live account action was taken: no
login, no token refresh, no usage poll, no vault write.

## Row verdicts

### CC-20 — Accounts page could not show account usage (global read was on the per-session transport)
**Verdict:** TRUE
**Claims checked:**
1. Three new files exist (`app/shared/accountsPoolWorker.ts`, `app/sidecar/accountsPoolWorker.ts`, `app/main/accountsPoolRunner.ts`).
2. Accounts is now a **host-plane** read, not the per-session transport.
3. Cadence 60 s, single-flight, start-anchored; a failed run keeps the last good pool.
4. Redaction REUSED via the already-exported pure `buildAccountsSnapshot`, not re-derived.
5. The worker does NOT call `initializeSidecarRuntime()` / `init()`; it uses `loadPoolForObservation()` + `enableConfigs()`.
6. `secretGuard` runs at the worker AND again at main's parse boundary.
7. Renderer has a global slot that outranks the session copy and survives session teardown.
8. Writes stay session-plane `account.*` verbs; no new preload channel, no new inbound vocabulary, no protocol bump.
9. Waiting-state copy no longer prints engineering notes.
10. Usage-analytics half explicitly NOT closed.

**Evidence:**
- `app/main/main.ts:532-551` builds the driver and emits `sendHostEvent({type:'accounts-pool', pool})`; armed at `app/main/main.ts:833` inside `window.once('ready-to-show')`. `app/shared/hostApi.ts:226` carries `accounts-pool` on `HostEvent` — the host plane, outbound-only. No `HostApi` error union was touched (the event is not a `HostApi` result), so the two planes' error unions remain separate.
- `app/main/accountsPoolRunner.ts:44` `ACCOUNTS_POOL_REFRESH_INTERVAL_MS = 60_000`; `:260-288` start-anchored single-flight; `:278-283` swallows a failed run so `onPool` is never called and the renderer keeps its snapshot.
- `app/sidecar/accountsPoolWorker.ts:78-105` imports `loadPoolForObservation` / `loadClaudePoolForObservation` / `ensureEngineMacro` / `enableConfigs` only — `initializeSidecarRuntime` appears nowhere in the file. `:132-138` calls the shared `buildAccountsSnapshot`. `:157` worker-side `scanForSecrets`; `app/main/accountsPoolRunner.ts:149` re-scan at the parse boundary.
- `src/services/api/codexAccountPool.ts:183-207` `loadPoolForObservation` is disk-read-only (vault + config), sets `pool.*` in memory, writes nothing. `:213-235` `initAccountPool` is the one that starts `startPeriodicRefresh`/`startQuarantineProbe`/`touchAll` — correctly avoided.
- `app/shared/accountsPoolWorker.ts:161-183` `hasExactKeys` allowlist on every account row: a smuggled `accessToken` key fails the whole record. `app/shared/secretGuard.ts:28-35` blocks `accessToken`/`refreshToken`/`vaultFilePath`/`idToken`.
- `app/renderer/src/accountsState.ts:62-64` stores the global pool; `:152-156` `selectGlobalAccountsSnapshot` prefers `state.pool`, never reads `activeSessionId`; `:94-101` the `lifecycle` teardown branch clears only `sessions`, never `pool`.
- `app/renderer/src/AccountsPage.tsx:681` renders `Loading accounts…`; a grep of the file for `sidecar`/`prototype`/`redacted` finds only comments.
- `app/sidecar/sidecarServer.ts:3503-3508` the six `account.*` verbs stay on the session plane with exact-key allowlists.

**Reachable-path trace:** `ready-to-show` → `startupTimers.schedule(startAccountsPoolRefresh)` (`main.ts:833`) → `createAccountsPoolDriver.start()` → `bun run app/sidecar/accountsPoolWorker.ts --bare` → one NDJSON record → `parseAccountsPoolWorkerResult` + `scanForSecrets` → `sendHostEvent` → `App.tsx:930` `event.type === 'accounts-pool'` → `dispatchAccounts({type:'pool'})` → `App.tsx:3251` `<AccountsPage snapshot={selectGlobalAccountsSnapshot(accounts)}/>` → mounted under `activeView === 'accounts'`, reachable from the unconditional sidebar item (`Sidebar.tsx:250` `{id:'accounts', label:'Accounts', enabled:true}`, click at `Sidebar.tsx:974`). No session required at any hop.

**Anti-Potemkin:** the producer is a real spawned process wired at a real Electron lifecycle hook, not a fixture; the parse boundary and the renderer selector are two different modules and both were read.

**Anchor drift:** three. `sidecarServer.ts:2569` (guarded one-shot `refreshAccountsUsageOnce`) is now `app/sidecar/sidecarServer.ts:3173`. `accountsDomain.ts:430` (`buildAccountsSnapshot`) is now `:440`. `accountsDomain.ts:56-70` (described as the `getPoolStatus()`/`getClaudePoolStatus()` reads) is now the import block; the reads live at `:440-478`. `codexAccountPool.ts:171-181` and `claudeAccountPool.ts:101` still land on the cited doc blocks.

### CC-17 — Restore Anthropic models after the OpenAI-only retirement
**Verdict:** TRUE
**Claims checked:**
1. Per-request routing: `gpt-*` always to OpenAI regardless of session provider.
2. Session provider precedence: explicit selection > `CLAUDE_CODE_USE_*` > saved startup preference > Anthropic.
3. Credential-aware pre-turn model options.
4. Explicit Claude selection crosses from OpenAI to first-party/Bedrock/Vertex/Foundry; provider-local Default clears the explicit model.
5. First accepted submit locks cross-provider changes.
6. Resumed sessions ignore synthetic/API-error tails and seed the latest real transcript model.
7. Composer shows the Claude subscription account only when that pool authenticates the route.
8. Accounts renders both pools.
9. `account.login` strict-schema validated.

**Evidence:**
- `src/utils/model/providers.ts:67-71` `getProviderForModel` → `'openai'` for `gpt-`; `:190-195` `resolveRequestProvider` puts the model implication ahead of the base provider. `:20-41` `getAPIProvider` → session first, then `getEnvAPIProvider` (Bedrock/Vertex/Foundry/OpenAI env), then `getStartupProviderPreference()`, then `'firstParty'`. Matches the stated precedence exactly.
- `src/utils/model/providers.ts:100-114` the cross-provider selection rule; `:79-87` `getConfiguredAnthropicProvider`.
- `git show HEAD:src/utils/model/modelOptions.ts` `:332-371` credential-aware base list (Codex subscriber gets GPT plus, only pre-lock and pre-first-token with `hasAnthropicCredentials()`, Sonnet 5 / Opus 5 / Fable 5 / Haiku 4.5); `:373+` the Claude-subscriber branch; `:595-617` the pre-first-query GPT cross-add.
- Desktop consumes the ENGINE's own list, not a local one: `app/sidecar/runControlsDomain.ts:64-66` imports `getModelOptions` from `src/utils/model/modelOptions.js`; `:433` calls it. No stub context at this seam.
- `app/sidecar/runControlsDomain.ts:124-127` `applyModelOverride` calls `setSessionProvider(resolveModelSelectionProvider(model))` then `setMainLoopModelOverride`; `:169-183` `activateProvider` sets route + provider-local default (`null` for Anthropic) + persists the startup preference.
- Lock: `app/sidecar/sidecarServer.ts:1283` calls `this.runControls?.lockProviderSwitches()` on the accepted-submit path, before `this.activeTurn = true`; impl `app/sidecar/runControlsDomain.ts:368-374`.
- Resume: `git show HEAD:app/sidecar/sessionController.ts:260-273` `selectResumedProviderModel` skips `isApiErrorMessage` and `SYNTHETIC_MODEL`; consumed at `:283-285`.
- Chip gate: `app/renderer/src/appModel.ts:50-58` requires `provider === 'anthropic' && anthropicSubscriptionActive === true`; consumed at `App.tsx:2450` and passed to `SessionPane` as `activeAnthropicAccount`.
- Both pools on the page: `AccountsPage.tsx:840-848` renders `snapshot.anthropicAccounts`.
- `app/sidecar/sidecarServer.ts:3508` + `:3703` — `account.login` exact-key set plus Zod literal.

**Reachable-path trace:** composer model picker → `run-control` verb → `runControlsDomain.setModel` → engine `setSessionProvider`/`setMainLoopModelOverride` → `QueryEngine` reads `getMainLoopModel()` per turn; options round-trip from `getModelOptions()` back to the picker via `RunControlsSnapshot`.

**Anchor drift:** the row's `account.login {provider, activateProvider?}` no longer matches source (`activateProvider` is not in the allowlist), but CC-17R's row states in its first sentence that it supersedes CC-17's OAuth clauses, so this is disclosed, not hidden. Row remains 🟡 with GUI/hardening explicitly pending.

### CC-17R — Anthropic restoration post-review hardening
**Verdict:** TRUE
**Claims checked (the ones settleable from source):**
1. Managed-org validation is pre-commit.
2. First-run activation is sidecar-owned and `account.login` carries only `{provider}`.
3. External API-key routing cannot display retained Claude subscription identity.
4. Startup resolves provider BEFORE provider-sensitive tool selection.

**Evidence:**
- `app/sidecar/accountsDomain.ts:348-359` — `persist()` awaits `validateOrg(tokens.accessToken)` and throws before `installTokens(tokens)`; the comment states the ordering reason.
- `app/sidecar/accountsDomain.ts:170-184` `isSidecarFirstRunEligible` is sidecar-local (reads both pools + `hasAnthropicCredentials`); `:652` `pendingProviderActivation = isFirstRunEligible() ? provider : null` — the renderer contributes nothing; `:680` and `:752` fire `onProviderActivated` only after `login.persist()` resolves. `sidecarServer.ts:3508` allowlist is `{type, requestId, provider}`.
- `app/renderer/src/appModel.ts:50-58` gates the subscription chip on `anthropicSubscriptionActive`, which `accountsDomain.ts:429-437` derives from `isClaudeAISubscriber()` — an API-key/Bedrock/Vertex/Foundry route reports false.
- `git show HEAD:app/sidecar/sessionController.ts` — `initializeSidecarModelProvider(resumedModel)` at `:285` precedes `getTools(...)` at `:301`.

**Reachable-path trace:** Accounts page "Add account" → `account.login` verb → sidecar OAuth controller → engine `OAuthService` → `persist()` → org gate → `installOAuthTokens` → accounts re-broadcast → page refresh.
**Anchor drift:** none checkable (the row cites a review doc, not line anchors).

### P4-5 — Accounts + Codex pool/lease + AccountLifecycle
**Verdict:** STALE
**Claims checked:**
1. "Canonical domain read-seam recipe (C3 outbound snapshot + `secretGuard` — no token leaves engine)".
2. Six validated lifecycle verbs.
3. Produces pool status for P4-15/P4-17.
4. Merged `c9e3a54`, reviewed GREEN.
5. Title scope includes "Codex pool/lease".

**Evidence:**
- Claims 2-4 hold. Six verbs at `app/sidecar/sidecarServer.ts:3503-3508` (`switch`, `rename`, `delete` with required `confirm`, `logout`, `touchAll`, `login`), each with an exact-key allowlist and a Zod schema at `:3677-3703`. Redaction whitelist at `app/sidecar/accountsDomain.ts:383-410` copies fields explicitly so a future `PoolAccount` token field cannot leak. `c9e3a54` exists with the matching subject line. P4-17 consumes it via `selectFirstAccountsSnapshot` (`accountsState.ts:131-138`, used at `App.tsx:2410-2411`), P4-15 via `oauthProgress`.
- Claim 1 is SUPERSEDED for the READ half. CC-20's own row names this recipe as the cause of the defect ("P4-5 shipped a global read as a per-session domain"), and `app/renderer/src/accountsState.ts:11-23` now documents two feeds with "The Accounts page reads THIS" pointing at the host-plane `pool`, not the P4-5 session snapshot. The P4-5 row carries no supersession note, so a reader taking it at face value would copy a recipe the program has since rejected for global state. The WRITE half (the six verbs) is untouched and still current.
- Claim 5: no lease surface was delivered by P4-5. `app/renderer/src/leaseState.ts:1-10` and `app/sidecar/leaseDomain.ts` are both headed P4-32b (`decisions/ORCHESTRATOR-IN-SESSION.md` §7, ruled 2026-07-30); the producer is `sidecarServer.ts:2890-2917` and the consumer `App.tsx:3457`. The row's title names a scope its detail column never claims to have built.

**Reachable-path trace (write half):** Accounts page row menu → `onVerb` → `App.tsx:1316` `sendAccountVerb` → session socket → sidecar allowlist + Zod → `createRealAccountsExecutor` (`accountsDomain.ts:489+`) → the engine's own `switchToAccount`/`removeCodexAccount`/`setAccountAlias`/`touchAll` → `account.result` frame → toast.
**Anchor drift:** the row cites no line anchors.

### P4-50 — Account health surfaces only inside the scrolling transcript
**Verdict:** OVERSTATED
**Claims checked:**
1. Bar appears exactly when `AccountStatus.availability` is `blocked` for every account in an initialized non-empty pool.
2. `availability` is the engine's `getCodexAccountAvailability().kind` projected verbatim.
3. Dismissal is in-memory, keyed to the banner id, cleared when the id changes or goes null; no `localStorage`.
4. One action, `Open Accounts`, that navigates only.
5. Copy mirrors `emitCodexUnavailableDiagnostic`'s wait-vs-repair split; the `0` reset sentinel is not formatted as a time.
6. Submit is never gated; the wall files are absent.
7. One mount above `WorkspaceLayout`, so a split view shows one bar.
8. `BannerStack` has its first production importer.
9. `formatResetLabel` gained an optional `now`.

**Evidence:**
- `app/renderer/src/accountHealthBanner.ts:69-101` — the four gates (`!snapshot`, `!initialized`, `length === 0`, `every(availability === 'blocked')`), then the `every(status === 'capped')` split into warn/danger. `:51-59` `earliestReset` filters `reset <= 0`, so the `0` sentinel is never formatted. Copy strings match the row verbatim and contain no em dash.
- `app/sidecar/accountsDomain.ts:389` `const availability = getCodexAccountAvailability(account, now).kind`, projected at `:394`. Engine source `src/services/api/codexAccountPool.ts:1544-1572` returns exactly `blocked | warned | available`.
- `app/renderer/src/App.tsx:1375-1396` — derivation, `dismissedAccountHealthId` `useState`, and the `useEffect` that resets it whenever `accountHealthBannerId` changes. No `localStorage` anywhere in the block.
- `App.tsx:3399-3403` the single `<BannerStack>` with `onAction={() => setActiveView('accounts')}`, mounted as a sibling ABOVE `<WorkspaceLayout>` (`:3403` vs `:3404`).
- `App.test.tsx:2157-2175` pins all of it structurally: `SessionPane` source contains no `accountHealth`, exactly one `<BannerStack`, and it precedes `<WorkspaceLayout`. `ls app/renderer/src | rg -i 'reauth|wall'` returns nothing — the sweep held.
- `app/renderer/src/accountsPageModel.ts:154` `formatResetLabel(sec, now = Date.now())` — cited line is exact.
- `BannerStack` production importers: `App.tsx` plus `accountHealthBanner.ts` (type-only) and `bannerStackModel.ts`/`tone.ts`/`SessionActionIcons.tsx`. `App.tsx` is the mount.

**Where it is overstated:** the derivation reads ONLY the Codex pool (`snapshot.accounts`) and has no provider gate — `rg -n 'provider' app/renderer/src/accountHealthBanner.ts` returns zero hits, and `App.tsx:1375` passes only the snapshot. CC-17 restored the Anthropic route, so a session routed to Anthropic (or Bedrock/Vertex/Foundry/API key) with stale-capped Codex accounts still in the vault raises a bar whose detail line reads "Sending will keep failing until an account resets." That statement is false for that session. The row's §0 flag (b) covers the OPPOSITE gap (no bar for the Anthropic pool) and does not disclose this one. The bar is mounted globally, above the workspace, so it has no session and therefore no provider to gate on: the fix is a design question, not a one-liner.

**Reachable-path trace:** accounts worker → `accounts-pool` host event → `accountsState.pool` → `selectGlobalAccountsSnapshot` → `selectAccountHealthBanner` → `<BannerStack>` above `<WorkspaceLayout>`, rendered in the `activeView === 'chat'` branch. Consumer is real and mounted.
**Anchor drift:** STATUS cites `App.tsx:1257` for the dismissal clear; actual is `App.tsx:1387-1392`. `accountsDomain.ts:388` is now `:389`. `client.ts:197-207` for `emitCodexUnavailableDiagnostic` is now `:200-224` (the split logic at `:204-211`) and `client.ts:227-229` is `:226-229`.

## Findings

| # | Severity | Row | Defect | Evidence | Failure scenario |
|---|---|---|---|---|---|
| F1 | Medium | P4-50 | The account-health bar reads only the Codex pool and has no provider gate, but CC-17 restored the Anthropic route. Not covered by the row's §0 flags. | `app/renderer/src/accountHealthBanner.ts:73-101` (zero `provider` references); `App.tsx:1375-1377` passes only the snapshot | User runs an Anthropic-routed session with old capped Codex accounts still in the vault. A warn bar appears saying "Sending will keep failing until an account resets." Sending works fine. They dismiss it; it returns next run. |
| F2 | Medium | P4-5 | The row's headline claim, the "canonical domain read-seam recipe", was disowned by CC-20 for global state, and the row carries no supersession pointer. Its title also scopes "Codex pool/lease", which P4-32b delivered, not P4-5. | CC-20 row text vs `app/renderer/src/accountsState.ts:11-23`; `app/renderer/src/leaseState.ts:1-10` (P4-32b) | A future session reads P4-5 as the pattern for a new global read seam and rebuilds the exact defect CC-20 spent a session removing. |
| F3 | Low | CC-20 | Anchor drift in three cited anchors. | `sidecarServer.ts:2569` → `:3173`; `accountsDomain.ts:430` → `:440`; `accountsDomain.ts:56-70` → `:440-478` | A reader verifying the row lands on unrelated code and cannot confirm the claim. |
| F4 | Low | P4-50 | Anchor drift in three cited anchors. | `App.tsx:1257` → `:1387-1392`; `accountsDomain.ts:388` → `:389`; `client.ts:197-207` → `:200-224` | Same as F3. |

**Explicitly checked and CLEAN — no finding:**
- **Lock/ledger machinery (`src/codex-core/accounts.ts`) is neither duplicated nor bypassed.** The desktop never touches the vault directly: a repo-wide search for vault I/O under `app/` returns only type names and comments. The 60 s worker path is `loadPoolForObservation()` (disk read, no write) + `loadClaudePoolForObservation()` (deliberately chosen over `initClaudeAccountPool()` precisely because that one can WRITE a vault file) + `fetchPoolUsage` (GET with existing tokens, `codexUsage.ts:199-221`, no refresh). `updateAccountUsageHints` (`codexAccountPool.ts:1250-1309`) mutates the in-memory singleton only and the worker then exits. All WRITES go through the engine's own `switchToAccount`/`removeCodexAccount`/`setAccountAlias`/`touchAll`, which own the locking.
- **No cross-process read-modify-write.** `accountsDomain.ts:607-618` `resolveAccountForWrite` re-reads via the engine's observation-only load on a miss only, and a failed re-read is non-fatal.
- **Security baseline intact.** `accounts-pool` is outbound-only on the existing `catcode:host:event` channel; no new preload channel, no new inbound frame kind, no protocol version bump. Double `secretGuard`. Exact-key boundary parse would reject a smuggled token field. No `as` casts on untrusted worker output.
- **Host-plane vs session-plane error unions are NOT merged.** `accounts-pool` is a `HostEvent` variant (`hostApi.ts:226`), not a `HostApi` result; no error union was extended.
- **No em dash in any user-visible string** in `AccountsPage.tsx`, `accountsPageModel.ts`, `accountHealthBanner.ts`, `leaseState.ts` — every hit is a code comment. No rendered engineering notes, no session ids, no internal vocabulary.
- **No Tailwind dynamic-class trap.** The two inline styles in `AccountsPage.tsx` (`:163`, `:654`) are data-driven percent widths, flagged as §0 exceptions in source.

## Operator steps required (UNVERIFIABLE-HEADLESS rows only)

None of my rows resolve to UNVERIFIABLE-HEADLESS: every row already declares its
own GUI acceptance as pending, and I could settle each source claim without one.
For completeness, the GUI acceptance the rows themselves still owe:

- **CC-20:** launch the dev app, click the sidebar Accounts item with no session tab open. The pool must populate within a few seconds. Leave it for >60 s without touching anything and confirm a headroom percentage moves.
- **P4-50:** cannot be settled without a genuinely capped pool. Staging one burns real quota. Leave UNVERIFIED as the row states, and re-check F1 at the same time by putting a stale capped Codex account in the vault while running an Anthropic-routed session.
- **CC-17 / CC-17R:** operator checks for provider cards, the Anthropic row and its switch, Default/model/effort/Fast, resumed routing, plus `bun run --cwd app test:hardening`.
- **P4-5:** the operator-only live pool + no-token-leak assertion.

## Nits

- With no session open, clicking Add account on the Accounts page returns "Open a session first, then change accounts from there." (`App.tsx:1318-1336`). Correct and honest, but the login verb hits the same early return as the mutating verbs, so the one action that does not conceptually need a session is refused too. In practice the app spawns a startup session, so this is near-unreachable.
- The accounts worker performs one authenticated GET per account every 60 s for as long as the app is open, and the engine-side 1-minute cache never helps because the process is disposable. The runner's own comment states this. Worth an eye if the account roster grows.
- `selectAccountHealthBanner` is called without an explicit `now` at `App.tsx:1375`, so the "back in 45m" wording only refreshes when something else re-renders App. Cosmetic.
