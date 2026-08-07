# X02a — non-atomic persistence and cross-layer duplication

## Verdict

The repo owns four excellent atomic-write implementations and eleven total, and the quality of a given write is decided by which copy its author happened to see. `app/` writes its own files correctly everywhere; every non-atomic write the desktop is exposed to comes from engine modules the sidecar calls into. The single most important thing to fix is not an atomicity bug at all: **the credential vaults create their directories and token files with default permissions, so live Anthropic and OpenAI refresh tokens are sitting at `0644` in a `0755` directory on this machine right now** — verified, not inferred. After that, the ranking is `settingsSync` bypassing the settings lock, `removeMessageByUuid` truncating the transcript past entries its own flush queue just appended, and the plugin registry whose truncating write plus catch-all loader turns one bad shutdown into a silent total uninstall. On the duplication axis the news is better than expected: session resume, session listing, and permission evaluation all delegate to the engine cleanly. The six divergences that remain share one shape — the correct engine function is imported in the same file, and a hand-rolled approximation is used instead a few lines away.

**Counts: 6 HIGH · 8 MED · 5 LOW.**

---

## SWEEP 1 — non-atomic persistence

### Reference implementations (correct, used as the bar)

| Impl | Guarantees |
|---|---|
| `src/services/deferredContinuation.ts:329` `atomicWriteJson` | O_EXCL + O_NOFOLLOW + 0600 + fsync + rename + chmod + dir-sync — strongest in the tree |
| `src/services/api/codexTokenRefresh.ts:926` `atomicWriteJson` | temp(0600) + fsync + rename + dir-fsync |
| `app/host/registry.ts:1030` `atomicWriteJson` | temp(0600) + fsync + rename + dir-fsync |
| `src/utils/file.ts:362` `writeFileSyncAndFlush_DEPRECATED` | temp + flush + rename, preserves symlink + mode |
| `src/services/api/codexAccountPool.ts:761` / `claudeAccountPool.ts:600` | temp + rename (no fsync, **no mode**) |

### Classification table

Legend: **Atomic** = temp+rename. **Locked** = cross-process lock held across the read and the write. **Merge** = whether a concurrent writer's change survives.

| # | Site | State persisted | Atomic | Locked | Merge | Shared by | Sev |
|---|---|---|---|---|---|---|---|
| 1 | `src/services/api/claudeAccountPool.ts:627,653` | Claude OAuth access+refresh tokens (`~/claude-vault/accounts/*.json`) | no (already confirmed) | no | LWW | all engine procs + desktop sidecars | **HIGH** (perm bug is new, see F1) |
| 2 | `src/services/api/codexAccountPool.ts:718,761` | Codex OAuth tokens (`~/codex-vault/…`) | yes | no | LWW | all engine procs + sidecars | **HIGH** (perm bug, F1) |
| 3 | `src/services/settingsSync/index.ts:461` `writeFileForSync` | `~/.claude/settings.json`, `.claude/settings.local.json`, `CLAUDE.md` | **no** | **no** | LWW | all engine procs + sidecar `settingsDomain` | **HIGH** (F2) |
| 4 | `src/utils/sessionStorage.ts:1362,1393` `removeMessageByUuid` | the live transcript `.jsonl` | **no** (ftruncate / truncating rewrite) | no | destructive | in-process append queue + any 2nd resumer | **HIGH** (F3) |
| 5 | `src/utils/plugins/installedPluginsManager.ts:373` `saveInstalledPluginsV2` | `~/.claude/plugins/installed_plugins.json` | **no** (`writeFileSync_DEPRECATED` truncates in place) | no | LWW over a fresh read | all engine procs | **HIGH** (F4) |
| 6 | `src/utils/cronTasks.ts:176` `writeCronTasks` | `.cat-code/scheduled_tasks.json` | **no** | no | LWW over a fresh read | all engine procs in that project | **MED** (F6) |
| 7 | `src/utils/tasks.ts:300,365` | `~/.cat-code/tasks/**` task JSON | **no** | **yes** (proper-lockfile) | read-under-lock ✅ | parallel swarm procs | **MED** (F7) |
| 8 | `src/utils/swarm/permissionSync.ts:423` `resolvePermission` | `resolved/<id>.json` permission decisions | **no** | write yes / **read no** | n/a | leader + worker procs | LOW (F11) |
| 9 | `src/utils/concurrentSessions.ts:77,123` | `~/.cat-code/sessions/<pid>.json` peer registry | **no** | no | single-writer per file ✅ | written by owner, read by every peer | LOW (F12) |
| 10 | `src/history.ts:319` | `~/.cat-code/history.jsonl` prompt history | append | **yes** | append ✅ | all engine procs | LOW (F13 — loses buffer on error) |
| 11 | `src/utils/settings/settings.ts:596` `updateSettingsForSource` | settings.json (all editable sources) | yes | **yes** | read-under-lock ✅ | all | clean |
| 12 | `src/utils/config.ts:1347` `saveConfigWithLock` | `~/.claude.json` | yes | **yes** | read-under-lock ✅ | all | clean |
| 13 | `src/utils/config.ts:1169` `saveConfig` (unlocked variant) | same file as #12 | yes | **no** | LWW | all | LOW (F14) |
| 14 | `src/agent-mode/sessionState.ts:242` | agent-mode session state | yes | in-proc chain | per-session file | single writer | clean |
| 15 | `src/services/mcp/config.ts:105` | `.mcp.json` | yes | no | LWW | user + engine | clean-ish |
| 16 | `src/utils/swarm/teamHelpers.ts:247` via `transactTeamFile:381` | team file | no | **yes** | read-under-lock ✅ | swarm procs | LOW (non-atomic under lock) |
| 17 | `src/utils/swarm/teamHelpers.ts:232` `writeTeamFile` (sync) | — | — | — | — | — | LOW dead code (F15) |
| 18 | `app/host/registry.ts:1030` | `registry.json` | yes | yes | LWW (already confirmed) | main + host | — |
| 19 | `app/main/transcriptCache.ts:275` `writeCache` | per-session transcript cache | yes (no dir-fsync) | n/a | per-session file | single main | clean |
| 20 | `app/sidecar/sessionsCatalogCache.ts:54` | global catalog cache | yes (no dir-fsync) | no | LWW (derived cache — fine) | catalog workers | clean |
| 21 | `app/main/devHarness.ts:348` `atomicWriteJson0600` | dev harness state | yes (no dir-fsync, no tmp cleanup) | n/a | dev only | dev only | clean |
| 22 | `app/main/main.ts:1514` | user-chosen save-as destination | n/a | n/a | user picks path | none | clean |
| 23 | `src/utils/toolResultStorage.ts:162` / `pasteStore.ts:48` / `mcpOutputStorage.ts:158` | content-addressed blobs | `flag:'wx'` / per-file | n/a | immutable | n/a | clean |

