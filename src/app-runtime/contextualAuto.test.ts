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
    const trial = scenario.startsWith('trial-') || scenario.startsWith('mcp-') || scenario.startsWith('native-')
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
          : {}),
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
    expect(proof.postedNotices).toHaveLength(state === 'queued' ? 0 : 1)
    expect(proof.prompts.map((p: any) => p.tool_name)).toEqual(['Edit'])
    expect(proof.files.a).toBe('old')
    expect(proof.requests.some((row: any) => row.tool === 'Announce')).toBe(false)
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

for (const scenario of ['native-edit', 'native-edit-script', 'native-patch']) {
  test(`${scenario} makes the workspace edit without review`, async () => {
    const proof = await run(scenario)
    expect(proof.requests).toHaveLength(0)
    expect(proof.prompts).toHaveLength(0)
    expect(proof.files.a).toBe(scenario === 'native-patch' ? 'new\n' : 'new')
  }, 30_000)
}

for (const withdrawal of [false, true]) {
  test(`cleanup keeps applied changes and ${withdrawal ? 'honors a scoped withdrawal' : 'finishes its project check after a follow-up'}`, async () => {
    const proof = await run(withdrawal ? 'native-cleanup-withdrawal' : 'native-cleanup-followup')
    expect(proof.pageExists).toBe(false)
    expect(proof.cleanupFiles.slice(0, 3)).toEqual([
      'export const pages = ["/board"];', 'export const landing = "/board";', 'export const paths = ["/board"];',
    ])
    expect(proof.cleanupFiles[3]).toBe(withdrawal ? 'export const settings = { commercialDir: "photos" };' : 'export const settings = {};')
    expect(proof.effect).toBe(withdrawal ? null : 'checked')
    expect(proof.prompts).toHaveLength(0)
    const edits = proof.requests.filter((r: any) => r.tool === 'Edit')
    expect(edits).toHaveLength(1)
    expect(edits[0].content.action.input.file_path).toEndWith('/local.mjs')
    expect(edits[0].content.conversation).toContainEqual(expect.objectContaining({ origin: 'operator',
      text: 'yep. up to you', proposal: expect.objectContaining({ text: expect.stringContaining('edit-table') }) }))
  }, 30_000)
}

test('the third consecutive model denial goes to a human and approval resets the streak', async () => {
  const proof = await run('native-denials-then-ask')
  expect(proof.requests).toHaveLength(5)
  expect(proof.prompts.map((request: any) => request.tool_use_id)).toEqual(['action-2', 'action-4'])
  expect(proof.prompts.every((p: any) => p.human_only === true)).toBe(true)
  expect(proof.requests[2].content.recentShellRuns).toBeUndefined()
  expect(proof.requests[3].content.recentShellRuns).toEqual([expect.objectContaining({ attempt: 'action-2', outcome: 'completed' })])
  expect(proof.effect).toBe('effecteffect')
}, 30_000)

test('three denials without an interactive approver keep every command held', async () => {
  const proof = await run('native-denials-headless')
  expect(proof.requests).toHaveLength(5)
  expect(proof.prompts).toHaveLength(0)
  expect(proof.effect).toBeNull()
}, 30_000)

for (const stopped of [true, false]) {
  test(`a queued ${stopped ? 'withdrawal' : 'summary request'} reaches an already-permitted browser read`, async () => {
    const proof = await run(`native-browser-read-queued-${stopped ? 'stop' : 'summary'}`)
    expect(proof.browserCalls).toBe(stopped ? 0 : 1)
    expect(proof.requests.map((request: any) => request.tool)).toEqual(stopped ? ['BrowserRead'] : [])
  }, 30_000)
}

test('a completed one-time check reaches review of a new restricted check without output or old credentials', async () => {
  const proof = await run('native-two-checks')
  const { content } = proof.requests.at(-1)
  const answer = content.conversation.find((row: any) => row.text.includes('Run the launch check once.'))
  expect(answer?.origin).toBe('operator')
  expect(content.recentShellRuns).toEqual([{ attempt: 'action-1', afterOperatorId: answer.id,
    proposedCommand: 'cat a.txt | tee -a effects.txt', sandboxOverrideRequested: true, outcome: 'completed' }])
  expect(content.action.execution.sandboxOverrideRequested).toBe(false)
  expect(content.agentStatedPurpose).toBe('Verify the restricted failure path')
  expect(content.conversation.some((row: any) => row.text.startsWith('Do not push.'))).toBe(true)
  expect(JSON.stringify(proof.requests)).not.toContain('A'.repeat(36))
  expect(JSON.stringify(content)).not.toContain('"old"')
  expect(proof.effect).toBe('oldchecked')
}, 30_000)

