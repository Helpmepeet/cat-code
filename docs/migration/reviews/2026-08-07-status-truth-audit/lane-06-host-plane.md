# Lane 06 — The host plane

**Auditor verdict:** YELLOW
**Rows audited:** 4 · TRUE 1 · OVERSTATED 3 · FALSE 0 · STALE 0 · UNVERIFIABLE-HEADLESS 0

Headline: the host plane is real and the mechanisms are built as described. Nothing
in this lane is a Potemkin surface. The three OVERSTATED verdicts are all
citation/constant drift inside otherwise-verified rows, plus one genuine design
gap the rows never claimed to close (F1). No Critical finding.

Concurrent edit in flight: `app/main/main.ts` and `app/sidecar/sessionController.ts`
are dirty in `git status` and not explained by these rows. HEAD behavior was
audited for both (`git show HEAD:app/sidecar/sessionController.ts` confirms the
resume-seed wiring at HEAD).

## Row verdicts

### P3-0 — Envelope N-hardening (F3 gaps) + two-sidecar smoke
**Verdict:** TRUE

**Claims checked:**
1. Ready frames carry app-owned `engineSessionId`.
2. main/supervisor return typed send-failure codes.
3. Outbound sessionId tripwire fails closed.
4. Ready schema check fails closed.
5. Restart/kill replay eviction is tested.
6. Extended two-sidecar smoke proved independent routing, survivor liveness,
   typed send-to-dead outcome, and no ghost replay.

**Evidence:**
1. `app/shared/protocol.ts:510-516` — `ReadyFrame.engineSessionId: string`.
2. `app/supervisor/supervisor.ts:118-138` (`SendFailureCode` union +
   `SidecarSendError` with `retryable`), `:327-334` (throw on send),
   `:577-581` (`sendFailureCodeForStatus`).
3. Two independent tripwires. Supervisor: `supervisor.ts:481-489` drops any frame
   whose `sessionId` does not match the connection record; `:490-497` sets
   `failed` + destroys the socket on any frame arriving before a valid ready.
   Sidecar-side outbound: `app/sidecar/sidecarServer.ts:854`.
4. `supervisor.ts:583-605` `validateReadyFrame` — rejects wrong
   `protocolVersion`, mismatched `sessionId`, missing/empty `engineSessionId`,
   non-`app.ready` payload; caller at `:462-471` sets `failed` and destroys.
5. `app/main/attachmentGate.test.ts:279` (`clearSession() drops stale replay
   while preserving the attached renderer`), `app/main/replayBuffer.test.ts`
   (`clearSession() drops only the restarted session replay state`). Production
   call sites: `app/host/host.ts:521` (close), `:630` (restart), wired to the
   real gate in `app/main/main.ts:1732-1736`.
6. `app/scripts/f2-attach-smoke.ts` — the smoke is genuinely two REAL sidecars,
   not mocks: real `SidecarSupervisor` spawning `bun run app/sidecar/index.ts`
   twice (`:154-165`), real Electron `BrowserWindow` with the real
   `preload.cjs` (`:217-225`), and the SAME production `AttachmentGate`
   imported, not copied (`:33,47`). Assertions: independent routing (`:188-215`
   both ready + both addressed pongs), survivor liveness after SIGTERM of the
   peer (`:295-338`), typed send-to-dead (`:314-323` asserts the send throws
   `session_disconnected`), no ghost replay after eviction (`:340-353` asserts
   every post-reload frame has `sessionId !== sessionA`).

**Reachable-path trace:** sidecar `index.ts` mints the ready frame → supervisor
socket `data` handler validates it (`supervisor.ts:462`) → emits `frame` →
`host.onSupervisorEvent` (`host.ts:175-180`) fills the registry row and emits
`session-status` → `wireHostEvents(host)` (`main.ts:1738`) → preload
`subscribeHost` → renderer roster. Replay eviction reaches a user via
close/restart in the tab UI through `host.closeSession`/`restartSession`.

**Anchor drift:** none — the row cites no `file:line`.

