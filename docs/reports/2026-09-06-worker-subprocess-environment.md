# Narrowing a worker's subprocess environment: the decision input

**Date:** 2026-09-06
**Status:** Decision input. Nothing changed in `src/`, `app/`, or `scripts/`.
**Scope:** item 9 of the fix order in
`docs/reports/2026-09-06-subagent-escalation-and-delegation-failures.md` §12,
i.e. the containment gap in §11b: `subprocessEnv()` returns the operator's whole
environment to every subprocess a worker starts.
**Evidence:** source read in this working tree at `e7ac319e` — `src/utils/subprocessEnv.ts`
and its six call sites, `src/utils/Shell.ts`, `src/utils/shell/bashProvider.ts`,
`src/utils/sessionEnvironment.ts`, `src/tools/AgentTool/runAgent.ts`,
`src/constants/tools.ts`, `src/utils/swarm/spawnUtils.ts`,
`src/services/api/codexAccountPool.ts`, `src/codex-core/accounts.ts` — plus four
`env -i` experiments run here (recorded in §6) and the live global MCP config
`~/.cat-code/.cat-code.json`. Where a claim is inference rather than something I
read or ran, the sentence says so.

---

## Recommendation

**Do not extend `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`.** It is the wrong shape for
this problem in three independent ways: it is read from `process.env` inside
`subprocessEnv()`, which takes no caller argument, so it cannot tell a worker's
`Bash` from the operator's; subagents run in-process (`runAgent` at
`src/tools/AgentTool/runAgent.ts:331` is an async generator, no `spawn`), so
"the worker's process" does not exist as a thing to scope a process-wide flag
to; and its meaning is inherited from upstream, where it denotes "this workflow
is exposed to untrusted content", not "this caller is a worker".

**Put the decision where `context.agentId` already is** — at the tool's own
`call`, which is exactly where item 2 put the `ClaudeCli` deny
(`src/tools/ClaudeCliTool/ClaudeCliTool.tsx` `checkPermissions`: `if (context.agentId !== undefined)`).
Concretely: add an optional `envScrub` (or `agentScoped: true`) field to
`ExecOptions` in `src/utils/Shell.ts:161`, set it from `context.agentId` at
`src/tools/BashTool/BashTool.tsx:927` and the `PowerShellTool` equivalent, and apply a **denylist**
inside the `spawn` at `src/utils/Shell.ts:318`. Leave the other four
`subprocessEnv()` call sites alone: all four are the operator's own machinery,
and scrubbing them to contain a worker is the failure mode to avoid.

**And say plainly what that buys.** It removes named secrets from a worker's
shell. It does not remove the worker's *authority*, because the Codex vault, the
lockfiles, the settings, and the network are reached through the filesystem and
the socket layer, none of which an environment change touches (§5). If the goal
is "a subagent cannot create agency", the environment is the cheapest tenth of
that job and should be described as such rather than as the fix.

---

## 1. What a worker legitimately needs

I did not find a documented list, so I derived one from what this repo's own
tooling reads plus four experiments.

**Read from source.** `scripts/` reads only `HOME`, `TMPDIR`, `NODE_ENV`,
`USER_TYPE`, `CLAUDE_CONFIG_DIR`, `CLAUDE_PROJECT_DIR`, `CCR_FORCE_BUNDLE`, and
a handful of `CLAUDE_*` tuning knobs (`scripts/mapRoutingNudge.ts`,
`scripts/build.ts`, `scripts/memory-behavior-eval/*`). Nothing in `scripts/`
reads a CI flag, `TERM`, or a locale variable.

**The non-obvious ones are already enumerated in this repo**, in
`src/utils/swarm/spawnUtils.ts:96` (`TEAMMATE_ENV_VARS`). That list exists for a
different reason — tmux teammates start a login shell that may not inherit the
parent env, so these are force-forwarded — but it is the closest thing here to a
worked answer for "what a child of this engine actually needs beyond `PATH`":

- proxy, in both cases: `HTTPS_PROXY` `https_proxy` `HTTP_PROXY` `http_proxy`
  `NO_PROXY` `no_proxy`
