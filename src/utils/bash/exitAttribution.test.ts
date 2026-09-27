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
  analyzeSnapshotForExitMarker,
  buildExitMarker,
  type ExitMarkerShellState,
  planExitAttribution,
  readExitEvidence,
  sessionEnvAllowsExitMarker,
} from './exitAttribution.js'
import { quote } from './shellQuote.js'
import { quoteShellCommand } from './shellQuoting.js'

const EVIDENCE = '/tmp/claude-test-exit'
const NO_USER_COMMANDS: ExitMarkerShellState = { userDefinedCommands: new Set() }
const plan = (command: string, state: ExitMarkerShellState = NO_USER_COMMANDS) =>
  planExitAttribution(command, SEMANTIC_COMMAND_NAMES, EVIDENCE, state)
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

  test('a direct final statement gets it immediately in front', () => {
    expect(placed('grep x f')).toBe('M; grep x f')
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
    // After `||` the left side runs after any marker and can end the shell.
    ['the right side of ||', 'false || grep x f'],
    ['exit on the left of ||', 'exit 1 || grep x f'],
    ['a trailing || after an && chain', 'true && grep x f || grep y f'],
    // The marker is a completed command and would reset these.
    ['PIPESTATUS after &&', 'false | true && test "${PIPESTATUS[0]}" -eq 1'],
    ['zsh pipestatus after &&', 'false | true && test "${pipestatus[1]}" -eq 1'],
    ['zsh $status at a statement start', 'false; test "$status" -eq 1'],
    ['$? at a statement start', 'false; test "$?" -eq 1'],
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
    // The name would run user code, not the program whose rule applies.
    ['a function shadowing the final command', 'diff() { echo boom >&2; return 1; }; diff'],
    ['a function shadowing lsof', 'lsof() { return 1; }; lsof'],
  ])('%s', (_label, command) => {
    expect(plan(command)).toBeNull()
  })

  test('a snapshot-defined name disables it, final or earlier in the command', () => {
    const state = { userDefinedCommands: new Set(['diff', 'arm']) }
    expect(plan('diff a b', state)).toBeNull()
    expect(plan('arm && grep missing f', state)).toBeNull()
    expect(plan('true && grep x "$(arm)"', state)).toBeNull()
    expect(plan('true && grep missing f', state)).not.toBeNull()
  })

  test('a user-defined [ disables it, as the final test or before the marker', () => {
    const state = { userDefinedCommands: new Set(['[']) }
    expect(plan('[ -n x ]', state)).toBeNull()
    expect(plan('true && [ -n x ]', state)).toBeNull()
    expect(plan('[ -n x ] && grep missing f', state)).toBeNull()
    expect(plan('[ -n x ]')).not.toBeNull()
  })

  test('$? after && is 0 with or without the marker, so it is allowed', () => {
    expect(plan('true && test "$?" -eq 0')).not.toBeNull()
  })

  test('safe option changes still allow the marker', () => {
    expect(plan('set -e; true && grep x f')).not.toBeNull()
    expect(plan('set -euo pipefail; true && grep x f')).not.toBeNull()
    expect(plan('setopt pipe_fail; true && grep x f')).not.toBeNull()
  })
})

