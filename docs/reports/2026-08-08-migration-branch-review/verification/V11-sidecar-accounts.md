# A11 adversarial validation: sidecar accounts, leases, settings, extensions, trust

> **Verification provenance:** `claude-opus-5`, high reasoning effort. Read-only
> source review plus three standalone scratch scripts run against repo modules
> (interactivity default, secretGuard leak proof, quarantine-probe write proof)
> in the scratchpad — no repo file was edited, no test suite was run, no GUI, no
> desktop app started, no git write. Branch `migration` at `a17e5e9`.
> Scratch scripts:
> `/private/tmp/claude-501/-Users-pt-cat-code/cdbe5dee-58e0-41f0-8421-b6cd23d30457/scratchpad/v11/{interactive,leak,probe}.ts`.

## Overall verdict

The original A11 report is substantially right about **where** the problems are
and consistently sloppy about **how big** they are. Of 16 findings, 8 are
CONFIRMED, 5 are PARTIALLY CONFIRMED, 1 is OVERSTATED, 2 are CONFIRMED with
material corrections folded in — none is INVALID, which is unusual for this
review set. The single most important claim, the HIGH about N sidecars becoming
N vault writers, survives only in narrowed form: I proved by scratch script that
the startup `touchAll()` **never runs in a sidecar** and that the 1 Hz quarantine
probe **performs zero disk I/O unless an account is already quarantined**, and
`MAX_LIVE_ENGINES = 4` caps "N" at four. The one finding I could prove outright
with a runnable repro is F3 (MCP `url` / hook `displayLine` crossing to the
renderer past `secretGuard`) — that one is exactly as described and is the item
that most deserves action, because it is a hard security-baseline gate, it needs
no race to fire, and the fix is ten lines. The report's clean bill for the trust
grant and the settings write both hold on inspection; one supporting line
citation in that section is wrong.

## Summary

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| F1 | HIGH | Every sidecar spawn starts live credential rotation → N writers | PARTIALLY CONFIRMED | Spawn path real; startup `touchAll()` proven not to run, probe proven to write only for quarantined accounts, N capped at 4 |
| F2 | HIGH | Non-atomic Claude-vault write + can resurrect a deleted account | PARTIALLY CONFIRMED | (a) is a one-shot migration write, not "every spawn"; (b) real but only for the LAST account, and fires on any CLI start too |
| F3 | HIGH | MCP `url` / hook `displayLine` carry credentials past `secretGuard` | CONFIRMED | Proven by scratch script: both fields reach the frame verbatim, guard returns `ok:true` |
| F4 | MED | `account.rename` unlocked whole-file vault rewrite | CONFIRMED | `setAccountAlias` takes no lock; pre-existing `src/` code also reachable from `/rename-account` |
| F5 | MED | Throwing `onProviderActivated` wedges the OAuth state machine | PARTIALLY CONFIRMED | Wedge is real; the report's trigger is unreachable — needs a zero-credential machine and the Codex runner only |
| F6 | MED | Second `account.login` strands machine-global port 1455 | CONFIRMED | Codex runner has no `cancel`, `resolveManualCode` orphaned, `waitForCode` has no timeout |
| F7 | MED | Stale settings snapshot causes a cross-window lost update | CONFIRMED | Snapshot frozen at spawn; the toggle sends `!staleValue` as an absolute write |
| F8 | MED | Engine free text uncapped on the accounts snapshot | OVERSTATED | Inconsistency real, but the frame cap is 32 MB and every writer is a short fixed-form string — no trigger |
| F9 | MED | `remoteSettings.directConnect` unbounded-host egress | CONFIRMED | No host policy, `cwd` is POSTed, `withTimeout` has no `AbortSignal` |
| F10 | MED | Silent `catch { return null }` on three snapshot reads | CONFIRMED | All six cited locations exact; settings/trust siblings do log |
| F11 | MED | `accountsDomain.ts` is a read seam plus a 250-line OAuth machine | CONFIRMED | 949 lines, ranges exact, the two named coverage gaps verified absent |
| F12 | LOW | Anthropic runner re-implements `installOAuthTokensAfterPolicyValidation` | CONFIRMED | Same file already imported at `accountsDomain.ts:70`; the two copies already differ |
| F13 | LOW | Lease snapshot rebuilt on every app-state mutation | PARTIALLY CONFIRMED | Raw subscribe real, but `AppState` has no top-level `messages` — the trigger rides task state |
| F14 | LOW | Four unchecked `as` casts into closed wire unions | CONFIRMED | All four exact; the tripwire idiom exists three files over |
| F15 | LOW | `buildBridgeStatusSnapshot` filed under "Pure projection" | CONFIRMED | Impure `isEnvLessBridgeEnabled()` at `:143`; banner scoping is a partial defense |
| F16 | LOW | `createSidecarExtensionsDomain` is a pass-through | CONFIRMED | Exact; the domain holds no state, no read, no verb |

Layer attribution, per the reviewer's question:

| Finding | Defect lives in | Branch-new? |
|---|---|---|
| F1 | `app/sidecar/initializeRuntime.ts` (choice to call `init()`) + `src/services/api/codexTokenRefresh.ts` (the unlocked RMW) | `app/` half is branch-new (`app/` does not exist on `main`); the rotation machinery predates the branch (`persistNextQuarantineProbe`, `startQuarantineProbe` both present on `main`) |
| F2 | `src/services/api/claudeAccountPool.ts` + `src/commands/delete-account/` | Engine-side; `initClaudeAccountPool` is on `main`. Only `loadClaudePoolForObservation` is branch-new |
| F3 | `app/sidecar/extensionsDomain.ts` + `app/shared/secretGuard.ts` | Fully branch-new (`app/`). `getHookDisplayText` is unmodified upstream `src/` |
| F4 | `src/services/api/codexAccountPool.ts` `setAccountAlias` | Pre-existing (`setAccountAlias` on `main`); only the UI button is branch-new |
| F5, F6, F7, F8, F9, F10, F11, F13, F14, F15, F16 | `app/sidecar/**` | Fully branch-new |
| F12 | `app/sidecar/accountsDomain.ts` duplicating `src/cli/handlers/auth.ts` | Both branch-new (`installOAuthTokensAfterPolicyValidation` is absent on `main`) |

## Per finding

### F1 — [HIGH] Every sidecar spawn starts the engine's live credential-rotation machinery, so N sessions become N writers on one vault

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: Mostly, with three off-by-N citations.
  `app/sidecar/index.ts:132` is `await initializeSidecarRuntime()` — exact.
  `app/sidecar/initializeRuntime.ts:40` is `await init()` — exact.
  `src/entrypoints/init.ts:89,95` is wrong by one: `void initAccountPool()` is at
  **`:90`** and `initClaudeAccountPool()` at **`:96`**.
  `codexTokenRefresh.ts:782,788` is wrong: `startPeriodicRefresh` is at **`:743`**
  and `startQuarantineProbe` at **`:785`** (`setInterval` at `:789`).
  `runQuarantineProbeOnce` is at **`:812`**, not `:838` (`:838` is the
  `persistNextQuarantineProbe` call *inside* it). `persistNextQuarantineProbe`
  at `:881`, the unlocked `next_probe_at` read at `:828-835`, `lock(vaultFilePath)`
  at `:293` and the ownership throw at `:537` are all exact.
- **Reachable in production?**: Yes. `initializeSidecarRuntime()` is gated only on
  `!args.probeOnAttach`; there is no env gate, feature flag or singleton in the
  way. `init` is `memoize`d, so it runs once **per process** — and the supervisor
  spawns one child process per `sessionId`
  (`app/supervisor/supervisor.ts:251`, registry keyed by session), so per-session
  is per-process. `SupervisorOptions.sidecarEnv` is declared
  (`supervisor.ts:59`) but never assigned anywhere in production code, so nothing
  suppresses the pool init.
