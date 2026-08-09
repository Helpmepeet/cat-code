# A20 — app build, dev, and harness tooling

## Verdict

This is the strongest-engineered corner of `app/` I have read. `devLauncher.ts` +
`dev.ts` is a genuinely good supervision split (pure decisions, injected clock/kill,
child-exit checked before the readiness probe), `prepare-dev-electron.ts` protects its
expensive footgun with a real test rather than a comment, and `sidecar-typecheck.ts`'s
filter is correct and not over-broad — I proved both empirically. The single most
important thing to fix is that two of the harnesses (`hardening-smoke.ts`,
`harness-demo-driver.ts`) end their run with a bare `app.exit()`, which Electron
documents as skipping `before-quit`/`will-quit` — and `before-quit` is the *only* place
`main.ts` tears down the engine sidecars it spawned. Every green `bun run --cwd app
test:hardening` therefore orphans a real ~230 MB sidecar; `f2-attach-smoke.ts` in the
same directory shows the correct shape. Secondary: "hardening 19/19" is a
renderer/main-process result and licenses none of the sidecar-boundary security
baseline, which is easy to misread from the harness's own "production path passed" line.

## Findings

### [HIGH] Harness `app.exit()` skips `before-quit`, orphaning the engine sidecars the run spawned
- **Where**: `/Users/pt/cat-code/app/scripts/hardening-smoke.ts:391`, `/Users/pt/cat-code/app/scripts/harness-demo-driver.ts:99`
- **Type**: correctness (resource leak)
- **What**: Both harnesses end with `app.exit(code)`. Electron's `app.exit()` closes
  windows immediately and does **not** emit `before-quit`/`will-quit`. `main.ts`'s only
  sidecar teardown is `shutdownRuntime()` → `host.shutdownAll()`, hung off
  `window-all-closed` (`app/main/main.ts:1903-1907`) and `before-quit`
  (`app/main/main.ts:1927-1932`). Neither runs, so every engine sidecar the harness's
  real main process started survives the run. `main.ts` itself already documents the
  correct shape at `app/main/main.ts:1891-1898`: `teardownOnSignal` calls
  `stopBackgroundDrivers()` + `shutdownRuntime()` **and then** `app.exit()`, with a
  comment explaining exactly why the plain-exit path loses the teardown.
- **Trigger / why it matters**: Run `bun run --cwd app test:hardening`. Production main
  auto-creates a startup session (a real Bun sidecar, ~230 MB RSS per the RAM-0 numbers
  in `docs/migration/decisions/IDLE-PARK.md:16`). The harness prints 19/19, calls
  `app.exit(0)`, main dies, the sidecar does not (die-with-window is supervisor
  behaviour, not process welding — SESSION-LIFETIME L2). This is not hypothetical:
  `docs/migration/STATUS.md` CC-3 records it verbatim — "the hardening harness leaked 1
  sidecar mid-session (42→43) — the exact failure the standing rule targets". It also
  compounds: `run-hardening-smoke.ts:82,85` deletes the temp `CLAUDE_CONFIG_DIR` while
  the orphan is still running against it, so the survivor is left pointed at a deleted
  config root until CC-3's 15-minute idle TTL reaps it. On a machine where several agent
  sessions each run the battery, that is several hundred MB of orphans at any moment —
  the exact condition CC-3 was created to end. `f2-attach-smoke.ts:234` gets this right
  (`supervisor.shutdown()` before `app.exit`), which makes the gap an inconsistency, not
  an unknown.
- **Fix**: In both harnesses, replace the bare `app.exit(code)` with `app.quit()`, or
  keep `app.exit` and emit the teardown first. `hardening-smoke.ts` is an external
  `--require` preload with no handle on `host`, so `app.quit()` (which *does* fire
  `before-quit`) is the smaller change; `harness-demo-driver.ts:98-101` already has a
  250 ms `process.exit` backstop that covers a quit that stalls.

### [MED] "hardening 19/19" covers the renderer document, not the security baseline
- **Where**: `/Users/pt/cat-code/app/scripts/hardening-smoke.ts:289-369`, `/Users/pt/cat-code/app/scripts/run-hardening-smoke.ts:79`
- **Type**: quality (misleading verification signal)
- **What**: The 19 checks are exactly: crafted-Markdown rendered (1), no
  `require`/`process`/`module`/`global` on `window` (4), five Markdown-XSS assertions
  (`<script>`, `img onerror`, `javascript:` execution, `javascript:` URL stripped, raw
  `target=_blank` not an active link) plus one inert-https check (6), bridge exposed +
  bridge key set exactly equals the allowlist + no raw `ipcRenderer` (3), CSP blocks
  dynamic inline script and inline `onerror` (2), `will-navigate` blocked (1),
  `setWindowOpenHandler` denied (1), packaged path wrote no debug export (1). Every one
  of them is a property of the **renderer document and the Electron main process**. The
  harness opens no sidecar socket and sends no client frame in the renderer→engine
  direction at all: `window.webContents.send(CH_SERVER_FRAME, …)` at lines 192/199/207 is
  main→renderer only.
