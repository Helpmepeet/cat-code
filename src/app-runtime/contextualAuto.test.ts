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
              ...(scenario === 'trial-legacy' && { CLAUDE_CODE_CONTEXTUAL_AUTO_MODE: 'legacy' }),
              ...(scenario === 'native-web-search-legacy' && { CLAUDE_CODE_CONTEXTUAL_AUTO_MODE: 'legacy' }),
              ...(scenario.endsWith('-shadow') && { CLAUDE_CODE_CONTEXTUAL_AUTO_MODE: 'shadow' }) }
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
  test(`legacy notice and workspace edit respect the ${state} parent state`, async () => {
    const proof = await run(`legacy-notice-${state}`)
    expect(proof.postedNotices).toHaveLength(state === 'queued' ? 0 : 1)
    expect(proof.prompts).toHaveLength(0)
    expect(proof.files.a).toBe(state === 'queued' ? 'old' : 'new')
    expect(proof.requests).toHaveLength(0)
  }, 30_000)
}

for (const state of ['host-identity', 'relay-marker']) {
  test(`a compacted chat with ${state} can make an ordinary edit without review`, async () => {
    const proof = await run(`compacted-${state}`)
    expect(proof.files.a).toBe('new')
    expect(proof.prompts).toHaveLength(0)
    expect(proof.requests).toHaveLength(0)
  }, 30_000)

  test(`a compacted chat with ${state} shows the correct actor during review`, async () => {
    const proof = await run(`compacted-${state}-review`)
    const actor = state === 'host-identity' ? 'peer-session' : 'main'
    expect(proof.requests.map((request: any) => request.tool)).toEqual(['Bash'])
    expect(proof.requests[0].content.action.actor).toBe(actor)
    expect(proof.requests[0].content.assignment).toEqual(state === 'host-identity' ? { actor, origin: 'peer' } : undefined)
    expect(proof.effect).toBe('effect')
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

for (const mode of ['experimental', 'shadow', 'legacy']) {
  test(`native WebSearch runs without Auto review in ${mode} mode`, async () => {
    const proof = await run(`native-web-search-${mode}`)
    expect(proof.requests).toHaveLength(0)
    expect(proof.prompts).toHaveLength(0)
    expect(proof.reviewEvents).toHaveLength(0)
    expect(proof.transcript).toContainEqual(expect.objectContaining({
      toolUseResult: expect.objectContaining({ query: 'Bun test documentation', summary: 'Fixture search completed.' }),
    }))
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

test('the third consecutive model denial tells the agent to report the blocker in chat', async () => {
  const proof = await run('native-denials-then-ask')
  expect(proof.requests).toHaveLength(5)
  expect(proof.prompts).toHaveLength(0)
  expect(proof.effect).toBeNull()
  expect(proof.reviewEvents).toContainEqual(expect.objectContaining({
    toolUseId: 'action-2', outcome: 'blocked', reason: expect.stringContaining('Stop and report the blocker in chat'),
  }))
}, 30_000)

test('a third Script child denial across cells reports the blocker and queued cancellation to the model', async () => {
  const proof = await run('native-denials-script')
  expect(proof.requests.map((request: any) => request.tool)).toEqual(['Bash', 'Bash', 'Bash'])
  expect(proof.prompts).toHaveLength(0)
  expect(proof.effect).toBeNull()
  expect(proof.files.a).toBe('old')
  const third = proof.modelToolResults['action-2']
  expect(third).toContain('3 consecutive actions were denied. Stop and report the blocker in chat.')
  expect(third).toContain('Queued action cancelled after Auto Mode denied an earlier action.')
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

test('v7 sends only custom Auto Mode rules and redacts credentials in them', async () => {
  const proof = await run('direct-credential-settings')
  expect(proof.requests).toHaveLength(1)
  const system = proof.requests[0].system.at(-1).text
  expect(system).toStartWith('cat-code-contextual-review-v7')
  expect(JSON.parse(system.slice(system.lastIndexOf('\n\n') + 2))).toEqual([{
    source: 'userSettings',
    allow: ['Synthetic example password = […]'],
    soft_deny: ['Avoid changes to shared fixture state.'],
    environment: ['This fixture uses a local database.'],
  }])
  expect(system).not.toContain('fixturePass98765')
  expect(proof.prompts).toHaveLength(0)
  expect(proof.effect).toBe('effect')
}, 30_000)

test('the request keeps action and operator intent while redacting credentials in both', async () => {
  const proof = await run('native-credential-complete')
  expect(proof.requests).toHaveLength(1)
  const { action, conversation } = proof.requests[0].content
  expect(action.input.command).toContain('password=[…] printf effect >> effects.txt')
  expect(conversation.findLast((row: any) => row.origin === 'operator').text).toContain('configure the local destination.\n[…]')
  expect(JSON.stringify(proof.requests)).not.toMatch(/actionSecretFixture123|fixture-private-key-body/)
  expect(proof.prompts).toHaveLength(0)
  expect(proof.effect).toBe('effect')
}, 30_000)

test('an incomplete private key prevents the action without a review or human prompt', async () => {
  const proof = await run('native-credential-incomplete')
  expect(proof.requests).toHaveLength(0)
  expect(proof.prompts).toHaveLength(0)
  expect(proof.effect).toBeNull()
  expect(proof.reviewEvents).toContainEqual(expect.objectContaining({ outcome: 'blocked', reason: expect.stringContaining('could not safely redact') }))
}, 30_000)

test('over-budget review keeps the early operator restriction and marks omitted context', async () => {
  const proof = await run('native-oversize-history')
  expect(proof.requests).toHaveLength(1)
  const { action, conversation } = proof.requests[0].content
  expect(action.input.command).toBe('printf effect >> effects.txt')
  expect(proof.effect).toBeNull()
  expect(conversation).toContainEqual(expect.objectContaining({
    origin: 'operator', text: 'Do not write to effects.txt in this investigation.',
  }))
  expect(conversation).toContainEqual(expect.objectContaining({
    origin: 'other', text: expect.stringMatching(/conversation entries were omitted/i),
  }))
  expect(conversation.findLast((row: any) => row.origin === 'operator').text).toBe('Run the isolated action and report the result.')
  expect(JSON.stringify(conversation)).not.toContain('OVERSIZE_EARLIER_CONTEXT')
  expect(proof.prompts).toHaveLength(0)
}, 30_000)

test('over-budget operator instructions are held for a one-action decision', async () => {
  const proof = await run('native-oversize-operator-history')
  expect(proof.requests).toHaveLength(0)
  expect(proof.prompts).toEqual([expect.objectContaining({
    human_only: true, input: expect.objectContaining({ command: 'printf effect >> effects.txt' }),
    decision_reason: expect.stringContaining('could not review this action'),
  })])
  expect(proof.effect).toBeNull()
}, 30_000)

test('an oversize action alone offers the exact input and resolved target for approval', async () => {
  const proof = await run('native-oversize-action')
  expect(proof.requests).toHaveLength(0)
  expect(proof.prompts).toEqual([expect.objectContaining({
    human_only: true, input: expect.objectContaining({ content: 'x'.repeat(300_000) }),
    decision_reason: expect.stringMatching(/could not review this action.*\.vscode\/settings\.json/),
  })])
  expect(proof.sensitiveFileExists).toBe(false)
}, 30_000)

for (const scenario of ['direct-late-correction', 'background-withdrawal']) {
  test(`${scenario} discards a pending model allowance and records the reason`, async () => {
    const proof = await run(scenario)
    const review = proof.requests.find((request: any) => request.tool === 'Bash')
    expect(review?.contextual).toBe(true)
    expect(proof.effect).toBeNull()
    const reviews = proof.requests.filter((request: any) => request.tool === 'Bash')
    const script = scenario === 'background-withdrawal'
    expect(reviews).toHaveLength(script ? 1 : 2)
    if (!script) expect(reviews.at(-1).content.conversation.at(-1)).toMatchObject({
      origin: 'operator', text: expect.stringContaining('Stop'),
    })
    const expected = { toolUseId: review.content.action.attempt, outcome: script ? 'inconclusive' : 'blocked',
      reviewer: expect.objectContaining({ verdict: script ? 'allow' : 'deny' }) }
    expect(proof.reviewEvents).toContainEqual(expect.objectContaining(expected))
    expect(proof.savedReviews).toContainEqual(expect.objectContaining(expected))
    if (script) {
      expect(proof.reviewUsage.ends.filter((end: any) => end.route === 'contextual')).toEqual([
        expect.objectContaining({ raw_result: 'deny', disposition: 'operational_error' }),
      ])
      expect(proof.reviewUsage.ends.find((end: any) => end.route === 'contextual')).not.toHaveProperty('cause')
      expect(proof.reviewUsage.outcomes).toMatchObject({ policy_blocked: 0, operational_error: 1 })
      const bash = proof.scripts.at(-1).calls.find((call: any) => call.name === 'Bash')
      expect(bash?.error).toContain('The reviewer allowed this action. The engine held the action')
      expect(proof.scripts.at(-1).output).toContain('The reviewer allowed this action. The engine held the action')
    }
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

test('shadow preserves the main actor and peer correspondence while the legacy allowance releases the write', async () => {
  const proof = await run('native-peer-write-shadow')
  const candidates = proof.requests.filter((request: any) => request.contextual)
  expect(candidates).toHaveLength(1)
  expect(JSON.stringify(candidates[0].system)).toContain('cat-code-contextual-review-v7')
  expect(candidates[0].content.action.actor).toBe('main')
  expect(candidates[0].content.assignment).toBeUndefined()
  expect(candidates[0].content.conversation).toContainEqual(expect.objectContaining({ origin: 'peer', actor: 'Lead',
    text: 'Update a.txt from old to new.' }))
  expect(proof.requests.some((request: any) => !request.contextual)).toBe(true)
  expect(proof.prompts).toHaveLength(0)
  expect(proof.effect).toBe('effect')
}, 30_000)

test('shadow skips contextual review of a routine notice and the notice posts', async () => {
  const proof = await run('native-scope-notice-shadow')
  expect(proof.requests.length).toBeGreaterThan(0)
  expect(proof.requests.every((request: any) => !request.contextual)).toBe(true)
  expect(proof.prompts).toHaveLength(0)
  expect(proof.postedNotices).toHaveLength(1)
}, 30_000)

for (const outcome of ['allow', 'deny', 'withdrawal', 'peer-only']) {
  test(`desktop Auto Mode holds a real MCP search through ${outcome}`, async () => {
    const proof = await run(`mcp-${outcome}`)
    expect(proof.mcpCalls).toHaveLength(outcome === 'allow' || outcome === 'peer-only' ? 1 : 0)
    expect(proof.prompts).toHaveLength(0)
    expect(proof.requests).toContainEqual(expect.objectContaining({
      contextual: true, content: expect.objectContaining({ action: expect.objectContaining({
        tool: 'mcp__fixture__records', effect: 'Invoke the named tool with the supplied arguments.', input: { key: 'sample' },
        execution: expect.objectContaining({ server: 'fixture', serverTool: 'records' }),
      }) }),
    }))
    if (outcome === 'peer-only') {
      const { action, assignment, conversation } = proof.requests[0].content
      expect(action.actor).toBe('main')
      expect(assignment).toBeUndefined()
      expect(conversation).toContainEqual(expect.objectContaining({ origin: 'peer', actor: 'Lead', text: 'Look up the sample record.' }))
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

for (const { scenario, followUp, posts } of [
  { scenario: 'private-follow-up', followUp: 'Also check the logs.', posts: 0 },
  { scenario: 'private-reauthorized', followUp: 'You may now post a scope notice about this investigation.', posts: 1 },
]) {
  test(`an earlier roster privacy veto reaches review for ${scenario}`, async () => {
    const proof = await run(`native-scope-notice-${scenario}`)
    expect(proof.postedNotices).toHaveLength(posts)
    expect(proof.requests.map((request: any) => request.tool)).toEqual(['Announce'])
    expect(proof.requests[0].content.conversation
      .filter((row: any) => row.origin === 'operator').map((row: any) => row.text))
      .toEqual(['Investigate the Chrome crash. Keep this investigation private.', followUp])
    expect(proof.prompts).toHaveLength(0)
  }, 30_000)
}

test('workspace maintenance instructions do not send an Announce notice to review', async () => {
  const proof = await run('native-scope-notice-workspace-maintenance')
  expect(proof.requests).toHaveLength(0)
  expect(proof.prompts).toHaveLength(0)
  expect(proof.postedNotices).toHaveLength(1)
}, 30_000)

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

test('the Write reviewer receives proposed changes relative to the complete read', async () => {
  const proof = await run('native-write-complete-read')
  expect(proof.requests.map((request: any) => request.tool)).toEqual(['Write'])
  const [review] = proof.requests
  expect(review.content.action.execution).toMatchObject({
    operation: 'overwrite',
    proposedChangesFromLastCompleteRead: { addedLines: 1, removedLines: 1 },
  })
  expect(review.content.action.execution).not.toHaveProperty('changeSinceCompleteRead')
  expect(JSON.stringify(review.system)).toContain(
    'These counts do not establish that another writer changed the file.',
  )
  expect(proof.prompts).toHaveLength(0)
  expect(proof.replacement).toBe('{ "editor.tabSize": 4 }\n')
}, 30_000)

test('desktop Auto Mode loads an ordinary skill without optional arguments or a review', async () => {
  const proof = await run('native-skill')
  expect(proof.requests).toHaveLength(0)
  expect(proof.prompts).toHaveLength(0)
  expect(JSON.stringify(proof.transcript)).toContain('AUTO_SKILL_INSTRUCTIONS_LOADED')
}, 30_000)

test('desktop Auto Mode honors a named skill ask before its named and routine allowances', async () => {
  const proof = await run('native-skill-ask')
  expect(proof.requests).toHaveLength(0)
  expect(proof.prompts).toEqual([expect.objectContaining({ tool_name: 'Skill', human_only: true })])
  expect(JSON.stringify(proof.transcript)).not.toContain('AUTO_SKILL_INSTRUCTIONS_LOADED')
}, 30_000)

for (const scope of ['inline', 'fork'] as const) {
  test(`desktop Auto review receives the parsed grants and scope of a ${scope} skill`, async () => {
    const proof = await run(`native-skill-${scope}`)
    expect(proof.prompts).toHaveLength(0)
    expect(proof.requests.map((request: any) => request.tool)).toEqual(['Skill'])
    expect(proof.requests[0].content.action.execution.skillGrants).toMatchObject({
      source: 'userSettings',
      scope: scope === 'inline' ? 'command' : 'worker',
      allowedTools: ['Bash(printf fixture:*)'],
      ...(scope === 'fork' && { worker: { agentType: 'fixture-skilled-worker', source: 'projectSettings', tools: ['Bash'] } }),
    })
    expect(JSON.stringify(proof.transcript)).toContain(scope === 'inline' ? 'AUTO_SKILL_INSTRUCTIONS_LOADED' : '"status":"forked"')
  }, 30_000)
}

test('desktop Auto holds a skill when its grants change during review', async () => {
  const proof = await run('native-skill-changed')
  expect(proof.requests.map((request: any) => request.tool)).toEqual(['Skill'])
  expect(JSON.stringify(proof.transcript)).toContain('The skill permissions changed during review.')
  expect(JSON.stringify(proof.transcript)).not.toContain('AUTO_SKILL_INSTRUCTIONS_LOADED')
}, 30_000)

for (const entry of ['direct', 'script']) {
  for (const tool of ['edit', 'bash']) {
    for (const source of ['verified', 'peer-only', 'withdrawn', 'stopped']) {
      test(`${entry} ${tool} respects ${source} authority`, async () => {
        const parentWithdrawal = tool === 'edit' && source === 'withdrawn'
        const proof = await run(`delegated-${tool}-${parentWithdrawal ? 'parent-' : ''}${source}-${entry}`)
        const released = source === 'verified' || source === 'peer-only'
        expect(tool === 'edit' ? proof.files.a : proof.effect).toBe(
          tool === 'edit' ? released ? 'new' : 'old' : released ? 'effect' : null,
        )
        expect(proof.prompts).toHaveLength(0)
        const reviewed = source !== 'stopped' && (tool === 'bash' || parentWithdrawal)
        expect(proof.requests.map((row: any) => row.tool)).toEqual(reviewed ? [tool === 'edit' ? 'Edit' : 'Bash'] : [])
        if (!reviewed) return
        const { action, conversation, assignment } = proof.requests[0].content
        expect(action.script !== undefined).toBe(entry === 'script')
        if (entry === 'script') expect(action.script.source).toContain('await tools.call')
        if (parentWithdrawal) {
          const [grant, withdrawal] = assignment.parent
          expect(assignment.parentAnchor).toBe(grant.id)
          expect(withdrawal).toMatchObject({ origin: 'operator', text: 'Stop this job. Leave all files as they are.' })
          expect(proof.reviewEvents).toContainEqual(expect.objectContaining({ outcome: 'blocked', reviewer: expect.objectContaining({ verdict: 'deny' }) }))
        } else if (source === 'peer-only') {
          expect(assignment).toBeUndefined()
          expect(conversation).toContainEqual(expect.objectContaining({ origin: 'peer', actor: 'Lead',
            text: 'Append one effect marker to effects.txt.' }))
        } else expect(conversation.map((row: any) => row.origin)).toContain('operator')
      }, 30_000)
    }
  }
}

test('a peer session runs an in-workspace git status and Edit without review', async () => {
  const proof = await run('delegated-git-status-script')
  expect(proof.requests).toHaveLength(0)
  expect(proof.prompts).toHaveLength(0)
  expect(proof.scripts[0].output).toContain('On branch')
  expect(proof.files.a).toBe('new')
}, 30_000)

test('a later local operator message in a peer session does not trigger review', async () => {
  const proof = await run('delegated-local-follow-up-direct')
  expect(proof.requests).toHaveLength(0)
  expect(proof.prompts).toHaveLength(0)
  expect(proof.files.a).toBe('new')
}, 30_000)

test('a subagent runs base-allowed edits and reviews an outside deletion and database write', async () => {
  const proof = await run('native-subagent-routing')
  expect(proof.prompts).toHaveLength(0)
  const reviews = proof.requests.filter((row: any) => row.contextual)
  expect(reviews.map((row: any) => row.tool)).toEqual(['Bash', 'Bash'])
  const [remove, database] = reviews.map((row: any) => row.content)
  expect(remove.action.input.command).toMatch(/^rm -rf '.*\/outside-build'$/)
  expect(database.action.input.command).toMatch(/^sqlite3 fixture\.db /)
  expect(remove.assignment).toMatchObject({ origin: 'worker-launch', sender: 'main', parentAnchor: expect.any(String) })
  expect(proof.files.a).toBe('new')
  expect(proof.buildExists).toBe(false)
  expect(proof.outsideBuildExists).toBe(false)
  expect(proof.workerDatabase).toBe('new')
}, 30_000)

for (const scope of ['accepted', 'refused', 'global', 'parent-verified']) {
  test(`outbound worker restrictions do not govern the sender (${scope} launch)`, async () => {
    const proof = await run(`native-subagent-scope-${scope}`)
    const packets = proof.requests.filter((row: any) => row.tool === 'Bash').map((row: any) => row.content)
    const sender = scope === 'parent-verified' ? 'peer-session' : 'main'
    const [parent, worker] = [packets.find((packet: any) => packet.action.actor === sender),
      packets.find((packet: any) => packet.assignment?.origin === 'worker-launch')]
    const restriction = 'Worker fixture: inspect the task. Do not append to effects.txt.'
    expect(parent?.conversation).not.toContainEqual(expect.objectContaining({ text: restriction }))
    if (scope === 'refused') expect(worker).toBeUndefined()
    else {
      expect(worker?.action.input.command).toBe(parent.action.input.command)
      expect(worker.assignment).toMatchObject({ text: restriction, sender })
    }
    if (scope === 'parent-verified') expect(parent.assignment).toMatchObject({ origin: 'peer', parentAnchor: expect.any(String) })
    if (scope === 'global') {
      const operator = expect.objectContaining({ origin: 'operator', text: 'Neither you nor the worker may append to effects.txt.' })
      expect(parent.conversation).toContainEqual(operator)
      expect(worker.assignment.parent).toContainEqual(operator)
    }
    expect(proof.effect).toBe(scope === 'global' ? null : 'effect')
    expect(proof.prompts).toHaveLength(0)
  }, 30_000)
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
      expect(result.sdkResults).toContainEqual(expect.objectContaining({ subtype: 'interrupted' }))
      expect(result.modelToolResults['action-0']).toContain('Code Mode execution cancelled')
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

for (const outcome of ['allow', 'mutated']) {
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

for (const [outcome, cause] of [
  ['unavailable', 'unavailable'],
  ['invalid', 'invalid_response'],
  ['denied', undefined],
] as const) {
  test(`desktop fails closed without a prompt when review is ${outcome}`, async () => {
    const proof = await run(`direct-${outcome}`)
    expect(proof.requests).toHaveLength(1)
    expect(proof.prompts).toHaveLength(0)
    expect(proof.effect).toBeNull()
    expect(proof.reviewEvents).toContainEqual(expect.objectContaining(cause
      ? { outcome: 'inconclusive', reason: expect.stringContaining('Retry or report the blocker in chat') }
      : { outcome: 'blocked', reason: 'Isolated review decision.' }))
    expect(proof.reviewUsage.ends).toEqual([expect.objectContaining({
      raw_result: 'deny', route: 'contextual',
      disposition: cause ? 'operational_error' : 'policy_blocked',
      ...(cause && { cause }),
    })])
    expect(proof.reviewUsage.outcomes).toMatchObject({
      operational_error: cause ? 1 : 0,
      policy_blocked: cause ? 0 : 1,
    })
  }, 30_000)
}

test('a computed Script edit uses the rewritten target for review and leaves it untouched on denial', async () => {
  const result = await run('hook-edit')
  expect(result.requests.find((request: any) => request.tool === 'Edit')?.content.action.input.file_path).toEndWith('/.vscode/settings.json')
  expect(result.files).toEqual({ a: 'old', b: 'old', c: 'old', hooked: 'old' })
  expect(result.protectedEdit).toBe('old')
  expect(result.prompts).toHaveLength(0)
  expect(result.scripts[0].calls.find((call: any) => call.name === 'Edit')?.result.permission).toBe('denied')
  expect(result.modelToolResults['action-0']).toContain('Edit: Denied by Auto Mode. Isolated review decision.')
}, 30_000)

test('a throwing Script child reports a failed review to the model', async () => {
  const proof = await run('script-review-unavailable')
  expect(proof.requests).toHaveLength(1)
  expect(proof.prompts).toHaveLength(0)
  expect(proof.effect).toBeNull()
  expect(proof.modelToolResults['action-0']).toContain('Bash: Auto Mode review failed. Auto Mode could not complete the Script review.')
}, 30_000)

test('a throwing Script child reports a human skip to the model', async () => {
  const proof = await run('skip-throwing')
  expect(proof.prompts).toHaveLength(1)
  expect(proof.files.b).toBe('old')
  expect(proof.modelToolResults['action-0']).toContain('Edit: Skipped by the user.')
}, 30_000)

test('a hook allow lets a routine peer edit run without review', async () => {
  const proof = await run('delegated-hook-allow-direct')
  expect(proof.hookRan).toBe(true)
  expect(proof.requests).toHaveLength(0)
  expect(proof.prompts).toHaveLength(0)
  expect(proof.files.a).toBe('new')
}, 30_000)

for (const [surface, outcome] of [
  ['terminal', 'allow'], ['terminal', 'deny'], ['terminal', 'stop'], ['terminal', 'unavailable'],
  ['sdk', 'allow'], ['sdk', 'deny'], ['sdk', 'stop'], ['sdk', 'unavailable'],
  ['sdk', 'nohost'], ['sdk', 'automated'],
]) {
  test(`${surface} human-only approval handles ${outcome}`, async () => {
    const result = await run(`direct-${surface}-${outcome}`)
    if (outcome === 'nohost' || outcome === 'unavailable') {
      expect(result.prompts).toHaveLength(0)
      expect(result.effect).toBeNull()
      return
    }
    expect(result.prompts).toHaveLength(1)
    expect(result.prompts[0].human_only).toBe(true)
    expect(result.hookRanBeforeHuman).toBe(true)
    expect(result.observedBeforeReply).toBeNull()
    expect(result.effect).toBe(outcome === 'allow' ? 'effect' : null)
  }, 30_000)
}

test('a correction queued during the human wait invalidates the held write', async () => {
  const result = await run('wait-correction')
  expect(result.observedBeforeReply).toBeNull()
  expect(result.effect).toBeNull()
  expect(result.requests).toHaveLength(1)
  expect(result.scripts[0].calls[0].status).toBe('blocked')
}, 30_000)

for (const state of ['verified', 'stale']) {
  test(`peer script uses the ${state} parent assignment record`, async () => {
    const result = await run(`delegated-edit-parent-${state}-script`)
    const review = result.requests.find((request: any) => request.tool === 'Edit')
    expect(result.prompts).toHaveLength(0)
    const { parent, parentAnchor } = review.content.assignment
    expect(parentAnchor).toBe(parent[0].id)
    if (state === 'verified') {
      expect(parent[0].text).toBe('Update .vscode/settings.json from old to new.')
      expect(result.protectedEdit).toBe('new')
    } else {
      expect(parent[0].text).toBe('Update a.txt from old to new.')
      expect(parent[1].text).toBe('Stop this edit and leave the file in place.')
      expect(result.files.a).toBe('old')
      expect(result.reviewEvents).toContainEqual(expect.objectContaining({ outcome: 'blocked', reviewer: expect.objectContaining({ verdict: 'deny' }) }))
    }
  }, 30_000)
}
