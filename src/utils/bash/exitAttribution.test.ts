import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  interpretCommandResult,
  SEMANTIC_COMMAND_NAMES,
} from '../../tools/BashTool/commandSemantics.js'
import {
  buildExitMarker,
  planExitAttribution,
  readExitEvidence,
  shellStateAllowsExitMarker,
} from './exitAttribution.js'
import { quote } from './shellQuote.js'
import { quoteShellCommand } from './shellQuoting.js'

const EVIDENCE = '/tmp/claude-test-exit'
const plan = (command: string) =>
  planExitAttribution(command, SEMANTIC_COMMAND_NAMES, EVIDENCE)
// The instrumented command with the marker collapsed to `M`, so placement
// reads at a glance.
const placed = (command: string) => {
  const p = plan(command)
  if (!p) return null
  return p.instrumentedCommand.replace(buildExitMarker(EVIDENCE, p.token), 'M')
}

describe('planExitAttribution: where the marker goes', () => {
  test('after && it guards the final operand, so it runs only if that does', () => {
    expect(placed('false && grep x f')).toBe('false && M && grep x f')
    expect(placed('ls -la && git status -sb && lsof -nP -iTCP:8001 -sTCP:LISTEN')).toBe(
      'ls -la && git status -sb && M && lsof -nP -iTCP:8001 -sTCP:LISTEN',
    )
    expect(placed('false || true && grep x f')).toBe('false || true && M && grep x f')
    expect(placed('true &&\n  grep x f')).toBe('true &&\n  M && grep x f')
    expect(placed('true && grep x f # comment')).toBe('true && M && grep x f # comment')
    expect(placed('true && grep x f 2>/dev/null')).toBe('true && M && grep x f 2>/dev/null')
    expect(placed('true && ps aux | grep node')).toBe('true && M && ps aux | grep node')
    expect(placed('true && [ -f x ]')).toBe('true && M && [ -f x ]')
  })

  test('otherwise it opens the final statement, which then always reaches the command', () => {
    expect(placed('grep x f')).toBe('M; grep x f')
    expect(placed('false || grep x f')).toBe('M; false || grep x f')
    expect(placed('false ; grep x f')).toBe('false ; M; grep x f')
    expect(placed('printf foo | grep bar')).toBe('M; printf foo | grep bar')
    expect(placed('set -e; false; grep x f')).toBe('set -e; false; M; grep x f')
  })

  test('offsets are bytes, so non-ASCII text before the insertion survives', () => {
    expect(placed('grep -q é f && grep ü f')).toBe('grep -q é f && M && grep ü f')
  })

  test('the candidate and its pipeline shape are reported', () => {
    expect(plan('true && lsof -i :1')).toMatchObject({
      semanticCommand: 'lsof',
      pipelineHasMultipleCommands: false,
    })
    expect(plan('true && ps aux | grep node')).toMatchObject({
      semanticCommand: 'grep',
      pipelineHasMultipleCommands: true,
    })
  })

  test('each run gets its own token', () => {
    expect(plan('grep x f')!.token).not.toBe(plan('grep x f')!.token)
  })
})

describe('planExitAttribution: no marker, so the default rule applies', () => {
  test.each([
    ['a final command without its own rule', 'cd /missing && ls'],
    ['a final echo after grep', 'true && grep x f; echo "$?"'],
    ['a brace group', 'true && { grep x f; }'],
    ['a subshell', 'true && (grep x f)'],
    ['negation', 'true && ! grep x f'],
    ['backgrounding', 'true && grep x f &'],
    ['a heredoc', 'grep x <<EOF\nbody\nEOF'],
    ['a dynamic command name', 'true && $GREP x f'],
    ['`$?` read by a statement-start marker position', 'false; grep x f $?'],
    ['xtrace enabled by the command', 'set -x; true && grep x f'],
    ['verbose enabled by the command', 'set -v; true && grep x f'],
    ['xtrace via setopt', 'setopt xtrace; true && grep x f'],
    ['a DEBUG trap', "trap 'n=1' DEBUG; true && grep x f"],
    ['sourced code', 'source ./env.sh && grep x f'],
    ['eval', "eval 'set -x'; true && grep x f"],
    ['shopt -o', 'shopt -o xtrace; true && grep x f'],
    ['a zsh trap function', 'TRAPDEBUG() { :; }; true && grep x f'],
    ['a function shadowing the marker', 'set() { :; }; true && grep x f'],
  ])('%s', (_label, command) => {
    expect(plan(command)).toBeNull()
  })

  test('safe option changes still allow the marker', () => {
    expect(plan('set -e; true && grep x f')).not.toBeNull()
    expect(plan('set -euo pipefail; true && grep x f')).not.toBeNull()
    expect(plan('setopt pipe_fail; true && grep x f')).not.toBeNull()
  })
})

