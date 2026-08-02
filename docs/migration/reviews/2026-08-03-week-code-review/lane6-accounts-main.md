# Lane 6: Accounts pool worker and Electron main

## Scope reviewed

Committed range `2f4278d..7c6959f` for `app/main/**`, `app/shared/accountsPoolWorker.ts`,
`app/sidecar/accountsPoolWorker.ts`, `app/sidecar/accountsDomain.ts`, `app/preload/**`,
`app/scripts/prepare-dev-electron.ts`, `app/eslint.config.js`, `app/package.json`.
The week moved the account pool off the per-session plane: Electron main now re-spawns a
disposable engine-graph worker every 60 s (`accountsPoolRunner.ts` → `sidecar/accountsPoolWorker.ts`),
validates one bounded NDJSON record fail-closed at a new private boundary
(`shared/accountsPoolWorker.ts`), and delivers the redacted snapshot to the renderer as a
read-only outbound `accounts-pool` host event. Alongside that: `accountsDomain.ts` grew an
Anthropic pool projection + Anthropic OAuth runner + a pool re-read before account-targeting
writes; three Electron-free decisions were extracted from `main.ts` into `mainDecisions.ts`;
`prepare-dev-electron.ts` was added to rebrand the dev Electron bundle; and `app/` gained a
real eslint config wired into dev/typecheck/renderer-build.

**The two `accountsPoolWorker.ts` files are not duplication.** `app/shared/` is the boundary
contract (version constant, size cap, fail-closed `parseAccountsPoolWorkerResult` /
`parseAccountsSnapshot`), imported by both main's runner and the worker. `app/sidecar/` is the
worker entry point (the process that actually reads the pool). Same split as the
`sessionsCatalogWorker` sibling. Intentional.

## Findings

### [HIGH] `accountsPoolWorker.probe.test.ts` reads the operator's real Codex vault and makes authenticated calls to chatgpt.com on every `bun test app/` — CONFIRMED

**Location:** `app/sidecar/accountsPoolWorker.probe.test.ts:45-76` (isolation claim at :14-19);
worker path `app/sidecar/accountsPoolWorker.ts:71-86`; engine `src/services/api/codexAccountPool.ts:913-926`

**Defect:** The probe's isolation is `CLAUDE_CONFIG_DIR=<tempdir>`, but the Codex vault path is
derived from `homedir()`, not from `CLAUDE_CONFIG_DIR`, so the spawned worker loads the real
vault accounts (with real access tokens) and then runs `fetchPoolUsage`, which issues one
authenticated HTTPS GET per account.

**Failure scenario:** Run the documented desktop battery `bun test app/` on this machine.
`runWorker()` spawns `bun run app/sidecar/accountsPoolWorker.ts --bare`. The worker calls
`loadPoolForObservation()` → `readVaultPath()`, which returns `~/.codex-nootp/config.toml`'s
`vault_path = "/Users/pt/codex-vault"` (verified present: 5 account files). Those 5 real
`accessToken`s land in the child's pool. The worker then unconditionally runs
`await fetchPoolUsage({ updateRoutingHints: true })`
(`app/sidecar/accountsPoolWorker.ts:80`), whose module-level cache is empty in a fresh
process, so it fires 5 × `GET https://chatgpt.com/backend-api/wham/usage` with
`Authorization: Bearer <real token>` (`src/services/api/codexUsage.ts:265, 273-293, 217-226`).
The test asserts nothing about any of this and passes either way.

**Evidence:**
- `codexAccountPool.ts:91` `const DEFAULT_VAULT_PATH = join(homedir(), 'codex-vault')` and
  `:92` `CODEX_NOOTP_CONFIG = join(homedir(), '.codex-nootp', 'config.toml')`. `readVaultPath()`
  (`:913-926`) consults only those two; there is no env override, and the probe passes
  `...process.env` so `HOME` is the operator's own.
