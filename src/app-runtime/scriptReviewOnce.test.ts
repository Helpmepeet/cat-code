import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSidecarLaunch } from '../../app/main/mainDecisions.js'

const fixture = new URL('./contextualAuto.fixture.ts', import.meta.url).pathname

async function run(scenario: string, extraEnv: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cat-script-review-once-')))
  try {
    await Promise.all([mkdir(join(root, 'config')), mkdir(join(root, 'workspace'))])
    const runtimeArgs = resolveSidecarLaunch({
      mainDir: new URL('../../app/main/', import.meta.url).pathname,
      packaged: false,
    }).argsFor('session').slice(0, -1)
    const child = Bun.spawn([process.execPath, ...runtimeArgs, fixture], {
      cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
      env: {
        PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        ANTHROPIC_API_KEY: 'isolated-fixture', CLAUDE_CODE_USE_OPENAI: '0',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        NODE_ENV: 'test', TEST_ENABLE_SESSION_PERSISTENCE: '1',
        CLAUDE_CODE_AUTO_MODE_MODEL: 'gpt-6-luna', CATCODE_SIDECAR_SESSION_ID: 'desktop-session',
        CONTEXTUAL_AUTO_TEST_ROOT: root, CONTEXTUAL_AUTO_TEST_SCENARIO: scenario, ...extraEnv,
      },
    })
    const timeout = setTimeout(() => child.kill(), 25_000)
    const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timeout)
    if (exit !== 0) throw new Error(`Fixture ${scenario} exited ${exit}\n${error}\n${output}`)
    const proof = JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
    return { ...proof, scripts: proof.transcript
      .map((row: any) => row.toolUseResult)
      .filter((result: any) => result?.kind === 'code-mode' && result.status !== 'running') }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}


type Cell = { code: string; run_in_background?: boolean }
const cells = (...inputs: (string | Cell)[]) => ({
  CONTEXTUAL_AUTO_TEST_SCRIPT_CELLS: JSON.stringify(inputs.map(input => typeof input === 'string' ? { code: input } : input)),
})
const bash = (command: string) => `tools.call(${JSON.stringify({ name: 'Bash', input: { command }, nothrow: true })})`
const write = `await ${bash('printf effect >> effects.txt')};`
const twoWrites = write + '\n' + write
const queue = (first: string, second: string) => `await Promise.all([${bash(first)}, ${bash(second)}]);`
const queued = queue('printf effect >> effects.txt', 'printf queued >> effects.txt')
const coverNote = 'Yes covers the rest of this Script without another model review.'

const skillCall = 'tools.call({name:"Skill",input:{skill:"fixture-auto-skill"},nothrow:true})'
const skillShellRefusal = 'Embedded Skill shell commands are unavailable in Auto Mode Scripts.'

test('a Script Skill cannot send embedded shell to a separate reviewer', async () => {
  const proof = await run('native-skill', {
    ...cells('await ' + skillCall + ';'),
    CONTEXTUAL_AUTO_TEST_SKILL_SHELL: 'inline',
  })
  expect(proof.requests).toHaveLength(0)
  expect(proof.prompts).toHaveLength(0)
  expect(proof.effect).toBeNull()
  expect(proof.scripts[0].calls[0].error).toContain(skillShellRefusal)
  expect(proof.scripts[0].status).toBe('blocked')
}, 30_000)

test('a covering allow and a Skill author rule cannot release embedded shell or queued effects', async () => {
  const source = write + 'await Promise.all([' + skillCall + ',' + bash('printf queued >> effects.txt') + ']);'
  const proof = await run('native-skill-inline', {
    ...cells(source),
    CONTEXTUAL_AUTO_TEST_SKILL_SHELL: 'block',
  })
  expect(proof.requests.map((request: any) => request.tool)).toEqual(['Bash'])
  expect(proof.prompts).toHaveLength(0)
  expect(proof.effect).toBe('effect')
  expect(proof.scripts[0].calls[1].error).toContain(skillShellRefusal)
  expect(proof.scripts[0].status).toBe('blocked')
}, 30_000)