- **Trigger**: Open three sessions on a machine with at least one Codex **vault**
  account (the `pool.accounts.some(a => a.source === 'vault')` gate at
  `codexAccountPool.ts:222`) and get one of them quarantined. Three independent
  1 Hz timers then each perform an unlocked whole-vault read-modify-write of that
  account's file, with only an unlocked `next_probe_at` read as a serializer.
- **Counter-arguments considered** — four of them land, and they materially
  shrink the finding:
  1. **The startup `touchAll()` does not run in a sidecar.** `initAccountPool`
     guards it with `shouldRunStartupCodexTouchAll()` =
     `!getIsNonInteractiveSession()` (`codexAccountPool.ts:162`).
     `STATE.isInteractive` defaults to `false` (`src/bootstrap/state.ts:315`) and
     the **only** production caller of `setIsInteractive` is `src/main.tsx:848`
     (the CLI). Nothing under `app/` calls it. Proven, not inferred:
     ```
     $ bun run scratchpad/v11/interactive.ts
     getIsInteractive() = false
     getIsNonInteractiveSession() = true
     => shouldRunStartupCodexTouchAll() would be false
     ```
     The report lists the startup `touchAll()` as one of three side effects; that
     third is **refuted**.
  2. **`startPeriodicRefresh` is not a 1-second timer.** It reads
     `codexTokenRefreshIntervalHours` and defaults to **4 hours**
     (`codexTokenRefresh.ts:745-752`). Only `startQuarantineProbe` is 1 s
     (`QUARANTINE_PROBE_INTERVAL_MS = 1_000`, `:783`). The report's sentence
     packs both into one clause reading as if both tick at 1 Hz.
  3. **The 1 Hz probe writes nothing in the healthy steady state.**
     `runQuarantineProbeOnce` filters to `account.status === 'quarantined'`
     before it touches disk (`:817-823`). Proven with a seeded in-memory pool
     against a deliberately nonexistent vault path:
     ```
     $ bun run scratchpad/v11/probe.ts
     pool statuses: [ "healthy" ]
     probe with 0 quarantined accounts -> results: []      # zero disk I/O
     probe with 1 quarantined account THREW (it reached disk):
       ENOENT ... open '/nonexistent/vault/.acct-q.json.<pid>.<ts>.tmp'
     ```
     So the report's "each ticking a 1-second quarantine probe that drives the
     engine's known-unlocked whole-vault read-modify-write" is only true once an
     account is quarantined. Before that it is an in-memory array filter.
  4. **N is capped at 4, not unbounded.** `MAX_LIVE_ENGINES = 4` and
     `PARK_IDLE_TTL_MS = 20 * 60 * 1000` (`app/main/idleParkDriver.ts:41,49`)
     — the host parks the least-recently-used engine beyond the cap and any
     engine idle past the TTL. "N open sessions become N writers" is bounded at
     four sidecars plus the CLI.
  What does **not** rescue it: `persistNextQuarantineProbe`'s `next_probe_at`
  reservation is a real but weak serializer — once one process writes it, others
  `continue` for ≥5 s — yet the reservation is itself written by the unlocked
  RMW, so two processes whose sub-millisecond read→write windows interleave both
  proceed. And the `atomicWriteJson` temp+fsync+rename (`:924-940`) makes the
  *write* atomic but does nothing about the read-modify-write.
- **True consequence**: On a machine with a quarantined Codex account, the
  desktop raises the number of processes performing an unlocked whole-vault RMW
  against that account from one (the CLI) to as many as five. Each collision that
  lands inside another process's `lock`-held refresh window strips
  `refresh.attempt_id`, and the refresh then hits `Lost refresh attempt ownership;
  refusing to write tokens` (`:537`) after the server has already rotated —
  a genuinely dead account. Note the partial mitigation the report missed: the
  ownership-loss branch first checks whether another process wrote newer tokens
  and adopts them (`:527-536`); that recovery only fails in exactly the
  probe-clobber case, because `persistNextQuarantineProbe` rewrites
  `vault.refresh` while leaving `vault.tokens` untouched.
- **Evidence**: `app/sidecar/index.ts:132`; `app/sidecar/initializeRuntime.ts:40`;
  `src/entrypoints/init.ts:86-97`; `src/services/api/codexAccountPool.ts:213-243`;
  `src/services/api/codexTokenRefresh.ts:743-752,783-800,812-870,881-921`;
  `src/bootstrap/state.ts:315,1115-1124`; `src/main.tsx:848`;
  `app/supervisor/supervisor.ts:251-269`; `app/main/idleParkDriver.ts:41,49`;
  scratch scripts `interactive.ts` and `probe.ts` above.
- **Disposition**: Do the fix, but **not** the way the report frames it. Its
  proposal reads as "call `loadPoolForObservation()` instead of the live
  initializers", which if implemented as "skip `init()`" would break the sidecar:
  `init()` also does the legacy-home migration, `enableConfigs()`, safe env
  application, `NODE_EXTRA_CA_CERTS`, graceful-shutdown registration, mTLS and
  proxy agents, and the scratchpad dir (`init.ts:48-203`) — all of which a live
  session needs. The correct change is to give `init()` an
  `{ accountPools: 'observation' | 'live' }` option (default `'live'` so the CLI
  is untouched) and have `initializeSidecarRuntime()` pass `'observation'`, with
  main's accounts worker remaining the single rotation owner per
  `decisions/ACCOUNTS-OWNERSHIP.md`. Independently — and this is the higher-value
  half — fix `persistNextQuarantineProbe` to take `lock(vaultFilePath)` and
  re-read under it. Reducing racers from five to two does not make an unlocked
  RMW correct; the CLI plus one worker still race.

### F2 — [HIGH] Every sidecar spawn can perform a non-atomic Claude-vault credential write, and can resurrect a deleted account

- **Verdict**: PARTIALLY CONFIRMED — (a) OVERSTATED, (b) CONFIRMED but
  mis-attributed to the desktop
- **Cited location holds?**: Yes. `claudeAccountPool.ts:152` is
  `export function initClaudeAccountPool()`, the `migratable` lookup is at
  `:162`, and `:655` is
  `writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')` inside
  `saveClaudeTokenToVault` — a bare truncating write with no temp+rename and no
  lock, exactly as claimed, and unlike its Codex sibling.
- **Reachable in production?**: The write path is reachable, but far more rarely
  than "on **every** sidecar construction". `saveClaudeTokenToVault` fires only
  for `pool.accounts.find(a => !a.vaultFilePath)`. `loadVaultAccounts` stamps
  `vaultFilePath` on every account it returns (`:717`), so the only account that
  can lack one is the single config/keychain account from `loadConfigAccount`
  (`:737`), and only while its UUID is **not already** in the vault
  (`loadClaudePoolForObservation`, `:111-113`). That makes it a one-shot
  per-machine migration, not a per-spawn write.
- **Trigger**:
  - (a) Two sidecars spawning within the same few milliseconds on a machine whose
    Claude account has never been migrated to the vault, while a third process
    reads the accounts dir in that window. Constructible in principle;
    self-healing in practice.
  - (b) Constructed and verified from source: run `/delete-account` on the
    **last** remaining Claude account. `removeClaudeAccount` unlinks the vault
    file only (`:543-560`); `delete-account.ts:205-208` then calls
    `clearOAuthTokenCache()` because `activeIndex < 0`, and that function only
    clears in-memory caches (`src/utils/auth.ts:1344-1347`) — the keychain
    `claudeAiOauth` blob and `config.oauthAccount` both survive. The next engine
    process reads them back via `loadConfigAccount` and re-creates the vault file.
