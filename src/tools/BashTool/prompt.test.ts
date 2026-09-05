import { describe, expect, test } from 'bun:test'
import { shouldRegisterForegroundShellTask } from '../../tasks/LocalShellTask/guards.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { FileEditTool } from '../FileEditTool/FileEditTool.js'
import { BashTool } from './BashTool.js'
import { getBashPrompt } from './prompt.js'

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

describe('Bash prompt edit-tool naming', () => {
  // The registry swaps Edit for Apply_patch on the OpenAI path
  // (getProviderFileEditTool, src/tools.ts), so naming Edit there points GPT at
  // a tool it was never given.
  test('names the edit tool the provider actually ships', () => {
    const gpt = getBashPrompt('openai')
    expect(gpt).toContain('Edit files: Use Apply_patch')
    expect(gpt).not.toContain('Edit files: Use Edit')

    const claude = getBashPrompt('firstParty')
    expect(claude).toContain('Edit files: Use Edit (NOT sed/awk)')
    expect(claude).not.toContain('Apply_patch')
  })

  test('the shipped tool pool outranks the request provider', () => {
    // getProviderFileEditTool picks by SESSION provider while this prompt
    // renders per REQUEST provider, so a gpt-* worker inside an Anthropic
    // session used to be told to use Apply_patch while Edit shipped.
    const gptRequestWithEditShipped = getBashPrompt(
      'openai',
      new Set(['Bash', 'Edit']),
    )
    expect(gptRequestWithEditShipped).toContain('Edit files: Use Edit')
    expect(gptRequestWithEditShipped).not.toContain('Edit files: Use Apply_patch')

    const claudeRequestWithPatchShipped = getBashPrompt(
      'firstParty',
      new Set(['Bash', 'Apply_patch']),
    )
    expect(claudeRequestWithPatchShipped).toContain(
      'Edit files: Use Apply_patch',
    )

    // No edit tool in the pool at all: fall back to the provider.
    expect(getBashPrompt('openai', new Set(['Bash']))).toContain(
      'Edit files: Use Apply_patch',
    )
  })

  test('BashTool.prompt hands the real tool pool to getBashPrompt', async () => {
    const prompt = await BashTool.prompt({
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [BashTool, FileEditTool],
      agents: [],
      provider: 'openai',
    })

    expect(prompt).toContain('Edit files: Use Edit')
  })
})

describe('Bash prompt file-mutation policy', () => {
  test('the GPT branch carries the hybrid rule and the diff check', () => {
    const prompt = getBashPrompt('openai')

    expect(prompt).toContain('Use Apply_patch for local file edits.')
    expect(prompt).toContain(
      'Do not create or edit files with cat, heredocs, or other shell write tricks.',
    )
    expect(prompt).toContain(
      'Formatting commands and bulk mechanical rewrites do not need Apply_patch.',
    )
    expect(prompt).toContain(
      'After any file mutation performed by a command rather than by Apply_patch, Write, or NotebookEdit',
    )
    expect(prompt).toContain('show the resulting git diff before moving on')
    expect(prompt).toContain(
      'show git diff --stat and git status --short instead',
    )
    expect(prompt).toContain('Never skip the check.')

    expect(prompt).not.toContain('TOOL SELECTION CONSTRAINT')
    expect(prompt).not.toContain('no dedicated tool')
  })

  test('the GPT branch allows targeted shell reads and search', () => {
    const prompt = getBashPrompt('openai')

    expect(prompt).toContain('`rg`')
    expect(prompt).toContain('`sed -n` line ranges')
    expect(prompt).toContain('`git blame`')
    expect(prompt).toContain('bounded (offset/limit) and numbered')

    expect(prompt).not.toContain('Content search: Use Grep (NOT grep or rg)')
    expect(prompt).not.toContain('Read files: Use Read (NOT cat/head/tail)')
  })

  test('the Claude branch keeps its dedicated-tool wording', () => {
    const prompt = getBashPrompt('firstParty')

    expect(prompt).toContain('IMPORTANT: Avoid using this tool to run')
    expect(prompt).toContain(
      'after you have verified that a dedicated tool cannot accomplish your task',
    )
    expect(prompt).toContain('Read files: Use Read (NOT cat/head/tail)')
    expect(prompt).toContain('Content search: Use Grep (NOT grep or rg)')
    expect(prompt).toContain('Write files: Use Write (NOT echo >/cat <<EOF)')

    expect(prompt).not.toContain('Use Apply_patch for local file edits')
    expect(prompt).not.toContain('Never skip the check.')
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
