# X02a adversarial validation: non-atomic persistence and cross-layer duplication

> **Verification provenance:** Opus 5 (`claude-opus-5`) at high effort. Read-only
> source review plus four standalone scratch scripts run against the real repo
> modules (`src/utils/sessionStorage.ts` imported live; `bun:bundle` `feature()`
> probed at runtime; POSIX mode/rename semantics measured), plus string analysis
> of the built `./cli-dev`. No repo file edited except this report. No test suite
> run (no single test file turned out to be decisive). No GUI, no dev server.
> Branch `migration` at `a17e5e9`.

## Overall verdict

The report is **substantially right**, and it is the strongest of the review's
scopes on evidence discipline: 14 of its 20 findings survive intact, 4 survive
narrower, 1 is overstated, and exactly 1 is dead. Its central thesis — that the
engine hosts a scatter of non-atomic writes of durable state while `app/` writes
its own files correctly — I attacked directly by re-auditing every direct `fs`
write under `app/main`, `app/host`, `app/sidecar`, `app/supervisor`: the only
non-atomic one is the user-chosen save-as the report already carves out. The
thesis holds.

Two corrections matter. **F2 (`settingsSync` bypasses the settings lock) is
INVALID**: the entire write path lives inside `if (feature('DOWNLOAD_USER_SETTINGS'))`,
that name is in neither of `scripts/build.ts`'s feature lists, `feature()` returns
false at runtime, and the module's telemetry strings are absent from the built
`cli-dev` while 1,628 other `tengu_*` strings survive — it is dead code in every
build this repo can produce. And **F4's "permanently erasing" is wrong**: the
plugin registry is rebuilt from `enabledPlugins` on the next launch. But F4 hides
something worse the report missed — the degraded-to-empty load feeds the orphan
sweeper, which marks every cached plugin version orphaned and `rm -rf`s it after
seven days.

**F3 I proved with a scratch repro**, and in doing so found the report had the
right bug with the wrong trigger: the flush-timer race it describes is real but
needs a sub-millisecond window against a 100 ms timer, while the dominant trigger —
two concurrent `removeMessageByUuid` calls from one tombstone burst, which the
report does not mention — reproduces on the very first attempt.

**Attribution: every one of the 13 sweep-1 findings is pre-existing on `main`.**
None is branch-new. All 7 sweep-2 (D) findings are branch-new by construction,
since `app/` does not exist on `main`. The classification table's row-1 note
"(perm bug is new, see F1)" should read "newly *found*", not "newly introduced".

Two bookkeeping errors: the header count "6 HIGH · 8 MED · 5 LOW" (19) does not
match the body (5 HIGH · 9 MED · 6 LOW = 20); and D7's "two of the four drop the
directory fsync" contradicts the same report's own sweep-1 finding, which
correctly lists three.

The single most deserving action is **F1**, unchanged: live refresh tokens at
`0644`. My verification adds the operational answer the fix needs — a `chmod 600`
on the Claude vault survives, on the Codex vault does not.

## Summary

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| F1 | HIGH | OAuth tokens written `0644` in `0755` vault dir | **CONFIRMED** | Cause traced to 6 writers; Codex vault on disk shows the 0600↔0644 flip-flop live |
| F2 | HIGH | `settingsSync` bypasses the settings lock | **INVALID** | Whole path behind `feature('DOWNLOAD_USER_SETTINGS')`, absent from `scripts/build.ts` and from `cli-dev` |
| F3 | HIGH | `removeMessageByUuid` truncates on a stale size | **CONFIRMED** | Reproduced; the report's flush-timer trigger is the rare one, concurrent tombstones the common one |
| F4 | HIGH | Registry crash → silent total uninstall | **PARTIALLY CONFIRMED** | Mechanism exact; "permanent" wrong (rebuilt from `enabledPlugins`) — but escalates to 7-day cache deletion |
| — | MED | Two near-identical helper names, opposite guarantees | **PARTIALLY CONFIRMED** | Core right; `main.tsx:471` mischaracterised, and 5 genuinely unsafe callers missed |
| — | MED | Eleven hand-rolled `atomicWriteJson` copies | **CONFIRMED** | All 11 verified, incl. the `devHarness` temp-file leak |
| F6 | MED | `scheduled_tasks.json` lock-free read-modify-write | **CONFIRMED** | Race real; live only under `feature('AGENT_TRIGGERS')`, which `dev-full` enables |
| F7 | MED | Task store locked but not atomic | **CONFIRMED** | Lock discipline as described; writes truncating; `writeHighWaterMark` is neither |
| F11 | LOW | `resolved/<id>.json` non-atomic, read unlocked | **CONFIRMED** | Cited lines hold; self-healing as stated |
| F12 | LOW | Peer registry truncated in place | **CONFIRMED** | `registerSession` is not feature-gated; `/resume` path live |
| F13 | LOW | `immediateFlushHistory` drops buffer on failure | **CONFIRMED** | `pendingEntries = []` precedes the `await appendFile` exactly as claimed |
| F14 | LOW | `saveConfig` unlocked twin on two live paths | **OVERSTATED** | Both are the documented catch-fallback for a *failed* lock, already guarded; proposed fix would recurse |
| F15 | LOW | `writeTeamFile` is dead | **CONFIRMED** | Non-exported, zero callers |
| D1 | HIGH | Desktop donut divides by the raw window | **CONFIRMED** | Divisor is the raw window; arithmetic right; red band is unreachable, which the report understates |
| D2 | MED | Sidecar drains one prompt per turn | **PARTIALLY CONFIRMED** | Batching divergence + false citation real; the slash-command half is not a divergence |
| D3 | MED | One-winner-per-key vs engine deep merge | **CONFIRMED** | Render site is `MetadataInspector.tsx:420`; the editor rows are *not* affected |
| D4 | MED | Four encodings of source precedence | **CONFIRMED** | Including the report's own "latent, not live" hedge |
| D5 | MED | `readyCount` re-derives availability | **CONFIRMED** | Both over- and undercount paths verified against `getCodexAccountAvailability` |
| D6 | MED | Backfill reads whole transcripts | **CONFIRMED** | No size gate; early-exit demands `effort`, which Anthropic sessions never write |
| D7 | LOW | Three (four) copies inside `app/` | **PARTIALLY CONFIRMED** | Real, but *three* of four drop the dir-fsync, not two |

---

## Per finding

### F1 — [HIGH] OAuth refresh tokens are written world-readable (0644) in a 0755 vault directory

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, and the line numbers are exact.
  `src/services/api/claudeAccountPool.ts:627` is `mkdirSync(accountsDir, { recursive: true })`;
  `:655` is `writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')`.
  `src/services/api/codexAccountPool.ts:718` is `mkdirSync(targetDir, { recursive: true })`,
  `:762` the temp write, `:806` the alias temp write.
  `src/services/api/codexTokenRefresh.ts:935` is `fd = openSync(tmpPath, 'w', 0o600)`,
  the one writer that gets it right.
- **Reachable in production?**: Yes, no gate of any kind. `saveClaudeTokenToVault`
  is called from `claudeAccountPool.ts:164` (migration), `:453` and `:535` (token
  refresh / account add). `saveCodexTokenToVault` is called from
  `src/codex-core/accounts.ts:572` **and from the desktop sidecar** at
  `app/sidecar/accountsDomain.ts:277`, so the desktop is a first-class writer of
  0644 credential files, not merely a bystander.
- **Trigger**: Any token refresh or login. The observation was independently
  confirmed by the operator for `~/claude-vault`; I extended it to the Codex
  vault, which is the more interesting case because it shows the mechanism
  operating live:

  ```
  drwxr-xr-x  /Users/pt/codex-vault/accounts
  -rw-r--r--  14f2f119-….json   Aug  8 01:32
  -rw-------  66608311-….json   Jul  3 05:03
  -rw-r--r--  93ce612e-….json   Aug  8 01:32
  -rw-------  9ed41939-….json   Jun 22 03:51
  -rw-r--r--  ca889574-….json   Aug  8 01:09
  ```

  Three at 0644, two at 0600. The 0600 pair are the two files nobody has written
  since June/July: they were last written by `codexTokenRefresh.ts`'s
  `atomicWriteJson` (0600 temp + rename). The three touched on Aug 8 were last
  written by `saveCodexTokenToVault` (0644 temp + rename). The report's sentence
  "its correctness is undone the moment `saveCodexTokenToVault` recreates the
  file" is not a deduction — it is legible in the directory listing.