- **Counter-arguments considered**:
  - **The delete path usually cleans up after itself.** If *any* Claude account
    remains, `delete-account.ts:205-206` calls `syncClaudeAccountToStorage()`,
    which overwrites the keychain blob **and** `config.oauthAccount` with the new
    active account (`claudeAccountPool.ts:466-510`). No remnant survives, so no
    resurrection. The resurrection is specific to deleting the last account.
  - **A torn read is not fatal.** `loadVaultAccounts` wraps each file in its own
    `try/catch` and `continue`s past a bad one (`:719,743-748`), so a truncated
    file costs that one account for that one read, and the next read (60 s later
    from the accounts worker, or the next spawn) sees the complete file. Both
    writers also write byte-identical content.
  - **This is not something the desktop introduced.** `initClaudeAccountPool` is
    present on `main` and is called from the same `init()` the CLI runs, so a
    plain `cat-code` launch resurrects the account exactly as a sidecar spawn
    does. The desktop increases the number of process starts; it does not create
    the defect. `loadClaudePoolForObservation` is the only branch-new piece here,
    and it is the *safe* one.
- **True consequence**: (a) In a one-shot migration window, one concurrent reader
  may miss the Anthropic account for a single read cycle. That is a LOW, not a
  HIGH. (b) Deleting your last Anthropic account does not actually delete it: the
  next engine start — CLI or sidecar — writes the credential file back from the
  keychain. That is a real and surprising correctness bug, and it is a `src/` bug.
- **Evidence**: `src/services/api/claudeAccountPool.ts:101-133,152-172,466-510,543-560,624-663,665-726,737-773`;
  `src/commands/delete-account/delete-account.ts:200-210`;
  `src/utils/auth.ts:1344-1347`; `git grep initClaudeAccountPool main -- src/`
  confirms the function predates the branch.
- **Disposition**: Two separate fixes, neither of them the report's single one.
  (1) In `src/`, make `/delete-account` complete: when the deleted account was the
  last one, clear `claudeAiOauth` from secure storage and drop
  `config.oauthAccount`, so nothing is left to migrate back. That closes the real
  bug at its source and fixes the CLI too. (2) In `src/`, convert
  `saveClaudeTokenToVault` to temp+rename to match `codexAccountPool.ts`; cheap
  and correct. The observation-only sidecar bootstrap from F1 is worth doing on
  its own merits but does **not** fix (b) — the CLI still resurrects.

### F3 — [HIGH] MCP server URLs and hook command lines carry credentials to the renderer under keys `secretGuard` cannot see

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, with one off-by-one. `extensionsDomain.ts:121-123`
  is `if ('url' in config …) { entry.url = config.url }` — exact. `:351` is
  `displayLine: getHookDisplayText(config)` — exact.
  `src/utils/hooks/hooksSettings.ts:78,84` are `case 'command': return hook.command`
  and `case 'http': return hook.url` — exact. `secretGuard.ts:28-40` is the
  `SECRET_KEYS` set (it runs to `:41`) and the walk matches **key names only**
  (`if (SECRET_KEYS.has(normalizeKey(key)))`, `:89`) — exact. The contradicted
  `protocol.ts` comment is at **`:2179`**, not `:2178`.
- **Reachable in production?**: Yes, unconditionally and without any user action.
  `loadExtensionsSnapshot` runs at controller construction
  (`app/sidecar/sessionController.ts:325`) for every non-probe session, and
  `sendExtensionsSnapshot` emits it on attach (`sidecarServer.ts:660,2696-2722`).
  The renderer reads `server.url` into the row detail
  (`SettingsExtensions.tsx:143`) and `hook.displayLine` at `:436`. No feature
  gate, no dev-only branch.
- **Trigger**: Proven end-to-end with a runnable repro rather than by reading:
  ```
  $ bun run scratchpad/v11/leak.ts
  MCP entry: {"name":"vendor","transport":"sse","scope":"user",
              "url":"https://mcp.vendor.com/sse?api_key=sk-live-DEADBEEF"}
  Hook entries: [{... "displayLine":"curl -H 'x-api-key: sk-live-DEADBEEF' https://x/y"},
                 {... "displayLine":"https://hooks.slack.com/services/T000/B000/SECRETPATH"}]
  scanForSecrets(frame) = {"ok":true}
  contains sk-live secret in serialized frame? true
  contains slack webhook path?             true
  ```
  The script calls the real exported `buildMcpEntry` / `buildHookEntries` and the
  real `scanForSecrets`, so this is the actual production projection and the
  actual production guard.
- **Counter-arguments considered**: I looked for a redaction step between the
  domain and the wire and there is none — `prepareOutboundPayload` is
  `structuredClone` + `checkJsonSafe` only, and `send` adds `scanForSecrets` +
  the size cap, which the repro shows passing. I also checked whether
  `getClaudeCodeMcpConfigs` strips anything (it does not) and whether the
  extensions frame is gated on the Settings page being open (it is not — it is an
  attach-time frame). The module header (`extensionsDomain.ts:113-117`) claims
  "`secretGuard` on the outbound frame is satisfied by construction", which is
  true and beside the point: the guard cannot see these keys, so satisfying it
  proves nothing about `url`/`displayLine`.
- **True consequence**: A hard SECURITY-MINIMUM §4 invariant ("secrets live
  engine-side only; the renderer never sees raw credentials") is broken by
  construction for two config fields, and `protocol.ts:2179` asserts the opposite
  as fact. Blast radius is bounded — the renderer is the same operator's
  CSP-locked window and does not forward or persist the value — so this is a
  broken invariant and a bad doc comment, not an exploit chain.
- **Evidence**: the repro above; `app/sidecar/extensionsDomain.ts:112-131,340-356`;
  `app/shared/secretGuard.ts:28-41,86-95`; `src/utils/hooks/hooksSettings.ts:67-89`;
  `app/shared/protocol.ts:2170-2181`; `app/sidecar/sidecarServer.ts:660,2696-2722`;
  `app/renderer/src/SettingsExtensions.tsx:140-145,436`.
- **Disposition**: Take the report's fix for `url` (emit
  `origin + pathname` only, dropping `search`, `hash`, `username`, `password`) —
  the panel exists to show which host a server talks to. For `displayLine`, do
  **not** take the report's second option of "strip `key=`/`token=`/`Bearer`-shaped
  substrings": pattern-stripping free-form shell is a losing game and will read as
  a guarantee it cannot make. Truncate to argv[0] for `command` hooks and to
  `origin + pathname` for `http` hooks, matching what the MCP row will do, and
  keep the full line engine-side. Then correct `protocol.ts:2179` to describe what
  is actually guaranteed. One caveat on the report's framing: it calls the
  credential-in-URL form "extremely common" without support; this machine has no
  MCP servers and no hooks configured at all, so the realistic-config half rests
  on well-known third-party shapes (query-string API keys, Slack incoming-webhook
  paths) rather than on anything observed here.

### F4 — [MED] `account.rename` performs an unlocked whole-file rewrite of a vault account file

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, both exactly. `accountsDomain.ts:876` is
  `const result = executor.rename(account.accountId, verb.alias)`;
  `codexAccountPool.ts:796` is `export function setAccountAlias(...)`, whose body
  is `readFileSync` → `JSON.parse` → mutate `alias` → `writeFileSync(tmp)` →
  `renameSync`, with no `lock()` anywhere (`:796-820`). The refresh path's
  `lock(vaultFilePath)` is at `codexTokenRefresh.ts:293` as cited.