- TLS trust roots, per runtime: `SSL_CERT_FILE` `NODE_EXTRA_CA_CERTS`
  `REQUESTS_CA_BUNDLE` `CURL_CA_BUNDLE`
- provider/config routing: `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`,
  `ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_REMOTE`,
  `CLAUDE_CODE_REMOTE_MEMORY_DIR`

Any denylist must not touch those; any allowlist must contain them. The proxy
and CA entries are the ones a hand-written allowlist reliably forgets, and their
failure mode is a worker whose `git fetch` and `bun install` fail behind a
corporate MITM with an error that looks like a network fault.

**Measured, not inferred** (commands and output in §6): `git` resolves refs
under `env -i` with `PATH` alone; `bun --version` and `bun -e` run with `PATH`
alone and `HOME` undefined; `bun test src/utils/subprocessEnv.test.ts` passes
under `env -i PATH=… TMPDIR=/tmp`. The one break I found is `git config
user.name` returning empty with no `HOME`, which means **`git commit` would fail
for a worker without `HOME`** — global config is where identity lives on this
machine. `HOME` is also what makes `~/.bun/install/cache` reachable, so dropping
it would turn every `bun install` into a cold fetch; I did not test that, since
`bun install` mutates the tree.

The live baseline is leaner than the GitHub-Actions framing assumes. Enumerating
names only (never values) from this session's environment: `HOME LOGNAME
NODE_USE_SYSTEM_CA PATH PWD SHELL SSH_AUTH_SOCK TMPDIR USER XPC_FLAGS
XPC_SERVICE_NAME __CFBundleIdentifier __CF_USER_TEXT_ENCODING`, plus `CLAUDE_*`
session variables. No `TERM`, no `LANG`/`LC_*`, no `CI`, no proxy variables, no
cloud credentials. Caveat, and it matters: this is the *Claude Code* session's
environment, which is the closest proxy I have but is not proven identical to
the cat-code terminal engine's or the desktop sidecar's. Enumerating those needs
a running instance.

So a worker's floor on this machine is roughly `PATH HOME TMPDIR PWD SHELL USER
LOGNAME` plus the proxy/CA/routing block above. That is small enough that an
allowlist is technically feasible — and §4 argues against it anyway.

## 2. What should be removed, and what `GHA_SUBPROCESS_SCRUB` misses

`GHA_SUBPROCESS_SCRUB` (`src/utils/subprocessEnv.ts:15`) is a *correct* list for
its stated threat and an *incomplete* list for this one. Roughly a third of its
24 entries are GitHub-Actions-only and inert here: `ACTIONS_ID_TOKEN_REQUEST_*`,
`ACTIONS_RUNTIME_*`, `ALL_INPUTS`, `OVERRIDE_GITHUB_TOKEN`,
`DEFAULT_WORKFLOW_TOKEN`, and the `INPUT_${k}` duplication loop. The cloud-provider
entries are dormant on a machine with no AWS/Azure/GCP variables set.

What it misses, taken from every `process.env.<NAME>` read across `src/` whose
name denotes a credential:

| Missing name | Why it belongs |
|---|---|
| `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_SESSION_ACCESS_TOKEN`, `CLAUDE_TRUSTED_DEVICE_TOKEN`, `CLAUDE_BRIDGE_OAUTH_TOKEN` | Long-lived Anthropic auth. The list scrubs `CLAUDE_CODE_OAUTH_TOKEN` but not the refresh token beside it. |
| `CLAUDE_CODE_MESSAGING_TOKEN` + `CLAUDE_CODE_MESSAGING_SOCKET` | **Both are set right now.** Together they are a capability handle onto the cross-session messaging plane (`src/utils/concurrentSessions.ts:87`), not a secret for an API. A worker holding them can address other sessions. This is the single most surprising item on the list. |
| `CLAUDE_CODE_CLIENT_KEY`, `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE` | mTLS client identity. |
| `MCP_CLIENT_SECRET`, `MCP_XAA_IDP_CLIENT_SECRET` | MCP OAuth client secrets. |
| `CAT_CODE_PTCLOVE_TOKEN`, `PTCLOVE_CAT_CODE_TOKEN` (+ their `_FILE` twins) | Fork-local bridge auth, read at `src/hooks/usePtcloveBridge.ts:90`. Nothing upstream knows these names exist. |
| `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`, `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR` | Half-measures. Deleting the variable hides the fd *number*; it does not close the fd, which is inherited unless `spawn` is told otherwise. A child can still walk `/dev/fd`. Deleting them is right; believing it closes the hole is not. |

`OPENAI_API_KEY` appears only in test files under `src/` — the Codex path takes
no key from the environment (§5), so it is worth scrubbing for hygiene but is
not part of the exposure.

Two entries deserve an explicit ruling rather than a default:

- **`SSH_AUTH_SOCK` is set and is not on any list.** A worker's shell can
  authenticate and sign as the operator over SSH for as long as the agent is
  unlocked. It is also what makes `git push`/`git fetch` over SSH work. My
  reading is that a worker should not have it, and that this is acceptable
  because §4 of CLAUDE.md already says workers do not push. This is a policy
  call for the operator, not something source can settle.
- **`GITHUB_TOKEN`/`GH_TOKEN` are deliberately kept** upstream because they are
  job-scoped and expire with the workflow. Neither premise holds for a personal
  access token on a workstation. If either is ever set here, the upstream
  rationale does not transfer and they should be scrubbed.

## 3. What breaks: the six call sites, sorted by whose subprocess it is

This is the half that decides cost. Four of the six callers are the operator's
own machinery; a process-wide scrub degrades all of them to contain the two that
matter. The seventh row below is the CCR proxy, which injects into
`subprocessEnv()` rather than calling it.

| Call site | Whose subprocess | Effect of a scrub |
|---|---|---|
| `src/utils/Shell.ts:318` (`exec`, spawns a fresh child per command) | **Both.** Same function for the operator's `Bash` and a worker's. | The target. Also the reason a caller-blind flag cannot work. |
| `src/tools/ClaudeCliTool/ClaudeCliTool.tsx:380` | **Worker or operator.** Item 2 already denies it to ungranted workers. | The target, for a granted worker. A scrubbed nested CLI would have to find its own credentials — which on this machine it can, from the vault (§5). |
| `src/utils/hooks.ts:883` | Operator's configured hooks. The comment at line ~896 is explicit that plugin option *values*, secrets included, are passed because "hooks run the user's own code, same trust boundary as reading keychain directly." | Scrubbing hooks contradicts a stated trust decision. Leave alone. Hooks do carry `agentId` in their input payload (`src/utils/hooks.ts:325` `agent_id`), so a future per-caller rule is possible here, but nothing asks for one. |
| `src/utils/bash/ShellSnapshot.ts:463` | Operator, once. Created per shell-provider construction (`src/utils/shell/bashProvider.ts:65`), not per worker. | Would break the operator's snapshot to contain a worker. Note it already has its own opt-out, `CLAUDE_CODE_DONT_INHERIT_ENV` — a second, differently-named env-inheritance control in the same subsystem. |
| `src/services/mcp/client.ts:964` | Operator, at session start. Servers are connected once and shared; workers inherit tool handles, not their own server processes. | See `cua-driver` below. |
| `src/services/lsp/LSPClient.ts:100` | Operator, session-lifetime. | Would break language servers to contain a worker. |
| `src/upstreamproxy/upstreamproxy.ts` (injected, not a caller) | Neither. Gated on `CLAUDE_CODE_REMOTE` at `src/entrypoints/init.ts:165`, which is unset here, so `_getUpstreamProxyEnv` stays undefined and this is a no-op on this machine. | None. |

**`cua-driver`, the live example.** `~/.cat-code/.cat-code.json` declares it as
`{type: stdio, command: /Users/pt/.local/bin/cua-driver, args: [mcp], env: {}}`.
The empty `env` means it depends entirely on `subprocessEnv()` inheritance. Under
the *denylist* shape recommended here it would still start: it is a Mach-O Swift
binary (checked with `file`) and none of the names in §2 are plausibly its
inputs. Under an *allowlist* shape I would not be confident — a macOS AX client
wants `HOME`, `TMPDIR`, `__CF_USER_TEXT_ENCODING` and possibly the `XPC_*` pair,
and its accessibility grant travels through the inherited Mach bootstrap port
rather than the environment, which an allowlist does not affect but which I have
not verified against this binary. That asymmetry is on its own an argument for
the denylist. It is also moot under the recommendation, since MCP servers are
started by the operator's session and would not be scrubbed at all.

## 4. Is `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` the right mechanism?

No, and the reason is structural rather than aesthetic.

`subprocessEnv()` takes no arguments. It reads the flag from `process.env` at the
moment of the call. There is exactly one process: `runAgent`
(`src/tools/AgentTool/runAgent.ts:331`) is an in-process async generator, so a
worker's `Bash` call and the operator's `Bash` call enter the *same* function in
the *same* process with the *same* `process.env`. A flag read from there is
constitutionally incapable of distinguishing them. Turning it on to contain a
worker turns it on for the operator's shell, hooks, snapshot, MCP servers, and
LSP for the rest of the session.

The discriminator already exists one frame up: `ToolUseContext.agentId`
(`src/Tool.ts:254`, commented "Only set for subagents"). `ClaudeCliTool`'s
`checkPermissions` already branches on it. What is missing is plumbing, not a
concept: `ExecOptions` (`src/utils/Shell.ts:161`) carries no caller identity, so
`src/tools/BashTool/BashTool.tsx:927` cannot currently tell `exec` who is calling. That is the whole
mechanical cost — one optional field, one call-site change per shell tool, one
branch inside the existing `spawn`.

**Denylist over allowlist.** An allowlist is the stronger boundary and I am
recommending against it, for a reason that is specific to this repo rather than
general: the failure mode of a missing allowlist entry is a worker whose build,
proxy, or toolchain breaks in a way that reads as a normal bug, on a shared tree
where several sessions are running and the operator would be debugging the wrong
thing. The `TEAMMATE_ENV_VARS` list in §1 is evidence of how many non-obvious
entries such a list needs, and it was assembled over time against a real bug
(`GitHub issue #23561` is cited in its comment). A denylist fails the other way —
silently permissive — which is the right direction for a first cut whose honest
claim is "named secrets removed", not "worker contained".

