import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Runs the real bash provider in a child process so HOME (read once at
// startup) and the inherited environment are exactly what a session would
// start with: here, no .bashrc, so the snapshot captures no user functions.
function planned(extraEnv: Record<string, string>): boolean {
  const home = mkdtempSync(join(tmpdir(), 'provider-exit-home-'))
  const config = mkdtempSync(join(tmpdir(), 'provider-exit-config-'))
  try {
    const script = `
      const { createBashShellProvider } = await import(${JSON.stringify(join(import.meta.dir, 'bashProvider.ts'))})
      const { SEMANTIC_COMMAND_NAMES } = await import(${JSON.stringify(join(import.meta.dir, '../../tools/BashTool/commandSemantics.ts'))})
      const provider = await createBashShellProvider('/bin/bash')
      const built = await provider.buildExecCommand('diff', {
        id: 'test', useSandbox: false, exitSemanticCommands: SEMANTIC_COMMAND_NAMES,
      })
      process.stdout.write(built.exitAttributionPlan ? 'planned' : 'unplanned')
    `
    const proc = spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config, ...extraEnv },
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
    expect(planned({})).toBe(true)
  })

  test('an exported bash function the snapshot never saw disables it', () => {
    // `export -f diff` puts this in the environment; the command shell
    // imports it as diff() while the no-.bashrc snapshot records nothing.
    expect(planned({ 'BASH_FUNC_diff%%': '() {  return 1\n}' })).toBe(false)
  })
})
