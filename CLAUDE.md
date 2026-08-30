# CLAUDE.md

Cat Code is a private fork of Claude Code being turned into a personal always-on
agent system. This file is the operating manual for any agent working here.
Every rule is checkable. If a rule conflicts with what you find in source,
source wins — finish the task by the source, then flag the drift in your report.

**Expect company.** More than one agent session usually works this repo at the
same time, sharing one working tree and one set of branches. Files you didn't
touch change, the branch tip moves between your own commands, and multi-writer
docs gain rows while you read them. Default assumption for anything you don't
recognize: it is another session's live work, not yours to clean up (§4).

## Workspace context — one user, zero others

This fork has exactly one human user, on one machine, and will never have
another. That single fact drives rules in several sections below, so it is
stated here once instead of only inside §4 Git.

**What it licenses.** No backwards compatibility, no deprecation windows, no
shims for "existing users", no staged rollout, no stable public API. No PRs,
no review gates, no branch ceremony (§4). A change that is only defensive
toward users who do not exist is waste: cut it, and say in your report that
you cut it.

**What it does NOT license.** The one user's live state is production. Saved
sessions in `~/.cat-code/`, the Codex account vault, settings, and a running
desktop app hold real work that cannot be regenerated. Config/schema
migrations (§6) apply in full, and the destructive-operation gates (§4, §10)
stand.

**What it does not change.** One user is not one session: several agent
sessions share this tree at the same time (Expect company, above). Nothing
here relaxes concurrency discipline.

## 1. Repo layout — know which world you are in

Two runtimes share this repo. **Which directory you touch decides which
build/test/typecheck battery applies (§3). Never mix them.**

| Area | What it is |
|---|---|
| `src/`, `scripts/` | The terminal agent engine (the Claude Code fork): CLI, REPL, tools, query pipeline, providers, Codex core, Agent Mode. Root package. |
| `app/` | The Electron desktop app (active migration program). Own package `@cat-code/desktop` with own scripts. Sub-folders are trust boundaries: `renderer/` `preload/` `main/` `supervisor/` (Electron-free) `host/` (Electron-free host plane: durable registry + typed control-plane API) `sidecar/` (runs the real engine) `shared/` (wire protocol). |
| `renderer-theme/`, `scripts/typecheck/renderer-engine-types/` | Temporary migration harnesses. Do not extend. |
| `docs/` | Plans, maps, reports. Dated filenames (`2026-05-12-…`) are historical records, NOT current truth. Two exceptions are kept current: `docs/maps/` (undated, each map stamped with its own `Last refreshed`) and `docs/migration/STATUS.md`. |

Everything else at the repo root is untracked or ignored: build output (`dist/`,
`app/dist-app/`, `ds-bundle/`), scratch (`scratchpad/`, `tmp/`), and whatever a
concurrent session left behind. Untracked does not mean stray — see the
expect-company note above and §4.

## 2. Navigation — read before you search

- **Execution boundary:** `cat-code exec` is reserved exclusively for exercising
  the Claude harness. Never use it to invoke, test, or stand in for Codex or
  Cat Code; use each system's native execution path instead.
- **Repository routing for implementation and diagnosis:** when ownership is not
  established and the task requires broad repository navigation, open
  `docs/maps/WORKSPACE_MAP.md` before the first broad search, choose only one of
  the 17 focused maps it indexes, then verify the route in source. If exact
  owner files or a focused map were supplied, start there and skip the workspace
  router. Maps route; source is authoritative.
- Prompt/instruction/output-style work → `docs/prompts/2026-04-30-prompt-surfaces.md` first.
- Desktop-app / migration work → `docs/migration/STATUS.md` (single source of
  truth for program state) + `.claude/rules/migration.md` (orchestrator rules).
  Executing a dispatched migration session: the **Standing rules** section of the
  current phase's `docs/migration/backlog/phaseN.md` is the authoritative worker
  rulebook — read it before code.
- The UX spec for desktop surfaces is the prototype at
  `~/catcode_prototype/cat-app/` (30 `.jsx` surfaces, ~15.5k lines). It is a
  design reference ONLY: port zero code from it, no inline `style={{}}`; its
  `// SOURCE:` anchors are routing hints (~83% exact), re-verify each in `src/`.