- **Trigger / why it matters**: A reader who sees `19/19` + `[hardening-smoke] production
  path passed` in a STATUS row or a session report will reasonably conclude the security
  baseline was exercised. It was not. **Nothing** in these 19 checks touches: T4
  `goalSnapshot` schema validation; T5a engine-minted permission request-id matching; T6
  echo-only `updatedInput`; T6b stripping renderer-authored `updatedPermissions`; T7
  frame-size/rate/prompt caps; the `MAX_FRAME_BYTES` vs `MAX_OUTBOUND_FRAME_BYTES`
  directional split; `secretGuard` on outbound frames; HC1 (renderer never authors a
  path); HC2 (session addressing validated); HC4 (`MAX_LIVE_SESSIONS` + spawn rate cap).
  Only HC3 is partly covered, and only as a key-name *shape* check on the preload
  surface, not as sidecar-side validation. All of the above *are* covered — by
  `app/sidecar/sidecarServer.test.ts` (21 `updatedPermissions`, 8 `secretGuard`, 8
  `goalSnapshot`, 5 `T7`, 5 `T6`, 4 `T6b`, 3 `T5a`, 3 `T4`, 2 each of the two `MAX_*`
  constants, 2 `HC1` references) and the per-domain boundary suites — but those run under
  `bun test app/`, a different command. `CLAUDE.md` states this correctly
  ("`test:hardening` green **+ boundary tests** for any new inbound frame"); it is the
  `19/19` shorthand in prose that over-claims.
- **Fix**: Change the harness's summary line from `production path passed` to something
  that names its scope (e.g. `renderer document + main-process policy: N/N`), and say the
  same in the failure line at `run-hardening-smoke.ts:81`. No new tests needed — this is a
  labelling fix on a signal that is otherwise honest.

### [MED] `dev.ts` installs its signal handlers only after the readiness wait, so a SIGTERM in that window orphans Vite
- **Where**: `/Users/pt/cat-code/app/scripts/dev.ts:95-118` vs `:185-190`
- **Type**: correctness (resource leak on partial failure)
- **What**: Vite is spawned at line 95-101. `process.on('SIGINT')` / `process.on('SIGTERM')`
  are not registered until lines 185/188 — after `await waitForRendererReady(...)` (up to
  `READY_TIMEOUT_MS = 15_000`) and after the Electron spawn. During that window the
  launcher has a live child and default signal disposition.
- **Trigger / why it matters**: Start `bun run --cwd app dev`; while it is polling for
  :5173, `kill <launcher-pid>`. The default SIGTERM action terminates the launcher
  immediately, `stop(vite)` never runs, and because `spawn` is not `detached` but SIGTERM
  was addressed to a single pid (not the process group), the Vite child survives with
  :5173 held. The next `bun run dev` then fails with exactly the stale-server message the
  launcher itself authors (`devLauncher.ts:140-146`), and the operator has to go find the
  pid. This is the precise recovery move `CLAUDE.md` instructs agents to use on a hung
  launch ("report the PID you recorded"; `kill <pid>` is explicitly the allowed form under
  the sweep-kill hook), so the window is reachable by normal repo practice, not just by
  accident. Interactive Ctrl-C is *not* affected: it signals the whole foreground process
  group, so Vite dies with the launcher.
- **Fix**: Hoist the two `process.on(...)` registrations above the Vite spawn. `shutdown()`
  already guards on `shuttingDown` and `stop()` already no-ops on a child that never
  started (`terminateChild` returns `'already-exited'`), so the handlers are safe to arm
  before `electron` exists — the only change needed is making `shutdown` tolerate
  `electron` being undefined (declare it as a mutable `Supervised | null`).

### [MED] `harness-demo.ts` re-implements `terminateChild` and leaks Electron on its own timeout
- **Where**: `/Users/pt/cat-code/app/scripts/harness-demo.ts:123-173`
- **Type**: correctness + duplication
- **What**: Two problems in one block. (a) The file already imports
  `waitForRendererReady` and `describeReadinessFailure` from `./devLauncher.js`, then
  writes its own `terminateChild` (lines 134-148) instead of importing the tested one two
  symbols away. The local copy resolves only via `child.once('exit', …)`, so if the child
  has already exited between the `exitCode !== null` guard and the listener attach, the
  promise never settles and `cleanup()` hangs. `devLauncher.ts:106-126` returns
  unconditionally after SIGKILL and has no such path. (b) `waitForExit` (lines 162-173) is
  the real leak: on timeout it calls `child.kill()` and **rejects immediately** without
  awaiting the exit, and `cleanup()` (lines 123-132) terminates only `viteProcess` —
  `electron` is never referenced there.