test('ordinary Skill text still reaches the model from a contextual Auto Script', async () => {
  const proof = await run('native-skill', cells('await ' + skillCall + ';'))
  expect(proof.requests).toHaveLength(0)
  expect(proof.scripts[0].calls[0].status).toBe('completed')
  expect(JSON.stringify(proof.transcript)).toContain('AUTO_SKILL_INSTRUCTIONS_LOADED')
}, 30_000)

for (const [name, env] of [
  ['a direct contextual Auto Skill', {}],
  ['a legacy Auto Script Skill', {
    ...cells('await ' + skillCall + ';'),
    CLAUDE_CODE_CONTEXTUAL_AUTO_MODE: 'legacy',
  }],
] as const) {
  test(name + ' still expands embedded shell', async () => {
    const proof = await run('native-skill-inline', {
      ...env,
      CONTEXTUAL_AUTO_TEST_SKILL_SHELL: 'inline',
    })
    expect(proof.effect).toBe('fixture')
    expect(JSON.stringify(proof.transcript)).toContain('AUTO_SKILL_INSTRUCTIONS_LOADED')
  }, 30_000)
}

for (const [model, route] of [['claude-sonnet-5-5', 'firstParty'], ['gpt-6.2-sol', 'openai']]) {
  test(`${route} task route reviews eleven log inspections once and executes each read`, async () => {
    const reads = Array.from({ length: 11 }, (_, index) => {
      const command = `${JSON.stringify(process.execPath)} -e 'console.log((await Bun.file("logs/row-${index}.log").text()).trim())'`
      return `output((await ${bash(command)}).data.stdout.trim());`
    }).join('\n')
    const proof = await run('native-script-log-inspection', {
      ...cells(reads), CONTEXTUAL_AUTO_TEST_MODEL: model,
    })
    expect(new Set(proof.taskRoutes)).toEqual(new Set([route]))
    expect(proof.requests.map((request: any) => request.tool)).toEqual(['Bash'])
    expect(proof.reviewEvents.map((event: any) => event.outcome)).toEqual(['reviewing', 'allowed'])
    expect(new Set(proof.reviewEvents.map((event: any) => event.toolUseId)).size).toBe(1)
    expect(proof.requests[0].content.action.script.source).toContain(reads)
    expect(proof.requests[0].content.action).toMatchObject({
      input: { command: expect.stringContaining('row-0.log') },
      effect: 'Execute the complete shell command in the effective working directory.',
    })
    expect(proof.prompts).toHaveLength(0)
    expect(proof.scripts[0].calls.map((call: any) => call.status)).toEqual(Array(11).fill('completed'))
    expect(proof.scripts[0].output.split('\n').slice(0, 11)).toEqual(Array.from({ length: 11 }, (_, index) => `report-line-${index}`))
  }, 30_000)
}

for (const answer of ['approve', 'decline', 'unavailable']) {
  test(`whole-Script ask with human answer ${answer} gates the held action and queued effects`, async () => {
    const proof = await run(answer === 'unavailable' ? 'native-script-no-human' : 'native-script-children', {
      ...cells(queued + write),
      CONTEXTUAL_AUTO_TEST_SCRIPT_ASK: answer,
    })
    expect(proof.requests.map((request: any) => request.tool)).toEqual(['Bash'])
    expect(proof.prompts).toHaveLength(answer === 'unavailable' ? 0 : 1)
    if (answer !== 'unavailable') expect(JSON.stringify(proof.prompts[0])).toContain(coverNote)
    expect(proof.effect).toBe(answer === 'approve' ? 'effectqueuedeffect' : null)
    expect(proof.scripts[0].status).toBe(answer === 'approve' ? 'completed' : 'blocked')
  }, 30_000)
}

test('the reviewer can refuse an earlier held child based on a later effect in the whole Script', async () => {
  const source = queue('printf effect >> effects.txt', 'printf fixtureProtected >> effects.txt') + write
  const proof = await run('native-script-mixed-review', cells(source))
  expect(proof.requests.map((request: any) => request.content.action.input.command)).toEqual(['printf effect >> effects.txt'])
  expect(proof.requests[0].content.action.script.source).toContain('fixtureProtected')
  expect(proof.effect).toBeNull()
  expect(proof.scripts[0].calls.map((call: any) => call.status)).toEqual(['failed', 'cancelled', 'blocked'])
}, 30_000)