- Docs index: `docs/2026-04-30-docs-readme.md`. Canonical-vs-historical is
  stated per folder there.
- `README.md`, `CLAUDE.md`, `AGENTS.md` stay the only root entrypoints (`DONE.md`
  is a ledger, not an entrypoint — §4). New
  plans/reports go under `docs/<topic>/YYYY-MM-DD-slug.md`. Maps are the one
  exception: no dates in map filenames.

## 3. Build, test, typecheck — the battery per area

Run the battery for **every area whose files you changed**. Paste the commands
and their outcomes in your final report; "should pass" is not a result.

A red result is not automatically yours. Before debugging a failure, check
`git status` / `git diff` on the failing file: if it's dirty and you didn't
edit it, another session is mid-change there — report the failure as
not-yours-and-unfixed rather than "fixing" code you don't own. The same goes
for baseline counts below; they shift under concurrent work, so re-measure
instead of assuming.

### Engine (`src/`, `scripts/`)

When writing or changing Cat Code tests, use the repository `writing-cat-code-tests` skill.

```bash
bun run build:dev:full        # THE build gate: maps:lint + branch-diff lint + ./cli-dev + version print
bun test <specific paths>     # focused tests only — there is NO root test script
```

- Never `bun run build` or `./cli` unless explicitly asked.
- Never bare `bun test` on the whole repo; some suites (Codex account suites)
  only pass file-isolated.
- Test routing per subsystem: `docs/maps/build-release-testing.md` §Test Routing.
- **Root `bun run typecheck` is KNOWN-RED** (1,974 pre-existing errors across
  `src/` as of 2026-08-19; tsconfig is `strict:false` and test files dominate).
  It is NOT a gate and not your job to fix. The engine gate is
  `build:dev:full` + focused tests. If you must reason about types in `src/`,
  compare error output before/after your change — zero NEW errors is the bar.

### Desktop (`app/`) — root commands do NOT cover this package

```bash
bun test app/                          # from repo root
bun run --cwd app typecheck            # isolated shell graph (strict)
bun run --cwd app typecheck:sidecar    # wrapper script — see known-red note
bun run --cwd app test:hardening       # security-baseline smoke; ALL checks must pass
bun run --cwd app renderer:build       # when renderer build inputs changed
```

**Running the app** — `cd /Users/pt/cat-code && bun run --cwd app dev` builds
main+preload, starts Vite on `:5173`, then launches Electron against it; Ctrl-C
tears down all three (`app/scripts/dev.ts`). Facts that follow from that:

- Dev loads the renderer from the **Vite server**, not `app/renderer/dist`
  (`app/main/main.ts` `loadURL(CATCODE_RENDERER_URL ?? localhost:5173)`; `dist`
  is only the packaged branch). So `renderer:build` is a build gate, NOT what
  makes your renderer change visible — a running dev app already serves current
  source. Conversely, a dev app left open across your edits is showing HMR
  state, so send the operator to a fresh launch before they judge a layout or
  effect change.
- **The renderer hot-reloads; main and preload do NOT.** `dev.ts:88` builds both
  once with a `spawnSync` before Vite starts, and nothing watches them
  (`grep -cE 'watch|chokidar' app/scripts/dev.ts` is 0). So a dev app left
  running across a change under `app/main/**` or `app/preload/**` serves a
  CURRENT renderer against a STALE main, and the two disagree silently: no
  error, no warning, no log line. Symptom shape: the page reflects your change
  and the window does not. Cost a full round trip on 2026-08-27, when a
  light-appearance renderer hot-reloaded while the main process that sets
  `nativeTheme.themeSource` was still the one built at launch — so the page went
  light, the macOS vibrancy material and the title bar stayed dark, and the
  operator reported the feature as broken when it was not. Before asking the
  operator to judge ANYTHING main owns — window chrome, vibrancy, title bar,
  `nativeTheme`, menus, IPC handlers — send them to a full Ctrl-C and relaunch,
  not a reload.
