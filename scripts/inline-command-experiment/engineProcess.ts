import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type EngineExperimentInput = {
  context: string
  stopBeforeDispatch?: boolean
  failPersistence?: boolean
  busy?: boolean
  repeat?: boolean
  crashAfterAcceptance?: boolean
  provider?: 'claude' | 'codex'
  recovery?: boolean
}
export type EngineFixtureInput = EngineExperimentInput & {
  recoveryPhase?: 'kill-after-acceptance' | 'restore-only' | 'retry'
}
export type EngineExperimentEvidence = {
  requests: unknown[]
  frames: any[]
  accepted: boolean
  error?: string
  transcript: unknown[]
  codexRequests?: unknown[]
  recovery?: {
    killedSignal: string | null
    beforeKill: EngineExperimentEvidence
    restored: EngineExperimentEvidence
    retried: EngineExperimentEvidence
  }
}

/** Child isolation prevents Bun module mocks and engine singletons leaking into callers. */
export async function runEngineExperiment(input: EngineExperimentInput): Promise<EngineExperimentEvidence> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'inline-delivery-')))
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    const runChild = async (childInput: EngineFixtureInput) => {
      const child = Bun.spawn([process.execPath, new URL('./engineFixture.ts', import.meta.url).pathname], {
        cwd: join(root, 'workspace'),
        env: {
          PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root,
          CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
          ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential',
          CLAUDE_CODE_USE_OPENAI: input.provider === 'codex' ? '1' : '0',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
          EXPERIMENT_INPUT: JSON.stringify(childInput), EXPERIMENT_ROOT: root,
        }, stdout: 'pipe', stderr: 'pipe',
      })
      const timer = setTimeout(() => child.kill(), 30_000)
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      clearTimeout(timer)
      const killedAsRequested = childInput.recoveryPhase === 'kill-after-acceptance' && child.signalCode === 'SIGKILL'
      if (code !== 0 && !killedAsRequested) throw new Error(`Engine fixture failed (${code}): ${stderr}\n${stdout}`)
      return {
        evidence: JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8')) as EngineExperimentEvidence,
        signal: child.signalCode,
      }
    }
    if (input.recovery) {
      const killed = await runChild({ ...input, recoveryPhase: 'kill-after-acceptance' })
      if (killed.signal !== 'SIGKILL') throw new Error('Recovery experiment did not kill the child')
      const restored = await runChild({ ...input, recoveryPhase: 'restore-only' })
      const retried = await runChild({ ...input, recoveryPhase: 'retry' })
      return { ...retried.evidence, recovery: {
        killedSignal: killed.signal,
        beforeKill: killed.evidence,
        restored: restored.evidence,
        retried: retried.evidence,
      } }
    }
    return (await runChild(input)).evidence
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
