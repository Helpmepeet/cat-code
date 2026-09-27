import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import type { CommandAttribution } from '../../utils/bash/exitAttribution.js'
import { interpretCommandResult } from './commandSemantics.js'

// The attribution the shell proves when `name` started and owns the final
// status; the overrides model each way that proof can be missing.
const started = (
  name: string,
  overrides: Partial<CommandAttribution> = {},
): CommandAttribution => ({
  semanticCommand: name,
  semanticCommandStarted: true,
  pipelineHasMultipleCommands: false,
  pipefailEnabled: false,
  ...overrides,
})

// BashTool merges stderr into stdout and passes '' for stderr, so every case
// here hands the semantic the merged output the same way.
const interpret = (
  exitCode: number,
  output: string,
  attribution: CommandAttribution | null,
) => interpretCommandResult(exitCode, output, '', attribution)

// Captured from lsof 4.91 on macOS: a bad argument exits 1, the same code as a
// clean no-match, and differs only by the `lsof: ` diagnostic.
const LSOF_BAD_STATE_OUTPUT = [
  'lsof: unknown TCP state name: NOTASTATE',
  'lsof 4.91',
  ' latest revision: ftp://lsof.itap.purdue.edu/pub/tools/unix/lsof/',
  ' usage: [-?abhlnNoOPRtUvVX] [+|-c c] [+|-d s] [+D D] [+|-E] [+|-e s] [+|-f[gG]]',
].join('\n')

const LS_AND_GIT_OUTPUT = [
  'total 64',
  'drwxr-xr-x   8 pt  staff   256 Sep 27 10:00 .',
  '-rw-r--r--   1 pt  staff  1024 Sep 27 10:00 README.md',
  '-rw-r--r--   1 pt  staff  2048 Sep 27 10:00 main.py',
  'drwxr-xr-x   4 pt  staff   128 Sep 27 10:00 tests',
  '## main...origin/main',
].join('\n')

describe('interpretCommandResult', () => {
  test('exit 0 is success with or without attribution', () => {
    expect(interpret(0, 'hello', null)).toEqual({
      isError: false,
      message: undefined,
    })
    expect(interpret(0, '', started('grep')).isError).toBe(false)
  })

  test('a command without its own rule exiting 1 is an error', () => {
    expect(interpret(1, '', started('false')).isError).toBe(true)
  })

  test('grep exit 1 is no matches, exit 2 is an error', () => {
    expect(interpret(1, '', started('grep'))).toEqual({
      isError: false,
      message: 'No matches found',
    })
    expect(interpret(2, '', started('grep')).isError).toBe(true)
  })

  describe('a rule applies only when attribution proves it', () => {
    test('no attribution means the default rule', () => {
      expect(interpret(1, '', null).isError).toBe(true)
    })

    test('the command never started: cd failed before grep', () => {
      expect(
        interpret(
          1,
          'cd: no such file or directory: /does-not-exist',
          started('grep', { semanticCommandStarted: false }),
        ).isError,
      ).toBe(true)
    })

    test('pipefail makes an earlier pipeline stage the possible owner', () => {
      const multi = { pipelineHasMultipleCommands: true }
      expect(
        interpret(1, '', started('grep', { ...multi, pipefailEnabled: true }))
          .isError,
      ).toBe(true)
      expect(
        interpret(1, '', started('grep', { ...multi, pipefailEnabled: false }))
          .isError,
      ).toBe(false)
    })
  })

  describe('lsof', () => {
    test('exit 1 with no diagnostic is a no-match, not a failure', () => {
      expect(interpret(1, '', started('lsof'))).toEqual({
        isError: false,
        message: 'No matching open files',
      })
    })

    test('exit 1 with an lsof diagnostic stays an error', () => {
      expect(interpret(1, LSOF_BAD_STATE_OUTPUT, started('lsof')).isError).toBe(
        true,
      )
      expect(
        interpret(1, "lsof: can't get UID for nosuchuser", started('lsof'))
          .isError,
      ).toBe(true)
    })

    test('a diagnostic passed as separate stderr is still seen', () => {
      expect(
        interpretCommandResult(
          1,
          '',
          'lsof: illegal option character: -',
          started('lsof'),
        ).isError,
      ).toBe(true)
    })

    test('exit codes other than 0 and 1 keep default semantics', () => {
      expect(interpret(0, 'COMMAND PID ...', started('lsof')).isError).toBe(false)
      expect(interpret(127, 'lsof: command not found', started('lsof')).isError).toBe(
        true,
      )
      expect(interpret(137, '', started('lsof')).isError).toBe(true)
    })

    test('earlier compound output does not hide a no-match', () => {
      expect(interpret(1, LS_AND_GIT_OUTPUT, started('lsof'))).toEqual({
        isError: false,
        message: 'No matching open files',
      })
    })

    test('earlier compound output does not hide a bad lsof argument', () => {
      expect(
        interpret(
          1,
          `${LS_AND_GIT_OUTPUT}\n${LSOF_BAD_STATE_OUTPUT}`,
          started('lsof'),
        ).isError,
      ).toBe(true)
    })
  })
})

// Runs the platform's real lsof so the fixtures above cannot drift from what
// the binary actually does. Output is merged the way BashTool merges it.
const LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof', '/bin/lsof'].find(existsSync)

describe.skipIf(LSOF === undefined)('lsof on this platform', () => {
  const run = (args: string) => {
    const proc = spawnSync('/bin/sh', ['-c', `${LSOF} ${args} 2>&1`], {
      encoding: 'utf8',
    })
    return interpret(proc.status ?? -1, proc.stdout, started('lsof'))
  }

  const closedPort = async () => {
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data() {} },
    })
    const port = server.port
    server.stop(true)
    return port
  }

  test('a port with no listener is a no-match', async () => {
    const port = await closedPort()
    expect(run(`-nP -iTCP:${port} -sTCP:LISTEN`)).toEqual({
      isError: false,
      message: 'No matching open files',
    })
  })

  test('an invalid TCP state name is an error', () => {
    expect(run('-nP -iTCP:8001 -sTCP:NOTASTATE').isError).toBe(true)
  })

  test('an illegal option is an error', () => {
    expect(run('--bogus').isError).toBe(true)
  })
})