**Anti-Potemkin note:** the smoke is a manual harness (`bun run
app/scripts/run-f2-attach-smoke.ts`); it is in neither `bun test app/` nor
`test:hardening` (`app/package.json:146` registers only the hardening smoke). The
row's "proved" is past tense and accurate, but nothing re-verifies it, so bit-rot
would be silent. Recorded as a nit, not a falsification.

### P3-1 — Spawn-config: per-session cwd + engine resume plumbing
**Verdict:** OVERSTATED (mechanism fully verified; four cited `src/…:line`
anchors now point at different symbols)

**Claims checked:**
1. `spawnSession(id, {cwd, resumeEngineSessionId?})` sets the child's real spawn
   cwd AND the `CATCODE_SIDECAR_CWD` / `CATCODE_SIDECAR_RESUME_SESSION_ID` env.
2. The config is retained on the record so `restartSession` re-roots and re-resumes.
3. Sidecar validates cwd is a directory, fail-loud.
4. `P1_1_CWD` fully retired; `app/shared/sessionConfig.ts` deleted; `main.ts` owns
   a `process.cwd()` default.
5. Resume composes the engine's REAL machinery via `loadConversationForResume`
   (`conversationRecovery.ts:465`) + `processResumedConversation`
   (`sessionRestore.ts:493`) whose internal `switchSession` (`state.ts:474`)
   adopts the id, mirroring TUI `--resume` (`main.tsx:3784-3797`).
6. Bogus id → `SidecarResumeError` → loud stderr `resume-failed` + dedicated exit 4.
7. F1 fix: the resumed `Message[]` are seeded into the served QueryEngine via
   `initialMessages` (`QueryEngine.ts:145/208`, submit copy at `:454`).

**Evidence:**
1. `app/supervisor/supervisor.ts:221` signature, `:234` `spawnCwd` resolution,
   `:256` actual `cwd:` on the spawn, `:265-268` both env vars set conditionally.
   TRUE.
2. `supervisor.ts:88` (`SpawnConfig` retained on the record), `:374-375`
   (`restartSession` re-calls `spawnSession(sessionId, config)`). TRUE.
3. `app/sidecar/index.ts:104-116` — missing `CATCODE_SIDECAR_CWD` throws;
   `statSync(cwd).isDirectory()` false throws. TRUE.
4. `app/shared/sessionConfig.ts` does not exist. Remaining `P1_1_CWD` hits are
   retirement prose plus an enforcing `expect(source).not.toContain(...)` in
   `app/main/mainSourceGuards.test.ts`. `main.ts:1748`
   `devHarnessConfig.initialCwd ?? process.cwd()`. TRUE.
5. `app/sidecar/sessionResume.ts:68-100` composes both engine functions and
   passes `sessionIdOverride`, then `:102-110` hard-fails if `getSessionId()`
   does not equal the requested id. Mechanism TRUE. **Anchors drifted** (below).
6. `app/sidecar/index.ts:399-405` — `SidecarResumeError` → `[sidecar]
   resume-failed:` on stderr → `process.exit(RESUME_FAILED_EXIT_CODE)`;
   `app/shared/limits.ts:166` `= 4`. Host classifies it at
   `app/host/host.ts:228-234` and refuses further retries via `resumeFailed` /
   `canResume` (`:861-864`). TRUE, and now *better* than the row claims.
7. `app/sidecar/index.ts:144-148` keeps `resumed.messages` →
   `app/sidecar/sessionController.ts:394-395` spreads `initialMessages` into the
   QueryEngine config (confirmed at HEAD, file is dirty) →
   `src/QueryEngine.ts:224` `this.mutableMessages = config.initialMessages ?? []`.
   TRUE. Anchors drifted.

**Reachable-path trace:** Sidebar restore click → preload `restoreSession` →
`main.ts:1311-1327` `CH_HOST_RESTORE` → `host.restoreSession` (`host.ts:296-369`)
→ `host.spawn` → `supervisor.spawnSession(id, {cwd, resumeEngineSessionId})` →
child env → `index.ts:144` `resumeEngineSession` → engine machinery → ready frame
echoes the id → `registry.fillEngineSessionId` → descriptor → roster.
Chain-level headless proof: `app/host/lifetimeChain.probe.test.ts:129-227`.

