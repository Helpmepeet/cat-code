import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixture = new URL('./contextualAuto.fixture.ts', import.meta.url).pathname

async function run(scenario: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cat-contextual-auto-')))
  try {
    await Promise.all([mkdir(join(root, 'config')), mkdir(join(root, 'workspace'))])
    const child = Bun.spawn([process.execPath, '--feature=CODE_MODE', '--feature=TRANSCRIPT_CLASSIFIER',
      '--feature=AUTO_MODE_UPSTREAM_PORT', '--feature=AUTO_MODE_CONTEXTUAL_REVIEW', fixture], {
      cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
      env: {
        PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        ANTHROPIC_API_KEY: 'isolated-fixture', CLAUDE_CODE_USE_OPENAI: '0',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        NODE_ENV: 'test', TEST_ENABLE_SESSION_PERSISTENCE: '1', CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-sonnet-5-5',
        CLAUDE_CODE_CONTEXTUAL_AUTO_MODE: 'experimental',
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

for (const receipt of ['matching', 'other-child']) {
  test(`legacy notice with ${receipt} creation receipt cannot authorize the next edit`, async () => {
    const proof = await run(`legacy-notice-${receipt}`)
    const matching = receipt === 'matching'
    expect(proof.postedNotices).toHaveLength(matching ? 1 : 0)
    expect(proof.prompts.map((p: any) => p.tool_name)).toEqual(matching ? ['Edit'] : ['Announce', 'Edit'])
    expect(proof.files.a).toBe('old')
    const notice = proof.requests.find((row: any) => row.tool === 'Announce')
    if (matching) expect(notice.content.assignment.parent).toContainEqual(expect.objectContaining({
      origin: 'operator', text: 'Have a helper inspect a.txt. Leave it untouched.',
    }))
    else expect(notice).toBeUndefined()
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
