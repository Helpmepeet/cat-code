import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'
import { ShellError } from '../../utils/errors.js'
import { BashTool } from './BashTool.js'

// The whole engine path for one Bash call: BashTool.call → Shell.exec →
// bashProvider (real snapshot, real marker) → ExecResult.exitAttribution →
// interpretCommandResult → a ShellError, which the tool runner turns into an
// is_error tool_result, or a normal result. Config state is isolated so the
// snapshot lands in a temp dir, and an agentId keeps `cd` in a command from
// moving this process's cwd.

let work: string
let configDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'bash-exit-attr-'))
  configDir = mkdtempSync(join(tmpdir(), 'bash-exit-attr-config-'))
  writeFileSync(join(work, 'file.txt'), 'hello\n')
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(work, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
})

function context(): ToolUseContext {
  let state = getDefaultAppState()
  return {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (update: (prev: typeof state) => typeof state) => {
      state = update(state)
    },
    agentId: asAgentId('exit-attribution-test'),
    toolUseId: 'toolu_exit_attribution',
  } as unknown as ToolUseContext
}

async function runBash(command: string) {
  try {
    const result = await BashTool.call(
      { command, description: 'exit attribution test' },
      context(),
    )
    return { failed: false as const, data: result.data }
  } catch (error) {
    if (error instanceof ShellError) return { failed: true as const, code: error.code }
    throw error
  }
}

const file = () => join(work, 'file.txt')

describe('Bash exit attribution through the engine', () => {
  test('cd fails, grep never runs: the call fails', async () => {
    const result = await runBash(`cd /does-not-exist && grep hello ${file()}`)
    expect(result).toEqual({ failed: true, code: 1 })
  })

  test('false && grep: the call fails', async () => {
    expect(await runBash(`false && grep hello ${file()}`)).toEqual({
      failed: true,
      code: 1,
    })
  })

  test('true && grep with no match: a no-match result, not a failure', async () => {
    const result = await runBash(`true && grep missing ${file()}`)
    expect(result.failed).toBe(false)
    expect(result.failed === false && result.data.returnCodeInterpretation).toBe(
      'No matches found',
    )
  })

  test('the reported compound command with no listener is not a failure', async () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    const port = server.port
    server.stop(true)
    const result = await runBash(
      `ls -la ${work} && git --version && lsof -nP -iTCP:${port} -sTCP:LISTEN`,
    )
    expect(result.failed).toBe(false)
    expect(result.failed === false && result.data.stdout).toContain('file.txt')
  })

  test('no evidence file outlives a call', async () => {
    await runBash(`true && grep missing ${file()}`)
    await runBash(`false && grep missing ${file()}`)
    const leftovers = readdirSync(tmpdir()).filter(name => /^claude-.*-exit-/.test(name))
    expect(leftovers).toEqual([])
  })
})
