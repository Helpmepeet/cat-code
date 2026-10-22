import { describe, expect, test } from 'bun:test'
import { shouldRegisterForegroundShellTask } from '../../tasks/LocalShellTask/guards.js'
import { BashTool } from './BashTool.js'
import { getBashPrompt } from './prompt.js'
import { setManagedSessionPolicy } from '../../utils/managedSessionPolicy.js'

test('managed chat Bash guidance adds no GPT-only change-inspection rule', () => {
  setManagedSessionPolicy({
    workingDirectory: '/tmp/managed-bash',
    temporaryDirectory: '/tmp/managed-bash/tmp',
    storageRootId: '22222222-2222-4222-8222-222222222222',
    storageId: '11111111-1111-4111-8111-111111111111',
  })
  try {
    const prompt = getBashPrompt('openai')
    expect(prompt).not.toContain('inspect the changed files before moving on')
    expect(prompt).not.toContain('show the resulting git diff before moving on')
    expect(prompt).toContain('Never skip hooks')
  } finally {
    setManagedSessionPolicy(null)
  }
})

describe('Bash prompt working-directory guidance', () => {
  test('distinguishes main-session persistence from agent-thread Bash calls', () => {
    for (const provider of ['firstParty', 'openai'] as const) {
      const prompt = getBashPrompt(provider)

      expect(prompt).toContain(
        "The main session's working directory persists between commands and is used by later tools",
      )
      expect(prompt).toContain(
        "A foreground Bash command updates it to the command's final `pwd`",
      )
      expect(prompt).toContain(
        'In agent threads, a `cd` applies only to the current Bash call',
      )
      expect(prompt).toContain(
        "the next call starts in the agent's assigned working directory",
      )
    }
  })
})

describe('foreground shell registration', () => {
  test('does not depend on terminal JSX availability', () => {
    expect(
      shouldRegisterForegroundShellTask({
        backgroundTasksDisabled: false,
        backgroundShellId: undefined,
        elapsedSeconds: 3,
        progressThresholdMs: 2_000,
      }),
    ).toBe(true)
  })

  test('waits for the threshold and respects existing background state and disablement', () => {
    expect(
      shouldRegisterForegroundShellTask({
        backgroundTasksDisabled: false,
        backgroundShellId: undefined,
        elapsedSeconds: 1,
        progressThresholdMs: 2_000,
      }),
    ).toBe(false)
    expect(
      shouldRegisterForegroundShellTask({
        backgroundTasksDisabled: false,
        backgroundShellId: 'shell-1',
        elapsedSeconds: 3,
        progressThresholdMs: 2_000,
      }),
    ).toBe(false)
    expect(
      shouldRegisterForegroundShellTask({
        backgroundTasksDisabled: true,
        backgroundShellId: undefined,
        elapsedSeconds: 3,
        progressThresholdMs: 2_000,
      }),
    ).toBe(false)
  })
})

describe('Bash work lifetime classification', () => {
  test('passes explicit lifetime through input schema', () => {
    for (const lifetime of ['finite', 'service'] as const) {
      expect(
        BashTool.inputSchema.safeParse({
          command: 'npm run dev',
          work_lifetime: lifetime,
        }),
      ).toMatchObject({ success: true, data: { work_lifetime: lifetime } })
    }
  })

  test('keeps work lifetime optional for legacy background calls', () => {
    expect(
      BashTool.inputSchema.safeParse({
        command: 'npm run dev',
        run_in_background: true,
      }),
    ).toMatchObject({ success: true, data: { command: 'npm run dev', run_in_background: true } })
  })
})

describe('Bash prompt commit authority', () => {
  test('honors an explicit repository commit workflow without authorizing push', () => {
    for (const provider of ['firstParty', 'openai'] as const) {
      const prompt = getBashPrompt(provider)

      expect(prompt).toContain(
        'loaded repository instructions explicitly require one as part of the workflow',
      )
      expect(prompt).toContain(
        'stage only the intended paths and do not push unless separately authorized',
      )
    }
  })
})

describe('Bash prompt file-mutation policy', () => {
  test('both providers omit dedicated-tool restrictions while retaining command guidance', () => {
    for (const provider of ['openai', 'firstParty'] as const) {
      const prompt = getBashPrompt(provider)
      expect(prompt).not.toContain('Avoid using this tool to run')
      expect(prompt).not.toContain('verified that a dedicated tool cannot accomplish')
      expect(prompt).not.toContain('stays the default for whole-file reads')
      expect(prompt).not.toContain('Use apply_patch for local file edits')
      expect(prompt).not.toContain('Do not create or edit files with cat')
      expect(prompt).not.toContain('TOOL SELECTION CONSTRAINT')
      expect(prompt).not.toContain('no dedicated tool')
      expect(prompt).not.toContain('Do not use Python to read or write files')
      expect(prompt).not.toContain('After any file mutation performed by a command')
      expect(prompt).not.toContain('Never skip the check.')
      expect(prompt).not.toContain('apply_patch')
      expect(prompt).toContain('Always quote file paths that contain spaces')
      expect(prompt).toContain('Communication: Output text directly')
    }
  })
})

describe('Bash prompt git section', () => {
  test('ships the trimmed bullet form, not the long inline manual', () => {
    for (const provider of ['anthropic', 'openai'] as const) {
      const prompt = getBashPrompt(provider)

      expect(prompt).toContain('# Git\n')
      expect(prompt).toContain(
        'NEVER skip hooks (--no-verify, --no-gpg-sign) unless explicitly asked',
      )
      expect(prompt).toContain(
        'A failed pre-commit hook means the commit did NOT happen',
      )
      expect(prompt).toContain(
        'NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D)',
      )
      expect(prompt).toContain(
        'Prefer staging specific named paths over `git add -A`',
      )
      expect(prompt).toContain(
        'Interactive git flags (-i, e.g. git rebase -i, git add -i) are not supported',
      )
      expect(prompt).toContain('Use the `gh` CLI for GitHub work')

      expect(prompt).not.toContain('Git Safety Protocol')
      expect(prompt).not.toContain('# Creating pull requests')
      expect(prompt).not.toContain('# Committing changes with git')
      expect(prompt).not.toContain('gh pr create')
      expect(prompt).not.toContain('HEREDOC')
    }
  })
})