**Anchor drift:**
- STATUS cites `conversationRecovery.ts:465`; `loadConversationForResume` is at
  **:510**. Line 465 is now inside `loadMessagesFromJsonlPath` — a different
  function. (Same at HEAD.)
- STATUS cites `sessionRestore.ts:493`; `processResumedConversation` is at **:646**.
  Line 493 is inside deferred-continuation lock code.
- STATUS cites `state.ts:474`; `switchSession` is at **:495**. Line 474 is inside
  a session-regeneration helper.
- STATUS cites `main.tsx:3784-3797` as the TUI `--resume` mirror; that range is
  now the **ccshare** resume branch (`loadCcshare` → `forkSession: true`), not
  the direct-UUID path. `sessionResume.ts:7` and `sessionController.ts:397`
  carry the same stale citation in code comments.
- STATUS cites `QueryEngine.ts:145/208`; actual **:148** (`initialMessages?:`)
  and **:224** (assignment to `mutableMessages`). `:454` no longer shows the
  submit-time copy; the copy is at **:499** (`const messages = [...this.mutableMessages]`).

**On `lifetimeChain.probe.test.ts` (asked for explicitly):** it proves what it
claims and is honestly scoped, but it is a **P3-8** regression companion, not
P3-0's proof. It carries one real registry file through
upsert → fill → markLiveCleanSync → fresh `SessionRegistry` → `launch()` →
`restorable()` → a real sidecar resume, and it does mint the transcript through
the engine's own `recordTranscript` (`mintTranscript.fixture.ts`). Its single
end assertion is `ready.engineSessionId === engineSessionId` (`:225`); the
argument that this is sufficient (a fresh session would mint a new random id, so
an echo proves `switchSession` adopted it) is sound. Two honest limitations it
states itself: the registry's `transcriptPathFor` is pointed at a **sentinel
file**, not the engine's real transcript (`:145-151`) — so it exercises the reap
*predicate*, not the real path encoding — and it does not assert the resumed
messages contain the nonce at the chain level (that lives in
`spawnConfig.probe.test.ts` and `resumeSeed.probe.test.ts`). It does not prove
anything about two-sidecar routing.

### P3-2 — Registry module (durable index, host plane)
**Verdict:** OVERSTATED (one schema constant stated in the row is no longer the
value in source)

**Claims checked:** schema per §3 (registryVersion 1, the [D]/[A] field split,
`MAX_REGISTRY_SESSIONS=32`, no secrets/layout/content); write discipline §5
(lazy-required `proper-lockfile` + `atomicWriteJson` temp+fsync+rename, both
re-homed host-side; a held lock fails the WRITE, never the session); launch §4
(corrupt/unknown-version move-aside + empty start; liveness sweep marking
`shutdown:null`→`crashed` and SIGTERMing an orphan only on pid-alive AND
identity; reap of missing-transcript / clean+null-engineSessionId / oldest
terminal over bound; restore-offer by `lastAttachedAt` desc); config-home +
`sanitizePath` re-implemented host-side, never imported; all deps injected; zero
`electron`/engine-graph imports; sidecar tsconfig excludes `host/`;
concurrent-writer test proves no torn JSON.

**Evidence:** all verified except the constant.
- Schema: `registry.ts:92-139` (every field carries its [D]/[A] tag), `:51`
  `REGISTRY_VERSION = 1`. No transcript bytes, message counts, secrets, or
  layout on the row. TRUE.
- **`MAX_REGISTRY_SESSIONS` is 256, not 32** — `registry.ts:72`, raised
  2026-07-26 with the rationale inline at `:57-71`.
- Write discipline: `registry.ts:1117-1131` (`defaultAcquireLock`, lazy
  `require('proper-lockfile')`, `realpath:false`, bounded retries),
  `:1031-1081` (`atomicWriteJson`: temp → `fsyncSync` → `renameSync` → dir
  fsync), `:892-932` (`persist` swallows both lock-acquire and write failure,
  sets `writeFailed`). Test: `registry.test.ts:971` proves a held lock advances
  the in-memory doc, logs, writes nothing, and does not throw. TRUE.