describe('shellStateAllowsExitMarker', () => {
  const clean = '# Functions\nfoo () {\n\techo hi\n}\n# Shell Options\nsetopt autocd\n'

  test('a clean snapshot with no session script allows it', () => {
    expect(shellStateAllowsExitMarker(clean, null)).toBe(true)
  })

  test.each([
    ['no snapshot (login-shell fallback)', undefined, null],
    ['zsh xtrace already on', `${clean}setopt xtrace\n`, null],
    ['bash verbose already on', `${clean}set -o verbose\n`, null],
    ['bash functrace', `${clean}set -o functrace\n`, null],
    ['a zsh TRAPDEBUG function', `${clean}TRAPDEBUG () {\n\t:\n}\n`, null],
    ['an alias for the marker builtin', `${clean}alias -- set='set -x'\n`, null],
    ['a session script that sets options', clean, 'export A=1\nset -x\n'],
    ['a session script that traps', clean, "trap 'x' DEBUG\n"],
  ])('%s blocks it', (_label, snapshot, sessionScript) => {
    expect(shellStateAllowsExitMarker(snapshot, sessionScript)).toBe(false)
  })
})

describe('readExitEvidence', () => {
  const p = { token: 'abc', semanticCommand: 'grep', pipelineHasMultipleCommands: true }

  test('a missing file means the command never started', () => {
    expect(readExitEvidence(undefined, p)).toMatchObject({
      semanticCommandStarted: false,
    })
  })

  test('a matching token proves the start and reads pipefail', () => {
    expect(readExitEvidence('abc hB\npipefail  off\n', p)).toEqual({
      semanticCommand: 'grep',
      semanticCommandStarted: true,
      pipelineHasMultipleCommands: true,
      pipefailEnabled: false,
    })
    expect(readExitEvidence('abc hB\npipefail  on\n', p)?.pipefailEnabled).toBe(true)
  })

  test('pipefail is assumed on when the option list is missing', () => {
    expect(readExitEvidence('abc hB\n', p)?.pipefailEnabled).toBe(true)
  })

  test('a wrong token, or tracing active at the marker, is not trusted', () => {
    expect(readExitEvidence('zzz hB\npipefail off\n', p)).toBeNull()
    expect(readExitEvidence('', p)).toBeNull()
    expect(readExitEvidence('abc hxB\npipefail off\n', p)).toBeNull()
    expect(readExitEvidence('abc hvB\npipefail off\n', p)).toBeNull()
  })
})

// The regression matrix, run in real shells through the production quoting
// and the same `eval ... && pwd -P >| cwd` shape bashProvider builds. Each row
// runs twice, original and instrumented: output, exit code, and final cwd must
// be identical, and the verdict comes from the evidence the marker wrote.
const SHELLS = ['/bin/bash', '/bin/zsh', '/bin/sh'].filter(existsSync)
const HAS_LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof'].some(existsSync)
const HAS_GIT = spawnSync('git', ['--version']).status === 0

let work: string
let closedPort: number

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'exit-attribution-'))
  writeFileSync(join(work, 'file.txt'), 'hello\n')
  spawnSync('git', ['init', '-q'], { cwd: work })
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  closedPort = server.port
  server.stop(true)
})

afterAll(() => {
  rmSync(work, { recursive: true, force: true })
})

type Run = { output: string; code: number; cwd: string | null }

function runWrapped(shell: string, command: string, runDir: string, flags: string[] = []): Run {
  const cwdFile = join(runDir, 'cwd')
  const outFile = join(runDir, 'out')
  rmSync(cwdFile, { force: true })
  const out = openSync(outFile, 'w')
  const script = `eval ${quoteShellCommand(command, false)} && pwd -P >| ${quote([cwdFile])}`
  const proc = spawnSync(shell, [...flags, '-c', script], {
    cwd: work,
    stdio: ['ignore', out, out],
  })
  closeSync(out)
  return {
    output: readFileSync(outFile, 'utf8'),
    code: proc.status ?? -1,
    cwd: existsSync(cwdFile) ? readFileSync(cwdFile, 'utf8') : null,
  }
}