- **That whole paragraph is conditional on `IS_DEV = !app.isPackaged`, and
  `app.isPackaged` is derived from the EXECUTABLE'S NAME.** Electron reports
  packaged for any executable not named `electron`, so renaming the dev binary
  silently flips the app to the packaged branch: it loads a stale `dist`, HMR
  never applies, `import.meta.env.DEV` is false (killing every dev-gated
  surface), and Vite runs unused. `prepare-dev-electron.ts` rebrands via the
  Info.plist display keys ONLY, and keeps the executable named `electron`, for
  exactly this reason — do not "tidy" that. Symptom when it breaks: renderer
  edits do not appear no matter how many times you relaunch. Checks: the app
  name is `Cat Code Dev` (`app.setName` runs only under `IS_DEV`) in the menu bar
  and in AX discovery — NOT on screen, since 2026-08-28 the window has no title
  bar to print it in (`titleBarStyle: 'hiddenInset'`, CC-77) — and main logs a
  loud warning when `CATCODE_RENDERER_URL` is set but the packaged branch wins. Cost the first time this happened, undiagnosed: hours (2026-07-28).
- **The sidecar is a third plane, and it reads the tree at every spawn.** In dev
  `resolveSidecarLaunch` (`app/main/mainDecisions.ts:135`) resolves to
  `bun run app/sidecar/<entry>.ts` — repository TypeScript, read off disk when
  the process starts — and `app/sidecar` + `app/shared` import from `src/` in 216
  places (`grep -rn '\.\./\.\./src/' app/sidecar/*.ts app/shared/*.ts | grep -v
  test | wc -l`). So a `src/**` or `app/sidecar/**` edit reaches every NEW session
  an open app starts, plus the catalog, transcript-backfill, accounts-pool and
  debug-cleanup workers; sessions already running keep the code they loaded.
  Symptom shape: a session started mid-edit dies on a module graph nobody wrote,
  and the stack trace reads like a real bug. So while editing `src/**` or
  `app/sidecar/**`, do not start new sessions in an open dev app. A packaged build
  has no such coupling: its sidecar is one compiled binary under
  `Resources/sidecar/` (`resolveSidecarLaunch` packaged branch).
- Launching it is a **GUI action on the operator's machine** (§8): give them the
  command, don't run it yourself without authorization for that run. It steals
  focus and it is often already open with their live work.
- `lsof -ti:5173` and `pgrep -lf "Cat Code Dev"` tell you whether it is up. If
  something you spawned hangs, report the PID you recorded — never sweep for it
  with a `ps` pattern match; other sessions and the operator's own app share
  this machine. **This is now ENFORCED, not just documented:** a `PreToolUse`
  hook (`.claude/hooks/block-sweep-kill.sh`, registered in
  `.claude/settings.local.json`) denies `pkill`/`killall`, `… | xargs kill`, and
  `kill $(pgrep …)`-style discovery-paired kills. `kill <pid>` and
  `kill $(cat x.pid)` still work, so nothing you legitimately own is out of
  reach. Searching is untouched — `ps aux | grep …`, `lsof`, `pgrep` all still
  run. The hook is machine-local (`.claude/` is git-excluded), so a fresh clone
  has the rule but not the enforcement. Added 2026-07-30 after three agents
  broke this rule in one day, one of them immediately after being corrected.

- Known-red baseline: raw `tsc -p app/sidecar/tsconfig.json` fails with ~5.5k
  pre-existing upstream-engine diagnostics (the include-override drops root
  `env.d.ts`). The wrapper (`app/scripts/sidecar-typecheck.ts`) ignores those
  and fails only on diagnostics in owned `app/sidecar`/`app/shared` files.
  **Zero new errors in owned files** is the pass bar — do not fix upstream noise.
- Fast Refresh boundary: production `app/renderer/src/**/*.tsx` modules export
  React components only at runtime. Move helpers, reducers, constants, contexts,
  and hooks into adjacent `.ts` files; type-only exports are fine. The desktop
  dev, typecheck, and renderer-build scripts enforce this with
  `lint:fast-refresh`, backed by `fastRefreshBoundaries.test.ts`.
