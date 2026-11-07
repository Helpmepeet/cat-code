import { type APIProvider, getAPIProvider } from '../../utils/model/providers.js'
import { feature } from 'bun:bundle'
import { prependBullets } from '../../constants/prompts.js'
import { isGPTPromptStyle } from '../../constants/promptStyle.js'
import { hasEmbeddedSearchTools } from '../../utils/embeddedTools.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getManagedSessionPolicy } from '../../utils/managedSessionPolicy.js'
import { shouldIncludeGitInstructions } from '../../utils/gitSettings.js'
import { getClaudeTempDir } from '../../utils/permissions/filesystem.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
} from '../../utils/timeouts.js'
import {
  getUndercoverInstructions,
  isUndercover,
} from '../../utils/undercover.js'
import { BASH_TOOL_NAME } from './toolName.js'

export function getDefaultTimeoutMs(): number {
  return getDefaultBashTimeoutMs()
}

export function getMaxTimeoutMs(): number {
  return getMaxBashTimeoutMs()
}

function getBackgroundUsageNote(): string | null {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) {
    return null
  }
  return "Use `run_in_background` when you don't need the result now. You are notified when it finishes, so don't poll for it or append `&`."
}

function getCommitAndPRInstructions(): string {
  // Defense-in-depth: undercover instructions must survive even if the user
  // has disabled git instructions entirely. Attribution stripping and model-ID
  // hiding are mechanical and work regardless, but the explicit "don't blow
  // your cover" instructions are the last line of defense against the model
  // volunteering an internal codename in a commit message.
  const undercoverSection =
    process.env.USER_TYPE === 'ant' && isUndercover()
      ? getUndercoverInstructions() + '\n'
      : ''

  if (!shouldIncludeGitInstructions()) return undercoverSection

  // For ant users, use the short version pointing to skills
  if (process.env.USER_TYPE === 'ant') {
    const skillsSection = !isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)
      ? `For git commits and pull requests, use the \`/commit\` and \`/commit-push-pr\` skills:
- \`/commit\` - Create a git commit with staged changes
- \`/commit-push-pr\` - Commit, push, and create a pull request

These skills handle git safety protocols, proper commit message formatting, and PR creation.

Before creating a pull request, run \`/simplify\` to review your changes, then test end-to-end (e.g. via \`/tmux\` for interactive features).

`
      : ''
    return `${undercoverSection}# Git operations

${skillsSection}IMPORTANT: NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it.

Use the gh command via the Bash tool for other GitHub-related tasks including working with issues, checks, and releases. If given a Github URL use the gh command to get the information needed.

# Other common operations
- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments`
  }

  return `# Git

- Commit only when the user asks or loaded repository instructions explicitly require one as part of the workflow; then stage only the intended paths and do not push unless separately authorized.
- Prefer staging specific named paths over \`git add -A\` or \`git add .\`.
- NEVER skip hooks (--no-verify, --no-gpg-sign) unless explicitly asked. A failed pre-commit hook means the commit did NOT happen: fix, re-stage, create a NEW commit, never --amend.
- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless explicitly asked.
- Prefer a new commit over amending one, and never bypass signing with \`-c commit.gpgsign=false\` unless explicitly asked.
- Interactive git flags (-i, e.g. git rebase -i, git add -i) are not supported.
- Use the \`gh\` CLI for GitHub work (issues, PRs, checks, releases).`
}

// SandboxManager merges config from multiple sources (settings layers, defaults,
// CLI flags) without deduping, so paths like ~/.cache appear 3× in allowOnly.
// Dedup here before inlining into the prompt — affects only what the model sees,
// not sandbox enforcement. Saves ~150-200 tokens/request when sandbox is enabled.
function dedup<T>(arr: T[] | undefined): T[] | undefined {
  if (!arr || arr.length === 0) return arr
  return [...new Set(arr)]
}