- Launch: `:434-446` sequence; `:453-478` + `:480-494` corrupt move-aside to
  `registry.json.corrupt-<ts>`; `:505-521` sweep; `:531-543`
  `matchesSidecarIdentity` requires pid-alive AND `socketPath` exists AND
  cmdline contains the injected marker, and returns **false** when no marker was
  injected (`:539`) — kill-nothing is the degraded direction. `:551-572` reap;
  `:629-633` restore-offer ordering. TRUE.
- Host-side re-implementation: `:213-216` (`claudeConfigHomeDir`) matches
  `src/utils/envUtils.ts:15-21` verbatim in behavior; `:243-248`
  (`sanitizePath`) matches `src/utils/sessionStoragePortable.ts:311-319`; the
  djb2-vs-`Bun.hash` divergence on long paths is acknowledged and backstopped by
  a prefix scan (`:272-287`). TRUE.
- Isolation: grep for `from 'electron'`, `require('electron')`, `../../src/`, and
  `@cat-code/engine` across `app/host/*.ts` (non-test) returns **zero** hits.
  `app/sidecar/tsconfig.json` `include` is `["./**/*.ts", "../shared/**/*.ts",
  "../../env.d.ts"]` — `../host` is absent. TRUE.
- Concurrent-writer test: `registry.test.ts:940-970`. It asserts only
  parseability and row well-formedness and its own comment says
  "last-writer-wins". The row's claim is exactly "proves no torn JSON" — narrow
  and honest. TRUE as stated. See **F1** for what it does *not* prove.

**Reachable-path trace:** `main.ts:1707` constructs the registry with
`sidecarCommandMarker: SIDECAR_ENTRY` → `:1716` `registry.launch()` → the promise
is the host's `launched` gate (`:1725`, consumed at `host.ts:155,258,299,…`) →
rows reach the user as `SessionDescriptor`s through `listSessions`/`HostEvent` →
Sidebar/TabBar.

**Anchor drift:** engine anchors cited by the row (`envUtils.ts:15-21`,
`sessionStoragePortable.ts:311-331`) still point at the described code. The
in-row **value** `MAX_REGISTRY_SESSIONS=32` is stale.

### P3-3 — Host API: typed control plane (D1 §6.1 / DR-4) + Electron wiring
**Verdict:** OVERSTATED (headline verified; two sub-claims superseded by later
work and never corrected in the row)

**Claims checked:**
1. `host.ts` composes supervisor + registry + spawn-config into five typed
   methods over `hostApi.ts`.
2. `HostErrorCode` is a SEPARATE union from transport `ErrorFrame['code']`
   (F3 §3) — never merged.
3. All results typed; failures are `HostError` values, never bare throws.
4. HC1 cwd revalidation via `validateCwd` (realpath + isDirectory) in `main.ts`;
   renderer never authors a path.
5. HC2 UUID-shape + live∪registry membership on every id → `session_not_found`,
   no throw-through.
6. HC3 preload exposes 5 fixed per-method senders + `subscribeHost` over FIXED
   channels; no generic invoke; picker returns one realpath, never FS contents.
7. HC4 `MAX_REGISTRY_SESSIONS` live-row bound + `MAX_SPAWNS_PER_WINDOW` rate cap
   → `session_limit`.
8. Ready-frame `engineSessionId` relayed into the row (two-id bridge); rows flip
   on status/exit; `registry_unavailable` degrades but never kills.
9. Single-instance lock taken BEFORE host construction; die-with-window
   preserved; fresh-session-per-activate flows through `createSession`.
10. `closeSession` evicts replay (injected `evictReplay`→`AttachmentGate.clearSession`)
    and keeps the row clean+restorable.
11. Zero new wire frames — asserted in a main-source test.
12. B1/B2: `pickDirectory()` returns a one-time TOKEN bound to a main-validated
    realpath (never the path); `resumeEngineSessionId` is off the renderer surface.
