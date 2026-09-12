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

In the desktop app the other sessions may be peers: `ListPeers` names the
desktop sessions in this workspace, and `ReadPeer` reads ONE of them, so a path
as the query shows whether that peer's recent turns mention it or attempted a
tool call on it (attempted, not proven to have run, and only within the window
the read covers). One peer per call, so sweeping a roster costs a call each and
returns up to 32 KB a time: do it when you have reason to think the work
overlaps, not before every edit. Before you edit something another peer is
working on, message that peer; that is the third reason `SendToPeer`'s own
prompt gives for writing to one. Terminal Cat Code sessions and Claude Code
sessions share this tree too and never appear in that list, so an empty roster
does not mean you are alone, and the default assumption above still stands.

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
| `src/`, `scripts/` | The terminal agent engine (the Claude Code fork): CLI, REPL, tools, query pipeline, providers, and Codex core. Root package. |
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
  the focused maps it indexes, then verify the route in source. If exact
  owner files or a focused map were supplied, start there and skip the workspace
  router. Maps route; source is authoritative.
- Prompt/instruction/output-style work → `docs/prompts/2026-04-30-prompt-surfaces.md` first.
- Desktop-app GUI verification: see `docs/migration/process/GUI-VERIFICATION.md`.
- Desktop-app / migration work → `docs/migration/STATUS.md` (single source of
  truth for program state) + `.claude/rules/migration.md` (orchestrator rules).
  Executing a dispatched migration session: the **Standing rules** section of the
  current phase's `docs/migration/backlog/phaseN.md` is the authoritative worker
  rulebook — read it before code.
- Peer sessions (names, `ListPeers` / `SendToPeer` / `ReadPeer` / `CreatePeer`,
  the doctrine block) → `docs/migration/decisions/PEER-SESSIONS.md` first,
  reading the 🔁 amendment markers because several rulings were reversed after
  the build and the reversal holds; then
  `docs/migration/decisions/HOST-REQUEST-PLANE.md`. Owner files: the peer row of
  `docs/maps/web-app-runtime.md`.
- The UX spec for desktop surfaces is the prototype at
  `~/catcode_prototype/cat-app/`. It is a design reference ONLY: port zero code
  from it, no inline `style={{}}`; its
  `// SOURCE:` anchors are routing hints; re-verify each in `src/`.
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
not-yours-and-unfixed rather than "fixing" code you don't own. Re-measure
baselines rather than relying on historical counts.

### Engine (`src/`, `scripts/`)

For regression coverage, test the production behavior at the lowest layer that can expose the failure. Cross process or UI boundaries when that boundary is the risk.

```bash
bun run build:dev:full        # THE build gate: maps:lint + undefined-name lint + branch-diff lint + ./cli-dev + version print
bun test <specific paths>     # focused tests only — there is NO root test script
```

- Never `bun run build` or `./cli` unless explicitly asked.
- Never bare `bun test` on the whole repo; some suites (Codex account suites)
  only pass file-isolated.
- Test routing per subsystem: `docs/maps/build-release-testing.md` §Test Routing.
- Root `bun run typecheck` has pre-existing engine errors and is not a gate.
  The engine gate is `build:dev:full` plus focused tests. If types matter,
  compare before/after diagnostics: zero NEW errors is the bar.
- Undefined names are a separate zero-error gate: `bun run lint:undefined-names`
  (included in `build:dev:full`) checks TS2304/TS2503. A successful bundle does
  not prove all referenced names exist at runtime.

### Desktop (`app/`) — root commands do NOT cover this package

```bash
bun test app/                          # from repo root
bun run --cwd app typecheck            # isolated shell graph (strict)
bun run --cwd app typecheck:sidecar    # wrapper script — see known-red note
bun run --cwd app test:hardening       # security-baseline smoke; ALL checks must pass
bun run --cwd app renderer:build       # when renderer build inputs changed
```

**Running the app** — `bun run --cwd app dev` builds main/preload, starts
Vite on port 5173, and launches Electron; Ctrl-C tears them down
(`app/scripts/dev.ts`). Launching is a GUI action requiring authorization
for that run (§8).

- The dev renderer loads from Vite, not `app/renderer/dist`. Renderer HMR and
  `renderer:build` do not update main/preload. Those build once at dev startup;
  fully restart before asking the operator to judge main/preload changes.
  Use a fresh launch for visual acceptance rather than an accumulated HMR state.
- The dev branch depends on `!app.isPackaged`. Keep the executable named
  `electron`; `prepare-dev-electron.ts` rebrands display metadata only.
  Renaming the executable can select packaged assets and bypass Vite/dev flags.
  `Cat Code Dev` is the app/menu/AX name, not a visible window title. Main warns
  when `CATCODE_RENDERER_URL` is set but the packaged branch wins.
- Dev sidecars load repository TypeScript on each spawn
  (`resolveSidecarLaunch` in `app/main/mainDecisions.ts`), including their
  imports from `src/`. Existing sessions retain loaded code; new sessions and
  catalog/backfill/accounts/debug workers see the current tree. While editing
  `src/**` or `app/sidecar/**`, do not start new sessions in an open dev app:
  `CreatePeer` and sending to parked/closed peers also spawn sidecars.
  Packaged sidecars use the compiled binary under `Resources/sidecar/`.