function getSimpleSandboxSection(): string {
  if (!SandboxManager.isSandboxingEnabled()) {
    return ''
  }

  const managedPolicy = getManagedSessionPolicy()
  const fsReadConfig = SandboxManager.getFsReadConfig()
  const fsWriteConfig = SandboxManager.getFsWriteConfig()
  const networkRestrictionConfig = SandboxManager.getNetworkRestrictionConfig()
  const allowUnixSockets = SandboxManager.getAllowUnixSockets()
  const ignoreViolations = SandboxManager.getIgnoreViolations()
  const allowUnsandboxedCommands =
    SandboxManager.areUnsandboxedCommandsAllowed()

  // Replace the per-UID temp dir literal (e.g. /private/tmp/claude-1001/) with
  // "$TMPDIR" so the prompt is identical across users — avoids busting the
  // cross-user global prompt cache. The sandbox already sets $TMPDIR at runtime.
  const claudeTempDir = getClaudeTempDir()
  const normalizeAllowOnly = (paths: string[]): string[] =>
    [...new Set(paths)].map(p => (p === claudeTempDir ? '$TMPDIR' : p))

  const filesystemConfig = {
    read: {
      denyOnly: dedup(fsReadConfig.denyOnly),
      ...(fsReadConfig.allowWithinDeny && {
        allowWithinDeny: dedup(fsReadConfig.allowWithinDeny),
      }),
    },
    write: {
      allowOnly: normalizeAllowOnly(fsWriteConfig.allowOnly),
      denyWithinAllow: dedup(fsWriteConfig.denyWithinAllow),
    },
  }

  const networkConfig = {
    ...(networkRestrictionConfig?.allowedHosts && {
      allowedHosts: dedup(networkRestrictionConfig.allowedHosts),
    }),
    ...(networkRestrictionConfig?.deniedHosts && {
      deniedHosts: dedup(networkRestrictionConfig.deniedHosts),
    }),
    ...(allowUnixSockets && { allowUnixSockets: dedup(allowUnixSockets) }),
  }

  const restrictionsLines = []
  if (Object.keys(filesystemConfig).length > 0) {
    restrictionsLines.push(`Filesystem: ${jsonStringify(filesystemConfig)}`)
  }
  if (Object.keys(networkConfig).length > 0) {
    restrictionsLines.push(`Network: ${jsonStringify(networkConfig)}`)
  }
  if (ignoreViolations) {
    restrictionsLines.push(
      `Ignored violations: ${jsonStringify(ignoreViolations)}`,
    )
  }

  const sandboxOverrideItems: Array<string | string[]> =
    allowUnsandboxedCommands
      ? [
          'You should always default to running commands within the sandbox. Do NOT attempt to set `dangerouslyDisableSandbox: true` unless:',
          [
            'The user *explicitly* asks you to bypass sandbox',
            'A specific command just failed and you see evidence of sandbox restrictions causing the failure. Note that commands can fail for many reasons unrelated to the sandbox (missing files, wrong arguments, network issues, etc.).',
          ],
          'Evidence of sandbox-caused failures includes:',
          [
            '"Operation not permitted" errors for file/network operations',
            'Access denied to specific paths outside allowed directories',
            'Network connection failures to non-whitelisted hosts',
            'Unix socket connection errors',
          ],
          'When you see evidence of sandbox-caused failure:',
          [
            'Retry with `dangerouslyDisableSandbox: true` — the harness will prompt the user to approve that specific command, so you do not need to ask separately first.',
            'Briefly explain what sandbox restriction likely caused the failure. Be sure to mention that the user can use the `/sandbox` command to manage restrictions.',
          ],
          'Treat each command you execute with `dangerouslyDisableSandbox: true` individually. Even if you have recently run a command with this setting, you should default to running future commands within the sandbox.',
          'Do not suggest adding sensitive paths like ~/.bashrc, ~/.zshrc, ~/.ssh/*, or credential files to the sandbox allowlist.',
        ]
      : [
          'All commands MUST run in sandbox mode - the `dangerouslyDisableSandbox` parameter is disabled by policy.',
          'Commands cannot run outside the sandbox under any circumstances.',
          'If a command fails due to sandbox restrictions, work with the user to adjust sandbox settings instead.',
        ]

  const items: Array<string | string[]> = [
    ...sandboxOverrideItems,
    managedPolicy
      ? `For intermediate files in this chat, use ${managedPolicy.temporaryDirectory}. The selected sandbox and permission mode still control access.`
      : 'For temporary files, always use the `$TMPDIR` environment variable. TMPDIR is automatically set to the correct sandbox-writable directory in sandbox mode. Do NOT use `/tmp` directly - use `$TMPDIR` instead.',
  ]

  return [
    '',
    '## Command sandbox',
    'By default, your command will be run in a sandbox. This sandbox controls which directories and network hosts commands may access or modify without an explicit override.',
    '',
    'The sandbox has the following restrictions:',
    restrictionsLines.join('\n'),
    '',
    ...prependBullets(items),
  ].join('\n')
}