**Keep the upstream flag's meaning intact.** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`
should keep meaning "this whole process is exposed to untrusted content" and keep
scrubbing everything, including the operator-side call sites. The new per-worker
rule composes with it rather than replacing it: worker → always scrubbed; flag on
→ everything scrubbed. Extend `GHA_SUBPROCESS_SCRUB` with the §2 additions (they
are correct for both meanings) and give the worker path its own entry point,
something like `subprocessEnv({ scrub: true })`, rather than a second flag.

## 5. What an environment change cannot close

Stated plainly, because the report's §11b sentence — "the credentials, the
account vault under `~/.cat-code/`, and the network" — bundles three things of
which only the first is environmental.

- **The Codex vault is not reached through the environment at all.**
  `readVaultPath()` (`src/services/api/codexAccountPool.ts:1008`) returns
  `DEFAULT_VAULT_PATH = join(homedir(), 'codex-vault')` unless
  `~/.codex-nootp/config.toml` names another path. `homedir()`, not an env var.
  The refresh lock target is `join(getClaudeConfigHomeDir(), 'codex-raw-refresh')`
  (`src/codex-core/accounts.ts:401`), and the ledger is
  `~/.cat-code/codex-raw-refresh.state.json`. A worker with a shell reads and
  writes all of it after any scrub. Deleting `CLAUDE_CONFIG_DIR` would not even
  hide the location, since the default is the location.
