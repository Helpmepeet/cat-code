# V10 adversarial validation: supervisor + preload (A10) + app tooling (A20)

> **Verification provenance:** Claude Opus 5, high effort. Source review of
> `app/supervisor/supervisor.ts`, `app/preload/{preload,rendererIpcGuard,preloadSource.test}.ts`,
> `app/main/{replayBuffer,attachmentGate,transcriptCache,main}.ts`,
> `app/host/registry.ts`, `app/shared/{framing,limits,protocol}.ts`,
> `app/renderer/src/{rawMessageLog,previewTranscriptState,fastRefreshBoundaries.test}.ts`,
> `app/scripts/{reap-orphan-sidecars,hardening-smoke,run-hardening-smoke,harness-demo,harness-demo-driver,dev,devLauncher,sidecar-typecheck,prepare-dev-electron,run-f2-attach-smoke,ram-fleet,ram-probe,ram-measure,ram-corpus-gen}.ts`,
> `app/{tsconfig.json,eslint.config.js,package.json,.gitignore}`.
> **Nine standalone scratch artefacts**, including **two real Electron processes**
> launched from the scratchpad (never the desktop app, hidden windows, immediate
> exit) — one settling `app.exit()`'s lifecycle semantics, one driving the **REAL
> `SidecarSupervisor`** through a real `child_process.spawn` and `app.exit()`; one
> **real engine sidecar** booted in isolation against a temp `CLAUDE_CONFIG_DIR`
> to measure RSS; the **real `reap-orphan-sidecars.ts` dry run** (never
> `--confirm`) against a benign decoy I spawned and killed by recorded pid; and a
> mutation harness re-running `preloadSource.test.ts`'s own regexes over modified
> copies of `preload.ts` in the scratchpad. Two focused test files run
> (`app/preload/preloadSource.test.ts`, `app/scripts/prepare-dev-electron.test.ts`
> — 6 pass / 0 fail). Raw `tsc -p app/sidecar/tsconfig.json` run read-only.
> No GUI, no `bun run --cwd app dev`, no `test:hardening`, no full suite, no repo
> edits, no `--confirm` reap, no pattern kill. Branch `migration` at `a1012b1`.
>
> **Working-tree state:** `app/` does not exist on `main` (`git ls-tree -r main -- app/`
> → 0 files), so every file both reports cite is branch-new. Of the cited files,
> exactly **two are DIRTY**: `app/scripts/dev.ts` (+11/−1: adds `repoRoot` at `:30`
> and `CATCODE_INITIAL_CWD` to the Electron env at `:128-140`, shifting everything
> below `:128` by **+7**; A20-F3's `:95-118` and `:185-190` are working-tree
> numbers and are `:95-118` / `:178-183` at HEAD) and `app/main/main.ts` (−1 net, a
> 3-line comment edit at `:998-1005`). Neither diff touches any mechanism either
> report describes. `supervisor.ts`, `preload.ts`, `rendererIpcGuard.ts`,
> `replayBuffer.ts`, `attachmentGate.ts`, `reap-orphan-sidecars.ts`,
> `hardening-smoke.ts`, `sidecar-typecheck.ts`, `prepare-dev-electron.ts`, all
> `ram-*.ts`, `eslint.config.js` and `tsconfig.json` are clean.

## Overall verdict

Both reports are substantially right on mechanism and unusually accurate on
`file:line` (~70 citations checked, all within ±2). Of 27 findings, **19 are
CONFIRMED, 6 PARTIALLY CONFIRMED, 1 OVERSTATED, 1 DUPLICATE**; none is invalid or
mis-located. The A10 HIGH is not just confirmed, it is **understated**: I ran the
reaper's dry run and it selected a benign decoy I had spawned, and
`--marker bun` — the documented packaged-binary override — selected **15
processes to SIGTERM**, including macOS `powerd`, four `containermanagerd`
instances, `ctkahp`, `coreautha`, Spotlight's metadata worker, SafariBookmarks,
**and another agent session's live `bun test app/`** (the substring `bun` matches
`bundle`). The A20 HIGH's *mechanism* is proven end-to-end — I drove the real
supervisor through `app.exit()` in a real Electron process and got a surviving
child at `ppid 1` and a surviving `/tmp/catcode-<pid>` — but its *headline*
("every green `test:hardening` run orphans a ~230 MB sidecar") is UNPROVEN
against the live harness and contradicted by this machine's state, which is the
operator's observation reconciled below. Three corrections matter beyond that.
**A10-F7 is refuted at the user-visible layer**: the truncation banner it says
users are shown is dropped by request id in *both* renderer consumers, with a doc
comment naming the exact bug the report claims is still live. **A10's preload
clean bill has an inverted mechanism**: the `assertAllowed`-at-29 pin catches a
*guarded* new sender, not an unguarded one — I proved an unguarded
`ipcRenderer.send('catcode:exfiltrate', …)` passes every assertion in
`preloadSource.test.ts`. **A20's two clean bills both re-prove**, including the
`sidecar-typecheck.ts` one the operator cited to the room. The one thing that
most deserves action is `reap-orphan-sidecars.ts`: it is a documented, wired
`package.json` script (`reap:orphans`) whose `--confirm` path would SIGTERM
system daemons on a plausible flag value.

## Reconciling the operator's `test:hardening` observation

The operator ran `bun run --cwd app test:hardening` earlier in this session, saw
19/19 green, and observed **no live sidecar and no new `/tmp/catcode-*`
directory**. Four facts settle what that means.

1. **`app.exit()` really does skip the teardown.** A scratch Electron process
   with `window-all-closed`, `before-quit`, `will-quit` and `quit` listeners,
   calling `app.exit(0)` after loading a hidden window, logged **only `quit`**.
   The socket dir it had created survived.
2. **The supervisor's socket dir is created unconditionally in its constructor**
   (`supervisor.ts:194-196`), before any spawn, and **`shutdown()` is the only
   thing that removes it** (`:387`). Proven with the real class: the dir survives
   `killSession`, and disappears only on `shutdown()`.
3. **Therefore a hardening run that reaches `ensureHost()` must leave a dated
   `/tmp/catcode-<pid>` behind.** My own real-supervisor Electron probe did
   exactly that (`/tmp/catcode-32460`, mtime today).
4. **There is no such directory from today.** All 86 `/tmp/catcode-*` dirs bucket
   as 2 × 08-02, 24 × 08-04, 26 × 08-05, 9 × 08-06, 25 × 08-07 — **zero on
   08-08**. Independently, the userData dir this Electron writes when
   `app.isPackaged` is forced true, `~/Library/Application Support/@cat-code/desktop`,
   was last touched **2026-08-07 22:15:54** (`Session Storage`, `blob_storage`
   same). My throwaway Electron probes each created their own userData dir with
   today's timestamp, so a launch does bump it.

**Conclusion: no Electron process of this app launched today.** The green
`test:hardening` the operator remembers did not run its Electron stage in this
session, so the absence of an orphan is not evidence that the harness cleans up
after itself — it is evidence that the harness did not run. The claim is neither
confirmed nor refuted by that observation.

Two facts I established that make the next attempt conclusive, and that neither
report has:

- **A surviving sidecar makes the harness hang for the full 20 s but still report
  green.** `run-hardening-smoke.ts:68-73` uses `spawnSync` with piped stdio, and
  the sidecar inherits main's stdout/stderr (`supervisor.ts:252`
  `stdio: ['ignore','inherit','inherit']`). I measured that Node's `spawnSync`
  **waits for grandchild pipe EOF**, not just child exit (6,011 ms for a 6 s
  grandchild whose parent exited immediately). On the `timeout: 20_000` expiry
  `spawnSync` sets `error = ETIMEDOUT` but leaves `status` at the child's real
  exit code — and `run-hardening-smoke.ts:77-84` checks `status` and the stdout
  marker and **never checks `smoke.error`**, so the run is reported as a pass.
  **Run duration is therefore the tell**: a fast green run means no orphan; a
  green run that sits for ~20 s after printing 19/19 means one.
- **A real sidecar's RSS is 282 MB, not ~230 MB.** I booted one in isolation
  (temp `CLAUDE_CONFIG_DIR`, temp cwd, 90 s idle TTL, pid recorded and killed):
  it reached `[sidecar] READY`, bound its socket, and sat at **288,448 KB RSS**.
  So it boots fine under a fresh config — the "the sidecar probably fails to
  start in the harness" escape hatch is closed.

The one-command settlement: run `test:hardening`, time it, then immediately
`ls -ldt /tmp/catcode-* | head -1` and
`ps -axo pid,ppid,rss,command | grep '[s]idecar/index.ts'`.

## Summary

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| A10-F1 | HIGH | Orphan reaper kills by cmdline pattern, not owned pid | CONFIRMED | Dry run selected my benign decoy; `--marker bun` selects `powerd`, `containermanagerd`, and another session's `bun test app/` |
| A10-F2 | MED | Socket dir predictable, 0755, no ownership check | PARTIALLY CONFIRMED | Dir 0755 + no check confirmed; but the socket inode is `srwxr-xr-x`, so "anything that can connect" overstates it |
| A10-F3 | MED | Teardown is SIGTERM-only, child handle dropped | CONFIRMED | No escalation, no retained pid; 86/86 stale socket dirs on this machine |
| A10-F4 | MED | Socket filenames collide across supervisor generations | CONFIRMED | Proven: a second supervisor over the same dir reissues `s0.sock` |
| A10-F5 | MED | Renderer restart has no cooldown | DUPLICATE | Same defect as A08-F2 / A09-F2; V08 measured 121 real spawns, 0 refusals |
| A10-F6 | MED | `Date.now()` rate guard wedges on a backward clock step | PARTIALLY CONFIRMED | Wedge proven (3,601 s to recover); "no recovery short of restart" is false — a renderer reload re-mints the guard |
| A10-F7 | MED | Replay truncation sticky, and its banner miscounts | OVERSTATED | Code claims hold; the banner is dropped by id in BOTH renderer consumers, so no user ever sees it |
| A10-F8 | MED | Frame byte accounting re-serializes twice at steady state | PARTIALLY CONFIRMED | 2.00 encodes/frame proven; cost measured at 0.7 ms/s — the perf framing does not survive |
| A10-F9 | LOW | `isObjectRecord` guard runs after the dereference | CONFIRMED | Proven: a `null` payload throws `TypeError` at `frame.kind`; main has no `uncaughtException` handler |
| A10-F10 | LOW | Frame-layer rejection leaves the child running | CONFIRMED | Both branches `setStatus`+`destroy` with no `record.child.kill`, unlike `:434` |
| A10-F11 | LOW | Size-cap violations throw an untyped `Error` | CONFIRMED | Verified end to end; the byte-count string renders at `App.tsx:4305-4306` |
| A10-F12 | LOW | Tumbling window documented as sliding | CONFIRMED | `limits.ts:28` says "Sliding-window"; the guard resets wholesale |
| A10-F13 | LOW | Promise-returning bridge methods throw synchronously | CONFIRMED | All 10 control-plane methods; guard precedes `invoke`, none is `async` |
| A20-F1 | HIGH | `app.exit()` skips `before-quit`, orphaning sidecars | PARTIALLY CONFIRMED | Mechanism proven with a real Electron + the real supervisor; the per-run claim is unproven and this machine shows no run today |
| A20-F2 | MED | "hardening 19/19" covers the renderer document only | CONFIRMED | 20 `add()` sites / 19 green; zero client frames, zero socket writes; vacuity count is **5** |
| A20-F3 | MED | `dev.ts` arms signal handlers after the readiness wait | CONFIRMED | Vite spawned `:95`, handlers `:185/:188`; child not detached, so a single-pid SIGTERM orphans it |
| A20-F4 | MED | `harness-demo.ts` re-implements `terminateChild`, leaks Electron | PARTIALLY CONFIRMED | Duplication real; the claimed race is impossible, and `child.kill()` does reach Electron via the shim |
| A20-F5 | MED | `preview-transcript.tsx` is in no tsconfig | CONFIRMED | `tsconfig.json:29` globs `scripts/**/*.ts`; `.tsx` is not matched |
| A20-F6 | MED | eslint registers two plugins, enables zero of their rules | CONFIRMED | `plugins` `:17-21`, `rules` holds one `react-refresh` entry |
| A20-F7 | MED | `ram-fleet.ts` duplicates `ram-probe.ts`; `parseArgs` ×4 | CONFIRMED | Six helpers duplicated at the exact cited ranges; `parseArgs` in all four scripts |
| A20-F8 | LOW | `sidecar-typecheck.ts` swallows a locationless error | PARTIALLY CONFIRMED | Predicate gap proven with a synthetic input; no real tsc invocation produces the combination |
| A20-F9 | LOW | `repoRoot` from `URL.pathname` is percent-encoded | CONFIRMED | Proven: a path with a space yields a non-existent dir; neighbours use `fileURLToPath` |
| A20-F10 | LOW | `fastRefreshBoundaries.test.ts` is non-recursive | CONFIRMED | `readdirSync(here)` at `:16`, flat listing only |
| A20-F11 | LOW | Stale `.gitignore` entry, one bundle never cleaned | CONFIRMED | `.gitignore:6` says `.js`, the emit is `.cjs`; `f2-attach-smoke.js` (24,040 B, Jul 6) is on disk now |
| A20-F12 | LOW | Unvalidated numeric argv in the `ram-*` scripts | CONFIRMED | `--n`/`--cap` validated; `--settle-ms` and six others are not |
| A20-F13 | LOW | `ram-fleet.ts` emergency cleanup leaves `/tmp/ramfleet-*` | CONFIRMED | `emergencyCleanup` `:204-210` has no `rmSync`; the normal path does at `:492` |
| A20-F14 | LOW | `ram-measure.ts` drops an unparseable rep | CONFIRMED | Non-zero exit pushes a placeholder `:129-133`; the parse `catch` `:136-138` pushes nothing |

