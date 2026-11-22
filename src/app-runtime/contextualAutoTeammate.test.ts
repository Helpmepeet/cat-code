import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const approval of ['dialog', 'mailbox', 'mailbox-revised'] as const) {
  const revised = approval === 'mailbox-revised'
  const name = revised
    ? 'a revised mailbox approval leaves the reviewed action held'
    : `a named teammate gets parent authority and can act after ${approval} approval`
  test(name, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cat-teammate-auto-')))
    try {
      const cwd = join(root, 'workspace')
      const config = join(root, 'config')
      await Promise.all([mkdir(cwd), mkdir(config)])
      const child = Bun.spawn([
        process.execPath, '--feature=TRANSCRIPT_CLASSIFIER', '--feature=AUTO_MODE_UPSTREAM_PORT',
        '--feature=AUTO_MODE_CONTEXTUAL_REVIEW', '--feature=CODE_MODE',
        new URL('./contextualAutoTeammate.fixture.ts', import.meta.url).pathname,
      ], {
        cwd, stdout: 'pipe', stderr: 'pipe',
        env: {
          PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
          CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: config,
          ANTHROPIC_API_KEY: 'isolated-fixture', CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-sonnet-5-5',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', NODE_ENV: 'test',
          TEAMMATE_TEST_APPROVAL: approval, TEAMMATE_TEST_ROOT: root,
        },
      })
      const timer = setTimeout(() => child.kill(), 20_000)
      const [exit, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]).finally(() => clearTimeout(timer))
      if (exit !== 0) throw new Error(`Teammate fixture exited ${exit}\n${stderr}\n${stdout}`)
      const proof = JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
      expect(proof.approval).toEqual({ worker: 'worker', tool: 'Bash', effectBeforeApproval: null })
      expect(proof.operatorId).toBeString()
      expect({ assignment: proof.assignment, effect: proof.effect }).toEqual({
        assignment: expect.objectContaining({
          origin: 'worker-launch', sender: 'main',
          parentAnchor: proof.operatorId,
          parent: expect.arrayContaining([expect.objectContaining({
            origin: 'operator', id: proof.operatorId, text: 'Have the named teammate write the fixture marker.',
          })]),
        }),
        effect: revised ? null : 'approved-by-leader',
      })
      if (revised) expect(proof.workerResult).toMatchObject({
        is_error: true,
        content: expect.stringContaining('The approval no longer matches the current action'),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 25_000)
}