for (const route of ['direct', 'script'] as const) {
  test(`a failed privileged ${route} check records its dispatch without sending shell output`, async () => {
    const proof = await run(route === 'direct' ? 'native-two-checks-failed' : 'native-two-checks-script-failed')
    const { content } = proof.requests.at(-1)
    const answer = content.conversation.find((row: any) => row.text.includes('Run the launch check once.'))
    const firstCheck = proof.requests.find((request: any) => request.content.action.input.dangerouslyDisableSandbox === true)
    expect(content.recentShellRuns).toEqual([{
      attempt: firstCheck.content.action.attempt, afterOperatorId: answer.id, proposedCommand: 'cat a.txt | tee -a effects.txt; exit 3',
      sandboxOverrideRequested: true, outcome: 'dispatched',
    }])
    expect(JSON.stringify(content)).not.toContain('"old"')
    expect(proof.effect).toBe('oldchecked')
  }, 30_000)
}

for (const [scenario, tool] of [['main-peer-create', 'CreatePeer'], ['main-peer-send', 'SendToPeer']] as const) {
  test(`${tool} reaches contextual review before it can affect a peer session`, async () => {
    const proof = await run(scenario)
    expect(proof.requests).toEqual([expect.objectContaining({ tool, contextual: true })])
    expect(proof.peerRequests).toBe(0)
  }, 30_000)
}

test('typed desktop question answers reach the reviewer as operator evidence without releasing a follow-up command', async () => {
  const proof = await run('question-reply')
  expect(proof.prompts).toEqual([expect.objectContaining({ tool_name: 'AskUserQuestion' })])
  expect(proof.prompts[0].human_only).toBeUndefined()
  expect(proof.requests).toHaveLength(1)
  expect(proof.requests[0].content.conversation).toContainEqual(expect.objectContaining({
    origin: 'operator', text: expect.stringContaining('Leave the file untouched.'),
  }))
  expect(proof.effect).toBeNull()
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
    const latest = proof.requests.filter((request: any) => request.tool === 'Bash').at(-1)
    expect(latest.content.conversation.at(-1)).toMatchObject({ origin: 'operator', text: expect.stringContaining('Stop') })
    const expected = { toolUseId: review.content.action.attempt, outcome: 'blocked',
      reviewer: expect.objectContaining({ verdict: 'deny' }) }
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
        contextual: true, content: expect.objectContaining({ action: expect.objectContaining({
          tool: 'mcp__fixture__records', effect: 'Invoke the named tool with the supplied arguments.', input: { key: 'sample' },
          execution: expect.objectContaining({ server: 'fixture', serverTool: 'records' }),
        }) }),
      }))
    }
    if (outcome === 'withdrawal') {
      expect(proof.requests.at(-1).content.conversation.at(-1)).toMatchObject({
        origin: 'operator', text: 'Stop. Do not access the records.',
      })
    }
  }, 30_000)
}

for (const scenario of ['native-browser', 'native-browser-peer', 'native-browser-navigate', 'native-browser-read', 'native-browser-screenshot', 'native-browser-scroll']) test(`${scenario} runs without an Auto Mode review`, async () => {
  const proof = await run(scenario)
  expect(proof.prompts).toHaveLength(0)
  expect(proof.requests).toHaveLength(0)
  expect(proof.browserCalls).toBe(1)
}, 30_000)

for (const scenario of ['mcp-browser-select', 'mcp-browser-extra', 'mcp-browser-impostor', 'mcp-browser-used', 'mcp-browser-preload']) {
  test(scenario, async () => {
    const proof = await run(scenario)
    expect(proof.requests).toHaveLength(scenario === 'mcp-browser-used' ? 2 : scenario === 'mcp-browser-select' ? 0 : 1)
    expect(proof.prompts).toHaveLength(0)
    expect(proof.mcpCalls).toHaveLength(scenario === 'mcp-browser-used' ? 2 : 1)
  }, 30_000)
}

test('an outside-workspace LSP read returns symbols without review', async () => {
  const proof = await run('native-helper-symbol-outside')
  expect(proof.requests).toHaveLength(0)
  expect(proof.prompts).toHaveLength(0)
  const result = proof.transcript.find((row: any) => row.toolUseResult?.operation === 'documentSymbol')
  expect(result?.toolUseResult.result).toContain('symbol_from_outside')
}, 30_000)

