# A11 — sidecar accounts, leases, settings, extensions, trust

## Verdict

The seven domain modules themselves are disciplined: they route every mutation
through a real engine entry point rather than re-implementing one, the redaction
projections are explicit field whitelists, the settings write path is genuinely
lock-safe, and workspace trust cannot be granted for a renderer-supplied path.
The damage is not in the domain code — it is in what the desktop's process model
does *around* it. Every sidecar spawn boots the engine's full live account
machinery (`init()` → `initAccountPool()` + `initClaudeAccountPool()`), so N open
sessions become N concurrent credential-rotation writers, each ticking a 1-second
quarantine probe that drives the engine's known-unlocked whole-vault
read-modify-write, and each performing a non-atomic Claude-vault write at spawn.
**The single most important fix: sidecars must boot the account pools
observation-only (the accounts worker already does exactly this and documents
why) and leave rotation to one owner.** Second: two config strings that routinely
carry API keys — an MCP server `url` and a hook's `displayLine` — cross to the
renderer under innocuous key names that `secretGuard` cannot see, against an
explicit "no secrets" claim in `protocol.ts`.

## Findings

### [HIGH] Every sidecar spawn starts the engine's live credential-rotation machinery, so N sessions become N writers on one vault

- **Where**: `app/sidecar/index.ts:132` → `app/sidecar/initializeRuntime.ts:40` → `src/entrypoints/init.ts:89,95`
- **Type**: correctness / security
- **What**: `initializeSidecarRuntime()` runs the full CLI `init()`, which fires
  `void initAccountPool()` (starting `startPeriodicRefresh()`, `startQuarantineProbe()`
  on a **1-second** interval — `src/services/api/codexTokenRefresh.ts:782,788` —
  and a startup `touchAll()`) plus a synchronous `initClaudeAccountPool()`. One
  engine process per session is a locked decision, so this is one full rotation
  driver per open desktop window, on top of the CLI.
- **Trigger / why it matters**: `runQuarantineProbeOnce`
  (`codexTokenRefresh.ts:838`) calls `persistNextQuarantineProbe` — the unlocked
  whole-vault read-modify-write the engine-side review already flagged HIGH
  (`codexTokenRefresh.ts:881`) — before every probe. Its only serializer is an
  **unlocked** read of `next_probe_at` (`:830-835`). With one CLI process that
  race is a once-per-backoff lottery; with three desktop sessions open it is
  three independent 1 Hz timers reading and writing the same file with no mutual
  exclusion, while `refreshAccountTokensStateful` holds `lock(vaultFilePath)`
  (`:293`) and expects its `refresh.attempt_id` to survive. When a probe write
  lands inside that window the refresh hits "Lost refresh attempt ownership;
  refusing to write tokens" (`:537`) after the server has already rotated and
  burned the old refresh token — a permanently dead account. The desktop does not
  introduce the defect; it multiplies its hit rate by the session count.
- **Fix**: the accounts worker already solved this and says so in its own header
  (`app/sidecar/accountsPoolWorker.ts:16-24`): call `loadPoolForObservation()`
  (`src/services/api/codexAccountPool.ts:183`, disk-only, no refresh/probe/usage)
  and `loadClaudePoolForObservation()` (`claudeAccountPool.ts:101`) instead of the
  live initializers. The request path still refreshes lazily under lock via
  `maybeRefreshAccount`; nothing needs the periodic timers in a session process.
  If a background rotation owner is wanted, elect exactly one (main's accounts
  worker is already the designated owner per `decisions/ACCOUNTS-OWNERSHIP.md`).

### [HIGH] Every sidecar spawn can perform a non-atomic Claude-vault credential write, and can resurrect a deleted account