- **Trigger / why it matters**: A harness-demo run where the debug-state predicate never
  settles hits the 45 s `waitForExit` timeout; the script prints `[harness-demo] failed`,
  removes the scratch dirs, kills Vite, and exits — leaving an Electron process (and, per
  the HIGH above, its sidecar) alive on the operator's machine, now pointed at a
  `CLAUDE_CONFIG_DIR` that was just `rmSync`'d at line 131.
- **Fix**: Delete the local `terminateChild` and use the imported one (which is what
  `harnessDemoSource.test.ts:14-15` is really asserting the shape of), hold the Electron
  child in a module-scoped variable alongside `viteProcess`, and terminate it in
  `cleanup()`.

### [MED] `app/scripts/preview-transcript.tsx` is typechecked by no tsconfig in the repo
- **Where**: `/Users/pt/cat-code/app/tsconfig.json:29` (`"scripts/**/*.ts"`), file at `/Users/pt/cat-code/app/scripts/preview-transcript.tsx`
- **Type**: quality (coverage gap)
- **What**: `app/tsconfig.json` includes `scripts/**/*.ts`; TypeScript's `*.ts` glob does
  not match `.tsx`. `app/sidecar/tsconfig.json` covers only `app/sidecar` + `app/shared`.
  I confirmed the program contents: `tsc -p app/tsconfig.json --listFilesOnly` pulls in
  exactly 21 files from `app/scripts/`, all `.ts` — `preview-transcript.tsx` is not among
  them. It is also outside `lint:fast-refresh` (which globs `renderer/src/**/*.tsx`).
- **Trigger / why it matters**: The file imports live renderer types and values —
  `TranscriptRowsView` from `../renderer/src/TranscriptView.js`, `ToolsExpandedContext`,
  and `NestedTranscriptRow` from `../renderer/src/transcriptProjector.js` — and hand-builds
  row fixtures against that type. `NestedTranscriptRow` is one of the most-churned types in
  the package (the current working tree has in-flight `agent_name`/subagent work touching
  exactly this projector). When the shape moves, nothing fails: not `typecheck`, not
  `typecheck:sidecar`, not `bun test app/`. The rot surfaces only when an operator runs
  `preview:transcript` — and the file's own header says it exists precisely because the
  SSR-only renderer suite let a colour/layout regression through, i.e. it is the tool you
  reach for when the batteries have already lied to you. I verified it typechecks clean
  today (isolated `tsc` against `app/tsconfig.json` with the file added: zero
  diagnostics), so this is a gap to close, not a live break.
- **Fix**: Add `"scripts/**/*.tsx"` to the `include` array in `app/tsconfig.json`.

### [MED] `app/eslint.config.js` registers two plugins and enables zero rules from them
- **Where**: `/Users/pt/cat-code/app/eslint.config.js:17-27`
- **Type**: dead-code / quality
- **What**: `jsx-a11y` and `react-hooks` are imported, listed as devDependencies, and
  registered in `plugins`, but the `rules` block contains exactly one entry
  (`react-refresh/only-export-components`). A registered plugin with no enabled rule does
  nothing at all.
- **Trigger / why it matters**: Two costs. First, the config reads as if accessibility and
  hooks linting are on; they are not, so "lint clean" on a renderer change carries less
  than it looks like (already a repo-wide caveat, but this is a second instance of it
  inside `app/`). Second, the two rules that are off — `react-hooks/rules-of-hooks` and
  `react-hooks/exhaustive-deps` — are the ones that catch stale-closure and
  conditional-hook bugs, a class this repo has hit before (`MEMORY.md`: "stale closures"
  is a standing review axis, and the SSR-only renderer suite cannot see them). The plugin
  is installed and one line away from being useful.
- **Fix**: Either enable `...reactHooks.configs.recommended.rules` (scoped to
  `renderer/src/**/*.{ts,tsx}`) and a jsx-a11y baseline, or delete both plugin
  registrations and their devDependencies so the config stops implying coverage it does
  not provide. Enabling them will surface pre-existing violations — treat that as its own
  session, not a drive-by.

