import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Runs the real provider in a child process so HOME (read once at startup)
// and the inherited environment are exactly what a session would start with:
// an isolated HOME with no rc file, so the snapshot captures no user state.
// `sessionEnv` is applied through setSessionEnvVar, as `/env NAME=value` does,
// after the provider (and its snapshot) exists.
function planned(
  shell: string,
  {
    env = {},
    sessionEnv = {},
    envFile,
    command = 'diff',
    useSandbox = false,
  }: {
    env?: Record<string, string>
    sessionEnv?: Record<string, string>
    envFile?: string
    command?: string
    useSandbox?: boolean
  } = {},
): boolean {
  const home = mkdtempSync(join(tmpdir(), 'provider-exit-home-'))
  const config = mkdtempSync(join(tmpdir(), 'provider-exit-config-'))
  try {
    const envFilePath = join(home, 'session.env')
    if (envFile !== undefined) writeFileSync(envFilePath, envFile)
    const script = `
      const { createBashShellProvider } = await import(${JSON.stringify(join(import.meta.dir, 'bashProvider.ts'))})
      const { setSessionEnvVar } = await import(${JSON.stringify(join(import.meta.dir, '../sessionEnvVars.ts'))})
      const { SEMANTIC_COMMAND_NAMES } = await import(${JSON.stringify(join(import.meta.dir, '../../tools/BashTool/commandSemantics.ts'))})
      const provider = await createBashShellProvider(${JSON.stringify(shell)})
      for (const [name, value] of Object.entries(${JSON.stringify(sessionEnv)})) setSessionEnvVar(name, value)
      const built = await provider.buildExecCommand(${JSON.stringify(command)}, {
        id: 'test', useSandbox: ${JSON.stringify(useSandbox)},
        sandboxTmpDir: ${JSON.stringify(join(home, 'sandbox'))},
        exitSemanticCommands: SEMANTIC_COMMAND_NAMES,
      })
      process.stdout.write(built.exitAttributionPlan ? 'planned' : 'unplanned')
    `
    const proc = spawnSync(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_CONFIG_DIR: config,
        ...(envFile !== undefined ? { CLAUDE_ENV_FILE: envFilePath } : {}),
        ...env,
      },
      encoding: 'utf8',
    })
    expect(proc.stdout).toMatch(/^(planned|unplanned)$/)
    return proc.stdout === 'planned'
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(config, { recursive: true, force: true })
  }
}

describe.skipIf(!existsSync('/bin/bash'))('bash provider exit attribution', () => {
  test('a plain environment is instrumented', () => {
    expect(planned('/bin/bash')).toBe(true)
  })

  test('a sandboxed command substitution cannot observe its exit marker', () => {
    expect(
      planned('/bin/bash', {
        useSandbox: true,
        command: 'grep needle "$(ls "$TMPDIR"/exit-*)"',
      }),
    ).toBe(false)
    expect(planned('/bin/bash', { useSandbox: true, command: 'grep missing file.txt' })).toBe(true)
  })

  test('an exported bash function the snapshot never saw disables it', () => {
    // `export -f diff` puts this in the environment; the command shell
    // imports it as diff() while the no-.bashrc snapshot records nothing.
    expect(planned('/bin/bash', { env: { 'BASH_FUNC_diff%%': '() {  return 1\n}' } })).toBe(
      false,
    )
  })

  test('a snapshot built from a different environment disables it', () => {
    expect(planned('/bin/bash', { env: { CLAUDE_CODE_DONT_INHERIT_ENV: '1' } })).toBe(false)
  })

  test.each([
    ['SHELLOPTS', 'xtrace'],
    ['BASHOPTS', 'extdebug'],
    ['BASH_ENV', '/tmp/env.sh'],
    ['BASH_FUNC_diff%%', '() {  return 1\n}'],
  ])('/env %s, read at startup after the snapshot, disables it', (name, value) => {
    expect(planned('/bin/bash', { sessionEnv: { [name]: value } })).toBe(false)
  })

  test('/env of an ordinary variable keeps it', () => {
    expect(planned('/bin/bash', { sessionEnv: { NODE_ENV: 'test' } })).toBe(true)
  })

  test('a session env file that only sets variables keeps it', () => {
    expect(
      planned('/bin/bash', {
        envFile: 'export A=1 B="x y"\nexport PATH="/opt/bin:$PATH"\nC=lit\n',
      }),
    ).toBe(true)
  })

  test.each([
    ['dot-sourcing after ;', 'export A=1; . /tmp/env.sh\n'],
    ['a function definition', 'diff() { return 1; }\n'],
    ['a command substitution', 'export A=$(id -u)\n'],
  ])('a session env file with %s disables it', (_label, envFile) => {
    expect(planned('/bin/bash', { envFile })).toBe(false)
  })
})

describe.skipIf(!existsSync('/bin/zsh'))('zsh provider exit attribution', () => {
  test('a plain environment is instrumented', () => {
    expect(planned('/bin/zsh')).toBe(true)
  })

  test('a sandboxed command substitution cannot observe its exit marker', () => {
    expect(
      planned('/bin/zsh', {
        useSandbox: true,
        command: 'grep needle "$(ls "$TMPDIR"/exit-*)"',
      }),
    ).toBe(false)
  })

  test.each(['ZDOTDIR', 'HOME'])('/env %s, which moves .zshenv, disables it', name => {
    expect(planned('/bin/zsh', { sessionEnv: { [name]: '/tmp/cc-zdot' } })).toBe(false)
  })

  test('why: zsh -c defines functions from $ZDOTDIR/.zshenv before any command', () => {
    const zdot = mkdtempSync(join(tmpdir(), 'provider-exit-zdot-'))
    try {
      writeFileSync(join(zdot, '.zshenv'), 'diff() { return 1; }\n')
      const proc = spawnSync('/bin/zsh', ['-c', 'whence -w diff'], {
        env: { ...process.env, ZDOTDIR: zdot },
        encoding: 'utf8',
      })
      expect(proc.stdout.trim()).toBe('diff: function')
    } finally {
      rmSync(zdot, { recursive: true, force: true })
    }
  })
})