- Live baseline as of 2026-08-19 (re-measure, don't assume): `bun test app/`
  3,675 pass / 1 fail across 234 files · app tsc clean · sidecar wrapper green
  (5,577 upstream ignored) · hardening 19/19. The counts grow; a DROP in pass
  count or any new owned diagnostic is a regression. The 1 fail is
  `app/sidecar/subagentRestore.probe.test.ts`: live-sidecar probes need
  `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` and fail without one, so
  read the `[sidecar] … env var is required` line before calling it yours.
- Root `bun run lint` does not cover `app/**` (Phase-5 CI item). Do not cite a
  clean root lint as evidence for an `app/` change.
- **Private desktop diagnostics:** Electron main owns bounded, local operational
  and delivery-trace JSONL under the desktop config directory. They are support
  evidence, not model context: never feed raw logs, transcripts, settings, or
  debug output into a prompt. Users export only the allowlisted, redacted bundle
  through **Save diagnostics bundle**; preserve the closed schemas and retention
  caps in `app/shared/operationalLog.ts`, `app/main/deliveryTraceSink.ts`, and
  `app/main/diagnosticsBundle.ts` when changing this path.

### Docs-only changes

```bash
git diff --check
bun run maps:lint             # validates map index, dates, links, and cited paths
```

Lint caveat (all areas): `bun run lint` only lints files changed vs
`main...HEAD`, and the config enables **zero rules** (all 19
custom rules are `createNoopRule()` stubs; the only two entries turn rules
off) — a lint pass is a parse check. Never cite "lint clean" as meaningful
evidence; tests and typechecks are the evidence.

## 4. Git — one human, many concurrent sessions

One human owns this repo, so there are no PRs or review gates; but several agent
sessions commit to the same branch live (on `migration` especially:
`worktree-agent-*` merges plus direct commits). Every git rule below exists
because the tree is shared.

- **Stage explicit paths only** — `git add <path> <path>`. Never `git add -A`,
  `git add -u`, or `git commit -a`: the diff you're staging contains other
  sessions' uncommitted edits.
- **Never destroy what you didn't write.** No `git checkout -- .`, `git clean`,
  `git stash`, or reverting a file you didn't edit. Uncommitted changes and
  untracked files that aren't yours are someone's in-flight work, and a stash is
  indistinguishable from deletion to the session that was mid-edit.
- **No relative refs, no history rewrites.** Never `HEAD~1`/`HEAD^` for
  reset/rebase — use an explicit SHA and re-check `git rev-parse HEAD`
  immediately before the op, because the tip may have moved since you read it.
  Once anything may sit on top of your commit, don't reset/rebase/amend at all;
  splitting or reordering a commit here is never worth force-rebasing another
  session's work. (2026-07-12: a `git reset HEAD~1` intended to undo my own
  commit undid another session's instead, seconds after they committed.)
- **Don't push to publish just your work** — your commit sits atop theirs, so
  pushing publishes theirs too. Let the owning session push, or make an isolated
  branch off `origin/<branch>`.
- **Re-read multi-writer files immediately before writing** —
  `docs/migration/STATUS.md`, `DONE.md`: the copy you read earlier in the
  session is probably stale. Edit only your own row/entry (§6).
- Commit directly to the **current** branch (including `main`). No branches,
  worktrees, or PRs unless explicitly asked; delete them after merge.

**Worktree format and location** — when you are asked for one, these are the
only correct answers. Both roots are gitignored (`.gitignore:7` and local
`.git/info/exclude`), so a worktree in the wrong place never shows up in
`git status` — nothing will catch the mistake for you.

| Created by | Directory | Branch |
|---|---|---|
| **You**, on request | `.worktrees/<slug>` | `worktree-<slug>` |
| **The harness** (`isolation: "worktree"`) | `.claude/worktrees/agent-<hex>` | `worktree-agent-<hex>` |

- Never invent a name or location: past sessions left `context-cost-fixes-20260706`
  and `account-system-20260706` in ad-hoc spots because this table didn't exist.
- `.claude/worktrees/` belongs to the harness. Don't hand-roll one there. Don't
  tidy what's in it **except a provably-spent one** (see the safe-sweep bullet
  below) — otherwise a live session may be in it.
- `git worktree list` is the truth, not the directory listing. **Reap at the
  source: the session that merges a worktree/agent branch into `migration`/`main`
  removes that worktree + branch as its LAST step** (`git worktree remove <path>`
  **and** `git branch -d <branch>`; a bare `rm -rf` leaves a stale admin entry
  needing `git worktree prune`). They pile up otherwise (2026-07-22: 34 spent
  worktrees, ~7 GB).
