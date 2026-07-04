# P3 host-plane integration review (P3-0..P3-3) — cold, by-layer

**Date:** 2026-07-05 · **Reviewer:** cold session (no prior context) · **Scope:** the four
host-plane sessions P3-0 (36551d3), P3-1 (c193258), P3-2 (ab319f2), P3-3 (c1a1626) plus the
P3-3 review commit (86b1129), read against `decisions/PROTOCOL-ENVELOPE.md`, `REGISTRY.md`,
`SESSION-LIFETIME.md`, `SECURITY-MINIMUM.md` (+Addendum). Focus: the seams BETWEEN the four
sessions, per the review charter. Per-session findings already fixed in 86b1129 were
reconciled, not re-reported.

## Verdict

| Unit | Verdict | One line |
|---|---|---|
| P3-0 envelope N-hardening | **GREEN** | All five F3 §6 additive gaps are real, tested code; verified in source. |
| P3-1 spawn-config + resume | **YELLOW** | cwd/env plumbing and loud-fail resume are solid, but the resume delivers id-adoption + transcript continuity only — the loaded history never reaches the engine it hands over (F1). |
| P3-2 registry | **GREEN** | Disciplined, hermetic, conservative sweep; write discipline honored; the orphan sweep was live-validated *during this review* (see §Gates). |
| P3-3 host API + wiring | **GREEN with nits** | HC1–HC4 hold end to end; the 86b1129 blocker fixes all verified present; control plane provably off the wire. |
| **Layer as a whole** | **YELLOW** | One Critical seam defect (F1) + one unowned design gap (F2) sit exactly where P3-5's restore surface and P3-8's gate will land. Everything else composes correctly. |

**Does anything block P3-5?** Not the parts P3-5's gate-half needs. Two live sessions /
two engine PIDs / switchable / isolated is fully supported and verified by the running code.
**But F1 must be fixed (and F2 decided) before P3-5 builds its restore-offer surface, and
unconditionally before P3-8** — as built, "restore" produces a session that *looks* restored
(same `engineSessionId`, transcript appended) and answers with **amnesia**. That is the
precise failure the D6 anti-Potemkin clause exists to catch; today it would catch it.

**Security baseline (hard gate): NO REGRESSION.** T4/T5a/T6/T6b/T7 enforcement in
`app/sidecar/sidecarServer.ts` is unchanged and tested; directional caps intact
(`MAX_FRAME_BYTES` inbound at the sidecar, `MAX_OUTBOUND_FRAME_BYTES` at the supervisor
decoder); secretGuard on every non-error outbound frame; preload still default-deny with
fixed channels only. T8/HC1 verified as a chain: renderer holds only an opaque one-time
token (`app/preload/preload.ts:104-117`) → main mints/consumes it single-use
(`app/main/main.ts:481-497`) → host revalidates realpath+isDirectory regardless of origin
(`app/host/host.ts:190-200`) → supervisor sets spawn cwd + host-owned env
(`app/supervisor/supervisor.ts:212-230`) → sidecar re-checks the directory fail-loud
(`app/sidecar/index.ts:63-77`). HC2 (UUID + membership, fuzz-tested), HC3 (five fixed
per-method channels, no generic invoke), HC4 (row bound + spawn rate cap) all present with
regression tests. `bypassPermissions` still rejected at the boundary.

## Gates re-run (this review, working tree = migration @ 5f9b129 + local docs edits)

- `bun test app/` — **285 pass / 0 fail** (includes the real-sidecar P3-1 probes and the
  two-sidecar routing tests).
- `bunx tsc --noEmit -p app/tsconfig.json` — clean.
- `bunx tsc --noEmit -p app/sidecar/tsconfig.json` — 5,549 errors, **zero in `app/` files**;
  matches the documented pre-existing engine-graph carry-forward (P1-3).