### [MED] `ram-fleet.ts` duplicates ~80 lines of `ram-probe.ts` verbatim, and `parseArgs` exists four times
- **Where**: `/Users/pt/cat-code/app/scripts/ram-fleet.ts:63-135` vs `/Users/pt/cat-code/app/scripts/ram-probe.ts:53-130`; `parseArgs` also in `/Users/pt/cat-code/app/scripts/ram-measure.ts:41` and `/Users/pt/cat-code/app/scripts/ram-corpus-gen.ts:71`
- **Type**: quality (duplication)
- **What**: `parseArgs`, `sizeTokenToMB`, `psRssMB`, `vmmapSummary`, `childPids` and
  `isAlive` are byte-identical between `ram-fleet.ts` and `ram-probe.ts` (modulo
  `vmmapSummary`'s return type, which drops `raw` in the fleet copy). The file
  acknowledges it in a comment at `ram-fleet.ts:76-78`: "verbatim reuse of ram-probe.ts
  idioms (ram-probe.ts:75-131)". `parseArgs` is copied a further two times.
- **Trigger / why it matters**: These are the measurement primitives behind numbers that
  became ratified decisions — the `~223 MB per parked session` figure in
  `docs/migration/decisions/IDLE-PARK.md:16` comes out of `ram-fleet.ts`, the RAM-0 boot
  floor out of `ram-probe.ts`. A parsing fix applied to one copy (say, `vmmap` changing its
  `Physical footprint` line format on a macOS update) silently leaves the other reporting
  a different, wrong number, and the two instruments' outputs are compared against each
  other in the reports. The comment marking the duplication as deliberate makes it worse,
  not better: it documents that a divergence is expected to be caught by a reader.
- **Fix**: Extract the six helpers into `app/scripts/ramSampling.ts` and import from all
  four scripts. `ramScriptsSource.test.ts` asserts on source substrings (`ram-fleet.ts`
  containing `sc.proc.kill(9)`, `ram-probe.ts` containing `proc.kill(9)`) and will need
  those anchors re-pointed.

### [LOW] `sidecar-typecheck.ts` swallows a locationless compiler error whenever any diagnostic exists
- **Where**: `/Users/pt/cat-code/app/scripts/sidecar-typecheck.ts:15-20,37-40`
- **Type**: correctness (narrow)
- **What**: `hasTypecheckInfrastructureFailure` returns true only when
  `exitCode !== 0 && countDiagnostics(output) === 0`. A locationless error (`error TS5083:
  Cannot read file …`, `TS6046`, a bad `--project` flag) that is emitted *alongside* the
  ~5.5k upstream diagnostics fails both the owned-diagnostic regex (no `app/…` prefix) and
  the infrastructure check (diagnostics > 0), so the wrapper prints "Scoped sidecar
  typecheck passed" and exits 0.
- **Trigger / why it matters**: Config-level errors are exactly the ones that would mean
  the *owned* files were never checked at all. The window is narrow because most such
  errors abort tsc before it emits anything, but the check is one predicate away from
  being airtight.
- **Fix**: Treat any `error TS\d+` line that has no `file(line,col):` prefix as an
  infrastructure failure regardless of the diagnostic count.

### [LOW] `sidecar-typecheck.ts` derives `repoRoot` from `URL.pathname`, which is percent-encoded
- **Where**: `/Users/pt/cat-code/app/scripts/sidecar-typecheck.ts:23`
- **Type**: correctness (latent)
- **What**: `new URL('../..', import.meta.url).pathname` returns a percent-encoded path.
  On a checkout whose absolute path contains a space or any non-ASCII character, `cwd`
  becomes a path that does not exist and `Bun.spawnSync` fails. Everywhere else in
  `app/scripts/` the idiom is `dirname(fileURLToPath(import.meta.url))`, which decodes
  correctly (`dev.ts:28`, `build-electron.ts:17`, `run-hardening-smoke.ts:18`,
  `prepare-dev-electron.ts:22`).
- **Trigger / why it matters**: Does not fire at `/Users/pt/cat-code`; fires on any clone
  under a directory with a space. The failure mode is confusing (tsc reports the project
  file missing), and the fix matches the file's neighbours.
- **Fix**: `const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')`.

### [LOW] `fastRefreshBoundaries.test.ts` is non-recursive, so any renderer subdirectory escapes it
- **Where**: `/Users/pt/cat-code/app/renderer/src/fastRefreshBoundaries.test.ts:16`
- **Type**: quality (coverage gap)
- **What**: The runtime backstop for the Fast Refresh boundary uses `readdirSync(here)`,
  a flat listing of `renderer/src` only. It is the *strong* half of the enforcement: the
  eslint rule alone cannot catch a `.tsx` that exports only helpers, because
  `only-export-components` reports non-component exports only when the file also has a
  component export (`app/node_modules/eslint-plugin-react-refresh/index.js:240-254`:
  `if (hasExports) { if (hasReactExport) { report nonComponentExports } … }`). The runtime
  test closes that hole by asserting `isLikelyComponentType` on every export of every
  non-test `.tsx`.
- **Trigger / why it matters**: `renderer/src` is flat today (91 top-level `.tsx`, only
  `assets/` and `assets/fonts/` as subdirectories, no `.tsx` in either), so nothing is
  currently missed. The moment someone adds `renderer/src/settings/Foo.tsx` — a natural
  move at 91 files in one directory — that file gets only the weaker eslint check and the
  helper-only case stops being caught.
- **Fix**: `readdirSync(here, { recursive: true })` with the same `.tsx` / `.test.tsx` /
  `main.tsx` filters.

### [LOW] Harness bundle artifacts: stale `.gitignore` entry and one bundle never cleaned up
- **Where**: `/Users/pt/cat-code/app/.gitignore:6`, `/Users/pt/cat-code/app/scripts/run-hardening-smoke.ts:51,74`, `/Users/pt/cat-code/app/scripts/run-f2-attach-smoke.ts:26`
- **Type**: quality
- **What**: Two small mismatches. (a) `.gitignore` lists `scripts/hardening-smoke.js`, but
  `run-hardening-smoke.ts` emits `hardening-smoke.cjs` (`naming: '[name].cjs'`, line 57) —
  the ignore entry does not match the file. The `rmSync` at line 74 hides this on the happy
  path, but it runs *after* the `spawnSync`, so a throw or a non-zero-exit path that
  short-circuits earlier leaves an untracked `hardening-smoke.cjs` in `app/scripts/`.
  (b) `run-f2-attach-smoke.ts` never removes its `f2-attach-smoke.js` at all — that one *is*
  correctly gitignored, and a 24 KB copy from 2026-07-06 is sitting in the tree right now.
- **Trigger / why it matters**: On this shared tree, `CLAUDE.md` §4 tells every agent that
  an untracked file it does not recognise is another session's live work and must not be
  removed. A leftover `hardening-smoke.cjs` is therefore a permanent, un-cleanable-by-policy
  artifact until someone traces it back to this script. The stale bundle also stays runnable
  by hand (`electron app/scripts/f2-attach-smoke.js`) long after its source has moved.
- **Fix**: Change the ignore entry to `scripts/hardening-smoke.cjs`; move the `rmSync` in
  `run-hardening-smoke.ts` into a `try/finally` around the spawn; add the same cleanup to
  `run-f2-attach-smoke.ts`.

### [LOW] Unvalidated numeric argv in the `ram-*` scripts turns a typo into a silently wrong measurement
- **Where**: `/Users/pt/cat-code/app/scripts/ram-fleet.ts:378-380`, `/Users/pt/cat-code/app/scripts/ram-probe.ts:206-209`, `/Users/pt/cat-code/app/scripts/ram-measure.ts:86`, `/Users/pt/cat-code/app/scripts/ram-corpus-gen.ts:104-107`
- **Type**: correctness (narrow) / quality
- **What**: `ram-fleet.ts` validates `--n` and `--cap` properly (lines 382-390) but not
  `--settle-ms`, `--ready-timeout-ms` or `--park-timeout-ms`; the other three scripts
  validate nothing. `Number('2500ms')` is `NaN`, and `setTimeout(fn, NaN)` is treated as
  `0`.
- **Trigger / why it matters**: `bun run app/scripts/ram-fleet.ts --settle-ms 2500ms`
  produces a full, plausible-looking JSON result with the settle window silently collapsed
  to zero — i.e. RSS sampled before the engines have settled. These scripts exist to
  produce decision-grade numbers that get written into ratified decision docs; a
  measurement that is wrong but well-formed is the worst possible output for them.
- **Fix**: Route every `Number(args[...])` through a small `requireFiniteMs(name, value)`
  helper that exits 2 on `NaN`, matching the treatment `--n`/`--cap` already get.

### [LOW] `ram-fleet.ts` emergency cleanup leaves `/tmp/ramfleet-*` directories behind
- **Where**: `/Users/pt/cat-code/app/scripts/ram-fleet.ts:204-215` vs `:492`
- **Type**: correctness (resource leak)
- **What**: The normal path removes each sidecar's `socketDir` (`rmSync(sc.socketDir, …)`
  at line 492). `emergencyCleanup()` — the SIGINT/SIGTERM/SIGHUP path — destroys sockets
  and kills the fleet but does not remove the temp dirs.