- **Safe to remove a spent worktree + branch (incl. a `.claude/worktrees/agent-*`)
  iff ALL hold — verify per worktree, leave it if unsure:** `migration..HEAD`
  commit count = 0 (fully merged, nothing unmerged to lose), working tree clean
  except an untracked `node_modules`, and NOT locked (locked = live session). The
  guards finish the job: `git worktree remove` refuses a dirty/locked tree and
  `git branch -d` (never `-D`) refuses an unmerged branch, so a misjudgment can't
  destroy work. `remove` also refuses an untracked `node_modules`; `--force` is OK
  **only** after confirming `node_modules` is the *sole* untracked entry.
- Exception: desktop-migration (`app/` + `docs/migration/`) work lives on the
  `migration` branch, never `main` (PROGRAM-PLAN rule).
- **Commit your own explicit paths to the current branch freely — no need to ask;
  commit early and often.** Uncommitted work on this shared tree is the fragile
  state (the 2026-07-21 bug-sweep nearly lost 4 finished fixes by staying
  uncommitted). **Push** only when asked — it publishes other sessions' commits
  stacked under yours. Never `--no-verify`. Never `git stash` as a checkpoint — if
  work matters, commit it.
- Message format: `type(scope): subject` — types `feat|fix|perf|refactor|docs|wip|merge|migration`,
  scopes seen: `app`, `codex`, `migration`, `DONE`. Multi-part commits get a
  short one-line-per-change body.
- `DONE.md`: ask the user before writing to it. One entry per finished task,
  added to the latest phase.

## 5. Architecture essentials

### Terminal engine flow

`src/entrypoints/cli.tsx` → `src/main.tsx` → `src/screens/REPL.tsx` (UI/session
loop) → `src/QueryEngine.ts` / `src/query.ts` → `src/services/api/` → provider.
Tools: `src/tools.ts` + `src/tools/<Name>Tool/`. Commands: `src/commands.ts` +
`src/commands/`. Agent/subagents: `src/agent-mode/`, `src/tools/AgentTool/`,
`src/tasks/`. Config/persistence: `src/utils/settings/`, `src/utils/config.ts`,
`src/utils/sessionStorage.ts`, `src/memdir/`. User state: `~/.cat-code/`.

### Feature gates

Runtime code checks `feature('NAME')` imported from `bun:bundle`; which names
are compiled in is decided at build time by `scripts/build.ts` (`dev-full`
bundle list). A feature is live only when BOTH sides exist: the name in the
build list AND `feature(...)` call sites consuming it.

### Provider routing

Session provider precedence: explicit session selection > `CLAUDE_CODE_USE_*`
env vars > saved startup preference > Anthropic. Per-request, the **model
string wins**: `gpt-*` models always route to the Codex/OpenAI path
(`src/utils/model/providers.ts` `resolveRequestProvider`), regardless of the
session provider — there is no stored per-request provider field. Codex internals:
`src/codex-core/`, `src/services/api/codex-*`. Any Codex account/token/refresh
change must respect the cross-process locking + attempt-ledger machinery in
`src/codex-core/accounts.ts` — multiple engine processes share these files.

### Desktop flow (one frame pipeline, two planes)

renderer → default-deny preload → Electron main → Electron-free supervisor →
Unix-domain socket → Bun sidecar (real engine `AppSessionController`) → raw
`AppSessionEvent` frames back. Wire contract: `app/shared/protocol.ts` (frames)
+ `app/shared/hostApi.ts` (host control plane — separate plane, error unions
must never merge). Renderer projects raw events via
`app/renderer/src/transcriptProjector.ts` (reducer + read-time selectors;
status is derived at read time, stored rows are never mutated).

### Locked decisions — do not reopen, do not "improve"

Unix-domain-socket transport · N-process (one engine process per session) ·
raw `AppSessionEvent` over the wire (no lossy mapper) · die-with-window v1
lifetime · two-id model (`appSessionId` address ↔ `engineSessionId` transcript
key). Full records: `docs/migration/decisions/`.

### Desktop security baseline — hard gate on every `app/` change