- **Two paths re-inject environment into the scrubbed shell, after the scrub.**
  In `src/utils/Shell.ts:318-322` the spawn spreads `...subprocessEnv()` first and
  `...envOverrides` after, and `getEnvironmentOverrides`
  (`src/utils/shell/bashProvider.ts:208`) copies in `getSessionEnvVars()`. Separately,
  `buildExecCommand` (`src/utils/shell/bashProvider.ts:170`) prepends
  `getSessionEnvironmentScript()`, which sources `CLAUDE_ENV_FILE` and every hook-written
  file under `~/.cat-code/session-env/` *inside* the shell
  (`src/utils/sessionEnvironment.ts:60`). Anything a SessionStart hook exports
  there survives a spawn-time scrub. I found no current writer of session env
  vars (`setSessionEnvVar` has no non-test caller), so this is latent rather than
  live — but any scrub that does not also cover it is defeated the day a hook
  starts using it.
  For completeness: the shell snapshot is *not* such a path. I read the generator
  and it writes only `export PATH=…` from `process.env.PATH` plus user functions
  and aliases; it does not dump the login shell's exported secrets.
- **The network is not environmental.** Removing every key still leaves outbound
  HTTP from a worker's shell.
- **The tool list still admits the shell.** `SHELL_TOOL_NAMES` is inside
  `ASYNC_AGENT_BASE_ALLOWED_TOOLS` (`src/constants/tools.ts:91`), so every async
  worker gets `Bash` by default, and `generalPurposeAgent`'s `tools: ['*']` gets
  it too. Items 1 and 2 moved `ClaudeCli` behind an explicit grant; they did not
  and were not meant to move the shell. Every claim in this document is downstream
  of that: the shell is the authority, and the environment is one of its inputs.