- **Where**: `app/sidecar/initializeRuntime.ts:40` → `src/entrypoints/init.ts:95` → `src/services/api/claudeAccountPool.ts:161` → `:655`
- **Type**: correctness / security
- **What**: `initClaudeAccountPool()` finds any pool account lacking a
  `vaultFilePath` (i.e. one that came from keychain/config) and writes it to the
  vault with a bare `writeFileSync(filePath, …)` — no temp+rename, no lock
  (`claudeAccountPool.ts:655`). This runs on **every** sidecar construction.
- **Trigger / why it matters**: two effects, both real.
  (a) Open two desktop sessions at once on a machine in the config-only state and
  two processes `writeFileSync` the same credential file concurrently; a third
  reader (`loadVaultAccounts`) can observe a truncated JSON file, which parses as
  a missing/dead account. (b) `/delete-account` removes the vault file but leaves
  the keychain blob and `config.oauthAccount` intact, so the next session spawn
  re-creates the deleted account's vault file. The accounts worker documents this
  exact hazard as its reason for avoiding `initClaudeAccountPool`
  (`app/sidecar/accountsPoolWorker.ts:27-45`) — the unattended 60 s worker was
  made safe while the per-session path, which runs far more often and
  concurrently, was not.
- **Fix**: same as above — `loadClaudePoolForObservation()` in the sidecar. The
  one-time config→vault migration belongs to a single owner, not to every
  session spawn. (The non-atomic write itself should also become temp+rename in
  `claudeAccountPool.ts:655`, matching its Codex sibling at
  `codexAccountPool.ts:761`.)

### [HIGH] MCP server URLs and hook command lines carry credentials to the renderer under keys `secretGuard` cannot see

- **Where**: `app/sidecar/extensionsDomain.ts:121-123` (`entry.url`), `:351` (`displayLine`); claim contradicted at `app/shared/protocol.ts:2178`
- **Type**: security
- **What**: `buildMcpEntry` copies `config.url` verbatim onto the outbound
  `McpConfigEntry`, and `buildHookEntries` puts `getHookDisplayText(config)` on
  `HookEntry.displayLine` — which for a `command` hook is the **raw shell command
  string** and for an `http` hook is the **raw webhook URL**
  (`src/utils/hooks/hooksSettings.ts:78,84`). `secretGuard` matches on key NAMES
  only (`app/shared/secretGuard.ts:28-40`), so `url` and `displayLine` pass
  unconditionally.
- **Trigger / why it matters**: an `.mcp.json` entry of the extremely common form
  `{"type":"sse","url":"https://mcp.vendor.com/sse?api_key=sk-live-…"}` sends that
  key to the renderer and renders it verbatim
  (`app/renderer/src/SettingsExtensions.tsx:143`). A settings-file hook such as
  `curl -H 'x-api-key: sk-…' …` does the same via `displayLine`. This is a direct
  violation of the SECURITY-MINIMUM §4 invariant "secrets live engine-side only;
  the renderer never sees raw credentials", and `protocol.ts:2178` states the
  opposite as fact: "`getHookDisplayText` output — the command / url / prompt line
  (no secrets)". The module header
  (`extensionsDomain.ts:14-18`) shows the authors thought about MCP `env`/`headers`
  and hook bodies but missed that the URL and the command line are the same class
  of carrier. Impact is bounded (the renderer is the same user's CSP-locked
  window, it does not persist or forward), which is why this is a broken
  invariant rather than an exploit — but the invariant is a hard gate here.
- **Fix**: redact before projecting. For `url`, emit origin + path only (drop
  `search`, `hash`, and any `username`/`password`) — the panel only needs to show
  which host a server talks to. For `displayLine`, either truncate to the argv[0]
  / host, or keep the full line but strip `key=`/`token=`/`Bearer …`-shaped
  substrings. Then fix the `protocol.ts:2178` comment so it describes what is
  actually guaranteed.

### [MED] `account.rename` performs an unlocked whole-file rewrite of a vault account file