**`app/` writes its own files correctly.** Every direct `fs` write under `app/main`, `app/host`, `app/sidecar` is temp+fsync+rename with 0600. The non-atomic persistence the desktop is exposed to all comes from the engine modules the sidecar calls into.

---

## Findings

### [HIGH] OAuth refresh tokens are written world-readable (0644) in a 0755 vault directory

- **Where**: `src/services/api/claudeAccountPool.ts:627` (`mkdirSync(accountsDir, { recursive: true })`) and `:655` (`writeFileSync(filePath, …, 'utf-8')`); same shape at `src/services/api/codexAccountPool.ts:718,762` and `:806`.
- **Type**: security
- **What**: Neither the vault directory nor the token files are created with a restrictive mode. `mkdirSync` without `mode` yields 0777&~umask (0755 typical) and `writeFileSync` without `mode` yields 0666&~umask (0644 typical). The only vault writer that gets this right is `codexTokenRefresh.ts:935` (`openSync(tmpPath, 'w', 0o600)`), and its correctness is undone the moment `saveCodexTokenToVault` recreates the file.
- **Trigger / why it matters**: Verified on this machine, not inferred:
  ```
  drwxr-xr-x  /Users/pt/claude-vault/accounts
  -rw-r--r--  6261be8f-…json      ← contains access_token + refresh_token
  -rw-r--r--  d8853123-…json
  ```
  Any process running as any local user can read live Anthropic and OpenAI refresh tokens. The repo already knows the right idiom — `deferredContinuation.ts:340` opens 0600, chmods 0600 after rename, and `readPrivateJson:352` *refuses to load* a record whose `mode & 0o077` is non-zero. The credential vaults have neither the write-side mode nor the read-side check.
- **Fix**: `mkdirSync(accountsDir, { recursive: true, mode: 0o700 })`, and pass `{ encoding: 'utf-8', mode: 0o600 }` to the three vault `writeFileSync` calls (`claudeAccountPool.ts:600,655`, `codexAccountPool.ts:762,806`). Add a one-time `chmodSync(0o600)` on load for files already on disk.

### [HIGH] Settings sync writes `settings.json` non-atomically and bypasses the cross-process settings lock

- **Where**: `src/services/settingsSync/index.ts:461` (`writeFileForSync`), called from `:518` (userSettings), `:551` (localSettings).
- **Type**: correctness
- **What**: `applyRemoteEntriesToLocal` writes the real settings files with a bare `await writeFile(filePath, content, 'utf8')`. Every other writer of these files goes through `updateSettingsForSource` (`src/utils/settings/settings.ts:507`), which acquires `acquireSettingsLockSync(filePath)`, re-reads under the lock, and writes via temp+rename. This path takes neither the lock nor the atomicity.
- **Trigger / why it matters**: Two concrete failures. (a) A sync pull lands while a session is mid-`updateSettingsForSource`: the sync write is not serialized against the lock holder, so it clobbers a permission rule the user just approved — exactly the lost-update the settings lock comment at `settings.ts:503-507` says was added for the N-process desktop model. (b) The process dies mid-`writeFile` (no temp+rename): `settings.json` is left truncated, and `parseSettingsFile` then treats the user's entire permission allowlist as absent. The `markInternalWrite` calls at `:517` and `:550` show the author was thinking about the watcher, not about the lock.
- **Fix**: Route both writes through `updateSettingsForSource(source, () => parsedRemoteSettings)` (the updater form exists precisely for this), or at minimum wrap the write in `acquireSettingsLockSync` + `writeFileSyncAndFlush_DEPRECATED`.