- **Trigger / why it matters**: Ctrl-C during a fleet run leaves N `/tmp/ramfleet-*` trees,
  each containing a config dir and a cwd. This is the same class of `/tmp` residue that
  CC-3 had to clean up 44 of; the reaper script (`reap-orphan-sidecars.ts`) only knows the
  `catcode-<pid>` naming, so it will not find these.
- **Fix**: Move the `rmSync(sc.socketDir, …)` loop into `emergencyCleanup()` so both paths
  share it.

### [LOW] `ram-measure.ts` drops an unparseable rep from the aggregate instead of recording it as failed
- **Where**: `/Users/pt/cat-code/app/scripts/ram-measure.ts:128-139`
- **Type**: quality (error handling shape)
- **What**: When the probe exits non-zero, the script pushes a failed placeholder result
  and continues (lines 129-133) — correct. When the probe exits 0 but its stdout will not
  `JSON.parse`, the `catch` writes a stderr line and pushes **nothing** (lines 136-138), so
  that rep vanishes from `results` and therefore from the per-condition aggregate.
- **Trigger / why it matters**: A `--reps 3` run where one probe emits a stray line on
  stdout reports a mean over 2 reps while still labelling itself a 3-rep run; the stderr
  note is easy to miss in a long measurement log. The two failure paths should be
  symmetric.
