import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import {
  ensureParserInitialized,
  getParserModule,
} from '../../utils/bash/bashParser.js'
import * as actualParser from '../../utils/bash/parser.js'
import { bashToolHasPermission } from './bashPermissions.js'

// parseCommandRaw is gated on feature('TREE_SITTER_BASH'), which compiles to
// false outside a built binary — under `bun test` every command would take the
// legacy shell-quote path and none of the AST decisions below would run. The
// shipped dev-full bundle compiles the flag in, so swap in the REAL tree-sitter
// parser (loaded directly, gate bypassed) to exercise the path that actually
// ships. Nothing else is stubbed.
beforeEach(async () => {
  await ensureParserInitialized()
  const parserModule = getParserModule()
  if (!parserModule) {
    throw new Error('tree-sitter bash parser failed to load')
  }
  await mock.module('src/utils/bash/parser.js', () => ({
    ...actualParser,
    parseCommandRaw: async (command: string) =>
      command ? parserModule.parse(command) : null,
  }))
})

function toolUseContext(allowRules: string[] = []): ToolUseContext {
  const toolPermissionContext: ToolPermissionContext = {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: allowRules.length > 0 ? { localSettings: allowRules } : {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  }
  return {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext }),
    setAppState: () => {},
    options: { tools: [] },
    messages: [],
  } as unknown as ToolUseContext
}

async function decide(command: string, allowRules: string[] = []) {
  return await bashToolHasPermission({ command }, toolUseContext(allowRules))
}

// A command made only of assignments parses to zero commands. Both
// `.every(...)` allow-checks in bashToolHasPermission were then vacuously
// true and the injection re-check iterated the same empty array, so the
// command was allowed because nothing had been examined. That is correct for
// `FOO=bar` and catastrophic for a variable bash arithmetically evaluates:
// assigning to an integer-attributed name resolves bare identifiers and
// expands array subscripts, which runs command substitution. Verified live:
// `x='a[$(echo PWNED >&2)]'; OPTIND=x` prints PWNED under /bin/bash.
describe('bashToolHasPermission assignment-only commands', () => {
  test('a plain assignment is allowed with no prompt', async () => {
    const decision = await decide('FOO=bar')
    expect(decision.behavior).toBe('allow')
  })

  test('a plain assignment chained to a command is still allowed', async () => {
    const decision = await decide('FOO=bar && echo hi')
    expect(decision.behavior).toBe('allow')
  })

  test('assigning a bare identifier to an integer variable asks', async () => {
    // The bypass: no `$(` appears in the assignment that evaluates, so the
    // command_substitution walk never sees the payload.
    const decision = await decide("x='a[$(echo PWNED)]' && OPTIND=x")
    expect(decision.behavior).toBe('ask')
  })

  test('assigning an arithmetic expression to an integer variable asks', async () => {
    const decision = await decide('RANDOM=2+2')
    expect(decision.behavior).toBe('ask')
  })

  test('resetting getopts with an integer literal is still allowed', async () => {
    // The one RHS with nothing left to resolve. This is the case the fix must
    // not break, and the reason it is a value check rather than a name ban.
    const decision = await decide('OPTIND=1')
    expect(decision.behavior).toBe('allow')
  })

  test('an integer variable as a for-loop variable asks', async () => {
    // for_statement assigns the loop var directly, bypassing
    // walkVariableAssignment. Verified live: this prints under /bin/bash.
    const decision = await decide("for OPTIND in 'a[$(echo PWNED)]'; do :; done")
    expect(decision.behavior).toBe('ask')
  })
})