- `bun run --cwd app test:hardening` — **18/18**, real Electron launch through the host.
  Bonus live evidence: that launch's registry sweep found a genuinely orphaned sidecar from a
  prior run on this machine, matched pid + socketPath + cmdline marker, SIGTERMed it, marked
  the row crashed, and reaped it (`[registry] swept orphaned sidecar pid=55448 …`). The
  §9-A3 kill-only-on-identity path has now executed against a real orphan, not just the
  hermetic tests.

## Findings (ranked)

### F1 — CRITICAL — Restored sessions have no conversation context in the engine
**Seam:** P3-1 ↔ P3-3 (the exact two-id/restore join this review exists for).
**Anchors:** `app/sidecar/index.ts:100` (resume result discarded) →
`app/sidecar/sessionResume.ts:112` (returns the deserialized `Message[]`) →
`app/sidecar/sessionController.ts:147-152` (controller built with no message seed) →
`src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts:10-34` (setup type has no
`initialMessages` field) → `src/QueryEngine.ts:208` (`mutableMessages = config.initialMessages ?? []`).

`resumeEngineSession()` runs the real machinery (`loadConversationForResume` +
`processResumedConversation`), adopts the id, and **returns the loaded messages — which
`index.ts` throws away.** The QueryEngine the sidecar then serves starts with an empty
message list. In the TUI, `--resume` works because `main.tsx:3784-3797` threads those
messages into the REPL as `initialMessages`; the sidecar composes the same loader but not
the same hand-off. Each session was locally correct: P3-1's probe (b)
(`app/sidecar/spawnConfig.probe.test.ts:158-197`) asserts the *loader* returns the nonce —
in a standalone probe process — and P3-3 wired `restoreSession` → spawn-with-resume-id. The
join (loaded messages → the engine that serves the session) belongs to neither session's
spec and does not exist.

**Failure it implies:** P3-8's anti-Potemkin clause (a) — "the engine answers from restored
context" — fails. Worse, the failure is camouflaged: clauses (b) (same `engineSessionId`
appended by a new PID — `recordTranscript` dedupes by UUID and appends, verified at
`src/utils/sessionStorage.ts:1723-1764`, so no data loss) and (c) (resume ran through the
real machinery) both *pass*. D1 R3's own words — the machinery "loads messages … into the
new engine" — are not satisfied.

**Fix shape (small):** plumb `resumeEngineSession()`'s `messages` into
`createSidecarSessionController` → an `initialMessages` slot on the setup →
`QueryEngineConfig.initialMessages` (the field already exists). Secondary benefit: the next
turn's `recordTranscript` chain then continues from the real tail instead of starting a
second parent-null chain in the same JSONL.

### F2 — HIGH — No path exists for restored history to reach the renderer
**Seam:** host plane ↔ P3-5 (design gap, not a code bug).
**Anchors:** `src/web/appSessionProtocol.ts:157-165` (`AppReadyPayload` carries no
messages); `app/shared/protocol.ts:125-144` (no frame kind carries history);
`app/main/replayBuffer.ts` (replay covers only frames produced this run).

Even with F1 fixed, a restored session's renderer transcript starts empty: nothing carries
prior messages across the socket, and the projector builds only from live `EventFrame`s.
The D6 §4 gate line says restored sessions "reopen with their transcript history intact" —
the engine half is F1; the *display* half has no designed mechanism and no owning session
in the P3 backlog. If P3-5 builds the restore surface without this being decided, restore
will look broken to the operator even when the engine context is correct.

**Action:** this is an extend-engine-vs-change-UI decision (C3 precedent — a new app-owned
outbound frame, e.g. a one-shot history snapshot after `ready`, is the obvious shape; the
resumed `Message[]` is already in hand at the right moment in `index.ts`). Decide it before
or at the start of P3-5; ≤1-page proposal per the established pattern.