- **Fix**: Push the same failed placeholder in the `catch` that the non-zero-exit branch
  pushes.

## Dead-harness audit (requested item 6)

Checked `package.json` scripts, `docs/migration/**` (decisions, backlog, specs, STATUS,
reviews, reports), and `docs/reports/**` before judging any script. **None of the three
candidates is deletable, and two are explicitly protected by a ratified ruling.**

| Script | Status | Evidence |
|---|---|---|
| `f2-attach-smoke.ts` / `run-f2-attach-smoke.ts` | **documented-only, protected** — no `package.json` script, but an explicit keep ruling | `docs/migration/STATUS.md` CC-5 ruling **#10: "keep both script harnesses (`f2-attach-smoke`, `harness-demo`)"** (RATIFIED 2026-07-21). Also cited in `docs/migration/decisions/PROTOCOL-ENVELOPE.md`, `docs/migration/backlog/phase3.md:174` (a backlog item instructs a session to *extend* it), and four review docs. |
| `harness-demo.ts` / `harness-demo-driver.ts` | **documented-only, protected** — no `package.json` script | Same CC-5 ruling #10. Plus `docs/migration/specs/2026-07-05-gui-harness-design.md` (it is the P3-H harness), `docs/migration/backlog/phase3.md:775`, and `docs/migration/process/GUI-VERIFICATION.md:3` which frames the whole agent-driven GUI process as "for … rows after P3-H". `.claude/rules/migration.md` requires every dispatched `🖐 GUI` prompt to "use the P3-H harness for launch/readiness/debug-export/registry cross-checks". Source-shape guarded by `harnessDemoSource.test.ts`. |
| `ram-probe.ts` / `ram-fleet.ts` / `ram-measure.ts` / `ram-corpus-gen.ts` | **documented-only, load-bearing** — no `package.json` script | `docs/migration/decisions/IDLE-PARK.md:16` cites `ram-fleet.ts` as the source of the ratified reclaim figure; `docs/migration/reports/2026-07-21-ram0-measurement*.md` and the raw JSON under `reports/ram0-raw*/` are `ram-probe`/`ram-measure` output; STATUS CC-5 calls the set "RAM-0 hermetic measurement instrument". Deleting them destroys the ability to re-derive a ratified number. Source-shape guarded by `ramScriptsSource.test.ts`. |
| `reap-orphan-sidecars.ts` | wired | `package.json:18` (`reap:orphans`) + `app/main/main.ts` + STATUS CC-3 deliverable (3). |
| `preview-transcript.tsx` | wired | `package.json:19` (`preview:transcript`). Deliberately not a gate (see its header). |

Genuinely orphaned: **none**. This matches the `MEMORY.md` note that referrer-greps have
twice misclassified scripts here — every candidate's only "referrer" is prose, and in two
cases the prose is a ratified operator ruling.

## Pattern-kill audit (requested item 7)

`reap-orphan-sidecars.ts` is the **only** script in `app/scripts/` that selects processes
by command-line matching (already reported by another agent — not re-raised here). Every
other kill in the directory is on a pid the script itself owns:

- `dev.ts:67` → `supervised.child.kill(signal)`, on children it spawned.
- `harness-demo.ts:139,146,165` → the `ChildProcess` handles it spawned.
- `f2-attach-smoke.ts:299` → `supervisor.getSessionProcessId(sessionA)`, a pid the
  harness's own supervisor minted.