describe('analyzeSnapshotForExitMarker', () => {
  const clean = '# Functions\nfoo () {\n\techo hi\n}\n# Shell Options\nsetopt autocd\n'

  test('a clean snapshot is usable and its functions are user-defined', () => {
    expect(analyzeSnapshotForExitMarker(clean)?.userDefinedCommands).toEqual(new Set(['foo']))
  })

  test.each([
    ['no snapshot (login-shell fallback)', undefined],
    ['zsh xtrace already on', `${clean}setopt xtrace\n`],
    ['bash verbose already on', `${clean}set -o verbose\n`],
    ['bash functrace', `${clean}set -o functrace\n`],
    ['a zsh TRAPDEBUG function', `${clean}TRAPDEBUG () {\n\t:\n}\n`],
    ['an alias for the marker builtin', `${clean}alias -- set='set -x'\n`],
  ])('%s makes it unusable', (_label, snapshot) => {
    expect(analyzeSnapshotForExitMarker(snapshot)).toBeNull()
  })

  test('aliases are user-defined unless they are the same command with literal flags', () => {
    const state = analyzeSnapshotForExitMarker(
      [
        clean,
        "alias -- grep='grep --color=auto --exclude-dir={.git,.hg}'",
        "alias -- ls='ls -G'",
        "alias -- ll='ls -lh'",
        'alias -- diff=false',
        "alias -- rg='rg $(pick-flags)'",
        "alias -- _='sudo '",
      ].join('\n'),
    )
    expect([...state!.userDefinedCommands].sort()).toEqual(['_', 'diff', 'foo', 'll', 'rg'])
  })

  test('names zsh prints quoted are read unquoted', () => {
    expect(
      analyzeSnapshotForExitMarker(["'[' () {", '\treturn 1', '}'].join('\n'))
        ?.userDefinedCommands,
    ).toEqual(new Set(['[']))
    expect(
      analyzeSnapshotForExitMarker("alias -- '['=false")?.userDefinedCommands,
    ).toEqual(new Set(['[']))
  })

  test('a function is user-defined unless it only forwards to the same program', () => {
    const state = analyzeSnapshotForExitMarker(
      [
        'diff () {',
        '\tcommand diff --color "$@"',
        '}',
        'lsof () {',
        '\tcommand lsof "$@"; set -x',
        '}',
        'find () {',
        '\tcommand grep "$@"',
        '}',
        'test () {',
        '\tcommand test "$1"',
        '}',
      ].join('\n'),
    )
    expect([...state!.userDefinedCommands].sort()).toEqual(['find', 'lsof', 'test'])
  })
})

describe('sessionEnvAllowsExitMarker', () => {
  test.each([
    ['no script', null],
    ['exports', 'export A=1\n'],
    [
      'assignments, exports, quoting, and $VAR expansion',
      'export A=1 B="x y"\nexport PATH="/opt/bin:$PATH"\nC=\'lit\'\nexport D\n# note\n',
    ],
  ])('%s: allowed', (_label, script) => {
    expect(sessionEnvAllowsExitMarker(script)).toBe(true)
  })

  test.each([
    ['dot-sourcing after ;', 'export A=1; . /tmp/env.sh'],
    ['dot-sourcing after &&', 'export A=1 && . /tmp/env.sh'],
    ['dot-sourcing on its own line', '. /tmp/env.sh'],
    ['source', 'source /tmp/env.sh'],
    ['autoload', 'autoload -Uz diff'],
    ['typeset -f', 'typeset -f diff'],
    ['export -f', 'export -f diff'],
    ['a command substitution', 'export A=$(id -u)'],
    ['setting options', 'export A=1\nset -x\n'],
    ['a trap', "trap 'x' DEBUG\n"],
    ['a function definition', 'diff() { return 1; }\n'],
    ['a function keyword definition', 'function lsof { return 1; }\n'],
  ])('%s: refused', (_label, script) => {
    expect(sessionEnvAllowsExitMarker(script)).toBe(false)
  })
})

// Snapshots written by the production generator for a shell whose rc file
// holds the given text. HOME is only read at process start, so the generator
// runs in a child with an isolated HOME and config dir.
const GENERATOR = join(import.meta.dir, 'ShellSnapshot.ts')
function withSnapshot<T>(shell: string, rc: string, use: (path: string, text: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'exit-attr-home-'))
  const config = mkdtempSync(join(tmpdir(), 'exit-attr-config-'))
  try {
    writeFileSync(join(home, shell.endsWith('zsh') ? '.zshrc' : '.bashrc'), rc)
    const proc = spawnSync(
      process.execPath,
      [
        '-e',
        `const { createAndSaveSnapshot } = await import(${JSON.stringify(GENERATOR)}); process.stdout.write(await createAndSaveSnapshot(${JSON.stringify(shell)}) ?? '')`,
      ],
      { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config }, encoding: 'utf8' },
    )
    const path = proc.stdout.trim()
    expect(path).not.toBe('')
    return use(path, readFileSync(path, 'utf8'))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(config, { recursive: true, force: true })
  }
}