### F3 — LOW — A sidecar that crashed mid-run is recorded as a *clean* shutdown at quit
**Anchors:** `app/host/host.ts:162-169` (`exit` event → `emitStatus` only; nothing marks
the row) → `app/host/registry.ts:661-682` (`markLiveCleanSync` marks every `shutdown:null`
row clean at quit).
If a sidecar crashes while the app keeps running and the operator later quits normally, the
row's `shutdown` becomes `"clean"`, so the next launch's restore offer mislabels a crashed
session. Advisory-field cleanup is correct either way and the row stays restorable — impact
is a wrong flag in the restore UI, nothing structural. Cheap fix: on a non-`closing` exit
event, mark the row `crashed` (or record exit state for `markLiveCleanSync` to respect).

### F4 — LOW — `restartCount` double-increments on every create/restore
**Anchors:** `app/host/host.ts:287` + `:308` (two `upsertOnSpawn` calls per spawn) →
`app/host/registry.ts:569-576` (existing-row branch increments `restartCount`).
A fresh session lands with `restartCount: 1`; each host restart adds 2. Advisory-only field
("supervisor policy input"), so today nothing misbehaves — but if restart-backoff policy is
ever derived from it, it will be wrong by 2×. Fix: only bump on the actual restart path.

### F5 — LOW — Runtime row reaps emit no `session-removed` HostEvent
**Anchors:** `app/host/registry.ts:529-541` (`enforceBound` on write) — reaped terminal
rows disappear from the registry with no host event; the renderer's "projection of the
stream" retains ghosts until its next `listSessions()` call. Launch-time reaps are fine
(they precede any renderer). Only reachable near the 32-row bound. Note for P3-5: either
emit removals from the host after writes, or have the shell re-snapshot on session-added.

### F6 — LOW — cwd normalization asymmetry can wrongly refuse a restore for non-ASCII paths
**Anchors:** `app/main/main.ts:123-131` (`validateCwd` = realpath only, no NFC) vs the
engine's realpath + **NFC** canonicalization (`src/utils/sessionStoragePortable.ts:333+`),
which feeds `sanitizePath` for the project dir. For a cwd containing decomposed-Unicode
(macOS-typical), the registry's re-implemented `defaultTranscriptPath`
(`app/host/registry.ts:211-233`) can compute a different sanitized dir than the engine
wrote, so `hasTranscript` → false → `restoreSession` refuses a restorable session. ASCII
paths (all current use) unaffected. Fix: `.normalize('NFC')` in `validateCwd` or in
`defaultTranscriptPath`'s input.

### Notes (no action required now)
- **Smoke-exit path bypasses B3:** the `CATCODE_SMOKE_EXIT_MS` hook
  (`app/main/main.ts:690-694`) calls `supervisor.shutdown()` + `app.exit()` without
  `host.shutdownAll()`, leaving `shutdown:null` rows that the next launch reports as
  crashed — this is where the review-run's swept orphan/reaped row came from. Harmless (the
  sweep is the designed janitor and it worked), but hardening/smoke runs do write rows into
  the operator's **real** registry (`~/.cat-code/desktop/registry.json`); row hygiene bounds
  it. If it ever annoys, point the smoke at a temp `CLAUDE_CONFIG_DIR`.
- **`restoreSession` of a live id returns `session_not_found`** with message "already live"
  (`app/host/host.ts:245-250`) — typed and safe, but the code reads oddly for that case;
  P3-5 should key its affordances on `listSessions` status, not on probing restore.
- Supervisor-map records for exited sessions persist until close/restart and count toward
  `liveCount()`; near the 32 bound, dead-but-unclosed tabs can consume create headroom.
- Cosmetic: stray tab-indentation on the three new `ErrorFrame` codes
  (`app/shared/protocol.ts:172-174`).

## Seam-by-seam status (the review charter's checklist)

- **Two-id model end to end — HOLDS.** Mint (`supervisor.ts:188`) → env → sidecar self-check
  → ready-frame `engineSessionId` (`sidecarServer.ts:158-164`) → supervisor schema check
  (`supervisor.ts:520-544`) → host bridges into the row (`host.ts:149-159`) → restore feeds
  it back as `resumeEngineSessionId` → sidecar pins the adopted id and fails loud on
  mismatch (`sessionResume.ts:102-110`). The one break in the chain is F1 (content, not id).