- **Counter-arguments considered**: (a) *Is there a `chmod` on load that fixes
  it?* No — I grepped every `chmodSync`/`chmod` in `src/` and `app/`; the vault
  loaders have none. `src/services/deferredContinuation.ts:352` `readPrivateJson`
  is the only read-side private-mode check in the tree and it guards a different
  store. (b) *Is the vault path test-only?* No: `vaultPathOverrideForTest` is
  `undefined` in production and falls through to `DEFAULT_VAULT_PATH`
  (`claudeAccountPool.ts:58` = `~/claude-vault`). (c) *Does some umask make this
  moot?* `process.umask()` is `022` on this machine, so `writeFileSync` yields
  exactly `0644` and `mkdirSync` `0755`. (d) *Is it branch-new?* No —
  `git show main:src/services/api/claudeAccountPool.ts` has the identical
  `mkdirSync` (`:570`) and `writeFileSync` (`:598`), and `git blame` dates both
  to the root commit `86051a8` (2026-04-30).
- **True consequence**: Every local user on this machine can read live Anthropic
  and OpenAI access + refresh tokens. Exactly as claimed.
- **Evidence**: `ls -l ~/codex-vault/accounts`; `git blame -L 620,660 HEAD -- src/services/api/claudeAccountPool.ts`;
  scratch script `f1-chmod.ts` (below).
- **Disposition** — the report's fix is right in direction and wrong in three
  details, and the operator's question ("would a `chmod` be reverted?") has a
  split answer I measured rather than reasoned:

  ```
  claude first create           644
  after saveClaudeTokenToVault  600   <- chmod 600 SURVIVES (truncate in place)
  codex after chmod             600
  after temp+rename save        644   <- chmod 600 REVERTED
  mkdirSync no mode             755
  after chmod 700 + re-mkdir    700   <- dir chmod SURVIVES (mkdir is a no-op)
  ```

  So: `chmod 700 ~/claude-vault/accounts ~/codex-vault/accounts` is **durable**
  for both vaults and is the correct first move — it closes the exposure today
  without a code change, because `mkdirSync(…, {recursive:true})` never touches an
  existing directory. `chmod 600` on the **Claude** token files is also durable
  against `saveClaudeTokenToVault` (it truncates in place, and POSIX ignores the
  create-mode for an existing file) but is reverted by `setClaudeAccountAlias`
  (`:600-601`, temp+rename). `chmod 600` on the **Codex** token files is reverted
  by the very next `saveCodexTokenToVault`.

  Code fix, corrected: the report says "the three vault `writeFileSync` calls"
  and then lists four. The real list is six sites —
  `claudeAccountPool.ts:600` and `:655`, `codexAccountPool.ts:762` and `:806`,
  plus the two `mkdirSync` calls at `claudeAccountPool.ts:627` /
  `codexAccountPool.ts:718`. And **passing `{ mode: 0o600 }` to
  `claudeAccountPool.ts:655` does nothing for files already on disk**, because
  Node applies `mode` only on `O_CREAT`; the temp+rename sites are fine because
  their temp file is always new. So the report's "add a one-time `chmodSync` on
  load" is not optional polish, it is required for the in-place writer. The
  cleanest fix is to make all four writers use `codexTokenRefresh.ts`'s
  `atomicWriteJson` (export it), which gets mode, fsync, dir-fsync and temp
  cleanup in one move — the report proposes exactly this under its "eleven
  copies" finding, so the two fixes should be done together.

  One credential path the report did not sweep: `src/utils/secureStorage/plainTextStorage.ts:57`
  writes `~/.cat-code/.credentials.json` with the truncating
  `writeFileSync_DEPRECATED` and only `chmodSync(0o600)` *after* the write, so the
  file exists at 0644 with credentials in it for the duration of the write, and a
  crash in between truncates the store. Latent on this machine (the file does not
  exist; macOS keychain wins at `secureStorage/index.ts:11`), so LOW, but it
  belongs in the same fix.

### F2 — [HIGH] Settings sync writes `settings.json` non-atomically and bypasses the cross-process settings lock

- **Verdict**: **INVALID** — not reachable in production.
- **Cited location holds?**: Yes. `src/services/settingsSync/index.ts:461`
  `writeFileForSync` is `await writeFile(filePath, content, 'utf8')` with no lock
  and no temp+rename, called at `:519` (userSettings) and `:550` (localSettings).
  The report's description of the code is accurate, and its comparison against
  `updateSettingsForSource` is accurate too — I verified
  `src/utils/settings/settings.ts:507` `acquireSettingsLockSync(filePath)`,
  `:518` `deleteCachedParsedFile`, `:596` `writeFileSyncAndFlush_DEPRECATED`,
  which is exactly the discipline the report says the sync path skips.
- **Reachable in production?**: **No.** `writeFileForSync` has no callers outside
  `applyRemoteEntriesToLocal`, which has exactly one caller: `doDownloadUserSettings`
  at `:191`, inside `if (feature('DOWNLOAD_USER_SETTINGS'))` at `:160`. Four
  independent checks, all negative:
  1. `rg -n "UPLOAD_USER_SETTINGS|DOWNLOAD_USER_SETTINGS" scripts/build.ts` →
     nothing. Neither name is in `defaultFeatures`
     (`['TRANSCRIPT_CLASSIFIER','VOICE_MODE']`, `scripts/build.ts:82`) nor in
     `fullExperimentalFeatures` (`:13-49`). `build:dev:full` passes only
     `--feature-set=dev-full`, so no build path this repo defines turns them on.
  2. Runtime probe: a scratch script importing `feature` from `bun:bundle`
     printed `DOWNLOAD_USER_SETTINGS: OFF`, `UPLOAD_USER_SETTINGS: OFF` (and
     `VOICE_MODE: OFF` too — unbundled execution, i.e. the sidecar, has *no*
     features on).
  3. Binary evidence: `strings -a cli-dev | rg -o "settings_sync[a-z_]*"` yields
     only the bare token `settings_sync`, which comes from
     `main.tsx:1019 profileCheckpoint('preAction_after_settings_sync')` — outside
     the gate. `tengu_settings_sync*` → 0 hits, against 1,628 surviving `tengu_`
     strings. The module's body is dead-code-eliminated.
  4. Even with the feature on, two further gates stand: the statsig
     `tengu_strap_foyer` flag (default `false`) and `isUsingOAuth()` at `:162-165`.
- **Trigger**: None constructible. Both scenarios the report describes ((a) sync
  pull racing `updateSettingsForSource`, (b) a truncated `settings.json` after a
  mid-write crash) require `applyRemoteEntriesToLocal` to run, and it cannot.
- **Counter-arguments considered**: I looked for a bypass. `redownloadUserSettings`
  (`:152`, reached from `/reload-plugins`) looked like one, but it calls
  `doDownloadUserSettings(0)`, whose body is itself wrapped in the same
  `feature('DOWNLOAD_USER_SETTINGS')` check — and its caller at
  `src/commands/reload-plugins/reload-plugins.ts:25` gates on the same flag
  anyway. I also checked whether the desktop enables features when spawning the
  sidecar: `rg "feature-set|--feature" package.json app/scripts app/supervisor`
  returns only the root `build:dev:full` line, and the sidecar runs unbundled
  where every `feature()` is false.
- **True consequence**: None. The file is a correctly-identified latent hazard
  in code that never executes.
- **Evidence**: `scratchpad/v30/feat2.ts` output; `scripts/build.ts:13-49,82`;
  `strings -a cli-dev | rg -o "settings_sync[a-z_]*"`.
- **Disposition**: Do not spend a fix cycle here. If `DOWNLOAD_USER_SETTINGS` is
  ever added to `scripts/build.ts`, this becomes a genuine HIGH on that same day —
  so the correct action is a one-line note at `writeFileForSync` pointing at
  `updateSettingsForSource`, not a refactor. The report's proposed fix (route
  through `updateSettingsForSource(source, () => parsedRemoteSettings)`) is the
  right one *when* that day comes; note it would also need `markInternalWrite` to
  stay, since `updateSettingsForSource` calls it at `:592` but the memory-file
  writes at `:531`/`:562` are outside its remit.

### F3 — [HIGH] `removeMessageByUuid` truncates the live transcript using a stale size

- **Verdict**: CONFIRMED — **and the report has the right bug with the wrong
  primary trigger.**
- **Cited location holds?**: Yes, precisely. `src/utils/sessionStorage.ts:1320`
  is `async removeMessageByUuid`, `:1362` is `await fh.truncate(absLineStart)`,
  `:1393` is the slow-path `await writeFile(this.sessionFile, lines.join('\n'))`,
  `:1396` the blanket `catch {}`. `trackWrite` at `:1030` does only
  `incrementPendingWrites` / `decrementPendingWrites` — no serialisation against
  `drainWriteQueue` (`:1078`). `flush()` at `:1290` does await `activeDrain`,
  `drainWriteQueue()` and `pendingWriteCount`, exactly as the report says.