## 6. Commands run, and what remains unsettled

Experiments, verbatim:

```
$ env -i PATH=/usr/bin:/bin:/usr/local/bin git rev-parse --short HEAD
e7ac319e
$ env -i PATH=/usr/bin:/bin git config user.name
(no output, exit 0)
$ env -i PATH=…:/Users/pt/.bun/bin bun -e 'console.log("ok", process.env.HOME)'
ok undefined
$ env -i PATH=…:/Users/pt/.bun/bin TMPDIR=/tmp bun test src/utils/subprocessEnv.test.ts
1 pass  0 fail  3 expect() calls   Ran 1 test across 1 file. [21.00ms]
```

Docs gate: `git diff --check` clean; `bun run maps:lint` result recorded in the
dispatching session's report.

Not settled here:

- **Whether the cat-code engine's own environment matches the one enumerated in
  §1.** I read this Claude Code session's environment as a proxy. Settling it
  costs one line — a `Bash` call printing `env | cut -d= -f1 | sort` from inside a
  running cat-code terminal session and from a desktop sidecar — and should be
  done before any list is frozen, because the desktop sidecar is spawned by
  Electron main and its environment is assembled differently.
- **Whether `bun install` and `bun run build:dev:full` survive a scrubbed
  environment.** I deliberately did not run either under `env -i`: both write
  build output and a package cache on a tree shared with live sessions. The
  experiment is a detached worktree with a symlinked `node_modules` and
  `env -i PATH=… HOME=… bun run build:dev:full`; the thing to watch is the
  install cache, not the compile.
- **Whether `cua-driver mcp` starts under a narrowed environment.** Settled by
  `env -i PATH=/usr/bin:/bin HOME=$HOME /Users/pt/.local/bin/cua-driver mcp` and
  watching for a stdio handshake. I did not run it, because starting a second AX
  driver against the operator's live desktop is a GUI-adjacent action (CLAUDE.md
  §10) and it is moot under the recommendation.
- **Whether `SSH_AUTH_SOCK` should go.** Source cannot answer it; it is a
  trade between a worker signing as the operator and a worker's `git fetch` over
  SSH working.

Where source contradicted the report: §11b's first paragraph says `ClaudeCliTool`
"spawns with plain `spawn`" and kills only its direct child. That is no longer
true — `src/tools/ClaudeCliTool/ClaudeCliTool.tsx:395` now spawns `detached` and calls `killProcessTree`,
landed as `5f2489aa`. That is item 3 doing its job, not a defect in the report;
it is noted only so a later reader does not act on the stale sentence. The §11b
paragraph this document is about, on `subprocessEnv()`, matches source exactly.
