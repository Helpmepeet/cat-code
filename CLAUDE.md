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

## 1. Repo layout — know which world you are in

Three runtimes share this repo. **Which directory you touch decides which
build/test/typecheck battery applies (§3). Never mix them.**

| Area | What it is |
|---|---|
| `src/`, `scripts/` | The terminal agent engine (the Claude Code fork): CLI, REPL, tools, query pipeline, providers, Codex core, Agent Mode. Root package. |
| `app/` | The Electron desktop app (active migration program). Own package `@cat-code/desktop` with own scripts. Sub-folders are trust boundaries: `renderer/` `preload/` `main/` `supervisor/` (Electron-free) `host/` (Electron-free host plane: durable registry + typed control-plane API) `sidecar/` (runs the real engine) `shared/` (wire protocol). |
| `web/` | Browser chat frontend (Vite React). Own package. |
| `renderer-theme/`, `scripts/typecheck/renderer-engine-types/` | Temporary migration harnesses. Do not extend. |
| `docs/` | Plans, maps, reports. Dated filenames (`2026-05-12-…`) are historical records, NOT current truth. |

## 2. Navigation — read before you search

- **Execution boundary:** `cat-code exec` is reserved exclusively for exercising
  the Claude harness. Never use it to invoke, test, or stand in for Codex or
  Cat Code; use each system's native execution path instead.
- **Repository routing for implementation and diagnosis:** when ownership is not
  established and the task requires broad repository navigation, open
  `docs/maps/WORKSPACE_MAP.md` before the first broad search, choose only the
  relevant focused map, then verify the route in source. If exact owner files or
  a focused map were supplied, start there and skip the workspace router. Maps
  route; source is authoritative.
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
- `README.md`, `CLAUDE.md`, `AGENTS.md` stay the only root entrypoints. New
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

```bash
bun run build:dev:full        # THE build gate: branch-diff lint + ./cli-dev + version print
bun test <specific paths>     # focused tests only — there is NO root test script
```

- Never `bun run build` or `./cli` unless explicitly asked.
- Never bare `bun test` on the whole repo; some suites (Codex account suites)
  only pass file-isolated.
- Test routing per subsystem: `docs/maps/build-release-testing.md` §Test Routing.
- **Root `bun run typecheck` is KNOWN-RED** (~1,862 pre-existing errors across
  `src/` as of 2026-07-07; tsconfig is `strict:false` and test files dominate).
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

- Known-red baseline: raw `tsc -p app/sidecar/tsconfig.json` fails with ~5.5k
  pre-existing upstream-engine diagnostics (the include-override drops root
  `env.d.ts`). The wrapper (`app/scripts/sidecar-typecheck.ts`) ignores those
  and fails only on diagnostics in owned `app/sidecar`/`app/shared` files.
  **Zero new errors in owned files** is the pass bar — do not fix upstream noise.