- The probe's own header says: "ISOLATION — nothing here reads the operator's real
  credentials." That is true only for the *Anthropic* config profile (temp config dir makes
  `loadConfigAccount()` return null); it is false for the Codex vault, which is where the
  tokens actually are.
- The commit that added it (`26c8875`) is titled "test(app): prove the disposable workers do
  not touch live accounts."

Harm is bounded to reads (the usage endpoint is a GET; no rotation, no vault write, no
completion spend), so this is not corruption. It is ranked HIGH because it is a documented-
prohibited action (CLAUDE.md §10: "any action on live accounts/credentials … burning usage")
executed by the standard battery, and because the false isolation claim is the part that
propagates: the next session extending this probe will trust it.

---

### [HIGH] The accounts worker calls the write-capable `initClaudeAccountPool()`, so a 60 s background poller can re-create a deleted Anthropic credential file — CONFIRMED

**Location:** `app/sidecar/accountsPoolWorker.ts:76`; engine `src/services/api/claudeAccountPool.ts:74-99`
(write at `:86-89`, `saveClaudeTokenToVault` at `:567-606`)

**Defect:** The worker deliberately takes the observation-only entry point for the Codex pool
(`loadPoolForObservation()`, and its doc-comment at `:14-25` explains at length why full
`init()` is unacceptable on a 60 s timer), but for the Anthropic pool it calls the full
`initClaudeAccountPool()`, which is *not* observation-only: it writes an account's access and
refresh tokens to the vault whenever the config/keychain mirror holds an account the vault
lacks. The worker's own contract line (`:74` "Both pool loads are disk-only (vault + config).
Neither refreshes a token") states the weaker guarantee and reads as read-only.

**Failure scenario:** Operator has one Anthropic account. In the terminal they run
`/delete-account <alias> --confirm`. `removeClaudeAccount()` unlinks
`~/claude-vault/accounts/<uuid>.json` and writes `activeClaudeAccountUuid: undefined`, but
leaves the keychain `claudeAiOauth` blob and `config.oauthAccount` intact; because no accounts
remain, `delete-account.ts:205-209` takes the `clearOAuthTokenCache()` branch, which is
memory-only (`src/utils/auth.ts:1344-1347`). Within 60 s the desktop app's accounts worker
runs: `initClaudeAccountPool()` → `loadConfigAccount()` reconstructs the deleted account from
keychain + config (`claudeAccountPool.ts:671-707`), `byUuid` does not contain it, so
`saveClaudeTokenToVault(configAccount)` re-writes the credential file to disk
(`:86-89`). The account the operator deleted is back on disk and back on the Accounts page,
with no user action, while the app is idle.

**Evidence:** `claudeAccountPool.ts:86-89`
```
if (configAccount && !byUuid.has(configAccount.accountUuid)) {
  saveClaudeTokenToVault(configAccount)
```
`saveClaudeTokenToVault` (`:567-606`) is a bare `writeFileSync` of `access_token` +
`refresh_token`, with no lock and no atomic tmp+rename.

The incomplete delete is a pre-existing engine gap (any `cat-code` start resurrects it too).
What is new is that the desktop app converts "resurrects at next engine start" into
"resurrects unattended within 60 s, from a process whose stated job is to observe". The fix
belongs on the app side: the Anthropic half needs the same observation-only discipline the
Codex half already got, or an explicit statement that the worker performs vault writes.

---

### [MEDIUM] A window closed within 250 ms of first paint arms the pool driver with no window, and it then polls live accounts forever — CONFIRMED

**Location:** `app/main/main.ts:778-783` (arm), `:1723-1735` (`window-all-closed` teardown),
`:1751-1754` (macOS does not quit)

**Defect:** `startAccountsPoolRefresh` is armed by a `setTimeout(…, 250)` scheduled on
`ready-to-show`. That timeout handle is never stored and never cleared. `window-all-closed`
stops and nulls `accountsPoolDriver` / `accountsPoolAbort`, but if the timer has not fired yet
both are still null, so teardown is a no-op and the timer arms the driver *after* teardown.

