# CLAUDE.md

Cat Code is a private Claude Code fork for one person, with a terminal engine
and a production Electron desktop app. Multiple agent sessions share this tree.

These are repository constraints and useful defaults. Choose an approach suited
to the task; investigation, planning, and reporting do not need a fixed sequence.
Source establishes current behavior; an implementation bug does not override a
user requirement or security constraint. Flag meaningful documentation drift.

## 1. Workspace

- `src/`, `scripts/`: terminal engine and shared runtime, using the root package.
- `app/`: desktop package with separate build and typecheck boundaries.
- `docs/maps/`: navigation maintained against source. Dated plans and migration
  program records describe past work; decision records may contain later amendments.
- `renderer-theme/` and `scripts/typecheck/renderer-engine-types/`: legacy
  harnesses; do not extend them.

There is no public compatibility or rollout obligation. Preserve the user's
saved sessions, settings, credentials, and running work when changing formats.

## 2. Finding the owner

Start with supplied files or a known owner. For unfamiliar areas,
[the workspace map](docs/maps/WORKSPACE_MAP.md) routes to focused maps and source.
Read references as relevant to the task, not as a required tour of the repository.

- Prompt/instruction work: [prompt surfaces](docs/prompts/2026-04-30-prompt-surfaces.md).
- Desktop runtime: [desktop map](docs/maps/web-app-runtime.md).
- Peer behavior: [peer decisions](docs/migration/decisions/PEER-SESSIONS.md) and
  [host requests](docs/migration/decisions/HOST-REQUEST-PLANE.md), including amendments.
- GUI verification: [GUI process](docs/migration/process/GUI-VERIFICATION.md).
- `~/catcode_prototype/cat-app/` is a read-only UX reference. Its code and mock
  contracts are not implementation inputs; verify its source anchors in this repo.

## 3. Verification

Test the changed behavior at the lowest layer that exposes the risk. Include
process or UI checks when the boundary itself matters. A bug regression test
should distinguish the broken behavior from the fix.

Commands below run from the repository root. Use the applicable package checks
for code changes; documentation-only work needs the docs checks. For a small
change, a narrower check is reasonable when it covers the affected behavior;
state what was checked and any material gap. Shared runtime or boundary changes
need the broader affected package checks.

| Area | Checks |
|---|---|
| Engine | `bun run build:dev:full` and `bun test <specific test paths>` |
| Desktop | `bun test app/`, `bun run --cwd app typecheck`, `bun run --cwd app typecheck:sidecar` |
| Renderer build inputs | `bun run --cwd app renderer:build` |
| Desktop security/runtime integration | `bun run --cwd app test:hardening` (launches Electron; needs authorization for that run) |
| Docs only | `git diff --check` and `bun run maps:lint`; check changed links |

- Use the dev build; `bun run build` and `./cli` require an explicit request.
  `cat-code exec` exercises the Claude harness only, not Codex or Cat Code.
- Avoid bare `bun test`: some account suites require file-isolated runs.
  [Test routing and build caveats](docs/maps/build-release-testing.md) give details.
- Root typecheck has existing engine errors. Require no new diagnostics from
  the change; `build:dev:full` includes the separate undefined-name gate.
  The sidecar typecheck wrapper scopes errors to owned sidecar/shared files.
- Root lint is a branch-diff check and may miss working-tree edits. It does not
  cover `app/`. A clean lint or bundle alone is not behavior evidence.
- Renderer TSX runtime exports are components only; put shared helpers, hooks,
  and constants in `.ts` modules. Desktop scripts enforce Fast Refresh boundaries.
- Investigate failures against the current diff. A dirty file is a reason to
  check ownership, not proof a failure is unrelated. Coordinate before changing
  another session's work; report unrelated failures without repairing their slice.
- Dev sidecars load current repository TypeScript when spawned. While editing
  `src/` or `app/sidecar/`, avoid spawning sessions in an open dev app, including
  creating peers or waking parked peers. Existing sessions retain loaded code.
  Main/preload changes need a full dev restart; renderer HMR does not reload them.

## 4. Shared-tree Git

- Treat unfamiliar edits and untracked files as another session's work.
  Check the current diff before editing or committing, and re-read shared files
  before writing. Coordinate known overlap; an empty desktop peer list does not
  account for terminal sessions.
- Stage explicit paths and inspect the staged diff. If a file contains mixed
  ownership, stage only your hunks. Do not stash, sweep-clean, revert others'
  changes, or use broad staging (`git add -A`, `git add -u`, `git commit -a`).
- Commit coherent, verified work to the current branch without asking, using
  `type(scope): subject`. No branches, worktrees, or PRs unless requested.
  Push only when asked: pushing this branch can publish others' commits too.
- Avoid history rewrites on the shared branch. An authorized rewrite needs
  explicit SHAs and a fresh tip/ownership check. Do not bypass commit hooks.
