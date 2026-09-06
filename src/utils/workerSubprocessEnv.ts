import { isEnvTruthy } from './envUtils.js'

/**
 * Flag that turns worker environment narrowing on.
 *
 * Fork-local name on purpose. The upstream CLAUDE_CODE_SUBPROCESS_ENV_SCRUB in
 * subprocessEnv.ts means "this workflow is exposed to untrusted content" and
 * applies to every subprocess this process starts, the operator's own hooks,
 * shell snapshot, MCP stdio servers and LSP included. This flag means something
 * different: "this shell command belongs to a subagent". It reaches the shell
 * spawn only, and it leaves subprocessEnv() alone.
 *
 * Default off. With it unset, exec hands spawn the same object it always did,
 * so nothing in this module runs on the operator's own commands.
 */
export const WORKER_ENV_ALLOWLIST_FLAG = 'CAT_CODE_WORKER_ENV_ALLOWLIST'

/**
 * The complete environment a subagent's shell gets when the flag is on.
 *
 * An allowlist rather than a denylist because a denylist of credential names
 * goes stale the moment a new credential variable exists, and fails open. This
 * fails closed: a name absent from this list is absent from the child, whether
 * or not anyone recognised it as a secret. The cost of that shape is that a
 * legitimate variable nobody thought of also disappears, so every entry below
 * says why it is here and what breaks without it.
 *
 * Deliberately NOT here, and each is a live variable on the operator's machine:
 *   SSH_AUTH_SOCK          a worker can authenticate and sign as the operator
 *                          for as long as the agent is unlocked. Excluding it
 *                          costs this repo nothing: origin is an https remote,
 *                          and neither a signing key nor commit.gpgsign is
 *                          configured, so no git path here reaches the agent.
 *                          Authenticated git over the network fails for a
 *                          worker regardless, because the osxkeychain
 *                          credential helper needs SECURITYSESSIONID, which is
 *                          also excluded. That is the intended outcome, not a
 *                          gap: the operator pushes, workers do not.
 *   CLAUDE_CODE_MESSAGING_TOKEN, CLAUDE_CODE_MESSAGING_SOCKET
 *                          together a capability handle onto the cross-session
 *                          messaging plane, not an API secret. A worker holding
 *                          them can address other sessions.
 *   SECURITYSESSIONID      the handle a process needs to reach the macOS
 *                          Keychain. Reaching the keychain is the authority
 *                          being narrowed, not an accident of the list.
 */
export const WORKER_ENV_ALLOWLIST = [
  // --- Floor: without these a shell is not usable. Verified by experiment,
  // recorded in docs/reports/2026-09-06-worker-subprocess-environment.md.
  'PATH',
  // Load-bearing, and the one entry a "minimal" list would drop. `git config
  // user.name` returns empty with no HOME, so a worker's `git commit` fails
  // with an identity error that reads nothing like a missing variable. HOME is
  // also what makes the bun install cache reachable.
  'HOME',
  'PWD',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',

  // --- Terminal and locale. Neither is set in the desktop sidecar's
  // environment, but the terminal engine inherits both, and a toolchain that
  // reads them (python, perl, less, git's pager) changes output encoding or
  // warns when they vanish.
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',

  // --- Proxy. Enumerated by TEAMMATE_ENV_VARS in src/utils/swarm/spawnUtils.ts,
  // which is this repo's only worked answer to "what does a child of this
  // engine need beyond PATH". These are the entries a hand-written allowlist
  // reliably forgets: behind a proxy, a worker whose git fetch and bun install
  // lose them fail with something that looks like a network fault.
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',

  // --- TLS trust roots, per runtime. Same source, same failure mode: a
  // corporate MITM root that stops being trusted reads as a certificate error,
  // not as a missing variable.
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  // Set on the operator's machine. Tells Node to trust the OS store; dropping
  // it silently narrows what a worker's node/bun can reach over TLS.
  'NODE_USE_SYSTEM_CA',

  // --- Provider and config routing. Also from TEAMMATE_ENV_VARS. These are
  // routing, not credentials: without them a nested CLI defaults to the wrong
  // endpoint or the wrong config directory rather than failing outright, which
  // is the harder bug to see.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_REMOTE_MEMORY_DIR',

  // --- Authored by the engine on the spawn itself, not inherited. The filter
  // runs over the fully composed object so that the shell provider's overrides
  // are filtered too, which means these have to be named here or exec would
  // strip its own settings.
  'CLAUDECODE',
  'GIT_EDITOR',
  'CLAUDE_CODE_SESSION_ID',
  // Points at the engine's isolated tmux socket, never the operator's.
  'TMUX',
  // Set together by the shell provider when a command runs sandboxed. Dropping
  // them puts a sandboxed worker's temp files outside the sandbox.
  'CLAUDE_CODE_TMPDIR',
  'TMPPREFIX',
] as const

const ALLOWED_NAMES: ReadonlySet<string> = new Set(WORKER_ENV_ALLOWLIST)

export function isWorkerEnvAllowlistEnabled(): boolean {
  return isEnvTruthy(process.env[WORKER_ENV_ALLOWLIST_FLAG])
}

/**
 * Whether one exec should get the narrowed environment.
 *
 * agentId is the fact: ToolUseContext.agentId is set only for subagents, so its
 * presence is what distinguishes a worker's shell from the operator's. This
 * function is the policy that reads the fact. Callers pass agentId and nothing
 * else, so there is one discriminator rather than two that can disagree.
 */
export function isWorkerScopedExec(agentId: string | undefined): boolean {
  return agentId !== undefined && isWorkerEnvAllowlistEnabled()
}

/**
 * Returns a copy of `env` holding only allowlisted names.
 *
 * Values are copied through untouched, including undefined, because
 * child_process drops undefined-valued keys and callers rely on that to unset
 * a name (exec passes SHELL: undefined for non-bash shells).
 *
 * This covers everything that reaches the child through spawn's `env`, which
 * includes the shell provider's own overrides. It does NOT cover anything the
 * shell sources after it starts: see buildExecCommand in
 * src/utils/shell/bashProvider.ts for the session-environment script, which is
 * skipped for a worker-scoped exec instead of filtered, since a filter at spawn
 * time cannot see it.
 */
export function applyWorkerEnvAllowlist(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const narrowed: NodeJS.ProcessEnv = {}
  for (const name of Object.keys(env)) {
    if (ALLOWED_NAMES.has(name)) {
      narrowed[name] = env[name]
    }
  }
  return narrowed
}