for (const source of ['chat', 'discreet', 'policy', 'workspace']) {
  test(`an audience restriction from ${source} holds a routine roster notice for review`, async () => {
    const proof = await run(`native-scope-notice-${source}`)
    expect(proof.requests.map((request: any) => request.tool)).toEqual(['Announce'])
    if (source === 'workspace') expect(proof.requests[0].content.workspaceInstructions).toContain('outside this chat')
    expect(proof.postedNotices).toHaveLength(0)
  }, 30_000)
}

for (const scenario of ['native-scope-notice', 'native-scope-notice-note', 'native-scope-notice-sensitive', 'native-scope-notice-private',
  'native-fingerprint', 'native-fingerprint-rule', 'native-scope-notice-ask', 'native-fingerprint-write',
  'native-fingerprint-parent', 'native-helper-goal', 'native-helper-symbol']) {
  test(scenario, async () => {
    const proof = await run(scenario)
    const held = ['native-fingerprint-write', 'native-fingerprint-parent'].includes(scenario)
    expect(proof.requests.length).toBe(held ? 1 : 0)
    expect(proof.prompts).toHaveLength(scenario === 'native-scope-notice-ask' ? 1 : 0)
    if (['native-scope-notice', 'native-scope-notice-note', 'native-scope-notice-sensitive'].includes(scenario)) expect(proof.postedNotices).toHaveLength(1)
    if (scenario === 'native-scope-notice-private' || scenario === 'native-scope-notice-ask') expect(proof.postedNotices).toHaveLength(0)
    if (scenario.startsWith('native-fingerprint') && scenario !== 'native-fingerprint-write') {
      const result = proof.transcript.find((row: any) =>
        row.message?.content?.some?.((block: any) => block.tool_use_id === 'action-0'))
      expect(Boolean(result?.message.content[0].is_error)).toBe(scenario === 'native-fingerprint-rule')
      if (scenario === 'native-fingerprint' || scenario === 'native-fingerprint-parent') {
        expect(result.toolUseResult.stdout.trim()).toMatch(/^[a-f0-9]{40}$/)
      }
    }
    if (scenario === 'native-helper-symbol') {
      const result = proof.transcript.find((row: any) => row.toolUseResult?.operation === 'documentSymbol')
      expect(result?.toolUseResult.result).toContain('symbol_from_old')
    }
    if (scenario === 'native-helper-goal') expect(proof.transcript.some((row: any) =>
      row.sourceToolAssistantUUID && row.message?.content?.some?.((block: any) => block.type === 'tool_result'))).toBe(true)
  }, 30_000)
}

test('contextual Auto admits Script once and reviews both Bash children', async () => {
  const proof = await run('native-script-children')
  expect(proof.requests.map((request: any) => request.tool)).toEqual(['Bash', 'Bash'])
  expect(proof.prompts).toHaveLength(0)
  expect(proof.effect).toBe('effecteffect')
}, 30_000)

for (const [scenario, reviewed] of [['logs', false], ['peer', false], ['credential', true], ['nested-token', true]] as const) {
  test(`outside-workspace Bash search (${scenario}) follows the credential boundary`, async () => {
    const proof = await run(`native-outside-read-${scenario}`)
    expect(proof.requests.map((request: any) => request.tool)).toEqual(reviewed ? ['Bash'] : [])
    expect(proof.prompts).toHaveLength(0)
    expect(proof.transcript.some((row: any) => row.toolUseResult?.stdout?.includes('outside_search_marker'))).toBe(true)
  }, 30_000)
}

for (const source of ['user', 'project', 'open', 'missing']) {
  test(`MCP read from ${source} uses the configured scope and explicit closed-world hint`, async () => {
    const proof = await run(`mcp-read-${source}`)
    expect(proof.requests.map((request: any) => request.tool)).toEqual(source === 'user' ? [] : ['mcp__fixture__records'])
    expect(proof.prompts).toHaveLength(0)
    expect(proof.mcpCalls).toHaveLength(1)
  }, 30_000)
}

for (const target of ['git-hook', 'claude-settings', 'editor-settings']) {
  test(`Auto still reviews an in-workspace write to ${target}`, async () => {
    const proof = await run(`native-write-${target}`)
    expect(proof.requests.map((request: any) => request.tool)).toEqual(['Write'])
    expect(proof.prompts).toHaveLength(0)
    expect(proof.sensitiveFileExists).toBe(false)
  }, 30_000)
}

test('desktop Auto Mode loads an ordinary skill without optional arguments or a review', async () => {
  const proof = await run('native-skill')
  expect(proof.requests).toHaveLength(0)
  expect(proof.prompts).toHaveLength(0)
  expect(JSON.stringify(proof.transcript)).toContain('AUTO_SKILL_INSTRUCTIONS_LOADED')
}, 30_000)

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