- **Reachable in production?**: Yes. `accountsDomain.ts:514` calls
  `setAccountAlias(accountId, alias)` from the real executor, and the verb is a
  first-class inbound frame. It is equally reachable from the CLI's
  `/rename-account` (`src/commands/rename-account/rename-account.ts:120`), which
  predates the branch.
- **Trigger**: Rename an account from the accounts page while another process's
  refresh for that same account is between its `attempt_id` write
  (`codexTokenRefresh.ts:386-395`) and its post-response ownership check
  (`:526-537`). `setAccountAlias` writes back the whole `existing` object it
  parsed, so any `refresh` block written after its `readFileSync` is reverted.
- **Counter-arguments considered**:
  - **Same-process interleaving is impossible.** `setAccountAlias` has no `await`
    — read, parse, stringify, write and rename are one synchronous tick — so the
    sidecar's own async refresh cannot interleave with it. The race is strictly
    cross-process, which is precisely the situation F1 multiplies.
  - **The window is tiny.** It is the duration of a synchronous parse+stringify+
    write+rename of a small JSON file, on the order of a millisecond, versus a
    refresh that spends up to 15 s in `fetch`. Per-rename probability is very low.
    The report already downgraded to MED on exactly this ground, so it is not
    overstating.
  - **The recovery branch does not help here either.** As in F1, the reverted
    write leaves `vault.tokens` untouched, so `:527-536`'s "another process wrote
    newer tokens" adoption does not fire and the refresh throws at `:537`.
  - One thing the report **understates**: the same window can also revert freshly
    written *tokens*, not just the `refresh` block, if the rename's read precedes
    and its rename follows a completed token write.
- **True consequence**: A rare cross-process lost update that, when it lands
  inside a refresh, discards a server-issued rotation and leaves the vault holding
  a burned refresh token — a dead account requiring re-login. Note this is
  pre-existing `src/` behavior; the migration branch contributed the button, not
  the bug.
- **Evidence**: `app/sidecar/accountsDomain.ts:514,876`;
  `src/services/api/codexAccountPool.ts:796-820`;
  `src/services/api/codexTokenRefresh.ts:293,386-395,526-537`;
  `git grep setAccountAlias main -- src/` confirms it predates the branch.
- **Disposition**: The report's fix is correct and I would apply it as written —
  wrap `setAccountAlias`'s read-modify-write in the same `lock(acct.vaultFilePath)`
  the refresh path uses and re-read under the lock. It belongs in `src/`, not in
  the sidecar, and it fixes `/rename-account` at the same time. Do not "fix" this
  in `accountsDomain` by adding a sidecar-side lock; that would leave the CLI path
  broken and duplicate engine machinery (CLAUDE.md §8 rule 10).

### F5 — [MED] A throwing `onProviderActivated` wedges the OAuth state machine permanently

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: Yes, exactly. `accountsDomain.ts:751-753` is
  `if (pendingProviderActivation) { options.onProviderActivated?.(pendingProviderActivation) }`
  sitting **after** the `persist()` try/catch and **before** the
  `pendingProviderActivation = null; pending = null; phase = 'idle'` resets
  (`:754-756`). `sessionController.ts:600-603` wires
  `const result = runControls.activateProvider(provider); if (!result.ok) throw new Error(result.message)`
  — exact. `runControlsDomain.ts:349` is the `providerSwitchLocked && crossing`
  rejection — exact. `sidecarServer.ts:1627` is the idle-park gate — exact.
  Test citations `accountsDomain.test.ts:596` and `:656` are exact.
- **Reachable in production?**: Yes, but through a much narrower door than the
  report describes, and the report's own stated door is closed:
  1. `pendingProviderActivation` is non-null only when `isFirstRunEligible()`
     returns true (`accountsDomain.ts:650`), and the real implementation
     `isSidecarFirstRunEligible` (`:170-186`) requires **zero** Codex accounts,
     **zero** Anthropic pool accounts, **and** `!hasAnthropicCredentials()`. That
     is a genuinely credential-free machine. The report's trigger — "a session
     started with provider-bound history or after `getTotalInputTokens() > 0`" —
     directly contradicts that precondition and cannot coexist with it.
  2. `submitAlias` is only reachable when `login.isExistingAccount === false`.
     The Anthropic runner hard-codes `isExistingAccount: true`
     (`accountsDomain.ts:349`), so every Anthropic sign-in takes the
     `beginLogin` IIFE branch instead — and **that** call site is inside the
     IIFE's `try/catch` (`:687,690-701`), which resets `pending`,
     `pendingProviderActivation`, `resolveManualCode` and `phase` and emits an
     `error` progress. So the Anthropic path is safe; only a **new Codex** account
     reaches the unprotected call.
  3. `providerSwitchLocked` becoming true does not need the report's `:217-220`
     spawn-time computation at all — `sidecarServer.ts:1283` calls
     `this.runControls?.lockProviderSwitches()` at the top of every submit, so
     any prompt sent before signing in sets it.
- **Trigger** (the real one): fresh machine, no credentials of any kind. Type
  anything into the composer and submit — the turn fails for lack of credentials,
  but `lockProviderSwitches()` has already fired. Now sign in with **Codex** while
  the session's model is an Anthropic one, so `crossing` is true. The Codex flow
  completes, `login.persist(alias)` writes the credentials, then
  `activateProvider` returns `ok:false` and `sessionController`'s callback throws.
- **Counter-arguments considered**: I checked whether the throw is swallowed
  upstream — it is not: `sidecarServer.ts:1762-1769` catches it into an
  `internal_error` frame, which is itself notable because the comment three lines
  above (`:1734-1736`) promises that account-verb errors "degrade to an `ok:false`
  result frame (a business failure), **never** a thrown internal error to the
  client". I checked whether anything else resets `phase` — nothing does; every
  other reset is on a path this throw skips. I checked whether
  `activeOAuthRunner` being null saves `isOAuthLoginInFlight()` — it does not, the
  predicate is `activeOAuthRunner !== null || phase !== 'idle'` (`:805-808`), and
  `phase` is stuck at `'persisting'`. I confirmed the claimed test gap: all four
  activation tests (`:596`, `:627`, `:656`, plus the first-run one) use
  non-throwing callbacks and the Anthropic `isExistingAccount: true` runner, so
  none exercises `submitAlias`'s call site.
- **True consequence**: On a first-run Codex sign-in that crosses providers after
  any prompt submit, the credentials are written and the user is signed in, but
  the app reports `internal_error`, never re-broadcasts the accounts snapshot,
  refuses every further `beginLogin` ("Sign-in is already completing") and
  `cancelLogin` ("can no longer be cancelled"), and permanently holds the
  idle-park gate closed, pinning that engine process for the life of the window.
  Real and nasty — just far rarer than the report implies.
- **Evidence**: `app/sidecar/accountsDomain.ts:170-186,349,641-707,735-757,761-782,805-808`;
  `app/sidecar/sessionController.ts:598-604`;
  `app/sidecar/runControlsDomain.ts:217-221,344-355,368-374`;
  `app/sidecar/sidecarServer.ts:1283,1627,1734-1736,1762-1769`;
  `app/sidecar/accountsDomain.test.ts:596-687`.