13. B3 die-with-window routes through `host.shutdownAll()`.
14. B4 the registry `launch()` promise gates every host op.
15. SF5 restart routes through `host.restartSession`; SF6 `restoreSession`
    rechecks transcript existence; SF7 `listSessions` drops rows neither live nor
    restorable.

**Evidence:**
2. **Verified, and this is the load-bearing one for this lane.**
   `hostApi.ts:118-128` `HostErrorCode` = `invalid_cwd | session_not_found |
   session_limit | spawn_failed | registry_unavailable`.
   `protocol.ts:605-620` `ErrorFrame['code']` = `bad_request |
   turn_already_running | permission_not_found | unauthorized | internal_error |
   session_not_found | session_not_ready | session_disconnected`. Disjoint but
   for the deliberate `session_not_found` overlap, which `hostApi.ts:19-24`
   documents as intentional. **No merge.** `protocol.ts:59-66` imports six
   hostApi *types* — but only to re-surface them on the renderer bridge (the one
   preload reaches both planes), and it imports **no error type**; the two unions
   are declared in their own modules and never union-ed. A third union
   (`SaveTextErrorCode`, `hostApi.ts:157-163`) was correctly kept separate from
   both for the same reason. The rule holds.
3. `hostApi.ts:131-141` (`HostError`/`HostResult`), every `return` in `host.ts`
   is a `HostResult`; `hostError()` at `host.ts:96-98`. TRUE.
4. `main.ts:1281` (`validateCwd(result.filePaths[0])` at the picker) and
   `host.ts:271-278` (revalidate regardless of origin, and use the returned
   realpath for both row and spawn). TRUE.
5. `host.ts:89-94` `UUID_RE`/`isUuid`, applied at `:301,389,508,562,605,691`
   before any lookup. TRUE.
6. **Superseded.** `app/preload/preload.ts` now exposes ~10 host senders
   (`pickDirectory`, `createSession`, `restoreSession`,
   `createSessionInWorkspace`, `previewSession`, `closeSession`, `listSessions`,
   `sessionsCatalog`, `openHistorySession`, `saveTextToFile`, …) not 5. The
   *principles* still hold: each is a fixed named channel constant, there is no
   generic invoke, and the picker returns a token string, never FS contents.
7. **Superseded.** The live bound is now `MAX_LIVE_SESSIONS`
   (`hostApi.ts:245`, checked at `host.ts:717`), split from
   `MAX_REGISTRY_SESSIONS` on 2026-07-26 precisely so raising the row bound would
   not raise the fork-bomb cap (`hostApi.ts:238-243`, `registry.ts:57-60`). The
   row still names `MAX_REGISTRY_SESSIONS` as the live-row bound, which is now
   the opposite of what source says that constant is for. Rate cap verified at
   `host.ts:721-729` (`MAX_SPAWNS_PER_WINDOW=8` / `SPAWN_RATE_WINDOW_MS=10_000`).
8. `host.ts:175-180` relay; `:204-248` exit/status → `markParked`/`markCrashed`
   + `emitStatus`; `:891-898` `surfaceRegistryHealth` logs and returns, never
   throws. TRUE.
9. `main.ts:1802` `requestSingleInstanceLock()` at module scope; `ensureHost()`
   is only reached at `:1825` inside `whenReady` in the else-branch, and again at
   `:1832` on `activate`. Nothing constructs a host without the lock. `:1844-1850`
   `shutdownRuntime` → `host.shutdownAll()`. `:1752` primary session via
   `host.createSession`. TRUE.
10. `host.ts:506-545` — `killSession` → `evictReplay` → `markClean` → emit
    status-or-removed based on `descriptor.restorable`. `main.ts:1732-1736` binds
    `evictReplay` to `persistTranscriptCache` + `cancelReplayFlush` +
    `attachmentGate.clearSession`. TRUE.
11. `app/main/mainSourceGuards.test.ts:118-143`. It is a source-TEXT guard (it
    greps `main.ts` for `type: 'host.` and allowlists every `forward(…, {type:…})`
    literal). Weak as proof-of-behavior but exactly what the row claims
    ("asserted in a main-source test"). TRUE as stated.