// The sibling of the above, with the damage one command later instead of in
// the assignment itself. A statement-level assignment is not pushed as a
// subcommand, so `PATH=/tmp/evil && git status` was permission-checked as a
// bare `git status`: the allow rule matched and `git` ran resolved out of an
// attacker-chosen directory, with no prompt. The env-PREFIX form
// (`PATH=/tmp/evil git status`) was already caught, which is what made the
// gap easy to miss. No cross-call shell persistence is needed — the hijack
// lands inside the single invocation.
describe('bashToolHasPermission lookup-altering assignments', () => {
  const ALLOW_GIT_STATUS = ['Bash(git status)']

  test('the allow rule alone still allows the bare command', async () => {
    // Baseline: every case below differs from this one only by the
    // assignment, so an `ask` there is the assignment being seen.
    const decision = await decide('git status', ALLOW_GIT_STATUS)
    expect(decision.behavior).toBe('allow')
  })

  test('PATH before && asks instead of riding the allow rule', async () => {
    const decision = await decide(
      'PATH=/tmp/evil && git status',
      ALLOW_GIT_STATUS,
    )
    expect(decision.behavior).toBe('ask')
  })

  test('leading whitespace does not hide a PATH assignment', async () => {
    const decision = await decide(
      '  PATH=/tmp/evil && git status',
      ALLOW_GIT_STATUS,
    )
    expect(decision.behavior).toBe('ask')
  })

  test('a lookup-altering assignment after ; asks', async () => {
    // `;` and `&&` are different separator tokens reaching the same branch.
    const decision = await decide('PATH=/tmp/evil; git status', ALLOW_GIT_STATUS)
    expect(decision.behavior).toBe('ask')
  })

  test('LD_PRELOAD before && asks', async () => {
    // Prefix family, not a listed name: the binary is the real one, the
    // attacker's code runs inside it.
    const decision = await decide(
      'LD_PRELOAD=/tmp/x.so && git status',
      ALLOW_GIT_STATUS,
    )
    expect(decision.behavior).toBe('ask')
  })

  test('DYLD_INSERT_LIBRARIES before && asks', async () => {
    const decision = await decide(
      'DYLD_INSERT_LIBRARIES=/tmp/x.dylib && git status',
      ALLOW_GIT_STATUS,
    )
    expect(decision.behavior).toBe('ask')
  })

  test('BASH_ENV before && asks', async () => {
    // Not covered by BINARY_HIJACK_VARS (/^(LD_|DYLD_|PATH$)/) — the startup
    // file bash sources for the next non-interactive shell.
    const decision = await decide(
      'BASH_ENV=/tmp/x && git status',
      ALLOW_GIT_STATUS,
    )
    expect(decision.behavior).toBe('ask')
  })

  test('the lowercase zsh alias of PATH asks', async () => {
    // zsh ties lowercase `path` to $PATH, and BashTool runs under the user's
    // default shell. A case-sensitive check would miss this entirely.
    const decision = await decide(
      'path=/tmp/evil && git status',
      ALLOW_GIT_STATUS,
    )
    expect(decision.behavior).toBe('ask')
  })

  test('export of a lookup-altering variable asks', async () => {
    // A declaration builtin reaches the same hijack by a different node
    // type: `Bash(export:*)` matched the export and `Bash(git status)`
    // matched the hijacked command, so both were allowed.
    const decision = await decide('export PATH=/tmp/evil && git status', [
      ...ALLOW_GIT_STATUS,
      'Bash(export:*)',
    ])
    expect(decision.behavior).toBe('ask')
  })

  test('the quoted export form asks', async () => {
    // `export "PATH=..."` arrives as one string token, so the
    // variable_assignment case never sees the name — it must be split out.
    const decision = await decide('export "PATH=/tmp/evil" && git status', [
      ...ALLOW_GIT_STATUS,
      'Bash(export:*)',
    ])
    expect(decision.behavior).toBe('ask')
  })

  test('a lookup-altering for-loop variable asks', async () => {
    // for_statement assigns the loop var directly, bypassing
    // walkVariableAssignment — the same second site 320c795d had to patch.
    const decision = await decide(
      'for PATH in /tmp/evil; do git status; done',
      ALLOW_GIT_STATUS,
    )
    expect(decision.behavior).toBe('ask')
  })

  test('a legitimate PATH prepend asks rather than being denied', async () => {
    // `PATH=/usr/local/bin:$PATH make` is a common, honest pattern. The
    // outcome must be a prompt, not a refusal — the guard cannot tell it
    // apart from the hijack, and does not try to.
    const decision = await decide('PATH=/usr/local/bin:$PATH make', [
      'Bash(make:*)',
    ])
    expect(decision.behavior).toBe('ask')
  })

  test('an ordinary assignment before && is still allowed', async () => {
    // The whole point of the statement-level branch: FOO is read by nothing
    // that decides what runs, so it stays inert and prompt-free.
    const decision = await decide('FOO=bar && git status', ALLOW_GIT_STATUS)
    expect(decision.behavior).toBe('allow')
  })

  test('exporting an ordinary variable is still allowed', async () => {
    const decision = await decide('export FOO=bar && git status', [
      ...ALLOW_GIT_STATUS,
      'Bash(export:*)',
    ])
    expect(decision.behavior).toBe('allow')
  })

  test('an ordinary for-loop variable is still allowed', async () => {
    const decision = await decide(
      'for f in a b; do git status; done',
      ALLOW_GIT_STATUS,
    )
    expect(decision.behavior).toBe('allow')
  })
})