- **Reachable in production?**: Yes, but **TUI-only**. The chain is
  `src/query.ts:769` (`yield { type: 'tombstone', message: msg }` when
  `streamingFallbackOccured`) → `src/utils/messages.ts:3058` `onTombstone?.(...)`
  → `src/screens/REPL.tsx:2964` `void removeTranscriptMessage(tombstonedMessage.uuid)`
  → `sessionStorage.ts:1924` → `removeMessageByUuid`. `rg removeTranscriptMessage`
  finds exactly one caller, and it is `REPL.tsx`. **The desktop sidecar never
  wires `onTombstone`**, so the report's framing that this is "now reachable by
  design" from the desktop via `app/main/openHistorySession.ts` is not supported:
  the desktop's second writer only *appends*, it never truncates. That does not
  make the finding safer — it means the desktop is the victim, not the trigger.
- **Trigger**: **Proven, twice.** Scratch script importing the real module
  (`setSessionFileForTesting` is exported at `:911`; `sessionFile` is a public
  field):

  *Scenario A — the report's trigger (queue append inside the window).* The
  append is delayed by N real filesystem round-trips so it lands between `stat()`
  and `truncate()`; the append call is `appendFile(path, line, {mode: 0o600})`,
  byte-identical to what `drainWriteQueue` → `appendToFile` (`:1067`) issues:

  ```
  ioTicks=0  U3 appended entry: survived    U2 tombstone: removed  bytes=177
  ioTicks=1  U3 appended entry: *** LOST *** U2 tombstone: removed  bytes=83
  ioTicks=2  U3 appended entry: *** LOST *** U2 tombstone: removed  bytes=83
  ioTicks=3  U3 appended entry: *** LOST *** U2 tombstone: removed  bytes=83
  ioTicks=4  U3 appended entry: survived    U2 tombstone: removed  bytes=177
  ```

  The data loss is real. But note the shape of the window: it is about three IO
  round-trips wide — sub-millisecond — against `FLUSH_INTERVAL_MS = 100`
  (`:1000`). So the report's "the timer fires inside that window" is true but
  describes a sub-1% event per tombstone, not the routine case it reads as.

  *Scenario B — the trigger the report missed, and the one that actually fires.*
  `query.ts:769` yields **one tombstone per orphaned assistant message**, and
  `REPL.tsx:2964` `void`-calls each without awaiting, so N concurrent
  `removeMessageByUuid` calls overlap by construction:

  ```
  ioTicks=0 *** WRONG *** U1=true U2=false U3=true  bytes=198
  ioTicks=1 *** WRONG *** U1=true U2=false U3=true  bytes=198
  ioTicks=2 ok            U1=true U2=false U3=false bytes=83
  ```

  At 0 and 1 ticks apart — i.e. the natural back-to-back case — **U3 is
  resurrected**: the second remover's re-append of its stale tail restores the
  line the first remover had just deleted. That is worse than losing an appended
  message, because the resurrected entry is precisely a partial thinking block
  with an invalid signature; the comment at `query.ts:766-768` says these "would
  cause 'thinking blocks cannot be modified' API errors". A later `--resume` of
  that transcript reloads it.
- **Counter-arguments considered**: (a) *Does `trackWrite` serialise?* No — read
  it at `:1030`; it is a counter, and the counter is only consumed by `flush()`.
  (b) *Does the queue always drain before the tombstone arrives?* No; nothing
  orders them. (c) *Does `shouldSkipPersistence` (`:1409`) make this test-only?*
  It guards `appendEntry`/`materializeSessionFile`, not `removeMessageByUuid`.
  (d) *Is the slow path defensible?* `MAX_TOMBSTONE_REWRITE_BYTES = 50 MB`
  (`:153`) bounds it, but the write is still a truncating full-file rewrite as
  claimed. (e) *Branch-new?* No — `git show main:src/utils/sessionStorage.ts`
  has `removeMessageByUuid` at `:1186` with the same `await fh.truncate(absLineStart)`
  at `:1229`.
- **True consequence**: A user or assistant turn silently vanishes from the
  transcript (Scenario A), or a tombstoned invalid-signature message is silently
  restored to it (Scenario B). Both are permanent, both are invisible at the time,
  and both surface later as a wrong `--resume`.
- **Evidence**: `scratchpad/v30/f3-race2.ts`, `scratchpad/v30/f3-race3.ts`,
  outputs above.
- **Disposition**: The report's fix — `await this.drainWriteQueue()` and
  `await this.activeDrain` at the top of the `trackWrite` body — **closes
  Scenario A but not Scenario B**, which is the likelier one; two removers would
  both drain and then both race on the file exactly as before. Apply instead a
  single per-file mutex (a promise chain keyed on `sessionFile`, the idiom
  `src/agent-mode/sessionState.ts:232` already uses via `sessionStateWriteChains`)
  covering the whole of `removeMessageByUuid`, and chain the queue drain into the
  same lock. Keep the report's two secondary fixes verbatim: make the `:1393`
  slow path temp+rename, and narrow the `:1396` `catch {}` to ENOENT — as written
  it swallows a half-completed truncate, which is how Scenario B stays silent.

### F4 — [HIGH] A crash during the plugin-registry write silently uninstalls every plugin

- **Verdict**: PARTIALLY CONFIRMED — mechanism exact, blast radius mis-stated in
  both directions.
- **Cited location holds?**: Mostly. `saveInstalledPluginsV2` is at
  `src/utils/plugins/installedPluginsManager.ts:369`, and its
  `writeFileSync_DEPRECATED(filePath, jsonContent, { encoding:'utf-8', flush:true })`
  is at `:378` (the report says `:373`; the function header is at `:367`). The
  characterisation of the helper is exactly right: `src/utils/slowOperations.ts:262-277`
  takes the `needsFlush` branch and does `openSync(filePath, 'w', mode)` —
  `O_TRUNC` in place — then write, then `fsyncSync`. No temp, no rename, no lock.
  The load path's catch-all is at `:353-362` and does return
  `{ version: 2, plugins: {} }`. Callers `addPluginInstallation:413` and
  `removePluginInstallation:457` do re-read from disk first, as stated.
- **Reachable in production?**: Yes, ungated. `initializeVersionedPlugins`
  (`:713`) runs at startup in both REPL and headless modes.
- **Trigger**: The report's path (a) is real and I traced it end to end.
  `readInstalledPluginsFileRaw` (`:259`) documents "Throws error if file exists
  but can't be parsed", and its `jsonParse` is
  `src/utils/slowOperations.ts:204 export const jsonParse: typeof JSON.parse`,
  which throws. So a truncated file →
  `loadInstalledPluginsV2` catch → zero plugins reported → the next
  `addPluginInstallation` writes `{}` back. Path (b) — two sessions installing
  concurrently, both re-reading, both writing the whole document, later write
  wins — is straightforwardly true; there is no lock anywhere in the module.
- **Counter-arguments considered** — this is where the finding moves:
  1. **There *is* a repopulation path, and the report missed it.**
     `initializeVersionedPlugins` Step 2 (`:721`) calls `migrateFromEnabledPlugins()`
     (`:1048`), which iterates `enabledPlugins` across `userSettings`,
     `projectSettings` and `localSettings` and rebuilds `installed_plugins.json`
     from the marketplace. On the launch immediately after corruption it is
     skipped — `readInstalledPluginsFileRaw()` at `:1058` sits outside a try, so
     it throws and `initializeVersionedPlugins`'s catch at `:722` swallows it —
     but once anything has written the empty document, the file parses again,
     `allPluginsExist` is false, and the rebuild runs. So "**permanently** erasing
     the record of every install" is **not** the outcome. The correct statement is:
     one session reports zero plugins, and the record is restored at the next
     launch for every plugin that has an `enabledPlugins` entry.
  2. **But there is an escalation the report missed, and it is worse than what it
     claimed.** `src/utils/plugins/cacheUtils.ts:136` `getInstalledVersionPaths()`
     calls `loadInstalledPluginsFromDisk()` — which, because of the very catch-all
     in this finding, *does not throw*; it returns the empty map. So the function
     returns an **empty `Set`, not `null`**, and its caller
     `cleanupOrphanedPluginVersionsInBackground` (`:74`) treats **every cached
     plugin version** as orphaned, writes `.orphaned_at` markers, and
     `rm -rf`s each one after `CLEANUP_AGE_MS` (7 days). The degrade-to-empty
     therefore reaches past the metadata and destroys the plugin payloads. The
     `null` return path at `:143` exists precisely to prevent this and the
     catch-all defeats it.
  3. Two further truncating writes of the same file the report did not list:
     `:159` (inside `migrateToSinglePluginFile`, the V1→V2 migration) and `:570`.
     Both use the same helper.
  4. *Branch-new?* No — `git diff main...HEAD -- src/utils/plugins/installedPluginsManager.ts`
     is empty; the file is byte-identical on `main`.