describe.skipIf(!existsSync('/bin/bash'))('analyzeSnapshotForExitMarker on real bash snapshots', () => {
  test('an ordinary function is stored encoded and seen as user-defined', () => {
    withSnapshot('/bin/bash', 'plain_helper() { echo hi; }\n', (_path, text) => {
      expect(text).toMatch(/^eval "\$\(echo '[A-Za-z0-9+/=]+' \| base64 -d\)"/m)
      expect(analyzeSnapshotForExitMarker(text)?.userDefinedCommands.has('plain_helper')).toBe(true)
    })
  })

  test.each([
    ['set', 'set() { builtin set "$@"; }\n'],
    ['command', 'command() { builtin command "$@"; }\n'],
    [':', ':() { true; }\n'],
  ])('a function named %s, which the marker calls, makes it unusable', (_name, bashrc) => {
    withSnapshot('/bin/bash', bashrc, (_path, text) => {
      expect(analyzeSnapshotForExitMarker(text)).toBeNull()
    })
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
// Per-run scratch lives outside `work`: `git status` in the matrix lists
// `work`, and files appearing there between the original and the
// instrumented run would make identical commands print different output.
let runs: string
let closedPort: number

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'exit-attribution-'))
  runs = mkdtempSync(join(tmpdir(), 'exit-attribution-runs-'))
  mkdirSync(join(work, 'x'))
  writeFileSync(join(work, 'file.txt'), 'hello\n')
  spawnSync('git', ['init', '-q'], { cwd: work })
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  closedPort = server.port
  server.stop(true)
})

afterAll(() => {
  rmSync(work, { recursive: true, force: true })
  rmSync(runs, { recursive: true, force: true })
})

type Run = { output: string; code: number; cwd: string | null }

type Snapshot = { path: string; state: ExitMarkerShellState }