- **Where**: `app/sidecar/accountsDomain.ts:876` → `src/services/api/codexAccountPool.ts:796` (`setAccountAlias`)
- **Type**: correctness
- **What**: the rename verb reaches `setAccountAlias`, which does
  `readFileSync` → mutate `alias` → `writeFileSync(tmp)` → `renameSync` on the
  whole account JSON, taking **no** lock — while the refresh path holds
  `lock(vaultFilePath)` for the same file (`codexTokenRefresh.ts:293`).
- **Trigger / why it matters**: the operator clicks Rename on the accounts page
  while a background refresh is mid-rotation for that account. If
  `setAccountAlias` reads before the refresh writes `refresh.attempt_id` and
  renames after, the whole `refresh` block reverts to its pre-attempt value; the
  refresh's ownership check then fails (`codexTokenRefresh.ts:537`) and it
  discards the rotated tokens the server has already issued, leaving the vault
  holding a burned refresh token. Same failure class as the engine-side
  `persistNextQuarantineProbe` HIGH, now reachable from a UI button. The window
  is short (a parse + stringify) and the action is user-initiated, hence MED
  rather than HIGH — but nothing makes it impossible, and the desktop is what
  put a rename button in front of a running rotation loop.
- **Fix**: engine-side. Wrap the read-modify-write in `setAccountAlias` in the
  same `lock(acct.vaultFilePath)` the refresh path uses, and re-read under the
  lock. The sidecar is calling the correct entry point; the entry point is what
  needs the lock.

### [MED] A throwing `onProviderActivated` wedges the OAuth state machine permanently

- **Where**: `app/sidecar/accountsDomain.ts:751-753`; the throwing callback is wired at `app/sidecar/sessionController.ts:600-603`
- **Type**: correctness
- **What**: in `submitAlias`, `options.onProviderActivated?.(…)` is called
  *before* `pending`, `pendingProviderActivation` and `phase` are reset, with no
  try/catch. `sessionController.ts` deliberately wires a callback that throws:
  `const result = runControls.activateProvider(provider); if (!result.ok) throw new Error(result.message)`.
- **Trigger / why it matters**: `activateProvider` returns `ok:false` whenever
  `providerSwitchLocked && crossing` (`app/sidecar/runControlsDomain.ts:349`);
  `providerSwitchLocked` is true for a session started with provider-bound
  history or after `getTotalInputTokens() > 0` (`:217-220`). In that case a
  first-run sign-in that has **already persisted credentials** throws, leaving
  `phase === 'persisting'` forever. From then on `beginLogin` refuses
  ("Sign-in is already completing", `:643`), `cancelLogin` refuses
  ("can no longer be cancelled", `:762`), no `success` progress is emitted so the
  accounts snapshot is never re-broadcast, and `isOAuthLoginInFlight()`
  permanently returns true — which permanently closes the idle-park gate
  (`app/sidecar/sidecarServer.ts:1627`), pinning the engine process. The user is
  signed in but the app reports an `internal_error` and can never sign in again
  in that session. `accountsDomain.test.ts` covers the throw-free activation path
  (`:596`) and the denied-activation path (`:656`) but never a throwing callback.
- **Fix**: wrap the activation call in try/catch and reset `pending` /
  `pendingProviderActivation` / `phase` in a `finally` before returning, treating
  a failed provider activation as an `ok:false` result rather than an exception —
  the credential write already succeeded, so the sign-in must be reported as
  successful. Better still, make `onProviderActivated` return a result instead of
  throwing so the type forces the caller to handle it.

### [MED] A second `account.login` abandons the first Codex flow, stranding machine-global port 1455

- **Where**: `app/sidecar/accountsDomain.ts:642-708` (`beginLogin`), vs `:761-782` (`cancelLogin`)
- **Type**: correctness / resource leak
- **What**: `beginLogin` guards only against `phase === 'persisting'`, then
  supersedes by `activeOAuthRunner?.cancel?.()` + `generation++` +
  `resolveManualCode = null`. `createRealOAuthLoginRunner` (the Codex runner,
  `:254`) defines **no** `cancel`, so the optional call is a no-op, and dropping
  `resolveManualCode` removes the only channel that could unblock the in-flight
  flow. `cancelLogin` gets this right (`:771-777`: it resolves the wait with `''`
  so `runCodexOAuthFlow` throws and reaches its `finally { callbackServer.close() }`).