export function getBashPrompt(
  provider: APIProvider = getAPIProvider(),
): string {
  // Embedded builds use bfs for find, whose regex semantics need guidance.
  const embedded = hasEmbeddedSearchTools()

  const sleepItems = [
    "Don't sleep between commands that can run now, and don't retry a failing command in a sleep loop; diagnose it instead.",
    ...(feature('MONITOR_TOOL')
      ? [
          'Use the Monitor tool to stream events from a background process (each stdout line is a notification). For one-shot "wait until done," use Bash with run_in_background instead.',
          '`sleep N` as the first command with N ≥ 2 is blocked. If you need a delay (rate limiting, deliberate pacing), keep it under 2 seconds.',
        ]
      : []),
  ]
  const backgroundNote = getBackgroundUsageNote()
  const workingDirectoryNote =
    "The main session's working directory persists between commands and is used by later tools. A foreground Bash command updates it to the command's final `pwd`, but shell state does not persist. In agent threads, a `cd` applies only to the current Bash call; the next call starts in the agent's assigned working directory. The shell environment is initialized from the user's profile (bash or zsh)."

  const instructionItems: Array<string | string[]> = [
    'Always quote file paths that contain spaces. Relative paths are fine from the current working directory; prefer absolute paths for locations outside it. Do not `cd` to the directory you are already in. When a command needs a different working directory, use `cd <directory> && <command>`.',
    'If a command fails or returns no output, do not assume success: check the exit status and stderr, then retry with a corrected command or report the failure with its output. Empty output is a result to interpret, not a completion signal.',
    `You may specify an optional foreground timeout in milliseconds (up to ${getMaxTimeoutMs()}ms / ${getMaxTimeoutMs() / 60000} minutes; default ${getDefaultTimeoutMs()}ms). At that limit, foreground execution stops or the command moves to the background when auto-backgrounding is enabled. Background commands have no duration timeout, including services; stop them explicitly when no longer needed.`,
    ...(backgroundNote !== null ? [backgroundNote] : []),
    `Send independent commands as parallel ${BASH_TOOL_NAME} calls in one message; chain dependent ones with \`&&\`.`,
    ...sleepItems,
    ...(embedded
      ? [
          // bfs (which backs `find`) uses Oniguruma for -regex, which picks the
          // FIRST matching alternative (leftmost-first), unlike GNU find's
          // POSIX leftmost-longest. This silently drops matches when a shorter
          // alternative is a prefix of a longer one.
          "When using `find -regex` with alternation, put the longest alternative first. Example: use `'.*\\.\\(tsx\\|ts\\)'` not `'.*\\.\\(ts\\|tsx\\)'` — the second form silently skips `.tsx` files.",
        ]
      : []),
  ]

  if (isGPTPromptStyle(provider)) {
    return [
      'Executes a given bash command and returns its output.',
      '',
      workingDirectoryNote,
      '',
      'Communication: Output text directly (NOT echo/printf)',
      '',
      'COMMAND EXECUTION RULES',
      ...prependBullets(instructionItems),
      getSimpleSandboxSection(),
      ...(getCommitAndPRInstructions() ? ['', getCommitAndPRInstructions()] : []),
    ].join('\n')
  }

  return [
    'Executes a given bash command and returns its output.',
    '',
    workingDirectoryNote,
    '',
    'Communication: Output text directly (NOT echo/printf)',
    '',
    '# Instructions',
    ...prependBullets(instructionItems),
    getSimpleSandboxSection(),
    ...(getCommitAndPRInstructions() ? ['', getCommitAndPRInstructions()] : []),
  ].join('\n')
}
