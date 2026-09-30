import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { writeWorkspaceJump } from '../../src/utils/workspaceJumpState.js'
import { writeSessionRelocation } from '../../src/utils/sessionRelocationState.js'
import { SIDECAR_RUNTIME_ARGS } from '../main/mainDecisions.js'

/** Proves the replacement gate precedes real resume hooks. Private config and
 * blocked network keep every engine process independent of live accounts. */
for (const settled of [false, true]) test(`destination identity and current trust precede real resume hooks (${settled ? 'later manual location' : 'unresolved jump'})`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-jump-startup-'))
  const previousConfig = process.env.CLAUDE_CONFIG_DIR
  const config = join(root, 'config'), project = join(root, 'project'), source = join(root, 'chat')
  mkdirSync(config); mkdirSync(project); mkdirSync(source)
  const cwd = realpathSync(project)
  const previousProject = join(root, 'previous-project')
  mkdirSync(previousProject)
  const appSessionId = randomUUID(), engineSessionId = randomUUID()
  const marker = join(root, 'resume-hook-ran')
  const blocker = join(root, 'block-network.ts')
  writeFileSync(blocker, 'globalThis.fetch = (async () => new Response("Network disabled", { status: 503 })) as typeof fetch\n')
  mkdirSync(join(project, '.cat-code'))
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  writeFileSync(join(project, '.cat-code', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: `touch ${quote(marker)}` }] }] } }))
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'sk-ant-local-probe', NODE_ENV: 'development', TEST_ENABLE_SESSION_PERSISTENCE: '1' }
  const trust = (trusted: boolean) => writeFileSync(join(config, '.config.json'), JSON.stringify({ projects: trusted ? { [cwd]: { hasTrustDialogAccepted: true } } : {} }))
  const processes: Array<ReturnType<typeof Bun.spawn>> = []
  try {
    trust(true)
    const mint = Bun.spawn(['bun', `--preload=${blocker}`, 'run', resolve('app/sidecar/mintTranscript.fixture.ts'), engineSessionId, 'jump-startup-history'], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
    processes.push(mint)
    const [code, stderr] = await Promise.all([mint.exited, new Response(mint.stderr).text(), new Response(mint.stdout).text()])
    if (code !== 0) throw new Error(stderr)
    process.env.CLAUDE_CONFIG_DIR = config
    const original = { cwd: realpathSync(source), binding: { kind: 'managed' as const, storageRootId: randomUUID(), storageId: randomUUID() } }
    const state = { version: 1 as const, appSessionId, engineSessionId, operationId: randomUUID(), sourceGeneration: 'source-generation',
      source: original, target: { cwd: settled ? realpathSync(previousProject) : cwd, binding: { kind: 'project' as const } },
      acceptedAt: 1, phase: settled ? 'settled' as const : 'moving' as const, location: settled ? 'destination' as const : 'unknown' as const,
      consumed: settled, cancelled: false, requiresUserReconciliation: false, ...(settled ? { outcome: 'completed' as const } : {}),
      sourceOutcomePersisted: false, boundary: { tipUuid: randomUUID(), toolUseId: 'jump-call' },
      continuation: { id: randomUUID(), state: settled ? 'settled' as const : 'not_admitted' as const } }
    writeWorkspaceJump(state)
    const relocation = { version: 1 as const, appSessionId, engineSessionId, original, source: original,
      target: { cwd, binding: { kind: 'project' as const } }, phase: 'complete' as const, controls: { mode: 'default' as const },
      backup: join(root, 'backup'), movedAt: 2 }
    if (settled) writeSessionRelocation(relocation)
    const spawn = (binding: unknown = { kind: 'project' }) => {
      const child = Bun.spawn(['bun', `--preload=${blocker}`, ...SIDECAR_RUNTIME_ARGS, resolve('app/sidecar/index.ts')], { cwd, env: { ...env,
        CATCODE_SIDECAR_SOCKET: join(root, 'session.sock'), CATCODE_SIDECAR_SESSION_ID: appSessionId,
        CATCODE_SIDECAR_CWD: cwd, CATCODE_SIDECAR_RESUME_SESSION_ID: engineSessionId,
        CATCODE_SESSION_BINDING_JSON: JSON.stringify(binding),
      }, stdout: 'pipe', stderr: 'pipe' })
      processes.push(child)
      return child
    }
    const misbound = spawn({ kind: 'managed', storageId: randomUUID(), storageRootId: randomUUID() })
    const [misboundCode, misboundError] = await Promise.all([misbound.exited, new Response(misbound.stderr).text(), new Response(misbound.stdout).text()])
    expect(misboundCode).not.toBe(0)
    expect(misboundError).toContain('location cannot be verified')
    expect(existsSync(marker)).toBe(false)
    if (settled) {
      writeSessionRelocation({ ...relocation, appSessionId: randomUUID() })
      const tampered = spawn()
      const [tamperedCode, tamperedError] = await Promise.all([tampered.exited, new Response(tampered.stderr).text(), new Response(tampered.stdout).text()])
      expect(tamperedCode).not.toBe(0)
      expect(tamperedError).toContain('location cannot be verified')
      expect(existsSync(marker)).toBe(false)
      writeSessionRelocation(relocation)
      writeWorkspaceJump({ ...state, requiresUserReconciliation: true, continuation: { ...state.continuation, state: 'uncertain' } })
      const unresolved = spawn()
      const [unresolvedCode, unresolvedError] = await Promise.all([unresolved.exited, new Response(unresolved.stderr).text(), new Response(unresolved.stdout).text()])
      expect(unresolvedCode).not.toBe(0)
      expect(unresolvedError).toContain('location cannot be verified')
      expect(existsSync(marker)).toBe(false)
      writeWorkspaceJump(state)
    }
    trust(false)
    const refused = spawn()
    const [refusedCode, refusedError] = await Promise.all([refused.exited, new Response(refused.stderr).text(), new Response(refused.stdout).text()])
    expect(refusedCode).not.toBe(0)
    expect(refusedError).toContain('destination is no longer trusted')
    expect(existsSync(marker)).toBe(false)
    // Positive control: the same transcript and hook really execute after the
    // receiving boundary finds saved trust, without starting a model turn.
    trust(true)
    const accepted = spawn()
    const stderrRead = new Response(accepted.stderr).text()
    const stdoutRead = new Response(accepted.stdout).text()
    const deadline = Date.now() + 20_000
    while (!existsSync(marker) && accepted.exitCode === null && Date.now() < deadline) await Bun.sleep(25)
    if (!existsSync(marker)) {
      accepted.kill('SIGTERM')
      throw new Error(`Trusted resume did not execute its hook: ${await stderrRead}`)
    }
    expect(existsSync(marker)).toBe(true)
    accepted.kill('SIGTERM')
    await Promise.all([accepted.exited, stderrRead, stdoutRead])
  } finally {
    for (const child of processes) if (child.exitCode === null) child.kill('SIGTERM')
    await Promise.all(processes.map(child => child.exited))
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