Defined in `docs/migration/decisions/SECURITY-MINIMUM.md` (T4/T5a/T6/T7 +
Addendum T8/HC1–HC4). Concretely:

- Inbound vocabulary is a closed allowlist validated **at the sidecar** (the
  trust boundary), never only at the preload.
- T4 `goalSnapshot` schema-validated · T5a permission responses must match an
  engine-minted request id · T6 renderer `updatedInput` is echo-only · T6b
  renderer-authored `updatedPermissions` stripped — always-allow = suggestion
  **selection** by index, sidecar re-attaches the engine's own objects (T6b is
  a sidecar boundary-test label, `app/sidecar/sidecarServer.ts`; the mechanism
  is `decisions/PERMISSION-BOUNDARY.md` C1) · T7 frame-size/rate/prompt caps.
- Directional limits: `MAX_FRAME_BYTES` (inbound) vs `MAX_OUTBOUND_FRAME_BYTES`
  (outbound) — never swap or unify.
- Secrets live engine-side only; `secretGuard` runs on outbound frames.
- Renderer never authors permission rules, never sees raw credentials.

Verification: `bun run --cwd app test:hardening` green + boundary tests for any
new inbound frame.

## 6. Files needing extra care

| File / dir | Care rule |
|---|---|
| `app/shared/protocol.ts` | Versioned wire contract. Additive changes only; version bump only on breaking shape change. Every new inbound frame kind needs: sidecar-local schema, boundary test, doc-comment citing its decision. |
| `app/shared/engine-types.snapshot.d.ts`, `app/shared/sdk-types.snapshot.d.ts` | Type-only snapshots. Re-sync from the engine source; never hand-edit. |
| `src/entrypoints/sdk/coreTypes.generated.ts` | Generated (`scripts/generate-sdk-types.ts`). Regenerate; never hand-edit. |
| `eslint-suppressions.json` | Do not regenerate or prune to make lint pass. |
| `scripts/build.ts` | Owner of feature sets + build macros. A feature needs BOTH the build-time list here and runtime `feature(...)` call sites. |
| `src/main.tsx` migrations | New migration = file + import + position in `runMigrations()` + `CURRENT_MIGRATION_VERSION` bump. All four or it never runs. |
| `src/codex-core/accounts.ts` | Cross-process token rotation with lockfiles + durable ledger. Never simplify away "redundant-looking" locking. |
| `docs/migration/STATUS.md` | Program truth. Update your session's row (status + date + note) as the last step of migration work; never rewrite other rows. |
| `src/vendor/` | Vendored; don't refactor. |
| `~/catcode_prototype/cat-app/` | Read-only UX reference. Never edit, never port code, never treat its mock data or invented shapes as the contract. |
| `install.sh` | Known stale (`free-code` naming). Don't use or cite it. |

## 7. Coding conventions (checkable)

### User-visible text (operator rules, 2026-07-27)

Anything a user can read on screen: JSX text, `desc`/`title`/`placeholder`,
`aria-label`, toasts, disabled-reasons, empty states, console warnings.

- **No em dash (—) in any of it. Ever.** Rewrite the sentence: split it in two,
  or use a comma or colon. This includes the `'—'` no-value placeholder (write
  `none`) and ` — ` as an aria-label separator (write `, `). Check with
  `rg -n '—' app/renderer/src --glob '!*.test.*'` and confirm every remaining
  hit is a code comment or a dev-only fixture name in `sdkMessageFixtures.ts`
  (the one standing exclusion). That sweep returns well over a thousand lines,
  nearly all of them comments, so read it as a diff against a clean run, not as
  a hit list. Code comments and `docs/` are NOT a text surface and are
  unaffected. Nothing enforces this half of §7 automatically: the sweep is the
  only check.
- **Never render engineering notes.** No `file.ts:123` citations, no session
  ids (`P4-6b`, `CC-19`), no internal vocabulary (read seam, write allowlist,
  sidecar review, registry row, host-API gap, `MAX_*` constant names). A
  deviation belongs in your report and the STATUS row, which is what §9 asks
  for; a component that exists to print your to-do list on the page is the bug
  (`DeferredNote`, deleted 2026-07-27 after the operator rejected the page).
  **This half IS enforced:** `app/renderer/src/userVisibleText.test.ts` sweeps
  every prose-shaped string across renderer, main, host, and sidecar. A genuine
  exception needs `§7-ok` in a comment on the same line, never a widened word
  list.
