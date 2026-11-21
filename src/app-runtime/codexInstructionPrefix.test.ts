import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Scenario = 'full' | 'prefix' | 'session-memory' | 'websocket' | 'worker' | 'estimate'
type Request = {
  instructions?: string
  input: Array<{ role?: string; content?: Array<{ text?: string }> }>
  previous_response_id?: string
  prompt_cache_key?: string
}

async function withFixture(testFixture: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-prefix-')))
  try {
    await Promise.all([mkdir(join(root, 'config')), mkdir(join(root, 'workspace'))])
    await testFixture(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function capture(root: string, scenario: Scenario, phase = 'run', blockingLimit?: number): Promise<Request[]> {
  const child = Bun.spawn([
    process.execPath, '--feature=BREAK_CACHE_COMMAND',
    ...(scenario === 'prefix' ? ['--feature=REACTIVE_COMPACT'] : []),
    new URL('./codexInstructionPrefix.fixture.ts', import.meta.url).pathname, scenario, phase,
  ], {
    cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
    env: {
      PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
      CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
      CLAUDE_CODE_USE_OPENAI: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
      ENABLE_CLAUDE_CODE_SM_COMPACT: scenario === 'session-memory' ? '1' : '0',
      DISABLE_CLAUDE_CODE_SM_COMPACT: scenario === 'session-memory' ? '0' : '1',
      DISABLE_AUTO_COMPACT: '1', ENABLE_TOOL_SEARCH: 'false',
      ...(blockingLimit === undefined ? {} : { CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE: String(blockingLimit) }),
    },
  })
  const timer = setTimeout(() => child.kill(), 20_000)
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timer))
  if (code !== 0) throw new Error(`Codex instruction fixture (${scenario}/${phase}) failed (${code})\n${stderr}\n${stdout}`)
  return JSON.parse(await readFile(join(root, 'requests.json'), 'utf8'))
}

const parentMarker = 'Stable parent fixture instructions.'

function expectPrefix(request: Request, marker: string) {
  expect(request.instructions ?? '').toBe('')
  expect(request.input[0]?.role).toBe('developer')
  expect(request.input[0]?.content?.[0]?.text).toContain(marker)
  expect(JSON.stringify(request.input).split(marker)).toHaveLength(2)
  return JSON.stringify(request.input[0])
}

for (const strategy of ['full', 'prefix', 'session-memory'] as const) {
  test(`Codex reassembles one stable prefix after ${strategy} compaction and transcript resume`, async () => {
    await withFixture(async root => {
      const requests = await capture(root, strategy)
      expect(requests).toHaveLength(strategy === 'session-memory' ? 3 : 4)
      const fresh = requests[0]!
      const later = requests[1]!
      const compacted = requests.at(-1)!
      const [resumed] = await capture(root, strategy, 'resume')
      const stable = expectPrefix(fresh, parentMarker)
      for (const request of [later, compacted, resumed!]) {
        expect(expectPrefix(request, parentMarker)).toBe(stable)
        expect(request.prompt_cache_key).toBe(fresh.prompt_cache_key)
      }
      expect(JSON.stringify(fresh.input[1])).toContain('volatile-one')
      const summary = strategy === 'session-memory' ? 'Isolated Session Memory summary.' : 'Isolated model-generated compaction summary.'
      for (const request of [compacted, resumed!]) {
        expect(JSON.stringify(request.input)).toContain(summary)
        expect(JSON.stringify(request.input).includes('Finished isolated request 1.')).toBe(strategy !== 'full')
      }
    })
  }, 35_000)
}

test('WebSocket appends only new input and replays changed developer context after the stable prefix', async () => {
  await withFixture(async root => {
    const [fresh, continued, rebased] = await capture(root, 'websocket')
    const stable = expectPrefix(fresh!, parentMarker)
    expect(JSON.stringify(fresh!.input[1])).toContain('volatile-one')
    expect(continued!.instructions ?? '').toBe('')
    expect(continued!.previous_response_id).toBe('prefix-response-0')
    expect(continued!.input).toHaveLength(1)
    expect(JSON.stringify(continued!.input)).toContain('Second fixture turn.')
    expect(rebased!.previous_response_id).toBeUndefined()
    expect(expectPrefix(rebased!, parentMarker)).toBe(stable)
    expect(JSON.stringify(rebased!.input[1])).toContain('volatile-two')
  })
}, 25_000)

test('a Codex worker starts with its own stable instructions', async () => {
  await withFixture(async root => {
    const [parent, worker, continuation] = await capture(root, 'worker')
    expectPrefix(parent!, parentMarker)
    expectPrefix(worker!, 'TASK CONTRACT: Use the available tools to complete the assigned task.')
    expect(JSON.stringify(worker!.input[0])).not.toContain(parentMarker)
    expect(worker!.prompt_cache_key).not.toBe(parent!.prompt_cache_key)
    expect(continuation!.previous_response_id).toBe('prefix-response-0')
  })
}, 25_000)

test('the first-turn context limit accounts for the stable Codex prompt once', async () => {
  await withFixture(async root => {
    expect(await capture(root, 'estimate', 'run', 25000)).toHaveLength(0)
  })
  await withFixture(async root => {
    const requests = await capture(root, 'estimate', 'run', 45000)
    expect(requests).toHaveLength(1)
    expectPrefix(requests[0]!, parentMarker)
  })
}, 30_000)
