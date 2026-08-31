import { join } from 'path'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { BashTool } from '../../tools/BashTool/BashTool.js'
import { FileWriteTool } from '../../tools/FileWriteTool/FileWriteTool.js'
import { getCwd } from '../cwd.js'
import { _resetForTesting } from './autoModeState.js'
import { hasPermissionsToUseTool } from './permissions.js'

// Auto mode is process-global state. Left active by another suite it routes
// plan mode into the classifier's acceptEdits fast path, which allows in-cwd
// writes for reasons that have nothing to do with the checks under test.
beforeEach(() => {
  _resetForTesting()
})

function permissionContext(
  overrides: Partial<ToolPermissionContext>,
): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...overrides,
  }
}

function toolUseContext(tpc: ToolPermissionContext): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: tpc }),
    setAppState: () => {},
    options: { tools: [] },
    messages: [],
  } as unknown as ToolUseContext
}

async function decide(
  tool: unknown,
  input: { [key: string]: unknown },
  tpc: ToolPermissionContext,
) {
  return await hasPermissionsToUseTool(
    tool as never,
    input,
    toolUseContext(tpc),
    {} as never,
    'test-tool-use-id',
  )
}

describe('hasPermissionsToUseTool plan mode bypass', () => {
  // Step 2a used to read isBypassPermissionsModeAvailable — a capability
  // answer computed from the Statsig gate plus settings — as if it recorded
  // that plan mode was entered from bypassPermissions. On any install where
  // bypass is simply permitted (the common case) that auto-allowed every
  // write in plan mode.
  test('plan entered from default mode still asks for a write', async () => {
    const decision = await decide(
      FileWriteTool,
      { file_path: join(getCwd(), 'cat-code-plan-mode-write.ts'), content: 'x' },
      permissionContext({
        mode: 'plan',
        prePlanMode: 'default',
        isBypassPermissionsModeAvailable: true,
      }),
    )
    expect(decision.behavior).toBe('ask')
  })

  test('plan entered from bypassPermissions still bypasses', async () => {
    const decision = await decide(
      FileWriteTool,
      { file_path: join(getCwd(), 'cat-code-plan-mode-write.ts'), content: 'x' },
      permissionContext({
        mode: 'plan',
        prePlanMode: 'bypassPermissions',
        isBypassPermissionsModeAvailable: true,
      }),
    )
    expect(decision.behavior).toBe('allow')
    expect(decision.decisionReason).toEqual({ type: 'mode', mode: 'plan' })
  })
})

describe('hasPermissionsToUseTool tool-wide ask vs content deny', () => {
  // A tool-wide ask rule used to return before step 1c ran
  // tool.checkPermissions, so a narrower deny rule was never evaluated and
  // the user was prompted for — and could approve — a denied command.
  test('a content deny rule beats a tool-wide ask rule', async () => {
    const decision = await decide(
      BashTool,
      { command: 'curl example.com' },
      permissionContext({
        alwaysAskRules: { session: ['Bash'] },
        alwaysDenyRules: { session: ['Bash(curl:*)'] },
      }),
    )
    expect(decision.behavior).toBe('deny')
  })

  test('a tool-wide ask rule still asks when nothing denies', async () => {
    const decision = await decide(
      BashTool,
      { command: 'echo hi' },
      permissionContext({
        alwaysAskRules: { session: ['Bash'] },
      }),
    )
    expect(decision.behavior).toBe('ask')
    expect(decision.decisionReason?.type).toBe('rule')
  })
})