**Failure scenario:** macOS. App launches, window paints, the 250 ms arm timer starts.
The operator closes the window inside that window (Cmd-W on a warm start).
`window-all-closed` runs: `accountsPoolDriver?.stop()` is a no-op on null,
`accountsPoolAbort?.abort()` is a no-op on null, host/supervisor are torn down, and because
`process.platform === 'darwin'` the app does **not** quit (`main.ts:1752`). 250 ms later the
orphaned timer fires, `startAccountsPoolRefresh()` sees `accountsPoolDriver === null`, passes
its guard, and arms the driver. From then on, with zero windows open, the app spawns a full
engine-graph worker every 60 s; each run loads the Codex vault and issues one authenticated
usage GET per account, and `sendHostEvent` delivers to nothing
(`main.ts:872-875` no-ops without a window). The loop only stops at the next
`window-all-closed`/`before-quit`.

**Evidence:** `main.ts:778-783` schedules three arms (`startSessionsCatalogRefresh`,
`startAccountsPoolRefresh`, idle-park) with unretained `setTimeout` handles; the only
`clearTimeout` calls in the file are `:213` and `:218`, both for replay flush timers. The
teardown at `:1730-1735` is guarded on the driver/controller being non-null.

The catalog driver and idle-park share the identical race (pre-existing pattern), but the
accounts driver is the one that reaches live account credentials and the network with no UI.

---

### [LOW] The runner's stated justification for the 60 s cadence is false: the usage cache never hits in a fresh worker process

**Location:** `app/main/accountsPoolRunner.ts:33-37`; `app/sidecar/accountsPoolWorker.ts:27-31`

**Defect:** Both comments justify the polling design with "the worker's one network read
(`fetchPoolUsage`) is engine-side cached for 1 minute — polling faster would spend a full
engine boot to re-read a cached value." The cache is a module-level `let cachedSnapshot`
(`src/services/api/codexUsage.ts:93`) inside a process that the design deliberately makes
disposable, so every run starts cold and every run performs the full live fan-out.

**Failure scenario:** A future session shortens `ACCOUNTS_POOL_REFRESH_INTERVAL_MS` to 15 s on
the stated basis that the cache absorbs it, and instead quadruples authenticated traffic to
`chatgpt.com/backend-api/wham/usage` for every account in the vault. The comment is the only
thing standing between the current cadence and that change.

**Evidence:** `codexUsage.ts:265` `if (!forceRefresh && cachedSnapshot && …)` — `cachedSnapshot`
is process-local module state, never persisted. Also documented in CLAUDE.md §12
("Caps don't persist across `-p` invocations: the capped state is in-memory pool state").

---

### [LOW] `buildAccountsSnapshot` is labelled a pure projection but has three impure defaults, two of which read live credentials

**Location:** `app/sidecar/accountsDomain.ts:441-450` (under the section header
"Pure projection (redaction) — the security-critical core, unit-tested")

**Defect:** The new parameters default to `getClaudePoolStatus()`, `hasAnthropicCredentials()`
and `resolveAnthropicSubscriptionActive()` (→ `isClaudeAISubscriber()`). Any caller that omits
them reads process-global pool state and the machine's real credential store.

**Failure scenario:** `app/sidecar/accountsDomain.test.ts:91` and `:161` call
`buildAccountsSnapshot({accounts:[…], activeIndex, initialized})` with one argument. During
`bun test app/` those two tests read the operator's real Anthropic credential state, and the
`anthropicAccounts` array they build is whatever the process-global Claude pool happens to
hold at that point in the file (it is seeded by an unrelated earlier test at `:133-136`). The
tests do not assert on those fields today, so they pass; the first assertion added over
`anthropicRouteAvailable` in a one-argument call becomes machine-dependent and green only on
a signed-in host.