- **Trigger / why it matters**: double-click "Sign in" on the accounts page.
  Flow 1 keeps `runCodexOAuthFlow` pending forever, holding its callback server
  bound on **port 1455** — a fixed, machine-global port hardcoded in OpenAI's
  registered redirect URI (`src/services/oauth/codex-client.ts:314-316,575`).
  Flow 2 then hits EADDRINUSE, silently falls back to the null server (`:577-584`),
  and can only complete via manual paste. Worse, the browser redirect for flow 2
  lands on flow 1's server with a mismatched `state` and is rejected. Net: the
  automatic Codex sign-in path is dead for the life of that sidecar, and port
  1455 is unavailable to the CLI's `/login` machine-wide until the process exits.
- **Fix**: in `beginLogin`, run the same unblock `cancelLogin` does before
  superseding (resolve the pending `resolveManualCode` with `''`), or simply call
  `cancelLogin()` at the top of `beginLogin`. Giving `createRealOAuthLoginRunner`
  a real `cancel()` that does this is the cleaner version, since the two runners
  then satisfy the same contract.

### [MED] A settings write in one window silently reverts a setting another window already changed

- **Where**: `app/sidecar/settingsDomain.ts:264,269-275`
- **Type**: correctness / design
- **What**: the settings snapshot is read once at spawn and refreshed **only**
  in the sidecar that performed a write. There is no cross-process invalidation
  and no `subscribe()`, so every other live session shows the pre-change value
  indefinitely.
- **Trigger / why it matters**: two windows open on the same project. Window A
  turns "Fast mode" off. Window B's snapshot still says on. The operator now
  toggles Fast mode in window B intending to turn it *off*, the UI sends `true`
  (its stale idea of the current value inverted), and A's change is reverted with
  no indication that the value had moved. The write itself is safe — the
  `SettingsUpdater` closure computes from the under-lock fresh read
  (`src/utils/settings/settings.ts:557-566`) — so this is a lost update caused by
  a stale *display*, not by a racing write. The header's justification
  ("general settings need a restart in the engine today") predates the write path
  and no longer holds now that the desktop mutates these files from N processes.
- **Fix**: re-read the snapshot on demand rather than freezing it. The cheapest
  correct version: have `getSnapshot()` re-run `readSettingsSnapshotOnce` when
  the settings files' mtimes have moved, and broadcast on attach; a
  `settings.snapshot` re-emit already exists (`sidecarServer.ts:2639`), so only
  the freshness check is missing.

### [MED] Engine-authored free text rides the accounts snapshot uncapped, while the lease domain caps the identical class

- **Where**: `app/sidecar/accountsDomain.ts:391-405` (`statusReason`, `availabilityLabel`, `lastError`) vs `app/sidecar/leaseDomain.ts:74,225-229` (`MAX_REASON_CHARS` / `capReason`)
- **Type**: correctness / design
- **What**: `leaseDomain` explicitly bounds engine reason strings because
  "`failoverCodexLease` passes an upstream `error.message` through". `AccountStatus`
  carries three fields from the same population — `lastError` is set directly from
  refresh/quarantine error text (`src/services/api/codexAccountPool.ts:441,617,646`)
  — with no cap at all.
- **Trigger / why it matters**: an upstream error whose message is large enough
  pushes the snapshot past `MAX_OUTBOUND_FRAME_BYTES`; `send` then drops the whole
  frame, so the accounts page silently shows nothing rather than a truncated
  reason. It is also the inconsistency that matters for the credential question:
  I traced these three fields to their sources and the engine currently sanitizes
  them (only extracted OAuth error codes or `http_NNN` reach `lastError` —
  `codexTokenRefresh.ts:472,487`, never `bodyText`), so today they carry no
  secret. But nothing in the sidecar enforces that, and `secretGuard` cannot,
  because these are free-text values under innocuous key names.