function runWrapped(
  shell: string,
  command: string,
  runDir: string,
  flags: string[] = [],
  snapshot?: Snapshot,
): Run {
  const cwdFile = join(runDir, 'cwd')
  const outFile = join(runDir, 'out')
  rmSync(cwdFile, { force: true })
  const out = openSync(outFile, 'w')
  // Sourced the way bashProvider sources it, ahead of the eval.
  const source = snapshot ? `source ${quote([snapshot.path])} 2>/dev/null || true && ` : ''
  const script = `${source}eval ${quoteShellCommand(command, false)} && pwd -P >| ${quote([cwdFile])}`
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

function judge(shell: string, command: string, flags: string[] = [], snapshot?: Snapshot) {
  const runDir = mkdtempSync(join(runs, 'run-'))
  const evidencePath = join(runDir, 'evidence')
  const original = runWrapped(shell, command, runDir, flags, snapshot)
  const p = planExitAttribution(
    command,
    SEMANTIC_COMMAND_NAMES,
    evidencePath,
    snapshot?.state ?? NO_USER_COMMANDS,
  )
  const instrumented = p
    ? runWrapped(shell, p.instrumentedCommand, runDir, flags, snapshot)
    : original
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
      ['false || grep falls back: || is never instrumented', () => 'false || grep missing file.txt', true],
      ['exit 1 || grep: grep never ran', () => 'exit 1 || grep missing file.txt', true],
      ['false ; grep: grep owns the status', () => 'false ; grep missing file.txt', false],
      ['printf | grep without pipefail', () => 'printf foo | grep bar', false],
      ['pipefail with a failing earlier stage', () => 'set -o pipefail; true && false | grep missing file.txt', true],
      ['set -e with grep reached', () => 'set -e; true && grep missing file.txt', false],
      ['multi-line && chain', () => 'true &&\n  grep missing file.txt', false],
      ['trailing comment', () => 'true && grep missing file.txt # comment', false],
      ['brace group falls back', () => 'true && { grep missing file.txt; }', true],
      ['subshell falls back', () => 'true && (grep missing file.txt)', true],
      ['xtrace in the command falls back', () => 'set -x; true && grep missing file.txt', true],
      ['a diff function in the command is not diff', () => 'diff() { echo boom >&2; return 1; }; diff', true],
      ['an lsof function in the command is not lsof', () => 'lsof() { return 1; }; lsof', true],
      ['false && lsof: lsof never ran', () => `false && ${lsofQuery()}`, true, HAS_LSOF],
      ['true && lsof: lsof ran, no listener', () => `true && ${lsofQuery()}`, false, HAS_LSOF],
      [
        'the reported command',
        // Lists `x`, not `work`: git status rewrites .git/index, which moves
        // the mtime `ls -la work` prints for .git between the two runs.
        () => `ls -la x && git status -sb && ${lsofQuery()}`,
        false,
        HAS_LSOF && HAS_GIT,
      ],
    ]
    if (kind === 'bash') {
      rows.push(
        ['a DEBUG trap falls back', () => "trap 'n=1' DEBUG; true && grep missing file.txt", true],
        ['PIPESTATUS read after && keeps its value', () => 'false | true && test "${PIPESTATUS[0]}" -eq 1', false],
      )
    }
    if (kind === 'zsh') {
      rows.push(
        ['pipestatus read after && keeps its value', () => 'false | true && test "${pipestatus[1]}" -eq 1', false],
        ['$status read at a statement start keeps its value', () => 'false; test "$status" -eq 1', false],
      )
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

// The user's shell as the snapshot restores it: functions and aliases from
// the rc file, sourced before the command exactly as bashProvider does.
for (const shell of ['/bin/bash', '/bin/zsh'].filter(existsSync)) {
  const kind = shell.split('/').pop()!

  describe(`real ${kind} with a snapshot from its rc file`, () => {
    const inSnapshot = (rc: string, command: string) =>
      withSnapshot(shell, rc, (path, text) => {
        const state = analyzeSnapshotForExitMarker(text)
        expect(state).not.toBeNull()
        return judge(shell, command, [], { path, state: state! })
      })

    // bash runs its `[` builtin even when a function has that name, so only
    // the alias shadows it there.
    const shadowsBracket: [string, string, string][] =
      kind === 'zsh'
        ? [
            ['a [ function returning 1', '[() { return 1; }\n', '[ -n x ]'],
            ['an alias of [ to false', "alias '['=false\n", '[ -n x ]'],
          ]
        : [['an alias of [ to false', "alias '['=false\n", '[ -n x ]']]

    test.each([
      ['a diff function returning 1', 'diff() { echo boom >&2; return 1; }\n', 'diff'],
      ['an alias of diff to false', 'alias diff=false\n', 'diff'],
      ['an lsof function returning 1', 'lsof() { return 1; }\n', 'lsof'],
      ...shadowsBracket,
    ])('%s is a failure, not the real program', (_label, rc, command) => {
      const r = inSnapshot(rc, command)
      expect(r.planned).toBe(false)
      expect(r.original.code).toBe(1)
      expect(r.isError).toBe(true)
    })

    test('a function that turns on tracing before the marker leaves output unchanged', () => {
      const r = inSnapshot('arm() { set -x; }\n', 'arm && grep missing file.txt')
      expect(r.planned).toBe(false)
      expect(r.instrumented).toEqual(r.original)
      expect(r.isError).toBe(true)
    })

    test('a wrapper forwarding to the same program keeps its rule', () => {
      writeFileSync(join(work, 'a.txt'), 'one\n')
      writeFileSync(join(work, 'b.txt'), 'two\n')
      const r = inSnapshot('diff() { command diff -u "$@"; }\n', 'diff a.txt b.txt')
      expect(r.planned).toBe(true)
      expect(r.instrumented).toEqual(r.original)
      expect(r.original.code).toBe(1)
      expect(r.isError).toBe(false)
    })

    test('a self-alias with literal flags keeps its rule', () => {
      const r = inSnapshot("alias grep='grep -i'\n", 'true && grep missing file.txt')
      expect(r.planned).toBe(true)
      expect(r.instrumented).toEqual(r.original)
      expect(r.isError).toBe(false)
    })
  })
}