**Evidence:** `accountsDomain.ts:444-449`
```
  anthropicPoolStatus = getClaudePoolStatus(),
  anthropicRouteAvailable = hasAnthropicCredentials(),
  anthropicSubscriptionActive = resolveAnthropicSubscriptionActive(),
```

---

### [LOW] `persist()` re-implements the engine's existing `installOAuthTokensAfterPolicyValidation` with a divergent error contract

**Location:** `app/sidecar/accountsDomain.ts` `createRealAnthropicOAuthLoginRunner` →
`persist()`; engine original `src/cli/handlers/auth.ts:216-232`

**Defect:** The app-side `persist()` does `validateOrg(tokens.accessToken)` then
`installTokens(tokens)` in that order, taking the same two injectables — which is exactly
`installOAuthTokensAfterPolicyValidation`, already exported from the engine. CLAUDE.md §8 #10
says to reuse the engine's real entry point. The copy also changes the contract: the engine
helper *returns* the `OrgValidationResult`, the copy *throws* `new Error(orgResult.message)`.

**Failure scenario:** No wrong output today (the ordering and gate are correct). The cost is
drift: an engine-side change to the pre-commit gate (a third check, a different failure
classification) lands in the CLI and is silently missed by the desktop path.

## Coverage gaps

- **The abort path ships untested.** `accountsPoolAbort` is the entire reason main can reach a
  worker already in flight at teardown (`main.ts:257-263` documents that nothing else can reap
  these children — the launch sweep and `scripts/reap-orphan-sidecars.ts` both match the
  sidecar entry marker, which this worker does not carry). `accountsPoolRunner.test.ts` has no
  test that passes a `signal`, aborts it, and asserts the child was killed and the run rejected.
  Same for `timeoutMs` and for an oversize record exceeding
  `MAX_ACCOUNTS_POOL_WORKER_RECORD_BYTES`; all three rejection branches
  (`aborted`, `timedOut`, size limit) are dead in the suite.
- **The runner's failure/concurrency coverage is otherwise good** (single-flight, cadence
  anchored to run start, rejection swallowed + rescheduled, `stop()` blocking further runs,
  spawn failure, multi-record, non-JSON, schema-invalid, token-bearing record) — the gap is
  specifically the three timer/signal-driven branches.
- **`initClaudeAccountPool()`'s write side is unexercised** in worker tests. The probe uses a
  temp config dir, which is exactly the configuration in which the vault-migration write cannot
  fire, so the HIGH above is invisible to the suite by construction.
- **Two guards lost with `mainSource.test.ts`** and not re-homed:
  `takes the OS single-instance lock BEFORE constructing the host (REGISTRY §5)` and
  `F6: validateCwd NFC-normalizes the realpath`. The ordering is still correct at
  `main.ts:1676-1697`, but nothing now fails if a future edit hoists `ensureHost()` above
  `requestSingleInstanceLock()`, which would let a losing second instance run the registry
  launch sweep against the winner's live rows. (The other dropped grep-tests are genuinely
  superseded: `mainDecisions.test.ts` now tests the supervisor→frame bridge and the HC1 token
  store behaviourally, and `hardening-smoke.ts:350-359` covers the debug-state packaged gate at
  runtime, which is stronger than the grep it replaced.)

## Clean

- **Codex cross-process safety holds.** The worker never touches `src/codex-core/accounts.ts`'s
  refresh/lock machinery and never rotates a token. `loadPoolForObservation()`
  (`codexAccountPool.ts:183-207`) is disk-read-only, and `loadVaultAccounts` honours the
  advisory lock, skipping any account another process has locked (`:974-979`).
  `updateAccountUsageHints` (`:1250-1310`) mutates only in-memory pool fields, and the worker
  process dies immediately after, so nothing it computes can reach the vault. No direct vault
  read-modify-write from the app side on the Codex path.