- **Say only what is surprising.** Restating the state the user just chose is
  noise; spend prose on what contradicts it. See `settingsRowNote`
  (`app/renderer/src/settingsScope.ts`), which returns null for the ordinary
  case.
- Tell the user what to DO ("Change it from the CLI"), not why we have not
  built it ("needs a recorded permission-boundary review").

- **TypeScript everywhere; scripts are plain Bun TS.** Root tsconfig is
  `strict: false` — do NOT enable strict flags or drive-by-fix unrelated type
  errors in `src/`. `app/` IS strict — keep it that way.
- Files: `camelCase.ts` for modules, `PascalCase.tsx` for React components,
  `<module>.test.ts(x)` colocated next to the module, `*.probe.test.ts` for
  multi-process probes.
- Renderer state modules follow `create<X>State` / `reduce<X>State` /
  `select<X>` (see `app/renderer/src/agentConfigState.ts`); sidecar domain
  modules follow `createSidecar<X>Domain` returning a narrow interface.
- Error handling asymmetry (desktop): **inbound = fail closed** (invalid frame
  rejected at the sidecar), **display = degrade gracefully** (unknown variant
  renders a tolerant fallback row, never throws). Runtime-narrow unknown
  shapes; zero `as` casts in projector-style code.
- Closed unions get compile-time exhaustiveness tripwires (`default` case
  assigning to `never`). When you extend `SDKMessage` handling, extend BOTH the
  projector switch and `app/renderer/src/sdkMessageFixtures.ts` — tsc enforces
  both sides; verify by deliberately removing a case and seeing the error.
- Tests use `bun:test` (`describe/test/expect/afterEach`). Prefer a module's
  exported `_forTest` reset helpers over process-global workarounds.
- Comments state constraints code can't show (see `protocol.ts` doc comments
  citing decisions). No narration comments, no comments on untouched code.
- No new dependencies without asking. Python tooling: `uv` only. Search: `rg`.
- Prefer editing existing files; no speculative features, configurability, or
  refactors beyond the request.

## 8. Mistakes that have actually happened here — and their rules

1. **Wiring a seam with stub context instead of the engine's real context.**
   (Three so far — P1-3: sidecar session had `tools: []`; P2-4:
   `getEmptyToolPermissionContext`; P3-7: `commands: []`.)
   Rule: when the sidecar builds anything the engine also builds, construct it
   from the SAME source the engine runtime uses, and cite that `src/…:line` in
   your report. Verify: a live-path test proves real data flows, not shape-only.
2. **Trusting a dated doc over source.** Rule: docs under `docs/` with dated
   names are historical; before acting on one, verify its claims against
   current source. Verify: report cites `file:line`, not doc sections.
3. **Declaring done from a partial battery.** Rule: run §3's battery for every
   touched area; paste outcomes. Also run an exhaustive stale-reference search
   (imports, docs, configs, tests) before claiming completion.
4. **"Fixing" known-red baselines.** (Sidecar tsc ~5.5k upstream diagnostics.)
   Rule: only NEW diagnostics in owned files count; never refactor engine code
   to silence the overlay.
5. **Widening the desktop inbound surface.** Rule: no new preload channel or
   inbound frame kind without sidecar validation + boundary test + decision
   reference. Verify: hardening smoke green, boundary tests exist.
6. **Reopening locked decisions** (§5). Rule: if your fix seems to require
   changing transport/process-model/event fidelity, STOP and report instead.
7. **Unwired migrations / features.** Rule: features need build-list + runtime
   call sites; migrations need all four wiring steps (§6). Verify: grep for the
   flag/import actually being consumed.
8. **Driving the GUI without authorization.** (2026-07-07: repeated cursor
   warps while the operator was live forced a machine restart.) Rule: a
   dispatched 🖐 GUI prompt defaults to STOP — print exact operator steps per
   `docs/migration/process/GUI-VERIFICATION.md`. Explicit operator
   authorization for THAT run (the P3-8 precedent) overrides the default and
   permits agent-driving (cua-driver against "Cat Code Dev"); authorization is
   per-run, never standing, and every claim must cite a live AX label.
   Hover/focus-only surfaces are operator-driven ALWAYS — never warp the
   cursor; mark them UNVERIFIED, or close them by source inspection when the
   logic is trivial (GUI-VERIFICATION.md).