- **Disposition**: Apply the report's stronger option, not its first one. Change
  `onProviderActivated` to return a result instead of throwing, and have
  `sessionController.ts:600-603` return `runControls.activateProvider(provider)`
  rather than throwing on `!result.ok` — the type then forces the caller to
  handle it and the `sidecarServer.ts:1734-1736` contract is restored by
  construction. A try/catch + `finally` reset (the report's first suggestion)
  works too but leaves a throwing callback shape in place that the next domain
  will copy. Either way, add the missing test: a throwing `onProviderActivated`
  through a **Codex** runner with `isExistingAccount: false`, asserting the verb
  still resolves `ok:true` and `isOAuthLoginInFlight()` returns to false.

### F6 — [MED] A second `account.login` abandons the first Codex flow, stranding machine-global port 1455

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `beginLogin` at `accountsDomain.ts:641-707`
  guards only `phase === 'persisting'` (`:642-647`), then does
  `activeOAuthRunner?.cancel?.()`, `++generation`, `resolveManualCode = null`
  (`:648-652`). `createRealOAuthLoginRunner` (`:254`) returns an object with only
  `begin` — no `cancel`, so the optional call is a no-op. `cancelLogin`
  (`:761-782`) does it correctly, resolving the pending wait with `''` at
  `:774-777`. `codex-client.ts:313-316` documents the fixed port 1455 and `:575`
  is `s.listen(1455, '127.0.0.1', ...)`; `:577-584` is the EADDRINUSE fallback
  resolving a null server.
- **Reachable in production?**: Yes. `account.login` is an ordinary inbound verb
  with no debounce at the sidecar, and I found no disabled-state guard on the
  sign-in control in `AccountsPage.tsx` (the only `disabled` usages are the alias
  dialog's save button). The trust boundary is the sidecar, and it accepts a
  second `account.login` in `waiting_for_login`.
- **Trigger**: Send `account.login` twice while flow 1 is in `waiting_for_login`
  (a double-click). Flow 1's `runCodexOAuthFlow` is parked on
  `await callbackServer.waitForCode()` (`codex-client.ts:626`), a promise with
  **no timeout** that only settles via a valid callback or `cancelWait()` —
  and `cancelWait()` is only reached from `manualPromise.then(...)` (`:621-624`),
  whose resolver was just orphaned. So `runCodexOAuthFlow` never settles, its
  `finally { callbackServer.close() }` (`:657-659`) never runs, and the listening
  socket on 1455 stays bound.
- **Counter-arguments considered**: The strongest one is that the user might
  complete flow 1's browser tab, which would settle `waitForCode`, unwind the
  flow (dropped by generation) and release the port. That is a real escape hatch —
  but a double-click opens two browser tabs and the operator naturally completes
  the most recent, which carries flow 2's `state` and is rejected 400 by flow 1's
  server (`codex-client.ts:359-363`). I also checked whether the OS or a keepalive
  reclaims the socket (no — a live listening handle in a live process) and whether
  `quarantineProbeInFlight`-style reentrancy guards exist for login (only the
  `phase === 'persisting'` one, which does not cover `waiting_for_login`).
- **True consequence**: Automatic Codex sign-in is dead for the life of that
  sidecar process — flow 2 got the null-server fallback, so its `waitForCode()`
  returns `null` immediately and it can only complete by manual paste — and port
  1455 is unavailable machine-wide, including to the CLI's `/login`, until the
  process exits. Matches the report.
- **Evidence**: `app/sidecar/accountsDomain.ts:254-296,641-707,761-782`;
  `src/services/oauth/codex-client.ts:313-316,325-347,359-363,575-584,603-660`;
  `app/renderer/src/AccountsPage.tsx` (no sign-in disabled guard);
  `app/sidecar/accountsDomain.test.ts:930-974` covers only the
  `phase === 'persisting'` rejection, not supersession from `waiting_for_login`.
- **Disposition**: Apply the report's cleanest option — give
  `createRealOAuthLoginRunner` a real `cancel()` that resolves the pending manual
  wait, so both runners satisfy the same contract. Its simpler suggestion, "call
  `cancelLogin()` at the top of `beginLogin`", would be wrong as written:
  `cancelLogin` returns `ok:false` during `'persisting'` and `beginLogin` already
  has its own message for that state, so calling it unconditionally would either
  swallow that rejection or duplicate it. Extract just the unblock step
  (resolve-and-null `resolveManualCode`) into a helper both call.

### F7 — [MED] A settings write in one window silently reverts a setting another window already changed

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, exactly. `settingsDomain.ts:264` is
  `let snapshot = readSettingsSnapshotOnce(availableOptions)`; `:269-275` is
  `runVerb`, refreshing `snapshot` only when `result.changed`. No `subscribe()` is
  exported on the domain and there is no cross-process invalidation.
- **Reachable in production?**: Yes. `sendSettingsSnapshot` is an attach-time
  frame (`sidecarServer.ts:616,2634-2645`) reading `this.settings.getSnapshot()`,
  which returns the frozen value.
- **Trigger**: Verified the missing link the report only asserted — the renderer's
  boolean control sends an **absolute** value computed from its displayed state:
  `onClick={() => onChange(!value)}` (`app/renderer/src/SettingsEditors.tsx:358`),
  wired to `onWrite(next)` at `:278/292/316`. `fastMode` is a real editable key
  (`app/shared/settingsEditable.ts:232`). So: window A turns Fast mode off;
  window B's frozen snapshot still says on; the operator clicks it in B intending
  off; B sends `true`; A's change is gone.
- **Counter-arguments considered**: I checked whether the *write* is racy and it
  is not — `applySettingsVerb` uses the `SettingsUpdater` function form
  (`settingsDomain.ts:345-353`), and the engine invokes it under
  `acquireSettingsLockSync(filePath)` after `deleteCachedParsedFile(filePath)`
  (`src/utils/settings/settings.ts:507,518,557-566`), so the next state is
  genuinely computed from a fresh under-lock read. That confirms the report's own
  characterization: this is a lost update caused by a stale **display**, not by a
  racing write. I also checked whether the accounts worker or any 60 s poller
  refreshes settings across processes — it does not; it only covers accounts.
- **True consequence**: With two or more windows open, a settings toggle in one
  can silently revert a change made in another, with no conflict indication. The
  domain header's justification ("general settings need a restart in the engine
  today") predates the write path, as the report says.
- **Evidence**: `app/sidecar/settingsDomain.ts:253-276,290-357,375-391`;
  `app/renderer/src/SettingsEditors.tsx:278,292,316,358`;
  `app/shared/settingsEditable.ts:232,321-323`;
  `src/utils/settings/settings.ts:500-570`;
  `app/sidecar/sidecarServer.ts:616,2634-2645`.
- **Disposition**: The report's fix (mtime-gated re-read in `getSnapshot()` plus
  broadcast on attach) is right in shape but incomplete: `getSnapshot()` is called
  on the attach path, which the module header says must do no disk I/O and must
  not reset the engine's parse cache. A cheaper correct version: keep the frozen
  snapshot for attach, and have the host broadcast a `settings.snapshot` re-emit
  to *all* sessions after any session's successful `settings.setValue` — the
  emitter (`sidecarServer.ts:2634`) already exists, only the fan-out is missing.
  If a pull model is preferred, gate the re-read on the settings files' mtimes and
  do it off the attach path.

### F8 — [MED] Engine-authored free text rides the accounts snapshot uncapped, while the lease domain caps the identical class

- **Verdict**: OVERSTATED
- **Cited location holds?**: Yes. `buildAccountStatus` puts `statusReason` at
  `accountsDomain.ts:393`, `availabilityLabel` at `:395` and `lastError` at
  `:405`, all uncapped. `leaseDomain.ts:74` is `MAX_REASON_CHARS = 240` and
  `:225-229` is `capReason`. `codexAccountPool.ts:441,617,646` are the three
  `acct.lastError = reason` assignments.
- **Reachable in production?**: The inconsistency is real and present. The
  claimed **consequence** is not reachable.
- **Trigger**: None exists. `MAX_OUTBOUND_FRAME_BYTES` is
  `32 * 1024 * 1024` (`app/shared/limits.ts:26`), so a single free-text field
  would have to carry ~32 MB to drop the frame. I enumerated every writer of the
  three fields:
  - `lastError` has exactly three production assignment sites
    (`codexAccountPool.ts:441,617,646`), and every caller passes a short
    fixed-form string: `Token refresh failed: HTTP NNN`
    (`codexTokenRefresh.ts:487`), a `normalizeCodexAccountBlockReason` output or
    an extracted OAuth error code (`:472-483`), or an `Error.message` from a
    `CodexRefreshTransportError` / `fetch` failure. `bodyText` is never assigned.
  - `availabilityLabel` is `describeCodexAccountAvailability`, whose every return
    is a literal or a short template (`codexAccountPool.ts:1586-1606`).
  - `statusReason` is a short enum-ish token (`'auth_dead'`,
    `'probe_pending_transport'`).
- **Counter-arguments considered**: I looked for a path that could put a raw
  provider response body into any of the three and found none; the report's own
  trace reaches the same conclusion and then asserts the frame-drop consequence
  anyway. I also checked whether `prepareOutboundPayload`/`send` truncate rather
  than drop (they drop), which is what the report describes — but only above 32 MB.
- **True consequence**: Two sibling domains handle the same class of engine text
  differently, and nothing in the sidecar enforces the sanitation the engine
  currently happens to provide. That is defensive drift worth closing, not a
  defect with a trigger. It should be LOW, not MED.
- **Evidence**: `app/sidecar/accountsDomain.ts:383-410`;
  `app/sidecar/leaseDomain.ts:68-74,218-229`;
  `src/services/api/codexAccountPool.ts:435-445,610-660,1586-1606`;
  `src/services/api/codexTokenRefresh.ts:455-497`; `app/shared/limits.ts:26`.
- **Disposition**: Apply the report's fix (a shared `capEngineText()` used by both
  domains) but reclassify it as a LOW consistency item, and do **not** justify it
  in the commit message by the frame-drop story — that story is not true at a
  32 MB cap and will mislead the next reader.

