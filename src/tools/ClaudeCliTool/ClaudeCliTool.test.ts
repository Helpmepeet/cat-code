import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import { mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import type { ToolUseContext } from '../../Tool.js'
import {
  ClaudeCliTool,
  _claudeCliToolInternalsForTest,
} from './ClaudeCliTool.js'

type FakeChildOptions = {
  stdout?: string
  stderr?: string
  code?: number
  autoExit?: boolean
  error?: NodeJS.ErrnoException
}

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killedWith: NodeJS.Signals | undefined
  pid = 12345

  constructor(private readonly opts: FakeChildOptions = {}) {
    super()
    if (opts.error) {
      queueMicrotask(() => this.emit('error', opts.error))
      return
    }
    if (opts.autoExit === false) return
    queueMicrotask(() => {
      if (opts.stdout) this.stdout.write(opts.stdout)
      if (opts.stderr) this.stderr.write(opts.stderr)
      this.stdout.end()
      this.stderr.end()
      this.emit('close', opts.code ?? 0, null)
    })
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal
    queueMicrotask(() => this.emit('close', null, signal ?? 'SIGTERM'))
    return true
  }
}

function buildContext({
  mode = 'default',
  isBypassPermissionsModeAvailable = false,
}: {
  mode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions'
  isBypassPermissionsModeAvailable?: boolean
} = {}): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () =>
      ({
        toolPermissionContext: {
          mode,
          isBypassPermissionsModeAvailable,
        },
      }) as never,
  } as ToolUseContext
}

afterEach(() => {
  delete process.env.CLAUDE_CLI_PATH
})