- **Fix**: apply `leaseDomain`'s `capReason` (or a shared helper) to
  `statusReason`, `availabilityLabel` and `lastError` in `buildAccountStatus`.
  A shared `capEngineText()` in one place would also stop the two domains from
  drifting again.

### [MED] `remoteSettings.directConnect` gives the privileged sidecar an unbounded-host egress channel

- **Where**: `app/sidecar/remoteSettingsDomain.ts:205-213`; URL shape validated at `app/sidecar/sidecarServer.ts:3874-3886`
- **Type**: security
- **What**: the boundary validation is good (absolute URL, `http`/`https` only,
  no embedded credentials, no query/fragment, non-empty host) and the code
  honestly notes that host *policy* was deliberately left undecided. What remains
  is that a renderer-named host receives a POST from the sidecar carrying the
  session `cwd`.
- **Trigger / why it matters**: a compromised or buggy renderer reaches any
  reachable host — including `http://127.0.0.1:<port>` and RFC1918 addresses —
  from the privileged process, which is exactly the egress SECURITY-MINIMUM T3
  relies on `connect-src 'self'` to deny, and it discloses a filesystem path. The
  `directConnectInFlight` latch (`:235,257-272`) correctly bounds concurrency to
  one per session, but the 15 s `withTimeout` *abandons* the underlying fetch
  (there is no signal), so the latch releases while the socket lives on; the real
  bound is one leaked socket per 15 s per session, not zero.
- **Fix**: two small things. Add the host policy the comment defers — loopback
  plus an operator-configured allowlist is the obvious v1, and it is a two-line
  addition to `isAllowedRemoteServerUrl`. Separately, thread an `AbortSignal`
  into `createDirectConnectSession` so the timeout actually cancels the request
  instead of orphaning it.

### [MED] A failed accounts / lease / remoteSettings snapshot read is completely silent

- **Where**: `app/sidecar/accountsDomain.ts:792-794`, `app/sidecar/leaseDomain.ts:131-133`, `app/sidecar/remoteSettingsDomain.ts:246-248`; consumed at `app/sidecar/sidecarServer.ts:3104,2902,3282`
- **Type**: quality (error handling)
- **What**: all three `getSnapshot()` implementations use a bare
  `catch { return null }` with no message, and every caller treats `null` as
  "emit nothing" with an early `return` that logs nothing either. The two domains
  that get this right — `settingsDomain.ts:384-391` and
  `workspaceTrustDomain.ts:190-196` — write a specific line to stderr.
- **Trigger / why it matters**: if `getPoolStatus()` or the lease read throws for
  any reason, the accounts page stays permanently empty and there is not one byte
  anywhere explaining why: no error text, no error type, no account id. The
  symptom ("the accounts page is blank") is indistinguishable from an empty pool,
  which is the single hardest class of bug to diagnose on an operator's machine.
- **Fix**: match the settings/trust pattern — write the caught error to stderr
  with the domain name before returning null, and log the `!raw` early-return in
  `sendAccountsSnapshot` / `sendLeaseSnapshot` / `sendRemoteSettingsSnapshot`.

### [MED] `accountsDomain.ts` is two modules: a read seam and a 250-line OAuth state machine

- **Where**: `app/sidecar/accountsDomain.ts` (949 lines); the login controller occupies `:189-372` and `:620-782`
- **Type**: design
- **What**: the file holds the pool projection, the verb executor, the verb
  dispatcher, *and* a two-provider OAuth login controller with its own generation
  counter, four-state phase machine, manual-code rendezvous, and pending-token
  custody. The stated recipe for this file is "the CANONICAL W4 domain read-seam
  recipe … later domains copy this shape" — but two thirds of what a reader must
  hold in their head to change it is the login controller, which no other domain
  has.