## Per finding — A10

### A10-F1 — [HIGH] Orphan reaper kills by command-line pattern match, not by owned pid

- **Verdict**: CONFIRMED — and understated
- **Cited location holds?**: Yes, all three. `reap-orphan-sidecars.ts:53-76` is
  `listMatchingProcesses`, whose only filters are `pid === self` and
  `command.includes(marker)`. `:83-95` is `partitionOrphans`, whose only test is
  `proc.ppid === 1 || !isProcessAlive(proc.ppid)`. `:141` is
  `const marker = markerIdx >= 0 && argv[markerIdx + 1] ? argv[markerIdx + 1]! : DEFAULT_MARKER`.
  The registry is never imported: the file's only imports are
  `node:child_process`, `node:fs`, `node:os`, `node:path` (`:29-32`). The
  contrast is accurate too — `registry.ts` `sweepOrphans` iterates
  `this.doc.sessions` and only ever probes `row.enginePid`, and
  `matchesSidecarIdentity` requires **four** things (recorded pid, alive, the
  row's `socketPath` still on disk, cmdline marker) before it kills.
- **Reachable in production?**: Yes, and it is wired, not dead:
  `app/package.json:18` `"reap:orphans": "bun run scripts/reap-orphan-sidecars.ts"`.
  No env gate, no feature flag.
- **Trigger — constructed and observed, without killing anything.** I spawned a
  benign process that is *not* a sidecar, has no registry row, and merely carries
  the marker in its argv (a scratch `app/sidecar/index.ts` under my scratchpad,
  run as `bun run app/sidecar/index.ts`, left to reparent to `ppid 1`), then ran
  the reaper's **dry run**:
  ```
  Orphaned-sidecar cleanup (marker: "app/sidecar/index.ts")
  matched 1 sidecar process(es): 1 orphaned, 0 with a live parent (kept).

  ORPHANS (parent dead) — would SIGTERM:
    pid=34831 ppid=1  bun run app/sidecar/index.ts
  ```
  Then the documented packaged-binary override, still dry:
  ```
  Orphaned-sidecar cleanup (marker: "bun")
  matched 17 sidecar process(es): 15 orphaned, 2 with a live parent (kept).

  ORPHANS (parent dead) — would SIGTERM:
    pid=338   /System/Library/CoreServices/powerd.bundle/powerd
    pid=408   /usr/libexec/containermanagerd_system --runmode=privileged --bundle-c…
    pid=538/547/557/643/1397/23458  /usr/libexec/containermanagerd --bundle-container-mod…
    pid=957/964  …/CryptoTokenKit.framework/ctkahp.bundle/…/ctkahp
    pid=979   …/Metadata.framework/…
    pid=1364  …/SafariSupport.bundle/…/SafariBookmar…
    pid=33961 …/LocalAuthentication.framework/…/coreautha.bundle/…
    pid=10941 bun test app/
    pid=34831 bun run app/sidecar/index.ts
  ```
  I killed my decoy afterwards with `kill 34831`, the pid I recorded at spawn.
- **Counter-arguments considered**:
  1. *Does the parent-dead filter save it?* No. On macOS anything reparented to
     launchd is `ppid 1`; every system daemon above qualified, and so did a live
     `bun test app/` (pid 10941) belonging to another session on this shared
     tree — the exact scenario `CLAUDE.md` §8 and `.claude/hooks/block-sweep-kill.sh`
     exist to prevent.
  2. *Is `--marker bun` a strawman?* No — it is the file's own documented usage
     (`:24`, "override cmdline marker (packaged binary)"), and the packaged
     sidecar is a Bun `--compile`d binary, so `bun` is the natural guess. The
     amplification is worse than the report says: `bun` is a **substring of
     `bundle`**, which is why `powerd.bundle`, `ctkahp.bundle` and
     `coreautha.bundle` matched.
  3. *Is `SIGTERM` mild enough not to matter?* Not for `powerd` or
     `containermanagerd`; and the process would run as the operator, so the
     `EPERM`-means-alive guard at `:46-49` does not protect user-owned system
     agents.
  4. *Does the dry-run default make this safe?* Partly. The default is DRY
     (`:139, :175-180`), and `--confirm` is required — real mitigation, and worth
     saying, but the script's own summary line ("Re-run with --confirm to SIGTERM
     the orphans") invites exactly the dangerous run.
- **Corrections to the report.** Two of its three named victims are narrower than
  written. (a) *"An editor holding `app/sidecar/index.ts`"* — only true for
  editors that carry the path in argv (`vim app/sidecar/index.ts`, `less`,
  `bat`); a GUI editor holding the file open has no such argv and never matches.
  (b) *"another agent session's worktree sidecar"* — matches the substring, but
  only becomes a victim once its supervisor is dead, at which point it genuinely
  is an orphan. The victim I actually observed is better than either: a live
  `bun test app/`. The report's core claim — selection ignores recorded pids —
  is exactly right.
- **True consequence**: A wired repo script whose `--confirm` path SIGTERMs
  processes chosen by an unanchored substring over every process on the machine.
  At the default marker it hits any process whose argv mentions that path; at a
  plausible override it hits macOS system daemons and other sessions' work.
- **Evidence**: two dry runs above; `reap-orphan-sidecars.ts:29-32,46-49,53-76,83-95,139,141,175-180,184-192`;
  `app/host/registry.ts` `sweepOrphans` / `matchesSidecarIdentity`;
  `app/package.json:18`.
- **Disposition**: Apply the report's fix — drive candidates from the registry
  document (`enginePid` + recorded `socketPath`) and reuse
  `matchesSidecarIdentity`'s two-signal test, keeping parent-dead as an
  additional filter. Two amendments. (1) **Delete `--marker` entirely** rather
  than "dropping it in registry-less mode": the registry row already carries the
  identity, so the flag has no remaining job, and its existence is what turns a
  typo into a system-daemon sweep. (2) If a registry-less mode is kept at all,
  anchor the match instead of using `includes` — require the marker to be a whole
  argv element — because the `bun`/`bundle` collision is a substring bug
  independent of the ownership bug.

### A10-F2 — [MED] Socket directory is predictable and world-traversable, with no ownership check

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: Yes. `supervisor.ts:188-197` is the `socketDir`
  default (`/tmp/catcode-${process.pid}` on POSIX) followed by
  `if (!existsSync(this.socketDir)) mkdirSync(this.socketDir, { recursive: true })`
  — no `mode`, no `lstat`, no owner check. The three safe-pattern citations are
  exact: `ram-probe.ts:218`, `ram-fleet.ts:397`, `supervisor.test.ts:69` all use
  `mkdtempSync`.
- **Reachable in production?**: Yes, unconditionally — `createSupervisor()`
  (`main.ts:635-644`) passes no `socketDir`, so every launch takes the default.
- **Trigger / measurements**: I drove the real class. The constructor created
  `/tmp/catcode-<pid>` at **mode 0755, uid 501**. Handing it a pre-existing
  directory it did not create was accepted silently, with no `lstat` and no
  refusal. `/private/tmp` is `drwxrwxrwt`, so any local user can create
  `catcode-<n>` entries in advance.
- **Counter-arguments considered**:
  1. *Is the socket file itself 0600, closing sub-claim (a)?* This is the item
     A10 filed as unresolved, and I resolved it: I booted a **real sidecar** and
     inspected the live socket. It is `srwxr-xr-x` — **0755**, not 0600. That
     cuts both ways. It confirms the sidecar does no `chmod` (the report's
     suspicion), but it also means **no group/other write bit**, and write
     permission on the socket inode is exactly what `connect(2)` checks on Linux
     and modern Darwin. So the report's "anything that can connect to that socket
     drives the engine with full tool permissions" does not follow: on a
     permission-enforcing platform a non-owner cannot connect at 0755. The
     `0700` parent is defence in depth here, not the only thing standing in the
     way.
  2. *Does sub-claim (b), the pre-creation squat, survive?* Yes — it is the real
     half. Pre-creating `/tmp/catcode-<pid>` short-circuits the `existsSync`, and
     the supervisor then writes its socket into an attacker-owned, non-sticky
     directory where the socket file can be unlinked and replaced.
  3. *Does a successful squat give engine control?* **No, and the report does not
     claim it does.** `validateReadyFrame` (`:583-607`) requires the exact
     `sessionId`, a `randomUUID` the squatter never sees (it travels by env to
     the child, not over the socket), so a fake peer lands on `failed`. The
     realistic payoff is a **crash of Electron main** via A10-F9 — the squatter's
     first frame can be a bare `null`, and `frame.kind` is read at `:462` before
     any validation. That is the chain worth naming, and the report is right to
     connect the two findings.
- **True consequence**: A predictable, unverified, world-traversable directory in
  world-writable `/tmp`, squattable in advance, whose realistic exploit is a
  main-process crash (and, per A08-F5, an orphaned engine fleet), not engine
  takeover.
- **Evidence**: `scratchpad/v10/f-socketdir.ts` output (`mode: 755 uid: 501`;
  pre-created dir accepted); live sidecar socket `srwxr-xr-x`; `ls -ld /private/tmp`
  → `drwxrwxrwt`; `supervisor.ts:188-197,246-249,583-607`.
- **Disposition**: Apply the fix, with the severity restated. `{ recursive: true,
  mode: 0o700 }` plus an `lstatSync` owner/mode refusal on a pre-existing
  directory is two lines and correct. But justify it on **squat prevention**, not
  on "anything that can connect": the socket is already 0755, so the connect
  argument will be rejected by anyone who checks. Land it **with** A10-F9's
  one-line hoist, which is the actual damage in the squat scenario — the
  directory fix alone still leaves `frame.kind` on a `null` in the crash path
  for any other route to the socket.

### A10-F3 — [MED] Teardown is SIGTERM-only, and the child handle is dropped immediately

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `killSession` at `:356-363` is
  `record.socket?.destroy(); record.child.kill('SIGTERM'); this.cleanupSocketFile(record); this.registry.delete(sessionId)`
  — four synchronous statements, no grace, no escalation, and the `delete` drops
  the only reference to the `ChildProcess`. `shutdown()` at `:379-391` is that in
  a loop plus `rmSync(this.socketDir, …)`. `devLauncher.ts:106-126` is
  `terminateChild` with SIGTERM → bounded grace poll → SIGKILL and the
  "abandoned [the child] to the operator's machine" doc comment, exactly as
  cited. `app/sidecar/index.ts:58` is `DEFAULT_SIDECAR_IDLE_TTL_MS`.
- **Reachable in production?**: Yes on every exit route — `shutdownRuntime()` is
  called from `window-all-closed` (`main.ts:1903`), `before-quit` (`:1927`) and
  `teardownOnSignal` (`:1891-1899`).
- **Trigger**: A sidecar inside a long synchronous engine operation, or one that
  has not yet installed its SIGTERM handler (`app/sidecar/index.ts:371`) because
  it is still booting. My isolated boot measured a **282 MB** resident engine, so
  the survivor is expensive.
- **Counter-arguments considered**:
  1. *Does the 15-minute idle TTL make this moot?* It bounds it, and the report
     says so. But the TTL is cancelled by a live connection, so it only starts
     counting after the socket drops — it is a backstop, not a teardown.
  2. *Does `registry.sweepOrphans` on the next launch clean up?* Only for rows
     with `shutdown == null` where `matchesSidecarIdentity` holds — and one of its
     four signals is that the recorded `socketPath` still exists, which
     `shutdown()`'s `rmSync` of the whole directory has just destroyed. So the
     supervisor's own teardown can make its own survivors unsweepable.
  3. *Is the empirical `/tmp` evidence still true?* The number moved and will keep
     moving: **86 dirs today, 86 of them with a dead owning pid** (the reaper's
     own dry-run stale list), against the report's 98/97. Same shape, different
     count — re-measure rather than quoting either figure.
- **True consequence**: A blocked sidecar is unreachable to the supervisor that
  spawned it the moment SIGTERM is sent, and survives up to 15 minutes at ~282 MB.
- **Evidence**: `supervisor.ts:356-363,379-391`; `devLauncher.ts:106-126`;
  `app/sidecar/index.ts:58,371`; live count 86/86.
- **Disposition**: Apply the report's fix (a `pendingKills` set, an unref'd grace
  timer, SIGKILL on expiry, reusing `terminateChild`'s shape). Add one thing it
  omits: **do not `rmSync` the socket directory in `shutdown()` until the grace
  window has elapsed**, or the escalation will still leave rows the next launch's
  identity check refuses to sweep (counter-argument 2). The next launch's own
  `existsSync` stale-socket removal at `:246-249` already handles a leftover file.

### A10-F4 — [MED] Socket filenames collide across supervisor generations in the same process

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `:149-150` is the doc comment plus
  `private socketSeq = 0` (instance field). `:239` is
  `const socketPath = join(this.socketDir, \`s${this.socketSeq++}.sock\`)`.
  `main.ts:1698-1700` is `ensureHost()`'s `if (host) return host; supervisor = createSupervisor()`.
- **Reachable in production?**: Yes on macOS. `window-all-closed` nulls
  `supervisor` and `host` without quitting on darwin (`main.ts:1903-1925`), and
  `app.on('activate')` calls `ensureHost()` (`:1830`), constructing a second
  supervisor in the same process with the same `/tmp/catcode-${process.pid}`.
- **Trigger — reproduced.** Two real supervisors over one directory:
  ```
  gen1 sockets: /tmp/catcode-seqprobe-<pid>/s0.sock  /tmp/catcode-seqprobe-<pid>/s1.sock
  gen2 first socket: /tmp/catcode-seqprobe-<pid>/s0.sock
  COLLIDES with gen1 first: true
  ```
- **Counter-arguments considered**:
  1. *Does `shutdown()`'s `rmSync` of the directory make the collision harmless?*
     No — it removes the directory, and the next constructor recreates it, but the
     dying gen-1 sidecar's SIGTERM handler (`app/sidecar/index.ts:365-370`) then
     `unlinkSync`es `args.socketPath`, which now names the **new** generation's
     live socket.
  2. *Does the stale-socket removal at `:246-249` cover it?* It runs **before**
     the spawn, so a delete landing after that check wins.
  3. *Does `connectWhenReady` recover?* No — it polls `existsSync` for
     `MAX_ATTEMPTS = 200` (~10 s) and then marks `failed` and SIGTERMs a healthy
     child (`:428-436`). The report's described outcome is what the code does.
  4. *Is this the same finding as A08-F4?* Related but distinct. A08-F4 is about
     the shared **directory** across generations; this is about the **filename
     counter** restarting. One fix (a per-process or random component) closes
     both, which is why they should land together.
- **True consequence**: On a fast dock-reopen, the new session's socket file can
  be deleted by the previous generation's dying sidecar, costing a ~10 s stall
  and a `failed` session with a healthy child killed underneath it. The secondary
  damage the report names is real: a live sidecar whose `socketPath` no longer
  exists can never satisfy `matchesSidecarIdentity`, so it is permanently
  unsweepable.
- **Evidence**: `scratchpad/v10/f-socketdir.ts` output above;
  `supervisor.ts:149-150,239,246-249,428-436`; `app/sidecar/index.ts:365-370`;
  `main.ts:1698-1700,1830,1903-1925`.
- **Disposition**: Apply, and prefer the report's *second* option — append
  `randomBytes(3).toString('hex')` to the filename — over seeding `socketSeq`
  from a module-level counter. A module counter still collides across two
  Electron processes that happen to share a directory (which A08-F4's pid-scoped
  naming already permits after pid reuse), whereas the random suffix closes both.
  The `sun_path` guard at `:240-245` already covers the extra 7 bytes.

### A10-F5 — [MED] Renderer-driven restart has no cooldown: 120 engine spawns per second

- **Verdict**: DUPLICATE — of **A08-F2** and **A09-F2**, both CONFIRMED in `V08`
- **Cited location holds?**: Yes. `main.ts:1203-1210` is the `CH_RESTART`
  handler; `host.ts:603-648` is `restartSession` with neither `checkSpawnLimits()`
  nor `recordSpawnTime()`.
- **Reachable in production?**: Yes — established in `V08` and not re-measured
  here.
- **Trigger**: As A08-F2.
- **Counter-arguments considered**: I checked whether A10 adds anything A08/A09
  do not. It does not, and one of its numbers is a floor rather than the figure:
  `V08` drove the **real** supervisor and registry and measured 120 restarts
  completing in **20 ms** (≈6,000 spawns/sec), with the preload's 120/s the only
  cap in the chain. A10's "sustains 120 Bun processes/second" is therefore a
  lower bound, not the ceiling. Its extra observation — that `restartCount` is
  recorded but never read as a circuit breaker — is also A09-F2's, and `V08`
  verified zero behavioural readers.
- **True consequence**: See A08-F2 / A09-F2.
- **Evidence**: `V08` §A08-F2, §A09-F2 (`scratchpad/v08/f-restart-rate.ts`,
  `f-restart-amplify.ts`).
- **Disposition**: One fix for all three reports — `checkSpawnLimits()` +
  `recordSpawnTime()` in `restartSession`, landed together with A09-F1's
  `liveCount` filter and A08-F3's refusal frame. A10's own suggestion (a
  per-session minimum interval, or backoff keyed off `restartCount`) is a good
  *addition* rather than a substitute: the window cap resets every 10 s while a
  resume-failure loop does not, which is exactly the circuit-breaker argument
  `V08` makes for keeping `restartCount`.

### A10-F6 — [MED] The IPC rate guard uses wall-clock time, so a backward clock step wedges every sender

- **Verdict**: PARTIALLY CONFIRMED — the wedge is real, the recovery claim is not
- **Cited location holds?**: Yes. `rendererIpcGuard.ts:12` is
  `now = Date.now` as the injected default; `:34-38` is
  `const currentTime = now(); if (currentTime - windowStart >= RATE_WINDOW_MS) { windowStart = currentTime; frameCount = 0 }`.
- **Reachable in production?**: Yes. `createRendererIpcGuard()` is called with no
  arguments at `preload.ts:85`, so production uses `Date.now`. `MAX_FRAMES_PER_WINDOW`
  is 120 and `RATE_WINDOW_MS` 1,000 (`limits.ts:28-32`).
- **Trigger — reproduced with the real guard and an injected clock.**
  ```
  admitted before cap: 120 (cap 120)
  after -1h clock step, blocked calls out of 5: 5
  recovered after advancing 3601 seconds of wall time: true
  ```
  Every bridge method — `submit`, `respondPermission`, `createSession`,
  `rendererReady` — shares this one guard instance, so the app is inert.
- **Counter-arguments considered**:
  1. *Is 120 actually reached in normal use?* Yes — a streaming turn plus
     `reportVisibleSessions` plus permission traffic hits it in seconds, and the
     guard counts every sender.
  2. **Is there a recovery path short of restarting the app?** *Yes, and this is
     where the report overreaches.* The guard is created at **preload module
     scope** (`preload.ts:85`), and Electron re-executes the preload for **every
     document load**. Any renderer reload therefore mints a fresh guard whose
     `windowStart` is the new (stepped-back) clock, and the app recovers
     immediately. `main.ts` never calls `Menu.setApplicationMenu`, so Electron's
     default macOS menu is in place, which means **View → Reload (⌘R)** is
     available to the user. So the true recovery is "reload the window", not
     "restart the app".
  3. *Does the injected `now` seam mean tests already cover this?* No — nothing
     injects a non-monotonic clock; the seam exists for determinism only.
- **True consequence**: A backward wall-clock step makes every bridge method
  throw until wall time re-passes the stale window (up to the size of the step).
  The user sees a completely unresponsive app; ⌘R clears it. Still worth fixing —
  an app that goes inert for an hour and recovers only if the user happens to
  reload is a real defect — but "no recovery path short of restarting the app"
  should not be repeated.
- **Evidence**: `scratchpad/v10/f-guard-and-null.ts` output above;
  `rendererIpcGuard.ts:11-16,34-44`; `preload.ts:85`; `limits.ts:28-32`;
  `rg 'setApplicationMenu' app/main` → no matches.
- **Disposition**: Apply the report's fix — `performance.now()` as the default
  `now`, keeping the injected seam. One correction to its wording: the fix is not
  free of behaviour change on the *first* window, because `performance.now()` is
  process-relative rather than epoch-relative; that is fine here because only
  differences are compared, but the doc comment should say so. Do **not** add a
  "reset on negative delta" guard instead — it would paper over the same class of
  bug in the two other `Date.now()` window computations (`host.ts` `spawnTimes`,
  `attachmentGate` flush scheduling) without fixing them.

### A10-F7 — [MED] Replay truncation is permanently sticky and its user-visible text reports frames as messages

- **Verdict**: OVERSTATED — both code claims hold, the user-visible claim is refuted
- **Cited location holds?**: Yes. `replayBuffer.ts:190-200` is the oversized-frame
  branch ending `entry.truncated = true; return` at `:198-199`, with the comment
  at `:192-197` stating the branch is "reachable in a healthy session". `:246-248`
  is `if (entry.truncated) frames.push(replayTruncationFrame(sessionId, entry.recent.length))`.
  `:273-286` is the builder, `message:` at `:283`. `entry.truncated` is written at
  exactly three places (`:177` init false, `:198`, `:211`) and cleared nowhere.
  `entry.recent.length` is a frame count, and `DEFAULT_MAX_BUFFERED_FRAMES`'s own
  comment at `:56-58` says "each message is several frames".
- **Reachable in production?**: The *frame* is minted, yes. The *banner* is not.
- **Trigger for the claimed harm**: None exists. This is the refutation:
  - `app/renderer/src/rawMessageLog.ts:117` —
    `if (frame.requestId === REPLAY_BUFFER_TRUNCATION_REQUEST_ID) return state`
    drops it before anything reaches `session.error`.
  - `app/renderer/src/previewTranscriptState.ts:139` — `continue`, the same drop
    on the preview/restore path.
  Those are the only two renderer consumers of `kind: 'error'` frames, and both
  filter this exact request id. The `rawMessageLog.ts:8-25` doc comment names the
  precise symptom the report describes as still live: *"Nothing ever clears
  `error`, so displaying it pinned an undismissable red line above the composer
  for the rest of the session. Dropped at DISPLAY only, and only for this one id."*
- **Counter-arguments considered**:
  1. *Is the frame at least stored somewhere a user could read it?*
     `transcriptCache.ts:127-131` keeps it in the at-rest cache
     (`isReplayTruncationFrame(frame) || … HISTORY_REPLAY_TRUNCATION_REQUEST_ID`),
     deliberately, as an incompleteness marker. But `previewTranscriptState.ts:139`
     is what reads that cache back and it drops the frame, so it never reaches a
     surface either.
  2. *Could a future consumer render it?* Yes — the string is wrong and would be
     wrong if displayed, which is why the second half of the finding still has
     value. But that is a latent-string finding, not "the user is told 'Only the
     6,214 most recent messages are shown'".
  3. *Is the sticky flag itself harmless then?* Effectively yes today: the only
     thing `entry.truncated` gates is emitting a frame nobody renders. It becomes
     harmful the moment someone wires the marker to UI.
  4. *Did the report have the evidence to know?* Its own "Not reviewed /
     uncertain" section admits it did not follow an `error`-frame `message` to a
     JSX surface. That caveat was filed against the untyped-`Error` finding; it
     applies to this one too and would have changed the verdict.
- **True consequence**: A sticky flag and a wrong string on a frame that two
  renderer consumers deliberately drop by id. Nothing is shown to a user, and no
  count is displayed. The honest finding is "a minted-but-never-rendered marker
  whose text is wrong and whose sticky flag conflates two causes".
- **Evidence**: `replayBuffer.ts:177,190-200,204-212,246-248,273-286`;
  `rawMessageLog.ts:8-26,117`; `previewTranscriptState.ts:10,139`;
  `transcriptCache.ts:127-131`.
- **Disposition**: Downgrade to LOW and apply only the cheap half — split
  `droppedOversized` from `evictedFromRing` and phrase the message without a
  count. Do **not** sell it as a user-facing text bug: `rawMessageLog.ts:20-25`
  already records the decision to drop it at display and the intent to promote
  the id to `shared/protocol.ts`; the *real* residual defect there is that the id
  is declared twice (`replayBuffer.ts:76` and `rawMessageLog.ts:26`) across a
  process boundary, so a rename in one place silently un-drops the banner. That
  duplication is worth more than the wording.

### A10-F8 — [MED] Frame byte accounting re-serializes every frame, twice at steady state, in main

- **Verdict**: PARTIALLY CONFIRMED — the mechanism is exact, the cost is not
- **Cited location holds?**: Yes, all four. `replayBuffer.ts:288-290` is
  `new TextEncoder().encode(JSON.stringify(value)).byteLength`; `:190` is the push
  measurement; `:210` the eviction re-measurement. `attachmentGate.ts:201-203` is
  a byte-identical second definition, called at `:85`. `preload.ts:343` is the
  same idiom for `MAX_SAVE_TEXT_BYTES`.
- **Reachable in production?**: Yes, on every buffered frame in Electron main.
- **Trigger — measured with the real `FrameReplayBuffer`,** instrumenting
  `TextEncoder.prototype.encode`:
  ```
  fill phase (200 frames, ring not yet evicting): 1.04 encodes/frame
  steady state (2000 frames, ring saturated):    2.00 encodes/frame
  elapsed for 2000 steady-state records: 4.7 ms => 2.3 us/frame
  projected at 300 frames/sec of streaming: 0.7 ms of main-thread work per second
  ```
- **Counter-arguments considered**:
  1. *Is the doubling real or an artefact of my small ring?* Real — it is
     structural: `record()` measures on push (`:190`) and again per eviction
     (`:210`) because the byte cost is not stored beside the frame. The 1.04 → 2.00
     step is exactly the transition into eviction.
  2. **Is the cost what the report implies?** No. "Hundreds of frames per second
     of avoidable stringify + allocation, on the Electron main thread that also
     drives the window" reads as a perf problem; it measures at **0.7 ms per
     second**, i.e. 0.07% of the main thread. Even at 10× my ~1 KB frames it is
     sub-1%. For scale, `V08` measured `readSessionsCatalogCache` at 4.39 ms per
     *call* — six orders of magnitude more impactful per unit of work.
  3. *Is the fragility claim right?* Yes, and it is the better argument: the
     subtraction at `:210` is only correct because nothing mutates a buffered
     frame, and that is an unstated invariant.
- **True consequence**: One avoidable `JSON.stringify` + full byte-array
  allocation per frame at steady state, costing well under a millisecond per
  second of streaming, plus a duplicated helper and an unstated
  frames-are-immutable invariant.
- **Evidence**: `scratchpad/v10/f-bytecost.ts` output above;
  `replayBuffer.ts:190,210,288-290`; `attachmentGate.ts:85,201-203`;
  `preload.ts:343`.
- **Disposition**: Apply the structural half only — store `{ frame, bytes }` in
  `recent` and export one shared helper — and drop the performance justification,
  which will not survive a measurement. `Buffer.byteLength(json, 'utf8')` is the
  right primitive in main. Do **not** change `preload.ts:343` to `new Blob([text]).size`
  as suggested: it is a one-shot check on a user-initiated save, `Blob` in a
  sandboxed preload is a different global surface, and the change buys nothing.

### A10-F9 — [LOW] The `isObjectRecord` guard runs after the dereference it was written to protect

- **Verdict**: CONFIRMED (as scoped — the report itself states it is unreachable today)
- **Cited location holds?**: Yes. `supervisor.ts:461` is
  `const frame = result.payload as ServerFrame`; `:462` is `if (frame.kind === 'ready')`;
  the `isObjectRecord(frame)` test is at `:481`, nineteen lines later.
  `framing.ts:72` is `results.push({ kind: 'frame', payload: JSON.parse(text) })`
  with no shape check.
- **Reachable in production?**: Not from a well-behaved sidecar — which is why
  LOW is right. It becomes reachable from anything that can own the socket
  (A10-F2's squat), and note the ordering: `frame.kind` is read **before**
  `validateReadyFrame`, so a hostile peer does not need to know the session UUID
  to trigger it.
- **Trigger — proven.**
  ```
  decoder result: [{"kind":"frame","payload":null}]
  THREW at `frame.kind`: TypeError - null is not an object
  isObjectRecord(null) = false => a hoisted guard would have caught it
  ```
- **Counter-arguments considered**:
  1. *Does the decoder reject `null` first?* No — `FrameDecoder.push` returns
     whatever `JSON.parse` produced; only malformed UTF-8 and oversized lengths
     become `kind: 'error'`.
  2. *Does the socket `data` handler catch it?* No `try` anywhere in
     `connectWhenReady` (`:418-525`).
  3. *Does main survive an uncaught throw?* No — `V08` established by grep that
     `app/` contains **zero** `uncaughtException`/`unhandledRejection` handlers,
     so main dies without running `shutdownRuntime()`, which is A08-F5's leak.
  4. *Are other primitives equally dangerous?* `JSON.parse('5')` → `5`, and
     `(5).kind` is `undefined`, not a throw; only `null` (and `undefined`, which
     JSON cannot produce) crashes. So the report's framing — "for the one input
     it was written to reject it is dead code" — is precisely right.
- **True consequence**: A one-line ordering defect that converts a single
  malformed peer frame into a crash of the privileged main process, latent behind
  a trusted peer today.
- **Evidence**: `scratchpad/v10/f-guard-and-null.ts`; `supervisor.ts:418-525,461-462,481-488`;
  `framing.ts:43-81`.
- **Disposition**: Apply exactly as written — hoist
  `if (!isObjectRecord(frame)) { log; continue }` above the `'ready'` branch and
  drop the redundant re-test in the mismatch log. One line moved, correct
  independent of A10-F2. Land it **before** the socket-directory hardening, not
  after: it is the cheaper half of the same chain and does not depend on it.

### A10-F10 — [LOW] A sidecar rejected at the frame layer keeps running; only the connect-timeout path kills it

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, ±1. The invalid-`ready` branch is `:464-471`
  (report said `:463-471`) — `this.setStatus(record, 'failed'); socket.destroy(); return`,
  no `record.child.kill`. The frame-before-ready branch is `:489-496`, identical
  shape. The connect-timeout path at `:428-437` does
  `record.child.kill('SIGTERM')` at `:434` (report said `:433`) with the "do not
  silently abandon a slow/hung sidecar" comment at `:429-430`.
- **Reachable in production?**: Yes. A protocol-version skew is the realistic
  route: `validateReadyFrame` returns `'missing or wrong protocolVersion'`
  (`:588-590`) for a sidecar built against a different `PROTOCOL_VERSION`.
- **Trigger**: A stale packaged sidecar binary against a newer main, or a partial
  rebuild where `app/shared/protocol.ts` moved but the sidecar bundle did not.
- **Counter-arguments considered**:
  1. *Does the record's later teardown catch it?* Only at `shutdown()` — and per
     A10-F3 that is an unescalated SIGTERM, and per A20-F1 the harness paths skip
     it entirely.
  2. *Does the child exit on its own when the socket is destroyed?* No. Bun's
     `listen` server keeps running; the sidecar's exits are its SIGTERM handler,
     the idle TTL (15 min with **zero** connections — and a connection did occur
     here), and the park gate. A rejected-but-connected sidecar sits with the
     session's cwd and engine graph resident.
  3. *Is the sibling really 30 lines away?* Yes, in the same method, which is what
     makes "oversight rather than decision" the fair reading.
- **True consequence**: A protocol-mismatched sidecar is marked unusable while its
  ~282 MB engine keeps running, until app shutdown at best.
- **Evidence**: `supervisor.ts:428-437,464-471,489-496,588-590`.
- **Disposition**: Apply as written — `record.child.kill('SIGTERM')` beside
  `setStatus(record, 'failed')` in both branches. Once A10-F3's escalation lands,
  route both through the shared `pendingKills` path rather than a bare `kill`, so
  a sidecar that ignores SIGTERM here gets the same SIGKILL backstop.

### A10-F11 — [LOW] Cap violations in `send` throw an untyped `Error`, so callers classify them as `bad_request`

- **Verdict**: CONFIRMED — and I closed the report's own open question
- **Cited location holds?**: Yes. `supervisor.ts:341-351` contains both bare
  throws: `throw new Error(\`prompt exceeds ${MAX_PROMPT_BYTES} bytes\`)` at `:345`
  and `throw new Error(\`frame exceeds ${MAX_FRAME_BYTES} bytes\`)` at `:350`,
  while the three lifecycle refusals at `:327-334` all use `SidecarSendError`
  with a closed `SendFailureCode` (`:120-135`). `main.ts:1596-1616` is `forward`'s
  catch: `const code = isSidecarSendError(error) ? error.code : 'bad_request'`
  and `message: messageText` verbatim.
- **Reachable in production?**: Yes. Every `app.submit` over `MAX_PROMPT_BYTES`
  (96 KiB) takes it. Note the preload's own guard measures the **payload**
  against `MAX_FRAME_BYTES` (128 KiB), so a 100 KiB prompt passes the preload and
  is refused here — the two caps do not coincide, which makes this path ordinary
  rather than exotic.
- **Trigger**: Paste a >96 KiB prompt.
- **Counter-arguments considered**:
  1. *Does the message actually reach a user surface?* **Yes — this is the item
     A10 filed as unresolved and I resolved it.** `rawMessageLog.ts:116-123`
     stores `error: frame.message` for every error frame except the
     replay-truncation id, and `App.tsx:4305-4306` renders it:
     `{activeLog.error ? (<div className="text-sm text-tone-danger">{activeLog.error}</div>) : …}`.
     So the user is shown `prompt exceeds 98304 bytes` as red text.
  2. *Is `retryable` at least right?* It is `false` for the bare `Error` branch
     (`main.ts:1611`), which happens to be correct for a size refusal — the only
     part of the classification that lands.
  3. *Does any consumer string-match today?* No, and that is the point: they
     cannot distinguish it, so nothing does.
- **True consequence**: A size refusal is reported to every consumer as
  `bad_request` with no retry semantics, and its byte-count diagnostic renders as
  user-facing red text — the engineering-vocabulary rule in `CLAUDE.md` §7.
- **Evidence**: `supervisor.ts:120-135,327-334,341-351`; `main.ts:1596-1616`;
  `rawMessageLog.ts:116-123`; `App.tsx:4305-4306`; `limits.ts:19-38`.
- **Disposition**: Apply the report's fix (extend `SendFailureCode` with
  `payload_too_large`, throw `SidecarSendError` from both checks, keep the byte
  count in the `log` line only). Add what it does not say: the **renderer** side
  needs the same treatment as A08-F8/A09-F6 — map `code` to human copy rather
  than rendering `HostError.message`/frame `message` verbatim — or the next
  diagnostic string lands on screen the same way. `App.tsx:4305-4306` is the site.

### A10-F12 — [LOW] The rate limiter is a tumbling window but is documented as sliding

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, exactly. `limits.ts:28` is
  `/** Sliding-window rate cap: max inbound frames per window (T7). */`.
  `rendererIpcGuard.ts:34-44` resets `windowStart` and `frameCount` wholesale.
- **Reachable in production?**: Yes — the doc and the code are both shipped.
- **Trigger**: 120 sends just before the boundary plus 120 just after: my F6 run
  shows the reset is wholesale (the first call past the stale window succeeded
  immediately), so 240 in a ~2 ms straddle is admitted by construction.
- **Counter-arguments considered**:
  1. *Is the 2× gap material for T7?* Barely — the threat T7 addresses is a
     sustained flood, and a tumbling window still bounds the sustained rate at
     120/s. The finding's own framing ("small in absolute terms") is honest.
  2. *Is there a second enforcement point that makes the doc true?* No. `rg`
     found no other rate limiter on the inbound path; `SECURITY-MINIMUM`'s T7 is
     implemented by this one guard.
  3. *Could "sliding" be defensible loose usage?* No — "sliding window" has a
     specific meaning that this implementation contradicts in a measurable way.
- **True consequence**: A doc-vs-code disagreement on a security-baseline
  constant, with a 2× burst allowance at window boundaries.
- **Evidence**: `limits.ts:28-32`; `rendererIpcGuard.ts:34-44`;
  `scratchpad/v10/f-guard-and-null.ts` (reset observed).
- **Disposition**: Take the report's own smaller option — correct the comment to
  "fixed-window". Do not implement interpolation: it adds state to the one guard
  that stands between the renderer and every inbound path, for a 2× boundary
  allowance nothing depends on. If the exact bound matters later,
  `SECURITY-MINIMUM.md` should state the enforced semantics rather than the
  constant's doc comment.

### A10-F13 — [LOW] Promise-returning bridge methods throw synchronously from the guard

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `preload.ts:252-347` is the control plane, and
  it is exactly **ten** methods (`pickDirectory`, `createSession`,
  `restoreSession`, `createSessionInWorkspace`, `previewSession`, `closeSession`,
  `listSessions`, `readSessionsCatalog`, `openHistorySession`, `saveTextToFile`).
  Every one is declared `Promise<…>`, none is `async`, and each calls
  `sendGuard.assertAllowed(...)` before its `ipcRenderer.invoke`. `:343-345` is
  the extra `MAX_SAVE_TEXT_BYTES` synchronous throw.
- **Reachable in production?**: Yes — the guard throws on rate (120/window) and
  on size (`MAX_FRAME_BYTES`).
- **Trigger**: `bridge.previewSession(id).then(…).catch(…)` during a burst that
  has already hit 120 frames.
- **Counter-arguments considered**:
  1. *Do today's call sites actually use `await`/`try`?* Yes —
     `App.tsx:2160-2192` handles exactly this for the void-returning
     `reportVisibleSessions`, with a comment. So nothing is broken now, as the
     report says.
  2. *Would wrapping break the void senders?* Yes, which is why the report's
     "keep the void-returning senders throwing synchronously" caveat matters —
     `App.tsx` depends on the synchronous throw there.
  3. *Is this actually a security issue?* No, and it is not filed as one; the
     type is `quality`.
- **True consequence**: A declared contract the code does not honour, latent
  until the first `.catch(…)`-style call site.
- **Evidence**: `preload.ts:252-347,343-345`; `App.tsx:2160-2192`.
- **Disposition**: Apply, but narrow it: wrap the guarded body of the **ten**
  promise-returning methods only, and prefer marking them `async` over an
  explicit `Promise.reject` wrapper — an `async` function converts a synchronous
  throw into a rejection for free and is one keyword per method rather than a
  try/catch each. The `void` senders stay exactly as they are.

## Per finding — A20

### A20-F1 — [HIGH] Harness `app.exit()` skips `before-quit`, orphaning the engine sidecars the run spawned

- **Verdict**: PARTIALLY CONFIRMED — mechanism proven, per-run consequence unproven
- **Cited location holds?**: Yes. `hardening-smoke.ts:391` is
  `app.exit(failed === 0 ? 0 : 1)`; `harness-demo-driver.ts:99` is `app.exit(code)`
  inside `exitElectron`, with a 250 ms `process.exit` backstop at `:100`.
  `main.ts:1903-1907` is `window-all-closed` → `shutdownRuntime()`; `:1927-1932`
  is `before-quit` → `shutdownRuntime()`; `:1891-1899` is `teardownOnSignal`
  doing `stopBackgroundDrivers() + shutdownRuntime()` **then** `app.exit()`, with
  the comment the report quotes. `f2-attach-smoke.ts:234` is the correct shape.
  `IDLE-PARK.md` carries the RAM figures around `:16-20` ("~223 MB RSS … matches
  the ~230/~190 boot floor") — the `~230` sits a few lines below the cited line.
- **Reachable in production?**: The harnesses are dev tooling, not shipped, but
  they run real production main, so the mechanism is live whenever they run.
- **Trigger — proven end to end, twice.**
  1. A scratch Electron main (hidden window, `data:` URL) with all four lifecycle
     listeners logged **only `quit`** on `app.exit(0)`; the directory its handler
     would have removed survived. So `app.exit()` skips `window-all-closed`,
     `before-quit` **and** `will-quit` in this Electron (33.x).
  2. A second scratch Electron main constructed the **REAL `SidecarSupervisor`**
     (bundled from `app/supervisor/supervisor.ts`), spawned a real child through
     the real `child_process.spawn` path, then `app.exit(0)`:
     ```
     socketDir: /tmp/catcode-32460
     spawned child pid: 32463
     calling app.exit(0)
     -- after exit --
     32463  ppid=1  /bin/sleep 900        <- survived, reparented to launchd
     drwxr-xr-x  /tmp/catcode-32460        <- socket dir survived
     ```
     (I killed 32463 with the pid I recorded and removed the directory.)
  3. Separately, a **real engine sidecar** booted in isolation reached
     `[sidecar] READY`, bound its socket, and measured **288,448 KB RSS
     (~282 MB)** — so the sidecar does boot under a fresh temp `CLAUDE_CONFIG_DIR`,
     and the report's `~230 MB` figure is if anything low.
- **Counter-arguments considered**:
  1. *Does the 15-minute idle TTL bound it?* Yes — `V29-F7` already established
     this and I confirm the wiring (`app/sidecar/index.ts:58,215,244,250`). "Every
     green run orphans a sidecar" should read "orphans one for up to 15 minutes".
  2. *Does the harness runner notice and fail?* **No, and this is a defect the
     report missed.** `run-hardening-smoke.ts:68-73` uses `spawnSync` with piped
     stdio, and the sidecar inherits main's stdout/stderr
     (`supervisor.ts:252` `stdio: ['ignore','inherit','inherit']`). I measured
     that `spawnSync` **blocks until grandchild pipe EOF** (6,011 ms for a 6 s
     grandchild). So an orphan stalls the runner for the full `timeout: 20_000`.
     On timeout, `spawnSync` sets `error = ETIMEDOUT` but leaves `status` at the
     real exit code, and `:77-84` checks only `status` and the stdout marker —
     never `smoke.error` — so it **still reports green**. Proven:
     `status: 0, signal: null, error: ETIMEDOUT` → the runner's own predicate
     evaluates to "no failure".
  3. **Does a live `test:hardening` run actually produce the orphan?** *Unproven,
     and this machine says no run happened today.* `supervisor.ts:194-196`
     creates `/tmp/catcode-<pid>` unconditionally in the constructor, and only
     `shutdown()` removes it (`:387`) — both verified with the real class. So any
     run reaching `ensureHost()` (`main.ts:1698,1822`) must leave a dated
     directory. There are **zero** `/tmp/catcode-*` dirs from 2026-08-08 (86 total:
     2/24/26/9/25 across 08-02 … 08-07), and `~/Library/Application Support/@cat-code/desktop`
     — the userData dir this app writes when `isPackaged` is forced true — was
     last touched **2026-08-07 22:15:54**. My throwaway Electron probes each
     created a today-dated userData dir, so launches do bump it.
  4. *Could the run have died on a signal instead, cleaning up?* That path
     (`teardownOnSignal`) would have produced a clean run and removed the
     directory — but it also would not have printed the success line before the
     signal in the normal case, and it does not explain the untouched userData.
  5. *Is `harness-demo-driver.ts` different?* Same `app.exit`, plus a 250 ms
     `process.exit` backstop that makes it strictly worse (it cannot even wait for
     an async teardown if one were added).
- **True consequence**: `app.exit()` in both harnesses skips the only sidecar
  teardown main has, and a supervisor-spawned child provably survives it at
  ~282 MB, reparented to launchd, until the 15-minute idle TTL. Whether the
  `test:hardening` path in particular produces one on every run is **not
  established** by either report or by me, and cannot be inferred from the
  operator's green run in either direction.
- **Evidence**: `scratchpad/v10/exitprobe/`, `scratchpad/v10/orphanprobe/`,
  `f-socketdir.ts`, `f-spawnsync-pipe.js`, `f-spawnsync-timeout.js`, isolated
  sidecar RSS measurement; `hardening-smoke.ts:391`; `harness-demo-driver.ts:99-101`;
  `run-hardening-smoke.ts:68-84`; `main.ts:1698,1822,1891-1899,1903-1907,1927-1932`;
  `supervisor.ts:194-196,252,387`; `app/sidecar/index.ts:58,215,244,250`;
  `/tmp` and userData timestamps above.
- **Disposition**: Apply the report's fix, with one substitution and one addition.
  **Substitution:** `app.quit()` in `hardening-smoke.ts` is right (it fires
  `before-quit`), but in `harness-demo-driver.ts` the 250 ms `process.exit`
  backstop at `:100` must be raised or made conditional first — 250 ms is not
  enough for `host.shutdownAll()` plus a registry `persist()` (`V08` measured
  ~1 ms per fsynced write at 256 rows, but the mark-clean pass walks every live
  row), and `process.exit` would truncate the very teardown the change adds.
  **Addition:** fix `run-hardening-smoke.ts:77` to treat `smoke.error` as a
  failure. Today a 20-second hang caused by exactly this leak is invisible, which
  is why nobody has noticed it in a green run — that one predicate is what turns
  the leak into a self-reporting one.

### A20-F2 — [MED] "hardening 19/19" covers the renderer document, not the security baseline

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `hardening-smoke.ts:289-369` is the check block;
  `run-hardening-smoke.ts:79` is the `'[hardening-smoke] production path passed'`
  gate and `:81` the failure line. There are **20** `add(` sites; the 20th
  (`:371`) is inside the `catch`, so a green run prints 19/19 — the report's
  enumeration of the 19 is exactly right (1 + 4 + 6 + 3 + 2 + 1 + 1 + 1).
- **Reachable in production?**: N/A — this is a verification-signal finding, and
  the mislabelling is live in `run-hardening-smoke.ts:79`.
- **Trigger**: Citing "hardening 19/19" as evidence for an inbound-boundary
  change.
- **Counter-arguments considered**:
  1. *Does the harness touch the sidecar at all?* No. I re-derived it
     independently: every crafted frame goes out via
     `window.webContents.send(CH_SERVER_FRAME, …)` (`:192`, `:199`, `:207` in the
     working tree), which is **main → renderer**. The file constructs no
     `ClientFrame`, opens no socket, and calls no `ipcRenderer.send`. So
     `sidecarServer.ts`'s schema/T-number path is entirely unexercised.
  2. *Is the coverage-gap list right?* Yes, and the counterpart coverage is where
     the report says: `app/sidecar/sidecarServer.test.ts` mentions
     `updatedPermissions` **20**× (report said 21 — the only count that is off),
     `secretGuard` 8, `goalSnapshot` 8, `T7` 5, `T6` 5, `T6b` 4, `T5a` 3, `T4` 3,
     `HC1` 2, and each of `MAX_FRAME_BYTES` / `MAX_OUTBOUND_FRAME_BYTES` 2 — all
     under `bun test app/`, a different command.
  3. *Is HC3 partly covered, as claimed?* Yes and only as a shape check: the
     `bridgeKeys` assertion (`:313-317`) compares `Object.keys(window.catcode).sort()`
     against a **30-name** allowlist (`:237-279`). That is a real allowlist pin —
     and per my A10 clean-bill work below it is the *only* place a new bridge
     method is caught.
- **The vacuity count the prompt asked for: 5, not 3.** The absence-shaped checks
  — those that PASS when the crafted payload simply never rendered — are:
  `:294` `!markdownScriptRan`, `:295` `!markdownImgRan`, `:296` `!markdownLinkRan`,
  `:297-301` `!unsafeLink?.href?.toLowerCase().startsWith('javascript:')` (passes
  when `unsafeLink` is `undefined`), and `:302-306`
  `rawTargetBlank === undefined` (passes trivially on an empty DOM). `:307-311`
  (`safeLink?.href === 'https://evil.example'`) is **not** vacuous — it requires
  the element to exist — and neither are the four `window.*` absence checks,
  whose subject genuinely is an absence. `V29`'s 5 is correct. Containment is
  real: check #1 (`:289 markerRendered`) fails and exits 1 if nothing rendered,
  and the marker shares a text block with the payloads (`:58-68`); the residual
  is a renderer that shows the text but strips the HTML, which leaves the two
  link checks vacuous while #1 still passes.
- **True consequence**: A renderer/CSP/preload/navigation result routinely cited
  as inbound-baseline evidence, plus 5 contained-but-vacuous PASS lines.
- **Evidence**: `hardening-smoke.ts:58-68,192,199,207,237-279,289-369,371,391`;
  `run-hardening-smoke.ts:79,81`; marker counts in `app/sidecar/sidecarServer.test.ts`.
- **Disposition**: Apply the labelling fix — it costs a string and it is the
  highest-value change in this scope. Prefer `V29`'s amendment on the vacuity
  half: one added gate (`crafted payload elements are present in the DOM`)
  covering all five, rather than rewriting individual checks. And extend the
  rename to the citations, not just the harness: `docs/migration/STATUS.md` and
  the session reports are where "19/19" is read as baseline evidence, and a
  renamed line that old prose still misquotes fixes nothing.

### A20-F3 — [MED] `dev.ts` installs its signal handlers only after the readiness wait

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, against the working tree (`dev.ts` is **DIRTY**).
  Vite is spawned at `:95-101`; `await waitForRendererReady(…)` runs `:104-118`
  with `READY_TIMEOUT_MS = 15_000` (`:33`); `process.on('SIGINT')` is `:185` and
  `process.on('SIGTERM')` `:188`. At HEAD those are `:178` and `:181` — the
  uncommitted `CATCODE_INITIAL_CWD` diff inserts 7 lines at `:128-140` and does
  not touch the finding.
- **Reachable in production?**: It is dev tooling, but reachable by ordinary repo
  practice — `CLAUDE.md` §3 explicitly tells agents to recover a hung launch with
  `kill <pid>` (the form the sweep-kill hook permits).
- **Trigger**: `bun run --cwd app dev`; while it is polling `:5173`,
  `kill <launcher-pid>`. Default SIGTERM disposition terminates the launcher;
  `stop(vite)` never runs.
- **Counter-arguments considered**:
  1. *Is the child in the launcher's process group, so a group signal would get
     it?* Yes — `spawn` is called without `detached`, so `kill -TERM -<pgid>`
     would reach it. But `kill <pid>` addresses one process, and that is the
     documented recovery move. The report calls this out correctly.
  2. *Is Ctrl-C affected?* No — the terminal signals the whole foreground group,
     so Vite dies with the launcher. The report says so.
  3. *Does the build step widen the window?* No — `spawnSync` at `:89-92`
     completes before Vite exists, so a build failure leaks nothing. The report
     says so in its item-4 answer.
  4. *Is the proposed fix safe?* Yes. `shutdown()` guards on `shuttingDown`
     (`:150`), and `terminateChild` returns `'already-exited'` for a child that
     never ran (`devLauncher.ts:117`). The only change needed is making `electron`
     a mutable `Supervised | null` and null-guarding it in `shutdown` — exactly as
     stated.
- **True consequence**: A ~15 s window in which a single-pid SIGTERM to the
  launcher strands Vite holding `:5173`, producing the stale-server failure the
  launcher itself authors (`devLauncher.ts:140-146`) on the next run.
- **Evidence**: `dev.ts:89-92,95-101,104-118,143-154,185-190` (working tree);
  `git diff -- app/scripts/dev.ts`; `devLauncher.ts:106-126,140-146`.
- **Disposition**: Apply as written. One addition: arm the handlers **before**
  `prepareDevElectron()` too (`:79-86`), not just before the Vite spawn — that
  call does `cp -Rc` of a whole Electron bundle plus `codesign`, and a SIGTERM
  during it leaves a half-copied `.dev-electron/` that the next run's cache check
  may accept. That is a second, quieter leak in the same window.

### A20-F4 — [MED] `harness-demo.ts` re-implements `terminateChild` and leaks Electron on its own timeout

- **Verdict**: PARTIALLY CONFIRMED — duplication real, both harm mechanisms wrong
- **Cited location holds?**: Yes. `harness-demo.ts:123-132` is `cleanup()`, which
  touches `viteProcess` only and `rmSync`s `configHome` at `:131`. `:134-148` is
  the local `terminateChild`. `:162-173` is `waitForExit`. The file does import
  `waitForRendererReady` and `describeReadinessFailure` from `./devLauncher.js`
  (`:6-11`) while writing its own terminator.
- **Reachable in production?**: Dev tooling; reachable on any harness-demo run
  whose debug-state predicate never settles.
- **Trigger**: The 45 s `waitForExit` timeout.
- **Counter-arguments considered — and both sub-claims fail as written.**
  1. **Sub-claim (a)'s race is impossible.** The report says the local
     `terminateChild` "never settles" if "the child has already exited between the
     `exitCode !== null` guard and the listener attach". The guard (`:135`), the
     `new Promise` executor, the `child.once('exit', …)` attach (`:143`) and the
     `child.kill('SIGTERM')` (`:146`) are all in **one synchronous block**. Node's
     event loop cannot deliver an `exit` between them. There *is* a real
     non-settling path, but it is a different one: a child that fails to spawn
     emits `'error'` and, per Node's own contract, may never emit `'exit'` — then
     the promise never resolves and `cleanup()` hangs. Same conclusion, wrong
     mechanism; the fix (use the imported, tested `terminateChild`) is unchanged.
  2. **Sub-claim (b)'s leak mostly does not happen.** `waitForExit` calls
     `child.kill()`, which sends **SIGTERM**. `harness-demo.ts:83` spawns
     `app/node_modules/.bin/electron`, and that shim (`electron/cli.js`)
     explicitly forwards SIGINT/SIGTERM to the real Electron child
     (`handleTerminationSignal`). Electron main installs
     `process.on('SIGTERM', () => teardownOnSignal('SIGTERM'))` (`main.ts:1900`),
     which runs `stopBackgroundDrivers() + shutdownRuntime()` and exits 143. So
     the normal timeout path **does** tear down Electron and its sidecars. The
     genuine gap is narrower: `waitForExit` rejects **without awaiting** the exit
     and never escalates to SIGKILL, so an Electron that is wedged and ignores
     SIGTERM survives — and `cleanup()` has no handle on it either way.
  3. *Is the `configHome` ordering claim right?* Yes and it survives both
     corrections: `cleanup()` `rmSync`s `configHome` at `:131` with no wait for
     the Electron child, so a slow-exiting Electron is briefly pointed at a
     deleted config root regardless.
- **True consequence**: A duplicated, untested terminator with a spawn-failure
  hang path, and a timeout path that signals Electron correctly but neither
  awaits nor escalates — so only a wedged Electron actually survives.
- **Evidence**: `harness-demo.ts:6-11,83,123-132,134-148,162-173`;
  `app/node_modules/electron/cli.js` (`handleTerminationSignal('SIGTERM')`);
  `main.ts:1891-1901`.
- **Disposition**: Apply the report's fix (delete the local copy, use
  `devLauncher.terminateChild`, hold the Electron child module-scoped and
  terminate it in `cleanup()`), because it happens to fix the real defects too —
  `terminateChild` returns unconditionally after SIGKILL, which closes both the
  spawn-failure hang and the no-escalation gap. But **restate the finding**: the
  race and the "Electron left alive" framing are both wrong, and a reader who
  checks either one will discard the whole item. Severity is LOW on the evidence,
  not MED.

### A20-F5 — [MED] `app/scripts/preview-transcript.tsx` is typechecked by no tsconfig in the repo

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `app/tsconfig.json:29` is `"scripts/**/*.ts"`,
  the last entry of `include`, and there is no `*.tsx` entry for `scripts/`
  (renderer gets both, `:27-28`). `app/sidecar/tsconfig.json` covers
  `app/sidecar` + `app/shared` only. The file exists
  (`app/scripts/preview-transcript.tsx`, 6,145 bytes) and `package.json:19`
  wires `preview:transcript`.
- **Reachable in production?**: N/A — it is a coverage gap, and the gap is real.
- **Trigger**: Any breaking change to `NestedTranscriptRow`,
  `TranscriptRowsView`, or `ToolsExpandedContext`.
- **Counter-arguments considered**:
  1. *Does `lint:fast-refresh` catch it?* No — `package.json:13` globs
     `renderer/src/**/*.tsx`.
  2. *Does `bun test app/` catch it?* No — it is not a test file and nothing
     imports it.
  3. *Is TypeScript's `*.ts` glob really `.tsx`-exclusive?* Yes; `include`
     patterns ending in `*.ts` match `.ts` only, which is why `tsconfig.json`
     lists `renderer/src/**/*.tsx` separately two lines above.
  4. *Is the churn claim right?* Directionally. The report says the working tree
     has in-flight subagent work "touching exactly this projector" — in fact
     `transcriptProjector.ts` itself is **clean**; its test
     (`transcriptProjector.test.ts`) and `sdkMessageFixtures.ts` are dirty. The
     type is still one of the most-churned in the package, so the argument holds
     with a corrected citation.
  5. *Minor mis-attribution:* the report says `ToolsExpandedContext` comes from
     `transcriptProjector.js`; it is imported from `../renderer/src/toolsExpanded.js`
     (`:31`). Harmless.
- **True consequence**: A 6 KB file importing three live renderer types drifts
  silently until an operator runs the one script the docs recommend precisely
  when the batteries have already lied.
- **Evidence**: `app/tsconfig.json:27-29`; `app/package.json:13,19`;
  `preview-transcript.tsx:28-32`; `git status` (projector clean, its test dirty).
- **Disposition**: Apply — add `"scripts/**/*.tsx"` to `include`. The report
  states it typechecks clean today, so this is a one-line, zero-fallout change.
  Worth pairing with a `bun run --cwd app typecheck` afterwards, since the file
  has never been in a program and `strict: true` may surface something.

### A20-F6 — [MED] `app/eslint.config.js` registers two plugins and enables zero rules from them

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `plugins` is `:17-21` with `'jsx-a11y'`,
  `'react-refresh'`, `'react-hooks'`; `rules` is `:22-26` and contains exactly one
  entry, `'react-refresh/only-export-components'`. `eslint-plugin-jsx-a11y` and
  `eslint-plugin-react-hooks` are both `devDependencies` in `app/package.json`.
  `linterOptions.reportUnusedDisableDirectives: false` is `:28-30`.
- **Reachable in production?**: The config is live in four scripts (`dev`,
  `renderer:dev`, `renderer:build`, `typecheck`), and it enforces exactly one rule.
- **Trigger**: A conditional hook or a stale closure in `renderer/src/**` passes
  `lint:fast-refresh` unremarked.
- **Counter-arguments considered**:
  1. *Do flat-config plugins auto-enable anything on registration?* No — a plugin
     entry only makes its rules *addressable*; ESLint runs nothing it is not asked
     to run.
  2. *Is there a second config that enables them?* No — `app/eslint.config.js` is
     the only ESLint config under `app/`, and root `bun run lint` does not cover
     `app/**` (a documented Phase-5 gap).
  3. *Would enabling them be cheap?* Unknown, and the report says so honestly. Its
     "treat that as its own session" caveat is the right call.
- **True consequence**: A config that reads as if a11y and hooks linting are on
  while enforcing neither, inside a package whose renderer suite is SSR-only and
  therefore structurally blind to stale-closure bugs.
- **Evidence**: `app/eslint.config.js:1-31`; `app/package.json:9,11-14`.
- **Disposition**: Prefer the report's **second** option first — delete the two
  plugin registrations and their devDependencies — and open enabling them as its
  own item. Reason: leaving them registered is the failure mode (it implies
  coverage), and enabling `react-hooks/exhaustive-deps` across 91 renderer files
  on a shared tree is a large, conflict-prone diff that will be deferred anyway.
  Deleting is honest immediately; enabling can then be a deliberate, scoped
  session rather than a blocked TODO.

### A20-F7 — [MED] `ram-fleet.ts` duplicates ~80 lines of `ram-probe.ts` verbatim, and `parseArgs` exists four times

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, precisely. `ram-fleet.ts`: `parseArgs:63`,
  `sizeTokenToMB:81`, `psRssMB:92`, `vmmapSummary:102`, `childPids:120`,
  `isAlive:129` — the cited `:63-135` block. `ram-probe.ts`: `:53`, `:75`, `:86`,
  `:96`, `:115`, `:124` — the cited `:53-130`. `parseArgs` also at
  `ram-measure.ts:41` and `ram-corpus-gen.ts:71`, so four copies. The
  acknowledging comment is `ram-fleet.ts:76-78`: "verbatim reuse of ram-probe.ts
  idioms (ram-probe.ts:75-131)". The `vmmapSummary` divergence is exactly as
  described — the probe returns `{ raw, footprintMB, peakMB }`, the fleet drops
  `raw`.
- **Reachable in production?**: These are measurement instruments, not shipped
  code; the risk is to the numbers they produce.
- **Trigger**: A `vmmap` output-format change on a macOS update, fixed in one copy.
- **Counter-arguments considered**:
  1. *Are the copies really byte-identical?* Close enough for the argument — same
     names, same order, same bodies modulo the `raw` field. The self-describing
     comment removes any doubt about intent.
  2. *Are the outputs really compared against each other?* Yes —
     `IDLE-PARK.md:16-20` quotes the fleet reclaim figure and then says it
     "matches the ~230/~190 boot floor", which is `ram-probe`'s number. That
     cross-check is exactly what a silent divergence would break.
  3. *Does the source-shape test constrain the refactor?* Yes, as the report says:
     `ramScriptsSource.test.ts` asserts on substrings (`sc.proc.kill(9)` in the
     fleet, `proc.kill(9)` in the probe) and its anchors need re-pointing.
- **True consequence**: Two instruments whose agreement is used as evidence share
  no code, so a parsing fix in one silently invalidates the comparison.
- **Evidence**: line list above; `ram-fleet.ts:76-78`; `IDLE-PARK.md:16-20`;
  `app/scripts/ramScriptsSource.test.ts`.
- **Disposition**: Apply — extract to `app/scripts/ramSampling.ts`. One
  amendment: make `vmmapSummary` return `raw` in the single shared copy and let
  the fleet ignore it, rather than parameterising the return type; a shared
  function with two shapes is how the next divergence starts. Do this **before**
  any future RAM re-measurement, not after, so the next ratified number comes out
  of one instrument.

### A20-F8 — [LOW] `sidecar-typecheck.ts` swallows a locationless compiler error whenever any diagnostic exists

- **Verdict**: PARTIALLY CONFIRMED — the predicate gap is real, no real trigger found
- **Cited location holds?**: Yes. `:15-20` is
  `hasTypecheckInfrastructureFailure = exitCode !== 0 && countDiagnostics(output) === 0`;
  `countDiagnostics` (`:10-13`) matches `/: error TS\d+:/`. `:37-40` is the
  infrastructure branch.
- **Reachable in production?**: The predicate is live in the app battery
  (`typecheck:sidecar`).
- **Trigger — proven at the function level, with the real module imported:**
  ```
  D) locationless config error alongside 5560 upstream diagnostics
     countDiagnostics sees it as a diagnostic? false
     infra-failure predicate fires? false
     owned diagnostics found: 0
     => wrapper would print "Scoped sidecar typecheck passed" and exit 0
  E) locationless error ALONE (tsc aborted before emitting anything)
     infra-failure predicate fires? true
  ```
  The reason is sharper than the report states: `countDiagnostics`'s regex
  requires a `": error TS"` (colon-space), and a locationless line is
  `error TS5083: …` with no leading colon — so it is not counted at all, and the
  5,560 real diagnostics keep the count non-zero.
- **Counter-arguments considered**:
  1. **Can a real `tsc` invocation emit a locationless error *alongside*
     diagnostics?** I could not construct one. TS5083 (cannot read file), TS6046
     (bad flag argument) and TS18003 (no inputs) all abort before any diagnostic
     is emitted, which lands in case (E) where the predicate correctly fires. The
     report concedes the window is narrow; the honest verdict is that the gap is
     proven in the function and unproven in `tsc`.
  2. *Would a real failure be silent for long?* No — an owned file that stopped
     being checked would eventually surface through `bun run --cwd app typecheck`
     or a runtime break.
- **True consequence**: A one-predicate hole that is currently unreachable in
  practice; if it ever fires, a green "Scoped sidecar typecheck passed" would mean
  the owned files were never checked.
- **Evidence**: `scratchpad/v10/f-typecheck-filter.ts` output;
  `sidecar-typecheck.ts:10-13,15-20,37-40`.
- **Disposition**: Apply the report's fix, but write the predicate against the
  **diagnostic form**, not the error text: treat any line matching
  `/^error TS\d+:/` (no `file(line,col):` prefix) as an infrastructure failure
  regardless of count. That is one line and it also makes `countDiagnostics`'s
  colon dependence explicit rather than incidental. Keep it LOW.

### A20-F9 — [LOW] `sidecar-typecheck.ts` derives `repoRoot` from `URL.pathname`, which is percent-encoded

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `:23` is
  `const repoRoot = new URL('../..', import.meta.url).pathname`. The four
  neighbours are exact: `dev.ts:28`, `build-electron.ts:17`,
  `run-hardening-smoke.ts:18`, `prepare-dev-electron.ts:22` all use
  `dirname(fileURLToPath(import.meta.url))`.
- **Reachable in production?**: Only on a checkout whose absolute path contains a
  space or non-ASCII character — not at `/Users/pt/cat-code`.
- **Trigger — proven:**
  ```
  new URL('../..', 'file:///Users/pt/cat code/app/scripts/x.ts').pathname
    -> '/Users/pt/cat%20code/'   exists? false
  fileURLToPath(...) -> '/Users/pt/cat code/'
  ```
  `Bun.spawnSync` with that `cwd` then fails, and tsc reports the project file
  missing.
- **Counter-arguments considered**:
  1. *Does `Bun.spawnSync` tolerate a percent-encoded cwd?* No — it is a literal
     path; the directory does not exist.
  2. *Is a spaced checkout plausible here?* `~/Documents/…`, a Dropbox/iCloud
     path, or a worktree under a folder with a space would all hit it. It is not
     hypothetical for a clone, only for *this* clone.
  3. *Does anything else in the file break first?* No — `repoRoot` is used only as
     `cwd`.
- **True consequence**: On such a checkout, `typecheck:sidecar` fails with a
  confusing "project file missing" error rather than a path error.
- **Evidence**: bun one-liner above; `sidecar-typecheck.ts:23`; the four
  neighbour citations.
- **Disposition**: Apply exactly as written —
  `join(dirname(fileURLToPath(import.meta.url)), '..', '..')`. It matches every
  neighbour and is strictly correct.

### A20-F10 — [LOW] `fastRefreshBoundaries.test.ts` is non-recursive, so any renderer subdirectory escapes it

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `:16` is `const files = readdirSync(here)`, a
  flat listing, with the `.tsx` / `!.test.tsx` / `!main.tsx` filters at `:17-24`.
  The rule-behaviour claim about `eslint-plugin-react-refresh` matches the report.
- **Reachable in production?**: It is a coverage gap; nothing escapes it today.
- **Trigger**: The first `renderer/src/<subdir>/Foo.tsx`.
- **Counter-arguments considered**:
  1. *Is `renderer/src` really flat?* Yes today — the only subdirectories are
     `assets/` and `assets/fonts/`, with no `.tsx` in either.
  2. *Would the eslint half still cover a subdirectory file?* Partly —
     `lint:fast-refresh` globs `renderer/src/**/*.tsx`, so it recurses. But the
     hole it cannot see (a `.tsx` exporting only helpers, no component) is exactly
     what the runtime test exists to close, and that half stops recursing.
  3. *Is the fix safe?* `readdirSync(here, { recursive: true })` returns
     subpath-joined names, so the existing `file.endsWith('.tsx')` filters keep
     working and `join(here, file)` still resolves — but `file !== 'main.tsx'`
     would stop matching a nested `main.tsx`, which is fine.
- **True consequence**: The strong half of the Fast Refresh enforcement stops at
  the first subdirectory anyone creates in a 91-file flat directory.
- **Evidence**: `fastRefreshBoundaries.test.ts:14-30`; `app/package.json:13`;
  directory listing of `app/renderer/src`.
- **Disposition**: Apply — one option object. Add a second assertion the report
  does not: fail the test if the file list is empty or shrinks below the current
  count, so a future filter change cannot silently make the whole test vacuous.

### A20-F11 — [LOW] Harness bundle artifacts: stale `.gitignore` entry and one bundle never cleaned up

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `app/.gitignore:6` is `scripts/hardening-smoke.js`
  while `run-hardening-smoke.ts:51` writes `hardening-smoke.cjs` under
  `naming: '[name].cjs'` at **`:58`** (the report said `:57`, off by one). The
  `rmSync(harnessOut, …)` is at `:74`, after the `spawnSync` at `:68-73`.
  `run-f2-attach-smoke.ts:26` sets `harnessOut = join(here, 'f2-attach-smoke.js')`
  and the file contains **no** `rmSync` at all.
- **Reachable in production?**: It is already realised: `app/scripts/f2-attach-smoke.js`
  is on disk now, 24,040 bytes, dated **Jul 6** — matching the report exactly.
- **Trigger**: For (a), any throw or early `process.exit` between `:68` and `:74`
  — e.g. the `process.exit(1)` at `:83`… which is *after* the `rmSync`, so the
  window is narrower than it looks; the genuine cases are a `spawnSync` throw or
  a signal.
- **Counter-arguments considered**:
  1. *Is `.gitignore:7` (`scripts/f2-attach-smoke.js`) present, making (b)
     harmless to `git status`?* Yes, and the report says so — the cost it claims
     is a stale runnable bundle, not repo noise. That cost is real: the file is a
     month old and `electron app/scripts/f2-attach-smoke.js` still runs it.
  2. *Is the "un-cleanable-by-policy" argument sound for (a)?* Yes for a
     `.cjs` leftover, which matches no ignore entry and would appear in every
     session's `git status` as an unrecognised untracked file.
  3. *Did today's runs leave one?* No — `app/scripts/` contains only the
     `f2-attach-smoke.js`, consistent with the happy path removing the `.cjs`.
- **True consequence**: An ignore entry that matches nothing, and a month-old
  stale harness bundle nobody removes.
- **Evidence**: `ls -l app/scripts/` (only `f2-attach-smoke.js`, 24,040 B, Jul 6);
  `app/.gitignore:1-17`; `run-hardening-smoke.ts:51,58,68-74`;
  `run-f2-attach-smoke.ts:26`.
- **Disposition**: Apply all three parts. Better than the report's `try/finally`
  around the spawn: register the `rmSync` in a `process.on('exit')` handler in
  both runners, so a signal path cleans up too — `try/finally` does not run on
  SIGINT, which is the most likely way an operator ends a stuck harness.

### A20-F12 — [LOW] Unvalidated numeric argv in the `ram-*` scripts turns a typo into a silently wrong measurement

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `ram-fleet.ts:378-380` are `settleMs`,
  `readyTimeoutMs`, `parkTimeoutMs`, all bare `Number(args[...] ?? '…')`, while
  `--n`/`--cap` get `Number.isFinite` + range checks at `:382-390`.
  `ram-probe.ts:206-209` are `dwellMs`, `sampleMs`, `settleMs` — unvalidated,
  and the only guard there is `if (!configDir)`. `ram-measure.ts:86` is
  `const reps = Number(args.reps ?? '3')`. `ram-corpus-gen.ts:104-107` are
  `sessions`, `dirs`, `seed`, `minBytes`.
- **Reachable in production?**: Yes for their purpose — these produce
  decision-grade numbers.
- **Trigger**: `--settle-ms 2500ms` → `Number('2500ms')` is `NaN` → the settle
  sleep collapses to 0 and RSS is sampled before the engines settle, in a
  well-formed JSON result.
- **Counter-arguments considered**:
  1. *Does the asymmetry within `ram-fleet.ts` weaken or strengthen the case?*
     Strengthens it — `--n`/`--cap` prove the author knew the pattern and applied
     it to two of nine.
  2. *Would a bad value be visible in the output?* No — the scripts echo their
     computed values into the result JSON, but `NaN` serialises to `null` in
     JSON, so a reader sees a missing field, not an obviously wrong one.
  3. *Is `setTimeout(fn, NaN)` really 0?* Yes, per spec (`NaN` clamps to 0).
- **True consequence**: A typo produces a complete, plausible measurement with a
  silently disabled settle/timeout — the worst output shape for an instrument
  feeding ratified decision docs.
- **Evidence**: line citations above; `IDLE-PARK.md:16-20` for the stakes.
- **Disposition**: Apply — one `requireFiniteMs(name, value)` helper exiting 2, as
  proposed. Land it in the **same** change as A20-F7's `ramSampling.ts` extraction
  so the helper has an obvious home and all four scripts pick it up at once;
  doing them separately means writing the helper four times, which is the problem
  F7 is about.

### A20-F13 — [LOW] `ram-fleet.ts` emergency cleanup leaves `/tmp/ramfleet-*` directories behind

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `emergencyCleanup()` is `:204-210` (within the
  cited `:204-215`, which also covers the signal registration at `:212-217`): it
  destroys `openSocks` and calls `killSidecar(sc)` for each fleet member, and has
  **no** `rmSync`. The normal path's
  `for (const sc of fleet) { try { rmSync(sc.socketDir, { recursive: true, force: true }) } … }`
  is at `:491-493` (report said `:492` — the `rmSync` line itself). Socket dirs
  are `mkdtempSync(join('/tmp', 'ramfleet-'))` at `:397`.
- **Reachable in production?**: Yes — the SIGINT/SIGTERM/SIGHUP handlers at
  `:212-217` are the only cleanup on an interrupted run.
- **Trigger**: Ctrl-C during a fleet run.
- **Counter-arguments considered**:
  1. *Does the reaper pick these up?* No — `listStaleSocketDirs` matches only
     `/^catcode-(\d+)$/` (`reap-orphan-sidecars.ts:114`), so `ramfleet-*` is
     invisible to it. The report is right.
  2. *Is the residue large?* Each tree holds a config dir and a cwd, so N per
     interrupted run — the same class as the 86 `catcode-*` dirs sitting there now.
  3. *Is the fix safe inside a signal handler?* `rmSync` is synchronous and the
     handler already calls `killSidecar`, so yes.
- **True consequence**: An interrupted fleet run leaves N `/tmp/ramfleet-*` trees
  that nothing in the repo can find or clean.
- **Evidence**: `ram-fleet.ts:204-217,397,491-493`; `reap-orphan-sidecars.ts:114`.
- **Disposition**: Apply — move the `rmSync` loop into a shared helper both paths
  call. One caution the report does not give: `emergencyCleanup` runs after
  `killSidecar` sends `kill(9)`, and a just-killed sidecar may not have released
  its socket file; `rmSync(..., { force: true })` handles that, so keep `force`.

### A20-F14 — [LOW] `ram-measure.ts` drops an unparseable rep from the aggregate instead of recording it as failed

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `:128-133` is the non-zero-exit branch, which
  writes a stderr line and **pushes a failed placeholder** before `continue`.
  `:135-139` is the `try/catch` around `JSON.parse(res.stdout)`, whose `catch`
  writes a stderr line and pushes **nothing**.
- **Reachable in production?**: Yes — any stray stdout line from the probe (a Bun
  warning, an engine log) breaks the parse.
- **Trigger**: `--reps 3` where one probe emits an extra stdout line.
- **Counter-arguments considered**:
  1. *Does the aggregate label itself honestly?* No — the run is still described
     as a 3-rep run while the per-condition mean is over 2, which is the whole
     defect.
  2. *Is the stderr note enough?* In a measurement log that is hundreds of lines
     of `vmmap` output, no.
  3. *Is the placeholder shape reusable in the catch?* Yes — the same
     `{ label, reachedReady: false, killVerified: false, survivors: [], samples: [] }`
     literal, so the fix is a copied line.
- **True consequence**: A silently under-sampled aggregate presented with the
  requested rep count — again feeding ratified decision numbers.
- **Evidence**: `ram-measure.ts:126-139`.
- **Disposition**: Apply as written. Add one thing: have the final report print
  the count of successful reps per condition beside the mean, so a dropped rep is
  visible in the artifact rather than only in a stderr line that will not survive
  a copy-paste into a decision doc.

## Re-deriving the three "clean bills" the prompt named

### A20 — `sidecar-typecheck.ts`'s filter is correct and not over-broad — **CONFIRMED, re-proven**

This is the one the operator cited as evidence that a green run is meaningful, so
I re-proved it rather than re-reading it. I ran the raw command
(`bunx tsc --noEmit -p app/sidecar/tsconfig.json --pretty false`), captured all
**7,832** output lines, and drove the repo's own exported
`collectOwnedDiagnostics` / `hasTypecheckInfrastructureFailure` over them.

- **Count**: exactly **5,560** lines match `: error TS\d+:` — the same number the
  wrapper reports, and the same number A20 reported. `CLAUDE.md`'s "~5.5k" holds.
- **The failure mode that would make the filter worthless does not exist.**
  **Zero** of the 5,560 diagnostics use an absolute path; every one is
  cwd-relative (`src/agent-mode/AgentModeWorkerRoster.tsx(1,19): error TS7016: …`).
  Since tsc uses one base for every diagnostic in a run, an owned error is
  necessarily printed as `app/sidecar/…` or `app/shared/…` and necessarily
  matches.
- **An owned error does fail the wrapper.** Injecting one realistic owned line
  into the real 7,832-line output yields `collectOwnedDiagnostics(...).length === 1`,
  which drives `console.error(...) + process.exit(1)` at `:42-45`, before the
  success message. An `app/shared/` line matches too.
- **Not over-broad.** Discrimination table, all as required:
  `src/agent-mode/sessionState.ts(613,9): error TS2783:` → no match;
  `app/renderer/src/App.tsx(…)` → no match; `app/main/main.ts(…)` → no match;
  `node_modules/app/sidecar/x.ts(…)` → no match (the `^` anchor holds after the
  per-line `trim()`). The one thing that *does* match beyond the letter of the
  regex is a leading-whitespace owned line, because `:6` trims first — which is
  correct behaviour, not over-breadth.
- **Scope matches the project.** `app/sidecar/tsconfig.json` includes
  `./**/*.ts` + `../shared/**/*.ts` + the root `env.d.ts`, and the regex
  whitelists exactly those two owned directories.
- The only leak is the locationless-error case, filed as A20-F8 above and
  downgraded there to "proven in the function, no real `tsc` trigger found".
- A20's side note is also right: `CLAUDE.md` says the include-override "drops root
  `env.d.ts`"; `../../env.d.ts` is in the include list today. Doc drift.

**Verdict: a green `typecheck:sidecar` is meaningful.** It means zero
diagnostics in `app/sidecar/**` and `app/shared/**`, and the 5,560 ignored
diagnostics are all in `src/`.

### A20 — `prepare-dev-electron.ts` protects the `app.isPackaged` footgun with a real test — **CONFIRMED**

- The four constants and shapes A20 cites all hold:
  `REBRANDED_PLIST_KEYS = ['CFBundleName','CFBundleDisplayName']` at `:41`;
  `DEV_ELECTRON_BINARY` ending `Contents/MacOS/Electron` at `:48`; `cp -Rc` with
  no rename at `:83`; the PlistBuddy loop iterating the **exported** constant at
  `:95`.
- `prepare-dev-electron.test.ts` asserts all four independently —
  `basename(DEV_ELECTRON_BINARY).toLowerCase() === 'electron'`,
  `REBRANDED_PLIST_KEYS` deep-equals the two display keys and does **not**
  contain `CFBundleExecutable`, the source contains
  `for (const key of REBRANDED_PLIST_KEYS)`, and the extracted `run('…')` command
  list deep-equals `['cp','/usr/libexec/PlistBuddy','codesign']` with no
  `renameSync`. **I ran it: 3 tests, 0 fail.**
- The second, independent backstop is real: `main.ts:850-853` writes a loud
  stderr warning naming the executable-name cause when `CATCODE_RENDERER_URL` is
  set but the packaged branch won.
- A20's own caveat is the right one and I confirm it: the command extraction
  regex is `/run\('([^']+)'/g`, single-quoted literals only, so a `run("mv", …)`
  or a direct `spawnSync` would evade *that* assertion — while the basename and
  plist-key assertions still hold, bounding the damage.
- One thing to add: the test deliberately never executes `prepareDevElectron()`
  (its header says why — it re-signs a bundle the operator's live dev app may be
  running from), so this is a **source-shape + constants** guard, not a
  behavioural one. That is the correct trade here, but it means a change to
  `sourceApp`/`targetApp` that broke the copy would not be caught.

### A10 — the preload is genuinely default-deny, pinned by `preloadSource.test.ts` — **PARTIALLY CONFIRMED**

The **shape** claim re-derives completely. The **enforcement** claim does not.

What holds, re-derived independently:

- Every sender names a `CH_*` constant: all 16 `ipcRenderer.send`, all 10
  `ipcRenderer.invoke`, and both `ipcRenderer.on`/`removeListener` pairs take an
  identifier, never a literal and never renderer input. (One nit: the report says
  "module-level" — `CH_DEBUG_SHELL_STATE` is declared **inside** the
  `__CATCODE_DEV_HARNESS__` block at `:358`, not at module scope. It is still a
  fixed constant and it is compiled out of the packaged preload.)
- No generic `send`/`invoke`, no `ipcRenderer` handle, no Node primitive, nothing
  live crosses `contextBridge` (`:365`).
- `preloadSource.test.ts:126-129` does extract the first argument of every
  `ipcRenderer.invoke` and assert both that there are exactly **10** and that each
  is one of ten named `CH_HOST_*` constants (`:130-144`).
- The comment-stripping detail the report praises is real and does make the
  default-deny assertions honest (`:147-164`).
- `subscribe`/`subscribeHost` correctly do not call the guard, and the test says
  so in prose (`:84-85`).
- `sendGuard.assertAllowed` does appear exactly **29** times, pinned at `:92`.
  **I ran the file: 3 tests, 0 fail.**

What does **not** hold — the pin's polarity is inverted. The report says the
29-pin means "adding a sender without guarding it fails the suite". It is the
opposite. I re-ran the test file's own regexes over mutated copies of `preload.ts`
in the scratchpad (no repo file touched):

```
baseline (unmodified):                                        passes: true
MUTATION 1 — new UNGUARDED ipcRenderer.send('catcode:exfiltrate', payload):
  guardPin true · invokeCountPin true · noGenericSend true    passes: TRUE
MUTATION 2 — new UNGUARDED ipcRenderer.invoke('catcode:host:anything', ch):
  guardPin true · invokeCountPin true · noGenericInvoke true  passes: TRUE
MUTATION 3 — new GUARDED sender (sendGuard.assertAllowed + CH_PING):
  guardPin FALSE                                              passes: FALSE
```

Two independent reasons:

1. Pinning the count at 29 detects a **change** in the number, so it fires on a
   *guarded* addition (forcing an honest number bump) and stays silent on an
   *unguarded* one.
2. The invoke-channel extractor is `/ipcRenderer\.invoke\((\w+)/g` — `\w+` cannot
   match a quoted string, so a literal-channel `invoke` is invisible to both the
   count and the allowlist, and `not.toContain('invoke(channel')` only catches a
   variable literally named `channel`.

**The real backstop exists, but it is elsewhere and it is narrower.**
`hardening-smoke.ts:313-317` compares `Object.keys(window.catcode).sort()` against
a 30-name allowlist, so a new *bridge method* fails — under `test:hardening`, a
different command (A20-F2's point). An unguarded `ipcRenderer.send` added **inside
an existing method** is caught by nothing at all.

**Disposition for the clean bill:** keep the praise for the shape, drop the
enforcement claim, and close the gap with two cheap assertions in
`preloadSource.test.ts`: (a) extract every `ipcRenderer.send(` / `invoke(` first
argument with a regex that also matches string literals, and fail if any is not a
`CH_*` identifier; (b) assert that the number of `ipcRenderer.send`/`invoke` call
sites equals the number of `sendGuard.assertAllowed` calls, which is the invariant
the 29-pin was reaching for and states it in a form that fires on the unguarded
case.

## Findings the original reports missed

Only items I verified to the same bar.

1. **`run-hardening-smoke.ts` never checks `spawnSync`'s `error`, so a 20-second
   timeout is reported as a pass.** `:77-84` tests `smoke.status !== 0` and the
   stdout marker. I proved that on a `timeout` expiry Node leaves `status` at the
   child's real exit code and signals the failure only through
   `error.code === 'ETIMEDOUT'`:
   ```
   elapsed_ms: 3002   status: 0   signal: null   error: ETIMEDOUT
   stdout captured: "[hardening-smoke] production path passed\n"
   run-hardening-smoke would report FAILURE: false
   ```
   Combined with the proven fact that `spawnSync` waits for **grandchild** pipe
   EOF, this is the reason A20-F1's leak has never announced itself: an orphaned
   sidecar holding main's inherited stdout makes the harness sit for the full 20 s
   and then print success. One added `|| smoke.error` turns the leak into a
   self-reporting failure and is the single highest-value line in this scope.

2. **`supervisor.shutdown()` destroys the identity signal the next launch's
   orphan sweep needs.** `shutdown()` `rmSync`s the whole socket directory
   (`supervisor.ts:387`) while `killSession` only SIGTERMs (no wait, no
   escalation — A10-F3). `registry.matchesSidecarIdentity` refuses to kill unless
   the row's `socketPath` **still exists on disk**. So a sidecar that survives the
   unescalated SIGTERM has had its socket file deleted by the very teardown that
   failed to kill it, and is therefore permanently unsweepable by every future
   launch — the row is marked `crashed` and the process runs on to its 15-minute
   TTL. A10 reports the two halves separately (F3's no-escalation, F4's
   "secondary damage" note) but not that `shutdown()` itself manufactures the
   condition. The fix follows A10-F3's: do not remove the directory until the
   grace window has elapsed.

3. **The replay-truncation request id is declared twice across a process
   boundary, and the display filter depends on the two staying equal.**
   `replayBuffer.ts:76` declares `REPLAY_TRUNCATION_REQUEST_ID` privately in
   main; `rawMessageLog.ts:26` declares `REPLAY_BUFFER_TRUNCATION_REQUEST_ID`
   again in the renderer, with a comment saying it is "a second copy" pending
   promotion to `shared/protocol.ts`. Both consumers' drops
   (`rawMessageLog.ts:117`, `previewTranscriptState.ts:139`) key off the renderer
   copy. Renaming the main-side string would silently un-drop the banner and
   restore the exact "undismissable red line above the composer" the comment
   records — with the wrong frame count in it (A10-F7). Its sibling
   `HISTORY_REPLAY_TRUNCATION_REQUEST_ID` is already in `shared/protocol.ts:588`,
   and that file's own doc comment at `:585` names the missing one, so the
   promotion is a two-line change with an obvious home.

## Uncertainty

- **Whether a live `test:hardening` run leaves an orphan is still unproven.** I
  proved every link of the mechanism with real processes, but not the harness end
  to end — running it is what the contract forbids and what would create the
  orphan. This machine shows no Electron launch of this app today
  (`~/Library/Application Support/@cat-code/desktop` last touched 2026-08-07
  22:15:54; zero 08-08 `/tmp/catcode-*` dirs), so the operator's green run cannot
  be used as evidence either way. Settled by: run it, time it, then
  `ls -ldt /tmp/catcode-* | head -1` and
  `ps -axo pid,ppid,rss,command | grep '[s]idecar/index.ts'`.
- **A20-F8's locationless-error case has no real `tsc` trigger.** Proven at the
  function level with the real module; every locationless error I could think of
  (TS5083/TS6046/TS18003) aborts before emitting diagnostics, which lands in the
  case the predicate already handles. Settled by: finding one `tsc` invocation
  that emits `error TS\d+:` with no file prefix *alongside* normal diagnostics.
- **Whether macOS enforces connect permission on a 0755 Unix socket.** I measured
  the live socket's mode (`srwxr-xr-x`) but cannot test a cross-user `connect()`
  on a single-user machine. This only affects how much of A10-F2's sub-claim (a)
  survives; sub-claim (b) (pre-creation squat) is unaffected and is the half worth
  fixing. Settled by: a second local account attempting `connect()` to a live
  `s0.sock`.
- **`app.exit()` semantics were verified on this Electron only** (`electron@^33.2.1`
  as installed in `app/node_modules`). The behaviour is documented and stable, but
  I did not check other majors.