### F9 — [MED] `remoteSettings.directConnect` gives the privileged sidecar an unbounded-host egress channel

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, exactly. `remoteSettingsDomain.ts:205-213` is
  the executor's `directConnect`, and `sidecarServer.ts:3874-3886` is
  `isAllowedRemoteServerUrl` performing precisely the five checks the report
  lists, with the host-policy deferral stated in the comment above it
  (`:3871-3873`). `directConnectInFlight` is declared at `:235` and used at
  `:257-272`.
- **Reachable in production?**: Yes — an ordinary inbound verb with a real
  executor by default (`options.executor ?? createRealRemoteSettingsExecutor()`).
- **Trigger**: A renderer sends `remoteSettings.directConnect` with
  `http://127.0.0.1:<port>` or any RFC1918 address. The sidecar POSTs
  `${serverUrl}/sessions` with a body containing `cwd`
  (`src/server/createDirectConnectSession.ts:49-57`).
- **Counter-arguments considered**:
  - **Does anything else bound the host?** No. I read `isAllowedRemoteServerUrl`
    in full; it deliberately decides shape and not policy.
  - **Does the latch make the socket bound zero?** No, and the report is right
    about why. `withTimeout` (`remoteSettingsDomain.ts:161-175`) is a
    `Promise.race` with **no `AbortSignal`** threaded into `fetch`, so on timeout
    the underlying request is abandoned, not cancelled, while `runVerb`'s
    `finally` releases `directConnectInFlight`. One orphaned socket per 15 s per
    session is the real bound.
  - **Does it leak a credential?** No — the sidecar calls
    `createDirectConnectSession({ serverUrl, cwd })` with no `authToken`, so the
    `authorization: Bearer` header at `:43-45` is not set. Only the filesystem
    path is disclosed.
  - One rider the report missed: `runDirectConnect`'s catch relays
    `error.message` verbatim to the renderer (`:351-361`), and
    `createDirectConnectSession` builds that message as
    `Failed to connect to server at ${serverUrl}: ${errorMessage(err)}`
    (`:60-62`). That turns the verb into a usable connect/refuse oracle for
    internal hosts, which strengthens rather than weakens the finding.
- **True consequence**: The privileged sidecar will make an arbitrary-host POST
  on renderer instruction, disclosing the session `cwd` and acting as a network
  probe from inside the trust boundary — exactly the egress `connect-src 'self'`
  exists to deny for the renderer itself.
- **Evidence**: `app/sidecar/remoteSettingsDomain.ts:161-175,205-213,235,257-272,335-364`;
  `app/sidecar/sidecarServer.ts:3856-3895`;
  `src/server/createDirectConnectSession.ts:26-62`.
- **Disposition**: Both of the report's fixes are correct and I would apply them.
  Add the deferred host policy to `isAllowedRemoteServerUrl` (loopback plus an
  operator-configured allowlist), and thread an `AbortSignal` from `withTimeout`
  into `createDirectConnectSession`'s `fetch`. I would add a third: stop relaying
  the raw connect error to the renderer and emit a generic failure message, since
  the detailed one is the oracle.

### F10 — [MED] A failed accounts / lease / remoteSettings snapshot read is completely silent

- **Verdict**: CONFIRMED
- **Cited location holds?**: All six, exactly. Bare `catch { return null }` at
  `accountsDomain.ts:792-794`, `leaseDomain.ts:131-133`,
  `remoteSettingsDomain.ts:246-248`. Callers `sidecarServer.ts:3104` / `:2902` /
  `:3282` each do `const raw = …getSnapshot(); if (!raw) { return }` with no log.
  The two counter-examples are exactly as described: `settingsDomain.ts:384-391`
  and `workspaceTrustDomain.ts:190-196` both `process.stderr.write` a named,
  domain-specific line.
- **Reachable in production?**: Yes — these are the ordinary attach/broadcast
  paths for three pages.
- **Trigger**: Any throw inside `getPoolStatus()` / `getClaudePoolStatus()` /
  `buildAccountsSnapshot`, `leaseSnapshot`, or the bridge/command-filter
  projection. `buildAccountStatus` alone dereferences a dozen pool fields.
- **Counter-arguments considered**: I checked whether the throw is caught and
  logged one level up — it is not; the callers' own `try` blocks wrap the
  *send*, and the `!raw` early return is above them. I also checked whether the
  accounts worker's separate 60 s path would still populate the page (it emits its
  own snapshot to main, so the Accounts page may still render from the worker) —
  that is a partial mitigation for accounts specifically, but not for lease or
  remoteSettings, and it does not produce a diagnostic either.
- **True consequence**: A page renders permanently empty with zero bytes of
  explanation anywhere, indistinguishable from an empty pool. Exactly as claimed.
- **Evidence**: the six locations above, plus `app/sidecar/settingsDomain.ts:384-391`
  and `app/sidecar/workspaceTrustDomain.ts:186-197`.
- **Disposition**: Apply as proposed — mirror the settings/trust pattern. Keep
  returning `null` (fail-soft display is the right posture per the repo's
  inbound/display asymmetry); only add the stderr line in the domain and one at
  the `!raw` early return in each sender.

### F11 — [MED] `accountsDomain.ts` is two modules: a read seam and a 250-line OAuth state machine

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `wc -l` is 949. The runner seam banner opens at
  `:189` and the Anthropic runner closes at `:372`; the login controller comment
  opens at `:620` and `cancelLogin` closes at `:782`. One trivial correction: the
  test file has **38** `test(` blocks, not 39.