### [HIGH] `removeMessageByUuid` truncates the live transcript using a stale size, deleting entries the flush queue appended in the same process

- **Where**: `src/utils/sessionStorage.ts:1319-1400`; the destructive call is `await fh.truncate(absLineStart)` at `:1362`, the slow-path rewrite is `await writeFile(this.sessionFile, lines.join('\n'))` at `:1393`.
- **Type**: correctness
- **What**: The method opens the transcript `r+`, stats it, reads the tail, computes an absolute offset, then truncates the file to that offset. It runs under `trackWrite` (`:1030`), which only increments a counter — it is **not** serialized against `drainWriteQueue` (`:1078`), which is the path that actually appends entries.
- **Trigger / why it matters**: Purely in-process, no second engine needed. `enqueueWrite` (`:1039`) buffers entries and `scheduleDrain` (`:1051`) flushes them on a 100 ms timer. `removeMessageByUuid` awaits four times (`fsOpen`, `stat`, `read`, then `truncate`), so the timer fires inside that window, `drainWriteQueue` → `appendToFile` appends N bytes at EOF, and the subsequent `fh.truncate(absLineStart)` chops the file back past them. Result: a user message or assistant turn silently disappears from the transcript. `flush()` (`:1290`) proves the author knew the two paths need ordering — it awaits `activeDrain` *and* `drainWriteQueue` *and* `pendingWriteCount` — but `removeMessageByUuid` awaits none of them. The slow path at `:1393` adds a second failure: a truncating full-file rewrite with no temp+rename, so a crash there leaves a half-written transcript. Cross-process makes it worse and is now reachable by design: `app/main/openHistorySession.ts:32-38` documents that opening a terminal-live transcript from the desktop deliberately creates a second writer.
- **Fix**: `await this.drainWriteQueue()` (and `await this.activeDrain`) at the top of the `trackWrite` body before opening the file, and make the slow path a temp+rename. The blanket `catch {}` at `:1396` (commented "the file might not exist yet") also swallows a failed partial truncate — narrow it to ENOENT.

### [HIGH] A crash during the plugin-registry write silently uninstalls every plugin

- **Where**: write `src/utils/plugins/installedPluginsManager.ts:373` (`saveInstalledPluginsV2`); load `:353-362`; callers `addPluginInstallation:414,440` and `removePluginInstallation:456`.
- **Type**: correctness
- **What**: `saveInstalledPluginsV2` writes the whole of `~/.claude/plugins/installed_plugins.json` with `writeFileSync_DEPRECATED(…, { flush: true })`. Despite the name's resemblance to the atomic `writeFileSyncAndFlush_DEPRECATED`, this helper (`src/utils/slowOperations.ts:248-286`) does `openSync(filePath, 'w')` — **truncate in place** — then write then fsync. There is no temp file and no lock. The load path's `catch` at `:353` then returns `{ version: 2, plugins: {} }` on any parse failure.
- **Trigger / why it matters**: Two paths, both silent. (a) Process dies (or the machine loses power) between the `O_TRUNC` and the write completing → the file is truncated JSON → the next launch logs one debug line and reports **zero installed plugins**, and the next `addPluginInstallation` writes that empty object back as truth, permanently erasing the record of every install. (b) Two sessions install plugins concurrently: both `loadInstalledPluginsFromDisk()` (`:414`, `:456` — correctly re-read from disk), both mutate their own copy, both write the whole document; the later write drops the earlier install.
- **Fix**: Switch `saveInstalledPluginsV2` to `writeFileSyncAndFlush_DEPRECATED` (already imported elsewhere in `src/`, already atomic) and take the same `acquireSettingsLockSync`-style lock the settings writer uses. Separately, do not degrade a *parse failure* to empty — distinguish ENOENT (legitimately empty) from corrupt (must not be overwritten), which is what `settings.ts:544-548` already does for settings.

### [MED] Two near-identically-named write helpers have opposite atomicity guarantees

- **Where**: `src/utils/slowOperations.ts:248` `writeFileSync_DEPRECATED(path, data, { flush: true })` (truncate in place + fsync) vs `src/utils/file.ts:362` `writeFileSyncAndFlush_DEPRECATED(path, content)` (temp + flush + rename).
- **Type**: design
- **What**: The names differ by the words "AndFlush", but the *actual* difference is atomicity, and the one that mentions flushing is the atomic one while the one you must pass `{flush:true}` to is the non-atomic one. Nothing at either call site tells you which guarantee you got.
- **Trigger / why it matters**: This is the direct cause of the previous finding: `installedPluginsManager` passes `{ flush: true }` and reads as if it had durability, when what it needs is atomicity. `src/utils/startupProfiler.ts:137` and `src/commands/export/export.tsx:63` use the same helper (benign — throwaway artifacts), and `src/main.tsx:471` uses it to write a settings file during migration, which is not benign.
- **Fix**: Rename to `writeFileSyncTruncating_DEPRECATED` / `writeFileSyncAtomic_DEPRECATED`, or delete the `flush` branch of the former and make every durable-state caller use the atomic one.

