import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSidecarLaunch } from '../../app/main/mainDecisions.js'

// Reuses the contextual Auto fixture: its native-script-children scenario runs
// one Script whose two Bash children each need a contextual review.
const fixture = new URL('./contextualAuto.fixture.ts', import.meta.url).pathname

async function run(scenario: string, reviewOnce: boolean, extraEnv: Record<string, string> = {}) {
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
        ...(reviewOnce && { CLAUDE_CODE_CONTEXTUAL_SCRIPT_REVIEW: 'once' }),
        CONTEXTUAL_AUTO_TEST_ROOT: root, CONTEXTUAL_AUTO_TEST_SCENARIO: scenario, ...extraEnv,
      },
    })
    const timeout = setTimeout(() => child.kill(), 25_000)
    const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timeout)
    if (exit !== 0) throw new Error(`Fixture ${scenario} exited ${exit}\n${error}\n${output}`)
    return JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('with review-once, one review covers both Bash children of a Script', async () => {
  const proof = await run('native-script-children', true)
  expect(proof.requests.map((request: any) => request.tool)).toEqual(['Bash'])
  expect(proof.requests[0].content.action.script.source).toContain('both writes completed')
  expect(proof.prompts).toHaveLength(0)
  expect(proof.effect).toBe('effecteffect')
}, 30_000)

test('without review-once, each Bash child is still reviewed', async () => {
  const proof = await run('native-script-children', false)
  expect(proof.requests.map((request: any) => request.tool)).toEqual(['Bash', 'Bash'])
  expect(proof.effect).toBe('effecteffect')
}, 30_000)

const coverNote = 'Yes runs the rest of this script without another review.'

test('with review-once, a Yes to the script review covers the rest of the Script', async () => {
  const proof = await run('native-script-children', true, { CONTEXTUAL_AUTO_TEST_SCRIPT_ASK: 'approve' })
  expect(proof.requests.map((request: any) => request.tool)).toEqual(['Bash'])
  expect(proof.prompts).toHaveLength(1)
  expect(JSON.stringify(proof.prompts[0])).toContain(coverNote)
  expect(proof.effect).toBe('effecteffect')
}, 30_000)

test('without review-once, each asking child prompts on its own', async () => {
  const proof = await run('native-script-children', false, { CONTEXTUAL_AUTO_TEST_SCRIPT_ASK: 'approve' })
  expect(proof.requests.map((request: any) => request.tool)).toEqual(['Bash', 'Bash'])
  expect(proof.prompts).toHaveLength(2)
  expect(JSON.stringify(proof.prompts)).not.toContain(coverNote)
  expect(proof.effect).toBe('effecteffect')
}, 30_000)

test('with review-once, a denied child still stops the Script', async () => {
  const proof = await run('native-denials-script', true)
  expect(proof.requests.length).toBeGreaterThan(0)
  expect(proof.effect).toBeNull()
}, 30_000)