test('a covering allow leaves the later mandatory ask in charge of dispatch', async () => {
  const source = write + queue('printf mandatory >> effects.txt', 'printf queued >> effects.txt') + write
  const proof = await run('native-script-mandatory', cells(source))
  expect(proof.requests).toHaveLength(1)
  expect(proof.prompts).toHaveLength(1)
  expect(JSON.stringify(proof.prompts[0])).not.toContain(coverNote)
  expect(proof.effect).toBe('effect')
  expect(proof.scripts[0].calls.map((call: any) => call.status)).toEqual(['completed', 'skipped', 'cancelled', 'blocked'])
}, 30_000)

test('computed commands and targets remain covered across the cell', async () => {
  const value = 'const file = ["effects", "txt"].join(".");'
  const call = 'await tools.call({ name: "Bash", input: { command: "printf computed >> " + file } });'
  const proof = await run('native-script-children', cells(write + value + call))
  expect(proof.requests).toHaveLength(1)
  expect(proof.effect).toBe('effectcomputed')
}, 30_000)

for (const verdict of ['allow', 'approve']) {
  test(`a covering ${verdict} preserves evidence for foreground helpers and background patched built-ins`, async () => {
    const helper = 'const run = async () => { ' + write + ' };'
    const patch = 'String.prototype.fixtureRun = function () { return run(); };'
    const usePatch = 'await "fixture".fixtureRun();'
    const proof = await run('native-script-children', {
      ...cells(helper, { code: patch, run_in_background: true }, usePatch, usePatch + write),
      ...(verdict === 'approve' && { CONTEXTUAL_AUTO_TEST_SCRIPT_ASK: verdict }),
    })
    expect(proof.effect).toBe('effecteffecteffect')
    const sources = proof.requests.map((r: any) => r.content.action.script.source)
    expect(sources).toHaveLength(2)
    const [combined, next] = sources
    const sections = combined.split(/Script \d+ of 3\b/).slice(1)
    expect(sections).toHaveLength(3)
    expect(sections[0]).toContain(helper)
    expect(sections[1]).toContain(patch)
    expect(sections[2]).toContain(usePatch)
    expect(next).toContain(usePatch + write)
    expect(next).toContain(patch)
    expect(next).toContain(helper)
  }, 30_000)
}

test('a later Script review sees the surviving helper and the earlier child outcomes', async () => {
  const helper = 'const fromHelper = async () => { ' + write + ' };'
  const earlier = [
    helper,
    `await ${bash('printf completed >> effects.txt')};`,
    `await ${bash('printf partial >> effects.txt; false')};`,
    `await ${bash('printf blocked >> effects.txt')};`,
  ].join('\n')
  const later = 'await fromHelper();'
  const proof = await run('native-script-deny-rule', cells(earlier, later))
  expect(proof.effect).toBe('completedpartialeffect')
  expect(proof.prompts).toHaveLength(0)
  expect(proof.requests).toHaveLength(2)
  expect(proof.scripts[0].calls[2].error).toContain('Blocked by permissions')
  const evidence = proof.requests[1].content.action.script
  expect(evidence.source).toContain(earlier)
  expect(evidence.source).toContain(later)
  expect(evidence.earlierCells).toEqual([{
    cell: 1,
    children: [
      { tool: 'Bash', line: 2, outcome: 'completed' },
      { tool: 'Bash', line: 3, outcome: 'unknown' },
      { tool: 'Bash', line: 4, outcome: 'refused' },
    ],
  }])
}, 30_000)

for (const size of [32_000, 32_001]) {
  test(`combined source of ${size} characters controls coverage until reset`, async () => {
    const setup = '//'.padEnd(size - twoWrites.length, 'x')
    const overBudget = size > 32_000
    const proof = await run('native-script-children', cells(
      setup, twoWrites, { code: twoWrites, run_in_background: true },
      // An undrained guest promise ends this generation.
      'var pending = Promise.race([]);', twoWrites,
    ))
    expect(proof.effect).toBe('effect'.repeat(overBudget ? 2 : 6))
    const generations = proof.requests.map((r: any) => r.content.action.script.generation)
    if (overBudget) {
      expect(generations).toHaveLength(1)
      const refusals = proof.reviewEvents.filter((event: any) => event.reason?.includes('32,000-character'))
      expect(refusals).toHaveLength(2)
      expect(refusals[0].reason).toContain('The held action did not run. Resume the chat to reset the Script interpreter')
    } else {
      expect(generations).toHaveLength(3)
      expect(generations[0]).toBe(generations[1])
      expect(generations[2]).not.toBe(generations[0])
    }
  }, 30_000)
}