12. `main.ts:1259-1284` — the handler returns `cwdTokens.mint(chosen.realpath)`,
    never the path; `:1287-1308` `CH_HOST_CREATE` reads only `cwdToken` + `title`
    and `consume()`s the token, failing `invalid_cwd` otherwise.
    `hostApi.ts:64-69` `CreateSessionInput` has no `cwd` and no
    `resumeEngineSessionId`. Enforced by `mainSourceGuards.test.ts:112-116`
    (`not.toMatch(/readString\(…'cwd'\)/)` and
    `not.toContain('resumeEngineSessionId')` in the create handler). TRUE.
    Note `main.ts:1262-1265` has a dev-harness picker bypass; it still routes
    through `cwdTokens.mint`, so it widens *which* path is chosen, never *who*
    authors it.
13/14. `host.ts:661-667`; `host.ts:143,155` + `await this.launched` at the head
    of every mutating method (`:258,299,385,507,561,604`). TRUE.
15. `host.ts:603-649` (restart refreshes advisory fields and re-checks
    `canResume`), `:314-323` (SF6), `:583-587` (SF7 filters on the descriptor's
    own `restorable`). TRUE — and `isRestorable` was later strengthened to a
    read-time transcript check (`:814-843`), which is stricter than the row.

**Reachable-path trace:** renderer "new session" → preload `pickDirectory` →
`main.ts:1259` native dialog → token → preload `createSession(token, title)` →
`main.ts:1287` consume → `host.createSession` → `registry.upsertOnSpawn` +
`supervisor.spawnSession` → `session-added` HostEvent → `wireHostEvents` →
renderer roster/TabBar.

**Anchor drift:** the row cites no `file:line`. Its two constant/count claims
(items 6 and 7) are stale as described.

## Findings