- **True consequence**: A crash or power loss during the registry write costs one
  session's plugin visibility, and the record is rebuilt on a later launch from
  `enabledPlugins`. If the machine is not relaunched for a week, or a plugin has
  no `enabledPlugins` entry, the orphan sweeper deletes the cached versions
  outright. Concurrent installs silently drop the earlier one.
- **Evidence**: `installedPluginsManager.ts:259-277,353-362,378,1048-1085`;
  `slowOperations.ts:204,262-277`; `cacheUtils.ts:74,136-145,160-175`.
- **Disposition**: Take the report's fix (switch to
  `writeFileSyncAndFlush_DEPRECATED`, add the settings-style lock, and stop
  degrading a *parse failure* to empty — distinguish it from ENOENT the way
  `settings.ts:544-548` does) and **add one line to it**: make
  `getInstalledVersionPaths` return `null` on a degraded load, or have the load
  path signal `corrupt` distinctly, so the orphan sweeper fails closed. Without
  that, fixing atomicity still leaves the 7-day deletion reachable through any
  other cause of an unparseable file (a hand edit, a disk-full write).

### (unlabelled MED) — Two near-identically-named write helpers have opposite atomicity guarantees

- **Verdict**: PARTIALLY CONFIRMED — the core is exactly right; one cited call
  site is mischaracterised and the genuinely dangerous callers are missing.
- **Cited location holds?**: Yes. `src/utils/slowOperations.ts:248`
  `writeFileSync_DEPRECATED(path, data, { flush: true })` is truncate-in-place +
  fsync; `src/utils/file.ts:362` `writeFileSyncAndFlush_DEPRECATED` is
  temp + flush + rename with symlink resolution and mode preservation
  (`file.ts:371-400`). The report's observation that the name mentioning "Flush"
  is the *atomic* one, while the one you must pass `{flush:true}` to is the
  *non-atomic* one, is accurate and is a genuinely good catch.
- **Reachable in production?**: Yes; both helpers are on live paths.
- **Counter-arguments considered / corrections**:
  - **`src/main.tsx:471` is mischaracterised.** The report calls it "a settings
    file during migration, which is not benign". It is neither. Reading
    `:463-471`: it writes `generateTempFilePath('claude-settings', '.json', { contentHash })`
    — a content-hashed **temp** file for inline `--settings <json>` / SDK inline
    settings, deliberately content-addressed so the path is stable across
    subprocesses for prompt-cache reasons. It is exactly as throwaway as the
    `startupProfiler.ts:137` and `export.tsx:63` cases the report correctly calls
    benign. This sub-claim is INVALID.
  - **Five callers that *are* non-benign were missed**, all writing durable state
    through the truncating helper: `src/utils/plugins/marketplaceManager.ts:346`
    (marketplace config) and `:1346` (marketplace cache);
    `src/utils/plugins/installedPluginsManager.ts:159` and `:570`; and
    `src/utils/secureStorage/plainTextStorage.ts:57` — the **plaintext credential
    store**. That last one is the strongest instance of the report's own thesis
    and it is missing from both the finding and the classification table.
  - `src/utils/nativeInstaller/pidLock.ts:218` uses the truncating helper but
    writes to a temp path and renames (`:222`), with cleanup on failure — a
    correct use, worth not flagging.
- **True consequence**: As claimed for the plugin registry; additionally the
  marketplace config/cache and the plaintext credential store are truncate-in-place.
- **Evidence**: `rg -n "writeFileSync_DEPRECATED" src/ --glob '!*.test.*'`;
  `main.tsx:463-471`; `plainTextStorage.ts:44-62`; `pidLock.ts:205-231`.
- **Disposition**: Take the rename (`writeFileSyncTruncating_DEPRECATED` /
  `writeFileSyncAtomic_DEPRECATED`) — it is cheap and it is the actual root cause
  of F4. Do **not** take the alternative the report offers ("delete the `flush`
  branch of the former and make every durable-state caller use the atomic one")
  as a single sweep: `pidLock.ts:218` and `main.tsx:471` are correct as they
  stand and would be churned for nothing. Convert the five durable-state callers
  named above, leave the temp-file callers alone.

### (unlabelled MED) — Eleven independent hand-rolled copies of `atomicWriteJson`, three of which drop a guarantee

- **Verdict**: CONFIRMED
- **Cited location holds?**: All eleven verified individually.
  With dir-fsync: `deferredContinuation.ts:330` (also `O_EXCL | O_NOFOLLOW`, mode
  `0o600` at open, `chmod 0o600` after rename — the strongest, as claimed),
  `codexTokenRefresh.ts:926`, `app/host/registry.ts:1032`. Without dir-fsync:
  `app/main/transcriptCache.ts:275`, `app/sidecar/sessionsCatalogCache.ts:54`,
  `app/main/devHarness.ts:348`. Without fsync at all:
  `codexAccountPool.ts:762`, `claudeAccountPool.ts:600`,
  `src/agent-mode/sessionState.ts:240` (temp + rename, no sync),
  `src/services/mcp/config.ts:105` (temp + `datasync` + rename — so this one *does*
  fsync the file; it belongs in the "no dir-fsync" tier, a minor misfiling).
  With symlink/mode preservation: `file.ts:362` only. The comment at
  `app/host/registry.ts:1027-1030` does cite `codexTokenRefresh.ts:913-952` as
  its source.
- **Reachable in production?**: n/a — this is a quality finding, and the cost it
  claims (F1's missing mode) is independently confirmed.
- **Trigger**: The `devHarness.ts:348` temp-file leak is real and I confirmed it
  by direct comparison: `registry.ts`, `transcriptCache.ts` and
  `sessionsCatalogCache.ts` all `unlinkSync(tmpPath)` in their catch;
  `atomicWriteJson0600` has only `closeSync(fd)` in a `finally` and then
  `renameSync` outside the try, so a failed `writeFileSync`/`fsyncSync` leaves
  `.<timestamp>.<pid>.tmp` behind forever.
- **Counter-arguments considered**: I checked whether any of the eleven is a
  re-export or wrapper rather than a copy — none is; they are eleven independent
  bodies. I also checked whether `app/shared/` already has one to collapse into —
  it does not.
- **True consequence**: As claimed. The header's "three of which drop a
  guarantee" undercounts its own body (four tiers, five copies missing fsync,
  three missing dir-fsync); harmless.
- **Evidence**: the eleven sites above, read individually.
- **Disposition**: Take the fix as written, and sequence it **before** F1's mode
  fix rather than after — exporting `codexTokenRefresh.ts`'s copy and pointing
  both account pools at it fixes F1's write-side mode, its missing fsync, and its
  missing dir-fsync in one change, instead of hand-patching `{mode: 0o600}` onto
  four call sites. The `app/`-local collapse (D7) is independent and can land
  separately.

### F6 — [MED] `.cat-code/scheduled_tasks.json` is a lock-free read-modify-write of the whole file

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `writeCronTasks` is at
  `src/utils/cronTasks.ts:165` with `await writeFile(getCronFilePath(root), …)`
  at `:177` (the table says `:176`). `addCronTask`'s read-modify-write is at
  `:215-217`, `removeCronTasks`' at `:244-247`, `markCronTasksFired`'s at
  `:268-277`. The doc comment at `:222` does say "No-op if none match (e.g.
  another session raced us)".