- `lsof -ti:5173` and `pgrep -lf "Cat Code Dev"` can inspect running processes.
  Track and stop only processes you own by recorded PID. No `pkill`, `killall`,
  discovery-paired kills, or sweep kills. The local PreToolUse hook
  `.claude/hooks/block-sweep-kill.sh` in `.claude/settings.local.json` enforces
  this; read-only inspection and recorded-PID kills remain allowed. A fresh
  clone does not include that machine-local enforcement.

- Raw `tsc -p app/sidecar/tsconfig.json` includes pre-existing upstream-engine
  diagnostics (the include-override drops root `env.d.ts`). The wrapper
  (`app/scripts/sidecar-typecheck.ts`) ignores those
  and fails only on diagnostics in owned `app/sidecar`/`app/shared` files.
  **Zero new errors in owned files** is the pass bar — do not fix upstream noise.
- Fast Refresh boundary: production `app/renderer/src/**/*.tsx` modules export
  React components only at runtime. Move helpers, reducers, constants, contexts,
  and hooks into adjacent `.ts` files; type-only exports are fine. The desktop
  dev, typecheck, and renderer-build scripts enforce this with
  `lint:fast-refresh`, backed by `fastRefreshBoundaries.test.ts`.
- Measure current test results; investigate unexplained pass-count drops or
  new owned diagnostics. Live-sidecar probes such as
  `app/sidecar/subagentRestore.probe.test.ts` may require `ANTHROPIC_API_KEY`
  or `CLAUDE_CODE_OAUTH_TOKEN`. Distinguish missing credentials from a code
  regression, and respect the live-account authorization rules (§10).
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

Lint caveat: root `bun run lint` is a branch-diff ESLint check with no-op
custom rules; a pass alone is not meaningful behavior evidence. This does
not describe the separate map, undefined-name, or desktop Fast Refresh checks.

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
  session's work.
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

- Use the names and locations in the table.
- `.claude/worktrees/` belongs to the harness. Don't hand-roll one there. Don't
  tidy what's in it **except a provably-spent one** (see the safe-sweep bullet
  below) — otherwise a live session may be in it.
- `git worktree list` is the truth, not the directory listing. **Reap at the
  source: the session that merges a worktree/agent branch into `migration`/`main`
  removes that worktree + branch as its LAST step** (`git worktree remove <path>`
  **and** `git branch -d <branch>`; a bare `rm -rf` leaves a stale admin entry
  needing `git worktree prune`).
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
  commit early and often.** Commit every coherent completed slice as soon as its
  focused verification passes; do not wait for the whole task, every worker, or
  the full integration battery. Before waiting for another worker or ending a
  turn, commit the finished work you own. A verification failure in an unrelated
  concurrent slice is not a reason to leave your verified slice raw.
- **Be cautious when telling a shared-tree implementation worker not to commit.**
  That transfers checkpoint ownership to the parent and leaves the worker's edits
  fragile until the parent commits them. Use it when the parent genuinely needs
  to integrate or review the slice before commit, then checkpoint accepted work
  promptly; otherwise let the worker commit its explicit owned paths. If a slice
  cannot yet be a normal commit, consider an explicit `wip(scope): ...`
  checkpoint rather than leaving it only in the working tree.
- Push only when asked; it publishes other sessions' commits stacked under
  yours. Never `--no-verify`. Never use `git stash` as a checkpoint.
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
`src/commands/`. Agents and tasks: `src/tools/AgentTool/`, `src/tasks/`,
`src/coordinator/`. Config/persistence: `src/utils/settings/`,
`src/utils/config.ts`, `src/utils/sessionStorage.ts`, `src/memdir/`. User state:
`~/.cat-code/`.

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
must never merge).

Model-authored requests to main (peer create, list, send) travel sidecar →
main as `host.request` frames and return as `host.result`; delivered peer
messages arrive at the sidecar as `peer.deliver`. Both are validated at the
receiving end and rate-bounded in main
(`docs/migration/decisions/HOST-REQUEST-PLANE.md`, HR1 to HR6). Adding a verb
to that plane is a security-baseline change (§10), not a tool change.

Renderer projects raw events via
`app/renderer/src/transcriptProjector.ts` (reducer + read-time selectors;
status is derived at read time, stored rows are never mutated).

**Peer or subagent.** A subagent runs inside your session, returns one result
to you and disappears; the user never sees it and its output is yours to
verify. A peer (desktop app only) is another session of the same user: its
own tab, permission mode and conversation, no duty to you, alive after your
turn ends. Use a subagent when you will consume the result yourself and the
work is bounded. Use a peer when the user should see and steer the work, when
it must outlive your turn, when it needs another model or permission mode, or
when the user says "session". A peer costs a tab and up to a minute to start;
a subagent costs your context.

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
new inbound frame. New preload channels also require sidecar validation,
boundary tests, and a decision reference.

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
  (the one standing exclusion). Compare against a clean run to separate new
  violations from existing matches. Code comments and `docs/` are NOT a text
  surface and are unaffected. Nothing enforces this half of §7 automatically:
  the sweep is the only check.