- Live baseline as of 2026-07-07 (re-measure, don't assume): `bun test app/`
  485 pass / 0 fail · app tsc clean · sidecar wrapper green (5,548 upstream
  ignored) · hardening 19 checks. The counts grow; a DROP in pass count or any
  new owned diagnostic is a regression.
- Root `bun run lint` does not cover `app/**` (Phase-5 CI item). Do not cite a
  clean root lint as evidence for an `app/` change.

### Web (`web/`)

```bash
bun run --cwd web test && bun run --cwd web typecheck && bun run --cwd web build
```

### Docs-only changes

```bash
git diff --check
bun run maps:lint             # validates map index, dates, links, and cited paths
```

Lint caveat (all areas): `bun run lint` only lints files changed vs
`main...HEAD`, excluding `web/`, and the config enables **zero rules** (all 19
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
- Unresolved uncertainty goes in the final report as its own section:
  what is unknown, what you checked, what would resolve it. Do not bury it.

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

Claiming completion requires: battery output pasted, quality-bar checklist
satisfied, stale-reference sweep done, and zero unreported deviations.

## 12. GPT one-shot delegation via `cat-code -p`

Relocated 2026-07-10 from the global `~/.claude/CLAUDE.md` working-style file so
this cat-code-specific guidance loads only in this repo rather than every project.

### GPT model selection for `cat-code -p`
- **Scope: only GPT model choice for cat-code's headless, one-shot delegation.** This does not govern cat-code's internal model picker or generic GPT questions; answer those from source/docs.
- **Execution boundary:** `cat-code exec` is reserved exclusively for exercising the Claude harness. Do not use it to invoke, test, or stand in for Codex or Cat Code; use each system's native execution path instead.
- `cat-code -p` is for a decorrelated, bounded GPT pass such as reviewing a diff or plan. Use Claude `Agent` for long-running, resumable, or multi-step delegated work; the named-GPT MCP helper is retired.
- The repo's four-model GPT roster is below. A model rejection is a constraint to respect, not a reason to guess or bypass.
- Evidence tags: **[verified]** means stated by current OpenAI documentation or checked directly in cat-code source; **[inferred]** means a local selection policy derived from those facts, not a provider guarantee.

| Model | Rule | Why / evidence |
|---|---|---|
| `gpt-5.6-sol` | Use for the hardest bounded work that benefits from frontier capability: complex coding, research, or high-judgment review. | **[verified]** OpenAI describes Sol as the frontier GPT-5.6 model for complex professional work. **[inferred]** Reserve it for work where its quality advantage justifies the greater cost. |
| `gpt-5.6-terra` | Default for bounded coding, debugging, testing, recon, and tool-heavy `cat-code -p` work. Use it for substantial everyday or complex work when Sol is not justified. | **[verified]** OpenAI positions Terra as the balanced GPT-5.6 model and the natural starting point for the former general-purpose tier. **[inferred]** Keep it as the default rather than treating every one-shot as a model-selection experiment. |
| `gpt-5.6-luna` | Use for clear, repeatable, latency- or cost-sensitive work and high-volume one-shot checks. | **[verified]** OpenAI describes Luna as fast, affordable, and the lowest-cost GPT-5.6 option for efficient/high-volume workloads. **[inferred]** Prefer a different model when the task is ambiguous or high-judgment. |

- Use Claude `Agent` instead for high-judgment work, long-horizon coherence, aesthetics/UI taste, visual inputs, or where false confidence is dangerous.
- Brief a GPT reviewer like a peer: problem, constraints, evidence/report-back contract, and the complete material to inspect. Treat its output like coworker output — spot-check high-impact claims.

### Second opinion via `cat-code -p` (GPT one-shot, no Codex CLI)
- **What/when:** cat-code's own headless mode is the `codex exec` equivalent — no Codex CLI needed. `gpt-*` models route to the Codex/ChatGPT pool automatically (`src/utils/model/providers.ts:63`: `if (model.startsWith('gpt-')) return 'openai'`). Use it only for a one-shot decorrelated GPT pass (review a diff/plan); use Claude `Agent` for long-running or resumable work.
- **Reviewer command** (read-only, machine-detectable failure):

  ```bash
  git diff main...HEAD > /tmp/cc-review.patch
  cat-code -p --bare --model gpt-5.6-terra --effort high --tools "" \
    --output-format json \
    --append-system-prompt "You are a skeptical staff engineer doing a decorrelated second-opinion review. You did NOT write this code — judge ONLY the diff below. Report concrete bugs/security/unstated-requirement gaps as file:line. End with one line: 'VERDICT: APPROVED' or 'VERDICT: REVISE'." \
    "Review this diff:

  $(cat /tmp/cc-review.patch)"
  ```

- **Flags that matter:** the reviewer command below intentionally uses `gpt-5.6-terra`, the table's default for bounded coding/review; consult the table before changing it. `--bare` prevents recursion + context bloat (skips CLAUDE.md re-discovery, hooks, auto-memory); drop it only if a live run shows Codex auth doesn't load under bare. Read-only: `--tools ""` (pure judgment on the provided diff) or `--permission-mode plan --add-dir .` if it must open other files — never give a reviewer write tools. Large diffs: pipe via stdin (`cat x.patch | cat-code -p ...`).
- **Exhausted-profile handling (REQUIRED — the pool fails terminal, not silent):** the Codex pool auto-fails-over across profiles on 429/cap (LRU, bounded by maxRetries; `codexAccountPool.ts:8`, `withRetry.ts:337`). When ALL profiles are capped it THROWS a terminal error classified `quota.exhausted` (`withRetry.ts:166-176`). **Output-format matters:** in `--output-format json` you get `is_error:true` on the final result + non-zero exit (coarse — "it failed," no reason code); the granular `cat_code_account_diagnostic` code (`quota.exhausted | account.pool.unavailable | auth.missing`) is emitted **only** in `--output-format stream-json --verbose` (`print.ts:597-603,800-802`), or read it cleanly from `cat-code codex status --json` once that ships. So: on `is_error` / non-zero exit, do NOT retry-hammer and do NOT fabricate a GPT verdict. To decide wait-for-reset (quota) vs needs-repair (auth) vs truncated (max-turns), consult the stream diagnostic or `codex status`, then report the pool state (reset ~time) and fall back to my own Anthropic-side review, clearly labeled as mine, not GPT's. Non-zero exit / empty stdout in text mode = same failure.
- **`--fallback-model` does NOT rescue exhaustion** — it fires on overloaded/529, not account-cap (429), and any `gpt-*` fallback is the same pool. Leave it off for GPT delegation.
- **Caps don't persist across `-p` invocations:** the capped state is in-memory pool state (`codexAccountPool.ts:95`), never written to the vault. Each one-shot is a fresh process that rebuilds health from vault + startup usage poll, so a profile a prior delegation just capped isn't remembered — under pool pressure a one-shot can burn one wasted 429 round before it re-caps and fails over (the "stale usageResetAt" edge). Prefer one well-scoped pass over retrying several one-shots when profiles are near their limits.
- **Reusable persona:** bind a profile instead of retyping `--append-system-prompt` — `--agents '{"gpt-reviewer":{"description":"...","model":"gpt-5.6-terra","effort":"high","tools":["Read","Grep","Glob"],"prompt":"You are..."}}' --agent gpt-reviewer`. The agent def (also loadable from `.claude/agents/<name>.md`) binds persona + per-agent model + tools (`src/tools/AgentTool/loadAgentsDir.ts:75-116`) — cat-code's analog of a Codex `--profile`.
- **Caveat:** the on-PATH `cat-code` may be a stale build; `--bare` + Codex auth and the exact print-mode `is_error`/exit shape are worth one live smoke test before trusting the rule end-to-end.
