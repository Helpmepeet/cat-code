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

function toolUseContext(): ToolUseContext {
  const toolPermissionContext: ToolPermissionContext = {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
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

async function decide(command: string) {
  return await bashToolHasPermission({ command }, toolUseContext())
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