- **Reachable in production?**: Yes, with one qualification the report does not
  state: the mutating entry points are the `CronCreateTool` / `CronDeleteTool`
  agent tools, registered at `src/tools.ts:34-40` behind
  `feature('AGENT_TRIGGERS')`. That name **is** in
  `scripts/build.ts:15 fullExperimentalFeatures`, so it is live under
  `bun run build:dev:full` (the operator's build) and absent from a plain
  `bun run build`. `cronScheduler.ts:218` also calls `removeCronTasks` on
  fire-once cleanup.
- **Trigger**: Exactly the interleaving described. Session A `addCronTask` reads
  `[t1]`; session B `removeCronTasks(['t1'])` reads `[t1]`, writes `[]`; A writes
  `[t1, t2]` — `t1` resurrected and it will fire. This repo runs several sessions
  per project by design, and the tools are agent-invocable, so two agents
  scheduling and deleting concurrently is ordinary.
- **Counter-arguments considered**: (a) *Is there a scheduler lock?* Yes, but only
  for the fire path — `markCronTasksFired`'s doc comment says "Scheduler lock
  means at most one process calls this". It does not cover `addCronTask` or
  `removeCronTasks`, which are the ones the report races. (b) *Does the session
  store absorb it?* `removeCronTasks:238-240` short-circuits when every id lives
  in the in-memory session store, but durable tasks by definition do not.
  (c) *Branch-new?* No — `git diff main...HEAD -- src/utils/cronTasks.ts` is empty.
- **True consequence**: A deleted durable task is resurrected and fires, or a
  newly created one is lost; a crash mid-`writeFile` truncates the schedule and
  every durable task silently disappears.
- **Evidence**: `cronTasks.ts:165-177,215-217,222,238-247,268-277`;
  `src/tools.ts:34-40`; `scripts/build.ts:15`.
- **Disposition**: Take the fix as written (`lockfile.lock` around the
  read-modify-write, mirroring `tasks.ts:288-296`, plus temp+rename). Scope note:
  the lock must be on the *file*, and `markCronTasksFired` should join it rather
  than rely on the scheduler lock, so all three mutators serialise on one thing.

### F7 — [MED] Task store writes are locked but not atomic

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `createTask` holds `lockfile.lock(lockPath, LOCK_OPTIONS)`
  at `src/utils/tasks.ts:293` across `findHighestTaskId` and the write at `:300`.
  `updateTask` at `:370` acquires `lockfile.lock(path, …)` at `:386` and delegates
  to `updateTaskUnsafe`, whose write is at `:365`. All three writes are plain
  `await writeFile(path, jsonStringify(...))`. `writeHighWaterMark`'s write is at
  `:130`. `getTask:322` does `TaskSchema().safeParse` and returns `null` on
  failure, as claimed.
- **Reachable in production?**: Yes — `isTodoV2Enabled()` (`:133`) returns true
  for any interactive session, no feature flag.
- **Trigger**: A crash between `O_TRUNC` and the write leaves a zero/partial task
  file; `getTask` then returns `null` after a debug-level log and the task
  vanishes from the list.
- **Counter-arguments considered**: (a) *Does the lock cover the crash case?* No,
  and the report says so correctly — `proper-lockfile` protects against a
  concurrent writer, not against the process dying mid-write. (b) *Is
  `updateTaskUnsafe` an unlocked back door?* It is exported and reachable, but it
  exists to be called under a held lock, which the report states accurately.
  (c) **One thing the report understates**: `writeHighWaterMark` at `:130` is
  called from `deleteTask:396-400` **outside any lock**, so the high-water mark is
  both unlocked and non-atomic — which is exactly the value the report says
  `findHighestTaskId` may reuse an id from. (d) *Branch-new?* No — file identical
  on `main`.
- **True consequence**: As claimed, plus id reuse via a torn or lost high-water
  mark.
- **Evidence**: `tasks.ts:125-131,285-306,322,355-368,370-391,393-401`.
- **Disposition**: Take the report's fix (temp+rename inside the existing lock),
  and extend it to `writeHighWaterMark` — the report says "three call sites, no
  new locking needed", but the high-water-mark site *does* need the lock, since
  `deleteTask` currently writes it unprotected.

### F11 — [LOW] `resolved/<id>.json` is written non-atomically and read with no lock

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. The write is
  `src/utils/swarm/permissionSync.ts:421-425` (`await writeFile(resolvedPath, …)`)
  under the pending-dir lock; the read is `readResolvedPermission` at `:323-335`
  with `readFile` + `safeParse` and no lock.
- **Reachable in production?**: Yes for swarm sessions (no feature gate on the
  module).
- **Trigger**: The polling worker reads between `O_TRUNC` and the write, the
  `safeParse` fails, and the caller reads it as "not resolved yet".
- **Counter-arguments considered**: The self-healing the report already concedes
  (next poll re-reads) is the correct reason this is LOW and not MED. I checked
  whether the leader's lock covers the read — it does not; different lock
  (pending dir vs resolved file), as claimed. Not branch-new: `resolvePermission`
  exists on `main` at the same shape (`git show main:…permissionSync.ts` has the
  identical `await writeFile(resolvedPath, …)` at `:420`).
- **True consequence**: One wasted poll; a crash mid-write leaves a permanently
  unparseable resolution after the pending file has been consumed.
- **Evidence**: `permissionSync.ts:323-335,408-431`.
- **Disposition**: Take the fix as written (temp+rename on the resolved write).

### F12 — [LOW] Peer registry files are truncated in place while other processes read them

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes — `registerSession`'s `await writeFile(pidFile, …)`
  is at `src/utils/concurrentSessions.ts:76` (table says `:77`, which is the
  first argument line) and `updatePidFile`'s read-modify-write at `:120-124`.
  `onSessionSwitch(id => void updatePidFile({sessionId: id}))` is at `:99`.
- **Reachable in production?**: Yes. This is the one I most expected to refute,
  because the module is riddled with `feature('BG_SESSIONS')` gates (`:32`, `:86`,
  `:89`, `:159`) and `BG_SESSIONS` is in **neither** of `scripts/build.ts`'s
  lists. But `registerSession` itself is **not** gated — it is called
  unconditionally from `src/main.tsx:2631`, and the `onSessionSwitch` registration
  at `:99` is inside its ungated body. Only `updateSessionActivity` (`:159`) is
  dead, and the report does not cite it.
- **Trigger**: `/resume` fires `updatePidFile`; a peer's `readdir`+parse
  enumeration lands mid-write and drops that session for one poll.
- **Counter-arguments considered**: single-writer-per-file (keyed on the owner's
  own pid) means there is genuinely no lost-update, which the report states
  correctly. Not branch-new: file identical on `main`.
- **True consequence**: Cosmetic and transient, exactly as claimed.
- **Evidence**: `concurrentSessions.ts:31-38,59-107,118-128,158-160`;
  `main.tsx:2631`; `scripts/build.ts:13-49`.
- **Disposition**: Take the one-line temp+rename fix.

### F13 — [LOW] `immediateFlushHistory` drops the pending buffer when the append fails

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, to the line. `src/history.ts:317` is
  `pendingEntries = []`; `:319` is `await appendFile(historyPath, jsonLines.join(''), { mode: 0o600 })`;
  the catch is at `:320-322`.
- **Reachable in production?**: Yes, ungated; `flushPromptHistory(retries)` at
  `:329` is the retry wrapper the report cites.
- **Trigger**: A transient EIO/ENOSPC on `~/.cat-code/history.jsonl`.
- **Counter-arguments considered**: I checked whether the clear happens after a
  point of no return that would make it correct — it does not; the `lock()` call
  precedes it (`:298`), so a lock failure leaves the buffer intact and only an
  `appendFile` failure loses it. That narrows the window but the report's claim is
  precisely about `appendFile`. Not branch-new: file identical on `main`.
- **True consequence**: One batch of prompt history lost silently, as claimed.
- **Evidence**: `history.ts:292-326`.
- **Disposition**: Take the fix (move the clear after a successful append). Prefer
  restoring in the catch over moving the clear, so a concurrent `addToHistory`
  during the await is not double-written.

### F14 — [LOW] `saveConfig` (the unlocked twin of `saveConfigWithLock`) is still on two live paths

- **Verdict**: **OVERSTATED**
- **Cited location holds?**: Partly. `saveConfig` is defined at
  `src/utils/config.ts:1151` (the report says `:1151` in the finding and `:1169`
  in the table — `:1168` is the `writeFileSyncAndFlush_DEPRECATED` inside it).
  `saveConfigWithLock` is at `:1188`. The four call sites `:847`, `:898`, `:1676`,
  `:1730` are correct.
- **Reachable in production?**: Yes, but only on an error path.
- **Trigger / why the finding does not stand as written**: `:898` and `:1730` are
  not a second, casually-unlocked writer sitting beside the locked one. Both are
  inside the `catch` block for a **failed** `saveConfigWithLock` — read
  `:868-899` and `:1699-1731`. The code already says everything the report asks
  for: "Fall back to non-locked version on error. This fallback is a race window:
  if another process is mid-write (or the file got truncated), getConfig returns
  defaults. Refuse to write those over a good cached config to avoid wiping auth.
  See GH #3117." And both fallbacks run `wouldLoseAuthState(currentConfig)` first
  and bail with `logEvent('tengu_config_auth_loss_prevented')` rather than write.
- **Counter-arguments considered**: I looked for a *non*-error caller of
  `saveConfig` that would vindicate the finding — `rg` finds only these two, both
  in catch blocks. I also considered whether the fallback could be reached
  routinely (making the "race window" comment a fig leaf): it requires
  `saveConfigWithLock` to throw, which means lock acquisition or the write itself
  failed, not ordinary operation.
- **True consequence**: When the config lock cannot be taken at all, the process
  writes unlocked rather than losing the user's change — a deliberate
  availability-over-consistency trade, with the dangerous half (auth loss)
  explicitly guarded.
- **Evidence**: `config.ts:836-900,1151-1186,1188-1260,1676-1732`.
- **Disposition**: **Do not apply the report's fix.** It proposes "otherwise use
  `saveConfigWithLock`" — inside the catch handler *for* `saveConfigWithLock`,
  which would either recurse into the call that just threw or drop the user's
  change entirely. Its other branch ("if the lock is held by the caller, say so in
  a comment") is already satisfied: the comments exist at `:872-876` and
  `:1705-1706`. No change. If anything is worth doing here it is raising the
  fallback's log from debug to a user-visible warning, which is a different
  finding.

### F15 — [LOW] `writeTeamFile` is dead

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes — `src/utils/swarm/teamHelpers.ts:232`
  `function writeTeamFile(teamName, teamFile): void`, not exported.
- **Reachable in production?**: No. `rg 'writeTeamFile'` across `src/` and `app/`
  returns the definition plus only `writeTeamFileAsync` hits
  (`TeamCreateTool.ts:206`, `transactTeamFile:381`, and tests), plus one prose
  mention in a comment at `teamHelpers.ts:1086` ("Call this right after the
  initial writeTeamFile") which is itself stale.
- **Counter-arguments considered**: I checked for dynamic access
  (`require`/bracket lookup) — none; the function is module-private, so a caller
  could not exist outside the file. Not branch-new: present on `main` at `:166`.
- **True consequence**: Dead code that models the wrong discipline next to
  `transactTeamFile`'s correct one.
- **Evidence**: `rg -n "writeTeamFile" src/ app/`; `teamHelpers.ts:228-248,375-395`.
- **Disposition**: Delete it, and fix the stale comment at `:1086` in the same
  edit — otherwise the reference-sweep leaves a dangling name.

---

### D1 — [HIGH] The desktop context donut divides by a different window than everything that acts on context

- **Verdict**: CONFIRMED. (Per the brief, I checked only the **desktop** divisor
  and the arithmetic; the engine-side denominators are another verifier's scope.)
- **Cited location holds?**: Yes. `app/renderer/src/contextUsage.ts:376-380`:

  ```ts
  if (contextWindow <= 0) contextWindow = DEFAULT_CONTEXT_WINDOW
  const percentUsed = Math.min(100, Math.max(0, Math.round((usedTokens / contextWindow) * 100)))
  ```

  where `contextWindow` is the **raw** window — either the result frame's
  `modelUsage[model].contextWindow` or `modelContextWindow`, which
  `app/sidecar/runControlsDomain.ts:573` resolves with
  `getContextWindowForModel(model, getSdkBetas())`. Neither the max-output
  reservation nor `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is applied anywhere on the
  desktop path. Engine side, `src/services/compact/autoCompact.ts:40-56` is
  `getEffectiveContextWindowSize = min(rawWindow, CLAUDE_CODE_AUTO_COMPACT_WINDOW?) − min(getMaxOutputTokensForModel(model), 20_000)`,
  and `src/components/StatusLine.tsx:51` feeds exactly that into
  `calculateContextPercentages`, surfacing at `:100-102` as
  `context_window_size` / `used_percentage`.
- **Reachable in production?**: Yes — this is the ordinary render path of the
  context donut, no gate.
- **Trigger / arithmetic**: The report claims 100% (terminal) vs 90% (desktop) at
  180k used on a 200k model with ≥20k max output. **That arithmetic is correct**:
  effective = 200 000 − 20 000 = 180 000; 180 000/180 000 = 100%;
  180 000/200 000 = 90%. A 10-point gap at that point.

  Note for the brief: **there is no "8-percentage-point" figure in X02a** — the
  only figures it states are 100 vs 90. For completeness I computed the gap at the
  point that is actually reachable, the auto-compact threshold. With
  `MANUAL_COMPACT_BUFFER_TOKENS = 3_000` (`autoCompact.ts:72`),
  `AUTOCOMPACT_RECOVERY_WINDOW_PERCENTAGE = 0.08` (`:75`) and
  `AUTOCOMPACT_BUFFER_TOKENS = 13_000` (`:69`), the recovery window is
  `clamp(0.08 × 180 000 = 14 400, 10 000, 50 000) = 14 400`, so
  `getAutoCompactThreshold = 180 000 − 3 000 − 14 400 = 162 600`. There the
  terminal reads 90.3% and the donut 81.3% — a **~9-point** gap. So the report's
  parenthetical "auto-compact fires" *at 180k* is imprecise (it fires at 162.6k),
  but that imprecision runs against the report's own interest.
- **Counter-arguments considered**: (a) *Is the raw window defensible as a
  deliberate choice?* `contextUsage.ts:57-64` does argue for it by citing the
  don't-re-derive rule, and the breakdown page legitimately matches
  `analyzeContext.ts`'s raw denominator — so the *value on the wire* is fine. The
  defect is that `percentUsed` and `pressureTone` are computed from it. (b) *Does
  `tokenWarning` already close the gap?* No — and `app/renderer/src/tokenWarning.ts:42-46`
  says so in its own words: "the denominator is `getEffectiveContextWindowSize`
  (`autoCompact.ts:40`), which differs from the gauge's `contextWindow`". The
  report's "the tell" is verbatim accurate. `tokenWarning` is a *separate* glyph
  fed by sidecar-supplied thresholds; it does not correct the donut.
  (c) *Is `pressureTone` really unreachable?* Verified stronger than the report
  states: `pressureTone` (`contextUsage.ts:103-107`) returns `danger` at ≥90,
  which needs ≥180 000 used — but `getBlockingLimit` (`autoCompact.ts:232-234`) is
  `180 000 − 3 000 = 177 000`, at which the engine blocks the request outright. So
  the red band is not merely late, it is **unreachable in normal operation**;
  the donut's ceiling colour is dead UI.
- **True consequence**: The donut systematically under-reports pressure by ~9-10
  points at the moment that matters, its `warn` band arrives late, its `danger`
  band never arrives, and under `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000` it reads
  40% at the instant the engine compacts.
- **Evidence**: `contextUsage.ts:57-64,103-107,368-381`;
  `runControlsDomain.ts:568-577`; `autoCompact.ts:36-56,69-76,193-234`;
  `StatusLine.tsx:50-52,98-103`; `tokenWarning.ts:26-46`.
- **Disposition**: Take the report's fix, with one addition. Put the effective
  window on `RunControlsSnapshot.model` beside the raw one and divide `percentUsed`
  by it; keep the raw window on the wire for the breakdown page. Additionally,
  re-base `pressureTone`'s thresholds once the denominator changes — at 90/70
  against the *effective* window the danger band still sits above the blocking
  limit, so it should key off the engine's own compact threshold rather than a
  fixed percentage.

### D2 — [MED] The sidecar's queue drain runs one turn per queued prompt where the engine runs one turn for all of them

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: Yes for the main claim.
  `src/utils/queueProcessor.ts:76-80` is
  `dequeueAllMatching(cmd => isMainThread(cmd) && !isSlashCommand(cmd) && cmd.mode === targetMode)`
  followed by one `void executeInput(commands)`.
  `app/sidecar/sidecarServer.ts:1142` is `const command = dequeue(isDeliverableParentPrompt)`
  — singular — and `:1160` is `generateTitle: true`, both as claimed. The false
  citation is real: `sidecarServer.ts:1123-1125` says the path works "exactly as
  the terminal REPL's between-turn processor does (`src/hooks/useQueueProcessor.ts:48-60`)",
  and that hook's effect body (`useQueueProcessor.ts:48-61`) is a single
  `processQueueIfReady({ executeInput: executeQueuedInput })` call — i.e. the
  batching one. The cited parity does not hold.
- **Reachable in production?**: Yes. `drainOneQueuedPrompt` is the documented
  fallback for a prompt queued into a turn that ends without another tool round.
- **Trigger**: Three follow-ups typed during a running turn. Terminal: one turn
  with three user messages. Desktop: three sequential turns, each with
  `generateTitle: true`.
- **Counter-arguments considered — and where the finding narrows**: the report's
  second half ("`isDeliverableParentPrompt` filters only on `mode === 'prompt'`
  and has no slash-command carve-out, where `processQueueIfReady:69-73`
  deliberately isolates slash and bash commands") **is not a divergence in
  outcome**. `processQueueIfReady`'s carve-out exists to stop a slash or bash
  command being *batched* with ordinary prompts — read the comment at `:70-71`:
  "Slash commands and bash-mode commands are processed individually." The sidecar
  never batches anything, so it already processes them individually. The report's
  own "Not reviewed" section hedges this ("I did not trace whether the desktop
  composer routes `/foo` through `enqueue`"), and on inspection the hedge should
  have been a retraction: whichever way the composer routes them, one-at-a-time is
  what the carve-out achieves. I also checked `isSlashCommand`
  (`src/utils/messageQueueManager.ts:594-600`) to be sure a slash command is not a
  distinct `mode` the sidecar filter would miss — it is a `value.startsWith('/')`
  test over any mode, confirming the point.
- **True consequence**: Extra turns and extra cost, plus the semantic difference
  the report describes (prompt 2 answered by a model that has already acted on
  prompt 1). The slash-command half adds nothing.
- **Evidence**: `sidecarServer.ts:1119-1183,3430-3440`;
  `queueProcessor.ts:52-82`; `useQueueProcessor.ts:48-61`;
  `messageQueueManager.ts:594-600`.
- **Disposition**: The report offers two options and the **second** is the one to
  take: state at `sidecarServer.ts:1122` that one-turn-per-prompt is the desktop's
  deliberate policy and delete the false `useQueueProcessor.ts:48-60` citation.
  Routing through `processQueueIfReady` (option one) means giving the sidecar an
  `executeInput` that maps a batch onto a single `startTurn`, which the current
  `startTurn` signature (`prompt: string`) cannot express without a protocol-level
  change to how a turn carries multiple user messages — too large a change for the
  benefit, and it collides with the per-prompt `onInputPersisted` / retry ledger
  at `:1150-1178`. Drop the slash-command sub-claim entirely.

### D3 — [MED] The settings screen attributes each key to one source, but the engine deep-merges and unions arrays across sources

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `app/sidecar/settingsDomain.ts:197-205` is the
  `seen` set and the `resolved.push({key, source, …})`; the walk is high→low from
  `:179`. Engine side, `src/utils/settings/settings.ts:764,825,864` all call
  `mergeWith(mergedSettings, …, settingsMergeCustomizer)`, and
  `settings.ts:629-631` `mergeArrays` is `uniq([...targetArray, ...sourceArray])`
  — concatenate and dedupe, exactly as claimed. The CC-13 comment the report
  quotes is at `:171-176` and says precisely what the report says it says.
- **Reachable in production?**: Yes, and I found the render site the report did
  not name: `app/renderer/src/sessionInspectorState.ts:209` `selectEffectiveSettingRows`
  ("Every top-level key this session resolved, with its winning layer"), consumed
  at `app/renderer/src/MetadataInspector.tsx:420`. `selectFlagLayer`'s
  `winningKeys` (`sessionInspectorState.ts:270-272`) has the same defect.
- **Trigger**: `permissions.allow` is an array. `Bash(git:*)` in
  `~/.claude/settings.json` and `Read(**)` in `.claude/settings.local.json` are
  **both** live per `mergeArrays`, but the effective-settings row for
  `permissions` names only `localSettings`.
- **Counter-arguments considered — this is where I expected to break it, and
  could only narrow it**: the sidecar emits a **second** projection,
  `editableValues` (`settingsDomain.ts:186-195`), which is explicitly **not**
  gated on `seen` — the comment at `:159-168` says "a key set at two layers needs
  an entry for EACH, not just the winner's". And the renderer's scope model
  (`app/renderer/src/settingsScope.ts:630-660`) is layer-relative: it shows *this*
  layer's own value and annotates that a higher layer wins, "never guessed at from
  the winner". So **the settings editor rows are not misattributed** — the report's
  phrase "the settings screen tells the operator their user-level permission rules
  are overridden" overshoots if read as the editor. What *is* misattributed is the
  effective-settings row list in the metadata inspector and the flag layer's
  winning-keys list. `permissions` is not in `EDITABLE_SETTING_KEYS`
  (`app/shared/settingsEditable.ts:321`), so it appears only in `resolved` — i.e.
  only in the surface that is wrong.
- **True consequence**: The metadata inspector's "effective settings" list names
  one owning layer per top-level key, which is wrong for every array-valued and
  deep-merged key (`permissions`, `hooks`, `env`). The editor is unaffected.
- **Evidence**: `settingsDomain.ts:156-212`; `settings.ts:629-645,764,825,864`;
  `sessionInspectorState.ts:205-232,262-274`; `MetadataInspector.tsx:420`;
  `settingsScope.ts:615-665`; `settingsEditable.ts:321`.
- **Disposition**: Take the report's fix — ship `getSettingsWithSources()`'s
  `effective` on the snapshot and let the renderer diff a layer's own keys against
  it — but scope the change to `selectEffectiveSettingRows` and `selectFlagLayer`.
  Do **not** touch `settingsScope.ts`; it is already correct and is the one place
  in this subsystem that got the layering right.

### D4 — [MED] Four independent encodings of the setting-source precedence order

- **Verdict**: CONFIRMED, including its own hedge.
- **Cited location holds?**: Yes, all five sites.
  `src/utils/settings/constants.ts:6-22` `SETTING_SOURCES` ascending;
  `:159-167` `getEnabledSettingSources()` building a `Set` from
  `getAllowedSettingSources()` then `.add('policySettings')` **then**
  `.add('flagSettings')` — so policy is appended before flag, exactly as the
  sidecar's comment asserts; `app/sidecar/settingsDomain.ts:372`
  (`for (const source of SETTING_SOURCES)` + `isSettingSourceEnabled`);
  `app/renderer/src/settingsState.ts:145-152` `SETTING_SOURCE_PRECEDENCE`, a
  hand-typed descending literal; `app/renderer/src/settingsScope.ts:554-557`
  `rank()` consuming it; `app/shared/protocol.ts:674-687` redeclaring the union
  with a comment explaining the P0-3 isolation idiom.
- **Reachable in production?**: The *stale-literal* cost is live today. The
  *order divergence* is latent, exactly as the report says.
- **Trigger**: `--setting-sources user,project` makes the engine's `Set` order
  `user, project, policy, flag` — flag last, so flag beats enterprise policy —
  while the sidecar keeps `SETTING_SOURCES` order with policy last.
- **Counter-arguments considered**: I confirmed the default makes the two
  identical (with the full canonical `allowedSettingSources`, the two `.add`
  calls are no-ops and `Set` insertion order is unchanged). I also closed the
  report's own open question about whether the desktop can pass the flag:
  `app/renderer/src/sessionInspectorState.ts:255-259` records that "the app spawns
  each sidecar as `bun run <sidecarEntry>` with no engine arguments at all
  (`app/main/main.ts:477`)". So latent, not live — the report's hedge was correct
  and can now be closed.
- **True consequence**: Reordering `SETTING_SOURCES` silently desynchronises the
  renderer's hand-typed literal, with no test and no type binding the two. The
  flag-vs-policy inversion is a real engine bug but unreachable from the desktop.
- **Evidence**: the five sites above; `bootstrap/state.ts:328-334`.
- **Disposition**: Take the first half of the fix (derive the renderer's order
  from the shared ascending constant). The second half — "decide whether flag or
  policy wins and fix `getEnabledSettingSources`" — is an **engine** change with
  enterprise-policy semantics attached; it does not belong to whoever fixes the
  renderer literal, and should be filed separately rather than bundled.

### D5 — [MED] `readyCount` re-derives account availability while the authoritative answer sits three lines above it

- **Verdict**: CONFIRMED, precisely as written.
- **Cited location holds?**: Yes. `app/sidecar/accountsDomain.ts:456-458` is
  `poolStatus.accounts.filter(a => a.status === 'healthy' && a.usageLimitReached !== true)`;
  `:470-472` is the Anthropic counter on `status === 'healthy'` alone;
  `buildAccountStatus` at `:383-388` already computes
  `const availability = getCodexAccountAvailability(account, now).kind` and puts
  it on the wire at `:394`. `src/services/api/codexAccountPool.ts:1544-1571` is
  `getCodexAccountAvailability`, and `describeCodexAccountAvailabilityLabel:1592-1596`
  is literally `if (availability.kind !== 'blocked') return 'Ready'` — so the
  engine's rule *is* what the UI word means.
- **Reachable in production?**: Yes, ungated; this drives the accounts badge.
- **Trigger**: Both directions verified against the engine function.
  **Overcount**: `status: 'healthy'` + `hasFreshPoolAccountUsageHint` +
  `usageAllowed === false` → `blocked` per `:1560-1568`, but `usageAllowed` is a
  different field from `usageLimitReached`, so the badge counts it ready and the
  pool will never lease it. **Undercount**: a `capped` account whose hard-429
  belief has elapsed (`:1551-1556`) or a `usageLimitReached` account past
  `isQuotaObservationResetElapsed` (`:1565`) is `available` to the engine but is
  not `'healthy'`, so the badge says 0 ready while turns run.
- **Counter-arguments considered**: (a) *Is `availability` actually on the wire?*
  Yes — `buildAccountStatus` returns it as a named field, so the fix is a
  one-line change with no new plumbing. (b) *Could `status === 'healthy'` be a
  superset that happens to coincide?* No: `getCodexAccountAvailability` reads
  `status`, the hard-429 belief, the usage hint and the plan-metadata warnings —
  four inputs, two of which the badge never looks at. (c) *Is the Anthropic
  counter defensible because there is no Anthropic availability concept?* That is
  true and the report says so ("cruder still"), so it is correctly scoped as an
  observation rather than a fix target.
- **True consequence**: The "Ready" badge disagrees with the pool in both
  directions, using the word the engine defines.
- **Evidence**: `accountsDomain.ts:383-400,450-476`;
  `codexAccountPool.ts:1544-1596`.
- **Disposition**: Take the fix as written, and prefer its **second** form —
  count the `availability` field `buildAccountStatus` already produced — over
  re-calling `getCodexAccountAvailability`, so the badge and the per-row label can
  never disagree with each other even if `now` drifts between the two calls.

### D6 — [MED] The backfill worker reads whole transcripts into memory where the engine reads bounded 64 KB windows

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `app/sidecar/transcriptRunFacts.ts:76` is
  `lines = readFileSync(path, 'utf8').split('\n')` with no `statSync` gate. The
  engine equivalents are `src/utils/sessionStoragePortable.ts:209-231` (head+tail,
  `LITE_READ_BUF_SIZE = 65536`) and `src/utils/sessionStorage.ts:3234`
  `readFileTailSync`. The sibling that does it right is
  `app/main/transcriptCache.ts:325`, which checks
  `statSync(filePath).size > MAX_TRANSCRIPT_CACHE_BYTES` **before** the read.
- **Reachable in production?**: Yes — the catalog backfill worker at app launch.
- **Trigger**: The backward scan's early exit (`:117-124`) requires all five facts
  including `facts.effort`, and `effort` is only ever set from a
  `system`/`codex_send_path` record (`:107-109`). An Anthropic-provider session
  never writes one, so `facts.effort` stays null and the loop runs to line 0 —
  full read plus `JSON.parse` of every record. I checked whether the `run_facts`
  snapshot rescues it: it does not. The snapshot is applied *after* the loop
  (`:130`), and the loop's break condition does not consult it, so even a session
  that has a `run_facts` record still scans to the beginning. That makes the
  finding slightly stronger than stated. Multiply by
  `MAX_TRANSCRIPT_BACKFILL_SESSIONS = 32` (`app/shared/transcriptBackfill.ts:28`).
- **Counter-arguments considered**: (a) *Is there an upstream size cap?*
  `transcriptBackfill.ts:29` caps the **request** at 256 KB, not the file — the
  report's point. (b) *Is the worker's own process isolation enough?*
  `app/sidecar/sessionsCatalogWorker.ts:1-8` justifies the architecture explicitly
  on RAM grounds, which is what makes an uncapped read notable here rather than
  merely untidy.
- **True consequence**: Roughly twice the file resident per session (string plus
  per-line array), for up to 32 sessions, in the one subsystem whose design is
  justified by RAM.
- **Evidence**: `transcriptRunFacts.ts:64-135`; `transcriptBackfill.ts:28-29`;
  `transcriptCache.ts:310-330`; `sessionStoragePortable.ts:209-231`.
- **Disposition**: Take the fix as written (tail window via `readFileTailSync`
  plus a `statSync` gate on the legacy full-scan fallback). Add: fix the early
  exit so it does not demand a fact the provider never emits — treat `effort` as
  satisfied once the `run_facts` snapshot is found, which the post-loop merge
  already assumes.

### D7 — [LOW] Three copies of the atomic-write helper inside `app/` alone

- **Verdict**: PARTIALLY CONFIRMED — real, miscounted.
- **Cited location holds?**: Yes; and note the heading says "Three" while the
  body correctly lists four (`app/host/registry.ts:1032`,
  `app/main/transcriptCache.ts:275-306`, `app/sidecar/sessionsCatalogCache.ts:54-87`,
  `app/main/devHarness.ts:348-360`).
- **Reachable in production?**: n/a (quality). `devHarness` is dev-only, the other
  three are production paths.
- **Trigger / correction**: "Two of the four drop the directory fsync" is **wrong
  — three of four do.** Only `registry.ts:1058-1065` performs the
  `openSync(dir,'r') + fsyncSync` step; `transcriptCache.ts`,
  `sessionsCatalogCache.ts` **and** `devHarness.ts` all omit it. This contradicts
  the same report's sweep-1 finding, which lists all three correctly, so it is a
  transcription slip rather than a misreading. The `devHarness` temp-file leak is
  confirmed: `atomicWriteJson0600` has `closeSync(fd)` in a `finally` but no
  `unlinkSync(tmp)` on the failure path, and its `renameSync` sits outside the
  `try`.
- **Counter-arguments considered**: I checked whether `app/shared/` may import
  `fs` at all (a shared helper has to live somewhere all four planes can reach) —
  `app/shared/protocol.ts` and siblings are type/pure modules today, so the helper
  would be the first `fs`-touching module there. That is a real design question
  the report skips, not a blocker: `app/host/` is Electron-free and already owns
  `registry.ts`'s copy, so it is the better home.
- **True consequence**: As claimed.
- **Evidence**: the four sites above.
- **Disposition**: Collapse to one helper, but put it in `app/host/` rather than
  `app/shared/` as the report proposes — `app/shared/` is the **wire contract**
  (§6 marks it a versioned-protocol trust boundary), and adding filesystem code to
  it widens what the renderer's type graph pulls in. Include the dir-fsync and the
  temp cleanup in the single copy so all four callers gain both.

---

## Findings the original report missed

Each verified to the same bar as above.

1. **[HIGH, strengthens F3] Two concurrent `removeMessageByUuid` calls undo each
   other's removal.** `src/query.ts:769` yields one tombstone **per** orphaned
   assistant message and `src/screens/REPL.tsx:2964` `void`-calls
   `removeTranscriptMessage` for each without awaiting. Reproduced at 0 and 1 IO
   ticks apart: the second remover truncates to its own stale offset and re-appends
   the tail it read, **restoring the message the first remover just deleted**. This
   is the dominant trigger for F3 — far likelier than the 100 ms flush-timer race
   the report describes — and it is not fixed by the report's proposed
   `await drainWriteQueue()`. Evidence: `scratchpad/v30/f3-race3.ts`.

2. **[HIGH, strengthens F4] The plugin registry's degrade-to-empty reaches the
   orphan sweeper and deletes the plugin cache.**
   `src/utils/plugins/cacheUtils.ts:136` `getInstalledVersionPaths()` calls
   `loadInstalledPluginsFromDisk()`, which *cannot throw* because of F4's
   catch-all — so it returns an empty `Set` rather than the `null` its own error
   path at `:143` was written to return. `cleanupOrphanedPluginVersionsInBackground`
   then marks every cached plugin version `.orphaned_at` and `rm -rf`s it after
   `CLEANUP_AGE_MS` (7 days). A metadata bug becomes payload deletion.

3. **[MED] `~/.cat-code/.credentials.json` is written truncate-in-place and is
   0644 for the duration of the write.**
   `src/utils/secureStorage/plainTextStorage.ts:57` uses
   `writeFileSync_DEPRECATED(..., { flush: false })` — `O_TRUNC` in place — and
   only `chmodSync(storagePath, 0o600)` **afterwards** (`:61`); `mkdirSync(storageDir)`
   at `:52` passes no mode. It is a credential store and belongs in F1's fix and
   F5's caller list. Latent on this machine (the file does not exist; macOS
   keychain wins at `secureStorage/index.ts:11`), hence MED not HIGH.

4. **[LOW] `mcpOutputStorage.ts:158` is misfiled as clean in the classification
   table.** Row 23 groups it with `toolResultStorage.ts:162` (`flag:'wx'`) and
   `pasteStore.ts:48` (`mode: 0o600`) as "content-addressed blobs / immutable".
   `mcpOutputStorage.ts:158` is a bare `await writeFile(filepath, bytes)` — no
   `wx`, no temp+rename — so a crash mid-write leaves a truncated blob at a
   `persistId` a message already references. Low consequence, but it is the one
   row in the table that is labelled clean and is not.

5. **[bookkeeping] The report's own counts.** The header says "6 HIGH · 8 MED · 5
   LOW" (19); the body contains 5 HIGH, 9 MED and 6 LOW (20). And D7's "two of the
   four drop the directory fsync" contradicts the sweep-1 finding in the same
   document, which lists three. Worth correcting before a fixer works from the
   table.

## Verdict counts

| Verdict | Count |
|---|---:|
| CONFIRMED | 14 |
| PARTIALLY CONFIRMED | 4 |
| OVERSTATED | 1 |
| INVALID | 1 |
| DUPLICATE | 0 |
| UNPROVEN | 0 |
| **Total** | **20** |

## Scratch artifacts

All under `…/scratchpad/v30/`, nothing written to the repo:
`feat2.ts` (runtime `feature()` probe), `f1-chmod.ts` (mode durability per writer
shape), `f3-race.ts` / `f3-race2.ts` / `f3-race3.ts` (transcript truncate races,
importing the real `src/utils/sessionStorage.ts`).
