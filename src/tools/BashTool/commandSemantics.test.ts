import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { interpretCommandResult } from './commandSemantics.js'

// BashTool merges stderr into stdout and passes '' for stderr, so every case
// here hands the semantic the merged output the same way.
const interpret = (command: string, exitCode: number, output = '') =>
  interpretCommandResult(command, exitCode, output, '')

const LSOF_QUERY = 'lsof -nP -iTCP:8001 -sTCP:LISTEN'

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
  test('exit 0 is success', () => {
    expect(interpret('echo hello', 0, 'hello')).toEqual({
      isError: false,
      message: undefined,
    })
  })

  test('an unknown command exiting 1 is an error', () => {
    expect(interpret('false', 1).isError).toBe(true)
  })

  test('grep exit 1 is no matches, exit 2 is an error', () => {
    expect(interpret('grep needle file.txt', 1)).toEqual({
      isError: false,
      message: 'No matches found',
    })
    expect(interpret('grep needle missing.txt', 2).isError).toBe(true)
  })

  describe('lsof', () => {
    test('exit 1 with no diagnostic is a no-match, not a failure', () => {
      expect(interpret(LSOF_QUERY, 1, '')).toEqual({
        isError: false,
        message: 'No matching open files',
      })
    })

    test('exit 1 with an lsof diagnostic stays an error', () => {
      expect(
        interpret('lsof -nP -iTCP:8001 -sTCP:NOTASTATE', 1, LSOF_BAD_STATE_OUTPUT)
          .isError,
      ).toBe(true)
      expect(
        interpret('lsof -u nosuchuser', 1, "lsof: can't get UID for nosuchuser")
          .isError,
      ).toBe(true)
    })

    test('a diagnostic passed as separate stderr is still seen', () => {
      expect(
        interpretCommandResult(LSOF_QUERY, 1, '', 'lsof: illegal option character: -')
          .isError,
      ).toBe(true)
    })

    test('exit codes other than 0 and 1 keep default semantics', () => {
      expect(interpret(LSOF_QUERY, 0, 'COMMAND PID ...').isError).toBe(false)
      expect(interpret(LSOF_QUERY, 127, 'lsof: command not found').isError).toBe(
        true,
      )
      expect(interpret(LSOF_QUERY, 137).isError).toBe(true)
    })

    test('the reported compound command with no listener is not a failure', () => {
      expect(
        interpret(
          `ls -la && git status -sb && ${LSOF_QUERY}`,
          1,
          LS_AND_GIT_OUTPUT,
        ),
      ).toEqual({ isError: false, message: 'No matching open files' })
    })

    test('the same compound command with a bad lsof argument stays an error', () => {
      expect(
        interpret(
          'ls -la && git status -sb && lsof -nP -iTCP:8001 -sTCP:NOTASTATE',
          1,
          `${LS_AND_GIT_OUTPUT}\n${LSOF_BAD_STATE_OUTPUT}`,
        ).isError,
      ).toBe(true)
    })

    test('lsof piped into another command is judged by the last command', () => {
      expect(interpret(`${LSOF_QUERY} | wc -l`, 1).isError).toBe(true)
      expect(interpret(`${LSOF_QUERY} | grep node`, 1).isError).toBe(false)
    })
  })
})

// Runs the platform's real lsof so the fixtures above cannot drift from what
// the binary actually does. Output is merged the way BashTool merges it.
const LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof', '/bin/lsof'].find(existsSync)

describe.skipIf(LSOF === undefined)('lsof on this platform', () => {
  const run = (args: string) => {
    const command = `lsof ${args}`
    const proc = spawnSync('/bin/sh', ['-c', `${LSOF} ${args} 2>&1`], {
      encoding: 'utf8',
    })
    return interpret(command, proc.status ?? -1, proc.stdout)
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