describe('ClaudeCliTool', () => {
  test('builds a claude print-mode command with model and effort', () => {
    const command = _claudeCliToolInternalsForTest.buildClaudeCliCommand({
      prompt: 'Review the auth module',
      cwd: '/tmp/project',
      model: 'sonnet',
      effort: 'high',
      max_turns: 3,
      permission_mode: 'plan',
      timeout: 12_000,
    })

    expect(command).toEqual({
      executable: 'claude',
      args: [
        '-p',
        '--output-format',
        'json',
        '--model',
        'sonnet',
        '--effort',
        'high',
        '--max-turns',
        '3',
        '--permission-mode',
        'plan',
        'Review the auth module',
      ],
      cwd: '/tmp/project',
      timeoutMs: 12_000,
    })
  })

  test('uses CLAUDE_CLI_PATH for external claude executables', () => {
    process.env.CLAUDE_CLI_PATH = '/usr/local/bin/claude'
    expect(
      _claudeCliToolInternalsForTest.buildClaudeCliCommand({
        prompt: 'hello',
      }).executable,
    ).toBe('/usr/local/bin/claude')
  })

  test('requires permission instead of using the default allow policy', async () => {
    const decision = await ClaudeCliTool.checkPermissions(
      { prompt: 'Review the auth module' },
      buildContext(),
    )

    expect(decision.behavior).toBe('passthrough')
  })

  test('validateInput rejects a configured Cat Code executable', async () => {
    process.env.CLAUDE_CLI_PATH = join(process.cwd(), 'cli-dev')

    const validation = await ClaudeCliTool.validateInput(
      { prompt: 'hello' },
      buildContext(),
    )

    expect(validation.result).toBe(false)
    expect(validation.message).toContain('external Claude CLI')
  })

  test('denies delegated bypassPermissions unless the parent mode is already trusted', async () => {
    const denied = await ClaudeCliTool.checkPermissions(
      {
        prompt: 'Do the work',
        permission_mode: 'bypassPermissions',
      },
      buildContext(),
    )

    expect(denied.behavior).toBe('deny')
    expect(denied.message).toContain('bypassPermissions')

    const trusted = await ClaudeCliTool.checkPermissions(
      {
        prompt: 'Do the work',
        permission_mode: 'bypassPermissions',
      },
      buildContext({ mode: 'bypassPermissions' }),
    )

    expect(trusted.behavior).toBe('passthrough')
  })

  test('rejects invalid effort values at the schema boundary', () => {
    const parsed = ClaudeCliTool.inputSchema.safeParse({
      prompt: 'hello',
      effort: 'extreme',
    })

    expect(parsed.success).toBe(false)
  })

  test('returns parsed json output from a successful claude cli run', async () => {
    const result = await _claudeCliToolInternalsForTest.runClaudeCliTask(
      {
        prompt: 'Summarize this repo',
        model: 'opus',
        effort: 'xhigh',
      },
      buildContext(),
      () =>
        new FakeChildProcess({
          stdout: JSON.stringify({
            type: 'result',
            subtype: 'success',
            result: 'Repository summary',
            session_id: 'session-1',
          }),
        }) as never,
    )

    expect(result).toMatchObject({
      status: 'success',
      exit_code: 0,
      stdout: expect.stringContaining('Repository summary'),
      result: 'Repository summary',
      session_id: 'session-1',
      model: 'opus',
      effort: 'xhigh',
    })
  })

  test('marks a zero-exit claude json error as failed', async () => {
    const result = await _claudeCliToolInternalsForTest.runClaudeCliTask(
      { prompt: 'Summarize this repo' },
      buildContext(),
      () =>
        new FakeChildProcess({
          stdout: JSON.stringify({
            type: 'result',
            is_error: true,
            result: 'Claude reported an error',
            session_id: 'session-1',
          }),
        }) as never,
    )

    expect(result).toMatchObject({
      status: 'failed',
      exit_code: 0,
      is_error: true,
      result: 'Claude reported an error',
    })
  })

  test('returns failed status with stderr on nonzero exit', async () => {
    const result = await _claudeCliToolInternalsForTest.runClaudeCliTask(
      { prompt: 'Do the work' },
      buildContext(),
      () =>
        new FakeChildProcess({
          stderr: 'authentication required',
          code: 1,
        }) as never,
    )

    expect(result).toMatchObject({
      status: 'failed',
      exit_code: 1,
      stderr: 'authentication required',
    })
  })

  test('surfaces a missing claude executable as structured failed output', async () => {
    const error = Object.assign(new Error('spawn claude ENOENT'), {
      code: 'ENOENT',
    })

    const result = await _claudeCliToolInternalsForTest.runClaudeCliTask(
      { prompt: 'hello' },
      buildContext(),
      () => new FakeChildProcess({ error }) as never,
    )

    expect(result.status).toBe('failed')
    expect(result.exit_code).toBeNull()
    expect(result.stderr).toContain('Claude CLI executable not found')
  })

  test('rejects a symlink to a local Cat Code binary before spawning', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'claude-cli-tool-'))
    try {
      const symlinkPath = join(tempDir, 'claude')
      await symlink(join(process.cwd(), 'cli'), symlinkPath)
      process.env.CLAUDE_CLI_PATH = symlinkPath
      let spawned = false

      const result = await _claudeCliToolInternalsForTest.runClaudeCliTask(
        { prompt: 'hello' },
        buildContext(),
        () => {
          spawned = true
          return new FakeChildProcess() as never
        },
      )

      expect(spawned).toBe(false)
      expect(result.status).toBe('failed')
      expect(result.stderr).toContain('Cat Code executable')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('returns null exit_code when aborted before the claude process starts', async () => {
    const context = buildContext()
    context.abortController.abort()
    let spawned = false

    const result = await _claudeCliToolInternalsForTest.runClaudeCliTask(
      { prompt: 'hello' },
      context,
      () => {
        spawned = true
        return new FakeChildProcess() as never
      },
    )

    expect(spawned).toBe(false)
    expect(result.status).toBe('interrupted')
    expect(result.exit_code).toBeNull()
  })

  test('kills the claude process on timeout', async () => {
    const child = new FakeChildProcess({ autoExit: false })
    const result = await _claudeCliToolInternalsForTest.runClaudeCliTask(
      { prompt: 'hello', timeout: 1 },
      buildContext(),
      () => child as never,
    )

    expect(child.killedWith).toBe('SIGKILL')
    expect(result.status).toBe('timeout')
    expect(result.stderr).toContain('timed out')
  })

  test('kills the claude process when the tool context aborts', async () => {
    const child = new FakeChildProcess({ autoExit: false })
    const context = buildContext()
    let markSpawned: () => void = () => {}
    const spawned = new Promise<void>(resolve => {
      markSpawned = resolve
    })
    const promise = _claudeCliToolInternalsForTest.runClaudeCliTask(
      { prompt: 'hello', timeout: 30_000 },
      context,
      () => {
        markSpawned()
        return child as never
      },
    )

    await spawned
    context.abortController.abort()
    const result = await promise

    expect(child.killedWith).toBe('SIGKILL')
    expect(result.status).toBe('interrupted')
  })

  test('truncates very large stdout and stderr for inline tool results', async () => {
    const longText = 'x'.repeat(60_000)
    const result = await _claudeCliToolInternalsForTest.runClaudeCliTask(
      { prompt: 'hello' },
      buildContext(),
      () =>
        new FakeChildProcess({
          stdout: longText,
          stderr: longText,
        }) as never,
    )

    expect(result.stdout.length).toBeLessThan(longText.length)
    expect(result.stderr.length).toBeLessThan(longText.length)
    expect(result.truncated).toBe(true)
  })

  test('truncates display text and activity descriptions', () => {
    const longText = 'x'.repeat(6_000)
    const displayText = _claudeCliToolInternalsForTest.formatDisplayText({
      status: 'success',
      exit_code: 0,
      stdout: '',
      stderr: '',
      result: longText,
      cwd: process.cwd(),
      elapsed_ms: 1,
      truncated: false,
    })

    expect(displayText.length).toBeLessThan(longText.length)
    expect(displayText).toContain('display truncated')

    const activity = ClaudeCliTool.getActivityDescription({
      prompt: longText,
    })

    expect(activity.length).toBeLessThan(140)
    expect(activity.endsWith('...')).toBe(true)
  })

  test('validateInput rejects a non-directory cwd', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'claude-cli-tool-cwd-'))
    try {
      const filePath = join(tempDir, 'not-a-dir')
      await writeFile(filePath, 'x')

      const validation = await ClaudeCliTool.validateInput(
        { prompt: 'hello', cwd: filePath },
        buildContext(),
      )

      expect(validation.result).toBe(false)
      expect(validation.message).toContain('not a directory')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
