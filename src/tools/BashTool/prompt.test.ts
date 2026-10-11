import { describe, expect, test } from 'bun:test'
import { shouldRegisterForegroundShellTask } from '../../tasks/LocalShellTask/guards.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { FileEditTool } from '../FileEditTool/FileEditTool.js'
import { BashTool } from './BashTool.js'
import { getBashPrompt } from './prompt.js'
import { setManagedSessionPolicy } from '../../utils/managedSessionPolicy.js'

test('managed chat Bash guidance inspects changes without requiring Git', () => {
  setManagedSessionPolicy({
    workingDirectory: '/tmp/managed-bash',
    temporaryDirectory: '/tmp/managed-bash/tmp',
    storageRootId: '22222222-2222-4222-8222-222222222222',
    storageId: '11111111-1111-4111-8111-111111111111',
  })
  try {
    const prompt = getBashPrompt('openai')
    expect(prompt).toContain('inspect the changed files before moving on')
    expect(prompt).toContain('When working in a Git repository, use git diff')
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

describe('Bash prompt diff-check tool naming', () => {
  // The registry swaps Edit for apply_patch on the OpenAI path
  // (getProviderFileEditTool, src/tools.ts), so naming Edit there points GPT at
  // a tool it was never given.
  test('names the shipped GPT editor in the diff check', () => {
    const gpt = getBashPrompt('openai')
    expect(gpt).toContain('rather than by apply_patch, Write, or NotebookEdit')
    expect(gpt).not.toContain('rather than by Edit, Write, or NotebookEdit')

    const claude = getBashPrompt('firstParty')
    expect(claude).toContain('Communication: Output text directly (NOT echo/printf)')
    expect(claude).not.toContain('apply_patch')
  })

  test('the shipped tool pool outranks the request provider', () => {
    // getProviderFileEditTool picks by SESSION provider while this prompt
    // renders per REQUEST provider, so a gpt-* worker inside an Anthropic
    // session used to be told to use apply_patch while Edit shipped.
    const gptRequestWithEditShipped = getBashPrompt(
      'openai',
      new Set(['Bash', 'Edit']),
    )
    expect(gptRequestWithEditShipped).toContain('rather than by Edit, Write, or NotebookEdit')
    expect(gptRequestWithEditShipped).not.toContain('rather than by apply_patch, Write, or NotebookEdit')

    const gptRequestWithPatchShipped = getBashPrompt(
      'openai',
      new Set(['Bash', 'apply_patch']),
    )
    expect(gptRequestWithPatchShipped).toContain(
      'rather than by apply_patch, Write, or NotebookEdit',
    )

    // No edit tool in the pool at all: fall back to the provider.
    expect(getBashPrompt('openai', new Set(['Bash']))).toContain(
      'rather than by apply_patch, Write, or NotebookEdit',
    )
  })

  test('BashTool.prompt hands the real tool pool to getBashPrompt', async () => {
    const prompt = await BashTool.prompt({
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [BashTool, FileEditTool],
      agents: [],
      provider: 'openai',
    })

    expect(prompt).toContain('rather than by Edit, Write, or NotebookEdit')
  })
})

describe('Bash prompt file-mutation policy', () => {
  test('the GPT branch retains scripting discipline and the diff check', () => {
    const prompt = getBashPrompt('openai')

    expect(prompt).toContain(
      'Do not use Python to read or write files when a simple shell command or apply_patch is enough.',
    )
    expect(prompt).toContain(
      'After any file mutation performed by a command rather than by apply_patch, Write, or NotebookEdit',
    )
    expect(prompt).toContain('show the resulting git diff before moving on')
    expect(prompt).toContain(
      'show git diff --stat and git status --short instead',
    )
    expect(prompt).toContain('Never skip the check.')

    expect(prompt).not.toContain('TOOL SELECTION CONSTRAINT')
    expect(prompt).not.toContain('no dedicated tool')
  })

  test('both providers omit dedicated-tool restrictions while retaining command guidance', () => {
    for (const provider of ['openai', 'firstParty'] as const) {
      const prompt = getBashPrompt(provider)
      expect(prompt).not.toContain('Avoid using this tool to run')
      expect(prompt).not.toContain('verified that a dedicated tool cannot accomplish')
      expect(prompt).not.toContain('stays the default for whole-file reads')
      expect(prompt).not.toContain('Use apply_patch for local file edits')
      expect(prompt).not.toContain('Do not create or edit files with cat')
      expect(prompt).toContain('Always quote file paths that contain spaces')
      expect(prompt).toContain('Communication: Output text directly')
    }
    expect(getBashPrompt('firstParty')).not.toContain('Never skip the check.')
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