- **No new inbound surface.** `app/preload/**` is unchanged in this range. `accounts-pool` is
  outbound-only over the existing `CH_HOST_EVENT` channel (`hostApi.ts:179`); the renderer
  consumes it read-only (`App.tsx:836`, `accountsState.ts`). The one protocol widening
  (`provider?: 'anthropic' | 'openai'` on `account.switch` / `account.login`) is validated at
  the sidecar with both an exact-key allowlist and a zod enum
  (`sidecarServer.ts` allowlist entries + `z.enum(['anthropic','openai']).optional()`).
- **Redaction is proven twice and the payload is redacted by construction.**
  `buildAccountsSnapshot` is a whitelist projection with no token/vault-path fields;
  `scanForSecrets` runs in the worker before emit and again at main's parse boundary;
  `parseAccountsPoolWorkerResult` / `parseAccountsSnapshot` narrow field-by-field with exact-key
  checks and zero `as` casts on child output, failing the whole record on one malformed row.
- **`prepare-dev-electron.ts` honours the `app.isPackaged` constraint.** It copies the bundle,
  rewrites only `CFBundleName` + `CFBundleDisplayName`, leaves `CFBundleExecutable` and the
  on-disk executable named `Electron`, and re-signs ad-hoc.
  `prepare-dev-electron.test.ts:28-38` asserts the basename is `electron`, that
  `REBRANDED_PLIST_KEYS` excludes `CFBundleExecutable`, and that the loop iterates that list.
  `IS_DEV = !app.isPackaged` is unchanged, and the new packaged-branch warning
  (`main.ts:793-801`) reports the contradiction without letting an env var talk a real packaged
  build onto a remote origin.
- **`mainDecisions.ts` extraction is faithful.** `supervisorEventToServerFrame` and
  `isTerminalLifecycleFrame` moved byte-identical. The cwd token store preserves every
  semantic of the old `mintCwdToken`/`consumeCwdToken`, including delete-before-expiry-check so
  an expired token is also spent, the 5-minute TTL, and single-use; the only change is
  injectable `now`/`newToken`/`ttlMs` defaults. `selectTranscriptBackfillCandidates` is a
  deliberate behaviour change (documented in `main.ts:366-372`), not a silent extraction drift,
  and it replaces two `!` non-null assertions with a `flatMap` narrowing.
- **Driver lifecycle is otherwise sound.** Single-flight prevents a second worker while one is
  in flight; `schedule()` and `tick()` both bail on `stopped`, so a `stop()` during a run
  cannot resurrect the timer; the timer is `unref`'d; a rejected run is logged and swallowed
  rather than killing the cadence; `waitForClose` uses `close` (not `exit`) so the final record
  cannot race completion validation; both `window-all-closed` and `before-quit` stop and abort
  idempotently.
- **User-visible text rules hold.** `rg -n '—'` over the five new/changed lane files returns
  only code-comment hits; the new stderr warning in `main.ts` and every new operator string in
  `accountsDomain.ts` are em-dash-free and carry no `file.ts:line` citations, session ids, or
  internal vocabulary. The only `as` cast in the new code is
  `as ChildProcessWithoutNullStreams` on the spawn handle, matching
  `sessionsCatalogRunner.ts:82` and `transcriptBackfill.ts:150`.

## Uncertainty

- I did not run `bun test app/`, so the HIGH #1 network behaviour is established by code trace
  plus confirmation that `~/.codex-nootp/config.toml` points at `/Users/pt/codex-vault` and that
  directory holds 5 account files. Running the probe is what would demonstrate it, and doing so
  is the very thing the finding says should not happen unattended.
- HIGH #2's resurrection is traced end to end through source, but I did not exercise
  `/delete-account`. Reproducing it means deleting a real Anthropic account.
- MEDIUM #3's 250 ms race is narrow. The code path is certain; how often an operator actually
  closes the window inside 250 ms of first paint is not.