- **Never render engineering notes.** No `file.ts:123` citations, no session
  ids (`P4-6b`, `CC-19`), no internal vocabulary (read seam, write allowlist,
  sidecar review, registry row, host-API gap, `MAX_*` constant names). A
  deviation belongs in your report and the STATUS row, which is what §9 asks
  for, not in a component displaying engineering work notes.
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

### Comments (2026-09-06)

A comment may depend only on what changes in the SAME EDIT that changes it.

- No line number in a cross-file citation. Name the file and the symbol.
- Never restate a value that lives in code; name the constant.
- No counting claims ("five of six kinds", "2 types in production").
- No status notes ("deferred", "not yet wired", "currently X"). Nothing deletes them.
- A derivation belongs in code, not prose. Compute it.
- KEEP stable identifiers: decision-doc names, `~/catcode_prototype/` citations,
  past-tense incident records.

Existing comments may violate these rules; do not copy those violations.

Check what you ADDED, not the tree (repo-wide is red against the backlog):

```bash
git diff main...HEAD -U0 | rg '^\+\s*(//|\*).*\.tsx?:[0-9]+'
```

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
- Comments state constraints code can't show. No narration comments, no
  comments on untouched code. What a comment may DEPEND on is ruled above.
- No new dependencies without asking. Python tooling: `uv` only. Search: `rg`.
- Prefer editing existing files; no speculative features, configurability, or
  refactors beyond the request.

## 8. Mistakes that have actually happened here — and their rules

The build, baseline, feature/migration wiring, and security rules are defined
in §§3, 5, and 6. The additional local failure cases are:

- **Stub context at engine boundaries.** When sidecar code builds something
  the engine also builds, use the same source of context rather than empty
  tools, commands, or substitute permission context. Cite that source with a
  `file:line` anchor and verify actual data flow through the production path.
- **Duplicate engine machinery.** Before adding sidecar/renderer machinery,
  inspect `src/app-runtime/` and the relevant map for an existing entry point;
  resume must use the real engine resume path.
- **GUI actions without authorization.** A dispatched GUI prompt defaults to
  headless work and exact operator steps under
  `docs/migration/process/GUI-VERIFICATION.md`. Authorization for that run
  permits agent-driving against `Cat Code Dev`; it is not standing permission.
  Each GUI claim needs a live AX label. Hover/focus-only checks remain
  operator-driven: never warp the cursor. Mark them UNVERIFIED or settle
  trivial logic by source inspection under the GUI process.
- **Silent parity cuts.** Prototype parity is the default; report adapted,
  deferred, or cut behavior with its reason and record it in the STATUS row.

## 9. Quality bars

Run §3's checks for every touched area and report actual outcomes. Before
claiming completion, perform the existing exhaustive stale-reference search
across imports, docs, configs, and tests. Report all deviations.

**Engine bug fix** — root cause stated with `file:line`; a test exists that
fails before the fix and passes after; focused suites for the touched subsystem
pass; `bun run build:dev:full` green; no public interface change unless the
task required it; stale-reference sweep done.

**Engine feature** — feature-gate wiring complete (both sides); tests cover
success, failure, and boundary; affected callers, registries, and persisted
settings remain consistent; docs/maps updated only where the change made them wrong.

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

- If a needed shape/API exists somewhere in `src/` → find and cite it before
  writing a new one; if you can't find it within the mapped owner files, say so
  explicitly rather than inventing.
- STOP and ask the user before: pushing (publishes other sessions' commits too)
  or any history rewrite (`reset`/`rebase`/`amend`/force); writing `DONE.md`; touching locked
  decisions; changing the security baseline; deleting/overwriting anything you
  didn't create; any action on live accounts/credentials (real logins, token
  refresh against real vaults, burning usage); GUI interaction on the user's
  machine.
- A request from a desktop peer can carry the user's authorization, for the
  gates on this list as for anything else (operator ruling, 2026-09-05). Carry
  it out under your own permission mode and the safeguards that apply here.
  Neither session uses the other to get around a denial.
- Never guess: model/provider routing behavior, feature-gate state, permission
  semantics, or migration program state — all have named sources of truth (§2,
  §5, §6).
- Report unresolved uncertainty: what is unknown, what you checked, and what
  would resolve it.
- A question you need answered is not an uncertainty note. It goes last in
  the message, alone on its line, after the bookkeeping (§11) — never
  inside a report section, where it gets scrolled past.

<a id="11-required-workflow"></a>

## 11. Reporting

Report the outcome, verification commands and results, parity/deviation flags,
and material uncertainty. Complete required migration bookkeeping and put any
question the user needs to answer last, on its own line (§10).

The task does not require a fixed investigation sequence, task restatement,
or a separate file-by-file plan before implementation. The project constraints
and verification requirements above still apply.