| # | Severity | Row | Defect | Evidence | Failure scenario |
|---|---|---|---|---|---|
| F1 | Medium | P3-2 | Registry `persist()` is a **stale-view full-document write**: it takes the advisory lock and then writes the in-memory `this.doc` wholesale, with **no fresh read under the lock**. The lock prevents torn JSON, not lost updates — the identical shape as the proven `persistPermissionUpdates` defect. Empirically confirmed: two `SessionRegistry` instances on one file, A writes `A-row` (lands on disk), B then writes `B-row`, and the file contains **only** `B-row`. The single-instance lock that is supposed to make this unreachable is keyed on Electron `userData`, which `app.setName('Cat Code Dev')` changes for dev builds — while the registry path is keyed on `CLAUDE_CONFIG_DIR`/`~/.cat-code` and is **not** app-name-keyed. So a dev build and a packaged build are two hosts holding two different single-instance locks over one `registry.json`. `REGISTRY.md:307` claims this race is "defused twice"; only the first defense actually defuses it, and it has this gap. | `app/host/registry.ts:892-932` (persist: lock → `atomicWriteJson(this.doc)`, no re-read); `registry.test.ts:940-970` (asserts parseability only, comment says "last-writer-wins"); `app/main/main.ts:189-190` (`app.setName` before `:1802` `requestSingleInstanceLock`); `app/host/registry.ts:213-221` (registry dir is config-home-keyed, not app-name-keyed) | Operator has the packaged app open and starts `bun run --cwd app dev` (or the reverse). Each instance's next registry write erases every row the other owns. Result: sessions opened in one build silently vanish from the other's sidebar and stop being offered for restore. Transcripts survive (REGISTRY.md A2), so this is roster/restore-offer loss, not conversation loss. |
| F2 | Low | P3-1 | Four `src/…:line` anchors the row cites for "resume composes the engine's REAL machinery" now point at different symbols. The mechanism itself is fully verified; the citations are not. Three of them are also duplicated as stale code comments, so a reader following them lands in the wrong function. | STATUS `conversationRecovery.ts:465` → actual `:510` (465 is `loadMessagesFromJsonlPath`); `sessionRestore.ts:493` → actual `:646`; `state.ts:474` → actual `:495`; `main.tsx:3784-3797` is now the **ccshare** `forkSession:true` branch, not direct-UUID `--resume`; `QueryEngine.ts:145/208` → actual `:148/:224`; `QueryEngine.ts:454` → the submit-time copy is at `:499`. Stale copies live in `app/sidecar/sessionResume.ts:7,13,15` and `app/sidecar/sessionController.ts:390,397`. | A future session verifying "does resume still go through the engine's own machinery?" follows `conversationRecovery.ts:465`, finds an unrelated function, and either concludes the claim is false or re-derives the answer from scratch. |
| F3 | Low | P3-2, P3-3 | Two constants the rows state as fact were renamed/re-valued on 2026-07-26 and the rows were never corrected. P3-2 states `MAX_REGISTRY_SESSIONS=32`; it is 256. P3-3 states HC4's live bound is `MAX_REGISTRY_SESSIONS`; the live bound is now `MAX_LIVE_SESSIONS` and `MAX_REGISTRY_SESSIONS` is explicitly documented as **not** a spawn limit. A reader auditing HC4 from P3-3's text would check the wrong constant and read the fork-bomb cap as 256. | `app/host/registry.ts:72` (`= 256`) with the split rationale at `:57-60`; `app/shared/hostApi.ts:238-245` (`MAX_LIVE_SESSIONS = 32`, "Deliberately SEPARATE from … `MAX_REGISTRY_SESSIONS`"); enforced at `app/host/host.ts:711-719` | Someone raises `MAX_REGISTRY_SESSIONS` again to fix a browsing-evicts-restorables complaint, believes P3-3's text that it is the live bound, and either blocks the fix or thinks they just widened the fork-bomb cap. |
| F4 | Low | P3-3 | Raw control-plane error **codes and internal messages are rendered verbatim to the user**, violating the "no rendered engineering notes / no internal vocabulary" rule. `hostErrorMessage` formats a `HostError` as `` `${error.code}: ${error.message}` `` and the result is displayed as shell error text. Users see strings like `session_limit: at most 32 live sessions`, `invalid_cwd: a valid directory token from pickDirectory() is required`, and `spawn_failed: could not spawn session: <raw JS error>`. Messages authored in this lane (`host.ts`, `main.ts`); rendered by the P3-5 shell. | `app/renderer/src/App.tsx:4705-4707` (`hostErrorMessage`), consumed at `:1240,1259,1822,1864,1985`, rendered at `:3170-3172`. Message sources: `app/host/host.ts:718,726-728,479`, `app/main/main.ts:1300-1303`. | User hits the spawn rate cap by clicking "+" quickly and reads `session_limit: spawn rate cap: 8 per 10000ms` — an internal constant's value and name, with no instruction on what to do. |

## Operator steps required (UNVERIFIABLE-HEADLESS rows only)
None. Every claim in these four rows was settled from source plus existing
headless probes.

## Nits
- `app/scripts/f2-attach-smoke.js` is a committed bundled build artifact of
  `f2-attach-smoke.ts` (same commit, `217985b`). It is not the file anything
  runs; it will silently drift from the `.ts`.
- The two-sidecar smoke is registered in no script (`app/package.json:146` has
  only `test:hardening`) and is not in `bun test app/`. Nothing detects rot.
- `app/host/lifetimeChain.probe.test.ts:115-127` is a doc comment that argues
  with itself mid-paragraph ("asking the same fixture path the mint used by
  re-deriving via the engine is overkill here — instead we make the registry's
  reap a no-op-safe check…"). The test is sound; the prose is not.
- Code-comment anchor drift outside my rows' claims:
  `app/main/openHistorySession.ts:25` cites `app/host/host.ts:213` for the
  fresh-appSessionId mint (actual `:285`); `app/host/registry.ts:112` cites
  `app/host/host.ts:332` for restore replaying the row's own title (actual `:367`).
- Two-id model: I scanned the host plane for `appSessionId`/`engineSessionId`
  conflation and found none. `openHistorySession.ts:91-93` correctly matches an
  engine id against `descriptor.engineSessionId`; `registry.fillEngineSessionId`
  keeps the two parameters distinct; `host.descriptorFromRow` never crosses them.
