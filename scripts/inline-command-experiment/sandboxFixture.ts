import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

/** Runs only in the disposable PTY owner, before loading the real runtime. */
export async function wrapFixtureWithSandbox(fixture: { home: string; argv: string[] }, cwd: string) {
  const home = await realpath(fixture.home)
  const workspace = await realpath(cwd)
  const temporary = join(home, 'sandbox-tmp')
  await mkdir(temporary, { mode: 0o700 })
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = home
  process.env.TMPDIR = temporary
  process.env.CLAUDE_TMPDIR = temporary
  process.chdir(workspace)
  // This is the real implementation delegated to by sandbox-adapter.ts. Do not
  // initialize the application settings adapter or mutate its enabled setting.
  const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')
  try {
    const ripgrep = ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg']
      .map(command => ({ command })).find(candidate => Bun.which(candidate.command) !== null)
    if (!ripgrep) throw new Error('Sandbox unavailable: rg missing from fixed fixture locations')
    const dependencies = SandboxManager.checkDependencies(ripgrep)
    if (dependencies.errors.length) throw new Error(`Sandbox unavailable: ${dependencies.errors.join('; ')}`)
    await SandboxManager.initialize({
      network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: false, allowAllUnixSockets: false },
      filesystem: { allowWrite: [workspace, home], denyWrite: [], denyRead: [] },
      allowPty: true,
      ripgrep,
    }, undefined, false)
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const wrapped = await SandboxManager.wrapWithSandbox(`exec ${fixture.argv.map(quote).join(' ')}`, '/bin/sh')
    if (!wrapped.includes('sandbox-exec')) throw new Error('macOS sandbox wrapper did not produce sandbox-exec')
    return { argv: ['/bin/sh', '-c', wrapped], cleanup: () => SandboxManager.reset() }
  } catch (error) {
    await SandboxManager.reset()
    throw error
  }
}