- **Reachable in production?**: N/A — design finding.
- **Trigger**: The cost claim is verifiable and I verified it: both OAuth defects
  in this report (F5, F6) live in that controller, both are missing-reset-on-an-
  exit-path bugs, and neither is covered. I confirmed no test passes a throwing
  `onProviderActivated` (all four activation tests use non-throwing callbacks with
  the Anthropic `isExistingAccount: true` runner), and the only double-login test
  (`:930-974`) exercises the `phase === 'persisting'` rejection, not supersession
  from `waiting_for_login`.
- **Counter-arguments considered**: I considered whether the split is artificial —
  whether the controller genuinely needs the pool reads the file also owns. It
  does not: the controller touches `getPoolStatus()` only through the runners it
  is handed, so `createOAuthLoginController({ runners, onProviderActivated })`
  is a clean seam. I also checked whether the file's self-description
  ("the CANONICAL W4 domain read-seam recipe") is a fair target — it is; the
  header does claim later domains copy this shape, and no other domain carries a
  state machine.
- **True consequence**: Design debt with two confirmed defects attributable to it.
- **Evidence**: `app/sidecar/accountsDomain.ts` (949 lines);
  `app/sidecar/accountsDomain.test.ts:596-687,930-974`.
- **Disposition**: Do the extraction the report proposes, but sequence it
  **after** F5 and F6 are fixed, not as the vehicle for fixing them — moving a
  broken state machine and repairing it in the same change makes the repair
  unreviewable, and this is the file two other findings point at.

### F12 — [LOW] The Anthropic runner re-implements an engine function it already imports from

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, exactly. `accountsDomain.ts:351-360` is
  `persist()` doing `await validateOrg(tokens.accessToken)` → throw on
  `valid === false` → `await installTokens(tokens)`.
  `src/cli/handlers/auth.ts:216-232` is `installOAuthTokensAfterPolicyValidation`
  doing the same with the same `{ validateOrg, installTokens }` injectable shape,
  returning the `OrgValidationResult` instead of throwing. The domain already
  imports `installOAuthTokens` and `parseManualOAuthCallbackInput` from that very
  file (`accountsDomain.ts:68-70`).
- **Reachable in production?**: Yes — this is the real Anthropic runner.
- **Trigger**: N/A — duplication finding; the divergence (return vs throw) is
  already present and observable in the two sources.
- **Counter-arguments considered**: I checked whether the engine helper predates
  the sidecar copy or was extracted from it — neither exists on `main`
  (`git grep installOAuthTokensAfterPolicyValidation main -- src/` is empty), so
  both are branch-new and the duplication was introduced, not inherited. I also
  checked whether the sidecar needs the throw for its own control flow: it does
  not — `submitAlias` already has a `try/catch` around `persist()` (`:736-746`)
  that converts an exception into `{ ok: false, message }`, so returning a result
  and mapping it at the call site is a smaller change than it looks.
- **True consequence**: Two copies of a credential-commit ordering rule, only one
  of which has engine-side tests.
- **Evidence**: `app/sidecar/accountsDomain.ts:68-70,351-360`;
  `src/cli/handlers/auth.ts:216-232`.
- **Disposition**: Apply as proposed.

### F13 — [LOW] The lease snapshot is rebuilt and re-sent on every app-state mutation

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: Mostly. `leaseDomain.ts:135-137` is
  `subscribe(listener) { return appStateStore.subscribe(listener) }` — the raw
  forward, exact. The broadcast wiring is at `sidecarServer.ts:508-514` (the
  report says `:511-514`; `:513` is the `broadcastLeaseSnapshot()` call).
  `runControlsDomain.ts:376-392` is the signature-guarded `subscribe` the report
  points at as the model — the guard itself is at `:379-385`.
- **Reachable in production?**: Yes.
- **Trigger**: `createStore.setState` notifies **every** listener whenever the
  next state is not `Object.is`-identical to the previous
  (`src/state/store.ts:20-28`) — there is no field-level filtering. So any
  `setAppState` fires `broadcastLeaseSnapshot()`, which for each connection runs
  `sendLeaseSnapshot` → full lease + pool-alias rebuild → `prepareOutboundPayload`
  (`structuredClone` + `checkJsonSafe`) → `send` (`scanForSecrets` + size check)
  → socket write.
- **Counter-arguments considered**: The report's stated mechanism is **half
  wrong**. `AppState` has **no top-level `messages` field** — I read the whole
  type (`src/state/AppStateStore.ts:91-484`); it has `tasks`, plus a nested
  `messages` array inside a sub-object, but not a main-loop transcript. So "the
  store holds `messages` and `tasks`" is inaccurate. The trigger survives via the
  other route the report names: `appendMessageToLocalAgent`
  (`src/tasks/LocalAgentTask/LocalAgentTask.tsx:242-247`) goes through
  `updateTaskState`, which writes `tasks[id].state.messages` via `setAppState` and
  therefore does fire the store. I also checked whether `broadcastLeaseSnapshot`
  short-circuits with no connections — it does (`:2925-2927`), which bounds the
  cost to sessions that actually have an attached renderer, i.e. all live ones.
- **True consequence**: Redundant per-frame work and a redundant socket write on
  every subagent message and task-state tick. Performance nit, correctly rated
  LOW; the mechanism reaches it through task state, not a top-level message list.
- **Evidence**: `app/sidecar/leaseDomain.ts:127-139,192-200`;
  `app/sidecar/sidecarServer.ts:508-514,2896-2924`;
  `app/sidecar/runControlsDomain.ts:376-392`; `src/state/store.ts:20-28`;
  `src/state/AppStateStore.ts:91-484`;
  `src/tasks/LocalAgentTask/LocalAgentTask.tsx:242-247`.
- **Disposition**: Apply the report's fix (a cheap projected-snapshot signature,
  mirroring `runControlSignature`). Its parenthetical is worth acting on too —
  `tasksDomain` and `agentModeDomain` share the raw-subscribe shape — but do it as
  one shared `subscribeOnChange(store, project)` helper rather than three copies
  of a bespoke signature function.

### F14 — [LOW] Four unchecked `as` casts narrow user-editable config into closed wire unions

- **Verdict**: CONFIRMED
- **Cited location holds?**: All four exactly. `extensionsDomain.ts:118`
  (`(config.type ?? 'stdio') as McpConfigTransport`), `:119`
  (`config.scope as McpConfigScope`), `:165` (`command.source as SkillConfigSource`),
  `:348` (`config.type as HookConfigType`). The three tripwire examples cited as
  the repo's own idiom all exist: `accountsDomain.ts:931`,
  `remoteSettingsDomain.ts:276`, `app/shared/settingsEditable.ts:393` (the report
  omits the `app/shared/` prefix on the third).
- **Reachable in production?**: Yes — this is projector-style code producing an
  outbound frame, exactly where the repo convention says zero `as`.
- **Trigger**: As the report states, the failure is a future one: the engine adds
  a transport/scope/source literal, nothing fails to compile, and the sidecar
  emits an out-of-union value the renderer has no case for.
- **Counter-arguments considered**: I checked whether the values are actually
  sound today — they are, `McpServerConfigSchema` constrains `type` to the same
  literals the wire union lists, which is why this is LOW and not a live defect.
  I also checked whether the renderer degrades gracefully on an unknown transport
  (it renders `{server.transport}` into a `MonoChip`, so a stray value would
  display rather than throw) — so the true failure mode is a wrong-looking chip
  and unhandled downstream branching, not a crash.
