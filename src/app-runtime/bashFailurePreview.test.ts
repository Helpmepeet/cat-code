import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

const padding = `${'routine output '.repeat(8)}\n`.repeat(320)

for (const mode of ['direct', 'script']) {
  test.skipIf(process.platform === 'win32')(`${mode} Bash delivers a bounded preview of recognized test failures to the provider`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'bash-failure-preview-')))
    const workspace = join(root, 'workspace')
    const config = join(root, 'config')
    const boilerplate = `import { expect, test } from 'bun:test'\n`
    const printPadding = `process.stdout.write(${JSON.stringify(padding)})\n`
    try {
      await Promise.all([mkdir(workspace), mkdir(config)])
      await Promise.all([
        writeFile(join(workspace, 'mixed.test.ts'), boilerplate + `
test('earlier passing case', () => { ${printPadding} })
test('middle assertion case', () => { expect(407).toBe(42) })
test('second failing case', () => {
  expect({ status: 'incorrect-value' }).toEqual({ status: 'expected-value' })
})
test('later passing case', () => { ${printPadding} })
`),
        writeFile(join(workspace, 'setup.test.ts'), `${boilerplate}${printPadding}throw new Error('missing test configuration')\n`),
        writeFile(join(workspace, 'passing.test.ts'), boilerplate + `
test('reports arbitrary text', () => {
  console.log('ordinary passing output\\n(fail) misleading failure [0.10ms]')
  ${printPadding}
})\n`),
        writeFile(join(workspace, 'unknown.log'), `ordinary unknown output\n(fail) fake failure marker\n${padding}unknown log ending\n`),
        // Replay representative unittest output without requiring a Python installation.
        writeFile(join(root, 'python3'), `#!/bin/sh\nif [ "$3" = suite ]; then cat unittest.log; exit 1; fi\ncat unknown.log\nexit 7\n`, { mode: 0o755 }),
        writeFile(join(workspace, 'unittest.log'), `${padding}
======================================================================
FAIL: test_recovers (suite.RecoveryTests.test_recovers)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "suite.py", line 4, in test_recovers
    self.assertEqual(407, 42)
AssertionError: 407 != 42

----------------------------------------------------------------------
Ran 500 tests in 0.223s

FAILED (failures=1)
`),
      ])
      const child = Bun.spawn([process.execPath, '--feature=CODE_MODE', new URL('./bashFailurePreview.fixture.ts', import.meta.url).pathname], {
        cwd: workspace, stdout: 'pipe', stderr: 'pipe',
        env: {
          PATH: [root, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
          HOME: root, TMPDIR: root, SHELL: '/bin/bash', NO_COLOR: '1',
          CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: config,
          ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential', CLAUDE_CODE_USE_OPENAI: '0',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
          BASH_PREVIEW_TEST_ROOT: root, BASH_PREVIEW_TEST_MODE: mode,
        },
      })
      const timer = setTimeout(() => child.kill(), 25_000)
      const [exit, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]).finally(() => clearTimeout(timer))
      if (exit !== 0) throw new Error(`Bash fixture failed (${exit}): ${stderr}\n${stdout}`)

      const receipts = JSON.parse(stdout) as Record<string, string>
      expect(Object.keys(receipts)).toEqual(['bun', 'unittest', 'setup', 'passing', 'unknown', 'replay'])
      const previews: Record<string, string> = {}
      for (const [id, receipt] of Object.entries(receipts)) {
        const path = receipt.match(/Full output saved to: ([^\n]+)/)?.[1]
        expect(path).toBeDefined()
        expect(path!.startsWith(root + '/')).toBe(true)
        const fullLog = await readFile(path!, 'utf8')
        expect(Buffer.byteLength(fullLog)).toBeGreaterThan(30_000)
        if (id === 'bun') expect(fullLog.indexOf('(fail) middle assertion case')).toBeGreaterThan(30_000)
        const preview = receipt.match(/^Preview \([^)]+\):\n([\s\S]*?)\n(?:\.\.\.\n)?<\/persisted-output>/m)?.[1]
        expect(preview).toBeDefined()
        expect(Buffer.byteLength(preview!)).toBeLessThanOrEqual(2000)
        previews[id] = preview!
        if (id !== 'passing') expect(receipt).toContain(`Exit code ${id === 'unknown' || id === 'replay' ? 7 : 1}`)
      }
      for (const id of ['unknown', 'passing', 'replay']) {
        expect(receipts[id].includes('Preview (first '), id).toBe(true)
      }
      expect(previews.unknown).toStartWith('ordinary unknown output\n(fail) fake failure marker')
      expect(previews.passing).toContain('ordinary passing output\n(fail) misleading failure')
      expect(receipts.passing).not.toContain('Exit code')
      expect({
        bun: /middle assertion case[\s\S]*?Expected: 42[\s\S]*?Received: 407[\s\S]*?second failing case[\s\S]*?expected-value[\s\S]*?incorrect-value[\s\S]*?2 fail[\s\S]*?Ran 4 tests/.test(previews.bun),
        unittest: /FAIL: test_recovers[\s\S]*?AssertionError: 407 != 42[\s\S]*?Ran 500 tests[\s\S]*?FAILED \(failures=1\)/.test(previews.unittest),
        setup: /Unhandled error between tests[\s\S]*?error: missing test configuration[\s\S]*?1 fail[\s\S]*?Ran 1 test/.test(previews.setup),
      }).toEqual({ bun: true, unittest: true, setup: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
}
