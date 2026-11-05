import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ToolUseContext } from '../../Tool.js'
import { toRelativePath } from '../../utils/path.js'
import { runWithCwdOverride } from '../../utils/cwd.js'

// Initialize the tool registry before loading tools whose UI shares renderers.
await import('../../tools.js')
const { GrepTool } = await import('./GrepTool.js')

let directory: string
const permissions = {
  additionalWorkingDirectories: new Map<string, string>(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
}
const context = {
  abortController: new AbortController(),
  getAppState: () => ({
    toolPermissionContext: permissions,
  }),
} as unknown as ToolUseContext

beforeAll(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'grep-count-test-')))
  permissions.additionalWorkingDirectories.set(directory, directory)
  writeFileSync(join(directory, 'first.txt'), 'needle needle\nneedle\nother\n')
  writeFileSync(join(directory, 'second.txt'), 'needle\nother\n')
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

async function count(path: string, pagination = {}) {
  return GrepTool.call(
    { pattern: 'needle', path, output_mode: 'count', ...pagination },
    context,
    undefined as never,
    {} as never,
  )
}

describe('Grep count mode with real ripgrep', () => {
  test('single-file counts retain filenames and count matching lines, not occurrences', async () => {
    const path = join(directory, 'first.txt')
    const { data } = await count(path)
    expect(data.content).toBe(`${toRelativePath(path)}:2`)
    expect(data.numMatches).toBe(2)
    expect(data.numFiles).toBe(1)
    const result = GrepTool.mapToolResultToToolResultBlockParam(data, 'count-test')
    expect(result.content).toBe(
      `${toRelativePath(path)}:2\n\nFound 2 total occurrences across 1 file.`,
    )
  })

  test('directory counts retain per-file formatting and totals', async () => {
    const { data } = await count(directory)
    expect(data.content?.split('\n').sort()).toEqual([
      `${toRelativePath(join(directory, 'first.txt'))}:2`,
      `${toRelativePath(join(directory, 'second.txt'))}:1`,
    ].sort())
    expect(data.numMatches).toBe(3)
    expect(data.numFiles).toBe(2)
  })

  test('pagination totals include only displayed count entries', async () => {
    const { data } = await count(directory, { head_limit: 1, offset: 1 })
    expect(data.content?.split('\n')).toHaveLength(1)
    expect(data.numMatches).toBe(Number(data.content?.split(':').at(-1)))
    expect(data.numFiles).toBe(1)
    expect(data.appliedOffset).toBe(1)
  })

  test('single-file searches without matches keep zero totals', async () => {
    const { data } = await GrepTool.call(
      { pattern: 'absent', path: join(directory, 'first.txt'), output_mode: 'count' },
      context,
      undefined as never,
      {} as never,
    )
    expect(data.content).toBe('')
    expect(data.numMatches).toBe(0)
    expect(data.numFiles).toBe(0)
  })
})

describe('missing search targets', () => {
  test.each(['content', 'files_with_matches', 'count'] as const)(
    '%s returns a normal not-found result with suggestions, without searching them',
    async output_mode => {
      const workspace = join(directory, output_mode)
      mkdirSync(join(workspace, 'app/main'), { recursive: true })
      mkdirSync(join(workspace, 'app/shared'), { recursive: true })
      const candidate = join(workspace, 'app/shared/operationalLog.ts')
      writeFileSync(candidate, 'needle SECRET CONTENT')
      await runWithCwdOverride(workspace, async () => {
        const missing = join(workspace, 'app/main/operationalLog.ts')
        const { data } = await GrepTool.call(
          { pattern: 'needle', path: missing, output_mode },
          context, undefined as never, {} as never,
        )
        expect(data.missingPath).toBe(missing)
        expect(data.suggestions).toEqual([candidate])
        expect(data.filenames).toEqual([])
        expect(data.content).toBeUndefined()
        expect(GrepTool.outputSchema.safeParse(data).success).toBe(true)
        const result = GrepTool.mapToolResultToToolResultBlockParam(data, 'missing')
        expect(result.is_error).not.toBe(true)
        expect(result.content).toContain('No search was performed.')
        expect(result.content).toContain(candidate)
        expect(result.content).not.toContain('SECRET CONTENT')
        expect(result.content).not.toContain('<tool_use_error>')
      })
    },
  )

  test('not-found results without suggestions remain distinct from no matches', async () => {
    const missing = join(directory, 'missing-directory/absent.txt')
    const { data } = await count(missing)
    expect(data.missingPath).toBe(missing)
    expect(data.suggestions).toEqual([])
    const result = GrepTool.mapToolResultToToolResultBlockParam(data, 'missing')
    expect(result.content).toContain('not found')
    expect(result.content).not.toContain('No matches found')
  })
})