- `ram-fleet.ts:196-201`, `ram-probe.ts:179` → killed through the Bun subprocess handle,
  with an explicit comment ("never by pid, so an already-exited victim can never be
  confused with whatever process now owns that number") and descendants gathered via
  `pgrep -P <ownedPid>`, which is parent-scoped, not a pattern sweep.

No `pkill`, no `killall`, no `xargs kill`, no `shell: true`, and no shell-interpolated
command anywhere in `app/scripts/` — every spawn is `spawn`/`spawnSync`/`execFileSync`/
`Bun.spawn` with an argv array.

## Directly answering the remaining prompt items

**Item 2 — `prepare-dev-electron.ts` invariant.** Still correct, and protected by more
than a comment. `REBRANDED_PLIST_KEYS = ['CFBundleName','CFBundleDisplayName']`
(`prepare-dev-electron.ts:41`), the PlistBuddy loop iterates that exported constant
(line 95), the copy is `cp -Rc` with no rename (line 83), and `DEV_ELECTRON_BINARY`
(line 48) ends in `Contents/MacOS/Electron`. `prepare-dev-electron.test.ts` asserts all
four independently: basename lowercases to `electron`, `CFBundleExecutable` is not in the
key list, the loop consumes the exported list, and the extracted `run('…')` command list
equals exactly `['cp','/usr/libexec/PlistBuddy','codesign']` with no `renameSync`. There
is a second, independent backstop at runtime: `app/main/main.ts:850-853` writes a loud,
specific stderr line when `CATCODE_RENDERER_URL` is set but the packaged branch won,
naming the executable-name cause. That is a genuinely durable pair. The one soft spot is
that the test's command extraction regex is `/run\('([^']+)'/g` — single-quoted literals
only — so a future `run("mv", …)` or a direct `spawnSync` would evade it; the
basename/plist-key assertions would still hold, so the damage is bounded.

**Item 3 — is the `sidecar-typecheck.ts` filter over-broad? No; proved empirically.**
I ran the raw command (`bunx tsc --noEmit -p app/sidecar/tsconfig.json --pretty false`,
exit 2) and captured all 7,832 output lines. Exactly **5,560** match `: error TS\d+:` —
the same number the wrapper reported ("5560 upstream diagnostics ignored"), so the
counter is accurate. Every diagnostic path is **cwd-relative** (`src/agent-mode/…`,
`src/utils/worktree.ts(607,17): error TS2307: …`); zero absolute paths, zero
`app/sidecar` or `app/shared` hits. That rules out the failure mode that would make the
filter worthless (tsc emitting absolute paths, so `^app/(sidecar|shared)/` never matches
and the wrapper always passes): tsc uses one base for every diagnostic, so an owned error
would be printed as `app/sidecar/foo.ts(1,1): error TS…` and match. The owned set also
lines up exactly with what the project compiles — `app/sidecar/tsconfig.json:13` includes
`./**/*.ts` (= `app/sidecar`) + `../shared/**/*.ts` (= `app/shared`) + root `env.d.ts`,
and the regex whitelists precisely those two directories. On the exit path,
`ownedDiagnostics.length > 0 → console.error(…) + process.exit(1)`
(`sidecar-typecheck.ts:42-45`) runs before the success message, so a single owned error
fails the wrapper. The only leak is the locationless-error case filed as LOW above.
(Side note: `CLAUDE.md` says the include-override "drops root `env.d.ts`" — it does not
any more; `../../env.d.ts` is in the include list. Doc drift, not a code bug.)

**Item 4 — does Ctrl-C tear down all three, including on a failed start?** Yes on the
happy path and on most failure paths; the one gap is the pre-registration window filed
as MED above. Concretely: the build step is `spawnSync` and completes before Vite exists
(`dev.ts:89-92`), so a build failure has nothing to leak. A readiness failure runs
`await stop(vite)` before exiting 1 (lines 120-124). Electron exiting on its own, Electron
failing to spawn (`error` without `exit`), and Vite dying after readiness all funnel into
the same re-entrant `shutdown()` (lines 149-181), which awaits `Promise.all([stop(electron),
stop(vite)])` before `process.exit`. `dev.ts` **does** use `devLauncher.terminateChild` —
via `stop()` at lines 65-74, with `graceMs: 5_000` and `pollMs: 100` — so it gets the
SIGTERM → grace → SIGKILL escalation, and `shutdown` awaits it rather than exiting
underneath it. I also checked the `bunx` layer, since `spawn('bunx', ['vite', …])` would
be a problem if `bunx` forked: it does not. Empirically, backgrounding `bunx tsc -w` and
inspecting the job pid showed the pid *is* the `node …/tsc` process with no descendants,
i.e. `bunx` replaces its own image. SIGTERM to `vite.child` therefore reaches Vite
directly.

**Item 5 — Fast Refresh lint.** `lint:fast-refresh` = `eslint "renderer/src/**/*.tsx"`
(`package.json:13`), config at `app/eslint.config.js` with
`react-refresh/only-export-components` at `error` and `allowConstantExport: false` (so
exported constants are flagged too). It is wired into **four** scripts, covering all three
the docs claim plus one more: `dev` (line 9), `renderer:dev` (11), `renderer:build` (12),
and `typecheck` (14). It does catch the important case — I read the installed rule's logic
(`app/node_modules/eslint-plugin-react-refresh/index.js:240-254`): with a component export
present, every non-component export and every React context export is reported. Its one
blind spot is a `.tsx` exporting *only* helpers with no component at all, which the rule
skips — and that hole is closed by `app/renderer/src/fastRefreshBoundaries.test.ts`, which
imports every non-test `.tsx` and asserts `isLikelyComponentType` on each runtime export.
The two together are sound; the recursion gap in the runtime half is filed as LOW above.
Two smaller notes: `*.test.tsx` files are inside the eslint glob (they are excluded only
from the runtime test), so a test file that exports a shared helper would fail
`lint:fast-refresh` for no real reason; and `linterOptions.reportUnusedDisableDirectives:
false` means a stale `// eslint-disable-next-line react-refresh/only-export-components`
would never be flagged. Neither fires today — I grepped, and there is not a single
`only-export-components` disable comment anywhere under `app/`.

## What is good here

- **`devLauncher.ts` is the model to copy.** Every branching decision (`resolveLauncherExitCode`,
  `waitForRendererReady`, `terminateChild`, `describeReadinessFailure`) is pure with an
  injected clock/probe/kill, so `dev.ts` is wiring with no logic to get wrong, and
  `devLauncher.test.ts` can exercise the escalation and the stale-server case with no
  processes. The child-exit-before-probe ordering with the comment explaining `strictPort`
  is exactly the kind of constraint a comment should carry.
- **`prepare-dev-electron.test.ts` turns a war story into an executable invariant.** It
  asserts against the constants the script actually consumes plus the source shape of the
  two mutations that would bypass them, and it deliberately never executes
  `prepareDevElectron()` (which would re-sign a bundle the operator's live dev app may be
  running from). Paired with the runtime warning at `main.ts:850`, the 2026-07-28 failure
  has two independent detectors.
- **`hardening-smoke.ts` refuses to compile a test branch into production.** It is an
  external `--require` preload that overrides `app.isPackaged` from outside and then
  observes the real main's own BrowserWindow, CSP, navigation and window-open handlers.
  No smoke-only fixture exists in shipped code — a discipline worth holding as the harness
  grows.
- **`ram-fleet.ts`'s kill discipline.** Kills through the Bun handle rather than the pid,
  gathers descendants while the parent is still alive, writes a pid file, and installs
  SIGINT/SIGTERM/SIGHUP emergency cleanup. In a repo where pattern-killing has been a
  repeated incident, this is the right shape.
- **`f2-attach-smoke.ts` imports the production `AttachmentGate` rather than copying it**
  (line 33, with the comment saying why), so a regression in the gate fails the harness.
  Where it *does* mirror production logic it says so and cites the file
  (`supervisorEventToServerFrame`, lines 96-102).

## Not reviewed / uncertain

- I did not run `test:hardening`, `harness-demo`, `run-f2-attach-smoke`, or any `ram-*`
  script (contract: do not run the app). The orphaned-sidecar HIGH is established from
  Electron's documented `app.exit` semantics, `main.ts`'s teardown wiring at lines
  1903/1927, and the recorded occurrence in STATUS CC-3 — not from a live run. Running
  `bun run --cwd app test:hardening` and then checking for a surviving `app/sidecar/index.ts`
  process would confirm it in about a minute, but that run would itself create the orphan.
- The `dev.ts` SIGTERM window is reasoned from signal semantics (single-pid SIGTERM does
  not reach a non-detached child; the handlers are registered at lines 185-190, after the
  await at line 104). I did not reproduce it, because doing so means starting a dev server.
- Windows/Linux behaviour of the dev launcher is unexamined. `prepareDevElectron()` returns
  null off darwin and `dev.ts` falls back to `node_modules/.bin/electron`; whether the
  `bunx` in-place-exec result I measured on macOS holds on other platforms is unverified,
  and if it does not, the Vite teardown would need a process-group kill there.
- `app/renderer/vite.config.ts` was in scope but I only relied on the `strictPort: true`
  claim that `devLauncher.ts:65-69` makes about it; I did not read the config itself, so
  the rest of its content is unreviewed.
- I did not evaluate whether enabling `react-hooks` rules would produce a manageable
  number of violations. That determines whether the MED fix is a one-line change or its own
  session.
