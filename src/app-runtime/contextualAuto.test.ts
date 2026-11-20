import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSidecarLaunch } from '../../app/main/mainDecisions.js'

const fixture = new URL('./contextualAuto.fixture.ts', import.meta.url).pathname

async function run(scenario: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cat-contextual-auto-')))
  try {
    await Promise.all([mkdir(join(root, 'config')), mkdir(join(root, 'workspace'))])
    const trial = scenario.startsWith('trial-') || scenario.startsWith('mcp-')
    const runtimeArgs = trial ? resolveSidecarLaunch({
      mainDir: new URL('../../app/main/', import.meta.url).pathname,
      packaged: false,
    }).argsFor('session').slice(0, -1) : ['--feature=CODE_MODE', '--feature=TRANSCRIPT_CLASSIFIER',
      '--feature=AUTO_MODE_UPSTREAM_PORT', '--feature=AUTO_MODE_CONTEXTUAL_REVIEW']
    const child = Bun.spawn([process.execPath, ...runtimeArgs, fixture], {
      cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
      env: {
        PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        ANTHROPIC_API_KEY: 'isolated-fixture', CLAUDE_CODE_USE_OPENAI: '0',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        NODE_ENV: 'test', TEST_ENABLE_SESSION_PERSISTENCE: '1', CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-sonnet-5-5',
        ...(trial
          ? { CLAUDE_CODE_AUTO_MODE_MODEL: 'gpt-6-luna', CATCODE_SIDECAR_SESSION_ID: 'desktop-session',
              ...(scenario === 'trial-legacy' && { CLAUDE_CODE_CONTEXTUAL_AUTO_MODE: 'legacy' }) }
          : { CLAUDE_CODE_CONTEXTUAL_AUTO_MODE: 'experimental' }),
        CONTEXTUAL_AUTO_TEST_ROOT: root, CONTEXTUAL_AUTO_TEST_SCENARIO: scenario,
      },
    })
    const timeout = setTimeout(() => child.kill(), 25_000)
    const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timeout)
    if (exit !== 0) throw new Error(`Fixture ${scenario} exited ${exit}\n${error}\n${output}`)
    const evidence = JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
    return {
      ...evidence,
      scripts: evidence.transcript.filter((row: any) => row.toolUseResult?.kind === 'code-mode').map((row: any) => row.toolUseResult),
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

for (const state of ['matching', 'script', 'other-child', 'conflicting', 'no-anchor', 'no-creator', 'queued']) {
  test(`legacy notice with ${state} parent evidence cannot authorize the next edit`, async () => {
    const proof = await run(`legacy-notice-${state}`)
    const matching = state === 'matching' || state === 'script'
    expect(proof.postedNotices).toHaveLength(matching ? 1 : 0)
    expect(proof.prompts.map((p: any) => p.tool_name)).toEqual(matching || state === 'queued' ? ['Edit'] : ['Announce', 'Edit'])
    expect(proof.files.a).toBe('old')
    const notice = proof.requests.find((row: any) => row.tool === 'Announce')
    if (matching) expect(notice.content.assignment.parent).toContainEqual(expect.objectContaining({
      id: notice.content.assignment.parentAnchor, origin: 'operator', text: 'Have a helper inspect a.txt. Leave it untouched.',
    }))
    else expect(notice).toBeUndefined()
  }, 30_000)
}

for (const state of ['host-identity', 'relay-marker']) {
  test(`a compacted helper with ${state} needs permission before an ordinary edit`, async () => {
    const proof = await run(`compacted-${state}`)
    expect(proof.files.a).toBe('old')
    expect(proof.prompts).toEqual([expect.objectContaining({ tool_name: 'Edit', human_only: true })])
    expect(proof.requests).toHaveLength(0)
  }, 30_000)
}

test('an ordinary main-session edit still reaches the contextual reviewer after an inspect-only request', async () => {
  const proof = await run('main-inspect-only')
  expect(proof.requests).toEqual([expect.objectContaining({ tool: 'Edit', contextual: true })])
  expect(proof.files.a).toBe('old')
}, 30_000)

for (const [scenario, tool] of [['main-peer-create', 'CreatePeer'], ['main-peer-send', 'SendToPeer']] as const) {
  test(`${tool} reaches contextual review before it can affect a peer session`, async () => {
    const proof = await run(scenario)
    expect(proof.requests).toEqual([expect.objectContaining({ tool, contextual: true })])
    expect(proof.peerRequests).toBe(0)
  }, 30_000)
}

test('typed desktop question answers reach the reviewer as operator evidence without releasing a follow-up edit', async () => {
  const proof = await run('question-reply')
  expect(proof.prompts).toEqual([expect.objectContaining({ tool_name: 'AskUserQuestion' })])
  expect(proof.prompts[0].human_only).toBeUndefined()
  expect(proof.requests).toHaveLength(1)
  expect(proof.requests[0].content.conversation).toContainEqual(expect.objectContaining({
    origin: 'operator', text: expect.stringContaining('Leave the file untouched.'),
  }))
  expect(proof.files.a).toBe('old')
}, 30_000)

test('a credential in sourced Auto Mode settings holds the action without a provider request', async () => {
  const proof = await run('direct-credential-settings')
  expect(proof.requests).toHaveLength(0)
  expect(proof.prompts).toEqual([expect.objectContaining({ tool_name: 'Bash', human_only: true })])
  expect(proof.effect).toBeNull()
}, 30_000)

for (const scenario of ['direct-late-correction', 'background-withdrawal']) {
  test(`${scenario} discards a pending model allowance and records the reason`, async () => {
    const proof = await run(scenario)
    const review = proof.requests.find((request: any) => request.tool === 'Bash')
    expect(review?.contextual).toBe(true)
    expect(proof.effect).toBeNull()
    const expected = { toolUseId: review.content.action.attempt, outcome: 'inconclusive',
      reason: 'The assignment or action changed during review.', reviewer: expect.objectContaining({ verdict: 'allow' }) }
    expect(proof.reviewEvents).toContainEqual(expect.objectContaining(expected))
    expect(proof.savedReviews).toContainEqual(expect.objectContaining(expected))
  }, 30_000)
}

for (const contextual of [true, false]) {
  test(`desktop Auto Mode uses the ${contextual ? 'contextual Luna reviewer without an opt-in' : 'legacy reviewer with an explicit override'}`, async () => {
    const proof = await run(contextual ? 'trial-default' : 'trial-legacy')
    expect(proof.requests.length).toBeGreaterThan(0)
    expect(proof.requests[0].contextual).toBe(contextual)
    if (contextual) {
      expect(proof.requests[0]).toMatchObject({ model: 'gpt-6-luna', provider: 'openai' })
      expect(proof.savedReviews).toContainEqual(expect.objectContaining({ outcome: 'allowed',
        reviewer: expect.objectContaining({ kind: 'contextual', verdict: 'allow',
          profile: expect.objectContaining({ provider: 'openai', model: 'gpt-6-luna' }) }) }))
    } else expect(proof.savedReviews.every((row: any) => row.reviewer === undefined)).toBe(true)
  }, 30_000)
}

for (const outcome of ['allow', 'deny', 'withdrawal', 'peer-only']) {
  test(`desktop Auto Mode holds a real MCP search through ${outcome}`, async () => {
    const proof = await run(`mcp-${outcome}`)
    expect(proof.mcpCalls).toHaveLength(outcome === 'allow' ? 1 : 0)
    if (outcome === 'peer-only') {
      expect(proof.requests).toHaveLength(0)
      expect(proof.prompts).toEqual([expect.objectContaining({ human_only: true, tool_name: 'mcp__fixture__records' })])
    } else {
      expect(proof.prompts).toHaveLength(0)
      expect(proof.requests).toContainEqual(expect.objectContaining({
        contextual: false, content: expect.stringContaining('mcp__fixture__records'),
      }))
    }
    if (outcome === 'withdrawal') {
      const held = proof.reviewEvents.find((row: any) => row.outcome === 'inconclusive')
      expect(held?.reason).toContain('no longer matches')
      expect(held.reviewer).toBeUndefined()
    }
  }, 30_000)
}

for (const entry of ['direct', 'script']) {
  for (const tool of ['edit', 'bash']) {
    for (const source of ['verified', 'peer-only', 'withdrawn', 'stopped']) {
      test(`${entry} ${tool} respects ${source} authority`, async () => {
        const proof = await run(`delegated-${tool}-${source}-${entry}`)
        expect(tool === 'edit' ? proof.files.a : proof.effect).toBe(
          tool === 'edit' ? source === 'verified' ? 'new' : 'old' : source === 'verified' ? 'effect' : null,
        )
        if (source === 'peer-only') {
          expect(proof.prompts).toHaveLength(1)
          expect(proof.prompts[0].human_only).toBe(true)
          expect(proof.prompts[0].tool_name).toBe(tool === 'edit' ? 'Edit' : 'Bash')
        } else {
          expect(proof.prompts).toHaveLength(0)
        }
        if (source === 'peer-only' || source === 'stopped') {
          expect(proof.requests.some((row: any) => row.tool === (tool === 'edit' ? 'Edit' : 'Bash'))).toBe(false)
        }
        if (source === 'verified' || source === 'withdrawn') {
          const review = proof.requests.find((row: any) => row.tool === (tool === 'edit' ? 'Edit' : 'Bash'))
          expect(review?.content.action.script !== undefined).toBe(entry === 'script')
          if (entry === 'script') expect(review?.content.action.script.source).toContain('await tools.call')
          expect(review?.content.conversation.map((row: any) => row.origin)).toContain('operator')
        }
      }, 30_000)
    }
  }
}

for (const queued of [true, false]) {
  test(`skipping B settles ${queued ? 'prequeued' : 'fresh'} C correctly`, async () => {
    const result = await run(queued ? 'skip-queued' : 'skip-fresh')
    expect(result.files).toEqual({ a: 'new', b: 'old', c: queued ? 'old' : 'new', hooked: 'old' })
    expect(result.scripts[0].calls.map((child: any) => child.status)).toEqual(['completed', 'skipped', queued ? 'cancelled' : 'completed'])
    expect(result.prompts.every((prompt: any) => prompt.human_only)).toBe(true)
    expect(result.prompts.some((prompt: any) => String(prompt.input.file_path).endsWith('/c.txt'))).toBe(!queued)
  }, 30_000)
}

for (const outcome of ['approve', 'stop']) {
  test(`a long script wait ends on ${outcome} with the correct effect`, async () => {
    const result = await run(`wait-${outcome}`)
    expect(result.waitMs).toBeGreaterThan(900)
    expect(result.observedBeforeReply).toBeNull()
    expect(result.effect).toBe(outcome === 'approve' ? 'effect' : null)
    if (outcome === 'approve') {
      expect(result.scripts[0].status).toBe('completed')
      expect(result.scripts[0].output).toContain('after approval')
    } else {
      expect(result.sdkResults.at(-1)?.subtype).toBe('interrupted')
    }
  }, 30_000)
}

for (const limit of ['host', 'runtime']) {
  test(`the ${limit} limit is reported as a timeout`, async () => {
    const result = await run(`timeout-${limit}`)
    expect(result.scripts[0].status).toBe('failed')
    expect(result.scripts[0].error).toMatch(/time limit|computation limit/i)
    expect(result.effect).toBeNull()
  }, 30_000)
}

for (const outcome of ['allow', 'mutated', 'unavailable', 'invalid']) {
  test(`desktop resolves only the held post-hook action when review is ${outcome}`, async () => {
    const result = await run(`direct-${outcome}`)
    expect(result.prompts).toHaveLength(1)
    expect(result.prompts[0].human_only).toBe(true)
    expect(result.prompts[0].input.timeout).toBe(5_000)
    expect(result.requests[0].content.action.execution.timeoutMs).toBe(5_000)
    expect(result.observedBeforeReply).toBeNull()
    expect(result.effect).toBe(outcome === 'mutated' ? null : 'effect')
  }, 30_000)
}

test('a computed Script edit uses the rewritten target for review and leaves it untouched on denial', async () => {
  const result = await run('hook-edit')
  expect(result.requests.find((request: any) => request.tool === 'Edit')?.content.action.input.file_path).toEndWith('/hooked.txt')
  expect(result.files).toEqual({ a: 'old', b: 'old', c: 'old', hooked: 'old' })
  expect(result.prompts).toHaveLength(0)
  expect(result.scripts[0].calls[0].result.permission).toBe('denied')
}, 30_000)

for (const [surface, outcome] of [
  ['terminal', 'allow'], ['terminal', 'deny'], ['terminal', 'stop'], ['terminal', 'unavailable'],
  ['sdk', 'allow'], ['sdk', 'deny'], ['sdk', 'stop'], ['sdk', 'unavailable'],
  ['sdk', 'nohost'], ['sdk', 'automated'],
]) {
  test(`${surface} human-only approval handles ${outcome}`, async () => {
    const result = await run(`direct-${surface}-${outcome}`)
    if (outcome === 'nohost') {
      expect(result.prompts).toHaveLength(0)
      expect(result.effect).toBeNull()
      return
    }
    expect(result.prompts).toHaveLength(1)
    expect(result.prompts[0].human_only).toBe(true)
    expect(result.hookRanBeforeHuman).toBe(true)
    expect(result.observedBeforeReply).toBeNull()
    expect(result.effect).toBe(outcome === 'allow' || outcome === 'unavailable' ? 'effect' : null)
  }, 30_000)
}

test('a correction queued during the human wait invalidates the held write', async () => {
  const result = await run('wait-correction')
  expect(result.observedBeforeReply).toBeNull()
  expect(result.effect).toBeNull()
  expect(result.scripts[0].calls[0].status).toBe('failed')
}, 30_000)

for (const state of ['verified', 'stale']) {
  test(`peer script uses the ${state} parent assignment record`, async () => {
    const result = await run(`delegated-edit-parent-${state}-script`)
    const review = result.requests.find((request: any) => request.tool === 'Edit')
    expect(review?.content.assignment.parent[0].text).toBe('Update a.txt from old to new.')
    expect(result.files.a).toBe(state === 'verified' ? 'new' : 'old')
  }, 30_000)
}