test('an oversized review sends no request and releases neither the held nor the queued effect', async () => {
  const proof = await run('native-oversize-history', cells(queued, twoWrites))
  expect(proof.effect).toBeNull()
  expect(proof.requests).toHaveLength(0)
  expect(proof.prompts).toHaveLength(0)
  expect(proof.reviewEvents.filter((event: any) =>
    event.reason?.includes('exceeded its size limit before reaching the reviewer. The held action did not run.'))).toHaveLength(2)
}, 30_000)

test('an oversized held action leaves the same Script interpreter eligible for later review', async () => {
  const oversized = 'tools.call({name:"Write",input:{file_path:".vscode/settings.json",content:"x".repeat(60000)},nothrow:true})'
  const proof = await run('native-oversize-action', cells(
    `await Promise.all([${oversized}, ${bash('printf queued >> effects.txt')}]);`, write,
  ))
  expect(proof.sensitiveFileExists).toBe(false)
  expect(proof.requests.map((request: any) => request.tool)).toEqual(['Bash'])
  expect(proof.effect).toBe('effect')
  expect(proof.prompts).toHaveLength(0)
  expect(proof.scripts.map((script: any) => script.status)).toEqual(['blocked', 'completed'])
  expect(proof.scripts[0].output).toContain('The held action did not run.')
  expect(proof.requests[0].content.action.script.source).toContain(oversized)
}, 30_000)

test('an unavailable reviewer stops every queued effect without child fallback', async () => {
  const proof = await run('script-review-unavailable', cells(queued + write))
  expect(proof.effect).toBeNull()
  expect(proof.requests).toHaveLength(1)
  expect(proof.prompts).toHaveLength(0)
  expect(proof.scripts[0].status).toBe('blocked')
  expect(proof.scripts[0].output).toContain('Submit a new Script cell when the reviewer is available')
}, 30_000)

test('a withdrawal at final release reports a hold after the initial allowance', async () => {
  const proof = await run('native-script-late-release', cells(queued))
  const [request] = proof.requests
  expect(request.tool).toBe('Bash')
  expect(proof.effect).toBeNull()
  expect(proof.reviewUsage.ends).toContainEqual(expect.objectContaining({ route: 'contextual', disposition: 'allowed' }))
  const held = 'The reviewer allowed this action. The engine held the action before it ran'
  expect(proof.savedReviews).toContainEqual(expect.objectContaining({ toolUseId: request.content.action.attempt,
    outcome: 'inconclusive', reviewer: expect.objectContaining({ verdict: 'allow' }), reason: expect.stringContaining(held) }))
  expect(proof.scripts[0].calls[0]).toMatchObject({ status: 'blocked', error: expect.stringContaining(held),
    result: expect.objectContaining({ isError: true, content: expect.stringContaining(held) }) })
}, 30_000)

test('a separate preflight hold keeps its reason after the reviewer allows the action', async () => {
  const proof = await run('native-script-children', cells(`await ${bash('cd . && printf effect >> effects.txt')};`))
  expect(proof.effect).toBeNull()
  expect(proof.requests.map((request: any) => request.tool)).toEqual(['Bash'])
  expect(proof.scripts[0].calls[0].error).toContain('Script Bash cannot preflight paths after a compound directory change')
  expect(proof.reviewEvents.at(-1)).toMatchObject({ outcome: 'inconclusive',
    reviewer: expect.objectContaining({ verdict: 'allow' }), reason: 'The reviewer allowed this action. The action did not run.' })
}, 30_000)