### [MED] Eleven independent hand-rolled copies of `atomicWriteJson`, three of which drop a guarantee

- **Where**: `src/services/deferredContinuation.ts:329` · `src/services/api/codexTokenRefresh.ts:926` · `src/utils/file.ts:362` · `app/host/registry.ts:1030` · `app/main/transcriptCache.ts:275` · `app/sidecar/sessionsCatalogCache.ts:54` · `app/main/devHarness.ts:348` · `src/services/api/codexAccountPool.ts:761` · `src/services/api/claudeAccountPool.ts:600` · `src/agent-mode/sessionState.ts:240` · `src/services/mcp/config.ts:105`.
- **Type**: quality
- **What**: The same 20-40 line temp+rename routine is written out eleven times at four different rigor levels: with dir-fsync (registry, codexTokenRefresh, deferredContinuation), without dir-fsync (transcriptCache, sessionsCatalogCache, devHarness), without fsync at all (both account pools, agent-mode, mcp config), and with symlink/mode preservation (file.ts only). `app/host/registry.ts:1027` even cites `codexTokenRefresh.ts:913-952` in a comment as the thing it is copying.
- **Trigger / why it matters**: The cost is already realised — the two account-pool copies are the ones missing the 0600 mode (finding F1), and each new copy re-decides whether the dir-fsync matters. `app/main/devHarness.ts:348` additionally leaks its temp file on a write error (no `unlinkSync` on the failure path) where all three of its siblings clean up.
- **Fix**: The `app/` plane already has three copies of the identical function — collapse those to one in `app/shared/` (all three callers are in-process to main or the sidecar). Engine-side, `codexTokenRefresh.ts`'s copy should be exported and used by both account pools.

### [MED] `.cat-code/scheduled_tasks.json` is a lock-free read-modify-write of the whole file

- **Where**: `src/utils/cronTasks.ts:165` `writeCronTasks`; read-modify-write callers at `:215-217` (`addCronTask`), `:244-247` (`removeCronTasks`), `:268-277`.
- **Type**: correctness
- **What**: Every mutation reads the whole task list, mutates in memory, and overwrites the file with a plain `writeFile`. No lock, no temp+rename.
- **Trigger / why it matters**: This repo runs several sessions per project by design. Session A calls `addCronTask` (reads `[t1]`), session B calls `removeCronTasks(['t1'])` (reads `[t1]`, writes `[]`), session A writes `[t1, t2]` — the deleted task is resurrected and will fire. Reverse the order and `t2` is lost. `removeCronTasks`' own doc comment at `:222` says "No-op if none match (e.g. another session raced us)", so the race was noticed but only the benign half of it was handled. Separately, a crash mid-`writeFile` truncates the schedule file; `readCronTasks` then yields nothing and every durable task is silently gone.
- **Fix**: Wrap the read-modify-write in the same `lockfile.lock` pattern `src/utils/tasks.ts:288-296` already uses for the task store, and write via temp+rename.

### [MED] Task store writes are locked but not atomic

- **Where**: `src/utils/tasks.ts:300` (`createTask`), `:365` (`updateTaskUnsafe`), `:130` (`writeHighWaterMark`).
- **Type**: correctness
- **What**: The lock discipline is correct — `createTask` and `updateTask` hold `lockfile.lock` across the read and the write, and `updateTaskUnsafe` exists specifically to avoid deadlocking a lock-holder. But the write itself is a truncating `writeFile`.
- **Trigger / why it matters**: A crash between truncate and write leaves a zero/partial-length task file. `getTask` (`:322`) then fails `TaskSchema().safeParse`, logs at debug level, and returns `null` — the task vanishes from the list with no user-visible signal, and `findHighestTaskId` may then reissue its id. The lock protects against concurrency but does nothing about crash atomicity.
- **Fix**: temp+rename inside the existing lock. Three call sites, no new locking needed.

### [LOW] `resolved/<id>.json` is written non-atomically and read with no lock

- **Where**: write `src/utils/swarm/permissionSync.ts:421-425` (under the pending-dir lock); read `:325` `readResolvedPermission` (no lock).
- **Type**: correctness
- **What**: The leader writes the permission decision with a truncating `writeFile` while holding the *pending* directory lock; the polling worker reads the *resolved* file taking no lock at all.
- **Trigger / why it matters**: The worker's read can land between the truncate and the write and see an empty or partial file; `safeParse` fails and it returns `null`, which the caller interprets as "not resolved yet". Self-healing on the next poll, which is why this is LOW rather than MED — but a crash mid-write leaves a permanently unparseable resolution while the pending file has already been consumed by the leader's in-memory state.
- **Fix**: temp+rename for the resolved write (the reader needs no change once the write is atomic).