function judge(shell: string, command: string, flags: string[] = []) {
  const runDir = mkdtempSync(join(work, 'run-'))
  mkdirSync(join(runDir, 'x'), { recursive: true })
  const evidencePath = join(runDir, 'evidence')
  const original = runWrapped(shell, command, runDir, flags)
  const p = planExitAttribution(command, SEMANTIC_COMMAND_NAMES, evidencePath)
  const instrumented = p ? runWrapped(shell, p.instrumentedCommand, runDir, flags) : original
  const evidence = existsSync(evidencePath) ? readFileSync(evidencePath, 'utf8') : undefined
  const attribution = p ? readExitEvidence(evidence, p) : null
  const verdict = interpretCommandResult(instrumented.code, instrumented.output, '', attribution)
  return { original, instrumented, planned: p !== null, attribution, isError: verdict.isError }
}

const lsofQuery = () => `lsof -nP -iTCP:${closedPort} -sTCP:LISTEN`

for (const shell of SHELLS) {
  const kind = shell.split('/').pop()!

  describe(`real ${kind}`, () => {
    // [label, command, expected isError, runs only when]
    const rows: [string, () => string, boolean, boolean?][] = [
      ['false && grep: grep never ran', () => 'false && grep x file.txt', true],
      ['cd /does-not-exist && grep: grep never ran', () => 'cd /does-not-exist && grep hello file.txt', true],
      ['true && grep: grep ran, no match', () => 'true && grep missing file.txt', false],
      ['false || grep: grep owns the status', () => 'false || grep missing file.txt', false],
      ['false ; grep: grep owns the status', () => 'false ; grep missing file.txt', false],
      ['printf | grep without pipefail', () => 'printf foo | grep bar', false],
      ['pipefail with a failing earlier stage', () => 'set -o pipefail; true && false | grep missing file.txt', true],
      ['set -e with grep reached', () => 'set -e; true && grep missing file.txt', false],
      ['multi-line && chain', () => 'true &&\n  grep missing file.txt', false],
      ['trailing comment', () => 'true && grep missing file.txt # comment', false],
      ['brace group falls back', () => 'true && { grep missing file.txt; }', true],
      ['subshell falls back', () => 'true && (grep missing file.txt)', true],
      ['xtrace in the command falls back', () => 'set -x; true && grep missing file.txt', true],
      ['false && lsof: lsof never ran', () => `false && ${lsofQuery()}`, true, HAS_LSOF],
      ['true && lsof: lsof ran, no listener', () => `true && ${lsofQuery()}`, false, HAS_LSOF],
      [
        'the reported command',
        () => `ls -la && git status -sb && ${lsofQuery()}`,
        false,
        HAS_LSOF && HAS_GIT,
      ],
    ]
    if (kind === 'bash') {
      rows.push(['a DEBUG trap falls back', () => "trap 'n=1' DEBUG; true && grep missing file.txt", true])
    }

    for (const [label, command, expectedError, runs = true] of rows) {
      test.skipIf(!runs)(label, () => {
        const r = judge(shell, command())
        expect(r.instrumented).toEqual(r.original)
        expect(r.isError).toBe(expectedError)
      })
    }

    test('set -e stopping at an earlier statement', () => {
      const r = judge(shell, 'set -e; false; grep missing file.txt')
      expect(r.instrumented).toEqual(r.original)
      // bash and sh exit at `false`, so grep never ran; zsh keeps going
      // inside an eval that is itself part of an && list, so grep did run.
      expect(r.attribution?.semanticCommandStarted).toBe(kind === 'zsh')
      expect(r.isError).toBe(kind !== 'zsh')
    })

    test('$? and $_ read by the user command are unchanged', () => {
      const status = judge(shell, 'true && grep missing file.txt\necho "status=$?"')
      expect(status.instrumented).toEqual(status.original)
      expect(status.original.output).toBe('status=1\n')

      const last = judge(shell, 'mkdir -p x && cd $_ && grep hello ../file.txt')
      expect(last.planned).toBe(true)
      expect(last.instrumented).toEqual(last.original)
      expect(last.original.cwd?.trim().endsWith('/x')).toBe(true)
    })

    test('tracing already on when the shell starts makes the evidence untrusted', () => {
      const r = judge(shell, 'true && grep missing file.txt', ['-x'])
      expect(r.planned).toBe(true)
      expect(r.attribution).toBeNull()
      expect(r.isError).toBe(true)
    })
  })
}