for (const changed of ['instruction', 'rules', 'mode']) {
  test(`a ${changed} change after release fences covered children and queued work`, async () => {
    const proof = await run('native-script-children', {
      ...cells(queued + write), CONTEXTUAL_AUTO_TEST_SCRIPT_AUTHORITY: changed,
    })
    expect(proof.scriptAuthorityChanged).toBe(true)
    expect(proof.requests).toHaveLength(1)
    expect(proof.prompts).toHaveLength(0)
    expect(proof.effect).toBe('effect')
    expect(proof.scripts[0].status).toBe('blocked')
  }, 30_000)
}

for (const command of [
  'rm -rf "$HOME"',
  'rm -rf >/dev/null "$HOME"',
  'rmdir "${HOME}/"',
  'rmdir -p "$HOME"/empty-child',
  'rm -rf ~/*',
  'cd / && rm -rf usr',
  'cd "$HOME"; rm -rf .',
  "bash -lc 'sh -c \"rm -rf /\"'",
]) {
  test(`a covering allow cannot dispatch protected removal ${command}`, async () => {
    const proof = await run('native-script-guard', cells(
      write + queue(`printf SCRIPT_GUARD_TRIPWIRE; ${command}`, 'printf queued >> effects.txt'),
    ))
    expect(proof.requests).toHaveLength(1)
    expect(proof.effect).toBe('effect')
    expect(proof.guardDispatched).toBe(false)
    expect(proof.scripts[0].output).toContain('would remove a root, home, or top-level system directory')
  }, 30_000)
}

test('ordinary project cleanup remains eligible for whole-Script review', async () => {
  const proof = await run('native-script-cleanup', cells(`await ${bash('rm -rf dist/*')};` + write))
  expect(proof.requests).toHaveLength(1)
  expect(proof.requests[0].content.action.input.command).toBe('rm -rf dist/*')
  expect(proof.artifactExists).toBe(false)
  expect(proof.effect).toBe('effect')
}, 30_000)

test('a credential assembled after the review is checked at release', async () => {
  const source = write + 'const marker = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");' +
    'await tools.call({name:"Bash",input:{command:"printf %s " + JSON.stringify(marker) + " >> effects.txt"},nothrow:true});' + write
  const proof = await run('native-script-children', cells(source))
  expect(proof.requests).toHaveLength(1)
  expect(proof.effect).toBe('effect')
  expect(proof.scripts[0].output).toContain('could not safely redact credentials from this Script action')
}, 30_000)

test('a retry after an unavailable reviewer needs a fresh decision', async () => {
  const proof = await run('native-script-retry', cells(queued, queued))
  expect(proof.requests).toHaveLength(2)
  const first = proof.requests[0].content.action.script
  const retry = proof.requests[1].content.action.script
  expect(retry.cellId).not.toBe(first.cellId)
  expect(retry.generation).toBe(first.generation)
  expect(proof.effect).toBe('effectqueued')
  expect(proof.scripts.map((script: any) => script.status)).toEqual(['blocked', 'completed'])
}, 30_000)

test('a subcommand deny survives an early compound-command safety ask', async () => {
  const proof = await run('native-script-deny-rule', cells(
    write + queue('cd . && cd . && printf blocked >> effects.txt', 'printf queued >> effects.txt'),
  ))
  expect(proof.requests).toHaveLength(1)
  expect(proof.prompts).toHaveLength(0)
  expect(proof.effect).toBe('effect')
  expect(proof.scripts[0].output).toContain('Blocked by permissions')
}, 30_000)

test('a Bash ask cannot supersede a denied read inside a covered Script', async () => {
  const proof = await run('native-script-path-deny', cells(
    write + queue('cat a.txt', 'printf queued >> effects.txt'),
  ))
  expect(proof.requests).toHaveLength(1)
  expect(proof.prompts).toHaveLength(0)
  expect(proof.effect).toBe('effect')
  expect(proof.scripts[0].calls[1].error).toContain('Blocked by permissions')
}, 30_000)

test('a denied output path holds a Script pipeline and its queued work', async () => {
  const proof = await run('native-script-path-deny', cells(
    write + queue('printf fixture | cat > a.txt', 'printf queued >> effects.txt'),
  ))
  expect(proof.requests).toHaveLength(1)
  expect(proof.prompts).toHaveLength(0)
  expect(proof.effect).toBe('effect')
  expect(proof.files.a).toBe('old')
  expect(proof.scripts[0].calls[1].error).toContain('Output redirection')
}, 30_000)
