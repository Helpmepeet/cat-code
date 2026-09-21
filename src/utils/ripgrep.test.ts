import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'path'
import { isRipgrepVersionResult, ripGrep } from './ripgrep.js'

const TARGET = join(import.meta.dir, 'ripgrep.ts')
const MODULE_URL = new URL('./ripgrep.ts', import.meta.url).href

async function expectRipgrepError(
  args: string[],
  diagnostic: string,
): Promise<void> {
  let caught: unknown
  try {
    await ripGrep(args, TARGET, new AbortController().signal)
  } catch (error) {
    caught = error
  }

  if (!(caught instanceof Error)) {
    throw new Error('Expected ripGrep to reject with an error')
  }
  expect(caught.message).toContain('ripgrep search failed with exit code 2')
  expect(caught.message).toContain(diagnostic)
}

describe('ripGrep', () => {
  test('accepts only a successful ripgrep identity probe', () => {
    expect(isRipgrepVersionResult(0, 'ripgrep 15.2.0\n')).toBe(true)
    expect(isRipgrepVersionResult(0, '2.1.87 (Cat Code)\n')).toBe(false)
    expect(isRipgrepVersionResult(1, 'ripgrep 15.2.0\n')).toBe(false)
  })

  test('rejects a wrong executable before it can run a search', async () => {
    const root = mkdtempSync(join(tmpdir(), 'catcode-ripgrep-identity-'))
    const fakeRg = join(root, 'rg')
    const queryMarker = join(root, 'query-ran')
    writeFileSync(
      fakeRg,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        '  echo "2.1.87 (Cat Code)"',
        '  exit 0',
        'fi',
        'echo query > "$FAKE_RG_QUERY_MARKER"',
        'exit 1',
        '',
      ].join('\n'),
    )
    chmodSync(fakeRg, 0o755)

    try {
      const code = `
        import { ripGrep } from ${JSON.stringify(MODULE_URL)}
        try {
          await ripGrep(['needle'], ${JSON.stringify(TARGET)}, new AbortController().signal)
          process.exit(2)
        } catch (error) {
          process.stdout.write(String(error instanceof Error ? error.message : error))
        }
      `
      const child = Bun.spawn([process.execPath, '-e', code], {
        env: {
          ...process.env,
          PATH: [root, '/usr/bin', '/bin'].join(':'),
          FAKE_RG_QUERY_MARKER: queryMarker,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ])

      expect(exitCode).toBe(0)
      expect(stdout).toContain('Ripgrep validation failed')
      expect(stdout).toContain('2.1.87 (Cat Code)')
      expect(existsSync(queryMarker)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects malformed regular expressions with ripgrep diagnostics', async () => {
    await expectRipgrepError(['['], 'unclosed character class')
  })

  test('rejects unknown ripgrep file types with diagnostics', async () => {
    await expectRipgrepError(
      ['--type', 'definitely_not_a_registered_rg_type', 'export'],
      'unrecognized file type',
    )
  })

  test('resolves an empty result for a normal no-match search', async () => {
    await expect(
      ripGrep(
        ['__cat_code_ripgrep_no_match_9d6f8c2a__'],
        TARGET,
        new AbortController().signal,
      ),
    ).resolves.toEqual([])
  })
})