- **Trigger / why it matters**: this is where the two OAuth defects above live,
  and both are of the same kind: state that must be reset on every exit path,
  spread across four functions and one async IIFE with no single owner. The cost
  is concrete — the domain's own test file has 39 tests and still misses the
  double-login and the throwing-callback paths, because the state machine's exit
  paths are not enumerable from any one place.
- **Fix**: extract the controller into `oauthLoginController.ts` exporting
  `createOAuthLoginController({ runners, onProviderActivated })` with the phase
  machine as an explicit reducer-shaped transition table. `accountsDomain` then
  delegates the four `account.oauth*` verbs to it and shrinks to the read seam +
  executor it advertises itself as.

### [LOW] The Anthropic runner re-implements an engine function it already imports from

- **Where**: `app/sidecar/accountsDomain.ts:351-360` vs `src/cli/handlers/auth.ts:216-232`
- **Type**: quality (duplication)
- **What**: `persist()` does `await validateOrg(tokens.accessToken)` then
  `await installTokens(tokens)`. `installOAuthTokensAfterPolicyValidation` in the
  engine does exactly that, with the same injectable `{ validateOrg, installTokens }`
  dependency shape — and it lives in the same file the domain already imports
  `installOAuthTokens` and `parseManualOAuthCallbackInput` from.
- **Trigger / why it matters**: CLAUDE.md §8 rule 10 names this pattern
  specifically. The two copies already differ: the engine returns the
  `OrgValidationResult`, the sidecar throws `new Error(orgResult.message)`. Any
  future change to the ordering or to what counts as a pre-commit gate now has to
  be made twice, and only one copy has engine-side tests.
- **Fix**: call `installOAuthTokensAfterPolicyValidation(tokens)` and throw on
  `valid === false` at the call site, keeping the engine as the single owner of
  the commit order.

### [LOW] The lease snapshot is rebuilt and re-sent on every app-state mutation

- **Where**: `app/sidecar/leaseDomain.ts:135-137`; broadcast at `app/sidecar/sidecarServer.ts:511-514`
- **Type**: quality (performance)
- **What**: `subscribe()` forwards the raw `AppStateStore` subscription, so every
  `setState` triggers `broadcastLeaseSnapshot()` → for each connection a full
  lease + pool-alias rebuild, a `structuredClone`, a `checkJsonSafe` walk, a
  `scanForSecrets` walk and a socket write — even when no lease moved.
- **Trigger / why it matters**: the store holds `messages` and `tasks`, so a
  running subagent fires it on every appended message and every task-state update
  (`src/tasks/LocalAgentTask/LocalAgentTask.tsx` `appendMessageToLocalAgent`,
  `updateTaskState`). The module header's own claim — that leases move "on exactly
  the events that mutate `AppState.tasks`" — is what justifies the subscription,
  and it is true; what does not follow is that every *other* mutation should also
  produce a frame. `runControlsDomain` solved the identical problem with a
  signature guard (`app/sidecar/runControlsDomain.ts:378-385`).
  (`tasksDomain` and `agentModeDomain` share the same raw-subscribe shape, so this
  is a pattern worth fixing once, not a lease-specific slip.)
- **Fix**: compute a cheap signature over the projected snapshot (owner ids +
  account ids + states) and only invoke the listener when it changes, exactly as
  `runControlSignature` does.

### [LOW] Four unchecked `as` casts narrow user-editable config into closed wire unions

- **Where**: `app/sidecar/extensionsDomain.ts:118` (`McpConfigTransport`), `:119` (`McpConfigScope`), `:165` (`SkillConfigSource`), `:348` (`HookConfigType`)
- **Type**: quality (types)
- **What**: this is projector-style code producing an outbound frame, where the
  repo convention is "runtime-narrow unknown shapes; zero `as` casts". The values
  happen to be sound today because `McpServerConfigSchema` constrains `type` to
  the same eight literals the wire union lists, but there is no compile-time link
  between the two.
