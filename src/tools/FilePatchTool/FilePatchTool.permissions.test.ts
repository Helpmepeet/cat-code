import { join } from 'path'
import { describe, expect, test } from 'bun:test'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { expandPath } from '../../utils/path.js'
import { FilePatchTool } from './FilePatchTool.js'

// Regression coverage for the F1/M1 permission-boundary defect: getPath must
// resolve the real target from every input shape it can receive, or the shared
// write-permission helper keys its checks to cwd and acceptEdits (plus the
// auto-mode acceptEdits fast path) silently auto-allows a patch to any path.
// See docs/reports/2026-07-12-apply-patch-tool-review.md.

function permissionContext(
  mode: ToolPermissionContext['mode'],
): ToolPermissionContext {
  return {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: true,
  }
}

function toolUseContext(tpc: ToolPermissionContext): ToolUseContext {
  return {
    getAppState: () => ({ toolPermissionContext: tpc }),
  } as unknown as ToolUseContext
}

describe('FilePatchTool.getPath', () => {
  test('resolves the synthetic { file_path } shape checkPermissions builds', () => {
    // Before the fix this returned '' → expandPath('') → cwd.
    expect(
      FilePatchTool.getPath({ file_path: '/abs/target.ts' } as never),
    ).toBe(expandPath('/abs/target.ts'))
  })

  test('resolves the raw { input: envelope } arm the GPT path emits', () => {
    const envelope =
      '*** Begin Patch\n*** Update File: rel/target.ts\n@@\n-old\n+new\n*** End Patch'
    expect(FilePatchTool.getPath({ input: envelope } as never)).toBe(
      expandPath('rel/target.ts'),
    )
  })

  test('resolves the structured { ops } arm', () => {
    expect(
      FilePatchTool.getPath({
        ops: [{ type: 'delete', path: 'rel/gone.ts' }],
      } as never),
    ).toBe(expandPath('rel/gone.ts'))
  })

  test('returns empty string for an unparseable envelope (fails closed, not cwd)', () => {
    expect(FilePatchTool.getPath({ input: 'not a patch' } as never)).toBe('')
  })
})

describe('FilePatchTool.checkPermissions boundary', () => {
  test('acceptEdits does NOT auto-allow a patch to a path outside working dirs', async () => {
    const outside = '/tmp/cat-code-fp-permtest-outside/target.ts'
    const decision = await FilePatchTool.checkPermissions(
      { ops: [{ type: 'delete', path: outside }] } as never,
      toolUseContext(permissionContext('acceptEdits')),
    )
    expect(decision.behavior).not.toBe('allow')
  })

  test('acceptEdits still allows a patch to a path inside the working dir', async () => {
    const inside = join(getCwd(), 'cat-code-fp-permtest-inside.ts')
    const decision = await FilePatchTool.checkPermissions(
      { ops: [{ type: 'delete', path: inside }] } as never,
      toolUseContext(permissionContext('acceptEdits')),
    )
    expect(decision.behavior).toBe('allow')
  })
})