- **True consequence**: No current defect; a silent-drift hazard with no
  compile-time tripwire, in a file whose siblings all have one.
- **Evidence**: `app/sidecar/extensionsDomain.ts:112-131,163-166,346-352`;
  `app/sidecar/accountsDomain.ts:929-933`;
  `app/sidecar/remoteSettingsDomain.ts:274-278`;
  `app/shared/settingsEditable.ts:390-396`.
- **Disposition**: Apply as proposed. Prefer the "drop the entry" fallback over
  "unknown transport → `'stdio'`" for MCP: silently relabelling a remote server as
  stdio would be a worse lie than omitting it.

### F15 — [LOW] `buildBridgeStatusSnapshot` is filed under "Pure projection" but reads an engine global

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. The banner is at `remoteSettingsDomain.ts:98-100`
  and `buildBridgeStatusSnapshot` at `:135-144`, with
  `transport: isEnvLessBridgeEnabled() ? 'v2' : 'v1'` at `:143`. Its sibling
  `buildCommandFilterSnapshot` is genuinely pure.
- **Reachable in production?**: Yes, via `getSnapshot()` at `:240-245`.
- **Trigger**: Any test that drives `buildBridgeStatusSnapshot` with a fixture
  silently depends on the test process's ambient env for `transport`.
- **Counter-arguments considered**: A partial defence the report did not note —
  the banner's subtitle is "Pure projection **— the command-filter bucketing**,
  unit-tested", which arguably scopes the purity claim to the sibling function
  rather than to everything under the banner. That weakens "filed under" but not
  the underlying point: the parameter list still misrepresents the function's
  inputs.
- **True consequence**: A misleading section header and an untestable
  environmental dependency. Cosmetic.
- **Evidence**: `app/sidecar/remoteSettingsDomain.ts:96-102,133-146,240-245`.
- **Disposition**: Apply as proposed (take `isEnvLess: boolean` as a second
  parameter, resolve at the single `getSnapshot()` call site). Also tighten the
  banner text while there.

### F16 — [LOW] `createSidecarExtensionsDomain` is a pass-through with no behavior

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, exactly. `extensionsDomain.ts:63-71` is
  `createSidecarExtensionsDomain(snapshot) { return { getSnapshot: () => snapshot } }`,
  and `sessionController.ts:325` calls `loadExtensionsSnapshot(...)` itself, then
  hands the result back at `:604`.
- **Reachable in production?**: Yes.
- **Trigger**: N/A — design finding.
- **Counter-arguments considered**: I checked whether the wrapper buys anything
  the raw value would not — a stable interface the server can null-check, and
  symmetry with the other six `createSidecar<X>Domain` factories. The server does
  null-check (`sidecarServer.ts:2703`), but it would null-check
  `ExtensionsSnapshot | null` identically, so the wrapper buys only the naming
  symmetry. It is genuinely the only one of the seven with no state, no
  call-time engine read and no verb.
- **True consequence**: A reader hop and a convention that looks like ceremony.
- **Evidence**: `app/sidecar/extensionsDomain.ts:57-71,340-356`;
  `app/sidecar/sessionController.ts:325-329,604`;
  `app/sidecar/sidecarServer.ts:2696-2722`.
- **Disposition**: Prefer the report's **second** option (move the
  `loadExtensionsSnapshot` call inside an async
  `createSidecarExtensionsDomain(cwd, commands, appState)`, as
  `createSidecarWorkspaceTrustDomain` does) over the first (drop the wrapper).
  Dropping it would make `extensions` the one domain the server stores as a raw
  value, trading one inconsistency for another.

## Verification of the report's clean bill ("What is good here")

I was asked to falsify the trust and settings-lock claims specifically. Both hold.

- **Workspace trust — CONFIRMED, with one wrong line citation.** `workspace.trust`
  really does carry no path: the strict-key allowlist entry is
  `['workspace.trust', new Set(['type', 'requestId'])]` at
  `sidecarServer.ts:3516` (exact), and the schema really is a two-field literal —
  but at **`sidecarServer.ts:3733-3736`**, not `:3937-3940`. That cited range is
  the `settings.setValue` zod object; the report mis-cited it.
  `createRealWorkspaceTrustExecutor(cwd)` closes over the sidecar's own spawn cwd
  (`workspaceTrustDomain.ts:80-101`), the read fails **closed** with a
  `trusted = false` default plus an stderr line (`:182-197`), the three sub-reads
  are independent, and the submit gate really is
  `this.workspaceTrust.getSnapshot()?.trusted !== true` (`sidecarServer.ts:1407`)
  — the `!== true` distinction the report highlights is genuinely what makes a
  null snapshot deny. `getTrustRoot()` really does return
  `getProjectPathForConfig()` (`workspaceTrustDomain.ts:100`), the same function
  that keys the write. Nothing here is renderer-grantable. Clean bill upheld.
- **Settings write — CONFIRMED exactly.** `updateSettingsForSource` acquires
  `acquireSettingsLockSync(filePath)` (`src/utils/settings/settings.ts:507`),
  then calls `deleteCachedParsedFile(filePath)` **inside** the lock
  (`:518`) with a comment explaining that `parseFileCache` has no mtime check so
  the lock alone is insufficient, then computes the next state from the
  under-lock fresh read when the updater form is used (`:557-566`). The sidecar
  does use the updater form (`settingsDomain.ts:345-353`). Both cited ranges are
  exact and the reasoning is correct.
- Spot-checked and also correct: `parseAccountsPoolWorkerResult`'s two-arm
  `hasExactKeys` handling of the optional field
  (`app/shared/accountsPoolWorker.ts:104-111`); `resolveAccountForWrite`'s
  pay-only-on-a-miss re-read (`accountsDomain.ts:607-618`) and its
  runs-exactly-once test (`accountsDomain.test.ts:365`); the accounts worker's
  header (`accountsPoolWorker.ts:1-60`) documenting the observation-only posture
  that F1 and F2 contrast against; and `liveWorkerOwnerIds` filtering on task
  **type**, not status (`leaseDomain.ts:194-200`), which is what the report's
  "Not reviewed" note says.

## Findings the original report missed

Only two, both verified to the same bar:

1. **The sidecar's own error contract already forbids what F5's wiring does.**
   `sidecarServer.ts:1734-1736` states, immediately above the accounts-verb
   dispatch: "the domain owns the pool-resolved business rules + dispatch. Errors
   there degrade to an `ok:false` result frame (a business failure), **never** a
   thrown internal error to the client." `sessionController.ts:600-603` wires a
   callback whose entire purpose is to throw into that domain. The invariant is
   not merely violated at runtime under a rare trigger — it is violated by
   construction, and the file that declares it is the file that catches the throw
   into `internal_error` at `:1762-1769`. This makes F5 a contract break rather
   than only a state-machine bug, and it is the argument for the return-a-result
   fix over a try/catch.

2. **Each sidecar spawn fires its own outbound usage poll with no cross-process
   dedupe.** `initAccountPool` ends with a fire-and-forget
   `fetchPoolUsage({ updateRoutingHints: true })` whenever
   `pool.accounts.length > 0` (`codexAccountPool.ts:229-233`).
   `codexUsage.ts`'s one-minute memo is module-level, so it is cold in every
   fresh process. With the cap of four live engines, opening four windows makes
   four independent usage polls on top of the accounts worker's own 60 s poll —
   same class as F1 (the sidecar inheriting the CLI's live bootstrap), same fix,
   but it is a network-side effect rather than a vault write and the report did
   not list it among `initAccountPool`'s side effects.