- **Trigger / why it matters**: the engine adds a ninth MCP transport literal.
  Nothing fails to compile; the sidecar simply emits a `transport` value outside
  the declared union and the renderer's transport handling silently gets a value
  it has no case for. The repo's own mechanism for this — an exhaustiveness
  tripwire — is used elsewhere in these same files
  (`accountsDomain.ts:931`, `remoteSettingsDomain.ts:276`,
  `settingsEditable.ts:393`) and is simply absent here.
- **Fix**: replace each cast with a small `is<X>()` guard plus a documented
  fallback (unknown transport → `'stdio'`, or drop the entry), and add a
  `never`-assignment tripwire over the engine literal so a new one is a compile
  error.

### [LOW] `buildBridgeStatusSnapshot` is filed under "Pure projection" but reads an engine global

- **Where**: `app/sidecar/remoteSettingsDomain.ts:135-144`, under the header at `:98-100`
- **Type**: quality (naming / testability)
- **What**: the function takes state as a parameter, sits under a section banner
  reading "Pure projection — the command-filter bucketing, unit-tested", and then
  calls `isEnvLessBridgeEnabled()` to derive `transport`. Its sibling
  `buildCommandFilterSnapshot` genuinely is pure.
- **Trigger / why it matters**: a test that drives this with a fixture is
  silently coupled to the ambient env of the test process; the parameter list
  lies about the function's inputs.
- **Fix**: take `transport` (or an `isEnvLess: boolean`) as a second parameter and
  resolve it at the one call site in `getSnapshot()`.

### [LOW] `createSidecarExtensionsDomain` is a pass-through with no behavior

- **Where**: `app/sidecar/extensionsDomain.ts:63-71`
- **Type**: quality (design)
- **What**: the "domain" is `(snapshot) => ({ getSnapshot: () => snapshot })`. All
  the work lives in the separately-exported `loadExtensionsSnapshot`, which the
  session controller calls itself (`sessionController.ts:325`) and then hands the
  result back in.
- **Trigger / why it matters**: it costs a reader a hop to discover the domain
  holds nothing, and it makes the `createSidecar<X>Domain` convention look like
  ceremony rather than a contract. It is the only one of the seven with no state,
  no engine read at call time and no verb.
- **Fix**: either drop the wrapper and pass `ExtensionsSnapshot | null` straight
  to the server (the type it stores anyway), or move the `loadExtensionsSnapshot`
  call inside an async `createSidecarExtensionsDomain(...)` so the module owns its
  own construction, as `createSidecarWorkspaceTrustDomain` does.

## What is good here

- **The trust grant is airtight, and for the right reason.** `workspace.trust`
  carries no path — the strict-key allowlist is `['type','requestId']`
  (`sidecarServer.ts:3516`) and the schema is a two-field literal
  (`:3937-3940`) — and `createRealWorkspaceTrustExecutor(cwd)` closes over the
  sidecar's own spawn cwd. The read fails **closed**
  (`workspaceTrustDomain.ts:182-197`), the three sub-reads are independent so a
  git-spawn failure cannot discard a known trust fact, and the enforcement is at
  the submit gate with `!== true` rather than `=== false`
  (`sidecarServer.ts:1407`) — which is the distinction that makes a null snapshot
  deny instead of permit. Reading `trustRoot` through the write's own
  `getProjectPathForConfig()` so the displayed scope cannot drift from the stored
  scope is a genuinely thoughtful touch.
- **The settings write is the model for how to touch a shared file.** It uses the
  `SettingsUpdater` *function* form so the next state is computed from the
  under-lock fresh read, and it depends on the engine dropping its parse cache
  inside the lock (`src/utils/settings/settings.ts:507-524`) — a subtlety the
  domain comment calls out explicitly, and the reason the lock alone was not
  enough. Copy this comment's reasoning wherever another domain starts writing a
  shared file.