- **Typed failure codes — CONSISTENT.** Transport codes (`session_not_found/not_ready/
  disconnected`) are produced only by main from `SidecarSendError`
  (`main.ts:506-544`), never by the sidecar; the control-plane `HostErrorCode` union is
  separate as F3 §3 mandates, and no call site conflates them. `retryable` semantics match
  the envelope doc (§3) exactly.
- **Durable/advisory split — HONORED by every writer.** Only the host process writes the
  registry; advisory fields are rewritten on spawn/restart, cleared on clean/crash marking,
  and the sweep verifies (pid + socketPath + cmdline marker) before trusting any of them.
  The sidecar never touches the registry file (grep-confirmed: no registry import outside
  `app/host/` + main).
- **Die-with-window + single-instance + sweep — NOT FIGHTING.** Lock taken at module load
  before any host (`main.ts:708`); clean quit routes both `window-all-closed` and
  `before-quit` through `shutdownAll` (idempotent — second call finds no live rows); a
  host crash leaves rows `null` + sockets on disk, which is exactly what the sweep's
  identity check needs; macOS re-activate rebuilds registry+host as a unit and re-runs the
  launch sequence against the already-clean file. One residual blemish is F3 (crashed-then-
  quit labeled clean). Also verified: `registry.launch()`'s read/sweep/reap run
  synchronously at call time (first await is the persist), so `listSessions` cannot observe
  a pre-sweep doc; the B4 gate correctly serializes the *write* interleaving.
- **Control plane off the wire — HOLDS.** No new inbound frame types at the sidecar
  (`checkStrictKeys` allowlist unchanged apart from P2-4's C2); asserted by
  `app/main/mainSource.test.ts:208`.

## Watch items (from the charter)

- **DR-2 same-class, the registry's own file: GREEN.** Single writer by construction +
  advisory `proper-lockfile` + atomic temp/fsync/rename + fail-the-write-never-the-session.
  The one lock bypass (`markLiveCleanSync`) is deliberate, documented, and safe (same
  process, same doc object, atomic rename).
- **DR-2 same-class, shared settings roots: UNCHANGED — and about to become reachable.**
  The host plane neither worsens nor fixes it: `persistPermissionUpdates` settings writes
  and `GenerateImageTool.ts:496` raw refresh remain the flagged unserialized writers. The
  moment P3-5 runs two live sessions, two sidecars can mint always-allow rules into the same
  `settings.local.json` concurrently. Recommend P3-5's verification include exactly that
  (two sessions, each persisting a rule) or an explicit deferral note.
- **N-sidecar `init()` from one config home:** exercised more than before (the P3-0
  two-sidecar smoke and P3-1 probes boot concurrent/serial real engines against a shared
  `CLAUDE_CONFIG_DIR`) with no observed collision; Codex raw-refresh is protected by the
  landed DR-2 fix. Still short of a targeted concurrent-init probe — acceptable to leave to
  P3-8's two-live-session reality.

## Addendum 2026-07-05 — F1 FIXED (same day)

Seed path (app-side only, zero engine-source changes): `app/sidecar/index.ts` keeps the
`resumeEngineSession` result and hands its `messages` to
`createSidecarSessionController({ initialMessages })`, which
`createNormalSidecarQueryEngineConfig` spreads into the `QueryEngineAppSessionConfig`
(`initialMessages` was never in the config type's `Omit` list; `QueryEngine.ts:145/208`
consumes it). Proof: `app/sidecar/resumeSeed.probe.test.ts` +
`resumeSeedProbe.fixture.ts` (child process, house pattern) — real minted transcript →
real resume → the REAL `QueryEngine`'s live `mutableMessages` (the exact state `submit`
copies into the model context, `QueryEngine.ts:454`) contains the pre-quit nonce and
matches the resumed array uuid-for-uuid; tripwire-verified (disabling the seed fails the
test at `engineHeldCount`). The live credentialed answers-from-context proof remains
P3-8's anti-Potemkin gate by design. Gates post-fix: 286/0 tests, app tsc clean, sidecar
tsc unchanged at the pre-existing count (zero in app files), hardening 18/18.