- Requested manual worktrees use `.worktrees/<slug>` with `worktree-<slug>`;
  `.claude/worktrees/agent-*` belongs to the harness. Use `git worktree list`
  for inventory. Clean up your merged worktree and branch only after verifying
  it is inactive, clean, and fully merged; do not force-remove uncertain work.
- Write `DONE.md` only when asked.

## 5. Architecture boundaries

Desktop flow: renderer → preload → main → supervisor → Unix socket → Bun
sidecar running the real engine. The supervisor and host plane are Electron-free.

Preserve Unix-socket transport, one engine process per session, raw
`AppSessionEvent` fidelity, the chosen window/session lifetime, and the separate
`appSessionId` / `engineSessionId` identities unless the user requests redesign.
Check [decision records](docs/migration/decisions/) and source for details.

Security is enforced at the receiving boundary: closed inbound schemas,
engine-owned permission requests, and bounded frames/rates. The renderer neither
receives raw credentials nor authors permission rules. Preserve the
separate session protocol and host control-plane contracts. Boundary work uses
[security minimum](docs/migration/decisions/SECURITY-MINIMUM.md),
[permission boundary](docs/migration/decisions/PERMISSION-BOUNDARY.md), and
[host requests](docs/migration/decisions/HOST-REQUEST-PLANE.md).

## 6. Sensitive and generated code

- `app/shared/protocol.ts`: preserve versioning; breaking wire shapes require
  a version bump. New inbound kinds need receiving-boundary validation, tests
  accepting valid and rejecting invalid input, and a decision reference.
- Regenerate `app/shared/engine-types.snapshot.d.ts`,
  `app/shared/sdk-types.snapshot.d.ts`, and
  `src/entrypoints/sdk/coreTypes.generated.ts` from their sources.
- `src/migrations/runEngineMigrations.ts` owns startup migration registration,
  order, versioning, and cross-process locking. Use it for persisted-state migrations.
- `src/codex-core/accounts.ts` coordinates shared token rotation. Preserve its
  locks and durable attempt ledger; exercise changes with isolated test state.
- Keep desktop diagnostic schemas bounded and exports allowlisted/redacted.
  Raw operational logs, transcripts, settings, and debug output must not be
  injected into product model prompts; see `app/main/diagnosticsBundle.ts`.
- Do not refactor `src/vendor/` or rewrite `eslint-suppressions.json` to pass lint.

## 7. Coding and user-visible text

- Use TypeScript and Bun. Keep desktop strictness; do not enable root strict
  flags or fix unrelated engine diagnostics. Ask before adding dependencies.
  Use `uv` for Python tooling when needed.
- Follow nearby module/test conventions. For desktop state, preserve reducers
  and read-time selectors rather than mutating stored transcript rows.
- Reject invalid inbound input; render unknown display variants gracefully.
  Runtime-narrow unknown shapes and keep closed-union handling exhaustive.
  When extending SDK message handling, update its projector and fixtures together.
- User-visible text, including accessibility labels and tool descriptions,
  contains no em dashes or internal engineering notes. Explain useful actions
  and surprising states without repeating the user's selection.
  `app/renderer/src/userVisibleText.test.ts` enforces engineering-text exclusions;
  `§7-ok` is for a justified local exception, not a widened allowlist.
- Comments explain constraints code cannot show. Avoid prose that silently
  becomes stale when another file changes; cite symbols instead of cross-file
  line numbers or duplicated values. Keep useful rationale and incident context.
- Renderer styling belongs in stylesheets/classes, not inline `style={{}}`.

## 8. Engine integration

Reuse real engine entry points and context from `src/app-runtime/` and the
relevant owner. Stub tools, commands, permission context, or duplicate resume
machinery can make a test pass while production remains broken.

Feature changes need both the build-time feature set in `scripts/build.ts` and
runtime `feature(...)` consumers. Provider behavior is owned by
`src/utils/model/providers.ts`; verify routing there rather than inferring it
from the session label.

## 9. Scope and documentation

Make the changes needed to complete the request, including affected callers,
tests, and docs. Follow references when renaming or removing a contract; avoid
unrelated cleanup. New plans/reports belong under `docs/<topic>/YYYY-MM-DD-slug.md`;
maintained maps and root entrypoints are updated in place.

## 10. Live state and authorization

The user's `~/.cat-code/`, account vault, and running app contain real work.
Use isolated state for tests. Live logins, token refreshes, quota-consuming
probes, GUI launches/driving, destructive operations outside the requested edit,
and changes to locked architecture or the security baseline need authorization
covering that action. Honor authorization already given for this task.

For GUI work, use **Cat Code Dev** and the linked GUI process. Do not steal
focus or warp the cursor for hover-only checks; leave precise operator steps
for checks you cannot perform. Stop only processes you started and tracked by
PID; no name-based or discovery-paired sweep kills.

## 11. Reporting

<a id="11-required-workflow"></a>

Report the result, relevant verification outcomes, and material limitations.
Distinguish source inspection from observed runtime/GUI behavior. Match the
detail to the task; no fixed report template is required.