9. **Silent parity cuts** (desktop surfaces). Rule: default is prototype
   parity; any deviation is a tagged flag (adapted/deferred/cut + reason) in
   your report and STATUS row, never a silent drop.
10. **Duplicating engine machinery in `app/`.** Rule: before writing new logic
    in the sidecar/renderer, search `src/app-runtime/` and the relevant map for
    the existing implementation; reuse via the real entry point (e.g. resume
    goes through the engine's actual resume machinery).

## 9. Quality bars

**Engine bug fix** — root cause stated with `file:line`; a test exists that
fails before the fix and passes after; focused suites for the touched subsystem
pass; `bun run build:dev:full` green; no public interface change unless the
task required it; stale-reference sweep done.

**Engine feature** — feature-gate wiring complete (both sides); tests cover
success, failure, and boundary; `checking-cat-code-change-impact` skill
checklist answered; docs/maps updated only where the change made them wrong.

**Desktop (`app/`) change** — full app battery green (§3); security baseline
intact (hardening all-pass); both exhaustiveness tripwires still fire if the
union was touched; STATUS row updated; parity deviations flagged; GUI-dependent
acceptance explicitly listed as operator steps, not claimed done. Migration
test turns use `gpt-5.6-luna` at low effort on a healthy account
(GUI-VERIFICATION.md §Model) — never burn frontier quota on dev-loop turns.

**Protocol change** — additive, or version bumped with the breaking reason in
the `protocol.ts` header; new frames validated at the sidecar with tests both
accepting valid and rejecting invalid frames.

**Docs update** — `git diff --check` clean; every cited path exists; dated
filename in the right topic folder; canonical files (STATUS, maps, README,
CLAUDE.md) updated in place instead of forked.

**Config/build change** — `scripts/build.ts` treated as source of truth;
resulting `./cli-dev --version` prints; a before/after of the effective feature
set or setting stated in the report.

## 10. Uncertainty and escalation

- If you don't know which files own a behavior → open the routing map (§2)
  BEFORE broad grep.
- If a doc and source disagree → follow source, note the drift.
- If a needed shape/API exists somewhere in `src/` → find and cite it before
  writing a new one; if you can't find it within the mapped owner files, say so
  explicitly rather than inventing.
- STOP and ask the user before: pushing (publishes other sessions' commits too)
  or any history rewrite (`reset`/`rebase`/`amend`/force); writing `DONE.md`; touching locked
  decisions; changing the security baseline; deleting/overwriting anything you
  didn't create; any action on live accounts/credentials (real logins, token
  refresh against real vaults, burning usage); GUI interaction on the user's
  machine.
- Never guess: model/provider routing behavior, feature-gate state, permission
  semantics, or migration program state — all have named sources of truth (§2,
  §5, §6).
- Unresolved uncertainty you are NOT blocked on goes in the final report as
  its own section: what is unknown, what you checked, what would resolve it.
- A question you need answered is not an uncertainty note. It goes last in
  the message, alone on its line, after the bookkeeping (§11.6) — never
  inside a report section, where it gets scrolled past.

## 11. Required workflow

1. **Understand** — restate the task; classify which area(s) it touches (§1).
2. **Inspect** — routing map → owner files → read the actual source; for
   migration work, STATUS row + backlog prompt + relevant decision docs.
3. **Plan** — for non-trivial changes list the files you will touch and the
   battery you will run; surface parity/security/locked-decision implications
   now, not after.
4. **Implement** — smallest change that satisfies the task; match surrounding
   style; extend colocated tests.
5. **Verify** — run the §3 battery per touched area + the specific quality bar
   (§9). Evidence = actual command + actual outcome.
6. **Report** — outcome first; commands run with results; parity/§0 flags;
   uncertainties; then bookkeeping (STATUS row for migration work).
   Anything you need the user to answer comes after all of that, last and
   alone (§10).

Claiming completion requires: battery output pasted, quality-bar checklist
satisfied, stale-reference sweep done, and zero unreported deviations.