## Addendum 2026-07-05 (later) — F2 DECIDED+IMPLEMENTED; F3–F6 FIXED

**F2 — RESOLVED.** Operator approved the replay-on-attach recommendation as proposed; owning
decision: `decisions/RESTORE-HISTORY.md` (+ dated pointer in `PROTOCOL-ENVELOPE.md` §6). As
landed: the sidecar replays the restored transcript to each attaching connection as standard
`event` frames converted by the engine's own `toSDKMessages`, after `ready`+C3 and before any
live event; one additive field `EventFrame.replay?: true`; newest-tail cap 400 frames / 4 MiB
(`app/shared/limits.ts`, test-enforced STRICTLY below main's replay-buffer budgets so a
renderer reload preserves the same history) with the `catcode.history-truncated` boundary
frame on any omission. The operator's two held seams are test-enforced: same-source-as-F1
(one `resumedMessages` variable, source-grepped + uuid-for-uuid runtime match against the
seeded QueryEngine) and reload preservation (at-cap pass through the real
`AttachmentGate`+`FrameReplayBuffer`). E2E: a REAL resumed sidecar replays its minted
transcript over the wire (`spawnConfig.probe.test.ts` (b)); renders as normal rows with the
flag invisible to reducers (`restoredHistoryRender.test.ts`). Security baseline unchanged:
outbound-only, per-frame `prepareOutboundPayload`+secretGuard+size caps, zero inbound
vocabulary. Field note: the replay faithfully transmits the ENGINE's resumed state, e.g.
recovery's API-validity sentinel replacing an incomplete trailing assistant
(`conversationRecovery.ts:243`) — the mint fixture's assistant never survived resume, which
the old marker-in-JSON assertions masked.

**F3 — FIXED.** Un-asked-for exits and `failed` statuses now `markCrashed` the row
(`host.ts` exit/status handlers; `registry.markCrashed` only transitions live rows, so
`shutdownAll`'s mark-clean-then-kill ordering is unaffected and a mid-run crash is never
relabeled clean at quit). Tests: crash→`crashed` survives quit; failed-spawn→`crashed`;
closeSession still `clean`.

**F4 — FIXED.** The create path's second upsert is now an advisory-only
`registry.setAdvisoryRuntime` (no counter/recency bump); fresh sessions land with
`restartCount: 0`, one restart bumps exactly once. Tests in registry + host suites.

**F5 — FIXED.** `enforceBound` returns the reaped ids; `upsertOnSpawn` surfaces them and the
host emits `session-removed` for each, so a live subscriber's projection drops runtime-reaped
rows. Test: 33rd row over a 32-terminal-row registry emits exactly one removal.

**F6 — FIXED.** `validateCwd` (main) and `defaultTranscriptPath` (registry) both NFC-normalize
(engine `canonicalizePath` parity, `sessionStoragePortable.ts:339-345`); an NFD-spelled cwd
now resolves the engine's NFC-derived project dir. Tests: NFD→NFC transcript resolution +
mainSource NFC assertion.

**All review findings (F1–F6) are now resolved. P3-5 is fully unblocked, restore surface
included.**

## Reconciliation with prior review work

86b1129's seven fixes (B1–B4, SF5–SF7) were each re-verified present and regression-tested;
none re-reported. STATUS row wording for P3-1 is *accurate but narrow*: "resumed Message[]
contains prior nonce (engine-side)" is true of the loader in a probe process — the row never
claimed the served engine consumes them, and no session owned that claim. That unowned claim
is F1.