### [LOW] Peer registry files are truncated in place while other processes read them

- **Where**: `src/utils/concurrentSessions.ts:77` (`registerSession`) and `:123` (`updatePidFile`).
- **Type**: correctness
- **What**: `~/.cat-code/sessions/<pid>.json` is written with a plain `writeFile`. Single-writer per file (keyed by the owner's own pid), so there is no lost-update — but `updatePidFile` is a read-modify-write and the file is read by every peer's `readdir`+parse enumeration.
- **Trigger / why it matters**: `onSessionSwitch` (`:99`) fires `updatePidFile` on every `/resume`. A peer enumerating at that instant reads a truncated file, fails to parse, and drops that session from the peer list for that poll. Cosmetic and transient.
- **Fix**: temp+rename; it is one line given the file is already per-pid.

### [LOW] `immediateFlushHistory` drops the pending buffer when the append fails

- **Where**: `src/history.ts:317-319`.
- **Type**: correctness
- **What**: `pendingEntries = []` executes *before* `await appendFile(...)`. If the append throws, the outer `catch` at `:320` logs to debug and returns — the entries are already gone from the buffer.
- **Trigger / why it matters**: A transient EIO/ENOSPC on `~/.cat-code/history.jsonl` silently loses that batch of prompt history rather than retrying on the next flush. The lock and retry machinery around it (`:290-296`, `flushPromptHistory(retries)` at `:329`) suggests the intent was for failures to be recoverable.
- **Fix**: Move the clear after a successful append, or restore `pendingEntries` in the catch.

### [LOW] `saveConfig` (the unlocked twin of `saveConfigWithLock`) is still on two live paths

- **Where**: `src/utils/config.ts:1151` defined; called at `:898` and `:1730`, while `:847` and `:1676` in the same functions use the locked `saveConfigWithLock`.
- **Type**: correctness
- **What**: Two writers of `~/.claude.json` sit inside the same functions, one taking the cross-process lock and one not.
- **Trigger / why it matters**: The write itself is atomic (`writeFileSyncAndFlush_DEPRECATED`), so there is no torn file — but the unlocked path can still clobber a concurrent session's config change, which is precisely what the locked path exists to prevent. Worth a look at whether the two call sites are genuinely on a path where the lock is already held.
- **Fix**: If the lock is held by the caller, say so in a comment; otherwise use `saveConfigWithLock`.

### [LOW] `writeTeamFile` is dead

- **Where**: `src/utils/swarm/teamHelpers.ts:232`.
- **Type**: dead-code
- **What**: The sync `writeTeamFile` has no callers (`rg 'writeTeamFile\('` returns only the definition; `writeTeamFileAsync` is used at `TeamCreateTool.ts:206` and inside `transactTeamFile` at `:381`).
- **Trigger / why it matters**: It is the only remaining un-transacted team-file writer, so leaving it there invites a future caller to bypass `transactTeamFile`'s lock-fresh-read-write discipline.
- **Fix**: Delete it.

---

## SWEEP 2 — cross-layer duplication (engine vs desktop)

| Pair | Engine | Desktop | Agree? |
|---|---|---|---|
| context accounting | `autoCompact.ts:40` `getEffectiveContextWindowSize`; consumed at `StatusLine.tsx:51,100`, `autoCompact.ts:194,211,232,259,374`, `attachments.ts` | `contextUsage.ts:379` divides by the RAW window; sourced from `runControlsDomain.ts:574` `getContextWindowForModel` | **NO** — D1 |
| queue drain | `queueProcessor.ts:76-79` `dequeueAllMatching` → ONE `executeInput([…])` | `sidecarServer.ts:1142` `dequeue(...)` → one `startTurn` per prompt | **NO** — D2 |
| settings source attribution | `settings.ts:766,827,864` `mergeWith(settingsMergeCustomizer)` — DEEP merge, arrays unioned | `settingsDomain.ts:179-205` top-level-key `seen` set, one winner per key | **NO** — D3 |
| settings precedence table | `constants.ts:7-22` `SETTING_SOURCES` + `constants.ts:159` `getEnabledSettingSources` | `settingsDomain.ts:372` re-walk + `settingsState.ts:145` hard-coded reversal + `settingsScope.ts:555` `rank()` + `protocol.ts:676` redeclared union | agree today, 4 copies — D4 |
| account pool readiness | `codexAccountPool.ts:1544` `getCodexAccountAvailability` (`!== 'blocked'` is literally labelled "Ready", `:1595`) | `accountsDomain.ts:456,470` hand-rolled two-field test | **NO** — D5 |
| transcript parsing | `sessionStoragePortable.ts:209-231` bounded 64 KB head+tail; `sessionStorage.ts:3234` `readFileTailSync` | `transcriptRunFacts.ts:76` `readFileSync(path,'utf8').split('\n')` — whole file | **NO** — D6 |
| session listing | `sessionStorage.ts` `loadAllProjectsMessageLogsProgressive` | `sessionsCatalogDomain.ts:43` imports and calls it | **YES — clean** |
| session resume | `conversationRecovery.ts` + `sessionRestore.ts` | `sessionResume.ts:69,79` calls both | **YES — clean** |
| permission evaluation | `permissionSetup.ts`, `permissionsLoader.ts` | `permissionDomain.ts:22-25` imports them; `permissionState.ts` is queue/display only, evaluates nothing | **YES — clean** |

### [HIGH] D1 — The desktop context donut divides by a different window than everything that acts on context

- **Where**: `app/renderer/src/contextUsage.ts:373-380` (`contextWindow` ← raw), fed by `app/sidecar/runControlsDomain.ts:574` `readContextWindow` → `getContextWindowForModel`. Engine side: `src/services/compact/autoCompact.ts:40` and its consumers `src/components/StatusLine.tsx:51,100,102`.
- **Type**: correctness
- **What**: `getEffectiveContextWindowSize` = raw window − `min(getMaxOutputTokensForModel(model), 20_000)`, and it is additionally clamped by `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (`autoCompact.ts:47-53`). The desktop gauge uses neither term.
- **Trigger / why it matters**: On a 200k model with ≥20k max output, effective = 180k. At 180k used the terminal status line reports `used_percentage` 100% and auto-compact fires; the desktop donut reads 90%. Worse, `pressureTone` (`contextUsage.ts:~105`) turns the donut red at ≥90 — so the danger colour arrives exactly when compaction has already happened, never before it. And an operator who sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000` gets a donut still dividing by 200k: it reads 40% at the instant the engine compacts. The tell that this was known and not resolved: `app/renderer/src/tokenWarning.ts:43` states outright that the auto-compact denominator "differs from the gauge's `contextWindow`", while `contextUsage.ts:59-64` in the same directory justifies the raw window by citing the repo's own "don't re-derive engine machinery" rule. Both cannot be right.
- **Fix**: Add the effective window to `RunControlsSnapshot.model` alongside `contextWindow` (`runControlsDomain.ts:574` already has the model string; one extra `getEffectiveContextWindowSize(model)` call) and make `percentUsed` divide by it. Keep the raw window on the wire for the breakdown page, which legitimately matches `analyzeContext.ts:1031`'s raw denominator.

### [MED] D2 — The sidecar's queue drain runs one turn per queued prompt where the engine runs one turn for all of them

- **Where**: `app/sidecar/sidecarServer.ts:1131-1183` `drainOneQueuedPrompt` (`dequeue(isDeliverableParentPrompt)` at `:1142`, filter at `:3432`) vs `src/utils/queueProcessor.ts:52-80` `processQueueIfReady`.
- **Type**: design / correctness
- **What**: The engine batches: `dequeueAllMatching(cmd => isMainThread(cmd) && !isSlashCommand(cmd) && cmd.mode === targetMode)` and hands the whole array to one `executeInput` call, each item becoming its own user message inside a single turn. The sidecar dequeues exactly one command and starts a turn for it, then `startTurn`'s finalizer schedules the next boundary and does it again.
- **Trigger / why it matters**: A user types three follow-ups while a turn runs. Terminal: one turn, the model sees all three together and can answer them coherently. Desktop: three sequential turns, each with `generateTitle: true` (`:1160`), each paying a full request. Beyond cost, the semantics differ — prompt 2 is answered by a model that has already acted on prompt 1 and cannot revise that action. The comment at `:1123-1125` says this path works "exactly as the terminal REPL's between-turn processor does (`src/hooks/useQueueProcessor.ts:48-60`)"; that hook's body is a single call to `processQueueIfReady`, i.e. the batching one, so the cited parity does not hold. Separately, `isDeliverableParentPrompt` (`:3432`) filters only on `mode === 'prompt'` and has no slash-command carve-out, where `processQueueIfReady:69-73` deliberately isolates slash and bash commands.
- **Fix**: Have `drainOneQueuedPrompt` call the engine's `processQueueIfReady` with an `executeInput` that maps the batch onto one `startTurn`, rather than owning a second drain policy. If the one-turn-per-prompt behaviour is intentional for the desktop, say so at `:1122` and delete the false citation.

### [MED] D3 — The settings screen attributes each key to one source, but the engine deep-merges and unions arrays across sources

- **Where**: `app/sidecar/settingsDomain.ts:178-205` (the `seen` set and `resolved` push) vs `src/utils/settings/settings.ts:766,827,864` (`mergeWith(..., settingsMergeCustomizer)`) and `settings.ts:628-645` (`mergeArrays` = `uniq([...target, ...source])`).
- **Type**: correctness
- **What**: `buildSettingsSnapshot` walks layers high→low and records the FIRST layer that has each top-level key as that key's owner. The engine does not resolve settings that way: it deep-merges objects and *concatenates and dedupes arrays* across every source.
- **Trigger / why it matters**: `permissions.allow` is an array. A user with `Bash(git:*)` in `~/.claude/settings.json` and `Read(**)` in `.claude/settings.local.json` is running with BOTH rules live. The desktop's resolved row says `permissions` comes from Project local settings alone — so the settings screen tells the operator their user-level permission rules are overridden when they are in fact still granting access. The same holds for `hooks` and `env`. The author already found this for one field: `:171-176` explains at length why `permissions.defaultMode` had to be resolved on its own axis and excluded from `seen`, because "the engine deep-merges settings … so a nested scalar is overridden per-key, not per top-level object". That reasoning is correct and applies to every nested key; it was applied to exactly one.
- **Fix**: Ship the engine's answer rather than recomputing it. `getSettingsWithSources()` (`settings.ts:936`) already returns `{ effective, sources }` — put `effective` on the snapshot and let the renderer diff a layer's own keys against it, instead of the sidecar deciding winners with a top-level-key set.

### [MED] D4 — Four independent encodings of the setting-source precedence order, one of them a hand-typed literal in the renderer

- **Where**: `src/utils/settings/constants.ts:7-22` (`SETTING_SOURCES`, ascending) · `constants.ts:159-167` (`getEnabledSettingSources`, a `Set` whose order depends on `getAllowedSettingSources()`) · `app/sidecar/settingsDomain.ts:372` (re-walks `SETTING_SOURCES` + `isSettingSourceEnabled`) · `app/renderer/src/settingsState.ts:145-152` (`SETTING_SOURCE_PRECEDENCE`, a hard-coded descending literal) consumed by `app/renderer/src/settingsScope.ts:555` `rank()`. `app/shared/protocol.ts:676` additionally redeclares the source union.
- **Type**: quality / correctness
- **What**: The renderer's precedence list is typed out by hand rather than derived from the engine constant. The sidecar's list is derived, but from `SETTING_SOURCES` instead of `getEnabledSettingSources()` — and its comment at `:361-364` asserts the engine's own order is wrong ("`getEnabledSettingSources()` insertion order … appends policy before flag").
- **Trigger / why it matters**: The sidecar's comment is right, but only under `--setting-sources`. With the default `allowedSettingSources` (`src/bootstrap/state.ts:328-334`, the full canonical list) the `Set` re-adds policy and flag that are already present, so order is unchanged and the two agree. Pass `--setting-sources user,project` and the engine's merge order becomes `… policySettings, flagSettings` — flag beats enterprise policy — while the sidecar keeps policy last. The desktop does not pass that flag today, so the divergence is latent rather than live; the cost that IS live is that reordering `SETTING_SOURCES` silently leaves the renderer's hard-coded literal stale, with no test or type binding the two.
- **Fix**: Derive the renderer's descending order from the shared ascending constant (`[...SETTING_SOURCES].reverse()`) so there is one authority. Separately, decide whether flag or policy wins and fix `getEnabledSettingSources` — a settings-source order that changes meaning based on a CLI flag is a bug in the engine, not something the sidecar should silently paper over.

### [MED] D5 — `readyCount` re-derives account availability from raw fields while the authoritative answer sits three lines above it

- **Where**: `app/sidecar/accountsDomain.ts:456-458` (`a.status === 'healthy' && a.usageLimitReached !== true`) and `:470-472` (`account.status === 'healthy'` for Anthropic), vs `src/services/api/codexAccountPool.ts:1544-1572` `getCodexAccountAvailability`.
- **Type**: correctness
- **What**: `buildAccountStatus` (`:387`) already calls `getCodexAccountAvailability(account, now).kind` and puts it on the wire per account. `buildAccountsSnapshot` then ignores that field and counts "ready" with a two-field test of its own.
- **Trigger / why it matters**: The two disagree in both directions, and `describeCodexAccountAvailabilityLabel:1594-1596` shows the engine's rule is exactly what the UI word "Ready" means. (a) **Overcount**: an account with `status: 'healthy'` and a fresh usage hint reporting `usageAllowed === false` is `blocked` per `:1560-1568`, but `usageAllowed` is a different field from `usageLimitReached`, so the badge counts it ready. The pool will never lease it. (b) **Undercount**: a `capped` account whose hard-429 window has elapsed (`:1551-1556`) or a `usageLimitReached` account past `isQuotaObservationResetElapsed` (`:1565`) is `available` to the engine but not `'healthy'`, so the badge says 0 ready while turns run fine. The Anthropic counter is cruder still — status only, no availability concept at all.
- **Fix**: `poolStatus.accounts.filter(a => getCodexAccountAvailability(a, now).kind !== 'blocked').length`, or count the `availability` field `buildAccountStatus` already produced.

### [MED] D6 — The backfill worker reads whole transcripts into memory where the engine reads bounded 64 KB windows

- **Where**: `app/sidecar/transcriptRunFacts.ts:76` — `lines = readFileSync(path, 'utf8').split('\n')`. Engine equivalents: `src/utils/sessionStoragePortable.ts:209-231` (head+tail, `LITE_READ_BUF_SIZE = 65536`) and `src/utils/sessionStorage.ts:3234` `readFileTailSync`.
- **Type**: correctness / design
- **What**: No size guard, no windowed read. The whole file becomes a string and then an array of per-line strings — roughly twice the file resident at once — per session, for up to `MAX_TRANSCRIPT_BACKFILL_SESSIONS = 32` sessions (`app/shared/transcriptBackfill.ts:28`) in one worker run.
- **Trigger / why it matters**: The backward scan early-exits only when all five facts are found (`:117-124`), and `effort` comes exclusively from a `system`/`codex_send_path` record. Any Anthropic-provider session never writes one, so `facts.effort` stays null and the loop runs to line 0 — full read plus `JSON.parse` of every record. Multiply by 32 long sessions at app launch. This sits inside the one subsystem in the repo whose architecture is explicitly justified by RAM (`sessionsCatalogWorker.ts:1-8` on the RAM-3.1 plateau; `transcriptBackfill.ts:29` caps the *request* at 256 KB while leaving the *file* uncapped), and its sibling `app/main/transcriptCache.ts:325` does exactly the right thing — `statSync(filePath).size > MAX_TRANSCRIPT_CACHE_BYTES` checked BEFORE the read.
- **Fix**: Read the tail window only (the scan is backward and the run-facts snapshot is written per turn, so it is in the tail by construction) via the engine's `readFileTailSync`, with a `statSync` size gate for the legacy full-scan fallback.

### [LOW] D7 — Three copies of the atomic-write helper inside `app/` alone

- **Where**: `app/host/registry.ts:1030`, `app/main/transcriptCache.ts:275-306`, `app/sidecar/sessionsCatalogCache.ts:54-87`, `app/main/devHarness.ts:348-360`.
- **Type**: quality
- **What**: Same routine, four times, in one package. Two of the four drop the directory fsync that `registry.ts` documents as required for crash durability, and `devHarness.ts` leaks its temp file on the error path.
- **Trigger / why it matters**: See the sweep-1 finding on the eleven repo-wide copies; this is the `app/`-local half and the cheapest to fix, since all four callers are in the same package.
- **Fix**: One helper in `app/shared/`, imported by all four.

---

## What is good here

- **`app/sidecar/sessionResume.ts` is the model for this whole program.** It composes `loadConversationForResume` + `processResumedConversation` with a doc comment citing the exact TUI lines it mirrors, and it *throws* on an unresumable id rather than silently minting a fresh session. Zero re-derivation. `sessionsCatalogDomain.ts` and `permissionDomain.ts` follow the same discipline.
- **`src/services/deferredContinuation.ts:329-350` is the best file-write in the tree** — O_EXCL, O_NOFOLLOW, 0600 at open, fsync, rename, chmod, dir-sync — and it pairs the write with `readPrivateJson:352-358`, which *refuses to load* a record whose mode is not private. The credential vaults should be copying this, not the account pools' temp+rename.
- **`app/main/transcriptCache.ts:310-330` gets the read side right**: size-checked before the read, fail-closed on every gate, and it deletes the file on failure so a corrupt cache cannot be re-read forever.
- **`src/utils/settings/settings.ts:503-518`** is the correct shape for shared mutable state and is worth pointing every other writer at: acquire the cross-process lock, *drop the parse cache* so the read is genuinely off disk, read, merge, atomic-write. The comment explains why each step exists.
- **The sidecar's `readSettingsSnapshotOnce` comment (`settingsDomain.ts:360-364`) and `tokenWarning.ts:26-46`** both name their own approximation and its cost instead of asserting parity. That habit is why several of the findings above were verifiable at all.

## Not reviewed / uncertain

- **Whether the `--setting-sources` flag-vs-policy ordering (D4) is reachable from the desktop.** I confirmed the default `allowedSettingSources` makes the two orders identical and that nothing in `app/` passes the flag, but I did not trace every sidecar spawn argument. If the supervisor ever forwards CLI flags, D4 becomes live rather than latent.
- **Whether a queued slash command can reach `drainOneQueuedPrompt`.** `isDeliverableParentPrompt` does not exclude them, but I did not trace whether the desktop composer routes `/foo` through `enqueue` with `mode: 'prompt'` or handles it before the queue. If it does enqueue them, D2 has a second and more serious half.
- **The concurrency of `writeSessionsCatalogCache` across multiple app instances.** The write is atomic and the file is a derived cache, so last-writer-wins is harmless — but I did not verify whether two desktop instances can run catalog workers simultaneously.
- **`src/services/teamMemorySync/index.ts:742` and `src/utils/fileHistory.ts`** were not classified; both write user-visible files and were outside the time I had after the priority targets.
- **I did not run any test.** Every claim above is from source plus one read-only `ls -l` of the vault directory (F1). The F3 in-process race and the D2 turn-count difference are both argued from control flow, not observed; a focused test would settle each in minutes.