- **The editable-settings allowlist is enforced three times, in the right places.**
  Zod schema with a closed source enum → `validateEditableSettingWrite` at the
  boundary (`sidecarServer.ts:2240`) → the same checks again in the domain as the
  last gate before disk (`settingsDomain.ts:290-323`), with the dynamic-enum
  membership check deliberately kept at the sidecar because that is the only
  plane holding the live option list. The `null`-as-clear channel is argued from
  three independent angles (type, validator, engine schema) instead of using an
  in-band sentinel, and the one place a sentinel survives is fenced off by
  refusing to *capture* it as an option (`settingsDomain.ts:442`).
- **`parseAccountsPoolWorkerResult` is exemplary fail-closed parsing.** Version
  check, exact-key check, field-by-field narrowing with zero `as` on untrusted
  child output, and one malformed row failing the whole record
  (`app/shared/accountsPoolWorker.ts:62-281`). The `hasExactKeys` two-arm handling
  of an optional field (`:106-111`) keeps the closed-vocabulary property intact
  instead of loosening to a subset check.
- **The accounts worker's headers are real engineering documentation.** Every
  non-obvious choice — why `loadPoolForObservation` instead of `init()`, why
  `loadClaudePoolForObservation` instead of `initClaudeAccountPool`, why the
  `CLAUDE_CODE_SIMPLE` gate has to be lifted synchronously for exactly two
  boolean reads and restored in a `finally` — states the failure it prevents.
  That header is what let me find the two HIGH findings above: it documents the
  correct posture, and the per-session path does the opposite.
- **`resolveAccountForWrite` (`accountsDomain.ts:607-618`) is the right shape for
  a stale-singleton problem**: pay the disk re-read only on a miss, keep the
  accumulated in-memory usage hints on a hit, and treat a failed re-read as
  non-fatal. It also has the test that proves the re-read happens exactly once
  (`accountsDomain.test.ts:365`).

## Not reviewed / uncertain

- **Whether the quarantine-probe race actually fires in practice.** I proved the
  mechanism from source (unlocked `next_probe_at` read at
  `codexTokenRefresh.ts:830`, unlocked write at `:881`, ownership check at `:537`)
  and proved that each sidecar starts a 1 s probe timer, but I did not
  instrument two live sidecars against a quarantined account to observe a lost
  rotation. A probe test spawning two processes against a temp vault with a
  quarantined account and asserting that at most one `attempt_id` survives would
  settle it. The fix I recommend (observation-only pool load in sidecars) is
  correct regardless of whether the race is currently being hit.
- **Keychain cost of the worker's route read.** `readAnthropicRouteFacts`
  (`accountsPoolWorker.ts:184-217`) lifts the hermetic-auth gate and calls
  `hasAnthropicCredentials()`, which can reach the macOS keychain, and it runs in
  a fresh process every 60 s with the token cache cleared on both sides. Whether
  that produces a measurable cost or a keychain prompt on a non-dev-signed build
  needs a live run; I could not determine it from source.
- **Lease release on abnormal worker termination.** I reviewed the read seam
  (`leaseDomain.ts`), which has no verb and no release path by design; whether a
  lease can strand in `codexAccountLeaseManager` when a `local_agent` dies without
  running its release is an engine-side question outside this scope. What I can
  say about the projection: a stranded engine lease would keep producing an owner
  row for as long as the task stays in `AppState.tasks`, because
  `liveWorkerOwnerIds` (`:194-200`) filters on task *type*, not task *status*.
  Since the whole lease map is process-local and the process dies with the
  session, no lease survives a crash.
- **Whether the renderer displays the MCP `url` in full or truncated.** I
  confirmed the value crosses the boundary and that `SettingsExtensions.tsx:143`
  reads `server.url` into the row's detail text; I did not verify CSS truncation
  or a title attribute. The finding stands either way — the credential is in the
  renderer's memory and in any DOM dump regardless of how it is styled.
